<script setup lang="ts">
/**
 * 单条消息。
 *  - 用户消息：纯文本（pre-wrap），不解析 markdown（避免误解出代码高亮）
 *  - 助手消息：markdown 渲染 + 代码高亮 + 代码块复制按钮 + 流式光标
 *
 * 流式性能：内容变化用 requestAnimationFrame 节流后整段重渲染（不做增量 diff）。
 * 代码块复制按钮：渲染后注入 DOM（v-html 出来的节点拿不到 Vue 作用域，所以用原生事件）。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { UiMessage } from '../stores/chat'
import { renderMarkdown } from '../lib/markdown'
import { formatDurationMs, formatPercent, formatTokens } from '../lib/format'

const props = defineProps<{ msg: UiMessage }>()

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
  <div v-if="msg.role === 'user'" class="flex justify-end">
    <div
      class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-gray-100 px-4 py-2 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
    >{{ msg.content }}</div>
  </div>

  <!-- 助手消息：文本流，不用气泡 -->
  <div v-else class="group">
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
    <p
      v-if="msg.error"
      class="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
    >
      {{ msg.error }}
    </p>
  </div>
</template>
