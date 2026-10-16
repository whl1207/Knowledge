// electron/main/plugin-dev/plugin-dev-service.ts
// 内置 MCP 服务：插件开发参考（builtin-plugin-dev）
//
// 场景：让「插件开发智能体」以及任何其它智能体 / 工作流 MCP 节点 / 外部 MCP 客户端
// 都能读到 AI-KM 官方插件开发参考（约束、清单字段、内置槽位、宿主 API 清单、最小示例、
// 常见问题、开发模板）与本机插件目录路径，从而**不必**去磁盘上找软件源码
// （装机后的软件里没有 src/，模型找不到会满盘 read_file / search_files / shell）。
//
// 设计要点：
// - **按主题拆成 7 个短工具**（host / constraints / manifest / api / api-main / faq / templates），
//   单次只回几百到几千字：体量小的模型一次吃不下几千字，按需取用才用得动。
// - 与 office / drawio / literature / postgres 同构：主进程内 SDK Server over InMemoryTransport；
//   打包主进程时不能静态内联 MCP SDK（zod v4 内联损坏），一律 @vite-ignore 运行时加载。
// - 正文组装在 ../plugin-dev-guide.ts（与「设置 → 插件 → 开发」页同一份数据源）；
//   本文件只负责「包装成 MCP 工具 + 提供传输」。
// - 对外 HTTP 暴露由 mcp-expose.ts 挂到 /mcp/builtin-plugin-dev（外部 MCP 客户端可直连）。

import { PLUGIN_DEV_TEMPLATE_KEYS, PLUGIN_DEV_TOOL_SPECS, pluginDevTopic } from '../plugin-dev-guide'
import { checkPluginDir } from './plugin-dev-check'

// ---------------- 运行时懒加载 MCP Server SDK ----------------

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

export const PLUGIN_DEV_MCP_ID = 'builtin-plugin-dev'

/** 单次返回文本上限（各话题本身在 0.5～5k 字之间，只有 templates/all 可能较大） */
const MAX_OUTPUT = 30000

/** MCP 工具清单（设置页「查看函数」与 mcp_call 的前置参数校验都读这里） */
export function toolDefinitions(): any[] {
  return PLUGIN_DEV_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.dirParam
      ? {
          type: 'object',
          properties: {
            dir: { type: 'string', description: '插件文件夹路径（绝对路径），或直接给插件 id（在插件目录下查找）' },
          },
          required: ['dir'],
        }
      : spec.keyParam
        ? {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                // 从 PLUGIN_DEV_TEMPLATE_KEYS 派生（原先手写一份，已经漏了 settings ——
                // 那个 key 实际能用、却没被 schema 广告）。同一份事实不许写两遍。
                enum: [...PLUGIN_DEV_TEMPLATE_KEYS],
                description: '要取正文的模板 key（缺省只返回模板目录 + 安装步骤）；minimal = 最小可运行示例，all 返回全部模板（较长）。',
              },
            },
          }
        : { type: 'object', properties: {} },
  }))
}

export function listToolNames(): string[] {
  return toolDefinitions().map((t) => String(t.name))
}

/** 执行某个工具（返回纯文本；调试与自检脚本可绕过 MCP 传输层直接调用） */
export async function executeTool(name: string, args: any): Promise<string> {
  const spec = PLUGIN_DEV_TOOL_SPECS.find((s) => s.name === name)
  if (!spec) {
    throw new Error(`未知工具: ${name}（可用：${PLUGIN_DEV_TOOL_SPECS.map((s) => s.name).join(' / ')}）`)
  }
  const text = spec.dirParam
    ? await checkPluginDir(String(args?.dir ?? ''))
    : pluginDevTopic(String(spec.topic), spec.keyParam ? String(args?.key ?? '') : '')
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…（内容过长已截断，请换更小的 key 分批取用）` : text
}

// ---------------- 共享单例 Server（内置连接与对外暴露共用） ----------------
let sharedServer: any = null
let sharedServerReady: Promise<any> | null = null

async function ensureServer(): Promise<any> {
  if (sharedServer) return sharedServer
  if (!sharedServerReady) {
    sharedServerReady = (async () => {
      const sdk = await getServerSdk()
      const server = new sdk.Server(
        { name: 'AI-KM 插件开发参考', version: '0.1.0' },
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
          return { isError: true, content: [{ type: 'text', text: `读取插件开发参考失败：${err?.message || String(err)}` }] }
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

/** 供对外 HTTP 暴露层：把外部 transport 挂到同一共享 Server */
export async function connectTransport(transport: any): Promise<void> {
  const server = await ensureServer()
  await server.connect(transport)
}

export const pluginDevService = {
  createLocalServerPair,
  connectTransport,
  toolDefinitions,
  listToolNames,
  executeTool,
}
