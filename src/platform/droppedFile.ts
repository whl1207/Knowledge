/**
 * droppedFile — 拖入窗口的文件（渲染层 `File` 对象）的磁盘路径与二进制文档判定
 *
 * 背景（真实事故）：Chromium 从 Electron 32 起移除了非标准的 `File.path`。
 * 本项目运行内核已升级到 Electron 42，拖入首页的文件只剩 `file.name`，
 * 而首页把「路径或文件名」直接交给主进程 `readFile` —— 得到的是相对路径，
 * 必然 ENOENT，于是 Word / Excel / Markdown 全部提示「读取失败」。
 *
 * 唯一正确的取法是在 preload 里调用 `webUtils.getPathForFile(file)`（见
 * electron/preload/index.ts 的 `api.getPathForFile`）：只有 preload 能碰到
 * 渲染层 File 对象背后的磁盘句柄。本模块是渲染层访问它的唯一入口。
 */
import { aikmIpcOrNull } from '@/lib/aikmIpc'

/**
 * 必须按二进制 / 宿主解析器处理的文档扩展名。
 *
 * 这些文件不能用 `File.text()` 读：那会把 zip（docx/xlsx/pptx）或 PDF 的字节
 * 按 UTF-8 解码成乱码，再当成正文发给模型。没有真实路径时应明确告知用户，
 * 而不是静默塞入垃圾内容。
 */
const BINARY_DOC_EXTENSIONS = new Set(['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx'])

/**
 * 取拖入文件的磁盘真实路径；取不到（网页 / 安卓 WebView / 虚拟文件来源）返回空串。
 *
 * 优先读 `file.path`：旧内核仍可能带着这个非标准属性，有就不必跨桥。
 * 否则经 preload 的 `webUtils.getPathForFile` 取回。
 */
export function droppedFilePath(file: File | null | undefined): string {
  if (!file) return ''
  const legacy = (file as File & { path?: unknown }).path
  if (typeof legacy === 'string' && legacy) return legacy
  const api = aikmIpcOrNull()
  try {
    const p = api?.getPathForFile?.(file)
    return typeof p === 'string' ? p : ''
  } catch {
    // 跨 realm 传参失败 / 非磁盘来源：按「没有路径」处理，由调用方走文本兜底或提示
    return ''
  }
}

/** 是否属于「只能由宿主解析」的二进制文档（见上方说明） */
export function isBinaryDocumentName(name: string): boolean {
  const ext = String(name || '').toLowerCase().split('.').pop() || ''
  return BINARY_DOC_EXTENSIONS.has(ext)
}
