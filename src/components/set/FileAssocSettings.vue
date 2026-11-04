<!-- FileAssocSettings.vue - 设置 → 其他：文件关联（默认打开方式） -->
<template>
  <div class="file-assoc-settings">
    <div class="settings-group">
      <h3>
        {{ zh ? '文件行为' : 'File Behavior' }}
        <i class="fa fa-info-circle fa-title-info" :title="intro"></i>
        <span class="fa-count">{{ filteredRows.length }} / {{ behaviorRows.length }}</span>
      </h3>

      <!-- 平台 / 开发版提示 -->
      <div class="form-group" v-for="(n, i) in notices" :key="'n' + i">
        <div class="config-description fa-notice" :class="n.type" style="margin-left:0">
          <i class="fa" :class="n.icon"></i> {{ n.text }}
        </div>
      </div>

      <div class="form-group" v-if="loading">
        <div class="config-description" style="margin-left:0">
          <i class="fa fa-spinner fa-spin"></i> {{ zh ? '正在读取系统关联状态…' : 'Reading system associations…' }}
        </div>
      </div>

      <template v-else>
        <!-- 顶部工具条：搜索 + 批量操作（与工具管理面板一致） -->
        <div class="fa-toolbar">
          <div class="fa-search-box">
            <i class="fa fa-search fa-search-icon"></i>
            <input
              v-model="search"
              type="text"
              :placeholder="zh ? '搜索文件类型 / 后缀 / 视图' : 'Search type / extension / view'"
              @keydown.esc="search = ''"
            />
            <i v-if="search" class="fa fa-times-circle fa-search-clear" :title="zh ? '清空' : 'Clear'" @click="search = ''"></i>
          </div>
          <div class="fa-actions">
            <div class="button fa-action-btn" :class="{ disabled: busy }" @click="applyAll('default')" :title="applyAllTitle">
              <i class="fa fa-check-circle-o"></i> {{ zh ? '全部设为默认' : 'Set All Default' }}
            </div>
            <div class="button fa-action-btn" :class="{ disabled: busy }" @click="applyAll('none')" :title="clearAllTitle">
              <i class="fa fa-eraser"></i> {{ zh ? '全部取消关联' : 'Clear All' }}
            </div>
            <div class="button fa-action-btn" :class="{ disabled: busy }" @click="load()" :title="zh ? '重新读取系统状态' : 'Reload system state'">
              <i class="fa fa-refresh"></i> {{ zh ? '刷新' : 'Refresh' }}
            </div>
          </div>
        </div>

        <div v-if="!filteredRows.length" class="fa-empty">
          <i class="fa fa-search"></i>
          <span>{{ zh ? '没有匹配的文件类型' : 'No matching file types' }}</span>
        </div>

        <!-- Grid 卡片：每个格式一张卡，小窗口自动降为单列，避免表格横向挤压 -->
        <div v-else class="fa-grid">
          <article v-for="r in filteredRows" :key="r.key" class="fa-card">
            <div class="fa-card-head">
              <img v-if="r.osEntry && iconOf(r.osEntry.key)" class="fa-type-icon" :src="iconOf(r.osEntry.key)" alt="" />
              <i v-else class="fa fa-type-icon fa-type-icon-fallback" :class="rowIcon(r)"></i>
              <div class="fa-card-title">
                <span class="fa-type-name" :title="r.label">{{ r.label }}</span>
                <span class="fa-exts" :title="r.exts.join(' ')">{{ extSummary(r) }}</span>
              </div>
              <span
                v-if="hasChoice(r)"
                class="fa-warn fa-card-warn"
                :title="choiceTitle(r)"
              ><i class="fa fa-exclamation-triangle"></i></span>
            </div>

            <div class="fa-field">
              <span class="fa-field-label">{{ zh ? '应用内默认' : 'In-app default' }}</span>
              <select
                v-if="viewOptions(r).length > 1"
                class="layout-select fa-mini-select"
                :value="defaultOfExts(r.exts)"
                :disabled="busy"
                :title="zh ? '该格式默认用哪个视图 / 查看器（自动 = 按文件窗口默认）' : 'Default view / viewer for this format (Auto = file-window default)'"
                @change="onDefaultChange(r.exts, $event)"
              >
                <option value="">{{ zh ? '自动（按文件窗口默认）' : 'Auto (file-window default)' }}</option>
                <option v-for="o in viewOptions(r)" :key="o.value" :value="o.value">
                  {{ zh ? o.titleZh : o.titleEn }}{{ o.source === 'plugin' ? ` · ${o.pluginId}` : '' }}
                </option>
              </select>
              <span v-else class="fa-field-static">{{ viewOptions(r).length ? (zh ? viewOptions(r)[0].titleZh : viewOptions(r)[0].titleEn) : '—' }}</span>
            </div>

            <div class="fa-field">
              <span class="fa-field-label">{{ zh ? '系统默认' : 'System default' }}</span>
              <template v-if="r.osEntries && r.osEntries.length">
                <select
                  v-if="r.osEntries.every(isSelectable)"
                  class="layout-select fa-mini-select"
                  :value="groupModeOf(r.osEntries)"
                  :disabled="busy"
                  :title="zh ? '统一设置这张卡里所有源码 / 配置类型的系统关联' : 'Set the system association for every source/config type in this card'"
                  @change="onOsGroupChange(r.osEntries, $event)"
                >
                  <option value="">{{ zh ? '混合（保持各自）' : 'Mixed (keep each)' }}</option>
                  <option value="none">{{ zh ? '不关联' : 'Not associated' }}</option>
                  <option v-if="info?.supportsOpenWith" value="openwith">{{ zh ? '加入「打开方式」' : 'Add to "Open with"' }}</option>
                  <option value="default">{{ zh ? '设为默认打开方式' : 'Set as default' }}</option>
                </select>
                <span v-else class="fa-field-static">{{ unsupportedText }}</span>
              </template>
              <template v-else-if="r.osEntry">
                <select
                  v-if="isSelectable(r.osEntry)"
                  class="layout-select fa-mini-select"
                  :value="modeOf(r.osEntry.key)"
                  :disabled="busy"
                  :title="selectTitle"
                  @change="onChange(r.osEntry, $event)"
                >
                  <option value="none">{{ zh ? '不关联' : 'Not associated' }}</option>
                  <option v-if="info?.supportsOpenWith" value="openwith">{{ zh ? '加入「打开方式」' : 'Add to "Open with"' }}</option>
                  <option value="default">{{ zh ? '设为默认打开方式' : 'Set as default' }}</option>
                </select>
                <span v-else class="fa-field-static">{{ unsupportedText }}</span>
              </template>
              <span v-else class="fa-field-static">{{ zh ? '系统未注册' : 'Not registered' }}</span>
            </div>

            <!-- 可用视图放卡片最下方；卡片等高时统一贴底 -->
            <div class="fa-field fa-field-views">
              <span class="fa-field-label">{{ zh ? '可用视图' : 'Views' }}</span>
              <div class="fa-viewers">
                <span
                  v-for="o in viewOptions(r)"
                  :key="o.value"
                  class="fa-viewer-chip"
                  :class="{ plugin: o.source === 'plugin' }"
                  :title="zh ? o.titleZh : o.titleEn"
                >
                  <i class="fa" :class="o.icon || 'fa-file-o'"></i>
                  <span>{{ zh ? o.titleZh : o.titleEn }}</span>
                  <em>{{ o.source === 'plugin' ? (zh ? '插件' : 'Plugin') : (zh ? '内置' : 'Built-in') }}</em>
                </span>
                <span v-if="!viewOptions(r).length" class="fa-muted">—</span>
              </div>
            </div>
          </article>
        </div>

        <div class="form-group">
          <div class="config-description" style="margin-left:0">{{ footer }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import { getPlatform, hasCapability } from '@/platform'
import { fileViewerCatalog, type FileViewerCatalogEntry } from '@/lib/knowFile/fileViewerCatalog'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const loading = ref(true)
const busy = ref(false)
const info = ref<any>(null)
const states = ref<Record<string, { mode: string; userChoice?: string }>>({})
/** key → 类型图标的 PNG data URL（主进程随状态一起下发，只有 Windows 有） */
const icons = ref<Record<string, string>>({})
/** 文件关联是应用壳能力（桌面主进程维护），网页端没有 */
const hasIpc = hasCapability('app.shell')

interface FileBehaviorRow {
  key: string
  label: string
  exts: string[]
  osEntry: any | null
  /** 合并的系统类型（目前只有「其他源码」卡会一次管理多个系统关联项） */
  osEntries?: any[]
  viewers: FileViewerCatalogEntry[]
}

/** 高优先级插件接管的扩展名：内置卡片不再把这些后缀算进自己的格式组 */
const takeoverExts = computed(() => new Set(
  fileViewerCatalog.value
    .filter((v) => v.source === 'plugin' && Number(v.priority) > 100)
    .flatMap((v) => v.extensions),
))

/** 合并「应用内查看器」与「系统文件关联」为一张表：先按系统类型分组，再补插件/内置专属格式 */
const behaviorRows = computed<FileBehaviorRow[]>(() => {
  const rows: FileBehaviorRow[] = []
  const covered = new Set<string>()
  const takeover = takeoverExts.value
  const sourceViewer = fileViewerCatalog.value.find((v) => v.id === 'builtin.code')
  const sourceExts = new Set(sourceViewer?.extensions || [])
  const sourceOsEntries: any[] = []
  const osEntries = (info.value?.entries || [])
  for (const e of osEntries) {
    const exts = (Array.isArray(e.exts) ? e.exts : []).map((x: string) => {
      const s = String(x).trim().toLowerCase()
      return s.startsWith('.') ? s : `.${s}`
    })
    // 代码 / 配置 / 样式统一收进一张「其他源码」卡，避免出现很多只有源码编辑的碎片卡
    if (exts.length && exts.every((x: string) => sourceExts.has(x))) {
      exts.forEach((x: string) => covered.add(x))
      sourceOsEntries.push(e)
    }
  }
  if (sourceViewer && sourceOsEntries.length) {
    const allExts = new Set<string>(sourceViewer.extensions)
    for (const e of sourceOsEntries) {
      for (const x of (e.exts || [])) allExts.add(String(x).startsWith('.') ? String(x).toLowerCase() : `.${String(x).toLowerCase()}`)
    }
    rows.push({
      key: 'source-group',
      label: zh.value ? '其他源码' : 'Other source',
      exts: [...allExts].filter((x) => !takeover.has(x)),
      osEntry: null,
      osEntries: sourceOsEntries,
      viewers: [sourceViewer],
    })
  }
  for (const e of osEntries) {
    const exts = (Array.isArray(e.exts) ? e.exts : []).map((x: string) => {
      const s = String(x).trim().toLowerCase()
      return s.startsWith('.') ? s : `.${s}`
    })
    if (sourceOsEntries.includes(e)) continue
    exts.forEach((x: string) => covered.add(x))
    const viewers = fileViewerCatalog.value.filter((v) =>
      v.extensions.some((x) => exts.includes(x) && (!takeover.has(x) || v.source === 'plugin')),
    )
    rows.push({
      key: `os:${e.key}`,
      label: zh.value ? (e.labelZh || e.labelEn) : (e.labelEn || e.labelZh),
      exts,
      osEntry: e,
      viewers,
    })
  }
  // 系统没有对应条目的格式（多为插件贡献的自定义格式，或内置音视频/图片等）
  const seen = new Set<string>()
  for (const v of fileViewerCatalog.value) {
    if (v.id === 'builtin.code' && sourceOsEntries.length) continue
    const effectiveExts = (v.source === 'plugin' ? v.extensions : v.extensions.filter((x) => !takeover.has(x)))
      .filter((x) => !covered.has(x))
    if (!effectiveExts.length) continue
    const extKey = effectiveExts.join(',')
    if (seen.has(extKey)) {
      const row = rows.find((r) => r.key === `viewer:${extKey}`)
      if (row) row.viewers.push(v)
      continue
    }
    seen.add(extKey)
    rows.push({
      key: `viewer:${extKey}`,
      label: zh.value ? v.titleZh : v.titleEn,
      exts: [...effectiveExts],
      osEntry: null,
      viewers: [v],
    })
  }
  // Markdown 是最高频的文本格式，固定放到第一张卡
  const markdownRank = (r: FileBehaviorRow): number =>
    r.exts.some((x) => ['.md', '.markdown', '.mdown', '.mkd'].includes(x)) ? 0 : 1
  return rows.sort((a, b) => markdownRank(a) - markdownRank(b))
})

/** 卡片图标：系统类型有 PNG 图标时优先；否则用查看器声明的 FA 图标（如「其他源码」的 fa-file-code-o） */
function rowIcon(r: FileBehaviorRow): string {
  return r.viewers?.[0]?.icon || 'fa-file-o'
}

/** 表格第三列的选项：内置格式展开成每个可选视图；插件查看器作为一项 */
interface FileBehaviorViewOption {
  value: string
  titleZh: string
  titleEn: string
  icon: string
  source: 'builtin' | 'plugin'
  pluginId?: string
}
function viewOptions(r: FileBehaviorRow): FileBehaviorViewOption[] {
  const out: FileBehaviorViewOption[] = []
  const seen = new Set<string>()
  for (const v of r.viewers) {
    if (v.source === 'plugin') {
      if (!seen.has(v.id)) {
        seen.add(v.id)
        out.push({ value: v.id, titleZh: v.titleZh, titleEn: v.titleEn, icon: v.icon, source: 'plugin', pluginId: v.pluginId })
      }
      continue
    }
    for (const view of (v.views || [])) {
      if (!view.key || seen.has(view.key)) continue
      seen.add(view.key)
      out.push({ value: view.key, titleZh: view.titleZh, titleEn: view.titleEn, icon: view.icon, source: 'builtin' })
    }
    // 目录缺少 views 的旧数据兜底
    if (!(v.views || []).length && v.viewKey && !seen.has(v.viewKey)) {
      seen.add(v.viewKey)
      out.push({ value: v.viewKey, titleZh: v.titleZh, titleEn: v.titleEn, icon: v.icon, source: 'builtin' })
    }
  }
  return out
}

const search = ref('')
const filteredRows = computed<FileBehaviorRow[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return behaviorRows.value
  return behaviorRows.value.filter((r) => {
    const views = viewOptions(r).map((o) => `${o.titleZh} ${o.titleEn}`).join(' ')
    return `${r.label} ${r.exts.join(' ')} ${views}`.toLowerCase().includes(q)
  })
})

/** 合并后只显示代表性后缀：完全取当前卡片的真实 exts，不写死格式名 */
const extSummary = (r: FileBehaviorRow): string => {
  const n = r.exts.length
  if (!n) return '—'
  const shown = r.exts.slice(0, 4).join(' ')
  return n > 4 ? `${shown} 等 ${n} 种` : shown
}

/** 一行覆盖多个后缀时：默认值一致才显示，避免误以为整组已设置 */
const defaultOfExts = (exts: string[]): string => {
  const values = exts.map((x) => String(store.UI.fileViewerDefaults?.[x] || ''))
  const first = values[0] || ''
  return values.every((v) => v === first) ? first : ''
}

function onDefaultChange(exts: string[], e: Event) {
  const value = String((e.target as HTMLSelectElement).value || '')
  const next = { ...(store.UI.fileViewerDefaults || {}) }
  for (const x of exts) {
    if (value) next[x] = value
    else delete next[x]
  }
  store.UI.fileViewerDefaults = next
  store.saveConfig()
}

// ---------- 文案 ----------
const intro = computed(() => zh.value
  ? '管理每种文件类型的「应用内查看器」和「系统默认打开方式」。插件可以贡献查看器（表中标注「插件」）；同一格式有多个查看器时，可直接在标题栏的视图菜单里切换，也可在这里设置默认项。系统关联部分：安装版在安装时已注册这些类型（PDF 除外），此处可随时调整（写入当前用户，无需管理员权限）。「设为默认」会让双击该类型文件直接在本软件的新窗口中打开。PDF 默认不关联，以免抢占系统 PDF 阅读器，需要时请在此手动选择。'
  : 'Manage the in-app viewer and the system default app for each file type. Plugins can contribute viewers (marked “Plugin”); when a format has several viewers, switch them from the view menu in the title bar or pick the default here. System associations: the installer registers these types (except PDF), and you can adjust them here (current-user scope, no admin rights). "Set as default" makes double-click open the file in a new app window. PDF is deliberately not associated by default so your system PDF reader stays in charge — pick it here if you want it.')

const footer = computed(() => zh.value
  ? '提示：Windows 8 及以上版本中，若某类型已被用户通过「打开方式 → 始终使用此应用」选定过默认程序，系统会优先采用该选择（程序无法覆盖）——此时请右键文件 → 打开方式 → 选择其他应用 → AI-KM，并勾选「始终使用」。'
  : 'Note: on Windows 8+, if a default app was already chosen via "Open with → Always use this app", the system keeps that choice (apps cannot override it). In that case, right-click the file → Open with → Choose another app → AI-KM and check "Always use".')

const selectTitle = computed(() => zh.value
  ? '不关联：移除本软件对该类型的注册\n加入「打开方式」：右键「打开方式」列表中出现 AI-KM（不改变默认程序）\n设为默认：双击直接用本软件打开'
  : 'Not associated: remove this app\'s registration\nAdd to "Open with": show AI-KM in the right-click Open with list (does not change the default)\nSet as default: double-click opens with this app')

/** 常见系统默认程序的 ProgID → 友好名称（仅用于提示文案；未命中时原样显示 ProgID） */
const PROGID_NAMES: Record<string, string> = {
  MSEdgePDF: 'Microsoft Edge',
  AppXq0fevzme2pys62n3e0fbqa7peapykr8v: 'Microsoft Edge',
  ChromePDF: 'Google Chrome',
  ChromeHTML: 'Google Chrome',
}
function progIdName(p?: string) {
  const id = String(p || '').trim()
  if (!id) return id
  if (PROGID_NAMES[id]) return PROGID_NAMES[id]
  if (/^AcroExch\./i.test(id)) return 'Adobe Acrobat / Reader'
  if (/^MSEdge/i.test(id)) return 'Microsoft Edge'
  if (/^Chrome/i.test(id)) return 'Google Chrome'
  if (/^Firefox/i.test(id)) return 'Mozilla Firefox'
  if (/^FoxitReader/i.test(id)) return 'Foxit Reader'
  return id
}

const userChoiceTitle = (p?: string) => zh.value
  ? `系统记录的默认程序为「${progIdName(p)}」，Windows 会优先使用它；如需改用本软件，请在「打开方式」中选择 AI-KM 并勾选「始终使用」`
  : `Windows currently uses "${progIdName(p)}" as the default; to switch, pick AI-KM in "Open with" and check "Always use"`

const applyAllTitle = computed(() => zh.value ? '把所有类型设为默认打开方式' : 'Set every type as default')
const clearAllTitle = computed(() => zh.value ? '取消本软件对所有类型的注册（不删除系统文件）' : 'Remove all registrations (files are not deleted)')

const notices = computed(() => {
  const out: { type: string; icon: string; text: string }[] = []
  if (!hasIpc) {
    out.push({ type: 'error', icon: 'fa-desktop', text: zh.value
      ? '当前为浏览器 / LAN 模式，文件关联仅在桌面版可用。'
      : 'File associations are only available in the desktop app (not in browser/LAN mode).' })
    return out
  }
  const rc = info.value?.reasonCode
  if (info.value && !info.value.supported) {
    const text = rc === 'macos'
      ? (zh.value
        ? 'macOS 不允许软件自己改默认打开方式：安装版已在 Info.plist 里声明这些文件类型，因此会出现在「打开方式」列表中（不抢系统默认程序）。请在「访达」中右键文件 → 显示简介 → 打开方式，选择 AI-KM 后点「全部更改」。'
        : 'macOS does not allow apps to change the default handler themselves. The installed build declares these file types in Info.plist, so AI-KM does appear in the "Open with" list (without claiming the system default). In Finder, right-click the file → Get Info → Open with, pick AI-KM, then click "Change All".')
      : rc === 'no-desktop-entry'
        ? (zh.value
          ? '未检测到桌面条目（ai-km.desktop / AI-KM.desktop）：Linux 上的文件关联需要安装包提供的桌面条目声明 MIME 类型，请使用 .deb 安装版；AppImage / 免安装版需先做桌面集成（如 AppImageLauncher / 手动安装 .desktop）。'
          : 'No desktop entry found (ai-km.desktop / AI-KM.desktop): on Linux the association needs a desktop entry that declares the MIME types, so please use the .deb package; AppImage/portable builds need desktop integration first (e.g. AppImageLauncher or installing the .desktop manually).')
        : (zh.value ? '当前平台不支持在软件内设置默认打开方式。' : 'Setting the default app is not supported on this platform.')
    out.push({ type: 'warn', icon: 'fa-info-circle', text })
  }
  if (info.value?.supported && !info.value.isPackaged) {
    out.push({ type: 'warn', icon: 'fa-flask', text: zh.value
      ? '当前为开发版：关联命令指向开发环境（electron.exe + 项目路径），双击文件会尝试启动开发版，仅供调试；正式使用请在安装版中设置。'
      : 'Development build: the association points to the dev environment (electron.exe + project path). For daily use, configure this in the installed build.' })
  }
  return out
})

// ---------- 状态读取 / 修改 ----------
const extText = (e: any) => (e.exts || []).map((x: string) => '.' + x).join(' ')

const stateOf = (key: string) => states.value[key] || { mode: 'none' }
const modeOf = (key: string) => stateOf(key).mode || 'none'
/** 多个系统类型的统一模式：全一致才返回，否则空（混合） */
const groupModeOf = (entries: any[]): string => {
  const modes = entries.map((e) => modeOf(e.key))
  return modes.every((m) => m === modes[0]) ? (modes[0] || 'none') : ''
}
const hasChoice = (r: FileBehaviorRow): boolean => {
  const entries = r.osEntries?.length ? r.osEntries : (r.osEntry ? [r.osEntry] : [])
  return entries.some((e) => !!stateOf(e.key).userChoice)
}
const choiceTitle = (r: FileBehaviorRow): string => {
  const entries = r.osEntries?.length ? r.osEntries : (r.osEntry ? [r.osEntry] : [])
  const hit = entries.find((e) => !!stateOf(e.key).userChoice)
  return hit ? userChoiceTitle(stateOf(hit.key).userChoice) : ''
}
/** 统一设置一组系统类型的关联模式（用于「其他源码」合并卡） */
async function onOsGroupChange(entries: any[], ev: Event) {
  const mode = String((ev.target as HTMLSelectElement).value || '')
  if (!mode) return
  for (const e of entries) {
    if (!isSelectable(e)) continue
    await setMode(e.key, mode)
  }
}
const iconOf = (key: string) => icons.value[key] || ''
/** 该类型在当前平台是否可设置（Linux 上仅支持有 MIME 映射的类型） */
const isSelectable = (e: any) => !!info.value?.supported && (info.value.platform !== 'linux' || !!e.mime)
/** label 悬停提示：类型名 + 扩展名清单 */
const labelTitle = (e: any) => `${zh.value ? e.labelZh : e.labelEn}  ${extText(e)}`
const unsupportedText = computed(() => zh.value
  ? '该类型在 Linux 上由系统 MIME 数据库管理，暂不支持在此设置'
  : 'Managed by the system MIME database on Linux; not configurable here')

function applyState(data: any) {
  info.value = data
  states.value = { ...(data?.states || {}) }
  icons.value = { ...(data?.icons || {}) }
}

async function load() {
  if (!hasIpc) { loading.value = false; return }
  loading.value = true
  try {
    const res: any = await getPlatform().app.getFileAssocState()
    if (res?.ok) applyState(res.data)
    else ElMessage.error(res?.error?.message || (zh.value ? '读取文件关联失败' : 'Failed to read file associations'))
  } catch (err: any) {
    ElMessage.error(err?.message || (zh.value ? '读取文件关联失败' : 'Failed to read file associations'))
  } finally {
    loading.value = false
  }
}

async function setMode(key: string, mode: string) {
  busy.value = true
  try {
    const res: any = await getPlatform().app.setFileAssoc({ key, mode })
    if (res?.ok) {
      applyState(res.data)
    } else {
      ElMessage.error(res?.error?.message || (zh.value ? '设置失败' : 'Failed to apply'))
      await load()
    }
  } catch (err: any) {
    ElMessage.error(err?.message || (zh.value ? '设置失败' : 'Failed to apply'))
    await load()
  } finally {
    busy.value = false
  }
}

async function onChange(entry: any, ev: Event) {
  const mode = (ev.target as HTMLSelectElement).value
  await setMode(entry.key, mode)
}

async function applyAll(mode: 'default' | 'none') {
  if (!info.value?.entries?.length) return
  busy.value = true
  try {
    for (const e of info.value.entries) {
      if (!isSelectable(e)) continue
      const res: any = await getPlatform().app.setFileAssoc({ key: e.key, mode })
      if (res?.ok) applyState(res.data)
      else {
        ElMessage.error(res?.error?.message || (zh.value ? '设置失败' : 'Failed to apply'))
        break
      }
    }
    if (mode === 'default') {
      ElMessage.success(zh.value ? '已把支持的类型设为默认打开方式' : 'All supported types set as default')
    } else {
      ElMessage.success(zh.value ? '已取消本软件的文件关联' : 'Associations cleared')
    }
  } catch (err: any) {
    ElMessage.error(err?.message || (zh.value ? '设置失败' : 'Failed to apply'))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
/* ====== 容器（与设置页其余面板一致） ====== */
.file-assoc-settings { padding: 2px; }

/* ====== 分组 / 标题 ====== */
.settings-group { margin-bottom: 5px; padding: 8px; }
.settings-group:last-child { margin-bottom: 0; }
.settings-group h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}
.settings-group h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* ====== 表单行 ====== */
.form-group { display: flex; align-items: center; margin-bottom: 5px; }
.form-group > * { margin: 0; }
.form-group:last-child { margin-bottom: 0; }
.form-group label {
  width: 140px;
  min-width: 140px;
  color: var(--fontColor);
  font-size: 14px;
  user-select: none;
  line-height: 1;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
}
/* 类型图标：与资源管理器里的文件图标一致，方便核对哪个类型是哪个颜色 */
.fa-type-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  margin-right: 6px;
  object-fit: contain;
}
.fa-type-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.form-group select {
  flex: 1;
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  height: 33px;
  box-sizing: border-box;
}
.form-group select:focus { outline: none; border-color: var(--fontActiveColor); }
.form-group select:disabled { opacity: 0.5; cursor: not-allowed; }
.layout-select { flex: 1; min-width: 0; box-sizing: border-box; }

/* ====== 说明 / 提示 ====== */
.config-description {
  flex: 1;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  margin-left: 5px;
  line-height: 1.5;
}
.fa-notice { opacity: 0.9; }
.fa-notice i { margin-right: 4px; }
.fa-notice.warn { color: #e6a23c; }
.fa-notice.error { color: #e74c3c; }
.fa-warn { flex-shrink: 0; margin-left: 6px; color: #e6a23c; }

/* ====== 按钮 / 按钮组（与其它设置模块一致） ====== */
.button {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 14px;
  white-space: nowrap;
  width: calc(100% - 20px);
  margin: 0;
  padding: 6px 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button i { font-size: 14px; }
.button.disabled { opacity: 0.5; pointer-events: none; }
.button-group {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.button-group .button { width: calc(100% - 14px); }

.fa-count {
  margin-left: 7px;
  font-size: 10px;
  font-weight: 400;
  opacity: .55;
}
.fa-title-info {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 400;
  opacity: .55;
  cursor: help;
}
.fa-toolbar {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
}
.fa-search-box {
  flex: 1;
  min-width: 0;
  max-width: 300px;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--backgroundColor);
}
.fa-search-icon {
  flex: 0 0 13px;
  width: 13px;
  height: 13px;
  align-self: center;
  margin: 0;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
  opacity: .5;
  border: 0;
  background: transparent;
}
.fa-search-box > input {
  flex: 1;
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  border: 0 !important;
  outline: 0;
  box-shadow: none !important;
  background: transparent !important;
  color: var(--fontColor);
  font-size: 11px;
  line-height: normal;
  padding: 0 !important;
  margin: 0 !important;
}
.fa-search-clear { cursor: pointer; opacity: .55; }
.fa-actions { display: flex; gap: 5px; flex-shrink: 0; margin-left: auto; }
.fa-action-btn {
  width: auto;
  min-width: 0;
  padding: 5px 8px;
  margin: 0;
  font-size: 10px;
}
.fa-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 28px 12px;
  font-size: 11px;
  opacity: .5;
}
.fa-field-views { align-items: start; }

/* ====== 文件行为：Grid 卡片（小窗口自动单列） ====== */
.fa-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
  grid-auto-rows: 1fr;
  gap: 7px;
  align-items: stretch;
}
.fa-card {
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
}
.fa-card:hover { border-color: var(--fontActiveColor); }
.fa-card-head { display: flex; align-items: center; gap: 6px; min-width: 0; padding-bottom: 4px; border-bottom: 1px solid var(--borderColor); }
.fa-card-warn { margin-left: auto; flex-shrink: 0; margin-right: 0; }
.fa-card-title { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.fa-type-icon { width: 18px; height: 18px; flex-shrink: 0; object-fit: contain; }
.fa-type-icon-fallback { opacity: .45; font-size: 15px; text-align: center; }
.fa-type-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-exts { font-size: 9px; opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; }
.fa-field { display: grid; grid-template-columns: 62px minmax(0, 1fr); align-items: center; gap: 6px; min-width: 0; }
.fa-field-label { font-size: 9px; opacity: .55; white-space: nowrap; }
.fa-field-static { min-width: 0; font-size: 10px; opacity: .65; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-viewers { display: flex; flex-wrap: wrap; gap: 3px; min-width: 0; }
.fa-viewer-chip {
  display: inline-flex; align-items: center; gap: 3px; max-width: 100%;
  padding: 1px 5px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--menuColor); font-size: 9px;
}
.fa-viewer-chip.plugin { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.fa-viewer-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fa-viewer-chip em { flex-shrink: 0; font-style: normal; font-size: 8px; opacity: .6; }
.fa-mini-select { min-width: 0; width: 100%; height: 27px; font-size: 10px; padding: 0 4px; margin: 0; }
.fa-field select { margin: 0; }
.fa-muted { font-size: 10px; opacity: .4; }
</style>
