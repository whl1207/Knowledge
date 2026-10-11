<!-- src/features/workflow/nodes/GenericProperties.vue -->
<!-- 通用属性面板：按字段类型自动生成编辑器（未写专属面板的节点用它，仍可正常编辑） -->
<template>
  <div>
    <div v-if="!fields.length" class="wf-empty-hint">{{ t('panel.generic.empty') }}</div>

    <div v-for="field in fields" :key="field.key" class="wf-field">
      <div class="wf-field__label">{{ field.key }}</div>

      <el-switch
        v-if="field.kind === 'boolean'"
        :model-value="!!raw[field.key]"
        size="small"
        @update:model-value="set(field.key, $event)"
      />

      <el-input-number
        v-else-if="field.kind === 'number'"
        :model-value="typeof raw[field.key] === 'number' ? (raw[field.key] as number) : undefined"
        size="small"
        controls-position="right"
        style="width:100%"
        @update:model-value="set(field.key, $event)"
      />

      <VariableSelector
        v-else-if="field.kind === 'selector'"
        :model-value="asSelector(raw[field.key])"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.generic.selectVariable')"
        @update:model-value="set(field.key, $event)"
      />

      <el-input
        v-else-if="field.kind === 'text'"
        :model-value="String(raw[field.key] ?? '')"
        type="textarea"
        :rows="3"
        @update:model-value="set(field.key, $event)"
      />

      <el-input
        v-else-if="field.kind === 'string'"
        :model-value="String(raw[field.key] ?? '')"
        size="small"
        @update:model-value="set(field.key, $event)"
      />

      <template v-else>
        <el-input
          :model-value="jsonText(field.key)"
          type="textarea"
          :rows="4"
          @update:model-value="(v: string) => onJsonInput(field.key, v)"
        />
        <div v-if="jsonError[field.key]" class="wf-field__error">{{ jsonError[field.key] }}</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { ElInput, ElInputNumber, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import type { ValueSelector } from '@/features/workflow/dsl/types'
import type { NodePanelProps } from './panelProps'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

/** 面板统一处理、不在通用面板里重复出现的字段 */
const RESERVED = new Set([
  'type',
  'title',
  'desc',
  'version',
  'error_strategy',
  'retry_config',
  'x-ai-km',
  'isInIteration',
  'iteration_id',
  'isInLoop',
  'loop_id',
])

/** 值用多行文本框编辑的字段关键词 */
const TEXT_KEYS = ['code', 'template', 'prompt', 'content', 'answer', 'args', 'body', 'headers', 'params', 'query', 'description', 'text', 'url']

type FieldKind = 'boolean' | 'number' | 'selector' | 'string' | 'text' | 'json'

interface Field {
  key: string
  kind: FieldKind
}

const raw = computed(() => props.data as unknown as Record<string, unknown>)

function kindOf(key: string, value: unknown): FieldKind {
  if (key.endsWith('_selector') || key === 'value_selector') return 'selector'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') {
    return TEXT_KEYS.includes(key) || value.length > 60 ? 'text' : 'string'
  }
  return 'json'
}

const fields = computed<Field[]>(() =>
  Object.keys(raw.value)
    .filter((key) => !RESERVED.has(key))
    .map((key) => ({ key, kind: kindOf(key, raw.value[key]) })),
)

function asSelector(value: unknown): ValueSelector {
  return Array.isArray(value) ? (value as ValueSelector) : []
}

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

/** 对象 / 数组字段以 JSON 文本编辑（非法 JSON 时不写回） */
const jsonCache = reactive<Record<string, string>>({})
const jsonError = reactive<Record<string, string>>({})

function jsonText(key: string): string {
  if (jsonCache[key] !== undefined) return jsonCache[key]
  try {
    return JSON.stringify(raw.value[key] ?? null, null, 2)
  } catch {
    return ''
  }
}

function onJsonInput(key: string, text: string): void {
  jsonCache[key] = text
  try {
    raw.value[key] = text.trim() ? JSON.parse(text) : null
    delete jsonError[key]
  } catch (error) {
    jsonError[key] = `${t('panel.generic.invalidJson')}：${(error as Error).message}`
  }
}
</script>
