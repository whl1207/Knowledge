<!-- src/components/home/ChatDockFiles.vue
     右侧栏（dock）「文件」标签：工作区（store.root）的懒加载文件树（与 DSH 右侧栏的文件页同定位）。

     交互（都只走已有的平台 fs 端口，不新增主进程能力）：
     - 文件夹：单击展开/收起（首次展开才去 listTree，depth=1）；
     - 文件：单击在当前右侧栏里以**文件标签**打开（复用文件窗口的多视图选择）；
       特殊文件（.kb / .task / 本地 .html / 系统打开类）仍走应用统一调度，见 home.vue 的 open-file 处理；
     - 每行右侧「插入」：把相对路径以行内代码形式插进当前聊天的输入框（方便直接让智能体读这个文件）。
     过滤框只过滤**已加载**的节点（不触发全盘扫描）。 -->
<template>
  <div class="dock-files">
    <div class="dock-files-head">
      <span class="dock-files-root" :title="rootPath">
        <i class="fa fa-folder-open-o"></i>
        {{ rootLabel || (zh ? '未打开工作区' : 'No workspace') }}
      </span>
      <button class="dock-icon-btn" :title="zh ? '刷新' : 'Refresh'" @click="reload()">
        <i class="fa fa-refresh" :class="{ 'fa-spin': loading }"></i>
      </button>
    </div>

    <div class="dock-files-filter">
      <i class="fa fa-search"></i>
      <input
        v-model="filterText"
        class="dock-filter-input"
        :placeholder="zh ? '过滤已加载的文件名…' : 'Filter loaded names…'"
        spellcheck="false"
      />
      <span v-if="filterText" class="dock-filter-clear" @click="filterText = ''"><i class="fa fa-times-circle"></i></span>
    </div>

    <div class="dock-files-body scoll">
      <div v-if="!canRead" class="dock-empty">
        <i class="fa fa-lock"></i>
        <span>{{ zh ? '当前环境不支持浏览文件' : 'File browsing is unavailable here' }}</span>
      </div>
      <div v-else-if="!rootPath" class="dock-empty">
        <i class="fa fa-folder-o"></i>
        <span>{{ zh ? '还没有选择工作区：用输入框左下角的工作区按钮切换或打开文件夹' : 'No workspace yet — use the workspace button at the bottom-left of the input box' }}</span>
      </div>
      <div v-else-if="loading && !allRows.length" class="dock-empty">
        <i class="fa fa-spinner fa-spin"></i>
        <span>{{ zh ? '加载中…' : 'Loading…' }}</span>
      </div>
      <div v-else-if="!visibleRows.length" class="dock-empty">
        <i class="fa fa-folder-open-o"></i>
        <span>{{ filterText ? (zh ? '没有匹配的文件' : 'No matching files') : (zh ? '这个目录是空的' : 'This folder is empty') }}</span>
      </div>
      <div
        v-for="row in visibleRows"
        :key="row.node.path"
        class="dock-file-row"
        :class="{ folder: row.isDir, 'is-filtering': !!filterText }"
        :style="{ paddingLeft: 6 + row.depth * 12 + 'px' }"
        :title="row.node.path"
        @click="onRowClick(row)"
      >
        <i class="fa dock-row-caret" :class="row.isDir ? (row.expanded ? 'fa-caret-down' : 'fa-caret-right') : ''"></i>
        <i class="fa dock-row-icon" :class="row.isDir ? (row.expanded ? 'fa-folder-open-o' : 'fa-folder-o') : fileIcon(row.node)"></i>
        <span class="dock-row-name">{{ row.node.label || fileNameOf(row.node.path) }}</span>
        <span v-if="row.isDir && row.loading" class="dock-row-loading"><i class="fa fa-spinner fa-spin"></i></span>
        <button
          v-else-if="!row.isDir"
          class="dock-row-insert"
          :title="zh ? '把相对路径插入输入框' : 'Insert relative path into the input box'"
          @click.stop="insertPath(row.node)"
        >
          <i class="fa fa-level-down"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件标签：只读浏览工作区 + 打开文件 + 插入路径。
 *
 * 状态是**本标签自己的**（展开集合 / 子节点缓存 / 过滤词）：右侧栏按标签页实例化，
 * 每个聊天、每个「文件」标签各自独立，互不干扰（与 dock 的每聊天配置一致）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { usestore } from '@/store'
import { getPlatform, hasCapability } from '@/platform'

interface FsNode {
  label?: string
  path: string
  type?: string
  extension?: string
  size?: number
}

const props = defineProps<{
  active?: boolean
  /** 根目录：**当前聊天自己的工作区**（空 = 回落到全局默认 store.root） */
  rootPath?: string
}>()
const emit = defineEmits<{
  (e: 'insert-text', text: string): void
  /** 点了文件：交给宿主（home.vue）在当前右侧栏里以 file 标签打开（不再直接弹独立窗口） */
  (e: 'open-file', payload: { path: string; view?: string; label?: string }): void
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')

/** 是否允许读路径（桌面 true；安卓/网页按各自能力表） */
const canRead = computed(() => hasCapability('fs.pathRead'))
const rootPath = computed(() => (String(props.rootPath || '').trim() || String(store.root || '')).replace(/[\\/]+$/, ''))
const rootLabel = computed(() => fileNameOf(rootPath.value))

/** 根目录一级节点 */
const rootNodes = ref<FsNode[]>([])
/** 已展开的目录（path → true） */
const expanded = ref<Record<string, boolean>>({})
/** 目录 → 子节点缓存（懒加载，只拉 depth=1） */
const childrenCache = ref<Record<string, FsNode[]>>({})
/** 正在加载的目录 */
const loadingDirs = ref<Record<string, boolean>>({})
const loading = ref(false)
const filterText = ref('')

function fileNameOf(p: string): string {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p || '')
}

/** 相对工作区根的路径（统一 / 分隔；根外路径原样返回） */
function relativeToRoot(p: string): string {
  const root = rootPath.value.replace(/\\/g, '/')
  const full = String(p || '').replace(/\\/g, '/')
  if (root && (full === root || full.startsWith(root + '/'))) {
    return full.slice(root.length).replace(/^\/+/, '')
  }
  return full
}

/** 常见扩展名 → 图标（够用即可，未知一律通用文件图标） */
function fileIcon(node: FsNode): string {
  const ext = String(node.extension || '').toLowerCase().replace(/^\./, '')
    || fileNameOf(node.path).split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'md': case 'markdown': case 'txt': return 'fa-file-text-o'
    case 'kb': return 'fa-database'
    case 'docx': case 'doc': case 'pdf': return 'fa-file-pdf-o'
    case 'xlsx': case 'xls': case 'csv': return 'fa-file-excel-o'
    case 'pptx': case 'ppt': return 'fa-file-powerpoint-o'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'bmp': case 'svg': return 'fa-file-image-o'
    case 'mp4': case 'mov': case 'mkv': case 'webm': case 'avi': return 'fa-file-video-o'
    case 'mp3': case 'wav': case 'm4a': case 'flac': case 'ogg': return 'fa-file-audio-o'
    case 'py': case 'js': case 'ts': case 'vue': case 'json': case 'html': case 'css': case 'java': case 'go': case 'rs': case 'sh': case 'yml': case 'yaml': return 'fa-file-code-o'
    case 'zip': case 'rar': case '7z': case 'tar': case 'gz': return 'fa-file-archive-o'
    case 'excalidraw': case 'drawio': case 'flow': case 'mmd': case 'data': case 'task': return 'fa-file-o'
    default: return 'fa-file-o'
  }
}

function isDir(node: FsNode): boolean {
  return node?.type === 'folder' || node?.type === 'dir'
}

const isExpanded = (p: string) => !!expanded.value[p]

/** 列表行：把树按「展开状态」拍平（比递归组件更好控样式与虚拟滚动） */
interface Row {
  node: FsNode
  depth: number
  isDir: boolean
  expanded: boolean
  loading: boolean
}

const allRows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (nodes: FsNode[], depth: number) => {
    for (const node of nodes) {
      if (!node?.path) continue
      const dir = isDir(node)
      const open = dir && isExpanded(node.path)
      out.push({ node, depth, isDir: dir, expanded: open, loading: !!loadingDirs.value[node.path] })
      if (open) {
        const kids = childrenCache.value[node.path]
        if (kids?.length) walk(kids, depth + 1)
      }
    }
  }
  walk(rootNodes.value, 0)
  return out
})

const visibleRows = computed<Row[]>(() => {
  const q = filterText.value.trim().toLowerCase()
  if (!q) return allRows.value
  return allRows.value.filter((r) => String(r.node.label || fileNameOf(r.node.path)).toLowerCase().includes(q))
})

/** 拉一层子节点（depth=1） */
async function loadChildren(dir: string): Promise<void> {
  if (!canRead.value || !dir) return
  if (childrenCache.value[dir]) return
  loadingDirs.value = { ...loadingDirs.value, [dir]: true }
  try {
    const nodes = (await getPlatform().fs.listTree(dir, 1)) as FsNode[] | null
    childrenCache.value = { ...childrenCache.value, [dir]: Array.isArray(nodes) ? nodes.filter((n) => n?.path) : [] }
  } catch {
    childrenCache.value = { ...childrenCache.value, [dir]: [] }
  } finally {
    const next = { ...loadingDirs.value }
    delete next[dir]
    loadingDirs.value = next
  }
}

/** 重新加载根目录（并清掉所有缓存，保证看到的是磁盘最新状态） */
async function reload(): Promise<void> {
  childrenCache.value = {}
  expanded.value = {}
  loadingDirs.value = {}
  rootNodes.value = []
  if (!canRead.value || !rootPath.value) return
  loading.value = true
  try {
    const nodes = (await getPlatform().fs.listTree(rootPath.value, 1)) as FsNode[] | null
    rootNodes.value = Array.isArray(nodes) ? nodes.filter((n) => n?.path) : []
  } catch {
    rootNodes.value = []
  } finally {
    loading.value = false
  }
}

function onRowClick(row: Row): void {
  if (row.isDir) {
    const next = { ...expanded.value }
    if (next[row.node.path]) delete next[row.node.path]
    else next[row.node.path] = true
    expanded.value = next
    if (next[row.node.path]) void loadChildren(row.node.path)
    return
  }
  // 文件：在**当前右侧栏**里以 file 标签打开（内容复用文件窗口的多视图选择）。
  // 特殊文件（.kb / .task / .html / 系统打开类）仍由宿主按统一调度处理，见 home.vue。
  const name = fileNameOf(row.node.path)
  emit('open-file', { path: row.node.path, label: row.node.label || name })
}

/** 插入相对路径（行内代码形式，便于智能体直接读取） */
function insertPath(node: FsNode): void {
  const rel = relativeToRoot(node.path)
  emit('insert-text', '`' + rel + '`')
}

onMounted(() => { void reload() })

// 工作区切换：根目录变了就重载
watch(rootPath, () => { void reload() })
// 标签重新激活时刷新一次（DSH 的文件页也是「切回来看到最新」）
watch(() => props.active, (v) => { if (v) void reload() })
</script>

<style scoped>
.dock-files {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 12px;
  color: var(--fontColor);
}
.dock-files-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.dock-files-root {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.85;
}
.dock-files-filter {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
  opacity: 0.9;
}
.dock-filter-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  height: 20px;
  margin:0px;
}
.dock-filter-clear { cursor: pointer; opacity: 0.6; }
.dock-filter-clear:hover { opacity: 1; }
.dock-files-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 3px 0 10px;
}
.dock-file-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding-right: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.dock-file-row:hover { background: color-mix(in srgb, var(--fontColor) 7%, transparent); }
.dock-file-row.folder { font-weight: 500; }
.dock-row-caret {
  width: 10px;
  flex-shrink: 0;
  font-size: 10px;
  opacity: 0.7;
}
.dock-row-icon { flex-shrink: 0; opacity: 0.8; color: var(--fontActiveColor); }
.dock-file-row.folder .dock-row-icon { color: #f0b429; }
.dock-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dock-row-loading { opacity: 0.6; font-size: 10px; }
.dock-row-insert {
  display: none;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  padding: 0 2px;
  opacity: 0.7;
}
.dock-file-row:hover .dock-row-insert { display: inline-block; }
.dock-row-insert:hover { opacity: 1; color: var(--fontActiveColor); }
.dock-icon-btn {
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  padding: 0 3px;
  opacity: 0.75;
}
.dock-icon-btn:hover { opacity: 1; color: var(--fontActiveColor); }
.dock-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 26px 14px;
  text-align: center;
  opacity: 0.6;
  font-size: 12px;
  line-height: 1.5;
}
.dock-empty i { font-size: 18px; }
</style>
