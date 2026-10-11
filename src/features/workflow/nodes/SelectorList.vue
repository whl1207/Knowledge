<!-- src/features/workflow/nodes/SelectorList.vue -->
<!-- 变量绑定列表：变量名 + 变量选择器（代码 / 模板 / 聚合等节点共用），原地增删改 -->
<template>
  <div>
    <div v-for="(item, index) in items" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('selector.item') }} {{ index + 1 }}</span>
        <button class="wf-icon-btn" :title="t('panel.moveUp')" @click="move(index, -1)">↑</button>
        <button class="wf-icon-btn" :title="t('panel.moveDown')" @click="move(index, 1)">↓</button>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>

      <div v-if="showName" class="wf-field">
        <div class="wf-field__label">{{ t('selector.name') }}</div>
        <el-input
          :model-value="String(item.variable ?? '')"
          size="small"
          :placeholder="namePlaceholder || t('selector.namePlaceholder')"
          @update:model-value="item.variable = $event"
        />
      </div>

      <div class="wf-field" :style="showName ? '' : 'margin-bottom:0'">
        <div v-if="!showName" class="wf-field__label">{{ t('selector.variable') }}</div>
        <VariableSelector
          :model-value="item.value_selector"
          :nodes="nodes"
          :edges="edges"
          :current-node-id="nodeId"
          :environment-variables="environmentVariables"
          :conversation-variables="conversationVariables"
          :placeholder="t('selector.selectVariable')"
          @update:model-value="item.value_selector = $event"
        />
      </div>
    </div>

    <button class="wf-add-btn" @click="add">+ {{ addLabel || t('selector.add') }}</button>
    <div v-if="!items.length" class="wf-empty-hint">{{ emptyLabel || t('selector.empty') }}</div>
  </div>
</template>

<script setup lang="ts">
import { ElInput } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from './panelProps'

export interface SelectorRow {
  variable?: string
  value_selector?: string[]
}

const props = withDefaults(defineProps<NodePanelProps & {
  /** 绑定行数组（原地增删改） */
  items: SelectorRow[]
  /** 是否显示变量名（代码/模板需要，聚合器不需要） */
  showName?: boolean
  addLabel?: string
  emptyLabel?: string
  namePlaceholder?: string
}>(), {
  showName: true,
})

const store = usestore()
const t = createFlowT(store.locales || 'zh')

function add(): void {
  props.items.push(props.showName ? { variable: '', value_selector: [] } : { value_selector: [] })
}

function remove(index: number): void {
  props.items.splice(index, 1)
}

function move(index: number, delta: number): void {
  const target = index + delta
  if (target < 0 || target >= props.items.length) return
  const [item] = props.items.splice(index, 1)
  props.items.splice(target, 0, item)
}
</script>
