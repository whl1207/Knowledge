<script setup lang="ts">
/**
 * BlockTable.vue — 表格块的单元格编辑器
 *
 * 只编辑单元格，不暴露整表源码：
 *  - 每格一个 input；表头/数据行结构由模型维护（列数自动对齐）
 *  - 行柄 / 列柄：拖动换序，点击弹出菜单（插入 / 移动 / 删除）
 *  - 右侧「+」加列，底部「+ 行」加行
 *  - Esc 退出编辑态（回到渲染视图）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  moveCol,
  moveRow,
  parseTable,
  serializeTable,
  setCell,
  type TableData,
} from '@/lib/blockeditor/table'

const props = defineProps<{
  /** 表格块的行数组（Markdown 源码） */
  lines: string[]
  zh: boolean
  /** 进入编辑前从渲染态表格量到的列宽：固定它才能和预览宽度一致 */
  colWidths?: number[]
  /** 进入编辑时要聚焦的单元格（点击预览表格的哪一格） */
  focusTarget?: { row: number; col: number } | null
}>()

const emit = defineEmits<{
  (e: 'change', lines: string[]): void
  (e: 'exit'): void
}>()

const table = ref<TableData>(parseTable(props.lines))

function currentLines(): string[] {
  return serializeTable(table.value)
}

const signature = () => currentLines().join('\n')

// 外部（撤销 / 换文件）改动才回灌，避免覆盖正在输入的内容
watch(
  () => props.lines.join('\n'),
  (v) => {
    if (v !== signature()) table.value = parseTable(props.lines)
  }
)

function emitChange(): void {
  emit('change', currentLines())
}

/** 对齐方式 → CSS */
type TextAlign = 'left' | 'right' | 'center'

function alignOf(col: number): TextAlign {
  const a = table.value.aligns[col] ?? ''
  const left = a.startsWith(':')
  const right = a.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'left'
}

function onCell(row: number, col: number, e: Event): void {
  setCell(table.value, row, col, (e.target as HTMLInputElement).value)
  emitChange()
}

// --- 行列操作菜单 ----------------------------------------------------------

const menu = reactive({
  open: false,
  x: 0,
  y: 0,
  kind: 'row' as 'row' | 'col',
  index: -1,
})

function clamp(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - 176)),
    y: Math.max(8, Math.min(y, window.innerHeight - 220)),
  }
}

function openMenu(kind: 'row' | 'col', index: number, e: MouseEvent): void {
  e.stopPropagation()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const pos = clamp(r.left, r.bottom + 4)
  menu.open = true
  menu.kind = kind
  menu.index = index
  menu.x = pos.x
  menu.y = pos.y
}

interface MenuOp {
  key: string
  label: string
  icon: string
  danger?: boolean
}

const menuOps = computed<MenuOp[]>(() => {
  const zh = props.zh
  if (menu.kind === 'row') {
    return [
      { key: 'insert-before', label: zh ? '在上方插入行' : 'Insert row above', icon: 'fa fa-arrow-up' },
      { key: 'insert-after', label: zh ? '在下方插入行' : 'Insert row below', icon: 'fa fa-arrow-down' },
      { key: 'move-up', label: zh ? '上移' : 'Move up', icon: 'fa fa-angle-up' },
      { key: 'move-down', label: zh ? '下移' : 'Move down', icon: 'fa fa-angle-down' },
      { key: 'delete', label: zh ? '删除行' : 'Delete row', icon: 'fa fa-trash-o', danger: true },
    ]
  }
  return [
    { key: 'insert-before', label: zh ? '在左侧插入列' : 'Insert column left', icon: 'fa fa-arrow-left' },
    { key: 'insert-after', label: zh ? '在右侧插入列' : 'Insert column right', icon: 'fa fa-arrow-right' },
    { key: 'move-left', label: zh ? '左移' : 'Move left', icon: 'fa fa-angle-left' },
    { key: 'move-right', label: zh ? '右移' : 'Move right', icon: 'fa fa-angle-right' },
    { key: 'delete', label: zh ? '删除列' : 'Delete column', icon: 'fa fa-trash-o', danger: true },
  ]
})

function runOp(key: string): void {
  const i = menu.index
  const d = table.value
  if (menu.kind === 'row') {
    if (key === 'insert-before') insertRow(d, i)
    else if (key === 'insert-after') insertRow(d, i + 1)
    else if (key === 'move-up') moveRow(d, i, Math.max(0, i - 1))
    else if (key === 'move-down') moveRow(d, i, Math.min(d.rows.length - 1, i + 1))
    else if (key === 'delete') deleteRow(d, i)
  } else {
    if (key === 'insert-before') insertCol(d, i)
    else if (key === 'insert-after') insertCol(d, i + 1)
    else if (key === 'move-left') moveCol(d, i, Math.max(0, i - 1))
    else if (key === 'move-right') moveCol(d, i, Math.min(d.header.length - 1, i + 1))
    else if (key === 'delete') deleteCol(d, i)
  }
  menu.open = false
  emitChange()
}

// --- 拖动换行 / 换列 -------------------------------------------------------

const dragRow = ref(-1)
const dragCol = ref(-1)
/** 插入位置提示：index 为参照行列，after 表示插到它后面 */
const dropRow = reactive({ index: -1, after: false })
const dropCol = reactive({ index: -1, after: false })

function onRowDragStart(i: number, e: DragEvent): void {
  dragRow.value = i
  e.dataTransfer?.setData('text/plain', String(i))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onRowDragOver(i: number, e: DragEvent): void {
  if (dragRow.value < 0) return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropRow.index = i
  dropRow.after = e.clientY > r.top + r.height / 2
}

function onRowDrop(i: number): void {
  const from = dragRow.value
  const boundary = dropRow.after ? i + 1 : i
  // boundary 是「插入缝隙」下标，换算成删除后的目标下标
  const to = boundary > from ? boundary - 1 : boundary
  if (from >= 0 && to !== from) {
    moveRow(table.value, from, to)
    emitChange()
  }
  clearDrop()
}

function onColDragStart(i: number, e: DragEvent): void {
  dragCol.value = i
  e.dataTransfer?.setData('text/plain', String(i))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onColDragOver(i: number, e: DragEvent): void {
  if (dragCol.value < 0) return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropCol.index = i
  dropCol.after = e.clientX > r.left + r.width / 2
}

function onColDrop(i: number): void {
  const from = dragCol.value
  const boundary = dropCol.after ? i + 1 : i
  const to = boundary > from ? boundary - 1 : boundary
  if (from >= 0 && to !== from) {
    moveCol(table.value, from, to)
    emitChange()
  }
  clearDrop()
}

function clearDrop(): void {
  dragRow.value = -1
  dragCol.value = -1
  dropRow.index = -1
  dropCol.index = -1
}

function addRow(): void {
  insertRow(table.value, table.value.rows.length)
  emitChange()
}

function addCol(): void {
  insertCol(table.value, table.value.header.length)
  emitChange()
}

/**
 * 「添加列」按钮位置：优先贴表格右侧留白（与表头同一高度）。
 * 表格宽度拉满时右侧放不下，若继续夹在右边缘会盖住末列的列柄（无法点开列菜单），
 * 因此改为移到表格下方右侧（与底部左角的「添加行」对称）。
 */
const addColStyle = computed(() => {
  const BTN = 18
  const GAP = 3
  const natural = tableNaturalWidth.value
  const cw = tableSize.cw
  if (cw <= 0 || cw - natural >= BTN + GAP) return { left: natural + GAP + 'px', top: '0px' }
  return { left: Math.max(cw - BTN, 0) + 'px', top: tableSize.h + GAP + 'px' }
})

// --- 列宽 / 行位置量化（浮动控件与固定列宽都靠它） --------------------------

const tableRef = ref<HTMLTableElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const rowTops = ref<number[]>([])
const rowHeights = ref<number[]>([])
/** 表格高度 + 可视宽度：浮动按钮与横向滚动判断都靠它 */
const tableSize = reactive({ h: 0, cw: 0 })

/** 默认列宽（没能从预览态量到时用） */
const DEFAULT_COL_WIDTH = 120

function colCount(): number {
  return table.value.header.length
}

/** 某一列的实际像素宽 */
function colWidth(ci: number): number {
  const w = props.colWidths?.[ci]
  return Math.max(w && w > 0 ? w : DEFAULT_COL_WIDTH, 40)
}

/** 始终用固定布局，这样列宽与预览一致，不会被内容均分或塌陷 */
function colWidthAt(ci: number): string {
  return colWidth(ci) + 'px'
}

/**
 * 表格自然宽 = 各列宽之和。
 * 不能用 offsetWidth：table-layout: fixed + width: auto 时浏览器会把「表格盒子」压到可用宽度，
 * 列却按 colgroup 溢出盒子，于是「比容器宽」根本判断不出来，横向滚动也就打不开。
 */
const tableNaturalWidth = computed(() => {
  let sum = 0
  for (let i = 0; i < colCount(); i++) sum += colWidth(i)
  return sum
})

/** 只有表格真的比可视宽度还宽时才允许横向滚动，否则一律不出滑块（留 2px 容差） */
const needsScrollX = computed(
  () => tableSize.cw > 0 && tableNaturalWidth.value > tableSize.cw + 2
)

/** 行柄需要知道每一行的纵向位置，才能浮在块左侧留白处 */
function measure(): void {
  const t = tableRef.value
  if (!t) return
  tableSize.h = t.offsetHeight
  tableSize.cw = scrollRef.value?.clientWidth ?? 0
  const base = t.getBoundingClientRect().top
  const rows = Array.from(t.querySelectorAll<HTMLElement>('tbody tr'))
  rowTops.value = rows.map((r) => r.getBoundingClientRect().top - base)
  rowHeights.value = rows.map((r) => r.getBoundingClientRect().height)
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  nextTick(() => {
    measure()
    // 点哪一格就聚焦哪一格（键盘进入时默认第一格数据）
    const target = props.focusTarget ?? { row: 0, col: 0 }
    focusCell(target.row, target.col)
  })
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => measure())
    if (tableRef.value) resizeObserver.observe(tableRef.value)
    // 容器宽度变化也要重算（否则 needsScrollX 会停留在旧结论）
    if (scrollRef.value) resizeObserver.observe(scrollRef.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

watch(
  () => props.lines,
  () => nextTick(measure)
)

function closeMenu(): void {
  menu.open = false
}

// --- 单元格导航（Tab 跳格 / Enter 下方插入行） -----------------------------

const rootRef = ref<HTMLElement | null>(null)

function focusCell(row: number, col: number): void {
  const el = rootRef.value?.querySelector<HTMLInputElement>(`input[data-cell="${row},${col}"]`)
  if (!el) return
  el.focus()
  el.select()
}

/** 单元格遍历顺序：表头（row = -1）在前，然后逐行从左到右 */
function cellSequence(): Array<[number, number]> {
  const n = table.value.header.length
  const seq: Array<[number, number]> = []
  for (let c = 0; c < n; c++) seq.push([-1, c])
  table.value.rows.forEach((_, ri) => {
    for (let c = 0; c < n; c++) seq.push([ri, c])
  })
  return seq
}

/** Tab / Shift+Tab：跳到上下一个单元格；末尾再 Tab 自动新增一行 */
function onTab(row: number, col: number, e: KeyboardEvent): void {
  const seq = cellSequence()
  let idx = seq.findIndex(([r, c]) => r === row && c === col)
  if (idx < 0) idx = e.shiftKey ? seq.length : -1
  const next = idx + (e.shiftKey ? -1 : 1)
  if (next < 0) return
  if (next >= seq.length) {
    addRow()
    nextTick(() => focusCell(table.value.rows.length - 1, col))
    return
  }
  const [nr, nc] = seq[next]
  focusCell(nr, nc)
}

/** Enter：表头回车跳到第一行数据；数据行回车在下方插入一行同列 */
function onEnter(row: number, col: number): void {
  if (row < 0) {
    focusCell(0, col)
    return
  }
  insertRow(table.value, row + 1)
  emitChange()
  nextTick(() => focusCell(row + 1, col))
}
</script>

<template>
  <div ref="rootRef" class="bt-root" @keydown.esc="emit('exit')" @click="closeMenu" @dragend="clearDrop">
    <div class="bt-holder">
      <!-- 浮动行柄：落在块左侧已有的留白里，不新增表格列 -->
      <div class="bt-rowhandles">
        <span
          v-for="(row, ri) in table.rows"
          :key="ri"
          class="bt-grip bt-grip-row"
          :class="{ 'is-dragging': dragRow === ri }"
          :style="{ top: (rowTops[ri] ?? 0) + 'px', height: (rowHeights[ri] ?? 22) + 'px' }"
          draggable="true"
          :title="zh ? '拖动换行 / 点击菜单' : 'Drag / menu'"
          @dragstart="onRowDragStart(ri, $event)"
          @click="openMenu('row', ri, $event)"
        ><i class="fa fa-ellipsis-v"></i><i class="fa fa-ellipsis-v"></i></span>
      </div>

      <div ref="scrollRef" class="bt-scroll scoll" :class="{ 'bt-scrollable': needsScrollX }">
        <table ref="tableRef" class="bt bt-fixed" :style="{ width: tableNaturalWidth + 'px' }">
          <colgroup>
            <col v-for="ci in colCount()" :key="ci" :style="{ width: colWidthAt(ci - 1) }" />
          </colgroup>
          <thead>
            <tr>
              <th
                v-for="(_, ci) in table.header"
                :key="ci"
                :class="{
                  'bt-drop-before': dragCol >= 0 && dropCol.index === ci && !dropCol.after,
                  'bt-drop-after': dragCol >= 0 && dropCol.index === ci && dropCol.after,
                }"
                @dragover.prevent="onColDragOver(ci, $event)"
                @drop="onColDrop(ci)"
              >
                <input
                  class="bt-cell bt-th"
                  :data-cell="`${-1},${ci}`"
                  :style="{ textAlign: alignOf(ci) }"
                  :value="table.header[ci]"
                  :placeholder="zh ? `列 ${ci + 1}` : `Col ${ci + 1}`"
                  @input="onCell(-1, ci, $event)"
                  @keydown.tab.prevent="onTab(-1, ci, $event)"
                  @keydown.enter.prevent="onEnter(-1, ci)"
                />
                <span
                  class="bt-grip bt-grip-col"
                  draggable="true"
                  :title="zh ? '拖动换列 / 点击菜单' : 'Drag / menu'"
                  @dragstart="onColDragStart(ci, $event)"
                  @click="openMenu('col', ci, $event)"
                ><i class="fa fa-ellipsis-v"></i></span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, ri) in table.rows"
              :key="ri"
              :class="{
                'bt-dragging': dragRow === ri,
                'bt-drop-top': dragRow >= 0 && dropRow.index === ri && !dropRow.after,
                'bt-drop-bottom': dragRow >= 0 && dropRow.index === ri && dropRow.after,
              }"
              @dragover.prevent="onRowDragOver(ri, $event)"
              @drop="onRowDrop(ri)"
            >
              <td
                v-for="(cell, ci) in row"
                :key="ci"
                :class="{
                  'bt-drop-before': dragCol >= 0 && dropCol.index === ci && !dropCol.after,
                  'bt-drop-after': dragCol >= 0 && dropCol.index === ci && dropCol.after,
                }"
              >
                <input
                  class="bt-cell"
                  :data-cell="`${ri},${ci}`"
                  :style="{ textAlign: alignOf(ci) }"
                  :value="cell"
                  @input="onCell(ri, ci, $event)"
                  @keydown.tab.prevent="onTab(ri, ci, $event)"
                  @keydown.enter.prevent="onEnter(ri, ci)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 浮动加列 / 加行：绝对定位，不占表格整体布局空间 -->
      <button
        class="bt-add bt-add-col"
        :style="addColStyle"
        :title="zh ? '添加列' : 'Add column'"
        @click.stop="addCol"
      >
        <i class="fa fa-plus"></i>
      </button>
      <button
        class="bt-add bt-add-row"
        :style="{ top: tableSize.h + 3 + 'px' }"
        :title="zh ? '添加行' : 'Add row'"
        @click.stop="addRow"
      >
        <i class="fa fa-plus"></i>
      </button>
    </div>

    <!-- 行列操作菜单 -->
    <div v-if="menu.open" class="bt-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
      <div v-for="op in menuOps" :key="op.key" class="bt-menu-item" :class="{ 'is-danger': op.danger }" @mousedown.prevent="runOp(op.key)">
        <i :class="op.icon"></i>{{ op.label }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.bt-root {
  position: relative;
  margin: 2px 0;
}

.bt-holder {
  position: relative;
}

.bt-scroll {
  /* 默认不出滑块；确实放不下时（needsScrollX）才开启横向滚动 */
  overflow-x: hidden;
  /* 显式关掉纵向：否则纵向会被计算成 auto，无端占掉一条滚动条宽度 */
  overflow-y: hidden;
}

.bt-scroll.bt-scrollable {
  overflow-x: auto;
}

/* 滚动条样式沿用全局 .scoll（5px、menuColor 轨道、menuActiveColor 滑块） */

.bt {
  border-collapse: collapse;
  /* 跟随块编辑器状态栏的 A- / A+（默认基准 15px，表格略小用 0.93） */
  font-size: calc(var(--be-font, 15px) * 0.93);
  table-layout: auto;
}

/* 有渲染态量到的列宽时改为固定布局：各列宽 = 预览里的列宽，不再被均分 */
.bt.bt-fixed {
  table-layout: fixed;
}

.bt th,
.bt td {
  border: 1px solid var(--borderColor);
  padding: 0;
  position: relative;
  vertical-align: top;
}

/* 单元格输入：字号/内边距/行高与渲染态表格对齐，宽度才能吻合 */
.bt-cell {
  width: 100%;
  min-width: 0;
  /* 抵消全局 style.css 的 `input { margin:5px; height:27px; border-radius:5px }`：
     margin 会把输入框整体右移 5px、右侧溢出 5px（超出单元格），height 会把行撑高，
     border-radius 会让聚焦高亮出现圆角（表格单元格是直角） */
  margin: 0;
  height: auto;
  border-radius: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-family: inherit;
  /* 继承 .bt 的字号（input 默认不继承） */
  font-size: inherit;
  /* 与渲染态表格一致（.be-rendered 为 1.7），进入编辑态行高不跳 */
  line-height: 1.7;
  padding: 4px 10px;
  box-sizing: border-box;
}

.bt-cell:focus {
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
}

.bt-th {
  font-weight: 600;
  padding-right: 18px;
}

/* --- 浮动行柄：落在块左侧已有留白里 --- */
.bt-rowhandles {
  position: absolute;
  top: 0;
  left: -22px;
  width: 18px;
  bottom: 0;
  pointer-events: none;
  z-index: 2;
}

.bt-grip-row {
  position: absolute;
  left: 0;
  width: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  cursor: grab;
  color: var(--fontColor);
  font-size: 10px;
  letter-spacing: -3px;
  border-radius: 3px;
  pointer-events: auto;
}

.bt-grip-row:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--fontActiveColor) 16%, transparent);
}

.bt-rowhandles:hover .bt-grip-row {
  opacity: 0.5;
}

.bt-rowhandles:hover .bt-grip-row:hover {
  opacity: 1;
}

.bt-grip-row.is-dragging {
  opacity: 0.25 !important;
}

/* 列柄：贴单元格右上角 */
.bt-grip-col {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: var(--fontColor);
  opacity: 0;
  cursor: grab;
  border-radius: 3px;
}

.bt th:hover .bt-grip-col {
  opacity: 0.55;
}

.bt-grip-col:hover {
  opacity: 1 !important;
  background: color-mix(in srgb, var(--fontActiveColor) 16%, transparent);
}

/* --- 拖动定位反馈 --- */
tr.bt-dragging {
  opacity: 0.4;
}

tr.bt-drop-top td {
  box-shadow: inset 0 2px 0 0 var(--fontActiveColor);
}

tr.bt-drop-bottom td {
  box-shadow: inset 0 -2px 0 0 var(--fontActiveColor);
}

th.bt-drop-before,
td.bt-drop-before {
  box-shadow: inset 2px 0 0 0 var(--fontActiveColor);
}

th.bt-drop-after,
td.bt-drop-after {
  box-shadow: inset -2px 0 0 0 var(--fontActiveColor);
}

/* --- 浮动添加按钮（绝对定位，不占表格布局空间） --- */
.bt-add {
  position: absolute;
  width: 18px;
  height: 18px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--menuColor);
  color: var(--fontColor);
  opacity: 0;
  cursor: pointer;
  font-size: 10px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.12s ease;
  /* 需要盖在下一个块之上（加行按钮会浮到块下方） */
  z-index: 5;
}

.bt-holder:hover .bt-add {
  opacity: 0.7;
}

.bt-add:hover {
  opacity: 1 !important;
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}

.bt-add-col {
  top: 0;
}

.bt-add-row {
  left: 0;
}

/* 菜单 */
.bt-menu {
  position: fixed;
  z-index: 3500;
  min-width: 168px;
  padding: 4px;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  font-size: 13px;
  color: var(--fontColor);
}

.bt-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.bt-menu-item:hover {
  background: color-mix(in srgb, var(--fontActiveColor) 16%, transparent);
}

.bt-menu-item i {
  width: 14px;
  font-size: 12px;
  opacity: 0.75;
  text-align: center;
}

.bt-menu-item.is-danger {
  color: #e74c3c;
}
</style>
