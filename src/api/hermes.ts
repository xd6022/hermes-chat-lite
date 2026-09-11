/**
 * Hermes API 封装（唯一允许发请求的地方；组件禁止直接 fetch）。
 *
 * 鉴权：生产环境由 nginx 在反代层注入 Authorization 头，前端不持有 key。
 *      开发环境由 vite.config.ts 的 dev proxy 注入。
 *      所以这里**不设置** Authorization，也不配置 baseURL（同源）。
 */

import { postSse, type SseHandler } from './sse'
import type {
  CreateSessionResponse,
  HealthResponse,
  MessageListResponse,
  SessionListResponse,
} from './types'

export class HermesApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'HermesApiError'
    this.status = status
    this.code = code
  }
}

async function readErrorMessage(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const data = await res.json()
    const err = data?.error
    if (err && typeof err === 'object') {
      return { message: String(err.message ?? res.statusText), code: err.code }
    }
    if (typeof data?.message === 'string') return { message: data.message }
    if (typeof data?.detail === 'string') return { message: data.detail }
  } catch {
    /* 非 JSON */
  }
  return { message: res.statusText || `HTTP ${res.status}` }
}

function friendly(status: number, message: string): string {
  if (status === 401) return '接口密钥无效或未注入（检查反代是否注入 Authorization 头）'
  if (status === 403) {
    // 实测：Hermes 的 CORS 中间件对任何带 Origin 的请求返回 403 空响应
    return '请求被 Hermes 的 CORS 防护拒绝（403）：浏览器必带 Origin 头，反代必须清掉它（nginx: proxy_set_header Origin ""）'
  }
  if (status === 404) return '会话不存在（可能已被删除）'
  if (status === 409) return '会话已存在，请新建会话'
  if (status === 503) return 'Hermes 会话数据库不可用'
  return message
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const { message, code } = await readErrorMessage(res)
    throw new HermesApiError(res.status, friendly(res.status, message), code)
  }
  return (await res.json()) as T
}

/** 会话列表。默认取最近 50 条（服务端上限 200）。 */
export function getSessions(limit = 50): Promise<SessionListResponse> {
  return request<SessionListResponse>(`/api/sessions?limit=${limit}&offset=0`)
}

/** 新建空会话。不要传 title —— 标题有唯一约束，重名会被 400 拒绝并回滚。 */
export function createSession(): Promise<CreateSessionResponse> {
  return request<CreateSessionResponse>('/api/sessions', { method: 'POST', body: '{}' })
}

/** 历史消息。order=latest 返回最近 N 条（内部仍按时间正序）。 */
export function getMessages(sessionId: string, limit = 100): Promise<MessageListResponse> {
  const q = new URLSearchParams({ order: 'latest', limit: String(limit), offset: '0' })
  return request<MessageListResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages?${q.toString()}`,
  )
}

/** 健康检查（Settings 面板的连接状态用）。 */
export function health(): Promise<HealthResponse> {
  return request<HealthResponse>('/health')
}

/**
 * 发送一条消息并流式接收回复。
 * 使用 Hermes 原生端点（不是 OpenAI 兼容的 /v1/chat/completions），
 * 这样能拿到 tool.started / tool.completed / run.completed 等一等事件。
 */
export function streamChat(
  sessionId: string,
  message: string,
  onEvent: SseHandler,
  signal?: AbortSignal,
): Promise<void> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`
  return postSse(url, { message }, onEvent, signal)
}
