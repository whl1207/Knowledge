/**
 * searchMatch.selftest.ts — glob 匹配与搜索文本渲染的自测
 *
 * 覆盖：glob 语义（`*` / `**` / `?` / 前缀锚定 / 大小写）、filePattern 简写、
 * grep 文本按文件分组与截断页脚、glob 文本页眉与截断页脚。
 */

import { compileFileGlobs, globToRegExp, matchesFileGlob } from '@/shared/globMatch'
import { formatGlobText, formatGrepText } from '@/shared/searchText'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runSearchMatchSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- glob 语义 ----
  check('*.ts 命中根目录文件', matchesFileGlob('a.ts', '*.ts'))
  check('*.ts 命中子目录文件（任意深度）', matchesFileGlob('src/x/a.ts', '*.ts'))
  check('*.ts 不命中 .tsx', !matchesFileGlob('src/a.tsx', '*.ts'))
  check('*.ts 大小写不敏感（Windows 口径）', matchesFileGlob('A.TS', '*.ts'))
  check('src/**/*.vue 命中二级', matchesFileGlob('src/a/b.vue', 'src/**/*.vue'))
  check('src/**/*.vue 命中一级', matchesFileGlob('src/a.vue', 'src/**/*.vue'))
  check('src/**/*.vue 不命中同名的外包目录', !matchesFileGlob('lib/a.vue', 'src/**/*.vue'))
  check('**/* 命中任意路径', matchesFileGlob('a/b/c.txt', '**/*'))
  check('? 只匹配单字符', matchesFileGlob('a.ts', '?.ts') && !matchesFileGlob('ab.ts', '?.ts'))
  check('前缀锚定 /src/*.ts', matchesFileGlob('src/a.ts', '/src/*.ts') && !matchesFileGlob('x/src/a.ts', '/src/*.ts'))

  // ---- filePattern 简写 ----
  const shorthand = compileFileGlobs('.ts')
  check('.ts 简写按扩展名匹配', shorthand.length === 1 && shorthand[0].test('a/b.ts'))
  const multi = compileFileGlobs('*.ts, src/**/*.vue')
  check('逗号分隔多个 pattern', multi.length === 2 && multi[1].test('src/x/y.vue'))

  // ---- grep 文本 ----
  const grepText = formatGrepText(
    [
      { path: 'src/a.ts', line: 12, text: 'const x = 1' },
      { path: 'src/a.ts', line: 40, text: 'const y = 2' },
      { path: 'src/b.ts', line: 3, text: 'const z = 3' },
    ],
    { root: 'D:/w', query: 'const', shown: 3, totalHits: 3, files: 2, truncated: false },
  )
  check('grep：页眉含根与计数', grepText.startsWith('D:/w（关键词 "const"，命中 3 处 / 2 个文件'), grepText.split('\n')[0])
  check('grep：文件只出现一次（分组）', grepText.split('src/a.ts').length === 2, String(grepText.split('src/a.ts').length))
  check('grep：行号前缀', grepText.includes('  Line 12: const x = 1'))
  check('grep：无命中时明说', formatGrepText([], { root: 'D:/w', query: 'x', shown: 0, totalHits: 0, files: 0, truncated: false }).includes('没有匹配'))

  const grepTruncated = formatGrepText([{ path: 'a.ts', line: 1, text: 'x' }], {
    root: 'D:/w',
    query: 'x',
    shown: 1,
    totalHits: 99,
    files: 1,
    truncated: true,
  })
  check('grep：截断页脚给出总数与下一步', grepTruncated.includes('只显示了前 1 处') && grepTruncated.includes('共 99 处'))

  // ---- glob 文本 ----
  const globText = formatGlobText([{ path: 'a.md' }, { path: 'b/c.md' }], {
    root: 'D:/w',
    pattern: '*.md',
    total: 2,
    truncated: false,
    byMtime: true,
  })
  check('glob：页眉含模式与排序说明', globText.startsWith('D:/w（模式 "*.md"，按修改时间倒序，共 2 个）'), globText.split('\n')[0])
  check('glob：每行一个路径', globText.includes('\na.md\n') && globText.endsWith('b/c.md'))
  check(
    'glob：空结果明说',
    formatGlobText([], { root: 'D:/w', pattern: '*.xyz', total: 0, truncated: false }).includes('没有匹配的文件'),
  )
  const globTruncated = formatGlobText([{ path: 'a.md' }], { root: 'D:/w', pattern: '*.md', total: 42, truncated: true })
  check('glob：截断页脚', globTruncated.includes('只显示前 1 个') && globTruncated.includes('共 42 个'))

  // ---- 正则对象本身（保证不误吞特殊字符）----
  check('globToRegExp 转义点号', !globToRegExp('a.ts', { matchDir: false }).test('aXts'))

  return cases
}
