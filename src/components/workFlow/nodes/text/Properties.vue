<!-- nodes/text/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row">
      <label class="property-label">{{ t('text_content') }}</label>
      <div class="property-input">
        <textarea :value="node.prompt" @input="onUpdate('prompt', ($event.target as HTMLTextAreaElement).value)"
          :placeholder="t('input_text')" rows="4"
          style="width:calc(100% - 12px);resize:vertical;font-size:12px;" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NodeData } from '@/components/workFlow/WorkflowTypes'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
}>()

const onUpdate = (key: string, value: any) => emit('update', { [key]: value })
</script>

