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
 * 轮内的**工具行段**（v2.11）：常驻小字行、不折叠、段内没有正文。
 * "它落在两段正文之间的哪个位置"由 normalize/turns 决定 —— 见 `lib/turns.spec.ts`
 * 与真浏览器的 DOM 顺序用例；这里只锁结构、标记与"不再有折叠开关"。
 */
describe('MessageItem：工具行段（常驻小字行、不折叠）', () => {
  const TOOLS: ToolStep[] = [
    { name: 'terminal', preview: 'ls -la /opt/data', status: 'ok', ms: 320 },
    { name: 'read_file', preview: 'a.py', status: 'fail', ms: 1500 },
  ]

  /** 一段工具行（`kind: 'tools'` 的段：没有正文，内容全在 tools 里） */
  function toolsSeg(tools: ToolStep[]): UiMessage {
    return { key: 'tg', role: 'assistant', kind: 'tools', content: '', tools }
  }

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

  it('没有折叠开关：一渲染就是明细（用户口径：常驻小字行）', () => {
    const wrapper = mount(MessageItem, { props: { msg: toolsSeg(TOOLS) } })
    expect(wrapper.find('[data-testid="tools-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tools-block"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="tools-list"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="tools-list"] li')).toHaveLength(2)
    expect(wrapper.find('.md-body').exists()).toBe(false) // 工具行段没有正文
  })

  it('一行一个：标记 + 工具名 + 参数预览 + 耗时', () => {
    const wrapper = mount(MessageItem, { props: { msg: toolsSeg(TOOLS) } })
    const rows = wrapper.findAll('[data-testid="tools-list"] li')
    expect(rows[0].text()).toContain('✓') // 成功
    expect(rows[0].text()).toContain('terminal')
    expect(rows[0].text()).toContain('"ls -la /opt/data"')
    expect(rows[0].text()).toContain('(0.3s)')
    expect(rows[1].text()).toContain('✗') // 失败
    expect(rows[1].text()).toContain('(1.5s)')
  })

  it('运行中的工具用 ●，且没有耗时就不显示括号', () => {
    const wrapper = mount(MessageItem, {
      props: { msg: toolsSeg([{ name: 'terminal', preview: 'sleep 30', status: 'run', ms: null }]) },
    })
    const list = wrapper.find('[data-testid="tools-list"]').text()
    expect(list).toContain('●')
    expect(list).not.toContain('(')
  })

  it('正文段不出现工具行（工具行是独立的一段，落在真实时间位置）', async () => {
    const wrapper = await renderText(ui({ content: '看完了', tools: TOOLS }))
    expect(wrapper.find('[data-testid="tools-list"]').exists()).toBe(false)
    expect(wrapper.find('.md-body').text()).toContain('看完了')
  })

  it('用户消息不出现工具行', () => {
    const wrapper = mount(MessageItem, { props: { msg: ui({ role: 'user', content: '你好' }) } })
    expect(wrapper.find('[data-testid="tools-list"]').exists()).toBe(false)
  })
})

describe('MessageItem：被打断的轮次要贴「已中断」（对齐 dashboard 的 · interrupted）', () => {
  // 注意：不能复用上面的 render()（它是给表格用例写的，会等 '.table-wrapper' 出现），
  // 这里正文是纯文本 → 直接 mount + waitFor 正文落地。
  function mountMsg(item: UiMessage) {
    return mount(MessageItem, { props: { msg: item } })
  }

  it('有 interrupted 标记时贴出「已中断」，且已输出的正文保留', async () => {
    const w = mountMsg(ui({ content: '说到一半的内容', interrupted: true }))
    const mark = w.find('[data-testid="msg-interrupted"]')
    expect(mark.exists()).toBe(true)
    expect(mark.text()).toContain('已中断')
    await vi.waitFor(() => expect(w.find('.md-body').text()).toContain('说到一半的内容'))
  })

  it('正常完成的轮次不出现这个标记', async () => {
    const w = mountMsg(ui({ content: '正常回答' }))
    expect(w.find('[data-testid="msg-interrupted"]').exists()).toBe(false)
  })
})

describe('MessageItem：用户消息可以一键复制（2026-09-17 用户要求）', () => {
  it('用户消息气泡下方有复制按钮；点击把**原文**写进剪贴板，标签变「已复制」', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mount(MessageItem, { props: { msg: ui({ role: 'user', content: '把这条复回去\n第二行' }) } })

    const btn = w.find('[data-testid="copy-user"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('复制')

    await btn.trigger('click')
    await vi.waitFor(() => expect(btn.text()).toBe('已复制'))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('把这条复回去\n第二行')
  })

  it('点完 1.5s 后标签自动变回「复制」（不用点第二次，也不留常驻状态）', async () => {
    vi.useFakeTimers()
    try {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
      const w = mount(MessageItem, { props: { msg: ui({ role: 'user', content: 'hi' }) } })
      const btn = w.find('[data-testid="copy-user"]')

      await btn.trigger('click')
      await vi.advanceTimersByTimeAsync(0)
      expect(btn.text()).toBe('已复制')

      await vi.advanceTimersByTimeAsync(1600)
      expect(btn.text()).toBe('复制')
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有 clipboard API 时如实说「复制失败」（不假装成功）', async () => {
    Object.assign(navigator, { clipboard: undefined })
    const w = mount(MessageItem, { props: { msg: ui({ role: 'user', content: 'hi' }) } })
    const btn = w.find('[data-testid="copy-user"]')

    await btn.trigger('click')
    await vi.waitFor(() => expect(btn.text()).toBe('复制失败'))
  })

  it('助手消息不出现复制按钮（只给我发出去的那半条）', () => {
    const w = mount(MessageItem, { props: { msg: ui({ role: 'assistant', content: '回复' }) } })
    expect(w.find('[data-testid="copy-user"]').exists()).toBe(false)
  })
})
