/**
 * "内容还在长"时稳定贴底的两个纯工具（坑 50 的修法）。
 * 这里锁死语义：稳定的判定、增长会打断稳定、兜底时限。
 */
import { describe, expect, it, vi } from 'vitest'
import { createHeightSettler, followUntilSettled } from './scroll-anchor'

describe('createHeightSettler：连续 N 帧高度不变 = 稳定', () => {
  it('第一次喂值不算稳定；连续两帧相同才算', () => {
    const s = createHeightSettler(2)
    expect(s.push(100)).toBe(false)
    expect(s.settled).toBe(false)
    expect(s.push(100)).toBe(true) // 第 2 帧相同 → 稳定
    expect(s.settled).toBe(true)
  })

  it('中间只要长高一次，稳定计数就清零（内容还在长的典型形态）', () => {
    const s = createHeightSettler(2)
    s.push(100)
    expect(s.push(100)).toBe(true)

    s.push(200) // 长高了 → 不再稳定
    expect(s.settled).toBe(false)
    expect(s.push(200)).toBe(true) // 又连续两帧 → 稳定
  })

  it('stableFrames=3 时要求连续三帧', () => {
    const s = createHeightSettler(3)
    s.push(5)
    expect(s.push(5)).toBe(false)
    expect(s.push(5)).toBe(true)
  })

  it('reset 后重新计数', () => {
    const s = createHeightSettler(1)
    s.push(9)
    expect(s.push(9)).toBe(true)
    s.reset()
    expect(s.settled).toBe(false)
  })
})

describe('followUntilSettled：每帧做一件事，直到稳定或到时限', () => {
  it('高度稳定后结束，且每帧都调用了 onFrame（贴底）', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    const heights = [100, 300, 300, 300]
    let frames = 0
    let mi = 0 // 测量下标（和"帧计数"分开，避免闭包里互相干扰）
    await followUntilSettled(
      () => heights[Math.min(mi++, heights.length - 1)],
      () => {
        frames++
      },
      { stableFrames: 2 },
    )
    // 100(第1次) → 300(第1次) → 300(连续第2次 = 稳定，结束)
    expect(frames).toBe(3)
    vi.unstubAllGlobals()
  })

  it('内容一直长（流式）也不能死循环：到 maxMs 就收手', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    let h = 0
    let t = 0
    let calls = 0
    await followUntilSettled(
      () => (h += 10),
      () => {
        calls++
      },
      { maxMs: 100, now: () => (t += 40) }, // 第 3 次调用就超时
    )
    expect(calls).toBeLessThanOrEqual(3)
    vi.unstubAllGlobals()
  })

  it('一上来就稳定（极端）也会结束', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    await followUntilSettled(
      () => 42,
      () => {},
      { stableFrames: 2 },
    )
    vi.unstubAllGlobals()
    expect(true).toBe(true)
  })
})
