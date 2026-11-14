/**
 * settingsData.ts — 设置页「通用 → 数据」与「基础 → 常用操作」共用的数据统计 / 导入导出工具。
 *
 * 定位：**纯函数 + 文件 IO**，不含 Vue 响应式状态（各页面自行持有 ref 并在需要时调用这里）。
 * 覆盖：localStorage 占用统计、各类数据的 JSON 导出 / 导入（DATA_IO + BACKUP_KEYS）、聊天记录导入导出。
 * 说明：这些逻辑原先内联在 Set.vue 里，数据页独立成组件（DataSettings.vue）后抽到此处共用。
 */
import { ElMessage, ElMessageBox } from 'element-plus'
import { chatsRef } from '@/store/chats'
import { getPlatform, hasCapability } from '@/platform'
import { aikmIpc, aikmIpcOrNull } from '@/lib/aikmIpc'
import { loadChatArchive, scheduleChatArchiveSave, flushChatArchive } from '@/lib/chatArchive'
import { isBuiltinAgentPreset } from '@/shared/builtinAgentPresets'
import { parseBackupText } from '@/shared/fullBackup'

/** 浏览器 localStorage 配额按 UTF-16 码元计（key + value 每字符 2 字节），Electron 上限约 100MB */
export const LOCAL_STORAGE_LIMIT = 100 * 1024 * 1024 // 100MB

/** 格式化字节数为可读大小（KB/MB） */
export const formatBytes = (b: number): string => {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + ' MB'
  return (b / 1024).toFixed(1) + ' KB'
}

/** 统计当前 localStorage 全部键值对占用（字节） */
export const lsTotalBytes = (): number => {
  let total = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key == null) continue
      const value = localStorage.getItem(key) || ''
      total += (key.length + value.length) * 2
    }
  } catch (e) {
    console.error('统计 localStorage 占用失败:', e)
  }
  return total
}

/** 若干 localStorage 键的总占用（UTF-16，与整体占用统计口径一致） */
export const lsSizeOf = (keys: string[]): number => {
  let total = 0
  for (const k of keys) {
    const v = localStorage.getItem(k)
    if (v) total += (k.length + v.length) * 2
  }
  return total
}

/** 读取并解析 localStorage 键（不存在 / 解析失败返回 null） */
export const readLsJson = (key: string): any => {
  try {
    const s = localStorage.getItem(key)
    return s ? JSON.parse(s) : null
  } catch { return null }
}

/** 条目数：数组取长度，对象取顶层键数 */
export const countEntries = (v: any): number =>
  Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0)

// ================ 文件 IO（另存为 / 选文件；桌面版走原生对话框，浏览器/LAN 走下载 / input） ================

export type FileFilters = { name: string; extensions: string[] }[]
export const JSON_FILTERS: FileFilters = [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }]
export const MD_FILTERS: FileFilters = [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }]

/** 保存文本文件；返回保存路径（浏览器模式为空串）；用户取消返回 null；写入失败抛错 */
export const saveTextFile = async (
  defaultName: string,
  content: string,
  mime: string,
  filters: FileFilters,
  zh = true,
): Promise<string | null> => {
  const ipc: any = aikmIpcOrNull()
  if (ipc?.invoke) {
    const target = await getPlatform().dialog.saveFile({ defaultPath: defaultName, filters })
    if (!target) return null
    const ok = await getPlatform().fs.saveText(target, content)
    if (!ok) throw new Error(zh ? '无法写入文件' : 'cannot write file')
    return target
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = defaultName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return ''
}

/** 浏览器 / LAN 模式选文件（无 ipcRenderer 时用 <input type=file>） */
export const pickTextFileInBrowser = (): Promise<string> => new Promise((resolve) => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = () => {
    const f = input.files && input.files[0]
    if (!f) { resolve(''); return }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => resolve('')
    reader.readAsText(f)
  }
  input.click()
})

/** 读取用户选中的文本文件内容（桌面版原生对话框 / 浏览器 file input） */
export const pickTextFile = async (): Promise<string> => {
  const ipc: any = aikmIpcOrNull()
  if (ipc?.invoke) {
    const res = await getPlatform().dialog.pickTextFile() // → { content, filePath }
    return res?.content != null ? String(res.content) : ''
  }
  return await pickTextFileInBrowser()
}

/** 时间戳后缀：YYYYMMDD-HHmmss（导出文件名用） */
export const stampText = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ================ 聊天记录导入 / 导出（存档正文在主进程 chats.json；浏览器端回退 localStorage） ================

/** 当前聊天列表（优先内存，回退存档） */
export const readStoredChats = async (): Promise<any[]> => {
  if (Array.isArray(chatsRef.value) && chatsRef.value.length) return chatsRef.value
  try {
    const list = (await loadChatArchive()).chats
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** 写回聊天存档；不动 ai-chats-index（主窗口加载时会自行 clamp） */
export const writeStoredChats = async (list: any[]) => {
  if (Array.isArray(chatsRef.value) && chatsRef.value.length) chatsRef.value = list
  scheduleChatArchiveSave(list)
  await flushChatArchive()
  window.dispatchEvent(new CustomEvent('ai-chats-changed'))
  // 独立设置窗口场景：通知其它窗口（主窗口）重新加载，否则主窗口下次 saveChats 会把导入结果覆盖掉
  try { aikmIpc?.send?.('chats-changed') } catch { /* 忽略 */ }
}

/** 导出文件名：ai-chats-YYYYMMDD-HHmmss.json */
export const chatsFileName = (): string => `ai-chats-${stampText()}.json`

/** 解析导入文件内容（兼容「完整导出包」与「裸数组」两种格式） */
export const parseChatsFile = (text: string, zh = true): any[] => {
  const data = JSON.parse(text)
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.chats) ? data.chats : null)
  if (!list) throw new Error(zh ? '不是有效的聊天导出文件' : 'not a valid chats export file')
  return list.filter((c: any) => c && typeof c === 'object' && (Array.isArray(c.messages) || c.config))
}

/** 导出全部聊天记录（含分支 / 知识库来源 / 工具调用时间线等完整字段）为 JSON 备份文件 */
export const exportChats = async (zh = true) => {
  const list = await readStoredChats()
  if (!list.length) {
    ElMessage.warning(zh ? '当前没有聊天记录可导出' : 'No chat history to export')
    return
  }
  const payload = { app: 'ai-km', kind: 'chats', version: 1, exportedAt: new Date().toISOString(), chats: list }
  try {
    const target = await saveTextFile(chatsFileName(), JSON.stringify(payload, null, 2), 'application/json', JSON_FILTERS, zh)
    if (target === null) return
    ElMessage.success(zh ? `已导出 ${list.length} 个聊天${target ? ` → ${target}` : ''}` : `Exported ${list.length} chats${target ? ` → ${target}` : ''}`)
  } catch (e: any) {
    ElMessage.error((zh ? '导出失败：' : 'Export failed: ') + (e?.message || String(e)))
  }
}

/** 导入聊天记录（JSON）：与现有记录合并，同 id 跳过（可重复导入而不产生重复） */
export const importChats = async (zh = true, onDone?: () => void) => {
  try {
    const text = await pickTextFile()
    if (!text) return
    const incoming = parseChatsFile(text, zh)
    if (!incoming.length) {
      ElMessage.warning(zh ? '文件中没有可导入的聊天记录' : 'No chats found in the file')
      return
    }
    const existing = await readStoredChats()
    const ids = new Set(existing.map((c: any) => String(c?.id ?? '')))
    const added = incoming.filter((c: any) => !ids.has(String(c?.id ?? '')))
    const skipped = incoming.length - added.length
    if (!added.length) {
      ElMessage.info(zh ? `未发现新聊天（${skipped} 个已存在）` : `Nothing new (${skipped} already exist)`)
      return
    }
    await writeStoredChats([...existing, ...added])
    ElMessage.success(zh ? `已导入 ${added.length} 个聊天${skipped ? `（跳过 ${skipped} 个已存在）` : ''}` : `Imported ${added.length} chats${skipped ? ` (${skipped} skipped)` : ''}`)
    onDone?.()
  } catch (e: any) {
    ElMessage.error((zh ? '导入失败：' : 'Import failed: ') + (e?.message || String(e)))
  }
}

// ================ 按类导出 / 导入（预设 / MCP / 界面、模型与协作配置） ================

/**
 * 配置类存档键（界面 + AI 配置 + 预设 + MCP + 技能/插件来源 + 协作 + 工作区等）。
 *
 * 口径：**只收「会被读取并决定行为」的配置**。
 * - 运行态 / 探测缓存不收：`llmSourceStatus` / `llmCustomSourceStatus` 是来源在线探测结果，
 *   导入等于把过期状态复原；
 * - 界面运行态不收：`view` / `treeSort` / `mainPanel` 是当前视图 / 排序 / 主面板，换机无意义，
 *   导入还会强行切走用户当前面板；
 * - 聊天记录体积大，由「导出聊天记录」单独备份，这里不重复；
 * - 工作区路径（root / roots / path / remoteRoots）是**机器相关**配置：同机恢复有用，
 *   换机导入后需自行改路径（页面文案已提示）。
 * - `pythonSandbox`（安全策略三档）与 `agentPresetPath`（预设文件夹）都属于必须随备份走的配置：
 *   漏掉会让恢复后的权限档位 / 预设位置悄悄回落到默认值。
 *
 * 旧备份里可能还带 `llmSourceStatus` / `llmCustomSourceStatus` / `view` / `treeSort` / `mainPanel`：
 * 它们已不在名单里，导入时自然被忽略（这些键运行时仍会被读写，只是不属于可迁移的配置）。
 */
export const BACKUP_KEYS = [
  'AIconfig', 'UI', 'customLlmSources', 'llmDisabledSources',
  'agentPresets', 'generalAgentMaxSteps', 'mcpServers', 'disabledSkills', 'skillStoreSources',
  'pluginStoreSources', 'agentTools',
  'webSearchConfig',
  'webFetchConfig',
  'hiddenNavs', 'hiddenExtras', 'customTitle', 'interfaceConfigMode', 'collab', 'remoteFs', 'lan',
  'remoteRoots', 'mapConfig', 'locales', 'roots', 'root', 'path', 'skillsPath', 'agentPresetPath',
  'pythonSandbox',
]

export type DataIoDef = { keys: string[]; kind: string; zh: string; en: string }

/** 各类数据的导入导出定义（kind 同时用作导出文件标识与文件名；config 与旧版「备份数据」同格式，可互相导入） */
export const DATA_IO: Record<string, DataIoDef> = {
  presets: { keys: ['agentPresets'], kind: 'agent-presets', zh: 'Agent 预设', en: 'Agent presets' },
  mcp: { keys: ['mcpServers'], kind: 'mcp-servers', zh: 'MCP 服务', en: 'MCP servers' },
  config: { keys: BACKUP_KEYS, kind: 'backup', zh: '界面、模型与协作配置', en: 'UI, model & collab config' },
}

/** 从 localStorage 收集若干键的当前值（解析失败按原文字符串带走）；count = 实际存在的键数 */
const collectStoredKeys = (keys: string[]): { data: Record<string, any>; count: number } => {
  const data: Record<string, any> = {}
  let count = 0
  for (const k of keys) {
    const raw = localStorage.getItem(k)
    if (raw === null) continue
    try { data[k] = JSON.parse(raw) } catch { data[k] = raw }
    count++
  }
  return { data, count }
}

/** 把一份存档数据写回 localStorage，返回命中的键（须在 onImported 之前调用，store 重读的才是新值） */
const writeStoredConfig = (data: Record<string, any>, keys: string[]): string[] => {
  const hits = keys.filter(k => data[k] !== undefined)
  for (const k of hits) {
    const v = data[k]
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
  }
  return hits
}

/** 配置变化后通知其它窗口（主窗口）重新同步界面 / 语言：直接从存档读，不依赖调用方的 store */
const broadcastConfigChanged = () => {
  try {
    const ui = readLsJson('UI')
    const locale = readLsJson('locales')
    aikmIpc?.send?.('settings-config-changed', {
      ui: ui && typeof ui === 'object' ? ui : undefined,
      locales: locale === 'zh' || locale === 'en' ? locale : undefined,
    })
  } catch { /* 忽略 */ }
}

/** 导出某类数据为 JSON 文件（含 app/kind/exportedAt/data） */
export const exportDataGroup = async (key: string, zh = true) => {
  const io = DATA_IO[key]
  if (!io) return
  const { data, count } = collectStoredKeys(io.keys)
  if (!count) {
    ElMessage.warning(zh ? `当前没有可导出的${io.zh}` : 'Nothing to export')
    return
  }
  const payload = {
    app: 'ai-km', kind: io.kind, version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
    keys: count, data,
  }
  try {
    const target = await saveTextFile(`ai-km-${io.kind}-${stampText()}.json`, JSON.stringify(payload, null, 2), 'application/json', JSON_FILTERS, zh)
    if (target === null) return
    ElMessage.success(zh ? `已导出${io.zh}（${count} 项）${target ? ` → ${target}` : ''}` : `Exported ${count} entries${target ? ` → ${target}` : ''}`)
  } catch (e: any) {
    ElMessage.error((zh ? '导出失败：' : 'Export failed: ') + (e?.message || String(e)))
  }
}

/**
 * 预设已切到「文件夹」存储（`agentPresetPath`）时，把刚导入到 localStorage 的预设同步写成
 * `.agent` 文件 —— 否则下次 `scanAgentPresets()` 以文件夹为准，会把导入结果整体覆盖掉
 * （用户看到的现像是「导入成功，但预设没变」）。
 *
 * 语义：**合并**，不删除磁盘上原有、备份里没有的预设（覆盖导入也不删别人的文件）。
 * @returns 成功写入文件夹的预设数（0 = 未启用文件夹模式 / 没有可写项）
 */
const syncImportedPresetsToFolder = async (): Promise<number> => {
  const { usestore } = await import('@/store')
  const store = usestore() as any
  const dir = String(store?.agentPresetPath || '')
  if (!dir) return 0
  const list = readLsJson('agentPresets')
  if (!Array.isArray(list) || !list.length) return 0
  const { scanAgentPresets, writeAgentPreset } = await import('@/composables/useAgentPresets')
  // 先扫一次：把 id → 文件路径 的映射对齐到当前目录，避免沿用旧目录的路径写错地方
  await scanAgentPresets()
  let written = 0
  for (const preset of list) {
    if (!preset || typeof preset !== 'object' || !preset.id) continue
    if (isBuiltinAgentPreset(preset)) continue // 内置预设由软件提供，不落盘
    if (await writeAgentPreset(preset)) written++
  }
  // 再扫一次：列表以文件夹实际内容为准（= 原有 ∪ 导入），内存与磁盘保持一致
  await scanAgentPresets()
  // 合并后的列表写回 localStorage 镜像，避免下次启动先读到「只有导入项」的旧镜像
  try { store?.saveConfig?.() } catch { /* 写盘失败不影响导入结果 */ }
  return written
}

/**
 * 导入某类数据（JSON）：覆盖对应存档键，二次确认后写入。
 * @param onImported 写入成功后的回调（调用方用它刷新占用统计 / 重新加载 store 配置）
 */
export const importDataGroup = async (key: string, zh = true, onImported?: () => void) => {
  const io = DATA_IO[key]
  if (!io) return
  let text = ''
  try {
    text = await pickTextFile()
  } catch (e: any) {
    ElMessage.error((zh ? '导入失败：' : 'Import failed: ') + (e?.message || String(e)))
    return
  }
  if (!text) return
  try {
    const parsed = JSON.parse(text)
    const data = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' ? parsed.data : null
    if (!data) throw new Error(zh ? '不是有效的导出文件（缺少 data 字段）' : 'not a valid export file (missing data)')
    const hits = io.keys.filter(k => data[k] !== undefined)
    if (!hits.length) {
      ElMessage.warning(zh ? '文件里没有本类数据' : 'No matching data in the file')
      return
    }
    try {
      await ElMessageBox.confirm(
        zh ? `将用文件里的 ${hits.length} 项数据覆盖当前${io.zh}（不可撤销）。\n确认导入？`
           : `Import overwrites your current ${io.en} with ${hits.length} entries (cannot be undone).\nContinue?`,
        zh ? '导入数据' : 'Import data',
        { confirmButtonText: zh ? '导入' : 'Import', cancelButtonText: zh ? '取消' : 'Cancel', type: 'warning' }
      )
    } catch { return /* 用户取消 */ }
    writeStoredConfig(data, io.keys)
    onImported?.()
    // 预设：文件夹模式以磁盘文件为准，导入后必须同步落盘，否则下次扫描会把导入结果覆盖掉
    let presetsWritten = 0
    if (hits.includes('agentPresets')) {
      try { presetsWritten = await syncImportedPresetsToFolder() } catch { presetsWritten = 0 }
    }
    broadcastConfigChanged()
    const extra = presetsWritten
      ? (zh ? `；其中 ${presetsWritten} 个预设已写入预设文件夹` : `; ${presetsWritten} presets written to the preset folder`)
      : ''
    ElMessage.success(zh
      ? `已导入${io.zh}（${hits.length} 项）${extra}；该模块若已打开，重新打开后完全生效`
      : `Imported ${hits.length} entries${extra}; reopen the module to apply fully`)
  } catch (e: any) {
    ElMessage.error((zh ? '导入失败：' : 'Import failed: ') + (e?.message || String(e)))
  }
}

// ================ 一键备份 / 一键恢复（配置 + 聊天记录，一个文件） ================

/** 「一键备份」文件的 kind 标识（一个文件同时带 data = 配置、chats = 聊天记录） */
export const FULL_BACKUP_KIND = 'full'

/**
 * 一键备份：把全部配置（BACKUP_KEYS）与全部聊天记录写进同一个 JSON。
 * 不含会话日志、用量账本（都在数据目录里按文件保存）与主进程凭据库（只存在主进程）。
 */
export const exportFullBackup = async (zh = true) => {
  const { data, count } = collectStoredKeys(BACKUP_KEYS)
  const chats = await readStoredChats()
  if (!count && !chats.length) {
    ElMessage.warning(zh ? '当前没有可备份的数据' : 'Nothing to back up')
    return
  }
  const payload = {
    app: 'ai-km', kind: FULL_BACKUP_KIND, version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
    configCount: count, chatCount: chats.length, data, chats,
  }
  try {
    const target = await saveTextFile(`ai-km-full-${stampText()}.json`, JSON.stringify(payload, null, 2), 'application/json', JSON_FILTERS, zh)
    if (target === null) return
    ElMessage.success(zh
      ? `已备份 ${count} 项配置与 ${chats.length} 个聊天${target ? ` → ${target}` : ''}`
      : `Backed up ${count} config entries and ${chats.length} chats${target ? ` → ${target}` : ''}`)
  } catch (e: any) {
    ElMessage.error((zh ? '备份失败：' : 'Backup failed: ') + (e?.message || String(e)))
  }
}

/**
 * 恢复前快照：把**当前**配置与聊天写到数据目录的 backups/ 下，万一恢复选错文件还能回退。
 * 失败不阻断恢复（返回空串，界面只用它拼提示）。
 */
const writePreRestoreSnapshot = async (): Promise<string> => {
  try {
    const { data, count } = collectStoredKeys(BACKUP_KEYS)
    const chats = await readStoredChats()
    if (!count && !chats.length) return ''
    const payload = {
      app: 'ai-km', kind: FULL_BACKUP_KIND, version: 1,
      exportedAt: new Date().toISOString(),
      reason: 'auto-before-restore',
      configCount: count, chatCount: chats.length, data, chats,
    }
    const dirRes: any = await getPlatform().app.dataDirPath()
    const baseDir = dirRes?.path ? String(dirRes.path).replace(/[\\/]+$/, '') : ''
    if (!baseDir) return ''
    const dir = `${baseDir}/backups`
    try { await (getPlatform() as any).fs.ensureDir(dir) } catch { /* 目录已存在 / 建不出来时继续尝试写 */ }
    const file = `${dir}/ai-km-pre-restore-${stampText()}.json`
    await getPlatform().fs.writeText(file, JSON.stringify(payload, null, 2))
    return file
  } catch {
    return ''
  }
}

/**
 * 一键恢复：读「一键备份」文件，同时兼容旧的配置备份（只有 data）与聊天记录导出（只有 chats / 裸数组）。
 * - 配置：覆盖（只写名单内、且文件里确实有的键；旧名单里的运行态键自然被忽略）
 * - 聊天：按 id **合并**（已存在的跳过），不删除现有聊天
 * - 恢复前先自动快照当前状态到 数据目录/backups/（失败不阻断）
 * @param onImported 恢复后的回调（刷新统计 / 重载 store）
 */
export const importFullBackup = async (zh = true, onImported?: () => void) => {
  let text = ''
  try {
    text = await pickTextFile()
  } catch (e: any) {
    ElMessage.error((zh ? '恢复失败：' : 'Restore failed: ') + (e?.message || String(e)))
    return
  }
  if (!text) return
  try {
    // 认文件：一键备份（配置 + 聊天）/ 旧配置备份 / 旧聊天导出 / 裸数组（解析规则见 shared/fullBackup）
    const { config: configData, chats } = parseBackupText(text)
    const cfgHits = configData ? BACKUP_KEYS.filter(k => configData[k] !== undefined) : []
    if (!cfgHits.length && !(chats && chats.length)) {
      throw new Error(zh ? '不是有效的备份文件（没有可恢复的配置或聊天）' : 'not a valid backup (no config or chats)')
    }
    // 聊天按 id 去重（与聊天导入同一套合并规则）
    const existing = (chats && chats.length) ? await readStoredChats() : []
    const ids = new Set(existing.map((c: any) => String(c?.id ?? '')))
    const addedChats = (chats || []).filter((c: any) => !ids.has(String(c?.id ?? '')))
    const skippedChats = (chats?.length || 0) - addedChats.length
    try {
      await ElMessageBox.confirm(
        zh
          ? `将恢复 ${cfgHits.length} 项配置${chats && chats.length ? `，并合并 ${addedChats.length} 个聊天（跳过 ${skippedChats} 个已存在）` : ''}。\n配置会覆盖当前设置，聊天按 id 合并，均不可撤销。确认恢复？`
          : `Restore ${cfgHits.length} config entries${chats && chats.length ? ` and merge ${addedChats.length} chats (${skippedChats} already exist)` : ''}?\nConfig is overwritten and chats are merged by id; this cannot be undone. Continue?`,
        zh ? '一键恢复' : 'Restore',
        { confirmButtonText: zh ? '恢复' : 'Restore', cancelButtonText: zh ? '取消' : 'Cancel', type: 'warning' }
      )
    } catch { return /* 用户取消 */ }
    // 恢复前快照（失败不阻断；成功则在结果里给出路径）
    const snapshot = await writePreRestoreSnapshot()
    if (cfgHits.length) writeStoredConfig(configData!, BACKUP_KEYS)
    if (addedChats.length) await writeStoredChats([...existing, ...addedChats])
    onImported?.()
    // 与分类导入同一套收尾：预设落盘 → 广播给主窗口
    let presetsWritten = 0
    if (cfgHits.includes('agentPresets')) {
      try { presetsWritten = await syncImportedPresetsToFolder() } catch { presetsWritten = 0 }
    }
    broadcastConfigChanged()
    const parts: string[] = []
    if (cfgHits.length) parts.push(zh ? `${cfgHits.length} 项配置` : `${cfgHits.length} config entries`)
    if (chats && chats.length) {
      parts.push(zh
        ? `${addedChats.length} 个聊天（跳过 ${skippedChats} 个已存在）`
        : `${addedChats.length} chats (${skippedChats} already exist)`)
    }
    if (presetsWritten) parts.push(zh ? `${presetsWritten} 个预设已写入预设文件夹` : `${presetsWritten} presets written to the preset folder`)
    const snapNote = snapshot
      ? (zh ? `恢复前的状态已快照到 ${snapshot}` : `Previous state saved to ${snapshot}`)
      : ''
    ElMessage.success(zh
      ? `已恢复：${parts.join('；')}。相关模块重新打开后完全生效${snapNote ? `；${snapNote}` : ''}`
      : `Restored: ${parts.join('; ')}. Reopen the related modules to apply fully${snapNote ? `; ${snapNote}` : ''}`)
  } catch (e: any) {
    ElMessage.error((zh ? '恢复失败：' : 'Restore failed: ') + (e?.message || String(e)))
  }
}
