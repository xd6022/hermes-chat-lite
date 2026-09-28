<script setup lang="ts">
/**
 * 邮件抽屉（v3.3，2026-09-28）—— 顶栏邮件图标点开。
 *
 * 形态：复用 Settings / 消息中心那套右侧抽屉（PC 480px / 手机全屏、遮罩点击关闭、✕ 关闭）。
 *
 * 与旧「邮件 tab」的区别（用户 2026-09-28 拍板）：
 *  - **读缓存**（`inbox_emails` 表）而不是每次实时连 IMAP ⇒ 打开瞬时、离线可读；
 *  - 只有点「刷新」才真连一次邮箱（服务端 `POST /inbox/email/refresh`，只读，不动邮箱已读状态）；
 *  - 档位 `1 / 3 / 7 天`，**默认 1 天**（原默认 3 天）；切档位只读缓存，不再连邮箱；
 *  - **只读**：没有已读/归档动作；未读不计入顶栏徽标；
 *  - 头部显示「上次拉取 HH:MM:SS」= 缓存新鲜度（定时任务每整点拉；点刷新立刻拉）。
 *
 * 失败**不弹红字横幅**：错误行 + 重试按钮（用户 09-24 明确要求过这一点）。
 */
import { computed, onMounted, ref } from 'vue'
import { renderMarkdown } from '../lib/markdown'
import { formatClock, formatWhen } from '../lib/inboxMeta'
import {
  EMAIL_DAY_OPTIONS,
  email,
  loadEmails,
  refreshEmails,
  retryEmails,
  setEmailDays,
  toggleEmailDetail,
} from '../stores/email'
import type { CachedEmail } from '../api/inbox'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'ask-email', mail: CachedEmail): void
}>()

// 打开就保证有内容：还没读过缓存时才去读一次（App 那边开抽屉也会读，这里靠 loaded/loading 去重，不会双发）
onMounted(() => {
  if (!email.loaded && !email.loading) void loadEmails()
})

/** 「刷新」转圈：最短转满一圈（请求常常几十毫秒就回来，不给兜底就是"闪一下" = 没反馈） */
const SPIN_MS = 600
const spinning = ref(false)

async function doRefresh(): Promise<void> {
  if (spinning.value) return
  spinning.value = true
  const started = Date.now()
  try {
    await refreshEmails()
  } finally {
    const rest = SPIN_MS - (Date.now() - started)
    if (rest > 0) await new Promise((r) => setTimeout(r, rest))
    spinning.value = false
  }
}

const renderedDetail = computed(() => (email.detail ? renderMarkdown(email.detail.body || '') : ''))

/** 发件人：有名字就「名字 <地址>」，没有就只给地址 */
function emailFrom(m: CachedEmail): string {
  return m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr
}

/** 头部那句"上次拉取"：整张缓存表最近一次成功拉取的时刻 */
const fetchedText = computed(() => {
  if (!email.lastFetchedAt) return '还没拉过'
  const t = Date.parse(email.lastFetchedAt)
  return Number.isFinite(t) ? `上次拉取 ${formatClock(t)}` : ''
})

/** 空态文案：区分"缓存空"与"这段窗口没邮件" */
const emptyText = computed(() =>
  email.cachedTotal > 0
    ? `最近 ${email.days} 天没有邮件（缓存里共有 ${email.cachedTotal} 封，可切到 3/7 天看）`
    : '缓存里还没有邮件 —— 点右上角刷新拉一次',
)
</script>

<template>
  <div data-testid="email-drawer" class="fixed inset-0 z-40 bg-black/20 dark:bg-black/50" @click.self="emit('close')">
    <div
      class="absolute right-0 top-0 flex h-full w-full flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-900 sm:w-[480px]"
    >
      <!-- 头部：标题 + 上次拉取 + 刷新 + 关闭 -->
      <div class="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <span class="text-sm font-semibold">邮件</span>
        <span data-testid="email-fetched" class="text-[10px] text-gray-400 dark:text-gray-500">{{ fetchedText }}</span>
        <button
          type="button"
          data-testid="email-refresh"
          class="ml-auto rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          title="连一次邮箱并更新缓存（只读，不改邮箱已读状态）"
          :disabled="spinning"
          @click="doRefresh()"
        >
          <svg
            viewBox="0 0 24 24"
            class="h-4 w-4"
            :class="spinning ? 'email-refresh-spin' : ''"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M21 12a9 9 0 11-3-6.7M21 3v6h-6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          data-testid="email-close"
          class="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <!-- 档位：只切显示窗口，不连邮箱 -->
      <div class="flex items-center gap-1 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <span class="text-xs text-gray-400 dark:text-gray-500">最近</span>
        <button
          v-for="d in EMAIL_DAY_OPTIONS"
          :key="d"
          type="button"
          data-testid="email-days"
          class="rounded-full px-2.5 py-0.5 text-xs transition"
          :class="
            email.days === d
              ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
          "
          @click="setEmailDays(d)"
        >
          {{ d }} 天
        </button>
        <span class="ml-auto text-[10px] text-gray-400 dark:text-gray-500">只读，不改邮箱已读状态</span>
      </div>

      <!-- 失败：一行报错 + 重试 -->
      <div
        v-if="email.error"
        data-testid="email-error"
        class="flex items-center gap-2 border-b border-gray-100 px-4 py-2 text-xs text-amber-600 dark:border-gray-800 dark:text-amber-400"
      >
        <span class="min-w-0 flex-1">{{ email.error }}</span>
        <button
          type="button"
          data-testid="email-retry"
          class="shrink-0 rounded border border-amber-300 px-2 py-0.5 transition hover:bg-amber-50 disabled:opacity-40 dark:border-amber-700 dark:hover:bg-amber-900/30"
          :disabled="email.loading"
          @click="retryEmails()"
        >
          重试
        </button>
      </div>

      <!-- 列表 -->
      <div class="min-h-0 flex-1 overflow-y-auto">
        <p
          v-if="email.loading && !email.rows.length"
          data-testid="email-loading"
          class="p-6 text-center text-sm text-gray-400"
        >
          正在读取缓存…
        </p>
        <p
          v-else-if="email.loaded && !email.rows.length"
          data-testid="email-empty"
          class="p-8 text-center text-sm text-gray-400"
        >
          {{ emptyText }}
        </p>
        <ul v-else>
          <li
            v-for="m in email.rows"
            :key="m.id"
            data-testid="email-item"
            class="border-b border-gray-100 dark:border-gray-800"
          >
            <button type="button" class="flex w-full flex-col gap-0.5 px-4 py-3 text-left" @click="toggleEmailDetail(m.id)">
              <span class="flex items-baseline gap-2">
                <span data-testid="email-from" class="min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400">
                  {{ emailFrom(m) }}
                </span>
                <span class="shrink-0 text-xs text-gray-400 dark:text-gray-500">{{ formatWhen(m.occurred_at) }}</span>
              </span>
              <span class="truncate text-sm text-gray-600 dark:text-gray-300">{{ m.subject }}</span>
              <span
                v-if="email.expandedId !== m.id"
                class="line-clamp-2 text-xs text-gray-500 dark:text-gray-400"
              >
                {{ m.excerpt }}
              </span>
            </button>

            <!-- 展开：全文（markdown；正文是服务端去标签的纯文本，前端不注入邮件 HTML） -->
            <div v-if="email.expandedId === m.id" data-testid="email-detail" class="px-4 pb-3">
              <p v-if="email.detailLoading" class="text-xs text-gray-400">正在加载全文…</p>
              <template v-else-if="email.detail">
                <p class="mb-1 text-xs text-gray-400 dark:text-gray-500">
                  收件人 {{ email.detail.to_addr }} · {{ email.detail.body_len }} 字<template
                    v-if="email.detail.attachment_count"
                  >
                    · {{ email.detail.attachment_count }} 个附件（暂不支持查看）</template
                  >
                </p>
                <div data-testid="email-detail-body" class="md-body text-sm leading-relaxed" v-html="renderedDetail" />
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="email-ask"
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
      </div>

      <!-- 页脚：缓存来源说明（邮件是"打开看一眼"，不是待办） -->
      <div class="flex items-center justify-between border-t border-gray-200 px-4 py-2 text-xs text-gray-400 dark:border-gray-800">
        <span data-testid="email-footer">定时每整点拉一次 · 只读缓存</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/** 刷新图标转一圈（与消息中心的 600ms 对齐，见 InboxDrawer.vue 的同款注释） */
.email-refresh-spin {
  animation: email-refresh-spin 600ms linear;
}
@keyframes email-refresh-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
