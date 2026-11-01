import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Code, PROTOCOL, assertValidActions, isValidActionName, type Frame } from '../src/proto.js'

/**
 * 一致性语料住在服务端仓（规范的事实来源），这里直接读它，绝不复制一份。
 * 用的是与 go.work 相同的「同级 checkout」约定：workspace/ailo 与 workspace/ailo-sdk 并排。
 *
 * 这个文件是协议的第二个实现：它不看服务端代码，只按规范判断每帧该被判成什么。
 * 两边对同一份语料得出同一组错误码，才算协议没有漂移。
 */
const CORPUS = fileURLToPath(
  new URL('../../../../ailo/docs/protocol/conformance-body-1.json', import.meta.url),
)

interface Vector {
  name: string
  direction: 'c2s' | 's2c'
  as?: string
  frame: unknown
  expectError?: { code: string }
}

interface Corpus {
  protocol: string
  frames: Vector[]
}

const available = fs.existsSync(CORPUS)
const corpus: Corpus | null = available ? (JSON.parse(fs.readFileSync(CORPUS, 'utf8')) as Corpus) : null

const C2S_METHODS = new Set(['connect', 'catalog.update', 'cancel'])
const S2C_METHODS = new Set(['action.call', 'cancel'])

/** 返回该帧应产生的错误码；null 表示合法。规则与规范 §2/§3/§4/§5 一一对应。 */
function classify(frame: unknown, direction: 'c2s' | 's2c'): string | null {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return Code.BadFrame
  const f = frame as Frame

  if (f.type !== 'req' && f.type !== 'res' && f.type !== 'event') return Code.BadFrame

  if (f.type === 'req') {
    if (!f.id || !f.method) return Code.BadFrame
    const allowed = direction === 'c2s' ? C2S_METHODS : S2C_METHODS
    if (!allowed.has(f.method)) return Code.UnsupportedMethod
    return classifyRequest(f)
  }

  if (f.type === 'res') {
    if (!f.id) return Code.BadFrame
    if (typeof f.ok !== 'boolean') return Code.BadFrame
    if (f.ok && f.error) return Code.BadFrame
    if (!f.ok && !f.error?.code) return Code.BadFrame
    return classifyResult(f)
  }

  if (!f.event || f.id) return Code.BadFrame
  if (f.event === 'observation') return classifyObservation(f.data)
  return null
}

function classifyContent(parts: unknown): string | null {
  if (!Array.isArray(parts)) return Code.InvalidParams
  for (const part of parts as { type?: string; text?: string; id?: string; url?: string }[]) {
    switch (part.type) {
      case 'text':
        if (!part.text) return Code.InvalidParams
        break
      case 'blob':
        if (!part.id) return Code.InvalidParams
        break
      case 'url':
        if (!part.url) return Code.InvalidParams
        break
      default:
        return Code.InvalidParams
    }
  }
  return null
}

function classifyResult(frame: Frame): string | null {
  const result = (frame.result ?? {}) as Record<string, unknown>
  // 只有 action.call 的结果载荷有形状约束；其余结果只有字面字段。
  if ('content' in result) return classifyContent(result.content)
  return null
}

function classifyObservation(data: unknown): string | null {
  const obs = (data ?? {}) as { text?: string; content?: unknown }
  if (!obs.text && !obs.content) return Code.InvalidParams
  if (obs.content) return classifyContent(obs.content)
  return null
}

function classifyRequest(frame: Frame): string | null {
  const params = (frame.params ?? {}) as Record<string, unknown>

  switch (frame.method) {
    case 'connect': {
      if (params.protocol !== PROTOCOL) return Code.BadVersion
      if (!params.apiKey) return Code.Unauthorized
      if (typeof params.bodyId !== 'string' || !params.bodyId) return Code.InvalidParams
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,47}$/.test(params.bodyId)) return Code.InvalidParams
      try {
        assertValidActions(((params.actions as never[]) ?? []) as never)
      } catch {
        return Code.InvalidParams
      }
      return null
    }

    case 'catalog.update': {
      if (!Array.isArray(params.actions)) return Code.InvalidParams
      try {
        assertValidActions(params.actions as never)
      } catch {
        return Code.InvalidParams
      }
      return null
    }

    case 'action.call': {
      const action = params.action
      if (typeof action !== 'string' || !isValidActionName(action)) return Code.InvalidParams
      if (typeof params.deadlineMs === 'number' && params.deadlineMs < 0) return Code.InvalidParams
      return null
    }

    case 'cancel':
      return params.id ? null : Code.InvalidParams

    default:
      return Code.UnsupportedMethod
  }
}

describe.skipIf(!available)('协议一致性语料', () => {
  it('协议标识与实现一致', () => {
    expect(corpus!.protocol).toBe(PROTOCOL)
  })

  it('每条 vector 的判定与服务端一致（结构 + 参数级错误码）', () => {
    const mismatches = corpus!.frames
      .map((vector) => ({
        name: vector.name,
        want: vector.expectError?.code ?? null,
        got: classify(vector.frame, vector.direction),
      }))
      .filter((result) => result.want !== result.got)

    expect(mismatches).toEqual([])
  })

  it('合法帧里的动作名都满足 provider 标识符约束', () => {
    for (const vector of corpus!.frames) {
      if (vector.expectError) continue
      const frame = vector.frame as Frame
      const params = frame?.params as { actions?: { name: string }[] } | undefined
      const actions = [...(params?.actions ?? [])]
      if (frame?.method === 'catalog.update' && params) actions.push(...((params as { actions?: { name: string }[] }).actions ?? []))
      for (const action of actions) {
        expect(isValidActionName(action.name)).toBe(true)
        expect(action.name.includes(':')).toBe(false)
      }
    }
  })

  it('旧协议的方法名一律不认识', () => {
    for (const method of ['message.submit', 'registry.update', 'tool.call']) {
      expect(classify({ type: 'req', id: 'x', method, params: {} }, 'c2s')).toBe(Code.UnsupportedMethod)
    }
  })
})

if (!available) {
  console.error(`[conformance] 未找到语料 ${CORPUS}；请在 workspace 下保留同级 ailo checkout`)
}
