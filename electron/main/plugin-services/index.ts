/**
 * plugin-services/index.ts — 按插件装配宿主服务（P1：会话面）
 *
 * 每个插件拿到的服务都是**按插件特化**的实例：
 * - 逻辑会话登记表按插件隔离（A 插件看不到 B 插件的逻辑 id 映射）；
 * - 会话的工具面按插件声明的权限裁剪（只声明 `agent.control` 的插件，会话只拿只读工具）；
 * - 工作目录默认落在 `userData/plugins-data/<id>/workspace`，不让相对路径落到进程 cwd；
 * - 插件卸载时把它的物理 agent 全部注销（`dispose()`）。
 *
 * P1 只实现 4 个服务：`sessions / sessionController / sessionProjections / agents`。
 * 其余服务（tools/webServer/approval/waterfall/process/secrets/…）在 P2/P3 接。
 */

import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { LAN_GUEST_READONLY_TOOLS } from '@/shared/lanGuest'
import { normalizeLlmType } from '@/shared/llmSources'
import { PluginServiceError } from '@/shared/pluginServices'
import type { AgentOptions } from '@/types/agent'
import type { PluginLogger, PluginPermission } from '@/types/plugin'
import type {
  ModelSelection,
  PluginServiceName,
  PluginServices,
} from '@/shared/pluginServices'
import { PluginSessionRegistry } from '@/shared/pluginSessionRegistry'
import { getLanGuestAgents, getLanGuestHostLlm, getLocalGeneralAgent } from '../lan-guest'
import { disposeAgent } from '../agent-loop'
import { clearPluginWaterfalls } from '../plugin-waterfall'
import { unregisterOwnedAgent } from '../plugin-owned-agents'
import { createSessionsService } from './sessions'
import { createSessionController, createSessionProjections } from './session-controller'
import { createAgentsService } from './agents'
import { createWaterfallService } from './waterfall'
import { createApprovalService } from './approval'
import { createUserQuestionsService } from './questions'
import { createPluginWebServer } from './web-server'
import { createPluginProcess } from './process'
import { createPluginSecrets } from './secrets'
import { createPluginSchedule } from './schedule'
import { createPluginAttachments } from './attachments'
import { createRpcHostService } from './rpc'
import { createWorkspaceRegistry } from './workspace'
import { buildModelCatalog } from './model-catalog'
import { clearPluginRpcs } from '../plugin-rpc-registry'

/** P1/P2/P3 已实现的服务及其权限（`null` = 不需要权限） */
export const HOST_SERVICE_PERMISSIONS: Readonly<Record<string, PluginPermission | null>> = {
  sessions: 'agent',
  sessionController: 'agent.control',
  sessionProjections: 'agent',
  agents: 'agent.control',
  workspaceRegistry: 'agent',
  waterfall: 'agent.control',
  approval: 'agent.control',
  userQuestions: 'agent.control',
  webServer: 'net.listen',
  process: 'process.spawn',
  secrets: 'secrets',
  schedule: 'schedule',
  attachments: 'attachments',
  rpcHost: null,
}

/** 本工厂能提供的全部服务名 */
export const HOST_SERVICE_NAMES: readonly PluginServiceName[] = Object.keys(HOST_SERVICE_PERMISSIONS) as PluginServiceName[]

export function isHostServiceName(name: unknown): name is PluginServiceName {
  return typeof name === 'string' && name in HOST_SERVICE_PERMISSIONS
}

/** 按权限过滤后、该插件可用的宿主服务名（`inject` 判定与装配共用） */
export function hostServiceNamesFor(permissions: readonly PluginPermission[]): PluginServiceName[] {
  return HOST_SERVICE_NAMES.filter((name) => {
    const need = HOST_SERVICE_PERMISSIONS[name]
    return !need || permissions.includes(need)
  })
}

/**
 * 未授权服务的**抛错桩**：插件没声明权限时，`ctx.sessions` 等成员不是 `undefined`，
 * 而是"一碰就抛结构化错误"的对象——避免插件只看到一句看不懂的 TypeError。
 */
export function hostServiceStubsFor(permissions: readonly PluginPermission[]): Partial<PluginServices> {
  const out: Record<string, unknown> = {}
  for (const name of HOST_SERVICE_NAMES) {
    const need = HOST_SERVICE_PERMISSIONS[name]
    if (!need || permissions.includes(need)) continue
    const fail = (): never => {
      throw new PluginServiceError(
        'PLUGIN_PERMISSION_DENIED',
        `插件未声明 ${need} 权限，无法使用 ctx.${name}（请在 package.json 的 aikm.permissions 中声明）`,
        { service: name, permission: need },
      )
    }
    out[name] = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol') return undefined
          return fail
        },
        apply: fail,
        has: () => true,
      },
    )
  }
  return out as Partial<PluginServices>
}

/** 插件会话可用的工具：只读默认集 + 按权限放开写入 / 执行 / 委派 */
function toolsFor(permissions: readonly PluginPermission[]): string[] {
  const out = new Set<string>(LAN_GUEST_READONLY_TOOLS)
  if (permissions.includes('fs')) {
    for (const name of ['write_file', 'replace_in_file', 'multi_replace']) out.add(name)
  }
  if (permissions.includes('shell')) {
    for (const name of ['shell', 'run_python', 'run_code']) out.add(name)
  }
  if (permissions.includes('agent.run')) out.add('run_subagent')
  return Array.from(out)
}

/**
 * 给 DSH 插件写一份它认得的「会话索引」。
 *
 * 微信插件判断会话是否还存在，读的是 `<home>/storages/session_projcache/sessions/<id>.json`
 * （`storedSessionWorkspace` / `hasStoredSession`）。AI-KM 的会话存在 `session-logs` 里，
 * 不写这份索引，插件会一直判定“会话已不存在”，然后每 120 秒新建一条并回一段
 * “原对话已不存在”的提示——真正推理的结果反而被这段提示淹没。
 *
 * 只写展示/存在性所需的最小字段，不写会话正文（正文仍在 AI-KM 的 session log）。
 */
function writeDshSessionIndex(pluginId: string, sessionId: string, cwd: string): void {
  try {
    const dir = path.join(pluginHomeDir(pluginId), 'storages', 'session_projcache', 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const record = {
      record: {
        identity: { cwd, createdAt: now },
        rows: {
          title: { val: `微信 ${sessionId.slice(-6)}` },
          sessionListMetadata: { val: { lastPromptAt: now } },
        },
      },
    }
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(record), 'utf8')
  } catch {
    /* 索引只是兼容层：写不了不能让会话本身失败 */
  }
}

/** 插件数据根（与 plugin-host 的 plugins-data/<id> 一致） */export function pluginHomeDir(pluginId: string): string {
  const dir = path.join(app.getPath('userData'), 'plugins-data', pluginId)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 建不了就让使用方拿原路径失败 */
  }
  return dir
}

/** 插件会话的默认工作目录（不存在就建；相对路径不会落到进程 cwd） */
export function pluginWorkspaceDir(pluginId: string): string {
  const dir = path.join(pluginHomeDir(pluginId), 'workspace')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 建不了就让调用方拿原路径失败，错误会在工具层出现，不在这里吞掉语义 */
  }
  return dir
}

export interface PluginHostServicesOptions {
  readonly pluginId: string
  readonly permissions: readonly PluginPermission[]
  readonly log: PluginLogger
}

export interface PluginHostServices {
  /** 只含已实现且已授权的服务 */
  readonly services: Partial<PluginServices>
  readonly names: readonly PluginServiceName[]
  /** 插件卸载时调用：注销物理 agent、清空登记表 */
  dispose(): void
}

/**
 * 装配一个插件的宿主服务。
 *
 * 注意：**不在这里判"插件有没有 inject"**。`inject` 只决定何时装载；服务在不在
 * 取决于权限。插件没 inject 却访问服务时，由 ctx 抛 `PLUGIN_SERVICE_UNAVAILABLE`。
 */
export function createPluginHostServices(opts: PluginHostServicesOptions): PluginHostServices {
  const { pluginId, permissions, log } = opts
  const registry = new PluginSessionRegistry()
  // 懒建：只声明了权限但从不建会话的插件，不该在 userData 里多一个空目录
  let workspaceDirCache: string | null = null
  const workspaceDir = (): string => (workspaceDirCache ??= pluginWorkspaceDir(pluginId))

  const buildOptions = (input: {
    sessionId: string
    cwd?: string
    agentPreset?: string
    model?: ModelSelection | null
    resume?: boolean
    seedHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
    seedPlan?: string | null
    seedTodos?: any[]
  }): { options: AgentOptions; model: ModelSelection | null } => {
    const host = getLanGuestHostLlm()
    if (!host) {
      throw new PluginServiceError(
        'PLUGIN_UNSUPPORTED',
        '主机还没有可用的模型配置：请先打开一次 AI-KM 主窗口（应用启动会下发当前模型）',
        { service: 'sessionController', permission: 'agent.control' },
      )
    }
    const hostProvider = normalizeLlmType(host.provider)
    // DSH 的默认值来自 `agentPresets.defaultId`；AI-KM 对应「通用智能体」档案（首位，id=general）。
    // 优先用本机档案（不按访客白名单裁剪），旧渲染层没推时退回访客清单里的 general。
    const general = getLocalGeneralAgent() ?? getLanGuestAgents().find((agent) => agent.id === 'general')
    const selected = input.model
    if (selected?.provider && normalizeLlmType(selected.provider) !== hostProvider) {
      throw new PluginServiceError(
        'PLUGIN_UNSUPPORTED',
        `跨来源会话暂不支持（插件要求 ${selected.provider}，主机是 ${hostProvider}）`,
        { service: 'sessionController', permission: 'agent.control' },
      )
    }

    const config = { ...(host.config || {}) }
    const llmConfig = { ...(host.llmConfig || {}), stream: true }
    if (selected?.model) {
      config.model = selected.model
      llmConfig.model = selected.model
    }

    // 主机全局模型可能为空（用户只在某个聊天里选过模型）：退到该来源已探测的第一个模型。
    // 不这样做会带着空 model 建会话，LLM 立刻报错，微信只看到「处理这条消息时出错了」。
    let modelName = String(config.model || llmConfig.model || '').trim()
    if (!modelName) {
      const available = Array.isArray(config.available_models) ? config.available_models : []
      const first = available.find((m: unknown) => typeof m === 'string' && m.trim()) as string | undefined
      if (first) modelName = first.trim()
    }
    if (!modelName) {
      // 再退一步：用主机来源快照里该来源的第一个模型（与「模型」下拉同源）
      const catalog = buildModelCatalog()
      const group = catalog.groups.find((g) => g.id === hostProvider)
      modelName = group?.models[0]?.id ?? ''
    }
    if (!modelName) {
      throw new PluginServiceError(
        'PLUGIN_UNSUPPORTED',
        `主机来源 ${hostProvider} 没有可用的模型：请先在「设置 → 模型 → 来源」里选一个模型，或给来源刷新模型列表`,
        { service: 'sessionController', permission: 'agent.control' },
      )
    }
    config.model = modelName
    llmConfig.model = modelName

    const model: ModelSelection = {
      provider: hostProvider,
      model: modelName,
      ...(selected?.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
    }

    const allowedTools = toolsFor(permissions)
    const generalPrompt = general?.options?.systemPrompt ? String(general.options.systemPrompt) : ''
    // 通用智能体的提示词是按「它的工具集」组装的；插件会话按权限裁剪后工具更少。
    // 末尾补一行实际工具清单，避免模型照着提示词调用不存在的工具。
    const systemPrompt = generalPrompt
      ? `${generalPrompt}\n\n[AI-KM] 本会话实际可用工具（以此为准）：${allowedTools.join('、')}。不要调用清单之外的工具。`
      : undefined

    const options: AgentOptions = {
      // 逻辑 id 必须传给 createAgent：否则会生成 agent-<uuid>，插件的绑定/事件流永远对不上
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      /*
       * 默认用「通用智能体」推理（对齐 DSH：会话没指定 preset 时用 agentPresets.defaultId）。
       * 档案由渲染层组装后随 LAN 策略下发（systemPrompt/技能/MCP/工作区提示都在里面）；
       * 工具仍按插件权限裁剪——**不**因为换成通用智能体就绕过 agent.control/fs/shell 授权。
       */
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(Array.isArray(general?.options?.kbPaths) ? { kbPaths: general.options.kbPaths as string[] } : {}),
      provider: hostProvider,
      config,
      llmConfig,
      // ⚠️ 绝不是 null（null = 全部工具）：按插件权限裁剪
      tools: allowedTools,
      cwd: input.cwd || workspaceDir(),
      label: `plugin:${pluginId}`,
      scope: `plugin:${pluginId}`,
      maxSteps: 100,
      sandboxMode: 'workspace',
      contextCompact: true,
      ...(host.contextLimit ? { contextLimit: host.contextLimit } : {}),
      ...(input.resume ? { resume: true } : {}),
      ...(input.seedHistory?.length ? { seedHistory: input.seedHistory } : {}),
      ...(input.seedPlan ? { seedPlan: input.seedPlan } : {}),
      ...(input.seedTodos?.length ? { seedTodos: input.seedTodos } : {}),
    }
    return { options, model }
  }

  const services: Partial<PluginServices> = {}
  const names: PluginServiceName[] = []
  /** 卸载时要主动释放的资源（server / 子进程 / 定时器） */
  const resourceDisposers: Array<() => void> = []
  /** 单工作区（P4）：sessionController.create({ workspaceId }) 用 */
  let workspaceRegistry: ReturnType<typeof createWorkspaceRegistry> | null = null

  if (permissions.includes('agent.control')) {
    services.sessionController = createSessionController({
      pluginId,
      log,
      registry,
      buildOptions,
      resolveWorkspace: (id) => workspaceRegistry?.get(id)?.path,
      onAgentCreated: (sessionId, cwd) => writeDshSessionIndex(pluginId, sessionId, cwd),
    })
    services.agents = createAgentsService(services.sessionController, registry)
    services.waterfall = createWaterfallService(pluginId)
    services.approval = createApprovalService(log)
    services.userQuestions = createUserQuestionsService(registry)
    names.push('sessionController', 'agents', 'waterfall', 'approval', 'userQuestions')
  }
  if (permissions.includes('agent')) {
    services.sessions = createSessionsService(registry, {
      // `agent` 只给摘要；正文（transcript）要 `agent.observe`，与权限表一致
      canReadTranscript: permissions.includes('agent.observe'),
    })
    services.sessionProjections = createSessionProjections(registry)
    workspaceRegistry = createWorkspaceRegistry(pluginHomeDir(pluginId))
    services.workspaceRegistry = workspaceRegistry
    names.push('sessions', 'sessionProjections', 'workspaceRegistry')
  }
  if (permissions.includes('net.listen')) {
    const webServer = createPluginWebServer(pluginId, log)
    services.webServer = webServer
    names.push('webServer')
    resourceDisposers.push(() => webServer.dispose())
  }
  if (permissions.includes('process.spawn')) {
    const proc = createPluginProcess(pluginId, log)
    services.process = proc
    names.push('process')
    resourceDisposers.push(() => proc.dispose())
  }
  if (permissions.includes('secrets')) {
    services.secrets = createPluginSecrets(pluginId, log)
    names.push('secrets')
  }
  if (permissions.includes('schedule')) {
    const schedule = createPluginSchedule(pluginId, log)
    services.schedule = schedule
    names.push('schedule')
    resourceDisposers.push(() => schedule.dispose())
  }
  if (permissions.includes('attachments')) {
    services.attachments = createPluginAttachments(pluginId)
    names.push('attachments')
  }
  // rpcHost 不授予任何宿主能力，只把自己的方法暴露给自己的界面半边 → 总是可用
  services.rpcHost = createRpcHostService(pluginId)
  names.push('rpcHost')

  return {
    services,
    names,
    dispose(): void {
      // 拦截链先摘：否则卸载后一次审批仍会进到这个插件（其上下文已销毁）
      clearPluginWaterfalls(pluginId)
      clearPluginRpcs(pluginId)
      for (const dispose of resourceDisposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (e) {
          log.warn(`[plugin-services] 资源释放失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      for (const rec of registry.list()) {
        unregisterOwnedAgent(rec.agentId)
        void disposeAgent(rec.agentId).catch((e: any) => {
          log.warn(`[plugin-services] 卸载时会话释放失败（${rec.id}）: ${e instanceof Error ? e.message : String(e)}`)
        })
      }
      registry.clear()
    },
  }
}
