# WebSocket Limb Protocol 设计文档

## 概述

WebSocket Limb 协议是 Ailo 框架中通道（Channel）与意识（Agent）之间的双向通信协议。它基于 JSON 帧格式，支持请求-响应、事件推送和轻量级信令三种通信模式。

## 核心概念

### 角色（Role）

- **channel**: 通道端（如飞书、Telegram、摄像头等外部系统的 SDK）
- **client**: 客户端（如 Web UI、CLI 工具等）

### 帧类型（Frame Type）

| 类型 | 方向 | 用途 |
|------|------|------|
| `req` | 客户端→服务器 | 请求方法调用 |
| `res` | 服务器→客户端 | 响应请求结果 |
| `event` | 服务器→客户端 | 推送事件（单向） |
| `signal` | 双向 | 轻量级控制消息（MCP ↔ Agent） |

## 帧格式

### 通用帧结构

```json
{
  "type": "req|res|event|signal",
  "id": "correlation-id",
  "method": "method-name",
  "params": {},
  "ok": true|false,
  "payload": {},
  "error": {
    "code": "ERROR_CODE",
    "message": "error message"
  },
  "event": "event-name",
  "seq": 1
}
```

### 字段说明

| 字段 | 类型 | 用途 | 何时出现 |
|------|------|------|---------|
| `type` | string | 帧类型 | 总是 |
| `id` | string | 请求/响应关联 ID 或信号名 | req/res/signal |
| `method` | string | 方法名 | req |
| `params` | object | 方法参数 | req |
| `ok` | boolean | 响应成功标志 | res |
| `payload` | object | 响应数据或信号数据 | res/signal |
| `error` | object | 错误详情 | res（失败时） |
| `event` | string | 事件名 | event |
| `seq` | number | 事件序列号 | event |

## 连接生命周期

### 1. 握手（Handshake）

**第一帧必须是 `connect` 请求**

#### 通道连接

```json
{
  "type": "req",
  "id": "conn_1",
  "method": "connect",
  "params": {
    "role": "channel",
    "token": "channel-token",
    "channel": "feishu",
    "displayName": "飞书",
    "sdkVersion": "1.0.0",
    "defaultRequiresResponse": true,
    "instructions": "optional channel-level system instructions"
  }
}
```

**响应**

```json
{
  "type": "res",
  "id": "conn_1",
  "ok": true,
  "payload": {
    "connId": "conn_1234567890",
    "protocol": 1
  }
}
```

#### 客户端连接

```json
{
  "type": "req",
  "id": "client_1",
  "method": "connect",
  "params": {
    "role": "client",
    "token": "client-token"
  }
}
```

## 通道消息流（Channel Message Flow）

### 主动信号路径（Active Signal）

通道向意识发送消息，期望得到回复。

#### 消息进入（channel.accept）

```json
{
  "type": "req",
  "id": "msg_1",
  "method": "channel.accept",
  "params": {
    "chatId": "chat_123",
    "content": [
      {
        "type": "text",
        "text": "你好"
      },
      {
        "type": "image",
        "media": {
          "type": "image",
          "url": "https://example.com/image.jpg",
          "mime": "image/jpeg"
        }
      }
    ],
    "contextTags": [
      {
        "kind": "participant",
        "value": "张三",
        "streamKey": true
      }
    ],
    "requiresResponse": true
  }
}
```

### 被动感知路径（Passive Signal）

通道发送纯状态信号，无需回复。允许空 content。

```json
{
  "type": "req",
  "id": "sense_1",
  "method": "channel.accept",
  "params": {
    "chatId": "sense_123",
    "content": [],
    "contextTags": [
      {
        "kind": "modality",
        "value": "视觉",
        "streamKey": false
      }
    ],
    "requiresResponse": false
  }
}
```

## 工具调用与结果流（Tool Call & Result Flow）

### 工具调用流程

1. **意识生成工具调用**
   - LLM 返回 `ToolCall[]`
   - 每个 `ToolCall` 包含 `id`、`name`、`arguments`

2. **工具执行**
   - 框架并发执行工具（最多 5 个/轮）
   - 通过 MCP 工具（如 `feishu action=send`）发送回复

3. **结果收集**
   - 工具结果作为 `tool` 角色消息注入上下文
   - 每个结果包含 `toolCallId` 关联调用

### 工具调用消息

```typescript
interface ToolCall {
  id: string;           // 唯一标识
  name: string;         // 工具名
  arguments: string;    // 原始 JSON 字符串
}

interface Message {
  role: "assistant";
  toolCalls: ToolCall[];
}
```

### 工具结果消息

```typescript
interface Message {
  role: "tool";
  toolCallId: string;   // 关联的工具调用 ID
  content: ContentPart[];
}
```

## 事件推送（Event Broadcasting）

### 消息事件

当消息落库时，推送给所有 `client` 角色连接：

```json
{
  "type": "event",
  "event": "message",
  "seq": 1,
  "payload": {
    "type": "message",
    "role": "user|assistant|tool",
    "id": "msg_123",
    "content": [...],
    "toolCalls": [...],
    "channel": "feishu",
    "timestamp": 1234567890,
    "contextTags": [...]
  }
}
```

## 客户端方法

### health

获取系统健康状态

```json
{
  "type": "req",
  "id": "health_1",
  "method": "health",
  "params": {}
}
```

### config.get

获取配置信息

```json
{
  "type": "req",
  "id": "cfg_1",
  "method": "config.get",
  "params": {}
}
```

### log.recent

获取最近日志

```json
{
  "type": "req",
  "id": "log_1",
  "method": "log.recent",
  "params": {
    "count": 200
  }
}
```

## 通道数据存储

### channel.data.get

```json
{
  "type": "req",
  "id": "data_1",
  "method": "channel.data.get",
  "params": {
    "key": "user_123",
    "prefix": "user_"
  }
}
```

### channel.data.set

```json
{
  "type": "req",
  "id": "data_2",
  "method": "channel.data.set",
  "params": {
    "key": "user_123",
    "value": "data_value",
    "items": {
      "key1": "value1",
      "key2": "value2"
    }
  }
}
```

### channel.data.delete

```json
{
  "type": "req",
  "id": "data_3",
  "method": "channel.data.delete",
  "params": {
    "key": "user_123",
    "prefix": "user_"
  }
}
```

## 通道健康状态

### channel.health

```json
{
  "type": "req",
  "id": "health_1",
  "method": "channel.health",
  "params": {
    "status": "connected|reconnecting|error",
    "detail": "optional error description"
  }
}
```

## 通道日志

### channel.log

MCP 子进程 stdout 被占用时，通过 WS 将日志发给 Go 代打：

```json
{
  "type": "req",
  "id": "log_1",
  "method": "channel.log",
  "params": {
    "level": "debug|info|warn|error",
    "message": "log message",
    "data": {
      "key": "value"
    }
  }
}
```

## 感知更新

### perception.update

```json
{
  "type": "req",
  "id": "perc_1",
  "method": "perception.update",
  "params": {
    "modality": "vision|audio|touch",
    "description": "optional description",
    "value": "perception data"
  }
}
```

## 客户端消息发送

### message.send

客户端（如 Web UI）发送消息给指定通道：

```json
{
  "type": "req",
  "id": "send_1",
  "method": "message.send",
  "params": {
    "channel": "feishu",
    "channelChatId": "chat_123",
    "content": [
      {
        "type": "text",
        "text": "message content"
      }
    ],
    "contextTags": [
      {
        "kind": "participant",
        "value": "user_name",
        "streamKey": true
      }
    ]
  }
}
```

## 错误处理

### 错误响应格式

```json
{
  "type": "res",
  "id": "req_id",
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message"
  }
}
```

### 常见错误码

| 错误码 | 含义 |
|--------|------|
| `HANDSHAKE_REQUIRED` | 首帧必须是 connect 请求 |
| `INVALID_PARAMS` | 参数格式错误 |
| `AUTH_FAILED` | 认证失败 |
| `UNAUTHORIZED` | 无权限执行此操作 |
| `UNKNOWN_METHOD` | 未知方法 |
| `ERROR` | 通用错误 |

## 性能考虑

### 限制

- WebSocket 读取限制：10 MB
- 工具调用上限：5 个/轮
- 消息内容截断：日志显示 200 字符

### 并发

- 工具调用并发执行
- 消息处理异步进行
- 写操作加锁保护

## 安全性

### 认证

- **通道**：token 由 MCP 预分配，连接时校验
- **客户端**：仅 localhost 允许（无配置 token）

### 跨域

- 允许所有来源（`InsecureSkipVerify: true`）
- 禁用 permessage-deflate 压缩

## 完整消息流示例

### 场景：用户通过飞书发送消息，意识调用工具回复

```
1. 飞书 SDK 连接
   飞书 → 服务器: connect(role=channel, channel=feishu, token=xxx)
   服务器 → 飞书: res(ok=true, connId=conn_123)

2. 用户发送消息
   飞书 → 服务器: channel.accept(chatId=chat_1, content=[{type:text, text:"你好"}])
   服务器 → 飞书: res(ok=true, accepted=true)

3. 意识处理消息
   服务器 → LLM: [user message with context tags]
   LLM → 服务器: [assistant message with tool_calls]

4. 工具执行
   服务器 → 飞书 MCP: feishu.send(chat_id=chat_1, text="回复内容")
   飞书 MCP → 服务器: tool result

5. 消息落库
   服务器 → 所有 clients: event(message, payload={role:user, content:...})
   服务器 → 所有 clients: event(message, payload={role:assistant, toolCalls:...})
   服务器 → 所有 clients: event(message, payload={role:tool, toolCallId:..., content:...})

6. Web UI 接收
   Web UI ← 服务器: event(message, ...)
   Web UI 显示完整对话流
```

## 版本历史

- **v1**: 初始版本，支持基本的请求-响应、事件推送、信令
