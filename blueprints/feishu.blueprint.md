---
name: feishu
version: 1.0.0
description: 飞书即时通讯端点，连接企业内所有飞书用户和群组
tools:
  - name: send
    timeout: 10
    description: 向飞书用户或群组发送消息
    parameters:
      type: object
      properties:
        chat_id: { type: string, description: "ou_xxx（用户）或 oc_xxx（群组）" }
        text: { type: string, description: 消息正文 }
        attachments:
          type: array
          description: 附件列表
          items: { type: object }
      required: [chat_id, text]

---

## 端点说明

飞书即时通讯端点，连接企业内所有飞书用户和群组。通过该端点可以与飞书用户私聊、在群组中发送和接收消息。

`chat_id` 格式：
- 用户私聊：`ou_` 前缀（如 `ou_abc123def456`）
- 群组聊天：`oc_` 前缀（如 `oc_abc123def456`）

## 使用场景

- 接收飞书用户的消息并回复
- 在飞书群组中提供智能助手服务

## 工具使用说明

### send — 发送消息

向指定用户或群组发送消息。

@提及格式：`@显示名 (ou_xxx)`，可触发飞书强提醒。例如：

```
@张三 (ou_abc123) 你好，请查看以下内容。
```

## 约束

- 私聊只能发给曾主动联系过机器人的用户
- 仅支持 Unicode emoji，不支持 :emoji: 冒号格式
- 外部用户默认显示为"外部用户 N"（同一编号始终对应同一人，自动增长）
