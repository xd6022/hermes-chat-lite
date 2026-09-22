/**
 * 消息中心的展示口径：等级灯、类型标签、时间格式化。
 *
 * 锁住的：
 *  1. 三档灯的**颜色与文案**（🔴要动手 / 🟡提示 / ⚪常规），且未知等级降级成 `info`（不报错、不空窗）；
 *  2. 类型代码 → 中文标签（`stock`→股票信号…），未知代码**原样显示**（不吞信息）；
 *  3. 时间按"今天 / 昨天 / MM-DD / 跨年"显示 —— 用**固定 now** 断言，否则用例会隔天变红。
 */
import { describe, expect, it } from 'vitest'
import { CATEGORY_FILTERS, categoryLabel, formatClock, formatWhen, levelMeta, normalizeLevel } from './inboxMeta'

describe('inboxMeta：等级灯', () => {
  it('三档灯的灯色与文案', () => {
    expect(levelMeta('action').dot).toBe('bg-red-500')
    expect(levelMeta('action').label).toBe('要动手')
    expect(levelMeta('warn').dot).toBe('bg-amber-500')
    expect(levelMeta('warn').label).toBe('提示')
    expect(levelMeta('info').dot).toContain('bg-gray-300')
    expect(levelMeta('info').label).toBe('常规')
  })

  it('未知/脏等级一律降级成 info（服务端将来加新等级也不会把界面打空）', () => {
    for (const bad of ['critical', '', null, undefined, 3, {}]) {
      expect(normalizeLevel(bad)).toBe('info')
      expect(levelMeta(bad).dot).toContain('bg-gray-300')
    }
  })
})

describe('inboxMeta：类型标签', () => {
  it('ASCII 代码 → 中文标签', () => {
    expect(categoryLabel('stock')).toBe('股票信号')
    expect(categoryLabel('email')).toBe('邮件')
    expect(categoryLabel('alert')).toBe('提醒')
    expect(categoryLabel('system')).toBe('系统')
  })

  it('未知代码原样显示，不显示成"未知"（不吞信息）', () => {
    expect(categoryLabel('other')).toBe('other')
    expect(categoryLabel(null)).toBe('')
  })

  it('筛选项第一项是"全部"，其余都是 ASCII 代码（中文进查询串会被 uvicorn 判非法）', () => {
    expect(CATEGORY_FILTERS[0]).toEqual({ value: 'all', label: '全部' })
    for (const f of CATEGORY_FILTERS.slice(1)) {
      expect(/^[a-z_]+$/.test(f.value)).toBe(true)
      expect(f.label).not.toBe(f.value)
    }
  })
})

describe('inboxMeta：时间显示', () => {
  // 固定 now：2026-09-22 20:00 本地时间（用例不能依赖真实时钟，否则隔天就红）
  const now = new Date(2026, 8, 22, 20, 0, 0).getTime()

  it('今天 / 昨天 / 更早 / 跨年 四档', () => {
    expect(formatWhen('2026-09-22T14:35:00+08:00', now)).toBe('今天 14:35')
    expect(formatWhen('2026-09-21T20:00:00+08:00', now)).toBe('昨天 20:00')
    expect(formatWhen('2026-09-18T09:32:00+08:00', now)).toBe('09-18 09:32')
    expect(formatWhen('2025-12-31T23:59:00+08:00', now)).toBe('2025-12-31 23:59')
  })

  it('解析不了就原样返回（宁可显示丑，也不要显示错的时间）', () => {
    expect(formatWhen('不是时间', now)).toBe('不是时间')
    expect(formatWhen(null, now)).toBe('')
  })

  it('formatClock 只给 HH:MM:SS，0/非法值给空串', () => {
    expect(formatClock(new Date(2026, 8, 22, 20, 3, 7).getTime())).toBe('20:03:07')
    expect(formatClock(0)).toBe('')
    expect(formatClock(NaN)).toBe('')
  })
})
