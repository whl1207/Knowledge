<!-- src/features/workflow/nodes/template-transform/Properties.vue -->
<!-- 模板转换：模板正文 + 变量绑定（{{ 变量名 }} 占位符） -->
<template>
  <div>
    <div class="wf-section-title">{{ t('selector.title') }}</div>
    <SelectorList
      :data="data"
      :node-id="nodeId"
      :nodes="nodes"
      :edges="edges"
      :environment-variables="environmentVariables"
      :conversation-variables="conversationVariables"
      :items="variables"
      :add-label="t('panel.template.addVariable')"
      :empty-label="t('panel.template.noVariables')"
      name-placeholder="arg1"
    />

    <div class="wf-section-title">{{ t('panel.template.content') }}</div>
    <el-input
      :model-value="template"
      type="textarea"
      :rows="10"
      :placeholder="t('panel.template.placeholder')"
      class="wf-code"
      @update:model-value="set('template', $event)"
    />
    <div class="wf-field__hint">{{ t('panel.template.hint') }}</div>
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

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)
const template = computed(() => String(raw.value.template ?? ''))
const variables = computed<SelectorRow[]>(() => {
  if (!Array.isArray(raw.value.variables)) raw.value.variables = []
  return raw.value.variables as SelectorRow[]
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}
</script>

<style scoped>
.wf-code :deep(textarea) {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}
</style>
