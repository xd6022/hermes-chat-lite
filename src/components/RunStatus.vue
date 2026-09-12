<script setup lang="ts">
/**
 * 执行可观测性（设计文档 5.6）—— 回答两个问题：
 *   "现在在干什么？"  → 状态条（阶段 + 计时 + 当前工具）
 *   "这轮到底结束了没？" → 显式完成态（只有收到 run.completed 才叫完成）
 *
 * 计时用 performance.now() 本地算，不用事件里的 ts（时钟/网络抖动会跳）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { respondApproval, store } from '../stores/chat'
import type { ApprovalChoice } from '../api/types'

const showTimeline = ref(false)
const tick = ref(0)
let timer: number | undefined
/** 审批回话进行中（防重复点击） */
const answering = ref(false)

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
  // 等审批时这一轮仍然"活着"（服务端卡在那儿等人回话），所以计时继续走
  ['thinking', 'tool', 'approval', 'writing'].includes(store.run.phase) || store.streaming,
)

const toolCount = computed(() => store.run.timeline.length)

/** 审批卡片：服务端给的可选项里有没有这一项 */
function has(c: ApprovalChoice): boolean {
  return !!store.run.approval?.choices.includes(c)
}

function choiceLabel(c: ApprovalChoice | null | undefined): string {
  return c === 'once'
    ? '批准一次'
    : c === 'session'
      ? '本会话都允许'
      : c === 'always'
        ? '永久允许'
        : c === 'deny'
          ? '拒绝'
          : ''
}

function answer(c: ApprovalChoice): void {
  if (answering.value) return
  answering.value = true
  void respondApproval(c).finally(() => {
    answering.value = false
  })
}

const label = computed(() => {
  const r = store.run
  switch (r.phase) {
    case 'thinking':
      return r.currentTool ? `正在使用 ${r.currentTool}…` : '正在思考…'
    case 'tool':
      return r.currentTool ? `正在使用 ${r.currentTool}…` : '正在执行工具…'
    case 'approval':
      return `等待你批准：${r.approval?.toolName ?? '危险操作'}`
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
    case 'approval':
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

    <!-- 安全闸门拦截说明：网页端没有审批通道，工具被拒时得说清"为什么"（否则只看到一个 ✗） -->
    <div
      v-if="store.run.blocked"
      class="mt-1 rounded-lg border border-amber-300/70 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300"
    >
      <p class="font-medium">⛔ 这次工具调用被安全闸门拦下了</p>
      <p class="mt-0.5 leading-5">{{ store.run.blocked.hint }}</p>
      <p class="mt-0.5 truncate font-mono text-[11px] opacity-70" :title="store.run.blocked.snippet">
        {{ store.run.blocked.snippet }}
      </p>
    </div>

    <!-- 轮末回读对账的提示（事件流断了才有）：告诉用户"这些内容是从会话里补回来的" -->
    <p v-if="store.run.recovered" class="mt-1 text-xs text-gray-400 dark:text-gray-500">
      事件流中断，本轮内容已从会话记录回读补齐（可能与实时渲染略有差异）
    </p>

    <!-- 审批卡片（A 方案新增能力）：服务端在等我们回话，这一轮**不会自己往下走** -->
    <div
      v-if="store.run.approval"
      class="mt-1 rounded-lg border border-sky-300/70 bg-sky-50 px-2.5 py-2 text-xs text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200"
    >
      <p class="font-medium">
        🔐 需要你批准：<span class="font-mono">{{ store.run.approval.toolName }}</span>
      </p>
      <pre
        v-if="store.run.approval.command"
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-black/5 p-1.5 font-mono text-[11px] leading-4 dark:bg-white/5"
        >{{ store.run.approval.command }}</pre
      >
      <p v-if="store.run.approval.smartDenied" class="mt-1 opacity-80">
        辅助模型判定这条命令有风险，所以拦下来等你确认。
      </p>

      <p v-if="store.run.approval.resolved" class="mt-1">
        已回话：{{ choiceLabel(store.run.approval.resolved) }}，等服务端继续…
      </p>
      <template v-else>
        <p class="mt-1 opacity-70">这一轮在等你回话，不点就不会继续。</p>
        <div class="mt-1.5 flex flex-wrap gap-1.5">
          <button
            v-if="has('once')"
            type="button"
            :disabled="answering"
            class="rounded border border-sky-400/70 bg-white px-2 py-0.5 font-medium transition hover:bg-sky-50 disabled:opacity-50 dark:border-sky-700 dark:bg-sky-900/40 dark:hover:bg-sky-900/70"
            @click="answer('once')"
          >
            批准一次
          </button>
          <button
            v-if="has('session')"
            type="button"
            :disabled="answering"
            class="rounded border border-sky-400/70 bg-white px-2 py-0.5 transition hover:bg-sky-50 disabled:opacity-50 dark:border-sky-700 dark:bg-sky-900/40 dark:hover:bg-sky-900/70"
            @click="answer('session')"
          >
            本会话都允许
          </button>
          <button
            v-if="has('always') && store.run.approval.allowPermanent"
            type="button"
            :disabled="answering"
            class="rounded border border-sky-400/70 bg-white px-2 py-0.5 transition hover:bg-sky-50 disabled:opacity-50 dark:border-sky-700 dark:bg-sky-900/40 dark:hover:bg-sky-900/70"
            @click="answer('always')"
          >
            永久允许
          </button>
          <button
            v-if="has('deny')"
            type="button"
            :disabled="answering"
            class="rounded border border-red-400/70 bg-white px-2 py-0.5 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-red-950/30 dark:hover:bg-red-950/60"
            @click="answer('deny')"
          >
            拒绝
          </button>
        </div>
      </template>

      <p v-if="store.run.approval.error" class="mt-1 text-red-600 dark:text-red-400">
        {{ store.run.approval.error }}
      </p>
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
