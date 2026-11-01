import { describe, expect, it } from 'vitest'

import { BodyClient, type ClientOptions } from '../src/client.js'
import { NoopLogger } from '../src/logger.js'
import { CloseCode, Code, Method, PROTOCOL, type Frame } from '../src/proto.js'
import { CONNECT_RESULT, FakeSocket, installFakeSocket } from './fake-socket.js'

const logger = new NoopLogger()

function connectOk(): Frame {
  return { type: 'res', id: 'x', ok: true, result: CONNECT_RESULT }
}

/**
 * 起一个装好假 socket 的客户端。
 *
 * onConnect 决定握手怎么应答；返回的 socket() 在 connect() 之后可用。
 */
function harness(
  options: ClientOptions = {},
  onConnect: (frame: Frame, socket: FakeSocket) => void = (frame, s) => {
    s.deliver({ ...connectOk(), id: frame.id })
  },
) {
  let created: FakeSocket | null = null
  const restore = installFakeSocket(() => {
    created = new FakeSocket(onConnect)
    return created
  })

  const client = new BodyClient(
    {
      url: 'ws://test/ws',
      apiKey: 'key',
      bodyId: 'desk-01',
      name: '这台电脑',
      description: '文件读写与 shell',
      actions: [{ name: 'read', description: '读文件' }],
    },
    { logger, ...options },
  )

  return {
    client,
    socket(): FakeSocket {
      if (!created) throw new Error('socket not created yet')
      return created
    },
    async connected(): Promise<FakeSocket> {
      const pending = client.connect()
      this.socket().open()
      await pending
      return this.socket()
    },
    dispose(): void {
      client.close()
      restore()
    },
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('握手', () => {
  it('按 ailo-body/1 协商，不带技能/能力/提示词', async () => {
    const h = harness()
    const socket = await h.connected()

    expect(h.client.session?.protocol).toBe(PROTOCOL)
    expect(h.client.session?.limits.actionTimeoutMs).toBe(2000)

    const connect = socket.sentMatching((f) => f.method === Method.Connect)[0]
    const params = connect.params as Record<string, unknown>
    expect(params.protocol).toBe(PROTOCOL)
    expect(params.bodyId).toBe('desk-01')
    expect(params.name).toBe('这台电脑')
    expect((params.actions as { name: string }[])[0].name).toBe('read')
    for (const gone of ['skills', 'features', 'instructions', 'endpointId', 'tools']) {
      expect(params[gone]).toBeUndefined()
    }

    h.dispose()
  })

  it('握手被拒时抛出带原因的错误，状态回到 idle', async () => {
    const h = harness({}, (frame, socket) => {
      socket.deliver({
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: Code.Unauthorized, message: '密钥已吊销' },
      })
    })

    const pending = h.client.connect()
    h.socket().open()
    await expect(pending).rejects.toThrow(/吊销/)
    expect(h.client.state).toBe('idle')
    h.dispose()
  })

  it('非法动作名在连之前就失败，不建立连接', async () => {
    let created = 0
    const restore = installFakeSocket(() => {
      created++
      return new FakeSocket()
    })
    const client = new BodyClient(
      { url: 'ws://test/ws', apiKey: 'key', bodyId: 'desk-01', actions: [{ name: 'mcp:read' }] },
      { logger },
    )

    await expect(client.connect()).rejects.toThrow(/invalid action name/)
    expect(created).toBe(0)
    restore()
  })
})

describe('action.call', () => {
  it('结果规整成 content 内容块回给服务端', async () => {
    const h = harness({ onActionCall: async (call) => ({ echo: call.args.text }) })
    const socket = await h.connected()

    socket.deliver({ type: 'req', id: 'call_1', method: Method.ActionCall, params: { action: 'read', args: { text: 'hi' } } })
    await flush()

    const res = socket.sentMatching((f) => f.type === 'res' && f.id === 'call_1')[0]
    expect(res.ok).toBe(true)
    const content = (res.result as { content: { type: string; text: string }[] }).content
    expect(content).toEqual([{ type: 'text', text: '{"echo":"hi"}' }])

    h.dispose()
  })

  it('处理器抛错回 ACTION_FAILED，而不是成功的错误文本', async () => {
    const h = harness({
      onActionCall: async () => {
        throw new Error('file not found')
      },
    })
    const socket = await h.connected()

    socket.deliver({ type: 'req', id: 'call_2', method: Method.ActionCall, params: { action: 'read' } })
    await flush()

    const res = socket.sentMatching((f) => f.type === 'res' && f.id === 'call_2')[0]
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe(Code.ActionFailed)
    expect((res.error as { message: string }).message).toBe('file not found')

    h.dispose()
  })

  it('没有注册处理器时回 UNKNOWN_ACTION', async () => {
    const h = harness()
    const socket = await h.connected()

    socket.deliver({ type: 'req', id: 'call_3', method: Method.ActionCall, params: { action: 'read' } })
    await flush()

    const res = socket.sentMatching((f) => f.type === 'res' && f.id === 'call_3')[0]
    expect((res.error as { code: string }).code).toBe(Code.UnknownAction)

    h.dispose()
  })

  it('cancel 会 abort 处理器并回 ACTION_CANCELLED', async () => {
    let aborted = false
    const h = harness({
      onActionCall: (call) =>
        new Promise((_resolve, reject) => {
          call.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('cancelled'))
          })
        }),
    })
    const socket = await h.connected()

    socket.deliver({ type: 'req', id: 'call_4', method: Method.ActionCall, params: { action: 'read' } })
    await flush()
    socket.deliver({ type: 'req', id: 'cancel_1', method: Method.Cancel, params: { id: 'call_4' } })
    await flush()

    expect(aborted).toBe(true)
    const ack = socket.sentMatching((f) => f.type === 'res' && f.id === 'cancel_1')[0]
    expect((ack.result as { cancelled: boolean }).cancelled).toBe(true)

    const res = socket.sentMatching((f) => f.type === 'res' && f.id === 'call_4')[0]
    expect((res.error as { code: string }).code).toBe(Code.ActionCancelled)

    h.dispose()
  })

  it('结果超过限额时显式截断', async () => {
    const h = harness({ onActionCall: async () => 'x'.repeat(10_000) })
    const socket = await h.connected()

    socket.deliver({ type: 'req', id: 'call_5', method: Method.ActionCall, params: { action: 'read' } })
    await flush()

    const res = socket.sentMatching((f) => f.type === 'res' && f.id === 'call_5')[0]
    const content = (res.result as { content: { text: string }[] }).content
    expect(content).toHaveLength(2)
    expect(content[1].text).toMatch(/结果已截断/)

    h.dispose()
  })
})

describe('观测与动作表', () => {
  it('observe 发 observation 事件并带 seq', async () => {
    const h = harness()
    const socket = await h.connected()

    await h.client.observe({ text: '门铃响了', source: { kind: 'sensor', id: 'front-door' } })

    const event = socket.sentMatching((f) => f.type === 'event' && f.event === 'observation')[0]
    expect(event.seq).toBeGreaterThan(0)
    expect((event.data as { text: string }).text).toBe('门铃响了')
    expect((event.data as { source: { id: string } }).source.id).toBe('front-door')

    h.dispose()
  })

  it('updateCatalog 整体替换动作表', async () => {
    const h = harness({}, (frame, socket) => {
      if (frame.method === Method.CatalogUpdate) {
        socket.deliver({ type: 'res', id: frame.id, ok: true, result: { updated: true } })
        return
      }
      socket.deliver({ ...connectOk(), id: frame.id })
    })
    const socket = await h.connected()

    await h.client.updateCatalog([{ name: 'write', description: '写文件' }])

    const req = socket.sentMatching((f) => f.method === Method.CatalogUpdate)[0]
    expect((req.params as { actions: { name: string }[] }).actions).toEqual([
      { name: 'write', description: '写文件' },
    ])

    h.dispose()
  })

  it('非法动作表在发帧之前就失败', async () => {
    const h = harness()
    await h.connected()
    await expect(h.client.updateCatalog([{ name: 'a b' }])).rejects.toThrow(/invalid action name/)
    h.dispose()
  })
})

describe('心跳与关闭码', () => {
  it('收到 ping 回 pong', async () => {
    const h = harness()
    const socket = await h.connected()

    socket.deliver({ type: 'event', event: 'ping', seq: 1 })
    expect(socket.lastSent()).toMatchObject({ type: 'event', event: 'pong' })

    h.dispose()
  })

  it('4001 顶替：进入 evicted，不重连', async () => {
    const evicted: string[] = []
    const h = harness({ onEvicted: (by) => evicted.push(by ?? '') })
    const socket = await h.connected()

    socket.remoteClose(CloseCode.Evicted, 'evicted')
    expect(h.client.state).toBe('evicted')
    expect(evicted).toHaveLength(1)

    await new Promise((r) => setTimeout(r, 40))
    expect(h.client.state).toBe('evicted')
    h.dispose()
  })

  it('4004 协议违规：报致命错误，不重连', async () => {
    const fatal: Error[] = []
    const h = harness({ onFatal: (error) => fatal.push(error) })
    const socket = await h.connected()

    socket.remoteClose(CloseCode.ProtocolViolation, 'BAD_FRAME')
    expect(h.client.state).toBe('closed')
    expect(fatal[0]?.message).toMatch(/protocol violation/)

    await new Promise((r) => setTimeout(r, 40))
    expect(h.client.state).toBe('closed')
    h.dispose()
  })

  it('未连接时 updateCatalog 报错而不是静默入队', async () => {
    const restore = installFakeSocket(() => new FakeSocket())
    const client = new BodyClient({ url: 'ws://test/ws', apiKey: 'key', bodyId: 'desk-01' }, { logger })
    await expect(client.updateCatalog([])).rejects.toThrow(/not connected/)
    restore()
  })
})
