<script setup lang="ts">
/**
 * BlockEditor.vue — 自研 Markdown 块编辑器
 *
 * 设计（与 Edit_Block.vue 讨论确定）：
 *  - Markdown 是唯一存储；块内**纯源码**编辑（textarea），不做行内 WYSIWYG
 *  - 扁平块 + indent 层级；块下标与 DOM `data-index` 严格一一对应（解决「拖动行不对应」）
 *  - 内容即源码，不需要 contenteditable ↔ markdown 双向同步（解决「编辑后对应不上」）
 *  - mermaid / 表格 / 公式 / 图片的预览复用本软件自己的渲染链路（解决「渲染不一致」）
 *
 * 对外 API（imperative）：
 *   getText() / setText(md) / focus() / appendText(text) / insertMarkdownAtCaret(md)
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { usestore } from '@/store'
import {
  LIST_TYPES,
  createBlock,
  indentWidth,
  type Block,
  type BlockProps,
  type BlockType,
  type ParsedDoc,
} from '@/lib/blockeditor/types'
import { parseMarkdown } from '@/lib/blockeditor/parse'
import { serializeMarkdown } from '@/lib/blockeditor/serialize'
import {
  appendText as cmdAppendText,
  blockText,
  bodyOf,
  contentText,
  enterBlocks,
  indentSubtree,
  mergeBackward,
  mergeForward,
  moveBlocks,
  nudgeBlock,
  prefixFor,
  prefixOf,
  removeBlock,
  setBlockType,
  setCodeLang,
  setContentText,
  setBlockText,
  toggleTodo,
  type Caret,
} from '@/lib/blockeditor/doc'
import { SnapshotHistory, type Snapshot } from '@/lib/blockeditor/history'
import { buildBlockTypeItems, type BlockTypeItem } from '@/lib/blockeditor/blockTypes'
// 公式段落（\[…\] / 裸环境，块类型仍是段落）按公式块对待：Monaco 编辑、不参与文本映射
import { formulaParagraph, isFormulaBlock, formulaEditText, formulaSource, setFormulaText } from '@/lib/blockeditor/formula'
import { renderMarkdown, escapeHtml } from '@/lib/markdown/render'
import { plainHeadingText, flattenHeadingLevels, loadDocTocWidth, saveDocTocWidth, loadDocTocOpen, saveDocTocOpen, DOC_TOC_MIN_WIDTH, DOC_TOC_MAX_WIDTH, type TocFlatItem } from '@/lib/markdown/toc'
import { loadDocChatWidth, saveDocChatWidth, DOC_CHAT_MIN_WIDTH, DOC_CHAT_MAX_WIDTH } from '@/lib/knowFile/panelWidths'
import DocTocPanel from '@/components/knowFile/view/DocTocPanel.vue'
import { renderInlineMarkdown, renderParagraphMarkdown } from '@/lib/markdown/inline'
import { renderMermaidSvgLenient } from '@/lib/markdown/mermaid'
import BlockTypeMenu from './BlockTypeMenu.vue'
import BlockTable from './BlockTable.vue'
import MermaidViewer from '@/components/MermaidViewer.vue'
import DocChatPanel from '@/components/knowFile/view/DocChatPanel.vue'
import { typesetRoot, scheduleTypeset, installTypesetCopyFix } from '@/lib/typeset'

// Monaco 体积很大：代码块用它编辑，但只有真的点进代码块时才需要加载，
// 所以拆成异步组件（避免打开知识管理就把 Monaco 拉下来）
const BlockCode = defineAsyncComponent(() => import('./BlockCode.vue'))

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const props = withDefaults(
  defineProps<{
    /** Markdown 文本（受控输入：外部更新时通过 watch 同步进来） */
    value: string
    /** 当前文件路径：变化时视为切换文件 */
    path?: string
    /** 文档标识（如条目 id）：变化时重建文档并重置撤销栈 */
    docKey?: string
    /** 图片相对路径的解析基准目录 */
    basePath?: string
    placeholder?: string
    /** 未保存标记（保存由父组件负责，所以状态也从父组件传进来） */
    dirty?: boolean
    /**
     * 状态栏右侧的语音输入按钮（可选）。
     * 只负责显示：图标 / 提示 / 是否高亮 / 是否禁用，真正的录音逻辑在父组件；
     * 点击时 emit('asr-toggle')。不传则不显示该按钮。
     */
    asr?: { icon: string; title: string; active?: boolean; disabled?: boolean } | null
  }>(),
  { path: '', docKey: '', basePath: '', placeholder: '', asr: null }
)

const emit = defineEmits<{
  (e: 'change', md: string): void
  (e: 'save'): void
  (e: 'drop-files', payload: { files: File[]; index: number }): void
  (e: 'asr-toggle'): void
}>()

// --- 状态 ------------------------------------------------------------------

const rootRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const doc = ref<ParsedDoc>(parseMarkdown(props.value || ''))
const blocks = computed(() => doc.value.blocks)

const history = new SnapshotHistory()
/** 正在编辑（显示源码）的块 id；null 表示全部处于渲染态 */
const editingId = ref<string | null>(null)
/** 渲染态 HTML 缓存（按块 id），避免每次重渲染都跑一遍 markdown */
const blockHtml = reactive(new Map<string, string>())
const blockSig = new Map<string, string>()
/** 上一次刷新时处于编辑态的块（用于在编辑态切换时把这一块也纳入局部刷新） */
let lastEditingId: string | null = null

const activeIndex = ref(0)
let suppressExternal = false
/** 正在做首次/切文档的大渲染（大文件下是同步长任务）→ 盖一层「正在渲染」占位符，避免白屏 */
const rendering = ref(false)

// --- 基础工具 --------------------------------------------------------------

function textareaEl(id: string): HTMLTextAreaElement | null {
  return rootRef.value?.querySelector<HTMLTextAreaElement>(`textarea[data-id="${id}"]`) ?? null
}

function blockEl(id: string): HTMLElement | null {
  return rootRef.value?.querySelector<HTMLElement>(`.be-block[data-id="${id}"]`) ?? null
}

function dividerEl(id: string): HTMLElement | null {
  return rootRef.value?.querySelector<HTMLElement>(`.be-divider[data-id="${id}"]`) ?? null
}

/** textarea 自增高。
 * 高度必须与渲染态（.be-rendered）一致，否则点进编辑态块高会跳一下（整篇内容跟着位移）：
 *  · 单行/无折行时用「行数 × 行高」算 —— 行高常是小数（标题 32.13px），而 scrollHeight 只给整数，会差 1px；
 *  · 有折行时退回 scrollHeight（折行后的视觉行数只有浏览器知道）；
 *  · 最小值取 .be-rendered 的 min-height（26px），空块两边同高。
 * 注意 .be-textarea 是 border-box，所以 height = 内容高 + 上下内边距。
 */
const RENDERED_MIN_HEIGHT = 26
function grow(el: HTMLTextAreaElement) {
  const cs = getComputedStyle(el)
  const lh = parseFloat(cs.lineHeight) || 0
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
  // 先复位：height 还是旧值时 scrollHeight 会停在旧高度（内容变短就缩不回去）
  el.style.height = 'auto'
  const scrollContent = el.scrollHeight - pad
  const exactContent = el.value.split('\n').length * lh
  const contentH = Math.abs(scrollContent - exactContent) < 1 ? exactContent : scrollContent
  el.style.height = Math.max(contentH + pad, RENDERED_MIN_HEIGHT) + 'px'
}

/** textarea 显示的值：代码块只显示内容（围栏由模型隐式维护）；公式类块显示公式正文 */
function editableText(b: Block): string {
  if (b.type === 'code') return contentText(b)
  const ft = formulaEditText(b)
  if (ft !== null) return ft
  return blockText(b)
}

/** 把快照写回模型（撤销/重做用） */
function applySnapshot(s: Snapshot) {
  doc.value = parseMarkdown(s.md)
  ensurePlaceholderBlock()
  blockHtml.clear()
  blockSig.clear()
  editingId.value = null
  const idx = Math.max(0, Math.min(s.index, doc.value.blocks.length - 1))
  scheduleStats()
  refreshRendered(true)
  nextTick(() => focusBlock(idx, s.offset))
}

function currentSnapshot(label: string, md: string): Snapshot {
  const el = document.activeElement as HTMLElement | null
  let index = activeIndex.value
  let offset = 0
  if (el && el.tagName === 'TEXTAREA' && el.hasAttribute('data-id')) {
    const id = el.getAttribute('data-id')!
    const i = doc.value.blocks.findIndex((b) => b.id === id)
    if (i >= 0) {
      index = i
      offset = (el as HTMLTextAreaElement).selectionStart ?? 0
    }
  }
  return { md, index, offset, label }
}

/** 提交一次改动：记录历史 + 通知外部 + 刷新预览 */
function commit(label: string, opts: { focus?: Caret | null; coalesce?: boolean } = {}) {
  if (!opts.coalesce) history.breakCoalesce()
  const md = serializeMarkdown(doc.value)
  history.commit(currentSnapshot(label, md))
  emit('change', md)
  if (opts.focus) focusBlock(opts.focus.index, opts.focus.offset)
  // 连续输入时只有当前块在变（且它正在编辑、会被跳过），无需全量刷新
  if (!opts.coalesce) refreshRendered()
  selfDirty.value = true
  scheduleStats()
}

function ensurePlaceholderBlock() {
  if (doc.value.blocks.length === 0) {
    doc.value.blocks.push(createBlock('paragraph'))
    doc.value.leadingBlank = 0
    doc.value.trailingNewline = false
  }
}

function loadFrom(md: string, resetHistory = true) {
  doc.value = parseMarkdown(md || '')
  ensurePlaceholderBlock()
  blockHtml.clear()
  blockSig.clear()
  editingId.value = null
  activeIndex.value = 0
  if (resetHistory) {
    history.reset({ md: serializeMarkdown(doc.value), index: 0, offset: 0, label: 'open' })
  }
  selfDirty.value = false
  scheduleStats()
  refreshRendered(true)
}

/**
 * 带占位符的装载：大文件下「解析 + 建全篇 HTML + 两端对齐排版」是一段同步长任务，
 * 不让出主线程的话，打开/切文件时就是一片白屏。这里先把占位符渲染上屏（等一帧），
 * 再做重活，结束后移除占位符。
 */
function loadFromWithPlaceholder(md: string, resetHistory = true) {
  rendering.value = true
  // 用 setTimeout 而不是 rAF：后台/隐藏窗口里 rAF 可能永不触发（会卡住不加载）
  window.setTimeout(() => {
    loadFrom(md, resetHistory)
    // 等渲染 + 后处理（排版/手柄）刷完再撤占位符
    nextTick(() => nextTick(() => { rendering.value = false }))
  }, 40)
}

// --- 光标 ------------------------------------------------------------------

/** 表格块进入编辑态前，从渲染态表格量到的列宽（保证编辑态与预览宽度一致） */
const tableColWidths = reactive(new Map<string, number[]>())

function captureTableColWidths(b: Block) {
  if (b.type !== 'table') return
  const table = rootRef.value?.querySelector<HTMLElement>(`.be-block[data-id="${b.id}"] .be-rendered table`)
  if (!table) return
  const rects = Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((th) =>
    th.getBoundingClientRect()
  )
  // 用「相邻列的 left 差」当作列宽，而不是单元格自身宽度：
  // border-collapse 下相邻单元格共享边框，累加宽度会比整表宽出好几像素 →
  // 固定到表格上就会超出容器，凭空多出横向滑块
  const widths: number[] = []
  for (let i = 0; i < rects.length; i++) {
    const w = i + 1 < rects.length ? rects[i + 1].left - rects[i].left : rects[i].width
    const rounded = Math.round(w)
    if (rounded > 0) widths.push(rounded)
  }
  if (widths.length) tableColWidths.set(b.id, widths)
}

/**
 * 聚焦某个块。
 * offset < 0 表示光标落到块末尾；分割线等无输入框的块聚焦容器本身。
 */
function focusBlock(index: number, offset: number) {
  const b = doc.value.blocks[index]
  if (!b) return
  const toEnd = offset < 0
  activeIndex.value = index

  if (b.type === 'divider') {
    editingId.value = null
    refreshRendered()
    nextTick(() => {
      const el = dividerEl(b.id)
      if (el) {
        el.focus()
        scrollIntoViewIfNeeded(el)
      }
    })
    return
  }

  // 进入表格块前先量下预览态的列宽（重新渲染后这个 DOM 就没了）
  if (editingId.value !== b.id) captureTableColWidths(b)
  editingId.value = b.id
  // 刚离开的那个块（内容被改过但渲染缓存还是旧的）需要在这里重建
  refreshRendered()
  nextTick(() => {
    const el = textareaEl(b.id)
    if (!el) return
    el.focus()
    const off = toEnd ? el.value.length : Math.min(offset, el.value.length)
    el.setSelectionRange(off, off)
    grow(el)
    scrollIntoViewIfNeeded(el)
  })
}

/** 点击渲染态 → 进入该块的编辑态 */
function startEdit(index: number) {
  const b = doc.value.blocks[index]
  if (!b) return
  focusBlock(index, -1)
  // 代码 / 公式（Monaco）与表格是异步铺开的，刚切过去量不到首行 → 稍后补量几次
  // 只补量这一块（手柄槽高只取决于块内首行，不必整篇重算）
  const id = b.id
  ;[80, 260].forEach((d) => window.setTimeout(() => syncGutterHeights([id]), d))
}

/** 点表格预览时记下点中的是哪一格，进入编辑后直接聚焦它 */
const pendingTableCell = ref<{ id: string; row: number; col: number } | null>(null)

function resolveTableCell(blockId: string, target: HTMLElement) {
  const cell = target.closest('th, td') as HTMLTableCellElement | null
  if (!cell) return
  const rowEl = cell.parentElement as HTMLTableRowElement | null
  const inHead = cell.tagName === 'TH' || rowEl?.parentElement?.tagName === 'THEAD'
  let row = -1
  if (!inHead && rowEl?.parentElement) {
    row = Array.from(rowEl.parentElement.querySelectorAll('tr')).indexOf(rowEl)
  }
  pendingTableCell.value = { id: blockId, row, col: cell.cellIndex }
}

/** 渲染态里是否有非空选区（拖选文字用于复制/查词时，不应该切进编辑态） */
function hasRenderedSelection(): boolean {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false
  if (!sel.toString().trim()) return false
  // 只认编辑器内部的选区，避免别处残留的选区挡住「点击进入编辑」
  const node = sel.getRangeAt(0).commonAncestorContainer
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  return !!el && !!rootRef.value?.contains(el)
}

/** 渲染态点击：复选框就地勾选，链接放行，拖选文字时不进编辑（留给复制），其余进入编辑 */
function onRenderedClick(index: number, e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t instanceof HTMLInputElement && t.type === 'checkbox') {
    e.preventDefault()
    if (toggleTodo(doc.value, index)) commit('structure')
    return
  }
  if (t.closest('a')) return
  // 刚用鼠标拖选了一段文字（或用 Shift 扩选）：保持选区，不要跳进编辑态
  if (hasRenderedSelection()) return
  const b = doc.value.blocks[index]
  if (b?.type === 'table') resolveTableCell(b.id, t)
  startEdit(index)
}

// --- 渲染态「选中文字 → 删除」------------------------------------------------
// 渲染态是静态 HTML（非 contenteditable），浏览器不会对选区响应 Delete/Backspace，
// 于是「拖选一段文字（单块或跨块）后按删除」毫无反应，必须先点进某个块才能删 —— 很反直觉。
// 这里自己完成映射：DOM 选区 →（首/末块内的源码区间 + 中间整块），
// 再做「裁剪 + 合并」，并把光标落在删除处（与在编辑态删完继续打字的手感一致）。

/** 可以按「行内文本裁剪 + 相邻合并」处理的块类型 */
const MERGE_TYPES: BlockType[] = ['paragraph', 'heading', 'bullet', 'ordered', 'todo', 'quote']

/**
 * 渲染文本 → 源码偏移的映射（贪心前向匹配）。
 * 渲染态看不到 `**`、`- `、`](url)` 这些标记，所以逐个字符在源码里「往后找第一次出现」即可跳过标记；
 * 跳过全不对（表格 / mermaid / 数学公式等）就返回 null，由调用方按整块处理。
 * startAt：前缀块（`### `、`- [ ] `）从正文开始找，避免正文首字符被匹配到前缀里。
 */
function mapRenderedToSource(src: string, rendered: string, startAt = 0): number[] | null {
  const map = new Array<number>(rendered.length + 1)
  let si = Math.max(0, Math.min(startAt, src.length))
  for (let i = 0; i < rendered.length; i++) {
    const at = src.indexOf(rendered[i], si)
    if (at < 0) return null
    map[i] = at
    si = at + 1
  }
  map[rendered.length] = si
  return map
}

/** 块内承载「正文」的渲染容器（列表圆点 / 待办复选框不算正文，否则偏移整体错位） */
function renderedTextHost(blockEl: HTMLElement): HTMLElement | null {
  const r = blockEl.querySelector<HTMLElement>('.be-rendered')
  if (!r) return null
  return r.querySelector<HTMLElement>('.be-li-text, .be-todo-text') ?? r
}

/** 选区边界点 → 该容器文本里的字符偏移（边界落在容器外则钳到首/尾） */
function domOffsetInHost(host: HTMLElement, container: Node, offset: number): number {
  const len = (host.textContent || '').length
  if (!host.contains(container)) {
    // container 在 host 之前 → 视为落在开头
    const rel = host.compareDocumentPosition(container)
    return rel & Node.DOCUMENT_POSITION_PRECEDING ? len : 0
  }
  const r = document.createRange()
  r.selectNodeContents(host)
  try { r.setEnd(container, offset) } catch { return 0 }
  return r.toString().length
}

function blockElementOf(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  const b = el?.closest<HTMLElement>('.be-block') ?? null
  return b && rootRef.value?.contains(b) ? b : null
}

interface RenderedBoundary {
  index: number
  /** 渲染文本内的偏移 / 渲染文本总长 */
  at: number
  len: number
  /** 渲染文本去掉首尾空白后的区间（表格等渲染文本里有大量换行/制表符，判定「整块被选中」要宽容些） */
  trimStart: number
  trimEnd: number
  /** 对应的源码偏移（editableText 坐标）；null = 对不上，只能整块处理 */
  src: number | null
}

/**
 * 该块的「渲染文本」能否与源码逐字对应。
 * 表格（渲染文本里夹着大量换行/制表符）、公式（MathJax 输出）、mermaid（SVG + 隐藏源码）、
 * 原始块都不对应，一律按整块处理；否则贪心映射会拿空白字符乱对齐，删出莫名其妙的结果。
 */
function isMappableBlock(b: Block): boolean {
  if (b.type === 'code') return !isMermaidBlock(b)
  if (formulaParagraph(b)) return false
  return (
    b.type === 'paragraph' || b.type === 'heading' || b.type === 'bullet' ||
    b.type === 'ordered' || b.type === 'todo' || b.type === 'quote'
  )
}

/** 把选区的一个边界点解算成「块下标 + 渲染偏移 + 源码偏移」 */
function resolveBoundary(container: Node, offset: number): RenderedBoundary | null {
  const blockEl = blockElementOf(container)
  if (!blockEl) return null
  const index = Number(blockEl.dataset.index)
  const b = doc.value.blocks[index]
  if (!b) return null
  const host = renderedTextHost(blockEl)
  if (!host) return null
  const renderedText = host.textContent || ''
  const at = Math.max(0, Math.min(domOffsetInHost(host, container, offset), renderedText.length))
  const trimStart = renderedText.length - renderedText.trimStart().length
  const trimEnd = renderedText.trimEnd().length
  // 映射只在「去掉首尾空白」的范围内做：代码块的 <pre> 渲染文本末尾常带多余换行，
  // 表格的渲染文本里夹着大量布局空白，直接拿整串去映射会一个字符对不上就整体失败。
  const inner = renderedText.slice(trimStart, trimEnd)
  const innerAt = Math.max(0, Math.min(at - trimStart, inner.length))
  const map = isMappableBlock(b)
    ? mapRenderedToSource(editableText(b), inner, b.type === 'code' ? 0 : prefixOf(b).length)
    : null
  return {
    index,
    at,
    len: renderedText.length,
    trimStart,
    trimEnd,
    src: map ? map[innerAt] ?? null : null,
  }
}

/** 某个节点是否落在「渲染态 HTML」里（textarea / 输入框内的选区不算） */
function insideRenderedHtml(node: Node | null): boolean {
  if (!node) return false
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
  return !!el && !!rootRef.value?.contains(el) && !!el.closest('.be-rendered')
}

/**
 * 渲染态里是否有可删除的非空选区。
 * 注意：判定的必须是「选区的两个边界点」——跨块选区的公共祖先会落在 .be-list 这类容器上，
 * 用它去 closest('.be-rendered') 恒为空，跨块删除就永远不生效（踩过）。
 */
function renderedSelectionRange(): Range | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  if (!sel.toString().trim()) return null
  const range = sel.getRangeAt(0)
  if (!insideRenderedHtml(range.startContainer) || !insideRenderedHtml(range.endContainer)) return null
  return range
}

/** 块正文是否已空（代码 / 公式只算内容） */
function bodyBlank(b: Block): boolean {
  return bodyOf(b).trim() === ''
}

/**
 * 删除 [start, end] 区间内的块。
 * 空行归属：区间内部的空行随块一起消失（只保留区间末尾那个块后面的空行），
 * 否则逐块 removeBlock 会把区间内每个空行都累加给前一块，删完之后凭空多出好几个空行。
 */
function removeBlockRange(start: number, end: number) {
  const list = doc.value.blocks
  if (end < start) return
  const prev = list[start - 1]
  const last = list[end]
  if (prev && last) prev.blankAfter = last.blankAfter
  list.splice(start, end - start + 1)
  if (!list.length) list.push(createBlock('paragraph'))
}

/** 删除后清掉残留的空行内标记（`****`、``、`[](...)`、`$$`），避免留下可见的垃圾符号 */
function tidyInline(text: string): string {
  return text
    .replace(/(\*\*|__|~~)(\s*)\1/g, '$2')
    .replace(/`\s*`/g, '')
    .replace(/!?\[\s*\]\([^)]*\)/g, '')
    .replace(/\$\s*\$/g, '')
}

/** 删除渲染态里选中的内容；返回是否真的处理了（false 时让浏览器走默认行为） */
function deleteRenderedSelection(): boolean {
  const range = renderedSelectionRange()
  if (!range) return false
  const from = resolveBoundary(range.startContainer, range.startOffset)
  const to = resolveBoundary(range.endContainer, range.endOffset)
  if (!from || !to || from.index > to.index) return false

  // 先清掉浏览器选区：下面会重建 DOM，残留的 Range 可能指向已被删除的节点
  window.getSelection()?.removeAllRanges()

  const blocks = doc.value.blocks
  const b0 = blocks[from.index]
  const b1 = blocks[to.index]
  if (!b0 || !b1) return false

  // ---- 同一个块内：直接裁掉选中区间 ----
  if (from.index === to.index) {
    if (from.src !== null && to.src !== null && from.at < to.at) {
      const text = editableText(b0)
      writeBlockText(b0, tidyInline(text.slice(0, from.src) + text.slice(to.src)))
      if (bodyBlank(b0) && b0.type !== 'paragraph') {
        // 整块文字被删空：标题 / 列表 / 引用退化成空段落（与在编辑态里删空一致）
        setBlockType(doc.value, from.index, 'paragraph')
      }
      const offset = bodyBlank(b0) ? 0 : Math.min(from.src, editableText(b0).length)
      commit('delete', { focus: { index: from.index, offset } })
      return true
    }
    // 表格 / 分割线 / mermaid 等对不上文字的块：只有整块都被选中才删掉
    if (!(from.at <= from.trimStart && to.at >= to.trimEnd)) return false
    commit('delete', { focus: removeBlock(doc.value, from.index) })
    return true
  }

  // ---- 跨块：裁剪首尾 + 删除中间 ----
  const whole0 = from.src === null || from.at <= from.trimStart
  const whole1 = to.src === null || to.at >= to.trimEnd
  const head = whole0 ? '' : tidyInline(editableText(b0).slice(0, from.src!))
  const tail = whole1 ? '' : tidyInline(editableText(b1).slice(to.src!))

  // 首尾都是行内文本类 → 合并成一块（等同普通编辑器里删掉跨段选区后的粘合）
  if (!whole0 && !whole1 && MERGE_TYPES.includes(b0.type) && MERGE_TYPES.includes(b1.type)) {
    writeBlockText(b0, head + tail)
    removeBlockRange(from.index + 1, to.index)
    commit('delete', { focus: { index: from.index, offset: head.length } })
    return true
  }

  if (!whole0) writeBlockText(b0, head)
  if (!whole1) writeBlockText(b1, tail)
  removeBlockRange(whole0 ? from.index : from.index + 1, whole1 ? to.index : to.index - 1)
  const caret: Caret = !whole0
    ? { index: from.index, offset: head.length }
    : !whole1
      ? { index: from.index, offset: 0 }
      : { index: Math.max(0, from.index - 1), offset: -1 }
  commit('delete', { focus: caret })
  return true
}

/** 文档级键盘监听：渲染态里响应删除 / 撤销（编辑态与输入框内不介入） */
function onDocumentKeydown(e: KeyboardEvent) {
  // e.target 可能是 document（事件直接派发在 document 上时），不是所有靶都有 closest
  const t = e.target instanceof HTMLElement ? e.target : null
  const inEditor = !!t?.closest('textarea, input, [contenteditable="true"], .monaco-editor')
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()

  // 撤销 / 重做：文本块由 textarea、代码块由 Monaco 自己处理；
  // 渲染态（以及表格单元格）没有原生撤销，交给编辑器历史 —— 刚在渲染态删完就按 Ctrl+Z 才有反应
  if (mod && !e.altKey && !inEditor && (key === 'z' || key === 'y')) {
    e.preventDefault()
    if (key === 'y' || e.shiftKey) doRedo()
    else doUndo()
    return
  }
  if (inEditor || e.altKey) return

  const cut = mod && !e.shiftKey && key === 'x'
  const del = !mod && (e.key === 'Backspace' || e.key === 'Delete')
  if (!cut && !del) return
  if (cut) {
    const text = window.getSelection()?.toString() || ''
    if (text) navigator.clipboard?.writeText(text).catch(() => {})
  }
  if (deleteRenderedSelection()) {
    e.preventDefault()
    e.stopPropagation()
  }
}

/** 退出编辑态：回到渲染视图 */
function onBlur(index: number) {
  const b = doc.value.blocks[index]
  if (!b || editingId.value !== b.id) return
  if (slash.open) return // 斜杠菜单还开着，先不切回渲染态
  editingId.value = null
  refreshRendered()
}

function scrollIntoViewIfNeeded(el: HTMLElement) {
  const c = rootRef.value
  if (!c) return
  const er = el.getBoundingClientRect()
  const cr = c.getBoundingClientRect()
  if (er.top < cr.top + 8) c.scrollTop -= cr.top + 8 - er.top
  else if (er.bottom > cr.bottom - 8) c.scrollTop += er.bottom - (cr.bottom - 8)
}

// --- 输入 ------------------------------------------------------------------

function onInput(i: number, e: Event) {
  const el = e.target as HTMLTextAreaElement
  const b = doc.value.blocks[i]
  if (!b) return
  if (b.type === 'code') setContentText(b, el.value)
  else if (b.type === 'math' || formulaParagraph(b)) setFormulaText(b, el.value)
  else setBlockText(b, el.value)

  grow(el)
  autoConvert(i, el)
  maybeSlash(i, el)
  commit('input', { coalesce: true })
}

/** Markdown 快捷输入：输入 `# `、`- `、` ``` ` 等即转成对应块 */
function autoConvert(i: number, el: HTMLTextAreaElement): boolean {
  const b = doc.value.blocks[i]
  if (!b || b.type === 'code' || isFormulaBlock(b)) return false
  const t = el.value

  let type: BlockType | null = null
  let props: BlockProps = {}
  let m: RegExpExecArray | null

  if ((m = /^(#{1,6})[ \t]$/.exec(t))) {
    type = 'heading'
    props = { level: m[1].length }
  } else if (/^[-*+][ \t]$/.test(t)) type = 'bullet'
  else if (/^\d{1,9}[.)][ \t]$/.test(t)) {
    type = 'ordered'
    props = { start: parseInt(t, 10) }
  } else if (/^>[ \t]?$/.test(t)) type = 'quote'
  else if (/^\[[ \t]?\][ \t]$/.test(t)) {
    type = 'todo'
    props = { checked: false }
  } else if (/^```$/.test(t)) {
    type = 'code'
    props = { lang: '' }
  } else if (/^\$\$$/.test(t)) type = 'math'
  else if (/^(---|\*\*\*|___)$/.test(t)) type = 'divider'
  if (!type) return false

  const body = t.replace(/^(#{1,6}[ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+|>[ \t]?|```|\$\$|\[[ \t]?\][ \t]+|---|\*\*\*|___)/, '')
  convertBlock(b, type, props, body)

  nextTick(() => {
    const el2 = textareaEl(b.id)
    if (!el2) {
      // 转成分割线后没有输入框了
      activeIndex.value = i
      refreshRendered()
      return
    }
    el2.focus()
    const off = b.type === 'code' || b.type === 'math' ? 0 : prefixFor(b.type, b.props).length
    el2.setSelectionRange(off, off)
    grow(el2)
  })
  return true
}

/** 按目标类型直接改写块（autoConvert 专用：body 已经剥掉标记） */
function convertBlock(b: Block, type: BlockType, props: BlockProps, body: string) {
  b.type = type
  b.props = { ...props }
  b.dirty = true
  if (type === 'divider') {
    b.lines = ['---']
    b.indentLevel = 0
  } else if (type === 'code') {
    b.lines = ['```', body, '```']
    b.indentLevel = 0
  } else if (type === 'math') {
    b.lines = ['$$', body, '$$']
    b.indentLevel = 0
  } else {
    b.lines = [prefixFor(type, props) + body]
  }
}

// --- 表格 / 代码 子编辑器 --------------------------------------------------

/** 退出编辑态：回到渲染视图 */
function exitEdit() {
  editingId.value = null
  pendingTableCell.value = null
  refreshRendered()
}

function onTableChange(i: number, lines: string[]) {
  const b = doc.value.blocks[i]
  if (!b) return
  b.lines = lines
  b.dirty = true
  // 视为连续输入：格子每敲一下不必全量刷新渲染缓存
  commit('input', { coalesce: true })
}

function onCodeChange(i: number, value: string) {
  const b = doc.value.blocks[i]
  if (!b) return
  if (b.type === 'math' || formulaParagraph(b)) setFormulaText(b, value)
  else setContentText(b, value)
  commit('input', { coalesce: true })
}

function onCodeLangChange(i: number, lang: string) {
  const b = doc.value.blocks[i]
  if (!b) return
  setCodeLang(b, lang)
  commit('structure')
}

// --- mermaid 组件预览 ------------------------------------------------------

const mermaidViewerRef = ref<InstanceType<typeof MermaidViewer> | null>(null)

function previewMermaid(b: Block) {
  const source = contentText(b)
  if (!source.trim()) return
  mermaidViewerRef.value?.open({ source, title: b.props.lang ? `${b.props.lang} 图表` : undefined })
}

function onBlockClick(i: number, e: MouseEvent) {
  maybeSlash(i, e.target as HTMLTextAreaElement)
}

// --- 键盘 ------------------------------------------------------------------

function wrapSelection(el: HTMLTextAreaElement, before: string, after = before) {
  const s = el.selectionStart ?? 0
  const e2 = el.selectionEnd ?? 0
  const v = el.value
  const sel = v.slice(s, e2)
  el.value = v.slice(0, s) + before + sel + after + v.slice(e2)
  el.dispatchEvent(new Event('input'))
  el.setSelectionRange(s + before.length, s + before.length + sel.length)
}

function onKeydown(i: number, e: KeyboardEvent) {
  const el = e.target as HTMLTextAreaElement
  const b = doc.value.blocks[i]
  if (!b) return
  const mod = e.ctrlKey || e.metaKey

  // 撤销 / 重做
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    doUndo()
    return
  }
  if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault()
    doRedo()
    return
  }

  // 斜杠菜单导航
  if (slash.open && slash.blockIndex === i) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slash.index = Math.min(slash.index + 1, Math.max(0, slashItems.value.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slash.index = Math.max(0, slash.index - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const it = slashItems.value[slash.index]
      if (it) applySlash(it)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slash.open = false
      return
    }
  }

  if (mod && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k === 'b') { e.preventDefault(); wrapSelection(el, '**'); return }
    if (k === 'i') { e.preventDefault(); wrapSelection(el, '*'); return }
    if (k === 'e') { e.preventDefault(); wrapSelection(el, '`'); return }
    if (k === 'k') { e.preventDefault(); wrapSelection(el, '[', '](url)'); return }
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const c = nudgeBlock(doc.value, i, e.key === 'ArrowUp' ? -1 : 1)
      commit('structure', { focus: c })
      return
    }
  }

  if (e.key === 'Enter') {
    if (e.shiftKey) return // 软换行
    if (b.type === 'code' || b.type === 'math') return // 内容里回车即换行
    e.preventDefault()
    if (b.type === 'divider') {
      const c = setBlockType(doc.value, i, 'paragraph')
      commit('structure', { focus: c })
      return
    }
    const c = enterBlocks(doc.value, i, el.selectionStart ?? 0)
    commit('structure', { focus: c })
    return
  }

  if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
    e.preventDefault()
    const c = mergeBackward(doc.value, i)
    if (c) commit('structure', { focus: c })
    return
  }

  // 光标在块尾按 Delete：把下一块并进来（与块首按 Backspace 对称）
  if (e.key === 'Delete' && el.selectionStart === el.selectionEnd && el.selectionStart === el.value.length) {
    const c = mergeForward(doc.value, i)
    if (c) {
      e.preventDefault()
      commit('structure', { focus: c })
      return
    }
  }

  if (e.key === 'Delete' && b.type === 'divider') {
    e.preventDefault()
    commit('structure', { focus: removeBlock(doc.value, i) })
    return
  }

  if (e.key === 'Tab') {
    e.preventDefault()
    if (LIST_TYPES.includes(b.type)) {
      if (indentSubtree(doc.value, i, e.shiftKey ? -1 : 1)) {
        commit('structure', { focus: { index: i, offset: el.selectionStart ?? 0 } })
      }
    }
    return
  }

  if (e.key === 'ArrowUp' && !e.shiftKey && !mod && el.selectionStart === 0) {
    e.preventDefault()
    focusBlock(i - 1, -1)
    return
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && !mod && el.selectionStart === el.value.length) {
    e.preventDefault()
    focusBlock(i + 1, 0)
    return
  }
}

/** 分割线块的键盘行为 */
function onDividerKeydown(i: number, e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    commit('structure', { focus: setBlockType(doc.value, i, 'paragraph') })
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault()
    commit('structure', { focus: removeBlock(doc.value, i) })
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    focusBlock(i - 1, -1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    focusBlock(i + 1, 0)
  }
}

function doUndo() {
  const s = history.undo()
  if (!s) return
  applySnapshot(s)
  emit('change', serializeMarkdown(doc.value))
}

function doRedo() {
  const s = history.redo()
  if (!s) return
  applySnapshot(s)
  emit('change', serializeMarkdown(doc.value))
}

// --- 粘贴 / 插入 -----------------------------------------------------------

/** 把一段 Markdown 拆成块，插到 index 之后 */
function insertMarkdownAfter(index: number, md: string, focusFirst = true) {
  const parsed = parseMarkdown(md)
  if (!parsed.blocks.length) return
  const parent = doc.value.blocks[index]
  const last = parsed.blocks[parsed.blocks.length - 1]
  if (parent) {
    last.blankAfter = parent.blankAfter
    parent.blankAfter = 0
  }
  doc.value.blocks.splice(index + 1, 0, ...parsed.blocks)
  const focus = focusFirst ? { index: index + 1, offset: parsed.blocks[0].lines[0].length } : null
  commit('structure', { focus })
}

function onPaste(i: number, e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!text.includes('\n')) return // 单行走默认行为
  e.preventDefault()
  const chunks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((c) => c.trimEnd()).filter((c) => c.trim() !== '')
  if (!chunks.length) return
  insertMarkdownAfter(i, chunks.join('\n\n'))
}

// --- 斜杠菜单 --------------------------------------------------------------

const slash = reactive({ open: false, x: 0, y: 0, index: 0, query: '', blockIndex: -1 })

/** 斜杠菜单里输入的 `/xxx` 匹配片段 */
function slashMatch(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret)
  if (before.includes('\n')) return null
  const m = /(?:^|\s)\/([\w\u4e00-\u9fa5]*)$/.exec(before)
  if (!m) return null
  return { start: m.index + (m[0].startsWith('/') ? 0 : 1), query: m[1] }
}

/** 菜单定位：统一做视口钳制，避免超出窗口底部后看不见 */
function clampMenu(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

function maybeSlash(i: number, el: HTMLTextAreaElement) {
  const caret = el.selectionStart ?? 0
  const m = caret === el.value.length ? slashMatch(el.value, caret) : null
  if (m) {
    slash.open = true
    slash.query = m.query
    slash.blockIndex = i
    slash.index = 0
    const wrap = blockEl(doc.value.blocks[i]?.id ?? '')
    const r = wrap?.getBoundingClientRect()
    if (r) {
      const pos = clampMenu(r.left + 28, r.bottom + 4, 200, 340)
      slash.x = pos.x
      slash.y = pos.y
    }
  } else if (slash.open && slash.blockIndex === i) {
    slash.open = false
  }
}

function applySlash(item: BlockTypeItem) {
  const i = slash.blockIndex
  const b = doc.value.blocks[i]
  slash.open = false
  if (!b) return
  const el = textareaEl(b.id)
  if (el) {
    const caret = el.selectionStart ?? 0
    const m = slashMatch(el.value, caret)
    if (m) {
      const next = el.value.slice(0, m.start) + el.value.slice(caret)
      if (b.type === 'code') setContentText(b, next)
      else if (b.type === 'math' || formulaParagraph(b)) setFormulaText(b, next)
      else setBlockText(b, next)
    }
  }
  const c = setBlockType(doc.value, i, item.type, {
    level: item.level,
    lang: item.lang,
    checked: item.type === 'todo' ? !!b.props.checked : undefined,
  })
  commit('structure', { focus: c })
}

// --- 块菜单（左侧手柄下拉） -------------------------------------------------

const menu = reactive({ open: false, x: 0, y: 0, index: -1, panel: 'main' as 'main' | 'type', subIndex: 0 })
const menuRef = ref<HTMLElement | null>(null)

/**
 * 渲染后用真实尺寸再钳制一次。
 * 预设高度只是估值（类型列表比主菜单高多了），算偏了菜单会跑到窗口外面看不见。
 */
function clampMenuRect() {
  nextTick(() => {
    const el = menuRef.value
    if (!el || !menu.open) return
    const r = el.getBoundingClientRect()
    const nx = Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))
    const ny = Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))
    if (nx !== menu.x) menu.x = nx
    if (ny !== menu.y) menu.y = ny
  })
}

function openBlockMenu(i: number, e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const pos = clampMenu(r.left, r.bottom + 4, 200, 320)
  menu.open = true
  menu.index = i
  menu.panel = 'main'
  menu.subIndex = 0
  menu.x = pos.x
  menu.y = pos.y
  clampMenuRect()
}

/** 切到「转换为」面板（重新钳制位置：类型列表更高） */
function showTypePanel() {
  const pos = clampMenu(menu.x, menu.y, 200, 340)
  menu.x = pos.x
  menu.y = pos.y
  menu.panel = 'type'
  clampMenuRect()
}

function menuSetType(item: BlockTypeItem) {
  const i = menu.index
  menu.open = false
  const c = setBlockType(doc.value, i, item.type, { level: item.level, lang: item.lang })
  commit('structure', { focus: c })
}

function menuDuplicate() {
  const i = menu.index
  menu.open = false
  insertMarkdownAfter(i, serializeMarkdown({ ...doc.value, blocks: [doc.value.blocks[i]] }).trimEnd(), false)
}

function menuDelete() {
  const i = menu.index
  menu.open = false
  commit('structure', { focus: removeBlock(doc.value, i) })
}

function menuMove(dir: -1 | 1) {
  const i = menu.index
  menu.open = false
  commit('structure', { focus: nudgeBlock(doc.value, i, dir) })
}

function menuIndent(delta: number) {
  const i = menu.index
  menu.open = false
  if (indentSubtree(doc.value, i, delta)) commit('structure', { focus: { index: i, offset: 0 } })
}

// --- 拖拽 ------------------------------------------------------------------

const dragState = reactive({ active: false, from: -1, to: -1, y: 0, x: 0, text: '', indent: 0 })
let dragRects: Array<{ top: number; height: number }> = []

function onHandleDown(i: number, e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const list = listRef.value
  if (!list) return
  dragRects = Array.from(list.querySelectorAll<HTMLElement>('.be-block')).map((n) => {
    const r = n.getBoundingClientRect()
    return { top: r.top, height: r.height }
  })
  dragState.active = true
  dragState.from = i
  dragState.to = i
  dragState.y = e.clientY
  dragState.x = e.clientX
  dragState.text = blockText(doc.value.blocks[i] ?? createBlock()).replace(/\n/g, ' ⏎ ').slice(0, 120)
  dragState.indent = indentWidth(doc.value.blocks[i]?.indent ?? '')
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp)
  window.addEventListener('pointercancel', onDragUp)
}

function computeDrop(y: number): number {
  for (let k = 0; k < dragRects.length; k++) {
    if (y < dragRects[k].top + dragRects[k].height / 2) return k
  }
  return dragRects.length
}

function onDragMove(e: PointerEvent) {
  if (!dragState.active) return
  dragState.y = e.clientY
  dragState.x = e.clientX
  dragState.to = computeDrop(e.clientY)

  // 靠近上下边缘时自动滚动
  const c = rootRef.value
  if (!c) return
  const r = c.getBoundingClientRect()
  const EDGE = 48
  if (e.clientY < r.top + EDGE) c.scrollTop -= 14
  else if (e.clientY > r.bottom - EDGE) c.scrollTop += 14
}

function onDragUp() {
  const { active, from, to } = dragState
  dragState.active = false
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
  window.removeEventListener('pointercancel', onDragUp)
  if (!active) return
  // 落到自身前后 = 未移动
  if (to === from || to === from + 1) return
  commit('structure', { focus: moveBlocks(doc.value, from, to) })
}

// --- 渲染态 -----------------------------------------------------------------

const BULLET_CHARS = ['•', '◦', '▪']

/** 渲染出来的 HTML 里可能带滚动条的容器统一用全局 scoll 样式（5px、menuColor 轨道） */
function withScoll(html: string): string {
  return html.replace(/class="hljs"/g, 'class="hljs scoll"')
}

/** 是否是 mermaid 块（右键菜单据此识别） */
function isMermaidBlock(b: Block): boolean {
  return b.type === 'code' && (b.props.lang || '').toLowerCase() === 'mermaid'
}

/** 把一个块渲染成 HTML（渲染态：看不到 `###`、`**`、`- ` 等符号） */
function buildBlockHtml(b: Block): string {
  try {
    // 段落里只放一条展示公式：按公式块渲染（与 math 块一致，可横向滚动、按整块作为一行）
    // 段落里只放一条展示公式 → 按公式块渲染（与 math 块同款容器：可横向滚动、整块视作一行）
    const fpSrc = b.type === 'paragraph' ? formulaSource(b) : null
    if (fpSrc !== null) return `<div class="be-math scoll">${renderMarkdown('$$\n' + fpSrc + '\n$$')}</div>`

    switch (b.type) {
      case 'divider':
        return '<hr class="be-hr">'

      case 'heading': {
        const lv = Math.min(6, Math.max(1, b.props.level ?? 1))
        return `<h${lv} class="be-h be-h${lv}">${renderInlineMarkdown(bodyOf(b))}</h${lv}>`
      }

      case 'paragraph': {
        const body = bodyOf(b)
        if (!body.trim()) return `<p class="be-ph">${escapeHtml(props.placeholder || '')}</p>`
        return `<div class="be-p">${renderParagraphMarkdown(body)}</div>`
      }

      case 'bullet': {
        const ch = BULLET_CHARS[b.indentLevel % BULLET_CHARS.length]
        return `<div class="be-li"><span class="be-li-mark">${ch}</span><span class="be-li-text">${renderInlineMarkdown(bodyOf(b))}</span></div>`
      }

      case 'ordered': {
        const mark = `${b.props.start ?? 1}${b.props.delimiter ?? '.'}`
        return `<div class="be-li"><span class="be-li-mark be-li-num">${mark}</span><span class="be-li-text">${renderInlineMarkdown(bodyOf(b))}</span></div>`
      }

      case 'todo': {
        const checked = !!b.props.checked
        return (
          `<div class="be-todo"><input type="checkbox"${checked ? ' checked' : ''}>` +
          `<span class="be-todo-text${checked ? ' is-done' : ''}">${renderInlineMarkdown(bodyOf(b))}</span></div>`
        )
      }

      case 'quote':
        return `<blockquote class="be-quote">${renderInlineMarkdown(bodyOf(b))}</blockquote>`

      case 'code':
        return withScoll(
          renderMarkdown('```' + (b.props.lang || '').trim() + '\n' + contentText(b) + '\n```')
        )

      case 'math':
        return `<div class="be-math scoll">${renderMarkdown('$$\n' + contentText(b) + '\n$$')}</div>`

      case 'table':
        return `<div class="be-table scoll">${renderMarkdown(b.lines.join('\n'))}</div>`

      default:
        return `<div class="be-raw scoll">${withScoll(renderMarkdown(b.lines.join('\n')))}</div>`
    }
  } catch (e) {
    return `<pre class="be-render-err">${escapeHtml(String(e))}</pre>`
  }
}

/** 渲染签名：只有内容真的变了才重建 DOM */
function renderSig(b: Block): string {
  return [
    b.type,
    b.indentLevel,
    b.props.level ?? '',
    b.props.lang ?? '',
    b.props.checked ? 1 : 0,
    b.lines.join('\n'),
  ].join('\u0001')
}

function resolveSrc(src: string): string {
  if (!src) return src
  if (/^(https?:|data:|file:\/\/|\/|[A-Za-z]:)/i.test(src)) return src
  return (props.basePath || '') + src.replace(/\\/g, '/')
}

/** 取参与后处理的块元素：传了 ids 就只取这些块（避免每次点击都整篇扫描 / 整篇排版） */
function touchedBlockEls(ids?: string[]): HTMLElement[] {
  const list = listRef.value
  if (!list) return []
  const all = Array.from(list.querySelectorAll<HTMLElement>('.be-block'))
  if (!ids) return all
  const set = new Set(ids)
  return all.filter((el) => {
    const id = el.dataset.id
    return !!id && set.has(id)
  })
}

/** 重建需要更新的块的渲染 HTML（正在编辑的块跳过） */
function refreshRendered(force = false) {
  const editing = editingId.value
  const touched = new Set<string>()
  for (const b of blocks.value) {
    if (!force && editing === b.id) continue
    const sig = renderSig(b)
    if (!force && blockSig.get(b.id) === sig) continue
    blockSig.set(b.id, sig)
    blockHtml.set(b.id, buildBlockHtml(b))
    touched.add(b.id)
  }
  // 编辑态切换过的块：DOM 从渲染态换成 textarea（或反过来），手柄槽高与排版都要重算
  if (editing && editing !== lastEditingId) touched.add(editing)
  if (lastEditingId && lastEditingId !== editing) touched.add(lastEditingId)
  lastEditingId = editing
  // 一个块都没变 → 不做任何后处理（大文件下这里是点击变慢的最大一笔开销）
  if (!touched.size) return
  const ids = Array.from(touched)
  nextTick(() => {
    postProcess(ids)
    syncGutterHeights(ids)
    typesetRendered(ids)
  })
}

/**
 * 只读态两端对齐排版（T2）：K-P 断行 + 逐行拉伸。
 * 只处理渲染态（编辑态是 textarea，断行由浏览器决定，接不了）。
 * 传 ids 时只排这几个块（块内宽度只取决于自己，所以局部排版结果与整篇一致）。
 */
function typesetRendered(ids?: string[]) {
  const root = rootRef.value
  if (!root) return
  const targets = ids ? touchedBlockEls(ids) : [root]
  for (const t of targets) {
    try {
      typesetRoot(t)
    } catch (e) {
      console.warn('[blockeditor] 排版失败：', e)
    }
  }
}

/** 行高取不到时（line-height: normal）用字号估算 */
function lineHeightOf(el: Element | null, fallbackFont = 15): number {
  if (!el) return fallbackFont * 1.45
  const cs = getComputedStyle(el)
  const lh = parseFloat(cs.lineHeight)
  if (Number.isFinite(lh) && lh > 0) return lh
  return (parseFloat(cs.fontSize) || fallbackFont) * 1.45
}

/** 整块可视作「一行」的容器（公式 / 表格 / 图片等），按自身盒子居中 */
function isAtomicLine(el: Element): boolean {
  if (el.classList.contains('be-math') || el.classList.contains('be-table') || el.classList.contains('be-raw')) return true
  return ['IMG', 'TABLE', 'MJX-CONTAINER', 'SVG'].includes(el.tagName)
}

/**
 * 量出块内「第一行」的垂直中心（相对左侧手柄槽的顶部）。
 *
 * 手柄槽靠它垂直居中：写死 26px 时字号一变行高就变，手柄会和第一行错开。
 * 基准必须是手柄槽自己的 top（= 块的 content top）——`.be-block` 每种类型有自己的
 * padding-top（标题 6px、公式 2px…），拿块自身 rect.top 当基准会整体偏移。
 */
function firstLineCenterOf(el: HTMLElement): number {
  const body = el.querySelector<HTMLElement>('.be-body')
  const gutter = el.querySelector<HTMLElement>('.be-gutter')
  if (!body || !gutter) return 13
  const refTop = gutter.getBoundingClientRect().top
  const centerOfRect = (r: DOMRect) => r.top - refTop + r.height / 2
  const centerOfLine = (r: DOMRect, line: number, padTop: number) => r.top - refTop + padTop + line / 2

  // 代码 / 公式（Monaco 编辑态）：语言栏 + 一行代码
  const bcHost = body.querySelector<HTMLElement>('.bc-host')
  if (bcHost) {
    const lineH = Math.round(editorFontSize.value * (20 / 13.5))
    // 优先量 Monaco 真实行元素（它带自己的上内边距，别用常量猜）
    const lineEl = bcHost.querySelector<HTMLElement>('.view-line')
    if (lineEl) {
      const lr = lineEl.getBoundingClientRect()
      // .view-line 的盒高是字形高度、不等于行高，行高用 BlockCode 里同一套算法
      return lr.top - refTop + lineH / 2
    }
    // 还没铺开出行：语言栏底 + Monaco 上内边距(8) + 半行
    const bar = body.querySelector<HTMLElement>('.bc-bar')
    const barRect = bar ? bar.getBoundingClientRect() : bcHost.getBoundingClientRect()
    return barRect.bottom - refTop + 8 + lineH / 2
  }

  // 表格（编辑态单元格 / 渲染态表格）：表头第一格
  const cell = body.querySelector<HTMLElement>('th, td')
  if (cell) return centerOfRect(cell.getBoundingClientRect())

  // 分割线：线本身的位置
  const divider = body.querySelector<HTMLElement>('.be-divider')
  if (divider) return centerOfRect(divider.getBoundingClientRect())

  // 其余：渲染态取第一个子元素，源码态取 textarea
  const host = body.querySelector<HTMLElement>('.be-rendered')
  const target =
    (host?.firstElementChild as HTMLElement | null) ??
    body.querySelector<HTMLElement>('textarea.be-textarea') ??
    host
  if (!target) return 13
  const r = target.getBoundingClientRect()
  if (isAtomicLine(target)) return centerOfRect(r)
  const padTop = parseFloat(getComputedStyle(target).paddingTop) || 0
  return centerOfLine(r, lineHeightOf(target, editorFontSize.value), padTop)
}

/** 把「第一行高度」写到 CSS 变量 --be-gutter-h，让左侧手柄与第一行严格垂直居中 */
function syncGutterHeights(ids?: string[]) {
  for (const el of touchedBlockEls(ids)) {
    const center = firstLineCenterOf(el)
    // 槽高 = 2 × 首行中心（手柄在槽内居中）；太小的行（分割线）也留出按钮高度
    const next = Math.max(22, Math.min(200, Math.round(center * 2)))
    const cur = el.style.getPropertyValue('--be-gutter-h')
    if (cur !== next + 'px') el.style.setProperty('--be-gutter-h', next + 'px')
  }
}

/** 渲染后处理：图片相对路径 → 绝对路径；mermaid 占位 → 真实 SVG */
async function postProcess(ids?: string[]) {
  const root = rootRef.value
  if (!root) return
  const nodes = touchedBlockEls(ids)
    .map((el) => el.querySelector<HTMLElement>('.be-rendered'))
    .filter((el): el is HTMLElement => !!el)
  for (const el of nodes) {
    const sig = el.dataset.sig ?? ''
    if (el.dataset.done === sig) continue
    el.dataset.done = sig

    if (props.basePath) {
      el.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
        const s = img.getAttribute('src') || ''
        if (s && !/^(https?:|data:|file:\/\/|\/|[A-Za-z]:)/i.test(s)) img.setAttribute('src', resolveSrc(s))
      })
    }

    const wraps = Array.from(el.querySelectorAll<HTMLElement>('.mermaid-wrapper'))
    for (const n of wraps) {
      // .mermaid-src 的 textContent 已经是解码后的原始源码（写入时做过 HTML 转义）
      const src = n.querySelector('.mermaid-src')?.textContent ?? ''
      if (!src.trim()) continue
      try {
        n.innerHTML = await renderMermaidSvgLenient(src)
      } catch {
        n.innerHTML = `<span class="be-mermaid-err">${zh.value ? '图表渲染失败' : 'Diagram failed'}</span>`
      }
    }
  }
}

// --- 文件拖入 --------------------------------------------------------------

function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.files?.length) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}

function onDrop(e: DragEvent) {
  const files = e.dataTransfer?.files
  if (!files?.length) return
  e.preventDefault()
  emit('drop-files', { files: Array.from(files), index: activeIndex.value })
}

// --- 类型菜单数据 ----------------------------------------------------------

const typeItems = computed<BlockTypeItem[]>(() => buildBlockTypeItems(zh.value))

const slashItems = computed(() => {
  const q = slash.query.trim().toLowerCase()
  if (!q) return typeItems.value
  return typeItems.value.filter(
    (it) => it.label.toLowerCase().includes(q) || it.type.includes(q) || (it.lang ?? '').includes(q)
  )
})

// --- 状态栏 ----------------------------------------------------------------

const FONT_SIZE_KEY = 'block-editor-font-size'
const FONT_MIN = 12
const FONT_MAX = 24

const editorFontSize = ref(
  Math.min(FONT_MAX, Math.max(FONT_MIN, Number(localStorage.getItem(FONT_SIZE_KEY)) || 15))
)

/** 父组件没传 dirty 时自己维护一个 */
const selfDirty = ref(false)
const showDirty = computed(() => props.dirty ?? selfDirty.value)

function changeFont(delta: number) {
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, editorFontSize.value + delta))
  if (next === editorFontSize.value) return
  editorFontSize.value = next
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(next))
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
  // 字号变了 → 行高变了 → 手柄槽位与排版都要重算
  nextTick(() => {
    syncGutterHeights()
    typesetRendered()
  })
}

/** 选区字符数（只有源码 textarea 可读，靠 selectionTick 触发重算） */
const selectionTick = ref(0)
const selectedCount = computed(() => {
  void selectionTick.value
  void activeIndex.value
  const el = document.activeElement as HTMLElement | null
  if (!el || el.tagName !== 'TEXTAREA') return 0
  const t = el as HTMLTextAreaElement
  return Math.max(0, (t.selectionEnd ?? 0) - (t.selectionStart ?? 0))
})

/** 文档统计：防抖，避免每次按键都序列化整篇 */
const stats = reactive({ blocks: 0, chars: 0 })
let statsTimer: ReturnType<typeof setTimeout> | null = null
function scheduleStats() {
  if (statsTimer) clearTimeout(statsTimer)
  statsTimer = setTimeout(() => {
    statsTimer = null
    stats.blocks = doc.value.blocks.length
    stats.chars = serializeMarkdown(doc.value).replace(/\s/g, '').length
  }, 300)
}

/** 状态栏里的当前块类型 */
const currentTypeLabel = computed(() => {
  const b = blocks.value[activeIndex.value]
  if (!b) return ''
  if (b.type === 'heading') return (zh.value ? '标题 ' : 'Heading ') + (b.props.level ?? 1)
  if (isMermaidBlock(b)) return 'Mermaid'
  const item = typeItems.value.find((it) => it.key === b.type)
  return item?.label ?? b.type
})

// --- 左侧目录（与 md_read 的目录面板一致） -------------------------------

const TOC_KEY = 'block-editor-toc-open'

// 目录开合与其它视图共享（见 lib/markdown/toc.ts）；宽度也共用同一个 key 与初始值
const tocOpen = ref(loadDocTocOpen())
const tocWidth = ref(loadDocTocWidth())
/** 显式开合（状态栏按钮 / 面板关闭按钮）：写回共享状态 */
const setTocOpen = (v: boolean) => { tocOpen.value = v; saveDocTocOpen(v) }

/** 容器太窄时自动收起目录（比如待办右侧只有 480px） */
const wrapRef = ref<HTMLElement | null>(null)
const wrapWidth = ref(Number.POSITIVE_INFINITY)
const tocUsable = computed(() => wrapWidth.value >= 420)
let wrapObserver: ResizeObserver | null = null
/** 正文区宽度观察器（用于重新排版） */
let typesetObserver: ResizeObserver | null = null
/** 复制修正的卸载函数 */
let disposeCopyFix: (() => void) | null = null

watch(tocOpen, (v) => {
  try {
    localStorage.setItem(TOC_KEY, v ? '1' : '0')
  } catch {
    /* 忽略 */
  }
})

watch(tocWidth, (v) => saveDocTocWidth(v))

/** 去掉行内标记，只留纯文本当目录标题（与浏览视图 / 源码编辑共用同一个实现） */
function headingText(b: Block): string {
  return plainHeadingText(bodyOf(b))
}

interface TocEntry {
  index: number
  id: string
  level: number
  text: string
}

const headings = computed<TocEntry[]>(() =>
  blocks.value
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.type === 'heading')
    .map(({ b, i }) => ({
      index: i,
      id: b.id,
      level: Math.min(6, Math.max(1, b.props.level ?? 1)),
      text: headingText(b),
    }))
)

/** 目录项：id 直接用块下标（与 activeHeading 同一坐标空间），层级/连接符交给公共工具 */
const tocItems = computed<TocFlatItem[]>(() =>
  flattenHeadingLevels(headings.value.map((h) => ({ level: h.level, text: h.text })))
    .map((it, i) => ({ ...it, id: headings.value[i]?.index ?? it.id }))
)

const activeHeading = ref(-1)
/** 跳转后短暂高亮目标块 */
const flashId = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null

/** 跳转到某个块（可选：跳到后进入编辑态并选中指定区间） */
function jumpToBlock(index: number, selStart = -1, selEnd = -1) {
  const b = doc.value.blocks[index]
  if (!b) return
  activeIndex.value = index

  const selectable = b.type !== 'code' && !isFormulaBlock(b) && b.type !== 'table' && b.type !== 'divider'
  if (selectable) {
    editingId.value = b.id
    refreshRendered()
    nextTick(() => {
      const el = textareaEl(b.id)
      if (el) {
        el.focus()
        if (selStart >= 0) {
          const s = Math.min(selStart, el.value.length)
          const e2 = Math.min(selEnd < 0 ? s : selEnd, el.value.length)
          el.setSelectionRange(s, e2)
        }
        grow(el)
      }
      scrollBlockIntoView(b.id)
    })
  } else {
    // 代码 / 公式 / 表格：交给各自的子编辑器，这里只滚动与高亮
    editingId.value = null
    refreshRendered()
    nextTick(() => scrollBlockIntoView(b.id))
  }

  flashId.value = b.id
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashId.value = null
  }, 1200)
}

function scrollBlockIntoView(id: string) {
  const c = rootRef.value
  const el = blockEl(id)
  if (!c || !el) return
  const cr = c.getBoundingClientRect()
  const er = el.getBoundingClientRect()
  c.scrollTop += er.top - cr.top - 8
}

/**
 * 目录点击：只滚动定位 + 短暂高亮，**不进入编辑态**。
 * 进编辑态要切 textarea（触发块重建与排版），大文件下点一下要等很久；
 * 这里保持渲染态，整条路径只有一次滚动，点哪到哪。
 */
function jumpToHeading(index: number) {
  const b = doc.value.blocks[index]
  if (!b) return
  activeIndex.value = index
  activeHeading.value = index
  flashId.value = b.id
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashId.value = null
  }, 1200)
  nextTick(() => scrollBlockIntoView(b.id))
}

/** 滚动时高亮所在章节（节流，避免每个滚动事件都量一堆 DOM） */
let scrollTick: ReturnType<typeof setTimeout> | null = null
function onEditorScroll() {
  if (scrollTick) return
  scrollTick = setTimeout(() => {
    scrollTick = null
    const c = rootRef.value
    const list = listRef.value
    if (!c || !list || !headings.value.length) return
    const limit = c.getBoundingClientRect().top + 12
    // 列表的第 i 个子元素就是第 i 个块：按下标直接取，省掉每个标题一次全文档 querySelector
    const kids = list.children
    let current = -1
    for (const h of headings.value) {
      const el = kids[h.index] as HTMLElement | undefined
      if (el && el.getBoundingClientRect().top <= limit) current = h.index
    }
    activeHeading.value = current
  }, 80)
}

// 拖拽调整目录宽度
let tocMoveHandler: ((e: MouseEvent) => void) | null = null
let tocUpHandler: (() => void) | null = null

function startTocDrag(e: MouseEvent) {
  const startX = e.clientX
  const startW = tocWidth.value
  tocMoveHandler = (ev: MouseEvent) => {
    tocWidth.value = Math.max(140, Math.min(460, startW + (ev.clientX - startX)))
  }
  tocUpHandler = () => {
    window.removeEventListener('mousemove', tocMoveHandler!)
    window.removeEventListener('mouseup', tocUpHandler!)
    tocMoveHandler = null
    tocUpHandler = null
    document.body.style.userSelect = ''
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', tocMoveHandler)
  window.addEventListener('mouseup', tocUpHandler)
}

/** 目录与搜索共用左侧面板，互斥 */
function toggleToc() {
  const next = !tocOpen.value
  setTocOpen(next)
  if (next) searchVisible.value = false
}

// --- 全文搜索（左侧面板） --------------------------------------------------

const searchVisible = ref(false)
const searchQuery = ref('')
const searchIndex = ref(0)
const searchInputRef = ref<HTMLInputElement | null>(null)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 结果片段：先转义再在转义文本里定位并包 mark（这份 HTML 自己拼，不进渲染链路） */
function snippetHtml(text: string, query: string): string {
  const esc = escapeHtml(text)
  const escQ = escapeHtml(query)
  const idx = esc.toLowerCase().indexOf(escQ.toLowerCase())
  if (idx < 0) return esc.slice(0, 80)
  const from = Math.max(0, idx - 20)
  const to = Math.min(esc.length, idx + escQ.length + 48)
  const slice = esc.slice(from, to)
  const marked = slice.replace(
    new RegExp(escapeRegExp(escQ), 'gi'),
    (m) => `<mark class="be-mark">${m}</mark>`
  )
  return (from > 0 ? '…' : '') + marked + (to < esc.length ? '…' : '')
}

interface SearchHit {
  index: number
  id: string
  count: number
  offset: number
  html: string
}

const searchHits = computed<SearchHit[]>(() => {
  const q = searchQuery.value.trim()
  if (!q) return []
  const re = new RegExp(escapeRegExp(q), 'gi')
  const out: SearchHit[] = []
  blocks.value.forEach((b, i) => {
    const text = blockText(b)
    const found = text.match(re)
    if (!found?.length) return
    out.push({
      index: i,
      id: b.id,
      count: found.length,
      offset: text.toLowerCase().indexOf(q.toLowerCase()),
      html: snippetHtml(text, q),
    })
  })
  return out
})

const searchMatchCount = computed(() => searchHits.value.reduce((n, h) => n + h.count, 0))

/** 当前结果序号（1 基，越界钳制） */
const searchCursor = computed(() =>
  searchHits.value.length
    ? Math.min(searchIndex.value, searchHits.value.length - 1) + 1
    : 0
)

// 只在关键字变化时回到第一条（文档编辑导致结果变化时保留当前位置）
watch(searchQuery, () => {
  searchIndex.value = 0
})

function openSearch() {
  searchVisible.value = true
  tocOpen.value = false
  nextTick(() => searchInputRef.value?.focus())
}

function closeSearch() {
  searchVisible.value = false
  searchQuery.value = ''
}

function toggleSearch() {
  if (searchVisible.value) closeSearch()
  else openSearch()
}

function gotoSearchHit(i: number) {
  const hit = searchHits.value[i]
  if (!hit) return
  searchIndex.value = i
  jumpToBlock(hit.index, hit.offset, hit.offset + searchQuery.value.trim().length)
}

function gotoSearchMatch(dir: number) {
  const n = searchHits.value.length
  if (!n) return
  gotoSearchHit((searchIndex.value + dir + n) % n)
}

// --- 右侧「智能操作」面板（复用共享 DocChatPanel） -------------------------

const CHAT_WIDTH_KEY = 'block-editor-chat-width'
const chatOpen = ref(false)
// 宽度与其它视图（浏览 / 源码编辑 / PDF）共用同一个 key 与默认值（见 lib/knowFile/panelWidths）
const chatWidth = ref(loadDocChatWidth())
const chatUsable = computed(() => wrapWidth.value >= 300)
const chatVisible = computed(() => chatOpen.value && chatUsable.value)

watch(chatWidth, (v) => saveDocChatWidth(v))

const chatDocKey = computed(() => props.path || props.docKey || 'block-editor')

const chatAttachOptions = computed(() => {
  const zhv = zh.value
  // 让选项数组随「光标所在块 / 选区 / 文档字数」重建：面板随之重渲染，
  // 悬浮提示里的字数才不会停在第一次统计的旧数字上
  void selectionTick.value
  void activeIndex.value
  void stats.chars
  return [
    {
      key: 'full',
      label: zhv ? '全文' : 'Full',
      icon: 'fa-align-left',
      title: zhv ? '附带整篇文档内容' : 'Attach full document',
      tag: zhv ? '文档全文' : 'Full document',
      default: true,
      // 悬浮时统计字符数（与浏览视图 / PDF 对话面板一致）；版本用「统计字数 + 块数」，文档改了即失效
      count: () => chatFullText().length,
      countRev: () => `${stats.chars}:${blocks.value.length}`,
    },
    {
      key: 'block',
      label: zhv ? '当前块' : 'Block',
      icon: 'fa-th-large',
      title: zhv ? '附带光标所在的块' : 'Attach current block',
      // 当前块随光标变化 → 版本用块下标，换块后悬浮看到的是新块的字数
      count: () => { const t = chatBlockText(); return t ? t.length : NaN },
      countRev: () => activeIndex.value,
    },
    {
      key: 'selection',
      label: zhv ? '选中文字' : 'Selection',
      icon: 'fa-i-cursor',
      title: zhv ? '附带当前选中的文字' : 'Attach selected text',
      usesSelection: true,
      // 没有选区时返回 NaN（面板会忽略，不显示「0 字符」）；版本带 selectionTick，换选区即失效
      count: () => { const t = chatSelectionText(); return t ? t.length : NaN },
      countRev: () => `${selectionTick.value}:${chatSelectionText().length}`,
    },
  ]
})

/** 全文（与 getChatContext('full') 完全一致，保证字数与实际附带内容一致） */
function chatFullText(): string {
  return getText()
}

/** 当前块文字（与 getChatContext('block') 一致） */
function chatBlockText(): string {
  const b = blocks.value[activeIndex.value]
  return b ? blockText(b) : ''
}

/** 选中文字（与 getChatContext('selection') 的 live 分支一致） */
function chatSelectionText(): string {
  const el = document.activeElement as HTMLElement | null
  if (el && el.tagName === 'TEXTAREA') {
    const t = el as HTMLTextAreaElement
    const s = t.selectionStart ?? 0
    const e2 = t.selectionEnd ?? 0
    if (e2 > s) return t.value.slice(s, e2)
  }
  return (window.getSelection()?.toString() || '').trim()
}

function getChatContext(key: string, snapshot?: string): string {
  if (key === 'full') return chatFullText()
  if (key === 'block') return chatBlockText()
  if (key === 'selection') {
    // 点输入框后失效：用面板在 mousedown 时记下的快照兜底
    return chatSelectionText() || (snapshot || '').trim()
  }
  return ''
}

let chatMoveHandler: ((e: MouseEvent) => void) | null = null
let chatUpHandler: (() => void) | null = null

function toggleChat() {
  chatOpen.value = !chatOpen.value
}

function startChatDrag(e: MouseEvent) {
  const startX = e.clientX
  const startW = chatWidth.value
  chatMoveHandler = (ev: MouseEvent) => {
    // 面板在右侧：往左拖是变宽
    chatWidth.value = Math.max(DOC_CHAT_MIN_WIDTH, Math.min(DOC_CHAT_MAX_WIDTH, startW - (ev.clientX - startX)))
  }
  chatUpHandler = () => {
    window.removeEventListener('mousemove', chatMoveHandler!)
    window.removeEventListener('mouseup', chatUpHandler!)
    chatMoveHandler = null
    chatUpHandler = null
    document.body.style.userSelect = ''
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', chatMoveHandler)
  window.addEventListener('mouseup', chatUpHandler)
}

function onSlashSelect(item: BlockTypeItem) {
  applySlash(item)
}

// --- 生命周期 / 对外接口 ---------------------------------------------------

function onRootKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    openSearch()
    return
  }
  if (e.key === 'Escape') {
    slash.open = false
    menu.open = false
    // 搜索面板优先关（不要直接退出编辑态）
    if (searchVisible.value) {
      closeSearch()
    }
  }
}

function onDocumentPointerDown(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  // 菜单自身的事件已经在模板里 stop 了；这里是兑底：
  // 面板切换会同步换 DOM，被点的节点可能已经脱离文档（closest 会失效），此时不能当成「点了外面」
  if (!t || !t.isConnected) return
  if (t.closest('.be-slash, .be-menu')) return
  slash.open = false
  menu.open = false
}

function getText(): string {
  return serializeMarkdown(doc.value)
}

function setText(md: string) {
  if (serializeMarkdown(doc.value) === (md || '')) return
  loadFrom(md, false)
}

function focus() {
  const idx = Math.min(activeIndex.value, doc.value.blocks.length - 1)
  focusBlock(idx < 0 ? 0 : idx, 0)
}

function appendText(text: string) {
  if (!text) return
  const c = cmdAppendText(doc.value, text)
  commit('structure', { focus: c })
}

function insertMarkdownAtCaret(md: string) {
  const i = Math.min(activeIndex.value, doc.value.blocks.length - 1)
  insertMarkdownAfter(Math.max(0, i), md)
}

/** 把文字塞进一个块（代码/公式只改内容，其余改整行） */
function writeBlockText(b: Block, text: string) {
  if (b.type === 'code') setContentText(b, text)
  else if (b.type === 'math' || formulaParagraph(b)) setFormulaText(b, text)
  else setBlockText(b, text)
  b.dirty = true
}

/**
 * 在「当前光标处」插入一段纯文本（语音输入用）。
 * 顺序：源码 textarea 光标 → 表格单元格光标 → 当前块正文末尾（并进入编辑态、光标落在插入内容之后）。
 * 之前一律追加到文末，光标在中间时文字会跑到文档最后面。
 */
function insertTextAtCaret(text: string) {
  if (!text) return
  const active = document.activeElement as HTMLElement | null

  // 1) 源码 textarea：插到光标处（有选区就替换）
  if (active && active.tagName === 'TEXTAREA' && active.classList.contains('be-textarea')) {
    const el = active as HTMLTextAreaElement
    const idx = doc.value.blocks.findIndex((b) => b.id === el.getAttribute('data-id'))
    if (idx >= 0) {
      const s = el.selectionStart ?? el.value.length
      const e2 = el.selectionEnd ?? s
      writeBlockText(doc.value.blocks[idx], el.value.slice(0, s) + text + el.value.slice(e2))
      commit('input', { focus: { index: idx, offset: s + text.length }, coalesce: true })
      return
    }
  }

  // 2) 表格单元格：插到格子里的光标处，改完补发 input 事件让 BlockTable 自己同步
  if (active && active.classList.contains('bt-cell')) {
    const el = active as HTMLInputElement
    const s = el.selectionStart ?? el.value.length
    const e2 = el.selectionEnd ?? s
    el.value = el.value.slice(0, s) + text + el.value.slice(e2)
    const caret = s + text.length
    el.setSelectionRange(caret, caret)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }

  // 3) 不在编辑态：插到当前块正文末尾（表格 / 分割线不能直接塞文字 → 在它后面新建段落）
  const i = Math.max(0, Math.min(activeIndex.value, doc.value.blocks.length - 1))
  const b = doc.value.blocks[i]
  if (!b) return
  if (b.type === 'table' || b.type === 'divider') {
    insertMarkdownAfter(i, text)
    return
  }
  const next = blockText(b) + text
  writeBlockText(b, next)
  commit('input', { focus: { index: i, offset: next.length }, coalesce: true })
}

function appendBlock() {
  const b = createBlock('paragraph')
  const last = doc.value.blocks[doc.value.blocks.length - 1]
  if (last) {
    b.blankAfter = last.blankAfter
    last.blankAfter = 0
  }
  doc.value.blocks.push(b)
  commit('structure', { focus: { index: doc.value.blocks.length - 1, offset: 0 } })
}

/** 在 index 之后插入一个空块 */
function insertEmptyAfter(index: number) {
  const b = createBlock('paragraph')
  const cur = doc.value.blocks[index]
  if (cur) {
    b.blankAfter = cur.blankAfter
    cur.blankAfter = 0
  }
  doc.value.blocks.splice(index + 1, 0, b)
  commit('structure', { focus: { index: index + 1, offset: 0 } })
}

function removeBlockById(id: string) {
  const i = doc.value.blocks.findIndex((b) => b.id === id)
  if (i < 0) return
  commit('structure', { focus: removeBlock(doc.value, i) })
}

/** 父组件保存成功后调用：清掉「未保存」标记 */
function markSaved() {
  selfDirty.value = false
}

defineExpose({
  getText,
  setText,
  focus,
  appendText,
  insertTextAtCaret,
  insertMarkdownAtCaret,
  insertMarkdownAfter,
  removeBlockById,
  markSaved,
})

watch(
  () => `${props.path ?? ''}\u0000${props.docKey ?? ''}`,
  () => {
    // 延到下一 tick：确保 props.value 已更新为新文档，否则可能读到上一条内容
    nextTick(() => {
      suppressExternal = true
      loadFromWithPlaceholder(props.value || '', true)
      nextTick(() => (suppressExternal = false))
    })
  }
)

watch(
  () => props.value,
  (v) => {
    if (suppressExternal) return
    setText(v || '')
  }
)

watch(
  () => props.basePath,
  () => refreshRendered(true)
)

onMounted(() => {
  loadFromWithPlaceholder(props.value || '', true)
  document.addEventListener('mousedown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
  if (typeof ResizeObserver !== 'undefined' && wrapRef.value) {
    wrapObserver = new ResizeObserver(() => {
      wrapWidth.value = wrapRef.value?.clientWidth ?? Number.POSITIVE_INFINITY
    })
    wrapObserver.observe(wrapRef.value)
    wrapWidth.value = wrapRef.value.clientWidth
  }
  // 正文区宽度变化（目录 / 对话面板 / 窗口）→ 防抖重排
  const root = rootRef.value
  if (typeof ResizeObserver !== 'undefined' && root) {
    typesetObserver = new ResizeObserver(() => {
      const r = rootRef.value
      if (r) scheduleTypeset(r, {}, 120)
    })
    typesetObserver.observe(root)
  }
  if (root) disposeCopyFix = installTypesetCopyFix(root)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
  window.removeEventListener('pointercancel', onDragUp)
  if (statsTimer) clearTimeout(statsTimer)
  if (flashTimer) clearTimeout(flashTimer)
  if (scrollTick) clearTimeout(scrollTick)
  if (tocMoveHandler) window.removeEventListener('mousemove', tocMoveHandler)
  if (tocUpHandler) window.removeEventListener('mouseup', tocUpHandler)
  if (chatMoveHandler) window.removeEventListener('mousemove', chatMoveHandler)
  if (chatUpHandler) window.removeEventListener('mouseup', chatUpHandler)
  wrapObserver?.disconnect()
  wrapObserver = null
  typesetObserver?.disconnect()
  typesetObserver = null
  disposeCopyFix?.()
  disposeCopyFix = null
  document.body.style.userSelect = ''
})
</script>

<template>
  <div
    ref="wrapRef"
    class="be-root"
    :class="{ 'be-loading': rendering }"
    :style="{ '--be-font': editorFontSize + 'px' }"
    @keydown="onRootKeydown"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <div class="be-main">
      <!-- 左侧面板：目录（共享组件 DocTocPanel，与浏览/源码编辑同一个）/ 搜索（互斥） -->
      <DocTocPanel
        v-if="!searchVisible"
        :open="tocOpen"
        @update:open="setTocOpen"
        v-model:width="tocWidth"
        :items="tocItems"
        :active-id="activeHeading >= 0 ? activeHeading : null"
        :usable="tocUsable"
        :min-width="DOC_TOC_MIN_WIDTH"
        :max-width="DOC_TOC_MAX_WIDTH"
        @select="jumpToHeading"
      />

      <!-- 搜索 -->
      <aside v-else class="be-toc" :style="{ width: tocWidth + 'px' }">
        <div class="toc-resizer" @mousedown.prevent="startTocDrag" :title="zh ? '拖动调整宽度' : 'Drag to resize'"></div>
        <div class="left-panel-head">
            <span class="left-panel-title"><i class="fa fa-search"></i> {{ zh ? '搜索' : 'Search' }}</span>
            <span class="be-search-count">{{ searchCursor }}/{{ searchHits.length }}</span>
            <button class="left-panel-btn" :disabled="!searchHits.length" :title="zh ? '上一个 (Shift+Enter)' : 'Previous (Shift+Enter)'" @click="gotoSearchMatch(-1)"><i class="fa fa-chevron-up"></i></button>
            <button class="left-panel-btn" :disabled="!searchHits.length" :title="zh ? '下一个 (Enter)' : 'Next (Enter)'" @click="gotoSearchMatch(1)"><i class="fa fa-chevron-down"></i></button>
            <button class="left-panel-close" :title="zh ? '关闭搜索' : 'Close search'" @click="closeSearch()"><i class="fa fa-times"></i></button>
          </div>
          <div class="be-search-bar">
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              class="be-search-input"
              type="text"
              :placeholder="zh ? '搜索全文…' : 'Search in document…'"
              @keydown.enter.prevent="gotoSearchMatch($event.shiftKey ? -1 : 1)"
              @keydown.escape.prevent="closeSearch()"
            />
          </div>
          <div class="left-scroll scoll">
            <div v-if="!searchQuery.trim()" class="be-toc-empty">{{ zh ? '输入关键字开始搜索' : 'Type to search' }}</div>
            <div v-else-if="!searchHits.length" class="be-toc-empty">{{ zh ? '没有找到匹配项' : 'No matches' }}</div>
            <template v-else>
              <div class="be-search-total">{{ zh ? `共 ${searchMatchCount} 处匹配` : `${searchMatchCount} matches` }}</div>
              <div
                v-for="(hit, i) in searchHits"
                :key="hit.id"
                class="be-search-item"
                :class="{ current: i === searchIndex }"
                @click="gotoSearchHit(i)"
              >
                <span class="be-search-line">{{ zh ? '第' : 'L' }}{{ hit.index + 1 }}{{ zh ? '块' : '' }}</span>
                <span class="be-search-text" v-html="hit.html"></span>
              </div>
            </template>
          </div>
      </aside>

      <div ref="rootRef" class="be-scroll scoll" @scroll="onEditorScroll">
        <div ref="listRef" class="be-list" :class="{ 'be-drop-end': dragState.active && dragState.to >= blocks.length }">
      <div
        v-for="(b, i) in blocks"
        :key="b.id"
        class="be-block"
        :class="[
          `be-t-${b.type}`,
          `be-lv-${b.props.level ?? 1}`,
          {
            'be-active': activeIndex === i,
            'be-editing': editingId === b.id,
            'be-flash': flashId === b.id,
            'be-dragging': dragState.active && dragState.from === i,
            'be-drop-before': dragState.active && dragState.to === i,
          },
        ]"
        :data-index="i"
        :data-id="b.id"
        :data-diagram="isMermaidBlock(b) ? '1' : undefined"
        :style="{ paddingLeft: 6 + b.indentLevel * 22 + 'px' }"
      >
        <div class="be-gutter">
          <button class="be-btn be-add" :title="zh ? '在下方插入' : 'Add below'" @click.stop="insertEmptyAfter(i)">
            <i class="fa fa-plus"></i>
          </button>
          <button
            class="be-btn be-handle"
            :title="zh ? '拖动 / 菜单' : 'Drag / menu'"
            @pointerdown="onHandleDown(i, $event)"
            @click.stop="openBlockMenu(i, $event)"
          >
            <i class="fa fa-ellipsis-v"></i><i class="fa fa-ellipsis-v"></i>
          </button>
        </div>

        <div class="be-body">
          <!-- 分割线：无内容，直接渲染一条线 -->
          <div
            v-if="b.type === 'divider'"
            class="be-divider"
            :data-id="b.id"
            tabindex="0"
            @keydown="onDividerKeydown(i, $event)"
            @focus="activeIndex = i"
          ></div>

          <!-- 表格块：单元格编辑 -->
          <BlockTable
            v-else-if="editingId === b.id && b.type === 'table'"
            :lines="b.lines"
            :zh="zh"
            :col-widths="tableColWidths.get(b.id)"
            :focus-target="
              pendingTableCell?.id === b.id
                ? { row: pendingTableCell.row, col: pendingTableCell.col }
                : null
            "
            @change="onTableChange(i, $event)"
            @exit="exitEdit"
          />

          <!-- 代码块 / 公式（含 \[…\]、裸环境写法）→ Monaco 编辑（公式复用同一组件，只是不显示语言栏）-->
          <BlockCode
            v-else-if="editingId === b.id && (b.type === 'code' || isFormulaBlock(b))"
            :model-value="b.type === 'code' ? contentText(b) : (formulaEditText(b) ?? '')"
            :lang="isFormulaBlock(b) ? 'latex' : b.props.lang || ''"
            :show-lang="b.type === 'code'"
            :font-size="editorFontSize"
            :zh="zh"
            @change="onCodeChange(i, $event)"
            @lang-change="onCodeLangChange(i, $event)"
            @exit="exitEdit"
          />

          <!-- 渲染态：看不到 Markdown 符号，点击进入编辑态 -->
          <div v-else-if="editingId !== b.id" class="be-rendered-wrap">
            <div
              class="be-rendered scoll"
              :data-sig="renderSig(b)"
              v-html="blockHtml.get(b.id) || ''"
              @click="onRenderedClick(i, $event)"
            ></div>
            <!-- 代码 / mermaid：右上角操作图标 -->
            <div v-if="b.type === 'code'" class="be-diagram-actions">
              <button
                v-if="isMermaidBlock(b)"
                class="be-btn"
                :title="zh ? '组件预览' : 'Preview'"
                @click.stop="previewMermaid(b)"
              >
                <i class="fa fa-expand"></i>
              </button>
              <button class="be-btn" :title="zh ? '编辑代码' : 'Edit code'" @click.stop="startEdit(i)">
                <i class="fa fa-pencil"></i>
              </button>
            </div>
          </div>

          <!-- 其余块：源码 textarea -->
          <div v-else class="be-line">
            <textarea
              :data-id="b.id"
              class="be-textarea"
              :class="`be-ta-${b.type}`"
              :value="editableText(b)"
              rows="1"
              spellcheck="false"
              @input="onInput(i, $event)"
              @keydown="onKeydown(i, $event)"
              @focus="activeIndex = i"
              @blur="onBlur(i)"
              @click="onBlockClick(i, $event)"
              @select="selectionTick++"
              @keyup="selectionTick++"
            ></textarea>
          </div>
        </div>
      </div>

        <div class="be-tail" @click="appendBlock()"></div>
        </div>
      </div>

      <!-- 右侧「智能操作」面板（复用 md_read 同款共享组件） -->
      <aside v-if="chatVisible" class="be-chat" :style="{ width: chatWidth + 'px' }">
        <div class="chat-resizer" @mousedown.prevent="startChatDrag" :title="zh ? '拖动调整宽度' : 'Drag to resize'"></div>
        <DocChatPanel
          :doc-key="chatDocKey"
          :attach-options="chatAttachOptions"
          :get-context="getChatContext"
          :hint="zh ? '可以让我读取整篇文档或当前块，帮你改写、扩写、检查问题' : 'Ask me to read the document or the current block and help rewrite, expand or review it'"
        />
      </aside>

      <!--
        大文件首次渲染 / 切文档：盖住整个编辑区（左侧目录 + 正文 + 右侧面板），避免长时间白屏。
        · 必须放在 .be-scroll **外层**：放在滚动容器里会跟着内容滚动，滚轮也能把底下正文滚走；
        · 只留底部状态栏（渲染期间仍能点保存）；
        · 同时给根节点加 .be-loading：左侧目录/搜索面板会被隐藏且不可交互（见下方 CSS），
          避免不同宿主下层叠顺序不同导致目录露出来、还能滑动。
      -->
      <div v-if="rendering" class="be-rendering-mask">
        <i class="fa fa-spinner fa-spin fa-2x"></i>
        <span>{{ zh ? '正在渲染…' : 'Rendering…' }}</span>
      </div>
    </div>

    <!-- 底部状态栏（样式对齐 md_read / Edit_Code） -->
    <div class="be-statusbar" @contextmenu.stop.prevent>
      <button
        v-if="headings.length && tocUsable"
        class="statusbar-btn"
        :class="{ active: tocOpen }"
        :title="zh ? (tocOpen ? '关闭目录' : '打开目录') : (tocOpen ? 'Close TOC' : 'Open TOC')"
        @click="toggleToc()"
      >
        <i class="fa fa-bars"></i>
      </button>
      <button
        class="statusbar-btn"
        :class="{ active: searchVisible }"
        :title="zh ? '搜索文档 (Ctrl+F)' : 'Search document (Ctrl+F)'"
        @click="toggleSearch()"
      >
        <i class="fa fa-search"></i>
      </button>
      <span v-if="showDirty" class="statusbar-item statusbar-dirty" :title="zh ? '有未保存的更改' : 'Unsaved changes'">
        <i class="fa fa-circle"></i>{{ zh ? '未保存' : 'Unsaved' }}
      </span>
      <span class="statusbar-item" :title="zh ? '当前块 / 总块数' : 'Current block / total'">
        <i class="fa fa-th-list"></i> {{ activeIndex + 1 }}/{{ stats.blocks || blocks.length }}
      </span>
      <span v-if="currentTypeLabel" class="statusbar-item" :title="zh ? '当前块类型' : 'Block type'">
        <i class="fa fa-tag"></i> {{ currentTypeLabel }}
      </span>
      <span v-if="selectedCount > 0" class="statusbar-item" :title="zh ? '已选中字符数' : 'Selected characters'">
        <i class="fa fa-text-width"></i> {{ selectedCount }} {{ zh ? '已选' : 'sel' }}
      </span>
      <button
        class="statusbar-btn"
        :disabled="editorFontSize <= 12"
        :title="zh ? '减小字号 (A-)' : 'Decrease font size (A-)'"
        @click="changeFont(-1)"
      >
        <span class="statusbar-font-label">A-</span>
      </button>
      <button
        class="statusbar-btn"
        :disabled="editorFontSize >= 24"
        :title="zh ? '增大字号 (A+)' : 'Increase font size (A+)'"
        @click="changeFont(1)"
      >
        <span class="statusbar-font-label">A+</span>
      </button>
      <span class="statusbar-spacer"></span>
      <!-- 语音输入（状态由父组件传入，点击交回父组件处理） -->
      <button
        v-if="asr"
        class="statusbar-btn"
        :class="{ active: asr.active, 'sb-recording': asr.active }"
        :disabled="asr.disabled"
        :title="asr.title"
        @click="emit('asr-toggle')"
      >
        <i class="fa" :class="asr.icon"></i>
      </button>
      <button
        class="statusbar-btn"
        :class="{ active: chatOpen }"
        :title="zh ? '智能操作：与当前文档智能对话' : 'Smart: chat about this document'"
        @click="toggleChat()"
      >
        <i class="fa fa-magic"></i>
      </button>
      <button class="statusbar-btn" :title="zh ? '保存 (Ctrl+S)' : 'Save (Ctrl+S)'" @click="emit('save')">
        <i class="fa fa-save"></i>
      </button>
      <span class="statusbar-item" :title="zh ? '字符数（不含空白）' : 'Characters (excl. whitespace)'">
        <i class="fa fa-file-text-o"></i> {{ stats.chars }} {{ zh ? '字符' : 'chars' }}
      </span>
    </div>

    <!-- 斜杠菜单 -->
    <div
      v-if="slash.open"
      class="be-slash"
      :style="{ left: slash.x + 'px', top: slash.y + 'px' }"
    >
      <BlockTypeMenu
        :items="slashItems"
        :active="slash.index"
        @select="onSlashSelect"
        @hover="(n: number) => (slash.index = n)"
      />
    </div>

    <!-- 块菜单（右键手柄弹出的菜单，scoll 使列表滚动条与全局一致） -->
    <div
      v-if="menu.open"
      ref="menuRef"
      class="be-menu scoll"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
    >
      <template v-if="menu.panel === 'main'">
        <div class="be-menu-item" @mousedown.prevent.stop="showTypePanel">
          <i class="fa fa-exchange"></i>{{ zh ? '转换为' : 'Turn into' }}<i class="fa fa-chevron-right be-menu-arrow"></i>
        </div>
        <div class="be-menu-sep"></div>
        <div class="be-menu-item" @mousedown.prevent.stop="menuMove(-1)"><i class="fa fa-arrow-up"></i>{{ zh ? '上移' : 'Move up' }}</div>
        <div class="be-menu-item" @mousedown.prevent.stop="menuMove(1)"><i class="fa fa-arrow-down"></i>{{ zh ? '下移' : 'Move down' }}</div>
        <div class="be-menu-item" @mousedown.prevent.stop="menuIndent(1)"><i class="fa fa-indent"></i>{{ zh ? '增加缩进' : 'Indent' }}</div>
        <div class="be-menu-item" @mousedown.prevent.stop="menuIndent(-1)"><i class="fa fa-outdent"></i>{{ zh ? '减少缩进' : 'Outdent' }}</div>
        <div class="be-menu-sep"></div>
        <div class="be-menu-item" @mousedown.prevent.stop="menuDuplicate()"><i class="fa fa-copy"></i>{{ zh ? '复制' : 'Duplicate' }}</div>
        <div class="be-menu-item be-danger" @mousedown.prevent.stop="menuDelete()"><i class="fa fa-trash-o"></i>{{ zh ? '删除' : 'Delete' }}</div>
      </template>
      <template v-else>
        <div class="be-menu-head" @mousedown.prevent.stop="menu.panel = 'main'">
          <i class="fa fa-chevron-left"></i>{{ zh ? '转换为' : 'Turn into' }}
        </div>
        <BlockTypeMenu
          :items="typeItems"
          :active="menu.subIndex"
          @select="menuSetType"
          @hover="(n: number) => (menu.subIndex = n)"
        />
      </template>
    </div>

    <!-- 拖拽幽灵 -->
    <div
      v-if="dragState.active"
      class="be-ghost"
      :style="{ left: dragState.x + 16 + 'px', top: dragState.y + 8 + 'px', paddingLeft: 6 + dragState.indent + 'px' }"
    >
      {{ dragState.text || (zh ? '空块' : 'Empty') }}
    </div>

    <!-- mermaid 组件预览（与浏览 / 演示共用同一组件） -->
    <MermaidViewer ref="mermaidViewerRef" />
  </div>
</template>

<style scoped>
.be-root {
  position: relative;
  width: 100%;
  height: 100%;
  /* 纵向 flex：目录+正文在一行，状态栏在下方 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}

.be-main {
  /* 作为「正在渲染」占位符（.be-rendering-mask）的定位基准（只盖编辑区，不遮状态栏） */
  position: relative;
  display: flex;
  flex-direction: row;
  flex: 1 1 auto;
  min-height: 0;
}

.be-scroll {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* 纵向 flex：.be-list 才能 flex:1 铺满（内容少时也能点空白追加块） */
  display: flex;
  flex-direction: column;
}

/* 大文件渲染占位符：盖住整个编辑区（绝对定位，不影响 .be-main 的 flex 布局）。
   ⚠️ 必须挂在 .be-scroll **外面**：挂在滚动容器里会跟着内容滚动，滚轮也能把底下正文滚走 */
.be-rendering-mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 13px;
  color: var(--fontColor);
  /* 完全不透明：半透明会让底下的旧内容与左侧目录透出来，看着像“没盖住” */
  background: var(--backgroundColor);
}
.be-rendering-mask i { opacity: 0.75; }

/* 渲染中：左侧目录 / 搜索面板、右侧对话面板一并隐藏且不可交互
   （占位符虽然已盖在其上，但宿主窗口的层叠关系不可控，这里做一层保险）。
   用 visibility 而不是 v-if：保住布局，渲染完成后相邻面板不会重新布局、跳动 */
.be-root.be-loading :deep(.nav),
.be-root.be-loading .be-toc,
.be-root.be-loading .be-chat {
  visibility: hidden;
}

/* 编辑区整体不响应鼠标（滚轮滚动、拖滚动条、点目录项都挡住），渲染期间不可操作 */
.be-root.be-loading .be-main {
  pointer-events: none;
}

/* --- 左侧目录（结构与样式对齐 md_read 的 nav / left-panel-* / toc-*） --- */
.be-toc {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--borderColor);
  background: var(--backgroundColor);
  box-sizing: border-box;
}

.be-toc .toc-resizer {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
  user-select: none;
}

.be-toc .toc-resizer:hover {
  background: rgba(128, 128, 128, 0.15);
}

.left-panel-head {
  display: flex;
  align-items: center;
  justify-content: flex-start;
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
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.left-panel-title i {
  font-size: 12px;
  opacity: 0.8;
}

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

.left-panel-close:hover {
  color: #e74c3c;
}

.left-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.be-toc-empty {
  padding: 10px 12px;
  font-size: 12px;
  opacity: 0.5;
}

/* 目录树的样式已随目录面板搬到共享组件 DocTocPanel.vue，这里只留搜索面板的样式 */

/* --- 左侧搜索面板（结构/样式对齐 md_read 的 md-search-*） --- */
.be-search-count {
  flex-shrink: 0;
  min-width: 36px;
  text-align: center;
  font-size: 11px;
  opacity: 0.8;
}

.left-panel-btn {
  flex-shrink: 0;
  margin: 0;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 13px;
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.8;
}

.left-panel-btn:hover:not(:disabled) {
  background: var(--menuActiveColor);
  opacity: 1;
}

.left-panel-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.be-search-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}

.be-search-input {
  flex: 1;
  min-width: 0;
  width: auto;
  height: 22px;
  padding: 0 8px;
  margin: 0;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--inputColor, var(--backgroundColor));
  color: var(--fontColor);
  font-size: 13px;
  outline: none;
}

.be-search-total {
  padding: 6px 10px 2px;
  font-size: 11px;
  opacity: 0.55;
}

.be-search-item {
  padding: 6px 8px;
  margin-bottom: 6px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fontColor);
  cursor: pointer;
  word-break: break-all;
}

.be-search-item:hover {
  background: var(--menuColor);
}

.be-search-item.current {
  border-color: var(--fontActiveColor);
  background: var(--menuColor);
}

.be-search-line {
  display: block;
  margin-bottom: 2px;
  font-size: 11px;
  opacity: 0.55;
}

.be-search-text {
  display: block;
}

/* v-html 内容拿不到 scoped 属性，高亮必须走 :deep */
.be-search-text :deep(mark.be-mark) {
  background: rgba(255, 213, 0, 0.45);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

/* --- 右侧「智能操作」面板（复用 md_read 同款共享组件） --- */
.be-chat {
  flex: 0 0 auto;
  max-width: 60%;
  min-width: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--borderColor);
  background: var(--backgroundColor);
  box-sizing: border-box;
}

.be-chat .chat-resizer {
  position: absolute;
  top: 0;
  left: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
  user-select: none;
}

.be-chat .chat-resizer:hover {
  background: rgba(128, 128, 128, 0.15);
}

.be-list {
  position: relative;
  /* 内容少时占满剩余高度（空白可点击追加块），内容多时自然撑开 */
  flex: 1 0 auto;
  padding: 8px 24px 48px 8px;
}

.be-tail {
  min-height: 32px;
  cursor: text;
}

/* --- 单个块 --- */
.be-block {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 2px;
  border-radius: 4px;
}

.be-block.be-dragging {
  opacity: 0.35;
}

/* 目录跳转后短暂高亮目标块 */
.be-block.be-flash {
  animation: be-flash 1.2s ease-out;
}

@keyframes be-flash {
  0% {
    background: color-mix(in srgb, var(--fontActiveColor) 26%, transparent);
  }
  100% {
    background: transparent;
  }
}

/* 拖拽插入位置指示线：用块自身伪元素，天然与行对齐 */
.be-block.be-drop-before::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -1px;
  height: 2px;
  background: var(--fontActiveColor);
  border-radius: 1px;
  z-index: 3;
}

.be-list.be-drop-end::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 6px;
  height: 2px;
  background: var(--fontActiveColor);
  border-radius: 1px;
}

.be-gutter {
  display: flex;
  align-items: center;
  gap: 1px;
  /* 与「第一行」等高（由 syncGutterHeights 写入），字号变化后手柄仍和首行居中 */
  height: var(--be-gutter-h, 26px);
  opacity: 0;
  transition: opacity 0.12s ease;
  flex: 0 0 auto;
}

.be-block:hover .be-gutter,
.be-block.be-active .be-gutter {
  opacity: 1;
}

.be-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  opacity: 0.5;
  cursor: pointer;
  border-radius: 3px;
  padding: 0;
  font-size: 11px;
}

.be-btn:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
}

.be-handle {
  cursor: grab;
  letter-spacing: -3px;
}

.be-handle:active {
  cursor: grabbing;
}

.be-body {
  flex: 1 1 auto;
  min-width: 0;
}

.be-line {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

/* --- 编辑区 --- */
.be-textarea {
  flex: 1 1 auto;
  width: 100%;
  /* 全局 textarea 没设 box-sizing（默认 content-box）+ 这里又有内边距的话，
     `width:100%` 会变成「内容宽 100% + 左右内边距」，被 flex 收缩后文字区比渲染态窄 4px 且右移 2px */
  box-sizing: border-box;
  min-height: 26px;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  background: transparent;
  color: var(--fontColor);
  font-family: inherit;
  font-size: var(--be-font, 15px);
  line-height: 1.7;
  /* 上下不留内边距：渲染态（.be-rendered）没有内边距，留了会使首行下沉、块高多 2px */
  padding: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 标题：编辑态字号/行高与渲染态一致，否则点进去文字会突然变小、换行位置也跟着变。
   必须带 .be-t-heading 限定 —— 非标题块也会带上 be-lv-1（level 默认值），否则正文会被命中 */
.be-ta-heading {
  font-weight: 600;
}

.be-t-heading.be-lv-1 .be-textarea { font-size: calc(var(--be-font, 15px) * 1.53); line-height: 1.4; }
.be-t-heading.be-lv-2 .be-textarea { font-size: calc(var(--be-font, 15px) * 1.27); line-height: 1.45; }
.be-t-heading.be-lv-3 .be-textarea { font-size: calc(var(--be-font, 15px) * 1.1); line-height: 1.5; }
.be-t-heading.be-lv-4 .be-textarea,
.be-t-heading.be-lv-5 .be-textarea,
.be-t-heading.be-lv-6 .be-textarea { font-size: var(--be-font, 15px); line-height: 1.7; }

.be-ta-quote {
  opacity: 0.85;
  font-style: italic;
}

.be-ta-code,
.be-ta-math {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13.5px;
  line-height: 1.6;
  background: color-mix(in srgb, var(--fontColor) 6%, transparent);
  border-radius: 4px;
  /* 与渲染态 pre 的 padding 保持一致（6px 10px），切换编辑不跳动 */
  padding: 6px 10px;
}

.be-t-heading {
  padding-top: 6px;
  padding-bottom: 2px;
}

.be-t-code,
.be-t-math {
  padding-top: 2px;
  padding-bottom: 2px;
}

/* 分割线 */
.be-divider {
  flex: 1 1 auto;
  height: 26px;
  margin: 2px 0;
  outline: none;
  cursor: pointer;
  position: relative;
}

.be-divider::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 12px;
  height: 1px;
  background: var(--borderColor);
}

.be-block.be-active .be-divider::after {
  background: var(--fontActiveColor);
}

/* --- 渲染态（空闲时看不到 Markdown 符号） --- */
.be-rendered-wrap {
  position: relative;
}

/* 代码 / mermaid 块右上角操作图标（悬浮显示） */
.be-diagram-actions {
  position: absolute;
  top: 2px;
  right: 4px;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s ease;
  padding: 1px 2px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--backgroundColor) 82%, transparent);
}

.be-block:hover .be-diagram-actions {
  opacity: 1;
}

.be-diagram-actions .be-btn {
  width: 20px;
  height: 20px;
  opacity: 0.65;
}

.be-rendered {
  min-height: 26px;
  cursor: text;
  font-size: var(--be-font, 15px);
  line-height: 1.7;
  color: var(--fontColor);
  overflow-x: auto;
  overflow-y: hidden;
}

.be-rendered :deep(p),
.be-rendered :deep(h1),
.be-rendered :deep(h2),
.be-rendered :deep(h3),
.be-rendered :deep(h4),
.be-rendered :deep(h5),
.be-rendered :deep(h6) {
  margin: 0;
}

/* 标题字号用 em，跟随状态栏的 A- / A+ 一起缩放 */
.be-rendered :deep(.be-h1) { font-size: 1.53em; font-weight: 600; line-height: 1.4; }
.be-rendered :deep(.be-h2) { font-size: 1.27em; font-weight: 600; line-height: 1.45; }
.be-rendered :deep(.be-h3) { font-size: 1.1em; font-weight: 600; line-height: 1.5; }
.be-rendered :deep(.be-h4),
.be-rendered :deep(.be-h5),
.be-rendered :deep(.be-h6) { font-size: 1em; font-weight: 600; }

.be-rendered :deep(.be-ph) {
  opacity: 0.3;
}

.be-rendered :deep(.be-li) {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.be-rendered :deep(.be-li-mark) {
  flex: 0 0 auto;
  width: 16px;
  text-align: center;
  opacity: 0.75;
}

.be-rendered :deep(.be-li-num) {
  width: auto;
  min-width: 16px;
  opacity: 0.85;
}

.be-rendered :deep(.be-todo) {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.be-rendered :deep(.be-todo input) {
  margin: 5px 0 0;
  cursor: pointer;
}

.be-rendered :deep(.is-done) {
  text-decoration: line-through;
  opacity: 0.5;
}

.be-rendered :deep(.be-quote) {
  margin: 0;
  padding: 0 0 0 10px;
  border-left: 3px solid var(--borderColor);
  opacity: 0.85;
  font-style: italic;
}

.be-rendered :deep(.be-hr) {
  border: none;
  border-top: 1px solid var(--borderColor);
  margin: 10px 0;
}

.be-rendered :deep(pre) {
  margin: 2px 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--fontColor) 7%, transparent);
  overflow-x: auto;
  font-size: 0.9em;
  line-height: 1.6;
}

.be-rendered :deep(code) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.be-rendered :deep(p code) {
  background: color-mix(in srgb, var(--fontColor) 9%, transparent);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.92em;
}

.be-rendered :deep(img) {
  max-width: 100%;
  border-radius: 4px;
}

.be-rendered :deep(table) {
  border-collapse: collapse;
  /* em：跟随状态栏的 A- / A+ 一起缩放 */
  font-size: 0.93em;
}

.be-rendered :deep(th),
.be-rendered :deep(td) {
  border: 1px solid var(--borderColor);
  padding: 4px 10px;
}

.be-rendered :deep(.mermaid-wrapper) {
  display: flex;
  justify-content: center;
  overflow: auto;
  max-height: 70vh;
}

.be-rendered :deep(.mermaid-wrapper svg) {
  max-width: 100%;
  flex-shrink: 0;
}

/* 公式：长公式横向滚动的滑块样式由全局 .scoll 提供 */
.be-rendered :deep(.be-math) {
  overflow-x: auto;
  overflow-y: hidden;
}

.be-rendered :deep(.be-table) {
  overflow-x: auto;
  overflow-y: hidden;
}

.be-rendered :deep(.be-mermaid-err),
.be-rendered :deep(.be-render-err) {
  color: #e74c3c;
  font-size: 12px;
}

/* --- 底部状态栏（与 md_read / Edit_Code 一致） --- */
.be-statusbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
  box-sizing: border-box;
}

.be-statusbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
}

.be-statusbar .statusbar-item i {
  font-size: 11px;
  opacity: 0.7;
}

.be-statusbar .statusbar-dirty {
  color: #e6a23c;
}

.be-statusbar .statusbar-dirty i {
  font-size: 8px;
}

.be-statusbar .statusbar-spacer {
  flex: 1;
}

.be-statusbar .statusbar-btn {
  margin: 0;
  padding: 0 6px;
  width: auto;
  height: 18px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 0.15s;
  flex-shrink: 0;
}

.be-statusbar .statusbar-btn:hover {
  background-color: var(--menuActiveColor);
  opacity: 1;
}

.be-statusbar .statusbar-btn.active {
  color: var(--fontActiveColor);
  opacity: 1;
}

.be-statusbar .statusbar-btn:disabled {
  opacity: 0.35;
  cursor: default;
  pointer-events: none;
}

.be-statusbar .statusbar-btn:disabled:hover {
  background-color: transparent;
}

/* 录音中：红色 + 呼吸（与 md_read 的朗读按钮同款） */
.be-statusbar .statusbar-btn.sb-recording i {
  color: #f56c6c;
  animation: be-sb-pulse 0.9s ease-in-out infinite alternate;
}

@keyframes be-sb-pulse {
  from { opacity: 1; }
  to { opacity: 0.35; }
}

.be-statusbar .statusbar-font-label {
  font-weight: 600;
  font-size: 12px;
  letter-spacing: -0.5px;
}

/* --- 浮层 --- */
.be-slash,
.be-menu {
  position: fixed;
  z-index: 3000;
}

.be-menu {
  min-width: 168px;
  /* 永不超出窗口：超出部分自己滚（主菜单项少，类型列表高时才用得上） */
  max-height: calc(100vh - 16px);
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

/* 「转换为」面板的返回条（之前漏写样式，和菜单项保持一致） */
.be-menu-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.85;
}

.be-menu-head:hover {
  background: color-mix(in srgb, var(--fontActiveColor) 16%, transparent);
  opacity: 1;
}

.be-menu-head i {
  width: 14px;
  font-size: 12px;
  text-align: center;
}

.be-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.be-menu-item:hover {
  background: color-mix(in srgb, var(--fontActiveColor) 16%, transparent);
}

.be-menu-item i {
  width: 14px;
  font-size: 12px;
  opacity: 0.75;
  text-align: center;
}

.be-menu-arrow {
  margin-left: auto;
  width: auto !important;
}

.be-menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--borderColor);
}

.be-danger {
  color: #e74c3c;
}

/* 拖拽幽灵 */
.be-ghost {
  position: fixed;
  z-index: 4000;
  max-width: 420px;
  padding: 4px 10px;
  border-radius: 4px;
  background: var(--menuColor);
  border: 1px solid var(--fontActiveColor);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  color: var(--fontColor);
  font-size: 13px;
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
