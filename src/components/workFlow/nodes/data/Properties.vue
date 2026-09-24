<!-- nodes/data/Properties.vue -->
<template>
  <div class="property-group">
    <div class="property-row">
      <label class="property-label">{{ t('data_file_path') }}</label>
      <div class="property-input file-path-input">
        <input type="text" :value="cfg.filePath || node.prompt" @input="onPath($event.target as HTMLInputElement)" :placeholder="'D:\\data\\test.csv'" />
        <button class="wf-btn small" :title="t('data_browse')" @click="pickFile">
          <i class="fa fa-folder-open-o"></i>
        </button>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('data_load_mode') }}</label>
      <div class="property-input">
        <select :value="cfg.loadMode || 'auto'" @change="save({ loadMode: ($event.target as HTMLSelectElement).value as any })">
          <option value="auto">{{ t('data_mode_auto') }}</option>
          <option value="stats">{{ t('data_mode_stats') }}</option>
          <option value="preview">{{ t('data_mode_preview') }}</option>
          <option value="full">{{ t('data_mode_full') }}</option>
        </select>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('data_delimiter') }}</label>
      <div class="property-input">
        <select :value="cfg.delimiter || ','" @change="save({ delimiter: ($event.target as HTMLSelectElement).value })">
          <option value=",">逗号 ,</option>
          <option value="\t">制表符 Tab</option>
          <option value=";">分号 ;</option>
        </select>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('data_has_header') }}</label>
      <div class="property-input">
        <input type="checkbox" :checked="cfg.hasHeader !== false" @change="save({ hasHeader: ($event.target as HTMLInputElement).checked })" />
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('data_max_rows') }}</label>
      <div class="property-input">
        <input type="number" min="0" :value="cfg.maxRows" @input="save({ maxRows: Number(($event.target as HTMLInputElement).value) || 0 })" />
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('data_batch_size') }}</label>
      <div class="property-input">
        <input type="number" min="0" :value="cfg.batchSize" @input="save({ batchSize: Number(($event.target as HTMLInputElement).value) || 0 })" />
      </div>
    </div>
    <div class="property-row" v-if="(cfg.loadMode || 'auto') !== 'full'">
      <label class="property-label">{{ t('data_preview_rows') }}</label>
      <div class="property-input">
        <input type="number" min="1" :value="cfg.previewRows" @input="save({ previewRows: Number(($event.target as HTMLInputElement).value) || 100 })" />
      </div>
    </div>
    <div class="code-help">{{ t('data_help') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData } from '@/components/workFlow/WorkflowTypes'
import type { DataConfig } from '@/components/workFlow/WorkflowTypes'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{ update: [data: Partial<NodeData>] }>()

const cfg = computed<DataConfig>(() => props.node.dataConfig || {})
const save = (patch: Partial<DataConfig>) => emit('update', { dataConfig: { ...props.node.dataConfig, ...patch } })

const onPath = (el: HTMLInputElement) => {
  const value = el.value
  // 同时写入 prompt（兼容旧读取逻辑）与 dataConfig.filePath
  emit('update', { prompt: value, dataConfig: { ...props.node.dataConfig, filePath: value } })
}

const pickFile = async () => {
  try {
    const path = await window.ipcRenderer.invoke('selectFile', {
      filters: [
        { name: 'Data Files', extensions: ['csv', 'tsv', 'txt', 'json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (path) {
      emit('update', { prompt: path, dataConfig: { ...props.node.dataConfig, filePath: path } })
    }
  } catch { /* 用户取消或对话框异常 */ }
}
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.file-path-input { display: flex; align-items: center; gap: 4px; }
.file-path-input input { flex: 1; min-width: 0; }
</style>
