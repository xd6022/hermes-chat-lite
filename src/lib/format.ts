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

/** 输入已是按 last_active 倒序的列表，输出保持顺序 */
export function groupSessions(sessions: HermesSession[]): SessionGroup[] {
  const buckets: Record<DayBucket, HermesSession[]> = { today: [], yesterday: [], earlier: [] }
  for (const s of sessions) {
    const ts = s.last_active || s.started_at || 0
    buckets[dayBucket(ts)].push(s)
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
