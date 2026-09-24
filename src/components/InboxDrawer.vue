<script setup lang="ts">
/**
 * 消息中心抽屉（v1，2026-09-22；v2 加「邮件」tab，2026-09-24）。
 *
 * 形态：**复用 Settings 那套右侧抽屉**（PC 480px / 手机全屏、遮罩点击关闭、✕ 关闭），
 * 一份骨架两处用，观感一致、少写一套。
 *
 * 两个 tab（用户 2026-09-24 定调）：
 *  - **通知**：消息表里的短通知（脚本 + agent 直推），可标记已读/归档；列表只给摘要，点开拉全文；
 *  - **邮件**：**实时读邮箱、不落库**（同一封邮件只有邮箱一份）。只读 —— 没有已读/归档动作
 *    （刻意不动您邮箱的状态），范围=整个收件箱，附件只在详情提示有几个。
 *
 * 口径：
 *  - 列表只给**摘要**（通知由服务端截 200 字，邮件由服务端压成一行），点开某条才拉全文；
 *  - 全文用**现成的 markdown 渲染器**（含 v2.1 修好的表格横向滚动 wrapper，且 `html: false`
 *    ⇒ 邮件正文里的 HTML 早已被后端去标签，前端绝不注入邮件 HTML）；
 *  - 等级灯：🔴要动手 / 🟡提示 / ⚪常规（左侧那颗圆点，颜色即级别）；
 *  - 动作：`就这条问 agent` / `标记已读` / `归档`（仅通知）；归档是"处理完了"，顺带已读；
 *  - 失败**不弹红字**：通知只在筛选行下面留一行小字；邮件给一行明确报错 + **重试按钮**
 *    （2026-09-24 用户要求：读邮箱失败必须能一键重试）。
 */
import { computed, ref } from 'vue'
import { renderMarkdown } from '../lib/markdown'
import { CATEGORY_FILTERS, categoryLabel, formatClock, formatWhen, levelMeta } from '../lib/inboxMeta'
import { pollSetting } from '../lib/inboxSettings'
import { isPolling, pollMs } from '../lib/inboxPoll'
import { isDefaultSince, sinceLabel } from '../lib/inboxSince'
import {
  archive,
  inbox,
  loadEmails,
  readAll,
  refreshNow,
  resetSince,
  retryEmails,
  setEmailDays,
  setEmailUnreadOnly,
  setFilter,
  setRead,
  setSinceInput,
  setTab,
  toggleDetail,
  toggleEmailDetail,
} from '../stores/inbox'
import type { InboxEmail, InboxMessage } from '../api/inbox'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'ask', msg: InboxMessage): void
  (e: 'ask-email', mail: InboxEmail): void
}>()

/** 邮件时间窗候选（天）：后端上限 90 */
const EMAIL_DAY_OPTIONS = [7, 30, 90] as const

/** 两个 tab：通知（消息表）/ 邮件（实时读邮箱） */
const TABS = [
  { value: 'notice' as const, label: '通知' },
  { value: 'email' as const, label: '邮件' },
]

/**
 * 「立即刷新」的转圈反馈（用户 2026-09-23 要求）。
 *
 * 问题：点完若列表没有新增，界面毫无变化 ⇒ 看不出这一下生效了没有。
 * 做法：点一下图标**转一圈**（360° 一次、不循环）——和浏览器刷新同一个肌肉记忆。
 *  ① 最短 `SPIN_MS`：请求常常几十毫秒就回来，不兜底就是"一闪而过"，等于没反馈；
 *  ② 转的期间按钮 disabled：防连点重复请求。
 */
const SPIN_MS = 600
/** 正在转（= 正在刷新） */
const refreshing = ref(false)

const renderedBody = computed(() => (inbox.detail ? renderMarkdown(inbox.detail.body || '') : ''))

/** 起始时间的人话（今天 00:00 起 / 不限 …） */
const sinceText = computed(() => sinceLabel(inbox.sinceInput))
/** 现在是不是"默认（当天 0 点）" —— 「今天 0 点」按钮的高亮用它 */
const isDefaultWindow = computed(() => isDefaultSince(inbox.sinceInput))
/**
 * 是不是"收窄了的时间窗"（有值、且不是当天 0 点）。
 *
 * 空窗（不限）不算收窄 —— 否则会把"没有消息"错说成"这个时间之后没有消息"。
 */
const narrowWindow = computed(() => Boolean(inbox.sinceInput) && !isDefaultSince(inbox.sinceInput))

function onSinceChange(e: Event): void {
  void setSinceInput((e.target as HTMLInputElement).value)
}

const footerClock = computed(() => {
  if (inbox.error) return '上次拉取失败'
  const t = formatClock(inbox.lastOkAt)
  return t ? `上次更新 ${t}` : ''
})

/** 轮询档位说明（`关闭` 档要把"手动刷新"这件事说清楚，否则像坏了） */
const pollHint = computed(() =>
  isPolling(pollSetting.value)
    ? `每 ${Math.round(pollMs(pollSetting.value) / 60000) >= 1 ? `${Math.round(pollMs(pollSetting.value) / 60000)} 分钟` : `${pollMs(pollSetting.value) / 1000} 秒`}自动刷新`
    : '自动刷新已关闭',
)

async function doRefresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  const started = Date.now()
  try {
    // 刷新的是**当前 tab**：在邮件页点刷新却去拉通知，等于没反应（2026-09-24）
    if (inbox.tab === 'email') await loadEmails()
    else await refreshNow()
  } finally {
    // 兜底到最少转满一圈的时长：请求太快时"闪一下"等于没反馈（用户 2026-09-23 的诉求）
    const rest = SPIN_MS - (Date.now() - started)
    if (rest > 0) await new Promise((r) => setTimeout(r, rest))
    refreshing.value = false
  }
}

/** 邮件正文（markdown 渲染，`html: false`；邮件里的 HTML 已在服务端去标签） */
const renderedEmailBody = computed(() =>
  inbox.emailDetail ? renderMarkdown(inbox.emailDetail.body || '') : '',
)

/** 邮件发件人：有名字就「名字 <地址>」，没名字就只给地址 */
function emailFrom(m: InboxEmail): string {
  return m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr
}

/** 邮件页脚：上次读取时刻（与通知的 footerClock 分开，免得两个 tab 互相冒充） */
const emailFooterClock = computed(() => {
  if (inbox.emailError) return '上次读取失败'
  const t = formatClock(inbox.emailLastOkAt)
  return t ? `上次读取 ${t}` : ''
})
</script>

<template>
  <div data-testid="inbox-drawer" class="fixed inset-0 z-40 bg-black/20 dark:bg-black/50" @click.self="emit('close')">
    <div
      class="absolute right-0 top-0 flex h-full w-full flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-900 sm:w-[480px]"
    >
      <!-- 头部：标题 + 未读 + 一键已读 + 刷新 + 关闭 -->
      <div class="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <span class="text-sm font-semibold">消息</span>
        <!-- 未读/一键已读只对**通知**有意义：邮件是只读、不落库的（2026-09-24） -->
        <template v-if="inbox.tab === 'notice'">
          <span v-if="inbox.unread > 0" data-testid="inbox-drawer-unread" class="text-xs text-red-500">
            {{ inbox.unread }} 条未读
          </span>
          <span v-else class="text-xs text-gray-400 dark:text-gray-500">全部已读</span>
        </template>
        <!-- ★ 一键已读放在头部（原来在最底部右下角一行小灰字 ⇒ 用户找不到就等于没有，2026-09-22 反馈）
             语义是**全部**：不带当前筛选（只清一部分会让徽标停在非 0，看着像"点了没用"） -->
        <button
          v-if="inbox.tab === 'notice'"
          type="button"
          data-testid="inbox-read-all"
          class="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 transition hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          :disabled="inbox.unread === 0"
          :title="inbox.unread > 0 ? `把全部 ${inbox.unread} 条标为已读` : '已经没有未读了'"
          @click="readAll()"
        >
          一键已读{{ inbox.unread > 0 ? ` (${inbox.unread})` : '' }}
        </button>
        <span
          class="ml-auto hidden text-[10px] text-gray-400 dark:text-gray-500 sm:inline"
          data-testid="inbox-poll-hint"
          >{{ pollHint }}</span
        >
        <button
          type="button"
          data-testid="inbox-refresh"
          class="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          title="立即刷新"
          :disabled="refreshing"
          @click="doRefresh()"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-4 w-4"
            :class="refreshing ? 'refresh-spin' : ''"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          data-testid="inbox-close"
          class="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <!-- tab（2026-09-24）：通知 = 消息表里的短通知；邮件 = 实时读邮箱、不落库 -->
      <div class="flex items-center gap-1 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <button
          v-for="t in TABS"
          :key="t.value"
          type="button"
          data-testid="inbox-tab"
          class="rounded-full px-2.5 py-0.5 text-xs transition"
          :class="
            inbox.tab === t.value
              ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          "
          @click="setTab(t.value)"
        >
          {{ t.label }}
        </button>
        <span
          v-if="inbox.tab === 'email'"
          data-testid="inbox-email-hint"
          class="ml-auto text-[10px] text-gray-400 dark:text-gray-500"
          >只读，不改邮箱已读状态</span
        >
      </div>

      <!-- 筛选（仅通知） -->
      <template v-if="inbox.tab === 'notice'">
        <div class="flex flex-wrap gap-1 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <button
          v-for="f in CATEGORY_FILTERS"
          :key="f.value"
          type="button"
          data-testid="inbox-filter"
          class="rounded-full px-2 py-0.5 text-xs transition"
          :class="
            inbox.filter === f.value
              ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          "
          @click="setFilter(f.value)"
        >
          {{ f.label }}
        </button>
      </div>

      <!-- 起始时间（v3.1）：默认当天 0 点；可以改；**刷新页面就还原**（只在内存里，不保存） -->
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-gray-200 px-4 py-2 text-xs dark:border-gray-800">
        <span class="text-gray-400 dark:text-gray-500">只看</span>
        <input
          type="datetime-local"
          data-testid="inbox-since"
          class="rounded border border-gray-300 bg-transparent px-1.5 py-0.5 text-xs outline-none dark:border-gray-700 dark:bg-gray-900"
          :value="inbox.sinceInput"
          @change="onSinceChange"
        />
        <span data-testid="inbox-since-label" class="text-gray-500 dark:text-gray-400">{{ sinceText }}</span>
        <button
          type="button"
          data-testid="inbox-since-today"
          class="ml-auto rounded px-1.5 py-0.5 transition"
          :class="
            isDefaultWindow
              ? 'text-gray-400 dark:text-gray-500'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          "
          title="回到默认：当天 00:00"
          @click="resetSince()"
        >
          今天 0 点
        </button>
        <button
          type="button"
          data-testid="inbox-since-all"
          class="rounded px-1.5 py-0.5 text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          title="不限时间（看全部历史）"
          @click="setSinceInput('')"
        >
          不限
        </button>
        </div>
      </template>

      <!-- 邮件工具条（仅邮件）：时间窗 + 只看未读；两者都只是**只读过滤**，不改邮箱状态 -->
      <div v-else class="flex flex-wrap items-center gap-1 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <span class="text-xs text-gray-400 dark:text-gray-500">最近</span>
        <button
          v-for="d in EMAIL_DAY_OPTIONS"
          :key="d"
          type="button"
          data-testid="inbox-email-days"
          class="rounded-full px-2 py-0.5 text-xs transition"
          :class="
            inbox.emailDays === d
              ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          "
          @click="setEmailDays(d)"
        >
          {{ d }} 天
        </button>
        <button
          type="button"
          data-testid="inbox-email-unread-only"
          class="ml-auto rounded-full px-2 py-0.5 text-xs transition"
          :class="
            inbox.emailUnreadOnly
              ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          "
          @click="setEmailUnreadOnly(!inbox.emailUnreadOnly)"
        >
          只看未读
        </button>
      </div>

      <!-- 失败提示：一行小字，不弹红字横幅 -->
      <div
        v-if="inbox.tab === 'notice' && inbox.error"
        data-testid="inbox-error"
        class="px-4 py-1 text-xs text-amber-600 dark:text-amber-400"
      >
        上次拉取失败：{{ inbox.error }}
      </div>

      <!-- 邮件失败：明确报错 + **重试按钮**（用户 2026-09-24 要求；连不上邮箱时不该只有一个转圈） -->
      <div
        v-if="inbox.tab === 'email' && inbox.emailError"
        data-testid="inbox-email-error"
        class="flex items-center gap-2 border-b border-gray-100 px-4 py-2 text-xs text-amber-600 dark:border-gray-800 dark:text-amber-400"
      >
        <span class="min-w-0 flex-1">{{ inbox.emailError }}</span>
        <button
          type="button"
          data-testid="inbox-email-retry"
          class="shrink-0 rounded border border-amber-300 px-2 py-0.5 transition hover:bg-amber-50 disabled:opacity-40 dark:border-amber-700 dark:hover:bg-amber-900/30"
          :disabled="inbox.emailLoading"
          @click="retryEmails()"
        >
          重试
        </button>
      </div>

      <!-- 列表 -->
      <div class="min-h-0 flex-1 overflow-y-auto">
        <!-- ── 通知（消息表）──────────────────────────────────────────── -->
        <template v-if="inbox.tab === 'notice'">
          <p v-if="!inbox.loaded && inbox.loading" class="p-6 text-center text-sm text-gray-400">正在加载…</p>
          <p
            v-else-if="inbox.loaded && !inbox.messages.length"
            data-testid="inbox-empty"
            class="p-8 text-center text-sm text-gray-400"
          >
            <template v-if="narrowWindow">
              这个时间之后没有消息<br />
              <span class="text-xs">（把上面时间往前调，或点「不限」）</span>
            </template>
            <template v-else>没有消息</template>
          </p>
          <ul v-else>
            <li
              v-for="m in inbox.messages"
              :key="m.id"
              data-testid="inbox-item"
              class="border-b border-gray-100 dark:border-gray-800"
            >
              <button type="button" class="flex w-full gap-2 px-4 py-3 text-left" @click="toggleDetail(m.id)">
                <span data-testid="inbox-lamp" class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="levelMeta(m.level).dot" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm" :class="m.read ? 'text-gray-500 dark:text-gray-400' : 'font-medium'">
                    {{ m.title }}
                  </span>
                  <span class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-gray-400 dark:text-gray-500">
                    <span data-testid="inbox-meta">
                      {{ categoryLabel(m.category) }} · {{ formatWhen(m.occurred_at) }} ·
                      <span :class="levelMeta(m.level).text">{{ levelMeta(m.level).label }}</span>
                    </span>
                    <span v-if="!m.read" class="rounded bg-gray-100 px-1 text-gray-500 dark:bg-gray-800 dark:text-gray-400">未读</span>
                  </span>
                  <span
                    v-if="inbox.expandedId !== m.id"
                    class="mt-1 line-clamp-2 block text-xs text-gray-500 dark:text-gray-400"
                  >
                    {{ m.excerpt }}
                  </span>
                </span>
              </button>

              <!-- 展开：全文（markdown）+ 动作 -->
              <div v-if="inbox.expandedId === m.id" data-testid="inbox-detail" class="px-4 pb-3">
                <p v-if="inbox.detailLoading" class="text-xs text-gray-400">正在加载全文…</p>
                <div
                  v-else-if="inbox.detail"
                  data-testid="inbox-detail-body"
                  class="md-body text-sm leading-relaxed"
                  v-html="renderedBody"
                />
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="inbox-ask"
                    class="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    @click="emit('ask', m)"
                  >
                    就这条问 agent
                  </button>
                  <button
                    v-if="!m.read"
                    type="button"
                    data-testid="inbox-mark-read"
                    class="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    @click="setRead(m.id, true)"
                  >
                    标记已读
                  </button>
                  <button
                    v-else
                    type="button"
                    data-testid="inbox-mark-unread"
                    class="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    @click="setRead(m.id, false)"
                  >
                    标为未读
                  </button>
                  <button
                    type="button"
                    data-testid="inbox-archive"
                    class="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    @click="archive(m.id)"
                  >
                    归档
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </template>

        <!-- ── 邮件（实时读邮箱，不落库；只读）──────────────────────────── -->
        <template v-else>
          <p
            v-if="inbox.emailLoading && !inbox.emails.length"
            data-testid="inbox-email-loading"
            class="p-6 text-center text-sm text-gray-400"
          >
            正在读取邮箱…
          </p>
          <p
            v-else-if="inbox.emailLoaded && !inbox.emails.length"
            data-testid="inbox-email-empty"
            class="p-8 text-center text-sm text-gray-400"
          >
            {{ inbox.emailUnreadOnly ? '这段时间没有未读邮件' : '这段时间没有邮件' }}
          </p>
          <ul v-else>
            <li
              v-for="m in inbox.emails"
              :key="m.uid"
              data-testid="inbox-email-item"
              class="border-b border-gray-100 dark:border-gray-800"
            >
              <button type="button" class="flex w-full flex-col gap-0.5 px-4 py-3 text-left" @click="toggleEmailDetail(m.uid)">
                <span class="flex items-baseline gap-2">
                  <span data-testid="inbox-email-from" class="min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400">
                    {{ emailFrom(m) }}
                  </span>
                  <span class="shrink-0 text-xs text-gray-400 dark:text-gray-500">{{ formatWhen(m.occurred_at) }}</span>
                </span>
                <span class="truncate text-sm" :class="m.unread ? 'font-medium' : 'text-gray-600 dark:text-gray-300'">
                  {{ m.subject }}
                </span>
                <span
                  v-if="inbox.emailExpandedUid !== m.uid"
                  class="line-clamp-2 text-xs text-gray-500 dark:text-gray-400"
                >
                  {{ m.excerpt }}
                </span>
              </button>

              <!-- 展开：全文（markdown）+ 提示（没有已读/归档动作：不碰邮箱状态） -->
              <div v-if="inbox.emailExpandedUid === m.uid" data-testid="inbox-email-detail" class="px-4 pb-3">
                <p v-if="inbox.emailDetailLoading" class="text-xs text-gray-400">正在加载全文…</p>
                <template v-else-if="inbox.emailDetail">
                  <p class="mb-1 text-xs text-gray-400 dark:text-gray-500">
                    收件人 {{ inbox.emailDetail.to_addr }} · {{ inbox.emailDetail.body_len }} 字<template
                      v-if="inbox.emailDetail.attachment_count"
                    >
                      · {{ inbox.emailDetail.attachment_count }} 个附件（暂不支持查看）</template
                    >
                  </p>
                  <div
                    data-testid="inbox-email-detail-body"
                    class="md-body text-sm leading-relaxed"
                    v-html="renderedEmailBody"
                  />
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="inbox-email-ask"
                      class="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      @click="emit('ask-email', m)"
                    >
                      就这封问 agent
                    </button>
                  </div>
                </template>
              </div>
            </li>
          </ul>
        </template>
      </div>

      <!-- 页脚：只留「上次更新」（一键已读已挪到头部，不做重复功能）；两个 tab 各自记自己的时刻 -->
      <div class="flex items-center justify-between border-t border-gray-200 px-4 py-2 text-xs text-gray-400 dark:border-gray-800">
        <span data-testid="inbox-footer-clock">{{ inbox.tab === 'email' ? emailFooterClock : footerClock }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/**
 * 「立即刷新」图标转一圈（用户 2026-09-23 要求：无新增消息时也要看得出按钮生效了）。
 *
 * 用自己的 keyframes 而不是 Tailwind 的 `animate-spin`：后者是 **1s/圈、无限循环**，
 * 短请求下只转小半圈（看不出"转了一圈"）、还得额外管"何时停"。这里要的是**恰好一圈**。
 * 时长与组件里的 `SPIN_MS` 对齐（600ms）。
 */
.refresh-spin {
  animation: inbox-refresh-spin 600ms linear;
}
@keyframes inbox-refresh-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
