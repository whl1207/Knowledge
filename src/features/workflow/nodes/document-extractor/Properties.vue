<!-- src/features/workflow/nodes/document-extractor/Properties.vue -->
<!-- 文档提取器：选择一个内容为文件路径的变量，读取为文本 -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.extractor.variable') }}</div>
      <VariableSelector
        :model-value="selector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.extractor.selectVariable')"
        @update:model-value="set('variable_selector', $event)"
      />
      <div v-if="!hasSelector" class="wf-field__error">{{ t('panel.extractor.required') }}</div>
      <div class="wf-field__hint">{{ t('panel.extractor.hint') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/features/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)
const selector = computed<ValueSelector>(() => (Array.isArray(raw.value.variable_selector) ? raw.value.variable_selector : []))
const hasSelector = computed(() => selector.value.length >= 2)

function set(key: string, value: unknown): void {
  raw.value[key] = value
}
</script>
