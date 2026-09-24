/**
 * types.ts — Agent脚手架模块的公共类型（Step 2 抽象重组）
 *
 * 目标模型（见 docs/设计决策记录.md §三）：
 *   源 Source（table / folder / urls）× 执行器 Executor（agent / llm / extract）× 汇聚 Sink（resultColumn / writeBack / dataRows）
 *
 * 本文件承接 Step 1 平移版的类型（原先定义在 pipelineRunner.ts 顶部），
 * 并提前声明执行器 / 汇聚器接口与预设类型（接口先行、实现后搬：类内会话编排暂留 pipelineRunner，
 * 后续提交迁入 executors/*，接入 llm 执行器与 writeBack 汇聚）。
 * 所有导出保持与旧名兼容（BatchRow / BatchConfig / BatchCallbacks…），UI 无需改动。
 */

import { normalizeLlmType } from '@/shared/llmSources'

// ==================== 状态 ====================
export type PipelineRowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
/** 兼容别名：UI 与既有代码沿用 Batch 命名 */
export type BatchRowStatus = PipelineRowStatus

// ==================== 工作单元 ====================
/** 过程快照：单次工具调用（args/result 已按上限截断） */
export interface BatchRowTraceCall {
  callId: string
  name: string
  status: string
  args?: string
  result?: string
}
/** 过程快照：单步 */
export interface BatchRowTraceStep {
  reasoning?: string
  content?: string
  toolCalls: BatchRowTraceCall[]
}

/** 工作单元：一行 = 一个独立任务（数据 + 状态 + 结果 + 过程快照） */
export interface PipelineUnit {
  id: string
  /** 原始行数据（列名 → 值）；占位符替换以此为数据源 */
  data: Record<string, any>
  status: PipelineRowStatus
  /** 结果文本（单列；sink=resultColumn） */
  result?: string
  /** 多列结果（键=目标列名；sink=writeBack）——Step 2 后续接入 */
  values?: Record<string, string>
  /**
   * 结构化提取产物（sink=dataRows）：本行提取出的记录（已按 schema 对齐，与数据集里同一批对象），
   * 供「详情」表按提取字段逐列展示；随任务文件保存 / 恢复
   */
  extracted?: Array<Record<string, any>>
  error?: string
  inputTokens: number
  outputTokens: number
  startedAt?: string
  finishedAt?: string
  /** agentBridge 会话 id（运行中有效） */
  viewId?: string
  retryCount: number
  /** 空内容自动重跑已进行的次数（emptyAction='rerun' 时生效；达 emptyRetryLimit 判失败） */
  emptyRetryCount: number
  /**
   * 过程快照（步骤/推理/工具参数与结果）：行结束时从会话 view 压缩而来，
   * **仅存内存**（不写入任务文件），供行详情在运行结束后回看；超出行数上限的旧行会被淘汰
   */
  trace?: BatchRowTraceStep[]
  /** 本轮推理步骤数（会话实际步数；过程快照只保留最后 10 步，此值用于展示与统计） */
  stepsCount?: number
  /** 源专属元数据（urls 的 depth/parentUrl、folder 的 size/relativePath…）——Step 3 接入 */
  meta?: Record<string, any>
  /**
   * 源数据指纹（导入时对原表列算出的短哈希）：源表增删行后重读表格时用它把历史结果对回正确的行；
   * 不写入任务文件（随结果一起保存，见 results[i].sig）。
   */
  sig?: string
  /**
   * 源数据指纹 - 归一化版（单元格值先归一化：数字写法 / 空白 / 零宽字符）：
   * 用来区分「真改了内容」与「只是换了个写法」（Excel 复存常见），避免误报满屏「已变更」。
   */
  sigNorm?: string
  /**
   * 源表增量标记（仅本次载入有效，不落盘）：`added` = 源表新增的行；`modified` = 同位置的行源数据已变（旧结果已作废，需重跑）。
   * 行被跑过 / 清空后自动清除。
   */
  delta?: 'added' | 'modified'
  /**
   * 跨轮引用虚拟列（运行时注入，**不落盘**）：键形如 `第1轮.结果` / `第1轮.字段名`。
   * 任务指令渲染时会与行数据合并，因此 `{{第1轮.结果}}` 等占位符可直接引用前轮产出。
   */
  roundRefs?: Record<string, string>
}

/** urls 源行元数据约定（unit.meta） */
export interface UrlUnitMeta {
  /** 抓取深度：种子 = 0，子链接 = 父 +1 */
  depth?: number
  /** 发现该页的父页面 URL（爬取轨迹边：父 → 子） */
  parentUrl?: string
  /** 本页抓取后解析出的链接（执行器写入；供 runner 动态扩展 frontier，失败重试后可覆盖） */
  discoveredLinks?: string[]
}
/** 兼容别名：UI 与既有代码沿用 BatchRow 命名 */
export type BatchRow = PipelineUnit

// ==================== 配置 ====================
export interface PipelineConfig {
  /** 预设 id（batch / tabreason / file / collector / custom）；旧任务文件无此字段 → 视为 batch */
  preset?: string
  /** 执行器类型（缺省 = 'agent'，兼容旧任务文件） */
  executorKind?: 'agent' | 'llm' | 'extract'
  /** 汇聚类型（缺省 = 'resultColumn'，兼容旧任务文件） */
  sinkKind?: 'resultColumn' | 'writeBack' | 'dataRows'
  /**
   * 源类型（缺省 = 'table'，兼容旧任务文件）：
   *   table  = 导入表格（每行一条，任意列）
   *   folder = 扫描文件夹（每文件一行，字段 filePath/relativePath…）
   *   text   = 文本（粘贴，每行一条，存为 textFieldName 单列）
   *   urls   = **旧值**（v1 链接采集）：读取时迁移为 text + contentSource 'url' + textFieldName 'url'
   */
  sourceKind?: 'table' | 'folder' | 'text' | 'urls'

  // ---- 智能体执行器（agent）----
  /** 预设智能体 id；'' = 通用智能体（自主规划） */
  presetId: string
  /**
   * 任务指令（含 {{列名}} 占位符；每行渲染一次）——智能体 / 纯 LLM / 结构化提取三种执行方式共用，
   * 也是「哪些列的数据进入提示词」的唯一表达（由 {{列名}} 决定）；
   * 读旧任务时：旧「任务目标」(goal) 与旧「源列」勾选(sourceColumns) 均合并到此处。
   */
  template: string
  /** 未匹配占位符：true=保留原样，false=替换为空 */
  keepUnmatched: boolean
  /** 单个 turn 最大 step 数 */
  maxSteps: number
  /** 自定义工具白名单（逗号分隔；留空=自动跟随预设/全局） */
  toolsOverride: string
  /** 空内容处置策略：''=无操作（按完成、结果留空）；'replace'=结果替换为指定文本；'rerun'=自动重跑 */
  emptyAction: '' | 'replace' | 'rerun'
  /** 结果为空时替换写入结果列的文本（emptyAction='replace'） */
  emptyReplaceText: string
  /** 结果为空时自动重跑上限（emptyAction='rerun'；按行 emptyRetryCount 计数） */
  emptyRetryLimit: number
  /** 各线程错峰启动间隔(ms)：>0 时第 i 个线程的首请求延迟 staggerMs*i，降低对远程推理服务的同时并发尖峰 */
  staggerMs: number

  // ---- 通用执行 ----
  /** 并发数（默认 5，上限 MAX_CONCURRENCY = 500，见 pipelineRunner） */
  concurrency: number
  /** 失败自动重试次数 */
  retry: number
  /** LLM 后端（''=跟随全局；'agent'=跟随预设；显式指定时覆盖预设/全局） */
  llmType: string
  /** 模型名（''=使用所选后端默认/全局配置） */
  model: string

  // ---- 汇聚 ----
  /** 结果写入列名（sink=resultColumn） */
  resultField: string

  // ---- llm 执行器（sink=writeBack）----
  /**
   * 【已废弃】旧「源列」：勾选后作为提示词依据注入的列。
   * 统一后该职责由 template（任务指令里的 {{列名}} 占位符）承担；读旧任务时自动迁移并删除。
   */
  sourceColumns?: string[]
  /**
   * 【已废弃】旧「目标列」（逐列写回）：读旧任务时自动迁移到 schema（name→name、prompt→description）；
   * UI 与执行器已统一用「输出字段」（schema）。
   */
  targetColumns?: PipelineTargetColumn[]
  /** 结构化输出：true = 每行只调用一次 LLM，一次性输出全部目标列（JSON） */
  structured?: boolean

  // ---- extract 执行器 + folder / urls 源 ----
  /** 【已废弃】旧「任务目标」——统一后并入 template（任务指令；读旧任务时自动迁移） */
  goal?: string
  /**
   * 输出字段定义（**逐列写回的「目标列」与结构化提取的「提取字段」是同一张列表**）：
   * name = 字段名 / 写回列名；description = 推理指令 / 字段说明；type / required / isPrimaryKey 用于结构化提取合并。
   */
  schema?: PipelineSchemaField[]
  /** 每段最大字符数（extract 分段；默认 8000） */
  maxContentPerFile?: number
  /**
   * 重跑同一个行时，结构化提取结果（sink=dataRows）怎么算：
   *   'replace'（默认）= 先清掉该任务行上次产出的记录，再写入本次结果（重跑 = 替换，不会越跑越多）；
   *   'merge'         = 保留旧记录，按主键合并 / 无主键时追加（跨行合并同一条记录的场景用）。
   * 仅结构化提取生效：单独结果 / 逐列写回本来就按行覆盖。
   */
  rerunResultMode?: 'replace' | 'merge'
  /**
   * 长内容分段后如何汇总（仅结构化提取）：
   *   'one'（默认）= 同一任务行的各段结果**合并成一条记录**（一个文件最终只产出 1 条数据）；
   *   'each'      = 每段的结果各自成为一条记录（一个文件里含多条独立记录时用）。
   */
  segmentMerge?: 'one' | 'each'
  /** folder 源：文件夹路径 */
  folderPath?: string
  /** folder 源：包含的文件扩展名（小写含点，如 ['.md','.txt']） */
  extensions?: string[]
  /** folder 源：排除的目录名 */
  excludeDirs?: string[]
  /** folder 源：最大文件数 */
  maxFiles?: number

  // ---- text 源（文本，每行一条：可粘贴网址 / 文件路径 / 任意文本） ----
  /** 文本内容（多行；点「生成任务行」时每行成为一行任务）；旧字段名 seedUrls（链接采集 v1）读取时自动迁移 */
  textInput?: string
  /** 文本源的字段名（默认 text；旧链接采集任务为 url）——既是占位符名，也是「内容获取」的取值字段 */
  textFieldName?: string
  /** 旧字段（链接采集 v1 的种子 URL 文本）——仅在读取旧任务文件时出现，迁移到 textInput */
  seedUrls?: string

  // ---- 内容获取（extract 执行器：每行任务从哪里取“素材”） ----
  /**
   * 'none' = 直接使用行数据（单字段取其值，多字段拼成「字段: 值」行）
   * 'file' = 把行内指定字段当作本地文件路径读取
   * 'url'  = 把行内指定字段当作网页地址抓取（顺带解析 title/links，支持链接跟随）
   * 缺省按来源推断：folder→file、旧 urls→url、其余→none
   */
  contentSource?: 'none' | 'file' | 'url'
  /** 内容获取取值字段（仅表格源需要填写；文本源用 textFieldName，文件夹固定 filePath） */
  contentField?: string

  // ---- urls 抓取（contentSource='url' 时的爬取设置） ----
  /** 爬取最大深度（0 = 只抓种子页；子链接深度 = 父 +1） */
  urlMaxDepth?: number
  /** 最大页面数（含种子；运行中发现的链接超过该数量则不再加入队列） */
  urlMaxPages?: number
  /** 链接跟随策略：none=不跟随 / same-host=同域 / keyword=关键词（URL 匹配）/ all=全部 */
  urlFollow?: 'none' | 'same-host' | 'keyword' | 'all'
  /** 跟随关键词（urlFollow='keyword'；逗号分隔，小写包含匹配 URL） */
  urlKeywords?: string
  /** 抓取后交给 LLM 的分析对象：text=过滤后正文 / links=链接清单（含锚文本；旧「链接分析模式」） */
  urlBody?: 'text' | 'links'

  // ---- 界面 / 任务文件 ----
  /**
   * 导出 Excel 时一并写入的**原表列**（列名数组）。
   * 未设置 = 沿用旧行为：单独结果模式导出全部列 / 结构化模式不导出原表列。
   */
  exportColumns?: string[]
  /**
   * 导出 Excel 时一并写入的**运行信息列**（键：rowNo / instruction / status / error / inputTokens /
   * outputTokens / startedAt / finishedAt / duration / steps / retry）。
   * 未设置 = 沿用旧行为：单独结果模式导出 状态/错误/Token/起止时间 / 结构化模式不导出。
   */
  exportMeta?: string[]
  /** 子任务表格（及结果页预览）左侧显示的标题字段（''=不显示该列；运行中可切换） */
  rowTitleField?: string
  /**
   * 导出 Excel 时额外写入的**轮次结果列**（轮次 id 数组）：每列 = 该轮该行的结果（结构化轮把多条记录拼成文本），
   * 便于把各轮结果并排对比。未设置 = 不导出轮次列。
   */
  exportRounds?: string[]
  /**
   * 导出列的**自定义顺序**（导出列表单里拖动得到）：条目键 = `col:<原表列>` / `meta:<运行信息键>` / `round:<轮次 id>`。
   * 未列入的条目按默认次序（原表列 → 运行信息 → 轮次列）排在后面。
   */
  exportOrder?: string[]
  /**
   * 导出列的**自定义列名**（键同 exportOrder：`col:<原表列>` / `meta:<运行信息键>` / `round:<轮次 id>` → 显示名）。
   * 未设置的键用默认名称；结果页表头与导出的 Excel 列名都用这里的名字。
   */
  exportHeaders?: Record<string, string>
  /** 自动保存间隔（小时，0=关闭；仅 UI / 任务文件持久化使用，不参与单行执行） */
  autoSaveHours: number
  /**
   * 是否启用「图谱」：关闭后不做轨迹投影计算（省算力），也不显示「图谱」标签页；
   * 默认 true（未设置 = 开启，旧任务文件行为不变）。行详情的“过程”回看不受影响。
   */
  graphEnabled?: boolean
  /**
   * 保存任务文件时是否一并写入**图谱数据**（行过程快照 trace / 步骤数；图谱与行详情的数据来源）。
   * 默认 false = 不保留（任务文件更小）；勾选后重开任务文件仍可看图谱。
   */
  keepTrace?: boolean
  /**
   * 保存任务文件时是否一并写入**运行日志**（主日志 + 各线程日志）。
   * 默认 false = 不保留（任务文件更小）。
   */
  keepLogs?: boolean
}
/** 兼容别名：UI 与既有代码沿用 BatchConfig 命名 */
export type BatchConfig = PipelineConfig

/** 轮次汇总（任务文件 / 轮次下拉展示用） */
export interface PipelineRoundSummary {
  /** 合计行数 */
  rows: number
  completed: number
  failed: number
  skipped: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
  finishedAt?: string
}

/**
 * 推理轮次（多轮处理）：一个 .task 文件按轮次分槽保存。
 * 每轮 = 一次启动的结果（results / units / dataset / traces）+ 该轮的配置快照 + 汇总。
 * 界面上的行、结果、数据集都属于「活跃轮」（currentRoundId）；切换轮次 = 把活跃状态写回槽位再载入目标轮。
 */
export interface PipelineRound {
  id: string
  /** 显示名（自动「第N轮」，可重命名） */
  label: string
  createdAt: string
  /** 配置快照（切换轮次时载入；含 presetId / executorKind / template / schema / llmType / model 等） */
  config: Record<string, any>
  summary?: PipelineRoundSummary
  /** 非文本源：按行索引的结果/状态数组（同 v2 的 results 结构） */
  results?: any[]
  /** 文本源：任务行（含行数据 / 状态 / 结果），本身就是成果 */
  units?: any[]
  /** 结构化提取数据集 */
  dataset?: any[]
  /** 行过程快照（仅「随任务文件保留 → 图谱数据」时写入） */
  traces?: any[]
  /**
   * 派生来源：`chain` = 本轮的行由该轮的结果展开而来；`copy` = 沿用该轮的行（同批行回放）。
   * 重新载入本轮时按同一规则重建行；源轮次被删除时无法重建（切换会给出日志提示）。
   */
  derivedFrom?: { kind: 'chain' | 'copy'; roundId: string }
  /**
   * 每行对应的「原始行号」（仅派生行需要：链式展开后行数与源行不同）。
   * 缺省（未写入）= 行序号即原始行号；跨轮引用按它对齐。
   */
  originOf?: number[]
  /**
   * 基准轮的行数据快照（**仅当本轮被链式轮次展开、且行不来自导入表时才写入**）：
   * 链式轮次会换掉行集合，靠它才能切回本轮；非基准轮由 derivedFrom 递归重建，不需要快照。
   */
  rowsData?: Array<Record<string, any>>
  /**
   * 保存时源表的列名顺序：重读源表时用它判断「源表结构是否变过」。
   * 列不一致 → 行指纹不可比，退回按行号对位（避免整表被误标「已变更」）。
   */
  sourceColumns?: string[]
}

/** 目标列（llm 执行器；与 TableReason 的 TargetColumn 同构） */
export interface PipelineTargetColumn {
  id: string
  /** 列名（推理结果写回表格的这一列） */
  name: string
  /** 推理指令，支持 {{列名}} 占位符；**留空表示按列名语义自动从源列分析提取** */
  prompt: string
  /** 是否导出该列（写入结果表格 / Excel） */
  export?: boolean
}

/** 结构化提取字段定义（extract 执行器；与 CollectFile / CollectWeb 的 SchemaField 同构） */
export interface PipelineSchemaField {
  id: string
  name: string
  type: string
  description: string
  /** 主键：按该字段去重合并（同名数据更新而非新增） */
  isPrimaryKey?: boolean
  /** 主键匹配正则（可选；如只取编号部分比较） */
  primaryKeyRegex?: string
  /** 必填：不允许留空 */
  required?: boolean
}

/** 文件夹扫描结果（folder 源；主进程 scanFolder IPC 返回项） */
export interface PipelineScannedFile {
  filePath: string
  relativePath: string
  fileName: string
  extension: string
  size: number
}

// ==================== 线程 / 回调 ====================
export interface BatchWorkerInfo {
  id: number
  label: string
  /** 当前处理行的标题（'' = 空闲） */
  rowTitle: string
  logs: Array<{ time: string; level: string; message: string; detail?: string }>
  rowCount: number
}

export interface BatchCallbacks {
  onRowUpdate?: (row: BatchRow) => void
  /** 行状态迁移（O(1) 增量更新计数用） */
  onStatusChange?: (rowId: string, from: PipelineRowStatus, to: PipelineRowStatus) => void
  /** 行对应的 agent 会话建立/销毁（传 row 对象，组件 O(1) 建 viewId→row 映射） */
  onRowSessionStart?: (row: BatchRow, viewId: string) => void
  onRowSessionEnd?: (row: BatchRow, viewId: string) => void
  onProgress?: (processed: number, total: number) => void
  onLog?: (level: string, message: string, workerId?: number, detail?: string) => void
  onWorkerUpdate?: (workers: BatchWorkerInfo[]) => void
  onTokenUsage?: (inputTokens: number, outputTokens: number, totalTokens: number) => void
  /**
   * 某一行的 token 用量（纯 LLM / 提取模式：没有 agent 会话，行 Token 只能由执行器回传）；
   * agent 模式的行 Token 由组件的会话监听累加，不走这里。
   */
  onRowTokenUsage?: (rowId: string, inputTokens: number, outputTokens: number) => void
  onAllDone?: (stats: { success: number; failed: number; skipped: number }) => void
  /** 数据集更新（sink=dataRows：提取数据经主键合并进数据集后回调；dataset 为最新数组） */
  onDatasetUpdate?: (dataset: Array<Record<string, any>>) => void
  /** 运行中动态新增任务行（urls 源发现新链接时）——UI 据此增量维护统计与分页窗口 */
  onRowsAdded?: (rows: BatchRow[]) => void
}

// ==================== 运行期共享上下文 ====================
/** 批量运行期共享上下文（整批只解析一次的内容，避免逐行重复解析） */
export interface BatchRuntimeContext {
  /** 本批已解析好的 MCP 服务工具清单文本（buildMcpServersContext 生成） */
  mcpContext?: string
}

// ==================== 执行器 / 汇聚器接口（Step 2 目标形态） ====================
export interface ExecutorOutcome {
  ok: boolean
  /** 单值结果（sink=resultColumn） */
  result?: string
  /** 多值结果（键=目标列名；sink=writeBack） */
  values?: Record<string, string>
  /** 结构化提取出的多条数据（sink=dataRows；键=字段名；对齐/合并由汇聚器完成） */
  rows?: Array<Record<string, any>>
  /**
   * 结构化提取的「模型原始输出」（sink=dataRows 且没解析出任何记录时带上）：
   * runner 会把它保留到行的 result 上，避免“模型明明答了、行却是空的”（行详情与导出都能看到）。
   */
  rawText?: string
  /** urls 源：本页解析出的链接（"链接即字段"的执行期产物；runner 据此动态扩展 frontier） */
  links?: string[]
  error?: string
}

/** 执行器构造依赖：runner 提供（日志出口 / 停止判定），构造时一次性注入 */
export interface ExecutorDeps {
  /** 线程日志出口（runner 的 log：写 worker.logs + onLog 回调） */
  log: (level: string, message: string, workerId?: number, detail?: string) => void
  /** 是否已被请求停止（错峰延迟 / 完成判定时使用） */
  isStopRequested: () => boolean
}

/** 执行器运行上下文：runner 提供的通用设施接口面（每次执行单元时构造） */
export interface ExecutorContext {
  /** 并发槽位号（0 起；日志按槽位路由到对应线程） */
  slotIndex: number
  /** 行号（0 起；占位符 {{rowIndex}} 显示为 rowIndex+1） */
  rowIndex: number
  /** 写线程日志（runner 路由到对应槽位并同步 worker.logs） */
  log(level: string, message: string, detail?: string): void
  /** 是否已被请求停止（错峰延迟 / 完成判定时使用） */
  isStopRequested(): boolean
  /** 会话建立通知（agent 执行器）：runner 记录 viewId 并通知 UI */
  attachSession(unit: PipelineUnit, viewId: string): void
  /** 本批共享上下文（agent：MCP 工具清单；runner 每批解析一次后注入） */
  runtime?: BatchRuntimeContext
}

export interface PipelineExecutor {
  kind: 'agent' | 'llm' | 'extract'
  /** 订阅底层事件源（agent=agentBridge；批量开始时由 runner 调用一次） */
  subscribe?(): void
  /** 取消订阅（批量结束/停止时） */
  unsubscribe?(): void
  /**
   * 执行一个单元并返回结果；**不改单元状态**（状态迁移统一由 runner 负责）。
   * agent：占位符渲染 → 构建 AgentOptions → 创建会话 → 发送 → 等待结束；
   * llm：按目标列构造提示词 → sendToAI 补全（structured 时整行一次 JSON）。
   */
  run(unit: PipelineUnit, ctx: ExecutorContext): Promise<ExecutorOutcome>
  /** 单元结束后的资源回收（agent：dispose 会话 + 清理观察状态） */
  cleanup?(unit: PipelineUnit): Promise<void>
  /** 中止进行中的请求/会话（llm：abort 请求；agent：会话取消由 runner 负责） */
  abort?(): void
  /** 只中止某一行的进行中请求（行详情「停止」用；llm / extract 实现） */
  abortRow?(rowId: string): void
  /** 新一轮批量的 token 归零 */
  resetTokens?(): void
  /** 取某会话所在的并发槽位（agent 执行器；日志路由 / 重跑时用） */
  slotOf?(viewId: string): number | undefined
}

export interface PipelineSink {
  kind: 'resultColumn' | 'writeBack' | 'dataRows'
  /** 结果是否含有效内容（空内容处理判定用） */
  hasContent(outcome: ExecutorOutcome): boolean
  /** 正常结果落盘（resultColumn=写 unit.result；writeBack=写 unit.data[列名]） */
  apply(unit: PipelineUnit, outcome: ExecutorOutcome): void
  /** 空内容替换文本落盘（emptyAction='replace'；writeBack 无此语义，可不实现） */
  applyEmptyText?(unit: PipelineUnit, text: string): void
  /**
   * 重跑前置：清掉该行上次产出的记录（仅 sink=dataRows 且 rerunResultMode='replace' 时实现）。
   * 在**本次结果落盘之前**调用，因此跑失败时旧结果不会被误删。
   */
  resetRow?(unit: PipelineUnit): void
}

// ==================== 源 / 预设 ====================
export type PipelineSourceKind = 'table' | 'folder' | 'text' | 'urls'
export type PipelineExecutorKind = PipelineExecutor['kind']
export type PipelineSinkKind = PipelineSink['kind']

// ==================== 配置推导（源 × 内容获取的正交组合） ====================
/** 实际生效的内容获取方式（缺省按来源推断；文件夹始终为读本地文件） */
export function effectiveContentSource(cfg: PipelineConfig): 'none' | 'file' | 'url' {
  if (cfg.sourceKind === 'folder') return 'file'
  if (cfg.contentSource === 'none' || cfg.contentSource === 'file' || cfg.contentSource === 'url') return cfg.contentSource
  if (cfg.sourceKind === 'urls') return 'url'
  return 'none'
}

/** 文本源的字段名（缺省 text；旧链接采集任务为 url） */
export function resolveTextFieldName(cfg: PipelineConfig): string {
  return cfg.textFieldName || (cfg.sourceKind === 'urls' ? 'url' : 'text')
}

/** 「内容获取」取值字段：folder 固定 filePath；text 用 textFieldName；table 用 contentField */
export function resolveContentField(cfg: PipelineConfig): string {
  if (cfg.sourceKind === 'folder') return 'filePath'
  if (cfg.sourceKind === 'text' || cfg.sourceKind === 'urls') return resolveTextFieldName(cfg)
  return cfg.contentField || ''
}

/**
 * 旧配置迁移（读取任务文件时调用）：
 * v1 链接采集（sourceKind='urls'）→ 文本源 + 内容获取=抓取网页 + 字段名 url + textInput。
 */
export function migratePipelineConfig(cfg: PipelineConfig): void {
  // 单来源迁移：旧任务文件里的显式后端 'deepseek-responses' → 'deepseek'
  // （接口样式跟随全局 deepseek.api_style，不再作为独立来源）
  if (cfg.llmType) cfg.llmType = normalizeLlmType(cfg.llmType)
  if (cfg.sourceKind === 'urls') {
    cfg.sourceKind = 'text'
    if (!cfg.contentSource) cfg.contentSource = 'url'
    if (!cfg.textFieldName) cfg.textFieldName = 'url'
  }
  if (cfg.textInput === undefined && cfg.seedUrls !== undefined) cfg.textInput = cfg.seedUrls
  delete (cfg as any).seedUrls

  // 任务指令统一（2026-09-21）：旧「任务目标」(goal) 并入「任务指令」(template)。
  // 规则：指令为空时直接用 goal；两边都有且当前是 llm/extract（goal 才是生效字段）时以 goal 为准。
  if (cfg.goal) {
    if (!(cfg.template || '').trim() || cfg.executorKind === 'llm') cfg.template = cfg.goal
    cfg.goal = ''
  }
  // 旧「源列」勾选（llm 模式）→ 任务指令里的 {{列名}} 引用（源列不再单独注入）
  if ((cfg.sourceColumns || []).length) {
    if (!(cfg.template || '').trim()) {
      cfg.template = (cfg.sourceColumns || []).map((c) => `${c}: {{${c}}}`).join('\n')
    }
    delete (cfg as any).sourceColumns
  }
  // 输出字段统一（2026-09-21）：旧「目标列」（逐列写回）→ schema（name=列名，description=推理指令）
  if ((cfg.targetColumns || []).length) {
    if (!(cfg.schema || []).length) {
      cfg.schema = (cfg.targetColumns || []).map((t, i) => ({
        id: t.id || `sf_${Date.now()}_${i}`,
        name: t.name || '',
        type: 'text',
        description: t.prompt || '',
        required: false,
      }))
    }
    delete (cfg as any).targetColumns
  }
  // 「表格定向推理」统一为结构化提取（2026-09-21）：旧映射（preset=tabreason + 逐列写回）→ extract + dataRows。
  // 注：手动改过输出方式的任务 preset 会被置为「自定义」，不会命中此规则。
  if (cfg.preset === 'tabreason' && cfg.sinkKind === 'writeBack') {
    cfg.executorKind = 'extract'
    cfg.sinkKind = 'dataRows'
  }
}

/** 内置预设：一个预设 = 一种「源 × 执行器 × 汇聚」组合（即一个旧脚手架的迁移目标） */
export interface PipelinePreset {
  key: string
  labelZh: string
  labelEn: string
  source: PipelineSourceKind
  executor: PipelineExecutorKind
  sink: PipelineSinkKind
  /** 新建任务时的默认配置片段（与 UI 现有默认值一致，保证行为对等） */
  defaultConfig: (zh?: boolean) => Partial<PipelineConfig>
}
