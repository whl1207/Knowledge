<template>
  <div class="media-container" :class="{ dark: isDark }" tabindex="0" @keydown.space.prevent="togglePlay">
    <!-- 音频播放器 -->
    <div v-if="isAudio" class="media-card audio-card" ref="audioCardRef"
         :style="{ '--tape-accent': accentColor, '--tape-accent-text': accentText }">
      <!-- 加载中 -->
      <div v-if="loading" class="media-status">
        <i class="fa fa-spinner fa-spin"></i>
        <span>{{ store.locales === 'zh' ? '正在加载音频...' : 'Loading audio...' }}</span>
      </div>

      <!-- 波形加载失败（仍可播放） -->
      <div v-else-if="waveError" class="media-status">
        <i class="fa fa-exclamation-triangle"></i>
        <span>{{ store.locales === 'zh' ? '波形生成失败，仍可正常播放' : 'Waveform unavailable, audio still playable' }}</span>
      </div>

      <template v-else>
        <div class="audio-body" :class="{ 'wave-mode': isWaveMode }">
          <!-- 黑胶模式：黑胶 + 标题/歌词 -->
          <div v-if="displayMode === 'record'" class="audio-main-row">
            <div class="audio-art" :class="{ playing: isPlaying }">
              <img v-if="albumArt" :src="albumArt" class="art-img" alt="cover" />
              <div v-else class="art-fallback">
                <i class="fa fa-music"></i>
                <span class="art-fallback-label">{{ extLabel }}</span>
              </div>
            </div>

            <div class="audio-info">
              <div class="audio-title" :title="fileName">{{ displayName }}</div>
              <div v-if="lyrics.length" class="lyrics-panel" ref="lyricsPanel">
                <div class="lyrics-scroll">
                  <div v-for="(line, i) in lyrics" :key="i" class="lyric-line" :class="{ active: i === activeLyric }">
                    {{ line.text || '♪' }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 磁带模式：黑色金属外壳+螺丝 · 中央贴封面 · 封面内胶囊观察窗 · 下方格栅(歌名/歌词) + 全宽进度条 -->
          <div v-else-if="displayMode === 'tape'" class="tape-stage" :class="{ playing: isPlaying }" ref="tapeStageRef">
              <div class="tape-shell">
                <span class="tape-screw tape-screw-l"></span>
                <span class="tape-screw tape-screw-r"></span>

                <!-- 中央贴的封面 -->
                <div class="tape-cover">
                  <img v-if="albumArt" :src="albumArt" class="tape-cover-img" alt="" />
                  <div v-else class="tape-cover-img tape-cover-fallback"><i class="fa fa-music"></i></div>
                  <!-- 封面内垂直居中的胶囊观察窗：两个卷轴中心对准两端半圆圆心 -->
                  <div class="tape-window">
                    <div class="tape-reel unit-l">
                      <div class="tape-pack"></div>
                      <span class="reel-gear">
                        <i v-for="n in 6" :key="n" class="reel-gear-slot" :style="{ transform: 'rotate(' + ((n - 1) * 60) + 'deg)' }"></i>
                      </span>
                    </div>
                    <div class="tape-reel unit-r">
                      <div class="tape-pack"></div>
                      <span class="reel-gear">
                        <i v-for="n in 6" :key="n" class="reel-gear-slot" :style="{ transform: 'rotate(' + ((n - 1) * 60) + 'deg)' }"></i>
                      </span>
                    </div>
                  </div>
                </div>

                <!-- 下方格栅区：复古磁带格栅样式，只显示当前歌词 -->
                <div class="tape-grille">
                  <div class="tape-meta">
                    <span class="tape-lyric" :title="currentLyricText">{{ currentLyricText }}</span>
                  </div>
                </div>
              </div>
          </div>

          <!-- 波形模式：标题 + 波形（整体峰谷 / 实时频谱） -->
          <template v-else>
            <div class="audio-title wave-title" :title="fileName">{{ displayName }}</div>
            <div class="wave-area">
              <canvas
                ref="waveCanvas"
                class="wave-canvas"
                @mousedown="onWaveMouseDown"
                @mousemove="onWaveHoverMove"
                @mouseleave="onWaveHoverLeave"
              ></canvas>
              <div v-if="hoverVisible" class="wave-tooltip" :style="{ left: hoverX + 'px' }">{{ formatTime(hoverTime) }}</div>
            </div>
            <!-- 波形/频谱下方：当前歌词（有歌词时显示） -->
            <div v-if="waveLyricText" class="wave-lyric" :title="waveLyricText">{{ waveLyricText }}</div>
          </template>
        </div>
      </template>

      <!-- 控制条（加载失败时也显示，保证可播放） -->
      <div class="ctl-bar" ref="ctlBar" :class="{ compact: ctlCompact, 'no-seek': displayMode === 'tape' }">
        <!-- 全宽进度条（黑胶/磁带/波形/频谱通用）：线贴控制栏上沿、圆钮完整（下半伸入控制栏） -->
        <div v-if="!loading && !waveError" class="tape-progress" ref="tapeProgressRef"
             @mousedown="onTapeSeekDown"
             @mouseenter="tapeHover = true"
             @mouseleave="tapeHover = false">
          <span v-if="tapeHover" class="tp-time tp-cur">{{ formatTime(currentTime) }}</span>
          <div class="tp-track">
            <div class="tp-fill" :style="{ width: seekPercent + '%' }"></div>
            <div class="tp-thumb" :style="{ left: seekPercent + '%' }"></div>
          </div>
          <span v-if="tapeHover" class="tp-time tp-dur">{{ formatTime(duration) }}</span>
        </div>
        <button class="ctl-btn nav-btn" @click="playPrev" :title="store.locales==='zh'?'上一首':'Previous'">
          <i class="fa fa-step-backward"></i>
        </button>
        <button class="ctl-btn play-btn" @click="togglePlay" :title="isPlaying ? (store.locales==='zh'?'暂停':'Pause') : (store.locales==='zh'?'播放':'Play')">
          <i :class="isPlaying ? 'fa fa-pause' : 'fa fa-play'"></i>
        </button>
        <button class="ctl-btn nav-btn" @click="playNext" :title="store.locales==='zh'?'下一首':'Next'">
          <i class="fa fa-step-forward"></i>
        </button>
        <div class="ctl-group">
          <div class="volume-ctl">
            <button class="ctl-btn" @click="volume = volume > 0 ? 0 : 1" :title="store.locales==='zh'?'静音':'Mute'">
              <i :class="volume === 0 ? 'fa fa-volume-off' : volume < 0.5 ? 'fa fa-volume-down' : 'fa fa-volume-up'"></i>
            </button>
            <input type="range" class="volume-slider" min="0" max="1" step="0.05" v-model.number="volume" @input="applyVolume" :title="store.locales==='zh'?'音量':'Volume'" />
          </div>
          <button class="ctl-btn mode-btn" @click="togglePlayMode" :title="playModeLabel">
            <i :class="playMode === 'shuffle' ? 'fa fa-random' : playMode === 'loop' ? 'fa fa-repeat' : 'fa fa-forward'"></i>
          </button>
          <button class="ctl-btn fs-btn" @click="toggleFullscreen" :title="store.locales==='zh'?'全屏':'Fullscreen'">
            <i class="fa fa-expand"></i>
          </button>
          <button class="ctl-btn viewmode-btn" @click="cycleDisplayMode"
                  :title="store.locales==='zh'
                    ? ('视图：' + displayModeLabel + ' · 点击切换（黑胶/磁带/波形/频谱）')
                    : ('View: ' + displayModeLabel + ' · click to switch')">
            <span class="viewmode-text">{{ displayGlyph }}</span>
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'

const store = usestore()

const props = defineProps<{
  path: string
  content?: string
}>()

const emit = defineEmits<{
  (e: 'update:path', path: string): void
}>()

// 内部当前播放路径：切歌时更新，props.path 变化时同步（与 store.addTab 标签逻辑分离）
const currentPath = ref(props.path)

// ---------- 文件类型判断 ----------
const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff']
const VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg']

const extension = computed(() => {
  const p = currentPath.value || ''
  const i = p.lastIndexOf('.')
  return i >= 0 ? p.slice(i).toLowerCase() : ''
})
const isAudio = computed(() => AUDIO_EXTS.includes(extension.value))

const extLabel = computed(() => (extension.value || '.audio').replace('.', '').toUpperCase())

const fileName = computed(() => {
  const p = currentPath.value || ''
  return p.replace(/\\/g, '/').split('/').pop() || (store.locales === 'zh' ? '未知文件' : 'Unknown')
})

// 文件名（不含扩展名后缀）
const displayName = computed(() => {
  const n = fileName.value
  const i = n.lastIndexOf('.')
  return i > 0 ? n.slice(0, i) : n
})

// ---------- 主题适配 ----------
function isDarkTheme() {
  const bg = store.UI.backgroundColor || '#ffffff'
  const hex = String(bg).replace('#', '')
  if (hex.length < 6) return false
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return r * 0.299 + g * 0.587 + b * 0.114 < 128
}
const isDark = computed(() => isDarkTheme())

// 强调色（已播放 / 高亮）
const accentColor = computed(() => store.UI.fontActiveColor || store.UI.menuActiveColor || (isDark.value ? '#4d9fff' : '#409eff'))
// 基础色（未播放波形）
const baseColor = computed(() => store.UI.borderColor || (isDark.value ? '#3d4451' : '#d0d7de'))
// 强调色上可读的文字色：按强调色亮度自动选深/浅
const accentText = computed(() => {
  let h = String(accentColor.value || '').replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (h.length !== 6) return '#fff'
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return r * 0.299 + g * 0.587 + b * 0.114 > 128 ? '#241a0c' : '#fff8e9'
})

function withAlpha(hex: string, alpha: number) {
  let h = String(hex || '').replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (h.length !== 6) return `rgba(128,128,128,${alpha})`
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ---------- 播放状态 ----------
const waveCanvas = ref<HTMLCanvasElement | null>(null)
const seekBar = ref<HTMLDivElement | null>(null)
const tapeStageRef = ref<HTMLElement | null>(null)
const tapeProgressRef = ref<HTMLDivElement | null>(null)
// 磁带全宽进度条：悬浮时显示当前/总时间
const tapeHover = ref(false)

const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const loading = ref(false)
const waveError = ref(false)

// 显示样式：record=黑胶 tape=磁带 waveform=整体波形 fft=实时频谱跳动
const displayMode = ref<'record' | 'tape' | 'waveform' | 'fft'>('record')
// 波形类样式（整体波形 / 实时频谱）都渲染波形区
const isWaveMode = computed(() => displayMode.value === 'waveform' || displayMode.value === 'fft')
// 右下角按钮文字：随当前样式显示（FA4 无磁带图标，文字徽标更清晰）
const displayGlyph = computed(() => {
  if (displayMode.value === 'tape') return store.locales === 'zh' ? '磁带' : 'TAPE'
  if (displayMode.value === 'waveform') return store.locales === 'zh' ? '波形' : 'WAVE'
  if (displayMode.value === 'fft') return store.locales === 'zh' ? '频谱' : 'FFT'
  return store.locales === 'zh' ? '黑胶' : 'REC'
})
const displayModeLabel = computed(() => {
  if (displayMode.value === 'tape') return store.locales === 'zh' ? '磁带' : 'Cassette'
  if (displayMode.value === 'waveform') return store.locales === 'zh' ? '整体波形' : 'Waveform'
  if (displayMode.value === 'fft') return store.locales === 'zh' ? '实时频谱' : 'Spectrum'
  return store.locales === 'zh' ? '黑胶' : 'Record'
})
// 磁带信息条：当前歌词行（无歌词/未开始时给提示文案）
const currentLyricText = computed(() => {
  const arr = lyrics.value
  if (!arr.length) return store.locales === 'zh' ? '♪ 暂无歌词' : '♪ No lyrics'
  if (arr[0].time < 0) return arr[0].text || '♪'
  if (activeLyric.value >= 0) return arr[activeLyric.value]?.text || '♪'
  return store.locales === 'zh' ? '♪ 即将开始…' : '♪ Coming up…'
})
// 波形/频谱下方当前歌词：只显示真实歌词（无歌词/未开始时为空，不显示）
const waveLyricText = computed(() => {
  const arr = lyrics.value
  if (!arr.length) return ''
  if (arr[0].time < 0) return arr[0].text || ''
  return activeLyric.value >= 0 ? (arr[activeLyric.value]?.text || '') : ''
})
// 循环切换：黑胶 → 磁带 → 整体波形 → 实时频谱 → …
function cycleDisplayMode() {
  const order: ('record' | 'tape' | 'waveform' | 'fft')[] = ['record', 'tape', 'waveform', 'fft']
  const i = order.indexOf(displayMode.value)
  displayMode.value = order[(i + 1) % order.length]
  // 等 DOM 更新后按新尺寸重绘波形/频谱；并立即定位/高亮当前歌词
  // （黑胶歌词面板此时是新挂载的，等“下一句”才变化会滞后）
  nextTick(() => {
    drawWaveform()
    updateActiveLyric(true)
  })
}

let rafId: number | null = null
let seeking = false

// 整曲峰谷波形（解码后预计算）
let wavePeaks: Float32Array | null = null
// 柱高渲染缓存（画布宽度变化才重建，避免每帧重算）
let cachedWaveW = 0
let cachedBars: Float32Array | null = null
// 播放位置游标（0~1，向目标平滑逼近实现动画过渡）
let smoothCursor = 0
// 悬停预览
const hoverFraction = ref<number | null>(null)
const hoverTime = ref(0)
const hoverVisible = computed(() => hoverFraction.value !== null && duration.value > 0)
const hoverX = computed(() => {
  const c = waveCanvas.value
  const f = hoverFraction.value
  if (!c || f == null) return 0
  return f * c.clientWidth
})

// Web Audio 实时播放与分析（音频专用）
let audioCtx: AudioContext | null = null
let audioBuffer: AudioBuffer | null = null
let bufferSource: AudioBufferSourceNode | null = null
let gainNode: GainNode | null = null
let analyser: AnalyserNode | null = null
let startCtxTime = 0
let startOffset = 0

// 专辑封面（MP3 ID3 APIC）
const albumArt = ref<string | null>(null)
let albumArtUrl: string | null = null

// 歌词（USLT 帧 / LRC 时间轴）
const lyrics = ref<{ time: number; text: string }[]>([])
const activeLyric = ref(-1)
const lyricsPanel = ref<HTMLElement | null>(null)
let lyricScrollRaf: number | null = null

// 控制条自适应 / 全屏
const ctlBar = ref<HTMLElement | null>(null)
const audioCardRef = ref<HTMLElement | null>(null)
const ctlCompact = ref(false)
let ctlObserver: ResizeObserver | null = null

// 播放模式：sequential=顺序播放 loop=单曲循环
const playMode = ref<'sequential' | 'loop' | 'shuffle'>('sequential')

// 播放模式名称（顺序/单曲循环/随机）
const playModeLabel = computed(() => {
  if (playMode.value === 'loop') return store.locales === 'zh' ? '单曲循环' : 'Loop one'
  if (playMode.value === 'shuffle') return store.locales === 'zh' ? '随机播放' : 'Shuffle'
  return store.locales === 'zh' ? '顺序播放' : 'Sequential'
})
// 当前文件夹内的音视频文件列表（用于上下首切换）
let folderFiles: { path: string; label: string; extension: string }[] = []
// 切歌后自动播放标记
let autoPlayAfterLoad = false

// ---------- 波形加载（Web Audio API 解码） ----------
async function loadAudio() {
  if (!isAudio.value) return
  loading.value = true
  waveError.value = false
  try {
    const uint8: Uint8Array | null = await window.ipcRenderer.invoke('readFileBinary', currentPath.value)
    if (!uint8 || !uint8.length) throw new Error('read failed')
    const arrayBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength) as ArrayBuffer
    // 尝试从 ID3 标签提取专辑封面
    const art = extractAlbumArt(uint8)
    if (art) {
      albumArt.value = art
      albumArtUrl = art
    }
    // 尝试从 ID3 标签提取歌词
    const lrcText = extractLyrics(uint8)
    if (lrcText) {
      lyrics.value = parseLrc(lrcText)
    }
    const Ctx: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext
    audioCtx = new Ctx()
    // decodeAudioData 会 detach 传入的 buffer，传副本
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0) as ArrayBuffer)
    audioBuffer = decoded
    duration.value = decoded.duration || 0
    // 构建音频图：source -> analyser -> gain -> destination
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.8
    gainNode = audioCtx.createGain()
    gainNode.gain.value = volume.value
    analyser.connect(gainNode)
    gainNode.connect(audioCtx.destination)
    // 预计算整曲峰谷（静态波形显示用）
    buildWavePeaks()
    // 切歌后自动播放
    if (autoPlayAfterLoad) {
      autoPlayAfterLoad = false
      startPlayback(0)
    }
  } catch (e) {
    waveError.value = true
    autoPlayAfterLoad = false
  } finally {
    loading.value = false
    drawWaveform()
  }
}

// 从音频文件头部解析 ID3v2 标签，提取 APIC 专辑封面（返回 blob URL）
function extractAlbumArt(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 10) return null
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null // "ID3"
    const major = bytes[3]
    if (major !== 2 && major !== 3 && major !== 4) return null
    // 标签体大小（syncsafe）
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
    const tagEnd = Math.min(bytes.length, 10 + tagSize)
    let pos = 10
    while (pos + 10 <= tagEnd) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
      if (id === '\u0000\u0000\u0000\u0000') break
      let frameSize: number
      if (major === 4) {
        frameSize = ((bytes[pos + 4] & 0x7f) << 21) | ((bytes[pos + 5] & 0x7f) << 14) | ((bytes[pos + 6] & 0x7f) << 7) | (bytes[pos + 7] & 0x7f)
      } else {
        frameSize = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]
      }
      const frameStart = pos + 10
      const frameEnd = frameStart + frameSize
      if (frameEnd > tagEnd || frameEnd > bytes.length) break
      if (id === 'APIC') {
        const img = parseApic(bytes, frameStart, frameEnd)
        if (img) return img
      }
      pos = frameEnd
    }
  } catch (e) { /* 忽略解析错误 */ }
  return null
}

// 解析 APIC 帧：encoding + mime(null) + pictureType(1) + description(null) + 图片数据
function parseApic(bytes: Uint8Array, start: number, end: number): string | null {
  if (end - start < 5) return null
  const enc = bytes[start] // 0=ISO-8859-1, 1=UTF-16, 2=UTF-16BE, 3=UTF-8
  let p = start + 1
  // MIME 类型（null 终止）
  let mimeEnd = p
  while (mimeEnd < end && bytes[mimeEnd] !== 0) mimeEnd++
  if (mimeEnd >= end) return null
  const mime = String.fromCharCode(...bytes.slice(p, mimeEnd)).toLowerCase()
  if (!mime.startsWith('image/')) return null
  p = mimeEnd + 1
  if (p >= end) return null
  p += 1 // 图片类型
  if (p >= end) return null
  // 跳过描述（按编码读取终止符）
  if (enc === 1 || enc === 2) {
    while (p + 1 < end && !(bytes[p] === 0 && bytes[p + 1] === 0)) p++
    p += 2
  } else {
    while (p < end && bytes[p] !== 0) p++
    p += 1
  }
  if (p >= end) return null
  const imgBytes = bytes.slice(p, end)
  if (!imgBytes.length) return null
  const blob = new Blob([imgBytes], { type: mime })
  return URL.createObjectURL(blob)
}

// 从音频文件解析 ID3v2 USLT 帧提取歌词
function extractLyrics(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 10) return null
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null
    const major = bytes[3]
    if (major !== 2 && major !== 3 && major !== 4) return null
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
    const tagEnd = Math.min(bytes.length, 10 + tagSize)
    let pos = 10
    while (pos + 10 <= tagEnd) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
      if (id === '\u0000\u0000\u0000\u0000') break
      let frameSize: number
      if (major === 4) {
        frameSize = ((bytes[pos + 4] & 0x7f) << 21) | ((bytes[pos + 5] & 0x7f) << 14) | ((bytes[pos + 6] & 0x7f) << 7) | (bytes[pos + 7] & 0x7f)
      } else {
        frameSize = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]
      }
      const frameStart = pos + 10
      const frameEnd = frameStart + frameSize
      if (frameEnd > tagEnd || frameEnd > bytes.length) break
      if (id === 'USLT') {
        const txt = parseUslt(bytes, frameStart, frameEnd)
        if (txt) return txt
      }
      pos = frameEnd
    }
  } catch (e) { /* 忽略解析错误 */ }
  return null
}

// 解析 USLT 帧：encoding + language(3) + descriptor(null) + 歌词文本
function parseUslt(bytes: Uint8Array, start: number, end: number): string | null {
  if (end - start < 5) return null
  const enc = bytes[start]
  let p = start + 1
  p += 3 // language
  if (p >= end) return null
  // 跳过描述（按编码读取终止符）
  if (enc === 1 || enc === 2) {
    while (p + 1 < end && !(bytes[p] === 0 && bytes[p + 1] === 0)) p++
    p += 2
  } else {
    while (p < end && bytes[p] !== 0) p++
    p += 1
  }
  if (p >= end) return null
  const lyricBytes = bytes.slice(p, end)
  let text: string
  try {
    if (enc === 1) text = new TextDecoder('utf-16').decode(lyricBytes)
    else if (enc === 2) text = new TextDecoder('utf-16be').decode(lyricBytes)
    else text = new TextDecoder('utf-8').decode(lyricBytes)
  } catch {
    text = new TextDecoder('utf-8').decode(lyricBytes)
  }
  return text.replace(/\u0000/g, '').trim() || null
}

// 解析 LRC 时间轴歌词；无时间戳则按行返回（不高亮）
function parseLrc(text: string): { time: number; text: string }[] {
  const result: { time: number; text: string }[] = []
  let hasTimestamp = false
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const timeMatches = [...rawLine.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (timeMatches.length) {
      hasTimestamp = true
      const lyricText = rawLine.replace(/\[[^\]]*\]/g, '').trim()
      for (const m of timeMatches) {
        const min = parseInt(m[1], 10)
        const sec = parseInt(m[2], 10)
        const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0
        result.push({ time: min * 60 + sec + frac, text: lyricText })
      }
    } else {
      result.push({ time: -1, text: rawLine })
    }
  }
  return hasTimestamp ? result : result.map(l => ({ time: -1, text: l.text }))
}

// 根据播放进度更新当前歌词行并平滑滚动到可见（force 时即使行不变也强制定位）
function updateActiveLyric(force = false) {
  const arr = lyrics.value
  if (!arr.length || arr[0].time < 0) return
  let idx = -1
  for (let i = 0; i < arr.length; i++) {
    if (currentTime.value >= arr[i].time) idx = i
    else break
  }
  if (idx !== activeLyric.value || force) {
    activeLyric.value = idx
    scrollLyricToActive()
  }
}

// 平滑滚动歌词到当前行（居中，带缓动动画）；无激活行时滚动到顶部
function scrollLyricToActive() {
  const panel = lyricsPanel.value
  if (!panel) return
  const scroller = panel.querySelector('.lyrics-scroll') as HTMLElement | null
  if (!scroller) return
  let target = 0
  const el = panel.querySelector('.lyric-line.active') as HTMLElement | null
  if (el) {
    const scrollerRect = scroller.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    target = scroller.scrollTop + (elRect.top - scrollerRect.top) - (scroller.clientHeight - elRect.height) / 2
  }
  if (lyricScrollRaf) cancelAnimationFrame(lyricScrollRaf)
  const start = scroller.scrollTop
  const delta = target - start
  if (Math.abs(delta) < 1) return
  const duration = 320
  const t0 = performance.now()
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration)
    scroller.scrollTop = start + delta * ease(p)
    lyricScrollRaf = p < 1 ? requestAnimationFrame(step) : null
  }
  lyricScrollRaf = requestAnimationFrame(step)
}

// ---------- 波形绘制（静态峰谷 + 播放进度高亮 / 实时频谱跳动） ----------
// 实时频谱跳动：以中心为轴镜像柱条（仅播放时使用；analyser 不可用时回退静态波形）
function drawSpectrum(ctx: CanvasRenderingContext2D, w: number, h: number, midY: number) {
  if (!analyser) return
  // 每帧读取时新建频率缓冲（规避不同 TS 版本对 Uint8Array 泛型的差异）
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(data)
  const totalBins = data.length
  if (totalBins <= 0) return
  const barCount = Math.max(24, Math.min(96, Math.floor(w / 9)))
  const binW = w / barCount
  const gap = Math.max(1, Math.floor(binW * 0.24))
  const ampMax = h * 0.46
  const logMax = Math.log(totalBins)
  for (let i = 0; i < barCount; i++) {
    const startBin = Math.max(0, Math.floor(Math.exp((i / barCount) * logMax) - 1))
    const endBin = Math.min(totalBins, Math.floor(Math.exp(((i + 1) / barCount) * logMax) - 1))
    let sum = 0
    const count = Math.max(1, endBin - startBin)
    for (let b = startBin; b < endBin; b++) sum += data[b]
    const v = (sum / count) / 255
    const amp = Math.max(2, Math.pow(v, 0.85) * ampMax)
    const x = i * binW + gap / 2
    const barW = Math.max(1, binW - gap)
    ctx.fillStyle = accentColor.value
    ctx.globalAlpha = 0.95
    ctx.beginPath()
    ctx.roundRect(x, midY - amp, barW, amp, Math.min(4, barW / 2.5))
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(x, midY, barW, amp, Math.min(4, barW / 2.5))
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// 解码后预计算整曲峰谷（每 ~20ms 一块取峰值，含多声道取最大）
function buildWavePeaks() {
  const buf = audioBuffer
  wavePeaks = null
  cachedWaveW = 0
  cachedBars = null
  if (!buf || buf.length <= 0) return
  const chans: Float32Array[] = []
  for (let c = 0; c < buf.numberOfChannels; c++) {
    try { chans.push(buf.getChannelData(c)) } catch { /* 忽略 */ }
  }
  if (!chans.length) return
  const n = buf.length
  // 每块约 20ms，任意画布宽度下都有足够密度
  const chunk = Math.max(256, Math.floor(buf.sampleRate * 0.02))
  const count = Math.max(1, Math.ceil(n / chunk))
  const peaks = new Float32Array(count)
  const stride = 2 // 能量(RMS)近似，隔 2 采样加速
  for (let i = 0; i < count; i++) {
    const s = i * chunk
    const e = Math.min(n, s + chunk)
    let sum = 0
    let cnt = 0
    for (let p = s; p < e; p += stride) {
      for (let c = 0; c < chans.length; c++) {
        const x = chans[c][p]
        sum += x * x
      }
      cnt += chans.length
    }
    // 每块响度用 RMS：比“峰值”更能体现音乐能量随时间的起伏，
    // 避免母带压限（响度战争）歌曲因每段都接近满幅而显得“一直顶满”
    peaks[i] = cnt > 0 ? Math.sqrt(sum / cnt) : 0
  }
  wavePeaks = peaks
  drawWaveform()
}

function drawWaveform() {
  const canvas = waveCanvas.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w <= 0 || h <= 0) return
  const targetW = Math.floor(w * dpr)
  const targetH = Math.floor(h * dpr)
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW
    canvas.height = targetH
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const midY = h / 2

  // 实时频谱跳动模式：仅播放且分析器可用时跳动态柱条；暂停/不可用时自动回退静态波形
  if (displayMode.value === 'fft' && isPlaying.value && analyser) {
    drawSpectrum(ctx, w, h, midY)
    return
  }

  // 播放位置游标：向目标平滑逼近（暂停/拖动时也平滑收敛）
  const target = duration.value > 0 ? Math.max(0, Math.min(1, currentTime.value / duration.value)) : 0
  if (isPlaying.value) {
    smoothCursor += (target - smoothCursor) * 0.2
    if (Math.abs(target - smoothCursor) < 0.0006) smoothCursor = target
  } else {
    smoothCursor += (target - smoothCursor) * 0.25
    if (Math.abs(target - smoothCursor) < 0.0004) smoothCursor = target
  }
  smoothCursor = Math.max(0, Math.min(1, smoothCursor))

  // 尚无波形数据：柔和基线兜底
  if (!wavePeaks || wavePeaks.length === 0) {
    ctx.strokeStyle = withAlpha(baseColor.value, 0.5)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, midY)
    ctx.lineTo(w, midY)
    ctx.stroke()
    return
  }

  // SoundCloud 风格细柱：柱宽 2 间隙 1，水平居中
  const barW = 2
  const gap = 1
  const stepW = barW + gap
  const bars = Math.max(1, Math.floor((w - 4) / stepW))
  const totalW = bars * stepW - gap
  const x0 = (w - totalW) / 2

  // 柱高缓存：仅在宽度/柱数变化时重建
  if (cachedWaveW !== w || !cachedBars || cachedBars.length !== bars) {
    cachedWaveW = w
    const peakLen = wavePeaks.length
    const arr = new Float32Array(bars)
    // 每柱取区间平均能量（均值比取“峰值”更平滑，能体现段落起伏）
    for (let i = 0; i < bars; i++) {
      const si = Math.floor((i * peakLen) / bars)
      const ei = Math.max(si + 1, Math.floor(((i + 1) * peakLen) / bars))
      let sum = 0
      for (let k = si; k < ei; k++) sum += wavePeaks[k]
      arr[i] = sum / (ei - si)
    }
    // 按整曲最响段归一化 + 弱段指数增强，让主歌/副歌层次分明
    let mMax = 0
    for (let i = 0; i < bars; i++) if (arr[i] > mMax) mMax = arr[i]
    if (mMax > 0) {
      for (let i = 0; i < bars; i++) {
        arr[i] = Math.min(1, arr[i] / mMax)
        arr[i] = Math.pow(arr[i], 0.75)
      }
    }
    cachedBars = arr
  }

  const ampMax = Math.max(4, h * 0.45)
  const playedX = smoothCursor * w
  const unplayedColor = withAlpha(baseColor.value, isDark.value ? 0.85 : 0.55)
  for (let i = 0; i < bars; i++) {
    const x = x0 + i * stepW
    const amp = Math.max(1.6, cachedBars[i] * ampMax)
    const cx = x + barW / 2
    const played = cx < playedX
    ctx.fillStyle = played ? accentColor.value : unplayedColor
    const r = barW / 2
    // 上下对称圆角柱
    ctx.beginPath()
    ctx.roundRect(cx - barW / 2, midY - amp, barW, amp, r)
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(cx - barW / 2, midY, barW, amp, r)
    ctx.fill()
  }

  // 播放位置游标（发光竖线 + 顶部圆点）
  ctx.save()
  ctx.shadowColor = accentColor.value
  ctx.shadowBlur = 8
  ctx.fillStyle = accentColor.value
  ctx.beginPath()
  ctx.roundRect(playedX - 1, 2, 2, h - 4, 1)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(playedX, 2, 3.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // 悬停预览虚线
  const hf = hoverFraction.value
  if (hf != null) {
    const hx = hf * w
    ctx.save()
    ctx.strokeStyle = withAlpha('#ffffff', isDark.value ? 0.75 : 0.6)
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(hx, 2)
    ctx.lineTo(hx, h - 2)
    ctx.stroke()
    ctx.restore()
  }
}

// ---------- 时间循环 ----------
function tick() {
  if (isPlaying.value) {
    const t = getAudioPosition()
    currentTime.value = t
    if (t >= duration.value - 0.05) {
      handleAudioEnded()
    }
  }
  // 磁带视图：只靠左右卷厚度此消彼长表达播放进度（不再画中央长条进度线）
  if (displayMode.value === 'tape') {
    const st = tapeStageRef.value
    if (st) {
      const p = duration.value > 0 ? Math.max(0, Math.min(1, currentTime.value / duration.value)) : 0
      // 模拟真实卡带：随播放左卷变薄(100%→38%)、右卷变厚(38%→100%)
      st.style.setProperty('--tape-pack-l', String(100 - p * 62) + '%')
      st.style.setProperty('--tape-pack-r', String(38 + p * 62) + '%')
    }
  }
  updateActiveLyric()
  drawWaveform()
  rafId = requestAnimationFrame(tick)
}

// ---------- Web Audio 播放控制（音频） ----------
function getAudioPosition() {
  if (!audioCtx || !bufferSource || !isPlaying.value) return currentTime.value
  const t = startOffset + (audioCtx.currentTime - startCtxTime)
  return Math.min(t, duration.value)
}

function stopSource() {
  if (bufferSource) {
    try { bufferSource.onended = null } catch {}
    try { bufferSource.stop() } catch {}
    try { bufferSource.disconnect() } catch {}
    bufferSource = null
  }
}

// 播放完成统一处理（防重入）：单曲循环重播 / 顺序模式自动下一首
let endedHandling = false
function handleAudioEnded() {
  if (endedHandling) return
  endedHandling = true
  bufferSource = null
  if (playMode.value === 'loop') {
    // 单曲循环：从开头重播
    startPlayback(0)
  } else {
    // 顺序/随机模式：自动播放下一首（顺序模式末尾则停止）
    isPlaying.value = false
    currentTime.value = duration.value
    stepTrack(1, true)
  }
  requestAnimationFrame(() => { endedHandling = false })
}

function startPlayback(offset: number) {
  if (!audioCtx || !audioBuffer || !analyser) return
  stopSource()
  const src = audioCtx.createBufferSource()
  src.buffer = audioBuffer
  src.connect(analyser)
  src.onended = () => {
    if (bufferSource !== src) return
    handleAudioEnded()
  }
  src.start(0, Math.max(0, Math.min(offset, (audioBuffer.duration || 0) - 0.01)))
  bufferSource = src
  startCtxTime = audioCtx.currentTime
  startOffset = offset
  isPlaying.value = true
}

function toggleAudioPlay() {
  if (!audioCtx || !audioBuffer) return
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  if (isPlaying.value) {
    currentTime.value = getAudioPosition()
    stopSource()
    isPlaying.value = false
  } else {
    let t = currentTime.value
    if (t >= duration.value - 0.05) t = 0
    startPlayback(t)
  }
}

// ---------- 播放控制 ----------
function togglePlay() {
  toggleAudioPlay()
}

function toggleFullscreen() {
  const el = audioCardRef.value
  if (!el) return
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    el.requestFullscreen?.()
  }
}

// 切换显示样式（黑胶/磁带/整体波形/实时频谱）由 cycleDisplayMode 统一循环处理


// ---------- 事件 ----------
// ---------- 进度拖拽 ----------
function seekTo(ratio: number) {
  const t = Math.max(0, Math.min(1, ratio))
  if (duration.value <= 0) return
  const target = t * duration.value
  currentTime.value = target
  if (isPlaying.value) startPlayback(target)
}

function onSeekDown(e: MouseEvent) {
  if (!audioBuffer) return
  seeking = true
  seekFromBar(e)
  window.addEventListener('mousemove', onSeekWindowMove)
  window.addEventListener('mouseup', onSeekWindowUp)
  e.preventDefault()
}
function onSeekWindowMove(e: MouseEvent) {
  if (seeking) seekFromBar(e)
}
function onSeekWindowUp() {
  seeking = false
  window.removeEventListener('mousemove', onSeekWindowMove)
  window.removeEventListener('mouseup', onSeekWindowUp)
  // 调整时间后歌词及时定位到中间
  updateActiveLyric(true)
}
function seekFromBar(e: MouseEvent) {
  const bar = seekBar.value
  if (!bar) return
  const rect = bar.getBoundingClientRect()
  const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
  seekTo(ratio)
}

// ---------- 磁带全宽进度条拖拽 seek ----------
function onTapeSeekDown(e: MouseEvent) {
  if (!audioBuffer) return
  seeking = true
  seekFromTapeBar(e)
  window.addEventListener('mousemove', onTapeSeekWindowMove)
  window.addEventListener('mouseup', onTapeSeekWindowUp)
  e.preventDefault()
}
function onTapeSeekWindowMove(e: MouseEvent) {
  if (seeking) seekFromTapeBar(e)
}
function onTapeSeekWindowUp() {
  seeking = false
  window.removeEventListener('mousemove', onTapeSeekWindowMove)
  window.removeEventListener('mouseup', onTapeSeekWindowUp)
  updateActiveLyric(true)
}
function seekFromTapeBar(e: MouseEvent) {
  const bar = tapeProgressRef.value
  if (!bar) return
  const rect = bar.getBoundingClientRect()
  const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
  seekTo(ratio)
}

// ---------- 波形拖拽 seek ----------
function onWaveMouseDown(e: MouseEvent) {
  if (!isAudio.value) return
  // 实时频谱跳动样式仅用于查看，不允许拖动波形调整播放位置
  if (displayMode.value === 'fft') return
  seeking = true
  seekFromWave(e)
  window.addEventListener('mousemove', onWaveWindowMove)
  window.addEventListener('mouseup', onWaveWindowUp)
  e.preventDefault()
}
function onWaveWindowMove(e: MouseEvent) {
  if (seeking) seekFromWave(e)
}
function onWaveWindowUp() {
  seeking = false
  window.removeEventListener('mousemove', onWaveWindowMove)
  window.removeEventListener('mouseup', onWaveWindowUp)
  // 调整时间后歌词及时定位到中间
  updateActiveLyric(true)
}
function seekFromWave(e: MouseEvent) {
  const canvas = waveCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
  seekTo(ratio)
}

// 波形悬停预览
function onWaveHoverMove(e: MouseEvent) {
  const canvas = waveCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || duration.value <= 0) {
    hoverFraction.value = null
    return
  }
  const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  hoverFraction.value = f
  hoverTime.value = f * duration.value
}
function onWaveHoverLeave() {
  hoverFraction.value = null
}

// ---------- 音量 / 倍速 ----------
function applyVolume() {
  const v = volume.value
  if (gainNode) gainNode.gain.value = v
}
watch(volume, applyVolume)

// 切换媒体文件时重置状态（封面/歌词/进度/播放）
function resetMedia() {
  stopSource()
  currentTime.value = 0
  duration.value = 0
  isPlaying.value = false
  activeLyric.value = -1
  lyrics.value = []
  if (albumArtUrl) {
    URL.revokeObjectURL(albumArtUrl)
    albumArtUrl = null
  }
  albumArt.value = null
  // 清理波形缓存
  wavePeaks = null
  cachedBars = null
  cachedWaveW = 0
  smoothCursor = 0
  hoverFraction.value = null
  drawWaveform()
}

// 获取当前文件所在文件夹中的音视频文件列表（按名称排序）
async function loadFolderAudioList() {
  try {
    const folderPath = (currentPath.value || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    if (!folderPath) { folderFiles = []; return }
    const files: any[] = (await window.ipcRenderer.invoke('getFiles', folderPath, 0)) || []
    folderFiles = files
      .filter((f: any) => f && f.type === 'file' && (AUDIO_EXTS.includes((f.extension || '').toLowerCase()) || VIDEO_EXTS.includes((f.extension || '').toLowerCase())))
      .sort((a: any, b: any) => String(a.label || '').localeCompare(String(b.label || ''), undefined, { numeric: true }))
      .map((f: any) => ({ path: f.path, label: f.label, extension: f.extension }))
  } catch {
    folderFiles = []
  }
}

// 切换上一首/下一首；auto=true 表示播放完自动切换（顺序模式末尾则停止）
function stepTrack(dir: number, auto = false) {
  const current = currentPath.value
  if (!folderFiles.length) return

  // 随机播放：随机选一首（排除当前）
  if (playMode.value === 'shuffle') {
    if (folderFiles.length <= 1) {
      startPlayback(0)
      return
    }
    const candidates = folderFiles.filter(f => f.path !== current)
    const next = candidates[Math.floor(Math.random() * candidates.length)]
    stopSource()
    autoPlayAfterLoad = true
    currentPath.value = next.path
    emit('update:path', next.path)
    return
  }

  // 顺序播放 / 单曲循环：按列表顺序切换
  let idx = folderFiles.findIndex(f => f.path === current)
  if (idx === -1) idx = 0
  const nextIdx = idx + dir
  if (auto && nextIdx >= folderFiles.length) {
    // 顺序模式播放到最后一首：停止
    stopSource()
    isPlaying.value = false
    currentTime.value = duration.value
    return
  }
  const wrapped = (nextIdx + folderFiles.length) % folderFiles.length
  const next = folderFiles[wrapped]
  if (!next) return
  if (next.path === current) {
    // 列表只有当前一首：重播
    startPlayback(0)
    return
  }
  stopSource()
  autoPlayAfterLoad = true
  currentPath.value = next.path
  // 通知父组件（独立窗口等）当前播放文件已切换
  emit('update:path', next.path)
}

function playNext() { stepTrack(1) }
function playPrev() { stepTrack(-1) }

// 切换播放模式：顺序播放 → 单曲循环 → 随机播放
function togglePlayMode() {
  playMode.value = playMode.value === 'sequential' ? 'loop' : playMode.value === 'loop' ? 'shuffle' : 'sequential'
}

// 控制条过窄时隐藏次要控件（音量/模式/全屏等），低于阈值隐藏、高于恢复
function checkCtlOverflow() {
  const el = ctlBar.value
  if (!el) return
  // 音频控制条完整内容约需 620px，视频约 430px（含 seek 最小宽度）
  const threshold = isAudio.value ? 620 : 430
  // clientWidth 不随按钮隐藏而变化，稳定无反馈循环
  ctlCompact.value = el.clientWidth < threshold
}

// 外部切换标签：同步到内部当前路径（与切歌共用重载逻辑）
watch(() => props.path, (newPath, oldPath) => {
  if (!newPath || newPath === oldPath) return
  currentPath.value = newPath
})

// 内部切换文件（切歌 / 外部同步）时重新加载并同步封面/歌词/播放状态
watch(currentPath, (newPath, oldPath) => {
  if (!newPath || newPath === oldPath) return
  resetMedia()
  loadFolderAudioList()
  if (isAudio.value) {
    loadAudio()
  }
})

// ---------- 计算属性 ----------
const seekPercent = computed(() => {
  if (duration.value <= 0) return 0
  return Math.max(0, Math.min(100, (currentTime.value / duration.value) * 100))
})

function formatTime(t: number) {
  if (!isFinite(t) || t < 0) return '00:00'
  const total = Math.floor(t)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ---------- 生命周期 ----------
onMounted(() => {
  if (isAudio.value) {
    loadAudio()
  }
  loadFolderAudioList()
  rafId = requestAnimationFrame(tick)
  window.addEventListener('resize', drawWaveform)
  window.addEventListener('resize', checkCtlOverflow)
  checkCtlOverflow()
  // 监听控制条尺寸变化，过窄时自动隐藏次要控件
  if (typeof ResizeObserver !== 'undefined') {
    ctlObserver = new ResizeObserver(() => checkCtlOverflow())
    if (ctlBar.value) ctlObserver.observe(ctlBar.value)
  }
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = null
  if (lyricScrollRaf) cancelAnimationFrame(lyricScrollRaf)
  lyricScrollRaf = null
  window.removeEventListener('resize', drawWaveform)
  window.removeEventListener('resize', checkCtlOverflow)
  if (ctlObserver) {
    ctlObserver.disconnect()
    ctlObserver = null
  }
  if (albumArtUrl) {
    URL.revokeObjectURL(albumArtUrl)
    albumArtUrl = null
  }
  stopSource()
  if (audioCtx) {
    try { audioCtx.close() } catch {}
    audioCtx = null
  }
})
</script>

<style scoped>
.media-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  overflow: hidden;
  background:
    radial-gradient(ellipse at top, var(--menuColor) 0%, transparent 60%),
    var(--backgroundColor);
  box-sizing: border-box;
  outline: none;
}

/* ---------- 卡片 ---------- */
.media-card {
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  background: var(--menuColor);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
  overflow: hidden;
}

/* 音频卡片：复古暖调背景 */
.audio-card {
  background:
    radial-gradient(circle at 50% 14%, color-mix(in srgb, var(--menuColor) 72%, #f0c98a) 0%, transparent 58%),
    linear-gradient(180deg, color-mix(in srgb, var(--menuColor) 90%, #e8cfa8) 0%, var(--menuColor) 100%);
}

/* ---------- 音频（复古黑胶 · 波形风格） ---------- */
.audio-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 14px 28px 12px;
  overflow: hidden;
}
/* 波形模式：标题 + 波形占满剩余空间 */
.audio-body.wave-mode .wave-title {
  flex: none;
  max-width: 80%;
}

/* ---------- 磁带（黑色金属外壳+螺丝 · 中央贴封面 · 封面内胶囊观察窗 · 下方格栅歌名/歌词 + 全宽进度条） ---------- */
.tape-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #0b0b0d;
}
/* 黑色金属机身外壳（整片作为背景） */
.tape-shell {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background:
    radial-gradient(130% 90% at 50% -12%, color-mix(in srgb, var(--menuColor) 35%, #fff) 0%, transparent 46%),
    linear-gradient(160deg, color-mix(in srgb, var(--menuColor) 62%, #000) 0%, color-mix(in srgb, var(--menuColor) 28%, #000) 45%, color-mix(in srgb, var(--backgroundColor) 52%, #000) 100%);
  box-shadow:
    inset 0 1px 2px rgba(255, 255, 255, 0.05),
    inset 0 -20px 46px rgba(0, 0, 0, 0.8);
  border-radius: 6px;
}
/* 顶部螺丝（钉子）：模拟复古磁带外壳 */
.tape-screw {
  position: absolute;
  top: 2.6%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #ececf0 0%, #9a9aa2 55%, #48484e 100%);
  box-shadow:
    inset 0 -1px 2px rgba(0, 0, 0, 0.6),
    0 1px 3px rgba(0, 0, 0, 0.75);
  z-index: 8;
}
.tape-screw::before,
.tape-screw::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  background: rgba(25, 25, 30, 0.85);
}
/* 十字螺丝槽 */
.tape-screw::before {
  width: 8px;
  height: 1.8px;
  transform: translate(-50%, -50%);
}
.tape-screw::after {
  width: 1.8px;
  height: 8px;
  transform: translate(-50%, -50%);
}
.tape-screw-l { left: 3.4%; }
.tape-screw-r { right: 3.4%; }
/* 中央贴的封面（类磁带 J 卡贴纸），胶囊观察窗在其内垂直居中 */
.tape-cover {
  position: absolute;
  left: 8%;
  right: 8%;
  top: 7%;
  height: 58%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.6),
    0 12px 26px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
.tape-cover-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.tape-cover-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, color-mix(in srgb, var(--menuColor) 48%, #161616) 0%, color-mix(in srgb, var(--menuColor) 26%, #000) 60%, color-mix(in srgb, var(--backgroundColor) 40%, #000) 100%);
  color: var(--tape-accent);
  font-size: clamp(40px, 8vmin, 84px);
}
/* 封面内的胶囊观察窗：垂直居中；宽约封面的 56%（较窄）、宽>高、圆角半径=高度一半（两端半圆） */
.tape-window {
  --tw-h: clamp(64px, 15vh, 128px);
  position: relative;
  flex: 0 0 auto;
  width: 56%;
  height: var(--tw-h);
  border-radius: 9999px;
  overflow: hidden;
  background: linear-gradient(180deg, rgba(10, 10, 14, 0.92), rgba(22, 22, 30, 0.86));
  box-shadow:
    inset 0 0 22px rgba(0, 0, 0, 0.9),
    inset 0 0 0 1px color-mix(in srgb, var(--tape-accent) 55%, transparent),
    0 12px 26px rgba(0, 0, 0, 0.5);
}
/* 卷轴单元：中心落在圆角矩形两端半圆的圆心上；直径大于窗高，上下/外侧被窗自然遮挡 */
.tape-reel {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(calc((100% - var(--tw-h)) * 0.92), calc(var(--tw-h) * 1.9));
  aspect-ratio: 1 / 1;
}
/* 使卷轴中心对齐到两端半圆圆心 */
.unit-l { margin-left: calc((var(--tw-h) - 100%) / 2); }
.unit-r { margin-left: calc((100% - var(--tw-h)) / 2); }
/* 磁带卷：一圈圈缠绕的带盘；播放时半径（厚度）变化并旋转 */
.tape-pack {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background:
    radial-gradient(circle at 38% 32%, rgba(255, 255, 255, 0.08), transparent 55%),
    repeating-radial-gradient(circle at 50% 50%, #19130d 0 2px, #0a0604 2px 4px);
  box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.9);
  z-index: 1;
}
.unit-l .tape-pack { width: var(--tape-pack-l, 100%); height: var(--tape-pack-l, 100%); }
.unit-r .tape-pack { width: var(--tape-pack-r, 38%); height: var(--tape-pack-r, 38%); }
/* 卷轴中心轮毂：深色塑料圆盘（与磁带同色），中间 6 个向内嵌刻的方形凹槽——外圈/凹槽/中心孔同色系，只靠光影表现深度 */
.reel-gear {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 34%;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, #3b3b42 0%, #202026 58%, #0d0d11 100%);
  box-shadow:
    inset 0 0 0 2px #050507,
    inset 0 1px 2px rgba(255, 255, 255, 0.1),
    inset 0 -3px 6px rgba(0, 0, 0, 0.78),
    0 0 5px rgba(0, 0, 0, 0.9);
  z-index: 2;
}
/* 轮毂上的 6 个方形凹槽：绕中心均匀分布、向内嵌刻，随轮毂同转；同色相、略暗 + 内阴影体现凹陷 */
.reel-gear-slot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 17%;
  height: 44%;
  margin-left: -8.5%;
  margin-top: -44%;
  border-radius: 2px;
  background: linear-gradient(180deg, #050507 0%, #0b0b0f 100%);
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.9),
    inset 0 1px 1px rgba(255, 255, 255, 0.05);
  transform-origin: 50% 100%;
}
/* 中心驱动圆孔（与凹槽同色，压住内端） */
.reel-gear::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 26%;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  background: radial-gradient(circle at 45% 40%, #121217 0%, #020203 72%);
  box-shadow: inset 0 0 3px #000;
  z-index: 3;
}
/* 播放：左卷收带（顺时针）、右卷放带（逆时针），齿轮随卷轴同转 */
.tape-stage.playing .unit-l .tape-pack,
.tape-stage.playing .unit-l .reel-gear {
  animation: tape-reel-cw 2.6s linear infinite;
}
.tape-stage.playing .unit-r .tape-pack,
.tape-stage.playing .unit-r .reel-gear {
  animation: tape-reel-ccw 3s linear infinite;
}
@keyframes tape-reel-cw {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}
@keyframes tape-reel-ccw {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(-360deg); }
}
/* 下方格栅区：等腰梯形（上窄下宽），下边与上面封面同宽，与封面保持一定间距；歌词放复古黄标签上 */
.tape-grille {
  position: absolute;
  left: 8%;
  right: 8%;
  top: 73%;
  bottom: 7%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  clip-path: polygon(9% 0, 91% 0, 100% 100%, 0 100%); /* 等腰梯形：上窄下宽 */
  background:
    repeating-linear-gradient(180deg,
      color-mix(in srgb, var(--menuColor) 66%, #000) 0 5px,
      color-mix(in srgb, var(--backgroundColor) 60%, #000) 5px 9px,
      color-mix(in srgb, var(--menuColor) 46%, #000) 9px 15px,
      color-mix(in srgb, var(--backgroundColor) 66%, #000) 15px 19px);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.06),
    inset 0 10px 22px rgba(0, 0, 0, 0.7);
}
.tape-meta {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: clamp(1px, 0.3vmin, 4px);
  width: 42%;
  height: 56%;
  box-sizing: border-box;
  padding: clamp(2px, 0.5vmin, 6px) clamp(6px, 1.4vmin, 12px);
  text-align: center;
  border-radius: 6px;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--menuColor) 92%, #ffffff) 0%,
      color-mix(in srgb, var(--menuColor) 42%, #000000) 100%);
  border: 1px solid color-mix(in srgb, var(--backgroundColor) 38%, #000000);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 2px 8px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.tape-lyric {
  max-width: 100%;
  font-family: Georgia, 'Songti SC', 'SimSun', serif;
  font-size: clamp(13px, 2.8vmin, 24px);
  font-weight: 600;
  line-height: 1.3;
  color: var(--fontColor);
  text-shadow: none;
  display: -webkit-box;
  line-clamp: 2;            /* 标准属性（兼容性） */
  -webkit-line-clamp: 2;    /* 长歌词最多两行，超出省略 */
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
/* 全宽进度条（挂在控制栏上、跨上沿）：线贴控制栏上沿（媒体底部），圆钮完整、下半伸入控制栏顶部 */
.tape-progress {
  position: absolute;
  left: 0;
  right: 0;
  top: -13px; /* 以控制栏顶为中线 */
  height: 26px;
  cursor: pointer;
  z-index: 9;
  user-select: none;
  -webkit-user-select: none;
}
.tape-progress .tp-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 50%; /* 轨道底边正好落在控制栏上沿 */
  height: 4px;
  background: rgba(255, 255, 255, 0.16);
  box-shadow: inset 0 0 3px rgba(0, 0, 0, 0.9);
}
.tape-progress .tp-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0%;
  background: linear-gradient(90deg, color-mix(in srgb, var(--tape-accent) 68%, #000), var(--tape-accent));
}
.tape-progress .tp-thumb {
  position: absolute;
  top: 50%; /* 与进度线垂直居中 */
  width: 11px;
  height: 11px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--tape-accent) 62%, #fff), var(--tape-accent) 62%, color-mix(in srgb, var(--tape-accent) 55%, #000));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.65), inset 0 -1px 2px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.12s;
  pointer-events: none;
}
.tape-progress:hover .tp-thumb {
  opacity: 1;
}
.tape-progress .tp-time {
  position: absolute;
  bottom: calc(100% + 4px);
  font-size: 11px;
  line-height: 1;
  color: var(--tape-accent);
  font-variant-numeric: tabular-nums;
  background: rgba(0, 0, 0, 0.62);
  padding: 3px 7px;
  border-radius: 9px;
  white-space: nowrap;
  pointer-events: none;
}
.tape-progress .tp-cur { left: 6px; }
.tape-progress .tp-dur { right: 6px; }

/* 主行：左黑胶 + 右信息 */
.audio-main-row {
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 1200px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 36px;
  padding: 0 8px;
}

/* 黑胶唱片（随容器宽度平滑缩放，始终保持正方形） */
.audio-art {
  flex: 0 0 auto;
  width: clamp(120px, 55%, 440px);
  height: auto;
  aspect-ratio: 1 / 1;
  min-height: 120px;
  border-radius: 50%;
  position: relative;
  background:
    radial-gradient(circle at 50% 42%, #2c2c2c 0%, #171717 52%, #080808 100%);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.06),
    inset 0 0 14px rgba(0, 0, 0, 0.9),
    0 14px 34px rgba(0, 0, 0, 0.35);
}
/* 唱片盘面同心圆纹路 */
.audio-art::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: repeating-radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.05) 0 1px, transparent 1px 3px);
  pointer-events: none;
}
/* 中心孔 */
.audio-art::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 12px;
  height: 12px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(circle at 40% 40%, #666, #1c1c1c);
  box-shadow: inset 0 0 3px #000;
  z-index: 3;
  pointer-events: none;
}
/* 有封面：封面作为唱片中心标签 */
.art-img {
  position: absolute;
  inset: 16%;
  width: 68%;
  height: 68%;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  box-shadow: 0 0 0 3px #000, 0 0 14px rgba(0, 0, 0, 0.55);
}
/* 无封面：复古唱片标签替代 */
.art-fallback {
  position: absolute;
  inset: 16%;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: #f3e3bf;
  background:
    radial-gradient(circle at 35% 30%, rgba(255, 235, 190, 0.35) 0%, transparent 55%),
    linear-gradient(160deg, #b4753a 0%, #8a4f24 45%, #5f3216 100%);
  box-shadow: 0 0 0 3px #000, 0 0 14px rgba(0, 0, 0, 0.55);
  font-family: Georgia, 'Times New Roman', serif;
}
.art-fallback i {
  font-size: 50px;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
}
.art-fallback-label {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 2px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
}
/* 播放时唱片旋转 */
.audio-art.playing {
  animation: record-spin 14s linear infinite;
}
@keyframes record-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 右侧信息（标题 + 歌词） */
.audio-info {
  flex: 1;
  min-width: 0;
  max-width: 520px;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 6px 0;
}

/* 文件名称（复古衬线） */
.audio-title {
  max-width: 100%;
  flex: none;
  font-family: Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif;
  font-size: 30px;
  letter-spacing: 0.5px;
  color: var(--fontColor);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 歌词面板 */
.lyrics-panel {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  position: relative;
  border-top: 1px dashed color-mix(in srgb, var(--borderColor) 70%, transparent);
  border-bottom: 1px dashed color-mix(in srgb, var(--borderColor) 70%, transparent);
}
.lyrics-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none; /* Firefox：隐藏滚动条 */
}
.lyrics-scroll::-webkit-scrollbar {
  display: none; /* Chrome/Safari：隐藏滚动条 */
}
.lyric-line {
  padding: 6px 10px;
  font-size: clamp(14px, 2.4vmin, 24px);
  line-height: 1.6;
  color: var(--fontColor);
  opacity: 0.5;
  text-align: center;
  font-family: Georgia, 'Songti SC', 'SimSun', serif;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: break-word;
  transition: all 0.3s ease;
}
.lyric-line.active {
  opacity: 1;
  font-weight: 700;
  color: var(--fontActiveColor);
  background: transparent;
}

/* 频谱 */
/* 波形显示区（整曲峰谷 + 播放进度）：随容器自适应宽度 */
.wave-area {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  cursor: pointer;
}
.wave-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.wave-tooltip {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  z-index: 3;
}
/* 波形/频谱下方：当前歌词 */
.wave-lyric {
  flex: none;
  width: 100%;
  font-family: Georgia, 'Songti SC', 'SimSun', serif;
  font-size: clamp(16px, 3.6vmin, 32px);
  font-weight: 600;
  line-height: 1.3;
  color: color-mix(in srgb, var(--fontActiveColor) 80%, var(--fontColor));
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 控制条 ---------- */
.ctl-bar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--borderColor);
  background: var(--menuColor);
  position: relative; /* 承载顶部全宽进度条（圆钮可伸入其顶部） */
  overflow: visible;
}
/* 过窄时隐藏次要控件，保持单行 */
.ctl-bar.compact .volume-ctl,
.ctl-bar.compact .mode-btn,
.ctl-bar.compact .fs-btn,
.ctl-bar.compact .viewmode-btn {
  display: none;
}

.ctl-btn {
  background: transparent;
  border: none;
  color: var(--fontColor);
  font-size: 16px;
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s, transform 0.1s;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
}
.ctl-btn:hover {
  background: var(--menuActiveColor);
}
.ctl-btn:active {
  transform: scale(0.92);
}

.play-btn {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: linear-gradient(145deg, #f6d792, #d8a94f);
  color: #4a2f00;
  font-size: 15px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}
.play-btn:hover {
  background: linear-gradient(145deg, #ffe2a6, #e0b25c);
  transform: scale(1.06);
}

/* 上一首 / 下一首 */
.nav-btn {
  width: 36px;
  height: 36px;
  font-size: 14px;
}
.nav-btn:hover {
  color: var(--fontActiveColor);
}

.time {
  font-size: 12.5px;
  color: var(--fontColor);
  font-variant-numeric: tabular-nums;
  min-width: 44px;
  text-align: center;
  opacity: 0.9;
}

/* 视图切换按钮：文字徽标（替代不存在的磁带图标） */
.ctl-btn.viewmode-btn {
  width: auto;
  min-width: 46px;
  padding: 0 10px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.ctl-btn.viewmode-btn .viewmode-text {
  color: var(--fontActiveColor);
  line-height: 1;
}

/* ---------- 进度条 ---------- */
.seek-bar {
  flex: 1;
  min-width: 60px;
  cursor: pointer;
  padding: 8px 0;
  display: flex;
  align-items: center;
}
.seek-track {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: var(--borderColor);
  overflow: visible;
}
.seek-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 3px;
  background: var(--fontActiveColor);
}
.seek-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--fontColor);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}
.seek-bar:hover .seek-thumb {
  opacity: 1;
}

.ctl-group {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto; /* 无内联进度后，控制组统一靠右 */
}
/* 磁带模式隐藏内联进度/时间后，控制组右对齐 */
.ctl-bar.no-seek .ctl-group {
  margin-left: auto;
}
/* 磁带模式：控制栏弱化并融入机身 —— 去分隔线、透明深色渐变、按钮低调 */
.ctl-bar.no-seek {
  padding: 7px 18px 9px;
  border-top: none;
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--menuColor) 32%, #000000) 0%,
      color-mix(in srgb, var(--menuColor) 16%, #000000) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    inset 0 -14px 30px rgba(0, 0, 0, 0.5);
}
.ctl-bar.no-seek .ctl-btn {
  color: color-mix(in srgb, var(--fontColor) 70%, transparent);
  opacity: 0.92;
}
.ctl-bar.no-seek .ctl-btn:hover {
  color: var(--fontColor);
  background: rgba(255, 255, 255, 0.07);
}
.ctl-bar.no-seek .nav-btn:hover {
  color: var(--tape-accent);
}
.ctl-bar.no-seek .play-btn {
  background: linear-gradient(145deg,
    color-mix(in srgb, var(--tape-accent) 62%, #ffffff),
    color-mix(in srgb, var(--tape-accent) 44%, #000000));
  color: var(--tape-accent-text);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.ctl-bar.no-seek .play-btn:hover {
  background: linear-gradient(145deg,
    color-mix(in srgb, var(--tape-accent) 75%, #ffffff),
    color-mix(in srgb, var(--tape-accent) 40%, #000000));
}
.ctl-bar.no-seek .volume-slider {
  background: color-mix(in srgb, var(--borderColor) 38%, #000000);
}
.ctl-bar.no-seek .volume-slider::-webkit-slider-thumb {
  background: var(--tape-accent);
}
.ctl-bar.no-seek .viewmode-btn .viewmode-text {
  color: color-mix(in srgb, var(--tape-accent) 60%, #ffffff);
}
/* 浅色主题：磁带控制栏改浅色底 + 深色图标，保证按钮清晰可见 */
.media-container:not(.dark) .ctl-bar.no-seek {
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--menuColor) 96%, #ffffff) 0%,
      color-mix(in srgb, var(--menuColor) 74%, #000000) 100%);
  box-shadow: inset 0 -14px 30px rgba(0, 0, 0, 0.08);
}
.media-container:not(.dark) .ctl-bar.no-seek .ctl-btn {
  color: var(--fontColor);
  opacity: 1;
}
.media-container:not(.dark) .ctl-bar.no-seek .ctl-btn:hover {
  color: var(--fontColor);
  background: color-mix(in srgb, var(--menuActiveColor) 55%, transparent);
}
.media-container:not(.dark) .ctl-bar.no-seek .volume-slider {
  background: color-mix(in srgb, var(--borderColor) 72%, #000000);
}
.media-container:not(.dark) .ctl-bar.no-seek .volume-slider::-webkit-slider-thumb {
  background: var(--fontColor);
}
.media-container:not(.dark) .ctl-bar.no-seek .viewmode-btn .viewmode-text {
  color: var(--fontActiveColor);
}

.volume-ctl {
  display: flex;
  align-items: center;
  gap: 6px;
}

.volume-slider {
  width: 70px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  border-radius: 2px;
  background: var(--borderColor);
  outline: none;
  cursor: pointer;
}
.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fontColor);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  transition: transform 0.1s;
}
.volume-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

/* 播放速度选择已移除 */

/* 窄屏适配：封面缩小、音频信息区占满 */
@media (max-width: 640px) {
  .audio-art i {
    font-size: 32px;
  }
  .art-fallback-label {
    font-size: 11px;
  }
  .audio-main-row {
    gap: 16px;
  }
  .audio-title {
    font-size: 16px;
  }
  .audio-body {
    gap: 10px;
    padding: 10px 12px;
  }
  .ctl-bar {
    padding: 10px 14px;
  }
  .volume-slider {
    width: 50px;
  }
}

/* ---------- 状态提示 ---------- */
.media-status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fontColor);
  font-size: 14px;
  padding: 24px;
}
.media-status i {
  font-size: 20px;
  color: var(--fontActiveColor);
}
</style>
