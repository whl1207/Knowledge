<!-- src/features/workflow/nodes/if-else/Properties.vue -->
<!-- 条件分支：每个 case 一组条件（AND/OR），全部不命中走 ELSE -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">{{ t('panel.ifElse.hint') }}</div>

    <div v-for="(item, index) in cases" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('panel.ifElse.case') }} {{ index + 1 }}</span>
        <span class="wf-tag">IF{{ index + 1 }}</span>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="removeCase(index)">✕</button>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.ifElse.logical') }}</div>
        <el-select
          :model-value="item.logical_operator ?? 'and'"
          size="small"
          style="width:100%"
          @update:model-value="item.logical_operator = $event"
        >
          <el-option :label="t('panel.ifElse.and')" value="and" />
          <el-option :label="t('panel.ifElse.or')" value="or" />
        </el-select>
      </div>

      <ConditionList
        :data="data"
        :node-id="nodeId"
        :nodes="nodes"
        :edges="edges"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :conditions="conditionsOf(item, index)"
      />
    </div>

    <button class="wf-add-btn" @click="addCase">+ {{ t('panel.ifElse.addCase') }}</button>

    <div class="wf-section-title">ELSE</div>
    <div class="wf-field__hint">{{ t('panel.ifElse.elseHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import ConditionList from '../ConditionList.vue'
import type { NodePanelProps } from '../panelProps'
import type { Condition, ConditionCase } from '@/features/workflow/engine/conditions'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const cases = computed<ConditionCase[]>(() => {
  const data = props.data as unknown as Record<string, unknown>
  if (!Array.isArray(data.cases)) data.cases = [{ case_id: 'true', logical_operator: 'and', conditions: [] }]
  return data.cases as ConditionCase[]
})

/** 保证 case 有唯一 case_id（它就是边的 sourceHandle）与 conditions 数组 */
function conditionsOf(item: ConditionCase, index: number): Condition[] {
  if (!item.case_id) item.case_id = index === 0 ? 'true' : `case_${index + 1}`
  if (!Array.isArray(item.conditions)) item.conditions = []
  return item.conditions as Condition[]
}

function addCase(): void {
  const index = cases.value.length
  cases.value.push({
    case_id: index === 0 ? 'true' : `case_${index + 1}`,
    logical_operator: 'and',
    conditions: [],
  })
}

function removeCase(index: number): void {
  cases.value.splice(index, 1)
}
</script>
