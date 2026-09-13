/**
 * 轻量响应式单例 store（不引 Pinia：v1 只有一个会话视图，reactive 足够）。
 *
 * 职责：
 *  - 会话列表 / 当前会话 / 消息列表
 *  - 发送消息并消费 SSE 事件（含工具执行时间线与显式完成态判定，见设计文档 5.6）
 */

import { reactive } from 'vue'
import {
  createSession,
  deleteSession as deleteSessionApi,
  getMessages,
  getSession,
  getSessions,
  health,
  HermesApiError,
  renameSession as renameSessionApi,
  streamChat,
} from '../api/hermes'
import { approveRun, getRun, runEvents, stopRun, submitRun } from '../api/runs'
import { isCompactionNote } from '../lib/messages'
// v2.2 后台/断线恢复：页面生命周期信号 + 退避间隔（见文件下半部分的 resumeSync）
import { backoffDelay, isForeground } from '../lib/page-lifecycle'
import { securityBlock, type SecurityBlock } from '../lib/security'
import type {
  ApprovalChoice,
  HermesMessage,
  HermesSession,
  HermesUsage,
  SseApprovalRequest,
  SseAssistantCompleted,
  SseDelta,
  SseError,
  SseRunCompleted,
  RunStatusResponse,
} from '../api/types'

export interface UiMessage {
  key: string
  role: 'user' | 'assistant'
  content: string
  /** 正在逐字渲染（显示光标） */
  streaming?: boolean
  /** 该条消息级别的错误 */
  error?: string | null
  /** 该轮的统计（仅助手消息、且本轮成功结束时才有） */
  stats?: TurnStats
  /**
   * 服务端消息 id。两个用途：
   *  1. 加载更早的历史时去重（offset 从最新往回数，发过新消息后窗口会整体位移，
   *     位移量正好等于新增消息数 → 会重叠，必须按 id 去重）
   *  2. 合并分页边界上的连续 assistant 时确定归属
   * 乐观插入（还在流式中）的消息没有 id。
   */
  srcId?: number
  /** 这是 Hermes 的上下文压缩摘要消息（内部机制，折叠显示、不参与合并） */
  compaction?: boolean
}

/**
 * 每轮统计。口径经实测核对（三者自洽）：
 *   usage.input_tokens       本轮总输入（临时值）
 *   会话记录 input_tokens    累计【未命中缓存】的输入
 *   会话记录 cache_read_tokens 累计【命中缓存】的输入
 *   未命中Δ + 命中Δ === usage.input_tokens（实测 706 + 26624 = 27330 ✓）
 */
export interface TurnStats {
  /** 墙钟耗时（用户真实等待时间） */
  ms: number
  /** 本轮总输入 */
  inputTokens: number
  /** 本轮未命中缓存的输入 */
  uncachedInput: number
  /** 本轮命中缓存的输入 */
  cacheRead: number
  /** 缓存命中率 0..1；取不到为 null */
  cacheRate: number | null
  outputTokens: number
}

export type RunPhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  /** 服务端在等我们回话（审批）——这一轮**卡住不会自己走**，必须回话 */
  | 'approval'
  | 'writing'
  /**
   * 连接断了/页面刚从后台回来，但**服务端那一轮还在跑**（v2.2）。
   * 与 `aborted` 的区别：aborted = 这一轮不会再变了；background = 还在跑，
   * 界面正在按退避间隔问服务端要状态，回来就自动补消息。
   */
  | 'background'
  | 'done'
  | 'aborted'
  | 'error'

/**
 * 待审批状态（服务端 `approval.request` 事件的界面投影）。
 * 字段是防御式的：载荷来自工具侧，缺字段也不能崩，所以全部可选 + 兜底。
 */
export interface ApprovalState {
  toolName: string
  /** 被 Tirith 标红的命令原文（服务端已脱敏），可能没有 */
  command: string | null
  /** 可选项（服务端 `_approval_event_choices()` 给的），兜底为 once/deny */
  choices: string[]
  smartDenied: boolean
  allowPermanent: boolean
  /** 正在回话 */
  submitting?: boolean
  /** 已回话的选择（等服务端 approval.responded 或下一个事件到达后收起） */
  resolved?: ApprovalChoice | null
  /** 回话失败的原因 */
  error?: string | null
}

export interface ToolStep {
  name: string
  preview: string
  status: 'run' | 'ok' | 'fail'
}

export const store = reactive({
  /* 连接 */
  healthOk: false,
  healthVersion: '',

  /* 会话列表 */
  sessions: [] as HermesSession[],
  sessionsLoading: false,

  /* 当前会话 */
  currentId: null as string | null,
  messages: [] as UiMessage[],
  messagesLoading: false,

  /* 历史分页：offset 从【最新】往回数（实测语义，见 §5.9） */
  rawCount: 0,
  hasMoreHistory: false,
  historyLoading: false,

  /* 轮次状态 */
  streaming: false,
  bootError: null as string | null,
  run: {
    phase: 'idle' as RunPhase,
    startedAt: 0,
    endedAt: 0,
    currentTool: null as string | null,
    toolPreview: null as string | null,
    timeline: [] as ToolStep[],
    errorMessage: null as string | null,
    /** 本轮被安全闸门拦下的说明（stream 通道从 run.completed.messages 捞；runs 通道从轮末回读的 transcript 捞） */
    blocked: null as SecurityBlock | null,
    /** 本轮 run_id（runs 通道才有：中断/审批回话都要它） */
    runId: null as string | null,
    /** 待审批（runs 通道才有） */
    approval: null as ApprovalState | null,
    /**
     * 本轮的数据是靠"轮末回读会话"补齐的（事件流断了/没收到终止事件）。
     * 界面据此标注一句"已回读对账"，用户才知道为什么会话里还有内容。
     */
    recovered: false,
    /**
     * 正在跟服务端要状态/补消息（v2.2）。为 true 时状态条显示"正在同步…"，
     * 让用户知道"不是卡住了，是在对齐"。
     */
    syncing: false,
  },
})

let abortCtl: AbortController | null = null

/**
 * 已加载过的原始消息 id（分页去重用）。
 * 为什么不能用 store.messages 里的 srcId：连续 assistant 合并后，一个界面消息
 * 只保留该组最后一条的 id，中间那些 id 从界面上消失了 —— 拿它去重会漏，
 * 于是同一段内容会被加载两次（自测已复现：assistant-70 出现两次）。
 */
let loadedIds = new Set<number>()

/* ---------------- 工具函数 ---------------- */

export function msgOf(e: unknown): string {
  if (e instanceof HermesApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function tempKey(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** content 可能是 string / 多模态数组 / null */
function textOf(m: HermesMessage): string {
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

/**
 * 历史消息 → 界面消息（设计文档 3.3 / 12 章）：
 *  1. 丢掉非 user/assistant（tool / system）
 *  2. 丢掉 content 为空的 assistant（那是工具调用轮，界面不该出现空泡泡）
 *  3. content 为数组时取 text 片段拼接
 *  4. 压缩摘要消息单独标记（折叠显示，且不参与合并）
 *  5. **连续 assistant 合并成一段**
 *
 * 为什么必须合并：一次工具轮次里模型可能说好几段话，transcript 里就是连续多条
 * assistant。实测本会话有一条 19 条连续的 assistant（每段都是我一次工具轮次的
 * 短句）。分开渲染 = 段与段之间 24px 间距 + 复制出来多空行，读起来像"自动加了
 * 换行"；合并后同一条回答连成一段，与流式时的观感也一致（流式本来就只有一块）。
 */
export function normalize(raw: HermesMessage[]): UiMessage[] {
  const out: UiMessage[] = []
  for (const m of raw) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = textOf(m)
    if (!text.trim()) continue

    if (m.role === 'assistant' && isCompactionNote(text)) {
      out.push({ key: `h_${m.id}`, role: 'assistant', content: text, srcId: m.id, compaction: true })
      continue
    }

    const prev = out[out.length - 1]
    if (m.role === 'assistant' && prev && prev.role === 'assistant' && !prev.compaction) {
      prev.content = `${prev.content}\n\n${text}`
      prev.srcId = m.id
      continue
    }
    out.push({ key: `h_${m.id}`, role: m.role, content: text, srcId: m.id })
  }
  return out
}

/** 一页历史消息的条数（服务端 messages 的 limit 上限实测是 500） */
export const HISTORY_PAGE = 100

/**
 * 把"更早的一页"拼到前面，并在分页边界处补一次合并 —— 一条几十段的 assistant
 * 会被分页切开（前 100 条一页），不补的话边界处还会留下那 24px 的缝。
 */
export function prependEarlier(older: UiMessage[], current: UiMessage[]): UiMessage[] {
  if (!older.length) return current
  if (!current.length) return older
  const last = older[older.length - 1]
  const first = current[0]
  if (
    last.role === 'assistant' &&
    first.role === 'assistant' &&
    !last.compaction &&
    !first.compaction
  ) {
    const merged: UiMessage = {
      ...last,
      content: `${last.content}\n\n${first.content}`,
      // 保留较新那条的运行时附注（统计/错误/流式标记）
      stats: first.stats ?? last.stats,
      error: first.error ?? last.error,
      streaming: first.streaming ?? last.streaming,
      srcId: first.srcId ?? last.srcId,
    }
    return [...older.slice(0, -1), merged, ...current.slice(1)]
  }
  return [...older, ...current]
}

/* ---------------- 动作 ---------------- */

export async function checkHealth(): Promise<void> {
  try {
    const h = await health()
    store.healthOk = h.status === 'ok'
    store.healthVersion = h.version ?? ''
  } catch {
    store.healthOk = false
  }
}

export async function loadSessions(): Promise<void> {
  store.sessionsLoading = true
  try {
    // 取满服务端上限 200 条：客户端搜索只能覆盖已取到的会话，
    // 少取一条就等于搜不到那一条（Hermes 没有服务端搜索端点）。
    const res = await getSessions(200)
    // 隐藏/归档的不进侧栏
    store.sessions = res.data.filter((s) => !s.hidden && !s.archived)
  } catch (e) {
    store.bootError = msgOf(e)
  } finally {
    store.sessionsLoading = false
  }
}

export async function openSession(id: string): Promise<void> {
  if (store.streaming) return
  store.currentId = id
  store.messages = []
  store.bootError = null
  store.messagesLoading = true
  store.run.phase = 'idle'
  store.run.timeline = []
  // 分页状态必须跟着会话重置，否则会把上一个会话的 offset 用到新会话上
  store.rawCount = 0
  store.hasMoreHistory = false
  try {
    const res = await getMessages(id, HISTORY_PAGE, 0)
    store.messages = normalize(res.data)
    loadedIds = new Set(res.data.map((m) => m.id))
    store.rawCount = res.data.length
    // 返回条数等于一页 → 可能还有更早的（真实会话动辄上百条，只取最近 100 条
    // 会让会话开头整段看不到，这就是"最上面的消息只到某一条"的原因）
    store.hasMoreHistory = res.data.length >= HISTORY_PAGE
  } catch (e) {
    store.messages = []
    store.bootError = msgOf(e)
  } finally {
    store.messagesLoading = false
  }
  // v2.2：打开会话后立刻对一次账 —— 页面刷新/被杀过之后，"这一轮还在后台跑"
  // 或"已经跑完了"都要在这里认出来（否则用户只看到自己那条消息、以为丢了）。
  void resumeSync()
}

/**
 * 加载更早的历史（点"加载更早的消息"）。
 *
 * 分页语义（实测 2026-09-11，见 docs §5.9）：
 *  - `order=latest` + `offset=N` = 从【最新】往回数第 N 条起的一页，页内按时间正序，无重叠
 *  - 合法 order 只有 `oldest | latest`（`earliest` 直接 400）
 *  - messages 的 limit 上限实测 500
 *  - offset 锚定在"最新"，所以发过新消息后窗口会整体后移，与已加载内容重叠 → 按 id 去重
 */
export async function loadEarlier(): Promise<void> {
  const sid = store.currentId
  if (!sid || store.streaming || store.historyLoading || !store.hasMoreHistory) return
  store.historyLoading = true
  try {
    const res = await getMessages(sid, HISTORY_PAGE, store.rawCount)
    const fresh = res.data.filter((m) => !loadedIds.has(m.id))
    for (const m of fresh) loadedIds.add(m.id)
    if (fresh.length) store.messages = prependEarlier(normalize(fresh), store.messages)
    store.rawCount += res.data.length
    // 两种"到底了"：不满一页，或这一页全是重复（窗口已位移到没有新内容）
    store.hasMoreHistory = res.data.length >= HISTORY_PAGE && fresh.length > 0
  } catch (e) {
    store.bootError = msgOf(e)
  } finally {
    store.historyLoading = false
  }
}

/** 新建空会话（不传 title：标题有唯一约束，重名会被拒） */
export async function newChat(): Promise<string | null> {
  try {
    const res = await createSession()
    store.currentId = res.session.id
    store.messages = []
    loadedIds = new Set()
    store.rawCount = 0
    store.hasMoreHistory = false
    store.bootError = null
    store.run.phase = 'idle'
    store.run.timeline = []
    return res.session.id
  } catch (e) {
    store.bootError = msgOf(e)
    return null
  }
}

/** 标题长度上限（服务端实测：超过 100 字符 → 400 `invalid_title`） */
export const TITLE_MAX = 100

/** 把服务端的 title 报错翻成人话（原文带 session id，丢给用户没意义） */
function titleError(e: unknown): string {
  const raw = msgOf(e)
  if (/already in use/i.test(raw)) return '标题已被别的会话占用，换一个'
  if (/too long/i.test(raw)) return `标题太长（最多 ${TITLE_MAX} 字）`
  return raw
}

/**
 * 重命名（PATCH）。成功返回 null，失败返回**给行内显示**的文案。
 * 刻意不写 store.bootError —— 那是全局横幅，改名失败属于行级错误，就地提示。
 *
 * 注意：服务端有标题唯一约束，重名必定 400；这是正常的业务拒绝，不是异常。
 */
export async function renameSession(id: string, title: string): Promise<string | null> {
  const next = title.trim()
  try {
    const res = await renameSessionApi(id, next)
    const row = store.sessions.find((s) => s.id === id)
    if (row) row.title = res.session?.title ?? (next || null)
    return null
  } catch (e) {
    return titleError(e)
  }
}

/**
 * 删除**单个**会话（硬删除、不可恢复）。
 *
 * 纪律（2026-09-11 真事故的教训）：只允许"用户点中某一行 → 二次确认 → 删这一行"。
 * 绝不提供按 source/条件批量删的入口 —— 服务端也**没有**批量端点，别在前端自己拼。
 *
 * **空壳复查**：服务端已知缺陷 —— 删除后约 0.5s，迟到的异步写入（token 计数 /
 * 标题生成）会调 `_insert_session_row()` 把会话行重新 upsert 出来
 *（`source='unknown'`、0 条消息），于是列表刷新后"删掉的会话又回来了"。
 * 复现与根因：`/opt/data/.verify/repro_ghost_session.mjs`；服务端补丁：
 * `/opt/data/.verify/apply_ghost_fix.py`（需 root，未应用时靠这里兜底）。
 * 这里在 `ghostSweepDelayMs` 之后复查一次，真冒出来就再删一次 —— 顺手把
 * TUI / 仪表盘列表里的同一具空壳也清掉。
 */
export async function removeSession(id: string, ghostSweepDelayMs = 2000): Promise<string | null> {
  try {
    await deleteSessionApi(id)
    store.sessions = store.sessions.filter((s) => s.id !== id)
    if (store.currentId === id) {
      // 删的正是当前打开的会话 → 回到空态，别留着一个已经不存在的 id
      store.currentId = null
      store.messages = []
      loadedIds = new Set()
      store.rawCount = 0
      store.hasMoreHistory = false
      store.run.phase = 'idle'
      store.run.timeline = []
    }
    void sweepGhost(id, ghostSweepDelayMs)
    return null
  } catch (e) {
    return msgOf(e)
  }
}

/** 复查"被复活"的空壳并清掉；失败一律静默（这不是用户请求的操作，不该打扰用户）。 */
async function sweepGhost(id: string, delayMs: number): Promise<void> {
  try {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    await getSession(id) // 还能读到 → 说明被异步写入复活了
    await deleteSessionApi(id)
    store.sessions = store.sessions.filter((s) => s.id !== id)
  } catch {
    // getSession 抛 HermesApiError(404) = 干净，什么都不用做
  }
}

/**
 * 发送通道开关（A 方案，2026-09-12）。
 *   `'runs'`   = `POST /v1/runs` + `GET /v1/runs/{id}/events` —— 自带审批/中断/引导
 *   `'stream'` = `POST /api/sessions/{id}/chat/stream` —— 旧通道（服务端没接审批线）
 * 两条路**共用同一套渲染与状态机**（applyEvent + finally 里的收尾），
 * 所以回退只要 `setSendTransport('stream')`（默认值见 DEFAULT_TRANSPORT）。
 * 设计与实测依据：docs/plans/2026-09-12-runs-transport.md
 */
export const DEFAULT_TRANSPORT: 'runs' | 'stream' = 'runs'

let transport: 'runs' | 'stream' = DEFAULT_TRANSPORT

/** 当前发送通道（界面上的"回退开关"读它） */
export function sendTransport(): 'runs' | 'stream' {
  return transport
}

/** 切换发送通道（生产上用于回退；用例里用来分别验证两条通道） */
export function setSendTransport(t: 'runs' | 'stream'): void {
  transport = t
}

/** 用户点过"停止"（用来区分"用户主动停"和"流断了"） */
let stopRequested = false

/** 本轮上下文。finally 里还要读，所以必须是对象而不是局部标量。 */
interface TurnCtx {
  sid: string
  asst: UiMessage
  /** runs 通道的 run_id（中断 / 审批回话都要它） */
  runId: string | null
  /** 收到过终止事件（run.completed / run.failed / run.cancelled / error） */
  sawTerminal: boolean
  /** 这一轮被取消（服务端 run.cancelled）—— 不能算"完成" */
  cancelled: boolean
  sawError: boolean
  usage: HermesUsage | null
}

/** 审批卡片：已回话、且这一轮已经继续往下跑了 → 收起 */
function dropResolvedApproval(): void {
  if (store.run.approval?.resolved) store.run.approval = null
}

/**
 * 工具名的取法：两条通道字段名不一样 ——
 *   旧通道 chat/stream：`tool_name`
 *   新通道 /v1/runs：`tool`（实证 `api_server.py:6604-6622` 的 `_callback`）
 * 不归一化的话，新通道下时间线里工具名全是空（实测踩到过：e2e 里
 * `{"preview":"echo hi","status":"ok"}` 就是缺 name 的那个形态）。
 */
function toolNameOf(d: unknown): string {
  const p = d as { tool_name?: unknown; tool?: unknown } | null
  const v = p?.tool_name ?? p?.tool
  return typeof v === 'string' ? v : ''
}

/** 工具预览：新通道 `tool.started` 只给 preview，没有 args */
function toolPreviewOf(d: unknown): string | null {
  const v = (d as { preview?: unknown } | null)?.preview
  return typeof v === 'string' ? v : null
}

/** 工具是否失败：新通道 `tool.completed` 带 `error: true`（旧通道另有 tool.failed 事件） */
function toolErrored(d: unknown): boolean {
  return (d as { error?: unknown } | null)?.error === true
}

/**
 * 事件归约器：**两条通道共用**。差异都在这一个函数里抹平 ——
 *  - 流式打字：stream 叫 `assistant.delta`，runs 叫 `message.delta`
 *  - 思考提示：stream 是伪工具 `tool.progress{tool_name:'_thinking'}`，
 *    runs 是独立事件 `reasoning.available`
 *  - 权威 transcript：stream 在 `run.completed.messages`，runs 没有（靠轮末对账）
 */
function applyEvent(ctx: TurnCtx, name: string, data: unknown): void {
  switch (name) {
    case 'assistant.delta':
    case 'message.delta': {
      const d = (data as SseDelta).delta
      if (d) ctx.asst.content += d
      store.run.phase = 'writing'
      dropResolvedApproval()
      break
    }
    case 'tool.progress':
    case 'reasoning.available': {
      // 实测：思考提示可能在正文已开始输出之后才到，不能把 'writing' 降级回 'thinking'
      const nm = toolNameOf(data)
      if (store.run.phase !== 'writing') {
        const thinking = name === 'reasoning.available' || nm === '_thinking'
        store.run.phase = thinking ? 'thinking' : 'tool'
        store.run.currentTool = thinking ? null : nm
      }
      break
    }
    case 'tool.started': {
      const nm = toolNameOf(data)
      const preview = toolPreviewOf(data)
      dropResolvedApproval()
      store.run.phase = 'tool'
      store.run.currentTool = nm
      store.run.toolPreview = preview
      store.run.timeline.push({
        name: nm,
        preview: preview ?? '',
        status: 'run',
      })
      break
    }
    case 'tool.completed': {
      markToolDone(toolNameOf(data), toolErrored(data) ? 'fail' : 'ok')
      store.run.phase = 'tool'
      dropResolvedApproval()
      break
    }
    case 'tool.failed': {
      markToolDone(toolNameOf(data), 'fail')
      break
    }
    case 'assistant.completed': {
      // 覆盖而非追加：delta 拼接在极端情况下可能丢字/重复（旧通道专有事件）
      const p = data as SseAssistantCompleted
      if (typeof p.content === 'string' && p.content.length > 0) {
        ctx.asst.content = p.content
      }
      break
    }
    case 'approval.request': {
      // 服务端在等人回话：这一轮**卡住不会自己走**（这与旧通道"当场 fail-closed
      // 拒绝"是本质区别 —— 网页端第一次真的能批准/拒绝了）
      const p = data as SseApprovalRequest
      store.run.phase = 'approval'
      store.run.approval = {
        toolName: String(p.tool_name ?? '(未知工具)'),
        command: typeof p.command === 'string' ? p.command : null,
        choices:
          Array.isArray(p.choices) && p.choices.length ? p.choices.map(String) : ['once', 'deny'],
        smartDenied: !!p.smart_denied,
        allowPermanent: p.allow_permanent !== false,
      }
      break
    }
    case 'approval.responded': {
      const live = store.run.approval
      if (live) store.run.approval = { ...live, submitting: false }
      if (store.run.phase === 'approval') store.run.phase = 'tool'
      break
    }
    case 'run.completed': {
      ctx.sawTerminal = true
      const p = data as SseRunCompleted
      ctx.usage = p.usage ?? null
      // 注意：payload.messages 是整轮 transcript（含工具结果），只用来捞"被安全闸门
      // 拦下"的原文，绝不渲染成聊天消息（会与正文重复）。
      // runs 通道没有这个字段 → 由轮末 reconcileTurn() 从会话里捞。
      if (p.messages?.length) store.run.blocked = blockFromMessages(p.messages)
      break
    }
    case 'run.failed': {
      ctx.sawTerminal = true
      ctx.sawError = true
      const m = String((data as { error?: string })?.error || '这一轮失败了')
      ctx.asst.error = m
      store.run.phase = 'error'
      store.run.errorMessage = m
      break
    }
    case 'run.cancelled': {
      ctx.sawTerminal = true
      ctx.cancelled = true
      break
    }
    case 'error': {
      ctx.sawTerminal = true
      ctx.sawError = true
      const m = (data as SseError).message || '未知错误'
      ctx.asst.error = m
      store.run.phase = 'error'
      store.run.errorMessage = m
      break
    }
    case 'run.started':
    case 'message.started':
    case 'run.steered':
    case 'done':
      break
    default:
      // 未知事件忽略（服务端将来新增事件不能让界面崩）
      break
  }
}

/** runs 通道：提交一轮并订流。abort 只断"看"，停服务端要另外 POST /stop。 */
async function runTurn(ctx: TurnCtx, text: string, signal: AbortSignal): Promise<void> {
  const sub = await submitRun(text, ctx.sid)
  ctx.runId = sub.run_id
  store.run.runId = sub.run_id
  // 立刻落记录（v2.2）：run 已经提交给服务端了，从这里开始"页面被冻结/刷新/回收"
  // 都不该让这一轮从界面上消失 —— 下次回到前台靠这条记录把状态要回来。
  writeActiveRun({ sessionId: ctx.sid, runId: sub.run_id, sentText: text, startedAt: Date.now() })
  await runEvents(sub.run_id, (n, d) => applyEvent(ctx, n, d), signal)
}

/** 读会话尾部消息（**不动分页状态** —— 分页只由 openSession / loadEarlier 管） */
async function tailMessages(sid: string, limit = 60): Promise<HermesMessage[] | null> {
  try {
    return (await getMessages(sid, limit, 0)).data
  } catch {
    return null
  }
}

/** 切出"本轮"那一段：最后一条内容等于本次发送文本的 user 消息之后的所有消息。 */
function turnSlice(raw: HermesMessage[], sentText: string): HermesMessage[] {
  const want = sentText.trim()
  let start = -1
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i].role === 'user' && textOf(raw[i]).trim() === want) {
      start = i
      break
    }
  }
  if (start < 0) {
    // 兜底（文本对不上时）：取最后一条 user 之后
    for (let i = raw.length - 1; i >= 0; i--) {
      if (raw[i].role === 'user') {
        start = i
        break
      }
    }
  }
  return start >= 0 ? raw.slice(start + 1) : []
}

/**
 * 轮末对账：用服务端 transcript 校正界面上的本轮。
 * 为什么必须做（runs 通道尤其）：`run.completed` **不带 messages**，而且事件流
 * 一次性、不可重连；只信 SSE 拼接的话，断线那一刻的内容就永久丢了。
 * 返回是否真的拿到了本轮 transcript。
 */
async function reconcileTurn(ctx: TurnCtx, sentText: string): Promise<boolean> {
  const raw = await tailMessages(ctx.sid)
  if (!raw) return false
  const turn = turnSlice(raw, sentText)
  if (!turn.length) return false

  // ① 权威正文：合并本轮所有 assistant 文本。SSE delta 拼接在"中间段落"上不可靠
  //    （工具调用前后的两段），服务端落库的才是权威；顺带抹掉 delta 的前导换行杂质。
  const joined = turn
    .filter((m) => m.role === 'assistant')
    .map(textOf)
    .filter((t) => t.trim())
    .join('\n\n')
  if (joined.trim()) ctx.asst.content = joined

  // ② 安全闸门拦截原文（旧通道靠 run.completed.messages，新通道没这个字段）
  store.run.blocked = blockFromMessages(turn)

  // ③ 工具时间线补齐（断线时 SSE 一个都没收到，但会话里已经落库了）
  if (!store.run.timeline.length) {
    for (const m of turn) {
      if (m.role === 'tool' && m.tool_name) {
        store.run.timeline.push({ name: m.tool_name, preview: '', status: 'ok' })
      }
    }
  }
  return true
}

/** 回话一次审批（界面按钮 → 服务端）。返回错误文案；成功返回 null。 */
export async function respondApproval(choice: ApprovalChoice): Promise<string | null> {
  const runId = store.run.runId
  const cur = store.run.approval
  if (!runId || !cur) return '当前没有等待回话的审批'
  store.run.approval = { ...cur, submitting: true, error: null }
  try {
    await approveRun(runId, choice)
    const live = store.run.approval
    if (live) store.run.approval = { ...live, submitting: false, resolved: choice, error: null }
    return null
  } catch (e) {
    const m = msgOf(e)
    const live = store.run.approval
    if (live) store.run.approval = { ...live, submitting: false, error: m }
    return m
  }
}

/* ============================================================
 * v2.2：浏览器进后台 / 断线后的自动恢复
 *
 * 架构前提（**实测确认，见 docs §10.4**）：
 *   `POST /v1/runs` 只是"提交"，run 由**服务端自己跑完并写进会话**，
 *   没有任何客户端订阅也照跑（实测：无人订阅的 run 24s 后 completed，
 *   正文已落库）。所以"前端连接"与"任务执行"本来就是解耦的 ——
 *   前端要补的只有一件事：**回来时把服务端状态同步成界面状态**。
 *
 * 因此这里**不引入常驻连接管理器/状态机**，只做三件小事：
 *   ① 提交后把 {sessionId, runId, sentText} 记进 sessionStorage（刷新/被回收后靠它找回）
 *   ② 回到前台（visibilitychange/focus/pageshow/online）时问一次 run 状态 → 对账
 *   ③ 服务端还在跑时，按退避间隔（1s→2s→4s→…→30s 封顶）继续问，直到终态
 * 后台 JS 不承担任何"保活"职责（定时器会被 throttle，连接会被系统掐），
 * 所有恢复动作都由"回到前台"这一个事件驱动。
 * ============================================================ */

const ACTIVE_RUN_KEY = 'hcl.activeRun'
/** 记录超过这个时长就当垃圾清掉（服务端也不会保留那么久的 run） */
const ACTIVE_RUN_TTL_MS = 6 * 3600_000

export interface ActiveRunRecord {
  sessionId: string
  runId: string
  /** 本轮发送文本：回读对账时用它切出"本轮那一段" */
  sentText: string
  /** 提交时刻（**墙钟** ms —— 跨页面刷新只能用它） */
  startedAt: number
}

function clearActiveRun(): void {
  try {
    sessionStorage.removeItem(ACTIVE_RUN_KEY)
  } catch {
    /* 隐私模式 / 无 sessionStorage：退化成"仅本页生命周期内有效" */
  }
}

function writeActiveRun(rec: ActiveRunRecord): void {
  try {
    sessionStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify(rec))
  } catch {
    /* 同上：写不进去也不能影响发送 */
  }
}

function readActiveRun(): ActiveRunRecord | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_RUN_KEY)
    if (!raw) return null
    const rec = JSON.parse(raw) as ActiveRunRecord
    if (!rec?.runId || !rec?.sessionId) return null
    if (Date.now() - (rec.startedAt || 0) > ACTIVE_RUN_TTL_MS) {
      clearActiveRun()
      return null
    }
    return rec
  } catch {
    return null
  }
}

/** 服务端状态里哪些算"已经不会再变" */
function isTerminalStatus(s: string): boolean {
  return s === 'completed' || s === 'failed' || s === 'cancelled'
}

let watchTimer = 0
let watchAttempt = 0
let watching: string | null = null
let resyncing = false

function stopWatching(): void {
  if (watchTimer) window.clearTimeout(watchTimer)
  watchTimer = 0
  watchAttempt = 0
  watching = null
}

/**
 * 回读对账（恢复路径专用）：把"被切断的那一轮"用服务端会话记录补回界面。
 * 与 send() 收尾的 reconcileTurn 共用同一套逻辑，只是这里没有 TurnCtx。
 */
async function recoverTurn(sid: string, sentText: string): Promise<boolean> {
  if (sid !== store.currentId) return false
  let asst = [...store.messages].reverse().find((m) => m.role === 'assistant')
  if (!asst) {
    asst = { key: tempKey(), role: 'assistant', content: '' }
    store.messages.push(asst)
  }
  asst.streaming = false
  const ctx: TurnCtx = {
    sid,
    asst,
    runId: null,
    sawTerminal: true,
    cancelled: false,
    sawError: false,
    usage: null,
  }
  return reconcileTurn(ctx, sentText)
}

/**
 * 问一次服务端状态并落到界面。返回 true = 已到终态（不必再轮询）。
 * 幂等：可以反复调用。
 */
async function applyRunStatus(rec: ActiveRunRecord): Promise<boolean> {
  store.run.syncing = true
  let st: RunStatusResponse | null = null
  let gone = false
  try {
    st = await getRun(rec.runId)
  } catch (e) {
    // 404 = 服务端已经没有这个 run 了（超出保留窗口/被清理）；其它错误按"暂时连不上"处理
    if (e instanceof HermesApiError && e.status === 404) gone = true
  } finally {
    store.run.syncing = false
  }

  if (st && !isTerminalStatus(st.status)) {
    // 还在跑（含等人审批）：把界面切成"后台执行中"，并修好计时基准。
    // startedAt 用 performance.now() 的基线算；跨了页面刷新（startedAt=0）时用墙钟换算回去，
    // 这样"已运行 Xs"显示的是从提交那一刻算起的真实时长。
    if (!store.run.startedAt) {
      store.run.startedAt = performance.now() - Math.max(0, Date.now() - rec.startedAt)
    }
    store.run.runId = rec.runId
    store.run.phase = 'background'
    return false
  }

  const wasStreamingHere = store.streaming
  if (st?.status === 'completed') {
    const ok = await recoverTurn(rec.sessionId, rec.sentText)
    if (!ok && typeof st.output === 'string' && st.output.trim()) {
      const asst = [...store.messages].reverse().find((m) => m.role === 'assistant')
      if (asst && !asst.content.trim()) asst.content = st.output
    }
    store.run.phase = 'done'
    store.run.recovered = store.run.recovered || ok
    store.run.endedAt = performance.now()
  } else if (st?.status === 'failed') {
    await recoverTurn(rec.sessionId, rec.sentText)
    const m = String(st.error || '这一轮失败了')
    store.run.phase = 'error'
    store.run.errorMessage = m
    store.run.endedAt = performance.now()
  } else if (st?.status === 'cancelled') {
    store.run.phase = 'aborted'
    store.run.endedAt = performance.now()
  } else {
    // gone（404）或暂时连不上：能对账就先对账（服务端已经写库的内容才是权威）
    const ok = await recoverTurn(rec.sessionId, rec.sentText)
    if (gone) {
      if (ok) {
        store.run.phase = 'done'
        store.run.recovered = true
      } else if (!wasStreamingHere && store.run.phase === 'background') {
        store.run.phase = 'idle'
      }
      store.run.endedAt = performance.now()
    } else {
      // 离线：留着记录，等下一个前台/网络事件再试
      store.run.phase = 'background'
      return false
    }
  }
  clearActiveRun()
  stopWatching()
  return true
}

function scheduleWatch(rec: ActiveRunRecord): void {
  const delay = backoffDelay(watchAttempt)
  watchAttempt += 1
  watchTimer = window.setTimeout(() => {
    watchTimer = 0
    void tickWatch(rec)
  }, delay)
}

async function tickWatch(rec: ActiveRunRecord): Promise<void> {
  if (watching !== rec.runId) return
  // 页面在后台时不空转（定时器本来也会被 throttle）；回到前台时 resumeSync 会重新接手
  if (!isForeground()) return
  const done = await applyRunStatus(rec)
  if (!done && watching === rec.runId) scheduleWatch(rec)
}

/** 开始盯这一轮（服务端还在跑时用） */
function watchRun(rec: ActiveRunRecord): void {
  if (watching !== rec.runId) {
    stopWatching()
    watching = rec.runId
  }
  if (!watchTimer && isForeground()) scheduleWatch(rec)
}

/**
 * 回到前台 / 网络恢复 / 打开会话时调用：把界面与服务端那一轮对齐。
 * 幂等，可任意重复调用（App 挂载、visibilitychange、online、openSession 都会调它）。
 */
export async function resumeSync(): Promise<void> {
  if (resyncing) return
  const rec = readActiveRun()
  if (!rec) return
  // 刷新后还没选会话：留着记录，等 openSession 之后再来同步（别在这里清掉）
  if (!store.currentId) return

  if (store.streaming) {
    // 本页那一轮还"活着"，但可能是个僵尸流（页面冻结期间 socket 已死、promise 永不 settle）。
    // 用服务端状态判定：已终态就主动掐断本地流，让 send() 的收尾逻辑跑起来（对账 + 标完成）。
    const st = await getRun(rec.runId).catch(() => null)
    if (st && isTerminalStatus(st.status)) abortCtl?.abort()
    else if (st && !isTerminalStatus(st.status)) watchRun(rec)
    return
  }

  resyncing = true
  try {
    const done = await applyRunStatus(rec)
    if (!done) watchRun(rec)
  } finally {
    resyncing = false
  }
}

export function stop(): void {
  // 后台执行中（background）也能停：这时本地没有 abortCtl（send() 早已收尾），
  // run_id 从 sessionStorage 的记录里取 —— 用户的"停止"在任何状态下都必须有效。
  const runId = store.run.runId ?? readActiveRun()?.runId ?? null
  if (sendTransport() === 'runs' && runId) {
    // runs 通道下"断开连接"≠"停止"：断流后服务端那一轮还在跑，必须显式停。
    // 服务端随后会发 run.cancelled（流没断的话界面能看到）。
    void stopRun(runId).catch(() => {
      /* 已结束/不存在都无所谓，最终状态以轮末对账为准 */
    })
  }
  stopRequested = true
  clearActiveRun()
  stopWatching()
  if (!store.streaming && store.run.phase === 'background') {
    store.run.phase = 'aborted'
    store.run.endedAt = performance.now()
  }
  abortCtl?.abort()
}

/** 从整轮 transcript 里找出第一条"被安全闸门拦下"的工具结果。 */
function blockFromMessages(messages?: HermesMessage[]): SecurityBlock | null {
  for (const m of messages ?? []) {
    const c = m.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? JSON.stringify(c) : ''
    const hit = securityBlock(text)
    if (hit) return hit
  }
  return null
}

function resetRun(): void {
  store.run.phase = 'thinking'
  store.run.startedAt = performance.now()
  store.run.endedAt = 0
  store.run.currentTool = null
  store.run.toolPreview = null
  store.run.timeline = []
  store.run.errorMessage = null
  store.run.blocked = null
  store.run.runId = null
  store.run.approval = null
  store.run.recovered = false
}

function markToolDone(name: string, status: 'ok' | 'fail'): void {
  for (let i = store.run.timeline.length - 1; i >= 0; i--) {
    const step = store.run.timeline[i]
    if (step.name === name && step.status === 'run') {
      step.status = status
      break
    }
  }
  store.run.currentTool = null
  store.run.toolPreview = null
}

export async function send(text: string): Promise<void> {
  const content = text.trim()
  // background = 上一轮还在服务端跑着（v2.2）：不能开第二轮，先等它结束或点停止
  if (!content || store.streaming || store.run.phase === 'background') return

  if (!store.currentId) {
    const id = await newChat()
    if (!id) {
      // 建会话失败（常见：反代没注入 key → 401）。必须让用户看见，不能静默返回。
      store.bootError = store.bootError ?? '无法创建会话'
      return
    }
  }
  const sid = store.currentId as string

  // 本轮开始前的累计计数基线（用于算本轮缓存命中）
  const before = await counters(sid)

  // 乐观插入：用户消息 + 助手空占位
  store.messages.push({ key: tempKey(), role: 'user', content })
  store.messages.push({ key: tempKey(), role: 'assistant', content: '', streaming: true })
  const asst = store.messages[store.messages.length - 1]

  store.streaming = true
  store.bootError = null
  stopRequested = false
  resetRun()
  abortCtl = new AbortController()

  /** 本轮上下文：两条通道共用（事件归约 + 收尾都要它） */
  const ctx: TurnCtx = {
    sid,
    asst,
    runId: null,
    sawTerminal: false,
    cancelled: false,
    sawError: false,
    usage: null,
  }

  try {
    if (sendTransport() === 'runs') {
      await runTurn(ctx, content, abortCtl.signal)
    } else {
      await streamChat(sid, content, (name, data) => applyEvent(ctx, name, data), abortCtl.signal)
    }
  } catch (e) {
    if (isAbortError(e)) {
      // 用户主动停止 —— 保留已渲染内容，phase 在 finally 里判定为 aborted
    } else {
      asst.error = msgOf(e)
      store.run.phase = 'error'
      store.run.errorMessage = asst.error
      ctx.sawError = true
    }
  } finally {
    // 事件流是"没收到终止事件就结束了"吗？（runs 通道的流一次性、不可重连，
    // 断线后拿不到任何补偿 → 只能靠下面的回读对账）
    const streamLost = !ctx.sawTerminal

    asst.streaming = false
    store.streaming = false
    abortCtl = null
    store.run.approval = null
    store.run.currentTool = null
    store.run.toolPreview = null

    // runs 通道：再去问一次这个 run 的终态。比"猜"可靠，也让"流断了但服务端跑完了"
    // 这种情况能正确显示成完成而不是中断。
    //
    // v2.2 补充：问不到"终态"有两种情况，都不能标成"中断" ——
    //   ① 服务端还在跑（running/queued/waiting_for_approval）→ 界面转 background，
    //      由 resumeSync/轮询把结果补回来（这正是手机切后台的常态）
    //   ② 状态接口也连不上（离线）→ 同样转 background 并留记录，回前台再同步
    let stillRunning = false
    if (sendTransport() === 'runs' && ctx.runId && !ctx.sawTerminal) {
      const st = await getRun(ctx.runId).catch(() => null)
      if (st) {
        if (st.status === 'completed') {
          ctx.sawTerminal = true
          if (!asst.content && typeof st.output === 'string') asst.content = st.output
          ctx.usage = st.usage ?? ctx.usage
        } else if (st.status === 'failed') {
          ctx.sawTerminal = true
          ctx.sawError = true
          const m = String(st.error || '这一轮失败了')
          asst.error = m
          store.run.errorMessage = m
        } else if (st.status === 'cancelled') {
          ctx.sawTerminal = true
          ctx.cancelled = true
        } else {
          stillRunning = true // running / queued / waiting_for_approval
        }
      } else if (!stopRequested) {
        stillRunning = true
      }
    }

    // 轮末对账：以服务端落库的 transcript 为准，校正正文 / 安全闸门原文 / 工具时间线。
    // 两条通道都做（成本就是一次 GET；拿不到就保留 SSE 的结果）。
    const reconciled = await reconcileTurn(ctx, content)
    store.run.recovered = streamLost && reconciled

    if (!ctx.sawError) {
      // 显式完成态判定：只有收到【完成类】终止事件才算真正完成；
      // 被服务端取消（run.cancelled）或用户点过停止 → 一律算中断。
      store.run.phase = ctx.cancelled || stopRequested || !ctx.sawTerminal ? 'aborted' : 'done'
    }

    if (stillRunning && !stopRequested) {
      // ★ 服务端那一轮还在跑：界面必须如实说"还在后台执行"，而不是"中断"。
      //   轮询交给 v2.2 的 watchRun（退避 1s→30s 封顶），回到前台会立刻再同步一次。
      //
      //   顺带把"断流"当成错误留下的痕迹抹掉：连接断 ≠ 这一轮失败，红字会骗人。
      asst.error = null
      store.run.errorMessage = null
      ctx.sawError = false
      store.run.phase = 'background'
      const rec = readActiveRun()
      if (rec) watchRun(rec)
    } else {
      clearActiveRun()
    }
    if (store.run.phase !== 'background') store.run.endedAt = performance.now()

    if (ctx.sawTerminal && !ctx.sawError && !ctx.cancelled) {
      // 每轮统计：耗时 / 输入 / 输出 / 缓存命中率（取本轮结束后的累计计数做差）
      const after = await counters(sid)
      asst.stats = buildStats({
        ms: store.run.endedAt - store.run.startedAt,
        usage: ctx.usage,
        before,
        after,
      })
    }

    // 新会话首轮结束后 Hermes 才会生成标题，刷新侧栏才能看到
    void loadSessions()
  }
}

interface Counters {
  input: number
  cache: number
}

/** 读会话累计计数；失败返回 null（此时不显示缓存率，耗时与 token 照常显示） */
async function counters(id: string): Promise<Counters | null> {
  try {
    const s = (await getSession(id)).session
    return { input: s.input_tokens ?? 0, cache: s.cache_read_tokens ?? 0 }
  } catch {
    return null
  }
}

function buildStats(args: {
  ms: number
  usage: HermesUsage | null
  before: Counters | null
  after: Counters | null
}): TurnStats {
  const { ms, usage, before, after } = args
  let uncachedInput = 0
  let cacheRead = 0
  let cacheRate: number | null = null
  if (before && after) {
    uncachedInput = Math.max(0, after.input - before.input)
    cacheRead = Math.max(0, after.cache - before.cache)
    const total = uncachedInput + cacheRead
    cacheRate = total > 0 ? cacheRead / total : null
  }
  const usageIn = Number(usage?.input_tokens ?? 0)
  const usageOut = Number(usage?.output_tokens ?? 0)
  return {
    ms,
    inputTokens: usageIn > 0 ? usageIn : uncachedInput + cacheRead,
    outputTokens: usageOut > 0 ? usageOut : 0,
    uncachedInput,
    cacheRead,
    cacheRate,
  }
}
