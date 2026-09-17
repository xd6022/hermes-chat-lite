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

  // 2026-09-16 A 方案：审批时状态词**不带工具名** —— 下面那张卡片的标题已经在说同一个名字了
  it('等审批时状态条说「等待审批」（不带工具名），灯转橙', () => {
    withApproval()
    store.run.startedAt = performance.now() - 1500
    const w = mount(RunStatus)
    // 只看状态行那一行（容器里还装着审批卡片，卡片里有工具名是应该的）
    const row = w.find('[data-testid="turn-light"]').element.parentElement as HTMLElement
    expect(row.textContent).toContain('等待审批')
    expect(row.textContent).not.toContain('terminal')
    expect(w.find('[data-testid="run-status"]').attributes('data-light')).toBe('orange')
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

  it('aborted：状态条说「已中断」，灯是橙的（不是失败，所以不红）', () => {
    store.run.phase = 'aborted'
    const w = mount(RunStatus)
    const line = w.find('[data-testid="run-status"]')
    expect(line.text()).toContain('已中断')
    expect(line.text()).not.toContain('run.completed')
    expect(line.attributes('data-light')).toBe('orange')
  })
})

/**
 * 2026-09-16 四态改版：状态行**常驻**（空闲时 🟢 时刻准备着），红灯的判据与「重试」按钮。
 * 判据本身在 `lib/turnStatus.spec.ts` 里逐条锁；这里只验"组件有没有照它画出来"。
 */
describe('状态行常驻与红灯重试（2026-09-16）', () => {
  const rowOf = (w: ReturnType<typeof mount>) =>
    (w.find('[data-testid="turn-light"]').element.parentElement as HTMLElement).textContent ?? ''

  it('空闲时也显示 🟢 时刻准备着（常驻，不再"空闲就隐藏"）', () => {
    store.run.phase = 'idle'
    const w = mount(RunStatus)
    expect(w.find('[data-testid="run-status"]').exists()).toBe(true)
    expect(rowOf(w)).toContain('时刻准备着')
    expect(w.find('[data-testid="turn-light"]').text()).toBe('🟢')
  })

  it('done 之后回到 🟢 时刻准备着（用户原话：正文结束了就恢复到空闲）', () => {
    store.run.phase = 'done'
    const w = mount(RunStatus)
    expect(rowOf(w)).toContain('时刻准备着')
    expect(w.find('[data-testid="run-status"]').attributes('data-light')).toBe('green')
  })

  it('忙碌中带秒表，且灯是在动的那种（animate-pulse）', () => {
    store.run.phase = 'tool'
    store.run.startedAt = performance.now() - 2400
    const w = mount(RunStatus)
    expect(rowOf(w)).toMatch(/忙碌中 \d+\.\ds/)
    expect(w.find('[data-testid="turn-light"]').classes()).toContain('animate-pulse')
  })

  it('runId 为 null（服务端根本没收到）→ 红灯带「重试」', () => {
    store.run.phase = 'error'
    store.run.runId = null
    const w = mount(RunStatus)
    expect(rowOf(w)).toContain('失败（请重试）')
    expect(w.find('[data-testid="retry"]').exists()).toBe(true)
  })

  it('runId 非 null（已收到、可能已落库）→ 红灯**不出**「重试」（重发会造成两条输入）', () => {
    store.run.phase = 'error'
    store.run.runId = 'run_abc'
    const w = mount(RunStatus)
    expect(rowOf(w)).toContain('失败')
    expect(rowOf(w)).not.toContain('请重试')
    expect(w.find('[data-testid="retry"]').exists()).toBe(false)
  })
})

/**
 * 工具调用与状态条（2026-09-16 用户口径：工具的调用显示在对话上，不显示在输入框上面）。
 * v2.11 起工具调用已内联在对话流里 ⇒ 状态条不再重复工具身份，只留"这一轮还活着 + 跑了多久"。
 */
describe('状态条不重复工具调用', () => {
  it('工具相位：不报工具名，参数预览也不再挂 tooltip（2026-09-16：连"正在执行工具"也换成四态词汇）', () => {
    store.run.phase = 'tool'
    store.run.currentTool = 'bash'
    store.run.toolPreview = 'ls -la /tmp'
    const w = mount(RunStatus)
    const line = w.find('[data-testid="run-status"]')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('忙碌中')
    expect(line.text()).not.toContain('正在使用')
    expect(line.text()).not.toContain('正在执行工具')
    expect(line.text()).not.toContain('bash')
    expect(w.html()).not.toContain('ls -la /tmp')
    expect(line.attributes('data-light')).toBe('yellow')
  })

  it('思考相位：不报工具名', () => {
    store.run.phase = 'thinking'
    store.run.currentTool = 'write_file'
    const w = mount(RunStatus)
    expect(w.find('[data-testid="run-status"]').text()).toContain('忙碌中')
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

describe('RunStatus：状态行与「模型/窗口/本轮输入合计」是同一行（2026-09-17 合并）', () => {
  it('灯、状态词、模型/窗口/合计在**同一个 flex 容器**里，顺序＝灯 → 状态词 → 模型 → 窗口 → 合计', () => {
    store.run.phase = 'idle'
    Object.assign(store.context, { model: 'deepseek-flash', limit: 1_000_000, turnInput: 47_100 })
    const w = mount(RunStatus)

    const light = w.find('[data-testid="turn-light"]')
    const gauge = w.find('[data-testid="ctx-gauge"]')
    expect(gauge.exists()).toBe(true)
    // 同一个父元素 ⇒ 同一行（原来 ContextGauge 是 ChatWindow 里单独的一行）
    expect(gauge.element.parentElement).toBe(light.element.parentElement)

    const row = light.element.parentElement as HTMLElement
    expect(row.className).toContain('flex')
    const text = (row.textContent ?? '').replace(/\s+/g, '')
    expect(text.indexOf('时刻准备着')).toBeLessThan(text.indexOf('deepseek-flash'))
    expect(text.indexOf('deepseek-flash')).toBeLessThan(text.indexOf('窗口1m'))
    expect(text.indexOf('窗口1m')).toBeLessThan(text.indexOf('本轮输入合计47.1k'))
  })

  it('没有任何水位数据时，这一行只剩「灯 + 状态词」（不留孤零零的分隔符、不留空当）', () => {
    store.run.phase = 'idle'
    Object.assign(store.context, { model: null, limit: null, turnInput: null })
    const w = mount(RunStatus)

    const light = w.find('[data-testid="turn-light"]')
    const row = light.element.parentElement as HTMLElement
    expect(row.textContent).toContain('时刻准备着')
    expect(row.textContent).not.toContain('│')
    expect(w.find('[data-testid="ctx-gauge"]').exists()).toBe(false)
  })
})
