<!-- src/features/workflow/nodes/private/SubflowProperties.vue -->
<!-- 本地扩展：子工作流（调用另一个 .flow.yml，入参/出参按变量名映射） -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.subflow.file') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="subflowPath" size="small" :placeholder="t('panel.subflow.filePlaceholder')" @update:model-value="set('subflow_path', $event)" />
        <button class="wf-btn" @click="pickFile">{{ t('panel.kb.browse') }}</button>
      </div>
      <div v-if="!subflowPath" class="wf-field__error">{{ t('panel.subflow.required') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.subflow.inputs') }}</div>
    <div class="wf-field__hint" style="margin-bottom:8px">{{ t('panel.subflow.inputsHint') }}</div>
    <SelectorList
      :data="data"
      :node-id="nodeId"
      :nodes="nodes"
      :edges="edges"
      :environment-variables="environmentVariables"
      :conversation-variables="conversationVariables"
      :items="variables"
      :add-label="t('panel.subflow.addInput')"
      :empty-label="t('panel.subflow.noInputs')"
      name-placeholder="question"
    />

    <div class="wf-section-title">{{ t('panel.subflow.outputs') }}</div>
    <div class="wf-field__hint">{{ t('panel.subflow.outputsHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import SelectorList from '../SelectorList.vue'
import type { SelectorRow } from '../SelectorList.vue'
import type { NodePanelProps } from '../panelProps'
import { getPlatform, hasCapability } from '@/platform'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)
const subflowPath = computed(() => String(raw.value.subflow_path ?? ''))
const variables = computed<SelectorRow[]>(() => {
  if (!Array.isArray(raw.value.variables)) raw.value.variables = []
  return raw.value.variables as SelectorRow[]
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

async function pickFile(): Promise<void> {
  const path = await getPlatform().dialog.pickFile({
    filters: [{ name: '工作流', extensions: ['yml', 'yaml'] }],
  })
  if (!path) return
  set('subflow_path', path)
  set('subflow_name', String(path).split(/[\\/]/).pop() || '')
}
</script>
