/**
 * skillAgent.ts — 技能 → Agent 循环适配器
 *
 * 把"技能执行"从 agentSkills.ts 的内部 ReAct 循环迁移到新 agent 循环：
 * - 技能（SKILL.md 指令 + 元数据）组装为 `AgentOptions`：systemPrompt 携带
 *   技能指令，tools 白名单 = 技能可用工具，cwd = 技能目录/工作区根；
 * - 执行由 agent-loop 驱动（turn/step + 工具注册表 + ask_user 问答接缝）；
 * - UI 通过 agentBridge 订阅会话视图（步骤时间线 / plan / todos / 提问）。
 */

import type { AgentOptions } from '@/types/agent'
import { DEFAULT_AGENT_MAX_STEPS } from '@/shared/agent-loop-rounds'

// ---------------------------------------------------------------------------
// 技能 Agent 默认工具集
// ---------------------------------------------------------------------------

/** 技能模式 agent 的默认可见工具（可按技能元数据裁剪） */
export const SKILL_AGENT_DEFAULT_TOOLS = [
  'read_file',
  'write_file',
  'replace_in_file',
  'multi_replace',
  'list_dir',
  'search_files',
  'run_python',
  'kb_search',
  'web_search',
  'web_fetch',
  'browser_navigate',
  'browser_extract_text',
  'browser_screenshot',
  'skill',
  'ask_user',
  'update_plan',
  'update_todo',
] as const

/** 判断某工具在当前白名单中是否可用；null/undefined 表示使用默认全集（全部可用） */
function toolEnabled(tools: readonly string[] | null | undefined, name: string): boolean {
  return !tools || tools.includes(name)
}


// ---------------------------------------------------------------------------
// 提示词组装
// ---------------------------------------------------------------------------

export interface SkillAgentPromptInput {
  name: string
  description: string
  /** SKILL.md 的指令正文 */
  content: string
  /** 技能目录内参考文件清单（主进程受限采样，仅作快速定位示例） */
  files?: string[]
  /** 技能目录真实文件总数（files 为采样；超大型技能用于提示"资源按需加载"） */
  fileCount?: number
  /** 技能目录（绝对路径；技能自带资源用 read_file 的 skill 参数或该绝对路径读取） */
  baseDir?: string
}

/** 组装技能 agent 的 system prompt（技能指令 + 工具使用约定） */
export function buildSkillSystemPrompt(
  skill: SkillAgentPromptInput,
  enabledTools?: readonly string[] | null,
): string {
  const tools = enabledTools ?? [...SKILL_AGENT_DEFAULT_TOOLS]
  const usageLines: string[] = []
  if (toolEnabled(tools, 'update_plan')) {
    usageLines.push('- 开始复杂多步任务前，先用 update_plan 规划步骤。')
  }
    if (toolEnabled(tools, 'update_todo')) {
      usageLines.push('- 执行中每完成一步用 update_todo 维护任务清单。')
    }
  if (toolEnabled(tools, 'ask_user')) {
    usageLines.push('- 需要用户补充信息时，使用 ask_user 提问，不要直接输出问题。')
  }
  usageLines.push('- 需要引用本地资料时用 read_file / search_files / kb_search；需要执行代码时用 run_python；需要联网时用 web_search + web_fetch。')
  usageLines.push('- read_file 单次返回有上限：返回 truncated=true 时要用 offset=nextOffset 继续读，直到 truncated=false 才算读完（读长文档 / 大文件时必须续读）。')
  // 资源提示（借鉴 DSH "资源按需加载、结果不枚举技能目录"）：不把全部文件路径
  // 注入上下文（超大型技能可达上万文件，会导致推理被截断），只给技能目录 +
  // 总数 + 少量示例，让模型用 list_dir / search_files / read_file 自行探索。
  const hasFiles = skill.files && skill.files.length > 0
  const fileCount = skill.fileCount ?? skill.files?.length ?? 0
  const fileHint = hasFiles || fileCount > 0
    ? [
        `\n技能目录资源（共 ${fileCount} 个文件${skill.baseDir ? `；技能目录：\`${skill.baseDir}\`` : ''}）：`,
        skill.baseDir
          ? `资源按需加载：不要枚举或一次性读取全部文件。读取技能自带资源时，用 read_file / list_dir / search_files 并传 skill="${skill.name}" + 相对路径（例：read_file({"skill":"${skill.name}","path":"references/x.md"})），或直接用绝对路径（如 \`${skill.baseDir}/references/x.md\`）。注意：不带 skill 的相对路径锚定的是**当前工作区**。`
          : '资源按需加载：不要枚举或一次性读取全部文件。需要时用 list_dir / search_files / read_file（相对路径锚定当前工作区）查找并读取具体文件。',
        hasFiles ? `参考文件示例（仅 ${Math.min(skill.files!.length, 15)} 个，便于快速定位）：\n${skill.files!.slice(0, 15).map((f) => `- ${f}`).join('\n')}` : '',
      ].filter(Boolean).join('\n')
    : ''
  return [
    `你正在执行技能「${skill.name}」（${skill.description}）。`,
    '请严格按照下面的技能指令执行任务，并结合你的通用能力完成任务目标。',
    '使用约定：',
    ...usageLines,
    // removed
    // removed
    '技能指令：',
    '---',
    skill.content,
    '---',
    fileHint,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 启动技能 Agent
// ---------------------------------------------------------------------------

export interface StartSkillAgentParams {
  skillName: string
  skillDescription: string
  skillContent: string
  skillFiles?: string[]
  /** 技能目录真实文件总数（files 为采样；防止超大型技能上下文膨胀） */
  skillFileCount?: number
  /** 技能目录（绝对路径；用于提示词里告知技能资源怎么寻址） */
  skillBaseDir?: string
  /** 工具执行的工作目录（技能目录或工作区根） */
  cwd?: string
  /** 技能可用工具白名单；不传用默认集合 */
  tools?: string[] | null
  /** LLM provider 与配置（渲染进程从 store.AIconfig + 聊天配置组装） */
  provider: string
  config: any
  llmConfig: any
  /** 用户输入（作为 agent 的首条消息） */
  userInput: string
  /** 单 turn 最大 step 数（默认取唯一数据源默认值 500；实际由 store.generalAgentMaxSteps 注入） */
  maxSteps?: number
  /** 会话历史种子（聊天窗口既有上下文，写入 agent 会话日志） */
  seedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 沙箱模式（'safe' | 'workspace' | 'trusted'；缺省 safe，fail-closed） */
  sandboxMode?: 'safe' | 'workspace' | 'trusted'
}

/** 组装技能 agent 的 AgentOptions（供渲染进程自建会话，或由 startSkillAgent 使用） */
export function buildSkillAgentOptions(params: StartSkillAgentParams): AgentOptions {
  return {
    systemPrompt: buildSkillSystemPrompt({
      name: params.skillName,
      description: params.skillDescription,
      content: params.skillContent,
      files: params.skillFiles,
      fileCount: params.skillFileCount,
      baseDir: params.skillBaseDir,
    }, params.tools ?? [...SKILL_AGENT_DEFAULT_TOOLS]),
    provider: params.provider,
    config: params.config,
    llmConfig: params.llmConfig,
    tools: params.tools ?? [...SKILL_AGENT_DEFAULT_TOOLS],
    cwd: params.cwd,
    label: `skill:${params.skillName}`,
    maxSteps: params.maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
    seedHistory: params.seedHistory,
    sandboxMode: params.sandboxMode,
  }
}

/**
 * replace_in_file / multi_replace 的使用约束（提示词硬性要求）。
 *
 * 与工具清单两处（buildToolUsageContext / buildAutonomousSystemPrompt）复用同一条文案，
 * 避免漏改一处导致模型不会用（历史上已踩过“工具清单只改一处”的坑）。
 */
const REPLACE_TOOLS_HINT =
  '   - replace_in_file / multi_replace：局部精确修改已有文件（在文件某段插入/替换/删除几行时优先用它们，不要用 write_file 把整个大文件整写回去）。硬性要求：① 改文件前先用 read_file 读取目标区域，old_string 必须从读到的原文里【逐字复制】（含缩进、标点、空行），禁止凭记忆手写；② old_string 取 3~10 行为宜（太少易不唯一，太多易抄错漏行）；③ 文件很小（约 200 行以内）时直接用 write_file 整写更稳；④ 未命中时会返回可复制的候选片段，请据此修正后重试，不要重复提交同一段 old_string'

/**
 * read_file 的分段读取（续读）说明。
 *
 * 与 REPLACE_TOOLS_HINT 同理：工具清单有两处（buildToolUsageContext /
 * buildAutonomousSystemPrompt），共用同一常量，避免只改一处导致模型读到大文件
 * 就以为“只有这些内容”。
 */
const READ_FILE_HINT =
  '   - read_file：读取文件内容；write_file：写入文件。read_file 单次返回有上限（纯文本约前 100KB、PDF/Word/Excel 前 20000 字符）：返回 truncated=true 时说明只读到一段，必须再用 offset=nextOffset 继续读，反复续读直到 truncated=false（读长文档 / 大文件时不要只读第一段就下结论）；也可用 offset / limit 直接定位到指定字符区间。读**技能自带资源**（SKILL.md 里的 regulations/x.md 这类）时，用 read_file / list_dir / search_files 的 skill 参数（例：read_file({"skill":"技能名","path":"references/x.md"})）；不带 skill 的相对路径锚定的是当前工作区'

/** 根据启用的工具白名单生成“可用工具”说明；供预设智能体在自定义 systemPrompt 之后附加 */
export function buildToolUsageContext(enabledTools?: readonly string[] | null): string {
  const tools = enabledTools ?? [...SKILL_AGENT_DEFAULT_TOOLS]
  const toolList: string[] = []
  if (toolEnabled(tools, 'list_dir')) toolList.push('   - list_dir：列出目录内容（用户问"某个盘/文件夹里有什么"时优先用它）')
    if (toolEnabled(tools, 'update_plan')) toolList.push('   - update_plan：制定/更新执行计划')
    if (toolEnabled(tools, 'update_todo')) toolList.push('   - update_todo：维护任务清单')
    if (toolEnabled(tools, 'ask_user')) toolList.push('   - ask_user：信息不足时向用户提问')
  if (toolEnabled(tools, 'read_file') || toolEnabled(tools, 'write_file')) toolList.push(READ_FILE_HINT)
  if (toolEnabled(tools, 'replace_in_file') || toolEnabled(tools, 'multi_replace')) toolList.push(REPLACE_TOOLS_HINT)
  if (toolEnabled(tools, 'search_files')) toolList.push('   - search_files：按文本搜索文件内容')
  if (toolEnabled(tools, 'run_python')) toolList.push('   - run_python：执行 Python 代码（处理数据、计算、批量文件操作等）')
  if (toolEnabled(tools, 'kb_search')) toolList.push('   - kb_search：检索本地知识库')
  if (toolEnabled(tools, 'web_search') || toolEnabled(tools, 'web_fetch')) toolList.push('   - web_search / web_fetch：联网搜索与读取网页')
  if (toolEnabled(tools, 'export_word')) toolList.push('   - export_word：把 Markdown 导出为 Word 文档（.docx，可指定模板/保存目录；内容可直接给 markdown 或给 .md 文件路径）')
  if (toolEnabled(tools, 'skill')) toolList.push('   - skill：加载并执行已安装技能')
  if (toolEnabled(tools, 'mcp_call')) toolList.push('   - mcp_call：调用已启用的 MCP 服务')
  if (toolEnabled(tools, 'shell')) toolList.push('   - shell：执行 Shell 命令（需完全访问）')
  if (toolEnabled(tools, 'run_subagent')) toolList.push('   - run_subagent：派生子智能体')
  if (toolList.length === 0) return ''
  return ['你可以使用以下工具：', ...toolList].join('\n')
}


// ---------------------------------------------------------------------------
// AgentLoop 提示词指令段（可配置的 system prompt 组装，兼容四 harness 的指令段方向）
// ---------------------------------------------------------------------------

/** AgentLoop 提示词指令段 */
export interface LoopSection {
  id: string
  title?: string
  text: string
}

/** 指令段渲染上下文（{{变量}} 插值用） */
export interface LoopSectionCtx {
  /** 工具白名单（生成 {{toolUsage}}） */
  tools?: readonly string[] | null
  /** 知识库能力提示（{{kbHint}}） */
  kbHint?: string
  /** 技能库清单文本（{{skills}}） */
  skills?: string
  /** 当前工作目录提示（{{cwd}}） */
  cwd?: string
  /** 模型名（{{model}}） */
  model?: string
  /** 来源/provider（{{provider}}） */
  provider?: string
}

/** 按序渲染指令段为 system prompt：过滤空段，支持 {{toolUsage}}/{{kbHint}}/{{skills}}/{{cwd}}/{{model}}/{{provider}} 变量插值 */
export function renderLoopSections(sections: LoopSection[] | undefined, ctx: LoopSectionCtx = {}): string {
  const toolUsage = ctx.tools ? buildToolUsageContext(ctx.tools) : ''
  const vars: Record<string, string> = {
    toolUsage: toolUsage || '',
    kbHint: ctx.kbHint || '',
    skills: ctx.skills || '',
    cwd: ctx.cwd || '',
    model: ctx.model || '',
    provider: ctx.provider || '',
  }
  return (sections || [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => {
      let t = s.text
      for (const [k, v] of Object.entries(vars)) {
        t = t.split(`{{${k}}}`).join(v)
      }
      return t
    })
    .join('\n\n')
}


/** 组装通用（自主）agent 的 system prompt——智能体模式无匹配技能时的自主规划路径 */
export function buildAutonomousSystemPrompt(
  extraContext?: string,
  installedSkills?: Array<{ name: string; description?: string }>,
  enabledTools?: readonly string[] | null,
): string {
  const ctx = extraContext ? `\n额外上下文：\n${extraContext}` : ''
  const tools = enabledTools ?? [...SKILL_AGENT_DEFAULT_TOOLS]
  const toolList: string[] = []
  if (toolEnabled(tools, 'list_dir')) toolList.push('   - list_dir：列出目录内容（用户问"某个盘/文件夹里有什么"时优先用它）')
  if (toolEnabled(tools, 'read_file') || toolEnabled(tools, 'write_file')) toolList.push(READ_FILE_HINT)
  if (toolEnabled(tools, 'replace_in_file') || toolEnabled(tools, 'multi_replace')) toolList.push(REPLACE_TOOLS_HINT)
  if (toolEnabled(tools, 'search_files')) toolList.push('   - search_files：按文本搜索文件内容')
  if (toolEnabled(tools, 'run_python')) toolList.push('   - run_python：执行 Python 代码（处理数据、计算、批量文件操作等）')
  if (toolEnabled(tools, 'kb_search')) toolList.push('   - kb_search：检索本地知识库')
  if (toolEnabled(tools, 'web_search') || toolEnabled(tools, 'web_fetch')) toolList.push('   - web_search / web_fetch：联网搜索与读取网页')
  if (toolEnabled(tools, 'export_word')) toolList.push('   - export_word：把 Markdown 导出为 Word 文档（.docx，可指定模板/保存目录；内容可直接给 markdown 或给 .md 文件路径）')
  if (toolEnabled(tools, 'skill')) toolList.push('   - skill：加载并执行已安装技能')
    if (toolEnabled(tools, 'mcp_call')) toolList.push('   - mcp_call：调用已启用的 MCP 服务')
    if (toolEnabled(tools, 'shell')) toolList.push('   - shell：执行 Shell 命令（需完全访问）')
    if (toolEnabled(tools, 'run_subagent')) toolList.push('   - run_subagent：派生子智能体')
  // 已安装技能库：让自主规划模式的 agent 也知道可用技能，用户询问技能时可自主回答
  const skillLib = Array.isArray(installedSkills) && installedSkills.length > 0
    ? [
        '你拥有一个已安装的技能库（skill 库），可用 skill 工具加载其中的技能并按其指令执行：',
        ...installedSkills.map((s) => `   - ${s.name}${s.description ? `：${s.description}` : ''}`),
        '用户问"有什么技能 / 会什么"时，直接列出上面的技能清单；',
      ].join('\n')
    : ''
  return [
    '你是一个自主规划执行任务的智能体（Agent），可以调用工具访问本地文件系统与网络。',
    '对用户提出的任务，请：',
    ...(toolEnabled(tools, 'update_plan') ? ['1. 先用 update_plan 制定执行计划；'] : []),
    ...(toolList.length ? ['2. 逐步执行，可用的工具包括：', ...toolList] : []),
    // removed
    // removed
    // removed
    // removed
    // removed
    // removed
    // removed
    ...(toolEnabled(tools, 'ask_user') ? ['3. 信息不足时用 ask_user 向用户提问；'] : []),
    ...(toolEnabled(tools, 'update_todo') ? ['4. 用 update_todo 维护任务清单，全部完成后传空数组清除。'] : []),
    skillLib,
    '最后给出结构化、完整的最终回答。',
    ctx,
  ].filter(Boolean).join('\n')
}

// ---------------------------------------------------------------------------
// 技能意图解析（智能体模式统一入口：技能列表 / 帮助 / $技能名 触发 / 自主）
// ---------------------------------------------------------------------------

export type SkillIntent =
  | { kind: 'list' } // 用户请求技能列表
  | { kind: 'help'; skillName: string } // 用户请求某技能帮助
  | { kind: 'skill'; skillName: string; rest: string } // 显式触发 $skill-name
  | { kind: 'autonomous' } // 无技能匹配 → 自主规划

/**
 * 解析用户输入为技能意图（对齐原 handleSkillMode 的关键词与 $mention 规则）。
 * @param message 用户输入
 * @param skills 已加载技能列表（用于校验 help/mention 目标是否存在）
 * @param parseMention skillManager.parseSkillMention（$skill-name 解析）
 */
export function parseSkillIntent(
  message: string,
  skills: Array<{ name: string }>,
  parseMention: (input: string) => { skillName: string; rest: string } | null,
): SkillIntent {
  const lower = message.toLowerCase().trim()
  const listKeywords = [
    // 中文
    '技能列表', '有哪些技能', '可用技能', '所有技能', '技能目录', '/skills', '列出技能',
    '你有什么技能', '你会什么技能', '你会做什么', '你会什么', '你能做什么', '你的技能',
    // English
    'skill list', 'list skills', 'available skills', 'all skills', 'show skills',
    'what skills do you have', 'what can you do', 'your skills',
  ]
  if (listKeywords.some((k) => lower.includes(k))) return { kind: 'list' }

  const helpMatch = lower.match(/^(help|帮助|介绍|说明)\s+(.+)$/)
  if (helpMatch) {
    const target = skills.find((s) => s.name.toLowerCase() === helpMatch[2].toLowerCase())
    if (target) return { kind: 'help', skillName: target.name }
  }

  const mention = parseMention(message)
  if (mention) {
    const skill = skills.find((s) => s.name.toLowerCase() === mention.skillName.toLowerCase())
    if (skill) return { kind: 'skill', skillName: skill.name, rest: mention.rest || '' }
  }

  return { kind: 'autonomous' }
}
