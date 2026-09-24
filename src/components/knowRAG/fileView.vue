<!-- /fileView.vue - 文件视图（状态/规范化 + 文件列表 + 摘要 + 预览 + 悬浮提示）；逻辑/数据由父壳注入 -->
<script setup lang="ts">
import PdfViewer from '@/components/knowFile/view/PdfViewer.vue'
import md_read from '@/components/knowFile/view/md_read.vue'
import { isPdfFile, isWordFile, isMissingMd, formatSize, formatTime } from '@/lib/kbFile'

defineOptions({ name: 'FileView' })

// ---------------- 组件接口（父壳注入） ----------------
interface Props {
  store: any
  files: any[]
  selectedFileIndex: number
  fileChanges: any
  currentFileSummary?: string
  previewContent: string
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
/** 文件行名称着色：按变更状态（新增=绿 / 修改=橙 / 删除=红），其次缺少同名 md 标红 */
const fileChangeNameStyle = (file: any): Record<string, string> => {
  const t = fileChangeType(file)
  if (t === 'added') return { color: '#4CAF50' }
  if (t === 'modified') return { color: '#FF9800' }
  if (t === 'deleted') return { color: '#F56C6C' }
  if (isMissingMd(file, props.files)) return { color: '#F56C6C' }
  return {}
}
</script>

<template>
  <div style="display:flex;gap:5px;padding:5px;height:100%;width:100%;box-sizing:border-box;align-items:stretch;">
    <div class="scoll" style="width:240px;height:100%; overflow:auto; border:1px solid var(--borderColor); border-radius:5px; padding:6px; box-sizing:border-box;user-select: none;">
      <div v-if="files.length===0" style="color:var(--borderColor);">无文件</div>
      <div v-for="(file, idx) in files" :key="idx" :class="['file-row', { active: selectedFileIndex===idx }]">
        <div
            @click="onPreview && onPreview(idx)"
            @mousemove="onShowTooltip && onShowTooltip($event, file)"
            @mouseleave="onHideTooltip && onHideTooltip()"
            class="file-name"
            :style="fileChangeNameStyle(file)"
        >
          <i :class="store.icon(file.extension)"></i>
          <span class="file-label">{{ file.label }}</span>
          <i v-if="isMissingMd(file, files)" class="fa fa-exclamation-triangle" style="margin-left:2px;flex-shrink:0;"></i>
        </div>
        <span v-if="fileChangeType(file)" class="file-change-badge" :class="'badge-' + fileChangeType(file)">{{ fileChangeBadgeText(file) }}</span>
      </div>
    </div>
    <div style="flex:1; height:100%; display:flex; flex-direction:column; gap:5px; min-width:0; box-sizing:border-box;">
      <!-- 文件摘要面板：显示 LLM 推理出的文件摘要（fileIndex），无推理摘要时回退 YAML 摘要 -->
      <div v-if="currentFileSummary" class="file-summary-panel scoll">
        <div class="file-summary-head">
          <i class="fa fa-file-text-o"></i>
          {{ store.locales=='zh' ? '文件摘要' : 'File Summary' }}
        </div>
        <div class="file-summary-body">{{ currentFileSummary }}</div>
      </div>
      <div style="flex:1; height:0; border:1px solid var(--borderColor); border-radius:5px; overflow:auto; box-sizing:border-box;">
        <PdfViewer
            v-if="isPdfFile(files[selectedFileIndex]?.extension)"
            :path="files[selectedFileIndex]?.path"
        />
        <md_read
            v-else-if="isWordFile(files[selectedFileIndex]?.extension)"
            :content="previewContent"
            :path="files[selectedFileIndex]?.path"
        />
        <md_read v-else :content="previewContent" :path="files[selectedFileIndex]?.path"/>
      </div>
    </div>
    <!-- 悬浮提示（参照 panel.vue，跟随鼠标显示文件信息） -->
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
/* 以下样式由 knowRAG 迁出（原父 scoped），随文件视图一起维护 */
.file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  padding: 4px;
  border-radius: 4px;
}
.file-row.active { background: var(--menuColor); }
.file-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  cursor: pointer;
}
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
  max-width: 60vw;
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
  max-height: 130px;
  overflow-y: auto;
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
}
</style>
