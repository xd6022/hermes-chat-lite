# Hermes Chat Lite

一个超轻量的 Hermes Web 聊天客户端：**只做展示层**（会话列表 / 历史消息 / 发送 / 流式渲染），Agent、Session、Memory、工具调用全部由 Hermes 负责。

- 前端：Vue3 + TypeScript + Vite + Tailwind CSS，markdown-it + highlight.js
- 无后端、无数据库、无用户体系；数据全部来自 Hermes API Server
- 相对 Open WebUI 的关键改进：**看得见工具执行、看得见本轮结束**

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/feasibility-analysis.md`](docs/feasibility-analysis.md) | 可行性分析：结论、实测依据、风险（暴露面）、工作量 |
| [`docs/detailed-design.md`](docs/detailed-design.md) | 详细设计：**接手先读 §0 状态看板 + §0.1 跨会话续接**，含 API 契约、SSE 事件表、组件设计、部署、坑清单（19 条）、验证证据 |

## 架构

```
浏览器 → chat.<域名> → Caddy(+basic_auth) → chatlite:80 (nginx 静态站 + /api /v1 反代注入 Authorization)
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
node node_modules/vitest/vitest.mjs run          # 28 个用例：SSE 半帧切片、中文多字节切分、过滤规则、输入法、集成
npm run typecheck                                # vue-tsc --noEmit
npm run build                                    # 产物约 271KB（gzip 106KB）
```

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
3. 发一条消息 → 文字**逐字**出现；长任务时状态条显示 `🔧 正在使用 xxx…`，结束后常驻 `✓ 完成 · Ns · M 个工具调用`（若这里变成"等全部返回才显示"，就是 nginx 少了 `proxy_buffering off`）

**排错对照表**（都是实测踩过的）：

| 现象 | 病因 |
| --- | --- |
| 接口 **403**、body 空，但 key 是对的 | Hermes 的 CORS 中间件拒绝了**带 `Origin` 头**的请求。nginx 的 API location 必须有 `proxy_set_header Origin "";`。浏览器必带 `Origin`、curl 不带 → 命令行测不出来，只在真机炸 |
| 接口 **401** | 反代没注入 `Authorization`，或 key 值不对（自检：`awk -F= '{print length($2)}' .env` 应为 64） |
| 流式变一次性返回 | 缺 `proxy_buffering off` |
| 容器 **unhealthy** | key/反代有问题（healthcheck 打的是需要鉴权的 `/api/sessions`，不是 `/health`） |
| 点发送毫无反应 | 早期版本的锅（错误静默）；现在会显示红色横幅 + 重试 |

## 目录

```
src/
├── api/       types.ts（接口类型）· hermes.ts（唯一发请求处）· sse.ts（POST+SSE 解析器）
├── stores/    chat.ts（轻量 reactive store + SSE 事件分发 + 完成态判定）
├── components/ Sidebar · ChatWindow · MessageItem · InputBox · RunStatus
└── lib/       markdown.ts（按需注册高亮语言）· format.ts（时间/分组）
```

提交历史与逐阶段验证记录见 `docs/detailed-design.md` §0 / §10.1。
