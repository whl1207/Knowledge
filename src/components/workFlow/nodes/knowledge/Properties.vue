<!-- nodes/knowledge/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 知识库路�?-->
    <div class="property-row">
      <label class="property-label">{{ t('kb_path') }}</label>
      <div class="property-input">
        <div style="display:flex;gap:5px;">
          <input type="text" :value="node.kbPath" @input="onUpdate('kbPath', ($event.target as HTMLInputElement).value)"
            :placeholder="t('drag_kb_file')" style="flex:1;" />
          <button class="wf-btn small" @click="$emit('select-kb')">
            <i class="fa fa-folder-open"></i>
          </button>
        </div>
      </div>
    </div>
    
    <!-- 知识库验证状�?-->
    <div v-if="node.kbValidation" class="kb-validation">
      <div class="validation-status" :class="node.kbValidation.valid ? 'valid' : 'invalid'">
        <i class="fa" :class="node.kbValidation.valid ? 'fa-check-circle' : 'fa-exclamation-circle'"></i>
        <span>{{ node.kbValidation.valid ? '知识库有效': '知识库存在问题' }}</span>
      </div>
      <div v-if="!node.kbValidation.valid && node.kbValidation.issues.length > 0" class="validation-issues">
        <small v-for="(issue, i) in node.kbValidation.issues" :key="i">{{ issue }}</small>
      </div>
    </div>
    
    <!-- 查询文本 -->
    <div class="property-row">
      <label class="property-label">{{ t('query_input') }}</label>
      <div class="property-input">
        <textarea :value="node.kbQuery" @input="onUpdate('kbQuery', ($event.target as HTMLTextAreaElement).value)"
          :placeholder="t('input_search')" rows="3"
          style="width:calc(100% - 12px);resize:vertical;font-size:12px;" />
      </div>
    </div>
    
    <!-- 检索选项 -->
    <div class="property-group">
      <h4 style="margin:0 0 8px 0;font-size:14px;"><i class="fa fa-sliders"></i> {{ t('retrieval_options') }}</h4>
      
      <div class="property-row">
        <label class="property-label">{{ t('top_k') }}</label>
        <input type="number" :value="kbOptions.topK" @input="onKbOption('topK', ($event.target as HTMLInputElement).value)"
          min="1" max="20"/>
      </div>
      <div class="property-row">
        <label class="property-label">{{ t('summary_weight') }}</label>
        <input type="number" :value="kbOptions.summaryWeight" @input="onKbOption('summaryWeight', ($event.target as HTMLInputElement).value)"
          min="0" max="1" step="0.1"/>
      </div>
      <div class="property-row" style="margin-bottom:5px;">
        <label class="property-label">{{ t('embed_model') }}</label>
        <input type="text" :value="kbOptions.embedModel" @input="onKbOption('embedModel', ($event.target as HTMLInputElement).value)"
          :placeholder="t('model_name')" style="flex:1;" />
      </div>
      <div class="property-row">
        <label class="property-label">{{ t('debug_mode') }}</label>
        <input type="checkbox" :checked="kbOptions.debug" @change="onKbOption('debug', ($event.target as HTMLInputElement).checked)" />
      </div>
    </div>

    <div class="code-help">
      <small>{{ t('kb_help') }}</small>
      <br v-if="upstream.length > 0">
      <small v-if="upstream.length > 0">{{ t('kb_query_help') }}。当前连接了{{ upstream.length }}个上游节点</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData, KbOptions } from '@/components/workFlow/WorkflowTypes'
import { defaultKbOptions } from '@/components/workFlow/WorkflowDefaults'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
  store: any
  upstream: any[]
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
  validate: [nodeId: number]
  'select-kb': []
}>()

const onUpdate = (key: string, value: any) => {
  if (key === 'kbPath') {
    emit('update', { [key]: value })
    emit('validate', props.node.id)
  } else {
    emit('update', { [key]: value })
  }
}

const kbOptions = computed(() => props.node.kbOptions || { ...defaultKbOptions })

const onKbOption = (key: string, value: any) => {
  const options = { ...props.node.kbOptions } as any
  if (key === 'topK') options.topK = parseInt(value) || defaultKbOptions.topK
  else if (key === 'summaryWeight') options[key] = parseFloat(value) || defaultKbOptions.summaryWeight
  else if (key === 'debug') options[key] = Boolean(value)
  else options[key] = String(value)
  emit('update', { kbOptions: options })
}
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.kb-validation { margin-bottom: 5px; padding: 8px; border-radius: 5px; background: rgba(0,0,0,0.02); border: 1px solid var(--borderColor); }
.validation-status { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 500; margin-bottom: 5px; }
.validation-status.valid { color: #4CAF50; }
.validation-status.invalid { color: #f44336; }
.validation-issues { padding-left: 20px; }
.validation-issues small { display: block; margin: 3px 0; color: #f44336; font-size: 11px; }
.property-btn.small { font-size: 11px; padding: 3px 6px; height: auto; background-color: var(--fontActiveColor); color: var(--backgroundColor); border: none; border-radius: 4px; cursor: pointer; }
</style>

