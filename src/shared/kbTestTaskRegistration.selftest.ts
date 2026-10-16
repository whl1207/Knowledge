/**
 * kbTestTaskRegistration.selftest.ts — 「批量测试结束后必须注销后台任务登记」的源码级防回归
 *
 * 背景（真实踩坑）：知识库评测（`src/components/knowRAG/testManager.vue`）在开跑前把
 * 「知识库评测」登记进后台任务表（`src/store/runningTasks.ts` 的 `setRunningTask('kb:test', …)`），
 * 目的是让关窗前的提醒与托盘提示知道「还有几十分钟的评测在跑」。
 * 但只有「批量测试（当前策略）」这条路径在结束处调了 `endGlobalTestRun()`；
 * 「批量测试所有策略」跑完后没有注销 → 登记永久残留 → 评测明明已经结束，点关闭按钮仍被
 * 「后台仍有任务在运行：知识库评测」拦下，托盘也一直挂着假任务。
 *
 * 这类问题 vue-tsc 查不出（两边都是合法调用），运行时也不报错（只是状态残留），
 * 因此这里按 `draggableSlot.selftest.ts` 的思路做**源码级**检查：
 *   1. 用合成样例验证「检查器本身」能抓出「登记了但没注销」的函数（一个永远通过的测试等于没有测试）；
 *   2. 拿真实的 testManager.vue 检查：两条批量测试路径都必须在结束处注销，
 *      且「实时进度文本清空」时还有一层兜底注销（覆盖今后新增的提前退出分支）。
 *
 * 用法：`node scripts/run-selftests.mjs kbTestTask`
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface KbTestTaskCase {
  name: string
  ok: boolean
  detail?: string
}

/** 仓库根：自测产物在系统临时目录里，用 runner 注入的 NODE_PATH（<repo>/node_modules）反推 */
function repoRoot(): string {
  const np = process.env.NODE_PATH || ''
  return np ? resolve(np, '..') : process.cwd()
}

/** 源码里的一段区间（start/end 为以 0 计的下标，text 含两端） */
export interface BraceSlice {
  start: number
  end: number
  text: string
}

/**
 * 从 `openIdx`（必须是 `{`）起取出一段配平的大括号区间。
 * 模板字符串里的 `${ … }` 同样是配平的，因此朴素计数在这里够用（本文件只用它切函数体）。
 */
export function sliceBraces(source: string, openIdx: number): BraceSlice | null {
  if (source[openIdx] !== '{') return null
  let depth = 0
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return { start: openIdx, end: i, text: source.slice(openIdx, i + 1) }
    }
  }
  return null
}

/** 取出 `const <name> = … => { … }` 这类箭头函数的函数体（从第一个 `{` 起配平）；找不到返回 null */
export function extractFunctionBody(source: string, name: string): BraceSlice | null {
  const decl = new RegExp('const\\s+' + name + '\\s*=(?![\\w$])')
  const m = decl.exec(source)
  if (!m) return null
  const openIdx = source.indexOf('{', m.index)
  if (openIdx < 0) return null
  return sliceBraces(source, openIdx)
}

/** 取出 `watch(<anchor>, …) => { … }` 的回调函数体；找不到返回 null */
export function extractWatchBody(source: string, anchor: string): BraceSlice | null {
  const idx = source.indexOf('watch(' + anchor)
  if (idx < 0) return null
  const openIdx = source.indexOf('{', idx)
  if (openIdx < 0) return null
  return sliceBraces(source, openIdx)
}

/** 后台任务登记 / 注销用的函数名（与 testManager.vue 内的常量 KB_TEST_TASK_ID 配对使用） */
const BEGIN = 'beginGlobalTestRun('
const END = 'endGlobalTestRun('

export interface KbTaskRegistrationReport {
  /** 两条批量测试路径：是否在函数体里注销了后台任务 */
  runPaths: Array<{ fn: string; hasEnd: boolean; found: boolean }>
  /** 实时进度文本清空时的兜底注销 */
  liveTextFallback: boolean
  /** 每个「登记后台任务」的调用点是否都落在会注销它的函数体里 */
  beginCalls: Array<{ located: boolean; released: boolean }>
  /** 结论（为空 = 通过） */
  issues: string[]
}

/**
 * 检查 `testManager.vue` 源码里的「登记 → 注销」生命周期。
 * 判定标准：每一个 `beginGlobalTestRun(…)` 调用点，都必须位于某个
 * 结尾调用了 `endGlobalTestRun()` 的函数体内部（当前即两条批量测试路径）。
 */
export function inspectKbTestTaskRegistration(source: string): KbTaskRegistrationReport {
  const runFns = ['runBatchTest', 'runAllStrategyTest']
  const bodies = runFns.map((fn) => ({ fn, slice: extractFunctionBody(source, fn) }))

  const runPaths = bodies.map((b) => ({
    fn: b.fn,
    found: !!b.slice,
    hasEnd: !!b.slice && b.slice.text.includes(END),
  }))

  const watchSlice = extractWatchBody(source, 'batchLiveText')
  const liveTextFallback = !!watchSlice && watchSlice.text.includes(END)

  // 所有登记调用点（排除函数声明 `const beginGlobalTestRun = …`）
  const callIdx: number[] = []
  for (let i = source.indexOf(BEGIN); i >= 0; i = source.indexOf(BEGIN, i + 1)) {
    const lineStart = source.lastIndexOf('\n', i) + 1
    if (source.slice(lineStart, i).includes('const ')) continue // 声明，不是调用
    callIdx.push(i)
  }
  const beginCalls = callIdx.map((i) => {
    const owner = bodies.find((b) => b.slice && i > b.slice.start && i < b.slice.end)
    return { located: !!owner, released: !!owner && owner.slice!.text.includes(END) }
  })

  const issues: string[] = []
  for (const p of runPaths) {
    if (!p.found) issues.push(`找不到函数 ${p.fn}（可能被重命名：请同步更新本自测）`)
    else if (!p.hasEnd) issues.push(`${p.fn} 结束后没有调用 ${END.slice(0, -1)}：后台任务登记会永久残留`)
  }
  if (!watchSlice) issues.push('找不到 watch(batchLiveText)（实时进度文本的兜底注销不见了：请同步更新本自测）')
  else if (!liveTextFallback) issues.push('watch(batchLiveText) 在进度文本清空时没有注销后台任务（提前退出的分支会留下假任务）')
  for (const c of beginCalls) {
    if (!c.located) issues.push('存在登记调用点不在受检的批量测试函数里（新增路径必须一并注销）')
    else if (!c.released) issues.push('存在登记调用点所在的函数不注销后台任务')
  }
  if (callIdx.length === 0) issues.push('源码里找不到任何 beginGlobalTestRun 调用点（请同步更新本自测）')

  return { runPaths, liveTextFallback, beginCalls, issues }
}

export function runKbTestTaskRegistrationSelfTest(): KbTestTaskCase[] {
  const cases: KbTestTaskCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 切分器本身：能配平模板字符串里的 ${ … } 与嵌套对象
  const sample = [
    'const runBatchTest = async () => {',
    '  const pct = `${Math.round((1 + 2) / 3 * 100)}%`',
    '  beginGlobalTestRun(1)',
    '  return { a: { b: 1 } }',
    '}',
    'const next = 1',
  ].join('\n')
  const body = extractFunctionBody(sample, 'runBatchTest')
  add('切分器：能取出函数体且在正确的 `}` 上收尾', !!body && body.text.includes('beginGlobalTestRun(1)') && !body.text.includes('const next'),
    body ? `end=${body.end}` : 'null')

  // 2. 检查器本身：合成「登记了但没注销」的坏样例必须判失败（防止本自测永远通过）
  const badSource = [
    'const runBatchTest = async () => {',
    '  beginGlobalTestRun(1)',
    '  endGlobalTestRun()',
    '}',
    'const runAllStrategyTest = async () => {',
    '  beginGlobalTestRun(0)',
    '}',
    'watch(batchLiveText, (v) => {',
    '  if (!v) return',
    '})',
  ].join('\n')
  const bad = inspectKbTestTaskRegistration(badSource)
  add('检查器：抓得到「全部策略跑完没注销」', bad.issues.some((s) => s.includes('runAllStrategyTest')), bad.issues.join(' | '))
  add('检查器：抓得到「实时文本清空时不兜底注销」', bad.issues.some((s) => s.includes('watch(batchLiveText)')), bad.issues.join(' | '))

  const goodSource = [
    'const runBatchTest = async () => {',
    '  beginGlobalTestRun(1)',
    '  endGlobalTestRun()',
    '}',
    'const runAllStrategyTest = async () => {',
    '  beginGlobalTestRun(0)',
    '  endGlobalTestRun()',
    '}',
    'watch(batchLiveText, (v) => {',
    '  if (!v) { endGlobalTestRun(); return }',
    '})',
  ].join('\n')
  const good = inspectKbTestTaskRegistration(goodSource)
  add('检查器：好样例（两条路径都注销）判定通过', good.issues.length === 0, good.issues.join(' | '))

  // 3. 真实文件：testManager.vue 的登记 / 注销生命周期
  try {
    const src = readFileSync(join(repoRoot(), 'src', 'components', 'knowRAG', 'testManager.vue'), 'utf8')
    const report = inspectKbTestTaskRegistration(src)
    add('testManager.vue：登记 → 注销生命周期完整（关窗不再误拦「知识库评测」）', report.issues.length === 0, report.issues.join(' | '))
    add('testManager.vue：两条批量测试路径都注销后台任务',
      report.runPaths.length === 2 && report.runPaths.every((p) => p.found && p.hasEnd),
      report.runPaths.map((p) => `${p.fn}=${p.found ? (p.hasEnd ? 'ok' : '未注销') : '未找到'}`).join(', '))
    add('testManager.vue：进度文本清空时兜底注销', report.liveTextFallback)
    add('testManager.vue：每个登记调用点都在会注销的函数里',
      report.beginCalls.length > 0 && report.beginCalls.every((c) => c.located && c.released),
      `calls=${report.beginCalls.length}`)
  } catch (err: any) {
    add('testManager.vue：读取失败', false, String(err?.message || err))
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logKbTestTaskRegistrationSelfTest(): boolean {
  const cases = runKbTestTaskRegistrationSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[kbTestTaskRegistration] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
