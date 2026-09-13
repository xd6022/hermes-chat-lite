/**
 * 浏览器进后台 / 断线后的恢复（v2.2）。
 *
 * 对应需求的测试 1~5（在单测这一层能做到的部分）：
 *  1. 切后台把连接掐了 → **不能标"中断"**，界面要如实说"还在后台执行"
 *  2. 回到前台 → 问服务端要状态 → 跑完了就用会话记录补正文、标完成
 *  3. 服务端还在跑 → 按退避轮询（1s→2s→4s…），不再盲目标"中断"
 *  4. 页面刷新/被系统回收重建 → **localStorage** 里的记录把那一轮找回来
 *  5. 用户点停止 → 任何状态下都能真的取消（POST /stop），相位回到"中断"
 * 另有：离线时留记录重试、run 超出保留窗口（404）时只能靠会话历史对账。
 *
 * 真机后台行为（Android/iOS 到底怎么冻结页面）**单测验不了**，那部分由真浏览器用例
 * 与您在手机上的实测覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HermesMessage } from '../api/types'
import type * as ChatModule from './chat'

const SID = 's_resume'
const RUN_ID = 'run_resume_1'
const SENT = '去跑一个长任务'

let calls: string[] = []
/** GET /v1/runs/{id} 的返回队列：每次调用弹一个（用 'offline' 表示请求抛错，'404' 表示 run 没了） */
let statusQueue: Array<Record<string, unknown> | 'offline' | '404'> = []
let transcript: Partial<HermesMessage>[] = []
/** 事件流行为：'die' = 连上就断（模拟切后台被掐），'ok' = 正常跑完 */
let streamMode: 'die' | 'ok' | 'hang' = 'die'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function deadStream(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error('network error'))
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function okStream(): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('event: message.delta\ndata: {"delta":"半截"}\n\n'))
      c.enqueue(enc.encode('event: run.completed\ndata: {"usage":{}}\n\n'))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/**
 * 永不结束、永不报错的流：模拟"页面被冻结时 socket 已经死了，但 promise 一直不 settle"。
 *
 * 必须自己接 signal 转成 AbortError：桩 fetch 绕过了真实内核，不接的话
 * `abortCtl.abort()` 对读流毫无影响，用例会假挂在 5s 超时上（踩过）。
 */
function hangStream(signal?: AbortSignal | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url}`)

      if (url === '/v1/runs' && method === 'POST') {
        return json({ run_id: RUN_ID, session_id: SID })
      }
      if (url === `/v1/runs/${RUN_ID}/events`) {
        return streamMode === 'hang'
          ? hangStream(init?.signal)
          : streamMode === 'die'
            ? deadStream()
            : okStream()
      }
      if (url === `/v1/runs/${RUN_ID}/stop` && method === 'POST') return json({ accepted: true })
      if (url === `/v1/runs/${RUN_ID}`) {
        const next = statusQueue.shift() ?? { run_id: RUN_ID, status: 'running' }
        if (next === 'offline') throw new TypeError('Failed to fetch')
        if (next === '404') return json({ error: { message: 'run not found' } }, 404)
        return json(next)
      }
      if (url.startsWith(`/api/sessions/${SID}/messages`)) {
        return json({
          object: 'list',
          session_id: SID,
          data: transcript,
          pagination: { limit: 60, offset: 0, order: 'latest', returned: transcript.length },
        })
      }
      if (url === `/api/sessions/${SID}`) {
        return json({ object: 'hermes.session', session: { id: SID, input_tokens: 10, cache_read_tokens: 5 } })
      }
      if (url === '/api/sessions' && method === 'POST') {
        return json({ object: 'hermes.session', session: { id: SID, source: 'api_server' } })
      }
      if (url.startsWith('/api/sessions?')) {
        return json({ object: 'list', data: [], limit: 200, offset: 0, has_more: false })
      }
      if (url === '/health') return json({ status: 'ok', version: '0.20.4' })
      throw new Error(`未预期的请求: ${method} ${url}`)
    }),
  )
}

/** 读 localStorage 里那条"正在跑的一轮"记录 */
function storedRecord() {
  const raw = localStorage.getItem('hcl.activeRun')
  return raw ? JSON.parse(raw) : null
}

async function freshRuns(): Promise<typeof ChatModule> {
  vi.resetModules()
  const mod = (await import('./chat')) as typeof ChatModule
  mod.setSendTransport('runs')
  return mod
}

/** 造一条"服务端已经落库"的 transcript（本轮 = 最后一条 user 之后的部分） */
function serverTurn(assistantText: string): Partial<HermesMessage>[] {
  return [
    { id: 1, session_id: SID, role: 'user', content: SENT, timestamp: 1 },
    { id: 2, session_id: SID, role: 'assistant', content: '', tool_calls: [{}], timestamp: 2 },
    { id: 3, session_id: SID, role: 'tool', content: '{"ok":true}', tool_name: 'terminal', timestamp: 3 },
    { id: 4, session_id: SID, role: 'assistant', content: assistantText, timestamp: 4 },
  ] as Partial<HermesMessage>[]
}

beforeEach(() => {
  calls = []
  statusQueue = []
  transcript = []
  streamMode = 'die'
  localStorage.clear()
  stubFetch()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('切后台把连接掐了（测试 1）', () => {
  it('服务端还在跑 → 相位是 background 而不是 aborted，且记录已落盘', async () => {
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.send(SENT)

    expect(mod.store.run.phase).toBe('background')
    expect(mod.store.messages.at(-1)?.error ?? null).toBeNull() // 断流不是"这一轮失败"
    const rec = storedRecord()
    expect(rec).toMatchObject({ sessionId: SID, runId: RUN_ID, sentText: SENT })
    expect(typeof rec.startedAt).toBe('number')
  })

  it('等待人工审批（waiting_for_approval）也算"还在跑"，不许标中断', async () => {
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'waiting_for_approval' }]
    await mod.send(SENT)
    expect(mod.store.run.phase).toBe('background')
  })

  it('真的终态失败（failed）仍然如实报错，不掩盖成 background', async () => {
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'failed', error: '模型挂了' }]
    await mod.send(SENT)
    expect(mod.store.run.phase).toBe('error')
    expect(mod.store.run.errorMessage).toBe('模型挂了')
    expect(storedRecord()).toBeNull()
  })
})

describe('回到前台同步（测试 2/4）', () => {
  it('★ 断流时留下的错误红字，在"其实已完成"时会被清掉（假报错）', async () => {
    const mod = await freshRuns()
    // 流断（网络错误）+ 服务端其实跑完了：这是真机上"Failed to fetch 挂在成功回复下面"的形态
    streamMode = 'die'
    statusQueue = [{ run_id: RUN_ID, status: 'completed' }]
    transcript = serverTurn('已经跑完的正文')
    await mod.send(SENT)

    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.messages.at(-1)?.content).toBe('已经跑完的正文')
    expect(mod.store.messages.at(-1)?.error ?? null).toBeNull()
  })

  it('服务端已完成 → 用会话记录补正文、标完成、清掉记录', async () => {
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.send(SENT)
    expect(mod.store.run.phase).toBe('background')

    // 用户在后台等它跑完，然后回到前台
    statusQueue = [{ run_id: RUN_ID, status: 'completed' }]
    transcript = serverTurn('后台跑完的完整正文')
    await mod.resumeSync()

    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.recovered).toBe(true)
    expect(mod.store.messages.at(-1)?.content).toBe('后台跑完的完整正文')
    expect(storedRecord()).toBeNull()
  })

  it('刷新页面（本地状态全没了）→ 靠记录把这一轮找回来', async () => {
    // 模拟刷新前留下的记录
    localStorage.setItem(
      'hcl.activeRun',
      JSON.stringify({ sessionId: SID, runId: RUN_ID, sentText: SENT, startedAt: Date.now() - 30_000 }),
    )
    const mod = await freshRuns()
    mod.store.currentId = SID
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]

    await mod.resumeSync()
    expect(mod.store.run.phase).toBe('background')
    // 计时基准要用墙钟换算回来：显示"已运行 ~30s"而不是 0
    expect((performance.now() - mod.store.run.startedAt) / 1000).toBeGreaterThan(20)

    statusQueue = [{ run_id: RUN_ID, status: 'completed' }]
    transcript = serverTurn('刷新期间跑完的正文')
    await mod.resumeSync()
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.messages.at(-1)?.content).toBe('刷新期间跑完的正文')
    expect(storedRecord()).toBeNull()
  })

  it('★ 被系统回收后重开（没选任何会话）→ 自动打开那一轮所在的会话并同步', async () => {
    // 真机实测（2026-09-13 14:14）就是这一格：页面被回收重建后 currentId 是空的，
    // 用户不点会话就永远看不到"还在后台执行"
    localStorage.setItem(
      'hcl.activeRun',
      JSON.stringify({ sessionId: SID, runId: RUN_ID, sentText: SENT, startedAt: Date.now() }),
    )
    const mod = await freshRuns()
    expect(mod.store.currentId).toBeNull()

    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.resumeSync()

    expect(mod.store.currentId).toBe(SID) // 自己把会话打开了
    expect(calls).toContain(`GET /api/sessions/${SID}/messages?order=latest&limit=100&offset=0`)
    expect(mod.store.run.phase).toBe('background')
  })

  it('★ 已修复"标签页被回收"：记录换了存储也在（sessionStorage 清空不影响）', async () => {
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.send(SENT)

    // 记录必须落在 localStorage（sessionStorage 扛不住"标签页被系统回收后重建"）
    expect(localStorage.getItem('hcl.activeRun')).not.toBeNull()
    expect(sessionStorage.getItem('hcl.activeRun')).toBeNull()

    // 模拟"新上下文"：sessionStorage 是空的（清掉），但 localStorage 还在
    sessionStorage.clear()
    statusQueue = [{ run_id: RUN_ID, status: 'completed' }]
    transcript = serverTurn('换上下文后同步到的正文')
    await mod.resumeSync()
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.messages.at(-1)?.content).toBe('换上下文后同步到的正文')
  })

  it('记录指向的会话已被删除 → 自动打开失败就把记录清掉（不留死循环）', async () => {
    localStorage.setItem(
      'hcl.activeRun',
      JSON.stringify({ sessionId: 'gone', runId: RUN_ID, sentText: SENT, startedAt: Date.now() }),
    )
    const mod = await freshRuns()
    // 让 messages 返回 404：临时替换 fetch 比给原 stub 加分支更直观
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(`GET ${url}`)
        if (url.startsWith('/api/sessions/gone/messages')) {
          return new Response(JSON.stringify({ error: { message: 'not found' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )

    await mod.resumeSync()
    expect(storedRecord()).toBeNull() // 记录被清（会话都没了）
  })

  it('僵尸流：本地流还挂着但服务端已经结束 → 主动掐断本地流（交给 send() 收尾）', async () => {
    const mod = await freshRuns()
    streamMode = 'hang'
    // 两次 completed：resumeSync 用一次（判定"服务端已结束 → 掐断僵尸流"），
    // send() 的收尾逻辑还会再查一次（它才是真正落地"完成 + 对账"的人）
    statusQueue = [
      { run_id: RUN_ID, status: 'completed' },
      { run_id: RUN_ID, status: 'completed' },
    ]
    transcript = serverTurn('僵尸流恢复后的正文')
    const p = mod.send(SENT)
    await vi.waitFor(() => expect(mod.store.streaming).toBe(true))
    await mod.resumeSync()
    await p // 被 abort 后 send() 收尾（会对账 + 标完成）
    expect(mod.store.streaming).toBe(false)
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.messages.at(-1)?.content).toBe('僵尸流恢复后的正文')
  })
})

describe('服务端还在跑时的轮询（测试 3）', () => {
  it('回前台时还在跑 → 按 1s/2s/4s 退避继续问，终态后停下', async () => {
    vi.useFakeTimers()
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.send(SENT)
    const before = calls.filter((c) => c === `GET /v1/runs/${RUN_ID}`).length

    vi.advanceTimersByTime(999)
    await Promise.resolve()
    expect(calls.filter((c) => c === `GET /v1/runs/${RUN_ID}`).length).toBe(before) // 1s 还没到

    await vi.advanceTimersByTimeAsync(1) // 到 1s → 第 1 次轮询
    await vi.advanceTimersByTimeAsync(2000) // 2s → 第 2 次
    await vi.advanceTimersByTimeAsync(4000) // 4s → 第 3 次
    const polls = calls.filter((c) => c === `GET /v1/runs/${RUN_ID}`).length - before
    expect(polls).toBeGreaterThanOrEqual(3)

    // 服务端跑完了 → 下一次轮询拿到 completed 就收尾，且不再排新定时器
    statusQueue = [{ run_id: RUN_ID, status: 'completed' }]
    transcript = serverTurn('正文')
    await vi.advanceTimersByTimeAsync(8000)
    expect(mod.store.run.phase).toBe('done')
    const settled = calls.filter((c) => c === `GET /v1/runs/${RUN_ID}`).length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter((c) => c === `GET /v1/runs/${RUN_ID}`).length).toBe(settled)
  })
})

describe('离线与保留窗口（兜底）', () => {
  it('状态接口也连不上（离线）→ 留记录、相位仍是 background，网络恢复后能补上', async () => {
    const mod = await freshRuns()
    statusQueue = ['offline']
    await mod.send(SENT)
    expect(mod.store.run.phase).toBe('background')
    expect(storedRecord()).not.toBeNull()

    statusQueue = [{ run_id: RUN_ID, status: 'completed' }]
    transcript = serverTurn('网络恢复后同步到的正文')
    await mod.resumeSync()
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.messages.at(-1)?.content).toBe('网络恢复后同步到的正文')
  })

  it('run 已超出服务端保留窗口（404）→ 退回会话历史对账，拿到内容就算完成', async () => {
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.send(SENT)

    statusQueue = ['404']
    transcript = serverTurn('只能用会话历史对回来的正文')
    await mod.resumeSync()
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.recovered).toBe(true)
    expect(mod.store.messages.at(-1)?.content).toBe('只能用会话历史对回来的正文')
    expect(storedRecord()).toBeNull()
  })
})

describe('用户主动停止（测试 5：不能因为这次修复而失效）', () => {
  it('流在跑时点停止 → POST /stop + 相位中断', async () => {
    const mod = await freshRuns()
    streamMode = 'hang'
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    const p = mod.send(SENT)
    await vi.waitFor(() => expect(mod.store.streaming).toBe(true))
    mod.stop()
    await p
    expect(calls).toContain(`POST /v1/runs/${RUN_ID}/stop`)
    expect(mod.store.run.phase).toBe('aborted')
    expect(storedRecord()).toBeNull()
  })

  it('★ 后台执行中（本地没有流了）点停止 → 仍然真的取消，记录清掉', async () => {
    const mod = await freshRuns()
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.send(SENT)
    expect(mod.store.run.phase).toBe('background')

    mod.stop()
    expect(calls).toContain(`POST /v1/runs/${RUN_ID}/stop`)
    expect(mod.store.run.phase).toBe('aborted')
    expect(storedRecord()).toBeNull()
  })

  it('刷新过页面后点停止 → run_id 从记录里取，照样能取消', async () => {
    localStorage.setItem(
      'hcl.activeRun',
      JSON.stringify({ sessionId: SID, runId: RUN_ID, sentText: SENT, startedAt: Date.now() }),
    )
    const mod = await freshRuns()
    mod.store.currentId = SID
    statusQueue = [{ run_id: RUN_ID, status: 'running' }]
    await mod.resumeSync()
    mod.stop()
    expect(calls).toContain(`POST /v1/runs/${RUN_ID}/stop`)
    expect(storedRecord()).toBeNull()
  })
})
