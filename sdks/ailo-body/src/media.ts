import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

import type { Logger } from './logger.js'
import type { ContentPart, HttpInfo } from './proto.js'
import { blobPart } from './proto.js'

/**
 * 上传结果。id 只在「上传用的那把端点密钥」的命名空间里有意义：
 * 协议没有跨端点传递 Blob 这回事，服务端也不做去重。
 */
export interface BlobRef {
  id: string
  mime: string
  name: string
  size: number
}

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
}

/** 按扩展名推断 MIME；未知一律 octet-stream。 */
export function inferMime(filePath: string): string {
  return EXT_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Blob 通道：协议里媒体的唯一落地方式。
 *
 * 握手返回的 `http` 是唯一定位依据——不要从 ws:// URL 反推 base，
 * 反代/子路径部署下那条路会静默跑到错误的主机上。
 */
export class BlobStore {
  constructor(
    private readonly http: HttpInfo,
    private readonly apiKey: string,
    private readonly logger?: Logger,
  ) {}

  /** Blob 的公网 URL（下载仍需 Authorization 头）。 */
  url(id: string): string {
    return `${this.http.base}${this.http.blobs}/${id.replace(/^\/+/, '')}`
  }

  /** 上传本地文件，返回服务端分配的 blob id。 */
  async upload(localPath: string): Promise<BlobRef> {
    const abs = path.resolve(localPath)
    const stat = await fs.promises.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) {
      throw new Error(`blob upload: file not found: ${abs}`)
    }

    const name = path.basename(abs)
    const mime = inferMime(abs)
    const raw = await fs.promises.readFile(abs)

    const form = new FormData()
    form.append('file', new Blob([raw], { type: mime }), name)

    const res = await fetch(`${this.http.base}${this.http.blobs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`blob upload failed: ${res.status} ${text}`.trim())
    }
    const body = (await res.json()) as BlobRef
    this.logger?.debug('blob_uploaded', { id: body.id, size: body.size, mime: body.mime })
    return { ...body, name: body.name || name, mime: body.mime || mime }
  }

  /** 上传并直接产出可放进 ContentPart 的 blob 引用。 */
  async part(localPath: string): Promise<ContentPart> {
    const ref = await this.upload(localPath)
    return blobPart({ id: ref.id, mime: ref.mime, name: ref.name, size: ref.size })
  }

  /** 下载 blob 到临时文件，返回本地绝对路径。 */
  async download(id: string): Promise<string> {
    const res = await fetch(this.url(id), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) {
      throw new Error(`blob download failed: ${res.status} (${id})`)
    }
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ailo-blob-'))
    const target = path.join(dir, path.basename(id) || `blob_${randomBytes(4).toString('hex')}`)
    await fs.promises.writeFile(target, Buffer.from(await res.arrayBuffer()))
    return target
  }
}
