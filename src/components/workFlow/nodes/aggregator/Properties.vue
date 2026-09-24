<!-- nodes/aggregator/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row">
      <label class="property-label">{{ t('aggregator_mode') }}</label>
      <div class="property-input">
        <select :value="cfg.mode" @change="save({ mode: ($event.target as HTMLSelectElement).value as 'collect' | 'merge' })">
          <option value="collect">{{ t('aggregator_mode_collect') }}</option>
          <option value="merge">{{ t('aggregator_mode_merge') }}</option>
        </select>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('aggregator_input_var') }}</label>
      <div class="property-input">
        <input type="text" :value="cfg.inputVar" @input="save({ inputVar: ($event.target as HTMLInputElement).value })"
          :placeholder="`{{${t('iteration_node')}.output}}`" />
      </div>
    </div>
    <div class="code-help">{{ t('aggregator_help') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData } from '@/components/workFlow/WorkflowTypes'
import type { AggregatorConfig } from '@/components/workFlow/WorkflowTypes'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{ update: [data: Partial<NodeData>] }>()

const cfg = computed<AggregatorConfig>(() => props.node.aggregatorConfig || {})
const save = (patch: Partial<AggregatorConfig>) => emit('update', { aggregatorConfig: { ...props.node.aggregatorConfig, ...patch } })
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
</style>
