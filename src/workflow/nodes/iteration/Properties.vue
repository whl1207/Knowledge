<!-- src/workflow/nodes/iteration/Properties.vue -->
<!-- 迭代容器：数组来源 / 收集哪个内部节点的输出 / 并发 / 错误模式 -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">{{ t('panel.iteration.hint') }}</div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.iteration.iterator') }}</div>
      <VariableSelector
        :model-value="iteratorSelector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.iteration.selectIterator')"
        @update:model-value="set('iterator_selector', $event)"
      />
      <div v-if="!hasIterator" class="wf-field__error">{{ t('panel.iteration.iteratorRequired') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.iteration.output') }}</div>
      <VariableSelector
        :model-value="outputSelector"
        :nodes="nodes"
        :edges="edges"
        :current-node-id="nodeId"
        :environment-variables="environmentVariables"
        :conversation-variables="conversationVariables"
        :placeholder="t('panel.iteration.selectOutput')"
        @update:model-value="set('output_selector', $event)"
      />
      <div class="wf-field__hint">{{ t('panel.iteration.outputHint') }}</div>
      <div class="wf-field__hint">{{ t('panel.iteration.childrenHint') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.iteration.errorMode') }}</div>
      <el-select
        :model-value="errorMode"
        size="small"
        style="width:100%"
        @update:model-value="set('error_handle_mode', $event)"
      >
        <el-option v-for="mode in ERROR_MODES" :key="mode" :label="t('iterationMode.' + mode)" :value="mode" />
      </el-select>
    </div>

    <div class="wf-inline" style="margin-bottom:8px">
      <el-switch
        :model-value="!!raw.is_parallel"
        size="small"
        @update:model-value="set('is_parallel', $event)"
      />
      <span class="wf-field__label">{{ t('panel.iteration.parallel') }}</span>
    </div>
    <div v-if="raw.is_parallel" class="wf-field">
      <div class="wf-field__label">{{ t('panel.iteration.parallelNums') }}</div>
      <el-input-number
        :model-value="Number(raw.parallel_nums ?? 10)"
        size="small"
        :min="1"
        :max="50"
        controls-position="right"
        style="width:100%"
        @update:model-value="set('parallel_nums', $event)"
      />
      <div class="wf-field__hint">{{ t('panel.iteration.parallelHint') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInputNumber, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const ERROR_MODES = ['terminated', 'continue_with_error', 'continue_with_error_inject', 'remove_abnormal_output'] as const

const raw = computed(() => props.data as unknown as Record<string, any>)

const iteratorSelector = computed<ValueSelector>(() => (Array.isArray(raw.value.iterator_selector) ? raw.value.iterator_selector : []))
const outputSelector = computed<ValueSelector>(() => (Array.isArray(raw.value.output_selector) ? raw.value.output_selector : []))
const hasIterator = computed(() => iteratorSelector.value.length >= 2)
const errorMode = computed(() => String(raw.value.error_handle_mode ?? 'terminated'))

function set(key: string, value: unknown): void {
  raw.value[key] = value
}
</script>
