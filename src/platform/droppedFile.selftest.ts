/**
 * droppedFile.selftest.ts — 「拖入文件 → 磁盘真实路径」的防回归
 *
 * 真实事故：Chromium 从 Electron 32 起移除了非标准的 `File.path`。本项目升到
 * Electron 42 后，首页仍把 `file.name` 当路径交给主进程 `readFile`（相对路径必然
 * ENOENT），于是 Word / Excel / Markdown 拖进首页全部提示「读取失败」。
 * 当时 `globals.d.ts` 还给 `File` 增补了 `path: string`，类型检查因此完全看不见这个问题。
 *
 * 本套件锁定三件事：
 *   1. 取路径的语义：旧内核 file.path 优先，否则经 preload 桥；都没有 → 空串（走文本兜底）；
 *   2. 纯判定：哪些扩展名必须由宿主解析、哪些返回值是「读失败文本」；
 *   3. 源码护栏：preload 仍提供 webUtils 路径、home.vue 走 droppedFilePath、
 *      `globals.d.ts` 不再给 File 增补 path（否则同类回归会再次被类型系统掩盖）。
 *
 * 用法：`node scripts/run-selftests.mjs droppedFile`
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { droppedFilePath, isBinaryDocumentName } from './droppedFile'
import { isReadFailureText } from '@/shared/readText'

export interface DroppedFileCase {
  name: string
  ok: boolean
  detail?: string
}

/** 仓库根：自测产物在系统临时目录里，用 runner 注入的 NODE_PATH（<repo>/node_modules）反推 */
function repoRoot(): string {
  const np = process.env.NODE_PATH || ''
  return np ? resolve(np, '..') : process.cwd()
}

/** 造一个「拖入文件」替身（Node 里没有真实 File；被测逻辑只用到 name / path） */
function fakeFile(name: string, path?: string): File {
  return { name, path } as unknown as File
}

export function runDroppedFileSelfTest(): DroppedFileCase[] {
  const cases: DroppedFileCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1) 旧内核的 file.path 仍可直接用（有就不必跨桥）
  add('旧内核 file.path 直接采用', droppedFilePath(fakeFile('a.md', 'C:\\docs\\a.md')) === 'C:\\docs\\a.md')

  // 2) 没有 file.path、也没有宿主桥 → 空串（调用方据此走文本兜底 / 明确提示）
  add('无路径且无桥 → 空串', droppedFilePath(fakeFile('a.md')) === '')
  add('null / undefined → 空串', droppedFilePath(null) === '' && droppedFilePath(undefined) === '')

  // 3) 二进制文档判定：这些不能用 File.text() 当正文
  for (const n of ['a.docx', 'B.XLSX', 'c.pdf', 'd.ppt']) {
    add(`二进制文档：${n}`, isBinaryDocumentName(n), n)
  }
  for (const n of ['a.md', 'b.txt', 'c.kb', 'd.csv', 'e.json']) {
    add(`文本文件：${n}`, !isBinaryDocumentName(n), n)
  }

  // 4) 主进程把读失败当文本返回：必须识别，不能当正文附上
  add('识别 Error reading file', isReadFailureText('Error reading file: ENOENT: no such file'))
  add('识别 Error reading Excel file', isReadFailureText('Error reading Excel file: bad zip'))
  add('正常正文不算失败', !isReadFailureText('# 标题') && !isReadFailureText('') && !isReadFailureText(null))

  // 5) 源码护栏
  try {
    const repo = repoRoot()
    const preload = readFileSync(join(repo, 'electron', 'preload', 'index.ts'), 'utf8')
    add('preload 用 webUtils.getPathForFile 提供路径', /webUtils\.getPathForFile\s*\(/.test(preload))
    const home = readFileSync(join(repo, 'src', 'components', 'home.vue'), 'utf8')
    add('home.vue 拖入文件经 droppedFilePath 取路径', home.includes('droppedFilePath('))
    add('home.vue 不再把 file.name 当路径读取', !/readText\([^\n]*file\.name/.test(home))
    const globals = readFileSync(join(repo, 'globals.d.ts'), 'utf8')
    add('globals.d.ts 未给 File 增补 path', !/interface\s+File\s*\{[^}]*\bpath\b/.test(globals))
  } catch (e: any) {
    add('源码检查', false, String(e?.message || e))
  }

  // 6) 桥取路径。claim 是一次性的，必须放在所有「无桥」用例之后。
  ;(globalThis as any).window = {
    __aikmClaimIpcBridge: () => ({
      ipcRenderer: { getPathForFile: (f: File) => `D:\\disk\\${f.name}` },
      dsh: {},
    }),
  }
  add('无 file.path 时经 preload 桥取回真实路径', droppedFilePath(fakeFile('b.md')) === 'D:\\disk\\b.md')

  return cases
}

export function logDroppedFileSelfTest(): boolean {
  const cases = runDroppedFileSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[droppedFile] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
