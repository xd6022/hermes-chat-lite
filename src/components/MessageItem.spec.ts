/**
 * 单条消息的 DOM 结构（v2.1 移动端表格横向溢出修复的组件级锁）。
 *
 * 单测只到"结构"这一层：wrapper 在不在、类名在不在、表格后面那条消息有没有被牵连
 *（DOM 上它是兄弟节点，不是表格的子节点）。**真正的宽度/滚动行为 jsdom 测不了**，
 * 由真浏览器用例负责（`docs/detailed-design.md` §10.3）。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageItem from './MessageItem.vue'
import type { ToolStep, UiMessage } from '../stores/chat'

const WIDE_TABLE = [
  '| 日期 | 开盘 | 收盘 | 最高 | 最低 | 成交量 | 成交额 | 涨跌幅 | 换手率 | 市值 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 2026-09-01 | 1.020 | 1.031 | 1.035 | 1.018 | 123456789 | 987654321 | +1.08% | 0.42% | 320亿 |',
].join('\n')

function ui(over: Partial<UiMessage> = {}): UiMessage {
  return { key: 'k1', role: 'assistant', content: '', ...over }
}

/** 等 rAF 节流的那次重渲染落地（MessageItem 用 requestAnimationFrame 更新 v-html） */
async function render(item: UiMessage) {
  const wrapper = mount(MessageItem, { props: { msg: item } })
  await vi.waitFor(() => {
    if (item.content && !wrapper.find('.md-body').html().includes('table')) {
      throw new Error('markdown 还没渲染完')
    }
  })
  return wrapper
}

describe('MessageItem：超宽表格的 DOM 结构', () => {
  it('助手消息里的表格被 wrapper 包住，表格是 wrapper 的直接子节点', async () => {
    const wrapper = await render(ui({ content: `看一下这张表：\n\n${WIDE_TABLE}\n\n下面是结论。` }))
    const w = wrapper.find('.md-body > .table-wrapper')
    expect(w.exists()).toBe(true)
    // 表格必须是 wrapper 的直接子节点（不能隔着其它盒子，否则滚动区位置不对）
    expect(w.find('table').element.parentElement).toBe(w.element)
    expect(w.classes()).toContain('thin-scroll')
  })

  it('表格后面的普通文本是兄弟节点（不会被包进表格自己的滚动区）', async () => {
    const wrapper = await render(ui({ content: `${WIDE_TABLE}\n\n下面是结论。` }))
    const body = wrapper.find('.md-body')
    const wrapperEl = body.find('.table-wrapper').element
    const paras = Array.from(body.element.querySelectorAll('p'))
    const para = paras[paras.length - 1]
    expect(para.textContent).toContain('下面是结论')
    expect(wrapperEl.contains(para)).toBe(false)
  })

  it('消息容器带 min-w-0 / max-w-full（flex 子项不被 min-content 撑开）', async () => {
    const wrapper = await render(ui({ content: `${WIDE_TABLE}` }))
    const group = wrapper.find('.group')
    expect(group.classes()).toContain('min-w-0')
    expect(group.classes()).toContain('max-w-full')
  })

  it('用户消息：长 URL / 无空格长串不被撑破（min-w-0 + break-words）', () => {
    const long = 'https://example.com/' + 'a'.repeat(300)
    const wrapper = mount(MessageItem, { props: { msg: ui({ role: 'user', content: long }) } })
    const bubble = wrapper.find('.whitespace-pre-wrap')
    expect(bubble.classes()).toContain('min-w-0')
    expect(bubble.classes()).toContain('break-words')
    expect(bubble.text()).toBe(long) // 用户消息不解析 markdown
  })

  it('压缩摘要里的表格同样有 wrapper（隐藏分支不能漏）', async () => {
    const wrapper = await render(ui({ compaction: true, content: WIDE_TABLE }))
    expect(wrapper.find('details .md-body > .table-wrapper').exists()).toBe(true)
  })
})

/**
 * 本轮工具调用（v2.3）：内联在这条回复下面、默认折叠。
 * 结构与标记在这一层锁住；颜色深浅属于肉眼观感，交给真浏览器用例。
 */
describe('MessageItem：本轮工具调用块', () => {
  const TOOLS: ToolStep[] = [
    { name: 'terminal', preview: 'ls -la /opt/data', status: 'ok', ms: 320 },
    { name: 'read_file', preview: 'a.py', status: 'fail', ms: 1500 },
  ]

  /** 等 markdown 渲染落地（不能用上面那个只认表格的 helper；用户消息没有 .md-body） */
  async function renderText(item: UiMessage) {
    const wrapper = mount(MessageItem, { props: { msg: item } })
    if (item.role === 'assistant' && item.content) {
      await vi.waitFor(() => {
        if (!wrapper.find('.md-body').text().includes(item.content)) throw new Error('markdown 还没渲染完')
      })
    }
    return wrapper
  }

  it('默认展开：直接看到明细；再点一下收起', async () => {
    const wrapper = await renderText(ui({ content: '看完了', tools: TOOLS }))
    expect(wrapper.find('[data-testid="tools-block"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tools-toggle"]').text()).toContain('工具调用 (2)')
    expect(wrapper.find('[data-testid="tools-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-testid="tools-list"]').exists()).toBe(true)

    // 收起 / 再展开
    await wrapper.find('[data-testid="tools-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="tools-list"]').exists()).toBe(false)
    await wrapper.find('[data-testid="tools-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="tools-list"]').exists()).toBe(true)
  })

  it('★ 工具块在正文**之前**（时间顺序的原样：先跑工具、再出正文）', async () => {
    const wrapper = await renderText(ui({ content: '看完了', tools: TOOLS }))
    const children = Array.from(wrapper.find('.group').element.children)
    const idxTools = children.findIndex((el) => el.getAttribute('data-testid') === 'tools-block')
    const idxBody = children.findIndex((el) => el.classList.contains('md-body'))
    expect(idxTools).toBeGreaterThanOrEqual(0)
    expect(idxBody).toBeGreaterThan(idxTools)
  })

  it('展开后一行一个：标记 + 工具名 + 参数预览 + 耗时', async () => {
    const wrapper = await renderText(ui({ content: '看完了', tools: TOOLS }))

    const rows = wrapper.findAll('[data-testid="tools-list"] li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('✓') // 成功
    expect(rows[0].text()).toContain('terminal')
    expect(rows[0].text()).toContain('"ls -la /opt/data"')
    expect(rows[0].text()).toContain('(0.3s)')
    expect(rows[1].text()).toContain('✗') // 失败
    expect(rows[1].text()).toContain('(1.5s)')
  })

  it('运行中的工具用 ●，且没有耗时就不显示括号', async () => {
    const wrapper = await renderText(
      ui({ content: '跑着呢', tools: [{ name: 'terminal', preview: 'sleep 30', status: 'run', ms: null }] }),
    )
    const list = wrapper.find('[data-testid="tools-list"]').text()
    expect(list).toContain('●')
    expect(list).not.toContain('(')
  })

  it('没有工具的消息不出现这个块（用户消息 / 纯文本回复都不出）', async () => {
    expect((await renderText(ui({ content: '你好' }))).find('[data-testid="tools-block"]').exists()).toBe(false)
    expect(
      (await renderText(ui({ role: 'user', content: '你好' }))).find('[data-testid="tools-block"]').exists(),
    ).toBe(false)
  })
})
