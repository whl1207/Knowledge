// electron/main/agent-preset/agent-preset-service.ts
// 内置 MCP 服务：Agent 预设管理参考（builtin-agent-preset）
//
// 场景：让内置「智能体设计师」（以及任何绑定了该服务的智能体 / 工作流 MCP 节点）
// 能**自己创建 / 修改 Agent 预设**，而不需要用户手工在设置页填十几个字段。
//
// 与 builtin-plugin-dev 的差异（为什么不能照抄它的实现）：
// - plugin-dev 是**纯只读**参考内容：正文在主进程组装，返回文本即可。
// - 预设的单一事实源是**渲染进程的 store.agentPresets**（内存 + localStorage / .agent 文件），
//   主进程既拿不到用户的预设，也拿不到技能库、插件工具清单与知识库路径。
//   因此本服务只做「MCP 协议包装 + 参数校验 + 转发」：真正的读写在渲染层执行
//   （requestRendererTask → src/composables/useAgentPresetTask.ts），
//   校验规则也只有一份（src/shared/agentPresetSpec.ts）。
//
// 设计要点（对齐 DSH：声明 → 自检 → 唯一写通道）：
// - 静态话题（schema / capabilities / example）由主进程直接返回，不依赖渲染层；
// - 数据与写入类工具要求「有发起调用的 agent 会话」（currentMcpOwner）：外部 HTTP MCP 客户端
//   没有渲染层可转发，明确报错而不是假装成功；
// - preset_write 是**唯一写通道**，内部强制再校验一次，有 error 直接拒绝。

import { AGENT_PRESET_TOOL_SPECS, presetCapabilitiesText, presetExampleText, presetSchemaText, type AgentPresetToolSpec } from '@/shared/agentPresetSpec'
import { currentMcpOwner } from '../mcp-owner'
import { requestRendererTask } from '../agent-loop'

/** 单次返回文本上限（与 plugin-dev 一致；预设 JSON 通常远小于此） */
const MAX_OUTPUT = 30000

/**
 * 渲染层任务超时：读 store / 列目录 / 读几个 .agent 都是毫秒级，20 秒足够；
 * 超时后 runRendererOp 会**再试一次**，两次合计 40 秒 < 老存档里 MCP 默认的 60 秒，
 * 这样「窗口偶发卡一下」不会直接变成「调用超时」。
 */
const RENDERER_TIMEOUT_MS = 20_000

/** 静态话题：纯文本，主进程即可回答 */
const STATIC_TOPICS: Record<string, () => string> = {
  preset_schema: presetSchemaText,
  preset_capabilities: presetCapabilitiesText,
  preset_example: presetExampleText,
}

/** MCP 工具清单（设置页「查看函数」与 mcp_call 的前置参数校验都读这里） */
export function toolDefinitions(): any[] {
  return (AGENT_PRESET_TOOL_SPECS as AgentPresetToolSpec[]).map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }))
}

export function listToolNames(): string[] {
  return toolDefinitions().map((t) => String(t.name))
}

/** 无 owner 时的说明（外部 MCP 客户端 / 定时任务没有渲染层可转发） */
const NO_OWNER_ERROR = [
  '这个操作需要桌面端智能体会话（内置 MCP 服务要把读写转发给渲染层执行）。',
  '外部 MCP 客户端只能读静态话题（preset_schema / preset_capabilities / preset_example）；',
  '在 AI-KM 里请选「智能体设计师」智能体，或让任何绑定了 builtin-agent-preset 的智能体来操作。',
].join('')

/**
 * 经渲染层执行一次预设操作。
 * 失败信息统一带「接下来该做什么」，方便模型自己纠正（对齐 plugin_dev_check 的报错风格）。
 *
 * 「渲染层未响应」重试一次：窗口偶发忙碌（刚打开设置页 / 主进程在做大目录 IO）时
 * 第一次可能等满 60 秒；第二次通常几十毫秒就回来了。两次都失败才把错误交给模型。
 */
async function runRendererOp(op: string, args: Record<string, any> = {}): Promise<any> {
  const owner = currentMcpOwner()
  if (!owner) throw new Error(NO_OWNER_ERROR)
  const request = () => requestRendererTask(owner, 'agent_preset', { op, ...args }, RENDERER_TIMEOUT_MS)
  try {
    return await request()
  } catch (e: any) {
    const msg = String(e?.message || e)
    if (!msg.includes('渲染层未响应')) throw e
    try {
      return await request()
    } catch (e2: any) {
      const msg2 = String(e2?.message || e2)
      if (msg2.includes('渲染层未响应')) {
        throw new Error(`${msg2}：预设读写需要 AI-KM 窗口在场；请确认应用窗口没有被关闭。若反复出现，可在「设置 → 工具 → MCP」里调大该服务的调用超时后重试。`)
      }
      throw e2
    }
  }
}

/** 把结构化结果渲染成 MCP 文本（模型既能读 summary，也能读到完整 JSON） */
function toText(title: string, value: any): string {
  let body: string
  try {
    body = JSON.stringify(value, null, 2)
  } catch {
    body = String(value)
  }
  const text = `${title}\n${body}`
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（内容过长已截断；请用 preset_get 看单个预设，或缩小范围）` : text
}

/** 执行某个工具（返回纯文本；调试与自测脚本可绕过 MCP 传输层直接调用） */
export async function executeTool(name: string, args: any): Promise<string> {
  const staticTopic = STATIC_TOPICS[name]
  if (staticTopic) return staticTopic()

  switch (name) {
    case 'preset_host': {
      const value = await runRendererOp('host')
      return toText('【预设存储现状】', value)
    }
    case 'preset_list': {
      const value = await runRendererOp('list')
      return toText('【现有预设 + 可用工具 / 技能 / 知识库 / MCP 服务】', value)
    }
    case 'preset_get': {
      const id = String(args?.id ?? '').trim()
      if (!id) throw new Error('preset_get 缺少 id（先用 preset_list 看现有预设的 id 与名称）')
      const value = await runRendererOp('get', { id })
      return toText(`【预设详情：${id}】`, value)
    }
    case 'preset_validate': {
      const preset = args?.preset
      if (!preset || typeof preset !== 'object') throw new Error('preset_validate 缺少 preset（完整预设 JSON）')
      const value = await runRendererOp('validate', { preset })
      // 校验结果里已经有可读的 text，但同时给完整结构（errors/warnings/fixes）
      return toText(`【预设校验：${value?.ok ? '通过' : '未通过'}】\n${value?.text || ''}\n`, value)
    }
    case 'preset_write': {
      const preset = args?.preset
      if (!preset || typeof preset !== 'object') throw new Error('preset_write 缺少 preset（完整预设 JSON；先 preset_validate 再写）')
      const value = await runRendererOp('write', { preset, overwrite: args?.overwrite !== false })
      const fixes = Array.isArray(value?.fixes) && value.fixes.length ? `\n已自动修正：\n${value.fixes.map((f: string) => `  · ${f}`).join('\n')}` : ''
      const warnings = Array.isArray(value?.warnings) && value.warnings.length
        ? `\n校验警告（不阻断）：\n${value.warnings.map((w: any) => `  ! ${w.message}`).join('\n')}`
        : ''
      const fileLine = value?.file ? `\n文件：${value.file}` : `\n存储：${value?.storage === 'folder' ? '预设文件夹' : '本地存储（未设置预设文件夹）'}`
      return [
        `【已写入预设】${value?.created ? '新建' : '更新'}：${value?.name}（id=${value?.id}）`,
        `工具（${(value?.tools || []).length}）：${(value?.tools || []).join(', ') || '（无）'}${fileLine}${fixes}${warnings}`,
        '',
        '生效范围：新建的会话 / 新一轮执行立即生效；已经在跑的会话保持启动时的工具集。',
        '下一步（交付说明里请提到）：用户可在「设置 → 智能体 → 预设」里继续微调；聊天右上角选预设即可使用。',
      ].join('\n')
    }
    case 'preset_reload': {
      const value = await runRendererOp('reload')
      const issues: any[] = Array.isArray(value?.issues) ? value.issues : []
      const lines = [
        `【已重新扫描预设文件夹】${value?.folder || ''}`,
        `文件 ${value?.files ?? 0} 个：载入 ${value?.loaded ?? 0} 个，跳过 ${value?.skipped ?? 0} 个${value?.skippedBuiltin ? `，忽略占用内置 id 的 ${value.skippedBuiltin} 个` : ''}；当前预设共 ${value?.presetCount ?? 0} 个。`,
      ]
      if (value?.error) lines.push(`✗ 目录不可读：${value.error}`)
      if (issues.length) {
        lines.push('', '✗ 有问题、未载入的文件：')
        for (const it of issues) lines.push(`  ✗ ${it.file}：${it.error}`)
        lines.push('', '改完这些文件后，再调用一次 preset_reload 直到 issues 为空。')
      } else if (value?.ok) {
        lines.push('', '✓ 没有发现被跳过的文件：所有 .agent 都已载入。')
      }
      const invalid: any[] = Array.isArray(value?.invalidPresets) ? value.invalidPresets : []
      if (invalid.length) {
        lines.push('', '! 已载入、但字段校验不通过的预设（还能用，但建议修）：')
        for (const p of invalid) {
          lines.push(`  ! ${p.name || p.id}（id=${p.id}）：`)
          for (const msg of (p.errors || []).slice(0, 6)) lines.push(`      · ${msg}`)
        }
        lines.push('这些可以直接用 preset_get 取回、改好字段后用 preset_write 覆盖（会顺带补齐默认值）。')
      }
      lines.push('', '提示：preset_reload 只读盘 + 字段检查，不做规范化；字段要补齐请用 preset_write。')
      return lines.join('\n')
    }
    case 'preset_delete': {
      const id = String(args?.id ?? '').trim()
      if (!id) throw new Error('preset_delete 缺少 id（先用 preset_list 确认要删的是自建预设）')
      const value = await runRendererOp('delete', { id })
      return `【已删除预设】${value?.name}（id=${value?.id}）\n注意：如果它仍被聊天 / 集群 / 工作流引用，那些引用现在会悬空，建议在回答里提醒用户检查。`
    }
    default:
      throw new Error(`未知工具: ${name}（可用：${listToolNames().join(' / ')}）`)
  }
}

// ---------------- 共享单例 Server（内置连接与对外暴露共用） ----------------
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
        { name: 'AI-KM 智能体设计参考', version: '0.1.0' },
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
          // 错误一律以 isError 返回：模型能读到原因并自己纠正（例如换 id、先 validate）
          return { isError: true, content: [{ type: 'text', text: `预设操作失败：${err?.message || String(err)}` }] }
        }
      })
      sharedServer = server
      return server
    })()
  }
  return sharedServerReady
}

/** 供 mcp-service：内置连接每次创建一对 InMemory transport 并挂到共享 Server */
export async function createLocalServerPair(_config?: any): Promise<{ server: any; clientTransport: any }> {
  const sdk = await getServerSdk()
  const server = await ensureServer()
  const [clientTransport, serverTransport] = sdk.InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { server, clientTransport }
}

/** 供对外 HTTP 暴露层：把外部 transport 挂到同一共享 Server（当前未暴露，保留接线） */
export async function connectTransport(transport: any): Promise<void> {
  const server = await ensureServer()
  await server.connect(transport)
}

export const agentPresetService = {
  createLocalServerPair,
  connectTransport,
  toolDefinitions,
  listToolNames,
  executeTool,
}
