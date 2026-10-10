<!-- src/workflow/ui/DifyNodeCard.vue -->
<!-- 画布节点卡片：所有 Dify 节点（含本地私有节点、容器）共用，差异由 data.type 驱动 -->
<template>
  <div
    class="dify-node"
    :class="{
      'is-selected': selected,
      'is-unknown': isUnknown,
      'is-container': isContainer,
      'is-container-entry': isContainerEntry,
    }"
    :style="{ '--node-color': color }"
  >
    <Handle v-if="!isContainerEntry" type="target" :position="Position.Left" id="target" />

    <!-- 容器（迭代 / 循环）没有分支端口，但需要右侧出口，否则「容器 → 下游」的连线会从卡片底部出去 -->
    <Handle v-if="isContainer" id="source" type="source" :position="Position.Right" />

    <div class="dify-node__header">
      <span class="dify-node__icon">{{ glyph }}</span>
      <span class="dify-node__title" :title="title">{{ title }}</span>
      <!-- 容器（迭代 / 循环）没有正文行，副标题与标题同行显示，避免挤占内部子节点 -->
      <span v-if="isContainer && summaryText" class="dify-node__inline" :title="summaryText">{{ summaryText }}</span>
      <span v-if="runStatus !== 'idle'" class="dify-node__run" :class="`is-${runStatus}`" :title="runStatusLabel" />
    </div>

    <div v-if="showBody" class="dify-node__body">
      <span class="dify-node__type" :title="subtitle">{{ subtitle }}</span>
      <span v-if="isUnknown" class="dify-node__badge">{{ t('flow.unknown_type') }}</span>
    </div>

    <div v-if="showBody && descLine" class="dify-node__desc" :title="descLine">{{ descLine }}</div>

    <!-- 容器节点（迭代 / 循环）右下角缩放手柄：手动调整容器大小 -->
    <div
      v-if="isContainer && !editorLocked"
      class="dify-node__resize"
      :title="t('flow.resizeNode')"
      @pointerdown="onResizeStart"
    />

    <!-- 分支端口：每个分支一个出口，标签显示在出口旁 -->
    <template v-if="branches.length > 1">
      <div
        v-for="(branch, index) in branches"
        :key="'label-' + branch.id"
        class="dify-node__branch-label"
        :style="{ top: branchTop(index) }"
      >
        {{ branch.label || branch.id }}
      </div>
    </template>

    <Handle
      v-for="(branch, index) in branches"
      :id="branch.id"
      :key="'handle-' + branch.id"
      type="source"
      :position="Position.Right"
      :style="branches.length > 1 ? { top: branchTop(index) } : undefined"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import { usestore } from '@/store'
import { getNodePresentation } from '@/workflow/nodes/presentation'
import { getNodeBranches, getNodeSummary } from '@/workflow/nodes/registry'
import { isContainerEntryType, isContainerType } from '@/workflow/dsl/container'
import { isKnownNodeType } from '@/workflow/dsl/types'
import { createFlowT } from './locales'
import { RUN_STATE_KEY, EDITOR_LOCK_KEY, recordStatus } from './runState'
import { CONTAINER_RESIZE_KEY } from './graphOps'
import type { DifyFlowNodeData } from './flowAdapter'

const props = defineProps<NodeProps<DifyFlowNodeData>>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')
const runState = inject(RUN_STATE_KEY, null)
const editorLocked = inject(EDITOR_LOCK_KEY, null)
const resizeHandle = inject(CONTAINER_RESIZE_KEY, null)

const dsl = computed(() => props.data.dsl)
const nodeType = computed(() => String(dsl.value.type))
const presentation = computed(() => getNodePresentation(nodeType.value))
const glyph = computed(() => presentation.value.glyph)
const color = computed(() => presentation.value.color)
const title = computed(() => dsl.value.title || nodeType.value)
const typeLabel = computed(() => {
  const key = presentation.value.labelKey
  return key ? t(key) : nodeType.value
})
const isUnknown = computed(() => !isKnownNodeType(nodeType.value))
const isContainer = computed(() => isContainerType(nodeType.value))
const isContainerEntry = computed(() => isContainerEntryType(nodeType.value))
const branches = computed(() => (isContainer.value ? [] : getNodeBranches(dsl.value)))

/**
 * 卡片副标题：优先显示该节点的关键配置（模型 / 变量 / 文件 …），
 * 没有摘要时退回节点说明，再退回类型名——与 Dify 卡片一致。
 */
const summaryText = computed(() => {
  const summary = getNodeSummary(dsl.value)
  if (!summary) return ''
  return 'text' in summary ? summary.text : t(summary.key, summary.params)
})
const subtitle = computed(() => summaryText.value || dsl.value.desc || typeLabel.value)
/** 容器与容器入口节点不显示正文/说明行（入口节点只有标题，容器靠标题行内的副标题） */
const showBody = computed(() => !isContainer.value && !isContainerEntry.value)
/** 摘要已表达核心配置时，节点说明另起一行小字展示 */
const descLine = computed(() => {
  const desc = dsl.value.desc || ''
  if (!desc || isContainerEntry.value) return ''
  return desc === subtitle.value ? '' : desc
})

const runStatus = computed(() => (runState ? recordStatus(runState.value, props.id) : 'idle'))
const runStatusLabel = computed(() => t('run.status.' + runStatus.value))

/** 分支端口的垂直位置：均匀分布 */
function branchTop(index: number): string {
  return `${Math.round(((index + 1) / (branches.value.length + 1)) * 100)}%`
}

/** 容器缩放手柄按下：交给编辑器接管指针（编辑器才知道画布缩放比例） */
function onResizeStart(event: PointerEvent): void {
  resizeHandle?.start(props.id, event)
}
</script>

<style scoped>
/* 配色全部走 theme.css 的 --wf-*（跟随 APP 主题）；--node-color 为节点类型主色、
   --node-accent 是其「随主题反相」版本（浅色主题加深、深色主题提亮） */
.dify-node {
  --node-color: var(--wf-text-dim);
  --node-accent: color-mix(in srgb, var(--node-color) 82%, var(--wf-text));
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 68px;
  box-sizing: border-box;
  border: 1px solid var(--wf-border);
  border-left: 3px solid var(--node-accent);
  border-radius: 8px;
  background: var(--wf-surface);
  box-shadow: var(--wf-shadow-sm);
  color: var(--wf-text);
  font-size: 13px;
  overflow: visible;
}

.dify-node.is-selected {
  border-color: var(--node-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--node-accent) 30%, transparent);
}

.dify-node.is-unknown {
  border-style: dashed;
  background: var(--wf-sunken);
}

/* 容器：半透明背景，子节点绘制在其上方 */
.dify-node.is-container {
  border-style: dashed;
  border-width: 2px;
  background: color-mix(in srgb, var(--node-accent) 8%, var(--wf-surface));
}

/* 缩放手柄：容器右下角的展开图标（FontAwesome，与节点图标同字体） */
.dify-node__resize {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  font-family: FontAwesome;
  font-size: 11px;
  color: var(--node-accent);
  cursor: nwse-resize;
  opacity: 0.5;
}

.dify-node__resize::before {
  content: '\f065';
}

.dify-node__resize:hover {
  opacity: 1;
}

.dify-node.is-container-entry {
  min-height: 34px;
  border-radius: 6px;
  background: var(--wf-surface);
  box-shadow: none;
}

.dify-node__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 4px;
}

.dify-node.is-container-entry .dify-node__header {
  padding: 6px 8px;
}

.dify-node__icon {
  font-family: FontAwesome;
  font-size: 13px;
  color: var(--node-accent);
}

.dify-node__title {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 600;
  color: var(--wf-text);
}

/* 容器节点的副标题（与标题同行，右对齐显示迭代变量 / 循环次数） */
.dify-node__inline {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--wf-text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dify-node__body {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 8px;
}

.dify-node__type {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--wf-text-dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 节点说明：摘要之外的补充信息，单独一行小字 */
.dify-node__desc {
  padding: 0 10px 8px;
  overflow: hidden;
  color: var(--wf-text-dim);
  font-size: 11px;
  line-height: 1.3;
  opacity: 0.85;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dify-node__badge {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--wf-warning-bg);
  color: var(--wf-warning);
  font-size: 11px;
}

.dify-node__branch-label {
  position: absolute;
  right: 8px;
  transform: translateY(-50%);
  padding: 0 4px;
  border-radius: 4px;
  background: var(--wf-sunken);
  color: var(--wf-text-soft);
  font-size: 10px;
  pointer-events: none;
}

.dify-node__run {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--wf-skipped);
}

.dify-node__run.is-running {
  background: var(--wf-running);
  animation: wf-node-pulse 1s ease-in-out infinite;
}

.dify-node__run.is-success {
  background: var(--wf-success);
}

.dify-node__run.is-error {
  background: var(--wf-danger);
}

.dify-node__run.is-skipped {
  background: var(--wf-skipped);
}

@keyframes wf-node-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
