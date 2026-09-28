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

// ---- 邮件（读缓存表 `inbox_emails`；2026-09-28 起不再实时连 IMAP）----------
//
// 口径（用户 2026-09-28 拍板，反转 09-24 的"打开实时读邮箱"）：
//  - 缓存由「定时拉取（交易日 9–15 每整点）+ 页面刷新按钮」写入，页面**只读缓存** ⇒ 打开瞬时、离线可读；
//  - **只读**：没有已读/归档动作 —— 邮箱状态一概不动（服务端 IMAP 一律 readonly）；
//  - 邮件未读**不计入顶栏徽标**（徽标只数通知），所以邮件图标上不带数字；
//  - 正文是服务端去标签后的纯文本（邮件 HTML 绝不注入前端）。

export interface CachedEmail {
  id: number
  message_id: string
  uid: string
  subject: string
  from_name: string
  from_addr: string
  to_addr: string
  /** 邮件头 Date（北京时间，带 +08:00） */
  occurred_at: string
  excerpt: string
  body_len: number
  attachment_count: number
  /** 这封最近一次从 IMAP 拉到的时刻（缓存新鲜度） */
  fetched_at: string
}

export interface CachedEmailDetail extends CachedEmail {
  body: string
}

export interface CachedEmailList {
  days: number
  count: number
  /** 整张缓存表最近一次拉取时刻（空缓存 = null） */
  fetched_at: string | null
  cached_total: number
  messages: CachedEmail[]
}

export interface EmailRefreshResult {
  days: number
  pulled: number
  inserted: number
  updated: number
  fetched_at: string
  sender: string
}

/** 读缓存（**不连 IMAP**，瞬时返回）。`days` 是显示窗口：1=今天、3=今天+前两天 */
export function listCachedEmails(opts: { days?: number; limit?: number } = {}): Promise<CachedEmailList> {
  const q = new URLSearchParams()
  q.set('days', String(opts.days ?? 1))
  q.set('limit', String(opts.limit ?? 50))
  return call<CachedEmailList>(`/inbox/email/cache?${q.toString()}`)
}

export function getCachedEmail(id: number): Promise<CachedEmailDetail> {
  return call<CachedEmailDetail>(`/inbox/email/cache/${id}`)
}

/** 刷新 = 让服务端实时连一次 IMAP 并写缓存（只读）。**全项目唯一会碰 IMAP 的调用**
 *
 * `days` 用缓存窗口（7 天）而不是当前显示档位：一次拉够，之后切 1/3/7 档就只是读缓存、不再连邮箱。
 */
export function refreshEmails(opts: { days?: number; limit?: number } = {}): Promise<EmailRefreshResult> {
  const q = new URLSearchParams()
  q.set('days', String(opts.days ?? 7))
  q.set('limit', String(opts.limit ?? 50))
  return call<EmailRefreshResult>(`/inbox/email/refresh?${q.toString()}`, { method: 'POST' })
}
