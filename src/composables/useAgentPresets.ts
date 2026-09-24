/**
 * useAgentPresets.ts — Agent 预设文件存储（.agent 文件模式）
 *
 * 预设从「设置 → 智能体 → 预设」管理，可导入/导出 .agent 文件。
 * agentPresetPath 仅当前会话内生效（不持久化到 localStorage）；
 * 打开预设文件夹后以文件夹内 .agent 文件为准，否则以内存（localStorage 的
 * agentPresets）为准。store.agentPresets 仍是内存单一事实源。
 *
 * 设计约束：不自动同步、不自动重命名/删除磁盘文件，避免误删用户预设。
 */

import { usestore } from '@/store'

/** presetId → .agent 文件路径（扫描时建立；改名/新增时更新） */
export const agentPresetFileMap = new Map<string, string>()

/** 预设名 → 合法文件名（.agent 后缀由调用方拼接） */
const sanitizeName = (name: string): string =>
  String(name || 'agent').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'agent'

/** 预设对应的 .agent 文件路径 */
export function agentFilePath(preset: any, dir: string): string {
  return `${dir}/${sanitizeName(preset.name)}.agent`
}

/** 扫描预设文件夹：读取全部 .agent 文件 → store.agentPresets */
export const scanAgentPresets = async (): Promise<void> => {
  const store = usestore()
  const dir = store.agentPresetPath
  if (!dir) return
  agentPresetFileMap.clear()
  try {
    const result = await window.ipcRenderer.invoke('getFilesRelation', dir, 1)
    const files: any[] = (result?.fileList || []).filter((f: any) => f.path?.endsWith('.agent'))
    const presets: any[] = []
    for (const f of files) {
      try {
        const text = await window.ipcRenderer.invoke('readFile', f.path)
        const data = JSON.parse(text)
        if (data && data.id) {
          presets.push(data)
          agentPresetFileMap.set(data.id, f.path)
        }
      } catch { /* 跳过损坏/非预设文件 */ }
    }
    // 以文件夹内 .agent 文件为准（不做 localStorage → 文件夹的自动同步迁移）
    store.agentPresets = presets
  } catch { /* 静默忽略（目录不可读等） */ }
}

/** 目标路径是否已被其它预设占用 */
const pathTakenByOther = (presetId: string, p: string): boolean => {
  for (const [otherId, otherPath] of agentPresetFileMap) {
    if (otherId !== presetId && otherPath === p) return true
  }
  return false
}

/**
 * 写入单个预设到 .agent 文件。
 *
 * 有已记录路径（prev）时写回原路径、保持文件名不变；否则按 sanitizeName(name)
 * 生成新路径写入（新建/复制/导入）。绝不自动删除或移动磁盘文件，
 * 也不因文件名规范化差异覆盖其它预设。
 *
 * @returns 是否写入成功（冲突/失败返回 false，不阻塞编辑）
 */
export const writeAgentPreset = async (preset: any): Promise<boolean> => {
  const store = usestore()
  const dir = store.agentPresetPath
  if (!dir || !preset?.id) return false
  const prev = agentPresetFileMap.get(preset.id)
  const next = agentFilePath(preset, dir)
  const target = prev || next
  // 新文件（prev 不存在）且目标被其它预设占用 → 跳过，避免互相覆盖
  if (!prev && pathTakenByOther(preset.id, next)) return false
  try {
    await window.ipcRenderer.invoke('writeFile', target, JSON.stringify(preset, null, 2))
    agentPresetFileMap.set(preset.id, target)
    return true
  } catch {
    /* 写入失败不阻塞编辑 */
    return false
  }
}

/** 删除预设：删除 .agent 文件 + 移出内存列表 */
export const removeAgentPreset = async (id: string): Promise<void> => {
  const store = usestore()
  const path = agentPresetFileMap.get(id)
  if (path) {
    try { await window.ipcRenderer.invoke('deleteFile', path) } catch { /* 忽略 */ }
    agentPresetFileMap.delete(id)
  }
  const idx = store.agentPresets.findIndex((c: any) => c.id === id)
  if (idx >= 0) store.agentPresets.splice(idx, 1)
}

/** 打开预设文件夹：选择文件夹 → 导入其中所有 .agent 文件（仅本次会话生效，不持久化路径） */
export const openAgentPresetFolder = async (): Promise<void> => {
  const store = usestore()
  const path = await window.ipcRenderer.invoke('openFolderDialog')
  if (!path) return
  store.agentPresetPath = path
  await scanAgentPresets()
}

/**
 * 导出全部预设为 .agent 文件到所选文件夹（不改动 agentPresetPath）。
 * @returns 成功导出的预设数量；用户取消选择文件夹时返回 -1
 */
export const exportAllAgentPresets = async (): Promise<number> => {
  const store = usestore()
  if (store.agentPresets.length === 0) return 0
  const dir = await window.ipcRenderer.invoke('openFolderDialog')
  if (!dir) return -1
  let ok = 0
  for (const c of store.agentPresets as any[]) {
    try {
      const p = agentFilePath(c, dir)
      await window.ipcRenderer.invoke('writeFile', p, JSON.stringify(c, null, 2))
      ok++
    } catch { /* 单个失败不影响其它 */ }
  }
  return ok
}
