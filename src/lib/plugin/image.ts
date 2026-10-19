/**
 * image.ts — 界面半边的 `ctx.image`（生图能力，对齐 DSH 的能力缝样式）
 *
 * 为什么在界面半边：用户的生图配置（服务地址 / 模型类型 / 步数 / token）与 llm 一样**只存在于渲染层**
 * （`store.AIconfig.image`）。主进程没有这份配置，复制过去必然漂移——与 `ctx.agent` / `ctx.llm` 同一条
 * 约束（见 docs/plan/ctx.agent.run §2.2 约束 A）。
 *
 * 判权：清单声明 `permissions: ['image']` 才给实现；未声明时 `available === false`，调用返回
 * `IMAGE_NOT_CONFIGURED`-style 的结构化失败（这里统一用 `IMAGE_FAILED` + 明确 message？不——
 * 用 `IMAGE_NOT_CONFIGURED` 会误导"没配服务"，所以未授权直接抛错，与 ctx.llm 的 guard 一致）。
 *
 * 结果纪律（与 `ctx.agent` / `ctx.llm.stream` 同源）：
 * - 失败**不抛异常**，返回 `{ ok:false, code, error? }`；
 * - 取消（signal / cancelAll）→ `code:'IMAGE_CANCELLED'`；
 * - 参数不合法（空提示词、参考图过多）也走结构化结果，不抛。
 * 只有"没权限"才抛——那是程序错误（清单没写），不是运行时失败。
 */

import { qwenImageGenerate, qwenImageInfo } from '@/services/image/qwenImage'
import { usestore } from '@/store'
import {
  classifyImageError,
  normalizeImageRequest,
  type ImageErrorCode,
  type PluginImageInfo,
  type PluginImageRequest,
  type PluginImageResult,
} from '@/shared/imageContract'

export interface PluginImageApi {
  /** 权限 + 服务地址都齐了才为 true */
  readonly available: boolean
  /** 不可用原因（给作者看的可读说明） */
  readonly reason: string
  /** 读服务信息（版本 / 模型类型 / 是否连通）；不通不抛，返回 connected=false */
  info(): Promise<PluginImageInfo & { error?: string; code?: ImageErrorCode }>
  /**
   * 画一张（或按参考图画）。**失败不抛**，看 `ok` 与 `code`。
   * 生成出来的 `images[i].url` 可直接放进 <img src>；要不要落盘由插件用 ctx.fs 自己决定。
   */
  generate(request: PluginImageRequest): Promise<PluginImageResult>
  /** 放弃本插件所有在飞的等待（Gradio 任务本身无法取消，这里只是不再等） */
  cancelAll(): { cancelled: number }
}

export interface PluginImageApiDeps {
  pluginId: string
  permitted: boolean
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
  /** 取用户配置（注入以便自测；缺省读 store.AIconfig.image） */
  config?: () => { url?: string; modelType?: string; width?: number; height?: number; steps?: number; negative?: string; lora1?: string; lora2?: string; lora3?: string; lora4?: string; token?: string }
  /** 真正干活的实现（注入以便自测；缺省 = Qwen-Image Gradio 客户端） */
  generate?: (cfg: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{ images: Array<{ url: string; path?: string }>; log?: string }>
  /** 读服务信息（注入以便自测） */
  probe?: (base: string) => Promise<{ version?: string; base?: string }>
}

const REASON_NO_PERMISSION = (id: string): string =>
  `插件 ${id} 未声明 "image" 权限（package.json 的 aikm.permissions 加 "image"，然后在插件页重载）`
const REASON_NO_SERVICE = '还没有配置生图服务：请到「设置 → 模型 → 生图」填服务地址并测试连接'

function base64ToBlob(base64: string, mimeType = 'image/png'): Blob {
  const raw = atob(String(base64).replace(/^data:[^,]+,/, ''))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

export function createPluginImageApi(deps: PluginImageApiDeps): PluginImageApi {
  const inflight = new Set<AbortController>()
  const readConfig = () => {
    if (deps.config) return deps.config() || {}
    try {
      const store: any = usestore()
      return store?.AIconfig?.image ?? {}
    } catch {
      return {}
    }
  }
  const doGenerate = deps.generate || ((cfg, opts) => qwenImageGenerate(cfg as any, opts as any))
  const doProbe = deps.probe || (async (base: string) => qwenImageInfo(base))

  const serviceUrl = (): string => String(readConfig().url || '').trim()
  const guard = (): void => {
    if (!deps.permitted) throw new Error(REASON_NO_PERMISSION(deps.pluginId))
  }

  return {
    get available() {
      return deps.permitted && !!serviceUrl()
    },
    get reason() {
      if (!deps.permitted) return REASON_NO_PERMISSION(deps.pluginId)
      if (!serviceUrl()) return REASON_NO_SERVICE
      return ''
    },

    async info(): Promise<PluginImageInfo & { error?: string; code?: ImageErrorCode }> {
      guard()
      const base = serviceUrl()
      if (!base) return { connected: false, version: '', modelType: '', base: '', code: 'IMAGE_NOT_CONFIGURED', error: REASON_NO_SERVICE }
      const cfg = readConfig()
      try {
        const found = await doProbe(base)
        return {
          connected: true,
          version: String(found?.version || ''),
          modelType: String(cfg.modelType || ''),
          base,
        }
      } catch (e) {
        const code = classifyImageError(e)
        return {
          connected: false,
          version: '',
          modelType: String(cfg.modelType || ''),
          base,
          code,
          error: e instanceof Error ? e.message : String(e),
        }
      }
    },

    async generate(request: PluginImageRequest): Promise<PluginImageResult> {
      guard()
      const startedAt = Date.now()
      const cfg = readConfig()
      const base = String(cfg.url || '').trim()
      const norm = normalizeImageRequest(request, {
        width: cfg.width,
        height: cfg.height,
        steps: cfg.steps,
        negative: cfg.negative,
      })
      if (!norm.ok) {
        return { ok: false, images: [], code: norm.code, error: norm.message, elapsedMs: Date.now() - startedAt }
      }
      if (!base) {
        return { ok: false, images: [], code: 'IMAGE_NOT_CONFIGURED', error: REASON_NO_SERVICE, elapsedMs: Date.now() - startedAt }
      }

      const controller = new AbortController()
      const external = request?.signal
      const forward = () => controller.abort()
      if (external) {
        if (external.aborted) controller.abort()
        else external.addEventListener('abort', forward, { once: true })
      }
      inflight.add(controller)
      // 调用前就已被取消：**不要开始干活**（真跑一次模型既费时又占队列，结果还会被丢弃）
      if (controller.signal.aborted) {
        inflight.delete(controller)
        if (external) external.removeEventListener('abort', forward)
        return { ok: false, images: [], code: 'IMAGE_CANCELLED', error: '调用已被取消（signal 已 abort）', elapsedMs: Date.now() - startedAt }
      }
      try {
        const result = await doGenerate(
          {
            base,
            modelType: cfg.modelType,
            width: norm.width,
            height: norm.height,
            steps: norm.steps,
            negative: norm.negative,
            lora1: cfg.lora1,
            lora2: cfg.lora2,
            lora3: cfg.lora3,
            lora4: cfg.lora4,
            token: cfg.token,
            timeoutMs: norm.timeoutMs,
          },
          {
            prompt: norm.prompt,
            images: norm.refs.map((r) => base64ToBlob(r.base64, r.mimeType || 'image/png')),
            fileNames: norm.refs.map((_, i) => `ref-${i + 1}.png`),
            maxWaitMs: norm.timeoutMs,
            signal: controller.signal,
            onLog: (line: string) => request?.onProgress?.({ logLine: String(line || '') }),
            onQueue: (queue: number) => request?.onProgress?.({ queue }),
          },
        )
        const images = (result?.images || [])
          .filter((img) => img && typeof img.url === 'string' && img.url)
          .map((img) => ({ url: img.url, ...(img.path ? { path: img.path } : {}) }))
        if (!images.length) {
          return {
            ok: false,
            images: [],
            code: 'IMAGE_FAILED',
            error: '服务端没有返回图片（可能被队列策略拒绝，看 log）',
            elapsedMs: Date.now() - startedAt,
            ...(result?.log ? { log: String(result.log).slice(-2000) } : {}),
          }
        }
        return {
          ok: true,
          images,
          elapsedMs: Date.now() - startedAt,
          ...(result?.log ? { log: String(result.log).slice(-2000) } : {}),
        }
      } catch (e) {
        const code = classifyImageError(e, controller.signal.aborted)
        if (code !== 'IMAGE_CANCELLED') {
          deps.log.warn(`[plugin:${deps.pluginId}] 生图失败：${e instanceof Error ? e.message : String(e)}`)
        }
        return {
          ok: false,
          images: [],
          code,
          error: e instanceof Error ? e.message : String(e),
          elapsedMs: Date.now() - startedAt,
        }
      } finally {
        inflight.delete(controller)
        if (external) external.removeEventListener('abort', forward)
      }
    },

    cancelAll() {
      let n = 0
      for (const c of inflight) {
        try {
          c.abort()
          n++
        } catch {
          /* 已结束 */
        }
      }
      inflight.clear()
      return { cancelled: n }
    },
  }
}
