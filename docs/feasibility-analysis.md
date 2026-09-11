# Hermes Chat Lite —— 可行性分析

> 结论：**可行，难度低**。Hermes 侧不需要任何改动；本项目是一个纯展示层，约 1～1.5 人日可完成第一版。
> 本文所有接口结论均在 **2026-09-11** 于本机 `hermes:8642` 实测验证，非文档推断。

---

## 一、结论速览

| 问题 | 结论 |
| --- | --- |
| 能不能做 | 能。所需 4 个能力（会话列表 / 历史消息 / 发送 / 流式）Hermes API Server **全部已内置** |
| 难度 | 低。前端 4 个组件 + 1 个 api 封装，无后端开发、无数据库、无用户体系 |
| 需要改 Hermes 吗 | **不需要**。零侵入，不加插件、不改配置（除可选的 CORS/暴露面加固） |
| 主要风险 | **不是技术风险，是安全风险**：同源反代注入 key 后，谁能打开这个域名，谁就拿到完整 agent（可执行 shell、读写数据库） |
| 预计工作量 | 前端 ~900 行（含样式），部署 ~60 行。分 4 个阶段，见详细设计的实施计划 |

---

## 二、可行性依据（实测）

### 2.1 Hermes 侧已有的能力

`/opt/hermes/gateway/platforms/api_server.py`（7646 行）已实现完整 REST + SSE 面。实测返回：

```
GET /health            → {"status":"ok","platform":"hermes-agent","version":"0.20.4"}
GET /api/sessions      → 200，实测返回真实会话（title/model/last_active/message_count/preview…）
GET /api/sessions/<id>/messages → 200，实测返回 role/content/timestamp/tool_calls…
无 Authorization        → 401（key 校验生效）
```

`/v1/capabilities` 自报的关键能力位（本机实测）：

```
session_chat: true            session_chat_streaming: true
session_resources: true       session_fork: true
run_events_sse: true          tool_progress_events: true
cors: false                   ← 注意，见风险 3.2
runtime.tool_execution: "server"  ← 工具在 Hermes 容器内真实执行
```

### 2.2 需求 → 接口映射（全部命中，无缺口）

| 需求 | 接口 | 状态 |
| --- | --- | --- |
| 功能1 会话列表（标题 + 更新时间 + 点击切换） | `GET /api/sessions?limit=&offset=` | ✅ 直接可用 |
| 功能1 新建会话 | `POST /api/sessions` | ✅ 直接可用 |
| 功能2 历史消息（含 Markdown/高亮） | `GET /api/sessions/{id}/messages?order=latest` | ✅ 直接可用 |
| 功能3 发送消息 | `POST /api/sessions/{id}/chat/stream` | ✅ 直接可用 |
| 功能4 流式响应 | 同上，SSE 命名事件 | ✅ 直接可用，逐字 delta |
| 验收8 Docker 部署 | 静态站 + nginx 反代 | ✅ 常规做法 |

**结论：需求清单里没有任何一项需要 Hermes 侧配合开发。** 这是本项目难度低的根本原因——原生 API Server 暴露的比这个需求要多（还有 fork、model lock、jobs 管理、skills/toolsets 发现等，第一版都不需要）。

---

## 三、风险与关键决策点

### 3.1 ⚠️ 最大风险：暴露面 = 完整 agent 权限

这是本项目**唯一需要认真对待**的问题，与技术无关：

- api_server 的运行模式是 `server_agent`，`tool_execution: "server"`——**每条消息都会真实执行工具**（读写文件、跑脚本、连 MySQL/Redis、发邮件）。
- 需求里"不做登录/权限/多用户"是合理的（Hermes 自己管 session），但前端必须拿到 `API_SERVER_KEY`。**key 不能编译进浏览器产物**（F12 就能看到），所以只能用同源反代在第 7 层注入 `Authorization`。
- 后果：反代层一旦挂到公网域名，**任何知道 URL 的人 = 拥有一台能操作你服务器的 agent**。这与 Open WebUI 不同（它自带登录）。

**建议（三选一，按推荐度排序）：**

1. **Caddy 加 basic_auth**（推荐）：一个账号密码挡在反代入口，5 行配置。前端零改动。
2. **不挂公网域名**，只在局域网/内网访问。
3. 前端加一个自建口令闸门（需要在容器里再跑一个小代理持 key，复杂度上升，不推荐）。

> 决策点：[待确认] 是否接受 Caddy basic_auth？如果选 2，本项目的部署章节可简化。

### 3.2 CORS 关闭的真实行为：不是"跨域被拦"，而是"带 Origin 直接 403"

实测 `capabilities.features.cors: false`，并且**实测发现它的行为比预期更硬**：

```
直连 POST /api/sessions 不带 Origin           → 201
直连 POST /api/sessions 带 Origin: https://…  → 403（空 body，Server: Python/3.x aiohttp）
```

Hermes 的 CORS 中间件在 CORS 未配置时，对**任何携带 `Origin` 头的请求**直接返回 403（防 CSRF）。**浏览器所有 POST 请求都自带 `Origin`，而 curl/脚本不发这个头** —— 所以这个坑在命令行测试里 100% 看不见，只在真机浏览器上炸（本项目部署时真实踩到，排查代价不小）。

修法（二者都在反代层，不需要改 Hermes 配置、不需要重启 gateway）：

| 环境 | 做法 |
| --- | --- |
| 生产 nginx | `proxy_set_header Origin "";`（请求头设为空字符串 = 不向后端传递） |
| 开发 vite | dev proxy 的 `configure` 里 `proxyReq.removeHeader('origin')` |

开启了 `API_SERVER_CORS_ORIGINS` 也能绕过，但要重启 gateway，且把浏览器跨域能力打开，不如在反代层剥掉干净。

架构（含 Origin 处理）：

```
浏览器 → chat.<域名> → Caddy (+basic_auth) → chatlite:80
         nginx 静态站 + /api /v1 反代（注入 Authorization，剥掉 Origin）
                                              ↓ [net_openclaw]
                                         hermes:8642
```

### 3.3 历史消息不是纯文本，必须过滤

实测 `GET /messages` 返回的 `data[]` 里混有 **tool 消息**、**content 为空但带 tool_calls 的 assistant 消息**、以及超长的 `reasoning` 字段（实测单条 reasoning 上万字符）。

过滤规则（写进详细设计）：
- 只渲染 `role ∈ {user, assistant}`；
- `role=assistant` 且 `content` 为空 → 跳过（它是工具调用轮）；
- `content` 可能是 `string` 或**数组**（多模态）→ 取其中 `type=text` 的片段拼接；
- `reasoning` / `reasoning_content` 第一版不展示（可选折叠面板，v2）。

### 3.4 流式中断行为（需接受的 v1 限制）

实测服务端逻辑：SSE 客户端断开时会调用 `_drain_session_stream_task_on_disconnect(interrupt_message="SSE client disconnected")`——**即浏览器刷新/关标签页会打断服务端正在跑的 turn**。第一版接受此行为并在文档中标注；恢复靠重新加载历史消息。

### 3.5 同一 session 双端并发

Web 里点开会话 A 并发送时，若 TUI 正在同一 session A 上跑 turn，属于同一 session 的并发使用。第一版策略：**前端显示"生成中"时禁用输入框**，避免自发并发；不处理跨端并发（属 Hermes 侧会话语义，不在本项目范围）。

### 3.6 其他小坑（已确认）

| 坑 | 影响 | 处理 |
| --- | --- | --- |
| 时间戳是 Unix 秒（float） | 需转本地时间 | 前端 `new Date(ts*1000)` + `Intl.DateTimeFormat` |
| `POST /api/sessions` 标题唯一约束 | 重名 400 | 前端不传 title，交给 Hermes 首轮后自动生成标题 |
| `run.completed` 里含整轮 transcript | 若渲染会重复内容 | 只渲染 `assistant.completed.content` |
| SSE 每 30s 发 `: keepalive` 注释行 | 解析器需忽略注释 | 解析时跳过非 `data:` 行 |
| 长会话（实测 message_count=598） | 一次拉 500 条会卡 | 默认 `order=latest&limit=100`，滚动到顶再往前取 |
| 单条响应可能很长 | 渲染卡顿 | markdown 全量重渲染 + rAF 节流（不用增量 diff） |

---

## 四、工作量拆解

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| P0 工程搭建 | Vite + Vue3 + TS + Tailwind + 依赖，`hermes.ts` 封装 | 0.2 天 |
| P1 只读链路 | Sidebar 会话列表 + 日期分组 + 历史消息渲染（markdown/高亮） | 0.5 天 |
| P2 写链路 | InputBox + Enter/Shift+Enter + 新建会话 + 乐观插入用户消息 | 0.2 天 |
| P3 流式 | SSE 解析器 + 逐字渲染 + tool 进度提示 + 停止/错误处理 | 0.3 天 |
| P4 部署 | Dockerfile + nginx.conf + compose（用户宿主机执行）+ Caddy 配置 | 0.2 天 |

**合计 ≈ 1.4 人日**，其中 P3 是唯一有技术含量的部分（约 120 行 SSE 解析）。

---

## 五、分工

| 事项 | 谁做 |
| --- | --- |
| 前端代码、api 封装、SSE 解析、nginx.conf、Dockerfile、compose 文件 | Hermes（本机 `/opt/data/hermes-chat-lite`，可推 feature 分支） |
| 建 GitHub 仓库、宿主机 `docker compose up -d --build`、Caddy 配置与域名 | 用户（按既往约定：编译/部署/宿主机操作由您执行） |
| 决定暴露面方案（basic_auth / 内网） | 用户 |

---

## 六、结论

需求设计本身是**准确的**——它没有要求任何 Hermes 不提供的东西，也没有把 agent 逻辑放到前端（这是外行最容易犯的错）。技术上是标准的"薄客户端 + 流式渲染"题目，**建议直接进入开发**；唯一需要先定的是暴露面方案（3.1）。

详细设计见：`docs/detailed-design.md`
