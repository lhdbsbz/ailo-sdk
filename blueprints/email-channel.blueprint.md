---
name: email-channel
version: 1.0.0
description: 电子邮件通道，支持收发邮件、搜索、附件处理
tools:
  - name: send
    timeout: 15
    description: 发送新邮件
    parameters:
      type: object
      properties:
        to: { type: string, description: 收件人邮箱地址 }
        subject: { type: string, description: 邮件主题 }
        body: { type: string, description: 邮件正文 }
        cc: { type: string, description: "抄送地址，多个用逗号分隔" }
        attachments: { type: array, description: 附件列表, items: { type: object } }
      required: [to, subject, body]

  - name: reply
    timeout: 15
    description: 回复邮件
    parameters:
      type: object
      properties:
        message_id: { type: string, description: 要回复的邮件 ID }
        body: { type: string, description: 回复正文 }
      required: [message_id, body]

  - name: forward
    timeout: 15
    description: 转发邮件
    parameters:
      type: object
      properties:
        message_id: { type: string, description: 要转发的邮件 ID }
        to: { type: string, description: 转发目标邮箱 }
        body: { type: string, description: 转发附言 }
      required: [message_id, to]

  - name: list
    timeout: 15
    description: 列出邮件
    parameters:
      type: object
      properties:
        folder: { type: string, description: "邮件文件夹，默认 INBOX" }
        limit: { type: number, description: "返回数量，默认 20" }
        offset: { type: number, description: "偏移量，默认 0" }
        unread_only: { type: boolean, description: "仅未读，默认 false" }

  - name: read
    timeout: 15
    description: 读取邮件详情
    parameters:
      type: object
      properties:
        message_id: { type: string, description: 邮件 ID }
      required: [message_id]

  - name: search
    timeout: 30
    description: 搜索邮件
    parameters:
      type: object
      properties:
        query: { type: string, description: 搜索关键词 }
        folder: { type: string, description: 限定文件夹 }
      required: [query]

  - name: mark_read
    timeout: 10
    description: 标记邮件已读或未读
    parameters:
      type: object
      properties:
        message_id: { type: string, description: 邮件 ID }
        read: { type: boolean, description: "true=已读, false=未读" }
      required: [message_id, read]

  - name: move
    timeout: 10
    description: 移动邮件到指定文件夹
    parameters:
      type: object
      properties:
        message_id: { type: string, description: 邮件 ID }
        folder: { type: string, description: 目标文件夹 }
      required: [message_id, folder]

  - name: delete
    timeout: 10
    description: 删除邮件
    parameters:
      type: object
      properties:
        message_id: { type: string, description: 邮件 ID }
      required: [message_id]

  - name: get_attachment
    timeout: 30
    description: 获取邮件附件内容
    parameters:
      type: object
      properties:
        message_id: { type: string, description: 邮件 ID }
        attachment_id: { type: string, description: 附件 ID }
      required: [message_id, attachment_id]
---

## 端点说明

电子邮件通道，通过 IMAP 接收邮件、SMTP 发送邮件。支持完整的邮箱操作：收发、回复、转发、搜索、附件处理。

`chat_id` 为发件人的邮箱地址，用于标识邮件会话流。回复邮件时使用 `reply` 工具并传入 `message_id`。

## 使用场景

- 接收用户邮件并自动回复
- 搜索历史邮件查找信息
- 转发邮件给相关人员
- 管理邮箱（标记已读、移动、删除）

## 工具使用说明

### send — 发送新邮件

发送一封全新的邮件。`to` 为收件人邮箱，`cc` 可选抄送。

### reply — 回复邮件

回复一封已有邮件。必须提供原邮件的 `message_id`。

### forward — 转发邮件

将一封邮件转发给其他人。可附加转发附言。

### list — 列出邮件

按文件夹列出邮件，支持分页和仅未读过滤。

### read — 读取邮件

获取一封邮件的完整内容（发件人、收件人、主题、正文、附件列表）。

### search — 搜索邮件

按关键词搜索邮件，可限定在某个文件夹内。

### mark_read — 标记已读/未读

### move — 移动邮件

将邮件移动到指定文件夹（如 Archive、Trash）。

### delete — 删除邮件

### get_attachment — 获取附件

获取邮件附件的 base64 内容。

## 约束

- 邮件发送有 SMTP 服务器的速率限制
- 大附件（>10MB）获取可能较慢
- 删除操作不可撤销
