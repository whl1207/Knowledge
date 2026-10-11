<!-- src/features/workflow/ui/VariableSelector.vue -->
<!-- 变量选择器：Dify 界面的核心控件。点选「上游节点输出 / 系统变量 / 环境变量 / 会话变量」写入 value_selector -->
<template>
  <el-popover
    :visible="open"
    placement="bottom-start"
    :width="320"
    trigger="click"
    popper-class="wf-var-popover"
    @hide="open = false"
  >
    <template #reference>
      <button type="button" class="wf-var-trigger" :class="{ 'is-empty': !display }" :disabled="disabled" @click="open = !open">
        <span class="wf-var-trigger__text" :title="display">{{ display || placeholder }}</span>
        <span v-if="display && !disabled" class="wf-var-trigger__clear" @click.stop="clear">×</span>
        <span class="wf-var-trigger__arrow">▾</span>
      </button>
    </template>

    <div class="wf-var-menu">
      <input v-model="keyword" class="wf-var-menu__search" :placeholder="t('var.search')" />
      <div class="wf-var-menu__list scoll">
        <template v-for="group in filteredGroups" :key="group.key">
          <div class="wf-var-menu__group">{{ groupLabel(group) }}</div>
          <button
            v-for="option in group.options"
            :key="group.key + '.' + option.name"
            type="button"
            class="wf-var-menu__item"
            @click="pick(option)"
          >
            <span class="wf-var-menu__name">{{ option.name }}</span>
            <span class="wf-var-menu__type">{{ option.type }}</span>
          </button>
        </template>
        <div v-if="!filteredGroups.length" class="wf-var-menu__empty">{{ t('var.empty') }}</div>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElPopover } from 'element-plus'
import { usestore } from '@/store'
import type { ConversationVariable, DslEdge, DslNode, EnvironmentVariable, ValueSelector } from '@/features/workflow/dsl/types'
import { createFlowT } from './locales'
import { buildVariableGroups, describeSelector, type VariableGroup, type VariableOption } from './variables'

const props = withDefaults(defineProps<{
  modelValue?: ValueSelector
  nodes: DslNode[]
  edges: DslEdge[]
  currentNodeId?: string
  environmentVariables?: EnvironmentVariable[]
  conversationVariables?: ConversationVariable[]
  placeholder?: string
  disabled?: boolean
  /** 选完即收起并清空显示（用于「插入到文本光标处」的场景） */
  insertMode?: boolean
}>(), {
  placeholder: '',
  disabled: false,
  insertMode: false,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: ValueSelector): void
  (e: 'pick', option: VariableOption): void
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const open = ref(false)
const keyword = ref('')

const groups = computed<VariableGroup[]>(() => buildVariableGroups({
  nodes: props.nodes,
  edges: props.edges,
  currentNodeId: props.currentNodeId,
  environmentVariables: props.environmentVariables,
  conversationVariables: props.conversationVariables,
}))

const namespaceLabels = computed<Record<string, string>>(() => ({
  sys: t('var.namespace.sys'),
  env: t('var.namespace.env'),
  conversation: t('var.namespace.conversation'),
  rag: t('var.namespace.rag'),
}))

const filteredGroups = computed<VariableGroup[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return groups.value
  return groups.value
    .map((group) => ({
      ...group,
      options: group.options.filter(
        (o) => o.name.toLowerCase().includes(kw) || group.label.toLowerCase().includes(kw),
      ),
    }))
    .filter((group) => group.options.length > 0)
})

const display = computed(() => {
  if (props.insertMode) return ''
  const selector = props.modelValue
  if (!selector || selector.length < 2) return ''
  return describeSelector(selector, props.nodes, namespaceLabels.value)
})

function groupLabel(group: VariableGroup): string {
  if (group.key in namespaceLabels.value) return namespaceLabels.value[group.key]
  return group.label
}

function pick(option: VariableOption): void {
  emit('pick', option)
  if (!props.insertMode) emit('update:modelValue', [...option.selector])
  open.value = false
  keyword.value = ''
}

function clear(): void {
  emit('update:modelValue', [])
  open.value = false
}

watch(open, (value) => {
  if (!value) keyword.value = ''
})
</script>

<style scoped>
/* 触发器沿用全局 input/button 主题（不写死颜色），只调尺寸；菜单项配色走 --wf-* */
.wf-var-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 6px;
  border: 1px solid var(--wf-border);
  border-radius: 6px;
  background: var(--wf-surface);
  color: var(--wf-text);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  margin: 0;
}

.wf-var-trigger:hover:not(:disabled) {
  border-color: var(--wf-accent);
}

.wf-var-trigger.is-empty {
  color: var(--wf-text-dim);
}

.wf-var-trigger:disabled {
  background: var(--wf-sunken);
  cursor: not-allowed;
}

.wf-var-trigger__text {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.wf-var-trigger__clear,
.wf-var-trigger__arrow {
  color: var(--wf-text-dim);
  flex: 0 0 auto;
}

.wf-var-trigger__clear:hover {
  color: var(--wf-danger);
}

.wf-var-menu__search {
  width: 100%;
  box-sizing: border-box;
  margin: 0 0 6px;
  padding: 4px 6px;
  border: 1px solid var(--wf-border);
  border-radius: 4px;
  height: 26px;
  font-size: 12px;
}

.wf-var-menu__search:focus {
  border-color: var(--wf-accent);
}

.wf-var-menu__list {
  max-height: 260px;
  overflow: auto;
}

.wf-var-menu__group {
  padding: 4px 2px;
  color: var(--wf-text-dim);
  font-size: 11px;
  font-weight: 600;
}

.wf-var-menu__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 3px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--wf-text);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  margin: 0;
}

.wf-var-menu__item:hover {
  background: var(--wf-hover);
  color: var(--wf-accent-text);
}

.wf-var-menu__type {
  color: var(--wf-text-dim);
  font-size: 11px;
}

.wf-var-menu__empty {
  padding: 8px 2px;
  color: var(--wf-text-dim);
  font-size: 12px;
}
</style>
