import { describe, expect, it } from 'vitest'
import { LIGHT_ICON, runStatus, type Light } from './turnStatus'
import type { RunPhase } from '../stores/chat'

/**
 * 状态灯四态的判据（用户 2026-09-16 口径）。
 *
 * 这些用例是本次改动的**主要回归网** —— 判据（尤其"什么时候才红"）全在这一层锁死，
 * 组件里只负责画。改动判据时先改这里。
 */

const s = (phase: RunPhase, seconds = 0, runId: string | null = null) => runStatus({ phase, seconds, runId })

describe('状态灯 · 时刻准备着（默认态）', () => {
  it('idle → 🟢 时刻准备着，不脉冲、不给重试', () => {
    const r = s('idle')
    expect(r.light).toBe('green')
    expect(r.icon).toBe('🟢')
    expect(r.text).toBe('时刻准备着')
    expect(r.pulse).toBe(false)
    expect(r.retry).toBe(false)
  })

  it('done → 也回到 🟢 时刻准备着（用户原话：正文结束了就恢复到空闲）', () => {
    expect(s('done')).toEqual(s('idle'))
  })
})

describe('状态灯 · 忙碌中', () => {
  it.each(['thinking', 'tool', 'writing'] as const)('%s → 🟡 忙碌中 + 计时 + 脉冲', (phase) => {
    const r = s(phase, 3.24)
    expect(r.light).toBe('yellow')
    expect(r.icon).toBe('🟡')
    expect(r.text).toBe('忙碌中 3.2s')
    expect(r.pulse).toBe(true)
  })

  it('**状态词里不出现工具**（"不记录工具，不记录是否在调用工具"）', () => {
    // tool 相位的文案与 thinking 完全一致：没有工具名、没有"正在使用 xx"
    expect(s('tool', 12.4).text).toBe(s('thinking', 12.4).text)
    expect(s('tool', 12.4).text).toMatch(/^忙碌中 \d+\.\ds$/)
  })

  it('计时保留一位小数，负数不会漏出去', () => {
    expect(s('thinking', 0).text).toBe('忙碌中 0.0s')
    expect(s('thinking', -5).text).toBe('忙碌中 0.0s')
    expect(s('thinking', 1234.56).text).toBe('忙碌中 1234.6s')
  })

  it('**连接暂断但服务端还在跑（background）也不是红**（9/13 真机纠偏过这条）', () => {
    const r = s('background', 8)
    expect(r.light).toBe('yellow')
    expect(r.text).toBe('忙碌中 8.0s')
    expect(r.retry).toBe(false)
  })
})

describe('状态灯 · 橙色（等你介入）', () => {
  it('approval → 🟠 等待审批，且**不带工具名**（审批卡片标题已经在说）', () => {
    const r = s('approval', 5)
    expect(r.light).toBe('orange')
    expect(r.icon).toBe('🟠')
    expect(r.text).toBe('等待审批')
    expect(r.pulse).toBe(false)
  })

  it('aborted → 🟠 已中断（不是失败，所以不红）', () => {
    const r = s('aborted')
    expect(r.light).toBe('orange')
    expect(r.text).toBe('已中断')
  })
})

describe('状态灯 · 红色（失败）与「重试」判据', () => {
  it('runId 为 null（服务端根本没收到）→ 🔴 失败（请重试）+ 给重试', () => {
    const r = s('error', 0, null)
    expect(r.light).toBe('red')
    expect(r.icon).toBe('🔴')
    expect(r.text).toBe('失败（请重试）')
    expect(r.retry).toBe(true)
  })

  it('runId 非 null（服务端已收到、可能已落库）→ 🔴 失败，**不给重试**（重发会造成两条输入）', () => {
    const r = s('error', 0, 'run_abc123')
    expect(r.light).toBe('red')
    expect(r.text).toBe('失败')
    expect(r.retry).toBe(false)
  })

  it('只有 error 相位是红的（其余相位一个都不能红）', () => {
    const phases: RunPhase[] = ['idle', 'thinking', 'tool', 'approval', 'writing', 'background', 'done', 'aborted']
    for (const p of phases) {
      expect(s(p, 1, null).light).not.toBe('red')
    }
  })
})

describe('状态灯 · 色板', () => {
  it('只有四种颜色 —— 蓝色已随"不记工具"整条撤掉', () => {
    expect(Object.keys(LIGHT_ICON).sort()).toEqual(['green', 'orange', 'red', 'yellow'])
    expect(Object.values(LIGHT_ICON)).not.toContain('🔵')
    expect(Object.values(LIGHT_ICON)).toEqual(['🟢', '🟡', '🟠', '🔴'])
  })

  it('icon 永远跟着 light 走（组件不用自己拼表情）', () => {
    const phases: RunPhase[] = ['idle', 'thinking', 'approval', 'error']
    for (const p of phases) {
      const r = s(p, 1, null)
      expect(r.icon).toBe(LIGHT_ICON[r.light as Light])
    }
  })
})
