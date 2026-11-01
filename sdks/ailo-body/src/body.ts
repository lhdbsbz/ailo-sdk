import { BodyClient, type ActionCall, type ClientConfig, type ClientOptions } from './client.js'
import { BodyError } from './errors.js'
import { ConsoleLogger, type Logger, type LogData, type LogLevel } from './logger.js'
import { BlobStore } from './media.js'
import type { Action, ContentPart, Observation, ObservationSource } from './proto.js'

/** 动作处理器：抛异常即 ACTION_FAILED；返回值按 ContentPart[] / string / 其余 JSON 化。 */
export type ActionHandler = (args: Record<string, unknown>, call: ActionCall) => Promise<unknown> | unknown

/** 肢体运行时上下文，交给业务 handler 用。 */
export interface BodyContext {
  client: BodyClient
  /** Blob 通道（上传/下载），握手后可用。 */
  media: BlobStore
  /** 上报一条观测。text 是最常见的形态；要带媒体就用 parts。 */
  observe(text: string, options?: { parts?: ContentPart[]; source?: ObservationSource }): Promise<void>
  /** 上传本地文件成 Blob，返回 blob id（可用于观测的 parts）。 */
  upload(localPath: string): Promise<string>
  /** 整体替换动作表。 */
  updateActions(actions: Action[]): Promise<void>
  log(level: LogLevel, message: string, data?: LogData): void
}

export interface BodyHandler {
  start(ctx: BodyContext): void | Promise<void>
  stop(): void | Promise<void>
}

export interface BodyConfig {
  url?: string
  apiKey?: string
  bodyId?: string
  /** 一行"这东西是什么"。不要写提示词。 */
  name?: string
  description?: string
  actions?: Action[]
  /** 动作名 → 处理器。未命中的名字交给 onUnknownAction。 */
  handlers?: Record<string, ActionHandler>
  onUnknownAction?: (action: string, args: Record<string, unknown>, call: ActionCall) => Promise<unknown> | unknown
  handler: BodyHandler
  logger?: Logger
  clientOptions?: Omit<ClientOptions, 'logger' | 'onActionCall' | 'onStateChange' | 'onEvicted' | 'onFatal'>
  /** 连接失败时的自定义处理（默认进程退出）。 */
  onConnectFailure?: (error: Error, client: BodyClient) => void | Promise<void>
  onEvicted?: (replacedBy?: string) => void
}

/**
 * 起一个肢体进程：连上、声明动作、把 action.call 分发到 handlers。
 *
 * 除了"进程该怎样活着"之外没有别的逻辑——协议细节全在 BodyClient。
 */
export function runBody(config: BodyConfig): void {
  const url = config.url ?? process.env.AILO_WS_URL ?? ''
  const apiKey = config.apiKey ?? process.env.AILO_API_KEY ?? ''
  const bodyId = config.bodyId ?? process.env.AILO_BODY_ID ?? ''

  if (!url || !apiKey || !bodyId) {
    console.error('[body] 缺少 url / apiKey / bodyId（可用 AILO_WS_URL / AILO_API_KEY / AILO_BODY_ID）')
    process.exit(1)
  }

  const logger = config.logger ?? new ConsoleLogger(`[${bodyId}]`)

  const clientConfig: ClientConfig = {
    url,
    apiKey,
    bodyId,
    name: config.name,
    description: config.description,
    actions: config.actions,
    clientName: '@greatlhd/ailo-body',
    clientVersion: SDK_VERSION,
  }

  const handlers = config.handlers ?? {}

  const client = new BodyClient(clientConfig, {
    ...config.clientOptions,
    logger,
    onActionCall: async (call) => {
      const fn = handlers[call.action]
      if (fn) return fn(call.args, call)
      if (config.onUnknownAction) return config.onUnknownAction(call.action, call.args, call)
      throw new Error(`unknown action: ${call.action}`)
    },
    onEvicted: config.onEvicted,
    onStateChange: (state, detail) => logger.info('state', { state, detail }),
    onFatal: (error) => {
      logger.error('fatal', { error: error.message })
      void shutdown('fatal')
    },
  })

  let ctx: BodyContext | null = null
  let stopping = false

  const shutdown = async (reason: string) => {
    if (stopping) return
    stopping = true
    logger.info('shutting_down', { reason })
    try {
      await config.handler.stop()
    } catch {
      /* 停不下来也要退出 */
    }
    client.close(reason)
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  void (async () => {
    for (;;) {
      try {
        const session = await client.connect()
        const media = new BlobStore(session.http, apiKey, logger)
        ctx = {
          client,
          media,
          async observe(text: string, options?: { parts?: ContentPart[]; source?: ObservationSource }) {
            const observation: Observation = { text }
            if (options?.parts?.length) observation.content = options.parts
            if (options?.source) observation.source = options.source
            await client.observe(observation)
          },
          async upload(localPath) {
            const ref = await media.upload(localPath)
            return ref.id
          },
          updateActions: (actions) => client.updateCatalog(actions),
          log: (level, message, data) => logger[level](message, data),
        }
        logger.info('body_ready', { bodyId, sessionId: session.sessionId, actions: config.actions?.length ?? 0 })
        await config.handler.start(ctx)
        return
      } catch (error) {
        const err = BodyError.from(error)
        logger.error('connect_failed', { error: err.message, code: err.code })
        if (!config.onConnectFailure) {
          process.exit(1)
        }
        await config.onConnectFailure(err, client)
        if (stopping) return
      }
    }
  })()
}

export const SDK_VERSION = '3.0.0'
