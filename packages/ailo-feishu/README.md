# @lmcl/ailo-feishu

Ailo 飞书/Lark 通道 MCP：WebSocket 长连接收消息 + 发消息。

## 配置

| 变量 | 必填 | 说明 |
|------|------|------|
| FEISHU_APP_ID | 是 | 飞书应用 App ID |
| FEISHU_APP_SECRET | 是 | 飞书应用 App Secret |

## 飞书开放平台配置

1. 创建自建应用，获取 App ID 和 App Secret
2. 在「事件与回调」中选择「使用长连接接收事件」并保存
3. 开通权限：`im:message`、`im:message.group_at_msg`、`contact:user.base:readonly`、`im:chat`、`docx:document`、`drive:drive` 等

## 在 Ailo 中添加

通过 `mcp_manage` 工具创建。**name 只能含字母、汉字、下划线**（无标点无数字），推荐纯英文尽量短：

```
mcp_manage(action=create, name="feishu", command="npx", args=["@lmcl/ailo-feishu"], env={FEISHU_APP_ID: "xxx", FEISHU_APP_SECRET: "xxx"})
mcp_manage(action=start, name="feishu")
```

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

## MCP 工具

- **feishu**：飞书操作统一入口
  - `action=send`：发消息（需 chat_id、text；attachments 可选）
  - `action=read_doc`：读飞书文档（需 url）
  - `action=set_nickname`：设置外部用户备注（需 sender_id、nickname）
