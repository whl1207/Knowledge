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

// ================ 聊天记录导入 / 导出（主窗口与设置窗口共享同一份 localStorage 存档 ai-chats） ================

/** 当前聊天列表（优先内存，回退 localStorage） */
export const readStoredChats = (): any[] => {
  if (Array.isArray(chatsRef.value) && chatsRef.value.length) return chatsRef.value
  try {
    const saved = localStorage.getItem('ai-chats')
    const list = saved ? JSON.parse(saved) : []
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** 写回聊天存档；不动 ai-chats-index（主窗口加载时会自行 clamp） */
export const writeStoredChats = (list: any[]) => {
  localStorage.setItem('ai-chats', JSON.stringify(list))
  if (Array.isArray(chatsRef.value) && chatsRef.value.length) chatsRef.value = list
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
  const list = readStoredChats()
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
    const existing = readStoredChats()
    const ids = new Set(existing.map((c: any) => String(c?.id ?? '')))
    const added = incoming.filter((c: any) => !ids.has(String(c?.id ?? '')))
    const skipped = incoming.length - added.length
    if (!added.length) {
      ElMessage.info(zh ? `未发现新聊天（${skipped} 个已存在）` : `Nothing new (${skipped} already exist)`)
      return
    }
    writeStoredChats([...existing, ...added])
    ElMessage.success(zh ? `已导入 ${added.length} 个聊天${skipped ? `（跳过 ${skipped} 个已存在）` : ''}` : `Imported ${added.length} chats${skipped ? ` (${skipped} skipped)` : ''}`)
    onDone?.()
  } catch (e: any) {
    ElMessage.error((zh ? '导入失败：' : 'Import failed: ') + (e?.message || String(e)))
  }
}

// ================ 按类导出 / 导入（预设 / MCP / 界面与模型配置） ================

/** 配置类存档键（界面 + AI 配置 + 预设 + MCP 等；聊天记录体积大，由「导出聊天」单独备份，这里不重复） */
export const BACKUP_KEYS = [
  'AIconfig', 'UI', 'customLlmSources', 'llmSourceStatus', 'llmDisabledSources', 'llmCustomSourceStatus',
  'agentPresets', 'generalAgentMaxSteps', 'mcpServers', 'disabledSkills', 'skillStoreSources',
  'pluginStoreSources', 'agentTools',
  'webSearchConfig',
  'webFetchConfig',
  'hiddenNavs', 'hiddenExtras', 'customTitle', 'interfaceConfigMode', 'collab', 'remoteFs', 'lan',
  'remoteRoots', 'mapConfig', 'locales', 'roots', 'root', 'path', 'skillsPath', 'treeSort',
  'view', 'mainPanel',
]

export type DataIoDef = { keys: string[]; kind: string; zh: string; en: string }

/** 各类数据的导入导出定义（kind 同时用作导出文件标识与文件名；config 与旧版「备份数据」同格式，可互相导入） */
export const DATA_IO: Record<string, DataIoDef> = {
  presets: { keys: ['agentPresets'], kind: 'agent-presets', zh: 'Agent 预设', en: 'Agent presets' },
  mcp: { keys: ['mcpServers'], kind: 'mcp-servers', zh: 'MCP 服务', en: 'MCP servers' },
  config: { keys: BACKUP_KEYS, kind: 'backup', zh: '界面与模型配置', en: 'UI & model config' },
}

/** 导出某类数据为 JSON 文件（含 app/kind/exportedAt/data） */
export const exportDataGroup = async (key: string, zh = true) => {
  const io = DATA_IO[key]
  if (!io) return
  const data: Record<string, any> = {}
  let count = 0
  for (const k of io.keys) {
    const raw = localStorage.getItem(k)
    if (raw === null) continue
    try { data[k] = JSON.parse(raw) } catch { data[k] = raw }
    count++
  }
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
    for (const k of hits) {
      const v = data[k]
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
    }
    onImported?.()
    // 广播给其它窗口（主窗口）重新同步配置：ui / locales 直接从存档读，避免依赖调用方的 store
    try {
      const ui = readLsJson('UI')
      const locale = readLsJson('locales')
      ;aikmIpc?.send?.('settings-config-changed', {
        ui: ui && typeof ui === 'object' ? ui : undefined,
        locales: locale === 'zh' || locale === 'en' ? locale : undefined,
      })
    } catch { /* 忽略 */ }
    ElMessage.success(zh
      ? `已导入${io.zh}（${hits.length} 项）；该模块若已打开，重新打开后完全生效`
      : `Imported ${hits.length} entries; reopen the module to apply fully`)
  } catch (e: any) {
    ElMessage.error((zh ? '导入失败：' : 'Import failed: ') + (e?.message || String(e)))
  }
}
