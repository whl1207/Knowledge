/**
 * panelWidths.ts — 文档视图「右侧面板」宽度（智能对话 / 智能操作）的统一默认值与存储。
 *
 * 各视图（浏览 md_read / 源码编辑 Edit_Code / 可视编辑 BlockEditor / PDF PdfViewer）右侧
 * 都挂着同一套对话面板，过去各自一份默认值（360 / 380 / 未记忆）导致「一打开宽窄不一」。
 * 现在共用一个 key：默认 360，任一处拖过之后其它视图打开也是同一宽度。
 *
 * 目录（左侧面板）宽度另见 lib/markdown/toc.ts 的 DOC_TOC_*（同样是共用一份）。
 */

export const DOC_CHAT_WIDTH_KEY = 'doc-chat-width'
/** 统一默认宽度（px） */
export const DOC_CHAT_DEFAULT_WIDTH = 360
export const DOC_CHAT_MIN_WIDTH = 260
export const DOC_CHAT_MAX_WIDTH = 640

/** 读取右侧面板宽度（带兜底与限幅） */
export function loadDocChatWidth(): number {
  try {
    const n = Number(localStorage.getItem(DOC_CHAT_WIDTH_KEY))
    if (Number.isFinite(n) && n > 0) {
      return Math.max(DOC_CHAT_MIN_WIDTH, Math.min(DOC_CHAT_MAX_WIDTH, Math.round(n)))
    }
  } catch { /* 隐私模式等场景忽略 */ }
  return DOC_CHAT_DEFAULT_WIDTH
}

/** 写入右侧面板宽度（拖动结束由宿主持久化） */
export function saveDocChatWidth(w: number): void {
  if (!Number.isFinite(w)) return
  try { localStorage.setItem(DOC_CHAT_WIDTH_KEY, String(Math.round(w))) } catch { /* 忽略 */ }
}
