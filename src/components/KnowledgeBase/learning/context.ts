import { inject, type InjectionKey } from 'vue'

/** 学习模块共享上下文：Provider 持有全部状态，五个页面只消费 */
export const LearningContextKey: InjectionKey<any> = Symbol('learning-context')

export function useLearningContext(): any {
  const ctx = inject(LearningContextKey)
  if (!ctx) throw new Error('LearningContext 未提供：请把学习页面放在 LearningProvider 内')
  return ctx
}
