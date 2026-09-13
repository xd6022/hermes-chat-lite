import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from './App.vue'

afterEach(() => {
  // 主题/折叠都会写 localStorage 和 <html class>，跨用例必须清干净
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  document.documentElement.style.colorScheme = ''
})

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
  it('渲染顶栏（Hermes + 服务端版本 + 前端构建标识）与空态', async () => {
    const w = mount(App)
    await flushPromises()

    const header = w.find('header').text()
    expect(header).toContain('Hermes')
    expect(header).toContain('v0.20.4') // 来自 /health
    // 前端构建标识（vite define 注入）：真机上"到底是哪一版"靠它一眼确认
    expect(header).toContain(__BUILD_SHORT__)
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.text()).toContain('有什么可以帮您？')
    // 空态底部也放了一份完整形态
    expect(w.text()).toContain(__BUILD_ID__)
  })

  it('侧栏渲染真实会话标题与日期分组', async () => {
    const w = mount(App)
    await flushPromises()

    const aside = w.find('aside').text()
    expect(aside).toContain('真实会话')
    expect(aside).toMatch(/今天|昨天|更早/)
    // 新建入口仍在，但已图标化（不再是一整行 "+ 新对话" 大按钮）
    expect(aside).not.toContain('+ 新对话')
    expect(w.find('aside button[aria-label="新对话"]').exists()).toBe(true)
  })

  it('侧栏支持关键字搜索（Hermes 无搜索 API，前端本地过滤）', async () => {
    const w = mount(App)
    await flushPromises()

    await w.find('aside input').setValue('真实')
    expect(w.find('aside nav').text()).toContain('真实会话')

    await w.find('aside input').setValue('zzz-不存在')
    expect(w.find('aside nav').text()).toContain('没有匹配')
  })

  it('桌面端顶栏按钮可折叠/展开侧栏，并记住选择', async () => {
    localStorage.removeItem('hcl.sidebar')
    const w = mount(App)
    await flushPromises()

    const toggle = w.find('header button[aria-label="折叠会话列表"]')
    expect(toggle.exists()).toBe(true)
    expect(w.find('aside').classes()).not.toContain('md:hidden')

    await toggle.trigger('click')
    expect(w.find('aside').classes()).toContain('md:hidden')
    expect(localStorage.getItem('hcl.sidebar')).toBe('1') // 刷新后仍保持折叠

    const expand = w.find('header button[aria-label="展开会话列表"]')
    expect(expand.exists()).toBe(true)
    await expand.trigger('click')
    expect(w.find('aside').classes()).not.toContain('md:hidden')
    expect(localStorage.getItem('hcl.sidebar')).toBe('0')
  })

  it('顶栏可切换黑夜模式（切 <html class="dark"> 并持久化）', async () => {
    localStorage.removeItem('hcl.theme')
    const w = mount(App)
    await flushPromises()

    const toDark = w.find('header button[aria-label="切换到黑夜模式"]')
    expect(toDark.exists()).toBe(true)
    await toDark.trigger('click')

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('hcl.theme')).toBe('dark')

    const toLight = w.find('header button[aria-label="切换到白天模式"]')
    expect(toLight.exists()).toBe(true)
    await toLight.trigger('click')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
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

  it('密钥无效时显示可见错误横幅 + 重试（不能静默空白）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: 'Invalid gateway API key (API_SERVER_KEY)', code: 'gateway_auth_failed' },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
    const w = mount(App)
    await flushPromises()

    const text = w.text()
    expect(text).toContain('接口密钥无效或未注入')
    expect(text).toContain('重试')
    expect(w.find('header').text()).toContain('未连接')
  })
})
