<template>
  <!-- 注：不用 teleport —— 若宿主进入 requestFullscreen，body 外的浮层会不可见；
       普通渲染 + position:fixed 在各宿主（含 PPT 全屏）下均正常 -->
  <div v-if="visible" class="mermaid-viewer-overlay" @click="close">
      <div class="mermaid-viewer-content" @click.stop>
        <div class="mermaid-viewer-header">
          <span class="mermaid-viewer-title" :title="title">{{ title }}</span>
          <div class="mermaid-viewer-toolbar">
            <button class="mermaid-viewer-btn" @click="exportPng" title="导出为 PNG">
              <i class="fa fa-file-image-o"></i> PNG
            </button>
            <button class="mermaid-viewer-btn" @click="exportSvg" title="导出为 SVG">
              <i class="fa fa-file-code-o"></i> SVG
            </button>
            <button class="mermaid-viewer-btn" @click="fitToViewport" title="适应窗口">
              <i class="fa fa-arrows-alt"></i>
            </button>
            <span class="mermaid-viewer-zoom">{{ Math.round(zoom * 100) }}%</span>
            <button class="mermaid-viewer-btn" @click="zoomOut" title="缩小"><i class="fa fa-minus"></i></button>
            <button class="mermaid-viewer-btn" @click="resetView" title="重置"><i class="fa fa-undo"></i></button>
            <button class="mermaid-viewer-btn" @click="zoomIn" title="放大"><i class="fa fa-plus"></i></button>
            <button class="mermaid-viewer-btn" @click="close" title="关闭"><i class="fa fa-times"></i></button>
          </div>
        </div>
        <div
          ref="viewportRef"
          class="mermaid-viewer-viewport"
          @wheel.prevent="onWheel"
          @mousedown="panStart"
          @mousemove="panMove"
          @mouseup="panEnd"
          @mouseleave="panEnd"
        >
          <div
            class="mermaid-viewer-svg"
            :style="{
              transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
              cursor: panning ? 'grabbing' : 'grab'
            }"
            v-html="svg"
          ></div>
        </div>
      </div>
    </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { getCachedSvgLenient, renderMermaidSvgLenient, parseSvgSize, ensureSvgExplicitSize, svgToPngDataUrl, downloadFile } from '@/lib/markdown/mermaid'

export interface MermaidViewerOpenOptions {
  /** mermaid 源码（内部会走共享渲染/缓存）；与 svg 二选一 */
  source?: string
  /** 已渲染好的 SVG 字符串（调用方自带缓存时可直传） */
  svg?: string
  /** 弹窗标题；缺省取源码首行 */
  title?: string
}

const visible = ref(false)
const svg = ref('')
const title = ref('')
const zoom = ref(1)
const panX = ref(0)
const panY = ref(0)
let panning = false
let panStartX = 0
let panStartY = 0
let panStartCX = 0
let panStartCY = 0
const viewportRef = ref<HTMLElement | null>(null)

/** 让整张图按最大比例「铺满」视窗（contain 留少量边距）并居中 */
const fitToViewport = () => {
  const vp = viewportRef.value
  if (!vp) return
  const vw = vp.clientWidth
  const vh = vp.clientHeight
  const size = parseSvgSize(svg.value)
  if (!size || size.w <= 0 || size.h <= 0 || vw <= 0 || vh <= 0) {
    zoom.value = 1
    panX.value = 0
    panY.value = 0
    return
  }
  const pad = 24
  const scale = Math.min((vw - pad) / size.w, (vh - pad) / size.h)
  zoom.value = Math.max(0.05, Math.min(6, scale))
  panX.value = 0
  panY.value = 0
}

const open = async (opts: MermaidViewerOpenOptions = {}) => {
  let s = opts.svg || ''
  if (!s && opts.source) {
    const source = opts.source
    // 先尝试共享缓存（键 = 规范化后的源码）
    s = getCachedSvgLenient(source) || ''
    if (!s) {
      try {
        s = await renderMermaidSvgLenient(source)
      } catch (e) {
        console.error('[MermaidViewer] render failed:', e)
        return
      }
    }
  }
  if (!s) return
  // mermaid 默认输出 width=100%+viewBox，直接展示会按极小尺寸渲染；
  // 固定为 viewBox 原生像素尺寸，使缩放/平移以真实像素为基准
  const size = parseSvgSize(s)
  if (size) s = ensureSvgExplicitSize(s, size.w, size.h)
  svg.value = s
  title.value = opts.title || (opts.source
    ? opts.source.split('\n')[0]?.substring(0, 50) || 'Mermaid 图表'
    : 'Mermaid 图表')
  zoom.value = 1
  panX.value = 0
  panY.value = 0
  visible.value = true
  await nextTick()
  fitToViewport()
}

const close = () => {
  visible.value = false
  svg.value = ''
}

const zoomOut = () => { zoom.value = Math.max(0.05, zoom.value - 0.2) }
const zoomIn = () => { zoom.value = Math.min(8, zoom.value + 0.2) }
const resetView = () => { zoom.value = 1; panX.value = 0; panY.value = 0 }

const onWheel = (e: WheelEvent) => {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.1 : 0.1
  zoom.value = Math.max(0.05, Math.min(8, zoom.value + delta))
}

const panStart = (e: MouseEvent) => {
  panning = true
  panStartX = e.clientX
  panStartY = e.clientY
  panStartCX = panX.value
  panStartCY = panY.value
}

const panMove = (e: MouseEvent) => {
  if (!panning) return
  panX.value = panStartCX + (e.clientX - panStartX)
  panY.value = panStartCY + (e.clientY - panStartY)
}

const panEnd = () => {
  panning = false
}

const exportPng = async () => {
  try {
    const s = svg.value
    if (!s) return
    const dataUrl = await svgToPngDataUrl(s)
    downloadFile(dataUrl, `mermaid_${Date.now()}.png`)
  } catch (e) {
    console.error('[MermaidViewer] export PNG failed:', e)
  }
}

const exportSvg = () => {
  const s = svg.value
  if (!s) return
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s)
  downloadFile(dataUrl, `mermaid_${Date.now()}.svg`)
}

defineExpose({ open, close })
</script>

<style scoped>
.mermaid-viewer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: mermaidViewerFadeIn 0.2s ease;
}
.mermaid-viewer-content {
  width: 90vw;
  height: 90vh;
  max-width: 1200px;
  max-height: 90vh;
  background-color: var(--backgroundColor, #1e1e1e);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--borderColor, #333);
}
.mermaid-viewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--borderColor, #333);
  flex-shrink: 0;
  gap: 8px;
}
.mermaid-viewer-title {
  font-size: 13px;
  color: var(--fontColor, #ccc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.mermaid-viewer-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.mermaid-viewer-btn {
  padding: 4px 8px;
  border: 1px solid var(--borderColor, #444);
  border-radius: 4px;
  background-color: var(--menuColor, #2d2d2d);
  color: var(--fontColor, #ccc);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.mermaid-viewer-btn:hover {
  background-color: var(--menuActiveColor, #3a3a3a);
  color: var(--fontActiveColor, #fff);
  border-color: var(--fontActiveColor, #fff);
}
.mermaid-viewer-zoom {
  font-size: 12px;
  color: var(--fontColor, #999);
  min-width: 40px;
  text-align: center;
  user-select: none;
}
.mermaid-viewer-viewport {
  flex: 1;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  background-color: var(--backgroundColor);
  user-select: none;
}
.mermaid-viewer-svg {
  display: flex;
  align-items: center;
  justify-content: center;
  transform-origin: center center;
  pointer-events: none;
}
.mermaid-viewer-svg svg {
  max-width: none;
  max-height: none;
  display: block;
}
@keyframes mermaidViewerFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
