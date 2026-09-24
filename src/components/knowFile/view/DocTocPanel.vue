<!--
  DocTocPanel.vue — 左侧目录面板（浏览 / 源码编辑 / 块编辑 三视图共用）

  结构、样式、交互完全按「浏览视图 md_read」的目录来做（.nav.resize + .toc-resizer +
  .left-panel-head + .left-scroll + .toc-tree，含祖先层级竖线 .toc-line 与连接符 .toc-connector），
  三个视图不再各写一份。

  对外只暴露「数据 + 事件」：目录项、当前高亮项、开合与宽度（v-model:open / v-model:width，
  持久化留在各宿主自己的 localStorage key 上，避免出现两个宽度来源）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'
import type { TocFlatItem } from '@/lib/markdown/toc'

const props = withDefaults(
  defineProps<{
    /** 是否展开（v-model:open） */
    open: boolean
    /** 面板宽度 px（v-model:width） */
    width: number
    /** 目录项（扁平结构，见 lib/markdown/toc.ts） */
    items: TocFlatItem[]
    /** 当前高亮项 id（滚动联动由宿主算好传进来） */
    activeId?: number | null
    /** 容器太窄时置 false → 自动收起（宿主按容器宽度判断） */
    usable?: boolean
    /** 面板标题，默认「目录」 */
    title?: string
    /** 没有标题时的提示文案 */
    emptyText?: string
    /** 目录项 tooltip（默认用 item.text；PDF 视图用来追加页码） */
    itemTitle?: ((item: TocFlatItem) => string) | null
    /** 目录项是否置灰不可跳转（PDF 视图：书签没有页码也没有外链） */
    itemDisabled?: ((item: TocFlatItem) => boolean) | null
    minWidth?: number
    maxWidth?: number
    /** 宿主底部状态栏是「绝对定位覆盖」时置 true：面板按 24px 让位（浏览视图的布局如此） */
    reserveStatusbar?: boolean
  }>(),
  {
    activeId: null,
    usable: true,
    title: '',
    emptyText: '',
    itemTitle: null,
    itemDisabled: null,
    minWidth: 140,
    maxWidth: 560,
    reserveStatusbar: false,
  }
)

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'update:width', v: number): void
  (e: 'select', id: number): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const visible = computed(() => props.open && props.usable)
const panelTitle = computed(() => props.title || (zh.value ? '目录' : 'Contents'))
const empty = computed(() => props.emptyText || (zh.value ? '（文档里还没有标题）' : '(No headings yet)'))
const rootStyle = computed(() => ({
  width: props.width + 'px',
  height: props.reserveStatusbar ? 'calc(100% - 24px)' : '100%',
}))

/** 拖动调宽：mousemove 跟随，钳制在 [minWidth, maxWidth]，宽度交回宿主持久化 */
let moveHandler: ((e: MouseEvent) => void) | null = null
let upHandler: (() => void) | null = null
function startResize(e: MouseEvent) {
  const startX = e.clientX
  const startW = props.width
  moveHandler = (ev: MouseEvent) => {
    emit('update:width', Math.max(props.minWidth, Math.min(props.maxWidth, startW + (ev.clientX - startX))))
  }
  upHandler = () => {
    if (moveHandler) window.removeEventListener('mousemove', moveHandler)
    if (upHandler) window.removeEventListener('mouseup', upHandler)
    moveHandler = null
    upHandler = null
    document.body.style.userSelect = ''
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', moveHandler)
  window.addEventListener('mouseup', upHandler)
}
onBeforeUnmount(() => upHandler?.())
</script>

<template>
  <div v-if="visible" class="nav resize" :style="rootStyle">
    <div class="toc-resizer" @mousedown.prevent.stop="startResize" :title="zh ? '拖动调整宽度' : 'Drag to resize'"></div>

    <div class="left-body">
      <div class="left-panel-head">
        <span class="left-panel-title"><i class="fa fa-bars"></i> {{ panelTitle }}</span>
        <button class="left-panel-close" :title="zh ? '关闭目录' : 'Close TOC'" @click="emit('update:open', false)">
          <i class="fa fa-times"></i>
        </button>
      </div>

      <div class="left-scroll scoll">
        <div v-if="!items.length" class="toc-empty">{{ empty }}</div>
        <ul v-else class="toc-tree">
          <li
            v-for="item in items"
            :key="item.id"
            class="toc-tree-item"
            :class="{ active: activeId === item.id }"
            :style="{ paddingLeft: item.depth * 18 + 'px' }"
            :title="itemTitle ? itemTitle(item) : item.text"
            @click="emit('select', item.id)"
          >
            <!-- 祖先层级竖线：第 k 层竖线位于 x = (k+1)*18，与各层连接符的竖线对齐 -->
            <span
              v-for="(ancestorIsLast, k) in item.parentLasts"
              :key="'line' + k"
              class="toc-line"
              :class="{ 'toc-line-blank': ancestorIsLast }"
              :style="{ left: (k + 1) * 18 + 'px' }"
            ></span>
            <!-- 当前节点连接符 -->
            <span
              class="toc-connector"
              :class="item.isLast ? 'toc-connector-last' : 'toc-connector-mid'"
            ></span>
            <a
              class="toc-link"
              :class="['toc-depth-' + item.depth, { 'toc-link-disabled': itemDisabled ? itemDisabled(item) : false }]"
              :href="item.href || undefined"
              target="_self"
              @click.prevent="emit('select', item.id)"
            >{{ item.text }}</a>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 面板外壳（与浏览视图 md_read 的 .nav 一致） ===== */
.nav {
  position: relative;
  flex: 0 0 auto;
  border-right: 1px solid var(--borderColor);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--backgroundColor);
}
.nav::-webkit-scrollbar { display: none; }

.toc-resizer {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
  user-select: none;
}
.toc-resizer:hover { background: rgba(128, 128, 128, 0.15); }

.left-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.left-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
  font-size: 13px;
  color: var(--fontColor);
}
.left-panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.left-panel-title i { font-size: 12px; opacity: 0.8; }
.left-panel-close {
  width: auto;
  padding: 0 6px;
  background: none;
  border: none;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}
.left-panel-close:hover { color: #e74c3c; }
.left-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.toc-empty {
  padding: 8px;
  font-size: 12px;
  color: var(--fontColor);
  opacity: 0.6;
}

/* ===== 目录树（完全复刻浏览视图） ===== */
.toc-tree {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  font-size: 13px;
}
.toc-tree-item {
  display: flex;
  align-items: center;
  height: 28px;
  line-height: 28px;
  padding-right: 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  position: relative;
  transition: background-color 0.15s;
}
.toc-tree-item:hover {
  background-color: var(--menuColor);
  color: var(--fontActiveColor);
}
.toc-tree-item:hover .toc-link { color: var(--fontActiveColor); }
.toc-tree-item.active { background-color: var(--menuColor); }

/* 祖先层级竖线：绝对定位（不占布局宽度，层级缩进完全由 li 的 paddingLeft 决定） */
.toc-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px solid var(--borderColor);
  pointer-events: none;
}
.toc-line-blank { border-left-color: transparent; }

.toc-connector {
  display: inline-block;
  width: 18px;
  height: 100%;
  flex-shrink: 0;
  position: relative;
}
.toc-connector::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 18px;
  height: 50%;
  border-bottom: 1px solid var(--borderColor);
  border-left: 1px solid var(--borderColor);
}
.toc-connector-last::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 18px;
  height: 50%;
  border-left: 0;
}
.toc-connector-mid::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 18px;
  height: 50%;
  border-left: 1px solid var(--borderColor);
}

.toc-link {
  display: inline-block;
  color: var(--fontColor);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 4px;
  flex: 1;
  min-width: 0;
}
.toc-link:hover { color: var(--fontActiveColor); }
.toc-link.active {
  color: var(--fontActiveColor);
  font-weight: 600;
}
/* 不可跳转的目录项（如 PDF 书签既没有页码也没有外链） */
.toc-link-disabled { opacity: 0.55; }
.toc-depth-0 { font-weight: 600; }
</style>
