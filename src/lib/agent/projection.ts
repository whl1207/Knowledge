/**
 * agentProjection.ts — agentBridge 会话视图 → 聊天消息投影（共享）
 *
 * 普通智能体（`useAgentRun.attachAgentToChat`）与集群成员（`swarmRunner`）
 * 共用同一套投影逻辑，保证「工具调用 / 思考时间线 / 知识库来源 / token 统计」
 * 在各模式下渲染数据完全一致（即样式与交互天然一致，不需要第二套 UI）。
 */

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

  const lastTool = [...units].reverse().find((u: any) => u.stepType === 'tool') || null
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
 * 兜底：保留用户手动确认的状态（done/cancelled），避免 agent 之后发来的全量 todo 覆盖本地已确认状态。
 */
export function projectTodos(ownerChat: any, v: any): void {
  if (!Array.isArray(v.todos) || !ownerChat) return
  const existingMap = new Map((ownerChat.agentTodos || []).map((t: any) => [String(t.id), t]))
  ownerChat.agentTodos = v.todos.map((t: any) => {
    const id = String(t.id || t.title || Math.random().toString(36).slice(2))
    const existing: any = existingMap.get(id)
    const next = {
      id,
      title: t.title || t.name || '',
      status: t.status || 'pending',
      detail: t.detail,
    }
    if (existing && (existing.status === 'done' || existing.status === 'cancelled')) {
      next.status = existing.status
    }
    return next
  })
}
