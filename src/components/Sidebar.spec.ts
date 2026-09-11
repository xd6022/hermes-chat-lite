import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Sidebar from './Sidebar.vue'
import { store } from '../stores/chat'
import type { HermesSession } from '../api/types'

function session(id: string, title: string): HermesSession {
  return {
    id,
    source: 'tui',
    title,
    started_at: 1789123327.23,
    last_active: 1789123327.23,
    message_count: 4,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mountSidebar(collapsed = false) {
  return mount(Sidebar, { props: { open: false, collapsed } })
}

beforeEach(() => {
  store.sessions = [session('s1', '股票分析'), session('s2', 'Docker 网络问题'), session('s3', '语音项目')]
  store.sessionsLoading = false
  store.currentId = null
})

describe('侧栏搜索（客户端过滤）', () => {
  it('默认显示全部会话，并按日期分组', () => {
    const w = mountSidebar()
    const nav = w.find('nav').text()
    expect(nav).toContain('股票分析')
    expect(nav).toContain('Docker 网络问题')
    expect(nav).toContain('语音项目')
    expect(nav).toMatch(/今天|昨天|更早/)
  })

  it('按关键字过滤，并显示命中数量', async () => {
    const w = mountSidebar()
    await w.find('input').setValue('docker')

    const nav = w.find('nav').text()
    expect(nav).toContain('Docker 网络问题')
    expect(nav).not.toContain('股票分析')
    expect(nav).toContain('找到 1 个')
  })

  it('大小写不敏感，且能命中会话 id', async () => {
    const w = mountSidebar()
    await w.find('input').setValue('DOCKER')
    expect(w.find('nav').text()).toContain('Docker 网络问题')

    await w.find('input').setValue('s3')
    expect(w.find('nav').text()).toContain('语音项目')
  })

  it('搜不到时给出明确空态（不是一片空白）', async () => {
    const w = mountSidebar()
    await w.find('input').setValue('不存在的关键字')
    const nav = w.find('nav').text()
    expect(nav).toContain('没有匹配')
    expect(nav).toContain('不存在的关键字')
  })

  it('清空按钮恢复完整列表', async () => {
    const w = mountSidebar()
    await w.find('input').setValue('docker')
    expect(w.find('nav').text()).not.toContain('股票分析')

    await w.find('button[aria-label="清空搜索"]').trigger('click')
    expect(w.find('nav').text()).toContain('股票分析')
    expect(w.find('button[aria-label="清空搜索"]').exists()).toBe(false)
  })

  it('没有任何会话时提示直接输入即可开始（不再依赖"新对话"按钮）', () => {
    store.sessions = []
    const w = mountSidebar()
    expect(w.find('nav').text()).toContain('还没有会话')
  })
})

describe('侧栏结构', () => {
  it('新建会话是图标按钮，不再占一整行大按钮', () => {
    const w = mountSidebar()
    expect(w.text()).not.toContain('+ 新对话')
    expect(w.find('button[aria-label="新对话"]').exists()).toBe(true)
  })

  it('collapsed 时桌面端隐藏（md:hidden），移动端抽屉不受影响', () => {
    const open = mountSidebar(true)
    expect(open.find('aside').classes()).toContain('md:hidden')

    const normal = mountSidebar(false)
    expect(normal.find('aside').classes()).not.toContain('md:hidden')
  })
})

describe('侧栏行内操作：重命名', () => {
  let calls: { method: string; url: string; body?: string }[] = []

  function stubApi(patcher?: (body: { title: string }) => Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ method, url, body: init?.body as string })
        if (method === 'PATCH') {
          if (patcher) return patcher(body)
          return jsonResponse({
            object: 'hermes.session',
            session: { id: 's1', source: 'tui', title: body.title, started_at: 1, last_active: 1 },
          })
        }
        if (method === 'DELETE') {
          return jsonResponse({ object: 'hermes.session.deleted', id: 's1', deleted: true })
        }
        throw new Error(`未预期的请求: ${method} ${url}`)
      }),
    )
  }

  beforeEach(() => {
    calls = []
    store.streaming = false
    stubApi()
  })

  it('点铅笔 → 原位输入框（预填当前标题）→ Enter 保存：发 PATCH 且列表标题就地更新', async () => {
    const w = mountSidebar()
    await w.findAll('button[aria-label="重命名"]')[0].trigger('click')

    const input = w.find('[data-edit-id="s1"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('股票分析')

    await input.setValue('新标题')
    await input.trigger('keydown', { key: 'Enter' })

    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const patched = calls.find((c) => c.method === 'PATCH')!
    expect(patched.url).toBe('/api/sessions/s1')
    expect(JSON.parse(patched.body!)).toEqual({ title: '新标题' })

    await vi.waitFor(() => {
      expect(w.find('nav').text()).toContain('新标题')
      expect(w.find('[data-edit-id="s1"]').exists()).toBe(false) // 退出编辑态
    })
  })

  it('服务端拒绝（重名）→ 行内红字提示，且保持编辑态让用户改', async () => {
    stubApi(() =>
      new Response(
        JSON.stringify({
          error: { message: "Title '股票分析' is already in use by session s9", code: 'invalid_title' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const w = mountSidebar()
    await w.findAll('button[aria-label="重命名"]')[0].trigger('click')
    await w.find('[data-edit-id="s1"]').setValue('股票分析')
    await w.find('[data-edit-id="s1"]').trigger('keydown', { key: 'Enter' })

    await vi.waitFor(() => expect(w.text()).toContain('标题已被别的会话占用'))
    expect(w.find('[data-edit-id="s1"]').exists()).toBe(true) // 没有退出编辑态
    expect(store.sessions[0].title).toBe('股票分析') // 本地标题没被改坏
  })

  it('Esc 取消：不发任何请求', async () => {
    const w = mountSidebar()
    await w.findAll('button[aria-label="重命名"]')[0].trigger('click')
    await w.find('[data-edit-id="s1"]').setValue('不要保存')
    await w.find('[data-edit-id="s1"]').trigger('keydown', { key: 'Escape' })

    expect(w.find('[data-edit-id="s1"]').exists()).toBe(false)
    expect(calls.length).toBe(0)
    expect(w.find('nav').text()).toContain('股票分析')
  })
})

describe('侧栏行内操作：删除', () => {
  let calls: { method: string; url: string }[] = []

  beforeEach(() => {
    calls = []
    store.streaming = false
    store.currentId = null
    store.messages = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push({ method, url: String(input) })
        return jsonResponse({ object: 'hermes.session.deleted', id: 's1', deleted: true })
      }),
    )
  })

  const confirmBtn = (w: ReturnType<typeof mountSidebar>) =>
    w.findAll('button').find((b) => b.text() === '删除')!

  it('先原位确认（文案带标题），点"取消"不发请求', async () => {
    const w = mountSidebar()
    await w.findAll('button[aria-label="删除"]')[0].trigger('click')

    expect(w.text()).toContain('删除「股票分析」？')
    expect(w.text()).toContain('不可恢复')

    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(calls.length).toBe(0)
    expect(w.text()).not.toContain('删除「股票分析」？')
  })

  it('确认后发 DELETE，并把该行从列表移除', async () => {
    const w = mountSidebar()
    await w.findAll('button[aria-label="删除"]')[0].trigger('click')
    await confirmBtn(w).trigger('click')

    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/sessions/s1')
    await vi.waitFor(() => {
      expect(w.find('nav').text()).not.toContain('股票分析')
      expect(w.find('nav').text()).toContain('Docker 网络问题') // 其它会话不受影响
    })
    expect(store.sessions.length).toBe(2)
  })

  it('删掉的正是当前打开的会话 → 回到空态（currentId 与消息都清空）', async () => {
    store.currentId = 's1'
    store.messages = [{ key: 'k1', role: 'user', content: '一些内容' }]
    const w = mountSidebar()
    await w.findAll('button[aria-label="删除"]')[0].trigger('click')
    await confirmBtn(w).trigger('click')

    await vi.waitFor(() => expect(store.currentId).toBeNull())
    expect(store.messages.length).toBe(0)
    expect(store.sessions.length).toBe(2)
  })

  it('正在流式输出的当前会话：改名/删除按钮禁用（服务端那一轮还在写它）', async () => {
    store.streaming = true
    store.currentId = 's1'
    const w = mountSidebar()

    expect(w.findAll('button[aria-label="重命名"]')[0].attributes('disabled')).toBeDefined()
    expect(w.findAll('button[aria-label="删除"]')[0].attributes('disabled')).toBeDefined()
    // 其它会话不受影响
    expect(w.findAll('button[aria-label="删除"]')[1].attributes('disabled')).toBeUndefined()
  })
})
