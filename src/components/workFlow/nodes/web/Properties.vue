<!-- nodes/web/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 搜索词 -->
    <div class="property-row">
      <label class="property-label">{{ t('search_term') }}</label>
      <div class="property-input">
        <input type="text" :value="node.prompt" @input="onUpdate('prompt', ($event.target as HTMLInputElement).value)"
          :placeholder="t('input_search')" />
      </div>
    </div>

    <div class="code-help">
      <small>{{ t('web_search_help') }}</small>
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

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
</style>
