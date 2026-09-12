# A 方案：发送链路迁移到 `/v1/runs`（计划书 + 状态看板）

- **立档**：2026-09-12 11:10 CST（Asia/Shanghai）
- **分支**：`feat/runs-transport`（main 不动）
- **状态**：🟢 进行中 —— 见 §5 阶段看板
- **改的是谁**：本项目 `hermes-chat-lite`。**Hermes 源码一行不动**（`/v1/runs` 是它自带能力，我们只是没用它）

## 0. 一句话

把网页端"发消息"从 `POST /api/sessions/{id}/chat/stream` 换成 `POST /v1/runs` + `GET /v1/runs/{id}/events`，
第一次让网页端具备"批准/拒绝危险操作"的能力，顺带拿到"中断"和"引导正在跑的一轮"。

## 1. 为什么（实测证据，非文档推断）

审批接线只存在于 `_handle_runs`（`api_server.py:6682`）：`register_gateway_notify` / `_run_approval_sessions` / `approval.request` 事件；
`_create_agent`（:6388 / :6835）零接线 → 走 `chat/stream` 时撞上审批只能 fail-closed（"BLOCKED: Failed to send approval request"）。

探针 `/opt/data/.verify/probe_runs.mjs` 实测（2026-09-12 11:09 CST）：

| 观测 | 结果 |
|---|---|
| `POST /v1/runs` | **202 + run_id**（异步提交） |
| 事件序列 | `message.delta` → `reasoning.available` → `run.completed`；带工具的一轮：`tool.started` → `tool.completed` → `message.delta` → `run.completed` |
| 逐字流式 | **在**（首字节 3.6s；另一个含工具调用的轮次 22.5s） |
| `run.completed` 载荷 | `{output, usage}` —— **没有 `messages` 字段**（`_turn_transcript_messages` 只被 :3991/:4027 的 chat/stream 路径使用） |
| 同 `session_id` 连续两轮 | 第二轮答得出第一轮内容 → **历史连续性 ✅** |
| `GET /api/sessions/{id}/messages` | 能读到 run 写的消息（6 条，含 `role=tool`）→ **现有历史/分页代码不用改** |
| `GET /v1/runs/{run_id}` | 200 `{status, session_id, model, last_event}` |
| `GET /v1/runs/{run_id}/events` 消费后再连 | **404**（流一次性、不可重放） |
| 服务端 30s 心跳 | 会发 SSE 注释行 `: keepalive` / 结束发 `: stream closed` |

## 2. 事件映射表（迁移的全部差异都在这）

| chat/stream（现状） | /v1/runs（新） | 处理 |
|---|---|---|
| 一个请求内完成"提交 + 流" | `POST /v1/runs`(202) → `GET /v1/runs/{id}/events` | 拆两步；服务端有 20×50ms 等待窗口兜底竞态 |
| `assistant.delta` | `message.delta` | 改名映射 |
| `assistant.completed` | `run.completed.output` | 终稿来源换成它 |
| `run.completed.messages` | ❌ 不存在 | **轮末补读会话消息对账** |
| `tool.progress`/`tool.started`/`tool.completed`/`tool.failed` | 已确认 `tool.started`/`tool.completed`，其余待实测 | 防御式：遇到就渲染，未知事件忽略并计数 |
| `_thinking` 伪工具 | `reasoning.available` | 新接 |
| 中断 = 直接断连接 | `POST /v1/runs/{id}/stop` | 新接 |
| （无） | `approval.request` → `POST /v1/runs/{id}/approval` `{choice: once\|session\|always\|deny}`（另有 `all`/`resolve_all`） | **本次核心** |
| （无） | `run.cancelled` / `run.failed` / `run.steered` | 新接 |
| （无） | `GET /v1/runs/{id}` | 用于"流丢了但想知道终态" |

## 3. 明确不做

- 不动 Hermes 源码（`/opt/hermes` 我也改不动，root 所有）
- 不改渲染层：`MessageItem` / `ChatWindow` / `InputBox` / `Sidebar` / 主题 / 分页 / 改名删除
- 不引新依赖、不引 Pinia、不加 `/xxx` 斜杠命令（用户暂缓）
- 不改统计口径（仍是"会话记录做差 + `usage`"）

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 动的是**核心发送链路** | 一行开关 `SEND_TRANSPORT = 'runs' \| 'stream'` 随时回退；分支开发，main 不动；全绿才推 |
| 事件流**不可重连**（断开后 404） | 断线/异常 → 立即 `GET /api/sessions/{id}/messages` 回读对账补上缺失段落，界面标注"已回读" |
| `run.completed` 没有权威 transcript | 轮末补读会话消息对账（比 SSE 拼的更权威，顺带修掉"中间助理段落丢失"的老问题） |
| 审批卡片字段未经真实载荷验证 | 防御式渲染（字段缺失不崩）；实施期尝试触发一次真审批，做不到就明确写"未实测"并留真机验收项 |
| 长轮次期间的 keepalive 注释行 | 解析器忽略 `:` 开头的注释行（已确认服务端会发） |
| 未知事件涌入 | 忽略 + 计数，不崩 |
| 并发/限流 | 服务端有 `max_concurrent_runs`，撞上会返回限流错误 → 界面原样提示 |

## 5. 阶段看板

| 阶段 | 内容 | 状态 |
|---|---|---|
| S0 | 实测 `/v1/runs` 可行性、事件映射、风险清单 | ✅ 完成（2026-09-12 11:10） |
| S1 | `src/api/runs.ts`：`submitRun` / `runEvents` / `stopRun` / `approveRun` / `getRun` / `steerRun` + `sse.ts` 抽出 `consumeSse`/`getSse` | ✅ 完成 |
| S2 | `src/stores/chat.ts`：`sendTransport()`/`setSendTransport()` 双通道 + 共用事件归约器 `applyEvent()` + 轮末对账 `reconcileTurn()` | ✅ 完成 |
| S3 | `RunStatus.vue`：审批卡片（4 个选项 + 等审批状态 + 已回话/失败提示）+ `recovered` 回读标注 | ✅ 完成 |
| S4 | 用例：`runs-transport.spec.ts`(16) + `RunStatus.spec.ts`(8) → **122/122 全过** | ✅ 完成 |
| S5 | 真实链路 e2e（普通轮/工具轮/中断/历史/清理）→ **常驻** `npm run e2e`，5 项全绿 | ✅ 完成 |
| S6 | 审批真实链路验证 | 🟡 **部分**：接口契约实测通过（400/404/409）；**真审批事件在本环境触发不了**（smart approval 自动放行，历史 0 次），卡片改由 8 条组件用例锁住，真机验收项写进 README 自检第 7 条 |
| S7 | 文档（§5.11 + §10.2 + 坑 38~42）+ README + skill + 推送 feat 分支 | ✅ 完成 |

更新纪律：每完成一个阶段就地改这张表，并在文末追加一行证据（时间 + 命令 + 结论）。

## 6. 验收清单（做完才算完）

- [ ] 普通聊天逐字出现，与旧通道肉眼无差别
- [ ] 工具时间线照常显示；统计页脚三项照常
- [ ] 既有 98 个用例全绿 + 新用例覆盖新链路
- [ ] 历史/分页/压缩摘要折叠/改名/删除/主题全部回归通过
- [ ] 中断按钮真的停住这一轮，界面状态正确
- [ ] 审批卡片能出现并批准/拒绝（以真机点一次为准）
- [ ] 断线后界面能自动回读补齐
- [ ] 回退开关生效：切回 `'stream'` 后行为与今天完全一致（不是"应该一致"，是跑一遍比对）

## 7. 回退

- 代码：把 `SEND_TRANSPORT` 切回 `'stream'`，或 `git revert` 该分支的提交
- 部署：重建容器回到旧产物（main 未动，旧产物随时可取）

## 8. 证据流水（追加式）

- 2026-09-12 11:09 CST · `node /opt/data/.verify/probe_runs.mjs` · `/v1/runs` 逐字流式在、同 session_id 历史连续、`/api/sessions/{id}/messages` 可读 run 消息、events 流不可重放
- 2026-09-12 11:40 CST · `node /opt/data/.verify/probe_runs_tail.mjs` · 原样打印流尾：`data: {...}\n\n` + `: stream closed\n\n`，**没有 `event:` 行** → 坑 38 的直接证据
- 2026-09-12 11:45 CST · `node /opt/data/.verify/probe_approval_contract.mjs` · 400 `invalid_approval_choice` / 404 `run_not_found` / 409 `approval_not_pending`
- 2026-09-12 11:47 CST · `node /opt/data/.verify/probe_approval_live.mjs` · **未能触发真审批**：让 agent 执行 `rm -rf /tmp/<不存在路径>` 被 smart approval 自动放行（`rm -rf` 也没弹），事件序列 `tool.started → tool.completed → message.delta ×2 → reasoning.available → run.completed`
- 2026-09-12 12:0x CST · `npm test` **122/122**；`npx vue-tsc --noEmit` 0 错误；`npm run build` 产物 297KB / gzip 114KB
- 2026-09-12 12:0x CST · `npm run e2e` **5 项全绿**（① 普通轮 `recovered=false`、统计 27,449 in / 缓存 96.99%；② 工具轮时间线 `[terminal]`；③ 中断 → 服务端 `cancelled`、界面 `aborted`；④ 历史 7→5 条；⑤ 删除后 404）

### 真链路抓到的问题（这些单测抓不到）

1. **`/v1/runs` 的 SSE 帧没有 `event:` 行** → 事件名在 JSON 的 `event` 字段里；照旧通道写法解析 → 全部事件被当未知事件忽略（症状：无逐字输出、无时间线，只有轮末对账补回来的正文）
2. **`run.cancelled` 被判成"完成"** → 需另立 `cancelled` 标记，且中断不产出本轮统计
3. **工具事件字段是 `tool`，不是 `tool_name`**（`tool.completed` 另带 `duration`/`error`；没有 `tool.failed`）
4. （工具链）jsdom 的 `AbortSignal` 不是 Node 的实例，透传真 `fetch` 会报 `Expected signal to be an instance of AbortSignal`；`vitest` 配置里的 `root` 相对路径按 CWD 解析，必须写绝对路径
