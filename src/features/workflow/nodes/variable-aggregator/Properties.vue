<!-- src/features/workflow/nodes/variable-aggregator/Properties.vue -->
<!-- 变量聚合器：按顺序取第一个有值的变量 -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">{{ t('panel.aggregator.hint') }}</div>
    <SelectorList
      :data="data"
      :node-id="nodeId"
      :nodes="nodes"
      :edges="edges"
      :environment-variables="environmentVariables"
      :conversation-variables="conversationVariables"
      :items="variables"
      :show-name="false"
      :add-label="t('panel.aggregator.add')"
      :empty-label="t('panel.aggregator.empty')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import SelectorList from '../SelectorList.vue'
import type { SelectorRow } from '../SelectorList.vue'
import type { NodePanelProps } from '../panelProps'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const variables = computed<SelectorRow[]>(() => {
  const raw = props.data as unknown as Record<string, any>
  if (!Array.isArray(raw.variables)) raw.variables = []
  return raw.variables as SelectorRow[]
})
</script>
