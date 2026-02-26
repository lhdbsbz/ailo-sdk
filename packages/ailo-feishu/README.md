# @lmcl/ailo-feishu

Ailo 飞书/Lark 通道：端点协议 WebSocket 长连接收消息 + 发消息。

## 配置

| 变量 | 必填 | 说明 |
|------|------|------|
| FEISHU_APP_ID | 是 | 飞书应用 App ID |
| FEISHU_APP_SECRET | 是 | 飞书应用 App Secret |

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

创建 `.env` 文件，填入配置后启动：

```bash
# .env 示例（必填：FEISHU_APP_ID、FEISHU_APP_SECRET）
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx

npm install
npm run build
npm start
```

## 端点工具

- **send**：发消息（需 chat_id、text；attachments 可选）
- **set_nickname**：设置外部用户备注（需 sender_id、nickname）
