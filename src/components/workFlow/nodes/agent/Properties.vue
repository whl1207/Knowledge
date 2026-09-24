<!-- nodes/agent/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 选择智能体：通用智能体 / 预设智能体 -->
    <div class="property-row">
      <label class="property-label">{{ t('agent_preset_select') }}</label>
      <div class="property-input">
        <select :value="cfg.presetId || ''" @change="onPresetChange($event.target as HTMLSelectElement)">
          <option value="">{{ t('agent_general') }}</option>
          <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
    </div>

    <!-- 任务提示词（与上游节点共同构造任务） -->
    <div class="property-row" style="flex-direction:column;align-items:stretch;">
      <label class="property-label">{{ t('agent_task_prompt') }}</label>
      <div class="property-input">
        <textarea :value="cfg.prompt" @input="save({ prompt: ($event.target as HTMLTextAreaElement).value })"
          rows="5" :placeholder="`请分析：{{迭代节点.item.title}}`"
          style="width:calc(100% - 8px);resize:vertical;font-size:12px;" />
      </div>
    </div>

    <div class="code-help">{{ t('agent_help') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData } from '@/components/workFlow/WorkflowTypes'
import type { AgentConfig } from '@/components/workFlow/WorkflowTypes'
import { usestore } from '@/store'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{ update: [data: Partial<NodeData>] }>()
const store = usestore()

const cfg = computed<AgentConfig>(() => props.node.agentConfig || {})
const presets = computed(() => (store.agentPresets || []) as any[])

const save = (patch: Partial<AgentConfig>) => emit('update', { agentConfig: { ...props.node.agentConfig, ...patch } })

const onPresetChange = (el: HTMLSelectElement) => {
  const v = el.value
  save({ presetId: v || '' })
}
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
</style>
