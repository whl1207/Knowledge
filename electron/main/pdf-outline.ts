/**
 * pdf-outline.ts — 给「Markdown → PDF」导出的 PDF 补一份书签（/Outlines 目录）。
 *
 * 导出链路是 Chromium 的 printToPDF，产物天生不带书签，所以本软件自己的 PdfViewer
 * （目录来自 PDF 的 Outline 书签）打开时看不到目录。这里：
 *   1. 用 pdfjs 逐页提取文字，按标题文本在文档中**单调向后**定位每个标题所在页；
 *   2. 用 pdf-lib 手写 /Outlines 树（按标题层级嵌套、Dest 用 /Fit 跳页）。
 *
 * 任何一步失败都返回 null（调用方照常写回原始 PDF），导出本身不会因为目录失败而失败。
 */
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDict, PDFRef } from 'pdf-lib'

export interface PdfOutlineHeading {
  /** 标题文字（已去掉 Markdown 标记） */
  title: string
  /** 标题级别：1~6（h1~h6） */
  level: number
}

interface OutlineNode {
  title: string
  /** 0 起的页码下标 */
  pageIndex: number
  children: OutlineNode[]
}

/** 归一化文字：NFKC（全半角统一）+ 去掉空白 / 软连字符 / 零宽字符 + 小写 */
const normalize = (s: string): string => String(s || '')
  .normalize('NFKC')
  .replace(/[\s\u00a0\u3000\u200b-\u200d\ufeff]+/g, '')
  .replace(/\u00ad/g, '')
  .toLowerCase()

/** 标题 → 页码（1 起）：按文档顺序单调向后搜索；找不到时沿用上一个标题的页码 */
async function locateHeadingPages(bytes: Uint8Array, headings: PdfOutlineHeading[]): Promise<number[]> {
  const loadingTask = PDFJS.getDocument({ data: bytes.slice(0), useSystemFonts: true, isEvalSupported: false })
  const doc = await loadingTask.promise
  try {
    const pageTexts: string[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      pageTexts.push(normalize((content.items as any[]).map((it: any) => String(it?.str ?? '')).join('')))
    }

    const pages: number[] = []
    let startIdx = 0
    for (const h of headings) {
      const target = normalize(h.title)
      let found = -1
      if (target) {
        for (let i = startIdx; i < pageTexts.length; i++) {
          if (pageTexts[i].includes(target)) { found = i; break }
        }
        // 标题可能被打印在上一个标题同页的末尾：向后找不到时回退一页再看一次
        if (found < 0 && startIdx > 0 && pageTexts[startIdx - 1]?.includes(target)) found = startIdx - 1
      }
      // 仍找不到（公式 / 图片标题 / 文字被拆散）：落到上一个标题所在页，保证目录顺序与页序单调
      if (found < 0) found = pages.length ? Math.min(startIdx, pages[pages.length - 1] - 1) : 0
      pages.push(found + 1)
      if (found >= 0) startIdx = found
    }
    return pages
  } finally {
    await doc.destroy()
  }
}

/** 扁平标题（带层级）→ 目录树 */
function buildOutlineTree(headings: PdfOutlineHeading[], pages: number[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: { node: OutlineNode; level: number }[] = []
  headings.forEach((h, i) => {
    const level = Math.max(1, Math.min(6, Number(h.level) || 1))
    const node: OutlineNode = {
      title: String(h.title || '').trim(),
      pageIndex: Math.max(0, (pages[i] || 1) - 1),
      children: [],
    }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    if (!stack.length) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ node, level })
  })
  return roots
}

/**
 * 给 PDF 字节流补书签；成功返回新字节，失败（或无标题）返回 null。
 * @param bytes Chromium printToPDF 产出的 PDF
 * @param headings Markdown 标题（文档顺序，level 1~6）
 */
export async function addPdfOutline(bytes: Uint8Array, headings: PdfOutlineHeading[]): Promise<Uint8Array | null> {
  const list = (headings || []).filter((h) => h && String(h.title || '').trim())
  if (!list.length) return null
  try {
    const pages = await locateHeadingPages(bytes, list)
    const tree = buildOutlineTree(list, pages)
    if (!tree.length) return null

    // 动态加载：只有「带标题的 PDF 导出」才会用到 pdf-lib（省主进程启动时间）
    const { PDFDocument, PDFName, PDFNumber, PDFHexString, PDFArray } = await import('pdf-lib')
    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    const pageRefs = pdfDoc.getPages().map((p) => p.ref)
    if (!pageRefs.length) return null
    const ctx = pdfDoc.context

    const makeDest = (pageIndex: number) => {
      const arr = PDFArray.withContext(ctx)
      arr.push(pageRefs[Math.min(pageRefs.length - 1, Math.max(0, pageIndex))])
      arr.push(PDFName.of('Fit'))
      return arr
    }

    /** 递归写一段同级条目，返回 First / Last / Count（Count 含所有后代） */
    const emit = (nodes: OutlineNode[], parentRef: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
      const refs = nodes.map(() => ctx.nextRef())
      const dicts = nodes.map((n, i) => {
        const dict = ctx.obj({}) as unknown as PDFDict
        // 标题走 UTF-16BE 十六进制串：PDFString 只按单字节编码，中文会乱码
        dict.set(PDFName.of('Title'), PDFHexString.fromText(n.title))
        dict.set(PDFName.of('Parent'), parentRef)
        dict.set(PDFName.of('Dest'), makeDest(n.pageIndex))
        if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1])
        if (i < nodes.length - 1) dict.set(PDFName.of('Next'), refs[i + 1])
        ctx.assign(refs[i], dict)
        return dict
      })
      let count = nodes.length
      nodes.forEach((n, i) => {
        if (!n.children.length) return
        const sub = emit(n.children, refs[i])
        dicts[i].set(PDFName.of('First'), sub.first)
        dicts[i].set(PDFName.of('Last'), sub.last)
        dicts[i].set(PDFName.of('Count'), PDFNumber.of(sub.count))
        count += sub.count
      })
      return { first: refs[0], last: refs[refs.length - 1], count }
    }

    const rootRef = ctx.nextRef()
    const rootDict = ctx.obj({}) as unknown as PDFDict
    rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'))
    const built = emit(tree, rootRef)
    rootDict.set(PDFName.of('First'), built.first)
    rootDict.set(PDFName.of('Last'), built.last)
    rootDict.set(PDFName.of('Count'), PDFNumber.of(built.count))
    ctx.assign(rootRef, rootDict)
    pdfDoc.catalog.set(PDFName.of('Outlines'), rootRef)

    return await pdfDoc.save()
  } catch (err) {
    console.warn('[pdf-outline] 生成 PDF 目录失败（PDF 照常导出）:', err)
    return null
  }
}
