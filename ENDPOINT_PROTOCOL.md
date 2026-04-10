# Ailo Endpoint Protocol v4

## Language / 语言索引

- [English Version](#english)
- [中文版本](#中文)

---

## English

### Overview

This document describes how to connect your application (chatbot, desktop assistant, IoT device, etc.) to the Ailo consciousness core.

**Core Concepts:**
- **Endpoint**: Any application that connects to Ailo
- **Self-Describing**: Endpoints directly report their capabilities (tools, MCP tools, skills)
- **Atomic Aggregation**: Server aggregates tools/skills by matching `name + description` hash
- **EndpointID**: Every tool call must specify the target endpoint

---

### 1. Connection Flow

#### 1.1 Handshake

The first frame sent by an endpoint must be a `connect` request:

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "role": "endpoint",
    "apiKey": "ailo_ep_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "endpointId": "my-app-01",
    "caps": ["message", "tool_execute"],
    "sdkVersion": "1.0.0",
    "tools": [...],
    "mcpTools": [...],
    "skills": [...],
    "instructions": "A brief description of this endpoint"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `role` | ✅ | Fixed value: `"endpoint"` |
| `apiKey` | ✅ | API Key created in admin dashboard |
| `endpointId` | ✅ | Unique identifier for your app (must be unique globally) |
| `caps` | ✅ | Declared capabilities |
| `sdkVersion` | ❌ | SDK version |
| `tools` | ❌ | Native tools defined by this endpoint |
| `mcpTools` | ❌ | MCP extension tools |
| `skills` | ❌ | Extended knowledge modules |
| `instructions` | ❌ | Brief description of this endpoint |

**Success Response:**

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "connId": "conn_1234567890",
    "protocol": 4
  }
}
```

**Error Response (Duplicate endpointId):**

```json
{
  "type": "res",
  "id": "c1",
  "ok": false,
  "error": {
    "code": "DUPLICATE_ENDPOINT",
    "message": "endpoint \"my-app-01\" is already registered"
  }
}
```

---

### 2. Capabilities

| Value | Description |
|-------|-------------|
| `message` | Receive user messages |
| `tool_execute` | Execute tool calls |
| `intent` | Receive intent commands |

---

### 3. Tool Definition

#### 3.1 Tool Structure

```json
{
  "name": "read_file",
  "description": "Read file content from local disk",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Absolute file path"
      }
    },
    "required": ["path"]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Tool name (unique within endpoint) |
| `description` | string | Tool description for LLM |
| `parameters` | object | JSON Schema for parameters |

#### 3.2 MCP Tools

MCP tools have the same structure as regular tools, prefixed with the MCP server name:

```json
{
  "name": "filesystem:read_file",
  "description": "List directory contents",
  "parameters": {...}
}
```

---

### 4. Skills

#### 4.1 Skill Structure

```json
{
  "name": "git-guide",
  "description": "Git usage guide",
  "content": "# Git Guide\n\n## Basic Commands\n..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique skill name |
| `description` | string | Brief description |
| `content` | string | Full documentation (Markdown, optional) |

#### 4.2 Querying Skills

Use the `get_skills` tool to query skills:

```json
// Query all skills
{"endpoint_id": "", "skill_name": ""}

// Query skills from a specific endpoint
{"endpoint_id": "desktop-01", "skill_name": ""}

// Get skill details
{"endpoint_id": "desktop-01", "skill_name": "git-guide"}
```

---

### 5. Server-Side Aggregation

#### 5.1 Matching Rule

```
Tool Match Key = hash(tool.name + "|" + tool.description)
Skill Match Key = hash(skill.name + "|" + skill.description)

- Same key = same tool/skill (aggregated)
- Different key = different tool/skill (even if name is same)
```

#### 5.2 Aggregation Result

For tools with same match key from multiple endpoints:

```json
{
  "name": "read_file",
  "description": "⚠️ 注意：不同端点的用法不同！\n\n【端点 1】desktop-01\nRead file from local disk\n\n【端点 2】server-01\nRead file from server, supports remote paths\n\n可用端点：desktop-01, server-01",
  "parameters": {
    "oneOf": [
      {
        "type": "object",
        "description": "Read file from local disk",
        "properties": {
          "endpointId": { "type": "string", "const": "desktop-01" },
          "path": { "type": "string" }
        },
        "required": ["endpointId", "path"]
      },
      {
        "type": "object",
        "description": "Read file from server",
        "properties": {
          "endpointId": { "type": "string", "const": "server-01" },
          "path": { "type": "string" },
          "timeout": { "type": "number" }
        },
        "required": ["endpointId", "path", "timeout"]
      }
    ]
  }
}
```

#### 5.3 Uniform Schema Optimization

If all endpoints with same tool have identical parameters, the server uses a unified schema:

```json
{
  "name": "read_file",
  "description": "Read file content.\n\n可用端点：desktop-01, server-01",
  "parameters": {
    "type": "object",
    "properties": {
      "endpointId": {
        "type": "string",
        "enum": ["desktop-01", "server-01"]
      },
      "path": { "type": "string" }
    },
    "required": ["endpointId", "path"]
  }
}
```

---

### 6. Dynamic Updates

#### 6.1 Update Request

```json
{
  "type": "req",
  "method": "endpoint.update",
  "params": {
    "register": {
      "tools": [...],
      "mcpTools": [...],
      "skills": [...]
    },
    "unregister": {
      "tools": true,
      "mcpTools": true,
      "skills": true
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `register` | Full replacement for the category |
| `unregister.tools` | Set to `true` to clear all native tools |
| `unregister.mcpTools` | Set to `true` to clear all MCP tools |
| `unregister.skills` | Set to `true` to clear all skills |

#### 6.2 Update Response

```json
{
  "type": "res",
  "ok": true,
  "payload": {
    "updated": true
  }
}
```

---

### 7. Connection Lifecycle

#### 7.1 WebSocket Disconnect

When WebSocket disconnects, the server:
1. Removes all endpoint data (tools, mcpTools, skills, instructions)
2. Triggers tool registry refresh
3. LLM sees updated tools/skills in next request

#### 7.2 Reconnection

On reconnect, the endpoint should:
1. Send full `connect` request with current tools/skills
2. Server will reject if endpointId is already registered by another connection

---

### 8. Message Format

#### 8.1 Common Frame Format

```json
{
  "type": "req|res|event",
  "id": "correlation-id",
  "method": "method-name",
  "params": {},
  "ok": true,
  "payload": {},
  "error": { "code": "...", "message": "..." },
  "event": "event-name",
  "seq": 1
}
```

---

### 9. Endpoint → Server

#### 9.1 Send Message (endpoint.accept)

```json
{
  "type": "req",
  "id": "m1",
  "method": "endpoint.accept",
  "params": {
    "content": [
      { "type": "text", "text": "User message" }
    ],
    "contextTags": [
      { "kind": "chat_id", "value": "oc_xxx", "groupWith": true, "passToTool": true }
    ]
  }
}
```

#### 9.2 Tool Response (tool_response)

```json
{
  "type": "req",
  "method": "tool_response",
  "params": {
    "id": "req_001",
    "success": true,
    "result": { "screenshot": "base64..." }
  }
}
```

---

### 10. Server → Endpoint

#### 10.1 Tool Call (tool_request)

```json
{
  "type": "event",
  "event": "tool_request",
  "payload": {
    "id": "req_001",
    "name": "read_file",
    "args": { "endpointId": "desktop-01", "path": "/tmp/test.txt" }
  }
}
```

#### 10.2 Intent Push (intent)

```json
{
  "type": "event",
  "event": "intent",
  "payload": {
    "action": "follow",
    "target": { "type": "person", "position": { "x": 100, "y": 200 } }
  }
}
```

| action | Description |
|--------|-------------|
| `follow` | Follow target |
| `scan` | Enter perception mode |
| `sleep` | Enter standby |
| `clean` | Cleaning mode |

---

## 中文

### 概述

本文档描述如何将你的应用（聊天机器人、桌面助手、IoT 设备等）连接到 Ailo 意识核心。

**核心概念：**
- **端点 (Endpoint)**：连接到 Ailo 的任何应用程序
- **自描述**：端点直接上报自己的能力（工具、MCP 工具、Skill）
- **原子化聚合**：服务端按 `name + description` 哈希匹配聚合工具/Skill
- **EndpointID**：每次工具调用必须指定目标端点

---

### 1. 连接流程

#### 1.1 握手

端点发送的第一个帧必须是 `connect` 请求：

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "role": "endpoint",
    "apiKey": "ailo_ep_xxx",
    "endpointId": "my-desktop-01",
    "caps": ["message", "tool_execute"],
    "sdkVersion": "1.0.0",
    "tools": [...],
    "mcpTools": [...],
    "skills": [...],
    "instructions": "我的 MacBook Pro，具备截图、浏览器自动化等能力"
  }
}
```

| 字段 | 必填 | 描述 |
|------|------|------|
| `role` | ✅ | 固定值：`"endpoint"` |
| `apiKey` | ✅ | 在管理后台创建的 API Key |
| `endpointId` | ✅ | 端点唯一标识（全局唯一，重复将拒绝注册） |
| `caps` | ✅ | 声明的能力 |
| `tools` | ❌ | 端点原生工具列表 |
| `mcpTools` | ❌ | MCP 扩展工具列表 |
| `skills` | ❌ | 技能文档列表 |
| `instructions` | ❌ | 端点描述（一句话） |

**成功响应：**

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "connId": "conn_1234567890",
    "protocol": 4
  }
}
```

**错误响应（endpointId 重复）：**

```json
{
  "type": "res",
  "id": "c1",
  "ok": false,
  "error": {
    "code": "DUPLICATE_ENDPOINT",
    "message": "endpoint \"my-desktop-01\" is already registered"
  }
}
```

---

### 2. 能力

| 值 | 描述 |
|---|------|
| `message` | 接收用户消息 |
| `tool_execute` | 执行工具调用 |
| `intent` | 接收意图命令 |

---

### 3. 工具定义

#### 3.1 工具结构

```json
{
  "name": "read_file",
  "description": "读取本地磁盘文件",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "文件绝对路径"
      }
    },
    "required": ["path"]
  }
}
```

#### 3.2 MCP 工具

MCP 工具结构与普通工具相同，带有 MCP 服务器名前缀：

```json
{
  "name": "filesystem:read_file",
  "description": "列出目录内容",
  "parameters": {...}
}
```

---

### 4. Skills

#### 4.1 Skill 结构

```json
{
  "name": "git-guide",
  "description": "Git 使用指南",
  "content": "# Git 使用指南\n\n## 基本命令\n..."
}
```

#### 4.2 查询 Skills

使用 `get_skills` 工具查询：

```json
// 查询所有 Skills
{"endpoint_id": "", "skill_name": ""}

// 查询特定端点的 Skills
{"endpoint_id": "desktop-01", "skill_name": ""}

// 获取 Skill 详情
{"endpoint_id": "desktop-01", "skill_name": "git-guide"}
```

---

### 5. 服务端聚合

#### 5.1 匹配规则

```
工具匹配 Key = hash(tool.name + "|" + tool.description)
Skill 匹配 Key = hash(skill.name + "|" + skill.description)

- 相同 Key = 相同工具/Skill（聚合）
- 不同 Key = 不同工具/Skill（即使 name 相同）
```

#### 5.2 聚合结果

对于来自多个端点的同名工具（描述不同）：

```json
{
  "name": "file_read",
  "description": "⚠️ 注意：不同端点的用法不同！\n\n【端点 1】desktop-01\n读取本地磁盘文件\n\n【端点 2】server-01\n读取服务器日志，支持远程路径\n\n可用端点：desktop-01, server-01",
  "parameters": {
    "oneOf": [
      {
        "type": "object",
        "description": "读取本地磁盘文件",
        "properties": {
          "endpointId": { "type": "string", "const": "desktop-01" },
          "path": { "type": "string" }
        },
        "required": ["endpointId", "path"]
      },
      {
        "type": "object",
        "description": "读取服务器日志",
        "properties": {
          "endpointId": { "type": "string", "const": "server-01" },
          "path": { "type": "string" },
          "timeout": { "type": "number" }
        },
        "required": ["endpointId", "path", "timeout"]
      }
    ]
  }
}
```

#### 5.3 统一 Schema 优化

如果所有端点的同名工具参数完全一致，服务端使用统一 Schema：

```json
{
  "name": "read_file",
  "description": "读取文件内容。\n\n可用端点：desktop-01, server-01",
  "parameters": {
    "type": "object",
    "properties": {
      "endpointId": {
        "type": "string",
        "enum": ["desktop-01", "server-01"]
      },
      "path": { "type": "string" }
    },
    "required": ["endpointId", "path"]
  }
}
```

---

### 6. 动态更新

#### 6.1 更新请求

```json
{
  "type": "req",
  "method": "endpoint.update",
  "params": {
    "register": {
      "tools": [...],
      "mcpTools": [...],
      "skills": [...]
    },
    "unregister": {
      "tools": true,
      "mcpTools": true,
      "skills": true
    }
  }
}
```

| 字段 | 描述 |
|------|------|
| `register` | 全量替换对应类别 |
| `unregister.tools` | 设为 `true` 清除所有原生工具 |
| `unregister.mcpTools` | 设为 `true` 清除所有 MCP 工具 |
| `unregister.skills` | 设为 `true` 清除所有 Skills |

#### 6.2 更新响应

```json
{
  "type": "res",
  "ok": true,
  "payload": {
    "updated": true
  }
}
```

---

### 7. 连接生命周期

#### 7.1 WebSocket 断开

WebSocket 断开时，服务端：
1. 移除该端点的所有数据（工具、MCP 工具、Skills、描述）
2. 触发工具注册表刷新
3. LLM 在下次请求时看到更新后的工具/Skills

#### 7.2 重连

重连时端点应：
1. 发送完整的 `connect` 请求，包含当前的工具/Skills
2. 如果 endpointId 已被其他连接注册，服务端将拒绝

---

### 8. 消息格式

#### 8.1 通用帧格式

```json
{
  "type": "req|res|event",
  "id": "correlation-id",
  "method": "method-name",
  "params": {},
  "ok": true,
  "payload": {},
  "error": { "code": "...", "message": "..." },
  "event": "event-name",
  "seq": 1
}
```

---

### 9. 端点 → 服务端

#### 9.1 发送消息 (endpoint.accept)

```json
{
  "type": "req",
  "id": "m1",
  "method": "endpoint.accept",
  "params": {
    "content": [
      { "type": "text", "text": "用户消息" }
    ],
    "contextTags": [
      { "kind": "chat_id", "value": "oc_xxx", "groupWith": true, "passToTool": true }
    ]
  }
}
```

#### 9.2 工具响应 (tool_response)

```json
{
  "type": "req",
  "method": "tool_response",
  "params": {
    "id": "req_001",
    "success": true,
    "result": { "screenshot": "base64..." }
  }
}
```

---

### 10. 服务端 → 端点

#### 10.1 工具调用 (tool_request)

```json
{
  "type": "event",
  "event": "tool_request",
  "payload": {
    "id": "req_001",
    "name": "read_file",
    "args": { "endpointId": "desktop-01", "path": "/tmp/test.txt" }
  }
}
```

#### 10.2 意图推送 (intent)

```json
{
  "type": "event",
  "event": "intent",
  "payload": {
    "action": "follow",
    "target": { "type": "person", "position": { "x": 100, "y": 200 } }
  }
}
```

| action | 描述 |
|--------|------|
| `follow` | 跟随目标 |
| `scan` | 进入感知模式 |
| `sleep` | 进入待机 |
| `clean` | 清洁模式 |
