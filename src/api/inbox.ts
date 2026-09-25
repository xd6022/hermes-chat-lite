/**
 * 消息中心（inbox）的 API 封装。
 *
 * 与 `hermes.ts` 一样：**组件禁止直接 fetch**，一律走这里。
 * 路径前缀是 `/inbox/...`（不是 `/api/inbox/...`）—— `/api` 那条反代会把请求抢去 Hermes API Server，
 * 而那边没有这个路由（已在 nginx.conf 里写明这个坑）。
 * 鉴权：nginx 在反代层注入 `X-Inbox-Token`，前端产物里没有任何密钥。
 */

export interface InboxMessage {
  id: number
  source: string
  category: string
  level: string
  title: string
  occurred_at: string
  read: boolean
  archived: boolean
  /** 列表只给摘要（默认 200 字），全文走 getMessage */
  excerpt: string
  body_len: number
}

export interface InboxMessageDetail extends Omit<InboxMessage, 'excerpt' | 'body_len'> {
  body: string
  body_len: number
}

export interface InboxListResponse {
  unread_count: number
  messages: InboxMessage[]
}

export class InboxApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'InboxApiError'
    this.status = status
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch {
    // 网络层失败（离线、反代挂了、容器没起来）
    throw new InboxApiError('连不上消息服务（检查 chatlite-inbox 容器是否在跑）', 0)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const data = await res.json()
      if (typeof data?.detail === 'string') detail = data.detail
      else if (typeof data?.message === 'string') detail = data.message
    } catch {
      /* 非 JSON（例如 nginx 的 502 页面） */
    }
    if (res.status === 401) throw new InboxApiError('消息服务未授权（反代没注入 X-Inbox-Token？）', 401)
    if (res.status === 503) throw new InboxApiError(detail || '消息服务暂时不可用', 503)
    throw new InboxApiError(detail || `消息服务返回 HTTP ${res.status}`, res.status)
  }
  return (await res.json()) as T
}

export interface ListOptions {
  /** ASCII 代码（stock/email/alert/system）；`all` 或不传 = 全部 */
  category?: string
  unreadOnly?: boolean
  includeArchived?: boolean
  limit?: number
  beforeId?: number
  /** 起始时间（带本地偏移的 ISO，如 `2026-09-22T00:00:00+08:00`）；不传 = 不限 */
  since?: string | null
}

export function listMessages(opts: ListOptions = {}): Promise<InboxListResponse> {
  const q = new URLSearchParams()
  if (opts.category && opts.category !== 'all') q.set('category', opts.category)
  if (opts.unreadOnly) q.set('unread', '1')
  if (opts.includeArchived) q.set('include_archived', '1')
  // ⚠️ since 必须走 URLSearchParams：里面的 `+` 手工拼进查询串会被解析成空格 ⇒ 服务端 400
  if (opts.since) q.set('since', opts.since)
  q.set('limit', String(opts.limit ?? 50))
  if (opts.beforeId) q.set('before_id', String(opts.beforeId))
  return call<InboxListResponse>(`/inbox/messages?${q.toString()}`)
}

export function getMessage(id: number): Promise<InboxMessageDetail> {
  return call<InboxMessageDetail>(`/inbox/messages/${id}`)
}

export function getUnreadCount(since?: string | null): Promise<{ unread_count: number }> {
  const q = new URLSearchParams()
  if (since) q.set('since', since)
  const qs = q.toString()
  return call<{ unread_count: number }>(`/inbox/unread-count${qs ? `?${qs}` : ''}`)
}

export function markRead(id: number, read = true): Promise<{ ok: boolean; unread_count: number }> {
  return call(`/inbox/messages/${id}/read?read=${read ? 1 : 0}`, { method: 'POST' })
}

export function markAllRead(category?: string): Promise<{ ok: boolean; updated: number; unread_count: number }> {
  const q = category && category !== 'all' ? `?category=${encodeURIComponent(category)}` : ''
  return call(`/inbox/messages/read-all${q}`, { method: 'POST' })
}

export function archiveMessage(id: number, archived = true): Promise<{ ok: boolean; unread_count: number }> {
  return call(`/inbox/messages/${id}/archive?archived=${archived ? 1 : 0}`, { method: 'POST' })
}

// ---- 邮件（实时直读邮箱，**不落库**；口径见后端 inbox/mail.py）------------
//
// 与通知的区别（用户 2026-09-24 定调）：
//  - 邮件**不进消息表**，每次打开「邮件」tab 实时从邮箱拉 ⇒ 同一封邮件只有邮箱一份；
//  - **只读**：没有"已读/归档"这类动作接口（碰邮箱状态是另一回事，明确不做）；
//  - 范围 = 整个收件箱（后续可收窄）；附件不展示，只在详情提示有几个。

export interface InboxEmail {
  /** IMAP UID（字符串；详情接口要原样传回） */
  uid: string
  subject: string
  from_name: string
  from_addr: string
  to_addr: string
  /** 邮件头 Date 转北京时间，带 +08:00 */
  occurred_at: string
  excerpt: string
  body_len: number
  attachment_count: number
  unread: boolean
}

export interface InboxEmailDetail extends InboxEmail {
  /** 纯文本正文（服务端已把 HTML 退化成去标签文本，前端不注入邮件 HTML） */
  body: string
  attachments: string[]
}

export interface EmailListResponse {
  days: number
  limit: number
  /** 这一屏里的未读封数（只读统计，不改邮箱状态） */
  unread_count: number
  messages: InboxEmail[]
}

export interface EmailListOptions {
  /** 最近几天（按邮件 Date），后端上限 90 */
  days?: number
  /** 最多几封，后端上限 100 */
  limit?: number
  unreadOnly?: boolean
}

export function listEmails(opts: EmailListOptions = {}): Promise<EmailListResponse> {
  const q = new URLSearchParams()
  q.set('days', String(opts.days ?? 3))
  q.set('limit', String(opts.limit ?? 30))
  if (opts.unreadOnly) q.set('unread', '1')
  return call<EmailListResponse>(`/inbox/email/messages?${q.toString()}`)
}

export function getEmail(uid: string): Promise<InboxEmailDetail> {
  return call<InboxEmailDetail>(`/inbox/email/messages/${encodeURIComponent(uid)}`)
}
