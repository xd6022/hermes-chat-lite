"""hermes-chat-lite 消息中心服务（inbox）。

职责**只有三件**：列表 / 未读数 / 标记已读·归档。

- **不写入业务消息**：消息由推送方（cron 脚本、agent）**直连 MySQL** 写入，
  本服务不开写入接口 ⇒ 职责单一、少一跳、少一个能被外部灌数据的面。
- **不删除**：只能归档（`archived_at`），防误删；要清理走 DB。
- **邮件缓存表**（2026-09-28 用户改口径，反转 09-24 的"邮件不落库"）：邮件走
  `/inbox/email/cache*` **读 `inbox_emails` 缓存表**（瞬时、离线可读、可翻历史）；
  缓存由「定时拉取（交易日 9–15 每整点）+ 页面刷新按钮」经 `/inbox/email/refresh` 写入，
  仍是 **IMAP 只读**（`readonly=True`，绝不动邮箱的已读状态）。
  消息表 `inbox_messages` 只放通知/待办；邮件正文绝不写进消息表（长文会撑爆列表响应）。
  ⚠️ 老口径别再当作"正确"来"纠正"本文件。
- 鉴权：请求头 `X-Inbox-Token` 必须等于 `INBOX_TOKEN`；该头由 **nginx 注入**
  （与注入 `Authorization` 同一姿势）⇒ 前端产物里没有任何密钥。
- 时区：库里 `occurred_at` 是 `Asia/Shanghai` 的 naive DATETIME（本机时区是 UTC，
  写入方已显式转换）；对外统一输出带 `+08:00` 的 ISO 串，前端 `new Date()` 直接可用。
- 列表只返回**摘要**（`excerpt`），正文走详情接口：早盘简报这类正文几千字，
  50 条一起返回会把载荷撑到几百 KB。

环境变量：MYSQL_HOST/PORT/USER/PASSWORD/DATABASE、INBOX_TABLE、INBOX_TOKEN
（邮件另见 `mail.py`：INBOX_MAIL_ACCOUNT/FOLDER/TIMEOUT/EXCERPT_CHARS）。
"""

import hashlib
import hmac
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Any, Dict, Iterator, List, Optional
from zoneinfo import ZoneInfo

import pymysql
from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from pymysql.cursors import DictCursor

import mail  # 邮箱直读（同目录，见 Dockerfile.inbox 的 COPY）

# ---- 配置 ----------------------------------------------------------------

_DB_CONFIG: Dict[str, Any] = {
    "host": os.environ.get("MYSQL_HOST", "mysql"),
    "port": int(os.environ.get("MYSQL_PORT", "3306")),
    "user": os.environ.get("MYSQL_USER", "hermes"),
    "password": os.environ.get("MYSQL_PASSWORD", ""),
    "database": os.environ.get("MYSQL_DATABASE", "hermes_stock"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
    "autocommit": True,
    "connect_timeout": 3,
    "read_timeout": 10,
}

TABLE = os.environ.get("INBOX_TABLE", "inbox_messages")

# ---- 邮件缓存（v3.3）-----------------------------------------------------
# 页面只读这张表；写它只有两条路：定时任务（交易日 9–15 每整点）与页面上的「刷新」按钮，
# 都走 POST /inbox/email/refresh（实时 IMAP 只读拉一次 → upsert）。
CACHE_TABLE = os.environ.get("INBOX_EMAIL_TABLE", "inbox_emails")
# 缓存**一次拉多少天**：页面档位最大 7 天 ⇒ 缓存按 7 天保底，切档位不再连 IMAP。
CACHE_DAYS = int(os.environ.get("INBOX_EMAIL_CACHE_DAYS", "7"))
# 只缓存"自己发的"通知 —— 沿用邮件同步腿的既有规则（`INBOX_MAIL_SENDER`），**不新增过滤口径**。
CACHE_SENDER = os.environ.get("INBOX_MAIL_SENDER", "xd602201@163.com")
# 一次拉多少封（缓存窗口内）
CACHE_LIMIT = int(os.environ.get("INBOX_EMAIL_CACHE_LIMIT", "50"))

if not re.fullmatch(r"[A-Za-z0-9_]+", CACHE_TABLE or ""):
    raise RuntimeError(f"INBOX_EMAIL_TABLE 非法: {CACHE_TABLE!r}")
TOKEN = os.environ.get("INBOX_TOKEN", "")
EXCERPT_CHARS = int(os.environ.get("INBOX_EXCERPT_CHARS", "200"))

# 表名进不了参数化占位符，只能自己把关：只允许「字母数字下划线」。
if not re.fullmatch(r"[A-Za-z0-9_]+", TABLE or ""):
    raise RuntimeError(f"INBOX_TABLE 非法: {TABLE!r}")

LEVELS = ("action", "warn", "info")

# 默认**不返回**的历史来源（2026-09-24 用户定调：邮件不再进消息表，改走 /inbox/email/* 实时直读）。
# 同步脚本已停，但库里还留着它当时写进来的旧行 —— 不删（要清理走 DB），只是不再出现在列表里。
# ⚠️ 列表与未读数**必须同口径**过滤：否则会出现"徽标显示 3 条未读、列表里一条都没有"的假象。
HIDDEN_SOURCES = ("email",)

# `since`（起始时间）：前端传带偏移的 ISO（如 `2026-09-22T00:00:00+08:00`），
# 统一换算成 **Asia/Shanghai 的 naive 时间**再与 `occurred_at` 比较（库里存的就是这个口径）。
# 不传 / 传空 = 不限（"看全部"）。
BJ = ZoneInfo("Asia/Shanghai")

# category 一律用 ASCII 代码（stock/email/alert/system），中文标签由前端映射：
# 中文字面量放进**查询串**会踩编码坑（实测：原样带中文的 `?category=股票信号` 变成空响应/400），
# 而标签文案本来就应该随前端改，不该焊死在数据里。
CATEGORY_RE = re.compile(r"[a-z_]{1,16}\Z")

app = FastAPI(title="hermes-chat-lite inbox", docs_url=None, redoc_url=None)


# ---- 基础工具 -------------------------------------------------------------


@contextmanager
def _conn() -> Iterator[Any]:
    conn = pymysql.connect(**_DB_CONFIG)
    try:
        yield conn
    finally:
        conn.close()


def _check_token(provided: Optional[str]) -> None:
    if not TOKEN:
        # 不配 token 就直接拒绝服务：宁可 500 也不要裸奔。
        raise HTTPException(status_code=500, detail="INBOX_TOKEN 未配置")
    if not provided or not hmac.compare_digest(provided, TOKEN):
        raise HTTPException(status_code=401, detail="invalid inbox token")


def _check_category(category: Optional[str]) -> Optional[str]:
    """category 只接受 ASCII 代码；拿中文当过滤条件直接 400（省得前端以为"筛不出来"是后端坏了）。"""
    if category is None or category == "":
        return None
    if not CATEGORY_RE.fullmatch(category):
        raise HTTPException(status_code=400, detail="category 必须是 ASCII 代码（如 stock/email/alert/system）")
    return category


def _parse_since(raw: Optional[str]) -> Optional[datetime]:
    """`since` → **Asia/Shanghai 的 naive datetime**（库里 `occurred_at` 就是这个口径）。

    - 空 / 不传 = 不限（None）
    - 带偏移的 ISO（前端传的 `2026-09-22T00:00:00+08:00`）会先换算到北京时间
    - 不带偏移的（`2026-09-22 18:00:00`）按北京时间理解
    - 解析不了 → **400 明确报错**（不静默当成"不限"，那会让人以为筛选没生效）
    """
    if raw is None or raw.strip() == "":
        return None
    text = raw.strip().replace(" ", "T")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise HTTPException(status_code=400, detail="since 必须是 ISO 时间（如 2026-09-22T00:00:00+08:00）")
    if dt.tzinfo is not None:
        dt = dt.astimezone(BJ).replace(tzinfo=None)
    return dt


def _iso(value: Any) -> Optional[str]:
    """naive DATETIME（Asia/Shanghai）→ 带 +08:00 的 ISO 串。"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%dT%H:%M:%S") + "+08:00"
    return str(value)


def _row_out(row: Dict[str, Any], *, with_body: bool) -> Dict[str, Any]:
    out = {
        "id": row.get("id"),
        "source": row.get("source"),
        "category": row.get("category"),
        "level": row.get("level") if row.get("level") in LEVELS else "info",
        "title": row.get("title"),
        "occurred_at": _iso(row.get("occurred_at")),
        "read": row.get("read_at") is not None,
        "archived": row.get("archived_at") is not None,
    }
    if with_body:
        out["body"] = row.get("body") or ""
        out["body_len"] = len(out["body"])
    else:
        out["excerpt"] = row.get("excerpt") or ""
        out["body_len"] = int(row.get("body_len") or 0)
    return out


def _unread_count(conn: pymysql.connections.Connection, since: Optional[datetime] = None) -> int:
    """未读数。带 `since` 时只数**该时间之后**的（与列表同口径 ⇒ 徽标数字永远等于列表里未读的条数）。"""
    where = ["read_at IS NULL", "archived_at IS NULL"]
    params: List[Any] = []
    if HIDDEN_SOURCES:
        where.append(f"source NOT IN ({','.join(['%s'] * len(HIDDEN_SOURCES))})")
        params.extend(HIDDEN_SOURCES)
    if since is not None:
        where.append("occurred_at >= %s")
        params.append(since)
    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS n FROM `{TABLE}` WHERE " + " AND ".join(where), params)
        row: Any = cur.fetchone() or {}
    return int(row.get("n") or 0)


# ---- 接口 -----------------------------------------------------------------


@app.get("/health")
def health() -> JSONResponse:
    """给 compose healthcheck 用：能连库且表在 → 200；否则 503。不打鉴权（不泄数据）。"""
    try:
        with _conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT 1 FROM `{TABLE}` LIMIT 1")
        return JSONResponse({"ok": True, "table": TABLE})
    except Exception as exc:  # noqa: BLE001 - 健康检查只关心成败
        return JSONResponse({"ok": False, "table": TABLE, "error": str(exc)[:200]}, status_code=503)


@app.get("/inbox/unread-count")
def get_unread_count(
    since: Optional[str] = Query(default=None, description="只看这个时间之后的（ISO，带偏移最稳）"),
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
):
    _check_token(x_inbox_token)
    since_dt = _parse_since(since)
    with _conn() as conn:
        return {"unread_count": _unread_count(conn, since_dt)}


@app.get("/inbox/messages")
def list_messages(
    category: Optional[str] = None,
    unread: int = Query(default=0, ge=0, le=1),
    include_archived: int = Query(default=0, ge=0, le=1),
    limit: int = Query(default=50, ge=1, le=200),
    before_id: Optional[int] = Query(default=None, ge=1),
    since: Optional[str] = Query(default=None, description="只看 occurred_at ≥ 这个时间的（ISO）"),
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    """列表（按 id 倒序）。只返回摘要；正文走 `/inbox/messages/{id}`。"""
    _check_token(x_inbox_token)
    category = _check_category(category)
    since_dt = _parse_since(since)

    where: List[str] = []
    params: List[Any] = []
    if not include_archived:
        where.append("archived_at IS NULL")
    if unread:
        where.append("read_at IS NULL")
    if HIDDEN_SOURCES:
        where.append(f"source NOT IN ({','.join(['%s'] * len(HIDDEN_SOURCES))})")
        params.extend(HIDDEN_SOURCES)
    if category:
        where.append("category = %s")
        params.append(category)
    if before_id:
        where.append("id < %s")
        params.append(before_id)
    if since_dt is not None:
        where.append("occurred_at >= %s")
        params.append(since_dt)
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    sql = (
        f"SELECT id, source, category, level, title, occurred_at, read_at, archived_at, "
        f"CHAR_LENGTH(COALESCE(body, '')) AS body_len, "
        f"LEFT(COALESCE(body, ''), {EXCERPT_CHARS}) AS excerpt "
        f"FROM `{TABLE}` {clause} ORDER BY id DESC LIMIT %s"
    )
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params + [limit])
            rows = cur.fetchall() or []
        return {
            "unread_count": _unread_count(conn, since_dt),
            "since": since_dt.strftime("%Y-%m-%d %H:%M:%S") if since_dt else None,
            "messages": [_row_out(r, with_body=False) for r in rows],
        }


@app.get("/inbox/messages/{msg_id}")
def get_message(
    msg_id: int,
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    _check_token(x_inbox_token)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT id, source, category, level, title, body, occurred_at, read_at, archived_at "
                f"FROM `{TABLE}` WHERE id = %s",
                [msg_id],
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="message not found")
    return _row_out(row, with_body=True)


@app.post("/inbox/messages/read-all")
def read_all(
    category: Optional[str] = None,
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    """全部标记已读（可选按类型）。已经读过的行不重复盖时间戳。"""
    _check_token(x_inbox_token)
    category = _check_category(category)
    where = ["read_at IS NULL", "archived_at IS NULL"]
    params: List[Any] = []
    if category:
        where.append("category = %s")
        params.append(category)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE `{TABLE}` SET read_at = NOW() WHERE " + " AND ".join(where), params
            )
            updated = cur.rowcount
        return {"ok": True, "updated": int(updated or 0), "unread_count": _unread_count(conn)}


@app.post("/inbox/messages/{msg_id}/read")
def mark_read(
    msg_id: int,
    read: int = Query(default=1, ge=0, le=1),
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    _check_token(x_inbox_token)
    with _conn() as conn:
        with conn.cursor() as cur:
            if read:
                cur.execute(f"UPDATE `{TABLE}` SET read_at = NOW() WHERE id = %s AND read_at IS NULL", [msg_id])
            else:
                cur.execute(f"UPDATE `{TABLE}` SET read_at = NULL WHERE id = %s", [msg_id])
            if cur.rowcount == 0:
                cur.execute(f"SELECT id FROM `{TABLE}` WHERE id = %s", [msg_id])
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="message not found")
        return {"ok": True, "unread_count": _unread_count(conn)}


# ---- 邮件（实时直读邮箱，**不落库**）--------------------------------------
# 口径见 mail.py 顶部：只读、不动邮箱已读状态、范围=整个收件箱、附件暂不支持。
# 失败一律 503 + 人话 detail（前端展示 + 给重试按钮）；单封不存在 → 404。


@app.get("/inbox/email/messages")
def list_email_messages(
    days: int = Query(default=3, ge=1, le=7, description="最近几天（按邮件 Date；档位 1/3/7，默认 3）"),
    limit: int = Query(default=30, ge=1, le=100),
    unread: int = Query(default=0, ge=0, le=1, description="1=只看未读（只读，不影响邮箱状态）"),
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    """收件箱列表（实时 IMAP 拉取，不写库）。"""
    _check_token(x_inbox_token)
    try:
        items = mail.list_emails(days=days, limit=limit, unread_only=bool(unread))
    except mail.MailError as exc:
        raise HTTPException(status_code=503, detail=f"读取邮箱失败：{exc}") from exc
    return {
        "days": days,
        "limit": limit,
        "unread_count": sum(1 for m in items if m.get("unread")),
        "messages": items,
    }


@app.get("/inbox/email/messages/{uid}")
def get_email_message(
    uid: str,
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    """单封全文（实时 IMAP 拉取，不写库）。"""
    _check_token(x_inbox_token)
    try:
        return mail.get_email(uid)
    except mail.MailNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except mail.MailError as exc:
        raise HTTPException(status_code=503, detail=f"读取邮箱失败：{exc}") from exc


# ---- 邮件缓存（v3.3）：页面读缓存，不再实时连 IMAP -------------------------------


def _cache_out(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "message_id": row.get("message_id"),
        "uid": row.get("uid"),
        "subject": row.get("subject"),
        "from_name": row.get("from_name"),
        "from_addr": row.get("from_addr"),
        "to_addr": row.get("to_addr"),
        "occurred_at": _iso(row.get("occurred_at")),
        "excerpt": row.get("excerpt") or "",
        "body_len": int(row.get("body_len") or 0),
        "attachment_count": int(row.get("attachment_count") or 0),
        "fetched_at": _iso(row.get("fetched_at")),
    }


@app.get("/inbox/email/cache")
def email_cache_list(
    days: int = Query(default=1, ge=1, le=30, description="最近几天（含今天）：1=今天、3=今天+前两天"),
    limit: int = Query(default=50, ge=1, le=200),
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    """缓存列表（**不连 IMAP**，瞬时返回）。`days` 是**显示窗口**，与缓存窗口解耦。"""
    _check_token(x_inbox_token)
    start = (datetime.now(BJ) - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT id, message_id, uid, subject, from_name, from_addr, to_addr, occurred_at, "
                f"LEFT(COALESCE(body, ''), {EXCERPT_CHARS}) AS excerpt, body_len, attachment_count, fetched_at "
                f"FROM `{CACHE_TABLE}` WHERE occurred_at >= %s ORDER BY occurred_at DESC LIMIT %s",
                [start.replace(tzinfo=None), limit],
            )
            rows = cur.fetchall() or []
            cur.execute(f"SELECT MAX(fetched_at) AS f, COUNT(*) AS n FROM `{CACHE_TABLE}`")
            agg = cur.fetchone() or {}
    return {
        "days": days,
        "count": len(rows),
        "fetched_at": _iso(agg.get("f")),
        "cached_total": int(agg.get("n") or 0),
        "messages": [_cache_out(r) for r in rows],
    }


@app.get("/inbox/email/cache/{row_id}")
def email_cache_detail(
    row_id: int,
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    """缓存里的单封全文（同样不连 IMAP）。"""
    _check_token(x_inbox_token)
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT id, message_id, uid, subject, from_name, from_addr, to_addr, occurred_at, body, "
                f"body_len, attachment_count, fetched_at FROM `{CACHE_TABLE}` WHERE id = %s",
                [row_id],
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="邮件不在缓存里（可能已被清理）")
    out = _cache_out({**row, "excerpt": ""})
    out["body"] = row.get("body") or ""
    return out


@app.post("/inbox/email/refresh")
def email_cache_refresh(
    days: int = Query(default=CACHE_DAYS, ge=1, le=30, description="一次拉多少天（默认=缓存窗口 7 天）"),
    limit: int = Query(default=CACHE_LIMIT, ge=1, le=200),
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
) -> Dict[str, Any]:
    """**实时连 IMAP 拉一次并写缓存**（定时任务与页面刷新按钮共用这一条路）。

    只读：`SELECT ... readonly=True`，不改您邮箱的已读状态。失败 → 503 + 人话 detail（前端给重试按钮）。
    """
    _check_token(x_inbox_token)
    try:
        items = mail.list_emails(days=days, limit=limit, with_body=True, sender=CACHE_SENDER)
    except mail.MailError as exc:
        raise HTTPException(status_code=503, detail=f"读取邮箱失败：{exc}") from exc

    inserted = updated = 0
    now = datetime.now(BJ).replace(tzinfo=None)
    with _conn() as conn:
        with conn.cursor() as cur:
            for m in items:
                mid = str(m.get("message_id") or "")
                if not mid:
                    # 没有 Message-ID 的邮件：用 主题+时间+发件人 的稳定散列兜底（口径同邮件同步腿）
                    mid = "sha1:" + hashlib.sha1(
                        f"{m.get('subject')}|{m.get('occurred_at')}|{m.get('from_addr')}".encode("utf-8")
                    ).hexdigest()
                cur.execute(
                    f"INSERT INTO `{CACHE_TABLE}` "
                    f"(message_id, uid, from_name, from_addr, to_addr, subject, occurred_at, body, body_len, "
                    f"attachment_count, fetched_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                    f"ON DUPLICATE KEY UPDATE uid=VALUES(uid), subject=VALUES(subject), occurred_at=VALUES(occurred_at), "
                    f"body=VALUES(body), body_len=VALUES(body_len), attachment_count=VALUES(attachment_count), "
                    f"fetched_at=VALUES(fetched_at)",
                    [mid[:191], str(m.get("uid") or "")[:64], (m.get("from_name") or "")[:191],
                     (m.get("from_addr") or "")[:191], (m.get("to_addr") or "")[:255],
                     (m.get("subject") or "")[:255], m.get("occurred_at") or now,
                     m.get("body") or "", int(m.get("body_len") or 0),
                     int(m.get("attachment_count") or 0), now],
                )
                if cur.rowcount == 1:
                    inserted += 1
                else:
                    updated += 1
    return {
        "days": days,
        "pulled": len(items),
        "inserted": inserted,
        "updated": updated,
        "fetched_at": _iso(now),
        "sender": CACHE_SENDER,
    }


@app.post("/inbox/messages/{msg_id}/archive")
def archive_message(
    msg_id: int,
    archived: int = Query(default=1, ge=0, le=1),
    x_inbox_token: Optional[str] = Header(default=None, alias="X-Inbox-Token"),
    _body: Optional[Dict[str, Any]] = Body(default=None),
) -> Dict[str, Any]:
    """归档 = 从默认列表消失，**并顺带标记已读**（归档就是"处理完了"）。

    撤回归档只恢复它出现在列表里，**不恢复未读** —— 否则徽标数字会莫名其妙涨回去。
    """
    _check_token(x_inbox_token)
    with _conn() as conn:
        with conn.cursor() as cur:
            if archived:
                cur.execute(
                    f"UPDATE `{TABLE}` SET archived_at = NOW(), read_at = COALESCE(read_at, NOW()) "
                    f"WHERE id = %s AND archived_at IS NULL",
                    [msg_id],
                )
            else:
                cur.execute(f"UPDATE `{TABLE}` SET archived_at = NULL WHERE id = %s", [msg_id])
            if cur.rowcount == 0:
                cur.execute(f"SELECT id FROM `{TABLE}` WHERE id = %s", [msg_id])
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="message not found")
        return {"ok": True, "unread_count": _unread_count(conn)}
