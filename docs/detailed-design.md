# Hermes Chat Lite —— 详细设计（可直接照着开发）

> 配套文档：`docs/feasibility-analysis.md`（可行性 / 风险 / 暴露面决策）
> 目标版本：v1.0（第一版验收标准见文末）
> 接口契约最后核验：2026-09-11（本机 hermes:8642 实测）

---

## 0. 状态看板

> 跨会话续接用：接手的会话先读本表，再读对应阶段章节。

| 阶段 | 状态 | 交付物 | 验收方式 |
| --- | --- | --- | --- |
| P0 工程搭建 | ⬜ 未开始 | `package.json` `vite.config.ts` `tailwind.config.js` `src/api/hermes.ts` | `npm run dev` 起得来，`getSessions()` 在控制台打印真实会话 |
| P1 只读链路 | ⬜ 未开始 | `Sidebar.vue` `ChatWindow.vue` `MessageItem.vue` | 左侧出现真实会话，点击能渲染历史消息与代码高亮 |
| P2 写链路 | ⬜ 未开始 | `InputBox.vue` + 新建会话 | Enter 发送，消息立刻上屏，Shift+Enter 换行 |
| P3 流式 | ⬜ 未开始 | `src/api/sse.ts` `RunStatus.vue` + 流式渲染 | 回复逐字出现；**工具执行可见 + 明确完成态**（见 5.6） |
| P4 部署 | ⬜ 未开始 | `Dockerfile` `nginx.conf` `docker-compose.yml` `README.md` | 浏览器打开域名即可聊天 |
| P5 安全加固（可选） | ⬜ 未开始 | Caddy basic_auth | 未带口令访问返回 401 |

图例：⬜ 未开始 / 🟡 进行中 / ✅ 完成 / ❌ 阻塞

---

## 1. 项目结构

```
hermes-chat-lite/
├── docs/
│   ├── feasibility-analysis.md
│   └── detailed-design.md
├── src/
│   ├── api/
│   │   ├── hermes.ts          # 唯一允许发请求的地方（组件禁止 fetch）
│   │   ├── sse.ts             # POST-SSE 解析器（fetch + ReadableStream）
│   │   └── types.ts           # 与 Hermes 返回一一对应的 TS 类型
│   ├── stores/
│   │   └── chat.ts            # 轻量响应式单例（不引 Pinia）
│   ├── components/
│   │   ├── Sidebar.vue
│   │   ├── ChatWindow.vue
│   │   ├── MessageItem.vue
│   │   ├── RunStatus.vue      # 执行状态条 + 工具时间线（见 5.6，用户明确痛点）
│   │   └── InputBox.vue
│   ├── lib/
│   │   ├── markdown.ts        # markdown-it + highlight.js 实例
│   │   └── format.ts          # 时间/日期分组
│   ├── App.vue
│   ├── main.ts
│   └── style.css
├── Dockerfile
├── nginx.conf
├── docker-compose.yml
├── vite.config.ts
├── tailwind.config.js
└── README.md
```

依赖（严格限定，不引 UI 框架 / 不引状态库 / 不引 axios）：

```
vue@^3.5  typescript  vite  @vitejs/plugin-vue
tailwindcss  postcss  autoprefixer
markdown-it  @types/markdown-it  highlight.js
```

---

## 2. API 契约（实测确认，开发时按此写）

Base：生产环境走同源 `/api`、`/v1`（由 nginx 反代到 `hermes:8642`，**不配置 base URL**，避免 CORS）。开发环境用 Vite proxy 指向 `http://127.0.0.1:8642` 或任意可达地址，并注入 key。

鉴权：`Authorization: Bearer <key>`，**由 nginx 注入，前端代码里不出现 key**。

### 2.0 端点选型决策（重要，直接决定"能不能看到工具执行"）

**只使用 Hermes 原生会话端点，不使用 OpenAI 兼容的 `/v1/chat/completions`。**

原因（与 Open WebUI 的对比）：`/v1/chat/completions` 是 OpenAI 协议，Hermes 在里面**确实**发出了工具进度，但只能塞进一个自定义事件名：

```
event: hermes.tool.progress      ← 非标准事件名
data: {...}
```

Open WebUI 这类 OpenAI 兼容客户端只解析标准 `data: {"choices":[{"delta":...}]}` 帧，**遇到不认识的 `event:` 名直接丢弃**。结果就是：agent 正在跑工具、助手正文长时间为空 → 界面一片空白，用户无法判断请求到底在跑、还是已经挂了。这是"看不到 tool 执行"的根因。

而 `/api/sessions/{id}/chat/stream` 是 Hermes 原生协议，把整轮生命周期作为**一等事件**发出来（`run.started` / `tool.started` / `tool.completed` / `assistant.completed` / `run.completed` / `done`），所以本项目能真正做到"看得见执行、看得见结束"。

**结论：本项目选原生端点，不选 OpenAI 兼容端点。** 这是本设计相对 Open WebUI 的核心改进点。

### 2.1 类型定义（`src/api/types.ts`）

```ts
// GET /api/sessions 返回的 data[] 元素（字段为 Hermes 的 _session_response 白名单）
export interface HermesSession {
  id: string
  source: string                 // 'tui' | 'api_server' | 'telegram' ...
  model: string | null
  title: string | null
  started_at: number             // Unix 秒（float）
  ended_at: number | null
  end_reason: string | null      // 'branched' | 'ws_orphan_reap' | null ...
  last_active: number            // Unix 秒，列表按此倒序
  message_count: number
  preview: string | null         // 首条消息摘要，列表副标题用
  parent_session_id: string | null
  pinned: boolean
  archived: boolean
  hidden: boolean
  // 其余字段（token/cost 统计）v1 不展示
}

export interface HermesMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | Array<{ type: string; text?: string }> | null
  tool_calls: unknown[] | null
  tool_name: string | null
  timestamp: number              // Unix 秒
  finish_reason: string | null
  reasoning?: string | null
}
```

### 2.2 端点清单

| # | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 1 | GET | `/api/sessions?limit=50&offset=0` | 会话列表 |
| 2 | POST | `/api/sessions` | 新建空会话 |
| 3 | GET | `/api/sessions/{id}/messages?order=latest&limit=100` | 历史消息 |
| 4 | POST | `/api/sessions/{id}/chat/stream` | 发送 + 流式回复 |
| 5 | GET | `/health` | 连接状态指示（Settings 面板用） |

**1. 会话列表** 响应：

```json
{ "object": "list",
  "data": [ { "id": "20260911_183957_70912c", "source": "tui", "model": "deepseek-flash",
              "title": "开发 Hermes Chat Lite 轻量前端", "last_active": 1789123310.09,
              "message_count": 31, "preview": "/** * ====...", "pinned": false, "archived": false, "hidden": false } ],
  "limit": 50, "offset": 0, "has_more": true }
```

- 默认 `limit=50`（服务端上限 200）。第一版固定 50，不做分页加载（侧栏只显示最近 50 条足够）。
- 客户端过滤：`hidden === true` 或 `archived === true` 的不显示。
- 按 `last_active` 分组为 **今天 / 昨天 / 更早**。

**2. 新建会话** 请求 `{}`（**不要传 title**，避免唯一约束 400）→ 201：

```json
{ "object": "hermes.session",
  "session": { "id": "api_1789123400_a1b2c3d4", "source": "api_server", "title": null, ... } }
```

- 取 `session.id` 作为当前会话 id。首轮结束后 Hermes 会自动生成标题，届时刷新侧栏即可看到。

**3. 历史消息** 响应：

```json
{ "object": "list", "session_id": "20260911_183957_70912c",
  "data": [ { "id": 25180, "role": "assistant", "content": "", "tool_calls": [ ... ],
              "tool_name": null, "timestamp": 1789123327.23, "finish_reason": "tool_calls" },
            { "id": 25181, "role": "tool", "content": "{\"bytes_written\":784}", "tool_name": "write_file" } ],
  "pagination": { "limit": 100, "offset": 0, "order": "latest", "returned": 100 } }
```

- `order=latest` 时返回的是**最近的 N 条（仍按时间正序排列）**，符合聊天窗口"先看最后一段"的需求。
- `pagination.returned === limit` 说明上面还有更早的消息 → 滚动到顶部时用 `offset += limit` 再取（`order=oldest` 语义不同，第一版统一用 `order=latest` + offset 翻页，或简化为只加载最近 100 条并在顶部显示「仅显示最近 100 条」）。

> **v1 简化决策**：只加载最近 100 条，顶部显示提示条。翻页列为 v1.1。

**4. 发送（流式）** 请求：

```http
POST /api/sessions/{id}/chat/stream
Content-Type: application/json

{ "message": "帮我看看 510210 现在的盘面" }
```

字段名 `message` 或 `input` 都可以（服务端 `body.message or body.input`）。
**不要传 `model` / `provider`**（v1 不做模型切换，走 Hermes 默认模型）。

### 2.3 SSE 事件契约（开发按此写解析器）

帧格式：`event: <name>\n` + `data: <json>\n\n`，UTF-8 原文（中文不转义）。
另有每 30 秒的保活注释行：`: keepalive\n\n`（解析时忽略）。

| event | 时机 | 关键字段 | 前端动作 |
| --- | --- | --- | --- |
| `run.started` | 轮次开始 | `user_message`, `runtime` | 确认发送，可显示"连接中" |
| `message.started` | 助手消息开始 | `message.id` | 创建空的助手占位气泡 |
| `assistant.delta` | **逐字** | `delta`（增量文本） | 追加到当前助手消息 → 实时渲染 |
| `tool.progress` | 思考中/工具中 | `tool_name`, `delta` | 显示 `正在使用 write_file…` 灰字状态 |
| `tool.started` | 工具开始 | `tool_name`, `preview`, `args` | 同上（可折叠） |
| `tool.completed` | 工具完成 | `tool_name`, `preview` | 更新状态 |
| `tool.failed` | 工具失败 | `tool_name` | 状态标红，继续等待 |
| `assistant.completed` | 本轮正文结束 | `content`（**完整全文**） | 用它**覆盖**流式拼接结果，纠正分片误差 |
| `run.completed` | 轮次结束 | `messages`（整轮 transcript）, `usage`, `session_id` | 结束 loading，刷新侧栏标题；**不要渲染 `messages`**（会与正文重复） |
| `error` | 出错 | `message` | 气泡内显示红色错误 |
| `done` | 流关闭 | — | 收尾（`finally` 兜底） |

所有事件都带 `session_id` / `run_id` / `seq` / `ts`。

**事件载荷的实际精度（实测确认，别期待过高）：**

| 事件 | 实际带什么 | 不带什么 |
| --- | --- | --- |
| `tool.started` | `tool_name` + `preview`（可读摘要）+ `args`（**已做过显示脱敏的**参数） | 参数全文 |
| `tool.completed` | **只有 `tool_name`**（服务端按 `(name, None, None)` 发出） | 执行结果 / 耗时 / 成功与否 |
| `tool.progress` | `tool_name` + `delta`；模型思考时 `tool_name === "_thinking"`，`delta` 是思考首行 | 完整思考内容 |
| `run.completed` | `messages`（整轮 transcript，**含工具结果**）+ `usage` | — |

→ 想要"工具执行结果"（如 `write_file ✓ 784 bytes`），只能在 `run.completed` 到达后从 `messages` 里回填时间线，**但不要把 `messages` 渲染成聊天消息**。

---

## 3. api 层设计

### 3.1 `src/api/hermes.ts`（组件禁止直接 fetch）

```ts
const BASE = ''            // 空字符串 = 同源；开发环境由 vite proxy 兜住

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new HermesApiError(res.status, await readErrorMessage(res))
  return res.json() as Promise<T>
}

export function getSessions(limit = 50): Promise<SessionListResponse>
export function createSession(): Promise<{ object: string; session: HermesSession }>
export function getMessages(sessionId: string, limit = 100): Promise<MessageListResponse>
export function health(): Promise<{ status: string; version?: string }>
export function streamChat(              // 见 3.2
  sessionId: string, message: string,
  handlers: SseHandlers, signal?: AbortSignal,
): Promise<void>
```

错误处理约定：把后端 `{ error: { message, code } }` 提取为可读文案；`401` → "访问口令/接口密钥无效"；`404` → "会话不存在（可能已被删除）"；`409` → "会话已存在，请新建"。

### 3.2 `src/api/sse.ts` —— POST + SSE 解析（本项目的核心难点，约 120 行）

`EventSource` 只能 GET，所以必须手写：`fetch` + `ReadableStream` + `TextDecoder`。

关键实现要点：

```ts
export async function postSse(
  url: string, body: unknown, onEvent: (name: string, data: any) => void, signal?: AbortSignal,
) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  })
  if (!res.ok || !res.body) throw new Error(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // 帧以空行分隔；\r\n\r\n 也要兼容（nginx 一般不改，但保险）
    const frames = buf.split(/\r?\n\r?\n/)
    buf = frames.pop() ?? ''               // 最后一段可能是半帧，留到下一轮
    for (const frame of frames) {
      if (!frame || frame.startsWith(':')) continue      // 跳过 keepalive 注释
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (!dataLines.length) continue
      try { onEvent(event, JSON.parse(dataLines.join('\n'))) } catch { /* 半帧 JSON，忽略 */ }
    }
  }
}
```

必须遵守的 4 条：
1. `decoder.decode(value, { stream: true })` —— 否则中文多字节字符被切断会乱码。
2. 按空行切帧、**最后一段留回缓冲区** —— 否则 JSON 被截断。
3. 跳过 `:` 开头的注释帧（服务端 30s 一次 keepalive）。
4. `data:` 后只 trimStart，不要 trim 掉正文里的换行（多行 data 用 `\n` 拼回）。

### 3.3 `nginx.conf` 的关键点

- `/api/` 与 `/v1/` 反代到 `http://hermes:8642`，并 `proxy_set_header Authorization "Bearer <key>"`；
- **`proxy_buffering off;`（必须）** —— 否则 nginx 会缓冲整个 SSE 响应，流式变一次性；
- `proxy_read_timeout 3600s;`（agent 单轮可能跑很久）；
- `proxy_http_version 1.1;` + `Connection ""`；
- `X-Accel-Buffering: no` 服务端已带，双重保险；
- `gzip off;`（对 SSE 无用且可能引入缓冲）；
- 静态资源：`try_files $uri $uri/ /index.html;`（Vue history 模式）。

key 通过环境变量注入：镜像里给 nginx 用 `envsubst` 模板，或用 `docker compose` 的 `env_file` 生成。**key 只存在于宿主机 .env 与容器环境变量中**。

---

## 4. 状态层（`src/stores/chat.ts`）

不引入 Pinia，用 `reactive` 单例（约 80 行）：

```ts
export const store = reactive({
  sessions: [] as HermesSession[],     // 侧栏
  currentId: null as string | null,    // 当前会话
  messages: [] as UiMessage[],         // 当前会话已渲染消息
  streaming: false,                    // 生成中（控制输入框禁用 + 停止按钮）
  error: null as string | null,
  run: {                               // 本轮执行状态（RunStatus.vue 用，见 5.6）
    phase: 'idle' as 'idle'|'thinking'|'tool'|'writing'|'done'|'aborted'|'error',
    startedAt: 0,                      // performance.now()
    endedAt: 0,
    currentTool: null as string | null,
    toolPreview: null as string | null,
    timeline: [] as { name: string; preview?: string; status: 'run'|'ok' }[],
    errorMessage: null as string | null,
  },
})

export interface UiMessage {
  key: string                 // 本地 key（服务端 id 或 temp-uuid）
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean         // 逐字渲染中 → 显示光标动画
  toolStatus?: string | null  // "正在使用 write_file…"
  error?: string | null
}
```

关键动作：

| 动作 | 行为 |
| --- | --- |
| `loadSessions()` | 调 `getSessions()`，过滤 hidden/archived，按 last_active 倒序 |
| `openSession(id)` | 设置 currentId → 清空 messages → `getMessages()` → `normalize()` → 渲染 |
| `newChat()` | `createSession()` 拿 id → currentId=id，messages=[]（**不发消息就不落库**） |
| `send(text)` | ① 乐观插入 user 气泡 ② 插入空 assistant 气泡 ③ `streamChat()` ④ 事件驱动更新 ⑤ finally 刷新侧栏 |
| `stop()` | `AbortController.abort()`；服务端会因断连打断本轮 |

`normalize(raw: HermesMessage[]): UiMessage[]` 过滤规则（**必须实现**）：
1. 丢掉 `role` 不是 user/assistant 的（tool / system）；跳过压缩摘要消息。
2. assistant 且 `content` 为空 → 丢弃（工具调用轮）。
3. `content` 是数组 → 取 `type === 'text'` 的 `text` 拼接。
4. 按 `timestamp` 正序。

---

## 5. 组件设计

### 5.1 `App.vue`（布局骨架）

三段式：顶部栏（`Hermes` + 连接状态点 + Settings 按钮）/ 主体（Sidebar 240px + ChatWindow 自适应）/ 输入区在 ChatWindow 内部底部。

- 桌面：侧栏常驻。
- 移动端（`< 768px`）：侧栏抽屉式，左上角汉堡按钮开关，默认收起（沿用您一贯的移动端偏好）。

### 5.2 `Sidebar.vue`

- 顶部「New Chat」按钮（主色，全宽）。
- 分组渲染：`今天` / `昨天` / `更早`（依据 `last_active`，用 `Intl.DateTimeFormat` 判定自然日差）。
- 单条：主行 title（空则显示 `preview` 前 30 字，再空则显示 `未命名会话`），副行不显示（保持简洁）；悬浮时右侧出现小字时间。
- 当前会话高亮（浅灰底）。
- 空态：`还没有会话，开始新的对话吧`。
- 加载态：骨架屏 3 行（不要 spinner 全屏遮罩）。

分组计算放在 `lib/format.ts`，用同一个函数产出 `{label, items}[]`。

### 5.3 `ChatWindow.vue`

- 消息列表容器：`max-width: 768px; margin: 0 auto;`（需求指定）。
- **不使用气泡**：用户消息 = 右侧淡灰圆角块（仅用户侧），助手 = 纯文本流（贴近 ChatGPT）。
  - 折中说明：需求 6.2 说"不使用聊天气泡"，指的是助手侧不要大框；用户消息保留淡背景块以区分角色，若您希望更彻底可全文本流 + 角色小标题，实现上是个开关。
- 自动滚动：仅当用户已在底部附近时才自动跟随（避免用户翻历史时被强行拽回）。
- 空会话态：居中显示 `有什么可以帮您？` + 3 条示例（点击填入输入框，不自动发送）。
- 底部：`InputBox`，上方一条 1px 分割线。

### 5.4 `MessageItem.vue`

- **助手消息**：
  - 流式中：渲染已到达文本 + 末尾闪烁光标（`▍`，CSS 动画），`toolStatus` 以灰字小行显示在正文上方。
  - 完成后：整段 markdown 渲染。
- **用户消息**：纯文本（`white-space: pre-wrap`），不解析 markdown（避免误触发代码高亮），保留换行。
- 代码块：`<pre><code class="hljs language-x">`，右上角"复制"按钮（`navigator.clipboard`），等宽字体。
- markdown-it 配置：`linkify: true, breaks: true, html: false`（**html:false 是安全项**，防止 agent 输出里的原始 HTML 注入）。代码高亮用 `highlight.js` 在 `highlight` 回调里调用，失败则 fallback 为转义纯文本。
- 性能：流式期间对同一气泡做**节流重渲染**（`requestAnimationFrame` 每帧最多一次 `v-html` 更新），长回复不会掉帧。

### 5.5 `InputBox.vue`

- `textarea` 高度自适应（1～8 行，`scrollHeight` 计算）。
- Enter 发送、Shift+Enter 换行；**中文输入法合成期间（`isComposing`）不触发发送**（必须处理，否则拼音回车会误发）。
- 生成中：发送按钮变「停止」（方形图标），点击 `stop()`；输入框禁用。
- 右下角小字：`Hermes 可能会出错，请核对重要信息`（可选，一句话即可）。

### 5.6 `RunStatus.vue` —— 执行可观测性（针对 Open WebUI 的核心痛点）

目标：任何时候用户都能回答两个问题——**"现在在干什么？"** 和 **"这轮到底结束了没有？"**

**状态条**（位于输入框上方，固定一行高，不占布局）：

| 阶段 | 显示 |
| --- | --- |
| 等待首字 | `⏳ 正在思考… 3.2s`（`message.started` 后启动计时器） |
| 模型思考 | `💭 正在思考… 5.1s`（`tool.progress` 且 `tool_name === "_thinking"`，可显示 `delta` 首行） |
| 工具执行 | `🔧 正在使用 write_file… 6.4s`（`tool.started`，`preview` 作 tooltip） |
| 工具完成 | `✓ write_file 完成 · 下一个…`（仅更新文本，不新增行） |
| 正文生成 | `✍️ 正在输出… 12.0s`（收到 `assistant.delta` 后切换，计时器继续走） |
| 本轮结束 | `✓ 完成 · 12.3s · 5 个工具调用`，**常驻显示在最后一条消息下方**（下次发送时才消失） |
| 异常结束 | `⚠️ 回复中断（未收到 run.completed）` 或 `✗ 出错：<message>` |

**完成态判定（必须显式，不能靠"没动静了"猜）：**

| 情况 | 判定 |
| --- | --- |
| 收到 `run.completed` | ✅ 完成 |
| 收到 `done` 但没收到 `run.completed` | ⚠️ 中断 |
| 收到 `error` | ❌ 失败，显示 `message` |
| 流关闭（`reader.read()` done）且以上都没有 | ⚠️ 中断 |
| 超过 5 分钟无任何事件 | ⚠️ 超时提示（**不自动中断请求**，可能确实在跑长命令） |

**工具时间线**（可折叠，默认收起）：本轮所有 `tool.started`/`tool.completed` 按序记录，展开后是一行一个工具的流水（`5. write_file · /opt/data/x.py`）。`run.completed` 到达后，若需要结果，从 `messages` 里按 `tool_call_id` 回填状态✓/✗。这是"看清楚这轮干了什么"的地方，也是 Open WebUI 完全缺失的部分。

**注意**：计时器用 `performance.now()` 本地算，不要依赖事件里的 `ts`（时钟/网络抖动会让它跳变）。

### 5.7 Settings（最小化，不做模型切换）

点顶部「Settings」右侧滑出小面板，只有三项：
1. 连接状态：绿点 + `Hermes v0.20.4`（数据来自 `GET /health`）+ 刷新按钮。
2. 主题：浅色 / 深色 / 跟随系统（Tailwind `dark` class 切换，存 `localStorage`）。
3. 关于：版本号、一组快捷键说明。

**明确不做**：模型切换、Prompt 管理、Agent 配置（需求第七条禁止项）。

---

## 6. UI 规范

| 项 | 值 |
| --- | --- |
| 消息区最大宽度 | `768px`，水平居中 |
| 字体 | 正文 15px / 行高 1.75（中文可读性）；代码 13px mono |
| 主色 | 深灰近黑（`#111827`）配白底；暗色模式 `#0f1115` 底 |
| 圆角 | 卡片 12px，输入框 16px |
| 间距 | 消息之间 24px，段落之间 12px |
| 侧栏 | 240px / 底 `#f9fafb`，与主体 1px 分隔线 |
| 输入区 | 固定底部，随内容增长；最大高度 40vh |
| 移动端 | 侧栏抽屉；输入框字号 ≥16px（防 iOS 自动缩放） |

---

## 7. 错误与边界处理

| 场景 | 表现 |
| --- | --- |
| 启动时 `/health` 失败 | 顶栏红点 + `无法连接 Hermes`，侧栏显示重试按钮 |
| 会话列表为空 | 空态文案，引导新建 |
| 历史消息 404（会话被删） | 提示"该会话已不存在"，自动回到空会话态 |
| 流中断（网络/切后台） | 已渲染内容保留，标灰提示"回复中断"；刷新可看到落库部分 |
| 服务端 `error` 事件 | 助手气泡内红色错误文本，输入框恢复可用 |
| 连续点击发送 | 按钮在 `streaming === true` 时禁用（防重复 turn） |
| 页面刷新 mid-stream | 服务端会打断本轮（已知限制，写入 README） |
| 流结束但没收到 `run.completed` | 标"回复中断"，不做静默处理（见 5.6 完成态判定） |

---

## 8. 部署

### 8.1 Dockerfile（多阶段）

阶段 1：`node:22-alpine` 装依赖 + `npm run build` → `dist/`
阶段 2：`nginx:alpine`，COPY `dist` 到 `/usr/share/nginx/html`，COPY `nginx.conf`，用 `envsubst` 注入 `HERMES_API_SERVER_KEY`（key 不进镜像层，运行时注入）。

镜像源走腾讯云 npm registry（`registry.npmmirror.com` 或 `mirrors.cloud.tencent.com/npm/`）与 NJU docker 镜像，避免国内超时。

### 8.2 docker-compose.yml 要点

```yaml
services:
  chatlite:
    build: .
    container_name: chatlite
    restart: unless-stopped
    environment:
      - HERMES_API_SERVER_KEY=${HERMES_API_SERVER_KEY}
    expose: ["80"]                 # 不映射宿主机端口
    networks: [net_openclaw]
networks:
  net_openclaw: { external: true }
```

按您既有约定：接入 `net_openclaw`，不配 `ports`，显式 `expose` 声明内部端口；Caddy 反代 `chatlite:80`。

### 8.3 Caddy（宿主机，用户执行）

```caddyfile
chat.<域名> {
    basic_auth {
        <用户名> <bcrypt 哈希>
    }
    reverse_proxy chatlite:80
}
```

Caddy 需处理 SSE：默认 `flush_interval -1` 对流式响应是安全的；若发现缓冲，显式加 `reverse_proxy chatlite:80 { flush_interval -1 }`。

---

## 9. 实施计划（按序执行，每阶段可独立验证）

**P0 工程搭建**
1. `npm create vite@latest hermes-chat-lite -- --template vue-ts`
2. 装依赖：`tailwindcss postcss autoprefixer markdown-it highlight.js @types/markdown-it`
3. `vite.config.ts` 加 dev proxy：`/api`、`/v1` → `http://127.0.0.1:8642`，并注入 `Authorization`（dev 专用，key 从 `.env.local` 读，`.gitignore` 掉）
4. 写 `types.ts` + `hermes.ts` 三个只读函数
5. 验证：控制台 `getSessions()` 打印出真实会话列表

**P1 只读链路**
6. `lib/markdown.ts`（markdown-it + highlight.js）
7. `Sidebar.vue` 列表 + 日期分组；`App.vue` 布局骨架
8. `ChatWindow.vue` + `MessageItem.vue`，`normalize()` 过滤
9. 验证：点会话能看历史消息、代码块高亮、tool 消息不出现

**P2 写链路**
10. `InputBox.vue`（Enter/Shift+Enter/isComposing）
11. `newChat()` + 乐观插入
12. 验证：Enter 发送，用户消息立即上屏，Enter 不再产生空行

**P3 流式**
13. `sse.ts` 解析器（按 3.2 的 4 条要求）
14. `streamChat()` 事件分发 → store 更新 → 逐字渲染 + 光标
15. 工具状态提示、`stop()`、错误事件
16. 验证：回复逐字出现；长回复不掉帧；停止按钮能中断

**P4 部署**
17. `Dockerfile` / `nginx.conf` / `docker-compose.yml` / `README.md`
18. 本地 `npm run build` + `docker build` 通过（构建由用户执行也可）
19. 用户侧：compose 启动 + Caddy 配置 → 浏览器验收

**P5 安全加固**
20. Caddy basic_auth；确认 `curl -I` 无口令返回 401

---

## 10. 验收清单（对应需求第八条）

| # | 验收项 | 验证方式 |
| --- | --- | --- |
| 1 | 浏览器打开即可聊天 | 访问域名，健康检查绿点 |
| 2 | 看到 Hermes 历史 Session | 侧栏出现 tui/gateway 等来源的真实会话 |
| 3 | 点 Session 加载历史消息 | 切换会话内容正确，含中文与代码块 |
| 4 | 输入消息可以发送 | 用户消息上屏，服务端 session 落库 |
| 5 | 回复实时流式显示 | 肉眼逐字出现；`curl -N` 对照事件流 |
| 5b | **工具执行可见 + 完成态明确** | 长任务时能看到"正在使用 X…"，结束后常驻"✓ 完成 · 12.3s · N 个工具调用" |
| 6 | Markdown 正常显示 | 标题/列表/表格/引用 |
| 7 | 代码块高亮 | 多语言代码块有色，复制按钮可用 |
| 8 | Docker 可部署 | `docker compose up -d` 后域名可访问 |

---

## 11. 明确不做（v1 冻结，防范围蔓延）

用户登录 / 权限 / 多用户 / 数据库 / 文件上传 / 图片生成 / 插件市场 / 模型切换 / Prompt 管理 / Agent 配置页 / 会话删除与收藏 / 会话搜索 / 消息重新生成 / 多标签并发流。

（Hermes API 其实支持其中若干项——fork、会话删除、model lock——但为守住"简洁 > 复杂"，v1 一律不做。）

---

## 12. 已知坑（开发时逐条对照）

1. **CORS 默认关闭** → 必须同源反代，不要试图在前端直接跨域打 8642。
2. **key 不能进浏览器产物** → 反代注入 Authorization。
3. **`EventSource` 用不了**（它只支持 GET）→ 必须手写 fetch + ReadableStream 解析。
4. **`proxy_buffering off`** → 忘了它，流式会退化成一次性返回。
5. **TextDecoder 必须 `{stream: true}`** → 忘了它，中文会乱码。
6. **半帧缓冲** → 切帧后最后一段要留回缓冲区。
7. **keepalive 注释帧**（`: keepalive`）→ 解析器要跳过。
8. **`run.completed.messages` 不要渲染** → 会与正文重复；只认 `assistant.completed.content`。
9. **历史消息要过滤 tool / 空 assistant / reasoning** → 否则界面出现大量 JSON 噪音。
10. **新建会话不要传 title** → 重名会被 400 拒绝并回滚。
11. **中文输入法 isComposing** → 未处理会导致拼音回车误发送。
12. **时间戳是 Unix 秒** → 直接 `new Date(ts)` 会得到 1970 年。
13. **刷新页面会打断服务端 turn** → 已知限制，README 里写明。
14. **markdown-it `html:false`** → 防止 agent 输出注入原始 HTML。
15. **`tool.completed` 不带执行结果** → 服务端按 `(name, None, None)` 发出，只有工具名。想要结果得在 `run.completed.messages` 里按 `tool_call_id` 回填；别指望事件里有。**不要因为拿不到结果就退回 OpenAI 端点**（那会连工具名都看不到，正是 Open WebUI 的病）。
16. **`tool.started` 的 `args` 是脱敏后的展示值** → 可以直接显示，但别当作真实参数入库/回传。
17. **`assistant.completed.content` 要覆盖流式拼接结果** → delta 拼接在极端情况下可能丢字/重复，以 completed 的全文为准（覆盖即可，不要追加）。
18. **计时器别用事件里的 `ts`** → 用 `performance.now()` 本地算，否则时间会跳。
19. **完成态必须由事件显式判定** → 见 5.6 的判定表；"界面不再变化"≠"已完成"，这正是 Open WebUI 让您困惑的地方。
