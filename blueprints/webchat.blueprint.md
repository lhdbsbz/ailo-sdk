---
name: webchat
version: 1.0.0
description: 网页聊天端点
tools:
  - name: send
    timeout: 10
    description: 向网页聊天界面发送消息
    parameters:
      type: object
      properties:
        text: { type: string, description: 消息正文 }
        participantName: { type: string, description: 目标使用者名称（路由主键） }
      required: [text, participantName]
---

## 端点说明

网页聊天端点，提供基于浏览器的实时聊天界面。用户通过网页端发送消息，系统接收后进行处理并返回响应。

每个使用者名称对应一个独立的 `chat_id`（使用 `participantName` 作为路由键）。

## 使用场景

- 网站内嵌的智能客服助手
- 在线问答与咨询服务

## 工具使用说明

### send — 发送消息

按 `participantName` 定向发送文本消息，实时显示在对应用户的浏览器界面中。

## 约束

- 仅支持纯文本消息
- `participantName` 为必填；缺失时消息会被拒绝发送
- 同名用户共享同一路由（会同时收到消息）
