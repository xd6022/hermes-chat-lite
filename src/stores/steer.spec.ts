/**
 * 补充信息（steer）的 store 级用例。
 *
 * 口径全部来自 2026-09-15 用户拍板：
 *  · **只在** runs 通道 + 拿得到 run_id + 非"正文输出期" 才发（正文输出期按钮是「暂停」）
 *  · 服务端**接受之后**才把那句话作为一条**普通用户消息**显示（不留"未入库"标记）
 *  · 服务端拒绝（409 `run_not_accepting_steer` = 这一轮刚好收尾）→ 静默忽略：
 *    不报错、也不留一条"其实没送进去"的气泡
 *  · `pending_steer`（落晚了、没赶上工具批次）→ 忽略（不重发、不提示）
 *
 * 真机已验（2026-09-15，见 docs）：`sleep` 跑着时 steer 生效，模型按补充后的指令执行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChatModule from './chat'

const calls: { method: string; url: string; body: string }[] = []
let steerReply: () => Response = () => json({ object: 'hermes.run.steer', accepted: true })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function freshModule(): Promise<typeof ChatModule> {
  vi.resetModules()
  const mod = (await import('./chat')) as typeof ChatModule
  mod.setSendTransport('runs')
  return mod
}

/** 造一个"跑着且能补充"的现场 */
function seedRunning(mod: typeof ChatModule, phase: 'thinking' | 'tool' | 'writing'): void {
  mod.store.currentId = 's1'
  mod.store.run.phase = phase
  mod.store.run.runId = 'run_1'
  mod.store.messages = []
  mod.store.streaming = true
}

beforeEach(() => {
  calls.length = 0
  steerReply = () => json({ object: 'hermes.run.steer', accepted: true })
  localStorage.clear() // 防活跃 run 记录（readActiveRun）串台
  vi.unstubAllGlobals()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ method: init?.method ?? 'GET', url, body: String(init?.body ?? '') })
      if (url.includes('/steer')) return steerReply()
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
})

describe('补充信息（steer）', () => {
  it('调工具阶段：POST /v1/runs/{id}/steer，成功后把那句话作为普通用户消息显示出来', async () => {
    const mod = await freshModule()
    seedRunning(mod, 'tool')
    expect(mod.canSteer()).toBe(true)

    await mod.steer('  补充：只查 2026 年的数据  ') // 前后空白应被 trim

    const post = calls.find((c) => c.url.includes('/steer'))
    expect(post?.method).toBe('POST')
    expect(post?.url).toContain('/v1/runs/run_1/steer')
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({ text: '补充：只查 2026 年的数据' })

    expect(mod.store.messages).toHaveLength(1)
    expect(mod.store.messages[0]).toMatchObject({ role: 'user', content: '补充：只查 2026 年的数据' })
  })

  it('思考阶段同样能补（不是只有调工具时）', async () => {
    const mod = await freshModule()
    seedRunning(mod, 'thinking')
    await mod.steer('再补一句')
    expect(calls.filter((c) => c.url.includes('/steer'))).toHaveLength(1)
  })

  it('服务端拒绝（409 这一轮刚好收尾）：不抛错、也不留下"其实没送进去"的气泡', async () => {
    const mod = await freshModule()
    seedRunning(mod, 'tool')
    steerReply = () => json({ error: { code: 'run_not_accepting_steer', message: 'not accepting' } }, 409)

    await expect(mod.steer('落晚了的一句')).resolves.toBeUndefined()
    expect(mod.store.messages).toHaveLength(0)
  })

  it('正文正在输出（writing）：不发 —— 那时按钮是「暂停」，插话的注入点碰不上', async () => {
    const mod = await freshModule()
    seedRunning(mod, 'writing')
    expect(mod.canSteer()).toBe(false)

    await mod.steer('正文输出期不该发')
    expect(calls.filter((c) => c.url.includes('/steer'))).toHaveLength(0)
    expect(mod.store.messages).toHaveLength(0)
  })

  it('stream 回退通道（没有 steer 端点）：不发', async () => {
    const mod = await freshModule()
    seedRunning(mod, 'tool')
    mod.setSendTransport('stream')
    expect(mod.canSteer()).toBe(false)

    await mod.steer('回退通道')
    expect(calls.filter((c) => c.url.includes('/steer'))).toHaveLength(0)
  })

  it('拿不到 run_id（既没有本轮 runId，也没有活跃记录）：不发', async () => {
    const mod = await freshModule()
    seedRunning(mod, 'thinking')
    mod.store.run.runId = null
    expect(mod.canSteer()).toBe(false)

    await mod.steer('没有 run_id')
    expect(calls.filter((c) => c.url.includes('/steer'))).toHaveLength(0)
  })

  it('空内容不发（不产生任何请求）', async () => {
    const mod = await freshModule()
    seedRunning(mod, 'tool')
    await mod.steer('   ')
    expect(calls).toHaveLength(0)
  })
})
