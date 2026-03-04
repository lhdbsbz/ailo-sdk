---
name: webchat
version: 1.2.0
description: 网页聊天端点，支持向浏览器用户发送文本消息和文件
tools:
  - name: webchat_send
    timeout: 30
    description: 向网页聊天界面的指定用户发送消息（文字、文件或两者同时）
    parameters:
      type: object
      properties:
        participantName: { type: string, description: "目标用户的称呼（路由主键，与用户在聊天框中设置的昵称完全一致）" }
        text: { type: string, description: "消息正文（可选，与 attachments 至少填一个）" }
        attachments:
          type: array
          description: "附件列表，每项格式为 {\"path\": \"/绝对路径\"}。发送图片或文件时使用此参数"
          items: { type: object }
      required: [participantName]

---

## 端点说明

网页聊天端点，提供基于浏览器的实时聊天界面。用户通过网页端发送消息，系统接收后进行处理并返回响应。

每个使用者名称对应一个独立的会话路由，用 `participantName` 作为路由键。

## 使用场景

- 网站内嵌的智能客服助手
- 在线问答与咨询服务

## 工具使用说明

### webchat_send — 发送消息

按 `participantName` 定向发送消息，实时显示在对应用户的浏览器界面中。

**发送文字**：
```
webchat_send(participantName="张三", text="你好！")
```

**发送文件/图片**（如截图后发图）：
```
webchat_send(participantName="张三", text="这是截图", attachments=[{"path": "/绝对路径/screenshot.png"}])
```

**注意**：`attachments` 中的 `path` 必须是本地绝对路径。`webchat_send` 仅适用于网页聊天通道，不可用于飞书、钉钉、QQ 等即时通讯平台（这些平台请使用各自的 send 工具）。

## 约束

- `participantName` 为必填；`text` 和 `attachments` 至少填一个
- 同名用户共享同一路由（会同时收到消息）
- `attachments` 的文件路径必须是绝对路径
