/**
 * 输入框上方那一行：模型 + 窗口上限 + 本轮输入合计。
 *
 * 锁住四件事：
 *  1. 展示形态＝`模型 │ 窗口 1m │ 本轮输入合计 112.3k` —— **没有百分比、没有进度条**
 *     （旧版那排 `2.6m/1m [██████████] 100%` 是拿"本轮累计输入"除窗口算出来的假水位，
 *      2026-09-15 查实：那一轮单次最大 prompt 只有 125k/1M）
 *  2. 任何数值都**不转黄、不转红** —— 整行一律灰（用户 2026-09-15 明确要求）
 *  3. 缺数据时的降级：没有分母就只显示模型名；有分母没本轮输入合计就显示 `—`；
 *     本地缓存恢复的值必须标"上次已知"（不许假装是实时值）；全空则整行不渲染
 *  4. 分母/合计都拿不到时，不编任何数字
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ContextGauge from './ContextGauge.vue'
import { store } from '../stores/chat'

function setCtx(ctx: Partial<typeof store.context>): void {
  Object.assign(store.context, { model: null, limit: null, turnInput: null, stale: false, at: 0 }, ctx)
}

beforeEach(() => setCtx({}))

describe('ContextGauge：模型 + 窗口 + 本轮输入合计', () => {
  it('展示形态：模型 │ 窗口 1m │ 本轮输入合计 407.7k，没有百分比与进度条', () => {
    setCtx({ model: 'deepseek-flash', limit: 1_000_000, turnInput: 407_700 })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-model"]').text()).toBe('deepseek-flash')
    expect(w.find('[data-testid="ctx-limit"]').text()).toBe('窗口 1m')
    expect(w.find('[data-testid="ctx-turn-input"]').text()).toBe('本轮输入合计 407.7k')
    expect(w.text()).not.toContain('%')
    expect(w.text()).not.toContain('█')
    expect(w.find('[data-testid="ctx-bar"]').exists()).toBe(false)
    expect(w.find('[data-testid="ctx-usage"]').exists()).toBe(false)
  })

  it('数值再大也一律灰：不转黄、不转红（历史 bug：2.6m/1m 被算成 100% 转红）', () => {
    const toneOf = () => mount(ContextGauge).find('[data-testid="ctx-gauge"]').classes().join(' ')

    setCtx({ model: 'm', limit: 1_000_000, turnInput: 79_000 })
    expect(toneOf()).toContain('text-gray-400')
    expect(toneOf()).not.toContain('text-amber-600')

    // 累计值远超窗口（旧版这里会变红并显示 100%）
    setCtx({ model: 'm', limit: 1_000_000, turnInput: 2_600_000 })
    expect(toneOf()).toContain('text-gray-400')
    expect(toneOf()).not.toContain('text-red-600')
    expect(toneOf()).not.toContain('text-amber-600')
  })

  it('只有模型、没有分母（/api/model-info 没通）→ 只显示模型名，不编「窗口 1m」', () => {
    setCtx({ model: 'deepseek-flash', turnInput: 407_700 })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-model"]').exists()).toBe(true)
    expect(w.find('[data-testid="ctx-limit"]').exists()).toBe(false)
    // 分母没有但合计有 → 合计照常显示（两条独立的路）
    expect(w.find('[data-testid="ctx-turn-input"]').text()).toBe('本轮输入合计 407.7k')
  })

  it('有分母但本轮输入合计未知 → 显示 `本轮输入合计 —`（诚实：还不知道）', () => {
    setCtx({ model: 'deepseek-flash', limit: 1_000_000 })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-turn-input"]').text()).toBe('本轮输入合计 —')
  })

  it('本地缓存恢复的值必须标"上次已知 + 时刻"（不假扮实时）', () => {
    const at = new Date(2026, 8, 14, 12, 34).getTime()
    setCtx({ model: 'm', limit: 1_000_000, turnInput: 500_000, stale: true, at })
    const w = mount(ContextGauge)

    expect(w.find('[data-testid="ctx-stale"]').text()).toContain('上次已知 12:34')
  })

  it('什么数据都没有 → 整行不渲染（不占位）', () => {
    setCtx({})
    expect(mount(ContextGauge).find('[data-testid="ctx-gauge"]').exists()).toBe(false)
  })
})
