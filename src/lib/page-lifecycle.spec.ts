/**
 * 页面生命周期信号（v2.2 后台恢复的入口）。
 *
 * 这里锁的是"什么算回到前台"和"退避怎么涨"这两件纯逻辑 —— 它们决定了恢复机制
 * 会不会变成请求风暴，或者永远不触发。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKOFF_CAP_MS, backoffDelay, isForeground, watchForeground } from './page-lifecycle'

function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
}

afterEach(() => {
  setVisibility('visible')
  vi.restoreAllMocks()
})

describe('isForeground', () => {
  it('看 document.visibilityState', () => {
    setVisibility('hidden')
    expect(isForeground()).toBe(false)
    setVisibility('visible')
    expect(isForeground()).toBe(true)
  })
})

describe('backoffDelay：1s 起步、翻倍、30s 封顶', () => {
  it('前六次的间隔就是需求里写的那串数字', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
  })

  it('继续涨也不会超过上限（避免"等到天荒地老"）', () => {
    expect(backoffDelay(9)).toBe(BACKOFF_CAP_MS)
    expect(backoffDelay(99)).toBe(BACKOFF_CAP_MS)
  })

  it('非法/负数不会算出奇怪的间隔', () => {
    expect(backoffDelay(-3)).toBe(1000)
    expect(backoffDelay(NaN)).toBe(1000)
  })
})

describe('watchForeground：只把"回来了"这件事交出去', () => {
  it('可见时 visibilitychange 触发；隐藏时不触发（隐藏 ≠ 要同步）', () => {
    const cb = vi.fn()
    const off = watchForeground(cb)
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cb).toHaveBeenCalledWith('visible')

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(cb).toHaveBeenCalledTimes(1)
    off()
  })

  it('focus / pageshow / online 都会触发（桌面切窗口、iOS bfcache、切网都要覆盖）', () => {
    const cb = vi.fn()
    const off = watchForeground(cb)
    setVisibility('visible')
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('pageshow'))
    window.dispatchEvent(new Event('online'))
    expect(cb.mock.calls.map((c) => c[0])).toEqual(['focus', 'pageshow', 'online'])
    off()
  })

  it('online 不要求可见（网络恢复本身就值得立刻同步一次）', () => {
    const cb = vi.fn()
    const off = watchForeground(cb)
    setVisibility('hidden')
    window.dispatchEvent(new Event('online'))
    expect(cb).toHaveBeenCalledWith('online')
    off()
  })

  it('取消订阅后不再回调（组件卸载不能留下野监听）', () => {
    const cb = vi.fn()
    watchForeground(cb)()
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    expect(cb).not.toHaveBeenCalled()
  })
})
