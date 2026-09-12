import { describe, expect, it } from 'vitest'
import { securityBlock } from './security'

/**
 * 用例全部取自服务端 `tools/approval.py` 里的**真实文案**（2026-09-12 读码摘录），
 * 保证判据和服务端一致；服务端改文案时这里会先红。
 */
describe('识别"被安全闸门拦下"（securityBlock）', () => {
  it('审批类：approval required 但无人可问 → 提示去 TUI 批准', () => {
    const r = securityBlock(
      'BLOCKED: approval required (destructive rm -rf) but no approver is available in this context',
    )
    expect(r?.kind).toBe('approval')
    expect(r?.hint).toContain('没有审批通道')
    expect(r?.hint).toContain('TUI')
    expect(r?.snippet.startsWith('BLOCKED')).toBe(true)
  })

  it('审批类：notify 失败（网页端就是这条路径）', () => {
    const r = securityBlock('BLOCKED: Failed to send approval request to user. Do NOT retry.')
    expect(r?.kind).toBe('approval')
  })

  it('审批类：等不到用户响应而超时', () => {
    const r = securityBlock('BLOCKED: Action timed out without user response. The user is not available.')
    expect(r?.kind).toBe('approval')
  })

  it('审批类：用户在别处点了拒绝', () => {
    const r = securityBlock('BLOCKED: User denied this potentially dangerous action (rm -rf).')
    expect(r?.kind).toBe('approval')
  })

  it('规则类：Tirith 扫出危险命令', () => {
    const r = securityBlock('Command was flagged (Security scan — [HIGH] Pipe to interpreter) ...')
    expect(r).toBeNull() // 没有 BLOCKED 字样（这是"被标记但放行"的提示）→ 不该误报

    const r2 = securityBlock('BLOCKED: Command flagged as dangerous (rm -rf /tmp/x) and denied.')
    expect(r2?.kind).toBe('rule')
    expect(r2?.hint).toContain('安全策略')
  })

  it('规则类：hardline 与自定义 deny 规则', () => {
    expect(securityBlock('BLOCKED (hardline): refusing to run this.')?.kind).toBe('rule')
    expect(
      securityBlock('BLOCKED: this command matches the user-defined deny rule for git push')?.kind,
    ).toBe('rule')
  })

  it('不误报：普通工具输出 / 空值', () => {
    expect(securityBlock('')).toBeNull()
    expect(securityBlock('{"bytes_written":784}')).toBeNull()
    expect(securityBlock('Command executed successfully')).toBeNull()
  })

  it('snippet 截断到 240 字符以内（原文可能很长）', () => {
    const long = 'BLOCKED: approval required ' + 'x'.repeat(1000)
    expect(securityBlock(long)!.snippet.length).toBe(240)
  })
})
