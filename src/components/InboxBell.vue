<script setup lang="ts">
/**
 * 顶栏的消息图标（v1，2026-09-22）—— 右侧、主题开关左边。
 *
 * 只做两件事：**显示未读数**、**点开抽屉**。
 * 不显示"有没有新消息"之外的任何状态（轮询成功与否由抽屉里那行小字说，图标不跟着变色 ——
 * 图标变色会让人以为"消息坏了"，实际只是刚才那次拉取没成功）。
 */
import { computed } from 'vue'
import { inbox } from '../stores/inbox'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'toggle'): void }>()

/** 徽标数字：>99 显示 99+（三位数会把图标撑变形） */
const badge = computed(() => (inbox.unread > 99 ? '99+' : String(inbox.unread)))

const label = computed(() => (inbox.unread > 0 ? `消息（${inbox.unread} 条未读）` : '消息'))
</script>

<template>
  <button
    type="button"
    data-testid="inbox-bell"
    class="relative rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
    :title="label"
    :aria-label="label"
    :aria-expanded="open"
    @click="emit('toggle')"
  >
    <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span
      v-if="inbox.unread > 0"
      data-testid="inbox-badge"
      class="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-red-500 px-1 text-center text-[10px] font-medium leading-4 text-white"
    >
      {{ badge }}
    </span>
  </button>
</template>
