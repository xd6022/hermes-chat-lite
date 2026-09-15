import { describe, expect, it } from 'vitest'
import { securityBlock } from './security'

/**
 * 用例全部取自服务端 `tools/approval.py` 里的**真实文案**（2026-09-12 读码摘录），
 * 保证判据和服务端一致；服务端改文案时这里会先红。
 *
 * 文案分通道（2026-09-15）：默认通道 `/v1/runs` 有审批接线，审批类 BLOCKED 只可能是
 * "超时没人回应 / 用户点了拒绝"；回退通道 `chat/stream` 零接线，同一句话 = 当场 fail-closed。
 */
describe('识别"被安全闸门拦下"（securityBlock）', () => {
  it('审批类：默认通道（runs）= 没等到回应或被拒 → 提示重新发一次点批准', () => {
    const r = securityBlock(
      'BLOCKED: approval required (destructive rm -rf) but no approver is available in this context',
    )
    expect(r?.kind).toBe('approval')
    expect(r?.hint).toContain('没等到您的回应')
    expect(r?.hint).toContain('您点了拒绝')
    expect(r?.hint).toContain('批准一次')
    expect(r?.snippet.startsWith('BLOCKED')).toBe(true)
  })

  it('审批类：回退通道（stream）= 那条路没有审批接线 → 提示切回默认通道', () => {
    const r = securityBlock(
      'BLOCKED: Failed to send approval request to user. Do NOT retry.',
      'stream',
    )
    expect(r?.kind).toBe('approval')
    expect(r?.hint).toContain('旧通道')
    expect(r?.hint).toContain('/v1/runs')
  })

  it('审批类：notify 失败（回退通道 chat/stream 就是这条路径）', () => {
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
