import { describe, expect, it } from 'vitest'
import { argPreview, isCompactionNote, toolFailed } from './messages'

/* ---------------- 工具调用：参数预览 + 失败判据（内联渲染用） ---------------- */

describe('工具参数预览 argPreview()', () => {
  it('JSON 参数取"最像主参数"的那个键（command/路径/URL 优先）', () => {
    expect(argPreview('{"command":"ls -la /opt/data","timeout":30}')).toBe('ls -la /opt/data')
    expect(argPreview('{"path":"src/App.vue"}')).toBe('src/App.vue')
    expect(argPreview('{"url":"https://example.com/a?b=1"}')).toBe('https://example.com/a?b=1')
  })

  it('超长截断、换行压成空格（历史里是整段 JSON，不能铺开占屏）', () => {
    const out = argPreview(JSON.stringify({ command: `${'x'.repeat(120)}\nnext` }), 20)
    expect(out).toBe(`${'x'.repeat(20)}…`)
    expect(out).not.toContain('\n')
  })

  it('非 JSON / 空参数不炸：能显示多少显示多少', () => {
    expect(argPreview('not json at all')).toBe('not json at all')
    expect(argPreview(undefined)).toBe('')
    expect(argPreview('')).toBe('')
  })
})

describe('工具失败的启发式判据 toolFailed()', () => {
  it('错误对象 / 异常文本算失败', () => {
    expect(toolFailed('{"error": "No such file"}')).toBe(true)
    expect(toolFailed('  {"detail": "Forbidden"}')).toBe(true)
    expect(toolFailed('BLOCKED (hardline): command parser limit')).toBe(true)
    expect(toolFailed('Traceback (most recent call last):')).toBe(true)
  })

  it('正常输出里出现 error 字样**不算**失败（判据锚在开头，这是不误报的关键）', () => {
    expect(toolFailed('{"ok":true,"stderr":"grep: error found in log"}')).toBe(false)
    expect(toolFailed('日志里有 3 个 error，但命令本身成功了')).toBe(false)
    expect(toolFailed('')).toBe(false)
  })
})

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
