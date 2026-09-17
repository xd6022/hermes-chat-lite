import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TurnAvatar from './TurnAvatar.vue'
import { avatar, DEFAULT_AVATAR, setAvatar } from '../lib/appearance'

/**
 * 轮首头像（2026-09-16 用户定：这里**只留头像**，状态灯全撤）。
 *
 * 回归网就一条要点：**轮首不许再出现任何状态灯/状态词** ——
 * 状态只由输入框上方那条四态状态行说（同一件事不在两处说）。
 */

const text = (w: ReturnType<typeof mount>) => w.text().replace(/\s+/g, ' ').trim()

describe('轮首头像', () => {
  beforeEach(() => setAvatar('')) // 恢复默认头像，避免用例互相影响

  it('只画头像', () => {
    const w = mount(TurnAvatar)
    expect(text(w)).toBe(DEFAULT_AVATAR)
  })

  it('**不画任何状态灯**（四态 + 已撤的蓝色，一个都不能有）', () => {
    const w = mount(TurnAvatar)
    for (const icon of ['🟢', '🟡', '🟠', '🔴', '🔵']) {
      expect(w.text()).not.toContain(icon)
    }
  })

  it('**不写任何状态词**（那些只属于输入框上方那条）', () => {
    const w = mount(TurnAvatar)
    for (const word of ['时刻准备着', '忙碌中', '等待审批', '已中断', '失败']) {
      expect(w.text()).not.toContain(word)
    }
  })

  it('头像可配：setAvatar 之后立刻变（不用重新构建）', () => {
    setAvatar('>_<')
    expect(avatar.value).toBe('>_<')
    expect(text(mount(TurnAvatar))).toBe('>_<')
  })

  it('头像清空 → 回到默认', () => {
    setAvatar('')
    expect(text(mount(TurnAvatar))).toBe(DEFAULT_AVATAR)
  })
})
