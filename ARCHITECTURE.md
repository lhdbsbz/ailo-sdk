# Ailo Desktop Agent 架构文档

## 概述

Ailo 桌面端（ailo-desktop）是 Ailo 云端大脑的"四肢"——运行在用户本地机器上，通过 WebSocket 连接 Ailo 大脑，提供截图、浏览器自动化、文件系统、命令执行、代码执行、MCP 管理、Skills 管理和定时任务等本地能力。

## 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                    Ailo 云端大脑 (Go)                        │
│  记忆系统 · Pulse 内驱力 · Soul 天性 · Specialist 专家系统    │
│  工具注册表 · 模型管理 · 消息路由 · 端点协议                  │
├──────────────────────── WebSocket ───────────────────────────┤
│                  Ailo Desktop (TypeScript)                    │
│  ┌──────────┬──────────┬──────────┬──────────┬────────────┐ │
│  │  Tools   │   MCP    │  Skills  │   Cron   │ Config UI  │ │
│  │ 16 工具  │ stdio    │ 4 市场   │ Heartbeat│ HTTP:19801 │ │
│  │          │ 热重载   │ 10 内置  │ 定时任务 │            │ │
│  └──────────┴──────────┴──────────┴──────────┴────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 模块详解

### 1. 工具系统（16 个工具）

| 工具 | 文件 | 说明 |
|------|------|------|
| screenshot | screenshot.ts | 桌面截图，macOS 支持窗口选择 |
| get_current_time | time_tool.ts | 当前时间+时区 |
| browser_use | browser_control.ts | Playwright 浏览器控制（25+ 动作） |
| execute_code | code_executor.ts | Python/JavaScript 代码执行 |
| exec | exec_tool.ts | Shell 命令（run/poll/stop/list/write） |
| mcp_manage | mcp_manager.ts | MCP 服务管理 |
| send_file | send_file.ts | 发送文件给用户 |
| read_file | fs_tools.ts | 文件读取 |
| write_file | fs_tools.ts | 文件写入 |
| edit_file | fs_tools.ts | 文件编辑 |
| append_file | fs_tools.ts | 文件追加 |
| list_directory | fs_tools.ts | 目录列表 |
| find_files | fs_tools.ts | 文件搜索 |
| search_content | fs_tools.ts | 内容搜索 |
| delete_file | fs_tools.ts | 文件删除 |
| move_file / copy_file | fs_tools.ts | 文件移动/复制 |

### 2. MCP 管理（mcp_manager.ts）

- 完整 JSON-RPC over stdio 客户端
- 配置持久化：`~/.agents/mcp_config.json`
- 配置文件监听（2s 轮询 mtime），变更时增量重载
- 进程生命周期管理

### 3. Skills 生态

#### 三层目录

| 层 | 路径 | 说明 |
|----|------|------|
| builtin | `ailo-sdk/skills/` | 随桌面端分发的内置 Skills |
| customized | `~/.agents/customized_skills/` | 用户自定义或市场导入的 Skills |
| active | `~/.agents/skills/` | 运行时实际加载的（builtin + customized 合并） |

#### 市场兼容（skills_hub.ts）

| 来源 | URL 格式 | 协议 |
|------|----------|------|
| skills.sh | `https://skills.sh/{owner}/{repo}/{skill}` | GitHub API |
| clawhub.ai | `https://clawhub.ai/{slug}` | Hub API → repo_url → GitHub |
| skillsmp.com | `https://skillsmp.com/{slug}` | Slug 解析 → GitHub |
| GitHub | `https://github.com/{owner}/{repo}/tree/{branch}/{path}` | GitHub API |

#### 内置 Skills（10 个）

browser-visible, pdf-processing, spreadsheet, document-editing, presentation, code-review, cron, file-reader, news-summary, himalaya-mail

### 4. Cron/Heartbeat（cron_manager.ts）

- 任务类型：text（固定文本）/ agent（发给 Ailo）
- Heartbeat：`~/.agents/HEARTBEAT.md`，定时发送内容给 Ailo
- 持久化：`~/.agents/cron_jobs.json`
- 通过 `endpoint.accept` 将任务内容发送给大脑

### 5. 配置界面（config_server.ts）

- 内嵌 HTTP 服务器，端口 19801
- 四个 Tab：状态、MCP、Skills、定时任务
- Skills Tab：列表展示、启用/禁用、市场安装、创建自定义
- Cron Tab：任务管理、Heartbeat 编辑

### 6. CLI（cli.ts）

- `ailo-desktop init [--defaults]`：交互式初始化
- 写入 `.env`（连接信息）
- 初始化 Skills 和 HEARTBEAT.md

## 配置文件

| 文件 | 位置 | 说明 |
|------|------|------|
| .env | 工作目录 | WebSocket URL、API Key、端点 ID |
| mcp_config.json | ~/.agents/ | MCP 服务配置 |
| cron_jobs.json | ~/.agents/ | 定时任务配置 |
| HEARTBEAT.md | ~/.agents/ | Heartbeat 内容 |
| skills/ | ~/.agents/ | 运行时 Skills |
| customized_skills/ | ~/.agents/ | 用户自定义 Skills |

## Go 大脑侧变更

### MCP 系统激活

- `main.go`：Phase 2 实例化 `mcp.Client`，注册 `mcp_manage` 工具
- `main.go`：Phase 6 从 DB 加载已启用的 MCP 服务自动连接
- `api_mcp.go`：`/api/mcp/servers` CRUD API

### 新增 API

| 路径 | 说明 |
|------|------|
| GET /api/mcp/servers | MCP 服务列表 |
| POST/PUT/PATCH/DELETE /api/mcp/servers/:name | MCP CRUD |
| GET /api/conversations | 对话列表（按 stream 聚合） |
| GET /api/conversations/:stream/messages | 对话消息 |
| GET /api/tasks | 任务列表 |

### Bootstrap 引导

- `bootstrap.go`：首次引导检测与模板
- `prompt.go`：PromptBuilder 新增 BootstrapGuide 字段
- 首次对话完成后自动标记 `.bootstrap_completed`

## 蓝图（desktop-agent.blueprint.md）

版本 1.2.0，定义 16+ 个工具的完整参数 schema。
