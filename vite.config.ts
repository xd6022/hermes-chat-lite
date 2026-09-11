import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 开发环境：把 /api 与 /v1 代理到 Hermes API Server，并在**代理层**注入 Authorization。
 *
 * 为什么必须在代理层注入：
 *   API_SERVER_KEY 一旦写进前端代码或 .env.local，就会被编译进浏览器产物，F12 即可见。
 *   生产环境由 nginx 做同一件事（见 nginx.conf）；前端代码里始终不存在 key。
 *
 * 用法（key 只存在于进程环境变量）：
 *   HERMES_API_SERVER_KEY=<key> npm run dev
 * 或从宿主机的 hermes .env 里 source 出来再跑。
 */
const API_TARGET = process.env.HERMES_API_DEV_URL || 'http://127.0.0.1:8642'
const API_KEY = process.env.HERMES_API_SERVER_KEY || ''

const upstream = {
  target: API_TARGET,
  changeOrigin: true,
  // 关键：SSE 不能被缓冲，http-proxy 默认逐块转发，这里额外声明禁用压缩
  headers: {
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    'Accept-Encoding': 'identity',
  },
}

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': upstream,
      '/v1': upstream,
      '/health': upstream,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
})
