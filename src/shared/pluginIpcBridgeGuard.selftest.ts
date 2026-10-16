/**
 * pluginIpcBridgeGuard.selftest.ts — 「宿主 IPC 桥不得落回渲染层全局」的源码级回归护栏
 *
 * 背景（2026-11，我自己踩的坑，值得留档）：
 * 把桥从 `window` 上撤掉、改由 `src/lib/aikmIpc.ts` 在模块作用域持有之后，我写了个 codemod
 * 迁移调用点。codemod 的**预过滤**用的是 `window\.(ipcRenderer|dsh)`，而替换规则里另有一条
 * `(window as any).ipcRenderer` 的归一化 —— **检测比替换窄**，于是 `(window as any).X` 形式的
 * 文件被整批跳过（40 处漏改，其中 `src/platform/electron/index.ts` 的 `isElectronRuntime()`
 * 会让整个应用误判成「浏览器模式」）。
 *
 * 更糟的是**收尾检查用了同一个窄正则**，所以报「0 残留」；`vue-tsc` 也查不出——那些站点全是
 * `(window as any)`，`any` 把类型系统绕过去了。三个"检查"同时失效。
 *
 * 教训固化成两条：
 *   1. **检测用的形式集必须比替换用的更宽**（这里把 8 种写法全列出来，带 meta 自测逐条验证）；
 *   2. `as any` 会让类型检查失效的地方，必须另有一条源码级护栏（本文件）。
 *
 * 用法：`node scripts/run-selftests.mjs pluginIpcBridge`
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export interface PluginIpcBridgeGuardCase {
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
 * 桥的**全部书写形式**（唯一事实源）。任何一个都不能出现在渲染层 / preload 的代码里。
 *
 * ⚠️ 这张表必须与 `scripts/codemod-ipc-bridge.mjs` 的 `CAST_OR_GLOBAL` / `MEMBER` 保持一致。
 */
const BRIDGE_WRITE_FORMS: Array<{ label: string; re: RegExp }> = [
  { label: 'window.ipcRenderer', re: /\bwindow\s*\.\s*ipcRenderer\b/ },
  { label: 'window?.ipcRenderer', re: /\bwindow\s*\?\s*\.\s*ipcRenderer\b/ },
  { label: "window['ipcRenderer']", re: /\bwindow\s*\[\s*['"]ipcRenderer['"]\s*\]/ },
  { label: '(window as any).ipcRenderer', re: /\(\s*window\s+as\s+any\s*\)\s*\??\s*\.\s*ipcRenderer\b/ },
  { label: 'window.dsh', re: /\bwindow\s*\.\s*dsh\b/ },
  { label: 'window?.dsh', re: /\bwindow\s*\?\s*\.\s*dsh\b/ },
  { label: "window['dsh']", re: /\bwindow\s*\[\s*['"]dsh['"]\s*\]/ },
  { label: '(window as any).dsh', re: /\(\s*window\s+as\s+any\s*\)\s*\??\s*\.\s*dsh\b/ },
  { label: 'globalThis.ipcRenderer', re: /\bglobalThis\s*\.\s*ipcRenderer\b/ },
  { label: 'globalThis.dsh', re: /\bglobalThis\s*\.\s*dsh\b/ },
  { label: 'self.ipcRenderer', re: /\bself\s*\.\s*ipcRenderer\b/ },
]

/** 整行注释不算（文档里提到旧名字是合理的历史说明） */
function commentLines(lines: string[]): boolean[] {
  return lines.map((l) => /^\s*(\/\/|\/\*|\*)/.test(l))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(p, out)
    } else if (/\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

/** 扫描一组文件，返回违规位置（`file:line  形式  →  代码`） */
export function scanBridgeWrites(root: string, files: string[]): string[] {
  const hits: string[] = []
  for (const f of files) {
    const rel = relative(root, f).replace(/\\/g, '/')
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    const isComment = commentLines(lines)
    lines.forEach((line, i) => {
      if (isComment[i]) return
      for (const form of BRIDGE_WRITE_FORMS) {
        if (form.re.test(line)) {
          hits.push(`${rel}:${i + 1}  ${form.label}  →  ${line.trim().slice(0, 100)}`)
          break
        }
      }
    })
  }
  return hits
}

export function runPluginIpcBridgeGuardSelfTest(): PluginIpcBridgeGuardCase[] {
  const cases: PluginIpcBridgeGuardCase[] = []
  const root = repoRoot()

  // 1) 渲染层源码里不得出现任何写法
  //
  // 本文件必须排除：它的形式表与 meta 样例里**字面包含**这些写法（否则它会报自己）。
  // 这是本套件唯一的豁免，且豁免对象就是护栏本身 —— 新增豁免需要有同等理由。
  const GUARD_FILE = 'src/shared/pluginIpcBridgeGuard.selftest.ts'
  const scanned = walk(join(root, 'src')).filter(
    (f) => relative(root, f).replace(/\\/g, '/') !== GUARD_FILE,
  )
  const srcHits = scanBridgeWrites(root, scanned)
  cases.push({
    name: '渲染层源码里没有 window.ipcRenderer / window.dsh 的任何写法',
    ok: srcHits.length === 0,
    detail: srcHits.length
      ? `改用 aikmIpc / aikmDsh / aikmIpcAvailable() / aikmIpcOrNull()（见 src/lib/aikmIpc.ts）：\n  - ${srcHits.join('\n  - ')}`
      : `已扫 ${scanned.length} 个文件 × ${BRIDGE_WRITE_FORMS.length} 种写法（含 (window as any) 与 window[...] 形式；仅豁免护栏自身）`,
  })

  // 2) preload 不得再把桥挂到 window 上（这是"窄桥"的实质）
  const preload = readFileSync(join(root, 'electron/preload/index.ts'), 'utf8')
  const stillExposed = /exposeInMainWorld\s*\(\s*['"](?:ipcRenderer|dsh)['"]/.test(preload)
    || /\(window as any\)\s*\.\s*(?:ipcRenderer|dsh)\s*=/.test(preload)
  cases.push({
    name: 'preload 不再把 ipcRenderer / dsh 挂到 window',
    ok: !stillExposed,
    detail: stillExposed
      ? 'preload 里仍有 exposeInMainWorld(\'ipcRenderer\'|\'dsh\') 或直接赋值 —— 界面半边插件会重新拿到全部宿主通道'
      : '只暴露一次性 __aikmClaimIpcBridge()',
  })

  // 3) 一次性领取：必须有 claimed 守卫，否则晚于应用启动的插件代码也能领到桥
  const oneShot = /bridgeClaimed\s*=\s*true/.test(preload) && /if\s*\(\s*bridgeClaimed\s*\)\s*return\s+null/.test(preload)
  cases.push({
    name: 'preload 的领取函数是一次性的（第二次起返回 null）',
    ok: oneShot,
    detail: oneShot ? '__aikmClaimIpcBridge 有 bridgeClaimed 守卫' : '缺少 bridgeClaimed 一次性守卫',
  })

  // 4) 领取入口在渲染层领走后要被焚掉
  const aikm = readFileSync(join(root, 'src/lib/aikmIpc.ts'), 'utf8')
  const burnsEntry = /delete\s+\(window as unknown as Record<string, unknown>\)\.__aikmClaimIpcBridge/.test(aikm)
  cases.push({
    name: 'aikmIpc 领走后删除 window.__aikmClaimIpcBridge',
    ok: burnsEntry,
    detail: burnsEntry ? '已删除领取入口（仅作纵深防御：插件装载本来就晚于应用启动）' : '未删除领取入口',
  })

  // 5) meta：证明这张表真的抓得住每一种写法（一个永远通过的测试等于没有测试）
  const probes: Array<[string, boolean]> = [
    ['const api = (window as any).ipcRenderer', true],
    ['const api = (window as any)?.ipcRenderer', true],
    ['const api = (window as any).dsh?.agent', true],
    ["const api = window['ipcRenderer']", true],
    ['if (!window.ipcRenderer) return', true],
    ['const api = globalThis.dsh', true],
    ['const api = self.ipcRenderer', true],
    ['const api = aikmIpcOrNull()', false],
    ['const api = aikmDsh?.plugin', false],
    ['if (!aikmIpcAvailable()) return', false],
    ['const p = (window as any).__AIKM_HOST__', false],
    ['const a = (window as any).speechSynthesis', false],
  ]
  const misses = probes.filter(([line, shouldHit]) =>
    BRIDGE_WRITE_FORMS.some((f) => f.re.test(line)) !== shouldHit,
  )
  cases.push({
    name: 'meta: 形式表对 12 个样例的判定全部正确（含 5 个不应命中的邻近代码）',
    ok: misses.length === 0,
    detail: misses.length ? misses.map(([l]) => `误判：${l}`).join('；') : `${probes.length}/${probes.length} 正确`,
  })

  // 6) meta：扫描器确实会报出违规（用一个临时构造的样例文件内容验证，不落盘）
  const fakeHits = BRIDGE_WRITE_FORMS.filter((f) => f.re.test('const x = (window as any).dsh?.plugin'))
  cases.push({
    name: 'meta: 扫描器能报出 (window as any).dsh —— 这正是当初漏掉的形式',
    ok: fakeHits.length === 1 && fakeHits[0].label === '(window as any).dsh',
    detail: `命中 ${fakeHits.map((f) => f.label).join(', ') || '（无）'}`,
  })

  return cases
}

/** 命令行入口 */
export function logPluginIpcBridgeGuardSelfTest(): boolean {
  const cases = runPluginIpcBridgeGuardSelfTest()
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail.split('\n').join('\n      ')}`)
  }
  return cases.every((c) => c.ok)
}
