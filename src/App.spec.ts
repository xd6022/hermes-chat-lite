import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from './App.vue'

/** 真实的一次会话：含 tool 消息与空 assistant（工具调用轮），都被过滤掉 */
const RAW_MESSAGES = [
  { id: 1, session_id: 's1', role: 'user', content: '读一下 package.json', timestamp: 1 },
  { id: 2, session_id: 's1', role: 'assistant', content: '', tool_calls: [{}], timestamp: 2 },
  { id: 3, session_id: 's1', role: 'tool', content: '{"ok":true}', tool_name: 'read_file', timestamp: 3 },
  { id: 4, session_id: 's1', role: 'assistant', content: '读到了', timestamp: 4 },
]

const SESSION_ROW = {
  id: 's1',
  source: 'tui',
  title: '真实会话',
  started_at: 1789123327.23,
  last_active: 1789123327.23,
  message_count: 4,
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/health') return json({ status: 'ok', platform: 'hermes-agent', version: '0.20.4' })
      if (url.startsWith('/api/sessions?')) {
        return json({ object: 'list', data: [SESSION_ROW], limit: 50, offset: 0, has_more: false })
      }
      if (url.includes('/messages?')) {
        return json({
          object: 'list',
          session_id: 's1',
          data: RAW_MESSAGES,
          pagination: { limit: 100, offset: 0, order: 'latest', returned: 4 },
        })
      }
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
})

describe('App 集成', () => {
  it('渲染顶栏（Hermes + 版本）与空态', async () => {
    const w = mount(App)
    await flushPromises()

    const header = w.find('header').text()
    expect(header).toContain('Hermes')
    expect(header).toContain('v0.20.4') // 来自 /health
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.text()).toContain('有什么可以帮您？')
  })

  it('侧栏渲染真实会话标题与日期分组', async () => {
    const w = mount(App)
    await flushPromises()

    const aside = w.find('aside').text()
    expect(aside).toContain('真实会话')
    expect(aside).toMatch(/今天|昨天|更早/)
    expect(aside).toContain('+ 新对话')
  })

  it('点击会话加载历史，且 tool / 空 assistant 被过滤掉', async () => {
    const w = mount(App)
    await flushPromises()

    const btn = w.findAll('aside button').find((b) => b.text().includes('真实会话'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')

    // 服务端返回立即渲染（用户消息），助手消息经 rAF 节流渲染 —— 要等帧
    await vi.waitFor(
      () => {
        expect(w.find('section').text()).toContain('读一下 package.json')
        expect(w.find('section').text()).toContain('读到了')
      },
      { timeout: 3000 },
    )
    expect(w.find('section').text()).not.toContain('{"ok":true}') // tool 消息不该出现在界面上
  })

  it('Settings 抽屉可打开，显示连接状态', async () => {
    const w = mount(App)
    await flushPromises()

    const settingsBtn = w.findAll('header button').find((b) => b.text() === 'Settings')
    await settingsBtn!.trigger('click')
    await flushPromises()

    const text = w.text()
    expect(text).toContain('Hermes API Server 正常')
    expect(text).toContain('Shift + Enter')
  })
})
