/**
 * 地址即状态（v2.12）—— 路由模块的用例。
 *
 * 这里锁的是"地址 ↔ 视图"的口径：什么地址算会话、什么算欢迎页、push/replace 的语义、
 * 以及"自己发起的导航也要分发"（pushState 不触发事件，这一条最容易漏，漏了就表现为
 * "点了侧栏，地址变了但画面没变"）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentRoute, markInitialRoute, navigate, onRouteChange, parseRoute, routeToUrl } from './route'

function resetLocation(): void {
  window.history.replaceState(null, '', '/')
  markInitialRoute({ kind: 'home' })
}

describe('parseRoute()：什么地址算"某个会话"', () => {
  it('空 / 裸 # / 单个斜杠 → 欢迎页', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' })
    expect(parseRoute('#')).toEqual({ kind: 'home' })
    expect(parseRoute('#/')).toEqual({ kind: 'home' })
  })

  it('#/s/<id> → 该会话（末尾斜杠也认）', () => {
    expect(parseRoute('#/s/api_1789467328_decb9504')).toEqual({
      kind: 'session',
      id: 'api_1789467328_decb9504',
    })
    expect(parseRoute('#/s/20260915_172336_00ed5f/')).toEqual({
      kind: 'session',
      id: '20260915_172336_00ed5f',
    })
  })

  it('★ id 为空 / 含非法字符 / 是别的路径 → 一律欢迎页（别把坏地址当会话）', () => {
    expect(parseRoute('#/s/')).toEqual({ kind: 'home' })
    expect(parseRoute('#/s')).toEqual({ kind: 'home' })
    expect(parseRoute('#/s/../../etc/passwd')).toEqual({ kind: 'home' })
    expect(parseRoute('#/settings')).toEqual({ kind: 'home' })
    expect(parseRoute('#foo')).toEqual({ kind: 'home' })
  })

  it('id 里的转义会解开（encodeURIComponent 的往返）', () => {
    expect(parseRoute(routeToUrl('a_b-c1'))).toEqual({ kind: 'session', id: 'a_b-c1' })
  })
})

describe('navigate()：改地址 + 分发', () => {
  beforeEach(resetLocation)

  it('进会话：hash 变成 #/s/<id>，订阅者收到路由', () => {
    const seen: string[] = []
    const off = onRouteChange((r) => seen.push(r.kind === 'session' ? r.id : 'home'))
    navigate('abc', { mode: 'push' })
    expect(window.location.hash).toBe('#/s/abc')
    expect(seen).toEqual(['abc'])
    off()
  })

  it('★ 回欢迎页：地址要**整个去掉 `#`**（不能留一个光秃秃的 #），并分发 home', () => {
    const seen: string[] = []
    navigate('abc', { mode: 'push' })
    const off = onRouteChange((r) => seen.push(r.kind))
    navigate(null, { mode: 'replace' })
    expect(window.location.hash).toBe('')
    expect(seen).toEqual(['home'])
    off()
  })

  it('replace 不进历史，push 进历史（返回键才有东西可回）', () => {
    const before = window.history.length
    navigate('a', { mode: 'replace' })
    expect(window.history.length).toBe(before)
    navigate('b', { mode: 'push' })
    expect(window.history.length).toBe(before + 1)
  })

  it('重复导航到同一个会话：不再分发（避免同一次变化跑两遍）', () => {
    const fn = vi.fn()
    const off = onRouteChange(fn)
    navigate('a', { mode: 'push' })
    navigate('a', { mode: 'push' })
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })

  it('★ 返回键/手改地址：popstate / hashchange 都要分发（且去重）', () => {
    const seen: string[] = []
    const off = onRouteChange((r) => seen.push(r.kind === 'session' ? r.id : 'home'))
    // 模拟"用户按了返回键"：地址已由浏览器改好，然后派发 popstate
    window.history.replaceState(null, '', '#/s/back1')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(seen).toEqual(['back1'])
    // 同一次变化再来一发 hashchange（浏览器可能两个都发）→ 不该重复分发
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(seen).toEqual(['back1'])
    off()
  })

  it('取消订阅后不再收到通知（组件卸载时用）', () => {
    const fn = vi.fn()
    const off = onRouteChange(fn)
    off()
    navigate('zzz', { mode: 'push' })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('currentRoute()', () => {
  it('读的是当前地址', () => {
    window.history.replaceState(null, '', '#/s/xyz')
    expect(currentRoute()).toEqual({ kind: 'session', id: 'xyz' })
    window.history.replaceState(null, '', '/')
    expect(currentRoute()).toEqual({ kind: 'home' })
  })
})
