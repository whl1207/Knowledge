<template>
  <div class="video-root" tabindex="0" @keydown.space.prevent="togglePlay">
    <!-- 画面区 -->
    <div class="video-wrap" :class="{ playing: isPlaying }">
      <video
        ref="videoEl"
        :src="currentPath"
        preload="metadata"
        @click="togglePlay"
        @dblclick="toggleFullscreen"
        @timeupdate="onVideoTime"
        @loadedmetadata="onVideoLoaded"
        @loadeddata="onVideoLoaded"
        @play="onMediaPlay"
        @pause="onMediaPause"
        @ended="onMediaEnded"
      ></video>

      <!-- 未播放 / 播放结束遮罩（点击播放/重播） -->
      <div v-if="!isPlaying" class="video-cover" :class="{ ended: videoEnded }" @click="videoEnded ? replayVideo() : togglePlay()">
        <i :class="videoEnded ? 'fa fa-repeat' : 'fa fa-play'"></i>
      </div>
    </div>

    <!-- 底部状态栏（样式与 md_read / Edit_Code 一致：左按钮 + 右信息） -->
    <div class="video-statusbar">
      <!-- 操作按钮（左） -->
      <button class="statusbar-btn" @click="togglePlay"
              :title="isPlaying ? (store.locales==='zh' ? '暂停 (空格)' : 'Pause (Space)') : (store.locales==='zh' ? '播放 (空格)' : 'Play (Space)')">
        <i :class="isPlaying ? 'fa fa-pause' : 'fa fa-play'"></i>
      </button>
      <template v-if="canNavigateVideos && folderVideos.length > 1">
        <button class="statusbar-btn" @click="stepVideo(-1)" :title="store.locales==='zh' ? '上一集' : 'Previous'"><i class="fa fa-backward"></i></button>
        <button class="statusbar-btn" @click="stepVideo(1)" :title="store.locales==='zh' ? '下一集' : 'Next'"><i class="fa fa-forward"></i></button>
      </template>

      <!-- 进度（弹性占满剩余空间） -->
      <span class="statusbar-item time">{{ formatTime(currentTime) }}</span>
      <div ref="seekBar" class="seek-bar" @mousedown="onSeekDown">
        <div class="seek-track">
          <div class="seek-fill" :style="{ width: seekPercent + '%' }"></div>
          <div class="seek-thumb" :style="{ left: seekPercent + '%' }"></div>
        </div>
      </div>
      <span class="statusbar-item time">{{ formatTime(duration) }}</span>

      <!-- 集数（同目录第几集，点击回到第 1 集） -->
      <span v-if="canNavigateVideos && folderVideos.length > 1" class="statusbar-item sb-idx" @click="jumpToVideo(0)"
            :title="store.locales==='zh' ? ('共 ' + folderVideos.length + ' 集 · 点击回到第 1 集') : (folderVideos.length + ' eps · click to 1st')">
        <i class="fa fa-list-ol"></i>{{ (currentVideoIndex < 0 ? 1 : currentVideoIndex + 1) }} / {{ folderVideos.length }}
      </span>

      <!-- 音量 / 全屏 -->
      <div class="volume-ctl">
        <button class="statusbar-btn" @click="volume = volume > 0 ? 0 : 1"
                :title="store.locales==='zh' ? (volume === 0 ? '取消静音' : '静音') : (volume === 0 ? 'Unmute' : 'Mute')">
          <i :class="volume === 0 ? 'fa fa-volume-off' : volume < 0.5 ? 'fa fa-volume-down' : 'fa fa-volume-up'"></i>
        </button>
        <input type="range" class="volume-slider" min="0" max="1" step="0.05" v-model.number="volume" @input="applyVolume"
               :title="store.locales==='zh' ? '音量' : 'Volume'" />
      </div>
      <button class="statusbar-btn" @click="toggleFullscreen"
              :title="store.locales==='zh' ? '全屏 (双击画面)' : 'Fullscreen (double-click)'"><i class="fa fa-expand"></i></button>
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

// 内部当前播放路径：切集时更新，props.path 变化时同步（与父级分发器标签逻辑分离）
const currentPath = ref(props.path)

const VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg']

// ---------- 播放状态 ----------
const videoEl = ref<HTMLVideoElement | null>(null)
const seekBar = ref<HTMLDivElement | null>(null)
const isPlaying = ref(false)
const videoEnded = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)

let rafId: number | null = null
let seeking = false
// 切集后自动播放标记（用户点击切集属于手势，可自动继续播放）
let autoPlayAfterSwitch = false

// 同目录视频列表（用于上一集/下一集）
const folderVideos = ref<{ path: string; label: string }[]>([])
const currentVideoIndex = ref(-1)
const hasIpc = typeof window !== 'undefined' && !!(window as any).ipcRenderer
const canNavigateVideos = computed(() => !!currentPath.value && hasIpc)
const normPath = (p: string) => String(p || '').replace(/\\/g, '/').toLowerCase()

// 扫描当前视频同目录的全部视频（按文件名自然排序），并定位当前集下标
async function loadFolderVideos() {
  folderVideos.value = []
  currentVideoIndex.value = -1
  if (!canNavigateVideos.value) return
  const folder = (currentPath.value || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  if (!folder) return
  try {
    const files: any[] = (await window.ipcRenderer.invoke('getFiles', folder, 0)) || []
    folderVideos.value = files
      .filter((f: any) => f && f.type === 'file' && VIDEO_EXTS.includes(String(f.extension || '').toLowerCase()))
      .sort((a: any, b: any) => String(a.label || '').localeCompare(String(b.label || ''), undefined, { numeric: true }))
      .map((f: any) => ({ path: String(f.path || ''), label: String(f.label || f.name || '') }))
    const target = normPath(currentPath.value || '')
    currentVideoIndex.value = folderVideos.value.findIndex(v => normPath(v.path) === target)
  } catch {
    folderVideos.value = []
  }
}

// 应用新视频路径（更新内部路径并通知父组件分发器）
function applyVideo(path: string) {
  if (!path || normPath(path) === normPath(currentPath.value)) return
  currentPath.value = path
  emit('update:path', path)
}

// 上一集/下一集（dir=1 下一集，dir=-1 上一集；到边界自动循环）
function stepVideo(dir: number) {
  const total = folderVideos.value.length
  if (total <= 1) return
  let idx = currentVideoIndex.value
  if (idx < 0 || idx >= total) idx = dir > 0 ? -1 : total
  currentVideoIndex.value = (idx + dir + total) % total
  const next = folderVideos.value[currentVideoIndex.value]
  if (!next) return
  autoPlayAfterSwitch = true
  applyVideo(next.path)
}

// 跳转到指定集的同目录视频（供序号点击回到第 1 集）
function jumpToVideo(target: number) {
  const total = folderVideos.value.length
  if (total <= 0) return
  const idx = ((Math.trunc(target) % total) + total) % total
  const next = folderVideos.value[idx]
  if (!next || idx === currentVideoIndex.value) return
  autoPlayAfterSwitch = true
  applyVideo(next.path)
}

// 外部切换标签：同步内部路径（触发下方 watch 重新加载）
watch(() => props.path, (p) => { if (p) currentPath.value = p })

// 内部/外部切换视频：重置状态并重新加载
watch(currentPath, (newPath, oldPath) => {
  if (!newPath || newPath === oldPath) return
  isPlaying.value = false
  videoEnded.value = false
  currentTime.value = 0
  duration.value = 0
  loadFolderVideos()
  nextTick(() => {
    const el = videoEl.value
    if (el) { try { el.load() } catch {} }
    if (autoPlayAfterSwitch) {
      autoPlayAfterSwitch = false
      const e = videoEl.value
      if (e) e.play().catch(() => {})
    }
  })
})

// ---------- 播放控制 ----------
function togglePlay() {
  const el = videoEl.value
  if (!el) return
  if (el.paused) {
    videoEnded.value = false
    el.play().catch(() => {})
    isPlaying.value = true
  } else {
    el.pause()
    isPlaying.value = false
  }
}

function replayVideo() {
  const el = videoEl.value
  if (!el) return
  videoEnded.value = false
  el.currentTime = 0
  el.play().catch(() => {})
  isPlaying.value = true
}

function toggleFullscreen() {
  const el = videoEl.value
  if (!el) return
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    el.requestFullscreen?.()
  }
}

// ---------- 事件 ----------
function onVideoTime() {
  const el = videoEl.value
  if (el) currentTime.value = el.currentTime || 0
}
function onVideoLoaded() {
  const el = videoEl.value
  if (!el) return
  if (el.duration && isFinite(el.duration)) duration.value = el.duration
}
function onMediaPlay() { isPlaying.value = true }
function onMediaPause() { isPlaying.value = false }
function onMediaEnded() { isPlaying.value = false; videoEnded.value = true }

// 时间循环（video timeupdate 已驱动，此处在 seek 后/缓冲期间持续刷新）
function tick() {
  const el = videoEl.value
  if (el) {
    currentTime.value = el.currentTime || 0
    if (el.duration && isFinite(el.duration)) duration.value = el.duration
  }
  rafId = requestAnimationFrame(tick)
}

// ---------- 进度拖拽 ----------
function seekTo(ratio: number) {
  const el = videoEl.value
  if (!el || !el.duration || !isFinite(el.duration)) return
  const t = Math.max(0, Math.min(1, ratio)) * el.duration
  el.currentTime = t
  currentTime.value = el.currentTime
}

function onSeekDown(e: MouseEvent) {
  if (!videoEl.value) return
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
}
function seekFromBar(e: MouseEvent) {
  const bar = seekBar.value
  if (!bar) return
  const rect = bar.getBoundingClientRect()
  if (rect.width > 0) seekTo((e.clientX - rect.left) / rect.width)
}

// ---------- 音量 ----------
function applyVolume() {
  const el = videoEl.value
  if (el) el.volume = volume.value
}
watch(volume, applyVolume)

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
  loadFolderVideos()
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = null
  window.removeEventListener('mousemove', onSeekWindowMove)
  window.removeEventListener('mouseup', onSeekWindowUp)
  // 停止播放并释放视频源
  const el = videoEl.value
  if (el) {
    el.pause()
    el.removeAttribute('src')
    try { el.load() } catch {}
  }
})
</script>

<style scoped>
.video-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #000;
  outline: none;
  box-sizing: border-box;
}

/* ---------- 画面区 ---------- */
.video-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  background: #000;
}
.video-wrap video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  background: #000;
}

/* 未播放 / 结束遮罩 */
.video-cover {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.45));
  cursor: pointer;
  transition: background 0.25s;
}
.video-cover i {
  font-size: 56px;
  color: rgba(255, 255, 255, 0.75);
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.6);
  transition: transform 0.15s, color 0.15s;
}
.video-cover:hover i {
  color: #fff;
  transform: scale(1.08);
}
.video-cover.ended {
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.6));
}

/* 播放时隐藏封面（纯画面） */
.video-wrap.playing .video-cover {
  display: none;
}

/* ---------- 底部状态栏（样式与 md_read / Edit_Code 一致） ---------- */
.video-statusbar {
  flex-shrink: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  box-sizing: border-box;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  z-index: 60;
}
/* 覆盖全局 button{width:100%}，避免状态栏按钮被撑满整行 */
.video-statusbar button {
  width: auto;
}
.video-statusbar .statusbar-btn {
  margin: 0;
  padding: 0 6px;
  width: auto;
  height: 18px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 0.15s;
  flex-shrink: 0;
}
.video-statusbar .statusbar-btn:hover {
  background-color: var(--menuActiveColor);
  opacity: 1;
}
.video-statusbar .statusbar-btn:active {
  transform: scale(0.92);
}
.video-statusbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
  flex-shrink: 0;
}
.video-statusbar .statusbar-item i {
  font-size: 11px;
  opacity: 0.7;
}
.video-statusbar .statusbar-spacer {
  flex: 1;
}
.video-statusbar .statusbar-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  margin: 0 4px;
  opacity: 0.6;
  flex-shrink: 0;
}
/* 时间码等宽数字 */
.video-statusbar .time {
  font-variant-numeric: tabular-nums;
  text-align: center;
  padding:0 4px;
}
/* 可点击序号 */
.video-statusbar .sb-idx {
  cursor: pointer;
  min-width: 46px;
  justify-content: center;
}
.video-statusbar .sb-idx:hover {
  background-color: var(--menuActiveColor);
  border-radius: 3px;
}

/* ---------- 进度条 ---------- */
.seek-bar {
  flex: 1;
  min-width: 60px;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  align-self: stretch;
}
.seek-track {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: var(--borderColor);
  overflow: visible;
}
.seek-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 2px;
  background: var(--fontActiveColor);
}
.seek-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 11px;
  height: 11px;
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

/* ---------- 音量 ---------- */
.volume-ctl {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 2px;
}
.volume-slider {
  width: 60px;
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
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--fontColor);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  transition: transform 0.1s;
}
.volume-slider::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

/* 窄屏：隐藏音量滑条，避免挤压进度条 */
@media (max-width: 768px) {
  .volume-slider {
    display: none;
  }
}
</style>
