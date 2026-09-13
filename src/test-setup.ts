/**
 * 测试环境 setup（vite.config.ts 的 test.setupFiles 注册）。
 *
 * 为什么需要它：
 *   jsdom 本身**提供** localStorage（裸 jsdom 实测 `typeof window.localStorage === 'object'`），
 *   但在 vitest 里 `globalThis` 上已经有一个自己的 `localStorage` 属性 —— 来自 Node 22+
 *   内置的实验性 localStorage；没有 `--localstorage-file` 时它取值为 undefined 并打印
 *   "ExperimentalWarning: localStorage is not available because --localstorage-file was not provided"。
 *   它把 jsdom 的那份遮蔽掉了，于是：
 *     - 主题切换（lib/theme.ts）
 *     - 侧栏折叠记忆（App.vue）
 *   一动 localStorage 就报 "Cannot read properties of undefined"。
 *
 * 修法：装一个语义完整的内存 Storage。这样测试跑的是真实的读写逻辑
 *（get/set/remove/clear/length/key 全都有），而不是把 localStorage 断言成 mock 调用次数。
 * 生产浏览器环境不受影响（那份 localStorage 是真的）。
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  // globalThis === window（vitest jsdom 环境下成立），所以一处定义两边都生效
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}

// v2.2 后台恢复把"正在跑的那一轮"记在 sessionStorage 里（见 stores/chat.ts 的
// ACTIVE_RUN_KEY）。**同一个坑**：Node 22+ 也用实验性的 sessionStorage 遮蔽了 jsdom
// 那份，不补的话 `sessionStorage.setItem` 会因为全局变量本身不存在而抛 ReferenceError
//（生产代码里包了 try/catch 不会崩，但用例就测不到"记录真的落下来了"）。
if (typeof globalThis.sessionStorage === 'undefined') {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}
