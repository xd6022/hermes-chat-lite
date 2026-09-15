<script setup lang="ts">
/**
 * 单条消息。
 *  - 用户消息：纯文本（pre-wrap），不解析 markdown（避免误解出代码高亮）
 *  - 助手消息：markdown 渲染 + 代码高亮 + 代码块复制按钮 + 流式光标
 *  - 本轮的**工具调用**：挂在触发它的这条回复下面，默认折叠（v2.3；此前在输入框
 *    上方的状态条里，多轮之后看不出工具属于哪一轮）
 *  - 压缩摘要消息（msg.compaction）：折叠块（内部机制，不该占据正文位置）
 *
 * 流式性能：内容变化用 requestAnimationFrame 节流后整段重渲染（不做增量 diff）。
 * 代码块复制按钮：渲染后注入 DOM（v-html 出来的节点拿不到 Vue 作用域，所以用原生事件）。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ToolStep, UiMessage } from '../stores/chat'
import { renderMarkdown } from '../lib/markdown'
import { formatDurationMs, formatPercent, formatTokens } from '../lib/format'

const props = defineProps<{ msg: UiMessage }>()

/** 工具块的展开态：**默认展开**（用户要用它确认"会话确实在工作"；只有排查问题时才逐条看） */
const toolsOpen = ref(true)

function toolMarker(s: ToolStep['status']): string {
  return s === 'run' ? '●' : s === 'ok' ? '✓' : '✗'
}

function toolTone(s: ToolStep['status']): string {
  if (s === 'ok') return 'text-emerald-600 dark:text-emerald-500'
  if (s === 'fail') return 'text-red-600 dark:text-red-400'
  return 'text-gray-400 dark:text-gray-500'
}

const bodyRef = ref<HTMLElement | null>(null)
const html = ref('')
let rafId = 0

const INLINE_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'TD', 'TH', 'BLOCKQUOTE'])

function decorate() {
  const root = bodyRef.value
  if (!root) return

  // 复制按钮（只加一次）
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-code')) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'copy-code'
    btn.textContent = '复制'
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')
      const text = code ? code.textContent ?? '' : pre.textContent ?? ''
      navigator.clipboard?.writeText(text).then(
        () => {
          btn.textContent = '已复制'
          window.setTimeout(() => {
            btn.textContent = '复制'
          }, 1500)
        },
        () => {
          btn.textContent = '复制失败'
        },
      )
    })
    pre.appendChild(btn)
  })

  // 流式光标
  root.querySelectorAll('.caret').forEach((n) => n.remove())
  if (!props.msg.streaming) return
  const caret = document.createElement('span')
  caret.className = 'caret'
  const last = root.lastElementChild
  if (last && INLINE_TAGS.has(last.tagName)) last.appendChild(caret)
  else root.appendChild(caret)
}

function schedule(): void {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    html.value = renderMarkdown(props.msg.content)
    void nextTick(decorate)
  })
}

watch(() => [props.msg.content, props.msg.streaming] as const, schedule, { immediate: true })

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<template>
  <!-- 用户消息：右侧淡灰块，保留换行 -->
  <div v-if="msg.role === 'user'" class="flex min-w-0 justify-end">
    <div
      class="min-w-0 max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-gray-100 px-4 py-2 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
    >{{ msg.content }}</div>
  </div>

  <!-- 压缩摘要：Hermes 的上下文压缩边界，属于内部机制 —— 折叠起来，别占正文位置 -->
  <div
    v-else-if="msg.compaction"
    class="min-w-0 max-w-full rounded-xl border border-gray-200 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-900/40"
  >
    <details>
      <summary
        class="cursor-pointer select-none px-3 py-2 text-xs text-gray-400 dark:text-gray-500"
      >
        内部上下文摘要（Hermes 压缩边界，点开查看）
      </summary>
      <div
        class="thin-scroll md-body max-h-80 overflow-y-auto px-3 pb-3 text-[13px] text-gray-500 dark:text-gray-400"
        v-html="html"
      />
    </details>
  </div>

  <!-- 助手消息：文本流，不用气泡 -->
  <div v-else class="group min-w-0 max-w-full">
    <!--
      本轮的模型执行过程（工具调用）：**放在正文前面**。
      顺序依据：Hermes 落库本身就是「assistant(tool_calls) → tool 结果 → assistant(正文)」，
      所以"工具在前、正文在后"才是时间顺序的原样，与 dashboard/TUI 的读法一致。
      默认展开：用它确认"这一轮确实在工作"（例如 MCP 更新后是否被触发）；
      要逐条细看工具时才是排查场景。字体比正文浅一档（过程信息不抢注意力）、等宽便于扫读。

      注意：展开态是**每条消息各自的局部状态**（不是全局开关）。
    -->
    <div v-if="msg.tools?.length" class="mb-2 text-xs" data-testid="tools-block">
      <button
        type="button"
        class="flex cursor-pointer select-none items-center gap-1 text-gray-500 transition hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        :aria-expanded="toolsOpen"
        data-testid="tools-toggle"
        @click="toolsOpen = !toolsOpen"
      >
        <span class="w-3 shrink-0 text-center">{{ toolsOpen ? '▾' : '▸' }}</span>
        <span>工具调用 ({{ msg.tools.length }})</span>
      </button>

      <ol
        v-if="toolsOpen"
        class="mt-1 space-y-0.5 border-l border-gray-200 pl-3 text-gray-500 dark:border-gray-700 dark:text-gray-400"
        data-testid="tools-list"
      >
        <li v-for="(s, i) in msg.tools" :key="i" class="flex items-baseline gap-1.5">
          <span class="w-3 shrink-0 text-center" :class="toolTone(s.status)">{{ toolMarker(s.status) }}</span>
          <span class="shrink-0 font-mono text-gray-600 dark:text-gray-300">{{ s.name }}</span>
          <span v-if="s.preview" class="truncate" :title="s.preview">"{{ s.preview }}"</span>
          <span v-if="s.ms !== null" class="shrink-0 tabular-nums text-gray-400 dark:text-gray-500">
            ({{ formatDurationMs(s.ms) }})
          </span>
        </li>
      </ol>
    </div>

    <div ref="bodyRef" class="md-body" v-html="html" />

    <!-- 每轮统计：耗时 / 输入 / 输出 / 缓存命中率 -->
    <p
      v-if="msg.stats"
      class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-5 text-gray-400 dark:text-gray-500"
    >
      <span title="本轮墙钟耗时">⏱ {{ formatDurationMs(msg.stats.ms) }}</span>
      <span>· 输入 {{ formatTokens(msg.stats.inputTokens) }}</span>
      <span v-if="msg.stats.cacheRate !== null" title="命中缓存的输入 token 数（不重复计费的部分）">
        · 缓存 {{ formatTokens(msg.stats.cacheRead) }} ({{ formatPercent(msg.stats.cacheRate) }})
      </span>
      <span>· 输出 {{ formatTokens(msg.stats.outputTokens) }}</span>
    </p>
    <!-- 被打断的那一轮：贴「已中断」（对齐 dashboard 的 `· interrupted`），已输出的正文保留 -->
    <p
      v-if="msg.interrupted"
      data-testid="msg-interrupted"
      class="mt-2 text-[11px] leading-5 text-amber-600 dark:text-amber-400"
      title="这一轮被您打断（或服务端取消），已输出的内容保留"
    >
      · 已中断
    </p>
    <p
      v-if="msg.error"
      class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
    >
      {{ msg.error }}
    </p>
  </div>
</template>
