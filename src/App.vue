<script setup lang="ts">
/**
 * 布局骨架（设计文档 5.1）：
 *   顶栏（会话开关 + Hermes + 连接状态 + 主题切换 + Settings）/ 主体（Sidebar + ChatWindow）
 *
 * 侧栏两种形态，由一个按钮统一控制（省一个按钮，也避免桌面上出现"两个汉堡"）：
 *   - 移动端（<768px）：抽屉，默认收起，点按钮展开，选中会话后自动收起
 *   - 桌面端（≥768px）：常驻列，点按钮折叠/展开，选择记在 localStorage
 */
import { onMounted, ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ChatWindow from './components/ChatWindow.vue'
import { checkHealth, loadSessions, store } from './stores/chat'
import { theme, toggleTheme } from './lib/theme'

const drawer = ref(false)
const settings = ref(false)

/** 桌面端侧栏折叠状态（持久化；移动端不用这个） */
const SIDEBAR_KEY = 'hcl.sidebar'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(readCollapsed())

function isDesktop(): boolean {
  const mm = window.matchMedia?.('(min-width: 768px)')
  return mm ? mm.matches : window.innerWidth >= 768
}

const sidebarLabel = ref('会话列表')

function toggleSidebar(): void {
  if (isDesktop()) {
    collapsed.value = !collapsed.value
    sidebarLabel.value = collapsed.value ? '展开会话列表' : '折叠会话列表'
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed.value ? '1' : '0')
    } catch {
      /* 隐私模式：不持久化即可 */
    }
  } else {
    drawer.value = true
  }
}

onMounted(() => {
  // 恢复折叠态后按钮语义要跟得上（否则 hover 提示会说反）
  sidebarLabel.value = collapsed.value ? '展开会话列表' : '折叠会话列表'
  void checkHealth()
  void loadSessions()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex h-12 shrink-0 items-center gap-3 border-b border-gray-200 px-3 dark:border-gray-800"
    >
      <button
        type="button"
        class="-ml-1 rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        :title="sidebarLabel"
        :aria-label="sidebarLabel"
        @click="toggleSidebar()"
      >
        <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" />
        </svg>
      </button>

      <span class="text-sm font-semibold tracking-tight">Hermes</span>

      <span class="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
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
        class="ml-auto rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        :title="theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'"
        :aria-label="theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'"
        @click="toggleTheme()"
      >
        <!-- 深色时显示太阳（点它回到白天），浅色时显示月亮 -->
        <svg
          v-if="theme === 'dark'"
          viewBox="0 0 24 24"
          class="h-5 w-5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
            stroke-linecap="round"
          />
        </svg>
        <svg v-else viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        @click="settings = true"
      >
        Settings
      </button>
    </header>

    <div class="flex min-h-0 flex-1">
      <Sidebar :open="drawer" :collapsed="collapsed" @close="drawer = false" />
      <ChatWindow />
    </div>
  </div>

  <!-- Settings 抽屉（最小化：不做模型切换 / Prompt / Agent 配置） -->
  <div v-if="settings" class="fixed inset-0 z-40 bg-black/20 dark:bg-black/50" @click.self="settings = false">
    <div
      class="absolute right-0 top-0 flex h-full w-80 max-w-[85vw] flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-900"
    >
      <div class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <span class="text-sm font-semibold">Settings</span>
        <button
          type="button"
          class="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          @click="settings = false"
        >
          ✕
        </button>
      </div>

      <div class="space-y-5 p-4 text-sm">
        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">连接</h3>
          <div class="flex items-center gap-2">
            <span
              class="inline-block h-2 w-2 rounded-full"
              :class="store.healthOk ? 'bg-green-500' : 'bg-red-500'"
            />
            <span>{{ store.healthOk ? 'Hermes API Server 正常' : '无法连接 Hermes' }}</span>
            <button
              type="button"
              class="ml-auto rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              @click="checkHealth()"
            >
              刷新
            </button>
          </div>
          <p v-if="store.healthVersion" class="mt-1 text-xs text-gray-400 dark:text-gray-500">
            版本 v{{ store.healthVersion }} · 鉴权由反代注入
          </p>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">外观</h3>
          <div class="flex items-center gap-2">
            <span>{{ theme === 'dark' ? '黑夜模式' : '白天模式' }}</span>
            <button
              type="button"
              class="ml-auto rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              @click="toggleTheme()"
            >
              切换
            </button>
          </div>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">快捷键</h3>
          <ul class="space-y-1 text-xs text-gray-500 dark:text-gray-400">
            <li><b class="font-mono">Enter</b> 发送</li>
            <li><b class="font-mono">Shift + Enter</b> 换行</li>
            <li>生成中，发送按钮变为 <b>停止</b></li>
          </ul>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">关于</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            Hermes Chat Lite v0.1.0 —— 只做展示层，Agent / Session / Memory / 工具调用全部由 Hermes 负责。
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
