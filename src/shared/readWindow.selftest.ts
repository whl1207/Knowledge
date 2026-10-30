/**
 * readWindow.selftest.ts — 读取窗口的纯逻辑自测
 *
 * 覆盖：行号渲染、offset 越界、空文件、单行截断、行数/字符/字节上限、末页 footer、
 * 尾部换行不算多一行、CRLF 去尾。
 *
 * 由 `scripts/run-selftests.mjs`（esbuild 打包）执行。
 */

import { READ_MAX_LINES, renderReadWindow } from '@/shared/readWindow'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runReadWindowSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const doc = ['one', 'two', 'three', 'four'].join('\n')

  // 1) 正常窗口：行号 + 页眉 + 末页 footer
  const all = renderReadWindow(doc, 'a.md')
  check('整体读取 ok', all.ok === true)
  if (all.ok) {
    const w = all.window
    check('行号前缀正确', w.text.includes('1: one') && w.text.includes('4: four'), w.text)
    check('页眉含路径与总行数', w.text.startsWith('a.md（共 4 行）'), w.text.split('\n')[0])
    check('末页 footer', w.text.includes('已读到文件末尾') && w.text.includes('第 1-4 行'), w.text)
    check('末页没有 nextOffset', w.nextOffset === undefined && w.capped === false)
  }

  // 2) 中部窗口 + 续读锚点
  const mid = renderReadWindow(doc, 'a.md', { offsetLine: 2, maxLines: 2 })
  check(
    'offset=2 / limit=2 → 第 2-3 行',
    mid.ok === true && mid.window.startLine === 2 && mid.window.endLine === 3 && mid.window.nextOffset === 4,
    JSON.stringify(mid.ok && mid.window),
  )

  // 3) 越界：明确报错并给总行数
  const over = renderReadWindow(doc, 'a.md', { offsetLine: 99 })
  check(
    'offset 越界 → OUT_OF_RANGE 且带总行数',
    over.ok === false && over.code === 'OUT_OF_RANGE' && over.error.includes('共 4 行'),
    over.ok ? 'ok' : over.error,
  )

  // 4) 空文件：offset=1 合法
  const empty = renderReadWindow('', 'empty.md')
  check('空文件 offset=1 → ok 且 0 行', empty.ok === true && empty.window.totalLines === 0 && empty.window.text.includes('空文件'))

  // 5) 单行截断
  const longLine = 'x'.repeat(3000)
  const truncated = renderReadWindow(longLine, 'long.txt')
  check(
    '单行超 2000 字符 → 截断标注',
    truncated.ok === true && truncated.window.text.includes('已截断') && truncated.window.text.length < 2200,
    truncated.ok ? String(truncated.window.text.length) : 'fail',
  )

  // 6) 行数上限
  const many = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n')
  const byLines = renderReadWindow(many, 'many.txt', { maxLines: 10 })
  check(
    'maxLines=10 → 截断并给 nextOffset=11',
    byLines.ok === true && byLines.window.endLine === 10 && byLines.window.nextOffset === 11 && byLines.window.capped,
    JSON.stringify(byLines.ok && { end: byLines.window.endLine, next: byLines.window.nextOffset, capped: byLines.window.capped }),
  )
  check('默认上限与常量一致', READ_MAX_LINES === 2000)

  // 7) 字符预算上限
  const byChars = renderReadWindow(many, 'many.txt', { maxChars: 120 })
  check(
    'maxChars 触发 capped 且不超预算',
    byChars.ok === true && byChars.window.capped === true && byChars.window.nextOffset !== undefined,
    JSON.stringify(byChars.ok && { end: byChars.window.endLine, next: byChars.window.nextOffset }),
  )

  // 8) 字节预算上限（中文按 3 字节计）
  const zh = Array.from({ length: 40 }, (_, i) => `第${i + 1}行内容`).join('\n')
  const byBytes = renderReadWindow(zh, 'zh.txt', { maxBytes: 200 })
  check(
    'maxBytes 触发 capped',
    byBytes.ok === true && byBytes.window.capped === true && byBytes.window.endLine < 40,
    JSON.stringify(byBytes.ok && { end: byBytes.window.endLine }),
  )

  // 9) 尾部换行不算多一行；CRLF 去尾
  const trailing = renderReadWindow('a\nb\n', 't.txt')
  check('尾部换行不多算行', trailing.ok === true && trailing.window.totalLines === 2, String(trailing.ok && trailing.window.totalLines))
  const crlf = renderReadWindow('a\r\nb\r\n', 'c.txt')
  check('CRLF 不留 \\r', crlf.ok === true && !crlf.window.text.includes('\r'), crlf.ok ? JSON.stringify(crlf.window.text) : 'fail')

  return cases
}
