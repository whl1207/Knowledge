<!-- nodes/python/Properties.vue -->
<template>
  <div class="property-group">
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
    
    <!-- Python代码编辑�?-->
    <div class="property-row">
      <label class="property-label">{{ t('python_code') }}</label>
      <div class="property-input">
        <textarea :value="node.prompt" @input="onUpdate('prompt', ($event.target as HTMLTextAreaElement).value)"
          :placeholder="t('input_code')" rows="8"
          class="code-textarea scoll"
          style="width:calc(100% - 12px);font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.4;resize:vertical;" />
      </div>
    </div>
    
    <div class="code-help">
      <small>{{ t('available_vars') }}: <code>input</code>, <code>output</code>, <code>log()</code></small>
      <br>
      <small>{{ t('import_modules') }}: <code>json</code>, <code>math</code>, <code>re</code>, <code>collections</code> {{ t('standard_libs') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NodeData } from '@/components/workFlow/WorkflowTypes'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
  upstream: any[]
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
}>()

const onUpdate = (key: string, value: any) => emit('update', { [key]: value })
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.code-help code { background-color: rgba(0,0,0,0.1); padding: 2px 5px; border-radius: 3px; font-size: 10px; margin: 0 2px; }
.upstream-info { margin-bottom: 10px; overflow: hidden; }
.upstream-header { padding: 6px 10px; background-color: rgba(0,0,0,0.05); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.upstream-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.upstream-table th { padding: 4px 6px; text-align: left; border-bottom: 1px solid var(--borderColor); font-weight: 500; }
.upstream-table td { padding: 4px 6px; border-bottom: 1px solid rgba(0,0,0,0.05); }
.upstream-table td code { background-color: rgba(0,0,0,0.05); padding: 1px 4px; border-radius: 3px; font-size: 10px; }
</style>

