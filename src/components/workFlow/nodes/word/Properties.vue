<!-- nodes/word/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row">
      <label class="property-label">{{ t('word_content') }}</label>
      <div class="property-input">
        <textarea :value="cfg.content" rows="3" :placeholder="t('word_content_placeholder')"
          @input="save({ content: ($event.target as HTMLTextAreaElement).value })"></textarea>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('word_template') }}</label>
      <div class="property-input">
        <select :value="cfg.template || ''" @change="save({ template: ($event.target as HTMLSelectElement).value })">
          <option value="">{{ t('word_template_follow') }}</option>
          <option v-for="p in templates" :key="p.key" :value="p.key">
            {{ locale === 'en' ? p.labelEn : p.labelZh }}
          </option>
        </select>
      </div>
    </div>
    <div class="property-row" v-if="(cfg.template || '') === 'custom'">
      <label class="property-label">{{ t('word_style_path') }}</label>
      <div class="property-input file-path-input">
        <input type="text" :value="cfg.stylePath" :placeholder="t('word_style_placeholder')"
          @input="save({ stylePath: ($event.target as HTMLInputElement).value })" />
        <button class="wf-btn small" :title="t('word_pick_style')" @click="pickStyle">
          <i class="fa fa-folder-open-o"></i>
        </button>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('word_dir') }}</label>
      <div class="property-input file-path-input">
        <input type="text" :value="cfg.dirPath" :placeholder="t('word_dir_placeholder')"
          @input="save({ dirPath: ($event.target as HTMLInputElement).value })" />
        <button class="wf-btn small" :title="t('word_pick_dir')" @click="pickDir">
          <i class="fa fa-folder-open-o"></i>
        </button>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('word_file_name') }}</label>
      <div class="property-input">
        <input type="text" :value="cfg.fileName" :placeholder="t('word_file_name_placeholder')"
          @input="save({ fileName: ($event.target as HTMLInputElement).value })" />
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('word_overwrite') }}</label>
      <div class="property-input">
        <input type="checkbox" :checked="cfg.overwrite === true"
          @change="save({ overwrite: ($event.target as HTMLInputElement).checked })" />
      </div>
    </div>
    <div class="code-help">{{ t('word_help') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usestore } from '@/store'
import type { NodeData, WordExportConfig } from '@/components/workFlow/WorkflowTypes'
import { WORD_EXPORT_TEMPLATES } from '@/lib/export/docx'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{ update: [data: Partial<NodeData>] }>()

const store = usestore()
const locale = computed(() => store.locales || 'zh')
// 模板选项复用导出模块的注册表（label 随界面语言），避免两处维护
const templates = WORD_EXPORT_TEMPLATES

const cfg = computed<WordExportConfig>(() => props.node.wordConfig || {})
const save = (patch: Partial<WordExportConfig>) =>
  emit('update', { wordConfig: { ...props.node.wordConfig, ...patch } })

/** 选择自定义模板样式 .docx（选中即切到 custom 模板） */
const pickStyle = async () => {
  try {
    const path = await window.ipcRenderer.invoke('selectFile', {
      filters: [
        { name: 'Word Document', extensions: ['docx'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (path) save({ stylePath: path, template: 'custom' })
  } catch { /* 用户取消或对话框异常 */ }
}

/** 选择保存目录 */
const pickDir = async () => {
  try {
    const path = await window.ipcRenderer.invoke('selectFile', { properties: ['openDirectory'] })
    if (path) save({ dirPath: path })
  } catch { /* 用户取消或对话框异常 */ }
}
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.file-path-input { display: flex; align-items: center; gap: 4px; }
.file-path-input input { flex: 1; min-width: 0; }
</style>
