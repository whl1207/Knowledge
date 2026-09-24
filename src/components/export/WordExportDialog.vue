<script setup lang="ts">
/**
 * 「导出为 Word」另存为对话框
 *
 * 与原生另存为的差别：多一层「导出样式」选择（内置三种模板 / 上传自定义 .docx 皮肤），
 * 保存位置默认定位到**当前文档所在目录**（聊天导出没有源文件时留空 → 落系统下载目录），
 * 也可点右侧文件夹按钮弹原生另存为改路径/改名。
 *
 * 确认后统一走 exportMarkdownAsWord → 主进程 exportDocx 直写磁盘；
 * 成功/失败提示由导出管线（ElMessage）给出，本组件只负责收表单与关闭。
 */
import { ref, computed, watch } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import { exportMarkdownAsWord } from '@/lib/export/md-to-docx'

const props = defineProps<{
  modelValue: boolean
  /** 待导出的 Markdown 源 */
  markdown: string
  /** 文档标题（决定默认文件名） */
  title: string
  /** 默认保存目录（当前文档所在目录；留空 = 系统下载目录） */
  defaultDir?: string
  /** 相对图片路径的兜底基目录 */
  baseDir?: string
  /** 是否去除 YAML frontmatter */
  stripFrontmatter?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')

/** 与设置页「Word 导出」保持同一套模板 key */
const templates = [
  { key: 'gongwen', labelZh: '公文（GB/T 9704-2012）', labelEn: 'Official (GB/T 9704-2012)' },
  { key: 'cn', labelZh: '中文论文', labelEn: 'Chinese Paper' },
  { key: 'en', labelZh: '英文论文（APA 7th）', labelEn: 'English Paper (APA 7th)' },
  { key: 'custom', labelZh: '自定义 Word 模板', labelEn: 'Custom Word Template' },
]

const template = ref('gongwen')
const stylePath = ref('')
const targetPath = ref('')
/** 路径来自原生另存为对话框（用户已确认过覆盖）→ 写盘时不改名 */
const picked = ref(false)
const busy = ref(false)

const ipc: any = (window as any)?.ipcRenderer
const canPick = !!ipc?.invoke

/** 文件名基（与 download.ts 的清洗规则一致，避免默认名与实际落盘名不符） */
const safeBase = computed(() => (props.title || '文档').replace(/[\\/:*?"<>|]/g, '_').trim() || '文档')

/** 拼目录 + 文件名（统一用 /，Windows 侧两种分隔符都能识别） */
function joinPath(dir: string, name: string): string {
  const d = (dir || '').replace(/\\/g, '/')
  if (!d) return name
  return d.endsWith('/') ? d + name : d + '/' + name
}

function hasDir(p: string): boolean {
  return /[\\/]/.test(p)
}

const hint = computed(() => {
  if (picked.value) return zh.value ? '已用「另存为」确认路径：同名文件将被覆盖' : 'Path confirmed via Save As: existing file will be overwritten'
  if (!hasDir(targetPath.value)) return zh.value ? '未指定目录 → 保存到系统下载目录；同名文件自动重命名（加 (1)）' : 'No folder given → saved to the system Downloads folder; duplicates get a (1) suffix'
  return zh.value ? '同名文件会自动重命名（加 (1)）；所选样式会被记住' : 'Duplicates get a (1) suffix; the chosen style is remembered'
})

// 打开时用当前设置 + 默认目录重置表单（immediate：组件挂载时若已是打开状态也能初始化）
watch(() => props.modelValue, (v) => {
  if (!v) return
  template.value = store.UI.wordExportTemplate || 'gongwen'
  stylePath.value = store.UI.wordExportStylePath || ''
  targetPath.value = joinPath(props.defaultDir || '', `${safeBase.value}.docx`)
  picked.value = false
  busy.value = false
}, { immediate: true })

const close = () => { if (!busy.value) emit('update:modelValue', false) }

/** 选择自定义 .docx 皮肤文件 */
const pickStyle = async () => {
  if (!canPick) {
    ElMessage.warning(zh.value ? '当前环境无法选择文件' : 'File picking unavailable here')
    return
  }
  const path = await ipc.invoke('selectFile', {
    filters: [{ name: 'Word 样式模板', extensions: ['docx'] }],
    properties: ['openFile'],
  })
  if (path) stylePath.value = path
}

/** 原生另存为：改目录/改文件名（同名由系统对话框确认覆盖） */
const browse = async () => {
  if (!canPick) {
    ElMessage.warning(zh.value ? '当前环境无法选择保存位置' : 'Save dialog unavailable here')
    return
  }
  const path = await ipc.invoke('saveFileDialog', {
    defaultPath: targetPath.value || `${safeBase.value}.docx`,
    filters: [{ name: 'Word 文档', extensions: ['docx'] }],
  })
  if (path) {
    targetPath.value = path
    picked.value = true
  }
}

const doExport = async () => {
  if (busy.value || !props.markdown) return
  if (template.value === 'custom' && !stylePath.value) {
    ElMessage.warning(zh.value ? '请选择自定义样式 .docx，或改用内置模板' : 'Pick a custom .docx or use a built-in template')
    return
  }
  busy.value = true
  try {
    await exportMarkdownAsWord(props.markdown, {
      title: safeBase.value,
      baseDir: props.baseDir,
      stripFrontmatter: props.stripFrontmatter,
      template: template.value,
      stylePath: template.value === 'custom' ? stylePath.value : undefined,
      targetPath: targetPath.value.trim(),
      overwrite: picked.value,
    })
    // 记住本次选择（下次导出沿用；设置页可改）—— 仅在变化时写配置，避免每次导出都保存+广播
    try {
      const ui = store.UI as any
      let changed = false
      if (ui.wordExportTemplate !== template.value) { ui.wordExportTemplate = template.value; changed = true }
      if (template.value === 'custom' && stylePath.value && ui.wordExportStylePath !== stylePath.value) {
        ui.wordExportStylePath = stylePath.value
        changed = true
      }
      if (changed) store.saveConfig()
    } catch { /* 忽略：配置持久化失败不影响导出 */ }
    emit('update:modelValue', false)
  } catch {
    // 失败提示已由导出管线给出，保留对话框便于改路径/样式重试
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="modelValue" class="wed-overlay" @click.self="close">
    <div class="wed-content">
      <div class="wed-header">
        <h3><i class="fa fa-file-word-o"></i> {{ zh ? '导出为 Word' : 'Export to Word' }}</h3>
        <button class="wed-close" @click="close" :title="zh ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
      </div>
      <div class="wed-body">
        <!-- 导出样式 -->
        <div class="wed-row">
          <label class="wed-label">{{ zh ? '导出样式' : 'Style' }}</label>
          <select v-model="template" class="wed-input">
            <option v-for="t in templates" :key="t.key" :value="t.key">{{ zh ? t.labelZh : t.labelEn }}</option>
          </select>
        </div>
        <div class="wed-row" v-if="template === 'custom'">
          <label class="wed-label">{{ zh ? '模板文件' : 'Template' }}</label>
          <div class="wed-inline">
            <input class="wed-input" readonly :value="stylePath" :title="stylePath"
                   :placeholder="zh ? '未选择（回退公文默认样式）' : 'None (fall back to official style)'" />
            <button class="wed-btn" @click="pickStyle" :title="zh ? '选择 .docx' : 'Pick .docx'">
              <i class="fa fa-folder-open"></i>
            </button>
          </div>
        </div>
        <!-- 保存位置 -->
        <div class="wed-row">
          <label class="wed-label">{{ zh ? '保存位置' : 'Save to' }}</label>
          <div class="wed-inline">
            <input class="wed-input" v-model="targetPath" @input="picked = false" :title="targetPath"
                   :placeholder="zh ? '文件名或完整路径' : 'File name or full path'" />
            <button class="wed-btn" @click="browse" :title="zh ? '另存为…' : 'Save as…'">
              <i class="fa fa-folder-open-o"></i>
            </button>
          </div>
        </div>
        <div class="wed-hint">{{ hint }}</div>
      </div>
      <div class="wed-footer">
        <button class="wed-btn" @click="close" :disabled="busy">{{ zh ? '取消' : 'Cancel' }}</button>
        <button class="wed-btn primary" @click="doExport" :disabled="busy || !markdown">
          <i class="fa" :class="busy ? 'fa-spinner fa-spin' : 'fa-download'"></i>
          {{ busy ? (zh ? '导出中…' : 'Exporting…') : (zh ? '导出' : 'Export') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wed-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}
.wed-content {
  background: var(--backgroundColor);
  color: var(--fontColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  width: 460px;
  max-width: 92vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
.wed-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--borderColor);
}
.wed-header h3 { margin: 0; font-size: 14px; font-weight: 500; }
.wed-close { background: none; border: none; color: var(--fontColor); cursor: pointer; font-size: 14px; }
.wed-body { padding: 10px; overflow-y: auto; }
.wed-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.wed-label { width: 68px; flex: none; font-size: 12px; opacity: 0.85; padding: 0px }
.wed-inline { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.wed-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  margin: 0px;
  font-size: 12px;
  color: var(--fontColor);
  background: var(--menuColor, var(--backgroundColor));
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  outline: none;
}
.wed-input:focus { border-color: #2196F3; }
.wed-btn {
  height: 28px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--fontColor);
  background: var(--menuColor, var(--backgroundColor));
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.wed-btn:hover:not(:disabled) { border-color: #2196F3; }
.wed-btn:disabled { opacity: 0.55; cursor: default; }
.wed-btn.primary { background: #2196F3; border-color: #2196F3; color: #fff; }
.wed-hint { font-size: 11px; opacity: 0.65; line-height: 1.6; word-break: break-all; }
.wed-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--borderColor);
}
</style>
