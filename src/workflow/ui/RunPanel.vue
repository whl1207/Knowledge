<!-- src/workflow/ui/RunPanel.vue -->
<!-- 运行面板：输入表单 → 运行 / 中止 → 节点状态 / 日志 / 最终输出 -->
<template>
  <aside class="wf-panel wf-run">
    <header class="wf-panel__head">
      <span class="wf-panel__title">{{ t('run.title') }}</span>
      <span class="wf-run__status" :class="`is-${state.status}`">{{ statusLabel }}</span>
      <span v-if="state.elapsedMs !== undefined" class="wf-panel__meta">{{ state.elapsedMs }}ms</span>
      <button class="wf-icon-btn" :title="t('run.close')" @click="$emit('close')"><i class="fa fa-times"></i></button>
    </header>

    <div class="wf-panel__body scoll">
      <div v-if="history.length" class="wf-field">
        <div class="wf-field__label">{{ t('run.history') }}</div>
        <el-select :model-value="viewRunId" size="small" style="width:100%" @update:model-value="viewRunId = $event">
          <el-option :label="t('run.historyLatest')" value="" />
          <el-option
            v-for="entry in history"
            :key="entry.id"
            :label="formatHistoryLabel(entry)"
            :value="entry.id"
          />
        </el-select>
      </div>

      <template v-if="startVariables.length">
        <div class="wf-section-title">{{ t('run.inputs') }}</div>
        <div v-for="variable in startVariables" :key="variable.variable" class="wf-field">
          <div class="wf-field__label">
            {{ variable.label || variable.variable }}
            <span v-if="variable.required" class="wf-run__required">*</span>
          </div>
          <el-switch
            v-if="variable.type === 'checkbox'"
            :model-value="!!inputs[variable.variable]"
            size="small"
            :disabled="state.running || readonly"
            @update:model-value="inputs[variable.variable] = $event"
          />
          <el-select
            v-else-if="variable.type === 'select'"
            :model-value="String(inputs[variable.variable] ?? '')"
            size="small"
            style="width:100%"
            :disabled="state.running || readonly"
            @update:model-value="inputs[variable.variable] = $event"
          >
            <el-option v-for="option in variable.options ?? []" :key="option" :label="option" :value="option" />
          </el-select>
          <el-input-number
            v-else-if="variable.type === 'number'"
            :model-value="typeof inputs[variable.variable] === 'number' ? (inputs[variable.variable] as number) : undefined"
            size="small"
            controls-position="right"
            style="width:100%"
            :disabled="state.running || readonly"
            @update:model-value="inputs[variable.variable] = $event"
          />
          <el-input
            v-else
            :model-value="String(inputs[variable.variable] ?? '')"
            :type="variable.type === 'paragraph' || variable.type === 'json_object' || variable.type === 'json' ? 'textarea' : 'text'"
            :rows="3"
            size="small"
            :disabled="state.running || readonly"
            :placeholder="variable.placeholder || variable.label"
            @update:model-value="setInput(variable.variable, $event, variable.type)"
          />
        </div>
      </template>
      <div v-else class="wf-empty-hint">{{ t('run.noInputs') }}</div>

      <div class="wf-panel__actions">
        <button v-if="!state.running" class="wf-btn wf-btn--primary" :disabled="readonly" @click="$emit('run', { ...inputs })">
          <i class="fa fa-play"></i> {{ t('run.start') }}
        </button>
        <button v-else class="wf-btn" @click="$emit('stop')"><i class="fa fa-stop"></i> {{ t('run.stop') }}</button>
      </div>

      <div v-if="displayState.error" class="wf-panel__error"><i class="fa fa-exclamation-triangle"></i> {{ displayState.error }}</div>

      <div v-if="traceRows.length" class="wf-section-title"><i class="fa fa-list-ol"></i> {{ t('run.nodes') }}</div>
      <div
        v-for="row in traceRows"
        :key="row.record.nodeId"
        class="wf-run__node"
        :class="[`is-${row.record.status}`, row.depth > 0 ? 'is-child' : '']"
      >
        <div class="wf-run__node-head" @click="toggle(row.record.nodeId)">
          <i class="fa wf-run__node-icon" :class="statusIcon(row.record.status)"></i>
          <span class="wf-run__node-title">{{ row.record.title }}</span>
          <span v-if="row.record.elapsedMs !== undefined" class="wf-panel__meta">{{ row.record.elapsedMs }}ms</span>
          <span class="wf-run__node-status">{{ statusText(row.record.status) }}</span>
          <span v-if="row.record.attempts && row.record.attempts > 1" class="wf-tag">{{ row.record.attempts }}x</span>
          <span class="wf-run__caret">{{ expanded[row.record.nodeId] ? '−' : '+' }}</span>
        </div>
        <div v-if="expanded[row.record.nodeId]" class="wf-run__node-body">
          <div v-if="row.record.streamed" class="wf-run__stream scoll">{{ row.record.streamed }}</div>
          <pre v-else-if="row.record.outputs" class="wf-run__pre scoll">{{ pretty(row.record.outputs) }}</pre>
          <div v-else-if="row.record.error" class="wf-panel__error">{{ row.record.error }}</div>
          <div v-else class="wf-empty-hint">{{ t('run.noOutputs') }}</div>
        </div>
      </div>

      <template v-if="hasOutputs">
        <div class="wf-section-title"><i class="fa fa-sign-out"></i> {{ t('run.outputs') }}</div>
        <pre class="wf-run__pre scoll">{{ pretty(displayState.outputs) }}</pre>
      </template>

      <template v-if="displayState.logs.length">
        <div class="wf-section-title"><i class="fa fa-terminal"></i> {{ t('run.logs') }}</div>
        <div class="wf-run__logs scoll">
          <div v-for="log in displayState.logs" :key="log.id" class="wf-run__log" :class="`is-${log.level}`">
            <i class="fa" :class="logIcon(log.level)"></i> {{ log.message }}
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from './locales'
import type { NodeRunRecord, RunStatus } from '@/workflow/engine/types'
import type { DslDocument, StartVariable } from '@/workflow/dsl/types'
import { buildTraceRows, type RunHistoryEntry, type RunUiState } from './runState'

const props = defineProps<{
  document: DslDocument | null
  state: RunUiState
  /** 历史运行（最近若干次，最新在前） */
  history?: RunHistoryEntry[]
  readonly?: boolean
}>()

defineEmits<{
  (e: 'run', inputs: Record<string, unknown>): void
  (e: 'stop'): void
  (e: 'close'): void
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const inputs = reactive<Record<string, unknown>>({})
const expanded = reactive<Record<string, boolean>>({})
/** 当前查看的运行：'' = 最新（实时） */
const viewRunId = ref('')

const history = computed(() => props.history ?? [])

/** 选择历史时展示该次快照，否则展示实时状态 */
const displayState = computed<RunUiState>(() => {
  if (!viewRunId.value) return props.state
  const entry = history.value.find((item) => item.id === viewRunId.value)
  if (!entry) return props.state
  return {
    status: entry.status,
    running: false,
    records: entry.records,
    logs: entry.logs,
    outputs: entry.outputs,
    error: entry.error,
    elapsedMs: entry.elapsedMs,
  }
})

/** 开始节点声明的输入变量 */
const startVariables = computed<StartVariable[]>(() => {
  const nodes = props.document?.workflow.graph.nodes ?? []
  const start = nodes.find((n) => String(n.data.type) === 'start' || String(n.data.type) === 'start-placeholder')
  if (!start) return []
  const raw = (start.data as unknown as Record<string, unknown>).variables
  return Array.isArray(raw) ? (raw as StartVariable[]) : []
})

/** 追踪树（容器子节点缩进） */
const traceRows = computed(() => buildTraceRows(props.document, displayState.value.records))

const hasOutputs = computed(() => Object.keys(displayState.value.outputs ?? {}).length > 0)

const statusLabel = computed(() => statusText(displayState.value.status as RunStatus))

function formatHistoryLabel(entry: RunHistoryEntry): string {
  const time = new Date(entry.at).toLocaleTimeString()
  const seconds = entry.elapsedMs !== undefined ? ` · ${entry.elapsedMs}ms` : ''
  return `${time} · ${statusText(entry.status)}${seconds}`
}

function statusText(status: string): string {
  const map: Record<string, string> = {
    idle: t('run.status.idle'),
    running: t('run.status.running'),
    success: t('run.status.success'),
    error: t('run.status.error'),
    aborted: t('run.status.aborted'),
    skipped: t('run.status.skipped'),
  }
  return map[status] ?? status
}

/** 节点状态图标（FA4） */
function statusIcon(status: string): string {
  const map: Record<string, string> = {
    running: 'fa-circle-o-notch fa-spin',
    success: 'fa-check-circle',
    error: 'fa-times-circle',
    aborted: 'fa-ban',
    skipped: 'fa-minus-circle',
  }
  return map[status] ?? 'fa-clock-o'
}

/** 日志级别图标 */
function logIcon(level: string): string {
  if (level === 'error') return 'fa-times-circle'
  if (level === 'warning') return 'fa-exclamation-triangle'
  return 'fa-info-circle'
}

function toggle(nodeId: string): void {
  expanded[nodeId] = !expanded[nodeId]
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * 输入赋值：JSON 类变量把文本解析成对象/数组（跑迭代这类节点时才拿得到真正的数组），
 * 解析失败时保留原文本，由节点自己给出可读报错。
 */
function setInput(name: string, value: string, type: string): void {
  if ((type === 'json_object' || type === 'json' || type === 'file-list' || type === 'files' || type === 'contexts') && value.trim()) {
    try {
      inputs[name] = JSON.parse(value)
      return
    } catch {
      inputs[name] = value
      return
    }
  }
  inputs[name] = value
}

/** 供父组件预填输入（重新打开面板时保留上次输入） */
const prefilled = ref(false)
function prefill(): void {
  if (prefilled.value) return
  for (const variable of startVariables.value) {
    const value = (variable as unknown as Record<string, unknown>).default
    if (value !== undefined && inputs[variable.variable] === undefined) inputs[variable.variable] = value
  }
  prefilled.value = true
}
prefill()
</script>

<style scoped>
/* 运行面板：与属性面板同底同边线，配色沿用 --wf-* */
/* 面板外壳（.wf-panel）与按钮样式见全局 panel.css，这里只写运行面板专属样式 */
.wf-run__status.is-running {
  color: var(--wf-running);
}

.wf-run__status.is-success {
  color: var(--wf-success);
}

.wf-run__status.is-error {
  color: var(--wf-danger);
}

.wf-run__status {
  font-size: 11px;
}

.wf-run__required {
  color: var(--wf-danger);
}

.wf-run__node {
  border-bottom: 1px solid var(--wf-border-soft);
}

.wf-run__node.is-child {
  margin-left: 12px;
  border-left: 2px solid var(--wf-border);
  padding-left: 6px;
}

.wf-run__node-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 2px;
  cursor: pointer;
  font-size: 12px;
}

.wf-run__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--wf-skipped);
  flex: 0 0 auto;
}

/* 节点状态的图标（运行中 / 成功 / 失败 / 跳过） */
.wf-run__node-icon {
  width: 12px;
  flex: 0 0 auto;
  font-size: 12px;
  text-align: center;
  color: var(--wf-skipped);
}

.wf-run__node-icon.is-running {
  color: var(--wf-running);
}

.wf-run__node-icon.is-success {
  color: var(--wf-success);
}

.wf-run__node-icon.is-error {
  color: var(--wf-danger);
}

.wf-run__node-icon.is-skipped {
  color: var(--wf-skipped);
}

.wf-run__dot.is-running {
  background: var(--wf-running);
}

.wf-run__dot.is-success {
  background: var(--wf-success);
}

.wf-run__dot.is-error {
  background: var(--wf-danger);
}

.wf-run__dot.is-skipped {
  background: var(--wf-skipped);
}

.wf-run__node-title {
  flex: 1;
  overflow: hidden;
  color: var(--wf-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-run__node-status {
  color: var(--wf-text-dim);
  font-size: 11px;
}

.wf-run__caret {
  color: var(--wf-text-dim);
}

.wf-run__node-body {
  padding: 4px 2px 8px 15px;
}

.wf-run__stream {
  max-height: 180px;
  padding: 6px;
  border-radius: 6px;
  background: var(--wf-sunken);
  color: var(--wf-text-soft);
  font-size: 11px;
  line-height: 1.6;
  overflow: auto;
  white-space: pre-wrap;
}

.wf-run__pre {
  max-height: 200px;
  margin: 0;
  padding: 6px;
  border-radius: 6px;
  background: var(--wf-sunken);
  color: var(--wf-text-soft);
  font-size: 11px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.wf-run__logs {
  max-height: 240px;
  overflow: auto;
}

.wf-run__log {
  padding: 2px 0;
  color: var(--wf-text-soft);
  font-size: 11px;
  line-height: 1.6;
  word-break: break-word;
}

.wf-run__log.is-warning {
  color: var(--wf-warning);
}

.wf-run__log.is-error {
  color: var(--wf-danger);
}
</style>
