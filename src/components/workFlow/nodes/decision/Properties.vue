<!-- nodes/decision/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 决策模式 -->
    <div class="property-row">
      <label class="property-label">{{ t('decision_mode') }}</label>
      <div class="property-input">
        <select :value="node.decisionMode" @change="onModeChange(($event.target as HTMLSelectElement).value)">
          <option value="llm">{{ t('llm_decision') }}</option>
          <option value="rule">{{ t('rule_decision') }}</option>
        </select>
      </div>
    </div>

    <!-- LLM决策配置 -->
    <div v-if="node.decisionMode === 'llm'">
      <div class="property-row">
        <label class="property-label">{{ t('model_type') }}</label>
        <div class="property-input">
          <select :value="modelTypeValue" @change="onModelTypeChange(($event.target as HTMLSelectElement).value)">
            <option v-for="opt in modelTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
      </div>
      <div class="property-row">
        <label class="property-label">{{ t('model_selection') }}</label>
        <div class="property-input">
          <select :value="node.model" @change="onUpdate('model', ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('select_model') }}</option>
            <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
      </div>
      <div class="property-row">
        <label class="property-label">{{ t('decision_prompt') }}</label>
        <div class="property-input">
          <textarea class="scoll" :value="node.decisionPrompt" @input="onUpdate('decisionPrompt', ($event.target as HTMLTextAreaElement).value)"
            :placeholder="t('decision_prompt_placeholder')" rows="5"
            style="width:calc(100% - 12px);resize:vertical;font-size:11px;" />
        </div>
      </div>
    </div>

    <!-- 规则决策配置 -->
    <div v-if="node.decisionMode === 'rule'">
      <div class="property-row">
        <label class="property-label">{{ t('decision_rules') }}</label>
        <div class="property-input">
          <textarea :value="node.decisionRules" @input="onUpdate('decisionRules', ($event.target as HTMLTextAreaElement).value)"
            :placeholder="t('decision_rules_placeholder')" rows="6"
            style="width:calc(100% - 12px);resize:vertical;font-size:11px;font-family:Consolas,Monaco,monospace;" />
        </div>
      </div>
    </div>

    <!-- 分支管理 -->
    <div class="property-group" style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.02);border-radius:5px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
        <h4 style="margin:0;font-size:14px;"><i class="fa fa-code-fork"></i> {{ t('branch_management') }}</h4>
        <button class="wf-btn primary small" @click="$emit('add-branch')"
          :disabled="(node.decisionBranches?.length || 0) >= 10">
          <i class="fa fa-plus"></i> {{ t('add_branch') }}
        </button>
      </div>
      <table class="branches-table" style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:rgba(0,0,0,0.05);">
            <th style="padding:4px;border:1px solid var(--borderColor);width:30px;">#</th>
            <th style="padding:4px;border:1px solid var(--borderColor);">{{ t('branch_name') }}</th>
            <th style="padding:4px;border:1px solid var(--borderColor);">{{ t('branch_description') }}</th>
            <th style="padding:4px;border:1px solid var(--borderColor);width:40px;text-align:center;">{{ t('delete') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(branch, idx) in node.decisionBranches" :key="branch.id">
            <td style="padding:2px;border:1px solid var(--borderColor);text-align:center;">{{ idx + 1 }}</td>
            <td style="padding:2px;border:1px solid var(--borderColor);">
              <input :value="branch.name" @input="onBranchUpdate(branch.id, 'name', ($event.target as HTMLInputElement).value)"
                style="width:calc(100% - 6px);margin:0px;padding:2px;font-size:11px;" />
            </td>
            <td style="padding:2px;border:1px solid var(--borderColor);">
              <input :value="branch.description" @input="onBranchUpdate(branch.id, 'description', ($event.target as HTMLInputElement).value)"
                :placeholder="t('branch_description_placeholder')" style="width:calc(100% - 6px);margin:0px;padding:2px;font-size:11px;" />
            </td>
            <td style="padding:2px;border:1px solid var(--borderColor);text-align:center;">
              <button class="wf-btn danger small" @click="$emit('delete-branch', branch.id)"
                :disabled="(node.decisionBranches?.length || 0) <= 2">
                <i class="fa fa-trash"></i>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="code-help" style="margin-top:10px;">
      <small>{{ t('decision_node_help') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData } from '@/components/workFlow/WorkflowTypes'
import { getWorkflowModelOptions, getWorkflowAvailableModels } from '@/components/workFlow/engine/executorHelpers'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
  store: any
  links: any[]
}>()

/** 模型来源下拉选项：内置来源 + 每个自定义来源独立一项（按名称，value 编码 custom:<index>） */
const modelTypeOptions = computed(() => getWorkflowModelOptions(props.store, props.t))

/** 当前来源下拉值：custom 编码为 custom:<index>（绑定具体自定义来源，缺省用激活来源） */
const modelTypeValue = computed<string>(() =>
  props.node.model_type === 'custom'
    ? 'custom:' + (typeof props.node.customSourceIndex === 'number'
        ? props.node.customSourceIndex
        : (props.store.AIconfig?.llm?.custom?.activeIndex ?? 0))
    : (props.node.model_type || '')
)

/** 选择来源：custom:<index> → model_type='custom' + customSourceIndex；内置来源 → 清空 customSourceIndex */
const onModelTypeChange = (v: string) => {
  if (v.startsWith('custom:')) {
    const n = parseInt(v.slice('custom:'.length), 10)
    emit('update', { model_type: 'custom', customSourceIndex: isNaN(n) || n < 0 ? 0 : n })
  } else {
    emit('update', { model_type: v, customSourceIndex: undefined })
  }
}

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
  'add-branch': []
  'delete-branch': [branchId: string]
}>()

const onUpdate = (key: string, value: any) => emit('update', { [key]: value })

const onModeChange = (mode: string) => {
  emit('update', { decisionMode: mode as 'llm' | 'rule' })
  if (mode === 'rule' && !props.node.decisionRules) {
    emit('update', {
      decisionRules: `[\n  {\n    "condition": "input && input.length > 100",\n    "branch": "branch_1"\n  },\n  {\n    "condition": "true",\n    "branch": "branch_2"\n  }\n]`
    })
  }
}

const onBranchUpdate = (branchId: string, field: string, value: string) => {
  if (!props.node.decisionBranches) return
  const branch = props.node.decisionBranches.find(b => b.id === branchId)
  if (branch) {
    (branch as any)[field] = value
    emit('update', { decisionBranches: [...props.node.decisionBranches] })
  }
}

const availableModels = computed(() =>
  modelTypeValue.value ? getWorkflowAvailableModels(props.store, modelTypeValue.value) : []
)
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.property-btn.small { font-size: 11px; padding: 3px 6px; height: auto; }
.property-btn.primary { background-color: var(--fontActiveColor); color: var(--backgroundColor); border: none; border-radius: 4px; cursor: pointer; }
.property-btn.danger { background-color: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; }
.property-btn.primary:disabled, .property-btn.danger:disabled { opacity: 0.6; cursor: not-allowed; }
</style>

