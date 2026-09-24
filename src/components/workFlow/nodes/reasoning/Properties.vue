<!-- nodes/reasoning/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 模型类型 -->
    <div class="property-row">
      <label class="property-label">{{ t('model_type') }}</label>
      <div class="property-input">
        <select :value="modelTypeValue" @change="onModelTypeChange(($event.target as HTMLSelectElement).value)">
          <option v-for="opt in modelTypeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
    </div>
    
    <!-- 模型选择 -->
    <div class="property-row">
      <label class="property-label">{{ t('model_selection') }}</label>
      <div class="property-input">
        <select :value="node.model" @change="onUpdate('model', ($event.target as HTMLSelectElement).value)">
          <option value="">{{ t('select_model') }}</option>
          <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>
    </div>
    
    <!-- 提示�?-->
    <div class="property-row">
      <label class="property-label">{{ t('prompt_input') }}</label>
      <div class="property-input">
        <textarea :value="node.prompt" @input="onUpdate('prompt', ($event.target as HTMLTextAreaElement).value)"
          :placeholder="t('input_prompt')" rows="6"
          style="width:calc(100% - 12px);resize:vertical;font-size:12px;font-family:Consolas,Monaco,monospace;" />
      </div>
    </div>
    
    <!-- 上游节点信息 -->
    <div v-if="upstream.length > 0" class="upstream-info">
      <div class="upstream-header">
        <i class="fa fa-info-circle"></i>
        <span>{{ upstream.length === 1 ? t('connected_node') : t('connected_nodes') }}</span>
      </div>
      <table class="upstream-table">
        <tr><th>{{ t('upstream_node_name') }}</th><th>{{ t('upstream_node_type') }}</th><th>{{ t('upstream_data_key') }}</th></tr>
        <tr v-for="u in upstream" :key="u.id">
          <td><i class="fa" :class="u.icon" :style="{color:u.iconColor}"></i> {{ u.name }}</td>
          <td>{{ u.type }}</td>
          <td><code>{{ u.key }}</code></td>
        </tr>
      </table>
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
  upstream: any[]
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
}>()

const onUpdate = (key: string, value: any) => emit('update', { [key]: value })

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

const availableModels = computed(() =>
  modelTypeValue.value ? getWorkflowAvailableModels(props.store, modelTypeValue.value) : []
)
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.upstream-info { margin-bottom: 10px; overflow: hidden; }
.upstream-header {
  padding: 6px 10px;
  background-color: rgba(0,0,0,0.05);
  font-size: 12px;
  color: var(--fontColor);
  display: flex;
  align-items: center;
  gap: 6px;
}
.upstream-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.upstream-table th {
  background-color: rgba(0,0,0,0.03);
  padding: 4px 6px;
  text-align: left;
  border-bottom: 1px solid var(--borderColor);
  font-weight: 500;
}
.upstream-table td { padding: 4px 6px; border-bottom: 1px solid rgba(0,0,0,0.05); }
.upstream-table td code {
  background-color: rgba(0,0,0,0.05);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10px;
}
</style>

