/**
 * 消息列表末尾那行「会话累计」的 DOM 锁。
 *
 * 为什么要有它：逐轮 token 明细 Hermes 不落库（实测 messages.token_count 恒空），
 * 客户端只能显示会话累计 —— 这行是"切走/刷新后还能看到用量"的唯一入口，
 * 口径也必须跟每轮那行一致（输入合计 = 未命中 + 命中；命中率 = 命中 / 合计）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatWindow from './ChatWindow.vue'
import { store } from '../stores/chat'

beforeEach(() => {
  store.messages = []
  store.totals = null
  store.messagesLoading = false
  store.bootError = null
  store.hasMoreHistory = false
})

/**
 * 打开历史会话的落点 + 内容分波长高时的跟随（坑 50 的修法）。
 *
 * 真实形态（真浏览器实测）：打开会话后 DOM 是**分波**进的 ——
 * 1205px（只有一条消息）→ 3554px（几十个工具行插进来），
 * 而旧实现只在"部分内容"那一刻锚定一次 → 落点停在半路（21%~50%）。
 * 设计口径：打开历史会话**永远落到底部（最新消息）**。
 */
type ROCb = () => void
let roCallbacks: ROCb[] = []
let observedEls: Element[] = []

class FakeRO {
  cb: ROCb
  constructor(cb: ROCb) {
    this.cb = cb
    roCallbacks.push(cb)
  }
  observe(el: Element): void {
    observedEls.push(el)
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom 不做布局：手工给 scroller 造一套"可信的"高度/位置（scrollTop 按真实规则夹取） */
function fakeLayout(el: HTMLElement): { h: number; view: number; top: number } {
  const s = { h: 601, view: 601, top: 0 }
  Object.defineProperty(el, 'scrollHeight', { get: () => s.h, configurable: true })
  Object.defineProperty(el, 'clientHeight', { get: () => s.view, configurable: true })
  Object.defineProperty(el, 'scrollTop', {
    get: () => s.top,
    set: (v: number) => {
      s.top = Math.max(0, Math.min(Math.round(v), Math.max(0, s.h - s.view)))
    },
    configurable: true,
  })
  return s
}

const flush = (n = 4): Promise<void> =>
  new Promise((resolve) => {
    let i = 0
    const step = (): void => {
      if (++i >= n) return resolve()
      setTimeout(step, 0)
    }
    setTimeout(step, 0)
  })

describe('ChatWindow：打开会话落到最底部（内容分波长高也跟住）', () => {
  beforeEach(() => {
    roCallbacks = []
    observedEls = []
    vi.stubGlobal('ResizeObserver', FakeRO as unknown as typeof ResizeObserver)
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as unknown)
    store.messages = [{ key: 'm1', role: 'user', content: '旧消息' }]
  })

  /**
   * 接线断言（★ 真浏览器实测抓到过两次）：
   *  ① 只观察 scroller 没用 —— flex 布局里它的盒子固定，内容长高不会通知；
   *  ② 内容块（含"加载更早"行/累计行）是"有消息才渲染"的，挂载时可能还不存在 → 出现后必须补观察。
   * 这两条都锁住，否则"修复看起来生效了，其实一个通知都收不到"。
   */
  it('必须真的观察"消息区整块内容"（否则内容长高收不到任何通知）', async () => {
    const w = mount(ChatWindow)
    const contentEl = w.find('[data-testid="content"]').element
    expect(observedEls).toContain(contentEl)

    // 空态挂载（内容块还不存在）→ 出现后必须补上观察
    store.messages = []
    await w.vm.$nextTick()
    const w2 = mount(ChatWindow)
    expect(w2.find('[data-testid="content"]').exists()).toBe(false)
    observedEls = []
    store.messages = [{ key: 'x', role: 'user', content: '新消息' }]
    await w2.vm.$nextTick()
    await w2.vm.$nextTick()
    expect(observedEls).toContain(w2.find('[data-testid="content"]').element)
  })

  it('内容分三波长高（1205 → 3554）：最终必须贴底，而不是停在半路', async () => {
    const w = mount(ChatWindow)
    const el = w.find('[data-testid="scroller"]').element as HTMLElement
    const L = fakeLayout(el)

    store.currentId = 's1' // 打开会话
    await flush()
    L.h = 601 // 第一帧：列表还没内容
    await flush()
    L.h = 1205 // 第一波（只有一条消息）
    roCallbacks.forEach((cb) => cb())
    await flush()
    const midWay = L.top

    L.h = 2999 // 第二波（工具行插进来）
    roCallbacks.forEach((cb) => cb())
    await flush()
    L.h = 3554 // 第三波
    roCallbacks.forEach((cb) => cb())
    await flush(8)

    expect(L.top).toBe(L.h - L.view) // 贴底
    expect(midWay).toBeLessThan(L.h - L.view) // 中途那一刻确实不在底部（说明这条断言有意义）
  })

  it('稳定之后内容再长高（流式/工具行），只要还在底部就继续跟', async () => {
    const w = mount(ChatWindow)
    const el = w.find('[data-testid="scroller"]').element as HTMLElement
    const L = fakeLayout(el)

    store.currentId = 's1'
    L.h = 2000
    roCallbacks.forEach((cb) => cb())
    await flush(8)
    expect(L.top).toBe(L.h - L.view)

    L.h = 2600 // 又长高
    roCallbacks.forEach((cb) => cb())
    await flush()
    expect(L.top).toBe(L.h - L.view)
  })

  it('用户正在翻历史（已上滚）→ 内容长高也绝不把他拽回底部', async () => {
    const w = mount(ChatWindow)
    const el = w.find('[data-testid="scroller"]').element as HTMLElement
    const L = fakeLayout(el)

    store.currentId = 's1'
    L.h = 3000
    roCallbacks.forEach((cb) => cb())
    await flush(8)
    expect(L.top).toBe(L.h - L.view)

    // 用户上滚到顶（贴顶附近；hasMoreHistory=false 所以不会触发翻页请求）
    L.top = 0
    el.dispatchEvent(new Event('scroll'))
    await flush()
    L.h = 4200 // 内容又长高
    roCallbacks.forEach((cb) => cb())
    await flush()

    expect(L.top).toBe(0) // 一动不动
  })
})

describe('ChatWindow：会话累计行', () => {
  it('有累计时显示在消息列表末尾，口径与每轮那行一致', () => {
    store.messages = [{ key: 'm1', role: 'user', content: '你好' }]
    store.totals = { inputTokens: 700, cacheReadTokens: 1200, outputTokens: 300, toolCalls: 7 }

    const w = mount(ChatWindow)
    const line = w.find('[data-testid="session-totals"]')
    expect(line.exists()).toBe(true)

    const t = line.text().replace(/\s+/g, ' ')
    expect(t).toContain('本会话累计')
    expect(t).toContain('输入 1.9k') // 700 + 1200（输入合计，不是只显示未命中那部分）
    expect(t).toContain('缓存命中 63%') // 1200 / 1900
    expect(t).toContain('输出 300')
    expect(t).toContain('工具 7 次')
  })

  it('累计行在消息下面（不在上面）：DOM 顺序在消息列表之后', () => {
    store.messages = [{ key: 'm1', role: 'user', content: '你好' }]
    store.totals = { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1, toolCalls: 1 }
    const w = mount(ChatWindow)
    const list = w.find('.space-y-6')
    const line = w.find('[data-testid="session-totals"]')
    expect(list.exists()).toBe(true)
    // compareDocumentPosition: 4 = 后者在前者之后
    expect(list.element.compareDocumentPosition(line.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('拿不到累计（请求失败/新会话）→ 不显示，也不编数字', () => {
    store.messages = [{ key: 'm1', role: 'user', content: '你好' }]
    store.totals = null
    expect(mount(ChatWindow).find('[data-testid="session-totals"]').exists()).toBe(false)
  })

  it('空会话（没有消息）时走空态，不显示累计行', () => {
    store.messages = []
    store.totals = { inputTokens: 1, cacheReadTokens: 1, outputTokens: 1, toolCalls: 1 }
    expect(mount(ChatWindow).find('[data-testid="session-totals"]').exists()).toBe(false)
  })
})
