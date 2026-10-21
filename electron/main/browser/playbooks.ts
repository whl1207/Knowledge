/**
 * playbooks.ts — 可执行的站点 Playbook（对齐 ego-lite 的 per-site tools）
 *
 * 与 learnings（纯 Markdown 笔记）不同：Playbook 是一段可在 browser_run 同一套
 * `browser.*` API 里执行的脚本。安全模型：
 * - Agent 只能保存/读取/运行；**不能批准**；
 * - 新保存或代码变更一律 approved=false，必须用户在「设置 → Playbook」里查看代码并批准；
 * - 只有 approved=true 才能被 browser_playbook_run 执行；
 * - 代码在 node:vm 中运行，只能用 browser/console/sleep，无 require/process/fs。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SitePlaybook {
  host: string
  name: string
  slug: string
  description: string
  code: string
  approved: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  lastRunOk?: boolean
  lastRunDetail?: string
  useCount: number
}

export interface SitePlaybookMeta {
  host: string
  name: string
  slug: string
  description: string
  approved: boolean
  updatedAt: number
  lastRunAt?: number
  lastRunOk?: boolean
  lastRunDetail?: string
  useCount: number
  bytes: number
}

interface HostFile { host: string; playbooks: SitePlaybook[] }

const MAX_CODE = 50_000
const MAX_PER_HOST = 50

function baseDir(): string {
  const d = join(app.getPath('userData'), 'browser-playbooks')
  try { mkdirSync(d, { recursive: true }) } catch { /* 忽略 */ }
  return d
}

export function normalizePlaybookHost(input: string, url?: string): string {
  let raw = String(input || '').trim()
  if (!raw && url) {
    try { raw = new URL(String(url)).hostname } catch { raw = '' }
  }
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/[^a-z0-9.\-_:]/g, '_')
    .slice(0, 120) || 'unknown-site'
}

export function slugifyPlaybookName(name: string): string {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || `playbook-${Date.now().toString(36)}`
}

function hostFile(host: string): string {
  return join(baseDir(), `${normalizePlaybookHost(host)}.json`)
}

function readHost(host: string): HostFile {
  const h = normalizePlaybookHost(host)
  const file = hostFile(h)
  if (!existsSync(file)) return { host: h, playbooks: [] }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { host: h, playbooks: Array.isArray(data?.playbooks) ? data.playbooks : [] }
  } catch {
    return { host: h, playbooks: [] }
  }
}

function writeHost(data: HostFile): void {
  const file = hostFile(data.host)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

function find(data: HostFile, nameOrSlug: string): SitePlaybook | undefined {
  const key = String(nameOrSlug || '').trim().toLowerCase()
  const slug = slugifyPlaybookName(nameOrSlug)
  return data.playbooks.find((p) => p.slug === slug || p.name.toLowerCase() === key)
}

export function saveSitePlaybook(input: { host?: string; url?: string; name: string; description?: string; code: string }): {
  ok: boolean
  host: string
  name?: string
  slug?: string
  approved?: boolean
  updated?: boolean
  error?: string
} {
  const host = normalizePlaybookHost(input.host || '', input.url)
  const name = String(input.name || '').trim().slice(0, 80)
  const code = String(input.code || '').trim()
  if (!name) return { ok: false, host, error: 'name 不能为空' }
  if (!code) return { ok: false, host, error: 'code 不能为空' }
  if (code.length > MAX_CODE) return { ok: false, host, error: `code 过长（上限 ${MAX_CODE} 字符）` }
  const data = readHost(host)
  const slug = slugifyPlaybookName(name)
  const now = Date.now()
  const existing = data.playbooks.find((p) => p.slug === slug)
  if (existing) {
    const changed = existing.code !== code
    existing.name = name
    existing.description = String(input.description || existing.description || '').slice(0, 500)
    existing.code = code
    existing.updatedAt = now
    // 代码变化必须重新批准；只改描述不影响已批准状态
    if (changed) existing.approved = false
    writeHost(data)
    return { ok: true, host, name, slug, approved: existing.approved, updated: true }
  }
  if (data.playbooks.length >= MAX_PER_HOST) {
    return { ok: false, host, error: `每个站点最多 ${MAX_PER_HOST} 个 Playbook` }
  }
  data.playbooks.push({
    host, name, slug, description: String(input.description || '').slice(0, 500),
    code, approved: false, createdAt: now, updatedAt: now, useCount: 0,
  })
  writeHost(data)
  return { ok: true, host, name, slug, approved: false, updated: false }
}

export function listSitePlaybooks(host?: string): SitePlaybookMeta[] {
  const hosts = host ? [normalizePlaybookHost(host)] : (() => {
    try { return readdirSync(baseDir()).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) } catch { return [] }
  })()
  const out: SitePlaybookMeta[] = []
  for (const h of hosts) {
    for (const p of readHost(h).playbooks) {
      out.push({
        host: p.host, name: p.name, slug: p.slug, description: p.description,
        approved: !!p.approved, updatedAt: p.updatedAt,
        ...(p.lastRunAt ? { lastRunAt: p.lastRunAt } : {}),
        ...(p.lastRunOk !== undefined ? { lastRunOk: p.lastRunOk } : {}),
        ...(p.lastRunDetail ? { lastRunDetail: p.lastRunDetail } : {}),
        useCount: p.useCount || 0, bytes: Buffer.byteLength(p.code, 'utf8'),
      })
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSitePlaybook(host: string, nameOrSlug: string): { ok: boolean; host: string; playbook?: SitePlaybook; error?: string } {
  const h = normalizePlaybookHost(host)
  const p = find(readHost(h), nameOrSlug)
  return p ? { ok: true, host: h, playbook: p } : { ok: false, host: h, error: 'Playbook 不存在' }
}

export function approveSitePlaybook(host: string, nameOrSlug: string, approved: boolean): { ok: boolean; host: string; playbook?: SitePlaybook; error?: string } {
  const h = normalizePlaybookHost(host)
  const data = readHost(h)
  const p = find(data, nameOrSlug)
  if (!p) return { ok: false, host: h, error: 'Playbook 不存在' }
  p.approved = !!approved
  p.updatedAt = Date.now()
  writeHost(data)
  return { ok: true, host: h, playbook: p }
}

export function deleteSitePlaybook(host: string, nameOrSlug: string): { ok: boolean; host: string; error?: string } {
  const h = normalizePlaybookHost(host)
  const data = readHost(h)
  const p = find(data, nameOrSlug)
  if (!p) return { ok: false, host: h, error: 'Playbook 不存在' }
  data.playbooks = data.playbooks.filter((x) => x.slug !== p.slug)
  if (data.playbooks.length) writeHost(data)
  else { try { rmSync(hostFile(h), { force: true }) } catch { /* 忽略 */ } }
  return { ok: true, host: h }
}

export function markSitePlaybookRun(host: string, nameOrSlug: string, ok: boolean, detail: string): void {
  const h = normalizePlaybookHost(host)
  const data = readHost(h)
  const p = find(data, nameOrSlug)
  if (!p) return
  p.useCount = (p.useCount || 0) + 1
  p.lastRunAt = Date.now()
  p.lastRunOk = !!ok
  p.lastRunDetail = String(detail || '').slice(0, 300)
  try { writeHost(data) } catch { /* 忽略 */ }
}
