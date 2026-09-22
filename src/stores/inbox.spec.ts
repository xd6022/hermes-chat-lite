/**
 * 消息中心 store 的口径。
 *
 * 锁住的（每条都对应一个真实会咬人的行为）：
 *  1. 列表只吃**摘要**，全文走详情接口 —— 不能拿摘要当正文显示；
 *  2. **筛选要真的带 category 参数**，`全部` 不带（中文进查询串会被 uvicorn 判非法请求）；
 *  3. 轮询**只问未读数**，未读变多才拉列表 —— 否则每 5 分钟白拉 50 条；
 *  4. 失败不抛、不打断：记 `error` + `failures`（驱动退避），列表保持上一次内容；
 *  5. `关闭` 档：开抽屉**不发请求**（这是"关闭"的语义，只有手动刷新才拉）；
 *  6. 归档 = 从列表消失；已读状态以**服务端返回的 unread_count** 为准（不在前端自己加减）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as InboxStore from './inbox'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let mode: 'ok' | 'fail' = 'ok'
let calls: string[] = []
let unread = 3

const M1 = {
  id: 11,
  source: 'email',
  category: 'email',
  level: 'action',
  title: '600259 盘中触及 83.00',
  occurred_at: '2026-09-22T14:38:00+08:00',
  read: false,
  archived: false,
  excerpt: '摘要（200 字以内）',
  body_len: 392,
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (mode === 'fail') throw new TypeError('Failed to fetch')
      if (url.startsWith('/inbox/messages/') && url.includes('/read')) return json({ ok: true, unread_count: 2 })
      if (url.startsWith('/inbox/messages/') && url.includes('/archive')) return json({ ok: true, unread_count: 2 })
      if (url.startsWith('/inbox/messages/') && url.includes('/read-all')) return json({ ok: true, updated: 1, unread_count: 0 })
      if (url === '/inbox/unread-count') return json({ unread_count: unread })
      if (url.startsWith('/inbox/messages/')) {
        return json({ ...M1, body: '全文正文（含表格）' })
      }
      if (url.startsWith('/inbox/messages?')) return json({ unread_count: unread, messages: [M1] })
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
  unread = 3
  localStorage.clear()
  stubFetch()
})

describe('消息中心 store：加载', () => {
  it('loadInbox 写入列表与未读数，并记下成功时刻', async () => {
    const s = await fresh()
    await s.loadInbox()
    expect(s.inbox.messages.length).toBe(1)
    expect(s.inbox.messages[0].title).toContain('600259')
    expect(s.inbox.unread).toBe(3)
    expect(s.inbox.loaded).toBe(true)
    expect(s.inbox.error).toBe('')
    expect(s.inbox.lastOkAt).toBeGreaterThan(0)
  })

  it('★ 筛选要带 category 参数；「全部」不带（中文进查询串会被判非法请求）', async () => {
    const s = await fresh()
    await s.setFilter('stock')
    expect(calls.some((c) => c.includes('category=stock'))).toBe(true)

    calls = []
    await s.setFilter('all')
    expect(calls.some((c) => c.includes('category'))).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('失败：不抛异常，记 error/failures，列表保持上一次内容', async () => {
    const s = await fresh()
    await s.loadInbox()
    mode = 'fail'
    await s.loadInbox()
    expect(s.inbox.error).toContain('连不上消息服务')
    expect(s.inbox.failures).toBe(1)
    expect(s.inbox.messages.length).toBe(1) // 上一次的内容还在，界面不空
  })

  it('恢复成功后退避计数清零（否则会一直按失败间隔拉）', async () => {
    const s = await fresh()
    mode = 'fail'
    await s.loadInbox()
    expect(s.inbox.failures).toBe(1)
    mode = 'ok'
    await s.loadInbox()
    expect(s.inbox.failures).toBe(0)
    expect(s.inbox.error).toBe('')
  })
})

describe('消息中心 store：轮询', () => {
  it('★ 未读变多才拉列表，并把新增条数记进 newCount（App 用它弹轻提示）', async () => {
    const s = await fresh()
    await s.loadInbox()
    unread = 4 // 服务端多了一条
    calls = []
    await s.pollInbox()
    expect(calls).toContain('GET /inbox/unread-count')
    expect(calls.some((c) => c.startsWith('GET /inbox/messages?'))).toBe(true)
    expect(s.inbox.newCount).toBe(1)
  })

  it('未读没变：只问未读数，不拉列表（省流量）', async () => {
    const s = await fresh()
    await s.loadInbox()
    calls = []
    await s.pollInbox()
    expect(calls).toEqual(['GET /inbox/unread-count'])
    expect(s.inbox.newCount).toBe(0)
  })

  it('clearNewCount 之后不再重复提示', async () => {
    const s = await fresh()
    await s.loadInbox()
    unread = 5
    await s.pollInbox()
    expect(s.inbox.newCount).toBe(2)
    s.clearNewCount()
    expect(s.inbox.newCount).toBe(0)
  })
})

describe('消息中心 store：动作', () => {
  it('已读状态以服务端返回的 unread_count 为准（不在前端自己加减）', async () => {
    const s = await fresh()
    await s.loadInbox()
    await s.setRead(11, true)
    expect(s.inbox.unread).toBe(2)
    expect(s.inbox.messages[0].read).toBe(true)
  })

  it('归档后从列表里移掉', async () => {
    const s = await fresh()
    await s.loadInbox()
    await s.archive(11)
    expect(s.inbox.messages.length).toBe(0)
  })

  it('展开某条才拉全文；再点一次收起且不重复请求', async () => {
    const s = await fresh()
    await s.toggleDetail(11)
    expect(s.inbox.detail?.body).toContain('全文正文')
    calls = []
    await s.toggleDetail(11)
    expect(s.inbox.expandedId).toBe(null)
    expect(s.inbox.detail).toBe(null)
    expect(calls.length).toBe(0)
  })
})

describe('消息中心 store：「关闭」档与开抽屉', () => {
  it('★ 非关闭档：开抽屉会拉一次', async () => {
    const s = await fresh()
    const { setPollSetting } = await import('../lib/inboxSettings')
    setPollSetting('5m')
    calls = []
    await s.onDrawerOpen()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('★ 关闭档：开抽屉**一个请求都不发**（"关闭"= 连开抽屉也不拉，只有手动刷新才拉）', async () => {
    const s = await fresh()
    const { setPollSetting } = await import('../lib/inboxSettings')
    setPollSetting('off')
    calls = []
    await s.onDrawerOpen()
    expect(calls).toEqual([])

    // 但手动「立即刷新」照样能用（否则关闭档 = 什么都看不到）
    await s.refreshNow()
    expect(calls.length).toBe(1)
  })
})

describe('消息中心 store：定时器', () => {
  it('开启轮询会排定时器；关闭档不排；stopPolling 能收干净', async () => {
    vi.useFakeTimers()
    try {
      const s = await fresh()
      const { setPollSetting } = await import('../lib/inboxSettings')

      setPollSetting('5m')
      s.startPolling()
      calls = []
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 10)
      expect(calls.some((c) => c === 'GET /inbox/unread-count')).toBe(true)

      s.stopPolling()
      calls = []
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(calls).toEqual([])

      setPollSetting('off')
      s.startPolling()
      calls = []
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(calls).toEqual([]) // 关闭档：一个定时器都不该有
      s.stopPolling()
    } finally {
      vi.useRealTimers()
    }
  })
})
