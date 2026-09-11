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
