---
name: email
version: 2.0.0
description: 电子邮件端点（集成于桌面端点），IMAP 收信 + SMTP 发信
tools:
  - name: email_send
    timeout: 15
    description: 发送新邮件
    parameters:
      type: object
      properties:
        to: { type: string, description: 收件人邮箱地址 }
        subject: { type: string, description: 邮件主题 }
        body: { type: string, description: 邮件正文（纯文本） }
        cc: { type: string, description: "抄送地址，多个用逗号分隔" }
        bcc: { type: string, description: "密送地址，多个用逗号分隔" }
        html: { type: string, description: "HTML 格式正文（可选）" }
        attachments: { type: array, description: 附件列表, items: { type: object, properties: { filename: { type: string }, content: { type: string }, contentType: { type: string } } } }
      required: [to, body]

  - name: email_reply
    timeout: 15
    description: 回复邮件
    parameters:
      type: object
      properties:
        uid: { type: number, description: 要回复的邮件 UID }
        body: { type: string, description: 回复正文 }
        folder: { type: string, description: "邮件所在文件夹，默认 INBOX" }
        html: { type: string, description: "HTML 格式正文（可选）" }
      required: [uid, body]

  - name: email_forward
    timeout: 15
    description: 转发邮件
    parameters:
      type: object
      properties:
        uid: { type: number, description: 要转发的邮件 UID }
        to: { type: string, description: 转发目标邮箱 }
        body: { type: string, description: 转发附言 }
        folder: { type: string, description: "邮件所在文件夹，默认 INBOX" }
        cc: { type: string, description: 抄送 }
        bcc: { type: string, description: 密送 }
      required: [uid, to]

  - name: email_list
    timeout: 15
    description: 列出邮件
    parameters:
      type: object
      properties:
        folder: { type: string, description: "邮件文件夹，默认 INBOX" }
        limit: { type: number, description: "返回数量，默认 50，最大 200" }
        offset: { type: number, description: "偏移量，默认 0" }
        unread_only: { type: boolean, description: "仅未读，默认 false" }

  - name: email_read
    timeout: 15
    description: 读取邮件详情（同时标记为已读）
    parameters:
      type: object
      properties:
        uid: { type: number, description: 邮件 UID }
        folder: { type: string, description: "邮件文件夹，默认 INBOX" }
      required: [uid]

  - name: email_search
    timeout: 30
    description: 搜索邮件
    parameters:
      type: object
      properties:
        query: { type: string, description: 正文关键词 }
        from: { type: string, description: 发件人筛选 }
        to: { type: string, description: 收件人筛选 }
        subject: { type: string, description: 主题筛选 }
        since: { type: string, description: "起始日期 (ISO 8601)" }
        until: { type: string, description: "截止日期 (ISO 8601)" }
        folder: { type: string, description: 限定文件夹 }
        limit: { type: number, description: "返回数量，默认 50" }

  - name: email_mark_read
    timeout: 10
    description: 标记邮件已读或未读
    parameters:
      type: object
      properties:
        uids: { type: array, items: { type: number }, description: 邮件 UID 列表 }
        read: { type: boolean, description: "true=已读, false=未读" }
        folder: { type: string, description: "邮件文件夹，默认 INBOX" }
      required: [uids, read]

  - name: email_move
    timeout: 10
    description: 移动邮件到指定文件夹
    parameters:
      type: object
      properties:
        uids: { type: array, items: { type: number }, description: 邮件 UID 列表 }
        folder: { type: string, description: 目标文件夹 }
        from_folder: { type: string, description: "来源文件夹，默认 INBOX" }
      required: [uids, folder]

  - name: email_delete
    timeout: 10
    description: 删除邮件（不可撤销）
    parameters:
      type: object
      properties:
        uids: { type: array, items: { type: number }, description: 邮件 UID 列表 }
        folder: { type: string, description: "邮件文件夹，默认 INBOX" }
      required: [uids]

  - name: email_get_attachment
    timeout: 30
    description: 下载邮件附件
    parameters:
      type: object
      properties:
        uid: { type: number, description: 邮件 UID }
        filename: { type: string, description: 附件文件名 }
        folder: { type: string, description: "邮件文件夹，默认 INBOX" }
      required: [uid, filename]
---

## 端点说明

电子邮件端点，集成于桌面端点。通过 IMAP IDLE 零延迟接收邮件、SMTP 发送邮件。

`chat_id` 为发件人的邮箱地址，用于标识邮件会话流。回复邮件使用 `email_reply` 并传入 `uid`。

## 使用场景

- 接收用户邮件并自动回复
- 搜索历史邮件查找信息
- 转发邮件给相关人员
- 管理邮箱（标记已读、移动、删除）

## 工具使用说明

### email_send — 发送新邮件

发送一封全新的邮件。`to` 为收件人，`body` 为纯文本正文。可选 `cc`、`bcc`、`html`、`attachments`。

### email_reply — 回复邮件

回复一封已有邮件。必须提供原邮件的 `uid`。自动维护邮件线程（In-Reply-To / References）。

### email_forward — 转发邮件

将一封邮件转发给其他人。可附加转发附言 `body`。

### email_list — 列出邮件

按文件夹列出邮件，支持分页（`offset`/`limit`）和仅未读过滤（`unread_only`）。

### email_read — 读取邮件

获取一封邮件的完整内容（发件人、收件人、主题、正文、附件列表）。读取后自动标记为已读。

### email_search — 搜索邮件

按关键词、发件人、收件人、主题、日期范围搜索邮件。

### email_mark_read — 标记已读/未读

### email_move — 移动邮件

将邮件移动到指定文件夹（如 Archive、Trash）。

### email_delete — 删除邮件

永久删除邮件，不可撤销。

### email_get_attachment — 下载附件

下载邮件附件到本地。

## 约束

- 需要在桌面端点配置页的「邮件」标签页中填写 IMAP/SMTP 配置后才能使用
- 邮件发送受 SMTP 服务器速率限制
- 大附件（>10MB）下载可能较慢
- 删除操作不可撤销
