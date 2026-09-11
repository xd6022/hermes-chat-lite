<script setup lang="ts">
/**
 * 会话列表。
 * 桌面：常驻 240px（可由顶栏按钮折叠成 0）；移动端：抽屉（默认收起）。
 *
 * 搜索：**客户端过滤**。Hermes API 没有搜索端点
 * （实测 /api/sessions 只认 limit/offset/source/include_children，
 *  库里虽有 FTS5 索引但只给 CLI 用），所以只能对已取到的会话标题做关键字匹配。
 * 取数上限见 stores/chat.ts 的 loadSessions（服务端上限 200 条）。
 *
 * 行内操作（v1.5 加）：
 *  - **重命名**：原位变输入框（不用原生 prompt —— 原生动弹框与本应用风格不搭）
 *  - **删除**：原位二次确认，且确认文案**带上标题**（删前必须能看清删的是谁）
 * 这两条都受"硬删除不可恢复 + 曾经误删过真实会话"的约束，所以：
 *  ① 只有单个删除，没有任何批量/按条件删除的入口；
 *  ② 正在跑的那一轮所属会话禁止改名/删除（服务端 turn 还在写它）。
 */
import { computed, nextTick, ref } from 'vue'
import { newChat, openSession, removeSession, renameSession, store, TITLE_MAX } from '../stores/chat'
import { displayTitle, formatClock, groupSessions } from '../lib/format'
import type { HermesSession } from '../api/types'

defineProps<{ open: boolean; collapsed: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const query = ref('')

/* ---- 行内编辑 / 删除确认状态（同时只会有一个） ---- */
const editingId = ref<string | null>(null)
const editText = ref('')
const editError = ref('')
const confirmingId = ref<string | null>(null)
const deleteError = ref('')
const busyId = ref<string | null>(null)

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

/** 正在流式输出的会话不许动：服务端那一轮还在写它 */
function locked(s: HermesSession): boolean {
  return store.streaming && store.currentId === s.id
}

async function pick(id: string): Promise<void> {
  if (id !== store.currentId) await openSession(id)
  emit('close')
}

async function startNew(): Promise<void> {
  await newChat()
  emit('close')
}

function startRename(s: HermesSession): void {
  confirmingId.value = null
  editingId.value = s.id
  editText.value = s.title ?? ''
  editError.value = ''
  void nextTick(() => {
    // v-for 里的 template ref 会变成数组，所以按数据属性查更省心
    const el = document.querySelector<HTMLInputElement>(`[data-edit-id="${s.id}"]`)
    el?.focus()
    el?.select()
  })
}

function cancelRename(): void {
  editingId.value = null
  editError.value = ''
}

async function saveRename(id: string): Promise<void> {
  if (busyId.value) return
  busyId.value = id
  const err = await renameSession(id, editText.value)
  busyId.value = null
  if (err) {
    editError.value = err // 保持编辑态，让用户就地改
    return
  }
  editingId.value = null
  editError.value = ''
}

function startDelete(id: string): void {
  editingId.value = null
  confirmingId.value = id
  deleteError.value = ''
}

function cancelDelete(): void {
  confirmingId.value = null
  deleteError.value = ''
}

async function doDelete(id: string): Promise<void> {
  if (busyId.value) return
  busyId.value = id
  const err = await removeSession(id)
  busyId.value = null
  if (err) {
    deleteError.value = err
    return
  }
  confirmingId.value = null
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

          <div
            v-for="s in g.items"
            :key="s.id"
            class="group flex items-center gap-1 rounded-lg"
            :class="s.id === store.currentId ? 'bg-gray-200/80 dark:bg-gray-700/70' : ''"
          >
            <!-- ① 重命名态：原位输入框 -->
            <div v-if="editingId === s.id" class="flex min-w-0 flex-1 flex-col px-2 py-1">
              <div class="flex items-center gap-1">
                <input
                  v-model="editText"
                  :data-edit-id="s.id"
                  :maxlength="TITLE_MAX"
                  :disabled="busyId === s.id"
                  class="min-w-0 flex-1 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-sm text-gray-900 outline-none focus:border-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  @keydown.enter.prevent="saveRename(s.id)"
                  @keydown.esc.prevent="cancelRename()"
                />
                <button
                  type="button"
                  class="shrink-0 rounded p-1 text-green-600 transition hover:bg-gray-200/70 dark:hover:bg-gray-700"
                  title="保存"
                  aria-label="保存标题"
                  :disabled="busyId === s.id"
                  @click="saveRename(s.id)"
                >
                  <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded p-1 text-gray-400 transition hover:bg-gray-200/70 dark:hover:bg-gray-700"
                  title="取消"
                  aria-label="取消重命名"
                  @click="cancelRename()"
                >
                  <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
              <p v-if="editError" class="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{{ editError }}</p>
            </div>

            <!-- ② 删除确认态：**带上标题**，删前看清删的是谁 -->
            <div v-else-if="confirmingId === s.id" class="flex min-w-0 flex-1 flex-col px-2 py-1">
              <div class="flex items-center gap-1">
                <span class="min-w-0 flex-1 truncate text-xs text-gray-700 dark:text-gray-200">
                  删除「{{ displayTitle(s) }}」？
                </span>
                <button
                  type="button"
                  class="shrink-0 rounded bg-red-600 px-1.5 py-0.5 text-xs text-white transition hover:bg-red-500 disabled:opacity-60"
                  :disabled="busyId === s.id"
                  @click="doDelete(s.id)"
                >
                  {{ busyId === s.id ? '删除中' : '删除' }}
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-500 transition hover:bg-gray-200/70 dark:text-gray-400 dark:hover:bg-gray-700"
                  @click="cancelDelete()"
                >
                  取消
                </button>
              </div>
              <p class="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">不可恢复（含全部消息）</p>
              <p v-if="deleteError" class="mt-0.5 text-[11px] text-red-600 dark:text-red-400">{{ deleteError }}</p>
            </div>

            <!-- ③ 正常态：标题 + 行内操作 -->
            <template v-else>
              <button
                type="button"
                class="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm transition"
                :class="
                  s.id === store.currentId
                    ? 'text-gray-900 dark:text-gray-100'
                    : 'text-gray-600 hover:bg-gray-200/50 dark:text-gray-300 dark:hover:bg-gray-800'
                "
                :title="`${displayTitle(s)} · ${formatClock(s.last_active || s.started_at)}`"
                @click="pick(s.id)"
              >
                {{ displayTitle(s) }}
              </button>

              <!--
                移动端常显（触屏没有 hover，关键操作必须直接可见）；
                桌面端默认 invisible（既看不见也点不到），hover 该行才出现。
              -->
              <span
                class="flex shrink-0 items-center gap-0.5 pr-1 visible md:invisible md:group-hover:visible"
              >
                <button
                  type="button"
                  class="rounded p-1 text-gray-400 transition hover:bg-gray-200/70 hover:text-gray-700 disabled:opacity-30 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                  title="重命名"
                  aria-label="重命名"
                  :disabled="locked(s)"
                  @click="startRename(s)"
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 20h4L19 9l-4-4L4 16v4z" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="rounded p-1 text-gray-400 transition hover:bg-red-100 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-950/50 dark:hover:text-red-400"
                  title="删除"
                  aria-label="删除"
                  :disabled="locked(s)"
                  @click="startDelete(s.id)"
                >
                  <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M5 7h14M10 7V5h4v2M6 7l1 12h10l1-12" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </span>
            </template>
          </div>
        </div>
      </template>
    </nav>
  </aside>
</template>
