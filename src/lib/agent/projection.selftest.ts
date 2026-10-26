/**
 * projection.selftest.ts — agent 时间线投影的跨轮隔离
 *
 * 回归点：同一个 agent 会话被跨轮 resume 时，bridge 视图里仍留着上一轮的 steps。
 * 新建的 assistant 消息如果直接投影，会把上一轮的工具卡片 / 思考过程追加到新消息里。
 * `minTurn` 是最后一道兜底：只投影本轮步骤，旧轮次一律跳过。
 *
 * 用法：`node scripts/run-selftests.mjs projection`
 */

import { projectStepsToUnits } from './projection'

export interface ProjectionCase { name: string; ok: boolean; detail?: string }

function viewWithSteps() {
  return {
    turn: 2,
    searchEvents: [],
    steps: [
      {
        turn: 1,
        step: 1,
        stream: '',
        content: '上一轮正文',
        reasoning: '',
        toolCalls: [
          {
            callId: 'call-old',
            name: 'write_file',
            args: { path: 'old.txt', content: 'old' },
            status: 'success',
            result: { path: 'old.txt', bytes: 3 },
            startTime: 1,
            endTime: 2,
          },
        ],
        startTime: 1,
        endTime: 2,
      },
      {
        turn: 2,
        step: 1,
        stream: '',
        content: '本轮正文',
        reasoning: '',
        toolCalls: [
          {
            callId: 'call-new',
            name: 'write_file',
            // 模拟流式未闭合参数：JSON 去掉最后一个 `}`（前端从原文提取 content 字数）
            args: JSON.stringify({ path: 'new.txt', content: 'new' }).slice(0, -1),
            status: 'running',
            startTime: 3,
          },
        ],
        startTime: 3,
      },
    ],
  }
}

export function runProjectionSelfTest(): ProjectionCase[] {
  const cases: ProjectionCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1) 不带 minTurn：兼容旧行为，全部步骤都投影（切模块后重新挂接运行中的会话）
  {
    const msg: any = { executionUnits: [] }
    projectStepsToUnits(msg, viewWithSteps())
    const ids = msg.executionUnits.map((u: any) => u.id)
    add('无 minTurn → 保留全部步骤', ids.includes('call-old') && ids.includes('call-new'), ids.join(','))
  }

  // 2) minTurn=2：上一轮的步骤 / 正文全部跳过，只剩本轮工具
  {
    const msg: any = { executionUnits: [] }
    projectStepsToUnits(msg, viewWithSteps(), { minTurn: 2 })
    const ids = msg.executionUnits.map((u: any) => u.id)
    add('minTurn=2 → 跳过上一轮', !ids.includes('call-old') && ids.includes('call-new'), ids.join(','))
    add('minTurn=2 → 跳过上一轮正文', !msg.executionUnits.some((u: any) => u.id === 'content-1-1'))
    const tool = msg.executionUnits.find((u: any) => u.id === 'call-new')
    add('本轮工具保留流式原始参数', typeof tool?.args === 'string' && tool.args.includes('new.txt'))
  }

  // 3) 旧消息本身已经在消息里的单元不被新投影覆盖（按 id 合并）
  {
    const msg: any = {
      executionUnits: [
        { id: 'call-new', status: 'success', result: 'done', description: 'write_file' },
      ],
    }
    projectStepsToUnits(msg, viewWithSteps(), { minTurn: 2 })
    const tool = msg.executionUnits.find((u: any) => u.id === 'call-new')
    // 视图里是 running 且无结果 → 不能用它覆盖已经带结果的同 id 单元
    add('已有结果的同 id 单元不被中间态覆盖', tool?.status === 'success' && tool?.result === 'done')
  }

  // 4) 旧数据没有 turn 字段：保持兼容，照常投影（不能因此整段消失）
  {
    const v: any = {
      turn: 3,
      searchEvents: [],
      steps: [{ step: 1, stream: '无 turn 的旧数据', content: '', reasoning: '', toolCalls: [], startTime: 1 }],
    }
    const msg: any = { executionUnits: [] }
    projectStepsToUnits(msg, v, { minTurn: 3 })
    add('缺 turn 的旧步骤仍投影', msg.executionUnits.length === 1, `units=${msg.executionUnits.length}`)
  }

  return cases
}
