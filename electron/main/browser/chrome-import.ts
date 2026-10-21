/**
 * chrome-import.ts — 从本机 Chrome / Edge 导入登录态（Cookie），仅 Windows 优先实现
 *
 * 设计约束：
 * - 必须由用户显式触发（设置页按钮），不做后台扫描；
 * - 只读取 Cookie 数据库，复制到临时目录后再用 sql.js 打开（避免锁库）；
 * - Chrome v10/v11 的 AES-GCM 密钥用 DPAPI 解出；v20（App-Bound）无法在不提升权限的情况下解密，明确跳过并计数；
 * - 不记录/回传任何 Cookie 值，只返回数量与失败原因。
 *
 * 其他平台返回 unsupported（macOS Keychain / Linux libsecret 的密钥获取留待后续）。
 */
import { session } from 'electron'
import { execFileSync } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// sql.js 是 CJS/UMD 工厂；主进程产物是 ESM，不能用裸 require，改用动态 import 互操作
async function loadSqlJs(): Promise<(config?: { locateFile?: (f: string) => string }) => Promise<any>> {
  const mod: any = await import('sql.js')
  return (mod?.default || mod) as any
}

export type ChromiumKind = 'chrome' | 'edge'

export interface ChromeImportResult {
  ok: boolean
  browser: ChromiumKind | string
  imported: number
  skipped: number
  failed: number
  profile?: string
  error?: string
  note?: string
}

interface CookieRow {
  host_key: string
  name: string
  value: string
  encrypted_value: Uint8Array | null
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
}

function userDataRoot(kind: ChromiumKind): string {
  const local = process.env.LOCALAPPDATA || ''
  return kind === 'edge'
    ? join(local, 'Microsoft', 'Edge', 'User Data')
    : join(local, 'Google', 'Chrome', 'User Data')
}

function findProfileDb(root: string): { profile: string; db: string } | null {
  const candidates: string[] = []
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))
    const cache = state?.profile?.info_cache || {}
    for (const name of Object.keys(cache)) candidates.push(name)
  } catch { /* 没有 Local State 就退回 Default */ }
  if (!candidates.includes('Default')) candidates.unshift('Default')
  for (const p of candidates) {
    for (const rel of [join('Network', 'Cookies'), 'Cookies']) {
      const db = join(root, p, rel)
      if (existsSync(db)) return { profile: p, db }
    }
  }
  return null
}

function dpapiUnprotect(blob: Buffer): Buffer {
  const b64 = blob.toString('base64')
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${b64}')`,
    "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    '[Convert]::ToBase64String($d)',
  ].join('; ')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  }).trim()
  return Buffer.from(out, 'base64')
}

function aesKeyFromLocalState(root: string): Buffer | null {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))
    const enc = Buffer.from(String(state?.os_crypt?.encrypted_key || ''), 'base64')
    if (enc.length <= 5) return null
    // 前缀固定为 "DPAPI"
    const key = dpapiUnprotect(enc.subarray(5))
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

function decryptCookie(enc: Uint8Array | null, key: Buffer | null): { value?: string; v20?: boolean } {
  if (!enc || enc.length === 0) return { value: '' }
  const buf = Buffer.from(enc)
  const prefix = buf.subarray(0, 3).toString('latin1')
  if (prefix === 'v10' || prefix === 'v11') {
    if (!key) return {}
    try {
      const nonce = buf.subarray(3, 15)
      const tag = buf.subarray(buf.length - 16)
      const ct = buf.subarray(15, buf.length - 16)
      const d = createDecipheriv('aes-256-gcm', key, nonce)
      d.setAuthTag(tag)
      return { value: d.update(ct, undefined, 'utf8') + d.final('utf8') }
    } catch {
      return {}
    }
  }
  if (prefix === 'v20') return { v20: true }
  // 早期未加密的明文
  return { value: buf.toString('utf8') }
}

function chromeTimeToUnix(expiresUtc: number): number | undefined {
  const n = Number(expiresUtc) || 0
  if (!n) return undefined // session cookie
  const seconds = n / 1_000_000 - 11_644_473_600
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return seconds
}

function sameSiteOf(v: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (v === 1) return 'no_restriction'
  if (v === 2) return 'lax'
  if (v === 3) return 'strict'
  return 'unspecified'
}

export async function importChromiumLogins(kind: ChromiumKind): Promise<ChromeImportResult> {
  const browser = kind
  if (process.platform !== 'win32') {
    return { ok: false, browser, imported: 0, skipped: 0, failed: 0, error: '当前仅支持 Windows 的 Chrome/Edge 登录态导入' }
  }
  const root = userDataRoot(kind)
  if (!existsSync(root)) {
    return { ok: false, browser, imported: 0, skipped: 0, failed: 0, error: `没有找到 ${kind === 'edge' ? 'Edge' : 'Chrome'} 用户数据目录` }
  }
  const found = findProfileDb(root)
  if (!found) {
    return { ok: false, browser, imported: 0, skipped: 0, failed: 0, error: '没有找到 Cookie 数据库（可能从未登录过）' }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'aikm-chrome-cookie-'))
  const tmpDb = join(tmp, 'Cookies')
  try {
    copyFileSync(found.db, tmpDb)
    // WAL 里可能还有未合并的写入
    for (const ext of ['-wal', '-shm']) {
      try { if (existsSync(found.db + ext)) copyFileSync(found.db + ext, tmpDb + ext) } catch { /* 忽略 */ }
    }

    const key = aesKeyFromLocalState(root)
    const initSqlJs = await loadSqlJs()
    const SQL = await initSqlJs()
    const db = new SQL.Database(readFileSync(tmpDb))
    const stmt = db.prepare('SELECT host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite FROM cookies')
    const rows: CookieRow[] = []
    while (stmt.step()) rows.push(stmt.getAsObject() as CookieRow)
    stmt.free()
    db.close()

    const ses = session.fromPartition('persist:browser-agent')
    let imported = 0
    let skipped = 0
    let failed = 0
    let v20 = 0
    const now = Date.now() / 1000
    for (const row of rows) {
      const host = String(row.host_key || '')
      const name = String(row.name || '')
      if (!host || !name) { skipped++; continue }
      const exp = chromeTimeToUnix(row.expires_utc)
      if (exp !== undefined && exp <= now) { skipped++; continue }
      const dec = decryptCookie(row.encrypted_value, key)
      if (dec.v20) { v20++; skipped++; continue }
      const value = dec.value !== undefined ? dec.value : String(row.value || '')
      if (dec.value === undefined && !row.value) { skipped++; continue }
      const secure = !!row.is_secure
      const domain = host.startsWith('.') ? host.slice(1) : host
      const url = `${secure ? 'https' : 'http'}://${domain}${row.path || '/'}`
      try {
        await ses.cookies.set({
          url,
          name,
          value,
          domain: host,
          path: row.path || '/',
          secure,
          httpOnly: !!row.is_httponly,
          ...(exp ? { expirationDate: exp } : {}),
          sameSite: sameSiteOf(Number(row.samesite)),
        })
        imported++
      } catch {
        failed++
      }
    }
    return {
      ok: true,
      browser,
      imported,
      skipped,
      failed,
      profile: found.profile,
      ...(v20 ? { note: `${v20} 条 Cookie 使用 Chrome 新版 App-Bound 加密（v20），无法直接导入；可在 Chrome 中退出该站点后重试，或在应用内重新登录。` } : {}),
    }
  } catch (err: any) {
    return { ok: false, browser, imported: 0, skipped: 0, failed: 0, error: err?.message || String(err) }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}
