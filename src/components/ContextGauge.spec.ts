/**
 * 输入框上方那一行：模型 + 上下文水位。
 *
 * 锁住三件事：
 *  1. 展示形态跟 dashboard 状态栏一致（`deepseek-flash │ 407.7k/1m │ [████░░░░░░] 41%`）
 *  2. 水位配色（≥80% 黄、≥95% 红）—— "快满了"要一眼可见
 *  3. 缺数据时的降级：没有分母就只显示模型名；有分母没占用就显示 `—/1m`；
 *     本地缓存恢复的值必须标"上次已知"（不许假装是实时值）；全空则整行不渲染
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ContextGauge from './ContextGauge.vue'
import { store } from '../stores/chat'

function setCtx(ctx: Partial<typeof store.context>): void {
  Object.assign(store.context, { model: null, limit: null, used: null, stale: false, at: 0 }, ctx)
}

beforeEach(() => setCtx({}))

describe('ContextGauge：模型 + 上下文水位', () => {
  it('展示形态与 dashboard 一致：模型 │ 已用/上限 │ 方块条 + 百分比', () => {
    setCtx({ model: 'deepseek-flash', limit: 1_000_000, used: 407_700 })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-model"]').text()).toBe('deepseek-flash')
    expect(w.find('[data-testid="ctx-usage"]').text()).toBe('407.7k/1m')
    expect(w.find('[data-testid="ctx-bar"]').text()).toBe('[████░░░░░░] 41%')
  })

  it('水位 ≥80% 转黄、≥95% 转红（其余保持灰）', () => {
    const toneOf = () => mount(ContextGauge).find('[data-testid="ctx-gauge"]').classes().join(' ')

    setCtx({ model: 'm', limit: 100_000, used: 79_000 })
    expect(toneOf()).toContain('text-gray-400')
    setCtx({ model: 'm', limit: 100_000, used: 85_000 })
    expect(toneOf()).toContain('text-amber-600')
    setCtx({ model: 'm', limit: 100_000, used: 96_000 })
    expect(toneOf()).toContain('text-red-600')
  })

  it('只有模型、没有分母（/api/model-info 没通）→ 只显示模型名，不编 `/1m`', () => {
    setCtx({ model: 'deepseek-flash' })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-model"]').exists()).toBe(true)
    expect(w.find('[data-testid="ctx-usage"]').exists()).toBe(false)
    expect(w.find('[data-testid="ctx-bar"]').exists()).toBe(false)
  })

  it('有分母但占用未知 → 显示 `—/1m`（诚实：还不知道），不出方块', () => {
    setCtx({ model: 'deepseek-flash', limit: 1_000_000 })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-usage"]').text()).toBe('—/1m')
    expect(w.find('[data-testid="ctx-bar"]').exists()).toBe(false)
  })

  it('本地缓存恢复的值必须标"上次已知 + 时刻"（不假扮实时）', () => {
    const at = new Date(2026, 8, 14, 12, 34).getTime()
    setCtx({ model: 'm', limit: 1_000_000, used: 500_000, stale: true, at })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-stale"]').text()).toContain('上次已知 12:34')
  })

  it('什么数据都没有 → 整行不渲染（不占位）', () => {
    setCtx({})
    expect(mount(ContextGauge).find('[data-testid="ctx-gauge"]').exists()).toBe(false)
  })
})
