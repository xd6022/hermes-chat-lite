<script setup lang="ts">
/**
 * 顶栏的**邮件图标**（v3.3，2026-09-28）—— 消息铃铛**左侧**，与消息中心完全独立。
 *
 * 为什么单独一个图标（而不是消息抽屉里的一个 tab）：邮件的刷新链路和消息完全不同
 * （邮件=读缓存/手动刷新，消息=按档位轮询），塞在一个抽屉里会互相拖累、还容易让人以为"两边都要刷"。
 *
 * 只做两件事：**点开抽屉**、告诉用户"这是邮件"。**不带未读徽标** ——
 * 邮件未读不计入任何计数（用户 2026-09-28 口径：徽标只数通知；邮件只在抽屉头部显示"上次拉取"）。
 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <button
    type="button"
    data-testid="email-bell"
    class="relative rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
    title="邮件（读缓存，点刷新才连邮箱）"
    aria-label="邮件"
    :aria-expanded="open"
    @click="emit('toggle')"
  >
    <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M3.5 6.5L12 13l8.5-6.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</template>
