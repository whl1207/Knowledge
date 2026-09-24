/**
 * remoteFs.ts — 远程文件共享客户端工具
 *
 * 对应主进程 remote-fs-service（HTTP 只读）：
 *   GET /fs/info?token=…
 *   GET /fs/list?path=相对路径&token=…  → { tree: RemoteFsNode[] }
 *   GET /fs/read?path=相对路径&token=…  → { text? | base64?, size }
 *   GET /fs/download?path=相对路径&token=… → 二进制流
 */
import type { RemoteRoot, RemoteFsNode } from '@/types/collab'

/** 构造远程文件唯一路径标识（用于 tab 的 path 字段） */
export function remotePathOf(root: RemoteRoot, rel: string): string {
  const r = normalizeRemoteRoot(root)
  return `remote://${r.host}:${r.port}/${rel}`.replace(/\/+/g, '/')
}

/**
 * 归一化远程工作区配置：若 host 已含端口（如 "192.168.1.8:3347"），
 * 自动拆分为 host 与 port，避免拼接出 http://ip:port:port。
 */
export function normalizeRemoteRoot(root: RemoteRoot): RemoteRoot {
  const hostRaw = String(root?.host || '').trim()
  // 匹配 ip:port 或 [v6]:port
  const m = hostRaw.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/)
  if (m) {
    return { ...root, host: m[1], port: Number(m[2]) }
  }
  return root
}

function baseUrl(root: RemoteRoot): string {
  const r = normalizeRemoteRoot(root)
  return `http://${r.host}:${r.port}`
}

function withToken(url: string, token: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

async function getJson(root: RemoteRoot, route: string, rel: string): Promise<any> {
  const url = withToken(`${baseUrl(root)}${route}?path=${encodeURIComponent(rel)}`, root.token)
  const res = await fetch(url)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json()
}

/** 校验共享是否可用，并获取共享名 */
export async function fetchFsInfo(root: RemoteRoot): Promise<{ name: string; rootPath: string; port: number }> {
  const url = withToken(`${baseUrl(root)}/fs/info`, root.token)
  const res = await fetch(url)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.json()
}

/** 列出共享内相对路径的子节点（懒加载用） */
export async function fetchFsList(root: RemoteRoot, rel: string): Promise<RemoteFsNode[]> {
  const data = await getJson(root, '/fs/list', rel)
  return Array.isArray(data?.tree) ? data.tree : []
}

/** 读取文件内容：文本返回 { text }，二进制返回 { base64 } */
export async function fetchFsRead(
  root: RemoteRoot,
  rel: string,
): Promise<{ text?: string; base64?: string; size: number }> {
  return getJson(root, '/fs/read', rel)
}

/**
 * 下载远程文件到本地并返回本地路径。
 * 底层通过渲染进程 fetch 流式下载，再交给主进程保存（saveRemoteDownload）。
 */
export async function downloadRemoteFile(root: RemoteRoot, rel: string, targetDir: string): Promise<string> {
  const url = withToken(`${baseUrl(root)}/fs/download?path=${encodeURIComponent(rel)}`, root.token)
  const res = await fetch(url)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  const buf = await res.arrayBuffer()
  const data = new Uint8Array(buf)
  // 文件名取相对路径最后一段
  const name = rel.replace(/\\/g, '/').split('/').pop() || 'file'
  const result = await window.ipcRenderer.invoke('saveRemoteDownload', {
    dir: targetDir,
    name,
    data: Array.from(data),
  })
  if (!result?.success) {
    throw new Error(result?.error || '保存失败')
  }
  return result.path
}
