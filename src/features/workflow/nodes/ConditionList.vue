<!-- src/features/workflow/nodes/ConditionList.vue -->
<!-- 条件列表编辑器（if-else 的 case 与循环结束条件共用）：直接原地修改传入的数组 -->
<template>
  <div>
    <div v-for="(item, index) in conditions" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('cond.item') }} {{ index + 1 }}</span>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('cond.variable') }}</div>
        <VariableSelector
          :model-value="item.variable_selector"
          :nodes="nodes"
          :edges="edges"
          :current-node-id="nodeId"
          :environment-variables="environmentVariables"
          :conversation-variables="conversationVariables"
          :placeholder="t('cond.selectVariable')"
          @update:model-value="item.variable_selector = $event"
        />
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('cond.operator') }}</div>
        <el-select
          :model-value="item.comparison_operator ?? 'is'"
          size="small"
          style="width:100%"
          @update:model-value="item.comparison_operator = $event"
        >
          <el-option v-for="opt in COMPARISON_OPERATORS" :key="opt.value" :label="t(opt.labelKey)" :value="opt.value" />
        </el-select>
      </div>

      <div v-if="needsValue(item.comparison_operator)" class="wf-field">
        <div class="wf-field__label">{{ t('cond.value') }}</div>
        <el-input
          :model-value="item.value === undefined || item.value === null ? '' : String(item.value)"
          size="small"
          :placeholder="t('cond.valuePlaceholder')"
          @update:model-value="item.value = $event"
        />
      </div>
    </div>

    <button class="wf-add-btn" @click="add">+ {{ t('cond.addCondition') }}</button>
    <div v-if="!conditions.length" class="wf-empty-hint">{{ t('cond.empty') }}</div>
  </div>
</template>

<script setup lang="ts">
import { ElInput, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import type { Condition } from '@/features/workflow/engine/conditions'
import { COMPARISON_OPERATORS, createConditionId, needsValue } from './conditionOps'
import type { NodePanelProps } from './panelProps'

const props = defineProps<NodePanelProps & {
  /** 条件数组（原地增删改） */
  conditions: Condition[]
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

function add(): void {
  props.conditions.push({
    id: createConditionId(props.conditions),
    comparison_operator: 'is',
    variable_selector: [],
    value: '',
    varType: 'string',
  })
}

function remove(index: number): void {
  props.conditions.splice(index, 1)
}
</script>
