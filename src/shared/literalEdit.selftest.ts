/**
 * literalEdit.selftest.ts — 字面量替换纯逻辑的自测
 *
 * 覆盖主进程 / 渲染层共用的那套判定：唯一性、replace_all、occurrence、空操作拒绝、
 * 换行归一、区间重叠、以及"与传入顺序无关"的落点拼装。
 *
 * 由 `scripts/run-selftests.mjs`（esbuild 打包）执行。
 */

import {
  applyLiteralEdits,
  collectOccurrences,
  detectEol,
  lineNumberAt,
  locateLiteralMatches,
  toFileEol,
  type LiteralEdit,
} from '@/shared/literalEdit'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runLiteralEditSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 基础工具 ----
  check('detectEol 认 CRLF', detectEol('a\r\nb') === '\r\n')
  check('detectEol 认 LF', detectEol('a\nb') === '\n')
  check('toFileEol 归一后转 CRLF', toFileEol('a\nb', '\r\n') === 'a\r\nb')
  check('toFileEol 不重复处理 CRLF', toFileEol('a\r\nb', '\r\n') === 'a\r\nb')
  check('collectOccurrences 升序不重叠', JSON.stringify(collectOccurrences('aa aa', 'aa')) === '[0,3]')
  check('lineNumberAt 1 起', lineNumberAt('a\nb\nc', 4) === 3 && lineNumberAt('a\nb\nc', 2) === 2, `${lineNumberAt('a\nb\nc', 4)}/${lineNumberAt('a\nb\nc', 2)}`)

  // ---- 唯一替换 ----
  const doc = 'line1\nalpha\nline3\n'
  const unique = locateLiteralMatches(doc, 'alpha', 'beta')
  check('唯一命中 → ok', unique.ok === true)
  if (unique.ok) {
    check('唯一命中 → 恰好 1 笔', unique.matches.length === 1, String(unique.matches.length))
    const applied = applyLiteralEdits(doc, unique.matches.map((m) => ({ ...m, newText: unique.newText })))
    check('唯一命中 → 结果正确', applied.ok === true && applied.text === 'line1\nbeta\nline3\n', JSON.stringify(applied))
  }

  // ---- 多命中：默认 fail-closed ----
  const dup = 'x\nsame\nx\nsame\n'
  const ambiguous = locateLiteralMatches(dup, 'same', 'other')
  check(
    '多命中 → AMBIGUOUS 且带行号',
    ambiguous.ok === false && ambiguous.code === 'AMBIGUOUS' && JSON.stringify(ambiguous.lines) === '[2,4]',
    JSON.stringify(ambiguous),
  )

  // ---- replace_all ----
  const all = locateLiteralMatches(dup, 'same', 'other', { replaceAll: true })
  check('replace_all → 两笔', all.ok === true && all.matches.length === 2 && all.hitCount === 2)
  if (all.ok) {
    const applied = applyLiteralEdits(dup, all.matches.map((m) => ({ ...m, newText: all.newText })))
    check('replace_all → 全部替换', applied.ok === true && applied.text === 'x\nother\nx\nother\n', JSON.stringify(applied))
  }

  // ---- occurrence ----
  const second = locateLiteralMatches(dup, 'same', 'other', { occurrence: 2 })
  check('occurrence=2 → 只取第二处', second.ok === true && second.matches.length === 1 && second.matches[0].startLine === 4)
  const overflow = locateLiteralMatches(dup, 'same', 'other', { occurrence: 99 })
  check('occurrence 越界 → OUT_OF_RANGE', overflow.ok === false && overflow.code === 'OUT_OF_RANGE')

  // ---- 空操作 / 空 old（对齐 DSH 的 "must differ"） ----
  const noop = locateLiteralMatches(doc, 'alpha', 'alpha')
  check('old === new → NOOP', noop.ok === false && noop.code === 'NOOP')
  const emptyOld = locateLiteralMatches(doc, '', 'x')
  check('old 为空 → EMPTY_OLD', emptyOld.ok === false && emptyOld.code === 'EMPTY_OLD')

  // ---- 未命中 ----
  const missing = locateLiteralMatches(doc, 'nope', 'x')
  check('未命中 → NOT_FOUND', missing.ok === false && missing.code === 'NOT_FOUND')

  // ---- 换行风格：模型发 \n，文件是 CRLF ----
  const crlf = 'a\r\nbeta\r\nc\r\n'
  const eolCase = locateLiteralMatches(crlf, 'beta\n', 'gamma\n')
  check('CRLF 文件接受 LF 的 old（归一后命中）', eolCase.ok === true && eolCase.hitCount === 1)
  if (eolCase.ok) {
    check('新内容写回时用文件自己的 EOL', eolCase.newText === 'gamma\r\n', JSON.stringify(eolCase.newText))
    const applied = applyLiteralEdits(crlf, eolCase.matches.map((m) => ({ ...m, newText: eolCase.newText })))
    check('CRLF 落盘结果', applied.ok === true && applied.text === 'a\r\ngamma\r\nc\r\n', JSON.stringify(applied))
  }

  // ---- 重叠感染 ----
  const overlapEdits: LiteralEdit[] = [
    { index: 0, length: 5, startLine: 1, endLine: 1, oldText: 'hello', newText: 'A' },
    { index: 3, length: 5, startLine: 1, endLine: 1, oldText: 'lo wo', newText: 'B' },
  ]
  const overlap = applyLiteralEdits('hello world', overlapEdits)
  check('区间重叠 → overlap', overlap.ok === false && overlap.reason === 'overlap')

  // ---- 与传入顺序无关（降序应用） ----
  const src = 'one two three'
  const editA = locateLiteralMatches(src, 'one', '1')
  const editB = locateLiteralMatches(src, 'three', '3')
  if (editA.ok && editB.ok) {
    const planned: LiteralEdit[] = [
      { ...editB.matches[0], newText: editB.newText },
      { ...editA.matches[0], newText: editA.newText },
    ]
    const applied = applyLiteralEdits(src, planned)
    check('逆序传入仍按偏移正确应用', applied.ok === true && applied.text === '1 two 3', JSON.stringify(applied))
  }

  // ---- 落盘前校验（内容拼装期间被改过） ----
  const stale: LiteralEdit[] = [{ index: 0, length: 5, startLine: 1, endLine: 1, oldText: 'HELLO', newText: 'X' }]
  const mismatch = applyLiteralEdits('hello', stale)
  check('命中段不再匹配 → mismatch', mismatch.ok === false && mismatch.reason === 'mismatch')

  return cases
}
