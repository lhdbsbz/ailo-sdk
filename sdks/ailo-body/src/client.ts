import { isBodyError } from './errors.js'
import type { Logger } from './logger.js'
import { ConsoleLogger } from './logger.js'
import { BlobStore } from './media.js'
import {
  PROTOCOL,
  Code,
  CloseCode,
  ReplyCode,
  Event,
  Method,
  assertValidActions,
  isContentPart,
  type Action,
  type ActionCallParams,
  type CatalogUpdateParams,
  type ConnectParams,
  type ConnectResult,
  type ContentPart,
  type Frame,
  type HttpInfo,
  type Limits,
  type Observation,
  type WireError,
} from './proto.js'

export type ClientState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'evicted'

/** 一次动作调用。signal 会在服务端（或肢体自己）发 cancel 时 abort。 */
export interface ActionCall {
  id: string
  action: string
  args: Record<string, unknown>
  /** 服务端给出的预算，毫秒。超时后服务端自己会失败，这里只用来提前收手。 */
  deadlineMs: number
  signal: AbortSignal
}

export type ActionCallHandler = (call: ActionCall) => Promise<unknown>

export interface ClientConfig {
  url: string
  apiKey: string
  bodyId: string
  /** 一行"这东西是什么"。不要写提示词：知识属于大脑。 */
  name?: string
  description?: string
  actions?: Action[]
  clientName?: string
  clientVersion?: string
}

export interface ClientOptions {
  logger?: Logger
  handshakeTimeoutMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /** 单次 catalog.update 请求的应答超时。 */
  requestTimeoutMs?: number
  onActionCall?: ActionCallHandler
  onStateChange?: (state: ClientState, detail?: string) => void
  onEvicted?: (replacedBy?: string) => void
  onFatal?: (error: Error) => void
}

const DEFAULT_HANDSHAKE_TIMEOUT = 15_000
const DEFAULT_REQUEST_TIMEOUT = 10_000
const DEFAULT_RECONNECT_BASE = 1_000
const DEFAULT_RECONNECT_MAX = 30_000

// 只依赖结构：Node 的 WebSocket 类型来自 undici，不提供 DOM 的 CloseEvent。
type CloseEventLike = { code: number; reason: string }
type MessageEventLike = { data: unknown }

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 肢体客户端：只做三件事——维护连接、收发帧、把 action.call 交给处理器。
 *
 * 它不认识文件路径，不认识模型，也不认识技能：媒体走 BlobStore，别的都在身体自己那边。
 */
export class BodyClient {
  private ws: WebSocket | null = null
  private cfg: ClientConfig
  private readonly opts: ClientOptions
  private readonly logger: Logger

  private stateValue: ClientState = 'idle'
  private pending = new Map<string, Pending>()
  private inflight = new Map<string, AbortController>()
  private reqSeq = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private lastInbound = 0

  private result: ConnectResult | null = null

  constructor(config: ClientConfig, options: ClientOptions = {}) {
    this.cfg = config
    this.opts = options
    this.logger = options.logger ?? new ConsoleLogger(`[${config.bodyId}]`)
  }

  get state(): ClientState {
    return this.stateValue
  }

  get connected(): boolean {
    return this.stateValue === 'connected'
  }

  /** 握手下发的限额与 HTTP 入口（连接前为 null）。 */
  get session(): ConnectResult | null {
    return this.result
  }

  get limits(): Limits | null {
    return this.result?.limits ?? null
  }

  get http(): HttpInfo | null {
    return this.result?.http ?? null
  }

  /** 用握手返回的 http 配置构造 Blob 通道；未连接时报错。 */
  blobStore(): BlobStore {
    if (!this.result) throw new Error('not connected: blob API base is unknown before handshake')
    return new BlobStore(this.result.http, this.cfg.apiKey, this.logger)
  }

  /** 建立连接并完成握手。自动重连不会走进这里。 */
  async connect(): Promise<ConnectResult> {
    if (this.stateValue === 'connected') return this.result as ConnectResult
    // 声明不合法就地失败：不要先建立连接再在对端被拒。
    if (this.cfg.actions?.length) assertValidActions(this.cfg.actions)
    this.setState('connecting', 'dial')
    try {
      const session = await this.dial()
      this.reconnectAttempt = 0
      this.result = session
      this.setState('connected', 'handshake complete')
      return session
    } catch (error) {
      this.setState('idle', 'dial failed')
      throw error
    }
  }

  /** 冷关闭。不再重连。 */
  close(reason = 'client closed'): void {
    if (this.stateValue === 'closed') return
    this.clearReconnect()
    this.stopWatchdog()
    this.failPending(new Error(reason))
    this.abortInflight(reason)
    this.detachAndClose(1000, reason)
    this.setState('closed', reason)
  }

  /** 上报一条观测（门铃、电量、一条通知）。大脑决定它落到哪段对话。 */
  async observe(observation: Observation): Promise<void> {
    this.send({
      type: 'event',
      event: Event.Observation,
      seq: this.nextSeq(),
      data: observation,
    })
  }

  /** 动作表变了：整体替换，不做增量合并。 */
  async updateCatalog(actions: Action[]): Promise<void> {
    assertValidActions(actions)
    this.cfg = { ...this.cfg, actions }
    const params: CatalogUpdateParams = { actions }
    await this.request(Method.CatalogUpdate, params)
  }

  /** 热更新连接参数并重连（配置变更时用）。 */
  async reconnect(patch?: Partial<ClientConfig>): Promise<ConnectResult> {
    if (patch) this.cfg = { ...this.cfg, ...patch }
    this.clearReconnect()
    this.stopWatchdog()
    this.failPending(new Error('reconnecting'))
    this.abortInflight('reconnecting')
    this.detachAndClose(1000, 'reconnect')
    this.setState('idle', 'reconnect')
    return this.connect()
  }

  // ─── 连接 ─────────────────────────────────────────────────────────────────

  private dial(): Promise<ConnectResult> {
    return new Promise<ConnectResult>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      const ws = new WebSocket(this.cfg.url)
      this.ws = ws

      const handshakeTimer = setTimeout(() => {
        settle(() => {
          try {
            ws.close(1000, 'handshake timeout')
          } catch {
            /* ignore */
          }
          reject(new Error(`handshake timeout after ${this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT}ms`))
        })
      }, this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT)

      ws.onopen = () => {
        const id = `connect-${++this.reqSeq}`
        const params: ConnectParams = {
          protocol: PROTOCOL,
          apiKey: this.cfg.apiKey,
          bodyId: this.cfg.bodyId,
          name: this.cfg.name,
          description: this.cfg.description,
          client: { name: this.cfg.clientName, version: this.cfg.clientVersion },
          actions: this.cfg.actions,
        }
        this.pending.set(id, {
          resolve: (value) => {
            clearTimeout(handshakeTimer)
            const session = value as ConnectResult
            this.result = session
            this.afterHandshake()
            settle(() => resolve(session))
          },
          reject: (error) => {
            clearTimeout(handshakeTimer)
            settle(() => {
              try {
                ws.close(1000, 'handshake rejected')
              } catch {
                /* ignore */
              }
              reject(error)
            })
          },
          timer: handshakeTimer,
        })

        ws.send(JSON.stringify({ type: 'req', id, method: Method.Connect, params } satisfies Frame))
      }

      ws.onmessage = (event: MessageEventLike) => {
        this.dispatch(event.data)
      }

      ws.onerror = () => {
        // 具体原因由 onclose 给出；这里只保证握手阶段不会挂死。
        settle(() => reject(new Error('websocket error before handshake')))
      }

      ws.onclose = (event: CloseEventLike) => {
        this.ws = null
        this.stopWatchdog()
        this.failPending(new Error(`connection closed (${event.code})`))
        this.abortInflight(`connection closed (${event.code})`)
        if (!settled) {
          settle(() => reject(new Error(`connection closed before handshake (${event.code})`)))
          return
        }
        this.handleClose(event.code, event.reason)
      }
    })
  }

  private afterHandshake(): void {
    this.lastInbound = Date.now()
    this.startWatchdog()
    this.logger.info('connected', {
      bodyId: this.cfg.bodyId,
      sessionId: this.result?.sessionId,
      actions: this.cfg.actions?.length ?? 0,
    })
  }

  private handleClose(code: number, reason: string): void {
    if (this.stateValue === 'closed') return

    if (code === CloseCode.Evicted) {
      this.logger.warn('evicted', { code, reason })
      this.setState('evicted', reason)
      this.opts.onEvicted?.(reason)
      return
    }

    if (code === CloseCode.ProtocolViolation) {
      const error = new Error(`protocol violation: ${reason || 'closed by server'}`)
      this.logger.error('protocol_violation', { reason })
      this.setState('closed', 'protocol violation')
      this.opts.onFatal?.(error)
      return
    }

    // 服务端关闭、慢消费者、网络断开：都按可恢复处理。
    this.logger.warn('disconnected', { code, reason })
    this.setState('reconnecting', `closed ${code}`)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const base = this.opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE
    const max = this.opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX
    const delay = Math.min(base * 2 ** this.reconnectAttempt, max)
    const jittered = Math.round(delay * (0.5 + Math.random() * 0.5))
    this.reconnectAttempt++
    this.logger.info('reconnect_scheduled', { delay: jittered, attempt: this.reconnectAttempt })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stateValue !== 'reconnecting') return
      this.setState('connecting', 'reconnect attempt')
      this.dial().then(
        (session) => {
          this.result = session
          this.reconnectAttempt = 0
          this.setState('connected', 'reconnected')
        },
        (error: Error) => {
          this.logger.error('reconnect_failed', { error: error.message })
          this.setState('reconnecting', 'reconnect failed')
          this.scheduleReconnect()
        },
      )
    }, jittered)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private detachAndClose(code: number, reason: string): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    try {
      ws.close(code, reason)
    } catch {
      /* ignore */
    }
  }

  // ─── 帧收发 ───────────────────────────────────────────────────────────────

  private dispatch(raw: unknown): void {
    this.lastInbound = Date.now()

    let frame: Frame
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as Frame
    } catch (error) {
      this.logger.error('bad_frame', { error: (error as Error).message })
      return
    }

    switch (frame.type) {
      case 'res':
        this.settleResponse(frame)
        return
      case 'req':
        void this.handleRequest(frame)
        return
      case 'event':
        this.handleEvent(frame)
        return
      default:
        this.logger.warn('unknown_frame', { type: (frame as Frame).type })
    }
  }

  private settleResponse(frame: Frame): void {
    const id = frame.id ?? ''
    const pending = this.pending.get(id)
    if (!pending) {
      this.logger.warn('orphan_response', { id })
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (frame.ok) {
      pending.resolve(frame.result)
      return
    }
    pending.reject(toError(frame.error, id))
  }

  private async handleRequest(frame: Frame): Promise<void> {
    switch (frame.method) {
      case Method.ActionCall:
        await this.runActionCall(frame)
        return
      case Method.Cancel:
        this.handleCancel(frame)
        return
      default:
        this.replyError(frame.id ?? '', Code.UnsupportedMethod, `method ${frame.method} is not valid for bodies`)
    }
  }

  private async runActionCall(frame: Frame): Promise<void> {
    const id = frame.id ?? ''
    const params = (frame.params ?? {}) as ActionCallParams
    const handler = this.opts.onActionCall

    if (!handler) {
      this.replyError(id, Code.UnknownAction, `no handler registered (action: ${params.action})`)
      return
    }

    const controller = new AbortController()
    this.inflight.set(id, controller)

    const call: ActionCall = {
      id,
      action: params.action,
      args: params.args ?? {},
      deadlineMs: params.deadlineMs ?? this.result?.limits.actionTimeoutMs ?? 120_000,
      signal: controller.signal,
    }

    try {
      const result = await handler(call)
      const maxBytes = this.result?.limits.maxActionResultBytes ?? 0
      this.reply(id, { content: toContentParts(result, maxBytes, this.logger) })
    } catch (error) {
      const err = error as Error
      // 处理器可以用 BodyError 声明这是参数问题（INVALID_PARAMS）等；没声明就按失败处理。
      const code = controller.signal.aborted
        ? Code.ActionCancelled
        : isBodyError(error) && ReplyCode.has(error.code)
          ? error.code
          : Code.ActionFailed
      this.replyError(id, code, err.message || String(error))
    } finally {
      this.inflight.delete(id)
    }
  }

  private handleCancel(frame: Frame): void {
    const target = (frame.params as { id?: string } | undefined)?.id ?? ''
    const controller = this.inflight.get(target)
    if (controller) controller.abort()
    this.reply(frame.id ?? '', { cancelled: Boolean(controller) })
  }

  private handleEvent(frame: Frame): void {
    switch (frame.event) {
      case Event.Ping:
        this.send({ type: 'event', event: Event.Pong, seq: this.nextSeq() })
        return
      case Event.Pong:
        return
      case Event.Evicted:
        // 精确的关闭码随后到达；这里只记录，状态切换交给 onclose。
        this.logger.warn('evicting', { data: frame.data })
        return
      default:
        this.logger.warn('unknown_event', { event: frame.event })
    }
  }

  private reply(id: string, result: unknown): void {
    this.send({ type: 'res', id, ok: true, result })
  }

  private replyError(id: string, code: string, message: string): void {
    this.send({ type: 'res', id, ok: false, error: { code, message } })
  }

  private nextSeq(): number {
    return ++this.reqSeq
  }

  private send(frame: Frame): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) {
      this.logger.warn('send_dropped', { type: frame.type, id: frame.id, event: frame.event })
      return
    }
    try {
      ws.send(JSON.stringify(frame))
    } catch (error) {
      this.logger.error('send_failed', { error: (error as Error).message })
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const ws = this.ws
      if (!ws || ws.readyState !== 1) {
        reject(new Error(`not connected (method ${method})`))
        return
      }
      const id = `${method}-${++this.reqSeq}`
      const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ type: 'req', id, method, params })
    })
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private abortInflight(reason: string): void {
    for (const controller of this.inflight.values()) controller.abort(reason)
    this.inflight.clear()
  }

  // ─── 心跳 ─────────────────────────────────────────────────────────────────

  /**
   * 服务端每 heartbeatIntervalMs 发一次 ping；超过 2.5 个周期什么都没收到，
   * 就认定半开连接并主动断开，交给重连。服务端那边有对称的看门狗。
   */
  private startWatchdog(): void {
    this.stopWatchdog()
    const interval = this.result?.limits.heartbeatIntervalMs ?? 30_000
    const limit = interval * 2.5
    this.watchdogTimer = setInterval(() => {
      const idle = Date.now() - this.lastInbound
      if (idle > limit) {
        this.logger.warn('heartbeat_timeout', { idle, limit })
        try {
          this.ws?.close(4000, 'heartbeat timeout')
        } catch {
          /* ignore */
        }
      }
    }, Math.max(1_000, Math.floor(interval / 2)))
    if (typeof this.watchdogTimer === 'object' && 'unref' in this.watchdogTimer) {
      ;(this.watchdogTimer as unknown as { unref: () => void }).unref()
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private setState(state: ClientState, detail?: string): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.opts.onStateChange?.(state, detail)
  }
}

function toError(error: WireError | undefined, id: string): Error {
  const err = new Error(error?.message ?? `request ${id} failed`)
  if (error) {
    ;(err as Error & { code?: string; details?: unknown }).code = error.code
    ;(err as Error & { code?: string; details?: unknown }).details = error.details
  }
  return err
}

/** 把处理器返回值规整成 ContentPart[]：已经是内容块就用，字符串当文本，其余 JSON 化。 */
export function toContentParts(
  result: unknown,
  maxBytes: number,
  logger?: Logger,
): ContentPart[] {
  let parts: ContentPart[]
  if (Array.isArray(result) && result.every(isContentPart)) {
    parts = result as ContentPart[]
  } else if (typeof result === 'string') {
    parts = [{ type: 'text', text: result }]
  } else if (result === undefined || result === null) {
    parts = [{ type: 'text', text: '{"ok":true}' }]
  } else {
    parts = [{ type: 'text', text: JSON.stringify(result) }]
  }

  if (maxBytes <= 0) return parts
  const encoded = JSON.stringify(parts)
  if (encoded.length <= maxBytes) return parts

  // 截断必须显式：静默丢弃会让模型对着半截结果继续推理。
  const budget = Math.floor(maxBytes * 0.8)
  const text = parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  logger?.warn('action_result_truncated', { original: encoded.length, cap: maxBytes })
  return [
    { type: 'text', text: text.slice(0, budget) },
    {
      type: 'text',
      text: `\n\n[结果已截断：原始 ${encoded.length} 字节，上限 ${maxBytes} 字节。请用更精确的参数重取（分页 / limit / 先过滤）。]`,
    },
  ]
}
