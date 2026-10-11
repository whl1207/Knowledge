<!-- src/features/workflow/nodes/llm/Properties.vue -->
<!-- 大语言模型节点：模型来源与模型、提示词消息、上下文变量、模型参数 -->
<template>
  <div>
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

    <div class="wf-section-title">{{ t('panel.llm.prompt') }}</div>
    <div class="wf-field__hint" style="margin-bottom:8px">{{ t('panel.llm.promptHint') }}</div>

    <div v-for="(message, index) in messages" :key="index" class="wf-card">
      <div class="wf-card__head">
        <el-select v-model="message.role" size="small" style="width:104px">
          <el-option v-for="role in ROLES" :key="role" :label="t('panel.llm.role.' + role)" :value="role" />
        </el-select>
        <span class="wf-card__title" />
        <VariableSelector
          insert-mode
          :nodes="nodes"
          :edges="edges"
          :current-node-id="nodeId"
          :environment-variables="environmentVariables"
          :conversation-variables="conversationVariables"
          :placeholder="t('panel.insertVariable')"
          @pick="(option) => insertInto(message, option, index)"
        />
        <button class="wf-icon-btn" :title="t('panel.moveUp')" @click="move(index, -1)">↑</button>
        <button class="wf-icon-btn" :title="t('panel.moveDown')" @click="move(index, 1)">↓</button>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>
      <el-input
        :ref="(el: any) => setTextareaRef(index, el)"
        v-model="message.text"
        type="textarea"
        :rows="4"
        :placeholder="t('panel.llm.promptPlaceholder')"
      />
    </div>

    <button class="wf-add-btn" @click="addMessage">+ {{ t('panel.llm.addMessage') }}</button>
    <div v-if="!messages.length" class="wf-field__error">{{ t('panel.llm.promptRequired') }}</div>

    <div class="wf-section-title">{{ t('panel.llm.context') }}</div>
    <div class="wf-inline" style="margin-bottom:6px">
      <el-switch v-model="context.enabled" size="small" />
      <span class="wf-field__label">{{ t('panel.llm.contextEnabled') }}</span>
    </div>
    <VariableSelector
      v-if="context.enabled"
      :model-value="context.variable_selector"
      :nodes="nodes"
      :edges="edges"
      :current-node-id="nodeId"
      :environment-variables="environmentVariables"
      :conversation-variables="conversationVariables"
      :placeholder="t('panel.llm.selectContext')"
      @update:model-value="context.variable_selector = $event"
    />

    <div class="wf-section-title">{{ t('panel.llm.params') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.llm.temperature') }} · {{ temperature }}</div>
      <el-slider
        :model-value="temperature"
        size="small"
        :min="0"
        :max="2"
        :step="0.1"
        @update:model-value="setParam('temperature', $event as number)"
      />
    </div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.llm.maxTokens') }}</div>
      <el-input-number
        :model-value="maxTokens"
        size="small"
        :min="1"
        :max="1000000"
        controls-position="right"
        style="width:100%"
        @update:model-value="setParam('max_tokens', $event as number)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect, ElSlider, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import { getAvailableModels, getModelOptions } from '@/features/workflow/engine/modelOptions'
import { insertVariableAtCursor } from '@/features/workflow/dsl/variable'
import type { VariableOption } from '@/features/workflow/ui/variables'
import type { NodePanelProps } from '../panelProps'
import type { PromptMessage } from '@/features/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const ROLES = ['system', 'user', 'assistant'] as const

const data = computed(() => props.data as unknown as Record<string, any>)

/** 模型配置块：缺失时补齐，保证面板可编辑 */
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

const messages = computed<PromptMessage[]>(() => {
  if (!Array.isArray(data.value.prompt_template)) data.value.prompt_template = []
  return data.value.prompt_template as PromptMessage[]
})

const context = computed<{ enabled?: boolean; variable_selector: string[] }>(() => {
  if (!data.value.context || typeof data.value.context !== 'object') {
    data.value.context = { enabled: false, variable_selector: [] }
  }
  if (!Array.isArray(data.value.context.variable_selector)) data.value.context.variable_selector = []
  return data.value.context
})

const temperature = computed(() => Number(model.value.completion_params.temperature ?? 0.7))
const maxTokens = computed(() => Number(model.value.completion_params.max_tokens ?? 512))

const textareaRefs = ref<Record<number, any>>({})

function setTextareaRef(index: number, el: any): void {
  if (el) textareaRefs.value[index] = el
}

/** 切换来源后，若当前模型不在新来源的模型列表里就换成第一个 */
function onProviderChange(provider: string): void {
  model.value.provider = provider
  const models = getAvailableModels(store, provider)
  if (!models.includes(model.value.name)) model.value.name = models[0] ?? ''
}

function setParam(key: string, value: number | undefined): void {
  if (value === undefined || Number.isNaN(value)) {
    delete model.value.completion_params[key]
    return
  }
  model.value.completion_params[key] = value
}

function addMessage(): void {
  messages.value.push({ role: 'user', text: '' })
}

function remove(index: number): void {
  messages.value.splice(index, 1)
  delete textareaRefs.value[index]
}

function move(index: number, delta: number): void {
  const target = index + delta
  if (target < 0 || target >= messages.value.length) return
  const [item] = messages.value.splice(index, 1)
  messages.value.splice(target, 0, item)
}

/** 把变量插到某条消息的光标位置 */
function insertInto(message: PromptMessage, option: VariableOption, index: number): void {
  const el = textareaRefs.value[index]?.textarea as HTMLTextAreaElement | undefined
  const cursor = el ? el.selectionStart ?? message.text.length : message.text.length
  const next = insertVariableAtCursor(message.text ?? '', cursor, option.selector)
  message.text = next.text
  requestAnimationFrame(() => {
    if (!el) return
    el.focus()
    el.setSelectionRange(next.cursor, next.cursor)
  })
}
</script>
