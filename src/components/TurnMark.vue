<script setup lang="ts">
/**
 * 轮首戳 —— 每一轮开头的「头像 + 状态灯」。
 *
 * 用户 2026-09-16 定：**每个助手轮开头都有头像**；跑完只把灯**换色**、不写状态词
 * （状态词由输入框上方那条统一说，避免同一件事两处说）。
 *
 * 为什么**固定占一行高**：跑着时这一行就已经在（只是黄点），跑完只换颜色 ⇒
 * **高度零变化**，不会触发 ChatWindow 那套贴底/锚定逻辑（坑 50 那一族）。
 * 反过来说，"跑完才插节点"是会抖的，别那样写。
 */
import { LIGHT_ICON, type Light } from '../lib/turnStatus'
import { avatar } from '../lib/appearance'

defineProps<{ light: Light }>()
</script>

<template>
  <div
    data-testid="turn-mark"
    class="flex items-center gap-1.5 text-xs leading-5 text-gray-400 dark:text-gray-500"
  >
    <span class="shrink-0 select-none" :title="`本轮状态：${light}`">{{ avatar }}</span>
    <span data-testid="turn-mark-light" :class="light === 'yellow' ? 'animate-pulse' : ''">
      {{ LIGHT_ICON[light] }}
    </span>
  </div>
</template>
