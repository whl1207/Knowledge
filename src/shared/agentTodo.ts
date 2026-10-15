/**
 * agentTodo.ts — 待办清单（update_todo 工具）的统一规范化与校验（主进程 / 渲染层共用）
 *
 * 工具逻辑参照 DSH `todo_write`（@deepseek-ai/dsh-tool-todo）：
 * - **整表替换**：每次调用必须传入完整清单，不做增量合并；
 * - **写入前校验**：文本非空、清单内不重复、状态合法，违规即 fail-loud
 *   （宁可让模型重写一次，也不把脏数据写进 UI 与会话）；
 * - **单活跃规则**：同一时刻最多一项 `running`，防止整张表都标成"进行中"
 *   （DSH 用 allowParallelInProgress 配置表达同一约束）；
 * - **状态别名归一**：DSH 词表 `in_progress` / `completed` 与常见手写
 *   `inprogress` / `complete` / `finished` / `canceled` 一律映射到本产品词表；
 * - **稳定 id**：按文本与上一版清单对齐 id，保证 UI 手动勾选（toggleAgentTodo）
 *   与投影层「已确认状态不被覆盖」的兜底逻辑不丢状态。
 */

import type { TodoItem, TodoStatus } from '@/types/agent'

/** 本产品对外（UI / 存储）的词表：与 DSH 的三态一一对应，另加 cancelled */
export const TODO_STATUSES: TodoStatus[] = ['pending', 'running', 'done', 'cancelled']

/** 单条待办文本长度上限（超出多为模型把整段说明塞进了一项） */
export const TODO_TEXT_MAX = 200
/** 单张清单条数上限（防止把长任务拆成上百项刷屏 / 撑爆 UI 与上下文） */
export const TODO_LIST_MAX = 50

/** 状态别名 → 本产品词表（DSH 词表优先） */
const STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: 'pending',
  todo: 'pending',
  open: 'pending',
  notstarted: 'pending',
  running: 'running',
  inprogress: 'running',
  doing: 'running',
  active: 'running',
  current: 'running',
  done: 'done',
  completed: 'done',
  complete: 'done',
  finished: 'done',
  success: 'done',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  aborted: 'cancelled',
  skipped: 'cancelled',
}

/**
 * 归一化单个状态值。
 * @param raw 模型/存储里出现的原始状态
 * @returns 本产品词表内的状态；无法识别时返回 undefined（由调用方决定 fail-loud 还是兜底）
 */
export function normalizeTodoStatus(raw: unknown): TodoStatus | undefined {
  if (typeof raw !== 'string') return undefined
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
  return STATUS_ALIASES[key]
}

/** 取一条待办的文本：优先 DSH 的 `content`，兼容本产品历史的 `title` / `name` */
function todoTextOf(raw: any): string {
  const v = raw?.content ?? raw?.title ?? raw?.name
  return typeof v === 'string' ? v.trim() : ''
}

export interface TodoCounts {
  pending: number
  running: number
  done: number
  cancelled: number
  total: number
}

/** 统计各状态条数（UI 进度与工具返回共用） */
export function todoCounts(todos: TodoItem[]): TodoCounts {
  const counts: TodoCounts = { pending: 0, running: 0, done: 0, cancelled: 0, total: todos.length }
  for (const t of todos) counts[t.status] = (counts[t.status] || 0) + 1
  return counts
}

/** 面向模型的确认文案（对齐 DSH 的 `Updated todo list: …` 渲染） */
export function todoSummaryText(counts: TodoCounts): string {
  return `任务清单已更新：${counts.pending} 项待办、${counts.running} 项进行中、${counts.done} 项已完成` +
    (counts.cancelled ? `、${counts.cancelled} 项已取消` : '') +
    `（共 ${counts.total} 项）。`
}

/**
 * 解析结果：`ok=false` 时 `error` 是可直接回给模型的修正提示。
 * 用一个结构而非可判别联合，是为了调用方（主进程 / 渲染层）都能只做一次
 * `if (!parsed.ok)` 判断，不必各自维护类型收窄。
 */
export interface ParsedTodoList {
  ok: boolean
  todos: TodoItem[]
  counts: TodoCounts
  message: string
  /** 是否为空清单（= 模型主动清空） */
  cleared: boolean
  /** ok=false 时的失败原因（面向模型的可操作提示） */
  error?: string
}

/** 构造一个失败结果（保持字段齐全，调用方无需判空） */
function todoFailure(error: string): ParsedTodoList {
  return {
    ok: false,
    todos: [],
    counts: { pending: 0, running: 0, done: 0, cancelled: 0, total: 0 },
    message: '',
    cleared: false,
    error,
  }
}

/**
 * 严格解析一次 update_todo 入参（fail-loud）。
 *
 * @param raw 模型传入的 `todos`（必须是数组；空数组表示清空）
 * @param prev 上一版清单：用于让同一条待办沿用原 id（UI 勾选状态与投影兜底都依赖 id 稳定）
 * @returns 规范化后的清单 + 计数 + 确认文案，或可直接回给模型的错误说明
 */
export function parseTodoList(raw: unknown, prev: TodoItem[] = []): ParsedTodoList {
  if (!Array.isArray(raw)) {
    return todoFailure('todos 必须是数组（完整清单；清空请传空数组 []）')
  }
  if (raw.length > TODO_LIST_MAX) {
    return todoFailure(`待办清单最多 ${TODO_LIST_MAX} 项（收到 ${raw.length} 项）：请合并同一步骤，只保留可验收的具体步骤`)
  }

  const prevByText = new Map(prev.map((t) => [String(t.title || '').trim(), t]))
  const usedIds = new Set<string>()
  const seenText = new Set<string>()
  const todos: TodoItem[] = []
  let running = 0

  for (let i = 0; i < raw.length; i++) {
    const item: any = raw[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return todoFailure(`第 ${i + 1} 项不是对象：每项需为 { content, status }（可选 detail）`)
    }
    const text = todoTextOf(item)
    if (!text) {
      return todoFailure(`第 ${i + 1} 项缺少任务描述：请用 content 写一句简短的祈使句（如「读取配置」）`)
    }
    if (text.length > TODO_TEXT_MAX) {
      return todoFailure(`第 ${i + 1} 项过长（${text.length} 字符，上限 ${TODO_TEXT_MAX}）：请精简为一句可验收的动作描述，细节放 detail`)
    }
    if (seenText.has(text)) {
      return todoFailure(`第 ${i + 1} 项与前面的待办重复：${JSON.stringify(text)}；同一件事只保留一项`)
    }
    seenText.add(text)

    const status = normalizeTodoStatus(item.status)
    if (!status) {
      return todoFailure(`第 ${i + 1} 项的状态非法（${JSON.stringify(item.status)}）：只接受 ${TODO_STATUSES.join(' | ')}`)
    }
    if (status === 'running') running++

    // id 稳定：显式 id（未被占用）→ 上一版同文本的 id → 上一版同位置 → 顺序编号
    const explicit = typeof item.id === 'string' ? item.id.trim() : ''
    let id = ''
    if (explicit && !usedIds.has(explicit)) id = explicit
    if (!id) {
      const matched = prevByText.get(text)
      if (matched && !usedIds.has(String(matched.id))) id = String(matched.id)
    }
    if (!id) {
      // 上一版按位对齐（文本被改写但仍是同一步时，避免 id 抖动导致 UI 勾选丢失）
      const byPos = prev[i]
      if (byPos && !usedIds.has(String(byPos.id))) id = String(byPos.id)
    }
    if (!id) id = `todo-${i + 1}`
    if (usedIds.has(id)) id = `todo-${i + 1}`
    usedIds.add(id)

    const detail = typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim() : undefined
    const todo: TodoItem = { id, title: text, status }
    if (detail) todo.detail = detail
    todos.push(todo)
  }

  if (running > 1) {
    return todoFailure(
      `同一时刻只能有 1 项 running（收到 ${running} 项）：请把其余的改为 pending——进行中的工作只留一项，做完一项再开启下一项`,
    )
  }

  const counts = todoCounts(todos)
  return { ok: true, todos, counts, message: todoSummaryText(counts), cleared: todos.length === 0 }
}

/**
 * 宽松归一化（**不抛错、不拒绝**）：供 UI 投影 / 旧存档读取使用。
 * 旧版本会把模型原始状态直接落盘（可能含 `in_progress` / `completed`），
 * 这里一律归一，避免界面出现无法识别的状态。
 *
 * @param raw 任意来源的一条待办
 * @param index 顺序（兜底 id / 标题用）
 * @param prev 可选的上一版（沿用 id）
 */
export function coerceTodoItem(raw: any, index: number, prev?: TodoItem): TodoItem {
  const text = todoTextOf(raw) || (prev ? String(prev.title || '').trim() : '') || `待办 ${index + 1}`
  const prevStatus: TodoStatus | undefined = prev ? normalizeTodoStatus(prev.status) : undefined
  const status: TodoStatus = normalizeTodoStatus(raw?.status) ?? prevStatus ?? 'pending'
  const id = (typeof raw?.id === 'string' && raw.id.trim())
    || (prev ? String(prev.id) : '')
    || `todo-${index + 1}`
  const detailRaw = raw?.detail ?? raw?.description
  const detail = typeof detailRaw === 'string' && detailRaw.trim() ? detailRaw.trim() : undefined
  const item: TodoItem = { id, title: text, status }
  if (detail) item.detail = detail
  return item
}

/** 宽松归一化整张清单（UI 投影入口） */
export function coerceTodoList(raw: unknown, prev: TodoItem[] = []): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const prevByText = new Map(prev.map((t) => [String(t.title || '').trim(), t]))
  return raw.slice(0, TODO_LIST_MAX).map((item, i) => coerceTodoItem(item, i, prevByText.get(todoTextOf(item)) ?? prev[i]))
}
