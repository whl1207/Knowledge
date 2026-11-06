/**
 * attachments.ts — `ctx.attachments`（P3）
 *
 * 插件收发的图片/文件统一落 `userData/plugins-data/<id>/attachments/`：
 * - `save()` 接受内存字节或本机已有路径（路径必须是调用方拿得到的，读不到就报错）；
 * - 文件名会清洗（去路径分隔符 / 控制字符），**不覆盖**已有文件；
 * - 元数据落 `index.json`（name / mime / size / 时间），供 `list()` 使用。
 *
 * 上限 64MB：再大的文件应该走 `ctx.fs` 的用户授权目录，而不是插件附件目录。
 */

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PluginServiceError } from '@/shared/pluginServices'
import type { AttachmentInput, PluginAttachment, PluginAttachmentsService } from '@/shared/pluginServices'

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024

interface AttachmentEntry {
  id: string
  name: string
  mime: string
  size: number
  file: string
  createdAt: number
}

interface IndexFile {
  version: 1
  items: AttachmentEntry[]
}

function rootDirOf(pluginId: string): string {
  return path.join(app.getPath('userData'), 'plugins-data', pluginId, 'attachments')
}

function sanitizeName(raw: string): string {
  const base = path.basename(String(raw || 'file'))
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim()
  return cleaned || 'file'
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

export function createPluginAttachments(pluginId: string): PluginAttachmentsService {
  const root = rootDirOf(pluginId)
  const filesDir = path.join(root, 'files')
  const indexFile = path.join(root, 'index.json')
  let cache: IndexFile | null = null

  const load = (): IndexFile => {
    if (cache) return cache
    try {
      if (!fs.existsSync(indexFile)) {
        cache = { version: 1, items: [] }
        return cache
      }
      const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Partial<IndexFile>
      cache = {
        version: 1,
        items: Array.isArray(parsed.items)
          ? parsed.items.filter((x): x is AttachmentEntry => !!x && typeof x.id === 'string' && typeof x.file === 'string')
          : [],
      }
      return cache
    } catch {
      // 附件索引坏了不该让插件整个挂掉：从空索引开始（文件还在磁盘上，只是列表看不到）
      cache = { version: 1, items: [] }
      return cache
    }
  }

  const saveIndex = (index: IndexFile): void => {
    atomicWriteJson(indexFile, index)
    cache = index
  }

  const toPublic = (entry: AttachmentEntry): PluginAttachment => ({
    id: entry.id,
    name: entry.name,
    mime: entry.mime,
    size: entry.size,
    path: path.join(filesDir, entry.file),
  })

  return {
    async save(input: AttachmentInput): Promise<PluginAttachment> {
      if (!input || (!input.bytes && !input.path)) {
        throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'save 需要 bytes 或 path', { service: 'attachments' })
      }
      const name = sanitizeName(input.name)
      const mime = String(input.mime || 'application/octet-stream')
      let bytes: Buffer
      if (input.bytes) {
        bytes = Buffer.from(input.bytes)
      } else {
        try {
          bytes = fs.readFileSync(String(input.path))
        } catch (e) {
          throw new PluginServiceError(
            'PLUGIN_NOT_FOUND',
            `附件源文件读不到：${String(input.path)}（${e instanceof Error ? e.message : String(e)}）`,
            { service: 'attachments' },
          )
        }
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new PluginServiceError(
          'PLUGIN_INVALID_ARGUMENT',
          `附件过大（${bytes.length} 字节 > ${MAX_ATTACHMENT_BYTES}）：请用 ctx.fs 的用户授权目录`,
          { service: 'attachments' },
        )
      }
      const id = `att-${randomUUID()}`
      const file = `${id}__${name}`
      fs.mkdirSync(filesDir, { recursive: true })
      fs.writeFileSync(path.join(filesDir, file), bytes)
      const entry: AttachmentEntry = { id, name, mime, size: bytes.length, file, createdAt: Date.now() }
      const index = load()
      saveIndex({ version: 1, items: [entry, ...index.items] })
      return toPublic(entry)
    },

    async read(id: string): Promise<Uint8Array> {
      const entry = load().items.find((x) => x.id === String(id || '').trim())
      if (!entry) throw new PluginServiceError('PLUGIN_NOT_FOUND', `附件不存在：${id}`, { service: 'attachments' })
      try {
        return fs.readFileSync(path.join(filesDir, entry.file))
      } catch (e) {
        throw new PluginServiceError(
          'PLUGIN_NOT_FOUND',
          `附件文件丢失：${entry.name}（${e instanceof Error ? e.message : String(e)}）`,
          { service: 'attachments' },
        )
      }
    },

    async list(): Promise<readonly PluginAttachment[]> {
      return load().items.map(toPublic)
    },

    async remove(id: string): Promise<boolean> {
      const target = String(id || '').trim()
      const index = load()
      const entry = index.items.find((x) => x.id === target)
      if (!entry) return false
      try {
        fs.unlinkSync(path.join(filesDir, entry.file))
      } catch {
        /* 文件已不在：仍然清索引 */
      }
      saveIndex({ version: 1, items: index.items.filter((x) => x.id !== target) })
      return true
    },
  }
}
