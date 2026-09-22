#!/usr/bin/env python3
"""往消息中心推一条消息（hermes-chat-lite 的消息区）。

运行时位置 = `/opt/data/scripts/notify.py`（**指向本文件的符号链接**，本文件在仓库里版本化：
hermes-chat-lite / inbox/notify.py）。

设计要点（都是踩过/想清楚才这么定的）：

1. **静默容错、退出码恒为 0**（除非显式 `--strict`）：调用它的是止盈、止损这类交易脚本，
   通知服务/数据库出问题**绝不能**让交易脚本报错或被 cron 记成失败。
2. **去重靠 `external_id`**，不是靠"少推"：默认 `--dedupe day` ⇒ 同一事件同一交易日只留一条，
   所以哪怕脚本每 2 分钟触发一次也不会刷屏（`INSERT ... ON DUPLICATE KEY UPDATE id=id` 幂等）。
3. **时间显式取 Asia/Shanghai**（`ZoneInfo`）：容器 TZ 现在是 CST，但不依赖它 —— TZ 一变就会静默写错 8 小时。
4. 只写 `inbox_messages`，**不碰任何业务表**；`category` 用 ASCII 代码（中文进查询串会被 uvicorn 判非法请求）。

用法：

    python3 /opt/data/scripts/notify.py --title "510210 移动止盈触发" --body "建议减仓1700股" \\
        --level action --category stock --event trailing_stop

    echo "多行正文" | python3 /opt/data/scripts/notify.py --title "收盘确认" --event close_confirm

    # 在交易脚本里最稳的写法（再不济也不影响主流程）：
    python3 /opt/data/scripts/notify.py --title "..." --event x >/dev/null 2>&1 || true
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

BJ = ZoneInfo("Asia/Shanghai")

DB: dict[str, Any] = dict(
    host=os.environ.get("NOTIFY_MYSQL_HOST", os.environ.get("MYSQL_HOST", "mysql")),
    port=int(os.environ.get("NOTIFY_MYSQL_PORT", os.environ.get("MYSQL_PORT", "3306"))),
    user=os.environ.get("NOTIFY_MYSQL_USER", os.environ.get("MYSQL_USER", "hermes")),
    password=os.environ.get("NOTIFY_MYSQL_PASSWORD", os.environ.get("MYSQL_PASSWORD", "hermes@106")),
    database=os.environ.get("NOTIFY_MYSQL_DATABASE", os.environ.get("MYSQL_DATABASE", "hermes_stock")),
    charset="utf8mb4",
    autocommit=True,
    connect_timeout=3,
    read_timeout=5,
    write_timeout=5,
)

TABLE = os.environ.get("NOTIFY_TABLE", "inbox_messages")
LEVELS = ("action", "warn", "info")
CATEGORIES = ("stock", "email", "alert", "system")
TITLE_MAX = 255


def _warn(msg: str) -> None:
    print(f"[notify] WARN {msg}", file=sys.stderr)


def build_external_id(event: str, dedupe: str, now: datetime) -> str:
    """去重键：`{事件}:{粒度}`。day=同一交易日一条，hour=同一小时一条，none=每次都进。"""
    if dedupe == "none":
        return f"{event}:{now.strftime('%Y%m%dT%H%M%S')}"
    if dedupe == "hour":
        return f"{event}:{now.strftime('%Y%m%dT%H')}"
    return f"{event}:{now.strftime('%Y%m%d')}"


def read_body(args: argparse.Namespace) -> str:
    # 注意：`--body` 的默认值是 **None**（不是空串）——用来区分"显式给了空正文"与"没给"，
    # 否则函数式入口 push() 传空正文时会掉进读 stdin 的分支，把调用方卡住。
    if args.body is not None:
        return args.body
    if args.body_file:
        try:
            with open(args.body_file, encoding="utf-8") as fh:
                return fh.read()
        except OSError as exc:
            _warn(f"读不到 --body-file（{exc}），改用 stdin/空正文")
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return ""


def push(
    title: str,
    body: str = "",
    level: str = "info",
    category: str = "alert",
    event: str = "",
    source: str = "cron",
    dedupe: str = "day",
    occurred_at: str = "",
    dry_run: bool = False,
) -> bool:
    """给 python 脚本用的函数式入口：成功 True，失败 False，**永不抛异常**。

    典型用法（交易脚本里就这三行，包在 try 里是为了连 import 都不炸）：

        try:
            sys.path.insert(0, "/opt/data/scripts")
            from notify import push
            push(title="588170 急跌 -3.3%", body=text, level="action",
                 category="stock", event="588170:dipA")
        except Exception:
            pass
    """
    argv = ["--title", title, "--body", body, "--level", level, "--category", category,
            "--source", source, "--dedupe", dedupe, "--quiet"]
    if event:
        argv += ["--event", event]
    if occurred_at:
        argv += ["--occurred-at", occurred_at]
    if dry_run:
        argv += ["--dry-run"]
    try:
        return main(argv) == 0
    except Exception as exc:  # noqa: BLE001 —— 同上：绝不连累调用方
        _warn(f"push() 异常（已忽略）: {type(exc).__name__}: {exc}")
        return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="往消息中心推一条消息（失败静默）")
    ap.add_argument("--title", required=True)
    ap.add_argument("--body", default=None, help="正文；不给则读 stdin（给空串也算给了）")
    ap.add_argument("--body-file", default="")
    ap.add_argument("--level", default="info")
    ap.add_argument("--category", default="alert")
    ap.add_argument("--event", default="")
    ap.add_argument("--source", default="cron")
    ap.add_argument("--dedupe", choices=("day", "hour", "none"), default="day")
    ap.add_argument("--occurred-at", default="", help="'YYYY-MM-DD HH:MM:SS'，默认现在（Asia/Shanghai）")
    ap.add_argument("--dry-run", action="store_true", help="只打印将写入的内容，不写库")
    ap.add_argument("--quiet", action="store_true", help="连成功日志也不打（给 push() 用，保持调用方 stdout 干净）")
    ap.add_argument("--strict", action="store_true", help="出错时返回非 0（默认恒为 0）")
    args = ap.parse_args(argv)

    try:
        now = (
            datetime.strptime(args.occurred_at, "%Y-%m-%d %H:%M:%S")
            if args.occurred_at
            else datetime.now(BJ).replace(tzinfo=None)
        )
        level = args.level if args.level in LEVELS else "info"
        if args.level not in LEVELS:
            _warn(f"level={args.level!r} 不认识，降级成 info")
        category = args.category if args.category in CATEGORIES else "alert"
        if args.category not in CATEGORIES:
            _warn(f"category={args.category!r} 不认识，降级成 alert")

        title = args.title.strip()
        if len(title) > TITLE_MAX:
            title = title[: TITLE_MAX - 1] + "…"
        event = (args.event or title).strip() or "event"
        external_id = build_external_id(event, args.dedupe, now)
        body = read_body(args)

        row = {
            "source": args.source,
            "category": category,
            "level": level,
            "title": title,
            "body": body,
            "external_id": external_id,
            "occurred_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        }

        if args.dry_run:
            print("[notify] dry-run 将写入：")
            for k, v in row.items():
                shown = v if len(str(v)) < 200 else str(v)[:200] + f"…（共 {len(str(v))} 字）"
                print(f"  {k}: {shown}")
            return 0

        import pymysql  # 延迟导入：没装 pymysql 时也不该让调用方崩

        conn = pymysql.connect(**DB)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    f"INSERT INTO {TABLE} (source, category, level, title, body, external_id, occurred_at) "
                    f"VALUES (%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE id=id",
                    (row["source"], row["category"], row["level"], row["title"], row["body"],
                     row["external_id"], row["occurred_at"]),
                )
                inserted = cur.rowcount == 1
        finally:
            conn.close()
        print(f"[notify] {'已推送' if inserted else '已存在（去重命中，未新增）'}: "
              f"{level}/{category} {title} (external_id={external_id})",
              file=sys.stderr if args.quiet else sys.stdout)
        return 0
    except Exception as exc:  # noqa: BLE001 —— 通知失败绝不连累调用方
        _warn(f"推送失败（已忽略，不影响主流程）: {type(exc).__name__}: {exc}")
        return 1 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
