/**
 * swarmRoom.ts — Agent Teams 房间模型（群聊 = cc-haha 式 Agent Teams）
 *
 * 设计见 `docs/plan/群聊-AgentTeams-实施设计（逐文件）.md`：
 * - **Room**（房间）持久在对话上；**Episode**（回合）是一次编排运行，临时；
 *   **Task** 属于 Episode。
 * - 房间的**事实源在渲染层**（`src/store/swarmRoom.ts`）：主进程协议工具只做转发。
 * - 消息投递复用 `agentBridge.send`（空闲唤醒）/ `steer`（运行中投递到下一 step 边界）。
 */

// ---------------------------------------------------------------------------
// 成员
// ---------------------------------------------------------------------------

export type SwarmMemberStatus = 'idle' | 'running' | 'blocked' | 'stopped'

/** 房间成员（名册，可寻址）。idx 恒等于 swarmState.agents 的下标 */
export interface SwarmTeamMember {
  idx: number
  /** 具名（唯一、可被 send_message 寻址） */
  name: string
  /** 角色说明（进 Lead 的团队说明） */
  role: string
  model?: string
  tools?: string[] | null
  permission?: 'default' | 'readonly' | 'auto'
  status: SwarmMemberStatus
  /** 当前正在执行的任务 id */
  currentTaskId?: string
  /** agentBridge 会话 id（懒创建，Episode 内复用，Episode 结束 dispose） */
  sessionId?: string
  lastActiveAt?: number
  tokens?: { in: number; out: number }
  /** 累计消耗 token 数（会话 usageTotal 增量累加；工作台活动指标） */
  tokensTotal?: number
  toolCount?: number
  /** 最近若干次工具名（对齐 cc-haha 的"最近 5 次活动"） */
  recentTools?: string[]
  /** 未 spawn（无 sessionId）时收到的消息暂存，spawn 时注入 */
  pending?: SwarmMessage[]
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

export type SwarmTaskStatus = 'pending' | 'ready' | 'running' | 'done' | 'error' | 'cancelled'

/** 共享任务板上的一个任务（对齐 cc-haha 的共享任务目录条目） */
export interface SwarmTask {
  id: string
  episodeId: string
  /** 3~8 字短标题（看板用） */
  title: string
  /** 完整任务描述（发给执行者） */
  prompt: string
  /** 负责人（名册下标）；undefined = 待认领 */
  assignee?: number
  /** 依赖任务 id */
  deps: string[]
  status: SwarmTaskStatus
  /** 后台执行：不阻塞主流程 */
  background?: boolean
  /** 最终产出（截断存储） */
  output?: string
  /** post_artifact 得到的产出物名（预留） */
  artifactRefs?: string[]
  createdAt: number
  startedAt?: number
  endedAt?: number
  error?: string
  /** 对应 swarmState.executionOrder 的调用序号（点任务卡可跳运行详情） */
  invSeq?: number
}

// ---------------------------------------------------------------------------
// 消息（结构化通信）
// ---------------------------------------------------------------------------

export type SwarmMessageKind = 'request' | 'inform' | 'handoff' | 'question' | 'reply'

export interface SwarmMessage {
  id: string
  episodeId: string
  from: number | 'lead' | 'user'
  to: number | 'lead' | '*' | 'user'
  kind: SwarmMessageKind
  /** 一句话摘要（进群聊时间线） */
  summary: string
  /** 完整正文（仅投递时进入接收方上下文） */
  content?: string
  replyTo?: string
  ts: number
  /** 是否已投递（送达会话或暂存 pending） */
  delivered: boolean
  /** 是否已被接收方消费（注入过 prompt） */
  consumed?: boolean
}

// ---------------------------------------------------------------------------
// 回合
// ---------------------------------------------------------------------------

export type SwarmEpisodeStatus = 'running' | 'done' | 'aborted'

export interface SwarmEpisode {
  id: string
  chatId: string
  /** 群主/Lead 名册下标；-1 = 中立 LLM。本方案默认由第一个成员兼任（0） */
  leadIdx: number
  /** 用户原始目标 */
  goal: string
  status: SwarmEpisodeStatus
  startedAt: number
  endedAt?: number
}

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------

export interface SwarmRoom {
  chatId: string
  /** 名册（持久） */
  members: SwarmTeamMember[]
  /** 当前 Episode 的任务板 */
  tasks: SwarmTask[]
  /** 当前 Episode 的协议消息（群聊已投影进 chat.messages） */
  messages: SwarmMessage[]
  /** 本回合产生的产出物（post_artifact） */
  artifacts: SwarmArtifact[]
  episode: SwarmEpisode | null
  /** 并发闸门（本地调度上限） */
  maxInflight: number
}

/** 产出物（post_artifact 落盘的工件） */
export interface SwarmArtifact {
  name: string
  path: string
  bytes: number
  /** 产生它的任务（若有） */
  taskId?: string
  /** 产生的成员下标 */
  agentIdx?: number
  at: number
}

/** 渲染层任务（`agent/renderer-task`，kind='swarm_room'）的载荷 */
export interface SwarmRoomTaskPayload {
  /** 协议操作名：spawn / task_create / task_list / task_update / task_claim / task_delete / say / shutdown / delete */
  op: string
  args: Record<string, any>
  /** 发起调用的 agent 会话 id（用于反查调用者身份） */
  agentId?: string
  /** 归属对话 id（缺省用当前运行的对话） */
  chatId?: string
}

/** 协议操作结果（回传主进程 → 模型） */
export interface SwarmRoomTaskResult {
  ok: boolean
  value?: any
  error?: string
}
