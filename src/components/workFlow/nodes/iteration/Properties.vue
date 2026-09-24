<!-- nodes/iteration/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 输入数组 -->
    <div class="property-row">
      <label class="property-label">{{ t('iteration_input') }}</label>
      <div class="property-input">
        <input type="text" :value="cfg.inputArray" @input="save({ inputArray: ($event.target as HTMLInputElement).value })"
          :placeholder="`{{${t('data_node')}.rows}} 或 [1,2,3]`" />
      </div>
    </div>

    <!-- 输出形态 -->
    <div class="property-row">
      <label class="property-label">{{ t('iteration_output_mode') }}</label>
      <div class="property-input">
        <select :value="cfg.outputMode || 'value'" @change="save({ outputMode: ($event.target as HTMLSelectElement).value as any })">
          <option value="value">{{ t('iter_out_value') }}</option>
          <option value="row">{{ t('iter_out_row') }}</option>
        </select>
      </div>
    </div>

    <!-- 并行度 / 错误处理 -->
    <div class="property-row">
      <label class="property-label">{{ t('iteration_concurrency') }}</label>
      <div class="property-input">
        <input type="number" min="1" max="50" :value="cfg.concurrency" @input="save({ concurrency: Number(($event.target as HTMLInputElement).value) || 1 })" />
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('iteration_error_mode') }}</label>
      <div class="property-input">
        <select :value="cfg.errorMode" @change="save({ errorMode: ($event.target as HTMLSelectElement).value as any })">
          <option value="terminated">{{ t('iter_err_terminated') }}</option>
          <option value="continue_with_error">{{ t('iter_err_continue') }}</option>
          <option value="continue_with_error_inject">{{ t('iter_err_inject') }}</option>
          <option value="remove_abnormal_output">{{ t('iter_err_remove') }}</option>
        </select>
      </div>
    </div>
    <div class="property-row">
      <label class="property-label">{{ t('iteration_max') }}</label>
      <div class="property-input">
        <input type="number" min="1" :value="cfg.maxIterations" @input="save({ maxIterations: Number(($event.target as HTMLInputElement).value) || 1 })" />
      </div>
    </div>

    <!-- 内部流水线 -->
    <div class="property-row" style="flex-direction:column;align-items:stretch;">
      <label class="property-label">{{ t('iteration_inner') }}</label>
      <div class="inner-pipeline">
        <div v-for="(n, idx) in cfg.innerItems || []" :key="n.id" class="inner-node">
          <div class="inner-node-head">
            <span class="inner-node-index">{{ idx + 1 }}</span>
            <select :value="n.type" @change="onInnerTypeChange(idx, ($event.target as HTMLSelectElement).value as NodeType)">
              <option v-for="opt in innerTypes" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <button class="wf-btn small" :title="t('iteration_inner_up')" @click="moveInner(idx, -1)"><i class="fa fa-arrow-up"></i></button>
            <button class="wf-btn small" :title="t('iteration_inner_down')" @click="moveInner(idx, 1)"><i class="fa fa-arrow-down"></i></button>
            <button class="wf-btn danger small" :title="t('delete_template')" @click="removeInner(idx)"><i class="fa fa-times"></i></button>
          </div>
          <div class="property-row">
            <label class="property-label" style="width:56px;">{{ t('node_name') }}</label>
            <div class="property-input">
              <input type="text" :value="n.name" @input="onInnerField(idx, 'name', ($event.target as HTMLInputElement).value)" />
            </div>
          </div>
          <div v-if="n.type === 'reasoning'" class="property-row">
            <label class="property-label" style="width:56px;">{{ t('model_selection') }}</label>
            <div class="property-input">
              <select :value="n.model" @change="onInnerField(idx, 'model', ($event.target as HTMLSelectElement).value)">
                <option value="">{{ t('select_model') }}</option>
                <option v-for="m in availableModels(n)" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
          </div>
          <div v-if="n.type !== 'end' && n.type !== 'aggregator'" class="property-row">
            <label class="property-label" style="width:56px;">{{ t(n.type === 'web' || n.type === 'webpage' ? 'iteration_inner_url' : 'prompt_input') }}</label>
            <div class="property-input">
              <textarea class="scoll" :value="n.prompt" @input="onInnerField(idx, 'prompt', ($event.target as HTMLTextAreaElement).value)"
                rows="6" :placeholder="innerPlaceholder(n.type)" style="width:calc(100% - 8px);resize:vertical;font-size:12px;font-family:Consolas,Monaco,monospace;" />
            </div>
          </div>
        </div>
        <button class="add-inner-btn" @click="addInner">
          <i class="fa fa-plus"></i> {{ t('iteration_add_inner') }}
        </button>
      </div>
      <div class="code-help" style="margin-top:4px;">{{ t('iteration_inner_help') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData } from '@/components/workFlow/WorkflowTypes'
import type { IterationConfig, IterationInnerNode, NodeType } from '@/components/workFlow/WorkflowTypes'
import { getWorkflowAvailableModels } from '@/components/workFlow/engine/executorHelpers'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
  store: any
}>()

const emit = defineEmits<{ update: [data: Partial<NodeData>] }>()

const cfg = computed<IterationConfig>(() => props.node.iterationConfig || {})

const save = (patch: Partial<IterationConfig>) => {
  emit('update', { iterationConfig: { ...props.node.iterationConfig, ...patch } })
}

const innerTypes: Array<{ value: NodeType; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'reasoning', label: '推理(LLM)' },
  { value: 'end', label: '结束(汇总)' },
  { value: 'aggregator', label: '变量聚合' },
  { value: 'web', label: '网络搜索' },
  { value: 'webpage', label: '网页抓取' },
  { value: 'python', label: 'Python' }
]

const availableModels = (n: IterationInnerNode) => {
  if (!n.model_type) return []
  return getWorkflowAvailableModels(props.store, n.model_type as string)
}

const innerPlaceholder = (type: string): string => {
  if (type === 'web') return '搜索词，可用 {{迭代节点.item.字段}}'
  if (type === 'webpage') return 'https://doi.org/{{迭代节点.item.doi}}'
  if (type === 'python') return '# input 为上一步结果'
  return '内容，可用 {{迭代节点.item.字段}}'
}

const addInner = () => {
  const list = [...(cfg.value.innerItems || [])]
  const modelType = props.store.AIconfig?.llm?.type || 'ollama'
  const id = list.length > 0 ? Math.max(...list.map(n => n.id)) + 1 : 0
  list.push({ id, type: 'text', name: `${props.t('inner_step')} ${list.length + 1}`, prompt: '' })
  save({ innerItems: list })
}

const removeInner = (idx: number) => {
  const list = [...(cfg.value.innerItems || [])]
  list.splice(idx, 1)
  save({ innerItems: list })
}

const moveInner = (idx: number, dir: number) => {
  const list = [...(cfg.value.innerItems || [])]
  const target = idx + dir
  if (target < 0 || target >= list.length) return
  const tmp = list[idx]; list[idx] = list[target]; list[target] = tmp
  save({ innerItems: list })
}

const onInnerField = (idx: number, key: string, value: any) => {
  const list = [...(cfg.value.innerItems || [])]
  list[idx] = { ...list[idx], [key]: value }
  save({ innerItems: list })
}

const onInnerTypeChange = (idx: number, type: NodeType) => {
  const list = [...(cfg.value.innerItems || [])]
  const prev = list[idx]
  const modelType = props.store.AIconfig?.llm?.type || 'ollama'
  const defaults: Record<string, string> = {
    text: '', reasoning: `请分析 {{迭代节点.item}}\n结合上下文，给出结论。`,
    web: '', webpage: 'https://doi.org/{{迭代节点.item.doi}}', python: '# input 为上一步结果'
  }
  const patch: any = {
    type,
    prompt: type === 'reasoning' ? prev.prompt || defaults.reasoning : (defaults[type] !== undefined ? defaults[type] : prev.prompt || '')
  }
  if (type === 'reasoning' && !prev.model_type) {
    patch.model_type = modelType
  }
  if (type === 'reasoning') {
    const mType = prev.model_type || modelType
    const models = availableModels({ ...prev, model_type: mType } as IterationInnerNode)
    patch.model = prev.model || (models[0] || '')
  }
  list[idx] = { ...prev, ...patch }
  save({ innerItems: list })
}
</script>

<style scoped>
.inner-pipeline { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.inner-node { border: 1px solid var(--borderColor); border-radius: 5px; padding: 6px; background: rgba(0,0,0,0.02); }
.inner-node-head { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.inner-node-index { font-size: 11px; font-weight: 600; color: #00897B; width: 16px; }
.inner-node-head select { flex: 1; font-size: 12px; }
.inner-btn { border: 1px solid var(--borderColor); background: transparent; border-radius: 3px; cursor: pointer; font-size: 10px; padding: 2px 5px; }
.inner-btn.danger:hover { color: #f44336; border-color: #f44336; }
.add-inner-btn { border: 1px dashed var(--borderColor); background: transparent; border-radius: 5px; padding: 6px; cursor: pointer; font-size: 12px; color: var(--fontColor); }
.add-inner-btn:hover { border-color: #00897B; color: #00897B; }
</style>
