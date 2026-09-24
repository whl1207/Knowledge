<!-- src/components/browser/BrowserBookmarksPanel.vue
     浏览器「收藏夹」树状管理面板（嵌于右侧停靠栏 bookmarks 视图）：
       - 树状展示（目录 → 书签），目录可折叠；
       - 单击书签 = 新标签打开；hover 可删除；
       - 拖拽整理：同目录内拖动调整顺序（写顺序标记）、拖到文件夹/其它书签/底部空区 → 移入该目录；
       - 顶部可「新建文件夹」。
     数据直接经 browser-agent:* IPC 读写（书签即 *.html 文件，落在 dir）。 -->
<template>
  <div class="browser-bookmarks-panel">
    <!-- 无可用目录时的空态 -->
    <div v-if="!dir" class="bb-empty">
      <i class="fa fa-folder-open-o"></i>
      <span>{{ zh ? '尚未配置书签位置' : 'No bookmark folder set yet' }}</span>
      <button class="bb-tool-btn bb-empty-btn" :title="locPickTitle" @click="pickSaveDir">
        <i class="fa fa-folder-open-o"></i>{{ zh ? '选择书签位置' : 'Choose folder' }}
      </button>
    </div>

    <template v-else>
      <!-- 工具栏：搜索(左) → 新建文件夹/选择书签位置/导入/导出(右) -->
      <div class="bb-toolbar">
        <div class="bb-tool">
          <div class="bb-search">
            <i class="fa fa-search bb-search-ic"></i>
            <input
              v-model="searchText"
              class="bb-search-input"
              spellcheck="false"
              :placeholder="zh ? '搜索收藏' : 'Search bookmarks'"
            />
            <button v-if="searchText" class="bb-search-clear" :title="zh ? '清除' : 'Clear'" @click="searchText = ''">
              <i class="fa fa-times-circle"></i>
            </button>
          </div>
          <button class="bb-tool-btn" :title="zh ? '新建文件夹' : 'New folder'" @click="startCreateFolder">
            <i class="fa fa-folder-o"></i>
          </button>
          <button class="bb-tool-btn" :title="locPickTitle" :disabled="mutating" @click="pickSaveDir">
            <i class="fa fa-folder-open-o"></i>
          </button>
          <button class="bb-tool-btn" :title="zh ? '导入收藏：从浏览器书签 HTML 导入（兼容 favorites_*.html）' : 'Import bookmarks from a browser HTML file (favorites_*.html)'"
            :disabled="importing || exporting" @click="importBookmarks">
            <i class="fa fa-download"></i>
          </button>
          <button class="bb-tool-btn" :title="zh ? '导出收藏：保存为浏览器书签 HTML（兼容 favorites_*.html）' : 'Export bookmarks as a browser HTML file (favorites_*.html)'"
            :disabled="importing || exporting" @click="exportBookmarks">
            <i class="fa fa-upload"></i>
          </button>
        </div>
        <div v-if="opMsg" class="bb-op-msg">{{ opMsg }}</div>
        <div v-if="creatingFolder" class="bb-create-row">
          <input
            v-model="folderName"
            class="bb-create-input"
            spellcheck="false"
            :placeholder="zh ? '文件夹名' : 'Folder name'"
            @keydown.enter="confirmCreateFolder"
            @keydown.esc="creatingFolder = false"
          />
          <button class="bb-icon-btn" :title="zh ? '确定' : 'OK'" @click="confirmCreateFolder"><i class="fa fa-check"></i></button>
          <button class="bb-icon-btn" :title="zh ? '取消' : 'Cancel'" @click="creatingFolder = false"><i class="fa fa-times"></i></button>
        </div>
      </div>

      <div v-if="!items.length" class="bb-empty">
        <i class="fa fa-star-o"></i>
        <span>{{ zh ? '暂无收藏：点顶部 ⭐ 收藏当前页' : 'No bookmarks yet: use the ⭐ on the toolbar' }}</span>
      </div>

      <!-- 收藏树 -->
      <div
        class="bb-tree"
        :class="{ dragging: draggingRel }"
        @dragover.prevent
        @drop="onDropRoot"
      >
        <div
          v-for="row in visibleRows"
          :key="row.rel"
          class="bb-row"
          :class="[
            `bb-depth-${Math.min(row.depth, 6)}`,
            row.kind,
            { 'bb-drop-target': dropRel === row.rel, [`bb-drop-${dropPos}`]: dropRel === row.rel },
            { collapsed: row.kind === 'dir' && collapsed.has(row.rel) },
          ]"
          :style="{ paddingLeft: (row.depth * 14 + 6) + 'px' }"
          :draggable="!searching && row.kind === 'file'"
          @click="onRowClick(row)"
          @dblclick.stop="onRowDblClick(row)"
          @contextmenu.prevent.stop="openRowCtx(row)"
          @dragstart="onDragStart($event, row)"
          @dragend="onDragEnd"
          @dragover.prevent="onRowDragOver($event, row)"
          @dragleave="onRowDragLeave(row)"
          @drop.stop.prevent="onRowDrop($event, row)"
        >
          <i
            v-if="row.kind === 'dir'"
            class="fa bb-chevron"
            :class="collapsed.has(row.rel) ? 'fa-caret-right' : 'fa-caret-down'"
            @click.stop="toggleDir(row.rel)"
          ></i>
          <i v-else class="fa bb-link fa-tag"></i>
          <span class="bb-title" :title="row.kind === 'file' ? (row.url || row.title) : (row.title + (zh ? '（文件夹）' : ' (folder)'))">
            {{ row.title }}
          </span>
          <span v-if="row.kind === 'file' && row.host" class="bb-host">{{ row.host }}</span>
          <span class="bb-actions">
            <template v-if="row.kind === 'dir'">
              <button class="bb-del bb-edit" :title="zh ? '编辑文件夹：改名 / 清空 / 删除' : 'Edit folder: rename / clear / delete'" @click.stop="openDirEdit(row)">
                <i class="fa fa-pencil"></i>
              </button>
              <button class="bb-del" :title="zh ? '删除该文件夹（含内部书签）' : 'Delete this folder (with its bookmarks)'" @click.stop="removeDirRow(row)">
                <i class="fa fa-trash-o"></i>
              </button>
            </template>
            <template v-else>
              <button v-if="!isSnapshotRow(row)" class="bb-del bb-edit" :title="zh ? '编辑标题/地址' : 'Edit title / URL'" @click.stop="openBmEdit(row)">
                <i class="fa fa-pencil"></i>
              </button>
              <button class="bb-del" :title="zh ? '删除收藏' : 'Delete bookmark'" @click.stop="removeRow(row)">
                <i class="fa fa-trash-o"></i>
              </button>
            </template>
          </span>
        </div>

        <!-- 拖到此处 → 根目录 -->
        <div v-if="draggingRel" class="bb-root-drop" @dragover.prevent @drop.stop.prevent="moveToRoot">
          <i class="fa fa-level-up"></i>
          {{ zh ? '拖到此处：移到根目录' : 'Drop here to move to root' }}
        </div>
      </div>

      <!-- 书签设置模态框：悬浮“编辑”按钮或右键书签行弹出（标题/地址 + 打开/复制/删除，底部单行统一风格） -->
      <div v-if="bmEditVisible" class="bb-edit-overlay" @click.self="closeBmEdit">
        <div class="bb-edit-modal">
          <div class="bb-edit-head">
            <span><i class="fa fa-pencil"></i> {{ zh ? '编辑收藏' : 'Edit bookmark' }}</span>
            <button class="bb-edit-x" :title="zh ? '关闭' : 'Close'" @click="closeBmEdit"><i class="fa fa-times"></i></button>
          </div>
          <div class="bb-edit-row">
            <label>{{ zh ? '标题' : 'Title' }}</label>
            <input v-model="bmEditTitle" class="bb-edit-input" spellcheck="false" :placeholder="zh ? '收藏显示的名称' : 'Bookmark title'" @keydown.enter="saveBmEdit" />
          </div>
          <div class="bb-edit-row">
            <label>{{ zh ? '地址' : 'URL' }}</label>
            <input v-model="bmEditUrl" class="bb-edit-input" spellcheck="false" placeholder="https://..." @keydown.enter="saveBmEdit" />
          </div>
          <div v-if="bmEditError" class="bb-edit-err">{{ bmEditError }}</div>
          <div class="bb-edit-foot">
            <button class="bb-edit-btn" :disabled="bmEditSaving" @click="openEditingInTab"><i class="fa fa-external-link"></i> {{ zh ? '打开' : 'Open' }}</button>
            <button class="bb-edit-btn" :disabled="bmEditSaving" @click="copyEditingUrl"><i class="fa fa-copy"></i> {{ zh ? '复制地址' : 'Copy URL' }}</button>
            <button class="bb-edit-btn danger" :disabled="bmEditSaving" @click="delEditingBm"><i class="fa fa-trash-o"></i> {{ zh ? '删除' : 'Delete' }}</button>
            <div style="flex:1"></div>
            <button class="bb-edit-btn" @click="closeBmEdit">{{ zh ? '取消' : 'Cancel' }}</button>
            <button class="bb-edit-btn primary" :disabled="bmEditSaving" @click="saveBmEdit"><i class="fa fa-check"></i> {{ zh ? '保存' : 'Save' }}</button>
          </div>
        </div>
      </div>

      <!-- 文件夹设置模态框：点文件夹行“编辑”弹出（重命名 + 清空/删除，底部单行统一风格，样式复用 .bb-edit-*） -->
      <div v-if="dirEditVisible" class="bb-edit-overlay" @click.self="closeDirEdit">
        <div class="bb-edit-modal">
          <div class="bb-edit-head">
            <span><i class="fa fa-folder-o"></i> {{ zh ? '编辑文件夹' : 'Edit folder' }}</span>
            <button class="bb-edit-x" :title="zh ? '关闭' : 'Close'" @click="closeDirEdit"><i class="fa fa-times"></i></button>
          </div>
          <div class="bb-edit-row">
            <label>{{ zh ? '名称' : 'Name' }}</label>
            <input v-model="dirEditTitle" class="bb-edit-input" spellcheck="false" :placeholder="zh ? '文件夹名称' : 'Folder name'" @keydown.enter="saveDirEdit" />
          </div>
          <div v-if="dirEditError" class="bb-edit-err">{{ dirEditError }}</div>
          <div class="bb-edit-foot">
            <button class="bb-edit-btn" :disabled="dirEditSaving" @click="onDirClearFromEdit"><i class="fa fa-eraser"></i> {{ zh ? '清空内容' : 'Clear' }}</button>
            <button class="bb-edit-btn danger" :disabled="dirEditSaving" @click="onDirDelFromEdit"><i class="fa fa-trash-o"></i> {{ zh ? '删除文件夹' : 'Delete' }}</button>
            <div style="flex:1"></div>
            <button class="bb-edit-btn" @click="closeDirEdit">{{ zh ? '取消' : 'Cancel' }}</button>
            <button class="bb-edit-btn primary" :disabled="dirEditSaving" @click="saveDirEdit"><i class="fa fa-check"></i> {{ zh ? '保存' : 'Save' }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { usestore } from '@/store'
import { ElMessageBox } from 'element-plus'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

interface BmRow {
  kind: 'dir' | 'file'
  rel: string
  title: string
  path: string
  url: string
  depth: number
  host: string
}

const props = defineProps<{ dir: string; items: any[]; active?: boolean }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const invoke = (channel: string, payload?: any) =>
  window.ipcRenderer?.invoke ? window.ipcRenderer.invoke(channel, payload) : Promise.reject(new Error('IPC 不可用'))

// ===== 搜索收藏（按标题/网址/目录名匹配，命中展平为结果列表） =====
const searchText = ref('')
const searching = computed(() => searchText.value.trim() !== '')

// ===== 数据：由父级传入的 items（主进程 list-bookmarks：kind/rel/title/name/path/url/order） =====
// 折叠状态：面板打开时默认全部折叠——初始只显示最上面一层的文件夹（及其下不展开），点击后再逐层展开
const collapsed = ref<Set<string>>(new Set())
const defaultCollapsedSet = (): Set<string> => {
  const s = new Set<string>()
  for (const it of props.items || []) {
    if (it?.kind !== 'dir') continue
    const rel = String(it.rel || '')
    if (!rel) continue
    // 所有目录默认折叠（含顶层），避免自动展开露出第二层
    s.add(rel)
  }
  return s
}
const resetCollapsed = () => { collapsed.value = defaultCollapsedSet() }
// 收藏面板被打开 / 收藏位置切换时恢复默认折叠；首次载入数据后也应用一次默认
let sawFirstItems = false
watch(() => (props.items || []).length, (n) => {
  if (n > 0 && !sawFirstItems) { sawFirstItems = true; resetCollapsed() }
  else if (n === 0) sawFirstItems = false
})
watch(() => props.dir, () => { sawFirstItems = false; resetCollapsed() })
watch(() => props.active, (a) => { if (a) resetCollapsed() })
onMounted(() => { if ((props.items || []).length) resetCollapsed() })

const parentOf = (rel: string) => {
  const i = rel.lastIndexOf('/')
  return i >= 0 ? rel.slice(0, i) : ''
}
const hasCollapsedAncestor = (rel: string) => {
  let p = parentOf(rel)
  while (p) {
    if (collapsed.value.has(p)) return true
    p = parentOf(p)
  }
  return false
}

const visibleRows = computed<BmRow[]>(() => {
  const q = searchText.value.trim().toLowerCase()
  // 搜索态：只返回命中的书签，展平展示（忽略目录层级与折叠）
  if (q) {
    const out: BmRow[] = []
    for (const it of props.items || []) {
      if (it?.kind !== 'file') continue
      const rel = it?.rel || ''
      if (!rel) continue
      const title = it?.title || it?.name || ''
      const url = it?.url || ''
      const name = it?.name || ''
      if (!`${title}\n${url}\n${name}\n${rel}`.toLowerCase().includes(q)) continue
      let host = ''
      try { host = url ? (new URL(url).host.replace(/^www\./, '') || '') : '' } catch { host = '' }
      out.push({ kind: 'file', rel, title: title || '书签', path: it?.path || '', url, depth: 0, host })
    }
    return out
  }
  // 树状态
  const rows: BmRow[] = []
  for (const it of props.items || []) {
    const kind: 'dir' | 'file' = it?.kind === 'dir' ? 'dir' : 'file'
    const rel = it?.rel || ''
    if (!rel) continue
    // 折叠父目录后，其下子目录/书签一并隐藏（真正只显示当前层）
    if (hasCollapsedAncestor(rel)) continue
    let host = ''
    if (kind === 'file' && it?.url) { try { host = new URL(it.url).host.replace(/^www\./, '') || '' } catch { host = '' } }
    rows.push({
      kind,
      rel,
      title: it?.title || it?.name || '书签',
      path: it?.path || '',
      url: it?.url || '',
      depth: rel ? rel.split('/').length - 1 : 0,
      host,
    })
  }
  return rows
})

const toggleDir = (rel: string) => {
  const s = new Set(collapsed.value)
  if (s.has(rel)) s.delete(rel); else s.add(rel)
  collapsed.value = s
}

// ===== 单击打开（防拖拽误触发） =====
let justDragged = false
const onRowClick = (row: BmRow) => {
  if (justDragged) { justDragged = false; return }
  if (row.kind === 'dir') { toggleDir(row.rel); return }
  if (row.url) { invoke('browser-agent:add-tab', { url: row.url }).catch(() => {}) }
}
const onRowDblClick = (row: BmRow) => {
  if (row.kind === 'dir') toggleDir(row.rel)
}

// ===== 删除 =====
const removeRow = async (row: BmRow) => {
  const r = await invoke('browser-agent:remove-bookmark', { root: props.dir, path: row.path }).catch(() => null)
  if (r?.ok) emit('changed')
}

// ===== 新建文件夹 =====
const creatingFolder = ref(false)
const folderName = ref('')
const startCreateFolder = () => { creatingFolder.value = true; folderName.value = '' }
const confirmCreateFolder = async () => {
  const name = folderName.value.trim()
  if (!name) return
  const r = await invoke('browser-agent:bookmark-mkdir', { root: props.dir, name }).catch(() => null)
  creatingFolder.value = false
  if (r?.ok) emit('changed')
}

// ===== 导入 / 导出（兼容浏览器书签 HTML favorites_*.html；选文件/保存位置由主进程对话框完成） =====
const importing = ref(false)
const exporting = ref(false)
const opMsg = ref('')
let opTimer: ReturnType<typeof setTimeout> | undefined
const showOp = (msg: string) => {
  opMsg.value = msg
  if (opTimer) clearTimeout(opTimer)
  opTimer = setTimeout(() => { if (opMsg.value === msg) opMsg.value = '' }, 3500)
}
const importBookmarks = async () => {
  if (!props.dir || importing.value || exporting.value) return
  importing.value = true
  try {
    const r = await invoke('browser-agent:import-bookmarks', { root: props.dir }).catch(() => null)
    if (r?.ok) {
      emit('changed')
      showOp(zh.value
        ? `已从浏览器 HTML 导入 ${r.imported ?? 0} 个书签 → 文件夹「${r.folder || ''}」`
        : `Imported ${r.imported ?? 0} bookmarks into "${r.folder || ''}"`)
    } else if (!r?.canceled) {
      showOp((zh.value ? '导入失败：' : 'Import failed: ') + (r?.error || '未知错误'))
    }
  } finally { importing.value = false }
}
const exportBookmarks = async () => {
  if (!props.dir || importing.value || exporting.value) return
  exporting.value = true
  try {
    const r = await invoke('browser-agent:export-bookmarks', { root: props.dir }).catch(() => null)
    if (r?.ok) {
      showOp(zh.value
        ? `已导出 ${r.count ?? 0} 个收藏到：${r.path || ''}`
        : `Exported ${r.count ?? 0} bookmarks to: ${r.path || ''}`)
    } else if (!r?.canceled) {
      showOp((zh.value ? '导出失败：' : 'Export failed: ') + (r?.error || '未知错误'))
    }
  } finally { exporting.value = false }
}

// ===== 书签位置：工具栏图标按钮选择落盘目录；已自定义时「取消」= 清空并恢复为工作区根（图标 title 显示完整路径） =====
const mutating = ref(false)
const hasCustomDir = computed(() => !!((store.UI?.browserSaveDir || '').trim()))
const locPath = computed(() => String(props.dir || '').trim())
const locPickTitle = computed(() => {
  const tip = zh.value ? '（点击更换；已自定义位置时点“取消”= 清空恢复为工作区根）' : ' (click to change; cancel = reset to workspace root when a custom folder is set)'
  return locPath.value
    ? `${zh.value ? '书签位置' : 'Bookmark folder'}：${locPath.value}${tip}`
    : `${zh.value ? '书签位置：未设置，将保存到工作区根目录' : 'Bookmark folder: workspace root'}${tip}`
})
const pickSaveDir = async () => {
  if (mutating.value || !window.ipcRenderer) return
  const dir = await window.ipcRenderer.invoke('openFolderDialog').catch(() => null)
  if (dir && typeof dir === 'string' && dir !== (store.UI?.browserSaveDir || '').trim()) {
    store.UI.browserSaveDir = dir
    store.saveConfig()
    emit('changed')
    showOp(zh.value ? `书签位置已切换：${dir}` : `Bookmark folder set: ${dir}`)
    return
  }
  // 选择「取消」且此前已自定义位置 → 清空（恢复为工作区根目录）
  if (!dir && hasCustomDir.value) {
    store.UI.browserSaveDir = ''
    store.saveConfig()
    emit('changed')
    showOp(zh.value ? '书签位置已清空，恢复为当前工作区根目录' : 'Bookmark folder reset to workspace root')
  }
}

// ===== 删除 / 清空（文件夹删除、文件夹内清空、全部清空；均用确认框） =====
// 某文件夹（及子孙）下现有书签条数（用于确认提示）
const countUnderRel = (row: BmRow): number => {
  const pre = `${row.rel}/`
  return (props.items || []).filter(i => i?.kind === 'file' && (i?.rel || '').startsWith(pre)).length
}
const confirmBox = (title: string, msg: string, okText: string) =>
  ElMessageBox.confirm(msg, title, { confirmButtonText: okText, cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' })
const runSafe = async (fn: () => Promise<any>, okMsg: string, failPrefix: string) => {
  if (!props.dir || mutating.value) return
  mutating.value = true
  try {
    const r = await fn().catch(() => null)
    if (r?.ok) { emit('changed'); showOp(okMsg) }
    else showOp(failPrefix + (r?.error || '未知错误'))
  } finally { mutating.value = false }
}
const removeDirRow = async (row: BmRow) => {
  if (mutating.value) return
  const n = countUnderRel(row)
  try {
    await confirmBox(
      zh.value ? '删除文件夹' : 'Delete folder',
      zh.value ? `确定删除文件夹「${row.title}」及其中的 ${n} 条书签吗？此操作不可恢复！` : `Delete folder "${row.title}" and its ${n} bookmark(s)? This cannot be undone!`,
      zh.value ? '删除' : 'Delete')
  } catch { return }
  await runSafe(() => invoke('browser-agent:remove-bookmark-folder', { root: props.dir, path: row.path }),
    zh.value ? `已删除文件夹「${row.title}」` : `Deleted folder "${row.title}"`,
    zh.value ? '删除失败：' : 'Delete failed: ')
}
// 清空文件夹入口已移入文件夹编辑模态框（onDirClearFromEdit），原行级“清空”按钮替换为“编辑”

// ===== 书签右键 / 悬浮“编辑”→ 设置模态框（标题/地址/打开/复制/删除，普通网页书签；离线快照除外） =====
const isSnapshotRow = (row: BmRow) => row.kind === 'file' && String(row.url || '').startsWith('file:')
const bmEditVisible = ref(false)
const bmEditSaving = ref(false)
const bmEditPath = ref('')
const bmEditTitle = ref('')
const bmEditUrl = ref('')
const bmEditOrigUrl = ref('')
const bmEditError = ref('')
// 右键入口：仅普通网页书签弹设置模态框；文件夹/离线快照不弹（仅拦默认菜单）
const openRowCtx = (row: BmRow) => { if (row.kind === 'file' && !isSnapshotRow(row)) openBmEdit(row) }
const openBmEdit = (row: BmRow) => {
  if (!props.dir || !row.path) return
  bmEditPath.value = row.path
  bmEditTitle.value = row.title || ''
  bmEditUrl.value = row.url || ''
  bmEditOrigUrl.value = row.url || ''
  bmEditError.value = ''
  bmEditVisible.value = true
}
const closeBmEdit = () => { bmEditVisible.value = false; bmEditError.value = '' }
const saveBmEdit = async () => {
  if (bmEditSaving.value) return
  const url = bmEditUrl.value.trim()
  if (!url) { bmEditError.value = zh.value ? '请输入网址' : 'URL is required'; return }
  const title = bmEditTitle.value.trim()
  if (!props.dir) return
  bmEditSaving.value = true
  try {
    const r = await invoke('browser-agent:update-bookmark', { root: props.dir, path: bmEditPath.value, title, url }).catch(() => null)
    if (r?.ok) { closeBmEdit(); emit('changed'); showOp(zh.value ? '已保存修改' : 'Bookmark updated') }
    else bmEditError.value = r?.error || (zh.value ? '保存失败' : 'Update failed')
  } finally { bmEditSaving.value = false }
}
const delEditingBm = async () => {
  if (bmEditSaving.value || !bmEditPath.value || !props.dir) return
  try {
    await confirmBox(
      zh.value ? '删除收藏' : 'Delete bookmark',
      zh.value ? '确定删除这个收藏吗？此操作不可恢复。' : 'Delete this bookmark? This cannot be undone.',
      zh.value ? '删除' : 'Delete')
  } catch { return }
  bmEditSaving.value = true
  try {
    const r = await invoke('browser-agent:remove-bookmark', { root: props.dir, path: bmEditPath.value }).catch(() => null)
    if (r?.ok) { closeBmEdit(); emit('changed'); showOp(zh.value ? '已删除该收藏' : 'Bookmark removed') }
    else bmEditError.value = r?.error || (zh.value ? '删除失败' : 'Delete failed')
  } finally { bmEditSaving.value = false }
}
const editingTargetUrl = () => {
  const u = bmEditUrl.value.trim()
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) ? u : bmEditOrigUrl.value
}
const openEditingInTab = () => {
  const u = editingTargetUrl()
  if (u) { closeBmEdit(); void invoke('browser-agent:add-tab', { url: u }).catch(() => {}) }
}
const copyEditingUrl = async () => {
  try { await navigator.clipboard.writeText(editingTargetUrl()); showOp(zh.value ? '已复制地址' : 'URL copied') }
  catch { showOp(zh.value ? '复制失败' : 'Copy failed') }
}

// ===== 文件夹编辑模态框（行悬浮“编辑”→ 重命名/清空/删除；底部单行与书签编辑同风格） =====
const dirEditVisible = ref(false)
const dirEditSaving = ref(false)
const dirEditRow = ref<BmRow | null>(null)
const dirEditPath = ref('')
const dirEditTitle = ref('')
const dirEditError = ref('')
const openDirEdit = (row: BmRow) => {
  if (!props.dir || !row.path) return
  dirEditRow.value = row
  dirEditPath.value = row.path
  dirEditTitle.value = row.title || ''
  dirEditError.value = ''
  dirEditVisible.value = true
}
const closeDirEdit = () => { dirEditVisible.value = false; dirEditError.value = '' }
// 保存 = 重命名文件夹（名称非法字符由主进程清理，同名视为成功）
const saveDirEdit = async () => {
  if (dirEditSaving.value) return
  const name = dirEditTitle.value.trim()
  if (!name) { dirEditError.value = zh.value ? '请输入文件夹名称' : 'Folder name is required'; return }
  if (!props.dir || !dirEditPath.value) return
  dirEditSaving.value = true
  try {
    const r = await invoke('browser-agent:bookmark-rename-folder', { root: props.dir, path: dirEditPath.value, name }).catch(() => null)
    if (r?.ok) { closeDirEdit(); emit('changed'); showOp(zh.value ? '已重命名文件夹' : 'Folder renamed') }
    else dirEditError.value = r?.error || (zh.value ? '重命名失败' : 'Rename failed')
  } finally { dirEditSaving.value = false }
}
const onDirClearFromEdit = async () => {
  const row = dirEditRow.value
  if (!row || dirEditSaving.value) return
  try {
    await confirmBox(
      zh.value ? '清空文件夹' : 'Clear folder',
      zh.value ? `确定清空文件夹「${row.title}」内的书签吗？将保留该文件夹。` : `Clear bookmarks inside folder "${row.title}"? The folder is kept.`,
      zh.value ? '清空' : 'Clear')
  } catch { return }
  closeDirEdit()
  await runSafe(() => invoke('browser-agent:clear-bookmark-folder', { root: props.dir, path: row.path }),
    zh.value ? `已清空文件夹「${row.title}」内的书签` : `Cleared bookmarks in "${row.title}"`,
    zh.value ? '清空失败：' : 'Clear failed: ')
}
const onDirDelFromEdit = async () => {
  const row = dirEditRow.value
  if (!row || dirEditSaving.value) return
  try {
    await confirmBox(
      zh.value ? '删除文件夹' : 'Delete folder',
      zh.value ? `确定删除文件夹「${row.title}」及其中的 ${countUnderRel(row)} 条书签吗？此操作不可恢复！` : `Delete folder "${row.title}" and its ${countUnderRel(row)} bookmark(s)? This cannot be undone!`,
      zh.value ? '删除' : 'Delete')
  } catch { return }
  closeDirEdit()
  await runSafe(() => invoke('browser-agent:remove-bookmark-folder', { root: props.dir, path: row.path }),
    zh.value ? `已删除文件夹「${row.title}」` : `Deleted folder "${row.title}"`,
    zh.value ? '删除失败：' : 'Delete failed: ')
}

// ===== 拖拽整理 =====
const draggingRel = ref('')
const dragRow = ref<BmRow | null>(null)
const dropRel = ref('')
const dropPos = ref<'before' | 'after' | 'into'>('before')

const onDragStart = (e: DragEvent, row: BmRow) => {
  draggingRel.value = row.rel
  dragRow.value = row
  justDragged = false
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', row.rel)
  }
}
const onDragEnd = () => {
  draggingRel.value = ''
  dragRow.value = null
  dropRel.value = ''
  justDragged = true
}

const rowElPos = (e: DragEvent, row: BmRow): 'before' | 'after' => {
  const el = (e.currentTarget as HTMLElement)
  const rect = el.getBoundingClientRect()
  return (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
}

const onRowDragOver = (e: DragEvent, row: BmRow) => {
  if (!draggingRel.value || row.rel === draggingRel.value) { dropRel.value = row.rel; return }
  e.preventDefault()
  dropRel.value = row.rel
  dropPos.value = row.kind === 'dir' && row.depth <= (dragRow.value?.depth ?? 0) ? 'after' : row.kind === 'dir' ? 'into' : rowElPos(e, row)
}

const onRowDragLeave = (row: BmRow) => { if (dropRel.value === row.rel) dropRel.value = '' }

// 同父目录内的书签文件（按主进程给出的当前顺序）
const siblingFiles = (parentRel: string): Array<{ rel: string; path: string; title: string }> => {
  return (props.items || [])
    .filter(i => i?.kind === 'file' && parentOf(i.rel || '') === parentRel)
    .map(i => ({ rel: i.rel, path: i.path, title: i.title || i.name || '书签' }))
}

const onRowDrop = async (_e: DragEvent, target: BmRow) => {
  const src = dragRow.value
  dragRow.value = null
  draggingRel.value = ''
  const savedDrop = { rel: dropRel.value, pos: dropPos.value }
  dropRel.value = ''
  if (!src || !src.path) return
  if (src.rel === target.rel) return

  // 目标为文件夹 → 移入该文件夹
  if (target.kind === 'dir') {
    await moveInto(src, target.rel)
    return
  }
  const srcParent = parentOf(src.rel)
  const dstParent = parentOf(target.rel)
  // 跨目录 → 移入目标所在目录（追加末尾）
  if (srcParent !== dstParent) {
    await moveInto(src, dstParent)
    return
  }
  // 同目录 → 重排顺序
  await reorderSiblings(src, target.rel, savedDrop.pos === 'after' ? 'after' : 'before')
}

// 移入某目录（dstRel 为空 = 根目录）
const moveInto = async (src: BmRow, dstParentRel: string) => {
  const r = await invoke('browser-agent:bookmark-move', { root: props.dir, srcPath: src.path, dstDirRel: dstParentRel }).catch(() => null)
  if (r?.ok) emit('changed')
}

// 同目录重排：把 src 插到 target 之前/之后
const reorderSiblings = async (src: BmRow, targetRel: string, pos: 'before' | 'after') => {
  const parentRel = parentOf(src.rel)
  const sibs = siblingFiles(parentRel)
  const order = sibs.map(s => s.rel).filter(r => r !== src.rel)
  const ti = order.indexOf(targetRel)
  if (ti < 0) return
  const insertAt = pos === 'after' ? ti + 1 : ti
  order.splice(insertAt, 0, src.rel)
  const pathByRel = new Map(sibs.map(s => [s.rel, s.path]))
  const orderedPaths = order.map(r => pathByRel.get(r)).filter((p): p is string => !!p)
  const r = await invoke('browser-agent:bookmark-reorder', { root: props.dir, order: orderedPaths }).catch(() => null)
  if (r?.ok) emit('changed')
}

const moveToRoot = async () => {
  const src = dragRow.value
  dragRow.value = null
  draggingRel.value = ''
  dropRel.value = ''
  if (!src || !src.path) return
  if (parentOf(src.rel) === '') return // 已在根目录
  await moveInto(src, '')
}

const onDropRoot = () => { /* 空白区交由 moveToRoot（drop 冒泡到此层时若无目标行） */ }

watch(() => props.items, () => { draggingRel.value = ''; dropRel.value = '' })
</script>

<style scoped>
.browser-bookmarks-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.bb-empty {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 12px;
  text-align: center;
  color: var(--fontColor);
  opacity: .55;
  font-size: 12px;
  line-height: 1.6;
}
.bb-empty i { font-size: 22px; color: var(--fontActiveColor); opacity: .6; }
.bb-toolbar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bb-tool {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bb-tool-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 13px;
  transition: all .15s;
}
.bb-tool-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.bb-empty-btn { width: auto !important; height: 24px; padding: 0 10px; gap: 5px; font-size: 11px; }
/* 搜索框（占满剩余、可清除） */
.bb-search {
  flex: 1;
  min-width: 0;
  height: 26px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 9px;
  border: 1px solid var(--borderColor);
  border-radius: 13px;
  background: var(--menuColor);
  transition: border-color .15s;
}
.bb-search:focus-within { border-color: var(--fontActiveColor); }
.bb-search-ic { flex-shrink: 0; font-size: 11px; color: var(--fontColor); opacity: .5; }
.bb-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.bb-search-clear {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fontColor);
  opacity: .6;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.bb-search-clear:hover { opacity: 1; color: var(--fontActiveColor); }
/* 计数样式已移除：改用 bb-loc（书签位置条）与行级操作 */
.bb-tool-btn:disabled { opacity: .4; cursor: default; }
.bb-tool-btn:disabled:hover { color: var(--fontColor); border-color: var(--borderColor); background: transparent; }
/* 导入/导出结果提示 */
.bb-op-msg {
  font-size: 11px;
  line-height: 1.5;
  color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--fontActiveColor) 30%, transparent);
  border-radius: 5px;
  padding: 4px 8px;
  word-break: break-all;
}
.bb-create-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.bb-create-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--fontActiveColor);
  border-radius: 5px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  outline: none;
}
.bb-icon-btn {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
}
.bb-icon-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
/* 树列表：占满剩余高度、仅此区滚动（细滚动条，样式与侧栏滚动区一致） */
.bb-tree {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  padding: 4px;
  background: color-mix(in srgb, var(--fontColor) 3%, transparent);
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--fontColor) 25%, transparent) transparent;
}
.bb-tree::-webkit-scrollbar { width: 8px; }
.bb-tree::-webkit-scrollbar-track { background: transparent; }
.bb-tree::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fontColor) 18%, transparent);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.bb-tree::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--fontActiveColor) 55%, transparent);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.bb-row {
  flex: 0 0 auto; /* 行高固定 26px：窗口缩放/内容超高时不压缩，仅由 .bb-tree 滚动 */
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding-right: 4px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--fontColor);
  user-select: none;
  position: relative;
  transition: background .12s;
}
.bb-row:hover { background: color-mix(in srgb, var(--fontColor) 7%, transparent); }
.bb-row.bb-drop-before { box-shadow: inset 0 2px 0 var(--fontActiveColor); }
.bb-row.bb-drop-after { box-shadow: inset 0 -2px 0 var(--fontActiveColor); }
.bb-row.bb-drop-into { background: color-mix(in srgb, var(--fontActiveColor) 16%, transparent); }
.bb-chevron { flex: 0 0 auto; width: 12px; font-size: 11px; color: var(--fontActiveColor); }
.bb-link { flex: 0 0 auto; width: 12px; font-size: 10px; color: var(--fontActiveColor); opacity: .7; }
.bb-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.bb-host {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--fontColor);
  opacity: .5;
  max-width: 90px;
}
/* 行级操作（hover 显示）：文件夹=清空+删除；书签=删除 */
.bb-actions {
  flex: 0 0 auto;
  display: none;
  align-items: center;
  justify-content: center;
  gap: 2px;
  margin-left: auto;
}
.bb-row:hover .bb-actions { display: inline-flex; }
.bb-del {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  opacity: .65;
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}
.bb-del:hover { color: #e81123; opacity: 1; }
.bb-del.bb-clear:hover { color: #FF9800; opacity: 1; }
.bb-root-drop {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  margin-top: 4px;
  border: 1px dashed color-mix(in srgb, var(--fontActiveColor) 45%, transparent);
  border-radius: 6px;
  color: var(--fontActiveColor);
  font-size: 11px;
  background: color-mix(in srgb, var(--fontActiveColor) 6%, transparent);
}
/* 行级“编辑”按钮（悬浮显示；书签行 hover 出现 编辑+删除） */
.bb-del.bb-edit:hover { color: #1971c2; opacity: 1; }
/* ===== 书签设置模态框（悬浮编辑/右键弹出）：底部单行统一风格 ===== */
.bb-edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, .45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
}
.bb-edit-modal {
  width: 420px;
  max-width: 92vw;
  box-sizing: border-box;
  background: var(--backgroundColor, #fff);
  border: 1px solid var(--borderColor);
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, .22);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bb-edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--fontColor);
  gap: 8px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--borderColor);
}
.bb-edit-x {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
}
.bb-edit-x:hover { background: color-mix(in srgb, var(--fontColor) 10%, transparent); }
.bb-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bb-edit-row label {
  flex: 0 0 42px;
  font-size: 12px;
  color: var(--fontColor);
  opacity: .8;
  padding: 0;
}
.bb-edit-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  outline: none;
  margin: 0;
}
.bb-edit-input:focus { border-color: var(--fontActiveColor); }
.bb-edit-err { font-size: 11px; color: #e81123; }
.bb-edit-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.bb-edit-btn {
  min-width: 56px;
  height: 28px;
  box-sizing: border-box;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  padding: 0 12px;
}
.bb-edit-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.bb-edit-btn.primary { background: #1971c2; color: #fff; border-color: #1971c2; }
.bb-edit-btn.primary:hover { opacity: .9; color: #fff; }
.bb-edit-btn.danger { color: #e81123; }
.bb-edit-btn.danger:hover { border-color: #e81123; color: #e81123; background: color-mix(in srgb, #e81123 8%, transparent); }
.bb-edit-btn:disabled { opacity: .5; cursor: default; }
</style>
