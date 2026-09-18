# 模块总览

## 一张图看清依赖方向

```
                    ┌──────────────────────────────────────────────┐
   浏览器事件 ──────▶│ components/  只画与转发意图，不查不写数据源   │
                    │ App · Sidebar · ChatWindow · MessageItem      │
                    │ InputBox · RunStatus · ContextGauge · Notice  │
                    └───────┬──────────────────────────┬───────────┘
                            │ 调 action / 读 store      │ 用纯函数（格式化、状态灯）
                            ▼                          ▼
                    ┌──────────────────────┐   ┌───────────────────────────┐
                    │ stores/chat.ts       │   │ lib/  纯函数（无副作用）  │
                    │ 唯一 store + 全部行为 │◀──│ route · turns · messages  │
                    │ 发送状态机 / 段归约    │   │ turnStatus · security …   │
                    │ 会话与分页 / 断线恢复  │   └───────────────────────────┘
                    └───────┬──────────────┘
                            │ 只能通过 api/ 发请求（组件禁止 fetch）
                            ▼
                    ┌──────────────────────────────────────────────┐
                    │ api/  hermes.ts（REST）  runs.ts（/v1/runs）  │
                    │       sse.ts（解析器）   types.ts（契约类型）  │
                    └───────┬──────────────────────────────────────┘
                            │ fetch（同源；鉴权头由反代注入）
                            ▼
              nginx（chatlite 容器） ── injects Bearer, strips Origin ──▶ hermes:8642 / :9119
```

**三条硬约束**（改代码前先认下来，违反了立刻出 bug）：

1. **依赖只能向下**：`components → stores → api`。组件里出现 `fetch` 就是违规（`api/hermes.ts` 文件头明确写了这条）。
2. **lib/ 是纯的**：不 import store、不发请求、不读 localStorage（`context-cache.ts` / `appearance.ts` / `theme.ts` 是
   唯一三个例外 —— 它们是"存储适配器"，被设计成可静默降级）。
3. **同一件事只允许有一个入口**：打开会话只走 `App.vue.applyRoute()`（地址即状态）；"忙不忙 / 这轮结束了没"只由
   `lib/turnStatus.ts` 派生。仓库文档把它总结成一句可复用判据：*凡是发现同一件事有两处实现，就是下一次 bug 的地址*。

## 模块清单

| # | 模块 | 文件 | 规模 | 一句话职责 |
| --- | --- | --- | --- | --- |
| 01 | [api 层](01-api层.md) | `src/api/*.ts`（4 个） | ~640 行 | 与 Hermes 的**契约层 + 传输层**：REST 封装、SSE 手写解析器、`/v1/runs` 全流程、类型定义 |
| 02 | [状态层](02-状态层.md) | `src/stores/chat.ts` | 1899 行 | 唯一 store；**发送状态机、事件归约、段模型、分页、断线恢复**全在这里 |
| 03 | [组件层](03-组件层.md) | `src/components/*.vue`（9 个） | ~1600 行 | 只负责画 + 转发用户意图；相位分派的输入框、四态状态行、审批卡片 |
| 04 | [lib 工具层](04-lib工具层.md) | `src/lib/*.ts`（11 个） | ~1050 行 | 纯函数：路由、分段、轮分组、状态灯判据、滚动锚定、格式化、markdown、安全判据 |
| 05 | [构建与部署层](05-构建与部署层.md) | `vite.config.ts` `nginx.conf` `Dockerfile` `docker-compose.yml` `index.html` | ~400 行 | 密钥不进产物、SSE 不缓冲、缓存分层、构建期自检、版本可核验 |
| 06 | [测试与验证层](06-测试与验证层.md) | `src/**/*.spec.ts` + `e2e/` + 技能库探针 | 314 用例 | 三层验证阶梯：纯函数单测 → 真链路 e2e → 真浏览器探针 |

## 谁拥有什么状态（评审时最容易问的一张表）

| 状态 | 唯一归属 | 生命周期 | 备注 |
| --- | --- | --- | --- |
| 会话 / 消息的**真值** | Hermes（服务端数据库） | 永久 | 前端所有渲染都是它的**投影** |
| 当前打开哪个会话 | **浏览器地址**（`#/s/<id>`） | 标签页 | hash 路由，裸域名 = 欢迎页 |
| 会话列表、当前会话的消息段 | `store.sessions` / `store.messages` | 内存（刷新即重建） | 重建入口 = `openSession()` + `normalize()` |
| 这一轮在跑（相位、计时、时间线、审批） | `store.run` | 内存 | `RunPhase` 8 态，**没有跨页面状态机** |
| 服务端那一轮是否还在跑 | 服务端 `GET /v1/runs/{id}` | 服务端保留期 | 前端只做"问 + 投影"，不自建执行器 |
| "我提交过哪一轮"（页面之外要记得的东西） | `localStorage: hcl.activeRun` | 6 小时 TTL / 终态即清 | 唯一能扛住"标签页被系统回收"的载体 |
| 本轮输入合计（水位行） | 无持久真值（Hermes 不落库） | 本地缓存 `hcl.ctx.<sid>` | 刷新后显示"上次已知"，**不显示百分比**（口径见文档 03） |
| 主题 / 头像 / 侧栏折叠 | `localStorage`（`hcl.theme` / `hcl.avatar` / `hcl.sidebar`） | 永久 | 纯展示偏好，改完即时生效、不需重建 |
| 分页游标 / 已加载 id 集 | **模块级变量**（`rawCount` 进 store，`loadedIds` 是模块级 `Set`） | 内存 | 去重必须用 `loadedIds`，界面消息的 `srcId` 已被合并逻辑吃掉 |

## 规模分布（哪里是复杂度中心）

```
stores/chat.ts            1899 ██████████████████████████████████████  ← 复杂度 100% 集中在这
components/Sidebar.vue     394 ████████
components/App.vue         315 ██████
components/ChatWindow.vue  268 █████
components/InputBox.vue    244 █████
components/RunStatus.vue   231 ████
api/types.ts               218 ████
components/MessageItem.vue 212 ████
api/hermes.ts              181 ███
api/runs.ts                130 ██
lib/format.ts              136 ██
lib/markdown.ts            130 ██
lib/turnStatus.ts          126 ██
lib/route.ts               116 ██
lib/scroll-anchor.ts       105 ██
api/sse.ts                 105 ██
lib/messages.ts             94 █
lib/page-lifecycle.ts       69 █
lib/theme.ts                66 █
lib/security.ts             68 █
lib/context-cache.ts        43 ▏
lib/appearance.ts           41 ▏
lib/turns.ts                36 ▏
```

一句话结论：**除了 `chat.ts`，全仓没有一个文件难以阅读**。`chat.ts` 承担了 6 类彼此不同的职责
（会话 CRUD / 段归约 / 发送状态机 / 断线恢复 / 统计口径 / 上下文缓存），这是本项目的**主要结构性负债**
（详见 `文档/04` 的缺陷 A1）。
