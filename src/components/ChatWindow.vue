<script setup lang="ts">
/**
 * 聊天区：消息列表 + 执行状态条 + 输入框。
 *
 * 自动滚动策略（v2.6 重做，坑 50）：
 *  ① **用户在底部附近** 才跟随（`stick`）—— 翻历史时绝不把用户拽回底部；
 *  ② 内容长高就重贴底：`ResizeObserver` 盯住消息列表与可视区，因为 DOM 是**分波**进
 *     的（工具行几十个节点排在正文之后），只靠 `watch(tail)` 会在"内容只渲染了一部分"
 *     时锚定，之后长出来的部分没人跟 → 落点停在半路（实测 21%~50%）；
 *  ③ 打开会话给一个**锚定窗口**：连贴到"高度连续两帧不变"为止（`followUntilSettled`），
 *     再交回 ① 的规则。设计口径：打开历史会话**永远落到底部（最新消息）**。
 *
 * 历史分页：首屏只取最近 100 条（Hermes 的 messages 接口一次最多 500），
 * 更早的由"加载更早的消息"按钮按 offset 翻页（offset 从最新往回数，见 §5.9）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { clearBootError, loadEarlier, loadModelInfo, loadSessions, openSession, store } from '../stores/chat'
import { followUntilSettled } from '../lib/scroll-anchor'
import { groupIntoTurns } from '../lib/turns'
import MessageItem from './MessageItem.vue'
import TurnAvatar from './TurnAvatar.vue'
import RunStatus from './RunStatus.vue'
import InputBox from './InputBox.vue'

const scroller = ref<HTMLElement | null>(null)
/** 消息区整块内容（含"加载更早"行）：ResizeObserver 盯它 */
const contentRef = ref<HTMLElement | null>(null)
const inputRef = ref<InstanceType<typeof InputBox> | null>(null)
const stick = ref(true)
/** 打开会话后的"锚定窗口"：期间无视 80px 阈值，内容长多少跟多少 */
const pendingAnchor = ref(false)
let ro: ResizeObserver | null = null

/**
 * 按轮分组（v2.11）：轮内是"正文段 / 工具行段"按时间交替的若干段，轮间才留白。
 * 分组是纯函数（`lib/turns.ts`），这里只负责把结果画出来。
 */
const turns = computed(() => groupIntoTurns(store.messages))

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

/** 立刻贴底（同步）。用赋值而不是 scrollTo({behavior:'smooth'})：开会话要"瞬间到位" */
function anchorNow(): void {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/**
 * 内容/可视区尺寸变化时的跟随。
 * 只有"该跟随"的时候才贴：用户正在看历史（stick=false）且不在锚定窗口里 → 一律不动。
 */
function onResize(): void {
  if (!stick.value && !pendingAnchor.value) return
  anchorNow()
}

/**
 * 打开会话：立起锚定窗口，每帧贴底，直到内容高度**连续两帧不变**（或 1.5s 兜底）。
 * 这是修掉坑 50 的关键：DOM 分波进去时，只有"贴到稳定"才不会停在半路。
 */
async function anchorUntilSettled(): Promise<void> {
  pendingAnchor.value = true
  try {
    await followUntilSettled(
      () => scroller.value?.scrollHeight ?? 0,
      () => anchorNow(),
    )
  } finally {
    pendingAnchor.value = false
  }
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  // 划到顶附近 → 自动翻页（earlier() 里会补偿 scrollTop，所以视口不会跳）
  if (el.scrollTop <= AUTO_TOP_PX) void earlier()
}

async function toBottom(): Promise<void> {
  await nextTick()
  anchorNow()
}

/**
 * 加载更早的消息：加载后把视口"钉"在原处。
 *
 * 必须自己算，因为 prepend 会让 scrollHeight 一下变大 —— 不补偿就会出现
 * "点一下、内容跳到最上面/最下面"的错觉。同时临时关掉跟随底部（否则
 * tail 变化会触发 toBottom，把用户刚要看的历史顶走）。
 *
 * v2.6：prepend 进 DOM 同样是**分波**的 → 先等高度稳定再算差值，否则差值算小了、
 * 补偿不到位（实测：手动滚到顶后加载更早，视口会留在顶部而内容已经长了一千多像素）。
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
  // 等 prepend 的内容真正落定（onFrame 什么都不做：这一刻绝不能贴底）
  await followUntilSettled(
    () => scroller.value?.scrollHeight ?? 0,
    () => {},
    { maxMs: 1200 },
  )
  if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
}

watch(tail, () => {
  if (stick.value) void toBottom()
})

watch(
  () => store.currentId,
  () => {
    // 打开/切换会话：口径是**永远落到底部（最新消息）**
    stick.value = true
    anchorNow()
    void anchorUntilSettled()
  },
)

onMounted(() => {
  void toBottom()
  // 上下文窗口上限（分母）：dashboard 后端 /api/model-info，经 nginx 转发；取不到就不显示
  void loadModelInfo()
  // 内容分波长高 / 可视区变化（手机键盘）时的跟随兜底：光靠 tail 变化不够（坑 50）
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => onResize())
    // 观察两样：① scroller —— 视口变化（手机键盘弹出/收起）；
    // ② contentRef —— **内容长高**（工具行、"加载更早"行、累计行都会在锚定之后才出现）。
    // 只观察 scroller 是没用的：flex 布局里它的盒子固定，内容长高不会改变它自己的尺寸。
    if (scroller.value) ro.observe(scroller.value)
    if (contentRef.value) ro.observe(contentRef.value)
  }
})

/**
 * 内容块是"有消息才渲染"的 —— 空态/加载态时根本不存在，挂载那一刻可能拿不到它。
 * 它一出现就补上观察，否则内容长高永远不会有通知（实测踩到：修复看起来生效了，其实什么都没观察）。
 */
watch(contentRef, (el) => {
  if (ro && el) ro.observe(el)
})

onUnmounted(() => {
  ro?.disconnect()
  ro = null
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
        <!--
          空态只留标题（2026-09-15 按用户要求）：副标题（『从一个新会话开始』/『这个会话还没有消息』）
          与空态那一份构建标识都去掉了 —— 那个时间戳是**构建时刻**不是在跑的时间，
          留在屏幕正中只会让人误读；顶栏另有一份同样的小字标识，"看是哪一版"不受影响。
          空态刻意不显示任何示例话术（自用：保持对话区干净）——曾有一组写死的示例按钮
          （510210 盘面 / hermes_stock 交易记录 / Python 改异步），已去掉。
        -->
        <div class="text-2xl font-semibold">有什么可以帮您？</div>
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

      <!-- 消息。ref 给 ResizeObserver：内容会**分波**长高（工具行、"加载更早"那一行、
           末尾的"会话累计"行），只有盯住整块内容才知道要重贴底（坑 50）——
           只盯列表 div 会漏掉后两者，实测留下恒定 44px 偏差。 -->
      <div v-else ref="contentRef" data-testid="content" class="mx-auto min-w-0 max-w-chat px-4 py-6">
        <!-- 更早的历史：划到顶会自动加载，这个按钮是手动兜底 + 加载中提示 -->
        <!-- （内容不足一屏时不会产生滚动事件，自动加载永远等不到，只能点它） -->
        <div v-if="store.hasMoreHistory" class="mb-4 flex justify-center">
          <button
            type="button"
            data-testid="earlier"
            class="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 transition hover:bg-gray-50 hover:text-gray-700 disabled:opacity-60 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200"
            :disabled="store.historyLoading"
            @click="earlier()"
          >
            {{ store.historyLoading ? '加载中…' : '加载更早的消息' }}
          </button>
        </div>
        <!--
          一轮一个块：轮内紧凑（space-y-2）、轮间留白（mt-6 + first:mt-0）。
          交错渲染之后一轮里会有好几个段，用统一个间距会让"轮内先后"和"新一轮提问"看起来一样远。
        -->
        <div class="min-w-0">
          <div
            v-for="t in turns"
            :key="t.key"
            data-testid="turn"
            class="mt-6 min-w-0 space-y-2 first:mt-0"
          >
            <MessageItem v-if="t.ask" :msg="t.ask" />
            <!-- 轮首头像：只回答"这是谁说的"；状态一律看输入框上方那条状态行 -->
            <TurnAvatar />
            <MessageItem v-for="m in t.segs" :key="m.key" :msg="m" />
          </div>
        </div>

      </div>
    </div>

    <!-- 执行状态行（含模型/窗口/本轮输入合计，2026-09-17 并成一行）+ 输入框 -->
    <RunStatus />
    <InputBox ref="inputRef" />
  </section>
</template>
