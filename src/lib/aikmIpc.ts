/**
 * aikmIpc.ts — 渲染进程访问宿主（Electron preload）IPC 的**唯一入口**
 *
 * 为什么需要它，而不是继续用 `window.ipcRenderer` / `window.dsh`：
 *
 * 插件的「界面半边」是宿主把源码包成 Blob URL、**在渲染进程同一个 realm 里** `import()`
 * 的（见 src/lib/plugin/runtime.ts）。因此只要通用 IPC 桥挂在 `window` 上，任何界面半边插件
 * ——哪怕清单里一个权限都没声明——都能直接
 *     window.ipcRenderer.invoke('tools:execute', { name: 'run_shell', … })
 *     window.dsh.credentials.resolve('xxx')
 * 拿到宿主几乎全部能力：`electron/main/ipc-registry.ts` 的 `tools:execute` / `credentials:resolve`
 * 等通道都不在插件判权路径上。也就是说清单里的 `permissions` 对「界面半边」形同虚设。
 *
 * 做法：
 * 1. preload **不再**把桥挂到 `window`，只暴露一个**一次性领取**函数
 *    `window.__aikmClaimIpcBridge()`（见 electron/preload/index.ts）；
 * 2. 本模块在应用启动最早时机领取，把桥保存在**模块作用域**里；
 * 3. 模块作用域对同 realm 的插件代码不可见——插件拿不到别的模块的闭包变量，也枚举不到任何全局名。
 *
 * 为什么不是「用一个假 window 遮蔽」：ESM 恒为严格模式，但 `(function(){}).constructor`
 * 拿到的是**内建** `Function`，不受作用域里 `Function` 绑定的影响，一句
 * `(function(){}).constructor('return window')()` 就能取回真全局。遮蔽在同一个 realm 里
 * 不构成边界，删除才是。
 *
 * ⚠️ 边界说明（不要过度承诺）：这不是沙箱。插件仍与宿主同进程、同文档，恶意插件仍能
 * 破坏界面、拖慢主进程。本模块消除的是**「零权限插件直接取得任意宿主 IPC 通道」这条具体路径**；
 * 真正的隔离需要独立窗口 / 独立进程（见 docs/plan/插件与工作台-实施方案（逐文件）.md 的安全模型）。
 *
 * 迁移约定：渲染层不得再出现 `window.ipcRenderer` / `window.dsh`（`globals.d.ts` 与
 * `src/vite-env.d.ts` 已移除这两个全局声明，写错会被 `vue-tsc` 直接拦下）。
 */

import type { AikmDshApi, IpcRendererApi } from '@/types/ipcBridge'

/** preload 一次性交给渲染层的桥（形状与 electron/preload/index.ts 的 api / dsh 一致） */
export interface AikmIpcHandle {
  ipcRenderer: IpcRendererApi
  dsh: AikmDshApi
}

export type { AikmDshApi, IpcRendererApi }

let claimed: AikmIpcHandle | null = null
let claiming = false

/**
 * 领取 IPC 桥（幂等；领取后立刻焚掉 window 上的领取函数，晚于应用启动执行的代码拿不到第二次）。
 *
 * 非 Electron 环境（浏览器 dev / 局域网访客网页 / 安卓 / preload 未加载）返回 null ——
 * 调用方据此静默降级，与 `window.ipcRenderer` 不存在时的历史行为一致。
 */
function claim(): AikmIpcHandle | null {
  if (claimed) return claimed
  if (claiming) return null
  if (typeof window === 'undefined') return null
  const take = (window as unknown as { __aikmClaimIpcBridge?: unknown }).__aikmClaimIpcBridge
  if (typeof take !== 'function') return null

  claiming = true
  try {
    const got = (take as () => unknown)()
    if (got && typeof got === 'object' && (got as AikmIpcHandle).ipcRenderer) {
      claimed = got as AikmIpcHandle
      // 领完即焚：插件界面半边是应用启动之后才装载的，此时领取入口已经不存在
      try {
        delete (window as unknown as Record<string, unknown>).__aikmClaimIpcBridge
      } catch {
        /* 属性不可配置（个别环境）：忽略，领取入口本身已是一次性的 */
      }
    }
  } catch (e) {
    console.error('[aikmIpc] 领取宿主 IPC 桥失败：', e)
  } finally {
    claiming = false
  }
  return claimed
}

/** 应用启动时显式领取（幂等；建议在 main.ts 顶部调用一次，避免首次调用落在插件装载之后） */
export function initAikmIpc(): boolean {
  return !!claim()
}

/**
 * 当前是否有可用的宿主 IPC 桥。
 * 这是 `if (!window.ipcRenderer) return` 的替代品——不要写成 `if (!aikmIpc)`：
 * `aikmIpc` 是一个恒真的 Proxy 对象，托底语义由本函数表达。
 */
export function aikmIpcAvailable(): boolean {
  return !!claim()
}

/**
 * 把桥**当值取出来**（不可用时返回 `null`）。
 *
 * 为什么需要它，而不是直接用 `aikmIpc`：历史代码里有大量
 *     const api = window.ipcRenderer
 *     if (!api) return          // 非 Electron 环境静默降级
 * 这种「取出桥 → 判空 → 用」的写法。JS 里对象恒真，`aikmIpc` 放进去会让 `if (!api)`
 * **永远不成立**，于是降级路径失效、调用点直接抛 "is not a function"。
 * 迁移这类站点一律用本函数，既有守卫可以一字不改。
 */
export function aikmIpcOrNull(): IpcRendererApi | null {
  return claim()?.ipcRenderer ?? null
}

/**
 * 通用 IPC 桥（`invoke` / `send` / `on` / `off`）。
 *
 * 用 Proxy 而不是直接导出对象，是为了保住历史语义：桥不存在时读任何成员都得到 `undefined`
 * （等价于 `window.ipcRenderer === undefined`），于是
 * `typeof aikmIpc.invoke === 'function'`、`!aikmIpc?.invoke` 这类判断照旧成立。
 */
export const aikmIpc: IpcRendererApi = new Proxy({} as IpcRendererApi, {
  get(_target, prop) {
    const bridge = claim()?.ipcRenderer
    if (!bridge) return undefined
    return (bridge as unknown as Record<string | symbol, unknown>)[prop]
  },
  has(_target, prop) {
    const bridge = claim()?.ipcRenderer
    return !!bridge && prop in (bridge as unknown as object)
  },
})

/**
 * 命名空间 IPC 桥（`aikmDsh.agent.*` / `aikmDsh.plugin.*` …）。
 * 类型上不写 `| undefined`：原 `Window.dsh` 是可选属性，调用方到处写 `window.dsh?.x`；
 * 这里恒为一个对象，语义与可选属性一致（不可用时读到 `undefined`）。
 */
export const aikmDsh: AikmDshApi = new Proxy({} as AikmDshApi, {
  get(_target, prop) {
    const ns = claim()?.dsh
    if (!ns) return undefined
    return (ns as unknown as Record<string | symbol, unknown>)[prop]
  },
  has(_target, prop) {
    const ns = claim()?.dsh
    return !!ns && prop in (ns as unknown as object)
  },
})
