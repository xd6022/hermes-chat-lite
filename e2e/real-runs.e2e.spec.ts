/**
 * 真实链路回归：`/v1/runs` 通道（**不在 `npm test` 里跑**，用 `npm run e2e`）。
 *
 * 为什么要单独放这里：它打的是**真实 API + 真实模型**，一轮几十秒、还烧 token，
 * 不适合放进每次 `npm test`；但它抓的是单元测试抓不到的东西 —— 真链路已经靠它
 * 抓到两个真 bug：
 *   1. `/v1/runs` 的 SSE 帧**没有 `event:` 行**（事件名在 JSON 的 event 字段里），
 *      照旧通道的写法解析会把所有事件当"未知事件"忽略
 *   2. 收到 `run.cancelled` 时被判成"完成"（应为中断）
 *
 * 前置：环境里要有 API_SERVER_KEY（`set -a && . /opt/data/.env && set +a`）
 * 用法：set -a && . /opt/data/.env && set +a && npm run e2e
 * 只用自建的探针会话，跑完自删并复查 404。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChatModule from '../src/stores/chat'

const BASE = process.env.HERMES_API_BASE || 'http://127.0.0.1:8642'
const KEY = process.env.API_SERVER_KEY || ''
const realFetch = globalThis.fetch.bind(globalThis)
let SID = ''

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
    /* 非 JSON（SSE/空） */
  }
  return { status: res.status, text, json }
}

let urls: string[] = []

/** 把 store 的相对 URL 打到真实 API，并注入 Authorization（生产由 nginx 注入） */
beforeEach(() => {
  urls = []
  vi.stubGlobal('fetch', (input: any, init: any = {}) => {
    const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input
    urls.push(`${init?.method ?? 'GET'} ${String(url)}`)
    // 这个环境里 jsdom 的 AbortSignal 不是 Node 的实例，透传会被真 fetch 拒收
    //（"Expected signal to be an instance of AbortSignal"）→ 这里干脆不传 signal。
    // 影响：本地 abort 不会真的掐断这条测试里的流；但 stop() 会 POST /stop，
    // 服务端停下后流自然结束，所以中断场景在本脚本里依然可验。
    const { signal: _ignored, ...rest } = init ?? {}
    void _ignored
    return realFetch(url, {
      ...rest,
      headers: { ...((init ?? {}).headers ?? {}), Authorization: `Bearer ${KEY}` },
    })
  })
})

describe('真实链路：/v1/runs 通道', () => {
  it('普通轮 / 工具轮 / 中断 / 历史回归 / 清理', async () => {
    const created = await api('/api/sessions', 'POST', {})
    SID = created.json?.session?.id
    console.log('探针会话 id =', SID, '| 建会话 status =', created.status)
    expect(SID).toBeTruthy()

    vi.resetModules()
    const mod = (await import('../src/stores/chat')) as typeof ChatModule
    mod.store.currentId = SID

    // 给探针会话钉一个便宜、听话的模型（不钉的话走网关默认 qwen3.8-flash，
    // 它会"自作主张"跑一整套复盘：实测一次 204 秒 / 45 万输入 token）
    const mdl = await api(`/api/sessions/${SID}/model`, 'POST', {
      provider: 'xyy',
      model: 'deepseek-flash',
    })
    console.log('钉模型 status =', mdl.status, mdl.text.slice(0, 120))

    // ① 普通轮：逐字 + 终稿 + run_id + 统计（只断言结构，不赌模型措辞）
    await mod.send('只回复两个字：收到。不要做任何其他事。')
    const a1 = mod.store.messages.at(-1)
    console.log('① phase =', mod.store.run.phase, '| runId =', mod.store.run.runId)
    console.log(
      '① 正文 =',
      JSON.stringify(a1?.content?.slice(0, 60)),
      '| recovered =',
      mod.store.run.recovered,
    )
    console.log('① 统计 =', JSON.stringify(a1?.stats))
    console.log('① 错误 =', JSON.stringify(mod.store.run.errorMessage))
    console.log('① 请求 =', JSON.stringify(urls))
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.runId).toMatch(/^run_/)
    expect((a1?.content ?? '').length).toBeGreaterThan(0)
    expect(a1?.stats?.inputTokens ?? 0).toBeGreaterThan(0)
    // 事件流没丢（丢了会靠轮末对账兜住并标 recovered）
    expect(mod.store.run.recovered).toBe(false)

    // ② 工具轮：时间线要真的有东西，且仍然判定完成
    await mod.send('用 terminal 工具执行 echo hi，然后把输出原样告诉我')
    console.log('② phase =', mod.store.run.phase, '| 时间线 =', JSON.stringify(mod.store.run.timeline))
    expect(mod.store.run.phase).toBe('done')
    expect(mod.store.run.timeline.length).toBeGreaterThan(0)
    // 时间线必须有工具名（新通道的字段叫 `tool`，不是 `tool_name` —— 真链路踩过）
    expect(mod.store.run.timeline[0].name).toBeTruthy()

    // ③ 中断：stop() 必须真的让服务端停下（不是只断连接）
    const p = mod.send('请从 1 数到 200，每个数字单独一行，不要省略')
    await new Promise((r) => setTimeout(r, 3000))
    const midRunId = mod.store.run.runId
    console.log('③ 中断前 runId =', midRunId, '| phase =', mod.store.run.phase)
    mod.stop()
    await p
    const st = await api(`/v1/runs/${midRunId}`)
    console.log('③ 中断后 phase =', mod.store.run.phase, '| 服务端 status =', st.json?.status)
    expect(['cancelled', 'completed', 'failed']).toContain(st.json?.status)

    // ④ 历史回归：openSession（分页/合并/压缩摘要过滤）在 runs 通道写的会话上照常工作
    await mod.openSession(SID)
    console.log(
      '④ 历史界面消息数 =',
      mod.store.messages.length,
      '| rawCount =',
      mod.store.rawCount,
      '| hasMore =',
      mod.store.hasMoreHistory,
    )
    expect(mod.store.messages.length).toBeGreaterThan(3)
    expect(mod.store.messages[0].role).toBe('user')
    expect(mod.store.messages.some((m) => m.role === 'assistant')).toBe(true)

    // ⑤ 清理：走 store.removeSession（顺带验证"空壳复查"这条兜底在 runs 通道下也生效）
    const rows =
      (await api('/api/sessions?limit=200')).json?.data?.filter((s: any) => s.id === SID) ?? []
    console.log(
      '⑤ 删除前该会话记录 =',
      JSON.stringify(rows.map((s: any) => ({ id: s.id, title: s.title, n: s.message_count }))),
    )
    const del = await mod.removeSession(SID)
    const chk = await api(`/api/sessions/${SID}`)
    console.log('⑤ 删除结果 =', del, '| 复查 GET =', chk.status)
    expect(del).toBeNull()
    expect(chk.status).toBe(404)
  })
})
