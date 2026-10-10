<!-- src/workflow/nodes/private/WordProperties.vue -->
<!-- 本地扩展：导出 Word -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.word.source') }}</div>
      <VariableSelector
        :model-value="selector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.word.selectSource')"
        @update:model-value="set('content_variable_selector', $event)"
      />
      <div class="wf-field__hint">{{ t('panel.word.sourceHint') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.word.fallback') }}</div>
      <el-input
        :model-value="content"
        type="textarea"
        :rows="4"
        :placeholder="t('panel.word.fallbackPlaceholder')"
        @update:model-value="set('content', $event)"
      />
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.word.template') }}</div>
      <el-select :model-value="template" size="small" style="width:100%" @update:model-value="set('template', $event)">
        <el-option :label="t('panel.word.templateFollow')" value="" />
        <el-option :label="t('panel.word.templateGongwen')" value="gongwen" />
        <el-option :label="t('panel.word.templateCustom')" value="custom" />
      </el-select>
    </div>

    <div v-if="template === 'custom'" class="wf-field">
      <div class="wf-field__label">{{ t('panel.word.stylePath') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="stylePath" size="small" :placeholder="t('panel.word.stylePathPlaceholder')" @update:model-value="set('style_path', $event)" />
        <button class="wf-btn" @click="pickStyle">{{ t('panel.kb.browse') }}</button>
      </div>
    </div>

    <div class="wf-section-title">{{ t('panel.word.output') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.word.dir') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="dirPath" size="small" :placeholder="t('panel.word.dirPlaceholder')" @update:model-value="set('dir_path', $event)" />
        <button class="wf-btn" @click="pickDir">{{ t('panel.kb.browse') }}</button>
      </div>
      <div class="wf-field__hint">{{ t('panel.word.dirHint') }}</div>
    </div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.word.fileName') }}</div>
      <el-input :model-value="fileName" size="small" :placeholder="t('panel.word.fileNamePlaceholder')" @update:model-value="set('file_name', $event)" />
    </div>
    <div class="wf-inline">
      <el-switch :model-value="!!overwrite" size="small" @update:model-value="(v: string | number | boolean) => set('overwrite', !!v)" />
      <span class="wf-field__label">{{ t('panel.word.overwrite') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)
const selector = computed<ValueSelector>(() => (Array.isArray(raw.value.content_variable_selector) ? raw.value.content_variable_selector : []))
const content = computed(() => String(raw.value.content ?? ''))
const template = computed(() => String(raw.value.template ?? ''))
const stylePath = computed(() => String(raw.value.style_path ?? ''))
const dirPath = computed(() => String(raw.value.dir_path ?? ''))
const fileName = computed(() => String(raw.value.file_name ?? ''))
const overwrite = computed(() => raw.value.overwrite)

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

async function pickStyle(): Promise<void> {
  const path = await window.ipcRenderer.invoke('selectFile', { filters: [{ name: 'Word 模板', extensions: ['docx'] }] })
  if (path) set('style_path', path)
}

async function pickDir(): Promise<void> {
  const path = await window.ipcRenderer.invoke('selectFile', { properties: ['openDirectory'] })
  if (path) set('dir_path', path)
}
</script>
