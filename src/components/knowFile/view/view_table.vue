<script setup lang="ts">
/**
 * view_table.vue — 表格视图（知识管理「表格」全局视图）
 *
 * 一行 = 当前目录（按「深度」）里的一个条目，一列 = 一个 YAML 属性；单元格直接改 frontmatter。
 * 数据范围默认「只看 Markdown」（与看板 / 日历一致），状态栏可切回「全部」（非 Markdown 整行只读）。
 * `状态` 列的取值与图标取自 statusOptions.ts（与看板 / 日历共用配置），其余列可在列菜单里指定编辑器类型。
 * 列头支持：点击排序（升 / 降 / 清除）、按列取值筛选、拖拽换序、拖右边界调宽、隐藏列；
 * 所有偏好（深度 / 范围 / 列序 / 列宽 / 列类型 / 排序 / 筛选）持久化在 `table-view-*`。
 * 单元格：单击或 Enter 进入编辑，Esc 取消，Tab / 方向键移动，Delete 清空该属性；
 * 行首复选框多选后可批量设置 / 删除属性、删除文件；单元格可整块粘贴 Excel 数据。
 *
 * ⚠ 编辑器类型不再只靠「属性名猜」：类型不明时按该列首个非空值推断，用户改过就记住。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { statusList, statusIconFor } from '@/lib/knowFile/statusOptions'
import { FILE_VIEWS, supportsOfficeView } from '@/lib/knowFile/fileViews'
import { parseSearchQuery, matchSearchTerms, searchTextTerms, searchTextOf } from '@/lib/knowFile/itemSearch'

const store = usestore()
const zh = (): boolean => store.locales === 'zh'
const ipc = (ch: string, ...args: any[]) => window.ipcRenderer.invoke(ch, ...args)

// ============ 列类型 ============
type ColType = 'text' | 'number' | 'date' | 'datetime' | 'checkbox' | 'color' | 'select' | 'tags'

const COL_TYPES: { key: ColType; name: string; labelEn: string; icon: string }[] = [
  { key: 'text', name: '文本', labelEn: 'Text', icon: 'fa fa-font' },
  { key: 'number', name: '数字', labelEn: 'Number', icon: 'fa fa-sort-numeric-asc' },
  { key: 'date', name: '日期', labelEn: 'Date', icon: 'fa fa-calendar-o' },
  { key: 'datetime', name: '日期时间', labelEn: 'Date & time', icon: 'fa fa-clock-o' },
  { key: 'checkbox', name: '复选框', labelEn: 'Checkbox', icon: 'fa fa-check-square-o' },
  { key: 'color', name: '颜色', labelEn: 'Color', icon: 'fa fa-tint' },
  { key: 'select', name: '单选', labelEn: 'Select', icon: 'fa fa-list-ul' },
  { key: 'tags', name: '标签', labelEn: 'Tags', icon: 'fa fa-tags' },
]
const colTypeDef = (t: ColType) => COL_TYPES.find((x) => x.key === t) || COL_TYPES[0]
const colTypeLabel = (t: ColType) => (zh() ? colTypeDef(t).name : colTypeDef(t).labelEn)

/** `状态` 属性：默认用「单选」编辑器（取值来自状态分类配置） */
const STATUS_FIELD = '状态'
/** 筛选面板里代表「未设置」的伪取值 */
const MISSING = '\u0000__missing__'

// ============ 偏好（localStorage） ============
const PREF = {
  deep: 'table-view-deep',
  mdOnly: 'table-view-md-only',
  order: 'table-view-col-order',
  hidden: 'table-view-col-hidden',
  widths: 'table-view-col-widths',
  types: 'table-view-col-types',
  sort: 'table-view-sort',
  filters: 'table-view-filters',
  /** 用户显式加进表格的列（当前数据里可能还没这个属性） */
  added: 'table-view-col-added',
}
function prefGet<T>(key: string, def: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? def : (JSON.parse(raw) as T)
  } catch {
    return def
  }
}
function prefSet(key: string, value: any) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 配额 / 隐私模式失败忽略 */
  }
}

const deep = ref<number>(prefGet(PREF.deep, 1))
const mdOnly = ref<boolean>(prefGet(PREF.mdOnly, true))
const colOrder = ref<string[]>(prefGet<string[]>(PREF.order, []))
const colHidden = ref<string[]>(prefGet<string[]>(PREF.hidden, []))
const colWidths = ref<Record<string, number>>(prefGet(PREF.widths, {}))
const colTypes = ref<Record<string, ColType>>(prefGet(PREF.types, {}))
const sort = ref<{ field: string; dir: 'asc' | 'desc' } | null>(prefGet(PREF.sort, null))
const colFilters = ref<Record<string, string[]>>(prefGet(PREF.filters, {}))
/** 用户显式添加的列（见 deriveKeys 注释） */
const colAdded = ref<string[]>(prefGet<string[]>(PREF.added, []))

// ============ 数据 ============
const files = ref<any[]>([])
const attrKeys = ref<string[]>([])
// 搜索词来自顶部工具栏（explorer 里统一渲染，各全局视图共用一份）
const searchQuery = computed(() => store.knowQuery)
const wrapEl = ref<HTMLElement | null>(null)

const isMdFile = (item: any): boolean => {
  const ext = String(item?.extension || '').toLowerCase()
  const label = String(item?.label || '').toLowerCase()
  return ext === '.md' || label.endsWith('.md')
}
const isFolder = (item: any): boolean => item?.type === 'folder' || item?.extension === 'folder'
/** 可编辑 = Markdown 文件（文件夹与其它格式只读） */
const isEditable = (item: any): boolean => !!item && !isFolder(item) && isMdFile(item)
const keyOf = (item: any): string => String(item?.path || item?.label || '')

const init = async () => {
  const dir = store.dataDir
  if (!dir) {
    files.value = []
    attrKeys.value = []
    return
  }
  try {
    const list = await ipc('getFiles', dir, deep.value)
    files.value = Array.isArray(list) ? list : []
  } catch (e) {
    console.error('读取表格数据失败:', e)
    files.value = []
  }
  deriveKeys()
}

/** 数据范围（只看 Markdown / 全部）——列集合按它推导，避免开关范围时列跳变 */
const rangeRows = computed(() => files.value.filter((f) => !mdOnly.value || isMdFile(f)))

/**
 * 重新推导属性列。
 *
 * 列集合只来自 **当前扫描范围内的数据**（`rangeRows`，即「深度」范围内的条目）+ **用户显式添加的列**：
 * 这样改「深度」或换目录时列会跟着变，不会残留只有更深层 / 别的目录才有的属性（那些列整列都是空的）。
 * 用户配置过的列（列序 / 列宽 / 类型 / 筛选）不再当成列，而是留在 `orphanKeys` 里供一键加回，
 * 数据再出现时也能自动恢复原来的宽度与类型。
 */
function deriveKeys() {
  const keys = new Set<string>()
  for (const row of rangeRows.value) {
    const attrs = row?.attributes
    if (!attrs || typeof attrs !== 'object') continue
    for (const k of Object.keys(attrs)) {
      if (String(k).trim()) keys.add(k)
    }
  }
  for (const k of colAdded.value) {
    if (k && String(k).trim()) keys.add(k)
  }
  attrKeys.value = [...keys]
}

/** 之前配置过、但当前扫描范围里没有的属性（列显隐面板里可一键加回来） */
const orphanKeys = computed(() => {
  const known = new Set(attrKeys.value)
  const set = new Set<string>()
  for (const src of [
    colOrder.value,
    Object.keys(colTypes.value),
    Object.keys(colWidths.value),
    Object.keys(colFilters.value),
  ]) {
    for (const k of src || []) {
      if (k && String(k).trim() && !known.has(k)) set.add(k)
    }
  }
  return [...set].sort(defaultKeySort)
})

/** 该属性在当前范围里是否有任何值（用于判断「显式添加的空列」能否移除） */
const colHasData = (key: string): boolean =>
  rangeRows.value.some((r) => r?.attributes?.[key] !== undefined && r?.attributes?.[key] !== null && r?.attributes?.[key] !== '')

/** 把属性加进表格（显式添加：当前数据里没有也保留，便于先建列再填值） */
function addCol(key: string) {
  const k = String(key || '').trim()
  if (!k) return
  if (!colAdded.value.includes(k)) {
    colAdded.value = [...colAdded.value, k]
    prefSet(PREF.added, colAdded.value)
  }
  if (colHidden.value.includes(k)) toggleColHidden(k)
  deriveKeys()
}

/** 手动添加一列：输入属性名（已存在则直接取消隐藏） */
async function promptAddCol() {
  try {
    const { value } = await ElMessageBox.prompt(zh() ? '要显示的属性名（不存在时会先建一个空列）：' : 'Attribute name to show:', zh() ? '添加属性列' : 'Add column', {
      confirmButtonText: zh() ? '添加' : 'Add',
      cancelButtonText: zh() ? '取消' : 'Cancel',
      inputPattern: /\S/,
      inputErrorMessage: zh() ? '名称不能为空' : 'Required',
    })
    addCol(String(value))
  } catch {
    /* 用户取消 */
  }
}

/** 移除「显式添加且当前没有任何值」的空列（不动文件里的属性） */
function removeCol(key: string) {
  colAdded.value = colAdded.value.filter((k) => k !== key)
  prefSet(PREF.added, colAdded.value)
  if (colHidden.value.includes(key)) {
    colHidden.value = colHidden.value.filter((k) => k !== key)
    prefSet(PREF.hidden, colHidden.value)
  }
  deriveKeys()
}

/** 默认列序：常用键优先，其余按名称 */
const DEFAULT_KEY_ORDER = [STATUS_FIELD, '颜色', '开始时间', '结束时间', '截止时间', '优先级', '标签']
function defaultKeySort(a: string, b: string): number {
  const ia = DEFAULT_KEY_ORDER.indexOf(a)
  const ib = DEFAULT_KEY_ORDER.indexOf(b)
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  }
  return a.localeCompare(b, 'zh')
}

// ============ 列 ============
interface Col {
  key: string
  type: ColType
}

/** 该列首个非空值（用于推断编辑器类型） */
function sampleValue(key: string): any {
  for (const row of rangeRows.value) {
    const v = row?.attributes?.[key]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

/** 按值（不按属性名硬编码）推断编辑器类型 */
function inferColType(key: string, value: any): ColType {
  if (key === STATUS_FIELD) return 'select'
  if (Array.isArray(value)) return 'tags'
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  const s = String(value ?? '').trim()
  if (!s) return /颜色|color/i.test(key) ? 'color' : 'text'
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s)) return 'color'
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date'
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return 'datetime'
  if (s.includes(',') || s.includes('，')) return 'tags'
  if (Number.isFinite(Number(s))) return 'number'
  if (/颜色|color/i.test(key)) return 'color'
  return 'text'
}

const colTypeOf = (key: string): ColType => colTypes.value[key] || inferColType(key, sampleValue(key))

/** 全部列（持久化顺序优先，新键按默认优先级追加） */
const allCols = computed<Col[]>(() => {
  const known = attrKeys.value
  const saved = colOrder.value.filter((k) => known.includes(k))
  const rest = known.filter((k) => !saved.includes(k)).sort(defaultKeySort)
  return [...saved, ...rest].map((key) => ({ key, type: colTypeOf(key) }))
})
const visibleCols = computed<Col[]>(() => allCols.value.filter((c) => !colHidden.value.includes(c.key)))
const hiddenCols = computed<Col[]>(() => allCols.value.filter((c) => colHidden.value.includes(c.key)))

function persistOrder() {
  prefSet(PREF.order, colOrder.value)
}

function setColType(key: string, type: ColType) {
  colTypes.value = { ...colTypes.value, [key]: type }
  prefSet(PREF.types, colTypes.value)
  // 改了类型后旧筛选值可能已无意义，直接清掉该列筛选
  if (colFilters.value[key]) {
    const next = { ...colFilters.value }
    delete next[key]
    colFilters.value = next
    persistFilters()
  }
}

function toggleColHidden(key: string) {
  colHidden.value = colHidden.value.includes(key)
    ? colHidden.value.filter((k) => k !== key)
    : [...colHidden.value, key]
  prefSet(PREF.hidden, colHidden.value)
}
function showAllCols() {
  colHidden.value = []
  prefSet(PREF.hidden, colHidden.value)
}

function colWidth(key: string): number {
  return colWidths.value[key] || 110
}
function persistWidths() {
  prefSet(PREF.widths, colWidths.value)
}

/** 拖右边界调列宽 */
function startResize(key: string, e: MouseEvent) {
  const startX = e.clientX
  const startW = colWidth(key)
  const onMove = (ev: MouseEvent) => {
    const w = Math.max(60, Math.min(600, startW + (ev.clientX - startX)))
    colWidths.value = { ...colWidths.value, [key]: w }
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    persistWidths()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'col-resize'
}

// ---- 拖拽列头换序 ----
const dragCol = ref<string>('')
function onColDragStart(key: string, e: DragEvent) {
  dragCol.value = key
  e.dataTransfer?.setData('text/plain', key)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onColDrop(target: string) {
  const from = dragCol.value
  dragCol.value = ''
  if (!from || from === target) return
  const keys = allCols.value.map((c) => c.key)
  const fi = keys.indexOf(from)
  const ti = keys.indexOf(target)
  if (fi < 0 || ti < 0) return
  keys.splice(fi, 1)
  keys.splice(ti, 0, from)
  colOrder.value = keys
  persistOrder()
}

// ============ 搜索（语法见 lib/knowFile/itemSearch.ts，各视图共用一份） ============
const searchTerms = computed(() => parseSearchQuery(searchQuery.value))
const textTerms = computed(() => searchTextTerms(searchTerms.value))

const hlRe = computed<RegExp | null>(() => {
  const terms = textTerms.value.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return terms.length ? new RegExp('(' + terms.join('|') + ')', 'gi') : null
})
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
/** 搜索命中高亮（先按原文切分再转义，避免破坏标记） */
function hl(text: any): string {
  const s = text == null ? '' : String(text)
  const re = hlRe.value
  if (!re) return esc(s)
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(s)) !== null) {
    out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'
    last = m.index + m[0].length
    if (m[0] === '') re.lastIndex++
  }
  return out + esc(s.slice(last))
}

/** 属性值的展示文本（数组按逗号连接；与 itemSearch 的取值判定保持同一份实现） */
const valueText = searchTextOf

// ============ 筛选 / 排序 ============
const filteredRows = computed(() => {
  const terms = searchTerms.value
  const filters = colFilters.value
  const active = Object.keys(filters).filter((k) => filters[k] && filters[k].length)
  return rangeRows.value.filter((row) => {
    if (!matchSearchTerms(row, terms)) return false
    for (const key of active) {
      const allowed = filters[key]
      const v = valueText(row?.attributes?.[key])
      if (v === '') {
        if (!allowed.includes(MISSING)) return false
      } else if (!allowed.includes(v)) {
        return false
      }
    }
    return true
  })
})

function cellCompare(a: any, b: any): number {
  const av = valueText(a)
  const bv = valueText(b)
  const an = Number(av)
  const bn = Number(bv)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  return av.localeCompare(bv, 'zh', { numeric: true })
}

function rawSortValue(row: any, field: string): any {
  if (field === '_name') return row?.label
  if (field === '_mtime') return row?.mtime
  if (field === '_size') return row?.size
  return row?.attributes?.[field]
}

const displayRows = computed(() => {
  const rows = [...filteredRows.value]
  const s = sort.value
  if (!s) return rows
  const dir = s.dir === 'asc' ? 1 : -1
  rows.sort((a, b) => {
    const av = rawSortValue(a, s.field)
    const bv = rawSortValue(b, s.field)
    const aEmpty = valueText(av) === ''
    const bEmpty = valueText(bv) === ''
    // 空值恒排在最后（否则乘以 -1 后升序里的「排最后」在降序里会变成「排最前」）
    if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1
    return cellCompare(av, bv) * dir
  })
  return rows
})

function persistFilters() {
  const clean: Record<string, string[]> = {}
  for (const k of Object.keys(colFilters.value)) {
    const v = colFilters.value[k]
    if (v && v.length) clean[k] = v
  }
  colFilters.value = clean
  prefSet(PREF.filters, clean)
}
const activeFilterCount = computed(() => Object.keys(colFilters.value).filter((k) => colFilters.value[k]?.length).length)

function toggleSort(field: string) {
  const s = sort.value
  if (!s || s.field !== field) sort.value = { field, dir: 'asc' }
  else if (s.dir === 'asc') sort.value = { field, dir: 'desc' }
  else sort.value = null
  prefSet(PREF.sort, sort.value)
}
function clearSort() {
  sort.value = null
  prefSet(PREF.sort, null)
}
const sortField = computed(() => sort.value?.field || '')

function isSortAsc(field: string): boolean {
  return sort.value?.field === field && sort.value.dir === 'asc'
}

/** 该列的全部取值（含计数）——筛选面板用 */
function distinctValues(key: string): { value: string; count: number }[] {
  const map = new Map<string, number>()
  let missing = 0
  for (const row of rangeRows.value) {
    const s = valueText(row?.attributes?.[key])
    if (s === '') {
      missing++
      continue
    }
    map.set(s, (map.get(s) || 0) + 1)
  }
  const list = [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value, 'zh', { numeric: true }))
  if (missing) list.unshift({ value: MISSING, count: missing })
  return list
}
function toggleFilterValue(key: string, value: string) {
  const cur = colFilters.value[key] || []
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
  colFilters.value = { ...colFilters.value, [key]: next }
  persistFilters()
}
function isFilteredOn(key: string, value: string): boolean {
  return (colFilters.value[key] || []).includes(value)
}
function clearColFilter(key: string) {
  const next = { ...colFilters.value }
  delete next[key]
  colFilters.value = next
  persistFilters()
}
function clearAllFilters() {
  colFilters.value = {}
  persistFilters()
}

// ============ 单元格编辑 ============
const sel = ref<{ r: number; c: number } | null>(null)
const editing = ref(false)
const draft = ref<string>('')

const rowVal = (row: any, key: string): any => row?.attributes?.[key]

function focusEditor() {
  nextTick(() => {
    const el = wrapEl.value?.querySelector<HTMLElement>('td.editing input, td.editing select, td.editing textarea')
    if (!el) return
    el.focus()
    if (el instanceof HTMLInputElement && ['text', 'number', 'search'].includes(el.type)) el.select()
  })
}

function startEdit() {
  const cur = sel.value
  if (!cur) return
  const row = displayRows.value[cur.r]
  const col = visibleCols.value[cur.c]
  if (!row || !col) return
  if (!isEditable(row)) return
  if (col.type === 'checkbox') return // 复选框在只读态直接点，不进编辑态
  const raw = rowVal(row, col.key)
  draft.value = col.type === 'tags' ? (Array.isArray(raw) ? raw.join(', ') : valueText(raw)) : col.type === 'color' ? normalizeColor(raw) : valueText(raw)
  editing.value = true
  focusEditor()
}

function cancelEdit() {
  editing.value = false
}

function normalizeColor(v: any): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v ?? '').trim())
  if (!m) return '#000000'
  let hex = m[1]
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  return '#' + hex.toLowerCase()
}

/** 把编辑器里草稿转成要写入的值（undefined = 删除该属性） */
function draftToValue(col: Col, before: any, raw: string | boolean): any {
  if (col.type === 'checkbox') {
    if (typeof raw === 'boolean') return raw ? true : undefined
    const t = String(raw ?? '').trim().toLowerCase()
    if (!t || ['false', '否', '0', 'no', 'n', '×', '-'].includes(t)) return undefined
    return true
  }
  const s = String(raw ?? '').trim()
  if (s === '') return undefined
  switch (col.type) {
    case 'number': {
      const n = Number(s)
      return Number.isFinite(n) ? n : s
    }
    case 'date':
      return s.slice(0, 10)
    case 'datetime':
      return s.replace(' ', 'T')
    case 'color':
      return normalizeColor(s)
    case 'tags': {
      const arr = s.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean)
      if (!arr.length) return undefined
      // 原来就是数组 → 保持数组形态，避免把 YAML 列表写成字符串
      return Array.isArray(before) ? arr : arr.join(', ')
    }
    default:
      return s
  }
}

function sameValue(a: any, b: any): boolean {
  if (a === b) return true
  const av = a === undefined || a === null ? '' : a
  const bv = b === undefined || b === null ? '' : b
  if (Array.isArray(av) || Array.isArray(bv)) return valueText(av) === valueText(bv)
  return String(av) === String(bv)
}

/** 写入同一文件的多个属性：合并成一次 IPC（saveFileMetadata 会整段重写 YAML 头） */
async function writeRowPatch(row: any, patch: Record<string, any>): Promise<boolean> {
  const config: Record<string, any> = { ...(row.attributes || {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') delete config[k]
    else config[k] = v
  }
  const ok = await ipc('saveFileMetadata', row.path, config)
  if (!ok) {
    ElMessage.error(zh() ? '保存失败（文件不可写或格式异常）' : 'Save failed')
    return false
  }
  row.attributes = config
  return true
}

/** 写入单元格：合并该行属性后整段重写 frontmatter */
async function writeCell(row: any, key: string, value: any): Promise<boolean> {
  const ok = await writeRowPatch(row, { [key]: value })
  if (ok) deriveKeys()
  return ok
}

async function commitEdit() {
  if (!editing.value) return
  const cur = sel.value
  editing.value = false
  if (!cur) return
  const row = displayRows.value[cur.r]
  const col = visibleCols.value[cur.c]
  if (!row || !col) return
  const before = rowVal(row, col.key)
  const next = draftToValue(col, before, draft.value)
  if (sameValue(before, next)) return
  await writeCell(row, col.key, next)
}

/** 复选框在只读态直接切换 */
async function toggleCheckCell(row: any, col: Col, checked: boolean) {
  if (!isEditable(row)) return
  await writeCell(row, col.key, checked ? true : undefined)
}

/** 清空当前单元格对应的属性（Delete 键） */
async function clearSelectedCell() {
  const cur = sel.value
  if (!cur) return
  const row = displayRows.value[cur.r]
  const col = visibleCols.value[cur.c]
  if (!row || !col || !isEditable(row)) return
  if (rowVal(row, col.key) === undefined) return
  const ok = await writeCell(row, col.key, undefined)
  if (ok) ElMessage.success(zh() ? `已清空「${col.key}」` : `Cleared "${col.key}"`)
}

function onCellClick(r: number, ci: number, e: MouseEvent) {
  if (e.detail > 1) return // 双击由行/文件名处理
  wrapEl.value?.focus()
  sel.value = { r, c: ci }
  editing.value = false
  startEdit()
}

/** 表格键盘操作（编辑态与导航态共用；编辑态在输入框里触发后冒泡到这里） */
function onKeydown(e: KeyboardEvent) {
  const cur = sel.value
  if (!cur) return
  if (editing.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void commitEdit().then(() => moveCell(1, 0))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      void commitEdit().then(() => moveCell(0, e.shiftKey ? -1 : 1))
    }
    return
  }
  switch (e.key) {
    case 'ArrowUp':
      moveCell(-1, 0)
      break
    case 'ArrowDown':
      moveCell(1, 0)
      break
    case 'ArrowLeft':
      moveCell(0, -1)
      break
    case 'ArrowRight':
      moveCell(0, 1)
      break
    case 'Tab':
      moveCell(0, e.shiftKey ? -1 : 1)
      break
    case 'Enter':
    case 'F2':
      startEdit()
      break
    case 'Delete':
    case 'Backspace':
      void clearSelectedCell()
      break
    default:
      return
  }
  e.preventDefault()
}

function moveCell(dr: number, dc: number) {
  const rowsLen = displayRows.value.length
  const colsLen = visibleCols.value.length
  if (!rowsLen || !colsLen) return
  const cur = sel.value || { r: 0, c: 0 }
  let r = cur.r + dr
  let c = cur.c + dc
  if (dc !== 0) {
    while (c < 0) {
      c += colsLen
      r -= 1
    }
    while (c >= colsLen) {
      c -= colsLen
      r += 1
    }
  }
  r = Math.max(0, Math.min(rowsLen - 1, r))
  c = Math.max(0, Math.min(colsLen - 1, c))
  sel.value = { r, c }
  nextTick(() => {
    const tr = wrapEl.value?.querySelectorAll('tbody tr')[r] as HTMLElement | undefined
    tr?.scrollIntoView({ block: 'nearest' })
  })
}

// ============ 多选与批量 ============
const picked = ref<string[]>([])
const hasPick = (row: any): boolean => picked.value.includes(keyOf(row))
function togglePick(row: any) {
  const k = keyOf(row)
  picked.value = picked.value.includes(k) ? picked.value.filter((x) => x !== k) : [...picked.value, k]
}
const allPicked = computed(() => displayRows.value.length > 0 && displayRows.value.every((r) => hasPick(r)))
function toggleAll() {
  picked.value = allPicked.value ? [] : displayRows.value.map((r) => keyOf(r))
}
const pickedRows = computed(() => files.value.filter((f) => picked.value.includes(keyOf(f))))

async function batchSetAttr() {
  const rows = pickedRows.value
  if (!rows.length) return
  try {
    const { value: attr } = await ElMessageBox.prompt(zh() ? '要设置的属性名：' : 'Attribute name:', zh() ? '批量设置属性' : 'Set attribute', {
      confirmButtonText: zh() ? '下一步' : 'Next',
      cancelButtonText: zh() ? '取消' : 'Cancel',
      inputPattern: /.+/,
      inputErrorMessage: zh() ? '名称不能为空' : 'Required',
    })
    const key = String(attr).trim()
    const { value: raw } = await ElMessageBox.prompt(
      zh() ? `把「${key}」设为（留空 = 删除该属性）：` : `Set "${key}" to (empty = remove):`,
      zh() ? `批量设置 · ${rows.length} 项` : `Set · ${rows.length} items`,
      { confirmButtonText: zh() ? '写入' : 'Apply', cancelButtonText: zh() ? '取消' : 'Cancel' }
    )
    const col: Col = { key, type: colTypeOf(key) }
    const value = draftToValue(col, undefined, String(raw))
    let done = 0
    for (const row of rows) {
      if (!isEditable(row)) continue
      if (await writeCell(row, key, value)) done++
    }
    ElMessage.success(zh() ? `已更新 ${done} 个文件` : `Updated ${done} files`)
  } catch {
    /* 用户取消 */
  }
}

async function batchDeleteAttr() {
  const rows = pickedRows.value.filter(isEditable)
  if (!rows.length) return
  try {
    const { value: attr } = await ElMessageBox.prompt(zh() ? '要删除的属性名：' : 'Attribute to remove:', zh() ? '批量删除属性' : 'Remove attribute', {
      confirmButtonText: zh() ? '下一步' : 'Next',
      cancelButtonText: zh() ? '取消' : 'Cancel',
      inputPattern: /.+/,
      inputErrorMessage: zh() ? '名称不能为空' : 'Required',
    })
    const key = String(attr).trim()
    const hit = rows.filter((r) => rowVal(r, key) !== undefined)
    if (!hit.length) {
      ElMessage.warning(zh() ? `选中的文件里没有「${key}」` : `"${key}" not found`)
      return
    }
    await ElMessageBox.confirm(zh() ? `将从 ${hit.length} 个文件里删除属性「${key}」，此操作不可撤销。` : `Remove "${key}" from ${hit.length} files?`, zh() ? '确认删除属性' : 'Confirm', { type: 'warning' })
    let done = 0
    for (const row of hit) {
      if (await writeCell(row, key, undefined)) done++
    }
    ElMessage.success(zh() ? `已从 ${done} 个文件删除「${key}」` : `Removed from ${done} files`)
  } catch {
    /* 用户取消 */
  }
}

async function batchDeleteFiles() {
  const rows = pickedRows.value
  if (!rows.length) return
  try {
    await ElMessageBox.confirm(
      zh() ? `确定删除选中的 ${rows.length} 个条目？文件夹会被整体删除，此操作不可恢复。` : `Delete ${rows.length} selected items?`,
      zh() ? '删除文件' : 'Delete files',
      { type: 'warning', confirmButtonText: zh() ? '删除' : 'Delete', cancelButtonText: zh() ? '取消' : 'Cancel' }
    )
  } catch {
    return
  }
  let done = 0
  for (const row of rows) {
    const ok = isFolder(row) ? (await ipc('deleteFolder', row.path))?.success : await ipc('deleteFile', row.path)
    if (ok) {
      done++
      store.closeTabByPath(row.path)
    }
  }
  picked.value = []
  await init()
  ElMessage.success(zh() ? `已删除 ${done} 个条目` : `Deleted ${done} items`)
}

// ============ 粘贴 Excel 数据 ============
function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text/plain') || ''
  if (!text.trim()) return
  const matrix = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').map((line) => line.split('\t'))
  const multi = matrix.length > 1 || matrix[0].length > 1
  if (!multi) return // 单值粘贴交给输入框本身
  const cur = sel.value
  if (!cur) return
  e.preventDefault()
  void pasteBlock(matrix, cur)
}

async function pasteBlock(matrix: string[][], cur: { r: number; c: number }) {
  const cols = visibleCols.value
  const rows = displayRows.value
  const targets: { row: any; col: Col; raw: string }[] = []
  matrix.forEach((line, dr) => {
    line.forEach((raw, dc) => {
      const row = rows[cur.r + dr]
      const col = cols[cur.c + dc]
      if (!row || !col || !isEditable(row)) return
      targets.push({ row, col, raw })
    })
  })
  if (!targets.length) {
    ElMessage.warning(zh() ? '粘贴位置不可写（超出范围或不是 Markdown 文件）' : 'Nothing to paste here')
    return
  }
  const changed = targets.filter((t) => !sameValue(rowVal(t.row, t.col.key), draftToValue(t.col, rowVal(t.row, t.col.key), t.raw)))
  if (!changed.length) return
  const fileCount = new Set(changed.map((t) => keyOf(t.row))).size
  try {
    await ElMessageBox.confirm(
      zh() ? `将写入 ${changed.length} 个单元格（${fileCount} 个文件），继续？` : `Write ${changed.length} cells across ${fileCount} files?`,
      zh() ? '粘贴' : 'Paste',
      { type: 'warning', confirmButtonText: zh() ? '写入' : 'Apply', cancelButtonText: zh() ? '取消' : 'Cancel' }
    )
  } catch {
    return
  }
  let done = 0
  // 同一文件可能被粘贴到多列：按文件合并成一次写盘
  const groups = new Map<string, { row: any; patch: Record<string, any> }>()
  for (const t of changed) {
    const k = keyOf(t.row)
    let g = groups.get(k)
    if (!g) {
      g = { row: t.row, patch: {} }
      groups.set(k, g)
    }
    g.patch[t.col.key] = draftToValue(t.col, rowVal(t.row, t.col.key), t.raw)
  }
  for (const g of groups.values()) {
    if (await writeRowPatch(g.row, g.patch)) done += Object.keys(g.patch).length
  }
  deriveKeys()
  await init()
  ElMessage.success(zh() ? `已写入 ${done} 个单元格` : `Wrote ${done} cells`)
}

// ============ 打开 / 行操作 ============
const openRow = function (row: any) {
  if (!row) return
  // 文件夹：进入该目录（表格与其它全局视图一起切过去）；系统文件管理器在右键菜单里
  if (isFolder(row)) {
    store.knowEnterDir(row.path)
    return
  }
  store.openFileByMode(row)
}
/** 在系统文件管理器里打开该文件夹（文件夹行的右键菜单；表格里点行本身是「进入文件夹」） */
const openFolderInSystem = (row: any) => {
  if (!row) return
  void ipc('openWithSystemApp', row.path)
}
const openInNewWindow = (row: any, view: string) => {
  // 统一走 store.openFileWindow：桌面独立窗口 / 单窗口环境（安卓、网页端）应用内浮层
  store.openFileWindow({ path: row.path, view })
}
const parentDirOf = (p: string): string => {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 0 ? s.slice(0, i) : ''
}
async function revealRow(row: any) {
  await ipc('openInFolder', row.path)
}
async function copyRowPath(row: any) {
  await copyText(String(row.path || ''))
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(zh() ? '已复制' : 'Copied')
  } catch {
    ElMessage.error(zh() ? '复制失败' : 'Copy failed')
  }
}
async function renameRow(row: any) {
  try {
    const { value } = await ElMessageBox.prompt(zh() ? '请输入新名称:' : 'New name:', zh() ? '重命名' : 'Rename', {
      confirmButtonText: zh() ? '确定' : 'OK',
      cancelButtonText: zh() ? '取消' : 'Cancel',
      inputValue: row.label,
      inputPattern: /.+/,
      inputErrorMessage: zh() ? '名称不能为空' : 'Required',
    })
    const name = String(value).trim()
    if (name === row.label) return
    const res = await ipc('renameFile', row.path, name)
    if (res?.success) {
      await init()
      ElMessage.success(zh() ? '重命名成功' : 'Renamed')
    } else {
      ElMessage.error(zh() ? `重命名失败: ${res?.error || ''}` : `Rename failed: ${res?.error || ''}`)
    }
  } catch {
    /* 用户取消 */
  }
}
async function removeRow(row: any) {
  try {
    await ElMessageBox.confirm(
      zh() ? `确定删除「${row.label}」？此操作不可恢复。` : `Delete "${row.label}"?`,
      zh() ? '删除文件' : 'Delete file',
      { type: 'warning', confirmButtonText: zh() ? '删除' : 'Delete', cancelButtonText: zh() ? '取消' : 'Cancel' }
    )
  } catch {
    return
  }
  const ok = isFolder(row) ? (await ipc('deleteFolder', row.path))?.success : await ipc('deleteFile', row.path)
  if (!ok) {
    ElMessage.error(zh() ? '删除失败' : 'Delete failed')
    return
  }
  store.closeTabByPath(row.path)
  await init()
  ElMessage.success(zh() ? '已删除' : 'Deleted')
}
/** 在当前目录新建一个同级 Markdown 文件 */
async function createRow(sameDir?: string) {
  const dir = sameDir || store.dataDir
  if (!dir) {
    ElMessage.warning(zh() ? '请先打开工作区' : 'Open a workspace first')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt(zh() ? '新建 Markdown 文件名：' : 'New Markdown file name:', zh() ? '新建行' : 'New row', {
      confirmButtonText: zh() ? '创建' : 'Create',
      cancelButtonText: zh() ? '取消' : 'Cancel',
      inputValue: '',
      inputPattern: /\S/,
      inputErrorMessage: zh() ? '名称不能为空' : 'Required',
    })
    const name = String(value).trim()
    const fileName = /\.md$/i.test(name) ? name : `${name}.md`
    const path = await ipc('createFile', dir, fileName)
    if (!path) {
      ElMessage.error(zh() ? '创建失败（同名文件已存在或目录不可写）' : 'Create failed')
      return
    }
    await init()
    ElMessage.success(zh() ? `已新建「${fileName}」` : `Created "${fileName}"`)
  } catch {
    /* 用户取消 */
  }
}

// ============ 浮层（列菜单 / 筛选 / 列显隐 / 行右键菜单） ============
interface Pop {
  kind: 'col' | 'filter' | 'cols' | 'row'
  x: number
  y: number
  ci?: number
  row?: any
  /** 向上展开（点状态栏按钮时用：底边贴住按钮顶边） */
  up?: boolean
}
const pop = ref<Pop | null>(null)
const popEl = ref<HTMLElement | null>(null)

// 「新窗口打开」的视图清单：非 Word / Excel / PPT 文件不列「Office 编辑」（与文件窗口的切换器一致）
const popOpenViews = computed(() =>
  FILE_VIEWS.filter((v) => v.key !== 'office' || supportsOfficeView(pop.value?.row?.path)),
)

function openPop(p: Pop) {
  pop.value = p
  nextTick(() => {
    const el = popEl.value
    const cur = pop.value
    if (!el || !cur) return
    const r = el.getBoundingClientRect()
    const x = Math.max(4, Math.min(cur.x, Math.max(4, window.innerWidth - r.width - 4)))
    const rawY = cur.up ? cur.y - r.height : cur.y
    const y = Math.max(4, Math.min(rawY, Math.max(4, window.innerHeight - r.height - 4)))
    pop.value = { ...cur, x, y }
  })
}
const closePop = () => {
  pop.value = null
}
const popCol = computed<Col | null>(() => {
  const p = pop.value
  if (!p || p.ci === undefined) return null
  return visibleCols.value[p.ci] || null
})
const filterOptions = computed(() => (popCol.value ? distinctValues(popCol.value.key) : []))

function openColMenu(ci: number, e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  openPop({ kind: 'col', x: r.left, y: r.bottom + 2, ci })
}
function openFilterPanel(ci: number, e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  openFilterPanelAt(ci, r.left, r.bottom + 2)
}
function openFilterPanelAt(ci: number, x: number, y: number) {
  openPop({ kind: 'filter', x, y, ci })
}
function openColsPanel(e: MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  openPop({ kind: 'cols', x: r.left - 140, y: r.top - 4, up: true })
}
function openRowMenu(e: MouseEvent, row: any) {
  openPop({ kind: 'row', x: e.clientX, y: e.clientY, row })
}

let unbindDismiss: (() => void) | null = null
watch(pop, (open) => {
  unbindDismiss?.()
  unbindDismiss = null
  if (!open) return
  const onDown = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null
    if (t && t.closest('.tv-pop, .context-menu')) return
    closePop()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePop()
  }
  document.addEventListener('mousedown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  unbindDismiss = () => {
    document.removeEventListener('mousedown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
  }
})

/** 菜单项统一入口：先收起浮层，再把「当时」的浮层与列带给动作（避免动作里读到已清空的 pop） */
function runPop(fn: (p: Pop, col: Col | null) => void) {
  const p = pop.value
  const col = popCol.value
  closePop()
  if (p) fn(p, col)
}

// ---- 二级菜单视口回收（列类型 / 行菜单的「新窗口打开」） ----
let activeSubmenuItem: HTMLElement | null = null
function adjustSubmenu(e: MouseEvent) {
  const target = (e.target as HTMLElement).closest('.tv .has-submenu') as HTMLElement | null
  if (!target) {
    activeSubmenuItem = null
    return
  }
  // 仅在首次进入某个二级菜单项时计算，避免在子菜单内部移动时反复翻转（闪烁）
  if (activeSubmenuItem === target) return
  activeSubmenuItem = target
  const submenu = target.querySelector(':scope > .submenu') as HTMLElement | null
  if (!submenu) return
  requestAnimationFrame(() => {
    submenu.classList.remove('submenu-up', 'submenu-left')
    const rect = submenu.getBoundingClientRect()
    if (rect.bottom > window.innerHeight) submenu.classList.add('submenu-up')
    if (rect.right > window.innerWidth) submenu.classList.add('submenu-left')
  })
}

// ---- 重命名属性（批量改 key） ----
async function renameAttr(key: string) {
  const rows = rangeRows.value.filter((r) => isEditable(r) && rowVal(r, key) !== undefined)
  if (!rows.length) return
  try {
    const { value } = await ElMessageBox.prompt(zh() ? `把属性「${key}」改名为：` : `Rename "${key}" to:`, zh() ? '重命名属性' : 'Rename attribute', {
      confirmButtonText: zh() ? '改名' : 'Rename',
      cancelButtonText: zh() ? '取消' : 'Cancel',
      inputValue: key,
      inputPattern: /.+/,
      inputErrorMessage: zh() ? '名称不能为空' : 'Required',
    })
    const next = String(value).trim()
    if (next === key) return
    await ElMessageBox.confirm(zh() ? `将修改 ${rows.length} 个文件的属性名「${key}」→「${next}」。` : `Rename in ${rows.length} files?`, zh() ? '确认' : 'Confirm', { type: 'warning' })
    let done = 0
    for (const row of rows) {
      const attrs = row.attributes || {}
      const rebuilt: Record<string, any> = {}
      for (const k of Object.keys(attrs)) {
        if (k === key) rebuilt[next] = attrs[k]
        else rebuilt[k] = attrs[k]
      }
      const ok = await ipc('saveFileMetadata', row.path, rebuilt)
      if (ok) {
        row.attributes = rebuilt
        done++
      }
    }
    // 列序 / 列类型 / 筛选里的旧名同步到新名
    colOrder.value = colOrder.value.map((k) => (k === key ? next : k))
    persistOrder()
    if (colTypes.value[key]) {
      const t = { ...colTypes.value }
      t[next] = t[key]
      delete t[key]
      colTypes.value = t
      prefSet(PREF.types, t)
    }
    if (colWidths.value[key]) {
      const w = { ...colWidths.value }
      w[next] = w[key]
      delete w[key]
      colWidths.value = w
      persistWidths()
    }
    // 显式添加的列跟着改名（否则改完名会被当成「当前深度内没有的属性」）
    if (colAdded.value.includes(key)) {
      colAdded.value = colAdded.value.map((k) => (k === key ? next : k))
      prefSet(PREF.added, colAdded.value)
    }
    clearColFilter(key)
    if (sort.value?.field === key) {
      sort.value = { field: next, dir: sort.value.dir }
      prefSet(PREF.sort, sort.value)
    }
    deriveKeys()
    ElMessage.success(zh() ? `已在 ${done} 个文件里改名` : `Renamed in ${done} files`)
  } catch {
    /* 用户取消 */
  }
}

// ============ 悬浮提示（跟随鼠标显示文件信息） ============
const tooltipVisible = ref(false)
const tooltipPos = ref({ x: 0, y: 0 })
const tooltipData = ref<any>(null)
let tipSize = { w: 0, h: 0 }
const formatSize = function (size?: number): string {
  if (size == null || size < 0) return ''
  if (size < 1024) return size + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return value.toFixed(1) + ' ' + units[i]
}
const formatTime = function (mtime?: number): string {
  if (!mtime) return ''
  const d = new Date(mtime)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const showTooltip = (e: MouseEvent, row: any) => {
  tooltipData.value = row
  if (!tooltipVisible.value) {
    tooltipVisible.value = true
    nextTick(() => {
      const el = document.querySelector('.table-tooltip') as HTMLElement | null
      if (el) tipSize = { w: el.offsetWidth, h: el.offsetHeight }
      updateTooltipPos(e)
    })
  }
  updateTooltipPos(e)
}
const updateTooltipPos = (e: MouseEvent) => {
  if (!tooltipVisible.value) return
  let x = e.clientX
  let y = e.clientY - tipSize.h
  if (tipSize.w && x + tipSize.w > window.innerWidth - 4) x = e.clientX - tipSize.w
  if (tipSize.h && y < 4) y = e.clientY
  tooltipPos.value = { x: Math.max(4, x), y: Math.max(4, y) }
}
const hideTooltip = () => {
  tooltipVisible.value = false
  tooltipData.value = null
}

// ============ 单元格展示 ============
const cellText = (row: any, col: Col): string => {
  const v = rowVal(row, col.key)
  if (v === undefined || v === null || v === '') return ''
  if (col.type === 'checkbox') return v === true ? '✓' : String(v)
  return valueText(v)
}
const cellMissing = (row: any, col: Col): boolean => {
  const v = rowVal(row, col.key)
  return v === undefined || v === null || v === ''
}
const cellColor = (row: any, col: Col): string => normalizeColor(rowVal(row, col.key))
const tagList = (row: any, col: Col): string[] => {
  const v = rowVal(row, col.key)
  if (Array.isArray(v)) return v.map((x) => String(x))
  return valueText(v).split(/[,，;；]/).map((s) => s.trim()).filter(Boolean)
}
const statusIcon = (row: any, col: Col): string => (col.key === STATUS_FIELD ? statusIconFor(valueText(rowVal(row, col.key))) : '')
/** 单选列的候选值：状态列用状态分类配置，其余用该列已出现的取值 */
function optionsFor(key: string): string[] {
  if (key === STATUS_FIELD) {
    const list = statusList.value.map((o) => o.value)
    for (const row of rangeRows.value) {
      const v = valueText(rowVal(row, key))
      if (v && !list.includes(v)) list.push(v)
    }
    return list
  }
  const set = new Set<string>()
  for (const row of rangeRows.value) {
    const v = valueText(rowVal(row, key))
    if (v) set.add(v)
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
}

/** 读取深度下拉的上限 */
const maxDepth = ref(5)
const getMaxDepth = function (tree: any[], currentDepth = 1): number {
  let max = currentDepth
  for (const node of tree || []) {
    if (node?.children?.length) max = Math.max(max, getMaxDepth(node.children, currentDepth + 1))
  }
  return max
}
watch(
  () => store.tree,
  (val) => {
    if (val && val.length > 0) maxDepth.value = Math.max(getMaxDepth(val), 1)
  },
  { immediate: true }
)
watch([() => store.root, () => store.path], () => {
  void init()
})
watch(deep, () => {
  prefSet(PREF.deep, deep.value)
  void init()
})
// 顶部工具栏的「刷新」：重新拉取当前目录
watch(() => store.knowRefreshTick, () => {
  void init()
})
watch(mdOnly, () => {
  prefSet(PREF.mdOnly, mdOnly.value)
  deriveKeys()
  picked.value = []
  sel.value = null
})
watch(displayRows, (rows) => {
  if (!rows.length) {
    sel.value = null
    return
  }
  const cur = sel.value
  if (!cur) return
  if (cur.r >= rows.length) sel.value = { r: rows.length - 1, c: cur.c }
})
// 列数变化时把光标夹回范围内（可见列被隐藏 / 属性被删空）
watch(visibleCols, (cols) => {
  if (!sel.value) return
  const max = Math.max(0, cols.length - 1)
  if (sel.value.c > max) sel.value = { r: sel.value.r, c: max }
})

onMounted(() => {
  void init()
})
onBeforeUnmount(() => {
  unbindDismiss?.()
  document.body.style.cursor = ''
})
</script>

<template>
  <div class="bg tv" @mousemove="adjustSubmenu">
    <!-- 顶部工具栏（路径面包屑 + 搜索）由 explorer.vue 统一渲染一条 -->
    <!-- 表格主体 -->
    <div
      ref="wrapEl"
      class="tab_content scoll"
      tabindex="0"
      @keydown="onKeydown"
      @paste="onPaste"
      @contextmenu.prevent
    >
      <table>
        <thead>
          <tr>
            <th class="fx fx-pick">
              <input type="checkbox" :checked="allPicked" @change="toggleAll" :title="zh() ? '全选 / 取消（当前筛选结果）' : 'Select all'" />
            </th>
            <th class="fx fx-idx">#</th>
            <th class="fx fx-act"></th>
            <th class="fx fx-name">
              <div class="th" @click="toggleSort('_name')">
                <span class="th-label" :title="zh() ? '按文件名排序' : 'Sort by name'">{{ zh() ? '文件名' : 'Name' }}</span>
                <i v-if="sortField === '_name'" class="th-sort fa" :class="isSortAsc('_name') ? 'fa-sort-asc' : 'fa-sort-desc'"></i>
              </div>
            </th>
            <th
              v-for="(col, ci) in visibleCols"
              :key="col.key"
              class="col"
              :class="{ dragging: dragCol === col.key }"
              :style="{ width: colWidth(col.key) + 'px', minWidth: colWidth(col.key) + 'px', maxWidth: colWidth(col.key) + 'px' }"
              draggable="true"
              @dragstart="onColDragStart(col.key, $event)"
              @dragover.prevent
              @drop="onColDrop(col.key)"
              @dragend="dragCol = ''"
            >
              <div class="th">
                <i class="th-type fa" :class="colTypeDef(col.type).icon" :title="colTypeLabel(col.type)"></i>
                <span class="th-label" :title="col.key" @click="toggleSort(col.key)">
                  {{ col.key }}<i v-if="sortField === col.key" class="th-sort fa" :class="isSortAsc(col.key) ? 'fa-sort-asc' : 'fa-sort-desc'"></i>
                </span>
                <i
                  v-if="colFilters[col.key] && colFilters[col.key].length"
                  class="th-filter-on fa fa-filter"
                  :title="zh() ? '已筛选（点击修改）' : 'Filtered'"
                  @click.stop="openFilterPanel(ci, $event)"
                ></i>
                <i class="th-btn fa fa-caret-down" :title="zh() ? '列操作' : 'Column'" @click.stop="openColMenu(ci, $event)"></i>
              </div>
              <div class="th-resize" :title="zh() ? '拖动调整列宽' : 'Resize'" @mousedown.stop.prevent="startResize(col.key, $event)"></div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, r) in displayRows"
            :key="keyOf(row)"
            :class="{ picked: hasPick(row), focused: sel && sel.r === r }"
            @contextmenu.prevent.stop="openRowMenu($event, row)"
          >
            <td class="fx fx-pick">
              <input type="checkbox" :checked="hasPick(row)" @click.stop @change="togglePick(row)" />
            </td>
            <td class="fx fx-idx" :title="row.path">{{ r + 1 }}</td>
            <td class="fx fx-act">
              <i :class="store.icon(row.extension)" class="row-open" @click.stop="openRow(row)" :title="isFolder(row) ? (zh() ? '进入此文件夹' : 'Open folder') : (zh() ? '打开文件' : 'Open file')"></i>
            </td>
            <td class="fx fx-name" @mouseover="showTooltip($event, row)" @mousemove="updateTooltipPos($event)" @mouseleave="hideTooltip" @dblclick="openRow(row)">
              <span class="filename-text" v-html="hl(row.label)"></span>
            </td>
            <td
              v-for="(col, ci) in visibleCols"
              :key="col.key"
              class="tv-cell"
              :class="{
                editing: editing && sel && sel.r === r && sel.c === ci,
                focused: !editing && sel && sel.r === r && sel.c === ci,
                readonly: !isEditable(row),
                missing: cellMissing(row, col),
                'cell-select': col.type === 'select',
              }"
              @click="onCellClick(r, ci, $event)"
            >
              <!-- 编辑态 -->
              <template v-if="editing && sel && sel.r === r && sel.c === ci && isEditable(row)">
                <select v-if="col.type === 'select'" v-model="draft" @change="commitEdit" @blur="commitEdit">
                  <option value="">{{ zh() ? '未设置' : 'Unset' }}</option>
                  <option v-for="v in optionsFor(col.key)" :key="v" :value="v">{{ v }}</option>
                </select>
                <input
                  v-else-if="col.type === 'color'"
                  type="color"
                  v-model="draft"
                  @change="commitEdit"
                  @blur="commitEdit"
                />
                <input
                  v-else
                  :type="col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : col.type === 'datetime' ? 'datetime-local' : 'text'"
                  v-model="draft"
                  @blur="commitEdit"
                  :placeholder="col.type === 'tags' ? (zh() ? '逗号分隔' : 'comma separated') : ''"
                />
              </template>
              <!-- 只读态 -->
              <template v-else>
                <!-- 复选框列：直接点即写 -->
                <input
                  v-if="col.type === 'checkbox'"
                  class="cell-check"
                  type="checkbox"
                  :checked="rowVal(row, col.key) === true"
                  :disabled="!isEditable(row)"
                  @click.stop
                  @change="toggleCheckCell(row, col, ($event.target as HTMLInputElement).checked)"
                  :title="rowVal(row, col.key) === true ? 'true' : rowVal(row, col.key) === false ? 'false' : (zh() ? '未设置' : 'unset')"
                />
                <span v-else-if="col.type === 'color'" class="cell-color" :title="cellText(row, col)">
                  <i :style="{ background: cellColor(row, col) }"></i>{{ cellText(row, col) }}
                </span>
                <span v-else-if="col.type === 'tags'" class="cell-tags">
                  <span v-for="t in tagList(row, col)" :key="t" class="cell-tag" v-html="hl(t)"></span>
                  <span v-if="!tagList(row, col).length" class="cell-empty">{{ isEditable(row) ? (zh() ? '点击添加' : '+') : '' }}</span>
                </span>
                <span v-else-if="cellText(row, col)" class="cell-text" :title="cellText(row, col)">
                  <i v-if="statusIcon(row, col)" class="cell-status-icon" :class="statusIcon(row, col)"></i>
                  <span v-html="hl(cellText(row, col))"></span>
                </span>
                <span v-else class="cell-empty">{{ isEditable(row) ? (zh() ? '点击添加' : '+') : '' }}</span>
              </template>
            </td>
          </tr>
          <tr v-if="!displayRows.length" class="empty-row">
            <td :colspan="visibleCols.length + 4" class="empty-cell">
              <div class="empty-state">
                <i class="fa fa-inbox"></i>
                <p>{{ searchQuery || activeFilterCount ? (zh() ? '没有匹配的行' : 'No matching rows') : mdOnly ? (zh() ? '当前目录没有 Markdown 条目' : 'No Markdown here') : (zh() ? '暂无数据' : 'No data') }}</p>
                <p v-if="searchQuery || activeFilterCount" class="search-hint">{{ zh() ? '试试清除搜索或列筛选' : 'Clear search / filters' }}</p>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 批量操作条（有选中行时出现） -->
    <div v-if="picked.length" class="tv-batchbar">
      <span class="statusbar-item"><i class="fa fa-check-square-o"></i> {{ zh() ? '已选' : 'Selected' }} {{ picked.length }}</span>
      <span class="statusbar-sep"></span>
      <button class="statusbar-btn" @click="batchSetAttr"><i class="fa fa-pencil-square-o"></i> {{ zh() ? '设置属性' : 'Set attribute' }}</button>
      <button class="statusbar-btn" @click="batchDeleteAttr"><i class="fa fa-eraser"></i> {{ zh() ? '删除属性' : 'Remove attribute' }}</button>
      <button class="statusbar-btn" @click="batchDeleteFiles"><i class="fa fa-trash-o"></i> {{ zh() ? '删除文件' : 'Delete files' }}</button>
      <span class="statusbar-spacer"></span>
      <button class="statusbar-btn" @click="picked = []"><i class="fa fa-times"></i> {{ zh() ? '清除选择' : 'Clear' }}</button>
    </div>

    <!-- 底部状态栏 -->
    <div class="table-statusbar">
      <span v-if="store.folderName" class="statusbar-item status-folder" :title="store.dataDir" style="max-width:180px"><i class="fa fa-folder-open-o"></i><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ store.folderName }}</span></span>
      <span v-if="store.folderName" class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-filter"></i> {{ zh() ? '范围' : 'Scope' }}</span>
      <select class="statusbar-select" v-model="mdOnly" :title="zh() ? '只显示 Markdown（其余格式只读）' : 'Markdown only'">
        <option :value="true">Markdown</option>
        <option :value="false">{{ zh() ? '全部' : 'All' }}</option>
      </select>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-sitemap"></i> {{ zh() ? '深度' : 'Depth' }}</span>
      <select class="statusbar-select" v-model.number="deep" :title="zh() ? '读取深度' : 'Read depth'">
        <option v-for="d in maxDepth" :key="d" :value="d">{{ d }}</option>
      </select>
      <span class="statusbar-sep"></span>
      <button v-if="sort" class="statusbar-btn" @click="clearSort" :title="zh() ? '清除排序' : 'Clear sort'">
        <i class="fa" :class="isSortAsc(sort.field) ? 'fa-sort-asc' : 'fa-sort-desc'"></i> {{ sort.field === '_name' ? (zh() ? '文件名' : 'Name') : sort.field === '_mtime' ? (zh() ? '修改时间' : 'Modified') : sort.field === '_size' ? (zh() ? '大小' : 'Size') : sort.field }}
        <i class="fa fa-times"></i>
      </button>
      <button v-if="activeFilterCount" class="statusbar-btn" @click="clearAllFilters" :title="zh() ? '清除全部列筛选' : 'Clear filters'">
        <i class="fa fa-filter"></i> {{ zh() ? '筛选' : 'Filter' }} {{ activeFilterCount }} <i class="fa fa-times"></i>
      </button>
      <span class="statusbar-spacer"></span>
      <button class="statusbar-btn" @click="createRow()" :title="zh() ? '在当前目录新建 Markdown 文件' : 'New Markdown file'"><i class="fa fa-plus"></i> {{ zh() ? '行' : 'Row' }}</button>
      <button class="statusbar-btn" @click="openColsPanel" :title="zh() ? '列：显示 / 隐藏（列头可拖动换序）' : 'Columns: show / hide'"><i class="fa fa-columns"></i> {{ visibleCols.length }}<span v-if="hiddenCols.length" class="tv-dim">/{{ allCols.length }}</span></button>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item table-count" :title="zh() ? `共 ${files.length} 个条目` : `Total ${files.length}`">
        <i class="fa fa-list-ol"></i>
        {{ displayRows.length }}<span v-if="displayRows.length !== rangeRows.length" class="tv-dim"> / {{ rangeRows.length }}</span>
      </span>
    </div>

    <!-- 浮层：列菜单 / 筛选 / 列显隐 -->
    <div v-if="pop && (pop.kind === 'col' || pop.kind === 'filter' || pop.kind === 'cols')" class="context-menu tv-pop" ref="popEl" :style="{ left: pop.x + 'px', top: pop.y + 'px' }" @click.stop @contextmenu.prevent>
      <!-- 列菜单 -->
      <template v-if="pop.kind === 'col' && popCol">
        <div class="menu-item" @click="runPop((_p, col) => col && toggleSort(col.key))">
          <i class="fa" :class="isSortAsc(popCol.key) ? 'fa-sort-desc' : 'fa-sort-asc'"></i>
          {{ sortField === popCol.key && isSortAsc(popCol.key) ? (zh() ? '降序' : 'Sort desc') : (zh() ? '升序' : 'Sort asc') }}
        </div>
        <div v-if="sortField === popCol.key" class="menu-item" @click="runPop(() => clearSort())"><i class="fa fa-times"></i> {{ zh() ? '清除排序' : 'Clear sort' }}</div>
        <div class="menu-item" @click="runPop((p) => openFilterPanelAt(p.ci as number, p.x, p.y))">
          <i class="fa fa-filter"></i> {{ zh() ? '筛选此列…' : 'Filter…' }}
        </div>
        <div class="menu-item has-submenu">
          <i class="fa" :class="colTypeDef(popCol.type).icon"></i>
          <span class="menu-label">{{ zh() ? '列类型' : 'Column type' }}</span>
          <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
          <ul class="submenu">
            <li v-for="t in COL_TYPES" :key="t.key" :class="{ current: popCol.type === t.key }" @click="runPop((_p, col) => col && setColType(col.key, t.key))">
              <i class="fa" :class="t.icon"></i>{{ zh() ? t.name : t.labelEn }}
            </li>
          </ul>
        </div>
        <div class="menu-divider"></div>
        <div class="menu-item" @click="runPop((_p, col) => col && toggleColHidden(col.key))"><i class="fa fa-eye-slash"></i> {{ zh() ? '隐藏此列' : 'Hide column' }}</div>
        <div
          v-if="popCol && colAdded.includes(popCol.key) && !colHasData(popCol.key)"
          class="menu-item"
          @click="runPop((_p, col) => col && removeCol(col.key))"
        ><i class="fa fa-trash-o"></i> {{ zh() ? '移除空列（不改文件）' : 'Remove empty column' }}</div>
        <div class="menu-item" @click="runPop((_p, col) => col && renameAttr(col.key))"><i class="fa fa-pencil"></i> {{ zh() ? '重命名属性…' : 'Rename attribute…' }}</div>
        <div class="menu-item" @click="runPop((_p, col) => col && copyText(col.key))"><i class="fa fa-clipboard"></i> {{ zh() ? '复制属性名' : 'Copy key' }}</div>
      </template>

      <!-- 筛选面板 -->
      <template v-else-if="pop.kind === 'filter' && popCol">
        <div class="tv-pop-head">
          <span class="tv-pop-title">{{ zh() ? `筛选「${popCol.key}」` : `Filter "${popCol.key}"` }}</span>
          <button class="statusbar-btn" @click="clearColFilter(popCol.key)" :title="zh() ? '清除该列筛选' : 'Clear'"><i class="fa fa-eraser"></i></button>
          <button class="statusbar-btn" @click="closePop" :title="zh() ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
        </div>
        <div class="tv-filter-list scoll">
          <label v-for="opt in filterOptions" :key="opt.value" class="tv-filter-item">
            <input type="checkbox" :checked="isFilteredOn(popCol.key, opt.value)" @change="toggleFilterValue(popCol.key, opt.value)" />
            <span class="tv-filter-label">{{ opt.value === MISSING ? (zh() ? '（未设置）' : '(unset)') : opt.value }}</span>
            <span class="tv-filter-count">{{ opt.count }}</span>
          </label>
          <div v-if="!filterOptions.length" class="tv-filter-empty">{{ zh() ? '该列没有取值' : 'No values' }}</div>
        </div>
        <div class="tv-pop-hint">{{ zh() ? '不勾选任何项 = 不筛选；勾选多项 = 只显示这些值' : 'None checked = no filter' }}</div>
      </template>

      <!-- 列显隐 -->
      <template v-else-if="pop.kind === 'cols'">
        <div class="tv-pop-head">
          <span class="tv-pop-title">{{ zh() ? '列' : 'Columns' }}</span>
          <button class="statusbar-btn" @click="showAllCols" :title="zh() ? '全部显示' : 'Show all'"><i class="fa fa-eye"></i></button>
          <button class="statusbar-btn" :title="zh() ? '添加属性列' : 'Add column'" @click.stop="promptAddCol"><i class="fa fa-plus"></i></button>
          <button class="statusbar-btn" @click="closePop" :title="zh() ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
        </div>
        <div class="tv-filter-list scoll">
          <label v-for="col in allCols" :key="col.key" class="tv-filter-item">
            <input type="checkbox" :checked="!colHidden.includes(col.key)" @change="toggleColHidden(col.key)" />
            <i class="fa tv-col-type" :class="colTypeDef(col.type).icon"></i>
            <span class="tv-filter-label">{{ col.key }}</span>
            <i
              v-if="colAdded.includes(col.key) && !colHasData(col.key)"
              class="fa fa-trash-o tv-col-remove"
              :title="zh() ? '从表格移除这个空列（不改文件）' : 'Remove this empty column'"
              @click.stop.prevent="removeCol(col.key)"
            ></i>
          </label>
          <div v-if="!allCols.length" class="tv-filter-empty">{{ zh() ? '当前范围没有属性列' : 'No columns' }}</div>
        </div>
        <template v-if="orphanKeys.length">
          <div class="tv-pop-sub">{{ zh() ? '当前深度内没有的属性' : 'Not in this depth' }}</div>
          <div class="tv-filter-list scoll tv-orphans">
            <button v-for="k in orphanKeys" :key="k" class="tv-orphan" :title="zh() ? '加回表格（清空后仍可保留列）' : 'Add back'" @click.stop="addCol(k)">
              <i class="fa fa-plus"></i><span class="tv-filter-label">{{ k }}</span>
            </button>
          </div>
        </template>
        <div class="tv-pop-hint">{{ zh() ? '列按当前「深度」范围内的属性生成；拖动列头可换序，拖右边界可调宽' : 'Columns come from the current depth; drag headers to reorder / resize' }}</div>
      </template>
    </div>

    <!-- 浮层：行右键菜单（样式复用模块统一的紧凑菜单） -->
    <div v-if="pop && pop.kind === 'row'" class="context-menu" ref="popEl" :style="{ left: pop.x + 'px', top: pop.y + 'px' }" @click.stop @contextmenu.prevent>
      <div class="menu-item" @click="runPop((p) => openRow(p.row))"><i class="fa fa-external-link"></i> {{ isFolder(pop.row) ? (zh() ? '进入文件夹' : 'Open folder') : (zh() ? '打开' : 'Open') }}</div>
      <div v-if="isFolder(pop.row)" class="menu-item" @click="runPop((p) => openFolderInSystem(p.row))"><i class="fa fa-folder-open"></i> {{ zh() ? '在系统文件管理器中打开' : 'Open in file manager' }}</div>
      <div v-if="!isFolder(pop.row)" class="menu-item has-submenu">
        <i class="fa fa-window-maximize"></i>
        <span class="menu-label">{{ zh() ? '新窗口打开' : 'Open in new window' }}</span>
        <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li v-for="v in popOpenViews" :key="v.key" @click="runPop((p) => openInNewWindow(p.row, v.key))"><i :class="v.icon"></i> {{ zh() ? v.name : v.labelEn }}</li>
        </ul>
      </div>
      <div class="menu-item" @click="runPop((p) => revealRow(p.row))"><i class="fa fa-folder-open-o"></i> {{ zh() ? '打开文件所在位置' : 'Reveal in folder' }}</div>
      <div class="menu-item" @click="runPop((p) => copyRowPath(p.row))"><i class="fa fa-link"></i> {{ zh() ? '复制文件路径' : 'Copy path' }}</div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="runPop((p) => createRow(parentDirOf(p.row.path)))"><i class="fa fa-plus"></i> {{ zh() ? '新建同级 Markdown' : 'New sibling .md' }}</div>
      <div class="menu-item" @click="runPop((p) => renameRow(p.row))"><i class="fa fa-pencil"></i> {{ zh() ? '重命名…' : 'Rename…' }}</div>
      <div class="menu-divider"></div>
      <div class="menu-item menu-danger" @click="runPop((p) => removeRow(p.row))"><i class="fa fa-trash-o"></i> {{ zh() ? '删除' : 'Delete' }}</div>
    </div>

    <!-- 悬浮提示（跟随鼠标显示文件信息） -->
    <div v-if="tooltipVisible && tooltipData" class="table-tooltip" :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }">
      <div class="tooltip-name">{{ tooltipData.label }}</div>
      <div v-if="tooltipData.type !== 'folder' && tooltipData.size != null">{{ store.locales == 'zh' ? '大小' : 'Size' }}：{{ formatSize(tooltipData.size) }}</div>
      <div v-if="tooltipData.mtime">{{ store.locales == 'zh' ? '修改时间' : 'Modified' }}：{{ formatTime(tooltipData.mtime) }}</div>
    </div>
  </div>
</template>

<style scoped>
.tv {
  position: relative;
}

.tab_content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0;
  background: var(--backgroundColor);
  outline: none;
}

table {
  border-collapse: separate;
  border-spacing: 0;
  /* 列宽由 colgroup 的 px 宽度决定：用 max-content 保持实际像素宽度，
     用 width:100% 会按比例把列拉宽（与拖拽调宽的结果不一致） */
  width: max-content;
  min-width: 100%;
  table-layout: fixed;
}

thead th {
  position: sticky;
  top: 0;
  z-index: 6;
  height: 30px;
  padding: 0;
  background: var(--menuColor);
  border-bottom: 1px solid var(--borderColor);
  font-size: 11px;
  font-weight: 600;
  color: var(--fontColor);
  user-select: none;
}

/* 固定列（表头 + 表体都要左右吸附） */
.fx {
  position: sticky;
  z-index: 5;
  background: var(--backgroundColor);
  /* 全局 `table td, table th` 带 height:24px / padding:5px，会把行撑到 35px 高、
     也让固定列（宽度只有 26~34px）显得很挤，这里统一按表体单元格的 28px / 无内边距对齐 */
  height: 28px;
  padding: 0;
}
thead .fx {
  z-index: 8;
  background: var(--menuColor);
  height: 30px;
}
.fx-pick {
  left: 0;
  width: 26px;
  min-width: 26px;
  max-width: 26px;
  text-align: center;
}
.fx-pick input {
  cursor: pointer;
}
.fx-idx {
  left: 26px;
  width: 34px;
  min-width: 34px;
  max-width: 34px;
  text-align: center;
  color: var(--fontColor);
  opacity: 0.6;
  font-size: 11px;
}
.fx-act {
  left: 60px;
  width: 30px;
  min-width: 30px;
  max-width: 30px;
  text-align: center;
}
.fx-name {
  left: 90px;
  width: 160px;
  min-width: 160px;
  max-width: 160px;
  padding: 0 6px;
  border-right: 1px solid var(--borderColor);
}
.row-open {
  cursor: pointer;
  opacity: 0.75;
  font-size: 12px;
}
.row-open:hover {
  opacity: 1;
  color: var(--fontActiveColor);
}
.filename-text {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}

/* 列头 */
.col {
  position: relative;
}
.col.dragging {
  opacity: 0.5;
}
.th {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 100%;
  padding: 0 4px;
  cursor: pointer;
}
.th-type {
  font-size: 9px;
  opacity: 0.45;
  flex-shrink: 0;
}
.th-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.th-sort {
  margin-left: 2px;
  font-size: 10px;
  color: var(--fontActiveColor);
}
.th-filter-on {
  color: var(--fontActiveColor);
  font-size: 9px;
  flex-shrink: 0;
}
.th-btn {
  font-size: 10px;
  opacity: 0.5;
  flex-shrink: 0;
  padding: 2px;
  border-radius: 3px;
}
.th-btn:hover {
  opacity: 1;
  background: var(--menuActiveColor);
}
.th-resize {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;
}
/* 最后一列的拖宽手柄改为向内：向右突出 3px 会让内容永远比容器宽，
   于是「字段很少、根本不需要滚动」时也一直挂着横向滚动条 */
thead th:last-child .th-resize {
  right: 0;
}

/* 单元格 */
tbody tr {
  height: 28px;
}
tbody tr:hover td {
  background: color-mix(in srgb, var(--menuActiveColor) 45%, transparent);
}
tbody tr.picked td {
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
}
.tv-cell {
  position: relative;
  height: 28px;
  padding: 0 4px;
  font-size: 11px;
  cursor: cell;
  overflow: hidden;
}
.tv-cell.editing,
.tv-cell.focused {
  outline: 1px solid var(--fontActiveColor);
  outline-offset: -1px;
}
.tv-cell.readonly {
  cursor: not-allowed;
}
.cell-text {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cell-status-icon {
  opacity: 0.75;
  flex-shrink: 0;
}
.cell-empty {
  color: var(--borderColor);
  font-size: 10px;
  opacity: 0.7;
}
.cell-check {
  cursor: pointer;
  opacity: 0.9;
}
.tv-cell.missing .cell-check {
  opacity: 0.35;
}
.cell-color {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  white-space: nowrap;
}
.cell-color i {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.cell-tags {
  display: flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
}
.cell-tag {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--menuActiveColor);
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
}
/* 单元格编辑器：全局 `input` / `select` 自带 margin（5px）与固定高度，在 28px 高的单元格里
   会横向撑出单元格（td 是 overflow: hidden，右侧被裁掉），这里统一清零并整格填满、内容居中 */
.tv-cell input,
.tv-cell select {
  width: 100%;
  height: 22px;
  margin: 0;
  padding: 0 4px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  vertical-align: middle;
  outline: none;
  box-sizing: border-box;
}
/* 单选 / 颜色 / 日期类的取值短，居中显示更整齐（文本类保持左对齐便于阅读长内容） */
.tv-cell select,
.tv-cell input[type='date'],
.tv-cell input[type='datetime-local'],
.tv-cell input[type='color'] {
  text-align: center;
}
.tv-cell select {
  text-align-last: center;
}
.tv-cell input[type='color'] {
  padding: 0;
  cursor: pointer;
}

/* 搜索命中高亮：内容由 v-html 渲染，不带 scoped 属性，必须用 :deep() */
:deep(mark) {
  background: color-mix(in srgb, var(--fontActiveColor) 30%, transparent);
  color: inherit;
  border-radius: 2px;
}

.empty-row,
.empty-cell {
  border-bottom: none;
}
.empty-cell {
  text-align: center;
  padding: 40px 20px !important;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--borderColor);
}
.empty-state i {
  font-size: 32px;
  opacity: 0.5;
}
.empty-state p {
  margin: 0;
  font-size: 12px;
}
.search-hint {
  font-size: 11px !important;
  opacity: 0.7;
}

/* 批量操作条 */
.tv-batchbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  flex-shrink: 0;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background: color-mix(in srgb, var(--fontActiveColor) 12%, var(--menuColor));
  border-top: 1px solid var(--borderColor);
  white-space: nowrap;
  overflow: hidden;
}
.tv-batchbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.tv-batchbar .statusbar-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
}
.tv-batchbar .statusbar-spacer {
  flex: 1;
}
.tv-batchbar .statusbar-btn {
  margin: 0;
  padding: 0 6px;
  height: 18px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  opacity: 0.9;
}
.tv-batchbar .statusbar-btn:hover {
  background: var(--menuActiveColor);
  opacity: 1;
}

/* 浮层 */
.tv-pop-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 2px 0 8px;
  border-bottom: 1px solid var(--borderColor);
  margin-bottom: 4px;
}
.tv-pop-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}
.tv-pop-head .statusbar-btn {
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  opacity: 0.7;
  padding: 0 4px;
}
.tv-pop-head .statusbar-btn:hover {
  opacity: 1;
  color: var(--fontActiveColor);
}
.tv-filter-list {
  max-height: 260px;
  overflow-y: auto;
}
.tv-filter-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.tv-filter-item:hover {
  background: var(--menuActiveColor);
}
.tv-filter-item input {
  cursor: pointer;
}
.tv-col-type {
  font-size: 10px;
  opacity: 0.5;
}
/* 面板里「移除空列」的小图标（只在显式添加且无数据时出现） */
.tv-col-remove {
  font-size: 10px;
  opacity: 0.5;
  flex-shrink: 0;
}
.tv-col-remove:hover {
  opacity: 1;
  color: #e74c3c;
}
/* 列面板里的分组小标题（「当前深度内没有的属性」） */
.tv-pop-sub {
  padding: 6px 8px 2px;
  font-size: 10px;
  opacity: 0.55;
  border-top: 1px solid var(--borderColor);
  margin-top: 4px;
}
/* 可一键加回的属性（按钮形态，避免与上面的勾选列表混淆） */
.tv-orphans {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 6px;
  max-height: 120px;
}
.tv-orphan {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--borderColor);
  border-radius: 10px;
  background: transparent;
  color: var(--fontColor);
  font-size: 11px;
  opacity: 0.75;
  cursor: pointer;
  flex: 0 0 auto;
}
.tv-orphan:hover {
  opacity: 1;
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.tv-orphan i {
  font-size: 9px;
  opacity: 0.7;
}
.tv-filter-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-filter-count {
  opacity: 0.55;
  font-size: 11px;
}
.tv-filter-empty {
  padding: 6px 8px;
  opacity: 0.6;
  font-size: 12px;
}
.tv-pop-hint {
  padding: 4px 8px;
  margin-top: 4px;
  border-top: 1px solid var(--borderColor);
  font-size: 11px;
  opacity: 0.6;
}
.tv-dim {
  opacity: 0.6;
}

/* ===== 底部状态栏（与代码编辑/阅读视图一致观感） ===== */
.table-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  box-sizing: border-box;
  flex-shrink: 0;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.table-statusbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
}
.table-statusbar .statusbar-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  flex-shrink: 0;
}
.table-statusbar .statusbar-item i {
  font-size: 11px;
  opacity: 0.7;
}
.table-statusbar .statusbar-spacer {
  flex: 1;
}
.table-statusbar .statusbar-btn {
  margin: 0;
  padding: 0 6px;
  height: 18px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 0.15s;
  flex-shrink: 0;
}
.table-statusbar .statusbar-btn:hover {
  background: var(--menuActiveColor);
  opacity: 1;
}
.table-statusbar .statusbar-select {
  height: 18px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  padding: 0 4px;
  width: auto;
  min-width: 56px;
  max-width: 120px;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
}
.table-statusbar .statusbar-select option {
  background: var(--backgroundColor);
  color: var(--fontColor);
}
.table-statusbar .table-count {
  font-weight: 600;
}

/* 搜索框已移到顶部工具栏（见 ViewToolbar.vue） */

/* 悬浮提示（跟随鼠标显示文件信息） */
.table-tooltip {
  position: fixed;
  z-index: 99999;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  line-height: 1.8;
  white-space: nowrap;
  padding: 6px 10px;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  max-width: calc(60vw / var(--ui-zoom, 1));
}
.table-tooltip .tooltip-name {
  white-space: normal;
  word-break: break-all;
  font-weight: bold;
  color: var(--fontColor);
}
</style>
