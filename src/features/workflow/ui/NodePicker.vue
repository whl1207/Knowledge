<!-- src/features/workflow/ui/NodePicker.vue -->
<!-- 节点选择器：按分组列出可选节点（工具栏「添加节点」与画布右键菜单共用） -->
<template>
  <div class="wf-picker">
    <input v-model="keyword" class="wf-picker__search" :placeholder="t('picker.search')" />
    <div class="wf-picker__list scoll">
      <template v-for="group in filteredGroups" :key="group.key">
        <div class="wf-picker__group">{{ t(group.labelKey) }}</div>
        <button
          v-for="type in group.types"
          :key="type"
          type="button"
          class="wf-picker__item"
          :class="{ 'is-disabled': disabled.includes(type) }"
          :disabled="disabled.includes(type)"
          @click="pick(type)"
        >
          <span class="wf-picker__icon" :style="{ '--node-color': presentation(type).color, '--node-glyph-weight': String(presentation(type).weight || 900) }">{{ presentation(type).glyph }}</span>
          <span class="wf-picker__label">{{ t(presentation(type).labelKey) }}</span>
          <span v-if="!isNodeImplemented(type)" class="wf-picker__tag">{{ t('picker.generic') }}</span>
          <span v-if="isPrivate(type)" class="wf-picker__tag is-private">{{ t('picker.local') }}</span>
        </button>
      </template>
      <div v-if="!filteredGroups.length" class="wf-picker__empty">{{ t('picker.empty') }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { usestore } from '@/store'
import { createFlowT } from './locales'
import { NODE_PICKER_GROUPS, isNodeImplemented, type NodePickerGroup } from '@/features/workflow/nodes/registry'
import { getNodePresentation } from '@/features/workflow/nodes/presentation'
import { isPrivateNodeType } from '@/features/workflow/dsl/types'

const props = withDefaults(defineProps<{
  /** 不可选的类型（例如已存在的开始 / 结束节点） */
  disabled?: string[]
}>(), {
  disabled: () => [],
})

const emit = defineEmits<{
  (e: 'pick', type: string): void
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const keyword = ref('')

const presentation = (type: string) => getNodePresentation(type)
const isPrivate = (type: string) => isPrivateNodeType(type)

const filteredGroups = computed<NodePickerGroup[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return NODE_PICKER_GROUPS
  return NODE_PICKER_GROUPS
    .map((group) => ({
      ...group,
      types: group.types.filter((type) => {
        const def = presentation(type)
        const label = t(def.labelKey).toLowerCase()
        return type.toLowerCase().includes(kw) || label.includes(kw)
      }),
    }))
    .filter((group) => group.types.length > 0)
})

function pick(type: string): void {
  if (props.disabled.includes(type)) return
  emit('pick', type)
}
</script>

<style scoped>
/* 节点选择器：作为 el-popover 的内容渲染，配色走 --wf-*，与下拉菜单一致 */
.wf-picker {
  /* 宽度交给 el-popover 的内容区（固定宽度会撑破弹层），只保底一个最小宽度 */
  width: 100%;
  min-width: 220px;
  box-sizing: border-box;
  color: var(--wf-text);
}

.wf-picker__search {
  width: 100%;
  box-sizing: border-box;
  margin: 0 0 6px;
  padding: 4px 6px;
  border: 1px solid var(--wf-border);
  border-radius: 4px;
  height: 26px;
  font-size: 12px;
}

.wf-picker__search:focus {
  border-color: var(--wf-accent);
}

.wf-picker__list {
  max-height: 320px;
  overflow: auto;
}

.wf-picker__group {
  padding: 4px 2px;
  color: var(--wf-text-dim);
  font-size: 11px;
  font-weight: 600;
}

.wf-picker__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 4px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--wf-text);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  margin: 0;
}

.wf-picker__item:hover:not(.is-disabled) {
  background: var(--wf-hover);
  color: var(--wf-accent-text);
}

.wf-picker__item.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.wf-picker__icon {
  flex: 0 0 14px;
  /* 每节点字形：字族走 FA5，字重由节点类型注入（线框节点 400 / 实心 900，见 presentation.ts） */
  font-family: 'Font Awesome 5 Free';
  font-weight: var(--node-glyph-weight, 900);
  font-size: 12px;
  text-align: center;
  /* 主色由节点类型注入（--node-color），朝主题文字色靠拢保证深浅主题都可读 */
  color: color-mix(in srgb, var(--node-color, var(--wf-text-dim)) 82%, var(--wf-text));
}

.wf-picker__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-picker__tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--wf-surface-2);
  color: var(--wf-text-soft);
  font-size: 10px;
  white-space: nowrap;
}

.wf-picker__tag.is-private {
  background: var(--wf-warning-bg);
  color: var(--wf-warning);
}

.wf-picker__empty {
  padding: 10px 2px;
  color: var(--wf-text-dim);
  font-size: 12px;
}
</style>
