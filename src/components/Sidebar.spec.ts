import { beforeEach, describe, expect, it } from 'vitest'
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
