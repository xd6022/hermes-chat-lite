<script setup lang="ts">
/**
 * 消息中心抽屉（v1，2026-09-22）。
 *
 * 形态：**复用 Settings 那套右侧抽屉**（PC 480px / 手机全屏、遮罩点击关闭、✕ 关闭），
 * 一份骨架两处用，观感一致、少写一套。
 *
 * 口径：
 *  - 列表只给**摘要**（服务端截的 200 字），点开某条才拉全文 —— 早盘简报正文 4k 字，
 *    50 条一起渲染会把抽屉拖慢；
 *  - 全文用**现成的 markdown 渲染器**（含 v2.1 修好的表格横向滚动 wrapper），
 *    所以行情表格不会把抽屉撑宽；
 *  - 等级灯：🔴要动手 / 🟡提示 / ⚪常规（左侧那颗圆点，颜色即级别）；
 *  - 动作：`就这条问 agent` / `标记已读` / `归档`；归档是"处理完了"，顺带已读；
 *  - 失败**不弹红字**：只在筛选行下面留一行小字「上次拉取失败 …」，界面照常可用。
 */
import { computed, ref } from 'vue'
import { renderMarkdown } from '../lib/markdown'
import { CATEGORY_FILTERS, categoryLabel, formatClock, formatWhen, levelMeta } from '../lib/inboxMeta'
import { pollSetting } from '../lib/inboxSettings'
import { isPolling, pollMs } from '../lib/inboxPoll'
import { archive, inbox, refreshNow, readAll, setFilter, setRead, toggleDetail } from '../stores/inbox'
import type { InboxMessage } from '../api/inbox'

const emit = defineEmits<{ (e: 'close'): void; (e: 'ask', msg: InboxMessage): void }>()

const refreshing = ref(false)

const renderedBody = computed(() => (inbox.detail ? renderMarkdown(inbox.detail.body || '') : ''))

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
  refreshing.value = true
  await refreshNow()
  refreshing.value = false
}
</script>

<template>
  <div data-testid="inbox-drawer" class="fixed inset-0 z-40 bg-black/20 dark:bg-black/50" @click.self="emit('close')">
    <div
      class="absolute right-0 top-0 flex h-full w-full flex-col border-l border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-900 sm:w-[480px]"
    >
      <!-- 头部：标题 + 未读 + 一键已读 + 刷新 + 关闭 -->
      <div class="flex items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <span class="text-sm font-semibold">消息</span>
        <span v-if="inbox.unread > 0" data-testid="inbox-drawer-unread" class="text-xs text-red-500">
          {{ inbox.unread }} 条未读
        </span>
        <span v-else class="text-xs text-gray-400 dark:text-gray-500">全部已读</span>
        <!-- ★ 一键已读放在头部（原来在最底部右下角一行小灰字 ⇒ 用户找不到就等于没有，2026-09-22 反馈）
             语义是**全部**：不带当前筛选（只清一部分会让徽标停在非 0，看着像"点了没用"） -->
        <button
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
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
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

      <!-- 筛选 -->
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

      <!-- 失败提示：一行小字，不弹红字横幅 -->
      <div v-if="inbox.error" data-testid="inbox-error" class="px-4 py-1 text-xs text-amber-600 dark:text-amber-400">
        上次拉取失败：{{ inbox.error }}
      </div>

      <!-- 列表 -->
      <div class="min-h-0 flex-1 overflow-y-auto">
        <p v-if="!inbox.loaded && inbox.loading" class="p-6 text-center text-sm text-gray-400">正在加载…</p>
        <p v-else-if="inbox.loaded && !inbox.messages.length" data-testid="inbox-empty" class="p-8 text-center text-sm text-gray-400">
          没有消息
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
      </div>

      <!-- 页脚：只留「上次更新」（一键已读已挪到头部，不做重复功能） -->
      <div class="flex items-center justify-between border-t border-gray-200 px-4 py-2 text-xs text-gray-400 dark:border-gray-800">
        <span data-testid="inbox-footer-clock">{{ footerClock }}</span>
      </div>
    </div>
  </div>
</template>
