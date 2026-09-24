// src/store/chats.ts
// 模块级共享「聊天 + 执行状态」
//
// 背景：home.vue 由 App.vue 用 v-if 挂载，切换模块（mainPanel）会卸载组件。
// 技能模式（ReAct 循环）与工作流模式（WorkflowRunner）的执行由渲染进程驱动，
// 若状态放在组件内，卸载即丢失；同时后台执行与重进组件会读写两处状态互相覆盖。
// 因此把 chats 与 globalExecutionState 提升为模块级 ref（单一数据源）：
// - 切模块卸载时不再中断技能/工作流，后台执行继续写入同一 ref；
// - 重进组件时读取同一 ref，Vue 响应式自动恢复实时状态；
// - localStorage 仍用于「应用整体重启」后的恢复（chatStore 只存内存态）。
import { ref } from 'vue'

// 聊天列表（元素为 home.vue 的 Chat 结构，这里用 any 避免跨层强依赖）
export const chatsRef = ref<any[]>([])

// 当前聊天索引：卸载模块后保留现场，重进回到同一聊天栏（另持久化到 localStorage 供重启恢复）
export const currentChatIndexRef = ref(0)

export interface GlobalExecutionStateShape {
  isExecuting: boolean
  executionType: 'workflow' | 'skill' | null
  chatId: string | null
  skillLoading: boolean
  currentStep: string
  stepIcon: string
  stepIndicatorClass: string
  // WorkflowRunner 实例（跨组件卸载存活，供后台工作流继续执行）
  workflowRunner: any
  abortController: AbortController | null
}

export const globalExecutionStateRef = ref<GlobalExecutionStateShape>({
  isExecuting: false,
  executionType: null,
  chatId: null,
  skillLoading: false,
  currentStep: '',
  stepIcon: '',
  stepIndicatorClass: '',
  workflowRunner: null,
  abortController: null,
})

// 工作流计时/错误标记（后台执行跨卸载存活）
export const workflowStartTimeRef = ref(0)
export const workflowErrorRef = ref(false)

let initialized = false

/**
 * 首次挂载时初始化一个空聊天。
 * 返回 true 表示本次会话首次初始化（需要从 localStorage 加载）；
 * 返回 false 表示切模块重进（chatsRef 已持有实时状态，不应重载覆盖）。
 */
export function ensureInitialChat(factory: () => any): boolean {
  if (initialized) return false
  initialized = true
  chatsRef.value = [factory()]
  return true
}
