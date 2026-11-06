/**
 * scopedFetch.ts — DSH 兼容包界面半边的 fetch 桥（纯逻辑）
 *
 * 生产环境渲染层是 `file://`：插件代码里的 `fetch('/api/...')` 会打到
 * `file:///api/...` 并失败。这里把**相对路径**重写到该插件自己的回环 webServer；
 * 绝对 URL 原样放行（插件访问外网仍受 CORS / 网络约束）。
 *
 * 基址可以滞后解析：webServer 的端口是 OS 分配的，界面半边装载时现问一次。
 */

export function createScopedFetch(
  baseUrl: string | undefined,
  fallback: typeof fetch,
  resolveBase?: () => Promise<string | null>,
): typeof fetch {
  if (!baseUrl && !resolveBase) return fallback
  return ((input: any, init?: any) => {
    let raw: string | undefined
    try {
      raw = typeof input === 'string' ? input : input?.url
    } catch {
      raw = undefined
    }
    if (typeof raw === 'string' && raw.startsWith('/')) {
      const resolve = async (): Promise<string | null> => {
        if (baseUrl) return baseUrl
        try {
          return (await resolveBase?.()) ?? null
        } catch {
          return null
        }
      }
      return resolve().then((base) => (base ? fallback(`${base}${raw}`, init) : fallback(input, init)))
    }
    return fallback(input, init)
  }) as typeof fetch
}
