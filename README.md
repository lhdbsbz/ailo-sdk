# Ailo SDK

Endpoint SDK for connecting messaging platforms, desktop agents, and IoT devices to an [Ailo](https://github.com/lhdbsbz/ailo) server via the unified [Endpoint Protocol](ENDPOINT_PROTOCOL.md).

## Project Structure

```
sdks/
  ailo-endpoint-sdk/       Core SDK — EndpointClient + runEndpoint bootstrap

packages/
  ailo-desktop/            Desktop agent（集成 Feishu、钉钉、QQ、邮件、MCP、截图、浏览器等）
  ailo-clawwork/           Clawwork 评测端点

blueprints/                Blueprint files for each endpoint (tool definitions + usage docs)
skills/                    Built-in skill definitions (SKILL.md format)
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Launch an endpoint

Each endpoint runs as an independent process. After building, start any endpoint and open its config UI to fill in credentials — no `.env` files needed.

```bash
# Desktop Agent（集成 Feishu、钉钉、QQ、邮件、MCP、截图等）
cd packages/ailo-desktop && npx ailo-desktop init
npm start
# 配置界面端口：启动时用 --port <端口> 指定，或运行后按提示输入；访问 http://127.0.0.1:<端口>

# Clawwork 评测端点
cd packages/ailo-clawwork && npm start
# Open http://127.0.0.1:19802 to configure
```

Each endpoint provides a web-based config UI where you can enter:
- **Ailo connection**: WebSocket URL, API Key, Endpoint ID
- **Platform credentials**: App ID, App Secret, Bot Token, etc.

Configuration is saved to `config.json` and can be hot-reloaded without restarting the process. Environment variables (`AILO_WS_URL`, `AILO_API_KEY`, `AILO_ENDPOINT_ID`, etc.) take precedence over `config.json` values when set.

## Architecture

All endpoints follow a unified pattern:

```
Third-party platform
        ↓  (receive message)
    XxxHandler
        ↓  ctx.accept(msg)
    EndpointClient ──WebSocket──→ Ailo Server
        ↑  onToolRequest(send)
    EndpointClient ←─tool_request─ Ailo Server
        ↓
    XxxHandler.sendText() → Third-party platform
```

Each endpoint:
1. Receives messages from its platform (Lark webhook, Discord gateway, IMAP poll, etc.)
2. Forwards them to Ailo via `ctx.accept()` with `contextTags` for routing
3. Listens for `tool_request` events to send replies back through the platform's API

## Developing a New Endpoint

1. Create a new directory under `packages/`
2. Implement the `EndpointHandler` interface (`start(ctx)` + `stop()`)
3. Call `runEndpoint()` in your `index.ts`
4. Create a blueprint file under `blueprints/`

See the [Endpoint Protocol](ENDPOINT_PROTOCOL.md) for the full protocol specification.

## License

MIT
