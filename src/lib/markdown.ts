/**
 * Markdown 渲染：markdown-it + highlight.js。
 *
 * 安全项（必须保持）：html: false —— agent 输出里可能带原始 HTML，
 * 打开它等于给 agent 一个注入前端 DOM 的通道。
 *
 * 体积：使用 highlight.js/lib/core + 显式注册常用语言。
 * 直接 import 'highlight.js' 会把 190+ 种语言全打进包（实测 1.17MB），
 * 按需注册后包体降到原来的约 1/6。
 *
 * 流式容错：未闭合的 ``` 代码块会被 markdown-it 当作普通代码块渲染，不会抛错，
 * 所以逐字渲染不需要特殊处理，直接 renderMarkdown(已到达的文本) 即可。
 */

import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'

import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import nginx from 'highlight.js/lib/languages/nginx'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGS: Record<string, unknown> = {
  bash,
  shell: bash,
  sh: bash,
  zsh: bash,
  css,
  diff,
  dockerfile,
  go,
  ini,
  toml: ini,
  java,
  javascript,
  js: javascript,
  json,
  markdown,
  md: markdown,
  nginx,
  conf: nginx,
  plaintext,
  text: plaintext,
  python,
  py: python,
  rust,
  sql,
  typescript,
  ts: typescript,
  html: xml,
  xml,
  vue: xml,
  yaml,
  yml: yaml,
}

for (const [name, lang] of Object.entries(LANGS)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hljs.registerLanguage(name, lang as any)
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${out}</code></pre>`
      } catch {
        /* 落到下面的纯文本分支 */
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`
  },
})

/**
 * 表格外层包一层可横向滚动的容器（v2.1，移动端超宽表格修复）。
 *
 * 为什么必须在渲染层做：markdown 表格的**最小宽度 = 各列 min-content 之和**，
 * 列一多（10 列的行情表）就必然比手机屏幕宽。表格本身是块级盒子，它溢出时
 * 会一路把祖先的 scrollWidth 撑大（消息区是 scroll 容器，于是整块消息区能左右拖），
 * 后面的消息跟着一起横向滚动。给它套一个 `overflow-x: auto` 的 wrapper，
 * 溢出就被关在 wrapper 里 —— 「超宽内容自己处理自己的宽度」。
 *
 * 替代方案（在 MessageItem 里 decorate 后包 DOM）不做：v-html 每次重渲染都要重包一遍，
 * 流式期间每帧都跑，容易漏；渲染器规则是纯函数、一次性的事。
 */
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="table-wrapper thin-scroll">${self.renderToken(tokens, idx, options)}`

md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`

export function renderMarkdown(src: string): string {
  return md.render(src)
}
