/**
 * pluginApiMembersSource.selftest.ts — 源码级防回归：`ctx` 成员表必须跟真实接口对齐
 *
 * 背景（2026-11 真实缺陷）：`plugin_dev_check` 用的成员表把 `ctx.files.readBytes` 与
 * `ctx.app.setChromeHidden` 漏在外面，而两者早就实现了（src/lib/plugin/files.ts / appApi.ts）。
 * 后果是**写法完全正确的插件被判为「用了宿主不存在的成员」**——校验器反过来误导作者，
 * 比不校验还糟。原因很朴素：表是手写的，接口改了没人记得回来同步。
 *
 * 这里按 `draggableSlot.selftest.ts` / `kbTestTaskRegistration.selftest.ts` 的思路做**源码级**检查：
 *   1. 从 `src/lib/plugin/*.ts` 与 `src/types/plugin.ts` 里把接口声明的成员名抠出来；
 *   2. 逐个比对 `src/shared/pluginApiMembers.ts` 的表 —— 接口里有、表里没有 = 缺陷；
 *   3. 用合成样例证明「检查器本身」抓得住这类漏项（一个永远通过的测试等于没有测试）。
 *
 * 用法：`node scripts/run-selftests.mjs pluginApiMembers`
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  CLIENT_CTX_MEMBERS,
  MAIN_CTX_MEMBERS,
  type PluginCtxMembers,
} from '@/shared/pluginApiMembers'

export interface PluginApiMembersCase {
  name: string
  ok: boolean
  detail?: string
}

/** 仓库根：自测产物在系统临时目录里，用 runner 注入的 NODE_PATH（<repo>/node_modules）反推 */
function repoRoot(): string {
  const np = process.env.NODE_PATH || ''
  return np ? resolve(np, '..') : process.cwd()
}

/**
 * 接口 → ctx 成员的对应关系。
 * `interface` 所在文件里声明的成员名，必须**全部**出现在成员表的对应项里
 * （表可以有接口没有的项吗？不可以 —— 那种情况同样意味着表在编造能力，所以两个方向都查，
 *   仅对下面 `RUNTIME_ONLY` 明确登记的少数项放行）。
 */
interface InterfaceMap {
  /** ctx 上的成员名 */
  member: string
  file: string
  iface: string
  /** 该成员表属于哪一半 */
  half: 'client' | 'main'
}

const MAPS: InterfaceMap[] = [
  { member: 'files', file: 'src/lib/plugin/files.ts', iface: 'PluginFilesApi', half: 'client' },
  { member: 'app', file: 'src/lib/plugin/appApi.ts', iface: 'PluginAppApi', half: 'client' },
  { member: 'llm', file: 'src/lib/plugin/llm.ts', iface: 'PluginLlmApi', half: 'client' },
  { member: 'tts', file: 'src/lib/plugin/tts.ts', iface: 'PluginTtsApi', half: 'client' },
  { member: 'locale', file: 'src/lib/plugin/locale.ts', iface: 'PluginLocaleApi', half: 'client' },
  { member: 'agent', file: 'src/lib/plugin/agent.ts', iface: 'PluginAgentApi', half: 'client' },
  // 注：ctx.slots / ctx.vue / ctx.on / ctx.effect / ctx.notify / ctx.plugin / ctx.config 的形状
  // 在 `src/lib/plugin/runtime.ts` 的 ClientPluginContext 里是**内联类型**（没有具名 interface），
  // 源码级比对无从下手。要覆盖它们，先把 ClientPluginContext 的对应字段抽成具名 interface。
  { member: 'host', file: 'src/types/plugin.ts', iface: 'PluginHostApi', half: 'main' },
  { member: 'storage', file: 'src/types/plugin.ts', iface: 'PluginStorage', half: 'main' },
]

/**
 * 成员表里允许出现的「接口声明不了」的项：运行时由宿主包装而成
 * （例如 `available` / `reason` 是运行时算出来的布尔与原因，接口里用属性声明，正则能抓到，故此处留空备用）。
 *
 * 键形如 `files.readBytes`。
 */
const RUNTIME_ONLY = new Set<string>([])

/** 从源码里抠出 `interface <name> { ... }` 的正文（大括号配平） */
export function extractInterfaceBody(source: string, iface: string): string | null {
  const re = new RegExp(`(?:export\\s+)?interface\\s+${iface}\\b[^{]*\\{`)
  const m = re.exec(source)
  if (!m) return null
  const start = m.index + m[0].length
  let depth = 1
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i)
    }
  }
  return null
}

/**
 * 接口正文里声明的一级成员名（方法 / 属性）。
 * 只在**大括号深度 0** 的行上取，避免把嵌套对象字面量的键也算成一级成员。
 */
export function declaredMembers(body: string): string[] {
  const out: string[] = []
  let depth = 0
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    const atTop = depth === 0
    const m = atTop && /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?]?\s*[(:<]/.exec(line)
    if (m) out.push(m[1])
    for (const ch of rawLine) {
      if (ch === '{' || ch === '(' || ch === '[') depth++
      else if (ch === '}' || ch === ')' || ch === ']') depth--
    }
  }
  return Array.from(new Set(out))
}

/** 双向比对：接口 ↔ 成员表。返回人类可读的差异描述（空数组 = 一致） */
export function diffInterfaceAgainstTable(
  member: string,
  declared: string[],
  table: PluginCtxMembers,
): string[] {
  const problems: string[] = []
  const listed = table[member]
  if (!Array.isArray(listed)) return [`成员表里 ${member} 不是子成员清单，无法比对`]
  const set = new Set(listed)
  for (const name of declared) {
    if (!set.has(name)) {
      problems.push(`接口声明了 ${member}.${name}，但成员表没有（→ plugin_dev_check 会误判正确写法）`)
    }
  }
  const declaredSet = new Set(declared)
  for (const name of listed) {
    if (!declaredSet.has(name) && !RUNTIME_ONLY.has(`${member}.${name}`)) {
      problems.push(`成员表列了 ${member}.${name}，但接口里没有声明（→ 表在编造能力）`)
    }
  }
  return problems
}

/** 返回 void，异常即不合规 */
function assertDeclaredMembersParses(): void {
  const sample = 'list(): Promise<void>\n  /** 注释 */\n  readBytes(path: string): Promise<void>\n'
  const got = declaredMembers(sample)
  if (got.join(',') !== 'list,readBytes') throw new Error(`declaredMembers 解析异常：${got.join(',')}`)
}

export function runPluginApiMembersSourceSelfTest(): PluginApiMembersCase[] {
  const cases: PluginApiMembersCase[] = []
  const root = repoRoot()

  for (const map of MAPS) {
    const table = map.half === 'client' ? CLIENT_CTX_MEMBERS : MAIN_CTX_MEMBERS
    let body: string | null = null
    try {
      body = extractInterfaceBody(readFileSync(join(root, map.file), 'utf8'), map.iface)
    } catch (e) {
      cases.push({ name: `${map.iface} 可读取`, ok: false, detail: String(e) })
      continue
    }
    if (body === null) {
      cases.push({
        name: `${map.iface}（${map.file}）能被解析`,
        ok: false,
        detail: '找不到接口定义 —— 接口被改名 / 搬走了？请同步 src/shared/pluginApiMembers.ts 与 MAPS',
      })
      continue
    }
    const declared = declaredMembers(body)
    const problems = diffInterfaceAgainstTable(map.member, declared, table)
    cases.push({
      name: `ctx.${map.member} 的成员表与 ${map.iface} 一致`,
      ok: problems.length === 0,
      detail: problems.length
        ? problems.join('\n  - ')
        : `${declared.length} 个成员：${declared.join(' / ')}`,
    })
  }

  // 元自测：证明比对逻辑抓得住「接口有、表没有」与「表有、接口没有」
  try {
    assertDeclaredMembersParses()
    cases.push({ name: 'meta: 接口成员解析正确（区分方法 / 属性 / 注释）', ok: true })
  } catch (e) {
    cases.push({ name: 'meta: 接口成员解析正确（区分方法 / 属性 / 注释）', ok: false, detail: String(e) })
  }

  const synthetic = diffInterfaceAgainstTable('files', ['pickFiles', 'readBytes'], { files: ['pickFiles'] })
  cases.push({
    name: 'meta: 抓得住「接口有 readBytes、表里没有」（本次修复的真实缺陷）',
    ok: synthetic.length === 1 && synthetic[0].includes('readBytes'),
    detail: synthetic.join('；'),
  })

  const synthetic2 = diffInterfaceAgainstTable('files', ['pickFiles'], { files: ['pickFiles', 'ghostMember'] })
  cases.push({
    name: 'meta: 抓得住「表里有、接口没有」的编造成员',
    ok: synthetic2.length === 1 && synthetic2[0].includes('ghostMember'),
    detail: synthetic2.join('；'),
  })

  cases.push({
    name: 'meta: 一致的接口与表不报问题',
    ok: diffInterfaceAgainstTable('files', ['pickFiles'], { files: ['pickFiles'] }).length === 0,
  })

  return cases
}

/** 命令行入口（run-selftests.mjs 走 run + metaRun） */
export function logPluginApiMembersSourceSelfTest(): boolean {
  const cases = runPluginApiMembersSourceSelfTest()
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail.split('\n').join('\n      ')}`)
  }
  return cases.every((c) => c.ok)
}
