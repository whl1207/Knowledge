// electron/main/skill-dev/skill-dev-service.ts
// 内置 MCP 服务：技能设计参考（builtin-skill-dev）
//
// 场景：让内置「技能设计师」智能体（以及任何绑定了该服务的智能体 / 工作流 MCP 节点）
// 能**按 AI-KM 的真实规则写技能**：目录结构、frontmatter 字段、`$技能名` 触发、
// 资源引用约定、写法指南、模板与报错对照，并在交付前用宿主同一套解析逻辑自检。
//
// 与 builtin-plugin-dev 同构（静态参考 + 一个自检工具）；差异只有一处：
// 技能目录是可配置的（默认 userData/skills，用户可在设置里改），这份路径只存在渲染层，
// 所以 `skill_dev_host` 经 requestRendererTask 取（见 src/composables/useAgentSkillTask.ts），
// 而 `skill_dev_check` 在**主进程**直接读盘（技能本来就是磁盘目录，不需要转发）。
//
// 对外 HTTP 暴露暂不提供：check 需要 dir，host 需要渲染层会话；保留 connectTransport 以便后续接线。

import { basename, isAbsolute, join, normalize } from 'node:path'
import { SKILL_DEV_MCP_ID, SKILL_DEV_TEMPLATE_KEYS, SKILL_DEV_TOOL_SPECS, skillDevTopic, type SkillDevTopic } from './skill-dev-guide'
import { checkSkillDir } from './skill-dev-check'
import { currentMcpOwner } from '../mcp-owner'
import { requestRendererTask } from '../agent-loop'

export { SKILL_DEV_MCP_ID }

/** 单次返回文本上限 */
const MAX_OUTPUT = 30000
/** 渲染层任务超时（读技能列表，一般很快；大技能库也不该超过 30 秒） */
const RENDERER_TIMEOUT_MS = 30_000

/** MCP 工具清单（静态话题 + host + check） */
export function toolDefinitions(): any[] {
  const staticTools = SKILL_DEV_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.keyParam
      ? {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              enum: [...SKILL_DEV_TEMPLATE_KEYS],
              description: '要取正文的模板 key（缺省只返回模板目录与取用方式）。',
            },
          },
        }
      : { type: 'object', properties: {} },
  }))
  return [
    {
      name: 'skill_dev_host',
      description:
        '读取技能的**存储现状**：技能目录的绝对路径（默认 userData/skills，可被用户改成自定义文件夹）、是否为默认位置、目录能否读取、**已装技能清单**（name / description / path / 文件数，用于避免重名与复用），以及怎么触发（`$技能名` / 预设勾选）与怎么刷新。写技能前先读这一条，拿到路径再动笔。',
      inputSchema: { type: 'object', properties: {} },
    },
    ...staticTools,
    {
      name: 'skill_dev_check',
      description:
        '**交付前自检**一个技能目录：SKILL.md 是否存在 / 能否解析、frontmatter 的 name 与 description、目录名是否与 name 一致、name 能否用 `$` 触发、正文体积、引用的 references/scripts/assets 是否真实存在、是否与已装技能重名、总大小。返回 ✗（必须修）/ !（建议改）/ ·（提示）与结论；有 ✗ 就改文件再跑，直到没有 ✗。',
      inputSchema: {
        type: 'object',
        properties: {
          dir: {
            type: 'string',
            description: '技能目录的绝对路径；也可以只传技能名（由宿主在技能目录下解析）。',
          },
        },
        required: ['dir'],
      },
    },
  ]
}

export function listToolNames(): string[] {
  return toolDefinitions().map((t) => String(t.name))
}

/** 无 owner 时的说明（外部 MCP 客户端没有渲染层会话） */
const NO_OWNER_ERROR = [
  '这个操作需要桌面端智能体会话（技能目录与技能库在渲染层）。',
  '在 AI-KM 里请选「技能设计师」智能体，或让任何绑定了 builtin-skill-dev 的智能体来操作。',
].join('')

/** 经渲染层取技能目录与已装清单 */
async function fetchHost(): Promise<any> {
  const owner = currentMcpOwner()
  if (!owner) throw new Error(NO_OWNER_ERROR)
  try {
    return await requestRendererTask(owner, 'agent_skill', { op: 'host' }, RENDERER_TIMEOUT_MS)
  } catch (e: any) {
    const msg = String(e?.message || e)
    if (msg.includes('渲染层未响应')) {
      throw new Error(`${msg}：技能目录信息需要 AI-KM 窗口在场；请确认应用窗口没有被关闭，然后重试。`)
    }
    throw e
  }
}

function toText(title: string, value: any): string {
  let body = ''
  try {
    body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    body = String(value)
  }
  const text = `${title}\n${body}`
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（内容过长已截断；请缩小范围）` : text
}

/** 把「技能名」解析成绝对路径所需的技能目录（拿不到就按当前目录处理） */
async function resolveCheckDir(input: string): Promise<{ dir: string; installed: Array<{ name: string; path?: string }>; folder: string; note: string }> {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('skill_dev_check 缺少 dir（技能目录绝对路径，或技能名）')
  if (isAbsolute(raw)) {
    let installed: Array<{ name: string; path?: string }> = []
    let folder = ''
    let note = ''
    try {
      const host = await fetchHost()
      folder = String(host?.folder || '')
      installed = Array.isArray(host?.skills) ? host.skills : []
    } catch (e: any) {
      // 外部客户端 / 无窗口：仍按绝对路径检查，只是跳过重名
      note = `（拿不到技能库清单，已跳过重名检查：${String(e?.message || e)}）`
    }
    return { dir: normalize(raw), installed, folder, note }
  }
  const host = await fetchHost()
  const folder = String(host?.folder || '')
  if (!folder) throw new Error('当前没有技能目录（未设置 skillsPath，且默认目录不可用）：先在「设置 → 技能 → 管理」选择文件夹')
  return {
    dir: join(folder, raw),
    installed: Array.isArray(host?.skills) ? host.skills : [],
    folder,
    note: '',
  }
}

/** 执行某个工具（返回纯文本；调试与自测脚本可绕过 MCP 传输层直接调用） */
export async function executeTool(name: string, args: any): Promise<string> {
  const topicSpec = SKILL_DEV_TOOL_SPECS.find((s) => s.name === name)
  if (topicSpec) {
    return skillDevTopic(topicSpec.topic as SkillDevTopic, topicSpec.keyParam ? String(args?.key ?? '') : '')
  }

  if (name === 'skill_dev_host') {
    const value = await fetchHost()
    const lines = [
      `技能目录：${value?.folder || '（未设置）'}${value?.isDefault ? '（默认位置）' : ''}`,
      `目录可读：${value?.exists ? '是' : '否'}；已装技能：${value?.count ?? 0} 个`,
      '',
      '已装技能（避免重名，也可复用）：',
      ...(Array.isArray(value?.skills) && value.skills.length
        ? value.skills.map((s: any) => `- ${s.name}${s.emoji ? ` ${s.emoji}` : ''}：${s.description || '（无 description）'}\n  路径：${s.path}（${s.fileCount} 个文件）`)
        : ['（还没有技能）']),
      '',
      `怎么用：${value?.howToUse || ''}`,
      `怎么刷新：${value?.howToReload || ''}`,
      value?.error ? `\n! 读取技能列表时报错：${value.error}` : '',
    ]
    return lines.filter((l) => l !== undefined).join('\n')
  }

  if (name === 'skill_dev_check') {
    const { dir, installed, note } = await resolveCheckDir(String(args?.dir ?? ''))
    const text = checkSkillDir(dir, { installed })
    return note ? `${text}\n\n${note}` : text
  }

  throw new Error(`未知工具: ${name}（可用：${listToolNames().join(' / ')}）`)
}

// ---------------- 共享单例 Server ----------------
let sharedServer: any = null
let sharedServerReady: Promise<any> | null = null

interface ServerSdkBundle {
  Server: any
  InMemoryTransport: any
  ListToolsRequestSchema: any
  CallToolRequestSchema: any
}
let serverSdkCache: ServerSdkBundle | null = null

async function getServerSdk(): Promise<ServerSdkBundle> {
  if (serverSdkCache) return serverSdkCache
  const [serverMod, inMemoryMod, typesMod] = await Promise.all([
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/server/index.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/inMemory.js'),
    import(/* @vite-ignore */ '@modelcontextprotocol/sdk/types.js'),
  ])
  serverSdkCache = {
    Server: (serverMod as any).Server ?? (serverMod as any).McpServer,
    InMemoryTransport: (inMemoryMod as any).InMemoryTransport,
    ListToolsRequestSchema: (typesMod as any).ListToolsRequestSchema,
    CallToolRequestSchema: (typesMod as any).CallToolRequestSchema,
  }
  return serverSdkCache
}

async function ensureServer(): Promise<any> {
  if (sharedServer) return sharedServer
  if (!sharedServerReady) {
    sharedServerReady = (async () => {
      const sdk = await getServerSdk()
      const server = new sdk.Server(
        { name: 'AI-KM 技能设计参考', version: '0.1.0' },
        { capabilities: { tools: {} } },
      )
      const tools = toolDefinitions()
      server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }))
      server.setRequestHandler(sdk.CallToolRequestSchema, async (req: any) => {
        const toolName = String(req?.params?.name || '')
        const args = req?.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {}
        try {
          const text = await executeTool(toolName, args)
          return { content: [{ type: 'text', text }] }
        } catch (err: any) {
          return { isError: true, content: [{ type: 'text', text: `技能操作失败：${err?.message || String(err)}` }] }
        }
      })
      sharedServer = server
      return server
    })()
  }
  return sharedServerReady
}

export async function createLocalServerPair(_config?: any): Promise<{ server: any; clientTransport: any }> {
  const sdk = await getServerSdk()
  const server = await ensureServer()
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { server, clientTransport }
}

export async function connectTransport(transport: any): Promise<void> {
  const server = await ensureServer()
  await server.connect(transport)
}

export const skillDevService = {
  createLocalServerPair,
  connectTransport,
  toolDefinitions,
  listToolNames,
  executeTool,
}

/** 技能目录名（供交付说明使用；避免模型把路径写错） */
export const skillDirName = (dir: string): string => basename(normalize(dir))
