<script setup lang="ts">
/**
 * 布局骨架（设计文档 5.1）：
 *   顶栏（会话开关 + Hermes + 连接状态 + 主题切换 + Settings）/ 主体（Sidebar + ChatWindow）
 *
 * 侧栏两种形态，由一个按钮统一控制（省一个按钮，也避免桌面上出现"两个汉堡"）：
 *   - 移动端（<768px）：抽屉，默认收起，点按钮展开，选中会话后自动收起
 *   - 桌面端（≥768px）：常驻列，点按钮折叠/展开，选择记在 localStorage
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Sidebar from './components/Sidebar.vue'
import ChatWindow from './components/ChatWindow.vue'
import Notice from './components/Notice.vue'
import InboxBell from './components/InboxBell.vue'
import InboxDrawer from './components/InboxDrawer.vue'
import {
  checkHealth,
  clearBootError,
  goHome,
  loadSessions,
  newChat,
  openSession,
  resumeSync,
  send,
  store,
} from './stores/chat'
import {
  clearNewCount,
  inbox,
  onDrawerOpen,
  reschedulePolling,
  setRead,
  startPolling,
  stopPolling,
} from './stores/inbox'
import { POLL_OPTIONS } from './lib/inboxPoll'
import { pollSetting, setPollSetting } from './lib/inboxSettings'
import type { InboxEmail, InboxMessage } from './api/inbox'
import { currentRoute, markInitialRoute, navigate, onRouteChange, type Route } from './lib/route'
import { watchForeground } from './lib/page-lifecycle'
import { theme, toggleTheme } from './lib/theme'
import { avatar, DEFAULT_AVATAR, resetAvatar, setAvatar } from './lib/appearance'

// 构建时注入（见 vite.config.ts 的 define）。
// 2026-09-17 起**只在 Settings 里显示** —— 用户要求把顶栏那串小字移走（首屏不摆构建信息）。
const buildId = __BUILD_ID__

const drawer = ref(false)
const settings = ref(false)
/**
 * 头像草稿（Settings 里那个输入框）—— 用独立变量而不是直接绑 `avatar`，
 * 否则清空输入框会被立刻弹回默认值，没法边打边改。
 */
const avatarDraft = ref(avatar.value)

function onAvatarInput(): void {
  setAvatar(avatarDraft.value) // 每敲一下就生效（"立马改"）
}

function onAvatarReset(): void {
  resetAvatar()
  avatarDraft.value = DEFAULT_AVATAR
}

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

/** 轻提示（会自动消失）：地址里的会话不存在、消息中心有新消息都会用到 */
const notice = ref('')
let offRoute: (() => void) | null = null

/* ── 消息中心（v1，2026-09-22）────────────────────────────────────────
 * 抽屉**不进地址**（与 Settings 一致）：它是覆盖层，不是"当前在哪"。
 * 进地址会有个真问题：地址里只有一个位置，写上 `#/inbox` 就把会话 id 挤掉了 ⇒
 * 刷新后会变成"欢迎页 + 抽屉开着"，比现在更差。要进地址得改成 `#/s/<id>/inbox` 那种带后缀的形态，
 * 那是另一件事（要动 v2.12 那套路由），首期不做。
 */
const inboxOpen = ref(false)

async function toggleInbox(): Promise<void> {
  inboxOpen.value = !inboxOpen.value
  // `关闭` 档下不自动拉（用户口径：关闭 = 连开抽屉也不拉，只有手动刷新才拉）
  if (inboxOpen.value) await onDrawerOpen()
}

/** 轮询发现新消息 → 一句轻提示（5 秒自己走，点一下就没） */
watch(
  () => inbox.newCount,
  (n) => {
    if (n > 0) {
      notice.value = `消息中心有 ${n} 条新消息`
      clearNewCount()
    }
  },
)

/** 轮询档位改了要**按新档位重排定时器**（改完立刻生效，不用刷新、不用重建） */
watch(pollSetting, () => reschedulePolling())

/**
 * 「就这条问 agent」：把这条消息当上下文发一轮（走现有发送链路，token 只在点的时候花）。
 * - 生成中不让发（send 的守卫会静默丢掉，这里得说出来，否则用户以为点了没反应）；
 * - 没有会话就先建一个，并把地址切过去（否则"问完看不见"）；
 * - 顺手标记已读：都拿去问了，说明这条处理过了。
 */
async function askAbout(msg: InboxMessage): Promise<void> {
  inboxOpen.value = false
  if (store.streaming || store.run.phase === 'background') {
    notice.value = '正在生成中，等这一轮结束再问'
    return
  }
  if (!store.currentId) {
    const id = await newChat()
    if (!id) {
      notice.value = '无法创建会话'
      return
    }
    navigate(id, { mode: 'push' })
  }
  const body = inbox.detail && inbox.detail.id === msg.id ? inbox.detail.body : msg.excerpt
  void setRead(msg.id, true)
  await send(`【消息中心】${msg.title}\n\n${body || ''}\n\n（上面这条是消息中心里的提醒，请结合我的规则给处理建议。）`)
}

/**
 * 「就这封问 agent」（邮件 tab）。
 *
 * 与通知那版的区别：邮件**不落库**，正文就取刚拉到的详情（不再多一次请求）；
 * ★ **不标已读** —— 邮件状态归邮箱，前端一概不动（用户 2026-09-24 定调）。
 */
async function askAboutEmail(mail: InboxEmail): Promise<void> {
  inboxOpen.value = false
  if (store.streaming || store.run.phase === 'background') {
    notice.value = '正在生成中，等这一轮结束再问'
    return
  }
  if (!store.currentId) {
    const id = await newChat()
    if (!id) {
      notice.value = '无法创建会话'
      return
    }
    navigate(id, { mode: 'push' })
  }
  const body = inbox.emailDetail && inbox.emailDetail.uid === mail.uid ? inbox.emailDetail.body : mail.excerpt
  await send(`【邮箱】${mail.subject}\n\n${body || ''}\n\n（上面这封是我邮箱里的邮件，请结合我的规则给处理建议。）`)
}

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
  // 消息中心轮询（档位来自浏览器设置；`关闭` 档不排定时器）
  startPolling()
})

onBeforeUnmount(() => {
  unwatchForeground?.()
  offRoute?.()
  stopPolling()
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

      <InboxBell class="ml-auto" :open="inboxOpen" @toggle="toggleInbox()" />

      <button
        type="button"
        class="rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
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

  <!-- 消息中心抽屉（v1）：与 Settings 同一套骨架，`关闭` 档只是不自动拉，界面照常可用 -->
  <InboxDrawer v-if="inboxOpen" @close="inboxOpen = false" @ask="askAbout" @ask-email="askAboutEmail" />

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
          <h3 class="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">头像</h3>
          <div class="flex items-center gap-2">
            <span
              data-testid="avatar-preview"
              class="w-10 shrink-0 truncate rounded bg-gray-100 px-1 py-0.5 text-center dark:bg-gray-800"
              >{{ avatar }}</span
            >
            <input
              v-model="avatarDraft"
              data-testid="avatar-input"
              type="text"
              maxlength="8"
              :placeholder="DEFAULT_AVATAR"
              class="min-w-0 flex-1 rounded border border-gray-300 bg-transparent px-2 py-0.5 outline-none focus:border-gray-400 dark:border-gray-700 dark:focus:border-gray-600"
              @input="onAvatarInput()"
            />
            <button
              type="button"
              class="shrink-0 rounded px-2 py-0.5 text-xs text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              @click="onAvatarReset()"
            >
              默认
            </button>
          </div>
          <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
            每轮对话开头那个标记。改完立刻生效（存在这台浏览器里，不用重新构建）。
          </p>
        </section>

        <section>
          <h3 class="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500">消息</h3>
          <div class="flex items-center gap-2">
            <span>自动刷新</span>
            <select
              data-testid="inbox-poll-select"
              class="ml-auto rounded border border-gray-300 bg-transparent px-1.5 py-0.5 text-xs outline-none dark:border-gray-700 dark:bg-gray-900"
              :value="pollSetting"
              @change="setPollSetting(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in POLL_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
          <p class="mt-1 text-xs text-gray-400 dark:text-gray-500">
            默认 5 分钟。`关闭` = 完全不自动拉取（点图标也不拉），只有抽屉里的「立即刷新」会拉。
            这个设置存在这台浏览器里、改完立刻生效（手机和 PC 可以不一样）。
          </p>
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
