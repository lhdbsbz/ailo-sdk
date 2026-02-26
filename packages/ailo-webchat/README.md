# @lmcl/ailo-webchat

Ailo 网页聊天通道 MCP - 内置 Web UI，基于 `@lmcl/ailo-channel-sdk` 构建。

## 功能

- Web 界面对话：用户通过浏览器与 Ailo 对话
- 用户称呼设置：首次使用可设置如何称呼用户（仅保存在浏览器 localStorage）
- 消息历史：前端 localStorage 持久化
- console 工具：Ailo 通过 MCP 工具将回复发送到网页聊天界面

## 环境变量

由 Ailo MCP 启动时注入，或手动配置：

- `AILO_WS_URL` - Ailo WebSocket 地址
- `AILO_TOKEN` - 通道认证 Token
- `AILO_MCP_NAME` - 通道名称
- `WEBCHAT_PORT` - Web UI 端口，默认 3001

## 使用

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动（需由 Ailo MCP 启动，或配置上述环境变量）
npm start

# 开发模式
npm run dev
```

## 架构

- `WebchatHandler` - 实现 `ChannelHandler`，管理 HTTP + WebSocket 服务
- `createWebchatMcpServer` - 注册 `console` 工具
- `runMcpChannel` - 来自 `@lmcl/ailo-channel-sdk`，连接 Ailo 并启动通道
