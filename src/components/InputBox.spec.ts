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
