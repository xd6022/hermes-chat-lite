# Hermes Chat Lite

一个超轻量的 Hermes Web 聊天客户端：只做展示层（会话列表 / 历史消息 / 发送 / 流式渲染），Agent、Session、Memory、工具调用全部由 Hermes 负责。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/feasibility-analysis.md`](docs/feasibility-analysis.md) | 可行性分析：结论、实测依据、风险（含暴露面）、工作量 |
| [`docs/detailed-design.md`](docs/detailed-design.md) | 详细设计：可从零照着开发（API 契约 / SSE 事件表 / 组件 / 部署 / 实施计划 / 坑清单） |

## 一句话结论

Hermes API Server 已内置所需全部端点（`/api/sessions`、`/api/sessions/{id}/messages`、`POST /api/sessions/{id}/chat/stream`），前端零后端、零数据库、零用户体系，**约 1.4 人日**。唯一需要先定的是暴露面方案（建议 Caddy basic_auth）。

## 架构

```
浏览器 → chat.<域名> → Caddy(+basic_auth) → chatlite:80 (nginx 静态站 + /api /v1 反代注入 Authorization)
                                                    ↓ [net_openclaw]
                                               hermes:8642
```

## 状态

未开始编码。进度看板在 `docs/detailed-design.md` 第 0 节。
