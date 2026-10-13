/**
 * platform/android/saf — SAF（系统文件夹授权）插件封装 + 文件适配器
 *
 * 原生侧见 android/app/src/main/java/com/whl/aikm/SafFolderPlugin.java：
 * 用户用系统界面挑一个文件夹（ACTION_OPEN_DOCUMENT_TREE），拿到**可持久化**授权，
 * 之后按「相对该文件夹的路径」读写——这样安卓上也能访问用户自己的资料，
 * 而不是只能待在应用沙箱里。
 *
 * 路径约定（与原生侧、与文件树 UI 一致）：
 *   `saf:`                        → 已授权文件夹的根
 *   `saf:<根目录名>`               → 同上（根目录名只是给界面看的，等价于根）
 *   `saf:<根目录名>/sub/a.md`      → 根内的子路径（根目录名这一段会被忽略）
 *
 * 为什么带根目录名：应用把路径当作工作区标识并按末段展示名称（如文件树/工作区列表），
 * 纯 `saf:` 在界面上无法辨认；因此渲染层用 `saf:<名字>` 作根路径，适配器在路由时
 * 识别并剥掉这段「根标记」。名字与授权不符时（用户换了文件夹）按普通子目录处理 —— 会解析失败并返回空，不会越界。
 */

import { registerPlugin } from '@capacitor/core'
import type { AndroidFilesystemAdapter } from '@/platform/android'

/** 渲染层使用的 SAF 路径前缀 */
export const SAF_PREFIX = 'saf:'

/** 原生插件的最小接口（与 SafFolderPlugin.java 的方法一一对应） */
export interface SafFolderPluginApi {
  getRoot(): Promise<{ granted: boolean; name: string; uri: string }>
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
 * 把 SAF 路径拆成「是否 SAF + 相对授权根的子路径」。
 * `saf:` / `saf:<根名>` 都解析为根（`''`）。
 */
export function splitSafPath(path: string, rootName = ''): { saf: boolean; rel: string } {
  const raw = String(path || '')
  if (!raw.startsWith(SAF_PREFIX)) return { saf: false, rel: raw }
  let rest = raw.slice(SAF_PREFIX.length).replace(/^\/+/, '')
  if (!rest) return { saf: true, rel: '' }
  const name = String(rootName || '')
  if (name && rest === name) return { saf: true, rel: '' }
  if (name && rest.startsWith(name + '/')) rest = rest.slice(name.length + 1)
  return { saf: true, rel: rest }
}

/** 组装 SAF 路径（根 → `saf:<根名>`；子路径 → `saf:<根名>/rel`） */
export function joinSafPath(rootName: string, rel: string): string {
  const name = String(rootName || '').trim()
  const r = String(rel || '').replace(/^\/+/, '')
  if (!r) return name ? `${SAF_PREFIX}${name}` : SAF_PREFIX
  return name ? `${SAF_PREFIX}${name}/${r}` : `${SAF_PREFIX}${r}`
}

/** 缓存的授权根名（适配器与界面共享；refreshRoot 更新） */
export const safCache: { rootName: string } = { rootName: '' }

/**
 * 用 SafFolder 插件实现文件适配器（与 Capacitor Filesystem 的适配面相同，
 * 因此上层 fsPortOf 逻辑完全不动，只是换了数据源）。
 *
 * `rootName()` 每次调用现取授权文件夹名，因此用户在系统界面换了文件夹后立即生效。
 */
export function createSafFilesystemAdapter(
  plugin: SafFolderPluginApi = SafFolder,
  rootName: () => string = () => safCache.rootName,
): SafFilesystemAdapter {
  const split = (path: string) => splitSafPath(path, rootName())

  return {
    async refreshRoot() {
      try {
        const r = await plugin.getRoot()
        safCache.rootName = r?.name || ''
        return { granted: !!r?.granted, name: safCache.rootName }
      } catch {
        safCache.rootName = ''
        return { granted: false, name: '' }
      }
    },

    async readFile({ path, encoding }) {
      const { rel } = split(path)
      const mode = modeOf(encoding)
      const r = await plugin.readFile({ path: rel, mode })
      // 文本口径由原生侧解码（UTF-8）；二进制口径返回 base64，由端口按需解码
      return { data: String(r?.data ?? '') }
    },

    async writeFile({ path, data, encoding }) {
      const { rel } = split(path)
      await plugin.writeFile({ path: rel, data: String(data ?? ''), encoding: modeOf(encoding) === 'text' ? 'utf8' : 'base64' })
      return { uri: path }
    },

    async mkdir({ path }) {
      const { rel } = split(path)
      await plugin.mkdir({ path: rel })
      return {}
    },

    async rmdir({ path }) {
      const { rel } = split(path)
      await plugin.remove({ path: rel })
      return {}
    },

    async deleteFile({ path }) {
      const { rel } = split(path)
      await plugin.remove({ path: rel })
      return {}
    },

    async rename({ from, to }) {
      const src = split(from).rel
      const dst = split(to).rel
      await plugin.rename({ from: src, to: dst })
      return { uri: to }
    },

    async copy({ from, to }) {
      const src = split(from).rel
      const dst = split(to).rel
      await plugin.copy({ from: src, to: dst })
      return { uri: to }
    },

    async stat({ path }) {
      const { rel } = split(path)
      const r = await plugin.stat({ path: rel })
      if (!r?.exists) throw new Error('路径不存在')
      return { type: r.type || 'file', size: r.size, mtime: r.mtime }
    },

    async readdir({ path }) {
      const { rel } = split(path)
      const r = await plugin.readdir({ path: rel })
      return { files: Array.isArray(r?.files) ? r.files : [] }
    },
  }
}
