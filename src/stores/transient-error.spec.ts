/**
 * 过时错误横幅 / 假报错（v2.2 修补）。
 *
 * 起因（真机实测）：手机切后台再回来，恢复逻辑把回复补出来了，**顶部却挂着一条红色
 * 横幅 "Failed to fetch" + 重试** —— 那是回前台瞬间网络还在恢复、某个请求以网络错误
 * 失败留下的痕迹，之后连接明明已经好了，横幅却没人清。
 *
 * 两条规则：
 *   ① 网络类错误要翻成人话（用户看不懂 "Failed to fetch"，四家浏览器措辞还各不相同）
 *   ② 任意一次成功请求 = 连接已恢复 → 清掉**过时的网络类**横幅；
 *      但服务端明确返回的错误（HermesApiError，如"会话不存在"）**不许清**
 *      —— 那会重蹈早期"错误静默"的覆辙。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChatModule from './chat'

const SID = 's_err'
let mode: 'ok' | 'network' | 'safari' | '404' = 'ok'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/health') return json({ status: 'ok', version: '0.20.4' })
      if (url.startsWith('/api/sessions?')) {
        if (mode === 'network') throw new TypeError('Failed to fetch')
        if (mode === 'safari') throw new TypeError('Load failed')
        if (mode === '404') return json({ error: { message: 'not found' } }, 404)
        return json({ object: 'list', data: [], limit: 200, offset: 0, has_more: false })
      }
      if (url === `/api/sessions/${SID}/messages`) {
        return json({ object: 'list', session_id: SID, data: [], pagination: { returned: 0 } })
      }
      if (url === `/api/sessions/${SID}`) {
        return json({ object: 'hermes.session', session: { id: SID, input_tokens: 0, cache_read_tokens: 0 } })
      }
      throw new Error(`未预期的请求: ${url}`)
    }),
  )
}

async function fresh(): Promise<typeof ChatModule> {
  vi.resetModules()
  return (await import('./chat')) as typeof ChatModule
}

beforeEach(() => {
  mode = 'ok'
  stubFetch()
})

describe('msgOf：把人看不懂的浏览器网络原话翻成中文', () => {
  it('Chrome / Safari / Firefox / undici 四种措辞都认', async () => {
    const { msgOf } = await fresh()
    for (const m of [
      'Failed to fetch',
      'Load failed',
      'NetworkError when attempting to fetch resource.',
      'fetch failed',
    ]) {
      expect(msgOf(new TypeError(m))).toContain('网络请求没有发出去')
    }
  })

  it('普通 TypeError 不许被误报成网络问题（否则更难查）', async () => {
    const { msgOf } = await fresh()
    expect(msgOf(new TypeError('x.foo is not a function'))).toBe('x.foo is not a function')
    expect(msgOf(new Error('boom'))).toBe('boom')
  })
})

describe('横幅：过时的网络类错误会被"下一次成功请求"清掉', () => {
  it('网络失败 → 横幅出现（中文）；随后成功 → 横幅消失', async () => {
    const mod = await fresh()

    mode = 'network'
    await mod.loadSessions()
    expect(mod.store.bootError).toContain('网络请求没有发出去')

    mode = 'ok'
    await mod.loadSessions()
    expect(mod.store.bootError).toBeNull()
  })

  it('Safari 的 "Load failed" 同样被认成网络抖动并清掉', async () => {
    const mod = await fresh()
    mode = 'safari'
    await mod.loadSessions()
    expect(mod.store.bootError).toContain('网络请求没有发出去')

    mode = 'ok'
    await mod.loadSessions()
    expect(mod.store.bootError).toBeNull()
  })

  it('★ 服务端明确报的错（会话不存在）不会被后续成功请求"洗掉"', async () => {
    const mod = await fresh()
    mode = '404'
    await mod.loadSessions()
    expect(mod.store.bootError).toContain('会话不存在')

    mode = 'ok'
    await mod.loadSessions()
    expect(mod.store.bootError).toContain('会话不存在') // 真实问题必须留着
  })

  it('用户主动重试 / 开始新一轮 / 切会话 → 无条件清横幅', async () => {
    const mod = await fresh()
    mode = '404'
    await mod.loadSessions()
    expect(mod.store.bootError).not.toBeNull()

    mod.clearBootError()
    expect(mod.store.bootError).toBeNull()
  })

  it('健康检查成功也视为"连接已恢复"', async () => {
    const mod = await fresh()
    mode = 'network'
    await mod.loadSessions()
    expect(mod.store.bootError).not.toBeNull()

    await mod.checkHealth() // /health 正常
    expect(mod.store.bootError).toBeNull()
  })
})
