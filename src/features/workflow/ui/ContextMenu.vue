<!-- src/features/workflow/ui/ContextMenu.vue -->
<!-- 画布 / 节点的右键菜单容器（点击外部或 Esc 关闭） -->
<template>
  <Teleport to="body">
    <div v-if="open" class="wf-ctx" :style="{ left: x + 'px', top: y + 'px' }" @contextmenu.prevent>
      <div v-for="(item, index) in items" :key="index">
        <div v-if="item.divider" class="wf-ctx__divider" />
        <button
          v-else
          type="button"
          class="wf-ctx__item"
          :class="{ 'is-danger': item.danger, 'is-disabled': item.disabled }"
          :disabled="item.disabled"
          @click="run(item)"
        >
          <span class="wf-ctx__label">{{ item.label }}</span>
          <span v-if="item.children" class="wf-ctx__arrow">›</span>
        </button>
        <div v-if="item.children && item === activeParent" class="wf-ctx__sub scoll">
          <slot name="sub" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ContextMenuItem } from './contextMenuTypes'

const props = defineProps<{
  open: boolean
  x: number
  y: number
  items: ContextMenuItem[]
}>()

const emit = defineEmits<{
  (e: 'pick', key: string): void
  (e: 'close'): void
}>()

/** 鼠标悬停展开子菜单的那一项 */
const hoveredKey = ref('')
const activeParent = computed(() => props.items.find((item) => item.key === hoveredKey.value && item.children))

function run(item: ContextMenuItem): void {
  if (item.disabled) return
  if (item.children) {
    hoveredKey.value = hoveredKey.value === item.key ? '' : item.key
    return
  }
  emit('pick', item.key)
}

function onPointerDown(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('.wf-ctx')) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
/* 右键菜单：与 APP 弹层（el-popover / el-select 下拉）同底同边线，配色走 --wf-* */
.wf-ctx {
  position: fixed;
  z-index: 3000;
  min-width: 160px;
  padding: 4px;
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  background: var(--wf-surface);
  box-shadow: var(--wf-shadow);
  color: var(--wf-text);
  font-size: 12px;
}

.wf-ctx__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--wf-text);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  margin: 0;
}

.wf-ctx__item:hover:not(.is-disabled) {
  background: var(--wf-hover);
  color: var(--wf-accent-text);
}

.wf-ctx__item.is-danger {
  color: var(--wf-danger);
}

.wf-ctx__item.is-danger:hover:not(.is-disabled) {
  background: var(--wf-danger-bg);
  color: var(--wf-danger);
}

.wf-ctx__item.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.wf-ctx__divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--wf-border-soft);
}

.wf-ctx__arrow {
  color: var(--wf-text-dim);
}

.wf-ctx__sub {
  position: absolute;
  left: 100%;
  top: 0;
  max-height: calc(60vh / var(--ui-zoom, 1));
  margin-left: 2px;
  padding: 4px;
  border: 1px solid var(--wf-border);
  border-radius: 8px;
  background: var(--wf-surface);
  box-shadow: var(--wf-shadow);
  overflow: auto;
}
</style>
