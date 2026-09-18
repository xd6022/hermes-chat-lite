# 模块 04 · lib 工具层（`src/lib/`）

> **一句话**：**纯函数层**。判据、解析、格式化、锚定这些东西从组件和 store 里抽出来，
> 目的只有一个 —— **能被单测逐条锁住**。风险越集中的判据，越应该在这里。
>
> 三条纪律：不 import store、不发请求、不直接依赖 DOM（`scroll-anchor` 只接受回调；
> `page-lifecycle` 是唯一碰 `document` 的，因为它就是"事件订阅适配器"）。

| 文件 | 行数 | 导出 | 职责与关键点 |
| --- | --- | --- | --- |
| `turnStatus.ts` | 126 | `runStatus` `LIGHT_ICON` | **四态状态灯的判据**（相位 + 秒 + runId → 灯/词/脉冲/是否给重试）。带**编译期绊线**：`const exhaustive: never = phase` |
| `route.ts` | 116 | `parseRoute` `currentRoute` `routeToUrl` `navigate` `onRouteChange` `markInitialRoute` | 手写 hash 路由（地址即状态）。三条坑：pushState 不触发事件要手动分发 / 欢迎页要把 `#` 整个去掉 / popstate+hashchange 要去重 |
| `turns.ts` | 36 | `groupIntoTurns` | 扁平的段 → 按"轮"分组（一个用户块 + 随后的连续助手段）；轮内紧凑、轮间留白的依据 |
| `messages.ts` | 94 | `isCompactionNote` `argPreview` `toolFailed` `COMPACTION_HEAD_CHARS` | ① 压缩摘要判据（**照抄上游**：前 280 字符包含 `CONTEXT COMPACTION` / `[CONTEXT SUMMARY]:` / `Conversation Summary`）；② 工具参数 → 一行预览（按 `command/url/path/query…` 优先级取值）；③ 历史 tool 行的成败**启发式**（锚在开头，避免把日志里的 error 误判） |
| `security.ts` | 68 | `securityBlock` | 识别"被安全闸门拦下"（判据取自上游 `tools/approval.py` 的**实际文案**）；返回 `{kind, hint, snippet}`，`kind=approval` 的文案按通道分 |
| `scroll-anchor.ts` | 105 | `followUntilSettled` `createHeightSettler` | "高度连续两帧不变才算稳定"的锚定器（打开会话贴底、翻页补偿 scrollTop 都用它） |
| `page-lifecycle.ts` | 69 | `isForeground` `watchForeground` `backoffDelay` `BACKOFF_CAP_MS` | 四个"回到前台/网络恢复"信号（visibilitychange/focus/pageshow/online）统一交一个幂等回调；退避 1s→30s 封顶（含 NaN/负数防御） |
| `format.ts` | 136 | `tsToDate` `dayBucket` `groupSessions` `formatClock/Date` `displayTitle` `relativeTime` `formatTokens` `formatCompactTokens` `formatDurationMs` `formatPercent` | 时间与数字的人类可读化；**`groupSessions(sessions, nowMs = Date.now())` 的时间入口可注入**（否则测试跨午夜必挂） |
| `markdown.ts` | 130 | `renderMarkdown` `escapeHtml` | markdown-it（`html: false` **必须保持**）+ hljs **按需注册 19 种语言**（全量 import 实测 1.17MB）；重写 `table_open/table_close` 给表格包 `.table-wrapper` |
| `theme.ts` | 66 | `theme` `THEME_KEY` `applyTheme` `setTheme` `initTheme` `toggleTheme` | 白天/黑夜三处同步：`index.html` 内联脚本（首帧前定主题）+ 本文件（运行时）+ `tailwind.config.js` 的 `darkMode:'class'` |
| `appearance.ts` | 41 | `avatar` `DEFAULT_AVATAR` `setAvatar` `resetAvatar` | 头像（`hcl.avatar`，默认 `-_-`）；改完立刻生效，不用重建 |
| `context-cache.ts` | 43 | `readContextUse` `writeContextUse` `CachedContextUse` | 按会话记"本轮输入合计的上次已知值"（`hcl.ctx.<sid>`）；隐私模式下静默降级 |

## 1. `turnStatus.ts` —— 本层最值得学的一个文件

```ts
runStatus({ phase, seconds, runId }) → { light, icon, text, pulse, retry }

thinking | tool | writing | background → 🟡 忙碌中 {secs}s   （pulse: true）
approval                              → 🟠 等待审批
aborted                               → 🟠 已中断
error   → runId === null ? 🔴 失败（请重试）[retry] : 🔴 失败
done | idle                           → 🟢 时刻准备着
```

四条硬约束（都来自用户原话，别改回去）：

1. **进行中必须在动**（`pulse`）—— 静态黄灯跟"卡住了"长得一样；
2. **灯不看工具**（状态词的词汇表里没有工具名，也没有蓝色）；
3. **只有 `error` 相位是红的** —— `background`（连接断了但服务端还在跑）**必须是 🟡**，
   报红会让人以为长任务白费；
4. **「重试」只在 `runId === null` 时给** —— `null` = 服务端根本没收到 ⇒ 重发安全；
   非 null 说明可能已落库，重发会出现两条输入（比少一个按钮糟得多）。

最后那个 `default:` 分支里的 `const exhaustive: never = phase` 是**编译器绊线**：
给 `RunPhase` 加成员会让这里编译报错，逼着人为新状态决定"亮什么灯"。
它的由来是一次真实事故：上游新增终态 `interrupted` 时四个判据点同时漏 ⇒ 界面永久卡在"忙碌中"。

## 2. `route.ts` —— 七十行换掉一个路由库

```ts
parseRoute('#/s/api_1789467328_decb9504') → { kind:'session', id }   // SESSION_ID_RE 宽松校验
parseRoute('')                            → { kind:'home' }          // 裸域名 = 欢迎页
parseRoute('#/s/')                        → { kind:'home' }          // 坏地址不当会话
navigate(id|null, {mode:'push'|'replace'}) // 改地址 + **手动分发**（pushState 不触发事件）
onRouteChange(cb)                          // 同时听 popstate + hashchange，按"最后分发过的路由"去重
```

口径（用户 2026-09-15 拍板）：**`push` 用于用户点侧栏**（返回键能回上一个会话）、
**`replace` 用于程序自己纠正地址**（无效 id、生成中撤回）；欢迎页要把 `#` **整个去掉**
（`pathname + search`），只把 hash 设空会留下一个光秃秃的 `#`。

## 3. `messages.ts` —— 三个"只能靠启发式"的判据

| 函数 | 判据 | 为什么是这个判据 |
| --- | --- | --- |
| `isCompactionNote` | content 前 **280** 字符里出现压缩标记 | 真实那条压缩消息**不以标记开头**（开头是 `[PRIOR CONTEXT — for reference only…]`，标记在 100 字符之后）；判据照抄上游压缩器，别自创正则 |
| `argPreview` | `arguments`（JSON 字符串）里按 `command/cmd/url/path/file_path/query/pattern/name/prompt/text/code/script` 优先级取第一个字符串，压空白、截 72 字符 | 目标是"一眼看出干了什么"，不是展开参数；解析失败退回原文截断（宁可丑也别空） |
| `toolFailed` | 结果**开头**匹配 `Error|Traceback|Exception|BLOCKED` 或 `{"error":…}` / `{"detail":…}` | 上游不返回成败字段（实测），只能启发式；锚在开头才不会把正常输出里的 "error" 字样（日志、grep 结果）误判 |

## 4. `security.ts` —— 把"为什么被拦"翻成人话

- 触发条件：文本里含 `BLOCKED`；`kind` 由是否命中审批类标记决定
  （`approval required` / `approval request` / `without user response` / `user denied this potentially dangerous action`）。
- **文案按通道分**：`runs` 通道下审批类 = "没等到回应（超时）或您点了拒绝"；
  `stream` 通道下同一句话 = "旧通道没注册审批通知者，当场 fail-closed 拒绝，不是排队等批准"。
- 返回 `snippet`（`BLOCKED` 起 240 字符）供想深究的人看一眼。

## 5. `scroll-anchor.ts` / `page-lifecycle.ts` —— 两个"事件源适配器"

- `followUntilSettled(readHeight, onFrame, {maxMs})`：每帧调 `onFrame`，直到高度**连续两帧不变**
  （默认 2 帧）或超时（默认 1.5s）。**为什么要"稳定"而不是"贴一次"**：DOM 是分波进场的
  （打开会话实测 1408ms→1509ms 之间插了 70+ 个节点），只贴一次必然贴在半路。
- `watchForeground(cb)`：四个信号全听，理由各自独立 —— `visibilitychange`（切回 App 主信号）、
  `focus`（桌面切窗口、部分浏览器不触发前者）、`pageshow`（iOS Safari 的 bfcache 恢复，JS 状态还在但连接已死）、
  `online`（移动网络恢复，**不看可见性**，因为它本身值得立刻同步一次）。**刻意不做**：不用
  `setInterval` 保活、不在 `hidden` 时做清理（隐藏 ≠ 断开）。

## 6. 本层的三个坑（都踩过）

1. **`groupSessions` 内部取 `Date.now()`** ⇒ 测试写死日期跨过午夜必挂。修法：`nowMs` 做成可注入参数
   （`relativeTime`、`dayBucket` 同理）。**凡是"相对当前时间"的逻辑，都要留一个可注入的时间入口。**
2. **暗色模式三处必须同步改**（`index.html` 内联 + `theme.ts` + `tailwind.config.js` 的 `darkMode:'class'`）：
   漏掉第三处**不会报错**，只是所有 `dark:` 类被静默丢弃。核验方式：构建后在 `dist/assets/*.css` 里数
   `:is(.dark *)` 的次数（Tailwind 3.4 生成的是 `:is(.dark *)`，不是 `.dark .bg-gray-800`）。
3. **hljs 暗色不能直接再引一份 `github-dark.css`**：CSS 不支持给 `@import` 加作用域，会在浅色下也生效。
   做法是手写 `.dark .hljs-*` 调色板（`.dark .hljs` 优先级高于 `.hljs`）。
