<script setup lang="ts">
/**
 * Mermaid.vue — `.mmd` / `.mermaid` 图表源码的「浏览」视图：源码 → 图。
 *
 * 只做呈现：渲染走共享管线（lib/markdown/mermaid 的规范化 + 缓存，与 Markdown 内嵌图表同一条路径），
 * 放大 / 平移 / 导出 PNG、SVG 复用共享组件 MermaidViewer；
 * 源码编辑仍由通用 Edit_Code（Monaco）承担，判别与视图范围见 components/knowFile/fileEditors.ts。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { usestore } from '@/store'
import { ensureMermaidInit, renderMermaidSvgLenient, getCachedSvgLenient } from '@/lib/markdown/mermaid'
import MermaidViewer from '@/components/MermaidViewer.vue'

const props = defineProps<{
  /** 文件绝对路径（只用于展示文件名；本视图不写盘，写盘由源码编辑视图负责） */
  path?: string
  /** Mermaid 源码（文件内容；远程文件由宿主注入同一 prop） */
  content?: string
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const svg = ref('')
const error = ref('')
/** 首次渲染中（命中共享缓存时不会亮） */
const rendering = ref(false)
const viewerRef = ref<InstanceType<typeof MermaidViewer> | null>(null)

/** 渲染序号：内容连续变化时丢弃过期结果，避免旧图覆盖新图 */
let seq = 0

const source = computed(() => String(props.content || '').replace(/^\uFEFF/, ''))
const isEmpty = computed(() => !source.value.trim())
const fileName = computed(() => {
  const p = String(props.path || '')
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
})

async function render() {
  const src = source.value
  if (!src.trim()) {
    seq++
    svg.value = ''
    error.value = ''
    rendering.value = false
    return
  }
  // 先吃共享缓存：同一份源码在 Markdown 里渲染过时立即可见，不闪「正在渲染」
  const cached = getCachedSvgLenient(src)
  if (cached) {
    seq++
    svg.value = cached
    error.value = ''
    rendering.value = false
    return
  }
  const my = ++seq
  rendering.value = true
  try {
    const out = await renderMermaidSvgLenient(src)
    if (my !== seq) return
    svg.value = out
    error.value = ''
  } catch (e: any) {
    if (my !== seq) return
    svg.value = ''
    error.value = e?.message || String(e || '')
  } finally {
    if (my === seq) rendering.value = false
  }
}

// 其他窗口 / AI 写入后宿主会更新 content，这里跟着重渲染
watch(source, render)

onMounted(() => {
  ensureMermaidInit()
  void render()
})

/** 点击图表 → 共享查看器（放大 / 平移 / 导出 PNG、SVG） */
const openViewer = () => {
  if (!svg.value) return
  viewerRef.value?.open({ svg: svg.value, title: fileName.value })
}
</script>

<template>
  <div class="mmd-wrap">
    <div
      class="mmd-canvas"
      :title="svg ? (zh ? '点击图表可放大 / 平移 / 导出 PNG、SVG' : 'Click the diagram to zoom, pan, export PNG / SVG') : ''"
      @click="openViewer"
    >
      <!-- 尺寸与限高交给 style.css 的 .mermaid-rendered-svg 统一规则（所有 Mermaid 入口共用） -->
      <div v-if="svg" class="mermaid-rendered-svg mmd-svg" v-html="svg"></div>

      <!-- 渲染失败：把源码一并显示出来，便于对照修正（改源码请切「源码编辑」视图） -->
      <div v-else-if="error" class="mmd-fail">
        <div class="mmd-fail-title">
          <i class="fa fa-exclamation-triangle"></i>
          {{ zh ? '图表渲染失败' : 'Failed to render diagram' }}
        </div>
        <div class="mmd-fail-msg">{{ error }}</div>
        <pre class="mmd-fail-src">{{ source }}</pre>
      </div>

      <div v-else class="mmd-hint">
        <i :class="isEmpty ? 'fa fa-sitemap' : 'fa fa-spinner fa-spin'"></i>
        <div>{{ isEmpty
          ? (zh ? '这个图表还没有源码：切到「源码编辑」写下 Mermaid 源码' : 'No source yet: switch to Source view and write Mermaid source')
          : (zh ? '正在渲染图表…' : 'Rendering diagram…') }}</div>
      </div>
    </div>

    <div v-if="svg" class="mmd-bar">
      <span class="mmd-name" :title="path">{{ fileName }}</span>
      <span class="mmd-tip"><i class="fa fa-search-plus"></i> {{ zh ? '点击图表放大 / 导出' : 'Click to zoom / export' }}</span>
    </div>

    <!-- 放大 / 平移 / 导出（与 Markdown 内嵌 Mermaid 图表共用） -->
    <MermaidViewer ref="viewerRef" />
  </div>
</template>

<style scoped>
.mmd-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  overflow: hidden;
}

.mmd-canvas {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  padding: 16px;
}

/* margin:auto 居中：内容超高时不会像 align-items:center 那样把顶部顶出可视区（裁切） */
.mmd-svg {
  width: 100%;
  margin: auto;
  cursor: zoom-in;
}

.mmd-hint,
.mmd-fail {
  margin: auto;
  text-align: center;
  color: var(--fontColor);
  opacity: 0.75;
  font-size: 13px;
}

.mmd-hint i {
  font-size: 22px;
  margin-bottom: 8px;
  display: block;
}

.mmd-fail {
  max-width: 720px;
  text-align: left;
  opacity: 1;
}

.mmd-fail-title {
  color: #e6a23c;
  font-size: 13px;
  margin-bottom: 6px;
}

.mmd-fail-msg {
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.85;
  word-break: break-word;
  margin-bottom: 8px;
}

.mmd-fail-src {
  margin: 0;
  padding: 8px 10px;
  max-height: calc(40vh / var(--ui-zoom, 1));
  overflow: auto;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--fontColor);
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
}

.mmd-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--fontColor);
  border-top: 1px solid var(--borderColor);
}

.mmd-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}

.mmd-tip {
  margin-left: auto;
  flex: none;
  opacity: 0.6;
}
</style>
