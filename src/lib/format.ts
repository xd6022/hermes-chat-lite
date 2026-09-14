/**
 * 时间与会话分组。
 *
 * 关键：Hermes 所有时间戳都是 **Unix 秒（float）**，直接 new Date(ts) 会得到 1970 年。
 */

import type { HermesSession } from '../api/types'

export function tsToDate(ts: number): Date {
  return new Date(ts * 1000)
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export type DayBucket = 'today' | 'yesterday' | 'earlier'

export const BUCKET_LABEL: Record<DayBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
}

/** 按自然日归类（用本地时区，不是 24 小时差） */
export function dayBucket(ts: number, nowMs = Date.now()): DayBucket {
  const diffDays = Math.round(
    (startOfLocalDay(new Date(nowMs)) - startOfLocalDay(tsToDate(ts))) / 86_400_000,
  )
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  return 'earlier'
}

export interface SessionGroup {
  bucket: DayBucket
  label: string
  items: HermesSession[]
}

const BUCKET_ORDER: DayBucket[] = ['today', 'yesterday', 'earlier']

/**
 * 输入已是按 last_active 倒序的列表，输出保持顺序。
 *
 * `nowMs` 可注入：不注入就用当前时间。**测试必须注入** —— 否则 fixture 里写死的
 * 日期会随着日子推进"变质"（实测：写死 9-11 的用例在 9-12 凌晨跑就挂了）。
 */
export function groupSessions(sessions: HermesSession[], nowMs = Date.now()): SessionGroup[] {
  const buckets: Record<DayBucket, HermesSession[]> = { today: [], yesterday: [], earlier: [] }
  for (const s of sessions) {
    const ts = s.last_active || s.started_at || 0
    buckets[dayBucket(ts, nowMs)].push(s)
  }
  return BUCKET_ORDER.filter((b) => buckets[b].length > 0).map((b) => ({
    bucket: b,
    label: BUCKET_LABEL[b],
    items: buckets[b],
  }))
}

export function formatClock(ts: number): string {
  const d = tsToDate(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatDate(ts: number): string {
  const d = tsToDate(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 侧栏标题：优先 title，其次 preview 截断，最后兜底文案 */
export function displayTitle(s: HermesSession): string {
  const t = (s.title ?? '').trim()
  if (t) return t
  const p = (s.preview ?? '').replace(/\s+/g, ' ').trim()
  if (p) return p.length > 30 ? `${p.slice(0, 30)}…` : p
  return '未命名会话'
}

/** 相对时间，用于侧栏悬浮提示 */
export function relativeTime(ts: number, nowMs = Date.now()): string {
  const diff = Math.max(0, nowMs - ts * 1000)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return formatDate(ts)
}

/* ---------- 每轮统计的展示格式 ---------- */

/** token 数压缩：1234 → 1.2k，27330 → 27.3k */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * 大数压缩（上下文水位/会话累计用）：407700 → 407.7k，1000000 → 1m，118842936 → 118.8m
 *
 * 与 formatTokens 的区别：这里有百万级的值，用 k 会读成 `118820k` 这种六位数，很难扫读；
 * 另外整数值不带小数点（`1m` 而不是 `1.0m`），跟 dashboard 状态栏的写法一致。
 */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${trim1(n / 1000)}k`
  return `${trim1(n / 1_000_000)}m`
}

/**
 * 保留 1 位小数；整数不补 `.0`。
 * 之所以保留小数：dashboard 状态栏写的就是 `407.7k`，取整成 `408k` 反而丢了信息。
 */
function trim1(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** 耗时：12.3s / 1m05s */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}
