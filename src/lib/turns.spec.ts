/**
 * 按轮分组（v2.11 交错渲染的视图层入口）。
 *
 * 一轮 = 提问 + 若干助手段（正文段 / 工具行段 **按时间交替**），轮间才留白。
 * 这里锁的是"分组与段序"；DOM 上真实的先后、间距由真浏览器用例验（jsdom 不做布局）。
 */
import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../stores/chat'
import { groupIntoTurns } from './turns'

const ask = (k: string, c: string): UiMessage => ({ key: k, role: 'user', content: c })
const text = (k: string, c: string): UiMessage => ({ key: k, role: 'assistant', kind: 'text', content: c })
const tools = (k: string, name: string): UiMessage => ({
  key: k,
  role: 'assistant',
  kind: 'tools',
  content: '',
  tools: [{ name, preview: '', status: 'ok', ms: null }],
})

describe('groupIntoTurns()：一轮 = 提问 + 若干助手段', () => {
  it('★ 一轮内的段按原顺序保留（正文 → 工具行 → 正文），不跨轮混', () => {
    const turns = groupIntoTurns([
      ask('u1', '问一'),
      text('a1', '先看一眼'),
      tools('t1', 'terminal'),
      text('a2', '看完了'),
      ask('u2', '问二'),
      text('a3', '答二'),
    ])

    expect(turns).toHaveLength(2)
    expect(turns[0].ask?.key).toBe('u1')
    // 顺序就是交错的关键：正文 → 工具行 → 正文（旧行为是并成一段、工具堆在最上面）
    expect(turns[0].segs.map((s) => s.key)).toEqual(['a1', 't1', 'a2'])
    expect(turns[0].segs.map((s) => s.kind)).toEqual(['text', 'tools', 'text'])
    expect(turns[1].ask?.key).toBe('u2')
    expect(turns[1].segs.map((s) => s.key)).toEqual(['a3'])
  })

  it('页面从中间翻开（第一段是助手段、那一轮的提问不在本页）→ 也归一轮，ask 为 null', () => {
    const turns = groupIntoTurns([tools('t0', 'read_file'), text('a1', '早段')])
    expect(turns).toHaveLength(1)
    expect(turns[0].ask).toBeNull()
    expect(turns[0].segs.map((s) => s.key)).toEqual(['t0', 'a1'])
  })

  it('整轮只有工具行（一个字正文都没有）→ 仍是一轮，段不丢', () => {
    const turns = groupIntoTurns([ask('u1', '跑一下'), tools('t1', 'terminal')])
    expect(turns).toHaveLength(1)
    expect(turns[0].segs.map((s) => s.kind)).toEqual(['tools'])
  })

  it('没有段的提问（刚发出、模型还没动）→ 一轮、段为空（不造假段）', () => {
    const turns = groupIntoTurns([ask('u1', '刚发的')])
    expect(turns).toHaveLength(1)
    expect(turns[0].segs).toEqual([])
  })

  it('空列表 → 空结果', () => {
    expect(groupIntoTurns([])).toEqual([])
  })
})
