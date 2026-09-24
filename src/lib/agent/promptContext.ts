/**
 * promptContext.ts — Agent system prompt 共享组装（渲染进程唯一实现）
 *
 * 历史上「聊天智能体 / 预设 / 技能 / 集群 Agent / 工作流智能体节点 / 批量智能体」
 * 各自复制了一份 system prompt 组装逻辑，导致每新增一类上下文（工作区、MCP 工具清单、
 * 指令段插值…）都要改 4~5 处，漏改就出现「批量运行没有把工作区组装进上下文」这类问题。
 *
 * 本模块把组装收敛为一处：
 *   - 基础提示词：预设自定义提示 / 通用自主规划（buildAutonomousSystemPrompt）
 *   - 预设「指令段」模式（loopPromptMode='sections'，支持 {{toolUsage}}/{{kbHint}}/{{skills}}/{{cwd}}/{{model}}/{{provider}}）
 *   - 预设勾选技能：全选 → 补 skill 工具 + 技能库清单；部分选 → 嵌入 SKILL.md 正文
 *   - 知识库能力提示（kb_capability）
 *   - MCP 服务 + 真实工具清单（buildMcpServersContext，异步解析后作为参数传入）
 *   - 工作区提示（当前工作目录 + 工具 cwd）
 *
 * 调用方只需准备：tools 白名单、已启用技能清单、MCP 上下文文本、模型/provider（指令段插值用）。
 */
import { buildAutonomousSystemPrompt, buildToolUsageContext, renderLoopSections } from './skill'
import { mcpManager } from '@/platform/mcpManager'
import { getSkillManager } from '@/services/agentSkills'
import type { McpTool } from '@/types/mcp'

/** 技能简要信息（技能库清单 + 预设 selectedSkills 匹配用） */
export interface PromptSkillBrief {
  name: string
  description?: string
  /** 技能磁盘路径（预设 selectedSkills 以路径匹配；缺失则无法判定「全选」） */
  path?: string
  /** SKILL.md 正文（部分勾选时嵌入用；也可由 resolveSkill 现取） */
  body?: string
  content?: string
}

/** 预设勾选技能的解析器：key（路径或技能名）→ 技能对象 */
export type PromptSkillResolver = (key: string) => PromptSkillBrief | null | undefined

/** 视为「未自定义」的默认占位提示词（与预设页默认值一致） */
const DEFAULT_PROMPTS = ['你是一个乐于助人的AI助手。', 'You are a helpful AI assistant.']

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

/** 当前工作区根目录（空白字符串视为未设置） */
export function workspaceRoot(store: any): string {
  return String(store?.root || '').trim()
}

/**
 * 工作区提示文本（追加到 system prompt 用；未设置工作区返回 ''）。
 * 注意：AgentOptions.cwd 只做工具路径围栏，模型看不到；必须写进提示词才算「组装到上下文」。
 */
export function buildWorkspaceHint(store: any, locales?: string): string {
  const root = workspaceRoot(store)
  if (!root) return ''
  return (locales ?? store?.locales) === 'en'
    ? `\nCurrent working directory (workspace): ${root}`
    : `\n当前工作目录（工作区）：${root}`
}

// ---------------------------------------------------------------------------
// 技能库引导（所有 agent 入口的统一步骤）
// ---------------------------------------------------------------------------

/** 已由本模块加载过的技能目录（幂等标记；目录变更后自动重载，空目录也不会逐行重扫） */
const ensuredSkillPaths = new Set<string>()

/**
 * 确保技能库已按当前 `store.skillsPath` 加载，返回「已启用技能」清单（含 path/body/content）。
 *
 * **所有走 agent 循环的入口（聊天 / 批量 / 工作流节点 / 集群）都必须在 assembleAgentSystemPrompt 之前 await 本函数**，
 * 否则技能库会是空的。原因：技能库有两个消费方，都只在 loadSkills 之后才可用——
 *   1. 渲染进程 SkillManager：技能库清单、预设勾选技能的正文注入都读它；
 *   2. 主进程 skillService 的根目录：`skill` 工具按名取技能，只有 loadSkills IPC 会 setRoots。
 * 历史上只有聊天页 onMounted 调过一次 loadSkills，于是「直接进批量 / 工作流 / 集群」时技能库为空：
 * 技能库清单与预设勾选的技能都注入不进 system prompt，模型只能猜技能名去调 skill 工具 → 主进程报「技能不存在」。
 * 另外技能目录变更后本函数会自动重载（否则会继续用旧目录的技能注入）。
 *
 * 幂等且廉价：目录未变且已加载时直接复用内存中的技能表（批量逐行调用不会重复读盘）。
 */
export async function ensureAgentSkills(store: any, opts: { force?: boolean } = {}): Promise<PromptSkillBrief[]> {
  const path = String(store?.skillsPath || '').trim()
  if (!path) return []
  const mgr = getSkillManager(store)
  // 已经为这个目录加载过就不重复读盘（批量逐行调用；技能目录为空时也不会每行重扫一次）
  if (opts.force || mgr.getSkillsPath() !== path || !ensuredSkillPaths.has(path)) {
    try {
      await mgr.loadSkills(path)
      ensuredSkillPaths.add(path)
    } catch (e) {
      console.warn('[promptContext] 技能库加载失败：', e)
    }
  }
  const disabled = new Set<string>(store?.disabledSkills || [])
  return mgr.getSkills().filter((s) => !disabled.has(s.name))
}

// ---------------------------------------------------------------------------
// 知识库 / 技能库 / MCP 上下文
// ---------------------------------------------------------------------------

/** 知识库能力提示（预设 capabilities.accessKnowledgeBase + 已关联文件时才有） */
export function buildKbCapabilityHint(caps: any, locales?: string): string {
  const files = caps?.knowledgeBaseFiles
  if (!caps?.accessKnowledgeBase || !Array.isArray(files) || files.length === 0) return ''
  return locales === 'en'
    ? '\nYou have the "Access Knowledge Base" capability; use the kb_search tool to retrieve from your knowledge base when you need to reference it. You may adjust search terms and search multiple times for more comprehensive information.'
    : '\n你拥有「访问知识库」能力，需要引用知识库资料时请使用 kb_search 工具自主检索，可更换检索词多次检索以获得更全面信息。'
}

/** 技能库清单（告诉模型可用 skill 工具加载哪些技能；无技能时返回 ''） */
export function buildSkillLibraryText(skills: PromptSkillBrief[] | undefined): string {
  const list = (skills || []).filter((s) => s && s.name)
  if (list.length === 0) return ''
  return [
    '你拥有一个已安装的技能库（skill 库），可用 skill 工具加载其中的技能并按其指令执行：',
    ...list.map((s) => `   - ${s.name}${s.description ? `：${s.description}` : ''}`),
    '用户问"有什么技能 / 会什么"时，直接列出上面的技能清单；',
  ].join('\n')
}

/**
 * 工具入参签名（必填项带「必填」标注，且排在前面）。
 * 只注入工具名/描述时，模型不知道 workbookId / docId 这类必传参数，也不认识 sheetName 之类参数名，
 * 只能猜（实测出现过 query_sheet 这种不存在的参数名）；因此把 schema 摘要一并注入。
 */
export function toolParamSignature(tool: McpTool | any, zh = true): string {
  const schema = tool?.inputSchema
  const props = schema?.properties
  if (!props || typeof props !== 'object') return ''
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const keys = Object.keys(props)
  if (!keys.length) return ''
  const ordered = [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k))]
  const MAX_PROPS = 14
  const text = ordered.slice(0, MAX_PROPS).map((k) => {
    const type = String(props[k]?.type || 'any')
    return required.has(k) ? `${k}:${type}${zh ? '（必填）' : ' (required)'}` : `${k}:${type}`
  }).join('、')
  return keys.length > MAX_PROPS ? `${text} …` : text
}

/**
 * MCP 服务 + 工具清单说明（异步：需连接服务取回工具列表）。
 * 只传 mcpServerIds 不够——模型知道能调 mcp_call，但不知道有哪些服务与工具。
 * 单个服务连接/取工具失败不影响其它服务；全部失败返回 ''。
 */
export async function buildMcpServersContext(servers: any[], locales?: string): Promise<string> {
  const list = (servers || []).filter((s) => s && s.id)
  if (list.length === 0) return ''
  const zh = locales !== 'en'
  const parts: string[] = []
  for (const server of list) {
    try {
      const ok = await mcpManager.connect(server.id, server, server.id)
      if (!ok) continue
      const tools: McpTool[] = mcpManager.getTools(server.id, server.id) || []
      if (tools.length === 0) continue
      parts.push(zh
        ? `## MCP 服务：${server.name || server.id}（serverId: ${server.id}）`
        : `## MCP service: ${server.name || server.id} (serverId: ${server.id})`)
      for (const t of tools) {
        parts.push(`- ${t.name}: ${t.description || ''}`)
        const sig = toolParamSignature(t, zh)
        if (sig) parts.push(`  ${zh ? '参数' : 'params'}：${sig}`)
      }
    } catch { /* 单个服务失败不影响其它服务 */ }
  }
  if (parts.length === 0) return ''
  const head = zh
    ? '你已启用以下 MCP 服务。需要调用外部工具或控制装备时，请使用 mcp_call 工具，并传入对应的 serverId 与 tool 名称；参数放进 args，必填项不可省略。'
    + '会话式工具（Office 的 open_document / open_workbook）会返回 docId / workbookId，后续每次调用都必须把它原样带在 args 里。'
    : 'You have the following MCP services enabled. When you need to call an external tool or control equipment, use the mcp_call tool with the corresponding serverId and tool name, and put parameters in args (never omit required ones).'
    + ' Session-based tools (Office open_document / open_workbook) return a docId / workbookId that must be passed back in args on every later call.'
  return `\n${head}\n\n${parts.join('\n')}`
}

// ---------------------------------------------------------------------------
// 主组装函数
// ---------------------------------------------------------------------------

export interface AssembleAgentPromptInput {
  store: any
  /** 预设（agentPresets 项）；null/undefined = 通用智能体（自主规划） */
  preset?: any | null
  /** 无预设时的能力配置（集群 Agent 自持 capabilities 的场景） */
  capabilities?: any
  /** 无预设时的自定义提示词（集群 Agent 自持 systemPrompt 的场景） */
  customPrompt?: string
  /** 工具白名单（能力槽/自定义解析结果）；函数内部会复制，不修改入参 */
  tools?: readonly string[] | null
  /** 已启用技能清单（技能库清单 / selectedSkills 全选判定；需带 path） */
  enabledSkills?: PromptSkillBrief[]
  /** 预设勾选技能的解析器（部分勾选时取 SKILL.md 正文） */
  resolveSkill?: PromptSkillResolver
  /** 已禁用的技能名（部分勾选时跳过并提示） */
  disabledSkills?: string[]
  /** 已解析好的 MCP 工具清单文本（buildMcpServersContext 生成）；'' 表示不注入 */
  mcpContext?: string
  /** 追加到最后的自定义段落（调用方特有内容，如集群技能嵌入） */
  extraAppend?: string
  /** 指令段 {{model}} / {{provider}} 插值值（缺省读 store.AIconfig） */
  model?: string
  provider?: string
  /** 是否注入工作区提示（默认 true；false 时仍返回 cwd） */
  includeWorkspaceHint?: boolean
}

export interface AssembleAgentPromptResult {
  systemPrompt: string
  /** 最终工具白名单（可能被追加 skill / read_file） */
  tools: string[]
  /** 工具工作目录（预设「部分勾选技能」时可能切换到技能目录） */
  cwd: string | undefined
  /** 是否命中预设「指令段」模式（此时工作区/知识库等均由指令段插值控制） */
  usedSections: boolean
  /** 预设勾选但没能在当前技能库中匹配到的技能（path/name 原值）；用于把「静默不注入」暴露成日志 */
  unresolvedSkills: string[]
}

/**
 * 组装 Agent system prompt（唯一实现）。所有入口（聊天 / 预设 / 集群 / 工作流节点 / 批量）都应调用本函数。
 */
export function assembleAgentSystemPrompt(input: AssembleAgentPromptInput): AssembleAgentPromptResult {
  const store: any = input.store || {}
  const locales: string = store.locales || 'zh'
  const zh = locales !== 'en'
  const preset: any = input.preset || null
  const tools: string[] = [...(input.tools || [])]
  const allEnabledSkills: PromptSkillBrief[] = input.enabledSkills || []
  // 能力配置：预设优先，其次调用方自持（集群 Agent）；都没有则为「通用智能体」
  const caps: any = preset?.capabilities || input.capabilities || {}
  // 技能库开关：预设侧由 capabilities.skills 控制；通用智能体始终携带技能库清单
  const skillsEnabled = !!caps.skills
  const skillPool = preset ? (skillsEnabled ? allEnabledSkills : []) : allEnabledSkills

  const kbCapHint = buildKbCapabilityHint(caps, locales)
  const rawPrompt = String(preset ? preset.systemPrompt : input.customPrompt || '').trim()
  const hasCustomPrompt = !!rawPrompt && !DEFAULT_PROMPTS.includes(rawPrompt)
  const skillLibText = buildSkillLibraryText(skillPool)

  // 预设勾选技能（selectedSkills[] 新格式，兼容旧 selectedSkill 单选）
  const selectedSkillKeys: string[] = preset
    ? (Array.isArray(preset.selectedSkills) ? preset.selectedSkills : (preset.selectedSkill ? [preset.selectedSkill] : []))
    : []
  const allSkillsSelected = skillPool.length > 0 && skillPool.every((s) => !!s.path && selectedSkillKeys.includes(s.path!))
  // 全选 → 启用 skill 工具（与指令段模式无关，须在渲染前生效，{{toolUsage}} 才会包含 skill）
  if (allSkillsSelected && !tools.includes('skill')) tools.push('skill')

  const cwdHintText = input.includeWorkspaceHint === false ? '' : buildWorkspaceHint(store, locales)
  const usedSections = !!preset
    && preset.loopPromptMode === 'sections'
    && Array.isArray(preset.loopSections)
    && preset.loopSections.some((s: any) => s && typeof s.text === 'string' && s.text.trim())
  // 勾选技能解析器：未提供时直接在 enabledSkills 里按 path / name 查
  const resolveSkill: PromptSkillResolver = input.resolveSkill
    ?? ((key: string) => (input.enabledSkills || []).find((s) => s.path === key || s.name === key))

  let cwd: string | undefined = workspaceRoot(store) || undefined
  let systemPrompt: string
  // 勾选了但解析不到的技能（技能目录变更 / 技能改名后 preset.selectedSkills 里的旧路径即会落这里）
  const unresolvedSkills: string[] = []

  if (usedSections) {
    // 指令段模式：按序渲染，{{cwd}}/{{kbHint}}/{{skills}}/{{toolUsage}}/{{model}}/{{provider}} 插值
    systemPrompt = renderLoopSections(preset.loopSections, {
      tools,
      kbHint: kbCapHint.trim() || undefined,
      skills: skillLibText || undefined,
      cwd: cwdHintText.trim() || undefined,
      model: input.model ?? store?.AIconfig?.llm?.model ?? '',
      provider: input.provider ?? store?.AIconfig?.llm?.type ?? '',
    })
  } else {
    // 基础提示词：自定义提示（+ 工具说明）或通用自主规划
    if (hasCustomPrompt) {
      systemPrompt = rawPrompt
      const toolCtx = buildToolUsageContext(tools)
      if (toolCtx) systemPrompt = `${systemPrompt}\n\n${toolCtx}`
    } else {
      systemPrompt = buildAutonomousSystemPrompt(undefined, skillPool, tools)
    }
    if (kbCapHint) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${kbCapHint}` : kbCapHint

    if (allSkillsSelected) {
      // 全选 = 与「通用智能体」一致：skill 工具按需加载技能库
      if (!hasCustomPrompt) {
        systemPrompt = [buildAutonomousSystemPrompt(undefined, skillPool, tools), kbCapHint].filter(Boolean).join('\n\n')
      } else if (skillLibText) {
        systemPrompt = [systemPrompt, skillLibText].filter(Boolean).join('\n\n')
      }
    } else if (skillsEnabled && selectedSkillKeys.length > 0) {
      // 部分勾选：把所选技能 SKILL.md 指令嵌入 system prompt
      const disabledSet = new Set(input.disabledSkills ?? store.disabledSkills ?? [])
      const bodies: string[] = []
      const disabledNames: string[] = []
      /** 已解析到的技能目录（用于把绝对目录写进提示词；技能内资源改用 skill 参数/绝对路径寻址） */
      const skillDirs: Array<{ name: string; dir: string }> = []
      for (const key of selectedSkillKeys) {
        const skill = resolveSkill(key)
        if (!skill) { unresolvedSkills.push(key); continue }
        if (disabledSet.has(skill.name || key)) { disabledNames.push(skill.name || key); continue }
        const body = String(skill.body || skill.content || '').trim()
        const dir = String(skill.path || '').trim()
        if (dir) skillDirs.push({ name: skill.name || key, dir })
        if (body) bodies.push([`## 技能「${skill.name || key}」`, '---', body, '---'].join('\n'))
      }
      if (disabledNames.length > 0) {
        systemPrompt += zh
          ? `\n（所选技能已禁用，指令未注入，请按自主能力完成任务：${disabledNames.join('、')}）`
          : `\n(The selected skills are disabled; their instructions were not injected. Complete the task autonomously: ${disabledNames.join(', ')})`
      }
      if (bodies.length > 0) {
        // 技能自带资源用「skill 参数 + 相对路径」寻址（工具 cwd 恒为用户工作区，不因技能而改变）；
        // 这里把技能的**绝对目录**写进提示词，便于模型直接拼绝对路径或传 skill 参数。
        const dirLines = skillDirs.length > 0
          ? [
              zh ? '技能资源目录（绝对路径）：' : 'Skill resource directories (absolute paths):',
              ...skillDirs.map((s) => `- 「${s.name}」：${s.dir}`),
              zh
                ? `读取技能自带资源时，用 read_file / list_dir / search_files 的 skill 参数（例：read_file({"skill":"${skillDirs[0].name}","path":"regulations/x.md"})）；SKILL.md 里写的相对路径（如 regulations/x.md、references/x.md）就是相对该技能目录。不带 skill 的相对路径锚定的才是工作区。`
                : `To read a skill's own resources, pass the skill parameter of read_file / list_dir / search_files (e.g. read_file({"skill":"${skillDirs[0].name}","path":"regulations/x.md"})). Relative paths written in SKILL.md are relative to that skill directory; without the skill parameter they resolve against the workspace.`,
              '',
            ]
          : []
        systemPrompt = [
          zh ? `你正在以「${preset?.name || 'Agent'}」的身份执行技能。` : `You are executing skills as "${preset?.name || 'Agent'}".`,
          zh
            ? '请严格按照以下技能指令执行（指令已在下文，不要再调用 skill 工具去加载技能）：'
            : 'Strictly follow the skill instructions below (they are already provided; do NOT call the skill tool):',
          ...dirLines,
          '---',
          bodies.join('\n\n'),
          '---',
          systemPrompt,
        ].join('\n')
        if (!tools.includes('read_file')) tools.push('read_file')
      }
    }

    if (cwdHintText) systemPrompt += cwdHintText
  }

  if (input.mcpContext) systemPrompt += input.mcpContext
  if (input.extraAppend) systemPrompt = `${systemPrompt}\n\n${input.extraAppend}`
  if (unresolvedSkills.length > 0) {
    console.warn('[promptContext] 预设勾选的技能未匹配到（技能目录变更或技能改名后需重新勾选）：', unresolvedSkills.join('、'))
  }

  return { systemPrompt, tools, cwd, usedSections, unresolvedSkills }
}
