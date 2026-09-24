/**
 * useSwarmChat.ts — 集群消息写入对话（与普通/智能体模式共用同一套消息与渲染）
 *
 * 集群不再有独立的「群聊流」组件：成员汇报就是 `chat.messages` 里的 assistant 消息，
 * 工具调用/思考走 `executionUnits`（由 `src/lib/agent/projection` 投影，与 useAgentRun 同一实现），
 * 因此渲染代码、样式、交互与其它模式完全一致，并免费获得持久化 / 分支 / 搜索 /
 * token 统计 / 停止 / 断线续跑。
 */

import { chatsRef } from '@/store/chats'
import { swarmRunChatId } from '@/store/swarmState'
import type { ChatMessage } from '@/types/chat'

/** 取本次运行所属对话（未设置或对话已删除时返回 null） */
export function swarmRunChat(): any | null {
  const id = swarmRunChatId.value
  if (!id) return null
  return (chatsRef.value || []).find((c: any) => c.id === id) || null
}

/**
 * 追加一条消息到所属对话，返回**响应式引用**。
 *
 * 注意：必须用返回值做后续流式更新 —— push 前创建的原始对象不会被 Vue 代理，
 * 直接改它不会触发渲染（与 useAgentRun 中 `reactive(assistantMsg)` 的原因相同）。
 */
export function pushSwarmMessage(msg: Partial<ChatMessage>): ChatMessage | null {
  const chat = swarmRunChat()
  if (!chat) return null
  chat.messages.push(msg as ChatMessage)
  return chat.messages[chat.messages.length - 1] as ChatMessage
}

/** 成员汇报消息（assistant，工具调用/思考随后由投影写入 executionUnits） */
export function pushMemberMessage(agentIdx: number, name: string, seq?: number): ChatMessage | null {
  return pushSwarmMessage({
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    // isExecuting 驱动「执行中」指示与停止按钮（与智能体模式一致）
    isExecuting: true,
    // 注意：**不设 executionType / executionName**
    //  - executionType='skill' 会被智能体的「会话对账 / 停止」逻辑当成自己的消息接管
    //    （会误写“本次执行未产生内容，可能已被中断”并提前清执行态）；
    //  - executionName 会以工作流的 [名称] 后缀展示，而成员名已由消息头直接显示。
    _startTime: Date.now(),
    swarmAgent: { idx: agentIdx, name, seq, status: 'running' },
  })
}

/** 用户任务消息（与其他模式一致：任务作为普通 user 消息进入对话） */
export function pushUserTaskMessage(text: string): ChatMessage | null {
  return pushSwarmMessage({ role: 'user', content: text, timestamp: Date.now() })
}

/** 系统消息（错误等；过程性提示不写入对话，避免污染聊天记录） */
export function pushSystemMessage(text: string): ChatMessage | null {
  return pushSwarmMessage({ role: 'system', content: text, timestamp: Date.now() })
}

/** 标记成员汇报消息结束 */
export function finishMemberMessage(msg: ChatMessage | null, status: 'done' | 'error'): void {
  if (!msg) return
  msg.isExecuting = false
  if (msg.swarmAgent) msg.swarmAgent.status = status
}
