/**
 * executorLlm.ts — 纯 LLM 执行器（Step 2 尾段，移植自 TableReason/tableReasonAgent.ts）
 *
 * 一单元 = N 次纯 LLM 补全（每个目标列一次；structured=true 时整行一次输出 JSON 对象）。
 * 不使用 agentBridge 会话（无工具 / 无多轮），走 store.sendToAI —— 快且省 token。
 *
 * 对等要点（对照移植，行为不变）：
 *   - 每行先渲染「任务指令」（config.template，含 {{列名}} 占位符）= 该行的任务 + 数据；
 *     旧任务（指令为空）回退旧行为：勾选的源列拼【源列信息】块（读旧任务时已迁移为指令）；
 *   - 指令留空 → 按列名语义自动分析（AUTO_TAIL 三档指令）；
 *   - 结构化输出走 parseJsonObject 容错解析（围栏 / 切片 / 白名单宽松兜底）；
 *   - token 由 sendToAI 的 onComplete(metadata) 累计。
 * 差异说明：失败不在此层重试（交由 runner 的通用行级重试统一处理，避免双重重试）。
 */

import { renderPrompt, renderTemplate } from './render'
import { parseJsonObject } from './parsers'
import type {
  BatchConfig, BatchCallbacks, ExecutorContext, ExecutorDeps, ExecutorOutcome,
  PipelineExecutor, PipelineSchemaField, PipelineUnit,
} from './types'

export class LlmExecutor implements PipelineExecutor {
  readonly kind = 'llm' as const
  private config: BatchConfig
  private store: any
  private callbacks: BatchCallbacks
  private deps: ExecutorDeps
  /** 进行中的 LLM 请求（按行 id 分组：可只中止某一行；abort() 中止全部） */
  private aborts = new Map<string, Set<AbortController>>()
  // token 统计（累计）
  private totalInput = 0
  private totalOutput = 0

  constructor(config: BatchConfig, store: any, callbacks: BatchCallbacks = {}, deps?: ExecutorDeps) {
    this.config = config
    this.store = store
    this.callbacks = callbacks
    this.deps = deps || { log: () => {}, isStopRequested: () => false }
  }

  /** 新一轮批量的 token 归零（runner.start 调用） */
  resetTokens(): void {
    this.totalInput = 0
    this.totalOutput = 0
  }

  /** 停止：中止所有进行中的 LLM 请求 */
  abort(): void {
    for (const set of this.aborts.values()) for (const c of set) c.abort()
    this.aborts.clear()
  }

  /** 只中止某一行的进行中请求（行详情「停止」；其它行不受影响） */
  abortRow(rowId: string): void {
    const set = this.aborts.get(rowId)
    if (!set) return
    for (const c of set) c.abort()
    this.aborts.delete(rowId)
  }

  /** 登记 / 注销某一行的进行中请求 */
  private trackAbort(rowId: string, c: AbortController): void {
    let set = this.aborts.get(rowId)
    if (!set) { set = new Set(); this.aborts.set(rowId, set) }
    set.add(c)
  }
  private untrackAbort(rowId: string, c: AbortController): void {
    const set = this.aborts.get(rowId)
    if (!set) return
    set.delete(c)
    if (!set.size) this.aborts.delete(rowId)
  }

  // ==================== 执行 ====================
  /** 执行一个单元：逐目标列推理（structured 时整行一次）→ 返回多值结果（sink=writeBack 落盘） */
  async run(unit: PipelineUnit, ctx: ExecutorContext): Promise<ExecutorOutcome> {
    // 输出字段（逐列写回的目标列 = 结构化提取的提取字段，同一张 schema 列表）
    const fields = (this.config.schema || []).filter((f) => f.name.trim())
    if (!fields.length) throw new Error('请先配置至少一个输出字段')
    if (!this.instructionBlock(unit, ctx.rowIndex).text && !(this.config.sourceColumns || []).length) {
      throw new Error('请先填写任务指令')
    }

    const values: Record<string, string> = {}
    if (this.config.structured) {
      Object.assign(values, await this.inferStructured(unit, fields, ctx))
    } else {
      for (const field of fields) {
        if (ctx.isStopRequested()) return { ok: false, error: '已手动停止' }
        const v = await this.inferCell(unit, field, ctx)
        if (v) values[field.name] = v
      }
    }
    return { ok: true, values }
  }

  /**
   * 任务指令块（每行渲染一次）：优先渲染 config.template（含 {{列名}} 占位符）——
   * 它就是“这一行要做什么 + 用到哪些数据”；为空时回退旧「源列注入」（旧任务已迁移，此处仅兜底）。
   */
  private instructionBlock(unit: PipelineUnit, rowIdx: number): { text: string; fromTemplate: boolean } {
    const tpl = this.config.template || ''
    if (tpl.trim()) {
      return { text: renderTemplate(tpl, { ...(unit.data || {}), ...(unit.roundRefs || {}) }, rowIdx, this.config.keepUnmatched), fromTemplate: true }
    }
    const srcParts: string[] = []
    for (const name of this.config.sourceColumns || []) {
      const v = unit.data?.[name]
      if (v !== undefined && v !== null && String(v).trim()) srcParts.push(`${name}: ${v}`)
    }
    return { text: srcParts.length ? `【源列信息】\n${srcParts.join('\n')}` : '', fromTemplate: false }
  }

  /** 单单元格推理：构造 prompt → 纯 LLM 补全 → 返回该字段结果（错误冒泡给 runner 判失败/重试） */
  private async inferCell(unit: PipelineUnit, field: PipelineSchemaField, ctx: ExecutorContext): Promise<string> {
    const rowIdx = ctx.rowIndex
    // 任务指令（每行渲染一次）：该行要做什么 + 通过 {{列名}} 注入的数据
    const instr = this.instructionBlock(unit, rowIdx)
    // 字段推理指令（description；支持 {{列名}}，按单元格渲染；留空 = 按字段名语义自动分析）
    const rendered = renderPrompt(field.description || '', { ...unit.data, rowIndex: String(rowIdx + 1) })
    const AUTO_TAIL = `只输出「${field.name}」的结果本身，不要任何解释、引号、列名前缀或前后缀。`
    const taskBlock = rendered
      ? `请完成以下任务，${AUTO_TAIL}\n\n${rendered}`
      : instr.fromTemplate
        ? `请按以上任务指令，自行判断「${field.name}」这一列应填写的内容并给出结果。\n${AUTO_TAIL}`
        : instr.text
          ? `请阅读以上【源列信息】，自行判断「${field.name}」这一列应填写的内容并给出结果。\n${AUTO_TAIL}`
          : `请为「${field.name}」推理出结果。\n${AUTO_TAIL}`
    const userMsg = [instr.text, taskBlock].filter(Boolean).join('\n\n')

    const controller = new AbortController()
    this.trackAbort(unit.id, controller)
    try {
      ctx.log('info', `[行${rowIdx + 1}·${field.name}] 推理中...`)
      const content: string = await this.store.sendToAI(
        [{ role: 'user', content: userMsg }],
        {
          signal: controller.signal,
          onComplete: (_c: string, metadata?: any) => { this.addTokens(metadata, unit.id) },
        },
      )
      return content && content.trim() ? content.trim() : ''
    } catch (error: any) {
      if (!ctx.isStopRequested()) ctx.log('error', `[行${rowIdx + 1}·${field.name}] 失败: ${error?.message || error}`)
      // 带上字段名再抛（runner 的失败日志即为「异常: [字段名] 原因」，不重复记录）
      throw new Error(`[${field.name}] ${error?.message || error}`)
    } finally {
      this.untrackAbort(unit.id, controller)
    }
  }

  /** 结构化模式：构造「一次产出全部输出字段」的提示词 */
  private buildStructuredPrompt(unit: PipelineUnit, fields: PipelineSchemaField[], rowIdx: number): string {
    // 任务指令（每行渲染一次）——替代原【源列信息】块（旧任务无指令时由 instructionBlock 回退）
    const instr = this.instructionBlock(unit, rowIdx)

    const lines = fields.map((f, i) => {
      const rendered = renderPrompt(f.description || '', { ...unit.data, rowIndex: String(rowIdx + 1) })
      return rendered
        ? `${i + 1}. 【${f.name}】${rendered}`
        : `${i + 1}. 【${f.name}】无额外指令：请根据字段名语义，自行从任务指令提供的信息中分析提取该字段应填写的内容。`
    })
    const jsonShape = `{${fields.map((f) => `"${f.name}": "..."`).join(', ')}}`
    return [
      instr.text,
      `请基于以上信息，为下列每一个输出字段分别给出结果（同一行内各字段相互独立）：\n${lines.join('\n')}`,
      `只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释、不要新增其他键；值为该字段结果的字符串（查不到内容则该键给空字符串）：\n${jsonShape}`,
    ].filter(Boolean).join('\n\n')
  }

  /** 结构化模式：整行一次调用 → 解析 JSON → 返回全部输出字段的值（错误冒泡给 runner） */
  private async inferStructured(unit: PipelineUnit, fields: PipelineSchemaField[], ctx: ExecutorContext): Promise<Record<string, string>> {
    const rowIdx = ctx.rowIndex
    const userMsg = this.buildStructuredPrompt(unit, fields, rowIdx)
    const names = fields.map((f) => f.name)
    const controller = new AbortController()
    this.trackAbort(unit.id, controller)
    try {
      ctx.log('info', `[行${rowIdx + 1}] 结构化推理 ${fields.length} 个字段...`)
      const content: string = await this.store.sendToAI(
        [{ role: 'user', content: userMsg }],
        {
          signal: controller.signal,
          onComplete: (_c: string, metadata?: any) => { this.addTokens(metadata, unit.id) },
        },
      )
      const obj = parseJsonObject(content, names)
      if (!obj) throw new Error(`输出不是合法 JSON: ${String(content || '').slice(0, 80)}`)
      const values: Record<string, string> = {}
      let hit = 0
      for (const f of fields) {
        const v = obj[f.name]
        if (v === undefined || v === null) continue
        const s = typeof v === 'string' ? v.trim() : JSON.stringify(v)
        if (s) { values[f.name] = s; hit++ }
      }
      if (!hit) throw new Error('JSON 中没有任何输出字段的值')
      ctx.log('info', `[行${rowIdx + 1}] 结构化完成（${hit}/${fields.length} 个字段）`)
      return values
    } catch (error: any) {
      if (!ctx.isStopRequested()) ctx.log('error', `[行${rowIdx + 1}] 结构化失败: ${error?.message || error}`)
      throw error
    } finally {
      this.untrackAbort(unit.id, controller)
    }
  }

  /** 累计 token（sendToAI 的 onComplete metadata）；rowId 非空时同时回传该行用量 */
  private addTokens(metadata?: any, rowId = ''): void {
    const pt = Number(metadata?.prompt_tokens ?? metadata?.promptTokens ?? 0) || 0
    const ct = Number(metadata?.completion_tokens ?? metadata?.completionTokens ?? 0) || 0
    this.totalInput += pt
    this.totalOutput += ct
    this.callbacks.onTokenUsage?.(this.totalInput, this.totalOutput, this.totalInput + this.totalOutput)
    if (rowId && (pt || ct)) this.callbacks.onRowTokenUsage?.(rowId, pt, ct)
  }
}
