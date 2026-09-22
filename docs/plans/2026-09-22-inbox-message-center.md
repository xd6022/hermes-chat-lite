# 计划书 · 消息中心（inbox）· hermes-chat-lite

> 状态看板 + 设计 + 口径 + 坑。跨会话入口就是本文件；被实况推翻的决策**就地改在本文件**，不另开文件。
> 立项 2026-09-22（用户拍板：带「就这条问 agent」、首期只做白名单脚本主动推 + 邮件提醒、等级用灯、轮询默认 5 分钟且可手动改）。

## §0 状态看板

| 阶段 | 状态 | 交付物 | 验收方式 |
| --- | --- | --- | --- |
| P0 计划书 | ✅ 完成 | 本文件 | 用户 review |
| P1 数据层 | ✅ 完成（**只差正式表**） | DDL 已用同名冒烟表 `inbox_messages_smoke` 实测通过（建表/去重/摘要截断） | 见 §12 验证记录 |
| P2 inbox 服务 | ✅ 完成 | `inbox/main.py` + `Dockerfile.inbox` + compose 的 `inbox` service + nginx `/inbox/` | 22 项接口断言全绿（§12） |
| P3 投递腿 | ⬜ 未开始 | `scripts/notify.py` 助手 + 白名单脚本改写 + `sync_inbox_email.py` + cron | 跑一次脚本，按 DB 读回验证消息行 |
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

### 5.1 通知助手 `notify.py`（股票白名单用）

- 用法：`python3 /opt/data/scripts/notify.py --title "510210 移动止盈触发" --body "..." --level action --category 股票信号 --event "trailing_stop"`
- **必须静默容错**：整体 try/except + 2 秒超时 + 失败只记日志，**绝不因为通知服务挂了让交易脚本报错**（这是硬要求）。
- 脚本内调用点包在 `|| true` 风格的兜底里。

**首期白名单（改脚本，每个脚本一行调用点）**：

| 任务 | job_id | 备注 |
| --- | --- | --- |
| 510210移动止盈监控 | a3494314d70a | 目前 deliver=email，邮件腿也会收到 → 两腿并存，靠 external_id 去重 |
| 510210涨跌±1%邮箱提醒 | 4db04a052b41 | 方向进 external_id |
| 三因子离场信号邮箱推送 | 071f9e5c5a15 | |
| 510210止损+冷却期尾盘提醒 | 2a607e413ca9 | |
| 588170急跌信号提醒 | 5420c444b523 | 目前 local |
| 600259关键价提醒 | 81e7b813643b | 目前 local |
| 模拟盘早间选股推送 | 9955cb4251f4 | 目前 local |

> 暂不会改：`*/2` 的 4 个高频轮询任务（多标实时监控、模拟盘持仓监控等）—— 每 2 分钟一次，全量接会一天几百条，把消息区淹没。

### 5.2 邮件同步 `sync_inbox_email.py`（cron，15 分钟）

- 凭据取法复刻 MCP `read_emails`：从 MySQL `email_accounts` 读 `xd6022@163.com` 的 IMAP 配置。
- **只收自己发件箱来的通知邮件**（发件人 `xd602201@163.com`）→ 现有 6~7 个 `deliver=email` 的任务（早盘简报、日报、周报、记忆整理、各类触发提醒）**零改动自动进消息区**。
- 去重按 `Message-ID`；等级：标题含触发/提醒/建议/止损/止盈 → `warn`，其余 `info`。

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
| 时间 | 本机时区是 **UTC** ⇒ 脚本写 `occurred_at` 必须显式转 `Asia/Shanghai`；前端显示用浏览器时区；交易时段判定不在服务端做 |
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
