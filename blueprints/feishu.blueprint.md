---
name: feishu
version: 1.0.0
description: 飞书即时通讯端点，连接企业内所有飞书用户和群组
tools:
  - name: feishu_send
    timeout: 10
    description: 向飞书用户或群组发送消息
    parameters:
      type: object
      properties:
        chat_id: { type: string, description: "必须使用时空场前缀中 chat_id: 后面的原始值（如 ou_xxxx 或 oc_xxxx），不可编造" }
        text: { type: string, description: 消息正文 }
        attachments:
          type: array
          description: "附件列表，每项格式为 {\"path\": \"/绝对路径\"} 或 {\"url\": \"https://...\"}。发送图片或文件时使用此参数"
          items: { type: object }
      required: [chat_id, text]

---

## 端点说明

飞书即时通讯端点，连接企业内所有飞书用户和群组。通过该端点可以与飞书用户私聊、在群组中发送和接收消息。

`chat_id` 是飞书平台生成的不透明标识符，**必须从消息的时空场前缀中原样提取**，禁止根据用户名推测。格式：
- 用户私聊：`ou_` 前缀 + 飞书生成的哈希（如 `ou_a1b2c3d4e5f6g7h8`）
- 群组聊天：`oc_` 前缀 + 飞书生成的哈希（如 `oc_a1b2c3d4e5f6g7h8`）

## 使用场景

- 接收飞书用户的消息并回复
- 在飞书群组中提供智能助手服务

## 工具使用说明

### feishu_send — 发送消息

向指定用户或群组发送消息。`chat_id` 参数**必须**从该消息时空场前缀的 `chat_id:` 字段中原样复制，不能自行构造。

**发送图片或文件**：使用 `attachments` 参数，格式为本地路径或 URL：
```json
[{"path": "/Users/xxx/screenshot.png"}]
```
或
```json
[{"url": "https://example.com/image.png"}]
```
截图后发图典型流程：`screenshot` → 得到图片路径 → `feishu_send(chat_id=..., text=..., attachments=[{"path": "截图路径"}])`。注意：`send_file` 工具仅适用于 webchat 网页聊天，**不能**用于飞书通道。

@提及格式：`@显示名 (ou_xxx)`，可触发飞书强提醒。例如：

```
@张三 (ou_abc123) 你好，请查看以下内容。
```

## 约束

- chat_id 是飞书平台生成的哈希值，不是人名或拼音，必须原样使用
- 私聊只能发给曾主动联系过机器人的用户
- 仅支持 Unicode emoji，不支持 :emoji: 冒号格式
- 外部用户默认显示为"外部用户 N"（同一编号始终对应同一人，自动增长）
