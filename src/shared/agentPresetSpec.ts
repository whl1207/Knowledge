/**
 * agentPresetSpec.ts — Agent 预设的「声明规范」单一数据源
 *
 * 为什么单独一个 shared 文件：预设现在有**两条写入路径**——
 *   1. 用户在「设置 → 智能体 → 管理」里手改（AgentPreset.vue → store）；
 *   2. 模型经内置 MCP 服务 `builtin-agent-preset` 调 `preset_write` 让宿主代写。
 * 两条路径必须用**同一份**字段规范与校验规则，否则会出现「界面存得下、模型写就被拒」
 * 或「模型写得进、运行时却不认」的分裂（DSH 的教训：预设是声明，写入前必须自检）。
 *
 * 本文件只放纯数据与纯函数：不读 store、不碰 DOM、不 import 渲染层模块，
 * 因此渲染进程（`@/shared/...`）与主进程 MCP 服务都能直接用。
 */

import { CAPABILITY_TOOL_SLOTS } from '@/lib/agent/capabilities'

/** 内置 MCP 服务 id（store.mcpServers 里的一项；「智能体设计师」预设按它绑定） */
export const AGENT_PRESET_MCP_ID = 'builtin-agent-preset'

/** 内置 MCP 服务的显示名 */
export const AGENT_PRESET_MCP_NAME = '智能体设计参考'

/** 预设各字段的长度/取值上限（写入口与校验共用） */
export const PRESET_LIMITS = {
  /** 显示名上限（也是 .agent 文件名清洗前的来源） */
  nameMax: 60,
  /** 系统提示词上限（字符；超长会挤掉工具清单与技能） */
  promptMax: 20000,
  /** 单个指令段正文上限 */
  sectionMax: 8000,
  /** 指令段数量上限 */
  sectionsMax: 24,
  /** 标签数量上限 */
  tagsMax: 12,
  /** 循环轮数（单回合最大步数）上限 */
  maxStepsMax: 1000,
} as const

/** 预设出厂默认能力（新建预设与 AI 新建预设共用，保证「最小权限起步」） */
export const DEFAULT_PRESET_CAPABILITIES: Record<string, any> = {
  readFiles: true,
  executeCode: true,
  webSearch: true,
  accessKnowledgeBase: false,
  browseWebsites: true,
  writeFiles: true,
  listDirs: true,
  runShell: false,
  runSubagent: false,
  skills: true,
  askUser: true,
  updatePlan: true,
  updateTodo: true,
  mcpAccess: false,
  mcpServerIds: [],
  mcpEquipmentIds: [],
  knowledgeBaseFiles: [],
}

/** 预设「指令段」模式支持的插值占位符（与 src/lib/agent/promptContext.ts 保持一致） */
export const PRESET_SECTION_PLACEHOLDERS = ['toolUsage', 'kbHint', 'skills', 'cwd', 'model', 'provider'] as const

/** 预设顶层字段（未知键会被校验器报出来，防模型写错字段名） */
export const PRESET_FIELDS: Array<{ key: string; type: string; required?: boolean; desc: string }> = [
  { key: 'id', type: 'string', required: true, desc: '稳定标识，小写字母/数字/-/._，1~64 位；省略时由宿主生成。已有 id = 覆盖该预设' },
  { key: 'name', type: 'string', required: true, desc: '显示名（≤60 字，不能含 \\ / : * ? " < > | 与换行；它同时是 .agent 文件名）' },
  { key: 'tags', type: 'string[]', desc: '标签（≤12 个），用于预设面板搜索' },
  { key: 'systemPrompt', type: 'string', required: true, desc: '系统提示词（角色 + 工作方式）；sections 模式下可留空，由指令段拼装' },
  { key: 'loopPromptMode', type: "'auto' | 'sections'", desc: "缺省 auto；sections = 用 loopSections 拼装提示词（支持 {{cwd}} 等占位符）" },
  { key: 'loopSections', type: 'Array<{ id, title, text }>', desc: 'sections 模式下的指令段，按数组顺序拼接，段序即最终提示词顺序' },
  { key: 'llmType', type: 'string', desc: "模型来源；'' = 跟随默认（读全局「设置 → 模型」的当前来源）" },
  { key: 'model', type: 'string', desc: '模型名；跟随默认时留空' },
  { key: 'temperature', type: 'number', desc: '0~2，缺省 0.7' },
  { key: 'maxSteps', type: 'number', desc: '单回合最大步数 1~1000；缺省回退全局循环轮数' },
  { key: 'kbTopK', type: 'number', desc: '知识库检索召回切片数 1~20，缺省 3' },
  { key: 'selectedSkills', type: 'string[]', desc: '勾选的技能（技能 path 或 name）；空 = 不勾选' },
  { key: 'capabilities', type: 'object', required: true, desc: '能力槽 + enabledTools（逐工具白名单，唯一权威；见 preset_capabilities）' },
  { key: 'presentation', type: "'native' | 'ptc'", desc: "工具呈现方式，缺省 native；ptc = 模型只看到 run_code（程序化工具调用）" },
  { key: 'seedHistory', type: 'boolean', desc: '是否把历史消息作上下文带入（缺省 true）' },
]

/** 能力槽 → 工具名（直接从运行时唯一数据源派生，绝不手抄第二份） */
export const PRESET_CAPABILITY_DOCS: Array<{ key: string; tools: string[]; note: string }> = CAPABILITY_TOOL_SLOTS.map((slot) => ({
  key: slot.key,
  tools: slot.tools.slice(),
  note: slot.needsKnowledgeFiles
    ? '需 capabilities.knowledgeBaseFiles 非空才会真正注入'
    : slot.defaultOn
      ? '旧预设缺省开启；逐工具模式下以 enabledTools 为准'
      : '',
}))

/** 每个能力槽「一句话说明」（给模型看，避免只看到工具名不知道语义） */
const CAPABILITY_NOTES: Record<string, string> = {
  askUser: '向用户提问并等待回答（无人值守场景会被运行时剔除）',
  updatePlan: '计划模式：写计划 + 请用户评审（exit_plan_mode）',
  updateTodo: '任务清单',
  mcpAccess: '调用已启用的 MCP 服务（必须同时勾 mcp_call 并配 mcpServerIds）',
  accessKnowledgeBase: '知识库切片检索（必须先关联 .kb 文件）',
  readFiles: '读文件 + 按内容/文件名搜索',
  listDirs: '列目录',
  writeFiles: '写文件 / 精确替换 / 多段替换',
  executeCode: '执行 Python',
  runShell: '执行 shell 命令（能力最大的槽位，按需才开）',
  webSearch: '联网搜索 + 抓取网页',
  browseWebsites: '内置浏览器操作（会真实点击/填写，谨慎开启）',
  runSubagent: '派生子代理 + 后台任务收集/停止',
  skills: '技能库（按需加载 SKILL.md 并按其流程执行）',
}

/** 预设的常见组合（给模型「照着改」的起点，而不是从零想） */
const PRESET_RECIPES: Array<{ name: string; when: string; tools: string[] }> = [
  { name: '只读分析', when: '读代码 / 查资料 / 出结论，不改任何东西', tools: ['read_file', 'search_files', 'list_dir', 'web_search', 'web_fetch', 'ask_user', 'update_todo'] },
  { name: '编码助手', when: '要改文件并验证', tools: ['read_file', 'search_files', 'list_dir', 'write_file', 'replace_in_file', 'multi_replace', 'run_python', 'shell', 'update_plan', 'exit_plan_mode', 'update_todo', 'ask_user'] },
  { name: '知识库问答', when: '只答用户资料里的内容（先关联 .kb）', tools: ['kb_search', 'read_file', 'ask_user'] },
  { name: '工具调度', when: '经 MCP 调外部服务（Office / 浏览器 / 自定义）', tools: ['mcp_call', 'ask_user', 'update_todo'] },
]

export interface PresetIssue {
  /** 机器可读的错误码（写入口据此分类；也给模型稳定引用） */
  code: string
  /** 面向模型/用户的说明（含正确做法） */
  message: string
}

export interface PresetValidationContext {
  /** 现存预设（判重名与是否内置） */
  existing?: Array<{ id?: string; name?: string; builtin?: boolean }>
  /** 当前可用工具名（内置注册表 + 插件声明） */
  availableTools?: string[]
  /** 当前技能库的 path 与 name（两者都接受） */
  skillKeys?: string[]
  /** 当前工作区里可关联的 .kb 路径 */
  kbPaths?: string[]
  /** 当前已配置的 MCP 服务 id */
  mcpServerIds?: string[]
  /** 可用的模型来源类型（'deepseek' / 'ollama' …；'' 恒合法） */
  llmTypes?: string[]
}

export interface PresetValidationResult {
  /** 没有 error 即为可写入 */
  ok: boolean
  errors: PresetIssue[]
  warnings: PresetIssue[]
  /** 已自动修正的项（写入口会把这些如实回给模型） */
  fixes: string[]
  /** 规范化后的预设（可直接落 store / 写 .agent） */
  preset: any
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 预设 id 合法性：小写字母/数字开头，只含 [a-z0-9._-]，1~64 位。
 * 与 .agent 文件名、聊天存档里的 presetId 引用都按这个口径。
 */
export const presetIdProblem = (id: unknown): string | null => {
  const s = typeof id === 'string' ? id.trim() : ''
  if (!s) return '缺少 id（建议用英文小写 slug，如 note-coach）'
  if (s.length > 64) return 'id 超过 64 个字符'
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
    return `id「${s}」不合法：只能用小写字母、数字与 - . _，且必须以字母或数字开头（中文请写进 name）`
  }
  return null
}

/** 名称里不允许的字符（它同时是 .agent 文件名，宿主会按名称清洗文件名） */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\r\n\t]/

/** 编辑距离（用于「你是不是想写 xxx」的提示；只处理短串，成本可忽略） */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m || !n) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/** 在候选集里找最接近的名字（≤2 距离才给建议，避免乱猜） */
export function nearestName(name: string, candidates: string[]): string | null {
  const target = String(name || '').toLowerCase()
  if (!target) return null
  let best: string | null = null
  let bestScore = Infinity
  for (const c of candidates) {
    const score = editDistance(target, String(c).toLowerCase())
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best && bestScore > 0 && bestScore <= 2 ? best : null
}

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []
const clampNum = (v: unknown, min: number, max: number, fallback: number): { value: number; clamped: boolean } => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  if (!Number.isFinite(n)) return { value: fallback, clamped: false }
  const clamped = n < min || n > max
  return { value: Math.min(max, Math.max(min, n)), clamped }
}
const dedupe = (list: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

// ---------------------------------------------------------------------------
// 校验 / 规范化
// ---------------------------------------------------------------------------

/**
 * 校验并规范化一份预设声明。
 *
 * 语义：`errors` 非空 = **不可写入**（调用方必须拒绝）；`warnings` 不阻断；
 * `fixes` 是已经替你改好的项（默认值补齐 / 越界夹取 / 能力槽布尔镜像），
 * 必须如实回给模型——静默修正会让模型以为它写的就是生效的。
 */
export function validatePreset(input: any, ctx: PresetValidationContext = {}): PresetValidationResult {
  const errors: PresetIssue[] = []
  const warnings: PresetIssue[] = []
  const fixes: string[] = []
  const src = input && typeof input === 'object' ? input : {}
  const preset: any = {}

  // ---- 未知顶层字段（typo 防线：模型常写 system_prompt / tools / capability）----
  const knownKeys = new Set(PRESET_FIELDS.map((f) => f.key))
  const knownKeyList = PRESET_FIELDS.map((f) => f.key)
  for (const key of Object.keys(src)) {
    if (knownKeys.has(key)) continue
    if (key === 'builtin') {
      warnings.push({ code: 'field.builtin', message: 'builtin 是宿主内部标记，写入时会被忽略（AI 不能创建内置预设；内置预设请先 preset_get 再改 id/name 另存为新预设）' })
      continue
    }
    const near = nearestName(key, knownKeyList)
    errors.push({
      code: 'field.unknown',
      message: `未知字段「${key}」${near ? `，是不是想写「${near}」？` : ''}（可用字段见 preset_schema）`,
    })
  }

  // ---- id ----
  const idProblem = presetIdProblem(src.id)
  if (idProblem) errors.push({ code: 'id.invalid', message: idProblem })
  else preset.id = String(src.id).trim()

  // ---- name ----
  const name = asString(src.name).trim()
  if (!name) errors.push({ code: 'name.missing', message: '缺少 name（显示名，如「代码评审员」）' })
  else if (name.length > PRESET_LIMITS.nameMax) {
    errors.push({ code: 'name.too_long', message: `name 超过 ${PRESET_LIMITS.nameMax} 个字符（它同时是 .agent 文件名）` })
  } else if (ILLEGAL_NAME_CHARS.test(name)) {
    errors.push({ code: 'name.illegal_char', message: 'name 不能含 \\ / : * ? " < > | 或换行（它同时是 .agent 文件名）' })
  } else preset.name = name

  if (name) {
    const dup = (ctx.existing || []).find(
      (p) => p && p.id !== preset.id && String(p.name || '').trim().toLowerCase() === name.toLowerCase(),
    )
    if (dup) {
      errors.push({
        code: 'name.duplicate',
        message: `已存在同名预设「${dup.name}」（id=${dup.id}）：换一个 name，或直接沿用该 id 覆盖它`,
      })
    }
  }

  // ---- tags ----
  const tags = dedupe(asStringArray(src.tags)).slice(0, PRESET_LIMITS.tagsMax)
  if (Array.isArray(src.tags) && asStringArray(src.tags).length > PRESET_LIMITS.tagsMax) {
    fixes.push(`tags 超过 ${PRESET_LIMITS.tagsMax} 个，已截断`)
  }
  preset.tags = tags

  // ---- 提示词：auto（单段）/ sections（指令段）----
  const mode = src.loopPromptMode === 'sections' ? 'sections' : 'auto'
  if (src.loopPromptMode !== undefined && src.loopPromptMode !== 'auto' && src.loopPromptMode !== 'sections') {
    fixes.push(`loopPromptMode「${src.loopPromptMode}」不认识，已按 auto 处理`)
  }
  preset.loopPromptMode = mode
  const systemPrompt = asString(src.systemPrompt)
  if (systemPrompt.length > PRESET_LIMITS.promptMax) {
    errors.push({ code: 'prompt.too_long', message: `systemPrompt 超过 ${PRESET_LIMITS.promptMax} 字符，请把细节移进技能或指令段` })
  }
  preset.systemPrompt = systemPrompt

  const sections = Array.isArray(src.loopSections) ? src.loopSections : []
  if (src.loopSections !== undefined && !Array.isArray(src.loopSections)) {
    errors.push({ code: 'sections.type', message: 'loopSections 必须是数组（每项 { id, title, text }）' })
  }
  preset.loopSections = sections.slice(0, PRESET_LIMITS.sectionsMax).map((s: any, i: number) => {
    const title = asString(s?.title).trim() || `第 ${i + 1} 段`
    const text = asString(s?.text)
    const id = asString(s?.id).trim() || `section-${i + 1}`
    if (text.length > PRESET_LIMITS.sectionMax) {
      warnings.push({ code: 'sections.too_long', message: `指令段「${title}」超过 ${PRESET_LIMITS.sectionMax} 字符，建议拆段` })
    }
    if (!text.trim()) warnings.push({ code: 'sections.empty', message: `指令段「${title}」正文为空，会被渲染成空白段` })
    // 占位符检查：只认 promptContext 支持的那几个
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z]+)\s*\}\}/g)) {
      if (!(PRESET_SECTION_PLACEHOLDERS as readonly string[]).includes(m[1])) {
        warnings.push({
          code: 'sections.placeholder',
          message: `指令段「${title}」里的 {{${m[1]}}} 不会被插值（支持：${PRESET_SECTION_PLACEHOLDERS.map((p) => `{{${p}}}`).join(' / ')}）`,
        })
      }
    }
    return { id, title, text }
  })
  if (sections.length > PRESET_LIMITS.sectionsMax) fixes.push(`loopSections 超过 ${PRESET_LIMITS.sectionsMax} 段，已截断`)
  if (mode === 'sections') {
    if (!preset.loopSections.length) errors.push({ code: 'sections.missing', message: 'loopPromptMode=sections 但没有 loopSections：提示词会是空的' })
    const ids = preset.loopSections.map((s: any) => s.id)
    if (new Set(ids).size !== ids.length) errors.push({ code: 'sections.duplicate_id', message: 'loopSections 的 id 有重复' })
    if (!preset.loopSections.some((s: any) => s.text.trim())) {
      errors.push({ code: 'sections.all_empty', message: 'loopSections 全部为空：提示词会是空的' })
    }
  } else if (!systemPrompt.trim()) {
    warnings.push({ code: 'prompt.empty', message: 'systemPrompt 为空：模型只会拿到工具清单与运行时上下文，没有角色设定' })
  }

  // ---- 模型 ----
  preset.llmType = asString(src.llmType).trim()
  preset.model = asString(src.model).trim()
  if (preset.llmType && Array.isArray(ctx.llmTypes) && ctx.llmTypes.length && !ctx.llmTypes.includes(preset.llmType)) {
    warnings.push({ code: 'llm.unknown', message: `llmType「${preset.llmType}」不是当前已配置的来源，将回退到默认来源` })
  }
  if (!preset.llmType && preset.model) {
    warnings.push({ code: 'llm.model_without_type', message: '配了 model 但 llmType 为空（跟随默认）：跟随档下 model 会被忽略，建议两个一起配或都留空' })
  }

  // ---- 数值项 ----
  const temp = clampNum(src.temperature, 0, 2, 0.7)
  preset.temperature = temp.value
  if (temp.clamped) fixes.push(`temperature 超出 0~2，已夹到 ${temp.value}`)
  const topK = clampNum(src.kbTopK, 1, 20, 3)
  preset.kbTopK = Math.round(topK.value)
  if (topK.clamped) fixes.push(`kbTopK 超出 1~20，已夹到 ${preset.kbTopK}`)
  if (src.maxSteps !== undefined && src.maxSteps !== null) {
    const rawSteps = Number(src.maxSteps)
    // 0 / 负数不代表「跟随全局」：跟随全局的正确写法是**省略该字段**。
    // 若在这里夹到 1，模型会以为「0 = 不限制」而写出一个每轮只走一步的预设，故直接报错。
    if (!Number.isFinite(rawSteps) || rawSteps < 1) {
      errors.push({ code: 'maxSteps.invalid', message: `maxSteps 必须是 1~${PRESET_LIMITS.maxStepsMax} 的数字（跟随全局请省略该字段，不要写 0）` })
    } else {
      const steps = clampNum(rawSteps, 1, PRESET_LIMITS.maxStepsMax, 1)
      preset.maxSteps = Math.round(steps.value)
      if (steps.clamped) fixes.push(`maxSteps 超出 1~${PRESET_LIMITS.maxStepsMax}，已夹到 ${preset.maxSteps}`)
    }
  }

  // ---- 技能 ----
  const skills = dedupe(asStringArray(src.selectedSkills))
  preset.selectedSkills = skills
  if (skills.length && Array.isArray(ctx.skillKeys) && ctx.skillKeys.length) {
    const known = new Set(ctx.skillKeys)
    const unknown = skills.filter((s) => !known.has(s))
    if (unknown.length) {
      warnings.push({
        code: 'skills.unknown',
        message: `这些技能不在当前技能库里，不会被注入：${unknown.join('、')}${skills.length === unknown.length ? '（全选技能请用 preset_list 看 skillKeys）' : ''}`,
      })
    }
  }

  // ---- capabilities：逐工具白名单是唯一权威 ----
  const rawCaps = src.capabilities && typeof src.capabilities === 'object' ? src.capabilities : null
  if (!rawCaps) errors.push({ code: 'capabilities.missing', message: '缺少 capabilities（至少给 { enabledTools: [...] }，见 preset_capabilities）' })
  const caps: any = { ...DEFAULT_PRESET_CAPABILITIES, ...(rawCaps || {}) }
  // 能力槽布尔只作为镜像：由 enabledTools 反推（旧数据升级也走这条）
  let enabledTools: string[] = Array.isArray(rawCaps?.enabledTools) ? asStringArray(rawCaps!.enabledTools) : []
  if (rawCaps && !Array.isArray(rawCaps.enabledTools)) {
    enabledTools = toolsFromSlots(caps)
    fixes.push('capabilities.enabledTools 缺省：已按能力槽布尔推导出工具白名单（逐工具模式建议显式写）')
  }
  enabledTools = dedupe(enabledTools)

  // run_code 由 PTC 呈现自动提供，写进 enabledTools 会让人误以为它能单独开关
  if (enabledTools.includes('run_code')) {
    enabledTools = enabledTools.filter((t) => t !== 'run_code')
    fixes.push('已从 enabledTools 移除 run_code：它由 presentation=ptc 自动提供，不需要（也不该）单列')
  }

  // 未知工具名 = 硬错误（否则运行时被静默剔除，模型以为开了其实没开）
  if (Array.isArray(ctx.availableTools) && ctx.availableTools.length) {
    const knownTools = new Set(ctx.availableTools)
    for (const tool of enabledTools) {
      if (knownTools.has(tool)) continue
      const near = nearestName(tool, ctx.availableTools)
      errors.push({
        code: 'tools.unknown',
        message: `工具「${tool}」当前不存在${near ? `，是不是想写「${near}」？` : ''}（插件工具需插件已加载并声明；可用工具见 preset_list 的 availableTools）`,
      })
    }
  }

  // kb_search：没关联 .kb 时运行时不会注入
  const kbFiles = dedupe(asStringArray(caps.knowledgeBaseFiles))
  if (enabledTools.includes('kb_search') && !kbFiles.length) {
    warnings.push({ code: 'kb.no_files', message: '开了 kb_search 但 capabilities.knowledgeBaseFiles 为空：运行时不会注入该工具，模型会以为不能检索' })
  }
  if (kbFiles.length && Array.isArray(ctx.kbPaths) && ctx.kbPaths.length) {
    const knownKb = new Set(ctx.kbPaths)
    const unknown = kbFiles.filter((p) => !knownKb.has(p))
    if (unknown.length) {
      warnings.push({ code: 'kb.unknown_path', message: `这些 .kb 不在当前工作区，检索不到内容：${unknown.join('、')}` })
    }
  }

  // MCP：mcpAccess 只是门控，真正生效要 mcp_call + mcpServerIds
  const mcpServerIds = dedupe(asStringArray(caps.mcpServerIds))
  if (caps.mcpAccess && !enabledTools.includes('mcp_call')) {
    enabledTools.push('mcp_call')
    fixes.push('capabilities.mcpAccess=true 但没勾 mcp_call：已自动补入（否则 MCP 配置完全不生效）')
  }
  if (caps.mcpAccess && !mcpServerIds.length) {
    warnings.push({ code: 'mcp.no_server', message: '开了 mcpAccess 但 mcpServerIds 为空：模型能调 mcp_call，但不知道能调哪个服务' })
  }
  if (!caps.mcpAccess && enabledTools.includes('mcp_call')) {
    // 运行时是「mcpAccess 门控提示词注入」：勾了 mcp_call 却把 mcpAccess 关掉，
    // 工具在，但服务清单不会进提示词 → 模型只能盲猜 serverId。
    warnings.push({
      code: 'mcp.access_off',
      message: '勾了 mcp_call 但 capabilities.mcpAccess=false：服务清单不会注入提示词，模型只能盲猜 serverId（要么关掉 mcp_call，要么开 mcpAccess 并写 mcpServerIds）',
    })
  }
  if (Array.isArray(ctx.mcpServerIds) && ctx.mcpServerIds.length) {
    const unknown = mcpServerIds.filter((id) => !ctx.mcpServerIds!.includes(id))
    if (unknown.length) {
      warnings.push({ code: 'mcp.unknown_server', message: `这些 MCP 服务当前未配置：${unknown.join('、')}` })
    }
  }
  caps.enabledTools = enabledTools
  caps.mcpServerIds = mcpServerIds
  caps.mcpEquipmentIds = dedupe(asStringArray(caps.mcpEquipmentIds))
  caps.knowledgeBaseFiles = kbFiles
  syncSlotBooleans(caps)
  preset.capabilities = caps
  if (!enabledTools.length) {
    warnings.push({ code: 'tools.empty', message: 'enabledTools 为空：该预设只能纯聊天，不能调用任何工具' })
  }

  // ---- 呈现方式 ----
  const presentation = src.presentation === 'ptc' ? 'ptc' : 'native'
  if (src.presentation !== undefined && src.presentation !== 'ptc' && src.presentation !== 'native') {
    fixes.push(`presentation「${src.presentation}」不认识，已按 native 处理`)
  }
  preset.presentation = presentation
  if (presentation === 'ptc' && enabledTools.includes('ask_user')) {
    warnings.push({ code: 'ptc.ask_user', message: 'PTC 模式下 ask_user 仍可用，但一次程序内提问会打断脚本流：确认确实需要再保留' })
  }

  preset.seedHistory = src.seedHistory === undefined ? true : src.seedHistory !== false

  return { ok: errors.length === 0, errors, warnings, fixes, preset }
}

/** 能力槽布尔 → 工具名（旧数据升级；与运行时 toolsFromCapabilities 的旧模式口径一致） */
function toolsFromSlots(caps: any): string[] {
  const out: string[] = []
  for (const slot of CAPABILITY_TOOL_SLOTS) {
    const v = caps?.[slot.key]
    let on = !!v
    if (slot.defaultOn) on = v !== false
    if (on && slot.needsKnowledgeFiles && !(Array.isArray(caps?.knowledgeBaseFiles) && caps.knowledgeBaseFiles.length)) on = false
    if (on) out.push(...slot.tools)
  }
  return out
}

/** 由 enabledTools 反推能力槽布尔（镜像；供仍读布尔值的旧逻辑用） */
function syncSlotBooleans(caps: any): void {
  for (const slot of CAPABILITY_TOOL_SLOTS) {
    caps[slot.key] = slot.tools.some((t) => Array.isArray(caps.enabledTools) && caps.enabledTools.includes(t))
  }
}

/** 校验结果的紧凑文本（失败时给模型看，别把整个 preset 打回去） */
export function formatValidationIssues(result: PresetValidationResult): string {
  const lines: string[] = []
  if (result.fixes.length) lines.push(`已自动修正（${result.fixes.length}）：`, ...result.fixes.map((f) => `  · ${f}`))
  if (result.warnings.length) lines.push(`警告（不阻断，${result.warnings.length}）：`, ...result.warnings.map((w) => `  ! ${w.message}`))
  if (result.errors.length) lines.push(`错误（必须改，${result.errors.length}）：`, ...result.errors.map((e) => `  ✗ ${e.message}`))
  if (!lines.length) lines.push('校验通过：没有错误，也没有警告。')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 给模型看的正文（内置 MCP 服务的静态话题）
// ---------------------------------------------------------------------------

/** `preset_schema`：字段表 + 硬规则 + 推荐工作流 */
export function presetSchemaText(): string {
  const fields = PRESET_FIELDS.map((f) => `- ${f.key}（${f.type}${f.required ? '，必填' : ''}）：${f.desc}`).join('\n')
  return [
    '【AI-KM Agent 预设：声明规范】',
    '预设 = 一份 JSON 声明：角色提示词 + 模型 + 逐工具白名单 + 技能 / 知识库 / MCP 绑定。它不写代码，也不挂插件；宿主把它编译成一次智能体运行的选项。',
    '',
    '字段（未知字段会被拒绝；不要写 builtin）：',
    fields,
    '',
    '硬规则（违反会被 preset_write 直接拒绝）：',
    '1. 只能写**用户自建**预设：id 不能是 builtin-* 或已存在的内置预设；改内置预设请先 preset_get 取回、换 id 与 name 另存。',
    '2. capabilities.enabledTools 是**唯一权威**：写了什么工具，运行时就能用什么；能力槽布尔（readFiles 等）只是镜像，会被宿主按 enabledTools 重算。',
    '3. 工具名必须真实存在（内置工具 + 已加载的插件工具）。名字写错的检查在 preset_write 之前就会失败，改到没有 ✗ 再写。',
    '4. 缺省能力从**最小权限**起：不要默认开 shell / run_subagent / browseWebsites；确实需要时在回答里说明理由。',
    '5. name 不能含 \\ / : * ? " < > |（它同时是 .agent 文件名），且不能与现有预设重名。',
    '6. 提示词里别写"你不能做什么"来替代权限：权限由 enabledTools 决定，提示词只写角色与工作方式。',
    '',
    '推荐工作流（照做，别跳步）：',
    '1. preset_list：看现有预设（挑一个最接近的克隆）+ 当前可用工具名 + 技能 / MCP / 知识库清单。',
    '2. preset_get：取回那个预设施为底稿（没合适的就从 preset_example 抄一份）。',
    '3. 只改需要改的字段（通常 3~6 个：name / id / systemPrompt / enabledTools / mcpServerIds / selectedSkills）。',
    '4. preset_validate：先干跑，按 errors 改到没有 ✗（warnings 可以保留，但要在交付说明里提一句）。',
    '   ⚠️ 参数**必须放在 mcp_call 的 args 里**：`{"serverId":"builtin-agent-preset","tool":"preset_validate","args":{"preset":{...}}}`；直接把 preset 放在 args 外层会被判「缺少必填参数 preset」。',
    '5. preset_write：首选写通道（内部会再校验一次）；成功后返回 id、文件路径与生效范围。（如果你是被「智能体设计师」的工序驱动的：直接用 write_file 写 `<预设目录>/<名>.agent` 再 preset_reload，不需要调用 preset_write / preset_validate。）',
    '   兜底：如果 preset_* 调用超时，或你已用 write_file 把文件写到预设目录（文件名 `<name>.agent`，内容就是规范化的 JSON），写完后调 preset_reload 让宿主载入，并按返回的 issues 逐个修（JSON 语法 / 缺 id / id 占用内置 / 名字重复）。',
    '6. 交付：说清「叫什么 / 用什么工具 / 绑了什么服务 / 在哪选到它」，不要把整份 JSON 贴回给用户。',
    '',
    '相关话题：preset_capabilities（能力槽 ↔ 工具名对照 + 常见组合）、preset_example（可照抄的完整 JSON）。',
  ].join('\n')
}

/** `preset_capabilities`：能力槽 ↔ 工具 + 常见组合 */
export function presetCapabilitiesText(): string {
  const slots = PRESET_CAPABILITY_DOCS.map((s) => {
    const note = CAPABILITY_NOTES[s.key] || ''
    return `- ${s.key}：${s.tools.join('、')}${note ? `\n    ${note}` : ''}${s.note ? `（${s.note}）` : ''}`
  }).join('\n')
  const recipes = PRESET_RECIPES.map((r) => `- ${r.name}（${r.when}）：\n    enabledTools: ${JSON.stringify(r.tools)}`).join('\n')
  return [
    '【能力槽 ↔ 工具名】（写 enabledTools 时直接抄工具名；只写你真正需要的）',
    slots,
    '',
    '【常见组合（照着改，别从零想）】',
    recipes,
    '',
    '提示：',
    '- kb_search 必须同时把知识库文件写进 capabilities.knowledgeBaseFiles，否则运行时不会注入。',
    '- mcpAccess=true 时必须同时勾 mcp_call 并写 capabilities.mcpServerIds（服务 id 从 preset_list 拿）。',
    '- presentation=ptc 时模型只看到 run_code，工具经生成的 SDK 调用；run_code 不需要写进 enabledTools。',
    '- 插件工具名来自已加载的插件（preset_list 的 availableTools 会列出来）；插件没装 / 没启用时写它会被判成未知工具。',
  ].join('\n')
}

/** `preset_example`：两份可直接照抄的完整 JSON（缺 id，由调用方补） */
export function presetExampleText(): string {
  const basic = {
    id: 'note-coach',
    name: '笔记教练',
    tags: ['写作', '知识库'],
    systemPrompt: '你是「笔记教练」。用户给一段笔记或问题，你先用 kb_search 找相关知识库内容，再给出结构化建议：结论在前，理由分点，最后给一个可执行的小练习。资料里没有的内容要明说"资料里没有"，不要编造。',
    temperature: 0.6,
    loopPromptMode: 'auto',
    llmType: '',
    model: '',
    maxSteps: 40,
    kbTopK: 5,
    selectedSkills: [],
    capabilities: {
      enabledTools: ['kb_search', 'read_file', 'ask_user', 'update_todo'],
      knowledgeBaseFiles: ['C:/Users/me/knowledge/读书笔记.kb'],
      mcpAccess: false,
      mcpServerIds: [],
      mcpEquipmentIds: [],
    },
    seedHistory: true,
    presentation: 'native',
  }
  const sections = {
    id: 'code-reviewer',
    name: '代码评审员',
    tags: ['code', 'review'],
    loopPromptMode: 'sections',
    loopSections: [
      { id: 'persona', title: '人格', text: '你是一名严格的代码评审员。只评审、不改代码：给出问题、依据与最小修法。' },
      { id: 'env', title: '环境', text: '工作区：{{cwd}}；模型：{{provider}} / {{model}}' },
      { id: 'tools', title: '可用工具', text: '{{toolUsage}}' },
    ],
    systemPrompt: '',
    selectedSkills: [],
    capabilities: {
      enabledTools: ['read_file', 'search_files', 'list_dir', 'update_todo', 'ask_user'],
      knowledgeBaseFiles: [],
      mcpAccess: false,
      mcpServerIds: [],
      mcpEquipmentIds: [],
    },
    seedHistory: true,
  }
  return [
    '【可直接照抄的完整预设（JSON；id 可省略，由宿主生成）】',
    '',
    '① 知识库问答型（auto 单段提示词 + kb_search）：',
    JSON.stringify(basic, null, 2),
    '',
    '② 指令段拼装型（loopPromptMode=sections，用 {{cwd}} / {{toolUsage}} 插值）：',
    JSON.stringify(sections, null, 2),
    '',
    '用法：把上面任一份复制出来，改 name / id / systemPrompt / enabledTools，然后 preset_validate → preset_write。',
    '注意：示例里的 knowledgeBaseFiles 路径只是占位，必须换成 preset_list 返回的真实 .kb 路径（或留空）。',
  ].join('\n')
}

/** 内置 MCP 服务对外声明的工具清单（名字 + 说明 + 入参 schema；主进程服务与自测共用） */
export interface AgentPresetToolSpec {
  name: string
  description: string
  inputSchema: any
}

const obj = (properties: Record<string, any>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
})

export const AGENT_PRESET_TOOL_SPECS: AgentPresetToolSpec[] = [
  {
    name: 'preset_schema',
    description:
      '读取 Agent 预设的**声明规范**：全部字段与含义、硬规则（enabledTools 为唯一权威 / 只能写自建预设 / 工具名必须真实存在）、以及推荐的六步工作流。动手写预设前先读这一条。',
    inputSchema: obj({}),
  },
  {
    name: 'preset_capabilities',
    description:
      '读取**能力槽 ↔ 工具名**对照表（askUser / readFiles / writeFiles / runShell / webSearch / browseWebsites / mcpAccess / skills …）与四套常见组合（只读分析 / 编码助手 / 知识库问答 / 工具调度）。写 enabledTools 时按这里的工具名逐字抄。',
    inputSchema: obj({}),
  },
  {
    name: 'preset_example',
    description:
      '读取两份**可直接照抄的完整预设 JSON**：① auto 单段提示词 + kb_search 的知识库问答型；② loopPromptMode=sections 的指令段拼装型（含 {{cwd}} / {{toolUsage}} 占位符）。',
    inputSchema: obj({}),
  },
  {
    name: 'preset_host',
    description:
      '读取预设的**存储位置与现状**：当前是"本地存储"还是"文件夹模式"、文件夹绝对路径、可写性、预设总数 / 内置数 / 自建数、以及推荐的工作流入口。创建或改预设前先看一眼，交付时也好告诉用户文件落在哪。',
    inputSchema: obj({}),
  },
  {
    name: 'preset_list',
    description:
      '列出**现有预设摘要**（id / 名称 / 是否内置 / 标签 / 工具数 / 绑定的 MCP 服务 / 所在 .agent 文件），同时返回当前**可用工具名**、**已配置的 MCP 服务 id**，以及**已缓存**的技能 key / 知识库 .kb 路径（技能与 .kb 不再为列表触发磁盘扫描；需要它们时先跑一次 preset_validate）。挑一个最接近的预设做底稿，比从零生成可靠得多。返回里带 timingsMs，慢时可据此判断卡在哪一步。',
    inputSchema: obj({}),
  },
  {
    name: 'preset_get',
    description:
      '读取**单个预设的完整 JSON**（可直接作为 preset_write 的底稿：改 name / id / 提示词 / enabledTools 后再写回）。传 id 或名称都可以。',
    inputSchema: obj({
      id: { type: 'string', description: '预设 id；也可传名称（按名称精确匹配）' },
    }, ['id']),
  },
  {
    name: 'preset_validate',
    description:
      '**干跑校验**一份预设 JSON（不写盘）：返回 errors（必须改）/ warnings（不阻断）/ fixes（宿主自动修正的项）与规范化后的结果。preset_write 之前必须先跑这条，改到没有 ✗。**参数必须放在 mcp_call 的 args 里**：`args = {"preset": {...}}`（把 preset 放在 args 外层会报「缺少必填参数 preset」）。',
    inputSchema: obj({
      preset: { type: 'object', description: '完整预设 JSON（字段见 preset_schema；id 可省略）' },
    }, ['preset']),
  },
  {
    name: 'preset_write',
    description:
      '**首选写入通道**：创建或更新一份自建预设。内部会再校验一次（同 preset_validate），有 error 直接拒绝并原样返回问题清单；成功后写入 store、按需落 .agent 文件，并返回 id / 名称 / 文件路径 / 自动修正项。内置预设（builtin-*）不可覆盖。**参数必须放在 mcp_call 的 args 里**：`args = {"preset": {...}}`（放进 args 外层会报「缺少必填参数 preset」）。若这条 MCP 调用超时，可改用 write_file 直接写 `.agent` 再 preset_reload（见 preset_schema 工作流末条）。',
    inputSchema: obj({
      preset: { type: 'object', description: '完整预设 JSON；省略 id 时由宿主生成（便于收藏），建议显式给' },
      overwrite: { type: 'boolean', description: '允许覆盖同 id 的自建预设（默认 true：更新同名 id 即覆盖；设为 false 时 id 已存在则报错）' },
    }, ['preset']),
  },
  {
    name: 'preset_reload',
    description:
      '**重新扫描预设文件夹并让宿主载入**（`preset_write` 之外的兜底通道）：AI 用 write_file / 编辑器直接写了 `.agent` 文件之后调用它，返回载入几个、跳过哪几个以及原因（JSON 坏了 / 缺 id / id 占用内置项），并对已载入的自建预设做一遍字段校验（列出 errors）。改完再调一次，直到没有 ✗。',
    inputSchema: obj({}),
  },
  {
    name: 'preset_delete',
    description:
      '删除一份**自建**预设（内置预设不可删）。会同时删掉它的 .agent 文件；若已被聊天 / 集群 / 工作流引用，引用会悬空——删除前先在回答里跟用户确认。',
    inputSchema: obj({
      id: { type: 'string', description: '要删除的预设 id' },
    }, ['id']),
  },
]
