/**
 * docx 编辑引擎（M1.1 · L1 run-aware 文本替换 + 增量保存）
 *
 *  - loadDocxPackage：读 .docx → 保留全部部件（styles/theme/header/footer/media…）的内存包
 *  - applyFindReplace：L1 文本替换 —— 优先「单 w:t 内原地替换」（完全保格式）；
 *    跨 run 时做 run 级替换（只改命中字符，未命中的 run 及其 rPr 原样保留，
 *    替换文本沿用命中起点 run 的格式）；只有 replace 含换行 / 制表符或命中落在
 *    w:br/w:tab 上时才退回「整段归一」（保留 pPr 与段首 run 格式）
 *  - saveDocxPackage：仅更新 word/document.xml 后增量重打包，写回前自动 .bak，原子 rename
 *
 * 与 docx-zip / docx-reader 配合；纯 Node、零第三方依赖。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { unzipEntries, packZip, type ZipEntryData } from './docx-zip'
import { asUint8 } from '../buffer-view'

// ==================== XML 小工具 ====================

function tagEnd(s: string, from: number): number {
  let quote = ''
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === quote) quote = ''; continue }
    if (c === '\'' || c === '"') quote = c
    else if (c === '>') return i
  }
  return -1
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ==================== 内存包 ====================

export interface DocxPackage {
  path: string
  name: string
  entries: ZipEntryData[]
  documentXml: string
  modified: boolean
}

export function loadDocxPackage(filePath: string): DocxPackage {
  const buf = fs.readFileSync(filePath)
  const entries = unzipEntries(buf)
  const doc = entries.find(e => e.name === 'word/document.xml')
  const documentXml = doc ? doc.data.toString('utf8') : ''
  return {
    path: filePath,
    name: path.basename(filePath),
    entries,
    documentXml,
    modified: false,
  }
}

// ==================== L1 文本替换 ====================

export interface FindReplaceOptions {
  /** 'all'（默认）替换所有出现；'first' 只替换第一处 */
  scope?: 'all' | 'first'
  ignoreCase?: boolean
}

export interface FindReplaceResult {
  replaced: number
  paragraphs: number
}

/** 把整段 XML 文本化；同时记录每个 w:t 在 text 中的坐标（start/end）与原始片段区间（absStart/absEnd） */
function tokenizeParagraph(rest: string): { text: string; spans: { absStart: number; absEnd: number; head: string; content: string; start: number; end: number }[] } {
  const spans: { absStart: number; absEnd: number; head: string; content: string; start: number; end: number }[] = []
  let text = ''
  let i = 0
  const n = rest.length
  while (i < n) {
    const lt = rest.indexOf('<', i)
    if (lt < 0) break
    const gt = tagEnd(rest, lt + 1)
    if (gt < 0) break
    const raw = rest.slice(lt + 1, gt)
    if (raw.startsWith('/') || raw.endsWith('/')) { i = gt + 1; continue }
    const nm = raw.split(/[\s/>]/)[0]
    if (nm === 'w:t') {
      const closeAt = rest.indexOf('</w:t>', gt + 1)
      if (closeAt >= 0) {
        const content = decodeXml(rest.slice(gt + 1, closeAt))
        const st = text.length
        spans.push({
          absStart: lt,
          absEnd: closeAt + '</w:t>'.length,
          head: rest.slice(lt, gt + 1),
          content,
          start: st,
          end: st + content.length,
        })
        text += content
        i = closeAt + 6
        continue
      }
    } else if (nm === 'w:br') { text += '\n'; i = gt + 1; continue }
    else if (nm === 'w:tab') { text += '\t'; i = gt + 1; continue }
    i = gt + 1
  }
  return { text, spans }
}

function findPositions(text: string, find: string, ci: boolean, maxN: number): number[] {
  const ps: number[] = []
  if (!find) return ps
  const t = ci ? text.toLowerCase() : text
  const f = ci ? find.toLowerCase() : find
  let from = 0
  while (ps.length < maxN) {
    const idx = t.indexOf(f, from)
    if (idx < 0) break
    ps.push(idx)
    from = idx + f.length
  }
  return ps
}

/** 首个 <w:rPr>…</w:rPr>（保留段内主要格式）；无则空 */
function firstRpr(rest: string): string {
  const m = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(rest)
  return m ? m[0] : ''
}

/** 把纯文本重建为 runs（按 \n → w:br、\t → w:tab 切分） */
function plainToRuns(text: string, rPr: string): string {
  let runs = ''
  let buf = ''
  const flush = () => {
    if (buf) { runs += `<w:r>${rPr}<w:t xml:space="preserve">${encodeXml(buf)}</w:t></w:r>`; buf = '' }
  }
  for (const ch of text) {
    if (ch === '\n') { flush(); runs += `<w:r>${rPr}<w:br/></w:r>` }
    else if (ch === '\t') { flush(); runs += `<w:r>${rPr}<w:tab/></w:r>` }
    else buf += ch
  }
  flush()
  return runs
}

/**
 * 跨 run 的保格式替换：只改「匹配覆盖到的字符」，未命中的文本仍留在各自原来的 run 里
 * （因此它们各自的 rPr —— 加粗 / 斜体 / 字号 / 颜色 —— 原样保留）。
 * 替换文本插到「匹配起点所在的 run」，沿用该 run 的格式。
 *
 * 与旧的「整段归一」区别：旧实现把整段拼成纯文本再用段首格式重建所有 run，
 * 段内局部格式（例如"5. [参考文献]"加粗、正文不加粗）会全部归一；这里只在
 * 一个 w:t 内改内容，其它 run 的 XML 一律不动。
 *
 * 返回新的段内 XML；无法安全处理（匹配起点落在 w:br/w:tab 等非 w:t 字符上）时返回 null，
 * 由调用方退回旧的整段归一实现。
 */
function replaceAcrossRuns(
  rest: string,
  spans: { absStart: number; absEnd: number; head: string; content: string; start: number; end: number }[],
  positions: number[],
  find: string,
  replace: string,
): string | null {
  /**
   * 每个 span 上的局部编辑：
   *  - removals：要删掉的局部字符区间 [from, to)；
   *  - inserts：在某个局部位置插入的替换文本（只发生在匹配起点所在的 span）。
   */
  const edits = spans.map(() => ({ removals: [] as Array<{ from: number; to: number }>, inserts: new Map<number, string>() }))
  for (const p of positions) {
    const end = p + find.length
    // 起点必须落在某个 w:t 的文本范围内（end 恰好等于 last span 的 end 也可以）
    let startSpan = -1
    for (let i = 0; i < spans.length; i++) {
      if (p >= spans[i].start && p < spans[i].end) { startSpan = i; break }
    }
    if (startSpan < 0) return null
    let endSpan = -1
    for (let i = startSpan; i < spans.length; i++) {
      if (end > spans[i].start && end <= spans[i].end) { endSpan = i; break }
    }
    if (endSpan < 0) return null
    // 匹配跨越了「非 w:t 的字符」（br/tab 不在 spans 的文本坐标里，会表现为区间跳空）
    const covered = spans.slice(startSpan, endSpan + 1)
      .reduce((sum, sp) => sum + Math.max(0, Math.min(end, sp.end) - Math.max(p, sp.start)), 0)
    if (covered !== find.length) return null
    // 记录删除区间（按 span 局部坐标）
    for (let i = startSpan; i <= endSpan; i++) {
      const sp = spans[i]
      const from = Math.max(p, sp.start) - sp.start
      const to = Math.min(end, sp.end) - sp.start
      if (to > from) edits[i].removals.push({ from, to })
    }
    // 替换文本插到匹配起点所在的 span（同一 run 的格式）
    const local = p - spans[startSpan].start
    const prev = edits[startSpan].inserts.get(local)
    edits[startSpan].inserts.set(local, (prev ?? '') + replace)
  }

  // 重建受影响的 span：按字符位置走一遍，删除命中字符、在起点插入替换文本
  let outRest = rest
  for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i]
    const edit = edits[i]
    if (!edit.removals.length && !edit.inserts.size) continue
    const removed = new Uint8Array(sp.content.length)
    for (const r of edit.removals) {
      for (let k = Math.max(0, r.from); k < Math.min(sp.content.length, r.to); k++) removed[k] = 1
    }
    let content = ''
    const chars = Array.from(sp.content)
    for (let k = 0; k < chars.length; k++) {
      const ins = edit.inserts.get(k)
      if (ins) content += ins
      if (!removed[k]) content += chars[k]
    }
    // 插入点可能正好在文本末尾（匹配到 span 末尾）
    const tailIns = edit.inserts.get(chars.length)
    if (tailIns) content += tailIns
    const newRaw = `${sp.head}${encodeXml(content)}</w:t>`
    outRest = outRest.slice(0, sp.absStart) + newRaw + outRest.slice(sp.absEnd)
  }
  return outRest
}

function replaceSegment(pXml: string, find: string, replace: string, ci: boolean, maxN: number): { xml: string; n: number } | null {
  const close = pXml.lastIndexOf('</w:p>')
  const openEnd = pXml.indexOf('>') + 1
  const openTag = pXml.slice(0, openEnd)
  const inner = pXml.slice(openEnd, close < 0 ? pXml.length : close)

  // 抽出 pPr（归一重建时原样保留）
  let pPr = ''
  let rest = inner
  const ppStart = inner.search(/<w:pPr\b/)
  if (ppStart >= 0) {
    const ppClose = inner.indexOf('</w:pPr>', ppStart)
    if (ppClose >= 0) {
      const end = ppClose + '</w:pPr>'.length
      pPr = inner.slice(ppStart, end)
      rest = inner.slice(0, ppStart) + inner.slice(end)
    }
  }

  const { text, spans } = tokenizeParagraph(rest)
  const hay = ci ? text.toLowerCase() : text
  const needle = ci ? find.toLowerCase() : find
  if (!hay.includes(needle)) return null
  const positions = findPositions(text, find, ci, maxN)
  if (!positions.length) return null

  const canInPlace = !/[\n\t]/.test(replace) &&
    positions.every(p => spans.some(sp => sp.start <= p && p + find.length <= sp.end))

  if (canInPlace) {
    // 每个匹配归属某 span（以 absStart 分组，local 相对 span.start）
    const bySpan = new Map<number, number[]>()
    for (const p of positions) {
      const sp = spans.find(s => s.start <= p && p + find.length <= s.end)
      if (!sp) continue
      const locals = bySpan.get(sp.absStart) || []
      locals.push(p - sp.start)
      bySpan.set(sp.absStart, locals)
    }
    // 重写 rest：按 absStart 降序，逐个 span 重建（content 内按 local 降序 splice）
    let outRest = rest
    const entries = Array.from(bySpan.entries()).sort((a, b) => b[0] - a[0])
    for (const [absStart, locals] of entries) {
      const sp = spans.find(s => s.absStart === absStart)
      if (!sp) continue
      let content = sp.content
      const sortedLocals = locals.slice().sort((a, b) => b - a)
      for (const l of sortedLocals) {
        content = content.slice(0, l) + replace + content.slice(l + find.length)
      }
      const newRaw = sp.head + encodeXml(content) + '</w:t>'
      outRest = outRest.slice(0, absStart) + newRaw + outRest.slice(sp.absEnd)
    }
    return { xml: openTag + pPr + outRest + '</w:p>', n: positions.length }
  }

  // 跨 run（含命中跨多个 w:t）：优先只改命中字符，未命中的 run 与其 rPr 原样保留
  if (!/[\n\t]/.test(replace)) {
    const cross = replaceAcrossRuns(rest, spans, positions, find, replace)
    if (cross) return { xml: openTag + pPr + cross + '</w:p>', n: positions.length }
  }

  // 兜底（replace 含换行 / tab，或匹配落在 w:br/w:tab 上）：整段归一，
  // 保留 pPr 与段首 run 格式；这是旧行为，只在无法做 run 级替换时使用。
  let newText = text
  const desc = positions.slice().sort((a, b) => b - a)
  for (const p of desc) {
    newText = newText.slice(0, p) + replace + newText.slice(p + find.length)
  }
  const rPr = firstRpr(rest)
  return { xml: openTag + pPr + plainToRuns(newText, rPr) + '</w:p>', n: positions.length }
}

/**
 * 在内存包上执行 L1 文本替换（逐段处理；'first' 命中即停）。修改 pkg.documentXml。
 */
export function applyFindReplace(pkg: DocxPackage, find: string, replace: string, opts: FindReplaceOptions = {}): FindReplaceResult {
  const res: FindReplaceResult = { replaced: 0, paragraphs: 0 }
  if (!find) return res
  const ci = !!opts.ignoreCase
  const all = (opts.scope || 'all') !== 'first'
  const maxN = all ? Number.MAX_SAFE_INTEGER : 1

  const re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(pkg.documentXml)) !== null) {
    out += pkg.documentXml.slice(last, m.index)
    const seg = replaceSegment(m[0], find, replace, ci, maxN)
    if (seg && seg.n > 0) {
      res.paragraphs++
      res.replaced += seg.n
      out += seg.xml
      if (!all) {
        out += pkg.documentXml.slice(m.index + m[0].length)
        pkg.documentXml = out
        pkg.modified = true
        return res
      }
    } else {
      out += m[0]
    }
    last = m.index + m[0].length
  }
  out += pkg.documentXml.slice(last)
  pkg.documentXml = out
  if (res.replaced > 0) pkg.modified = true
  return res
}

/**
 * 在文档 XML 的指定区间内做文本替换（表格单元格 / 单个块 / 选区用）。
 *
 * 与 `applyFindReplace` 完全同一套 run 级替换逻辑，只是把扫描范围限制在 [start, end)：
 *  - 区间由调用方按块 / 表格单元格定位（见 office-service 的 blockIndex / row / col）；
 *  - 只影响区间内的段落，区间外的同名文字不会被误替换；
 *  - 无匹配时原文档不变。
 */
export function applyFindReplaceInRange(
  pkg: DocxPackage,
  start: number,
  end: number,
  find: string,
  replace: string,
  opts: FindReplaceOptions = {},
): FindReplaceResult {
  const from = Math.max(0, Math.min(pkg.documentXml.length, Math.floor(start)))
  const to = Math.max(from, Math.min(pkg.documentXml.length, Math.floor(end)))
  if (to <= from) return { replaced: 0, paragraphs: 0 }
  const segment = pkg.documentXml.slice(from, to)
  // 浅拷贝：applyFindReplace 只改 documentXml / modified，entries 等部件原样共用
  const tmp: DocxPackage = { ...pkg, documentXml: segment, modified: false }
  const res = applyFindReplace(tmp, find, replace, opts)
  if (res.replaced > 0) {
    pkg.documentXml = pkg.documentXml.slice(0, from) + tmp.documentXml + pkg.documentXml.slice(to)
    pkg.modified = true
  }
  return res
}

// ==================== 导出 / 保存 ====================

/** 读内存包中某部件的文本（不存在返回 null） */
export function readPackageEntryText(pkg: DocxPackage, name: string): string | null {
  const e = pkg.entries.find(x => x.name === name)
  return e ? e.data.toString('utf8') : null
}

/** 写内存包中某部件的文本（不存在则新增条目）并置 modified —— styles.xml 等部件改动用它回写 */
export function writePackageEntryText(pkg: DocxPackage, name: string, text: string): void {
  const i = pkg.entries.findIndex(x => x.name === name)
  const entry = { name, data: Buffer.from(text, 'utf8') }
  if (i >= 0) pkg.entries[i] = entry
  else pkg.entries.push(entry)
  pkg.modified = true
}

/**
 * 内存包 → .docx Buffer（不落盘、不改动 pkg）。
 * 用于外部工具在“已改但还没 save”时拿到当前内容的完整包（如 Office MCP 的 export_markdown）。
 */
export function buildDocxBuffer(pkg: DocxPackage): Buffer {
  const entries = pkg.entries.map((e) =>
    e.name === 'word/document.xml' ? { name: e.name, data: Buffer.from(pkg.documentXml, 'utf8') } : e
  )
  return packZip(entries)
}

export interface SaveOptions {
  /** 写回前把当前原文件复制为 <path>.bak（默认 true） */
  backup?: boolean
}

/** 增量重打包并写回：先 .bak，再 tmp + 原子 rename */
export function saveDocxPackage(pkg: DocxPackage, opts: SaveOptions = {}): { ok: boolean; path: string; backup?: string; error?: string } {
  try {
    // 保持 pkg.entries 与 documentXml 同步（再次保存 / buildDocxBuffer 都以 entries 为准）
    const i = pkg.entries.findIndex(e => e.name === 'word/document.xml')
    if (i >= 0) pkg.entries[i] = { name: 'word/document.xml', data: Buffer.from(pkg.documentXml, 'utf8') }
    const packed = buildDocxBuffer(pkg)
    const backupPath = pkg.path + '.bak'
    if (opts.backup !== false) {
      try { fs.copyFileSync(pkg.path, backupPath) } catch { /* 忽略备份失败 */ }
    }
    const tmp = pkg.path + '.__office_tmp'
    fs.writeFileSync(tmp, asUint8(packed))
    fs.renameSync(tmp, pkg.path)
    pkg.modified = false
    return { ok: true, path: pkg.path, backup: backupPath }
  } catch (e: any) {
    return { ok: false, path: pkg.path, error: e?.message || String(e) }
  }
}
