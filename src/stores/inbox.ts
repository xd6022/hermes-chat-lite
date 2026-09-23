/**
 * 消息中心的 store（v1）。
 *
 * 口径（用户 2026-09-22 拍板）：
 *  - 列表只显示**摘要**（服务端给的 200 字 `excerpt`），点开某条才拉全文；
 *  - **未读态在服务端**（`read_at`）⇒ 多标签、多设备天然一致；轮询档位在浏览器（每设备独立）；
 *  - `关闭` 档 = 完全不自动拉取：开抽屉/点图标也不拉，只有「立即刷新」拉；
 *  - 轮询**首轮只建基线**：刷新页面时客户端未读是 0，不能把服务端原有未读当成"新消息"弹提示
 *    （用户 2026-09-23 要求：刷新页面时不要弹窗提醒未读数量）；
 *  - 失败不弹红字、不打断：只在抽屉里留一行「上次拉取失败 …」，并按 `nextDelayMs` 退避
 *    （连续失败 ×2 放大，30 分钟封顶）；
 *  - 页面在后台时**不拉**（复用 `page-lifecycle` 的判定），回到前台立刻拉一次。
 *
 * 不做的事：不做消息删除（只有归档）、不在前端存未读态、不做服务端推送（低频消息用轮询就够）。
 */
import { reactive } from 'vue'
import {
  archiveMessage,
  getMessage,
  getUnreadCount,
  listMessages,
  markAllRead,
  markRead,
  type InboxMessage,
  type InboxMessageDetail,
} from '../api/inbox'
import { isForeground, watchForeground } from '../lib/page-lifecycle'
import { isPolling, nextDelayMs } from '../lib/inboxPoll'
import { pollSetting } from '../lib/inboxSettings'
import { defaultSinceInput, toApiSince } from '../lib/inboxSince'

export const inbox = reactive({
  /** 当前筛选（`all` = 全部） */
  filter: 'all',
  /**
   * 起始时间（界面上那个 `datetime-local` 的值，本地墙钟）。
   *
   * 默认 = **当天 00:00**；**只在内存里**（刷新页面即还原默认）—— 用户 2026-09-22 明确
   * "不用保存，刷新还原"。空串 = 不限。
   */
  sinceInput: defaultSinceInput(),
  messages: [] as InboxMessage[],
  unread: 0,
  /** 首次加载完成（用于区分"空态"与"还没加载"） */
  loaded: false,
  loading: false,
  /** 上次拉取失败的原因（空串 = 最近一次是成功的）；只在抽屉里显示，不弹横幅 */
  error: '',
  /** 上次成功拉取的时刻（本地毫秒；页脚显示 HH:MM:SS） */
  lastOkAt: 0,
  /** 连续失败次数（驱动退避） */
  failures: 0,
  /** 最近一次轮询发现的新消息条数（App 用它弹轻提示，弹完清零） */
  newCount: 0,
  /** 展开的那条（同时只展开一条：屏小、状态简单） */
  expandedId: null as number | null,
  detail: null as InboxMessageDetail | null,
  detailLoading: false,
})

let timer: ReturnType<typeof setTimeout> | null = null
let unwatch: (() => void) | null = null

/**
 * 本会话里被用户**手动标为未读**的消息 id。
 *
 * 用途：加了"展开即已读"（2026-09-22 用户要求）之后，若用户刚把某条标成未读当备忘，
 * 再展开一下又会被自动吃掉 ⇒ 这里记着，**不再自动已读**（显式动作优先于自动行为）。
 * 只活在内存里：刷新即清空。
 */
const unreadExempt = new Set<number>()

/**
 * 是否已经建立「未读基线」—— 本页面生命周期内**第一次成功拿到未读数**。
 *
 * 为什么需要：页面刚打开时 `inbox.unread` 是 0，服务端有几个未读就被当成"新增了几个"
 * ⇒ 刷新一次就弹一句「消息中心有 N 条新消息」（那 N 条其实早就存在、徽标已经在显示）。
 * 所以**首轮只建基线、不报增量**（用户 2026-09-23 要求：刷新页面时不要弹窗提醒未读数量）。
 * 之后（同一个页面会话内）未读再变多才是真·新消息，照旧弹提示。
 */
let hasBaseline = false

/** 测试/切档位用：清空状态 */
export function resetInbox(): void {
  inbox.filter = 'all'
  inbox.sinceInput = defaultSinceInput()
  inbox.messages = []
  inbox.unread = 0
  inbox.loaded = false
  inbox.loading = false
  inbox.error = ''
  inbox.lastOkAt = 0
  inbox.failures = 0
  inbox.newCount = 0
  inbox.expandedId = null
  inbox.detail = null
  inbox.detailLoading = false
  unreadExempt.clear()
  hasBaseline = false
}

/** 当前起始时间对应的 API 参数（`null` = 不限） */
function apiSince(): string | null {
  return toApiSince(inbox.sinceInput)
}

/**
 * 改起始时间：**立刻重拉**（否则改了没反应，看着像坏了）。
 * 值只留在内存里 —— 刷新页面就回到"当天 0 点"（用户要的就是这个，别顺手写 localStorage）。
 */
export async function setSinceInput(value: string): Promise<void> {
  inbox.sinceInput = value ?? ''
  inbox.expandedId = null
  inbox.detail = null
  await loadInbox()
}

/** 复位成"当天 0 点"（默认值） */
export async function resetSince(): Promise<void> {
  await setSinceInput(defaultSinceInput())
}

function onFail(e: unknown): void {
  inbox.failures += 1
  inbox.error = e instanceof Error ? e.message : String(e)
}

function onOk(): void {
  inbox.error = ''
  inbox.failures = 0
  inbox.lastOkAt = Date.now()
}

/** 拉一屏列表（按当前筛选）+ 未读数 */
export async function loadInbox(): Promise<void> {
  if (inbox.loading) return
  inbox.loading = true
  try {
    const res = await listMessages({ category: inbox.filter, since: apiSince() })
    inbox.messages = res.messages
    inbox.unread = res.unread_count
    inbox.loaded = true
    hasBaseline = true
    onOk()
  } catch (e) {
    onFail(e)
  } finally {
    inbox.loading = false
  }
}

/**
 * 轮询一次：**只问未读数**（轻接口，省流量）。
 * 只有发现未读变多时才去拉列表 —— 否则每 5 分钟白拉 50 条消息。
 *
 * ★ 首轮（本页面打开后第一次拿到未读数）**只建基线**：刷新页面时客户端未读是 0，
 *   若按"变多"处理，服务端原有的未读会被全部算成新消息 ⇒ 每次刷新都弹一句提示。
 */
export async function pollInbox(): Promise<void> {
  try {
    const res = await getUnreadCount(apiSince())
    if (!hasBaseline) {
      // 只记基线：不拉列表、不写 newCount（=> App 不弹轻提示），徽标照常显示这个数
      inbox.unread = res.unread_count
      hasBaseline = true
    } else if (res.unread_count > inbox.unread) {
      const diff = res.unread_count - inbox.unread
      await loadInbox()
      inbox.newCount = diff
    } else {
      inbox.unread = res.unread_count
    }
    onOk()
  } catch (e) {
    onFail(e)
  }
}

/** 手动「立即刷新」：不管档位（`关闭` 档也能用），把列表和未读一起拉 */
export async function refreshNow(): Promise<void> {
  await loadInbox()
}

/** 打开抽屉时的动作：非 `关闭` 档才自动拉（`关闭` 档只显示手上已有的数据） */
export async function onDrawerOpen(): Promise<void> {
  if (isPolling(pollSetting.value)) await loadInbox()
}

export function clearNewCount(): void {
  inbox.newCount = 0
}

/** 改筛选并重拉（`all` 传 'all'） */
export async function setFilter(category: string): Promise<void> {
  if (inbox.filter === category) return
  inbox.filter = category
  inbox.expandedId = null
  inbox.detail = null
  await loadInbox()
}

/** 展开/收起某条；展开时按需拉全文（同一条再点就是收起，不重复请求） */
export async function toggleDetail(id: number): Promise<void> {
  if (inbox.expandedId === id) {
    inbox.expandedId = null
    inbox.detail = null
    return
  }
  inbox.expandedId = id
  inbox.detail = null
  inbox.detailLoading = true
  try {
    const detail = await getMessage(id)
    inbox.detail = detail
    // ★ 展开即已读（2026-09-22 用户要求）：真去看了就算处理过。
    //   例外：本会话里被**手动标为未读**的不动（显式动作优先，别把"待办标记"吃掉）。
    if (!detail.read && !unreadExempt.has(id)) void setRead(id, true)
  } catch (e) {
    onFail(e)
    inbox.expandedId = null
  } finally {
    inbox.detailLoading = false
  }
}

/** 标记已读（`read=false` 可撤回） */
export async function setRead(id: number, read = true): Promise<void> {
  // 手动标未读 ⇒ 记进"豁免名单"，之后展开也不会被自动已读吃掉
  if (read) unreadExempt.delete(id)
  else unreadExempt.add(id)
  try {
    const res = await markRead(id, read)
    inbox.unread = res.unread_count
    const hit = inbox.messages.find((m) => m.id === id)
    if (hit) hit.read = read
    if (inbox.detail?.id === id) inbox.detail.read = read
  } catch (e) {
    onFail(e)
  }
}

/** 全部已读。
 *
 * ⚠️ **不带筛选**（口径 2026-09-22 用户反馈后定）：这个按钮的标签就是"全部"，
 * 若按当前筛选只清一部分，徽标会停在非 0（比如筛「邮件」时点它，剩股票类未读），
 * 用户看到的现象就是"点了没用"。要按类型清就走接口的 category 参数，界面不再暴露。
 */
export async function readAll(): Promise<void> {
  try {
    const res = await markAllRead()
    inbox.unread = res.unread_count
    for (const m of inbox.messages) m.read = true
    if (inbox.detail) inbox.detail.read = true
  } catch (e) {
    onFail(e)
  }
}

/** 归档（= 处理完了，顺带已读）；归档后从当前列表里移掉 */
export async function archive(id: number): Promise<void> {
  try {
    const res = await archiveMessage(id, true)
    inbox.unread = res.unread_count
    inbox.messages = inbox.messages.filter((m) => m.id !== id)
    if (inbox.expandedId === id) {
      inbox.expandedId = null
      inbox.detail = null
    }
  } catch (e) {
    onFail(e)
  }
}

/** 排下一次拉取（`关闭` 档不排 → 定时器自然为空） */
function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const delay = nextDelayMs(pollSetting.value, inbox.failures)
  if (delay <= 0) return
  timer = setTimeout(async () => {
    // 后台不拉（定时器在后台本来也会被 throttle，这里再判一次更省电）
    if (isForeground()) await pollInbox()
    schedule()
  }, delay)
}

/**
 * 启动轮询（App 挂载时调一次）。重复调用是安全的（先停再起）。
 * 回到前台立刻拉一次 —— 手机切出去再回来，"上次看过的"已经过期了。
 */
export function startPolling(): void {
  stopPolling()
  unwatch = watchForeground(() => {
    if (isPolling(pollSetting.value)) void pollInbox()
  })
  schedule()
}

export function stopPolling(): void {
  if (timer) clearTimeout(timer)
  timer = null
  unwatch?.()
  unwatch = null
}

/** 档位改了要**按新档位重排**（改完立刻生效，不用重建、不用刷新） */
export function reschedulePolling(): void {
  if (timer) clearTimeout(timer)
  timer = null
  schedule()
}
