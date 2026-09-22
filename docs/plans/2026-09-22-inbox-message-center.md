# 计划书 · 消息中心（inbox）· hermes-chat-lite

> 状态看板 + 设计 + 口径 + 坑。跨会话入口就是本文件；被实况推翻的决策**就地改在本文件**，不另开文件。
> 立项 2026-09-22（用户拍板：带「就这条问 agent」、首期只做白名单脚本主动推 + 邮件提醒、等级用灯、轮询默认 5 分钟且可手动改）。

## §0 状态看板

| 阶段 | 状态 | 交付物 | 验收方式 |
| --- | --- | --- | --- |
| P0 计划书 | ✅ 完成 | 本文件 | 用户 review |
| P1 数据层 | ✅ 完成（正式表已核验） | 正式表 `inbox_messages` 已建并通过结构与索引核对（§12） | 见 §12 验证记录 |
| P2 inbox 服务 | ✅ 完成 | `inbox/main.py` + `Dockerfile.inbox` + compose 的 `inbox` service + nginx `/inbox/` | 22 项接口断言全绿（§12） |
| P3 投递腿 | ✅ 完成 | `inbox/notify.py`（CLI + `push()` 函数入口）、`inbox/sync_inbox_email.py` + cron `3d862de00356`、`alert_588170.py` 接入 | 见 §12.3 / §12.4 |
| P4 前端 | ⬜ 未开始 | 图标 + 未读徽标 + 消息抽屉 + 等级灯 + Settings「消息」设置组 | vitest（新断言 RED/GREEN）+ 真浏览器探针 |
| P5 部署 | ⬜ 未开始 | 分支 push + 用户 `docker compose up -d --build` | 容器内网直问确认线上版本（不用口令） |

## §1 目标与范围

**目标**：在 hermes-chat-lite 里有一个消息中心 —— 股票信号提醒、邮件通知统一落到一处，看得到、能标记处理、能就这条直接问 agent。

**首期范围**（明确不做的事写在 §8）：
1. 一个独立的 `inbox` 服务（新增，**不动 Hermes 核心**；chat-lite 原本没有后端，这是新增的 sidecar）。
2. MySQL 表 `hermes_stock.inbox_messages`。
3. 投递腿：**脚本白名单主动推**（股票提醒）+ **邮件同步**（覆盖现有 `deliver=email` 的任务，零改动）。
4. 前端：header 消息图标 + 未读徽标 + 消息抽屉（复用 Settings 抽屉骨架）+ 等级灯。
5. 轮询：默认 **5 分钟**一次，可在 Settings 里手动改（改完立刻生效，免重建）。

## §2 架构与数据流

```
股票脚本（hermes 容器内，白名单）--\
                                    >--> MySQL hermes_stock.inbox_messages
邮件同步脚本（cron，15 分钟一次）--/            |
                                                v
                     inbox 服务（sidecar，只读 + 标记）  <-- 前端 5 分钟轮询（可改）
                                                |
                       nginx /inbox/ 反代（注入内部 token，清 Origin）
```

- 写入方**直连 MySQL**（脚本用 `scripts/.venv` 里的 pymysql），不经过 inbox 服务 —— 服务只管读和标记，职责单一、少一跳。
- agent（我）以后主动推提醒：走**现成 MCP 工具** `insert_hermes_stock`，零新工具。

## §3 数据模型

```sql
CREATE TABLE IF NOT EXISTS inbox_messages (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source       VARCHAR(16)  NOT NULL,              -- cron / email / agent
  category     VARCHAR(16)  NOT NULL,              -- 股票信号 / 邮件 / 提醒 / 系统
  level        VARCHAR(8)   NOT NULL DEFAULT 'info',-- action / warn / info
  title        VARCHAR(255) NOT NULL,
  body         MEDIUMTEXT,
  external_id  VARCHAR(191) NOT NULL,              -- 去重键，由推送方按语义生成
  occurred_at  DATETIME     NOT NULL,              -- 事件时间（Asia/Shanghai）
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at      DATETIME     DEFAULT NULL,
  archived_at  DATETIME     DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_source_external (source, external_id),
  KEY idx_unread (read_at, occurred_at),
  KEY idx_cat_time (category, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**去重/防刷屏口径**：写入一律 `INSERT ... ON DUPLICATE KEY UPDATE id=id`（幂等，实测重复推送影响行数=0）。`external_id` 由推送方按语义生成：

| 场景 | external_id | 效果 |
| --- | --- | --- |
| 同日只该响一次的规则（止盈触发、止损提醒、趋势确认） | `{脚本名}:{事件}:{YYYY-MM-DD}` | 同一交易日只推一条 |
| 方向/幅度不同算不同事件（涨跌 ±1%） | `{脚本名}:{方向}:{YYYY-MM-DD}` | 上/下各一条 |
| 邮件 | `Message-ID` | 天然唯一 |

**category 一律存 ASCII 代码，中文标签由前端映射**（实测踩坑：中文字面量进查询串会被 uvicorn 判成非法请求 —
原样 `?category=股票信号` 直接得到空响应/400，`Invalid HTTP request received`）。标签随前端改，不焊死在数据里：

| 代码 | 前端标签 | 用在哪 |
| --- | --- | --- |
| `stock` | 股票信号 | 510210/588170/600259 等脚本推送 |
| `email` | 邮件 | 邮件同步腿 |
| `alert` | 提醒 | 通用提醒（脚本/agent 推） |
| `system` | 系统 | 任务异常、健康检查类 |

`level` 同样只收 `action / warn / info`（前端不认识的值一律降级成 `info`，不报错）。

**归档语义**：归档 = 从默认列表消失**并顺带标记已读**（归档就是"处理完了"）；**撤回归档不恢复未读**
（否则徽标数字会莫名涨回去）。消息**不提供删除**，只归档。

## §4 inbox 服务接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（**不打鉴权**、不泄数据）：真连库 + `SELECT 表`，表没建/库不通 → 503（compose healthcheck 用它，避免"进程活着就算健康"的假阳性） |
| GET | `/inbox/messages?category=&unread=1&limit=50&before_id=&include_archived=` | 列表（倒序）+ `unread_count`；**只回摘要 `excerpt`（默认 200 字）+ `body_len`**，不回全文 |
| GET | `/inbox/messages/{id}` | 单条详情（全文） |
| GET | `/inbox/unread-count` | 只给徽标用的轻接口 |
| POST | `/inbox/messages/{id}/read?read=0\|1` | 标记已读 / 撤回已读 |
| POST | `/inbox/messages/read-all` | 全部已读（可带 `category`） |
| POST | `/inbox/messages/{id}/archive?archived=0\|1` | 归档 / 撤回归档 |

- 鉴权：请求头 `X-Inbox-Token`，由 **nginx 注入**（与现在注入 `API_SERVER_KEY` 同一姿势，**复用同一把 key** ⇒ `.env` 不用新增口令变量），前端产物里没有任何密钥。
- `category` 只接受 ASCII 代码，给中文 → **400 明确报错**（不静默返回空列表，省得当成"后端坏了"）。
- 只读 + 标记，**不提供删除**（要清理走 DB/归档）。

## §5 投递腿

### 5.1 通知助手 `inbox/notify.py`（股票白名单用）

- **运行时位置**：`/opt/data/scripts/notify.py` → **符号链接**到仓库里的 `inbox/notify.py`（仓库里版本化、可 review）。
- CLI：

  | 参数 | 说明 |
  | --- | --- |
  | `--title` | 必填（超 255 字自动截断加 …） |
  | `--body` / `--body-file` / stdin | 正文，三选一（省略则读 stdin） |
  | `--level` | `action` / `warn` / `info`（默认 `info`）；不认识的值降级 `info` 并 warn |
  | `--category` | `stock` / `email` / `alert`（默认） / `system` |
  | `--event` | 进 `external_id` 的事件名（默认取 title） |
  | `--dedupe` | `day`（默认：同一交易日只留一条）/ `hour` / `none` |
  | `--source` | 默认 `cron` |
  | `--occurred-at` | `'YYYY-MM-DD HH:MM:SS'`，默认现在（Asia/Shanghai） |
  | `--dry-run` / `--strict` | 只打印不写库 / 出错返回非 0（默认**恒为 0**） |

- **静默容错是硬要求**：调用它的是止盈、止损这类交易脚本，通知/DB 出问题**绝不能**让它们报错。
  脚本里的推荐写法：`python3 /opt/data/scripts/notify.py ... >/dev/null 2>&1 || true`
- **去重不靠"少推"**：`INSERT ... ON DUPLICATE KEY UPDATE id=id` ⇒ 哪怕脚本每 2 分钟触发一次也不会刷屏。
- **时间显式取 Asia/Shanghai**（`ZoneInfo`），不依赖容器 TZ。

**首期白名单 —— 结论：只有 1 个脚本需要改，其余全部由「邮件同步腿」零改动覆盖。**

> ★ 决策（2026-09-22，动手前查证后改的）：原计划是给 7 个提醒脚本各加一行 `notify` 调用点。
> 实测发现**这批提醒本来就都已进邮箱**（有的由 cron 的 `deliver=email` 发、有的脚本自己发信），
> 邮件腿会把它们搬进消息区；再在脚本里直推一次 = **同一个提醒出现两条**
> （两腿的去重键不同：邮件是 `Message-ID`，直推是 `{事件}:{交易日}`，互相看不见）。
> ⇒ 直推只留给**没有外发通道**的提醒。

| 任务 | 脚本 | 外发通道 | 首期处理 |
| --- | --- | --- | --- |
| 588170急跌信号提醒 | `alert_588170.py` | **只 print**（cron `deliver=local`）⇒ 除了翻 cron 输出，您根本收不到 | ✅ **加 `push()` 直推**（唯一改动） |
| 510210移动止盈监控 | `trailing_stop.sh` | cron `deliver=email` | 邮件腿覆盖，不改 |
| 510210涨跌±1%提醒 | `alert_510210_pct.py` | cron `deliver=email` | 同上 |
| 三因子离场信号推送 | `exit_signal_email.sh` | cron `deliver=email` | 同上 |
| 510210止损+冷却期尾盘提醒 | `stop_loss_cooldown.py` | cron `deliver=email` | 同上 |
| 600259关键价提醒 | `alert_600259_levels.py` | 脚本自己发信 | 同上 |
| 模拟盘早间选股推送 | `sim_pick_daily.py` | 脚本自己发信 | 同上 |
| 稀土现货日度采集 | `rare_earth_spot_daily.py` | 脚本自己发信 | 同上（本来不在首期名单，顺带覆盖了） |

> 暂不会改：`*/2` 的 4 个高频轮询任务（多标实时监控、模拟盘持仓监控等）—— 每 2 分钟一次，全量接会一天几百条，把消息区淹没。
> `notify` 以后真正的用武之地：① 不进邮箱的通知（任务异常、健诊结果）；② 需要比邮件腿更快到达的提醒；③ **以后新加的定时任务**（一行接入，前端不用动）。


### 5.2 邮件同步 `inbox/sync_inbox_email.py`（cron，15 分钟）

- **运行时**：cron 任务「消息中心-邮件同步」（`3d862de00356`，`*/15 * * * *`，`no_agent`，`deliver=local`）
  跑 `scripts/sync_inbox_email.sh` → `.venv/bin/python3 scripts/sync_inbox_email.py --days 3 --max 50`
  （wrapper 的必要性同 `archive_to_mysql.sh`：cron 的系统 python3 没有 pymysql）。
- 凭据取法复刻 MCP `read_emails`：从 MySQL `email_accounts` 读 `xd6022@163.com` 的 IMAP 配置。
- **只收自己发件箱来的通知邮件**（发件人 `xd602201@163.com`）→ 现有 6~7 个 `deliver=email` 的任务
  （早盘简报、日报、周报、记忆整理、各类触发提醒、选股、稀土）**零改动自动进消息区**。
- **只读不改邮箱**：`SELECT INBOX readonly=True` —— 绝不把邮件改成已读（实测跑完邮箱未读数不变）。
- **163 必须发 IMAP ID 命令**（LOGIN 之后），否则 `SEARCH/FETCH` 直接 `BYE Unsafe Login`。
- **等级只看标题**（扫正文会把"日报里提到止盈"误判成 action）：
  `action`=触发/触及/止损/止盈/急跌/跌破/上破/异动/减仓/加仓/建议；`warn`=确认/提醒/信号/预警/离场/冷却/选股；其余 `info`。
- **agent 型 cron 投递的邮件**主题是 `Re: Hermes Agent`、正文以 `Cronjob Response: <任务名>` 开头 ⇒
  标题改取**任务名**，并把那段头部从正文里去掉。
- 去重按 `Message-ID`（没有则退化成 主题+时间+发件人 的 sha1）；邮件原样留在邮箱里。

## §6 前端

| 元素 | 设计 |
| --- | --- |
| 图标 | header 右侧（主题开关左边、Settings 左边），铃铛 SVG |
| 未读徽标 | 数字，>99 显示 `99+`；0 时不渲染 |
| 抽屉 | **复用 Settings 那套右侧抽屉骨架**（PC 480px / 手机全屏、遮罩点击关闭、✕ 关闭） |
| 等级灯 | 🔴 `action`（要动手） / 🟡 `warn` / ⚪ `info`。**与状态行的四态灯不是同一套**，不复用词汇表 |
| 列表项 | 灯 + 标题 + 类型标签 + 时间；正文只给 2 行摘要（早盘简报这类几千字的必须截断） |
| 详情 | 复用现有 markdown 渲染（含修好的 `table-wrapper`）；长内容在抽屉内滚动 |
| 动作 | `标记已读` / `归档` / **`就这条问 agent`**（把正文当上下文起一轮 `/v1/runs`，走现有发送链路）/ `全部已读` / `立即刷新` |
| 筛选 | 全部 / 股票信号 / 邮件 / 提醒（按 `category`） |
| 地址 | 抽屉打开时地址带 `#/inbox`（刷新/返回键不丢，保持"地址即状态" D3） |
| 新消息 | 复用现有 `Notice` 轻提示（~5s 自消、点击即消） |

## §7 轮询策略（前端可控）

- **默认 5 分钟**；Settings → 「消息」里可改：`关闭 / 30秒 / 1分钟 / 5分钟 / 15分钟 / 30分钟 / 1小时`，存 localStorage（与头像同款存法）⇒ **改完立刻生效、免重建、每设备独立**（手机和 PC 可以不同）。
- **`关闭` 档的语义**（周末那种"只想聊天、不想被邮件打扰"的场景）：**完全停止定时拉取**；
  此时点图标 / 打开抽屉**也不自动拉**，只有手动点「立即刷新」才拉一次。
- 立即拉取的时机（非关闭档）：**打开抽屉 / 回到前台 / 点图标**。
- 页面不可见时**暂停**（复用现有 `src/lib/page-lifecycle.ts`）。
- 失败退避：1→2→4→…→30 分钟封顶，恢复后回设定值；失败**不弹错误**，只在抽屉里一行小字「上次拉取失败 HH:MM」。
- 不做"按交易时段自动切换间隔"：隐式行为会让人困惑，且他要的是"我自己改"。

## §8 保留 / 退回 / 新增（改 chat-lite 的三栏表）

| 保留（一个都不动） | 新增 | 明确不做 |
| --- | --- | --- |
| 会话视图 / SSE / 段渲染 / 地址即状态 / 审批卡片 / 状态行四态灯 / 现有 28 个 cron 的 schedule | ① 表 §3 ② inbox 服务 §4 ③ `notify.py` + 白名单脚本调用点 ④ `sync_inbox_email.py` + cron ⑤ 前端图标/徽标/抽屉/等级灯/Settings 设置组 ⑥ nginx 一条 location ⑦ compose 一个 service | 改 Hermes 核心 / 全量收 cron 输出目录 / 服务端推送管道（SSE 推送） / 前端存未读态 / 消息删除 / 按交易时段自动切间隔 |

## §9 坑（已知，动手前先看）

| 级别 | 坑 |
| --- | --- |
| 会返工 | 白名单外的高频任务接进来必然淹没；未读态若存前端则换设备即丢 |
| 渲染 | 股票提醒正文含**行情表格**，抽屉窄会被挤（v2.1 同类事故）；正文长（早盘简报 ~8k 字）⇒ 列表只给摘要、详情才全文 |
| 时间 | **容器 TZ 实测 = Asia/Shanghai（CST）**，`date` 直接给北京时间（2026-09-22 复核，此前误记为 UTC）；即便如此，脚本仍**显式**用 `ZoneInfo("Asia/Shanghai")` 生成 `occurred_at`，别依赖容器 TZ（TZ 一变就会静默写错 8 小时）；前端显示用浏览器时区 |
| 可靠性 | `notify.py` 必须静默容错（通知挂掉绝不能影响交易脚本） |
| 口径 | IMAP UID 在 163 上会变 ⇒ 去重必须用 `Message-ID`；163 有拉取限流 ⇒ 同步间隔 ≥15 分钟 |
| 编码 | **中文不能进查询串**：`?category=股票信号` 会被 uvicorn 判成非法请求（空响应 + `Invalid HTTP request received`）⇒ category 存 ASCII 代码（§3）；正文里的中文没问题（JSON body 正常 UTF-8） |
| 安全 | inbox 服务拿 MySQL 凭据 ⇒ 多一个能写 `hermes_stock` 的进程：内部 token + 只在内网 + 走 Caddy 口令闸门；**库口令不写进仓库**，走 `.env` 的 `INBOX_MYSQL_PASSWORD` |

## §10 验证阶梯

1. `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`
2. `node node_modules/vitest/vitest.mjs run`（新断言必须 RED/GREEN：还原源文件后必红）
3. 服务：容器内 curl 四个接口 + **按 DB/表读回**核对（写后验证铁律）
4. `node node_modules/vite/bin/vite.js build` + 产物自检 grep
5. 真浏览器探针（本技能 `scripts/` 模板）：图标 → 抽屉 → 筛选 → 已读 → 徽标数字变化
6. 线上复验：容器内网直问，不用口令

## §11 部署（用户侧）

```bash
cd ~/workspace/project/hermes-chat-lite && git pull && docker compose up -d --build
```

新增的 `inbox` service 需接 `net_openclaw`（compose 里已声明），nginx 新增一条 `/inbox/` location（清 Origin + 注入内部 token）。

**用户侧的一次性准备**（两行）：

```bash
cd ~/workspace/project/hermes-chat-lite
# ① .env 加一行库口令（仓库里不写明文）
grep -q '^INBOX_MYSQL_PASSWORD=' .env || printf 'INBOX_MYSQL_PASSWORD=hermes@106\n' >> .env
# ② 建正式表（DDL 见 §3，已在冒烟表上验证过语法）
```

## §12 验证记录（2026-09-22）

在**正式表还没建**的前提下做完的验证 —— 用的是同名冒烟表 `inbox_messages_smoke`（跑完已 DROP，`hermes_stock` 里不留痕）：

| 验的什么 | 怎么验的 | 结果 |
| --- | --- | --- |
| DDL 语法 / 字段类型 / 长正文（3023 字） | `scripts/.venv` 的 pymysql 跑真建表 + 插三条 | ✅ 全部通过 |
| 去重口径 | 同 `(source, external_id)` 再推一次 | ✅ 影响行数 0，无新行 |
| 摘要截断 | `LEFT(body,200)` | ✅ 列表只回 200 字 + `body_len` |
| 写后读回 | **换一条独立连接**读（避免 REPEATABLE READ 快照误判） | ✅ 行数/未读数一致 |
| 服务 22 项接口断言 | 真起 uvicorn（本机 18123）+ 真 MySQL，curl 全接口 | ✅ 22 通过 / 0 失败 |
| 鉴权三态 | 无 token / 错 token → 401，对 token → 200 | ✅ |
| 归档语义 | 归档后默认列表消失、未读不变之外的口径；撤回归档不恢复未读 | ✅ |
| 中文过滤条件 | `?category=股票信号` | ✅ 400 明确报错（服务端日志同时印证 `Invalid HTTP request received`） |

脚本留档（下次改完重跑即可）：`/opt/data/.verify/inbox_smoke_ddl.py`、`/opt/data/.verify/test_inbox_service.sh`、
`/opt/data/.verify/run_inbox_smoke.sh`（起本地冒烟服务）、`/opt/data/.verify/mk_inbox_venv.sh`（建隔离 venv）。

### §12.1 正式表核验（用户建表后，2026-09-22）

| 验的什么 | 结果 |
| --- | --- |
| 结构：11 列的类型/可空/键/默认值/自增 逐列比对 `information_schema` | ✅ 与 §3 的 DDL **完全一致** |
| 索引：`PRIMARY(id)` / `uk_source_external(source,external_id)` / `idx_unread(read_at,occurred_at)` / `idx_cat_time(category,occurred_at)` | ✅ 四条全对 |
| 写库：插一条测试消息（`external_id=smoke:link-check:2026-09-22`），再推一次同 external_id | ✅ 无重复行（幂等） |
| 服务打正式表端到端（uvicorn + 真库，本地 18124） | ✅ 17 项断言全绿：鉴权三态、列表摘要不带 body、详情全文、`+08:00`、类型过滤、标记已读、归档后撤出默认列表 |
| 服务写下去的已读/归档**换独立连接直接读库**复核 | ✅ `read_at`/`archived_at` 均已落库（19:40:12） |
| 遗留 | 表里留了 **1 条已归档的测试消息 id=1**（按"只归档不删除"的口径），要清掉说一声 |

⚠️ 脚本本身踩的两个坑（已修，别再犯）：① 期望 `COLUMN_KEY` 时忘了 MySQL 的 `MUL` 只给多列索引的**第一列**、
`auto_increment` 在 `EXTRA` 而不在 `DEFAULT` ⇒ 一版假报警 5 条；② 断言忘了真发请求，复用了上一条响应。

### §12.2 时区复核（顺手纠正一条旧认知）

`date` → **CST（Asia/Shanghai）**，`date -u` 才是 UTC ⇒ 容器 TZ 是**北京时间**（此前记的"本机是 UTC"是错的）。
结论不变：脚本写 `occurred_at` 仍**显式**用 `ZoneInfo("Asia/Shanghai")`，不依赖容器 TZ。

### §12.3 `notify.py` 自检（2026-09-22，12 项全绿）

脚本 `/opt/data/.verify/test_notify.sh`。验的点：dry-run 不写库；真推一条后**换独立连接**读回
`level/category/occurred_at`；同事件再推一次**不新增行**（去重命中）；`--dedupe hour/none` 的键形态
（`e1:20260922T19` / `e1:20260922T194226`）；**连不上库时退出码仍为 0**（`--strict` 才给 1）；
不认识的 `level` 降级 `info`；stdin 正文可用。

自检留下的 4 条消息（1 条链路冒烟 + 3 条 notify 自检）**已全部归档**，
`inbox_messages` 当前 **未读 = 0**（前端首屏是干净的空态）。
（重跑注意：`test_notify.sh` 的事件名带时间戳，否则同一天重跑会被去重吃掉 → "行数 +1"那条断言假红。）

### §12.4 邮件同步腿（2026-09-22，真邮箱真库）

| 验的什么 | 结果 |
| --- | --- |
| 抓取范围 | 近 3 天、发件人 `xd602201@163.com` ⇒ 抓到 **10 封**（含 4 封 agent 型 cron 投递 + 6 封脚本自己发的） |
| 首次同步 | 新增 **10 条**（source=email），等级分布 action 3 / warn 3 / info 4 |
| 二次同步（幂等） | 新增 **0 条**，去重命中 10 条 |
| agent 型邮件的标题 | `Re: Hermes Agent` → 正确换成任务名（`每日早盘简报-XYY` /`记忆整理-每周强制`） |
| 正文头部 | `Cronjob Response: …(job_id)…----` 那段已剥掉 |
| **没有改动邮箱状态** | 跑完 IMAP `UNSEEN` 数 **77**（未被标成已读）——`readonly=True` 生效 |
| wrapper 路径 | `bash scripts/sync_inbox_email.sh` 退出码 0、去重命中 10（cron 的真实调用姿势） |

### §12.5 588170 直推链路（2026-09-22，端到端）

用真脚本的副本（**只改两个测试旋钮**：交易时段强制 True、行情源换假报价 `-3.33%`，其余逻辑一字不动）
跑真库：脚本 stdout 出告警 + 库里落一行 `source=cron / category=stock / level=action`、
`external_id=588170:dipA:20260922`；再跑一次不新增行（当天去重）。
`push()` 的日志走 stderr ⇒ **调用方的 stdout 保持干净**（那条 stdout 是 cron 的投递内容）。
测试留档：`/opt/data/.verify/test_588170_notify.py`。
