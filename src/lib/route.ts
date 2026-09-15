/**
 * 地址即状态（v2.12）：把"当前打开哪个会话"放进地址栏。
 *
 * 为什么（用户 2026-09-15 拍板）：刷新页面时浏览器只记得地址，不记得我们内存里的
 * `store.currentId` —— 之前"刷新就回欢迎页"就是这么来的（远端设计里只有"在跑的那一轮"
 * 会被恢复）。地址承载会话 id 之后，刷新、书签、多标签、把链接发到手机打开全都自然成立，
 * 浏览器返回键也第一次有了正确语义。
 *
 * 地址形态（用户选定 hash，零 nginx 依赖）：
 *   `https://host/`            → 欢迎页（**裸域名，不带 `#`**：可以安全分享，永不"偷偷跳回上次会话"）
 *   `https://host/#/s/<id>`    → 该会话
 *   认不出来的 hash（含 `#/s/` 但 id 为空）→ 当作欢迎页
 *
 * 为什么手写而不引 vue-router：收益来自"状态在地址里"，不来自路由库；这里只有一个参数，
 * 手写 ~70 行纯函数就够，还能直接单测（引库反而多一层要跟着升级的依赖）。
 *
 * ⚠️ 关键实现点：`history.pushState/replaceState` **不会**触发 `hashchange`/`popstate`
 * ⇒ 我们自己发起的导航必须**主动分发**一次，否则"点侧栏 → 地址变了但视图没变"。
 */

export type Route = { kind: 'home' } | { kind: 'session'; id: string }

/** 会话 id 的形态：Hermes 里是 `api_1789467328_decb9504` / `20260915_172336_00ed5f` 这类，宽松点别误杀 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** 把地址里的 hash 解析成路由（纯函数，便于单测） */
export function parseRoute(hash: string): Route {
  const raw = (hash ?? '').replace(/^#/, '')
  if (!raw || raw === '/') return { kind: 'home' }
  const m = /^\/s\/([^/?#]*)\/?$/.exec(raw)
  if (m && m[1]) {
    // 地址里可能是 encode 过的（routeToUrl 用 encodeURIComponent）
    let id = m[1]
    try {
      id = decodeURIComponent(id)
    } catch {
      /* 坏转义就按原样用，后面那条正则会把非法 id 挡掉 */
    }
    if (SESSION_ID_RE.test(id)) return { kind: 'session', id }
  }
  // 认不出来（含 `#/s/` 后面空着、或别的路径）→ 欢迎页，别把坏地址当会话
  return { kind: 'home' }
}

/** 当前地址对应的路由 */
export function currentRoute(): Route {
  return parseRoute(window.location.hash)
}

/** 会话 id → 地址（纯函数；home 传 null） */
export function routeToUrl(id: string | null): string {
  return id ? `#/s/${encodeURIComponent(id)}` : ''
}

/**
 * 改地址并**分发**。
 *
 * - `push`（默认）：进历史一步 —— 用户点侧栏切换会话用这个，返回键才有东西可回。
 * - `replace`：不进历史 —— 程序自己纠正地址（无效 id、生成中撤回、自动跳转）用这个。
 *
 * 欢迎页（id = null）会把 `#` 整个去掉（`location.pathname + search`），
 * 不能只把 hash 设成空串：那会留下一个光秃秃的 `#`，地址栏看着不干净。
 */
export function navigate(id: string | null, opts: { mode?: 'push' | 'replace' } = {}): void {
  const mode = opts.mode ?? 'push'
  const hash = routeToUrl(id) // null → ''（欢迎页）
  const url = hash || window.location.pathname + window.location.search
  const next = parseRoute(hash)

  if (mode === 'replace') window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)

  // 自己发起的导航不会触发任何事件 ⇒ 手动分发（地址没变就不重复分发）
  if (!sameRoute(next, lastDispatched)) dispatch(next)
}

let lastDispatched: Route = { kind: 'home' }
const listeners = new Set<(r: Route) => void>()

function sameRoute(a: Route, b: Route): boolean {
  return a.kind === b.kind && (a.kind !== 'session' || b.kind !== 'session' || a.id === b.id)
}

/** 记录"刚刚分发过的路由"（用于去重：popstate 与 hashchange 可能为同一次变化各来一发） */
function dispatch(r: Route): void {
  lastDispatched = r
  for (const fn of [...listeners]) fn(r)
}

/**
 * 订阅地址变化（返回取消订阅的函数）。
 *
 * 两个事件都听：
 *  - `popstate`：前进/后退（返回键）
 *  - `hashchange`：用户手改地址栏、或点了带 hash 的链接
 * 去重靠 `lastDispatched`：同一次变化只分发一次。
 */
export function onRouteChange(cb: (r: Route) => void): () => void {
  listeners.add(cb)
  const onPop = (): void => {
    const r = currentRoute()
    if (!sameRoute(r, lastDispatched)) dispatch(r)
  }
  window.addEventListener('popstate', onPop)
  window.addEventListener('hashchange', onPop)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('popstate', onPop)
    window.removeEventListener('hashchange', onPop)
  }
}

/** 记下"启动时地址里的路由"，让之后第一次分发能正确去重（启动流程用） */
export function markInitialRoute(r: Route): void {
  lastDispatched = r
}
