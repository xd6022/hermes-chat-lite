/**
 * 消息中心的本地设置 —— **只存浏览器**（与 `appearance.ts` 同款存法）。
 *
 * 为什么存本地而不是服务端（用户 2026-09-22 明确要"我自己改"）：
 *  - 改完**立刻生效、不用重新构建**；
 *  - **每设备独立**：手机想 1 小时一拉、PC 想 30 秒一拉，互不干涉；
 *  - 代价：换设备要重设一次 —— 这条是知道的，写在这里免得以后被当 bug。
 */
import { ref } from 'vue'
import { DEFAULT_POLL, normalizePoll, type PollSetting } from './inboxPoll'

const KEY = 'hcl.inboxPoll'

function read(): PollSetting {
  try {
    return normalizePoll(localStorage.getItem(KEY))
  } catch {
    return DEFAULT_POLL // 隐私模式：不持久化，用默认值
  }
}

/** 当前轮询档位（响应式：Settings 里改完，轮询器立刻按新档位重排） */
export const pollSetting = ref<PollSetting>(read())

/** 改档位（接受任意字符串，认不出来的回默认档） */
export function setPollSetting(v: unknown): void {
  const next = normalizePoll(v)
  pollSetting.value = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* 隐私模式：内存里生效即可 */
  }
}
