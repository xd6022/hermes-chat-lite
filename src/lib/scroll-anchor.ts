/**
 * "内容还在长"时怎么稳定贴底。
 *
 * 背景（真浏览器实测，见 docs 坑 50）：打开历史会话时，DOM 是**分波**插进去的 ——
 *   t=1427ms 只有一条消息 → scrollHeight=1205  → 应用此刻 toBottom()，scrollTop=1205（可滚 604）
 *   t=1449ms +56 个节点 → 2999
 *   t=1492ms +16 个节点 → 3510
 *   t=1509ms +1 个节点  → 3554   ← 全渲染完，但**再无任何滚动调用**
 * 结果：落点 = 锚定那一刻的内容高 − 可视高 → 会话越大偏得越多（实测 21% / 44% / 50%，
 * 内容不足一屏的甚至停在最上面；空会话看着"在底部"只是因为没内容）。
 *
 * 根因是"触发条件"不对：原先只由 `watch(tail)`（消息条数 + 最后一条正文字数）触发，
 * 而工具行/表格/字体这些"不改 tail 的长高"不会触发第二次锚定。
 *
 * 两个纯工具（好测，不依赖浏览器环境）：
 *  - `createHeightSettler`：判断"高度连续 N 帧不变" = 内容渲染稳定
 *  - `followUntilSettled`：每帧做一件事（通常=贴底），直到高度稳定或到时限
 */

export interface HeightSettler {
  /** 喂一次当前高度；返回 true = 本次刚判定为稳定 */
  push(h: number): boolean
  reset(): void
  readonly settled: boolean
}

/**
 * 高度稳定判定：连续 `stableFrames` 帧高度相同才算稳定。
 * 语义按"帧计数"：同一个高度**连续出现 `stableFrames` 次**（不是"出现后又变了那么多次"）。
 * 单看第一帧永远不算稳定 —— 那时还没有"连续"可言。
 */
export function createHeightSettler(stableFrames = 2): HeightSettler {
  let last = -1
  let same = 0
  let settled = false
  return {
    push(h: number): boolean {
      if (h === last) {
        same++
      } else {
        last = h
        same = 1 // 这一帧就是该高度的第 1 次
        settled = false
        return false
      }
      if (!settled && same >= stableFrames) {
        settled = true
        return true
      }
      return false
    },
    reset(): void {
      last = -1
      same = 0
      settled = false
    },
    get settled(): boolean {
      return settled
    },
  }
}

/** rAF 不存在时（老环境/测试）退化成 setTimeout(16) */
function nextFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
  else setTimeout(cb, 16)
}

export interface FollowOptions {
  /** 连续几帧高度不变算稳定（默认 2） */
  stableFrames?: number
  /** 兜底时限：内容一直长（例如流式）也不能永远循环（默认 1500ms） */
  maxMs?: number
  /** 注入时钟（测试用） */
  now?: () => number
}

/**
 * 每帧调用 `onFrame`（通常就是"贴底"），直到 `measure()` 的高度连续稳定 `stableFrames` 帧，
 * 或超过 `maxMs`（兜底，避免流式期间一直循环）。
 *
 * 用法：
 *   await followUntilSettled(() => scroller.scrollHeight, () => anchorNow())
 */
export function followUntilSettled(
  measure: () => number,
  onFrame: () => void,
  opts: FollowOptions = {},
): Promise<void> {
  const { stableFrames = 2, maxMs = 1500, now = () => Date.now() } = opts
  const settler = createHeightSettler(stableFrames)
  const start = now()
  return new Promise<void>((resolve) => {
    const step = (): void => {
      onFrame()
      const done = settler.push(measure())
      if (done || now() - start >= maxMs) {
        resolve()
        return
      }
      nextFrame(step)
    }
    step()
  })
}
