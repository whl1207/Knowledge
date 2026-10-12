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

/** 客户端半边源码的检查上限（超大文件只读前 512KB，足够判断 import / 模板 / 槽位注册） */
const CLIENT_SOURCE_MAX = 512 * 1024

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
    if (/ctx\.storage\b/.test(stripped)) {
      problems.push(`${clientRel} 用了 ctx.storage：界面半边没有 storage，持久化请用 localStorage（键名带 aikm.plugin.<插件 id>. 前缀）`)
      lines.push('✗ 用了 ctx.storage（界面半边没有这个能力）')
    }
    if (/\bonMounted\s*\(|\bonUnmounted\s*\(/.test(stripped) && !/setup\s*\(/.test(stripped)) {
      problems.push(`${clientRel} 里调用了 onMounted / onUnmounted 但没有 setup()：生命周期钩子必须在组件的 setup 内调用`)
      lines.push('✗ onMounted / onUnmounted 不在 setup 里')
    }
    if ((manifest?.declares?.slots || rawAikm?.declares?.slots || []).length === 0) {
      problems.push('清单没有 declares.slots：注册槽位会被拒绝，请把用到的槽位写进 declares.slots')
    }
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
