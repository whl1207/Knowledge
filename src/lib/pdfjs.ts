/**
 * pdf.js 运行时配置（worker 路径 + CMap / 标准字体数据），所有 `getDocument` 调用点共用。
 *
 * 为什么必须带上 cMapUrl / standardFontDataUrl：
 * PDF 中的 Type0/CID 字体会引用**预定义 CMap**（如 UniGB-UCS2-H）或标准字体（Helvetica 等）；
 * 不提供这些数据时 pdf.js 只会打印一句 “Ensure that the `cMapUrl` and `cMapPacked` API
 * parameters are provided.”，随后**整段文字不绘制**——表现为 PDF 大量文字看不见，
 * 而 Acrobat / 浏览器自带阅读器（用系统字体）却能正常显示，极难判断。
 *
 * 资源位置：`public/` 下的 pdf.worker.min.mjs、cmaps/、standard_fonts/（取自 pdfjs-dist 包，
 * 升级 pdfjs-dist 时需一并替换）。用相对路径（'./xxx'）以同时兼容 dev server、
 * Electron 打包后的 file:// 与局域网网页端。
 */
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs'

/** 传给 pdfjsLib.getDocument 的运行时资源选项（与 getDocument 调用方合并使用） */
export const PDFJS_RUNTIME_OPTIONS = {
  cMapUrl: './cmaps/',
  cMapPacked: true,
  standardFontDataUrl: './standard_fonts/',
}
