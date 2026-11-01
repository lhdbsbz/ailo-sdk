import type { Frame } from '../src/proto.js'

/**
 * 一个最小的 WebSocket 替身：只实现 BodyClient 用到的那点表面。
 *
 * 用它而不是真开一条 socket，是为了让用例可以精确控制帧的到达时序
 * （握手拒绝、cancel 抢在响应前、顶替关闭码）。服务端那一侧的行为
 * 由 ailo 仓的 cmd/protocolcheck 用真 WebSocket 端到端验证，两边不重复。
 */
export class FakeSocket {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  /** 客户端发出的帧。 */
  sent: Frame[] = []
  closeCode: number | null = null

  constructor(private readonly onSend?: (frame: Frame, socket: FakeSocket) => void) {}

  /** 由用例调用：模拟握手完成。 */
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame
    this.sent.push(frame)
    this.onSend?.(frame, this)
  }

  close(code = 1000, reason = ''): void {
    this.closeCode = code
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  /** 由用例调用：服务端下发一帧。 */
  deliver(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  /** 由用例调用：服务端发起的关闭。 */
  remoteClose(code: number, reason = ''): void {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  /** 最近一条发往服务端的帧。 */
  lastSent(): Frame | undefined {
    return this.sent[this.sent.length - 1]
  }

  sentMatching(predicate: (frame: Frame) => boolean): Frame[] {
    return this.sent.filter(predicate)
  }
}

/** 安装到全局，供 BodyClient 的 `new WebSocket(...)` 使用。 */
export function installFakeSocket(factory: () => FakeSocket): () => void {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket
  ;(globalThis as { WebSocket?: unknown }).WebSocket = function () {
    return factory()
  }
  return () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = original
  }
}

export const CONNECT_RESULT = {
  sessionId: 'sess_test',
  protocol: 'ailo-body/1',
  limits: {
    maxFrameBytes: 1 << 20,
    maxActionResultBytes: 4096,
    actionTimeoutMs: 2000,
    heartbeatIntervalMs: 60_000,
  },
  http: { base: 'http://localhost:19800', blobs: '/api/v1/blobs' },
}
