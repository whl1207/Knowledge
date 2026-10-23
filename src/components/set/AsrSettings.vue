<!-- AsrSettings.vue - 语音输入（ASR）设置（从 Set.vue 拆分出的独立组件，样式自带，与设置页一致） -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'
// 语音输入默认快捷键的唯一来源（迁移/备选同源，见 src/shared/asrShortcut.ts）
import { DEFAULT_ASR_SHORTCUT } from '@/shared/asrShortcut'
import { getPlatform, hasCapability } from '@/platform'
// 全局语音输入的运行状态（热键注册形式 / 引擎自检 / 最近一次触发）——用于本页的排查行
import { voiceState, retryVoiceShortcut } from '@/services/asr/globalVoice'

const store = usestore()

// ================ Qwen3-ASR 模型预设 ================
// 常用模型下拉选项；非预设值（自定义/云端模型名）自动落到「自定义」输入框
const qwen3ModelPresets = [
  { label: 'Qwen3-ASR-1.7B（高质量）', value: 'Qwen/Qwen3-ASR-1.7B' },
  { label: 'Qwen3-ASR-0.6B（快速）', value: 'Qwen/Qwen3-ASR-0.6B' },
  { label: 'Qwen3-ASR-1.7B-hf（Transformers 原生）', value: 'Qwen/Qwen3-ASR-1.7B-hf' },
  { label: 'Qwen3-ASR-0.6B-hf（Transformers 原生）', value: 'Qwen/Qwen3-ASR-0.6B-hf' },
]
// 用户是否切到「自定义」（避免选了自定义又因 model 值仍在预设里被弹回）
const qwen3ModelIsCustom = ref(false)
// 下拉当前值：预设命中返回其 value，否则为自定义占位
const qwen3ModelPreset = computed({
  get: () => {
    if (qwen3ModelIsCustom.value) return '__custom__'
    const v = store.AIconfig.asr.qwen3.model
    return qwen3ModelPresets.some(p => p.value === v) ? v : '__custom__'
  },
  set: (val: string) => {
    if (val === '__custom__') {
      qwen3ModelIsCustom.value = true
      return // 切到自定义：保留当前值，由下方输入框编辑
    }
    qwen3ModelIsCustom.value = false
    store.AIconfig.asr.qwen3.model = val
    store.saveConfig()
  }
})
// 是否为自定义模型名（不在预设列表内）
const isQwen3CustomModel = computed(() => {
  if (qwen3ModelIsCustom.value) return true
  return !qwen3ModelPresets.some(p => p.value === store.AIconfig.asr.qwen3.model)
})

// Qwen3-ASR 实际生效的协议：auto 时按地址判断（指向 .../audio/transcriptions 用 OpenAI 兼容，否则用 Gradio 网页服务）
const qwen3Protocol = computed<'gradio' | 'openai'>(() => {
  const q = store.AIconfig.asr.qwen3
  const p = q.protocol || 'auto'
  if (p === 'gradio' || p === 'openai') return p
  const url = (q.url || '').trim()
  if (!url) return 'gradio'
  try {
    const fixed = /^https?:\/\//i.test(url) ? url : `http://${url}`
    const path = new URL(fixed).pathname.replace(/\/+$/, '')
    return /\/audio\/transcriptions$/.test(path) ? 'openai' : 'gradio'
  } catch {
    return 'gradio'
  }
})

// 是否启用「分段准流式」：仅 Gradio 网页服务支持（OpenAI 兼容端点没有 /run 接口）
const qwen3Segment = computed(() => qwen3Protocol.value === 'gradio' && store.AIconfig.asr.qwen3.mode === 'segment')

// 单段最长：设置页按「秒」录入（5~180s = 上限 3 分钟），存储统一用毫秒
const qwen3MaxSegmentSec = computed({
  get: () => Math.round((store.AIconfig.asr.qwen3.maxSegmentMs ?? 15000) / 1000),
  set: (val: number) => {
    const n = Number(val)
    const sec = isFinite(n) ? Math.min(180, Math.max(5, Math.round(n))) : 15
    store.AIconfig.asr.qwen3.maxSegmentMs = sec * 1000
  }
})

// ================ ASR 语音输入相关代码 ================

// ASR 测试状态
const asrTesting = ref(false)
const asrTestResult = ref('')
const asrTestError = ref('')
let asrTestManager: any = null
// 记录上次测试使用的引擎类型：切换引擎时才重建管理器（复用 + 预热可避免开头语音丢失）
let asrTestManagerType = ''

// 初始化 ASR 测试管理器（复用 + 预热音频采集图，避免每次测试重建导致开头几秒丢失）
async function initASRTestManager() {
  const type = store.AIconfig.asr.type
  // 引擎类型变化时才销毁重建
  if (asrTestManager && asrTestManagerType !== type) {
    try { asrTestManager.destroy() } catch (e) { /* ignore */ }
    asrTestManager = null
  }
  asrTestManagerType = type
  // 已存在则直接预热复用
  if (asrTestManager) {
    asrTestManager.warmup?.().catch(() => {})
    return
  }
  // 延迟导入，避免循环依赖
  const { createASRManager } = await import('@/services/asr/manager')
  if (asrTestManager) return // 已被后续调用创建
  asrTestManager = createASRManager(store.AIconfig.asr, {
    onResult: (result: any) => {
      if (result.isFinal) {
        asrTestResult.value += result.text
      } else {
        // 流式 partial（funasr-online）：实时覆盖显示
        asrTestResult.value = result.text
      }
    },
    onStatusChange: (status: string) => {
      if (status === 'error') {
        asrTesting.value = false
      }
    },
    onError: (error: string) => {
      asrTestError.value = error
      asrTesting.value = false
    }
  })
  // 预热音频采集图（不加载模型）：让按住说话的录音立即开始
  await asrTestManager.warmup?.().catch(() => {})
}

// 开始 ASR 测试：等管理器就绪再开录（首次使用需动态加载模块，避免按下了却没开始录音）
async function startASRTest() {
  asrTestResult.value = ''
  asrTestError.value = ''
  asrTesting.value = true
  try {
    await initASRTestManager()
  } catch (e: any) {
    asrTestError.value = String(e?.message || e)
    asrTesting.value = false
    return
  }
  // 初始化期间用户已松手：不再开录
  if (!asrTesting.value) return
  asrTestManager?.start()
}

// 停止 ASR 测试
async function stopASRTest() {
  if (!asrTesting.value) return
  asrTesting.value = false
  if (asrTestManager) {
    const text = await asrTestManager.stop()
    // 流式引擎（funasr-online / Qwen3-ASR 分段）：分段文本已由 onResult 实时追加，
    // stop() 只返回最后一段 → 这里追加而不是覆盖，否则会丢掉前面已显示的句子
    if (text && !asrTestResult.value.endsWith(text)) {
      asrTestResult.value += text
    }
  }
}

// 清除 ASR 测试结果
function clearASRTestResult() {
  asrTestResult.value = ''
  asrTestError.value = ''
}

// ================ FunASR 流式 Paraformer（funasr-online 引擎） ================
async function pickFunasrModelDir() {
  if (!hasCapability('dialog.native')) return
  const d = await getPlatform().dialog.pickDirectory()
  if (d) {
    store.AIconfig.asr.funasr.dir = d
    store.saveConfig()
  }
}

async function selectFunasrRefine() {
  if (!hasCapability('dialog.native')) return
  const f = await getPlatform().dialog.pickFile({
    filters: [
      { name: 'ONNX Model', extensions: ['onnx'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (f) {
    store.AIconfig.asr.funasr.refineModel = f
    store.saveConfig()
  }
}

// 选择官方 ct-punc（标点恢复）本地模型目录（全局标点目录）
async function selectAsrPuncDir() {
  if (!hasCapability('dialog.native')) return
  const d = await getPlatform().dialog.pickDirectory()
  if (d) {
    store.AIconfig.asr.puncDir = d
    store.saveConfig()
  }
}

// 捕获快捷键
function captureShortcut(event: KeyboardEvent) {
  event.preventDefault()
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Win')
  
  // 排除单独按修饰键
  const key = event.key
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
    return
  }
  
  if (key) {
    // 格式化键名
    let formattedKey = key
    if (key === ' ') formattedKey = 'Space'
    else if (key.length === 1) formattedKey = key.toUpperCase()
    else formattedKey = key.charAt(0).toUpperCase() + key.slice(1)
    
    parts.push(formattedKey)
  }
  
  if (parts.length > 0) {
    store.AIconfig.asr.shortcut = parts.join('+')
    store.saveConfig()
    // 注册由全局语音输入按焦点负责（见文件末尾说明），这里不直接调宿主
  }
}

// 重置快捷键（与 store 里的默认值、globalVoice 的备选组合保持一致）
function resetShortcut() {
  store.AIconfig.asr.shortcut = DEFAULT_ASR_SHORTCUT
  store.saveConfig()
  // 同上：注册由全局语音输入按焦点负责
}

/**
 * 清空快捷键 = **不用系统级快捷键**（只保留悬浮麦克风）。
 *
 * 为什么必须有这一条：有些机器上「Ctrl+Shift+Space」这类组合会被别的软件或输入法占着，
 * 注册永远失败，而原来的行为是「失败 → 自动退到备选 → 一直提示」，用户既关不掉也换不了。
 * 清空后 `syncShortcut` 直接走「未设置」分支，不再注册、也不再提示。
 */
function clearShortcut() {
  store.AIconfig.asr.shortcut = ''
  store.saveConfig()
}

/** 悬浮麦克风开关（关掉后可用同一处重新打开） */
function setFloatButton(on: boolean) {
  store.AIconfig.asr.floatButton = on
  store.saveConfig()
}

/** 系统级听写开关（关闭后快捷键只在应用内生效） */
function setSystemWide(on: boolean) {
  store.AIconfig.asr.systemWide = on
  store.saveConfig()
}

/** 系统级听写的宿主能力（Windows PowerShell / Linux xdotool·wtype） */
const systemStatus = ref<{ supported: boolean; backend?: string; error?: string } | null>(null)
const systemStatusLoading = ref(false)
async function refreshSystemStatus() {
  if (systemStatusLoading.value) return
  systemStatusLoading.value = true
  try {
    systemStatus.value = await getPlatform().shell.systemDictationStatus()
  } catch (e: any) {
    systemStatus.value = { supported: false, error: String(e?.message || e) }
  } finally {
    systemStatusLoading.value = false
  }
}

/**
 * 提示文字统一放 title：面板里只保留「左侧 label + 右侧控件」，
 * 不再用整段说明把行高撑开（与语音合成页的紧凑布局一致）。
 */
const hints = computed(() => {
  const zh = store.locales === 'zh'
  return {
    shortcut: zh
      ? '默认 CapsLock：按住说话，短按仍然是系统的大小写切换。也可以改成带功能键的组合；Ctrl+Alt+* 在 Windows 上会与输入法冲突。长按模式不会注册系统热键，因此不会吞掉按键本身的功能。'
      : 'Default is CapsLock: hold to dictate, while a short press still toggles Caps Lock. You can also use a function-key combination; Ctrl+Alt+* conflicts with IMEs on Windows. Hold mode does not register a system hotkey, so the key keeps its normal behaviour.',
    systemWide: zh
      ? '开启后，应用在后台时也可以按快捷键说话，识别结果会粘贴到当前前台应用；关闭后快捷键只在应用窗口内生效。需要 Windows PowerShell，或 Linux 的 xdotool / wtype。'
      : 'When enabled, the shortcut works while the app is in the background and the result is pasted into the active app; when off, the shortcut only works inside this app. Requires Windows PowerShell, or xdotool / wtype on Linux.',
    inputMode: zh
      ? '单点开关：按一次开始、再按一次结束。长按说话：按住快捷键说话、松开即结束（更接近对讲机，需要全局按键抬起监听）。'
      : 'Toggle: press once to start, press again to finish. Hold: hold the shortcut while speaking and release to finish (walkie-talkie style; requires global key-up listening).',
    clipboard: zh
      ? '粘贴完成后恢复剪贴板原内容；关闭则把识别文字留在剪贴板，方便手动粘贴。'
      : 'Restore the previous clipboard contents after pasting; turn this off to leave the recognized text on the clipboard for manual pasting.',
    floatButton: zh
      ? '在右下角显示可拖动的悬浮麦克风，点一下开始 / 结束语音输入；关闭后仍可使用快捷键。'
      : 'Show the draggable floating mic in the bottom-right corner (click to start / stop dictation); the shortcut still works when hidden.',
    qwenSegment: zh
      ? '流式（分段准实时）：按住说话时，一停顿超过「停顿切段」就把这一段送去识别，文字边说边出；一直不停顿则到「单段最长」（上限 3 分钟）强切。切点保留「切点重叠」音频，避免切在字中间丢音。注意：该模型本身是整段模型，所以是「说完一句、停顿后约 0.5~1.5 秒出字」，不是逐字上屏；停顿设得太短会切断长句。'
      : 'Streaming (segmented): while you hold, each pause longer than “Cut on pause” sends that segment for recognition, so text appears as you speak; without pauses it force-cuts at “Max segment length” (up to 3 min). “Cut overlap” keeps audio around each cut point so no syllable is lost. The model itself is offline/whole-utterance, so expect text ~0.5–1.5s after each pause, not per-character streaming; too-short pauses will split long sentences.',
    qwenEndpoint: zh
      ? 'Qwen3-ASR 本地网页服务默认地址 http://127.0.0.1:7867（按手册 /run 接口调用：自动上传音频并取回识别文本，支持 30 种语言 + 22 种方言与自动语种识别）。若使用 vLLM / Docker 部署的 OpenAI 兼容服务，地址填 http://localhost:8000/v1/audio/transcriptions 并选「OpenAI 兼容」（仅支持整段识别）。'
      : 'Qwen3-ASR local web UI default URL is http://127.0.0.1:7867 (called through the documented /run API: audio is uploaded and the recognized text is returned; supports 30 languages + 22 Chinese dialects with auto language ID). For a vLLM/Docker OpenAI-compatible server, set the URL to http://localhost:8000/v1/audio/transcriptions and pick "OpenAI-compatible" (whole-utterance only).',
    funasrPunct: zh
      ? '仅在「标点校验模式=大模型」时生效：原文先实时显示，攒够此字数后由大模型一次性补标点并整体替换；0=关闭批处理（每句都校验）。“普通校验（本地标点模型）”不受此限制，句子落定即即时补标点。'
      : 'Only applies when Punctuation Mode = LLM: show raw text live, then batch-punctuate once this many chars accumulate; 0 = per-sentence. Local ct-punc (Normal mode) punctuates every committed sentence immediately regardless of this value.',
    funasrGuide: zh
      ? 'FunASR 官方流式 Paraformer（online）：按住说话实时出字，松开出完整文本。首次使用会加载 ~230MB 双模型；下方「按住说话测试」可边听边验证。开启自动断句后，说完一句停顿约 0.9s 会自动落一句；如配置离线精修模型，松开时会对最后一句做整段二次识别替换。'
      : 'FunASR official streaming Paraformer (online). First use loads ~230MB models; try the "Hold to Test" button below. With auto-VAD, pausing ~0.9s commits a sentence and keeps listening; if an offline refine model is set, the last utterance is re-recognized on release (2-pass).',
    punctLocal: zh
      ? '普通校验 = 本地 ct-punc（CT-Transformer 标点恢复）模型：识别完成后离线补标点，无需联网与大模型，对任意识别引擎生效。'
      : 'Normal = local ct-punc (CT-Transformer) model: punctuate offline after recognition, works with any ASR engine, no network/LLM needed.',
    punctLlm: zh
      ? '大模型校验会对识别文字做错字修正并补全标点；开启后 funasr-online 可用下方“批处理标点阈值”节流（攒够字数一次性处理）。'
      : 'LLM mode also fixes misheard characters. With funasr-online you can use the batch punct threshold below to process text in batches.',
  }
})

/**
 * 状态行里的快捷键部分：把「系统级快捷键是否注册成功 / 实际生效的是哪一组」说清楚。
 * 「按了没反应」时这一行就是判断依据：没有「上次触发」= 按键根本没进到软件。
 */
const shortcutStatusText = computed(() => {
  const zh = store.locales === 'zh'
  const configured = voiceState.shortcutDisplay || (zh ? '未设置' : 'none')
  if (!hasCapability('shell.globalShortcut')) {
    return zh ? `快捷键 ${configured}（本环境无系统级快捷键）` : `shortcut ${configured} (no global shortcut here)`
  }
  if (voiceState.hostShortcut === 'ok') {
    const active = voiceState.hostShortcutActive || configured
    const fellBack = voiceState.hostShortcutActive && voiceState.hostShortcutActive !== voiceState.shortcutDisplay
    return fellBack
      ? (zh ? `快捷键 ${configured} 注册失败，已临时改用 ${active}` : `${configured} failed; using ${active} instead`)
      : (zh ? `快捷键 ${active} 已注册` : `shortcut ${active} registered`)
  }
  if (voiceState.hostShortcut === 'failed') {
    return zh
      ? `快捷键 ${configured} 注册失败${voiceState.hostShortcutError ? '：' + voiceState.hostShortcutError : ''}`
      : `${configured} failed to register${voiceState.hostShortcutError ? ': ' + voiceState.hostShortcutError : ''}`
  }
  return zh ? `快捷键 ${configured}（注册结果未返回）` : `shortcut ${configured} (no result yet)`
})

// 选择 ONNX 模型文件
async function selectOnnxModel() {
  try {
    // 如果支持 Electron 文件对话框
    if (hasCapability('dialog.native')) {
      const result = await getPlatform().dialog.pickFile({
        filters: [
          { name: 'ONNX Model', extensions: ['onnx'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })
      if (result) {
        store.AIconfig.asr.onnx.modelPath = result
        store.AIconfig.asr.onnx.modelLoaded = false
        store.saveConfig()
      }
    } else {
      // Web 环境使用文件输入
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.onnx'
      input.onchange = (e: any) => {
        const file = e.target.files?.[0]
        if (file) {
          store.AIconfig.asr.onnx.modelPath = file.name
          store.AIconfig.asr.onnx.modelLoaded = false
          store.saveConfig()
        }
      }
      input.click()
    }
  } catch (error) {
    console.error('选择ONNX模型失败:', error)
  }
}

// 快捷键的注册 / 注销统一由全局语音输入（services/asr/globalVoice.ts）按窗口焦点负责：
// 窗口在前台时故意不注册（按键进窗口，能识别「按住 / 松开」），切到后台才注册系统级快捷键。
// 这里不再自己注册，否则会把前台那条更准的路径顶掉（Windows 上系统级快捷键按住会不停重复触发）。
onMounted(() => {
  void refreshSystemStatus()
})

onBeforeUnmount(() => {
  // 销毁测试管理器，避免麦克风/会话泄漏
  if (asrTestManager) {
    try { asrTestManager.destroy() } catch (e) { /* ignore */ }
    asrTestManager = null
  }
})
</script>

<template>
  <div class="settings-group">
    <h3>{{ store.locales=='zh'?'语音输入设置' : 'Speech Input Settings' }}</h3>

    <!-- ASR类型选择 -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'识别引擎' : 'ASR Engine' }}</label>
      <select v-model="store.AIconfig.asr.type">
        <option value="onnx-whisper">{{ store.locales=='zh'?'ONNX 本地识别（Whisper/Paraformer/SenseVoice）' : 'ONNX Local (Whisper/Paraformer/SenseVoice)' }}</option>
        <option value="whisper-api">{{ store.locales=='zh'?'Whisper API（需API密钥）' : 'Whisper API (Requires API Key)' }}</option>
        <option value="whisper-local">{{ store.locales=='zh'?'Whisper Python（需Python环境）' : 'Whisper Local (Requires Python)' }}</option>
        <option value="qwen3-asr">{{ store.locales=='zh'?'Qwen3-ASR（本地网页服务 / OpenAI兼容）' : 'Qwen3-ASR (Local Web UI / OpenAI-compatible)' }}</option>
        <option value="funasr-online">{{ store.locales=='zh'?'FunASR 流式 Paraformer（官方 online，本地实时）' : 'FunASR Streaming Paraformer (Local)' }}</option>
      </select>
    </div>

    <!-- 语言选择 -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'识别语言' : 'Recognition Language' }}</label>
      <select v-model="store.AIconfig.asr.language">
        <option value="zh-CN">{{ store.locales=='zh'?'中文（简体）' : 'Chinese (Simplified)' }}</option>
        <option value="en-US">{{ store.locales=='zh'?'英语（美国）' : 'English (US)' }}</option>
        <option value="ja-JP">{{ store.locales=='zh'?'日语' : 'Japanese' }}</option>
        <option value="ko-KR">{{ store.locales=='zh'?'韩语' : 'Korean' }}</option>
        <option value="fr-FR">{{ store.locales=='zh'?'法语' : 'French' }}</option>
        <option value="de-DE">{{ store.locales=='zh'?'德语' : 'German' }}</option>
        <option value="es-ES">{{ store.locales=='zh'?'西班牙语' : 'Spanish' }}</option>
        <option value="ru-RU">{{ store.locales=='zh'?'俄语' : 'Russian' }}</option>
        <option value="auto">{{ store.locales=='zh'?'自动检测' : 'Auto Detect' }}</option>
      </select>
    </div>

    <!-- Whisper API 配置 -->
    <div v-if="store.AIconfig.asr.type === 'whisper-api'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'API地址' : 'API URL' }}</label>
        <input v-model="store.AIconfig.asr.whisper.url" :placeholder="store.locales=='zh'?'例如: https://api.openai.com/v1/audio/transcriptions' : 'Example: https://api.openai.com/v1/audio/transcriptions'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'API密钥' : 'API Key' }}</label>
        <input type="password" v-model="store.AIconfig.asr.whisper.api_key" :placeholder="store.locales=='zh'?'请输入API密钥' : 'Enter API key'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'模型' : 'Model' }}</label>
        <input v-model="store.AIconfig.asr.whisper.model" :placeholder="store.locales=='zh'?'例如: whisper-1' : 'Example: whisper-1'"/>
      </div>
    </div>

    <!-- Qwen3-ASR 配置（本地网页服务 Gradio / 或 OpenAI 兼容端点） -->
    <div v-if="store.AIconfig.asr.type === 'qwen3-asr'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'接口协议' : 'API Protocol' }}</label>
        <select v-model="store.AIconfig.asr.qwen3.protocol" @change="store.saveConfig">
          <option value="auto">{{ store.locales=='zh'?'自动（按地址判断）' : 'Auto (detect from URL)' }}</option>
          <option value="gradio">{{ store.locales=='zh'?'Gradio 网页服务（Qwen3-ASR WebUI /run）' : 'Gradio web UI (/run)' }}</option>
          <option value="openai">{{ store.locales=='zh'?'OpenAI 兼容（vLLM / Docker / 云端）' : 'OpenAI-compatible (vLLM / Docker / cloud)' }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'API地址' : 'API URL' }}</label>
        <input v-model="store.AIconfig.asr.qwen3.url" @change="store.saveConfig"
          :title="hints.qwenEndpoint"
          :placeholder="qwen3Protocol === 'openai' ? 'http://localhost:8000/v1/audio/transcriptions' : 'http://127.0.0.1:7867'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'API密钥' : 'API Key' }}</label>
        <input type="password" v-model="store.AIconfig.asr.qwen3.api_key" @change="store.saveConfig"
          :placeholder="store.locales=='zh'?'本地服务可留空；云端服务填写密钥' : 'Leave blank for local server; enter key for cloud'"/>
      </div>
      <!-- Gradio 网页服务参数（手册 /run 接口的入参） -->
      <template v-if="qwen3Protocol === 'gradio'">
        <div class="form-group">
          <label>{{ store.locales=='zh'?'识别方式' : 'Recognition Mode' }}</label>
          <select v-model="store.AIconfig.asr.qwen3.mode" :title="hints.qwenSegment" @change="store.saveConfig">
            <option value="segment">{{ store.locales=='zh'?'流式：分段准实时（边说边出）' : 'Streaming: segmented (text while you speak)' }}</option>
            <option value="whole">{{ store.locales=='zh'?'整段：松手后一次识别' : 'Whole: transcribe on release' }}</option>
          </select>
        </div>
        <template v-if="qwen3Segment">
          <div class="form-group">
            <label>{{ store.locales=='zh'?'停顿切段（毫秒）' : 'Cut on pause (ms)' }}</label>
            <input type="number" min="200" max="3000" step="50" v-model.number="store.AIconfig.asr.qwen3.silenceMs" @change="store.saveConfig" />
          </div>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'单段最长（秒）' : 'Max segment length (s)' }}</label>
            <input type="number" min="5" max="180" step="5" v-model.number="qwen3MaxSegmentSec" @change="store.saveConfig" />
          </div>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'切点重叠（毫秒）' : 'Cut overlap (ms)' }}</label>
            <input type="number" min="0" max="800" step="50" v-model.number="store.AIconfig.asr.qwen3.overlapMs" @change="store.saveConfig" />
          </div>
        </template>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'语种选择' : 'Language' }}</label>
          <input v-model="store.AIconfig.asr.qwen3.langDisp" @change="store.saveConfig"
            :placeholder="store.locales=='zh'?'网页服务下拉框中的语种名，默认「自动识别」' : 'Language name used by the web UI (default 自动识别)'"/>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'单行最大字符数' : 'Max chars per line' }}</label>
          <input type="number" min="0" max="200" step="10" v-model.number="store.AIconfig.asr.qwen3.maxChars" @change="store.saveConfig" />
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'选项' : 'Options' }}</label>
          <div class="checkbox-group">
            <label class="checkbox-label" style="width:100%">
              <input type="checkbox" v-model="store.AIconfig.asr.qwen3.splitPunc" @change="store.saveConfig" />
              {{ store.locales=='zh'?'跟随结果文本标点断句（推荐）' : 'Split by punctuation (recommended)' }}
            </label>
            <label class="checkbox-label" style="width:100%">
              <input type="checkbox" v-model="store.AIconfig.asr.qwen3.diarize" @change="store.saveConfig" />
              {{ store.locales=='zh'?'开启说话人角色识别' : 'Speaker diarization' }}
            </label>
          </div>
        </div>
      </template>
      <!-- OpenAI 兼容端点才需要模型名 -->
      <template v-else>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'模型' : 'Model' }}</label>
          <select v-model="qwen3ModelPreset">
            <option v-for="p in qwen3ModelPresets" :value="p.value">{{ p.label }}</option>
            <option value="__custom__">{{ store.locales=='zh'?'自定义…' : 'Custom…' }}</option>
          </select>
        </div>
        <div class="form-group" v-if="isQwen3CustomModel">
          <label>{{ store.locales=='zh'?'模型名称' : 'Model Name' }}</label>
          <input v-model="store.AIconfig.asr.qwen3.model" :placeholder="store.locales=='zh'?'输入模型名，例如 Qwen/Qwen3-ASR-1.7B' : 'Enter model name, e.g. Qwen/Qwen3-ASR-1.7B'" @change="store.saveConfig"/>
        </div>
      </template>
    </div>

    <!-- ONNX Whisper 配置 -->
    <div v-if="store.AIconfig.asr.type === 'onnx-whisper'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'模型文件' : 'Model File' }}</label>
        <div class="input-with-button">
          <input v-model="store.AIconfig.asr.onnx.modelPath" 
                :placeholder="store.locales=='zh'?'选择 .onnx 模型文件（Whisper/Paraformer/SenseVoice）' : 'Select .onnx model file (Whisper/Paraformer/SenseVoice)'"/>
          <div class="button" style="width:25px;" @click="selectOnnxModel"
              :title="store.locales=='zh'?'选择模型文件' : 'Select model file'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'执行后端' : 'Execution Provider' }}</label>
        <select v-model="store.AIconfig.asr.onnx.provider">
          <option value="wasm">{{ store.locales=='zh'?'WASM（兼容性最好）' : 'WASM (best compatibility)' }}</option>
          <option value="webgl">{{ store.locales=='zh'?'WebGL（GPU加速）' : 'WebGL (GPU acceleration)' }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'选项' : 'Options' }}</label>
        <div class="checkbox-group">
          <label class="checkbox-label" style="width: 100%">
            <input type="checkbox" v-model="store.AIconfig.asr.onnx.useLocalWasm" @change="store.saveConfig" />
            {{ store.locales=='zh'?'使用本地 WASM 文件（离线）' : 'Use local WASM files (offline)' }}
          </label>
          <label class="checkbox-label" style="width: 100%">
            <input type="checkbox" v-model="store.AIconfig.asr.continuous" />
            {{ store.locales=='zh'?'连续识别（说话时持续识别，无需反复按键）' : 'Continuous recognition' }}
          </label>
          <label class="checkbox-label" style="width: 100%">
            <input type="checkbox" v-model="store.AIconfig.asr.autoSend" />
            {{ store.locales=='zh'?'识别后自动发送（停止说话后自动发送消息）' : 'Auto-send after recognition' }}
          </label>
        </div>
      </div>
      <div class="form-group" v-if="store.AIconfig.asr.onnx.modelLoaded">
        <div class="onnx-model-status">
          <i class="fa fa-check-circle" style="color:#2ecc71"></i>
          <span>{{ store.locales=='zh'?'模型已加载，可以开始语音识别' : 'Model loaded, ready for speech recognition' }}</span>
        </div>
      </div>
      <div class="form-group" v-if="store.AIconfig.asr.onnx.loading">
        <div class="onnx-model-status loading">
          <i class="fa fa-spinner fa-spin"></i>
          <span>{{ store.locales=='zh'?'正在加载模型...' : 'Loading model...' }}</span>
        </div>
      </div>
    </div>
    <!-- FunASR 流式 Paraformer 配置 -->
    <div v-if="store.AIconfig.asr.type === 'funasr-online'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'模型目录' : 'Model Directory' }}</label>
        <div class="input-with-button">
          <input v-model="store.AIconfig.asr.funasr.dir" 
                :title="hints.funasrGuide"
                :placeholder="store.locales=='zh'?'选择含 model_quant.onnx / decoder_quant.onnx / config.yaml 的目录' : 'Dir with model_quant.onnx / decoder_quant.onnx / config.yaml'"
                @change="store.saveConfig"/>
          <div class="button" style="width:25px;" @click="pickFunasrModelDir"
              :title="store.locales=='zh'?'选择模型目录' : 'Select model directory'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'离线精修模型' : 'Offline refine model (optional)' }}</label>
        <div class="input-with-button">
          <input v-model="store.AIconfig.asr.funasr.refineModel"
                :placeholder="store.locales=='zh'?'选择离线单文件 onnx，如 sensevoice-small /model.onnx（空则不精修）' : 'Optional offline .onnx (e.g. sensevoice-small); blank = no refinement'"
                @change="store.saveConfig" />
          <div class="button" style="width:25px;" @click="selectFunasrRefine"
              :title="store.locales=='zh'?'选择离线模型文件' : 'Select offline model file'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'批处理标点阈值' : 'Punct batch threshold (chars)' }}</label>
        <input type="number" min="0" max="500" step="10" v-model.number="store.AIconfig.asr.funasr.punctMin" :title="hints.funasrPunct" @change="store.saveConfig" />
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'选项' : 'Options' }}</label>
        <div class="checkbox-group">
          <label class="checkbox-label" style="width:100%">
            <input type="checkbox" v-model="store.AIconfig.asr.funasr.vad" @change="store.saveConfig" />
            {{ store.locales=='zh'?'自动断句（说话停顿自动出句并继续听，无需精确点按启停）' : 'Auto sentence VAD (pause commits a sentence and keeps listening)' }}
          </label>
        </div>
      </div>
    </div>
    <!-- 标点校验模式（全局，对所有识别引擎生效） -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'标点校验模式' : 'Punctuation Mode' }}</label>
      <select v-model="store.AIconfig.asr.punctMode"
              :title="store.AIconfig.asr.punctMode === 'local' ? hints.punctLocal : (store.AIconfig.asr.punctMode === 'llm' ? hints.punctLlm : '')"
              @change="store.saveConfig">
        <option value="none">{{ store.locales=='zh'?'无校验' : 'None' }}</option>
        <option value="local">{{ store.locales=='zh'?'普通校验（本地标点模型，离线）' : 'Normal (local ct-punc, offline)' }}</option>
        <option value="llm">{{ store.locales=='zh'?'大模型校验（纠错 + 补标点，需已连接大模型）' : 'LLM proofread + punctuation (LLM must be connected)' }}</option>
      </select>
    </div>
    <!-- 本地标点模型目录（punctMode=local，全局） -->
    <div class="form-group" v-if="store.AIconfig.asr.punctMode === 'local'">
      <label>{{ store.locales=='zh'?'本地标点模型目录' : 'Local punct model dir' }}</label>
      <div class="input-with-button">
        <input v-model="store.AIconfig.asr.puncDir"
              :placeholder="store.locales=='zh'?'选择含 model_quant.onnx / config.yaml / tokens.json 的目录' : 'Dir with model_quant.onnx / config.yaml / tokens.json'"
              @change="store.saveConfig"/>
        <div class="button" style="width:25px;" @click="selectAsrPuncDir"
            :title="store.locales=='zh'?'选择标点模型目录' : 'Select punctuation model directory'">
          <i class="fa fa-folder-open"></i>
        </div>
      </div>
    </div>
    <!-- 快捷按键：先配好引擎与标点，再配「怎么按」 -->
    <div class="form-group">
      <label :title="hints.shortcut">{{ store.locales=='zh'?'快捷按键' : 'Shortcut Key' }}</label>
      <div class="shortcut-input">
        <input 
          v-model="store.AIconfig.asr.shortcut" 
          :placeholder="store.locales=='zh'?'默认 CapsLock（按住说话；短按切换大小写）' : 'Default CapsLock (hold to dictate; short press still toggles Caps Lock)'"
          :title="hints.shortcut"
          @keydown="captureShortcut"
          readonly
        />
        <div class="button" style="width:25px;" @click="resetShortcut" 
            :title="store.locales=='zh'?'恢复默认快捷键' : 'Reset to default shortcut'">
          <i class="fa fa-undo"></i>
        </div>
        <div class="button" style="width:25px;" @click="clearShortcut" 
            :title="store.locales=='zh'?'清空（不用系统级快捷键，只留悬浮麦克风）' : 'Clear (no global shortcut; floating mic only)'">
          <i class="fa fa-ban"></i>
        </div>
      </div>
    </div>

    <!-- 输入方式 -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'系统级听写' : 'System input' }}</label>
      <label class="check-line"
             :title="hasCapability('shell.systemInput') ? hints.systemWide : (store.locales=='zh'?'当前系统暂不支持系统级输入' : 'System-wide input is not supported on this platform')">
        <input type="checkbox" :checked="store.AIconfig.asr.systemWide !== false"
               :disabled="!hasCapability('shell.systemInput')"
               @change="setSystemWide(($event.target as HTMLInputElement).checked)" />
        <span>{{ store.locales=='zh'?'在其它应用中直接输入' : 'Type into other apps' }}</span>
      </label>
    </div>
    <div v-if="store.AIconfig.asr.systemWide !== false" class="form-group">
      <label :title="hints.inputMode">{{ store.locales=='zh'?'触发方式' : 'Trigger' }}</label>
      <select v-model="store.AIconfig.asr.systemInputMode" :title="hints.inputMode" @change="store.saveConfig">
        <option value="toggle">{{ store.locales=='zh'?'单点开关（按一次开始 / 再按一次结束）' : 'Toggle (press once to start / again to finish)' }}</option>
        <option value="hold">{{ store.locales=='zh'?'长按说话（按住开始 / 松开结束）' : 'Hold to talk (hold to start / release to finish)' }}</option>
      </select>
    </div>
    <div v-if="store.AIconfig.asr.systemWide !== false" class="form-group">
      <label>{{ store.locales=='zh'?'剪贴板' : 'Clipboard' }}</label>
      <label class="check-line" :title="hints.clipboard">
        <input type="checkbox" v-model="store.AIconfig.asr.restoreClipboard" @change="store.saveConfig" />
        <span>{{ store.locales=='zh'?'粘贴后恢复剪贴板' : 'Restore clipboard after pasting' }}</span>
      </label>
    </div>
    <div v-if="store.AIconfig.asr.systemWide !== false && hasCapability('shell.systemInput') && systemStatus && !systemStatus.supported" class="form-group">
      <label></label>
      <div class="field-hint warn"
           :title="systemStatus.error || (store.locales=='zh'?'当前环境不支持系统级输入' : 'System-wide input is unavailable in this environment')">
        <i class="fa fa-exclamation-triangle"></i>
      </div>
    </div>

    <div class="form-group">
      <label>{{ store.locales=='zh'?'悬浮麦克风' : 'Floating Mic' }}</label>
      <label class="check-line" :title="hints.floatButton">
        <input type="checkbox" :checked="store.AIconfig.asr.floatButton !== false"
               @change="setFloatButton(($event.target as HTMLInputElement).checked)" />
        <span>{{ store.locales=='zh'?'显示悬浮麦克风' : 'Show floating mic' }}</span>
      </label>
    </div>

    <!-- 状态：配置自检 + 系统级快捷键注册情况 + 最近一次触发（按了没反应时看这一行） -->
    <div class="form-group status-row">
      <label>{{ store.locales=='zh'?'状态' : 'Status' }}</label>
      <div class="asr-diag">
        {{
          (voiceState.ready
            ? (store.locales=='zh'?'引擎配置：已就绪' : 'Engine config: ready')
            : (store.locales=='zh'?'引擎配置：还缺必填项（见下方对应引擎的参数）' : 'Engine config: missing required fields'))
          + ' · '
          + shortcutStatusText
          + ' · '
          + (voiceState.lastTrigger
            ? (store.locales=='zh'?'上次触发：' : 'last trigger: ') + voiceState.lastTrigger
            : (store.locales=='zh'?'上次触发：无（按下快捷键没有到达软件）' : 'last trigger: none (the shortcut never reached the app)'))
        }}
      </div>
      <div class="button mini" @click="retryVoiceShortcut()"
           :title="store.locales=='zh'?'重新注册系统级快捷键' : 'Re-register the global shortcut'">
        <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'重试' : 'Retry' }}
      </div>
    </div>

    <!-- 测试功能：与语音合成页一致，放在最后 -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'测试功能' : 'Test Function' }}</label>
      <div class="button-group">
        <div 
          class="button" 
          @mousedown="startASRTest" 
          @mouseup="stopASRTest"
          @mouseleave="stopASRTest"
          :class="{ 'recording': asrTesting }"
          :title="store.locales=='zh'?'按住测试语音识别' : 'Press and hold to test speech recognition'"
        >
          <i :class="asrTesting ? 'fa fa-microphone fa-fade' : 'fa fa-microphone'"></i>
          {{ asrTesting ? (store.locales=='zh'?'录音中...' : 'Recording...') : (store.locales=='zh'?'按住说话测试' : 'Hold to Test') }}
        </div>
        <div class="button" @click="clearASRTestResult" :title="store.locales=='zh'?'清除测试结果' : 'Clear test result'">
          <i class="fa fa-eraser"></i> {{ store.locales=='zh'?'清除' : 'Clear' }}
        </div>
      </div>
    </div>
    <!-- 测试结果（独立一行） -->
    <div v-if="asrTestResult" class="asr-test-result">
      <div class="result-content scoll">
        <strong>{{ store.locales=='zh'?'识别结果：' : 'Recognition Result:' }}</strong>{{ asrTestResult }}
      </div>
    </div>
    <div v-if="asrTestError" class="asr-test-result error">
      <div class="result-content scoll">
        <strong>{{ store.locales=='zh'?'识别失败：' : 'Recognition Failed:' }}</strong>{{ asrTestError }}
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 样式与 Set.vue 一致（拆分后由本组件自持，不依赖父级 scoped 样式） */
.settings-group {
  margin-bottom: 5px;
  padding: 8px;
}

.settings-group:last-child {
  margin-bottom: 0;
}

.settings-group h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}

.settings-group h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* 表单组样式 */
.form-group {
  display: flex;
  align-items: center;
  /* 与语音合成页一致：label 在左、控件在右，一行一个；不让宽 100% 的 select 换行 */
  flex-wrap: nowrap;
  margin-bottom: 5px;
}

/* 统一清零 form-group 内元素的 margin（防止全局样式污染导致行高超出） */
.form-group > * {
  margin: 0;
}

.form-group:last-child {
  margin-bottom: 0;
}

/* 复选框 + 说明一行（与 TtsSettings 的 .check-line 保持一致） */
.check-line {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: var(--fontColor);
  opacity: 0.85;
  line-height: 1.45;
  cursor: pointer;
  user-select: none;
}
/* 覆盖 .form-group label 的 120px 固定宽度：开关说明是一整行文字，不能被压成 120px */
.form-group label.check-line {
  width: auto;
  min-width: 0;
  flex: 1 1 auto;
  flex-shrink: 1;
  font-size: 12px;
  line-height: 1.45;
}
.check-line input[type="checkbox"] {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
}
.check-line > span {
  min-width: 0;
}

/* 状态行：说明占满剩余宽度，重试按钮不再把行撑高 */
.status-row {
  align-items: center;
}
.status-row .asr-diag {
  align-self: center;
}
.button.mini {
  flex: 0 0 auto;
  width: auto;
  height: 31px;
  min-height: 31px;
  padding: 0 10px;
  margin-left: 6px;
  font-size: 12px;
  box-sizing: border-box;
}
.field-hint.warn {
  color: #e6a23c;
  opacity: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 状态行（引擎自检 / 快捷键注册 / 最近一次触发） */
.asr-diag {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  line-height: 1.6;
  opacity: 0.75;
  word-break: break-word;
}

.form-group label {
  width: 120px;
  min-width: 120px;
  color: var(--fontColor);
  font-size: 14px;
  user-select: none;
  line-height: 1;
  flex-shrink: 0;
}

.form-group input:not([type="checkbox"]):not([type="radio"]),
.form-group textarea {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  margin: 0px
}
/* 下拉框用正常背景色（不用菜单底色），并占满 label 右侧剩余宽度 */
.form-group select {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  margin: 0;
  background-color: var(--backgroundColor);
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}

.form-group input[type="range"] {
  flex: 1;
  margin-right: 10px;
}

.form-group input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-right: 10px;
}

.form-group input[type="password"] {
  letter-spacing: 1px;
}

/* 带按钮的输入框 */
.input-with-button {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 5px;
}
.input-with-button > input,
.input-with-button > select {
  flex: 1;
  min-width: 0;
  margin: 0;
}
.input-with-button > .button {
  flex-shrink: 0;
  height: auto;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 0 6px;
  margin: 0;
  width: auto;
}

.button {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 14px;
  white-space: nowrap;
  width:calc(100% - 20px);
  margin:0px;
  padding: 6px 6px;
}

.button:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.button.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

.button i {
  font-size: 14px;
}

/* 按钮组样式 */
.button-group {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
/* 让按钮恰好填满网格单元格、右缘对齐；不引入 box-sizing，保持原有高度（全局 .button height:23px content-box）不变 */
.button-group .button {
  /* calc(100% - 14px) 抵消 .button 的 padding(6px*2) + border(1px*2)，使 border-box 宽度恰为 100% */
  width: calc(100% - 14px);
}

/* ASR 语音输入设置 */
.shortcut-input {
  flex: 1;
  display: flex;
  gap: 5px;
  align-items: center;
}

.shortcut-input input {
  cursor: pointer;
  /* 与其它输入框/下拉框同高（不再单独压成 22px） */
  background-color: var(--menuColor);
  user-select: none;
}

.shortcut-input input:focus {
  border-color: var(--fontActiveColor);
  background-color: var(--backgroundColor);
}

.shortcut-input input::selection {
  background: transparent;
}

/* 快捷键右侧的「重置 / 清空」两个小按钮：
   全局 .button 自带 6px 上下 padding，和 22px 高的输入框并排时明显更高。
   这里改成撑满输入框高度、去掉上下 padding，三者看起来一样高。 */
.shortcut-input > .button {
  flex: 0 0 25px;
  width: 25px;
  height: auto;
  align-self: stretch;
  padding: 0;
  margin: 0;
  box-sizing: border-box;
}

/* 快捷键说明（换一组 / 清空的用法）：小一号、淡一点，跟在输入行下面 */
.field-hint {
  flex: 1;
  min-width: 0;
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.6;
  opacity: 0.65;
}

.checkbox-group {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.45;
  color: var(--fontColor);
  opacity: 0.85;
  user-select: none;
}

.checkbox-label input[type="checkbox"] {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
  appearance: auto;
  -webkit-appearance: checkbox;
  opacity: 1 !important;
}

/* 修正：.form-group label 的 120px 强制宽度/line-height:1 会压掉 checkbox 行，
   这里覆盖，让「选项 / 标点校验」等勾选行完整可见、可点、文字不重叠 */
.settings-group .checkbox-group .checkbox-label {
  width: auto !important;
  min-width: 0 !important;
  flex-shrink: 1 !important;
  flex-grow: 1;
  line-height: 1.4 !important;
  color: var(--fontColor);
}
.settings-group .checkbox-group .checkbox-label input[type="checkbox"] {
  flex: 0 0 auto !important;
  width: 14px !important;
  height: 14px !important;
  margin-right: 8px !important;
  accent-color: var(--fontActiveColor, #4a90d9);
}

/* ASR 测试按钮录音状态 */
.button.recording {
  background-color: #e74c3c !important;
  color: white !important;
  border-color: #c0392b !important;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.4);
  }
  50% {
    transform: scale(1.02);
    box-shadow: 0 0 0 10px rgba(231, 76, 60, 0);
  }
}

/* ASR 测试结果 */
.asr-test-result {
  margin: 5px 0px;
  padding: 5px;
  border-radius: 5px;
  background-color: rgba(46, 204, 113, 0.1);
  border: 1px solid rgba(46, 204, 113, 0.2);
}

.asr-test-result.error {
  background-color: rgba(231, 76, 60, 0.1);
  border: 1px solid rgba(231, 76, 60, 0.2);
}

/* fa-fade 动画（Font Awesome自带） */
.fa-fade {
  animation: fa-fade 1.5s ease-in-out infinite;
}

/* ONNX 模型状态 */
.onnx-model-status {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 5px;
  font-size: 14px;
  background-color: rgba(46, 204, 113, 0.1);
  border: 1px solid rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}

.onnx-model-status.loading {
  background-color: rgba(52, 152, 219, 0.1);
  border: 1px solid rgba(52, 152, 219, 0.2);
  color: #3498db;
}

.onnx-model-status i {
  font-size: 16px;
}

.funasr-chunk-tag {
  opacity: .6;
  font-size: 12px;
  margin-right: 6px;
}
</style>
