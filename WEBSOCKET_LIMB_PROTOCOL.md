# Ailo Endpoint Protocol v2

## 概述

Ailo Endpoint Protocol 是 Ailo 意识核心与所有外部终端之间的统一双向通信协议。

**终端（Endpoint）** 是接入 Ailo 意识的任意实体：机器人、飞书、网页聊天、门口摄像头、IoT 网关、桌面 Agent 等。所有终端使用同一套协议，通过声明不同的能力（caps）来决定双方交换哪些消息类型。

**认证**：终端使用在 aido 管理界面预创建的 **API Key** 直接连接，无需任何注册步骤。

---

## 一、帧格式

所有消息均为 JSON，共享同一顶层结构：

```json
{
  "type": "req|res|event|signal",
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

| 字段 | 类型 | 说明 | 何时出现 |
|------|------|------|---------|
| `type` | string | `"req"` / `"res"` / `"event"` / `"signal"` | 总是 |
| `id` | string | 请求/响应关联 ID | req / res / signal |
| `method` | string | 方法名 | req |
| `params` | object | 方法参数 | req |
| `ok` | boolean | 成功标志 | res |
| `payload` | object | 响应数据或信号数据 | res / signal |
| `error` | object | 错误详情 | res（失败时） |
| `event` | string | 事件名 | event |
| `seq` | number | 事件序列号 | event |

---

## 二、连接角色

| 角色 | 说明 |
|------|------|
| `endpoint` | 外部终端（机器人、飞书、摄像头、IoT 等），使用 API Key 认证 |
| `client` | Web UI、CLI 工具等，仅 localhost 允许 |

同一 `endpointId` 仅允许一个活跃连接。新连接到达时，旧连接会被自动断开（处理网络重连和 TCP 半开场景）。

---

## 三、能力（Caps）

终端在连接握手时声明自身能力，服务端据此路由消息并校验权限。

| cap | 含义 | 端点→云端 | 云端→端点 |
|-----|------|---------|---------|
| `message` | 对话消息 | `endpoint.accept` | `tool_request`（发回复） |
| `world_update` | 感知更新 | `world_update` | `world_enrichment` |
| `tool_execute` | 工具执行 | `tool_response` | `tool_request` |
| `intent` | 意图接收 | — | `intent` |
| `signal` | 信令 | `signal` | `signal` |
| *(公共)* | 日志/健康/存储 | `endpoint.health`, `endpoint.log`, `endpoint.data.*` | — |

---

## 四、Blueprint（蓝图）

**Blueprint（蓝图）** 是独立于端点存在的设备使用说明文档，通过 URL 寻址。它定义了一类设备的能力、工具和使用方式。

核心特性：
- **独立存在**：蓝图不依附于任何端点，可以托管在 GitHub、CDN 或自建服务器
- **N:M 关系**：一个端点可引用多份蓝图，一份蓝图可被多个端点引用
- **去重**：同一蓝图的 10 个端点实例，LLM 只看一份说明 + 实例列表
- **可标准化**：蓝图可以成为行业标准——任何厂商只要遵循同一份蓝图，LLM 就知道怎么用
- **工具定义**：蓝图的 YAML frontmatter 定义标准工具（JSON Schema），端点可额外声明私有工具

### 4.1 蓝图文档格式

Markdown + YAML frontmatter。frontmatter 定义元数据和工具 schema，body 是 LLM 可读的使用说明。

```yaml
---
name: sweeper-robot
version: 1.0.0
description: 智能扫地机器人
tools:
  - name: start_clean
    description: 开始清扫任务
    timeout: 10
    parameters:
      type: object
      properties:
        mode: { type: string, enum: [auto, spot, edge] }
        room: { type: string }
      required: [mode]
  - name: stop
    description: 停止清扫
    timeout: 5
  - name: get_status
    description: 获取当前状态
---
## 端点说明
智能扫地机器人，具备自主导航、定时清扫、区域清扫功能。

## 使用场景
- 用户要求打扫某个房间时
- 定时任务触发时

## 工具使用说明
### start_clean
开始清扫任务。
- mode: "auto"（自动）, "spot"（定点）, "edge"（沿边）
- room: 可选，指定房间

### stop
停止当前清扫。

## 约束
- 低电量时会自动返回充电座
- 清扫中无法拍照
```

### 4.2 工具执行语义

所有工具调用在协议层是**同步的**（LLM 等待 tool_result 后继续推理）。蓝图 tool 定义支持：

| 字段 | 类型 | 说明 |
|------|------|------|
| `timeout` | number | 执行超时（秒），默认 30 |
| `async` | boolean | 标记为 `true` 时，工具应秒回 taskId，真正结果通过 `endpoint.accept` 异步通知 |

### 4.3 工具命名与路由

蓝图工具以 `blueprintName:toolName` 注册，并自动注入 `endpointId` 参数用于路由到具体实例：

```
LLM 调用: sweeper-robot:start_clean(endpointId="robot-02", mode="auto")
服务端: 查找 endpointId="robot-02" 的连接 → 发送 tool_request
端点: 执行 start_clean(mode="auto") → 返回 tool_response
```

端点私有工具以 `endpointId:toolName` 注册，不需要 `endpointId` 参数（直接路由到该端点）。

### 4.4 端点连接时的蓝图引用

端点在 `connect` 时通过 `blueprints` 字段引用蓝图 URL：

```json
{
  "blueprints": ["https://blueprints.ailo.ai/sweeper-robot/v1.md"],
  "tools": [{ "name": "debug_dump", "description": "开发调试" }],
  "instructions": "这台在客厅，面积约20平米"
}
```

- `blueprints`：蓝图 URL 数组，服务端拉取并缓存
- `tools`：私有工具（不在蓝图中）
- `instructions`：私有备注（追加在蓝图内容之后）

---

## 五、连接生命周期

### 5.1 握手

**第一帧必须是 `connect` 请求**，携带 API Key 和能力声明。

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "role": "endpoint",
    "apiKey": "ailo_ep_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "endpointId": "robot-01",
    "displayName": "客厅陪伴机器人",
    "caps": ["world_update", "tool_execute", "intent"],
    "sdkVersion": "1.0.0",
    "blueprints": [
      "https://blueprints.ailo.ai/companion-robot/v1.md"
    ],
    "tools": [
      { "name": "debug_dump", "description": "开发调试用，导出内部状态" }
    ],
    "instructions": "这台机器人在客厅，面积约20平米"
  }
}
```

`blueprints`：蓝图 URL 数组。服务端拉取并缓存蓝图文档，从中提取工具定义和使用说明。同一蓝图被多个端点引用时，工具只注册一次（通过 `endpointId` 参数路由到具体实例）。

`tools`：仅放不在任何蓝图中的私有工具。

`instructions`：私有备注，追加在蓝图内容之后显示。

**成功响应**

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "connId": "conn_1234567890",
    "protocol": 2
  }
}
```

**失败响应**

```json
{
  "type": "res",
  "id": "c1",
  "ok": false,
  "error": { "code": "AUTH_FAILED", "message": "invalid apiKey" }
}
```

### 5.2 API Key 管理

API Key 在 **aido 管理界面**创建和管理，无需代码注册。

| REST API | 方法 | 说明 |
|---------|------|------|
| `/api/endpoint-keys` | GET | 列出所有 key（密钥值脱敏） |
| `/api/endpoint-keys` | POST | 创建 key（body: `label`, `endpointType`） |
| `/api/endpoint-keys/:id` | DELETE | 吊销 key |

创建响应示例（**仅创建时返回完整 key**，之后查询均脱敏）：

```json
{
  "key": {
    "id": "epk_a1b2c3d4e5f6g7h8",
    "key": "ailo_ep_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "label": "客厅机器人",
    "endpointType": "robot",
    "createdAt": "2026-01-01T00:00:00Z"
  }
}
```

---

## 六、端点→云端方法

### 6.1 endpoint.accept（cap: message）

提交一条用户消息或感知信号给意识处理。

```json
{
  "type": "req",
  "id": "m1",
  "method": "endpoint.accept",
  "params": {
    "content": [
      { "type": "text", "text": "你好" },
      {
        "type": "image",
        "media": { "type": "image", "url": "https://example.com/img.jpg", "mime": "image/jpeg" }
      }
    ],
    "contextTags": [
      { "kind": "participant", "value": "张三", "groupWith": true },
      { "kind": "chat_id", "value": "oc_xxx", "groupWith": true, "passToTool": true }
    ],
    "requiresResponse": true
  }
}
```

| 字段 | 必须 | 说明 |
|------|------|------|
| `content` | 是* | 消息内容数组（`requiresResponse: true` 时至少一项） |
| `contextTags` | 否 | 时空场标签。流分组与回复路由由端点通过 contextTags（含 groupWith、passToTool）自行携带 |
| `requiresResponse` | 否 | 默认 `true`；设为 `false` 时走被动感知路径，允许空 content，不触发 LLM 推理 |

### 6.2 world_update（cap: world_update）

上报传感器/感知数据，触发意识场景理解。

```json
{
  "type": "req",
  "id": "w1",
  "method": "world_update",
  "params": {
    "mode": "aware",
    "obstacles": [120.5, 200.0, 85.3],
    "pir_active": true,
    "image_base64": "/9j/4AAQ...",
    "voice_text": "",
    "reason": "frame_diff"
  }
}
```

| 字段 | 说明 |
|------|------|
| `mode` | 当前运行模式："sleep"\|"aware"\|"companion"\|"pet_follow"\|"patrol" |
| `obstacles` | 超声波距离 [前, 左, 右]（cm） |
| `pir_active` | PIR 传感器是否激活 |
| `image_base64` | 当前帧 JPEG base64（有帧差变化时附带） |
| `voice_text` | Whisper 转写结果（有语音时附带） |
| `reason` | 上报原因："frame_diff"\|"voice"\|"pir_wake"\|"mode_changed"\|"reconnect" |

### 6.3 tool_response（cap: tool_execute）

返回工具执行结果，与 tool_request 的 `id` 关联。

```json
{
  "type": "req",
  "id": "r1",
  "method": "tool_response",
  "params": {
    "id": "req_001",
    "success": true,
    "result": { "duration_ms": 1240 }
  }
}
```

### 6.4 endpoint.health

上报平台/硬件健康状态。

```json
{
  "type": "req",
  "id": "h1",
  "method": "endpoint.health",
  "params": {
    "status": "connected",
    "detail": ""
  }
}
```

### 6.5 endpoint.log

将日志转发到 Ailo 服务端打印（MCP 子进程 stdout 被占用时使用）。

```json
{
  "type": "req",
  "id": "l1",
  "method": "endpoint.log",
  "params": {
    "level": "info",
    "message": "Whisper 模型加载完成",
    "data": { "model": "tiny", "elapsed_ms": 843 }
  }
}
```

### 6.6 endpoint.data.*

每个端点独立的 KV 存储（按 endpointId 隔离）。

```json
{ "type": "req", "id": "d1", "method": "endpoint.data.get", "params": { "key": "user_prefs" } }
{ "type": "req", "id": "d2", "method": "endpoint.data.set", "params": { "key": "user_prefs", "value": "{...}" } }
{ "type": "req", "id": "d3", "method": "endpoint.data.delete", "params": { "key": "user_prefs" } }
```

---

## 七、云端→端点消息

服务端通过 `event` 帧主动推送，不需要端点先发请求。

### 7.1 world_enrichment（cap: world_update）

返回场景理解结果，通常是对 world_update 的响应。

```json
{
  "type": "event",
  "event": "world_enrichment",
  "seq": 1,
  "payload": {
    "entities": [
      { "type": "cat", "position": { "x": 200, "y": 150 }, "size": 0.12, "confidence": 0.93 },
      { "type": "furniture", "position": { "x": 50, "y": 200 }, "size": 0.4 }
    ],
    "scene_description": "客厅地板上有一只橙色的猫在走动"
  }
}
```

### 7.2 intent（cap: intent）

下发高层意图，端点自主决定如何执行。

```json
{
  "type": "event",
  "event": "intent",
  "seq": 2,
  "payload": {
    "action": "follow",
    "target": { "type": "cat", "position": { "x": 200, "y": 150 }, "size": 0.12 },
    "params": { "style": "playful" }
  }
}
```

| action | 说明 |
|--------|------|
| `sleep` | 进入深度待机 |
| `scan` | 进入感知模式 |
| `converse` | 进入对话陪伴模式 |
| `follow` | 跟随 target 实体 |
| `patrol` | 自主巡逻 |
| `clean` | 清洁模式（巡逻+旋转刷） |
| `low_balance` | 额度不足提示 |

### 7.3 tool_request（cap: tool_execute）

指定端点执行一项具体工具。端点执行后须发送对应 `tool_response`。

```json
{
  "type": "event",
  "event": "tool_request",
  "id": "req_001",
  "seq": 3,
  "payload": {
    "id": "req_001",
    "name": "play_audio",
    "args": {
      "audio_base64": "UklGR...",
      "expression": "talking"
    }
  }
}
```

**机器人端可用工具**：

| 工具名 | 参数 | 说明 |
|--------|------|------|
| `play_audio` | `audio_base64`, `expression` | 播放 TTS 音频，同时切换表情 |
| `show_expression` | `name` | 切换屏幕表情 |
| `set_led` | `state` | LED 控制 |
| `capture_photo` | `resolution` | 拍照并返回 base64 |

### 7.4 stream（流式文本输出）

意识生成长文本时，可以实时逐 chunk 推送给端点（机器人屏幕滚动显示、飞书打字指示等），无需等待完整响应。

```json
// 流开始
{ "type": "event", "event": "stream", "seq": 4,
  "payload": { "streamId": "s_001", "action": "start", "correlationId": "w1" } }

// 文字块（可能触发多次）
{ "type": "event", "event": "stream", "seq": 5,
  "payload": { "streamId": "s_001", "action": "chunk", "text": "你好！我" } }

{ "type": "event", "event": "stream", "seq": 6,
  "payload": { "streamId": "s_001", "action": "chunk", "text": "检测到一只猫" } }

// 流结束
{ "type": "event", "event": "stream", "seq": 7,
  "payload": { "streamId": "s_001", "action": "end" } }
```

| 字段 | 说明 |
|------|------|
| `streamId` | 唯一标识此次流，同一流的所有帧相同 |
| `action` | `"start"` / `"chunk"` / `"end"` |
| `text` | 文字内容（仅 `action="chunk"` 时出现） |
| `correlationId` | 关联触发此流的 `world_update`/`endpoint.accept` 的请求 ID |

---

## 八、信令（Signal）

双向轻量级控制帧，不需要 req/res 确认。

```json
{ "type": "signal", "id": "signal-name", "payload": {} }
```

---

## 九、心跳

SDK 使用 WebSocket 标准 ping/pong 机制（不走应用层帧）：

- SDK 每 30 秒发一个 WS ping
- 10 秒内未收到 pong → 关闭连接触发重连
- 服务端 30 秒未收到 ping → 标记端点离线

---

## 十、错误码

| 错误码 | 含义 |
|--------|------|
| `HANDSHAKE_REQUIRED` | 首帧必须是 connect 请求 |
| `INVALID_PARAMS` | 参数格式错误 |
| `AUTH_FAILED` | API Key 无效或已吊销 |
| `UNAUTHORIZED` | 无权限执行此操作（未声明对应 cap） |
| `UNKNOWN_METHOD` | 未知方法 |
| `ERROR` | 通用错误 |

---

## 十一、完整流程示例

### 场景 A：机器人唤醒 → 跟随宠物

```
1. 机器人连接
   机器人 → 服务端: connect(role=endpoint, apiKey=ailo_ep_xxx, endpointId=robot-01, caps=["world_update","tool_execute","intent"])
   服务端 → 机器人: res(ok=true, connId=conn_xxx, protocol=2)

2. PIR 检测到热源，上报感知
   机器人 → 服务端: world_update(mode=aware, pir_active=true, image_base64=..., reason=pir_wake)
   服务端 → 机器人: res(ok=true)

3. 意识理解场景
   服务端 → LLM: [世界模型快照 + 图片]
   LLM → 服务端: 场景中有一只猫

4. 下发场景理解结果
   服务端 → 机器人: event(world_enrichment, entities=[{type:cat, ...}])

5. 下发意图
   服务端 → 机器人: event(intent, action=follow, target={type:cat, ...})

6. 机器人开始执行（本地 PD 控制，无需云端逐帧指挥）

7. 宠物追丢，请求发音频问候
   服务端 → 机器人: event(tool_request, id=req_001, name=play_audio, args={audio_base64:...})
   机器人 → 服务端: tool_response(id=req_001, success=true)
```

### 场景 B：飞书用户发消息（新 SDK）

```
1. 飞书端点连接（由 Ailo 拉起，注入 AILO_API_KEY + AILO_ENDPOINT_ID）
   飞书 → 服务端: connect(role=endpoint, apiKey=ailo_ep_yyy, endpointId=feishu, caps=["message","tool_execute"])
   服务端 → 飞书: res(ok=true, protocol=2)

2. 用户发消息
   飞书 → 服务端: endpoint.accept(content=[{type:text,text:"你好"}], contextTags=[{kind:"chat_id",value:"oc_xxx",groupWith:true,passToTool:true}], requiresResponse=true)
   服务端 → 飞书: res(ok=true, accepted=true)

3. 意识推理 → 调用飞书回复工具
   服务端 → 飞书: event(tool_request, name=feishu.send, args={chat_id:oc_xxx, text:"你好！"})
   飞书 → 服务端: tool_response(id=req_xxx, success=true)
```

---

## 十二、版本历史

| 版本 | 变更 |
|------|------|
| v2.4 | `endpoint.accept` 移除 `chatId` 必填；流分组与回复路由由 contextTags（groupWith、passToTool）承载；ContextTag 字段 `streamKey`→`groupWith`、`routing`→`passToTool` |
| v3.0 | 引入 Blueprint（蓝图）体系：URL 可寻址的设备说明文档，N:M 端点引用，工具按蓝图注册（引用计数），endpointId 路由参数，per-tool timeout/async 标记；工具执行统一走 WebSocket（废弃 MCP stdio 双通道）；ConnectParams 新增 `blueprints` 字段 |
| v2.3 | 修复 `world_enrichment` 帧类型（`res` → `event`）；所有 event 帧统一分配 `seq` 序列号；`endpoint.accept` 强制 `chatId` 字段；`endpointId` 唯一性强制（新连接替换旧连接）；章节编号统一；完全移除 `channel` 角色定义 |
| v2.2 | 端点声明的 `tools` 动态注册进工具注册表（LLM 可直接调用）；`tool_response` 关联回等待结果；`BuildSection` 将 tools 列表注入系统提示词；新增标准 Skill Document 格式 |
| v2.1 | 新增 `tools` 声明；新增 `stream` 事件（流式文本输出）；完全移除 `channel` 遗留角色和内存 token 机制 |
| v2 | 统一 channel/limb 为 endpoint；引入 API Key 认证；按 caps 路由；新增 world_update/world_enrichment/intent 消息类型 |
| v1 | 初始版本：channel/client 角色，token 认证，channel.accept/tool_request 消息类型 |
