<script setup lang="ts">
/**
 * 聊天区：消息列表 + 执行状态条 + 输入框。
 * 自动滚动策略：只有用户本来就在底部附近时才跟随，避免翻历史时被强行拽回。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { loadSessions, openSession, store } from '../stores/chat'
import MessageItem from './MessageItem.vue'
import RunStatus from './RunStatus.vue'
import InputBox from './InputBox.vue'

const scroller = ref<HTMLElement | null>(null)
const inputRef = ref<InstanceType<typeof InputBox> | null>(null)
const stick = ref(true)

const EXAMPLES = [
  '看看 510210 现在的盘面',
  '帮我查一下 hermes_stock 里最近的交易记录',
  '把这段 Python 代码改成异步的',
]

const tail = computed(() => {
  const n = store.messages.length
  if (!n) return 0
  return n * 10_000 + (store.messages[n - 1].content?.length ?? 0)
})

const truncated = computed(() => store.messages.length >= 100)

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

async function toBottom(): Promise<void> {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(tail, () => {
  if (stick.value) void toBottom()
})

watch(
  () => store.currentId,
  () => {
    stick.value = true
    void toBottom()
  },
)

onMounted(() => {
  void toBottom()
})

/** 出错后重试：有会话就重载当前会话，否则重拉列表 */
function retry(): void {
  store.bootError = null
  if (store.currentId) void openSession(store.currentId)
  else void loadSessions()
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 错误横幅：创建会话 / 拉列表失败时必须可见（否则点发送会"没反应"） -->
    <div v-if="store.bootError" class="mx-auto w-full max-w-chat px-4 pt-3">
      <div
        class="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
      >
        <span class="flex-1 break-words">{{ store.bootError }}</span>
        <button
          type="button"
          class="shrink-0 rounded px-2 py-0.5 text-xs transition hover:bg-red-100 dark:hover:bg-red-900/40"
          @click="retry()"
        >
          重试
        </button>
      </div>
    </div>

    <!-- 消息区 -->
    <div ref="scroller" class="thin-scroll min-h-0 flex-1 overflow-y-auto" @scroll="onScroll">
      <!-- 空态 -->
      <div
        v-if="!store.messages.length && !store.messagesLoading"
        class="mx-auto flex h-full max-w-chat flex-col items-center justify-center gap-4 px-6"
      >
        <div class="text-center">
          <div class="text-2xl font-semibold">有什么可以帮您？</div>
          <p class="mt-1 text-sm text-gray-400 dark:text-gray-500">
            {{ store.currentId ? '这个会话还没有消息' : '从一个新会话开始' }}
          </p>
        </div>
        <div v-if="!store.currentId" class="flex w-full flex-col gap-2">
          <button
            v-for="q in EXAMPLES"
            :key="q"
            type="button"
            class="rounded-xl border border-gray-200 px-3 py-2 text-left text-sm text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:bg-gray-900"
            @click="inputRef?.fill(q)"
          >
            {{ q }}
          </button>
        </div>
      </div>

      <!-- 加载态 -->
      <div v-else-if="store.messagesLoading" class="mx-auto max-w-chat space-y-3 px-4 py-6">
        <div
          v-for="i in 3"
          :key="i"
          class="h-4 animate-pulse rounded bg-gray-100 dark:bg-gray-800"
          :style="{ width: `${90 - i * 15}%` }"
        />
      </div>

      <!-- 消息 -->
      <div v-else class="mx-auto max-w-chat space-y-6 px-4 py-6">
        <p
          v-if="truncated"
          class="rounded-lg bg-gray-50 px-3 py-2 text-center text-xs text-gray-400 dark:bg-gray-900 dark:text-gray-500"
        >
          仅显示最近 100 条消息
        </p>
        <MessageItem v-for="m in store.messages" :key="m.key" :msg="m" />
      </div>
    </div>

    <!-- 执行状态条 + 输入框 -->
    <RunStatus />
    <InputBox ref="inputRef" />
  </section>
</template>
