/**
 * remoteStore.ts — 把「共享目录」当作插件商店 / 技能商店来源时的地址解析（渲染层共用）
 *
 * 背景：局域网共享已有只读 HTTP 服务（`/fs/store` 商店清单、`/fs/bundle` 目录打包，
 * 都需要 token）。用户从「协作 → 共享」那一栏复制的链接是给人看的
 * `remote-fs://<ip>:<port>?token=…`，商店输入框应当直接接受它 —— 也可能直接粘
 * `http://<ip>:<port>/fs/store?token=…`。这里统一收敛成「商店索引地址」。
 *
 * 为什么不做 FTP：渲染层（Chromium）无法访问 ftp://，任何 FTP 都要在主进程加依赖 + IPC 桥，
 * 而共享服务本身已经是只读 + token + 路径白名单的 HTTP，商店直接用即可。
 */

/** 商店索引地址（token 以查询参数形式带上；`url` 可直接 GET 到清单 JSON） */
export interface RemoteStoreSource {
  /** 可 GET 到商店清单 JSON 的地址 */
  url: string
  /** 解析出的 token（没有则为空串） */
  token: string
}

/**
 * 规范化用户粘贴的共享地址。
 *
 * 支持（其余原样返回，交给上层按普通 JSON 源处理）：
 *   remote-fs://ip:port?token=xxx        → http://ip:port/fs/store?token=xxx
 *   http://ip:port/fs[...]?token=xxx     → 补成 /fs/store
 *   http://host/path/store?token=xxx     → 原样
 */
export function normalizeRemoteStoreUrl(raw: string): RemoteStoreSource | null {
  const text = String(raw || '').trim()
  if (!text) return null

  // remote-fs:// → http://（用户从「协作 → 共享」复制的就是这种链接）
  const remoteMatch = /^remote-fs:\/\/([^/?#]+)(\/[^?#]*)?(?:\?(.*))?$/i.exec(text)
  if (remoteMatch) {
    const host = remoteMatch[1]
    const query = remoteMatch[3] || ''
    const token = new URLSearchParams(query).get('token') || ''
    const url = `http://${host}/fs/store${token ? `?token=${encodeURIComponent(token)}` : ''}`
    return { url, token }
  }

  let url = text
  if (!/^https?:\/\//i.test(url)) return null

  // 共享服务的基地址 / 子接口 → 统一补到 /fs/store
  const hashIdx = url.indexOf('#')
  if (hashIdx >= 0) url = url.slice(0, hashIdx)
  const [base, query = ''] = url.split('?')
  const trimmed = base.replace(/\/+$/, '')
  const token = new URLSearchParams(query).get('token') || ''
  let normalized = trimmed
  if (/\/fs$/i.test(trimmed) || /\/fs\/(info|list|read|download)$/i.test(trimmed)) {
    normalized = `${trimmed.replace(/\/fs\/[^/]*$/i, '/fs')}/store`
  }
  const withToken = token ? `${normalized}?token=${encodeURIComponent(token)}` : query ? `${normalized}?${query}` : normalized
  return { url: withToken, token }
}

/** 由商店清单的下载地址推断「同源共享服务基地址」（`/fs/bundle` 需要另外拼 path） */
export function siblingBundleUrl(indexUrl: string, path: string): string {
  try {
    const u = new URL(indexUrl)
    const token = u.searchParams.get('token') || ''
    u.pathname = u.pathname.replace(/\/store$/i, '/bundle')
    u.search = `?path=${encodeURIComponent(path)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
    return u.toString()
  } catch {
    return ''
  }
}

/** 商店清单里的插件条目（与共享服务 /fs/store 的输出、以及普通 JSON 源兼容） */
export interface RemoteStorePlugin {
  id: string
  name: string
  version: string
  apiVersion: string
  description: string
  permissions: string[]
  path: string
  downloadUrl: string
}

/** 解析商店清单 JSON：兼容 `[...]`、`{plugins:[...]}`、`{skills:[...]}` 三种形状 */
export function parseStoreIndex(data: any, fallbackBundleUrl?: (path: string) => string): {
  plugins: RemoteStorePlugin[]
  skills: Array<{ name: string; description: string; path: string; downloadUrl: string }>
} {
  const arr: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.plugins)
      ? data.plugins
      : Array.isArray(data?.data) && data.data.every((x: any) => x && (x.id || x.aikm))
        ? data.data
        : []
  const skills: any[] = Array.isArray(data) ? [] : (Array.isArray(data?.skills) ? data.skills : [])
  const plugins = arr
    .filter((x: any) => x && (x.id || x.name))
    .map((x: any) => ({
      id: String(x.id || x.name),
      name: String(x.name || x.id),
      version: String(x.version || ''),
      apiVersion: String(x.apiVersion || ''),
      description: String(x.description || x.desc || ''),
      permissions: Array.isArray(x.permissions) ? x.permissions.map((p: any) => String(p)) : [],
      path: String(x.path || ''),
      downloadUrl: String(x.downloadUrl || x.download_url || x.url || '') || (x.path && fallbackBundleUrl ? fallbackBundleUrl(String(x.path)) : ''),
    }))
  return {
    plugins,
    skills: skills
      .filter((s: any) => s && (s.name || s.id))
      .map((s: any) => ({
        name: String(s.name || s.id),
        description: String(s.description || s.desc || ''),
        path: String(s.path || ''),
        downloadUrl: String(s.downloadUrl || s.download_url || s.url || ''),
      })),
  }
}
