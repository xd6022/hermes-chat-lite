/**
 * 样式契约（v2.1 移动端表格横向溢出修复的锁）。
 *
 * 为什么用"读 CSS 原文 + 断言声明"这种方式：jsdom **不做布局**，`scrollWidth`
 * 永远是 0，所以"页面会不会横向溢出"在单测里验不了（真浏览器证据见
 * `docs/detailed-design.md` §10.3）。但**规则本身在不在、是不是又被改回 `w-full`**
 * 是可以锁的，而且这正是这次 bug 的成因 —— 值一次断言，防止回归。
 *
 * 三条契约（对应需求三、四）：
 *  ① 表格必须是"自己滚自己"：wrapper 上 `overflow-x: auto` + 表格 `max-content`；
 *  ② 消息容器不许被撑破：`.md-body` 上 `min-width: 0` / `max-width: 100%`；
 *  ③ 禁止用"整个页面横向滚动"当解法：html/body/#app 上不许出现 `overflow-x`。
 */
import { describe, expect, it } from 'vitest'
// 读源文件（两种更"优雅"的写法都试过，都不可用，别再走一遍）：
//   `import css from './style.css?raw'` —— vitest 默认 css:false，拿到的是**空串**
//   `new URL('./style.css', import.meta.url)` —— 报 "The URL must be of scheme file"
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'style.css'), 'utf8')
/** 注释先剥掉：注释会跟后面的选择器一起被切成"选择器"，精确匹配会失准 */
const css = source.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取出所有最内层规则块（@layer 只是分组，不影响这里的解析） */
function ruleBlocks(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    out.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] })
  }
  return out
}

/** 精确匹配某条选择器（避免 `.md-body table` 命中 `.md-body table td` 之类） */
function ruleOf(selector: string): string {
  const hit = ruleBlocks().filter((r) => r.selector === selector)
  expect(hit.map((r) => r.body).join('\n'), `style.css 里找不到规则：${selector}`).not.toBe('')
  return hit.map((r) => r.body).join('\n')
}

describe('样式契约：超宽表格自己滚，不许撑破页面', () => {
  it('table wrapper 承担横向滚动，宽度被限制在容器内', () => {
    const body = ruleOf('.md-body .table-wrapper')
    expect(body).toMatch(/overflow-x:\s*auto/)
    expect(body).toMatch(/width:\s*100%/)
    expect(body).toMatch(/max-width:\s*100%/)
  })

  it('表格用 max-content 保住列宽（不被压扁），窄表格仍铺满容器', () => {
    const body = ruleOf('.md-body table')
    expect(body).toMatch(/width:\s*max-content/)
    expect(body).toMatch(/min-width:\s*100%/)
    // ★ 就是这条 w-full 造成溢出：表格的 used width 不会小于各列 min-content 之和，
    //   100% 只当"下限"用，于是表格比容器宽 → 撑大消息区 scrollWidth。
    expect(body, '表格不能再回到 w-full（width:100%）').not.toMatch(/w-full/)
  })

  it('消息正文容器：min-width: 0 + max-width: 100% + 长串可断', () => {
    const body = ruleOf('.md-body')
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/max-width:\s*100%/)
    expect(body).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('代码块仍然是自己滚自己（回归：pre 不受本次改动影响）', () => {
    // pre 上写的是 Tailwind 工具类（@apply overflow-x-auto），不是字面声明
    expect(ruleOf('.md-body pre')).toMatch(/overflow-x(-auto|\s*:\s*auto)/)
  })

  it('★ 禁止"给整个页面加横向滚动"这种解法（需求四明文禁止）', () => {
    const offenders = ruleBlocks().filter(
      (r) =>
        /(^|[\s,])(html|body|#app)([\s,]|$)/.test(r.selector) && /overflow-x/.test(r.body),
    )
    expect(offenders.map((r) => r.selector), '页面级 overflow-x 等于把问题从"表格滚"变成"整页滚"').toEqual(
      [],
    )
  })
})
