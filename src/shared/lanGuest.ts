/**
 * lanGuest.ts — 局域网访客（网页端）能力白名单：默认值 + 归一化（渲染层与主进程共用）
 *
 * 背景：局域网共享（`http://<ip>:3345`）把网页版暴露给局域网；网页端没有 ipcRenderer，
 * 它能做什么完全取决于主机「设置 → 协作 → 权限」里的这份策略。
 *
 * 设计原则：**默认全只读**——等价于今天「只能普通对话 + 知识库检索」的行为；
 * 任何放宽（写入文件 / 执行代码 / 调用 MCP / 使用智能体）都必须由用户在设置页显式勾选。
 * 后续主进程侧（/api/agent/*、/__proxy）直接消费本策略，因此放在 shared 供两侧共用。
 *
 * 注：桌面端「技能」已并入「智能体」（输入 `$技能名` 触发），因此访客侧不再有独立的
 * 「技能」模式——技能能力由**工具白名单里的 `skill` 工具**单独控制（默认关闭）。
 */

/** 访客可选的对话模式（与桌面端模式下拉一致：技能归入智能体） */
export type LanGuestMode = 'normal' | 'retrieval' | 'agent'

/** 沙箱级别（与全局 sandbox-policy 同名；访客只允许取「不高于全局」的严格度） */
export type LanGuestSandbox = 'safe' | 'workspace' | 'trusted'

/**
 * 访客对**主机共享目录**的文件访问档位：
 * - `off`（默认）：网页端没有本地文件能力，只能用共享知识库（改动前行为）
 * - `read`：可浏览 / 预览 / 检索共享目录（只读，写入一律拒绝）
 * - `write`：在 `read` 基础上可新建 / 保存 / 重命名 / 删除（仍被限制在共享目录内）
 */
export type LanGuestFsAccess = 'off' | 'read' | 'write'

/** 访客默认可用的对话模式（= 现状，不放开任何主机能力） */
export const LAN_GUEST_DEFAULT_MODES: LanGuestMode[] = ['normal', 'retrieval']

/** 访客可选的对话模式清单（agent / skill 走主机侧智能体桥 /api/agent/*） */
export const LAN_GUEST_MODES: Array<{
  value: LanGuestMode
  zh: string
  en: string
  icon: string
  zhDesc: string
  enDesc: string
}> = [
  {
    value: 'normal', zh: '普通', en: 'Normal', icon: 'fa-comments',
    zhDesc: '直接问答（不检索、不调用工具）',
    enDesc: 'Plain Q&A (no retrieval, no tools)',
  },
  {
    value: 'retrieval', zh: '知识库', en: 'Knowledge Base', icon: 'fa-database',
    zhDesc: '用主机共享的 .kb 或访客上传的文件作答',
    enDesc: 'Answer with the host-shared .kb or guest uploads',
  },
  {
    value: 'agent', zh: '智能体', en: 'Agent', icon: 'fa-android',
    zhDesc: '多步推理 + 在主机上调用白名单工具（含输入 $技能名 触发技能）',
    enDesc: 'Multi-step reasoning with whitelisted host tools (incl. $skill triggers)',
  },
]

/**
 * 访客默认可用的工具：只读 + 检索/联网。
 * 绝不含写入（write_file / replace_in_file / multi_replace）、执行（run_python / shell / run_code）
 * 与外部能力（mcp_call / skill / run_subagent / export_word）。
 */
export const LAN_GUEST_READONLY_TOOLS: string[] = [
  'read_file',
  'list_dir',
  'search_files',
  'kb_search',
  'web_search',
  'web_fetch',
]

/** 高危工具：勾选时需要二次确认（写入 / 执行 / 外部调用 / 导出） */
export const LAN_GUEST_DANGEROUS_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'replace_in_file',
  'multi_replace',
  'run_python',
  'shell',
  'run_code',
  'run_subagent',
  'mcp_call',
  'skill',
  'export_word',
])

export interface LanGuestPolicy {
  /** 允许访客使用的对话模式（默认仅普通 + 知识库） */
  modes: LanGuestMode[]
  /** 允许访客使用的 Agent 预设 id（空 = 只允许「通用智能体」） */
  presetIds: string[]
  /** 智能体工具白名单（语义同 store.agentTools：null=用默认集，[]=全部禁止，[names]=仅这些） */
  tools: string[] | null
  /** 访客沙箱级别（只能比全局更严格） */
  sandbox: LanGuestSandbox
  /** 访客智能体单轮最大步数（防死循环） */
  maxSteps: number
  /** 并发上限（保护主机 GPU / 模型） */
  maxConcurrent: number
  /** 是否要求访客携带访问令牌 */
  requireToken: boolean
  /** 访客访问令牌（与协同 / 共享文件夹的令牌分开） */
  token: string
  /** 是否允许访客自带模型 Key（默认 false = 必须用主机模型，经 /__proxy） */
  allowGuestModel: boolean
  /**
   * 访客智能体使用的**模型来源**（'' = 跟随主机当前激活来源）。
   * 取值 = 来源键（ollama/lmstudio/openai/deepseek/…）或自定义来源的 `custom:<索引>`。
   */
  guestLlmType: string
  /** 访客智能体使用的**模型名**（'' = 用该来源当前配置的模型） */
  guestLlmModel: string
  /**
   * 访客对主机**共享目录**的文件访问档位（默认 off）。
   * 打开后网页端才具备文件浏览 / 写入能力（见 LanGuestFsAccess），路径一律限制在共享目录内。
   */
  guestFs: LanGuestFsAccess
}

/** 默认策略：只读、不需要令牌、沙箱 safe、单并发 */
export function defaultLanGuestPolicy(): LanGuestPolicy {
  return {
    modes: [...LAN_GUEST_DEFAULT_MODES],
    presetIds: [],
    tools: [...LAN_GUEST_READONLY_TOOLS],
    sandbox: 'safe',
    maxSteps: 20,
    maxConcurrent: 1,
    requireToken: false,
    token: '',
    allowGuestModel: false,
    // 模型：默认跟随主机当前来源与当前模型（改动前行为）
    guestLlmType: '',
    guestLlmModel: '',
    // 文件访问：默认关闭（网页端无本地文件能力）
    guestFs: 'off',
  }
}

/** 访客文件访问档位选项（设置页「协作 → 权限」下拉） */
export const LAN_GUEST_FS_OPTIONS: Array<{ value: LanGuestFsAccess; zh: string; en: string }> = [
  { value: 'off', zh: '关闭（仅共享知识库）', en: 'Off (shared KB only)' },
  { value: 'read', zh: '只读（浏览 / 预览 / 检索）', en: 'Read-only (browse / preview / search)' },
  { value: 'write', zh: '可写（含新建 / 保存 / 删除）', en: 'Read & write (create / save / delete)' },
]

/** 是否允许访客读文件（共享目录内） */
export function lanGuestFsReadable(policy: LanGuestPolicy | undefined | null): boolean {
  const v = policy?.guestFs
  return v === 'read' || v === 'write'
}

/** 是否允许访客写文件（共享目录内） */
export function lanGuestFsWritable(policy: LanGuestPolicy | undefined | null): boolean {
  return policy?.guestFs === 'write'
}

/** 沙箱级别选项（访客只能取「不高于全局」的严格度；顺序由严到宽） */
export const LAN_GUEST_SANDBOX_OPTIONS: Array<{ value: LanGuestSandbox; zh: string; en: string }> = [
  { value: 'safe', zh: '安全（只读）', en: 'Safe (read-only)' },
  { value: 'workspace', zh: '工作区写入', en: 'Workspace write' },
  { value: 'trusted', zh: '完全访问', en: 'Full access' },
]

const SANDBOXES: LanGuestSandbox[] = ['safe', 'workspace', 'trusted']

// ---------------------------------------------------------------------------
// 主机侧访客接口（P3/P4）：令牌传递与路由常量（渲染层与主进程共用）
// ---------------------------------------------------------------------------

/** 访客携带令牌的请求头名（自定义头；浏览器 fetch 可自由设置） */
export const LAN_GUEST_TOKEN_HEADER = 'x-aikm-token'

/** 访客令牌的 Cookie 名（静态站无法自定义头，首次访问用 ?token= 换成 Cookie 后放行） */
export const LAN_GUEST_COOKIE = 'aikm_lan_token'

/** 访客令牌在本机浏览器里的存储键（从 ?token= 落盘，后续请求自动携带） */
export const LAN_GUEST_TOKEN_KEY = 'lanGuestToken'

/** 主机侧访客智能体接口前缀（/api/agent/create|send|events|…） */
export const LAN_AGENT_API_BASE = '/api/agent'

/** 主机侧「网页端可选模型来源」接口（含来源开关 / 地址 / 已探测模型；见 /api/llm/sources） */
export const LAN_LLM_SOURCES_API = '/api/llm/sources'

/**
 * 访客生效的智能体工具白名单。
 * 关键安全语义：策略里的 `tools: null`（渲染层表示「用默认集」）对访客**绝不**等于
 * 「全部工具」——必须回落为只读默认集（AgentOptions.tools = null 是「全部」，误传即失守）。
 */
export function effectiveGuestTools(policy: LanGuestPolicy | undefined | null): string[] {
  const list = policy?.tools
  if (Array.isArray(list)) return list.filter((t) => typeof t === 'string')
  return [...LAN_GUEST_READONLY_TOOLS]
}

/** 访客是否允许走主机智能体桥（/api/agent/*） */
export function lanGuestAgentAllowed(policy: LanGuestPolicy | undefined | null): boolean {
  return lanGuestModeAllowed(policy, 'agent')
}

/** 「通用智能体」的固定 id（预设选择里始终存在，不需要在策略中列白） */
export const LAN_GUEST_GENERAL_AGENT = 'general'

/**
 * 下发给主进程的「访客可用智能体」档案（P4 扩展：网页端可选智能体）。
 *
 * 由**主机渲染层**组装（预设提示词 / 工具白名单 / 知识库 / MCP 都只有渲染层拿得到），
 * 主进程只负责在此基础上叠加盟客策略限制（工具 ∩ 白名单、沙箱、步数、工作区围栏）。
 */
export interface LanGuestAgentProfile {
  id: string
  name: string
  /** 一句话摘要（预设标签 + 提示词首行；仅用于网页端浮层提示） */
  desc?: string
  /** 预设侧组装结果：{ systemPrompt, tools, kbPaths, kbTopK, mcpServerIds, mcpServerConfigs, mcpEquipmentIds, maxSteps } */
  options: Record<string, any>
}

/**
 * 归一化访客策略（旧存档缺失 / 脏数据兜底）：
 * 缺失字段一律回默认值（不回退为「放开」），未知模式与未知沙箱级别直接丢弃。
 */
export function normalizeLanGuestPolicy(raw: any): LanGuestPolicy {
  const def = defaultLanGuestPolicy()
  if (!raw || typeof raw !== 'object') return def
  const modes: LanGuestMode[] = Array.isArray(raw.modes)
    ? raw.modes.filter((m: any): m is LanGuestMode => LAN_GUEST_MODES.some((x) => x.value === m))
    : def.modes
  const tools: string[] | null = raw.tools === null
    ? null
    : (Array.isArray(raw.tools) ? raw.tools.filter((t: any) => typeof t === 'string') : def.tools)
  return {
    modes: modes.length ? [...new Set(modes)] : def.modes,
    presetIds: Array.isArray(raw.presetIds) ? raw.presetIds.filter((p: any) => typeof p === 'string') : def.presetIds,
    tools,
    sandbox: SANDBOXES.includes(raw.sandbox) ? raw.sandbox : def.sandbox,
    maxSteps: clampInt(raw.maxSteps, 1, 200, def.maxSteps),
    maxConcurrent: clampInt(raw.maxConcurrent, 1, 20, def.maxConcurrent),
    requireToken: typeof raw.requireToken === 'boolean' ? raw.requireToken : def.requireToken,
    token: typeof raw.token === 'string' ? raw.token : def.token,
    allowGuestModel: typeof raw.allowGuestModel === 'boolean' ? raw.allowGuestModel : def.allowGuestModel,
    // 访客模型来源/模型：仅接受字符串；非法值（含未知来源键）回落为「跟随主机」
    guestLlmType: typeof raw.guestLlmType === 'string' ? raw.guestLlmType.trim() : def.guestLlmType,
    guestLlmModel: typeof raw.guestLlmModel === 'string' ? raw.guestLlmModel.trim() : def.guestLlmModel,
    // 文件访问档位：仅接受三个已知值，其余一律回默认（off）
    guestFs: (['off', 'read', 'write'] as const).includes(raw.guestFs) ? raw.guestFs : def.guestFs,
  }
}

function clampInt(v: any, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 访客是否允许某对话模式 */
export function lanGuestModeAllowed(policy: LanGuestPolicy | undefined | null, mode: string): boolean {
  const modes = policy?.modes?.length ? policy.modes : LAN_GUEST_DEFAULT_MODES
  return modes.includes(mode as LanGuestMode)
}
