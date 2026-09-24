<!-- TtsSettings.vue - 语音合成（TTS）设置（从 Set.vue 拆分出的独立组件，样式自带，与设置页一致） -->
<script setup lang="ts">
import { computed, ref, nextTick, onUnmounted } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'

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
    if (!window.ipcRenderer) {
      ElMessage.warning(store.locales === 'zh' ? '仅在 Electron 应用中可用' : 'Only available in Electron app')
      return
    }
    const dir = await window.ipcRenderer.invoke('openFolderDialog')
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

// Kokoro / Piper：调用主进程 sherpa-onnx 合成一段，返回 WAV 字节
async function synthOnnxChunk(text: string): Promise<Uint8Array | null> {
  const dsh = (window as any).dsh
  if (!dsh?.tts?.synthesize) return null
  const onnx = store.AIconfig.tts.onnx || {}
  return dsh.tts.synthesize({
    engine: store.AIconfig.tts.type,
    modelDir: onnx.modelDir || '',
    text,
    sid: onnx.sid ?? 0,
    speed: onnx.speed ?? 1.0,
    lang: onnx.lang || undefined,
  })
}

// indexTTS2 / Qwen3-TTS：整段一次请求远程服务，返回音频字节与格式
async function synthRemote(text: string): Promise<{ buffer: ArrayBuffer; format: string }> {
  const zh = store.locales === 'zh'
  const cfg = store.AIconfig.tts
  const isQwen = cfg.type === 'Qwen3-TTS'
  const base = (cfg.url || '').trim()
  if (!base) throw new Error(zh ? '未配置 TTS 服务地址' : 'TTS service URL not configured')
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const url = new URL(isQwen ? base.replace(/\/+$/, '') : base)
  url.searchParams.set('text', cleaned)
  if (cfg.voice) url.searchParams.set('speaker', cfg.voice)
  if (cfg.language) url.searchParams.set('lang', cfg.language)
  if (isQwen) {
    const speed = (cfg as any).qwen3?.speed || cfg.rate || 1.0
    if (speed !== 1.0) url.searchParams.set('speed', String(speed))
    const pitch = (cfg as any).qwen3?.pitch || cfg.pitch || 1.0
    if (pitch !== 1.0) url.searchParams.set('pitch', String(pitch))
  } else {
    if (cfg.emo) url.searchParams.set('emo', cfg.emo)
    if (cfg.weight) url.searchParams.set('weight', String(cfg.weight))
  }
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
      blob = new Blob([r.buffer], { type: r.format === 'wav' ? 'audio/wav' : r.format === 'mp3' ? 'audio/mpeg' : 'audio/*' })
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
      <select v-model="store.AIconfig.tts.type">
        <option v-for="ttsType in ttsTypes" :key="ttsType.value" :value="ttsType.value">
          {{ getTTSLabel(ttsType.value) }}
        </option>
      </select>
    </div>

    <!-- 本地TTS设置 -->
    <div v-if="store.AIconfig.tts.type === '本地'">
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
    <!-- Qwen3-TTS设置 -->
    <div v-if="store.AIconfig.tts.type === 'Qwen3-TTS'">
      <div class="form-group">
        <label>{{ store.locales=='zh'?'TTS服务地址' : 'TTS Service URL' }}</label>
        <input v-model="store.AIconfig.tts.url" :title="(store.locales=='zh'?'Qwen3-TTS服务地址，默认为http://localhost:9880/' : 'Qwen3-TTS service URL')" :placeholder="store.locales=='zh'?'请输入TTS服务地址' : 'Enter TTS service URL'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'音色' : 'Voice' }}</label>
        <input v-model="store.AIconfig.tts.voice" :title="store.locales=='zh'?'例如: mazhao, zh-CN-YunxiNeural 等' : 'Example: mazhao, zh-CN-YunxiNeural, etc.'" :placeholder="store.locales=='zh'?'请输入音色名称' : 'Enter voice name'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'语言' : 'Language' }}</label>
        <input v-model="store.AIconfig.tts.language" :placeholder="store.locales=='zh'?'例如: zh, en 等' : 'Example: zh, en, etc.'"/>
      </div>
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
