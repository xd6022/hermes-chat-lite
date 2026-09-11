import { describe, expect, it } from 'vitest'

/**
 * 测试环境哨兵：主题切换与侧栏折叠都依赖 localStorage。
 * vitest 环境下它默认是 undefined（Node 22+ 内置实现遮蔽了 jsdom 的），
 * 靠 src/test-setup.ts 的内存 Storage 兜住 —— 这条断言是那个 setup 的守卫：
 * 一旦 setupFiles 配置丢了，这里会立刻说明原因，而不是让 10 个 UI 用例以
 * "Cannot read properties of undefined" 的神秘方式挂掉。
 */
describe('测试环境', () => {
  it('localStorage 可用（主题/折叠功能的前提）', () => {
    expect(typeof localStorage).not.toBe('undefined')
    localStorage.setItem('__probe__', '1')
    expect(localStorage.getItem('__probe__')).toBe('1')
    localStorage.removeItem('__probe__')
    expect(localStorage.getItem('__probe__')).toBeNull()
    expect(localStorage.length).toBe(0)
  })
})
