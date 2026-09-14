/**
 * 消息列表末尾那行「会话累计」的 DOM 锁。
 *
 * 为什么要有它：逐轮 token 明细 Hermes 不落库（实测 messages.token_count 恒空），
 * 客户端只能显示会话累计 —— 这行是"切走/刷新后还能看到用量"的唯一入口，
 * 口径也必须跟每轮那行一致（输入合计 = 未命中 + 命中；命中率 = 命中 / 合计）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
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
