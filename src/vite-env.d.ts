/// <reference types="vite/client" />

/** 构建时由 vite.config.ts 注入的构建标识（构建时刻，带 .git 时还带短 sha） */
declare const __BUILD_ID__: string
/** 同上，紧凑形态（顶栏用：短 sha，或 09-13 19:55） */
declare const __BUILD_SHORT__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
