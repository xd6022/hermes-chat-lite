/**
 * 「起始时间」纯函数：默认值、界面值↔API 值、人话文案。
 *
 * 锁住的（每条都对应一个会咬人的坑）：
 *  1. 默认 = **当天 00:00**（本地墙钟），不是 UTC 零点 —— `new Date('2026-09-22')` 会按 UTC 解析，早晚差 8 小时；
 *  2. 传给后端的串**必须带本地偏移**（`+08:00`），否则服务端只能猜；
 *  3. 空值 = `null` = **不限**（不是"从 1970 年起"，也不是"今天 0 点"）；
 *  4. 文案按"今天/昨天/MM-DD/跨年"分级，且**用固定 now 断言**（否则用例隔天就红）。
 */
import { describe, expect, it } from 'vitest'
import { defaultSinceInput, inputToDate, isDefaultSince, sinceLabel, toApiSince } from './inboxSince'

// 固定"现在"：2026-09-22 20:30 本地时间
const NOW = new Date(2026, 8, 22, 20, 30, 0)

describe('inboxSince：默认值', () => {
  it('默认是当天 00:00（本地墙钟），形态给 datetime-local 用', () => {
    expect(defaultSinceInput(NOW)).toBe('2026-09-22T00:00')
    expect(defaultSinceInput(new Date(2026, 0, 3, 23, 59, 59))).toBe('2026-01-03T00:00')
  })

  it('isDefaultSince：只有正好等于当天 0 点才算默认', () => {
    expect(isDefaultSince('2026-09-22T00:00', NOW)).toBe(true)
    expect(isDefaultSince('2026-09-22T18:00', NOW)).toBe(false)
    expect(isDefaultSince('', NOW)).toBe(false)
    expect(isDefaultSince(null, NOW)).toBe(false)
  })
})

describe('inboxSince：解析（不交给 Date 猜）', () => {
  it('日期时间按**本地**解析（若按 UTC 会差 8 小时）', () => {
    const d = inputToDate('2026-09-22T18:00')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(8) // 9 月
    expect(d.getDate()).toBe(22)
    expect(d.getHours()).toBe(18)
    expect(d.getMinutes()).toBe(0)
  })

  it('只给日期 → 当天 00:00；给到秒也认；空格分隔也认', () => {
    expect(inputToDate('2026-09-22')!.getHours()).toBe(0)
    expect(inputToDate('2026-09-22T18:00:07')!.getSeconds()).toBe(7)
    expect(inputToDate('2026-09-22 18:00')!.getHours()).toBe(18)
  })

  it('垃圾输入 → null（不抛异常）', () => {
    for (const bad of ['', null, undefined, '昨天下午', '2026-09-22T', '22/09/2026', {}]) {
      expect(inputToDate(bad as never)).toBe(null)
    }
  })
})

describe('inboxSince：给后端的串', () => {
  it('★ 带本地时区偏移（服务端靠它换算，不能省）', () => {
    const api = toApiSince('2026-09-22T00:00')!
    expect(api).toMatch(/^2026-09-22T00:00:00[+-]\d{2}:\d{2}$/)
    // 本机（容器/浏览器）时区若为东八区，偏移就是 +08:00
    const off = -new Date().getTimezoneOffset()
    if (off === 480) expect(api).toBe('2026-09-22T00:00:00+08:00')
  })

  it('秒补齐（datetime-local 只给到分钟）', () => {
    expect(toApiSince('2026-09-22T18:05')).toMatch(/18:05:00[+-]/)
  })

  it('★ 空值 = null = 不限（不是 1970 年）', () => {
    expect(toApiSince('')).toBe(null)
    expect(toApiSince(null)).toBe(null)
    expect(toApiSince('昨天')).toBe(null)
  })
})

describe('inboxSince：人话文案', () => {
  it('今天 / 昨天 / MM-DD / 跨年 四档，空值=不限', () => {
    expect(sinceLabel('2026-09-22T00:00', NOW)).toBe('今天 00:00 起')
    expect(sinceLabel('2026-09-22T18:00', NOW)).toBe('今天 18:00 起')
    expect(sinceLabel('2026-09-21T20:00', NOW)).toBe('昨天 20:00 起')
    expect(sinceLabel('2026-09-18T08:00', NOW)).toBe('09-18 08:00 起')
    expect(sinceLabel('2025-12-31T09:00', NOW)).toBe('2025-12-31 09:00 起')
    expect(sinceLabel('', NOW)).toBe('不限')
  })
})
