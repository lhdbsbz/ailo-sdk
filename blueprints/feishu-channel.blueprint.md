---
name: feishu-channel
version: 1.0.0
description: 飞书即时通讯通道，连接企业内所有飞书用户和群组
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

  - name: read_doc
    timeout: 30
    description: 读取飞书文档内容
    parameters:
      type: object
      properties:
        url: { type: string, description: 飞书文档链接 }
      required: [url]

  - name: set_nickname
    timeout: 10
    description: 设置外部用户显示昵称
    parameters:
      type: object
      properties:
        sender_id: { type: string, description: 外部用户的 sender_id }
        nickname: { type: string, description: 要设置的显示昵称 }
      required: [sender_id, nickname]
---

## 端点说明

飞书即时通讯通道，连接企业内所有飞书用户和群组。通过该通道可以与飞书用户私聊、在群组中发送和接收消息、读取飞书文档。

`chat_id` 格式：
- 用户私聊：`ou_` 前缀（如 `ou_abc123def456`）
- 群组聊天：`oc_` 前缀（如 `oc_abc123def456`）

## 使用场景

- 接收飞书用户的消息并回复
- 在飞书群组中提供智能助手服务
- 读取飞书文档内容并进行分析或总结
- 管理外部用户的显示名称

## 工具使用说明

### send — 发送消息

向指定用户或群组发送消息。

@提及格式：`@显示名(ou_xxx)`，可触发飞书强提醒。例如：

```
@张三(ou_abc123) 你好，请查看以下内容。
```

### read_doc — 读取文档

传入飞书文档的完整 URL，返回文档的文本内容。

### set_nickname — 设置昵称

外部用户首次接入时默认显示为"外部用户N"，可通过此工具设置更具辨识度的名称。

## 约束

- 私聊只能发给曾主动联系过机器人的用户
- 仅支持 Unicode emoji，不支持 :emoji: 冒号格式
- 外部用户默认显示为"外部用户N"（同一编号始终对应同一人）
