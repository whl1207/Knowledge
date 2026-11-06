<!-- ModuleNav.vue — 知识库模块左侧分区导航（桌面宽屏） -->
<script setup lang="ts">
import type { NavGroup } from './moduleNavTypes'

const props = defineProps<{ groups: NavGroup[]; active: string }>()
defineEmits<{ (e: 'select', key: string): void }>()

function countText(n?: number): string {
  if (n == null) return ''
  return n.toLocaleString('zh-CN')
}
</script>

<template>
  <nav class="module-nav" role="tablist" :aria-label="'知识库分区'">
    <template v-for="(group, gi) in props.groups" :key="'g' + gi">
      <div v-if="group.label" class="mn-group">{{ group.label }}</div>
      <button
        v-for="item in group.items"
        :key="item.key"
        class="mn-item"
        :class="{ active: props.active === item.key, 'mn-bottom': item.key === 'set' }"
        role="tab"
        :aria-selected="props.active === item.key"
        :title="item.label"
        @click="$emit('select', item.key)"
      >
        <i class="fa" :class="item.icon"></i>
        <span class="mn-label">{{ item.label }}</span>
        <span v-if="item.count != null" class="mn-count">{{ countText(item.count) }}</span>
        <span v-if="item.dot" class="mn-dot" aria-hidden="true"></span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.module-nav {
  width: 190px;
  flex: 0 0 190px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 6px 8px;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--menuColor);
  border-right: 1px solid var(--borderColor);
  user-select: none;
}
.mn-group {
  margin: 10px 8px 3px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--fontColor);
  opacity: .5;
  white-space: nowrap;
}
.mn-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--fontColor);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}
.mn-item:hover {
  background: var(--menuActiveColor);
}
.mn-item.active {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: color-mix(in srgb, var(--fontActiveColor) 22%, transparent);
}
.mn-item i.fa {
  width: 16px;
  flex: 0 0 16px;
  text-align: center;
  font-size: 12px;
}
.mn-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mn-count {
  flex: 0 0 auto;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: .6;
}
.mn-item.active .mn-count {
  opacity: .85;
}
.mn-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: #d48806;
}
.mn-bottom {
  margin-top: auto;
}
</style>
