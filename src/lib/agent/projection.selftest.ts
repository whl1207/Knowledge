/**
 * projection.selftest.ts — agent 时间线投影的跨轮隔离
 *
 * 回归点：同一个 agent 会话被跨轮 resume 时，bridge 视图里仍留着上一轮的 steps。
 * 新建的 assistant 消息如果直接投影，会把上一轮的工具卡片 / 思考过程追加到新消息里。
 * `minTurn` 是最后一道兜底：只投影本轮步骤，旧轮次一律跳过。
 *
 * 用法：`node scripts/run-selftests.mjs projection`
 */

import { projectStepsToUnits, projectUsage } from './projection'

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

  // 5) 右上角运行信息：轮/步即使本步还没拿到 usage 也要跟着事件推进
  {
    const msg: any = {}
    projectUsage(msg, { turn: 2, step: 4 })
    add('无 usage 时也投影轮/步', msg.agentTurn === 2 && msg.agentStep === 4, `T${msg.agentTurn}/S${msg.agentStep}`)
    add('无 usage 时不写 tokenStats', msg.tokenStats === undefined)
  }

  // 6) 单轮口径 + 缓存命中：总量取 turnUsageTotal（不是会话累计 usageTotal）
  {
    const msg: any = {}
    projectUsage(msg, {
      turn: 3,
      step: 5,
      usageTotal: 999999,          // 会话累计（跨轮）——不应被消息拿走
      turnUsageTotal: 1200,        // 本轮累计
      turnPromptTotal: 5000,       // 本轮各步 prompt 之和（缓存比例分母）
      turnCachedTotal: 3500,       // 本轮命中之和
      turnCacheReported: true,
      lastUsage: { promptTokens: 800, completionTokens: 200, totalTokens: 1000, cachedTokens: 600, cacheReported: true },
    })
    add('轮/步投影', msg.agentTurn === 3 && msg.agentStep === 5, `T${msg.agentTurn}/S${msg.agentStep}`)
    add('消息总量取本轮累计而不是会话累计', msg.tokenStats?.totalTokens === 1200, `total=${msg.tokenStats?.totalTokens}`)
    add('上下文占用仍取最后一步 prompt', msg.tokenStats?.promptTokens === 800, `prompt=${msg.tokenStats?.promptTokens}`)
    add('缓存字段投影（命中/分母）',
      msg.tokenStats?.cacheReported === true && msg.tokenStats?.cachedTokens === 3500 && msg.tokenStats?.promptTokensTotal === 5000,
      `cached=${msg.tokenStats?.cachedTokens} promptTotal=${msg.tokenStats?.promptTokensTotal}`)
  }

  // 7) 来源不报缓存：不写缓存字段（界面据此不显示缓存比例，而不是显示 0%）
  {
    const msg: any = {}
    projectUsage(msg, {
      turn: 1,
      step: 1,
      turnUsageTotal: 100,
      turnPromptTotal: 80,
      turnCacheReported: false,
      lastUsage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
    })
    add('来源不报缓存 → 不写缓存字段', msg.tokenStats?.cacheReported === undefined && msg.tokenStats?.cachedTokens === undefined)
    add('普通 usage 仍投影总量', msg.tokenStats?.totalTokens === 100, `total=${msg.tokenStats?.totalTokens}`)
  }

  return cases
}
