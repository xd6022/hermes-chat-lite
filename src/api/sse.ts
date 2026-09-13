/**
 * POST + SSE 解析器。
 *
 * 为什么不用 EventSource：
 *   EventSource 只支持 GET，而 Hermes 的流式聊天是 POST /api/sessions/{id}/chat/stream。
 *   所以必须手写 fetch + ReadableStream + TextDecoder。
 *
 * 四条必须遵守的规则（踩过才知道）：
 *   1. TextDecoder 必须带 { stream: true }   —— 否则中文在多字节分片边界会乱码
 *   2. 切帧后最后一段必须留回缓冲区            —— 否则 JSON 被截断，事件丢失
 *   3. 跳过 ':' 开头的注释帧                  —— 服务端每 30s 发一次 `: keepalive`
 *   4. 'data:' 后只 trimStart，不要 trim 整行   —— 否则正文里的换行被吃掉
 */

export type SseHandler = (event: string, data: any) => void

/**
 * 解析一个 SSE 响应体（POST / GET 通用）。
 * 规则见文件头 1~4 条。
 */
export async function consumeSse(res: Response, onEvent: SseHandler): Promise<void> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  if (!res.body) {
    throw new Error('响应没有可读流（浏览器不支持或已被代理缓冲）')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // 规则 1
      buf += decoder.decode(value, { stream: true })

      const frames = buf.split(/\r?\n\r?\n/)
      // 规则 2：最后一段可能是半帧
      buf = frames.pop() ?? ''

      for (const frame of frames) {
        // 规则 3
        if (!frame || frame.startsWith(':')) continue
        let eventName = 'message'
        const dataLines: string[] = []
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            // 规则 4
            dataLines.push(line.slice(5).replace(/^ /, ''))
          }
        }
        if (!dataLines.length) continue
        const raw = dataLines.join('\n')
        try {
          onEvent(eventName, JSON.parse(raw))
        } catch {
          // 半帧或非 JSON，忽略
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 忽略 */
    }
  }
}

export async function postSse(
  url: string,
  body: unknown,
  onEvent: SseHandler,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  return consumeSse(res, onEvent)
}

/**
 * GET + SSE。`/v1/runs/{id}/events` 是 GET 流（EventSource 也能连，但它不能带
 * 自定义头，而鉴权头由反代注入、浏览器同源请求本来就会带上；仍用 fetch 是为了
 * 与 POST 流共用一套解析器和 AbortSignal 语义）。
 *
 * 注意：这个流**不能重连、不能重放** —— 服务端把队列在消费者断开时就丢弃了，
 * 再连同一个 run_id 会 404。断线只能靠回读会话消息对账（见 stores/chat.ts）。
 */
export async function getSse(
  url: string,
  onEvent: SseHandler,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal })
  return consumeSse(res, onEvent)
}
