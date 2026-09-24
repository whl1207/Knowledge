/**
 * credentials.ts — 凭据接缝（路线图 2.3 的最小落地）
 *
 * 目标：让 API key **不再散落在 localStorage / 渲染进程配置里**，而是收进
 * 主进程受保护的 `userData/credentials.json`，配置中只存 `apiKeyRef`（引用名）。
 *
 * 设计（对齐 DSH 持久化/凭据接缝）：
 * - **值只存主进程**：渲染进程只能看到脱敏的 `CredentialInfo`（name + 掩码），
 *   永远拿不到明文（`resolveValue` 仅主进程内部调用）；
 * - **向后兼容**：渲染进程仍可传内联 `api_key`（旧配置/旧逻辑不变）；
 *   新增了 `apiKeyRef` 字段的配置，则在 agent 循环请求前由主进程解析成明文；
 * - 文件权限：credentials.json 写入时设置为仅当前用户可读写（0600 语义）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

export interface CredentialInfo {
  name: string
  /** 脱敏展示：sk-****abcd */
  masked: string
  createdAt: number
  updatedAt: number
}

interface CredentialEntry {
  value: string
  createdAt: number
  updatedAt: number
}

class CredentialStore {
  private file: string | null = null
  private entries = new Map<string, CredentialEntry>()

  private ensureFile(): string {
    if (!this.file) {
      this.file = path.join(app.getPath('userData'), 'credentials.json')
    }
    return this.file
  }

  load(): void {
    try {
      const file = this.ensureFile()
      if (!fs.existsSync(file)) return
      const raw = fs.readFileSync(file, 'utf-8')
      const data = JSON.parse(raw)
      if (data && typeof data === 'object') {
        this.entries = new Map()
        for (const [name, entry] of Object.entries(data as Record<string, CredentialEntry>)) {
          if (entry && typeof entry.value === 'string') {
            this.entries.set(name, {
              value: entry.value,
              createdAt: entry.createdAt || Date.now(),
              updatedAt: entry.updatedAt || Date.now(),
            })
          }
        }
      }
    } catch (e) {
      console.error('[credentials] 加载失败:', e)
    }
  }

  private persist(): void {
    try {
      const file = this.ensureFile()
      const data: Record<string, CredentialEntry> = {}
      for (const [name, entry] of this.entries) {
        data[name] = entry
      }
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
    } catch (e) {
      console.error('[credentials] 保存失败:', e)
    }
  }

  /** 保存凭据（覆盖同名）。 */
  set(name: string, value: string): CredentialInfo {
    const now = Date.now()
    const existing = this.entries.get(name)
    this.entries.set(name, { value, createdAt: existing?.createdAt || now, updatedAt: now })
    this.persist()
    return this.mask(name)
  }

  /** 删除凭据。 */
  delete(name: string): boolean {
    const ok = this.entries.delete(name)
    if (ok) this.persist()
    return ok
  }

  /** 列出全部凭据（脱敏，供 UI）。 */
  list(): CredentialInfo[] {
    return Array.from(this.entries.entries()).map(([name, e]) => this.mask(name, e))
  }

  /** 取明文（仅主进程内部调用；agent 循环请求前解析 apiKeyRef）。 */
  resolveValue(name: string): string | null {
    return this.entries.get(name)?.value ?? null
  }

  private mask(name: string, e?: CredentialEntry): CredentialInfo {
    const entry = e || this.entries.get(name)
    const value = entry?.value || ''
    const masked = value.length <= 4 ? '****' : `${value.slice(0, 3)}****${value.slice(-4)}`
    return {
      name,
      masked,
      createdAt: entry?.createdAt || Date.now(),
      updatedAt: entry?.updatedAt || Date.now(),
    }
  }
}

export const credentialStore = new CredentialStore()
