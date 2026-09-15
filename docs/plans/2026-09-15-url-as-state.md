# 地址即状态（URL as the single source of truth）—— 计划书 + 状态看板

- **立档**：2026-09-15 CST（Asia/Shanghai）
- **分支**：`feat/url-as-state`（从 `origin/main` 的 `6afbf7c` 开；main 不动、不部署）
- **起因**：用户实测「打开会话 → 刷新页面 → 回到空白欢迎页」，问是 BUG 还是设计。
  查证结论：**一半刻意（有一轮在跑时会自动接上）、一半漏做（普通刷新没恢复）** ⇒ 决定做「地址即状态」。
- **用户拍板（2026-09-15）**：A 留 `hcl.activeRun` 记录（只砍"自动切会话"分支）｜B **hash**（`#/s/<id>`）｜
  C 点侧栏 **push** 一步（返回键可用）｜D 提示 5 秒自动消失 + 点击立即消失、删除当前会话静默回欢迎页；
  **圆圈（在跑标识）本轮不做**。

## 状态看板

| 阶段 | 状态 | 交付物 |
| --- | --- | --- |
| S0 定口径 | ✅ 完成 | 三栏表（保留/退回/新增）+ 6 条验收判据（用户已过目） |
| S1 `lib/route.ts` + 单测 | ✅ 完成 | 解析 `#/s/<id>`；`navigate(id \| null, {push\|replace})`；`onRouteChange` |
| S2 `Notice.vue`（会自动消失的提示） | ✅ 完成 | 5 秒计时 + 点击立即消失 |
| S3 `chat.ts` 新口径 | ✅ 完成 | `goHome()`；`openSession` 返回可判别结果；`resumeSync` 只接当前会话 |
| S4 `App.vue` 挂载与分发 | ✅ 完成 | 启动按地址进入；popstate/hashchange → 打开会话 |
| S5 `Sidebar.vue` 改导航 | ✅ 完成 | 点行 push；「新会话」清地址不建会话；删除当前会话 replace 回欢迎页 |
| S6 测试与真浏览器验证 | ⬜ | 6 条验收判据全过 + RED/GREEN |
| S7 文档与交付 | ⬜ | detailed-design（新节 + 看板 P26 + 坑位）、待办文档、提交推送 |

## 一、口径（用户已拍板，别再问）

1. **地址是唯一真相源**：裸域名（无 `#`）= 欢迎页（**输入第一条消息才建会话**）；`#/s/<id>` = 进该会话；
   id 不存在 → `replace` 回裸域名 + 顶部提示 `该会话不存在，请重新创建`（5 秒自动消失、点击立即消失）。
2. **根路径永远不"偷偷跳回上次会话"**（这样 `/` 可以安全分享）。
3. **点侧栏 = push 一步**（返回键回上一个会话）；**程序内部自动跳转 = replace**（不污染历史）。
4. **`hcl.activeRun` 记录保留**，但 `resumeSync()` **不再自动打开别的会话** —— 只在"你打开的这一条正好是那条在跑的"时才接上
   （保留：接流 / 能停 / 轮末对账 / 防误发第二轮）。
5. **「新会话」不再预建空会话**（副作用：侧栏不再堆 0 消息空会话）。
6. 多标签同会话不实时同步：**接受**，写进已知限制。

## 二、三栏表（保留 / 退回 / 新增）

**保留（不动）**：v2.11 渲染模型与段序；相位分派/steer/暂停/已中断；水位行口径；`send()` 懒创建；
`hcl.theme`/`hcl.sidebar`/`hcl.activeRun`；`resumeSync` 的接流/停止/对账能力；侧栏搜索/改名/删除/归档；
翻页与滚动锚定；**其它** `bootError`（401、建会话失败）仍走原横幅；nginx / Dockerfile / Hermes 核心一律不动。

**退回（行为改变，共 5 条）**：
| # | 现在 | 改成 |
| --- | --- | --- |
| 1 | 刷新一定回欢迎页 | 按地址恢复：有 `#/s/<id>` 进该会话，否则欢迎页 |
| 2 | 点侧栏不进历史 | **push 一步**（返回键能回上一个会话） |
| 3 | 「新会话」立刻建空会话 | 只清地址回欢迎页，**不建会话** |
| 4 | `resumeSync()` 自动打开"在跑那轮"的会话 | 只在你打开的就是它时才接上（`rec.sessionId === currentId`） |
| 5 | 无效 id 走常驻红字横幅 | `replace` 回裸域名 + 5 秒自动消失的提示（点击立即消失） |

**新增**：`src/lib/route.ts`（手写，**不引 vue-router**）；`src/components/Notice.vue`；
`App.vue` 的路由挂载与分发；`Sidebar.vue` 三处改导航；`chat.ts` 的 `goHome()` + `openSession` 返回值 + `resumeSync` 新口径；
单测 ~12–16 条；真浏览器 5 条用例；文档一节 + 看板 P26 + 坑位。

## 三、实现要点（给未来的自己）

- **不引 vue-router**：收益来自"状态在地址里"，不来自路由库；手写 hash 路由 ~70 行、纯函数可测。
- **自己的导航也要分发**：`pushState/replaceState` **不会**触发 `hashchange`/`popstate` ⇒ `navigate()` 内部改完地址
  主动调用一次订阅者；同时监听 `popstate`（前进/后退）与 `hashchange`（用户手改地址/直接点链接），
  用一个"最后分发过的路由"去重，避免双跑。
- **欢迎页地址要干净**：用 `history.replaceState(null, '', location.pathname + location.search)` 把 `#` 整个去掉，
  不能只把 hash 设为空串（会留下一个光秃秃的 `#`）。
- **缺会话的判据**（实测）：`GET /api/sessions/<bad>/messages` → **404**，body `{"error":{"code":"session_not_found"}}`
  ⇒ 用 `HermesApiError.status === 404`（或 `code === 'session_not_found'`）判定，不要拿文案比。
- **打开会话只有一个入口**：`App.vue` 的路由分发；`Sidebar` 不再直接调 `openSession`（这是本次改动最想消除的
  "同一件事两处实现"）。`ChatWindow.retry()` 仍重开"当前会话"，不改会话身份，保留。
- **生成中切会话**：`openSession` 有 `if (store.streaming) return` 守卫（既有行为：点了没反应）⇒ 路由层要**把地址
  撤回当前会话**，否则地址与视图不一致（静默撤回，行为与现在一致）。

## 四、验收判据（真浏览器，逐条可看）

1. 打开会话 A → 刷新 → 仍在 A（地址 `#/s/<A>` 不变）
2. 在 A 点侧栏 B → 刷新 → **落 B**（不跳回 A）
3. 从 B 按返回键 → 回到 A
4. 访问 `#/s/不存在` → 落欢迎页 + 裸域名地址 + 提示 5 秒自动消失；再来一次 → 点一下提示立即消失
5. 点「新会话」→ 地址清空、欢迎页、**侧栏不新增 0 消息会话**
6. 回归：跑着一轮时刷新到别的会话 → 不被打断、不自动跳走；点开那条在跑的会话 → 仍能停/仍能接上

## 五、边界与回滚

- 不做：圆圈、命令面板、vue-router、多标签实时同步（用户已接受）。
- 回滚 = 不合并（改动集中在一个新文件 + 三个挂接点）。

### S1–S5 落地记录（2026-09-15）

- 新增 `src/lib/route.ts`（~110 行含注释）：`parseRoute` 纯函数 + `routeToUrl` + `navigate(id|null, {push|replace})`
  + `onRouteChange`（同时听 `popstate` 与 `hashchange`，用"最后分发过的路由"去重）+ `markInitialRoute`。
  自己的导航也**手动分发**（`pushState/replaceState` 不触发事件）。欢迎页把 `#` 整个去掉（`pathname + search`）。
- 新增 `src/components/Notice.vue`：5 秒自动消失 + 点击立即消失（`ms` 可调，下限 1 秒防"闪现"）。
- `chat.ts`：`openSession()` 现在返回 `{ok:true} | {ok:false, missing}`（`missing` 用 `status===404 || code==='session_not_found'` 判定）；
  新增 `goHome()`；`resumeSync()` 删掉"自动打开会话"分支，新增"`rec.sessionId !== currentId` 就返回"。
- `App.vue`：新增 `applyRoute()`（**唯一的打开会话入口**）+ 启动按地址进入 + 订阅地址变化；无效 id → replace 回欢迎页 + `clearBootError()` + 轻提示。
- `Sidebar.vue`：`pick()` 改成 `navigate(push)`（不再直接 `openSession`）；`startNew()` 改成 `navigate(null, replace)`（**不再调 `newChat()`**）；
  删除当前会话后把地址也清掉（否则刷新会被当成"会话不存在"）。
- 测试：**269 passed / 26 files**（新增 `route.spec` 11 条 + `Notice.spec` 5 条 + `App.spec` 地址组 6 条，改写 `resume.spec` 3 条旧口径断言）。
  RED/GREEN：还原 `chat.ts`/`App.vue`/`Sidebar.vue` → **7 条新断言全红**。
  ⚠️ RED 阶段发现一个**假通过**：同文件里 `store` 是模块级单例，上一组用例留下的 `currentId/messages` 会让"启动就进那个会话"
  这类断言照样绿 ⇒ 已在新 describe 的 `beforeEach` 里显式清 store（这条记进坑位）。
