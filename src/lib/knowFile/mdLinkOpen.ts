/**
 * mdLinkOpen.ts — Markdown 内本地文件链接的统一打开逻辑（浏览 / 导图 / 演示视图共用）
 *
 * 背景：`applyMdLinkRule`（@/lib/markdown/mdLinkPolicy）会给链接打上
 * `class="md-file-link" data-path="绝对路径"`。此前只有浏览视图（md_read）实现了点击处理，
 * 导图（markmap 自带 markdown-it）与演示视图里点链接会走浏览器默认行为——相对 href 被当成
 * 应用内地址，于是「跳转 md 文件」结果不对（跳走 / 跳错 / 丢失视图）。
 */
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import { rewriteMdLinkHref } from '@/lib/markdown/mdLinkPolicy'
import { aikmIpc } from '@/lib/aikmIpc'

/** 当前文档所在目录（含结尾 `/`），用于把相对链接解析成绝对路径 */
export function currentDocDir(): string {
  const store = usestore()
  const p = String(store.data[store.index]?.path || '').replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.substring(0, i + 1) : ''
}

/** markdown-it URL 编码过的路径（%20 等）还原成真实路径 */
function decodePath(p: string): string {
  try {
    return decodeURI(p)
  } catch {
    try { return decodeURIComponent(p) } catch { return p }
  }
}

/**
 * 解析链接指向的本地文件绝对路径。
 * 优先用 `data-path`（applyMdLinkRule 已算好）；没有时按当前文档目录解析 href。
 * 外链 / 页内锚点等非本地文件返回 `''`。
 */
export function resolveMdLinkTarget(a: HTMLAnchorElement, baseDir = ''): string {
  const dataPath = a.getAttribute('data-path')
  if (dataPath) return decodePath(dataPath)
  const href = (a.getAttribute('href') || '').trim()
  if (!href) return ''
  const rw = rewriteMdLinkHref(href, baseDir)
  return rw.kind === 'file' && rw.path ? decodePath(rw.path) : ''
}

/**
 * 打开本地文件：已打开则切到对应标签，否则按「文件操作模式」打开。
 * @param opts.page 目标页（1 起的序号 / 页名）：`.drawio` 图表会直接定位到该页，用于 Markdown 内嵌图表点击
 * @returns 是否按本地文件处理（false = 不是本地文件链接）
 */
export async function openMdFileLink(
  targetPath: string,
  opts: { isRemote?: boolean; page?: string | number } = {},
): Promise<boolean> {
  if (!targetPath) return false
  const store = usestore()
  // 打开前先确认目标存在（远程只读模式跳过校验）：否则会打开后只显示 `Error reading file: ENOENT`
  if (!opts.isRemote) {
    try {
      const info = await aikmIpc?.invoke?.('getInf', targetPath)
      if (!info) {
        ElMessage.warning(store.locales === 'zh' ? `目标文件不存在：${targetPath}` : `File not found: ${targetPath}`)
        return true
      }
    } catch (err) {
      // 校验失败时按原逻辑继续打开
      console.warn('[mdLinkOpen] 链接目标校验失败:', err)
    }
  }
  const existingIndex = store.data.findIndex((d: any) => d.path === targetPath)
  if (existingIndex >= 0) {
    store.index = existingIndex
    // 已在本窗口打开：图表窗口可能仍停在别的页，按同样方式通知换页（与主进程命中已开窗口的处理一致；
    // 单窗口环境（安卓 / 网页端）由 store.openFileWindow 更新应用内文件窗口的 page）
    if (opts.page != null && opts.page !== '') {
      store.openFileWindow({ path: targetPath, view: 'read', page: opts.page })
    }
    return true
  }
  await store.openFileByMode({
    path: targetPath,
    label: targetPath.replace(/\\/g, '/').split('/').pop() || 'file',
    type: 'file',
    extension: targetPath.substring(targetPath.lastIndexOf('.')),
    page: opts.page,
  })
  return true
}

/**
 * 容器级链接点击处理（导图 / 演示视图内容由 markmap / v-html 注入，只能在容器上监听）：
 *  - 页内锚点（`#xxx`）：阻止默认行为（否则相对应用 hash 路由跳转）
 *  - 本地文件链接：按当前文档目录解析后打开
 *  - 其它（http(s) 外链等）：不处理，交给全局逻辑
 */
export async function handleMdContainerClick(e: MouseEvent, baseDir = '', opts: { isRemote?: boolean } = {}): Promise<void> {
  const a = (e.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
  if (!a) return
  const href = (a.getAttribute('href') || '').trim()
  if (a.hasAttribute('data-anchor') || href.startsWith('#')) {
    e.preventDefault()
    return
  }
  const target = resolveMdLinkTarget(a, baseDir)
  if (!target) return
  e.preventDefault()
  e.stopPropagation()
  await openMdFileLink(target, opts)
}
