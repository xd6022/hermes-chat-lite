/**
 * 邮件缓存 store（v3.3，2026-09-28）—— 顶栏**独立邮件图标**用，与消息中心（`stores/inbox.ts`）完全分开。
 *
 * 口径（用户 2026-09-28 拍板）：
 *  - **页面只读缓存**（`inbox_emails` 表）：打开瞬时、离线可读、能翻历史；只有点「刷新」才会真连一次 IMAP；
 *  - **默认 1 天**（档位 1/3/7 保留）——"打开就是为了看刚到的通知"，7/30/90 那种太大（09-24 已收窄过一轮）；
 *  - 刷新时按**缓存窗口 7 天**拉（≥ 最大档位）⇒ 切档位只是读缓存，不会每次都连邮箱；
 *  - **只读**：没有已读/归档动作，绝不改邮箱状态；
 *  - 邮件未读**不计入顶栏徽标**（徽标只数通知）⇒ 邮件图标上不带数字，只在抽屉头部显示"上次拉取"。
 */
import { reactive } from 'vue'
import {
  getCachedEmail,
  listCachedEmails,
  refreshEmails as apiRefreshEmails,
  type CachedEmail,
  type CachedEmailDetail,
} from '../api/inbox'

/**
 * 显示档位（天）：`1` = 今天、`3` = 今天+前两天……**只此一份**，组件从这里 import
 * （两边各写一份数组会出现"按钮上没有 3 天、默认却是 3"这类看不见的错）。
 */
export const EMAIL_DAY_OPTIONS = [1, 3, 7] as const
/** 默认显示档位：**1 天**（2026-09-28 用户拍板；09-24 是 3 天） */
export const DEFAULT_EMAIL_DAYS = 1
/**
 * 刷新时一次拉多少天。**故意 ≥ 最大档位**：一次拉够，之后切档位只读缓存、不再连邮箱
 * （IMAP 只在"定时任务"和"点刷新"这两个时机被碰）。
 */
export const EMAIL_CACHE_DAYS = 7

export const email = reactive({
  /** 当前显示档位（天） */
  days: DEFAULT_EMAIL_DAYS as number,
  rows: [] as CachedEmail[],
  loaded: false,
  loading: false,
  /** 读缓存/刷新失败的原因（空串 = 最近一次成功） */
  error: '',
  /** 整张缓存表最近一次拉取时刻（ISO，空串 = 缓存还是空的） */
  lastFetchedAt: '',
  /** 缓存总行数（用于"缓存里有 N 封，但这段窗口内没有"这类提示） */
  cachedTotal: 0,
  /** 正在执行"刷新"（点了会真连 IMAP，给转圈反馈 + 防连点） */
  refreshing: false,
  /** 展开的那封（同时只展开一封） */
  expandedId: null as number | null,
  detail: null as CachedEmailDetail | null,
  detailLoading: false,
})

/** 测试用：清空 */
export function resetEmail(): void {
  email.days = DEFAULT_EMAIL_DAYS
  email.rows = []
  email.loaded = false
  email.loading = false
  email.error = ''
  email.lastFetchedAt = ''
  email.cachedTotal = 0
  email.refreshing = false
  email.expandedId = null
  email.detail = null
  email.detailLoading = false
}

function fmt(iso: string | null | undefined): string {
  return typeof iso === 'string' ? iso : ''
}

/** 读缓存（不连 IMAP）。失败**保留旧列表** + 记下原因（界面给重试按钮）。 */
export async function loadEmails(): Promise<void> {
  if (email.loading) return
  email.loading = true
  try {
    const res = await listCachedEmails({ days: email.days })
    email.rows = res.messages
    email.cachedTotal = res.cached_total
    email.lastFetchedAt = fmt(res.fetched_at)
    email.loaded = true
    email.error = ''
  } catch (e) {
    email.error = e instanceof Error ? e.message : String(e)
  } finally {
    email.loading = false
  }
}

/** 改档位：只重读缓存，**不连 IMAP**（刷新时已按 7 天拉够） */
export async function setEmailDays(days: number): Promise<void> {
  if (email.days === days) return
  email.days = days
  email.expandedId = null
  email.detail = null
  await loadEmails()
}

/**
 * 刷新：让服务端实时连一次 IMAP 并写缓存，然后重读。
 *
 * 这是**全项目唯一会碰邮箱的动作**（连同定时任务那条腿），只读、不改邮箱已读状态。
 * 失败时保留旧列表 + 报错（用户 09-24 明确要过：读邮箱失败必须能一键重试）。
 */
export async function refreshEmails(): Promise<void> {
  if (email.refreshing) return
  email.refreshing = true
  email.error = ''
  try {
    await apiRefreshEmails({ days: EMAIL_CACHE_DAYS })
  } catch (e) {
    email.error = e instanceof Error ? e.message : String(e)
  } finally {
    email.refreshing = false
  }
  await loadEmails()
}

/** 重试（错误行上的按钮）：先清错误再拉 */
export async function retryEmails(): Promise<void> {
  email.error = ''
  await loadEmails()
}

/** 展开/收起；展开时按 id 拉全文（同一封再点就是收起，不重复请求） */
export async function toggleEmailDetail(id: number): Promise<void> {
  if (email.expandedId === id) {
    email.expandedId = null
    email.detail = null
    return
  }
  email.expandedId = id
  email.detail = null
  email.detailLoading = true
  try {
    email.detail = await getCachedEmail(id)
    email.error = ''
  } catch (e) {
    email.error = e instanceof Error ? e.message : String(e)
    email.expandedId = null
  } finally {
    email.detailLoading = false
  }
}
