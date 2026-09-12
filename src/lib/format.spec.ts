import { describe, expect, it } from 'vitest'
import {
  dayBucket,
  displayTitle,
  formatClock,
  formatDurationMs,
  formatPercent,
  formatTokens,
  groupSessions,
  tsToDate,
} from './format'
import type { HermesSession } from '../api/types'

function sess(id: string, lastActiveMs: number, extra: Partial<HermesSession> = {}): HermesSession {
  const sec = lastActiveMs / 1000
  return { id, source: 'tui', started_at: sec, last_active: sec, ...extra }
}

const NOW = new Date(2026, 8, 11, 15, 0, 0).getTime() // 2026-09-11 15:00 本地

describe('时间戳口径', () => {
  it('服务端时间戳是 Unix 秒，不是毫秒', () => {
    const d = tsToDate(1789123327.23)
    expect(d.getFullYear()).toBeGreaterThan(2020) // 若当毫秒处理会得到 1970
  })

  it('按自然日划分，不是按 24 小时差', () => {
    expect(dayBucket(new Date(2026, 8, 11, 0, 5).getTime() / 1000, NOW)).toBe('today')
    expect(dayBucket(new Date(2026, 8, 10, 23, 55).getTime() / 1000, NOW)).toBe('yesterday')
    expect(dayBucket(new Date(2026, 8, 9, 23, 55).getTime() / 1000, NOW)).toBe('earlier')
  })

  it('formatClock 补零', () => {
    expect(formatClock(new Date(2026, 8, 11, 9, 5).getTime() / 1000)).toBe('09:05')
  })
})

describe('会话分组', () => {
  it('按 今天/昨天/更早 分组且保持倒序', () => {
    const list = [
      sess('a', new Date(2026, 8, 11, 14, 0).getTime()),
      sess('b', new Date(2026, 8, 11, 9, 0).getTime()),
      sess('c', new Date(2026, 8, 10, 12, 0).getTime()),
      sess('d', new Date(2026, 7, 1, 12, 0).getTime()),
    ]
    // 必须注入 NOW：不注入会用真实 Date.now()，这些写死的日期过一天就"变质"
    //（实测 9-12 凌晨跑时 '今天' 全部变成 '昨天'，用例无辜挂掉）
    const groups = groupSessions(list, NOW)
    expect(groups.map((g) => g.label)).toEqual(['今天', '昨天', '更早'])
    expect(groups[0].items.map((s) => s.id)).toEqual(['a', 'b'])
    expect(groups[1].items.map((s) => s.id)).toEqual(['c'])
    expect(groups[2].items.map((s) => s.id)).toEqual(['d'])
  })

  it('空列表不产生空分组', () => {
    expect(groupSessions([])).toEqual([])
  })
})

describe('侧栏标题', () => {
  it('优先 title', () => {
    expect(displayTitle(sess('a', 0, { title: '股票分析' }))).toBe('股票分析')
  })

  it('无 title 用 preview 截断到 30 字', () => {
    const long = '一'.repeat(40)
    const out = displayTitle(sess('a', 0, { title: null, preview: long }))
    expect(out).toHaveLength(31) // 30 字 + 省略号
    expect(out.endsWith('…')).toBe(true)
  })

  it('都没有时兜底', () => {
    expect(displayTitle(sess('a', 0, { title: '', preview: null }))).toBe('未命名会话')
  })
})

describe('每轮统计的展示格式', () => {
  it('formatTokens：千位压缩', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(27330)).toBe('27.3k')
    expect(formatTokens(141157)).toBe('141k')
  })

  it('formatDurationMs：秒/分', () => {
    expect(formatDurationMs(38400)).toBe('38.4s')
    expect(formatDurationMs(6600)).toBe('6.6s')
    expect(formatDurationMs(65000)).toBe('1m05s')
    expect(formatDurationMs(Number.NaN)).toBe('—')
  })

  it('formatPercent：四舍五入', () => {
    expect(formatPercent(0.974)).toBe('97%')
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
  })
})
