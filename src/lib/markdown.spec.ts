/**
 * Markdown 渲染层回归（v2.1 移动端表格横向溢出修复的锁）。
 *
 * 锁的是什么：**每个 `<table>` 必须被 `<div class="table-wrapper">` 包住**。
 * 这是整个修复的源头 —— 少了这层 wrapper，超宽表格就会把消息区（scroll 容器）
 * 的 scrollWidth 撑大，手机上整块聊天区能左右拖（用户报的 bug）。
 *
 * 为什么这个断言要放在单测里：jsdom 不做布局，`scrollWidth` 全是 0，
 * 溢出行为只能在真浏览器里验（见 `docs/detailed-design.md` §10.3 的浏览器证据）；
 * 但"有没有 wrapper"是纯字符串/结构问题，单测能锁死，防止以后有人改渲染器时漏掉。
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

/** 用户报的那个真实场景：10 列行情表，手机上一定比屏幕宽 */
const WIDE_TABLE = [
  '| 日期 | 开盘 | 收盘 | 最高 | 最低 | 成交量 | 成交额 | 涨跌幅 | 换手率 | 市值 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| 2026-09-01 | 1.020 | 1.031 | 1.035 | 1.018 | 123456789 | 987654321 | +1.08% | 0.42% | 320亿 |',
].join('\n')

const WRAPPER_OPEN = '<div class="table-wrapper thin-scroll">'

describe('renderMarkdown：表格 wrapper', () => {
  it('超宽表格被 wrapper 包住，且 wrapper 紧贴 table（中间不能插东西）', () => {
    const html = renderMarkdown(WIDE_TABLE)
    expect(html).toContain(`${WRAPPER_OPEN}<table>`)
    // 闭合顺序：</table> 紧跟 </div>（中间只允许换行，不能有别的兄弟节点）
    expect(html).toMatch(/<\/table>\s*<\/div>/)
  })

  it('wrapper 与 div 配平（多表格场景不串层）', () => {
    const html = renderMarkdown(`${WIDE_TABLE}\n\n中间一段普通文本\n\n${WIDE_TABLE}`)
    expect(html.match(/<div class="table-wrapper/g)).toHaveLength(2)
    // markdown-it 本身不产出其它 div，所以总数应该刚好等于 wrapper 数
    expect(html.match(/<\/div>/g)).toHaveLength(2)
    expect(html).toContain('中间一段普通文本')
  })

  it('没有表格时不会凭空出现 wrapper', () => {
    const html = renderMarkdown('# 标题\n\n- 列表项\n\n```python\nprint("| not a table |")\n```')
    expect(html).not.toContain('table-wrapper')
    expect(html).not.toContain('<table>')
    // 围栏代码块里的管道符不能触发表格解析（markdown 表格必须在块级上下文）
    expect(html).toContain('language-python')
  })

  it('表格里的行内格式与转义照旧（wrapper 不影响原有渲染）', () => {
    const html = renderMarkdown(`| A | B |\n| --- | --- |\n| **粗** | \`code\` |`)
    expect(html).toContain(`${WRAPPER_OPEN}<table>`)
    expect(html).toContain('<strong>粗</strong>')
    expect(html).toContain('<code>code</code>')
  })

  it('安全项没被破坏：原始 HTML 仍然被转义（html:false）', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n| A |\n| --- |\n| <b>x</b> |')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<b>x</b>')
  })
})
