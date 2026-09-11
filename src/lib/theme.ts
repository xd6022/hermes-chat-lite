/**
 * 白天/黑夜主题。
 *
 * 三处必须一致（改动时三处一起改）：
 *  1. index.html 内联脚本 —— 首帧前定主题，避免闪白（FOUC）
 *  2. 这里 —— 运行中切换
 *  3. tailwind.config.js `darkMode: 'class'` —— 样式依赖 <html class="dark">
 *
 * 口径：手动选择 > 系统偏好。只切 class，不写回 localStorage 时保持"跟随系统"。
 */

import { ref } from 'vue'

export type Theme = 'light' | 'dark'

/** localStorage 键名（index.html 里硬编码了同一个键，改名要同步改） */
export const THEME_KEY = 'hcl.theme'

/** 当前生效主题（供 UI 显示图标） */
export const theme = ref<Theme>('light')

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null // 隐私模式下 localStorage 会抛
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  } catch {
    return false
  }
}

/** 只应用，不持久化（初始化用，避免把"跟随系统"冻成固定值） */
export function applyTheme(t: Theme): void {
  theme.value = t
  document.documentElement.classList.toggle('dark', t === 'dark')
  document.documentElement.style.colorScheme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#030712' : '#ffffff')
}

/** 用户显式选择：应用 + 持久化 */
export function setTheme(t: Theme): void {
  applyTheme(t)
  try {
    localStorage.setItem(THEME_KEY, t)
  } catch {
    /* 忽略：主题不是关键功能 */
  }
}

/** 启动时调用（main.ts）。读 localStorage，没有则跟随系统 */
export function initTheme(): Theme {
  const t = readStored() ?? (systemPrefersDark() ? 'dark' : 'light')
  applyTheme(t)
  return t
}

export function toggleTheme(): void {
  setTheme(theme.value === 'dark' ? 'light' : 'dark')
}
