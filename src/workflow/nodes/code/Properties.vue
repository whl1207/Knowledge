<!-- src/workflow/nodes/code/Properties.vue -->
<!-- 代码执行：语言 / 变量绑定 / 代码正文 / 输出变量声明 -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.code.language') }}</div>
      <el-select :model-value="language" size="small" style="width:100%" @update:model-value="set('code_language', $event)">
        <el-option label="Python 3" value="python3" />
      </el-select>
      <div class="wf-field__hint">{{ t('panel.code.languageHint') }}</div>
    </div>

    <div class="wf-section-title">{{ t('selector.title') }}</div>
    <SelectorList
      :data="data"
      :node-id="nodeId"
      :nodes="nodes"
      :edges="edges"
      :environment-variables="environmentVariables"
      :conversation-variables="conversationVariables"
      :items="variables"
      :add-label="t('panel.code.addVariable')"
      :empty-label="t('panel.code.noVariables')"
      name-placeholder="question"
    />

    <div class="wf-section-title">{{ t('panel.code.content') }}</div>
    <el-input
      :model-value="code"
      type="textarea"
      :rows="12"
      :placeholder="t('panel.code.placeholder')"
      class="wf-code"
      @update:model-value="set('code', $event)"
    />
    <div class="wf-field__hint">{{ t('panel.code.outputHint') }}</div>

    <div class="wf-section-title">{{ t('panel.outputs') }}</div>
    <div class="wf-field__hint" style="margin-bottom:6px">{{ t('panel.code.outputsHint') }}</div>
    <div v-for="(item, index) in outputRows" :key="index" class="wf-inline" style="margin-bottom:4px">
      <el-input
        :model-value="item.name"
        size="small"
        :placeholder="t('panel.code.outputName')"
        @update:model-value="(v: string) => renameOutput(index, v)"
      />
      <el-select
        :model-value="item.type"
        size="small"
        style="width:120px"
        @update:model-value="(v: string) => setOutputType(index, v)"
      >
        <el-option v-for="type in OUTPUT_TYPES" :key="type" :label="type" :value="type" />
      </el-select>
      <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="removeOutput(index)">✕</button>
    </div>
    <button class="wf-add-btn" @click="addOutput">+ {{ t('panel.code.addOutput') }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import SelectorList from '../SelectorList.vue'
import type { SelectorRow } from '../SelectorList.vue'
import type { NodePanelProps } from '../panelProps'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const OUTPUT_TYPES = ['string', 'number', 'object', 'array[string]', 'array[object]', 'boolean']

const raw = computed(() => props.data as unknown as Record<string, any>)
const language = computed(() => String(raw.value.code_language ?? 'python3'))
const code = computed(() => String(raw.value.code ?? ''))

const variables = computed<SelectorRow[]>(() => {
  if (!Array.isArray(raw.value.variables)) raw.value.variables = []
  return raw.value.variables as SelectorRow[]
})

/** outputs 是「名称 → {type}」对象（对齐 Dify） */
const outputRows = computed<Array<{ name: string; type: string }>>(() => {
  if (!raw.value.outputs || typeof raw.value.outputs !== 'object' || Array.isArray(raw.value.outputs)) {
    raw.value.outputs = {}
  }
  return Object.entries(raw.value.outputs as Record<string, { type?: string }>).map(([name, meta]) => ({
    name,
    type: String(meta?.type ?? 'string'),
  }))
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

function rebuildOutputs(rows: Array<{ name: string; type: string }>): void {
  const next: Record<string, { type: string }> = {}
  for (const row of rows) if (row.name) next[row.name] = { type: row.type }
  raw.value.outputs = next
}

function renameOutput(index: number, name: string): void {
  rebuildOutputs(outputRows.value.map((row, i) => (i === index ? { ...row, name } : row)))
}

function setOutputType(index: number, type: string): void {
  rebuildOutputs(outputRows.value.map((row, i) => (i === index ? { ...row, type } : row)))
}

function addOutput(): void {
  const rows = outputRows.value
  let index = rows.length + 1
  while (rows.some((row) => row.name === `result${index}`)) index++
  rebuildOutputs([...rows, { name: rows.length ? `result${index}` : 'result', type: 'string' }])
}

function removeOutput(index: number): void {
  rebuildOutputs(outputRows.value.filter((_, i) => i !== index))
}
</script>

<style scoped>
.wf-code :deep(textarea) {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}
</style>
