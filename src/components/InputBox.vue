<script setup lang="ts">
/**
 * 输入框。
 *  - Enter 发送 / Shift+Enter 换行
 *  - 中文输入法合成期间（composing / isComposing）绝不发送，否则拼音候选回车会误发
 *  - 生成中不禁用输入（可以继续打字），只把发送按钮换成"停止"
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
import { nextTick, ref } from 'vue'
import { send, stop, store } from '../stores/chat'

const text = ref('')
const el = ref<HTMLTextAreaElement | null>(null)
const composing = ref(false)

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
  if (!v.trim() || store.streaming) return
  text.value = ''
  void nextTick(autoGrow)
  void send(v)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.shiftKey) return
  if (composing.value || e.isComposing) return
  e.preventDefault()
  submit()
}

/** 供外部（示例问题）填入文本 */
function fill(t: string): void {
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
        <button
          v-if="store.streaming"
          type="button"
          class="rounded-xl bg-gray-900 px-3 py-1.5 text-sm text-white transition hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
          title="停止本轮"
          @click="stop()"
        >
          停止
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
    <p class="mt-1.5 text-center text-[11px] text-gray-400 dark:text-gray-500">
      浏览器刷新会打断正在进行的回复 · Enter 发送 / Shift+Enter 换行
    </p>
  </div>
</template>
