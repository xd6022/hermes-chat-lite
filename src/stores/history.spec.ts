import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { HermesMessage } from '../api/types'
import type * as ChatModule from './chat'

/**
 * 历史分页 + 连续 assistant 合并（对应设计文档 §5.9）。
 *
 * 这些用例针对两个真实反馈：
 *  1. "打开会话，最上面的消息只到某一条" —— 首屏只取最近 100 条，前面的被截断
 *  2. "页面展示像自动加了换行" —— 一次工具轮次里有连续多条 assistant，分开渲染多出间距
 *
 * 分页语义（2026-09-11 实测）：order=latest 时 offset 是【从最新往回数】，页内按时间正序。
 * mock 严格按这个语义实现，否则测试就失去意义。
 */

/** 169 条原始消息：1 条开头 user + 一段连续 assistant + 若干 user 打断 */
function buildServer(): HermesMessage[] {
  const out: HermesMessage[] = []
  for (let id = 1; id <= 169; id++) {
    const isUser = id === 1 || id === 26 || id % 30 === 0
    out.push({
      id,
      session_id: 's1',
      role: isUser ? 'user' : 'assistant',
      content: `${isUser ? 'user' : 'assistant'}-${id}`,
      timestamp: id,
    } as HermesMessage)
  }
  return out
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

let SERVER: HermesMessage[] = []
let calls: string[] = []

beforeEach(() => {
  SERVER = buildServer()
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/messages?')) {
        const u = new URL(url, 'http://test.local')
        const limit = Number(u.searchParams.get('limit'))
        const offset = Number(u.searchParams.get('offset'))
        // order=latest：从最新往回数 offset 条，取 limit 条，页内时间正序
        const end = Math.max(0, SERVER.length - offset)
        const start = Math.max(0, end - limit)
        const page = SERVER.slice(start, end)
        return jsonResponse({
          object: 'list',
          session_id: 's1',
          data: page,
          pagination: { limit, offset, order: 'latest', returned: page.length },
        })
      }
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
})

async function freshModule(): Promise<typeof ChatModule> {
  vi.resetModules()
  return (await import('./chat')) as typeof ChatModule
}

const joined = (msgs: { content: string }[]): string => msgs.map((m) => m.content).join('\n')

describe('历史分页', () => {
  it('首屏取最近一页；不满一页则认为到底了', async () => {
    const chat = await freshModule()

    await chat.openSession('s1')
    expect(calls[0]).toContain('limit=100')
    expect(calls[0]).toContain('offset=0')
    expect(chat.store.rawCount).toBe(100)
    expect(chat.store.hasMoreHistory).toBe(true)
    // 最新一条在，第二页才有的更早内容不在
    expect(joined(chat.store.messages)).toContain('assistant-169')
    expect(joined(chat.store.messages)).not.toContain('user-1\n')
  })

  it('加载更早：拼到前面、覆盖到会话开头、按钮消失', async () => {
    const chat = await freshModule()
    await chat.openSession('s1')

    await chat.loadEarlier()
    // 注意：openSession 还会顺手读一次「会话累计」（列表末尾那行用），
    // 所以不能按固定下标断言 —— 按内容找那一页请求。
    const paged = calls.filter((c) => c.includes('/messages?') && c.includes('offset=100'))
    expect(paged).toHaveLength(1) // offset = 已加载条数（从最新往回数）
    // 这个 mock 不认 /api/sessions/s1（会抛）→ 累计保持 null，界面就不显示那行（不编数字）
    expect(calls.some((c) => c.endsWith('/api/sessions/s1'))).toBe(true)
    expect(chat.store.totals).toBeNull()

    const text = joined(chat.store.messages)
    expect(text).toContain('user-1') // 会话第一条已可见 ← 这正是原来缺失的部分
    expect(text).toContain('assistant-169')
    expect(chat.store.rawCount).toBe(169)
    expect(chat.store.hasMoreHistory).toBe(false)
  })

  it('发过新消息后 offset 会整体位移：按 id 去重，不出现重复段', async () => {
    const chat = await freshModule()
    await chat.openSession('s1') // 窗口 ids 70..169

    // 模拟期间又聊了 3 条（窗口锚定在"最新"，于是整体后移 3）
    SERVER.push(
      { id: 170, session_id: 's1', role: 'user', content: 'user-170', timestamp: 170 } as HermesMessage,
      { id: 171, session_id: 's1', role: 'assistant', content: 'assistant-171', timestamp: 171 } as HermesMessage,
      { id: 172, session_id: 's1', role: 'assistant', content: 'assistant-172', timestamp: 172 } as HermesMessage,
    )

    await chat.loadEarlier()
    const text = joined(chat.store.messages)
    // assistant-70 同时落在两个窗口里 —— 必须只出现一次
    expect(text.split('assistant-70').length - 1).toBe(1)
    expect(text).toContain('user-1')
  })

  it('没有会话 / 还有流式进行中时不动', async () => {
    const chat = await freshModule()
    await chat.loadEarlier()
    expect(calls.length).toBe(0)

    await chat.openSession('s1')
    const n = calls.length
    chat.store.streaming = true
    await chat.loadEarlier()
    expect(calls.length).toBe(n)
  })
})

describe('连续 assistant 合并（消除"多出来的换行"）', () => {
  it('连续 assistant 合成一段，user 之间不合并', async () => {
    const chat = await freshModule()
    const raw = [
      { id: 1, role: 'assistant', content: '第一段' },
      { id: 2, role: 'assistant', content: '第二段' },
      { id: 3, role: 'assistant', content: '第三段' },
      { id: 4, role: 'user', content: '用户插话' },
      { id: 5, role: 'assistant', content: '答一次' },
      { id: 6, role: 'assistant', content: '答二次' },
    ] as HermesMessage[]

    const ui = chat.normalize(raw)
    expect(ui.length).toBe(3)
    expect(ui[0].content).toBe('第一段\n\n第二段\n\n第三段')
    expect(ui[1].role).toBe('user')
    expect(ui[2].content).toBe('答一次\n\n答二次')
  })

  it('分页边界上的两段也要接上（否则缝还在）', async () => {
    const chat = await freshModule()
    const older = chat.normalize([{ id: 1, role: 'assistant', content: '早段' }] as HermesMessage[])
    const current = chat.normalize([{ id: 2, role: 'assistant', content: '晚段' }] as HermesMessage[])

    const merged = chat.prependEarlier(older, current)
    expect(merged.length).toBe(1)
    expect(merged[0].content).toBe('早段\n\n晚段')
  })

  it('边界一侧是 user 时不合并', async () => {
    const chat = await freshModule()
    const older = chat.normalize([{ id: 1, role: 'assistant', content: '答' }] as HermesMessage[])
    const current = chat.normalize([{ id: 2, role: 'user', content: '问' }] as HermesMessage[])
    expect(chat.prependEarlier(older, current).length).toBe(2)
  })

  it('压缩摘要标记出来，且不被合并进正文', async () => {
    const chat = await freshModule()
    const raw = [
      { id: 1, role: 'assistant', content: '正常回答' },
      { id: 2, role: 'assistant', content: '[CONTEXT COMPACTION — REFERENCE ONLY] 前面的对话被压缩了' },
      { id: 3, role: 'assistant', content: '压缩后的继续回答' },
    ] as HermesMessage[]

    const ui = chat.normalize(raw)
    expect(ui.length).toBe(3)
    expect(ui[1].compaction).toBe(true)
    expect(ui[0].content).toBe('正常回答') // 没有被压缩块污染
    expect(ui[2].content).toBe('压缩后的继续回答')
  })
})

describe('界面：加载更早按钮', () => {
  it('有更早历史时出现按钮，点击请求下一页', async () => {
    const chat = await freshModule()
    const ChatWindow = (await import('../components/ChatWindow.vue')).default

    await chat.openSession('s1')
    const w = mount(ChatWindow)
    const btn = w.findAll('button').find((b) => b.text().includes('加载更早的消息'))
    expect(btn).toBeTruthy()

    await btn!.trigger('click')
    await vi.waitFor(() => {
      expect(calls.some((c) => c.includes('offset=100'))).toBe(true)
    })
    // 到底了 → 按钮消失（注意：输入框的"发送"也是 button，必须按文案查）
    await vi.waitFor(() => {
      expect(w.findAll('button').some((b) => b.text().includes('加载更早的消息'))).toBe(false)
    })
  })
})

describe('界面：划到顶自动加载（按钮只是兜底）', () => {
  it('滚到顶部附近自动请求下一页，不用点按钮', async () => {
    const chat = await freshModule()
    const ChatWindow = (await import('../components/ChatWindow.vue')).default

    await chat.openSession('s1')
    const w = mount(ChatWindow)
    expect(calls.some((c) => c.includes('offset=100'))).toBe(false)

    // jsdom 没有布局：scrollTop 读回 0（≤ 60px 阈值），等价于"划到顶"
    await w.find('[data-testid="scroller"]').trigger('scroll')
    await vi.waitFor(() => {
      expect(calls.some((c) => c.includes('offset=100'))).toBe(true)
    })
  })

  it('到底之后滚动不再发请求', async () => {
    const chat = await freshModule()
    const ChatWindow = (await import('../components/ChatWindow.vue')).default

    await chat.openSession('s1')
    const w = mount(ChatWindow)
    await chat.loadEarlier() // 翻到底
    expect(chat.store.hasMoreHistory).toBe(false)

    const before = calls.length
    await w.find('[data-testid="scroller"]').trigger('scroll')
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.length).toBe(before)
  })

  it('正在加载时滚动不重复发请求', async () => {
    const chat = await freshModule()
    const ChatWindow = (await import('../components/ChatWindow.vue')).default

    await chat.openSession('s1')
    const w = mount(ChatWindow)
    chat.store.historyLoading = true

    const before = calls.length
    await w.find('[data-testid="scroller"]').trigger('scroll')
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.length).toBe(before)
  })
})
