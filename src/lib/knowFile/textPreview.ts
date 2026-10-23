/**
 * textPreview.ts — 哪些文件**不需要**按文本读进渲染层（图片 / 音视频 / PDF / PPTX）
 *
 * 为什么单独成文件：这个判断必须和打开路径、标签内容缓存保持一致，否则很容易出现
 * 一处跳过了、另一处又把几十 MB 的视频/PDF 经桥搬进内存（安卓上直接卡死/OOM）。
 *
 * 这些类型各自的读者：
 *  - 图片：view_image 自己按路径取 data URL / 本地服务器 URL；
 *  - 音视频：MediaVideo / MediaAudio 自己取流或读二进制；视频还要经 `fs.urlOf` 换成
 *    WebView 能加载的地址（`saf:` 原始路径 WebView 不认识）；
 *  - PDF：PdfViewer 自己读字节；
 *  - PPTX：内嵌 Office 编辑器自己打开（不走文本预览）。
 *
 * 不在此列的 `.docx` / `.xlsx` / `.xls` 仍需文本（Office 管线转 Markdown），
 * `.html` / `.md` / 代码 / 画布等本来就是文本。
 */

/** 无需按文本读的扩展名（小写，含点） */
export const NO_TEXT_PREVIEW_EXTS = [
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif',
  // 音视频
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.mpg', '.mpeg',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff',
  // 自带字节读取器的文档
  '.pdf', '.pptx',
]

/** 取路径的小写扩展名（含点；无扩展名返回 ''） */
export function extensionOfPath(path: string): string {
  const m = String(path || '').toLowerCase().match(/\.[^./\\]+$/)
  return m ? m[0] : ''
}

/** 该路径是否应按“非文本”处理（不要 readText 进标签内容） */
export function shouldSkipTextPreview(path: string): boolean {
  const ext = extensionOfPath(path)
  return !!ext && NO_TEXT_PREVIEW_EXTS.includes(ext)
}
