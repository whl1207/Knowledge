<!-- src/workflow/nodes/private/CsvProperties.vue -->
<!-- 本地扩展：本地数据表（CSV / TSV / Excel） -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.csv.file') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="filePath" size="small" :placeholder="t('panel.csv.filePlaceholder')" @update:model-value="set('file_path', $event)" />
        <button class="wf-btn" @click="pickFile">{{ t('panel.kb.browse') }}</button>
      </div>
      <div v-if="!filePath" class="wf-field__error">{{ t('panel.csv.fileRequired') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.csv.loadMode') }}</div>
      <el-select :model-value="loadMode" size="small" style="width:100%" @update:model-value="set('load_mode', $event)">
        <el-option v-for="mode in LOAD_MODES" :key="mode" :label="t('csvMode.' + mode)" :value="mode" />
      </el-select>
      <div class="wf-field__hint">{{ t('panel.csv.loadModeHint') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.csv.delimiter') }}</div>
      <el-input :model-value="delimiter" size="small" style="width:100px" @update:model-value="set('delimiter', $event)" />
      <div class="wf-field__hint">{{ t('panel.csv.delimiterHint') }}</div>
    </div>

    <div class="wf-inline" style="margin-bottom:10px">
      <el-switch :model-value="hasHeader" size="small" @update:model-value="(v: string | number | boolean) => set('has_header', !!v)" />
      <span class="wf-field__label">{{ t('panel.csv.hasHeader') }}</span>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.csv.previewRows') }}</div>
      <el-input-number
        :model-value="previewRows"
        size="small"
        :min="1"
        :max="500"
        controls-position="right"
        style="width:100%"
        @update:model-value="(v: number | undefined) => set('preview_rows', Number(v ?? 20))"
      />
    </div>

    <template v-if="loadMode === 'auto' || loadMode === 'full'">
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.csv.maxRows') }}</div>
        <el-input-number
          :model-value="maxRows"
          size="small"
          :min="0"
          :step="100"
          controls-position="right"
          style="width:100%"
          @update:model-value="(v: number | undefined) => set('max_rows', Number(v ?? 0))"
        />
        <div class="wf-field__hint">{{ t('panel.csv.maxRowsHint') }}</div>
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.csv.batchSize') }}</div>
        <el-input-number
          :model-value="batchSize"
          size="small"
          :min="0"
          :step="50"
          controls-position="right"
          style="width:100%"
          @update:model-value="(v: number | undefined) => set('batch_size', Number(v ?? 0))"
        />
        <div class="wf-field__hint">{{ t('panel.csv.batchSizeHint') }}</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import type { NodePanelProps } from '../panelProps'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const LOAD_MODES = ['auto', 'preview', 'stats', 'full'] as const

const raw = computed(() => props.data as unknown as Record<string, any>)
const filePath = computed(() => String(raw.value.file_path ?? ''))
const loadMode = computed(() => String(raw.value.load_mode ?? 'preview'))
const delimiter = computed(() => String(raw.value.delimiter ?? ','))
const hasHeader = computed(() => raw.value.has_header !== false)
const previewRows = computed(() => Number(raw.value.preview_rows ?? 20))
const maxRows = computed(() => Number(raw.value.max_rows ?? 0))
const batchSize = computed(() => Number(raw.value.batch_size ?? 0))

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

async function pickFile(): Promise<void> {
  const path = await window.ipcRenderer.invoke('selectFile', {
    filters: [{ name: '数据表', extensions: ['csv', 'tsv', 'xlsx', 'xls', 'txt'] }],
  })
  if (path) set('file_path', path)
}
</script>
