import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChatModule from './chat'

/**
 * A 方案（`/v1/runs` 通道）的用例。
 *
 * 这里覆盖的是"与旧通道不同"的那些点，旧通道的行为由 chat.spec.ts 保证：
 *  - 提交与订阅分离（POST /v1/runs → GET .../events）
 *  - `message.delta` / `reasoning.available` 事件名映射
 *  - `run.completed` **不带** messages → 轮末回读会话对账（权威正文 / 安全闸门 / 时间线）
 *  - 事件流一次性不可重连 → 流断后用 GET /v1/runs/{id} 判终态、标 recovered
 *  - 审批：approval.request → 卡片状态 → POST .../approval {choice} → 收起
 *  - 中断：POST .../stop（不是"断开连接"）
 *  - 回退开关：setSendTransport('stream') 后不再碰 /v1/runs
 */

const RUN_ID = 'run_test1'
const SID = 's1'

function ev(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseText(lines: string[]): Response {
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let calls: string[] = []
let bodies: Record<string, string> = {}
let opts: {
  /** 事件流内容（静态） */
  events?: string[]
  /** 原样返回的帧文本（用来复现真链路的帧形态） */
  rawFrames?: string
  /** 事件流交给我们手动喂（测审批这种"流中途要回话"的场景） */
  controlled?: boolean
  runStatus?: Record<string, unknown>
  transcript?: unknown[]
  approval?: { status: number; body: unknown }
} = {}

/** 手动可控的事件流（测审批/中断时必须"流还没结束就回话"） */
let streamCtl: ReadableStreamDefaultController<Uint8Array> | null = null
const enc = new TextEncoder()

function push(...lines: string[]): void {
  streamCtl?.enqueue(enc.encode(lines.join('')))
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (init?.body) bodies[`${method} ${url}`] = String(init.body)

      if (url === '/v1/runs' && method === 'POST') return json({ run_id: RUN_ID, session_id: SID })
      if (url === `/v1/runs/${RUN_ID}/events`) {
        if (opts.controlled) {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              streamCtl = c
            },
          })
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }
        if (opts.rawFrames !== undefined) return sseText([opts.rawFrames])
        return sseText(opts.events ?? [])
      }
      if (url === `/v1/runs/${RUN_ID}/approval`) {
        const a = opts.approval ?? { status: 200, body: { ok: true } }
        return json(a.body, a.status)
      }
      if (url === `/v1/runs/${RUN_ID}/stop`) return json({ accepted: true })
      if (url === `/v1/runs/${RUN_ID}`) {
        return json(opts.runStatus ?? { run_id: RUN_ID, status: 'running' })
      }
      if (url.startsWith(`/api/sessions/${SID}/messages`)) {
        return json({
          object: 'list',
          session_id: SID,
          data: opts.transcript ?? [],
          pagination: { limit: 60, offset: 0, order: 'latest', returned: (opts.transcript ?? []).length },
        })
      }
      if (url === `/api/sessions/${SID}`) {
        return json({
          object: 'hermes.session',
          session: { id: SID, input_tokens: 200, cache_read_tokens: 100 },
        })
      }
      if (url === '/api/sessions' && method === 'POST') {
        return json({ object: 'hermes.session', session: { id: SID, source: 'api_server' } })
      }
      if (url.startsWith('/api/sessions?')) {
        return json({ object: 'list', data: [], limit: 200, offset: 0, has_more: false })
      }
      if (url === `/api/sessions/${SID}/chat/stream`) {
        return sseText([
          ev('assistant.delta', { delta: '旧' }),
          ev('run.completed', { usage: { input_tokens: 1, output_tokens: 1 } }),
        ])
      }
      throw new Error(`未预期的请求: ${method} ${url}`)
    }),
  )
}

async function freshRuns(): Promise<typeof ChatModule> {
  vi.resetModules()
  const mod = (await import('./chat')) as typeof ChatModule
  mod.setSendTransport('runs')
  return mod
}

beforeEach(() => {
  calls = []
  bodies = {}
  opts = {}
  streamCtl = null
  stubFetch()
})

describe('/v1/runs 通道：基本链路', () => {
  it('默认通道就是 runs（A 方案默认开启）', async () => {
    const mod = await freshRuns()
    expect(mod.DEFAULT_TRANSPORT).toBe('runs')
    expect(mod.sendTransport()).toBe('runs')
  })

  it('提交 → 订流 → 逐字 → 完成；请求序列与对账/统计请求都对', async () => {
    opts.events = [
      ev('run.started', {}),
      ev('message.delta', { delta: '你' }),
      ev('message.delta', { delta: '好' }),
      ev('run.completed', { output: '你好', usage: { input_tokens: 300, output_tokens: 7 } }),
    ]
    opts.transcript = [
      { id: 1, role: 'user', content: 'hi' },
      { id: 2, role: 'assistant', content: '你好' },
    ]
    const mod = await freshRuns()
    await mod.send('hi')

    expect(mod.store.messages).toHaveLength(2)
    expect(mod.store.messages[1].content).toBe('你好')
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.recovered).toBe(false)
    expect(mod.store.messages[1].stats?.inputTokens).toBe(300)
    expect(calls).toEqual([
      'POST /api/sessions',
      `GET /api/sessions/${SID}`,
      'POST /v1/runs',
      `GET /v1/runs/${RUN_ID}/events`,
      `GET /api/sessions/${SID}/messages?order=latest&limit=60&offset=0`,
      `GET /api/sessions/${SID}`,
      'GET /api/sessions?limit=200&offset=0',
    ])
  })

  it('reasoning.available 当思考提示（不是工具），不把 writing 降级', async () => {
    opts.events = [
      ev('reasoning.available', { delta: '想' }),
      ev('message.delta', { delta: '答' }),
      ev('reasoning.available', {}),
      ev('run.completed', { output: '答' }),
    ]
    const mod = await freshRuns()
    await mod.send('hi')

    // 正文开始输出后又来了思考提示，结束态仍是完成、且时间线里没有伪工具
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.timeline).toEqual([])
  })

  it('未知事件不影响收尾（服务端将来新增事件也不崩）', async () => {
    opts.events = [ev('brand.new.event', { x: 1 }), ev('run.completed', { output: 'ok' })]
    const mod = await freshRuns()
    await mod.send('hi')
    expect(mod.store.run.phase).toBe('done')
  })

  it('真字段形态：工具事件用 `tool` 字段、完成带 error 标志（旧通道用的是 tool_name）', async () => {
    opts.rawFrames = [
      'data: {"event":"tool.started","run_id":"r","tool":"terminal","preview":"echo hi"}\n\n',
      'data: {"event":"tool.completed","run_id":"r","tool":"terminal","duration":0.12,"error":true}\n\n',
      'data: {"event":"run.completed","run_id":"r","output":"ok"}\n\n',
    ].join('')
    const mod = await freshRuns()
    await mod.send('hi')

    expect(mod.store.run.timeline).toMatchObject([
      { name: 'terminal', preview: 'echo hi', status: 'fail' },
    ])
    // 内联展示同样要有（失败的工具在这条回复下面显示 ✗）
    expect(mod.store.messages[1].tools).toMatchObject([{ name: 'terminal', status: 'fail' }])
  })

  it('真实帧形态：没有 event: 行、事件名在 JSON 的 event 字段里（真链路实测踩到的坑）', async () => {
    opts.rawFrames = [
      'data: {"event":"message.delta","run_id":"r","delta":"真"}\n\n',
      'data: {"event":"run.completed","run_id":"r","output":"真","usage":{"input_tokens":9,"output_tokens":1}}\n\n',
      ': stream closed\n\n',
    ].join('')
    const mod = await freshRuns()
    await mod.send('hi')

    // 事件被正确识别 → 逐字 + 收到终止事件（没有被降级成"未知事件忽略"）
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.recovered).toBe(false)
    expect(mod.store.messages[1].stats?.inputTokens).toBe(9)
  })
})

describe('/v1/runs 通道：轮末回读对账', () => {
  it('权威正文来自 transcript：抹掉 delta 的前导换行杂质，并合并工具前后的多段', async () => {
    opts.events = [
      ev('message.delta', { delta: '\n\n让我查一下' }),
      ev('tool.started', { tool_name: 'read_file' }),
      ev('tool.completed', { tool_name: 'read_file' }),
      ev('message.delta', { delta: '答案是 42' }),
      ev('run.completed', { output: '答案是 42' }),
    ]
    opts.transcript = [
      { id: 1, role: 'user', content: 'hi' },
      { id: 2, role: 'assistant', content: '让我查一下', tool_calls: [{}] },
      { id: 3, role: 'tool', content: '{"ok":true}', tool_name: 'read_file' },
      { id: 4, role: 'assistant', content: '答案是 42' },
    ]
    const mod = await freshRuns()
    await mod.send('hi')

    expect(mod.store.messages[1].content).toBe('让我查一下\n\n答案是 42')
    // 断线补齐/轮末对账：找回的那份也要长成同一形状（有预览、有成败、耗时拿不到就是 null）
    // 注意这一轮 SSE 收到过 tool.started，所以时间线保留实时那份（有本地耗时），不覆盖成历史版
    expect(mod.store.run.timeline).toMatchObject([
      { name: 'read_file', preview: '', status: 'ok' },
    ])
    expect(typeof mod.store.run.timeline[0].ms).toBe('number')
    // 并且已经内联挂到本轮这条回复上
    expect(mod.store.messages[1].tools?.map((t) => t.name)).toEqual(['read_file'])
  })

  it('安全闸门原文从 transcript 捞（runs 通道没有 run.completed.messages）', async () => {
    opts.events = [ev('run.completed', { output: '我做不到' })]
    opts.transcript = [
      { id: 1, role: 'user', content: 'hi' },
      {
        id: 2,
        role: 'tool',
        content: 'BLOCKED: Failed to send approval request to user. Do NOT retry.',
        tool_name: 'terminal',
      },
      { id: 3, role: 'assistant', content: '我做不到' },
    ]
    const mod = await freshRuns()
    await mod.send('hi')

    expect(mod.store.run.blocked?.kind).toBe('approval')
    expect(mod.store.run.blocked?.hint).toContain('审批')
  })
})

describe('/v1/runs 通道：审批', () => {
  it('approval.request → 卡片状态；respondApproval(once) 发对请求体；responded 后收起', async () => {
    opts.controlled = true
    const mod = await freshRuns()
    const done = mod.send('hi')
    await vi.waitFor(() => expect(streamCtl).toBeTruthy())

    push(
      ev('approval.request', {
        tool_name: 'terminal',
        command: 'rm -rf ./tmp',
        choices: ['once', 'session', 'always', 'deny'],
        allow_permanent: true,
      }),
    )
    await vi.waitFor(() => expect(mod.store.run.phase).toBe('approval'))
    expect(mod.store.run.approval).toMatchObject({ toolName: 'terminal', command: 'rm -rf ./tmp' })
    expect(mod.store.run.approval?.choices).toEqual(['once', 'session', 'always', 'deny'])

    expect(await mod.respondApproval('once')).toBeNull()
    expect(calls).toContain(`POST /v1/runs/${RUN_ID}/approval`)
    expect(JSON.parse(bodies[`POST /v1/runs/${RUN_ID}/approval`])).toEqual({ choice: 'once' })
    expect(mod.store.run.approval?.resolved).toBe('once')

    // 服务端确认 + 这一轮继续往下走 → 卡片收起
    push(ev('approval.responded', {}), ev('tool.started', { tool_name: 'terminal' }))
    await vi.waitFor(() => expect(mod.store.run.approval).toBeNull())

    push(ev('run.completed', { output: '做好了' }), '')
    streamCtl?.close()
    await done
    expect(mod.store.run.phase).toBe('done')
  })

  it('回话失败（409 已过期）→ 卡片上给出原因，且不误判为完成', async () => {
    opts.controlled = true
    opts.approval = { status: 409, body: { error: { message: 'approval_not_active' } } }
    const mod = await freshRuns()
    const done = mod.send('hi')
    await vi.waitFor(() => expect(streamCtl).toBeTruthy())

    push(ev('approval.request', { tool_name: 'terminal', choices: ['once', 'deny'] }))
    await vi.waitFor(() => expect(mod.store.run.phase).toBe('approval'))

    const err = await mod.respondApproval('once')
    expect(err).toContain('没有待处理的审批')
    expect(mod.store.run.approval?.error).toContain('没有待处理的审批')

    streamCtl?.close()
    await done
  })

  it('缺少 choices 字段时兜底成 once/deny（服务端载荷变化也不能崩）', async () => {
    opts.controlled = true
    const mod = await freshRuns()
    const done = mod.send('hi')
    await vi.waitFor(() => expect(streamCtl).toBeTruthy())

    push(ev('approval.request', { tool_name: 'terminal' }))
    await vi.waitFor(() => expect(mod.store.run.phase).toBe('approval'))
    expect(mod.store.run.approval?.choices).toEqual(['once', 'deny'])

    streamCtl?.close()
    await done
  })
})

describe('/v1/runs 通道：中断与断线恢复', () => {
  it('stop() 走 POST /v1/runs/{id}/stop（不是只断连接）', async () => {
    opts.controlled = true
    const mod = await freshRuns()
    const done = mod.send('hi')
    await vi.waitFor(() => expect(calls).toContain('POST /v1/runs'))

    mod.stop()
    await vi.waitFor(() => expect(calls).toContain(`POST /v1/runs/${RUN_ID}/stop`))

    streamCtl?.close()
    await done
    // 没收到终止事件 → 中断态（并标注已回读）
    expect(mod.store.run.phase).toBe('aborted')
  })

  it('流断了但服务端其实跑完了 → 用 GET /v1/runs/{id} 判成完成，并标 recovered', async () => {
    opts.events = [ev('message.delta', { delta: '半截' })]
    opts.runStatus = {
      run_id: RUN_ID,
      status: 'completed',
      output: '完整答案',
      usage: { input_tokens: 50, output_tokens: 3 },
    }
    opts.transcript = [
      { id: 1, role: 'user', content: 'hi' },
      { id: 2, role: 'assistant', content: '完整答案' },
    ]
    const mod = await freshRuns()
    await mod.send('hi')

    expect(calls).toContain(`GET /v1/runs/${RUN_ID}`)
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.recovered).toBe(true)
    expect(mod.store.messages[1].content).toBe('完整答案')
  })

  it('run 失败 → 状态为 error，并显示服务端给的原因', async () => {
    opts.events = [ev('run.failed', { error: 'provider 401' })]
    const mod = await freshRuns()
    await mod.send('hi')

    expect(mod.store.run.phase).toBe('error')
    expect(mod.store.run.errorMessage).toBe('provider 401')
    expect(mod.store.messages[1].error).toBe('provider 401')
  })

  it('run.cancelled → 判为中断（不是完成），且不给本轮统计', async () => {
    opts.events = [ev('message.delta', { delta: '半截' }), ev('run.cancelled', {})]
    const mod = await freshRuns()
    await mod.send('hi')

    expect(mod.store.run.phase).toBe('aborted')
    expect(mod.store.messages[1].stats).toBeUndefined()
  })
})

describe('回退开关', () => {
  it("setSendTransport('stream') 后完全不碰 /v1/runs，走旧通道", async () => {
    vi.resetModules()
    const mod = (await import('./chat')) as typeof ChatModule
    mod.setSendTransport('stream')
    await mod.send('hi')

    expect(calls).toContain(`POST /api/sessions/${SID}/chat/stream`)
    expect(calls.some((c) => c.includes('/v1/runs'))).toBe(false)
    expect(mod.store.run.phase).toBe('done')
  })
})
