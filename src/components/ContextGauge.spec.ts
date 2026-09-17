/**
 * 输入框上方那一行：模型 + 窗口上限 + 本轮输入合计。
 *
 * 锁住四件事：
 *  1. 展示形态＝`模型 │ 窗口 1m │ 本轮输入合计 112.3k` —— **没有百分比、没有进度条**
 *     （旧版那排 `2.6m/1m [██████████] 100%` 是拿"本轮累计输入"除窗口算出来的假水位，
 *      2026-09-15 查实：那一轮单次最大 prompt 只有 125k/1M）
 *  2. 任何数值都**不转黄、不转红** —— 整行一律灰（用户 2026-09-15 明确要求）
 *  3. 缺数据时的降级：没有分母就只显示模型名；有分母没本轮输入合计就显示 `—`；
 *     全空则整段不渲染（含前导分隔符，不留孤零零的 `│`）
 *  4. 分母/合计都拿不到时，不编任何数字
 *  5. ⚠️ 2026-09-17 起**并入状态行**（原来自己占一行），且用户要求**不再显示「· 上次已知 HH:MM」**；
 *     值仍可能来自本地缓存 —— 解释留在 tooltip 里（悬停才看得到），界面上不摆
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

  it('值是本地缓存来的 → **也不再显示「上次已知」那半句**（2026-09-17 用户要求去掉）', () => {
    const at = new Date(2026, 8, 14, 12, 34).getTime()
    setCtx({ model: 'm', limit: 1_000_000, turnInput: 500_000, stale: true, at })
    const w = mount(ContextGauge)

    // 数字照常显示，但那半句（连同它的 testid）不许再出现在界面上
    expect(w.find('[data-testid="ctx-turn-input"]').text()).toBe('本轮输入合计 500k')
    expect(w.find('[data-testid="ctx-stale"]').exists()).toBe(false)
    expect(w.text()).not.toContain('上次已知')
    // 诚实性没有丢：只是挪进 tooltip（悬停才看得到），界面不摆
    expect(w.find('[data-testid="ctx-gauge"]').attributes('title')).toContain('上次已知')
  })

  it('前导分隔符只在有内容时出现 —— 全空时不渲染孤零零的 `│`', () => {
    setCtx({})
    expect(mount(ContextGauge).find('[data-testid="ctx-gauge"]').exists()).toBe(false)

    setCtx({ model: 'm' })
    const w = mount(ContextGauge)
    // 有内容 → 恰好一个前导分隔符（把它和状态词隔开）
    expect(w.text().startsWith('│')).toBe(true)
    expect(w.text().split('│').length - 1).toBe(1)
  })

  it('什么数据都没有 → 整行不渲染（不占位）', () => {
    setCtx({})
    expect(mount(ContextGauge).find('[data-testid="ctx-gauge"]').exists()).toBe(false)
  })
  // ⚠️ 手机端（< lg）两件事靠 Tailwind 的 `max-lg:` 变体实现 —— jsdom 不跑媒体查询、
  // 算不出真实显隐，所以这里**锁的是"class 在不在位"这个契约**（真显隐由真浏览器探针量）。
  it('手机端契约：整行缩号 +「窗口 1m」连同其前导分隔符一起 max-lg:hidden', () => {
    setCtx({ model: 'm', limit: 1_000_000, turnInput: 500_000 })
    const w = mount(ContextGauge)

    // 整行字号在手机端更小（10px）
    expect(w.find('[data-testid="ctx-gauge"]').classes()).toContain('max-lg:text-[10px]')

    const spans = w.findAll('[data-testid="ctx-gauge"] > span')
    // 桌面顺序：│ 模型 │ 窗口 │ 合计  ⇒ 找到「窗口」段，它和**它前面那个** │ 都必须带 max-lg:hidden
    const limitIdx = spans.findIndex((s) => s.text().startsWith('窗口'))
    expect(limitIdx).toBeGreaterThan(0)
    expect(spans[limitIdx].classes()).toContain('max-lg:hidden')
    expect(spans[limitIdx - 1].text()).toBe('│')
    expect(spans[limitIdx - 1].classes()).toContain('max-lg:hidden')

    // 合计段的前导 │ 与合计本身**不许**隐藏（手机端仍要看到模型 + 合计）
    const turnIdx = spans.findIndex((s) => s.text().startsWith('本轮输入合计'))
    expect(spans[turnIdx].classes()).not.toContain('max-lg:hidden')
    expect(spans[turnIdx - 1].text()).toBe('│')
    expect(spans[turnIdx - 1].classes()).not.toContain('max-lg:hidden')
  })

  it('手机端隐藏「窗口」不依赖数据：limit 缺失时那段本就不渲染（两种隐藏都不留光杆 │）', () => {
    setCtx({ model: 'm', turnInput: 500_000 }) // 没有 limit
    const w = mount(ContextGauge)
    const spans = w.findAll('[data-testid="ctx-gauge"] > span')
    // │ 模型 │ 合计 —— 分隔符数量与可见段严格对应
    expect(spans.filter((s) => s.text() === '│').length).toBe(2)
    expect(spans.filter((s) => s.text().startsWith('窗口')).length).toBe(0)
  })
})
