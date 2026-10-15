/**
 * agentTodo.selftest.ts — 待办清单规范化 / 校验的纯逻辑自测
 *
 * 覆盖 update_todo 工具写入前的全部校验分支（DSH `todo_write` 的整表替换 + fail-loud
 * 语义），以及投影层的宽松归一化（旧存档里的 `in_progress` / `completed` 照样能显示）。
 * 运行：npm run test:selftest agentTodo
 */

import { parseTodoList, coerceTodoList, normalizeTodoStatus, todoSummaryText, TODO_LIST_MAX } from './agentTodo'
import type { TodoItem } from '@/types/agent'

export interface AgentTodoCase {
  name: string
  ok: boolean
  detail?: string
}

const prev: TodoItem[] = [
  { id: 'todo-1', title: '读取配置', status: 'done' },
  { id: 'todo-2', title: '改造工具', status: 'pending' },
]

export function runAgentTodoSelfTest(): AgentTodoCase[] {
  const cases: AgentTodoCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  // ---- 状态别名（DSH 词表） ----
  check('别名 in_progress → running', normalizeTodoStatus('in_progress') === 'running')
  check('别名 completed → done', normalizeTodoStatus('completed') === 'done')
  check('别名 In-Progress（大小写/短横线）→ running', normalizeTodoStatus('In-Progress') === 'running')
  check('别名 canceled → cancelled', normalizeTodoStatus('canceled') === 'cancelled')
  check('未知状态返回 undefined', normalizeTodoStatus('whatever') === undefined)

  // ---- 正常路径：content 写法 + 计数 + 确认文案 ----
  const okList = parseTodoList([
    { content: '读取配置', status: 'done' },
    { content: '改造工具', status: 'running' },
    { content: '跑自测', status: 'pending', detail: 'node scripts/run-selftests.mjs' },
  ], prev)
  check('合法清单通过校验', okList.ok === true, okList.error)
  check('计数正确', okList.counts.total === 3 && okList.counts.done === 1 && okList.counts.running === 1 && okList.counts.pending === 1, JSON.stringify(okList.counts))
  check('确认文案含计数', okList.message.includes('1 项进行中') && okList.message.includes('共 3 项'), okList.message)
  check('detail 保留', okList.todos[2]?.detail === 'node scripts/run-selftests.mjs')
  check('同文本沿用上一版 id', okList.todos[0]?.id === 'todo-1' && okList.todos[1]?.id === 'todo-2', okList.todos.map((t) => t.id).join(','))

  // ---- title 写法（本产品历史字段）仍被接受 ----
  const titleList = parseTodoList([{ title: '旧写法任务', status: 'pending' }])
  check('title 兼容为任务文本', titleList.ok && titleList.todos[0]?.title === '旧写法任务', titleList.error)
  check('content 优先于 title', parseTodoList([{ content: 'A', title: 'B', status: 'pending' }]).todos[0]?.title === 'A')

  // ---- fail-loud：非法输入一律拒绝 ----
  check('非数组拒绝', parseTodoList('nope').ok === false)
  check('空文本拒绝', parseTodoList([{ content: '   ', status: 'pending' }]).ok === false)
  check('缺 content 拒绝', parseTodoList([{ status: 'pending' }]).ok === false)
  check('重复项拒绝', parseTodoList([{ content: 'A', status: 'pending' }, { content: 'A', status: 'done' }]).ok === false)
  check('非法状态拒绝', parseTodoList([{ content: 'A', status: 'working' }]).ok === false)
  check('非对象项拒绝', parseTodoList(['A']).ok === false)
  const twoRunning = parseTodoList([{ content: 'A', status: 'running' }, { content: 'B', status: 'in_progress' }])
  check('两项 running 拒绝（单活跃规则）', twoRunning.ok === false, twoRunning.error)
  check('超长文本拒绝', parseTodoList([{ content: 'x'.repeat(201), status: 'pending' }]).ok === false)
  check('超出清单上限拒绝', parseTodoList(Array.from({ length: TODO_LIST_MAX + 1 }, (_, i) => ({ content: `任务 ${i}`, status: 'pending' }))).ok === false)
  check('恰好上限通过', parseTodoList(Array.from({ length: TODO_LIST_MAX }, (_, i) => ({ content: `任务 ${i}`, status: 'pending' }))).ok === true)

  // ---- 清空 ----
  const cleared = parseTodoList([], prev)
  check('空数组 = 清空', cleared.ok === true && cleared.cleared === true && cleared.todos.length === 0)

  // ---- 宽松归一（UI 投影 / 旧存档） ----
  const coerced = coerceTodoList([
    { title: '旧存档进行中', status: 'in_progress' },
    { title: '旧存档完成', status: 'completed' },
    { content: '无状态' },
    { content: '坏状态', status: 'weird' },
  ])
  check('投影归一 DSH 状态', coerced[0]?.status === 'running' && coerced[1]?.status === 'done', JSON.stringify(coerced.map((t) => t.status)))
  check('投影缺状态兜底 pending', coerced[2]?.status === 'pending')
  check('投影坏状态兜底 pending', coerced[3]?.status === 'pending')
  check('投影非数组返回空', coerceTodoList(null).length === 0)
  check('投影生成稳定 id', coerced.every((t) => typeof t.id === 'string' && t.id.length > 0))

  // ---- 摘要文案 ----
  const summary = todoSummaryText({ pending: 2, running: 1, done: 3, cancelled: 1, total: 7 })
  check('摘要含全部状态计数', summary.includes('2 项待办') && summary.includes('1 项进行中') && summary.includes('3 项已完成') && summary.includes('1 项已取消'), summary)

  return cases
}

/** 命令行入口（scripts/run-selftests.mjs 优先调用 log*） */
export function logAgentTodoSelfTest(): boolean {
  const cases = runAgentTodoSelfTest()
  const bad = cases.filter((c) => !c.ok)
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  console.log(`[agentTodo] ${cases.length - bad.length}/${cases.length} passed`)
  return bad.length === 0
}
