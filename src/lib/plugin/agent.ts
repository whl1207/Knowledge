/**
 * agent.ts — 界面半边插件的 `ctx.agent`（委派智能体）
 *
 * ## 为什么这条能力只能在界面半边（而不是主进程半边）
 *
 * 智能体预设与模型配置（provider / config / llmConfig）**只存在于渲染层**
 * （`store.agentPresets` + `store.AIconfig`，见 `src/types/agent.ts` 里 `AgentOptions` 的注释）。
 * 主进程半边要自己跑 agent，就得把预设与 AIconfig 复制一份过去 —— 同一份事实写两遍，
 * 是这个项目反复吃亏的那类缺陷。所以：**渲染层解析预设 → 主进程裁定预算并执行**。
 *
 * 代价（已核实、写进设计 §8.5 的 N1）：
 * - **主进程半边的 `ctx.tool` 无法委派**（工具在主进程跑，拿不到界面半边的能力；
 *   想补需要新增一条主机中介的 RPC + 主↔界面通道）；
 * - 因此"给模型一个会自己派活的工具"这种 DSH 式用法**做不到**，本能力只服务"插件面板自己想要一次 AI 回答"。
 *
 * ## 谁说了算
 *
 * 本模块**不做任何判权**：权限、首次同意、预算、工具裁剪、步数裁定全在主进程
 * （`electron/main/plugin-agent.ts`）。这里只做三件事：解析预设、过桥、把结果**再归一一次**。
 *
 * ## 无副作用可清理
 *
 * `run` 不注册任何全局监听（一次请求一次响应），因此在飞委派的取消**不靠卸载清理**，
 * 而靠主进程在插件卸载时统一 abort（`plugin-agent-budget.ts` 的 `abortPluginRuns`）。
 * `cancelAll()` 只是把这个动作暴露给插件（例如面板上的「停止」按钮）。
 */

import { normalizeAgentRunResult, toIpcSafe, type AgentRunResult } from './agentContract'
import type { PluginBridgeApi } from './bridge'

/** 预设摘要（给插件选预设用；与 `ctx.app.agentPresets()` 同源） */
export interface PluginAgentPreset {
  id: string
  name: string
  /** 该预设会带上的工具名（已按能力槽推导；实际委派时宿主要再裁一次） */
  tools: string[]
  /** 预设自带的步数上限（未配置则跟随「设置 → 智能体」的通用值） */
  maxSteps?: number
}

/**
 * 插件可以**申请**的委派要素。
 *
 * ⚠️ **模型不在其中**：provider / model / 来源 / 密钥一律来自用户配置的**预设**，
 * 插件无法指定（见 `PluginAgentRunOptions` 的说明）。这里是"插件能改什么"的完整清单。
 */
export interface PluginAgentOverrides {
  /** 覆盖预设的系统提示词（预设给基线，插件可在其上覆盖成自己的角色说明） */
  systemPrompt?: string
  /**
   * 覆盖交给被委派 agent 的工具白名单。
   * **这只是"申请"**：宿主（主进程）仍按插件声明的权限与用户在该插件上的放宽开关裁剪，
   * 裁掉哪些可以在插件日志里看到。
   */
  tools?: string[]
  /**
   * 按 **id** 引用**用户已配置**的 MCP 服务（插件不能自带 MCP 服务定义 —— 那等于允许插件任意起进程）。
   * 无效 id 会被忽略；实际能不能用 `mcp_call` 还要看用户在该插件上开的放宽开关。
   */
  mcpServerIds?: string[]
}

/**
 * 插件可以申请的预算 + 可覆盖的要素。
 *
 * **模型不可选**（无 `provider` / `model` / `baseUrl` / `apiKey`）：委派永远跑在用户配置的预设上。
 * 这条是刻意的：那两个自由度决定了"钱花在哪、用户数据发到哪"，不该由插件决定。
 */
export interface PluginAgentRunOptions extends PluginAgentOverrides {
  /** 墙钟超时；默认 10 分钟，上限 30 分钟 */
  timeoutMs?: number
  /** 单 turn 最大 step 数；默认 20，上限 60，且与预设值取 min */
  maxSteps?: number
  /** 每子 agent 的 token 上限；**v1 只记录不硬拦**（主进程尚不解析用量） */
  maxTokens?: number
}

/**
 * 把 `run()` 的 opts 拆成「预算」与「要素覆盖」两部分。
 *
 * **白名单式重建**，不是展开：JS 插件（没有类型检查）完全可以多传字段，
 * 而那些字段绝不允许搭车 —— 尤其是 `provider` / `model` / `llmConfig` / `config`
 * （能自己指定这些就等于绕过了"模型由用户决定"这条规矩）。
 */
export function splitAgentRunOptions(opts?: PluginAgentRunOptions): {
  budget: { timeoutMs?: number; maxSteps?: number; maxTokens?: number }
  overrides: PluginAgentOverrides
} {
  const src = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined)

  const budget: { timeoutMs?: number; maxSteps?: number; maxTokens?: number } = {}
  const timeoutMs = num(src.timeoutMs)
  const maxSteps = num(src.maxSteps)
  const maxTokens = num(src.maxTokens)
  if (timeoutMs !== undefined) budget.timeoutMs = timeoutMs
  if (maxSteps !== undefined) budget.maxSteps = maxSteps
  if (maxTokens !== undefined) budget.maxTokens = maxTokens

  const overrides: PluginAgentOverrides = {}
  if (typeof src.systemPrompt === 'string' && src.systemPrompt.trim() !== '') overrides.systemPrompt = src.systemPrompt
  const tools = strList(src.tools)
  if (tools) overrides.tools = tools
  const mcpServerIds = strList(src.mcpServerIds)
  if (mcpServerIds) overrides.mcpServerIds = mcpServerIds

  return { budget, overrides }
}

export interface PluginAgentApi {
  /** 是否可用（需清单声明 `permissions: ['agent.run']`，且运行在桌面端） */
  readonly available: boolean
  /** 不可用的原因（`available=false` 时给作者看的可读说明） */
  readonly reason?: string
  /** 可选预设清单（只读；不需要权限，与 `ctx.app.agentPresets()` 同源） */
  presets(): PluginAgentPreset[]
  /**
   * 跑一次委派：独立会话、独立预算，委派出的 agent **拿不到文件 / 命令类工具**。
   * 失败时 `ok=false` 且 `output` 是在中止前拿到的部分输出（不冒充成功）。
   */
  run(presetId: string, input: string, opts?: PluginAgentRunOptions): Promise<AgentRunResult>
  /** 取消本插件全部在飞委派（返回被取消的数量） */
  cancelAll(): Promise<{ cancelled: number }>
}

/** 预设解析结果（由渲染层的 `agentPresetOptions.ts` 提供，注入以便本模块可自测） */
export interface ResolvedAgentPreset {
  id: string
  name: string
  /** 预设自带的步数上限（会被带上去让主进程与插件申请取 min） */
  maxSteps?: number
  /** 组装好的 `AgentOptions`（provider / config / llmConfig / systemPrompt / tools / cwd / mcpServerIds） */
  options: unknown
}

export interface PluginAgentApiDeps {
  pluginId: string
  /** 清单是否声明了 `agent.run` */
  permitted: boolean
  /** 与 `createPluginLlmApi` / `createPluginFilesApi` 同一形状（插件日志走宿主缓冲） */
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
  /** 取插件桥；拿不到（例如网页端 / 测试环境）返回 null */
  bridge: () => PluginBridgeApi | null
  /**
   * 解析预设并**就地应用插件覆盖**（渲染层实现：读 store 里的预设与模型配置）。
   * 覆盖只涉及系统提示词 / 工具 / MCP 服务 id；模型与密钥由实现自己决定，插件无从干预。
   */
  resolvePreset: (presetId: string, overrides: PluginAgentOverrides) => ResolvedAgentPreset | null
  /** 列出可用预设（渲染层实现） */
  listPresets: () => PluginAgentPreset[]
}

export function createPluginAgentApi(deps: PluginAgentApiDeps): PluginAgentApi {
  const bridgeAgentRun = () => {
    const bridge = deps.bridge()
    return typeof bridge?.agentRun === 'function' ? bridge.agentRun.bind(bridge) : null
  }

  const unavailableReason = (): string | undefined => {
    if (!bridgeAgentRun()) {
      return '当前运行方式不支持委派智能体（需要桌面端；网页 / 移动端的本地宿主没有主进程可执行预算）'
    }
    if (!deps.permitted) {
      return '未声明 "agent.run" 权限（在 package.json 的 aikm.permissions 里加上它，然后重载插件）'
    }
    return undefined
  }

  return {
    get available() {
      return unavailableReason() === undefined
    },
    get reason() {
      return unavailableReason()
    },

    presets() {
      try {
        return deps.listPresets()
      } catch (e) {
        deps.log.warn(`列出预设失败：${e instanceof Error ? e.message : String(e)}`)
        return []
      }
    },

    async run(presetId, input, opts) {
      const why = unavailableReason()
      if (why) throw new Error(`[plugin:${deps.pluginId}] ctx.agent.run 不可用：${why}`)

      const id = String(presetId ?? '').trim()
      if (!id) throw new Error(`[plugin:${deps.pluginId}] ctx.agent.run 需要 presetId（用 ctx.agent.presets() 取可用 id）`)
      if (typeof input !== 'string' || !input.trim()) {
        throw new Error(`[plugin:${deps.pluginId}] ctx.agent.run 需要非空的 input`)
      }

      // 白名单拆分：预算走主进程裁定，要素覆盖在渲染层解析时就地生效；
      // 其余字段（例如插件多传的 provider / model）一律不进 payload。
      const { budget, overrides } = splitAgentRunOptions(opts)

      const preset = deps.resolvePreset(id, overrides)
      if (!preset) {
        const ids = deps.listPresets().map((p) => p.id).join(' / ') || '（无）'
        throw new Error(`[plugin:${deps.pluginId}] 没有叫「${id}」的智能体预设。可用：${ids}`)
      }

      const call = bridgeAgentRun()
      if (!call) throw new Error(`[plugin:${deps.pluginId}] ctx.agent.run 不可用：${unavailableReason()}`)

      const overridden = [
        overrides.systemPrompt !== undefined ? '系统提示词' : '',
        overrides.tools !== undefined ? `工具×${overrides.tools.length}` : '',
        overrides.mcpServerIds !== undefined ? `MCP×${overrides.mcpServerIds.length}` : '',
      ].filter(Boolean)
      deps.log.info(
        `委派智能体：预设「${preset.name}」，输入 ${input.length} 字`
          + (overridden.length ? `（覆盖：${overridden.join('、')}）` : ''),
      )
      // 过桥前**当场折一遍纯数据**：折不动就点名到"这个插件的这次请求"，
      // 而不是让 Electron 抛 `An object could not be cloned.`（插件作者无从下手）。
      // 预设解析器自己也折一遍；这里再折是兜底 —— 适配器对"任何 resolver 实现"都得成立。
      const payload = toIpcSafe(
        {
          pluginId: deps.pluginId,
          presetId: preset.id,
          presetName: preset.name,
          ...(preset.maxSteps !== undefined ? { presetMaxSteps: preset.maxSteps } : {}),
          input,
          // 只送白名单拆分后的预算 —— 直接送 `opts` 会让插件多传的字段（provider / model…）搭车过桥
          ...(Object.keys(budget).length ? { budget } : {}),
          options: preset.options,
        },
        `插件 ${deps.pluginId} 的 ctx.agent.run 请求`,
      )
      const raw = await call(payload)

      // 主进程已经归一过一次；这里**再归一一次**是刻意的：
      // `normalizeAgentRunResult` 幂等，而它保证「ok 由 termination 决定」这条不因通道两端实现差异而失守。
      const result = normalizeAgentRunResult(raw)
      deps.log[result.ok ? 'info' : 'warn'](
        `委派结束：${result.termination}（${result.turn} 轮，输出 ${result.output.length} 字）${result.error ? `｜${result.error}` : ''}`,
      )
      return result
    },

    async cancelAll() {
      const bridge = deps.bridge()
      const cancel = bridge?.agentCancel
      if (typeof cancel !== 'function') return { cancelled: 0 }
      try {
        return await cancel({ pluginId: deps.pluginId })
      } catch (e) {
        deps.log.warn(`取消在飞委派失败：${e instanceof Error ? e.message : String(e)}`)
        return { cancelled: 0 }
      }
    },
  }
}
