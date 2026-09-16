<script setup lang="ts">
/**
 * 输入框。按钮与 Enter 的行为**按当前相位分派**（2026-09-15 用户定的规则）：
 *
 *   | 相位 | 按钮 | 点它 / Enter |
 *   | --- | --- | --- |
 *   | 思考 / 调工具 / 等审批 / 后台在跑 | 「发送」（旁边另有次要「暂停」） | **补充信息**（steer：不打断工具、不新开一轮） |
 *   | 正在输出正文（writing） | 「暂停」 | 中断这一轮；Enter **不提交**（静默，防误触打断输出） |
 *   | 没在跑 | 「发送」 | 开新的一轮 |
 *
 *  - Enter 发送 / Shift+Enter 换行
 *  - 中文输入法合成期间（composing / isComposing）绝不发送，否则拼音候选回车会误发
 *  - 生成中不禁用输入（可以继续打字）
 *  - `stream` 回退通道没有 steer 端点 → 只给「暂停」，并在下方注明不支持补充
 *
 * 布局（v1.4 改，对齐 ChatGPT）：**文字区与按钮上下两段，不并排**。
 *   ┌───────────────────────────────┐
 *   │ 文字区（占满整宽，可一直顶到右） │
 *   │                    [发送]      │ ← 工具行
 *   └───────────────────────────────┘
 * 早期版本是 textarea(flex-1) + 按钮 左右并排，结果按钮占了右下角、
 * 文字到按钮左缘就断行 —— 输入长内容时按钮上方一片空，观感很差。
 * 以后加语音/附件等按钮，一律放这条工具行里（左侧 justify-between 即可）。
 */
import { computed, nextTick, ref } from 'vue'
import { canSteer, send, sendTransport, steer, stop, store } from '../stores/chat'

const text = ref('')
const el = ref<HTMLTextAreaElement | null>(null)
const composing = ref(false)

/* ---------------- 历史输入：↑ / ↓（像 shell 那样翻"我说过的话"） ----------------
 *
 * 只翻**当前会话**里我说过的话（最新的在最后，最多取最近 20 条）：
 *  - ↑：把上一条填进输入框，连按继续往前翻
 *  - ↓：往回走；翻到最后一条时还原"翻历史之前正在打的那个草稿"
 *
 * 两个必须让路的地方（否则会抢用户的按键）：
 *  1. **输入法合成期间**（拼音候选框也用 ↑/↓ 选字）→ 一律不拦
 *  2. **多行草稿里光标不在首行**→ 交给 textarea 原生行为（那是在文本里上下移动光标）
 */

/** 翻历史前正在打的内容（↓ 翻到底时还回去） */
let draft = ''
/** 当前停在历史第几条；null = 不在翻历史 */
const histIdx = ref<number | null>(null)

const history = computed(() => {
  const out: string[] = []
  for (const m of store.messages) {
    if (m.role !== 'user') continue
    const t = m.content.trim()
    if (t) out.push(t)
  }
  return out.slice(-20)
})

function setText(v: string): void {
  text.value = v
  void nextTick(() => {
    autoGrow()
    const ta = el.value
    if (ta) {
      const n = ta.value.length
      ta.setSelectionRange?.(n, n) // 光标放末尾：填进来就是为了改一改再发
    }
  })
}

/** 光标是否在第一行（多行时 ↑ 应该移动光标，不该翻历史） */
function onFirstLine(ta: HTMLTextAreaElement): boolean {
  return !ta.value.slice(0, ta.selectionStart ?? 0).includes('\n')
}

/** 处理 ↑/↓；返回 true = 已消费（调用方要 preventDefault） */
function recall(e: KeyboardEvent): boolean {
  if (composing.value || e.isComposing) return false
  const ta = el.value
  const list = history.value
  if (!ta || !list.length) return false

  if (e.key === 'ArrowUp') {
    if (text.value && !onFirstLine(ta)) return false
    if (histIdx.value === null) draft = text.value
    histIdx.value = histIdx.value === null ? list.length - 1 : Math.max(0, histIdx.value - 1)
    setText(list[histIdx.value])
    return true
  }

  if (e.key === 'ArrowDown' && histIdx.value !== null) {
    const next = histIdx.value + 1
    if (next >= list.length) {
      histIdx.value = null
      setText(draft)
      draft = ''
    } else {
      histIdx.value = next
      setText(list[next])
    }
    return true
  }

  return false
}

/** 工具行高度（发送按钮那一行），算最大高度时要减掉它，否则会顶出容器 */
const TOOLBAR_PX = 40

function autoGrow(): void {
  const t = el.value
  if (!t) return
  t.style.height = 'auto'
  const max = Math.max(80, Math.round(window.innerHeight * 0.4) - TOOLBAR_PX)
  t.style.height = `${Math.min(t.scrollHeight, max)}px`
}

function submit(): void {
  const v = text.value
  if (!v.trim()) return
  // 正文正在输出：按钮是「暂停」，Enter 不提交（静默 —— 用户 2026-09-15 选的乙口径）
  if (mode.value === 'stop') return
  text.value = ''
  histIdx.value = null // 发出去的这句成了最新历史；下次 ↑ 从它开始
  draft = ''
  void nextTick(autoGrow)
  if (mode.value === 'steer') void steer(v) // 补充：插进正在跑的那一轮
  else void send(v) // 新的一轮
}

/**
 * "忙"的两种形态（v2.2）：
 *  - streaming：本页正连着事件流
 *  - background：本地流已经断了，但**服务端那一轮还在跑**
 * 两种情况都必须让"暂停"可用 —— 用户在任何状态下都该能取消这一轮。
 */
const busy = computed(() => store.streaming || store.run.phase === 'background')

/**
 * 按钮语义（按相位分派，2026-09-15 用户口径）：
 *  - `steer`：跑着且能补充（思考 / 调工具 / 等审批 / 后台在跑）→ 按钮是「发送」= 补充
 *  - `stop` ：忙但不能补（正文正在输出 / stream 通道 / 拿不到 run_id）→ 按钮是「暂停」
 *  - `send` ：没在跑 → 按钮是「发送」= 新的一轮
 */
const mode = computed<'send' | 'steer' | 'stop'>(() =>
  canSteer() ? 'steer' : busy.value ? 'stop' : 'send',
)

/** stream 回退通道（没有 steer 端点）：忙时只能暂停，界面注明一句，免得用户以为坏了 */
const steerUnsupported = computed(() => busy.value && sendTransport() !== 'runs')

function onKeydown(e: KeyboardEvent): void {
  // ↑/↓ 翻历史（像 shell）：被消费了就拦掉原生滚动/光标移动
  if (recall(e)) {
    e.preventDefault()
    return
  }
  if (e.key !== 'Enter' || e.shiftKey) return
  if (composing.value || e.isComposing) return
  e.preventDefault()
  submit()
}

/** 供外部（示例问题）填入文本 */
function fill(t: string): void {
  histIdx.value = null
  text.value = t
  void nextTick(() => {
    autoGrow()
    el.value?.focus()
  })
}

defineExpose({ fill })
</script>

<template>
  <div class="mx-auto w-full max-w-chat px-4 pb-4">
    <div
      class="rounded-2xl border border-gray-300 bg-white px-3 pb-1.5 pt-2.5 shadow-sm focus-within:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:focus-within:border-gray-600"
    >
      <textarea
        ref="el"
        v-model="text"
        rows="1"
        placeholder="给 Hermes 发消息…"
        class="thin-scroll max-h-[40vh] w-full resize-none bg-transparent leading-6 outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500"
        @input="autoGrow"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />

      <!-- 工具行：所有按钮都在这一行，文字区因此可以占满整宽 -->
      <div class="flex items-center justify-end gap-1 pt-1">
        <!--
          忙且能补充时，「发送」（=补充）是主按钮，但**保留一个次要「暂停」**：
          v2.2 立的不变式是"用户在任何状态下都能取消这一轮"—— 工具可能跑很久，
          若这一刻只剩「发送」，用户就没法中断了。用户 2026-09-15 定的规则只说了
          "正文输出期按钮必须是暂停"，没说"别的相位不能暂停"，所以两者并存。
        -->
        <button
          v-if="mode === 'steer'"
          type="button"
          class="rounded-xl border border-gray-300 px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          title="中断本轮"
          @click="stop()"
        >
          暂停
        </button>
        <button
          v-if="mode === 'stop'"
          type="button"
          class="rounded-xl bg-gray-900 px-3 py-1.5 text-sm text-white transition hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
          :title="store.streaming ? '中断本轮（正文输出中）' : '中断后台执行中的这一轮'"
          @click="stop()"
        >
          暂停
        </button>
        <button
          v-else
          type="button"
          class="rounded-xl bg-gray-900 px-3 py-1.5 text-sm text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white dark:disabled:bg-gray-800 dark:disabled:text-gray-600"
          :disabled="!text.trim()"
          @click="submit()"
        >
          发送
        </button>
      </div>
    </div>
    <!--
      提示行只在**有功能含义**时出现（2026-09-16 用户要求：提示词换展示方式或直接去掉）。
      常驻那行装饰文案已去掉 —— 它那两段各有归属，不必在输入框下面重复：
        · 「刷新/切后台不会取消任务」→ RunStatus 的 background 相位在真的发生时会说；
        · 「Enter 发送 / Shift+Enter 换行」→ Settings 的「快捷键」小节已列出。
    -->
    <p
      v-if="steerUnsupported"
      data-testid="steer-unsupported"
      class="mt-1.5 text-center text-[11px] text-gray-400 dark:text-gray-500"
    >
      当前通道不支持补充信息（只能暂停本轮）
    </p>
  </div>
</template>
