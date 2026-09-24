/**
 * tools.ts — 主进程核心工具注册（统一工具注册表的第一个消费者）
 *
 * 在 `toolRegistry` 上注册一组模型可调用的核心工具。它们与 skill 步骤、
 * 工作流节点共用同一套执行管线（pre/execute/post）与统一 `ToolResult`。
 *
 * 设计约束：
 * - **路径围栏**：read_file/write_file/list_dir 在提供 `ctx.cwd`（工作区根）
 *   时拒绝越界访问（fail-closed），未提供 cwd 时退化为全盘可读（对齐旧的
 *   渲染进程行为，未来由沙箱策略接管）；
 * - **结果统一**：一律返回 `{ ok, value | error }`，错误不外泄堆栈；
 * - 新增工具 = 在 `registerCoreTools` 里加一行 `toolRegistry.register(...)`。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { BrowserWindow } from 'electron'
import * as PDFJS from 'pdfjs-dist'
import xlsx from 'xlsx'
import { toolRegistry, defineTool } from '@/shared/toolRegistry'
import type { ToolResult, ToolExecutionContext } from '@/types/tool'
import { pythonService } from './python-service'
import { docxToMarkdown } from './office/docx-to-markdown'
import { shellService } from './shell-service'
import { resolvePolicy, isShellAllowed } from './sandbox-policy'
import { retrieveKnowledge } from '@/shared/kbRetrieval'
import { isBotChallengePage, extractDoiFromUrl, fetchDoiViaCrossref } from '@/shared/webFetchHelpers'
import { computeEditDiff, makeEditDiffPreview, countTextLines, EDIT_DIFF_MAX_CHARS, type EditDiffFilePreview } from '@/shared/editDiff'
import { skillService } from './skill-service'
import { requestAnswer, setAgentPlan, setAgentTodos, createAgent, getAgent, getAgentLastContent, disposeAgent, requestRendererTask } from './agent-loop'
import { sessionLog } from './session-log'
import { mcpService } from './mcp-service'
import { browserAgentService } from './browser-agent'
import { asUint8 } from './buffer-view'
import { RUN_CODE_DESCRIPTION, RUN_CODE_INPUT_SCHEMA, runCodeHandler } from './code-sdk'
import { excludeFromAppZoom } from './window-zoom'
import {
  normalizeWebSearchConfig,
  findWebSearchCustomSource,
  webSearchProviderMeta,
  type WebSearchConfig,
  type WebSearchCustomSource,
  type WebSearchItem,
  type WebSearchProviderId,
  type WebSearchRunResult,
} from '@/shared/webSearch'

// ---------------------------------------------------------------------------
// 路径围栏
// ---------------------------------------------------------------------------

/** 读取类文件大小上限（100KB，防爆上下文；纯文本的默认窗口即按此字节量折算字符数） */
const READ_CAP_BYTES = 100 * 1024
/** 纯文本可整文件读入内存的上限（超过则不按字符续读，只给开头样本 + run_python 引导） */
const TEXT_FULL_READ_MAX_BYTES = 16 * 1024 * 1024
/** 单次返回字符数硬上限（防止模型传入超大 limit 撑爆上下文） */
const MAX_READ_CHARS = 100 * 1024
/** PDF / Word / Excel 单次返回字符数（默认窗口，沿用原有上限） */
const DEFAULT_DOC_CHARS = 20000

/**
 * 解析并校验路径：
 * - **相对路径**：锚定到 ctx.cwd（工作区根），提供 cwd 时拒绝越界（fail-closed）；
 * - **绝对路径**（含 Windows 驱动器路径如 `D:\`、`D:/`）：视为用户显式授权
 *   （如用户要求查看 D 盘 / 指定文件路径），放行；
 * - **驱动器相对路径**（如 `D:`）：归一化为该驱动器根目录 `D:\`（Windows
 *   上 `path.isAbsolute('D:')` 为 false，若不处理会被误当相对路径解析到工作区）。
 * 返回绝对路径；非法时返回 null。
 */
function resolveWithinCwd(rawPath: string, ctx: ToolExecutionContext): string | null {
  if (!rawPath) return null
  // Windows 驱动器相对路径（如 D:）→ 驱动器根目录
  const driveMatch = /^([a-zA-Z]):$/.exec(rawPath.trim())
  if (driveMatch) {
    return `${driveMatch[1]}:${path.sep}`
  }
  if (path.isAbsolute(rawPath)) {
    // 用户显式给出的绝对路径 → 放行（agent 的绝对路径访问视为用户授权）
    return rawPath
  }
  const abs = path.resolve(ctx.cwd || process.cwd(), rawPath)
  if (ctx.cwd) {
    const root = path.resolve(ctx.cwd)
    if (abs !== root && !abs.startsWith(root + path.sep)) return null
  }
  return abs
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/**
 * 按技能名解析技能目录（绝对路径）。
 *
 * 供 read_file / list_dir / search_files 的 `skill` 参数使用：把 `path` 锚定到技能目录，
 * 让 SKILL.md 里 `regulations/x.md` / `references/x.md` 这类相对写法**逐字可用**，
 * 而不必依赖工具 cwd（cwd 恒为用户工作区，见 promptContext / useAgentRun）。
 */
function resolveSkillDir(rawSkill: string): { base?: string; error?: string } {
  const name = String(rawSkill ?? '').trim()
  if (!name) return { error: 'skill 参数为空' }
  const resolved = resolveSkillCandidate(name)
  const candidate = resolved.candidate
  if (!candidate) return { error: `技能不存在: ${name}。${resolved.hint || ''}`.trim() }
  const base = String(candidate.path || '').trim()
  if (!base) return { error: `技能「${candidate.name}」没有可用的目录路径` }
  return { base }
}

/**
 * 解析工具的 path（+ 可选 skill）→ 绝对路径。
 *
 * - **传 `skill`**：`path` 相对该技能目录解析（技能名容错匹配，失败时回可用技能名）；
 *   相对路径越出技能目录时 fail-closed；绝对路径仍按「显式授权」放行。
 * - **不传 `skill`**：与原语义完全一致（绝对路径放行；相对路径锚定工作区根）。
 */
function resolveToolPath(
  rawPath: string,
  rawSkill: unknown,
  ctx: ToolExecutionContext,
): { abs?: string; error?: string } {
  const skillName = String(rawSkill ?? '').trim()
  if (!skillName) {
    const abs = resolveWithinCwd(rawPath, ctx)
    return abs ? { abs } : { error: '路径越界或缺失（path 参数必填）' }
  }
  const dir = resolveSkillDir(skillName)
  const base = dir.base
  if (!base) return { error: dir.error }
  const raw = String(rawPath ?? '').trim() || '.'
  if (path.isAbsolute(raw)) return { abs: raw }
  const abs = path.resolve(base, raw)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { error: `路径越出技能目录: ${raw}（技能「${skillName}」目录：${base}）` }
  }
  return { abs }
}

/** 解析 read_file 的 offset / limit（单位：字符；缺省或非法值按默认处理） */
function parseReadWindow(input: any): { offset: number; limit?: number } {
  const rawOffset = Number(input?.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  const rawLimit = Number(input?.limit)
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_READ_CHARS) : undefined
  return { offset, limit }
}

/**
 * 按字符窗口切分已取到的全文。
 *
 * `nextOffset`（= 本次结束位置）即**续读锚点**：把它作为下一次调用的 offset 继续读，
 * 反复调用直到 `truncated === false` 即为读完全文。
 */
function sliceByCharWindow(text: string, offset: number, limit: number) {
  const totalChars = text.length
  const startOffset = Math.max(0, Math.min(offset, totalChars))
  const endOffset = Math.min(startOffset + limit, totalChars)
  const truncated = endOffset < totalChars
  return {
    content: text.slice(startOffset, endOffset),
    totalChars,
    startOffset,
    endOffset,
    truncated,
    nextOffset: truncated ? endOffset : undefined,
  }
}

/** 窗口被截断 / 已读到末尾时的提示文案（各格式共用，模型据此决定是否续读） */
function windowNote(
  label: string,
  win: ReturnType<typeof sliceByCharWindow>,
  requestedOffset: number,
): string | undefined {
  if (win.truncated) {
    return `${label}共 ${win.totalChars} 字符，本次返回第 ${win.startOffset}–${win.endOffset} 字符（已截断）。如需继续读取后续内容，请再次调用 read_file 并传 offset=${win.nextOffset}（可反复续读，直到返回的 truncated 为 false）。`
  }
  if (requestedOffset > 0) return `已读到${label}末尾（共 ${win.totalChars} 字符）。`
  return undefined
}

/** 首个 READ_CAP_BYTES 字节（对齐到完整 UTF-8 字符边界）包含的字符数——纯文本的默认窗口 */
function defaultTextWindowChars(buf: Buffer): number {
  let cut = Math.min(READ_CAP_BYTES, buf.length)
  while (cut > 0 && cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut--
  return buf.toString('utf-8', 0, cut).length
}

async function readFile(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const resolved = resolveToolPath(String(input?.path ?? ''), input?.skill, ctx)
  const abs = resolved.abs
  if (!abs) return { ok: false, error: resolved.error || '路径越界或缺失（path 参数必填）' }
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${input.path}` }
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) return { ok: false, error: `是目录而非文件: ${input.path}` }

    // PDF 文件：用 pdfjs-dist 提取正文文本（不能按 UTF-8 文本读取，否则得到二进制乱码）
    const isPdfExt = /\.pdf$/i.test(abs)
    const headBuf = Buffer.alloc(4)
    const headFd = fs.openSync(abs, 'r')
    const headRead = fs.readSync(headFd, asUint8(headBuf), 0, 4, 0)
    fs.closeSync(headFd)
    const isPdfMagic = headRead >= 4 && headBuf[0] === 0x25 && headBuf[1] === 0x50 && headBuf[2] === 0x44 && headBuf[3] === 0x46 // %PDF
    if (isPdfExt || isPdfMagic) {
      try {
        const pdfText = await parsePdfBytes(new Uint8Array(fs.readFileSync(abs)))
        if (!pdfText || pdfText.trim().length === 0) {
          return { ok: false, error: 'PDF 解析结果为空（可能是扫描件/图片型 PDF，建议改用 OCR）' }
        }
        const { offset, limit } = parseReadWindow(input)
        const win = sliceByCharWindow(pdfText, offset, limit ?? DEFAULT_DOC_CHARS)
        return {
          ok: true,
          value: {
            path: input.path,
            content: win.content,
            size: stat.size,
            format: 'pdf',
            totalChars: win.totalChars,
            startOffset: win.startOffset,
            endOffset: win.endOffset,
            truncated: win.truncated,
            nextOffset: win.nextOffset,
            note: windowNote('PDF 文本', win, offset),
          },
        }
      } catch (e: any) {
        return { ok: false, error: `PDF 解析失败: ${e?.message || String(e)}` }
      }
    }

    // Word 文档：.docx 用 mammoth 提取 Markdown 文本（标题 atx / 表格管道化）；.doc 为旧版二进制格式不支持
    const ext = path.extname(abs).toLowerCase()
    if (ext === '.docx') {
      try {
        const docText = await parseDocxFile(abs)
        if (!docText || docText.trim().length === 0) {
          return { ok: false, error: 'Word 文档解析结果为空' }
        }
        const { offset, limit } = parseReadWindow(input)
        const win = sliceByCharWindow(docText, offset, limit ?? DEFAULT_DOC_CHARS)
        return {
          ok: true,
          value: {
            path: input.path,
            content: win.content,
            size: stat.size,
            format: 'docx',
            totalChars: win.totalChars,
            startOffset: win.startOffset,
            endOffset: win.endOffset,
            truncated: win.truncated,
            nextOffset: win.nextOffset,
            note: windowNote('Word 文本', win, offset),
          },
        }
      } catch (e: any) {
        return { ok: false, error: `Word 解析失败: ${e?.message || String(e)}` }
      }
    }
    if (ext === '.doc') {
      return { ok: false, error: '不支持读取旧版 .doc 二进制格式，请先在 Word 中另存为 .docx 后再读取。' }
    }

    // Excel 表格：.xlsx/.xls 用 SheetJS 提取为 Markdown 表格
    if (ext === '.xlsx' || ext === '.xls') {
      try {
        const xlsText = await parseXlsxFile(abs)
        if (!xlsText || xlsText.trim().length === 0) {
          return { ok: false, error: 'Excel 解析结果为空' }
        }
        const { offset, limit } = parseReadWindow(input)
        const win = sliceByCharWindow(xlsText, offset, limit ?? DEFAULT_DOC_CHARS)
        return {
          ok: true,
          value: {
            path: input.path,
            content: win.content,
            size: stat.size,
            format: ext === '.xlsx' ? 'xlsx' : 'xls',
            totalChars: win.totalChars,
            startOffset: win.startOffset,
            endOffset: win.endOffset,
            truncated: win.truncated,
            nextOffset: win.nextOffset,
            note: windowNote('Excel 文本', win, offset),
          },
        }
      } catch (e: any) {
        return { ok: false, error: `Excel 解析失败: ${e?.message || String(e)}` }
      }
    }

    if (stat.size > TEXT_FULL_READ_MAX_BYTES) {
      // 超大文本文件：不整文件读入内存（无法按字符续读），只给开头样本 + run_python 引导
      const fd = fs.openSync(abs, 'r')
      const buf = Buffer.alloc(READ_CAP_BYTES)
      const read = fs.readSync(fd, asUint8(buf), 0, READ_CAP_BYTES, 0)
      fs.closeSync(fd)
      // 回退到完整 UTF-8 字符边界，避免末尾出现半截字符
      let cut = read
      while (cut > 0 && cut < read && (buf[cut] & 0xc0) === 0x80) cut--
      const sample = buf.toString('utf-8', 0, cut)
      return {
        ok: true,
        value: {
          path: input.path,
          content: sample,
          size: stat.size,
          truncated: true,
          sampleBytes: Buffer.byteLength(sample, 'utf-8'),
          note: `文件较大（${stat.size} 字节），仅返回开头样本且不支持 offset 续读；如需完整处理，请用 run_python 直接读取（例如 print(open(path, encoding="utf-8").read()[起始:结束])）。`,
        },
      }
    }
    // 普通文本：按「字符」窗口切片（默认窗口 = 首个 100KB 字节所含字符数，与旧行为一致）
    const buf = fs.readFileSync(abs)
    const { offset, limit } = parseReadWindow(input)
    const win = sliceByCharWindow(buf.toString('utf-8'), offset, limit ?? defaultTextWindowChars(buf))
    return {
      ok: true,
      value: {
        path: input.path,
        content: win.content,
        size: stat.size,
        totalChars: win.totalChars,
        startOffset: win.startOffset,
        endOffset: win.endOffset,
        truncated: win.truncated,
        nextOffset: win.nextOffset,
        note: windowNote('文件', win, offset),
      },
    }
  } catch (e: any) {
    return { ok: false, error: `读取失败: ${e?.message || String(e)}` }
  }
}

async function writeFile(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const abs = resolveWithinCwd(String(input?.path ?? ''), ctx)
  if (!abs) return { ok: false, error: '路径越界或缺失（path 参数必填）' }
  try {
    const content = String(input?.content ?? '')
    const rawPath = String(input?.path ?? '')
    const before = readOldTextForDiff(abs)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
    // 差异预览：仅在能拿到可读原文时算行级 diff；新建/过大/二进制只给行数摘要
    const created = 'missing' in before
    const diff: EditDiffFilePreview = created
      ? { path: rawPath, created: true, stats: { added: countTextLines(content), removed: 0 }, lines: [] }
      : 'text' in before
        ? { path: rawPath, ...computeEditDiff(before.text, content) }
        : { path: rawPath, lines: [], skipped: before.reason }
    return {
      ok: true,
      value: {
        path: input.path,
        bytes: content.length,
        created,
        stats: diff.stats,
      },
      preview: makeEditDiffPreview([diff]),
    }
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e?.message || String(e)}` }
  }
}

/**
 * 读取写盘前的文件内容（供差异预览）。
 * 不抛异常：不存在 → missing（新建）；目录/过大/二进制 → 返回 reason（跳过 diff）。
 */
function readOldTextForDiff(abs: string): { text: string } | { missing: true } | { reason: 'too-large' | 'binary' } {
  try {
    const st = fs.statSync(abs)
    if (st.isDirectory()) return { reason: 'too-large' }
    if (st.size > EDIT_DIFF_MAX_CHARS) return { reason: 'too-large' }
    const text = fs.readFileSync(abs, 'utf-8')
    if (text.includes('\u0000')) return { reason: 'binary' }
    return { text }
  } catch {
    return { missing: true }
  }
}

// ---------------------------------------------------------------------------
// 精确编辑工具（replace_in_file / multi_replace）
//
// 与 write_file（全量覆盖）互补：模型只给出"待替换原文段 + 新文段"，工具负责
// 定位、唯一性校验与落盘，不改动文件其余部分。语义要点：
// - 匹配以整段精确为准，自动做 EOL 归一（兼容 CRLF/LF 差异）；
// - 未传 occurrence 时要求全文唯一（fail-closed：多处命中宁可报错也不猜测，
//   防止"以为改 A 处实际改了 B 处"）；错误信息带各出现行号与相似片段提示；
// - multi_replace 先对全部条目定位，全部唯一命中后才统一写盘（原子性），
//   任一失败整批不落盘，避免把文件留在"改了一半"的中间态。
// ---------------------------------------------------------------------------

/** 主换行风格：只要文件里出现 CRLF 即按 CRLF 处理，否则按 LF */
function detectEol(text: string): '\r\n' | '\n' {
  return text.indexOf('\r\n') !== -1 ? '\r\n' : '\n'
}

/** 把任意行尾统一为指定 EOL（先归一为 LF 再转目标，避免 CRLF 双重处理） */
function toFileEol(s: string, eol: '\r\n' | '\n'): string {
  const lf = s.replace(/\r\n/g, '\n')
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

/** 收集 needle 在 hay 中的所有命中偏移（升序、互不重叠） */
function collectOccurrences(hay: string, needle: string): number[] {
  const hits: number[] = []
  if (!needle) return hits
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i === -1) break
    hits.push(i)
    from = i + needle.length
  }
  return hits
}

/** 计算 [0, idx) 内换行数 + 1 = 该偏移所在 1-based 行号 */
function lineNumberAt(content: string, idx: number): number {
  return content.slice(0, idx).split('\n').length
}

/**
 * 生成"未命中"提示：给出**可直接复制的候选片段**（让模型“抄作业”），而不只是“附近几行”。
 *
 * 未命中的两个典型形态：① old_string 抄漏/抄多了行；② 行内空白或字词被改写。
 * 做法：以 old_string 中能在文件里对上的行作锚点，按锚点在 old_string 内的偏移回推目标
 * 区域行号，并原样（含缩进）回显锚点附近的片段，明确要求"原样复制"。
 * 回显最多 MAX_HINT_LINES 行，避免"整文件 old_string"把错误信息本身擑爆上下文。
 */
function suggestNearMatch(content: string, oldRaw: string): string {
  const MAX_HINT_LINES = 30
  const oldLines = oldRaw.split(/\r\n|\r|\n/)
  const fileLines = content.split(/\r\n|\r|\n/)
  const fileTrim = fileLines.map((l) => l.trim())

  /** 在文件里找某行（trim 后完全一致）；返回命中行下标（最多 5 个） */
  const findHits = (needle: string): number[] => {
    const hits: number[] = []
    for (let i = 0; i < fileTrim.length && hits.length < 5; i++) {
      if (fileTrim[i] === needle) hits.push(i)
    }
    return hits
  }

  // 锚点：old_string 中最靠前的、能在文件中对上的非平凡行（≥ 4 字符，避免 "}" 之类误命中）
  const tried = new Set<string>()
  for (let k = 0; k < oldLines.length; k++) {
    const anchor = oldLines[k].trim()
    if (anchor.length < 4 || tried.has(anchor)) continue
    tried.add(anchor)
    const hits = findHits(anchor)
    if (!hits.length) continue

    // 按锚点偏移回推"模型想要的区域"，上下各放宽 1 行便于取舍
    const guessStart = Math.max(0, hits[0] - k)
    const guessEnd = Math.min(fileLines.length, guessStart + Math.max(oldLines.length, 1))
    const from = Math.max(0, guessStart - 1)
    const to = Math.min(fileLines.length, Math.max(guessEnd + 1, hits[0] + 2))

    // 回显窗口：以锚点为中心，最多 MAX_HINT_LINES 行
    let s = from
    let e = to
    if (e - s > MAX_HINT_LINES) {
      s = Math.max(from, hits[0] - Math.floor(MAX_HINT_LINES / 2))
      e = Math.min(to, s + MAX_HINT_LINES)
    }

    const lines: string[] = []
    const multi = hits.length > 1 ? `（该行在文件中出现 ${hits.length} 处，请连同上下文一起复制以保证唯一）` : ''
    lines.push(`old_string 第 ${k + 1} 行（\`${anchor}\`）在文件里能对上，但整段无法匹配${multi}。`)
    if (k > 0) {
      lines.push(`注意：你的 old_string 从第 ${k + 1} 行才开始与文件对上（前 ${k} 行在该位置附近不存在）——常见原因是抽漏了文件里的某几行。`)
    }
    lines.push(`文件第 ${guessStart + 1}-${guessEnd} 行大致对应你要改的区域（当前文件共 ${fileLines.length} 行）。`)
    if (s > from || e < to) {
      lines.push(`下面只回显第 ${s + 1}-${e} 行（如需完整区域请 read_file 读该区间）：`)
    } else {
      lines.push('该区域原文如下（原样回显，含缩进）：')
    }
    lines.push('----- 复制开始 -----', fileLines.slice(s, e).join('\n'), '----- 复制结束 -----')
    lines.push('请对上面这段做【原样复制】作为 old_string 重试（只改需要改的行，并保留相邻行以保证唯一）；不要凭记忆手写 old_string。')
    return lines.join('\n')
  }

  // 一行都对不上：退回"前缀包含"模糊匹配（应对行内空白/字词被改写）
  const first = oldLines.find((l) => l.trim().length >= 4)
  if (first) {
    const key = first.trim().slice(0, 24)
    const i = fileTrim.findIndex((t) => key.length >= 8 && t.includes(key))
    if (i >= 0) {
      const s = Math.max(0, i - 2)
      const e = Math.min(fileLines.length, i + 3)
      return [
        `文件里没有与 old_string 完全一致的行；第 ${i + 1} 行附近内容相似：`,
        '----- 复制开始 -----',
        fileLines.slice(s, e).join('\n'),
        '----- 复制结束 -----',
        '请先 read_file 读取该区域，再把要修改的行【原样复制】为 old_string。',
      ].join('\n')
    }
  }
  return ''
}

/** 读取文件文本并做编辑前置校验（仅文本文件允许替换） */
function readTextFileForEdit(rawPath: string, abs: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${rawPath}` }
    if (fs.statSync(abs).isDirectory()) return { ok: false, error: `是目录而非文件: ${rawPath}` }
    const text = fs.readFileSync(abs, 'utf-8')
    if (text.includes('\u0000')) return { ok: false, error: `文件「${rawPath}」疑似二进制（含 NUL 字节），拒绝文本替换。` }
    return { ok: true, text }
  } catch (e: any) {
    return { ok: false, error: `读取失败: ${e?.message || String(e)}` }
  }
}

/** 定位结果：只定位不改写（原子性由 multi_replace / 单次写盘保证） */
interface LocatedEdit {
  abs: string
  rawPath: string
  content: string       // 编辑前的原始内容（写回基准）
  index: number         // 命中偏移（相对 content）
  oldMatched: string    // 命中的原文段（含文件 EOL）
  newString: string     // 已统一为文件 EOL 的新文段
  startLine: number
  endLine: number
}

/**
 * 在单个文件内容中定位一次替换。
 * 匹配策略：先整段精确（原样），未命中再按文件 EOL 归一重试（兼容 CRLF/LF）。
 * 唯一性：不传 occurrence 时要求全文唯一；多处命中给出各出现行号（fail-closed）。
 */
function locateReplacement(
  rawPath: string,
  abs: string,
  content: string,
  oldRaw: string,
  newRaw: string,
  occurrence?: number,
): { ok: true; edit: LocatedEdit } | { ok: false; error: string } {
  if (!oldRaw) return { ok: false, error: `old_string 不能为空（${rawPath}）` }
  const eol = detectEol(content)
  // 候选串：原样 + 归一为文件 EOL（模型常发 \n 而文件可能是 CRLF）
  const candidates: string[] = []
  const norm = toFileEol(oldRaw, eol)
  if (!candidates.includes(oldRaw)) candidates.push(oldRaw)
  if (norm !== oldRaw) candidates.push(norm)

  let used = oldRaw
  let hits: number[] = []
  for (const c of candidates) {
    const found = collectOccurrences(content, c)
    if (found.length > 0) { used = c; hits = found; break }
  }

  if (hits.length === 0) {
    return {
      ok: false,
      error: `old_string 未在文件「${rawPath}」中找到。${suggestNearMatch(content, oldRaw) || '请先用 read_file 读取该文件，再原样复制要修改的片段作为 old_string。'}`,
    }
  }
  if (hits.length > 1 && occurrence === undefined) {
    const lines = hits.map((i) => lineNumberAt(content, i))
    return {
      ok: false,
      error: `old_string 在文件「${rawPath}」中出现 ${hits.length} 处（第 ${lines.join('、')} 行）。为安全起见未执行替换：请补充更多上下文使其唯一，或传 occurrence 指定第几处（从 1 起）。`,
    }
  }
  const pick = occurrence === undefined ? 0 : occurrence - 1
  if (occurrence !== undefined && (pick < 0 || pick >= hits.length)) {
    return {
      ok: false,
      error: `occurrence=${occurrence} 越界：old_string 共出现 ${hits.length} 处（occurrence 从 1 开始）。`,
    }
  }
  const index = hits[pick]
  const oldMatched = content.slice(index, index + used.length)
  const startLine = lineNumberAt(content, index)
  const endLine = startLine + oldMatched.split('\n').length - 1
  return {
    ok: true,
    edit: { abs, rawPath, content, index, oldMatched, newString: toFileEol(newRaw, eol), startLine, endLine },
  }
}

/** 在内存构造同一文件的一组编辑后的新内容（无 IO，供原子批量） */
function buildNewContent(edits: LocatedEdit[]): { ok: true; content: string } | { ok: false; error: string } {
  if (edits.length === 0) return { ok: true, content: '' }
  const sorted = [...edits].sort((a, b) => a.index - b.index)
  // 区间重叠防护：同一文件两条替换不得交叠
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].index + sorted[i - 1].oldMatched.length
    if (sorted[i].index < prevEnd) {
      return {
        ok: false,
        error: `文件「${sorted[0].rawPath}」存在区间重叠的替换（第 ${sorted[i - 1].startLine} 行与第 ${sorted[i].startLine} 行），请合并为一条后重试。`,
      }
    }
  }
  // 按 index 降序应用（后续编辑发生在更前位置，不影响已应用位置偏移）
  let current = sorted[0].content
  for (const ed of [...sorted].sort((a, b) => b.index - a.index)) {
    const seg = current.slice(ed.index, ed.index + ed.oldMatched.length)
    if (seg !== ed.oldMatched) {
      return { ok: false, error: `文件「${ed.rawPath}」应用第 ${ed.startLine} 行替换时校验失败，已整体回滚（未写盘）。` }
    }
    current = current.slice(0, ed.index) + ed.newString + current.slice(ed.index + ed.oldMatched.length)
  }
  return { ok: true, content: current }
}

/** 单点精确替换（replace_in_file）：一次只定位一个文件的一处替换 */
async function replaceInFile(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const rawPath = String(input?.path ?? '')
  const oldRaw = String(input?.old_string ?? '')
  const newRaw = String(input?.new_string ?? '')
  const abs = resolveWithinCwd(rawPath, ctx)
  if (!abs) return { ok: false, error: '路径越界或缺失（path 参数必填）' }
  const rd = readTextFileForEdit(rawPath, abs)
  if (!rd.ok) return rd
  const occurrence = input?.occurrence === undefined ? undefined : Number(input.occurrence)
  const loc = locateReplacement(rawPath, abs, rd.text, oldRaw, newRaw, occurrence)
  if (!loc.ok) return loc
  const built = buildNewContent([loc.edit])
  if (!built.ok) return built
  // 差异预览：编辑前文本（rd.text）与编辑后内容（built.content）
  const diff: EditDiffFilePreview = { path: rawPath, ...computeEditDiff(rd.text, built.content) }
  try {
    fs.writeFileSync(abs, built.content, 'utf-8')
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e?.message || String(e)}` }
  }
  return {
    ok: true,
    value: {
      path: rawPath,
      applied: 1,
      changedLines: { start: loc.edit.startLine, end: loc.edit.endLine },
      deleted: loc.edit.newString.length === 0,
      stats: diff.stats,
    },
    preview: makeEditDiffPreview([diff]),
  }
}

/** 批量原子替换（multi_replace）：全部命中才落盘，任一失败整批不生效 */
async function multiReplace(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const repls = Array.isArray(input?.replacements) ? input.replacements : []
  if (repls.length === 0) return { ok: false, error: 'replacements 参数必填（至少一项，数组形式）' }

  // 阶段一：解析路径 + 读取文本（同一文件只读一次）
  interface FileState { rawPath: string; abs: string; text: string }
  const fileCache = new Map<string, FileState>()
  const pending: { rawPath: string; oldRaw: string; newRaw: string; state: FileState }[] = []
  for (const r of repls) {
    if (!r || typeof r !== 'object') return { ok: false, error: 'replacements 中存在非法项' }
    const rawPath = String((r as any).path ?? '')
    const oldRaw = String((r as any).old_string ?? '')
    const newRaw = String((r as any).new_string ?? '')
    if (!rawPath) return { ok: false, error: 'replacements 中存在缺 path 的项' }
    if (!oldRaw) return { ok: false, error: `「${rawPath}」的 old_string 不能为空` }
    const abs = resolveWithinCwd(rawPath, ctx)
    if (!abs) return { ok: false, error: `路径越界或缺失: ${rawPath}` }
    let state = fileCache.get(abs)
    if (!state) {
      const rd = readTextFileForEdit(rawPath, abs)
      if (!rd.ok) return rd
      state = { rawPath, abs, text: rd.text }
      fileCache.set(abs, state)
    }
    pending.push({ rawPath, oldRaw, newRaw, state })
  }

  // 阶段二：全部定位（multi_replace 强制唯一，不接受 occurrence 猜测）
  const byFile = new Map<string, LocatedEdit[]>()
  for (let pi = 0; pi < pending.length; pi++) {
    const p = pending[pi]
    const loc = locateReplacement(p.rawPath, p.state.abs, p.state.text, p.oldRaw, p.newRaw)
    if (!loc.ok) {
      // 任一条失败 → 整批不落盘；标明第几条，便于模型定位（错误内已含候选片段）
      // 注：tsconfig.node.json 未开 strict，判别式联合的真值收窄不生效，故用 in 收窄
      const reason = 'error' in loc ? loc.error : '定位失败'
      return { ok: false, error: `第 ${pi + 1}/${pending.length} 条替换失败：${reason}` }
    }
    const arr = byFile.get(p.state.abs) ?? []
    arr.push(loc.edit)
    byFile.set(p.state.abs, arr)
  }

  // 阶段三：先在内存构造全部目标内容（无副作用），全部成功后再统一写盘
  const targets: { abs: string; content: string }[] = []
  const newContentByAbs = new Map<string, string>()
  for (const edits of byFile.values()) {
    const built = buildNewContent(edits)
    if (!built.ok) return built
    targets.push({ abs: edits[0].abs, content: built.content })
    newContentByAbs.set(edits[0].abs, built.content)
  }
  try {
    for (const t of targets) fs.writeFileSync(t.abs, t.content, 'utf-8')
  } catch (e: any) {
    return { ok: false, error: `写入失败（可能部分文件已写入）: ${e?.message || String(e)}` }
  }

  const files = [...byFile.entries()].map(([abs, edits]) => {
    const after = newContentByAbs.get(abs) ?? ''
    const d = computeEditDiff(edits[0].content, after)
    return {
      path: edits[0].rawPath,
      replacements: edits.map((ed) => ({ changedLines: { start: ed.startLine, end: ed.endLine }, deleted: ed.newString.length === 0 })),
      stats: d.stats,
      diff: { path: edits[0].rawPath, ...d } as EditDiffFilePreview,
    }
  })
  return {
    ok: true,
    value: { applied: pending.length, files: files.map((f) => ({ path: f.path, replacements: f.replacements, stats: f.stats })) },
    preview: makeEditDiffPreview(files.map((f) => f.diff)),
  }
}

async function listDir(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const resolved = resolveToolPath(String(input?.path ?? '.'), input?.skill, ctx)
  const abs = resolved.abs
  if (!abs) return { ok: false, error: resolved.error || '路径越界或缺失（path 参数必填）' }
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `目录不存在: ${input.path || '.'}` }
    const entries = fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other',
    }))
    return { ok: true, value: { path: input.path || '.', entries } }
  } catch (e: any) {
    return { ok: false, error: `读取目录失败: ${e?.message || String(e)}` }
  }
}

async function runPython(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const code = String(input?.code ?? '')
  if (!code.trim()) return { ok: false, error: 'code 参数必填' }
  try {
    // 统一沙箱策略解析（路线图 2.5）：ctx.sandboxMode 可为 'safe' | 'workspace' | 'trusted'
    const policy = resolvePolicy((ctx as any).sandboxMode, { workspaceRoot: ctx.cwd })
    const sandboxMode: 'safe' | 'workspace' | 'trusted' = policy.mode
    const res = sandboxMode === 'trusted'
      ? await trustedPythonExecute(code, ctx.cwd)
      : await pythonService.executeCode(code, input?.input ?? '', ctx.cwd, sandboxMode)
    return {
      ok: !res?.error,
      value: { ...res, sandbox: policy },
      error: res?.error || undefined,
    }
  } catch (e: any) {
    return { ok: false, error: `Python 执行失败: ${e?.message || String(e)}` }
  }
}

// trusted 模式走完整访问服务（与 executePython IPC 一致）
async function trustedPythonExecute(code: string, cwd?: string) {
  const { trustedPythonService } = await import('./trusted-python-service')
  return trustedPythonService.executeCode(code, '', cwd)
}

async function runShell(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const command = String(input?.command ?? '')
  if (!command.trim()) return { ok: false, error: 'command 参数必填' }
  // shell 是最高危执行面：统一策略解析，仅 trusted 放行（fail-closed）
  const policy = resolvePolicy((ctx as any).sandboxMode, { workspaceRoot: ctx.cwd })
  if (!isShellAllowed(policy)) {
    return {
      ok: false,
      error: `shell 执行被沙箱策略拒绝：当前模式 ${policy.mode}（enforcement: ${policy.enforcement}）。仅「完全访问（trusted）」模式允许执行 shell 命令。`,
    }
  }
  try {
    const res = await shellService.executeCommand(command, ctx.cwd)
    return { ok: res.success, value: { ...res, sandbox: policy }, error: res.error || undefined }
  } catch (e: any) {
    return { ok: false, error: `shell 执行失败: ${e?.message || String(e)}` }
  }
}

async function kbSearch(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const query = String(input?.query ?? '')
  if (!query) return { ok: false, error: 'query 参数必填' }

  // 检索范围：input.kbPath（单个）→ input.kbPaths（数组）→ ctx.kbPaths（预设模式候选）
  const explicitPaths = input?.kbPath
    ? [String(input.kbPath)]
    : Array.isArray(input?.kbPaths) && input.kbPaths.length
      ? input.kbPaths.map(String)
      : Array.isArray(ctx.kbPaths) && ctx.kbPaths.length
        ? ctx.kbPaths.map(String)
        : []
  if (explicitPaths.length === 0) return { ok: false, error: '未指定知识库（kbPath/kbPaths，或预设关联的知识库）' }

  // kb 名称过滤（对齐原渲染进程 executeAgentPresetTool 语义）
  const kbFilter = typeof input?.kb === 'string' && input.kb.trim() ? input.kb.trim() : undefined
  const topK = Math.max(
    1,
    Math.min(20, typeof input?.topK === 'number' ? input.topK : typeof ctx.kbTopK === 'number' ? ctx.kbTopK : 5),
  )

  const allBlocks: any[] = []
  let ragContext = ''
  for (const kbPath of explicitPaths) {
    const kbName = String(kbPath).split(/[/\\]/).pop() || String(kbPath)
    if (kbFilter && kbName !== kbFilter && String(kbPath) !== kbFilter) continue
    if (!fs.existsSync(kbPath)) continue
    try {
      const result = await retrieveKnowledge(query, kbPath, {
        topK,
        debug: !!input?.debug,
        missingModelStrategy: 'fallback',
      })
      if ((result as any)?.context) {
        ragContext += `【知识库：${kbName}】\n${(result as any).context}\n`
      }
      const blocks = (result as any)?.relevantBlocks || []
      if (Array.isArray(blocks) && blocks.length > 0) allBlocks.push(...blocks)
    } catch (e: any) {
      ragContext += `【知识库：${kbName}】检索失败：${e?.message || String(e)}\n`
    }
  }

  if (!ragContext.trim()) {
    return { ok: false, error: `未检索到与「${query}」相关的知识库内容，请更换检索词后重试。` }
  }
  const preview = ragContext.length > 6000 ? ragContext.slice(0, 6000) + '\n...(内容过长已截断)' : ragContext
  return {
    ok: true,
    value: {
      query,
      kbPaths: explicitPaths,
      count: allBlocks.length,
      context: preview,
      blocks: allBlocks.slice(0, 10),
      debug: (input as any)?.debug ? allBlocks : undefined,
    },
  }
}

/**
 * 技能名归一化：忽略大小写与 `_`/空格差异（模型常把 kebab-case 技能名写歪）
 */
function normalizeSkillName(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/**
 * 按名解析技能（容错）：精确 → 忽略大小写/分隔符 → 唯一的前缀/包含匹配。
 * 未命中时给出可用技能清单：模型凭印象编技能名（如 contract-audit-skill）时，
 * 能直接看到真实技能名并改正，而不是反复重猜（旧实现只回「技能不存在」）。
 */
function resolveSkillCandidate(name: string): { candidate?: ReturnType<typeof skillService.get>; hint?: string } {
  const exact = skillService.get(name)
  if (exact) return { candidate: exact }
  const all = skillService.list()
  if (all.length === 0) {
    return { hint: '当前技能库为空（技能文件夹未设置或未加载）：请先在 设置 → 技能 中选择技能文件夹。' }
  }
  const norm = normalizeSkillName(name)
  const sameNorm = all.filter((c) => normalizeSkillName(c.name) === norm)
  if (sameNorm.length === 1) return { candidate: sameNorm[0] }
  const partial = all.filter((c) => {
    const n = normalizeSkillName(c.name)
    return n.startsWith(norm) || norm.startsWith(n) || n.includes(norm)
  })
  if (partial.length === 1) return { candidate: partial[0] }
  return { hint: `可用技能：${all.map((c) => c.name).join('、')}。请从中原文择一重新调用。` }
}

async function loadSkill(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const name = String(input?.name ?? '')
  if (!name) return { ok: false, error: 'name 参数必填（kebab-case 技能名）' }
  // 技能管理中关闭的技能：拒绝加载（ctx.disabledSkills 由 agent 循环注入）
  const disabledSkills = Array.isArray((ctx as any)?.disabledSkills) ? (ctx as any).disabledSkills as string[] : []
  if (disabledSkills.includes(name)) {
    return { ok: false, error: `技能「${name}」已禁用，禁止加载（可在技能管理中启用）` }
  }
  const resolved = resolveSkillCandidate(name)
  const candidate = resolved.candidate
  if (!candidate) return { ok: false, error: `技能不存在: ${name}。${resolved.hint || ''}`.trim() }
  if (candidate.name !== name && disabledSkills.includes(candidate.name)) {
    return { ok: false, error: `技能「${candidate.name}」已禁用，禁止加载（可在技能管理中启用）` }
  }
  // 返回内容包裹明确的执行指令：技能一旦加载即视为"指令已获得"，
  // 防止模型反复调用 skill 工具而不进入实际执行（死循环）。
  // 资源提示对齐 DSH"资源按需加载、结果不枚举技能目录"：只给技能目录 + 真实
  // 总数 + 少量示例，不把超大技能（如 1w+ 模板文件）的全量清单塞进工具结果。
  const sampled = (candidate.preview.files || []).slice(0, 20)
  const fileCount = candidate.preview.fileCount ?? candidate.preview.files?.length ?? 0
  const instruction = [
    `技能「${candidate.name}」已加载成功。`,
    '请立即按照下面的技能指令继续执行任务（生成代码用 run_python 执行、需要资料用 read_file / kb_search、需要联网用 web_search）。',
    '不要再次调用 skill 工具重复加载本技能。',
    `技能目录：${candidate.path}（共 ${fileCount} 个文件）。资源按需加载：不要枚举或读取全部文件，需要时用 read_file / list_dir / search_files 并**传 skill="${candidate.name}" + 相对路径**（例：read_file({"skill":"${candidate.name}","path":"references/x.md"})）查找读取——这样不受当前工作区影响（注意：不带 skill 的相对路径锚定的是当前工作区）。`,
    sampled.length > 0
      ? `参考文件示例（前 ${sampled.length} 个，便于快速定位）：\n${sampled.map((f) => `- ${f.name}`).join('\n')}`
      : '',
    '--- 技能指令开始 ---',
    candidate.preview.content,
    '--- 技能指令结束 ---',
  ].join('\n')
  return {
    ok: true,
    value: {
      name: candidate.name,
      description: candidate.description,
      source: candidate.source,
      promptVersion: candidate.promptVersion,
      content: instruction,
      resourceBase: candidate.path,
      fileCount,
      files: sampled.map((f) => f.name),
    },
  }
}

// ---------------------------------------------------------------------------
// 交互与状态工具（依赖 agent 循环的接缝）
// ---------------------------------------------------------------------------

/** ask_user：向用户提问，等待渲染进程经 agent:answer 回复 */
async function askUser(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const question = String(input?.question ?? '')
  if (!question) return { ok: false, error: 'question 参数必填' }
  if (!ctx.agentId) return { ok: false, error: 'ask_user 只能在 agent 循环内使用' }
  try {
    const answer = await requestAnswer(ctx.agentId, question)
    return { ok: true, value: { answer } }
  } catch (e: any) {
    return { ok: false, error: e?.message || '用户未回答' }
  }
}

/** update_plan：创建/更新执行计划（随 agent/plan 事件广播给 UI） */
async function updatePlan(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const plan = typeof input?.plan === 'string' && input.plan.trim() ? input.plan.trim() : null
  if (ctx.agentId) setAgentPlan(ctx.agentId, plan)
  return { ok: true, value: { plan } }
}

/** update_todo：维护结构化待办清单（随 agent/todos 事件广播给 UI） */
async function updateTodo(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const todos = Array.isArray(input?.todos) ? input.todos : []
  if (ctx.agentId) setAgentTodos(ctx.agentId, todos)
  return { ok: true, value: { count: todos.length } }
}

// ---------------------------------------------------------------------------
// search_files：工作区文本搜索（对齐 index.ts 的 searchInWorkspace 语义）
// ---------------------------------------------------------------------------

const SEARCH_IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'dist-electron', 'release', '.vscode', '.idea', '__pycache__', '.venv', 'venv', 'out', 'build', 'coverage', 'target', 'miniprogram_npm', '.mypy_cache', '.pytest_cache'])
const SEARCH_BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mp3', '.wav', '.db', '.sqlite', '.node', '.wasm'])

async function searchFiles(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const query = String(input?.query ?? '').trim()
  if (!query) return { ok: false, error: 'query 参数必填' }
  // 搜索根优先级：skill（技能目录）→ 显式 root（可绝对/相对工作区）→ 工具上下文 cwd
  const skillName = String(input?.skill ?? '').trim()
  let root: string | undefined
  if (skillName) {
    const dir = resolveSkillDir(skillName)
    const base = dir.base
    if (!base) return { ok: false, error: dir.error }
    root = base
  } else if (input?.root) {
    const abs = resolveWithinCwd(String(input.root), ctx)
    if (!abs) return { ok: false, error: `搜索根路径越界: ${input.root}` }
    root = abs
  } else {
    root = ctx.cwd
  }
  if (!root) return { ok: false, error: '缺少搜索目录（skill 或 root，或工具上下文 cwd）' }
  const filePattern = input?.filePattern ? String(input.filePattern) : undefined
  const maxResults = typeof input?.maxResults === 'number' ? input.maxResults : 30
  const maxFileSizeMB = typeof input?.maxFileSizeMB === 'number' ? input.maxFileSizeMB : 2
  const queryLower = query.toLowerCase()
  const results: any[] = []
  const maxFileSize = maxFileSizeMB * 1024 * 1024

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || results.length >= maxResults) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SEARCH_IGNORE_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (filePattern) {
        const pattern = filePattern.toLowerCase().replace(/^\./, '')
        if (ext !== '.' + pattern) continue
      }
      if (SEARCH_BINARY_EXT.has(ext)) continue
      const rel = path.relative(root, full).split(path.sep).join('/')
      try {
        const stat = await fs.promises.stat(full)
        if (stat.size > maxFileSize) continue
        const content = await fs.promises.readFile(full, 'utf8')
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) return
          const line = lines[i]
          if (line.toLowerCase().includes(queryLower)) {
            results.push({ path: rel, line: i + 1, text: line.slice(0, 300) })
          }
        }
      } catch {
        /* 无法读取的文件跳过 */
      }
    }
  }

  try {
    await walk(root, 0)
    return { ok: true, value: { query, results } }
  } catch (e: any) {
    return { ok: false, error: `搜索失败: ${e?.message || String(e)}` }
  }
}

// ---------------------------------------------------------------------------
// 联网工具（web_search / web_fetch）
//
// web_search 支持多搜索源（设置页「工具 → 搜索」切换）：
// - 免 Key：bing（默认，隐藏浏览器渲染）/ baidu / duckduckgo
// - 自建：searxng（实例地址 + JSON 接口）
// - API Key：bocha 博查 / zhipu 智谱 / tavily / brave
// 配置由渲染进程经 IPC（webSearch:set-config）注入，默认保持原 Bing 行为不变。
// ---------------------------------------------------------------------------

/** 当前生效的搜索源配置（默认 Bing 免 Key；setWebSearchConfig 覆盖） */
let webSearchConfig: WebSearchConfig = normalizeWebSearchConfig(null)

/** 注入搜索源配置（IPC webSearch:set-config / 测试搜索共用），返回归一化后的配置 */
export function setWebSearchConfig(cfg: unknown): WebSearchConfig {
  webSearchConfig = normalizeWebSearchConfig(cfg)
  return JSON.parse(JSON.stringify(webSearchConfig))
}

/** 读取当前搜索源配置（深拷贝，避免调用方改动内部状态） */
export function getWebSearchConfig(): WebSearchConfig {
  return JSON.parse(JSON.stringify(webSearchConfig))
}

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 解析 Bing 网页搜索结果（title/url/snippet），容器为 <li class="b_algo"> */
function parseBingResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = []
  // 逐个提取结果块（class 可能带额外修饰，如 b_algo b_amoyo，用属性包含匹配）
  const algoRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = algoRe.exec(html)) !== null) {
    const block = m[1]
    // 标题链接：<h2><a href="...">标题</a></h2>（标题内可能有 <strong> 高亮标签）
    const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const url = decodeEntities(a[1])
    const title = stripTags(decodeEntities(a[2]))
    if (!url || !title) continue
    // 摘要：<div class="b_caption"><p class="b_lineclamp2">…</p></div>
    const cap = block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = cap ? stripTags(decodeEntities(cap[1])) : ''
    out.push({ title, url, snippet })
  }
  return out
}

/** Bing 结果提取器（隐藏浏览器内执行；li.b_algo 块） */
const BING_EXTRACTOR = `(() => {
  const items = Array.from(document.querySelectorAll('li.b_algo')).slice(0, 10)
  const out = []
  for (const li of items) {
    const a = li.querySelector('h2 a') || li.querySelector('a[href]')
    if (!a) continue
    const href = a.getAttribute('href') || ''
    const title = (a.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!href || !title) continue
    const cap = li.querySelector('.b_caption, .b_snippet, .b_lineclamp2, .b_algo p')
    const snippet = (cap ? cap.textContent : '').replace(/\\s+/g, ' ').trim()
    out.push({ title, url: href, snippet })
  }
  return out
})()`

/** 百度结果提取器（隐藏浏览器内执行；#content_left 下的结果卡片） */
const BAIDU_EXTRACTOR = `(() => {
  const nodes = Array.from(document.querySelectorAll('#content_left > div')).slice(0, 12)
  const out = []
  for (const node of nodes) {
    const a = node.querySelector('h3 a[href]') || node.querySelector('a[href]')
    if (!a) continue
    const href = a.href || a.getAttribute('href') || ''
    const title = (a.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!href || !title || !/^https?:/i.test(href)) continue
    const cap = node.querySelector('[class*="content-right"], .c-abstract, [class*="c-span-last"], [class*="c-color-text"]')
    const snippet = (cap ? cap.textContent : '').replace(/\\s+/g, ' ').trim()
    out.push({ title, url: href, snippet })
  }
  return out
})()`

/** DuckDuckGo 结果提取器（隐藏浏览器内执行；html.duckduckgo.com） */
const DDG_EXTRACTOR = `(() => {
  const nodes = Array.from(document.querySelectorAll('.result, .web-result')).slice(0, 12)
  const out = []
  for (const node of nodes) {
    const a = node.querySelector('a.result__a') || node.querySelector('a[href]')
    if (!a) continue
    const href = a.href || ''
    const title = (a.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!href || !title) continue
    const cap = node.querySelector('.result__snippet')
    const snippet = (cap ? cap.textContent : '').replace(/\\s+/g, ' ').trim()
    out.push({ title, url: href, snippet })
  }
  return out
})()`

/** 反爬兜底：在隐藏 Chromium 中真正加载搜索页，等 JS 渲染后用 extractor 从 DOM 提取结果。 */
async function searchViaBrowser(url: string, extractor: string, label: string, timeoutMs = 25000): Promise<WebSearchItem[]> {
  return new Promise<WebSearchItem[]>((resolve, reject) => {
    let settled = false
    let win: BrowserWindow | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (win && !win.isDestroyed()) win.destroy() } catch { /* 忽略 */ }
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${label} 浏览器搜索超时`)))
    }, timeoutMs)
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          sandbox: true,
        },
      })
      // 隐藏抓取窗口：不参与全局窗口缩放（缩放会改变页面布局，影响抓取结果）
      excludeFromAppZoom(win)
      const wc = win.webContents
      wc.on('did-finish-load', async () => {
        try {
          await new Promise(r => setTimeout(r, 1500))
          const data = await wc.executeJavaScript(extractor) as WebSearchItem[]
          if (Array.isArray(data) && data.length > 0) {
            finish(() => resolve(data.map((it) => ({
              title: String(it?.title || '').trim(),
              url: String(it?.url || '').trim(),
              snippet: String(it?.snippet || '').trim(),
              summary: String(it?.snippet || '').trim(),
            })).filter((it) => it.title && it.url)))
          } else {
            finish(() => reject(new Error(`${label} 浏览器页面中未解析到搜索结果`)))
          }
        } catch (e: any) {
          finish(() => reject(new Error(`${label} 浏览器提取失败: ${e?.message || String(e)}`)))
        }
      })
      wc.on('did-fail-load', (_e, code, desc) => {
        finish(() => reject(new Error(`${label} 浏览器加载失败 (${code}): ${desc}`)))
      })
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.loadURL(url)
    } catch (e: any) {
      finish(() => reject(new Error(`${label} 浏览器启动失败: ${e?.message || String(e)}`)))
    }
  })
}

/** Bing 网页搜索对中文查询的拆词/实体识别不稳定：
 *  1. 句中「的」会导致整句崩坏（「最新款的小米手机」→ 只命中「最」）；
 *  2. 「如何/怎么/怎样 + 动词 + 名词」结构会把动词当核心（「如何制作咖啡」→ 需把「咖啡」置前）。
 *  改写为关键词查询：去掉「的」与疑问语气词，并尽量把核心名词短语放到前面。 */
function rewriteQueryForBing(q: string): string {
  let s = q.trim()
  if (!s) return q
  // 去掉句末标点与疑问语气词（有哪些/是什么/什么样/如何/怎么/多少…）
  s = s.replace(/[？?。！!～~]+$/g, '')
  s = s.replace(
    /(有哪些|是哪些|是什么样|是怎么样|是啥样|是什么|是啥|怎么样|什么样|如何|怎么|怎样|多少|什么|哪款|哪些|吗|呢|吧|啊|哦|呀|的)$/g,
    '',
  )
  // 句中「的」全部去掉（Bing 对带「的」的长句拆词极不稳定）
  s = s.replace(/的/g, '')
  // 动词前置重排：把「如何/怎么/怎样 + 动词 + 名词短语」改为「名词短语（+ 动词）」，
  // 让核心名词出现在查询开头（Bing 以首段为实体识别锚点）。
  // 例：「如何制作咖啡」→「咖啡制作」；「怎么泡手冲咖啡」→「手冲咖啡」（单字动词拼上反而破坏实体识别）。
  // 动词用常见表识别（避免把「制作」猜成单字「制」）。
  const ASK_VERBS = ['制作', '学习', '使用', '选择', '设置', '安装', '下载', '操作', '练习', '掌握', '泡', '做', '写', '煮', '冲', '调', '查', '找', '开', '买', '用', '学']
  const askRe = /^(如何|怎么|怎样|怎么样|咋)(.+)$/u
  const am = s.match(askRe)
  if (am) {
    const body = am[2]
    const v = ASK_VERBS.find(vb => body.startsWith(vb))
    if (v && body.length > v.length) {
      const rest = body.slice(v.length).trim()
      if (rest.length >= 2) {
        // 双字及以上动词（制作/学习/使用…）拼到名词后，Bing 识别为「名词+动词」短语；
        // 单字动词（泡/煮/冲/做…）拼接会破坏名词实体（「手冲咖啡泡」→ 崩），只保留名词短语
        s = v.length >= 2 ? `${rest}${v}` : rest
      }
    }
  }
  // 修饰语开头后置：Bing 把查询首段当作核心实体，「最新款/详细/新款/新版/2026」等
  // 修饰语开头会导致实体识别失败（「最新款小米手机」→ 只命中「最」）。
  // 把这些修饰语移到名词短语之后（「最新款小米手机」→「小米手机最新款」）。
  const MOD_PREFIX = /^(最新款|新款|新版|详细|完整的?|全面|超详细|高级|高端|入门|基础|专业|简易|简单|2026年?|2025年?|2024年?)/u
  const mp = s.match(MOD_PREFIX)
  if (mp && s.length > mp[0].length) {
    const rest = s.slice(mp[0].length)
    if (rest.length >= 2) s = `${rest}${mp[0].replace(/年$/, '')}`
  }
  // 归一空白（去除后重排产生的多余空格）
  s = s.replace(/\s+/g, '').trim()
  return s || q
}

// ---------------------------------------------------------------------------
// 搜索结果解析（HTML 兜底通道）/ 通用 HTTP / 各搜索源实现
// ---------------------------------------------------------------------------

/** 解析百度搜索结果页（结果卡片 → 标题/链接/摘要） */
function parseBaiduResults(html: string): WebSearchItem[] {
  const out: WebSearchItem[] = []
  const blockRe = /<div[^>]*class="[^"]*result[^"]*c-container[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*result[^"]*c-container|<\/body>)/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1]
    const a = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const url = decodeEntities(a[1])
    const title = stripTags(decodeEntities(a[2]))
    if (!/^https?:/i.test(url) || !title) continue
    const cap = block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || block.match(/<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    out.push({ title, url, snippet: cap ? stripTags(decodeEntities(cap[1])) : '' })
  }
  return out
}

/** DuckDuckGo 跳转链接（//duckduckgo.com/l/?uddg=...）还原为真实 URL */
function unwrapDdgUrl(u: string): string {
  try {
    if (!/duckduckgo\.com\/l\//.test(u)) return u
    const abs = u.startsWith('//') ? `https:${u}` : u
    const target = new URL(abs).searchParams.get('uddg')
    return target ? decodeURIComponent(target) : u
  } catch {
    return u
  }
}

/** 解析 DuckDuckGo HTML 端点（result__a 标题 + result__snippet 摘要） */
function parseDdgResults(html: string): WebSearchItem[] {
  const out: WebSearchItem[] = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = unwrapDdgUrl(decodeEntities(m[1]))
    const title = stripTags(decodeEntities(m[2]))
    if (!url || !title) continue
    out.push({ title, url, snippet: '' })
  }
  // 摘要单独扫一遍（与标题顺序一一对应）
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let i = 0
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html)) !== null && i < out.length) {
    out[i].snippet = stripTags(decodeEntities(sm[1]))
    i++
  }
  return out
}

/** GET 文本（搜索页兜底通道；带浏览器 UA 与超时） */
async function fetchSearchText(url: string, headers: Record<string, string> = {}, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': SEARCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 请求 JSON 接口（各 API 搜索源；失败时截取响应片段，便于定位 Key/额度问题） */
async function fetchSearchJson(url: string, init: RequestInit = {}, timeoutMs = 25000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': SEARCH_UA,
        Accept: 'application/json',
        ...((init.headers as Record<string, string>) || {}),
      },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`响应不是合法 JSON：${text.slice(0, 200)}`)
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 统一清洗结果（去空值、只保留 http(s) 链接） */
function cleanSearchItems(items: any[]): WebSearchItem[] {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      title: String(it?.title || '').trim(),
      url: String(it?.url || '').trim(),
      snippet: String(it?.snippet || '').trim(),
    }))
    .filter((it) => it.title && /^https?:/i.test(it.url))
}

/** 单次搜索产物：结果列表 + 实际通道（browser / html-fallback / html / json / api） */
interface SearchOutcome {
  items: WebSearchItem[]
  via: string
}

/** Bing：隐藏浏览器渲染为主，HTML 解析兜底 */
async function searchBingWeb(query: string): Promise<SearchOutcome> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`
  try {
    const items = await searchViaBrowser(url, BING_EXTRACTOR, 'Bing')
    if (items.length) return { items, via: 'browser' }
    throw new Error('未解析到搜索结果')
  } catch (browserError: any) {
    const html = await fetchSearchText(url)
    const items = parseBingResults(html)
    if (items.length) return { items, via: 'html-fallback' }
    throw new Error(`未解析到搜索结果（浏览器通道：${browserError?.message || String(browserError)}）`)
  }
}

/** 百度：隐藏浏览器渲染为主，HTML 解析兜底 */
async function searchBaiduWeb(query: string): Promise<SearchOutcome> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`
  try {
    const items = await searchViaBrowser(url, BAIDU_EXTRACTOR, '百度')
    if (items.length) return { items, via: 'browser' }
    throw new Error('未解析到搜索结果')
  } catch (browserError: any) {
    const html = await fetchSearchText(url)
    const items = parseBaiduResults(html)
    if (items.length) return { items, via: 'html-fallback' }
    throw new Error(`未解析到搜索结果（浏览器通道：${browserError?.message || String(browserError)}）`)
  }
}

/** DuckDuckGo：HTML 端点为主，隐藏浏览器兜底 */
async function searchDuckDuckGoWeb(query: string): Promise<SearchOutcome> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  try {
    const html = await fetchSearchText(url)
    const items = parseDdgResults(html)
    if (items.length) return { items, via: 'html' }
    throw new Error('HTML 页面中未解析到结果')
  } catch (htmlError: any) {
    const items = await searchViaBrowser(url, DDG_EXTRACTOR, 'DuckDuckGo')
    if (items.length) return { items, via: 'browser' }
    throw new Error(`未解析到搜索结果（HTML 通道：${htmlError?.message || String(htmlError)}）`)
  }
}

/** SearXNG：自建实例 JSON 接口（实例需开启 format=json） */
async function searchSearxng(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.searxng.apiHost || '').trim().replace(/\/+$/, '')
  if (!host) throw new Error('未配置 SearXNG 实例地址')
  const params = new URLSearchParams({ q: query, format: 'json' })
  if (cfg.searxng.engines) params.set('engines', cfg.searxng.engines)
  if (cfg.searxng.language && cfg.searxng.language !== 'auto') params.set('language', cfg.searxng.language)
  const data = await fetchSearchJson(`${host}/search?${params.toString()}`)
  return {
    items: cleanSearchItems((data?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: r?.content ?? r?.snippet,
    }))),
    via: 'json',
  }
}

/** 博查 Bocha：POST /v1/web-search（Bearer） */
async function searchBocha(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.bocha.apiHost || 'https://api.bochaai.com').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.bocha.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置博查 API Key')
  const data = await fetchSearchJson(`${host}/v1/web-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: cfg.maxResults, summary: true }),
  })
  if (data?.code !== undefined && Number(data.code) !== 200) {
    throw new Error(`博查返回错误：${data?.msg || data?.code}`)
  }
  return {
    items: cleanSearchItems((data?.data?.webPages?.value || []).map((r: any) => ({
      title: r?.name, url: r?.url, snippet: r?.summary || r?.snippet,
    }))),
    via: 'api',
  }
}

/** 智谱 BigModel：POST /web_search（Bearer；search_std / search_pro） */
async function searchZhipu(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.zhipu.apiHost || 'https://open.bigmodel.cn/api/paas/v4').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.zhipu.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置智谱 API Key')
  const data = await fetchSearchJson(`${host}/web_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      search_query: query,
      search_engine: cfg.zhipu.searchEngine || 'search_std',
      count: cfg.maxResults,
    }),
  })
  return {
    items: cleanSearchItems((data?.search_result || []).map((r: any) => ({
      title: r?.title, url: r?.link || r?.url, snippet: stripTags(String(r?.content || '')),
    }))),
    via: 'api',
  }
}

/** Tavily：POST /search（Bearer） */
async function searchTavily(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.tavily.apiHost || 'https://api.tavily.com').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.tavily.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 Tavily API Key')
  const data = await fetchSearchJson(`${host}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: cfg.maxResults }),
  })
  return {
    items: cleanSearchItems((data?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: r?.content,
    }))),
    via: 'api',
  }
}

/** Brave Search：GET /res/v1/web/search（X-Subscription-Token） */
async function searchBrave(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.brave.apiHost || 'https://api.search.brave.com').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.brave.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 Brave Search API Key')
  const params = new URLSearchParams({ q: query, count: String(cfg.maxResults) })
  const data = await fetchSearchJson(`${host}/res/v1/web/search?${params.toString()}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  return {
    items: cleanSearchItems((data?.web?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: stripTags(String(r?.description || '')),
    }))),
    via: 'api',
  }
}

// ---------------------------------------------------------------------------
// 自定义（内网）搜索源
//
// 设置页可添加任意数量的自定义源（`config.customs`，搜索源 id 形如 `cs:<id>`）：
// - searxng：内网 SearXNG 兼容实例（`<地址>/search?q=&format=json`）
// - json：通用 HTTP JSON 接口（URL 模板 `{query}` 占位 / POST 请求体 / 请求头 / 字段映射）
// 地址允许不带协议（自动补 http://），结果中的相对链接按请求地址补全为绝对地址。
// ---------------------------------------------------------------------------

/** 归一化自定义源地址（去尾斜杠；缺协议时补 http://，便于内网 IP:端口 直接填写） */
function normalizeCustomHost(raw: string): string {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`
  return s
}

/** 点号路径取值（`data.list` / `hits.hits`）；路径为空时返回原对象 */
function pickJsonPath(root: any, pathStr: string): any {
  const keys = String(pathStr || '').split('.').map((k) => k.trim()).filter(Boolean)
  let cur = root
  for (const k of keys) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

/** 未填「结果路径」时按常见字段自动识别结果数组 */
const AUTO_ITEMS_PATHS = [
  'results', 'data.results', 'data.list', 'data.items', 'data.data', 'data',
  'items', 'list', 'hits.hits', 'webPages.value', 'search_result', 'documents', 'docs',
]

function resolveItemsArray(data: any, itemsPath: string): any[] {
  if (itemsPath) {
    const v = pickJsonPath(data, itemsPath)
    return Array.isArray(v) ? v : []
  }
  if (Array.isArray(data)) return data
  for (const p of AUTO_ITEMS_PATHS) {
    const v = pickJsonPath(data, p)
    if (Array.isArray(v) && v.length) return v
  }
  return []
}

/** 结果项字段取值（支持点号路径；未配置字段时按候选名依次尝试） */
function pickItemField(item: any, field: string, fallbacks: string[]): string {
  for (const f of field ? [field] : fallbacks) {
    const v = pickJsonPath(item, f)
    if (v == null) continue
    const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
    if (s.trim()) return s.trim()
  }
  return ''
}

/** 解析自定义请求头文本（每行 `Key: Value`；值中的 `{key}` 替换为 API Key） */
function parseCustomHeaderLines(text: string, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf(':')
    if (i <= 0) continue
    const key = s.slice(0, i).trim()
    if (!key) continue
    out[key] = s.slice(i + 1).trim().replace(/\{key\}/g, apiKey)
  }
  return out
}

/** 自定义源请求头（自定义头 + 未指定 Authorization 时用 API Key 补 Bearer） */
function buildCustomHeaders(cs: WebSearchCustomSource, apiKey: string): Record<string, string> {
  const headers = parseCustomHeaderLines(cs.headers, apiKey)
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
  if (apiKey && !hasAuth) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

/** 请求 URL 拼接：含 `{query}` 占位则替换；否则 POST 用原地址，GET 自动追加 `q` 参数 */
function buildCustomUrl(base: string, query: string, method: 'GET' | 'POST'): string {
  if (!base) throw new Error('未配置请求地址')
  if (base.includes('{query}')) return base.replace(/\{query\}/g, encodeURIComponent(query))
  if (method === 'POST') return base
  return `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`
}

/** 把内网源返回的相对链接补全为绝对地址（http/https 或 // 开头原样返回） */
function resolveItemUrl(raw: string, base: string): string {
  const u = String(raw || '').trim()
  if (!u) return ''
  if (/^https?:/i.test(u)) return u
  if (u.startsWith('//')) return `https:${u}`
  if (!base) return ''
  try {
    return new URL(u, base).toString()
  } catch {
    return ''
  }
}

/** 自定义（内网）搜索源：searxng 兼容实例 / 通用 HTTP JSON 接口 */
async function searchCustomSource(
  cs: WebSearchCustomSource,
  query: string,
  config: WebSearchConfig,
): Promise<SearchOutcome> {
  const name = cs.name || '自定义源'
  const apiKey = String(cs.apiKey || '').trim()
  const base = normalizeCustomHost(cs.apiHost)
  if (!base) throw new Error(`自定义源「${name}」未配置请求地址`)

  // SearXNG 兼容实例：GET <地址>/search?q=&format=json
  if (cs.kind === 'searxng') {
    const params = new URLSearchParams({ q: query, format: 'json' })
    if (cs.engines) params.set('engines', cs.engines)
    if (cs.language && cs.language !== 'auto') params.set('language', cs.language)
    const data = await fetchSearchJson(`${base}/search?${params.toString()}`, {
      headers: buildCustomHeaders(cs, apiKey),
    })
    return {
      items: cleanSearchItems((data?.results || []).map((r: any) => ({
        title: r?.title,
        url: resolveItemUrl(String(r?.url || ''), base),
        snippet: r?.content ?? r?.snippet,
      }))),
      via: 'custom-searxng',
    }
  }

  // 通用 HTTP JSON 接口：URL 模板 / POST 请求体 / 自定义头 / 字段映射
  const url = buildCustomUrl(base, query, cs.method)
  const init: RequestInit = { method: cs.method, headers: buildCustomHeaders(cs, apiKey) }
  if (cs.method === 'POST') {
    const tpl = String(cs.bodyTemplate || '').trim()
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    // `{query}` 原样替换（JSON 模板请自行加引号）；转义反斜杠与双引号避免拼出非法 JSON
    init.body = tpl
      ? tpl.replace(/\{query\}/g, query.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
      : JSON.stringify({ query, count: config.maxResults })
  }
  const data = await fetchSearchJson(url, init)
  const arr = resolveItemsArray(data, String(cs.itemsPath || '').trim())
  if (!arr.length) {
    throw new Error(`自定义源「${name}」响应中未解析到结果数组（可在「结果路径」填 data.list 之类的字段路径）`)
  }
  return {
    items: cleanSearchItems(arr.slice(0, Math.max(config.maxResults, 20)).map((it: any) => ({
      title: pickItemField(it, cs.titleField, ['title', 'name', 'subject', 'heading', 'docTitle']),
      url: resolveItemUrl(pickItemField(it, cs.urlField, ['url', 'link', 'href', 'uri', 'path']), base),
      snippet: pickItemField(it, cs.snippetField, ['snippet', 'content', 'summary', 'description', 'text', 'abstract']),
    }))),
    via: 'custom-json',
  }
}

/** 单个搜索源执行（Bing/百度 走查询改写；其余源保持原句） */
async function runSingleSearch(
  provider: WebSearchProviderId,
  query: string,
  config: WebSearchConfig,
): Promise<SearchOutcome> {
  // 自定义（内网）源：按配置中的类型与字段映射执行
  const custom = findWebSearchCustomSource(config, provider)
  if (custom) return searchCustomSource(custom, query, config)
  // Bing 对长中文句拆词/实体识别不稳定 → 仅 Bing 走查询改写（其余源保持原句）
  const q = provider === 'bing' && config.rewriteZhQuery ? (rewriteQueryForBing(query) || query) : query
  switch (provider) {
    case 'baidu': return searchBaiduWeb(q)
    case 'duckduckgo': return searchDuckDuckGoWeb(q)
    case 'searxng': return searchSearxng(q, config)
    case 'bocha': return searchBocha(q, config)
    case 'zhipu': return searchZhipu(q, config)
    case 'tavily': return searchTavily(q, config)
    case 'brave': return searchBrave(q, config)
    case 'bing':
    default: return searchBingWeb(q)
  }
}

/** 结果清洗 + 截断到 maxResults（统一工具返回值形状） */
function toSearchItems(items: WebSearchItem[], maxResults: number): WebSearchItem[] {
  return items.slice(0, maxResults).map((it) => ({
    title: it.title,
    url: it.url,
    snippet: it.snippet || '',
    summary: it.snippet || '',
  }))
}

/** 按 URL 去重合并多个源的结果（保持源顺序；同 URL 保留先出现的项） */
function mergeSearchItems(groups: WebSearchItem[][], maxResults: number): WebSearchItem[] {
  const seen = new Set<string>()
  const out: WebSearchItem[] = []
  for (const group of groups) {
    for (const it of group) {
      const key = String(it.url || '').replace(/\/+$/, '').toLowerCase() || `${it.title}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(it)
      if (out.length >= maxResults) return out
    }
  }
  return out
}

/**
 * 执行一次联网搜索（web_search 工具与设置页「测试搜索」共用）。
 * 支持多源：`fallback` 依次回退（第一个有结果的源胜出）/ `merge` 并行后合并去重。
 * 全部源失败或均无结果时抛错（错误信息带各源原因）。
 */
export async function runWebSearch(rawQuery: string, cfg: WebSearchConfig = webSearchConfig): Promise<WebSearchRunResult> {
  const query = String(rawQuery ?? '').trim()
  if (!query) throw new Error('搜索关键词不能为空')
  const config = normalizeWebSearchConfig(cfg)
  const providers = config.providers
  const started = Date.now()

  if (config.strategy === 'merge') {
    // 并行聚合：所有启用源同时执行，成功的结果按源顺序合并去重
    const settled = await Promise.allSettled(providers.map((id) => runSingleSearch(id, query, config)))
    const groups: WebSearchItem[][] = []
    const attempts: Array<{ provider: WebSearchProviderId; ok: boolean; error?: string }> = []
    settled.forEach((s, i) => {
      const id = providers[i]
      if (s.status === 'fulfilled' && s.value.items.length) {
        groups.push(s.value.items)
        attempts.push({ provider: id, ok: true })
      } else {
        attempts.push({
          provider: id,
          ok: false,
          error: s.status === 'fulfilled' ? '未返回结果' : (s.reason?.message || String(s.reason)),
        })
      }
    })
    const results = mergeSearchItems(groups, config.maxResults)
    if (!results.length) {
      const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join('；')
      throw new Error(`全部搜索源均未返回结果 —— ${detail}`)
    }
    return {
      query,
      provider: attempts.find((a) => a.ok)!.provider,
      providers,
      via: 'merge',
      results,
      elapsedMs: Date.now() - started,
      attempts,
    }
  }

  // 回退：按配置顺序逐个尝试，第一个有结果的源胜出
  const attempts: Array<{ provider: WebSearchProviderId; ok: boolean; error?: string }> = []
  for (const id of providers) {
    try {
      const outcome = await runSingleSearch(id, query, config)
      if (outcome.items.length) {
        attempts.push({ provider: id, ok: true })
        return {
          query,
          provider: id,
          providers,
          via: outcome.via,
          results: toSearchItems(outcome.items, config.maxResults),
          elapsedMs: Date.now() - started,
          attempts,
        }
      }
      attempts.push({ provider: id, ok: false, error: '未返回结果' })
    } catch (e: any) {
      attempts.push({ provider: id, ok: false, error: e?.message || String(e) })
    }
  }
  const detail = attempts.map((a) => `${a.provider}: ${a.error || '失败'}`).join('；')
  throw new Error(`全部搜索源均失败 —— ${detail}`)
}

async function webSearch(input: any): Promise<ToolResult> {
  const rawQuery = String(input?.query ?? '')
  if (!rawQuery.trim()) return { ok: false, error: 'query 参数必填' }
  try {
    const r = await runWebSearch(rawQuery)
    if (!r.results.length) return { ok: false, error: `搜索失败（搜索源：${r.provider}）：未返回结果` }
    return {
      ok: true,
      value: {
        query: rawQuery,
        provider: r.provider,
        providers: r.providers,
        via: r.via,
        results: r.results,
      },
    }
  } catch (e: any) {
    // 错误链用搜索源显示名（自定义源显示用户起的名字，比 cs:xxx 直观）
    const chain = webSearchConfig.providers
      .map((id) => webSearchProviderMeta(id, webSearchConfig).label)
      .join(' → ')
    return { ok: false, error: `搜索失败（搜索源：${chain}）：${e?.message || String(e)}` }
  }
}

/** 从 HTML 提取正文文本（去掉 script/style/标签，压缩空白） */
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 反爬兜底：用 Electron 无头 BrowserWindow 加载页面（真实 Chromium 执行 JS，
 * 可过知乎 zh-zse-ck 等 JS 加密挑战），页面加载完成后提取正文文本。
 * 仅作为 webFetch 直接 fetch 失败（403/网络错误）时的降级通道。
 */
async function fetchViaBrowser(url: string, timeoutMs = 25000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let win: BrowserWindow | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (win && !win.isDestroyed()) win.destroy() } catch { /* 忽略 */ }
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('浏览器抓取超时')))
    }, timeoutMs)
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          // 不需要 preload；禁用 node 集成避免页面脚本触碰主进程
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          sandbox: true,
        },
      })
      // 隐藏抓取窗口：不参与全局窗口缩放（缩放会改变页面布局，影响抓取结果）
      excludeFromAppZoom(win)
      const wc = win.webContents
      wc.on('did-finish-load', async () => {
        try {
          // 等一小段让页面 JS 渲染（知乎挑战/懒加载内容）
          await new Promise(r => setTimeout(r, 1200))
          const text = await wc.executeJavaScript(`document.body ? document.body.innerText : ''`)
          if (text && String(text).trim().length > 0) {
            finish(() => resolve(String(text).trim()))
          } else {
            finish(() => reject(new Error('页面无内容')))
          }
        } catch (e: any) {
          finish(() => reject(new Error(`提取失败: ${e?.message || String(e)}`)))
        }
      })
      wc.on('did-fail-load', (_e, code, desc) => {
        finish(() => reject(new Error(`页面加载失败 (${code}): ${desc}`)))
      })
      // 拦截弹窗/新窗口（避免导航跳出）
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.loadURL(url)
    } catch (e: any) {
      finish(() => reject(new Error(`浏览器抓取启动失败: ${e?.message || String(e)}`)))
    }
  })
}

/** 用 pdfjs-dist 从 PDF 字节流提取全文（与 index.ts readPdf 同款实现） */
async function parsePdfBytes(uint8: Uint8Array): Promise<string> {
  const loadingTask = PDFJS.getDocument({ data: uint8 })
  const pdfDocument = await loadingTask.promise
  const pageCount = pdfDocument.numPages
  const parts: string[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDocument.getPage(i)
    const content = await page.getTextContent()
    const strings = (content as { items: { str: string }[] }).items.map((item) => item.str)
    parts.push(strings.join(' '))
  }
  return parts.join('\n')
}

/** 从 .docx 提取 Markdown 文本（统一走 office/docx-to-markdown：atx 标题 / 管道表格 / 编号回填 / 公式 LaTeX；
 *  工具场景只要正文文字，故不提取图片，避免写盘） */
async function parseDocxFile(filePath: string): Promise<string> {
  return docxToMarkdown({ filePath, extractImages: false })
}

/** 二维数组 → Markdown 表格（与 index.ts convertToMarkdown 同款） */
function rowsToMarkdown(data: any[][]): string {
  let markdown = ''
  const headers = data[0] || []
  markdown += '| ' + headers.join(' | ') + ' |\n'
  markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n'
  for (let i = 1; i < data.length; i++) {
    markdown += '| ' + (data[i] || []).join(' | ') + ' |\n'
  }
  return markdown
}

/** 用 SheetJS 从 .xlsx/.xls 提取 Markdown 表格文本（与 index.ts 同款实现，逐工作表输出） */
async function parseXlsxFile(filePath: string): Promise<string> {
  const workbook = xlsx.readFile(filePath)
  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName]
    const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 }) as any[][]
    if (!Array.isArray(jsonData) || jsonData.length === 0) continue
    parts.push(`## ${sheetName}\n\n${rowsToMarkdown(jsonData)}`)
  }
  return parts.join('\n\n')
}

async function webFetch(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const url = String(input?.url ?? '')
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'url 参数必填（http/https）' }

  // 目标可能为 DOI 链接（doi.org 或裸 DOI）：命中反爬验证页时可直接用 Crossref 降级获取元数据
  const doi = extractDoiFromUrl(url)

  // 通道 1：直接 fetch（快；带浏览器头提高通过率）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  let directError = ''
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': SEARCH_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': new URL(url).origin + '/',
        'Upgrade-Insecure-Requests': '1',
      },
    })
    if (res.ok) {
      // 先读二进制：既能用魔数识别 PDF，也可回退按 UTF-8 解码为 HTML
      const buf = new Uint8Array(await res.arrayBuffer())
      const ctype = (res.headers.get('content-type') || '').toLowerCase()
      const isPdfUrl = /\.pdf($|\?)/i.test(url)
      const isPdfMagic = buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 // %PDF
      if (ctype.includes('application/pdf') || isPdfUrl || isPdfMagic) {
        // PDF 文档：用 pdfjs-dist 提取正文文本（不能按 HTML 文本解码，否则得到 %PDF 乱码）
        try {
          const pdfText = await parsePdfBytes(buf)
          if (pdfText && pdfText.trim().length > 0) {
            return { ok: true, value: { url, text: pdfText.slice(0, 20000), length: pdfText.length, via: 'pdf' } }
          }
          return { ok: false, error: 'PDF 解析结果为空（可能是扫描件/图片型 PDF，建议改用 OCR 或截图）' }
        } catch (e: any) {
          return { ok: false, error: `PDF 解析失败: ${e?.message || String(e)}` }
        }
      }
      const html = new TextDecoder().decode(buf)
      const text = extractTextFromHtml(html)
      if (text.length > 50) {
        // 检测到反爬验证页（人机验证/WAF/Cloudflare）：不当作成功内容返回
        if (isBotChallengePage(text)) {
          if (doi) {
            const crossrefText = await fetchDoiViaCrossref(doi, controller.signal)
            if (crossrefText) {
              return { ok: true, value: { url, text: crossrefText.slice(0, 20000), length: crossrefText.length, via: 'crossref' } }
            }
          }
          directError = '目标站点需要人机验证（验证页）'
        } else {
          return { ok: true, value: { url, text: text.slice(0, 20000), length: text.length, via: 'fetch' } }
        }
      } else {
        directError = '页面内容为空'
      }
    } else {
      directError = `HTTP ${res.status}`
    }
  } catch (e: any) {
    directError = e?.name === 'AbortError' ? '请求超时' : `抓取失败: ${e?.message || String(e)}`
  } finally {
    clearTimeout(timer)
  }

  // 通道 2：反爬兜底 —— 直接 fetch 失败（403/超时/空内容/验证页）时用无头浏览器执行 JS 抓取
  try {
    const bodyText = await fetchViaBrowser(url)
    if (bodyText && bodyText.length > 0 && !isBotChallengePage(bodyText)) {
      return { ok: true, value: { url, text: bodyText.slice(0, 20000), length: bodyText.length, via: 'browser' } }
    }
    return { ok: false, error: `抓取失败: ${directError}` }
  } catch (e: any) {
    return { ok: false, error: `抓取失败: ${directError}（浏览器兜底也失败: ${e?.message || String(e)}）` }
  }
}

// ---------------------------------------------------------------------------
// MCP 调用（统一工具注册表中的 mcp_call，供 Agent 预设/集群控制场景使用）
// ---------------------------------------------------------------------------

/** 参数名归一化比较键（workbook_id ≡ workbookId、sheet_name ≡ sheetName） */
function normArgKey(k: string): string {
  return String(k).toLowerCase().replace(/[_-]/g, '')
}

/**
 * 会话类参数（workbookId / docId …）：不作为前置硬拦截项——
 * 服务端可自动复用唯一已打开的会话，或给出带「当前会话列表」的精确提示。
 */
const SESSION_ARG_RE = /^(workbookid|bookid|wbid|docid|documentid)$/

/** 按工具 inputSchema 找出缺失的非会话必填参数（schema 缺失或无 required 时返回空数组 = 不拦截） */
function missingRequiredArgs(schema: any, args: Record<string, any>): string[] {
  const required: string[] = Array.isArray(schema?.required) ? schema.required.map(String) : []
  if (required.length === 0) return []
  const have = new Set(Object.keys(args || {}).map(normArgKey))
  return required.filter((k) => !SESSION_ARG_RE.test(normArgKey(k)) && !have.has(normArgKey(k)))
}

async function mcpCall(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const ctxServerIds: string[] = (ctx as any).mcpServerIds || ((ctx as any).mcpServerId ? [(ctx as any).mcpServerId] : [])
  // LLM 常把 tool/serverId 误放进 args 内层（或用 toolName 命名）——多层级兜底
  const innerArgs = input?.args && typeof input.args === 'object' && !Array.isArray(input.args) ? (input.args as any) : {}
  const toolName = String(
    input?.tool || input?.toolName || innerArgs.tool || innerArgs.toolName || ''
  )
  if (!toolName) return { ok: false, error: 'mcp_call 缺少 tool 参数' }

  // serverId 解析优先级：模型显式传入 > ctx 中唯一服务 > 主进程已连接服务按工具名自动匹配（唯一）
  let serverId = String(input?.serverId || innerArgs.serverId || innerArgs.server_id || (ctxServerIds.length === 1 ? ctxServerIds[0] : ''))
  if (!serverId && toolName) {
    // LLM 常省略可选参数 serverId：按目标工具名在已连接服务中匹配，唯一命中时自动使用
    const matches = mcpService.findServersByTool(toolName)
    if (matches.length === 1) serverId = matches[0].serverId
    else if (matches.length > 1) {
      const candidates = matches.map((m) => `  - ${m.serverName || m.serverId}（serverId: ${m.serverId}）`).join('\n')
      return {
        ok: false,
        error: `mcp_call 缺少 serverId 且无法自动确定：有 ${matches.length} 个已连接服务都能提供工具「${toolName}」，请在 mcp_call 参数中显式传入 serverId。候选服务：\n${candidates}`,
      }
    }
  }
  if (!serverId) {
    return {
      ok: false,
      error: 'mcp_call 缺少 serverId：请在「设置 → MCP 服务」中启用并连接 MCP 服务，并在「设置 → 工具管理」中启用 mcp_call（智能体/预设模式会自动携带已启用的服务）；也可在 mcp_call 参数中显式传入 serverId。',
    }
  }

  const ctxConfigs: any[] = (ctx as any).mcpServerConfigs || ((ctx as any).mcpServerConfig ? [(ctx as any).mcpServerConfig] : [])
    let config = input?.config || ctxConfigs.find((c: any) => c?.id === serverId) || ctxConfigs[0] || {}
  if (typeof config === 'string') {
    try { config = JSON.parse(config) } catch { config = {} }
  }
  if (!config || typeof config !== 'object') config = {}

  let args = input?.args
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = { _raw: args } }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}

  // 若 tool/serverId 取自 args 内层，从转发参数中剔除，避免污染远端工具入参
  if (!input?.tool && (args.tool !== undefined || args.toolName !== undefined)) {
    delete args.tool
    delete args.toolName
  }
  if (!input?.serverId && (args.serverId !== undefined || args.server_id !== undefined)) {
    delete args.serverId
    delete args.server_id
  }

  // 必填参数前置校验：按工具 schema 检查（别名归一后比较：workbook_id ≡ workbookId、sheet_name ≡ sheetName）。
  // 缺参直接回可操作的提示，不再把空参透传到服务端只换回一句晦涩错误；
  // 会话 ID（workbookId / docId）不在硬拦截之列——见 SESSION_ARG_RE 注释。
  const missing = missingRequiredArgs(mcpService.getToolSchema(serverId, toolName), args)
  if (missing.length) {
    return {
      ok: false,
      error: `mcp_call 调用 ${toolName} 缺少必填参数：${missing.join('、')}（参数名支持别名，如 workbook_id ≡ workbookId、sheet_name ≡ sheetName）`,
    }
  }

  try {
    const res = await mcpService.callTool(serverId, config, toolName, args)
    if (res.success) {
      let data: any = res.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch { /* 保留原文 */ }
      }
      return { ok: true, value: { serverId, tool: toolName, data } }
    }
    return { ok: false, error: res.error || `MCP 工具 ${toolName} 调用失败` }
  } catch (e: any) {
    return { ok: false, error: `MCP 调用异常: ${e?.message || String(e)}` }
  }
}


// ---------------------------------------------------------------------------
// 子代理接缝（路线图 2.6：ctx.subagents 的 in-process provider）
// 模型可用 run_subagent 派生一个独立的 agent 会话执行子任务（复用 agent 循环），
// 等待其完成并取回最终输出；父 agent 销毁时子代理一并销毁。
// ---------------------------------------------------------------------------

async function runSubagent(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const prompt = String(input?.prompt ?? '')
  if (!prompt.trim()) return { ok: false, error: 'prompt 参数必填（子任务描述）' }
  const parentId = ctx.agentId || ctx.sessionId
  if (!parentId) return { ok: false, error: 'run_subagent 只能在 agent 会话内使用' }

  // 通用子代理：不注入群成员身份。群成员之间协作请用 @点名（见 swarmStrategies.buildMemberPrompt）；
  // run_subagent 仅用于委派临时的通用子任务（不占用成员身份、不入群，结果由父 Agent 自行综合）。
  const fallbackTools = ['read_file', 'write_file', 'replace_in_file', 'multi_replace', 'list_dir', 'search_files', 'run_python', 'kb_search', 'web_search', 'web_fetch', 'ask_user', 'update_plan', 'update_todo']
  let baseTools: string[]
  if (Array.isArray(input?.tools)) baseTools = input.tools.map(String)
  else if (Array.isArray((ctx as any).tools)) baseTools = (ctx as any).tools
  else baseTools = fallbackTools
  // 通用子代理不再派生下一级（过滤 run_subagent 防递归）
  const childTools = baseTools.filter((t: string) => t !== 'run_subagent')

  const child = createAgent({
    systemPrompt: input?.systemPrompt
      ? String(input.systemPrompt)
      : '你是一个子代理（subagent），负责独立完成父任务分配给你的子任务。完成后直接输出最终结果。',
    provider: input?.provider || 'ollama',
    config: input?.config,
    llmConfig: input?.llmConfig,
    tools: childTools,
    cwd: ctx.cwd,
    label: `subagent:${parentId}`,
    maxSteps: typeof input?.maxSteps === 'number' ? input.maxSteps : 10,
    sandboxMode: (ctx as any).sandboxMode,
    mcpServerIds: (ctx as any).mcpServerIds,
    mcpServerConfigs: (ctx as any).mcpServerConfigs,
    mcpEquipmentIds: (ctx as any).mcpEquipmentIds,
    kbPaths: (ctx as any).kbPaths,
    parentId,
  })

  try {
    child.send(prompt, 'subagent')
    await child.whenIdle()
    // 子代理最终输出：直接读会话维护的 lastContent（比日志重建可靠，避免 output 为空）
    const output = getAgentLastContent(child.id)
    return { ok: true, value: { agentId: child.id, output } }
  } catch (e: any) {
    return { ok: false, error: `子代理执行失败: ${e?.message || String(e)}` }
  } finally {
    await disposeAgent(child.id)
  }
}

// ---------------------------------------------------------------------------
// Word 导出接缝（export_word）
//
// 渲染 / MathJax / mermaid / canvas 能力只在渲染进程具备，故主进程只负责
// 「取内容 + 定位置 + 路径围栏」，实际导出经 requestRendererTask 交由渲染层执行
// 并复用 md-to-docx / docx.ts 同一套代码（效果与手动导出完全一致）。
// ---------------------------------------------------------------------------

/** 单次导出的 Markdown 规模上限（3MB：防止超长内容撑爆 IPC 与导出管线） */
const EXPORT_WORD_MAX_BYTES = 3 * 1024 * 1024

async function exportWord(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const agentId = ctx.agentId
  if (!agentId) return { ok: false, error: 'export_word 只能在智能体会话内使用' }

  const markdownArg = typeof input?.markdown === 'string' ? input.markdown : ''
  const pathArg = String(input?.path ?? '').trim()
  if (!markdownArg.trim() && !pathArg) {
    return { ok: false, error: '需要提供 markdown（Markdown 内容）或 path（.md 文件路径）之一' }
  }

  // 1. 内容来源：显式内容优先，否则读文件（走统一路径围栏）
  let markdown = markdownArg
  if (!markdown.trim()) {
    const abs = resolveWithinCwd(pathArg, ctx)
    if (!abs) return { ok: false, error: `路径越界或非法: ${pathArg}` }
    try {
      if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${pathArg}` }
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) return { ok: false, error: `是目录而非文件: ${pathArg}` }
      if (stat.size > EXPORT_WORD_MAX_BYTES) {
        return { ok: false, error: `Markdown 文件过大（${Math.round(stat.size / 1024)}KB，上限 ${EXPORT_WORD_MAX_BYTES / 1024}KB），请拆分后再导出` }
      }
      markdown = fs.readFileSync(abs, 'utf-8')
    } catch (e: any) {
      return { ok: false, error: `读取 Markdown 失败: ${e?.message || String(e)}` }
    }
  }
  if (!markdown.trim()) return { ok: false, error: 'Markdown 内容为空' }
  if (Buffer.byteLength(markdown, 'utf8') > EXPORT_WORD_MAX_BYTES) {
    return { ok: false, error: `Markdown 内容过大（超过 ${EXPORT_WORD_MAX_BYTES / 1024}KB），请拆分后再导出` }
  }

  // 2. 保存位置：output_path 可以是 .docx 完整路径，也可以是目录（目录 → 拼 file_name）
  const rawName = String(input?.file_name ?? input?.fileName ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
  const fileName = rawName || '导出文档'
  let targetPath = String(input?.output_path ?? input?.outputPath ?? '').trim()
  if (targetPath) {
    try {
      const isDirPath = /[\\/]$/.test(targetPath)
      if (isDirPath || (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory())) {
        targetPath = path.join(targetPath, /\.docx$/i.test(fileName) ? fileName : `${fileName}.docx`)
      } else if (!/\.docx$/i.test(targetPath)) {
        // 既不是目录也缺扩展名：按 .docx 处理，避免写出无后缀文件
        targetPath = `${targetPath}.docx`
      }
    } catch { /* 路径不可判定时按原样交给写盘层 */ }
  } else {
    // 未指定位置：只给文件名，由主进程 exportDocx 落到系统下载目录
    targetPath = /\.docx$/i.test(fileName) ? fileName : `${fileName}.docx`
  }

  // 3. 交由渲染层执行（复用统一导出管线），结果原样返回给模型
  try {
    const res = await requestRendererTask(agentId, 'export_word', {
      markdown,
      targetPath,
      template: String(input?.template ?? '').trim(),
      overwrite: input?.overwrite === true,
    })
    return { ok: true, value: res && typeof res === 'object' ? res : { path: targetPath } }
  } catch (e: any) {
    return { ok: false, error: `Word 导出失败: ${e?.message || String(e)}` }
  }
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

/** 注册全部核心工具（应用启动时调用一次；幂等） */
// ============ 浏览器 Agent 工具（M0/M1：进程内 MCP server 同名内核工具，通用智能体可直接调用） ============
const runBrowserAgentTool = (tool: string) => async (args: any, ctx: ToolExecutionContext): Promise<ToolResult> => {
  try {
    const input = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
    // 把调用方 agent 会话 id（agentId/sessionId）传给浏览器服务 → 新建的 AI 标签带上属主，
    // 该会话 idle/dispose 时主进程可精确回收它自己的标签（谁结束收谁的，不依赖全局 90s 静默/cap）
    const owner = (ctx?.sessionId || ctx?.agentId) ? String(ctx?.sessionId || ctx?.agentId) : undefined
    const text = await browserAgentService.executeTool(tool, input, owner ? { owner } : undefined)
    return { ok: true, value: text }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export function registerCoreTools(): void {
  // ============ 浏览器 Agent 工具（进程内 MCP server 同名内核工具；单一 schema 来源 = browserAgentService.toolDefinitions()） ============
  for (const def of browserAgentService.toolDefinitions()) {
    toolRegistry.register(
      defineTool(def.name, def.description, runBrowserAgentTool(def.name), {
        inputSchema: def.inputSchema,
      }),
    )
  }
  toolRegistry.register(
    defineTool('read_file', '读取本地文件内容（UTF-8；PDF / Word(.docx) / Excel(.xlsx,.xls) 自动提取文本）。支持绝对路径（可读任意位置文件）与相对路径（基于工作区根；传 skill 时基于该技能目录）。单次返回有上限（纯文本约前 100KB、PDF/Word/Excel 前 20000 字符），超出时返回 truncated=true 与 nextOffset——把 nextOffset 作为 offset 再调用一次即可续读后续内容，反复续读直到 truncated=false 即读完全文（limit 可显式指定单次字符数，上限 102400）。超大文本文件（>16MB）只返回开头样本，请改用 run_python 完整处理。', readFile, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径可访问任意文件；相对路径基于工作区根，传 skill 时基于技能目录）' },
          skill: { type: 'string', description: '可选。技能名（kebab-case，容错匹配）：path 按该技能目录解析，用于读取技能自带资源（如 path="references/x.md"）' },
          offset: { type: 'integer', description: '可选。起始字符偏移（从 0 起，默认 0）；续读时填上一次返回的 nextOffset' },
          limit: { type: 'integer', description: '可选。本次最多返回的字符数（默认：纯文本约 100KB、PDF/Word/Excel 20000；上限 102400）' },
        },
        required: ['path'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('write_file', '写入本地文件（UTF-8，自动创建父目录）。支持绝对路径与相对路径（基于工作区根）。', writeFile, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径或相对工作区根）' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('replace_in_file', '在文件中定位一段唯一原文并替换为新内容（UTF-8 文本，精确局部修改，文件其余部分保持不变）。old_string 必须与文件内容精确一致（含缩进与上下文，建议 ≥3 行）——调用前请先用 read_file 读取目标区域，把要改的内容【原样复制】过来，不要凭记忆手写；默认要求全文唯一：出现多处会报错并列出各出现行号（此时请补充更多上下文使其唯一，或传 occurrence 指定第几处），未找到会返回【可直接复制的候选片段】，请据此修正后重试（不要重复提交同一段 old_string）。new_string 传空字符串表示删除该段。替换会保留文件的换行风格（CRLF/LF）。文件较小（约 200 行以内）时直接用 write_file 整写更稳。', replaceInFile, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径或相对工作区根）' },
          old_string: { type: 'string', description: '要被替换的精确原文段（含足够上下文，默认要求全文唯一）' },
          new_string: { type: 'string', description: '替换后的新内容；传空字符串表示删除该段' },
          occurrence: { type: 'integer', description: '可选。old_string 出现多处时指定替换第几处（从 1 起）；不传则要求唯一' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('multi_replace', '在一次调用中批量替换多处代码（可跳多个文件），所有替换全部命中才整体落盘（原子）：任一条 old_string 未找到或不唯一都会使整批不生效，避免文件处于"改了一半"的中间态。适合同一文件多处 / 多文件联动的修改；同一文件的替换区间不能重叠。每条 old_string 同样必须先 read_file 读到原文后【原样复制】（含缩进）。单处替换请用 replace_in_file。', multiReplace, {
      inputSchema: {
        type: 'object',
        properties: {
          replacements: {
            type: 'array',
            description: '要执行的替换列表（按位置降序应用，与顺序无关）',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '文件路径（绝对路径或相对工作区根）' },
                old_string: { type: 'string', description: '要被替换的精确原文段（默认要求在该文件中唯一）' },
                new_string: { type: 'string', description: '替换后的新内容；传空字符串表示删除该段' },
              },
              required: ['path', 'old_string', 'new_string'],
            },
          },
        },
        required: ['replacements'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('list_dir', '列出目录条目（名称与类型）。可用绝对路径查看任意目录（如 D:\\），相对路径基于工作区根；传 skill 时改为列出该技能目录。', listDir, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径（绝对路径可访问任意位置；相对路径基于工作区根，传 skill 时基于技能目录；默认 .）' },
          skill: { type: 'string', description: '可选。技能名（kebab-case，容错匹配）：改为列出该技能目录（path 相对该目录解析）' },
        },
      },
    }),
  )
  toolRegistry.register(
    defineTool('search_files', '按文本搜索文件内容，返回匹配的文件路径、行号与内容片段。默认搜索工作区；传 skill 时搜索该技能目录。', searchFiles, {
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          root: { type: 'string', description: '可选，搜索根目录（绝对路径或相对工作区根；缺省用工作区根）' },
          skill: { type: 'string', description: '可选。技能名（kebab-case，容错匹配）：在该技能目录内搜索（优先于 root）' },
          filePattern: { type: 'string', description: '可选，扩展名过滤（如 .ts）' },
          maxResults: { type: 'number', description: '可选，最大结果数（默认 30）' },
        },
        required: ['query'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('run_python', '执行 Python 代码。默认只读沙箱；需要写工作区时传 sandbox=workspace；完全访问可传 sandbox=trusted。', runPython, {
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 Python 代码' },
          input: { description: '作为 input 注入执行环境的输入' },
        },
        required: ['code'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('shell', '执行 shell 命令（仅「完全访问」沙箱模式可用；否则被策略拒绝并返回原因）。', runShell, {
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
        required: ['command'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('run_subagent', '派生一个独立的子代理会话执行子任务（复用 agent 循环），等待其完成后返回最终输出。支持 member=<群成员名> 以该成员的设定（角色/模型/工具/知识库）执行（AgentSwarm 群成员化，结果会以该成员名义汇报）；子代理默认白名单不含 run_subagent（防递归）。', runSubagent, {
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '子任务描述（发给子代理的首条消息）' },
          member: { type: 'string', description: '可选，群成员名（AgentSwarm 团队成员；缺省为通用子代理）' },
          systemPrompt: { type: 'string', description: '可选，子代理系统提示词；缺省用通用子代理提示' },
          provider: { type: 'string', description: '可选，LLM provider；缺省 ollama（member 时用成员自身的 provider/model）' },
          config: { type: 'object', description: '可选，provider 配置（含 api_key 或 apiKeyRef）' },
          llmConfig: { type: 'object', description: '可选，通用 LLM 配置' },
          maxSteps: { type: 'number', description: '可选，子代理单 turn 最大 step 数（默认 10）' },
          tools: { type: 'array', items: { type: 'string' }, description: '可选，子代理工具白名单；缺省用默认子代理工具集' },
        },
        required: ['prompt'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('kb_search', '从本地知识库文件（.kb）检索与查询相关的知识切片，返回切片内容。关联了多个知识库时会在全部库中检索（可用 kb 参数按文件名过滤）。', kbSearch, {
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索查询' },
          kbPath: { type: 'string', description: '单个知识库 .kb 文件的绝对路径（与 kbPaths 二选一）' },
          kbPaths: { type: 'array', items: { type: 'string' }, description: '多个知识库 .kb 文件的绝对路径' },
          kb: { type: 'string', description: '可选，按知识库文件名过滤' },
          topK: { type: 'number', description: '每个库返回切片数（默认 5）' },
        },
        required: ['query'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('skill', '加载一个已安装技能的完整指令（只调用一次）。返回的技能指令就是你接下来要执行的步骤：加载成功后请立即按指令行动（写代码用 run_python 执行），不要再调用 skill 重复加载。', loadSkill, {
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名（kebab-case）' } },
        required: ['name'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('export_word', '把 Markdown 导出为 Word 文档（.docx，可在 Word 中继续编辑；公式转为 Word 原生公式、mermaid 转为图片、标题/表格/列表样式随导出模板）。内容二选一：markdown（直接给内容）或 path（.md 文件路径）。output_path 可给完整 .docx 路径或目录（目录则用 file_name 命名，缺省“导出文档.docx”；都为空时存到系统下载目录）。template 可选 gongwen(公文)/cn(中文论文)/en(英文论文 APA)/custom(自定义模板)，缺省跟随设置页。', exportWord, {
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Markdown 内容（与 path 二选一）' },
          path: { type: 'string', description: 'Markdown 文件路径（.md；与 markdown 二选一）' },
          output_path: { type: 'string', description: '可选，保存的 .docx 完整路径或目标目录（为空则存到系统下载目录）' },
          file_name: { type: 'string', description: '可选，文件名（不含扩展名；output_path 为目录或为空时使用）' },
          template: { type: 'string', description: '可选，导出模板：gongwen/cn/en/custom（缺省跟随设置页）' },
          overwrite: { type: 'boolean', description: '可选，是否覆盖同名文件（默认 false，重名自动追加 (1)）' },
        },
      },
    }),
  )
  toolRegistry.register(
    defineTool('ask_user', '向用户提问并等待回答。需要补充信息或澄清需求时使用；回答会作为工具结果返回。', askUser, {
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string', description: '要问用户的问题' } },
        required: ['question'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('update_plan', '创建或更新当前任务的执行计划。开始复杂多步任务前先用它规划步骤；执行中情况变化时更新计划。', updatePlan, {
      inputSchema: {
        type: 'object',
        properties: { plan: { type: 'string', description: '完整计划文本（传空字符串清除计划）' } },
        required: ['plan'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('update_todo', '维护结构化的待办清单（任务状态机）。开始任务前先规划所有步骤；每完成一步就把对应项置为 done，正在做的置为 running，无法完成的置为 cancelled；每次调用必须传入完整清单，完成后传空数组清除。', updateTodo, {
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整待办清单（按 title 去重合并，未传入的项将被移除）',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                detail: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'running', 'done', 'cancelled'] },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    }),
  )
    toolRegistry.register(
      defineTool('mcp_call', '通过 MCP 服务调用外部工具或控制装备。需要指定 tool 和 args；若 Agent 预设已配置 MCP 服务，可省略 serverId。', mcpCall, {
        inputSchema: {
          type: 'object',
          properties: {
            serverId: { type: 'string', description: 'MCP 服务 ID（可选，预设已配置时可省略）' },
            tool: { type: 'string', description: '要调用的 MCP 工具名' },
            args: { type: 'object', description: '工具参数（JSON 对象）' },
            config: { type: 'object', description: '可选，MCP 服务配置；缺省使用预设/上下文携带的配置' },
          },
          required: ['tool'],
        },
      }),
    )

  // PTC（Code Mode）：程序化工具调用。模型不逐个调用工具，而是写一段 TS 程序用 ctx SDK 组合多步操作。
  toolRegistry.register(
    defineTool('run_code', RUN_CODE_DESCRIPTION, runCodeHandler, {
      inputSchema: RUN_CODE_INPUT_SCHEMA,
    }),
  )

  toolRegistry.register(
    defineTool('web_search', '搜索互联网获取信息（返回标题/链接/摘要列表），搜索源可在设置页「工具 → 搜索」中配置。搜索后请挑选相关链接用 web_fetch 读取具体页面内容，仅凭摘要不足以完成任务。', webSearch, {
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('web_fetch', '获取网页完整内容（自动过滤 HTML 标签）。用于 web_search 之后深入阅读具体页面并提取信息。', webFetch, {
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的网页 URL' } },
        required: ['url'],
      },
    }),
  )
  console.log(`[tools] ${toolRegistry.snapshot().length} core tools registered`)
}
