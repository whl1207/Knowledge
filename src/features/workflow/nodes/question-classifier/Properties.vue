<!-- src/features/workflow/nodes/question-classifier/Properties.vue -->
<!-- 问题分类器：输入变量 + 模型 + 分类列表（分类 id 即分支端口） -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.classifier.query') }}</div>
      <VariableSelector
        :model-value="querySelector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.classifier.selectQuery')"
        @update:model-value="setQuery"
      />
      <div v-if="!hasQuery" class="wf-field__error">{{ t('panel.classifier.queryRequired') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.llm.provider') }}</div>
      <el-select
        :model-value="model.provider"
        size="small"
        style="width:100%"
        :placeholder="t('panel.llm.selectProvider')"
        @update:model-value="onProviderChange"
      >
        <el-option v-for="opt in providerOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
      <div v-if="!model.provider" class="wf-field__error">{{ t('panel.llm.providerRequired') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.llm.model') }}</div>
      <el-select
        :model-value="model.name"
        size="small"
        filterable
        allow-create
        default-first-option
        style="width:100%"
        :placeholder="t('panel.llm.selectModel')"
        @update:model-value="model.name = $event"
      >
        <el-option v-for="name in modelOptions" :key="name" :label="name" :value="name" />
      </el-select>
      <div v-if="!model.name" class="wf-field__error">{{ t('panel.llm.modelRequired') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.classifier.classes') }}</div>
    <div v-for="(item, index) in classes" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('panel.classifier.class') }} {{ index + 1 }}</span>
        <span class="wf-tag">{{ item.id }}</span>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="removeClass(index)">✕</button>
      </div>
      <el-input
        :model-value="item.label ?? item.name ?? ''"
        size="small"
        :placeholder="t('panel.classifier.classPlaceholder')"
        @update:model-value="item.label = $event"
      />
    </div>

    <button class="wf-add-btn" @click="addClass">+ {{ t('panel.classifier.addClass') }}</button>
    <div v-if="!classes.length" class="wf-field__error">{{ t('panel.classifier.classesRequired') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import { getAvailableModels, getModelOptions } from '@/features/workflow/engine/modelOptions'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/features/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const data = computed(() => props.data as unknown as Record<string, any>)

const querySelector = computed<ValueSelector>(() =>
  Array.isArray(data.value.query_variable_selector) ? data.value.query_variable_selector : [],
)
const hasQuery = computed(() => querySelector.value.length >= 2)

const model = computed<{ provider: string; name: string; mode?: string; completion_params: Record<string, any> }>(() => {
  if (!data.value.model || typeof data.value.model !== 'object') {
    data.value.model = { provider: '', name: '', mode: 'chat', completion_params: {} }
  }
  if (!data.value.model.completion_params || typeof data.value.model.completion_params !== 'object') {
    data.value.model.completion_params = {}
  }
  return data.value.model
})

const providerOptions = computed(() => getModelOptions(store, t))
const modelOptions = computed(() => (model.value.provider ? getAvailableModels(store, model.value.provider) : []))

/** 分类项直接编辑：data.classes 是响应式数组，面板只做增删改 */
const classes = computed<Array<{ id: string; name?: string; label?: string }>>(() => {
  if (!Array.isArray(data.value.classes)) data.value.classes = []
  return data.value.classes as Array<{ id: string; name?: string; label?: string }>
})

function setQuery(selector: ValueSelector): void {
  data.value.query_variable_selector = selector
}

function onProviderChange(provider: string): void {
  model.value.provider = provider
  const models = getAvailableModels(store, provider)
  if (!models.includes(model.value.name)) model.value.name = models[0] ?? ''
}

function addClass(): void {
  const nextId = String(classes.value.length + 1)
  classes.value.push({ id: nextId, label: `${t('panel.classifier.class')}${nextId}` })
}

function removeClass(index: number): void {
  classes.value.splice(index, 1)
}
</script>
