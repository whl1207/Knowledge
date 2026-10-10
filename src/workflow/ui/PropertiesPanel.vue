<!-- src/workflow/ui/PropertiesPanel.vue -->
<!-- 属性面板外壳：节点标题 / 描述 / 专属面板 / 输出变量 / 错误处理 / 校验问题 / 原始数据 -->
<template>
  <aside class="wf-props">
    <div v-if="!data" class="wf-props__empty">{{ t('panel.selectNode') }}</div>

    <template v-else>
      <header class="wf-props__head">
        <span class="wf-props__icon" :style="{ '--node-color': presentation.color }">{{ presentation.glyph }}</span>
        <div class="wf-props__titles">
          <div class="wf-props__type">{{ typeLabel }}</div>
          <div class="wf-props__id">{{ nodeId }}</div>
        </div>
        <span v-if="isPrivate" class="wf-tag">{{ t('panel.privateNode') }}</span>
      </header>

      <div class="wf-props__body scoll">
        <div class="wf-field">
          <div class="wf-field__label">{{ t('panel.nodeTitle') }}</div>
          <el-input :model-value="data.title" size="small" :disabled="readonly" @update:model-value="data.title = $event" />
        </div>

        <div class="wf-field">
          <div class="wf-field__label">{{ t('panel.nodeDesc') }}</div>
          <el-input
            :model-value="data.desc ?? ''"
            type="textarea"
            :rows="2"
            :disabled="readonly"
            @update:model-value="data.desc = $event"
          />
        </div>

        <div v-if="issues.length" class="wf-issues">
          <div v-for="(issue, index) in issues" :key="index" class="wf-issues__item">{{ issue }}</div>
        </div>

        <div class="wf-section-title"><i class="fa fa-sliders"></i> {{ t('panel.nodeConfig') }}</div>
        <component :is="panelComponent" v-if="panelComponent" v-bind="panelProps" />
        <GenericProperties v-else v-bind="panelProps" />

        <div class="wf-section-title"><i class="fa fa-sign-out"></i> {{ t('panel.outputs') }}</div>
        <div v-if="!outputs.length" class="wf-empty-hint">{{ t('panel.noOutputs') }}</div>
        <table v-else class="wf-outputs">
          <tr v-for="output in outputs" :key="output.name">
            <td class="wf-outputs__name">{{ output.name }}</td>
            <td class="wf-outputs__type">{{ output.type }}</td>
          </tr>
        </table>

        <div class="wf-section-title"><i class="fa fa-shield"></i> {{ t('panel.errorHandling') }}</div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('panel.errorStrategy') }}</div>
          <el-select
            :model-value="errorStrategy"
            size="small"
            style="width:100%"
            :disabled="readonly"
            @update:model-value="data.error_strategy = $event"
          >
            <el-option
              v-for="opt in ERROR_STRATEGIES"
              :key="opt"
              :label="t('errorStrategy.' + opt)"
              :value="opt"
            />
          </el-select>
        </div>
        <template v-if="isModelNode">
          <div class="wf-inline" style="margin-bottom:6px">
            <el-switch :model-value="!!retry?.enabled" size="small" :disabled="readonly" @update:model-value="setRetry('enabled', $event)" />
            <span class="wf-field__label">{{ t('panel.retry') }}</span>
          </div>
          <div v-if="retry?.enabled" class="wf-inline wf-inline--full">
            <el-input-number
              :model-value="retry?.max_retries ?? 3"
              size="small"
              :min="1"
              :max="10"
              controls-position="right"
              @update:model-value="setRetry('max_retries', $event as number)"
            />
            <span class="wf-field__label">{{ t('panel.retryInterval') }}</span>
            <el-input-number
              :model-value="retry?.retry_interval ?? 1000"
              size="small"
              :min="100"
              :step="100"
              controls-position="right"
              @update:model-value="setRetry('retry_interval', $event as number)"
            />
          </div>
        </template>

        <details class="wf-raw">
          <summary>{{ t('panel.rawData') }}</summary>
          <pre class="scoll">{{ rawJson }}</pre>
        </details>
      </div>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, shallowRef, watch, type Component } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from './locales'
import GenericProperties from '@/workflow/nodes/GenericProperties.vue'
import { getNodeOutputs, getNodePanel, validateNode, type NodeOutputDeclaration } from '@/workflow/nodes/registry'
import { getNodePresentation } from '@/workflow/nodes/presentation'
import { isPrivateNodeType, type BaseNodeData, type ConversationVariable, type DslEdge, type DslNode, type EnvironmentVariable, type ErrorStrategy } from '@/workflow/dsl/types'
import './panel.css'

const props = defineProps<{
  data?: BaseNodeData
  nodeId: string
  nodes: DslNode[]
  edges: DslEdge[]
  environmentVariables: EnvironmentVariable[]
  conversationVariables: ConversationVariable[]
  readonly?: boolean
}>()

const emit = defineEmits<{
  /** 节点配置变化（用于上层刷新画布显示） */
  (e: 'change'): void
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const ERROR_STRATEGIES: ErrorStrategy[] = ['terminated', 'continue-on-error', 'remove-abnormal-output']

const presentation = computed(() => getNodePresentation(String(props.data?.type ?? '')))
const typeLabel = computed(() => {
  const key = presentation.value.labelKey
  return key ? t(key) : String(props.data?.type ?? '')
})
const isPrivate = computed(() => isPrivateNodeType(String(props.data?.type ?? '')))
const isModelNode = computed(() => String(props.data?.type ?? '') === 'llm')

const errorStrategy = computed(() => props.data?.error_strategy ?? 'terminated')
const retry = computed(() => props.data?.retry_config as BaseNodeData['retry_config'])

const outputs = computed<NodeOutputDeclaration[]>(() => (props.data ? getNodeOutputs(props.data) : []))
const issues = computed<string[]>(() => (props.data ? validateNode(props.data) : []))

const rawJson = computed(() => {
  try {
    return JSON.stringify(props.data ?? {}, null, 2)
  } catch {
    return ''
  }
})

const panelComponent = shallowRef<Component | null>(null)

/** 切换节点类型时换面板组件（未知/未实现类型回落到通用面板） */
watch(
  () => props.data?.type,
  (type) => {
    const loader = type ? getNodePanel(type) : undefined
    panelComponent.value = loader ? defineAsyncComponent(loader) : null
  },
  { immediate: true },
)

// 节点配置变化时通知上层（面板内部是原地修改，靠深度 watcher 也能发现，这里只做即时反馈）
watch(() => JSON.stringify(props.data ?? {}), () => emit('change'))

const panelProps = computed(() => ({
  data: props.data as BaseNodeData,
  nodeId: props.nodeId,
  nodes: props.nodes,
  edges: props.edges,
  environmentVariables: props.environmentVariables,
  conversationVariables: props.conversationVariables,
}))

function setRetry(key: string, value: unknown): void {
  const data = props.data as unknown as Record<string, unknown>
  if (!data.retry_config || typeof data.retry_config !== 'object') data.retry_config = {}
  ;(data.retry_config as Record<string, unknown>)[key] = value
}
</script>

<style scoped>
/* 面板外壳：底色 / 边线 / 文字全部走 --wf-*（跟随 APP 主题） */
.wf-props {
  display: flex;
  flex-direction: column;
  width: 320px;
  flex: 0 0 320px;
  border-left: 1px solid var(--wf-border);
  background: var(--wf-surface);
  color: var(--wf-text);
  overflow: hidden;
}

.wf-props__empty {
  padding: 24px 12px;
  color: var(--wf-text-dim);
  font-size: 12px;
  text-align: center;
}

.wf-props__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--wf-border);
}

.wf-props__icon {
  font-family: FontAwesome;
  font-size: 15px;
  /* 主色由节点类型注入（--node-color），朝主题文字色靠拢保证可读 */
  color: color-mix(in srgb, var(--node-color, var(--wf-text-dim)) 82%, var(--wf-text));
}

.wf-props__titles {
  flex: 1;
  min-width: 0;
}

.wf-props__type {
  color: var(--wf-text);
  font-size: 13px;
  font-weight: 600;
}

.wf-props__id {
  overflow: hidden;
  color: var(--wf-text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-props__body {
  flex: 1;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.wf-issues {
  margin-bottom: 10px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--wf-danger-bg);
}

.wf-issues__item {
  color: var(--wf-danger);
  font-size: 11px;
  line-height: 1.6;
}

.wf-outputs {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.wf-outputs td {
  padding: 3px 4px;
  border-bottom: 1px solid var(--wf-border-soft);
}

.wf-outputs__name {
  color: var(--wf-text);
  font-family: Consolas, Monaco, monospace;
}

.wf-outputs__type {
  color: var(--wf-text-dim);
  text-align: right;
}

.wf-raw {
  margin-top: 14px;
  color: var(--wf-text-dim);
  font-size: 11px;
}

.wf-raw pre {
  max-height: 220px;
  margin: 6px 0 0;
  padding: 6px;
  border-radius: 6px;
  background: var(--wf-sunken);
  color: var(--wf-text-soft);
  font-size: 11px;
  overflow: auto;
}
</style>
