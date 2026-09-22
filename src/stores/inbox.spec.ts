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
/** 桩里模拟服务端的已读状态（/read 会改它，详情接口读它）——真实服务就是这样 */
let readIds = new Set<number>()

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
      if (url.includes('/read-all')) return json({ ok: true, updated: 2, unread_count: 0 })
      if (url.startsWith('/inbox/messages/') && url.includes('/read')) {
        const id = Number(/\/inbox\/messages\/(\d+)\//.exec(url)?.[1] ?? 0)
        if (url.includes('read=0')) readIds.delete(id)
        else readIds.add(id)
        return json({ ok: true, unread_count: readIds.size ? 2 : 3 })
      }
      if (url.startsWith('/inbox/messages/') && url.includes('/archive')) return json({ ok: true, unread_count: 2 })
      if (url.startsWith('/inbox/messages/') && url.includes('/read-all')) return json({ ok: true, updated: 1, unread_count: 0 })
      // ★ 前缀匹配：v3.1 起这个 URL 会带 ?since=…，写死等号会让桩漏掉它
      if (url.startsWith('/inbox/unread-count')) return json({ unread_count: unread })
      if (url.startsWith('/inbox/messages/')) {
        const id = Number(/\/inbox\/messages\/(\d+)$/.exec(url)?.[1] ?? M1.id)
        return json({ ...M1, id, read: readIds.has(id), body: '全文正文（含表格）' })
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
  readIds = new Set<number>()
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
    expect(calls.some((c) => c.startsWith('GET /inbox/unread-count'))).toBe(true)
    expect(calls.some((c) => c.startsWith('GET /inbox/messages?'))).toBe(true)
    expect(s.inbox.newCount).toBe(1)
  })

  it('未读没变：只问未读数，不拉列表（省流量）', async () => {
    const s = await fresh()
    await s.loadInbox()
    calls = []
    await s.pollInbox()
    // 只有一次请求，且是那个轻接口（URL 带 since —— 口径 v3.1 起时间窗也参与）
    expect(calls.length).toBe(1)
    expect(calls[0].startsWith('GET /inbox/unread-count')).toBe(true)
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

  it('★ readAll 不带筛选（按钮语义是"全部"：按筛选只清一部分会让徽标停在非 0 ⇒ 看着像"点了没用"）', async () => {
    const s = await fresh()
    await s.setFilter('email') // 故意先筛一个类型
    calls = []
    await s.readAll()
    const call = calls.find((c) => c.includes('/read-all'))
    expect(call).toBeTruthy()
    expect(call).not.toContain('category')
    expect(s.inbox.unread).toBe(0)
    expect(s.inbox.messages.every((m) => m.read)).toBe(true)
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

describe('消息中心 store：起始时间窗（v3.1）', () => {
  it('默认 = 当天 00:00，且列表请求带 since（带本地偏移）', async () => {
    const s = await fresh()
    expect(s.inbox.sinceInput).toMatch(/^\d{4}-\d{2}-\d{2}T00:00$/)
    calls = []
    await s.loadInbox()
    const list = calls.find((c) => c.startsWith('GET /inbox/messages?'))
    expect(list).toBeTruthy()
    expect(list).toContain('since=')
    expect(decodeURIComponent(list!)).toContain(`${s.inbox.sinceInput.slice(0, 10)}T00:00:00`)
  })

  it('★ 手改时间 → 立刻重拉，参数跟着变（改完没反应会像坏了）', async () => {
    const s = await fresh()
    calls = []
    await s.setSinceInput('2026-09-22T18:00')
    const list = calls.find((c) => c.startsWith('GET /inbox/messages?'))
    expect(list).toBeTruthy()
    expect(decodeURIComponent(list!)).toContain('2026-09-22T18:00:00')
  })

  it('★ 「不限」= 请求不带 since（空值不等于"从 1970 年起"）', async () => {
    const s = await fresh()
    await s.setSinceInput('')
    calls = []
    await s.loadInbox()
    const list = calls.find((c) => c.startsWith('GET /inbox/messages?'))
    expect(list).not.toContain('since=')
  })

  it('轮询（徽标）也带同一个时间窗 —— 徽标数字与列表必须同口径', async () => {
    const s = await fresh()
    calls = []
    await s.pollInbox()
    const poll = calls.find((c) => c.startsWith('GET /inbox/unread-count'))
    expect(poll).toBeTruthy()
    expect(poll).toContain('since=')
  })

  it('★ 「刷新页面即还原」：resetInbox 之后回到当天 0 点（值只在内存里）', async () => {
    const s = await fresh()
    await s.setSinceInput('2026-09-22T18:00')
    expect(s.inbox.sinceInput).toBe('2026-09-22T18:00')
    s.resetInbox()
    expect(s.inbox.sinceInput).toMatch(/T00:00$/)
    // 也确实没写进 localStorage（写盘就把"刷新还原"变成 bug 了）
    expect(localStorage.getItem('hcl.inboxSince')).toBe(null)
  })
})

describe('消息中心 store：展开即已读（v3.1）', () => {
  it('★ 展开未读消息 → 自动标记已读', async () => {
    const s = await fresh()
    await s.loadInbox() // 先有列表，才能断言列表项上的 read 也被同步
    calls = []
    await s.toggleDetail(11)
    await new Promise((r) => setTimeout(r, 0)) // 自动已读是 fire-and-forget：等一拍再断言
    expect(calls.some((c) => c.includes('/read?'))).toBe(true)
    expect(s.inbox.messages[0].read).toBe(true)
  })

  it('已读的再展开不会重复打请求', async () => {
    const s = await fresh()
    await s.loadInbox()
    await s.setRead(11, true)
    calls = []
    await s.toggleDetail(11)
    expect(calls.some((c) => c.includes('/read?'))).toBe(false)
  })

  it('★ 手动标未读的，再展开也不许被自动吃掉（显式动作优先）', async () => {
    const s = await fresh()
    await s.loadInbox()
    await s.setRead(11, false) // 用户手动标成"待办"
    calls = []
    await s.toggleDetail(11)
    expect(calls.some((c) => c.includes('/read?'))).toBe(false)
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
      expect(calls.some((c) => c.startsWith('GET /inbox/unread-count'))).toBe(true)

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
