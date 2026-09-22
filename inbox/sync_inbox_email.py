#!/usr/bin/env python3
"""把「自己发的」通知邮件同步进消息中心（hermes-chat-lite 的消息区）。

覆盖的是**现有 6~7 个 `deliver=email` 的定时任务**：它们本来就会把通知邮件发到
`xd6022@163.com`，这里只做「收件箱 → inbox_messages」的搬运 ⇒ **不需要改任何 cron 配置**。

运行时位置 = `/opt/data/scripts/sync_inbox_email.py`（符号链接到本文件，仓库里版本化）。

口径（每条都是踩过或想清楚才定的）：

1. **只收自己发出通知**（发件人 `xd602201@163.com`）：别人发的、营销、客服回复一律不进消息区。
2. **去重按 `Message-ID`**（`source='email'`）——163 的 IMAP UID 会变，不能拿 UID 当键；没有
   `Message-ID` 时退化成 (主题+时间+发件人) 的 sha1，仍然稳定。
3. **只读不标记**：`SELECT ... readonly=True`，绝不把邮件改成已读（那是您邮箱的语义，不该被脚本动）。
4. **163 必须发 IMAP ID 命令**（LOGIN 之后），否则 SEARCH/FETCH 直接 `BYE Unsafe Login`。这条是硬坑，
   照抄 xyy_mcp 的实现。
5. 时间取邮件头 `Date` 并转 **Asia/Shanghai**（不是"抓取时刻"），补跑历史邮件时时间才是对的。
6. 等级按关键词映射（见 `pick_level`）：`action` 要动手 / `warn` 提示 / `info` 日报周报类。
7. agent 型 cron 投递过来的邮件主题是 `Re: Hermes Agent`、正文以 `Cronjob Response: <任务名>` 开头 ——
   这种情况**标题取任务名**（`Re: Hermes Agent` 当标题等于没标题），并把那段头部从正文里去掉。

用法：`python3 /opt/data/scripts/sync_inbox_email.py [--days 3] [--max 50] [--dry-run]`
环境变量可覆盖：INBOX_MAIL_ACCOUNT / INBOX_MAIL_SENDER / INBOX_MAIL_DAYS / INBOX_MAIL_MAX。
"""

from __future__ import annotations

import argparse
import email as email_lib
import email.message  # noqa: F401  —— 让 email_lib.message.Message 的类型注解可用
import hashlib
import imaplib
import os
import re
import sys
from datetime import datetime, timedelta
from email.header import decode_header
from email.utils import parsedate_to_datetime
from typing import Any
from zoneinfo import ZoneInfo

import pymysql

BJ = ZoneInfo("Asia/Shanghai")

MAIL_ACCOUNT = os.environ.get("INBOX_MAIL_ACCOUNT", "xd6022@163.com")
MAIL_SENDER = os.environ.get("INBOX_MAIL_SENDER", "xd602201@163.com")

DB: dict[str, Any] = dict(
    host=os.environ.get("NOTIFY_MYSQL_HOST", os.environ.get("MYSQL_HOST", "mysql")),
    port=int(os.environ.get("NOTIFY_MYSQL_PORT", os.environ.get("MYSQL_PORT", "3306"))),
    user=os.environ.get("NOTIFY_MYSQL_USER", os.environ.get("MYSQL_USER", "hermes")),
    password=os.environ.get("NOTIFY_MYSQL_PASSWORD", os.environ.get("MYSQL_PASSWORD", "hermes@106")),
    database=os.environ.get("NOTIFY_MYSQL_DATABASE", os.environ.get("MYSQL_DATABASE", "hermes_stock")),
    charset="utf8mb4",
    autocommit=True,
    connect_timeout=3,
    read_timeout=15,
    write_timeout=10,
)

TABLE = os.environ.get("NOTIFY_TABLE", "inbox_messages")

# 等级关键词：**只看标题**（扫正文会把"日报里提到止盈"误判成要动手）；先 action 后 warn，都不中就是 info
ACTION_WORDS = ("触发", "触及", "止损", "止盈", "急跌", "跌破", "上破", "异动", "减仓", "加仓", "建议")
WARN_WORDS = ("确认", "提醒", "信号", "预警", "离场", "冷却", "选股")

# agent 型 cron 投递过来的邮件：正文头部形如
#   Cronjob Response: 每日早盘简报-XYY
#   (job_id: 447bde9f0794)
#   -------------
_CRON_HEAD = re.compile(r"^Cronjob Response:\s*(.+?)\s*(?:\(job_id:[^)]*\))?\s*\n-{3,}\s*\n?", re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def decode_mime_words(raw: str) -> str:
    if not raw:
        return ""
    parts = decode_header(raw)
    out: list[str] = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            out.append(chunk.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(chunk)
    return " ".join(out).strip()


def extract_body(msg: email_lib.message.Message) -> str:
    """优先 text/plain；没有就退到 text/html 去标签。"""
    plain: list[str] = []
    html: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if part.get("Content-Disposition", "").startswith("attachment"):
                continue
            if ctype not in ("text/plain", "text/html"):
                continue
            try:
                payload = part.get_payload(decode=True) or b""
                text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            except Exception:
                continue
            (plain if ctype == "text/plain" else html).append(text)
    else:
        try:
            payload = msg.get_payload(decode=True) or b""
            text = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")
        except Exception:
            text = ""
        if msg.get_content_type() == "text/html":
            html.append(text)
        else:
            plain.append(text)

    if plain:
        return "\n".join(plain).strip()
    if html:
        return _TAG_RE.sub("", "\n".join(html)).strip()
    return ""


def pick_level(subject: str, body: str) -> str:
    """标题命中的关键词决定等级（body 参数保留但**不参与判断**，理由见文件头部注释）。"""
    title = subject or ""
    if any(w in title for w in ACTION_WORDS):
        return "action"
    if any(w in title for w in WARN_WORDS):
        return "warn"
    return "info"


def parse_cron_delivery(subject: str, body: str) -> tuple[str, str]:
    """agent cron 投递的邮件：标题换成任务名，正文去掉头部那三行。"""
    m = _CRON_HEAD.match(body or "")
    if not m:
        return subject, body
    job_name = m.group(1).strip()
    rest = body[m.end():].strip()
    return (job_name or subject), rest


def fetch_account(conn: pymysql.connections.Connection) -> tuple[str, int, str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT email_address, imap_port, auth_code, imap_host FROM email_accounts "
            "WHERE email_address = %s AND is_active = TRUE",
            (MAIL_ACCOUNT,),
        )
        row = cur.fetchone()
    if not row:
        raise RuntimeError(f"email_accounts 里没有可用账号 {MAIL_ACCOUNT}")
    return row[3], int(row[1]), row[2], row[0]  # host, port, auth_code, addr  # type: ignore[return-value]


def fetch_emails(days: int, max_count: int) -> list[dict[str, Any]]:
    host, port, auth_code, addr = ("", 0, "", "")
    conn = pymysql.connect(**DB)
    try:
        host, port, auth_code, addr = fetch_account(conn)  # type: ignore[misc]
    finally:
        conn.close()

    imap = imaplib.IMAP4_SSL(host, port, timeout=30)
    rows: list[dict[str, Any]] = []
    try:
        imap.login(addr, auth_code)
        try:  # ★ 163 必须的 ID 命令（少这一步会被判 "Unsafe Login" 直接断连）
            imap.xatom("ID", '("name" "hermes-inbox-sync" "version" "1.0" "vendor" "hermes")')
        except Exception:
            pass
        status, _ = imap.select("INBOX", readonly=True)  # ★ 只读：不改您的未读状态
        if status != "OK":
            raise RuntimeError(f"SELECT INBOX 失败: {status}")

        since = (datetime.now(BJ) - timedelta(days=days)).strftime("%d-%b-%Y")
        status, data = imap.uid("search", None, f"(SINCE {since})")  # type: ignore[arg-type]
        if status != "OK" or not data or not data[0]:
            return []
        uids = data[0].split()[::-1]  # 新的在前

        for uid in uids:
            if len(rows) >= max_count:
                break
            status, msg_data = imap.uid("fetch", uid, "(RFC822)")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue
            msg = email_lib.message_from_bytes(msg_data[0][1])

            sender_raw = msg.get("From", "")
            sender = sender_raw.split("<")[1].split(">")[0].strip() if "<" in sender_raw else sender_raw
            if MAIL_SENDER.lower() not in sender.lower():
                continue

            subject = decode_mime_words(msg.get("Subject", ""))
            body = extract_body(msg)
            title, body = parse_cron_delivery(subject, body)

            try:
                dt = parsedate_to_datetime(msg.get("Date", ""))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=BJ)
                occurred_at = dt.astimezone(BJ).strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                occurred_at = datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")

            message_id = (msg.get("Message-ID") or "").strip()
            if not message_id:
                message_id = "sha1:" + hashlib.sha1(
                    f"{subject}|{occurred_at}|{sender}".encode("utf-8")
                ).hexdigest()

            rows.append({
                "title": title or "(无主题)",
                "body": body,
                "external_id": message_id[:191],
                "occurred_at": occurred_at,
                "level": pick_level(title, body),
            })
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把「自己发的」通知邮件同步进消息中心")
    ap.add_argument("--days", type=int, default=int(os.environ.get("INBOX_MAIL_DAYS", "3")))
    ap.add_argument("--max", type=int, default=int(os.environ.get("INBOX_MAIL_MAX", "50")))
    ap.add_argument("--dry-run", action="store_true", help="只打印，不写库")
    args = ap.parse_args(argv)

    try:
        mails = fetch_emails(args.days, args.max)
    except Exception as exc:
        print(f"[sync-inbox-email] ✗ 抓取失败: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"[sync-inbox-email] 抓到 {len(mails)} 封（发件人={MAIL_SENDER}，近 {args.days} 天）")
    if not mails:
        return 0

    if args.dry_run:
        for m in mails:
            print(f"  [{m['level']}] {m['occurred_at']} {m['title'][:60]} (id={m['external_id'][:40]})")
        return 0

    inserted = 0
    conn = pymysql.connect(**DB)
    try:
        with conn.cursor() as cur:
            for m in mails:
                cur.execute(
                    f"INSERT INTO {TABLE} (source, category, level, title, body, external_id, occurred_at) "
                    f"VALUES (%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE id=id",
                    ("email", "email", m["level"], m["title"][:255], m["body"], m["external_id"], m["occurred_at"]),
                )
                if cur.rowcount == 1:
                    inserted += 1
                    print(f"  + [{m['level']}] {m['occurred_at']} {m['title'][:60]}")
    finally:
        conn.close()

    print(f"[sync-inbox-email] 新增 {inserted} 条，去重命中 {len(mails) - inserted} 条（邮件本身不动，仍保留在邮箱）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
