/**
 * remotePreview.ts — 远程工作区文件的只读预览数据
 *
 * 文件树（panel.vue）与「文件」视图里的远程目录列表共用这一份读取逻辑，
 * 避免两处各写一遍扩展名判定，出现「树里能预览、文件视图里却提示下载」的不一致。
 */
import type { RemoteRoot } from '@/types/collab'
import { fetchFsRead, remotePathOf } from '@/platform/remoteFs'
import { getPlatform } from '@/platform'

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']

export interface RemotePreviewTab {
  path: string
  label: string
  type: 'file'
  extension: string
  isRemote: true
  quickPreview: boolean
  remoteRootId: string
  remoteRel: string
  /** 主机允许直接编辑 Markdown 时为 true（仅 .md 类文件） */
  remoteEditable: boolean
  content?: string
  remoteBase64?: string
  remoteText?: string
}

export type RemotePreviewResult =
  | { ok: true; tab: RemotePreviewTab }
  /** 无法内联预览（音视频 / 压缩包等）：调用方引导用户下载到本地 */
  | { ok: false; reason: 'download'; error?: string }
  | { ok: false; reason: 'error'; error: string }

function extOf(rel: string): string {
  const name = String(rel || '').replace(/\\/g, '/').split('/').pop() || ''
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.substring(i).toLowerCase() : ''
}

function baseTab(root: RemoteRoot, rel: string, label: string, quickPreview: boolean): RemotePreviewTab {
  const name = label || String(rel || '').replace(/\\/g, '/').split('/').pop() || 'file'
  const ext = extOf(name)
  return {
    path: remotePathOf(root, rel),
    label: name,
    type: 'file',
    extension: ext,
    isRemote: true,
    quickPreview,
    remoteRootId: root.id,
    remoteRel: rel,
    remoteEditable: root.permission === 'md' && ['.md', '.markdown', '.mdown', '.mkd'].includes(ext),
  }
}

/**
 * 读取远程文件并组装成可直接放进标签栏的记录。
 * @param quickPreview 单击快速预览（不显示远程只读条）/ 正式打开（false）
 */
export async function buildRemotePreviewTab(
  root: RemoteRoot,
  rel: string,
  label: string,
  quickPreview = false,
): Promise<RemotePreviewResult> {
  const ext = extOf(label || rel)
  const tab = baseTab(root, rel, label, quickPreview)

  // 明确无法内联预览的二进制类型：直接提示下载，避免拉取完整 base64
  const NO_PREVIEW_EXTS = [
    '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg',
    '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst',
    '.exe', '.msi', '.dll', '.apk', '.dmg', '.deb', '.rpm', '.iso', '.bin', '.run', '.flatpak', '.snap',
  ]
  if (NO_PREVIEW_EXTS.includes(ext)) return { ok: false, reason: 'download' }

  try {
    if (IMAGE_EXTS.includes(ext) || ext === '.pdf') {
      const content = await fetchFsRead(root, rel)
      if (!content?.base64 && !content?.text) return { ok: false, reason: 'download' }
      tab.remoteBase64 = content.base64 || ''
      tab.remoteText = content.text || ''
      return { ok: true, tab }
    }
    if (ext === '.docx' || ext === '.doc') {
      const content = await fetchFsRead(root, rel)
      if (!content?.base64) return { ok: false, reason: 'download' }
      const md: any = await getPlatform().host.docs.docxToMarkdown({ base64: content.base64 })
      if (typeof md !== 'string' || !md) return { ok: false, reason: 'download' }
      tab.content = md
      tab.remoteText = md
      return { ok: true, tab }
    }
    const content = await fetchFsRead(root, rel)
    if (typeof content?.text !== 'string') return { ok: false, reason: 'download' }
    tab.content = content.text
    return { ok: true, tab }
  } catch (e: any) {
    return { ok: false, reason: 'error', error: e?.message || '读取远程文件失败' }
  }
}
