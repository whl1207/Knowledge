<!-- src/workflow/nodes/parameter-extractor/Properties.vue -->
<!-- 参数提取器：输入变量 + 模型 + 参数定义 -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.extract.query') }}</div>
      <VariableSelector
        :model-value="querySelector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.extract.selectQuery')"
        @update:model-value="set('query', $event)"
      />
      <div v-if="!hasQuery" class="wf-field__error">{{ t('panel.extract.queryRequired') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.llm.provider') }}</div>
      <el-select :model-value="model.provider" size="small" style="width:100%" @update:model-value="onProviderChange">
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
        @update:model-value="model.name = $event"
      >
        <el-option v-for="name in modelOptions" :key="name" :label="name" :value="name" />
      </el-select>
      <div v-if="!model.name" class="wf-field__error">{{ t('panel.llm.modelRequired') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.extract.parameters') }}</div>
    <div v-for="(item, index) in parameters" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('panel.extract.parameter') }} {{ index + 1 }}</span>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.extract.name') }}</div>
        <el-input v-model="item.name" size="small" :placeholder="t('panel.extract.namePlaceholder')" />
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.extract.type') }}</div>
        <el-select v-model="item.type" size="small" style="width:100%">
          <el-option v-for="type in TYPES" :key="type" :label="type" :value="type" />
        </el-select>
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.extract.description') }}</div>
        <el-input v-model="item.description" size="small" type="textarea" :rows="2" />
      </div>
      <div class="wf-inline">
        <el-switch v-model="item.required" size="small" />
        <span class="wf-field__label">{{ t('panel.start.required') }}</span>
      </div>
    </div>
    <button class="wf-add-btn" @click="add">+ {{ t('panel.extract.addParameter') }}</button>
    <div v-if="!parameters.length" class="wf-field__error">{{ t('panel.extract.parametersRequired') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import { getAvailableModels, getModelOptions } from '@/workflow/engine/modelOptions'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const TYPES = ['string', 'number', 'boolean', 'object', 'array[string]', 'array[number]', 'array[object]']

interface ParameterRow {
  name?: string
  type?: string
  description?: string
  required?: boolean
}

const raw = computed(() => props.data as unknown as Record<string, any>)
const querySelector = computed<ValueSelector>(() => (Array.isArray(raw.value.query) ? raw.value.query : []))
const hasQuery = computed(() => querySelector.value.length >= 2)

const model = computed<Record<string, any>>(() => {
  if (!raw.value.model || typeof raw.value.model !== 'object') raw.value.model = { provider: '', name: '', mode: 'chat', completion_params: {} }
  if (!raw.value.model.completion_params || typeof raw.value.model.completion_params !== 'object') raw.value.model.completion_params = {}
  return raw.value.model
})

const providerOptions = computed(() => getModelOptions(store, t))
const modelOptions = computed(() => (model.value.provider ? getAvailableModels(store, model.value.provider) : []))

const parameters = computed<ParameterRow[]>(() => {
  if (!Array.isArray(raw.value.parameters)) raw.value.parameters = []
  return raw.value.parameters as ParameterRow[]
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

function onProviderChange(provider: string): void {
  model.value.provider = provider
  const models = getAvailableModels(store, provider)
  if (!models.includes(model.value.name)) model.value.name = models[0] ?? ''
}

function add(): void {
  parameters.value.push({ name: '', type: 'string', description: '', required: false })
}

function remove(index: number): void {
  parameters.value.splice(index, 1)
}
</script>
