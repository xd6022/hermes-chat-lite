/**
 * 消息中心的展示口径（纯函数）：等级灯、类型标签、时间格式化。
 *
 * 等级（用户 2026-09-22 定："加一个灯来表示级别，一眼看清楚"）：
 *   🔴 `action` = **要动手**（触发规则、建议减仓这类）
 *   🟡 `warn`   = 提示（确认、信号、接近阈值）
 *   ⚪ `info`   = 常规（日报/周报/简报/选股清单）
 *
 * ⚠️ 这套灯**与输入框上方那个四态状态灯不是同一套**，别互相套用文案：
 *    状态灯说的是"这一轮在干什么"，这里的灯说的是"这条消息要不要你动手"。
 *
 * 类型（`category`）库里存 **ASCII 代码**（`stock`/`email`/`alert`/`system`）——
 * 中文字面量进查询串会被 uvicorn 判成非法请求（实测），中文标签只在界面上映射。
 */

export type InboxLevel = 'action' | 'warn' | 'info'

export const LEVEL_META: Record<InboxLevel, { label: string; dot: string; text: string }> = {
  action: { label: '要动手', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400' },
  warn: { label: '提示', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  info: { label: '常规', dot: 'bg-gray-300 dark:bg-gray-600', text: 'text-gray-400 dark:text-gray-500' },
}

/** 服务端不认识的值 → 一律当 `info`（不报错、不空窗） */
export function normalizeLevel(v: unknown): InboxLevel {
  return v === 'action' || v === 'warn' || v === 'info' ? v : 'info'
}

export function levelMeta(v: unknown): { label: string; dot: string; text: string } {
  return LEVEL_META[normalizeLevel(v)]
}

/** 顶部筛选项（`all` = 不传 category）
 *
 * ⚠️ 没有 `邮件` 这一项了（2026-09-24）：邮件改走「邮件」tab 实时直读邮箱，不再进消息表；
 *    留着它只会筛出一堆历史旧行，等于两个入口说两件事。 */
export const CATEGORY_FILTERS: readonly { value: string; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'stock', label: '股票信号' },
  { value: 'alert', label: '提醒' },
  { value: 'system', label: '系统' },
]

const CATEGORY_LABELS: Record<string, string> = {
  stock: '股票信号',
  email: '邮件',
  alert: '提醒',
  system: '系统',
}

/** 类型代码 → 中文标签（未知代码原样显示，不吞信息） */
export function categoryLabel(code: unknown): string {
  const c = typeof code === 'string' ? code : ''
  return CATEGORY_LABELS[c] ?? c
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 消息时间：`今天 14:35` / `昨天 20:00` / `09-20 21:54` / 跨年 `2025-09-20 21:54`。
 *
 * 按**浏览器本地时区**显示（服务端给的是带 `+08:00` 的 ISO 串，`Date.parse` 认得）。
 * 解析失败就原样返回（宁可显示丑一点，也不要显示错的时间）。
 */
export function formatWhen(iso: unknown, nowMs: number = Date.now()): string {
  const raw = typeof iso === 'string' ? iso : ''
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return raw
  const d = new Date(t)
  const now = new Date(nowMs)
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay(d, now)) return `今天 ${hm}`

  const yest = new Date(nowMs)
  yest.setDate(yest.getDate() - 1)
  if (sameDay(d, yest)) return `昨天 ${hm}`

  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`
}

/** 精确到秒的钟点（抽屉页脚"上次更新"用） */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
