/**
 * 与 Hermes API Server 返回结构一一对应的类型。
 * 字段依据 2026-09-11 实测（api_server.py 的 _session_response / _message_response 白名单）。
 */

/** GET /api/sessions 的 data[] 元素 */
export interface HermesSession {
  id: string
  source: string // 'tui' | 'api_server' | 'telegram' | ...
  user_id?: string | null
  model?: string | null
  title?: string | null
  started_at: number // Unix 秒（float）
  ended_at?: number | null
  end_reason?: string | null
  last_active: number // Unix 秒，列表按此倒序
  message_count?: number
  // 累计计数（注意：都是【会话累计】，要算每轮必须做差）
  input_tokens?: number // 累计【未命中缓存】的输入
  output_tokens?: number
  cache_read_tokens?: number // 累计【命中缓存】的输入
  cache_write_tokens?: number
  api_call_count?: number
  preview?: string | null
  parent_session_id?: string | null
  pinned?: boolean
  archived?: boolean
  hidden?: boolean
  has_system_prompt?: boolean
  has_model_config?: boolean
}

/** content 可能是字符串，也可能是多模态数组 */
export type HermesContent =
  | string
  | null
  | Array<{ type?: string; text?: string; [k: string]: unknown }>

/** GET /api/sessions/{id}/messages 的 data[] 元素 */
export interface HermesMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'tool' | 'system' | string
  content: HermesContent
  tool_call_id?: string | null
  tool_calls?: unknown[] | null
  tool_name?: string | null
  timestamp: number // Unix 秒
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
}

export interface SessionListResponse {
  object: 'list'
  data: HermesSession[]
  limit: number
  offset: number
  has_more: boolean
}

export interface MessageListResponse {
  object: 'list'
  session_id: string
  data: HermesMessage[]
  pagination: { limit: number; offset: number; order: string; returned: number }
}

export interface SessionResponse {
  object: 'hermes.session'
  session: HermesSession
}

/**
 * run.completed 的 usage（实测：**每轮**值，不是会话累计）。
 * 口径核对：usage.input_tokens = 本轮总输入 = 未命中Δ + 缓存命中Δ
 */
export interface HermesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  runtime?: Record<string, unknown>
}

export interface CreateSessionResponse {
  object: 'hermes.session'
  session: HermesSession
}

export interface HealthResponse {
  status: string
  platform?: string
  version?: string
}

/* ---------- SSE 事件载荷（原生 /api/sessions/{id}/chat/stream） ---------- */

export interface SseBase {
  session_id?: string
  run_id?: string
  seq?: number
  ts?: number
}

export interface SseRunStarted extends SseBase {
  user_message?: { role: string; content: unknown }
}
export interface SseMessageStarted extends SseBase {
  message?: { id: string; role: string }
}
export interface SseDelta extends SseBase {
  message_id?: string
  delta: string
}
export interface SseToolProgress extends SseBase {
  message_id?: string
  /** 模型思考时为 '_thinking' */
  tool_name: string
  delta?: string
}
export interface SseToolLifecycle extends SseBase {
  message_id?: string
  tool_name: string
  preview?: string | null
  args?: Record<string, unknown> | null
}
export interface SseAssistantCompleted extends SseBase {
  message_id?: string
  content: string
  completed?: boolean
  partial?: boolean
  interrupted?: boolean
}
export interface SseRunCompleted extends SseBase {
  message_id?: string
  messages?: HermesMessage[]
  usage?: HermesUsage
}
export interface SseError extends SseBase {
  message: string
}
