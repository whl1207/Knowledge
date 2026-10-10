<script setup lang="ts">
/**
 * view_kanban.vue — 看板视图（知识管理「看板」全局视图）
 *
 * 一个卡片 = 一个 Markdown 文件 + YAML frontmatter：`状态 / 颜色 / 开始时间 / 结束时间 / 归档`。
 * 看板按「分组字段」分列（默认 `状态`，可切换为任意属性），卡片可在列之间拖拽改该属性的值；
 * **顶部的取值筛选与新建默认值都跟随当前分组字段**（切字段时自动清空筛选）。
 * 支持回车快速新建（默认写入 `开始时间 = 今天`，新建后立刻能在日历 / 甘特上看到）、
 * 卡片右键重命名 / 一键归档与看板 / 列表两种形式；
 * `状态` 的分类顺序与图标可在状态栏「状态分类」里自定义（与日历共用，见 statusOptions.ts）。
 * 只读写 frontmatter（`saveFileMetadata` 会整段重写文件头，因此每次都先 `getConfig` 再合并），
 * 日历 / 表格 / 甘特靠同一套属性自动着色、显示状态图标与排期。
 * 数据范围与其它集合视图一致：跟随左侧当前目录（`store.dataDir`），只收纳 Markdown 文件。
 */
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { parseSearchQuery, matchSearchTerms } from '@/lib/knowFile/itemSearch'
import { usestore, parentPathOf } from '@/store'
import {
  stripMdSuffix,
  colorOfAttributes,
  contrastTextColor,
  colorFieldOf,
  colorPresetsFor,
  COLOR_FIELD_DEFAULT,
  FIELD_ARCHIVED,
  isArchivedOf,
  attrDateOf,
  resolveStartFieldOf,
  isTimeishField,
} from '@/lib/knowFile/itemMeta'
// 浮层公用交互：点击外部 / Esc 收起、子菜单溢出翻转（见 lib/knowFile/overlay.ts）
import { bindDismiss, createSubmenuHoverFix } from '@/lib/knowFile/overlay'
import {
  statusList,
  statusIconFor,
  statusKeyOf,
  addStatusOption,
  removeStatusOption,
  moveStatusOption,
  setStatusIcon,
  resetStatusOptions,
  ICON_PRESETS,
  DEFAULT_STATUS_OPTIONS,
} from '@/lib/knowFile/statusOptions'
// 文件系统变更：全局单例订阅 + 目录监听租约（见 lib/knowFile/fileWatch.ts）
import { onFileSystemChanged, acquireFileWatch, releaseFileWatch } from '@/lib/knowFile/fileWatch'

const store = usestore()

const FIELD_STATUS = '状态'
/** 结束字段候选：优先「结束时间」，其次常见别名，最后退回「其它时间类字段」（见 timeRangeOf） */
const END_FIELD_CANDIDATES = ['结束时间', '截止时间', '结束', '到期时间', 'end', 'End', 'due', 'deadline']
/** 未设置状态的列标识 */
const UNSET = ''

const MODE_KEY = 'kanban-view-mode'
const DEPTH_KEY = 'kanban-view-depth'
const ARCHIVED_KEY = 'kanban-view-show-archived'
const FILTER_KEY = 'kanban-view-value-filter'
const HIDE_EMPTY_KEY = 'kanban-view-hide-empty'
const GROUP_KEY = 'kanban-view-group-field'
/** 默认分组字段 */
const FIELD_GROUP_DEFAULT = FIELD_STATUS

const zh = () => store.locales === 'zh'

function readNumber(key: string, def: number): number {
  const n = Number(localStorage.getItem(key))
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : def
}
function readFilter(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(FILTER_KEY) || '[]')
    return Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string') : []
  } catch {
    return []
  }
}

const items = ref<any[]>([])
const deep = ref(readNumber(DEPTH_KEY, 1))
const mode = ref(localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'board')
const showArchived = ref(localStorage.getItem(ARCHIVED_KEY) === '1')
const hideEmpty = ref(localStorage.getItem(HIDE_EMPTY_KEY) !== '0')
/** 分组字段：看板按它的取值分列（默认 状态） */
const groupField = ref(localStorage.getItem(GROUP_KEY) || FIELD_GROUP_DEFAULT)
/** 状态筛选（实为「当前分组字段的取值」筛选）：空数组 = 全部 */
const valueFilter = ref<string[]>(readFilter())
// 搜索词来自顶部工具栏（explorer 里统一渲染，各全局视图共用一份；语法见 lib/knowFile/itemSearch.ts）
const query = computed(() => store.knowQuery)
const searchTerms = computed(() => parseSearchQuery(query.value))
/** 新建卡片时写入的取值（属于当前分组字段；空 = 不写该属性），跟随分组字段自动取第一个取值 */
const newValue = ref(statusList.value[0]?.value || '')
const dragging = ref<any>(null)
const dragOverStatus = ref<string | null>(null)
/** 状态分类编辑器（顺序 / 图标）显隐与新增表单 */
const showStatusEditor = ref(false)
/** 取值筛选面板（状态栏「筛选」按钮弹出） */
const showFilterPanel = ref(false)
const newStatusName = ref('')
const newStatusIcon = ref(ICON_PRESETS[0])

const ipc = (channel: string, ...args: any[]) => window.ipcRenderer.invoke(channel, ...args)

// ============ 数据 ============
const getData = async () => {
  const dir = store.dataDir
  if (!dir) {
    items.value = []
    return
  }
  try {
    const list = (await ipc('getFiles', dir, deep.value)) || []
    // 一张卡片 = 一个 Markdown 文件（文件夹的 frontmatter 在 .README.md 里，且无法写回元数据）
    items.value = list.filter((f: any) => f?.type === 'file' && String(f.extension || '').toLowerCase() === '.md')
  } catch (e) {
    console.error('读取看板卡片失败:', e)
    items.value = []
  }
}

const valueOf = (item: any, field: string) => String(item?.attributes?.[field] ?? '').trim()
const labelOf = (item: any) => stripMdSuffix(item?.label)
const isArchived = (item: any) => isArchivedOf(item?.attributes)
const dateOf = (item: any, field: string): Date | null => attrDateOf(item, field)
const fmtShort = (d: Date) => `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
const fmtDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 开始字段：与日历一致（显式 `开始时间` > 首个时间类字段） */
const startOf = (item: any): Date | null => attrDateOf(item, resolveStartFieldOf(item))

/**
 * 条目的起止时间：开始字段同日历；结束字段优先「结束时间 / 截止时间 / 结束…」等候选，
 * 否则取「与开始字段不同的首个时间类字段」，都没有则只显示开始。
 */
const timeRangeOf = (item: any) => {
  const startField = resolveStartFieldOf(item)
  const start = attrDateOf(item, startField)
  const attrs = item?.attributes || {}
  let endField = ''
  let end: Date | null = null
  for (const f of END_FIELD_CANDIDATES) {
    if (f === startField) continue
    const d = attrDateOf(item, f)
    if (d) { endField = f; end = d; break }
  }
  if (!end) {
    for (const k of Object.keys(attrs)) {
      if (k === startField || !isTimeishField(k)) continue
      const d = attrDateOf(item, k)
      if (d) { endField = k; end = d; break }
    }
  }
  return { start, startField: start ? startField : '', end, endField: end ? endField : '' }
}

/** 卡片 / 列表上的日期文案：`10-08 → 10-10`（单日只显示一个） */
const rangeText = (item: any) => {
  const { start, end } = timeRangeOf(item)
  if (!start && !end) return ''
  if (start && end && start.getTime() !== end.getTime()) return `${fmtShort(start)} → ${fmtShort(end)}`
  return fmtShort((start || end) as Date)
}
/** 日期悬浮提示：写明取自哪个字段 */
const rangeTitle = (item: any) => {
  const { start, startField, end, endField } = timeRangeOf(item)
  const parts: string[] = []
  if (start) parts.push(`${startField}：${fmtDay(start)}`)
  if (end) parts.push(`${endField}：${fmtDay(end)}`)
  return parts.join(' · ')
}
/** 卡片 / 列表行右侧日历图标的悬浮提示：还没设时间时提示「设置」，已有时沿用日期提示（写明字段） */
const dateBtnTitle = (item: any) => {
  const t = rangeTitle(item)
  if (!t) return zh() ? '设置开始 / 结束时间' : 'Set start / end dates'
  return `${t} · ${zh() ? '点击修改时间' : 'Click to edit dates'}`
}
/** 通过归档 / 搜索过滤后的条目（不含状态筛选，用于统计各状态数量） */
const scoped = computed(() => {
  const terms = searchTerms.value
  return items.value.filter((it) => {
    if (!showArchived.value && isArchived(it)) return false
    return matchSearchTerms(it, terms)
  })
})

const matched = computed(() => {
  if (!valueFilter.value.length) return scoped.value
  return scoped.value.filter((it) => valueFilter.value.includes(valueOf(it, groupField.value)))
})

const countOf = (value: string) => scoped.value.filter((it) => valueOf(it, groupField.value) === value).length

/** 分组字段可选项：`状态` 恒在首位，其余属性（含自定义）按字母序 */
const groupFields = computed(() => {
  const found = new Set<string>()
  for (const it of items.value) {
    for (const k of Object.keys(it?.attributes || {})) found.add(k)
  }
  found.delete(FIELD_GROUP_DEFAULT)
  return [FIELD_GROUP_DEFAULT, ...[...found].sort()]
})

/** 当前分组字段下出现过的取值（按字母序；状态分组时改用配置列序） */
const groupValues = computed(() => {
  const found = new Set<string>()
  for (const it of items.value) {
    const v = valueOf(it, groupField.value)
    if (v) found.add(v)
  }
  return [...found].sort()
})

/** 内置默认列序：分类表里没有的取值也按它排，避免出现「已完成」排最前这种莫名其妙的顺序 */
const DEFAULT_STATUS_ORDER = DEFAULT_STATUS_OPTIONS.map((o) => o.value)

/** 分组字段的取值选项：`状态` 用配置列序（状态栏「状态分类」可编辑），其它属性按字母序；文件里的额外取值追加在后 */
const groupValueOptions = computed(() => {
  const discovered = groupValues.value
  if (groupField.value !== FIELD_STATUS) return discovered
  // 状态：先按分类表的顺序（表里没有卡片的取值也占位，便于「隐藏空列」关掉后看到完整列序），
  // 文件里的取值与表里的取值只差不可见字符时按归一化键对到表内位置（否则表里的顺序对它们不生效）
  const rawByKey = new Map<string, string[]>()
  for (const v of discovered) {
    const k = statusKeyOf(v)
    const arr = rawByKey.get(k)
    if (arr) arr.push(v)
    else rawByKey.set(k, [v])
  }
  const out: string[] = []
  const usedKeys = new Set<string>()
  for (const o of statusList.value) {
    const k = statusKeyOf(o.value)
    if (!k || usedKeys.has(k)) continue
    usedKeys.add(k)
    // 有对应取值时用文件里的原值当列（卡片匹配 / 拖拽写回都按原值），否则保留表里的取值占位
    const raws = rawByKey.get(k)
    if (raws) out.push(...raws)
    else out.push(o.value)
  }
  // 表里没有的取值：先按内置默认列序，仍未知的再按字符编码排序
  const extras = discovered.filter((v) => !usedKeys.has(statusKeyOf(v)))
  const builtin = DEFAULT_STATUS_ORDER.filter((v) => extras.includes(v))
  return [...out, ...builtin, ...extras.filter((v) => !builtin.includes(v)).sort()]
})

/** 只出现在文件里、不在分类表里的 `状态` 取值（列序不受表控制，可在「状态分类」里一键加入） */
const unconfiguredStatuses = computed(() => {
  const keys = new Set(statusList.value.map((o) => statusKeyOf(o.value)))
  const found = new Set<string>()
  for (const it of items.value) {
    const v = valueOf(it, FIELD_STATUS)
    if (v && !keys.has(statusKeyOf(v))) found.add(v)
  }
  return [...found].sort()
})

// 换工作区 / 目录后分组字段已不存在时回落到默认，避免整板掉进「未设置」
watch(groupFields, (fields) => {
  if (items.value.length && !fields.includes(groupField.value)) groupField.value = FIELD_GROUP_DEFAULT
})

const columns = computed(() => {
  const field = groupField.value
  const cols = groupValueOptions.value.map((v) => ({ status: v, items: matched.value.filter((it) => valueOf(it, field) === v) }))
  const unset = matched.value.filter((it) => !valueOf(it, field))
  if (unset.length) cols.push({ status: UNSET, items: unset })
  // 隐藏空列时仍保留「新建卡片默认落点」列，作为拖拽改值的可见目标
  const anchor = field === FIELD_STATUS ? statusKeyOf(newValue.value) : ''
  const isAnchor = (status: string) => anchor && statusKeyOf(status) === anchor
  const visible = hideEmpty.value ? cols.filter((c) => c.items.length || isAnchor(c.status)) : cols
  // 一列都没有（目录为空或全被筛掉）时保留一个空列，用于承载提示文案
  return visible.length ? visible : [{ status: UNSET, items: [] }]
})

/** 列表模式排序：有开始时间的按时间升序在前，其余按名称 */
const listItems = computed(() => {
  return [...matched.value].sort((a, b) => {
    const da = startOf(a)
    const db = startOf(b)
    if (da && db && da.getTime() !== db.getTime()) return da.getTime() - db.getTime()
    if (da && !db) return -1
    if (!da && db) return 1
    return labelOf(a).localeCompare(labelOf(b))
  })
})

// ============ 写入 ============
/** 合并写 frontmatter：值为空则删除该字段（其余元数据原样保留） */
const patchMeta = async (path: string, patch: Record<string, any>) => {
  const meta = (await ipc('getConfig', path)) || {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') delete meta[k]
    else meta[k] = v
  }
  return !!await ipc('saveFileMetadata', path, meta)
}

/** 改分组字段的取值（看板拖拽 / 列表改状态共用）；空值 = 删除该属性 */
const setFieldValue = async (item: any, field: string, value: string) => {
  if (valueOf(item, field) === value) return
  const ok = await patchMeta(item.path, { [field]: value || undefined })
  if (!ok) {
    ElMessage.error(zh() ? `${field}写入失败` : `Failed to update ${field}`)
    return
  }
  await getData()
  ElMessage.success(
    value
      ? (zh() ? `已移入「${value}」` : `Moved to "${value}"`)
      : (zh() ? `已清除${field}` : `${field} cleared`)
  )
}

const toggleArchive = async (item: any) => {
  const next = !isArchived(item)
  const ok = await patchMeta(item.path, { [FIELD_ARCHIVED]: next ? true : undefined })
  if (!ok) {
    ElMessage.error(zh() ? '归档写入失败' : 'Failed to update archive')
    return
  }
  await getData()
  ElMessage.success(
    next
      ? (zh() ? '已归档（可在状态栏显示）' : 'Archived')
      : (zh() ? '已取消归档' : 'Unarchived')
  )
}

// ============ 新建卡片面板（状态栏左侧的「+」弹出） ============
const showAddCard = ref(false)
const addNameEl = ref<HTMLInputElement | null>(null)
/** 名称必填；分组字段取值 / 开始 / 结束时间都可留空 */
const addCardName = ref('')
const addStart = ref('')
const addEnd = ref('')

const openAddCard = () => {
  if (!store.dataDir) {
    ElMessage.warning(zh() ? '请先打开工作区' : 'Open a workspace first')
    return
  }
  addCardName.value = ''
  // 开始时间默认今天（可在面板里清空），新建后卡片立刻能在日历 / 甘特上看到
  addStart.value = fmtDay(new Date())
  addEnd.value = ''
  showAddCard.value = true
  nextTick(() => addNameEl.value?.focus())
}
const toggleAddCard = () => {
  if (showAddCard.value) showAddCard.value = false
  else openAddCard()
}

/** 在当前文件夹建一张卡片（`.md`），并按面板里填写的属性写 frontmatter（留空的属性不写） */
const submitAddCard = async () => {
  const dir = store.dataDir
  const name = addCardName.value.trim()
  if (!dir || !name) return
  const fileName = /\.md$/i.test(name) ? name : `${name}.md`
  const path = await ipc('createFile', dir, fileName)
  if (!path) {
    ElMessage.error(zh() ? '创建失败（同名文件已存在或目录不可写）' : 'Create failed (name exists or not writable)')
    return
  }
  const field = groupField.value
  const patch: Record<string, any> = {
    [FIELD_START_DEFAULT]: addStart.value || undefined,
    [FIELD_END_DEFAULT]: addEnd.value || undefined,
  }
  // 分组字段取值（面板里只在该字段不是时间类字段时才给下拉）：写进去新卡片就落在对应的列
  const value = newValue.value
  if (value && !isTimeishField(field)) patch[field] = value
  const ok = await patchMeta(path, patch)
  showAddCard.value = false
  await getData()
  const label = value && !isTimeishField(field) ? `（${field}：${value}）` : ''
  if (!ok) ElMessage.warning(zh() ? `已新建「${fileName}」，但属性写入失败` : `Created "${fileName}" but attribute write failed`)
  else ElMessage.success(zh() ? `已新建「${fileName}」${label}` : `Created "${fileName}" ${label}`)
}

const open = (item: any) => store.openFileByMode(item)

// ============ 状态分类编辑器（顺序 / 图标） ============
const addStatus = () => {
  const name = newStatusName.value.trim()
  if (!name) return
  if (!addStatusOption(name, newStatusIcon.value)) {
    ElMessage.warning(zh() ? '该分类已存在' : 'Category already exists')
    return
  }
  newStatusName.value = ''
  ElMessage.success(zh() ? `已添加「${name}」` : `Added "${name}"`)
}
const removeStatus = (value: string) => {
  removeStatusOption(value)
  ElMessage.success(
    zh() ? `已移除「${value}」（文件里已用的取值仍会作为额外列出现）` : `Removed "${value}"`
  )
}
const resetStatuses = () => {
  resetStatusOptions()
  ElMessage.success(zh() ? '已恢复默认状态分类' : 'Status categories reset')
}

/** 把只存在于文件里的取值加入分类表（加入后即可排序 / 改图标，看板列序随之生效） */
const adoptStatus = (value: string) => {
  if (!addStatusOption(value, statusIconFor(value) || 'fa fa-tag')) {
    ElMessage.warning(zh() ? `「${value}」已在分类表里` : `"${value}" is already in the list`)
    return
  }
  ElMessage.success(zh() ? `已把「${value}」加入状态分类` : `Added "${value}" to categories`)
}

// 浮层收起：点击外部 / Esc（实现见 lib/knowFile/overlay.ts，与日历条目菜单共用）
bindDismiss(showStatusEditor, '.status-editor, .status-editor-btn', () => { showStatusEditor.value = false })
bindDismiss(showFilterPanel, '.filter-panel, .filter-panel-btn', () => { showFilterPanel.value = false })
// 新建卡片面板：点面板外或按 Esc 关闭（点状态栏的「+」由按钮自己切换，故排除在该按钮之外）
bindDismiss(showAddCard, '.kb-card-new, .statusbar-add', () => { showAddCard.value = false })

// ============ 卡片右键菜单 ============
const menu = ref<{ x: number; y: number; item: any } | null>(null)
const menuEl = ref<HTMLElement | null>(null)
bindDismiss(computed(() => !!menu.value), '.kb-menu', () => { menu.value = null })

const openMenu = (e: MouseEvent, item: any) => {
  e.preventDefault()
  e.stopPropagation()
  menu.value = { x: e.clientX, y: e.clientY, item }
  // 贴边时回收到视口内（菜单渲染后再量尺寸）
  nextTick(() => {
    const el = menuEl.value
    if (!el || !menu.value) return
    const r = el.getBoundingClientRect()
    const x = Math.min(menu.value.x, Math.max(4, window.innerWidth - r.width - 4))
    const y = Math.min(menu.value.y, Math.max(4, window.innerHeight - r.height - 4))
    menu.value = { ...menu.value, x, y }
  })
}
/**
 * 菜单项统一入口：先收起菜单再把卡片传给动作（避免操作后菜单残留 / 读到已清空的 menu）。
 * 第二个参数是菜单当时的坐标（「设置时间」要把日期浮层开在菜单位置）。
 */
const runMenu = (fn: (item: any, point: { x: number; y: number }) => any) => {
  const cur = menu.value
  menu.value = null
  if (cur?.item) void fn(cur.item, { x: cur.x, y: cur.y })
}

/** 子菜单溢出检测：右侧或底部空间不足时翻转展开方向（实现见 lib/knowFile/overlay.ts） */
const onMenuHover = createSubmenuHoverFix('.kb-menu')

// ============ 卡片 / 列表行的日期编辑 ============
/** 文件里还没有时间类字段时写回的默认字段名 */
const FIELD_START_DEFAULT = '开始时间'
const FIELD_END_DEFAULT = END_FIELD_CANDIDATES[0]
const dateEdit = ref<{ x: number; y: number; item: any } | null>(null)
const dateEditEl = ref<HTMLElement | null>(null)
const editStartDate = ref('')
const editEndDate = ref('')
/** 打开时的原值：用来跳过「点开又直接保存」这类没有改动的写入 */
let editStartRaw = ''
let editEndRaw = ''
/** 写回的字段名：沿用文件里已有的字段，避免同一个文件写出两套日期字段 */
const editStartField = ref(FIELD_START_DEFAULT)
const editEndField = ref(FIELD_END_DEFAULT)
bindDismiss(computed(() => !!dateEdit.value), '.kb-date-edit', () => { dateEdit.value = null })

/** 日期浮层的锚点定位（渲染后再量尺寸回收进视口） */
const openDatePopover = (x: number, y: number, item: any) => {
  dateEdit.value = { x, y, item }
  nextTick(() => {
    const el = dateEditEl.value
    if (!el || !dateEdit.value) return
    const r = el.getBoundingClientRect()
    dateEdit.value = {
      ...dateEdit.value,
      x: Math.min(dateEdit.value.x, Math.max(4, window.innerWidth - r.width - 4)),
      y: Math.min(dateEdit.value.y, Math.max(4, window.innerHeight - r.height - 4)),
    }
  })
}

/** 在指定位置打开某张卡片的时间编辑器（写回文件里已有的时间字段） */
const openDateEditAt = (x: number, y: number, item: any) => {
  const { start, startField, end, endField } = timeRangeOf(item)
  editStartDate.value = editStartRaw = start ? fmtDay(start) : ''
  editEndDate.value = editEndRaw = end ? fmtDay(end) : ''
  editStartField.value = startField || resolveStartFieldOf(item) || FIELD_START_DEFAULT
  editEndField.value = endField || FIELD_END_DEFAULT
  openDatePopover(x, y, item)
}

/** 点卡片 / 列表行上的日期或卡片右侧的日历图标：改这张卡片的时间 */
const openDateEdit = (e: MouseEvent, item: any) => {
  e.preventDefault()
  e.stopPropagation()
  openDateEditAt(e.clientX, e.clientY, item)
}

const datesChanged = () => editStartDate.value !== editStartRaw || editEndDate.value !== editEndRaw

/** 写回开始 / 结束字段（清空 = 删除该属性，其余元数据原样保留） */
const applyDates = async () => {
  const target = dateEdit.value
  if (!target) return
  const ok = await patchMeta(target.item.path, {
    [editStartField.value]: editStartDate.value || undefined,
    [editEndField.value]: editEndDate.value || undefined,
  })
  if (!ok) {
    ElMessage.error(zh() ? '时间写入失败' : 'Failed to save dates')
    return
  }
  editStartRaw = editStartDate.value
  editEndRaw = editEndDate.value
  await getData()
}
/** 日期选完即应用（与表格视图改单元格一致），浮层保持打开便于接着改另一个 */
const onDateChanged = () => {
  if (datesChanged()) void applyDates()
}
const saveDateEdit = async () => {
  const changed = datesChanged()
  if (changed) await applyDates()
  dateEdit.value = null
  if (changed) ElMessage.success(zh() ? '已更新时间' : 'Dates updated')
}
const clearDateEdit = async () => {
  editStartDate.value = ''
  editEndDate.value = ''
  await saveDateEdit()
}

const copyItemPath = async (item: any) => {
  try {
    await navigator.clipboard.writeText(String(item.path || ''))
    ElMessage.success(zh() ? '已复制文件路径' : 'Path copied')
  } catch {
    ElMessage.error(zh() ? '复制失败' : 'Copy failed')
  }
}
const revealItem = async (item: any) => {
  const dir = parentPathOf(item.path)
  if (!dir) return
  await ipc('openWithSystemApp', dir)
}
/** 重命名卡片对应的文件：提示里填卡片显示名（不带 .md），未写扩展名时自动补回原扩展名 */
const renameItem = async (item: any) => {
  const ext = String(item.extension || '.md')
  const base = labelOf(item)
  try {
    const { value } = await ElMessageBox.prompt(
      zh() ? '请输入新的文件名：' : 'Enter a new file name:',
      zh() ? '重命名' : 'Rename',
      {
        confirmButtonText: zh() ? '确定' : 'OK',
        cancelButtonText: zh() ? '取消' : 'Cancel',
        inputValue: base,
        inputPattern: /[^\s\\/:*?"<>|]/,
        inputErrorMessage: zh() ? '名称不能为空，也不能含 \\ / : * ? " < > |' : 'Name is empty or contains \\ / : * ? " < > |'
      }
    )
    const trimmed = String(value || '').trim()
    if (!trimmed || trimmed === base) return
    const fileName = trimmed.toLowerCase().endsWith(ext.toLowerCase()) ? trimmed : trimmed + ext
    const result = await ipc('renameFile', item.path, fileName)
    if (!result?.success) {
      ElMessage.error(zh() ? `重命名失败：${result?.error || ''}` : `Rename failed: ${result?.error || ''}`)
      return
    }
    await getData()
    ElMessage.success(zh() ? `已重命名为「${stripMdSuffix(fileName)}」` : `Renamed to "${fileName}"`)
  } catch { /* 用户取消 */ }
}

// ---- 卡片颜色（右键菜单） ----
const currentColor = (item: any) => colorOfAttributes(item?.attributes)
/** 预设色板（按主题亮度取一套，与日历条目菜单共用，见 lib/knowFile/itemMeta.ts） */
const COLOR_PRESETS = computed(() => colorPresetsFor(store.UI.backgroundColor))
/** 设置卡片颜色；空值 = 清除（两个可能的字段名一起删，不留下另一个） */
const setColor = async (item: any, value: string) => {
  const patch: Record<string, any> = value
    ? { [colorFieldOf(item?.attributes)]: value }
    : { [COLOR_FIELD_DEFAULT]: undefined, color: undefined }
  const ok = await patchMeta(item.path, patch)
  if (!ok) {
    ElMessage.error(zh() ? '颜色写入失败' : 'Failed to save color')
    return
  }
  await getData()
  ElMessage.success(
    value ? (zh() ? `已设置颜色 ${value}` : `Color set to ${value}`) : (zh() ? '已清除颜色' : 'Color cleared')
  )
}
/** 取色器确认后写入并收起菜单（原生取色器只在确认时触发 change） */
const onCustomColor = async (e: Event, item: any) => {
  const value = (e.target as HTMLInputElement).value
  menu.value = null
  if (value) await setColor(item, value)
}
const removeItem = async (item: any) => {
  try {
    await ElMessageBox.confirm(
      zh() ? `确定删除「${labelOf(item)}」？此操作不可恢复。` : `Delete "${labelOf(item)}"? This cannot be undone.`,
      zh() ? '删除文件' : 'Delete file',
      { type: 'warning', confirmButtonText: zh() ? '删除' : 'Delete', cancelButtonText: zh() ? '取消' : 'Cancel' }
    )
  } catch {
    return
  }
  const ok = !!(await ipc('deleteFile', item.path))
  if (!ok) {
    ElMessage.error(zh() ? '删除失败' : 'Delete failed')
    return
  }
  store.closeTabByPath(item.path)
  await getData()
  ElMessage.success(zh() ? '已删除' : 'Deleted')
}

// ============ 取值筛选 / 拖拽 ============
const isValueOn = (v: string) => !valueFilter.value.length || valueFilter.value.includes(v)
const toggleValueFilter = (v: string) => {
  const cur = valueFilter.value
  if (!cur.length) {
    valueFilter.value = [v]
    return
  }
  valueFilter.value = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
}
const clearValueFilter = () => { valueFilter.value = [] }

const onDragStart = (e: DragEvent, item: any) => {
  dragging.value = item
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(item.path || ''))
  }
}
const onDragEnd = () => {
  dragging.value = null
  dragOverStatus.value = null
}
const onColumnDragOver = (status: string) => {
  if (dragging.value) dragOverStatus.value = status
}
const onColumnDragLeave = (status: string) => {
  if (dragOverStatus.value === status) dragOverStatus.value = null
}
const onColumnDrop = async (value: string) => {
  const item = dragging.value
  const field = groupField.value
  dragOverStatus.value = null
  dragging.value = null
  if (!item) return
  await setFieldValue(item, field, value)
}

/** 卡片配色：有 `颜色` 属性时整卡着色并自动选对比文字色（与日历条目条一致） */
const cardStyle = (item: any): Record<string, string> => {
  const c = colorOfAttributes(item.attributes)
  if (!c) return {}
  return { background: c, borderColor: c, '--kanban-card-fg': contrastTextColor(c) || 'var(--fontColor)' }
}
const cardTitle = (item: any) => {
  const parts = [item.label]
  const v = valueOf(item, groupField.value)
  if (v) parts.push(`${groupField.value}：${v}`)
  const when = rangeTitle(item)
  if (when) parts.push(when)
  return parts.join(' · ')
}

watch(deep, (v) => {
  localStorage.setItem(DEPTH_KEY, String(v))
  getData()
})
watch(showArchived, (v) => localStorage.setItem(ARCHIVED_KEY, v ? '1' : '0'))
watch(hideEmpty, (v) => localStorage.setItem(HIDE_EMPTY_KEY, v ? '1' : '0'))
watch(valueFilter, (v) => localStorage.setItem(FILTER_KEY, JSON.stringify(v)))
watch(mode, (v) => {
  localStorage.setItem(MODE_KEY, v)
  store.resize()
})
watch(groupField, (v) => {
  localStorage.setItem(GROUP_KEY, v)
  // 取值筛选与「新建默认值」都跟着分组字段走，避免留着另一个字段的取值
  valueFilter.value = []
  newValue.value = groupValueOptions.value[0] || ''
  store.resize()
})
// 分类表被编辑（增删 / 调序）后，新建默认值可能已不存在 → 回落到第一个取值
watch(groupValueOptions, (opts) => {
  if (!opts.includes(newValue.value)) newValue.value = opts[0] || ''
})
watch([() => store.root, () => store.path], () => getData())
// 顶部工具栏的「刷新」：重新拉取当前目录
watch(() => store.knowRefreshTick, () => getData())

// ============ 文件变更自动刷新 ============
// frontmatter 在别处被改（表格视图改属性 / 源码编辑保存 / 外部编辑器 / AI 工具写文件）时，
// 卡片的状态、颜色、时间要跟着更新，不必手动点刷新。
let disposeFileWatch: (() => void) | null = null
let watchAcquired = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** fileWatch 已按 400ms 去抖，这里再合并一小段连续写入（多次写只刷新一次） */
const scheduleRefresh = () => {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void getData()
  }, 300)
}

onMounted(() => {
  getData()
  disposeFileWatch = onFileSystemChanged(() => { scheduleRefresh() })
  // 按租约参与目录监听：面板收起或本视图单独显示时也能收到变更
  if (store.roots?.length) {
    watchAcquired = true
    void acquireFileWatch([...store.roots])
  }
})

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  if (disposeFileWatch) {
    disposeFileWatch()
    disposeFileWatch = null
  }
  if (watchAcquired) {
    watchAcquired = false
    releaseFileWatch()
  }
})
</script>

<template>
  <div class="bg">
    <!-- 顶部工具栏（路径面包屑 + 搜索）由 explorer.vue 统一渲染一条；新建卡片入口在下方状态栏左侧的「+」 -->

    <!-- 主体：看板 / 列表 -->
    <div class="kanban-body">
      <div v-if="mode === 'board'" class="board">
        <div
          v-for="col in columns"
          :key="col.status || '__unset'"
          class="column"
          :class="{ 'drag-over': dragOverStatus === col.status }"
          @dragover.prevent="onColumnDragOver(col.status)"
          @dragleave="onColumnDragLeave(col.status)"
          @drop.prevent="onColumnDrop(col.status)"
        >
          <div class="column-head">
            <i :class="statusIconFor(col.status) || (col.status ? 'fa fa-tag' : 'fa fa-question-circle-o')"></i>
            <span class="column-title">{{ col.status || (zh() ? '未设置' : 'Unset') }}</span>
            <span class="column-count">{{ col.items.length }}</span>
          </div>
          <div class="column-body">
            <div
              v-for="item in col.items"
              :key="item.path"
              class="card"
              :class="{ archived: isArchived(item), dragging: dragging && dragging.path === item.path }"
              :style="cardStyle(item)"
              :title="cardTitle(item)"
              draggable="true"
              @dragstart="onDragStart($event, item)"
              @dragend="onDragEnd"
              @click="open(item)"
              @contextmenu="openMenu($event, item)"
            >
              <div class="card-main">
                <div class="card-title">
                  <i :class="store.icon(item.extension)" class="card-icon"></i>
                  <span class="card-label">{{ labelOf(item) }}</span>
                </div>
                <!-- 宽布局：归档图标排在第二行时间的左侧（窄布局时改到日历图标右侧，见 .card-badge-right） -->
                <div class="card-meta" v-if="rangeText(item) || isArchived(item)">
                  <i v-if="isArchived(item)" class="fa fa-archive card-badge card-badge-meta" :title="zh() ? '已归档' : 'Archived'"></i>
                  <span v-if="rangeText(item)" class="card-date" :title="rangeTitle(item)">{{ rangeText(item) }}</span>
                </div>
              </div>
              <!-- 卡片右侧的日历图标：点它设置 / 修改这张卡片的开始 / 结束时间（已有时间时图标常亮） -->
              <button
                class="card-date-btn"
                :class="{ active: !!rangeText(item) }"
                :title="dateBtnTitle(item)"
                @click.stop="openDateEdit($event, item)"
              ><i class="fa fa-calendar-o"></i></button>
              <!-- 窄布局（上下摆放）：归档图标跟在日历图标右侧 -->
              <i v-if="isArchived(item)" class="fa fa-archive card-badge card-badge-right" :title="zh() ? '已归档' : 'Archived'"></i>
            </div>
            <div v-if="!col.items.length" class="column-empty">
              {{ matched.length ? (zh() ? '拖到这里' : 'Drop here') : (items.length ? (zh() ? '当前筛选无结果' : 'No match') : (zh() ? '点左下角的 + 新建卡片' : 'Click + at the bottom left to add a card')) }}
            </div>
          </div>
        </div>
      </div>

      <div v-else class="list">
        <div
          v-for="item in listItems"
          :key="item.path"
          class="row"
          :class="{ archived: isArchived(item) }"
          :style="cardStyle(item)"
          :title="cardTitle(item)"
          @click="open(item)"
          @contextmenu="openMenu($event, item)"
        >
          <i :class="store.icon(item.extension)" class="row-icon"></i>
          
          <span class="row-label">{{ labelOf(item) }}</span>
          <span v-if="rangeText(item)" class="row-date" :title="rangeTitle(item)">{{ rangeText(item) }}</span>
          <button class="row-date-btn" :class="{ active: !!rangeText(item) }" :title="dateBtnTitle(item)" @click.stop="openDateEdit($event, item)"><i class="fa fa-calendar-o"></i></button>
          <i v-if="isArchived(item)" class="fa fa-archive row-badge" :title="zh() ? '已归档' : 'Archived'"></i>
          <select class="row-status" :value="valueOf(item, groupField)" @click.stop @change="setFieldValue(item, groupField, ($event.target as HTMLSelectElement).value)" :title="zh() ? `修改「${groupField}」` : `Change ${groupField}`">
            <option :value="UNSET">{{ zh() ? '未设置' : 'Unset' }}</option>
            <option v-for="v in groupValueOptions" :key="v" :value="v">{{ v }}</option>
          </select>
        </div>
        <div v-if="!listItems.length" class="list-empty">
          {{ items.length ? (zh() ? '当前筛选没有匹配的条目' : 'No item matches the current filter') : (zh() ? '当前目录没有 Markdown 条目（点左下角的 + 新建卡片）' : 'No Markdown items here (click + at the bottom left to add a card)') }}
        </div>
      </div>
    </div>

    <!-- 底部状态栏：文件夹 / 新建 / 分组 / 视图 / 深度 / 筛选 / 归档 / 计数（路径与搜索在顶部工具栏） -->
    <div class="statusbar-wrap">
      <div class="kanban-statusbar">
        <span v-if="store.folderName" class="statusbar-item status-folder sb-wide" :title="store.dataDir" style="max-width:220px"><i class="fa fa-folder-open-o"></i><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ store.folderName }}</span></span>
        <!-- 新建卡片：唯一的添加入口（面板里填名称 + 可选的状态 / 时间），紧跟在「当前文件夹」右侧 -->
        <button v-if="store.dataDir" class="statusbar-btn statusbar-add" :class="{ active: showAddCard }" @click="toggleAddCard" :title="zh() ? '新建卡片（在当前文件夹新建一个 Markdown）' : 'New card (a Markdown file in the current folder)'"><i class="fa fa-plus"></i></button>
        <span v-if="store.folderName" class="statusbar-sep sb-wide"></span>
        <span class="statusbar-item sb-wide" :title="zh() ? '按哪个属性分列（默认 状态）' : 'Group by attribute (default: status)'"><i class="fa fa-tag"></i></span>
        <select class="statusbar-select" v-model="groupField" :title="zh() ? '按哪个属性分列（默认 状态）' : 'Group by attribute (default: status)'">
          <option v-for="f in groupFields" :key="f" :value="f">{{ f }}</option>
        </select>
        <span class="statusbar-sep"></span>
        <span class="statusbar-item sb-wide" :title="zh() ? '看板 / 列表' : 'Board / List'"><i class="fa fa-th-large"></i></span>
        <select class="statusbar-select" v-model="mode" :title="zh() ? '看板 / 列表' : 'Board / List'">
          <option value="board">{{ zh() ? '看板' : 'Board' }}</option>
          <option value="list">{{ zh() ? '列表' : 'List' }}</option>
        </select>
        <span class="statusbar-sep sb-wide"></span>
        <span class="statusbar-item sb-wide" :title="zh() ? '读取深度' : 'Read depth'"><i class="fa fa-sitemap"></i></span>
        <select class="statusbar-select sb-wide" v-model.number="deep" :title="zh() ? '读取深度' : 'Read depth'">
          <option v-for="d in [1, 2, 3, 4, 5]" :key="d" :value="d">L{{ d }}</option>
        </select>
        <button class="statusbar-btn sb-wide" :class="{ active: hideEmpty }" @click="hideEmpty = !hideEmpty" :title="zh() ? '隐藏空列' : 'Hide empty columns'"><i class="fa fa-columns"></i></button>
        <button class="statusbar-btn filter-panel-btn" :class="{ active: !!valueFilter.length }" @click="showFilterPanel = !showFilterPanel" :title="zh() ? `按「${groupField}」的取值筛选（可多选）` : `Filter by values of ${groupField}`">
          <i class="fa fa-filter"></i><span v-if="valueFilter.length" class="filter-count">{{ valueFilter.length }}</span>
        </button>
        <button class="statusbar-btn sb-wide" :class="{ active: showArchived }" @click="showArchived = !showArchived" :title="zh() ? '显示 / 隐藏已归档卡片（右键卡片可归档）' : 'Show / hide archived cards (right-click a card to archive)'"><i class="fa fa-archive"></i></button>
        <span class="statusbar-spacer"></span>
        <span class="statusbar-item"><i class="fa fa-check-square-o"></i> {{ valueFilter.length || query ? `${matched.length} / ${items.length}` : items.length }} {{ zh() ? '项' : 'items' }}</span>
        <button class="statusbar-btn status-editor-btn sb-wide" :class="{ active: showStatusEditor }" @click="showStatusEditor = !showStatusEditor" :title="zh() ? '状态分类：调整顺序 / 图标（看板列序与日历图标共用）' : 'Status categories: order / icon (shared with Calendar)'"><i class="fa fa-tags"></i></button>
        <button class="statusbar-btn sb-wide" @click="getData()" :title="zh() ? '刷新' : 'Refresh'"><i class="fa fa-refresh"></i></button>
      </div>
    </div>

    <!-- 卡片右键菜单（打开 / 重命名 / 设置时间 / 移入取值 / 归档 / 复制路径 / 在文件夹中显示 / 删除）：
         样式取自全局的 .context-menu 紧凑变体（见 style.css 的「知识管理模块：紧凑右键菜单」），
         .kb-menu 仅为脚本里「点击外部关闭」的判定钩子 -->
    <div
      v-if="menu"
      ref="menuEl"
      class="context-menu kb-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
      @mouseover="onMenuHover"
    >
      <div class="menu-item" @click="runMenu((it) => open(it))"><i class="fa fa-external-link"></i>{{ zh() ? '打开' : 'Open' }}</div>
      <div class="menu-item" @click="runMenu((it) => renameItem(it))"><i class="fa fa-pencil"></i>{{ zh() ? '重命名' : 'Rename' }}</div>
      <div class="menu-item" @click="runMenu((it, p) => openDateEditAt(p.x, p.y, it))"><i class="fa fa-calendar-o"></i>{{ zh() ? '设置时间' : 'Set dates' }}</div>
      <div class="menu-item has-submenu">
        <i class="fa fa-tag"></i><span class="menu-label">{{ zh() ? `移入「${groupField}」` : `Set ${groupField}` }}</span><i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <ul class="submenu">
          <li
            v-for="v in groupValueOptions"
            :key="v"
            :class="{ current: valueOf(menu!.item, groupField) === v }"
            @click="runMenu((it) => setFieldValue(it, groupField, v))"
          >{{ v }}</li>
          <li
            :class="{ current: !valueOf(menu!.item, groupField) }"
            @click="runMenu((it) => setFieldValue(it, groupField, UNSET))"
          >{{ zh() ? '未设置' : 'Unset' }}</li>
        </ul>
      </div>
      <!-- 颜色：预设色板（随主题切换，浅色 / 深色各一套）/ 取色器自定义 / 清除（写入 frontmatter，卡片整卡着色 + 自动对比文字色） -->
      <div class="menu-item has-submenu">
        <i class="fa fa-tint"></i><span class="menu-label">{{ zh() ? '颜色' : 'Color' }}</span><i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <div class="submenu">
          <div class="kb-swatches">
            <button
              v-for="c in COLOR_PRESETS"
              :key="c"
              class="kb-swatch"
              :class="{ current: currentColor(menu!.item).toLowerCase() === c }"
              :style="{ background: c }"
              :title="c"
              @click="runMenu((it) => setColor(it, c))"
            ></button>
          </div>
          <label class="kb-color-row" :title="zh() ? '用系统取色器选一个自定义颜色' : 'Pick a custom color with the system picker'">
            <i class="fa fa-eyedropper"></i><span>{{ zh() ? '自定义颜色…' : 'Custom color…' }}</span>
            <span class="kb-color-hex">{{ currentColor(menu!.item) }}</span>
            <input type="color" :value="currentColor(menu!.item) || '#4a90d9'" @click.stop @change="onCustomColor($event, menu!.item)" />
          </label>
          <div class="kb-color-row" @click="runMenu((it) => setColor(it, ''))">
            <i class="fa fa-eraser"></i><span>{{ zh() ? '清除颜色' : 'Clear color' }}</span>
          </div>
        </div>
      </div>
      <div class="menu-item" @click="runMenu((it) => toggleArchive(it))">
        <i class="fa fa-archive"></i>{{ isArchived(menu.item) ? (zh() ? '取消归档' : 'Unarchive') : (zh() ? '归档' : 'Archive') }}
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="runMenu((it) => copyItemPath(it))"><i class="fa fa-clipboard"></i>{{ zh() ? '复制文件路径' : 'Copy path' }}</div>
      <div class="menu-item" @click="runMenu((it) => revealItem(it))"><i class="fa fa-folder-open-o"></i>{{ zh() ? '在文件夹中显示' : 'Reveal in folder' }}</div>
      <div class="menu-item menu-danger" @click="runMenu((it) => removeItem(it))"><i class="fa fa-trash-o"></i>{{ zh() ? '删除' : 'Delete' }}</div>
    </div>

    <!-- 卡片日期编辑器：点卡片 / 列表行上的日期弹出；写回 frontmatter 的开始 / 结束字段 -->
    <div
      v-if="dateEdit"
      ref="dateEditEl"
      class="kb-date-edit"
      :style="{ left: dateEdit.x + 'px', top: dateEdit.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div class="de-head">
        <i class="fa fa-calendar-o"></i>
        <span class="de-title" :title="labelOf(dateEdit.item)">{{ zh() ? '修改时间' : 'Edit dates' }}</span>
        <button class="se-btn" @click="dateEdit = null" :title="zh() ? '关闭 (Esc)' : 'Close (Esc)'"><i class="fa fa-times"></i></button>
      </div>
      <label class="de-row">
        <span class="de-label" :title="editStartField">{{ editStartField }}</span>
        <input class="de-input" type="date" v-model="editStartDate" @change="onDateChanged" @keydown.enter.prevent="saveDateEdit" @keydown.stop />
      </label>
      <label class="de-row">
        <span class="de-label" :title="editEndField">{{ editEndField }}</span>
        <input class="de-input" type="date" v-model="editEndDate" @change="onDateChanged" @keydown.enter.prevent="saveDateEdit" @keydown.stop />
      </label>
      <div class="de-actions">
        <button class="de-btn" :disabled="!editStartDate && !editEndDate" @click="clearDateEdit" :title="zh() ? '清空两个日期（删除这两个属性）' : 'Clear both dates'">
          <i class="fa fa-eraser"></i>{{ zh() ? '清除' : 'Clear' }}
        </button>
        <button class="de-btn primary" @click="saveDateEdit"><i class="fa fa-check"></i>{{ zh() ? '保存' : 'Save' }}</button>
      </div>
    </div>

    <!-- 新建卡片面板：从状态栏左侧的「+」弹出（名称必填；状态 / 开始时间 / 结束时间都可留空） -->
    <div v-if="showAddCard" class="kb-card-new" @click.stop @keydown.stop>
      <div class="de-head">
        <i class="fa fa-plus"></i>
        <span class="de-title">{{ zh() ? '新建卡片' : 'New card' }}</span>
        <button class="se-btn" @click="showAddCard = false" :title="zh() ? '关闭 (Esc)' : 'Close (Esc)'"><i class="fa fa-times"></i></button>
      </div>
      <label class="de-row">
        <span class="de-label" :title="zh() ? '文件名（自动补 .md）' : 'File name (.md is added automatically)'">{{ zh() ? '名称' : 'Name' }}</span>
        <input ref="addNameEl" class="de-input" v-model="addCardName" :placeholder="zh() ? '必填' : 'Required'" @keydown.enter.prevent="submitAddCard" />
      </label>
      <!-- 分组字段不是时间类字段时才给取值下拉（写进去新卡片就落在这一列）；选「不设置」＝留空 -->
      <label class="de-row" v-if="!isTimeishField(groupField)">
        <span class="de-label" :title="zh() ? '写入新卡片的该属性，可留空' : `Written to the new card, may stay empty`">{{ groupField }}</span>
        <select class="de-input" v-model="newValue">
          <option value="">{{ zh() ? '不设置' : 'Unset' }}</option>
          <option v-for="v in groupValueOptions" :key="v" :value="v">{{ v }}</option>
        </select>
      </label>
      <label class="de-row">
        <span class="de-label" :title="zh() ? '可留空' : 'May stay empty'">{{ FIELD_START_DEFAULT }}</span>
        <input class="de-input" type="date" v-model="addStart" />
      </label>
      <label class="de-row">
        <span class="de-label" :title="zh() ? '可留空' : 'May stay empty'">{{ FIELD_END_DEFAULT }}</span>
        <input class="de-input" type="date" v-model="addEnd" />
      </label>
      <div class="de-actions">
        <button class="de-btn" @click="showAddCard = false">{{ zh() ? '取消' : 'Cancel' }}</button>
        <button class="de-btn primary" :disabled="!addCardName.trim()" @click="submitAddCard"><i class="fa fa-check"></i>{{ zh() ? '创建' : 'Create' }}</button>
      </div>
    </div>

    <!-- 取值筛选面板：从状态栏的「筛选」按钮弹出（取值多时自动换行 / 纵向滚动） -->
    <div v-if="showFilterPanel" class="filter-panel">
      <div class="se-head">
        <span class="se-title"><i class="fa fa-filter"></i> {{ zh() ? `筛选「${groupField}」` : `Filter "${groupField}"` }}</span>
        <button class="se-btn" @click="clearValueFilter" :title="zh() ? '清除筛选（显示全部）' : 'Clear filter'"><i class="fa fa-eraser"></i></button>
        <button class="se-btn" @click="showFilterPanel = false" :title="zh() ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
      </div>
      <div class="fp-hint">{{ zh() ? '点击取值多选筛选；不选任何取值 = 显示全部。计数为当前范围内的卡片数。' : 'Click values to filter (multi-select); none selected = show all. Counts are cards in the current scope.' }}</div>
      <div class="fp-values">
        <span class="chip" :class="{ active: !valueFilter.length }" @click="clearValueFilter">
          <i class="fa fa-asterisk"></i> {{ zh() ? '全部' : 'All' }}
        </span>
        <span
          v-for="v in groupValueOptions"
          :key="v"
          class="chip"
          :class="{ active: isValueOn(v), dim: !countOf(v) }"
          @click="toggleValueFilter(v)"
          :title="v"
        >
          <i :class="statusIconFor(v) || 'fa fa-tag'"></i> <span class="chip-text">{{ v }}</span><b>{{ countOf(v) }}</b>
        </span>
      </div>
    </div>

    <!-- 状态分类编辑器：顺序 = 看板（状态分组）列序，图标与日历共用 -->
    <div v-if="showStatusEditor" class="status-editor">
      <div class="se-head">
        <span class="se-title"><i class="fa fa-tags"></i> {{ zh() ? '状态分类' : 'Status categories' }}</span>
        <button class="se-btn" @click="resetStatuses" :title="zh() ? '恢复默认' : 'Reset to defaults'"><i class="fa fa-undo"></i></button>
        <button class="se-btn" @click="showStatusEditor = false" :title="zh() ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
      </div>
      <div class="se-hint">{{ zh() ? '顺序即「状态」分组的列序；图标在看板与日历共用。移除分类不会改动文件里已写的取值（仍会作为额外列出现）。' : 'Order = column order when grouping by status; icons are shared with Calendar. Removing a category never rewrites file values.' }}</div>
      <div class="se-row" v-for="(o, i) in statusList" :key="o.value">
        <i :class="o.icon" class="se-preview"></i>
        <span class="se-name" :title="o.value">{{ o.value }}</span>
        <select class="se-select" :value="o.icon" @change="setStatusIcon(o.value, ($event.target as HTMLSelectElement).value)" :title="zh() ? '图标' : 'Icon'">
          <option v-for="ic in ICON_PRESETS" :key="ic" :value="ic">{{ ic.replace('fa fa-', '') }}</option>
        </select>
        <button class="se-btn" :disabled="i === 0" @click="moveStatusOption(o.value, -1)" :title="zh() ? '上移' : 'Move up'"><i class="fa fa-arrow-up"></i></button>
        <button class="se-btn" :disabled="i === statusList.length - 1" @click="moveStatusOption(o.value, 1)" :title="zh() ? '下移' : 'Move down'"><i class="fa fa-arrow-down"></i></button>
        <button class="se-btn se-del" @click="removeStatus(o.value)" :title="zh() ? '移除' : 'Remove'"><i class="fa fa-trash-o"></i></button>
      </div>
      <div class="se-row se-add">
        <i :class="newStatusIcon" class="se-preview"></i>
        <input v-model="newStatusName" class="se-input" :placeholder="zh() ? '新增分类名称…' : 'New category…'" @keydown.enter="addStatus" @keydown.stop />
        <select class="se-select" v-model="newStatusIcon" :title="zh() ? '图标' : 'Icon'">
          <option v-for="ic in ICON_PRESETS" :key="ic" :value="ic">{{ ic.replace('fa fa-', '') }}</option>
        </select>
        <button class="se-btn se-add-btn" @click="addStatus"><i class="fa fa-plus"></i> {{ zh() ? '添加' : 'Add' }}</button>
      </div>
      <!-- 只出现在文件里的取值：不在分类表里 → 上面的顺序管不到它们，可一键加入分类表 -->
      <template v-if="unconfiguredStatuses.length">
        <div class="se-hint se-extra-hint">
          {{ zh()
            ? '下面这些取值只出现在文件里、不在分类表里，所以上面的顺序管不到它们（目前排在已知取值之后）。加入后即可排序 / 改图标。'
            : 'These values only exist in your files, so the order above does not apply to them (they sit after the known ones). Add them to control order and icon.' }}
        </div>
        <div class="se-row se-extra-row" v-for="v in unconfiguredStatuses" :key="v">
          <i :class="statusIconFor(v) || 'fa fa-tag'" class="se-preview"></i>
          <span class="se-name" :title="v">{{ v }}</span>
          <button class="se-btn se-add-btn" @click="adoptStatus(v)" :title="zh() ? '加入分类表' : 'Add to categories'"><i class="fa fa-plus"></i> {{ zh() ? '加入' : 'Add' }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bg {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--backgroundColor);
  overflow: hidden;
  border-right: 1px solid var(--borderColor);
  box-sizing: border-box;
}

/* 卡片 / 列表行右侧的日历图标：只有点它才设置 / 修改时间（时间文字本身不可点） */
.card-date-btn,
.row-date-btn {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--kanban-card-fg, var(--fontColor));
  font-size: 11px;
  cursor: pointer;
  opacity: 0.45;
  transition: opacity 0.15s, color 0.15s, background-color 0.15s;
}
.card-date-btn:hover,
.card-date-btn.active,
.row-date-btn:hover,
.row-date-btn.active {
  opacity: 1;
  color: var(--fontActiveColor);
}
.card-date-btn:hover,
.row-date-btn:hover {
  background: var(--menuActiveColor);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 7px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 10px;
  color: var(--fontColor);
  font-size: 11px;
  opacity: 0.7;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s, opacity 0.15s;
}
.chip:hover {
  background: var(--menuActiveColor);
  opacity: 1;
}
.chip.active {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background: var(--menuActiveColor);
  opacity: 1;
}
.chip.dim {
  opacity: 0.4;
}
.chip i {
  font-size: 10px;
}
.chip b {
  font-weight: 600;
  opacity: 0.6;
}

/* ===== 主体 ===== */
.kanban-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  overflow: hidden;
  /* 容器查询：让看板按自身可用宽度决定「并排」还是「上下摆放」 */
  container-type: inline-size;
}
.board {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: 5px;
  padding: 5px;
  box-sizing: border-box;
  overflow-x: auto;
  overflow-y: hidden;
}
/* 可用宽度放不下并排两列时（2×220 列宽 + 8 列间距 + 8×2 内边距 = 464px，
   阈值需与 .column 的 flex-basis / .board 的 gap、padding 一起改）改为上下摆放：
   列宽铺满、列高由内容决定，改由整条看板纵向滚动（列内不再各自滚动，避免嵌套滚动条） */
@container (max-width: 464px) {
  .board {
    flex-direction: column;
    overflow-x: hidden;
    overflow-y: auto;
  }
  .board .column {
    flex: 0 0 auto;
  }
  .board .column-body {
    flex: 0 0 auto;
    overflow: visible;
  }
  /* 窄面板下卡片压成一行：标题占满左侧、日期靠右（右侧日历图标位置不变） */
  .board .card .card-main {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .board .card .card-title {
    flex: 1 1 auto;
    min-width: 0;
  }
  .board .card .card-meta {
    flex: 0 0 auto;
    margin-top: 0;
    min-height: 0;
  }
  .board .card .card-date {
    white-space: nowrap;
  }
  /* 窄布局：归档图标从「时间里侧」改到日历图标右侧 */
  .board .card .card-badge-meta {
    display: none;
  }
  .board .card .card-badge-right {
    display: inline-block;
  }
}
.column {
  flex: 0 0 220px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  overflow: hidden;
}
.column.drag-over {
  border-color: var(--fontActiveColor);
  background: var(--menuActiveColor);
}
.column-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--borderColor);
  color: var(--fontActiveColor);
  font-size: 12px;
}
.column-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.column-count {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.6;
}
.column-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 2px;
}
.column-empty {
  margin: 6px;
  padding: 10px 4px;
  border: 1px dashed var(--borderColor);
  border-radius: 4px;
  color: var(--fontColor);
  opacity: 0.35;
  font-size: 11px;
  text-align: center;
}

.card {
  margin: 4px;
  padding: 6px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  color: var(--kanban-card-fg, var(--fontColor));
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  transition: box-shadow 0.15s, transform 0.15s;
  /* 左侧是内容（标题 + 时间），右侧固定一个日历图标 */
  display: flex;
  align-items: center;
  gap: 6px;
}
.card-main {
  flex: 1 1 auto;
  min-width: 0;
}
.card:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.16);
}
.card.archived {
  opacity: 0.55;
}
.card.dragging {
  opacity: 0.4;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  line-height: 1.4;
}
.card-icon {
  font-size: 12px;
  color: var(--kanban-card-fg, var(--fontColor));
  flex-shrink: 0;
}
.card-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-badge {
  font-size: 11px;
  opacity: 0.75;
  flex-shrink: 0;
}
/* 窄布局用的那一份归档图标默认不显示（宽布局只留第二行时间里侧的那一份） */
.card-badge-right {
  display: none;
}
.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  min-height: 14px;
  font-size: 11px;
  color: var(--kanban-card-fg, var(--fontColor));
  opacity: 0.85;
}
.card-date {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

/* ===== 列表模式 ===== */
.list {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 0 4px ;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 5px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  color: var(--kanban-card-fg, var(--fontColor));
  font-size: 12.5px;
  cursor: pointer;
}
.row:hover {
  background: var(--menuActiveColor);
}
.row.archived {
  opacity: 0.55;
}
.row-icon {
  font-size: 12px;
  flex-shrink: 0;
}
.row-status {
  flex-shrink: 0;
  max-width: 92px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  outline: none;
  cursor: pointer;
  margin: 0px
}
.row-status option {
  background: var(--backgroundColor);
  color: var(--fontColor);
}
.row-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-date {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  opacity: 0.75;
  flex-shrink: 0;
}
.row-badge {
  font-size: 11px;
  opacity: 0.75;
  flex-shrink: 0;
}
.list-empty {
  padding: 24px 12px;
  color: var(--fontColor);
  opacity: 0.45;
  font-size: 12px;
  text-align: center;
}

/* 卡片颜色菜单 / 时间编辑器 / 新建卡片面板的样式：与日历条目菜单共用，见 style.css 的
   「知识管理：条目「颜色」子菜单」与「知识管理：时间编辑浮层」两节 */

/* 滚动条（与看板 / 表格视图观感一致） */
.column-body::-webkit-scrollbar,
.board::-webkit-scrollbar,
.list::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.column-body::-webkit-scrollbar-track,
.board::-webkit-scrollbar-track,
.list::-webkit-scrollbar-track {
  background: transparent;
}
.column-body::-webkit-scrollbar-thumb,
.board::-webkit-scrollbar-thumb,
.list::-webkit-scrollbar-thumb {
  background-color: rgba(128, 128, 128, 0.3);
  border-radius: 4px;
}
.column-body::-webkit-scrollbar-thumb:hover,
.board::-webkit-scrollbar-thumb:hover,
.list::-webkit-scrollbar-thumb:hover {
  background-color: rgba(128, 128, 128, 0.5);
}

/* ===== 底部状态栏（与看板 / 代码编辑视图一致观感） ===== */
.kanban-statusbar {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  height: 24px;
  box-sizing: border-box;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
/* 窄面板：状态栏只保留必要选项 —— 「分组 / 视图」的下拉框 + 新建 + 筛选 + 计数（图标与分隔线一并收起，含义看控件 title）；
   文件夹名、深度、隐藏空列、归档、状态分类、刷新用 .sb-wide 收起（路径面包屑与刷新顶部工具栏已有） */
.statusbar-wrap {
  flex-shrink: 0;
  container-type: inline-size;
}
@container (max-width: 464px) {
  .statusbar-wrap .kanban-statusbar .sb-wide { display: none; }
}
.kanban-statusbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
}
.kanban-statusbar .statusbar-item i {
  font-size: 11px;
  opacity: 0.7;
}
.kanban-statusbar .statusbar-spacer {
  flex: 1;
}
.kanban-statusbar .statusbar-btn {
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
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 0.15s;
  flex-shrink: 0;
}
.kanban-statusbar .statusbar-btn:hover {
  background: var(--menuActiveColor);
  opacity: 1;
}
.kanban-statusbar .statusbar-btn.active {
  color: var(--fontActiveColor);
  opacity: 1;
}
/* 新建卡片：状态栏唯一的添加入口（紧跟在「当前文件夹」右侧），窄面板也保留 */
.kanban-statusbar .statusbar-add {
  color: var(--fontActiveColor);
  opacity: 1;
}
.kanban-statusbar .statusbar-add i {
  font-size: 13px;
  opacity: 1;
}
.kanban-statusbar .statusbar-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  flex-shrink: 0;
}
.kanban-statusbar .statusbar-select {
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
.kanban-statusbar .statusbar-select option {
  background: var(--backgroundColor);
  color: var(--fontColor);
}

/* 新建卡片面板（状态栏左侧「+」弹出，位于状态栏左上方；行样式复用 .de-*） */
/* 面板位置 / 尺寸与行间距在此声明，内部行样式与时间编辑浮层共用（见 style.css） */
.kb-card-new {
  position: absolute;
  left: 8px;
  bottom: 28px;
  z-index: 20;
  width: 240px;
  padding: 8px;
  box-sizing: border-box;
}
.kb-card-new .de-input {
  cursor: text;
}
.kb-card-new select.de-input {
  cursor: pointer;
}

/* 取值筛选面板（状态栏「筛选」按钮弹出，位于状态栏上方）：
   ⚠ 值很多时：面板宽度自适应（少量取值时窄、多了变宽到上限），气泡自动换行并纵向滚动 */
.filter-panel {
  position: absolute;
  right: 8px;
  bottom: 28px;
  z-index: 20;
  width: max-content;
  min-width: 240px;
  max-width: min(460px, calc(100% - 16px));
  max-height: min(320px, 60%);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--menuColor);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}
.filter-panel .se-head {
  flex-shrink: 0;
}
.fp-hint {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.6;
  line-height: 1.5;
  margin-bottom: 6px;
}
.fp-values {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  align-content: flex-start;
  gap: 4px;
  min-height: 0;
  overflow-y: auto;
  /* 只做纵向滚动（另一轴留 visible 会被浏览器提升成 auto，长标签会撑出横向滚动条） */
  overflow-x: clip;
}
.fp-values .chip {
  max-width: 100%;
  flex: 0 0 auto;
}
/* 取值名过长时省略，避免单个气泡把面板撑爆 */
.chip-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 状态栏筛选按钮上的已选数量角标 */
.filter-count {
  margin-left: 3px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--menuActiveColor);
  font-size: 10px;
  font-weight: 600;
}

/* ===== 状态分类编辑器（状态栏右侧按钮弹出，位于状态栏上方） ===== */
.status-editor {
  position: absolute;
  right: 8px;
  bottom: 28px;
  z-index: 20;
  width: 360px;
  max-height: 60%;
  overflow-y: auto;
  padding: 8px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--menuColor);
  color: var(--fontColor);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  user-select: none;
}
.se-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--fontActiveColor);
}
.se-title {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.se-hint {
  margin-bottom: 6px;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.65;
  white-space: normal;
}
/* 只存在于文件里的取值：加一条上分隔线，说明它们不在表里 */
.se-extra-hint {
  margin: 8px 0 4px;
  padding-top: 6px;
  border-top: 1px solid var(--borderColor);
}
.se-extra-row .se-btn {
  width: auto;
  padding: 0 6px;
  gap: 3px;
}
.se-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 0;
}
.se-preview {
  width: 16px;
  font-size: 12px;
  text-align: center;
  flex-shrink: 0;
}
.se-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.se-select {
  flex-shrink: 0;
  max-width: 116px;
  height: 20px;
  padding: 0 2px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  outline: none;
  cursor: pointer;
  margin: 0px
}
.se-select option {
  background: var(--backgroundColor);
  color: var(--fontColor);
}
.se-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  outline: none;
}
.se-input:focus {
  border-color: var(--fontActiveColor);
}
.se-btn {
  flex-shrink: 0;
  width: 22px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.85;
}
.se-btn:hover:not(:disabled) {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  opacity: 1;
}
.se-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.se-del:hover:not(:disabled) {
  color: #e74c3c;
}
.se-add {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--borderColor);
}
.se-add-btn {
  width: auto;
  padding: 0 8px;
  gap: 3px;
}
</style>
