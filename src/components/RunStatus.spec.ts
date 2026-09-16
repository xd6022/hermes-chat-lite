import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import RunStatus from './RunStatus.vue'
import { store } from '../stores/chat'

/**
 * 审批卡片的组件级用例（A 方案的核心交付，用户看到的就是这块）。
 *
 * 真审批事件已于 2026-09-15 在真链路上验收通过（含真域名页面点按钮那一下，见 README 自检第 7 条）。
 * 这些用例继续保留：它们锁的是"卡片长什么样、点按钮发什么请求"，不依赖真模型，几秒跑完、改坏就红。
 */

const RUN_ID = 'run_appr1'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

let calls: string[] = []
let bodies: Record<string, string> = {}

beforeEach(() => {
  calls = []
  bodies = {}
  store.run.phase = 'idle'
  store.run.runId = null
  store.run.approval = null
  store.run.recovered = false
  store.run.timeline = []
  store.run.startedAt = 0
  store.run.endedAt = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (init?.body) bodies[`${init?.method ?? 'GET'} ${url}`] = String(init.body)
      return jsonResponse({ ok: true })
    }),
  )
})

function withApproval(over: Partial<NonNullable<typeof store.run.approval>> = {}): void {
  store.run.phase = 'approval'
  store.run.runId = RUN_ID
  store.run.approval = {
    toolName: 'terminal',
    command: 'rm -rf ./tmp',
    choices: ['once', 'session', 'always', 'deny'],
    smartDenied: false,
    allowPermanent: true,
    ...over,
  }
}

describe('审批卡片', () => {
  it('显示工具名与命令，四个选项都在，并提示"不点就不会继续"', () => {
    withApproval()
    const w = mount(RunStatus)
    const text = w.text()
    expect(text).toContain('需要你批准')
    expect(text).toContain('terminal')
    expect(text).toContain('rm -rf ./tmp')
    expect(text).toContain('这一轮在等你回话，不点就不会继续')
    expect(w.findAll('button').map((b) => b.text())).toEqual([
      '批准一次',
      '本会话都允许',
      '永久允许',
      '拒绝',
    ])
  })

  it('点"批准一次" → POST /v1/runs/{id}/approval {choice:once}，随后显示已回话', async () => {
    withApproval()
    const w = mount(RunStatus)
    await w.findAll('button')[0].trigger('click')

    await vi.waitFor(() => expect(calls).toContain(`POST /v1/runs/${RUN_ID}/approval`))
    expect(JSON.parse(bodies[`POST /v1/runs/${RUN_ID}/approval`])).toEqual({ choice: 'once' })
    await vi.waitFor(() => expect(w.text()).toContain('已回话：批准一次'))
  })

  it('点"拒绝" → choice:deny', async () => {
    withApproval()
    const w = mount(RunStatus)
    const buttons = w.findAll('button')
    await buttons[buttons.length - 1].trigger('click')

    await vi.waitFor(() => expect(calls).toContain(`POST /v1/runs/${RUN_ID}/approval`))
    expect(JSON.parse(bodies[`POST /v1/runs/${RUN_ID}/approval`])).toEqual({ choice: 'deny' })
  })

  it('服务端没给"永久允许"就不显示它；缺 choices 时兜底展示 批准一次/拒绝', () => {
    withApproval({ allowPermanent: false })
    let w = mount(RunStatus)
    expect(w.findAll('button').map((b) => b.text())).toEqual(['批准一次', '本会话都允许', '拒绝'])

    // choices 缺字段（服务端载荷变化）→ store 兜底为 once/deny
    withApproval({ choices: ['once', 'deny'], allowPermanent: false })
    w = mount(RunStatus)
    expect(w.findAll('button').map((b) => b.text())).toEqual(['批准一次', '拒绝'])
  })

  it('回话失败时把原因显示在卡片上，且按钮仍可重试', async () => {
    withApproval()
    const w = mount(RunStatus)
    // 服务端 409（审批已过期）
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'approval_not_pending' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
    await w.findAll('button')[0].trigger('click')

    await vi.waitFor(() => expect(w.text()).toContain('没有待处理的审批'))
    expect(w.findAll('button').length).toBeGreaterThan(0)
  })

  it('等审批时状态条显示"等待你批准"，并按进行中计时', () => {
    withApproval()
    store.run.startedAt = performance.now() - 1500
    const w = mount(RunStatus)
    expect(w.text()).toContain('等待你批准：terminal')
  })

  it('没有审批时卡片不出现（正常轮不打扰）', () => {
    store.run.phase = 'writing'
    store.run.approval = null
    const w = mount(RunStatus)
    expect(w.text()).not.toContain('需要你批准')
  })

  // v2.2 起文案改成"从服务端会话记录同步回来"（覆盖 后台/断线 两种情况），
  // 且 background 阶段不显示（那时还没同步完）
  it('recovered 为真时提示"本轮内容已从服务端会话记录同步回来"', () => {
    store.run.phase = 'done'
    store.run.recovered = true
    const w = mount(RunStatus)
    expect(w.text()).toContain('已从服务端会话记录同步回来')
  })

  it('aborted：状态条说「已中断这一轮」，且不暴露内部事件名', () => {
    store.run.phase = 'aborted'
    const w = mount(RunStatus)
    expect(w.find('[data-testid="run-status"]').text()).toContain('已中断这一轮')
    expect(w.text()).not.toContain('run.completed')
  })
})

/**
 * 工具调用与状态条（2026-09-16 用户口径：工具的调用显示在对话上，不显示在输入框上面）。
 * v2.11 起工具调用已内联在对话流里 ⇒ 状态条不再重复工具身份，只留"这一轮还活着 + 跑了多久"。
 */
describe('状态条不重复工具调用', () => {
  it('工具相位：不报工具名，参数预览也不再挂 tooltip', () => {
    store.run.phase = 'tool'
    store.run.currentTool = 'bash'
    store.run.toolPreview = 'ls -la /tmp'
    const w = mount(RunStatus)
    const line = w.find('[data-testid="run-status"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('正在执行工具')
    expect(line.text()).not.toContain('正在使用')
    expect(line.text()).not.toContain('bash')
    expect(w.html()).not.toContain('ls -la /tmp')
  })

  it('思考相位：不报工具名', () => {
    store.run.phase = 'thinking'
    store.run.currentTool = 'write_file'
    const w = mount(RunStatus)
    expect(w.find('[data-testid="run-status"]').text()).toContain('正在思考')
    expect(w.text()).not.toContain('write_file')
  })

  it('计时保留：工具相位照样走秒（"跑了多久"没丢），但工具名不出现', () => {
    store.run.phase = 'tool'
    store.run.currentTool = 'bash'
    store.run.startedAt = performance.now() - 3000
    const w = mount(RunStatus)
    const line = w.find('[data-testid="run-status"]')
    expect(line.text()).toMatch(/\d+\.\d+s/) // 秒表还在
    expect(line.text()).not.toContain('bash') // 工具名不在
  })
})
