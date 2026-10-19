/**
 * pluginManifest.ts — 插件清单解析与校验（纯函数，主进程与渲染进程共用）
 *
 * 清单写在插件包 `package.json` 的 `aikm` 字段（对齐 dsh 把 profile / bundle / client
 * 声明集中到 `dsh` 字段的做法）。**校验与展示共用同一实现**，避免「设置页说没问题、
 * 宿主加载却失败」这类双份判断。
 *
 * fail-loud：清单任何一项不合法都返回带 problem 的失败结果，不做静默兜底。
 */

import { isValidPluginId, brand, type PluginId } from '@/types/ids'
import {
  PLUGIN_HOST_API_VERSION,
  type AikmPluginManifest,
  type PluginClientDecl,
  type PluginPermission,
} from '@/types/plugin'
import { CORE_PLUGIN_SLOT_NAMES, unknownPluginSlots } from '@/shared/pluginSlots'

/** 清单所在的字段名与文件名 */
export const PLUGIN_MANIFEST_KEY = 'aikm'
export const PLUGIN_MANIFEST_FILE = 'package.json'

/** 受支持的权限类别（与 PluginHostApi 各项判权一一对应） */
export const SUPPORTED_PLUGIN_PERMISSIONS: readonly PluginPermission[] = ['fs', 'shell', 'net', 'agent', 'agent.run', 'llm', 'image']

export type ManifestProblem =
  | 'no-manifest'
  | 'bad-id'
  | 'bad-name'
  | 'bad-version'
  | 'bad-api-version'
  | 'bad-entry'
  | 'bad-permission'
  | 'bad-inject'
  | 'bad-declares'

export type ManifestCheck =
  | { ok: true; id: PluginId; manifest: AikmPluginManifest }
  | { ok: false; problem: ManifestProblem; message: string }

/**
 * 类型守卫（显式收窄）。
 * 主进程 tsconfig 未开 strictNullChecks，布尔字面量判别式的自动收窄不可靠，
 * 故统一用本守卫而不是 `if (!result.ok)`。
 */
export function isManifestFailure(result: ManifestCheck): result is Extract<ManifestCheck, { ok: false }> {
  return result.ok === false
}

/** 解析并校验清单。`fallbackId` 传目录名，用于 id 缺省与「id 必须与目录一致」的约束。 */
export function parseManifest(raw: unknown, fallbackId?: string): ManifestCheck {
  if (!raw || typeof raw !== 'object') {
    return fail('no-manifest', 'package.json 不是对象')
  }
  const source = (raw as Record<string, unknown>)[PLUGIN_MANIFEST_KEY]
  if (!source || typeof source !== 'object') {
    return fail('no-manifest', `package.json 缺少 "${PLUGIN_MANIFEST_KEY}" 字段`)
  }
  const m = source as Record<string, unknown>

  const idRaw = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : (fallbackId || '')
  if (!idRaw || !isValidPluginId(idRaw)) {
    return fail('bad-id', `插件 id 非法："${idRaw}"（须以小写字母/数字开头，仅含 [a-z0-9._-]）`)
  }
  if (fallbackId && idRaw !== fallbackId) {
    return fail('bad-id', `插件 id "${idRaw}" 与目录名 "${fallbackId}" 不一致`)
  }

  const version = typeof m.version === 'string' ? m.version.trim() : ''
  if (!version || !/^\d+(\.\d+)*([-+].+)?$/.test(version)) {
    return fail('bad-version', `version 非法："${version}"（须形如 1.0.0）`)
  }

  // apiVersion：宿主 API 版本区间（字符串，如 "^1"、">=1 <2"）。
  // 兼容写成数字的清单（模型 / 手写常见）：1 → "1"（等价于要求主版本 1）；2 → "2"，由 checkApiVersion 给出
  // 「插件要求 2，当前 1」这种准确报错，而不是含混的「必填」。
  const apiRaw = m.apiVersion
  const apiVersion = typeof apiRaw === 'string'
    ? apiRaw.trim()
    : (typeof apiRaw === 'number' && Number.isFinite(apiRaw) ? String(apiRaw) : '')
  if (!apiVersion) {
    if (apiRaw !== undefined && apiRaw !== null) {
      return fail(
        'bad-api-version',
        `apiVersion 必须是字符串或数字（推荐写字符串 "^1"），收到 ${JSON.stringify(apiRaw)}（${typeof apiRaw}）`,
      )
    }
    return fail('bad-api-version', 'apiVersion 必填（如 "^1"，表示要求宿主 API 主版本 1）')
  }
  if (parseComparatorSet(apiVersion) === 'unsupported') {
    return fail('bad-api-version', `apiVersion 语法不支持："${apiVersion}"（支持 ^ ~ > >= < <= = 与空格分隔的区间）`)
  }

  const main = typeof m.main === 'string' ? m.main.trim() : ''
  if (main && !isSafeRelativeEntry(main)) {
    return fail('bad-entry', `main 非法："${main}"（须为插件目录内的相对路径，不得含 .. 或绝对路径）`)
  }

  let client: PluginClientDecl | undefined
  if (m.client !== undefined) {
    if (!m.client || typeof m.client !== 'object') {
      return fail('bad-entry', 'client 必须是对象，如 { "entry": "client.mjs" }')
    }
    const c = m.client as Record<string, unknown>
    const entry = typeof c.entry === 'string' ? c.entry.trim() : ''
    if (!entry || !isSafeRelativeEntry(entry)) {
      return fail('bad-entry', `client.entry 非法："${entry}"（须为插件目录内的相对路径）`)
    }
    client = { entry }
    if (c.inject !== undefined) {
      if (!isStringArray(c.inject)) return fail('bad-inject', 'client.inject 必须是字符串数组')
      client.inject = dedupe(c.inject as string[])
    }
  }

  if (!main && !client) {
    return fail('bad-entry', 'main 与 client 至少声明一个（否则插件没有任何可加载的入口）')
  }

  let permissions: PluginPermission[] | undefined
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) return fail('bad-permission', 'permissions 必须是数组')
    const bad = m.permissions.filter((p) => !SUPPORTED_PLUGIN_PERMISSIONS.includes(p as PluginPermission))
    if (bad.length) {
      return fail('bad-permission', `不支持的权限：${bad.join(', ')}（可用：${SUPPORTED_PLUGIN_PERMISSIONS.join(' / ')}）`)
    }
    permissions = dedupe(m.permissions as string[]) as PluginPermission[]
  }

  let inject: string[] | undefined
  if (m.inject !== undefined) {
    if (!isStringArray(m.inject)) return fail('bad-inject', 'inject 必须是字符串数组')
    // inject 只放**宿主服务名**（tools / jobs / sessionLog 等）。写槽位名（panel.main / settings.tab …）
    // 是最常见的手写 / 模型混淆——直接点明该写在哪，而不是等界面半边注册时报「槽位未声明」。
    const slotInInject = (m.inject as string[]).filter((s) => CORE_PLUGIN_SLOT_NAMES.includes(s))
    if (slotInInject.length) {
      return fail(
        'bad-inject',
        `inject 里不能放槽位：${slotInInject.join(', ')}（inject 是宿主服务名，如 ["tools"]；槽位请写 declares.slots，如 { "declares": { "slots": ["${slotInInject[0]}"] } }）`,
      )
    }
    inject = dedupe(m.inject as string[])
  }

  let declares: AikmPluginManifest['declares']
  if (m.declares !== undefined) {
    if (!m.declares || typeof m.declares !== 'object') return fail('bad-declares', 'declares 必须是对象')
    const d = m.declares as Record<string, unknown>
    if (d.tools !== undefined && !isStringArray(d.tools)) return fail('bad-declares', 'declares.tools 必须是字符串数组')
    if (d.slots !== undefined && !isStringArray(d.slots)) return fail('bad-declares', 'declares.slots 必须是字符串数组')
    const unknown = unknownPluginSlots(d.slots)
    if (unknown.length) {
      return fail('bad-declares', `declares.slots 含未知槽位：${unknown.join(', ')}`)
    }
    declares = {}
    if (d.tools) declares.tools = dedupe(d.tools as string[])
    if (d.slots) declares.slots = dedupe(d.slots as string[])
  }

  return {
    ok: true,
    id: brand(idRaw, 'PluginId'),
    manifest: {
      id: idRaw,
      name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : idRaw,
      version,
      apiVersion,
      ...(main ? { main } : {}),
      ...(client ? { client } : {}),
      ...(inject ? { inject } : {}),
      ...(permissions ? { permissions } : {}),
      ...(typeof m.description === 'string' ? { description: m.description.trim() } : {}),
      ...(declares ? { declares } : {}),
    },
  }
}

/** 入口路径必须是插件目录内的相对路径（安全前提：不允许逃出插件目录） */
export function isSafeRelativeEntry(rel: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(rel)) return false // Windows 盘符
  if (rel.startsWith('/') || rel.startsWith('\\')) return false
  const parts = rel.split(/[\\/]+/)
  return parts.every((p) => p !== '..' && p !== '' && p !== '.')
}

/**
 * 校验清单要求的宿主 API 版本区间。
 * 返回扁平结构（ok + reason）而非判别式联合：主进程 tsconfig 未开 strictNullChecks，
 * 判别式联合的自动收窄不可靠，扁平结构在两个进程里都不需要收窄。
 */
export function checkApiVersion(
  range: string,
  hostVersion: number = PLUGIN_HOST_API_VERSION,
): { ok: boolean; reason: string | null } {
  const set = parseComparatorSet(range)
  if (set === 'unsupported') {
    return { ok: false, reason: `apiVersion 语法不支持："${range}"` }
  }
  if (set === 'any') return { ok: true, reason: null }
  const host = `${hostVersion}.0.0`
  const matched = set.every((c) => matchComparator(host, c))
  if (matched) return { ok: true, reason: null }
  return {
    ok: false,
    reason: `插件要求宿主 API ${range}，当前宿主 API 为 ${hostVersion}`,
  }
}

// ---------------------------------------------------------------------------
// 版本区间（只实现插件清单需要的子集：^ ~ > >= < <= = 与空格分隔的区间）
// ---------------------------------------------------------------------------

type ComparatorOp = '=' | '>' | '>=' | '<' | '<='
interface Comparator {
  op: ComparatorOp
  version: string
}

/** 解析结果：任意版本 / 比较器集合 / 语法不支持 */
function parseComparatorSet(range: string): Comparator[] | 'any' | 'unsupported' {
  const text = (range || '').trim()
  if (!text || text === '*' || text.toLowerCase() === 'x') return 'any'
  if (text.includes('||')) return 'unsupported'

  if (text.startsWith('^')) return caretSet(text.slice(1))
  if (text.startsWith('~')) return tildeSet(text.slice(1))

  const out: Comparator[] = []
  for (const token of text.split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*)$/.exec(token)
    if (!m) return 'unsupported'
    const op = (m[1] || '') as ComparatorOp | ''
    const version = m[2]
    if (op) {
      out.push({ op, version })
    } else {
      // 裸版本 = 前缀相等：`1` → 1.x.x，`1.2` → 1.2.x，`1.2.3` → 精确
      const parts = version.split('.')
      if (parts.length >= 3) {
        out.push({ op: '=', version })
      } else {
        out.push({ op: '>=', version })
        out.push({ op: '<', version: bumpPrefix(parts, parts.length - 1) })
      }
    }
  }
  return out.length ? out : 'unsupported'
}

/** `^1.2.3` → >=1.2.3 <2.0.0；`^0.2.3` → >=0.2.3 <0.3.0；`^0.0.3` → >=0.0.3 <0.0.4 */
function caretSet(base: string): Comparator[] | 'unsupported' {
  if (!/^\d+(\.\d+)*$/.test(base)) return 'unsupported'
  const parts = base.split('.').map((n) => parseInt(n, 10))
  if (parts.length === 1) {
    return [
      { op: '>=', version: `${parts[0]}.0.0` },
      { op: '<', version: `${parts[0] + 1}.0.0` },
    ]
  }
  if (parts[0] > 0) {
    return [
      { op: '>=', version: base },
      { op: '<', version: `${parts[0] + 1}.0.0` },
    ]
  }
  if (parts[1] > 0) {
    return [
      { op: '>=', version: base },
      { op: '<', version: `0.${parts[1] + 1}.0` },
    ]
  }
  const patch = parts[2] ?? 0
  return [
    { op: '>=', version: base },
    { op: '<', version: `0.0.${patch + 1}` },
  ]
}

/** `~1.2.3` → >=1.2.3 <1.3.0；`~1` → >=1.0.0 <2.0.0 */
function tildeSet(base: string): Comparator[] | 'unsupported' {
  if (!/^\d+(\.\d+)*$/.test(base)) return 'unsupported'
  const parts = base.split('.').map((n) => parseInt(n, 10))
  if (parts.length === 1) {
    return [
      { op: '>=', version: `${parts[0]}.0.0` },
      { op: '<', version: `${parts[0] + 1}.0.0` },
    ]
  }
  return [
    { op: '>=', version: base },
    { op: '<', version: `${parts[0]}.${parts[1] + 1}.0` },
  ]
}

/** 把前 `keep` 段保留、末段 +1，其余补 0：(['1'],1) → 2.0.0；(['1','2'],2) → 1.3.0 */
function bumpPrefix(parts: string[], keep: number): string {
  const nums = parts.map((n) => parseInt(n, 10))
  const head = nums.slice(0, keep)
  head[keep - 1] = (head[keep - 1] ?? 0) + 1
  while (head.length < 3) head.push(0)
  return head.slice(0, 3).join('.')
}

function matchComparator(candidate: string, c: Comparator): boolean {
  const cmp = compareVersions(candidate, c.version)
  switch (c.op) {
    case '=':
      return cmp === 0
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
  }
}

/** 数字段比较（忽略预发布后缀；三段不足补 0） */
export function compareVersions(a: string, b: string): number {
  const pa = numericParts(a)
  const pb = numericParts(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

function numericParts(v: string): number[] {
  return String(v)
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => parseInt(n, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

// ---------------------------------------------------------------------------

function fail(problem: ManifestProblem, message: string): ManifestCheck {
  return { ok: false, problem, message }
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '')
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)))
}
