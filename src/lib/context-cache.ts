/**
 * 上下文占用的本地缓存（ⓐ 口径：刷新后显示"上次已知"）。
 *
 * 为什么需要它：Hermes **不落库"当前上下文占用"** —— 那个值只有跑完一轮才知道
 * （= 本轮最后一次调用的 prompt tokens，即 dashboard 状态栏的 `last_prompt_tokens`）。
 * 所以刷新页面 / 切走再回来时，占用值只能靠浏览器自己记住；界面会明确标注"上次已知"，
 * 不假扮成实时值。
 *
 * 按会话分别记（`hcl.ctx.<sessionId>`），换会话不会串台。
 * 隐私模式 / localStorage 不可用时静默降级（返回 null），不抛错。
 */

const KEY = (sid: string): string => `hcl.ctx.${sid}`

export interface CachedContextUse {
  /** 当时记下的占用 token 数 */
  used: number
  /** 记录时刻（毫秒，本地时钟） */
  at: number
}

export function readContextUse(sid: string): CachedContextUse | null {
  try {
    const raw = localStorage.getItem(KEY(sid))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<CachedContextUse>
    if (typeof v?.used !== 'number' || !Number.isFinite(v.used) || v.used <= 0) return null
    return { used: v.used, at: typeof v.at === 'number' ? v.at : 0 }
  } catch {
    return null
  }
}

export function writeContextUse(sid: string, used: number, at = Date.now()): void {
  if (!Number.isFinite(used) || used <= 0) return
  try {
    localStorage.setItem(KEY(sid), JSON.stringify({ used, at }))
  } catch {
    /* 隐私模式：不持久化即可（本次会话内仍然看得到） */
  }
}
