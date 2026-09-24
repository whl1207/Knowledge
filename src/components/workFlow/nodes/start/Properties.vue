<!-- nodes/start/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row">
      <label class="property-label">{{ t('start_input') }}</label>
      <div class="property-input">
        <textarea class="scoll" :value="node.prompt" @input="onUpdate('prompt', ($event.target as HTMLTextAreaElement).value)"
          :placeholder="t('start_placeholder')" rows="4"
          style="width:calc(100% - 12px);resize:vertical;font-size:12px;" />
      </div>
    </div>
    <div class="code-help">
      <small>{{ t('start_help_new') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NodeData } from '@/components/workFlow/WorkflowTypes'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
  upstream: any[]
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
}>()

const onUpdate = (key: string, value: any) => {
  emit('update', { [key]: value })
}
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
</style>

