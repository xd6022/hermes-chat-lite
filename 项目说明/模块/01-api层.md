# 模块 01 · api 层（`src/api/`）

> **一句话**：这是全项目**唯一允许发 HTTP 请求**的地方，也是与 Hermes 的契约边界。
> 组件层禁止 `fetch`（`api/hermes.ts` 文件头明确写了这条纪律），因为一旦散开，
> "密钥由反代注入""Origin 必须被剥掉""错误文案要翻成人话"这些约定就会在某个角落被绕过。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `types.ts` | 218 | 与上游返回结构**一一对应**的类型（白名单快照 + SSE 载荷类型 + run 状态类型） |
| `hermes.ts` | 181 | 会话/消息 REST 封装；统一错误翻译；健康检查；模型信息；**旧通道**流式入口 |
| `runs.ts` | 130 | `/v1/runs` 全流程：提交 / 订流 / 查状态 / 审批回话 / 中断 / steer |
| `sse.ts` | 105 | SSE 解析器（POST / GET 通用）—— 本项目的核心技术难点之一 |

依赖方向：`runs.ts → sse.ts + hermes.ts`，`hermes.ts → sse.ts`。**没有任何文件 import store 或组件**（纯叶子层）。

---

## 1. `types.ts` —— 契约快照

- 每段类型都带**实测依据的注释**，例如"字段依据 2026-09-11 实测（`api_server.py` 的
  `_session_response` / `_message_response` 白名单）"。这类注释不是装饰：它让"上游改了字段"这件事
  有一个可以对照的基线。
- 关键类型：
  - `HermesSession`：注意 `input_tokens` / `cache_read_tokens` 等都是**会话累计**（算每轮必须做差）。
  - `HermesMessage`：`content` 可能是 `string` / 多模态数组 / `null`（所以有个 `textOf()` 归一化）；
    `tool_calls[].function.arguments` 是 **JSON 字符串**（不是对象）。
  - `RunStatusResponse.status`：`queued | running | waiting_for_approval | completed | failed | cancelled | interrupted`
    —— **这一行就是终态判定的依据**（`interrupted` 是后来加的，曾经漏接导致界面卡死）。
  - `SseApprovalRequest`：字段**全部可选 + 允许未知字段**（载荷来自工具侧，防御式渲染，缺字段不崩）。
  - `ApprovalChoice = 'once' | 'session' | 'always' | 'deny'`（实测上游还接受 `approve/approved/allow` 别名，
    本项目只传规范值）。

## 2. `hermes.ts` —— REST 封装与错误翻译

对外导出：`getSessions(200)` / `createSession()` / `getMessages()` / `getSession()` / `health()` /
`getModelInfo()` / `renameSession()` / `deleteSession()` / `streamChat()`，以及 `HermesApiError` / `request`。

三个值得学的点：

1. **`friendly(status, message)` 把 HTTP 码翻成"带修法的人话"**：
   - `401` → 「接口密钥无效或未注入（检查反代是否注入 Authorization 头）」
   - `403` → 「请求被 Hermes 的 CORS 防护拒绝（403）：浏览器必带 Origin 头，反代必须清掉它」
   - `404` → 会话不存在（可能已被删除）；`409` → 已存在；`503` → 会话数据库不可用。
   > 这类文案的价值：**错误信息直接指向修法**，把"排查"变成"照做"。
2. **`getSessions(limit = 200)` 取满上限**：不是为了列表完整，而是因为**上游没有搜索端点**，
   客户端搜索只能覆盖"已取到的"集合 —— 少取一条就等于搜不到那一条。
3. **`renameSession` / `deleteSession` 的注释记录了上游硬约束**：标题**唯一**（重名 400，错误里带占用者 id）、
   上限 100 字符；删除是**硬删除、不可恢复、无批量端点**。

⚠️ `streamChat()` 是**旧通道**（`POST /api/sessions/{id}/chat/stream`）的入口，只在回退开关打开时用；
它的上游能力显著弱于 `/v1/runs`（无审批接线、中断=断连接）。保留是因为迁移期需要保险。

## 3. `runs.ts` —— `/v1/runs` 通道

导出的函数一一对应上游能力：`submitRun` / `runEvents` / `getRun` / `approveRun` / `stopRun` / `steerRun`。

文件头写了**与旧通道的四点本质差别**（都是实测得来的，值得背下来）：

| # | 差别 | 客户端后果 |
| --- | --- | --- |
| 1 | **提交与订阅分离**（202 `run_id`，再单独订流；服务端有 20×50ms 等待窗口兜竞态） | 可以先落 localStorage 再订流 |
| 2 | 事件名不同：`message.delta`（不是 `assistant.delta`），终稿在 `run.completed.output` | 归约器要兼容两套名字 |
| 3 | `run.completed` **不带 `messages`** → 权威 transcript 要自己回读会话消息 | 轮末必须 `reconcileTurn()` |
| 4 | 事件流**一次性、不可重放**（消费后再连同一 run_id → 404） | 别设计"重连补事件"，只能查状态 + 回读 |

两处"就地修好上游语义"的实现：

```ts
// ① runRequest()：同一个状态码在两条路上含义不同，文案必须就地纠正
404 → '这个 run 不存在或已结束（事件流是一次性的，不能重连/重放）'
409 → '这个 run 当前没有待处理的审批（可能已过期，或已被别处处理）'
429/503 → '服务端繁忙（并发上限或数据库不可用）：<原文>'

// ② runEvents()：事件名归一化（不修就"整轮没有逐字输出"）
const real = name === 'message' && typeof inner === 'string' ? inner : name
```

## 4. `sse.ts` —— 手写解析器（**本项目最值得单独读的 100 行**）

为什么不用 `EventSource`：**它只支持 GET**，而聊天流是 POST。所以必须
`fetch` + `res.body.getReader()` + `TextDecoder`。四条规则，每条都对应一次真实故障：

| # | 规则 | 漏了会怎样 |
| --- | --- | --- |
| 1 | `decoder.decode(value, { stream: true })` | 中文在多字节分片边界**乱码** |
| 2 | 切帧后最后一段**留回缓冲区** | JSON 被截断、事件丢失（半帧） |
| 3 | 跳过 `:` 开头的注释帧 | 服务端每 30s 发 `: keepalive`，末了发 `: stream closed` |
| 4 | `data:` 后只 `trimStart`，**不要 trim 整行** | 正文里的换行被吃掉 |

其它设计细节：
- `getSse` 与 `postSse` **共用同一个解析器**，好处是 `AbortSignal` 语义与切帧逻辑只有一份；
- 解析失败（半帧/非 JSON）**静默忽略** —— 这是流式场景下的务实选择，代价是"丢帧"不可观测
  （见 `文档/04` B 级观察：`seq` 字段存在但未被利用）。

## 5. 读这一层的正确姿势

1. 先读 `runs.ts` 的文件头（10 行）—— 它把两条通道的差别讲完了，是理解 `chat.ts` 归约器的前提。
2. 再读 `sse.ts` 的四条规则 —— 这四条在别处几乎都会踩一遍。
3. `types.ts` 不用通读，**要用某个字段时回来查**（尤其 `RunStatusResponse.status` 的取值集合）。
4. 想改这一层的东西，先问："这个差异是上游给的，还是我们能抹平的？"
   上游语义差异**就地抹平并写注释**（如 `runRequest` 的文案纠正），能抹平的都别泄漏到上层。
