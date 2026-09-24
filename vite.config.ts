import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'
import type { ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 开发环境：把 /api 与 /v1 代理到 Hermes API Server，并在**代理层**注入 Authorization。
 *
 * 为什么必须在代理层注入：
 *   API_SERVER_KEY 一旦写进前端代码或 .env.local，就会被编译进浏览器产物，F12 即可见。
 *   生产环境由 nginx 做同一件事（见 nginx.conf）；前端代码里始终不存在 key。
 *
 * 用法（key 只存在于进程环境变量）：
 *   set -a && . /opt/data/.env && set +a
 *   node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173
 */
const API_TARGET = process.env.HERMES_API_DEV_URL || 'http://127.0.0.1:8642'
// Hermes 容器里的变量名是 API_SERVER_KEY（HERMES_API_SERVER_KEY 只是历史别名）
const API_KEY = process.env.API_SERVER_KEY || process.env.HERMES_API_SERVER_KEY || ''

/**
 * 构建标识（**自动生成，不要手工维护**）：界面角落里显示它，用来回答
 * "手机上现在到底是哪一版" —— 踩过坑：手机缓存了旧入口 HTML，只能靠猜
 *（见 docs 坑 46）。
 *
 * 取值顺序：`BUILD_ID` 环境变量（给 CI/部署流程留的口子，可选）→ 有 `.git` 时
 * "短 sha · 构建时刻" → 没 `.git`（Docker 镜像里只 COPY 部分文件）时只有时刻。
 * 时刻按北京时间格式化，方便和日志/部署时间对照。
 */
function makeBuildId(): { full: string; short: string } {
  // 北京时间（和日志/部署时间对照方便）
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(/\//g, '-')
  const compactStamp = stamp.slice(5) // 去掉年份：09-13 19:55（头部空间小）
  let sha = ''
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    /* 没有 .git（镜像构建）→ 只用时刻 */
  }
  return {
    // 完整形态（设置面板/空态用）：461d034 · 2026-09-13 19:55
    full: sha ? `${sha} · ${stamp}` : stamp,
    // 紧凑形态（顶栏用，手机上不挤）：461d034 或 09-13 19:55
    short: sha || compactStamp,
  }
}

const BUILD = process.env.BUILD_ID
  ? { full: process.env.BUILD_ID, short: process.env.BUILD_ID }
  : makeBuildId()

export default defineConfig(({ command }) => {
  if (command === 'serve' && !API_KEY) {
    console.warn(
      '[vite] 未检测到 API_SERVER_KEY —— /api 反代不带鉴权头，请求会 401。\n' +
        '       启动：set -a && . /opt/data/.env && set +a && node node_modules/vite/bin/vite.js',
    )
  }

  const upstream: ProxyOptions = {
    target: API_TARGET,
    changeOrigin: true,
    headers: {
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      // 关键：SSE 要逐块转发，不能让链路做压缩/缓冲
      'Accept-Encoding': 'identity',
    },
    // 关键：必须剥掉 Origin。Hermes API Server 的 CORS 中间件对任何带 Origin 的请求
    // 直接返回 403（防 CSRF），而浏览器所有 POST 都会带 Origin —— 不剥掉的话
    // dev 环境下真机浏览器同样会挂（curl 测试看不出来）。
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
      })
    },
  }

  /**
   * 消息中心（inbox）在 dev 也要连得上：生产由 nginx 在反代层注入 `X-Inbox-Token`
   * （见 nginx.conf），dev 这里用**同一姿势**注入 —— 前端产物里始终没有密钥。
   *
   * 目标默认 `http://127.0.0.1:8080`（容器里 chatlite-inbox 的端口），可用 `INBOX_DEV_URL`
   * 覆盖（比如本地用 uvicorn 起在别的端口时）。令牌与 /api 复用同一个 key（nginx 也是这么做的）。
   */
  const inboxProxy: ProxyOptions = {
    target: process.env.INBOX_DEV_URL || 'http://127.0.0.1:8080',
    changeOrigin: true,
    headers: {
      ...(API_KEY ? { 'X-Inbox-Token': API_KEY } : {}),
      'Accept-Encoding': 'identity',
    },
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
      })
    },
  }

  return {
    plugins: [vue()],
    // 界面角落显示的构建标识（`src/vite-env.d.ts` 里有声明）：
    // 重新部署后一眼就能确认"线上到底跑的是哪一版"，不用再靠猜
    define: {
      __BUILD_ID__: JSON.stringify(BUILD.full),
      __BUILD_SHORT__: JSON.stringify(BUILD.short),
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': upstream,
        '/v1': upstream,
        '/health': upstream,
        // 消息中心（inbox）：dev 也要能开抽屉，否则本地只能看 UI 壳
        '/inbox': inboxProxy,
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 600,
    },
    test: {
      environment: 'jsdom',
      // jsdom 默认 url 是 about:blank（不透明 origin），那种 origin 下 jsdom 根本不建
      // localStorage；给个真实 url 才会建。**但它还不够** —— 见 src/test-setup.ts：
      // vitest 里 globalThis.localStorage 已被 Node 22+ 内置的实验性实现占据，
      // 无 --localstorage-file 时值为 undefined，会遮蔽 jsdom 的那份。
      environmentOptions: { jsdom: { url: 'http://localhost/' } },
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.spec.ts'],
      restoreMocks: true,
    },
  }
})
