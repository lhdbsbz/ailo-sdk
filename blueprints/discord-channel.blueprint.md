---
name: discord-channel
version: 1.0.0
description: Discord 通道，连接 Discord 服务器频道和私聊
tools:
  - name: send
    timeout: 10
    description: 向 Discord 频道或用户发送消息
    parameters:
      type: object
      properties:
        chat_id: { type: string, description: "会话标识（由 contextTags 中的 chat_id 获得）" }
        text: { type: string, description: 消息正文（支持 Markdown 格式） }
      required: [chat_id, text]

---

## 端点说明

Discord 通道，通过 Discord.js Gateway 接收消息，通过 REST API 回复。支持 Server 频道和 DM 私聊。

`chat_id` 格式：
- 频道消息：`ch:` 前缀 + channel_id（如 `ch:123456789`）
- 私聊消息：`dm:` 前缀 + user_id（如 `dm:987654321`）

## 使用场景

- 接收 Discord 频道中的消息并回复
- 接收 Discord 用户的 DM 私聊消息并回复
- 支持接收图片/视频/音频/文件附件

## 工具使用说明

### send — 发送消息

向指定频道或用户发送消息。超过 2000 字符的消息会自动分段发送。

## 约束

- 机器人需要在 Discord Developer Portal 开启 Message Content Intent
- 仅支持纯文本回复（不支持发送图片/文件）
- 国内访问 Discord 可能需要配置 HTTP 代理
