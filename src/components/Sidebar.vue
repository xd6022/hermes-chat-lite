<script setup lang="ts">
/**
 * 会话列表。
 * 桌面：常驻 240px；移动端：抽屉（默认收起，由汉堡按钮打开）。
 */
import { computed } from 'vue'
import { newChat, openSession, store } from '../stores/chat'
import { displayTitle, formatClock, groupSessions } from '../lib/format'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const groups = computed(() => groupSessions(store.sessions))

async function pick(id: string): Promise<void> {
  if (id !== store.currentId) await openSession(id)
  emit('close')
}

async function startNew(): Promise<void> {
  await newChat()
  emit('close')
}
</script>

<template>
  <!-- 移动端遮罩 -->
  <div
    v-if="open"
    class="fixed inset-0 z-20 bg-black/30 md:hidden"
    @click="emit('close')"
  />

  <aside
    class="fixed inset-y-0 left-0 z-30 flex w-60 shrink-0 flex-col border-r border-gray-200 bg-gray-50 transition-transform duration-200 md:static md:z-auto md:translate-x-0"
    :class="open ? 'translate-x-0' : '-translate-x-full'"
  >
    <div class="p-2">
      <button
        type="button"
        class="w-full rounded-xl bg-gray-900 px-3 py-2 text-sm text-white transition hover:bg-gray-700"
        @click="startNew()"
      >
        + 新对话
      </button>
    </div>

    <nav class="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <!-- 骨架 -->
      <div v-if="store.sessionsLoading && !store.sessions.length" class="space-y-2 px-1 py-2">
        <div v-for="i in 5" :key="i" class="h-4 animate-pulse rounded bg-gray-200/70" />
      </div>

      <!-- 空态 -->
      <p v-else-if="!store.sessions.length" class="px-2 py-3 text-xs text-gray-400">
        还没有会话，开始新的对话吧
      </p>

      <template v-else>
        <div v-for="g in groups" :key="g.bucket" class="mb-2">
          <div class="px-2 py-1 text-[11px] font-medium text-gray-400">{{ g.label }}</div>
          <button
            v-for="s in g.items"
            :key="s.id"
            type="button"
            class="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition"
            :class="s.id === store.currentId ? 'bg-gray-200/80 text-gray-900' : 'text-gray-600 hover:bg-gray-200/50'"
            @click="pick(s.id)"
          >
            <span class="min-w-0 flex-1 truncate" :title="displayTitle(s)">{{ displayTitle(s) }}</span>
            <span class="shrink-0 text-[11px] text-gray-400 opacity-0 transition group-hover:opacity-100">
              {{ formatClock(s.last_active || s.started_at) }}
            </span>
          </button>
        </div>
      </template>
    </nav>
  </aside>
</template>
