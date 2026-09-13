import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 真实链路回归专用配置（`npm run e2e`）。
 *
 * 与根配置的差别只有三点，都是为了"打真 API、跑得久"：
 *  1. 只收 e2e/ 下的用例（`include` 不指向 src/，与 `npm test` 互不干扰）
 *  2. 单测超时放宽到 5 分钟（一轮真模型对话几十秒起步）
 *  3. 复用同一份 test-setup（localStorage 兜底）
 *
 * ⚠️ `root` 必须用绝对路径：写相对路径时 vitest 是按 **CWD** 解析的，
 *    从别的目录调用会指错（实测 `root: '..'` 被解析成 /opt/data）。
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  test: {
    root: projectRoot,
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: ['./src/test-setup.ts'],
    include: ['e2e/**/*.e2e.spec.ts'],
    testTimeout: 300000,
    hookTimeout: 60000,
    restoreMocks: true,
  },
})
