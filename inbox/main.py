"""hermes-chat-lite 消息中心服务（inbox）。

职责**只有三件**：列表 / 未读数 / 标记已读·归档。

- **不写入业务消息**：消息由推送方（cron 脚本、邮件同步脚本、agent）**直连 MySQL** 写入，
  本服务不开写入接口 ⇒ 职责单一、少一跳、少一个能被外部灌数据的面。
- **不删除**：只能归档（`archived_at`），防误删；要清理走 DB。
- 鉴权：请求头 `X-Inbox-Token` 必须等于 `INBOX_TOKEN`；该头由 **nginx 注入**
  （与注入 `Authorization` 同一姿势）⇒ 前端产物里没有任何密钥。
- 时区：库里 `occurred_at` 是 `Asia/Shanghai` 的 naive DATETIME（本机时区是 UTC，
  写入方已显式转换）；对外统一输出带 `+08:00` 的 ISO 串，前端 `new Date()` 直接可用。
- 列表只返回**摘要**（`excerpt`），正文走详情接口：早盘简报这类正文几千字，
  50 条一起返回会把载荷撑到几百 KB。

环境变量：MYSQL_HOST/PORT/USER/PASSWORD/DATABASE、INBOX_TABLE、INBOX_TOKEN。
"""

import hmac
import os
import re
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, Iterator, List, Optional
from zoneinfo import ZoneInfo

import pymysql
from fastapi import Body, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from pymysql.cursors import DictCursor

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
TOKEN = os.environ.get("INBOX_TOKEN", "")
EXCERPT_CHARS = int(os.environ.get("INBOX_EXCERPT_CHARS", "200"))

# 表名进不了参数化占位符，只能自己把关：只允许「字母数字下划线」。
if not re.fullmatch(r"[A-Za-z0-9_]+", TABLE or ""):
    raise RuntimeError(f"INBOX_TABLE 非法: {TABLE!r}")

LEVELS = ("action", "warn", "info")

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
