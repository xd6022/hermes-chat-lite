/**
 * 「本轮输入合计」的本地缓存（ⓐ 口径：刷新后显示"上次已知"）。
 *
 * 为什么需要它：Hermes **不落库这个值** —— 只有跑完一轮才知道
 * （= 该轮内每次 API 调用的 prompt 累加，见 `stores/chat.ts::rememberContextUse`）。
 * 所以刷新页面 / 切走再回来时，占用值只能靠浏览器自己记住；界面会明确标注"上次已知"，
 * 不假扮成实时值。
 *
 * 按会话分别记（`hcl.ctx.<sessionId>`），换会话不会串台。
 * 隐私模式 / localStorage 不可用时静默降级（返回 null），不抛错。
 * 字段名从 `used` 改成 `turnInput`（v2.8，同名却实为"累计输入"是上次口径 bug 的根源）：
 * 旧条目会读成"没有缓存"，界面暂时显示 `—` 直到下一轮跑完，不做迁移。
 */

const KEY = (sid: string): string => `hcl.ctx.${sid}`

export interface CachedContextUse {
  /** 当时记下的「本轮输入合计」token 数 */
  turnInput: number
  /** 记录时刻（毫秒，本地时钟） */
  at: number
}

export function readContextUse(sid: string): CachedContextUse | null {
  try {
    const raw = localStorage.getItem(KEY(sid))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<CachedContextUse>
    if (typeof v?.turnInput !== 'number' || !Number.isFinite(v.turnInput) || v.turnInput <= 0) return null
    return { turnInput: v.turnInput, at: typeof v.at === 'number' ? v.at : 0 }
  } catch {
    return null
  }
}

export function writeContextUse(sid: string, turnInput: number, at = Date.now()): void {
  if (!Number.isFinite(turnInput) || turnInput <= 0) return
  try {
    localStorage.setItem(KEY(sid), JSON.stringify({ turnInput, at }))
  } catch {
    /* 隐私模式：不持久化即可（本次会话内仍然看得到） */
  }
}
