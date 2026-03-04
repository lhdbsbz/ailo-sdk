---
name: qq
version: 1.0.0
description: QQ 频道/群组/私聊端点，连接 QQ Bot 的所有消息入口
tools:
  - name: qq_send
    timeout: 10
    description: 向 QQ 用户、频道或群组发送消息
    parameters:
      type: object
      properties:
        chat_id: { type: string, description: "必须使用时空场前缀中 chat_id: 后面的原始值（如 ch:xxx、dm:xxx、c2c:xxx 或 grp:xxx），不可编造" }
        text: { type: string, description: 消息正文 }
        msg_id: { type: string, description: "关联的原消息 ID（可选，用于被动回复）" }
      required: [chat_id, text]

---

## 端点说明

QQ Bot 端点，通过 WebSocket Gateway 接收消息，通过 REST API 回复。支持频道、群组和 C2C 私聊三种场景。

`chat_id` 格式：
- 频道消息：`ch:` 前缀 + channel_id（如 `ch:123456`）
- 频道私聊：`dm:` 前缀 + guild_id（如 `dm:789012`）
- C2C 私聊：`c2c:` 前缀 + user_openid（如 `c2c:abc123`）
- 群消息：`grp:` 前缀 + group_openid（如 `grp:def456`）

## 使用场景

- 接收 QQ 频道中 @机器人 的消息并回复
- 接收 QQ 群中的 @消息并回复
- 接收 QQ 用户的私聊消息并回复

## 工具使用说明

### qq_send — 发送消息

向指定会话发送文本消息。`msg_id` 可选，传入原消息 ID 时为被动回复（推荐），不传时为主动消息。

## 约束

- 被动回复（带 msg_id）更稳定，主动消息可能受频率限制
- 仅支持纯文本回复
- C2C 和群消息需要机器人具备对应权限（intents）
