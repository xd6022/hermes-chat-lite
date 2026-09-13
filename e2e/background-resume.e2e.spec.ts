/**
 * 真实链路回归：**浏览器进后台 / 连接断掉之后能不能恢复**（v2.2，`npm run e2e`）。
 *
 * 为什么必须真链路（单测与真浏览器用例都替代不了这一条）：
 *   单测里的"服务端"是桩，真浏览器用例里的也是桩 —— 而本功能的**全部前提**是
 *   "服务端那一轮不依赖客户端连接、自己会跑完并写进会话"。这句话只有打真 API 才算数。
 *   实测（docs §10.4）：无人订阅的 run 照跑照落库；客户端中途掐断连接后 run 依然
 *   completed；所以前端的责任只有"回来时同步"。
 *
 * 本用例做的事（模拟手机切后台）：
 *   ① 发一轮会跑十几秒的任务
 *   ② 2.5s 后**掐断事件流**（不调 /stop —— 那才是"用户取消"）
 *   ③ 断言界面进 `background`（"任务仍在后台执行"），**不是** `aborted`
 *   ④ 等服务端自己跑完 → 调 resumeSync()（等价于"用户回到前台"）
 *   ⑤ 断言界面补出正文、标完成、记录清掉；最后删掉探针会话
 *
 * 前置：环境里要有 API_SERVER_KEY（`set -a && . /opt/data/.env && set +a`）
 * 用法：`npm run e2e`（或 `npx vitest run -c e2e/vitest.config.ts`）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChatModule from '../src/stores/chat'

const BASE = process.env.HERMES_API_BASE || 'http://127.0.0.1:8642'
const KEY = process.env.API_SERVER_KEY || ''
const realFetch = globalThis.fetch.bind(globalThis)

let SID = ''
let eventsAbort: AbortController | null = null
let abortedAt = 0

async function api(path: string, method = 'GET', body?: unknown) {
  const res = await realFetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, text, json }
}

/** 把 store 的相对 URL 打到真 API 并注入鉴权（生产由 nginx 注入）；/events 可被掐断 */
beforeEach(() => {
  eventsAbort = null
  abortedAt = 0
  vi.stubGlobal('fetch', (input: any, init: any = {}) => {
    const raw = typeof input === 'string' && input.startsWith('/') ? BASE + input : input
    const url = String(raw)
    const { signal: _ignored, ...rest } = init ?? {}
    void _ignored
    const headers = { ...((init ?? {}).headers ?? {}), Authorization: `Bearer ${KEY}` }
    if (url.includes('/events')) {
      // 这一条流交给测试掐断（模拟浏览器进后台时系统把 SSE 连掉了）
      const ctl = new AbortController()
      eventsAbort = ctl
      return realFetch(url, { ...rest, headers, signal: ctl.signal })
    }
    return realFetch(url, { ...rest, headers })
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('真实链路：进后台（掐断事件流）→ 回前台自动恢复', () => {
  it('断流不取消任务；回前台把正文与服务端状态同步回来', async () => {
    const created = await api('/api/sessions', 'POST', {})
    SID = created.json?.session?.id
    expect(SID).toBeTruthy()
    const mdl = await api(`/api/sessions/${SID}/model`, 'POST', {
      provider: 'xyy',
      model: 'deepseek-flash',
    })
    console.log('探针会话 =', SID, '| 钉模型 status =', mdl.status)

    vi.resetModules()
    const mod = (await import('../src/stores/chat')) as typeof ChatModule
    mod.store.currentId = SID

    // ① 发一轮要跑十几秒的（sleep 12）任务
    const p = mod.send('只运行一条 shell 命令：sleep 12。不要做其它任何事，结束后只回复两个字：完成。')
    await vi.waitFor(() => expect(mod.store.run.runId).toBeTruthy(), { timeout: 20000 })
    const runId = mod.store.run.runId as string
    console.log('① run_id =', runId)

    // ② 2.5s 后掐断事件流（**不**调 stop：那才是用户取消）
    await sleep(2500)
    abortedAt = Date.now()
    eventsAbort?.abort()
    await p

    // ③ 关键断言：进后台 ≠ 中断
    console.log('② 断流后 phase =', mod.store.run.phase, '| 界面错误 =', mod.store.messages.at(-1)?.error)
    expect(mod.store.run.phase).toBe('background')
    expect(mod.store.messages.at(-1)?.error ?? null).toBeNull()

    // 记录必须落盘（刷新/被回收后靠它找回）
    const rec = JSON.parse(sessionStorage.getItem('hcl.activeRun') || 'null')
    expect(rec?.runId).toBe(runId)

    // ④ 等服务端自己跑完（**客户端全程没有再订阅**）
    let status = ''
    for (let i = 0; i < 40; i++) {
      const st = await api(`/v1/runs/${runId}`)
      status = st.json?.status
      if (['completed', 'failed', 'cancelled'].includes(status)) break
      await sleep(2000)
    }
    const elapsed = ((Date.now() - abortedAt) / 1000).toFixed(1)
    console.log(`③ 断流后服务端自己跑完：status=${status}（断流后 ${elapsed}s）`)
    expect(status).toBe('completed') // ← 这就是"任务独立于前端连接"的实锤

    // ⑤ 用户回到前台
    await mod.resumeSync()
    const last = mod.store.messages.at(-1)
    console.log('④ 回前台后 phase =', mod.store.run.phase, '| 正文 =', JSON.stringify(last?.content))
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.recovered).toBe(true)
    expect((last?.content ?? '').trim().length).toBeGreaterThan(0)
    expect(sessionStorage.getItem('hcl.activeRun')).toBeNull() // 记录已清

    // ⑥ 清理：按 id 删探针会话（硬删除，只删自己建的这一个）
    const del = await api(`/api/sessions/${SID}`, 'DELETE')
    const chk = await api(`/api/sessions/${SID}`)
    console.log('⑤ 清理：DELETE =', del.status, '| 复查 GET =', chk.status)
    expect(chk.status).toBe(404)
  })
})
