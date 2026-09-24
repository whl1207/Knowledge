<script setup lang="ts">
/**
 * BlockTypeMenu.vue — 块类型选择菜单
 *
 * 两处共用：
 *  1. 输入 `/` 唤起的斜杠菜单（items 经过过滤）
 *  2. 块左侧手柄下拉菜单里的「转换为」
 *
 * 纯展示组件，定位交给父级的容器样式。
 */
import type { BlockTypeItem } from '@/lib/blockeditor/blockTypes'

defineProps<{
  items: BlockTypeItem[]
  active: number
}>()

const emit = defineEmits<{
  (e: 'select', item: BlockTypeItem): void
  (e: 'hover', index: number): void
}>()
</script>

<template>
  <div class="btm scoll">
    <div v-if="!items.length" class="btm-empty">无匹配项</div>
    <ul v-else class="btm-list">
      <li
        v-for="(it, i) in items"
        :key="it.key"
        class="btm-item"
        :class="{ 'is-active': i === active }"
        @mouseenter="emit('hover', i)"
        @mousedown.prevent.stop="emit('select', it)"
      >
        <i :class="it.icon"></i>
        <span class="btm-label">{{ it.label }}</span>
        <span v-if="it.hint" class="btm-hint">{{ it.hint }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.btm {
  min-width: 168px;
  max-height: min(320px, 60vh);
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  padding: 4px;
  font-size: 13px;
  color: var(--fontColor);
}

.btm-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.btm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.btm-item i {
  width: 14px;
  font-size: 12px;
  opacity: 0.75;
  text-align: center;
}

.btm-item.is-active {
  background: var(--fontActiveColor);
  color: #fff;
}

.btm-item.is-active i {
  opacity: 1;
}

.btm-label {
  flex: 1;
}

.btm-hint {
  font-size: 11px;
  opacity: 0.55;
}

.btm-empty {
  padding: 6px 8px;
  opacity: 0.6;
}
</style>
