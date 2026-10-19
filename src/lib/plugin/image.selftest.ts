/**
 * pluginImageApi.selftest.ts — `ctx.image` 适配器（生图）的自测
 *
 * 生图有两条容易错的边界，这里都钉住：
 * 1. **失败不抛异常**（除了"没声明权限"这种程序错误）——插件按 `code` 分支，不写 try/catch 也能用；
 * 2. **参数夹紧与参考图上限**在契约层只有一份实现，适配器不得再写一套数字。
 *
 * DI 纯函数：生成器 / 配置 / 探活都是注入的，不需要真实 Gradio 服务、不需要 DOM。
 * 用法：`node scripts/run-selftests.mjs pluginImageApi`
 */

import { createPluginImageApi, type PluginImageApiDeps } from './image'
import { IMAGE_LIMITS, normalizeImageRequest, classifyImageError } from '@/shared/imageContract'

export interface ImageApiCase {
  name: string
  ok: boolean
  detail?: string
}

const CONFIG = { url: 'http://127.0.0.1:7861', modelType: 'Qwen(本地免费)', width: 1024, height: 1024, steps: 4, negative: 'lowres', token: 'secret-token' }

function makeDeps(over: Partial<PluginImageApiDeps> = {}): { deps: PluginImageApiDeps; calls: any[] } {
  const calls: any[] = []
  const deps: PluginImageApiDeps = {
    pluginId: 'probe',
    permitted: true,
    log: { info: () => {}, warn: () => {} },
    config: () => CONFIG,
    probe: async (base: string) => {
      calls.push({ probe: base })
      return { version: '5.0.0', base }
    },
    generate: async (cfg: any, opts: any) => {
      calls.push({ cfg, opts })
      return { images: [{ url: 'http://127.0.0.1:7861/gradio_api/file=/tmp/a.png', path: '/tmp/a.png' }], log: 'ok' }
    },
    ...over,
  }
  return { deps, calls }
}

export async function runPluginImageApiSelfTest(): Promise<ImageApiCase[]> {
  const cases: ImageApiCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 权限 ----
  {
    const { deps } = makeDeps({ permitted: false })
    const api = createPluginImageApi(deps)
    check('未声明 image 权限 → available=false 且 reason 说明', api.available === false && /image/.test(api.reason), api.reason)
    let thrown = ''
    try {
      await api.generate({ prompt: 'cat' })
    } catch (e: any) {
      thrown = String(e?.message ?? e)
    }
    check('未声明权限 → generate 抛错（程序错误，不是运行时失败）', /image/.test(thrown), thrown)
  }

  // ---- 未配置服务 ----
  {
    const { deps } = makeDeps({ config: () => ({ url: '' }) })
    const api = createPluginImageApi(deps)
    check('没配服务地址 → available=false', api.available === false)
    const r = await api.generate({ prompt: 'cat' })
    check('没配服务地址 → IMAGE_NOT_CONFIGURED（结构化，不抛）', r.ok === false && r.code === 'IMAGE_NOT_CONFIGURED', JSON.stringify(r))
  }

  // ---- 正常 ----
  {
    const { deps, calls } = makeDeps()
    const api = createPluginImageApi(deps)
    check('权限 + 地址齐 → available=true 且 reason 为空', api.available === true && api.reason === '')
    const r = await api.generate({ prompt: '一只猫', width: 9999, steps: 999 })
    check('成功 → ok=true 且有图片 URL', r.ok === true && r.images.length === 1 && r.images[0].url.includes('/file='), JSON.stringify(r.images))
    const call = calls.find((c) => c.cfg)
    check('宽度被夹到上限（契约层夹紧，适配器不另写一套）', call?.cfg?.width === IMAGE_LIMITS.maxSide, String(call?.cfg?.width))
    check('步数被夹到上限', call?.cfg?.steps === IMAGE_LIMITS.maxSteps, String(call?.cfg?.steps))
    check('token 交给实现（插件拿不到，但宿主得用）', call?.cfg?.token === 'secret-token')
    check('负面词来自用户配置的默认值', call?.cfg?.negative === 'lowres', String(call?.cfg?.negative))
  }

  // ---- 参数与参考图 ----
  {
    const { deps } = makeDeps()
    const api = createPluginImageApi(deps)
    const empty = await api.generate({ prompt: '  ' })
    check('空提示词 → IMAGE_NO_PROMPT', empty.ok === false && empty.code === 'IMAGE_NO_PROMPT', JSON.stringify(empty))
    const tooMany = await api.generate({ prompt: 'x', reference: [1, 2, 3, 4].map(() => ({ base64: 'AAAA' })) })
    check('参考图超过 3 张 → IMAGE_TOO_MANY_REFS', tooMany.ok === false && tooMany.code === 'IMAGE_TOO_MANY_REFS', JSON.stringify(tooMany))
  }
  {
    const { deps } = makeDeps({
      generate: async () => ({ images: [], log: 'queue rejected' }),
    })
    const api = createPluginImageApi(deps)
    const r = await api.generate({ prompt: 'cat' })
    check('服务端没返回图片 → IMAGE_FAILED 且带日志尾部', r.ok === false && r.code === 'IMAGE_FAILED' && String(r.log || '').includes('rejected'), JSON.stringify(r))
  }

  // ---- 失败分类 ----
  {
    const { deps } = makeDeps({ generate: async () => { throw new Error('请求超时（300s）') } })
    const api = createPluginImageApi(deps)
    const r = await api.generate({ prompt: 'cat' })
    check('超时 → IMAGE_TIMEOUT（不抛）', r.ok === false && r.code === 'IMAGE_TIMEOUT', JSON.stringify(r))
  }
  {
    const { deps } = makeDeps({ generate: async () => { throw new Error('Failed to fetch') } })
    const api = createPluginImageApi(deps)
    const r = await api.generate({ prompt: 'cat' })
    check('连不上服务 → IMAGE_UNREACHABLE', r.ok === false && r.code === 'IMAGE_UNREACHABLE', JSON.stringify(r))
  }
  {
    const { deps } = makeDeps()
    const api = createPluginImageApi(deps)
    const pre = new AbortController()
    pre.abort()
    const r = await api.generate({ prompt: 'cat', signal: pre.signal })
    check('调用前就 abort → IMAGE_CANCELLED', r.ok === false && r.code === 'IMAGE_CANCELLED', JSON.stringify(r))
  }
  {
    // 真取消：生成器一直挂到 signal 被 abort
    const { deps } = makeDeps({
      generate: (_cfg: any, opts: any) =>
        new Promise((_resolve, reject) => {
          const signal = opts.signal as AbortSignal
          if (signal.aborted) return reject(new Error('aborted'))
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    const api = createPluginImageApi(deps)
    const pending = api.generate({ prompt: 'cat' })
    await new Promise((r) => setTimeout(r, 10))
    const cancelled = api.cancelAll()
    const r = await pending
    check('cancelAll → 取消在飞请求并返回计数', cancelled.cancelled === 1, JSON.stringify(cancelled))
    check('被取消 → IMAGE_CANCELLED（不是 FAILED）', r.ok === false && r.code === 'IMAGE_CANCELLED', JSON.stringify(r))
  }

  // ---- 连通性 ----
  {
    const { deps } = makeDeps()
    const api = createPluginImageApi(deps)
    const info = await api.info()
    check('info() 探活成功 → connected=true + version', info.connected === true && info.version === '5.0.0', JSON.stringify(info))
  }
  {
    const { deps } = makeDeps({ probe: async () => { throw new Error('Failed to fetch') } })
    const api = createPluginImageApi(deps)
    const info = await api.info()
    check('info() 探活失败 → connected=false + code（不抛）', info.connected === false && info.code === 'IMAGE_UNREACHABLE', JSON.stringify(info))
  }

  // ---- 契约层自身 ----
  check('默认尺寸/步数来自边界常量', normalizeImageRequest({ prompt: 'x' }).ok === true
    && (normalizeImageRequest({ prompt: 'x' }) as any).width === IMAGE_LIMITS.defaultSide
    && (normalizeImageRequest({ prompt: 'x' }) as any).steps === IMAGE_LIMITS.defaultSteps)
  check('classifyImageError: aborted 优先', classifyImageError(new Error('Failed to fetch'), true) === 'IMAGE_CANCELLED')

  return cases
}
