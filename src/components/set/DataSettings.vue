<!-- DataSettings.vue — 设置「通用 → 数据」页（独立模块）
 * 本机数据总览（localStorage 占用 / 数据目录 / 可清理缓存）+ 数据清单（数量 / 占用 / 前往 / 导出 / 导入 / 清空会话日志）。
     只统计本机数据（localStorage + 应用数据目录），**不扫描工作区文件**（知识库 / 工作流等归「知识管理」）。
     导入导出与文件 IO 集中在 src/lib/settingsData.ts（「基础 → 常用操作」的导出 Markdown 也共用同一套工具）。 -->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import {
  BACKUP_KEYS,
  LOCAL_STORAGE_LIMIT,
  countEntries,
  exportChats,
  exportDataGroup,
  formatBytes,
  importChats,
  importDataGroup,
  lsSizeOf,
  lsTotalBytes,
  readLsJson,
} from '@/lib/settingsData'

const store = usestore()
const zh = () => store.locales === 'zh'

/** 会话日志会话数（主进程 sessionLog 列表；非桌面版 / 读取失败为 null） */
const sessionLogCount = ref<number | null>(null)
/** 应用数据目录（userData 路径；主进程返回） */
const dataDirPath = ref('')
/** 本机 localStorage 占用（字节） */
const lsBytes = ref(0)
/** 可安全清理的缓存占用（字节） */
const cacheBytes = ref(0)

/** 占用文本，如 "24.5 KB / 100 MB · 0.02%" */
const lsText = computed(() => {
  const pct = (lsBytes.value / LOCAL_STORAGE_LIMIT) * 100
  return `${formatBytes(lsBytes.value)} / ${LOCAL_STORAGE_LIMIT / (1024 * 1024)} MB · ${pct < 0.01 ? '<0.01' : pct.toFixed(1)}%`
})
/** 进度条宽度百分比（0~100） */
const lsPct = computed(() => Math.min((lsBytes.value / LOCAL_STORAGE_LIMIT) * 100, 100))
const cacheText = computed(() => formatBytes(cacheBytes.value))

/** 数据清单：每类本机数据的数量与占用；nav=跳转目标 / io=可导出导入 / clear=可清空 */
const dataRows = computed(() => {
  const chatList = readLsJson('ai-chats')
  const chats = Array.isArray(chatList) ? chatList : []
  const msgCount = chats.reduce((n: number, c: any) => n + (Array.isArray(c?.messages) ? c.messages.length : 0), 0)
  const presetCount = countEntries(readLsJson('agentPresets'))
  const mcpCount = countEntries(readLsJson('mcpServers'))
  const todoCount = countEntries(readLsJson('todo-entries-v1'))
  const cfgKeys = BACKUP_KEYS.filter(k => localStorage.getItem(k) !== null)
  return [
    { key: 'chats', icon: 'fa fa-comments-o', label: zh() ? '聊天记录' : 'Chats',
      count: `${chats.length} ${zh() ? '个会话' : 'chats'} · ${msgCount} ${zh() ? '条消息' : 'messages'}`,
      bytes: lsSizeOf(['ai-chats', 'ai-chats-index']), nav: '', io: true, clear: false, openFolder: '' },
    { key: 'todo', icon: 'fa fa-history', label: zh() ? '旧版待办与随手记' : 'Legacy todos & notes',
      count: `${todoCount} ${zh() ? '条' : 'items'}`, bytes: lsSizeOf(['todo-entries-v1']), nav: '', io: true, clear: false, openFolder: '' },
    { key: 'presets', icon: 'fa fa-address-book-o', label: zh() ? 'Agent 预设' : 'Agent presets',
      count: `${presetCount} ${zh() ? '个' : 'items'}`, bytes: lsSizeOf(['agentPresets']), nav: 'agentpreset', io: true, clear: false, openFolder: '' },
    { key: 'mcp', icon: 'fa fa-plug', label: zh() ? 'MCP 服务' : 'MCP servers',
      count: `${mcpCount} ${zh() ? '个' : 'items'}`, bytes: lsSizeOf(['mcpServers']), nav: 'mcp', io: true, clear: false, openFolder: '' },
    { key: 'logs', icon: 'fa fa-list-alt', label: zh() ? '会话日志' : 'Session logs',
      count: sessionLogCount.value == null ? '—' : `${sessionLogCount.value} ${zh() ? '个会话' : 'sessions'}`,
      bytes: 0, nav: 'sessionlog', io: false, clear: true, openFolder: 'session-logs' },
    { key: 'config', icon: 'fa fa-cog', label: zh() ? '界面与模型配置' : 'UI & model config',
      count: `${cfgKeys.length} ${zh() ? '项' : 'keys'}`, bytes: lsSizeOf(cfgKeys), nav: 'llm', io: true, clear: false, openFolder: '' },
  ]
})

/** 刷新统计：本机占用 / 可清理缓存 / 数据目录路径 / 会话日志会话数 */
const refresh = async () => {
  lsBytes.value = lsTotalBytes()
  const ipc: any = (window as any).ipcRenderer
  if (!ipc?.invoke) {
    cacheBytes.value = 0
    dataDirPath.value = ''
    sessionLogCount.value = null
    return
  }
  try { cacheBytes.value = (await ipc.invoke('userdata-cache-info'))?.bytes || 0 } catch { cacheBytes.value = 0 }
  try { dataDirPath.value = (await ipc.invoke('data-dir-path'))?.path || '' } catch { /* 旧版本主进程无该通道：路径留空 */ }
  try {
    const list = await (window as any).dsh?.sessionLog?.list?.()
    sessionLogCount.value = Array.isArray(list) ? list.length : null
  } catch { sessionLogCount.value = null }
}

/** 在系统文件管理器中打开本机数据目录（配置 / 缓存 / 会话日志所在位置） */
const openDataDir = async () => {
  const ipc: any = (window as any).ipcRenderer
  if (!ipc?.invoke) {
    ElMessage.warning(zh() ? '浏览器模式下无法打开本机目录' : 'Not available in browser mode')
    return
  }
  try {
    const res = await ipc.invoke('open-data-dir')
    if (res?.success) ElMessage.success(zh() ? `已打开数据目录：${res.path}` : `Opened data folder: ${res.path}`)
    else ElMessage.error((zh() ? '打开失败：' : 'Failed: ') + (res?.error || ''))
  } catch (e: any) {
    ElMessage.error((zh() ? '打开失败：' : 'Failed: ') + (e?.message || String(e)))
  }
}

/** 在系统文件管理器中打开数据目录下的子目录（如会话日志 session-logs；仅桌面版） */
const openDataSubDir = async (sub: string) => {
  const ipc: any = (window as any).ipcRenderer
  if (!ipc?.invoke) {
    ElMessage.warning(zh() ? '浏览器模式下无法打开本机目录' : 'Not available in browser mode')
    return
  }
  try {
    const res = await ipc.invoke('open-data-dir', { sub })
    if (res?.success) ElMessage.success(zh() ? `已打开：${res.path}` : `Opened: ${res.path}`)
    else ElMessage.error((zh() ? '打开失败：' : 'Failed: ') + (res?.error || ''))
  } catch (e: any) {
    ElMessage.error((zh() ? '打开失败：' : 'Failed: ') + (e?.message || String(e)))
  }
}

/** 行内「打开所在文件夹」：'session-logs' = 数据目录下的子目录 */
const openRowFolder = async (kind: string) => {
  if (kind === 'session-logs') return openDataSubDir('session-logs')
}

/** 清理可安全删除的缓存（Chromium 缓存 / Word 预览图片缓存；不动配置、聊天、日志） */
const cleanCache = async () => {
  await refresh()
  const size = cacheBytes.value
  if (size <= 0) {
    ElMessage.info(zh() ? '当前没有可清理的缓存' : 'No cache to clean right now')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh()
        ? `确定清理缓存文件吗（当前约 ${formatBytes(size)}）？只清理浏览器缓存/临时文件（Cache、Code Cache、GPUCache 等）与 Word 预览图片缓存（docx-media，重开 Word 文件会自动重新提取），不会删除任何配置、聊天记录、会话日志或账号数据。`
        : `Clean cache files now (about ${formatBytes(size)})? Only Chromium cache/temp files (Cache, Code Cache, GPUCache, etc.) and the Word preview image cache (docx-media, re-extracted on next open) will be removed. Config, chats, session logs and credentials are NOT affected.`,
      zh() ? '提示' : 'Confirm',
      { confirmButtonText: zh() ? '清理' : 'Clean', cancelButtonText: zh() ? '取消' : 'Cancel', type: 'warning' }
    )
    const ipc: any = (window as any).ipcRenderer
    const res = await ipc.invoke('clean-userdata-cache')
    if (res?.ok) {
      ElMessage.success(zh() ? `已清理缓存 ${formatBytes(res.freed || 0)}` : `Cache cleaned: ${formatBytes(res.freed || 0)}`)
      if (res.failed && res.failed.length) {
        ElMessage.warning(zh()
          ? `部分缓存正在被占用，已标记为下次启动时自动补清：${res.failed.join('、')}`
          : `Some cache is in use and is scheduled to be fully cleared on next startup: ${res.failed.join(', ')}`)
      }
    } else {
      ElMessage.error(zh() ? '清理失败：' + (res?.error || '未知错误') : 'Clean failed: ' + (res?.error || 'unknown error'))
    }
    await refresh()
  } catch { /* 用户取消 */ }
}

/** 清空全部会话日志（智能体/会话的原始事件记录，仅桌面版） */
const clearSessionLog = async () => {
  if (!window.dsh?.sessionLog) {
    ElMessage.warning(zh() ? '浏览器模式下无法清空会话日志' : 'Not available in browser mode')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh()
        ? '确定清空全部会话日志吗？该日志是智能体/会话的原始事件记录（用于「设置 → 日志」检视），清空后不可恢复。正在运行的智能体任务请先停止。'
        : 'Clear all session logs? These are the raw event records shown in Settings → Session Log and cannot be recovered.',
      zh() ? '提示' : 'Confirm',
      { confirmButtonText: zh() ? '确定' : 'OK', cancelButtonText: zh() ? '取消' : 'Cancel', type: 'warning' }
    )
    const res = await window.dsh.sessionLog.clearAll()
    if (res?.success === false) throw new Error(zh() ? '清空失败' : 'clear failed')
    ElMessage.success(zh() ? '已清空全部会话日志' : 'All session logs cleared')
    await refresh()
  } catch { /* 用户取消 / 清空失败：取消不做处理 */ }
}

/** 导入完成：让内存中的 store 重新读一次存档（界面 / 模型 / 预设 / MCP 等随之生效）并刷新统计 */
const onImported = () => {
  try { void store.loadConfig?.() } catch { /* 忽略 */ }
  void refresh()
}
/** 行内动作：导出（聊天记录走各自的处理函数，其余按类导出） */
const exportRow = (key: string) => (key === 'chats' ? exportChats(zh()) : exportDataGroup(key, zh()))
/** 行内动作：导入（聊天记录为合并导入，其余为覆盖导入，均需确认） */
const importRow = (key: string) => (key === 'chats' ? importChats(zh(), onImported) : importDataGroup(key, zh(), onImported))
/** 前往对应设置页（由 Set.vue 的 settingsNav 监听完成跳转） */
const goTo = (nav: string) => { store.settingsNav = nav }

onMounted(refresh)
</script>

<template>
  <div class="settings-section data-settings">
    <!-- ① 使用总览 -->
    <div class="settings-group">
      <h3>{{ zh() ? '使用总览' : 'Overview' }}</h3>
      <div class="config-description" style="margin:0 0 8px 2px;">{{ zh()
        ? '本机数据（聊天 / 待办 / Agent 预设 / MCP / 会话日志 / 配置）的数量与占用；工作区里的知识库、工作流、数据画布等文件不算在内（请在「知识管理」查看）。'
        : 'Counts and sizes of local data (chats, todos, agent presets, MCP, session logs, config). Workspace files such as knowledge bases, workflows and data canvases are not included (see Knowledge Management).' }}</div>
      <!-- 本地存储占用（与「其他 → 系统状态」同一口径；占用统计的刷新在下方「刷新」按钮） -->
      <div class="form-group">
        <label>{{ zh() ? '本地存储' : 'Local Storage' }}</label>
        <div class="storage-usage">
          <div class="storage-bar" :title="lsText">
            <div class="storage-bar-fill" :style="{ width: lsPct + '%' }"
                 :class="{ warn: lsPct > 70, danger: lsPct > 90 }"></div>
          </div>
          <span class="storage-text">{{ lsText }}</span>
        </div>
      </div>
      <!-- 应用数据目录（配置 / 缓存 / 会话日志所在位置） -->
      <div class="form-group">
        <label>{{ zh() ? '数据目录' : 'Data Folder' }}</label>
        <div class="input-with-button">
          <input :value="dataDirPath" readonly
                 :placeholder="zh() ? '（桌面版显示本机数据目录，非桌面版为空）' : '(shown on desktop)'"/>
          <div class="button" style="width:auto;padding:0 10px;" @click="openDataDir"
               :title="zh() ? '在系统文件管理器中打开' : 'Open in file manager'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <!-- 全部配置备份：与数据清单中「界面与模型配置」同一套实现 -->
      <div class="form-group">
        <label>{{ zh() ? '配置备份' : 'Config Backup' }}</label>
        <div class="data-actions">
          <div class="button data-btn" @click="exportRow('config')"
               :title="zh() ? '导出全部配置（界面 / 模型 / 预设 / MCP / 技能 / 协作等）为 JSON 备份文件' : 'Export all config (UI / models / presets / MCP / skills / collaboration) as JSON'">
            <i class="fa fa-download"></i> {{ zh() ? '导出全部配置' : 'Export all' }}
          </div>
          <div class="button data-btn" @click="importRow('config')"
               :title="zh() ? '从 JSON 备份导入全部配置（覆盖当前配置，需确认）' : 'Import all config from JSON (overwrites current, with confirmation)'">
            <i class="fa fa-upload"></i> {{ zh() ? '导入全部配置' : 'Import all' }}
          </div>
        </div>
      </div>
      <!-- 可清理缓存（Chromium 缓存 / Word 预览图片缓存；大小显示在左侧标签内） -->
      <div class="form-group">
        <label>{{ zh() ? '可清理缓存' : 'Cache' }}<span class="label-size">{{ cacheText }}</span></label>
        <div class="data-actions">
          <div class="button data-btn" @click="refresh()" :title="zh() ? '重新统计占用与缓存大小' : 'Recalculate usage and cache size'">
            <i class="fa fa-refresh"></i> {{ zh() ? '刷新' : 'Refresh' }}
          </div>
          <div class="button data-btn" @click="cleanCache"
               :title="zh() ? '清理缓存文件（不动配置 / 聊天 / 日志）' : 'Clean cache files (config, chats and logs untouched)'">
            <i class="fa fa-eraser"></i> {{ zh() ? '清理缓存' : 'Clean' }}
          </div>
        </div>
      </div>
    </div>

    <!-- ② 数据清单（数量 + 占用 + 前往 / 导出 / 导入 / 清空） -->
    <div class="settings-group">
      <h3>{{ zh() ? '数据清单' : 'Data Inventory' }}</h3>
      <div class="data-list">
        <div v-for="row in dataRows" :key="row.key" class="data-row">
          <i class="fa" :class="row.icon"></i>
          <span class="data-row-label">{{ row.label }}</span>
          <span class="data-row-count">{{ row.count }}</span>
          <span class="data-row-size">{{ row.bytes ? formatBytes(row.bytes) : '—' }}</span>
          <div class="data-actions">
            <div v-if="row.io" class="button data-act" @click="exportRow(row.key)"
                 :title="zh() ? `导出${row.label}为 JSON 备份文件` : `Export ${row.label} as JSON`">
              <i class="fa fa-download"></i>
            </div>
            <div v-if="row.io" class="button data-act" @click="importRow(row.key)"
                 :title="zh() ? `从 JSON 备份导入${row.label}（覆盖当前数据，需确认）` : `Import ${row.label} from JSON (overwrites current)`">
              <i class="fa fa-upload"></i>
            </div>
            <div v-if="row.clear" class="button data-act" @click="clearSessionLog"
                 :title="zh() ? '清空全部会话日志（智能体的原始事件记录，不可恢复）' : 'Clear all session logs (raw event records, unrecoverable)'">
              <i class="fa fa-trash"></i>
            </div>
            <div v-if="row.openFolder" class="button data-act" @click="openRowFolder(row.openFolder)"
                 :title="zh() ? '打开会话日志所在文件夹' : 'Open the session log folder'">
              <i class="fa fa-folder-open"></i>
            </div>
            <div v-if="row.nav" class="button data-act" @click="goTo(row.nav)"
                 :title="zh() ? '前往对应设置页' : 'Open the related settings page'">
              <i class="fa fa-arrow-right"></i>
            </div>
          </div>
        </div>
      </div>
      <div class="config-description" style="margin-left:0">
        {{ zh()
          ? '导入会覆盖对应数据（弹框确认）；聊天记录为合并导入（相同会话跳过）。清空聊天 / 初始化等破坏性操作在「基础 → 常用操作」中。'
          : 'Import overwrites the related data (with confirmation); chats are merged (same chat skipped). Destructive actions (clear chats, initialize) live under Basic → Common Actions.' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ====== 组容器（与设置页其余面板一致） ====== */
.data-settings { padding: 2px; }
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
  left: 0; top: 3px; bottom: 9px; width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* ====== 表单组 / 控件 ====== */
.form-group { display: flex; align-items: center; margin-bottom: 5px; }
.form-group > * { margin: 0; }
.form-group:last-child { margin-bottom: 0; }
.form-group label {
  width: 120px; min-width: 120px;
  color: var(--fontColor); font-size: 14px;
  user-select: none; line-height: 1; flex-shrink: 0;
}
.form-group input,
.form-group textarea {
  flex: 1; padding: 2px 4px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor);
  font-size: 14px; transition: border-color 0.2s ease; margin: 0px;
}
.form-group input, .form-group select { height: 33px; box-sizing: border-box; }
.form-group select { background-color: var(--backgroundColor); }
.form-group input:focus, .form-group select:focus, .form-group textarea:focus {
  outline: none; border-color: var(--fontActiveColor);
}
.input-with-button { flex: 1; min-width: 0; display: flex; align-items: stretch; gap: 5px; }
.input-with-button > input, .input-with-button > select { flex: 1; min-width: 0; margin: 0; }
.input-with-button > .button {
  flex-shrink: 0; height: auto; align-self: stretch;
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 6px; margin: 0; width: auto;
}

/* ====== 按钮 ====== */
.button {
  border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor);
  cursor: pointer; transition: all 0.2s ease;
  display: flex; align-items: center; justify-content: center;
  gap: 5px; font-size: 14px; white-space: nowrap;
  margin: 0px; padding: 6px 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button i { font-size: 14px; }

/* ====== 本地存储占用：进度条 + 大小/容量文本 ====== */
.storage-usage { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
.storage-bar {
  flex: 1; min-width: 0; height: 8px; border-radius: 4px;
  background-color: var(--borderColor); overflow: hidden; position: relative; cursor: default;
}
.storage-bar-fill {
  height: 100%; border-radius: 4px;
  background-color: var(--fontActiveColor); transition: width 0.3s ease;
}
.storage-bar-fill.warn { background-color: #e6a23c; }
.storage-bar-fill.danger { background-color: #e74c3c; }
.storage-text {
  flex-shrink: 0; font-size: 11px; color: var(--fontColor);
  opacity: 0.85; white-space: nowrap; user-select: all;
}

/* ====== 说明文字 ====== */
.config-description { flex: 1; font-size: 10px; color: var(--fontColor); opacity: 0.7; margin-left: 5px; }

/* ====== 使用总览 / 数据清单的行内按钮 ====== */
/* 带文字的按钮（导出全部配置 / 导入全部配置 / 刷新 / 清理缓存）：四处尺寸完全一致 */
.button.data-btn {
  flex-shrink: 0;
  height: 33px;
  box-sizing: border-box;
  padding: 0 10px;
  gap: 6px;
  font-size: 13px;
}
/* 行内图标按钮（数据清单每行的导出 / 导入 / 清空 / 打开文件夹 / 前往）：仅图标 + 悬停说明 */
.button.data-act { width: 24px; height: 24px; padding: 0; flex-shrink: 0; font-size: 12px; }
/* label 内附加的数值（如可清理缓存大小）：小号、弱化，紧跟在标题后面 */
.form-group label .label-size { margin-left: 6px; font-size: 11px; opacity: 0.7; white-space: nowrap; }
.data-actions { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.data-list { display: flex; flex-direction: column; gap: 4px; }
.data-row {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px; border: 1px solid var(--borderColor); border-radius: 4px;
}
.data-row > i { width: 14px; flex-shrink: 0; color: var(--fontActiveColor); opacity: .85; }
.data-row-label { flex: 0 0 116px; font-size: 12px; }
.data-row-count { flex: 1; min-width: 0; font-size: 12px; opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.data-row-size { flex: 0 0 76px; text-align: right; font-size: 12px; opacity: .7; }
</style>
