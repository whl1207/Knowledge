/**
 * skill-dev-guide.ts — 「技能设计师」参考正文（内置 MCP 服务 builtin-skill-dev 的内容来源）
 *
 * 为什么按话题拆：与 builtin-plugin-dev 同一套经验——一次只回几百到几千字，
 * 小模型也吃得下；模型按需取 `schema` / `writing` / `constraints` / `templates` / `faq`。
 *
 * 内容的三个来源：
 *  1. AI-KM 自己的技能实现（electron/main/skill-service.ts：SKILL.md + YAML frontmatter、
 *     目录名、`$name` 触发规则、`/` 相对路径约定、watcher 自动刷新）；
 *  2. Anthropic skill-creator 的写作方法（description 是唯一触发器、三层渐进披露、
 *     目录结构 references/scripts/assets、祈使句、示例格式、正文 < 500 行）；
 *  3. 本项目的真实翻车点（frontmatter 冒号、资源路径、重名、技能太重）。
 */

/** 工具话题（= MCP 工具名去掉 skill_dev_ 前缀） */
export type SkillDevTopic = 'schema' | 'writing' | 'constraints' | 'templates' | 'faq'

export interface SkillDevTopicSpec {
  topic: SkillDevTopic
  name: string
  description: string
  /** 是否带 key 参数（只有 templates 用） */
  keyParam?: boolean
}

export const SKILL_DEV_TOOL_SPECS: SkillDevTopicSpec[] = [
  {
    topic: 'schema',
    name: 'skill_dev_schema',
    description:
      '读取技能的**目录结构与 frontmatter 字段表**：SKILL.md 必填 / 可选字段（name / description / version / tags / emoji / requires…）、目录名与 name 的关系、resources 三种目录（references / scripts / assets）、`$技能名` 触发规则、资源引用为什么要用 `/` 开头、技能是如何被注入与加载的。动手写 SKILL.md 前先读这一条。',
  },
  {
    topic: 'writing',
    name: 'skill_dev_writing',
    description:
      '读取**写法指南**（决定技能好不好用）：description 怎么写才会被触发（写清"做什么 + 什么场景 + 用户会怎么说"，宁可主动一点）、三层渐进披露（metadata 常驻 → SKILL.md 正文按需 → 资源按需）、正文骨架（何时用 / 前置 / 步骤 / 输出格式 / 失败处理 / 检查清单）、祈使句与"讲原因而不是堆 MUST"、示例格式、多领域拆 references、正文 < 500 行。',
  },
  {
    topic: 'constraints',
    name: 'skill_dev_constraints',
    description:
      '读取**硬约束清单**（违反会导致技能装不上、不触发或读不到资源）：SKILL.md 与 frontmatter 必填项、目录名 = name、name 只能用 ASCII（`$` 触发）、UTF-8 编码、资源必须真实存在、引用路径写法、体积上限、不要写越权 / 恶意内容、依赖外部命令要在 requires 里声明、不要重复宿主已有技能。',
  },
  {
    topic: 'templates',
    name: 'skill_dev_templates',
    description:
      '读取**可直接照抄的模板**：minimal（最小技能全文）、playbook（多步骤流程型）、scripted（带 scripts/ 脚本）、reference（长参考拆 references/）。正文用 key 参数逐取；不带 key 时只返回模板目录与取用方式。',
    keyParam: true,
  },
  {
    topic: 'faq',
    name: 'skill_dev_faq',
    description:
      '读取**报错 / 现象对照表**：技能不触发、触发太频繁、`$技能名` 没反应、列表里看不到、读不到 references 里的文件、改了不生效、技能太重、重名覆盖、frontmatter 解析失败（YAML 冒号）等，每条给出原因与改法。',
  },
]

export const SKILL_DEV_TEMPLATE_KEYS = ['minimal', 'playbook', 'scripted', 'reference'] as const
export type SkillDevTemplateKey = (typeof SKILL_DEV_TEMPLATE_KEYS)[number]

export const SKILL_DEV_MCP_ID = 'builtin-skill-dev'

const BASE_DIR_PLACEHOLDER = '<技能目录>/<技能名>'

function schemaZh(): string {
  return [
    '【技能：目录结构与 frontmatter】',
    '',
    '一个技能 = 一个目录，目录里必须有 SKILL.md：',
    `${BASE_DIR_PLACEHOLDER}/`,
    '├── SKILL.md            （必需：YAML frontmatter + Markdown 操作手册）',
    '├── references/*.md     （可选：长文档，按需 read_file 读取）',
    '├── scripts/*           （可选：可执行脚本，正文说明怎么跑）',
    '└── assets/*            （可选：输出用模板 / 图标 / 字体）',
    '',
    'frontmatter（SKILL.md 开头的 `---` 之间，YAML）：',
    '- name：**必填**，技能标识；只能用 `[A-Za-z0-9_-]`（`$name` 触发与 skill 工具都按这个名字找它），建议全小写短横线，且**与目录名一致**。',
    '- description：**必填**，一行说清"做什么 + 什么时候用"。它是**唯一的自动触发依据**（技能目录里只注入 name + description），"何时用"必须写在这里，不要只写在正文。',
    '- 可选：version / author / tags（字符串数组）/ emoji / homepage / always（true = 每轮都注入，慎用）/ requires（bins / anyBins / env / config / models / os）/ install（安装说明）。',
    '- 不认识的大写字段会被忽略；拼错字段名会让技能丢元数据（用 skill_dev_check 可查出来）。',
    '',
    '正文（frontmatter 之后）：模型的**操作手册**，不是给人看的介绍。建议顺序：何时用 → 前置检查 → 步骤 → 输出格式 → 失败处理 → 检查清单。',
    '',
    '资源引用约定：',
    '- 正文里用 **以 `/` 开头的相对路径**指向技能目录内的文件，例如 `/references/schema.md`、`/scripts/build.py`；运行时模型会拼成技能目录的绝对路径去读。',
    '- 不要把资源写成绝对路径（换机器就废），也不要写不存在的文件（skill_dev_check 会逐个核对）。',
    '',
    '技能怎么被用起来：',
    '1. 系统提示里只放技能目录（name + description + 简短描述），不注入正文；',
    '2. 模型判断需要时，用 read_file 读 `<技能目录>/SKILL.md` 再照着做；',
    '3. 用户在聊天里输入 `$技能名` 可显式触发（名字必须是 `[A-Za-z0-9_-]`）；',
    '4. 预设「技能」页勾选后，该预设在系统提示里带上技能库清单。',
    '',
    '加载与刷新：技能目录内的文件变化会被自动监听（约 400ms 防抖），设置页「技能 → 管理」也有刷新按钮；新技能不需要重启。',
  ].join('\n')
}

function writingZh(): string {
  return [
    '【技能：写法指南（决定好不好用）】',
    '',
    '0. 先想清楚三件事：这个技能让 AI 做什么、用户会怎么开口、交付物长什么样。三件事不清楚就先问，不要动笔。',
    '',
    '1. description 是唯一触发器，值得反复打磨：',
    '   - 写"做什么 + 什么场景 + 用户可能的说法"，把关键触发词写进去；',
    '   - 模型常见的问题是**不触发**，所以描述可以比日常语气**主动一点**（例如"凡是涉及 X、Y、Z 的请求都用这个技能，即使用户没有明确说 X"）；',
    '   - 不要写成"当用户需要时使用"这种没有信息的句子；也不要过长（一行到两行，建议 ≤ 300 字）。',
    '',
    '2. 三层渐进披露（决定上下文成本）：',
    '   - 第一层：frontmatter 的 name + description（常驻系统提示，约 100 字）；',
    '   - 第二层：SKILL.md 正文（命中后才读，建议 < 500 行 / < 8000 字符）；',
    '   - 第三层：references / scripts / assets（真的需要时才读，不限量）。',
    '   推论：正文里只留"必须马上知道的流程"，长清单、领域知识、大表格拆进 references/，并在正文写清"什么时候去读哪个文件"。',
    '',
    '3. 正文骨架（按需删减，但顺序别乱）：',
    '   ## 何时使用        —— 与 description 呼应，给出 2~3 个典型请求',
    '   ## 前置检查        —— 需要哪些文件 / 参数 / 工具，缺了怎么办',
    '   ## 步骤            —— 编号步骤，每步说清"做什么 + 怎么判断做对了"',
    '   ## 输出格式        —— 直接给可复制的模板（标题层级 / 表格列 / 文件名约定）',
    '   ## 失败处理        —— 常见失败与替代路径（不要只说"重试"）',
    '   ## 检查清单        —— 交付前逐条自检（3~6 条）',
    '',
    '4. 写法：',
    '   - 祈使句（"读取…""先确认…"），不要写"你可以考虑…"这类模糊语气；',
    '   - 解释**为什么**这样做，比堆 MUST 更能让模型迁移到新情况；',
    '   - 给例子比给形容词有效：输入 → 输出成对写；',
    '   - 提到工具就写清工具名与参数要点（并确认该工具真的在当前工具白名单里）；',
    '   - 需要运行脚本时，写清命令、工作目录、预期输出。',
    '',
    '5. 反模式（写出来一定不好用）：',
    '   - 整篇是角色设定（"你是一位资深专家"）而没有流程；',
    '   - 把几十页参考资料塞进正文；',
    '   - 依赖宿主不存在的能力 / 工具；',
    '   - 只写一句"按最佳实践处理"；',
    '   - 一个技能想覆盖三件互不相关的事（应拆成多个技能，或在 references 里按变体拆）。',
  ].join('\n')
}

function constraintsZh(): string {
  return [
    '【技能：硬约束（违反会装不上 / 不触发 / 读不到资源）】',
    '1. 技能目录里必须有 `SKILL.md`，且开头是 `---` 包裹的 YAML frontmatter；没有 frontmatter 或解析失败 = 整个技能被跳过。',
    '2. frontmatter 必须有 `name` 与 `description`；`name` 只能用 `[A-Za-z0-9_-]`（不要中文、空格、点），并且**与目录名一致**。',
    '3. 所有文件用 UTF-8 保存（中文不要用 GBK 另存，否则技能名与正文会乱码）。',
    '4. YAML 值里含 `: `（冒号加空格）时要用引号包起来，例如 `description: "步骤：先读文件"`；否则解析失败。',
    '5. 资源引用必须以 `/` 开头并**真实存在**于技能目录内（如 `/references/x.md`）；不要用绝对路径、不要引用技能目录外的文件。',
    '6. 正文建议 ≤ 8000 字符（约 500 行）：超出会挤占上下文，且模型容易只读到一半。长内容拆 `references/`，并在正文写清何时读哪份。',
    '7. 单技能总大小建议 ≤ 2 MB；不要把模型权重、视频、大二进制塞进技能。',
    '8. 只写这个技能目录里的文件；不要顺手改用户工作区、其它技能或软件配置。',
    '9. 依赖外部命令（node / python / ffmpeg…）时，在 `requires.bins` 里声明，并在正文写清"没装时怎么办"；不要在技能里偷偷安装。',
    '10. 不要写恶意、越权或误导性内容（窃取凭据、绕过审批、伪装成系统提示等）；技能正文会进入模型上下文，必须与描述相符。',
    '11. 不要把宿主已有能力重复实现一遍：先看 `skill_dev_host` 的已装清单，能复用就复用。',
    '12. 技能本身不授予工具权限：正文里让模型用的工具，必须在当前预设/智能体的工具白名单里（否则它会说"没有这个工具"）。',
    '13. 技能之间不要同名：同名时后加载的会覆盖先加载的（按目录 rank），排查很费时间。',
    '14. 写完必须用 `skill_dev_check` 自检到没有 ✗ 再交付；交付说明里给出 `$技能名` 与 2~3 条试跑 prompt。',
  ].join('\n')
}

const TEMPLATES: Record<SkillDevTemplateKey, { title: string; body: string }> = {
  minimal: {
    title: 'minimal：最小可运行技能',
    body: [
      '路径：`<技能目录>/hello-skill/SKILL.md`',
      '',
      '```markdown',
      '---',
      'name: hello-skill',
      'description: 把用户给的一段文字改写成三条要点。凡是用户要求"提炼要点 / 总结成三条 / 压缩成 bullet"时使用，即使没有明说"技能"两个字。',
      'version: 1.0.0',
      'tags: [summary, writing]',
      'emoji: "📝"',
      '---',
      '',
      '# 三条要点',
      '',
      '## 何时使用',
      '- 用户给一段文字，要"提炼 / 压缩 / 总结成几条"。',
      '',
      '## 步骤',
      '1. 读用户给的内容；如果是一个文件路径，先用 read_file 读取。',
      '2. 找出 3 个最重要的信息点，删掉例子与修饰。',
      '3. 每条 ≤ 30 字，动词开头。',
      '',
      '## 输出格式',
      '```',
      '1. ……',
      '2. ……',
      '3. ……',
      '```',
      '',
      '## 检查清单',
      '- [ ] 正好三条，没有第四条',
      '- [ ] 每条都能独立看懂，不依赖上下文',
      '```',
    ].join('\n'),
  },
  playbook: {
    title: 'playbook：多步骤流程型',
    body: [
      '适合"每次都要按同一套流程做"的任务（评审、发布、排障、周报）。骨架：',
      '',
      '```markdown',
      '---',
      'name: release-check',
      'description: 发布前按清单核对版本号、变更日志、构建与产物。用户提到"发版 / 发布 / release / 打 tag"时使用。',
      '---',
      '',
      '# 发布前检查',
      '',
      '## 何时使用',
      '- 用户说"准备发版""帮我检查一下能不能发"。',
      '',
      '## 前置检查',
      '- 确认当前分支与工作区是否干净（有未提交改动先问用户）。',
      '',
      '## 步骤',
      '1. 读 package.json 的 version，与最近一次 CHANGELOG 的标题核对。',
      '2. 跑构建命令；失败就修到通过，不要跳过。',
      '3. 检查产物目录里是否包含说明里承诺的文件。',
      '4. 汇总：能发 / 不能发 + 阻塞项。',
      '',
      '## 输出格式',
      '| 检查项 | 结果 | 证据 |',
      '| --- | --- | --- |',
      '',
      '## 失败处理',
      '- 构建失败：贴出前 20 行错误，按错误类型给出下一步（依赖 / 类型 / 测试）。',
      '',
      '## 检查清单',
      '- [ ] 版本号一致',
      '- [ ] 构建通过',
      '- [ ] 产物齐全',
      '```',
    ].join('\n'),
  },
  scripted: {
    title: 'scripted：带 scripts/ 的技能',
    body: [
      '目录：',
      '```',
      'csv-report/',
      '├── SKILL.md',
      '└── scripts/',
      '    └── summarize.py',
      '```',
      '',
      'SKILL.md 里必须写清脚本怎么跑（命令、参数、cwd、预期输出），并给出失败处理：',
      '',
      '```markdown',
      '---',
      'name: csv-report',
      'description: 把 CSV 汇总成按列统计的 Markdown 报告。用户给 .csv 并要求"统计 / 汇总 / 出一份报告"时使用。',
      'requires:',
      '  bins: [python]',
      '---',
      '',
      '## 步骤',
      '1. 用 read_file 看一眼表头，确认编码与分隔符。',
      '2. 运行：`python /scripts/summarize.py <csv 绝对路径>`（工作目录 = 技能目录）。',
      '3. 把脚本输出的 Markdown 原样返回给用户；脚本报错就把 stderr 前 10 行贴给用户并说明原因。',
      '',
      '## 失败处理',
      '- 缺 python：告诉用户需要安装 Python 3，并给出替代方案（用 run_python 工具手工统计）。',
      '```',
    ].join('\n'),
  },
  reference: {
    title: 'reference：长参考拆 references/',
    body: [
      '目录：',
      '```',
      'cloud-deploy/',
      '├── SKILL.md',
      '└── references/',
      '    ├── aws.md',
      '    ├── gcp.md',
      '    └── azure.md',
      '```',
      '',
      '正文只做选择与索引，细节留给 references（模型只读需要的那一份）：',
      '',
      '```markdown',
      '---',
      'name: cloud-deploy',
      'description: 把服务部署到云平台。用户提到"部署 / deploy / 上线到 AWS、GCP、Azure"时使用。',
      '---',
      '',
      '## 步骤',
      '1. 先问/确认目标平台。',
      '2. 读对应的参考文件并按其步骤执行：',
      '   - AWS：`/references/aws.md`',
      '   - GCP：`/references/gcp.md`',
      '   - Azure：`/references/azure.md`',
      '3. 只读与本次平台相关的那一份，不要全读。',
      '```',
    ].join('\n'),
  },
}

function templatesZh(key?: string): string {
  const k = String(key || '').trim()
  if (k && (SKILL_DEV_TEMPLATE_KEYS as readonly string[]).includes(k)) {
    const t = TEMPLATES[k as SkillDevTemplateKey]
    return `【模板：${t.title}】\n\n${t.body}`
  }
  return [
    '【技能模板目录】用 key 参数取正文（一次取一个）：',
    ...SKILL_DEV_TEMPLATE_KEYS.map((key) => `- ${key}：${TEMPLATES[key].title}`),
    '',
    '建议：新技能从 minimal 起步，跑通后再按 playbook / scripted / reference 加结构。',
  ].join('\n')
}

function faqZh(): string {
  return [
    '【技能：现象 → 原因 → 改法】',
    '1. 技能**不触发**：description 写得太泛或没写场景。→ 把"用户会怎么说"的关键词写进 description，并主动一点（"凡是提到 X/Y/Z 都用这个技能"）；正文放正文，触发信息只放 description。',
    '2. 技能**触发太频繁**：description 里的词太宽（如"写任何文档"）。→ 收窄到具体任务与交付物。',
    '3. 输入 `$技能名` 没反应：name 含中文 / 空格 / 点号。→ 改成 `[A-Za-z0-9_-]`（目录名一起改），或改用预设勾选 / 让模型自己读 SKILL.md。',
    '4. 技能列表里**看不到**：目录里没有 SKILL.md，或 frontmatter 解析失败（最常见：值里有 `: ` 没加引号）、缺 name。→ 跑 `skill_dev_check`，按报错改 YAML。',
    '5. 读不到 `/references/xxx.md`：文件不存在 / 大小写不一致 / 用了绝对路径。→ 正文改成 `/references/...`，并确认目录里真的有这个文件（check 会逐个核对）。',
    '6. 改了技能**不生效**：目录监听有约 400ms 防抖；跨窗口/远程目录可能不触发。→ 在「设置 → 技能 → 管理」点刷新；确认当前 `skillsPath` 就是技能所在目录（`skill_dev_host` 可看）。',
    '7. 技能**太重**、模型读了半天：正文超过 ~8000 字符或塞了大量参考资料。→ 正文只留流程，长内容拆 `references/`，并在正文写清何时读哪份。',
    '8. **重名**覆盖：两个目录的 frontmatter `name` 相同。→ 先看 `skill_dev_host` 的已装清单，换一个唯一名字。',
    '9. 技能里写的能力**用不了**：提到的工具不在当前预设的工具白名单里，或依赖的命令没装。→ 先确认工具清单；外部命令写进 `requires.bins` 并在正文给替代方案。',
    '10. frontmatter 报 YAML 错：缩进不齐、列表写法混用（`- a` 与 `[a, b]`）、中文冒号。→ 统一缩进 2 空格，值含特殊符号就加引号。',
  ].join('\n')
}

/** 取某个话题正文（key 只对 templates 生效） */
export function skillDevTopic(topic: SkillDevTopic | string, key = ''): string {
  switch (topic) {
    case 'schema': return schemaZh()
    case 'writing': return writingZh()
    case 'constraints': return constraintsZh()
    case 'templates': return templatesZh(key)
    case 'faq': return faqZh()
    default: return `未知话题：${topic}（可用：${SKILL_DEV_TOOL_SPECS.map((t) => t.topic).join(' / ')}）`
  }
}
