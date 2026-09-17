<script setup lang="ts">
/**
 * 模型 + 窗口上限 + 本轮输入合计（`deepseek-flash │ 窗口 1m │ 本轮输入合计 112.3k`）。
 *
 * ⚠️ 2026-09-17 起这个组件**并入状态行**（用户要求"灯和模型信息合成一行"）：
 * 它不再自己占一行（原来灯一行、这条一行），根元素就是一个 flex 项，**自带前导分隔符**；
 * 没有任何数据时整段不渲染 —— 也就不会在状态行尾巴上留下一个孤零零的 `│`。
 *
 * ⚠️ 手机端（< lg = 1024px）两件事（2026-09-17 用户要求，**桌面一律不动**）：
 *  - 整行**字号缩小**到 10px（与状态词同步，见 `RunStatus.vue`）⇒ 尽量挤成一行；
 *  - **「窗口 1m」整段隐藏**（连同它**前面那个**分隔符一起藏 ⇒ 不会留下光杆 `│`）。
 *    它是三段里唯一"可以不要"的 —— 模型名和合计都跟本轮 token 直接挂钩，窗口上限是固定值。
 *    用 `max-lg:hidden`（Tailwind 3.2+ 的上界变体），**纯 CSS**：不改 vm、不影响 tooltip。
 *
 * 三个数字三个来源（缺哪个就少显示哪段，**绝不编数字**）：
 *  - 模型：会话行 `session.model`（counters() 顺手带回来，不额外请求）
 *  - 上限：dashboard 后端 `/api/model-info` → `effective_context_length`（nginx 转发）
 *  - 本轮输入合计：run 结束时那次的 `usage.input_tokens`
 *
 * ⚠️ 这一行**不显示"水位/百分比"**（v2.8 改；2026-09-15 查实的口径 bug）：
 * 服务端那个 `usage.input_tokens` 是 `agent.session_prompt_tokens` —— **该轮内每次 API
 * 调用的 prompt 累加**，不是"这次请求把多少上下文喂给了模型"。拿它除窗口会得到一个
 * 荒唐的假水位：一轮 30 次调用累出 2.6m ÷ 1m ⇒ 界面显示 100% 并转红，看着像"上下文爆了"，
 * 而那一轮**单次最大 prompt 只有 125k（≈12.5%）**。
 * Hermes 的 HTTP 接口**不提供"当前上下文占用"**（dashboard 状态栏走的是内部管道），
 * 所以这里只报有真实来源的累计值：不算百分比、不画进度条、不判红。
 *
 * 颜色一律灰一档：这行是辅助信息，不抢眼，也不制造告警。
 *
 * ⚠️ 本值只有跑完一轮才知道（Hermes 不落库）⇒ 刷新/切走后显示的是**浏览器缓存里那一份**
 * （`lib/context-cache.ts`）。2026-09-17 用户要求**不再显示「· 上次已知 HH:MM」**那半句
 * （留着的解释在 tooltip 里，鼠标悬停才看得到）。
 */
import { computed } from 'vue'
import { store } from '../stores/chat'
import { formatCompactTokens } from '../lib/format'

const vm = computed(() => {
  const { model, limit, turnInput, stale } = store.context
  const lim = typeof limit === 'number' && limit > 0 ? limit : 0

  return {
    // 什么都没有（既没模型也没分母也没本轮输入）→ 整段不渲染（含分隔符）
    show: Boolean(model) || lim > 0 || turnInput !== null,
    model: model ?? '',
    limitText: lim > 0 ? formatCompactTokens(lim) : '',
    hasTurnInput: turnInput !== null,
    turnInputText: turnInput === null ? '—' : formatCompactTokens(turnInput),
    title:
      turnInput === null
        ? '本轮输入合计：还没跑过带用量的轮次'
        : stale
          ? '本轮输入合计（刷新/切走后只能显示上次已知的那一份；跑完一轮会更新）'
          : '本轮输入合计 = 这一轮内每次 API 调用的输入之和（Hermes 的 HTTP 接口不提供"当前上下文占用"，所以不显示水位百分比）',
  }
})
</script>

<template>
  <div
    v-if="vm.show"
    data-testid="ctx-gauge"
    class="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] leading-4 text-gray-400 dark:text-gray-500 max-lg:text-[10px]"
    :title="vm.title"
  >
    <span class="opacity-50">│</span>
    <span v-if="vm.model" data-testid="ctx-model">{{ vm.model }}</span>
    <!-- 窗口段连同它**前面那个**分隔符一起在手机端隐藏（`max-lg:hidden`）⇒ 不会出现光杆 `│` -->
    <template v-if="vm.limitText">
      <span class="opacity-50 max-lg:hidden">│</span>
      <span data-testid="ctx-limit" class="max-lg:hidden">窗口 {{ vm.limitText }}</span>
    </template>
    <template v-if="vm.limitText || vm.hasTurnInput">
      <span class="opacity-50">│</span>
      <span data-testid="ctx-turn-input" class="tabular-nums">本轮输入合计 {{ vm.turnInputText }}</span>
    </template>
  </div>
</template>
