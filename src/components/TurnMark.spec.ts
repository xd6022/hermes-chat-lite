import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TurnMark from './TurnMark.vue'
import { avatar, DEFAULT_AVATAR, setAvatar } from '../lib/appearance'

/**
 * 轮首戳：每一轮开头的「头像 + 状态灯」（用户 2026-09-16 定）。
 *
 * 两条口径要锁住：
 *  ① **只给灯、不写状态词** —— 状态词由输入框上方那条统一说（同一件事不在两处说）；
 *  ② 跑着时（🟡）那个点在动（"一眼看出还在跑"是用户硬要求）。
 */

const text = (w: ReturnType<typeof mount>) => w.text().replace(/\s+/g, ' ').trim()

describe('轮首戳', () => {
  beforeEach(() => setAvatar('')) // 恢复默认头像，避免用例互相影响

  it('四态各自画对表情，且都带头像', () => {
    const cases = [
      ['green', '🟢'],
      ['yellow', '🟡'],
      ['orange', '🟠'],
      ['red', '🔴'],
    ] as const
    for (const [light, icon] of cases) {
      const w = mount(TurnMark, { props: { light } })
      expect(w.find('[data-testid="turn-mark-light"]').text()).toBe(icon)
      expect(text(w)).toContain(DEFAULT_AVATAR)
    }
  })

  it('只给灯、不写状态词（状态词由输入框上方那条统一说）', () => {
    const w = mount(TurnMark, { props: { light: 'yellow' } })
    const t = text(w)
    expect(t).toContain(DEFAULT_AVATAR)
    expect(t).toContain('🟡')
    // 除了头像和灯，这一行不该有任何别的文字（视觉间距靠 CSS gap，不是空格）
    expect(t.replace(DEFAULT_AVATAR, '').replace('🟡', '').trim()).toBe('')
    for (const word of ['忙碌中', '空闲中', '等待审批', '已中断', '失败']) {
      expect(t).not.toContain(word)
    }
  })

  it('只有忙碌中那个点在动，其余静止', () => {
    const busy = mount(TurnMark, { props: { light: 'yellow' } })
    expect(busy.find('[data-testid="turn-mark-light"]').classes()).toContain('animate-pulse')

    for (const light of ['green', 'orange', 'red'] as const) {
      const w = mount(TurnMark, { props: { light } })
      expect(w.find('[data-testid="turn-mark-light"]').classes()).not.toContain('animate-pulse')
    }
  })

  it('头像可配：setAvatar 之后立刻变（不用重新构建）', () => {
    setAvatar('>_<')
    expect(avatar.value).toBe('>_<')
    const w = mount(TurnMark, { props: { light: 'green' } })
    expect(text(w)).toContain('>_<')
  })

  it('头像清空 → 回到默认', () => {
    setAvatar('')
    const w = mount(TurnMark, { props: { light: 'green' } })
    expect(text(w)).toContain(DEFAULT_AVATAR)
  })
})
