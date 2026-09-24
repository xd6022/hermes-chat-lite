"""邮箱直读（IMAP 实时拉，**不落库**）—— 消息中心的「邮件」tab 专用。

用户 2026-09-24 定调：
- 邮件不再由同步脚本搬进消息表；消息表只留 `notify.py` 推的通知 ⇒ 同一封邮件不再有第二份副本。
- 打开「邮件」tab 时**实时**去邮箱拉，`readonly=True`：绝不改动您邮箱的已读状态
  （代价：前端读过的邮件在手机 App 上仍显示未读 —— 用户已确认接受）。
- 范围先看**整个收件箱**（2026-09-24 用户拍板，后续再收窄）；附件暂不支持，
  详情里只提示"有几个附件"。
- 失败必须能给人话：所有异常统一包成 `MailError`，前端 `detail` 直接展示 + 给重试按钮。

口径照搬 `sync_inbox_email.py` / xyy_mcp 里踩过的坑（不要自己发明）：
1. 163 必须在 LOGIN 之后发 **IMAP ID 命令**，否则 SEARCH/FETCH 直接 `BYE Unsafe Login`；
2. 时间取邮件头 `Date` 并转 **Asia/Shanghai**（不是"抓取时刻"）；
3. `text/plain` 优先，HTML 退化成**去标签纯文本** —— 前端绝不注入邮件 HTML（XSS）；
4. `SELECT ... readonly=True`：连已读标记都不动。

⚠️ 本模块自己读一遍 MYSQL_* 环境变量（与 main.py 同源同默认值）：好处是能脱离 FastAPI
单独跑着测（`python3 -c "import mail; print(mail.list_emails(3, 5))"`），
代价是那几个默认值有两份 —— 改 Dockerfile/compose 时两处一起改。
"""

from __future__ import annotations

import email as email_lib
import email.message  # noqa: F401  —— 让 email_lib.message.Message 的类型注解可用
import imaplib
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta
from email.header import decode_header
from email.utils import parsedate_to_datetime
from typing import Any, Dict, Iterator, List, Optional, Tuple
from zoneinfo import ZoneInfo

import pymysql

BJ = ZoneInfo("Asia/Shanghai")

MAIL_ACCOUNT = os.environ.get("INBOX_MAIL_ACCOUNT", "xd6022@163.com")
MAIL_FOLDER = os.environ.get("INBOX_MAIL_FOLDER", "INBOX")
MAIL_TIMEOUT = int(os.environ.get("INBOX_MAIL_TIMEOUT", "20"))
MAIL_EXCERPT_CHARS = int(os.environ.get("INBOX_MAIL_EXCERPT_CHARS", "200"))

_DB_CONFIG: Dict[str, Any] = {
    "host": os.environ.get("MYSQL_HOST", "mysql"),
    "port": int(os.environ.get("MYSQL_PORT", "3306")),
    "user": os.environ.get("MYSQL_USER", "hermes"),
    "password": os.environ.get("MYSQL_PASSWORD", ""),
    "database": os.environ.get("MYSQL_DATABASE", "hermes_stock"),
    "charset": "utf8mb4",
    "autocommit": True,
    "connect_timeout": 3,
    "read_timeout": 10,
}

_MAIL_ID = '("name" "hermes-inbox" "version" "1.0" "vendor" "hermes")'
_TAG_RE = re.compile(r"<[^>]+>")
_INLINE_WS_RE = re.compile(r"[ \t\r\f\v]+")
_BLANK_RE = re.compile(r"\n{3,}")


class MailError(RuntimeError):
    """邮箱读取失败；`str(exc)` 是给人看的一句话（前端直接展示）。"""


class MailNotFound(MailError):
    """这封邮件不存在（可能已被移动/删除）⇒ 前端按 404 处理。"""


# ---- 账号（来源与 xyy_mcp 完全一致：hermes_stock.email_accounts） ----------


def _account() -> Tuple[str, int, str, str]:
    """→ (imap_host, imap_port, auth_code, address)。"""
    try:
        conn = pymysql.connect(**_DB_CONFIG)
    except pymysql.MySQLError as exc:
        raise MailError(f"读邮箱配置失败（MySQL 连不上）：{exc}") from exc
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT email_address, imap_port, auth_code, imap_host FROM email_accounts "
                "WHERE email_address = %s AND is_active = TRUE",
                (MAIL_ACCOUNT,),
            )
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        raise MailError(f"email_accounts 里没有可用账号 {MAIL_ACCOUNT}（检查 is_active/授权码）")
    return str(row[3]), int(row[1]), str(row[2]), str(row[0])


@contextmanager
def _connect() -> Iterator[imaplib.IMAP4_SSL]:
    host, port, auth_code, addr = _account()
    try:
        imap = imaplib.IMAP4_SSL(host, port, timeout=MAIL_TIMEOUT)
    except OSError as exc:
        raise MailError(f"连不上邮箱服务器 {host}:{port}（{exc}）") from exc
    try:
        try:
            imap.login(addr, auth_code)
        except imaplib.IMAP4.error as exc:
            raise MailError(f"邮箱登录失败（授权码过期或被拦？）：{exc}") from exc
        try:  # ★ 163 必需，缺了后续命令一律 BYE Unsafe Login
            imap.xatom("ID", _MAIL_ID)
        except Exception:  # noqa: BLE001 - 不支持 ID 的服务器不该因此挂掉
            pass
        status, _ = imap.select(MAIL_FOLDER, readonly=True)
        if status != "OK":
            raise MailError(f"打开邮箱目录 {MAIL_FOLDER} 失败（{status}）")
        yield imap
    finally:
        try:
            imap.logout()
        except Exception:  # noqa: BLE001 - 断开失败不影响结果
            pass


# ---- 解析 -----------------------------------------------------------------


def _decode_words(raw: Optional[str]) -> str:
    if not raw:
        return ""
    out: List[str] = []
    for chunk, charset in decode_header(raw):
        if isinstance(chunk, bytes):
            out.append(chunk.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(chunk)
    return " ".join(out).strip()


def _split_addr(raw: str) -> Tuple[str, str]:
    """`张三 <a@b.com>` → ('张三', 'a@b.com')；只有地址时名字留空。"""
    text = (raw or "").strip()
    if "<" in text and ">" in text:
        name = text.split("<")[0].strip().strip('"')
        addr = text.split("<")[1].split(">")[0].strip()
        return _decode_words(name), addr
    return "", text


def extract_body(msg: email_lib.message.Message) -> Tuple[str, List[str]]:
    """→ (纯文本正文, 附件名列表)。text/plain 优先，HTML 去标签；附件不读内容。"""
    plain: List[str] = []
    html: List[str] = []
    files: List[str] = []

    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        disposition = (part.get("Content-Disposition") or "")
        filename = _decode_words(part.get_filename() or "")
        if disposition.startswith("attachment") or filename:
            if filename:
                files.append(filename)
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            payload = part.get_payload(decode=True) or b""
            text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - 单段解析失败不该让整封信失败
            continue
        (plain if ctype == "text/plain" else html).append(text)

    if plain:
        body = "\n".join(plain)
    elif html:
        body = _TAG_RE.sub("", "\n".join(html))
    else:
        body = ""
    body = _BLANK_RE.sub("\n\n", body.replace("\r\n", "\n")).strip()
    return body, files


def _excerpt(body: str) -> str:
    """列表用摘要：压成一行（换行折成空格），省得前端还要处理截断换行。"""
    flat = _INLINE_WS_RE.sub(" ", body.replace("\n", " "))
    return flat[:MAIL_EXCERPT_CHARS]


def _occurred_at(msg: email_lib.message.Message) -> str:
    """邮件头 Date → 北京时间 ISO（前端 `new Date()` 直接可用；坏头就退回当前时间）。"""
    try:
        dt = parsedate_to_datetime(msg.get("Date", ""))
    except Exception:  # noqa: BLE001
        dt = None
    if dt is None:
        return datetime.now(BJ).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BJ)
    return dt.astimezone(BJ).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def _norm_uid(uid: Any) -> str:
    """IMAP 回来的 uid 是 **bytes**（`b'1315301460'`）⇒ 统一成干净的数字串。

    踩过：直接 `str(uid)` 会得到 `"b'1315301460'"`，再拿去 `UID FETCH` 会被服务器
    判 `BAD Parse command error`（详情接口必挂）。
    """
    if isinstance(uid, bytes):
        return uid.decode("ascii", errors="replace")
    return str(uid)


def _row(uid: Any, msg: email_lib.message.Message) -> Dict[str, Any]:
    body, files = extract_body(msg)
    name, addr = _split_addr(_decode_words(msg.get("From", "")))
    return {
        "uid": _norm_uid(uid),
        "subject": _decode_words(msg.get("Subject", "")) or "(无主题)",
        "from_name": name,
        "from_addr": addr,
        "to_addr": _decode_words(msg.get("To", "")),
        "occurred_at": _occurred_at(msg),
        "excerpt": _excerpt(body),
        "body_len": len(body),
        "attachment_count": len(files),
    }


# ---- 对外 -----------------------------------------------------------------


def list_emails(days: int = 7, limit: int = 30, unread_only: bool = False) -> List[Dict[str, Any]]:
    """收件箱最近 `days` 天、最新的 `limit` 封（只读）。

    ⚠️ 每封都取 `RFC822`（= 含正文）：实测 30 封 1.16s、合计 141KB —— 换来列表能显示摘要，
    比"先取头再逐封补正文"少一轮往返。真慢了再改成两段式（头部 + 按需正文）。
    """
    since = (datetime.now(BJ) - timedelta(days=days)).strftime("%d-%b-%Y")
    criteria = f"(SINCE {since}{' UNSEEN' if unread_only else ''})"
    with _connect() as imap:
        status, data = imap.uid("search", None, criteria)  # type: ignore[arg-type]
        if status != "OK":
            raise MailError(f"邮箱搜索失败（IMAP SEARCH 返回 {status}）")
        uids = (data[0].split() if data and data[0] else [])[::-1]  # 新的在前
        if not uids:
            return []
        unseen = _unseen_uids(imap, since)
        out: List[Dict[str, Any]] = []
        for uid in uids[:limit]:
            status, msg_data = imap.uid("fetch", uid, "(RFC822)")
            if status != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
                continue
            row = _row(uid, email_lib.message_from_bytes(msg_data[0][1]))
            row["unread"] = uid in unseen
            out.append(row)
        return out


def _unseen_uids(imap: imaplib.IMAP4_SSL, since: str) -> set[bytes]:
    """顺带取一次未读集合（额外一次 SEARCH，几十毫秒）；失败就当全已读，不抛。"""
    try:
        status, data = imap.uid("search", None, f"(UNSEEN SINCE {since})")  # type: ignore[arg-type]
    except imaplib.IMAP4.error:
        return set()
    if status != "OK" or not data or not data[0]:
        return set()
    return set(data[0].split())


def get_email(uid: str) -> Dict[str, Any]:
    """单封全文（只读）。不存在 → `MailNotFound`。"""
    with _connect() as imap:
        status, msg_data = imap.uid("fetch", str(uid), "(RFC822)")
        if status != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
            raise MailNotFound(f"邮件不存在（uid={uid}，可能已被移动或删除）")
        msg = email_lib.message_from_bytes(msg_data[0][1])
        row = _row(uid, msg)
        body, files = extract_body(msg)
        row["body"] = body
        row["attachments"] = files
        return row
