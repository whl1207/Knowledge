<!-- src/features/workflow/nodes/agent/Properties.vue -->
<!-- 智能体节点：选用 AI-KM 智能体预设（角色 / 能力 / 技能 / 知识库 / MCP），并给出本次任务输入 -->
<template>
  <div>
    <div class="wf-section-title">{{ t('panel.agent.sectionRole') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.agent.preset') }}</div>
      <el-select
        :model-value="presetId"
        size="small"
        style="width:100%"
        :placeholder="t('panel.agent.selectPreset')"
        @update:model-value="setPreset"
      >
        <el-option :label="t('panel.agent.general')" value="" />
        <el-option v-for="item in presets" :key="item.id" :label="item.name || item.id" :value="item.id" />
      </el-select>
      <div class="wf-field__hint">{{ t('panel.agent.presetHint') }}</div>
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.agent.query') }}</div>
      <div class="wf-inline wf-inline--full" style="margin-bottom:6px">
        <VariableSelector
          insert-mode
          :nodes="nodes"
          :edges="edges"
          :current-node-id="nodeId"
          :environment-variables="environmentVariables"
          :conversation-variables="conversationVariables"
          :placeholder="t('panel.insertVariable')"
          @pick="insertQuery"
        />
      </div>
      <el-input
        ref="queryRef"
        :model-value="query"
        type="textarea"
        :rows="5"
        :placeholder="t('panel.agent.queryPlaceholder')"
        @update:model-value="setQuery"
      />
      <div class="wf-field__hint">{{ t('panel.agent.queryHint') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.agent.sectionModel') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.agent.provider') }}</div>
      <el-select
        :model-value="provider"
        size="small"
        style="width:100%"
        :placeholder="t('panel.agent.followPreset')"
        @update:model-value="setProvider"
      >
        <el-option :label="t('panel.agent.followPreset')" value="" />
        <el-option v-for="opt in providerOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
    </div>
    <div v-if="provider" class="wf-field">
      <div class="wf-field__label">{{ t('panel.agent.model') }}</div>
      <el-select
        :model-value="modelName"
        size="small"
        filterable
        allow-create
        default-first-option
        style="width:100%"
        :placeholder="t('panel.llm.selectModel')"
        @update:model-value="setModelName"
      >
        <el-option v-for="name in modelOptions" :key="name" :label="name" :value="name" />
      </el-select>
    </div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.agent.maxSteps') }}</div>
      <el-input-number
        :model-value="maxSteps"
        size="small"
        :min="0"
        :max="1000"
        controls-position="right"
        style="width:100%"
        @update:model-value="setMaxSteps"
      />
      <div class="wf-field__hint">{{ t('panel.agent.maxStepsHint') }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.agent.sectionTools') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.agent.tools') }}</div>
      <el-select
        :model-value="toolsOverride"
        multiple
        collapse-tags
        collapse-tags-tooltip
        size="small"
        style="width:100%"
        :placeholder="t('panel.agent.toolsFollow')"
        @update:model-value="setToolsOverride"
      >
        <el-option v-for="tool in toolOptions" :key="tool.name" :label="tool.label" :value="tool.name" />
      </el-select>
      <div class="wf-field__hint">{{ t('panel.agent.toolsHint') }}</div>
    </div>
    <div class="wf-inline" style="margin-bottom:6px">
      <el-switch :model-value="structured" size="small" @update:model-value="setStructured" />
      <span class="wf-field__label">{{ t('panel.agent.structured') }}</span>
    </div>
    <div class="wf-field__hint">{{ t('panel.agent.structuredHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/features/workflow/ui/locales'
import VariableSelector from '@/features/workflow/ui/VariableSelector.vue'
import { getAvailableModels, getModelOptions } from '@/features/workflow/engine/modelOptions'
import { insertVariableAtCursor } from '@/features/workflow/dsl/variable'
import { AGENT_TOOL_REGISTRY } from '@/services/agentSkills'
import type { VariableOption } from '@/features/workflow/ui/variables'
import type { NodePanelProps } from '../panelProps'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const data = computed(() => props.data as unknown as Record<string, any>)
const presets = computed<any[]>(() => (store.agentPresets || []) as any[])

/** 模型配置块：缺失时补齐，保证面板可编辑（provider 为空 = 跟随预设 / 全局） */
const model = computed<{ provider: string; name: string; completion_params: Record<string, any> }>(() => {
  if (!data.value.model || typeof data.value.model !== 'object') {
    data.value.model = { provider: '', name: '', completion_params: {} }
  }
  if (!data.value.model.completion_params || typeof data.value.model.completion_params !== 'object') {
    data.value.model.completion_params = {}
  }
  return data.value.model
})

/** 工具清单：ask_user 在工作流运行期无人应答（执行器已剔除），因此这里不再列出 */
const toolOptions = computed(() =>
  AGENT_TOOL_REGISTRY
    .filter((tool) => tool.name !== 'ask_user')
    .map((tool) => ({ name: tool.name, label: store.locales === 'en' ? tool.labelEn : tool.labelZh })),
)

const presetId = computed(() => String(data.value.agent_preset_id ?? ''))
const query = computed(() => String(data.value.query ?? ''))
const provider = computed(() => String(model.value.provider ?? ''))
const modelName = computed(() => String(model.value.name ?? ''))
const maxSteps = computed(() => Number(data.value.max_steps) || 0)
const structured = computed(() => data.value.structured_output === true)
const toolsOverride = computed<string[]>(() => (Array.isArray(data.value.tools_override) ? data.value.tools_override : []))
const providerOptions = computed(() => getModelOptions(store, t))
const modelOptions = computed(() => (provider.value ? getAvailableModels(store, provider.value) : []))

const queryRef = ref<any>(null)

function setPreset(value: string): void {
  data.value.agent_preset_id = value || ''
}

function setQuery(value: string): void {
  data.value.query = value ?? ''
}

function setProvider(value: string): void {
  model.value.provider = value || ''
  // 切回「跟随预设」时清掉模型名，避免残留一个固定模型继续生效
  if (!value) model.value.name = ''
}

function setModelName(value: string): void {
  model.value.name = value || ''
}

function setMaxSteps(value: number | undefined): void {
  data.value.max_steps = value && value > 0 ? value : 0
}

function setStructured(value: boolean | string | number): void {
  data.value.structured_output = value === true
}

function setToolsOverride(value: string[] | undefined): void {
  data.value.tools_override = Array.isArray(value) ? [...value] : []
}

/** 把变量插到任务输入的光标位置 */
function insertQuery(option: VariableOption): void {
  const el = queryRef.value?.textarea as HTMLTextAreaElement | undefined
  const cursor = el ? el.selectionStart ?? query.value.length : query.value.length
  const next = insertVariableAtCursor(query.value, cursor, option.selector)
  setQuery(next.text)
  requestAnimationFrame(() => {
    if (!el) return
    el.focus()
    el.setSelectionRange(next.cursor, next.cursor)
  })
}
</script>
