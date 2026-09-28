/**
 * 邮件抽屉（v3.3，2026-09-28）：读缓存 + 刷新按钮 + 档位 1/3/7（默认 1）。
 *
 * 锁住的（用户点过名或会咬人的）：
 *  1. 默认选中 **1 天**、打开即读缓存（瞬时，不连邮箱）；
 *  2. 切档位只重读缓存；只有**刷新按钮**才会发 POST `/inbox/email/refresh`（唯一碰 IMAP 的动作）；
 *  3. 头部显示「上次拉取」= 缓存新鲜度；
 *  4. 失败**不弹横幅**：一行报错 + 重试按钮（用户 09-24 明确要求）；
 *  5. 列表只给摘要，点开才拉全文并用现成的 markdown 渲染器；展开**不发任何写请求**（只读）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let calls: string[] = []
let mode: 'ok' | 'fail' = 'ok'
let fetchedAt: string | null = '2026-09-28T20:12:14+08:00'

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
    excerpt: '摘要一行（服务端压成一行）',
    body_len: 7283,
    attachment_count: 0,
    fetched_at: '2026-09-28T20:12:14+08:00',
    ...over,
  }
}

beforeEach(() => {
  calls = []
  mode = 'ok'
  fetchedAt = '2026-09-28T20:12:14+08:00'
  vi.resetModules()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (mode === 'fail') throw new TypeError('Failed to fetch')
      if (url.startsWith('/inbox/email/refresh')) {
        return json({ days: 7, pulled: 48, inserted: 0, updated: 48, fetched_at: fetchedAt, sender: 'xd602201@163.com' })
      }
      if (url.startsWith('/inbox/email/cache/')) {
        return json({ ...row(), body: ['正文全文（含表格）', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n') })
      }
      if (url.startsWith('/inbox/email/cache?')) {
        return json({ days: 1, count: 1, fetched_at: fetchedAt, cached_total: 48, messages: [row()] })
      }
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
})

async function mountDrawer() {
  const { default: EmailDrawer } = await import('./EmailDrawer.vue')
  const w = mount(EmailDrawer)
  await flushPromises()
  return w
}

describe('EmailDrawer：默认与列表', () => {
  it('默认选中 1 天；档位按钮恰好 1/3/7', async () => {
    const w = await mountDrawer()
    const days = w.findAll('[data-testid="email-days"]')
    expect(days.map((d) => d.text())).toEqual(['1 天', '3 天', '7 天'])
    const active = days.filter((d) => d.classes().some((c) => c.includes('bg-gray-900') || c.includes('dark:bg-gray-100')))
    expect(active).toHaveLength(1)
    expect(active[0].text()).toBe('1 天')
  })

  it('渲染发件人 / 主题 / 摘要，并显示「上次拉取」', async () => {
    const w = await mountDrawer()
    expect(w.findAll('[data-testid="email-item"]')).toHaveLength(1)
    expect(w.text()).toContain('Hermes <xd602201@163.com>')
    expect(w.text()).toContain('📊 早盘简报 2026-09-28')
    expect(w.text()).toContain('摘要一行')
    expect(w.find('[data-testid="email-fetched"]').text()).toContain('上次拉取')
  })

  it('切档位 → 只重读缓存（days=7），不发 POST', async () => {
    const w = await mountDrawer()
    calls = []
    await w.findAll('[data-testid="email-days"]')[2].trigger('click')
    await flushPromises()
    expect(calls).toEqual(['GET /inbox/email/cache?days=7&limit=50'])
  })
})

describe('EmailDrawer：刷新按钮（唯一连邮箱的动作）', () => {
  it('点刷新 → POST refresh?days=7 后重读缓存', async () => {
    const w = await mountDrawer()
    calls = []
    await w.find('[data-testid="email-refresh"]').trigger('click')
    await flushPromises()
    expect(calls[0]).toBe('POST /inbox/email/refresh?days=7&limit=50')
    expect(calls[1]).toBe('GET /inbox/email/cache?days=1&limit=50')
  })
})

describe('EmailDrawer：失败与只读', () => {
  it('读缓存失败：一行报错 + 重试按钮能恢复', async () => {
    mode = 'fail'
    const w = await mountDrawer()
    expect(w.find('[data-testid="email-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="email-error"]').text()).toContain('连不上消息服务')
    mode = 'ok'
    await w.find('[data-testid="email-retry"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="email-error"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="email-item"]')).toHaveLength(1)
  })

  it('空缓存给出"点刷新"的指引', async () => {
    fetchedAt = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(`GET ${url}`)
        return json({ days: 1, count: 0, fetched_at: null, cached_total: 0, messages: [] })
      }),
    )
    const w = await mountDrawer()
    expect(w.find('[data-testid="email-empty"]').text()).toContain('刷新')
  })

  it('展开只发 GET、渲染 markdown 正文（表格也有 wrapper）', async () => {
    const w = await mountDrawer()
    calls = []
    await w.find('[data-testid="email-item"] button').trigger('click')
    await flushPromises()
    expect(calls).toEqual(['GET /inbox/email/cache/7'])
    const body = w.find('[data-testid="email-detail-body"]')
    expect(body.exists()).toBe(true)
    expect(body.html()).toContain('table')
    expect(w.find('[data-testid="email-ask"]').exists()).toBe(true)
  })
})
