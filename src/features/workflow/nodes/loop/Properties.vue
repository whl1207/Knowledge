<!-- src/features/workflow/nodes/loop/Properties.vue -->
<!-- 循环容器：最大轮数 / 循环变量 / 结束条件 / 错误模式 -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">{{ t('panel.loop.hint') }}</div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.loop.count') }}</div>
      <el-input-number
        :model-value="Number(raw.loop_count ?? 10)"
        size="small"
        :min="1"
        :max="200"
        controls-position="right"
        style="width:100%"
        @update:model-value="set('loop_count', $event)"
      />
      <div class="wf-field__hint">{{ t('panel.loop.countHint') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.loop.variables') }}</div>
    <div class="wf-field__hint" style="margin-bottom:8px">{{ t('panel.loop.variablesHint') }}</div>
    <div v-for="(item, index) in variables" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('panel.loop.variable') }} {{ index + 1 }}</span>
        <span class="wf-tag">{{ item.id || t('panel.loop.unnamed') }}</span>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="removeVariable(index)">✕</button>
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.start.name') }}</div>
        <el-input v-model="item.id" size="small" :placeholder="t('panel.loop.variableNamePlaceholder')" />
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.loop.initial') }}</div>
        <el-input
          :model-value="item.value === undefined || item.value === null ? '' : String(item.value)"
          size="small"
          @update:model-value="item.value = $event"
        />
      </div>
    </div>
    <button class="wf-add-btn" @click="addVariable">+ {{ t('panel.loop.addVariable') }}</button>

    <div class="wf-section-title">{{ t('panel.loop.breaks') }}</div>
    <div class="wf-field__hint" style="margin-bottom:8px">{{ t('panel.loop.breaksHint') }}</div>
    <ConditionList
      :data="data"
      :node-id="nodeId"
      :nodes="nodes"
      :edges="edges"
      :environment-variables="environmentVariables"
      :conversation-variables="conversationVariables"
      :conditions="breakConditions"
    />

    <div class="wf-field" style="margin-top:10px">
      <div class="wf-field__label">{{ t('panel.iteration.errorMode') }}</div>
      <el-select
        :model-value="errorMode"
        size="small"
        style="width:100%"
        @update:model-value="set('error_handle_mode', $event)"
      >
        <el-option v-for="mode in ERROR_MODES" :key="mode" :label="t('iterationMode.' + mode)" :value="mode" />
      </el-select>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import ConditionList from '../ConditionList.vue'
import type { NodePanelProps } from '../panelProps'
import type { Condition } from '@/features/workflow/engine/conditions'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const ERROR_MODES = ['terminated', 'continue_with_error', 'remove_abnormal_output'] as const

interface LoopVariable {
  id?: string
  label?: string
  value?: unknown
  value_type?: string
}

const raw = computed(() => props.data as unknown as Record<string, any>)
const errorMode = computed(() => String(raw.value.error_handle_mode ?? 'terminated'))

const variables = computed<LoopVariable[]>(() => {
  if (!Array.isArray(raw.value.loop_variables)) raw.value.loop_variables = []
  return raw.value.loop_variables as LoopVariable[]
})

/** 结束条件：第一组条件的 conditions 数组（Dify 里是数组套条件） */
const breakConditions = computed<Condition[]>(() => {
  if (!Array.isArray(raw.value.break_conditions)) raw.value.break_conditions = []
  const list = raw.value.break_conditions as Array<{ case_id?: string; conditions?: Condition[] }>
  if (!list.length) list.push({ case_id: 'break', conditions: [] })
  const first = list[0]
  if (!Array.isArray(first.conditions)) first.conditions = []
  // ConditionList 直接改这个数组，改动自然落到 break_conditions[0].conditions
  return first.conditions
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

function addVariable(): void {
  variables.value.push({ id: '', label: '', value: '', value_type: 'string' })
}

function removeVariable(index: number): void {
  variables.value.splice(index, 1)
}
</script>
