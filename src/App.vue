<script setup lang="ts">
/**
 * 布局骨架（设计文档 5.1）：
 *   顶栏（会话开关 + Hermes + 连接状态 + 主题切换 + Settings）/ 主体（Sidebar + ChatWindow）
 *
 * 侧栏两种形态，由一个按钮统一控制（省一个按钮，也避免桌面上出现"两个汉堡"）：
 *   - 移动端（<768px）：抽屉，默认收起，点按钮展开，选中会话后自动收起
 *   - 桌面端（≥768px）：常驻列，点按钮折叠/展开，选择记在 localStorage
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ChatWindow from './components/ChatWindow.vue'
import Notice from './components/Notice.vue'
import { checkHealth, clearBootError, goHome, loadSessions, openSession, resumeSync, store } from './stores/chat'
import { currentRoute, markInitialRoute, navigate, onRouteChange, type Route } from './lib/route'
import { watchForeground } from './lib/page-lifecycle'
import { theme, toggleTheme } from './lib/theme'

// 构建时注入（见 vite.config.ts 的 define）—— 顶栏那串小字就是它：
// "手机上是哪一版"一眼可见，不用再靠猜（踩过：手机缓存旧入口 HTML）
const buildId = __BUILD_ID__
const buildShort = __BUILD_SHORT__

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

/**
 * 回到前台 / 网络恢复 → 立刻跟服务端对一次账（v2.2）。
 *
 * 手机切 App、锁屏、切 Wi-Fi/5G 都会让页面的连接失效，而**后台 JS 里做什么都不可靠**
 * （定时器被 throttle、连接被系统掐）。所以这里只监听"回来了"这一个事件，把恢复
 * 动作交给 stores/chat.ts 的 resumeSync（幂等：没在跑的轮次它就是一次空操作）。
 */
let unwatchForeground: (() => void) | null = null

/* ── 地址即状态（v2.12）─────────────────────────────────────────────
 * 打开会话**只有这一个入口**：地址变化 → applyRoute()。
 * 侧栏点击、返回键、手改地址、外链进来，走的都是同一条路 —— 所以地址和画面不会打架。
 */

/** 轻提示（会自动消失）：目前只有"地址里的会话不存在"会用到 */
const notice = ref('')
let offRoute: (() => void) | null = null

async function applyRoute(r: Route): Promise<void> {
  if (r.kind === 'home') {
    goHome()
    return
  }
  if (r.id === store.currentId) return

  const res = await openSession(r.id)
  if (res.ok) return

  if (res.missing) {
    // 地址里的会话不存在（被删/归档/乱写）→ 送回欢迎页（地址也清干净）+ 一句轻提示。
    // 口径（用户 2026-09-15）：5 秒自动消失、点一下就立刻消失。
    // 顺手清掉 bootError：这条信息由轻提示表达，别同时挂一条红字常驻横幅。
    clearBootError()
    navigate(null, { mode: 'replace' })
    notice.value = '该会话不存在，请重新创建'
    return
  }

  // 生成中不许切会话（openSession 的守卫，既有行为）→ 把地址撤回当前会话，
  // 否则会留下"地址是 B、画面是 A"的不一致。其它错误（网络等）保持地址不动：
  // 那种情况下 openSession 已经把人送进目标会话并挂了错误横幅，刷新重试即可。
  if (store.streaming && store.currentId) navigate(store.currentId, { mode: 'replace' })
}

onMounted(() => {
  // 恢复折叠态后按钮语义要跟得上（否则 hover 提示会说反）
  sidebarLabel.value = collapsed.value ? '展开会话列表' : '折叠会话列表'
  void checkHealth()
  void loadSessions()
  unwatchForeground = watchForeground(() => void resumeSync())
  // 首帧：先按地址进入（刷新恢复会话靠的就是这一步），再对一次账
  const initial = currentRoute()
  markInitialRoute(initial)
  offRoute = onRouteChange((r) => void applyRoute(r))
  void applyRoute(initial)
  // 欢迎页时也对一次账：页面可能是被系统回收后重新打开的（此时本轮 run 还在服务端跑）
  void resumeSync()
})

onBeforeUnmount(() => {
  unwatchForeground?.()
  offRoute?.()
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
        <span class="text-gray-300 dark:text-gray-600" :title="`前端构建 ${buildId}`">
          · {{ buildShort }}
        </span>
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

  <!-- 会自动消失的轻提示（点击立即消失；5 秒后自己走） -->
  <Notice v-if="notice" :text="notice" @close="notice = ''" />

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
          <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">前端构建 {{ buildId }}</p>
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
