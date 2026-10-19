<!-- TtsSettings.vue - 语音合成（TTS）设置（从 Set.vue 拆分出的独立组件，样式自带，与设置页一致） -->
<script setup lang="ts">
import { aikmIpcAvailable } from '@/lib/aikmIpc'
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import { getPlatform, hasCapability } from '@/platform'
import {
  QWEN3_LANGS,
  QWEN3_REFERENCE_VOICE,
  normalizeQwen3Lang,
  qwen3Synthesize,
  resetQwen3Cache,
} from '@/services/tts/qwen3'

const store = usestore()

// TTS语音类型选项
const ttsTypes = computed(() => [
  { value: '本地', label_zh: '本地语音合成', label_en: 'Local TTS' },
  { value: 'Kokoro', label_zh: 'Kokoro（本地离线）', label_en: 'Kokoro (Local)' },
  { value: 'Piper', label_zh: 'Piper（本地离线）', label_en: 'Piper (Local)' },
  { value: 'indexTTS2', label_zh: 'IndexTTS2', label_en: 'IndexTTS2' },
  { value: 'Qwen3-TTS', label_zh: 'Qwen3-TTS', label_en: 'Qwen3-TTS' }
])

// 获取当前语言下的TTS类型标签
const getTTSLabel = (type: string) => {
  const ttsType = ttsTypes.value.find(t => t.value === type)
  if (!ttsType) return type
  return store.locales === 'zh' ? ttsType.label_zh : ttsType.label_en
}

/**
 * 「本地语音合成」在不同环境用不同引擎：
 * - 浏览器 / 桌面：Web Speech（SpeechSynthesis）
 * - 安卓：WebView 没有 Web Speech，改用系统自带 TTS 引擎（无需模型、可离线）
 */
const localEngineHint = computed(() => {
  const zh = store.locales === 'zh'
  const hasWeb = typeof (window as any).speechSynthesis?.speak === 'function'
  if (hasWeb) {
    return zh
      ? '当前由浏览器 / 桌面自带的语音引擎朗读，音色取决于系统；如需更好的音质可改用 Kokoro / Piper。'
      : 'Spoken by the browser / desktop speech engine; voice quality depends on the system. Use Kokoro / Piper for better quality.'
  }
  if (hasCapability('host.tts')) {
    return zh
      ? '当前由手机系统自带的语音引擎朗读（无需模型、多数机型可离线）；音色 / 语速跟随系统「文字转语音」设置，可在下方调节语速与音高。'
      : 'Spoken by the device system TTS engine (no model needed, usually works offline). Voice follows the system text-to-speech settings; rate and pitch can be adjusted below.'
  }
  return zh ? '当前环境没有可用的本地语音引擎。' : 'No local speech engine is available in this environment.'
})

// ================== Qwen3-TTS（Qwen3-TTS-AllinOne） ==================
// 音色列表来自服务端 /update_voices（voices 目录里的 .pt 名字）；
// 「使用参考音频」需要同时上传参考音频（本接入不提供上传，走网页服务添加），列表里过滤掉。
const qwen3Voices = computed<string[]>(() => {
  const list = (store.AIconfig.tts.qwen3?.available_voices || []) as string[]
  const voices = Array.isArray(list) ? list.filter(v => v && v !== QWEN3_REFERENCE_VOICE) : []
  if (!voices.length) return [] // 列表为空 → 退回手动输入框（不把旧的音色名冒充成列表）
  // 当前音色还没进列表（换过地址 / 手动填过）→ 先列出来，别让下拉变空白
  const current = String(store.AIconfig.tts.voice || '').trim()
  if (current && current !== QWEN3_REFERENCE_VOICE && !voices.includes(current)) return [current, ...voices]
  return voices
})
const qwen3VoicesLoading = computed(() => !!store.AIconfig.tts.qwen3?.voicesLoading)
const qwen3Langs = QWEN3_LANGS

// 语言：服务端只认 Auto/Chinese/… 词表（旧存档的 'zh' 会在这里被映射，直接发 'zh' 会被服务端 500）
const qwen3Lang = computed({
  get: () => normalizeQwen3Lang(store.AIconfig.tts.qwen3?.lang ?? store.AIconfig.tts.language),
  set: (v: string) => store.updateQwen3TTS({ lang: v }),
})

// ================== 接入方式：本地 Qwen3-TTS / GPUStack 局域网 ==================
// local    = 本地或局域网里的 Qwen3-TTS-AllinOne（Gradio 7862 / FastAPI 9880）
// gpustack = GPUStack 部署的 Qwen3-TTS（OpenAI 兼容 /v1-openai/audio/speech，可跨局域网）
const qwen3Deploy = computed({
  get: () => (store.AIconfig.tts.qwen3?.deploy === 'gpustack' ? 'gpustack' : 'local'),
  set: (v: string) => store.updateQwen3TTS({ deploy: v === 'gpustack' ? 'gpustack' : 'local' }),
})

const gpustackConfig = computed<any>(() => store.AIconfig.tts.qwen3?.gpustack || {})

// GPUStack 模型 / 音色下拉（当前值不在服务端列表里时先列出来，避免下拉变空白）
const gpuStackModels = computed<string[]>(() => {
  const list = (gpustackConfig.value.availableModels || []) as string[]
  const models = Array.isArray(list) ? list.filter(Boolean) : []
  const current = String(gpustackConfig.value.model || '').trim()
  if (current && !models.includes(current)) return [current, ...models]
  return models
})
const gpuStackVoices = computed<string[]>(() => {
  const list = (gpustackConfig.value.availableVoices || []) as string[]
  const voices = Array.isArray(list) ? list.filter(Boolean) : []
  const current = String(gpustackConfig.value.voice || '').trim()
  if (current && !voices.includes(current)) return [current, ...voices]
  return voices
})
const gpuStackModelsLoading = computed(() => !!gpustackConfig.value.loadingModels)
const gpuStackVoicesLoading = computed(() => !!gpustackConfig.value.loadingVoices)

const qwen3Hint = computed(() => {
  const zh = store.locales === 'zh'
  const q = store.AIconfig.tts.qwen3 || {}
  if (qwen3Deploy.value === 'gpustack') {
    return zh
      ? 'GPUStack：填服务地址（如 http://192.168.1.10:8080，粘贴 /v1-openai 也能识别）+ API 密钥，模型选 GPUStack 里部署的 Qwen3-TTS。请求走 OpenAI 兼容的 /v1-openai/audio/speech（自动回退 /v1），局域网内其它电脑也能连；音色列表部分后端不提供，可直接手填。'
      : 'GPUStack: enter the server URL (e.g. http://192.168.1.10:8080; a pasted /v1-openai is fine) and API key, then pick the Qwen3-TTS model deployed in GPUStack. Requests use the OpenAI-compatible /v1-openai/audio/speech (falls back to /v1) over your LAN. Some backends have no voice list — type the voice name instead.'
  }
  const transport = q.transport === 'gradio'
    ? (zh ? 'Gradio /do_job（网页服务）' : 'Gradio /do_job (web UI)')
    : q.transport === 'api'
      ? (zh ? '直连接口（一次 POST）' : 'Direct API (single POST)')
      : (zh ? '未探测（点「测试连接」）' : 'Not probed (click "Test connection")')
  return zh
    ? `当前接口：${transport}。音色取自服务端 voices 目录；新增音色请在 Qwen3-TTS 网页服务（默认 http://127.0.0.1:7862）填写「输入音色名称」+ 参考音频后保存。`
    : `Transport: ${transport}. Voices come from the server's voices folder; add one in the Qwen3-TTS web UI (default http://127.0.0.1:7862) with a name and a reference audio clip.`
})

async function refreshQwen3Voices(silent = false) {
  if (qwen3VoicesLoading.value) return
  const res = await store.loadQwen3TTSVoices()
  if (res.success) {
    if (!silent) ElMessage.success(res.message)
  } else if (!silent) {
    ElMessage.error(res.message)
  }
}

async function refreshGpuStackModels(silent = false) {
  if (gpuStackModelsLoading.value) return
  const res = await store.loadGpuStackModels()
  if (res.success) {
    if (!silent) ElMessage.success(res.message)
  } else if (!silent) {
    ElMessage.error(res.message)
  }
}

async function refreshGpuStackVoices(silent = false) {
  if (gpuStackVoicesLoading.value) return
  const res = await store.loadQwen3TTSVoices()
  if (res.success) {
    if (!silent) ElMessage.success(res.message)
  } else if (!silent) {
    ElMessage.error(res.message)
  }
}

// 改地址 / 改协议 / 换接入方式：清掉接口探测缓存，并静默补拉一次列表
function onQwen3EndpointChanged() {
  resetQwen3Cache()
  store.updateQwen3TTS({ transport: '' })
  if (qwen3Deploy.value === 'gpustack') {
    const gs = gpustackConfig.value
    if (!gpuStackModels.value.length && !gs.loadingModels && !gs.modelsError) void refreshGpuStackModels(true)
    return
  }
  if (!qwen3Voices.value.length) void refreshQwen3Voices(true)
}

// 换接入方式：清缓存，补拉新方式需要的列表
// （读事件里的值，避免 v-model 与 @change 的触发顺序影响判断）
function onDeployChanged(ev?: Event) {
  const mode = String((ev?.target as any)?.value || qwen3Deploy.value)
  resetQwen3Cache()
  store.updateQwen3TTS({ transport: '' })
  if (mode === 'gpustack') {
    const gs = gpustackConfig.value
    if (!gpuStackModels.value.length && !gs.loadingModels && !gs.modelsError) void refreshGpuStackModels(true)
    return
  }
  if (!qwen3Voices.value.length) void refreshQwen3Voices(true)
}

// GPUStack 地址变了：旧列表作废，重新拉模型（音色等选定模型后再拉）
function onGpuStackEndpointChanged() {
  resetQwen3Cache()
  const gs = gpustackConfig.value
  gs.availableModels = []
  gs.availableVoices = []
  gs.modelsError = ''
  gs.voicesError = ''
  store.updateQwen3TTS({ transport: '' })
  store.saveConfig()
  void refreshGpuStackModels(true)
}

// GPUStack 换模型：音色随模型变，清空后重拉
function onGpuStackModelChanged() {
  const gs = gpustackConfig.value
  gs.availableVoices = []
  gs.voicesError = ''
  gs.voice = ''
  store.updateQwen3TTS({})
  if (String(gs.model || '').trim()) void refreshGpuStackVoices(true)
}

async function testQwen3Connection() {
  const res = await store.testQwen3TTSConnection()
  if (res.success) ElMessage.success(res.message)
  else ElMessage.error(res.message)
}

// 切到 Qwen3-TTS 且列表为空时自动拉一次（失败后不反复重试，等用户点刷新）
watch(() => store.AIconfig.tts.type, (type) => {
  if (type !== 'Qwen3-TTS') return
  if (qwen3Deploy.value === 'gpustack') {
    const gs = gpustackConfig.value
    if (!gpuStackModels.value.length && !gs.loadingModels && !gs.modelsError) void refreshGpuStackModels(true)
    return
  }
  const q = store.AIconfig.tts.qwen3
  if (qwen3Voices.value.length || qwen3VoicesLoading.value || q?.voicesError) return
  void refreshQwen3Voices(true)
}, { immediate: true })

// 打开语音设置时同步一次「本地服务」运行状态（软件重启后状态不会自己回来）
onMounted(() => {
  void store.refreshQwen3ServiceStatus()
})

// ================== Qwen3-TTS 本地服务（安装目录 / 启动停止） ==================
// Qwen3-TTS 是独立安装的 Python 程序（Gradio 7862 + FastAPI 9880）。桌面端按这里的
// 「安装目录」直接拉起它，等价于手动双击「开始_自动启动接口服务.bat」，不用再开 cmd。
const qwen3ServiceBusy = ref(false)
const qwen3ServiceHint = ref('')
const qwen3ServiceLog = ref('')

const qwen3ServiceRunning = computed(() => !!store.AIconfig.tts.qwen3?.serviceRunning)
const qwen3InstallDir = computed({
  get: () => String(store.AIconfig.tts.qwen3?.installDir || ''),
  set: (v: string) => { store.AIconfig.tts.qwen3.installDir = v },
})
const qwen3AutoStart = computed({
  get: () => !!store.AIconfig.tts.qwen3?.autoStart,
  set: (v: boolean) => store.updateQwen3TTS({ autoStart: v }),
})

// 选择安装目录（含 py312 与 app.py）
async function pickQwen3InstallDir() {
  try {
    if (!aikmIpcAvailable()) {
      ElMessage.warning(store.locales === 'zh' ? '仅在桌面应用中可用' : 'Only available in the desktop app')
      return
    }
    const dir = await getPlatform().dialog.pickDirectory()
    if (!dir) return
    qwen3InstallDir.value = dir
    await store.refreshQwen3ServiceStatus()
  } catch (e: any) {
    ElMessage.error((store.locales === 'zh' ? '选择目录失败: ' : 'Select folder failed: ') + (e?.message || e))
  }
}

// 启动后轮询：进程状态 + 音色列表，直到服务可用（模型加载通常十几秒到一分钟）
async function waitQwen3Ready(maxMs = 120000) {
  const zh = store.locales === 'zh'
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    if (store.AIconfig.tts.qwen3.serviceRunning) {
      const st = await store.refreshQwen3ServiceStatus()
      // 进程已经退出（端口占用 / 依赖缺失）→ 直接给出日志尾
      if (st && !st.running && st.lastExit) {
        qwen3ServiceLog.value = (st as any).logTail || ''
        qwen3ServiceHint.value = zh
          ? `服务进程已退出（code ${st.lastExit.code ?? '-'}），详见下方日志`
          : `Service process exited (code ${st.lastExit.code ?? '-'}); see logs below`
        return
      }
    }
    const res = await store.loadQwen3TTSVoices()
    if (res.success) {
      qwen3ServiceHint.value = zh ? `服务就绪 · ${res.message}` : `Ready · ${res.message}`
      qwen3ServiceLog.value = ''
      return
    }
    qwen3ServiceHint.value = zh ? '正在加载模型，等待服务就绪…' : 'Loading model, waiting for the service…'
    await new Promise(r => setTimeout(r, 2500))
  }
  const st = await store.refreshQwen3ServiceStatus()
  qwen3ServiceLog.value = (st as any)?.logTail || ''
  qwen3ServiceHint.value = zh
    ? '等待超时：服务可能还在加载模型，稍后点「刷新音色」再试'
    : 'Timed out: the service may still be loading; try "Refresh voices" later'
}

async function startQwen3Service() {
  if (qwen3ServiceBusy.value) return
  qwen3ServiceBusy.value = true
  qwen3ServiceLog.value = ''
  qwen3ServiceHint.value = store.locales === 'zh' ? '正在启动服务…' : 'Starting service…'
  try {
    const res = await store.startQwen3Service(false)
    qwen3ServiceHint.value = res.message
    if (res.success) await waitQwen3Ready()
    else {
      const st = await store.refreshQwen3ServiceStatus()
      qwen3ServiceLog.value = (st as any)?.logTail || ''
    }
  } finally {
    qwen3ServiceBusy.value = false
  }
}

async function stopQwen3Service() {
  if (qwen3ServiceBusy.value) return
  qwen3ServiceBusy.value = true
  try {
    const res = await store.stopQwen3Service(false)
    qwen3ServiceHint.value = res.message
    qwen3ServiceLog.value = ''
    resetQwen3Cache()
  } finally {
    qwen3ServiceBusy.value = false
  }
}

// 测试TTS功能
const testTTS = () => {
  const testText = store.locales === 'zh' ? '这是一个语音合成测试。' : 'This is a TTS test.'
  store.tts(testText)
}

// 设置模型目录后自动尝试加载模型（文件夹选择与手动输入共用）
async function applyModelDirAndLoad(dir: string, showSuccess: boolean) {
  store.updateOnnxTTS({ modelDir: dir, modelLoaded: false })
  if (!dir) return
  const res = await store.loadOnnxTTS()
  if (res.success) {
    if (showSuccess) ElMessage.success(res.message)
  } else {
    ElMessage.error(res.message)
  }
}

// 选择本地 ONNX 模型目录（Kokoro / Piper），选中后自动加载
async function selectOnnxModelDir() {
  try {
    if (!aikmIpcAvailable()) {
      ElMessage.warning(store.locales === 'zh' ? '仅在 Electron 应用中可用' : 'Only available in Electron app')
      return
    }
    const dir = await getPlatform().dialog.pickDirectory()
    if (!dir) return
    await applyModelDirAndLoad(dir, true)
  } catch (e: any) {
    ElMessage.error(store.locales === 'zh' ? '选择目录失败: ' + e?.message : 'Select folder failed: ' + e?.message)
  }
}

// 手动输入模型目录后自动加载
async function onModelDirInput() {
  await applyModelDirAndLoad(store.AIconfig.tts.onnx.modelDir, false)
}

// 手动加载本地 ONNX 模型
async function handleLoadOnnxTTS() {
  if (store.AIconfig.tts.onnx.loading) return
  const res = await store.loadOnnxTTS()
  if (res.success) {
    ElMessage.success(res.message)
  } else {
    ElMessage.error(res.message)
  }
}

// 合并后的模型加载/状态提示文案（加载按钮 + 状态提示合一）
const onnxStatusText = computed(() => {
  const zh = store.locales === 'zh'
  const o = store.AIconfig.tts.onnx
  if (o?.loading) return zh ? '正在加载模型...' : 'Loading model...'
  if (o?.modelLoaded) {
    return zh
      ? `模型就绪（${o.numSpeakers ?? 0} 个音色，${o.sampleRate ?? 0}Hz）· 点击重新加载`
      : `Ready (${o.numSpeakers ?? 0} voices, ${o.sampleRate ?? 0}Hz) · Click to reload`
  }
  if (o?.error) return zh ? `${o.error} · 点击重试` : `${o.error} · Click to retry`
  return zh ? '未加载 · 点击加载模型' : 'Not loaded · Click to load'
})

// 音色范围（0 ~ N-1），用于标签与输入上限
const speakerMax = computed(() => Math.max(0, (store.AIconfig.tts.onnx.numSpeakers || 1) - 1))

// Kokoro / Piper 类型说明（含模型下载指引）
const onnxHint = computed(() => {
  const zh = store.locales === 'zh'
  const engine = store.AIconfig.tts.type
  if (engine === 'Kokoro') {
    return zh
      ? '解压 sherpa-onnx 的 Kokoro 模型包（kokoro-multi-lang-v1_1 / v1_0），选择包含 model.onnx + voices.bin + tokens.txt 的文件夹。'
      : 'Extract a sherpa-onnx Kokoro model pack (kokoro-multi-lang-v1_1 / v1_0), pick the folder with model.onnx + voices.bin + tokens.txt.'
  }
  return zh
    ? '解压 Piper(VITS) 模型包（如 vits-piper-en_US-lessac-medium），选择包含 *.onnx + tokens.txt 的文件夹。'
    : 'Extract a Piper(VITS) model pack (e.g. vits-piper-en_US-lessac-medium), pick the folder with *.onnx + tokens.txt.'
})

// ================== 文本合成（生成 / 下载音频） ==================
// 说明：sherpa-onnx（Kokoro / Piper）的 generate() 是单次同步调用，内部不提供逐采样进度回调，
// 因此这里把长文本按句子/段落切块、逐块合成，百分比 = 已合成块数 / 总块数（长文本可见真实进度）。

const synthText = ref('')
const synthProgress = ref(0)             // 0 ~ 100
const synthPhase = ref<'idle' | 'synth' | 'done' | 'error'>('idle')
const synthStatus = ref('')
const synthUrl = ref('')
const synthExt = ref('wav')
let synthCancelled = false

// 支持生成音频文件的语音类型（本地浏览器 TTS 无音频文件，不支持）
const canGenerateFile = computed(() => {
  const t = store.AIconfig.tts.type
  return t === 'Kokoro' || t === 'Piper' || t === 'indexTTS2' || t === 'Qwen3-TTS'
})

// 将文本按句子/段落切块（用于逐段合成 + 进度），与 AudioQueue 的分句逻辑保持一致
function splitForSynth(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  if (!cleaned) return []
  const chunks: string[] = []
  const paragraphs = cleaned.split(/\n\s*\n/)
  for (const para of paragraphs) {
    const t = para.trim()
    if (!t) continue
    if (t.length < 200) {
      chunks.push(t)
      continue
    }
    const parts = t.split(/([。！？；\.!?;]+)/)
    let cur = ''
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim()
      if (!part) continue
      if (/([。！？；\.!?;]+)/.test(part) && cur) {
        cur += part
        if (cur.length >= 100 || i === parts.length - 1) {
          chunks.push(cur.trim())
          cur = ''
        }
      } else {
        if (cur.length + part.length < 300) {
          cur += (cur ? ' ' : '') + part
        } else {
          if (cur.trim()) chunks.push(cur.trim())
          cur = part
        }
      }
    }
    if (cur.trim()) chunks.push(cur.trim())
  }
  // 兜底：单块过长（无标点长文本）硬切，避免单次合成过长
  const result: string[] = []
  for (const c of chunks) {
    if (c.length <= 500) { result.push(c); continue }
    for (let i = 0; i < c.length; i += 500) result.push(c.slice(i, i + 500))
  }
  return result.filter(Boolean)
}

// 解析 WAV，提取格式信息与 PCM 数据（兼容带扩展块的 WAV）
function parseWav(buf: Uint8Array): { format: number; channels: number; sampleRate: number; bitsPerSample: number; data: Uint8Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let format = 1, channels = 1, sampleRate = 24000, bitsPerSample = 16
  // 显式标注为 Uint8Array（TS 5.7+ 中即 Uint8Array<ArrayBufferLike>），
  // 避免 new Uint8Array(0) 推断为 Uint8Array<ArrayBuffer> 导致 subarray 结果无法赋值
  let data: Uint8Array = new Uint8Array(0)
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      format = view.getUint16(offset + 8, true)
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
    } else if (id === 'data') {
      data = buf.subarray(offset + 8, Math.min(offset + 8 + size, buf.length))
      break
    }
    offset += 8 + size + (size % 2)
  }
  return { format, channels, sampleRate, bitsPerSample, data }
}

// 拼接多个同格式 WAV（均为 16bit PCM 单声道，同一模型采样率一致）为一个 WAV
// 返回 ArrayBuffer 而非 Uint8Array 视图：TS 5.7+ 中 Uint8Array 为 Uint8Array<ArrayBufferLike>，
// 其 buffer 可能是 SharedArrayBuffer，不满足 BlobPart 的 ArrayBufferView<ArrayBuffer> 约束；
// ArrayBuffer 在 TS 5.4/5.5/5.7+ 各版本都可直接作为 BlobPart。
function concatWav(parts: Uint8Array[]): ArrayBuffer {
  const infos = parts.map(parseWav).filter(i => i.data.length > 0)
  if (!infos.length) return new ArrayBuffer(0)
  const first = infos[0]
  const bytesPerSample = Math.max(1, Math.round(first.bitsPerSample / 8))
  const channels = Math.max(1, first.channels)
  let totalBytes = 0
  for (const info of infos) totalBytes += info.data.length
  const buffer = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(buffer)
  view.setUint32(0, 0x46464952, true)   // 'RIFF'
  view.setUint32(4, 36 + totalBytes, true)
  view.setUint32(8, 0x45564157, true)   // 'WAVE'
  view.setUint32(12, 0x20746d66, true)  // 'fmt '
  view.setUint32(16, 16, true)
  view.setUint16(20, first.format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, first.sampleRate, true)
  view.setUint32(28, first.sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, first.bitsPerSample, true)
  view.setUint32(36, 0x61746164, true)  // 'data'
  view.setUint32(40, totalBytes, true)
  const out = new Uint8Array(buffer)
  let o = 44
  for (const info of infos) {
    out.set(info.data, o)
    o += info.data.length
  }
  // 返回底层 ArrayBuffer（out 是它的视图，数据已写入 buffer）
  return buffer
}

// Kokoro / Piper：调用宿主合成一段（桌面 = sherpa-onnx），返回 WAV 字节
async function synthOnnxChunk(text: string): Promise<Uint8Array | null> {
  if (!hasCapability('host.tts')) return null
  const onnx = store.AIconfig.tts.onnx || {}
  try {
    return await getPlatform().host.tts.synthesize({
      engine: store.AIconfig.tts.type,
      modelDir: onnx.modelDir || '',
      text,
      sid: onnx.sid ?? 0,
      speed: onnx.speed ?? 1.0,
      lang: onnx.lang || undefined,
    })
  } catch {
    return null
  }
}

// indexTTS2 / Qwen3-TTS：整段一次请求远程服务，返回音频字节与格式
async function synthRemote(text: string): Promise<{ buffer: ArrayBuffer; format: string; mime?: string }> {
  const zh = store.locales === 'zh'
  const cfg = store.AIconfig.tts
  const isQwen = cfg.type === 'Qwen3-TTS'
  const q = cfg.qwen3 || {}
  const gs = q.gpustack || ({} as any)
  const isGpuStack = isQwen && q.deploy === 'gpustack'
  const base = String(isGpuStack ? (gs.url || '') : (cfg.url || '')).trim()
  if (!base) throw new Error(zh ? '未配置 TTS 服务地址' : 'TTS service URL not configured')
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (isQwen) {
    // Qwen3-TTS：本地按接口协议自动探测（Gradio /do_job 或直连接口）；GPUStack 走 OpenAI 兼容 /audio/speech
    const res = await qwen3Synthesize({
      deploy: isGpuStack ? 'gpustack' : 'local',
      base,
      apiKey: gs.apiKey,
      model: gs.model,
      responseFormat: gs.responseFormat,
      protocol: q.protocol,
      voice: isGpuStack ? gs.voice : cfg.voice,
      lang: isGpuStack ? (gs.lang || 'Auto') : (q.lang ?? cfg.language),
      modelType: q.modelType,
      speed: isGpuStack ? (gs.speed ?? q.speed ?? cfg.rate) : (q.speed ?? cfg.rate),
      chunkSize: q.chunkSize,
      batch: q.batch,
      timeoutMs: 180000,
    }, cleaned)
    return { buffer: res.buffer, format: res.format, mime: res.mime }
  }
  // indexTTS2：GET 一次拿音频
  const url = new URL(base)
  url.searchParams.set('text', cleaned)
  if (cfg.voice) url.searchParams.set('speaker', cfg.voice)
  if (cfg.language) url.searchParams.set('lang', cfg.language)
  if (cfg.emo) url.searchParams.set('emo', cfg.emo)
  if (cfg.weight) url.searchParams.set('weight', String(cfg.weight))
  const res = await fetch(url.toString(), {
    headers: { Accept: 'audio/wav, audio/mpeg, audio/*' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buffer = await res.arrayBuffer()
  if (!buffer.byteLength) throw new Error(zh ? '服务返回空音频' : 'Empty audio from service')
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  const format = ct.includes('wav') || ct.includes('x-wav') ? 'wav' : (ct.includes('mpeg') || ct.includes('mp3') ? 'mp3' : 'audio')
  return { buffer, format }
}

// 生成音频主流程
async function generateAudio() {
  const zh = store.locales === 'zh'
  const text = synthText.value.trim()
  if (!text) {
    ElMessage.warning(zh ? '请输入要合成的文本' : 'Please enter text to synthesize')
    return
  }
  if (store.AIconfig.tts.type === '本地') {
    ElMessage.warning(zh ? '本地浏览器语音不支持生成音频文件' : 'Local browser TTS cannot generate audio files')
    return
  }
  if (synthUrl.value) { URL.revokeObjectURL(synthUrl.value); synthUrl.value = '' }
  synthCancelled = false
  synthPhase.value = 'synth'
  synthProgress.value = 0
  const isOnnx = store.AIconfig.tts.type === 'Kokoro' || store.AIconfig.tts.type === 'Piper'
  try {
    let blob: Blob
    let ext: string
    if (isOnnx) {
      const chunks = splitForSynth(text)
      if (!chunks.length) throw new Error(zh ? '无法切分文本' : 'Cannot split text')
      const parts: Uint8Array[] = []
      for (let i = 0; i < chunks.length; i++) {
        if (synthCancelled) throw new Error(zh ? '已取消' : 'Cancelled')
        synthStatus.value = zh ? `正在合成 ${i + 1} / ${chunks.length} 段…` : `Synthesizing ${i + 1} / ${chunks.length}…`
        synthProgress.value = Math.round((i / chunks.length) * 100)
        await nextTick()
        const wav = await synthOnnxChunk(chunks[i])
        if (!wav || wav.byteLength === 0) throw new Error(zh ? `第 ${i + 1} 段合成失败（空结果）` : `Chunk ${i + 1} returned empty`)
        parts.push(wav)
      }
      const merged = concatWav(parts)
      if (!merged.byteLength) throw new Error(zh ? '合并音频失败' : 'Failed to merge audio')
      blob = new Blob([merged], { type: 'audio/wav' })
      ext = 'wav'
    } else {
      synthStatus.value = zh ? '正在请求 TTS 服务…' : 'Requesting TTS service…'
      await nextTick()
      const r = await synthRemote(text)
      const mime = r.mime || (r.format === 'wav' ? 'audio/wav' : r.format === 'mp3' ? 'audio/mpeg' : 'audio/*')
      blob = new Blob([r.buffer], { type: mime })
      ext = r.format
    }
    const sizeKB = blob.size / 1024
    synthUrl.value = URL.createObjectURL(blob)
    synthExt.value = ext
    synthProgress.value = 100
    synthPhase.value = 'done'
    synthStatus.value = zh ? `生成完成 · ${sizeKB.toFixed(1)} KB` : `Done · ${sizeKB.toFixed(1)} KB`
  } catch (e: any) {
    if (synthCancelled) {
      synthPhase.value = 'idle'
      synthStatus.value = ''
      synthProgress.value = 0
    } else {
      synthPhase.value = 'error'
      synthStatus.value = (zh ? '生成失败：' : 'Failed: ') + (e?.message || String(e))
    }
  }
}

// 取消合成
function stopSynth() {
  synthCancelled = true
  synthStatus.value = store.locales === 'zh' ? '正在取消…' : 'Cancelling…'
}

// 下载生成的音频
function downloadAudio() {
  if (!synthUrl.value) return
  const a = document.createElement('a')
  a.href = synthUrl.value
  a.download = `tts-${Date.now()}.${synthExt.value || 'wav'}`
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// 组件卸载时销毁生成的音频 Blob URL，避免离开设置页后内存泄漏
// （重新生成时的清理在 generateAudio() 开头；停留在页面时需保留 URL 供预览/下载）
onUnmounted(() => {
  if (synthUrl.value) {
    URL.revokeObjectURL(synthUrl.value)
    synthUrl.value = ''
  }
})
</script>

<template>
  <div class="settings-group">
    <h3>{{ store.locales=='zh'?'语音合成设置' : 'Text-to-Speech Settings' }}</h3>

    <!-- TTS类型选择 -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'语音类型' : 'TTS Type' }}</label>
      <select v-model="store.AIconfig.tts.type" @change="store.saveConfig">
        <option v-for="ttsType in ttsTypes" :key="ttsType.value" :value="ttsType.value">
          {{ getTTSLabel(ttsType.value) }}
        </option>
      </select>
    </div>

    <!-- 自动朗读：助手回复生成完后自动念出来（所有引擎通用；见 home.vue 的 completeAssistantReply） -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'自动朗读' : 'Auto speak' }}</label>
      <label class="check-line">
        <input type="checkbox" v-model="store.AIconfig.tts.autoSpeak" @change="store.saveConfig"/>
        <span>{{ store.locales=='zh'?'助手回复生成完后自动朗读（只念当前会话）' : 'Speak assistant replies automatically (current chat only)' }}</span>
      </label>
    </div>

    <!-- 本地TTS设置 -->
    <div v-if="store.AIconfig.tts.type === '本地'">
      <div class="form-group">
        <div class="engine-hint">{{ localEngineHint }}</div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'语音设置' : 'Voice Settings' }}</label>
        <div class="voice-settings">
          <div class="form-group">
            <label>{{ store.locales=='zh'?'语速' : 'Speech Rate' }}</label>
            <input type="range" v-model="store.AIconfig.tts.rate" min="0.5" max="2" step="0.1" />
            <span class="range-value">{{ store.AIconfig.tts.rate || 1.0 }}</span>
          </div>
          <div class="form-group">
            <label>{{ store.locales=='zh'?'音高' : 'Pitch' }}</label>
            <input type="range" v-model="store.AIconfig.tts.pitch" min="0.5" max="2" step="0.1" />
            <span class="range-value">{{ store.AIconfig.tts.pitch || 1.0 }}</span>
          </div>
        </div>
      </div>
    </div>
    <!-- indexTTS2设置 -->
    <div v-if="store.AIconfig.tts.type === 'indexTTS2'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'TTS服务地址' : 'TTS Service URL' }}</label>
        <input v-model="store.AIconfig.tts.url" :title="(store.locales=='zh'?'IndexTTS2服务地址，默认为http://localhost:9880/' : 'IndexTTS2 service URL')" :placeholder="store.locales=='zh'?'请输入TTS服务地址' : 'Enter TTS service URL'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'音色' : 'Voice' }}</label>
        <input v-model="store.AIconfig.tts.voice" :title="store.locales=='zh'?'例如: mazhao, zh-CN-YunxiNeural 等' : 'Example: mazhao, zh-CN-YunxiNeural, etc.'" :placeholder="store.locales=='zh'?'请输入音色名称' : 'Enter voice name'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'语言' : 'Language' }}</label>
        <input v-model="store.AIconfig.tts.language" :placeholder="store.locales=='zh'?'例如: zh, en 等' : 'Example: zh, en, etc.'"/>
      </div>
      <div v-if="store.AIconfig.tts.type === 'indexTTS2'" class="form-group">
        <label>{{ store.locales=='zh'?'情感参数' : 'Emotion Parameter' }}</label>
        <input v-model="store.AIconfig.tts.emo" :placeholder="store.locales=='zh'?'可选情感参数' : 'Optional emotion parameter'"/>
      </div>
      <div v-if="store.AIconfig.tts.type === 'indexTTS2'" class="form-group">
        <label>{{ store.locales=='zh'?'权重参数' : 'Weight Parameter' }}</label>
        <input type="number" v-model="store.AIconfig.tts.weight" min="0" max="1" step="0.1" :placeholder="store.locales=='zh'?'0-1之间的权重' : 'Weight between 0-1'"/>
      </div>
    </div>
    <!-- Qwen3-TTS设置：本地 Qwen3-TTS-AllinOne（Gradio 7862 / 直连 9880）或 GPUStack（OpenAI 兼容，局域网） -->
    <div v-if="store.AIconfig.tts.type === 'Qwen3-TTS'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'接入方式' : 'Deployment' }}</label>
        <select v-model="qwen3Deploy" @change="onDeployChanged">
          <option value="local">{{ store.locales=='zh'?'本地 / 自建 Qwen3-TTS（Gradio 7862 · 直连 9880）' : 'Local / self-hosted Qwen3-TTS (Gradio 7862 · API 9880)' }}</option>
          <option value="gpustack">{{ store.locales=='zh'?'GPUStack（局域网 · OpenAI 兼容）' : 'GPUStack (LAN · OpenAI-compatible)' }}</option>
        </select>
      </div>

      <template v-if="qwen3Deploy === 'local'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'服务地址' : 'Service URL' }}</label>
        <input v-model="store.AIconfig.tts.url" @change="onQwen3EndpointChanged"
               :title="store.locales=='zh'?'Gradio 网页服务默认 http://127.0.0.1:7862；直连接口默认 http://127.0.0.1:9880' : 'Gradio web UI defaults to http://127.0.0.1:7862; direct API defaults to http://127.0.0.1:9880'"
               :placeholder="'http://127.0.0.1:7862'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'接口协议' : 'Protocol' }}</label>
        <select v-model="store.AIconfig.tts.qwen3.protocol" @change="onQwen3EndpointChanged">
          <option value="auto">{{ store.locales=='zh'?'自动识别（按地址探测）' : 'Auto detect' }}</option>
          <option value="gradio">{{ store.locales=='zh'?'Gradio 网页服务（/do_job）' : 'Gradio web UI (/do_job)' }}</option>
          <option value="api">{{ store.locales=='zh'?'直连接口（一次 POST）' : 'Direct API (single POST)' }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'音色' : 'Voice' }}</label>
        <div class="input-with-button">
          <select v-if="qwen3Voices.length" v-model="store.AIconfig.tts.voice" @change="store.saveConfig" style="flex:1; min-width:0;">
            <option v-for="v in qwen3Voices" :key="v" :value="v">{{ v }}</option>
          </select>
          <input v-else v-model="store.AIconfig.tts.voice" @change="store.saveConfig"
                 :placeholder="store.locales=='zh'?'先点刷新拉取音色，或直接填写音色名' : 'Refresh to load voices, or type a voice name'"/>
          <div class="button" style="width:32px;" @click="refreshQwen3Voices(false)"
               :title="store.locales=='zh'?'刷新音色列表（/update_voices）' : 'Refresh voice list (/update_voices)'">
            <i :class="qwen3VoicesLoading ? 'fa fa-spinner fa-spin' : 'fa fa-refresh'"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'语言' : 'Language' }}</label>
        <select v-model="qwen3Lang">
          <option v-for="l in qwen3Langs" :key="l.value" :value="l.value">{{ store.locales=='zh' ? l.zh : l.en }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'模型类型' : 'Model' }}</label>
        <select v-model="store.AIconfig.tts.qwen3.modelType" @change="store.saveConfig">
          <option value="0.6B">{{ store.locales=='zh'?'0.6B（小参数，更快）' : '0.6B (small, faster)' }}</option>
          <option value="1.7B">{{ store.locales=='zh'?'1.7B（大参数，更好）' : '1.7B (large, better)' }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'语速' : 'Speed' }}</label>
        <input type="range" min="0.5" max="2" step="0.05" v-model.number="store.AIconfig.tts.qwen3.speed" @change="store.saveConfig"/>
        <span class="range-value">{{ (store.AIconfig.tts.qwen3.speed || 1).toFixed(2) }}</span>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'分段大小' : 'Chunk size' }}</label>
        <input type="number" min="100" max="900" step="50" v-model.number="store.AIconfig.tts.qwen3.chunkSize" @change="store.saveConfig"/>
        <span class="config-description">{{ store.locales=='zh'?'越大上下文一致性越好，但可能爆显存' : 'Larger = better context, more VRAM' }}</span>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'并行批次' : 'Batch size' }}</label>
        <input type="number" min="1" max="32" step="1" v-model.number="store.AIconfig.tts.qwen3.batch" @change="store.saveConfig"/>
        <span class="config-description">{{ store.locales=='zh'?'显存小就改 1（彻底串行）' : 'Set 1 to serialize on small VRAM' }}</span>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'连接' : 'Connection' }}</label>
        <div class="button-group">
          <div class="button" @click="testQwen3Connection" :title="store.locales=='zh'?'探测接口并拉取音色列表' : 'Probe the transport and fetch voices'">
            <i class="fa fa-plug"></i> {{ store.locales=='zh'?'测试连接' : 'Test connection' }}
          </div>
          <div class="button" @click="refreshQwen3Voices(false)" :title="store.locales=='zh'?'刷新音色列表' : 'Refresh voice list'">
            <i :class="qwen3VoicesLoading ? 'fa fa-spinner fa-spin' : 'fa fa-refresh'"></i> {{ store.locales=='zh'?'刷新音色' : 'Refresh voices' }}
          </div>
        </div>
      </div>

      <!-- 本地服务：安装目录 + 启动/停止（等价于手动双击「开始_自动启动接口服务.bat」） -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'安装目录' : 'Install folder' }}</label>
        <div class="input-with-button">
          <input v-model="qwen3InstallDir" @change="store.saveConfig"
                 :placeholder="'D:\\AI\\Qwen3-TTS-AllinOne'"
                 :title="store.locales=='zh'?'Qwen3-TTS-AllinOne 的根目录（含 py312 与 app.py）' : 'Root folder of Qwen3-TTS-AllinOne (contains py312 and app.py)'"/>
          <div class="button" style="width:32px;" @click="pickQwen3InstallDir" :title="store.locales=='zh'?'选择文件夹' : 'Select folder'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'本地服务' : 'Local service' }}</label>
        <div class="button-group">
          <div class="button" :class="{ active: qwen3ServiceRunning, disabled: qwen3ServiceBusy }" @click="startQwen3Service"
               :title="store.locales=='zh'?'按上面的安装目录启动 Qwen3-TTS 服务（不用再开 cmd）' : 'Start the Qwen3-TTS service from the folder above (no cmd needed)'">
            <i :class="qwen3ServiceBusy ? 'fa fa-spinner fa-spin' : 'fa fa-play'"></i>
            {{ store.locales=='zh'?'启动服务' : 'Start service' }}
          </div>
          <div class="button" :class="{ disabled: qwen3ServiceBusy }" @click="stopQwen3Service"
               :title="store.locales=='zh'?'停止本应用启动的服务' : 'Stop the service started by this app'">
            <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止服务' : 'Stop service' }}
          </div>
        </div>
      </div>
      <div class="form-group">
        <label></label>
        <div class="config-description" style="margin-left:0;">
          {{ qwen3ServiceRunning
            ? (store.locales=='zh'?'● 服务运行中（本应用启动）' : '● Service running (started by this app)')
            : (store.locales=='zh'?'○ 本应用未启动服务（手动开的服务也能照常连接）' : '○ Service not started by this app (an external one still works)') }}
        </div>
      </div>
      <div class="form-group">
        <label></label>
        <label class="check-line">
          <input type="checkbox" v-model="qwen3AutoStart" @change="store.saveConfig"/>
          <span>{{ store.locales=='zh'?'随软件启动自动拉起服务（首次会加载模型，较慢）' : 'Start the service with the app (model load takes a while)' }}</span>
        </label>
      </div>
      <div v-if="qwen3ServiceHint || store.AIconfig.tts.qwen3.serviceError" class="form-group">
        <label></label>
        <div class="config-description" style="margin-left:0; line-height:1.5;"
             :class="{ 'qwen3-error': !!(store.AIconfig.tts.qwen3.serviceError && !qwen3ServiceHint) }">
          {{ qwen3ServiceHint || store.AIconfig.tts.qwen3.serviceError }}
        </div>
      </div>
      <div v-if="qwen3ServiceLog" class="form-group qwen3-log-row">
        <label></label>
        <pre class="qwen3-log">{{ qwen3ServiceLog }}</pre>
      </div>

      <div class="form-group">
        <label></label>
        <div class="config-description" style="margin-left:0; line-height:1.5;">{{ qwen3Hint }}</div>
      </div>
      <!-- 音色列表拉取失败的原因（静默自动拉取时也能看到，不用非点刷新） -->
      <div v-if="store.AIconfig.tts.qwen3.voicesError" class="form-group">
        <label></label>
        <div class="config-description qwen3-error" style="margin-left:0;">⚠ {{ store.AIconfig.tts.qwen3.voicesError }}</div>
      </div>
      </template>

      <!-- GPUStack：局域网部署的 Qwen3-TTS，走 OpenAI 兼容 /v1-openai/audio/speech -->
      <template v-else>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'服务地址' : 'Server URL' }}</label>
          <input v-model="gpustackConfig.url" @change="onGpuStackEndpointChanged"
                 :title="store.locales=='zh'?'GPUStack 服务地址（可带 /v1-openai 或尾斜杠）；局域网填它的内网 IP，如 http://192.168.1.10:8080' : 'GPUStack server URL (a trailing /v1-openai or slash is fine); use the LAN IP, e.g. http://192.168.1.10:8080'"
                 :placeholder="'http://192.168.1.10:8080'"/>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'API 密钥' : 'API Key' }}</label>
          <input type="password" v-model="gpustackConfig.apiKey" @change="store.saveConfig"
                 :title="store.locales=='zh'?'GPUStack 的 API Key（在 GPUStack 界面「API Key 管理」里生成）；没开鉴权就留空' : 'GPUStack API key (create it in GPUStack → API Key Management); leave empty if auth is off'"
                 :placeholder="store.locales=='zh'?'没开鉴权可留空' : 'Leave empty if auth is off'"/>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'模型' : 'Model' }}</label>
          <div class="input-with-button">
            <select v-if="gpuStackModels.length" v-model="gpustackConfig.model" @change="onGpuStackModelChanged" style="flex:1; min-width:0;">
              <option v-for="m in gpuStackModels" :key="m" :value="m">{{ m }}</option>
            </select>
            <input v-else v-model="gpustackConfig.model" @change="onGpuStackModelChanged"
                   :placeholder="store.locales=='zh'?'如 qwen3-tts（点刷新从 GPUStack 列表选择）' : 'e.g. qwen3-tts (refresh to pick from GPUStack)'"/>
            <div class="button" style="width:32px;" @click="refreshGpuStackModels(false)"
                 :title="store.locales=='zh'?'从 /v1-openai/models 刷新模型列表' : 'Refresh models from /v1-openai/models'">
              <i :class="gpuStackModelsLoading ? 'fa fa-spinner fa-spin' : 'fa fa-refresh'"></i>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'音色' : 'Voice' }}</label>
          <div class="input-with-button">
            <select v-if="gpuStackVoices.length" v-model="gpustackConfig.voice" @change="store.saveConfig" style="flex:1; min-width:0;">
              <option v-for="v in gpuStackVoices" :key="v" :value="v">{{ v }}</option>
            </select>
            <input v-else v-model="gpustackConfig.voice" @change="store.saveConfig"
                   :placeholder="store.locales=='zh'?'留空 = 服务端默认音色，也可手填' : 'Empty = server default; or type a voice'"/>
            <div class="button" style="width:32px;" @click="refreshGpuStackVoices(false)"
                 :title="store.locales=='zh'?'从 /v1-openai/audio/voices 刷新音色（部分后端没有这个接口）' : 'Refresh voices from /v1-openai/audio/voices (not every backend has it)'">
              <i :class="gpuStackVoicesLoading ? 'fa fa-spinner fa-spin' : 'fa fa-refresh'"></i>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'语言' : 'Language' }}</label>
          <select v-model="gpustackConfig.lang" @change="store.saveConfig">
            <option v-for="l in qwen3Langs" :key="l.value" :value="l.value">{{ store.locales=='zh' ? l.zh : l.en }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'输出格式' : 'Format' }}</label>
          <select v-model="gpustackConfig.responseFormat" @change="store.saveConfig">
            <option value="wav">{{ store.locales=='zh'?'wav（兼容最好）' : 'wav (most compatible)' }}</option>
            <option value="mp3">{{ store.locales=='zh'?'mp3（体积小）' : 'mp3 (smaller)' }}</option>
            <option value="flac">flac</option>
            <option value="opus">opus</option>
          </select>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'语速' : 'Speed' }}</label>
          <input type="range" min="0.25" max="4" step="0.05" v-model.number="gpustackConfig.speed" @change="store.saveConfig"/>
          <span class="range-value">{{ (gpustackConfig.speed || 1).toFixed(2) }}</span>
        </div>
        <div class="form-group">
          <label>{{ store.locales=='zh'?'连接' : 'Connection' }}</label>
          <div class="button-group">
            <div class="button" @click="testQwen3Connection" :title="store.locales=='zh'?'读取模型列表并拉一次音色列表' : 'Read the model list and fetch voices'">
              <i class="fa fa-plug"></i> {{ store.locales=='zh'?'测试连接' : 'Test connection' }}
            </div>
            <div class="button" @click="refreshGpuStackModels(false)" :title="store.locales=='zh'?'刷新模型列表' : 'Refresh models'">
              <i :class="gpuStackModelsLoading ? 'fa fa-spinner fa-spin' : 'fa fa-list'"></i> {{ store.locales=='zh'?'刷新模型' : 'Refresh models' }}
            </div>
            <div class="button" @click="refreshGpuStackVoices(false)" :title="store.locales=='zh'?'刷新音色列表' : 'Refresh voices'">
              <i :class="gpuStackVoicesLoading ? 'fa fa-spinner fa-spin' : 'fa fa-refresh'"></i> {{ store.locales=='zh'?'刷新音色' : 'Refresh voices' }}
            </div>
          </div>
        </div>

        <div class="form-group">
          <label></label>
          <div class="config-description" style="margin-left:0; line-height:1.5;">{{ qwen3Hint }}</div>
        </div>
        <!-- 模型 / 音色列表拉取失败的原因（静默自动拉取时也能看到） -->
        <div v-if="gpustackConfig.modelsError" class="form-group">
          <label></label>
          <div class="config-description qwen3-error" style="margin-left:0;">⚠ {{ gpustackConfig.modelsError }}</div>
        </div>
        <div v-if="gpustackConfig.voicesError" class="form-group">
          <label></label>
          <div class="config-description qwen3-error" style="margin-left:0;">⚠ {{ gpustackConfig.voicesError }}</div>
        </div>
      </template>
    </div>

    <!-- 本地 ONNX TTS 设置（Kokoro / Piper，主进程 sherpa-onnx 离线合成） -->
    <div v-if="store.AIconfig.tts.type === 'Kokoro' || store.AIconfig.tts.type === 'Piper'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'模型目录' : 'Model Folder' }}</label>
        <div class="input-with-button">
          <input v-model="store.AIconfig.tts.onnx.modelDir"
                 :placeholder="store.locales=='zh'?'选择解压后的模型文件夹' : 'Select the extracted model folder'"
                 @change="onModelDirInput"/>
          <div class="button" style="width:20px;" @click="selectOnnxModelDir" :title="store.locales=='zh'?'选择文件夹' : 'Select folder'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <!-- 加载模型 / 状态提示（合并按钮与状态为一体，点击加载/重新加载） -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'加载模型' : 'Load Model' }}</label>
        <div class="onnx-model-status clickable"
             :class="{ loading: store.AIconfig.tts.onnx.loading, error: !!store.AIconfig.tts.onnx.error && !store.AIconfig.tts.onnx.modelLoaded }"
             :title="store.locales=='zh'?'点击加载/重新校验模型' : 'Click to load / verify model'"
             @click="handleLoadOnnxTTS">
          <i :class="store.AIconfig.tts.onnx.loading
              ? 'fa fa-spinner fa-spin'
              : (store.AIconfig.tts.onnx.modelLoaded ? 'fa fa-check-circle' : (store.AIconfig.tts.onnx.error ? 'fa fa-times-circle' : 'fa fa-download'))"></i>
          <span>{{ onnxStatusText }}</span>
        </div>
      </div>
      <!-- Kokoro 语言 -->
      <div v-if="store.AIconfig.tts.type === 'Kokoro'" class="form-group">
        <label>{{ store.locales=='zh'?'语言' : 'Language' }}</label>
        <select v-model="store.AIconfig.tts.onnx.lang"
                @change="store.updateOnnxTTS({ lang: store.AIconfig.tts.onnx.lang, modelLoaded: false })">
          <option value="en">{{ store.locales=='zh'?'英文（中英混合，推荐）' : 'English (Mixed, recommended)' }}</option>
          <option value="zh">{{ store.locales=='zh'?'中文（仅中文）' : 'Chinese (Chinese only)' }}</option>
        </select>
      </div>
      <!-- 音色 ID -->
      <div class="form-group">
        <label>
          {{ store.locales=='zh'?'音色 ID' : 'Speaker ID' }}
          <span class="sid-range">{{ store.locales=='zh'?'0 ~ ' + speakerMax : '0 ~ ' + speakerMax }}</span>
        </label>
        <input type="number" v-model.number="store.AIconfig.tts.onnx.sid" min="0"
               :max="speakerMax" step="1"
               @change="store.updateOnnxTTS({ sid: store.AIconfig.tts.onnx.sid })"/>
      </div>
      <!-- 语速 -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'语速' : 'Speed' }}</label>
        <input type="range" v-model.number="store.AIconfig.tts.onnx.speed" min="0.5" max="2" step="0.05"
               @change="store.updateOnnxTTS({ speed: store.AIconfig.tts.onnx.speed })"/>
        <span class="range-value">{{ store.AIconfig.tts.onnx.speed || 1.0 }}</span>
      </div>
    </div>

    <!-- 测试按钮 -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'测试' : 'Test' }}</label>
      <div class="button-group">
        <div class="button" @click="testTTS" :title="store.locales=='zh'?'测试语音合成' : 'Test TTS function'">
          <i class="fa fa-volume-up"></i> {{ store.locales=='zh'?'测试语音' : 'Test TTS' }}
        </div>
        <div class="button" @click="store.stopTTS" :title="store.locales=='zh'?'停止当前语音' : 'Stop current TTS'">
          <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止语音' : 'Stop TTS' }}
        </div>
      </div>
    </div>

    <!-- 文本合成（生成 / 下载音频 + 进度，置于最下方，样式与上方一致） -->
    <template v-if="canGenerateFile">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'合成文本' : 'Text' }}</label>
        <textarea v-model="synthText" class="synth-textarea scoll" rows="6"
                  :placeholder="store.locales=='zh'?'输入要合成的文字…' : 'Type text to synthesize…'"></textarea>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'操作' : 'Actions' }}</label>
        <div class="button-group">
          <div class="button" :class="{ active: synthPhase === 'synth', disabled: synthPhase === 'synth' }" @click="generateAudio">
            <i :class="synthPhase === 'synth' ? 'fa fa-spinner fa-spin' : 'fa fa-music'"></i>
            {{ synthPhase === 'synth'
              ? (store.locales=='zh'?'合成中…' : 'Synthesizing…')
              : (store.locales=='zh'?'生成音频' : 'Generate Audio') }}
          </div>
          <div v-if="synthPhase === 'synth'" class="button" @click="stopSynth">
            <i class="fa fa-stop"></i> {{ store.locales=='zh'?'取消' : 'Cancel' }}
          </div>
          <div class="button" :class="{ active: synthPhase === 'done', disabled: synthPhase !== 'done' }" @click="downloadAudio">
            <i class="fa fa-download"></i> {{ store.locales=='zh'?'下载音频' : 'Download' }}
          </div>
        </div>
      </div>
      <!-- 进度条（百分比） -->
      <div v-if="synthPhase === 'synth' || synthPhase === 'done' || synthPhase === 'error'" class="form-group synth-progress-row">
        <label>{{ store.locales=='zh'?'进度' : 'Progress' }}</label>
        <div class="synth-progress">
          <div class="synth-progress-bar">
            <div class="synth-progress-fill" :class="{ error: synthPhase === 'error' }" :style="{ width: synthProgress + '%' }"></div>
          </div>
          <span class="synth-progress-text">{{ synthPhase === 'error' ? '—' : synthProgress + '%' }}</span>
        </div>
      </div>
      <!-- 状态信息 -->
      <div v-if="synthStatus" class="form-group">
        <label></label>
        <div class="config-description synth-status" style="margin-left:0;">{{ synthStatus }}</div>
      </div>
      <!-- 音频预览 -->
      <div v-if="synthUrl" class="form-group">
        <label>{{ store.locales=='zh'?'预览' : 'Preview' }}</label>
        <audio :src="synthUrl" controls style="flex:1; height:32px;"></audio>
      </div>
    </template>
    <!-- 模型下载指引 -->
    <div class="form-group">
        <label></label>
        <div class="config-description" style="margin-left:0; line-height:1.5;">
          {{ onnxHint }}
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
  margin-bottom: 5px;
}

/* 统一清零 form-group 内元素的 margin（防止全局样式污染导致行高超出） */
.form-group > * {
  margin: 0;
}

.form-group:last-child {
  margin-bottom: 0;
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
  flex: 1;
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  margin: 0px;
}
/* 下拉框用正常背景色（不用菜单底色） */
.form-group select {
  background-color: var(--backgroundColor);
}

/* 仅合成文本框：垂直缩放 + 最小高度（不影响其它输入框/下拉框高度） */
.form-group textarea.synth-textarea {
  resize: vertical;
  min-height: 60px;
  line-height: 1.5;
  font-family: inherit;
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

/* 配置描述文本 */
.config-description {
  flex: 1;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  margin-left: 5px;
}

/* Qwen3-TTS 音色列表拉取失败提示（比普通说明更显眼） */
.config-description.qwen3-error {
  opacity: 1;
  color: #e6a23c;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
}

/* 复选框 + 说明文字一行（自动朗读 / 随软件启动） */
.check-line {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--fontColor);
  opacity: 0.85;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
}
.check-line input[type="checkbox"] {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
}

/* Qwen3-TTS 服务启动日志（失败时看这里） */
.form-group.qwen3-log-row {
  align-items: flex-start;
}
.qwen3-log {
  flex: 1;
  min-width: 0;
  max-height: 140px;
  overflow: auto;
  margin: 0;
  padding: 6px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  opacity: 0.85;
}

/* 语音设置 */
.voice-settings {
  width: 100%;
}

.range-value {
  min-width: 40px;
  text-align: center;
  color: var(--fontColor);
  font-size: 14px;
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

/* ONNX 模型状态（合并加载按钮与状态提示：可点击，加载/就绪/错误三态） */
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

.onnx-model-status i {
  font-size: 16px;
}

.onnx-model-status.clickable {
  cursor: pointer;
  user-select: none;
  transition: opacity 0.15s ease;
}

.onnx-model-status.clickable:hover {
  opacity: 0.85;
}

.onnx-model-status.loading {
  background-color: rgba(52, 152, 219, 0.1);
  border: 1px solid rgba(52, 152, 219, 0.2);
  color: #3498db;
}

.onnx-model-status.error {
  background-color: rgba(231, 76, 60, 0.1);
  border: 1px solid rgba(231, 76, 60, 0.2);
  color: #e74c3c;
}

/* 音色范围小字（并入音色 ID 标签） */
.sid-range {
  font-size: 11px;
  opacity: 0.7;
  margin-left: 2px;
  font-weight: 400;
}

/* 按钮禁用态 */
.button.disabled {
  opacity: 0.55;
  pointer-events: none;
}

/* 进度条 */
.synth-progress-row {
  margin-top: 4px;
}

.synth-progress {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.synth-progress-bar {
  flex: 1;
  height: 10px;
  border-radius: 5px;
  background-color: rgba(128, 128, 128, 0.25);
  overflow: hidden;
}

.synth-progress-fill {
  height: 100%;
  width: 0%;
  border-radius: 5px;
  background: var(--fontActiveColor);
  transition: width 0.2s ease;
}

.synth-progress-fill.error {
  background: #e74c3c;
}

.synth-progress-text {
  min-width: 44px;
  text-align: right;
  font-size: 12px;
  color: var(--fontColor);
  font-variant-numeric: tabular-nums;
}

.synth-status {
  margin-left: 0;
  white-space: pre-wrap;
}
</style>
