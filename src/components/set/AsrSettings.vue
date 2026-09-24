<!-- AsrSettings.vue - 语音输入（ASR）设置（从 Set.vue 拆分出的独立组件，样式自带，与设置页一致） -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'

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
  if (!window.ipcRenderer) return
  const d = await window.ipcRenderer.invoke('openFolderDialog')
  if (d) {
    store.AIconfig.asr.funasr.dir = d
    store.saveConfig()
  }
}

async function selectFunasrRefine() {
  if (!window.ipcRenderer) return
  const f = await window.ipcRenderer.invoke('selectFile', {
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
  if (!window.ipcRenderer) return
  const d = await window.ipcRenderer.invoke('openFolderDialog')
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
    // 通知主进程更新快捷键
    if (window.ipcRenderer) {
      window.ipcRenderer.invoke('registerASRShortcut', store.AIconfig.asr.shortcut).catch(() => {})
    }
  }
}

// 重置快捷键
function resetShortcut() {
  store.AIconfig.asr.shortcut = 'Ctrl+Shift+Space'
  store.saveConfig()
  if (window.ipcRenderer) {
    window.ipcRenderer.invoke('registerASRShortcut', store.AIconfig.asr.shortcut).catch(() => {})
  }
}

// 选择 ONNX 模型文件
async function selectOnnxModel() {
  try {
    // 如果支持 Electron 文件对话框
    if (window.ipcRenderer) {
      const result = await window.ipcRenderer.invoke('selectFile', {
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

// 组件挂载时注册 ASR 快捷键（后台录音快捷键由 home.vue 全局注册，这里作为设置页打开时的兜底）
onMounted(() => {
  if (window.ipcRenderer && store.AIconfig.asr.shortcut) {
    window.ipcRenderer.invoke('registerASRShortcut', store.AIconfig.asr.shortcut).catch(() => {})
  }
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

    <!-- 快捷按键 -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'快捷按键' : 'Shortcut Key' }}</label>
      <div class="shortcut-input">
        <input 
          v-model="store.AIconfig.asr.shortcut" 
          :placeholder="store.locales=='zh'?'按住说话快捷键（如：Ctrl+Shift+Space）' : 'Push-to-talk shortcut (e.g. Ctrl+Shift+Space)'"
          @keydown="captureShortcut"
          readonly
        />
        <div class="button" style="width:25px;" @click="resetShortcut" 
            :title="store.locales=='zh'?'重置快捷键' : 'Reset shortcut'">
          <i class="fa fa-undo"></i>
        </div>
      </div>
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
          <select v-model="store.AIconfig.asr.qwen3.mode" @change="store.saveConfig">
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
          <div class="config-description">
            {{ store.locales=='zh'?'流式（分段准实时）：按住说话时，一停顿超过「停顿切段」就把这一段送去识别，文字边说边出；一直不停顿则到「单段最长」（上限 3 分钟）强切。切点保留「切点重叠」音频，避免切在字中间丢音。注意：该模型本身是整段模型，所以是「说完一句、停顿后约 0.5~1.5 秒出字」，不是逐字上屏；停顿设得太短会切断长句。' : 'Streaming (segmented): while you hold, each pause longer than “Cut on pause” sends that segment for recognition, so text appears as you speak; without pauses it force-cuts at “Max segment length” (up to 3 min). “Cut overlap” keeps audio around each cut point so no syllable is lost. The model itself is offline/whole-utterance, so expect text ~0.5–1.5s after each pause, not per-character streaming; too-short pauses will split long sentences.' }}
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
      <div class="config-description usage-guide">
        {{ store.locales=='zh'?'Qwen3-ASR 本地网页服务默认地址 http://127.0.0.1:7867（按手册 /run 接口调用：自动上传音频并取回识别文本，支持 30 种语言 + 22 种方言与自动语种识别）。若使用 vLLM / Docker 部署的 OpenAI 兼容服务，地址填 http://localhost:8000/v1/audio/transcriptions 并选「OpenAI 兼容」（仅支持整段识别）。' : 'Qwen3-ASR local web UI default URL is http://127.0.0.1:7867 (called through the documented /run API: audio is uploaded and the recognized text is returned; supports 30 languages + 22 Chinese dialects with auto language ID). For a vLLM/Docker OpenAI-compatible server, set the URL to http://localhost:8000/v1/audio/transcriptions and pick "OpenAI-compatible" (whole-utterance only).' }}
      </div>
    </div>

    <!-- 测试按钮 -->
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
                :placeholder="store.locales=='zh'?'选择含 model_quant.onnx / decoder_quant.onnx / config.yaml 的目录' : 'Dir with model_quant.onnx / decoder_quant.onnx / config.yaml'"
                @change="store.saveConfig"/>
          <div class="button" style="width:25px;" @click="pickFunasrModelDir"
              :title="store.locales=='zh'?'选择模型目录' : 'Select model directory'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'离线精修模型（可选，两遍精修）' : 'Offline refine model (optional)' }}</label>
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
        <label>{{ store.locales=='zh'?'批处理标点阈值（字）' : 'Punct batch threshold (chars)' }}</label>
        <input type="number" min="0" max="500" step="10" v-model.number="store.AIconfig.asr.funasr.punctMin" @change="store.saveConfig" />
        <div class="config-description">
          {{ store.locales=='zh'?'仅在「标点校验模式=大模型」时生效：原文先实时显示，攒够此字数后由大模型一次性补标点并整体替换；0=关闭批处理（每句都校验）。“普通校验（本地标点模型）”不受此限制，句子落定即即时补标点。' : 'Only applies when Punctuation Mode = LLM: show raw text live, then batch-punctuate once this many chars accumulate; 0 = per-sentence. Local ct-punc (Normal mode) punctuates every committed sentence immediately regardless of this value.' }}
        </div>
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
      <div class="config-description usage-guide">
        {{ store.locales=='zh'?'FunASR 官方流式 Paraformer（online）：按住说话实时出字，松开出完整文本。首次使用会加载 ~230MB 双模型；下方「按住说话测试」可边听边验证。开启自动断句后，说完一句停顿约 0.9s 会自动落一句；如配置离线精修模型，松开时会对最后一句做整段二次识别替换。' : 'FunASR official streaming Paraformer (online). First use loads ~230MB models; try the "Hold to Test" button below. With auto-VAD, pausing ~0.9s commits a sentence and keeps listening; if an offline refine model is set, the last utterance is re-recognized on release (2-pass).' }}
      </div>
    </div>
    <!-- 标点校验模式（全局，对所有识别引擎生效） -->
    <div class="form-group">
      <label>{{ store.locales=='zh'?'标点校验模式' : 'Punctuation Mode' }}</label>
      <select v-model="store.AIconfig.asr.punctMode" @change="store.saveConfig">
        <option value="none">{{ store.locales=='zh'?'无校验' : 'None' }}</option>
        <option value="local">{{ store.locales=='zh'?'普通校验（本地标点模型，离线）' : 'Normal (local ct-punc, offline)' }}</option>
        <option value="llm">{{ store.locales=='zh'?'大模型校验（纠错 + 补标点，需已连接大模型）' : 'LLM proofread + punctuation (LLM must be connected)' }}</option>
      </select>
      <div class="config-description" v-if="store.AIconfig.asr.punctMode === 'local'">
        {{ store.locales=='zh'?'普通校验 = 本地 ct-punc（CT-Transformer 标点恢复）模型：识别完成后离线补标点，无需联网与大模型，对任意识别引擎生效。' : 'Normal = local ct-punc (CT-Transformer) model: punctuate offline after recognition, works with any ASR engine, no network/LLM needed.' }}
      </div>
      <div class="config-description" v-else-if="store.AIconfig.asr.punctMode === 'llm'">
        {{ store.locales=='zh'?'大模型校验会对识别文字做错字修正并补全标点；开启后 funasr-online 可用下方“批处理标点阈值”节流（攒够字数一次性处理）。' : 'LLM mode also fixes misheard characters. With funasr-online you can use the batch punct threshold below to process text in batches.' }}
      </div>
    </div>
    <!-- 本地标点模型目录（punctMode=local，全局） -->
    <div class="form-group" v-if="store.AIconfig.asr.punctMode === 'local'">
      <label>{{ store.locales=='zh'?'本地标点模型目录（ct-punc）' : 'Local punct model dir (ct-punc)' }}</label>
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
    <!-- 使用方法 -->
    <div class="config-description usage-guide">
      {{ store.locales=='zh'?'使用方法：① 选择识别引擎并配置下方相应参数；② 设置快捷按键；③ 按住快捷键说话即可识别（应用在后台也可用）；④ 点击上方「按住说话测试」可验证效果。' : 'How to use: 1) Choose an ASR engine and configure the options below; 2) Set the shortcut key; 3) Press and hold the shortcut to talk (works even when the app is in background); 4) Click the "Hold to Test" button above to verify.' }}
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
  flex-wrap: wrap;
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
  margin: 0px
}
/* 下拉框用正常背景色（不用菜单底色） */
.form-group select {
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

/* 配置描述文本：位于输入元素下方一行 */
.config-description {
  flex-basis: 100%;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  margin: 0;
  padding-left: 135px; /* 与 label 宽度对齐，缩进到输入框正下方 */
  box-sizing: border-box;
}

/* 底部使用方法说明：全宽显示 */
.config-description.usage-guide {
  padding-left: 0;
  margin-top: 10px;
  padding-top: 6px;
  border-top: 1px dashed var(--borderColor);
  line-height: 1.6;
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
  font-size: 14px;
  color: var(--fontColor);
}

.checkbox-label input[type="checkbox"] {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
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
  width: 16px !important;
  height: 16px !important;
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
