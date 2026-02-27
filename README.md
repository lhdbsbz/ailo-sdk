# Ailo SDK

Ailo 多渠道端点 SDK，通过统一的 [Endpoint Protocol](WEBSOCKET_LIMB_PROTOCOL.md) 将各类消息平台和设备接入 Ailo 意识核心。

## 项目结构

```
sdks/
  ailo-endpoint-sdk/     核心 SDK — EndpointClient + runEndpoint 框架

packages/
  ailo-feishu/           飞书通道（Lark WS 收消息 + Open API 发消息）
  ailo-dingtalk/         钉钉通道（Stream 模式收消息 + sessionWebhook 发消息）
  ailo-qq/               QQ 通道（Bot WS Gateway 收消息 + REST API 发消息）
  ailo-discord/          Discord 通道（Discord.js Gateway + REST API）
  ailo-webchat/          网页聊天通道（内置 HTTP+WS 服务器）
  ailo-email/            邮件通道（IMAP 收信 + SMTP 发信）
  ailo-desktop/          桌面端点（文件系统/Shell/截图/MCP 工具）

blueprints/              各通道的蓝图声明文件（工具定义 + 说明文档）
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 构建

```bash
npm run build
```

### 3. 启动渠道

每个渠道包是独立进程，配置好环境变量后即可启动：

```bash
# 飞书
cd packages/ailo-feishu && cp .env.example .env  # 编辑 .env 填入凭据
npm start

# 钉钉
cd packages/ailo-dingtalk && cp .env.example .env
npm start

# QQ
cd packages/ailo-qq && cp .env.example .env
npm start

# Discord
cd packages/ailo-discord && cp .env.example .env
npm start
```

## 各渠道环境变量

### 通用变量（所有渠道共用）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AILO_WS_URL` | Ailo WebSocket 地址 | `ws://localhost:19800/ws` |
| `AILO_API_KEY` | Ailo API Key | — |
| `AILO_ENDPOINT_ID` | 端点唯一标识 | — |

### 飞书

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |

获取方式：[飞书开放平台](https://open.feishu.cn/) → 创建企业自建应用 → 凭证与基础信息

### 钉钉

| 变量 | 说明 |
|------|------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID (AppKey) |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret (AppSecret) |

获取方式：[钉钉开发者后台](https://open-dev.dingtalk.com/) → 企业内部应用 → 机器人（选择 Stream 模式）

### QQ

| 变量 | 说明 |
|------|------|
| `QQ_APP_ID` | QQ 机器人 App ID |
| `QQ_APP_SECRET` | QQ 机器人 App Secret |
| `QQ_API_BASE` | API 地址（可选，沙箱用 `https://sandbox.api.sgroup.qq.com`） |

获取方式：[QQ 开放平台](https://q.qq.com/) → 应用管理 → 机器人

### Discord

| 变量 | 说明 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord Bot Token |
| `DISCORD_HTTP_PROXY` | HTTP 代理地址（可选，国内访问需要） |

获取方式：[Discord Developer Portal](https://discord.com/developers/applications) → 创建应用 → Bot → Token

## 架构说明

所有渠道遵循统一架构：

```
第三方平台 → XxxHandler (implements EndpointHandler)
                ↓ ctx.accept(AcceptMessage)
            EndpointClient → WS → Ailo Gateway → Agent Loop
                ↑ onToolRequest(send)
            EndpointClient ← tool_request ← Ailo
                ↓
            XxxHandler.sendText() → 第三方平台
```

每个渠道通过 `contextTags` 携带路由信息（`chat_id`、`sender_id`、`conv_type` 等），Ailo 根据 `chat_id` 的 `groupWith` 标记自动管理会话分组。回复通过蓝图工具 `send` 触发，Ailo 调用 `tool_request` 事件，渠道 handler 接收后调用各平台发送 API。

## 开发新渠道

1. 在 `packages/` 下创建新目录
2. 实现 `EndpointHandler` 接口（`start(ctx)` + `stop()`）
3. 在 `index.ts` 中调用 `runEndpoint()`
4. 在 `blueprints/` 下创建对应蓝图文件
