<script setup lang="ts">
/**
 * 布局骨架（设计文档 5.1）：
 *   顶栏（Hermes + 连接状态 + Settings）/ 主体（Sidebar + ChatWindow）
 * 移动端侧栏为抽屉，默认收起。
 */
import { onMounted, ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ChatWindow from './components/ChatWindow.vue'
import { checkHealth, loadSessions, store } from './stores/chat'

const drawer = ref(false)
const settings = ref(false)

onMounted(() => {
  void checkHealth()
  void loadSessions()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-gray-200 px-3">
      <button
        type="button"
        class="-ml-1 rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 md:hidden"
        aria-label="打开会话列表"
        @click="drawer = true"
      >
        <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
        </svg>
      </button>

      <span class="text-sm font-semibold tracking-tight">Hermes</span>

      <span class="flex items-center gap-1.5 text-xs text-gray-400">
        <span
          class="inline-block h-1.5 w-1.5 rounded-full"
          :class="store.healthOk ? 'bg-green-500' : 'bg-red-500'"
        />
        <span v-if="!store.healthOk">未连接</span>
        <span v-else-if="store.healthVersion">v{{ store.healthVersion }}</span>
        <span v-else>已连接</span>
      </span>

      <button
        type="button"
        class="ml-auto rounded-lg px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
        @click="settings = true"
      >
        Settings
      </button>
    </header>

    <div class="flex min-h-0 flex-1">
      <Sidebar :open="drawer" @close="drawer = false" />
      <ChatWindow />
    </div>
  </div>

  <!-- Settings 抽屉（最小化：不做模型切换 / Prompt / Agent 配置） -->
  <div v-if="settings" class="fixed inset-0 z-40 bg-black/20" @click.self="settings = false">
    <div class="absolute right-0 top-0 flex h-full w-80 max-w-[85vw] flex-col border-l border-gray-200 bg-white shadow-xl">
      <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <span class="text-sm font-semibold">Settings</span>
        <button type="button" class="rounded p-1 text-gray-400 hover:bg-gray-100" @click="settings = false">✕</button>
      </div>

      <div class="space-y-5 p-4 text-sm">
        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400">连接</h3>
          <div class="flex items-center gap-2">
            <span
              class="inline-block h-2 w-2 rounded-full"
              :class="store.healthOk ? 'bg-green-500' : 'bg-red-500'"
            />
            <span>{{ store.healthOk ? 'Hermes API Server 正常' : '无法连接 Hermes' }}</span>
            <button
              type="button"
              class="ml-auto rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-100"
              @click="checkHealth()"
            >
              刷新
            </button>
          </div>
          <p v-if="store.healthVersion" class="mt-1 text-xs text-gray-400">
            版本 v{{ store.healthVersion }} · 鉴权由反代注入
          </p>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400">快捷键</h3>
          <ul class="space-y-1 text-xs text-gray-500">
            <li><b class="font-mono">Enter</b> 发送</li>
            <li><b class="font-mono">Shift + Enter</b> 换行</li>
            <li>生成中，发送按钮变为 <b>停止</b></li>
          </ul>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400">关于</h3>
          <p class="text-xs text-gray-500">
            Hermes Chat Lite v0.1.0 —— 只做展示层，Agent / Session / Memory / 工具调用全部由 Hermes 负责。
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
