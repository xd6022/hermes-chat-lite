<script setup lang="ts">
/**
 * 一段消息（v2.11 起，"一条消息"可能是**一轮里的一个段**）。
 *  - 用户消息：纯文本（pre-wrap），不解析 markdown（避免误解出代码高亮）
 *  - 助手**正文段**（`kind` 缺省）：markdown 渲染 + 代码高亮 + 代码块复制按钮 + 流式光标
 *  - 助手**工具行段**（`kind === 'tools'`）：**常驻小字行**（灰字 + 缩进），不折叠 ——
 *    它就是那一时刻发生的事，按时间排在两段正文之间（v2.11；此前折叠、且统一堆在正文上方）
 *  - 压缩摘要消息（msg.compaction）：折叠块（内部机制，不该占据正文位置）
 *  - 轮级页脚（每轮统计 /「已中断」/ 错误）：挂在**本轮的最后一个段**上，两种段共用同一份渲染
 *
 * 流式性能：内容变化用 requestAnimationFrame 节流后整段重渲染（不做增量 diff）。
 * 代码块复制按钮：渲染后注入 DOM（v-html 出来的节点拿不到 Vue 作用域，所以用原生事件）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ToolStep, UiMessage } from '../stores/chat'
import { renderMarkdown } from '../lib/markdown'
import { formatDurationMs, formatPercent, formatTokens } from '../lib/format'

const props = defineProps<{ msg: UiMessage }>()

/** 这一段是"工具行段"吗（那一时刻调用的工具，按时间排在两段正文之间） */
const isTools = computed(() => props.msg.kind === 'tools')

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
  if (isTools.value) return // 工具行段没有 markdown 正文
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    html.value = renderMarkdown(props.msg.content)
    void nextTick(decorate)
  })
}

watch(() => [props.msg.content, props.msg.streaming, props.msg.kind] as const, schedule, { immediate: true })

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

  <!--
    助手：**正文段 / 工具行段**（v2.11 按时间交错）。
    工具行不再统一堆到正文上方、也不再折叠 —— 它就是"那个时刻做了什么"，
    落在两段正文之间的真实位置上（用户 2026-09-15 定的口径：常驻小字行）。
    两种段共用下面同一份页脚（每轮统计 /「已中断」/ 错误），所以它天然长在轮尾。
  -->
  <div v-else class="group min-w-0 max-w-full">
    <ol
      v-if="isTools"
      data-testid="tools-list"
      class="space-y-0.5 border-l border-gray-200 pl-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
    >
      <li v-for="(s, i) in msg.tools ?? []" :key="i" class="flex items-baseline gap-1.5">
        <span class="w-3 shrink-0 text-center" :class="toolTone(s.status)">{{ toolMarker(s.status) }}</span>
        <span class="shrink-0 font-mono text-gray-600 dark:text-gray-300">{{ s.name }}</span>
        <span v-if="s.preview" class="truncate" :title="s.preview">"{{ s.preview }}"</span>
        <span v-if="s.ms !== null" class="shrink-0 tabular-nums text-gray-400 dark:text-gray-500">
          ({{ formatDurationMs(s.ms) }})
        </span>
      </li>
    </ol>

    <div v-else ref="bodyRef" class="md-body" v-html="html" />

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
