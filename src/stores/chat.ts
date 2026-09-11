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
  getMessages,
  getSessions,
  health,
  HermesApiError,
  streamChat,
} from '../api/hermes'
import type {
  HermesMessage,
  HermesSession,
  SseAssistantCompleted,
  SseDelta,
  SseError,
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
 * 历史消息过滤（设计文档 3.3 / 12 章）：
 *  1. 丢掉非 user/assistant（tool / system / 压缩摘要）
 *  2. 丢掉 content 为空的 assistant（那是工具调用轮，界面不该出现空泡泡）
 *  3. content 为数组时取 text 片段拼接
 */
export function normalize(raw: HermesMessage[]): UiMessage[] {
  const out: UiMessage[] = []
  for (const m of raw) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = textOf(m)
    if (!text.trim()) continue
    out.push({ key: `h_${m.id}`, role: m.role, content: text })
  }
  return out
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
    const res = await getSessions(50)
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
  try {
    const res = await getMessages(id, 100)
    store.messages = normalize(res.data)
  } catch (e) {
    store.messages = []
    store.bootError = msgOf(e)
  } finally {
    store.messagesLoading = false
  }
}

/** 新建空会话（不传 title：标题有唯一约束，重名会被拒） */
export async function newChat(): Promise<string | null> {
  try {
    const res = await createSession()
    store.currentId = res.session.id
    store.messages = []
    store.bootError = null
    store.run.phase = 'idle'
    store.run.timeline = []
    return res.session.id
  } catch (e) {
    store.bootError = msgOf(e)
    return null
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
    // 新会话首轮结束后 Hermes 才会生成标题，刷新侧栏才能看到
    void loadSessions()
  }
}
