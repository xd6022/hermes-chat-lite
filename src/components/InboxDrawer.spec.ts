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
import { defaultSinceInput } from '../lib/inboxSince'
import type * as InboxStore from '../stores/inbox'

/**
 * 当天的某个时刻（`datetime-local` 形态）。
 *
 * ⚠️ **不许在这里写死日期**：早先这条用例用的是「昨晚随手给的示例值」`2026-09-22T18:00`
 * 加断言 `今天 18:00 起` —— 到了 9/23 那天它就成了「昨天 18:00 起」，用例**天天红一次**
 * （红色追下去发现断言在跟日历赛跑，不是代码坏了）。日期一律由前端自己的
 * `defaultSinceInput()`（当天 00:00）取**当天真实日期**再拼时间。
 */
function todayAt(hhmm: string): string {
  return `${defaultSinceInput().slice(0, 10)}T${hhmm}`
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let calls: string[] = []
/** 邮件接口的桩开关：'fail' 时抛网络错（验证"明确报错 + 重试按钮"） */
let emailMode: 'ok' | 'fail' = 'ok'

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

/** 邮件 tab 的样本邮件（字段与后端 /inbox/email/* 一致） */
function email(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  }
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      // ---- 邮件 tab（实时直读邮箱）----
      if (url.startsWith('/inbox/email/')) {
        if (emailMode === 'fail') throw new TypeError('Failed to fetch')
        if (/\/inbox\/email\/messages\/[^?]+$/.test(url)) return json({ ...email(), body: '邮件正文（纯文本）' })
        return json({ days: 7, limit: 30, unread_count: 1, messages: [email()] })
      }
      if (url.includes('/read-all')) return json({ ok: true, updated: 2, unread_count: 0 })
      if (url.includes('/archive')) return json({ ok: true, unread_count: 0 })
      if (url.startsWith('/inbox/messages/'))
        return json({
          ...msg(),
          body: '行情表格：\n\n| 项 | 值 |\n| --- | --- |\n| 现价 | 1.013 |\n| 建议 | 减仓1700股 |\n',
        })
      if (url.startsWith('/inbox/messages?')) return json({ unread_count: 1, messages: [msg()] })
      if (url.startsWith('/inbox/unread-count')) return json({ unread_count: 1 })
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
  emailMode = 'ok'
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

  it('★ 展开即已读（v3.1）：展开后自动打 /read，按钮随之变成「标为未读」', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.includes('/read?'))).toBe(true)
    expect(w.find('[data-testid="inbox-mark-read"]').exists()).toBe(false)
    expect(w.find('[data-testid="inbox-mark-unread"]').exists()).toBe(true)
  })

  it('手动「标为未读」也能用（把消息留成待办）', async () => {
    const { storeMod, w } = await fresh()
    await w.find('[data-testid="inbox-item"] button').trigger('click')
    await flushPromises()
    await w.find('[data-testid="inbox-mark-unread"]').trigger('click')
    await flushPromises()
    expect(storeMod.inbox.messages[0].read).toBe(false)
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

describe('InboxDrawer：起始时间窗（v3.1）', () => {
  it('默认值 = 当天 0 点，旁边有「今天 00:00 起」人话', async () => {
    const { w } = await fresh()
    const input = w.find('[data-testid="inbox-since"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('value')).toMatch(/T00:00$/)
    expect(w.find('[data-testid="inbox-since-label"]').text()).toBe('今天 00:00 起')
  })

  it('★ 点「不限」→ 请求不再带 since，标签变「不限」', async () => {
    const { w } = await fresh()
    await w.find('[data-testid="inbox-since-all"]').trigger('click')
    await flushPromises()
    const list = calls.filter((c) => c.startsWith('GET /inbox/messages?')).pop()
    expect(list).not.toContain('since=')
    expect(w.find('[data-testid="inbox-since-label"]').text()).toBe('不限')
  })

  it('★ 改时间 → 请求带上新时间（改完立刻生效）', async () => {
    const { w } = await fresh()
    const at = todayAt('18:00') // 当天 18:00（例子里那个日期是示例数据，不写死）
    const input = w.find('[data-testid="inbox-since"]')
    await input.setValue(at)
    await input.trigger('change')
    await flushPromises()
    const list = calls.filter((c) => c.startsWith('GET /inbox/messages?')).pop()
    expect(decodeURIComponent(list!)).toContain(`${at}:00`)
    expect(w.find('[data-testid="inbox-since-label"]').text()).toBe('今天 18:00 起')
  })

  it('点了「今天 0 点」回到默认', async () => {
    const { storeMod, w } = await fresh()
    await storeMod.setSinceInput(todayAt('18:00'))
    await w.vm.$nextTick()
    await w.find('[data-testid="inbox-since-today"]').trigger('click')
    await flushPromises()
    expect(storeMod.inbox.sinceInput).toMatch(/T00:00$/)
    expect(w.find('[data-testid="inbox-since-label"]').text()).toBe('今天 00:00 起')
  })

  it('时间窗把消息挡没了时，空态要说清原因（不是一句"没有消息"）', async () => {
    const { storeMod, w } = await fresh([])
    storeMod.inbox.sinceInput = todayAt('18:00')
    await w.vm.$nextTick()
    expect(w.find('[data-testid="inbox-empty"]').text()).toContain('这个时间之后没有消息')
    storeMod.inbox.sinceInput = ''
    await w.vm.$nextTick()
    expect(w.find('[data-testid="inbox-empty"]').text()).toBe('没有消息') // 不限 = 不是"窄窗口"
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

describe('InboxDrawer：「立即刷新」的转圈反馈（用户 2026-09-23 要求）', () => {
  /**
   * 诉求原话：「点击后，如果消息列表无新增消息时，看不出来这个按钮是否生效了，
   * 可以像浏览器刷新一样，转一圈」。
   * 所以这里锁两件事：① 转的类在请求期间挂上、结束后摘掉；
   * ② **请求几十毫秒就回来也要转满最短时长**（否则一闪而过 = 等于没反馈）。
   */
  it('★ 请求期间图标在转、结束后停下（请求瞬间返回也不许一闪而过）', async () => {
    vi.useFakeTimers()
    try {
      const { w } = await fresh()
      const icon = () => w.find('[data-testid="inbox-refresh"] svg')
      expect(icon().classes()).not.toContain('refresh-spin')

      // 让请求挂在半空，模拟"点了但还没回来"
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          calls.push(`GET ${String(input)}`)
          await gate
          return json({ unread_count: 1, messages: [msg()] })
        }),
      )

      await w.find('[data-testid="inbox-refresh"]').trigger('click')
      await Promise.resolve()
      expect(icon().classes()).toContain('refresh-spin')

      release()
      await vi.advanceTimersByTimeAsync(0) // 请求已回来，但最短时长还没走完
      expect(icon().classes()).toContain('refresh-spin')

      await vi.advanceTimersByTimeAsync(600) // 转满一圈
      expect(icon().classes()).not.toContain('refresh-spin')
      expect(w.find('[data-testid="inbox-refresh"]').attributes('disabled')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('★ 列表没有新增消息时，同样能看出按钮生效了（这次点击仍然转了）', async () => {
    vi.useFakeTimers()
    try {
      const { w } = await fresh()
      calls = []
      // 服务端返回的是**同一批**消息（无新增 ⇒ 界面不会有任何变化，只能靠动画说话）
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          calls.push(`GET ${String(input)}`)
          return json({ unread_count: 1, messages: [msg()] })
        }),
      )
      await w.find('[data-testid="inbox-refresh"]').trigger('click')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.some((c) => c.startsWith('GET /inbox/messages?'))).toBe(true)
      expect(w.find('[data-testid="inbox-refresh"] svg').classes()).toContain('refresh-spin')
      await vi.advanceTimersByTimeAsync(600)
      expect(w.find('[data-testid="inbox-refresh"] svg').classes()).not.toContain('refresh-spin')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── 「邮件」tab（2026-09-24：实时直读邮箱、不落库）────────────────────────────

/** 邮件 tab 的挂载：预置成"邮件 tab 已加载一屏"（真实流程由 store 用例覆盖） */
async function freshEmail(rows: Record<string, unknown>[] = [email()], error = '') {
  vi.resetModules()
  const storeMod = (await import('../stores/inbox')) as typeof InboxStore
  const { default: InboxDrawer } = await import('./InboxDrawer.vue')
  storeMod.inbox.tab = 'email'
  storeMod.inbox.emails = rows as never
  storeMod.inbox.emailUnread = rows.filter((r) => (r as { unread?: boolean }).unread).length
  storeMod.inbox.emailLoaded = true
  storeMod.inbox.emailError = error
  storeMod.inbox.emailLastOkAt = Date.now()
  const w = mount(InboxDrawer)
  return { storeMod, w }
}

describe('InboxDrawer：邮件 tab', () => {
  it('两个 tab 都在；切到「邮件」后通知那一套（筛选/时间窗/一键已读）让位给邮件工具条', async () => {
    const { w } = await freshEmail()
    expect(w.findAll('[data-testid="inbox-tab"]').map((b) => b.text())).toEqual(['通知', '邮件'])

    // 邮件 tab 上：通知的筛选、起始时间、一键已读都不该出现（免得点错口径）
    expect(w.find('[data-testid="inbox-filter"]').exists()).toBe(false)
    expect(w.find('[data-testid="inbox-since"]').exists()).toBe(false)
    expect(w.find('[data-testid="inbox-read-all"]').exists()).toBe(false)
    // 邮件工具条 + 只读提示在
    expect(w.findAll('[data-testid="inbox-email-days"]').map((b) => b.text())).toEqual(['1 天', '3 天', '7 天'])
    expect(w.find('[data-testid="inbox-email-unread-only"]').exists()).toBe(true)
    expect(w.find('[data-testid="inbox-email-hint"]').text()).toContain('只读')
  })

  it('★ 时间窗档位 = 1/3/7 天且**默认 3 天**；点一下按该 days 重拉（不是摆设）', async () => {
    const { storeMod, w } = await freshEmail()
    const btns = w.findAll('[data-testid="inbox-email-days"]')
    expect(btns.map((b) => b.text())).toEqual(['1 天', '3 天', '7 天'])
    // 默认值从 7 改成 3 之后最容易犯的两种错：① 选中态仍落在 7 上（改了 store 没改 reset）
    // ② 档位数组里根本没有 3（前后端各写一份的老毛病）→ 两条一起断言
    expect(btns.filter((b) => b.classes().includes('bg-gray-900')).map((b) => b.text())).toEqual(['3 天'])
    expect(storeMod.inbox.emailDays).toBe(3)

    await btns[0].trigger('click')
    await flushPromises()
    expect(storeMod.inbox.emailDays).toBe(1)
    expect(
      calls.some((c) => c.startsWith('GET /inbox/email/messages?') && c.includes('days=1')),
    ).toBe(true)
  })

  it('★ 邮件未读不写进徽标：头部不显示"未读/一键已读"', async () => {
    const { w } = await freshEmail([email({ unread: true })])
    expect(w.find('[data-testid="inbox-drawer-unread"]').exists()).toBe(false)
    expect(w.text()).not.toContain('全部已读')
  })

  it('列表：发件人 / 主题 / 摘要都在；点开拉全文并渲染', async () => {
    const { w, storeMod } = await freshEmail()
    expect(w.find('[data-testid="inbox-email-from"]').text()).toContain('xd602201@163.com')
    expect(w.text()).toContain('📊 模拟盘早间选股 2026-09-24')
    expect(w.text()).toContain('摘要一行')

    await w.find('[data-testid="inbox-email-item"] button').trigger('click')
    await flushPromises()
    expect(storeMod.inbox.emailDetail?.body).toBe('邮件正文（纯文本）')
    expect(w.find('[data-testid="inbox-email-detail-body"]').text()).toContain('邮件正文')
  })

  it('「就这封问 agent」把整封 emit 出去（发送逻辑不放在组件里）', async () => {
    const { w } = await freshEmail()
    await w.find('[data-testid="inbox-email-item"] button').trigger('click')
    await flushPromises()
    await w.find('[data-testid="inbox-email-ask"]').trigger('click')
    const emitted = w.emitted('ask-email')
    expect(emitted).toBeTruthy()
    expect((emitted![0][0] as { uid: string }).uid).toBe('1315301460')
  })

  it('★ 读邮箱失败：一行明确报错 + 重试按钮；点了重试能恢复', async () => {
    const { w, storeMod } = await freshEmail([], '')
    storeMod.inbox.emailLoaded = false // 还没成功加载过 ⇒ 切到邮件 tab 会真去拉
    emailMode = 'fail'
    await storeMod.setTab('notice')
    await w.find('[data-testid="inbox-tab"]:nth-child(2)').trigger('click')
    await flushPromises()

    const err = w.find('[data-testid="inbox-email-error"]')
    expect(storeMod.inbox.emailError).toMatch(/连不上消息服务/)
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('重试')

    emailMode = 'ok'
    await w.find('[data-testid="inbox-email-retry"]').trigger('click')
    await flushPromises()
    expect(storeMod.inbox.emailError).toBe('')
    expect(w.find('[data-testid="inbox-email-item"]').exists()).toBe(true)
  })
})
