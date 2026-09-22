/**
 * 消息中心轮询策略（v1）——**纯函数**，界面只负责画。
 *
 * 用户 2026-09-22 定的口径：
 *  - **默认 5 分钟**一次，可在 Settings 里手动改（改完立刻生效、免重建、**每设备独立**）；
 *  - 档位里必须有 **`关闭`**：周末那种"只想聊天、不想被邮件打扰"的场景关掉就行；
 *  - `关闭` 的语义是**完全停止定时拉取** —— 点图标/开抽屉也不自动拉，只有手动「立即刷新」才拉；
 *  - **不做**"按交易时段自动切换间隔"（隐式行为会让人困惑，他要的是"我自己改"）。
 *
 * 失败退避也放这里：连续失败按 ×2 逐级放大，**30 分钟封顶**（不无限退避，也不请求风暴）。
 */

export type PollSetting = 'off' | '30s' | '1m' | '5m' | '15m' | '30m' | '1h'

export const POLL_OPTIONS: readonly { value: PollSetting; label: string; ms: number }[] = [
  { value: 'off', label: '关闭（不自动拉取）', ms: 0 },
  { value: '30s', label: '30 秒', ms: 30_000 },
  { value: '1m', label: '1 分钟', ms: 60_000 },
  { value: '5m', label: '5 分钟', ms: 5 * 60_000 },
  { value: '15m', label: '15 分钟', ms: 15 * 60_000 },
  { value: '30m', label: '30 分钟', ms: 30 * 60_000 },
  { value: '1h', label: '1 小时', ms: 60 * 60_000 },
]

export const DEFAULT_POLL: PollSetting = '5m'

/** 失败退避上限：30 分钟（再久就像坏了） */
export const POLL_MAX_MS = 30 * 60_000

/** 认不出来的值一律回默认档（localStorage 里可能是旧值/手改的脏值，不能让它把轮询关掉） */
export function normalizePoll(v: unknown): PollSetting {
  const hit = POLL_OPTIONS.find((o) => o.value === v)
  return hit ? hit.value : DEFAULT_POLL
}

/** 档位对应的间隔毫秒（`off` = 0） */
export function pollMs(setting: unknown): number {
  const hit = POLL_OPTIONS.find((o) => o.value === normalizePoll(setting))
  return hit ? hit.ms : 0
}

/** 是否会自动轮询（`off` → false） */
export function isPolling(setting: unknown): boolean {
  return pollMs(setting) > 0
}

/**
 * 下一次拉取要等多久。
 * - `off` → 0（调用方据此**不排定时器**）
 * - 没失败 → 档位间隔
 * - 连续失败 n 次 → `间隔 × 2^n`，30 分钟封顶
 */
export function nextDelayMs(setting: unknown, failures: number): number {
  const base = pollMs(setting)
  if (base === 0) return 0
  const n = Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0
  if (n === 0) return base
  return Math.min(base * 2 ** Math.min(n, 8), POLL_MAX_MS)
}
