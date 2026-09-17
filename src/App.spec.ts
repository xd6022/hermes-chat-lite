import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from './App.vue'
import { store } from './stores/chat'

afterEach(() => {
  // 主题/折叠都会写 localStorage 和 <html class>，跨用例必须清干净
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  document.documentElement.style.colorScheme = ''
  // v2.12：地址是状态的一部分 —— 用例之间必须复位，否则下一个用例会"启动就进某个会话"
  window.history.replaceState(null, '', '/')
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
  it('渲染顶栏（Hermes + 服务端版本）与空态；**顶栏不再摆前端构建标识**（2026-09-17 移到 Settings）', async () => {
    const w = mount(App)
    await flushPromises()

    const header = w.find('header').text()
    expect(header).toContain('Hermes')
    expect(header).toContain('v0.20.4') // 来自 /health
    // 2026-09-17 用户要求：首屏不摆构建信息（那串 `09-17 10:33` 原来是顶栏小字）
    expect(header).not.toContain(__BUILD_SHORT__)
    expect(header).not.toContain('09-')
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.text()).toContain('有什么可以帮您？')
    // 空态那份构建标识也已去掉（2026-09-15）；现在全页只留 Settings 那一份
    expect(w.text()).not.toContain(__BUILD_ID__)
  })

  it('构建标识是**搬家不是删掉**：Settings 面板里仍然看得到（问"到底是哪一版"还得有答案）', async () => {
    const w = mount(App)
    await flushPromises()

    expect(w.text()).not.toContain('前端构建')
    const settingsBtn = w.findAll('header button').find((b) => b.text() === 'Settings')
    await settingsBtn!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain(`前端构建 ${__BUILD_ID__}`)
  })

  it('空态只剩标题：副标题与构建标识都已去掉（2026-09-15）', async () => {
    const w = mount(App)
    await flushPromises()

    const scroller = w.find('[data-testid="scroller"]')
    expect(scroller.exists()).toBe(true)
    expect(scroller.text()).toContain('有什么可以帮您？')
    // 副标题的两种文案（新会话 / 已选中但没消息）都不该再出现在屏幕正中
    expect(scroller.text()).not.toContain('从一个新会话开始')
    expect(scroller.text()).not.toContain('这个会话还没有消息')
    // 屏幕正中不再有那份构建标识（现在全页只剩 Settings 里那一份）
    expect(scroller.text()).not.toContain(__BUILD_ID__)
  })

  it('空态不显示任何示例话术（自用：保持对话区干净）', async () => {
    const w = mount(App)
    await flushPromises()

    // 曾经这里写死过一组示例按钮（看看 510210 现在的盘面 / hermes_stock 交易记录 / Python 改异步）
    const scroller = w.find('[data-testid="scroller"]')
    expect(scroller.exists()).toBe(true)
    expect(scroller.text()).not.toContain('510210')
    expect(scroller.text()).not.toContain('把这段 Python')
    // 空态里不应再有任何可点话术按钮
    expect(scroller.find('button').exists()).toBe(false)
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

/**
 * 地址即状态（v2.12）—— 用户 2026-09-15 拍板：地址栏决定打开哪个会话。
 *
 * 这一组锁的是"地址 ↔ 视图"的四条硬口径：
 *   ① 地址里有会话 → 启动就进它（刷新恢复会话靠这条）
 *   ② 裸域名 → 欢迎页（**永不偷偷跳回上次会话**）
 *   ③ 地址里的会话不存在 → 回欢迎页 + 轻提示 + 地址清干净（不叠常驻红字横幅）
 *   ④ 「新对话」→ 清地址回欢迎页，且**不预建空会话**
 * 另外两条行为（点侧栏进历史、返回键跟着地址走）也在这一组里。
 */
describe('地址即状态（v2.12）', () => {
  const SESSION_2 = {
    id: 's2',
    source: 'tui',
    title: '另一个会话',
    started_at: 1789123400.0,
    last_active: 1789123400.0,
    message_count: 1,
  }
  const MESSAGES_2 = [
    { id: 9, session_id: 's2', role: 'user', content: '第二个会话的消息', timestamp: 9 },
  ]

  beforeEach(() => {
    window.history.replaceState(null, '', '/')
    /*
     * ⚠️ 同一个 spec 文件里 `store` 是**模块级单例**：上面那组用例点过会话行，会留下
     * `currentId = 's1'` 与已加载的消息。不清掉的话，本组里"启动就进某个会话"这类断言
     * 会**因为残留状态而假通过**（RED 阶段实测撞到过：还原源文件后它照样绿）。
     */
    store.currentId = null
    store.messages = []
    store.sessions = []
    store.bootError = null
    store.streaming = false
    store.run.phase = 'idle'
    store.run.timeline = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/health') return json({ status: 'ok', platform: 'hermes-agent', version: '0.20.4' })
        if (url.startsWith('/api/sessions?'))
          return json({ object: 'list', data: [SESSION_ROW, SESSION_2], limit: 50, offset: 0, has_more: false })
        if (url.includes('/s1/messages?'))
          return json({
            object: 'list',
            session_id: 's1',
            data: RAW_MESSAGES,
            pagination: { limit: 100, offset: 0, order: 'latest', returned: 4 },
          })
        if (url.includes('/s2/messages?'))
          return json({
            object: 'list',
            session_id: 's2',
            data: MESSAGES_2,
            pagination: { limit: 100, offset: 0, order: 'latest', returned: 1 },
          })
        // 不存在的会话：实测口径是 404 + code=session_not_found（2026-09-15 量过）
        if (url.startsWith('/api/sessions/ghost'))
          return new Response(
            JSON.stringify({ error: { message: 'Session not found: ghost', code: 'session_not_found' } }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        if (url.startsWith('/api/model-info')) return json({})
        if (url.startsWith('/api/sessions/')) return json({ object: 'list', data: [] })
        throw new Error(`未预期的请求: ${url} ${init?.method ?? 'GET'}`)
      }),
    )
  })

  /** 助手消息是 rAF 节流渲染的，等等帧 */
  async function waitText(w: ReturnType<typeof mount>, needle: string): Promise<void> {
    await vi.waitFor(() => expect(w.find('section').text()).toContain(needle), { timeout: 3000 })
  }

  it('★ 地址里有会话 → 启动就进那个会话（刷新恢复会话靠的就是这一步）', async () => {
    window.history.replaceState(null, '', '#/s/s1')
    const w = mount(App)
    await flushPromises()

    await waitText(w, '读到了')
    expect(w.find('section').text()).not.toContain('有什么可以帮您？')
    expect(window.location.hash).toBe('#/s/s1') // 地址不动（刷新语义：还在原地）
  })

  it('★ 地址是裸域名 → 欢迎页（不偷偷跳回上次打开的会话）', async () => {
    const w = mount(App)
    await flushPromises()

    expect(w.find('section').text()).toContain('有什么可以帮您？')
    expect(window.location.hash).toBe('')
  })

  it('★ 地址里的会话不存在 → 回欢迎页 + 5 秒轻提示 + 地址清干净（不留坏地址）', async () => {
    window.history.replaceState(null, '', '#/s/ghost')
    const w = mount(App)
    await flushPromises()
    await flushPromises()

    expect(w.find('section').text()).toContain('有什么可以帮您？')
    expect(window.location.hash).toBe('') // 地址回到裸域名
    const notice = w.find('[data-testid="notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toBe('该会话不存在，请重新创建')
    // 这条信息由轻提示表达，别再叠一条常驻红字横幅（用户口径：别两种提示并存）
    expect(w.find('[data-testid="boot-error"]').exists()).toBe(false)
  })

  it('★ 点侧栏另一个会话：进历史一步（返回键才有东西可回）+ 真的打开它', async () => {
    window.history.replaceState(null, '', '#/s/s1')
    const w = mount(App)
    await flushPromises()
    await waitText(w, '读到了')
    const before = window.history.length

    const btn = w.findAll('aside button').find((b) => b.text().includes('另一个会话'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()

    expect(window.location.hash).toBe('#/s/s2')
    expect(window.history.length).toBe(before + 1) // push 而不是 replace
    await waitText(w, '第二个会话的消息')
  })

  it('★ 返回键/前进（popstate）→ 视图跟着地址走', async () => {
    window.history.replaceState(null, '', '#/s/s1')
    const w = mount(App)
    await flushPromises()
    await waitText(w, '读到了')

    // 模拟浏览器把地址改回 s2 并派发 popstate（返回/前进键就是这条路径）
    window.history.replaceState(null, '', '#/s/s2')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()

    await waitText(w, '第二个会话的消息')
  })

  it('★ 点「新对话」：清地址回欢迎页，且**不预建空会话**（侧栏不再堆 0 消息空壳）', async () => {
    window.history.replaceState(null, '', '#/s/s1')
    const w = mount(App)
    await flushPromises()
    await waitText(w, '读到了')

    await w.find('aside button[aria-label="新对话"]').trigger('click')
    await flushPromises()

    expect(window.location.hash).toBe('')
    expect(w.find('section').text()).toContain('有什么可以帮您？')
    const posts = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
      String(c[0]),
    )
    expect(posts.filter((u) => u === '/api/sessions')).toEqual([]) // 没有 POST 建会话
  })
})
