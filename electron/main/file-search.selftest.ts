/**
 * file-search.selftest.ts — search_files 新版行为（纯 Node，临时目录）
 *
 * 覆盖：字面量 / 正则 / 大小写 / 文件过滤 / .gitignore / contextLines / 截断。
 */

import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFilesInRoot } from './file-search'

export interface FileSearchCase { name: string; ok: boolean; detail?: string }

export async function runFileSearchSelfTest(): Promise<FileSearchCase[]> {
  const cases: FileSearchCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const root = fs.mkdtempSync(join(tmpdir(), 'aikm-file-search-'))
  try {
    fs.mkdirSync(join(root, 'src'), { recursive: true })
    fs.mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(join(root, 'src', 'a.ts'), 'const foo = 1\nconst bar = 2\n')
    fs.writeFileSync(join(root, 'src', 'b.vue'), '<template><div>foo</div></template>\n')
    fs.writeFileSync(join(root, 'src', 'c.md'), 'FOO upper\n')
    fs.writeFileSync(join(root, 'node_modules', 'pkg', 'x.ts'), 'foo\n')
    fs.writeFileSync(join(root, 'ignored.ts'), 'foo\n')
    fs.writeFileSync(join(root, '.gitignore'), 'ignored.ts\nnode_modules/\n')

    const literal = await searchFilesInRoot({ root, query: 'foo' })
    const literalPaths = ((literal.value as any)?.results || []).map((r: any) => r.path)
    add(
      '字面量：默认大小写敏感，命中 a.ts / b.vue',
      literal.ok && literalPaths.length === 2 && literalPaths.includes('src/a.ts') && literalPaths.includes('src/b.vue'),
      JSON.stringify(literalPaths),
    )
    add('默认区分大小写：不命中 FOO', !literalPaths.includes('src/c.md'))
    add('默认忽略 node_modules', !(literal.value as any).results.some((r: any) => r.path.includes('node_modules')))
    add('默认遵守 .gitignore', !(literal.value as any).results.some((r: any) => r.path === 'ignored.ts'))

    const ci = await searchFilesInRoot({ root, query: 'foo', ignoreCase: true })
    add('ignoreCase=true：命中 FOO', (ci.value as any).results.some((r: any) => r.path === 'src/c.md'))

    const regex = await searchFilesInRoot({ root, query: 'const\\s+(foo|bar)', regex: true })
    add('正则：命中两行', regex.ok && (regex.value as any).results.length === 2, String((regex.value as any)?.results?.length))

    const legacyCs = await searchFilesInRoot({ root, query: 'foo', caseSensitive: false })
    add('旧参数 caseSensitive=false 仍按忽略大小写', (legacyCs.value as any).results.some((r: any) => r.path === 'src/c.md'))

    const glob = await searchFilesInRoot({ root, query: 'foo', filePattern: '*.vue' })
    add('文件过滤：只命中 .vue', glob.ok && (glob.value as any).results.length === 1 && (glob.value as any).results[0].path === 'src/b.vue')

    const ctx = await searchFilesInRoot({ root, query: 'bar', contextLines: 1 })
    const hit = (ctx.value as any).results.find((r: any) => r.path === 'src/a.ts')
    add('上下文行：before/after 存在', !!hit?.before?.length && !!hit?.after?.length, JSON.stringify(hit))
    add('模型可见文本：按文件分组并带行号', typeof (ctx.value as any).modelText === 'string' && /Line \d+:/.test((ctx.value as any).modelText))

    const capped = await searchFilesInRoot({ root, query: 'foo', maxResults: 1 })
    add(
      '截断：maxResults=1 时 truncated=true 且另有完整结果文本',
      capped.ok && (capped.value as any).truncated === true && (capped.value as any).results.length === 1
        && typeof (capped.value as any).overflowText === 'string',
    )

    const ac = new AbortController()
    ac.abort()
    const aborted = await searchFilesInRoot({ root, query: 'foo', signal: ac.signal })
    add('取消：已 abort 的 signal 直接返回 SEARCH_ABORTED', aborted.ok === false && aborted.code === 'SEARCH_ABORTED')
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return cases
}
