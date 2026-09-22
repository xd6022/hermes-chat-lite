/**
 * 消息中心轮询策略：档位、默认值、失败退避。
 *
 * 锁四件事（用户 2026-09-22 定的口径）：
 *  1. 默认 **5 分钟**；
 *  2. 档位里必须有 **`关闭`**，且 `关闭` ⇒ 间隔 0（调用方据此**不排定时器**）；
 *  3. `关闭` 档即使连续失败也必须是 0 —— 不能"退避"出一个定时器来偷偷拉；
 *  4. 连续失败按 ×2 放大，**30 分钟封顶**；脏值/旧值一律回默认档（不能被 localStorage 里的坏值关掉轮询）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLL, POLL_MAX_MS, POLL_OPTIONS, isPolling, nextDelayMs, normalizePoll, pollMs } from './inboxPoll'

describe('inboxPoll：轮询档位', () => {
  it('默认档是 5 分钟', () => {
    expect(DEFAULT_POLL).toBe('5m')
    expect(pollMs(DEFAULT_POLL)).toBe(5 * 60_000)
  })

  it('档位里有「关闭」，且它等于不轮询', () => {
    expect(POLL_OPTIONS.some((o) => o.value === 'off')).toBe(true)
    expect(pollMs('off')).toBe(0)
    expect(isPolling('off')).toBe(false)
    expect(isPolling('5m')).toBe(true)
  })

  it('档位表全部可解析，数值单调递增（除了 off）', () => {
    const list = POLL_OPTIONS.filter((o) => o.value !== 'off').map((o) => o.ms)
    expect(list.every((ms, i) => i === 0 || ms > list[i - 1])).toBe(true)
  })

  it('认不出来的值（null / 空串 / 旧值 / 数字）一律回默认档 5 分钟', () => {
    for (const bad of [null, undefined, '', '10m', 'offf', 5, {}, '5M']) {
      expect(normalizePoll(bad)).toBe('5m')
      expect(pollMs(bad)).toBe(5 * 60_000)
    }
  })
})

describe('inboxPoll：失败退避', () => {
  it('没失败就是档位间隔', () => {
    expect(nextDelayMs('5m', 0)).toBe(5 * 60_000)
    expect(nextDelayMs('30s', 0)).toBe(30_000)
  })

  it('连续失败 ×2 放大，30 分钟封顶', () => {
    expect(nextDelayMs('5m', 1)).toBe(10 * 60_000)
    expect(nextDelayMs('5m', 2)).toBe(20 * 60_000)
    expect(nextDelayMs('5m', 3)).toBe(POLL_MAX_MS) // 40 分钟 → 封顶 30 分钟
    expect(nextDelayMs('1m', 9)).toBe(POLL_MAX_MS)
  })

  it('★ 「关闭」档永远不排定时器：失败多少次都得是 0', () => {
    expect(nextDelayMs('off', 0)).toBe(0)
    expect(nextDelayMs('off', 3)).toBe(0)
    expect(nextDelayMs('off', 99)).toBe(0)
  })

  it('脏参数不产生 NaN / 负数（NaN 会让 setTimeout 变成"立即重试"）', () => {
    expect(nextDelayMs('5m', NaN)).toBe(5 * 60_000)
    expect(nextDelayMs('5m', -3)).toBe(5 * 60_000)
    expect(nextDelayMs('5m', 1.7)).toBe(10 * 60_000) // 向下取整 → 1 次
  })
})
