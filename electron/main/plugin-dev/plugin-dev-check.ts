// electron/main/plugin-dev/plugin-dev-check.ts
// 内置 MCP 服务 builtin-plugin-dev 的自检工具：plugin_dev_check
//
// 为什么需要它：模型（尤其体量小的）写完插件后经常在「清单字段类型 / 槽位声明 / 入口导出形状 /
// 界面半边用了 import」这些点上翻车，而用户只有在「插件管理」里看到一句报错才知道。
// 这个工具让模型在交付前**自己**跑一遍宿主真实的校验逻辑（与设置页同一份 parseManifest），
// 拿到可操作的清单并把问题改掉，再回报用户。
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
import { pluginHost } from '../plugin-host'
import { isValidPluginId } from '@/types/ids'

/** 客户端半边源码的检查上限（超大文件只读前 512KB，足够判断 import / 模板 / 槽位注册） */
const CLIENT_SOURCE_MAX = 512 * 1024

/**
 * 界面半边 `ctx` 的**真实成员表**（与 `src/lib/plugin/runtime.ts` 的 ClientPluginContext 一一对应）。
 *
 * 为什么需要它：生成式插件最常见的翻车不是语法错，而是**臆造宿主 API**
 * （真实案例：`ctx.files.readFile(...)` + `ctx.service('office', …)` 想解析 Excel，
 * 运行到第一行就抛 "is not a function"，用户看到的就是「面板一直空白 / 图表不显示」）。
 * 静态比对一眼就能在**交付前**发现，不必等用户在界面上发现「什么都没发生」。
 *
 * 值 = 该成员下可用的子成员（`null` = 只读数据对象或函数，不逐个校验属性）。
 */
const CLIENT_CTX_MEMBERS: Record<string, string[] | null> = {
  plugin: null, // 只读快照 { id, name, version, dir }
  config: null, // 只读快照（用户在「插件 → 配置」里保存的 JSON）
  vue: [
    'h', 'defineComponent', 'ref', 'shallowRef', 'reactive', 'computed', 'watch', 'watchEffect',
    'onMounted', 'onUnmounted', 'onBeforeUnmount', 'nextTick', 'toRef', 'toRefs', 'markRaw',
    'provide', 'inject', 'KeepAlive', 'Teleport', 'Transition', 'Fragment',
  ],
  locale: ['language', 'languageRef', 't', 'pick', 'ref', 'fixed'],
  llm: ['available', 'reason', 'sources', 'current', 'models', 'chat'],
  files: [
    'available', 'reason', 'pickFiles', 'pickDirectory', 'list', 'readText', 'readBase64',
    'readSheet', 'renderPdfPage', 'openInApp',
  ],
  app: ['info', 'agentPresets'],
  tts: ['available', 'reason', 'speak', 'stop'],
  shortcuts: ['register', 'list'],
  slots: ['register', 'declare', 'entries'],
  log: ['debug', 'info', 'warn', 'error'],
  on: null, // (type, listener) => 取消订阅函数
  effect: null, // (fn) => 登记副作用并自动清理
  notify: null, // (message) => 轻提示
}

/**
 * 界面半边**不存在**的宿主能力 → 给出「正确做法」。
 * 这些名字（尤其 service / mcp / storage / host）是模型最容易臆造出来的，所以单独列出来报。
 */
const CLIENT_CTX_ABSENT: Record<string, string> = {
  service: '界面半边没有 ctx.service（也没法连 MCP 服务）：office / 浏览器 / drawio 这些 MCP 服务只按 mcp_call 给智能体调用。要在插件里做同类事情，请用 ctx 上已有的能力，或把功能做成**主进程半边**的工具（index.mjs + ctx.tool）让智能体调用',
  mcp: '界面半边没有 ctx.mcp：MCP 服务只按 mcp_call 给智能体调用，插件不能直连',
  host: '界面半边没有 ctx.host（那是主进程半边 index.mjs 的能力）',
  storage: '界面半边没有 ctx.storage：设置存 localStorage（键名带 aikm.plugin.<插件 id>. 前缀），图片 / 存档等大文件放本机 OPFS 的 plugins/<插件 id>/',
  tool: '界面半边没有 ctx.tool：注册工具要在**主进程半边** index.mjs 里写（export const inject = ["tools"]）',
  shell: '界面半边没有 ctx.shell（执行命令是主进程半边的能力，且需要 shell 权限）',
  fs: '界面半边没有 ctx.fs：文件能力在 ctx.files 上',
}

/** 检查源码里对 `ctx.*` 的引用，返回问题（空数组 = 没发现） */function checkCtxUsage(
  code: string,
  members: Record<string, string[] | null>,
  absent: Record<string, string>,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  // 只认字面量 `ctx.x` / `ctx.x.y`；`ctx['files']`、把 ctx 赋给别的变量后再用 属已知盲区（报告末尾会说明）
  const re = /\bctx\s*\.\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g
  for (const match of code.matchAll(re)) {
    const top = match[1]
    const sub = match[2]
    const key = `${top}.${sub ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)

    const reason = absent[top]
    if (reason) {
      // 同一个缺失成员只报一次
      if (!seen.has(`!${top}`)) {
        seen.add(`!${top}`)
        problems.push(`用了宿主不存在的 ctx.${top} —— ${reason}`)
      }
      continue
    }
    if (!(top in members)) {
      problems.push(`用了宿主不存在的 ctx.${top}（这里可用的只有：${Object.keys(members).join(' / ')}）`)
      continue
    }
    const subs = members[top]
    if (sub && subs && !subs.includes(sub)) {
      problems.push(`ctx.${top} 没有 ${sub}（可用：${subs.join(' / ')}）`)
    }
  }
  return problems
}

/** 界面半边：检查 `ctx.*` 用法 */
function checkClientCtxUsage(code: string): string[] {
  return checkCtxUsage(code, CLIENT_CTX_MEMBERS, CLIENT_CTX_ABSENT)
}

/** `ctx.files` 上返回 Promise 的成员：忘了 await 时读属性会得到 undefined */
const ASYNC_FILES_MEMBERS = [
  'pickFiles', 'pickDirectory', 'list', 'readText', 'readBase64', 'readSheet', 'renderPdfPage', 'openInApp',
]

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

  // a) 异步成员没有 await
  const missingAwait = new Set<string>()
  const callRe = /\bctx\s*\.\s*files\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g
  for (const match of code.matchAll(callRe)) {
    const member = match[1]
    if (!ASYNC_FILES_MEMBERS.includes(member) || missingAwait.has(member)) continue
    const before = code.slice(0, match.index)
    // 取「当前语句」片段（上一个分隔符之后），在里面找 await
    const segStart = Math.max(
      0,
      ...[';', '\n', '{', '}', '(', ',', '=>'].map((c) => before.lastIndexOf(c) + c.length),
    )
    if (/\bawait\b/.test(before.slice(segStart))) continue
    const after = code.slice(match.index + match[0].length)
    // 允许 .then(...) / .catch(...) 链式写法
    if (/^[^;\n]*\)\s*\.\s*(then|catch|finally)\s*\(/.test(after)) continue
    missingAwait.add(member)
  }
  for (const member of missingAwait) {
    problems.push(
      `ctx.files.${member}() 是**异步**的（返回 Promise），这里没写 await —— 直接读它的属性/长度只会得到 undefined（典型表现：面板报「文件为空」、或选了文件却没有任何反应）`,
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

/**
 * 主进程半边 `ctx` 的真实成员表（与 `src/types/plugin.ts` 的 PluginContext 一一对应）。
 * 界面半边那套（ctx.vue / ctx.files / ctx.slots）在这里**不存在**，反之亦然——两半边最容易互相串用。
 */
const MAIN_CTX_MEMBERS: Record<string, string[] | null> = {
  plugin: null,
  config: null,
  tool: null, // (def) => disposer
  service: null, // (name, impl) => disposer
  getService: null, // (name) => impl | undefined
  on: null, // (type, listener) => disposer
  effect: null, // (fn) => disposer
  host: ['readFile', 'writeFile', 'listDir', 'runShell', 'fetch', 'sessions', 'notify'],
  storage: ['get', 'set', 'delete', 'keys'],
  log: ['debug', 'info', 'warn', 'error'],
}

/** 主进程半边写错时，把「那东西在界面半边」直接点出来（两半边互串是最常见的错法） */
const MAIN_CTX_ABSENT: Record<string, string> = {
  vue: '主进程半边没有 ctx.vue（那是界面半边的：ctx.vue / ctx.slots / ctx.locale / ctx.files 只在 client.mjs 里有）',
  files: '主进程半边没有 ctx.files；读自己目录内的文件用 ctx.host.readFile / writeFile / listDir',
  slots: '主进程半边没有 ctx.slots：界面贡献（面板 / 设置页签等）要在界面半边 client.mjs 里注册',
  locale: '主进程半边没有 ctx.locale：中英文案在界面半边用 ctx.locale 处理',
  llm: '主进程半边没有 ctx.llm（大模型能力在界面半边 client.mjs 上）',
  tts: '主进程半边没有 ctx.tts（语音能力在界面半边 client.mjs 上）',
  shortcuts: '主进程半边没有 ctx.shortcuts（全局快捷键在界面半边 client.mjs 上注册）',
  notify: '主进程半边没有 ctx.notify；提示用户用 ctx.host.notify(message)',
}

/** 主进程半边：检查 `ctx.*` 用法 */
function checkMainCtxUsage(code: string): string[] {
  return checkCtxUsage(code, MAIN_CTX_MEMBERS, MAIN_CTX_ABSENT)
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
  }

  // 检查盲区说明：只认字面量 ctx.x，别名 / 动态取值看不出来
  lines.push('（说明：以上 ctx 检查只识别字面量写法 ctx.x / ctx.x.y；把 ctx 赋给别的变量、或用 ctx["files"] 这类动态取值时看不出来。）')

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
