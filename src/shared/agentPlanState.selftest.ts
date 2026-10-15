/**
 * agentPlanState.selftest.ts — 计划 / 待办日志折叠的纯逻辑自测
 *
 * 覆盖 DSH 的「仅记日志、最后一条胜出」语义：整值替换、清除、顺序、
 * 脏数据归一，以及无关事件不制造新对象（响应式友好）。
 * 运行：npm run test:selftest agentPlanState
 */

import { emptyPlanTodoState, foldPlanTodoEvents, foldPlanTodoState } from './agentPlanState'

export interface AgentPlanStateCase {
  name: string
  ok: boolean
  detail?: string
}

export function runAgentPlanStateSelfTest(): AgentPlanStateCase[] {
  const cases: AgentPlanStateCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, detail })

  check('初始为空状态', foldPlanTodoEvents([]).plan === null && foldPlanTodoEvents([]).todos.length === 0)
  check('空状态工厂每次新对象', emptyPlanTodoState() !== emptyPlanTodoState())

  // 最后一条胜出
  const folded = foldPlanTodoEvents([
    { type: 'session/start' },
    { type: 'plan/write', plan: '# 计划 v1' },
    { type: 'todo/write', todos: [{ id: 'a', title: '第一步', status: 'running' }] },
    { type: 'tool/result' },
    { type: 'plan/write', plan: '# 计划 v2' },
  ])
  check('计划取最后一条', folded.plan === '# 计划 v2', String(folded.plan))
  check('待办取最后一条', folded.todos.length === 1 && folded.todos[0]?.title === '第一步')
  check('无关事件不影响状态', foldPlanTodoEvents([{ type: 'agent/status' }]).plan === null)

  // 清除语义
  const cleared = foldPlanTodoEvents([
    { type: 'plan/write', plan: '# 计划' },
    { type: 'todo/write', todos: [{ id: 'a', title: 'x', status: 'pending' }] },
    { type: 'plan/write', plan: null },
    { type: 'todo/write', todos: [] },
  ])
  check('plan=null 清除计划', cleared.plan === null)
  check('todos=[] 清空清单', cleared.todos.length === 0)
  check('空白计划视为清除', foldPlanTodoEvents([{ type: 'plan/write', plan: '   ' }]).plan === null)

  // 脏数据归一
  const dirty = foldPlanTodoEvents([{
    type: 'todo/write',
    todos: [
      { id: 'a', title: '  合法  ', status: 'done' },
      { id: 'b', content: '用 content 也能读', status: 'in_progress' },
      { id: 'c', title: '', status: 'pending' },
      { id: 'd', title: '未知状态', status: 'wat' },
      null,
    ],
  }])
  check('去空白保留 title', dirty.todos[0]?.title === '合法' && dirty.todos[0]?.status === 'done')
  check('content 兼容为 title', dirty.todos[1]?.title === '用 content 也能读')
  check('空文本项被丢弃', dirty.todos.length === 3, JSON.stringify(dirty.todos.map((t) => t.id)))
  check('未知状态回落 pending', dirty.todos[2]?.status === 'pending')
  check('非数组 → 空清单', foldPlanTodoEvents([{ type: 'todo/write', todos: 'nope' }]).todos.length === 0)

  // 引用语义：无关事件返回同一个引用（避免无谓的响应式更新）
  const base = emptyPlanTodoState()
  check('无关事件返回同一引用', foldPlanTodoState(base, { type: 'turn/start' }) === base)
  check('plan/write 返回新引用且保留 todos', foldPlanTodoState(base, { type: 'plan/write', plan: 'p' }).todos === base.todos)

  // ---- 计划评审：待裁决状态（进程重启后可恢复的那条事实） ----
  check('初始无待评审', emptyPlanTodoState().pendingReview === null)
  const opened = foldPlanTodoEvents([
    { type: 'plan/review', reviewId: 'review-1', plan: '# 计划' },
  ])
  check('plan/review → 记下待评审', opened.pendingReview?.reviewId === 'review-1' && opened.pendingReview?.plan === '# 计划')
  check('重启场景：只有 review 没有 result → 仍待评审', foldPlanTodoEvents([
    { type: 'session/start' },
    { type: 'plan/review', reviewId: 'review-9', plan: 'P' },
    { type: 'turn/start' },
  ]).pendingReview?.reviewId === 'review-9')

  const settled = foldPlanTodoEvents([
    { type: 'plan/review', reviewId: 'review-1', plan: '# 计划' },
    { type: 'plan/review-result', reviewId: 'review-1', verdict: 'keep', feedback: ' 先备份 ' },
  ])
  check('裁决后清空待评审', settled.pendingReview === null)
  check('裁决结果被记录（含反馈归一）', settled.lastReviewResult?.verdict === 'keep' && settled.lastReviewResult?.feedback === '先备份', JSON.stringify(settled.lastReviewResult))
  check('cancelled 裁决同样结算', foldPlanTodoEvents([
    { type: 'plan/review', reviewId: 'r', plan: 'p' },
    { type: 'plan/review-result', reviewId: 'r', verdict: 'cancelled' },
  ]).pendingReview === null)
  check('迟到的裁决不误关新评审', foldPlanTodoEvents([
    { type: 'plan/review', reviewId: 'old', plan: 'p1' },
    { type: 'plan/review', reviewId: 'new', plan: 'p2' },
    { type: 'plan/review-result', reviewId: 'old', verdict: 'approve' },
  ]).pendingReview?.reviewId === 'new')
  check('缺 reviewId 的事件被忽略', foldPlanTodoState(base, { type: 'plan/review', plan: 'p' }) === base)
  check('重复开启同一评审保持最新计划', foldPlanTodoEvents([
    { type: 'plan/review', reviewId: 'r', plan: 'v1' },
    { type: 'plan/review', reviewId: 'r', plan: 'v2' },
  ]).pendingReview?.plan === 'v2')
  check('评审不影响计划与清单', (() => {
    const s = foldPlanTodoEvents([
      { type: 'plan/write', plan: 'P' },
      { type: 'todo/write', todos: [{ id: 'a', title: 'x', status: 'pending' }] },
      { type: 'plan/review', reviewId: 'r', plan: 'P' },
    ])
    return s.plan === 'P' && s.todos.length === 1
  })())

  return cases
}

/** 命令行入口（scripts/run-selftests.mjs 优先调用 log*） */
export function logAgentPlanStateSelfTest(): boolean {
  const cases = runAgentPlanStateSelfTest()
  const bad = cases.filter((c) => !c.ok)
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  console.log(`[agentPlanState] ${cases.length - bad.length}/${cases.length} passed`)
  return bad.length === 0
}
