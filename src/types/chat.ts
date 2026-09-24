/**
 * chat.ts — 聊天领域类型（从 home.vue 抽出，避免巨型组件承载类型定义）
 *
 * 依赖：WorkflowData 来自工作流引擎（仅类型引用）。
 * 供 home.vue 与各 composables（useChatSessions / useChatSend / ...）共用。
 */

import type { WorkflowData } from '@/components/workFlow/engine/WorkflowRunner'
import type { EditDiffPreview } from '@/shared/editDiff'
import type { PtcRunPreview } from '@/types/tool'

/** 聊天模式（每条聊天独立）
 *  code = PTC（程序化工具调用 / Code Mode）：工具呈现坍缩为单个 run_code，模型写程序调用工具 */
export type ChatMode = 'normal' | 'retrieval' | 'workflow' | 'skill' | 'agent' | 'agent2' | 'swarm' | 'code'

/** 知识库相关片段（检索结果展示） */
export interface RelevantBlock {
  label: string
  content: string
  similarity: number
  summaryScore?: number
  sliceScore?: number
}

/** 统一的执行单元接口（技能步骤 / 工作流节点的统一展示形状） */
export interface ExecutionUnit {
  id: string | number
  status: 'pending' | 'running' | 'success' | 'error'

  // 技能步骤字段
  stepType?: string
  description?: string

  // 通用字段
  /** 工具入参（智能体模式工具调用展示） */
  args?: any
  result?: any
  resultPreview?: string
  streamContent?: string
  error?: string
  /** UI 专用差异预览（编辑类工具；来自工具结果 preview，不进模型上下文） */
  preview?: EditDiffPreview | PtcRunPreview

  // 时间信息
  startTime?: number
  endTime?: number
}

/** 工作流单元接口（扩展自 ExecutionUnit） */
export interface WorkflowUnit extends ExecutionUnit {
  name?: string
  nodeType?: string
  decisionInfo?: string
}

/** 上传项：图片或解析后的文件 */
export interface UploadItem {
  kind: 'image' | 'file'
  data: string | Uint8Array | ArrayBuffer // 图片数据(base64)或空字符串
  name: string
  size: number
  parsedContent?: string // 文件解析后的文本内容
  charCount?: number // 解析后的字符数
}

/** 聊天消息 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  model?: string
  kbInfo?: {
    kbPath: string
    relevantBlocks?: RelevantBlock[]
    debugInfo?: any
  }

  // 统一的执行相关字段
  executionType?: 'workflow' | 'skill'
  isExecuting?: boolean
  /** 流式输出中：true 时用纯文本渲染（避免每个 chunk 全量 markdown 重解析导致卡顿），结束置 false 渲染 markdown */
  streaming?: boolean
  executionName?: string
  executionUnits?: (ExecutionUnit | WorkflowUnit)[]
  executionProgress?: {
    completed: number
    total: number
  }
  executionTime?: number
  executionStats?: {
    total: number
    success: number
    failed: number
    time: number
    errors?: Array<{ id: string | number; name: string; error: string }>
  }

  // 添加图片支持
  images?: Array<string | Uint8Array | ArrayBuffer>

  // 上传的文件附件（仅用户消息）
  fileAttachments?: Array<{
    name: string
    content: string
    charCount: number
  }>

  tokenStats?: {
    promptTokens: number // 输入 token 数
    completionTokens: number // 输出 token 数
    totalTokens: number // 总 token 数
    speed?: number // 输出速度 (tokens/秒)
    duration?: number // 生成耗时 (毫秒)
  }

  // 联网搜索信息（DeepSeek Responses API 等服务端联网）
  webSearch?: {
    status: 'idle' | 'searching' | 'completed'
    query?: string
    results?: Array<{ title?: string; url?: string; snippet?: string; content?: string }>
  }

  _startTime?: number
  /** 主进程 AI 会话 id（断线续传用） */
  requestId?: string
  /** 智能体主进程会话 id（agentBridge view id；供运行状态对账 / 切模块重进恢复 / 停止映射） */
  agentViewId?: string
  /**
   * 该用户消息是在智能体**运行中**作为「引导」（steer）发送的：
   * 不打断当前执行，在下一个 step 边界被智能体读取（气泡上显示「引导」标记）。
   */
  steer?: boolean
  /**
   * 智能体会话启动时注入的固定上下文（system prompt + 工具 schema + 种子历史）的估算 token 数。
   * 这些内容不落在消息正文上（主进程持有），后端未回传 usage 时上下文圆环靠它估算（见 lib/contextUsage）。
   */
  ctxSeedTokens?: number

  // 深度思考（<think>…</think>，Qwen3/vLLM 等）
  /** 思考内容（从正文剥离，单独折叠展示） */
  reasoning?: string
  /** 思考块手动折叠状态（用户点击后固化；未设置时按“思考中展开/出结果折叠”自动判定） */
  thinkCollapsed?: boolean

  /** 集群模式：本消息来自某成员的本次发言（成员汇报气泡） */
  swarmAgent?: {
    /** 成员下标；-1 = 系统/群主（中立 LLM） */
    idx: number
    /** 成员显示名（用于头像色与标题） */
    name: string
    /** 该成员本次调用序号（同一成员多次发言时递增） */
    seq?: number
    /** 本次调用状态（供头像 spinner / 失败标记） */
    status?: 'running' | 'done' | 'error'
  }
}

/** 每条聊天的独立配置 */
export interface ChatConfig {
  llmType: string
  model: string
  temperature: number
  maxTokens: number
  stream: boolean
  functionIndex: number
  kbPath?: string
  kbTopK?: number
  /** 知识库检索策略：similarity=相似度, ontology=本体, multiHop=多跳, community=社区, agentic=Agentic */
  retrievalStrategy?: string
  /** 浏览器模式（LAN 共享）下知识库退化为上传文件内容 */
  kbFiles?: Array<{ name: string; content: string; charCount: number }>
  /** 浏览器模式（LAN 共享）：使用主机「局域网共享→知识库目录」中的现有 .kb（只存引用，不落盘内容） */
  sharedKb?: { name: string; size?: number }
  workflowPath?: string
  workflowData?: WorkflowData
  /** Agent 预设模式：选中的预设 id（mode='agent' 时生效） */
  presetId?: string
  /** 自定义来源：绑定的来源索引（llmType='custom' 时生效；缺省用设置页当前激活来源） */
  customSourceIndex?: number
  /** 集群模式：参与本次对话的 Agent 预设 id 列表（有序 = 发言顺序）；不落预案文件，改预设即改成员 */
  swarmPresetIds?: string[]
  /** 集群模式：运行方式等选项（随对话保存，不做群内成员特化） */
  swarmOptions?: {
    /** 运行方式：auto=全员响应（默认）/ host=群主撮合 / debate=辩论 */
    runMode?: 'auto' | 'host' | 'debate'
    /** 结束后由群主总结（默认关闭） */
    hostSummary?: boolean
    /** 群主：-1=中立 LLM（默认）；>=0 = 成员下标 */
    hostIdx?: number
    /** 把群聊前文注入成员提示词（默认开） */
    injectHistory?: boolean
    /** 辩论轮数（runMode='debate' 时生效） */
    debateRounds?: number
  }
}

/** 聊天会话 */
export interface Chat {
  id: string
  title: string
  messages: ChatMessage[]
  config: ChatConfig
  createdAt: number
  online?: boolean
  isGenerating?: boolean
  /** 当前生成中的主进程 AI 会话 id（切模块/中断后重进续接） */
  activeRequestId?: string
  mode: ChatMode // 每个聊天的独立模式
  // 分支对话相关
  parentId?: string // 父聊天 ID，根聊天为 undefined
  branchMsgIndex?: number // 从父聊天的第几条消息分支（消息索引）
  branchLabel?: string // 分支节点显示标签（从分支消息提取）
  /** 智能体（agent2）模式的执行展示：当前任务的待办清单（update_todo 维护） */
  agentTodos?: TodoItem[]
  /** 智能体模式最近一次工具调用快照（供输入区右侧展示；null 表示无） */
  agentLastTool?: { name: string; status: string; summary?: string } | null
}

/** Agent 待办项（与 types/agent.ts 的 TodoItem 对齐的展示形状） */
export interface TodoItem {
  id: string
  title: string
  status: 'pending' | 'running' | 'done' | 'cancelled'
  detail?: string
}

/** 知识库检索统计 */
export interface RetrievalStats {
  totalBlocks: number
  returnedBlocks: number
  maxSimilarity: string
  averageSimilarity?: string
}
