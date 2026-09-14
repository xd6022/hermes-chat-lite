<script setup lang="ts">
/**
 * 输入框上方一行：模型 + 上下文水位（照 dashboard 状态栏的读法）
 *
 *   deepseek-flash │ 407.7k/1m │ [████░░░░░░] 41%
 *
 * 三个数字三个来源（缺哪个就少显示哪段，**绝不编数字**）：
 *  - 模型：会话行 `session.model`（counters() 顺手带回来，不额外请求）
 *  - 上限：dashboard 后端 `/api/model-info` → `effective_context_length`（nginx 转发）
 *  - 占用：本轮最后一次调用的 `usage.input_tokens`（= dashboard 的 last_prompt_tokens）
 *
 * ⚠️ 占用只有跑完一轮才知道（Hermes 不落库）→ 刷新/切走后若来自本地缓存，标"上次已知"。
 * 水位 ≥80% 转黄、≥95% 转红：一眼看出"快满了，该开新会话了"。
 */
import { computed } from 'vue'
import { store } from '../stores/chat'
import { formatClock, formatCompactTokens } from '../lib/format'

/** 进度条格数（dashboard 那行是 10 格） */
const CELLS = 10

const vm = computed(() => {
  const { model, limit, used, stale, at } = store.context
  const lim = typeof limit === 'number' && limit > 0 ? limit : 0
  const pct = lim > 0 && used !== null ? Math.min(100, Math.round((used / lim) * 100)) : null
  const filled = pct === null ? 0 : Math.min(CELLS, Math.round((pct / 100) * CELLS))

  return {
    // 什么都没有（既没模型也没分母也没占用）→ 整行不渲染，不占位
    show: Boolean(model) || lim > 0 || used !== null,
    model: model ?? '',
    usedText: used === null ? '—' : formatCompactTokens(used),
    limitText: lim > 0 ? formatCompactTokens(lim) : '',
    pct,
    bar: pct === null ? '' : '█'.repeat(filled) + '░'.repeat(CELLS - filled),
    // 本地缓存恢复的值：说清"不是刚刚那一刻的数字"，并带上记录时间
    staleNote: stale && at > 0 ? `上次已知 ${formatClock(at / 1000)}` : stale ? '上次已知' : '',
    tone: pct === null || pct < 80 ? 'dim' : pct >= 95 ? 'danger' : 'warn',
    title:
      lim > 0
        ? stale
          ? '上下文水位（刷新/切走后只能显示上次已知的值；跑完一轮会更新）'
          : '上下文水位（本轮最后一次调用实际喂给模型的 token 数）'
        : '上下文窗口上限拿不到（dashboard 后端 /api/model-info 没通）',
  }
})

const TONE: Record<string, string> = {
  dim: 'text-gray-400 dark:text-gray-500',
  warn: 'text-amber-600 dark:text-amber-500',
  danger: 'text-red-600 dark:text-red-400',
}
</script>

<template>
  <div v-if="vm.show" class="mx-auto w-full max-w-chat px-4 pb-1">
    <div
      data-testid="ctx-gauge"
      class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[11px] leading-5"
      :class="TONE[vm.tone]"
      :title="vm.title"
    >
      <span v-if="vm.model" data-testid="ctx-model">{{ vm.model }}</span>
      <template v-if="vm.limitText">
        <span class="opacity-50">│</span>
        <span data-testid="ctx-usage" class="tabular-nums">{{ vm.usedText }}/{{ vm.limitText }}</span>
      </template>
      <template v-if="vm.bar">
        <span class="opacity-50">│</span>
        <span data-testid="ctx-bar" class="tabular-nums">[{{ vm.bar }}] {{ vm.pct }}%</span>
      </template>
      <span v-if="vm.staleNote" data-testid="ctx-stale" class="text-gray-400 dark:text-gray-500">
        · {{ vm.staleNote }}
      </span>
    </div>
  </div>
</template>
