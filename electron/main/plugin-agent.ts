/**
 * plugin-agent.ts — 插件委派智能体的 IPC 通道（`plugin:agent-run`）
 *
 * 为什么**不**复用 `agent:run`：那是工作流「智能体节点」的接缝
 * （创建 → 发输入 → 等收敛 → 返回 `{ content, error?, timedOut, turn }`，每次新建并销毁），
 * 与插件委派需要的契约（预算裁定 + 首次同意 + D5 工具裁剪 + `termination` 归一）**不是同一份**。
 * 塞进同一个通道会让返回体随 payload 变形 —— 那种"一个通道两种语义"正是本项目反复踩过的坑。
 * 命名沿用插件能力通道的既有形状（`plugin:files:*` 之于 `plugin-agent-run`）。
 *
 * ## 判权与纵深防御（每一次调用都过五道）
 *
 * 1. **权限**：`pluginHost.get(id).permissions` 必须含 `agent.run`；
 * 2. **同意**：主进程弹框（`plugin-agent-consent`），三态；未答/无窗口 → 拒绝；
 * 3. **预算**：并发 + 每小时调用数（`plugin-agent-budget`）——占用即记账，finally 释放；
 * 4. **工具裁剪**：**在主进程再跑一次 D5**（界面半边已裁过一次；但那里的输入来自 localStorage
 *    里的预设定义，而插件能写 localStorage，所以主进程这份才是权威的）；
 * 5. **步数**：`options.maxSteps` 一律被宿主裁定值覆盖（只紧不松）。
 *
 * 插件从清单里拿不到的 provider / model / apiKey 也在这里被**丢弃**：只透传宿主认得的字段。
 */

import { IPCError } from '@/types/ipc'
import { registerIpc } from './ipc-registry'
import { pluginHost } from './plugin-host'
import { runDelegatedAgent } from './agent-loop'
import { acquireSlot, releaseSlot, trackController, usageSnapshot, abortPluginRuns, clearUsage } from './plugin-agent-budget'
import { resolveConsent, consentOf, setConsent, type AgentConsent } from './plugin-agent-consent'
import { requirePluginApproval } from './plugin-approval'
import { agentConfigOf, isAgentConfigCustomized, listAgentConfig, setAgentLimits, setAgentRelax, clearAgentConfig } from './plugin-agent-config'
import { approvalToolsOf } from './plugin-tool-approval'
import { toolApprovalOf } from './plugin-tool-approval-store'
import { normalizeAgentRunResult, resolveAgentRunBudget, delegableToolFilter, AGENT_RUN_LIMITS } from '@/lib/plugin/agentContract'
import type { AgentOptions } from '@/types/agent'

/**
 * 显式逐字段重建 `AgentOptions`（**不是** spread 整个 payload）。
 *
 * 两个作用：
 * 1. 插件无法借 `options` 夹带私货（如 `label` / `scope` / `seedHistory` / `parentId` 这些由宿主掌管的字段）；
 * 2. `provider` 缺失在这里就 fail-loud —— 它意味着渲染层没能把预设解析成模型来源，
 *    继续往下跑只会得到一句含混的底层报错。
 */
function pickOptions(raw: unknown): AgentOptions {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const provider = typeof src.provider === 'string' ? src.provider.trim() : ''
  if (!provider) throw new IPCError('INVALID_ARGUMENT', '缺少 provider（预设没有解析出模型来源）')

  return {
    provider,
    ...(typeof src.systemPrompt === 'string' ? { systemPrompt: src.systemPrompt } : {}),
    ...(src.config !== undefined ? { config: src.config } : {}),
    ...(src.llmConfig !== undefined ? { llmConfig: src.llmConfig } : {}),
    // `tools` 必须透传：它是**预设配置**（用户选的能力槽）的产物，主进程要在它之上再做 D5 裁剪。
    // 若不透传，被委派的 agent 反而会拿到"可委派全集"，比预设本意更宽 —— 方向反了。
    ...(Array.isArray(src.tools) ? { tools: src.tools as string[] } : src.tools === null ? { tools: null } : {}),
    // MCP：插件按 id 引用**用户已配置**的服务。configs 由渲染层从用户清单里按 id 取（见
    // agentPresetOptions.ts 的 resolvePluginMcpSelection）—— 主进程拿不到那份清单（它在渲染层
    // 的 localStorage），所以与聊天链路同一口径：信任渲染层，插件够不到 IPC。
    ...(Array.isArray(src.mcpServerIds) ? { mcpServerIds: src.mcpServerIds.map((x) => String(x)) } : {}),
    ...(Array.isArray(src.mcpServerConfigs) ? { mcpServerConfigs: src.mcpServerConfigs } : {}),
    ...(src.toolsPresentation === 'native' || src.toolsPresentation === 'code'
      ? { toolsPresentation: src.toolsPresentation }
      : {}),
    ...(typeof src.cwd === 'string' ? { cwd: src.cwd } : {}),
  }
}

export function registerPluginAgentIpc(): void {
  registerIpc('plugin:agent-run', async (payload) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')

    const snapshot = pluginHost.get(pluginId)
    if (!snapshot) throw new IPCError('NOT_FOUND', `插件未装载：${pluginId}`)

    // 1) 权限
    if (!(snapshot.permissions ?? []).includes('agent.run')) {
      throw new IPCError(
        'PERMISSION_DENIED',
        `插件 ${pluginId} 未声明 "agent.run" 权限（package.json 的 aikm.permissions 加 "agent.run"，然后重载插件）`,
      )
    }

    const input = String(payload?.input ?? '')
    if (!input.trim()) throw new IPCError('INVALID_ARGUMENT', '缺少 input')

    // 2) 先把 options 校验/重建好再往下走（fail fast）：
    //    否则会出现"先弹框问用户、用户点了允许、然后才发现 provider 缺失"这种糟糕顺序。
    const requested = pickOptions(payload?.options)

    // 3) 预算（先算出来，好在同意框里告知用户"最多几步 / 多久"）
    // 预设自己的步数上限由渲染层解析预设后带上来（主进程拿不到预设定义）；这里与插件申请取 min。
    const budget = resolveAgentRunBudget(payload?.budget, payload?.presetMaxSteps)

    // 4) 占名额（占用即记账；同意框还没答时也算占用，避免弹框期间并发穿透）
    const slot = acquireSlot(pluginId)
    if (!slot.ok) {
      throw new IPCError('PLUGIN_AGENT_BUDGET', slot.reason || '超出委派预算')
    }

    const controller = new AbortController()
    const untrack = trackController(pluginId, controller)
    try {
      // 5) 同意（主进程弹框）
      const consent = await resolveConsent({
        pluginId,
        pluginName: snapshot.name || pluginId,
        presetName: String(payload?.presetName ?? payload?.presetId ?? '(未命名预设)'),
        maxSteps: budget.maxSteps,
        timeoutMs: budget.timeoutMs,
      })
      if (consent !== 'allow') {
        return normalizeAgentRunResult({ termination: 'consent-denied', output: '', error: '用户未允许该插件调用智能体' })
      }

      // 6) D5 工具裁剪（主进程权威版）：插件可**申请**任意工具，但天花板在这里
      const cfg = agentConfigOf(pluginId)
      const filtered = delegableToolFilter({
        requestedTools: Array.isArray(requested.tools) ? (requested.tools as string[]) : null,
        pluginPermissions: snapshot.permissions ?? [],
        pluginOwnTools: snapshot.tools ?? [],
        relax: cfg.relax,
      })

      const options: AgentOptions = { ...requested, tools: filtered.allowed }
      if (filtered.denied.length) {
        console.info(`[plugin-agent] ${pluginId} 委派工具被裁剪：${filtered.denied.join(', ')}`)
      }

      return await runDelegatedAgent(options, input, budget, pluginId, controller.signal)
    } finally {
      untrack()
      releaseSlot(pluginId)
    }
  })

  /** 各插件的委派用量快照（设置页展示；只读） */
  registerIpc('plugin:agent-usage', () => usageSnapshot())

  /**
   * 某个插件的委派状态：同意 + 用量（设置页「插件 → 数据」展示）。
   *
   * 只读，不需要审批 —— 与 `plugin:files:grants` 同一口径（读自己的状态不该要确认）。
   */
  registerIpc('plugin:agent:status', (payload) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    const usage = usageSnapshot()[pluginId] ?? { inFlight: 0, callsInWindow: 0 }
    return { consent: consentOf(pluginId), inFlight: usage.inFlight, callsInWindow: usage.callsInWindow }
  })

  /**
   * 改写同意状态（设置页的「撤销同意」→ `ask`，或「改为拒绝」→ `deny`）。需用户确认。
   *
   * 与 `plugin:files:clear-grants` 一样走 `requirePluginApproval`：**通过界面**改也是用户的决定，
   * 所以由用户亲手确认。注意这条通道与"插件能不能自己给自己同意"无关 ——
   * 插件根本够不到 IPC（那条通用桥早已撤掉并有源码级护栏）。
   */
  registerIpc('plugin:agent:consent-set', (payload) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    const consent = String(payload?.consent ?? '').trim() as AgentConsent
    requirePluginApproval(payload, `修改插件 ${pluginId} 的委派同意`)
    if (!setConsent(pluginId, consent)) {
      throw new IPCError('INVALID_ARGUMENT', `非法同意值：${consent}（可用 allow / ask / deny）`)
    }
    return { consent: consentOf(pluginId) }
  })

  /** 清掉某插件的用量（设置页的「重置额度」：撞了每小时上限时不必等到窗口滑过）。需用户确认。 */
  registerIpc('plugin:agent:reset-usage', (payload) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    requirePluginApproval(payload, `重置插件 ${pluginId} 的委派用量`)
    return { cleared: clearUsage(pluginId) }
  })

  /**
   * 「插件权限」页签的总览：**每个已装插件一行**（同意 + 用量 + 额度 + 放宽开关 + 是否被改过）。
   *
   * 一次拿全而不是每插件一次调用 —— 面板是一张表，N 次往返会让它在插件多时明显卡顿。
   * 只读，不需要审批。
   */
  registerIpc('plugin:agent:overview', () => {
    const usage = usageSnapshot()
    const rows = pluginHost.list().map((p) => {
      const cfg = agentConfigOf(p.id)
      const u = usage[p.id] ?? { inFlight: 0, callsInWindow: 0 }
      return {
        pluginId: p.id,
        name: p.name || p.id,
        status: p.status,
        permissions: p.permissions ?? [],
        /** 是否声明了 agent.run（没声明的插件这一行的额度/放宽项无意义） */
        agentRunDeclared: (p.permissions ?? []).includes('agent.run'),
        consent: consentOf(p.id),
        inFlight: u.inFlight,
        callsInWindow: u.callsInWindow,
        limits: cfg.limits,
        relax: cfg.relax,
        /** 用户是否调过（面板据此显示"默认"） */
        customized: isAgentConfigCustomized(p.id),
        /** 工具审批三态（声明了 fs / shell 的插件，其工具默认要用户确认） */
        toolApproval: toolApprovalOf(p.id),
        /** 该插件里**需要审批**的工具名（为空表示它没有这类工具，这一列无意义） */
        approvalTools: approvalToolsOf(p.id),
      }
    })
    return { rows, limits: AGENT_RUN_LIMITS }
  })

  /**
   * 写某插件的额度与放宽开关（「插件权限」页签）。需用户确认。
   *
   * 这是**唯一**能让被委派 agent 拿到文件 / MCP 工具的入口 —— 插件自己够不到 IPC，
   * 只能用 `ctx.agent.run` 申请，是否放宽由用户在界面上亲手决定。
   */
  registerIpc('plugin:agent:config-set', (payload) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    if (!pluginHost.get(pluginId)) throw new IPCError('NOT_FOUND', `插件未装载：${pluginId}`)
    requirePluginApproval(payload, `修改插件 ${pluginId} 的委派额度与工具放宽`)

    const hasLimits = payload?.limits !== undefined
    const hasRelax = payload?.relax !== undefined
    const wantsReset = payload?.reset === true
    if (!hasLimits && !hasRelax && !wantsReset) {
      throw new IPCError('INVALID_ARGUMENT', 'limits / relax / reset 至少要给一个')
    }

    if (wantsReset) {
      // 「撤销自定义」= 把这一行的配置整条删掉，回到"默认"状态（面板据此不再标"已自定义"）。
      // 只写回默认值是不够的：那样 customized 仍为 true，界面会一直显示"已自定义"。
      clearAgentConfig(pluginId)
    } else {
      if (hasLimits) setAgentLimits(pluginId, payload.limits)
      if (hasRelax) setAgentRelax(pluginId, payload.relax)
    }
    const cfg = agentConfigOf(pluginId)
    console.info(
      `[plugin-agent] [audit] ${pluginId} 额度=${cfg.limits.concurrency}/${cfg.limits.callsPerHour}` +
        ` 放宽 fs=${cfg.relax.fs === true} mcp=${cfg.relax.mcp === true}${wantsReset ? '（已撤销自定义）' : ''}`,
    )
    return { pluginId, limits: cfg.limits, relax: cfg.relax, customized: isAgentConfigCustomized(pluginId) }
  })

  /**
   * 取消某插件全部在飞委派（插件面板上的「停止」按钮）。
   *
   * 信任模型与其它 `plugin:*` 通道一致：**宿主渲染层是受信调用方**，id 由调用方给出。
   * 插件侧够不到本通道，只能用 `ctx.agent.cancelAll()` —— 而适配器把**自己的** `pluginId` 写死在里面，
   * 所以插件取消不了别人的委派。真要按"调用方身份"判权，得先有 per-window 通道令牌（设计里列为后续项）。
   */
  registerIpc('plugin:agent-cancel', (payload) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    return { cancelled: abortPluginRuns(pluginId) }
  })
}
