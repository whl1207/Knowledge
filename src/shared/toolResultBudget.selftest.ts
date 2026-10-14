/**
 * toolResultBudget.selftest.ts — 工具结果有界化自测（纯计算，不依赖 DOM / electron）
 *
 * 覆盖：未超阈值时逐字不变、阈值边界、headTail 掐中段、headOnly 只保头、
 * 码点切分不切断代理对（emoji）、预算自相矛盾时抛错、替换必须变小、
 * 续读提示在预算内、真实工具返回值形状（read_file）仍然可用。
 *
 * 用法（开发期）：
 *   import { runToolResultBudgetSelfTest } from '@/shared/toolResultBudget.selftest'
 *   console.table(runToolResultBudgetSelfTest())
 * 或命令行：`node --experimental-strip-types scripts/selftest/run-tool-result-budget.mjs`
 */

import {
  boundToolResult,
  boundToolResultText,
  buildSpillPreview,
  continuationHintFor,
  countCodePoints,
  budgetForTool,
  DEFAULT_TOOL_RESULT_BUDGET,
  PRUNE_MARKER,
  serializeToolValue,
  shouldSpill,
  spillPreviewBudgetForWindow,
  spillThresholdForWindow,
  toolResultBudgetForWindow,
  toolResultTokensForWindow,
  TOOL_RESULT_SPILL_BUDGET_MULTIPLE,
  TOOL_RESULT_TOKENS_MAX,
  TOOL_RESULT_TOKENS_MIN,
  TOOL_RESULT_WINDOW_RATIO,
  WORST_CASE_CHARS_PER_TOKEN,
  type ToolResultBudget,
} from './toolResultBudget'

export interface BudgetCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一段可控长度的文本（ASCII，1 字符 = 1 码点） */
function ascii(n: number, ch = 'a'): string {
  return ch.repeat(n)
}

/** 是否存在孤立代理项（半个 emoji）——真出现说明按 UTF-16 切了，不是按码点 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

export function runToolResultBudgetSelfTest(): BudgetCase[] {
  const cases: BudgetCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })
  const budget = DEFAULT_TOOL_RESULT_BUDGET
  const threshold = budget.thresholdChars

  // 1. 未超阈值：逐字不变，且不裁剪
  {
    const text = ascii(threshold - 1)
    const r = boundToolResultText(text, budget)
    add('未超阈值：原文不变', r.text === text && !r.pruned, `len=${r.originalChars}`)
    const t = boundToolResult('shell', true, { stdout: ascii(1000) })
    add('未超阈值：boundToolResult 不加提示', !t.pruned && t.model === t.raw)
  }

  // 2. 恰好等于阈值：仍算未超（与 DSH 的 `totalChars <= threshold` 同口径）
  {
    const text = ascii(threshold)
    const r = boundToolResultText(text, budget)
    add('恰好等于阈值：不裁剪', !r.pruned && r.text === text)
  }

  // 3. headTail：保头 + 尾，中段被换掉
  {
    const head = 'HEAD'.repeat(1)
    const text = 'S' + ascii(threshold * 2, 'M') + 'E' + head
    const r = boundToolResultText(text, budget)
    const startsWithS = r.text.startsWith('S')
    const endsWithTail = r.text.endsWith(head)
    const hasMarker = r.text.includes(PRUNE_MARKER.trim())
    const inBudget = countCodePoints(r.text) <= threshold
    add(
      'headTail：保头 + 标记 + 保尾',
      r.pruned && startsWithS && endsWithTail && hasMarker && inBudget,
      `before=${r.originalChars} after=${countCodePoints(r.text)}`,
    )
    add('headTail：丢弃量 = 原长 - 现长', r.omitted?.count === r.originalChars - countCodePoints(r.text))
  }

  // 4. headOnly：只保头（工具结果按相关性排序时用）
  {
    const text = ascii(threshold * 3, 'x')
    const r = boundToolResultText(text, { ...budget, strategy: 'headOnly' })
    const markerChars = countCodePoints(PRUNE_MARKER)
    add('headOnly：保留开头且不含尾部', r.pruned && r.text.startsWith('x'.repeat(100)) && r.text.endsWith(PRUNE_MARKER))
    add('headOnly：长度 ≈ 阈值 - 标记', countCodePoints(r.text) === threshold, `after=${countCodePoints(r.text)} marker=${markerChars}`)
    add('headOnly：在预算内', countCodePoints(r.text) <= threshold)
  }

  // 5. 策略按工具名分流
  {
    add('read_file 走 headOnly', budgetForTool('read_file').strategy === 'headOnly')
    add('list_dir / search_files 走 headOnly', budgetForTool('list_dir').strategy === 'headOnly' && budgetForTool('search_files').strategy === 'headOnly')
    add('shell / run_python 走 headTail', budgetForTool('shell').strategy === 'headTail' && budgetForTool('run_python').strategy === 'headTail')
  }

  // 6. 码点切分：emoji 不能被切成半个（否则模型看到乱码）
  {
    const text = '🙂'.repeat(threshold * 2)
    const r = boundToolResultText(text, budget)
    add('emoji：不产生孤立代理项', !hasLoneSurrogate(r.text), `after=${countCodePoints(r.text)}`)
    add('emoji：按码点计数', r.originalChars === threshold * 2)
    const headOnly = boundToolResultText(text, { ...budget, strategy: 'headOnly' })
    add('emoji（headOnly）：不产生孤立代理项', !hasLoneSurrogate(headOnly.text))
  }

  // 7. 预算自相矛盾：必须显式抛错，而不是悄悄发一个没变小的结果
  {
    let threw = false
    try {
      boundToolResultText(ascii(100), { thresholdChars: 20, headChars: 30, tailChars: 30, strategy: 'headTail' })
    } catch { threw = true }
    add('预算装不下头尾：抛错', threw)

    threw = false
    try {
      boundToolResultText(ascii(100), { thresholdChars: 20, headChars: 0, tailChars: 0, strategy: 'headTail' })
    } catch { threw = true }
    add('预算装不下标记：抛错', threw)

    threw = false
    try {
      boundToolResultText(ascii(100), { thresholdChars: 0, headChars: 1, tailChars: 1 })
    } catch { threw = true }
    add('阈值非正：抛错', threw)
  }

  // 8. 不变量：有界化结果**永远**严格小于原文（DSH 的 "replacement must be smaller" 同款约束）
  //    注："替换没变小" 那条内部断言在当前预算算术下不可达（见 toolResultBudget.ts 注释），
  //    所以这里验证的是它对**所有合法预算**都成立，而不是硬造一个非法预算去踩它。
  {
    const budgets: ToolResultBudget[] = [
      { thresholdChars: 150, headChars: 100, tailChars: 10, strategy: 'headTail' },
      { thresholdChars: 150, headChars: 50, tailChars: 60, strategy: 'headTail' },
      { thresholdChars: 60, headChars: 0, tailChars: 0, strategy: 'headOnly' },
      // 注意：headChars + 标记 + tailChars 必须 ≤ thresholdChars，否则是**非法预算**（会抛错，见用例 14/15）
      { thresholdChars: 100, headChars: 40, tailChars: 20, strategy: 'headTail' },
    ]
    let violations = 0
    let checked = 0
    for (const b of budgets) {
      for (const len of [b.thresholdChars + 1, b.thresholdChars * 2, 100_000]) {
        checked++
        const r = boundToolResultText(ascii(len), b)
        if (countCodePoints(r.text) >= len) violations++
        if (countCodePoints(r.text) > b.thresholdChars) violations++
      }
    }
    add('不变量：结果严格小于原文且不超预算', violations === 0, `checked=${checked} violations=${violations}`)
  }

  // 9. boundToolResult：整体（含续读提示）仍在预算内
  //    这里显式传 budget：本组用例验证的是**裁剪算术本身**，与窗口缩放无关
  //    （窗口缩放另有第 20~22 组用例）
  {
    const t = boundToolResult('shell', true, { stdout: ascii(threshold * 4) }, undefined, budget)
    add('boundToolResult：整体在预算内', countCodePoints(t.model) <= threshold, `after=${countCodePoints(t.model)}`)
    add('boundToolResult：带续读提示', t.model.includes('截断'))
    add('boundToolResult：raw 仍是原文', countCodePoints(t.raw) > threshold)
    add('boundToolResult：omitted 计量存在', (t.omitted?.count ?? 0) > 0)
  }

  // 10. 提示语本身也不能超出预算（预留机制）
  {
    const t = boundToolResult('read_file', true, { content: ascii(threshold * 6) }, undefined, budget)
    const hintChars = countCodePoints(continuationHintFor('read_file'))
    add('read_file：提示语非空', hintChars > 0)
    add('read_file：命中 headOnly 提示（含 nextOffset）', t.model.includes('nextOffset'))
    add('read_file：整体在预算内', countCodePoints(t.model) <= threshold)
  }

  // 11. 真实形状：read_file 的续读元数据必须还在（否则分页会断）
  {
    const value = {
      // 与 electron/main/tools.ts 和 src/lib/agent/rendererTools.ts 的实际产出**同序**：
      // 控制字段在 content 之前。顺序一旦回退，超长读取就会被截掉 nextOffset。
      path: '/kb/big.md',
      truncated: true,
      nextOffset: threshold * 3,
      content: ascii(threshold * 3, 'L'),
      chars: threshold * 3,
      lines: 10,
    }
    const t = boundToolResult('read_file', true, value, undefined, budget)
    add('read_file：确实被裁剪了（前提成立）', t.pruned)
    add('read_file：truncated / nextOffset 仍在头部', t.model.includes('"truncated":true') && t.model.includes('"nextOffset"'))
    add('read_file：仍能拿到 path', t.model.includes('/kb/big.md'))
    add('read_file：正文被截断（content 只留开头）', t.model.includes('"content":"LLL'))
  }

  // 12. 失败结果：短文本不动，长错误也受约束
  {
    const short = boundToolResult('shell', false, undefined, '命令不存在')
    add('错误结果：原文回灌', !short.pruned && short.model === 'ERROR: 命令不存在')
    const long = boundToolResult('shell', false, undefined, ascii(threshold * 2, 'E'), budget)
    add('长错误：被约束在预算内', countCodePoints(long.model) <= threshold)
  }

  // 13. 序列化口径与 deriveMessages 一致
  {
    add('serialize：对象 → JSON', serializeToolValue(true, { a: 1 }) === '{"a":1}')
    add('serialize：undefined → null', serializeToolValue(true, undefined) === 'null')
    add('serialize：失败 → ERROR 前缀', serializeToolValue(false, undefined, 'x') === 'ERROR: x')
  }

  // 14. 未知工具走默认策略 + 通用提示
  {
    const t = boundToolResult('some_future_tool', true, { blob: ascii(threshold * 2) }, undefined, budget)
    add('未知工具：headTail + 整体在预算内', countCodePoints(t.model) <= threshold && t.model.includes('截断'))
  }

  // 15. 极端值：预算刚好等于"标记 + 1"，headOnly 仍应能收口
  {
    const tiny: ToolResultBudget = { thresholdChars: 60, headChars: 0, tailChars: 0, strategy: 'headOnly' }
    let ok = false
    let detail = ''
    try {
      const r = boundToolResultText(ascii(500), tiny)
      ok = r.pruned && countCodePoints(r.text) <= tiny.thresholdChars
      detail = `after=${countCodePoints(r.text)}`
    } catch (e: any) { detail = String(e?.message || e) }
    add('极小预算（headOnly）：仍能收口', ok, detail)
  }

  // 16. 第二层（spill）：落盘门槛按窗口缩放，且必定高于第一层门槛
  {
    for (const w of [32_000, 128_000, 1_000_000]) {
      const thr = spillThresholdForWindow(w)
      const pruner = toolResultBudgetForWindow(w).thresholdChars
      add(`spill 门槛高于剪枝门槛（窗口 ${w}）`, thr > pruner, `spill=${thr} pruner=${pruner}`)
      add(`spill 门槛 = 第一层预算 × ${TOOL_RESULT_SPILL_BUDGET_MULTIPLE}`, thr === pruner * TOOL_RESULT_SPILL_BUDGET_MULTIPLE)
      add(`shouldSpill 与门槛一致（窗口 ${w}）`, !shouldSpill(ascii(thr), w) && shouldSpill(ascii(thr + 1), w))
    }
    // 关键回归：32K 窗口下必须**可达**（改造前固定 200K 门槛 > 剪枝门槛，是死代码）
    const w32 = 32_000
    const pruner32 = toolResultBudgetForWindow(w32).thresholdChars
    add('32K：落盘门槛可达（<= read_file 单次上限 100K）', spillThresholdForWindow(w32) <= 100 * 1024, `spill=${spillThresholdForWindow(w32)}`)
    add('32K：剪枝后仍可能触发落盘（门槛 > 第一层）', spillThresholdForWindow(w32) > pruner32)
    add('大窗口：门槛随之放大（不是死值）', spillThresholdForWindow(1_000_000) > spillThresholdForWindow(128_000))
  }

  // 17. 第二层：落盘预览的形状与预算（按窗口）
  {
    const w = 32_000
    const budget = spillPreviewBudgetForWindow(w)
    const raw = ascii(spillThresholdForWindow(w) * 2, 'R')
    const ref = { path: '/tmp/aikm-spill-Ab12Cd/session-0123456789ab/deadbeef-shell.txt', bytes: raw.length }
    const p = buildSpillPreview(raw, ref, w)
    add('spill 预览：整体不超过预览预算', p.previewChars <= budget.thresholdChars, `preview=${p.previewChars} budget=${budget.thresholdChars}`)
    add('spill 预览：带落盘路径', p.text.includes(ref.path))
    add('spill 预览：明确要求回读', p.text.includes('read_file'))
    add('spill 预览：头尾都被保留（中间才是丢掉的）', p.text.startsWith('RRR') && /R{100}/.test(p.text.slice(0, p.text.indexOf('[... middle pruned ...]'))))
    add('spill 预览：原文长度如实记录', p.originalChars === countCodePoints(raw))
    add('spill 预览：路径原样进 ref', p.ref.path === ref.path && p.ref.bytes === ref.bytes)
  }

  // 18. 两级联动（模拟 agent-loop 的判定顺序，用显式 budget 隔离窗口缩放）
  {
    const mid = ascii(DEFAULT_TOOL_RESULT_BUDGET.thresholdChars + 5000, 'M')
    const t = boundToolResult('shell', true, { stdout: mid }, undefined, budget)
    // 默认预算下：超剪枝门槛但远未到落盘门槛 → 只有第一层
    add('两级：中等超限只剪枝、不落盘', t.pruned && !shouldSpill(t.raw), `raw=${t.originalChars}`)
    add('两级：中等超限仍带续读提示', t.model.includes('截断'))
  }

  // 19. 引擎自造诊断（diagnostic）不套工具专属提示
  //     反例：read_file 的提示说"用 nextOffset 继续读"，但白名单拦截这类消息里根本没有该字段
  {
    const longError = 'E'.repeat(threshold * 2)
    const withHint = boundToolResult('read_file', false, undefined, longError, budget)
    const withoutHint = boundToolResult('read_file', false, undefined, longError, budget, { skipContinuationHint: true })
    add('diagnostic：默认会给 read_file 续读提示（含 nextOffset）', withHint.model.includes('nextOffset'))
    add('diagnostic：skip 后不再出现误导性的 nextOffset', !withoutHint.model.includes('nextOffset'))
    add('diagnostic：仍然被裁剪且有标记', withoutHint.pruned && withoutHint.model.includes('middle pruned'))
    add('diagnostic：仍在预算内', countCodePoints(withoutHint.model) <= threshold)
    add('diagnostic：原文不受影响（raw 仍完整）', withoutHint.raw === withHint.raw)
  }

  // 20. 按窗口缩放（本轮核心）：三档窗口下的预算占比
  {
    // 目标：单条工具结果 ≤ 窗口的 ~12%（token 计），且预算随窗口放大
    const tiers: Array<{ w: number; label: string }> = [
      { w: 32_000, label: '32K' },
      { w: 128_000, label: '128K' },
      { w: 1_000_000, label: '1M' },
    ]
    for (const { w, label } of tiers) {
      const tokens = toolResultTokensForWindow(w)
      const budget = toolResultBudgetForWindow(w)
      const shareOfWindow = tokens / w
      add(`${label}：预算 token 在 [${TOOL_RESULT_TOKENS_MIN}, ${TOOL_RESULT_TOKENS_MAX}] 内`, tokens >= TOOL_RESULT_TOKENS_MIN && tokens <= TOOL_RESULT_TOKENS_MAX, `tokens=${tokens}`)
      // 小窗口按比例；大窗口被上限夹住（此时占比天然小于比例）
      add(`${label}：占比不超过 ${(TOOL_RESULT_WINDOW_RATIO * 100).toFixed(0)}%`, shareOfWindow <= TOOL_RESULT_WINDOW_RATIO + 1e-9, `share=${(shareOfWindow * 100).toFixed(1)}%`)
      add(`${label}：码点预算 = token × 最坏比`, budget.thresholdChars === tokens * WORST_CASE_CHARS_PER_TOKEN, `chars=${budget.thresholdChars}`)
      add(`${label}：头+尾不超过阈值`, budget.headChars + budget.tailChars <= budget.thresholdChars)
    }
    add('32K 的预算严格小于 128K', toolResultTokensForWindow(32_000) < toolResultTokensForWindow(128_000))
    add('128K 的预算严格小于 1M', toolResultTokensForWindow(128_000) < toolResultTokensForWindow(1_000_000))
    add('1M 落在上限（大窗口行为与改造前一致）', toolResultTokensForWindow(1_000_000) === TOOL_RESULT_TOKENS_MAX)
    add('32K 按 12% 计 ≈ 3840 token', toolResultTokensForWindow(32_000) === 3_840, `got=${toolResultTokensForWindow(32_000)}`)
    add('未知窗口 → 回落上限（不缩小既有行为）', toolResultTokensForWindow(undefined) === TOOL_RESULT_TOKENS_MAX)
    add('窗口为 0 / 负数 → 回落上限', toolResultTokensForWindow(0) === TOOL_RESULT_TOKENS_MAX && toolResultTokensForWindow(-5) === TOOL_RESULT_TOKENS_MAX)
    add('极小窗口被下限托住（工具不至于不可用）', toolResultTokensForWindow(1_000) === TOOL_RESULT_TOKENS_MIN)
  }

  // 21. 关键回归：32K 窗口下，一次 100KB read_file 结果被压到窗口的 ~12% 以内
  {
    const w = 32_000
    const value = {
      path: '/kb/big.md',
      truncated: true,
      nextOffset: 100_000,
      content: ascii(100_000, 'L'),
      chars: 100_000,
      lines: 900,
    }
    const t = boundToolResult('read_file', true, value, undefined, undefined, { windowTokens: w })
    const budget = toolResultBudgetForWindow(w)
    add('32K：100KB 读取被裁剪', t.pruned)
    add('32K：模型可见不超过该窗口预算', countCodePoints(t.model) <= budget.thresholdChars, `model=${countCodePoints(t.model)} budget=${budget.thresholdChars}`)
    add('32K：控制字段仍在头部', t.model.includes('"truncated":true') && t.model.includes('"nextOffset"'))
    add('32K：带续读提示', t.model.includes('nextOffset'))
    // 对比：同一结果在"未知窗口/大窗口保底预算"下明显更大（→ 证明缩放真的生效）
    const tBig = boundToolResult('read_file', true, value, undefined, undefined, { windowTokens: 1_000_000 })
    add('同结果在大窗口预算下明显更大', countCodePoints(tBig.model) > countCodePoints(t.model) * 2, `big=${countCodePoints(tBig.model)} small=${countCodePoints(t.model)}`)
  }

  // 22. 32K 下 spill 真正被触发（改造前是死代码）
  {
    const w = 32_000
    // 构造一个超过该窗口落盘门槛的原始结果
    const rawLen = spillThresholdForWindow(w) + 1_000
    const value = { stdout: ascii(rawLen, 'Z') }
    const bound = boundToolResult('shell', true, value, undefined, undefined, { windowTokens: w })
    add('32K：大结果已裁剪', bound.pruned)
    add('32K：原始结果超过落盘门槛', shouldSpill(bound.raw, w), `raw=${countCodePoints(bound.raw)} thr=${spillThresholdForWindow(w)}`)
    const ref = { path: '/tmp/aikm-spill-XXXXXX/session-0123456789ab/abc-shell.txt', bytes: countCodePoints(bound.raw) }
    const preview = buildSpillPreview(bound.raw, ref, w)
    add('32K：落盘预览在预算内', preview.previewChars <= spillPreviewBudgetForWindow(w).thresholdChars, `preview=${preview.previewChars}`)
    add('32K：落盘预览带可回读路径', preview.text.includes(ref.path) && preview.text.includes('read_file'))
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logToolResultBudgetSelfTest(): boolean {
  const cases = runToolResultBudgetSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[toolResultBudget] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
