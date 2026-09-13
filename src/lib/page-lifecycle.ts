/**
 * 页面生命周期 & 网络恢复的探测（v2.2）。
 *
 * 为什么需要它：手机上切到别的 App 后，浏览器会冻结页面 / 掐断 SSE 连接，甚至直接
 * 回收页面。**后台 JS 不可依赖**（定时器被 throttling、连接被系统断掉），所以这里
 * 只做一件事：**在"用户回到前台"这一刻把接力棒交出去**，由上层（stores/chat.ts 的
 * resumeSync）去问服务端要真实状态并补消息。
 *
 * 不做的事（刻意的）：
 *  - 不用 setInterval 轮询"保活"（后台必然被 throttle，还费电）
 *  - 不在 visibilitychange → hidden 时做清理（隐藏 ≠ 断开；清理放在服务端状态判定里）
 */

/** 页面此刻是否可见（无法判定时按"可见"处理，宁可多同步一次） */
export function isForeground(): boolean {
  if (typeof document === 'undefined') return true
  if (typeof document.visibilityState === 'undefined') return true
  return document.visibilityState === 'visible'
}

export type ResumeReason = 'visible' | 'focus' | 'online' | 'pageshow'

/**
 * 订阅"可能回到前台/网络恢复"的信号，返回取消订阅函数。
 *
 * 为什么四个都要：
 *  - `visibilitychange`：切回 App 的主信号（Android/iOS 都有）
 *  - `focus`：桌面端切窗口、部分浏览器不触发 visibilitychange 的情况
 *  - `pageshow`：从 bfcache 恢复（iOS Safari 上很常见，此时 JS 状态还在但连接已死）
 *  - `online`：移动网络从无信号恢复（切 Wi-Fi/5G 时连接会断）
 *
 * 统一交给同一个回调 —— 上层做幂等同步，重复触发没有副作用。
 */
export function watchForeground(onResume: (reason: ResumeReason) => void): () => void {
  if (typeof document === 'undefined') return () => {}

  const fireVisible = (reason: ResumeReason) => {
    if (isForeground()) onResume(reason)
  }
  const onVisibility = () => fireVisible('visible')
  const onFocus = () => fireVisible('focus')
  const onPageShow = () => fireVisible('pageshow')
  // online 不看可见性：网络恢复本身值得立刻同步一次（哪怕页面还在后台）
  const onOnline = () => onResume('online')

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('online', onOnline)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pageshow', onPageShow)
    window.removeEventListener('online', onOnline)
  }
}

/**
 * 重连/轮询的退避间隔：1s → 2s → 4s → 8s → 16s → 30s（封顶，不再涨）。
 * 不用固定间隔的原因：移动网络下短时间连续重试 = 请求风暴 + 费电；
 * 不无限退避的原因：用户在等结果，30s 是"能感觉到在动"的上限。
 */
export const BACKOFF_CAP_MS = 30_000

export function backoffDelay(attempt: number): number {
  // NaN / Infinity / 负数（调用方算错时）一律按第 0 次处理，别算出 NaN 毫秒把 setTimeout 变成"立即重试"
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  return Math.min(BACKOFF_CAP_MS, 1000 * 2 ** n)
}
