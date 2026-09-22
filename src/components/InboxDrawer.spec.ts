/**
 * 消息抽屉：灯、筛选、摘要/全文、动作、失败降级。
 *
 * 锁住的（都是用户点过名或踩过的坑）：
 *  1. **等级灯**按 level 上色（action 红 / warn 黄 / info 灰）；
 *  2. 列表只显示**摘要**，点开才拉全文，全文用**现成的 markdown 渲染器**（含表格横向滚动 wrapper ——
 *     v2.1 那次"超宽表格把消息区撑宽"的坑，不能在新界面重演）；
 *  3. `关闭` 档要在头部说清楚"自动刷新已关闭"（否则用户以为坏了）；
 *  4. 拉取失败**不弹红字横幅**，只在筛选行下面留一行小字，界面照常可用；
 *  5. 归档后条目从列表消失；「就这条问 agent」把整条 emit 给上层（发送逻辑不放在组件里）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type * as InboxStore from '../stores/inbox'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let calls: string[] = []

function msg(over: Record<string, unknown> = {}) {
  return {
    id: 11,
    source: 'cron',
    category: 'stock',
    level: 'action',
    title: '510210 上涨触发规则22',
    occurred_at: '2026-09-22T14:35:00+08:00',
    read: false,
    archived: false,
    excerpt: '建议减仓1700股（摘要）',
    body_len: 120,
    ...over,
  }
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/read-all')) return json({ ok: true, updated: 2, unread_count: 0 })
      if (url.includes('/archive')) return json({ ok: true, unread_count: 0 })
      if (url.startsWith('/inbox/messages/'))
        return json({
          ...msg(),
          body: '行情表格：\n\n| 项 | 值 |\n| --- | --- |\n| 现价 | 1.013 |\n| 建议 | 减仓1700股 |\n',
        })
      if (url.startsWith('/inbox/messages?')) return json({ unread_count: 1, messages: [msg()] })
      if (url === '/inbox/unread-count') return json({ unread_count: 1 })
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
}

async function fresh(rows: Record<string, unknown>[] = [msg()]) {
  vi.resetModules()
  const storeMod = (await import('../stores/inbox')) as typeof InboxStore
  const { default: InboxDrawer } = await import('./InboxDrawer.vue')
  storeMod.inbox.messages = rows as never
  storeMod.inbox.unread = rows.filter((r) => !r.read).length
  storeMod.inbox.loaded = true
  const w = mount(InboxDrawer)
  return { storeMod, w }
}

beforeEach(() => {
  calls = []
  localStorage.clear()
  stubFetch()
})

describe('InboxDrawer：列表与灯', () => {
  it('等级灯按 level 上色，类型/时间/等级文案都对', async () => {
    const { w } = await fresh([
      msg({ id: 1, level: 'action', title: 'A' }),
      msg({ id: 2, level: 'warn', title: 'B' }),
      msg({ id: 3, level: 'info', title: 'C' }),
    ])
    const lamps = w.findAll('[data-testid="inbox-lamp"]')
    expect(lamps[0].classes()).toContain('bg-red-500')
    expect(lamps[1].classes()).toContain('bg-amber-500')
    expect(lamps[2].classes()).toContain('bg-gray-300')

    const meta = w.findAll('[data-testid="inbox-meta"]')[0].text()
    expect(meta).toContain('股票信号')
    expect(meta).toContain('14:35')
    expect(meta).toContain('要动手')
  })

  it('未读有标记、头部有未读条数；全部已读时头部改文案', async () => {
    const { storeMod, w } = await fresh()
    expect(w.find('[data-testid="inbox-drawer-unread"]').text()).toContain('1 条未读')
    expect(w.text()).toContain('未读')

    storeMod.inbox.unread = 0
    await w.vm.$nextTick()
    expect(w.find('[data-testid="inbox-drawer-unread"]').exists()).toBe(false)
    expect(w.text()).toContain('全部已读')
  })

  it('空态：加载完成但没消息 → 显示「没有消息」', async () => {
    const { w } = await fresh([])
    expect(w.find('[data-testid="inbox-empty"]').text()).toBe('没有消息')
    expect(w.find('[data-testid="inbox-item"]').exists()).toBe(false)
  })

  it('摘要只在收起时显示（展开后正文接管）', async () => {
    const { w } = await fresh()
    expect(w.text()).toContain('建议减仓1700股（摘要）')
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="inbox-detail"]').exists()).toBe(true)
  })
})

describe('InboxDrawer：全文渲染', () => {
  it('★ 全文走 markdown 渲染器，且表格带 table-wrapper（v2.1 那个"撑宽"坑不能重演）', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    const body = w.find('[data-testid="inbox-detail-body"]')
    expect(body.exists()).toBe(true)
    expect(body.classes()).toContain('md-body')
    expect(body.html()).toContain('table-wrapper')
    expect(body.html()).toContain('减仓1700股')
  })

  it('展开时点同一行 → 收起', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="inbox-detail"]').exists()).toBe(false)
  })
})

describe('InboxDrawer：动作', () => {
  it('「就这条问 agent」把整条 emit 出去（发送逻辑不放在组件里）', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    await w.find('[data-testid="inbox-ask"]').trigger('click')
    const asked = w.emitted('ask')?.[0]?.[0] as { title: string } | undefined
    expect(asked?.title).toContain('510210')
  })

  it('归档后条目从列表消失', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    await w.find('[data-testid="inbox-archive"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.includes('/archive'))).toBe(true)
    expect(w.findAll('[data-testid="inbox-item"]').length).toBe(0)
  })

  it('「标记已读」把状态交给服务端（请求 /read）', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    await w.find('[data-testid="inbox-mark-read"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.includes('/read?'))).toBe(true)
  })

  it('筛选按钮：点「股票信号」带的 category 是 ASCII 代码 stock', async () => {
    const { w } = await fresh()
    const stock = w.findAll('[data-testid="inbox-filter"]').find((b) => b.text() === '股票信号')!
    await stock.trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.includes('category=stock'))).toBe(true)
  })

  it('关闭按钮 emit close', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })
})

describe('InboxDrawer：一键已读（2026-09-22 用户反馈"看了但外面还显示未读"后挪到头部）', () => {
  it('★ 按钮在**头部**（列表之前）、带未读数', async () => {
    const { w } = await fresh([msg({ id: 1 }), msg({ id: 2 })])
    const btn = w.find('[data-testid="inbox-read-all"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('一键已读')
    expect(btn.text()).toContain('(2)')

    // 位置判据（比看 class 稳）：按钮出现在列表项之前的文档顺序里 ⇒ 它在头部，不在页脚
    const firstItem = w.find('[data-testid="inbox-item"]').element
    const pos = btn.element.compareDocumentPosition(firstItem)
    expect(Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('★ 点了就清零：请求不带筛选、未读归零、头部改文案', async () => {
    const { storeMod, w } = await fresh([msg({ id: 1 }), msg({ id: 2 })])
    storeMod.inbox.filter = 'stock' // 故意先筛一个类型
    await w.find('[data-testid="inbox-read-all"]').trigger('click')
    await flushPromises()

    const call = calls.find((c) => c.includes('/read-all'))
    expect(call).toBeTruthy()
    expect(call).not.toContain('category') // ← 带了筛选就只清一部分，徽标停在非 0
    expect(storeMod.inbox.unread).toBe(0)
    expect(w.text()).toContain('全部已读')
    // 徽标数字应从外部消失（未读 0 不渲染徽标）
    expect(w.find('[data-testid="inbox-read-all"]').text()).not.toContain('(')
  })

  it('没有未读时按钮禁用（不给出点了没反应的按钮）', async () => {
    const { w } = await fresh([msg({ read: true })])
    const btn = w.find('[data-testid="inbox-read-all"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).not.toContain('(')
  })
})

describe('InboxDrawer：失败与关闭档的说明', () => {
  it('拉取失败：只在筛选行下面留一行小字，不弹红字横幅', async () => {
    const { storeMod, w } = await fresh()
    storeMod.inbox.error = '连不上消息服务（检查 chatlite-inbox 容器是否在跑）'
    await w.vm.$nextTick()
    const line = w.find('[data-testid="inbox-error"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('上次拉取失败')
    expect(w.find('[data-testid="inbox-footer-clock"]').text()).toBe('上次拉取失败')
    // 界面照常可用：条目还在、筛选还在
    expect(w.findAll('[data-testid="inbox-item"]').length).toBe(1)
  })

  it('★ 「关闭」档要在头部说清楚，否则像坏了', async () => {
    const { w } = await fresh()
    const { setPollSetting } = await import('../lib/inboxSettings')
    setPollSetting('off')
    await w.vm.$nextTick()
    expect(w.find('[data-testid="inbox-poll-hint"]').text()).toContain('关闭')

    setPollSetting('5m')
    await w.vm.$nextTick()
    expect(w.find('[data-testid="inbox-poll-hint"]').text()).toContain('5 分钟')
  })
})
