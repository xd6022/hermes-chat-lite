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
  // background（v2.2）：本地连接断了但服务端还在跑 —— 也是"活着"，计时继续走
  ['thinking', 'tool', 'approval', 'writing', 'background'].includes(store.run.phase) ||
  store.streaming,
)

/*
 * 工具调用**不再在这里列**（v2.3）：内联渲染在它所属的那条回复下面（见 MessageItem
 * 的"工具调用"折叠块）。这里只负责"现在在干什么 / 这一轮结束了没"。
 * 两处都列 = 同一条信息两副面孔，而且多轮之后看不出工具属于哪一轮。
 */

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
    case 'background':
      // v2.2：连接断了，但**服务端那一轮还在跑**（手机切后台的常态）。
      // 措辞要明确"任务没失败、也没丢"，否则用户会以为白跑了。
      return r.syncing
        ? '已重新连接，正在同步最新消息…'
        : '连接已暂时中断，任务仍在后台执行（回到页面会自动同步）'
    case 'done':
      // 完成后的数字（耗时/token/缓存）在消息下方常驻显示，这里不重复
      return '完成'
    case 'aborted':
      // 不暴露内部事件名（用户 2026-09-15 要求）；措辞与消息上的「已中断」标记一致
      return '已中断这一轮'
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
    case 'background':
      // 蓝色=进行中（不是错误也不是中断）：任务还在后台跑
      return 'text-sky-700 dark:text-sky-400'
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
  <!-- data-phase 给自动化用（真浏览器用例要靠它断言"现在是哪种状态"），与 data-testid 同惯例 -->
  <div
    v-if="store.run.phase !== 'idle'"
    data-testid="run-status"
    :data-phase="store.run.phase"
    class="mx-auto w-full max-w-chat px-4 pb-1"
  >
    <div class="flex items-center gap-2 text-xs" :class="tone">
      <span v-if="active" class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
      <span class="truncate" :title="store.run.toolPreview ?? ''">{{ label }}</span>
      <span v-if="active" class="tabular-nums text-gray-400 dark:text-gray-500">{{ secs }}</span>
    </div>

    <!-- 安全闸门拦截说明：工具被拒时得说清"为什么"（否则只看到一个 ✗）。审批类文案按当前通道分，见 lib/security.ts -->
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
    <!-- background 阶段不显示：那时还没同步完，等真正对齐了再说"已同步"（v2.2） -->
    <p
      v-if="store.run.recovered && store.run.phase !== 'background'"
      class="mt-1 text-xs text-gray-400 dark:text-gray-500"
    >
      本轮内容已从服务端会话记录同步回来（页面曾进入后台或连接中断，可能与实时渲染略有差异）
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
  </div>
</template>
