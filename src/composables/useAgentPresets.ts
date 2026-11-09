/**
 * useAgentPresets.ts — Agent 预设的文件夹存储（.agent 文件模式）
 *
 * 两种存储模式（与「技能目录 / 插件目录」同一套心智）：
 *   - **本地存储**（默认）：预设只存 localStorage 的 `agentPresets`，不落盘；
 *   - **文件夹模式**：用户在「设置 → 智能体 → 管理 → 存储位置」里选定一个目录后，
 *     目录里的 `*.agent`（每份一个 JSON）是**事实来源**，编辑即写回文件、删除即删文件。
 *     路径持久化在 shop 的 `agentPresetPath`（重启后仍然生效），不是"仅本次会话"。
 *
 * 无论哪种模式，`store.agentPresets` 都是内存里的单一事实源；`ensureBuiltinAgentPresets`
 * 负责把出厂内置预设按 id 幂等补齐（内置预设**永不落盘**，避免用户目录里多出非自建文件）。
 *
 * 设计约束：不自动把 localStorage 里的预设搬进文件夹、不自动重命名 / 删除磁盘文件，
 * 避免误删用户预设；文件夹模式下的文件新增请用「重新扫描」。
 */

import { usestore } from '@/store'
import { ensureBuiltinAgentPresets, isBuiltinAgentPreset, builtinPresetDefaultsFromStore } from '@/shared/builtinAgentPresets'
import { getPlatform } from '@/platform'

/** presetId → .agent 文件路径（扫描时建立；新建/改名时更新） */
export const agentPresetFileMap = new Map<string, string>()

/** 预设名 → 合法文件名（.agent 后缀由调用方拼接） */
const sanitizeName = (name: string): string =>
  String(name || 'agent').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'agent'

/** 预设对应的 .agent 文件路径 */
export function agentFilePath(preset: any, dir: string): string {
  return `${dir}/${sanitizeName(preset.name)}.agent`
}

/** 一次扫描的结果（设置页的文件夹管理据此给用户看「读到了什么、跳过了什么」） */
export interface AgentPresetScanSummary {
  /** 目录是否可读（false 时 store.agentPresets 保持原样） */
  ok: boolean
  /** 目录绝对路径（空 = 未启用文件夹模式） */
  folder: string
  /** 目录里的 .agent 文件数 */
  files: number
  /** 成功载入的预设数 */
  loaded: number
  /** 损坏 / 缺 id 被跳过的文件数 */
  skipped: number
  /** 因 id 是内置预设而被跳过的文件数（内置预设由软件提供，不允许被磁盘文件冒充） */
  skippedBuiltin: number
  /** 本次从内存**一次性写入空目录**的预设数（选了一个空文件夹时的防丢数据迁移） */
  seeded?: number
  /** 被跳过的文件与原因（最多 20 条）——「AI 直接写文件」后要能告诉它哪里写错了 */
  issues?: Array<{ file: string; error: string }>
  /** 可读性错误（目录不存在 / 无权限等） */
  error?: string
}

/**
 * 扫描预设文件夹：读取全部 .agent 文件 → store.agentPresets。
 * 未启用文件夹模式时直接返回 ok=false（调用方据此保持本地存储）。
 */
export const scanAgentPresets = async (): Promise<AgentPresetScanSummary> => {
  const store = usestore() as any
  const dir = String(store.agentPresetPath || '')
  const summary: AgentPresetScanSummary = { ok: false, folder: dir, files: 0, loaded: 0, skipped: 0, skippedBuiltin: 0, issues: [] }
  if (!dir) return summary
  agentPresetFileMap.clear()
  const pushIssue = (file: string, error: string) => {
    if (!summary.issues) summary.issues = []
    if (summary.issues.length < 20) summary.issues.push({ file: file.split(/[\\/]/).pop() || file, error })
  }
  try {
    const result = await getPlatform().fs.listTreeWithRelations(dir, 1)
    const files: any[] = (result?.fileList || []).filter((f: any) => String(f?.path || '').endsWith('.agent'))
    summary.files = files.length
    const presets: any[] = []
    for (const f of files) {
      try {
        const text = await getPlatform().fs.readText(f.path)
        const data = JSON.parse(text)
        if (!data || typeof data.id !== 'string' || !data.id.trim()) {
          summary.skipped++
          pushIssue(String(f.path), '缺少 id（预设必须有字符串 id）')
          continue
        }
        // 内置预设由软件按 id 提供：磁盘文件不能冒充（否则旧文件会盖掉出厂定义且被当成"不可删"）
        if (isBuiltinAgentPreset(data)) {
          summary.skippedBuiltin++
          pushIssue(String(f.path), `id「${data.id}」是内置预设，磁盘文件不予覆盖`)
          continue
        }
        presets.push(data)
        agentPresetFileMap.set(data.id, f.path)
        summary.loaded++
      } catch (e: any) {
        // 损坏 / 非预设文件：跳过但不静默——文件名与原因回给 UI / AI
        summary.skipped++
        pushIssue(String(f.path), e instanceof SyntaxError ? 'JSON 解析失败（不是合法 JSON）' : String(e?.message || e))
      }
    }
    // 以文件夹内 .agent 文件为准（不做 localStorage → 文件夹的自动同步迁移），
    // **但内置预设不是文件、也永远不会落盘**：不能因为扫描文件夹就把内存里
    // 用户对内置预设的编辑（工具勾选 / 名称 / 提示词）丢掉。
    // 做法：先保留本窗口内存里的内置项，再拼上文件夹里的自建项；
    // 缺失的内置 id 仍由 ensureBuiltinAgentPresets 按出厂值补齐。
    const builtinsBefore = (Array.isArray(store.agentPresets) ? store.agentPresets : [])
      .filter((p: any) => p && isBuiltinAgentPreset(p))
    // 自建项兜底：内存里有、磁盘上还没有的（新建后写盘失败 / 写盘还没完成就重扫）
    // 不能直接丢掉 —— 先尝试补写，成功的一并保留。否则「新建智能体 → 重开设置就没了」。
    const diskIds = new Set(presets.map((p: any) => String(p?.id || '')))
    const missingCustom = (Array.isArray(store.agentPresets) ? store.agentPresets : [])
      .filter((p: any) => p && p.id && !isBuiltinAgentPreset(p) && !diskIds.has(String(p.id)))
    const recovered: any[] = []
    for (const p of missingCustom) {
      try {
        if (await writeAgentPreset(p)) recovered.push(p)
      } catch { /* 单个失败不阻塞扫描 */ }
    }
    const custom = [...presets, ...recovered]
    store.agentPresets = [...builtinsBefore, ...custom]
    // 内置预设按 id 幂等兜底：文件夹模式以文件为准，但内置项不能因文件夹缺文件而消失
    ensureBuiltinAgentPresets(store.agentPresets as any[], builtinPresetDefaultsFromStore(store))
    summary.ok = true
  } catch (e: any) {
    summary.error = String(e?.message || e)
  }
  return summary
}

/** 目标路径是否已被其它预设占用 */
const pathTakenByOther = (presetId: string, p: string): boolean => {
  for (const [otherId, otherPath] of agentPresetFileMap) {
    if (otherId !== presetId && otherPath === p) return true
  }
  return false
}

/**
 * 文件夹模式下，这份预设要写的 .agent 文件是否与其它预设冲突。
 * 文件名由 name 清洗得到，两个同名预设会互相覆盖 —— 写入口必须在**动 store 之前**问一次。
 */
export function agentPresetFilePathConflict(preset: any): { conflictId: string; path: string } | null {
  const store = usestore() as any
  const dir = String(store.agentPresetPath || '')
  if (!dir || !preset?.id) return null
  const target = agentPresetFileMap.get(preset.id) || agentFilePath(preset, dir)
  for (const [otherId, otherPath] of agentPresetFileMap) {
    if (otherId !== preset.id && otherPath === target) return { conflictId: otherId, path: target }
  }
  return null
}

/**
 * 写入单个预设到 .agent 文件。
 *
 * 有已记录路径（prev）时写回原路径、保持文件名不变；否则按 sanitizeName(name)
 * 生成新路径写入（新建/复制/导入）。绝不自动删除或移动磁盘文件，
 * 也不因文件名规范化差异覆盖其它预设。
 *
 * 未启用文件夹模式时直接返回 false（本地存储模式不落盘）。
 *
 * @returns 是否写入成功（冲突/失败返回 false，不阻塞编辑）
 */
export const writeAgentPreset = async (preset: any): Promise<boolean> => {
  const store = usestore() as any
  const dir = String(store.agentPresetPath || '')
  if (!dir || !preset?.id) return false
  const prev = agentPresetFileMap.get(preset.id)
  const next = agentFilePath(preset, dir)
  const target = prev || next
  // 新文件（prev 不存在）且目标被其它预设占用 → 跳过，避免互相覆盖
  if (!prev && pathTakenByOther(preset.id, next)) return false
  try {
    await getPlatform().fs.writeText(target, JSON.stringify(preset, null, 2))
    agentPresetFileMap.set(preset.id, target)
    return true
  } catch {
    /* 写入失败不阻塞编辑 */
    return false
  }
}

/** 删除预设：删除 .agent 文件 + 移出内存列表 */
export const removeAgentPreset = async (id: string): Promise<void> => {
  const store = usestore() as any
  const path = agentPresetFileMap.get(id)
  if (path) {
    try { await getPlatform().fs.deleteFile(path) } catch { /* 忽略 */ }
    agentPresetFileMap.delete(id)
  }
  const idx = store.agentPresets.findIndex((c: any) => c.id === id)
  if (idx >= 0) store.agentPresets.splice(idx, 1)
}

/**
 * 把预设存储切到某个文件夹（设置路径 → 扫描 → 空目录时把 seedPresets 落盘 → 再扫描）。
 *
 * 空目录保护：目标目录里**一个 .agent 都没有**、而调用方交来了当前的自建预设时，
 * 先一次性把它们写成 .agent 文件再扫描——否则「切到一个空文件夹」会让列表里只剩内置预设
 * （而 localStorage 已被文件夹模式覆盖），等于一次静默的数据丢失。
 * 目录里已有文件时**绝不**碰任何文件（不自动合并 / 不覆盖用户文件）。
 *
 * 反向保护：源文件写不进去时**整体回滚**（路径清空 + 列表还原），宁可留在原来的存储，
 * 也不出现「列表空了、文件也没写」的半途状态。
 *
 * @param opts.seedPresets 空目录时要落进去的预设（调用方传切换前的快照）
 * @param opts.persist 是否立即落盘（缺省 true；批量初始化时可先攒着）
 */
export const applyAgentPresetFolder = async (
  dir: string,
  opts: { seedPresets?: any[]; persist?: boolean } = {},
): Promise<AgentPresetScanSummary> => {
  const store = usestore() as any
  const before: any[] = Array.isArray(store.agentPresets) ? JSON.parse(JSON.stringify(store.agentPresets)) : []
  const persist = opts.persist !== false
  store.agentPresetPath = dir
  // 进入文件夹模式：清掉「本地存储」标记，下次启动不再自动切回（当前已是文件夹）
  try { localStorage.removeItem('agentPresetLocalMode') } catch { /* 非桌面/无 localStorage 忽略 */ }
  if (persist) store.saveConfig?.()
  let summary = await scanAgentPresets()
  if (!summary.ok) {
    // 目录读不了：保留原列表与原来的存储模式，不让用户看到一个空列表
    store.agentPresetPath = ''
    store.agentPresets = before
    if (persist) store.saveConfig?.()
    summary.error = summary.error || '目录不可读'
    return summary
  }
  const seeds = (opts.seedPresets || []).filter((p) => p && p.id && !isBuiltinAgentPreset(p))
  // 不再只在「空目录」播种：只写「内存里有、磁盘上还没有」的自建项。
  // 旧逻辑在目录已有旧文件时什么都不写，于是用户从「本地存储」切回文件夹模式后，
  // 期间新建的预设会被磁盘旧列表整体覆盖（表现为新增智能体消失）。
  const currentIds = new Set((store.agentPresets as any[] || []).map((p: any) => String(p?.id || '')))
  const missingSeeds = seeds.filter((p) => !currentIds.has(String(p.id)))
  if (missingSeeds.length) {
    let seeded = 0
    for (const preset of missingSeeds) {
      try {
        if (await writeAgentPreset(preset)) seeded++
      } catch { /* 单个失败计入下面的一致性判断 */ }
    }
    if (summary.files === 0 && seeded !== missingSeeds.length) {
      // 空目录 + 写不进去 → 整体回滚（已写出的文件留在磁盘上，不删，用户可重试）
      store.agentPresetPath = ''
      store.agentPresets = before
      if (persist) store.saveConfig?.()
      summary.ok = false
      summary.seeded = seeded
      summary.error = `无法把 ${missingSeeds.length} 个预设全部写入目标文件夹（成功 ${seeded} 个），已保留原来的存储位置`
      return summary
    }
    if (seeded > 0) {
      summary = await scanAgentPresets()
      summary.seeded = seeded
      return summary
    }
  }
  if (persist) store.saveConfig?.()
  return summary
}

/**
 * 选择并启用预设文件夹（文件夹模式）。
 * @returns 扫描结果；用户取消选择时返回 null
 */
export const chooseAgentPresetFolder = async (opts: { seedPresets?: any[] } = {}): Promise<AgentPresetScanSummary | null> => {
  const path = await getPlatform().dialog.pickDirectory()
  if (!path) return null
  return await applyAgentPresetFolder(path, opts)
}

/**
 * 改回本地存储模式：保留当前内存里的预设（写进 localStorage），不再读写任何文件。
 * 不删除磁盘上的 .agent 文件（用户可能还要用别的工具打开）。
 */
export const closeAgentPresetFolder = async (): Promise<void> => {
  const store = usestore() as any
  store.agentPresetPath = ''
  agentPresetFileMap.clear()
  // 记住「用户显式选择了本地存储」：启动时 ensureDefaultAgentPresetFolder 不再自动切回文件夹，
  // 否则本地模式期间新建的预设会被旧文件夹列表整体覆盖。
  try { localStorage.setItem('agentPresetLocalMode', '1') } catch { /* 忽略 */ }
  store.saveConfig?.()
}

/** 在系统文件管理器里打开预设文件夹（未启用文件夹模式时返回 false） */
export const revealAgentPresetFolder = async (): Promise<boolean> => {
  const store = usestore() as any
  const dir = String(store.agentPresetPath || '')
  if (!dir) return false
  try {
    const res = await getPlatform().shell.revealInFolder(dir)
    return res !== false
  } catch {
    return false
  }
}

/**
 * 兼容旧入口：早期版本把"打开预设文件夹"做成"选目录 + 导入其中全部 .agent"，
 * 且路径只在本会话生效。现在它等价于「选择文件夹并启用文件夹模式」。
 */
export const openAgentPresetFolder = chooseAgentPresetFolder

/** 文件夹现状（设置页显示当前模式 / 文件数用） */
export const agentPresetFolderInfo = async (): Promise<{ folder: string; exists: boolean; fileCount: number }> => {
  const store = usestore() as any
  const folder = String(store.agentPresetPath || '')
  if (!folder) return { folder: '', exists: false, fileCount: 0 }
  try {
    const result = await getPlatform().fs.listTreeWithRelations(folder, 1)
    const files: any[] = (result?.fileList || []).filter((f: any) => String(f?.path || '').endsWith('.agent'))
    return { folder, exists: true, fileCount: files.length }
  } catch {
    return { folder, exists: false, fileCount: 0 }
  }
}

/**
 * 导出全部预设为 .agent 文件到所选文件夹（不改动 agentPresetPath）。
 * @returns 成功导出的预设数量；用户取消选择文件夹时返回 -1
 */
export const exportAllAgentPresets = async (): Promise<number> => {
  const store = usestore() as any
  if (store.agentPresets.length === 0) return 0
  const dir = await getPlatform().dialog.pickDirectory()
  if (!dir) return -1
  let ok = 0
  for (const c of store.agentPresets as any[]) {
    // 内置预设由软件自带，不导出：避免在同名文件夹里覆盖用户自建预设文件
    if (isBuiltinAgentPreset(c)) continue
    try {
      const p = agentFilePath(c, dir)
      await getPlatform().fs.writeText(p, JSON.stringify(c, null, 2))
      ok++
    } catch { /* 单个失败不影响其它 */ }
  }
  return ok
}
