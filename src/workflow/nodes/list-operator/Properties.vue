<!-- src/workflow/nodes/list-operator/Properties.vue -->
<!-- 列表操作：输入列表 / 过滤 / 排序 / 提取字段 / 截断 -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.list.input') }}</div>
      <VariableSelector
        :model-value="variableSelector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.list.selectInput')"
        @update:model-value="set('variable', $event)"
      />
      <div v-if="!hasVariable" class="wf-field__error">{{ t('panel.list.inputRequired') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.list.filter') }}</div>
    <div class="wf-inline" style="margin-bottom:6px">
      <el-switch :model-value="!!filterBy.enabled" size="small" @update:model-value="(v: string | number | boolean) => setFilterEnabled(!!v)" />
      <span class="wf-field__label">{{ t('panel.list.filterEnabled') }}</span>
    </div>
    <template v-if="filterBy.enabled">
      <el-select :model-value="filterBy.logical_operator ?? 'and'" size="small" style="width:100%;margin-bottom:6px" @update:model-value="setFilterLogical">
        <el-option :label="t('panel.ifElse.and')" value="and" />
        <el-option :label="t('panel.ifElse.or')" value="or" />
      </el-select>
      <ConditionList
        :data="data"
        :node-id="nodeId"
        :nodes="nodes"
        :edges="edges"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :conditions="filterConditions"
      />
      <div class="wf-field__hint">{{ t('panel.list.filterHint') }}</div>
    </template>

    <div class="wf-section-title">{{ t('panel.list.order') }}</div>
    <div class="wf-inline" style="margin-bottom:6px">
      <el-switch :model-value="!!orderBy.enabled" size="small" @update:model-value="(v: string | number | boolean) => setOrderEnabled(!!v)" />
      <span class="wf-field__label">{{ t('panel.list.orderEnabled') }}</span>
    </div>
    <template v-if="orderBy.enabled">
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="String(orderBy.value ?? '')" size="small" :placeholder="t('panel.list.fieldName')" @update:model-value="setOrderField" />
        <el-select :model-value="orderBy.order ?? 'asc'" size="small" style="width:100px;flex:0 0 100px" @update:model-value="setOrderDirection">
          <el-option :label="t('panel.list.asc')" value="asc" />
          <el-option :label="t('panel.list.desc')" value="desc" />
        </el-select>
      </div>
    </template>

    <div class="wf-section-title">{{ t('panel.list.extract') }}</div>
    <div class="wf-inline" style="margin-bottom:6px">
      <el-switch :model-value="!!extractBy.enabled" size="small" @update:model-value="(v: string | number | boolean) => setExtractEnabled(!!v)" />
      <span class="wf-field__label">{{ t('panel.list.extractEnabled') }}</span>
    </div>
    <el-input
      v-if="extractBy.enabled"
      :model-value="String(extractBy.value ?? '')"
      size="small"
      :placeholder="t('panel.list.fieldName')"
      @update:model-value="setExtractField"
    />

    <div class="wf-section-title">{{ t('panel.list.limit') }}</div>
    <div class="wf-inline" style="margin-bottom:6px">
      <el-switch :model-value="!!limit.enabled" size="small" @update:model-value="(v: string | number | boolean) => setLimitEnabled(!!v)" />
      <span class="wf-field__label">{{ t('panel.list.limitEnabled') }}</span>
    </div>
    <el-input-number
      v-if="limit.enabled"
      :model-value="Number(limit.size ?? 10)"
      size="small"
      :min="1"
      controls-position="right"
      style="width:100%"
      @update:model-value="(v: number | undefined) => setLimitSize(Number(v ?? 1))"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import ConditionList from '../ConditionList.vue'
import type { NodePanelProps } from '../panelProps'
import type { Condition } from '@/workflow/engine/conditions'
import type { ValueSelector } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)

const variableSelector = computed<ValueSelector>(() => (Array.isArray(raw.value.variable) ? raw.value.variable : []))
const hasVariable = computed(() => variableSelector.value.length >= 2)

const filterBy = computed<Record<string, any>>(() => ensureObject('filter_by'))
const orderBy = computed<Record<string, any>>(() => ensureObject('order_by'))
const extractBy = computed<Record<string, any>>(() => ensureObject('extract_by'))
const limit = computed<Record<string, any>>(() => ensureObject('limit'))

function ensureObject(key: string): Record<string, any> {
  if (!raw.value[key] || typeof raw.value[key] !== 'object') raw.value[key] = {}
  return raw.value[key]
}

const filterConditions = computed<Condition[]>(() => {
  if (!Array.isArray(filterBy.value.conditions)) filterBy.value.conditions = []
  return filterBy.value.conditions as Condition[]
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

function setFilterEnabled(value: boolean): void {
  filterBy.value.enabled = value
  if (!Array.isArray(filterBy.value.conditions)) filterBy.value.conditions = []
}
function setFilterLogical(value: string): void { filterBy.value.logical_operator = value }
function setOrderEnabled(value: boolean): void { orderBy.value.enabled = value }
function setOrderField(value: string): void { orderBy.value.value = value }
function setOrderDirection(value: string): void { orderBy.value.order = value }
function setExtractEnabled(value: boolean): void { extractBy.value.enabled = value }
function setExtractField(value: string): void { extractBy.value.value = value }
function setLimitEnabled(value: boolean): void { limit.value.enabled = value }
function setLimitSize(value: number): void { limit.value.size = value }
</script>
