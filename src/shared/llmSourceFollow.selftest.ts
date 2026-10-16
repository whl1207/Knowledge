/**
 * llmSourceFollow.selftest.ts — 智能体预设「跟随默认」判定的纯逻辑自测
 *
 * 背景：预设的来源 / 模型原先必须写死，用户在「设置 → 模型」里换来源后还得逐个预设重配。
 * 现在预设可把来源设为「跟随默认」（llmType 为空 / 哨兵值），运行时读全局当前来源与模型。
 *
 * 这套判定被 UI（来源下拉档位）与所有执行入口（聊天 / 工作流 / 集群 / 批量 / 插件委派）共用，
 * 一旦判反就会出现「界面显示跟随、执行却钉死旧来源」这类只靠肉眼很难发现的问题，
 * 因此把边界（空串 / 哨兵 / 历史别名 / 未配置）固化在这里。
 *
 * 用法：`node scripts/run-selftests.mjs presetFollowLlm`
 */

import {
  FOLLOW_DEFAULT_LLM,
  normalizeLlmType,
  presetFollowsDefaultLlm,
  resolvePresetLlmType,
  resolvePresetModel,
} from './llmSources'

export interface LlmSourceFollowCase {
  name: string
  ok: boolean
  detail?: string
}

const storeOf = (type: string) => ({ AIconfig: { llm: { type } } })

export function runLlmSourceFollowSelfTest(): LlmSourceFollowCase[] {
  const cases: LlmSourceFollowCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 判定：哪些算「跟随默认」
  add('判定：llmType 为空串 = 跟随', presetFollowsDefaultLlm({ llmType: '', model: '' }) === true)
  add('判定：llmType 只有空白 = 跟随', presetFollowsDefaultLlm({ llmType: '   ' }) === true)
  add('判定：哨兵值（界面下拉用）= 跟随', presetFollowsDefaultLlm({ llmType: FOLLOW_DEFAULT_LLM }) === true)
  add('判定：字段缺失 / null 预设 = 跟随', presetFollowsDefaultLlm({}) && presetFollowsDefaultLlm(null))
  add('判定：写了具体来源 = 不跟随', presetFollowsDefaultLlm({ llmType: 'deepseek' }) === false)
  add('判定：只剩 model 但没来源 = 跟随（来源才是绑定开关）',
    presetFollowsDefaultLlm({ llmType: '', model: 'gpt-4o' }) === true)

  // 2. 解析来源：跟随 → 全局；绑定 → 预设自己那份
  add('来源：跟随 → 取全局当前来源',
    resolvePresetLlmType({ llmType: '' }, storeOf('deepseek')) === 'deepseek')
  add('来源：绑定 → 用预设自己的来源（不被全局覆盖）',
    resolvePresetLlmType({ llmType: 'ollama' }, storeOf('deepseek')) === 'ollama')
  add('来源：跟随 + 全局是历史别名 → 归一为 deepseek',
    resolvePresetLlmType({ llmType: '' }, storeOf('deepseek-responses')) === 'deepseek')
  add('来源：绑定 + 历史别名 → 归一为 deepseek',
    resolvePresetLlmType({ llmType: 'deepseek-responses' }, storeOf('ollama')) === 'deepseek')
  add('来源：跟随但全局没配置 → 空串（由下游按各自默认兜底）',
    resolvePresetLlmType({ llmType: '' }, {}) === '')
  add('来源：哨兵值 = 跟随（不把哨兵当来源键传下去）',
    resolvePresetLlmType({ llmType: FOLLOW_DEFAULT_LLM }, storeOf('openai')) === 'openai')

  // 3. 解析模型：跟随 → 留空（由来源配置里的模型兜底）；绑定 → 预设自己的模型
  add('模型：跟随 → 空串', resolvePresetModel({ llmType: '', model: 'gpt-4o' }) === '')
  add('模型：绑定 → 预设的模型', resolvePresetModel({ llmType: 'openai', model: 'gpt-4o' }) === 'gpt-4o')
  add('模型：绑定但没填模型 → 空串', resolvePresetModel({ llmType: 'openai' }) === '')
  add('模型：null 预设 → 空串', resolvePresetModel(null) === '')

  // 4. 哨兵值不得被当成来源键（曾担心它被写进预设再传给 resolveLlmSource）
  add('哨兵：normalizeLlmType 不认识它（故仅限界面使用）',
    normalizeLlmType(FOLLOW_DEFAULT_LLM) === FOLLOW_DEFAULT_LLM)

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logLlmSourceFollowSelfTest(): boolean {
  const cases = runLlmSourceFollowSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[presetFollowLlm] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
