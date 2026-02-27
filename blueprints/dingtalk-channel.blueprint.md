---
name: dingtalk-channel
version: 1.0.0
description: 钉钉即时通讯通道，连接企业内所有钉钉用户和群组
tools:
  - name: send
    timeout: 10
    description: 向钉钉用户或群组发送消息
    parameters:
      type: object
      properties:
        chat_id: { type: string, description: "会话标识（由 contextTags 中的 chat_id 获得）" }
        text: { type: string, description: 消息正文（支持 Markdown 格式） }
      required: [chat_id, text]

---

## 端点说明

钉钉即时通讯通道，通过 Stream 模式接收企业内钉钉用户的消息，通过 sessionWebhook 回复。

`chat_id` 格式：
- 群聊：`grp:` 前缀 + conversationId 后16位（如 `grp:abc123def456`）
- 私聊：`p2p:` 前缀 + 用户 staffId（如 `p2p:012345`）

## 使用场景

- 接收钉钉用户的私聊消息并回复
- 在钉钉群组中提供智能助手服务

## 工具使用说明

### send — 发送消息

向指定会话发送文本或 Markdown 消息。文本中包含 Markdown 语法（如 `#`、`*`、`` ` ``）时自动使用 Markdown 格式发送。

## 约束

- 只能回复曾主动发过消息的会话（依赖 sessionWebhook）
- sessionWebhook 有过期时间，长时间未互动的会话可能无法主动推送
- 不支持发送图片/文件附件（仅支持文本和 Markdown）
