/**
 * pdfEdit.ts — PDF「页面整理」（合并 / 删除 / 排序 / 旋转）的纯逻辑层。
 *
 * 界面只负责画缩略图与拼「页面清单」，真正的读写交给这里：
 * 用 pdf-lib 建一份新文档，按清单顺序把源文档的页复制进来（copyPages），
 * 因此**不动源文件**（除非调用方主动覆盖保存）；合并多个 PDF 就是往 sources 里多塞几份字节。
 *
 * pdf-lib 体积约 1MB，在这里**动态 import**：只有真正整理页面时才加载，不拖慢 PDF 打开。
 */

/** 清单里的一项：这一页取自哪个文档的第几页、额外旋转多少度 */
export interface PdfPageRef {
  /** 源文档下标（0 = 当前打开的 PDF，其余为合并进来的） */
  src: number
  /** 源文档内的页序号（0 起） */
  index: number
  /** 用户额外施加的旋转角度（顺时针，0 / 90 / 180 / 270） */
  rotation: number
}

export interface PdfSourceInfo {
  /** 页数 */
  pageCount: number
  /** 是否加密 / 需要密码（加密文档按「忽略加密」打开，内容可能读不出来） */
  encrypted: boolean
}

/** data:application/pdf;base64,xxx → Uint8Array（也接受不带前缀的纯 base64） */
export function base64ToBytes(base64: string): Uint8Array {
  const pure = base64.includes('base64,') ? base64.slice(base64.indexOf('base64,') + 7) : base64
  const bin = atob(pure)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Uint8Array → 纯 base64（不带 data: 前缀）；分块拼接，避免大文件爆栈 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** 读 PDF 基本信息（页数 / 是否加密） */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfSourceInfo> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  return { pageCount: doc.getPageCount(), encrypted: doc.isEncrypted }
}

/** 把角度归一化到 0 / 90 / 180 / 270（负数也接受） */
export function normalizeAngle(deg: number): number {
  return ((Math.round(deg) % 360) + 360) % 360
}

/**
 * 按清单重组 PDF：sources[0] 为当前文档，其余为合并进来的 PDF。
 * 每个源文档只调用一次 copyPages（整份复制），再按清单顺序 addPage，
 * 避免逐页调用导致字体 / 资源被反复解析。
 */
export async function composePdf(sources: Uint8Array[], pages: PdfPageRef[]): Promise<Uint8Array> {
  if (!pages.length) throw new Error('至少需要保留一页')
  const { PDFDocument, degrees } = await import('pdf-lib')

  const out = await PDFDocument.create()
  const copied: any[][] = []
  for (const bytes of sources) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    copied.push(await out.copyPages(doc, doc.getPageIndices()))
  }

  for (const ref of pages) {
    const page = copied[ref.src]?.[ref.index]
    if (!page) continue
    const added = out.addPage(page)
    const extra = normalizeAngle(ref.rotation)
    if (extra) added.setRotation(degrees(normalizeAngle(added.getRotation().angle + extra)))
  }

  return out.save()
}
