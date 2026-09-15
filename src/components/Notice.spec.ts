/**
 * 轻提示（v2.12）：5 秒自动消失 + 点击立即消失（用户 2026-09-15 定的口径）。
 *
 * 为什么值得单测：这两个行为都是"用户能感觉到但不一定报 bug"的那种 ——
 * 提示赖着不走会挡视线、点不掉会让人烦，靠肉眼容易漏。
 */
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Notice from './Notice.vue'

describe('Notice：会自动消失的轻提示', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('渲染文案', () => {
    const w = mount(Notice, { props: { text: '该会话不存在，请重新创建' } })
    expect(w.get('[data-testid="notice"]').text()).toBe('该会话不存在，请重新创建')
  })

  it('★ 5 秒后自己消失（发 close）', () => {
    const w = mount(Notice, { props: { text: 'x' } })
    vi.advanceTimersByTime(4999)
    expect(w.emitted('close')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('★ 点一下就立刻消失（不用等满 5 秒，也不需要瞄准关闭按钮）', async () => {
    const w = mount(Notice, { props: { text: 'x' } })
    await w.get('[data-testid="notice"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    // 点掉之后定时器不该再补一发
    vi.advanceTimersByTime(6000)
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('ms 可调（下限 1 秒，避免传 0 变成"闪现"）', () => {
    const w = mount(Notice, { props: { text: 'x', ms: 0 } })
    vi.advanceTimersByTime(999)
    expect(w.emitted('close')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('被卸载时清掉定时器（别让回调打在已卸载的组件上）', () => {
    const w = mount(Notice, { props: { text: 'x' } })
    w.unmount()
    vi.advanceTimersByTime(6000)
    expect(w.emitted('close')).toBeUndefined()
  })
})
