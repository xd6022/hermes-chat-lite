<script setup lang="ts">
/**
 * 执行可观测性（设计文档 5.6）—— 回答两个问题：
 *   "现在在干什么？"  → **状态行**（四态灯 + 中文状态词 + 计时）
 *   "这轮到底结束了没？" → 灯色（🟢 时刻准备着 / 🟡 忙碌中 / 🟠 等审批·已中断 / 🔴 失败）
 *
 * 2026-09-16 改版（用户拍板）：
 *  · 词汇表砍到**四态**，🟢 从"完成"变成"**时刻准备着**"（正文结束就回空闲）——
 *    于是这一行**常驻**（不再"空闲时隐藏"，也不再"停留 3 秒后收起"）；
 *  · 灯**不看工具**（"不记录工具，不记录是否在调用工具"）⇒ 状态词里没有工具名，也没有蓝色；
 *  · 判据全在 `lib/turnStatus.ts`（纯函数、逐条单测），这里只负责画。
 *
 * 计时用 performance.now() 本地算，不用事件里的 ts（时钟/网络抖动会跳）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { respondApproval, retryTurn, store } from '../stores/chat'
import { runStatus } from '../lib/turnStatus'
import ContextGauge from './ContextGauge.vue'
import type { ApprovalChoice } from '../api/types'

const tick = ref(0)
let timer: number | undefined
/** 审批回话进行中（防重复点击） */
const answering = ref(false)
/** 重试进行中（防重复点击） */
const retrying = ref(false)

onMounted(() => {
  timer = window.setInterval(() => {
    tick.value++ // 只为驱动秒表刷新
  }, 200)
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

const elapsed = computed(() => {
  void tick.value
  const { startedAt, endedAt } = store.run
  if (!startedAt) return 0
  const end = endedAt || performance.now()
  return Math.max(0, (end - startedAt) / 1000)
})

/** 四态灯 + 状态词（判据见 lib/turnStatus.ts；这一行**常驻**，空闲时是 🟢 时刻准备着） */
const status = computed(() => {
  void tick.value
  return runStatus({ phase: store.run.phase, seconds: elapsed.value, runId: store.run.runId })
})

/**
 * 文字色调跟灯走。
 * 时刻准备着**刻意最安静**（灰）—— 它是默认态，不该抢注意力。
 */
const tone = computed(() => {
  switch (status.value.light) {
    case 'red':
      return 'text-red-600 dark:text-red-400'
    case 'orange':
      return 'text-amber-600 dark:text-amber-400'
    case 'yellow':
      return 'text-gray-500 dark:text-gray-400'
    default:
      return 'text-gray-400 dark:text-gray-500'
  }
})

function onRetry(): void {
  if (retrying.value) return
  retrying.value = true
  void retryTurn().finally(() => {
    retrying.value = false
  })
}

/*
 * 工具调用**不在这里列**（v2.3 去掉时间线；2026-09-16 起连工具名也不再出现 —— 用户口径"不记工具"）：
 * 它内联渲染在对话流里（v2.11 起是常驻小字行，见 MessageItem 的工具行段），
 * 这里只负责"忙不忙 / 这轮结束了没"。
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
</script>

<template>
  <!-- data-phase 给自动化用（真浏览器用例要靠它断言"现在是哪种状态"），与 data-testid 同惯例。
       2026-09-16 起这一块**常驻**（空闲时显示 🟢 时刻准备着）⇒ 不再有 v-if 隐藏。 -->
  <div
    data-testid="run-status"
    :data-phase="store.run.phase"
    :data-light="status.light"
    class="mx-auto w-full max-w-chat px-4 pb-1"
  >
    <!-- 状态行：一眼一行 —— 灯 + 状态词 + **模型/窗口/本轮输入合计**（2026-09-17 并成一行；原来是两行）。
         进行中时灯本身做脉冲（"在动"是用户硬要求：静态黄灯跟"卡住了"长得一样）。
         手机端（`max-lg`，< 1024px）整行缩一号（状态词 12→11px，水位段再小到 10px，见 ContextGauge）
         且「窗口 1m」整段隐藏 —— 2026-09-17 用户要求，**桌面一律不动**。 -->
    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs max-lg:text-[11px]" :class="tone">
      <span
        data-testid="turn-light"
        class="shrink-0 select-none"
        :class="status.pulse ? 'animate-pulse' : ''"
      >{{ status.icon }}</span>
      <span class="min-w-0 truncate">{{ status.text }}</span>
      <!-- 模型 │ 窗口 │ 本轮输入合计：作为同一行的后半段（自带前导分隔符；没数据时自己整段不渲染） -->
      <ContextGauge />
      <button
        v-if="status.retry"
        type="button"
        data-testid="retry"
        :disabled="retrying"
        class="shrink-0 rounded border border-red-400/70 bg-white px-2 py-0.5 font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/60"
        @click="onRetry()"
      >
        重试
      </button>
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
