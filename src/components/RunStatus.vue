<script setup lang="ts">
/**
 * 执行可观测性（设计文档 5.6）—— 回答两个问题：
 *   "现在在干什么？"  → 状态条（阶段 + 计时 + 当前工具）
 *   "这轮到底结束了没？" → 显式完成态（只有收到 run.completed 才叫完成）
 *
 * 计时用 performance.now() 本地算，不用事件里的 ts（时钟/网络抖动会跳）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { store } from '../stores/chat'

const showTimeline = ref(false)
const tick = ref(0)
let timer: number | undefined

onMounted(() => {
  timer = window.setInterval(() => {
    tick.value++
  }, 200)
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

const elapsed = computed(() => {
  void tick.value // 只为驱动刷新
  const { startedAt, endedAt } = store.run
  if (!startedAt) return 0
  const end = endedAt || performance.now()
  return Math.max(0, (end - startedAt) / 1000)
})

const secs = computed(() => `${elapsed.value.toFixed(1)}s`)

const active = computed(() =>
  ['thinking', 'tool', 'writing'].includes(store.run.phase) || store.streaming,
)

const toolCount = computed(() => store.run.timeline.length)

const label = computed(() => {
  const r = store.run
  switch (r.phase) {
    case 'thinking':
      return r.currentTool ? `正在使用 ${r.currentTool}…` : '正在思考…'
    case 'tool':
      return r.currentTool ? `正在使用 ${r.currentTool}…` : '正在执行工具…'
    case 'writing':
      return '正在输出…'
    case 'done':
      // 完成后的数字（耗时/token/缓存）在消息下方常驻显示，这里不重复
      return '完成'
    case 'aborted':
      return '回复中断（未收到 run.completed）'
    case 'error':
      return `出错：${r.errorMessage ?? '未知错误'}`
    default:
      return ''
  }
})

const tone = computed(() => {
  switch (store.run.phase) {
    case 'done':
      return 'text-gray-500 dark:text-gray-400'
    case 'aborted':
      return 'text-amber-600 dark:text-amber-400'
    case 'error':
      return 'text-red-600 dark:text-red-400'
    default:
      return 'text-gray-500 dark:text-gray-400'
  }
})
</script>

<template>
  <div v-if="store.run.phase !== 'idle'" class="mx-auto w-full max-w-chat px-4 pb-1">
    <div class="flex items-center gap-2 text-xs" :class="tone">
      <span v-if="active" class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
      <span class="truncate" :title="store.run.toolPreview ?? ''">{{ label }}</span>
      <span v-if="active" class="tabular-nums text-gray-400 dark:text-gray-500">{{ secs }}</span>

      <button
        v-if="toolCount > 0"
        type="button"
        class="ml-auto shrink-0 rounded px-1.5 py-0.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        @click="showTimeline = !showTimeline"
      >
        {{ showTimeline ? '收起' : `工具 ${toolCount}` }}
      </button>
    </div>

    <!-- 工具时间线：本轮到底干了什么（Open WebUI 缺的就是这块） -->
    <ol
      v-if="showTimeline && toolCount > 0"
      class="mt-1 space-y-0.5 border-l border-gray-200 pl-3 dark:border-gray-700"
    >
      <li
        v-for="(s, i) in store.run.timeline"
        :key="i"
        class="flex items-baseline gap-1.5 text-xs text-gray-500 dark:text-gray-400"
      >
        <span class="w-3 shrink-0 text-center">
          {{ s.status === 'run' ? '·' : s.status === 'ok' ? '✓' : '✗' }}
        </span>
        <span class="shrink-0 font-mono text-gray-600 dark:text-gray-300">{{ s.name }}</span>
        <span class="truncate" :title="s.preview">{{ s.preview }}</span>
      </li>
    </ol>
  </div>
</template>
