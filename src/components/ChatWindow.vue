<script setup lang="ts">
/**
 * 聊天区：消息列表 + 执行状态条 + 输入框。
 * 自动滚动策略：只有用户本来就在底部附近时才跟随，避免翻历史时被强行拽回。
 *
 * 历史分页：首屏只取最近 100 条（Hermes 的 messages 接口一次最多 500），
 * 更早的由"加载更早的消息"按钮按 offset 翻页（offset 从最新往回数，见 §5.9）。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { clearBootError, loadEarlier, loadSessions, openSession, store } from '../stores/chat'
import { formatPercent, formatTokens } from '../lib/format'
import MessageItem from './MessageItem.vue'
import RunStatus from './RunStatus.vue'
import InputBox from './InputBox.vue'

// 构建时注入（vite.config.ts 的 define）：空态底部显示，方便真机一眼确认版本
const buildId = __BUILD_ID__

const scroller = ref<HTMLElement | null>(null)
const inputRef = ref<InstanceType<typeof InputBox> | null>(null)
const stick = ref(true)

/**
 * 会话累计那一行的文案（与每轮那行**同一算法**，只是不做差）：
 *   输入合计 = 累计未命中缓存 + 累计命中缓存
 *   缓存命中率 = 命中 / 输入合计
 * 返回 null = 没有累计（请求失败/新会话）→ 那行不显示，绝不编数字。
 */
const totals = computed(() => {
  const t = store.totals
  if (!t) return null
  const inputTotal = t.inputTokens + t.cacheReadTokens
  const rate = inputTotal > 0 ? t.cacheReadTokens / inputTotal : null
  return {
    input: formatTokens(inputTotal),
    cache: rate === null ? '—' : formatPercent(rate),
    output: formatTokens(t.outputTokens),
    tools: t.toolCalls,
  }
})

/**
 * 划到顶部这个距离内就自动加载更早的历史（滚轮/触摸都一样触发）。
 * 阈值不用 0：等真的贴到 0 才开始加载，用户会先看到一个空档再蹦出新内容。
 */
const AUTO_TOP_PX = 60

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
  clearBootError()
  if (store.currentId) void openSession(store.currentId)
  else void loadSessions()
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col">
    <!-- 错误横幅：创建会话 / 拉列表失败时必须可见（否则点发送会"没反应"） -->
    <div v-if="store.bootError" data-testid="boot-error" class="mx-auto w-full max-w-chat px-4 pt-3">
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
        <!-- 空态刻意不显示任何示例话术（自用：保持对话区干净）。
             曾有一组写死的示例按钮（510210 盘面 / hermes_stock 交易记录 / Python 改异步），已去掉。 -->
        <!-- 构建标识：手机上一个新加载的页面就能看到"这是哪一版"（踩过缓存旧版本的坑） -->
        <p class="text-xs text-gray-300 dark:text-gray-600">{{ buildId }}</p>
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

        <!--
          会话累计（v2.4）：逐轮明细只在刚跑完那一轮可见（那些数字是客户端用会话累计
          做差算出来的，Hermes 不落库 per-turn usage），所以切走/刷新后只能看累计。
          放在列表末尾：不占常驻空间，也不跟状态条打架。
        -->
        <p
          v-if="totals"
          data-testid="session-totals"
          class="mt-8 text-center text-[11px] leading-5 text-gray-400 dark:text-gray-500"
        >
          本会话累计 · 输入 {{ totals.input }}（缓存命中 {{ totals.cache }}）· 输出 {{ totals.output }} · 工具
          {{ totals.tools }} 次
        </p>
      </div>
    </div>

    <!-- 执行状态条 + 输入框 -->
    <RunStatus />
    <InputBox ref="inputRef" />
  </section>
</template>
