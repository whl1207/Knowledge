/**
 * useAgentPresetTask.ts — 「AI 自己创建 Agent 预设」的渲染层执行体
 *
 * 为什么在渲染层：预设的单一事实源是 `store.agentPresets`（内存 + localStorage /
 * `.agent` 文件），只有渲染进程拿得到它（主进程不知道用户的预设，也拿不到技能库与插件工具清单）。
 *
 * 链路（与 export_word 同一套接缝，见 src/platform/rendererTasks.ts）：
 *   内置 MCP 服务 builtin-agent-preset 的工具 handler（主进程）
 *     → requestRendererTask(agentId, 'agent_preset', { op, ... })
 *     → 本模块执行（读写 store + 文件 + 校验）
 *     → 结果回传主进程 → 作为 mcp_call 的工具结果给模型
 *
 * 纪律（与 DSH 的「声明 → 自检 → 唯一写通道」一致）：
 *   1. 写之前必须过 `validatePreset`（与 preset_validate 同一份实现），有 error 直接拒；
 *   2. 只能写用户自建预设，`builtin-*` 一律拒绝（改内置请先 get 再换 id 另存）；
 *   3. 校验的自动修正项（fixes）必须原样回报，不静默改。
 */

import { usestore } from '@/store'
import { getPlatform } from '@/platform'
import { AGENT_TOOL_REGISTRY, getSkillManager } from '@/services/agentSkills'
import { getPluginDeclaredToolNames, toolsFromCapabilities } from '@/lib/agent/capabilities'
import { isBuiltinAgentPreset } from '@/shared/builtinAgentPresets'
import { formatValidationIssues, validatePreset, type PresetValidationContext, type PresetValidationResult } from '@/shared/agentPresetSpec'
import { writeAgentPreset, removeAgentPreset, agentFilePath, agentPresetFileMap, scanAgentPresets, agentPresetFilePathConflict } from '@/composables/useAgentPresets'
import { normalizeLlmTypeList } from '@/shared/llmSources'

export interface PresetTaskResult {
  ok: boolean
  value?: any
  error?: string
}

/** 生成一个新预设 id（时间戳 + 随机后缀；满足 shared 的 id 规则） */
const genPresetId = (): string => `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** 当前可用的工具名（内置注册表 + 插件声明；run_code 由 PTC 自动提供，校验器会剔掉） */
export function availableToolNames(): string[] {
  const names = new Set<string>()
  for (const t of AGENT_TOOL_REGISTRY) names.add(t.name)
  for (const t of getPluginDeclaredToolNames()) names.add(t)
  names.add('run_code')
  return Array.from(names)
}

/**
 * 带超时的 Promise：慢扫描（技能库 / 工作区目录）不能把整个 MCP 调用拖到 60 秒超时。
 * 超时返回 fallback（校验时这两项是「锦上添花」的未知项检查，缺了只是少几条警告）。
 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 技能库（只列可用技能；被禁用的技能选了也不会注入，故不列）。
 *
 * ⚠️ 这里**不重新扫盘**：`skills.list` 走主进程的同步目录扫描，技能目录很大时会
 * 把主进程事件循环卡住几十秒——MCP 调用（也在主进程）因此超时，实测就出现过
 * 「preset_list / preset_validate 60 秒超时」。改为读已经装进 SkillManager 的那份清单
 * （聊天 / 预设组装时已经加载过）；没加载过就先返回空，校验器会跳过那几条警告。
 */
async function availableSkillKeys(): Promise<string[]> {
  const store = usestore()
  try {
    const mgr: any = getSkillManager(store)
    const list: any[] = (mgr?.getSkills?.() as any[]) || []
    const disabled = new Set(((store as any).disabledSkills || []) as string[])
    const keys: string[] = []
    for (const s of list) {
      if (!s || typeof s.name !== 'string' || disabled.has(s.name)) continue
      keys.push(String(s.path || s.name))
      keys.push(s.name)
    }
    return keys
  } catch {
    return []
  }
}

/** 工作区里的 .kb（供 knowledgeBaseFiles 校验与提示） */
async function availableKbPaths(): Promise<string[]> {
  const store = usestore()
  const root = (store as any).root
  if (!root) return []
  try {
    const result = await getPlatform().fs.listTreeWithRelations(root, 1)
    const files: any[] = (result?.fileList || []).filter((f: any) => String(f?.path || '').endsWith('.kb'))
    return files.map((f) => String(f.path))
  } catch {
    return []
  }
}

/**
 * 技能 / 知识库清单的短缓存：一次对话里常连续调 list → validate → write，
 * 每次重扫技能目录既慢又可能撞 60 秒超时（实测「preset_list 超时」就是它）。
 * 缓存 60 秒，足够覆盖一次构建流程；用户刚装完技能时最多晚一分钟出现在提示里。
 */
const ENV_CACHE_TTL_MS = 60_000
let envCache: { at: number; skillKeys: string[]; kbPaths: string[] } | null = null

/**
 * 取技能库 + .kb。
 * @param opts.allowScan false = 只读缓存，绝不触发扫描（`preset_list` 用这个：它只是展示，
 *        不该为了列一份 .kb 名单去扫工作区；扫描留给 validate / write，那里才真的需要）。
 */
async function environmentLists(opts: { allowScan?: boolean } = {}): Promise<{ skillKeys: string[]; kbPaths: string[] }> {
  const allowScan = opts.allowScan !== false
  if (envCache && Date.now() - envCache.at < ENV_CACHE_TTL_MS) {
    return { skillKeys: envCache.skillKeys, kbPaths: envCache.kbPaths }
  }
  if (!allowScan) return { skillKeys: [], kbPaths: [] }
  const [skillKeys, kbPaths] = await Promise.all([
    withTimeout(availableSkillKeys(), 4_000, []),
    withTimeout(availableKbPaths(), 4_000, []),
  ])
  envCache = { at: Date.now(), skillKeys, kbPaths }
  return { skillKeys, kbPaths }
}

/** 当前可用的模型来源（与预设页来源下拉同一口径：排除被禁用的来源） */
function availableLlmTypes(): string[] {
  const store = usestore() as any
  try {
    const all = normalizeLlmTypeList(
      store.AIconfig?.llm?.types || ['ollama', 'openai', 'lmstudio', 'anthropic', 'google', 'azure', 'custom'],
    )
    return all.filter((t: string) => {
      if (typeof store.isLlmSourceDisabled === 'function' && store.isLlmSourceDisabled(t)) return false
      if (t === 'custom' && typeof store.hasEnabledCustomSource === 'function' && !store.hasEnabledCustomSource()) return false
      return true
    })
  } catch {
    return []
  }
}

/** 组装校验上下文（写入口与 preset_validate 共用，保证两条路径判据一致） */
async function buildContext(): Promise<PresetValidationContext> {
  const store = usestore() as any
  const env = await environmentLists()
  return {
    existing: (store.agentPresets || []).map((p: any) => ({ id: p.id, name: p.name, builtin: !!p.builtin })),
    availableTools: availableToolNames(),
    skillKeys: env.skillKeys,
    kbPaths: env.kbPaths,
    mcpServerIds: (store.mcpServers || []).filter((s: any) => s && s.enabled !== false).map((s: any) => String(s.id)),
    llmTypes: availableLlmTypes(),
  }
}

/**
 * 文件夹模式下若还没扫描过（本次启动后没打开过设置页），先扫一次。
 * 否则「文件路径映射」是空的：preset_list 的 file 字段为空、写入时的同名冲突也查不出来。
 * 目录不可读时 scan 会原样保留内存列表，不会把预设清空。
 */
async function ensureFolderScanned(): Promise<void> {
  const store = usestore() as any
  if (!store.agentPresetPath) return
  if (agentPresetFileMap.size > 0) return
  await scanAgentPresets()
}

/**
 * 预设存储现状（预设文件夹管理、交付说明都要用它）。
 * @param deep true（默认）= 真去列一遍目录，拿到准确的「文件数 / 目录可读」；
 *        false = 只用内存里的文件映射（`preset_list` 用这个，省掉一次目录 IPC）。
 */
async function hostInfo(deep = true): Promise<any> {
  const store = usestore() as any
  const folder = String(store.agentPresetPath || '')
  let folderExists = false
  let fileCount = 0
  if (folder) {
    if (!deep) {
      // 浅查询：扫描时建立的映射就是文件清单，不再为「列个数字」再走一次 IPC
      folderExists = true
      fileCount = agentPresetFileMap.size
    } else {
      try {
        const result = await getPlatform().fs.listTreeWithRelations(folder, 1)
        const files: any[] = (result?.fileList || []).filter((f: any) => String(f?.path || '').endsWith('.agent'))
        folderExists = true
        fileCount = files.length
      } catch {
        folderExists = false
      }
    }
  }
  const presets: any[] = store.agentPresets || []
  const builtinCount = presets.filter((p) => isBuiltinAgentPreset(p)).length
  return {
    mode: folder ? 'folder' : 'local',
    modeLabel: folder ? '文件夹模式（每个预设一个 .agent 文件）' : '本地存储（浏览器 localStorage）',
    folder,
    folderExists,
    fileCount,
    presetCount: presets.length,
    builtinCount,
    userCount: presets.length - builtinCount,
    writable: true,
    howToChangeFolder: '用户在「设置 → 智能体 → 管理」左侧底栏点存储位置（或右侧「存储位置设置」）选择 / 重新扫描 / 改回本地存储 / 恢复默认位置',
  }
}

/** 预设摘要（不含完整提示词，避免列表把上下文塞满） */
function summarize(p: any): any {
  const caps = p?.capabilities || {}
  // 旧预设没有 enabledTools：按能力槽推导出「运行时实际会拿到」的工具集（只读展示，不写回）
  const tools: string[] = Array.isArray(caps.enabledTools) ? caps.enabledTools : toolsFromCapabilities(caps)
  return {
    id: p?.id,
    name: p?.name,
    builtin: !!p?.builtin,
    tags: Array.isArray(p?.tags) ? p.tags : [],
    toolCount: tools.length,
    tools: tools.slice(0, 40),
    legacyTools: !Array.isArray(caps.enabledTools),
    mcpServerIds: Array.isArray(caps.mcpServerIds) ? caps.mcpServerIds : [],
    knowledgeBaseFiles: Array.isArray(caps.knowledgeBaseFiles) ? caps.knowledgeBaseFiles.length : 0,
    presentation: p?.presentation === 'ptc' ? 'ptc' : 'native',
    loopPromptMode: p?.loopPromptMode === 'sections' ? 'sections' : 'auto',
    file: agentPresetFileMap.get(String(p?.id)) || '',
  }
}

function findPreset(store: any, idOrName: string): any | null {
  const key = String(idOrName || '').trim()
  if (!key) return null
  const list: any[] = store.agentPresets || []
  return (
    list.find((p) => p && String(p.id) === key) ||
    list.find((p) => p && String(p.name || '').trim().toLowerCase() === key.toLowerCase()) ||
    null
  )
}

/** 把校验结果回给模型（文本，便于直接阅读；也便于写进交付说明） */
function validationPayload(result: PresetValidationResult): any {
  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    fixes: result.fixes,
    text: formatValidationIssues(result),
    preset: result.preset,
  }
}

/**
 * 写一份自建预设（唯一写通道）。
 * @param input 原始声明（可缺 id / 缺省字段，由校验器规范化）
 */
async function writePreset(input: any, overwrite = true): Promise<any> {
  const store = usestore() as any
  const raw = input && typeof input === 'object' ? { ...input } : {}
  // 缺 id 由宿主生成：先补再校验，这样「id 非法」这类错误仍然报得出来
  if (!raw.id || !String(raw.id).trim()) raw.id = genPresetId()

  const ctx = await buildContext()
  const result = validatePreset(raw, ctx)
  if (!result.ok) {
    throw new Error(`预设未通过校验，未写入：\n${formatValidationIssues(result)}`)
  }
  const preset = result.preset

  // 内置保护：AI 不能覆盖 / 新建内置预设
  if (String(preset.id).startsWith('builtin-') || isBuiltinAgentPreset(preset)) {
    throw new Error(
      `「${preset.id}」是内置预设，不能覆盖。改内置预设请先 preset_get 取回、换一个 id 与 name 另存为自建预设（内置预设可编辑，但由用户在设置页改）。`,
    )
  }

  // 文件夹模式：先确认 .agent 目标文件没被别的预设占用（文件名由 name 生成），
  // 否则会出现「store 改了、文件没写」的半成功状态。
  if (store.agentPresetPath) {
    const conflict = agentPresetFilePathConflict(preset)
    if (conflict) {
      throw new Error(
        `文件名冲突：这份预设会写到 ${conflict.path}，但该文件已属于预设「${conflict.conflictId}」（.agent 文件名由 name 生成）。请换一个 name，或先删除 / 重命名那个预设。`,
      )
    }
  }

  const list: any[] = store.agentPresets || (store.agentPresets = [])
  const idx = list.findIndex((p) => p && p.id === preset.id)
  if (idx >= 0) {
    if (list[idx]?.builtin) throw new Error(`「${preset.id}」是内置预置，不能覆盖（同上：换 id 另存）`)
    if (!overwrite) throw new Error(`已存在 id 为「${preset.id}」的预设（overwrite=false 时不允许覆盖）`)
    list.splice(idx, 1, preset)
  } else {
    list.push(preset)
  }
  store.saveConfig()

  // 文件夹模式：同步落 .agent 文件（本地存储模式不写盘）
  let file = ''
  const warnings = [...result.warnings]
  if (store.agentPresetPath) {
    const ok = await writeAgentPreset(preset)
    file = ok ? agentPresetFileMap.get(preset.id) || agentFilePath(preset, store.agentPresetPath) : ''
    if (!ok) {
      // store 已经改了，但文件没写成（权限 / 目录消失）：必须如实报，不能假装成功
      warnings.push({
        code: 'file.write_failed',
        message: `预设已写入应用内，但 .agent 文件没写成（${store.agentPresetPath}）：检查目录是否存在、是否可写后，用「预设 → 存储位置 → 重新扫描」或再写一次。`,
      })
    }
  }

  return {
    id: preset.id,
    name: preset.name,
    created: idx < 0,
    updated: idx >= 0,
    file,
    storage: store.agentPresetPath ? 'folder' : 'local',
    fixes: result.fixes,
    warnings,
    tools: preset.capabilities?.enabledTools || [],
  }
}

async function deletePreset(idOrName: string): Promise<any> {
  const store = usestore() as any
  const target = findPreset(store, idOrName)
  if (!target) throw new Error(`找不到预设「${idOrName}」（先 preset_list 看准确 id）`)
  if (target.builtin || isBuiltinAgentPreset(target)) throw new Error(`「${target.name || target.id}」是内置预设，不能删除`)
  await removeAgentPreset(String(target.id))
  store.saveConfig()
  return { id: target.id, name: target.name, deleted: true, storage: store.agentPresetPath ? 'folder' : 'local' }
}

/**
 * 渲染层任务入口（kind === 'agent_preset'）。
 * 所有分支都返回 { ok, value | error }，异常由本函数统一收口成可读中文。
 */
export async function handleAgentPresetTask(payload: any): Promise<PresetTaskResult> {
  const op = String(payload?.op || '')
  const store = usestore() as any
  try {
    // 文件夹模式：本次启动还没扫过就先扫（同步「内存列表 / 文件路径映射」与磁盘）
    await ensureFolderScanned()
    switch (op) {
      case 'host':
        return { ok: true, value: await hostInfo() }

      case 'list': {
        // 文件夹模式但还没扫描（例如刚在另一个窗口改了文件夹）：先扫一次，保证列表与磁盘一致
        if (store.agentPresetPath && !store.agentPresets?.length) await scanAgentPresets()
        const t0 = Date.now()
        // 技能 / .kb 只读缓存：`preset_list` 是展示用途，不该为它去扫工作区
        const env = await environmentLists({ allowScan: false })
        const host = await hostInfo(false)
        const t1 = Date.now()
        const presets = (store.agentPresets || []).map(summarize)
        const t2 = Date.now()
        return {
          ok: true,
          value: {
            host,
            presets,
            availableTools: availableToolNames(),
            skillKeys: env.skillKeys,
            kbPaths: env.kbPaths,
            mcpServerIds: (store.mcpServers || []).filter((s: any) => s && s.enabled !== false).map((s: any) => String(s.id)),
            llmTypes: availableLlmTypes(),
            // 诊断用：慢的时候一眼看出是「环境 / 宿主信息」还是「序列化预设施摘要」
            timingsMs: { envAndHost: t1 - t0, summarize: t2 - t1, total: Date.now() - t0 },
            envScanned: !!envCache,
          },
        }
      }

      case 'reload': {
        // AI 用 write_file 直接写进预设目录之后：重新扫描，并把「载入 / 跳过（含原因）」回给它自检；
        // 已载入的自建预设再跑一遍字段校验（直写路径没有经过 preset_write 的规范化）。
        const summary = await scanAgentPresets()
        store.ensureBuiltinAgentPresets?.()
        store.saveConfig?.()
        let invalidPresets: Array<{ id: string; name: string; errors: string[] }> = []
        try {
          const ctx = await buildContext()
          invalidPresets = (store.agentPresets || [])
            .filter((p: any) => p && p.id && !isBuiltinAgentPreset(p))
            .map((p: any) => {
              const r = validatePreset(p, ctx)
              return r.ok ? null : { id: String(p.id), name: String(p.name || ''), errors: r.errors.map((e) => e.message) }
            })
            .filter(Boolean) as any
        } catch { /* 校验失败不影响载入结果 */ }
        return { ok: true, value: { ...summary, presetCount: (store.agentPresets || []).length, invalidPresets } }
      }

      case 'get': {
        const target = findPreset(store, String(payload?.id || ''))
        if (!target) throw new Error(`找不到预设「${payload?.id}」（先 preset_list 看准确 id）`)
        return {
          ok: true,
          value: {
            preset: JSON.parse(JSON.stringify(target)),
            file: agentPresetFileMap.get(String(target.id)) || (store.agentPresetPath ? agentFilePath(target, store.agentPresetPath) : ''),
            builtin: !!target.builtin,
            hint: target.builtin
              ? '这是内置预设：可以照它的结构改，但要换一个 id 与 name 才能写入（preset_write 会拒绝 builtin-*）'
              : '可直接作为 preset_write 的底稿',
          },
        }
      }

      case 'validate': {
        const input = payload?.preset
        if (!input || typeof input !== 'object') throw new Error('preset_validate 缺少 preset 参数（完整预设 JSON）')
        const result = validatePreset(input, await buildContext())
        return { ok: true, value: validationPayload(result) }
      }

      case 'write': {
        const input = payload?.preset
        if (!input || typeof input !== 'object') throw new Error('preset_write 缺少 preset 参数（完整预设 JSON）')
        const value = await writePreset(input, payload?.overwrite !== false)
        return { ok: true, value }
      }

      case 'delete':
        return { ok: true, value: await deletePreset(String(payload?.id || '')) }

      default:
        return { ok: false, error: `未知的预设操作：${op}（可用：host / list / get / validate / write / delete）` }
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}
