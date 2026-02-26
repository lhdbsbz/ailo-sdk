# @lmcl/ailo-webchat

Ailo 网页聊天端点 MCP - 内置 Web UI，基于 `@lmcl/ailo-endpoint-sdk` 构建。

## 功能

- Web 界面对话：用户通过浏览器与 Ailo 对话
- 用户称呼设置：首次使用可设置如何称呼用户（仅保存在浏览器 localStorage）
- 消息历史：前端 localStorage 持久化
- console 工具：Ailo 通过 MCP 工具将回复发送到网页聊天界面

## 环境变量

由 Ailo 端点管理后台拉起时注入，或手动配置：

- `AILO_WS_URL` - Ailo WebSocket 地址
- `AILO_API_KEY` - 端点 API Key
- `AILO_ENDPOINT_ID` - 端点唯一 ID
- `WEBCHAT_PORT` - Web UI 端口，默认 3001
- `BLUEPRINT_WEBCHAT_URL` - 蓝图 URL（可选，本地开发用 `.env` 覆盖，默认从 GitHub raw 拉取）

## 使用

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动（需由 Ailo 端点管理后台拉起，或配置上述环境变量）
npm start

# 开发模式
npm run dev
```

本地开发时在包目录创建 `.env`，例如：
```
BLUEPRINT_WEBCHAT_URL=C:/path/to/ailo-sdk/blueprints/webchat-channel.blueprint.md
```

## 架构

- `WebchatHandler` - 实现 `EndpointHandler`，管理 HTTP + WebSocket 服务
- `createWebchatMcpServer` - 注册 `console` 工具
- `runEndpoint` - 来自 `@lmcl/ailo-endpoint-sdk`，连接 Ailo 并启动端点
