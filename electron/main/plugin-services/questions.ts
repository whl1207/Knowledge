/**
 * questions.ts — `ctx.userQuestions` 的实现（P2）
 *
 * 与 `agent-loop.requestQuestions` 共用 `user-questions/request` 拦截链：
 * 插件可以在手机上回答桌面弹出的问题；无人认领时回落到渲染层的提问 UI。
 *
 * 注意 fallback 必须调 `requestQuestionsDirect`（跳过拦截链的版本）——
 * 调 `requestQuestions` 会再次进入链，形成 "next() → 再拦截" 的递归。
 */

import { requestQuestionsDirect } from '../agent-loop'
import { PluginServiceError } from '@/shared/pluginServices'
import type {
  PluginUserQuestionsService,
  QuestionAnswer,
  QuestionItem,
} from '@/shared/pluginServices'
import type { PluginSessionRegistry } from '@/shared/pluginSessionRegistry'
import { runPluginWaterfall } from '../plugin-waterfall'

export function createUserQuestionsService(registry: PluginSessionRegistry): PluginUserQuestionsService {
  return {
    async ask(
      questions: readonly QuestionItem[],
      options?: { sessionId?: string; signal?: AbortSignal },
    ): Promise<readonly QuestionAnswer[]> {
      if (options?.signal?.aborted) return []
      const rec = options?.sessionId ? registry.get(options.sessionId) : undefined
      const agentId = rec?.agentId
      return runPluginWaterfall<readonly QuestionAnswer[]>(
        'user-questions/request',
        { questions, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) },
        async () => {
          if (!agentId) {
            throw new PluginServiceError(
              'PLUGIN_UNSUPPORTED',
              '没有可提问的会话：请传 sessionId（或由插件认领 user-questions/request）',
              { service: 'userQuestions' },
            )
          }
          // QuestionItem 与 AskUserQuestion 结构一致（多一个可选 detail），直接透传
          return (await requestQuestionsDirect(agentId, questions as never)) as unknown as QuestionAnswer[]
        },
      )
    },
  }
}
