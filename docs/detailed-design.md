# Hermes Chat Lite —— 详细设计（可直接照着开发）

> 配套文档：`docs/feasibility-analysis.md`（可行性 / 风险 / 暴露面决策）
> 目标版本：v1.0（第一版验收标准见文末）
> 接口契约最后核验：2026-09-11（本机 hermes:8642 实测）

---

## 0. 状态看板

> 跨会话续接用：接手的会话先读本表，再读对应阶段章节。

| 阶段 | 状态 | 交付物 | 验收方式 |
| --- | --- | --- | --- |
| P0 工程搭建 | ✅ 完成（2026-09-11 实测） | `package.json` `vite.config.ts` `tailwind.config.js` `src/api/{types,hermes,sse}.ts` | dev server 200；反代注入 key 后 `/api/sessions` 返回 200 + 真实会话 |
| P1 只读链路 | ✅ 完成 | `Sidebar.vue` `ChatWindow.vue` `MessageItem.vue` `lib/*` | 集成用例：侧栏渲染真实标题+日期分组、点会话加载历史且 tool/空 assistant 被滤掉 |
| P2 写链路 | ✅ 完成 | `InputBox.vue` + `newChat()` | 输入规则 7 项全过（Enter/Shift+Enter/输入法合成/生成中不重发/空内容） |
| P3 流式 | ✅ 完成 | `src/api/sse.ts` `RunStatus.vue` `stores/chat.ts` | 真实接口端到端跑通（delta 流式 + tool 事件 + run.completed）；半帧切片/中文多字节切分/keepalive 用例全过 |
| P4 部署 | 🟡 文件完成，**待宿主机验证** | `Dockerfile` `nginx.conf` `docker-compose.yml` `.env.example` | 本容器未挂 docker daemon，无法在此构建；命令见 §8 |
| P5 安全加固 | ⬜ 未开始（已定用 basic_auth） | Caddy basic_auth | 未带口令返回 401 |
| P6 每轮统计（v1.1 追加） | ✅ 完成 | `TurnStats`（`stores/chat.ts`）+ `MessageItem` 页脚 + `getSession()` | 单测 4 条 + **真实接口自检：未命中Δ + 命中Δ === usage.input_tokens** |
| P7 界面优化（v1.1 追加） | ✅ 完成 | 侧栏搜索（`Sidebar.vue`）+ 桌面折叠（`App.vue`）+ 黑夜模式（`lib/theme.ts`） | 新增 17 条单测（54/54 全过）；产物 CSS 核验含 39 条 `:is(.dark *)` 暗色规则；`vue-tsc` 0 错 |
| P8 长会话完整可读（v1.2 追加） | ✅ 完成 | 历史分页 `loadEarlier()`（划到顶自动触发 + 按钮兜底）+ 连续 assistant 合并（`normalize`）+ 压缩摘要折叠（`lib/messages.ts`、`MessageItem`） | 新增 18 条单测（72/72 全过），含"滚动到顶自动加载/到底不再请求/加载中不重复"；**真实链路核验：逐页加载结果与全量读 `toEqual` 完全相等**（206 条会话，含偏移位移去重） |
| P9 输入区布局（v1.4 追加） | ✅ 完成 | `InputBox.vue` 改上下两段（文字区占满整宽 + 底部工具行） | 新增 2 条结构用例（74/74 全过），锁死"不得并排"，见 §5.5 / 坑 30 |
| P10 会话改名与删除（v1.5 追加） | ✅ 完成 | `Sidebar.vue` 行内操作 + `stores/chat.ts` `renameSession/removeSession` + `api/hermes.ts` PATCH/DELETE | 新增 7 条单测（81/81 全过）；**真实链路核验**：改名落库、重名/超长被拒并翻成中文、删除后 GET 404 且本地状态清空（只动探针会话，用完即删），见 §5.10 |
| P11 行内状态自动收起（v1.6 追加） | ✅ 完成 | `Sidebar.vue` document 捕获阶段 click + Esc 取消；顺带修掉一个"会腐烂"的测试（`groupSessions` 注入 `nowMs`） | 新增 5 条单测（86/86 全过）：点外面取消/删除确认点外面取消/Esc/点行内保存不误伤/切到另一行编辑；见 §5.2 与坑 34/35 |
| P12 删除后空壳残留（v1.7 追加） | 🟡 客户端兜底已完成；🟠 **服务端补丁待宿主机应用** | 根因定位到 `hermes_state.py:7506`「确保行存在」的 upsert；客户端 `removeSession()` 加 2s 复查再删 | 新增 2 条单测（88/88 全过）+ **真实链路核验**：状态序列 `1.6s:200 → 2.0s:404`、`state.db` 行数 0；服务端补丁 `/opt/data/.verify/apply_ghost_fix.py`（需 root），见 §5.10 与坑 36 |
| P13 安全闸门拦截提示（v1.8 追加） | ✅ 完成 | `lib/security.ts` 判据（照抄服务端文案）+ store 从 `run.completed.messages` 捞原文 + `RunStatus.vue` 琥珀色说明卡 | 新增 10 条单测（98/98 全过，含 7 条判据用例与"不误报/换轮清空"）；**真实链路核验**：transcript 确实带 `role=tool` 原文（简单一轮 2.0 KB）且正常轮不误报，见 §5.10 与坑 37 |
| P14 发送链路迁到 `/v1/runs`（v2.0，A 方案） | ✅ 完成 | 新增 `api/runs.ts`（提交/订流/查终态/中断/审批回话/引导）+ `api/sse.ts` 抽出 `consumeSse`/`getSse` + store 双通道开关 + `RunStatus.vue` 审批卡片 + 轮末回读对账 | 新增 24 条用例（**122/122 全过**）+ **常驻真实链路 e2e**（`npm run e2e`，5 项全绿）。真链路抓到 2 个真 bug（事件名不在 `event:` 行里 → 全事件被忽略；`run.cancelled` 被判成"完成"）与 1 个字段坑（`tool` ≠ `tool_name`）；审批**真审批事件已于 2026-09-15 真机验收**（真链路触发 + 真域名页面上点按钮），此前"触发不了"的归因是 `config.yaml` 的 `command_allowlist` 里有 `delete in root path` 在问人之前静默放行；见 §5.11 与坑 38/39/40 |
| P15 移动端表格横向溢出（v2.1，分支 `fix/mobile-table-overflow`） | ✅ 完成（2026-09-13） | `lib/markdown.ts` 给表格包 `.table-wrapper`；`style.css` 加宽度契约（wrapper `overflow-x:auto` + table `max-content` + `.md-body` `min-width:0`/`overflow-wrap:anywhere`）；`MessageItem`/`ChatWindow` 补 `min-w-0` | 新增 15 条用例（`lib/markdown.spec.ts` 5 + `style.spec.ts` 5 + `components/MessageItem.spec.ts` 5，**137/137 全过**）+ `vue-tsc` 0 错误 + **Chromium 真浏览器 before/after 对照**（375 / 320 / 1280 三档，脚本与判据见 §10.3） |
| P16 进后台/断线自动恢复（v2.2 → v2.2.1 → v2.2.2，分支 `fix/background-resume`） | ✅ 完成（2026-09-13，含两轮真机纠偏） | `lib/page-lifecycle.ts`（前台信号 + 退避）+ `stores/chat.ts`（`hcl.activeRun` 记录、`resumeSync()`、`background` 相位、停止仍可用）+ `App.vue` 接线 + `RunStatus`/`InputBox` 文案与按钮。v2.2.1：网络类错误翻中文 + 过时横幅自愈 + 假红字自愈；v2.2.2：记录迁 `localStorage` + 没选会话时自动打开那一轮所在的会话 | 新增 31 条用例（`lib/page-lifecycle.spec.ts` 8 + `stores/resume.spec.ts` 15 + `stores/transient-error.spec.ts` 8，**168/168 全过**）+ 常驻真链路 e2e（`e2e/background-resume.e2e.spec.ts`）+ **真浏览器 7 个场景**（含"标签页被系统回收后重开"，脚本与数字见 §10.4） |
| P17 空态去示例话术（v2.2.5，`chore/remove-empty-examples`） | ✅ 完成并部署（2026-09-14） | `ChatWindow.vue` 删掉写死的三句示例按钮（`EXAMPLES` 常量），保留「有什么可以帮您？/从一个新会话开始」两行；`App.spec.ts` 加回归断言 | 全量单测通过 + 新断言 **RED/GREEN** + 构建产物三句话术 0 命中 + **线上 bundle 复验** |
| P18 工具调用内联（v2.3 → v2.3.1，`feat/inline-tool-calls`） | ✅ 完成并部署（2026-09-14） | `stores/chat.ts`（`ToolStep` 扩字段 + `normalize()` 按 `tool_call_id` 配对 + 合并串接 + 实时同步）+ `MessageItem.vue`（工具块放**正文之前**、**默认展开**、`●/✓/✗ 名称 "参数" (耗时)`）+ `RunStatus.vue` 去掉输入框上方那份时间线 | 单测 183 + **RED/GREEN（12 条）** + 新 `e2e/tools-inline.e2e.spec.ts`（真数据 5 会话 / 827 步 / 预览 98.3% / 耗时 99.2%）+ **线上真 DOM 复验 14/14** |
| P19 会话累计行 + 输入框 ↑ 翻历史（v2.4，`feat/session-totals-input-history`） | ✅ 完成并部署（2026-09-14） | `ChatWindow.vue` 列表末尾一行「本会话累计」（`formatCompactTokens`）+ `InputBox.vue` ↑/↓ 翻历史（输入法合成、多行非首行一律让路）+ `lib/format.ts` 新格式化 | 单测 194 + **RED/GREEN（7 条）** + **线上真 DOM 复验 14/14**（含 ↑ 填回上一条 / ↓ 还原草稿） |
| P20 上下文水位（v2.5，`feat/context-gauge`） | ✅ 完成并部署（2026-09-14） | 新 `ContextGauge.vue`（贴输入框上方）+ 新 `lib/context-cache.ts`（ⓐ 上次已知）+ `chat.ts` 三来源接线 + `nginx.conf`（`/api/model-info` → 9119） | 单测 210 + RED/GREEN 13 条 + **真浏览器 14/14** + 本地桩端到端 18/18；线上复验：水位行在线、`/api/model-info` 200、构建标识 `2026-09-14 21:30`（Docker 无 .git 只有时刻） |
| P21 打开会话的落点（v2.6，`fix/scroll-anchor-stable`） | 🟡 代码完成，**待合并部署** | 新 `lib/scroll-anchor.ts`（高度稳定判定 + 逐帧跟随）+ `ChatWindow.vue`（ResizeObserver 盯**内容容器**、打开会话锚定窗口、`earlier()` 补偿改为等稳定）+ 新单测 | 单测 **221** + RED/GREEN（2 条核心断言红）+ **真浏览器**：多会话落点表**修后全部"距底 0"**（修前 655~2297px）、护栏"上滚不被拽回"（距底保持 1200）、"加载更早"后锚偏移 **Δ=0px**；坑 50/51 记录了四处修法与两个可复用教训 |
| P22 水位行口径纠偏 + 删「本会话累计」（v2.7，`chore/ctx-gauge-and-session-totals`，PR #16） | ✅ 完成并部署（2026-09-15） | `ContextGauge.vue` 改灰并撤掉分母/百分比/进度条（`模型 │ 窗口 1m │ 本轮输入合计 …`）+ `chat.ts` 删 `totals`/`SessionTotals`/`counters()` 写段 + `ChatWindow.vue` 删「本会话累计」行 | 单测 221 + **RED/GREEN（9 条新断言全红）** + 构建产物「本会话累计/缓存命中/█」**0 命中** + **线上真浏览器**：颜色 `rgb(156,163,175)`、无 █/%、旧行 DOM 与文本都不存在。口径纠偏见坑 52 |
| P23 发送按钮按相位分派（v2.9，`feat/phase-dispatch-steer`，PR #17） | ✅ 完成并部署（2026-09-15） | `chat.ts` 新增 `canSteer()`/`steer()`/`UiMessage.interrupted`；`InputBox.vue` 按钮与 Enter **按相位分派**（思考/调工具期=补充，正文输出期=暂停且 Enter 静默）；`MessageItem.vue` 贴「已中断」；`RunStatus.vue` 文案改「已中断这一轮」 | 单测 **238** + **RED/GREEN（15 条新断言全红）** + `vite build` + **真浏览器端到端（打真模型真工具）**：工具期按钮 `["暂停","发送"]`、点发送后补充气泡可见（轮末仍在）、本轮输出含 `STEER_OK`（证明模型真按补充执行）、工具期点暂停 → `phase=aborted` + 贴「已中断」；插消息端点口径见坑 53 |
| P24 静态资源"缺文件"真 404 加固（v2.10，同 `feat/phase-dispatch-steer`） | ✅ 完成并部署（行为验收 2026-09-16 重建镜像时） | `nginx.conf` 加根层后缀 location（`try_files $uri =404`）+ `Dockerfile` 加构建期断言（`test -f dist/{index.html,favicon.svg,favicon.ico,apple-touch-icon.png}` + `test -d dist/assets`） | 后缀正则语义 18/18 + 断言 **RED/GREEN**（模拟漏拷 `public/`、产物无 `assets/` 均按预期失败）+ **真 nginx 解析器 crossplane `status: ok` / 0 错**；**行为验收已过**（v2.13 部署起线上实测 `/nope.svg` → **404**、`/favicon.svg` → 200） |
| P25 按时间交错渲染（v2.11，`feat/interleaved-render`，PR #19） | ✅ 完成并部署（v2.12 起即在线上；本次线上指纹复验 2026-09-16） | `UiMessage.kind`（`text`/`tools`）+ `normalize()` 改为按时间切段 + `prependEarlier()` 只在同 kind 合并 + `TurnCtx.segs` 与 `openTextSeg/sealTextSeg/toolsSegFor/replaceTurnSegs`（流式期即交错、轮末用 transcript 整批重建）+ 新 `lib/turns.ts`（按轮分组）+ `MessageItem` 删折叠开关、工具行改常驻小字行 + `ChatWindow` 按轮渲染（轮内 `space-y-2`／轮间 `mt-6`） | 单测 **245**（新增 `lib/turns.spec.ts` 5 条、改写 12 条旧断言）+ **RED/GREEN（还原 3 个源文件 → 12 条核心断言全红）** + `vite build`（`工具调用 (` 0 命中）+ **真浏览器**：段序与服务端 transcript **逐轮完全一致**（11/11）、工具行 0 折叠开关且全部可见、轮内 8px < 轮间 24px、实时一轮中途即 `text→tools` 跑完 `text→tools→text`、滚动锚定无回归（落底 距底 0、上滚不被拽回）。详见 §5.13。**线上复验**（2026-09-16，未重做段序对照，只取指纹）：`工具调用 (` 命中 **0**（折叠开关确已删）、空态 `有什么可以帮您` 命中 1、`[data-testid="turn"]` 按轮渲染在真浏览器打线上时行为正常 |
| P26 地址即状态（v2.12，`feat/url-as-state`，PR #20） | ✅ 完成并部署（线上指纹复验 2026-09-16） | 新 `lib/route.ts`（手写 hash 路由，不引 vue-router）+ `Notice.vue`（5 秒自动消失/点击即消失）+ `App.vue` 的 `applyRoute()`（**打开会话的唯一入口**）+ `Sidebar` 改走导航（点行 push、「新对话」不再预建空会话）+ `chat.ts`（`openSession` 返回 `{ok,missing}`、新增 `goHome()`、`resumeSync` 不再自动切会话） | 单测 **269**（新增 `route.spec` 11 + `Notice.spec` 5 + `App.spec` 地址组 6，改写 `resume.spec` 3 条旧口径）+ **RED/GREEN（还原 3 个源文件 → 7 条新断言全红）** + `vite build` + **真浏览器 9/9**：刷新落原会话 / 切到 B 再刷新落 B / 返回键回 A / 无效 id → 欢迎页+裸域名+提示（5 秒消失、点击即消失）/「新对话」不新建空会话 / 跑着时切会话地址撤回不打断、刷新后接上（`phase=background`）；`pageerror` 无。详见 §5.14。**线上复验**：`该会话不存在，请重新创建` 命中 1（2026-09-16 探针） |

| P27 输入框下方提示词 + 工具调用不再上屏状态条（v2.13，`chore/input-hint-and-tool-line`） | ✅ 完成并部署（2026-09-16；其中「状态条不报工具名」一条已被 P28 四态词汇覆盖） | `InputBox.vue` 去掉常驻装饰文案，提示行只在 `steerUnsupported` 时出现（加 `data-testid`）；`RunStatus.vue` 工具相位改「正在执行工具…」**不报工具名**、撤掉 `toolPreview` tooltip（思考相位同样不报名） | 单测 **274**（新增 5 条）+ **RED/GREEN（还原 2 个源文件 → 5 条新断言全红）** + `vite build` + 产物自检（`刷新/切后台`/`Enter 发送`/`正在使用` 各 **0**，`正在执行工具` **1**）+ **真浏览器 10/10**（打真模型真工具）：输入框下方文本块为空、工具期状态条 `正在执行工具… 7.3s` 且几何上确在 textarea 上方、状态条无工具名泄漏、计时仍在走、同名工具在对话流里可见；`pageerror` 无。详见坑 65 |

| P28 四态状态灯 + 每轮一个状态戳（v2.14，`feat/turn-status-light`） | ✅ 完成并部署（2026-09-16） | 新 `lib/turnStatus.ts`（四态判据纯函数）+ `components/TurnMark.vue`（轮首戳）+ `lib/appearance.ts`（头像默认值，Settings 可覆盖）+ `chat.ts` 新增 `retryTurn()`；`RunStatus.vue` 状态行改四态且**常驻**；`ChatWindow.vue` 挂轮首戳（`markOf`）；`App.vue` Settings 加「头像」项 | 单测 **299**（新增 25 条：`lib/turnStatus.spec` 15 + `components/TurnMark.spec` 5 + 改写的 RunStatus 组件用例）+ **RED/GREEN（还原 4 个源文件 → 9 条组件级新断言全红）** + `vite build` + 产物自检（`🔵` / `正在执行工具` / `正在使用` / `刷新/切后台` 各 **0**，四态词各就位）+ **真浏览器 5/5**（打真模型真工具）：空闲 `🟢空闲中` 常驻且全屏无 🔵、发一句 `🟡忙碌中 1.4s` 且灯在动、跑完回 `🟢空闲中`、中途暂停 `🟠已中断`（不是红）、每轮都有轮首戳且历史轮保留自身状态；`pageerror` 无。详见 §5.6。**线上复验（部署后，2026-09-16）**：容器内网直问 `chatlite`，bundle `index-Dc1NuDo2.js`，四态词各就位 / 🔵=0；真浏览器打线上 5/5（`🟢空闲中`→`🟡忙碌中 1.5s` 在动→暂停`🟠已中断`→`🟢空闲中`；轮首戳 第1轮🟠/第2轮🟢；无 pageerror）；`/nope.svg`=404。探针 `/opt/data/.verify/review_0916/verify_live_turnlight.cjs` |

| P29 轮首只留头像 + 空闲词改「时刻准备着」（v2.15，`chore/avatar-only`） | 🟡 代码完成，**待合并部署** | `TurnMark.vue` → **`TurnAvatar.vue`**（改名名实相符：只画头像，删掉灯与 `markOf()`）；`ChatWindow.vue` 去掉实时相位映射（少一个派生量）；`lib/turnStatus.ts` 的空闲词 `空闲中` → `时刻准备着` | 单测 **303**（`TurnAvatar.spec` 5 条 + `ChatWindow.spec` 新增集成断言 1 条）+ **RED/GREEN（两组各自验证：还原 `turnStatus.ts` → 3 条词相关断言红；还原 `ChatWindow.vue` + 旧 `TurnMark.vue` → 轮首灯断言红）** + `vite build` + 产物自检（`时刻准备着`≥1、`空闲中`=**0**、`turn-mark-light`=**0**、`turn-avatar`≥1、`🔵`=0）+ **真浏览器**（打真模型）：轮首是纯头像、全页无轮首灯、状态行空闲 `🟢时刻准备着` / 忙碌 `🟡忙碌中 X.Xs` 在动。**撤灯的理由**见坑 70 |

图例：⬜ 未开始 / 🟡 进行中 / ✅ 完成 / ❌ 阻塞

### 0.1 跨会话续接（接手先读这段，再读对应阶段章节）

**路径**：`/opt/data/hermes-chat-lite`（远程 `git@github.com:xd6022/hermes-chat-lite.git`，主分支 `main`）
**当前进度**：P0～P3、P6（每轮统计）、P7（搜索/折叠/黑夜模式）、P8（长会话分页与合并）、P15～P19 已完成并部署（`main`）；P4 文件已写好但**必须在宿主机构建验证**（本容器没有 docker daemon）。

**分支现状**（2026-09-14 收口后）：
- `main` = `d874a9a`（PR #10）：已含 P15（移动端表格）、P16（后台恢复）、P17（空态去话术）、P18（工具内联）、P19（累计行 + ↑ 翻历史）、P20（上下文水位 + 构建标识），**且全部已部署**。
- `feat/context-gauge`、`fix/background-resume` 均已并入 main（相对 main 0 个提交）。
- `fix/scroll-anchor-stable` = P21（打开会话落点修正 + 内容分波长高的跟随）：基于 `d874a9a`，**待合并部署**。

**下一步**：① 合并 `fix/scroll-anchor-stable` → 宿主机 `docker compose up -d --build` → 真机上点开几个会话确认"都落到底部"（本容器已用真内核验过：距底全部 0）；② P5 Caddy basic_auth；③ 候选：服务端会话搜索（需改 Hermes 源码，按"不改 Hermes"原则暂不做）。

> **前端真浏览器验证已不再依赖 browser-use**：本容器 browser-use 守护进程会整体卡死，改用容器内自带的 `chrome-headless-shell` + Playwright 直连（`executablePath`）跑真实内核，方法/脚本见 §10.3；卡死时别反复重试，直接走这条。
> 现成装备（2026-09-14 备好）：内核 `/opt/hermes/.playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`
> —— **别写死目录名里的版本号**（playwright 升级会改，实测 `-1234` → `-1243`），探针里用 `readdirSync` 自动发现，见坑 66；
> 驱动 `/opt/data/.verify/pw/bin/python`（uv venv 里装的 playwright，复用上面那个内核、不用下载）。可直接抄的脚本：`/opt/data/.verify/chatlite_live/real_browser_ctx.py`（几何/配色断言）、`verify_live_dom.mjs`（jsdom 真 DOM + 真 API）、`stub_gateway.py`（本地桩：静态产物 + `/api/model-info`→9119 + 其余→8642，绑内核分配端口并自报家门）。

**可复制命令**：

```bash
cd /opt/data/hermes-chat-lite

# 依赖（已装则跳过；npm 11 必须 approve，否则 esbuild 起不来）
npm install --registry=https://mirrors.cloud.tencent.com/npm/
npm approve-scripts esbuild

# 起 dev server（key 由 vite 反代注入，前端里没有 key）
set -a && . /opt/data/.env && set +a
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173

# 自检：反代 + 鉴权是否通（期望 200 + 真实会话 JSON）
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:5173/api/sessions?limit=3"

# 类型检查 / 构建
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit
node node_modules/vite/bin/vite.js build
```

**本机特有点坑（会反复踩）**：

| 坑 | 说明 |
| --- | --- |
| `./node_modules/.bin/<x>` 被终端拦截 | 判定为"从网关内重启服务"。一律改 `node node_modules/<pkg>/bin/<x>.js` |
| npm 11 拦 postinstall | 首次装完必须 `npm approve-scripts esbuild`，否则 vite 起不来 |
| key 的变量名 | hermes 容器里是 `API_SERVER_KEY`（非 `HERMES_API_SERVER_KEY`），vite 配置两个都认，缺 key 会打印警告 |
| 8642 只在容器内网 | 本容器内可 `http://127.0.0.1:8642` 直连；对外只能经 Caddy/nginx |
| 写盘限制 | 临时/核验文件统一放 `/opt/data/.verify/` |

**验证原则**：每阶段验收都要有真实工具输出（接口真返回、构建真通过、`vue-tsc` 真无错），不接受"应该能跑"。

---

## 1. 项目结构

```
hermes-chat-lite/
├── docs/
│   ├── feasibility-analysis.md
│   └── detailed-design.md
├── src/
│   ├── api/
│   │   ├── hermes.ts          # 唯一允许发请求的地方（组件禁止 fetch）
│   │   ├── sse.ts             # POST-SSE 解析器（fetch + ReadableStream）
│   │   └── types.ts           # 与 Hermes 返回一一对应的 TS 类型
│   ├── stores/
│   │   └── chat.ts            # 轻量响应式单例（不引 Pinia）
│   ├── components/
│   │   ├── Sidebar.vue
│   │   ├── ChatWindow.vue
│   │   ├── MessageItem.vue
│   │   ├── RunStatus.vue      # 执行状态条 + 工具时间线（见 5.6，用户明确痛点）
│   │   └── InputBox.vue
│   ├── lib/
│   │   ├── markdown.ts        # markdown-it + highlight.js 实例
│   │   └── format.ts          # 时间/日期分组
│   ├── App.vue
│   ├── main.ts
│   └── style.css
├── Dockerfile
├── nginx.conf
├── docker-compose.yml
├── vite.config.ts
├── tailwind.config.js
└── README.md
```

依赖（严格限定，不引 UI 框架 / 不引状态库 / 不引 axios）：

```
vue@^3.5  typescript  vite  @vitejs/plugin-vue
tailwindcss  postcss  autoprefixer
markdown-it  @types/markdown-it  highlight.js
```

---

## 2. API 契约（实测确认，开发时按此写）

Base：生产环境走同源 `/api`、`/v1`（由 nginx 反代到 `hermes:8642`，**不配置 base URL**，避免 CORS）。开发环境用 Vite proxy 指向 `http://127.0.0.1:8642` 或任意可达地址，并注入 key。

鉴权：`Authorization: Bearer <key>`，**由 nginx 注入，前端代码里不出现 key**。

### 2.0 端点选型决策（重要，直接决定"能不能看到工具执行"）

**只使用 Hermes 原生会话端点，不使用 OpenAI 兼容的 `/v1/chat/completions`。**

原因（与 Open WebUI 的对比）：`/v1/chat/completions` 是 OpenAI 协议，Hermes 在里面**确实**发出了工具进度，但只能塞进一个自定义事件名：

```
event: hermes.tool.progress      ← 非标准事件名
data: {...}
```

Open WebUI 这类 OpenAI 兼容客户端只解析标准 `data: {"choices":[{"delta":...}]}` 帧，**遇到不认识的 `event:` 名直接丢弃**。结果就是：agent 正在跑工具、助手正文长时间为空 → 界面一片空白，用户无法判断请求到底在跑、还是已经挂了。这是"看不到 tool 执行"的根因。

而 `/api/sessions/{id}/chat/stream` 是 Hermes 原生协议，把整轮生命周期作为**一等事件**发出来（`run.started` / `tool.started` / `tool.completed` / `assistant.completed` / `run.completed` / `done`），所以本项目能真正做到"看得见执行、看得见结束"。

**结论：本项目选原生端点，不选 OpenAI 兼容端点。** 这是本设计相对 Open WebUI 的核心改进点。

**★ 反代必须清掉 `Origin` 头（实测踩坑，见 §12 第 21 条）**：Hermes 的 CORS 中间件在 `cors: false` 时会对任何携带 `Origin` 的请求返回 403 空响应。浏览器发 POST 一定带 `Origin`，所以反代（nginx / vite dev proxy）必须把它剥掉，否则真机浏览器 100% 不可用。

### 2.1 类型定义（`src/api/types.ts`）

```ts
// GET /api/sessions 返回的 data[] 元素（字段为 Hermes 的 _session_response 白名单）
export interface HermesSession {
  id: string
  source: string                 // 'tui' | 'api_server' | 'telegram' ...
  model: string | null
  title: string | null
  started_at: number             // Unix 秒（float）
  ended_at: number | null
  end_reason: string | null      // 'branched' | 'ws_orphan_reap' | null ...
  last_active: number            // Unix 秒，列表按此倒序
  message_count: number
  preview: string | null         // 首条消息摘要，列表副标题用
  parent_session_id: string | null
  pinned: boolean
  archived: boolean
  hidden: boolean
  // 其余字段（token/cost 统计）v1 不展示
}

export interface HermesMessage {
  id: number
  session_id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | Array<{ type: string; text?: string }> | null
  tool_calls: unknown[] | null
  tool_name: string | null
  timestamp: number              // Unix 秒
  finish_reason: string | null
  reasoning?: string | null
}
```

### 2.2 端点清单

| # | 方法 | 路径 | 用途 |
| --- | --- | --- | --- |
| 1 | GET | `/api/sessions?limit=50&offset=0` | 会话列表 |
| 2 | POST | `/api/sessions` | 新建空会话 |
| 3 | GET | `/api/sessions/{id}/messages?order=latest&limit=100` | 历史消息 |
| 4 | POST | `/api/sessions/{id}/chat/stream` | 发送 + 流式回复 |
| 5 | GET | `/health` | 连接状态指示（Settings 面板用） |

**1. 会话列表** 响应：

```json
{ "object": "list",
  "data": [ { "id": "20260911_183957_70912c", "source": "tui", "model": "deepseek-flash",
              "title": "开发 Hermes Chat Lite 轻量前端", "last_active": 1789123310.09,
              "message_count": 31, "preview": "/** * ====...", "pinned": false, "archived": false, "hidden": false } ],
  "limit": 50, "offset": 0, "has_more": true }
```

- 默认 `limit=50`（服务端上限 200）。第一版固定 50，不做分页加载（侧栏只显示最近 50 条足够）。
- 客户端过滤：`hidden === true` 或 `archived === true` 的不显示。
- 按 `last_active` 分组为 **今天 / 昨天 / 更早**。

**2. 新建会话** 请求 `{}`（**不要传 title**，避免唯一约束 400）→ 201：

```json
{ "object": "hermes.session",
  "session": { "id": "api_1789123400_a1b2c3d4", "source": "api_server", "title": null, ... } }
```

- 取 `session.id` 作为当前会话 id。首轮结束后 Hermes 会自动生成标题，届时刷新侧栏即可看到。

**3. 历史消息** 响应：

```json
{ "object": "list", "session_id": "20260911_183957_70912c",
  "data": [ { "id": 25180, "role": "assistant", "content": "", "tool_calls": [ ... ],
              "tool_name": null, "timestamp": 1789123327.23, "finish_reason": "tool_calls" },
            { "id": 25181, "role": "tool", "content": "{\"bytes_written\":784}", "tool_name": "write_file" } ],
  "pagination": { "limit": 100, "offset": 0, "order": "latest", "returned": 100 } }
```

- `order=latest` 时返回的是**最近的 N 条（仍按时间正序排列）**，符合聊天窗口"先看最后一段"的需求。
- `pagination.returned === limit` 说明上面还有更早的消息 → 滚动到顶部时用 `offset += limit` 再取（`order=oldest` 语义不同，第一版统一用 `order=latest` + offset 翻页，或简化为只加载最近 100 条并在顶部显示「仅显示最近 100 条」）。

> **v1 简化决策**：只加载最近 100 条，顶部显示提示条。翻页列为 v1.1。

**4. 发送（流式）** 请求：

```http
POST /api/sessions/{id}/chat/stream
Content-Type: application/json

{ "message": "帮我看看 510210 现在的盘面" }
```

字段名 `message` 或 `input` 都可以（服务端 `body.message or body.input`）。
**不要传 `model` / `provider`**（v1 不做模型切换，走 Hermes 默认模型）。

### 2.3 SSE 事件契约（开发按此写解析器）

帧格式：`event: <name>\n` + `data: <json>\n\n`，UTF-8 原文（中文不转义）。
另有每 30 秒的保活注释行：`: keepalive\n\n`（解析时忽略）。

| event | 时机 | 关键字段 | 前端动作 |
| --- | --- | --- | --- |
| `run.started` | 轮次开始 | `user_message`, `runtime` | 确认发送，可显示"连接中" |
| `message.started` | 助手消息开始 | `message.id` | 创建空的助手占位气泡 |
| `assistant.delta` | **逐字** | `delta`（增量文本） | 追加到当前助手消息 → 实时渲染 |
| `tool.progress` | 思考中/工具中 | `tool_name`, `delta` | 显示 `正在使用 write_file…` 灰字状态 |
| `tool.started` | 工具开始 | `tool_name`, `preview`, `args` | 同上（可折叠） |
| `tool.completed` | 工具完成 | `tool_name`, `preview` | 更新状态 |
| `tool.failed` | 工具失败 | `tool_name` | 状态标红，继续等待 |
| `assistant.completed` | 本轮正文结束 | `content`（**完整全文**） | 用它**覆盖**流式拼接结果，纠正分片误差 |
| `run.completed` | 轮次结束 | `messages`（整轮 transcript）, `usage`, `session_id` | 结束 loading，刷新侧栏标题；**不要渲染 `messages`**（会与正文重复） |
| `error` | 出错 | `message` | 气泡内显示红色错误 |
| `done` | 流关闭 | — | 收尾（`finally` 兜底） |

所有事件都带 `session_id` / `run_id` / `seq` / `ts`。

**事件载荷的实际精度（实测确认，别期待过高）：**

| 事件 | 实际带什么 | 不带什么 |
| --- | --- | --- |
| `tool.started` | `tool_name` + `preview`（可读摘要）+ `args`（**已做过显示脱敏的**参数） | 参数全文 |
| `tool.completed` | **只有 `tool_name`**（服务端按 `(name, None, None)` 发出） | 执行结果 / 耗时 / 成功与否 |
| `tool.progress` | `tool_name` + `delta`；模型思考时 `tool_name === "_thinking"`，`delta` 是思考首行 | 完整思考内容 |
| `run.completed` | `messages`（整轮 transcript，**含工具结果**）+ `usage` | — |

→ 想要"工具执行结果"（如 `write_file ✓ 784 bytes`），只能在 `run.completed` 到达后从 `messages` 里按 `tool_call_id` 回填时间线，**但不要把 `messages` 渲染成聊天消息**。

### 2.4 token 口径（实测核对，做每轮统计必须按这个来）

三个数字来源不同、语义不同，混用必然算错：

| 来源 | 语义 | 实测核对 |
| --- | --- | --- |
| `run.completed.usage.input_tokens` | **本轮总输入**（临时值，不累计） | 连发两轮分别 27311 / 27330，量级相同 → 确认是每轮值 |
| 会话记录 `input_tokens` | **累计**【未命中缓存】的输入 | 两轮后 1393 = 687 + 706 |
| 会话记录 `cache_read_tokens` | **累计**【命中缓存】的输入 | 两轮后 53248 = 26624 + 26624 |

**自检恒等式（实测精确成立）**：

```
本轮未命中Δ + 本轮命中Δ === 本轮 usage.input_tokens
706        + 26624      === 27330   ✅
```

所以每轮统计 = 会话记录做差（拿缓存分项）+ usage（拿本轮总量）。缓存命中率 = 命中Δ ÷ (未命中Δ + 命中Δ)。
**另外实测：`run.completed` 到达时会话记录已经是新值**（立即读 == +1.2s 再读），不需要等待或重试。
失败降级：会话记录读不到时，缓存率留空，耗时/输入/输出照常显示。

---

## 3. api 层设计

### 3.1 `src/api/hermes.ts`（组件禁止直接 fetch）

```ts
const BASE = ''            // 空字符串 = 同源；开发环境由 vite proxy 兜住

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new HermesApiError(res.status, await readErrorMessage(res))
  return res.json() as Promise<T>
}

export function getSessions(limit = 50): Promise<SessionListResponse>
export function createSession(): Promise<{ object: string; session: HermesSession }>
export function getMessages(sessionId: string, limit = 100): Promise<MessageListResponse>
export function health(): Promise<{ status: string; version?: string }>
export function streamChat(              // 见 3.2
  sessionId: string, message: string,
  handlers: SseHandlers, signal?: AbortSignal,
): Promise<void>
```

错误处理约定：把后端 `{ error: { message, code } }` 提取为可读文案；`401` → "访问口令/接口密钥无效"；`404` → "会话不存在（可能已被删除）"；`409` → "会话已存在，请新建"。

### 3.2 `src/api/sse.ts` —— POST + SSE 解析（本项目的核心难点，约 120 行）

`EventSource` 只能 GET，所以必须手写：`fetch` + `ReadableStream` + `TextDecoder`。

关键实现要点：

```ts
export async function postSse(
  url: string, body: unknown, onEvent: (name: string, data: any) => void, signal?: AbortSignal,
) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  })
  if (!res.ok || !res.body) throw new Error(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // 帧以空行分隔；\r\n\r\n 也要兼容（nginx 一般不改，但保险）
    const frames = buf.split(/\r?\n\r?\n/)
    buf = frames.pop() ?? ''               // 最后一段可能是半帧，留到下一轮
    for (const frame of frames) {
      if (!frame || frame.startsWith(':')) continue      // 跳过 keepalive 注释
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (!dataLines.length) continue
      try { onEvent(event, JSON.parse(dataLines.join('\n'))) } catch { /* 半帧 JSON，忽略 */ }
    }
  }
}
```

必须遵守的 4 条：
1. `decoder.decode(value, { stream: true })` —— 否则中文多字节字符被切断会乱码。
2. 按空行切帧、**最后一段留回缓冲区** —— 否则 JSON 被截断。
3. 跳过 `:` 开头的注释帧（服务端 30s 一次 keepalive）。
4. `data:` 后只 trimStart，不要 trim 掉正文里的换行（多行 data 用 `\n` 拼回）。

### 3.3 `nginx.conf` 的关键点

- `/api/` 与 `/v1/` 反代到 `http://hermes:8642`，并 `proxy_set_header Authorization "Bearer <key>"`；
- **`proxy_set_header Origin "";`（必须，最容易漏，实测踩过）** —— Hermes API Server 的 CORS 中间件对**任何带 `Origin` 头的请求直接返回 403 空响应**（防 CSRF 设计）。浏览器所有 POST 都带 `Origin`，curl 不带 → 命令行测试全绿、真机浏览器全挂。nginx 语义：请求头设为空字符串 = 不向后端传递。
- **`proxy_buffering off;`（必须）** —— 否则 nginx 会缓冲整个 SSE 响应，流式变一次性；
- `proxy_read_timeout 3600s;`（agent 单轮可能跑很久）；
- `proxy_http_version 1.1;` + `Connection ""`；
- `X-Accel-Buffering: no` 服务端已带，双重保险；
- `gzip off;`（对 SSE 无用且可能引入缓冲）；
- 静态资源：`try_files $uri $uri/ /index.html;`（Vue history 模式）。
- **静态资源"缺文件"必须真 404（v2.10 加固）**：`location ~* ^/[^/]+\.(?:ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|map|webmanifest)$ { try_files $uri =404; }` —— 否则 `location /` 的 `try_files $uri $uri/ /index.html` 会把不存在的 `/favicon.svg` **也**回成 **200 + 入口 HTML**，于是"文件压根没打进镜像"这种错**在浏览器和 curl 里都看不见**（实测栽过：一度误判成浏览器缓存，真凶是 Dockerfile 漏了 `COPY public/`）。
  正则**锚在根层**（`^/[^/]+\.`）是有意的：不锚会抢走 `/assets/x.woff2`、`/assets/x.svg` 这类 vite 产物、**绕过 `/assets/` 那条一年 immutable 缓存头**（缓存行为悄悄退化）。

key 通过环境变量注入：镜像里给 nginx 用 `envsubst` 模板，或用 `docker compose` 的 `env_file` 生成。**key 只存在于宿主机 .env 与容器环境变量中**。

---

## 4. 状态层（`src/stores/chat.ts`）

不引入 Pinia，用 `reactive` 单例（约 80 行）：

```ts
export const store = reactive({
  sessions: [] as HermesSession[],     // 侧栏
  currentId: null as string | null,    // 当前会话
  messages: [] as UiMessage[],         // 当前会话已渲染消息
  streaming: false,                    // 生成中（控制输入框禁用 + 停止按钮）
  error: null as string | null,
  run: {                               // 本轮执行状态（RunStatus.vue 用，见 5.6）
    phase: 'idle' as 'idle'|'thinking'|'tool'|'writing'|'done'|'aborted'|'error',
    startedAt: 0,                      // performance.now()
    endedAt: 0,
    currentTool: null as string | null,
    toolPreview: null as string | null,
    timeline: [] as { name: string; preview?: string; status: 'run'|'ok' }[],
    errorMessage: null as string | null,
  },
})

export interface UiMessage {
  key: string                 // 本地 key（服务端 id 或 temp-uuid）
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean         // 逐字渲染中 → 显示光标动画
  toolStatus?: string | null  // "正在使用 write_file…"
  error?: string | null
}
```

关键动作：

| 动作 | 行为 |
| --- | --- |
| `loadSessions()` | 调 `getSessions()`，过滤 hidden/archived，按 last_active 倒序 |
| `openSession(id)` | 设置 currentId → 清空 messages → `getMessages()` → `normalize()` → 渲染 |
| `newChat()` | `createSession()` 拿 id → currentId=id，messages=[]（**不发消息就不落库**） |
| `send(text)` | ① 乐观插入 user 气泡 ② 插入空 assistant 气泡 ③ `streamChat()` ④ 事件驱动更新 ⑤ finally 刷新侧栏 |
| `stop()` | `AbortController.abort()`；服务端会因断连打断本轮 |

`normalize(raw: HermesMessage[]): UiMessage[]` 过滤规则（**必须实现**）：
1. 丢掉 `role` 不是 user/assistant 的（tool / system）；跳过压缩摘要消息。
2. assistant 且 `content` 为空 → 丢弃（工具调用轮）。
3. `content` 是数组 → 取 `type === 'text'` 的 `text` 拼接。
4. 按 `timestamp` 正序。

---

## 5. 组件设计

### 5.1 `App.vue`（布局骨架）

三段式：顶部栏（侧栏开关 + `Hermes` + 连接状态点 + **主题切换** + Settings 按钮）/ 主体（Sidebar 240px + ChatWindow 自适应）/ 输入区在 ChatWindow 内部底部。

- **一个按钮管两种形态**（`toggleSidebar()`，不按 viewport 分两个按钮渲染——桌面上出现"两个汉堡"很蠢）：
  - 桌面（`≥768px`）：切换侧栏折叠/展开，选择记在 `localStorage['hcl.sidebar']`（`'1'`/`'0'`），刷新后保持。
  - 移动端（`<768px`）：打开抽屉（选中会话后自动关闭）。
  - 判据：`window.matchMedia('(min-width: 768px)')`，`matchMedia` 不存在时退回 `innerWidth >= 768`（测试环境要用）。
  - 按钮 `aria-label`/`title` 随状态变化（`折叠会话列表` ↔ `展开会话列表`），否则 hover 提示会说反。
- 折叠态实现：Sidebar 根节点加 `md:hidden`（`display:none` 优先于 `md:static`，不必动宽度动画）。

### 5.2 `Sidebar.vue`

- 顶部一行（高度压缩，不再是整行大按钮）：**搜索框（占满）+ 新建图标按钮**。
  - **搜索是客户端过滤**：Hermes API **没有**搜索端点（实测 `/api/sessions` 只认 `limit/offset/source/include_children`；库里虽有 FTS5 索引，但只喂给 CLI 的 `hermes sessions browse`）。所以对已取到的会话做 `title / preview / id` 不区分大小写匹配。
  - 取数取满服务端上限 200 条（`loadSessions()`），**少取一条就等于搜不到那一条**。
  - 命中时显示 `找到 N 个`；无命中显示 `没有匹配「关键字」的会话`（不留空白）；有 `✕` 清空按钮；`Esc` 也可清空。
- 新建会话入口降级为图标按钮（`aria-label="新对话"`），因为**发送消息时如果还没有会话会自动建一个**（`send()` 里 `if (!store.currentId) await newChat()`），所以入口不需要抢视觉权重。
- **行内操作（v1.5）**：每行右侧两个图标按钮 —— **重命名**（原位变输入框）与**删除**（原位二次确认，文案带标题）。
  - 移动端**常显**（触屏没有 hover，关键操作必须直接可见）；桌面端默认 `invisible`（看不见也就点不到，且不占额外宽度），hover 该行才出现。原先进度时间挪进了标题的 `title` 提示里，把空间让给操作。
  - **行不能用 `<button>` 包裹**：按钮里嵌按钮是非法 HTML、事件也会乱。行改成 `<div class="group flex">`，标题是内部的 `<button class="flex-1">`，操作用兄弟节点。
  - 行内 **template ref 会变数组**（v-for 内的 ref 都是数组），聚焦编辑框改用 `data-edit-id` + `querySelector`。
  - 正在流式输出的**当前会话**禁止改名/删除（服务端那一轮还在写它）；其它行不受影响。
  - **点外面 / Esc 自动收起（v1.6）**：进入改名或删除确认后，点右侧对话区、点别的会话、按 Esc 都会自动退出该状态，不必再手点 ✕/取消。
    - 实现用 **document 捕获阶段的 click**，判断目标是否落在"当前那一行"（行上有 `data-row-id`）：
      行内 → 不取消（交给按钮自己的逻辑）；行外 → 取消，且那个地方的正常逻辑照常执行（例如顺手切到别的会话）。
    - **不要用 input 的 `blur` 实现**：点"保存/取消"按钮时 blur 先触发 → 编辑态被关掉 → 按钮的 click 落空（保存静默失效）。捕获阶段先于目标自身处理执行，顺序天然正确。
    - 监听器随状态挂/卸（`watch(activeRowId)`），`onBeforeUnmount` 里兜底移除，避免重复绑定。
- 分组渲染：`今天` / `昨天` / `更早`（依据 `last_active`，用 `Intl.DateTimeFormat` 判定自然日差）。
- 单条：主行 title（空则显示 `preview` 前 30 字，再空则显示 `未命名会话`），副行不显示（保持简洁）；悬浮时右侧出现小字时间。
- 当前会话高亮（浅灰底；深色下 `dark:bg-gray-700/70`）。
- 空态：无会话 → `还没有会话，直接在下方输入即可开始`；加载态 → 骨架屏 5 行（不要 spinner 全屏遮罩）。

分组计算放在 `lib/format.ts`，用同一个函数产出 `{label, items}[]`。

### 5.3 `ChatWindow.vue`

- 消息列表容器：`max-width: 768px; margin: 0 auto;`（需求指定）。
- **不使用气泡**：用户消息 = 右侧淡灰圆角块（仅用户侧），助手 = 纯文本流（贴近 ChatGPT）。
  - 折中说明：需求 6.2 说"不使用聊天气泡"，指的是助手侧不要大框；用户消息保留淡背景块以区分角色，若您希望更彻底可全文本流 + 角色小标题，实现上是个开关。
- 自动滚动：仅当用户已在底部附近时才自动跟随（避免用户翻历史时被强行拽回）。
- 空会话态：居中显示 `有什么可以帮您？` + 3 条示例（点击填入输入框，不自动发送）。
- 底部：`InputBox`，上方一条 1px 分割线。

### 5.4 `MessageItem.vue`

- **助手消息**：
  - 流式中：渲染已到达文本 + 末尾闪烁光标（`▍`，CSS 动画），`toolStatus` 以灰字小行显示在正文上方。
  - 完成后：整段 markdown 渲染。
  - **完成后追加一行统计页脚**：`⏱ 3.6s · 输入 27.3k · 缓存 26.6k (97%) · 输出 20`（数据来自 `TurnStats`，见 §2.4 口径）。缓存率取不到时该段自动省略。
- **用户消息**：纯文本（`white-space: pre-wrap`），不解析 markdown（避免误触发代码高亮），保留换行。
- 代码块：`<pre><code class="hljs language-x">`，右上角"复制"按钮（`navigator.clipboard`），等宽字体。
- markdown-it 配置：`linkify: true, breaks: true, html: false`（**html:false 是安全项**，防止 agent 输出里的原始 HTML 注入）。代码高亮用 `highlight.js` 在 `highlight` 回调里调用，失败则 fallback 为转义纯文本。
- **表格外层套 `.table-wrapper`（v2.1）**：渲染器重写 `table_open`/`table_close`，产出 `<div class="table-wrapper thin-scroll"><table>…</table></div>`。为什么必须在渲染层做、为什么不放在 `decorate()` 里包 DOM，见 `lib/markdown.ts` 的注释与坑 43；样式契约见 §6 与 §10.3。
- 性能：流式期间对同一气泡做**节流重渲染**（`requestAnimationFrame` 每帧最多一次 `v-html` 更新），长回复不会掉帧。

### 5.5 `InputBox.vue`

**布局（v1.4 改，对齐 ChatGPT）：文字区与按钮上下两段，不并排。**

```
┌───────────────────────────────┐
│ 文字区（占满整宽，可顶到最右）  │
│                       [发送]  │ ← 工具行
└───────────────────────────────┘
```

早期版本是 `textarea(flex-1)` + 按钮左右并排（`flex items-end`），副作用是按钮占住右下角、文字到按钮左缘就断行 —— 输入长内容时按钮上方一片空白，观感像"这个角落必须留空"。改成两段后文字区 `w-full` 一路顶到容器右侧。

- 工具行（`flex items-center justify-end gap-1 pt-1`）是按钮集合位；以后加语音/附件按钮就放这里，左侧用 `justify-between` 分区。
- `autoGrow()` 的最大高度要**减掉工具行高度**（`TOOLBAR_PX = 40`），否则算出来的高度会把按钮顶出容器。
- 其余规则不变：Enter 发送 / Shift+Enter 换行 / 中文输入法 `isComposing` 期间绝不发送 / 生成中只把发送换成"停止"而不禁用输入。

- `textarea` 高度自适应（`scrollHeight` 计算，上限 40vh 再减掉工具行高），超出后内部滚动。
- 生成中：发送按钮变「停止」，点击 `stop()`；**输入框保持可输入**（只禁用发送，方便先打下一句），Enter 不再触发发送。
- 输入框下方小字：**只在"当前通道不支持补充"时出现一句功能警告**（2026-09-16 起）。原来那句常驻的
  `刷新/切后台不会取消任务（回来会自动同步） · Enter 发送 / Shift+Enter 换行` 已去掉 —— 它那两段各有归属
  （前者 `RunStatus` 的 `background` 相位在真发生时会说，后者 Settings 的「快捷键」小节已列出），
  留在输入框下面纯属噪音。去掉的是**装饰**，功能警告一个字不动。

### 5.6 `RunStatus.vue` —— 执行可观测性（针对 Open WebUI 的核心痛点）

目标：任何时候用户都能回答两个问题——**"现在在干什么？"** 和 **"这轮到底结束了没有？"**

**状态行**（位于输入框上方，**常驻**一行；2026-09-16 起只有**四个状态**）：

| 灯 | 状态词 | 什么时候 | 判据（全在 `lib/turnStatus.ts`） |
| --- | --- | --- | --- |
| 🟢 | `时刻准备着` | **默认态** —— 没有在跑的任务。就是用户要的 `Ready` 式正向信号 | `phase === 'idle'` 或 `'done'` |
| 🟡 | `忙碌中 {secs}s` | 这一轮在跑；灯**在动**（`animate-pulse`） | `thinking` / `tool` / `writing` / `background` |
| 🟠 | `等待审批` 或 `已中断` | 等你介入，或这一轮被停 | `approval` / `aborted` |
| 🔴 | `失败（请重试）` 或 `失败` | 出错、后端不可用 | `error`；**`runId === null` 时才给「重试」按钮** |

**四条硬口径（改这一节之前先读）：**

1. **正文结束就回到 🟢 `时刻准备着`**（状态词是用户 2026-09-16 亲口定的，正合 `Ready` 那个正向信号的意思）⇒
   状态行**常驻**：不再"空闲时隐藏"，也没有"停留 N 秒后收起"那套逻辑。
2. **灯不看工具**（用户原话："不记录工具，不记录是否在调用工具，第一版做最简单的"）⇒
   状态词里没有工具名，**词汇表里没有蓝色**（🔵 已整条撤掉）；工具行也**不动**（保持 v2.11 现状）。
3. **红灯的判据**：只有 `phase === 'error'` 才红。
   **"连接断了但服务端还在跑"（`background`）是 🟡 忙碌中，绝不红** —— 切后台/锁屏/换网是常态，
   报红会让人以为跑着的长任务白费了（2026-09-13 真机纠偏过这条）。
4. **「重试」只在 `runId === null` 时给**（服务端**根本没收到**才重发；已收到、可能已落库 ⇒ 重发会出现两条输入）。
   点击走 `retryTurn()`（`stores/chat.ts`）：撤回最后那条乐观用户消息（`splice`）+ 清 `bootError` + 原样重发。

**轮首头像**（`TurnAvatar.vue`，2026-09-16）：每一轮开头只放一个 `{头像}`（默认 `-_-`）。
- **这里不挂状态灯**（原来挂过，后来撤了，见坑 70）—— 状态只由上面那条状态行说。
  它只回答"**这是谁说的**"。
- 头像默认值在 `lib/appearance.ts` + Settings 可覆盖（存浏览器，**改完立刻生效、不用重新构建**）。
- 因为不再随状态变色，原来"必须固定一行高、跑完只换颜色"那条约束**自动消失**（静态元素不会抖）。

**完成态判定（必须显式，不能靠"没动静了"猜）：**

| 情况 | 判定 |
| --- | --- |
| 收到 `run.completed` | ✅ 完成 |
| 收到 `done` 但没收到 `run.completed` | ⚠️ 中断 |
| 收到 `error` | ❌ 失败，显示 `message` |
| 流关闭（`reader.read()` done）且以上都没有 | ⚠️ 中断 |
| 超过 5 分钟无任何事件 | ⚠️ 超时提示（**不自动中断请求**，可能确实在跑长命令） |

**工具时间线**：**不在这个组件里**（v2.3 去掉这里的折叠块；2026-09-16 连状态条上的工具名也一起去掉）。
工具按真实先后**内联渲染在对话流里**（v2.11 起的常驻小字行：`●/✓/✗ 名称 "参数预览" (耗时)`，见 §5.13 与 `MessageItem`），
`run.completed` 到达后从 `messages` 里按 `tool_call_id` 回填状态 ✓/✗。
这是"看清楚这轮干了什么"的地方，也是 Open WebUI 完全缺失的部分 —— 但它属于**对话流**，不属于状态条。

**注意**：计时器用 `performance.now()` 本地算，不要依赖事件里的 `ts`（时钟/网络抖动会让它跳变）。

**阶段切换规则（实测得出）**：一旦进入「正文生成」(`writing`)，**不因迟到的 `tool.progress` 降级回「思考中」** —— 实测事件顺序里 `tool.progress`（reasoning.available）会晚于首个 `assistant.delta` 到达，若不做保护，状态条会在正文已经开始输出时倒回"正在思考"。

### 5.7 Settings（最小化，不做模型切换）

点顶部「Settings」右侧滑出小面板，只有四项：
1. 连接状态：绿点 + `Hermes v0.20.4`（数据来自 `GET /health`）+ 刷新按钮。
2. **外观**：当前主题（白天/黑夜）+ 切换按钮（等同顶栏那个按钮）。
3. 关于：版本号、一组快捷键说明。

### 5.8 侧栏搜索 / 桌面折叠 / 黑夜模式（v1.1 追加）

**黑夜模式**——三处必须同时改，否则会出现"切了没反应"或"刷新闪白"：

| 位置 | 作用 |
| --- | --- |
| `index.html` 内联脚本 | **首帧之前**读 `localStorage['hcl.theme']` 给 `<html>` 加 `dark` 类。少了它，深色用户每次刷新都会闪一下白屏（FOUC） |
| `src/lib/theme.ts` | 运行时切换：`initTheme()` / `toggleTheme()` / `setTheme()`；同步 `<html class>`、`color-scheme`、`<meta name="theme-color">` |
| `tailwind.config.js` `darkMode: 'class'` | 所有 `dark:` 变体的开关。配错（用默认 `media`）会**静默丢掉全部 `dark:` 类**，界面看起来"完全没变" |

口径：**手动选择 > 系统偏好**。没有手动选择时跟随 `prefers-color-scheme`，且此时**不写 localStorage**（写回会把"跟随系统"冻死成当前值，系统改主题就再也追不上）。

代码高亮暗色：`highlight.js` 的 `github.css` 是浅色专用，且 CSS 不支持给 `@import` 加作用域 —— 不能再引一份 `github-dark.css`（它会把整个文件的选择器都带上，浅色下也生效）。做法是在 `style.css` 里手写一份 `.dark .hljs-*` 调色板（约 30 行），靠选择器优先级覆盖 `github.css`。

**明确不做**：模型切换、Prompt 管理、Agent 配置（需求第七条禁止项）。

### 5.9 历史分页与消息合并（v1.2 追加）

**起因**（用户反馈）：「打开这个会话，最上面的消息只能到中间某一条」+「页面展示像自动加了换行」。两个都是真问题，各有明确根因。

**① 分页语义（实测 2026-09-11，本机 hermes:8642）**

| 项 | 实测结论 |
| --- | --- |
| 合法 `order` | 只有 `oldest` / `latest`；传 `earliest` 直接 **400** —— `order must be one of: oldest, latest` |
| `order=latest` + `offset=N` | 从**最新往回数**第 N 条起的一页；页内按时间正序；不同 offset 的窗口**不重叠** |
| `limit` 上限 | messages 接口实测 **500**（传 1000 会被夹到 500） |
| 总数 | 接口**不返回 total**，只能靠「返回条数 == limit」判断可能还有更早的 |

选 `latest`+`offset` 而不是 `oldest`：首屏要的就是"最新一页"，用 `oldest` 得先知道总数（接口不给）。代价是 offset **锚定在"最新"** —— 发过新消息后窗口整体后移、与已加载内容重叠，**必须按 id 去重**。

**② 去重不能用 `store.messages` 里的 srcId**（自测踩到）：连续 assistant 合并后，一个界面消息只保留该组**最后一条**的 id，中间 id 从界面上消失 → 去重漏掉它们，同一段内容会被加载两次。必须单独维护模块级 `loadedIds`（`openSession` 时重置）。

**③ 合并连续 assistant**（`normalize` 最后一步、`prependEarlier` 在分页边界补一次）：一次工具轮次里模型可能说好几段话，transcript 就是连续多条 assistant（实测本会话有一条 **19 条连续**）。分开渲染 = 段间 24px 间距 + 复制出来多空行，读起来就是"自动加了换行"；合并成一段后与流式时的观感一致（流式本来只有一块）。

**④ 压缩摘要消息要认出来**：Hermes 上下文压缩会在 transcript 留下一条内部机制消息（实测 11890 字符、`role=assistant`）。它既不是对话内容、也不该被合并进正文 → 标记 `compaction` 后渲染成折叠块。判据**照抄 Hermes 自身实现**（`api_server.py:439 _is_compressed_summary_message` / `context_compressor.py:376-382`）：**取前 280 字符做包含判断**。不要自己写 `startsWith('[CONTEXT COMPACTION')` —— 真实那条消息开头是 `[PRIOR CONTEXT — for reference only…]`，标记在 100 字符之后，startsWith 会漏判。

**⑤ 怎么验证的（可复现，这是本项目最强的一种验证）**：写一次性 spec，用**未改动的 store 源码**打真实 API（包装 `globalThis.fetch`：相对路径改写成 `http://127.0.0.1:8642` + 注入 `Bearer`，即 nginx 在生产做的那件事），逐页 `loadEarlier()` 到没有更早，再断言 `store.messages` 与「一次全量读后 `normalize`」的结果 **`toEqual` 逐字段相等**。这一条断言同时覆盖漏、重、边界合并三类错误。实测该会话 206 条原始消息 → 15 条界面消息，偏移位移造成的重叠被正确去重。

```bash
cd /opt/data/hermes-chat-lite
set -a && . /opt/data/.env && set +a
npx vitest run src/xxx.verify.spec.ts     # 临时核验脚本：跑完就删，别混进 npm test
```

**副作用提示**：合并后「界面消息数」≠「transcript 条数」（该会话 206 → 15）。客服式对账、截图比对时不要拿界面条数当借口数。

**⑥ 划到顶自动加载**（v1.3）：`onScroll` 里判 `scrollTop <= 60px` 就直接调 `earlier()`，滚轮和触摸都走同一条路径。

- 阈值取 60 而不是 0：贴到 0 才开始加载，用户会先看到一段空档再蹦出新内容。
- **不会重复请求**：`loadEarlier()` 自身有 `historyLoading / hasMoreHistory / streaming` 三重闸门；而且加载后的 `scrollTop` 补偿会把位置推出阈值，天然形成"一次滚动只加载一页"。
- **按钮必须保留**（别当成冗余清理掉）：内容不足一屏时**不产生滚动事件**，自动加载永远等不到 —— 那个场景只能点按钮。按钮同时是"加载中…"的反馈位。
- 滚动监听用 `@scroll.passive`（不调 preventDefault，被动监听让浏览器滚动更顺）。

### 5.10 会话管理：改名与删除（v1.5 追加）

**先实测再动手**（2026-09-11，本机 hermes:8642，全部操作只作用于探针会话）：

| 项 | 实测结论 |
| --- | --- |
| 改名 | `PATCH /api/sessions/{id}` body `{"title":"…"}` → 200 + 返回更新后的 session；GET 读回一致 |
| **标题唯一约束** | 重名 → **400** `Title 'x' is already in use by session <id>`（code `invalid_title`） |
| **标题长度上限** | **100 字符**；200 字 → 400 `Title too long (200 chars, max 100)` |
| 空串 / `null` | **合法**，等于清空标题（界面回落到显示 `preview`） |
| 其它可 PATCH 字段 | `pinned` / `archived` / `hidden` / `unread`（布尔，给字符串 400）、`end_reason`；白名单外字段 400 `Unsupported session fields` |
| 删除 | `DELETE /api/sessions/{id}` → 200 `{"object":"hermes.session.deleted","id":…,"deleted":true}` |
| 删除的边界 | 再删一次 / 删不存在的 id → 404；删完 GET 立刻 404、列表立刻消失 |
| **批量删除** | **没有**这个端点（路由表 + `/v1/capabilities` 都没有）→ 想批量只能前端循环，**不做** |

**会不会被自动标题覆盖？不会。** `hermes_state.py:8161 set_session_title()` 的注释明确写着它会记 `user` 来源（provenance）：*"records user provenance, so auto-titling will never replace the result"*。自动标题走 `set_auto_title()`，受来源优先级约束。
（例外：把标题**清空**后会话变回"无标题"，自动标题只在最初几次交换附近触发，所以老会话不会被重新起名、新会话可能被起名。）

**安全纪律（继承 2026-09-11 那起不可恢复的误删事故）**：

1. **只做单个删除**：入口是"点中某一行 → 原位二次确认 → 删这一行"。**不做**批量、不做"删除全部搜索结果"、不做按 `source`/条件删除。
2. **确认文案必须带标题**（`删除「标题」？`）：删之前要能看清删的是谁。
3. 确认区常驻一句 `不可恢复（含全部消息）`：`DELETE` 是硬删除（会话 + 消息一起没，MySQL 归档 cron 每天 21:00 才一次）。
4. 删掉的若是**当前打开的会话** → `currentId` / `messages` / 分页游标全部清空回到空态，不留已失效的 id。
5. 失败不静默：删除失败在行内显示红字；改名失败（重名/超长）也**保持编辑态**就地报错，并把服务端文案翻成人话（原文带占用者 session id，对用户无意义）。

**不改用原生 `prompt` / `confirm`**：用户明确反感原生弹窗，一律原位编辑 + 原位确认。

#### 删除后的"空壳残留"（服务端缺陷 + 客户端兜底，v1.7）

**现象**：删掉的会话过一会儿又出现在列表里，标题是刚生成的那个，点进去 0 条消息。

**复现**（`/opt/data/.verify/repro_ghost_session.mjs`，稳定复现）：建会话 → 跑一轮 → 立刻删 → 0.5s 内同一 id 冒出一行新记录：

```
source="unknown"  title_source="llm"  message_count=0  started_at=删除后约 1 秒
```

**根因**（读码定位）：`hermes_state.py:7506`，`update_token_counts()` 在轮次结束后**异步**写 token 前会先调 `_insert_session_row(session_id, "unknown", ...)`「确保行存在」（注释原话：避免 UPDATE 静默影响 0 行），而那是 upsert —— 会话若已被删，行就被**重建**出来；随后迟到的异步标题写入正好落到这具空壳上。跟标题写入无关（`_set_session_title` 是纯 UPDATE，造不出行），删除本身也是干净的两条 DELETE。

**为什么改不动**：`/opt/hermes` 是 **root:root 755**，agent 以 uid 1000 `hermes` 运行且**没有 sudo** → 写不进去，写保护根也限制在 `/opt/data`。

**两手都要**：

1. **客户端兜底（已实现，不依赖服务端）**：`removeSession()` 删完 2s 后复查一次 `GET /api/sessions/{id}`，还在就再删一次并把本地列表里的空壳清掉；404 则什么都不做，失败静默。实测状态序列 `0.4s:200 … 1.6s:200 → 2.0s:404 → 之后恒 404`，`state.db` 行数 0 —— 连 TUI/仪表盘列表里的同一具空壳也一起清了。
2. **服务端根治（待宿主机应用）**：补丁脚本 `/opt/data/.verify/apply_ghost_fix.py`（墓碑集合：删除时登记 id、`_insert_session_row` 见到墓碑直接返回、`create_session` 解除墓碑；4 处锚点带唯一性断言，`--check` 可先看 diff，原文件已备份到 `/opt/data/backups/hermes_patches/`）。应用后需重启 gateway：`/command/s6-svc -t /run/service/gateway-default`（api server 就跑在 `hermes gateway run --replace` 这个进程里）。

#### 被安全闸门拦下时说人话（v1.8）

旧通道 `chat/stream` 上没有审批接线（审批只在 `/v1/runs`），需要人工批准的工具会被 **fail-closed 直接拒**。原来界面只显示一个 ✗，用户看不懂发生了什么。（默认通道 `/v1/runs` 不会走到这里 —— 它会弹审批卡片等人回话。）现在：

- **数据来源**：`tool.failed` 事件**只带工具名、不带结果**（实测载荷 `message_id, tool_name, preview, args`），所以原因只能从 `run.completed.messages`（整轮 transcript）里捞 `role=tool` 的原文 —— 真实链路已核验：该字段确实带完整工具输出（简单一轮 2.0 KB），且正常轮次不会误报。
- **判据**：`lib/security.ts` 的 `securityBlock()`，匹配服务端 `tools/approval.py` 的**真实文案**（`approval required` / `Failed to send approval request` / `without user response` / `User denied this potentially dangerous action` → 审批类；`flagged as dangerous` / `hardline` / `deny rule` → 规则类），并给出对应的人话解释 —— **审批类按通道分文**（`securityBlock(text, transport)`，`transport` 由 `stores/chat.ts` 的 `sendTransport()` 传入）：默认通道 `/v1/runs` 下说明"没等到您的回应（超时）/ 您点了拒绝"，回退通道 `chat/stream` 下说明"这条路上没有审批接线，当场拒绝"）。
- **展示**：`RunStatus.vue` 在状态条下方出一个琥珀色卡片（标题 + 解释 + 服务端原文片段截断 240 字符），随 `resetRun()` 在下一轮开始时清掉。



---

### 5.11 发送链路迁到 `/v1/runs`（v2.0 追加，A 方案）

**为什么换**：旧通道 `POST /api/sessions/{id}/chat/stream` 上 Hermes **没有接审批线**
（`register_gateway_notify` / `_run_approval_sessions` / `approval.request` 事件全在
`_handle_runs`（即 `POST /v1/runs`）里，`_create_agent` 零接线）→ 网页端撞上审批只能
fail-closed 直接拒。换到 `/v1/runs` 后网页端**第一次能批准/拒绝危险操作**，并顺带拿到
"中断正在跑的一轮"（`POST .../stop`）与"引导"（`.../steer`）。
**Hermes 源码一行未改**（`/v1/runs` 是它自带能力，我们之前只是没用它）。

**两条通道的差异**（全部差异都在 `stores/chat.ts` 的 `applyEvent()` 与 `api/runs.ts` 里抹平）：

| 维度 | 旧 `chat/stream` | 新 `/v1/runs` |
|---|---|---|
| 提交与订阅 | 一个 POST 内同时完成 | `POST /v1/runs`(202) 先拿 `run_id` → `GET /v1/runs/{id}/events` |
| 流式打字 | `assistant.delta` | `message.delta` |
| 思考提示 | 伪工具 `tool.progress{tool_name:'_thinking'}` | 独立事件 `reasoning.available` |
| 工具事件字段 | `tool_name` | **`tool`**（`tool.completed` 另带 `duration`/`error`） |
| SSE 帧 | 有 `event:` 行 | **没有 `event:` 行**，事件名在 JSON 的 `event` 字段里 |
| 终稿 | `assistant.completed.content` | `run.completed.output` |
| 权威 transcript | `run.completed.messages` | **没有该字段** → 轮末回读会话对账 |
| 失败原因 | `error` 事件 | `run.failed{error}` / `GET /v1/runs/{id}` 的 `status` |
| 中断 | 断开连接 | `POST /v1/runs/{id}/stop` → `run.cancelled` |
| 审批 | 无（fail-closed） | `approval.request` → `POST /v1/runs/{id}/approval` |
| 事件流可重连 | 否 | 否（消费后队列即被丢弃，重连 404） |

**回退开关**：`setSendTransport('stream')`（默认 `DEFAULT_TRANSPORT = 'runs'`）。
两条通道共用同一套事件归约器与收尾逻辑，切回去行为与 v1.8 一致（有单测锁）。

**审批卡片**（`RunStatus.vue`）：显示工具名 + 被标红的命令原文 + 选项
（批准一次 / 本会话都允许 / 永久允许 / 拒绝 —— 按服务端 `choices` 与 `allow_permanent`
决定显示哪些），回话后显示"已回话：…"，失败（如 409 已过期）在卡片内红字提示且可重试。
等待期间状态条是"等待你批准：<工具>"、计时继续走 —— 这一轮**卡住不会自己往下跑**。

**轮末回读对账**（`reconcileTurn()`）：轮次结束后补一次 `GET /api/sessions/{id}/messages`，
用服务端落库的数据校正 ① 正文（合并本轮所有 assistant 段，顺带抹掉 delta 的前导换行杂质）
② 安全闸门原文 ③ 工具时间线补齐。若事件流中途断了（且 `GET /v1/runs/{id}` 显示还在跑），
界面标注"事件流中断，本轮内容已从会话记录回读补齐"。

**安全边界**：会话上的审批授权按 `run_id` 隔离（服务端行为），所以"本会话都允许"只影响
这一个 run；前端不做任何授权缓存，每次审批都真问服务端。

**遗留**：`POST .../steer`（往正在跑的一轮里插话）接口已封装（`api/runs.ts`），界面入口没做。

### 5.12 浏览器进后台 / 断线后的自动恢复（v2.2 追加）

**问题**：手机上切到别的 App 后浏览器会冻结页面、掐断 SSE，甚至直接回收页面。原来的实现只在
`send()` 的 `finally` 里做"轮末对账"，那是**页面还活着**才跑得到；一旦页面被冻结/回收，界面就
停在"正在思考…"或误报"回复中断"。

**架构前提（实测，见 §10.4）**：默认的 `runs` 通道本身就是解耦的 —— `POST /v1/runs` 只负责提交，
run 由**服务端自己跑完并写进会话**，没有任何客户端订阅也照跑（实测无人订阅的 run 24s 后
`completed`，正文已落库）；客户端中途掐断连接，run 依然 `completed`。所以**前端不需要常驻连接**，
它要补的只有一件：回来时把服务端状态同步成界面状态。

**因此刻意不做**（简单稳定 > 功能齐全）：不引入常驻连接管理器 / 新状态机、不用 `setInterval`
保活、不加 Service Worker / 推送、不改 Hermes 后端。实现只加了三样东西：

| 组成 | 位置 | 职责 |
| --- | --- | --- |
| `watchForeground()` | `lib/page-lifecycle.ts` | 订阅 `visibilitychange` / `focus` / `pageshow` / `online`，过滤出"真的回到前台"后交给上层；`backoffDelay()` 提供轮询退避（1s→2s→4s→8s→16s→**30s 封顶**） |
| in-flight 记录 | `stores/chat.ts`（`hcl.activeRun` in **localStorage**） | 提交后立刻写 `{sessionId, runId, sentText, startedAt}`；终态/停止时清掉（6h 自动作废）。**用 localStorage 不用 sessionStorage**：后者扛得住"刷新"，扛不住"标签页被系统回收后重建"（真机实测撞到，见 §10.4 的 14:13/14:14 两轮）。代价是同设备多标签页共享这条记录 —— 语义上是对的（那一轮确实在跑），代码只处理当前会话、终态即清 |
| `resumeSync()` | `stores/chat.ts` | 幂等同步：`GET /v1/runs/{id}` 判状态 → 还在跑就进 `background` 相位并按退避继续问；已终态就把会话记录回读补进界面（复用 `reconcileTurn`）。App 挂载、四个前台事件、`openSession` 都会调它 |

**相位语义**（`RunPhase` 新增 `background`）：

| 相位 | 含义 | 状态条文案 |
| --- | --- | --- |
| `background` | 连接断了/刚从后台回来，但**服务端那一轮还在跑** | `连接已暂时中断，任务仍在后台执行（回到页面会自动同步）`；正在同步时 → `已重新连接，正在同步最新消息…` |
| `aborted` | 这一轮确实结束了（被用户停/被服务端取消/拿不到终态且无内容） | `回复中断（未收到 run.completed）` |

配套细节：① 断流被系统当成错误留下的红字会**清掉**（连接断 ≠ 这一轮失败）；② `background` 下
输入框的按钮仍是**停止**（`run_id` 从记录里取），保证"任何状态下都能取消"；③ 页面被回收/刷新后
**没有选中任何会话时，自动打开那一轮所在的会话**（`resumeSync` 里做，`openSession(..., {resumeAfter:false})`
避免同一轮同步跑两遍）—— 否则用户只看到空态、看不到"还在后台执行"，也不会知道要点一下；④ 记录 6 小时后自动作废；
⑤ 记录指向的会话若已被删除，自动打开会失败 → 记录清掉，横幅如实显示"会话不存在"。

**边界（如实写清）**：`background` 只对**默认的 `runs` 通道**成立；回退到旧 `chat/stream` 时
断连接会打断服务端那一轮，此时没有 run_id，恢复机制不介入（与旧行为一致）。`background` 期间
不允许开新一轮（避免同一会话并发两轮）。

## 6. UI 规范

| 项 | 值 |
| --- | --- |
| 消息区最大宽度 | `768px`，水平居中 |
| 字体 | 正文 15px / 行高 1.75（中文可读性）；代码 13px mono |
| 主色 | 浅色：近黑文字 `#111827` 配白底 `#ffffff`；深色：`gray-100` 文字配 `gray-950` 底（`#030712`），卡片 `gray-900`。以 Tailwind `dark:` 变体落地，不写死 hex |
| 圆角 | 卡片 12px，输入框 16px |
| 间距 | 消息之间 24px，段落之间 12px |
| 侧栏 | 240px / 底 `#f9fafb`，与主体 1px 分隔线 |
| 输入区 | 固定底部，随内容增长；最大高度 40vh |
| 移动端 | 侧栏抽屉；输入框字号 ≥16px（防 iOS 自动缩放） |
| 超宽内容（v2.1） | **溢出只允许发生在内容自己的滚动容器里**：表格 → `.md-body .table-wrapper`（`overflow-x:auto`，表格 `width:max-content` + `min-width:100%`）；代码块 → `pre`（`overflow-x:auto`）。消息正文容器 `.md-body` 一律 `min-width:0` + `max-width:100%` + `overflow-wrap:anywhere`（长 URL/长串可断）。**页面（html/body）与消息区（scroller）永远不横向滚动** —— 禁止用 `body{overflow-x:auto}` 之类"整页横滑"当解法 |

---

## 7. 错误与边界处理

| 场景 | 表现 |
| --- | --- |
| 启动时 `/health` 失败 | 顶栏红点 + `无法连接 Hermes`；**消息区上方红色错误横幅 + 重试按钮** |
| 创建会话失败（如反代没注入 key → 401） | **必须显示可见横幅**（实测踩过：原来只在"已有消息"分支渲染错误，导致点发送毫无反应、只能去 F12 看） |
| 会话列表为空 | 空态文案，引导新建 |
| 历史消息 404（会话被删） | 提示"该会话已不存在"，自动回到空会话态 |
| 流中断（网络/切后台） | 分两种（v2.2）：**服务端还在跑** → 状态条蓝色"连接已暂时中断，任务仍在后台执行"，回到前台自动同步；**确实已终止** → 标灰"回复中断"，已渲染内容保留 |
| 服务端 `error` 事件 | 助手气泡内红色错误文本，输入框恢复可用 |
| 连续点击发送 | 按钮在 `streaming === true` 时禁用（防重复 turn） |
| 页面刷新 / 切后台 mid-run | **不会打断**（默认 `runs` 通道：run 由服务端自己跑完并落库，客户端回来同步即可，见 §5.12）。⚠️ 只有把通道回退成旧版 `chat/stream` 时，断连接才会打断那一轮 |
| 流结束但没收到 `run.completed` | 标"回复中断"，不做静默处理（见 5.6 完成态判定） |

---

## 8. 部署

### 8.1 Dockerfile（多阶段）

阶段 1：`node:22-alpine` 装依赖 + `npm run build` → `dist/`
阶段 2：`nginx:alpine`，COPY `dist` 到 `/usr/share/nginx/html`，COPY `nginx.conf`，用 `envsubst` 注入 `HERMES_API_SERVER_KEY`（key 不进镜像层，运行时注入）。

**构建期自检（v2.10 加）**：`npm run build` 之后跟一句 `RUN test -f dist/index.html && test -f dist/favicon.svg && test -f dist/favicon.ico && test -f dist/apple-touch-icon.png && test -d dist/assets` —— 少拷 `public/` 或产物结构变了就**在构建阶段炸**，不必等线上"图标还是旧的"（与 §3.3 那条真 404 加固是一对：一个让错响亮，一个让错根本进不来）。改了 `public/` 记得同步改这行。

镜像源走腾讯云 npm registry（`registry.npmmirror.com` 或 `mirrors.cloud.tencent.com/npm/`）与 NJU docker 镜像，避免国内超时。

### 8.2 docker-compose.yml 要点

```yaml
services:
  chatlite:
    build: .
    container_name: chatlite
    restart: unless-stopped
    environment:
      - HERMES_API_SERVER_KEY=${HERMES_API_SERVER_KEY}
    expose: ["80"]                 # 不映射宿主机端口
    networks: [net_openclaw]
networks:
  net_openclaw: { external: true }
```

按您既有约定：接入 `net_openclaw`，不配 `ports`，显式 `expose` 声明内部端口；Caddy 反代 `chatlite:80`。

### 8.3 Caddy（宿主机，用户执行）

```caddyfile
chat.<域名> {
    basic_auth {
        <用户名> <bcrypt 哈希>
    }
    reverse_proxy chatlite:80
}
```

Caddy 需处理 SSE：默认 `flush_interval -1` 对流式响应是安全的；若发现缓冲，显式加 `reverse_proxy chatlite:80 { flush_interval -1 }`。

### 8.4 重建镜像后的两条自检（v2.10 加固，必跑）

⚠️ Caddy 前面有 `basic_auth`（§8.3），而 Caddy 的 `basic_auth` 排在 `reverse_proxy` **之前**，
所以**不带口令的 curl 一律 401，任何路径都一样 —— 它只说明口令闸门在正常工作，
既不代表加固没生效，也不代表"没发布"**（实测：连 `/nope.svg` 这种不存在的路径也回 401；
应用其实好好地跑着，内网直问是 200）。想看真实状态就走下面这两条 / §8.5。两种验法任选：

```bash
# A. 带口令走公网（把 用户:口令 换成 basic_auth 那一对）
curl -sI -u '用户:口令' https://chat.<域名>/favicon.svg | head -1   # 期望 200
curl -sI -u '用户:口令' https://chat.<域名>/nope.svg     | head -1   # 期望 404（仍是 200 = 没重建 / 没生效）

# B. 不用口令：绕过 Caddy 直接问容器里的 nginx（服务名自动探测，一条可粘贴）
cd <部署目录> && SVC=$(docker compose config --services | head -1) \
&& for u in /favicon.svg /nope.svg /assets/nope.js; do printf '%-18s -> ' "$u"; \
docker compose exec -T "$SVC" wget -S -O /dev/null "http://127.0.0.1$u" 2>&1 | grep -m1 -E 'HTTP/|server returned error'; done
```

判据：`/favicon.svg`（存在）→ `200`；`/nope.svg`（不存在）→ **`404`，不能再是 200**；
`/assets/nope.js` → 404（`/assets/` 那条本来就这样，顺带做回归确认）。
**加固生效后的直接红利**：以后"文件没打进镜像"这类问题，curl 一看就是 404，不会再被 200 的 HTML 骗过去。

### 8.5 判"线上到底发的哪一版"（绕开口令、绕过浏览器缓存）

**先记住一件事**：公网带不带口令都判不出版本 —— 口令走 §8.3 的闸门，缓存走 §3.3 的 `no-store`，
两者都不告诉你"镜像里装的是哪一版"。**可靠的判法：从容器内网直接问 chat-lite 容器，再看产物文案。**

```bash
cd <部署目录> && SVC=$(docker compose config --services | head -1)

# ① 当前入口引用的是哪个 bundle（哈希变了就是新产物）
docker compose exec -T "$SVC" sh -c 'wget -qO- http://127.0.0.1/ | grep -oE "/assets/index-[A-Za-z0-9_-]+\.js" | head -1'

# ② 抓那个 bundle，按"每个版本独有的文案"判断版本（把 <bundle> 换成上一行的输出）
docker compose exec -T "$SVC" sh -c 'wget -qO- http://127.0.0.1<bundle> | grep -c "本轮输入合计"'
```

| 版本 | 独有文案（`grep -c` 为 1 才说明这版在里面） |
| --- | --- |
| v2.7 水位行口径 | `本轮输入合计`（旧字样 `本会话累计` / `缓存命中` 必须为 **0**） |
| v2.9 相位分派 | `当前通道不支持补充信息`、`已中断这一轮` |
| v2.10 静态资源加固 | 无前端文案 → 改用 `/nope.svg` 是否 **404** 判断（见 §8.4） |
| v2.12 地址即状态 | `该会话不存在，请重新创建`（且 `#/s/` 字样为 1） |

**实测示例（2026-09-15，PR #17 已合并但未重建时）**：bundle 仍是 `index-CarQVqMx.js`，
`本轮输入合计`=1、`已中断这一轮`=0、`当前通道不支持补充信息`=0 ⟹ **"合并了但没发布"**，
一句话定位，不用猜（这也是"合并 ≠ 发布"这个常见误会的判别手法）。

---

---

## 9. 实施计划（按序执行，每阶段可独立验证）

**P0 工程搭建**
1. `npm create vite@latest hermes-chat-lite -- --template vue-ts`
2. 装依赖：`tailwindcss postcss autoprefixer markdown-it highlight.js @types/markdown-it`
3. `vite.config.ts` 加 dev proxy：`/api`、`/v1` → `http://127.0.0.1:8642`，并注入 `Authorization`（dev 专用，key 从 `.env.local` 读，`.gitignore` 掉）
4. 写 `types.ts` + `hermes.ts` 三个只读函数
5. 验证：控制台 `getSessions()` 打印出真实会话列表

**P1 只读链路**
6. `lib/markdown.ts`（markdown-it + highlight.js）
7. `Sidebar.vue` 列表 + 日期分组；`App.vue` 布局骨架
8. `ChatWindow.vue` + `MessageItem.vue`，`normalize()` 过滤
9. 验证：点会话能看历史消息、代码块高亮、tool 消息不出现

**P2 写链路**
10. `InputBox.vue`（Enter/Shift+Enter/isComposing）
11. `newChat()` + 乐观插入
12. 验证：Enter 发送，用户消息立即上屏，Enter 不再产生空行

**P3 流式**
13. `sse.ts` 解析器（按 3.2 的 4 条要求）
14. `streamChat()` 事件分发 → store 更新 → 逐字渲染 + 光标
15. 工具状态提示、`stop()`、错误事件
16. 验证：回复逐字出现；长回复不掉帧；停止按钮能中断

**P4 部署**
17. `Dockerfile` / `nginx.conf` / `docker-compose.yml` / `README.md`
18. 本地 `npm run build` + `docker build` 通过（构建由用户执行也可）
19. 用户侧：compose 启动 + Caddy 配置 → 浏览器验收

**P5 安全加固**
20. Caddy basic_auth；确认 `curl -I` 无口令返回 401

---

## 10. 验收清单（对应需求第八条）

| # | 验收项 | 验证方式 |
| --- | --- | --- |
| 1 | 浏览器打开即可聊天 | 访问域名，健康检查绿点 |
| 2 | 看到 Hermes 历史 Session | 侧栏出现 tui/gateway 等来源的真实会话 |
| 3 | 点 Session 加载历史消息 | 切换会话内容正确，含中文与代码块 |
| 4 | 输入消息可以发送 | 用户消息上屏，服务端 session 落库 |
| 5 | 回复实时流式显示 | 肉眼逐字出现；`curl -N` 对照事件流 |
| 5b | **工具执行可见 + 完成态明确** | 长任务时能看到"正在使用 X…"，结束后常驻"✓ 完成 · 12.3s · N 个工具调用" |
| 6 | Markdown 正常显示 | 标题/列表/表格/引用 |
| 7 | 代码块高亮 | 多语言代码块有色，复制按钮可用 |
| 8 | Docker 可部署 | `docker compose up -d` 后域名可访问 |

### 10.1 验证证据（2026-09-11）

| 验证项 | 怎么验的 | 结果 |
| --- | --- | --- |
| SSE 解析器打真实接口 | node 直接跑 `src/api/sse.ts`（模拟反代注入鉴权头）打 `POST /api/sessions/{id}/chat/stream` | ✅ 事件序列 `run.started → message.started → tool.started → tool.completed → assistant.delta → tool.progress → assistant.completed → run.completed → done`；delta 分片 2（真流式）；`read_file` 工具事件收到；`run.completed` 收到 |
| 历史消息过滤 | 同上，读回 `GET /messages` | ✅ 原始 4 条 → 界面可见 2 条，最后一条是 assistant |
| 前端运行时 | `vitest`（jsdom + @vue/test-utils） | ✅ 37/37 通过（半帧切片、中文切在多字节中间、keepalive、过滤规则、输入法、失败可见性、每轮统计、App 集成） |
| Origin 403 修复 | 带 `Origin` 头打修复后的反代 | ✅ GET 200 / POST 201；对照：直连 8642 带同样 `Origin` 仍 403（反证触发点就是它） |
| token 口径 | 真接口连发两轮，比对 usage 与两次会话记录 | ✅ 未命中Δ 706 + 命中Δ 26624 === usage.input_tokens 27330（精确）；`run.completed` 后立即读记录已是新值 → 无竞态 |
| 每轮统计页脚 | 用真实数据按前端同样算法渲染 | ✅ 输出 `⏱ 3.6s · 输入 27.3k · 缓存 26.6k (97%) · 输出 20` |
| 类型与构建 | `vue-tsc --noEmit` + `vite build` | ✅ 0 类型错误；产物 280KB（gzip 109KB）/ CSS 25.4KB |
| 界面优化三件套（v1.1） | `vitest` + 产物 CSS 核验 | ✅ 新增 17 条（54/54 全过）：搜索过滤/无命中空态/清空、折叠持久化、主题切换与持久化、隐私模式不抛异常；`dist/assets/*.css` 含 39 条 `:is(.dark *)` 与 `.dark .hljs-*` 规则；`dist/index.html` 含首帧防闪白脚本 |
| 长会话可读性（v1.2→v1.3） | `vitest` + **真实 API 端到端** | ✅ 新增 18 条（72/72 全过）：分页 offset/到底判定/位移去重/边界合并/压缩摘要不污染正文/滚到顶自动加载与三重闸门；真实会话 206 条原始消息逐页加载后与全量读 `toEqual` **完全相等**，会话第一条已可见 |
| 真实浏览器 | ❌ 未做（**2026-09-13 已补上：Chromium headless 真内核，见 §10.3**） | 本容器 browser-use 守护进程卡死（已知问题），需您在真机点一遍 |
| Docker 构建/运行 | ❌ 未做 | 本容器未挂 docker daemon（只有 CLI），需在宿主机执行 |

---

### 10.2 验证证据（2026-09-12，A 方案 / v2.0）

| 项 | 命令 / 脚本 | 结论 |
|---|---|---|
| 单元 + 组件 | `npm test` | **122/122 通过**（新增 `stores/runs-transport.spec.ts` 16 条、`components/RunStatus.spec.ts` 8 条） |
| 类型 | `npx vue-tsc --noEmit -p tsconfig.json` | 0 错误 |
| 真实链路（**常驻**） | `set -a && . /opt/data/.env && set +a && npm run e2e` | **5 项全绿**：① 普通轮（`recovered=false`、统计 27,449 in / 缓存 96.99%）② 工具轮（时间线带工具名 `terminal`）③ 中断（服务端 `status=cancelled`、界面 `aborted`）④ 历史回归（7 条原始 → 5 条界面消息）⑤ 清理（删除后 GET 404）。全程只动自建探针会话，用完全部删净 |
| 审批接口契约 | `/opt/data/.verify/probe_approval_contract.mjs` | 非法/缺 `choice` → 400 `invalid_approval_choice`；未知 run（approval/get/stop）→ 404 `run_not_found`；无待审批提交 → 409 `approval_not_pending` |
| 审批真实事件 | `/opt/data/.verify/probe_approval_chmod.mjs`（2026-09-15） | ✅ **真机验收通过**：`chmod -R 777 <一次性目录>`（模式描述不在 `command_allowlist` 里）→ 收 `approval.request`（`choices` 四项、`command`、`request_id`）→ 回话 `once` → 200 → `approval.responded` → 命令真执行；同日真域名页面上点按钮也走通（日志 `POST /v1/runs/{id}/approval → 200`，Referer = `chat.1597133.xyz`）。**另**：2026-09-12 的 `probe_approval_live.mjs` 用 `rm -rf /tmp/<不存在路径>` 未能触发 —— 不是 smart approval，而是 `delete in root path` 已在 `command_allowlist` 里被静默放行，见 README 第 7 条 |
| 通道可替代性（前置实测） | `/opt/data/.verify/probe_runs.mjs` | `/v1/runs` 有逐字流式、同一 `session_id` 连续两轮历史连续、`GET /api/sessions/{id}/messages` 能读到 run 写的消息（含 `role=tool`）、事件流消费后再连 → 404 |
| 帧形态取证 | `/opt/data/.verify/probe_runs_tail.mjs` | 原样打印流尾：`data: {...}\n\n` + `: stream closed\n\n`，**没有 `event:` 行** → 坑 38 的直接证据 |

---

### 10.3 验证证据（2026-09-13，移动端表格横向溢出 / v2.1）

**为什么必须真浏览器**：jsdom 不做布局，`scrollWidth` 恒为 0，溢出行为在单测里测不出来（单测只锁"结构 + CSS 契约"，见坑 43）。

**方法（复现实验对照组）**：同一份探针脚本跑**两个构建产物** —— `dist-before`（修复前的 `dist`，对照组）与 `dist-after`（本分支产物）。静态站点由脚本自带的服务器提供，`/api` 与 `/health` 用 `page.route` 打桩（**真实前端产物 + 真实 CSS + 真实 markdown 渲染，只有数据是假的**）。三档视口：`375×812`（isMobile + hasTouch）/ `320×640` / `1280×800`。探针构造 4 条消息：普通文本 → **10 列超宽表** + 跟随文本 → **表格之后的普通消息** → 代码块 + 窄表 + 长 URL + **400 字符无分隔长串** + 尾文本。

**脚本**（本地工具，不进仓库）：`/opt/data/.verify/table-overflow/{probe.cjs, extract.cjs, verdict.cjs}`，产物两份构建在 `dist-before/` `dist-after/`。本容器已有 headless 内核，**不需要装浏览器**：

```bash
cd /opt/data/.verify/table-overflow
node probe.cjs --dir dist-before --port 4711 --label before && node extract.cjs before
node probe.cjs --dir dist-after  --port 4712 --label after  && node extract.cjs after
node verdict.cjs before.json after.json     # 修复后应输出 PASS ✅
```

| 判据 | 修复前（375） | 修复后（375） |
| --- | --- | --- |
| 页面不横滑 / 整页拖不动 | `doc=375 body=375`、`scrollX=0`（本来就 OK：溢出被关在消息区里） | 同左 |
| **消息区 scroller 不横滑** | ❌ `client=375 / scroll=3353`（能左右拖 2978px） | ✅ `375 / 375` |
| **表格溢出被关在表格区** | ❌ 无 `.table-wrapper`，裸 `table` 越出 `.md-body` 右缘 255px | ✅ wrapper `343 → 650`（可滑），另一张窄表 `343/343`（放得下、无滚动条） |
| 手机：超宽表格自己横滑 | ❌ 无滚动容器 | ✅ 表宽 650 > 容器 343，`scrollLeft` 可动 |
| PC（1280）：同一张表完整显示 | ❌（消息区 `1040/3489`） | ✅ 表 736 = 容器 736，无滚动条、不裁切 |
| **表格之后的普通消息不被撑宽** | ❌ `.space-y-6` 的 `scrollWidth=598`（后续消息也跟着有多余横向空间） | ✅ 四条消息全部 `343/343` |
| 长串/长 URL 不撑破 | —（URL 有分隔符时本身不断行） | ✅ 400 字无分隔长串无溢出（`overflow-wrap:anywhere` 生效） |
| 意外溢出元素 / JS 错误 | `table+255px` | ✅ 0 / 0（三档 `pageErrors` 全 0） |

**未验证（如实标注）**：真机 iOS Safari / Android 浏览器里的**手指横滑手感**（本容器只有 Chromium headless，用程序化 `scrollLeft` 证明"滚动容器真的能滚"，替代不了手指拖拽）；`-webkit-overflow-scrolling` 之类 iOS 专有手感的差异请真机确认。

---

### 10.4 验证证据（2026-09-13，进后台/断线自动恢复 / v2.2）

**第一层：后端行为（真 API，决定性事实）** —— 脚本 `/opt/data/.verify/bg-resume/probe_backend{,2}.cjs`：

| 问题 | 实测 |
| --- | --- |
| 提交后**完全没有客户端订阅**，run 会跑吗？ | ✅ 会。`POST /v1/runs` → 202；不订阅任何流，24.0s 后 `GET /v1/runs/{id}` = `completed`，且会话里已有 assistant 正文 `"完成"`（`/api/sessions/{id}/messages` 读到） |
| 订阅到一半**客户端掐断连接**（模拟进后台）？ | ✅ run 继续跑完：`status=completed`，正文照常落库。**断开 ≠ 取消** |
| 掐断后**能重连那条事件流**吗（能不能靠重放补事件）？ | ❌ 不能：重连同一 run 的 `/events` 在 8s 内没有任何数据块（本次 watchdog 主动放弃）。所以恢复只能走 `GET /v1/runs/{id}` + 会话消息，**不能依赖事件流重放** |
| 显式 `POST /v1/runs/{id}/stop` 还有效吗？ | ✅ `200 {"status":"stopping"}` → 终态 `cancelled`（"用户主动取消"这条路没被这次改动弄坏） |
| 服务端有没有"run 列表 / 事件增量重放"能力？ | `GET /v1/capabilities` 的 features 里有 `run_submission / run_status / run_events_sse / run_stop / run_steer / run_approval_response`，**没有** run 列表、也没有 `since`/`last_event_id` 之类的重放参数 → 所以用 sessionStorage 记录 + 会话历史对账 |

**第二层：真实链路 e2e（常驻用例）** —— `e2e/background-resume.e2e.spec.ts`（`npm run e2e`，真模型 `xyy/deepseek-flash`）：

```
① run_id = run_4cfa11e3…
② 2.5s 后掐断事件流（不调 stop）→ 界面 phase = background，界面无错误红字
③ 断流后服务端自己跑完：status=completed（断流后 16.0s，期间客户端零订阅）
④ 回前台 resumeSync() → phase = done，正文 = "完成"，sessionStorage 记录已清
⑤ 清理：DELETE = 200，复查 GET = 404
```

**第三层：真浏览器（Chromium headless + 可控桩服务端）** —— 脚本 `/opt/data/.verify/bg-resume/probe_browser.cjs`，产物为 `npm run build` 的 dist：

| 场景 | 结果 |
| --- | --- |
| S1/S2 手机 375：连接被掐 → 回前台自动同步 | 断开后界面 `data-phase=background`、文案 `连接已暂时中断，任务仍在后台执行（回到页面会自动同步）`、**停止按钮在位**；派发 `visibilitychange` 后 → `done`、正文补回（`后台跑完的最终答复`）、停止按钮消失、`pageErrors=0`。请求序列可见恢复路径：`GET /v1/runs/{id}` → `GET /api/sessions/{id}/messages` |
| S3 后台执行中点停止 | 发出 `POST /v1/runs/{id}/stop`，相位 → `aborted`（Cancel 未被弄坏） |
| S4 运行中**刷新页面** | `hcl.activeRun` 记录落盘（runId 一致）→ reload 后打开会话 → 仍识别为 `background` → 回前台 → `done` 且正文补回 |
| S5 PC 1280 | 同一条链路同样通过（不是移动端特例） |
| S6 回前台瞬间网络抖动 | 横幅出现（**已翻成中文**："网络请求没有发出去（断网或连接被中断），恢复后会自动重试" + 重试按钮）→ 同步成功后 **横幅消失**、正文补回、消息里无残留红字、0 JS 错误。这一格是"真机看到假报错"的复刻与修复证据 |
| S7 **标签页被系统回收后重开**（`storageState` 模拟：新上下文，sessionStorage 空、只有 localStorage 带过来） | `localStorage` 里那条记录活下来了；**不用点任何东西**界面自己打开那一轮所在的会话并显示"任务仍在后台执行"；服务端跑完后回前台 → 自动补出正文；0 JS 错误 |

**真机实测（2026-09-13 下午，两轮）**：

| 轮次 | 服务端 | 客户端 |
| --- | --- | --- |
| 14:13:55 提交（`run_3e50cdfb…`）→ 事件流 **0 字节**（连接被掐） | ✅ 30.19s 工具完成后 `Turn ended`，回复落库 | ❌ **自动同步没触发**：页面上下文被系统重建（日志里 3 秒内 4 次 App 挂载 + 一次全新挂载），sessionStorage 被清空 → 前端不知道有 run 在跑。**这就是把记录迁到 localStorage + 自动打开会话（v2.2.2）的直接依据** |
| 14:14:35 提交（`run_2722c66c…`，用户补了「，真机测试」） | ✅ 30.13s 工具完成后落库 | 同一上下文内正常（记录在），恢复由"回到前台"驱动 |

> 两轮都**没有**出现非 2xx、没有 error/cancel 记录 —— "连接被掐 ≠ 任务被取消"在真机上稳定成立。

**未验证（交给真机，如实标注）**：
1. **真实的后台冻结语义**：Android Chrome / iOS Safari 到底何时冻结页面、何时回收、何时掐连接 —— 本容器只能"模拟连接被掐 + 人工派发 visibilitychange"，**替代不了真机**。请在手机上按 README「上线自检」第 10 条走一遍（切后台 10~30s / 几分钟各来一次）。
2. iOS 上 `pageshow`（bfcache 恢复）路径：代码已覆盖，但 headless 里触发不了真实的 bfcache。

**探测会话已清理**：本次探测共建 8 个 `api_server` 会话（含首轮超时被留下的），按"消息里含探测原文"的指纹列成白名单后逐个 `DELETE`，复查列表为 0（脚本 `cleanup_probe_sessions.cjs`，**只按 id 删，绝不按条件批量删**）。

## 11. 明确不做（v1 冻结，防范围蔓延）

用户登录 / 权限 / 多用户 / 数据库 / 文件上传 / 图片生成 / 插件市场 / 模型切换 / Prompt 管理 / Agent 配置页 / 会话删除与收藏 / 消息重新生成 / 多标签并发流。

**关于"会话搜索"**（原列在此处，v1.1 已做）：做的是**客户端标题过滤**（覆盖已加载的 200 条），不是服务端全文检索——Hermes API 没有搜索端点，要做真搜索必须改 Hermes 源码，与"不改 Hermes"原则冲突。消息内容搜索仍不做。

（Hermes API 其实支持其中若干项——fork、会话删除、model lock——但为守住"简洁 > 复杂"，v1 一律不做。）

---

### 5.13 按时间交错渲染（v2.11 追加）

**一句话**：一轮不再压成一个气泡，而是按**时间顺序**排成一串"段" —— `正文段 → 工具行段 → 正文段 → …`，
工具行变成**常驻小字行**（灰字 + 缩进、不折叠）。这是用户 2026-09-15 定的口径（待办第 14 条）。

**为什么必须改**（不是审美）：服务端落库本身就是「`assistant(正文 + tool_calls)` → `tool(结果)` → `assistant(…)`」，
而旧实现的 `normalize()` 把连续 assistant **合并成一个气泡**、`attachPending()` 又把工具**统一堆到正文上方** ⇒
"哪段话之后调了什么"这个**顺序信息被抹掉**。用户插话（v2.9 的 steer）之所以"放上面不对、放下面也不对"，根子就在这里。

**数据模型**（刻意最小）：

```ts
UiMessage.kind?: 'text' | 'tools'   // 缺省 'text'；'tools' 段 content 为空、内容在 tools 里
```
一轮 = `user 块` + 若干段；**轮级页脚**（每轮统计 /「已中断」/ 错误）挂在**本轮最后一个段**上 —— 它天然就是轮尾。

**为什么不用 `UiTurn { segments: [] }` 包一层**：那要动渲染、滚动锚定、分页与全部既有断言，收益只是"更好看的分组"。
用扁平列表 + 纯函数分组（`lib/turns.ts: groupIntoTurns()`）得到同样的 DOM，风险小得多（用户原则：简单稳定 > 功能齐全）。

**渲染**：`ChatWindow` 按 `groupIntoTurns()` 的结果渲染 —— 轮内 `space-y-2`（段与段挨近）、轮间 `mt-6`（一眼看出新一轮提问）；
两处间距实测 8px / 24px。`MessageItem` 的 `kind === 'tools'` 分支渲染 `●/✓/✗ 名称 "参数预览" (耗时)` 小字行，**没有折叠开关**。

**实时链路（边跑边交错）**：

| 时机 | 行为 |
| --- | --- |
| `message.delta` | 写进"当前正文段"；若它已被工具行切开 → **新开一段**（这是交错的关键） |
| `tool.started` | 先把当前正文段**封口**，再新开/续挂一段工具行（同批调用挨在一起：上一批都跑完才另起一段） |
| `run.completed` / 收尾 | `reconcileTurn()` 用服务端 transcript **整批重建**本轮的段（`replaceTurnSegs`），再用 `syncToolsToMsg()` 按顺序把成败/耗时铺回工具行段 |
| 拿不到 transcript（断网） | 保留流式期拼出来的段，只把 `streaming` 关掉 —— 降级但不丢 |

**一处实现时改掉的计划**：原计划"`send()` 立刻插一个空正文段当占位"。实现时发现那会造出**空正文段这种假东西**
（本轮开口先调工具时，界面就是"空气泡 + 工具行 + 正文"）⇒ 改成**按需创建**：第一段是工具行就是工具行、第一段是正文就是正文；
思考阶段的进展由状态条如实说。单测有断言专门锁"没有空正文段"。

**分页**：`prependEarlier()` 的边界合并**只在同 kind 之间**（`text`+`text` 合并正文、`tools`+`tools` 合并工具行），
`text`+`tools` 一律不合并 —— 否则又把顺序抹掉了。按 `srcId` 去重的机制不变。

**已知取舍**：① 补充（steer）您那句话仍显示成独立用户块、不参与段序（steer 的注入点是"最近一条工具结果末尾"，
这是 Hermes 侧语义，不在前端能修的范围）；② 长轮次的 DOM 节点变多（正是当初做折叠的原因，用户已明确选择"常驻小字行"）。

**验证**（2026-09-15）：单测 245 + RED/GREEN（12 条核心断言在还原后全红）+ `vite build` +
真浏览器（`/opt/data/.verify/review_0915/verify_interleaved4.cjs`）：**段序与服务端 transcript 逐轮完全一致**、
0 个折叠开关、工具行全部可见、轮内 8px < 轮间 24px、实时一轮中途 `[text,tools]` 跑完 `[text,tools,text]`、
滚动锚定无回归（落底 距底=0；上滚不被拽回；划到顶触发"加载更早"后顶部那条消息 **Δ=0px**，插入 10336px —
A/B 与 main 产物行为一致，见坑 61）。

---

## 12. 已知坑（开发时逐条对照）
### 5.14 地址即状态（v2.12 追加）

**一句话**：`#/s/<id>` = 打开该会话；裸域名 = 欢迎页（输入第一条消息才建会话）；
地址里的 id 不存在 → `replace` 回裸域名 + 一句 5 秒自动消失的提示。**打开会话只有"地址变化"这一个入口。**

为什么做（用户 2026-09-15 实测提出）：打开会话后刷新页面会回到空白欢迎页。查证结论是"一半刻意、一半漏做" ——
v2.2 只做了"有在跑的一轮时会自动接上（`resumeSync` 直接 `openSession`）"，普通刷新没做恢复。地址承载会话 id 之后，
刷新、书签、多标签、把链接发到手机打开都自然成立，浏览器返回键也第一次有了正确语义。

| 载体 | 位置 | 说明 |
| --- | --- | --- |
| 解析/导航 | `src/lib/route.ts` | `parseRoute()` 纯函数；`navigate(id \| null, {push\|replace})`；`onRouteChange()`（同听 `popstate` + `hashchange`，用"最后分发过的路由"去重）；`markInitialRoute()` |
| 唯一入口 | `App.vue` 的 `applyRoute()` | 启动按地址进入；订阅地址变化。侧栏/返回键/手改地址/外链走的都是它 |
| 提示 | `src/components/Notice.vue` | 5 秒自动消失 + 点击立即消失（`ms` 可调，下限 1 秒） |
| 状态收紧 | `chat.ts` | `openSession()` 返回 `{ok:true} \| {ok:false, missing}`；新增 `goHome()`；`resumeSync()` **只在你打开的就是那条在跑的会话时才接上** |

**四条硬口径**（改这里之前先读）：
1. `pushState/replaceState` **不触发** `hashchange`/`popstate` ⇒ 自己的导航必须**手动分发**（漏了就表现为"地址变了、画面没变"）。
2. 欢迎页要把 `#` **整个去掉**（`pathname + search`）；只把 hash 设成空串会留下一个光秃秃的 `#`。
3. **点侧栏 = push**（返回键能回上一个会话）；**程序自己纠正地址 = replace**（无效 id、生成中撤回）。
4. **生成中不许切会话**（`openSession` 的守卫）⇒ 路由层把地址**撤回**当前会话，避免"地址 B、画面 A"。
   「新对话」也**不再预建空会话**（旧行为会堆一堆 0 消息空壳），会话交给 `send()` 懒创建。

**已知限制**：两个标签打开同一会话时互不实时同步（用户已接受）；`hcl.activeRun` 记录保留但**不再用于"打开哪个会话"**。


1. **CORS 默认关闭** → 必须同源反代，不要试图在前端直接跨域打 8642。
2. **key 不能进浏览器产物** → 反代注入 Authorization。
3. **`EventSource` 用不了**（它只支持 GET）→ 必须手写 fetch + ReadableStream 解析。
4. **`proxy_buffering off`** → 忘了它，流式会退化成一次性返回。
5. **TextDecoder 必须 `{stream: true}`** → 忘了它，中文会乱码。
6. **半帧缓冲** → 切帧后最后一段要留回缓冲区。
7. **keepalive 注释帧**（`: keepalive`）→ 解析器要跳过。
8. **`run.completed.messages` 不要渲染** → 会与正文重复；只认 `assistant.completed.content`。
9. **历史消息要过滤 tool / 空 assistant / reasoning** → 否则界面出现大量 JSON 噪音。
10. **新建会话不要传 title** → 重名会被 400 拒绝并回滚。
11. **中文输入法 isComposing** → 未处理会导致拼音回车误发送。
12. **时间戳是 Unix 秒** → 直接 `new Date(ts)` 会得到 1970 年。
13. **刷新页面会不会打断服务端那一轮？** → `runs` 通道（默认）**不会**：run 是服务端自己的任务，页面刷新/被回收/切后台都不影响它，回到页面自动同步（见 §5.12）。只有把通道回退成旧 `chat/stream` 时，断连接才会打断那一轮。
14. **markdown-it `html:false`** → 防止 agent 输出注入原始 HTML。
15. **`tool.completed` 不带执行结果** → 服务端按 `(name, None, None)` 发出，只有工具名。想要结果得在 `run.completed.messages` 里按 `tool_call_id` 回填；别指望事件里有。**不要因为拿不到结果就退回 OpenAI 端点**（那会连工具名都看不到，正是 Open WebUI 的病）。
16. **`tool.started` 的 `args` 是脱敏后的展示值** → 可以直接显示，但别当作真实参数入库/回传。
17. **`assistant.completed.content` 必须覆盖 delta 拼接** → 实测：delta 原文是 `["\n\nhermes-chat","-lite"]`，`completed` 是 `"hermes-chat-lite"`。**delta 会带前导换行等杂质**，追加会多出空行、少字就在所难免。以 `completed` 覆盖是必须的，不是防御性编程。
18. **计时器别用事件里的 `ts`** → 用 `performance.now()` 本地算，否则时间会跳。
19. **完成态必须由事件显式判定** → 见 5.6 的判定表；"界面不再变化"≠"已完成"，这正是 Open WebUI 让您困惑的地方。
20. **健康检查不能打 `/health`** → 实测 `/health` 不带 key 也返回 200，密钥填错照样 healthy，等于验不出问题；要打 `GET /api/sessions?limit=1`（无 key/错 key 返回 401），才能同时验证反代与密钥有效。
21. **★★ 带 `Origin` 头的请求会被 Hermes 直接 403**（本项目部署时真实踩到，代码与文档此前判断有误）→ Hermes 的 CORS 中间件在 `cors: false` 时，只要请求带 `Origin` 就返回 **403 空 body**（`Server: Python/3.x aiohttp`）。**浏览器所有 POST 都自带 `Origin`，curl 不发送** → 结果就是：命令行怎么测都通，真机浏览器一打开就死。修法：反代层剥掉它 —— nginx `proxy_set_header Origin "";`，vite dev proxy `proxyReq.removeHeader('origin')`。**注意：这不是"开 CORS 就行"的问题，同源反代本身也不够。**
22. **★★ 清理测试会话只许按 id 白名单，禁止按 `source` 批量删**（2026-09-11 真实事故，见 `docs/incident-2026-09-11-deleted-session.md`）→ `DELETE /api/sessions/{id}` 是**硬删除**（会话 + 消息一起没，无回收站）；MySQL 归档 cron 每天 21:00 才跑一次，之前删的东西没有第二份副本。用 `source=api_server` 做批量条件删除会**把用户的真实会话一起删掉，且不可恢复**（页级抢救实测无效：被删页已被后续写入复用）。
23. **★ 会话搜索必须客户端自己实现** → Hermes API **没有**搜索端点：`GET /api/sessions` 实测只认 `limit/offset/source/include_children`；`hermes_state.py` 里那个 `search_sessions()` 名字骗人，它只是"按 source/workspace 列会话"，不搜关键字；真正的 FTS5 全文检索在 `hermes_state_search.py`，但只喂 CLI（`hermes sessions browse --filter`），没走 HTTP。所以搜索只能对已取到的会话做本地匹配，且**必须取满 limit=200**（少取就搜不到）。搜消息内容要改 Hermes 源码，不做。
24. **★★ 测试里 `localStorage` 是 undefined（Node 22+ 遮蔽 jsdom）** → 裸 jsdom 明明有（`typeof window.localStorage === 'object'`），但在 vitest 里 `globalThis.localStorage` 已被 **Node 22+ 内置的实验性实现**占住：没有 `--localstorage-file` 时取值为 `undefined` 并打印 `ExperimentalWarning: localStorage is not available...`，把 jsdom 那份遮蔽掉。症状是 `Cannot read properties of undefined (reading 'clear')`，会误以为是 jsdom 不支持。修法：`src/test-setup.ts` 装一个语义完整的内存 `Storage`（不要用 mock 调用次数糊过去，那样测的不是真逻辑），并给 jsdom 一个真实 `url`（`environmentOptions`，否则不透明 origin 下 jsdom 根本不建 localStorage）。
25. **★ 暗色模式三处必须同步改** → `index.html` 内联脚本（首帧前定主题，防闪白）+ `lib/theme.ts`（运行时切换）+ `tailwind.config.js` 的 `darkMode: 'class'`。漏掉第三处时**不会报错**，只是所有 `dark:` 类被静默丢弃、界面看起来完全没切。核验方式：构建后在 `dist/assets/*.css` 里数 `:is(.dark *)` 出现次数（当前 39 条）。注意 Tailwind 3.4 生成的是 `:is(.dark *)` 形式，**不是** `.dark .bg-gray-800`，用后一种模式 grep 会得到 0 并误判成"配置没生效"。
26. **★ hljs 暗色不能直接再引一份 `github-dark.css`** → CSS 不支持给 `@import` 加作用域，引进来会在浅色模式下也生效。做法是手写 `.dark .hljs-*` 调色板（`.dark .hljs` 的优先级高于 `.hljs`，能覆盖 `github.css` 的 `background:#fff`），代码块底色由 `.md-body pre` 的 `dark:bg-gray-900` 负责，`.dark .hljs` 只把背景设为透明。
27. **★ 历史分页的 offset 锚定在"最新"，不是会话开头** → `order` 只有 `oldest|latest`（传 `earliest` 直接 400：`order must be one of: oldest, latest`）；`latest` + `offset=N` 是"从最新往回数第 N 条"，所以**发过新消息后已加载窗口会整体后移并与新页重叠 → 必须按 id 去重**；接口不返回总数，"还有没有更早"只能靠 `returned === limit` 判断（messages 的 limit 上限实测 500）。改动分页相关代码时，务必用 §5.9 ⑤ 那个"逐页加载 vs 一次全量读 `toEqual`"的核验方法重跑一遍。
28. **★★ 合并连续 assistant 之后，不能再用界面消息去重** → 合并只保留该组最后一条的 id，中间 id 从界面上消失；拿 `store.messages` 的 `srcId` 去重会漏（自测已复现：同一段被加载两次）。要单独维护 `loadedIds`。同理，**压缩摘要消息不能靠 `startsWith('[CONTEXT COMPACTION')` 识别** —— 真实那条以 `[PRIOR CONTEXT — for reference only…]` 开头，标记在 100 字符之后，必须用 Hermes 压缩器那套"前 280 字符包含标记"的判据（见 `lib/messages.ts`）。
29. **★ "加载更早"按钮不能因为有了自动加载就删掉** → 自动加载挂在 `scroll` 事件上，而**内容不足一屏时容器根本不产生滚动事件**，用户永远触发不了 → 必须有可点的按钮兜底（它同时是"加载中…"的反馈位）。另外自动加载的阈值是 `scrollTop <= 60px` 而不是 `== 0`，贴到 0 才加载会先露一段空档。
30. **★ 发送按钮不要与 `textarea` 并排** → 并排（`flex` + `textarea` 用 `flex-1`）会让按钮占住右下角，文字到按钮左缘就断行：输入长内容时按钮上方一片空白。正确做法是上下两段——文字区 `w-full` 占满整宽，按钮放它下面单独的工具行（ChatGPT 也是这样，工具行里还能放语音等按钮）。`autoGrow()` 的高度上限要相应减掉工具行高度。
31. **★ 改名有两个硬约束，必须当业务拒绝处理** → 标题**唯一**（重名 400 `Title 'x' is already in use by session <id>`，错误里带占用者 id，要翻成人话）+ **上限 100 字符**（`maxlength` 也要设）。改名失败**不能**走全局横幅，要保持在编辑态行内报错，否则用户输入的内容会丢。
32. **★★ 删除是硬删除、不可恢复，界面纪律比功能重要** → 服务端没有批量端点，也**不要**在前端拼批量；只做"单行 → 原位二次确认（文案带标题）→ 删这一行"。删的若是当前会话要连同 `currentId`/消息/分页游标一起清空。参见 `docs/incident-2026-09-11-deleted-session.md`（按 source 批量删误删真实会话，不可恢复）。
33. **★ 列表行不能用 `<button>` 包住行内按钮** → 会得到非法 HTML + 事件串味（点重命名等于点了打开会话）。行要是 `<div class="group flex">`，标题与操作按钮做兄弟节点。另外 **v-for 里的 template ref 会变成数组**，要聚焦编辑框用 `data-*` 属性 + `querySelector`。
34. **★ "点外面自动收起"不要用 `blur` 实现** → 点"保存/取消"按钮时 `blur` 先于 `click` 触发，编辑态被关掉后按钮的 click 就落空了（保存静默失效）。正确做法：**document 捕获阶段的 `click`** + 判断目标是"行内还是行外"（行上带 `data-row-id`）；捕获阶段先于目标自身处理执行，所以行内点击不会误取消、行外点击会先取消再执行原逻辑（例如顺手切到别的会话）。监听器要随状态挂/卸并在卸载时移除。
35. **★ 测试里不要用"写死的日期 + 内部 `Date.now()`"** → `groupSessions()` 原先内部取 `Date.now()`，而 fixture 写死 2026-09-11 → **跨过午夜后用例必挂**（实测 9-12 早上跑时"今天"全变"昨天"，报错还很难看出是时间问题）。修法：函数把 `nowMs` 做成可注入参数、测试显式传入固定 NOW。**凡是"相对当前时间"的逻辑，都要留一个可注入的时间入口**，否则测试会随时间腐烂。
36. **★★ 删掉的会话会"复活"（服务端缺陷）** → 症状：删完 0.5s 后同一 id 冒出一行空壳（`source="unknown"`、0 条消息、标题是刚生成的），列表刷新后像"没删掉"。根因：`hermes_state.py:7506` `update_token_counts()` 异步写 token 前会 upsert「确保行存在」，而会话可能刚被删；**跟标题写入无关**（那是纯 UPDATE），删除本身也干净。客户端兜底：删完 2s 复查一次、还在就再删一次（已实现，实测 2.0s 处变 404、DB 行数 0）；服务端补丁 `/opt/data/.verify/apply_ghost_fix.py` 待宿主机以 root 应用。**排查手法可复用**：先写复现脚本 + 直查 state.db 原始行 + 按时刻捞日志，再回头读码，比盯着代码猜快得多。
37. **★ 工具失败的原因不在事件里，在 `run.completed.messages` 里** → `tool.failed` 只带 `tool_name`/`preview`/`args`，**不带结果与错误**（实测），所以"为什么失败"（例如被安全闸门拦下）只能从整轮 transcript 里捞 `role=tool` 的原文。另外**审批只在 `/v1/runs` 上**（`chat/stream` 无接线），网页端需要人工批准的操作会被 fail-closed 直接拒 —— 别把它当成静默卡死去排查。
38. **★★ `/v1/runs` 的 SSE 帧没有 `event:` 行** → 事件名在 JSON 载荷的 `event` 字段里（服务端 `_sse_frame(event)` 没传 `event=` 参数）；旧通道 `chat/stream` 是有的（`_sse_frame(payload, event=name)`）。照旧通道的写法解析，事件名会一律变成默认的 `message`，**所有事件被当未知事件忽略** —— 症状是"没有任何逐字输出与工具时间线，只有轮末对账补回来的一段正文"，看起来像"流式坏了"而不是"解析错了"。修法：在 `api/runs.ts` 的 `runEvents()` 里归一化（`name === 'message' && typeof data.event === 'string' ? data.event : name`）。**这条只能靠真链路发现**：单测若照旧通道的帧形态写 fixture，会一直绿。
39. **★ `/v1/runs` 的工具事件字段叫 `tool`，不是 `tool_name`** → `tool.started{tool, preview}`、`tool.completed{tool, duration, error}`（实证 `api_server.py:6604-6622` 的 `_callback`）。不归一化则时间线里工具名全空 —— 注意 **JSON 序列化会丢掉 `undefined` 字段**，所以症状是 `{"preview":"echo hi","status":"ok"}` 这种"缺 name"的形态，容易看漏。另外新通道**没有 `tool.failed` 事件**，失败要靠 `tool.completed.error === true` 判断。
40. **★ 收到 `run.cancelled` 不能判成"完成"** → 它是"终止事件"但不是"完成事件"。把 `sawTerminal` 直接当完成判据，会让用户主动中断的那一轮显示成"完成"。要另立 `cancelled` 标记，并且中断不产出"本轮统计"。真链路 e2e 抓到的第二个真 bug。
41. **★ 真链路 e2e 要单独放、别塞进 `npm test`** → 它打真 API + 真模型，一轮几十秒又烧 token（实测一次"自作主张"的复盘跑了 204 秒 / 45 万输入 token）。做法：用例放 `e2e/`（根配置的 `include` 是 `src/**/*.spec.ts`，天然不收录），另给 `e2e/vitest.config.ts` + `npm run e2e`。**该配置文件里的 `root` 必须写绝对路径**（实测相对路径 `'..'` 是按 CWD 解析的，会指到项目外）。另外 jsdom 的 `AbortSignal` 不是 Node 的实例，透传给真 `fetch` 会报 `Expected signal to be an instance of AbortSignal` → 真链路用例里要么不传 signal，要么换 `environment: 'node'`。
42. **★ 探针会话要钉模型，别用网关默认** → 网关默认是 `qwen3.8-flash`，实测它会把"只回复两个字"执行成一整套 510210 复盘；探针里先 `POST /api/sessions/{id}/model {provider, model}` 钉个便宜听话的模型（如 `xyy/deepseek-flash`），既省钱又让断言稳定。断言的写法也要**只赌结构、不赌措辞**（如"正文非空 + 有 `run_id` + 有统计"），否则模型随口一改文案用例就红。
43. **★★ 手机端超宽表格把整块聊天区撑宽（v2.1 修复）** → 症状：手机上打开含宽表格的会话，**整个消息区能左右拖**，且"表格之后的消息"也跟着有多余横向空间。根因链：`.md-body table` 原先写的是 `w-full`（`width:100%`），但**表格的 used width 不会小于各列 min-content 之和**（10 列行情表 ≈ 650px）→ 表格盒子越出消息容器右缘；而消息列表所在的 scroller 是 `overflow-y:auto`（按规范另一轴的 `overflow-x` 会同时计算为 `auto`）→ 溢出在那个滚动容器里变成"可左右拖动"，后面的消息自然一起被放大。**禁止**用 `body{overflow-x:auto}` / `.chat-container{overflow-x:auto}` 这类"整页横滑"糊过去（那是把 bug 从"消息区滚"变成"整页滚"）。正确姿势是三层：① 渲染层给每张表包 `<div class="table-wrapper">`（重写 markdown-it 的 `table_open`/`table_close`；**不要**放到 `MessageItem.decorate()` 里包 DOM —— v-html 每次重渲染都要重包一遍，流式期间每帧都跑、必漏）；② wrapper `overflow-x:auto` + `width/max-width:100%`，表格 `width:max-content`（保住列宽、不被压扁）+ `min-width:100%`（窄表仍铺满容器，观感与修复前一致）；③ flex/grid 子项要 `min-width:0`（`min-width:auto` 会按 min-content 撑开），正文容器加 `overflow-wrap:anywhere` 兜住长 URL / 无分隔长串。**验证只能靠真内核**：jsdom 不做布局（`scrollWidth` 恒 0），要看 `document.scrollWidth`、`scroller.scrollWidth`、`window.scrollTo(9999)` 之后的 `window.scrollX`（必须为 0）这三个量，且**必须与修复前的产物做对照**（修复前必现、修复后为 0 才算闭环）。脚本、三档视口与前后数字见 §10.3。
44. **★★ 别把"连接断了"当成"任务没了"** → 手机切后台会把 SSE 掐掉，老实现只在 `send()` 的 `finally` 里做轮末对账 → **页面被冻结/回收时那段代码根本不跑**，界面停在"正在思考…"或误报"回复中断"。要点：① `runs` 通道下 **run 是服务端自己的任务**（实测无人订阅也照跑完、客户端掐断仍然 `completed`），所以断开**不代表**取消，只有 `POST /stop` 才是取消；② 事件流**不可重连/不可重放**（断开后重连拿不到任何数据）→ 恢复只能靠 `GET /v1/runs/{id}` 判状态 + `GET /api/sessions/{id}/messages` 回读对账（**别去设计"重连 SSE 补事件"**）；③ 前端状态必须记在**页面之外**（`localStorage` 存 `{sessionId, runId, sentText, startedAt}`），否则刷新/被回收后整个人失忆；**别用 `sessionStorage`**（扛不住标签页被回收重建，见坑 45）；④ 相位要区分 `background`（服务端还在跑，等同步）与 `aborted`（确实结束了），断流顺带留下的红字要**清掉**，否则"连接断"会被读成"这一轮失败"；⑤ 恢复动作挂在 `visibilitychange`/`focus`/`pageshow`/`online` 上（**不要用 `setInterval` 保活**：后台定时器会被 throttle，白费电还不可靠）；⑥ 退避 1s→2s→…→30s 封顶，页面不可见时**不轮询**（回到前台再接手）。实测数字与三层证据（真 API / 真链路 e2e / 真浏览器）见 §10.4。
45. **★★ 记"未完成的轮次"要用 `localStorage`，不是 `sessionStorage`**（v2.2.2 真机纠正）→ 两者都扛得住"刷新"，但**安卓/iOS 把标签页整个回收后重建时 `sessionStorage` 是空的** —— 于是前端完全不知道有 run 在跑：不会显示"任务仍在后台执行"，也不会自动同步，用户只看到自己那条孤零零的消息（真机 14:13 那轮实测如此；日志特征=同一会话在几秒内出现多次 App 挂载）。改用 `localStorage` 后，配合**开机/刷新时"有未完成的记录就自动打开它所属会话"**（否则用户面对空态根本不知道要点一下）即可闭环。代价：同设备多标签页共享这条记录 —— 语义上没错（那一轮确实在跑），代码只处理当前会话、终态即清、6h 自动作废；记录指向的会话若已被删除则清掉记录。验证用 `storageState` 造"杀掉标签页再重开"（浏览器用例 S7，见 §10.4），**别只用 `page.reload()`** —— 那只覆盖"刷新"，覆盖不到"上下文被重建"。
46. **★★ 手机上"刷了好几次还是老版本" = 入口 HTML 被缓存**（v2.2.3）→ 症状：服务端镜像早换了新产物（旧 `index-*.js` 在容器里已经 404），手机上刷新、杀进程重开都还是旧界面。根因：`location /` 里**没给 `index.html` 任何 `Cache-Control`**（只有 `ETag`/`Last-Modified`），浏览器于是按 `Last-Modified` 做"启发式缓存"，自带 webview 缓存/云加速的国产浏览器更激进；而 `/assets/`（带 hash）那边是 `max-age=604800, immutable`（**这是对的，别动**）→ "旧 HTML + 旧 hash 资源"这套组合被一直用下去，链子断在第一环。修法：`location = /index.html` 里 `Cache-Control: no-store, no-cache, must-revalidate` + `Pragma: no-cache` + `etag off` + `if_modified_since off`（这份 HTML 才 1.5KB，不值得为它省一次请求）；带 hash 的资源保持长缓存 —— 只要入口 HTML 每次是新的，新 HTML 自然会带出新的 hash 文件名。真机上想**立刻绕过**：地址后面加个查询串（`?v=2` —— 缓存按完整 URL 存，必然重新拉 HTML），或开无痕标签页/清该站点缓存。改完若**仍然**被缓存，那说明是浏览器自带的"云加速/极速模式"在缓存（关掉它或换浏览器）；判据是先 `curl -I` 确认入口 HTML 真的带上了 `no-store`。
    **配套**：界面顶部会显示**前端构建标识**（`vite.config.ts` 构建时自动生成：本机构建是"短 sha · 北京时间"，Docker 镜像里没有 `.git` 所以只有时刻；顶栏放紧凑形态，设置面板"连接"与空态底部放完整形态）—— 部署完打开手机对一眼就知道有没有吃到新版，不用再靠猜。
    **判据**：入口 HTML 响应里应能看到 `Cache-Control: no-store, no-cache, must-revalidate`（`wget -S` 或浏览器 devtools）。

47. **★★ 上下文水位三个数字在三个地方，只有一个前端能直接读到（v2.5）** → 想复刻 dashboard 状态栏的 `deepseek-flash │ 407.7k/1m │ [████░░░░░░] 41%`，先弄清三份数据：
   - **分母（窗口上限，`/1m`）**：只在 **dashboard 后端** —— `hermes_cli/web_server.py` 的 `GET /api/model/info`（容器 **9119**），返回 `effective_context_length`（config 的 `model.context_length` 优先，否则 `agent.model_metadata.get_model_context_length()`）。**API server（8642）完全没有 context 字段**（实测：`/v1/capabilities`、`/api/model/options`、`/health/detailed`、`/api/sessions/{id}` 全无）→ 必须在 nginx 单独加 `location = /api/model-info` 转发到 9119；**不能并进 `/api` 那条**（会打到 8642 变 404）。路径特意叫 `/api/model-info`（不是后端的 `/api/model/info`），避免与 API server 的 `/api/...` 命名空间混淆。
   - **分子（当前占用，`407.7k`）**：Hermes **不落库**。TUI 那行用的是 `compressor.last_prompt_tokens`（`tui_gateway/server.py` 约 5530 行算出 `context_used/context_max/context_percent`），**经 stdin/stdout JSON-RPC 下发，HTTP 拿不到**（全仓 HTTP 路由里没有它；`gateway/` 下也没有 WebSocket 服务）。前端等价的量是**本轮 `run.completed` 的 `usage.input_tokens`**（同义：最后一次调用实际喂进去的 token）→ 只有跑完一轮才知道，刷新/切走后靠 `localStorage` 记"上次已知"并**明确标注**（`hcl.ctx.<sid>`）。
   - **模型名**：`GET /api/sessions/{id}` 的 `model` ✓（顺手就有，不用额外请求）。
   排查手法：全仓 grep `context_percent|context_length|last_prompt_tokens`，再顺着 `runtime_footer.py` → `tui_gateway/server.py` 找到消费端，最后用 `curl http://hermes:9119/api/model/info` 实测字段名 —— **别猜字段**。

48. **★★ 逐轮 token 明细不落库，"切走再回来就没有"不是前端 bug** → Hermes 的 message 行只有 `content/role/timestamp/tool_calls…`，**`token_count` 恒空**（实测一个真实会话 300 条消息，user/assistant/tool 三类非空 0 条）。每轮那行 `⏱ 3.6s · 输入 27.3k · 缓存 …` 是客户端在轮末用**会话累计做差**算出来的（`counters()` 前后各读一次 `GET /api/sessions/{id}`），所以切走/刷新无法复原。能长期显示的只有**会话累计**（`input_tokens`/`cache_read_tokens`/`output_tokens`/`tool_call_count` 都在会话行上）→ 这也是"消息列表末尾那行会话累计"存在的唯一原因。要逐轮历史就必须让服务端落库 usage（动 Hermes 核心，按"不改 Hermes"原则不做）。

49. **★ 核验脚本自身也会"假绿"：`check()` 的参数顺序写反** → 真浏览器核验脚本里 `check(ok, label, detail)` 被调用成 `check("标签", 条件, 细节)` → 第一个位置收了个非空字符串，恒真，**所有断言都过**（打印出来是 `✅ True` 才发现）。教训：① 断言助手的签名要**让写错就报类型错**（或统一成 `check(标签, 条件)`）；② 新写的核验脚本先做一次**反向自检**（把一条断言故意改成必失败，确认它真的红）再采信结果；③ 看输出时留意标签位是否是 `True/False` 这类"不该出现的东西"。

50. **★★ 打开历史会话停在"半路"（v2.6 修）** → 症状：打开不同会话落点不一致，大会话停在中途（实测 21% / 44% / 50%），内容不足一屏的甚至停最上面，空会话看着"在底部"只是因为没内容。**根因不是"没贴底"，而是"贴早了 + 之后没人跟"**：拦截 `scrollTop` 赋值 + `MutationObserver` 抓到的真实时序 ——
   ```
   t=1408ms  列表刚插 1 个节点 → scrollHeight=601   → scrollTop := 601
   t=1427ms  又插 1 个节点     → scrollHeight=1205  → scrollTop := 1205   ★锚定在这一刻
   t=1449ms  +56 个节点 → 2999
   t=1492ms  +16 个节点 → 3510
   t=1509ms  +1 个节点  → 3554   ← 全渲染完，**再无任何滚动调用**
   ```
   落点 = 锚定那一刻的内容高 − 可视高。旧实现只由 `watch(tail)`（消息条数 + 最后一条正文字数）触发，而工具行/表格/字体这些"不改 tail 的长高"不会触发第二次锚定。**修法四处，缺一处就白干**：
   ① `ResizeObserver` 盯住**整块内容容器**（`.mx-auto.max-w-chat` 那一层，必须含"加载更早"行与末尾"会话累计"行 —— 只盯列表 div 会留下恒定 44px 偏差），`stick` 时内容一变高就重贴底；
   ② **不能只盯 scroller**：flex 布局里 scroller 自己的盒子是固定的，内容长高**不会**改变它自己的尺寸 → 一个通知都收不到（第一版就这么写的，单元测试还"绿"—— 因为我在测试里手动喂了 RO 事件；真浏览器一跑才发现修复无效）；
   ③ 内容容器是"有消息才渲染"的（空态/加载态不存在），挂载那一刻拿不到 → `watch(ref)` 在它出现时补 `observe`（否则同样收不到通知）；
   ④ 打开会话给一个**锚定窗口** `followUntilSettled`（每帧贴底，直到高度连续两帧不变、1.5s 兜底），"只贴一次"永远可能早于最后一波长高；同款逻辑用在「加载更早」的 scrollTop 补偿上（prepend 同样分波，原先只 `await nextTick()` 会算小差值 → 视口从顶部溜走）。
   验证（真浏览器）：多会话落点表 **修前 距底 655~2297px → 修后全部 0**；护栏：上滚到中途后点"加载更早"（内容 +3356px）→ 距底保持 1200（**没被拽回底部**）、锚元素相对视口偏移 **Δ=0px**（视口钉住）；单测含"必须真的观察内容容器"的接线断言。
   **两个可复用的教训**：① "DOM 分波长高"这类 bug 只能靠真浏览器 + 拦截 `scrollTop`/`MutationObserver` 抓（jsdom 不做布局，永远抓不到）；② 核验时当"锚"的元素**不能用会被重构的容器** —— prepend 会让相邻 assistant 合并、`.md-body` 的首句都变了（踩过两次），要用**叶子元素的文本指纹**去定位同一个点。

51. **★ 单元测试"绿"不等于接线对** → 坑 50 的第一版修复：单测全绿，真浏览器无效。因为测试里我手动调用 RO 回调（模拟浏览器行为），而**应用代码根本没 observe 对元素** —— 测试验证的是"收到通知后逻辑对不对"，没验证"通知会不会来"。修法：给假的 `ResizeObserver` 记录 `observe()` 到的元素，断言"内容容器确实被观察到了"。**凡是"事件驱动的修复"，都要有一条断言锁住"事件源确实接上了"**，否则测试只能证明逻辑本身自洽。

52. **★★ `usage.input_tokens` 是"这一轮里各次 API 调用 prompt 的累加"，不是一次 prompt，更不是"会话累计"（v2.7 修）** → 水位行曾把它当"当前上下文占用"除以窗口 ⇒ 显示 `2.6m/1m [██████] 100%`，看着像爆了。实测那一轮 30 次调用合计 **2,573,021（≈2.6m）**，而**单次最大 prompt 只有 125,071（≈12.5%）**。HTTP 层**拿不到**"当前上下文占用"（只有轮末 usage），所以前端只能显示"本轮输入合计"这类量，**不能出现百分比/进度条**（`ContextGauge.vue` 2026-09-15 起的形态）。
53. **★★ 往"正在跑的一轮"里插消息，HTTP 层只有一个端点：`steer`** → `POST /v1/runs/{id}/steer`：不打断、文本挂到**最近一条工具结果**末尾、模型下一次迭代可见（系统提示词里 `## Mid-turn user steering` 明确告诉模型"这是用户本轮指令、不是工具输出、也不是注入"）。两个落空点：① 本轮**没有工具调用** → 文本留到轮末，随 `run.completed.pending_steer` 回传（本客户端**按口径忽略**：不重发、不提示，代码里写明了"别当遗漏去修"）；② run 刚好收尾 → `409 run_not_accepting_steer`（静默降级，不留假气泡）。**"打断 + 把这句话并进同一轮"是内部的 `AIAgent.redirect()`（dashboard 默认 busy 策略走它），HTTP 未暴露**；而再 `POST /v1/runs` 是**并发第二条 run**（实测两条都 `running`、历史落库交叉），**不能当补充用**。按钮按相位分派的口径见 §5.5。
54. **★ 本地反代核验脚本必须删掉 `Origin` / `Referer`** → 否则浏览器发来的请求带 `Origin`，被 API Server 的 CORS 防护直接 **403 空响应**（与坑 21 同源，线上 nginx 就是 `proxy_set_header Origin "";`）。症状是页面报"请求被 Hermes 的 CORS 防护拒绝（403），反代必须清掉它" —— **极易误判成前端 bug**。自建 node 代理里 `delete headers.origin; delete headers.referer` 即可。
55. **★ 真浏览器核验脚本里两个"恒假"陷阱** → ① 用 `.group` 选择器断言**用户**气泡恒为 false：`MessageItem` 只有助手消息那一支带 `.group`，用户消息是另一个分支 ⇒ 断言永远看不到那句话、却很容易误报成"功能没生效"（改用 `document.body.innerText.includes(文本)`）；② 走自建代理时不修坑 54，整页从第一帧就是错误态，后面所有断言都跑在"假现场"上。两个都实测踩过一遍。
56. **★ 用 crossplane 解析这份 `nginx.conf` 会"假失败"** → 它是**片段**（运行时被官方镜像入口脚本塞进 `http{}`），单独 parse 会报 `"upstream"/"server" directive is not allowed here`，**错误行指向的正是文件里本来就有的 upstream/server**，别误判成自己改坏了。正确姿势：`{ echo 'events {}'; echo 'http {'; sed 's/\${HERMES_API_SERVER_KEY}/FAKEKEY/g' nginx.conf; echo '}'; } > /tmp/w.conf` 再 `crossplane parse /tmp/w.conf`，`status: ok` 才算过；顺带能把每个 `location` 的**顺序**打出来，用来确认正则优先级。

57. **★★ "一整轮压成一个气泡"会把顺序信息抹掉（v2.11 修）** → 服务端落库是分条的（`assistant(正文+tool_calls)` → `tool` → `assistant`），
   旧实现把连续 assistant 合并、又把工具统一堆到正文上方 ⇒ "哪段话之后调了什么"永久丢失（用户插话时最明显：放上放下都不对）。
   现在按时间切段（`kind: text | tools`）+ 工具行常驻小字行。**判断有没有改对**：拿服务端 transcript 推一遍段序，与页面 DOM **逐轮对照**（§5.13 的验证脚本）。
58. **★ 交错渲染有三条"容易漏"的规则** → ① **相邻正文仍然合并**（不然一轮碎成十几个小块、每块 24px 缝）；
   ② 一条 assistant **同时有正文和 tool_calls** 时，段序是"正文段在前、工具段在后"（模型先说话后调工具）；
   ③ `role=tool` 结果行通常不直接成段，但**当前工具段为空时会新开一段**（孤儿结果行 —— 宁可多一行，也不把"调过这个工具"丢掉）。
   第 ③ 条最容易被"期望函数"漏掉，从而把实现判成错的。
59. **★ 探针点侧栏会话行：三个坑一起** → ① 按标题片段点，**cron 会话标题会重复** ⇒ 点到别的会话（假失败）；
   ② `aside button` 把行内"重命名/删除"图标按钮也选进来了，`nth(-1)` **会落到"删除"按钮上**（很危险）；
   ③ 断言的元素必须用**内容指纹**复核"打开的确实是要验的会话"。正确姿势：`aside button:not([aria-label])` + 指纹核对；
   指纹要**先去 markdown 记号**（`**粗**`、反引号、列表符在渲染后的 innerText 里搜不到 → 会假跳过）。
60. **★ 对照类核验的两条纪律** → ① 期望函数必须与实现的**窗口假设**一致：应用会把"窗口起点那半轮"保留成一轮（`ask` 为 null），
   期望若丢掉它就整体错位；② **别拿提问文本当对齐键** —— 同一句话发多次的会话会全塌成一条（实测把两个"反例"照出来全是假的），**按下标对齐**。
61. **★ 量"加载更早"的锚偏移有两个经典假象（2026-09-15 两个都踩了）** → ① **锚元素按选择器认**：prepend 之后
   "第一个 `.md-body`"已经是另一条消息，量出 **18391px** 的恐怖假偏移（真实 ≈0）⇒ 用"内容前 40 字"当 key 前后定位同一元素，
   并校验前后命中数都是 1；② **用 playwright 的 `click('[data-testid="earlier"]')` 点那个按钮**：它会**先把按钮滚进视口**
   （scroller 的 scrollTop 先被滚到 ≈0），应用于是按"用户本来就在顶部"做补偿（`scrollTop = 0 + 插入高度`）——**这是正确行为**，
   但会让"原本在视口上方一万九千像素"的锚元素相对视口移动整页高度，量出 **19062px** 的第二个假数。
   正确做法：走**真实路径**（把 scrollTop 设 0 触发自动加载），取"此刻视口顶部那条消息"当参照再比（本次 **Δ=0px**）；
   **A/B 对照**（`/opt/data/.verify/review_0915/ab_anchor2.cjs`：main 产物 vs 本次改动）两边行为一致 ⇒ 不是本次引入的回归。

62. **★ "打开会话"只允许有一个入口** → v2.12 之前 `Sidebar.pick()` 直接 `openSession()`，而 `resumeSync()` 也会自己
   `openSession()`；一旦地址成为状态源，两处入口必然打架（地址 B、画面 A）。改法：所有"打开哪个会话"的意图都变成
   **改地址**，由 `App.vue` 的 `applyRoute()` 统一落地。**凡是发现同一件事有两处实现，就是下一次 bug 的地址**。
63. **★ `pushState/replaceState` 不触发任何事件** → 所以自建 hash 路由必须**手动分发**给自己订阅者；
   同时要听 `popstate`（前进/后退）与 `hashchange`（手改地址/点链接），并用"最后分发过的路由"去重（否则同一次变化分发两遍，
   表现为"打开会话两次/请求翻倍"）。
64. **★ 单测里 `store` 是模块级单例：上一个用例的状态会污染下一个** → RED/GREEN 阶段实测撞到：还原源文件后，
   "地址里有会话 → 启动就进那个会话"这条断言**照样绿**，因为上面那组用例点过会话行、`currentId/messages` 还留着。
   凡是断言"启动态/空态"的新用例，`beforeEach` 里要显式把 `store` 清干净（`currentId/messages/sessions/run`），
   否则 RED 阶段会给出**假通过**。（另：探针脚本忘写 `server.listen()` 会得到 `ERR_CONNECTION_REFUSED`，
   看着像前端崩溃 —— 先查探针自己。）
65. **★ 核验"工具名有没有上屏"时，探针自己会假失败（2026-09-16 踩到）** → 内联工具行的文本是
   `● terminal "sleep 12"`，**标记与名称之间有空格**：按 `' '` 切分取 `[0]` 得到的是圆点本身，
   工具名集合恒为空串 ⇒ "工具名在对话流里可见"这条断言**假失败**（看着像功能没生效，其实是探针解析错）。
   先剥标记再切分：`t.replace(/^[●✓✗]\s*/, '').split(/\s+/)[0]`。
   同一次还踩了个更基础的：打印时用了快照对象的**原始字段名**（`a.wrapperHasHint`）而不是算好的派生字段
   （`out.A.wrapperHasHint`）⇒ 输出 `undefined`，而 SUMMARY 里其实是 `false`。**先看 SUMMARY 再下结论。**
66. **★ 真浏览器探针别写死 `chrome-headless-shell` 的路径**（2026-09-16 踩到） → playwright 升级会把目录名里的
   版本号改掉（实测 `chromium_headless_shell-1234` → `-1243`），写死路径的探针直接报
   `browserType.launch: Failed to launch chromium because executable doesn't exist` —— 看着像浏览器没了，
   其实只是换了目录。**自动发现**：`fs.readdirSync('/opt/hermes/.playwright').filter(d => d.startsWith('chromium_headless_shell-')).sort()` 取最后一个。
67. **★ Vue 会把元素之间的空白"压缩掉"，断言"这一行只有 A 和 B"时别按空格数写**（2026-09-16 踩到） →
   `<span>{{ avatar }}</span>\n<span>🟡</span>` 编译后 `textContent` 是 `-_-🟡`（**没有空格**）——
   视觉上的间距来自 CSS `gap`，不是文本。所以断言要么按内容比（`replace(A,'').replace(B,'').trim() === ''`），
   要么 `not.toContain`；**别写 `toBe('-_- 🟡')`**（这条实测红了一次，看着像功能坏了，其实是断言错）。
68. **★ 服务端新增终态 `interrupted` 没接住 ⇒ 界面永久卡在"忙碌中"（2026-09-16 修，v0.21.3 起）** →
   v0.21.3 给 `/v1/runs` 加了新终态：**网关在这一轮跑完之前重启**时，服务端把该 run 记为
   `status=interrupted` 并发事件 `run.interrupted`（`api_server_runs.py` 的 error 文案
   *"The gateway restarted before this run settled."*）。这套代码当时只把
   `completed/failed/cancelled` 当终态，于是**四个判据点同时漏**，表现不是"显示得差一点"而是**卡死**：
   ① `isTerminalStatus()` 判成"还在跑" ⇒ 恢复时相位停在 `background`；
   ② `send()` 收尾的 status 分支落到 `else` ⇒ `stillRunning=true` 又强制回 `background`；
   ③ 每轮统计的判据（`sawTerminal && !sawError && !cancelled`）⇒ 给半截的轮次算了统计；
   ④ 网关重启会掐断本地流，那个"失败红字"是传输层假报错，没清 ⇒ 看起来像这一轮失败了。
   合起来：`activeRun` 记录不清、**退避轮询永不停止**（实测 60 秒里 6 次状态请求，只能强刷脱身）。
   修法 = 终态清单加 `interrupted` + 单独一个 `ctx.interrupted` 标记（**不复用 `cancelled`**：同呈现、不同成因）
   + 归到 🟠「已中断」并贴轮末「已中断」+ 统计只给真正跑完的轮次。
   **教训：服务端加新终态时，先把"status 比较点"全找一遍再动手**
   （`grep -n "isTerminalStatus\|status === '" src/`），别只改第一处 —— 这次就是一处声明、三处调用、两个分支各漏一次。
69. **★ 这个 clone 是"多会话共用"的：看到自己没动过的文件变了，先找别人的提交**（2026-09-16 踩到） →
   同一个工作区里另一个会话在改 `src/stores/chat.ts` / `resume.spec.ts` / `runs-transport.spec.ts`（修 v0.21.3 的
   `interrupted` 终态，即上面坑 68），而且它**已经提交进 main** ⇒ `git status` 看起来是干净的、什么都没多。
   于是我把"用例数 299 → 303"判成了工具抽风，还写了一条**错的坑**（"vitest 会偶尔少报用例数"）——
   真相是那 4 条用例就是对方新加的（`resume.spec` +3、`runs-transport.spec` +1），文件内容当然和上一轮不同。
   **教训**：① 数字/文件对不上时，先 `git log --oneline -6` 和 `git log <我分支的起点>..HEAD` 看有没有别人的提交，
   再去怀疑工具；② `git status` 干净**不等于**"没人在动这个工作区"—— 对方可能已经提交了；
   ③ **别急着给异常编"工具抽风"这种解释**，那正是最容易写进文档的错误结论（这条坑本身就是因为编错了才存在）。
70. **★★ 同一件事不要在"轮首"和"状态行"都说**（2026-09-16 实测后的结论，撤掉了轮首灯） → v2.14 一度在每轮开头
   挂「头像 + 同款四态灯」，用下来发现：**灯那部分和输入框上方那条 100% 重叠**（状态行位置固定、永远看得见），
   而"历史轮的状态"清一色 🟢 ⇒ 满屏绿点等于没有信息量（真出过问题的轮，轮尾本来就有红字块／「已中断」标记）。
   撤掉后连"必须固定一行高、跑完只换颜色"那条约束也一起消失了（静态头像不会抖）。
   **可复用的判据**：一个"状态显示"要同时满足"位置固定"与"归属明确"才值得存在；只能满足后者时，它的价值 ≈ 0。
