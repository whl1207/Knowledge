/**
 * swarmState.ts — 集群模块级共享状态（单一事实源）
 *
 * 集群运行态是模块级单例：成员由**当前对话**的 `swarmPresetIds` 在发送前派生后写入
 * `agents`（见 `useSwarmMembers`），消息则直接写入该对话的 `messages`
 * （见 `useSwarmChat`）。这里只保留「运行配置 + 运行态」，不再有预案文件、
 * 关系图谱、资源库与输出契约。
 */

import { ref } from 'vue'
import { setActivePinia } from 'pinia'
import { pinia } from '@/store/pinia'
import { usestore } from '@/store'
import type { StepView } from '@/platform/agentBridge'
import type { SwarmAgent, SwarmAgentRunState, SwarmRunMode } from '@/types/swarm'

// 模块级访问 store：先激活共享 Pinia（与 main.ts app.use(pinia) 同一实例），
// 否则 import 阶段调用 usestore() 会因“没有 active Pinia”而抛错。
setActivePinia(pinia)
export const store = usestore()

// ==================== 成员（= Agent 预设引用派生结果） ====================

/** 本次运行的成员列表（发送前由 useSwarmMembers.applyMembers 写入；顺序 = 发言顺序） */
export const agents = ref<SwarmAgent[]>([])

export interface SkillInfo { name: string; description: string; path: string }
export const skillList = ref<SkillInfo[]>([])

export interface KbFileInfo { label: string; path: string }
export const knowledgeBaseList = ref<KbFileInfo[]>([])

// ==================== 运行配置（每次发送前由对话 config 写入） ====================

/** 执行模式（策略键，见 src/lib/agent/swarmStrategies.ts）；auto = 全员响应，debate = 辩论 */
export const swarmMode = ref<SwarmRunMode>('auto')
export const debateRounds = ref(2)
export const hideModeHint = ref(false)
/** 运行细节设置（collabMode / enableHostSummary / managerAgentIdx / injectHistory） */
export const settings = ref<Record<string, any>>({})

// ==================== 运行归属与代际 ====================

/**
 * 本次集群运行所属对话 id：成员汇报 / 用户任务写入该对话的 `messages`
 * （与其它模式同一套渲染与持久化）。
 */
export const swarmRunChatId = ref<string | null>(null)
export function setSwarmRunChatId(id: string | null) { swarmRunChatId.value = id }

/**
 * 运行代际：切换对话 / 重新派发时递增。
 * 旧代际的运行仍在主进程后台执行，但其 UI 写入（消息/状态）会被隔离，不污染当前对话。
 */
export const runEpoch = ref(0)
export function bumpRunEpoch() { runEpoch.value++ }

// ==================== 运行态 ====================

export const running = ref(false)
export const currentRound = ref(0)
export const agentRunStates = ref<Record<number, SwarmAgentRunState>>({})
export const elapsedMs = ref(0)
export const outputContainer = ref<HTMLElement | null>(null)

/** 当前集群运行对应的后台任务 id（供进度上报） */
export let activeSwarmJobId: string | null = null
export function setActiveSwarmJobId(id: string | null) { activeSwarmJobId = id }

// ==================== 会话与执行时间线 ====================

/**
 * 已挂接流式输出的 swarm 会话 id（跨标签切换 / 停止时保留）。
 * 用于避免重复挂接造成同一条汇报出现两次。
 */
export const attachedSwarmViews = new Set<string>()

/** 成员调用序号（每个成员第几次发言，用于标识发言轮次） */
export const agentStepSeq = ref<Record<number, number>>({})
/** 主进程会话 id → { 成员下标, 调用序号 } */
export const agentViewSeq = ref<Record<string, { agentIdx: number; seq: number }>>({})

/** 本轮被 @点名 / 被群主撮合而追加发言的成员下标（避免重复唤起） */
export const summonedMembers = ref<number[]>([])

/** 执行顺序时间线（内部状态展示用） */
export const executionOrder = ref<Array<{
  agentIdx: number
  stage?: string
  round?: number
  seq: number
  generic?: boolean
  time: number
}>>([])

/** 每次调用的结束状态（`${agentIdx}|${seq}` → running/done/error） */
export const invocationRunStates = ref<Record<string, string>>({})

/** 成员的原始步骤视图（会话日志级数据；消息渲染走 executionUnits） */
export const agentStepViews = ref<Record<number, StepView[]>>({})
export const selectedStepKey = ref<string | null>(null)
export const stepFollowUserPicked = ref(false)
