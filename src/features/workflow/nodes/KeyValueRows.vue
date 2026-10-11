<!-- src/features/workflow/nodes/KeyValueRows.vue -->
<!-- 键值行编辑器（请求头 / 查询参数 / 请求体字段共用），原地增删改传入数组 -->
<template>
  <div>
    <div v-for="(row, index) in rows" :key="index" class="wf-inline" style="margin-bottom:4px">
      <el-input :model-value="String(row.key ?? '')" size="small" :placeholder="keyPlaceholder" @update:model-value="row.key = $event" />
      <el-input :model-value="String(row.value ?? '')" size="small" :placeholder="valuePlaceholder" @update:model-value="row.value = $event" />
      <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
    </div>
    <button class="wf-add-btn" @click="add">+ {{ addLabel }}</button>
  </div>
</template>

<script setup lang="ts">
import { ElInput } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'

export interface KeyValueRow {
  key?: string
  value?: string
}

const props = defineProps<{
  rows: KeyValueRow[]
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel: string
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

function add(): void {
  props.rows.push({ key: '', value: '' })
}

function remove(index: number): void {
  props.rows.splice(index, 1)
}
</script>
