/**
 * docx-images.ts — .docx 图片读取 / 插入 / 替换（纯 Node，不依赖 electron）
 *
 * 为什么不走第 3 方库：docx 就是一个 zip，图片是 `word/media/*` + `word/_rels/document.xml.rels`
 * 里的关系 + 正文里的 `<w:drawing>`。自己改部件可以：只动必要的 4 个部件（document.xml /
 * document.xml.rels / [Content_Types].xml / media），其它样式、页眉页脚、表格、图片全部原样保留。
 *
 * 能力边界：
 *  - `listDocxImages`：按正文顺序列出图片（关系 id / 媒体路径 / 尺寸 / inline 或 anchor）。
 *  - `addDocxImage`：把图片写进包并生成一段 `<w:p><w:r><w:drawing>…`（由调用方决定插到哪）。
 *  - `replaceDocxImage`：按图片序号替换媒体字节；默认保留原显示尺寸（布局不变），
 *    也可以给 widthCm / heightCm 重设尺寸；格式变了会自动改关系与 Content_Types。
 *
 * 只处理正文里的图片（页眉页脚里的图片不在此列，替换/插入也不会动它们）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DocxPackage } from './docx-editor'
import type { ZipEntryData } from './docx-zip'

const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
const RELS_PART = 'word/_rels/document.xml.rels'
const CONTENT_TYPES_PART = '[Content_Types].xml'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  svg: 'image/svg+xml',
}

export interface DocxImageInfo {
  /** 1-based，按正文出现顺序 */
  index: number
  /** 图片关系 id（a:blip r:embed） */
  relId: string
  /** zip 内的媒体路径（word/media/xxx） */
  mediaPath: string
  /** 扩展名（不含点） */
  format: string
  bytes: number
  /** 显示尺寸（EMU；1 cm = 360000 EMU） */
  widthEmu?: number
  heightEmu?: number
  /** inline = 嵌入型；anchor = 浮动 */
  location: 'inline' | 'anchor' | 'unknown'
  docPrId?: number
  name?: string
}

export interface AddImageResult {
  paragraphXml: string
  relId: string
  mediaPath: string
  widthEmu: number
  heightEmu: number
  format: string
  docPrId: number
}

function entryOf(pkg: DocxPackage, name: string): ZipEntryData | undefined {
  return pkg.entries.find((e) => e.name === name)
}

function entryText(pkg: DocxPackage, name: string): string | null {
  const e = entryOf(pkg, name)
  return e ? e.data.toString('utf8') : null
}

function setEntry(pkg: DocxPackage, name: string, data: Buffer): void {
  const i = pkg.entries.findIndex((e) => e.name === name)
  const entry = { name, data }
  if (i >= 0) pkg.entries[i] = entry
  else pkg.entries.push(entry)
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`).exec(tag)
  return m ? m[1] : undefined
}

/** 关系 Target → zip 内路径（相对 word/document.xml 所在目录） */
function resolveRelTarget(target: string): string {
  const t = String(target || '').replace(/\\/g, '/')
  if (!t) return ''
  if (t.startsWith('/')) return t.slice(1)
  return path.posix.normalize(`word/${t}`)
}

interface RelRow { id: string; target: string; type: string }

function parseRels(pkg: DocxPackage): RelRow[] {
  const xml = entryText(pkg, RELS_PART) || ''
  const out: RelRow[] = []
  const re = /<Relationship\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    const type = attr(m[0], 'Type') || ''
    if (id && target) out.push({ id, target, type })
  }
  return out
}

function writeRels(pkg: DocxPackage, rows: RelRow[]): void {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  const body = rows
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
    .join('')
  const existing = entryText(pkg, RELS_PART)
  if (existing && !existing.includes('<Relationships')) {
    // 极少数异常包：保留原内容不动，直接失败由调用方处理
    throw new Error('document.xml.rels 结构异常')
  }
  setEntry(pkg, RELS_PART, Buffer.from(`${head}${body}</Relationships>`, 'utf8'))
}

function nextRelId(rows: RelRow[]): string {
  let max = 0
  for (const r of rows) {
    const m = /^rId(\d+)$/.exec(r.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  const used = new Set(rows.map((r) => r.id))
  let n = max + 1
  while (used.has(`rId${n}`)) n++
  return `rId${n}`
}

function nextMediaName(pkg: DocxPackage, ext: string): string {
  const used = new Set(pkg.entries.map((e) => e.name))
  let max = 0
  for (const name of used) {
    const m = /^word\/media\/image(\d+)\.[a-z0-9]+$/i.exec(name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  let n = max + 1
  while (used.has(`word/media/image${n}.${ext}`)) n++
  return `image${n}.${ext}`
}

function ensureContentType(pkg: DocxPackage, ext: string): void {
  const ct = entryText(pkg, CONTENT_TYPES_PART)
  if (!ct) return
  const lower = ext.toLowerCase()
  const contentType = CONTENT_TYPES[lower]
  if (!contentType) return
  const re = new RegExp(`<Default\\b[^>]*Extension="${lower}"`, 'i')
  if (re.test(ct)) return
  const next = ct.replace(/<\/Types>\s*$/, `<Default Extension="${lower}" ContentType="${contentType}"/></Types>`)
  setEntry(pkg, CONTENT_TYPES_PART, Buffer.from(next, 'utf8'))
}

/** 从 PNG / JPEG / GIF / BMP / WebP 文件头读像素尺寸（读不到返回 null，由调用方要求额外给尺寸） */
export function readImagePixelSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      i += 2
      if (marker === 0xd8 || marker === 0xd9) continue
      if (i + 2 > buf.length) break
      const len = buf.readUInt16BE(i)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 7 <= buf.length) return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) }
        break
      }
      i += len
    }
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X' && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { width: w, height: h }
    }
    if (kind === 'VP8 ' && buf.length >= 30) {
      const w = buf.readUInt16LE(26) & 0x3fff
      const h = buf.readUInt16LE(28) & 0x3fff
      if (w && h) return { width: w, height: h }
    }
  }
  return null
}

const EMU_PER_CM = 360_000
const EMU_PER_PX_96 = 9_525 // 914400 / 96

function sizeFromOptions(
  pixel: { width: number; height: number } | null,
  opts: { widthCm?: number; heightCm?: number; maxWidthCm?: number },
): { widthEmu: number; heightEmu: number } | { error: string } {
  const maxWidthCm = Math.max(1, Number(opts.maxWidthCm) || 15.9)
  let widthCm = Number(opts.widthCm)
  let heightCm = Number(opts.heightCm)
  if (!(widthCm > 0) || !(heightCm > 0)) {
    if (!pixel) return { error: '无法从图片文件头读取像素尺寸：请给 widthCm 与 heightCm（或其中一项 + 已知宽高比）' }
    if (widthCm > 0 && !(heightCm > 0)) heightCm = (pixel.height / pixel.width) * widthCm
    else if (heightCm > 0 && !(widthCm > 0)) widthCm = (pixel.width / pixel.height) * heightCm
    else {
      widthCm = (pixel.width * 2.54) / 96
      heightCm = (pixel.height * 2.54) / 96
    }
  }
  if (widthCm > maxWidthCm) {
    heightCm = (heightCm / widthCm) * maxWidthCm
    widthCm = maxWidthCm
  }
  return {
    widthEmu: Math.max(1, Math.round(widthCm * EMU_PER_CM)),
    heightEmu: Math.max(1, Math.round(heightCm * EMU_PER_CM)),
  }
}

/**
 * 新的 wp:docPr id：Word 要求**整个包**里的 drawing 对象 id 唯一（正文 + 页眉页脚都算）。
 * 只扫 document.xml 会与页眉页脚里的图形撞 id —— 实测 Word 会报「文件可能已经损坏」。
 */
function nextDocPrId(pkg: DocxPackage): number {
  let max = 0
  const re = /<wp:docPr\b[^>]*\bid="(\d+)"/g
  for (const entry of pkg.entries) {
    if (!/\.xml$/i.test(entry.name)) continue
    const text = entry.data.toString('utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) max = Math.max(max, Number(m[1]))
    re.lastIndex = 0
  }
  return max + 1 || 1
}

function normalizeExt(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
  return ext === 'jpeg' ? 'jpg' : ext
}

function buildImageParagraph(opts: {
  relId: string
  widthEmu: number
  heightEmu: number
  docPrId: number
  name: string
  imageId: number
}): string {
  const { relId, widthEmu, heightEmu, docPrId, name, imageId } = opts
  const safeName = String(name || `Picture ${docPrId}`).replace(/[<>&"]/g, '')
  return `<w:p><w:r><w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="${docPrId}" name="${safeName}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${imageId}" name="${safeName}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

/**
 * 把图片写进包（media + rels + Content_Types），返回可插入正文的段落 XML。
 * 注意：本函数会先改包；调用方应先校验插入位置，避免留下未使用的媒体与关系。
 */
export function addDocxImage(
  pkg: DocxPackage,
  imagePath: string,
  opts: { widthCm?: number; heightCm?: number; maxWidthCm?: number; name?: string } = {},
): AddImageResult | { error: string } {
  const abs = path.resolve(String(imagePath || ''))
  if (!fs.existsSync(abs)) return { error: `图片不存在：${abs}` }
  const ext = normalizeExt(abs)
  if (!CONTENT_TYPES[ext]) return { error: `不支持的图片格式：.${ext}（支持 ${Object.keys(CONTENT_TYPES).join(' / ')}）` }
  let buf: Buffer
  try {
    buf = fs.readFileSync(abs)
  } catch (e: any) {
    return { error: `读取图片失败：${e?.message || e}` }
  }
  const pixel = readImagePixelSize(buf)
  const size = sizeFromOptions(pixel, opts)
  if ('error' in size) return size
  const rows = parseRels(pkg)
  const relId = nextRelId(rows)
  const mediaName = nextMediaName(pkg, ext)
  const mediaPath = `word/media/${mediaName}`
  setEntry(pkg, mediaPath, buf)
  rows.push({ id: relId, target: `media/${mediaName}`, type: REL_IMAGE })
  writeRels(pkg, rows)
  ensureContentType(pkg, ext)
  const docPrId = nextDocPrId(pkg)
  const paragraphXml = buildImageParagraph({
    relId,
    widthEmu: size.widthEmu,
    heightEmu: size.heightEmu,
    docPrId,
    name: opts.name || path.basename(abs),
    imageId: docPrId,
  })
  pkg.modified = true
  return {
    paragraphXml,
    relId,
    mediaPath,
    widthEmu: size.widthEmu,
    heightEmu: size.heightEmu,
    format: ext,
    docPrId,
  }
}

/** 按正文顺序列出图片 */
export function listDocxImages(pkg: DocxPackage): DocxImageInfo[] {
  const rows = parseRels(pkg)
  const relById = new Map(rows.map((r) => [r.id, r]))
  const out: DocxImageInfo[] = []
  const re = /<wp:(inline|anchor)\b[\s\S]*?<\/wp:\1>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pkg.documentXml)) !== null) {
    const block = m[0]
    const location = m[1] === 'anchor' ? 'anchor' : 'inline'
    const extentTag = /<wp:extent\b[^>]*>/.exec(block)?.[0]
    const widthEmu = extentTag ? Number(attr(extentTag, 'cx')) || undefined : undefined
    const heightEmu = extentTag ? Number(attr(extentTag, 'cy')) || undefined : undefined
    const docPrTag = /<wp:docPr\b[^>]*>/.exec(block)?.[0]
    const docPrId = docPrTag ? Number(attr(docPrTag, 'id')) || undefined : undefined
    const name = docPrTag ? attr(docPrTag, 'name') : undefined
    const blipRe = /<a:blip\b[^>]*\br:embed="([^"]+)"[^>]*>/g
    let b: RegExpExecArray | null
    while ((b = blipRe.exec(block)) !== null) {
      const relId = b[1]
      const rel = relById.get(relId)
      if (!rel) continue
      const mediaPath = resolveRelTarget(rel.target)
      const entry = entryOf(pkg, mediaPath)
      if (!entry) continue
      out.push({
        index: out.length + 1,
        relId,
        mediaPath,
        format: path.posix.extname(mediaPath).replace(/^\./, '').toLowerCase(),
        bytes: entry.data.length,
        widthEmu,
        heightEmu,
        location,
        docPrId,
        name,
      })
    }
  }
  return out
}

export interface ReplaceImageResult {
  index: number
  mediaPath: string
  format: string
  bytes: number
  widthEmu?: number
  heightEmu?: number
  keptSize: boolean
}

/** 替换第 index 张图片的媒体字节；默认保留原显示尺寸。 */
export function replaceDocxImage(
  pkg: DocxPackage,
  index: number,
  imagePath: string,
  opts: { keepSize?: boolean; widthCm?: number; heightCm?: number } = {},
): ReplaceImageResult | { error: string } {
  const images = listDocxImages(pkg)
  const target = images[Number(index) - 1]
  if (!target) return { error: `图片序号 ${index} 不存在（当前共 ${images.length} 张；可用 list_images 查看）` }
  const abs = path.resolve(String(imagePath || ''))
  if (!fs.existsSync(abs)) return { error: `图片不存在：${abs}` }
  const ext = normalizeExt(abs)
  if (!CONTENT_TYPES[ext]) return { error: `不支持的图片格式：.${ext}` }
  const buf = fs.readFileSync(abs)
  const pixel = readImagePixelSize(buf)
  const rows = parseRels(pkg)
  const rel = rows.find((r) => r.id === target.relId)
  if (!rel) return { error: `图片关系 ${target.relId} 不存在` }
  const oldPath = resolveRelTarget(rel.target)
  const sameExt = ext === target.format
  if (sameExt) {
    setEntry(pkg, oldPath, buf)
  } else {
    const oldEntry = entryOf(pkg, oldPath)
    if (!oldEntry) return { error: `原图片文件缺失：${oldPath}` }
    const mediaName = nextMediaName(pkg, ext)
    const mediaPath = `word/media/${mediaName}`
    setEntry(pkg, mediaPath, buf)
    rel.target = `media/${mediaName}`
    writeRels(pkg, rows)
    ensureContentType(pkg, ext)
    // 不删除旧媒体：同一个 media 可能还被页眉页脚或其它关系引用（删了会让那些引用损坏）。
    // 留下的孤儿媒体不影响 Word 打开，只是包略大。
    void oldEntry
  }
  // 尺寸：默认保留原 extent；显式给尺寸或 keepSize=false 时按新图片重算
  let widthEmu = target.widthEmu
  let heightEmu = target.heightEmu
  const keepSize = opts.keepSize !== false && !(Number(opts.widthCm) > 0) && !(Number(opts.heightCm) > 0)
  if (!keepSize) {
    const size = sizeFromOptions(pixel, { widthCm: opts.widthCm, heightCm: opts.heightCm })
    if ('error' in size) return size
    widthEmu = size.widthEmu
    heightEmu = size.heightEmu
    // 在包含该图片的 drawing 块里替换 extent（只改显示尺寸，不动布局容器）
    const blockRe = /<wp:(inline|anchor)\b[\s\S]*?<\/wp:\1>/g
    let bm: RegExpExecArray | null
    let replaced = false
    while ((bm = blockRe.exec(pkg.documentXml)) !== null) {
      if (!bm[0].includes(`r:embed="${target.relId}"`)) continue
      const nextBlock = bm[0]
        .replace(/<wp:extent\b[^>]*\/>/, `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>`)
        .replace(/<a:ext\b[^>]*\/>/, `<a:ext cx="${widthEmu}" cy="${heightEmu}"/>`)
      pkg.documentXml = pkg.documentXml.slice(0, bm.index) + nextBlock + pkg.documentXml.slice(bm.index + bm[0].length)
      replaced = true
      break
    }
    if (!replaced) {
      console.warn('[docx-images] 未找到图片的 drawing 块，尺寸保持不变')
    }
  }
  pkg.modified = true
  return {
    index: Number(index),
    mediaPath: sameExt ? oldPath : resolveRelTarget(rel.target),
    format: ext,
    bytes: buf.length,
    widthEmu,
    heightEmu,
    keptSize: keepSize,
  }
}
