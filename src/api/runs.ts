/**
 * `/v1/runs` 系列接口 —— A 方案的发送通道（自带审批）。
 *
 * 与 `chat/stream` 的四点本质差别（均为 2026-09-12 实测，详见
 * docs/plans/2026-09-12-runs-transport.md）：
 *   1. **提交与订阅分离**：`POST /v1/runs` 立即 202 返回 `run_id`，再
 *      `GET /v1/runs/{id}/events` 订流（服务端有 20×50ms 等待窗口兜住竞态）
 *   2. **事件名不同**：`message.delta`（不是 `assistant.delta`）；终稿在
 *      `run.completed.output`
 *   3. **`run.completed` 不带 `messages`** → 权威 transcript 要自己回读会话消息
 *      （`GET /api/sessions/{id}/messages`，实测能读到 run 写的消息，含 role=tool）
 *   4. **事件流一次性、不可重放**：消费后再连同一个 run_id → 404
 *
 * 另外服务端每 30s 会发 SSE 注释行 `: keepalive`、结束发 `: stream closed`，
 * 由 api/sse.ts 的解析器统一忽略（规则 3）。
 */

import { getSse, type SseHandler } from './sse'
import { HermesApiError, request } from './hermes'
import type { ApprovalChoice, RunStatusResponse, RunSubmitResponse } from './types'

/**
 * run 类接口的报错措辞修正：`request()` 的通用文案是给会话接口写的，
 * 404/409 在 run 这条路上含义完全不同，直接照搬会误导。
 */
async function runRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    return await request<T>(path, init)
  } catch (e) {
    if (e instanceof HermesApiError) {
      if (e.status === 404) {
        throw new HermesApiError(404, '这个 run 不存在或已结束（事件流是一次性的，不能重连/重放）', e.code)
      }
      if (e.status === 409) {
        throw new HermesApiError(409, '这个 run 当前没有待处理的审批（可能已过期，或已被别处处理）', e.code)
      }
      if (e.status === 429 || e.status === 503) {
        throw new HermesApiError(e.status, `服务端繁忙（并发上限或数据库不可用）：${e.message}`, e.code)
      }
    }
    throw e
  }
}

export interface SubmitRunOptions {
  /** 附加 system 提示（对应 body.instructions），一般不用 */
  instructions?: string
  /** 覆盖本轮模型/渠道（不传则用会话已存模型，也就是"粘住"的那个） */
  model?: string
  provider?: string
}

/**
 * 提交一轮并立刻拿到 run_id（服务端返回 202）。
 * 用同一个 `session_id` 就能接续现有会话 —— 实测同一 session_id 连续两轮，
 * 第二轮答得出第一轮内容，且历史仍可用 `/api/sessions/{id}/messages` 读到。
 */
export function submitRun(
  input: string,
  sessionId: string,
  opts: SubmitRunOptions = {},
): Promise<RunSubmitResponse> {
  const body: Record<string, unknown> = { input, session_id: sessionId }
  if (opts.instructions) body.instructions = opts.instructions
  if (opts.model) body.model = opts.model
  if (opts.provider) body.provider = opts.provider
  return runRequest<RunSubmitResponse>('/v1/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * 订阅这个 run 的事件流（一次性：断开就没了，只能回读会话对账）。
 *
 * ⚠️ 关键差异（2026-09-12 真链路实测踩到）：`/v1/runs` 的 SSE 帧**没有 `event:` 行**，
 * 事件名放在 JSON 载荷的 `event` 字段里（`_sse_frame(event)` 未传 event= 参数）；
 * 而旧通道 `chat/stream` 是有的（`_sse_frame(payload, event=name)`）。
 * 不在这里归一化的话，解析器会一律报事件名 `message`，于是所有事件被当成未知事件忽略
 * —— 表现就是"界面空白，只有轮末对账补回来的一段正文"。
 */
export function runEvents(runId: string, onEvent: SseHandler, signal?: AbortSignal): Promise<void> {
  return getSse(
    `/v1/runs/${encodeURIComponent(runId)}/events`,
    (name, data) => {
      const inner = (data as { event?: unknown } | null)?.event
      const real = name === 'message' && typeof inner === 'string' ? inner : name
      onEvent(real, data)
    },
    signal,
  )
}

/** 查这个 run 的终态/当前状态（流丢了但想知道结果时用）。 */
export function getRun(runId: string): Promise<RunStatusResponse> {
  return runRequest<RunStatusResponse>(`/v1/runs/${encodeURIComponent(runId)}`)
}

/**
 * 回话一次审批。
 * choice：`once` 只批这一次 / `session` 本会话记住 / `always` 永久允许 / `deny` 拒绝。
 * （实测服务端还接受别名 approve|approved|allow → once；我们只传规范值。）
 * `all=true` 表示把所有待审批项一起按这个 choice 处理（服务端字段名 all / resolve_all）。
 */
export function approveRun(
  runId: string,
  choice: ApprovalChoice,
  all = false,
): Promise<Record<string, unknown>> {
  return runRequest<Record<string, unknown>>(
    `/v1/runs/${encodeURIComponent(runId)}/approval`,
    { method: 'POST', body: JSON.stringify(all ? { choice, all: true } : { choice }) },
  )
}

/** 中断这一轮（比 chat/stream 时代"直接断连接"干净：服务端会发 run.cancelled）。 */
export function stopRun(runId: string): Promise<Record<string, unknown>> {
  return runRequest<Record<string, unknown>>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    body: '{}',
  })
}

/** 往正在跑的一轮里插话（引导）。本轮未做界面入口，接口先留着。 */
export function steerRun(runId: string, text: string): Promise<Record<string, unknown>> {
  return runRequest<Record<string, unknown>>(`/v1/runs/${encodeURIComponent(runId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}
