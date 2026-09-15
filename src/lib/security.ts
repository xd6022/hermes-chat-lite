/**
 * 安全闸门相关（纯函数，方便单测）。
 *
 * 背景：发送默认走 `POST /v1/runs`，Hermes 的**审批接线只在这条路上**
 * （`register_gateway_notify` / `_run_approval_sessions` 都在 `_handle_runs` 里）——
 * 需要人工批准的操作会弹审批卡片等人回话，所以在这条路上出现的审批类 BLOCKED
 * 只可能是"没等到回应（超时）"或"用户点了拒绝"。
 * 回退通道 `chat/stream` 上零接线：同样的情况会被 **fail-closed 直接拒**
 * （"没有可问的人"），因此文案按通道分开说（见 `transport` 参数）。
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

/** 发送通道（与 stores/chat.ts 的 `setSendTransport` 对应，那边的默认值是 `'runs'`） */
export type SendTransport = 'runs' | 'stream'

/** 识别"被安全闸门拦下"。命中返回说明，未命中返回 null。 */
export function securityBlock(
  text: string,
  transport: SendTransport = 'runs',
): SecurityBlock | null {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t.includes('BLOCKED')) return null

  const lower = t.toLowerCase()
  const kind: SecurityBlockKind = APPROVAL_MARKERS.some((m) => lower.includes(m))
    ? 'approval'
    : 'rule'

  const hint =
    kind === 'approval'
      ? transport === 'stream'
        ? '这次操作需要人工批准，而旧通道（chat/stream）上 Hermes 没注册审批通知者，所以被**当场拒绝、不会执行**（不是"排队等你批准"）。切回默认通道（/v1/runs）再发一次，就会弹审批卡片。'
        : '这次操作需要您人工审批（就是卡片上那几个选项），但**没等到您的回应（超时）或您点了拒绝**，所以没有执行。再发一次这条消息，在卡片上点「批准一次」即可放行。'
      : '被 Hermes 的安全策略拦下（hardline 硬规则 / 用户自定义 deny 规则等），这次操作没有执行；这类规则在任何客户端都不会放行。'

  const i = t.indexOf('BLOCKED')
  const snippet = t.slice(i, i + 240)
  return { kind, hint, snippet }
}
