/**
 * 肢体协议 `ailo-body/1` 的线上类型与常量。
 *
 * 规范：ailo 仓 `docs/protocol/body-v1.md`
 * 语料：ailo 仓 `docs/protocol/conformance-body-1.json`（`tests/conformance.test.ts` 直接跑它）
 *
 * 这里只放"线上有什么"，不放任何连接状态或业务判断。
 *
 * 协议里没有 skill、没有 instructions、没有能力协商：知识属于大脑，
 * 肢体只有动作与一行 description。
 */

export const PROTOCOL = 'ailo-body/1'

// ─── 帧 ─────────────────────────────────────────────────────────────────────

export type FrameType = 'req' | 'res' | 'event'

export interface WireError {
  code: string
  message: string
  retryable?: boolean
  details?: Record<string, unknown>
}

export interface Frame {
  type: FrameType
  id?: string
  method?: string
  params?: unknown
  ok?: boolean
  result?: unknown
  error?: WireError
  event?: string
  seq?: number
  data?: unknown
}

// ─── 方法名与事件名 ─────────────────────────────────────────────────────────

export const Method = {
  Connect: 'connect',
  CatalogUpdate: 'catalog.update',
  Cancel: 'cancel',
  ActionCall: 'action.call',
} as const

export const Event = {
  Ping: 'ping',
  Pong: 'pong',
  Evicted: 'evicted',
  Observation: 'observation',
} as const

/** 线上错误码。服务端会给出这些值，客户端按码分流而不是按文案匹配。 */
export const Code = {
  BadFrame: 'BAD_FRAME',
  HandshakeRequired: 'HANDSHAKE_REQUIRED',
  BadVersion: 'BAD_VERSION',
  UnsupportedMethod: 'UNSUPPORTED_METHOD',
  Unauthorized: 'UNAUTHORIZED',
  InvalidParams: 'INVALID_PARAMS',
  UnknownAction: 'UNKNOWN_ACTION',
  ActionFailed: 'ACTION_FAILED',
  ActionTimeout: 'ACTION_TIMEOUT',
  ActionCancelled: 'ACTION_CANCELLED',
  Internal: 'INTERNAL',
} as const

/**
 * 肢体在应答 action.call 时**可以据实返回**的码。
 *
 * 默认是 ACTION_FAILED。明确知道是参数问题的肢体应回 INVALID_PARAMS——大脑据此
 * 决定"改参数再来"还是"这条路走不通"，而不是一律重试。
 */
export const ReplyCode: ReadonlySet<string> = new Set([
  Code.InvalidParams,
  Code.UnknownAction,
  Code.ActionFailed,
  Code.ActionTimeout,
  Code.ActionCancelled,
  Code.Internal,
])

/** 关闭码。一律按数字判定，不匹配 reason 文案。 */
export const CloseCode = {
  Evicted: 4001,
  Shutdown: 4002,
  SlowConsumer: 4003,
  ProtocolViolation: 4004,
} as const

// ─── 动作声明 ───────────────────────────────────────────────────────────────

/**
 * 一个动作。名字只在肢体内有名（`(bodyId, action)` 才是地址），
 * 但仍然会进 provider 的函数名位置，所以必须是 provider 合法标识符。
 */
export interface Action {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/** 动作名只允许字母数字与 `_ . -`，且不含冒号。 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

export function isValidActionName(name: string): boolean {
  return NAME_RE.test(name)
}

// ─── 内容 ───────────────────────────────────────────────────────────────────

/**
 * 文本、Blob、外部 URL 三种形态，同层扁平，靠 `type` 判别。
 * 没有 base64，也没有本地路径：本地文件必须先上传成 Blob 再引用。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'blob'; id: string; mime?: string; name?: string; size?: number }
  | { type: 'url'; url: string; mime?: string; name?: string }

export function textPart(text: string): ContentPart {
  return { type: 'text', text }
}

export function blobPart(blob: { id: string; mime?: string; name?: string; size?: number }): ContentPart {
  return { type: 'blob', ...blob }
}

export function urlPart(url: string, extra?: { mime?: string; name?: string }): ContentPart {
  return { type: 'url', url, ...extra }
}

export function isContentPart(value: unknown): value is ContentPart {
  if (typeof value !== 'object' || value === null) return false
  const t = (value as { type?: unknown }).type
  return t === 'text' || t === 'blob' || t === 'url'
}

// ─── 方法载荷 ───────────────────────────────────────────────────────────────

export interface ClientInfo {
  name?: string
  version?: string
}

export interface ConnectParams {
  protocol: string
  apiKey: string
  bodyId: string
  name?: string
  description?: string
  client?: ClientInfo
  actions?: Action[]
}

export interface Limits {
  maxFrameBytes: number
  maxActionResultBytes: number
  actionTimeoutMs: number
  heartbeatIntervalMs: number
}

export interface HttpInfo {
  /** 本连接唯一被授权的 HTTP 入口。不要从 ws:// URL 反推。 */
  base: string
  /** Blob API 路径，形如 /api/v1/blobs。 */
  blobs: string
}

export interface ConnectResult {
  sessionId: string
  protocol: string
  limits: Limits
  http: HttpInfo
  replacedSessionId?: string
}

export interface ActionCallParams {
  action: string
  args?: Record<string, unknown>
  deadlineMs?: number
}

export interface ActionResult {
  content: ContentPart[]
}

export interface CatalogUpdateParams {
  actions: Action[]
}

export interface CatalogUpdateResult {
  updated: boolean
}

export interface CancelParams {
  id: string
}

export interface CancelResult {
  cancelled: boolean
}

/** 信号的物理来源（哪台设备、哪个窗口）。不是会话路由：进哪段对话由大脑决定。 */
export interface ObservationSource {
  kind?: string
  id?: string
  label?: string
}

export interface Observation {
  text?: string
  content?: ContentPart[]
  source?: ObservationSource
}

// ─── 校验（失败即抛，不发脏帧） ─────────────────────────────────────────────

export function assertValidActions(actions: Action[]): void {
  const seen = new Set<string>()
  for (const a of actions) {
    if (!isValidActionName(a.name)) {
      throw new Error(`invalid action name: ${JSON.stringify(a.name)}（只允许字母数字 _ . -，且不含冒号）`)
    }
    if (seen.has(a.name)) throw new Error(`duplicate action name: ${a.name}`)
    seen.add(a.name)
    if (a.parameters && a.parameters.type !== 'object') {
      throw new Error(`action ${a.name}: parameters.type must be "object"`)
    }
  }
}
