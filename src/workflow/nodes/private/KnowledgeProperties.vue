<!-- src/workflow/nodes/private/KnowledgeProperties.vue -->
<!-- 本地扩展：本地知识库检索 -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.kb.file') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="kbPath" size="small" :placeholder="t('panel.kb.filePlaceholder')" @update:model-value="set('kb_path', $event)" />
        <button class="wf-btn" @click="pickFile">{{ t('panel.kb.browse') }}</button>
      </div>
      <div v-if="!kbPath" class="wf-field__error">{{ t('panel.localKb.required') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.kb.query') }}</div>
      <VariableSelector
        :model-value="querySelector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.kb.selectQuery')"
        @update:model-value="set('query_variable_selector', $event)"
      />
      <div class="wf-field__hint">{{ t('panel.localKb.queryHint') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.localKb.fallbackQuery') }}</div>
      <el-input :model-value="query" size="small" :placeholder="t('panel.localKb.fallbackPlaceholder')" @update:model-value="set('query', $event)" />
    </div>

    <div class="wf-section-title">{{ t('panel.kb.options') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.kb.topK') }}</div>
      <el-input-number :model-value="topK" size="small" :min="1" :max="50" controls-position="right" style="width:100%" @update:model-value="(v: number | undefined) => setConfig('top_k', Number(v ?? 5))" />
    </div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.kb.scoreThreshold') }}</div>
      <el-input-number
        :model-value="scoreThreshold"
        size="small"
        :min="0"
        :max="1"
        :step="0.05"
        :precision="2"
        controls-position="right"
        style="width:100%"
        @update:model-value="(v: number | undefined) => setConfig('score_threshold', Number(v ?? 0))"
      />
      <div class="wf-field__hint">{{ t('panel.kb.scoreThresholdHint') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElInputNumber } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)
const kbPath = computed(() => String(raw.value.kb_path ?? ''))
const querySelector = computed<ValueSelector>(() => (Array.isArray(raw.value.query_variable_selector) ? raw.value.query_variable_selector : []))
const query = computed(() => String(raw.value.query ?? ''))
const topK = computed(() => Number(raw.value.multiple_retrieval_config?.top_k ?? 5))
const scoreThreshold = computed(() => Number(raw.value.multiple_retrieval_config?.score_threshold ?? 0))

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

function setConfig(key: string, value: unknown): void {
  if (!raw.value.multiple_retrieval_config || typeof raw.value.multiple_retrieval_config !== 'object') {
    raw.value.multiple_retrieval_config = {}
  }
  raw.value.multiple_retrieval_config[key] = value
}

async function pickFile(): Promise<void> {
  const path = await window.ipcRenderer.invoke('selectFile', { filters: [{ name: '知识库', extensions: ['kb'] }] })
  if (path) set('kb_path', path)
}
</script>
