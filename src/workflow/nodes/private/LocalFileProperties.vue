<!-- src/workflow/nodes/private/LocalFileProperties.vue -->
<!-- 本地扩展：本地文件（完整文件 / 模板切片） -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.local.file') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="filePath" size="small" :placeholder="t('panel.local.filePlaceholder')" @update:model-value="set('file_path', $event)" />
        <button class="wf-btn" @click="pickFile">{{ t('panel.kb.browse') }}</button>
      </div>
      <div v-if="!filePath" class="wf-field__error">{{ t('panel.local.fileRequired') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.local.mode') }}</div>
      <el-radio-group :model-value="mode" size="small" @update:model-value="set('file_mode', $event)">
        <el-radio-button value="full">{{ t('panel.local.modeFull') }}</el-radio-button>
        <el-radio-button value="template">{{ t('panel.local.modeTemplate') }}</el-radio-button>
      </el-radio-group>
      <div class="wf-field__hint">{{ mode === 'full' ? t('panel.local.fullHint') : t('panel.local.templateHint') }}</div>
    </div>

    <template v-if="mode === 'template'">
      <div class="wf-section-title">{{ t('panel.local.templates') }}</div>
      <div v-for="(item, index) in templates" :key="index" class="wf-card">
        <div class="wf-card__head">
          <span class="wf-card__title">{{ t('panel.local.template') }} {{ index + 1 }}</span>
          <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="removeTemplate(index)">✕</button>
        </div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('panel.local.templateName') }}</div>
          <el-input v-model="item.name" size="small" :placeholder="t('panel.local.templateNamePlaceholder')" />
        </div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('panel.local.pattern') }}</div>
          <el-input v-model="item.pattern" size="small" :placeholder="t('panel.local.patternPlaceholder')" />
          <div class="wf-field__hint">{{ t('panel.local.patternHint') }}</div>
        </div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('panel.local.outputName') }}</div>
          <el-input v-model="item.output_name" size="small" :placeholder="t('panel.local.outputNamePlaceholder')" />
        </div>
      </div>
      <button class="wf-add-btn" @click="addTemplate">+ {{ t('panel.local.addTemplate') }}</button>
      <div v-if="!templates.length" class="wf-field__error">{{ t('panel.local.templatesRequired') }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElRadioButton, ElRadioGroup } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import type { NodePanelProps } from '../panelProps'
import type { FileTemplate } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)
const filePath = computed(() => String(raw.value.file_path ?? ''))
const mode = computed(() => String(raw.value.file_mode ?? 'full'))

const templates = computed<FileTemplate[]>(() => {
  if (!Array.isArray(raw.value.file_templates)) raw.value.file_templates = []
  return raw.value.file_templates as FileTemplate[]
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

function addTemplate(): void {
  const index = templates.value.length + 1
  templates.value.push({ name: `${t('panel.local.template')}${index}`, pattern: '', output_name: `output${index}` })
}

function removeTemplate(index: number): void {
  templates.value.splice(index, 1)
}

async function pickFile(): Promise<void> {
  const path = await window.ipcRenderer.invoke('selectFile', {
    filters: [{ name: '文本文件', extensions: ['md', 'txt', 'json', 'csv', 'docx'] }],
  })
  if (path) set('file_path', path)
}
</script>
