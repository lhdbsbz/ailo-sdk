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
| CONFIG_PORT | 否 | 配置页端口，默认 19802 |

配置通过两种方式提供：

1. **网页配置界面**（推荐）：启动后访问 http://127.0.0.1:19802 ，填写并保存后自动生效，配置存储在 `config.json`
2. **环境变量**：通过 `AILO_WS_URL` 等注入，优先级高于 config.json，适合容器化部署

## 飞书开放平台配置

1. 创建自建应用，获取 App ID 和 App Secret
2. 在「事件与回调」中选择「使用长连接接收事件」并保存
3. 开通权限：`im:message`、`im:message.group_at_msg`、`contact:user.base:readonly`、`im:chat` 等

## 在 Ailo 中添加

通过 **Ailo 端点管理后台** 配置并添加：

1. 在 Ailo 管理端「端点密钥」创建 API Key
2. 在「端点配置」添加端点：endpoint_id=feishu，command=npx，args=[@lmcl/ailo-feishu]，选择密钥，env 填入 FEISHU_APP_ID、FEISHU_APP_SECRET
3. 启用后由 Ailo 自动拉起

## 本地开发

```bash
npm install
npm run build
npm start
# 打开 http://127.0.0.1:19802 填写配置
```

## 端点工具

- **send**：发消息（需 chat_id、text；attachments 可选）
