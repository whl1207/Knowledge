/**
 * onboardingState.ts — 首次使用引导的进度与完成标记
 *
 * 做法参照 DSH 的 onboarding：
 * - 进度存本机（不随配置备份迁移），关掉软件再开能接着上次那一步；
 * - 记录「已确认的版本」：版本号提高后，老用户会再次看到新版须知，而不是永远不再出现；
 * - 「跳过」也算完成本次遍历，不反复打扰；要重看从 设置 → 通用 → 基础 → 常用操作 → 新手引导 打开。
 */

/** 引导版本：文案 / 步骤结构有实质变化时 +1（会让老用户再看一次） */
export const ONBOARDING_VERSION = 1

const STORAGE_KEY = 'kb-onboarding'

export interface OnboardingState {
  /** 用户确认过的引导版本（0 = 从未确认过） */
  version: number
  /** 上次停在第几步（0 起；恢复时用） */
  step: number
  /** 是否已完成 / 跳过本次遍历 */
  done: boolean
}

export const readOnboarding = (): OnboardingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: 0, step: 0, done: false }
    const v = JSON.parse(raw)
    return {
      version: Number(v?.version) || 0,
      step: Math.max(0, Math.floor(Number(v?.step) || 0)),
      done: v?.done === true,
    }
  } catch {
    return { version: 0, step: 0, done: false }
  }
}

export const writeOnboarding = (patch: Partial<OnboardingState>): OnboardingState => {
  const cur = readOnboarding()
  const next: OnboardingState = { ...cur, ...patch, version: ONBOARDING_VERSION }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* 隐私模式等写不进也不影响使用 */ }
  return next
}

/** 本次版本还需要展示吗（没做过，或只确认过更老的版本） */
export const needsOnboarding = (): boolean => {
  const s = readOnboarding()
  return !(s.done && s.version >= ONBOARDING_VERSION)
}

/** 完成 / 跳过：记住当前版本，之后不再自动出现 */
export const markOnboardingDone = (): OnboardingState => writeOnboarding({ done: true, step: 0 })

/** 显式重看：清掉完成标记，从头开始（设置里的入口用） */
export const resetOnboarding = (): OnboardingState => writeOnboarding({ done: false, step: 0 })

/**
 * 看起来像全新安装吗：没有任何使用痕迹（没配过模型、没设过工作区、没有聊天）。
 * 老用户升级后 `needsOnboarding()` 也是 true，但这里会拦住，不会突然被打断。
 */
export const looksLikeFreshInstall = (opts: {
  hasConfiguredModel: boolean
  hasWorkspace: boolean
  chatCount: number
}): boolean => !opts.hasConfiguredModel && !opts.hasWorkspace && opts.chatCount === 0

/**
 * 是否已经配过任何模型来源（云端来源看凭据、本地来源看模型名）。
 * 与 OnboardingWizard 里「当前来源是否已配置」同一口径，只是这里看全部来源——
 * 老用户只要有一个来源可用，就不该被当成新用户。
 */
export const anyModelConfigured = (llm: any): boolean => {
  const l = llm || {}
  const hasKey = (c: any) => !!(c?.api_key || c?.apiKeyRef)
  const hasModel = (c: any) => !!String(c?.model || '').trim()
  if (hasKey(l.deepseek) || hasKey(l.openai) || hasKey(l.anthropic) || hasKey(l.google) || hasKey(l.azure)) return true
  if (hasKey(l.glm) || hasKey(l.kimi) || hasKey(l.mimo)) return true
  const customSources = Array.isArray(l.custom?.sources) ? l.custom.sources : []
  // 自定义来源可能指向本地 / 内网服务（LM Studio、vLLM、Ollama 网关），**没有 api_key**。
  // 只要有模型名就算可用；否则「明明配了自定义模型却提示先配置一个」。
  if (customSources.some((c: any) => hasKey(c) || hasModel(c))) return true
  if (hasKey(l.custom) || hasModel(l.custom)) return true
  return hasModel(l.ollama) || hasModel(l.lmstudio) || hasModel(l.gpustack)
}
