<!-- src/workflow/nodes/end/Properties.vue -->
<!-- 结束节点：声明工作流的最终输出（变量名 + 引用哪个上游输出） -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">
      {{ t('panel.end.hint') }}
    </div>

    <div v-for="(item, index) in outputs" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('panel.end.output') }} {{ index + 1 }}</span>
        <button class="wf-icon-btn" :title="t('panel.moveUp')" @click="move(index, -1)">↑</button>
        <button class="wf-icon-btn" :title="t('panel.moveDown')" @click="move(index, 1)">↓</button>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.end.name') }}</div>
        <el-input
          :model-value="item.variable"
          size="small"
          :placeholder="t('panel.end.namePlaceholder')"
          @update:model-value="item.variable = $event"
        />
        <div v-if="nameError(item, index)" class="wf-field__error">{{ nameError(item, index) }}</div>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.end.value') }}</div>
        <VariableSelector
          :model-value="item.value_selector"
          :nodes="nodes"
          :edges="edges"
          :current-node-id="nodeId"
          :environment-variables="environmentVariables"
          :conversation-variables="conversationVariables"
          :placeholder="t('panel.end.selectVariable')"
          @update:model-value="item.value_selector = $event"
        />
        <div v-if="isEmpty(item)" class="wf-field__error">{{ t('panel.end.valueRequired') }}</div>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.end.type') }}</div>
        <el-select
          :model-value="item.value_type"
          size="small"
          style="width:100%"
          @update:model-value="item.value_type = $event"
        >
          <el-option v-for="opt in VALUE_TYPES" :key="opt" :label="opt" :value="opt" />
        </el-select>
      </div>
    </div>

    <button class="wf-add-btn" @click="add">+ {{ t('panel.end.addOutput') }}</button>

    <div v-if="!outputs.length" class="wf-empty-hint">{{ t('panel.end.empty') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from '../panelProps'
import type { EndOutput, ValueSelector } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const VALUE_TYPES = ['string', 'number', 'object', 'array[string]', 'array[number]', 'array[object]', 'file'] as const

const outputs = computed<EndOutput[]>(() => {
  const data = props.data as unknown as Record<string, unknown>
  if (!Array.isArray(data.outputs)) data.outputs = []
  return data.outputs as EndOutput[]
})

function nameError(item: EndOutput, index: number): string {
  const name = String(item.variable || '').trim()
  if (!name) return t('panel.end.nameRequired')
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return t('panel.end.nameInvalid')
  const duplicated = outputs.value.some((other, i) => i !== index && other.variable === name)
  return duplicated ? t('panel.end.nameDuplicated') : ''
}

function isEmpty(item: EndOutput): boolean {
  return !Array.isArray(item.value_selector) || (item.value_selector as ValueSelector).length < 2
}

function add(): void {
  outputs.value.push({ variable: 'output', value_selector: [], value_type: 'string' })
}

function remove(index: number): void {
  outputs.value.splice(index, 1)
}

function move(index: number, delta: number): void {
  const target = index + delta
  if (target < 0 || target >= outputs.value.length) return
  const [item] = outputs.value.splice(index, 1)
  outputs.value.splice(target, 0, item)
}
</script>
