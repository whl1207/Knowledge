/**
 * Word → Markdown 统一入口（`.docx` 继续走 mammoth 管线，旧版 `.doc` 走 word-extractor）
 *
 * 供所有「读 Word 正文」的路径复用：
 *  - `index.ts` 的 `readFile`（文件浏览 / 聊天附件 / 知识库规范化）
 *  - `index.ts` 的 `docxToMarkdown` IPC（远程 Word 预览）
 *  - `tools.ts` 的 `read_file`（智能体读取正文）
 *  - `office-ai.ts` 的知识库取文
 *
 * 为什么按**文件头**而不是扩展名分派：
 *  - 真正的 `.docx` 是 ZIP，`.doc` 是 OLE2 复合文档；现实中改扩展名的文件很常见
 *    （.docx 改名 .doc，或 .doc 改名 .docx），只看扩展名总有一边会读成乱码；
 *  - 部分工具还会把 `.doc` 存成 RTF 或 HTML，这里一并兜住。
 *
 * `.doc` 的能力边界：word-extractor 只还原纯文本（Word 97-2003 的标题样式、图片、公式
 * 没有对外暴露），所以这里只做「段落 + 管道表格」的 Markdown 化，不产生图片引用，
 * 也不承诺 `.docx` 级别的排版还原（标题层级丢失，目录收不到 `.doc` 里的标题）。
 */
import * as fs from 'node:fs'
import WordExtractor from 'word-extractor'
import { docxToMarkdown, htmlToMarkdown } from './docx-to-markdown'
import { rtfToText } from './rtf-text'

export interface WordToMarkdownInput {
  /** 本地文件路径（与 buffer 二选一） */
  filePath?: string
  /** 文件内容（远程预览用，与 filePath 二选一） */
  buffer?: Buffer
  /** `.docx` 图片缓存目录（`.doc` 不提取图片，忽略此项） */
  mediaDir?: string
  /** 是否提取 `.docx` 图片（默认 true）；仅需纯文本时设为 false */
  extractImages?: boolean
}

/** ZIP 头：OOXML（.docx / .xlsx / .pptx，含改名为 .doc 的文件） */
function isZip(raw: Buffer): boolean {
  return raw.length >= 2 && raw[0] === 0x50 && raw[1] === 0x4b
}

/** OLE2 复合文档头：Word 97-2003 二进制（真正的 .doc） */
function isOle2(raw: Buffer): boolean {
  return raw.length >= 4 && raw[0] === 0xd0 && raw[1] === 0xcf && raw[2] === 0x11 && raw[3] === 0xe0
}

/** RTF 头：少数工具把 .doc 存成 RTF */
function isRtf(raw: Buffer): boolean {
  // latin1 下 UTF-8 BOM 会显示成 ï»¿，两种 BOM 写法都要能跳过
  const head = raw.subarray(0, 512).toString('latin1').replace(/^(\u00EF\u00BB\u00BF|\uFEFF)/, '').trimStart()
  return head.startsWith('{\\rtf')
}

/** HTML 头：部分系统导出的 .doc 实际是 HTML */
function isHtml(raw: Buffer): boolean {
  const head = raw.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase()
  return /^<!doctype html|^<html[\s>]|^<head[\s>]|^<meta[\s>]/.test(head)
}

/** HTML 按声明的 charset 解码（Word 导出的 HTML 常是 gb2312 / windows-1252，直接按 UTF-8 解会乱码） */
function decodeHtml(raw: Buffer): string {
  const head = raw.subarray(0, 2048).toString('latin1')
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]
  try {
    return new TextDecoder(charset || 'utf-8').decode(raw)
  } catch {
    return raw.toString('utf8')
  }
}

/**
 * Word 文件（任意容器）→ Markdown。
 * 失败时抛错（调用方按各自契约转成错误提示）。
 */
export async function wordToMarkdown(input: WordToMarkdownInput): Promise<string> {
  const raw = input.buffer ?? (input.filePath ? fs.readFileSync(input.filePath) : Buffer.alloc(0))
  if (!raw.length) throw new Error('文档为空')

  // 新版 Word：复用现有 mammoth 管线（标题 / 表格 / 图片 / 编号 / 公式）
  if (isZip(raw)) {
    // 把 filePath 一并传下去：图片缓存目录用「路径 + 内容」做键，重命名/移动后不会复用旧图
    return docxToMarkdown({
      filePath: input.filePath,
      buffer: raw,
      mediaDir: input.mediaDir,
      extractImages: input.extractImages,
    })
  }
  if (isRtf(raw)) return docTextToMarkdown(rtfToText(raw))
  if (isHtml(raw)) return htmlToMarkdown(decodeHtml(raw))
  if (!isOle2(raw)) {
    throw new Error('无法识别的 Word 文档（文件头既不是 .docx 的 ZIP，也不是 .doc 的 OLE2 / RTF / HTML）')
  }

  // Word 97-2003：word-extractor 取正文 + 文本框（页眉页脚是重复内容，不取）
  let extracted: Awaited<ReturnType<WordExtractor['extract']>>
  try {
    extracted = await new WordExtractor().extract(raw)
  } catch (e: any) {
    throw new Error(`解析 Word 97-2003 文档失败：${e?.message || String(e)}（文件可能已损坏或加密）`)
  }
  const body = extracted.getBody({ filterUnicode: false })
  const textboxes = extracted.getTextboxes({ filterUnicode: false, includeHeadersAndFooters: false })
  const text = [body, textboxes].filter((part) => part && part.trim()).join('\n')
  if (!text.trim()) throw new Error('文档里没有可读取的文字（可能只含图片，或已加密）')
  return docTextToMarkdown(text)
}

/** 一行是否像表格行：按制表符切分且至少两列（行首制表符视为缩进，不算表格） */
function splitTableRow(line: string): string[] | null {
  if (!line.includes('\t')) return null
  const cells = line.split('\t').map((cell) => cell.trim())
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  if (cells.length < 2 || !cells[0]) return null
  return cells
}

/** 二维单元格 → GFM 管道表格（首行作表头；竖线转义，避免破坏列结构） */
function tableToMarkdown(rows: string[][]): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|')
  const header = rows[0].map(escape)
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ]
  for (const row of rows.slice(1)) lines.push(`| ${row.map(escape).join(' | ')} |`)
  return lines.join('\n')
}

/**
 * 纯文本（.doc / RTF）→ Markdown。
 *
 * word-extractor 用 `\n` 分隔段落、用制表符分隔表格单元格（单元格标记 0x07），
 * 所以这里：
 *  - 连续 ≥2 行、列数一致的制表符行 → GFM 管道表格（首行作表头）；
 *  - 其余行 → 独立段落（段落之间空一行，Markdown 才会分段）；
 *  - 行内残留的制表符换成两个空格 —— 不能换四个，否则会被当成代码块。
 *
 * 不做 Markdown 转义：`.doc` 里本来就是普通文字，转义反斜杠反而会在预览 / 导出里露出来。
 */
export function docTextToMarkdown(text: string): string {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    // 去掉 word-extractor 没有映射的残余控制字符（0x09 制表符 / 0x0A 换行保留）
    .replace(/[\u0000-\u0008\u000e-\u001f]/g, '')
  const lines = normalized.split('\n').map((line) => line.replace(/[ \t\u00a0]+$/g, ''))

  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const row = splitTableRow(line)
    if (row) {
      const rows: string[][] = [row]
      let j = i + 1
      while (j < lines.length) {
        const next = splitTableRow(lines[j])
        if (!next || next.length !== row.length) break
        rows.push(next)
        j++
      }
      if (rows.length >= 2) {
        blocks.push(tableToMarkdown(rows))
        i = j
        continue
      }
    }
    blocks.push(line.replace(/\t+/g, '  ').trim())
    i++
  }
  return blocks.join('\n\n')
}
