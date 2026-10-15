/**
 * agent（智能体）执行器
 *
 * Dify 的 agent 节点跑在插件策略上（`agent_strategy_*` 驱动 function_calling / ReAct），
 * 本地没有插件运行时；这里把它映射到 **AI-KM 智能体预设**：
 * 预设的 systemPrompt / 能力槽（工具白名单）/ 技能 / 知识库 / MCP / 循环轮数
 * 经 `@/lib/agent/presetOptions` 组装成 AgentOptions，交给渲染层 agentBridge
 * （主进程 agent 循环）执行——与聊天、集群、批量走同一套提示词与工具注册表。
 *
 * 节点字段（本地语义）：
 * - `agent_preset_id`：选用的智能体预设 id（空 = 通用智能体，自主规划）
 * - `query`：任务输入模板（`{{#节点.变量#}}` 插值）
 * - `model`：模型覆盖（provider 为空 = 跟随预设 / 全局），与大语言模型节点同形状
 * - `max_steps`：循环轮数覆盖
 * - `tools_override`：工具白名单覆盖
 * - `structured_output`：要求最终回答为 JSON，解析结果进 `json` 输出
 * Dify 侧的 `agent_strategy_*` / `agent_parameters` / `output_schema` 原样保留但本地不执行，
 * 运行时给出提示（避免「配了策略却以为生效」）。
 */
import { agentBridge, type AgentSessionView } from '@/platform/agentBridge'
import { buildPresetAgentOptions } from '@/lib/agent/presetOptions'
import { resolveText, stringifyValue } from '../template'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from '../types'

/** Dify agent 节点的策略入参（本地不执行，仅用于兜底取任务输入） */
function difyQuery(data: Record<string, unknown>): string {
  const params = data.agent_parameters
  if (!params || typeof params !== 'object') return ''
  const query = (params as Record<string, any>).query
  const value = query && typeof query === 'object' ? query.value : query
  return typeof value === 'string' ? value.trim() : ''
}

/** 结果对象里可能承载产出文件的字段名（export_word / write_file 等） */
const FILE_PATH_KEYS = ['path', 'file_path', 'filePath', 'output_path', 'outputPath']

/** 从工具调用结果里收集产出文件路径（去重） */
function collectFiles(view: AgentSessionView | undefined): string[] {
  const files: string[] = []
  for (const step of view?.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      if (call.status === 'running') continue
      let value: any = call.result
      if (value && typeof value === 'object' && 'value' in value) value = (value as any).value
      if (typeof value === 'string' && value.trim().startsWith('{')) {
        try { value = JSON.parse(value) } catch { /* 非 JSON 字符串结果，忽略 */ }
      }
      if (!value || typeof value !== 'object') continue
      for (const key of FILE_PATH_KEYS) {
        const path = (value as Record<string, unknown>)[key]
        if (typeof path === 'string' && path.trim() && !files.includes(path.trim())) files.push(path.trim())
      }
    }
  }
  return files
}

/** 解析 JSON 数组输出（容忍 ```json 代码块包裹与对象单值） */
function parseJsonArray(text: string): Array<Record<string, unknown>> | null {
  const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  if (!clean) return null
  try {
    const parsed = JSON.parse(clean)
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>
    if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>]
  } catch { /* 走下面的数组片段兜底 */ }
  const match = clean.match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>
    } catch { /* 解析失败：交给调用方提示 */ }
  }
  return null
}

/** 结构化输出要求（追加到 system prompt 末尾） */
function structuredInstruction(zh: boolean): string {
  return zh
    ? '最终回答必须是一个 JSON（对象或数组），不要包含解释文字、不要用 Markdown 代码块包裹；字段名与用户要求的保持一致。'
    : 'Your final answer must be a single JSON value (object or array), with no explanation and no Markdown code fence.'
}

export const agentExecutor: WorkflowNodeExecutor = {
  type: 'agent',
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const store: any = ctx.store
    const data = ctx.node as unknown as Record<string, unknown>
    if (!agentBridge.available) {
      throw new Error('智能体节点需要桌面端 agent 运行环境（当前环境不可用）')
    }

    // —— 智能体预设 ——
    const presetId = stringifyValue(data.agent_preset_id).trim()
    const preset = presetId ? (store.agentPresets || []).find((item: any) => item.id === presetId) : undefined
    if (presetId && !preset) ctx.log('warning', `找不到智能体预设「${presetId}」，本次按通用智能体执行`)

    // Dify 的策略参数本地不执行：明确提示，不静默忽略
    if (stringifyValue(data.agent_strategy_name).trim() || data.agent_parameters) {
      ctx.log('warning', 'Dify 的 agent 策略（agent_strategy_* / agent_parameters）在本地不执行，已改用智能体预设的能力配置')
    }

    // —— 任务输入：本地 query 优先，回退 Dify 的策略入参 ——
    const rawQuery = stringifyValue(data.query).trim() || difyQuery(data)
    if (!rawQuery) throw new Error('请先填写任务输入（query）')
    const { value: query, warnings } = resolveText(rawQuery, ctx.pool)
    for (const warning of warnings) {
      ctx.log('warning', `任务输入引用 ${warning.selector.join('.')} 没有数据，已留空`)
    }
    if (!query.trim()) throw new Error('任务输入为空（引用的上游变量都没有值）')

    const structured = data.structured_output === true
    const maxSteps = Number(data.max_steps)
    const toolsOverride = Array.isArray(data.tools_override) ? (data.tools_override as string[]) : null
    const { options, tools } = await buildPresetAgentOptions({
      store,
      preset,
      // 无预设（通用智能体）时，节点上的指令可作为自定义提示词
      customPrompt: preset ? undefined : stringifyValue(data.instruction).trim() || undefined,
      toolsOverride,
      model: data.model && typeof data.model === 'object' ? (data.model as any) : null,
      maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : undefined,
      label: `workflow:${preset?.name || 'agent'}`,
      scope: `workflow-${ctx.nodeId}`,
      interactive: false,
      extraAppend: structured ? structuredInstruction(store.locales !== 'en') : undefined,
    })
    ctx.log('info', `智能体「${preset?.name || (store.locales === 'en' ? 'General' : '通用智能体')}」启动：${tools.length} 个工具，最多 ${options.maxSteps} 步`)

    const view = await agentBridge.create(options)
    const abort = (): void => { void agentBridge.cancel(view.id, 'user').catch(() => { /* 已收敛 */ }) }
    if (ctx.signal.aborted) abort()
    ctx.signal.addEventListener('abort', abort, { once: true })

    try {
      let streamed = ''
      let currentStep = -1
      const reported = new Set<string>()
      const content = await new Promise<string>((resolve, reject) => {
        let sawRunning = false
        let settled = false
        const finish = (done: () => void): void => {
          if (settled) return
          settled = true
          unsub()
          done()
        }
        const unsub = agentBridge.on((v) => {
          if (v.id !== view.id) return
          if (v.status === 'running') sawRunning = true

          // 流式文本：按 step 重算（currentStream 是「当前 step」的累计文本）
          if (v.step !== currentStep) {
            currentStep = v.step
            streamed = ''
          }
          if (v.currentStream && v.currentStream !== streamed) {
            streamed = v.currentStream
            ctx.emitStream(streamed)
          }

          // 步骤与工具调用 → 运行日志（工作流面板里能看见智能体做了什么）
          for (const step of v.steps ?? []) {
            for (const call of step.toolCalls ?? []) {
              if (call.status === 'running' || reported.has(call.callId)) continue
              reported.add(call.callId)
              const detail = call.error
                ? `（失败：${call.error}）`
                : `（${call.status === 'success' ? '完成' : '未完成'}）`
              ctx.log(call.error ? 'warning' : 'info', `第 ${step.step} 步调用工具 ${call.name}${detail}`)
            }
          }

          if (v.pendingQuestion || v.pendingPlanReview) {
            // 工作流是单次运行，没有人在线回答：直接取消，避免整条流程悬挂
            const what = v.pendingPlanReview
              ? `计划评审（exit_plan_mode）：${String(v.pendingPlanReview.plan || '').slice(0, 120)}`
              : `人工输入：${v.pendingQuestion?.question ?? ''}`
            ctx.log('warning', `智能体请求${what}，但工作流运行期无人应答，已取消本次请求`)
            void agentBridge.cancel(view.id, 'user').catch(() => { /* 已收敛 */ })
          }
          if (v.lastError) {
            finish(() => reject(new Error(v.lastError!)))
            return
          }
          if (v.status === 'idle' && sawRunning && !v.pendingQuestion && !v.pendingPlanReview) {
            finish(() => resolve(v.lastAssistantContent || streamed || ''))
          }
        })
        agentBridge.send(view.id, query, 'workflow').catch((error) => finish(() => reject(error)))
      })

      if (ctx.signal.aborted) throw new Error('已中止')
      if (!content.trim()) throw new Error('智能体没有返回内容')

      const json = structured ? (parseJsonArray(content) ?? []) : []
      if (structured && !json.length) {
        ctx.log('warning', '结构化输出解析失败，json 输出为空（text 保留模型原样回答）')
      }
      return { outputs: { text: content, files: collectFiles(agentBridge.get(view.id)), json } }
    } finally {
      ctx.signal.removeEventListener('abort', abort)
      await agentBridge.dispose(view.id).catch(() => { /* 已销毁 */ })
    }
  },
}
