/**
 * learnings.ts — 站点经验（site learnings）本地存储
 *
 * 对齐 ego-lite 的 per-site learnings：把"这个站点怎么操作"沉淀成可复用的 Markdown，
 * 下次同站点任务先读经验，减少重复探索。文件按 host 存到 userData/browser-learnings/<host>.md。
 *
 * 只存文本，不存 Cookie/密码；写入由 Agent 触发，用户可在设置页查看/删除。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SiteLearningMeta {
  host: string
  title: string
  updatedAt: number
  bytes: number
  preview: string
}

const MAX_FILE_BYTES = 200_000

function dir(): string {
  const d = join(app.getPath('userData'), 'browser-learnings')
  try { mkdirSync(d, { recursive: true }) } catch { /* 忽略 */ }
  return d
}

function safeHost(input: string): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/[^a-z0-9.\-_:]/g, '_')
    .slice(0, 120) || 'unknown-site'
}

export function normalizeLearningHost(input: string, url?: string): string {
  if (input) return safeHost(input)
  try {
    const u = new URL(String(url || ''))
    return safeHost(u.hostname)
  } catch {
    return 'unknown-site'
  }
}

export function saveSiteLearning(input: { host?: string; url?: string; title?: string; notes: string }): { ok: boolean; host: string; path?: string; error?: string } {
  const host = normalizeLearningHost(input.host || '', input.url)
  const notes = String(input.notes || '').trim()
  if (!notes) return { ok: false, host, error: 'notes 不能为空' }
  const title = String(input.title || '经验').trim().slice(0, 120)
  const file = join(dir(), `${host}.md`)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const block = [
    `## ${title} · ${stamp}`,
    input.url ? `- 页面：${input.url}` : '',
    '',
    notes,
    '',
  ].filter((x, i) => x !== '' || i === 2).join('\n')
  let prev = ''
  try { prev = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { /* 忽略 */ }
  if (prev.length + block.length > MAX_FILE_BYTES) {
    prev = prev.slice(-Math.floor(MAX_FILE_BYTES / 2))
  }
  const header = prev ? '' : `# ${host}\n\n`
  try {
    writeFileSync(file, header + prev + block, 'utf8')
    return { ok: true, host, path: file }
  } catch (err: any) {
    return { ok: false, host, error: err?.message || String(err) }
  }
}

export function listSiteLearnings(): SiteLearningMeta[] {
  const base = dir()
  let names: string[] = []
  try { names = readdirSync(base).filter((n) => n.endsWith('.md')) } catch { return [] }
  const out: SiteLearningMeta[] = []
  for (const name of names) {
    const p = join(base, name)
    try {
      const st = statSync(p)
      const text = readFileSync(p, 'utf8')
      const title = (text.match(/^######?\s+(.+)$/m)?.[1] || name.replace(/\.md$/, '')).slice(0, 100)
      out.push({
        host: name.replace(/\.md$/, ''),
        title,
        updatedAt: st.mtimeMs,
        bytes: st.size,
        preview: text.replace(/^#.*$/gm, '').trim().slice(0, 180),
      })
    } catch { /* 忽略坏文件 */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSiteLearning(input: string): { ok: boolean; host: string; content?: string; error?: string } {
  const host = normalizeLearningHost(input)
  const file = join(dir(), `${host}.md`)
  if (!existsSync(file)) return { ok: false, host, error: `没有 ${host} 的经验记录` }
  try { return { ok: true, host, content: readFileSync(file, 'utf8') } }
  catch (err: any) { return { ok: false, host, error: err?.message || String(err) } }
}

export function deleteSiteLearning(input: string): { ok: boolean; host: string; error?: string } {
  const host = normalizeLearningHost(input)
  const file = join(dir(), `${host}.md`)
  if (!existsSync(file)) return { ok: false, host, error: '记录不存在' }
  try { rmSync(file, { force: true }); return { ok: true, host } }
  catch (err: any) { return { ok: false, host, error: err?.message || String(err) } }
}
