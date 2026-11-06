<!-- SectionListPage.vue — 窄屏一级页面：知识库分区列表（点一项进二级页面） -->
<script setup lang="ts">
import type { NavGroup } from './moduleNavTypes'

const props = defineProps<{ groups: NavGroup[]; active: string; zh: boolean }>()
defineEmits<{ (e: 'select', key: string): void }>()

function countText(n?: number): string {
  if (n == null) return ''
  return n.toLocaleString('zh-CN')
}
</script>

<template>
  <div class="section-list-page">
    <div class="slp-scroll">
      <template v-for="(group, gi) in props.groups" :key="'g' + gi">
        <div v-if="group.label" class="slp-group">{{ group.label }}</div>
        <button
          v-for="item in group.items"
          :key="item.key"
          class="slp-item"
          :class="{ active: props.active === item.key }"
          @click="$emit('select', item.key)"
        >
          <i class="fa" :class="item.icon"></i>
          <span class="slp-label">{{ item.label }}</span>
          <span v-if="item.count != null" class="slp-count">{{ countText(item.count) }}</span>
          <span v-if="item.dot" class="slp-dot" aria-hidden="true"></span>
          <i class="fa fa-angle-right slp-arrow" aria-hidden="true"></i>
        </button>
      </template>
      <div class="slp-hint">{{ props.zh ? '选择分区后进入对应页面' : 'Pick a section to open it' }}</div>
    </div>
  </div>
</template>

<style scoped>
.section-list-page {
  flex: 1;
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--backgroundColor);
  display: flex;
  justify-content: center;
}
.slp-scroll {
  width: min(560px, calc(100% - 20px));
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 4px 0 20px;
}
.slp-group {
  margin: 10px 8px 3px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--fontColor);
  opacity: .5;
}
.slp-item {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  padding: 0 10px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  color: var(--fontColor);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, transform .08s ease;
}
.slp-item:active {
  transform: scale(.995);
  background: var(--menuActiveColor);
}
.slp-item.active {
  border-color: var(--fontActiveColor);
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.slp-item i.fa {
  width: 16px;
  flex: 0 0 16px;
  text-align: center;
  font-size: 13px;
}
.slp-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slp-count {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  opacity: .6;
}
.slp-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: #d48806;
}
.slp-arrow {
  flex: 0 0 auto;
  width: 11px !important;
  font-size: 11px !important;
  opacity: .45;
}
.slp-hint {
  margin: 14px 8px 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--fontColor);
  opacity: .45;
}
</style>
