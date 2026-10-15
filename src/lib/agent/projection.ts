/**
 * agentProjection.ts — agentBridge 会话视图 → 聊天消息投影（共享）
 *
 * 普通智能体（`useAgentRun.attachAgentToChat`）与集群成员（`swarmRunner`）
 * 共用同一套投影逻辑，保证「工具调用 / 思考时间线 / 知识库来源 / token 统计」
 * 在各模式下渲染数据完全一致（即样式与交互天然一致，不需要第二套 UI）。
 */

import { coerceTodoList } from '@/shared/agentTodo'

/** 步骤时间线投影结果 */
export interface StepProjectionResult {
  /** 本批次中最后一个工具单元（供输入区「最近工具」快照） */
  lastTool: any | null
}

/**
 * 步骤时间线 → `msg.executionUnits`。
 *
 * 按 step 顺序：先插该 step 的思考单元（reasoning 流式全量文本），再插正文单元（content），
 * 最后插该 step 的工具调用；思考可出现在工具之前或工具之间。
 * 同 id 合并时「有结果/已结束的优先」，防止中间态快照覆盖掉已带结果的条目。
 */
export function projectStepsToUnits(msg: any, v: any): StepProjectionResult {
  const units: any[] = []
  // 服务端搜索激活时（searchEvents 含 search/open/done 事件）：思考段由事件队列切分，
  // 这里不再生成聚合思考单元（仅 reasoning 事件 = 普通推理，仍由本投影生成，按 step 顺序穿插）
  const hasServerSearch = !!(v.searchEvents && v.searchEvents.some((e: any) => e && e.kind !== 'reasoning'))
  for (const step of v.steps || []) {
    // 思考单元：该 step 的模型思维链（流式），排在工具调用之前
    if (step.reasoning && !hasServerSearch) {
      units.push({
        id: `reasoning-${step.turn}-${step.step}`,
        status: step.endTime ? 'success' : 'running',
        stepType: 'reasoning',
        description: 'reasoning',
        args: undefined,
        result: step.reasoning,
        startTime: step.startTime,
        endTime: step.endTime,
      })
    }
    // 内容单元：该 step 的助手正文（思考/方案/中间说明/最终输出），按时间顺序穿插在工具调用之间。
    // 流式用 stream（累积），消息完成用 content；解决跨 step 时 msg.content 只保留最后一段导致
    // 前面的思考/方案正文丢失、无法按时间穿插的问题。
    const stepText = (step.stream || step.content || '').trim()
    if (stepText && !hasServerSearch) {
      units.push({
        id: `content-${step.turn}-${step.step}`,
        status: step.endTime ? 'success' : 'running',
        stepType: 'content',
        description: 'content',
        args: undefined,
        result: step.stream || step.content,
        startTime: step.startTime,
        endTime: step.endTime,
      })
    }
    for (const tc of step.toolCalls || []) {
      if (!tc.callId) continue
      units.push({
        id: tc.callId,
        status: tc.status === 'running' ? 'running' : tc.status === 'success' ? 'success' : 'error',
        stepType: 'tool',
        description: tc.name || '',
        // 参数（展示：工具入参 JSON）
        args: tc.args,
        result: tc.status === 'success' ? (tc.result?.value ?? tc.result) : undefined,
        error: tc.error,
        // UI 专用差异预览（编辑类工具；不参与模型上下文）
        preview: tc.preview,
        startTime: tc.startTime,
        endTime: tc.endTime,
      })
    }
  }
  // 上下文压缩：主进程在「开始生成摘要 / 结束」各推一个 agent/compaction 事件，
  // 这里投影成时间线里一张卡片（生成摘要要额外发一次 LLM 请求，不给提示会看起来像卡住）。
  const comp = v.compaction
  if (comp && comp.seq > 0 && comp.phase !== 'idle') {
    units.push({
      id: `context-compact-${comp.seq}`,
      status: comp.phase === 'running' ? 'running' : comp.phase === 'failed' ? 'error' : 'success',
      stepType: 'tool',
      description: 'context-compact',
      args: undefined,
      // 文案按当前语言在渲染层生成（本投影不依赖 store；见 home.vue 的 unitResultText）
      result: {
        phase: comp.phase,
        kind: comp.kind,
        droppedMessages: comp.droppedMessages,
        tokensBefore: comp.tokensBefore,
      },
      startTime: comp.startTime || Date.now(),
      endTime: comp.phase === 'running' ? undefined : (comp.endTime || Date.now()),
    })
  }
  if (!units.length) return { lastTool: null }

  // 按 id 合并：保留每个单元的最新状态（含已结束的），新单元按时间序追加。
  const existing = (msg.executionUnits || []).slice()
  for (const u of units) {
    const i = existing.findIndex((e: any) => e.id === u.id)
    if (i >= 0) {
      const prev = existing[i]
      const prevHasResult = prev && (prev.result !== undefined && prev.result !== null && prev.result !== '')
      const nextHasResult = u.result !== undefined && u.result !== null && u.result !== ''
      if (!prevHasResult || nextHasResult) existing[i] = u
    } else {
      existing.push(u)
    }
  }
  msg.executionUnits = existing

  // 压缩卡片不算工具调用：输入区「最近工具」快照不采纳
  const lastTool = [...units].reverse().find((u: any) => u.stepType === 'tool' && u.description !== 'context-compact') || null
  return { lastTool }
}

/**
 * kb_search 成功结果 → `msg.kbInfo`（「参考了 N 个知识片段」来源展示）。
 * @param processed 调用去重集合（同一 callId 只收集一次）
 */
export function projectKbInfo(msg: any, v: any, processed: Set<string>): void {
  for (const step of v.steps || []) {
    for (const tc of step.toolCalls || []) {
      if (tc.name !== 'kb_search' || tc.status !== 'success' || processed.has(tc.callId)) continue
      processed.add(tc.callId)
      const val = tc.result?.value ?? tc.result
      const blocks = Array.isArray(val?.blocks) ? val.blocks : []
      const kbPath = Array.isArray(val?.kbPaths) ? val.kbPaths[0] : val?.kbPath
      if (!blocks.length) continue
      const relevant = blocks.map((b: any) => ({
        label: b?.label || b?.filePath || '',
        content: b?.content || '',
        similarity: typeof b?.similarity === 'number' ? b.similarity : 0,
      }))
      msg.kbInfo = msg.kbInfo
        ? { kbPath: msg.kbInfo.kbPath, relevantBlocks: [...(msg.kbInfo.relevantBlocks || []), ...relevant] }
        : { kbPath: kbPath || '', relevantBlocks: relevant }
    }
  }
}

/**
 * 真实 token 统计回填：最后一步 promptTokens = 真实上下文占用（圆环用）；
 * totalTokens = 累计消耗。
 */
export function projectUsage(msg: any, v: any): void {
  if (!v.lastUsage) return
  msg.tokenStats = {
    promptTokens: v.lastUsage.promptTokens || 0,
    completionTokens: v.lastUsage.completionTokens || 0,
    totalTokens: v.usageTotal || v.lastUsage.totalTokens || 0,
    duration: Date.now() - (msg._startTime || Date.now()),
  }
}

/**
 * 待办清单（update_todo 维护）→ `chat.agentTodos`。
 *
 * 两层兜底：
 * - **状态归一**：旧版本把模型原始状态直接落盘（可能含 `in_progress` / `completed`），
 *   这里统一经 `coerceTodoList` 归一，避免界面出现无法识别的状态；
 * - **本地已确认状态优先**：用户手动勾选的 done / cancelled 不被 agent 之后发来的
 *   全量清单覆盖（同一条（同 id）以本地为准）。
 */
export function projectTodos(ownerChat: any, v: any): void {
  if (!Array.isArray(v.todos) || !ownerChat) return
  const prev: any[] = Array.isArray(ownerChat.agentTodos) ? ownerChat.agentTodos : []
  const existingMap = new Map(prev.map((t: any) => [String(t.id), t]))
  const prevByText = new Map(prev.map((t: any) => [String(t.title || '').trim(), t]))
  ownerChat.agentTodos = coerceTodoList(v.todos, prev).map((t: any) => {
    const existing: any = existingMap.get(String(t.id)) || prevByText.get(String(t.title || '').trim())
    if (existing && (existing.status === 'done' || existing.status === 'cancelled')) {
      return { ...t, status: existing.status }
    }
    return t
  })
}

/**
 * 执行计划（update_plan / exit_plan_mode 维护）→ `chat.agentPlan`。
 *
 * 与待办清单同样随聊天存档落盘：会话日志是会话内的事实源，
 * 聊天存档是跨会话的事实源；重开聊天时后者作为 seed 回到新会话（再落盘一条 plan/write）。
 */
export function projectPlan(ownerChat: any, v: any): void {
  if (!ownerChat) return
  if (typeof v.plan === 'string') ownerChat.agentPlan = v.plan
  else if (v.plan === null) ownerChat.agentPlan = null
}

/**
 * 计划评审（exit_plan_mode）→ `chat.pendingPlanReview`（聊天存档级的恢复源）。
 *
 * - 会话里有挂起评审 → 记下 reviewId / plan / 会话 id（进程被杀也不会丢）；
 * - 评审已被回答或取消 → 清掉本地标记（决策由调用方另行记入 `chat.planDecision`）。
 */
export function projectPlanReview(ownerChat: any, v: any): void {
  if (!ownerChat) return
  const review = v?.pendingPlanReview
  if (review) {
    ownerChat.pendingPlanReview = {
      reviewId: String(review.reviewId || ''),
      plan: String(review.plan || ''),
      sessionId: String(v?.id || ''),
    }
    return
  }
  if (ownerChat.pendingPlanReview && ownerChat.pendingPlanReview.sessionId === String(v?.id || '')) {
    ownerChat.pendingPlanReview = null
  }
}
