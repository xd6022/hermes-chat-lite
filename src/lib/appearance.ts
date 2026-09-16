/**
 * 外观小配置 —— 目前只有"轮首那个头像"。
 *
 * 用户 2026-09-16 定：**放在这里方便随时改**，不用翻组件；
 * 默认值写在代码里，Settings 面板可以覆盖（存浏览器）——
 * 改完**立刻生效，不用重新构建**（这是 B 方案的全部意义）。
 */
import { ref } from 'vue'

const KEY = 'hcl.avatar'

/** 默认头像。想换就改这一行（或者直接在 Settings 里改，不用动代码）。 */
export const DEFAULT_AVATAR = '-_-'

function read(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_AVATAR
  } catch {
    return DEFAULT_AVATAR // 隐私模式：不持久化即可
  }
}

/** 轮首戳显示的头像（响应式：Settings 里改完界面立刻变） */
export const avatar = ref(read())

/** 设成自定义值（空串 = 恢复默认）。截断到 8 字符，防止把布局撑坏。 */
export function setAvatar(v: string): void {
  const t = v.trim().slice(0, 8)
  avatar.value = t || DEFAULT_AVATAR
  try {
    if (t) localStorage.setItem(KEY, t)
    else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式：内存里生效即可 */
  }
}

/** 恢复默认头像 */
export function resetAvatar(): void {
  setAvatar('')
}
