/**
 * updateCheck.ts — 「检查更新」：查 GitHub Releases 的最新版本，并挑出当前平台能装的包
 *
 * 只做两件事：
 * 1. 读取 `https://api.github.com/repos/<repo>/releases/latest`（只读，不需要登录）；
 * 2. 按当前平台（Windows / macOS / Linux / Android）过滤安装包并排序（安装版优先）。
 *
 * 下载不在这里做：调用方把 `browser_download_url` 交给系统浏览器（大文件不经过渲染进程），
 * 也不改任何配置 / 不写 localStorage，失败只抛错给界面提示。
 */

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface LatestRelease {
  /** 去掉 v 前缀的版本号，如 6.11.4 */
  version: string
  /** 原始 tag，如 v6.11.4 */
  tag: string
  /** Release 标题 */
  title: string
  /** Release 页面（浏览器打开） */
  pageUrl: string
  /** 发布时间（ISO） */
  publishedAt: string
  /** 更新说明（GitHub Release body，可能为空） */
  notes: string
  assets: ReleaseAsset[]
}

/** 仓库（与 package.json 的 homepage 一致） */
const REPO = 'whl1207/Knowledge'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

/** 当前应用版本（构建时注入；未注入时退回 0.0.0） */
export const currentAppVersion = (): string =>
  typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? String(__APP_VERSION__) : '0.0.0'

/**
 * 版本比较：`1.10.0 > 1.9.9`；忽略 v 前缀、`-rc.1` / `+build` 之类的后缀。
 * @returns >0 表示 a 更新，<0 表示 b 更新，0 相同
 */
export const compareVersions = (a: string, b: string): number => {
  const parts = (v: string): number[] => String(v || '')
    .replace(/^v/i, '')
    .split(/[+-]/)[0]
    .split('.')
    .map((n) => parseInt(n, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

export type ReleasePlatform = 'win' | 'mac' | 'linux' | 'android' | 'other'

/**
 * 当前平台：优先用平台适配层的 kind（android），其余按 User-Agent 判断。
 * 不引主进程依赖，浏览器 / 局域网模式同样可用。
 */
export const detectPlatform = (kind?: string): ReleasePlatform => {
  if (kind === 'android') return 'android'
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/android/i.test(ua)) return 'android'
  if (/windows/i.test(ua)) return 'win'
  if (/mac os x|macintosh/i.test(ua)) return 'mac'
  if (/linux|x11/i.test(ua)) return 'linux'
  return 'other'
}

/** 各平台安装包的文件名特征（与 scripts/collect-release.mjs 的产物命名一致） */
const PLATFORM_PATTERNS: Record<Exclude<ReleasePlatform, 'other'>, RegExp> = {
  win: /windows.*\.(exe|msi)$/i,
  mac: /mac.*\.(dmg|zip)$/i,
  linux: /linux.*\.(appimage|deb|tar\.gz)$/i,
  android: /\.apk$/i,
}

/** 平台显示名（对话框标题用） */
export const platformLabel = (p: ReleasePlatform, zh = true): string => {
  const map: Record<ReleasePlatform, { zh: string; en: string }> = {
    win: { zh: 'Windows', en: 'Windows' },
    mac: { zh: 'macOS', en: 'macOS' },
    linux: { zh: 'Linux', en: 'Linux' },
    android: { zh: 'Android', en: 'Android' },
    other: { zh: '当前平台', en: 'current platform' },
  }
  return zh ? map[p].zh : map[p].en
}

/**
 * 该平台可下载的包：安装版（Setup / Installer / dmg）优先，
 * 其次是 Portable / AppImage，最后是 deb 等。
 */
export const assetsForPlatform = (assets: ReleaseAsset[], platform: ReleasePlatform): ReleaseAsset[] => {
  if (platform === 'other') return []
  const re = PLATFORM_PATTERNS[platform]
  const rank = (name: string): number =>
    /setup|installer|\.dmg$/i.test(name) ? 0
      : /portable|appimage/i.test(name) ? 1
        : 2
  return assets
    .filter((a) => re.test(a.name))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
}

/** 字节数 → 可读文本（用于显示安装包大小） */
export const formatAssetSize = (bytes: number): string => {
  const n = Number(bytes || 0)
  if (!n) return ''
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

/** GitHub Releases 最新版本页面（检查失败时的兜底入口） */
export const releasesPageUrl = (): string => RELEASES_PAGE

/** 「跳过此版本」：只压制启动时的自动提醒，手动点「检查更新」仍然会弹对话框 */
const SKIP_KEY = 'kb-skip-update-version'
const AUTO_CHECK_KEY = 'kb-update-auto-checked-at'

export const readSkippedVersion = (): string => {
  try { return String(localStorage.getItem(SKIP_KEY) || '') } catch { return '' }
}
export const writeSkippedVersion = (version: string): void => {
  try { localStorage.setItem(SKIP_KEY, String(version || '')) } catch { /* 隐私模式忽略 */ }
}
export const clearSkippedVersion = (): void => {
  try { localStorage.removeItem(SKIP_KEY) } catch { /* 忽略 */ }
}

/** 启动自动检查的节流（默认 24 小时一次） */
export const shouldAutoCheck = (everyMs = 24 * 60 * 60 * 1000): boolean => {
  try {
    const last = Number(localStorage.getItem(AUTO_CHECK_KEY) || 0)
    return !last || Date.now() - last > everyMs
  } catch {
    return true
  }
}
export const markAutoChecked = (): void => {
  try { localStorage.setItem(AUTO_CHECK_KEY, String(Date.now())) } catch { /* 忽略 */ }
}

/** 拉取最新 Release（只读；失败抛错，由界面提示） */
export const fetchLatestRelease = async (): Promise<LatestRelease> => {
  let res: Response
  try {
    res = await fetch(`${LATEST_API}?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    })
  } catch (e: any) {
    throw new Error(e?.message || 'network error')
  }
  if (res.status === 404) throw new Error('no published release')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data: any = await res.json()
  const tag = String(data?.tag_name || '')
  return {
    version: tag.replace(/^v/i, ''),
    tag,
    title: String(data?.name || tag),
    pageUrl: String(data?.html_url || RELEASES_PAGE),
    publishedAt: String(data?.published_at || ''),
    notes: String(data?.body || ''),
    assets: Array.isArray(data?.assets)
      ? data.assets
        .filter((a: any) => a && a.name && a.browser_download_url)
        .map((a: any) => ({
          name: String(a.name),
          url: String(a.browser_download_url),
          size: Number(a.size) || 0,
        }))
      : [],
  }
}
