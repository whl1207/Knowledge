// pipelineRunner.ts - Agent脚手架核心逻辑（调度层）
// 选择导入表格（Excel/CSV）→ 任务指令（{{列名}} 占位符）→ 逐行渲染 prompt → 并发执行独立 Agent 会话
// （复用 agentBridge 主进程 agent-loop）→ 结果写回结果列 → 可导出 / 保存恢复 / 失败重试
//
// 与 CollectFile/CollectWeb 的差异：本模块每行 = 一个「完整智能体」会话
// （含工具调用/多轮推理），而非单次 LLM 提取；执行路径复用 agentBridge。
// 注：运行期 scope/label（'batch' / 'agent-batch'）为对照移植保留，暂不改名（Step 2 再统一）。
//
// 抽象重组（Step 2）：
//   - 类型定义     → ./types.ts（PipelineUnit / PipelineConfig + 执行器/汇聚器接口）
//   - 占位符引擎   → ./render.ts（renderTemplate / extractPlaceholders）
//   - 智能体执行器 → ./executorAgent.ts（provider 解析 / MCP 服务选择 / AgentOptions 组装）
//   本文件保留「并发调度 + 状态机 + 日志 + token + 停止续跑 + 重跑」等通用运行器职责；
//   文件末尾对上述模块做原样再导出（旧导入路径兼容，UI 无需改动）。

import { agentBridge } from '@/platform/agentBridge'
import { buildMcpServersContext, ensureAgentSkills, workspaceRoot } from '@/lib/agent/promptContext'
import { batchMcpServers, AgentExecutor } from './executorAgent'
import { LlmExecutor } from './executorLlm'
import { ExtractExecutor } from './executorExtract'
import { sinkOf, makeDataRowsSink } from './sinks'
import { normalizeUrl, hostOf, PIPELINE_TITLE_FIELD, PIPELINE_LINKS_FIELD } from './fetch'
import { effectiveContentSource, resolveContentField, resolveTextFieldName } from './types'
import type {
  BatchConfig, BatchRow, BatchCallbacks, BatchWorkerInfo, BatchRowStatus,
  BatchRowTraceStep, BatchRowTraceCall, ExecutorContext, ExecutorDeps, ExecutorOutcome,
  PipelineExecutor, PipelineSink,
} from './types'

// ==================== 兼容再导出（旧导入路径 / 符号名不变） ====================
export type {
  BatchRow, BatchConfig, BatchWorkerInfo, BatchCallbacks, BatchRowStatus,
  BatchRowTraceCall, BatchRowTraceStep,
  PipelineUnit, PipelineConfig, PipelineRowStatus,
  ExecutorOutcome, ExecutorContext, PipelineExecutor, PipelineSink,
  PipelinePreset, PipelineSourceKind, PipelineExecutorKind, PipelineSinkKind,
} from './types'
export { renderTemplate, extractPlaceholders } from './render'
export { buildBatchAgentOptions, batchMcpServers, effectiveLlmType } from './executorAgent'
export type { BatchRuntimeContext } from './executorAgent'

/** 过程快照保留的行数上限（内存，FIFO 淘汰；不落盘） */
const TRACE_KEEP_ROWS = 1000
/** 单行过程快照的压缩参数：避免 10w 行批量把内存吃满 */
const TRACE_MAX_STEPS = 10
const TRACE_LIMIT = { reasoning: 800, content: 800, args: 400, result: 1200 }
/** 批量重跑逐行打日志的行数上限（超过只打汇总，避免日志被刷爆） */
const RERUN_LOG_ROWS = 20
/** 并发数上限（设置项「并发数」的硬上限；UI / 调度器 / 主进程远端限流共用同一量级） */
export const MAX_CONCURRENCY = 500

// ==================== 核心 Agent 类 ====================
export class BatchAgent {
  private config: BatchConfig
  private callbacks: BatchCallbacks
  private store: any
  private isRunning: boolean = false
  private stopRequested: boolean = false
  private rows: BatchRow[] = []
  private concurrency: number = 5
  /** 当前批量运行的并发声明作用域 id（setConcurrency 运行中改并发时重新声明用） */
  private runScopeId: string = ''
  private activeTasks: Set<Promise<void>> = new Set()
  private taskQueue: Array<() => Promise<void>> = []
  // 并发线程日志追踪 — 固定槽位
  private workers: Map<number, BatchWorkerInfo> = new Map()
  private availableSlots: number[] = []
  /** 执行器（agent / llm，按 config.executorKind 选择；Step 2 拆出，行为等价） */
  private executor!: PipelineExecutor
  /** 结果汇聚器（resultColumn / writeBack / dataRows，按 config.sinkKind 选择） */
  private sink!: PipelineSink
  /** 提取出的结构数据（sink=dataRows：数据集由本类持有，汇聚器就地合并；UI 经 getDataset/onDatasetUpdate 读写） */
  private dataset: Array<Record<string, any>> = []
  /** 本批一次性解析的 MCP 服务工具清单（避免逐行重复连接 MCP 服务） */
  private mcpContext: string = ''
  // 行 id → 索引（避免 runRow/rowTitle 的 O(N) findIndex，批量 10w+ 行时必须 O(1)）
  private rowIndexMap: Map<string, number> = new Map()
  /** 已保留过程快照的行（插入序 = FIFO 淘汰顺序） */
  private traceRows: Map<string, BatchRow> = new Map()
  // 已到达终态（完成/失败/跳过）的行数：O(1) 增量维护，避免 computeProgress 每次 O(N) 过滤
  private processedCount: number = 0
  /** urls 源：已入队/已存在页面的 URL 去重集（规范化后比较） */
  private urlSeen: Set<string> = new Set()

  constructor(config: BatchConfig, store: any, callbacks: BatchCallbacks = {}, opts?: { dataset?: Array<Record<string, any>> }) {
    this.config = config
    this.store = store
    this.callbacks = callbacks
    this.concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, config.concurrency || 5))
    // 执行器：agent（agentBridge 会话）/ llm（纯补全）/ extract（结构化提取），按配置选择；
    // 日志出口与停止判定回接到本类，保持 worker.logs 写入与 onLog 回调行为不变
    const deps: ExecutorDeps = {
      log: (level, message, workerId, detail) => this.log(level, message, workerId, detail),
      isStopRequested: () => this.stopRequested,
    }
    const kind = config.executorKind || 'agent'
    // 执行器回调：额外接一层「按行 token」——纯 LLM / 提取模式没有 agent 会话，
    // 行上的 Token 只能由执行器回传（agent 模式由组件的会话监听累加），这里直接记到行上
    const execCallbacks: BatchCallbacks = {
      ...callbacks,
      onRowTokenUsage: (rowId, inputTokens, outputTokens) => {
        const idx = this.rowIndexMap.get(rowId)
        const row = idx === undefined ? undefined : this.rows[idx]
        if (!row) return
        row.inputTokens = (row.inputTokens || 0) + inputTokens
        row.outputTokens = (row.outputTokens || 0) + outputTokens
        this.callbacks.onRowUpdate?.(row)
      },
    }
    this.executor = kind === 'llm'
      ? new LlmExecutor(config, store, execCallbacks, deps)
      : kind === 'extract'
        ? new ExtractExecutor(config, store, execCallbacks, deps)
        : new AgentExecutor(config, store, execCallbacks, deps)
    // 汇聚器：resultColumn / writeBack 用静态汇聚器；dataRows 时数据集由本类持有，注入读写访问
    if ((config.sinkKind || 'resultColumn') === 'dataRows') {
      if (opts?.dataset?.length) this.dataset = opts.dataset.slice()
      this.sink = makeDataRowsSink({
        schema: () => this.config.schema,
        getData: () => this.dataset,
        notify: () => this.callbacks.onDatasetUpdate?.(this.dataset),
        log: (level, message) => this.log(level, message),
        // 来源列取值：文本源取文本字段值；抓取类任务取网页地址字段值；其余回退文件路径链
        sourceOf: (unit) => {
          const kind = this.config.sourceKind || 'table'
          if (kind === 'text') return String(unit.data?.[resolveTextFieldName(this.config)] || '')
          if (effectiveContentSource(this.config) === 'url') return String(unit.data?.[this.config.contentField || ''] || '')
          return ''
        },
        // 行号（1 起）：写进数据集记录 `_rowNo`，导出时按「产生该条数据的任务行」合并原表列 / 运行信息
        rowNoOf: (unit) => Number(this.rowIndexMap.get(unit.id) ?? -1) + 1,
        // 重跑结果策略（缺省 replace）：重跑前先清掉本行上次产出的记录
        rerunMode: () => this.config.rerunResultMode,
      })
    } else {
      this.sink = sinkOf(config.sinkKind)
    }
  }

  /** 提取数据集（sink=dataRows；UI 用于渲染数据表、保存/恢复任务文件） */
  getDataset(): Array<Record<string, any>> {
    return this.dataset
  }

  get running(): boolean {
    return this.isRunning
  }

  /** 当前应生效的并发数：运行中始终读最新 config（UI 调整即时生效），1~MAX_CONCURRENCY */
  private currentConcurrency(): number {
    const n = Number(this.config?.concurrency)
    return Number.isFinite(n) && n >= 1 ? Math.min(MAX_CONCURRENCY, Math.floor(n)) : this.concurrency
  }

  /** 运行中调整并发：更新调度上限；已运行且并发被调高时拾取排队任务，并同步远端并发声明 */
  setConcurrency(n: number): void {
    const next = Number.isFinite(n) ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(n))) : this.concurrency
    if (next === this.concurrency) return
    this.concurrency = next
    if (this.isRunning && this.runScopeId) {
      agentBridge.declareConcurrency(this.runScopeId, next).catch(() => {})
    }
    // 触发 drainQueue：调高并发时立即多拾取排队任务；调低则等当前任务结束后自然收敛
    this.drainQueue()
    this.callbacks.onWorkerUpdate?.(Array.from(this.workers.values()))
  }

  /** 取一个空闲线程槽；不足时按需扩容（运行中把并发调高时需要更多槽位） */
  private acquireSlot(): number {
    if (this.availableSlots.length > 0) return this.availableSlots.shift()!
    // 扩容：id 取当前槽数（保持与 UI workerSlots 按 id 补齐展示一致）
    const id = this.workers.size
    this.workers.set(id, { id, label: `线程${id + 1}`, rowTitle: '', logs: [], rowCount: 0 })
    this.callbacks.onWorkerUpdate?.(Array.from(this.workers.values()))
    return id
  }

  // ==================== 并发任务调度（对齐 CollectFileAgent） ====================
  private enqueueTask(fn: () => Promise<void>): void {
    this.taskQueue.push(fn)
    this.drainQueue()
  }

  private drainQueue(): void {
    while (this.taskQueue.length > 0 && this.activeTasks.size < this.currentConcurrency()) {
      const task = this.taskQueue.shift()!
      const promise = task().finally(() => {
        this.activeTasks.delete(promise)
        this.drainQueue()
      })
      this.activeTasks.add(promise)
    }
  }

  /**
   * 高优先级入队：插到任务队列最前（手动重跑 / 空内容重跑）——
   * 当前有任一线程空闲即立即执行；全部忙碌时排在本批其它排队任务之前，
   * 任一线程一结束（drainQueue）即最先被取走。
   */
  private enqueueTaskFront(fn: () => Promise<void>): void {
    this.taskQueue.unshift(fn)
    this.drainQueue()
  }

  /**
   * 批量高优先级入队：一次把整块插到队首（`concat` 为 O(n+m)），
   * 取代逐行 `enqueueTaskFront`（每次 unshift 都是 O(n)，选上千行时是 O(n²)）。
   */
  private enqueueTasksFront(tasks: Array<() => Promise<void>>): void {
    if (!tasks.length) return
    this.taskQueue = tasks.concat(this.taskQueue)
    this.drainQueue()
  }

  private async waitForAllTasks(): Promise<void> {
    while (this.activeTasks.size > 0 || this.taskQueue.length > 0) {
      if (this.activeTasks.size > 0) {
        await Promise.race(this.activeTasks)
      } else {
        break
      }
    }
  }



  // ==================== 主入口 ====================
  /**
   * 启动/续跑批量执行。
   * @param onlyRowIds 选区执行：只执行这些行（必须是 pending）；不传 = 执行全部待处理行。
   *   「精确重跑某段」依赖此参数——否则表里其它待处理行会被一起跑掉。
   */
  async start(rows: BatchRow[], onlyRowIds?: Set<string>): Promise<{ success: boolean; error?: string }> {
    if (this.isRunning) return { success: false, error: '任务正在运行中' }
    // 任务指令校验仅 agent 执行器需要（llm 用任务指令+目标列指令 / extract 用字段定义，各自在执行器内部校验）
    if ((this.config.executorKind || 'agent') === 'agent' && !this.config.template.trim()) {
      return { success: false, error: '请先填写任务指令' }
    }
    const inScope = (r: BatchRow) => !onlyRowIds || onlyRowIds.has(r.id)
    if (!rows.some((r) => inScope(r) && r.status === 'pending')) {
      return { success: false, error: onlyRowIds ? '选区内没有待处理的行任务' : '没有待处理的行任务' }
    }

    this.isRunning = true
    this.stopRequested = false
    this.stoppedRowIds.clear()
    this.rows = rows
    this.executor.resetTokens?.()
    // urls 抓取任务：初始化页面去重集（已有行的网址字段，规范化后比较），保证重复链接不会再次入队
    this.urlSeen.clear()
    if (this.usesUrlContent()) {
      const field = resolveContentField(this.config)
      for (const r of rows) {
        const u = String(r.data?.[field] || '')
        if (u) this.urlSeen.add(normalizeUrl(u))
      }
    }
    // 建立 O(1) 行索引，并初始化终态计数（续跑时从既有状态恢复）
    this.rowIndexMap.clear()
    this.traceRows.clear()
    let terminal = 0
    rows.forEach((r, i) => {
      this.rowIndexMap.set(r.id, i)
      if (r.status === 'completed' || r.status === 'failed' || r.status === 'skipped') terminal++
    })
    this.processedCount = terminal

    // 初始化并发槽位（按启动时的并发数）；运行中调高并发时由 acquireSlot 按需扩容
    this.workers.clear()
    this.availableSlots = []
    for (let i = 0; i < this.currentConcurrency(); i++) {
      this.workers.set(i, { id: i, label: `线程${i + 1}`, rowTitle: '', logs: [], rowCount: 0 })
      this.availableSlots.push(i)
    }
    this.callbacks.onWorkerUpdate?.(Array.from(this.workers.values()))
    this.executor.subscribe?.()

    // 编排并发意图：运行期把「远端大模型并发」跟随本批量并发数（远程自托管后端限流按此生效），
    // 使模型侧实际并发与「并发数」设置一致；结束/停止时在 finally 里撤销
    const runScopeId = `agent-batch:${Date.now()}`
    this.runScopeId = runScopeId
    await agentBridge.declareConcurrency(runScopeId, this.currentConcurrency()).catch(() => {})

    const pending = rows.filter((r) => inScope(r) && r.status === 'pending')
    const execKindForLabel = this.config.executorKind || 'agent'
    const modeLabel = execKindForLabel === 'llm' ? '纯 LLM 推理' : execKindForLabel === 'extract' ? '结构化提取' : '批量智能体执行'
    this.log('info', `开始${modeLabel}: ${pending.length} 个任务，并发数 ${this.concurrency}${onlyRowIds ? '（仅执行选定行）' : ''}`)
    if (onlyRowIds) {
      // 选区执行：明确告知其它待处理行不会被本次带跑（避免用户以为“全都跑了”）
      const rest = rows.filter((r) => !inScope(r) && r.status === 'pending').length
      if (rest > 0) this.log('info', `本次为选区执行：另有 ${rest} 行待处理未纳入本次执行（点 ▶ 可继续）`)
    }
    const execKind = this.config.executorKind || 'agent'
    if (execKind === 'llm') {
      // 纯 LLM 执行器：无工作区/MCP/预设概念，只报告输出字段
      this.mcpContext = ''
      const fields = (this.config.schema || []).filter((f) => f.name.trim())
      this.log('info', `执行方式: 纯 LLM 推理（${this.config.structured ? '结构化输出' : '逐列推理'}），输出字段: ${fields.map((f) => f.name).join(', ')}`)
    } else if (execKind === 'extract') {
      // 结构化提取执行器：同样无工作区/MCP/预设概念
      this.mcpContext = ''
      const fields = (this.config.schema || []).map((f) => f.name)
      if (this.usesUrlContent()) {
        const followLabel = ({ none: '不跟随', 'same-host': '同域', keyword: '关键词', all: '全部' } as Record<string, string>)[this.config.urlFollow || 'none'] || '不跟随'
        const maxDepth = Math.max(0, Number(this.config.urlMaxDepth ?? 1))
        const maxPages = Math.max(1, Number(this.config.urlMaxPages) || 50)
        this.log('info', `执行方式: 纯 LLM 推理（结构化提取），字段: ${fields.join(', ')}`)
        this.log('info', `爬取设置: 链接跟随=${followLabel}，最大深度=${maxDepth}，最大页面数=${maxPages}，分析对象=${this.config.urlBody === 'links' ? '链接清单' : '页面正文'}`)
      } else {
        this.log('info', `执行方式: 纯 LLM 推理（结构化提取），字段: ${fields.join(', ')}（分段调用）`)
      }
    } else {
      // 工作区：既作为工具 cwd（相对路径锚点），也由共享组装函数注入每个 Agent 的 system prompt
      const wsRoot = workspaceRoot(this.store)
      this.log('info', wsRoot
        ? `工作区: ${wsRoot}（已注入每个 Agent 的上下文，工具相对路径基于该目录）`
        : '未设置工作区：工具相对路径将基于程序工作目录，建议先在左侧知识管理中打开一个工作区')
      // 技能库：与聊天/工作流/集群同一引导（按 store.skillsPath 加载，并告知主进程 skillService 技能根目录）
      // 日志里直接可见「注入了几个技能」，避免技能库为空时静默不注入（模型只能靠猜技能名）
      const skillsPath = String(this.store?.skillsPath || '').trim()
      const skillBriefs = await ensureAgentSkills(this.store)
      if (!skillsPath) {
        this.log('warn', '未设置技能文件夹：技能库清单与预设勾选的技能都无法注入，请先在 设置 → 技能 中选择技能文件夹')
      } else if (skillBriefs.length === 0) {
        this.log('warn', `技能文件夹内未找到可用技能（${skillsPath}）`)
      } else {
        this.log('info', `技能库: 已加载 ${skillBriefs.length} 个可用技能（${skillsPath}）`)
      }
      // 预设勾选的技能若在当前技能库中找不到（技能目录变更 / 技能改名），明确提示——否则会静默不注入
      const presetForSkills = this.config.presetId
        ? (this.store?.agentPresets || []).find((p: any) => p.id === this.config.presetId)
        : undefined
      const selectedKeys: string[] = Array.isArray(presetForSkills?.selectedSkills) ? presetForSkills.selectedSkills : []
      if (selectedKeys.length > 0) {
        const paths = new Set(skillBriefs.map((s) => s.path))
        const names = new Set(skillBriefs.map((s) => s.name))
        const missing = selectedKeys.filter((k) => !paths.has(k) && !names.has(k))
        if (missing.length > 0) {
          this.log('warn', `预设勾选的 ${missing.length} 个技能未匹配到（技能目录或技能名已变化），本次不会注入：${missing.join('、')}`)
        }
      }
      // MCP：整批只解析一次工具清单（连接服务较慢），各行复用同一段上下文
      this.mcpContext = ''
      try {
        const mcpServers = batchMcpServers(this.config, this.store)
        if (mcpServers.length > 0) {
          this.mcpContext = await buildMcpServersContext(mcpServers, this.store?.locales)
          if (this.mcpContext) this.log('info', `MCP: 已注入 ${mcpServers.length} 个服务的工具清单到每个 Agent 的上下文`)
        }
      } catch { /* MCP 不可用不影响批量执行 */ }
      this.log('info', this.config.presetId ? `使用预设智能体: ${this.getPresetName()}` : '使用通用智能体')
      if ((this.config.sinkKind || 'resultColumn') === 'dataRows') {
        const fields = (this.config.schema || []).map((f) => f.name).filter(Boolean)
        this.log('info', `输出方式: 结构化提取（智能体最后输出 JSON），字段: ${fields.join(', ')}，结果按主键合并进数据表`)
      }
      const llmInfo = `${this.config.llmType === 'agent' ? '跟随智能体' : (this.config.llmType || '跟随全局')}${this.config.model ? ' / ' + this.config.model : ''}`
      this.log('info', `LLM 后端: ${llmInfo}`)
    }

    for (const row of rows) {
      if (!this.isRunning) break
      if (row.status !== 'pending') continue
      if (!inScope(row)) continue
      this.enqueueTask(async () => {
        if (!this.isRunning || row.status !== 'pending') return
        await this.runRow(row)
      })
    }

    try {
      await this.waitForAllTasks()
    } finally {
      this.executor.unsubscribe?.()
      // 撤销本批量声明的远端并发（完成/手动停止都回到全局基准）
      await agentBridge.revokeConcurrency(runScopeId).catch(() => {})
      this.isRunning = false
    }
    const stats = this.computeStats()
    this.log('info', `批量执行完成: 成功 ${stats.success}，失败 ${stats.failed}，跳过 ${stats.skipped}`)
    this.callbacks.onAllDone?.(stats)
    return { success: true }
  }

  private getPresetName(): string {
    const p = (this.store?.agentPresets || []).find((x: any) => x.id === this.config.presetId)
    return p?.name || this.config.presetId
  }

  private computeStats(): { success: number; failed: number; skipped: number } {
    let success = 0
    let failed = 0
    let skipped = 0
    for (const r of this.rows) {
      if (r.status === 'completed') success++
      else if (r.status === 'failed') failed++
      else if (r.status === 'skipped') skipped++
    }
    return { success, failed, skipped }
  }

  private rowIndex(row: BatchRow): number {
    return this.rowIndexMap.get(row.id) ?? -1
  }

  private rowTitle(row: BatchRow): string {
    const idx = this.rowIndex(row)
    const first = Object.values(row.data || {})[0]
    const title = first !== undefined && first !== null && String(first).trim() ? String(first) : '(空)'
    return `行${idx + 1} · ${title.slice(0, 30)}`
  }

  /** O(1) 就地状态迁移：增量维护 processedCount 并通知 UI */
  private setRowStatus(row: BatchRow, status: BatchRowStatus): void {
    const from = row.status
    if (from === status) return
    row.status = status
    const terminal = (s: BatchRowStatus) => s === 'completed' || s === 'failed' || s === 'skipped'
    if (terminal(status) && !terminal(from)) this.processedCount++
    else if (!terminal(status) && terminal(from)) this.processedCount--
    this.callbacks.onStatusChange?.(row.id, from, status)
    this.callbacks.onRowUpdate?.(row)
  }

  private computeProgress(): void {
    this.callbacks.onProgress?.(this.processedCount, this.rows.length)
  }

  // ==================== 执行单行 ====================
  private async runRow(row: BatchRow): Promise<void> {
    const idx = this.rowIndex(row)
    const slotIndex = this.acquireSlot()
    const worker = this.workers.get(slotIndex)!
    worker.rowTitle = this.rowTitle(row)
    this.callbacks.onWorkerUpdate?.(Array.from(this.workers.values()))

    row.startedAt = new Date().toISOString()
    row.error = undefined
    // 重跑 / 重试时 Token 归零：行上的 Token 列与开始 / 结束时间、步数同一口径（= 本轮），
    // 否则重跑会从上一次的数值上继续累加（越跑越大）
    row.inputTokens = 0
    row.outputTokens = 0
    this.setRowStatus(row, 'running')

    // 空内容自动重跑标记：outcome 为空时置位，finally 末尾统一入队（避开会话释放竞态）
    let emptyRerunQueued = false
    // 空内容重跑已达上限判失败：抑制 finally 的失败自动重试，避免超出用户设定的重跑上限
    let suppressRetry = false

    try {
      if (!this.isRunning) {
        this.setRowStatus(row, 'pending')
        return
      }
      worker.rowCount++
      this.log('info', `[行${idx + 1}] 开始执行`, slotIndex)

      // 错峰启动：各线程首请求按线程槽位错开 staggerMs*i ms（0 号线程不延迟），
      // 缓解多线程同时压向远端 LM Studio 导致的并发空回 / 500
      const staggerMs = Math.max(0, Number(this.config.staggerMs) || 0)
      if (staggerMs > 0 && slotIndex > 0 && this.isRunning && !this.stopRequested) {
        await new Promise((r) => setTimeout(r, staggerMs * slotIndex))
        if (!this.isRunning || this.stopRequested) {
          this.setRowStatus(row, 'pending')
          return
        }
      }

      // 执行交给执行器（占位符渲染 / 建会话或调 LLM / 等待结果均在其内部，行为与拆分前一致）
      const execCtx: ExecutorContext = {
        slotIndex,
        rowIndex: idx,
        log: (level, message, detail) => this.log(level, message, slotIndex, detail),
        isStopRequested: () => this.stopRequested,
        attachSession: (unit, viewId) => {
          unit.viewId = viewId
          this.callbacks.onRowSessionStart?.(unit, viewId)
        },
        runtime: { mcpContext: this.mcpContext },
      }
      const outcome = await this.executor.run(row, execCtx)
      // 用户单独停了这一行：取消会话/请求后收尾为「跳过」（不判失败、不自动重试）
      if (this.consumeStopped(row)) {
        row.error = undefined
        this.setRowStatus(row, 'skipped')
        this.log('info', `[行${idx + 1}] 已手动停止（标记为跳过）`, slotIndex)
        return
      }
      // urls 源：行结束后按发现的链接扩展 frontier（停止时不扩展；新行插入队尾排队执行）
      this.expandDiscovery(row, slotIndex, outcome)

      if (this.stopRequested) {
        this.setRowStatus(row, 'pending')
        row.error = undefined
      } else if (outcome.ok) {
        // 空内容判定：整轮正常结束但无任何有效文本/值 → 按配置策略收尾（内容语义由汇聚器判定）
        const hasText = this.sink.hasContent(outcome)
        // 结构化提取但没解析出任何记录（例如模型没按 JSON 输出）：内容不能丢——把模型原始输出保留到行上
        // （行详情「输出」可直接看，导出会自动带上「原始输出」列，否则该行在导出的数据表里会彻底消失）
        if (!hasText && (this.config.sinkKind || 'resultColumn') === 'dataRows' && String(outcome.rawText || '').trim()) {
          row.result = String(outcome.rawText).trim()
          // 不碰 row.extracted：与其它分支一致，解析失败时保留上一次提取到的记录
          const action = this.config.emptyAction || ''
          const limit = Math.max(0, Number(this.config.emptyRetryLimit) || 0)
          if (action === 'rerun' && row.emptyRetryCount < limit) {
            // 同「空内容处理 = 自动重跑」：模型没按 JSON 回答时也自动重试，达上限则按完成收尾（保留原文）
            row.emptyRetryCount++
            row.error = undefined
            this.setRowStatus(row, 'pending')
            emptyRerunQueued = true
            this.log('warning', `[行${idx + 1}] 未解析出结构化数据，第 ${row.emptyRetryCount}/${limit} 次自动重跑...`, slotIndex)
          } else {
            this.setRowStatus(row, 'completed')
            this.log('warning', `[行${idx + 1}] 未解析出结构化数据（模型未返回合法 JSON）——原始输出已保留在该行；导出会自动带上「原始输出」列`, slotIndex)
          }
        } else if (!hasText) {
          // 空内容（本轮未产出有效内容）：除非配置了替换文本，否则保留原结果，避免把旧结果冲掉
          const action = this.config.emptyAction || ''
          if (action === 'replace' && this.sink.applyEmptyText) {
            this.setRowStatus(row, 'completed')
            this.sink.applyEmptyText(row, this.config.emptyReplaceText || '')
            this.log('warning', `[行${idx + 1}] 模型返回为空，已按配置替换为指定文本`, slotIndex)
          } else if (action === 'rerun') {
            const limit = Math.max(0, Number(this.config.emptyRetryLimit) || 0)
            if (row.emptyRetryCount < limit) {
              row.emptyRetryCount++
              // 保留旧结果：本轮回空不冲掉既有结果，跑出新结果再替换
              row.error = undefined
              this.setRowStatus(row, 'pending')
              emptyRerunQueued = true
              this.log('warning', `[行${idx + 1}] 模型返回为空，第 ${row.emptyRetryCount}/${limit} 次自动重跑...`, slotIndex)
            } else {
              this.setRowStatus(row, 'failed')
              row.error = `模型连续 ${limit} 次返回空内容（已达自动重跑上限）`
              suppressRetry = true
              this.log('error', `[行${idx + 1}] ${row.error}`, slotIndex)
            }
          } else {
            // 无操作：按完成；本轮无有效文本则不覆盖，保留原结果
            this.setRowStatus(row, 'completed')
            this.log('warning', `[行${idx + 1}] 模型返回为空（未配置空内容处理，保留原结果）`, slotIndex)
          }
        } else {
          this.setRowStatus(row, 'completed')
          // 重跑 = 替换：落盘新结果前先清掉该行上次产出的记录（rerunResultMode='replace'，缺省）
          this.sink.resetRow?.(row)
          this.sink.apply(row, outcome)
          this.log('info', `[行${idx + 1}] 完成`, slotIndex)
        }
      } else {
        this.setRowStatus(row, 'failed')
        row.error = outcome.error
        this.log('error', `[行${idx + 1}] 失败: ${outcome.error}`, slotIndex)
      }
    } catch (error: any) {
      if (this.stopRequested) {
        this.setRowStatus(row, 'pending')
        row.error = undefined
      } else if (this.consumeStopped(row)) {
        // 单行停止会把请求中止成异常 → 同样按「跳过」收尾
        row.error = undefined
        this.setRowStatus(row, 'skipped')
        this.log('info', `[行${idx + 1}] 已手动停止（标记为跳过）`, slotIndex)
      } else {
        this.setRowStatus(row, 'failed')
        row.error = error.message || String(error)
        this.log('error', `[行${idx + 1}] 异常: ${row.error}`, slotIndex)
      }
      // 抓取成功但后续步骤（如 LLM 提取）抛错时，本页已解析出的链接仍应延续爬取轨迹
      this.expandDiscovery(row, slotIndex)
    } finally {
      // 释放会话前先把过程快照留在行上（内存，供详情回看；不落盘）
      if (row.viewId) {
        const view: any = agentBridge.get(row.viewId)
        if (view) this.snapshotRowTrace(row, view)
        this.callbacks.onRowSessionEnd?.(row, row.viewId)
        await this.executor.cleanup?.(row)   // 清理观察状态 + dispose 会话 + 置空 row.viewId
      }
      row.finishedAt = new Date().toISOString()
      this.callbacks.onRowUpdate?.(row)
      this.computeProgress()

      worker.rowTitle = ''
      this.availableSlots.push(slotIndex)
      this.callbacks.onWorkerUpdate?.(Array.from(this.workers.values()))

      // 失败自动重试（未被停止时；空内容达上限的失败不叠加自动重试）。
      // 若“失败重试=0”但属于后端瞬态错误（HTTP 5xx / 网络层，如远程 LM Studio 过载返回 500），
      // 仍自动整行重跑至多 3 次并指数退避，避免瞬时故障把任务直接判死终止。
      if (row.status === 'failed' && !suppressRetry && this.isRunning && !this.stopRequested) {
        const transientFail = this.isTransientBackendError(row.error) && (this.config.retry || 0) <= 0
        const retryLimit = transientFail ? 3 : (this.config.retry || 0)
        if (row.retryCount < retryLimit) {
          row.retryCount++
          this.setRowStatus(row, 'pending')
          const backoff = transientFail ? Math.round(1500 * Math.pow(2, Math.min(row.retryCount - 1, 4))) : 0
          const kind = transientFail ? '后端瞬态错误' : '失败'
          this.log('warning', `[行${idx + 1}] ${kind}，第 ${row.retryCount} 次${transientFail ? '自动重跑' : '重试'}${backoff ? `（${backoff}ms 后）` : ''}...`, slotIndex)
          this.enqueueTask(async () => {
            if (!this.isRunning || this.stopRequested || row.status !== 'pending') return
            if (backoff > 0) {
              await new Promise((r) => setTimeout(r, backoff))
              if (!this.isRunning || this.stopRequested || row.status !== 'pending') return
            }
            await this.runRow(row)
          })
        }
      }
      // 空内容自动重跑：在本行会话释放（dispose）之后再入队并优先调度，避免与清理产生竞态
      if (emptyRerunQueued && this.isRunning && !this.stopRequested) {
        this.enqueueTaskFront(async () => {
          if (!this.isRunning || this.stopRequested || row.status !== 'pending') return
          await this.runRow(row)
        })
      }
    }
  }

  /** 是否为后端瞬态错误（HTTP 5xx / 网络层 / 抓取超时）；这类错误即使“失败重试=0”也应自动整行重跑 */
  private isTransientBackendError(msg?: string): boolean {
    const m = String(msg || '')
    return (
      /状态码[:：] ?5\d\d/i.test(m) ||
      /status[:：] ?5\d\d/i.test(m) ||
      /HTTP ?5\d\d/i.test(m) ||
      /HTTP错误|HTTP error/i.test(m) ||
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|failed to fetch|network error/i.test(m) ||
      /超时|timed? ?out/i.test(m)
    )
  }

  // ==================== url 抓取任务：frontier 动态扩展 ====================
  /** 是否使用网页抓取作为内容获取（内容获取=url）：决定 frontier 扩展是否生效 */
  private usesUrlContent(): boolean {
    return effectiveContentSource(this.config) === 'url'
  }

  /** 构造一个起始/子链接任务行（网址存到取值字段；depth/parentUrl 记录轨迹） */
  private makeUrlRow(url: string, depth: number, parentUrl: string): BatchRow {
    const field = resolveContentField(this.config) || 'text'
    return {
      id: `row_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      data: { [field]: url, [PIPELINE_TITLE_FIELD]: '', [PIPELINE_LINKS_FIELD]: '' },
      status: 'pending',
      inputTokens: 0, outputTokens: 0, retryCount: 0, emptyRetryCount: 0,
      meta: { depth, parentUrl },
    }
  }

  /**
   * 把某行发现的链接变成新的待处理行（爬取轨迹的“下一步”）：
   * - 只对 urls 源生效；停止/未运行时静默跳过
   * - 去重（规范化 URL）、深度上限、最大页面数上限
   * - 链接跟随策略：none 不跟随 / same-host 同域 / keyword 关键词（URL 匹配）/ all 全部
   * - 新行插入队尾排队执行；同时取回响应式代理对象，保证 UI 能跟踪后续状态变化
   */
  private expandDiscovery(row: BatchRow, slotIndex: number, outcome?: ExecutorOutcome): void {
    if (!this.usesUrlContent() || !this.isRunning || this.stopRequested) return
    const links: string[] = (outcome?.ok && outcome.links?.length ? outcome.links : null)
      || (Array.isArray(row.meta?.discoveredLinks) ? (row.meta!.discoveredLinks as string[]) : [])
    if (!links.length) return
    const follow = this.config.urlFollow || 'none'
    if (follow === 'none') return
    const maxDepth = Math.max(0, Number(this.config.urlMaxDepth ?? 1))
    const depth = Number(row.meta?.depth ?? 0) || 0
    if (depth >= maxDepth) return

    const maxPages = Math.max(1, Number(this.config.urlMaxPages) || 50)
    const myUrl = String(row.data?.[resolveContentField(this.config)] || '')
    const myHost = hostOf(myUrl)
    const kws = String(this.config.urlKeywords || '').toLowerCase().split(',').map(k => k.trim()).filter(Boolean)
    const added: BatchRow[] = []
    let capped = false
    for (const raw of links) {
      if (this.rows.length + added.length >= maxPages) { capped = true; break }
      const norm = normalizeUrl(String(raw || ''))
      if (!norm || this.urlSeen.has(norm)) continue
      if (follow === 'same-host' && hostOf(norm) !== myHost) continue
      if (follow === 'keyword' && kws.length) {
        const low = norm.toLowerCase()
        const hit = kws.some(k => low.includes(k) || low.includes(encodeURIComponent(k).toLowerCase()))
        if (!hit) continue
      }
      this.urlSeen.add(norm)
      added.push(this.makeUrlRow(String(raw), depth + 1, myUrl))
    }
    if (capped) this.log('warning', `已达最大页面数 ${maxPages}，本页其余链接不再加入队列`, slotIndex)
    if (!added.length) return

    // 入列：push 后取回响应式代理（UI 侧的行对象需为代理，后续状态变化才能驱动刷新）
    const proxies: BatchRow[] = []
    for (const u of added) {
      this.rows.push(u)
      const stored = this.rows[this.rows.length - 1]
      this.rowIndexMap.set(stored.id, this.rows.length - 1)
      proxies.push(stored)
    }
    this.callbacks.onRowsAdded?.(proxies)
    this.log('info', `本页发现 ${added.length} 个新链接并加入队列（深度 ${depth + 1}，队列共 ${this.rows.length} 页）`, slotIndex)
    for (const u of proxies) {
      this.enqueueTask(async () => {
        if (!this.isRunning || this.stopRequested || u.status !== 'pending') return
        await this.runRow(u)
      })
    }
  }

  // ==================== 手动重跑 ====================
  /**
   * 运行中批量重跑（选区重跑）：一次把整批行并入队首，返回实际受理行数。
   * - 执行中的行、不属于本批次的行会被跳过；
   * - 批量未运行/已请求停止时返回 0（调用方应改用「置 pending + 选区启动」）；
   * - 行数较多时只打一条汇总日志（逐行明细仍会在各行真正执行时输出）。
   */
  requestRerunBatch(rows: BatchRow[]): number {
    if (!this.isRunning || this.stopRequested) return 0
    const tasks: Array<() => Promise<void>> = []
    let accepted = 0
    const verbose = rows.length <= RERUN_LOG_ROWS
    for (const row of rows) {
      if (row.status === 'running') continue
      const idx = this.rowIndex(row)
      if (idx < 0) continue
      // 保留旧结果：不提前清空，跑出新结果后直接替换（error 由 runRow 开始时清空）
      row.error = undefined
      row.retryCount = 0
      row.emptyRetryCount = 0
      const workerId = row.viewId ? this.executor.slotOf?.(row.viewId) : undefined
      this.setRowStatus(row, 'pending')
      if (verbose) this.log('info', `[行${idx + 1}] 手动重跑已入队（优先）`, workerId)
      tasks.push(async () => {
        if (!this.isRunning || this.stopRequested || row.status !== 'pending') return
        await this.runRow(row)
      })
      accepted++
    }
    if (accepted === 0) return 0
    if (!verbose) this.log('info', `批量重跑已入队: ${accepted} 行（优先执行）`)
    this.enqueueTasksFront(tasks)
    return accepted
  }

  /**
   * 运行中手动重跑某行（UI 点击行内“重跑”）：
   * 重置该行状态并插到任务队列最前——当前任一线程一空闲立即执行
   * （若并发已满，则等最先结束的线程，无需等队列里其它排队任务）。
   * 行正在执行中 / 批量未运行 / 行不存在时返回 false。
   */
  requestRerun(row: BatchRow): boolean {
    return this.requestRerunBatch([row]) > 0
  }

  // ==================== 停止 ====================
  stop(): void {
    if (!this.isRunning) return
    this.stopRequested = true
    this.isRunning = false
    // 级联取消所有活跃会话（进行中的任务会回到 pending，可续跑）
    for (const row of this.rows) {
      if (row.status === 'running' && row.viewId) {
        agentBridge.cancel(row.viewId, 'user').catch(() => {})
      }
    }
    // 中止执行器进行中的请求（llm：abort 请求；agent 无此需要）
    try { this.executor.abort?.() } catch { /* 忽略 */ }
    this.log('info', '批量执行已停止（进行中的任务已取消，可点击 ▶ 续跑）')
  }

  // ==================== 单行停止（行详情） ====================
  /** 被用户单独停止的行 id：runRow 收尾时据此标记跳过（不判失败、不自动重试） */
  private stoppedRowIds = new Set<string>()

  /**
   * 只停当前这一行（行详情里的「停止」），不影响其它行与整批：
   * - 执行中的行 → 取消它的会话（agent）/ 中止它在跑的请求（llm / extract），收尾为「跳过」；
   * - 排队中（待处理）的行 → 直接标记「跳过」，队列里的任务到点自动跳过；
   * - 行不在本次批量 / 已是终态 → 返回 false。
   */
  requestStopRow(row: BatchRow): boolean {
    if (!this.isRunning) return false
    const idx = this.rowIndex(row)
    if (idx < 0) return false
    if (row.status === 'running') {
      this.stoppedRowIds.add(row.id)
      if (row.viewId) agentBridge.cancel(row.viewId, 'user').catch(() => {})
      // llm / extract：只中止这一行的请求（其它行继续跑）
      try { this.executor.abortRow?.(row.id) } catch { /* 忽略 */ }
      this.log('info', `[行${idx + 1}] 已请求停止…`)
      return true
    }
    if (row.status === 'pending') {
      this.setRowStatus(row, 'skipped')
      this.log('info', `[行${idx + 1}] 已从队列移出（标记为跳过）`)
      return true
    }
    return false
  }

  /** runRow 收尾判定：该行是否被用户单独停止（是则清标记并返回 true） */
  private consumeStopped(row: BatchRow): boolean {
    if (!this.stoppedRowIds.has(row.id)) return false
    this.stoppedRowIds.delete(row.id)
    return true
  }

  // ==================== 行过程快照（内存，供行详情回看） ====================
  /** 把 view.steps 压缩成过程快照存到行上；超出行数上限时 FIFO 淘汰最早的行 */
  private snapshotRowTrace(row: BatchRow, view: any): void {
    const steps: any[] = Array.isArray(view?.steps) ? view.steps : []
    if (!steps.length) return
    // 步骤数（实际值；trace 只保留最后 10 步，展示用这个）
    row.stepsCount = steps.length
    const cut = (s: any, n: number): string => {
      let t: string
      if (typeof s === 'string') t = s
      else if (s === undefined || s === null) t = ''
      else { try { t = JSON.stringify(s, null, 2) } catch { t = String(s) } }
      const v = String(t || '').trim()
      return v.length > n ? v.slice(0, n) + '…' : v
    }
    row.trace = steps.slice(-TRACE_MAX_STEPS).map((s: any): BatchRowTraceStep => ({
      reasoning: cut(s.reasoning, TRACE_LIMIT.reasoning),
      content: cut(s.content, TRACE_LIMIT.content),
      toolCalls: (s.toolCalls || []).map((t: any): BatchRowTraceCall => ({
        callId: String(t.callId || ''),
        name: String(t.name || ''),
        status: String(t.status || ''),
        args: cut(t.args, TRACE_LIMIT.args),
        result: cut(t.status === 'error' ? (t.error || t.result) : t.result, TRACE_LIMIT.result),
      })),
    }))
    this.traceRows.set(row.id, row)
    while (this.traceRows.size > TRACE_KEEP_ROWS) {
      const oldest = this.traceRows.keys().next().value as string | undefined
      if (oldest === undefined) break
      const oldRow = this.traceRows.get(oldest)
      if (oldRow) oldRow.trace = undefined
      this.traceRows.delete(oldest)
    }
  }

  // ==================== 日志 ====================
  private log(level: string, message: string, workerId?: number, detail?: string): void {
    const time = new Date().toLocaleTimeString()
    const entry: { time: string; level: string; message: string; detail?: string } = { time, level, message }
    if (detail) entry.detail = detail
    if (workerId !== undefined) {
      const worker = this.workers.get(workerId)
      if (worker) {
        worker.logs.push(entry)
        if (worker.logs.length > 300) worker.logs = worker.logs.slice(-200)
      }
    }
    this.callbacks.onLog?.(level, message, workerId, detail)
  }
}

/** 便捷创建 */
export function createBatchAgent(config: BatchConfig, store: any, callbacks?: BatchCallbacks): BatchAgent {
  return new BatchAgent(config, store, callbacks)
}
