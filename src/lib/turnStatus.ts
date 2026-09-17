/**
 * 状态灯（四态）—— 把"现在是什么状态"算成一盏灯 + 一句中文状态词。
 *
 * 用户 2026-09-16 定的口径（"第一版做最简单的"）：
 *
 *   🟢 时刻准备着              默认态 —— 没有在跑的任务（"一眼知道我没在跑、可以发下一句"）
 *   🟡 忙碌中 {secs}s      这一轮在跑（含"连接暂断但服务端还在跑"）
 *   🟠 等待审批 / 已中断    等你介入，或这一轮被停
 *   🔴 失败（请重试）       出错 / 后端不可用
 *
 * 三条硬约束（都出自用户原话，别改回去）：
 *  ① 进行中**必须在动**（`pulse`）—— 静态黄灯跟"卡住了"长得一样；
 *  ② 灯**不看工具**（"不记录工具，不记录是否在调用工具"）⇒ 本函数的输入里没有 currentTool，
 *     状态词里也绝不出现工具名；
 *  ③ 灯是**派生量**不是状态 —— 现场算，不缓存、不落盘（所以没有"开始/结束"这类可变状态）。
 *
 * 为什么单独抽成纯函数：判据（尤其"什么时候才红"）是本次改动风险最集中的地方，
 * 一条一条单测锁住；组件里只负责把它画出来。
 */
import type { RunPhase } from '../stores/chat'

export type Light = 'green' | 'yellow' | 'orange' | 'red'

/**
 * 四态对应的表情（灯本身就是那个表情）。
 * **刻意只有四种颜色** —— 蓝色已随"不记工具"整条撤掉（用户 2026-09-16 定）。
 */
export const LIGHT_ICON: Record<Light, string> = {
  green: '🟢',
  yellow: '🟡',
  orange: '🟠',
  red: '🔴',
}

export interface StatusInput {
  phase: RunPhase
  /** 本地算的已用秒（`performance.now()` 口径；别用事件里的 ts —— 时钟/网络抖动会让它跳） */
  seconds: number
  /**
   * 这一轮的 `run_id`。**它回答"服务端到底有没有收到这一轮"**，是「重试」的唯一依据：
   * `null` = 根本没收到 ⇒ 重发安全；非 null = 收到了（可能已落库）⇒ 重发会出现两条输入。
   */
  runId: string | null
}

export interface Status {
  light: Light
  /** 灯的表情（跟 light 走，组件不用自己拼） */
  icon: string
  /** 状态词（中文；不含工具名） */
  text: string
  /** 进行中 → 组件给"在动"的脉冲效果 */
  pulse: boolean
  /** 显示「重试」按钮 —— 只有"服务端根本没收到"才给 */
  retry: boolean
}

function make(light: Light, text: string, opts: { pulse?: boolean; retry?: boolean } = {}): Status {
  return { light, icon: LIGHT_ICON[light], text, pulse: opts.pulse ?? false, retry: opts.retry ?? false }
}

function fmt(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(1)}s`
}

/**
 * 相位 → 灯 + 状态词。
 *
 * 判据表（与 `docs/plans/2026-09-16-turn-status-light.md` §1.4 一一对应）：
 *
 * | 相位 | 输出 |
 * | --- | --- |
 * | `thinking` / `tool` / `writing` / `background` | 🟡 `忙碌中 {secs}s`（在动） |
 * | `approval` | 🟠 `等待审批` |
 * | `aborted`  | 🟠 `已中断` |
 * | `error`    | 🔴 `失败（请重试）`（仅当 runId 为 null）/ 🔴 `失败` |
 * | `done` / `idle` | 🟢 `时刻准备着` —— **正文结束就回到空闲** |
 */
export function runStatus({ phase, seconds, runId }: StatusInput): Status {
  switch (phase) {
    // 忙碌：这一轮在跑。计时是"还要等多久"的唯一来源，只挂在这里。
    case 'thinking':
    case 'tool':
    case 'writing':
      return make('yellow', `忙碌中 ${fmt(seconds)}`, { pulse: true })

    // 连接断了/刚回前台，但**服务端那一轮还在跑**（v2.2 相位）。
    // 这条**绝不能报红**：切后台、锁屏、换 Wi-Fi/5G 都是常态，
    // 报红会让人以为跑着的长任务白费了（2026-09-13 真机纠偏过这条）。
    case 'background':
      return make('yellow', `忙碌中 ${fmt(seconds)}`, { pulse: true })

    // 等你介入。审批时**不带工具名** —— 下面那张审批卡片的标题已经在说同一个名字了。
    case 'approval':
      return make('orange', '等待审批')

    // 被停（用户点暂停 / 服务端取消 / 拿不到终态）—— 不是失败，所以不红。
    case 'aborted':
      return make('orange', '已中断')

    // 失败。文案跟着"能不能重试"走：
    //   runId === null  ⇒ 服务端根本没收到 ⇒ 提示重试并给按钮
    //   runId !== null  ⇒ 已收到（可能已落库）⇒ 只说失败，不给重试按钮
    //                     （重发会造成两条输入，比"少一个按钮"糟得多）
    case 'error':
      return runId === null
        ? make('red', '失败（请重试）', { retry: true })
        : make('red', '失败')

    // 默认态：没有在跑的任务。`done` 也回落到这里 —— 用户原话"正文结束了，就恢复到绿色"。
    // 文案是用户 2026-09-16 亲口定的："时刻准备着"（正合 `Ready` 那个正向信号的意思）。
    case 'done':
    case 'idle':
    default:
      return make('green', '时刻准备着')
  }
}
