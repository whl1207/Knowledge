<!-- /fileView.vue - 文件视图（状态/规范化 + 文件列表 + 摘要 + 预览 + 悬浮提示）；逻辑/数据由父壳注入 -->
<script setup lang="ts">
import PdfViewer from '@/components/knowFile/view/PdfViewer.vue'
import md_read from '@/components/knowFile/view/md_read.vue'
import { ref, computed, onBeforeUnmount } from 'vue'
import { isPdfFile, isWordFile, isMissingMd, formatSize, formatTime } from '@/lib/kbFile'

defineOptions({ name: 'FileView' })

// ---------------- 组件接口（父壳注入） ----------------
interface Props {
  store: any
  files: any[]
  selectedFileIndex: number
  fileChanges: any
  /** 缺失文件：知识库记录但当前文件夹中已不存在（仅提示 + 手动清理，不自动删除切片） */
  missingFiles?: string[]
  onCleanupMissing?: () => void
  currentFileSummary?: string
  previewContent: string
  /** 正文读取中（切换文件时显示骨架，不闪旧内容） */
  previewLoading?: boolean
  /** 按路径的切片统计：{ total, ready } */
  sliceStats?: Record<string, { total: number; ready: number }>
  tooltipVisible: boolean
  tooltipData: any
  tooltipPos: { x: number; y: number }
  // 回调（父壳实现：预览 / 悬浮提示定位）
  onPreview?: (index: number) => void
  onShowTooltip?: (e: MouseEvent, file: any) => void
  onHideTooltip?: () => void
}
const props = defineProps<Props>()

// ---- 文件展示逻辑（本组件自持；纯展示工具来自 src/lib/kbFile 共享） ----
/** 文件变更状态：'added' / 'modified' / 'deleted' / ''（空表示无变更标记） */
const fileChangeType = (file: any): 'added' | 'modified' | 'deleted' | '' => {
  if (!file?.path) return ''
  const c = props.fileChanges
  if (c.deleted.includes(file.path)) return 'deleted'
  if (c.added.includes(file.path)) return 'added'
  if (c.modified.includes(file.path)) return 'modified'
  return ''
}
/** 文件变更徽标文案 */
const fileChangeBadgeText = (file: any): string => {
  switch (fileChangeType(file)) {
    case 'added': return props.store.locales == 'zh' ? '新增' : 'NEW'
    case 'modified': return props.store.locales == 'zh' ? '修改' : 'MOD'
    case 'deleted': return props.store.locales == 'zh' ? '删除' : 'DEL'
    default: return ''
  }
}
/** 缺失文件在列表里的显示名（取文件名，完整路径放 title） */
const missingName = (p: string) => String(p || '').replace(/\\/g, '/').split('/').pop() || p

/** 文件行名称着色：按变更状态（新增=绿 / 修改=橙 / 删除=红），其次缺少同名 md 标红 */
const fileChangeNameStyle = (file: any): Record<string, string> => {
  const t = fileChangeType(file)
  if (t === 'added') return { color: '#4CAF50' }
  if (t === 'modified') return { color: '#FF9800' }
  if (t === 'deleted') return { color: '#F56C6C' }
  if (isMissingMd(file, props.files)) return { color: '#F56C6C' }
  return {}
}

// ===== 文件列表：搜索 / 筛选 / 排序 / 元信息 =====
const searchKw = ref('')
const filterMode = ref<'all' | 'changed' | 'missing-md'>('all')
const sortMode = ref<'name' | 'time' | 'size'>('name')
const summaryOpen = ref(true)
const missingOpen = ref(true)
const listWidth = ref(Number(localStorage.getItem('kbFileListWidth')) || 280)
let resizing = false
let resizeStartX = 0
let resizeStartW = 0

const rows = computed(() => {
  const kw = searchKw.value.trim().toLowerCase()
  const out = props.files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => {
      if (filterMode.value === 'changed' && !fileChangeType(file)) return false
      if (filterMode.value === 'missing-md' && !isMissingMd(file, props.files)) return false
      if (kw) {
        const hay = `${file.label || ''} ${file.path || ''}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
  out.sort((a, b) => {
    if (sortMode.value === 'time') return Number(b.file.mtime || 0) - Number(a.file.mtime || 0)
    if (sortMode.value === 'size') return Number(b.file.size || 0) - Number(a.file.size || 0)
    return String(a.file.label || '').localeCompare(String(b.file.label || ''))
  })
  return out
})
const changedCount = computed(() => props.files.filter((f) => !!fileChangeType(f)).length)
const missingMdCount = computed(() => props.files.filter((f) => isMissingMd(f, props.files)).length)
const currentFile = computed(() => props.files[props.selectedFileIndex] || null)
const currentStats = computed(() => currentFile.value ? props.sliceStats?.[currentFile.value.path] : undefined)

function startResize(e: PointerEvent): void {
  resizing = true
  resizeStartX = e.clientX
  resizeStartW = listWidth.value
  window.addEventListener('pointermove', onResize)
  window.addEventListener('pointerup', stopResize, { once: true })
}
function onResize(e: PointerEvent): void {
  if (!resizing) return
  listWidth.value = Math.max(220, Math.min(440, resizeStartW + e.clientX - resizeStartX))
}
function stopResize(): void {
  resizing = false
  window.removeEventListener('pointermove', onResize)
  try { localStorage.setItem('kbFileListWidth', String(listWidth.value)) } catch { /* ignore */ }
}
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onResize)
})
</script>

<template>
  <div class="file-view-root">
    <!-- 左侧：搜索 / 筛选 / 文件列表，可拖动分隔条调整宽度 -->
    <aside class="file-list-pane" :style="{ width: listWidth + 'px' }">
      <div class="file-list-toolbar">
        <div class="file-search">
          <i class="fa fa-search"></i>
          <input v-model="searchKw" :placeholder="store.locales=='zh' ? '搜索文件…' : 'Search files…'" />
          <i v-if="searchKw" class="fa fa-times-circle file-search-clear" @click="searchKw = ''"></i>
        </div>
        <div class="file-filter-row">
          <button class="file-chip" :class="{ on: filterMode === 'all' }" @click="filterMode = 'all'">{{ store.locales=='zh' ? '全部' : 'All' }} <b>{{ files.length }}</b></button>
          <button class="file-chip" :class="{ on: filterMode === 'changed' }" @click="filterMode = 'changed'">{{ store.locales=='zh' ? '变更' : 'Changed' }} <b>{{ changedCount }}</b></button>
          <button class="file-chip" :class="{ on: filterMode === 'missing-md' }" @click="filterMode = 'missing-md'">{{ store.locales=='zh' ? '缺 md' : 'No md' }} <b>{{ missingMdCount }}</b></button>
          <select v-model="sortMode" class="file-sort" :title="store.locales=='zh' ? '排序' : 'Sort'">
            <option value="name">{{ store.locales=='zh' ? '名称' : 'Name' }}</option>
            <option value="time">{{ store.locales=='zh' ? '时间' : 'Time' }}</option>
            <option value="size">{{ store.locales=='zh' ? '大小' : 'Size' }}</option>
          </select>
        </div>
      </div>

      <!-- 缺失文件：可折叠，不再长期占用列表顶部 -->
      <div v-if="(missingFiles || []).length" class="file-missing-panel">
        <div class="file-missing-head" @click="missingOpen = !missingOpen">
          <i class="fa fa-exclamation-triangle"></i>
          <span>{{ store.locales=='zh' ? `缺失文件 ${(missingFiles || []).length}` : `Missing ${(missingFiles || []).length}` }}</span>
          <i class="fa" :class="missingOpen ? 'fa-angle-down' : 'fa-angle-right'" style="margin-left:auto;"></i>
          <i class="fa fa-trash file-missing-clean"
             :title="store.locales=='zh' ? '清理这些缺失文件的切片 / 问题 / 摘要（需确认）' : 'Clean up slices / questions / summaries of these missing files (asks for confirmation)'"
             @click.stop="onCleanupMissing && onCleanupMissing()"></i>
        </div>
        <div v-show="missingOpen" class="file-missing-list">
          <div v-for="(p, i) in (missingFiles || [])" :key="i" class="file-missing-item" :title="p">
            <i class="fa fa-file-o"></i> {{ missingName(p) }}
          </div>
        </div>
      </div>

      <div class="file-rows scoll">
        <div v-if="rows.length === 0" class="file-empty">
          <i class="fa fa-folder-open-o"></i>
          <span>{{ searchKw || filterMode !== 'all' ? (store.locales=='zh' ? '没有匹配的文件' : 'No matching files') : (store.locales=='zh' ? '当前文件夹没有文件' : 'No files') }}</span>
        </div>
        <div v-for="{ file, index } in rows" :key="file.path || index" :class="['file-row', { active: selectedFileIndex === index }]">
          <div
              @click="onPreview && onPreview(index)"
              @mouseenter="onShowTooltip && onShowTooltip($event, file)"
              @mouseleave="onHideTooltip && onHideTooltip()"
              class="file-name"
              :style="fileChangeNameStyle(file)"
          >
            <i :class="store.icon(file.extension)"></i>
            <span class="file-label">{{ file.label }}</span>
            <i v-if="isMissingMd(file, files)" class="fa fa-exclamation-triangle" style="margin-left:2px;flex-shrink:0;"></i>
            <span v-if="fileChangeType(file)" class="file-change-badge" :class="'badge-' + fileChangeType(file)">{{ fileChangeBadgeText(file) }}</span>
          </div>
          <div class="file-meta" :title="file.path">
            <span>{{ formatSize(file.size) }}</span>
            <span v-if="file.mtime">{{ formatTime(file.mtime) }}</span>
            <span v-if="sliceStats?.[file.path]">{{ sliceStats[file.path].total }} {{ store.locales=='zh' ? '切片' : 'slices' }}</span>
            <span v-if="sliceStats?.[file.path]" :class="sliceStats[file.path].ready >= sliceStats[file.path].total ? 'meta-ok' : 'meta-warn'">
              {{ sliceStats[file.path].ready }}/{{ sliceStats[file.path].total }} {{ store.locales=='zh' ? '向量' : 'vec' }}
            </span>
          </div>
        </div>
      </div>
      <div class="file-list-count">
        {{ store.locales=='zh' ? `显示 ${rows.length} / ${files.length}` : `${rows.length} / ${files.length}` }}
      </div>
    </aside>

    <!-- 可拖动分隔条 -->
    <div class="file-splitter" @pointerdown.prevent="startResize" :title="store.locales=='zh' ? '拖动调整列表宽度' : 'Drag to resize'"></div>

    <!-- 右侧：当前文件头部 + 摘要 + 预览 -->
    <main class="file-preview-pane">
      <div v-if="currentFile" class="file-preview-head">
        <div class="file-preview-title" :title="currentFile.path">
          <i :class="store.icon(currentFile.extension)"></i>
          <b>{{ currentFile.label }}</b>
        </div>
        <div class="file-preview-meta">
          <span v-if="currentFile.size != null">{{ formatSize(currentFile.size) }}</span>
          <span v-if="currentFile.mtime">{{ formatTime(currentFile.mtime) }}</span>
          <span v-if="currentStats">{{ currentStats.total }} {{ store.locales=='zh' ? '切片' : 'slices' }}</span>
          <span v-if="currentStats" :class="currentStats.ready >= currentStats.total ? 'meta-ok' : 'meta-warn'">{{ currentStats.ready }}/{{ currentStats.total }} {{ store.locales=='zh' ? '向量化' : 'embedded' }}</span>
        </div>
      </div>
      <!-- 文件摘要：可折叠，长摘要不挤压预览 -->
      <div v-if="currentFileSummary" class="file-summary-panel">
        <div class="file-summary-head" @click="summaryOpen = !summaryOpen">
          <i class="fa fa-file-text-o"></i>
          <span>{{ store.locales=='zh' ? '文件摘要' : 'File Summary' }}</span>
          <i class="fa" :class="summaryOpen ? 'fa-angle-down' : 'fa-angle-right'" style="margin-left:auto;"></i>
        </div>
        <div v-show="summaryOpen" class="file-summary-body scoll">{{ currentFileSummary }}</div>
      </div>
      <div class="file-preview-body scoll">
        <div v-if="previewLoading" class="file-preview-loading">
          <div class="file-skeleton"></div>
          <div class="file-skeleton short"></div>
          <div class="file-skeleton"></div>
          <span>{{ store.locales=='zh' ? '正在读取文件…' : 'Loading file…' }}</span>
        </div>
        <PdfViewer
            v-else-if="isPdfFile(currentFile?.extension)"
            :path="currentFile?.path"
        />
        <md_read
            v-else-if="isWordFile(currentFile?.extension)"
            :content="previewContent"
            :path="currentFile?.path"
        />
        <md_read v-else :content="previewContent" :path="currentFile?.path"/>
      </div>
    </main>

    <!-- 悬浮提示（hover 触发，不再跟随 mousemove） -->
    <div v-if="tooltipVisible && tooltipData" class="tree-tooltip" :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }">
      <div class="tooltip-name">{{ tooltipData.label }}</div>
      <div v-if="tooltipData.size != null">{{ store.locales=='zh'?'大小':'Size' }}: {{ formatSize(tooltipData.size) }}</div>
      <div v-if="tooltipData.mtime">{{ store.locales=='zh'?'修改时间':'Modified' }}: {{ formatTime(tooltipData.mtime) }}</div>
      <div v-if="isMissingMd(tooltipData, files)" style="color:#F56C6C;">
        <i class="fa fa-exclamation-triangle"></i> {{ store.locales=='zh'?'缺少同名 Markdown 文档':'Missing matching Markdown file' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-view-root {
  display: flex;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  padding: 5px;
  gap: 0;
  align-items: stretch;
  container-type: inline-size;
}
.file-list-pane {
  height: 100%;
  min-width: 220px;
  max-width: 440px;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  overflow: hidden;
  user-select: none;
}
.file-list-toolbar { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
.file-search {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
}
.file-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--fontColor); font-size: 11px; }
.file-search .fa { font-size: 10px; opacity: .65; flex-shrink: 0; }
.file-search-clear { cursor: pointer; }
.file-filter-row { display: flex; align-items: center; gap: 3px; flex-wrap: wrap; }
.file-chip {
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  font-size: 9px;
  cursor: pointer;
  white-space: nowrap;
}
.file-chip b { font-weight: 500; opacity: .55; }
.file-chip.on { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: var(--menuActiveColor); }
.file-sort {
  height: 22px;
  margin-left: auto;
  max-width: 76px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 9px;
  outline: none;
}
.file-rows { flex: 1; min-height: 0; overflow-y: auto; }
.file-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px 8px; font-size: 11px; color: var(--borderColor); }
.file-empty .fa { font-size: 18px; }
.file-list-count { flex-shrink: 0; font-size: 9px; color: var(--borderColor); text-align: right; }
.file-splitter { width: 5px; flex: 0 0 5px; cursor: col-resize; position: relative; }
.file-splitter::after { content: ''; position: absolute; top: 8px; bottom: 8px; left: 2px; width: 1px; background: var(--borderColor); opacity: .55; }
.file-splitter:hover::after { background: var(--fontActiveColor); opacity: 1; }
.file-preview-pane { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; gap: 5px; box-sizing: border-box; }
.file-preview-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
}
.file-preview-title { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: 11px; color: var(--fontColor); }
.file-preview-title b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-preview-title .fa { color: var(--fontActiveColor); flex-shrink: 0; }
.file-preview-meta { margin-left: auto; display: flex; align-items: center; gap: 7px; flex-shrink: 0; font-size: 9px; color: var(--fontColor); opacity: .62; white-space: nowrap; }
.meta-ok { color: #3fb950; opacity: .95; }
.meta-warn { color: #d29922; opacity: .95; }
.file-preview-body { flex: 1; min-height: 0; border: 1px solid var(--borderColor); border-radius: 5px; overflow: auto; box-sizing: border-box; position: relative; }
.file-preview-loading {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  font-size: 10px;
  color: var(--borderColor);
}
.file-skeleton { height: 12px; width: 82%; border-radius: 4px; background: var(--menuActiveColor); opacity: .55; animation: filePulse 1.2s ease-in-out infinite; }
.file-skeleton.short { width: 48%; }
@keyframes filePulse { 0%, 100% { opacity: .35; } 50% { opacity: .7; } }

.file-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 4px;
  padding: 4px 5px;
  border-radius: 4px;
  border: 1px solid transparent;
}
.file-row.active { background: var(--menuColor); border-color: var(--borderColor); }
.file-name { display: flex; align-items: center; gap: 3px; min-width: 0; cursor: pointer; }
.file-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 9px; color: var(--fontColor); opacity: .5; white-space: nowrap; overflow: hidden; }
.file-meta span { overflow: hidden; text-overflow: ellipsis; }
.file-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-change-badge {
  margin-left: 4px;
  font-size: 9px;
  line-height: 1.4;
  padding: 0 4px;
  border-radius: 3px;
  color: var(--fontColor);
  flex-shrink: 0;
  vertical-align: 1px;
}
.file-change-badge.badge-added { background: #4CAF50; }
.file-change-badge.badge-modified { background: var(--menuActiveColor); }
.file-change-badge.badge-deleted { background: #F56C6C; }

/* ===== 缺失文件面板（知识库记录但当前文件夹没有） ===== */
.file-missing-panel {
  border: 1px dashed #F56C6C; border-radius: 5px;
  padding: 4px 6px; margin-bottom: 6px; font-size: 11px;
}
.file-missing-head {
  display: flex; align-items: center; gap: 4px; color: #F56C6C; font-weight: 600;
}
.file-missing-clean { margin-left: auto; cursor: pointer; }
.file-missing-clean:hover { color: var(--fontActiveColor); }
.file-missing-list { max-height: 132px; overflow-y: auto; margin-top: 3px; }
.file-missing-item { color: var(--fontColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-missing-note { color: var(--borderColor); margin-top: 3px; }
.tree-tooltip {
  position: fixed;
  z-index: 99999;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  line-height: 1.8;
  white-space: nowrap;
  padding: 6px 10px;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
  pointer-events: none;
  max-width: calc(60vw / var(--ui-zoom, 1));
}
.tooltip-name {
  white-space: normal;
  word-break: break-all;
  font-weight: bold;
  color: var(--fontColor);
}
.file-summary-panel {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  padding: 6px 8px;
  flex-shrink: 0;
  max-height: 160px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
}
.file-summary-head {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 500;
  color: var(--fontActiveColor);
  margin-bottom: 4px;
  user-select: none;
}
.file-summary-head .fa { font-size: 11px; }
.file-summary-body {
  font-size: 11px;
  line-height: 1.6;
  color: var(--fontColor);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  max-height: 116px;
}
@media (max-width: 760px) {
  .file-view-root { flex-direction: column; }
  .file-list-pane { width: auto !important; max-width: none; height: 40%; min-height: 150px; }
  .file-splitter { display: none; }
  .file-preview-pane { height: 60%; }
  .file-preview-meta { display: none; }
}
</style>
