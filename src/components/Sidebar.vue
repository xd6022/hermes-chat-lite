<script setup lang="ts">
/**
 * 会话列表。
 * 桌面：常驻 240px（可由顶栏按钮折叠成 0）；移动端：抽屉（默认收起）。
 *
 * 搜索：**客户端过滤**。Hermes API 没有搜索端点
 * （实测 /api/sessions 只认 limit/offset/source/include_children，
 *  库里虽有 FTS5 索引但只给 CLI 用），所以只能对已取到的会话标题做关键字匹配。
 * 取数上限见 stores/chat.ts 的 loadSessions（服务端上限 200 条）。
 */
import { computed, ref } from 'vue'
import { newChat, openSession, store } from '../stores/chat'
import { displayTitle, formatClock, groupSessions } from '../lib/format'

defineProps<{ open: boolean; collapsed: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const query = ref('')

/** 关键字过滤：标题 / 预览 / 会话 id 都算命中（id 便于按 id 精确定位） */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return store.sessions
  return store.sessions.filter((s) =>
    `${displayTitle(s)} ${s.preview ?? ''} ${s.id}`.toLowerCase().includes(q),
  )
})

const groups = computed(() => groupSessions(filtered.value))

const searching = computed(() => query.value.trim().length > 0)
const noMatch = computed(() => searching.value && filtered.value.length === 0)

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
    class="fixed inset-0 z-20 bg-black/30 dark:bg-black/60 md:hidden"
    @click="emit('close')"
  />

  <aside
    class="fixed inset-y-0 left-0 z-30 flex w-60 shrink-0 flex-col border-r border-gray-200 bg-gray-50 transition-transform duration-200 dark:border-gray-800 dark:bg-gray-900 md:static md:z-auto md:translate-x-0"
    :class="[open ? 'translate-x-0' : '-translate-x-full', collapsed ? 'md:hidden' : '']"
  >
    <!-- 顶部：搜索 + 新建（图标化，不再是整行大按钮） -->
    <div class="flex items-center gap-1.5 p-2">
      <div class="relative min-w-0 flex-1">
        <svg
          viewBox="0 0 24 24"
          class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400 dark:text-gray-500"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" stroke-linecap="round" />
        </svg>
        <input
          v-model="query"
          type="search"
          placeholder="搜索会话…"
          class="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-7 pr-6 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-gray-600"
          @keydown.esc="query = ''"
        />
        <button
          v-if="searching"
          type="button"
          class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-200"
          aria-label="清空搜索"
          @click="query = ''"
        >
          <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <button
        type="button"
        class="shrink-0 rounded-lg border border-gray-200 p-1.5 text-gray-600 transition hover:bg-gray-200/60 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        title="新对话"
        aria-label="新对话"
        @click="startNew()"
      >
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 5v14M5 12h14" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <nav class="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <!-- 骨架 -->
      <div v-if="store.sessionsLoading && !store.sessions.length" class="space-y-2 px-1 py-2">
        <div v-for="i in 5" :key="i" class="h-4 animate-pulse rounded bg-gray-200/70 dark:bg-gray-800" />
      </div>

      <!-- 空态：一个会话都没有 -->
      <p v-else-if="!store.sessions.length" class="px-2 py-3 text-xs text-gray-400 dark:text-gray-500">
        还没有会话，直接在下方输入即可开始
      </p>

      <!-- 空态：搜不到 -->
      <p v-else-if="noMatch" class="px-2 py-3 text-xs text-gray-400 dark:text-gray-500">
        没有匹配「{{ query.trim() }}」的会话
      </p>

      <template v-else>
        <p v-if="searching" class="px-2 py-1 text-[11px] text-gray-400 dark:text-gray-500">
          找到 {{ filtered.length }} 个
        </p>
        <div v-for="g in groups" :key="g.bucket" class="mb-2">
          <div class="px-2 py-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">{{ g.label }}</div>
          <button
            v-for="s in g.items"
            :key="s.id"
            type="button"
            class="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition"
            :class="
              s.id === store.currentId
                ? 'bg-gray-200/80 text-gray-900 dark:bg-gray-700/70 dark:text-gray-100'
                : 'text-gray-600 hover:bg-gray-200/50 dark:text-gray-300 dark:hover:bg-gray-800'
            "
            @click="pick(s.id)"
          >
            <span class="min-w-0 flex-1 truncate" :title="displayTitle(s)">{{ displayTitle(s) }}</span>
            <span
              class="shrink-0 text-[11px] text-gray-400 opacity-0 transition group-hover:opacity-100 dark:text-gray-500"
            >
              {{ formatClock(s.last_active || s.started_at) }}
            </span>
          </button>
        </div>
      </template>
    </nav>
  </aside>
</template>
