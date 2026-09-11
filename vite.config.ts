import { defineConfig } from 'vitest/config'
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

export default defineConfig(({ command }) => {
  if (command === 'serve' && !API_KEY) {
    console.warn(
      '[vite] 未检测到 API_SERVER_KEY —— /api 反代不带鉴权头，请求会 401。\n' +
        '       启动：set -a && . /opt/data/.env && set +a && node node_modules/vite/bin/vite.js',
    )
  }

  const upstream = {
    target: API_TARGET,
    changeOrigin: true,
    headers: {
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      // 关键：SSE 要逐块转发，不能让链路做压缩/缓冲
      'Accept-Encoding': 'identity',
    },
  }

  return {
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
      chunkSizeWarningLimit: 600,
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.spec.ts'],
      restoreMocks: true,
    },
  }
})
