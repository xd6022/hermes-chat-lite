/**
 * 邮件 store（v3.3，2026-09-28）：**读缓存**（inbox_emails）+ 手动刷新。
 *
 * 锁住的（每条都对应一个真实会咬人的行为）：
 *  1. 打开就**读缓存**、默认 **1 天**、`limit=50`（且**不碰** IMAP）；
 *  2. 切档位只重读缓存，**绝不连邮箱**（刷新已按 7 天拉够）；
 *  3. ★ **只有 refreshEmails 会连邮箱**：`POST /inbox/email/refresh?days=7`，然后重读缓存（顺序固定）；
 *  4. 读缓存/刷新失败：给**人话错误**、**保留上一次的列表**（清空会让人以为"没邮件"）、`retryEmails` 能恢复；
 *  5. ★ **只读**：展开只发 GET，除了刷新那个 POST 之外没有任何写请求；
 *  6. 邮件**不参与消息轮询**：`stores/inbox.ts` 的 `pollInbox()` 不许碰 `/inbox/email*`
 *     （用户 2026-09-28 的口径：邮件的实时性由"看"和"刷新"决定，不进 5 分钟轮询）；
 *  7. 邮件未读**不写进徽标**：`inbox.unread` 仍只数通知。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as InboxStore from './inbox'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let mode: 'ok' | 'fail' = 'ok'
let calls: string[] = []

function row(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    message_id: '<abc@163.com>',
    uid: '1315301460',
    subject: '📊 早盘简报 2026-09-28',
    from_name: 'Hermes',
    from_addr: 'xd602201@163.com',
    to_addr: 'xd6022@163.com',
    occurred_at: '2026-09-28T08:33:00+08:00',
    excerpt: '摘要一行',
    body_len: 7283,
    attachment_count: 0,
    fetched_at: '2026-09-28T20:12:14+08:00',
    ...over,
  }
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (mode === 'fail') throw new TypeError('Failed to fetch')
      if (url.startsWith('/inbox/email/refresh')) {
        return json({ days: 7, pulled: 48, inserted: 48, updated: 0, fetched_at: '2026-09-28T20:12:14+08:00', sender: 'xd602201@163.com' })
      }
      if (url.startsWith('/inbox/email/cache/')) {
        return json({ ...row(), body: '正文全文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |' })
      }
      if (url.startsWith('/inbox/email/cache?')) {
        return json({ days: 1, count: 1, fetched_at: '2026-09-28T20:12:14+08:00', cached_total: 48, messages: [row()] })
      }
      if (url.startsWith('/inbox/unread-count')) return json({ unread_count: 2 })
      if (url.startsWith('/inbox/messages')) return json({ unread_count: 2, messages: [] })
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
}

async function fresh(): Promise<typeof import('./email')> {
  vi.resetModules()
  return await import('./email')
}

beforeEach(() => {
  mode = 'ok'
  calls = []
  stubFetch()
})

describe('邮件：默认与拉取口径', () => {
  it('默认档位 = 1 天，档位数组 = [1,3,7]', async () => {
    const s = await fresh()
    expect(s.DEFAULT_EMAIL_DAYS).toBe(1)
    expect([...s.EMAIL_DAY_OPTIONS]).toEqual([1, 3, 7])
    expect(s.email.days).toBe(1)
  })

  it('loadEmails 读缓存：days=1&limit=50，且**不**碰 IMAP', async () => {
    const s = await fresh()
    expect(calls).toHaveLength(0) // 导入不自动拉
    await s.loadEmails()
    expect(calls).toEqual(['GET /inbox/email/cache?days=1&limit=50'])
    expect(s.email.rows).toHaveLength(1)
    expect(s.email.cachedTotal).toBe(48)
    expect(s.email.lastFetchedAt).toBe('2026-09-28T20:12:14+08:00')
    expect(s.email.error).toBe('')
  })

  it('切档位只重读缓存、不连邮箱', async () => {
    const s = await fresh()
    await s.loadEmails()
    await s.setEmailDays(7)
    expect(calls.filter((c) => c.includes('/inbox/email/refresh'))).toHaveLength(0)
    expect(calls.at(-1)).toBe('GET /inbox/email/cache?days=7&limit=50')
  })
})

describe('邮件：刷新（唯一会碰 IMAP 的动作）', () => {
  it('refreshEmails → POST refresh?days=7 然后重读缓存（顺序固定）', async () => {
    const s = await fresh()
    await s.refreshEmails()
    const emailCalls = calls.filter((c) => c.includes('/inbox/email'))
    expect(emailCalls).toEqual([
      'POST /inbox/email/refresh?days=7&limit=50',
      'GET /inbox/email/cache?days=1&limit=50',
    ])
    expect(s.email.refreshing).toBe(false)
  })

  it('★ 只读：除刷新那个 POST 外没有任何写请求', async () => {
    const s = await fresh()
    await s.loadEmails()
    await s.toggleEmailDetail(7)
    const writes = calls.filter((c) => /^(POST|PUT|PATCH|DELETE) /.test(c))
    expect(writes).toHaveLength(0)
    expect(calls.at(-1)).toBe('GET /inbox/email/cache/7')
    expect(s.email.detail?.body).toContain('正文全文')
  })
})

describe('邮件：失败降级', () => {
  it('读缓存失败：人话错误 + 保留旧列表 + retry 恢复', async () => {
    const s = await fresh()
    await s.loadEmails()
    expect(s.email.rows).toHaveLength(1)
    mode = 'fail'
    await s.loadEmails()
    expect(s.email.error).toContain('连不上消息服务')
    expect(s.email.rows).toHaveLength(1) // ★ 旧列表不能被清空
    mode = 'ok'
    await s.retryEmails()
    expect(s.email.error).toBe('')
    expect(s.email.rows).toHaveLength(1)
  })

  it('刷新失败也保留旧列表并报错（不是静默）', async () => {
    const s = await fresh()
    await s.loadEmails()
    mode = 'fail'
    await s.refreshEmails()
    expect(s.email.error).not.toBe('')
    expect(s.email.rows).toHaveLength(1)
  })
})

describe('邮件与消息中心相互独立', () => {
  it('消息轮询不许碰邮件接口', async () => {
    const s = await fresh()
    await s.loadEmails()
    calls = []
    const inbox = (await import('./inbox')) as typeof InboxStore
    await inbox.pollInbox()
    expect(calls.filter((c) => c.includes('/inbox/email'))).toHaveLength(0)
  })

  it('邮件未读不写进徽标（inbox.unread 只数通知）', async () => {
    const s = await fresh()
    await s.loadEmails()
    const inbox = (await import('./inbox')) as typeof InboxStore
    await inbox.pollInbox()
    expect(inbox.inbox.unread).toBe(2)
    // 邮件这边根本没有 unread 字段 —— 未读不是这个 store 的概念
    expect('unread' in s.email).toBe(false)
  })
})
