import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, initTheme, setTheme, theme, toggleTheme, THEME_KEY } from './theme'

/** 伪造系统偏好（jsdom 默认没有 matchMedia） */
function stubSystemDark(dark: boolean): void {
  window.matchMedia = ((q: string) => ({
    matches: dark,
    media: q,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  document.documentElement.style.colorScheme = ''
  theme.value = 'light'
})

describe('主题（白天/黑夜）', () => {
  it('没有手动选择时跟随系统偏好', () => {
    stubSystemDark(true)
    expect(initTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    // 关键：跟随系统时不能写 localStorage，否则"系统改了主题"就永远追不上
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
  })

  it('系统是浅色时保持浅色', () => {
    stubSystemDark(false)
    expect(initTheme()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('手动选择优先于系统偏好，并被持久化', () => {
    stubSystemDark(true) // 系统深色
    localStorage.setItem(THEME_KEY, 'light') // 用户手动选过浅色
    expect(initTheme()).toBe('light')

    setTheme('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('toggleTheme 来回切换并同步 color-scheme', () => {
    stubSystemDark(false)
    initTheme()

    toggleTheme()
    expect(theme.value).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    toggleTheme()
    expect(theme.value).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('localStorage 不可用时（隐私模式）不抛异常', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => initTheme()).not.toThrow()

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => setTheme('dark')).not.toThrow()
    expect(document.documentElement.classList.contains('dark')).toBe(true) // 仍然切换了外观

    getItem.mockRestore()
    setItem.mockRestore()
    applyTheme('light')
  })
})
