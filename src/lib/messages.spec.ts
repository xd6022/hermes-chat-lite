import { describe, expect, it } from 'vitest'
import { isCompactionNote } from './messages'

/**
 * 压缩摘要识别。用例取自 2026-09-11 从真实会话读回的原文形态
 * （会话 20260911_183957_70912c，消息 id=25660）。
 */
describe('压缩摘要识别（判据对齐 Hermes 自身实现）', () => {
  it('真实压缩消息：开头是 [PRIOR CONTEXT]，标记在后面 —— 必须仍能识别', () => {
    const real =
      '[PRIOR CONTEXT — for reference only; not a new message]\n\n\n' +
      '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n' +
      '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted ...'
    expect(isCompactionNote(real)).toBe(true)
  })

  it('以 [CONTEXT COMPACTION 开头的标准形态', () => {
    expect(isCompactionNote('[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted')).toBe(true)
  })

  it('[CONTEXT SUMMARY]: 形态', () => {
    expect(isCompactionNote('[CONTEXT SUMMARY]: 前面聊了 A、B、C')).toBe(true)
  })

  it('Conversation Summary（Hermes 压缩器判据里的第三种写法）', () => {
    expect(isCompactionNote('Conversation Summary\n\n用户在开发一个前端')).toBe(true)
  })

  it('正常正文不误判', () => {
    expect(isCompactionNote('查清楚了，不是我的前端算的，是模型返回的。')).toBe(false)
    expect(isCompactionNote('## 三个东西的生命周期\n\n| 会话 | ... |')).toBe(false)
    expect(isCompactionNote('')).toBe(false)
  })

  it('判据只看前 280 字符（与 Hermes 一致）：正文深处出现该词不算', () => {
    const far = `${'正'.repeat(300)}\n\nCONTEXT COMPACTION 这个词只是在正文里被提到`
    expect(isCompactionNote(far)).toBe(false)
  })
})
