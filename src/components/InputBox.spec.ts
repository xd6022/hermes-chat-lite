import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

/** 只替换 send/stop 两个副作用函数，store 本体保持真实（组件要读 store.streaming） */
const h = vi.hoisted(() => ({ send: vi.fn(), stop: vi.fn() }))

vi.mock('../stores/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stores/chat')>()
  return { ...actual, send: h.send, stop: h.stop }
})

import InputBox from './InputBox.vue'
import { store } from '../stores/chat'

beforeEach(() => {
  h.send.mockClear()
  h.stop.mockClear()
  store.streaming = false
})

describe('InputBox 布局（文字区与按钮上下两段）', () => {
  it('文字区占满整宽，按钮在独立的工具行里（不能并排）', () => {
    const w = mount(InputBox)
    const ta = w.find('textarea')
    const btn = w.find('button')

    // 并排时按钮会挤掉文字区右侧（症状：输入长内容时按钮上方一片空）
    expect(ta.element.parentElement).not.toBe(btn.element.parentElement)
    expect(ta.classes()).toContain('w-full')

    // 按钮那一行是文字区的兄弟节点，同属外层圆角容器
    expect(btn.element.parentElement?.parentElement).toBe(ta.element.parentElement)
  })

  it('只有一个按钮（发送/停止），工具行是预留位', () => {
    const w = mount(InputBox)
    expect(w.findAll('button').length).toBe(1)
  })
})

describe('InputBox 输入规则', () => {
  it('Enter 发送', async () => {
    const w = mount(InputBox)
    await w.find('textarea').setValue('看看盘面')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(h.send).toHaveBeenCalledWith('看看盘面')
  })

  it('Shift+Enter 换行，不发送', async () => {
    const w = mount(InputBox)
    await w.find('textarea').setValue('第一行')
    await w.find('textarea').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('中文输入法合成期间按 Enter 不发送（否则拼音候选回车会误发）', async () => {
    const w = mount(InputBox)
    await w.find('textarea').setValue('nihao')
    await w.find('textarea').trigger('compositionstart')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(h.send).not.toHaveBeenCalled()

    await w.find('textarea').trigger('compositionend')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(h.send).toHaveBeenCalledWith('nihao')
  })

  it('空内容不发送', async () => {
    const w = mount(InputBox)
    await w.find('textarea').setValue('   ')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('发送后清空输入框', async () => {
    const w = mount(InputBox)
    await w.find('textarea').setValue('你好')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('生成中：发送按钮变停止，点击调用 stop', async () => {
    store.streaming = true
    const w = mount(InputBox)
    const btn = w.find('button')
    expect(btn.text()).toBe('停止')
    await btn.trigger('click')
    expect(h.stop).toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('生成中按 Enter 不重复发送（防自并发）', async () => {
    store.streaming = true
    const w = mount(InputBox)
    await w.find('textarea').setValue('再问一句')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('InputBox 历史输入（↑ / ↓，像 shell）', () => {
  function seed(texts: string[]): void {
    store.messages = texts.map((t, i) => ({ key: `k${i}`, role: 'user' as const, content: t }))
  }

  beforeEach(() => {
    store.messages = []
  })

  it('↑ 填上我发的上一条；连按继续往前翻', async () => {
    seed(['第一条', '第二条', '第三条'])
    const w = mount(InputBox)
    const ta = w.find('textarea')

    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第三条')
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第二条')
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第一条')
    // 到顶了就不动（不是循环，也不是清空）
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第一条')
  })

  it('↓ 往回走；翻到最后一条时还原"翻历史之前打的草稿"', async () => {
    seed(['第一条', '第二条'])
    const w = mount(InputBox)
    const ta = w.find('textarea')

    await ta.setValue('我正在打一半的内容')
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第二条')
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第一条')

    await ta.trigger('keydown', { key: 'ArrowDown' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第二条')
    await ta.trigger('keydown', { key: 'ArrowDown' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('我正在打一半的内容')
  })

  it('不在翻历史时按 ↓ 什么都不做（不误拦原生操作）', async () => {
    seed(['第一条'])
    const w = mount(InputBox)
    const ta = w.find('textarea')
    await ta.setValue('草稿')
    await ta.trigger('keydown', { key: 'ArrowDown' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('草稿')
  })

  it('输入法合成期间 ↑ 不拦截（拼音候选框要用方向键选字）', async () => {
    seed(['第一条'])
    const w = mount(InputBox)
    const ta = w.find('textarea')
    await ta.setValue('nihao')
    await ta.trigger('compositionstart')
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('nihao')

    await ta.trigger('compositionend')
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('第一条')
  })

  it('多行草稿里光标不在首行时，↑ 交给原生行为（在文本里移动光标）', async () => {
    seed(['第一条'])
    const w = mount(InputBox)
    const ta = w.find('textarea')
    await ta.setValue('第一行\n第二行')
    const node = ta.element as HTMLTextAreaElement
    node.setSelectionRange(6, 6) // 光标落在第二行

    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect(node.value).toBe('第一行\n第二行')
  })

  it('没有历史（会话刚开）时按 ↑ 不动', async () => {
    const w = mount(InputBox)
    const ta = w.find('textarea')
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('')
  })

  it('发送后清掉历史游标：下一次 ↑ 从刚发的那条开始', async () => {
    seed(['旧消息'])
    const w = mount(InputBox)
    const ta = w.find('textarea')

    await ta.setValue('刚发出去的')
    await ta.trigger('keydown', { key: 'Enter' })
    expect(h.send).toHaveBeenCalledWith('刚发出去的')

    // 服务端还没回，界面先把这句放进历史（乐观插入）→ ↑ 拿到它
    store.messages = [
      ...store.messages,
      { key: 'new', role: 'user', content: '刚发出去的' },
    ] as typeof store.messages
    await ta.trigger('keydown', { key: 'ArrowUp' })
    expect((ta.element as HTMLTextAreaElement).value).toBe('刚发出去的')
  })
})
