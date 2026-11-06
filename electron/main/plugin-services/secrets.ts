/**
 * secrets.ts — `ctx.secrets`（P3）
 *
 * 插件私有密钥：`safeStorage` 加密后落 `userData/plugins-data/<id>/secrets.bin`。
 * 界面半边永远拿不到明文（设置页只显示掩码）；插件卸载时由用户选择是否清数据（宿主
 * 的插件数据清理会一并删掉这个目录）。
 *
 * `safeStorage` 不可用（Linux 没有 keyring 等）时**fail-loud**，不退化成明文落盘。
 */

import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PluginServiceError } from '@/shared/pluginServices'
import type { PluginSecretsService } from '@/shared/pluginServices'
import type { PluginLogger } from '@/types/plugin'

interface SecretsFile {
  version: 1
  /** key → base64(encrypted bytes) */
  values: Record<string, string>
}

function secretsFileOf(pluginId: string): string {
  return path.join(app.getPath('userData'), 'plugins-data', pluginId, 'secrets.bin')
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function createPluginSecrets(pluginId: string, log: PluginLogger): PluginSecretsService {
  const file = secretsFileOf(pluginId)
  let cache: SecretsFile | null = null

  const load = (): SecretsFile => {
    if (cache) return cache
    try {
      if (!fs.existsSync(file)) {
        cache = { version: 1, values: {} }
        return cache
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SecretsFile>
      cache = {
        version: 1,
        values: parsed && typeof parsed.values === 'object' && parsed.values ? { ...parsed.values } : {},
      }
      return cache
    } catch (e) {
      // 坏文件不当空处理（会静默丢密钥）：报错让用户/作者看见
      throw new PluginServiceError(
        'PLUGIN_UNSUPPORTED',
        `密钥文件无法解析：${file}（${e instanceof Error ? e.message : String(e)}）`,
        { service: 'secrets' },
      )
    }
  }

  const ensureAvailable = (): void => {
    let available = false
    try {
      available = safeStorage.isEncryptionAvailable()
    } catch {
      available = false
    }
    if (!available) {
      throw new PluginServiceError(
        'PLUGIN_UNSUPPORTED',
        '系统加密不可用（safeStorage）：无法安全保存插件密钥，已拒绝写入（不会退化成明文）',
        { service: 'secrets' },
      )
    }
  }

  const save = (store: SecretsFile): void => {
    atomicWrite(file, JSON.stringify(store, null, 2))
    cache = store
  }

  return {
    async get(key: string): Promise<string | undefined> {
      const name = String(key || '').trim()
      if (!name) return undefined
      const enc = load().values[name]
      if (!enc) return undefined
      ensureAvailable()
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'))
      } catch (e) {
        log.warn(`[secrets] 解密失败（${name}）: ${e instanceof Error ? e.message : String(e)}`)
        throw new PluginServiceError('PLUGIN_UNSUPPORTED', `密钥解密失败：${name}`, { service: 'secrets' })
      }
    },

    async set(key: string, value: string): Promise<void> {
      const name = String(key || '').trim()
      if (!name) throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', '缺少 key', { service: 'secrets' })
      ensureAvailable()
      const store = load()
      const encrypted = safeStorage.encryptString(String(value ?? ''))
      save({ version: 1, values: { ...store.values, [name]: encrypted.toString('base64') } })
    },

    async delete(key: string): Promise<boolean> {
      const name = String(key || '').trim()
      if (!name) return false
      const store = load()
      if (!(name in store.values)) return false
      const values = { ...store.values }
      delete values[name]
      save({ version: 1, values })
      return true
    },

    async keys(): Promise<readonly string[]> {
      return Object.keys(load().values).sort()
    },
  }
}
