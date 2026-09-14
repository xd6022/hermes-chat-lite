/**
 * 消息层面的纯函数（不依赖 store，方便单测）。
 */

/**
 * Hermes 的上下文压缩摘要 —— 它不是对话内容，是"压缩边界"留下的内部机制消息。
 *
 * 判据**照抄 Hermes 自己的实现**（不要自创正则）：
 *  - `gateway/platforms/api_server.py:439 _is_compressed_summary_message()`
 *      prefix.startswith("[CONTEXT COMPACTION") || prefix.startswith("[CONTEXT SUMMARY]:")
 *  - `agent/context_compressor.py:376-382`（同为压缩机制内部判据）
 *      取 content 前 280 字符，命中 "CONTEXT COMPACTION" / "[CONTEXT COMPACTION]" / "Conversation Summary"
 *
 * 实测坑：这类消息**不一定以标记开头**。本会话里那条压缩消息的真实开头是
 *   `[PRIOR CONTEXT — for reference only; not a new message]\n\n\n[END OF PRIOR CONTEXT …]`
 * 后面才出现 `[CONTEXT COMPACTION — REFERENCE ONLY]`。
 * 所以只用 `startsWith("[CONTEXT COMPACTION")` 会漏判 —— 必须用 Hermes 压缩器那套
 * "前 280 字符里出现" 的判据。
 *
 * 另外：API 的 message 对象**不返回** metadata（只有 id/role/content/timestamp 等），
 * 所以 Hermes 判据里那条"按 metadata key 判定"的分支在前端用不上。
 */
export const COMPACTION_HEAD_CHARS = 280

const COMPACTION_MARKERS = ['CONTEXT COMPACTION', '[CONTEXT SUMMARY]:', 'Conversation Summary']

export function isCompactionNote(content: string): boolean {
  const head = content.slice(0, COMPACTION_HEAD_CHARS)
  return COMPACTION_MARKERS.some((m) => head.includes(m))
}

/* ---------------- 工具调用（内联渲染用） ---------------- */

/**
 * 参数里最值得先看的那几个键（按"一眼看出干了什么"排序）。
 * 命令行/URL/路径/查询串是绝大多数工具的主参数。
 */
const PREFERRED_ARG_KEYS = [
  'command',
  'cmd',
  'url',
  'path',
  'file_path',
  'query',
  'pattern',
  'name',
  'prompt',
  'text',
  'code',
  'script',
]

/**
 * 工具参数 → 一行预览。
 *
 * 实测：历史里 `tool_calls[].function.arguments` 是 **JSON 字符串**，terminal 的
 * command 常有几百字符。这里的目标是"一眼看出这次干了什么"，不是把参数铺开 ——
 * 完整参数点开那一行再看。解析不出就退回原文截断：宁可显示得丑一点，也不要空。
 */
export function argPreview(raw: unknown, max = 72): string {
  const src = typeof raw === 'string' ? raw.trim() : ''
  let v = src
  if (src.startsWith('{')) {
    try {
      const obj = JSON.parse(src) as Record<string, unknown>
      const hit = PREFERRED_ARG_KEYS.map((k) => obj[k]).find((x) => typeof x === 'string')
      if (typeof hit === 'string') v = hit
      else {
        const first = Object.values(obj).find((x) => typeof x === 'string')
        if (typeof first === 'string') v = first
      }
    } catch {
      /* 不是合法 JSON → 用原文 */
    }
  }
  v = v.replace(/\s+/g, ' ').trim()
  return v.length > max ? `${v.slice(0, max)}…` : v
}

/**
 * 历史 tool 行算不算失败？——**只能靠启发式**：API 不返回成败字段（实测字段只有
 * content / tool_name / tool_call_id / timestamp 等）。
 *
 * 判据锚在结果**开头**，不是"全文出现 error"：
 *  - 工具失败时 Hermes 落库的是错误对象或异常文本，实测（6 个会话、1004 条 tool 行）
 *    失败形状是 `{"error": …}` / `{"detail": …}`，占 0.9%；
 *  - 正常输出里出现 "error" 字样（日志、grep 结果）很常见，只有出现在首键位置才算。
 */
export function toolFailed(content: unknown): boolean {
  const head = String(content ?? '').trimStart().slice(0, 120)
  if (/^(Error|Traceback|Exception|BLOCKED)\b/.test(head)) return true
  return /^\{\s*"(error|detail)"\s*:/.test(head)
}

