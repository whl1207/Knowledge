<!-- nodes/end/Properties.vue -->
<template>
  <div class="property-group">
    <div class="code-help">
      <small>{{ t('end_help') }}</small>
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
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
</style>

