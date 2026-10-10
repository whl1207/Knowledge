<!-- src/workflow/nodes/assigner/Properties.vue -->
<!-- 变量赋值：把上游变量或常量写入会话变量 / 容器循环变量（Dify assigner 与旧别名 variable-assigner 共用） -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">{{ t('panel.assigner.hint') }}</div>

    <div v-for="(item, index) in items" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('selector.item') }} {{ index + 1 }}</span>
        <button class="wf-icon-btn" :title="t('panel.moveUp')" @click="move(index, -1)">↑</button>
        <button class="wf-icon-btn" :title="t('panel.moveDown')" @click="move(index, 1)">↓</button>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.assigner.target') }}</div>
        <VariableSelector
          :model-value="item.variable_selector"
          :nodes="nodes"
          :edges="edges"
          :current-node-id="nodeId"
          :environment-variables="environmentVariables"
          :conversation-variables="conversationVariables"
          :placeholder="t('panel.assigner.targetPlaceholder')"
          @update:model-value="item.variable_selector = $event"
        />
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.assigner.mode') }}</div>
        <el-select
          :model-value="modeOf(item)"
          size="small"
          style="width:100%"
          @update:model-value="item.operation = $event"
        >
          <el-option :label="t('panel.assigner.modeOverwrite')" value="over-write" />
          <el-option :label="t('panel.assigner.modeAppend')" value="append" />
          <el-option :label="t('panel.assigner.modeClear')" value="clear" />
        </el-select>
      </div>

      <template v-if="modeOf(item) !== 'clear'">
        <div class="wf-field">
          <div class="wf-field__label">{{ t('panel.assigner.source') }}</div>
          <el-radio-group
            :model-value="inputTypeOf(item)"
            size="small"
            @update:model-value="item.input_type = $event as 'variable' | 'constant'"
          >
            <el-radio-button value="variable">{{ t('panel.assigner.sourceVariable') }}</el-radio-button>
            <el-radio-button value="constant">{{ t('panel.assigner.sourceConstant') }}</el-radio-button>
          </el-radio-group>
        </div>

        <div class="wf-field" style="margin-bottom:0">
          <div class="wf-field__label">{{ t('panel.assigner.value') }}</div>
          <VariableSelector
            v-if="inputTypeOf(item) === 'variable'"
            :model-value="variableValueOf(item)"
            :nodes="nodes"
            :edges="edges"
            :current-node-id="nodeId"
            :environment-variables="environmentVariables"
            :conversation-variables="conversationVariables"
            :placeholder="t('selector.selectVariable')"
            @update:model-value="item.value = $event"
          />
          <el-input
            v-else
            :model-value="constantValueOf(item)"
            size="small"
            :placeholder="t('panel.assigner.valuePlaceholder')"
            @update:model-value="item.value = $event"
          />
        </div>
      </template>
    </div>

    <button class="wf-add-btn" @click="add">+ {{ t('panel.assigner.add') }}</button>
    <div v-if="!items.length" class="wf-empty-hint">{{ t('panel.assigner.empty') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElOption, ElRadioButton, ElRadioGroup, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from '../panelProps'

/** Dify assigner 的赋值项：目标变量 + 写入方式 +（变量引用 | 常量） */
interface AssignerItem {
  input_type?: 'variable' | 'constant'
  operation?: string
  variable_selector?: string[]
  value?: unknown
}

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const items = computed<AssignerItem[]>(() => {
  const raw = props.data as unknown as Record<string, any>
  if (!Array.isArray(raw.items)) raw.items = []
  return raw.items as AssignerItem[]
})

const modeOf = (item: AssignerItem): string => item.operation || 'over-write'
const inputTypeOf = (item: AssignerItem): 'variable' | 'constant' =>
  item.input_type === 'constant' ? 'constant' : 'variable'
/** 变量型赋值：Dify 用 value 承载变量引用（数组形式） */
const variableValueOf = (item: AssignerItem): string[] => (Array.isArray(item.value) ? (item.value as string[]) : [])
const constantValueOf = (item: AssignerItem): string => (item.value == null ? '' : String(item.value))

function add(): void {
  items.value.push({ input_type: 'variable', operation: 'over-write', variable_selector: [], value: [] })
}

function remove(index: number): void {
  items.value.splice(index, 1)
}

function move(index: number, delta: number): void {
  const target = index + delta
  if (target < 0 || target >= items.value.length) return
  const [item] = items.value.splice(index, 1)
  items.value.splice(target, 0, item)
}
</script>
