# Hermes Chat Lite

一个超轻量的 Hermes Web 聊天客户端：**只做展示层**（会话列表 / 历史消息 / 发送 / 流式渲染），Agent、Session、Memory、工具调用全部由 Hermes 负责。

- 前端：Vue3 + TypeScript + Vite + Tailwind CSS，markdown-it + highlight.js
- 无后端、无数据库、无用户体系；数据全部来自 Hermes API Server
- 相对 Open WebUI 的关键改进：**看得见工具执行、看得见本轮结束、看得见每轮 token 与缓存命中**
- 界面：会话搜索（本地标题过滤）、桌面侧栏可折叠、白天/黑夜模式（跟随系统 + 手动覆盖）、会话改名与单个删除（行内原位操作）
- 发送通道走 Hermes 原生 `/v1/runs`：**危险操作能在网页上批准/拒绝**（批准一次 / 本会话都允许 / 永久允许 / 拒绝），并能真正中断正在跑的一轮

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/feasibility-analysis.md`](docs/feasibility-analysis.md) | 可行性分析：结论、实测依据、风险（暴露面）、工作量 |
| [`docs/detailed-design.md`](docs/detailed-design.md) | 详细设计：**接手先读 §0 状态看板 + §0.1 跨会话续接**，含 API 契约、SSE 事件表、组件设计、部署、坑清单（42 条）、验证证据（§10.1 / §10.2） |
| [`docs/plans/2026-09-12-runs-transport.md`](docs/plans/2026-09-12-runs-transport.md) | A 方案（`/v1/runs` 通道）计划书 + 状态看板 + 实测证据流水 |

## 架构

```
浏览器 → chat.<域名> → Caddy(+basic_auth) → chatlite:80 (nginx 静态站 + /api /v1 反代注入 Authorization)
                                                          └─ /api/model-info 单独反代到 **hermes:9119**（dashboard 后端，
                                                             只读，取上下文窗口上限；不在 API server 上，见 nginx.conf）
                                                    ↓ [net_openclaw]
                                               hermes:8642 (API Server)
```

**API_SERVER_KEY 不进浏览器**：`/api`、`/v1` 的 `Authorization` 头由 nginx（生产）或 vite dev proxy（开发）在反代层注入。因此**反代入口必须加 basic_auth**——否则任何知道域名的人等于拿到一台能操作服务器的 agent（Hermes 的工具在服务端真实执行）。

## 开发

```bash
npm install --registry=https://mirrors.cloud.tencent.com/npm/
npm approve-scripts esbuild          # npm 11 必须：否则 esbuild postinstall 被拦，vite 起不来

# 起 dev server（key 从进程环境读，不落文件）
set -a && . <hermes 部署目录>/.env && set +a
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173

# 自检：反代 + 鉴权通不通（期望 200 + 真实会话 JSON）
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:5173/api/sessions?limit=3"
```

> 本机（hermes 容器内）注意：`./node_modules/.bin/<x>` 会被终端拦截（误判为重启网关），一律用
> `node node_modules/<pkg>/bin/<x>.js`。所以 `npm run dev` 在这个环境里跑不通，用上面的 node 直跑形式。

## 测试 / 类型检查 / 构建

```bash
node node_modules/vitest/vitest.mjs run          # 122 个用例（不打真 API，秒级）：SSE 半帧切片、中文多字节切分、过滤规则、输入法、输入框布局、侧栏搜改删、删除后空壳复查、安全闸门提示、历史分页与消息合并、/v1/runs 通道（事件名归一化/审批状态机/中断/断线回读）、审批卡片组件、集成、搜索/折叠/主题
npm run typecheck                                # vue-tsc --noEmit
npm run build                                    # 产物约 297KB（gzip 114KB）+ CSS 29KB

# 真实链路回归（可选，打真 API + 真模型，约 40 秒、会烧 token）
set -a && . /opt/data/.env && set +a
npm run e2e                                      # 普通轮 / 工具轮 / 中断 / 历史回归 / 清理，只用自建探针会话并跑完自删
```

> `npm run e2e` 的两条纪律：① 探针会话会先钉 `xyy/deepseek-flash`（不钉的话走网关默认
> `qwen3.8-flash`，实测它会把"只回复两个字"执行成一整套复盘）；② 断言只赌结构不赌措辞。

## 部署（宿主机执行）

```bash
cd <部署目录>/hermes-chat-lite

# 1) 写 .env —— 从 hermes 部署目录的 .env 自动取值（两个可能的变量名都兼容）
#    ⛔ 不要照抄 .env.example 里的占位符：照抄 = 所有接口 401（页面能开、侧栏空）
HERMES_DIR=<hermes 部署目录>
KEY=$(grep -hE '^[[:space:]]*(HERMES_)?API_SERVER_KEY=' "$HERMES_DIR/.env" | head -1 | sed 's/^[^=]*=//' | tr -d '\042\047\r ')
printf 'HERMES_API_SERVER_KEY=%s\n' "$KEY" > .env && chmod 600 .env

# 2) 自检：长度必须是 64（不是 64 就说明取错了）
awk -F= '/^HERMES_API_SERVER_KEY=/{print length($2)}' .env

# 3) 起容器
docker compose up -d --build
docker compose ps          # 期望 healthy：healthcheck 打的是【需要鉴权】的 /api/sessions，
                           # 所以它同时验证了 nginx 反代 + 密钥有效（/health 不鉴权，验不出来）
docker compose logs --tail=30 chatlite
```

Caddy：

```caddyfile
chat.<域名> {
    basic_auth {
        <用户名> <bcrypt 哈希>
    }
    reverse_proxy chatlite:80 {
        flush_interval -1      # SSE 必须不缓冲
    }
}
```

**上线自检**：
1. 域名打开 → 顶栏绿点 + `v0.20.4`，侧栏出现真实会话（侧栏空 + 提示"接口密钥无效或未注入" = .env 的 key 不对）
2. 点会话 → 历史消息渲染正常（无 tool/JSON 噪音），代码块高亮
3. 发一条消息 → 文字**逐字**出现；长任务时状态条显示 `🔧 正在使用 xxx…`，结束后消息下方常驻一行统计 `⏱ 3.6s · 输入 27.3k · 缓存 26.6k (97%) · 输出 20`（若这里变成"等全部返回才显示"，就是 nginx 少了 `proxy_buffering off`）
4. 顶栏右侧太阳/月亮按钮 → 整站换色（刷新后保持）；左上按钮 → 桌面折叠/展开侧栏（刷新后保持）；侧栏搜索框输入关键字 → 列表实时过滤，搜不到显示 `没有匹配「…」的会话`
5. 打开一个长会话（上百条）→ 往上滚，到顶附近会**自动**加载更早的历史（不跳位）；顶部也常驻一个 `加载更早的消息` 按钮可手动点；翻到会话第一条后按钮消失。同一轮回答的多段文字应当是**连成一段**的（不再是一段一段分开、中间空行）；顶部若出现 `内部上下文摘要（Hermes 压缩边界）` 说明该会话被上下文压缩过，默认折叠
6. 侧栏某行 hover（手机上是常显）→ 出现铅笔/垃圾桶图标：铅笔是**原位改名**（Enter 保存 / Esc 取消，重名或超 100 字会行内红字提示），垃圾桶先出 `删除「标题」？` 二次确认（**不可恢复**，删掉的若是当前会话会回到空态）。**改名/确认中直接点右侧对话区或按 Esc 会自动收起**，不必去点 ✕/取消。⚠️ 只支持单个删除，这是刻意的（服务端无批量端点 + 曾经误删过真实会话不可恢复）
7. **审批卡片**（`/v1/runs` 通道新能力）：让 agent 做需要人工批准的操作时，状态条变成 `等待你批准：<工具名>`，下面出现蓝色卡片（工具名 + 被标红的命令原文 + 按钮）。点 `批准一次` 后服务端继续执行、卡片显示"已回话"。**注意触发概率低**：本环境里被标红的命令大多被 smart approval（辅助模型）自动放行，日志历史上 0 次真审批 → 真机若要验收，可让 agent 执行一条更激进的命令（会真执行，请自担风险），或直接看 `src/components/RunStatus.spec.ts` 的 8 条用例。想让所有通道整体退回旧行为：把 `src/stores/chat.ts` 的 `DEFAULT_TRANSPORT` 改成 `'stream'`
8. 中断：任务跑着时点停止 → 状态条变 `回复中断`，且**服务端那一轮真的停了**（`GET /v1/runs/{id}` 的 status 变 `cancelled`；旧通道只是断开连接、服务端还在跑）
9. **手机上打开含宽表格的会话**（例如让 agent 输出一张 10 列行情表）：**整个消息区不能左右拖动**，只有表格自己那一小块能横滑；表格**之后**的普通消息应当占满屏宽、没有多余横向空白。页面本身（`window.scrollX`）始终为 0 —— 详见 §12 坑 43 与 `docs/detailed-design.md` §10.3 的验证数字
10. **手机上切后台再回来（v2.2 重点，只能在真机验）**：发一条要跑十几秒的任务（例如"运行 shell 命令 sleep 30，结束后回复完成"）→ 立刻切到别的 App 等十几秒 → 切回来。期望：状态条是蓝色 `连接已暂时中断，任务仍在后台执行（回到页面会自动同步）`（**不是**"回复中断"），随后自动同步成 `完成` 并把正文补出来；任务执行期间那条 **停止** 按钮一直可用（点了就真的取消）。再极端一点：任务跑着时**刷新页面**、或者干脆**切后台等系统把标签页回收掉**（v2.2.2 起：重开时会**自动打开那一轮所在的会话**并显示"还在后台执行"，**不需要您手点会话**）；极端情况下若看到红色横幅，也应当是中文那句 `网络请求没有发出去…` 且网络恢复后**自动消失**（不会再要您点"重试"）

**排错对照表**（都是实测踩过的）：

| 现象 | 病因 |
| --- | --- |
| 发消息**没有逐字输出、工具时间线也空**，只有一段正文（像"流式坏了"） | `/v1/runs` 的 SSE 帧**没有 `event:` 行**，事件名在 JSON 的 `event` 字段里；照旧通道写法解析会把全部事件当未知事件忽略。已在 `api/runs.ts` 的 `runEvents()` 归一化修掉，见 docs §12 坑 38 |
| 状态条显示"事件流中断，本轮内容已从会话记录回读补齐" | 事件流断开（它**一次性、不可重连**）。客户端已自动回读会话把内容补齐并如实标注；频繁出现就查网络/反代超时 |
| 危险操作**只显示"被安全闸门拦下"而不是审批卡片** | 那是旧通道（`chat/stream`）的 fail-closed 行为 → 确认 `DEFAULT_TRANSPORT = 'runs'`；另外被 smart approval 自动放行的命令本来就不会弹卡片（本环境绝大多数是这种） |
| 点停止后界面显示"完成"而不是"中断" | 已被修：`run.cancelled` 是终止事件但不是完成事件，需另立 `cancelled` 标记（见 docs 坑 40） |
| 删掉的会话过一会儿又回来了（标题是刚生成的、0 条消息） | 服务端缺陷：删除后迟到的异步写入（token 计数）会 upsert 把会话行重建。客户端已加 2s 复查再删兜底；根治需在宿主机应用 `/opt/data/.verify/apply_ghost_fix.py`（需 root）+ 重启 gateway-default。见 docs §5.10 与坑 36 |
| 接口 **403**、body 空，但 key 是对的 | Hermes 的 CORS 中间件拒绝了**带 `Origin` 头**的请求。nginx 的 API location 必须有 `proxy_set_header Origin "";`。浏览器必带 `Origin`、curl 不带 → 命令行测不出来，只在真机炸 |
| 接口 **401** | 反代没注入 `Authorization`，或 key 值不对（自检：`awk -F= '{print length($2)}' .env` 应为 64） |
| 流式变一次性返回 | 缺 `proxy_buffering off` |
| 容器 **unhealthy** | key/反代有问题（healthcheck 打的是需要鉴权的 `/api/sessions`，不是 `/health`） |
| **手机上刷了好几次还是老版本** | 入口 `index.html` 原先没有任何 `Cache-Control`（只有 ETag/Last-Modified）→ 浏览器（尤其国产浏览器的 webview 缓存/云加速）一直用旧 HTML，而旧 HTML 又引用旧的 hash 产物，于是"怎么刷都是旧版"。已在 `nginx.conf` 给 `location = /index.html` 加 `no-store`（带 hash 的 `/assets/` 长缓存保持不变）。**临时绕过**：地址后加查询串（如 `https://chat.1597133.xyz/?v=2`）或开无痕标签页。部署后自检：`docker compose exec -T chatlite wget -S -q -O /dev/null http://127.0.0.1/index.html 2>&1 \| grep -i cache-control` 应看到 `no-store`。**判断"现在是哪一版"**：顶栏 `Hermes v0.20.4 · 09-13 20:20` 后面那串小字就是**前端构建标识**（构建时自动生成；本机构建还带短 sha）；设置面板"连接"里与空态底部有完整形态 |
| 点发送毫无反应 | 早期版本的锅（错误静默）；现在会显示红色横幅 + 重试 |
| **手机上宽表格把整个聊天区撑宽、能左右拖** | 表格原先写 `width:100%`，但表格的实际宽度**不会小于各列内容的最小宽度**（10 列 ≈ 650px）→ 溢出被消息区的滚动容器接住，变成"整块聊天区能横滑"。已在渲染层给表格包 `.table-wrapper`（`overflow-x:auto`）+ 正文容器 `min-width:0`/`overflow-wrap:anywhere` 修掉，见 docs §12 坑 43；**注意别用 `body{overflow-x:auto}` 糊**（那是把 bug 从"消息区滚"变成"整页滚"） |
| **手机切后台再回来，回复看着"断了"/要刷新才恢复** | v2.1 及以前只在"页面还活着"时做轮末对账，页面被冻结/回收就补不回来。v2.2 起：轮次状态记在 `localStorage`，回到前台（`visibilitychange`/`focus`/`pageshow`/`online`）自动问 `GET /v1/runs/{id}` 再回读会话补正文；服务端那一轮**不受前端连接影响**（断开 ≠ 取消，只有点"停止"才取消）。v2.2.1 起：回前台瞬间网络抖动留下的**假报错**（英文 `Failed to fetch` 横幅、成功回复下面的红字）会自愈。v2.2.2 起：**标签页被系统回收后重开**也能自动打开那一轮所在的会话并同步（记录必须放 `localStorage`，`sessionStorage` 会被回收清掉）。见 docs §5.12 与 §12 坑 44/45 |

**操作纪律（血的教训）**：`DELETE /api/sessions/{id}` 是**硬删除**（会话 + 消息一起没，无回收站，MySQL 归档每天 21:00 才跑一次）。清理测试会话**必须用显式 id 白名单**——用 `source=api_server` 之类的条件批量删，会把真实会话一起删掉且不可恢复。详见 `docs/incident-2026-09-11-deleted-session.md`。

## 目录

```
src/
├── api/       types.ts（接口类型）· hermes.ts（会话/历史/改删）· runs.ts（/v1/runs：提交·订流·中断·审批回话）· sse.ts（SSE 解析器，POST/GET 通用）
├── stores/    chat.ts（reactive store + 双通道事件归约 + 完成态判定 + 轮末回读对账）
├── components/ Sidebar · ChatWindow · MessageItem · InputBox · RunStatus（含审批卡片）
└── lib/       markdown.ts（按需注册高亮语言 + 给表格包 `.table-wrapper`，见 §12 坑 43）· format.ts（时间/分组）· theme.ts（白天/黑夜）· security.ts（安全闸门判据）
     page-lifecycle.ts  前台/网络恢复信号 + 重连退避（v2.2，见 §12 坑 44）
     style.css       超宽内容的宽度契约（表格/代码块自己滚，页面与消息区永不横滑）
     style.spec.ts   CSS 契约回归（v2.1）；markdown.spec.ts / MessageItem.spec.ts 锁表格 wrapper 结构
     test-setup.ts   测试环境补 localStorage（见 §12 坑 24）
e2e/           real-runs.e2e.spec.ts + background-resume.e2e.spec.ts + vitest.config.ts（真实链路回归，`npm run e2e`，不进 `npm test`）
docs/plans/    跨会话计划书与状态看板
```

提交历史与逐阶段验证记录见 `docs/detailed-design.md` §0 / §10.1 / §10.2。
