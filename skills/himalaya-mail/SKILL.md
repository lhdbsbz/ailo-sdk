---
name: himalaya-mail
description: 通过 himalaya CLI 管理邮件（IMAP/SMTP），支持收发邮件和附件管理
---

# 邮件管理（Himalaya）

使用 himalaya CLI 工具管理邮件。himalaya 是一个跨平台命令行邮件客户端。

## 前提条件

需要安装 himalaya CLI：
```bash
# macOS
brew install himalaya

# Linux
curl -sSL https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh | bash

# Windows (scoop)
scoop install himalaya
```

## 配置

在 `~/.config/himalaya/config.toml` 中配置邮箱账户。

## 常用操作

### 查看收件箱
```bash
himalaya list
```

### 阅读邮件
```bash
himalaya read <id>
```

### 搜索邮件
```bash
himalaya search "关键词"
```

### 下载附件
```bash
himalaya attachment download <id>
```

## 安全规则

- **只读操作**：list、read、search、attachment download
- **禁止执行**：reply、forward、write、send（避免未授权发送邮件）
- 如需发送邮件，请先确认用户明确授权

## 工作流程

1. 用 `exec(action="run", command="himalaya list")` 查看邮件列表
2. 用 `exec(action="run", command="himalaya read <id>")` 阅读邮件
3. 用 `exec(action="run", command="himalaya search '关键词'")` 搜索
4. 整理邮件内容并回复用户
