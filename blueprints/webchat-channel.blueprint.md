---
name: webchat-channel
version: 1.0.0
description: 网页聊天通道
tools:
  - name: send
    timeout: 10
    description: 向网页聊天界面发送消息
    parameters:
      type: object
      properties:
        text: { type: string, description: 消息正文 }
      required: [text]
---

## 端点说明

网页聊天通道，提供基于浏览器的实时聊天界面。用户通过网页端发送消息，系统接收后进行处理并返回响应。

每个网页会话对应一个独立的 `chat_id`，由系统在用户首次访问时自动生成。

## 使用场景

- 网站内嵌的智能客服助手
- 在线问答与咨询服务

## 工具使用说明

### send — 发送消息

向当前网页聊天会话发送文本消息，实时显示在用户的浏览器界面中。

## 约束

- 仅支持纯文本消息
- 会话生命周期与浏览器连接绑定，用户关闭页面后会话结束
