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
 */

import { PLUGIN_HOST_API_VERSION } from '@/types/plugin'
import { CORE_PLUGIN_SLOTS } from '@/shared/pluginSlots'
import { SUPPORTED_PLUGIN_PERMISSIONS } from '@/shared/pluginManifest'
import {
  CONSTRAINTS_ZH,
  PLUGIN_DEV_FAQ,
  PLUGIN_DEV_FACTS,
  PLUGIN_DEV_MINIMAL_ZH,
  PLUGIN_DEV_SECTIONS,
  PLUGIN_DEV_USAGE_ZH,
} from '@/lib/plugin/devGuide'
import { pluginHost } from './plugin-host'

/** 话题名（= MCP 工具名去掉 plugin_dev_ 前缀） */
export const PLUGIN_DEV_TOPICS = ['host', 'constraints', 'manifest', 'api', 'faq', 'templates'] as const
export type PluginDevTopic = (typeof PLUGIN_DEV_TOPICS)[number]

/** 模板话题可单独取用的小节（key 与 devGuide 的 PLUGIN_DEV_SECTIONS 一致） */
export const PLUGIN_DEV_TEMPLATE_KEYS = ['general', 'panel', 'tool', 'llm-files', 'fix', 'usage', 'all'] as const

// ---------------------------------------------------------------------------
// 各话题正文
// ---------------------------------------------------------------------------

/** 本机运行态：模型必须知道往哪写插件、现在装了哪些、数据该放哪 */
export function topicHost(): string {
  const lines: string[] = ['【本机运行态（由软件实时给出，可直接使用）】']
  const custom = pluginHost.hasCustomRoot()
  lines.push(`- 插件目录（绝对路径，插件文件夹就建在这里面）：${pluginHost.rootDir()}`)
  lines.push(`- 上面这个是${custom ? '用户在设置里自定义的目录' : '默认目录（userData/plugins）'}；写出插件文件夹后让用户在「设置 → 插件 → 管理」点「重新扫描」即可发现，不必重启软件。`)
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
  const facts = PLUGIN_DEV_FACTS.filter((f) => f.name.startsWith('package.json'))
    .map((f) => `- ${f.name}\n  ${f.descZh}`)
    .join('\n')
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
    '（id 必须等于插件目录名；name 是显示名；version 形如 1.0.0；apiVersion 是**字符串** "^1"。）',
    '',
    '【内置槽位（declares.slots 只能填这些，未知槽位会被拒绝）】',
    slots,
    '',
    '【改清单时最容易写错的四点（宿主会直接拒绝或加载失败）】',
    '1. apiVersion 必须写字符串 "^1"（写数字 2 会被判定为「要求宿主 API 2，当前 1」而拒绝；写 1 会按 "1" 处理）。',
    '2. 槽位写进 declares.slots —— **不要**写进 inject：inject 只放宿主**服务名**（如 ["tools"]），写槽位会被直接驳回。',
    '3. 声明了 main 就必须真的有那个文件：只写界面半边就**不要**写 main（否则报「入口文件不存在：index.mjs」）。',
    '4. 用到的权限（fs / shell / net / agent / llm）必须写进 permissions，否则调用时抛错。',
  ].join('\n')
}

/** 宿主 API 速查（界面半边 + 主进程半边）+ 最小可运行示例 */
export function topicApi(): string {
  const facts = PLUGIN_DEV_FACTS.filter((f) => !f.name.startsWith('package.json'))
    .map((f) => `- ${f.name}\n  ${f.descZh}`)
    .join('\n')
  return [
    '【宿主 API 速查（照抄名字，不要臆造）】',
    facts,
    '',
    '【最小可运行示例（与仓库 examples/plugins/hello-panel 一致）】',
    PLUGIN_DEV_MINIMAL_ZH,
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
      '- usage：安装、启用与调试步骤',
      '',
      topicUsage(),
    ].join('\n')
  }
  if (k === 'usage') return topicUsage()
  if (k === 'all') {
    const all = PLUGIN_DEV_SECTIONS.map((s) => `### ${s.titleZh}（key: ${s.key}）\n（${s.descZh}）\n\n${s.bodyZh}`).join('\n\n---\n\n')
    return ['【全部开发模板】', '', all, '', topicUsage()].join('\n')
  }
  const section = PLUGIN_DEV_SECTIONS.find((s) => s.key === k)
  if (!section) {
    const keys = [...PLUGIN_DEV_SECTIONS.map((s) => s.key), 'usage', 'all'].join(' / ')
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

/** 各工具的一句话说明（只讲「这条能拿到什么」，通用告诫不放这里，避免 6 条重复占 schema） */
export const PLUGIN_DEV_TOOL_SPECS: readonly PluginDevToolSpec[] = [
  {
    name: 'plugin_dev_host',
    topic: 'host',
    description: '读取本机插件运行态：插件目录的绝对路径、是默认目录还是自定义目录、已装插件清单、宿主插件 API 版本、可申请的权限、插件数据该放在哪。写插件前先取它，就知道该把文件夹建在哪里。',
  },
  {
    name: 'plugin_dev_constraints',
    topic: 'constraints',
    description: '读取插件开发的硬性约束（14 条，违反会加载失败或界面出错）：目录名＝id、清单必填字段、可用槽位与权限、界面半边必须单文件 ESM 无 import、Vue 由 ctx.vue 注入、副作用必须可清理、主题变量与滚动样式、面板不能撑大窗口等。写代码前必读。',
  },
  {
    name: 'plugin_dev_manifest',
    topic: 'manifest',
    description: '读取 package.json 里 aikm 清单的全部字段（id / name / version / apiVersion / main / client.entry / inject / permissions / declares.tools / declares.slots）与五个内置槽位的用途。写清单时取这一条。',
  },
  {
    name: 'plugin_dev_api',
    topic: 'api',
    description: '读取宿主 API 速查（界面半边与主进程半边两套 ctx 方法：slots / shortcuts / llm / files / app / tts / config / log / notify / effect / storage / tool / service / shell / net / sessions）以及一份最小可运行示例（package.json + client.mjs 全文）。写代码时取这一条。',
  },
  {
    name: 'plugin_dev_faq',
    topic: 'faq',
    description: '读取插件开发常见问题对照（装载失败、槽位未声明、权限报错、深色主题白底白字、面板被挤扁或撑大窗口、改动何时生效等）。插件报错时先用它对照。',
  },
  {
    name: 'plugin_dev_templates',
    topic: 'templates',
    keyParam: true,
    description: '读取可照抄的开发模板目录与「安装、启用、调试步骤」。默认只回目录（很短）；要正文时传 key，一次取一个：general（通用开发指令）、panel（界面插件：面板 + 设置页签 + 快捷键）、tool（给智能体加工具）、llm-files（大模型与文件能力）、fix（排障指令）、usage（安装步骤）、all（全部，较长）。',
  },
  {
    name: 'plugin_dev_check',
    dirParam: true,
    description: '自检一个插件文件夹（交付前必跑）：用宿主**同一份**校验逻辑检查 package.json 清单（字段类型 / apiVersion / 槽位声明 / 权限）、声明的入口文件是否存在，并静态检查界面半边（是否含 import/require、是否用了 template、是否导出 apply(ctx)、是否调用 ctx.slots.register、是否误用界面半边没有的 ctx.storage、生命周期钩子是否在 setup 里）。返回逐条 ✓/✗ 与修法；有问题就改完再跑一次，直到没有 ✗。参数 dir 传插件文件夹路径或插件 id。',
  },
]
