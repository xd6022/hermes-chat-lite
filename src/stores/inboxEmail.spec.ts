/**
 * 消息中心「邮件」tab 的口径（2026-09-24 用户定调：邮件不进消息表，实时直读邮箱）。
 *
 * 锁住的（每条都对应一个真实会咬人的行为）：
 *  1. 切到「邮件」tab 才拉邮件，且**默认 7 天 / 不带 unread**；
 *  2. 读邮箱失败：给**人话错误**、保留上一次的列表、重试能恢复（用户要求"明确报错 + 重试按钮"）；
 *  3. ★ **只读**：展开某封只发 GET，绝不发任何写请求（不动邮箱的已读状态）；
 *  4. 邮件**不参与轮询**：`pollInbox` 不许碰 /inbox/email（那是实连 IMAP，跟着轮询等于白耗）；
 *  5. 开抽屉时若停在邮件 tab → **每次都实时拉一次**（用户："每次直接去邮箱拉"）；
 *  6. 邮件未读数**不写进徽标**（`inbox.unread` 只数通知）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as InboxStore from './inbox'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let mode: 'ok' | 'fail' = 'ok'
let calls: string[] = []

const E1 = {
  uid: '1315301460',
  subject: '📊 模拟盘早间选股 2026-09-24',
  from_name: 'Hermes',
  from_addr: 'xd602201@163.com',
  to_addr: 'xd6022@163.com',
  occurred_at: '2026-09-24T09:20:40+08:00',
  excerpt: '摘要一行（服务端压成一行）',
  body_len: 638,
  attachment_count: 0,
  unread: true,
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (mode === 'fail') throw new TypeError('Failed to fetch')
      if (url.startsWith('/inbox/email/messages/')) {
        return json({ ...E1, uid: url.split('/').pop(), body: '正文全文（含表格）', attachments: [] })
      }
      if (url.startsWith('/inbox/email/messages?')) {
        return json({ days: 7, limit: 30, unread_count: 1, messages: [E1] })
      }
      // 通知那套照旧（切 tab 的用例不该因为这边没桩而炸）
      if (url.startsWith('/inbox/unread-count')) return json({ unread_count: 2 })
      if (url.startsWith('/inbox/messages?')) return json({ unread_count: 2, messages: [] })
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
}

async function fresh(): Promise<typeof InboxStore> {
  vi.resetModules()
  return (await import('./inbox')) as typeof InboxStore
}

beforeEach(() => {
  mode = 'ok'
  calls = []
  stubFetch()
})

describe('邮件 tab：拉取与筛选', () => {
  it('切到「邮件」tab 才拉，默认 days=3（档位 1/3/7，2026-09-24 从 7 改小）/ limit=30 / 不带 unread', async () => {
    const s = await fresh()
    s.resetInbox()
    expect(calls.filter((c) => c.includes('/inbox/email'))).toHaveLength(0) // 切之前不拉

    await s.setTab('email')
    const mailCalls = calls.filter((c) => c.includes('/inbox/email'))
    expect(mailCalls).toHaveLength(1)
    expect(mailCalls[0]).toBe('GET /inbox/email/messages?days=3&limit=30')
    expect(s.inbox.emails[0].subject).toBe(E1.subject)
    expect(s.inbox.emailUnread).toBe(1)
    expect(s.inbox.emailLoaded).toBe(true)
  })

  it('「只看未读」开关 → 请求带 unread=1；改时间窗 → days 跟着变', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.setTab('email')

    await s.setEmailUnreadOnly(true)
    expect(calls[calls.length - 1]).toBe('GET /inbox/email/messages?days=3&limit=30&unread=1')

    // 档位内换一档（1/3/7）——顺带证明"改时间窗真的重拉"，参数是新的那个值
    await s.setEmailDays(7)
    expect(calls[calls.length - 1]).toBe('GET /inbox/email/messages?days=7&limit=30&unread=1')
  })

  it('★ 邮件不参与轮询：pollInbox 不碰 /inbox/email', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.pollInbox()
    expect(calls.filter((c) => c.includes('/inbox/email'))).toHaveLength(0)
  })

  it('★ 邮件未读不计进徽标（徽标只数通知）', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.setTab('email')
    expect(s.inbox.emailUnread).toBe(1)
    expect(s.inbox.unread).toBe(0) // 桩里通知未读是 2，但没拉过 → 仍是初始值，且不会被邮件覆盖
  })

  it('★ 打开抽屉（停在邮件 tab）→ 每次都实时拉一次', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.setTab('email')
    const before = calls.filter((c) => c.includes('/inbox/email')).length

    await s.onDrawerOpen()
    expect(calls.filter((c) => c.includes('/inbox/email')).length).toBe(before + 1)
  })
})

describe('邮件 tab：失败与重试（用户要求"明确报错 + 重试按钮"）', () => {
  it('失败 → 人话错误 + 保留上一次列表；重试恢复并清错误', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.setTab('email')
    expect(s.inbox.emails).toHaveLength(1)

    mode = 'fail'
    await s.loadEmails()
    expect(s.inbox.emailError).toMatch(/连不上消息服务/)
    expect(s.inbox.emails).toHaveLength(1) // ★ 旧列表不能被清空（清空会以为是"没邮件"）
    expect(s.inbox.emailLastOkAt).toBeGreaterThan(0)

    mode = 'ok'
    await s.retryEmails()
    expect(s.inbox.emailError).toBe('')
    expect(s.inbox.emails).toHaveLength(1)
  })

  it('加载中不重复发请求（防连点/重复轮询）', async () => {
    const s = await fresh()
    s.resetInbox()
    await Promise.all([s.setTab('email'), s.loadEmails()])
    expect(calls.filter((c) => c.includes('/inbox/email/messages?'))).toHaveLength(1)
  })
})

describe('邮件 tab：展开详情', () => {
  it('展开某封 → 拉全文（body 就位）', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.setTab('email')
    await s.toggleEmailDetail(E1.uid)
    expect(s.inbox.emailExpandedUid).toBe(E1.uid)
    expect(s.inbox.emailDetail?.body).toBe('正文全文（含表格）')
  })

  it('再点同一封 → 收起，详情清空（不重复请求）', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.setTab('email')
    await s.toggleEmailDetail(E1.uid)
    const detailCalls = calls.filter((c) => c.includes('/inbox/email/messages/')).length

    await s.toggleEmailDetail(E1.uid)
    expect(s.inbox.emailExpandedUid).toBe(null)
    expect(s.inbox.emailDetail).toBe(null)
    expect(calls.filter((c) => c.includes('/inbox/email/messages/')).length).toBe(detailCalls)
  })

  it('★ 只读：整条流程（拉列表 + 展详情）里没有任何写请求', async () => {
    const s = await fresh()
    s.resetInbox()
    await s.setTab('email')
    await s.toggleEmailDetail(E1.uid)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((c) => !c.startsWith('GET '))).toEqual([])
  })
})
