import type { UiMessage } from '../stores/chat'

/**
 * 把扁平的段列表按"轮"分组（纯函数 —— 可单测，也能被真浏览器脚本复用）。
 *
 * 一轮 = 一个用户块 + 紧随其后的连续助手段（正文段 / 工具行段 按时间交替），
 * 直到下一个用户块为止。
 *
 * 为什么要分组（v2.11）：交错渲染之后一轮里会有好几个段（正文 → 工具行 → 正文 …），
 * 如果所有段都用同一个间距，**"同一轮内部的先后"与"两个不同轮次"看起来一样远**，
 * 读起来就分不清哪里是新一轮提问了。所以：轮内紧凑（`space-y-2`）、轮间留白（`mt-6`）。
 *
 * 边界情况：页面从中间翻开时，第一段可能是助手段（那一轮的用户块在更早的页里）
 * → `ask` 为 null，那些段仍归在这一轮里。
 */
export interface UiTurn {
  key: string
  /** 这一轮的提问（可能为 null：用户块不在已加载的页里） */
  ask: UiMessage | null
  /** 这一轮的助手段（按时间序：正文段 / 工具行段 交替） */
  segs: UiMessage[]
}

export function groupIntoTurns(msgs: UiMessage[]): UiTurn[] {
  const turns: UiTurn[] = []
  for (const m of msgs) {
    if (m.role === 'user') {
      turns.push({ key: m.key, ask: m, segs: [] })
      continue
    }
    const cur = turns[turns.length - 1]
    if (cur) cur.segs.push(m)
    else turns.push({ key: `t_${m.key}`, ask: null, segs: [m] })
  }
  return turns
}
