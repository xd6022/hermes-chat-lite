/**
 * 安全闸门相关（纯函数，方便单测）。
 *
 * 背景：网页客户端走 `chat/stream`，而 Hermes 的**审批通道只存在于 `/v1/runs`**
 * （`register_gateway_notify` / `_run_approval_sessions` 都在 `_handle_runs` 里）。
 * 于是 `chat/stream` 这条路上：
 *   - 需要人工批准的操作 → 没有可用的通知者 → 立即 fail-closed 拒绝（不会静默卡住）
 *   - 结果就是工具时间线上只出现一个 ✗，用户完全看不懂刚才发生了什么
 *
 * 而 `tool.failed` 事件**只带工具名、不带结果**（实测载荷：`message_id, tool_name,
 * preview, args`），所以拦下的原因只能从 `run.completed.messages` 的整轮 transcript
 * 里捞（那里有 role=tool 的原文）。
 */

export type SecurityBlockKind = 'approval' | 'rule'

export interface SecurityBlock {
  kind: SecurityBlockKind
  /** 给用户看的一句话解释 */
  hint: string
  /** 服务端原文片段（截断，供想深究时看一眼） */
  snippet: string
}

/**
 * 判据取自服务端源码 `tools/approval.py` 的**实际文案**（不是猜的）：
 *   "BLOCKED: approval required (...)"                    需要人工批准但无人可问
 *   "BLOCKED: Failed to send approval request to user..."  同上（notify 失败）
 *   "BLOCKED: Action timed out without user response..."   审批超时（默认 300s）
 *   "BLOCKED: User denied this potentially dangerous action..."
 *   "BLOCKED: Command flagged as dangerous (...)"
 *   "BLOCKED (hardline): ..." / "BLOCKED: ... user-defined deny rule ..."
 */
const APPROVAL_MARKERS = [
  'approval required',
  'approval request',
  'without user response',
  'user denied this potentially dangerous action',
]

/** 识别"被安全闸门拦下"。命中返回说明，未命中返回 null。 */
export function securityBlock(text: string): SecurityBlock | null {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t.includes('BLOCKED')) return null

  const lower = t.toLowerCase()
  const kind: SecurityBlockKind = APPROVAL_MARKERS.some((m) => lower.includes(m))
    ? 'approval'
    : 'rule'

  const hint =
    kind === 'approval'
      ? 'Hermes 的安全闸门要求人工批准这次操作，但网页端没有审批通道（审批只存在于 /v1/runs 接口），所以它被直接拒绝了。需要放行请到 TUI 里操作。'
      : '被 Hermes 的安全策略（Tirith 扫描 / 硬规则 / 用户自定义 deny 规则）拦下，这次操作没有被执行。'

  const i = t.indexOf('BLOCKED')
  const snippet = t.slice(i, i + 240)
  return { kind, hint, snippet }
}
