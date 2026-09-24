/**
 * Markdown → Word (.docx) 导出工具
 * 接收已渲染的 HTML 内容，转换为真实 .docx（OOXML + ZIP）并下载，
 * Word 打开即可显示文字、标题、表格、代码块、内嵌图片（含 mermaid 转出的 PNG）
 * 与 Word 原生公式（OMML）。
 */
import { buildDocxBlob, readImageAsDataUrl, type DocxSkin, type DocxPageProfile } from '@/lib/export/docx'

/** 导出结果：name = 文件名；path = 实际落盘路径（浏览器模式或未拿到下载完成事件时为空） */
export interface WordSaveResult {
  name: string
  path: string
}

/** 保存目标：targetPath 为绝对路径时直接写到该处；只给文件名则落到系统下载目录 */
export interface WordSaveTarget {
  targetPath?: string
  /** true = 允许覆盖同名文件（路径来自原生「另存为」对话框时用） */
  overwrite?: boolean
}

/** Blob → base64（分块拼接，避免大文件一次性 fromCharCode 爆栈） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * 等 Electron 主进程的下载完成事件（拿真实保存路径）。
 * 主进程的 will-download 兜底会把页面发起的下载静默写盘（不弹框），完成后回发
 * `app-download-done`；拿不到（浏览器模式/超时/取消）就返回空串，不影响导出流程。
 */
function waitDownloadDone(timeoutMs = 3000): Promise<string> {
  const ipc: any = (typeof window !== 'undefined') ? (window as any).ipcRenderer : null
  if (!ipc || typeof ipc.on !== 'function' || typeof ipc.off !== 'function') return Promise.resolve('')
  return new Promise<string>((resolve) => {
    let done = false
    const finish = (p: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ipc.off('app-download-done', listener) } catch { /* 忽略 */ }
      resolve(p)
    }
    const listener = (_e: any, payload: any) => finish(String(payload?.path || ''))
    const timer = setTimeout(() => finish(''), timeoutMs)
    try {
      ipc.on('app-download-done', listener)
    } catch {
      finish('')
    }
  })
}

/**
 * 将已渲染的 HTML 转换为真实 .docx 并保存。
 * - 给了 target 且运行在 Electron 中：交主进程直写 targetPath（可指定 Markdown 所在目录），
 *   targetPath 只有文件名时落系统下载目录，重名自动追加 (1)；
 * - 否则回退为浏览器式下载（Electron 下由主进程 will-download 兜底静默落盘）。
 */
export async function downloadAsWord(renderedHtml: string, title: string = '文档', skin?: DocxSkin, page?: DocxPageProfile, target?: WordSaveTarget): Promise<WordSaveResult> {
  const blob = await buildDocxBlob(renderedHtml, skin, page)
  const safeName = title.replace(/[\\/:*?"<>|]/g, '_').trim() || '文档'
  const name = `${safeName}.docx`
  // Electron：主进程直写目标路径（浏览器式下载拿不到目录信息，只会落下载文件夹）
  const targetPath = (target?.targetPath || '').trim()
  const ipc: any = (typeof window !== 'undefined') ? (window as any).ipcRenderer : null
  if (targetPath && ipc && typeof ipc.invoke === 'function') {
    const res = await ipc.invoke('exportDocx', {
      base64: await blobToBase64(blob),
      targetPath,
      overwrite: !!target?.overwrite,
    })
    if (res && res.ok && res.path) {
      const saved = String(res.path)
      return { name: saved.split(/[\\/]/).pop() || name, path: saved }
    }
    throw new Error(res?.error || '保存失败')
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  // 下载完成事件里带真实保存路径（Electron 静默落盘，提示里告诉用户存到哪了）
  const savedPath = await waitDownloadDone()
  if (savedPath) console.info('[export-word] 已保存到', savedPath)
  return { name, path: savedPath }
}

/** 语义化别名：生成 .docx */
export const downloadAsDocx = downloadAsWord

/**
 * 将已渲染 HTML 中指向本地文件的 <img> 内联为 base64 data URL，
 * 使导出的 PDF / Word 图片不依赖本地绝对路径或 file:// 访问权限即可显示。
 * 兼容性：
 *  - data: / http(s): / // 远程资源直接跳过；
 *  - file:/// 前缀与 Windows 绝对路径（D:/...、C:\...）走 IPC readFileBase64 读取；
 *  - 相对路径（未以盘符/斜杠开头）可用 baseDir（需以 / 结尾）兜底拼接为绝对路径；
 *  - 非 Electron（浏览器模式）时原样返回。
 */
export async function inlineLocalImagesAsDataUrls(html: string, baseDir?: string): Promise<string> {
  if (!html || typeof window === 'undefined' || !(window as any).ipcRenderer) {
    return html
  }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }
  const imgs = Array.from(doc.querySelectorAll('img'))
  await Promise.all(imgs.map(async (img) => {
    const src = img.getAttribute('src') || ''
    if (!src || /^(data:|https?:|\/\/)/i.test(src)) return
    let filePath = src
    if (/^file:\/\//i.test(src)) {
      filePath = src.replace(/^file:\/\/\/?/i, '')
    } else if (baseDir && !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(filePath)) {
      // 相对路径兜底：基于 markdown 文件所在目录拼接为绝对路径
      filePath = baseDir + filePath.replace(/^\.\/+/, '')
    }
    // readImageAsDataUrl 会自动尝试解码百分号编码（中文文件名）与清理 ./ 段
    const dataUrl = await readImageAsDataUrl(filePath)
    if (dataUrl) {
      img.setAttribute('src', dataUrl)
    } else {
      console.warn('[export] 图片读取失败:', filePath)
    }
  }))
  return doc.body ? doc.body.innerHTML : html
}

/** 简单的 HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
