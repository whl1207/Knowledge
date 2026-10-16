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
import { ClientEventBus } from './clientEventBus'
import { getPluginBridge, type PluginBridgeApi, type PluginClientBundle } from './bridge'
import { createPluginLocaleApi, type PluginLocaleApi } from './locale'
import { createPluginLlmApi, type PluginLlmApi } from './llm'
import { createPluginFilesApi, releasePluginPdfCache, type PluginFilesApi } from './files'
import { createPluginAppApi, type PluginAppApi } from './appApi'
import { createPluginAgentApi, type PluginAgentApi } from './agent'
import { listPluginAgentPresets, resolvePluginAgentPreset } from './agentPresetOptions'
import { createPluginTtsApi, type PluginTtsApi } from './tts'
import { PluginShortcutService, type ShortcutRecord } from './shortcuts'
import { setPluginDeclaredToolNames, setPluginToolNames } from '@/lib/agent/capabilities'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import type { PluginLogLevel, PluginSnapshot, PluginStatus } from '@/types/plugin'
// 宿主自带的 Vue 运行时：以 ctx.vue 交给插件，保证**单实例**（插件自带 vue 会导致响应式失效）
import * as VueRuntime from 'vue'
import { computed, ref } from 'vue'

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
   * 需要清单声明 `permissions: ['fs']`；主进程另有「只能访问用户在该插件里选过的路径」的授权校验
   * （选一次就记住、跨重启有效，可在「插件 → 数据」里撤销）。
   */
  readonly files: PluginFilesApi
  /** 应用信息（只读）：名称 / 版本 / 语言、预设智能体清单 */
  readonly app: PluginAppApi
  /**
   * 委派智能体：按一个**用户已配置好的预设**跑一次独立会话，拿回文本结果。
   *
   * 需要清单声明 `permissions: ['agent.run']`（与只读的 `'agent'` 是两件事，见 `PluginPermission` 注释），
   * 且**只在桌面端可用**（网页 / 移动端的本地宿主没有主进程可执行预算，`available` 为 false）。
   *
   * 边界（作者必须知道）：
   * - **不能选模型**：provider / 密钥都来自用户配置的预设，插件拿不到（防止"插件自带 key"绕过用户设置）；
   * - **预算由宿主裁定**：墙钟 / 步数 / 并发 / 每小时次数只紧不松，宿主还会裁掉被削项；
   * - **拿不到文件 / 命令类工具**：委派出的 agent 的工具白名单由宿主裁剪，fs / shell / MCP / 技能都不给；
   * - **首次调用由主进程弹框确认**，用户可「允许 / 每次都问 / 拒绝」；
   * - 只能跑**界面半边**（主进程半边的 `ctx.tool` 无法委派，原因见本文件顶部与设计 §8.5）。
   */
  readonly agent: PluginAgentApi
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
//
// 实现抽到 src/lib/plugin/clientEventBus.ts：那里没有 Vue / 平台依赖，可以被 Node 下的
// 自测直接实例化，从而**行为级**验证「重载不加监听器」这个不变式（见同目录 .selftest.ts）。
// ---------------------------------------------------------------------------

const bus = new ClientEventBus()

/**
 * 渲染层插件事件（供插件订阅）。
 *
 * 这条总线上由**外壳**发出的只有 `plugin/loaded` 与 `plugin/unloaded`；
 * `plugin/changed` **不**在这里 —— 它走主进程 IPC（`bridge.onEvent`，见 initPluginRuntime），
 * 外壳收到后自己触发同步。两件事别混：前者是"给插件听的事件"，后者是"给外壳的指令"。
 *
 * ⚠️ 插件不要直接 import 本模块（客户端 bundle 是单文件 ESM，本来也 import 不了）：
 * 走 `ctx.on` 才能拿到 disposer 托管，否则监听器会跨重载累积。
 */
export const clientPluginEvents = {
  on: (type: string, listener: (payload: unknown) => void) => bus.on(type, listener),
}

// ---------------------------------------------------------------------------
// 插件显示名注册表（导航收纳启动器用）
// ---------------------------------------------------------------------------

/**
 * 插件 id → 显示名（= 清单里的 `aikm.name`）。
 *
 * 槽位条目的 `owner` 只有 `plugin:<id>`（id 是 ASCII 目录名），而启动器卡片要显示
 * 用户看得懂的中文插件名，因此每次同步插件清单时顺手记下这份映射。
 * 挂在模块级 ref 上：插件窗口（独立渲染进程）与主窗口各自的运行时都会填自己那份。
 */
export const pluginDisplayNames = ref<Record<string, string>>({})

/** 从槽位条目的 owner 取插件 id（`plugin:xxx` → `xxx`，非插件条目返回 ''） */
export function pluginIdOfOwner(owner: unknown): string {
  const raw = String(owner ?? '')
  return raw.startsWith('plugin:') ? raw.slice('plugin:'.length) : ''
}

/** 插件显示名（没有记录时回退到 id 本身，便于用户对照插件目录） */
export function pluginDisplayName(id: string): string {
  if (!id) return ''
  return pluginDisplayNames.value[id] || id
}

/**
 * 插件 id → 插件描述（清单里的 `aikm.description`，可能为空）。
 *
 * 启动器网格的卡片用它做副标题：卡片标题是**面板名**，副标题给「这个插件是干什么的」
 * （光重复一遍插件名对用户没有信息量，见 PluginLauncherGrid 的说明）。
 */
export const pluginDescriptions = ref<Record<string, string>>({})

/** 插件描述（没有记录时返回空串，由调用方决定回退文案） */
export function pluginDescription(id: string): string {
  if (!id) return ''
  return pluginDescriptions.value[id] || ''
}

/**
 * 工具名 → 它所在的作用域（`plugin:<插件 id>`）。
 *
 * 为什么要单独一份：「智能体预设 → 工具」页要**在工具名右侧标出它来自哪个插件**
 * （这是用户明确要求的可辨识性），而那里只有工具名、没有 scope。
 * 与 `pluginDisplayNames` 同一时机填充，随插件启停即时更新。
 */
export const pluginToolScopes = ref<Record<string, string>>({})

/**
 * 插件状态表（id → status）与两个计数：启动器面板底部状态栏要显示「共 N 个插件 / 已启用 M 个」。
 *
 * 为什么不用「面板条目数」代替：那是**面板**数量（一个插件可能有多个面板，也可能一个都没有），
 * 与「插件有多少个、启用了几个」是两件事，混着显示会跟插件管理页对不上。
 */
export const pluginStatuses = ref<Record<string, PluginStatus>>({})
/** 已识别的插件总数（含未启用） */
export const pluginTotalCount = computed(() => Object.keys(pluginStatuses.value).length)
/** 已启用的插件数（status === 'active'） */
export const pluginEnabledCount = computed(
  () => Object.values(pluginStatuses.value).filter((s) => s === 'active').length,
)

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
    agent: createPluginAgentApi({
      pluginId: snapshot.id,
      permitted: (snapshot.permissions ?? []).includes('agent.run'),
      log: deps.log,
      bridge: () => getPluginBridge(),
      resolvePreset: resolvePluginAgentPreset,
      listPresets: listPluginAgentPresets,
    }),
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

/**
 * 初始化渲染层插件运行时（入口调用一次；无插件桥时静默降级）。
 *
 * 幂等：`initialized` 在**同步段**里置位（从判断到置位之间没有 await），所以并发/重复调用
 * 都不可能走到第二次订阅 —— 这点上「每窗口一条订阅」是由构造保证的，不需要额外去重。
 *
 * ⚠️ 置位的位置有讲究：以前在 `getPluginBridge()` **之前**置位，于是「桥当时还不可用」
 * 会把整个渲染层插件运行时**永久**卡死（之后桥出现了也不会再初始化）。现在只有真拿到桥才置位，
 * 失败只是本次返回，下次调用仍可重试。
 */
export async function initPluginRuntime(): Promise<void> {
  if (initialized) return
  declareCoreSlots() // 幂等（内部 coreScopes 非空即返回）
  const bridge = getPluginBridge()
  if (!bridge) return
  initialized = true
  // 每**窗口**一条订阅，与插件数量、启停、重载次数无关；它随窗口存活，故有意不保存 unsubscribe。
  // 插件自身的订阅一律经 ctx.on（已由 disposer 托管，见 layoutClientPlugin 里的 track）。
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

  // 0) 插件显示名 / 描述 / 状态（导航收纳启动器要按插件名分组、卡片给出插件用途，
  //    底部状态栏还要显示「共 N 个 / 已启用 M 个」；槽位条目的 owner 只有 id）
  const names: Record<string, string> = {}
  const descs: Record<string, string> = {}
  const statuses: Record<string, PluginStatus> = {}
  for (const p of plugins) {
    names[p.id] = p.name || p.id
    descs[p.id] = p.description || ''
    statuses[p.id] = p.status
  }
  pluginDisplayNames.value = names
  pluginDescriptions.value = descs
  pluginStatuses.value = statuses

  // 1) 插件工具同步（已激活插件的工具 → 智能体可见集）
  //    同时记下「工具名 → 作用域」：预设的工具页要标出每个工具来自哪个插件
  const toolNames: string[] = []
  const declaredToolNames: string[] = []
  const toolScopes: Record<string, string> = {}
  for (const p of plugins) {
    const active = p.status === 'active'
    for (const name of p.tools ?? []) {
      // 作用域与"声明过"对所有列出了工具的插件都记（含未启用/失败的），
      // 这样预设页能显示"来源：X（当前不可用）"，运行时也能把残留名字剔除干净
      toolScopes[String(name)] = `plugin:${p.id}`
      declaredToolNames.push(String(name))
      if (active) toolNames.push(String(name))
    }
  }
  setPluginToolNames(toolNames)
  setPluginDeclaredToolNames(declaredToolNames)
  pluginToolScopes.value = toolScopes

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
  //
  // 先**并发**把入口源码取回来，再按原顺序逐个装载：
  //  - 慢的是 I/O（安卓上要经桥 + 本地服务器读每个插件入口，有的几百 KB），并发取能把这些等待叠起来；
  //  - 而 `apply()` 的顺序必须保持与清单一致（槽位 key 冲突、日志顺序都依赖它），所以只并行"取"不并行"装"。
  const toLoad = wanted.filter((p) => !loaded.has(p.id))
  const prefetched = new Map<string, { bundle?: PluginClientBundle; error?: unknown }>()
  await mapLimit(toLoad, 3, async (p) => {
    try {
      prefetched.set(p.id, { bundle: await bridge.clientBundle(p.id) })
    } catch (e) {
      prefetched.set(p.id, { error: e })
    }
  })
  for (const p of toLoad) {
    if (loaded.has(p.id)) continue
    await loadOne(bridge, p, prefetched.get(p.id))
  }

  slotRegistry.notify()
}

/** 有上限的并发 map（稳定优先：不把桥 / 文件系统一次性打爆） */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        await fn(items[i])
      }
    }),
  )
}

async function loadOne(
  bridge: PluginBridgeApi,
  snapshot: PluginSnapshot,
  prefetched?: { bundle?: PluginClientBundle; error?: unknown },
): Promise<void> {
  const log = createClientLogger(snapshot.id)
  try {
    // 已经并发取回来的 bundle 直接用；没有就现取（单独调用 loadOne 的路径）
    if (prefetched?.error) throw prefetched.error
    const bundle = prefetched?.bundle ?? (await bridge.clientBundle(snapshot.id))
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
