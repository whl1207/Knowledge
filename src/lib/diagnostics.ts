/**
 * diagnostics.ts — 「复制诊断信息」：把排障需要的本机事实拼成一段可粘贴文本
 *
 * 只读：版本 / 平台 / 数据目录 / 已配置的模型来源 / 工作区与预设数量 / 引导进度 / 会话日志数量。
 * 不含任何密钥（只报「哪些来源已配置」，不读 api_key）。
 */
import { getPlatform } from '@/platform'
import { chatArchiveStat } from '@/lib/chatArchive'
import { currentAppVersion } from '@/lib/updateCheck'
import { readOnboarding } from '@/components/onboarding/onboardingState'

/** 把文本写入剪贴板（Electron / 浏览器都走同一个 API，失败时回退到临时 textarea） */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 权限被拒时走下面的回退 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** 汇总本机诊断信息（多行文本） */
export const collectDiagnostics = async (): Promise<string> => {
  const lines: string[] = []
  const add = (k: string, v: unknown) => lines.push(`${k}: ${v ?? ''}`)

  add('AI-KM', currentAppVersion())
  add('platform', getPlatform().kind)
  add('OS', typeof navigator !== 'undefined' ? navigator.userAgent : '')
  add('locale', typeof navigator !== 'undefined' ? navigator.language : '')

  let store: any = null
  try {
    const mod = await import('@/store')
    store = mod.usestore()
  } catch { /* store 未就绪时只报环境信息 */ }

  if (store) {
    add('appLocale', store.locales)
    add('theme', store?.UI?.theme)
    add('windowMode', store?.UI?.windowMode)
    add('navLayout', store?.UI?.navLayout)
    try {
      const res: any = await getPlatform().app.dataDirPath()
      if (res?.path) add('dataDir', res.path)
    } catch { /* 旧主进程没有该通道 */ }

    const llm = store?.AIconfig?.llm || {}
    const keys = ['ollama', 'lmstudio', 'openai', 'deepseek', 'glm', 'kimi', 'mimo', 'gpustack', 'anthropic', 'google', 'azure']
    const configured = keys.filter((k) => {
      const b = llm[k] || {}
      return !!(b.api_key || b.apiKeyRef || b.model)
    })
    add('llmType', llm.type || '')
    add('llmConfigured', configured.join(',') || '(none)')
    add('workspaces', Array.isArray(store?.roots) ? store.roots.length : 0)
    add('agentPresets', Array.isArray(store?.agentPresets) ? store.agentPresets.length : 0)
    add('mcpServers', Array.isArray(store?.mcpServers) ? store.mcpServers.length : 0)
  }

  try {
    const stat = await chatArchiveStat()
    add('chats', stat.chats)
    add('chatsStore', stat.store)
  } catch { add('chats', '?') }

  const onb = readOnboarding()
  add('onboarding', `v${onb.version} done=${onb.done}`)
  try {
    const list = await (window as any)?.aikmDsh?.sessionLog?.list?.()
    if (Array.isArray(list)) add('sessionLogs', list.length)
  } catch { /* 非桌面版没有会话日志 */ }

  return lines.join('\n')
}
