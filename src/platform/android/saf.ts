/**
 * platform/android/saf — SAF（系统文件夹授权）插件封装 + 文件适配器
 *
 * 原生侧见 android/app/src/main/java/com/whl/aikm/SafFolderPlugin.java：
 * 用户用系统界面挑一个文件夹（ACTION_OPEN_DOCUMENT_TREE），拿到**可持久化**授权，
 * 之后按「相对该文件夹的路径」读写——这样安卓上也能访问用户自己的资料，
 * 而不是只能待在应用沙箱里。
 *
 * 路径约定（与原生侧、与文件树 UI 一致）：
 *   `saf:`                        → 最近一次授权的那个文件夹的根
 *   `saf:<根目录名>`               → 同名授权文件夹的根
 *   `saf:<根目录名>/sub/a.md`      → 那个授权文件夹里的子路径
 *
 * 为什么带根目录名：应用把路径当作工作区标识并按末段展示名称（如文件树/工作区列表），
 * 纯 `saf:` 在界面上无法辨认；因此渲染层用 `saf:<名字>` 作根路径，**原生按第一段选授权根**
 * （多授权根：工作区、插件目录、插件自己读的游戏目录各拿各的，互不顶掉）。
 * 名字不是已知授权根时按普通子目录处理（相对「最近一次授权的根」）——会解析失败并返回空，不会越界。
 */

import { registerPlugin } from '@capacitor/core'
import type { AndroidFilesystemAdapter } from '@/platform/android'

/** 渲染层使用的 SAF 路径前缀 */
export const SAF_PREFIX = 'saf:'

/** 原生插件的最小接口（与 SafFolderPlugin.java 的方法一一对应） */
export interface SafFolderPluginApi {
  /** 授权状态：name = 最近一次授权的根名；names = 全部已授权根名（多授权根） */
  getRoot(): Promise<{ granted: boolean; name: string; uri: string; names?: string[] }>
  pickFolder(): Promise<{ name: string; uri: string }>
  clear(): Promise<void>
  readFile(opts: { path: string; mode?: 'text' | 'base64' }): Promise<{ data: string; size?: number }>
  writeFile(opts: { path: string; data: string; encoding?: 'utf8' | 'base64' }): Promise<{ path: string; size?: number }>
  readdir(opts: { path: string }): Promise<{ files: Array<{ name: string; type?: string; size?: number; mtime?: number }> }>
  stat(opts: { path: string }): Promise<{ exists: boolean; type?: string; size?: number; mtime?: number; name?: string }>
  mkdir(opts: { path: string }): Promise<{ path: string }>
  remove(opts: { path: string }): Promise<unknown>
  rename(opts: { from: string; to: string }): Promise<{ path: string }>
  copy(opts: { from: string; to: string }): Promise<{ path: string }>
  /** 取已授权目录内某文件的可共享 uri（content://…/document/…，分享 / 用其它应用打开用） */
  getUri(opts: { path: string }): Promise<{ uri: string; name?: string; type?: string }>
}

/** SAF 文件适配器（比应用沙箱适配器多一个「授权状态刷新」） */
export interface SafFilesystemAdapter extends AndroidFilesystemAdapter {
  refreshRoot(): Promise<{ granted: boolean; name: string }>
}

/** 原生插件实例（未安装时调用会 reject，由上层按能力降级） */
export const SafFolder = registerPlugin<SafFolderPluginApi>('SafFolder')

/**
 * 读写的文本 / 二进制口径（与 Capacitor Filesystem 一致）：
 * 传 `encoding`（如 `utf8`）按文本处理；不传则按 base64 二进制。
 */
function modeOf(encoding?: string): 'text' | 'base64' {
  return encoding ? 'text' : 'base64'
}

/** 是否 SAF 路径 */
export function isSafPath(path: string): boolean {
  return String(path || '').startsWith(SAF_PREFIX)
}

/**
 * 把 SAF 路径拆成「是否 SAF + 交给原生的相对路径」。
 *
 * ⚠️ 这里**不再剥掉根名那一段**：安卓上应用会同时持有多个文件夹授权（工作区、插件目录、
 * 插件自己要读的游戏 / 数据目录……），原生按 `saf:<根名>/sub` 的**第一段**路由到对应授权
 * （见 SafFolderPlugin.pick）。早期只有一个授权根，渲染层会把根名剥掉再传，于是
 * 「在别处又选了一个文件夹」就会把前一个授权的路径解析带偏——插件目录因此整片读空。
 * 老形状（不含根名，或就是 `saf:`）按「最近一次授权的根」处理，原生两种都认。
 */
export function splitSafPath(path: string): { saf: boolean; rel: string } {
  const raw = String(path || '')
  if (!raw.startsWith(SAF_PREFIX)) return { saf: false, rel: raw }
  return { saf: true, rel: raw.slice(SAF_PREFIX.length).replace(/^\/+/, '') }
}

/** 组装 SAF 路径（根 → `saf:<根名>`；子路径 → `saf:<根名>/rel`） */
export function joinSafPath(rootName: string, rel: string): string {
  const name = String(rootName || '').trim()
  const r = String(rel || '').replace(/^\/+/, '')
  if (!r) return name ? `${SAF_PREFIX}${name}` : SAF_PREFIX
  return name ? `${SAF_PREFIX}${name}/${r}` : `${SAF_PREFIX}${r}`
}

/**
 * 缓存的授权根（适配器与界面共享；refreshRoot 更新）：
 * rootName = 最近一次授权的根（匿名 `saf:` 与界面展示都用它），rootNames = 全部已授权根名。
 */
export const safCache: { rootName: string; rootNames: string[] } = { rootName: '', rootNames: [] }

/**
 * 用 SafFolder 插件实现文件适配器（与 Capacitor Filesystem 的适配面相同，
 * 因此上层 fsPortOf 逻辑完全不动，只是换了数据源）。
 *
 * 路径原样交给原生：`saf:<根名>/…` 由原生按名字选授权根，因此用户在任何一处重新选文件夹，
 * 都不会再把别处的 `saf:<旧根名>/…` 解析带偏。授权状态由 refreshRoot() 现取现更新。
 */
export function createSafFilesystemAdapter(plugin: SafFolderPluginApi = SafFolder): SafFilesystemAdapter {
  const relOf = (path: string) => splitSafPath(path).rel

  return {
    async refreshRoot() {
      try {
        const r = await plugin.getRoot()
        safCache.rootName = r?.name || ''
        const names = Array.isArray(r?.names) ? r.names.filter((n) => !!n) : []
        safCache.rootNames = names.length ? names : safCache.rootName ? [safCache.rootName] : []
        return { granted: !!r?.granted, name: safCache.rootName }
      } catch {
        safCache.rootName = ''
        safCache.rootNames = []
        return { granted: false, name: '' }
      }
    },

    async readFile({ path, encoding }) {
      const mode = modeOf(encoding)
      const r = await plugin.readFile({ path: relOf(path), mode })
      // 文本口径由原生侧解码（UTF-8）；二进制口径返回 base64，由端口按需解码
      return { data: String(r?.data ?? '') }
    },

    async writeFile({ path, data, encoding }) {
      await plugin.writeFile({ path: relOf(path), data: String(data ?? ''), encoding: modeOf(encoding) === 'text' ? 'utf8' : 'base64' })
      return { uri: path }
    },

    async mkdir({ path }) {
      await plugin.mkdir({ path: relOf(path) })
      return {}
    },

    async rmdir({ path }) {
      await plugin.remove({ path: relOf(path) })
      return {}
    },

    async deleteFile({ path }) {
      await plugin.remove({ path: relOf(path) })
      return {}
    },

    async rename({ from, to }) {
      await plugin.rename({ from: relOf(from), to: relOf(to) })
      return { uri: to }
    },

    async copy({ from, to }) {
      await plugin.copy({ from: relOf(from), to: relOf(to) })
      return { uri: to }
    },

    async stat({ path }) {
      const r = await plugin.stat({ path: relOf(path) })
      if (!r?.exists) throw new Error('路径不存在')
      return { type: r.type || 'file', size: r.size, mtime: r.mtime }
    },

    async readdir({ path }) {
      const r = await plugin.readdir({ path: relOf(path) })
      return { files: Array.isArray(r?.files) ? r.files : [] }
    },
  }
}
