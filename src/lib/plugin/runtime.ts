/**
 * runtime.ts — 渲染层插件运行时（P1）
 *
 * 职责（与主进程 PluginHost 对称，只做浏览器侧那半）：
 * 1. 声明内置槽位（`declareCoreSlots`），使插件在任何时刻都能注册；
 * 2. 拉取插件清单，为「已激活且声明了 client 半边」的插件加载其 bundle 并执行 apply；
 * 3. 订阅 `plugin/changed`：启停 / 重载 / 卸载后**同步**装载或撤销渲染层贡献
 *    （撤销 = 跑该插件的 disposer，槽位条目随之消失，不需要刷新页面）；
 * 4. 同步「已激活插件注册的工具名」给能力槽推导，使插件工具对智能体可见。
 *
 * 客户端 bundle 的加载方式：主进程读取入口源码 → IPC 传字符串 → 本层用 Blob URL
 * `import()`。比自定义协议简单，且 dev（http）与生产（file://）行为一致；
 * 代价是**客户端半边必须是单文件 ESM**：Blob 模块**无法解析裸模块名**，
 * 因此插件不能 `import { h } from 'vue'`，要用宿主注入的 `ctx.vue`（单实例，见 PluginVueApi）。
 */

import { declareCoreSlots, coreSlotScope, slotRegistry, type SlotDefinition } from './slots'
import { getPluginBridge, type PluginBridgeApi } from './bridge'
import { createPluginLocaleApi, type PluginLocaleApi } from './locale'
import { createPluginLlmApi, type PluginLlmApi } from './llm'
import { createPluginFilesApi, releasePluginPdfCache, type PluginFilesApi } from './files'
import { createPluginAppApi, type PluginAppApi } from './appApi'
import { createPluginTtsApi, type PluginTtsApi } from './tts'
import { PluginShortcutService, type ShortcutRecord } from './shortcuts'
import { setPluginToolNames } from '@/lib/agent/capabilities'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import type { PluginLogLevel, PluginSnapshot } from '@/types/plugin'
// 宿主自带的 Vue 运行时：以 ctx.vue 交给插件，保证**单实例**（插件自带 vue 会导致响应式失效）
import * as VueRuntime from 'vue'

/**
 * 暴露给插件的 Vue API 子集。
 *
 * 为什么必须由宿主注入：插件 bundle 是单文件 ESM，经 Blob URL 加载时**无法解析裸模块名**
 * （`import { h } from 'vue'` 在 blob 模块里必然失败）。由宿主传入同时解决了「单实例」问题
 * ——插件自带的 vue 会是第二个副本，跨副本的响应式/依赖注入都会失效。
 */
export interface PluginVueApi {
  h: typeof VueRuntime.h
  defineComponent: typeof VueRuntime.defineComponent
  ref: typeof VueRuntime.ref
  shallowRef: typeof VueRuntime.shallowRef
  reactive: typeof VueRuntime.reactive
  computed: typeof VueRuntime.computed
  watch: typeof VueRuntime.watch
  watchEffect: typeof VueRuntime.watchEffect
  onMounted: typeof VueRuntime.onMounted
  onUnmounted: typeof VueRuntime.onUnmounted
  onBeforeUnmount: typeof VueRuntime.onBeforeUnmount
  nextTick: typeof VueRuntime.nextTick
  toRef: typeof VueRuntime.toRef
  toRefs: typeof VueRuntime.toRefs
  markRaw: typeof VueRuntime.markRaw
  provide: typeof VueRuntime.provide
  inject: typeof VueRuntime.inject
  KeepAlive: typeof VueRuntime.KeepAlive
  Teleport: typeof VueRuntime.Teleport
  Transition: typeof VueRuntime.Transition
  Fragment: typeof VueRuntime.Fragment
}

const PLUGIN_VUE_API: PluginVueApi = {
  h: VueRuntime.h,
  defineComponent: VueRuntime.defineComponent,
  ref: VueRuntime.ref,
  shallowRef: VueRuntime.shallowRef,
  reactive: VueRuntime.reactive,
  computed: VueRuntime.computed,
  watch: VueRuntime.watch,
  watchEffect: VueRuntime.watchEffect,
  onMounted: VueRuntime.onMounted,
  onUnmounted: VueRuntime.onUnmounted,
  onBeforeUnmount: VueRuntime.onBeforeUnmount,
  nextTick: VueRuntime.nextTick,
  toRef: VueRuntime.toRef,
  toRefs: VueRuntime.toRefs,
  markRaw: VueRuntime.markRaw,
  provide: VueRuntime.provide,
  inject: VueRuntime.inject,
  KeepAlive: VueRuntime.KeepAlive,
  Teleport: VueRuntime.Teleport,
  Transition: VueRuntime.Transition,
  Fragment: VueRuntime.Fragment,
}

/** 客户端插件上下文（对齐主进程 ctx 的形状，去掉宿主能力、加上槽位与 Vue 运行时） */
export interface ClientPluginContext {
  readonly plugin: { id: string; name: string; version: string; dir: string }
  /** 用户在「设置 → 插件 → 配置」里保存的 JSON */
  readonly config: Readonly<Record<string, unknown>>
  /** 宿主注入的 Vue 运行时（单实例；插件不要自带 vue，也不要写 `import ... from 'vue'`） */
  readonly vue: PluginVueApi
  /** 文案服务：中英双语字典 + 响应式取词（切语言自动重渲染） */
  readonly locale: PluginLocaleApi
  /**
   * 大模型能力：按来源 / 模型发起一次性对话，并可拉取来源的模型清单。
   * 需要清单声明 `permissions: ['llm']`——未声明时 `available` 为 false 且调用抛错。
   */
  readonly llm: PluginLlmApi
  /**
   * 文件能力：选文件 / 选文件夹 / 列目录 / 读文本（PDF 自动提取）/ 渲染 PDF 页面 / 应用内置查看器打开。
   * 需要清单声明 `permissions: ['fs']`；主进程另有「只能访问用户在该插件里选过的路径」的授权校验。
   */
  readonly files: PluginFilesApi
  /** 应用信息（只读）：名称 / 版本 / 语言、预设智能体清单 */
  readonly app: PluginAppApi
  /**
   * 语音能力：把一段文本交给应用自己的 TTS 念出来（引擎 / 音色 / 语速由「设置 → 语音」决定）。
   * 不需要声明权限，但 `available` 为 false 时要用 `reason` 给出可读提示。
   */
  readonly tts: PluginTtsApi
  /** 快捷键服务：注册全局快捷键（单一监听器，输入框内默认不抢键） */
  readonly shortcuts: {
    register(binding: string, handler: (event: KeyboardEvent) => void, options?: {
      descriptionZh?: string
      descriptionEn?: string
      preventDefault?: boolean
      allowInInput?: boolean
      when?: () => boolean
    }): () => void
    /** 已注册快捷键（诊断 / 自查） */
    list(): ShortcutRecord[]
  }
  /** 槽位贡献：注册即副作用，插件卸载时自动撤销 */
  readonly slots: {
    /** 向内置槽位注册条目（槽位未声明 / key 重复 / kind 不匹配 → 抛错） */
    register(slot: string, def: SlotDefinition): () => void
    /** 声明子槽位（供该条目继续扩展）；随插件卸载递归撤销 */
    declare(slot: string, kind?: 'single' | 'list' | 'keyed' | 'chain'): { register(def: SlotDefinition): () => void; dispose(): void }
    /** 读取某槽位当前条目（只读，用于自查） */
    entries(slot: string): SlotDefinition[]
  }
  readonly on: (type: string, listener: (payload: unknown) => void) => () => void
  readonly effect: (fn: () => void | (() => void | Promise<void>)) => () => void
  /** 向用户弹出轻提示（元素消息；仅主窗口会显示，避免多窗口重复提示） */
  notify(message: string): void
  readonly log: {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
}

/** 客户端插件模块的期望导出形状 */
export interface AikmClientPluginModule {
  apply(ctx: ClientPluginContext): void | Promise<void>
}

interface ClientPluginHandle {
  snapshot: PluginSnapshot
  /** 装载时主进程给的 loadedAt：变了说明主进程重新装载过（= 用户点了「重新载入」）→ 界面半边也要重来 */
  loadedAt: number | null
  ctx: ClientPluginContext
  dispose: () => Promise<void>
}

// ---------------------------------------------------------------------------
// 渲染层事件总线（插件之间 / 插件与外壳之间的轻量通信）
// ---------------------------------------------------------------------------

class ClientEventBus {
  private listeners = new Map<string, Set<(payload: unknown) => void>>()

  on(type: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  emit(type: string, payload: unknown): void {
    const set = this.listeners.get(type)
    if (!set) return
    for (const listener of Array.from(set)) {
      try {
        listener(payload)
      } catch (e) {
        console.error(`[plugin-runtime] 事件监听器异常 (${type}):`, e)
      }
    }
  }
}

const bus = new ClientEventBus()

/** 渲染层插件事件（供插件订阅；外壳也在这条总线上广播 plugin/changed） */
export const clientPluginEvents = {
  on: (type: string, listener: (payload: unknown) => void) => bus.on(type, listener),
}

// ---------------------------------------------------------------------------
// 宿主服务：文案 + 快捷键（进程内单例，所有插件共用）
// ---------------------------------------------------------------------------

/** 当前语言来源：跟随 store.locales（'zh' | 'en'） */
function currentLanguage(): string {
  try {
    return usestore().locales === 'en' ? 'en' : 'zh'
  } catch {
    // pinia 未就绪（极早期调用）时按中文，避免抛错打断插件加载
    return 'zh'
  }
}

let localeApi: PluginLocaleApi | null = null
function sharedLocaleApi(): PluginLocaleApi {
  if (!localeApi) localeApi = createPluginLocaleApi({ getLanguage: currentLanguage })
  return localeApi
}

const isMacPlatform = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '')

let shortcutService: PluginShortcutService | null = null
function sharedShortcutService(): PluginShortcutService {
  if (!shortcutService) {
    shortcutService = new PluginShortcutService({
      target: window,
      isMac: isMacPlatform,
      onWarning: (message) => console.warn(message),
    })
  }
  return shortcutService
}

/** 已注册的插件快捷键（设置页「插件详情」展示；无插件注册时为空数组） */
export function pluginShortcutRecords(): ShortcutRecord[] {
  return shortcutService?.list() ?? []
}

/** 某个插件（owner = `plugin:<id>`）注册的快捷键；不传 owner 则返回全部 */
export function clientShortcuts(owner?: string): ShortcutRecord[] {
  const all = pluginShortcutRecords()
  return owner ? all.filter((r) => r.owner === owner) : all
}

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

interface ClientContextDeps {
  snapshot: PluginSnapshot
  log: ClientPluginContext['log']
}

function createClientContext(deps: ClientContextDeps): { ctx: ClientPluginContext; dispose: () => Promise<void> } {
  const { snapshot } = deps
  const owner = `plugin:${snapshot.id}`
  const disposers: Array<() => void | Promise<void>> = []
  let disposed = false

  const track = (fn: () => void | Promise<void>): (() => void) => {
    if (disposed) {
      void safeRun(fn)
      return () => {}
    }
    disposers.push(fn)
    return () => {
      const i = disposers.indexOf(fn)
      if (i !== -1) disposers.splice(i, 1)
      void safeRun(fn)
    }
  }

  const ctx: ClientPluginContext = {
    plugin: { id: snapshot.id, name: snapshot.name, version: snapshot.version, dir: snapshot.dir },
    config: snapshot.config ?? {},
    vue: PLUGIN_VUE_API,
    locale: sharedLocaleApi(),
    llm: createPluginLlmApi({
      pluginId: snapshot.id,
      permitted: (snapshot.permissions ?? []).includes('llm'),
      log: deps.log,
    }),
    files: createPluginFilesApi({
      pluginId: snapshot.id,
      permitted: (snapshot.permissions ?? []).includes('fs'),
      log: deps.log,
    }),
    app: createPluginAppApi(),
    tts: createPluginTtsApi({ pluginId: snapshot.id, log: deps.log }),
    shortcuts: {
      register: (binding, handler, options) =>
        track(sharedShortcutService().register({ binding, handler, ...(options ?? {}) }, owner)),
      list: () => sharedShortcutService().list(),
    },
    slots: {
      register(slot: string, def: SlotDefinition) {
        const scope = coreSlotScope(slot)
        if (!scope) {
          throw new Error(
            `[plugin:${snapshot.id}] 槽位未声明：${slot}（可用：${slotRegistry.snapshot().map((s) => s.slot).join(', ')}）`,
          )
        }
        return track(scope.register({ ...def, owner }))
      },
      declare(slot: string, kind) {
        const scope = coreSlotScope(slot)
        if (!scope) throw new Error(`[plugin:${snapshot.id}] 无法声明子槽位，父槽位未声明：${slot}`)
        const child = scope.declare(slot, kind)
        track(() => child.dispose())
        return {
          register: (def: SlotDefinition) => track(child.register({ ...def, owner })),
          dispose: () => child.dispose(),
        }
      },
      entries(slot: string) {
        return slotRegistry.entriesAll(slot)
      },
    },
    on: (type, listener) => track(bus.on(type, listener)),
    effect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup !== 'function') return () => {}
      return track(cleanup)
    },
    notify: (message) => {
      try {
        ElMessage.info({ message: String(message ?? ''), grouping: true })
      } catch (e) {
        deps.log.warn('notify 失败:', e)
      }
    },
    log: deps.log,
  }

  const dispose = async (): Promise<void> => {
    disposed = true
    for (const fn of disposers.splice(0).reverse()) await safeRun(fn)
    releasePluginPdfCache(snapshot.id)
    slotRegistry.notify()
  }

  return { ctx, dispose }
}

async function safeRun(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    console.error('[plugin-runtime] 撤销注册失败:', e)
  }
}

/** 插件日志器：同时进控制台与本地环形缓冲（设置页「日志」在 P1 仍看主进程侧） */
const LOG_LIMIT = 200
const clientLogs: Array<{ id: string; level: PluginLogLevel; message: string; ts: number }> = []

export function clientPluginLogs(id?: string): Array<{ id: string; level: PluginLogLevel; message: string; ts: number }> {
  return id ? clientLogs.filter((l) => l.id === id) : clientLogs.slice()
}

/**
 * 界面半边的**装载结果**（按插件 id）：设置页据此提示「界面半边装载失败：…」。
 * 只反映最近一次尝试，失败后再次 `syncClientPlugins()`（例如管理页点「重新载入」）会刷新它。
 */
export function clientPluginLoadStates(): Record<string, { ok: boolean; message: string; ts: number }> {
  return Object.fromEntries(Array.from(clientLoadState.entries()))
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      // Error 直接 JSON.stringify 会得到 {}（真实踩过：插件日志把渲染失败的报错吞成 {}）
      if (a instanceof Error) return `${a.name}: ${a.message}`
      if (a && typeof a === 'object' && 'message' in (a as Record<string, unknown>)) {
        const err = a as { name?: string; message?: unknown }
        return `${err.name || 'Error'}: ${String(err.message)}`
      }
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

function createClientLogger(id: string): ClientPluginContext['log'] {
  const push = (level: PluginLogLevel, args: unknown[]): void => {
    const message = formatArgs(args)
    clientLogs.push({ id, level, message, ts: Date.now() })
    if (clientLogs.length > LOG_LIMIT) clientLogs.splice(0, clientLogs.length - LOG_LIMIT)
    const prefix = `[plugin:${id}]`
    if (level === 'error') console.error(prefix, message)
    else if (level === 'warn') console.warn(prefix, message)
    else console.log(prefix, message)
    // warn / error 同步给主进程：界面半边出错（装载失败、apply 抛错）时，
    // 「插件 → 管理 → 日志」与开发者 MCP 服务（plugin_dev_check）才看得到原因。
    // 只转发 warn / error 且吞掉失败，避免 debug 日志刷爆 IPC。
    if (level === 'error' || level === 'warn') {
      try {
        getPluginBridge()?.clientLog?.(id, level, message)
      } catch {
        /* 桥不可用（网页端）时忽略 */
      }
    }
  }
  return {
    debug: (...a: unknown[]) => push('debug', a),
    info: (...a: unknown[]) => push('info', a),
    warn: (...a: unknown[]) => push('warn', a),
    error: (...a: unknown[]) => push('error', a),
  }
}

// ---------------------------------------------------------------------------
// 装载 / 卸载
// ---------------------------------------------------------------------------

const loaded = new Map<string, ClientPluginHandle>()
/** 上一次界面半边装载结果（按插件 id）：供设置页显示「界面半边装载失败」的提示 */
const clientLoadState = new Map<string, { ok: boolean; message: string; ts: number }>()
let syncing: Promise<void> | null = null
/** 同步期间又有新请求：**不能丢**，本轮结束后必须再跑一遍 */
let syncPending = false
let initialized = false

/** 初始化渲染层插件运行时（入口调用一次；无插件桥时静默降级） */
export async function initPluginRuntime(): Promise<void> {
  if (initialized) return
  initialized = true
  declareCoreSlots()
  const bridge = getPluginBridge()
  if (!bridge) return
  bridge.onEvent((ev) => {
    // 状态变化（启用 / 禁用 / 重载 / 卸载）后同步渲染层贡献
    if (ev.type === 'plugin/changed') void syncClientPlugins()
  })
  await syncClientPlugins()
}

/**
 * 同步渲染层插件：装载新增、卸载不再需要、重试之前装载失败的。
 *
 * 关键：同步进行中收到的新请求**排队**而不是丢弃。以前这里是 `if (syncing) return syncing`——
 * 主进程「重载插件」会先后广播两条 plugin/changed（卸载一条 + 装载一条），第二条常常落在
 * 第一次同步的进行期间而被丢掉，于是**界面上那份（客户端半边）永远不再重试**：用户改好文件、
 * 点「重新载入」看着没反应，只有重启软件（全新一次同步）才恢复。排队后最后一次状态一定会被应用。
 */
export function syncClientPlugins(): Promise<void> {
  if (syncing) {
    syncPending = true
    return syncing
  }
  syncing = (async () => {
    do {
      syncPending = false
      await doSync()
    } while (syncPending)
  })().finally(() => {
    syncing = null
    syncPending = false
  })
  return syncing
}

async function doSync(): Promise<void> {
  const bridge = getPluginBridge()
  if (!bridge) return
  let plugins: PluginSnapshot[]
  try {
    const res = await bridge.list()
    plugins = res.plugins ?? []
  } catch (e) {
    console.warn('[plugin-runtime] 拉取插件清单失败:', e)
    return
  }

  // 1) 插件工具同步（已激活插件的工具 → 智能体可见集）
  const toolNames: string[] = []
  for (const p of plugins) {
    if (p.status === 'active') for (const name of p.tools ?? []) toolNames.push(name)
  }
  setPluginToolNames(toolNames)

  // 2) 卸载：不再需要（禁用 / 卸载 / 加载失败 / 不再有 client 半边）的插件，
  //    以及主进程重新装载过的（loadedAt 变了）——否则改完界面半边点「重新载入」界面不会更新
  const wanted = plugins.filter((p) => p.status === 'active' && p.hasClient && p.clientEntry)
  for (const [id, handle] of Array.from(loaded.entries())) {
    const still = wanted.find((p) => p.id === id)
    if (still && handle.loadedAt === still.loadedAt) continue
    await handle.dispose()
    loaded.delete(id)
    bus.emit('plugin/unloaded', { id })
  }

  // 3) 装载新增 / 重载（上一步已把需要重载的卸掉）
  for (const p of wanted) {
    if (loaded.has(p.id)) continue
    await loadOne(bridge, p)
  }

  slotRegistry.notify()
}

async function loadOne(bridge: PluginBridgeApi, snapshot: PluginSnapshot): Promise<void> {
  const log = createClientLogger(snapshot.id)
  try {
    const bundle = await bridge.clientBundle(snapshot.id)
    if (!bundle?.code) throw new Error('客户端 bundle 为空')
    const plugin = await importBundle(snapshot.id, bundle.code)
    const handle = createClientContext({ snapshot, log })
    try {
      await plugin.apply(handle.ctx)
    } catch (e) {
      // apply 抛错 → 回滚本次已注册的贡献，不留半成品
      await handle.dispose()
      throw e
    }
    loaded.set(snapshot.id, { snapshot, loadedAt: snapshot.loadedAt ?? null, ctx: handle.ctx, dispose: handle.dispose })
    clientLoadState.set(snapshot.id, { ok: true, message: '', ts: Date.now() })
    log.info(`${snapshot.name}@${snapshot.version} 界面扩展已装载`)
    // 装载成功也同步给主进程一条（info 级日志默认不转发）：用户在「插件 → 管理 → 日志」、
    // 以及开发者 MCP 服务（plugin_dev_check）里都能确认界面半边真的起来了，而不只是「没报错」。
    try {
      getPluginBridge()?.clientLog?.(snapshot.id, 'info', `${snapshot.name}@${snapshot.version} 界面扩展已装载`)
    } catch {
      /* 桥不可用时忽略 */
    }
    bus.emit('plugin/loaded', { id: snapshot.id })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    clientLoadState.set(snapshot.id, { ok: false, message, ts: Date.now() })
    log.error(`界面扩展装载失败：${message}`)
  }
}

/** 用 Blob URL 动态 import 单文件 ESM（见文件头注释的取舍） */
async function importBundle(id: string, code: string): Promise<AikmClientPluginModule> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  try {
    const mod: any = await import(/* @vite-ignore */ url)
    const plugin = (mod?.default ?? mod) as AikmClientPluginModule
    if (!plugin || typeof plugin.apply !== 'function') {
      throw new Error('client 半边必须导出 apply(ctx)（默认导出或具名 apply 均可）')
    }
    return plugin
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // CSP 未放行 blob: 时的典型报错，给出可操作的提示
    if (/Content Security Policy|blob:/i.test(message)) {
      throw new Error(`${message}（请确认 index.html 的 CSP script-src 含 blob:）`)
    }
    throw new Error(`加载 ${id} 的界面扩展失败：${message}`)
  } finally {
    // 模块已求值完成，可安全回收（客户端半边不得再依赖该 blob URL 做后续动态导入）
    URL.revokeObjectURL(url)
  }
}
