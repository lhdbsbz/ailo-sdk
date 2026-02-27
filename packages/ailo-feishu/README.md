# @lmcl/ailo-feishu

Ailo 飞书/Lark 通道：端点协议 WebSocket 长连接收消息 + 发消息。**自带配置界面**：启动后打开网页填写飞书应用与 Ailo 连接信息，保存即可生效。

## 配置

| 变量 | 必填 | 说明 |
|------|------|------|
| FEISHU_APP_ID | 是 | 飞书应用 App ID |
| FEISHU_APP_SECRET | 是 | 飞书应用 App Secret |
| AILO_WS_URL | 是* | Ailo WebSocket 地址（本地开发或未由 Ailo 拉起时必填） |
| AILO_API_KEY | 是* | Ailo 端点 API Key |
| AILO_ENDPOINT_ID | 是* | 端点 ID |
| DISPLAY_NAME | 否 | 显示名称，默认「飞书」 |
| CONFIG_PORT | 否 | 配置页端口，默认 19802 |

## 飞书开放平台配置

1. 创建自建应用，获取 App ID 和 App Secret
2. 在「事件与回调」中选择「使用长连接接收事件」并保存
3. 开通权限：`im:message`、`im:message.group_at_msg`、`contact:user.base:readonly`、`im:chat` 等

## 在 Ailo 中添加

通过 **Ailo 端点管理后台** 配置并添加：

1. 在 Ailo 管理端「端点密钥」创建 API Key
2. 在「端点配置」添加端点：endpoint_id=feishu，command=npx，args=[@lmcl/ailo-feishu]，选择密钥，env 填入 FEISHU_APP_ID、FEISHU_APP_SECRET
3. 启用后由 Ailo 自动拉起

## 本地开发与配置界面

启动后会自动打开**配置界面**（默认 http://127.0.0.1:19802），在网页中填写飞书应用与 Ailo 连接信息并保存即可：

- **飞书应用配置**：FEISHU_APP_ID、FEISHU_APP_SECRET（修改后需重启进程生效）
- **Ailo 连接配置**：AILO_WS_URL、AILO_API_KEY、AILO_ENDPOINT_ID、DISPLAY_NAME（保存后自动重连，无需重启）

也可沿用 `.env` 文件后直接启动：

```bash
# .env 示例（必填：飞书应用 + Ailo 连接）
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
AILO_WS_URL=ws://127.0.0.1:19800/ws
AILO_API_KEY=ailo_ep_xxx
AILO_ENDPOINT_ID=feishu-01

npm install
npm run build
npm start
```

## 端点工具

- **send**：发消息（需 chat_id、text；attachments 可选）
