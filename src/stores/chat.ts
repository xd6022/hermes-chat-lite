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
import { isCompactionNote } from '../lib/messages'
import type {
  HermesMessage,
  HermesSession,
  HermesUsage,
  SseAssistantCompleted,
  SseDelta,
  SseError,
  SseRunCompleted,
  SseToolLifecycle,
  SseToolProgress,
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

export type RunPhase = 'idle' | 'thinking' | 'tool' | 'writing' | 'done' | 'aborted' | 'error'

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
 */
export async function removeSession(id: string): Promise<string | null> {
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
    return null
  } catch (e) {
    return msgOf(e)
  }
}

export function stop(): void {
  abortCtl?.abort()
}

function resetRun(): void {
  store.run.phase = 'thinking'
  store.run.startedAt = performance.now()
  store.run.endedAt = 0
  store.run.currentTool = null
  store.run.toolPreview = null
  store.run.timeline = []
  store.run.errorMessage = null
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
  if (!content || store.streaming) return

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
  resetRun()
  abortCtl = new AbortController()

  let sawRunCompleted = false
  let sawError = false
  let turnUsage: HermesUsage | null = null

  try {
    await streamChat(
      sid,
      content,
      (name, data) => {
        switch (name) {
          case 'assistant.delta': {
            const d = (data as SseDelta).delta
            if (d) asst.content += d
            store.run.phase = 'writing'
            break
          }
          case 'tool.progress': {
            // 模型思考时服务端用 tool_name === '_thinking' 表示（不是工具！）
            // 实测：tool.progress 可能在正文已开始输出之后才到（reasoning.available 晚到），
            // 所以不能让它把 'writing' 降级回 'thinking'。
            const p = data as SseToolProgress
            if (store.run.phase !== 'writing') {
              store.run.phase = p.tool_name === '_thinking' ? 'thinking' : 'tool'
              store.run.currentTool = p.tool_name === '_thinking' ? null : p.tool_name
            }
            break
          }
          case 'tool.started': {
            const p = data as SseToolLifecycle
            store.run.phase = 'tool'
            store.run.currentTool = p.tool_name
            store.run.toolPreview = p.preview ?? null
            store.run.timeline.push({
              name: p.tool_name,
              preview: p.preview ?? '',
              status: 'run',
            })
            break
          }
          case 'tool.completed': {
            markToolDone((data as SseToolLifecycle).tool_name, 'ok')
            store.run.phase = 'tool'
            break
          }
          case 'tool.failed': {
            markToolDone((data as SseToolLifecycle).tool_name, 'fail')
            break
          }
          case 'assistant.completed': {
            // 覆盖而非追加：delta 拼接在极端情况下可能丢字/重复
            const p = data as SseAssistantCompleted
            if (typeof p.content === 'string' && p.content.length > 0) {
              asst.content = p.content
            }
            break
          }
          case 'run.completed': {
            // 注意：payload.messages 是整轮 transcript（含工具结果），只用于回填时间线，
            // 绝不渲染成聊天消息（会与正文重复）。
            sawRunCompleted = true
            turnUsage = (data as SseRunCompleted).usage ?? null
            break
          }
          case 'error': {
            sawError = true
            const m = (data as SseError).message || '未知错误'
            asst.error = m
            store.run.phase = 'error'
            store.run.errorMessage = m
            break
          }
          default:
            // run.started / message.started / done 等无需额外处理
            break
        }
      },
      abortCtl.signal,
    )
  } catch (e) {
    if (isAbortError(e)) {
      // 用户主动停止 —— 保留已渲染内容，phase 在 finally 里判定为 aborted
    } else {
      asst.error = msgOf(e)
      store.run.phase = 'error'
      store.run.errorMessage = asst.error
    }
  } finally {
    asst.streaming = false
    store.streaming = false
    abortCtl = null
    if (!sawError) {
      // 显式完成态判定：只有收到 run.completed 才算真正完成
      store.run.phase = sawRunCompleted ? 'done' : 'aborted'
    }
    store.run.endedAt = performance.now()
    store.run.currentTool = null
    store.run.toolPreview = null

    if (sawRunCompleted) {
      // 每轮统计：耗时 / 输入 / 输出 / 缓存命中率（取本轮结束后的累计计数做差）
      const after = await counters(sid)
      asst.stats = buildStats({
        ms: store.run.endedAt - store.run.startedAt,
        usage: turnUsage,
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
