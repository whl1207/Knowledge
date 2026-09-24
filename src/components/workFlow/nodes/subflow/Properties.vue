<!-- nodes/subflow/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row">
      <label class="property-label">{{ t('subflow_file') }}</label>
      <div class="property-input" style="display:flex;gap:5px;">
        <input type="text" :value="node.subflowPath || ''" readonly
          :placeholder="t('drop_flow_file')" style="flex:1;font-size:10px;" />
        <button class="wf-btn small" @click="onSelectFile">
          <i class="fa fa-folder-open"></i>
        </button>
      </div>
    </div>
    <div v-if="node.subflowPath" class="property-row">
      <label class="property-label">{{ t('flow_name') }}</label>
      <div class="property-input">
        <span style="font-size:10px;color:var(--fontColor);opacity:0.7;">
          {{ node.subflowName || node.subflowPath.split(/[\\/]/).pop() }}
        </span>
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

const onSelectFile = async (): Promise<void> => {
  try {
    const result = await window.ipcRenderer.invoke('openFile')
    if (result?.content) {
      const fileName = result.filePath?.split(/[\\/]/).pop() || 'unknown.flow'
      emit('update', { subflowPath: result.filePath, subflowName: fileName.replace(/\.\w+$/, ''), prompt: result.filePath })
    }
  } catch {}
}
</script>

