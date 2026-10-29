/**
 * word-to-markdown.selftest.ts — 旧版 Word（.doc）读取的纯逻辑防回归
 *
 * 守的约束：
 *  - `.doc` 的纯文本按段落转 Markdown（段落之间空行），制表符分隔的连续行还原成管道表格；
 *  - 行首制表符是缩进、不是表格；单元格竖线要转义；
 *  - 扩展名写错的 .doc（实际是 RTF / HTML / ZIP）按文件头分派，不能当二进制乱码；
 *  - RTF 兜底只取正文（字体表 / 图片 / 可忽略目的地不进正文），中文按 ansicpg 解码。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { docTextToMarkdown, wordToMarkdown } from './word-to-markdown'
import { rtfToText } from './rtf-text'

export interface WordMarkdownCase { name: string; ok: boolean; detail?: string }

export async function runWordMarkdownSelfTest(): Promise<WordMarkdownCase[]> {
  const cases: WordMarkdownCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 1. 纯文本段落 ----
  add('段落：每行独立成段（空行分隔）', docTextToMarkdown('第一段\n第二段') === '第一段\n\n第二段', JSON.stringify(docTextToMarkdown('第一段\n第二段')))
  add('段落：CRLF / BOM 归一化', docTextToMarkdown('\uFEFFa\r\nb\r\n') === 'a\n\nb', JSON.stringify(docTextToMarkdown('\uFEFFa\r\nb\r\n')))
  add('段落：空白行折叠，不产生连续空行', docTextToMarkdown('a\n\n\n\nb') === 'a\n\nb')
  add('段落：去掉残余控制字符', docTextToMarkdown('a\u0001b') === 'ab')
  add('段落：空文本返回空串', docTextToMarkdown('') === '')

  // ---- 2. 表格还原（word-extractor 用制表符分隔单元格） ----
  const table = docTextToMarkdown('姓名\t年龄\n张三\t18\n李四\t20')
  add(
    '表格：连续制表符行转管道表格（首行表头）',
    table === '| 姓名 | 年龄 |\n| --- | --- |\n| 张三 | 18 |\n| 李四 | 20 |',
    JSON.stringify(table),
  )
  add(
    '表格：行尾单元格标记（多余制表符）不产生空列',
    docTextToMarkdown('A\tB\t\n1\t2\t') === '| A | B |\n| --- | --- |\n| 1 | 2 |',
    JSON.stringify(docTextToMarkdown('A\tB\t\n1\t2\t')),
  )
  add(
    '表格：单元格竖线转义',
    docTextToMarkdown('a|b\tc\n1\t2').includes('| a\\|b | c |'),
    JSON.stringify(docTextToMarkdown('a|b\tc\n1\t2')),
  )
  add(
    '表格：行首制表符是缩进，不当表格',
    !docTextToMarkdown('\t缩进段落\n\t第二行').includes('|'),
    JSON.stringify(docTextToMarkdown('\t缩进段落\n\t第二行')),
  )
  add(
    '表格：单行制表符内容回退为普通段落（换两个空格）',
    docTextToMarkdown('键:\t值') === '键:  值',
    JSON.stringify(docTextToMarkdown('键:\t值')),
  )

  // ---- 3. RTF 兜底 ----
  const rtf = '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Arial;}}\\pard Hello\\par World\\par}'
  const rtfText = rtfToText(rtf)
  add('RTF：取正文并按 \\par 分段', rtfText.includes('Hello') && rtfText.includes('World') && rtfText.includes('\n'), JSON.stringify(rtfText))
  add('RTF：字体表不进正文', !rtfText.includes('Arial'), JSON.stringify(rtfText))
  add(
    'RTF：可忽略目的地（\\*）整组跳过',
    rtfToText('{\\rtf1{\\*\\generator Foo;}body}').trim() === 'body',
    JSON.stringify(rtfToText('{\\rtf1{\\*\\generator Foo;}body}')),
  )
  add(
    'RTF：图片（\\pict）不进正文',
    rtfToText('{\\rtf1{\\pict\\pngblip 89504e47}正文}').trim() === '正文',
    JSON.stringify(rtfToText('{\\rtf1{\\pict\\pngblip 89504e47}正文}')),
  )
  add(
    'RTF：ansicpg936 的 hex 字节按 GBK 解码',
    rtfToText("{\\rtf1\\ansi\\ansicpg936 \\'d6\\'d0\\'ce\\'c4\\par}").trim() === '中文',
    JSON.stringify(rtfToText("{\\rtf1\\ansi\\ansicpg936 \\'d6\\'d0\\'ce\\'c4\\par}")),
  )
  add(
    'RTF：\\uN Unicode 转义（含 ANSI 回退字符）',
    rtfToText('{\\rtf1\\ansi\\uc1 \\u20320?\\u22909?\\par}').trim() === '你好',
    JSON.stringify(rtfToText('{\\rtf1\\ansi\\uc1 \\u20320?\\u22909?\\par}')),
  )
  const rtfTable = docTextToMarkdown(rtfToText('{\\rtf1 A\\cell B\\cell\\row 1\\cell 2\\cell\\row}'))
  add(
    'RTF：\\cell / \\row 还原为管道表格',
    rtfTable === '| A | B |\n| --- | --- |\n| 1 | 2 |',
    JSON.stringify(rtfTable),
  )

  // ---- 4. 文件头分派 ----
  const rtfAsDoc = await wordToMarkdown({ buffer: Buffer.from(rtf, 'latin1') })
  add('分派：扩展名写错的 .doc（内容是 RTF）能读出正文', rtfAsDoc.includes('Hello') && rtfAsDoc.includes('World'), JSON.stringify(rtfAsDoc))
  const htmlAsDoc = await wordToMarkdown({
    buffer: Buffer.from('<html><body><h1>标题</h1><p>正文</p></body></html>', 'utf8'),
  })
  add('分派：扩展名写错的 .doc（内容是 HTML）转成 Markdown', htmlAsDoc.includes('# 标题') && htmlAsDoc.includes('正文'), JSON.stringify(htmlAsDoc))
  try {
    await wordToMarkdown({ buffer: Buffer.from('not a word document') })
    add('分派：无法识别的字节抛错而不是返回乱码', false, '没有抛错')
  } catch (e: any) {
    add('分派：无法识别的字节抛错而不是返回乱码', /无法识别/.test(String(e?.message || e)), String(e?.message || e))
  }

  // ---- 5. 真实 .doc（vendored 测试样本；未同步 vendor 时跳过） ----
  const fixture = path.resolve('vendor/genoffice/packages/file-parse/tests/fixtures/legacy-sample.doc')
  if (fs.existsSync(fixture)) {
    try {
      const md = await wordToMarkdown({ filePath: fixture, extractImages: false })
      add(
        '真实 .doc：word-extractor 读出正文',
        md.includes('Legacy Report') && md.includes('Second paragraph from Word 97-2003.'),
        JSON.stringify(md.slice(0, 120)),
      )
    } catch (e: any) {
      add('真实 .doc：word-extractor 读出正文', false, String(e?.message || e))
    }
  } else {
    console.log('[wordMarkdown] 未找到 vendored .doc 样本，跳过真实文件用例:', fixture)
  }

  return cases
}
