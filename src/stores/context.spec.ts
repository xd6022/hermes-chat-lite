/**
 * 输入框上方那行（模型 / 窗口上限 / 本轮输入合计）的数据链路。
 *
 * 三个数字三个来源，这里锁住"谁来填、什么时候填、填不到怎么办"：
 *  - 模型：会话行 session.model（counters() 顺手带回来）
 *  - 上限：`/api/model-info`（dashboard 后端，经 nginx 转发）→ effective_context_length
 *  - 本轮输入合计：本轮 run.completed 的 usage.input_tokens = **该轮内每次 API 调用 prompt 之和**
 *    （服务端不提供"当前上下文占用"，所以这个值**不能**拿去算水位百分比 —— 2026-09-15 查实的 bug）
 *
 * 另外锁住 ⓐ 口径：Hermes 不落库这个值 → 写进 localStorage，重开页面标"上次已知"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChatModule from './chat'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sse(usage: unknown): string {
  return [
    'event: assistant.delta',
    'data: {"delta":"好"}',
    '',
    'event: assistant.completed',
    'data: {"content":"好"}',
    '',
    'event: run.completed',
    `data: ${JSON.stringify({ usage })}`,
    '',
    'event: done',
    'data: {}',
    '',
    '',
  ].join('\n')
}

const SESSION_ROW = {
  id: 's1',
  model: 'deepseek-flash',
  input_tokens: 706,
  cache_read_tokens: 26624,
  output_tokens: 53,
  tool_call_count: 11,
  started_at: 1,
  last_active: 1,
}

/** 统一的 fetch 桩：可以按需让 `/api/model-info` 失败（模拟"nginx 没配好"） */
function stub(modelInfoOk: boolean, usage: unknown = { input_tokens: 407_700, output_tokens: 12 }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat/stream')) return new Response(sse(usage), { status: 200 })
      if (url === '/api/sessions/s1') return jsonResponse({ object: 'hermes.session', session: SESSION_ROW })
      if (url === '/api/model-info') {
        if (!modelInfoOk) return new Response('nope', { status: 502 })
        return jsonResponse({
          model: 'deepseek-flash',
          provider: 'xyy',
          auto_context_length: 1_000_000,
          effective_context_length: 1_000_000,
        })
      }
      if (url.startsWith('/api/sessions?')) {
        return jsonResponse({ object: 'list', data: [], limit: 50, offset: 0, has_more: false })
      }
      if (url.includes('/messages?')) {
        return jsonResponse({ object: 'list', data: [], pagination: { limit: 100, offset: 0, returned: 0 } })
      }
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
}

async function freshModule(): Promise<typeof ChatModule> {
  vi.resetModules()
  const mod = (await import('./chat')) as typeof ChatModule
  mod.setSendTransport('stream')
  return mod
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('输入框上方那行（模型 / 窗口上限 / 本轮输入合计）', () => {
  it('轮末用 usage.input_tokens 记下本轮输入合计，并写进本地缓存（ⓐ 刷新后还能看）', async () => {
    stub(true)
    const mod = await freshModule()
    mod.store.currentId = 's1'

    await mod.loadModelInfo()
    await mod.send('hi')

    expect(mod.store.context.limit).toBe(1_000_000)
    expect(mod.store.context.model).toBe('deepseek-flash') // 从会话行顺手拿的
    expect(mod.store.context.turnInput).toBe(407_700)
    expect(mod.store.context.stale).toBe(false)
    expect(mod.store.context.at).toBeGreaterThan(0)
    // ⓐ 本地缓存（按会话存）
    expect(JSON.parse(localStorage.getItem('hcl.ctx.s1') ?? '{}')).toMatchObject({ turnInput: 407_700 })
  })

  it('重开页面/切回会话：从本地缓存恢复本轮输入合计并标"上次已知"', async () => {
    localStorage.setItem('hcl.ctx.s1', JSON.stringify({ turnInput: 321_000, at: 1_700_000_000_000 }))
    stub(true)
    const mod = await freshModule()

    await mod.openSession('s1')

    expect(mod.store.context.turnInput).toBe(321_000)
    expect(mod.store.context.stale).toBe(true)
    expect(mod.store.context.at).toBe(1_700_000_000_000)
  })

  it('切到另一个会话：不带上一个会话的值（不串台）', async () => {
    localStorage.setItem('hcl.ctx.s1', JSON.stringify({ turnInput: 321_000, at: 1 }))
    stub(true)
    const mod = await freshModule()

    await mod.openSession('s1')
    expect(mod.store.context.turnInput).toBe(321_000)

    // s2 没有缓存 → 清空成"未知"，而不是留着 s1 的数字
    await mod.openSession('s2')
    expect(mod.store.context.turnInput).toBeNull()
    expect(mod.store.context.stale).toBe(false)
  })

  it('上限接口没通（nginx 没配/后端改名）→ limit 保持 null：不显示分母，也不编数字', async () => {
    stub(false)
    const mod = await freshModule()
    mod.store.currentId = 's1'

    await mod.loadModelInfo()
    await mod.send('hi')

    expect(mod.store.context.limit).toBeNull()
    // 本轮输入合计照常记录（它跟分母是两条独立的路）
    expect(mod.store.context.turnInput).toBe(407_700)
  })

  it('usage 里没有 input_tokens（异常轮）→ 不覆盖上一轮的值', async () => {
    stub(true)
    const mod = await freshModule()
    mod.store.currentId = 's1'
    mod.store.context.turnInput = 123_456

    await mod.send('hi') // 这个桩返回的 usage 有值，先确认正常路径
    expect(mod.store.context.turnInput).toBe(407_700)

    // 再来一轮，usage 空 → 保持上一轮的值（不写成 0）
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/chat/stream')) return new Response(sse({}), { status: 200 })
        if (url === '/api/sessions/s1') return jsonResponse({ object: 'hermes.session', session: SESSION_ROW })
        if (url.startsWith('/api/sessions?')) {
          return jsonResponse({ object: 'list', data: [], limit: 50, offset: 0, has_more: false })
        }
        throw new Error(`未预期的请求: ${url}`)
      }),
    )
    await mod.send('再来一轮')
    expect(mod.store.context.turnInput).toBe(407_700)
  })
})
