/**
 * 消息中心的「起始时间」筛选（v3.1，2026-09-22 用户提出）。
 *
 * 用户口径（原话）：默认当天 00:00:00；前端把这个时间传给后端，只查这个点**之后**的消息；
 * 也可以手动改成别的时间（比如今天 18:00）；**刷新页面就还原成当天 0 点，不用保存**。
 *
 * 因此这里只有**纯函数**，状态放在 store 的内存里 —— 不写 localStorage 是**有意的**
 * （"刷新即还原"就是他要的行为，写盘反而变成 bug）。
 *
 * 三个容易踩的点：
 *  1. `new Date('2026-09-22')` 按 **UTC** 解析，而我们要的是**本地墙钟时间** ⇒ 一律手写解析，不交给 Date 猜；
 *  2. 传给后端的串必须带**本地时区偏移**（`+08:00`），否则服务端只能按它的口径猜；
 *  3. 这个串进查询参数时 `+` 会被解析成空格 ⇒ 必须走 `URLSearchParams`（api 层负责），
 *     手工拼字符串会得到 400（服务端会明确报错，不静默）。
 */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM[:SS]`（本地墙钟）→ Date；解析不了给 null */
export function inputToDate(input: unknown): Date | null {
  const text = typeof input === 'string' ? input.trim() : ''
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  return Number.isNaN(dt.getTime()) ? null : dt
}

/** 默认起点 = **当天 00:00**（本地时间），给 `<input type="datetime-local">` 用的形态 */
export function defaultSinceInput(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T00:00`
}

/** 把界面上的值转成 Date（没有则 null） */
export function dateOf(input: string | null | undefined): Date | null {
  return inputToDate(input)
}

/**
 * 界面值 → 给后端的 ISO 串（**带本地偏移**）。
 * 空串/null → `null`（= 不限，看全部）。
 */
export function toApiSince(input: string | null | undefined): string | null {
  const d = inputToDate(input)
  if (!d) return null
  const offMin = -d.getTimezoneOffset() // 东八区 = 480
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 界面上那句人话：「今天 00:00 起」/「昨天 18:00 起」/「09-20 08:00 起」/「不限」 */
export function sinceLabel(input: string | null | undefined, now: Date = new Date()): string {
  const d = inputToDate(input)
  if (!d) return '不限'
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay(d, now)) return `今天 ${hm} 起`
  const yest = new Date(now.getTime())
  yest.setDate(yest.getDate() - 1)
  if (sameDay(d, yest)) return `昨天 ${hm} 起`
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm} 起` : `${d.getFullYear()}-${md} ${hm} 起`
}

/** 现在的界面值是不是"默认（当天 0 点）" —— 用来决定要不要给「今天 0 点」按钮加高亮 */
export function isDefaultSince(input: string | null | undefined, now: Date = new Date()): boolean {
  return (input ?? '') === defaultSinceInput(now)
}
