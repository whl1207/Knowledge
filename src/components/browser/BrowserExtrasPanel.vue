<!-- src/components/browser/BrowserExtrasPanel.vue
     P1 浏览器扩展面板：下载列表 + 浏览历史 / 最近关闭。
     数据全部经 browser-agent:* IPC 查询；下载进度由主进程 browser-agent:downloads 事件推送。 -->
<template>
  <div class="browser-extras">
    <div v-if="mode === 'both'" class="bx-tabs">
      <button class="bx-tab" :class="{ on: tab === 'downloads' }" @click="switchTab('downloads')">
        <i class="fa fa-download"></i> {{ zh ? '下载' : 'Downloads' }}<span v-if="downloads.length" class="bx-count">{{ downloads.length }}</span>
      </button>
      <button class="bx-tab" :class="{ on: tab === 'history' }" @click="switchTab('history')">
        <i class="fa fa-history"></i> {{ zh ? '历史' : 'History' }}
      </button>
    </div>

    <template v-if="tab === 'downloads'">
      <div v-if="!downloads.length" class="bx-empty">{{ zh ? '暂无下载' : 'No downloads' }}</div>
      <div v-for="d in downloads" :key="d.id" class="bx-row" :title="d.path">
        <i class="fa bx-ic" :class="downloadIcon(d)"></i>
        <span class="bx-name" @click="openDownload(d)">{{ d.filename }}</span>
        <span class="bx-meta">{{ downloadMeta(d) }}</span>
        <button v-if="d.state === 'completed'" class="bx-mini" :title="zh ? '在文件夹中显示' : 'Show in folder'" @click="revealDownload(d)">
          <i class="fa fa-folder-open-o"></i>
        </button>
      </div>
      <button v-if="downloads.length" class="bx-action" @click="clearDownloads">
        <i class="fa fa-trash-o"></i> {{ zh ? '清空下载记录' : 'Clear download list' }}
      </button>
    </template>

    <template v-else>
      <div class="bx-search">
        <i class="fa fa-search bx-search-ic"></i>
        <input
          v-model="query"
          class="bx-search-input"
          spellcheck="false"
          :placeholder="zh ? '搜索历史' : 'Search history'"
          @input="loadHistory"
        />
        <button v-if="query" class="bx-search-clear" :title="zh ? '清除' : 'Clear'" @click="clearQuery">
          <i class="fa fa-times-circle"></i>
        </button>
      </div>
      <div v-if="!history.length" class="bx-empty">{{ zh ? '暂无历史' : 'No history' }}</div>
      <div v-for="h in history" :key="h.id" class="bx-row bx-click" :title="h.url" @click="onOpenTab?.(h.url)">
        <i class="fa bx-ic" :class="h.agent ? 'fa-android' : 'fa-clock-o'"></i>
        <span class="bx-name">{{ h.title || h.url }}</span>
        <span class="bx-meta">{{ shortTime(h.visitedAt) }}</span>
      </div>
      <template v-if="closed.length && !query">
        <div class="bx-sec">{{ zh ? '最近关闭' : 'Recently closed' }}</div>
        <div v-for="c in closed" :key="c.id" class="bx-row bx-click" :title="c.url" @click="restoreClosed(c)">
          <i class="fa bx-ic fa-undo"></i>
          <span class="bx-name">{{ c.title || c.url }}</span>
        </div>
      </template>
      <button v-if="history.length && !query" class="bx-action" @click="clearHistory">
        <i class="fa fa-trash-o"></i> {{ zh ? '清空历史' : 'Clear history' }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usestore } from '@/store'
import { getPlatform } from '@/platform'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const props = withDefaults(defineProps<{
  /** 面板是否可见（可见时刷新下载/历史并订阅下载事件） */
  active?: boolean
  /** both=带页签；downloads/history=只显示单一面板（工具栏弹层用） */
  mode?: 'both' | 'downloads' | 'history'
  onOpenTab?: (url: string) => void
}>(), { active: false, mode: 'both' })

const invoke = (method: string, payload?: any) =>
  getPlatform().browserAgent.call(method.replace(/^browser-agent:/, '') as any, payload)

type DownloadRow = {
  id: string; filename: string; url: string; path: string
  state: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number; totalBytes: number; startedAt: number; doneAt?: number
}
type HistoryRow = { id: string; url: string; title: string; visitedAt: number; agent?: boolean }

const tab = ref<'downloads' | 'history'>(props.mode === 'history' ? 'history' : 'downloads')
const downloads = ref<DownloadRow[]>([])
const history = ref<HistoryRow[]>([])
const closed = ref<HistoryRow[]>([])
const query = ref('')
let timer: ReturnType<typeof setInterval> | null = null
let offDownloads: (() => void) | null = null

const loadDownloads = async () => {
  const rows = await invoke('downloads-list').catch(() => null)
  if (Array.isArray(rows)) downloads.value = rows
}
const loadHistory = async () => {
  const rows = await invoke('history-list', { query: query.value, limit: 200 }).catch(() => null)
  if (Array.isArray(rows)) history.value = rows
  const closedRows = await invoke('recently-closed').catch(() => null)
  if (Array.isArray(closedRows)) closed.value = closedRows
}
const switchTab = (t: 'downloads' | 'history') => {
  tab.value = t
  if (t === 'downloads') void loadDownloads()
  else void loadHistory()
}

const downloadIcon = (d: DownloadRow) => {
  if (d.state === 'completed') return 'fa-check-circle'
  if (d.state === 'cancelled' || d.state === 'interrupted') return 'fa-exclamation-circle'
  if (d.state === 'paused') return 'fa-pause-circle'
  return 'fa-spinner fa-spin'
}
const fmtBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`
}
const downloadMeta = (d: DownloadRow) => {
  if (d.state === 'completed') return fmtBytes(d.totalBytes || d.receivedBytes) || (zh.value ? '已完成' : 'done')
  if (d.state === 'cancelled') return zh.value ? '已取消' : 'cancelled'
  if (d.state === 'interrupted') return zh.value ? '已中断' : 'interrupted'
  if (d.state === 'paused') return zh.value ? '已暂停' : 'paused'
  return d.totalBytes > 0 ? `${fmtBytes(d.receivedBytes)} / ${fmtBytes(d.totalBytes)}` : fmtBytes(d.receivedBytes)
}
const shortTime = (ts: number) => {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? d.toTimeString().slice(0, 5) : `${d.getMonth() + 1}/${d.getDate()}`
}
const openDownload = async (d: DownloadRow) => {
  if (d.state !== 'completed') return
  const r = await invoke('download-open', { id: d.id }).catch(() => null)
  if (r && r.ok === false) window.alert(r.error || (zh.value ? '打开失败' : 'Open failed'))
}
const revealDownload = async (d: DownloadRow) => { await invoke('download-reveal', { id: d.id }).catch(() => {}) }
const clearDownloads = async () => {
  await invoke('downloads-clear').catch(() => {})
  downloads.value = []
}
const clearHistory = async () => {
  if (!window.confirm(zh.value ? '清空全部浏览历史？' : 'Clear all browsing history?')) return
  await invoke('history-clear').catch(() => {})
  history.value = []
}
const restoreClosed = async (c: HistoryRow) => {
  const r = await invoke('restore-closed', { id: c.id }).catch(() => null)
  if (r?.ok) closed.value = closed.value.filter((x) => x.id !== c.id)
  else if (r?.error) window.alert(r.error)
}

const clearQuery = () => { query.value = ''; void loadHistory() }

const refresh = () => {
  if (!props.active) return
  if (tab.value === 'downloads') void loadDownloads()
  else void loadHistory()
}

onMounted(() => {
  try {
    offDownloads = getPlatform().events.on('browser-agent:downloads', (rows: any) => {
      if (Array.isArray(rows)) downloads.value = rows
    })
  } catch { /* 非桌面环境忽略 */ }
  void loadDownloads()
  void loadHistory()
  timer = setInterval(refresh, 2000)
})
onBeforeUnmount(() => {
  if (timer) { clearInterval(timer); timer = null }
  try { offDownloads?.() } catch { /* 忽略 */ }
})
watch(() => props.active, (v) => { if (v) refresh() })
watch(() => props.mode, (m) => {
  if (m === 'downloads' || m === 'history') tab.value = m
  refresh()
})
</script>

<style scoped>
.browser-extras { display: flex; flex-direction: column; gap: 4px; }
.bx-tabs { display: flex; gap: 6px; margin: 4px 0 6px; }
.bx-tab {
  flex: 1; height: 26px; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 1px solid var(--borderColor); border-radius: 6px; background: transparent;
  color: var(--fontColor); font-size: 12px; cursor: pointer; opacity: .75;
}
.bx-tab.on { opacity: 1; border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.bx-count { font-size: 10px; opacity: .7; }
.bx-empty { font-size: 12px; opacity: .55; padding: 8px 2px; }
.bx-row { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 2px; font-size: 12px; border-bottom: 1px dashed color-mix(in srgb, var(--fontColor) 12%, transparent); }
.bx-click { cursor: pointer; }
.bx-click:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.bx-ic { color: var(--fontActiveColor); width: 14px; text-align: center; flex: 0 0 auto; font-size: 12px; }
.bx-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bx-meta { flex: 0 0 auto; font-size: 11px; opacity: .55; }
.bx-mini { flex: 0 0 auto; border: none; background: transparent; color: var(--fontActiveColor); cursor: pointer; padding: 0 2px; }
.bx-sec { margin: 8px 2px 2px; font-size: 11px; font-weight: 600; opacity: .55; }
.bx-search {
  width: 100%;
  height: 26px;
  box-sizing: border-box;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 9px;
  border: 1px solid var(--borderColor);
  border-radius: 13px;
  background: var(--menuColor);
  transition: border-color .15s;
}
.bx-search:focus-within { border-color: var(--fontActiveColor); }
.bx-search-ic { flex-shrink: 0; font-size: 11px; color: var(--fontColor); opacity: .5; }
.bx-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.bx-search-clear {
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
.bx-search-clear:hover { opacity: 1; color: var(--fontActiveColor); }
.bx-action { margin-top: 6px; height: 26px; border: 1px solid var(--borderColor); border-radius: 6px; background: transparent; color: var(--fontColor); font-size: 12px; cursor: pointer; }
.bx-action:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
</style>
