// electron/main/plugin-dev/plugin-dev-check.ts
// 内置 MCP 服务 builtin-plugin-dev 的自检工具：plugin_dev_check
//
// 为什么需要它：模型（尤其体量小的）写完插件后经常在「清单字段类型 / 槽位声明 / 入口导出形状 /
// 界面半边用了 import」这些点上翻车，而用户只有在「插件管理」里看到一句报错才知道。
// 这个工具让模型在交付前**自己**跑一遍宿主真实的校验逻辑（与设置页同一份 parseManifest），
// 拿到可操作的清单并把问题改掉，再回报用户。
//
// 检查分三层：
// 1. **清单与入口**：目录名 → 插件 id、aikm 清单（字段 / apiVersion / 槽位 / 权限 / 入口存在）；
// 2. **静态契约**：两半边的 ctx 成员（表在 src/shared/pluginApiMembers.ts）与「能力 → 权限」交叉校验
//    （用了 ctx.fs / ctx.llm / ctx.image / ctx.agent.run / ctx.host.runShell … 却没在清单里声明）；
// 3. **静默陷阱**：漏 await、pickFiles 返回形状、ResizeObserver、locale 的 ref 当字符串、
//    写错的事件类型（不报错但永远不触发）；老入口（ctx.files 读写 / ctx.host 读写）只给「建议迁移」提示。
//
// 只读：不写任何文件。

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  PLUGIN_MANIFEST_FILE,
  checkApiVersion,
  isManifestFailure,
  isSafeRelativeEntry,
  parseManifest,
} from '@/shared/pluginManifest'
import { CLIENT_CTX_ABSENT, CLIENT_CTX_MEMBERS, MAIN_CTX_ABSENT, MAIN_CTX_MEMBERS, checkCtxUsage } from '@/shared/pluginApiMembers'
import { PLUGIN_EVENT_TYPES } from '@/lib/plugin/events'
import type { PluginPermission } from '@/types/plugin'
import { pluginHost } from '../plugin-host'
import { isValidPluginId } from '@/types/ids'

/** 客户端半边源码的检查上限（超大文件只读前 512KB，足够判断 import / 模板 / 槽位注册） */
const CLIENT_SOURCE_MAX = 512 * 1024


/** 界面半边：检查 `ctx.*` 用法 */
function checkClientCtxUsage(code: string): string[] {
  return checkCtxUsage(code, CLIENT_CTX_MEMBERS, CLIENT_CTX_ABSENT)
}

/** `ctx.files` 上返回 Promise 的成员：忘了 await 时读属性会得到 undefined */
const ASYNC_FILES_MEMBERS = [
  'pickFiles', 'pickDirectory', 'pickWritableDirectory', 'list', 'readText', 'readBase64', 'readBytes', 'readSheet',
  'renderPdfPage', 'openInApp', 'writeText', 'remove',
]

/** `ctx.fs` 上返回 Promise 的成员（两级成员 `sheet.read` 另行判断） */
const ASYNC_FS_MEMBERS = ['stat', 'readText', 'readBytes', 'readBase64', 'listDir', 'writeText', 'editText', 'remove']

/**
 * 找出「调用了异步成员却没写 await」的成员名（同一成员只报一次，够定位了）。
 * `.then(...)` 链式写法放行；取「当前语句」片段而不是整段代码，避免上一行的 await 误放行。
 */
function findMissingAwait(code: string, api: 'files' | 'fs', members: readonly string[]): string[] {
  const missing: string[] = []
  const beforeSegment = (at: number): string => {
    const before = code.slice(0, at)
    const segStart = Math.max(
      0,
      ...[';', '\n', '{', '}', '(', ',', '=>'].map((c) => before.lastIndexOf(c) + c.length),
    )
    return before.slice(segStart)
  }
  const callRe = new RegExp(`\\bctx\\s*\\.\\s*${api}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g')
  for (const match of code.matchAll(callRe)) {
    const member = match[1]
    if (!members.includes(member) || missing.includes(member)) continue
    if (/\bawait\b/.test(beforeSegment(match.index))) continue
    const after = code.slice(match.index + match[0].length)
    if (/^[^;\n]*\)\s*\.\s*(then|catch|finally)\s*\(/.test(after)) continue
    missing.push(member)
  }
  // `ctx.fs.sheet.read(...)` 是唯一的两级成员：上面的正则只认到 `sheet(`
  const sheetRe = /\bctx\s*\.\s*fs\s*\.\s*sheet\s*\.\s*read\s*\(/
  const sheetAt = code.search(sheetRe)
  if (api === 'fs' && sheetAt >= 0 && !missing.includes('sheet.read') && !/\bawait\b/.test(beforeSegment(sheetAt))) {
    missing.push('sheet.read')
  }
  return missing
}

/**
 * 界面半边最容易踩的**运行时陷阱**（都来自真实翻车的插件）：
 *  a) 异步成员忘了 await → 读返回值属性得到 undefined（面板报「文件为空」）；
 *  b) `pickFiles` 的返回形状用错（它是 `{ cancelled, files: [{path,…}] }`，不是路径数组）；
 *  c) 建了 `ResizeObserver` 却没 `disconnect()`（重载后越挂越多）；
 *  d) `ctx.locale.pick()/ref()` 返回的是 **ref**，被当字符串用（插进模板字符串 / 与字符串相加 / 传给 ctx.notify）
 *     → 界面或提示显示 "[object Object]"；
 *  e) `const text = ctx.locale.pick(...)` 之后写 `text.title`（漏 `.value`）→ 取值得到 undefined。
 * 这些都不是语法错，宿主也只会在运行时表现成「什么都不显示」/「提示是 [object Object]」，所以必须静态提示。
 */
function checkClientRuntimeTraps(code: string): string[] {
  const problems: string[] = []

  // a) 异步成员没有 await（ctx.files 与 ctx.fs 都是 Promise）
  for (const member of findMissingAwait(code, 'files', ASYNC_FILES_MEMBERS)) {
    problems.push(
      `ctx.files.${member}() 是**异步**的（返回 Promise），这里没写 await —— 直接读它的属性/长度只会得到 undefined（典型表现：面板报「文件为空」、或选了文件却没有任何反应）`,
    )
  }
  for (const member of findMissingAwait(code, 'fs', ASYNC_FS_MEMBERS)) {
    problems.push(
      `ctx.fs.${member}() 是**异步**的（返回 Promise），这里没写 await —— 直接读 res.text / res.bytes / res.version 只会得到 undefined（典型表现：面板「没有数据」）`,
    )
  }

  // b) pickFiles 的返回形状：{ cancelled, files: [{ path, name, size }] }
  //    只盯「把它当数组用」这一种确定错误（var.length / var[0] / var.map），避免误报
  const pickRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?ctx\s*\.\s*files\s*\.\s*pickFiles\s*\(/g
  for (const match of code.matchAll(pickRe)) {
    const varName = match[1]
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`${escaped}\\s*(?:\\.\\s*length\\b|\\[\\s*0\\s*\\]|\\.\\s*map\\s*\\()|\\(\\s*${escaped}\\s*\\)\\s*&&`).test(code)) {
      problems.push(
        `把 ctx.files.pickFiles() 的返回值（${varName}）当数组用了：它返回 { cancelled, files: [{ path, name, size }] }，正确写法是 if (${varName}.cancelled || !${varName}.files.length) return; const path = ${varName}.files[0].path（用户取消时**不抛错**，所以不能用 try/catch 判取消）`,
      )
    }
  }

  // c) ResizeObserver 必须 disconnect
  if (/new\s+ResizeObserver\s*\(/.test(code) && !/\.\s*disconnect\s*\(/.test(code)) {
    problems.push('new ResizeObserver(...) 没有调用 observer.disconnect()：要在 onUnmounted 里断开，否则每次重载插件都会多挂一个观察器')
  }

  // d) ctx.locale.pick() / ref() 返回的是 **ref**（对象），当字符串用 → 界面 / 提示显示 "[object Object]"
  //    真实翻车：ctx.notify(ctx.locale.pick({ zh: … }))、`${ctx.locale.pick({ zh: '篇' })}`。
  //    只认「同一语句片段内」的三种确定写法（模板字符串插值 / 字符串相加 / 传给 notify），避免误报；
  //    片段分隔符故意不含 "("，这样才能看出「作为 notify 的参数」的写法。
  //    模板字符串这一种直接看调用前是不是 `${`（用 "{"/"}" 切片段会把 `${` 的 "{" 当分隔符，判不出来）。
  const localeRefMisuse = new Set<string>()
  for (const match of code.matchAll(/ctx\s*\.\s*locale\s*\.\s*(pick|ref)\s*\(/g)) {
    const kind = match[1]
    const before = code.slice(0, match.index)
    const segStart = Math.max(0, ...[';', '\n', '{', '}', ',', '=>'].map((c) => before.lastIndexOf(c) + c.length))
    const seg = before.slice(segStart)
    if (/\$\{\s*$/.test(before)) localeRefMisuse.add(`模板字符串里插入了 ctx.locale.${kind}() 的返回值`)
    if (/\+\s*$/.test(seg)) localeRefMisuse.add(`把 ctx.locale.${kind}() 的返回值与字符串相加了`)
    if (/ctx\s*\.\s*notify\s*\([^()]*$/.test(seg)) localeRefMisuse.add('ctx.notify(...) 收到的是 ctx.locale.pick()/ref() 的返回值')
  }
  for (const misuse of localeRefMisuse) {
    problems.push(
      `${misuse}：ctx.locale.pick() / ref() 返回的是 **ref（对象），不是字符串**，当字符串用就会显示 "[object Object]"（ctx.notify 只接受字符串）。取值要写 const text = ctx.locale.pick({ zh: {...}, en: {...} }) 再 text.value.key，或直接用 ctx.locale.t(dict, 'key', { 参数 }) 拿一次性字符串`,
    )
  }

  // e) const text = ctx.locale.pick(...) 之后用了 text.xxx（漏 .value）→ 取值得到 undefined
  const localeRefAssign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*ctx\s*\.\s*locale\s*\.\s*(?:pick|ref)\s*\(/g
  for (const match of code.matchAll(localeRefAssign)) {
    const varName = match[1]
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const misuse = new RegExp(`\\b${escaped}\\s*\\.\\s*(?!value\\b)[A-Za-z_$][\\w$]*`).exec(code)
    if (!misuse) continue
    problems.push(
      `${varName} = ctx.locale.pick()/ref() 返回的是 **ref**，这里写的是 ${misuse[0]}（少了 .value），取值会得到 undefined；要写成 ${varName}.value.<key>`,
    )
  }

  return problems
}

/** 界面半边的本地事件（外壳只发这两个，走渲染层总线，不受观测允许名单限制） */
const LOCAL_PLUGIN_EVENTS = ['plugin/loaded', 'plugin/unloaded']

/**
 * 订阅的事件类型是否真的会触发。
 *
 * 背景：界面半边的 `ctx.on` 对**观测类型**走主进程转发（有允许名单），对其余类型走渲染层本地
 * 总线（不报错）。所以把 `tool/call` 写成 `tools/call` 不会抛异常，而是**永远静默**——
 * 这是最难查的一类问题。只对「看起来像观测事件」的名字（tool/ agent/ assistant/ 前缀）报警，
 * 自定义的本地事件名无法静态判定，不制造误报。
 */
function checkClientEventTypes(code: string): string[] {
  const problems: string[] = []
  const allowed = new Set<string>([...PLUGIN_EVENT_TYPES, ...LOCAL_PLUGIN_EVENTS])
  const seen = new Set<string>()
  for (const match of code.matchAll(/ctx\s*\.\s*on\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    const type = match[1]
    if (allowed.has(type) || seen.has(type)) continue
    seen.add(type)
    if (!/^(tools?|agents?|assistant)\//.test(type)) continue
    problems.push(
      `订阅的事件类型 "${type}" 不在允许名单里：它**永远不会触发**（宿主不报错，所以很难查）。可订阅：${[...PLUGIN_EVENT_TYPES].join(' / ')}`,
    )
  }
  return problems
}

/** 一条「能力 → 权限」规则：源码里用了该能力，清单就必须声明对应权限 */
interface PermissionRule {
  re: RegExp
  permission: PluginPermission
  /** 报错里给作者看的名字 */
  label: string
}

/** 界面半边：能力 → 权限（与 src/shared/pluginCapabilities.ts 同一套对应关系） */
const CLIENT_PERMISSION_RULES: readonly PermissionRule[] = [
  { re: /\bctx\s*\.\s*fs\s*\./, permission: 'fs', label: 'ctx.fs' },
  { re: /\bctx\s*\.\s*files\s*\./, permission: 'fs', label: 'ctx.files' },
  { re: /\bctx\s*\.\s*llm\s*\./, permission: 'llm', label: 'ctx.llm' },
  { re: /\bctx\s*\.\s*image\s*\./, permission: 'image', label: 'ctx.image' },
  { re: /\bctx\s*\.\s*agents?\s*\./, permission: 'agent.run', label: 'ctx.agent / ctx.agents' },
]

/** 主进程半边：能力 → 权限（host.readFile/writeFile/listDir 不需要权限，granted.* 需要 fs） */
const MAIN_PERMISSION_RULES: readonly PermissionRule[] = [
  { re: /\bctx\s*\.\s*fs\s*\./, permission: 'fs', label: 'ctx.fs' },
  { re: /\bctx\s*\.\s*host\s*\.\s*granted\s*\./, permission: 'fs', label: 'ctx.host.granted' },
  { re: /\bctx\s*\.\s*host\s*\.\s*runShell\s*\(/, permission: 'shell', label: 'ctx.host.runShell' },
  { re: /\bctx\s*\.\s*host\s*\.\s*fetch\s*\(/, permission: 'net', label: 'ctx.host.fetch' },
  { re: /\bctx\s*\.\s*host\s*\.\s*sessions\s*\./, permission: 'agent', label: 'ctx.host.sessions' },
]

/**
 * 交叉校验「代码用到的能力」与「清单声明的权限」。
 *
 * 为什么值得一条独立检查：未声明时能力 `available=false`、调用直接抛错，而作者往往先写代码
 * 再补清单（或反过来），跑起来只看到「什么都没发生」或一句英文权限错误。
 */
function checkDeclaredPermissions(
  code: string,
  permissions: readonly string[],
  rules: readonly PermissionRule[],
  fileName: string,
): string[] {
  const problems: string[] = []
  for (const rule of rules) {
    if (!rule.re.test(code) || permissions.includes(rule.permission)) continue
    problems.push(
      `${fileName} 用了 ${rule.label}，但清单 permissions 里没有 "${rule.permission}"：未声明时该能力 available=false、调用直接抛错（把 "${rule.permission}" 加进 aikm.permissions 后重载插件）`,
    )
  }
  return problems
}

/** 清单里声明的权限（校验失败时退回原始 aikm.permissions，好把问题一次列全） */
function declaredPermissions(manifest: any, rawAikm: any): string[] {
  const list = manifest?.permissions ?? rawAikm?.permissions
  return Array.isArray(list) ? list.filter((p: unknown): p is string => typeof p === 'string') : []
}

/** 主进程半边：检查 `ctx.*` 用法 */
function checkMainCtxUsage(code: string): string[] {
  return checkCtxUsage(code, MAIN_CTX_MEMBERS, MAIN_CTX_ABSENT)
}

/**
 * 老入口 → 新入口的迁移提示（**不算错误**：老写法全部保留）。
 *
 * 为什么要报：`ctx.files` 的读写只是 `ctx.fs` 的别名，`ctx.host` 的读写是插件目录内的老入口。
 * 不提示的话，新插件会继续照抄旧例，而 `ctx.fs` 的目标身份 / 版本 / 字面量编辑正是为此加的。
 */
function migrationHints(code: string, fileName: string): string[] {
  const hints: string[] = []
  if (/ctx\s*\.\s*files\s*\.\s*(?:readText|readBytes|readBase64|readSheet|list|writeText|remove)\s*\(/.test(code)) {
    hints.push(
      `${fileName}：ctx.files 的读写建议改用 ctx.fs（老写法仍可用）——ctx.fs 多了目标身份 resolve / 版本 stat / 字面量编辑 editText，且两个半边同形状；选择框（pickFiles / pickDirectory / pickWritableDirectory）与 renderPdfPage / openInApp 仍留在 ctx.files`,
    )
  }
  if (/ctx\s*\.\s*host\s*\.\s*(?:readFile|writeFile|listDir|granted)\b/.test(code)) {
    hints.push(
      `${fileName}：ctx.host 的读写建议改用 ctx.fs（老入口仍可用）——插件目录内免授权、其余路径走用户授权，读写与界面半边同一套判定`,
    )
  }
  if (/ctx\s*\.\s*llm\s*\.\s*chat\s*\(/.test(code) && !/\bschema\s*:/.test(code)) {
    hints.push(
      `${fileName}：需要结构化结果时给 ctx.llm.chat 传 schema（宿主负责要求 JSON + 解析 + 浅校验），可省掉自己写的容错解析；要边出边显示改用 ctx.llm.stream`,
    )
  }
  return hints
}

/** 解析目标插件目录：允许「插件 id」（在插件目录下找）或绝对 / 相对路径 */
function resolveDir(input: string): { dir: string; name: string } | { error: string } {
  const raw = String(input || '').trim()
  if (!raw) return { error: '缺少 dir 参数：给插件文件夹路径，或直接给插件 id（在插件目录下查找）' }
  const dirs = path.isAbsolute(raw) ? [raw] : [path.join(pluginHost.rootDir(), raw)]
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return { dir, name: path.basename(dir) }
    } catch {
      /* 继续 */
    }
  }
  return { error: `找不到插件目录：${raw}（插件目录当前是 ${pluginHost.rootDir()}；也可以直接传插件 id）` }
}

function readText(file: string, max = CLIENT_SOURCE_MAX): string | null {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = Math.min(fs.fstatSync(fd).size, max)
      const buf = Buffer.alloc(size)
      fs.readSync(fd, buf, 0, size, 0)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * 检查一个插件目录，返回**可读的检查报告**（✓ / ✗ + 怎么改）。
 * 校验逻辑与宿主完全一致（同一份 parseManifest / checkApiVersion / isSafeRelativeEntry）。
 *
 * 若宿主还不认识这个插件（刚写好的新文件夹），会先让宿主重扫一次再报状态——
 * 这样「写完 → 自检」就能立刻拿到真实的加载结果，不必等目录监视去抖或手动点「重新扫描」。
 */
export async function checkPluginDir(dirArg: string): Promise<string> {
  const resolved = resolveDir(dirArg)
  if ('error' in resolved) return resolved.error
  const { dir, name } = resolved
  if (!pluginHost.get(name)) {
    try {
      await pluginHost.rescanNow()
    } catch {
      /* 重扫失败不影响静态检查结果 */
    }
  }
  return buildReport(dir, name)
}

/** 组装检查报告（静态检查 + 宿主真实状态与日志） */
function buildReport(dir: string, name: string): string {
  const lines: string[] = [`【插件自检：${dir}】`, '']
  const problems: string[] = []
  /** 迁移提示（不算错误）：老入口仍可用，但新代码有更合适的样子 */
  const hints: string[] = []

  // 0) 目录名本身必须是合法插件 id：中文 / 大写 / 空格会让宿主**静默跳过**整个文件夹
  //    （插件列表里根本不出现，用户只能看到「什么都没发生」），所以放在最前面报。
  if (!isValidPluginId(name)) {
    const reason = `目录名 "${name}" 不能作为插件 id（必须以小写字母/数字开头，且只含 [a-z0-9._-]）——宿主会跳过这个文件夹，插件不会出现在列表里`
    problems.push(`${reason}；请把文件夹改成 ASCII 名（如 my-plugin），并让清单 aikm.id 与它一致（显示名 aikm.name 仍可用中文）`)
    lines.push(`✗ ${reason}`)
  } else {
    lines.push(`✓ 目录名可作为插件 id：${name}`)
  }

  // 1) package.json + aikm 清单
  const manifestPath = path.join(dir, PLUGIN_MANIFEST_FILE)
  let manifest: any = null
  /** 清单原始 aikm 字段（清单校验失败时也用它报入口/半边问题，一次性把问题都列出来） */
  let rawAikm: any = null
  if (!fs.existsSync(manifestPath)) {
    problems.push(`缺少 ${PLUGIN_MANIFEST_FILE}（清单写在 package.json 的 aikm 字段里；没有它就完全不认识这个插件）`)
    lines.push(`✗ 没有 ${PLUGIN_MANIFEST_FILE}`)
  } else {
    const rawText = readText(manifestPath) ?? ''
    let parsed: any = null
    try {
      parsed = JSON.parse(rawText)
      lines.push(`✓ ${PLUGIN_MANIFEST_FILE} 是合法 JSON`)
    } catch (e: any) {
      problems.push(`${PLUGIN_MANIFEST_FILE} 不是合法 JSON：${e?.message || e}（不要写注释、不要有多余逗号）`)
      lines.push(`✗ ${PLUGIN_MANIFEST_FILE} JSON 解析失败：${e?.message || e}`)
    }
    if (parsed) {
      rawAikm = parsed?.aikm && typeof parsed.aikm === 'object' ? parsed.aikm : null
      const check = parseManifest(parsed, name)
      if (isManifestFailure(check)) {
        problems.push(`清单不通过：${check.message}`)
        lines.push(`✗ 清单校验失败（${check.problem}）：${check.message}`)
      } else {
        manifest = check.manifest
        lines.push(`✓ 清单通过：id=${manifest.id} name=${manifest.name} version=${manifest.version} apiVersion=${manifest.apiVersion}`)
        const apiCheck = checkApiVersion(manifest.apiVersion)
        if (!apiCheck.ok) {
          problems.push(`API 版本不匹配：${apiCheck.reason}（宿主 API 版本是 1，清单里写 "^1"）`)
          lines.push(`✗ ${apiCheck.reason}`)
        } else {
          lines.push('✓ 宿主 API 版本匹配')
        }
        if (manifest.declares?.slots?.length) lines.push(`✓ 声明的槽位：${manifest.declares.slots.join(', ')}`)
      }
    }
  }

  // 2) 声明的入口文件是否存在（清单校验失败时也按原始 aikm 报，便于一次性改完）
  const entries: Array<[string, string]> = []
  const mainRel = manifest?.main || (typeof rawAikm?.main === 'string' ? rawAikm.main : '')
  const clientRelRaw = manifest?.client?.entry || (typeof rawAikm?.client?.entry === 'string' ? rawAikm.client.entry : '')
  if (mainRel) entries.push(['main', mainRel])
  if (clientRelRaw) entries.push(['client.entry', clientRelRaw])
  for (const [label, rel] of entries) {
    if (!isSafeRelativeEntry(rel)) {
      problems.push(`${label} 路径非法：${rel}`)
      lines.push(`✗ ${label} = ${rel}（必须是插件目录内的相对路径）`)
      continue
    }
    if (fs.existsSync(path.join(dir, rel))) {
      lines.push(`✓ ${label} = ${rel}（存在）`)
    } else {
      problems.push(`${label} 指向的 ${rel} 不存在（只写界面半边就不要写 main；写了工具半边就要建 index.mjs）`)
      lines.push(`✗ ${label} = ${rel} 不存在`)
    }
  }

  // 3) 界面半边：宿主按 Blob 模块加载，几条硬规则可以直接静态看出来
  const clientRel = clientRelRaw
  if (clientRel && isSafeRelativeEntry(clientRel) && fs.existsSync(path.join(dir, clientRel))) {
    const code = readText(path.join(dir, clientRel)) ?? ''
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const hasImport = /^\s*import\s/m.test(stripped)
      || /\bfrom\s+['"][^'"]+['"]/.test(stripped)
      || /export\s+.*\bfrom\s+['"]/.test(stripped)
    if (hasImport) {
      problems.push(`${clientRel} 里有 import：界面半边必须单文件、零 import（Vue 从 ctx.vue 取）`)
      lines.push(`✗ ${clientRel} 含 import（Blob 模块解析不了裸模块名）`)
    } else {
      lines.push(`✓ ${clientRel} 没有 import`)
    }
    if (/\brequire\s*\(/.test(stripped)) {
      problems.push(`${clientRel} 里有 require：界面半边不能用 CommonJS`)
      lines.push(`✗ ${clientRel} 含 require`)
    }
    if (/\btemplate\s*:/.test(stripped)) {
      problems.push(`${clientRel} 里用了 template：界面半边只能写渲染函数 h(...)（没有模板编译器）`)
      lines.push(`✗ ${clientRel} 用了 template:（只能写渲染函数）`)
    }
    const hasApply = /export\s+(async\s+)?function\s+apply\b/.test(code)
      || /export\s+default\s*\{/.test(code)
      || /\bapply\s*:/.test(code)
    if (!hasApply) {
      problems.push(`${clientRel} 没有导出 apply(ctx)——要写 export function apply(ctx) {...} 或 export default { apply }；export default function (ctx) 这种裸函数不行`)
      lines.push(`✗ ${clientRel} 不是导出 apply(ctx) 的形状`)
    } else {
      lines.push('✓ 导出形状看起来是 apply(ctx)')
    }
    if (!/slots\.register\s*\(/.test(stripped)) {
      problems.push(`${clientRel} 没有调用 ctx.slots.register('panel.main', …)：界面半边不注册槽位就不会在界面上出现任何东西`)
      lines.push('✗ 没有 ctx.slots.register(...)（不会在界面上出现）')
    } else {
      lines.push('✓ 调用了 ctx.slots.register')
    }
    if (/\bonMounted\s*\(|\bonUnmounted\s*\(/.test(stripped) && !/setup\s*\(/.test(stripped)) {
      problems.push(`${clientRel} 里调用了 onMounted / onUnmounted 但没有 setup()：生命周期钩子必须在组件的 setup 内调用`)
      lines.push('✗ onMounted / onUnmounted 不在 setup 里')
    }
    if ((manifest?.declares?.slots || rawAikm?.declares?.slots || []).length === 0) {
      problems.push('清单没有 declares.slots：注册槽位会被拒绝，请把用到的槽位写进 declares.slots')
    }

    // 3b) ctx API：臆造宿主 API 是生成式插件最常见的翻车（运行时直接 "is not a function"）
    const ctxProblems = checkClientCtxUsage(stripped)
    if (ctxProblems.length) {
      lines.push(`✗ 用了宿主不存在的 API（${ctxProblems.length} 处）`)
      problems.push(...ctxProblems.map((p) => `${clientRel}：${p}`))
    } else {
      lines.push('✓ 用到的 ctx 成员都是宿主真实提供的')
    }

    // 3b2) 运行时陷阱：漏 await / pickFiles 形状 / ResizeObserver 未断开 / ref 当字符串用
    const trapProblems = checkClientRuntimeTraps(stripped)
    if (trapProblems.length) {
      lines.push(`✗ 运行时陷阱（${trapProblems.length} 处）`)
      problems.push(...trapProblems.map((p) => `${clientRel}：${p}`))
    } else {
      lines.push('✓ 没有发现漏 await / 返回形状用错 / 观察器未断开 / ref 当字符串用')
    }

    // 3b2b) 订阅的事件类型真的会触发吗（写错名字不报错，只是永远不来）
    const eventProblems = checkClientEventTypes(stripped)
    if (eventProblems.length) {
      lines.push(`✗ 事件订阅（${eventProblems.length} 处）`)
      problems.push(...eventProblems.map((p) => `${clientRel}：${p}`))
    } else {
      lines.push('✓ 订阅的事件类型都在允许名单内（或属于渲染层本地事件）')
    }

    // 3b2c) 能力 → 权限：未声明时 available=false 且调用抛错
    const permProblems = checkDeclaredPermissions(
      stripped,
      declaredPermissions(manifest, rawAikm),
      CLIENT_PERMISSION_RULES,
      clientRel,
    )
    if (permProblems.length) {
      lines.push(`✗ 用到的能力没有在清单里申请权限（${permProblems.length} 处）`)
      problems.push(...permProblems)
    } else {
      lines.push('✓ 用到的能力都有对应的 permissions 声明')
    }

    hints.push(...migrationHints(stripped, clientRel))

    // 3b3) 写死的绝对路径：fs 权限不等于能读任意路径（只授权用户在该插件里亲自选过的文件）
    const absPath = stripped.match(/['"`]([A-Za-z]:[\\/][^'"`\n]*|\\\\[^'"`\n]*|\/(?:Users|home|mnt|opt|srv|var|tmp|Volumes)\/[^'"`\n]*)/)
    const hasPicker = /ctx\.files\s*\.\s*pick(?:Files|Directory)\s*\(/.test(stripped)
    if (absPath && !hasPicker) {
      problems.push(
        `${clientRel}：写死了绝对路径（${absPath[1]}）却没有 ctx.files.pickFiles / pickDirectory —— fs 权限只授权「用户在该插件里亲自选过」的文件，写死的路径一定读不到（报「未授权访问」）；正确做法是先让用户选一次，再把路径存进 localStorage`,
      )
    }
  }

  // 3c) 主进程半边：两半边的 ctx 完全不通用（ctx.vue / ctx.files 在 index.mjs 里不存在）
  if (mainRel && isSafeRelativeEntry(mainRel) && fs.existsSync(path.join(dir, mainRel))) {
    const mainCode = readText(path.join(dir, mainRel)) ?? ''
    const mainStripped = mainCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const mainCtxProblems = checkMainCtxUsage(mainStripped)
    if (mainCtxProblems.length) {
      lines.push(`✗ ${mainRel} 用了主进程半边不存在的 API（${mainCtxProblems.length} 处）`)
      problems.push(...mainCtxProblems.map((p) => `${mainRel}：${p}`))
    } else {
      lines.push(`✓ ${mainRel} 用到的 ctx 成员都是主进程半边真实提供的`)
    }

    // 3c2) 主进程半边同样要核对权限（granted.* → fs、runShell → shell、fetch → net、sessions → agent）
    const mainPermProblems = checkDeclaredPermissions(
      mainStripped,
      declaredPermissions(manifest, rawAikm),
      MAIN_PERMISSION_RULES,
      mainRel,
    )
    if (mainPermProblems.length) {
      lines.push(`✗ ${mainRel} 用到的能力没有在清单里申请权限（${mainPermProblems.length} 处）`)
      problems.push(...mainPermProblems)
    } else {
      lines.push(`✓ ${mainRel} 用到的能力都有对应的 permissions 声明`)
    }

    hints.push(...migrationHints(mainStripped, mainRel))
  }

  // 检查盲区说明：只认字面量 ctx.x，别名 / 动态取值看不出来
  lines.push('（说明：以上 ctx 检查只识别字面量写法 ctx.x / ctx.x.y；把 ctx 赋给别的变量、或用 ctx["files"] 这类动态取值时看不出来。）')

  if (hints.length) {
    lines.push('', '【建议迁移（不算错误，老写法仍可用）】')
    hints.forEach((h) => lines.push(`- ${h}`))
  }

  lines.push('')
  if (!problems.length) {
    lines.push('结论：没发现明显问题。提醒用户到「设置 → 插件 → 管理」点「重新扫描」→ 启用（会列出申请的权限）→ 在导航栏或对应位置查看效果。')
  } else {
    lines.push(`结论：发现 ${problems.length} 个问题，请修好再交付：`)
    problems.forEach((p, i) => lines.push(`${i + 1}. ${p}`))
  }

  // 4) 宿主真实状态与日志（开发后报错就在这里）：
  //    - 状态来自主进程的加载流程（清单校验失败 / 入口缺失 / 加载抛错都反映在 status + error）
  //    - 日志含主进程半边与**界面半边**（界面装载失败等由渲染层上报，见 plugin:client-log）
  lines.push('', hostStateReport(name))
  return lines.join('\n')
}

/** 宿主侧的真实状态 + 最近日志（按 id 匹配；新写的插件若尚未被扫描到会明确提示） */
function hostStateReport(id: string): string {
  const snap = pluginHost.get(id)
  if (!snap) {
    return [
      '【宿主状态】宿主还没扫描到这个插件（通常 1 秒内目录监视会自动发现；本工具也已主动触发过一次重扫）。',
      `若仍没有：让用户在「设置 → 插件 → 管理」点一次「重新扫描」（插件目录：${pluginHost.rootDir()}）。`,
    ].join('\n')
  }
  const lines: string[] = ['【宿主状态（真实加载结果）】']
  lines.push(`- 状态：${snap.status}${snap.enabled ? '' : '（已禁用：需要用户在管理页启用）'}`)
  if (snap.apiVersion || snap.clientEntry || snap.hasMain) {
    lines.push(`- 宿主解析到的清单：name=${snap.name} version=${snap.version} apiVersion=${snap.apiVersion} main=${snap.hasMain ? '有' : '无'} client=${snap.clientEntry || '无'}`)
  } else {
    lines.push('- 宿主没能解析出清单（清单校验没通过，上面的 ✗ 就是原因）')
  }
  if (snap.declaredSlots.length) lines.push(`- 声明的槽位：${snap.declaredSlots.join(', ')}`)
  if (snap.error) lines.push(`- 错误：${snap.error}`)
  const logs = pluginHost.logs(id)
  if (logs.length) {
    lines.push('- 最近日志（新 → 旧，最多 30 条）：')
    for (const l of logs.slice(-30).reverse()) {
      lines.push(`  [${new Date(l.ts).toLocaleTimeString()}] ${l.level.toUpperCase()} ${l.message}`)
    }
    const errs = logs.filter((l) => l.level === 'error')
    if (errs.length) lines.push(`- 其中错误 ${errs.length} 条（界面半边装载失败也会记在这里，前缀 [界面]）。`)
  } else {
    lines.push('- 暂无日志（插件还没被加载过，或加载前就失败了）。')
  }
  return lines.join('\n')
}
