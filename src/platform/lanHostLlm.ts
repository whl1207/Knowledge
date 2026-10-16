/**
 * lanHostLlm.ts — 网页端（局域网访客，浏览器）对齐主机的模型来源
 *
 * 网页端既没有主进程、也没有主机那份配置，模型来源只能靠自己的 localStorage：
 *  - 地址是出厂默认值（Ollama `127.0.0.1:11434` / LM Studio `localhost:1234`），与主机实际用的地址无关；
 *  - 来源清单默认是**全部内置来源**，主机在「模型 → 来源」里关掉的来源照样列出来。
 * 于是出现「主机桌面端能刷出模型、网页端刷不出来」「关掉的来源还在」两种现象。
 *
 * 这里从主机拉一份来源快照（主机侧已剥离密钥）并**只覆盖地址 / 模型 / 模型列表**：
 *  - 来源开关：按主机的 `llmDisabledSources` 过滤，网页端的 `enabledLlmTypes` 自动跟着一致；
 *  - 地址与模型：用主机真正在用的地址与已探测模型，网页端经 `/__proxy` 就连到同一个服务。
 *
 * 只在浏览器环境生效（Electron 渲染进程走 IPC，不需要这套）。
 */

import { LAN_GUEST_TOKEN_HEADER, LAN_GUEST_TOKEN_KEY, LAN_LLM_SOURCES_API } from '@/shared/lanGuest'
import { aikmIpcAvailable } from '@/lib/aikmIpc'

export interface LanHostLlmSources {
  llm: any
  disabled: string[]
}

/** 从 ?token= 落盘的访客令牌（与 lanAgentClient 同一份） */
function readToken(): string {
  try {
    return localStorage.getItem(LAN_GUEST_TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * 拉取主机的模型来源快照。
 * @param probe true = 请主机现场探测各来源的模型列表（网页端点「刷新」/ 首次加载用），
 *              false = 只取主机最近一次下发的缓存。
 * 返回 null = 非网页端 / 主机未下发 / 请求失败（调用方保持现状，不报错）。
 */
export async function fetchHostLlmSources(probe = true): Promise<LanHostLlmSources | null> {
  if (typeof window === 'undefined' || aikmIpcAvailable()) return null
  const headers: Record<string, string> = {}
  const token = readToken()
  if (token) headers[LAN_GUEST_TOKEN_HEADER] = token
  try {
    const query = `${probe ? '' : 'cached=1&'}_t=${Date.now()}`
    const resp = await fetch(`${LAN_LLM_SOURCES_API}?${query}`, { headers })
    if (!resp.ok) return null
    const data: any = await resp.json()
    if (!data?.ok || !data.llm || typeof data.llm !== 'object') return null
    return { llm: data.llm, disabled: Array.isArray(data.disabled) ? data.disabled : [] }
  } catch {
    return null
  }
}

/** 内置来源里需要从主机覆盖的字段（刻意不含 api_key / apiKeyRef：网页端的凭据不被覆盖） */
const OVERRIDE_FIELDS = ['model_url', 'base_url', 'api_version', 'model', 'embed_model', 'available_models', 'deployment', 'api_style']
const BUILTIN_KEYS = ['ollama', 'lmstudio', 'openai', 'deepseek', 'gpustack', 'anthropic', 'google', 'azure']

/** 把主机快照合并进网页端本地 AI 配置（地址 / 模型 / 模型列表 + 来源开关） */
export function applyHostLlmSources(store: any, data: LanHostLlmSources | null): boolean {
  const llm = data?.llm
  const target = store?.AIconfig?.llm
  if (!llm || typeof llm !== 'object' || !target) return false
  if (Array.isArray(llm.types) && llm.types.length) target.types = [...llm.types]
  if (typeof llm.type === 'string' && llm.type) target.type = llm.type
  for (const key of BUILTIN_KEYS) {
    const src = llm[key]
    if (!src || typeof src !== 'object') continue
    if (!target[key]) target[key] = {}
    for (const field of OVERRIDE_FIELDS) {
      if (src[field] === undefined) continue
      target[key][field] = Array.isArray(src[field]) ? [...src[field]] : src[field]
    }
  }
  if (llm.custom && Array.isArray(llm.custom.sources) && target.custom) {
    // 按 id 保留网页端自己填过的密钥（主机下发的是空串，不能反过来把本地凭据清掉）
    const prev = new Map<string, any>(
      (Array.isArray(target.custom.sources) ? target.custom.sources : []).map((s: any) => [String(s?.id ?? ''), s]),
    )
    const hostActiveId = llm.custom.sources[Number(llm.custom.activeIndex) || 0]?.id
    // 空地址的来源在主机也没法用（多为「+ 添加」后未填写的占位项），不下发 / 不显示
    const list = llm.custom.sources
      .filter((s: any) => String(s?.api_url || '').trim())
      .map((s: any) => {
        const own = prev.get(String(s?.id ?? ''))
        return { ...s, api_key: own?.api_key || '', apiKeyRef: own?.apiKeyRef || '' }
      })
    target.custom.sources = list
    const activeIndex = list.findIndex((s: any) => s?.id === hostActiveId)
    target.custom.activeIndex = activeIndex >= 0 ? activeIndex : 0
  }
  if (Array.isArray(data?.disabled)) store.llmDisabledSources = [...data.disabled]
  return true
}

/** 网页端启动 / 刷新时调用：拉主机快照并落到本地配置；返回是否成功对齐 */
export async function syncHostLlmSources(store: any, probe = true): Promise<boolean> {
  const data = await fetchHostLlmSources(probe)
  if (!data) return false
  return applyHostLlmSources(store, data)
}
