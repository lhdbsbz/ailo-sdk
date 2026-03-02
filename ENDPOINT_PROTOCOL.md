# Ailo Endpoint Protocol v3

## Overview

Ailo Endpoint Protocol is a unified bidirectional communication protocol between the Ailo server and all external endpoints.

An **Endpoint** is any entity that connects to Ailo: a chat bot, Lark/Feishu, web chat, a camera, an IoT gateway, a desktop agent, etc. All endpoints use the same protocol and declare different **capabilities (caps)** to determine which message types they send and receive.

**Authentication**: Endpoints authenticate using a pre-created **API Key** from the Ailo admin dashboard.

---

## 1. Frame Format

All messages are JSON with a shared top-level structure:

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

| Field | Type | Description | Present in |
|-------|------|-------------|-----------|
| `type` | string | `"req"` / `"res"` / `"event"` / `"signal"` | always |
| `id` | string | Request/response correlation ID | req / res / signal |
| `method` | string | Method name | req |
| `params` | object | Method parameters | req |
| `ok` | boolean | Success flag | res |
| `payload` | object | Response data or signal data | res / signal |
| `error` | object | Error details | res (on failure) |
| `event` | string | Event name | event |
| `seq` | number | Event sequence number | event |

---

## 2. Connection Roles

| Role | Description |
|------|-------------|
| `endpoint` | External endpoint (bot, Lark, camera, IoT, etc.), authenticated via API Key |
| `client` | Web UI, CLI tools, etc. — localhost only |

Only one active connection per `endpointId` is allowed. When a new connection arrives, the old one is automatically disconnected (handles network reconnects and TCP half-open scenarios).

---

## 3. Capabilities (Caps)

Endpoints declare their capabilities during the connection handshake. The server uses these to route messages and validate permissions.

| Cap | Description | Endpoint → Server | Server → Endpoint |
|-----|-------------|-------------------|-------------------|
| `message` | Chat messages | `endpoint.accept` | `tool_request` (send reply) |
| `world_update` | Perception updates | `world_update` | `world_enrichment` |
| `tool_execute` | Tool execution | `tool_response` | `tool_request` |
| `intent` | Intent delivery | — | `intent` |
| `signal` | Signaling | `signal` | `signal` |
| *(common)* | Logging/health/storage | `endpoint.health`, `endpoint.log`, `endpoint.data.*` | — |

---

## 4. Blueprints

A **Blueprint** is a standalone device/channel specification document, addressed by URL. It defines the capabilities, tools, and usage instructions for a class of endpoints.

Key properties:
- **Standalone**: Blueprints exist independently of any endpoint — host them on GitHub, a CDN, or your own server
- **N:M relationship**: One endpoint can reference multiple blueprints; one blueprint can be referenced by multiple endpoints
- **Deduplication**: 10 endpoint instances sharing the same blueprint → only one copy of the instructions is shown, plus a list of instances
- **Standardizable**: Blueprints can become industry standards — any vendor following the same blueprint is automatically supported
- **Tool definitions**: YAML frontmatter defines standard tools (JSON Schema); endpoints can declare additional private tools

### 4.1 Blueprint Document Format

Markdown + YAML frontmatter. The frontmatter defines metadata and tool schemas; the body provides human-readable usage instructions.

```yaml
---
name: sweeper-robot
version: 1.0.0
description: Smart sweeping robot
tools:
  - name: start_clean
    description: Start a cleaning task
    timeout: 10
    parameters:
      type: object
      properties:
        mode: { type: string, enum: [auto, spot, edge] }
        room: { type: string }
      required: [mode]
  - name: stop
    description: Stop cleaning
    timeout: 5
  - name: get_status
    description: Get current status
---
## Endpoint Description
Smart sweeping robot with autonomous navigation, scheduled cleaning, and zone cleaning.

## Use Cases
- When a user asks to clean a specific room
- When a scheduled task triggers

## Tool Usage
### start_clean
Start a cleaning task.
- mode: "auto" (automatic), "spot" (spot clean), "edge" (edge clean)
- room: optional, specify a room name

### stop
Stop the current cleaning task.

## Constraints
- Automatically returns to charging dock on low battery
- Cannot take photos while cleaning
```

### 4.2 Tool Execution Semantics

All tool calls are **synchronous** at the protocol level (the server waits for `tool_response` before continuing). Blueprint tool definitions support:

| Field | Type | Description |
|-------|------|-------------|
| `timeout` | number | Execution timeout in seconds (default: 30) |
| `async` | boolean | When `true`, the tool should immediately return a `taskId`; the actual result is delivered asynchronously via `endpoint.accept` |

### 4.3 Tool Naming and Routing

Blueprint tools are registered as `blueprintName:toolName`, with an `endpointId` parameter automatically injected for routing to specific instances:

```
Call:     sweeper-robot:start_clean(endpointId="robot-02", mode="auto")
Server:   find connection with endpointId="robot-02" → send tool_request
Endpoint: execute start_clean(mode="auto") → return tool_response
```

Private tools (not in any blueprint) are registered as `endpointId:toolName` and route directly to that endpoint without an `endpointId` parameter.

### 4.4 Blueprint References at Connect Time

Endpoints reference blueprints via the `blueprints` field during `connect`:

```json
{
  "blueprints": ["https://blueprints.example.com/sweeper-robot/v1.md"],
  "tools": [{ "name": "debug_dump", "description": "Dev debugging tool" }],
  "instructions": "This unit is in the living room, ~20 sqm"
}
```

- `blueprints`: Array of blueprint URLs; the server fetches and caches them
- `tools`: Private tools not covered by any blueprint
- `instructions`: Private notes appended after blueprint content

---

## 5. Connection Lifecycle

### 5.1 Handshake

**The first frame must be a `connect` request** carrying the API Key and capability declarations.

```json
{
  "type": "req",
  "id": "c1",
  "method": "connect",
  "params": {
    "role": "endpoint",
    "apiKey": "ailo_ep_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "endpointId": "robot-01",
    "displayName": "Living Room Robot",
    "caps": ["world_update", "tool_execute", "intent"],
    "sdkVersion": "1.0.0",
    "blueprints": [
      "https://blueprints.example.com/companion-robot/v1.md"
    ],
    "tools": [
      { "name": "debug_dump", "description": "Dev debugging, export internal state" }
    ],
    "instructions": "This robot is in the living room, ~20 sqm"
  }
}
```

- `blueprints`: Blueprint URL array. The server fetches and caches the documents, extracting tool definitions and usage instructions. When multiple endpoints reference the same blueprint, tools are registered once (routed via the `endpointId` parameter).
- `tools`: Only for private tools not in any blueprint.
- `instructions`: Private notes appended after blueprint content.

**Success response**

```json
{
  "type": "res",
  "id": "c1",
  "ok": true,
  "payload": {
    "connId": "conn_1234567890",
    "protocol": 3
  }
}
```

**Failure response**

```json
{
  "type": "res",
  "id": "c1",
  "ok": false,
  "error": { "code": "AUTH_FAILED", "message": "invalid apiKey" }
}
```

### 5.2 API Key Management

API Keys are created and managed in the **Ailo admin dashboard**. No code-level registration is needed.

| REST API | Method | Description |
|---------|--------|-------------|
| `/api/endpoint-keys` | GET | List all keys (values are masked) |
| `/api/endpoint-keys` | POST | Create a key (body: `label`, `endpointType`) |
| `/api/endpoint-keys/:id` | DELETE | Revoke a key |

Create response example (**the full key is only returned at creation time**; subsequent queries are masked):

```json
{
  "key": {
    "id": "epk_a1b2c3d4e5f6g7h8",
    "key": "ailo_ep_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "label": "Living Room Robot",
    "endpointType": "robot",
    "createdAt": "2026-01-01T00:00:00Z"
  }
}
```

---

## 6. Endpoint → Server Methods

### 6.1 endpoint.accept (cap: message)

Submit a user message or perception signal for processing.

```json
{
  "type": "req",
  "id": "m1",
  "method": "endpoint.accept",
  "params": {
    "content": [
      { "type": "text", "text": "Hello" },
      {
        "type": "image",
        "media": { "type": "image", "url": "https://example.com/img.jpg", "mime": "image/jpeg" }
      }
    ],
    "contextTags": [
      { "kind": "participant", "value": "Alice", "groupWith": true },
      { "kind": "chat_id", "value": "oc_xxx", "groupWith": true, "passToTool": true }
    ],
    "requiresResponse": true
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `content` | Yes* | Content array (`requiresResponse: true` requires at least one item) |
| `contextTags` | No | Context tags for stream grouping and reply routing (via `groupWith` and `passToTool` flags) |
| `requiresResponse` | No | Default `true`. Set to `false` for passive perception — allows empty `content`, does not trigger a response |

### 6.2 world_update (cap: world_update)

Report sensor/perception data for scene understanding.

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

| Field | Description |
|-------|-------------|
| `mode` | Current operating mode: `"sleep"` \| `"aware"` \| `"companion"` \| `"pet_follow"` \| `"patrol"` |
| `obstacles` | Ultrasonic distances [front, left, right] in cm |
| `pir_active` | Whether PIR sensor is triggered |
| `image_base64` | Current JPEG frame as base64 (sent when frame difference detected) |
| `voice_text` | Speech-to-text result (sent when voice detected) |
| `reason` | Report trigger: `"frame_diff"` \| `"voice"` \| `"pir_wake"` \| `"mode_changed"` \| `"reconnect"` |

### 6.3 tool_response (cap: tool_execute)

Return tool execution results, correlated with the `tool_request` via its `id`.

Two response formats are supported (`content` is preferred; falls back to `result`):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Correlates to the `tool_request.id` |
| `success` | boolean | Whether execution succeeded |
| `result` | any | Legacy format: arbitrary JSON result (backward-compatible) |
| `error` | string | Error message (on failure) |
| `content` | ContentPart[] | **Preferred format**: same structure as `endpoint.accept` content — supports text, image, audio, video, and mixed content. The server uses this field when present, falling back to `result` otherwise |

**Legacy format example** (plain result):

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

**ContentPart format example** (screenshot tool returning an image):

```json
{
  "type": "req",
  "id": "r2",
  "method": "tool_response",
  "params": {
    "id": "req_002",
    "success": true,
    "content": [
      { "type": "text", "text": "Screenshot captured" },
      {
        "type": "image",
        "media": {
          "type": "image",
          "base64": "/9j/4AAQ...",
          "mime": "image/png",
          "name": "screenshot.png"
        }
      }
    ]
  }
}
```

### 6.4 endpoint.health

Report platform/hardware health status.

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

Forward log entries to the server (useful when local stdout is occupied, e.g. MCP child processes).

```json
{
  "type": "req",
  "id": "l1",
  "method": "endpoint.log",
  "params": {
    "level": "info",
    "message": "Whisper model loaded",
    "data": { "model": "tiny", "elapsed_ms": 843 }
  }
}
```

### 6.6 endpoint.data.*

Per-endpoint key-value storage (isolated by `endpointId`).

```json
{ "type": "req", "id": "d1", "method": "endpoint.data.get", "params": { "key": "user_prefs" } }
{ "type": "req", "id": "d2", "method": "endpoint.data.set", "params": { "key": "user_prefs", "value": "{...}" } }
{ "type": "req", "id": "d3", "method": "endpoint.data.delete", "params": { "key": "user_prefs" } }
```

---

## 7. Server → Endpoint Messages

The server pushes events via `event` frames. No prior request from the endpoint is needed.

### 7.1 world_enrichment (cap: world_update)

Returns scene understanding results, typically in response to a `world_update`.

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
    "scene_description": "An orange cat is walking on the living room floor"
  }
}
```

### 7.2 intent (cap: intent)

Delivers a high-level intent. The endpoint decides how to execute it autonomously.

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

| Action | Description |
|--------|-------------|
| `sleep` | Enter deep standby |
| `scan` | Enter perception mode |
| `converse` | Enter conversation/companion mode |
| `follow` | Follow the target entity |
| `patrol` | Autonomous patrol |
| `clean` | Cleaning mode |
| `low_balance` | Insufficient credits notification |

### 7.3 tool_request (cap: tool_execute)

Instructs the endpoint to execute a specific tool. The endpoint must respond with a corresponding `tool_response`.

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

### 7.4 stream (Streaming Text Output)

When the server generates long text responses, it can push them incrementally as chunks — enabling live display on robot screens, typing indicators in chat apps, etc.

```json
// Stream start
{ "type": "event", "event": "stream", "seq": 4,
  "payload": { "streamId": "s_001", "action": "start", "correlationId": "w1" } }

// Text chunks (may occur multiple times)
{ "type": "event", "event": "stream", "seq": 5,
  "payload": { "streamId": "s_001", "action": "chunk", "text": "Hello! I " } }

{ "type": "event", "event": "stream", "seq": 6,
  "payload": { "streamId": "s_001", "action": "chunk", "text": "detected a cat" } }

// Stream end
{ "type": "event", "event": "stream", "seq": 7,
  "payload": { "streamId": "s_001", "action": "end" } }
```

| Field | Description |
|-------|-------------|
| `streamId` | Unique identifier for this stream; shared by all frames in the same stream |
| `action` | `"start"` / `"chunk"` / `"end"` |
| `text` | Text content (only present when `action="chunk"`) |
| `correlationId` | Links back to the `world_update` or `endpoint.accept` request that triggered this stream |

---

## 8. Signals

Lightweight bidirectional control frames that do not require req/res acknowledgment.

```json
{ "type": "signal", "id": "signal-name", "payload": {} }
```

---

## 9. Heartbeat

The SDK uses standard WebSocket ping/pong (no application-layer frames):

- SDK sends a WS ping every 30 seconds
- If no pong is received within 10 seconds → close the connection and trigger reconnect
- Server marks the endpoint as offline if no ping is received for 30 seconds

---

## 10. Error Codes

| Code | Description |
|------|-------------|
| `HANDSHAKE_REQUIRED` | The first frame must be a `connect` request |
| `INVALID_PARAMS` | Invalid parameter format |
| `AUTH_FAILED` | API Key is invalid or revoked |
| `UNAUTHORIZED` | No permission (required cap not declared) |
| `UNKNOWN_METHOD` | Unknown method |
| `ERROR` | Generic error |

---

## 11. End-to-End Examples

### Scenario A: Robot wakes up → follows a pet

```
1. Robot connects
   Robot → Server: connect(role=endpoint, apiKey=ailo_ep_xxx, endpointId=robot-01, caps=["world_update","tool_execute","intent"])
   Server → Robot: res(ok=true, connId=conn_xxx, protocol=3)

2. PIR detects heat source, reports perception
   Robot → Server: world_update(mode=aware, pir_active=true, image_base64=..., reason=pir_wake)
   Server → Robot: res(ok=true)

3. Server processes the scene
   Server analyzes the image and detects a cat

4. Scene understanding delivered
   Server → Robot: event(world_enrichment, entities=[{type:cat, ...}])

5. Intent delivered
   Server → Robot: event(intent, action=follow, target={type:cat, ...})

6. Robot begins execution (local PD control, no per-frame cloud guidance needed)

7. Lost the pet, server requests audio playback
   Server → Robot: event(tool_request, id=req_001, name=play_audio, args={audio_base64:...})
   Robot → Server: tool_response(id=req_001, success=true)
```

### Scenario B: Lark/Feishu user sends a message

```
1. Feishu endpoint connects
   Feishu → Server: connect(role=endpoint, apiKey=ailo_ep_yyy, endpointId=feishu, caps=["message","tool_execute"])
   Server → Feishu: res(ok=true, protocol=3)

2. User sends a message
   Feishu → Server: endpoint.accept(content=[{type:text,text:"Hello"}], contextTags=[{kind:"chat_id",value:"oc_xxx",groupWith:true,passToTool:true}], requiresResponse=true)
   Server → Feishu: res(ok=true, accepted=true)

3. Server processes and invokes the reply tool
   Server → Feishu: event(tool_request, name=feishu-channel:send, args={chat_id:oc_xxx, text:"Hello!"})
   Feishu → Server: tool_response(id=req_xxx, success=true)
```
