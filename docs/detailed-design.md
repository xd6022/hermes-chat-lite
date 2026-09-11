# Hermes Chat Lite —— 详细设计（可直接照着开发）

> 配套文档：`docs/feasibility-analysis.md`（可行性 / 风险 / 暴露面决策）
> 目标版本：v1.0（第一版验收标准见文末）
> 接口契约最后核验：2026-09-11（本机 hermes:8642 实测）

---

## 0. 状态看板

> 跨会话续接用：接手的会话先读本表，再读对应阶段章节。

| 阶段 | 状态 | 交付物 | 验收方式 |
| --- | --- | --- | --- |
| P0 工程搭建 | ✅ 完成（2026-09-11 实测） | `package.json` `vite.config.ts` `tailwind.config.js` `src/api/{types,hermes,sse}.ts` | dev server 200；反代注入 key 后 `/api/sessions` 返回 200 + 真实会话 |
| P1 只读链路 | ✅ 完成 | `Sidebar.vue` `ChatWindow.vue` `MessageItem.vue` `lib/*` | 集成用例：侧栏渲染真实标题+日期分组、点会话加载历史且 tool/空 assistant 被滤掉 |
| P2 写链路 | ✅ 完成 | `InputBox.vue` + `newChat()` | 输入规则 7 项全过（Enter/Shift+Enter/输入法合成/生成中不重发/空内容） |
| P3 流式 | ✅ 完成 | `src/api/sse.ts` `RunStatus.vue` `stores/chat.ts` | 真实接口端到端跑通（delta 流式 + tool 事件 + run.completed）；半帧切片/中文多字节切分/keepalive 用例全过 |
| P4 部署 | 🟡 文件完成，**待宿主机验证** | `Dockerfile` `nginx.conf` `docker-compose.yml` `.env.example` | 本容器未挂 docker daemon，无法在此构建；命令见 §8 |
| P5 安全加固 | ⬜ 未开始（已定用 basic_auth） | Caddy basic_auth | 未带口令返回 401 |
| P6 每轮统计（v1.1 追加） | ✅ 完成 | `TurnStats`（`stores/chat.ts`）+ `MessageItem` 页脚 + `getSession()` | 单测 4 条 + **真实接口自检：未命中Δ + 命中Δ === usage.input_tokens** |
| P7 界面优化（v1.1 追加） | ✅ 完成 | 侧栏搜索（`Sidebar.vue`）+ 桌面折叠（`App.vue`）+ 黑夜模式（`lib/theme.ts`） | 新增 17 条单测（54/54 全过）；产物 CSS 核验含 39 条 `:is(.dark *)` 暗色规则；`vue-tsc` 0 错 |
| P8 长会话完整可读（v1.2 追加） | ✅ 完成 | 历史分页 `loadEarlier()`（划到顶自动触发 + 按钮兜底）+ 连续 assistant 合并（`normalize`）+ 压缩摘要折叠（`lib/messages.ts`、`MessageItem`） | 新增 18 条单测（72/72 全过），含"滚动到顶自动加载/到底不再请求/加载中不重复"；**真实链路核验：逐页加载结果与全量读 `toEqual` 完全相等**（206 条会话，含偏移位移去重） |

图例：⬜ 未开始 / 🟡 进行中 / ✅ 完成 / ❌ 阻塞

### 0.1 跨会话续接（接手先读这段，再读对应阶段章节）

**路径**：`/opt/data/hermes-chat-lite`（远程 `git@github.com:xd6022/hermes-chat-lite.git`，主分支 `main`）
**当前进度**：P0～P3、P6（每轮统计）、P7（搜索/折叠/黑夜模式）、P8（长会话分页与合并）已完成并推送（远程 `main`）；P4 文件已写好但**必须在宿主机构建验证**（本容器没有 docker daemon）。

**下一步**：① 宿主机 `docker compose up --build` 重建 → 真机点一遍（浏览器验证是唯一没做的一环，本容器 browser-use 守护进程卡死），重点按 README「上线自检」5 条走；② P5 Caddy basic_auth；③ 后续候选：`run.completed.messages` 回填工具结果到时间线（现在工具时间线只在流式过程中可见，重开就没了）、真机上把滚动位置补偿手感调一遍、服务端会话搜索（需改 Hermes 源码，按"不改 Hermes"原则暂不做）。

**可复制命令**：

```bash
cd /opt/data/hermes-chat-lite

# 依赖（已装则跳过；npm 11 必须 approve，否则 esbuild 起不来）
npm install --registry=https://mirrors.cloud.tencent.com/npm/
npm approve-scripts esbuild

# 起 dev server（key 由 vite 反代注入，前端里没有 key）
set -a && . /opt/data/.env && set +a
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173

# 自检：反代 + 鉴权是否通（期望 200 + 真实会话 JSON）
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:5173/api/sessions?limit=3"

# 类型检查 / 构建
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/vite/bin/vite.js build
```

**本机特有点坑（会反复踩）**：

| 坑 | 说明 |
| --- | --- |
| `./node_modules/.bin/<x>` 被终端拦截 | 判定为"从网关内重启服务"。一律改 `node node_modules/<pkg>/bin/<x>.js` |
| npm 11 拦 postinstall | 首次装完必须 `npm approve-scripts esbuild`，否则 vite 起不来 |
| key 的变量名 | hermes 容器里是 `API_SERVER_KEY`（非 `HERMES_API_SERVER_KEY`），vite 配置两个都认，缺 key 会打印警告 |
| 8642 只在容器内网 | 本容器内可 `http://127.0.0.1:8642` 直连；对外只能经 Caddy/nginx |
| 写盘限制 | 临时/核验文件统一放 `/opt/data/.verify/` |

**验证原则**：每阶段验收都要有真实工具输出（接口真返回、构建真通过、`vue-tsc` 真无错），不接受"应该能跑"。

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

**★ 反代必须清掉 `Origin` 头（实测踩坑，见 §12 第 21 条）**：Hermes 的 CORS 中间件在 `cors: false` 时会对任何携带 `Origin` 的请求返回 403 空响应。浏览器发 POST 一定带 `Origin`，所以反代（nginx / vite dev proxy）必须把它剥掉，否则真机浏览器 100% 不可用。

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

→ 想要"工具执行结果"（如 `write_file ✓ 784 bytes`），只能在 `run.completed` 到达后从 `messages` 里按 `tool_call_id` 回填时间线，**但不要把 `messages` 渲染成聊天消息**。

### 2.4 token 口径（实测核对，做每轮统计必须按这个来）

三个数字来源不同、语义不同，混用必然算错：

| 来源 | 语义 | 实测核对 |
| --- | --- | --- |
| `run.completed.usage.input_tokens` | **本轮总输入**（临时值，不累计） | 连发两轮分别 27311 / 27330，量级相同 → 确认是每轮值 |
| 会话记录 `input_tokens` | **累计**【未命中缓存】的输入 | 两轮后 1393 = 687 + 706 |
| 会话记录 `cache_read_tokens` | **累计**【命中缓存】的输入 | 两轮后 53248 = 26624 + 26624 |

**自检恒等式（实测精确成立）**：

```
本轮未命中Δ + 本轮命中Δ === 本轮 usage.input_tokens
706        + 26624      === 27330   ✅
```

所以每轮统计 = 会话记录做差（拿缓存分项）+ usage（拿本轮总量）。缓存命中率 = 命中Δ ÷ (未命中Δ + 命中Δ)。
**另外实测：`run.completed` 到达时会话记录已经是新值**（立即读 == +1.2s 再读），不需要等待或重试。
失败降级：会话记录读不到时，缓存率留空，耗时/输入/输出照常显示。

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
- **`proxy_set_header Origin "";`（必须，最容易漏，实测踩过）** —— Hermes API Server 的 CORS 中间件对**任何带 `Origin` 头的请求直接返回 403 空响应**（防 CSRF 设计）。浏览器所有 POST 都带 `Origin`，curl 不带 → 命令行测试全绿、真机浏览器全挂。nginx 语义：请求头设为空字符串 = 不向后端传递。
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

三段式：顶部栏（侧栏开关 + `Hermes` + 连接状态点 + **主题切换** + Settings 按钮）/ 主体（Sidebar 240px + ChatWindow 自适应）/ 输入区在 ChatWindow 内部底部。

- **一个按钮管两种形态**（`toggleSidebar()`，不按 viewport 分两个按钮渲染——桌面上出现"两个汉堡"很蠢）：
  - 桌面（`≥768px`）：切换侧栏折叠/展开，选择记在 `localStorage['hcl.sidebar']`（`'1'`/`'0'`），刷新后保持。
  - 移动端（`<768px`）：打开抽屉（选中会话后自动关闭）。
  - 判据：`window.matchMedia('(min-width: 768px)')`，`matchMedia` 不存在时退回 `innerWidth >= 768`（测试环境要用）。
  - 按钮 `aria-label`/`title` 随状态变化（`折叠会话列表` ↔ `展开会话列表`），否则 hover 提示会说反。
- 折叠态实现：Sidebar 根节点加 `md:hidden`（`display:none` 优先于 `md:static`，不必动宽度动画）。

### 5.2 `Sidebar.vue`

- 顶部一行（高度压缩，不再是整行大按钮）：**搜索框（占满）+ 新建图标按钮**。
  - **搜索是客户端过滤**：Hermes API **没有**搜索端点（实测 `/api/sessions` 只认 `limit/offset/source/include_children`；库里虽有 FTS5 索引，但只喂给 CLI 的 `hermes sessions browse`）。所以对已取到的会话做 `title / preview / id` 不区分大小写匹配。
  - 取数取满服务端上限 200 条（`loadSessions()`），**少取一条就等于搜不到那一条**。
  - 命中时显示 `找到 N 个`；无命中显示 `没有匹配「关键字」的会话`（不留空白）；有 `✕` 清空按钮；`Esc` 也可清空。
- 新建会话入口降级为图标按钮（`aria-label="新对话"`），因为**发送消息时如果还没有会话会自动建一个**（`send()` 里 `if (!store.currentId) await newChat()`），所以入口不需要抢视觉权重。
- 分组渲染：`今天` / `昨天` / `更早`（依据 `last_active`，用 `Intl.DateTimeFormat` 判定自然日差）。
- 单条：主行 title（空则显示 `preview` 前 30 字，再空则显示 `未命名会话`），副行不显示（保持简洁）；悬浮时右侧出现小字时间。
- 当前会话高亮（浅灰底；深色下 `dark:bg-gray-700/70`）。
- 空态：无会话 → `还没有会话，直接在下方输入即可开始`；加载态 → 骨架屏 5 行（不要 spinner 全屏遮罩）。

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
  - **完成后追加一行统计页脚**：`⏱ 3.6s · 输入 27.3k · 缓存 26.6k (97%) · 输出 20`（数据来自 `TurnStats`，见 §2.4 口径）。缓存率取不到时该段自动省略。
- **用户消息**：纯文本（`white-space: pre-wrap`），不解析 markdown（避免误触发代码高亮），保留换行。
- 代码块：`<pre><code class="hljs language-x">`，右上角"复制"按钮（`navigator.clipboard`），等宽字体。
- markdown-it 配置：`linkify: true, breaks: true, html: false`（**html:false 是安全项**，防止 agent 输出里的原始 HTML 注入）。代码高亮用 `highlight.js` 在 `highlight` 回调里调用，失败则 fallback 为转义纯文本。
- 性能：流式期间对同一气泡做**节流重渲染**（`requestAnimationFrame` 每帧最多一次 `v-html` 更新），长回复不会掉帧。

### 5.5 `InputBox.vue`

- `textarea` 高度自适应（1～8 行，`scrollHeight` 计算）。
- Enter 发送、Shift+Enter 换行；**中文输入法合成期间（`isComposing`）不触发发送**（必须处理，否则拼音回车会误发）。
- 生成中：发送按钮变「停止」，点击 `stop()`；**输入框保持可输入**（只禁用发送，方便先打下一句），Enter 不再触发发送。
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

**阶段切换规则（实测得出）**：一旦进入「正文生成」(`writing`)，**不因迟到的 `tool.progress` 降级回「思考中」** —— 实测事件顺序里 `tool.progress`（reasoning.available）会晚于首个 `assistant.delta` 到达，若不做保护，状态条会在正文已经开始输出时倒回"正在思考"。

### 5.7 Settings（最小化，不做模型切换）

点顶部「Settings」右侧滑出小面板，只有四项：
1. 连接状态：绿点 + `Hermes v0.20.4`（数据来自 `GET /health`）+ 刷新按钮。
2. **外观**：当前主题（白天/黑夜）+ 切换按钮（等同顶栏那个按钮）。
3. 关于：版本号、一组快捷键说明。

### 5.8 侧栏搜索 / 桌面折叠 / 黑夜模式（v1.1 追加）

**黑夜模式**——三处必须同时改，否则会出现"切了没反应"或"刷新闪白"：

| 位置 | 作用 |
| --- | --- |
| `index.html` 内联脚本 | **首帧之前**读 `localStorage['hcl.theme']` 给 `<html>` 加 `dark` 类。少了它，深色用户每次刷新都会闪一下白屏（FOUC） |
| `src/lib/theme.ts` | 运行时切换：`initTheme()` / `toggleTheme()` / `setTheme()`；同步 `<html class>`、`color-scheme`、`<meta name="theme-color">` |
| `tailwind.config.js` `darkMode: 'class'` | 所有 `dark:` 变体的开关。配错（用默认 `media`）会**静默丢掉全部 `dark:` 类**，界面看起来"完全没变" |

口径：**手动选择 > 系统偏好**。没有手动选择时跟随 `prefers-color-scheme`，且此时**不写 localStorage**（写回会把"跟随系统"冻死成当前值，系统改主题就再也追不上）。

代码高亮暗色：`highlight.js` 的 `github.css` 是浅色专用，且 CSS 不支持给 `@import` 加作用域 —— 不能再引一份 `github-dark.css`（它会把整个文件的选择器都带上，浅色下也生效）。做法是在 `style.css` 里手写一份 `.dark .hljs-*` 调色板（约 30 行），靠选择器优先级覆盖 `github.css`。

**明确不做**：模型切换、Prompt 管理、Agent 配置（需求第七条禁止项）。

### 5.9 历史分页与消息合并（v1.2 追加）

**起因**（用户反馈）：「打开这个会话，最上面的消息只能到中间某一条」+「页面展示像自动加了换行」。两个都是真问题，各有明确根因。

**① 分页语义（实测 2026-09-11，本机 hermes:8642）**

| 项 | 实测结论 |
| --- | --- |
| 合法 `order` | 只有 `oldest` / `latest`；传 `earliest` 直接 **400** —— `order must be one of: oldest, latest` |
| `order=latest` + `offset=N` | 从**最新往回数**第 N 条起的一页；页内按时间正序；不同 offset 的窗口**不重叠** |
| `limit` 上限 | messages 接口实测 **500**（传 1000 会被夹到 500） |
| 总数 | 接口**不返回 total**，只能靠「返回条数 == limit」判断可能还有更早的 |

选 `latest`+`offset` 而不是 `oldest`：首屏要的就是"最新一页"，用 `oldest` 得先知道总数（接口不给）。代价是 offset **锚定在"最新"** —— 发过新消息后窗口整体后移、与已加载内容重叠，**必须按 id 去重**。

**② 去重不能用 `store.messages` 里的 srcId**（自测踩到）：连续 assistant 合并后，一个界面消息只保留该组**最后一条**的 id，中间 id 从界面上消失 → 去重漏掉它们，同一段内容会被加载两次。必须单独维护模块级 `loadedIds`（`openSession` 时重置）。

**③ 合并连续 assistant**（`normalize` 最后一步、`prependEarlier` 在分页边界补一次）：一次工具轮次里模型可能说好几段话，transcript 就是连续多条 assistant（实测本会话有一条 **19 条连续**）。分开渲染 = 段间 24px 间距 + 复制出来多空行，读起来就是"自动加了换行"；合并成一段后与流式时的观感一致（流式本来只有一块）。

**④ 压缩摘要消息要认出来**：Hermes 上下文压缩会在 transcript 留下一条内部机制消息（实测 11890 字符、`role=assistant`）。它既不是对话内容、也不该被合并进正文 → 标记 `compaction` 后渲染成折叠块。判据**照抄 Hermes 自身实现**（`api_server.py:439 _is_compressed_summary_message` / `context_compressor.py:376-382`）：**取前 280 字符做包含判断**。不要自己写 `startsWith('[CONTEXT COMPACTION')` —— 真实那条消息开头是 `[PRIOR CONTEXT — for reference only…]`，标记在 100 字符之后，startsWith 会漏判。

**⑤ 怎么验证的（可复现，这是本项目最强的一种验证）**：写一次性 spec，用**未改动的 store 源码**打真实 API（包装 `globalThis.fetch`：相对路径改写成 `http://127.0.0.1:8642` + 注入 `Bearer`，即 nginx 在生产做的那件事），逐页 `loadEarlier()` 到没有更早，再断言 `store.messages` 与「一次全量读后 `normalize`」的结果 **`toEqual` 逐字段相等**。这一条断言同时覆盖漏、重、边界合并三类错误。实测该会话 206 条原始消息 → 15 条界面消息，偏移位移造成的重叠被正确去重。

```bash
cd /opt/data/hermes-chat-lite
set -a && . /opt/data/.env && set +a
npx vitest run src/xxx.verify.spec.ts     # 临时核验脚本：跑完就删，别混进 npm test
```

**副作用提示**：合并后「界面消息数」≠「transcript 条数」（该会话 206 → 15）。客服式对账、截图比对时不要拿界面条数当借口数。

**⑥ 划到顶自动加载**（v1.3）：`onScroll` 里判 `scrollTop <= 60px` 就直接调 `earlier()`，滚轮和触摸都走同一条路径。

- 阈值取 60 而不是 0：贴到 0 才开始加载，用户会先看到一段空档再蹦出新内容。
- **不会重复请求**：`loadEarlier()` 自身有 `historyLoading / hasMoreHistory / streaming` 三重闸门；而且加载后的 `scrollTop` 补偿会把位置推出阈值，天然形成"一次滚动只加载一页"。
- **按钮必须保留**（别当成冗余清理掉）：内容不足一屏时**不产生滚动事件**，自动加载永远等不到 —— 那个场景只能点按钮。按钮同时是"加载中…"的反馈位。
- 滚动监听用 `@scroll.passive`（不调 preventDefault，被动监听让浏览器滚动更顺）。

---

## 6. UI 规范

| 项 | 值 |
| --- | --- |
| 消息区最大宽度 | `768px`，水平居中 |
| 字体 | 正文 15px / 行高 1.75（中文可读性）；代码 13px mono |
| 主色 | 浅色：近黑文字 `#111827` 配白底 `#ffffff`；深色：`gray-100` 文字配 `gray-950` 底（`#030712`），卡片 `gray-900`。以 Tailwind `dark:` 变体落地，不写死 hex |
| 圆角 | 卡片 12px，输入框 16px |
| 间距 | 消息之间 24px，段落之间 12px |
| 侧栏 | 240px / 底 `#f9fafb`，与主体 1px 分隔线 |
| 输入区 | 固定底部，随内容增长；最大高度 40vh |
| 移动端 | 侧栏抽屉；输入框字号 ≥16px（防 iOS 自动缩放） |

---

## 7. 错误与边界处理

| 场景 | 表现 |
| --- | --- |
| 启动时 `/health` 失败 | 顶栏红点 + `无法连接 Hermes`；**消息区上方红色错误横幅 + 重试按钮** |
| 创建会话失败（如反代没注入 key → 401） | **必须显示可见横幅**（实测踩过：原来只在"已有消息"分支渲染错误，导致点发送毫无反应、只能去 F12 看） |
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

### 10.1 验证证据（2026-09-11）

| 验证项 | 怎么验的 | 结果 |
| --- | --- | --- |
| SSE 解析器打真实接口 | node 直接跑 `src/api/sse.ts`（模拟反代注入鉴权头）打 `POST /api/sessions/{id}/chat/stream` | ✅ 事件序列 `run.started → message.started → tool.started → tool.completed → assistant.delta → tool.progress → assistant.completed → run.completed → done`；delta 分片 2（真流式）；`read_file` 工具事件收到；`run.completed` 收到 |
| 历史消息过滤 | 同上，读回 `GET /messages` | ✅ 原始 4 条 → 界面可见 2 条，最后一条是 assistant |
| 前端运行时 | `vitest`（jsdom + @vue/test-utils） | ✅ 37/37 通过（半帧切片、中文切在多字节中间、keepalive、过滤规则、输入法、失败可见性、每轮统计、App 集成） |
| Origin 403 修复 | 带 `Origin` 头打修复后的反代 | ✅ GET 200 / POST 201；对照：直连 8642 带同样 `Origin` 仍 403（反证触发点就是它） |
| token 口径 | 真接口连发两轮，比对 usage 与两次会话记录 | ✅ 未命中Δ 706 + 命中Δ 26624 === usage.input_tokens 27330（精确）；`run.completed` 后立即读记录已是新值 → 无竞态 |
| 每轮统计页脚 | 用真实数据按前端同样算法渲染 | ✅ 输出 `⏱ 3.6s · 输入 27.3k · 缓存 26.6k (97%) · 输出 20` |
| 类型与构建 | `vue-tsc --noEmit` + `vite build` | ✅ 0 类型错误；产物 280KB（gzip 109KB）/ CSS 25.4KB |
| 界面优化三件套（v1.1） | `vitest` + 产物 CSS 核验 | ✅ 新增 17 条（54/54 全过）：搜索过滤/无命中空态/清空、折叠持久化、主题切换与持久化、隐私模式不抛异常；`dist/assets/*.css` 含 39 条 `:is(.dark *)` 与 `.dark .hljs-*` 规则；`dist/index.html` 含首帧防闪白脚本 |
| 长会话可读性（v1.2→v1.3） | `vitest` + **真实 API 端到端** | ✅ 新增 18 条（72/72 全过）：分页 offset/到底判定/位移去重/边界合并/压缩摘要不污染正文/滚到顶自动加载与三重闸门；真实会话 206 条原始消息逐页加载后与全量读 `toEqual` **完全相等**，会话第一条已可见 |
| 真实浏览器 | ❌ 未做 | 本容器 browser-use 守护进程卡死（已知问题），需您在真机点一遍 |
| Docker 构建/运行 | ❌ 未做 | 本容器未挂 docker daemon（只有 CLI），需在宿主机执行 |

---

## 11. 明确不做（v1 冻结，防范围蔓延）

用户登录 / 权限 / 多用户 / 数据库 / 文件上传 / 图片生成 / 插件市场 / 模型切换 / Prompt 管理 / Agent 配置页 / 会话删除与收藏 / 消息重新生成 / 多标签并发流。

**关于"会话搜索"**（原列在此处，v1.1 已做）：做的是**客户端标题过滤**（覆盖已加载的 200 条），不是服务端全文检索——Hermes API 没有搜索端点，要做真搜索必须改 Hermes 源码，与"不改 Hermes"原则冲突。消息内容搜索仍不做。

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
17. **`assistant.completed.content` 必须覆盖 delta 拼接** → 实测：delta 原文是 `["\n\nhermes-chat","-lite"]`，`completed` 是 `"hermes-chat-lite"`。**delta 会带前导换行等杂质**，追加会多出空行、少字就在所难免。以 `completed` 覆盖是必须的，不是防御性编程。
18. **计时器别用事件里的 `ts`** → 用 `performance.now()` 本地算，否则时间会跳。
19. **完成态必须由事件显式判定** → 见 5.6 的判定表；"界面不再变化"≠"已完成"，这正是 Open WebUI 让您困惑的地方。
20. **健康检查不能打 `/health`** → 实测 `/health` 不带 key 也返回 200，密钥填错照样 healthy，等于验不出问题；要打 `GET /api/sessions?limit=1`（无 key/错 key 返回 401），才能同时验证反代与密钥有效。
21. **★★ 带 `Origin` 头的请求会被 Hermes 直接 403**（本项目部署时真实踩到，代码与文档此前判断有误）→ Hermes 的 CORS 中间件在 `cors: false` 时，只要请求带 `Origin` 就返回 **403 空 body**（`Server: Python/3.x aiohttp`）。**浏览器所有 POST 都自带 `Origin`，curl 不发送** → 结果就是：命令行怎么测都通，真机浏览器一打开就死。修法：反代层剥掉它 —— nginx `proxy_set_header Origin "";`，vite dev proxy `proxyReq.removeHeader('origin')`。**注意：这不是"开 CORS 就行"的问题，同源反代本身也不够。**
22. **★★ 清理测试会话只许按 id 白名单，禁止按 `source` 批量删**（2026-09-11 真实事故，见 `docs/incident-2026-09-11-deleted-session.md`）→ `DELETE /api/sessions/{id}` 是**硬删除**（会话 + 消息一起没，无回收站）；MySQL 归档 cron 每天 21:00 才跑一次，之前删的东西没有第二份副本。用 `source=api_server` 做批量条件删除会**把用户的真实会话一起删掉，且不可恢复**（页级抢救实测无效：被删页已被后续写入复用）。
23. **★ 会话搜索必须客户端自己实现** → Hermes API **没有**搜索端点：`GET /api/sessions` 实测只认 `limit/offset/source/include_children`；`hermes_state.py` 里那个 `search_sessions()` 名字骗人，它只是"按 source/workspace 列会话"，不搜关键字；真正的 FTS5 全文检索在 `hermes_state_search.py`，但只喂 CLI（`hermes sessions browse --filter`），没走 HTTP。所以搜索只能对已取到的会话做本地匹配，且**必须取满 limit=200**（少取就搜不到）。搜消息内容要改 Hermes 源码，不做。
24. **★★ 测试里 `localStorage` 是 undefined（Node 22+ 遮蔽 jsdom）** → 裸 jsdom 明明有（`typeof window.localStorage === 'object'`），但在 vitest 里 `globalThis.localStorage` 已被 **Node 22+ 内置的实验性实现**占住：没有 `--localstorage-file` 时取值为 `undefined` 并打印 `ExperimentalWarning: localStorage is not available...`，把 jsdom 那份遮蔽掉。症状是 `Cannot read properties of undefined (reading 'clear')`，会误以为是 jsdom 不支持。修法：`src/test-setup.ts` 装一个语义完整的内存 `Storage`（不要用 mock 调用次数糊过去，那样测的不是真逻辑），并给 jsdom 一个真实 `url`（`environmentOptions`，否则不透明 origin 下 jsdom 根本不建 localStorage）。
25. **★ 暗色模式三处必须同步改** → `index.html` 内联脚本（首帧前定主题，防闪白）+ `lib/theme.ts`（运行时切换）+ `tailwind.config.js` 的 `darkMode: 'class'`。漏掉第三处时**不会报错**，只是所有 `dark:` 类被静默丢弃、界面看起来完全没切。核验方式：构建后在 `dist/assets/*.css` 里数 `:is(.dark *)` 出现次数（当前 39 条）。注意 Tailwind 3.4 生成的是 `:is(.dark *)` 形式，**不是** `.dark .bg-gray-800`，用后一种模式 grep 会得到 0 并误判成"配置没生效"。
26. **★ hljs 暗色不能直接再引一份 `github-dark.css`** → CSS 不支持给 `@import` 加作用域，引进来会在浅色模式下也生效。做法是手写 `.dark .hljs-*` 调色板（`.dark .hljs` 的优先级高于 `.hljs`，能覆盖 `github.css` 的 `background:#fff`），代码块底色由 `.md-body pre` 的 `dark:bg-gray-900` 负责，`.dark .hljs` 只把背景设为透明。
27. **★ 历史分页的 offset 锚定在"最新"，不是会话开头** → `order` 只有 `oldest|latest`（传 `earliest` 直接 400：`order must be one of: oldest, latest`）；`latest` + `offset=N` 是"从最新往回数第 N 条"，所以**发过新消息后已加载窗口会整体后移并与新页重叠 → 必须按 id 去重**；接口不返回总数，"还有没有更早"只能靠 `returned === limit` 判断（messages 的 limit 上限实测 500）。改动分页相关代码时，务必用 §5.9 ⑤ 那个"逐页加载 vs 一次全量读 `toEqual`"的核验方法重跑一遍。
28. **★★ 合并连续 assistant 之后，不能再用界面消息去重** → 合并只保留该组最后一条的 id，中间 id 从界面上消失；拿 `store.messages` 的 `srcId` 去重会漏（自测已复现：同一段被加载两次）。要单独维护 `loadedIds`。同理，**压缩摘要消息不能靠 `startsWith('[CONTEXT COMPACTION')` 识别** —— 真实那条以 `[PRIOR CONTEXT — for reference only…]` 开头，标记在 100 字符之后，必须用 Hermes 压缩器那套"前 280 字符包含标记"的判据（见 `lib/messages.ts`）。
29. **★ "加载更早"按钮不能因为有了自动加载就删掉** → 自动加载挂在 `scroll` 事件上，而**内容不足一屏时容器根本不产生滚动事件**，用户永远触发不了 → 必须有可点的按钮兜底（它同时是"加载中…"的反馈位）。另外自动加载的阈值是 `scrollTop <= 60px` 而不是 `== 0`，贴到 0 才加载会先露一段空档。
