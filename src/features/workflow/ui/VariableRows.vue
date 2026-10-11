<!-- src/features/workflow/ui/VariableRows.vue -->
<!-- 全局变量行编辑器（环境变量 / 会话变量），原地增删改传入数组 -->
<template>
  <div>
    <div v-for="(row, index) in rows" :key="row.id ?? index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ row.name || t('app.unnamedVar') }}</span>
        <span class="wf-tag">{{ row.value_type }}</span>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('app.varName') }}</div>
        <el-input :model-value="row.name" size="small" placeholder="SECRET" @update:model-value="row.name = $event" />
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('app.varType') }}</div>
        <el-select :model-value="row.value_type" size="small" style="width:100%" @update:model-value="row.value_type = $event as any">
          <el-option v-for="type in TYPES" :key="type" :label="type" :value="type" />
        </el-select>
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('app.varValue') }}</div>
        <el-input
          :model-value="String(row.value ?? '')"
          size="small"
          :placeholder="t('app.varValuePlaceholder')"
          @update:model-value="row.value = $event"
        />
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('app.varDescription') }}</div>
        <el-input :model-value="row.description ?? ''" size="small" @update:model-value="row.description = $event" />
      </div>
    </div>
    <button class="wf-add-btn" @click="add">+ {{ addLabel }}</button>
    <div v-if="!rows.length" class="wf-empty-hint">{{ t('app.noVars') }}</div>
  </div>
</template>

<script setup lang="ts">
import { ElInput, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from './locales'

/** 兼容环境变量与会话变量的最小结构 */
interface VariableRow {
  id?: string
  name: string
  value_type: string
  value: unknown
  description?: string
}

const props = defineProps<{
  rows: VariableRow[]
  addLabel: string
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const TYPES = ['string', 'number', 'boolean', 'object', 'secret']

/** 新增变量时生成稳定 id（Dify 用 uuid） */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `var_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

function add(): void {
  props.rows.push({ id: newId(), name: '', value_type: 'string', value: '', description: '' })
}

function remove(index: number): void {
  props.rows.splice(index, 1)
}
</script>
