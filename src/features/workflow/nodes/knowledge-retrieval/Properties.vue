<!-- src/features/workflow/nodes/knowledge-retrieval/Properties.vue -->
<!-- 知识检索：查询变量 + 本地知识库（Dify 数据集在本地不可用，导出时该字段被忽略） -->
<template>
  <div>
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
      <div v-if="!hasQuery" class="wf-field__error">{{ t('panel.kb.queryRequired') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.kb.file') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-input :model-value="kbPath" size="small" :placeholder="t('panel.kb.filePlaceholder')" @update:model-value="set('kb_path', $event)" />
        <button class="wf-btn" @click="pickFile">{{ t('panel.kb.browse') }}</button>
      </div>
      <div class="wf-field__hint">{{ t('panel.kb.fileHint') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.kb.options') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.kb.topK') }}</div>
      <el-input-number
        :model-value="topK"
        size="small"
        :min="1"
        :max="50"
        controls-position="right"
        style="width:100%"
        @update:model-value="setConfig('top_k', $event)"
      />
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
        @update:model-value="setConfig('score_threshold', $event)"
      />
      <div class="wf-field__hint">{{ t('panel.kb.scoreThresholdHint') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElInputNumber } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/features/workflow/dsl/types'
import { getPlatform, hasCapability } from '@/platform'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)
const querySelector = computed<ValueSelector>(() => (Array.isArray(raw.value.query_variable_selector) ? raw.value.query_variable_selector : []))
const hasQuery = computed(() => querySelector.value.length >= 2)
const kbPath = computed(() => String(raw.value.kb_path ?? ''))
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
  const path = await getPlatform().dialog.pickFile({
    filters: [{ name: 'Knowledge Base', extensions: ['kb'] }],
  })
  if (path) set('kb_path', path)
}
</script>
