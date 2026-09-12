import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HermesMessage, HermesSession } from '../api/types'
import type * as ChatModule from './chat'

/**
 * 流式链路的核心测试（对应设计文档 3.2 / 5.6 / 12 章）：
 *  - 半帧缓冲（响应体切片不能丢事件）
 *  - 多字节中文被切在字节中间也不能乱码（TextDecoder {stream:true}）
 *  - keepalive 注释帧要跳过
 *  - assistant.completed 必须覆盖 delta 拼接（delta 带杂质）
 *  - tool 事件要进时间线，run.completed 才是完成信号
 */

const SSE = [
  ': keepalive',
  '',
  'event: run.started',
  'data: {"session_id":"s1","run_id":"r1","seq":1}',
  '',
  'event: message.started',
  'data: {"message":{"id":"m1","role":"assistant"},"seq":2}',
  '',
  'event: tool.started',
  'data: {"tool_name":"read_file","preview":"package.json","args":{"path":"package.json"},"seq":3}',
  '',
  'event: tool.completed',
  'data: {"tool_name":"read_file","preview":null,"args":null,"seq":4}',
  '',
  'event: assistant.delta',
  'data: {"delta":"\\n\\n你好","seq":5}',
  '',
  'event: assistant.delta',
  'data: {"delta":"，世界","seq":6}',
  '',
  'event: tool.progress',
  'data: {"tool_name":"_thinking","delta":"我在想","seq":7}',
  '',
  'event: assistant.completed',
  'data: {"content":"你好，世界","seq":8}',
  '',
  'event: run.completed',
  'data: {"session_id":"s1","messages":[{"id":9,"role":"assistant","content":"你好，世界"}],"usage":{},"seq":9}',
  '',
  'event: done',
  'data: {}',
  '',
  '',
].join('\n')

/** 把整段 SSE 按字节切片返回，故意切在多字节汉字中间 */
function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const bytes = enc.encode(text)
  const byteIndexOf = (needle: string) => enc.encode(text.slice(0, text.indexOf(needle))).length
  const parts = [byteIndexOf('你') + 1, byteIndexOf('你') + 2, byteIndexOf('世界') + 1, byteIndexOf('run.completed') + 3, 400]
    .filter((p) => p > 0 && p < bytes.length)
    .sort((a, b) => a - b)
  const chunks: Uint8Array[] = []
  let prev = 0
  for (const p of parts) {
    chunks.push(bytes.slice(prev, p))
    prev = p
  }
  chunks.push(bytes.slice(prev))

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SESSION_ROW = {
  id: 's1',
  source: 'tui',
  started_at: 1789123327.23,
  last_active: 1789123327.23,
  title: '真实会话',
  message_count: 3,
}

let calls: string[] = []

async function freshModule(): Promise<typeof ChatModule> {
  vi.resetModules()
  return (await import('./chat')) as typeof ChatModule
}

beforeEach(() => {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)
      if (url === '/api/sessions' && method === 'POST') {
        return jsonResponse({
          object: 'hermes.session',
          session: { id: 's1', source: 'api_server', started_at: 1, last_active: 1 },
        })
      }
      if (url.endsWith('/chat/stream')) return sseResponse(SSE)
      if (url.startsWith('/api/sessions?')) {
        return jsonResponse({ object: 'list', data: [SESSION_ROW], limit: 50, offset: 0, has_more: false })
      }
      if (url === '/health') return jsonResponse({ status: 'ok', version: '0.20.4' })
      throw new Error(`未预期的请求: ${method} ${url}`)
    }),
  )
})

describe('历史消息过滤 normalize()', () => {
  it('滤掉 tool / 空 assistant / 非文本，取多模态 text 片段', async () => {
    const { normalize } = await freshModule()
    const raw = [
      { id: 1, session_id: 's', role: 'user', content: '你好', timestamp: 1 },
      { id: 2, session_id: 's', role: 'assistant', content: '', tool_calls: [{}], timestamp: 2 },
      { id: 3, session_id: 's', role: 'tool', content: '{"ok":true}', tool_name: 'read_file', timestamp: 3 },
      { id: 4, session_id: 's', role: 'assistant', content: '读到了', timestamp: 4 },
      { id: 5, session_id: 's', role: 'user', content: [{ type: 'text', text: '图片说明' }], timestamp: 5 },
      { id: 6, session_id: 's', role: 'system', content: '你应该…', timestamp: 6 },
    ] as unknown as HermesMessage[]

    const out = normalize(raw)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out.map((m) => m.content)).toEqual(['你好', '读到了', '图片说明'])
  })
})

describe('流式发送 send()', () => {
  it('半帧切片 + 中文切在多字节中间 → 不乱码不丢事件；completed 覆盖 delta', async () => {
    const mod = await freshModule()
    await mod.send('hi')

    expect(mod.store.messages).toHaveLength(2)
    expect(mod.store.messages[0]).toMatchObject({ role: 'user', content: 'hi' })
    // delta 拼接是 "\n\n你好，世界"，completed 是 "你好，世界" → 必须是后者
    expect(mod.store.messages[1].content).toBe('你好，世界')
    expect(mod.store.messages[1].streaming).toBe(false)
  })

  it('工具事件进时间线，run.completed 才判定完成', async () => {
    const mod = await freshModule()
    await mod.send('hi')

    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.endedAt).toBeGreaterThan(0)
    expect(mod.store.run.timeline).toEqual([
      { name: 'read_file', preview: 'package.json', status: 'ok' },
    ])
    expect(mod.store.streaming).toBe(false)
  })

  it('请求序列：必要时先建会话，再流式发送', async () => {
    const mod = await freshModule()
    await mod.send('hi')
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /api/sessions',
      'POST /api/sessions/s1/chat/stream',
    ])
  })

  it('已有会话时不再新建，且结束后刷新侧栏', async () => {
    const mod = await freshModule()
    mod.store.currentId = 's1'
    await mod.send('hi')
    expect(calls).not.toContain('POST /api/sessions')
    expect(calls.some((c) => c.startsWith('GET /api/sessions?'))).toBe(true)
  })

  it('流在 run.completed 前结束 → 判定为中断而不是完成', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/chat/stream')) {
          // 只有 delta，没有 run.completed
          const partial = 'event: assistant.delta\ndata: {"delta":"半截"}\n\n'
          return new Response(partial, { status: 200 })
        }
        if (url.startsWith('/api/sessions?')) {
          return jsonResponse({ object: 'list', data: [], limit: 50, offset: 0, has_more: false })
        }
        throw new Error(`未预期的请求: ${url} ${init?.method}`)
      }),
    )
    const mod = await freshModule()
    mod.store.currentId = 's1'
    await mod.send('hi')

    expect(mod.store.run.phase).toBe('aborted')
    expect(mod.store.messages[1].content).toBe('半截')
  })

  it('error 事件 → 气泡显示错误且状态为 error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/chat/stream')) {
          return new Response('event: error\ndata: {"message":"模型不可用"}\n\n', { status: 200 })
        }
        return jsonResponse({ object: 'list', data: [], limit: 50, offset: 0, has_more: false })
      }),
    )
    const mod = await freshModule()
    mod.store.currentId = 's1'
    await mod.send('hi')

    expect(mod.store.run.phase).toBe('error')
    expect(mod.store.messages[1].error).toBe('模型不可用')
  })
})

describe('会话列表与健康检查', () => {
  it('loadSessions 过滤 hidden/archived', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          object: 'list',
          data: [
            SESSION_ROW,
            { ...SESSION_ROW, id: 's2', hidden: true },
            { ...SESSION_ROW, id: 's3', archived: true },
          ],
          limit: 50,
          offset: 0,
          has_more: false,
        }),
      ),
    )
    const mod = await freshModule()
    await mod.loadSessions()
    expect(mod.store.sessions.map((s) => s.id)).toEqual(['s1'])
  })

  it('checkHealth 设置连接状态与版本', async () => {
    const mod = await freshModule()
    await mod.checkHealth()
    expect(mod.store.healthOk).toBe(true)
    expect(mod.store.healthVersion).toBe('0.20.4')
  })
})

describe('失败必须可见（不能静默）', () => {
  it('创建会话 401 时：bootError 给出人话、不留半截消息、不卡 streaming', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/sessions') {
          return new Response(
            JSON.stringify({
              error: { message: 'Invalid gateway API key (API_SERVER_KEY)', code: 'gateway_auth_failed' },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          )
        }
        throw new Error(`不该走到这里: ${url}`)
      }),
    )
    const mod = await freshModule()
    await mod.send('你是谁')

    expect(mod.store.bootError).toBe('接口密钥无效或未注入（检查反代是否注入 Authorization 头）')
    expect(mod.store.messages).toHaveLength(0)
    expect(mod.store.streaming).toBe(false)
  })

  it('拉会话列表 401 时：bootError 有值（界面据此显示横幅）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    const mod = await freshModule()
    await mod.loadSessions()
    expect(mod.store.bootError).toBe('接口密钥无效或未注入（检查反代是否注入 Authorization 头）')
    expect(mod.store.sessionsLoading).toBe(false)
  })

  it('403（带 Origin 被 Hermes CORS 防护拒绝）要给出区别于 401 的定位提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    )
    const mod = await freshModule()
    await mod.loadSessions()
    expect(mod.store.bootError).toContain('CORS')
    expect(mod.store.bootError).toContain('Origin')
  })
})

describe('每轮统计（耗时 / 输入 / 输出 / 缓存命中率）', () => {
  it('用会话累计计数做差算出本轮缓存命中，token 以 usage 为准', async () => {
    let recReads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/chat/stream')) {
          const frames = [
            'event: assistant.delta',
            'data: {"delta":"好"}',
            '',
            'event: assistant.completed',
            'data: {"content":"好"}',
            '',
            'event: run.completed',
            'data: {"usage":{"input_tokens":27330,"output_tokens":53,"total_tokens":27383}}',
            '',
            'event: done',
            'data: {}',
            '',
            '',
          ].join('\n')
          return new Response(frames, { status: 200 })
        }
        if (url === '/api/sessions/s1') {
          recReads++
          // 第 1 次读=本轮基线，第 2 次读=本轮结束（实测：run.completed 后立即读已是新值）
          return jsonResponse({
            object: 'hermes.session',
            session:
              recReads === 1
                ? { id: 's1', input_tokens: 25263, cache_read_tokens: 2048, output_tokens: 25, started_at: 1, last_active: 1 }
                : { id: 's1', input_tokens: 25969, cache_read_tokens: 28672, output_tokens: 78, started_at: 1, last_active: 1 },
          })
        }
        if (url.startsWith('/api/sessions?')) {
          return jsonResponse({ object: 'list', data: [], limit: 50, offset: 0, has_more: false })
        }
        throw new Error(`未预期的请求: ${url}`)
      }),
    )
    const mod = await freshModule()
    mod.store.currentId = 's1'
    await mod.send('hi')

    const st = mod.store.messages[1].stats
    expect(st).toBeTruthy()
    expect(st!.uncachedInput).toBe(706) // 25969 - 25263
    expect(st!.cacheRead).toBe(26624) // 28672 - 2048
    expect(st!.inputTokens).toBe(27330) // 以 usage 为准
    expect(st!.outputTokens).toBe(53)
    expect(st!.cacheRate).toBeCloseTo(26624 / 27330, 3) // 97.4%
    expect(st!.ms).toBeGreaterThanOrEqual(0)
    expect(recReads).toBe(2) // 基线一次 + 结束一次
  })

  it('取不到会话记录时不崩：token 照常显示，缓存率留空', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/chat/stream')) {
          return new Response(
            'event: run.completed\ndata: {"usage":{"input_tokens":100,"output_tokens":7}}\n\nevent: done\ndata: {}\n\n',
            { status: 200 },
          )
        }
        if (url === '/api/sessions/s1') return new Response('', { status: 500 })
        if (url.startsWith('/api/sessions?')) {
          return jsonResponse({ object: 'list', data: [], limit: 50, offset: 0, has_more: false })
        }
        throw new Error(`未预期的请求: ${url}`)
      }),
    )
    const mod = await freshModule()
    mod.store.currentId = 's1'
    await mod.send('hi')

    const st = mod.store.messages[1].stats
    expect(st!.inputTokens).toBe(100)
    expect(st!.outputTokens).toBe(7)
    expect(st!.cacheRate).toBeNull()
    expect(mod.store.run.phase).toBe('done')
  })
})

describe('删除会话：空壳复查（对服务端已知缺陷的兜底）', () => {
  /** 服务端行为可控：DELETE 恒成功；GET 按 opts.ghost 返回"复活的行"或 404 */
  function stubOps(opts: { ghost: boolean }) {
    let deletes = 0
    let gets = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push(`${method} ${url}`)
        if (method === 'DELETE') {
          deletes++
          return jsonResponse({ object: 'hermes.session.deleted', id: 's1', deleted: true })
        }
        if (method === 'GET' && url === '/api/sessions/s1') {
          gets++
          if (opts.ghost) {
            // 实测形态：source='unknown'、message_count=0、标题是刚生成的
            return jsonResponse({
              object: 'hermes.session',
              session: { id: 's1', source: 'unknown', title: '幽灵会话', started_at: 1, last_active: 1 },
            })
          }
          return new Response(
            JSON.stringify({ error: { message: 'Session not found: s1', code: 'session_not_found' } }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        throw new Error(`未预期的请求: ${method} ${url}`)
      }),
    )
    return { dels: () => deletes, gets: () => gets }
  }

  const row = (id: string, title: string): HermesSession =>
    ({ id, source: 'api_server', title, started_at: 1, last_active: 1 }) as HermesSession

  it('会话被异步写入"复活"→ 复查后自动再删一次（顺手把列表里的空壳清掉）', async () => {
    const mod = await freshModule()
    const st = stubOps({ ghost: true })
    mod.store.sessions = [row('s1', '要删的会话'), row('s2', '别的会话')]

    const err = await mod.removeSession('s1', 0) // 延迟设 0：测试不等真实 2 秒
    expect(err).toBeNull()
    expect(mod.store.sessions.map((s) => s.id)).toEqual(['s2']) // 本地立刻移除

    await vi.waitFor(() => expect(st.dels()).toBe(2)) // 复查发现空壳 → 又删了一次
    expect(st.gets()).toBe(1)
    expect(mod.store.sessions.some((s) => s.id === 's1')).toBe(false)
  })

  it('会话真的没了（404）→ 复查只读一次，不多发删除', async () => {
    const mod = await freshModule()
    const st = stubOps({ ghost: false })
    mod.store.sessions = [row('s1', '要删的会话')]

    await mod.removeSession('s1', 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(st.gets()).toBe(1)
    expect(st.dels()).toBe(1)
  })
})
