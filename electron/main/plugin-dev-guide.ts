/**
 * plugin-dev-guide.ts — 插件开发参考的正文组装（内置 MCP 服务 `builtin-plugin-dev` 的内容来源）
 *
 * 为什么需要它：插件开发预设原先要求模型先读 `src/types/plugin.ts` / `src/lib/plugin/devGuide.ts`
 * 这类路径来核对 API，但那是**开发仓库**里的路径——装机后的软件里没有源码，于是模型会满盘
 * read_file / search_files / 跑 shell 去找「AI-KM 装在哪」（用户看到的就是一串无意义搜索）。
 * 这里把官方指南（devGuide.ts 的同一份数据 + 运行时信息）交给模型，离线、不依赖磁盘源码。
 *
 * 为什么按主题拆成多个话题而不是一个「返回全部」的工具：体量小的模型吃不下一次几千字，
 * 而且一次灌太多反而抓不住重点。因此每个话题都是一个独立的小工具（见 PLUGIN_DEV_TOOL_SPECS），
 * 单次只回 500～4000 字；需要更多时模型再自己取下一个话题。
 *
 * 单一事实源：约束 / 清单字段 / 宿主 API / 最小示例 / 常见问题 / 模板全部取自
 * `src/lib/plugin/devGuide.ts`（「设置 → 插件 → 开发」页展示的同一份内容），槽位取自
 * `src/shared/pluginSlots.ts`，运行态取自 plugin-host。
 *
 * 话题的**分桶依据是事实的 `topic` 字段**（devGuide 的 PLUGIN_DEV_FACTS），不在本文件里手写
 * 成员名单：早先本文件按「事实名里有没有『主进程半边：』前缀」过滤，界面半边的能力一多就把
 * `api` 话题顶到 6003 字（超过 6000 字的工具结果截断阈值），而漏掉的那条又没有归属。现在
 * 「一条事实只属于一个话题」是类型必填字段，自测再断言不漏不重。
 */

import { PLUGIN_HOST_API_VERSION } from '@/types/plugin'
import { CORE_PLUGIN_SLOTS } from '@/shared/pluginSlots'
import { SUPPORTED_PLUGIN_PERMISSIONS } from '@/shared/pluginManifest'
import {
  CONSTRAINTS_ZH,
  PLUGIN_DEV_FAQ,
  PLUGIN_DEV_FACTS,
  PLUGIN_DEV_MINIMAL_MAIN_ZH,
  PLUGIN_DEV_MINIMAL_ZH,
  PLUGIN_DEV_SECTIONS,
  PLUGIN_DEV_USAGE_ZH,
  type PluginDevFactTopic,
} from '@/lib/plugin/devGuide'
import { pluginHost } from './plugin-host'

/** 话题名（= MCP 工具名去掉 plugin_dev_ 前缀） */
export const PLUGIN_DEV_TOPICS = ['host', 'constraints', 'manifest', 'api', 'api-caps', 'api-main', 'faq', 'templates'] as const
export type PluginDevTopic = (typeof PLUGIN_DEV_TOPICS)[number]

/** 模板话题可单独取用的小节（key 与 devGuide 的 PLUGIN_DEV_SECTIONS 一致） */
export const PLUGIN_DEV_TEMPLATE_KEYS = ['general', 'panel', 'settings', 'chart', 'tool', 'llm-files', 'image', 'fix', 'minimal', 'usage', 'all'] as const

/** 按话题取速查表行（`topic` 是 devGuide 里每条事实的必填字段：一条事实只进一个话题） */
function factLines(topic: PluginDevFactTopic): string {
  return PLUGIN_DEV_FACTS.filter((f) => f.topic === topic)
    .map((f) => `- ${f.name}\n  ${f.descZh}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// 各话题正文
// ---------------------------------------------------------------------------

/** 本机运行态：模型必须知道往哪写插件、现在装了哪些、数据该放哪 */
export function topicHost(): string {
  const lines: string[] = ['【本机运行态（由软件实时给出，可直接使用）】']
  const custom = pluginHost.hasCustomRoot()
  lines.push(`- 插件目录（绝对路径，插件文件夹就建在这里面）：${pluginHost.rootDir()}`)
  lines.push(`- 上面这个是${custom ? '用户在设置里自定义的目录' : '默认目录（userData/plugins）'}；写出插件文件夹后让用户在「设置 → 插件 → 管理」点「重新扫描」即可发现，不必重启软件。`)
  lines.push('- **插件文件夹命名（动手前先定好，否则要改名返工）**：文件夹名必须等于清单里的 aikm.id，且只能是 ASCII 小写——以 [a-z0-9] 开头、只含 `[a-z0-9._-]`（例：my-plugin）。文件夹名带中文 / 大写 / 空格时宿主会**整目录跳过**（插件根本不会出现在列表里），只能改名重来。中文写在清单 aikm.name（显示名）与界面文案里。')
  const skipped = pluginHost.invalidNamedDirs()
  if (skipped.length) {
    lines.push(`- ⚠ 当前有 ${skipped.length} 个文件夹因目录名不能作为插件 id 被跳过（有清单但名字非法）：${skipped.join('、')}——需要改成 ASCII 名字才会被识别。`)
  }
  lines.push(`- 宿主插件 API 版本：${PLUGIN_HOST_API_VERSION}（清单里写 apiVersion: "^1"）`)
  lines.push(`- 可申请的权限：${SUPPORTED_PLUGIN_PERMISSIONS.join(' / ')}（不申请就用不了对应能力；多申请会让用户多一层顾虑）`)
  const plugins = pluginHost.list()
  lines.push(`- 当前已装插件：${plugins.length ? plugins.map((p) => `${p.name || p.id}(${p.id}, ${p.status})`).join('、') : '无'}`)
  lines.push('- 数据放哪：「设置 → 插件 → 数据」按约定统计，请照做：设置 / 结构小的数据放 localStorage，键名以 `aikm.plugin.<插件 id>.` 开头；图片、存档等大文件放本机 OPFS 的 `plugins/<插件 id>/`；主进程半边用 ctx.storage（落在 `userData/plugins-data/<插件 id>/storage.json`）。')
  lines.push('- 写插件所需的全部资料就在本服务这几条工具里（另有「设置 → 插件 → 开发」页的可复制模板），不要去磁盘上找 AI-KM 的源码或安装目录：装机版没有 `src/`，找不到。')
  return lines.join('\n')
}

/** 硬性约束（违反就加载失败 / 界面出错，逐条必须遵守） */
export function topicConstraints(): string {
  return CONSTRAINTS_ZH
}

/** package.json 的 aikm 清单字段 + 内置槽位 + 可直接照抄的完整示例 */
export function topicManifest(): string {
  const facts = factLines('manifest')
  const slots = CORE_PLUGIN_SLOTS.map((s) => `- ${s.name}（${s.kind}）：${s.desc}`).join('\n')
  return [
    '【package.json 的 aikm 清单字段】',
    facts,
    '',
    '【可直接照抄的最小清单（只用界面半边）】',
    '{',
    '  "name": "my-plugin",',
    '  "version": "1.0.0",',
    '  "aikm": {',
    '    "id": "my-plugin",',
    '    "name": "我的插件",',
    '    "version": "1.0.0",',
    '    "apiVersion": "^1",',
    '    "client": { "entry": "client.mjs" },',
    '    "declares": { "slots": ["panel.main"] }',
    '  }',
    '}',
    '（id 必须等于插件目录名，且只能是 ASCII 小写 [a-z0-9._-]（目录名带中文会被宿主直接跳过）；name 是显示名，可用中文；version 形如 1.0.0；apiVersion 是**字符串** "^1"。）',
    '',
    '【内置槽位（declares.slots 只能填这些，未知槽位会被拒绝）】',
    slots,
    '',
    '【改清单时最容易写错的五点（宿主会直接拒绝或加载失败）】',
    '1. apiVersion 必须写字符串 "^1"（写数字 2 会被判定为「要求宿主 API 2，当前 1」而拒绝；写 1 会按 "1" 处理）。',
    '2. 槽位写进 declares.slots —— **不要**写进 inject：inject 只放宿主**服务名**（如 ["tools"]），写槽位会被直接驳回。',
    '3. 声明了 main 就必须真的有那个文件：只写界面半边就**不要**写 main（否则报「入口文件不存在：index.mjs」）。',
    '4. 用到的权限（fs / shell / net / agent / agent.run / llm / image）必须写进 permissions，否则调用时抛错；**不使用就不要申请**（启用时会把它们列给用户确认）。',
    '5. 用了 ctx.fs / ctx.llm / ctx.image / ctx.agent.run / ctx.host.runShell / ctx.host.fetch / ctx.host.sessions，就必须声明对应的 fs / llm / image / agent.run / shell / net / agent；plugin_dev_check 会做这条交叉校验。',
  ].join('\n')
}

/**
 * 宿主 API 速查 —— **界面半边基础**（UI 贡献与通用服务；纯名表，不含示例）。
 *
 * 两次瘦身 / 一次拆分的记录（都为了 plugin-smoke 的「单次不超过话题预算」——预算数由
 * `src/shared/toolResultBudget.ts` 的截断阈值推导，见 smoke.mts 的 topicCharBudget）：
 *  1. 按半边拆成 `api` / `api-main` —— 两半边的 ctx 串用是本项目最常见的错法，拆开各读各的；
 *  2. 示例再挪去 `plugin_dev_templates {key:"minimal"}` —— 示例本来就是"可照抄的正文"；
 *  3. 界面半边的**能力**（fs / llm / agents / image / tts）再拆到 `api-caps`：加完生图后
 *     `api` 到了 6003 字（上限 6000），再多一条事实中段就会被裁掉。拆分不靠手写名单，
 *     而是读事实上的 `topic` 字段（见 devGuide 的 PluginDevFactTopic）。
 */
export function topicApi(): string {
  return [
    '【宿主 API 速查 · 界面半边基础（client.mjs；照抄名字，不要臆造）】',
    '（文件 / 模型 / 委派 / 生图 / 语音这些**能力**在 `plugin_dev_api_caps`；主进程半边 index.mjs 在 `plugin_dev_api_main`）',
    factLines('api'),
    '',
    '最小可运行示例（package.json + client.mjs 全文）：取 `plugin_dev_templates` 的 key="minimal"。',
  ].join('\n')
}

/** 宿主 API 速查 —— **界面半边能力**（文件 / 模型 / 委派 / 生图 / 语音） */
export function topicApiCaps(): string {
  return [
    '【宿主 API 速查 · 界面半边能力（client.mjs）】',
    '（界面贡献与通用服务在 `plugin_dev_api`；主进程半边在 `plugin_dev_api_main`）',
    '先用 available / reason 判断可用性，再调用；**清单 permissions 里声明了才给实现**：fs / llm / image / agent.run。',
    '',
    factLines('api-caps'),
    '',
    '可照抄的完整示例：文件 + 大模型见 `plugin_dev_templates` 的 key="llm-files"，生图见 key="image"。',
  ].join('\n')
}

/** 宿主 API 速查 —— **主进程半边**（名表 + 一段最小示例，主半边事实表很短，留得下） */
export function topicApiMain(): string {
  return [
    '【宿主 API 速查 · 主进程半边（index.mjs；照抄名字，不要臆造）】',
    '（界面半边在 `plugin_dev_api` 与 `plugin_dev_api_caps`，两半边的 ctx 不能混用）',
    '文件能力（ctx.fs）两个半边同形状 —— 成员表在 `plugin_dev_api_caps`，这里不重复。',
    factLines('api-main'),
    '',
    '【主进程半边最小可运行示例（注册一个工具给智能体用）】',
    PLUGIN_DEV_MINIMAL_MAIN_ZH,
  ].join('\n')
}

/** 常见问题（报错 → 原因 → 处理） */
export function topicFaq(): string {
  const body = PLUGIN_DEV_FAQ.map((f) => `Q：${f.qZh}\nA：${f.aZh}`).join('\n\n')
  return ['【常见问题】', '', body].join('\n')
}

/**
 * 模板话题：不带 key 时只给**模板目录 + 安装/调试步骤**（小模型友好），
 * 传 key 才返回那一个模板的正文。
 */
export function topicTemplates(key?: string): string {
  const k = String(key || '').trim().toLowerCase()
  if (!k) {
    const index = PLUGIN_DEV_SECTIONS.map((s) => `- ${s.key}：${s.titleZh}\n  ${s.descZh}`).join('\n')
    return [
      '【可照抄的开发模板（用 plugin_dev_templates 的 key 参数取正文，一次只取一个）】',
      index,
      '- minimal：最小可运行示例（package.json + client.mjs 全文，第一次写插件从它开始）',
      '- usage：安装、启用与调试步骤',
      '',
      topicUsage(),
    ].join('\n')
  }
  if (k === 'usage') return topicUsage()
  // 示例原在 plugin_dev_api 话题里；因界面半边事实表本身 ≈4000 字、话题预算见上，挪到这里
  if (k === 'minimal') {
    return [
      '【最小可运行示例（目录 + package.json + client.mjs；照抄即可跑）】',
      PLUGIN_DEV_MINIMAL_ZH,
    ].join('\n')
  }
  if (k === 'all') {
    const all = PLUGIN_DEV_SECTIONS.map((s) => `### ${s.titleZh}（key: ${s.key}）\n（${s.descZh}）\n\n${s.bodyZh}`).join('\n\n---\n\n')
    return ['【全部开发模板】', '', all, '', topicUsage()].join('\n')
  }
  const section = PLUGIN_DEV_SECTIONS.find((s) => s.key === k)
  if (!section) {
    const keys = [...PLUGIN_DEV_SECTIONS.map((s) => s.key), 'minimal', 'usage', 'all'].join(' / ')
    return `没有叫「${k}」的模板。可用 key：${keys}`
  }
  return [`### ${section.titleZh}（key: ${section.key}）`, `（${section.descZh}）`, '', section.bodyZh].join('\n')
}

/** 安装、启用与调试步骤 */
export function topicUsage(): string {
  return ['【安装、启用与调试步骤】', '', PLUGIN_DEV_USAGE_ZH].join('\n')
}

/** 取某个话题的正文（容错：未知话题给 host 的提示） */
export function pluginDevTopic(topic: string, arg?: string): string {
  switch (String(topic || '').trim().toLowerCase()) {
    case 'host': return topicHost()
    case 'constraints': return topicConstraints()
    case 'manifest': return topicManifest()
    case 'api': return topicApi()
    case 'api-caps': return topicApiCaps()
    case 'api-main': return topicApiMain()
    case 'faq': return topicFaq()
    case 'templates': return topicTemplates(arg)
    default: return `未知话题「${topic}」。可用：${PLUGIN_DEV_TOPICS.join(' / ')}`
  }
}

// ---------------------------------------------------------------------------
// MCP 工具声明（服务层直接读这张表生成工具清单）
// ---------------------------------------------------------------------------

export interface PluginDevToolSpec {
  /** MCP 工具名 */
  name: string
  /** 对应话题（自检工具没有话题，走 dir 参数） */
  topic?: PluginDevTopic
  /** 面向模型的一句话说明（进工具 schema） */
  description: string
  /** 是否接受 key 参数（仅 templates 有） */
  keyParam?: boolean
  /** 是否接受 dir 参数（仅 check 有） */
  dirParam?: boolean
}

/** 各工具的一句话说明（只讲「这条能拿到什么」，通用告诫不放这里，避免 9 条重复占 schema） */
export const PLUGIN_DEV_TOOL_SPECS: readonly PluginDevToolSpec[] = [
  {
    name: 'plugin_dev_host',
    topic: 'host',
    description: '读取本机插件运行态：插件目录的绝对路径、**插件文件夹命名规则（必须等于清单 id 且只能用 ASCII 小写 [a-z0-9._-]，中文目录名会被宿主整目录跳过）**、是默认目录还是自定义目录、已装插件清单、宿主插件 API 版本、可申请的权限（fs / shell / net / agent / agent.run / llm / image）、插件数据该放在哪。写插件前先取它，就知道该把文件夹建成什么名字、放在哪里。',
  },
  {
    name: 'plugin_dev_constraints',
    topic: 'constraints',
    description: '读取插件开发的硬性约束（15 条，违反会加载失败或界面出错）：目录名＝id 且只能用 ASCII 小写（中文 / 大写 / 空格会被整目录跳过，要返工改名的就是这一条）、清单必填字段、可用槽位与权限（含 fs 只能读用户在插件里选过的路径）、界面半边必须单文件 ESM 无 import、**只准调用指南列出的宿主 API（界面 / 主进程两半边不能混用；ctx.service / ctx.mcp / ctx.files.readFile 都不存在）**、**两套失败形态（ctx.fs 抛 FS_* 错误码；ctx.image / ctx.llm.stream / ctx.agents 不抛，看 ok / finish / termination）**、**用到的能力必须写进 permissions**、canvas 2D 不认 CSS 变量、Vue 由 ctx.vue 注入、副作用必须可清理、主题变量与滚动样式、面板不能撑大窗口等。动手写第一个文件之前必读。',
  },
  {
    name: 'plugin_dev_manifest',
    topic: 'manifest',
    description: '读取 package.json 里 aikm 清单的全部字段（id / name / version / apiVersion / main / client.entry / inject / permissions / declares.tools / declares.slots）与五个内置槽位的用途。写清单时取这一条。',
  },
  {
    name: 'plugin_dev_api',
    topic: 'api',
    description: '读取**界面半边基础**（client.mjs）的宿主 API 速查：plugin / config / vue / locale / slots / shortcuts / app / on / effect / notify / log 与界面半边的最小可运行示例（package.json + client.mjs 全文）。写界面（面板 / 设置页签）时取这一条；文件 / 模型 / 委派 / 生图 / 语音这些**能力**在 plugin_dev_api_caps，主进程半边取 plugin_dev_api_main（两半边 ctx 不能混用）。',
  },
  {
    name: 'plugin_dev_api_caps',
    topic: 'api-caps',
    description: '读取**界面半边能力**的宿主 API 速查：ctx.fs（文件读写 / 版本 / 字面量编辑）、ctx.files（选择框与预览）、ctx.llm（chat + stream + schema）、ctx.agent / ctx.agents（委派）、ctx.image（生图）、ctx.tts（语音），含各自的权限（fs / llm / agent.run / image）、失败形态（抛 FS_* 还是返回 ok=false）与可用性判断。要读写文件、调大模型、委派智能体或生图时取这一条；界面贡献在 plugin_dev_api，主进程半边在 plugin_dev_api_main。',
  },
  {
    name: 'plugin_dev_api_main',
    topic: 'api-main',
    description: '读取**主进程半边**（index.mjs）的宿主 API 速查（tool / service / getService / storage.get|set|delete|keys / on 观测事件 / host：readFile / writeFile / listDir / granted.* / runShell / fetch / sessions.list / notify，以及同形状的 ctx.fs）以及主进程半边的最小可运行示例（清单里的 main / inject / declares.tools 与一段注册工具的 index.mjs 全文），并说明"与宿主同进程、不受工作区沙箱约束""工具名必须带前缀""handler 必须返回 { ok, value?, error? }"。写工具 / 后台能力时取这一条。',
  },
  {
    name: 'plugin_dev_faq',
    topic: 'faq',
    description: '读取插件开发常见问题对照（装载失败、槽位未声明、权限报错、ctx.fs 的 FS_* 错误码与并发写冲突、ok=false 被当成成功、深色主题白底白字、面板被挤扁或撑大窗口、改动何时生效等）。插件报错时先用它对照。',
  },
  {
    name: 'plugin_dev_templates',
    topic: 'templates',
    keyParam: true,
    description: '读取可照抄的开发模板目录与「安装、启用、调试步骤」。默认只回目录（很短）；要正文时传 key，一次取一个：minimal（最小可运行示例：目录 + package.json + client.mjs 全文，第一次写插件从它开始）、general（通用开发指令）、panel（界面插件：面板 + 设置页签 + 快捷键）、settings（设置页签 / 设置卡片：配置项放进「设置 → 插件」，含分组与设置页 id 清单、完整设置组件骨架）、chart（图表面板：canvas 饼图 / 柱状图 + 数据变化重画）、tool（给智能体加工具）、llm-files（大模型 + 文件能力：ctx.fs / stream / schema）、image（生图面板：ctx.image 的可运行示例）、fix（排障指令）、usage（安装步骤）、all（全部，较长）。',
  },
  {
    name: 'plugin_dev_check',
    dirParam: true,
    description: '自检一个插件文件夹（交付前必跑）：检查目录名能否作为插件 id（中文 / 大写 / 空格会被宿主跳过）、用宿主**同一份**校验逻辑检查 package.json 清单（字段类型 / apiVersion / 槽位声明 / 权限）、声明的入口文件是否存在，并静态检查两个半边：界面半边（是否含 import/require、是否用了 template、是否导出 apply(ctx)、是否调用 ctx.slots.register、生命周期钩子是否在 setup 里）、**是否用了宿主不存在的 ctx 成员**（如 ctx.service / ctx.mcp / ctx.files.readFile 会逐条报「宿主没有这个」并给出正确做法；两半边 ctx 串用也会报）、**代码用到的能力是否在 permissions 里声明**（ctx.fs / ctx.files → fs、ctx.llm → llm、ctx.image → image、ctx.agent.run / ctx.agents → agent.run、ctx.host.runShell → shell、ctx.host.fetch → net）、**订阅的事件类型是否真的会触发**，以及**运行时陷阱**（异步成员漏 await、pickFiles 返回值当数组用、ResizeObserver 没 disconnect、**把 ctx.locale.pick/ref 的 ref 当字符串用（模板字符串 / 字符串相加 / 传给 ctx.notify → 界面显示 "[object Object]"）**——这几类都不报错，但会让面板「没有数据」或提示显示 "[object Object]"），另外检查主进程半边（ctx.host / ctx.storage / ctx.tool / ctx.fs 等）、「写死绝对路径却没让用户选文件」，并对老写法（ctx.files 读写 / ctx.host 读写）给一条「建议迁移到 ctx.fs」的提示（不算错误）。返回逐条 ✓/✗ 与修法；有问题就改完再跑一次，直到没有 ✗。参数 dir 传插件文件夹路径或插件 id。',
  },
]
