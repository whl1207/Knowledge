// src/services/agentSkills.ts

// ==================== Openclaw 兼容的类型定义 ====================

// 前置条件接口（兼容 Openclaw requires 字段）
export interface SkillRequires {
  bins?: string[]
  anyBins?: string[]
  env?: string[]
  config?: string[]
  models?: string[]
  os?: string[]
}

// 安装规范接口（兼容 Openclaw install 字段）
export interface SkillInstallSpec {
  id?: string
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download'
  label?: string
  bins?: string[]
  os?: string[]
  formula?: string
  package?: string
  module?: string
  url?: string
  archive?: string
  extract?: boolean
  stripComponents?: number
  targetDir?: string
}

// 技能元数据接口（兼容 Openclaw SKILL.md frontmatter 格式）
export interface SkillMetadata {
  name: string
  description: string
  version?: string
  author?: string
  tags?: string[]
  emoji?: string
  homepage?: string
  always?: boolean
  skillKey?: string
  primaryEnv?: string
  os?: string[]
  requires?: SkillRequires
  install?: SkillInstallSpec[]
}

// 技能接口（兼容 Openclaw Skill 模型）
export interface Skill {
  name: string
  description: string
  path: string
  baseDir: string
  metadata: SkillMetadata
  content: string           // 完整 SKILL.md 内容（含 frontmatter）
  body: string              // 去 frontmatter 后的纯内容
  files: string[]
  /** 技能目录真实文件总数（files 为主进程受限采样；超大型技能如 1w+ 模板文件不枚举全部） */
  fileCount?: number
  promptVersion?: string    // 内容哈希，用于变更检测
  source: string            // 技能来源标识
  disabled?: boolean        // 是否禁用
  /** 简短描述（Codex short-description），用于技能目录展示以节省 token */
  shortDescription?: string
}


// ==================== 结构化任务清单（todo，由 update_todo 工具维护） ====================

export type TodoStatus = 'pending' | 'running' | 'done' | 'cancelled'
export interface TodoItem {
  id: string
  title: string
  detail?: string
  status: TodoStatus
}

// ==================== 工具调用记录（用于UI展示） ====================

export interface ToolCallRecord {
  id: string
  tool: string
  params: Record<string, any>
  status: 'pending' | 'running' | 'success' | 'error'
  result?: any
  error?: string
  startTime?: number
  endTime?: number
  /** 文件读取时记录原始内容长度（字符数），用于UI显示实际文件大小 */
  originalLength?: number
}



// ==================== 阶段E：工具编排器与审批流（借鉴 Codex ToolOrchestrator / approvals.rs） ====================

// 沙箱偏好：工具运行所需的最小沙箱级别（Codex SandboxablePreference）
export type SandboxPreference = 'none' | 'readonly' | 'workspace-write' | 'full-access'

// 审批要求：执行该工具是否需要用户批准（Codex ExecApprovalRequirement 简化）
export type ApprovalRequirement = 'auto' | 'on-request' | 'forbidden'


// ==================== 工具注册表（工具管理 UI 共用） ====================

// 单个可用工具的展示信息（工具管理设置模块使用）
export interface AgentToolInfo {
  name: string
  /** 中文标签 */
  labelZh: string
  /** 英文标签 */
  labelEn: string
  /** Font Awesome 图标 */
  icon: string
  /** 简要说明 */
  description: string
  sandboxPreference: SandboxPreference
  approvalRequirement: ApprovalRequirement
  /** 默认是否启用（首次加载时的初始值） */
  defaultEnabled: boolean
  /** 是否始终启用（无法在工具管理中关闭，如引擎核心工具） */
  alwaysOn?: boolean
}

// 全部可用工具（agentskill 执行时可暴露的工具全集）
export const AGENT_TOOL_REGISTRY: AgentToolInfo[] = [
  { name: 'read_file', labelZh: '读取文件', labelEn: 'Read File', icon: 'fa-file-o', description: '读取本地文件内容（工作区内）；大文件单次只返回一段并给出截断位置，可用 offset 续读直到读完；传 skill 可读技能自带资源', sandboxPreference: 'readonly', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'write_file', labelZh: '写入文件', labelEn: 'Write File', icon: 'fa-pencil-square-o', description: '写入/创建文件内容（工作区内）', sandboxPreference: 'workspace-write', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'replace_in_file', labelZh: '替换片段', labelEn: 'Replace In File', icon: 'fa-eraser', description: '在文件中定位一段唯一原文并替换为新内容（精确局部修改，文件其余部分不变）', sandboxPreference: 'workspace-write', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'multi_replace', labelZh: '多处替换', labelEn: 'Multi Replace', icon: 'fa-files-o', description: '批量原子替换：一次提交多处 old→new，全部命中才落盘，任一失败整批不生效', sandboxPreference: 'workspace-write', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'list_dir', labelZh: '列出目录', labelEn: 'List Directory', icon: 'fa-folder-open-o', description: '列出目录条目（名称与类型），探查工作区结构；传 skill 可列出技能目录', sandboxPreference: 'readonly', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'web_search', labelZh: '搜索网页', labelEn: 'Web Search', icon: 'fa-search', description: '搜索互联网信息（返回标题/链接/摘要）', sandboxPreference: 'none', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'web_fetch', labelZh: '获取网页', labelEn: 'Fetch Web', icon: 'fa-globe', description: '获取网页完整内容（自动过滤 HTML 标签）', sandboxPreference: 'none', approvalRequirement: 'on-request', defaultEnabled: true },
  { name: 'search_files', labelZh: '搜索文件', labelEn: 'Search Files', icon: 'fa-search-plus', description: '在工作区中按文本搜索文件内容/文件名；传 skill 可在技能目录内搜索', sandboxPreference: 'readonly', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'run_python', labelZh: '执行代码', labelEn: 'Run Python', icon: 'fa-code', description: '执行 Python 代码（需用户批准）', sandboxPreference: 'workspace-write', approvalRequirement: 'on-request', defaultEnabled: true },
  { name: 'shell', labelZh: '执行命令', labelEn: 'Shell', icon: 'fa-terminal', description: '执行 shell 命令（仅「完全访问」可用，需批准）', sandboxPreference: 'full-access', approvalRequirement: 'on-request', defaultEnabled: true },
  { name: 'kb_search', labelZh: '知识库检索', labelEn: 'KB Search', icon: 'fa-database', description: '从本地知识库文件（.kb）检索相关切片（RAG）', sandboxPreference: 'readonly', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'skill', labelZh: '加载技能', labelEn: 'Load Skill', icon: 'fa-cubes', description: '加载已安装技能的完整定义（内容与资源清单），按技能流程执行任务', sandboxPreference: 'readonly', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'run_subagent', labelZh: '子代理', labelEn: 'Subagent', icon: 'fa-sitemap', description: '派生子代理会话独立执行子任务（in-process，复用 agent 循环）', sandboxPreference: 'none', approvalRequirement: 'on-request', defaultEnabled: true },
  { name: 'export_word', labelZh: '导出 Word', labelEn: 'Export Word', icon: 'fa-file-word-o', description: '把 Markdown（内容或 .md 文件路径）导出为 .docx，可指定模板与保存位置（复用统一导出管线）', sandboxPreference: 'workspace-write', approvalRequirement: 'on-request', defaultEnabled: false },
    { name: 'mcp_call', labelZh: 'MCP 调用', labelEn: 'MCP Call', icon: 'fa-plug', description: '通过 MCP 服务调用外部工具/装备控制（需在预设或上下文中配置 MCP 服务）', sandboxPreference: 'none', approvalRequirement: 'on-request', defaultEnabled: false },
  { name: 'ask_user', labelZh: '询问用户', labelEn: 'Ask User', icon: 'fa-question-circle-o', description: '向用户提问并等待回答', sandboxPreference: 'none', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'update_plan', labelZh: '更新计划', labelEn: 'Update Plan', icon: 'fa-list-alt', description: '创建/更新执行计划', sandboxPreference: 'none', approvalRequirement: 'auto', defaultEnabled: true },
  { name: 'update_todo', labelZh: '任务清单', labelEn: 'Update Todo', icon: 'fa-tasks', description: '维护结构化任务清单', sandboxPreference: 'none', approvalRequirement: 'auto', defaultEnabled: true },
]

// 技能管理器类
export class SkillManager {
  private skills: Map<string, Skill> = new Map()
  private skillsPath: string = ''
  private loading: boolean = false
  private store: any

  // 当前启用的工具名集合（工具管理设置；null = 使用注册表默认值）
  private enabledTools: Set<string> | null = null

  constructor(store: any) {
    this.store = store
  }


  // 获取所有技能
  getSkills(): Skill[] {
    return Array.from(this.skills.values())
  }

  // 获取技能
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  // 获取技能路径
  getSkillsPath(): string {
    return this.skillsPath
  }

  // 是否正在加载
  isLoading(): boolean {
    return this.loading
  }

  // 解析 SKILL.md content，提取 body（去 frontmatter）
  private parseSkillBody(content: string): string {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
    return match ? content.substring(match[0].length) : content
  }

  // 计算简单的内容哈希（用于 promptVersion）
  private computeContentHash(content: string): string {
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return 'v:' + Math.abs(hash).toString(36)
  }

  // ==================== 技能目录格式化（Openclaw 兼容） ====================

  // 生成技能目录 XML（类似 Openclaw 的 <available_skills>）
  // 长描述会被截断以减少 token 消耗
  formatSkillsCatalog(maxDescChars: number = 120): string {
    if (this.skills.size === 0) return ''

    const entries: string[] = []
    for (const skill of this.skills.values()) {
      const versionAttr = skill.promptVersion ? ` version="${skill.promptVersion}"` : ''
      // 优先使用简短描述（Codex short-description），省 token 且目录更清晰
      const descSource = skill.shortDescription || skill.description
      const desc = descSource
        ? this.escapeXml(descSource.length > maxDescChars
          ? descSource.substring(0, maxDescChars) + '…'
          : descSource)
        : ''
      entries.push(`    <skill>
      <name>${this.escapeXml(skill.name)}</name>
      <description>${desc}</description>
      <location>${this.escapeXml(skill.path)}/SKILL.md</location>${versionAttr}
    </skill>`)
    }

    return [
      '<available_skills>',
      ...entries,
      '</available_skills>',
      `匹配任务时用 read_file 读取对应 <location> 的 SKILL.md（技能不可直接调用，需读取其指令后手动执行）。`,
      `<version> 变化时需重读。`,
      `SKILL.md 中 "/" 开头的路径表示相对于该技能目录，read_file 时拼接技能目录为绝对路径。`,
    ].join('\n')
  }

  // XML 转义
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  // 加载技能
  async loadSkills(path: string): Promise<Skill[]> {
    if (!path) {
      this.skills.clear()
      this.skillsPath = ''
      return []
    }

    this.loading = true
    this.skillsPath = path

    try {
      const loadedSkills = await window.ipcRenderer.invoke('loadSkills', path)
      
      const skills: Skill[] = []
      this.skills.clear()

      for (const skillData of loadedSkills) {
        const content = skillData.preview?.content || ''
        const metadata = skillData.metadata || { 
          name: skillData.name, 
          description: skillData.description 
        }

        // 提取简短描述（兼容多种命名：short-description / short_description / shortDescription）
        const shortDescription =
          (typeof metadata.shortDescription === 'string' ? metadata.shortDescription : undefined) ||
          (typeof metadata.short_description === 'string' ? metadata.short_description : undefined) ||
          (typeof metadata['short-description'] === 'string' ? metadata['short-description'] : undefined) ||
          (metadata.metadata && typeof metadata.metadata === 'object'
            ? (typeof metadata.metadata['short-description'] === 'string'
              ? metadata.metadata['short-description']
              : undefined)
            : undefined)

        // 健康度检查（借鉴 OpenAI Codex parser.rs：name/description 是触发关键字段）
        if (!metadata.name) {
          console.warn(`[SkillManager] 技能 "${skillData.name}" 缺少 name 字段`)
        }
        if (!metadata.description) {
          console.warn(`[SkillManager] 技能 "${skillData.name}" 缺少 description 字段（Codex 要求必填用于触发）`)
        }

        const skill: Skill = {
          name: skillData.name,
          description: skillData.description,
          shortDescription: shortDescription || undefined,
          path: skillData.path,
          baseDir: skillData.path,
          metadata: metadata,
          content: content,
          body: this.parseSkillBody(content),
          files: skillData.preview?.files || [],
          fileCount: skillData.preview?.fileCount ?? (Array.isArray(skillData.preview?.files) ? skillData.preview.files.length : 0),
          promptVersion: skillData.promptVersion || this.computeContentHash(content),
          source: skillData.source || 'workspace',
          disabled: skillData.disabled || false
        }

        this.skills.set(skill.name, skill)
        skills.push(skill)
      }

      return skills
    } catch (error) {
      console.error('加载技能失败:', error)
      throw error
    } finally {
      this.loading = false
    }
  }

  // 刷新技能
  async refreshSkills(): Promise<Skill[]> {
    if (!this.skillsPath) {
      return []
    }
    return this.loadSkills(this.skillsPath)
  }

  // ==================== 阶段B：技能显式触发与调用追踪（借鉴 Codex） ====================

  // 解析输入中的 $skill-name 前缀（借鉴 Codex app-server 的 $skill 显式触发）
  // 仅当技能名已加载时识别，避免误拦截普通 $xxx 文本
  parseSkillMention(input: string): { skillName: string; rest: string } | null {
    const trimmed = (input || '').trim()
    const m = trimmed.match(/^\$([A-Za-z0-9_-]+)\b([\s\S]*)$/)
    if (!m) return null
    const skillName = m[1]
    if (!this.skills.has(skillName)) return null
    return { skillName, rest: (m[2] || '').trim() }
  }


  // 设置 agentskill 执行时可调用的工具集（null = 使用注册表默认；空数组 = 全部关闭）
  setEnabledTools(toolNames: string[] | null): void {
    this.enabledTools = toolNames === null ? null : new Set(toolNames)
  }



  async getSkillHelp(skillName: string): Promise<string> {
    const skill = this.skills.get(skillName)
    if (!skill) {
      return `技能 "${skillName}" 不存在`
    }

    const emoji = skill.metadata.emoji || ''
    let help = `${emoji ? emoji + ' ' : ''}# ${skill.name}\n\n`
    help += `**描述**: ${skill.description}\n\n`
    if (skill.shortDescription) {
      help += `**简短描述**: ${skill.shortDescription}\n\n`
    }
    help += `**来源**: ${skill.source}\n`
    help += `**技能文件夹路径**: ${this.skillsPath}\n\n`

    if (skill.metadata.version) {
      help += `**版本**: ${skill.metadata.version}\n`
    }
    if (skill.promptVersion) {
      help += `**内容版本**: \`${skill.promptVersion}\`\n`
    }
    if (skill.metadata.author) {
      help += `**作者**: ${skill.metadata.author}\n`
    }
    if (skill.metadata.homepage) {
      help += `**主页**: ${skill.metadata.homepage}\n`
    }
    if (skill.metadata.tags && skill.metadata.tags.length > 0) {
      help += `**标签**: ${skill.metadata.tags.join(', ')}\n`
    }

    help += '\n## 使用方法\n\n'
    help += `直接输入你的需求，系统会自动匹配并使用此技能。\n\n`

    // 前置条件展示
    const requires = skill.metadata.requires
    if (requires) {
      const reqParts: string[] = []
      if (requires.models && requires.models.length > 0) {
        reqParts.push(`模型: ${requires.models.join(', ')}`)
      }
      if (requires.bins && requires.bins.length > 0) {
        reqParts.push(`依赖命令: \`${requires.bins.join('`, `')}\``)
      }
      if (requires.anyBins && requires.anyBins.length > 0) {
        reqParts.push(`可选命令: \`${requires.anyBins.join('`, `')}\``)
      }
      if (requires.env && requires.env.length > 0) {
        reqParts.push(`环境变量: \`${requires.env.join('`, `')}\``)
      }
      if (requires.os && requires.os.length > 0) {
        reqParts.push(`操作系统: ${requires.os.join(', ')}`)
      }
      if (reqParts.length > 0) {
        help += `**前置条件**: ${reqParts.join(' | ')}\n\n`
      }
    }

    if (skill.files && skill.files.length > 0) {
      help += '\n## 技能文件夹包含的文件\n\n'
      // 受限展示：files 为主进程采样，只列前 N 个，防止超大型技能刷屏
      const MAX_FILES_SHOWN = 30
      const shown = skill.files.slice(0, MAX_FILES_SHOWN)
      const fileList = shown.map(file => {
        if (typeof file === 'string') {
          return `- ${file}`
        } else if (file && typeof file === 'object') {
          const fileName = (file as any).name || (file as any).path || JSON.stringify(file)
          return `- ${fileName}`
        }
        return `- ${String(file)}`
      }).join('\n')
      const total = skill.fileCount ?? skill.files.length
      help += fileList
      if (total > shown.length) {
        help += `\n…（共 ${total} 个文件，此处仅显示前 ${shown.length} 个，需要时用 read_file / list_dir 按路径读取）`
      }
      help +=
      help += fileList + '\n'
    }

    if (skill.body) {
      help += '\n## 技能说明\n\n'
      help += skill.body.substring(0, 500)
      if (skill.body.length > 500) {
        help += '...\n'
      }
    } else if (skill.content) {
      help += '\n## 技能说明\n\n'
      help += skill.content.substring(0, 500)
      if (skill.content.length > 500) {
        help += '...\n'
      }
    }

    return help
  }
}

// 创建单例
let skillManagerInstance: SkillManager | null = null

export function getSkillManager(store: any): SkillManager {
  if (!skillManagerInstance) {
    skillManagerInstance = new SkillManager(store)
  }
  return skillManagerInstance
}

export default {
  getSkillManager
}
