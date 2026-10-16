/**
 * globalVoice.ts — 全局语音输入（**唯一的一份**：一个热键入口 + 一个 ASR 管理器 + 一份状态）
 *
 * 设计要点（对应「所有能输入文字的地方都能语音输入，且只有一个逻辑元素」）：
 *   1. **唯一落点规则**：录音开始时用 resolveVoiceTarget() 认一次「光标现在在哪个可输入元素里」，
 *      本次会话的结果就写进它（voiceTarget.ts 负责判断与写入，各模块不需要任何接入代码）；
 *   2. **唯一识别实例**：整个窗口只有这一个 ASRManager（按 store.AIconfig.asr 建，配置变了自动 update）；
 *   3. **唯一视觉提示**：状态都放在 voiceState 里，由全局挂载一次的 VoiceInputOverlay.vue 渲染
 *      （录音波形 / 实时文字 / 落点 / 结束与取消 / 出错原因，都在那一个浮层里）；
 *   4. **热键语义**（与输入卡片上的麦克风按钮同一套手感）：窗口在前台时按窗口内按键实现
 *      「按住说话、松开结束；短按切换持续收音」；应用在后台时走宿主系统级快捷键
 *      （Electron 的 globalShortcut 探测不到按键弹起，只能是「按一次开始、再按一次结束」）。
 *      两条路径可能同时触发，用时间戳互斥（见 SELF_HANDLED_GUARD_MS）。
 *   5. **落点没了不丢字**：识别结果无法写入（输入框被关掉 / number 输入框 / 焦点在网页里）时
 *      复制到剪贴板并提示，而不是静默丢弃。
 *
 * 谁调用：App.vue 在挂载时 initGlobalVoice(store)，卸载时 disposeGlobalVoice()；
 * 各模块**不需要**注册任何东西，旧的「各模块自己监听热键」的做法已收敛到这里（见 home.vue）。
 */
import { computed, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getPlatform, hasCapability } from '@/platform'
import { formatBinding, matchesKeyboardEvent, normalizeEventKey, parseBinding } from '@/lib/plugin/shortcuts'
// 备选组合与默认值同源（见 src/shared/asrShortcut.ts），别在这里再写一份
import { ASR_SHORTCUT_FALLBACKS } from '@/shared/asrShortcut'
import { createASRManager, type ASRManager } from './manager'
import {
  installVoiceTargetTracking,
  insertVoiceText,
  resetVoiceTargetTracking,
  resolveVoiceTarget,
  type VoiceTarget,
} from './voiceTarget'

/** 会话阶段：空闲 / 正在起录音（加载模型、拿麦克风）/ 收音中 / 识别中 */
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'processing'

/** 全局语音输入的可见状态（浮层只读这一份） */
export const voiceState = reactive({
  phase: 'idle' as VoicePhase,
  /** 本次落点的展示名（浮层显示「正在输入到：搜索框」） */
  targetLabel: '',
  /** 落点是否已锁定（没有落点时结果只能复制到剪贴板） */
  hasTarget: false,
  /** 流式引擎的实时文本（这句话还没落定时显示在浮层里） */
  partial: '',
  /** 浮层里的一次性短提示（如「已输入」）；错误 / 配置缺失一律走 ElMessage，不在浮层显示 */
  notice: '',
  /** 热键的展示形式（浮层里提示用） */
  shortcutDisplay: '',
  /** 没有系统级快捷键能力（网页 / 安卓）→ 只有窗口内那条路径 */
  holdToTalk: false,
  /** 引擎配置自检是否通过（缺配置时不显示悬浮麦克风，避免点了只弹提示） */
  ready: false,
  /** 系统级快捷键注册状态：ok=已注册 / failed=注册失败（多半被别的软件占用）/ unsupported=环境不支持 */
  hostShortcut: 'unknown' as 'unknown' | 'ok' | 'failed' | 'unsupported',
  /** 注册失败的原因（设置页显示） */
  hostShortcutError: '',
  /** 实际生效的加速键（主键注册失败时会退到备选组合，见 SHORTCUT_FALLBACKS） */
  hostShortcutActive: '',
  /** 最近一次热键触发（「系统快捷键 / 窗口按键 + 时间」）——设置页用来排查「按了没反应」 */
  lastTrigger: '',
})

/** 浮层是否显示：录音 / 识别中，或有一条刚产生的一次性提示 */
export const voiceOverlayVisible = computed(() => voiceState.phase !== 'idle' || !!voiceState.notice)

/** 聊天输入框：识别完成后按 asr.autoSend 自动发送时需要的选择器（唯一的「模块约定」，不反向依赖模块） */
const CHAT_COMPOSER_SELECTOR = 'textarea.message-input'

let voiceStore: any = null
let manager: ASRManager | null = null
/** 本次会话锁定的落点（录音开始时确定，中途焦点跑掉也不改） */
let sessionTarget: VoiceTarget | null = null
/** 还在路上的识别结果（含流式引擎「逐句落定」的异步标点校验）：全部写完才算会话结束 */
let pendingDeliveries = 0
/** 引擎是否已经回到空闲（流式引擎会先给文本、随后才 idle） */
let engineIdle = true
let stopConfigWatch: (() => void) | null = null
let noticeTimer: ReturnType<typeof setTimeout> | null = null
let inited = false
/** 刚刚失败（缺配置 / 报错）后的冷却截止时间：这段时间内不再重试，避免按住时提示刷屏 */
let startBlockedUntil = 0

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '')
}

function zh(): boolean {
  return (voiceStore?.locales ?? 'zh') === 'zh'
}

/**
 * 浮层里的一次性短提示（「已输入」这类收尾反馈，几秒后自动收起）。
 * 注意：**错误与配置缺失不走这里**——那些统一用 ElMessage 弹出（见 warnMessage），
 * 浮层只负责「正在录音 / 正在识别」这类状态，不在屏幕下方用红色显示报错。
 */
function flashNotice(text: string, ms = 1800): void {
  voiceState.notice = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    voiceState.notice = ''
    noticeTimer = null
  }, ms)
}

/** 出错 / 缺少配置 / 没有可写入的输入框：统一用 ElMessage 提示 */
function warnMessage(text: string, type: 'warning' | 'info' = 'warning'): void {
  console.warn('[voice]', text)
  ElMessage({ type, duration: 6000, showClose: true, message: text })
}

function clearNotice(): void {
  voiceState.notice = ''
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null }
}

/** 当前配置里的快捷键（主进程 / 窗口内监听共用同一来源） */
function currentShortcut(): string {
  return String(voiceStore?.AIconfig?.asr?.shortcut || '').trim()
}

// ==================== 起录音前的配置自检 ====================

/** 「先在设置里配置 XX」这类提示（按当前语言拼） */
function configGapMessage(what: string): string {
  return zh()
    ? `请先在「设置 → 语音 → 输入」中配置${what}，再使用语音输入`
    : `Configure ${what} under Settings → Voice → ASR before using voice input`
}

/**
 * 明显没配置就别起录音：直接一条 ElMessage 说清缺什么。
 * 为什么要在起录音前拦一道：引擎自己的报错是**异步**的（会话已经进入「正在启动…」浮层后才抛），
 * 按住快捷键时 Windows 会反复触发宿主快捷键，结果是浮层闪一下又消失、提示反复弹。
 */
function asrConfigGap(): string {
  const asr = voiceStore?.AIconfig?.asr
  if (!asr?.type) return configGapMessage(zh() ? '语音识别引擎' : 'a speech recognition engine')
  switch (asr.type) {
    case 'onnx-whisper':
      return asr.onnx?.modelPath ? '' : configGapMessage(zh() ? 'ONNX Whisper 模型文件' : 'the ONNX Whisper model file')
    case 'funasr-online':
      return asr.funasr?.dir ? '' : configGapMessage(zh() ? 'FunASR 模型目录' : 'the FunASR model folder')
    case 'qwen3-asr':
      return asr.qwen3?.url ? '' : configGapMessage(zh() ? 'Qwen3-ASR 服务地址' : 'the Qwen3-ASR service URL')
    case 'whisper-api':
      return asr.whisper?.url ? '' : configGapMessage(zh() ? 'Whisper API 地址' : 'the Whisper API URL')
    // Whisper 本地（Python）依赖本机 Python 环境，没有可预检的字段，交给引擎自己报错
    default:
      return ''
  }
}

// ==================== 识别结果 → 落点 ====================

/**
 * 自动发送：与旧行为一致（语音输入设置里的 autoSend），只有落点是聊天输入框时才发。
 * 这里用 Enter 键事件触发，而不是直接调用聊天模块的 sendMessage —— 保持「全局只有一个逻辑元素」，
 * 不反向依赖任何模块内部函数。
 * 注意：落点要在 await 之前传进来（结束会话时状态会被复位，不能再读全局变量）。
 */
function maybeAutoSend(target: VoiceTarget | null): void {
  if (!voiceStore?.AIconfig?.asr?.autoSend) return
  const el = target?.kind === 'dom' ? (target.el as HTMLElement) : null
  if (!el || !el.matches?.(CHAT_COMPOSER_SELECTOR)) return
  // 等输入事件落地（v-model 已更新草稿）再触发发送
  setTimeout(() => {
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: false, cancelable: true }))
    } catch { /* 触发失败不影响已写入的文本 */ }
  }, 120)
}

/** 落点写不进去时的兜底：复制到剪贴板，用户可自行粘贴（例如焦点在浏览器 Agent 的网页里） */
async function fallbackToClipboard(text: string): Promise<void> {
  let copied = false
  try {
    // 加超时：剪贴板权限弹窗挂住时不能把「结果记账」也一起挂住（否则浮层会一直停在识别中）
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1500)),
    ])
    copied = true
  } catch { copied = false }
  const msg = copied
    ? (zh() ? '没有可写入的输入框，识别结果已复制到剪贴板' : 'No input field to type into — the result was copied to the clipboard')
    : (zh() ? '没有可写入的输入框，识别结果已丢弃' : 'No input field to type into — the result was dropped')
  warnMessage(msg, copied ? 'info' : 'warning')
}

/** 一句最终结果：写进锁定的落点（流式引擎会连续来多句，逐句接着写） */
async function deliverFinal(text: string): Promise<void> {
  // 先抓住落点：结束会话时 onStatusChange('idle') 会复位 sessionTarget，
  // 而本次写入是异步的（monaco 分支还要等动态 import），不能等到 await 之后再读全局变量
  const target = sessionTarget
  const ok = target ? await insertVoiceText(target, text) : false
  if (!ok) { await fallbackToClipboard(text); return }
  // 写完给一个短促的「已输入」收尾提示：结束后浮层不会无声消失
  flashNotice(zh() ? '已输入' : 'Typed')
  maybeAutoSend(target)
}

// ==================== ASR 管理器（唯一实例） ====================

/** 结束会话：复位全部会话态（浮层随之收起） */
function finishSession(): void {
  voiceState.phase = 'idle'
  voiceState.partial = ''
  sessionTarget = null
  voiceState.hasTarget = false
}

function ensureManager(): ASRManager | null {
  if (manager) return manager
  if (!voiceStore?.AIconfig?.asr) return null
  manager = createASRManager(voiceStore.AIconfig.asr, {
    onResult: (result: { text: string; isFinal: boolean }) => {
      if (!result?.isFinal) {
        voiceState.partial = result?.text || ''
        return
      }
      voiceState.partial = ''
      if (!result.text) return
      // 结果在写入前先记账：流式引擎会「先给文本、随后才 idle」，
      // 标点校验（local/llm）又是异步的——只要还有结果在路上，浮层就不能消失，
      // 否则会出现「面板没了、字还在往里打」的迷惑现象
      pendingDeliveries++
      void deliverFinal(result.text).finally(() => {
        pendingDeliveries--
        if (engineIdle && pendingDeliveries === 0) finishSession()
      })
    },
    onStatusChange: (status: string) => {
      if (status === 'listening') {
        engineIdle = false
        voiceState.phase = 'listening'
      } else if (status === 'processing') {
        engineIdle = false
        voiceState.phase = 'processing'
      } else if (status === 'idle') {
        engineIdle = true
        // 还有结果没落地 → 继续显示「识别中…」，等它们写完再收起
        if (pendingDeliveries === 0) finishSession()
        else voiceState.phase = 'processing'
      } else if (status === 'error') {
        engineIdle = true
        finishSession()
      }
    },
    onError: (error: string) => {
      engineIdle = true
      finishSession()
      // 失败后短暂冷却：按住快捷键时宿主会反复触发，不冷却就会「会话闪一下 + 提示刷屏」
      startBlockedUntil = Date.now() + START_COOLDOWN_MS
      warnMessage(error)
    },
  })
  return manager
}

// ==================== 会话控制 ====================

/** 开始一次语音输入：锁定当前焦点落点 → 起录音（识别结果写进那个元素） */
export async function startVoice(): Promise<void> {
  if (!inited) return
  if (voiceState.phase !== 'idle') return
  // 刚失败过（缺配置 / 报错）→ 冷却期内直接忽略：按住快捷键时宿主会反复触发，
  // 不拦一道就会「浮层闪一下又消失 + 同一条提示反复弹」
  if (Date.now() < startBlockedUntil) return
  // 明显没配置就到此为止：一条 ElMessage 说清缺什么，不进入会话（浮层也就不会闪）
  const gap = asrConfigGap()
  if (gap) {
    startBlockedUntil = Date.now() + START_COOLDOWN_MS
    warnMessage(gap)
    return
  }
  clearNotice()
  sessionTarget = resolveVoiceTarget(zh())
  voiceState.hasTarget = !!sessionTarget
  voiceState.targetLabel = sessionTarget?.label || (zh() ? '未找到输入框' : 'No input field')
  voiceState.partial = ''
  voiceState.phase = 'starting'
  engineIdle = false
  const mgr = ensureManager()
  if (!mgr) {
    voiceState.phase = 'idle'
    startBlockedUntil = Date.now() + START_COOLDOWN_MS
    warnMessage(zh()
      ? '请先在「设置 → 语音 → 输入」中配置语音识别引擎，再使用语音输入'
      : 'Configure a speech recognition engine under Settings → Voice → ASR before using voice input')
    return
  }
  try {
    // 预热采集图（不加载模型）：首次录音也能立即开始，避免开头丢字
    mgr.warmup?.().catch(() => { /* 失败静默，start() 里会重试 */ })
    mgr.start()
  } catch (e: any) {
    voiceState.phase = 'idle'
    startBlockedUntil = Date.now() + START_COOLDOWN_MS
    warnMessage(String(e?.message || e))
  }
}

/** 结束一次语音输入：交给引擎出最终文本（写完浮层自动收起） */
export async function stopVoice(): Promise<void> {
  if (voiceState.phase === 'idle') return
  voiceState.phase = 'processing'
  try {
    await manager?.stop()
  } catch (e: any) {
    warnMessage(String(e?.message || e))
  } finally {
    // 兜底复位：管理器在「识别器还没建起来」时 stop() 会直接返回、不发 idle 状态，
    // 不复位的话浮层会一直停在「识别中…」，且热键也切不回来。
    // 注意：**还有结果在路上时不能收起**（异步标点校验会稍后才把句子写进来）。
    // （断言：await 期间识别器回调可能已经改过 phase，TS 不会跟踪这种异步改写）
    if ((voiceState.phase as VoicePhase) !== 'idle') {
      engineIdle = true
      if (pendingDeliveries > 0) voiceState.phase = 'processing'
      else finishSession()
    }
  }
}

/** 放弃本次语音输入：丢弃音频，不产生文本 */
export function cancelVoice(): void {
  if (voiceState.phase === 'idle') return
  try { manager?.abort?.() } catch { /* 忽略 */ }
  engineIdle = true
  finishSession()
}

/** 热键的一次触发：录音中 → 结束；空闲 → 开始（桌面系统级快捷键只有「按下」，无法探测弹起） */
export async function toggleVoice(): Promise<void> {
  if (voiceState.phase === 'idle') await startVoice()
  else await stopVoice()
}

// ==================== 热键接入 ====================

/** 与输入卡片上的麦克风按钮同一套手感：短按 = 切换持续收音，长按 = 按住说话（松开结束） */
const SHORT_PRESS_MS = 300
/** 窗口自己处理过按键后的这段时间内，忽略宿主送来的切换事件（两者可能同时到达，避免互相打断） */
const SELF_HANDLED_GUARD_MS = 600
/**
 * 两次宿主事件间隔小于这个值 = 同一次按住（不是新的一次按下）。
 *
 * 为什么必须这样判：Windows 上**按住快捷键不放时，Electron 的 globalShortcut 会按键盘自动重复
 * 不停触发回调**（见 electron/electron#39718，macOS 无此问题）。如果不合并，
 * 「按住说话」会变成每秒几十次的开始/结束切换 → 提示浮层疯狂闪烁、配置报错反复弹。
 * 键盘自动重复的间隔只有几十毫秒，而人手两次按键的间隔不可能小于这个值，所以能区分开。
 */
const HOST_REPEAT_MS = 900
/** 失败（缺配置 / 报错）后的冷却时间：这段时间内不再重试，避免按住时提示刷屏 */
const START_COOLDOWN_MS = 1500
/** 主快捷键被别的软件占用时的备选组合（按顺序尝试，第一个可用的生效） */
const SHORTCUT_FALLBACKS = ASR_SHORTCUT_FALLBACKS

let windowPressAt = 0
let windowPressWasActive = false
let lastSelfHandledAt = 0
let lastHostAt = 0

function shortcutBinding() {
  return parseBinding(currentShortcut(), isMacPlatform())
}

/** 按下：组合键要完全匹配（多按一个修饰键不算） */
function matchesShortcutDown(e: KeyboardEvent): boolean {
  const parsed = shortcutBinding()
  return !!parsed && matchesKeyboardEvent(parsed, e)
}

/** 弹起：只比对主键（松手时修饰键通常已经先松开） */
function matchesShortcutKey(e: KeyboardEvent): boolean {
  const parsed = shortcutBinding()
  return !!parsed && normalizeEventKey(e) === parsed.key
}

/**
 * 窗口内按键（捕获阶段：任何输入控件 stopPropagation 之前先拿到）：
 *   · 网页 / 安卓没有系统级快捷键，完全靠这里；
 *   · 桌面窗口在前台时也走这里（于是「按住说话、松开结束」在桌面上同样成立），
 *     后台时按键交给宿主系统级快捷键（见 onHostHotkey）。
 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.repeat) return
  // Esc：录音中放弃本次输入（只在会话进行时拦截，不影响弹窗等既有 Esc 行为）
  if (e.key === 'Escape' && voiceState.phase !== 'idle') {
    e.preventDefault()
    e.stopPropagation()
    cancelVoice()
    return
  }
  if (!matchesShortcutDown(e)) return
  e.preventDefault()
  lastSelfHandledAt = Date.now()
  windowPressAt = Date.now()
  windowPressWasActive = voiceState.phase !== 'idle'
  voiceState.lastTrigger = `${zh() ? '窗口按键' : 'window key'} ${new Date().toLocaleTimeString()}`
  if (!windowPressWasActive) void startVoice()
}

function onWindowKeyup(e: KeyboardEvent): void {
  if (!matchesShortcutKey(e)) return
  const pressAt = windowPressAt
  windowPressAt = 0
  if (voiceState.phase === 'idle') return
  // 短按且按下前没在录 → 视为「单击切换」：松开后继续收音（再按一次才结束）
  // 其余情况（长按松手 / 短按结束持续收音）都结束本次输入
  if (pressAt && Date.now() - pressAt < SHORT_PRESS_MS && !windowPressWasActive) return
  void stopVoice()
}

/**
 * 宿主系统级快捷键（桌面：应用在后台时唯一可用的一条路径）。
 *
 * 两条过滤，缺一不可：
 *   ① 窗口内刚刚自己处理过这次按键（前台时窗口监听能识别「按住 / 松开」，比这里准）→ 忽略；
 *   ② 与上一次宿主事件间隔过短 → 认定为「同一次按住」的键盘自动重复，忽略。
 */
function onHostHotkey(): void {
  const now = Date.now()
  const repeated = lastHostAt > 0 && now - lastHostAt < HOST_REPEAT_MS
  lastHostAt = now
  if (repeated) return
  if (lastSelfHandledAt && now - lastSelfHandledAt < SELF_HANDLED_GUARD_MS) return
  voiceState.lastTrigger = `${zh() ? '系统快捷键' : 'global shortcut'} ${new Date().toLocaleTimeString()}`
  void toggleVoice()
}

/**
 * 把当前快捷键注册到宿主，并同步浮层需要的展示形式。
 *
 * **两条路径同时保留，互相兜底**（踩过坑：只留一条时，任何一边不成立就整个不可用）：
 *   · 宿主系统级快捷键：应用在后台也能用。代价是 Windows 上按住会随键盘自动重复反复触发，
 *     只能靠 onHostHotkey 的时间过滤把「同一次按住」合并掉；
 *   · 窗口内按键：窗口在前台时能精确识别「按住 / 松开」。
 * 两者可能对同一次按下都做出反应 → 用 lastSelfHandledAt / HOST_REPEAT_MS 去重：
 * 谁先到都不影响结果（先到者开始，后到者被忽略；松手由窗口内那条负责结束）。
 */
async function syncShortcut(): Promise<void> {
  const shortcut = currentShortcut()
  voiceState.shortcutDisplay = shortcut ? formatBinding(shortcut, isMacPlatform()) : ''
  voiceState.holdToTalk = !hasCapability('shell.globalShortcut')
  voiceState.ready = !asrConfigGap()
  if (!hasCapability('shell.globalShortcut')) {
    voiceState.hostShortcut = 'unsupported'
    voiceState.hostShortcutError = ''
    return
  }
  if (!shortcut) {
    voiceState.hostShortcut = 'failed'
    voiceState.hostShortcutError = zh() ? '没有设置快捷键' : 'no shortcut configured'
    return
  }
  let res = await tryRegisterShortcut(shortcut)
  let used = shortcut
  // 主键被别的软件占用（或系统不允许）时自动退到备选组合：至少保证「按了有反应」，
  // 并把实际生效的组合告诉用户（设置页也一直显示着）
  if (!res.ok) {
    for (const alt of SHORTCUT_FALLBACKS) {
      if (alt === shortcut) continue
      const r = await tryRegisterShortcut(alt)
      if (r.ok) { res = r; used = alt; break }
    }
  }
  if (res.ok) {
    voiceState.hostShortcut = 'ok'
    voiceState.hostShortcutError = ''
    voiceState.hostShortcutActive = used
    if (used !== shortcut) {
      // ⚠️ 先说清「主键失败」再报当前生效的是哪一组 —— 提示里必须**同时**给出两组：
      // 只写「已临时改用 X」时，用户从消息里根本看不出原来那组为什么没生效（曾以为是逻辑错）。
      warnOnce(`fallback:${shortcut}`, zh()
        ? `快捷键 ${formatBinding(shortcut, isMacPlatform())} 被其它软件占用，暂时改用 ${formatBinding(used, isMacPlatform())}（可在「设置 → 语音 → 输入」里自己换一组）`
        : `${formatBinding(shortcut, isMacPlatform())} is taken by another app — temporarily using ${formatBinding(used, isMacPlatform())} (change it under Settings → Voice → ASR)`)
    }
    return
  }
  // 连备选都没注册上：**不要**说「已临时改用」（那会让人以为能用）。把主键的失败原因报出来。
  voiceState.hostShortcut = 'failed'
  voiceState.hostShortcutError = res.error || (zh() ? '注册失败' : 'registration failed')
  voiceState.hostShortcutActive = ''
  warnOnce(`failed:${shortcut}`, zh()
    ? `快捷键 ${formatBinding(shortcut, isMacPlatform())} 注册失败（备选组合也不可用）：${voiceState.hostShortcutError}。请在「设置 → 语音 → 输入」里换一组，或点「清空」改用右下角的悬浮麦克风。`
    : `Could not register ${formatBinding(shortcut, isMacPlatform())} (fallbacks unavailable too): ${voiceState.hostShortcutError}. Pick another combination under Settings → Voice → ASR, or clear it and use the floating mic at the bottom-right.`)
}

async function tryRegisterShortcut(accel: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await getPlatform().shell.registerShortcut(accel)
    return { ok: !!res?.success, error: res?.error }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** 同一件事只提示一次（按 key 去重）：注册失败 / 回退组合不该每次配置变化都弹一遍 */
const warnedOnce = new Set<string>()
function warnOnce(key: string, text: string): void {
  if (warnedOnce.has(key)) return
  warnedOnce.add(key)
  warnMessage(text)
}

/** 供设置页手动重试注册（注册失败后改了别的软件占用情况时可点一下） */
export function retryVoiceShortcut(): void {
  warnedOnce.clear()
  void syncShortcut()
}

/**
 * 全局快捷键监听挂在 window / ipcRenderer 上；HMR（开发时改代码）或重复初始化会留下上一份监听，
 * 而新加载的模块实例拿不到旧闭包、摘不掉它们——结果就是「两套监听打架」或「旧的把新的事件吃掉」。
 * 这里把句柄挂在 window 上，每次安装前先摘掉上一份，做到幂等。
 */
const HOTKEY_MARK = '__aikmVoiceHotkey'
type HotkeyInstall = { down: typeof onWindowKeydown; up: typeof onWindowKeyup; unsub: (() => void) | null }

function installHotkeyListeners(): void {
  const w = window as any
  const prev = w[HOTKEY_MARK] as HotkeyInstall | undefined
  if (prev) {
    try { prev.unsub?.() } catch { /* 旧的退订失败不影响装机 */ }
    window.removeEventListener('keydown', prev.down, true)
    window.removeEventListener('keyup', prev.up, true)
  }
  // 两条路径都装（互相兜底）：宿主系统级快捷键 + 窗口内按键
  const unsub = hasCapability('shell.globalShortcut')
    ? getPlatform().events.on('asr-shortcut-toggle', onHostHotkey)
    : null
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('keyup', onWindowKeyup, true)
  w[HOTKEY_MARK] = { down: onWindowKeydown, up: onWindowKeyup, unsub }
}

function removeHotkeyListeners(): void {
  const w = window as any
  const cur = w[HOTKEY_MARK] as HotkeyInstall | undefined
  if (!cur) return
  try { cur.unsub?.() } catch { /* 忽略 */ }
  window.removeEventListener('keydown', cur.down, true)
  window.removeEventListener('keyup', cur.up, true)
  delete w[HOTKEY_MARK]
}

// ==================== 生命周期 ====================

/**
 * 初始化（App.vue 挂载时调用一次；独立窗口各自初始化，主进程会把热键投给**当前聚焦的那个窗口**）。
 * 幂等：重复调用只更新 store、重装一次监听（先摘旧的）、重新同步快捷键。
 */
export function initGlobalVoice(storeInstance: any): void {
  voiceStore = storeInstance
  installVoiceTargetTracking()
  installHotkeyListeners()
  if (!inited) {
    inited = true
    // 设置里改了快捷键 / 引擎参数：立刻生效（不需要重启）
    stopConfigWatch = watch(
      () => JSON.stringify(storeInstance?.AIconfig?.asr || {}),
      (_json, prev) => {
        if (prev === undefined) return // 首次只建立基线
        manager?.updateConfig?.(storeInstance.AIconfig.asr)
        void syncShortcut()
      },
    )
  }
  void syncShortcut()
}

/** 释放（组件卸载 / 应用退出）：拆监听、销毁麦克风采集图 */
export function disposeGlobalVoice(): void {
  removeHotkeyListeners()
  stopConfigWatch?.()
  stopConfigWatch = null
  // 刻意不注销宿主快捷键：快捷键注册在**主进程**（整个应用一份），
  // 而本函数可能因为某个窗口（设置 / 文件窗口）关闭而被调用——那样会把主窗口的热键一起注销掉。
  // 主进程随应用退出自然回收，改键走 syncShortcut() 的先注销再注册。
  manager?.destroy()
  manager = null
  sessionTarget = null
  pendingDeliveries = 0
  engineIdle = true
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null }
  voiceState.phase = 'idle'
  voiceState.partial = ''
  voiceState.notice = ''
  resetVoiceTargetTracking()
  inited = false
}
