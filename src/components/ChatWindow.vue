<script setup lang="ts">
/**
 * 聊天区：消息列表 + 执行状态条 + 输入框。
 * 自动滚动策略：只有用户本来就在底部附近时才跟随，避免翻历史时被强行拽回。
 *
 * 历史分页：首屏只取最近 100 条（Hermes 的 messages 接口一次最多 500），
 * 更早的由"加载更早的消息"按钮按 offset 翻页（offset 从最新往回数，见 §5.9）。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { loadEarlier, loadSessions, openSession, store } from '../stores/chat'
import MessageItem from './MessageItem.vue'
import RunStatus from './RunStatus.vue'
import InputBox from './InputBox.vue'

const scroller = ref<HTMLElement | null>(null)
const inputRef = ref<InstanceType<typeof InputBox> | null>(null)
const stick = ref(true)

/**
 * 划到顶部这个距离内就自动加载更早的历史（滚轮/触摸都一样触发）。
 * 阈值不用 0：等真的贴到 0 才开始加载，用户会先看到一个空档再蹦出新内容。
 */
const AUTO_TOP_PX = 60

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

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  // 划到顶附近 → 自动翻页（earlier() 里会补偿 scrollTop，所以视口不会跳）
  if (el.scrollTop <= AUTO_TOP_PX) void earlier()
}

async function toBottom(): Promise<void> {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/**
 * 加载更早的消息：加载后把视口"钉"在原处。
 * 必须自己算，因为 prepend 会让 scrollHeight 一下变大 —— 不补偿就会出现
 * "点一下、内容跳到最上面/最下面"的错觉。同时临时关掉跟随底部（否则
 * tail 变化会触发 toBottom，把用户刚要看的历史顶走）。
 *
 * 重入由 loadEarlier() 自己兜底（historyLoading / hasMoreHistory / streaming），
 * 所以滚动事件狂发也不会重复请求；而且下面的 scrollTop 补偿会把位置推出
 * 触发阈值，天然形成"一次滚动只加载一页"。
 */
async function earlier(): Promise<void> {
  if (!store.hasMoreHistory || store.historyLoading || store.streaming) return
  const el = scroller.value
  const prevHeight = el?.scrollHeight ?? 0
  const prevTop = el?.scrollTop ?? 0
  stick.value = false
  await loadEarlier()
  await nextTick()
  if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
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
    <div
      ref="scroller"
      data-testid="scroller"
      class="thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto"
      @scroll.passive="onScroll"
    >
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
      <div v-else class="mx-auto min-w-0 max-w-chat px-4 py-6">
        <!-- 更早的历史：划到顶会自动加载，这个按钮是手动兜底 + 加载中提示 -->
        <!-- （内容不足一屏时不会产生滚动事件，自动加载永远等不到，只能点它） -->
        <div v-if="store.hasMoreHistory" class="mb-4 flex justify-center">
          <button
            type="button"
            class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 transition hover:bg-gray-50 hover:text-gray-700 disabled:opacity-60 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200"
            :disabled="store.historyLoading"
            @click="earlier()"
          >
            {{ store.historyLoading ? '加载中…' : '加载更早的消息' }}
          </button>
        </div>
        <div class="min-w-0 space-y-6">
          <MessageItem v-for="m in store.messages" :key="m.key" :msg="m" />
        </div>
      </div>
    </div>

    <!-- 执行状态条 + 输入框 -->
    <RunStatus />
    <InputBox ref="inputRef" />
  </section>
</template>
