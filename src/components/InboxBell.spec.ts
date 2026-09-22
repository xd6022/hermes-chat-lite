/**
 * 顶栏消息图标：只做两件事 —— 显示未读数、点开抽屉。
 *
 * 锁住的：
 *  1. 未读 0 时**不渲染徽标**（不留一个红底 0）；
 *  2. >99 显示 `99+`（三位数会把图标撑变形）；
 *  3. 点击 emit `toggle`（具体开合由 App 决定，图标自己不管状态）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type * as InboxStore from '../stores/inbox'

async function fresh() {
  vi.resetModules()
  const storeMod = (await import('../stores/inbox')) as typeof InboxStore
  const { default: InboxBell } = await import('./InboxBell.vue')
  return { storeMod, InboxBell }
}

beforeEach(() => {
  localStorage.clear()
})

describe('InboxBell', () => {
  it('未读 0：不渲染徽标', async () => {
    const { storeMod, InboxBell } = await fresh()
    storeMod.inbox.unread = 0
    const w = mount(InboxBell, { props: { open: false } })
    expect(w.find('[data-testid="inbox-badge"]').exists()).toBe(false)
    expect(w.find('[data-testid="inbox-bell"]').attributes('title')).toBe('消息')
  })

  it('未读 7：徽标显示 7，title 里带条数', async () => {
    const { storeMod, InboxBell } = await fresh()
    storeMod.inbox.unread = 7
    const w = mount(InboxBell, { props: { open: false } })
    expect(w.find('[data-testid="inbox-badge"]').text()).toBe('7')
    expect(w.find('[data-testid="inbox-bell"]').attributes('title')).toContain('7 条未读')
  })

  it('未读 150：徽标显示 99+', async () => {
    const { storeMod, InboxBell } = await fresh()
    storeMod.inbox.unread = 150
    const w = mount(InboxBell, { props: { open: false } })
    expect(w.find('[data-testid="inbox-badge"]').text()).toBe('99+')
  })

  it('点击 emit toggle', async () => {
    const { InboxBell } = await fresh()
    const w = mount(InboxBell, { props: { open: false } })
    await w.find('[data-testid="inbox-bell"]').trigger('click')
    expect(w.emitted('toggle')).toBeTruthy()
  })
})
