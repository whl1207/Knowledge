// src/services/ai-utils.ts
// AI IPC 桥（Electron 主进程执行）+ 浏览器/LAN 模式直连兜底
//
// 架构：
// - Electron 环境（有 window.ipcRenderer）：所有 AI 网络请求通过 ai:start 委托给
//   主进程 electron/main/ai-service.ts 执行并解析；主进程按 requestId 缓冲完整回答
//   并落盘。渲染进程只负责把事件映射回 onStream/onComplete/onError 等回调。
// - 前端切模块（home.vue 卸载）时主进程会话继续运行；重新进入后用同一个 requestId
//   调用 resumeSession() 即可取回完整/部分回答并继续实时接收。
// - 浏览器 / LAN 共享模式（无 ipcRenderer）：回退到 electron/ai-core.ts 直连
//   （保持原有 /__proxy 代理行为），功能不变。
//
// 对外 API 与旧版 ai-utils.ts 保持一致，store/index.ts 与 EntryView.vue 无需改动。

import { AIUtils as AICore, normalizeReasoning, type ContextWindowProbe, type LmStudioModelInfo, type OllamaModelInfo, type OllamaLoadedModel } from '@/shared/ai-core'
import { deepSeekStyleOf, normalizeLlmType } from '@/shared/llmSources'

// ==================== IPC 工具 ====================

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.ipcRenderer
}

/** 深拷贝为纯 JSON / 保留 typed array：剥离 Vue 响应式 Proxy，保留 Uint8Array/ArrayBuffer/Blob */
function toPlain(value: any, seen = new WeakMap<any, any>()): any {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t !== 'object') return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Blob) return value
  if (seen.has(value)) return seen.get(value)
  if (value instanceof Date) return value
  if (Array.isArray(value)) {
    const out: any[] = []
    seen.set(value, out)
    for (const v of value) out.push(toPlain(v, seen))
    return out
  }
  const out: any = {}
  seen.set(value, out)
  for (const k of Object.keys(value)) {
    try { out[k] = toPlain((value as any)[k], seen) } catch { out[k] = (value as any)[k] }
  }
  return out
}

function invoke(channel: string, payload: any): Promise<any> {
  if (isElectron()) {
    return window.ipcRenderer.invoke(channel, toPlain(payload))
  }
  return Promise.reject(new Error('IPC 不可用（请在 Electron 中运行）'))
}

function genRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

// ==================== 会话注册表（事件分发） ====================

interface SessionHandler {
  requestId: string
  onStream?: (chunk: string) => void
  onComplete?: (content: string, metadata?: any) => void
  onError?: (error: Error) => void
  onSearchStatus?: (info: any) => void
  onReasoning?: (text: string) => void
  onToolCalls?: (calls: any[]) => void
  onToolCallArgs?: (callId: string, name: string, argsFragment: string) => void
  resolve?: (content: string) => void
  reject?: (error: Error) => void
  signal?: AbortSignal
  _onAbort?: () => void
  done?: boolean
}

const sessions = new Map<string, SessionHandler>()
let listenerAttached = false

function ensureListener(): void {
  if (listenerAttached) return
  listenerAttached = true
  window.ipcRenderer.on('ai:event', (_e: any, payload: any) => {
    const { requestId, type } = payload || {}
    if (!requestId) return
    const h = sessions.get(requestId)
    if (!h || h.done) return
    switch (type) {
      case 'stream':
        h.onStream?.(payload.chunk)
        break
      case 'search':
        h.onSearchStatus?.(payload.info)
        break
      case 'reasoning':
        h.onReasoning?.(payload.text)
        break
      case 'toolcalls':
        h.onToolCalls?.(payload.calls)
        break
      case 'toolargs':
        h.onToolCallArgs?.(payload.callId, payload.name, payload.argsFragment)
        break
      case 'done':
        finishSession(requestId, payload.content, payload.metadata)
        break
      case 'error':
        failSession(requestId, payload.message)
        break
    }
  })
}

function finishSession(requestId: string, content: string, metadata?: any): void {
  const h = sessions.get(requestId)
  if (!h || h.done) return
  h.done = true
  h.onComplete?.(content, metadata)
  if (h.resolve) h.resolve(content)
  cleanupSession(requestId)
}

function failSession(requestId: string, message: string): void {
  const h = sessions.get(requestId)
  if (!h || h.done) return
  h.done = true
  const err = new Error(message || 'AI 请求失败')
  h.onError?.(err)
  if (h.reject) h.reject(err)
  cleanupSession(requestId)
}

function cleanupSession(requestId: string): void {
  const h = sessions.get(requestId)
  if (h) {
    h.signal?.removeEventListener?.('abort', h._onAbort as any)
    sessions.delete(requestId)
  }
}

/** 启动会话：注册本地回调 → 通知主进程执行 → 返回 Promise（done/error 时 settle） */
function startSession(requestId: string, spec: any, options?: any): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      const err = new Error('请求已中止')
      options?.onError?.(err)
      reject(err)
      return
    }
    const h: SessionHandler = {
      requestId,
      onStream: options?.onStream,
      onComplete: options?.onComplete,
      onError: options?.onError,
      onSearchStatus: options?.onSearchStatus,
      onReasoning: options?.onReasoning,
      onToolCalls: options?.onToolCalls,
      onToolCallArgs: options?.onToolCallArgs,
      resolve,
      reject,
      signal: options?.signal,
    }
    if (options?.signal) {
      h._onAbort = () => {
        invoke('ai:abort', { requestId }).catch(() => {})
      }
      options.signal.addEventListener('abort', h._onAbort, { once: true })
    }
    sessions.set(requestId, h)
    ensureListener()
    invoke('ai:start', { requestId, spec })
      .then((res: any) => {
        if (!res?.success) throw new Error(res?.error || 'AI 会话启动失败')
      })
      .catch((err: any) => {
        cleanupSession(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

// ==================== AIUtils（IPC 桥 + 浏览器兜底） ====================

/** 解析 API Key：优先 apiKeyRef（凭据引用，经 window.dsh 解析），回退内联 api_key */
async function resolveApiKey(config: any): Promise<string> {
  if (!config) return ''
  const ref = config?.apiKeyRef
  if (typeof ref === 'string' && ref.trim()) {
    try {
      if ((window as any).dsh?.credentials?.resolve) {
        const res = await (window as any).dsh.credentials.resolve(ref.trim())
        if (res?.value) return res.value
      }
    } catch (e) {
      console.warn('[ai] 凭据解析失败:', e)
    }
  }
  return config?.api_key || ''
}

export class AIUtils {
  // ---------- 纯工具函数（委托共享核心，渲染/浏览器通用） ----------

  static imageToBase64(imageFile: File): Promise<string> {
    return AICore.imageToBase64(imageFile)
  }

  static imageUrlToBase64(imageUrl: string): Promise<string> {
    return AICore.imageUrlToBase64(imageUrl)
  }

  static createImageMessage(role: string, content: string, images: Array<string | Uint8Array> = []) {
    return AICore.createImageMessage(role, content, images)
  }

  static buildOpenAIRequest(openaiConfig: any, llmConfig: any, messages: any[]) {
    return AICore.buildOpenAIRequest(openaiConfig, llmConfig, messages)
  }

  static buildDeepSeekResponsesRequest(responsesConfig: any, llmConfig: any, messages: any[], options?: any) {
    return AICore.buildDeepSeekResponsesRequest(responsesConfig, llmConfig, messages, options)
  }

  /** 归一化自定义 api_url 为聊天请求端点（基址自动补 /chat/completions） */
  static buildCustomChatEndpoint(apiUrl: string): string {
    return AICore.buildCustomChatEndpoint(apiUrl)
  }

  static translateOpenAIToolsToAnthropic(tools: any[]): any[] {
    return AICore.translateOpenAIToolsToAnthropic(tools)
  }

  /** 获取模型真实上下文窗口（tokens）：Ollama / LM Studio / Google 可读，其余来源返回 null（按来源默认表兜底） */
  static fetchModelContextWindow(provider: string, config: any, model: string): Promise<number | null> {
    if (!isElectron()) return AICore.fetchModelContextWindow(provider, config, model)
    // Electron：委托主进程 fetch，避免渲染进程 CORS/CSP 拦截本地 Ollama /api/ps、/api/show
    return invoke('ai:contextWindow', { provider, config, model }).catch(() => null)
  }

  /** 同上，但带来源可信度（loaded / model-file / model-max）：上层据此区分「真正生效值」与「模型上限」 */
  static fetchModelContextWindowDetail(provider: string, config: any, model: string): Promise<ContextWindowProbe | null> {
    if (!isElectron()) return AICore.fetchModelContextWindowDetail(provider, config, model)
    return invoke('ai:contextWindowDetail', { provider, config, model }).catch(() => null)
  }

  /**
   * LM Studio 模型清单（含 type：llm / vlm / embeddings 与 state：loaded / not-loaded）：
   * 设置页用它显示「哪些模型已加载」，以及当前嵌入模型是否已就绪。
   * 其余来源无此能力，不做调用。
   */
  static listLmStudioModels(config: any): Promise<{ online: boolean; models: LmStudioModelInfo[]; native: boolean; error?: string }> {
    if (!isElectron()) return AICore.listLmStudioModels(config || {})
    return invoke('ai:lmstudioModels', { config: config || {} })
      .then((res: any) => res || { online: false, models: [], native: false })
      .catch(() => ({ online: false, models: [], native: false }))
  }

  /**
   * LM Studio 命令行（lms）：已加载实例清单 / 加载模型 / 卸载模型。
   * REST API 不提供加载卸载（POST /api/v0/models/load 报 Unexpected endpoint），故走官方 CLI。
   */
  static lmStudioCli(payload: { action: 'ps' | 'load' | 'unload'; model?: string; contextLength?: number; all?: boolean }): Promise<any> {
    if (!isElectron()) return Promise.resolve({ ok: false, available: false, models: [], error: 'LM Studio 命令行仅桌面版可用' })
    return invoke('ai:lmstudioCli', payload).catch((e: any) => ({ ok: false, available: false, models: [], error: e?.message || String(e) }))
  }


  /**
   * Ollama 模型清单（已安装 /api/tags + 已加载 /api/ps + 逐模型明细 /api/show）：
   * 设置页用它显示模型类型（对话 / 视觉 / 嵌入）、参数、上下文与加载状态。
   */
  static listOllamaModels(config: any): Promise<{ online: boolean; models: OllamaModelInfo[]; loaded: OllamaLoadedModel[]; error?: string }> {
    if (!isElectron()) return AICore.listOllamaModels(config || {})
    return invoke('ai:ollamaModels', { config: config || {} })
      .then((res: any) => res || { online: false, models: [], loaded: [] })
      .catch(() => ({ online: false, models: [], loaded: [] }))
  }

  /** Ollama 加载 / 卸载模型（加载 = 预热并驻留 keepAlive；卸载 = keep_alive 0） */
  static ollamaModelAction(config: any, action: 'load' | 'unload', model: string, keepAlive?: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    if (!isElectron()) return AICore.ollamaModelAction(config || {}, action, model, keepAlive)
    return invoke('ai:ollamaModelAction', { config: config || {}, action, model, keepAlive })
      .then((res: any) => res || { ok: false, error: '空响应' })
      .catch((e: any) => ({ ok: false, error: e?.message || String(e) }))
  }


  static translateOpenAIMessagesToAnthropic(messages: any[]): { system: string; messages: any[] } {
    return AICore.translateOpenAIMessagesToAnthropic(messages)
  }

  static translateOpenAIToolsToGoogle(tools: any[]): any[] {
    return AICore.translateOpenAIToolsToGoogle(tools)
  }

  static translateOpenAIMessagesToGoogle(messages: any[]): any[] {
    return AICore.translateOpenAIMessagesToGoogle(messages)
  }

  // ---------- 连接探测（Electron 走主进程，浏览器直连） ----------

  static checkOllamaConnection(ollamaConfig: any) {
    if (!isElectron()) return AICore.checkOllamaConnection(ollamaConfig)
    return invoke('ai:check', { provider: 'ollama', config: ollamaConfig })
  }

  static checkLMStudioConnection(lmstudioConfig: any) {
    if (!isElectron()) return AICore.checkLMStudioConnection(lmstudioConfig)
    return invoke('ai:check', { provider: 'lmstudio', config: lmstudioConfig })
  }

  static checkOpenAIConnection(openaiConfig: any) {
    if (!isElectron()) return AICore.checkOpenAIConnection(openaiConfig)
    return invoke('ai:check', { provider: 'openai', config: openaiConfig })
  }

  static checkCustomConnection(customConfig: any) {
    if (!isElectron()) return AICore.checkCustomConnection(customConfig)
    return invoke('ai:check', { provider: 'custom', config: customConfig })
  }

  static checkDeepSeekResponsesConnection(responsesConfig: any) {
    if (!isElectron()) return AICore.checkDeepSeekResponsesConnection(responsesConfig)
    // DeepSeek 单来源：provider 统一为 'deepseek'，由 apiStyle 指明走 Responses 接口
    return invoke('ai:check', { provider: 'deepseek', apiStyle: 'responses', config: responsesConfig })
  }

  /** 查询 DeepSeek 账户余额（Electron 走主进程，避开渲染进程 CORS/CSP；浏览器直连） */
  static fetchDeepSeekBalance(deepseekConfig: any) {
    if (!isElectron()) return AICore.fetchDeepSeekBalance(deepseekConfig)
    return invoke('ai:check', { provider: 'deepseek-balance', config: deepseekConfig })
  }

  static checkAnthropicConnection(anthropicConfig: any) {
    if (!isElectron()) return AICore.checkAnthropicConnection(anthropicConfig)
    return invoke('ai:check', { provider: 'anthropic', config: anthropicConfig })
  }

  static checkGoogleConnection(googleConfig: any) {
    if (!isElectron()) return AICore.checkGoogleConnection(googleConfig)
    return invoke('ai:check', { provider: 'google', config: googleConfig })
  }

  static checkAzureConnection(azureConfig: any) {
    if (!isElectron()) return AICore.checkAzureConnection(azureConfig)
    return invoke('ai:check', { provider: 'azure', config: azureConfig })
  }

  // ---------- 发送请求（Electron 走主进程会话，浏览器直连） ----------

  static sendToOllama(ollamaConfig: any, llmConfig: any, messages: any[], options?: any): Promise<string> {
    if (!isElectron()) return AICore.sendToOllama(ollamaConfig, llmConfig, messages, options)
    if (!ollamaConfig?.model) {
      const error = new Error('请先在AI配置中选择一个Ollama模型')
      options?.onError?.(error)
      return Promise.reject(error)
    }
    const requestId = options?.requestId || genRequestId()
    return startSession(requestId, {
      provider: 'ollama',
      config: ollamaConfig,
      llmConfig,
      messages,
      tools: options?.tools,
      toolChoice: options?.toolChoice,
    }, options)
  }

  static sendToLMStudio(lmstudioConfig: any, llmConfig: any, messages: any[], options?: any): Promise<string> {
    if (!isElectron()) return AICore.sendToLMStudio(lmstudioConfig, llmConfig, messages, options)
    if (!lmstudioConfig?.model) {
      const error = new Error('请先在AI配置中选择一个LM Studio模型')
      options?.onError?.(error)
      return Promise.reject(error)
    }
    const requestId = options?.requestId || genRequestId()
    return startSession(requestId, {
      provider: 'lmstudio',
      config: lmstudioConfig,
      llmConfig,
      messages,
      tools: options?.tools,
      toolChoice: options?.toolChoice,
    }, options)
  }

  static makeAPIRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any): Promise<string> {
    if (!isElectron()) return AICore.makeAPIRequest(endpoint, body, headers, options)
    const requestId = options?.requestId || genRequestId()
    return startSession(requestId, {
      provider: 'custom',
      endpoint,
      body,
      headers,
      tools: options?.tools,
      toolChoice: options?.toolChoice,
    }, options)
  }

  static makeDeepSeekResponsesRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any): Promise<string> {
    if (!isElectron()) return AICore.makeDeepSeekResponsesRequest(endpoint, body, headers, options) as unknown as Promise<string>
    const requestId = options?.requestId || genRequestId()
    return startSession(requestId, {
      provider: 'deepseek',
      apiStyle: 'responses',
      endpoint,
      body,
      headers,
    }, options)
  }

  static makeAnthropicRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any): Promise<string> {
    if (!isElectron()) return AICore.makeAnthropicRequest(endpoint, body, headers, options)
    const requestId = options?.requestId || genRequestId()
    return startSession(requestId, {
      provider: 'anthropic',
      endpoint,
      body,
      headers,
    }, options)
  }

  static makeGoogleRequest(endpoint: string, body: any, headers: Record<string, string>, options?: any): Promise<string> {
    if (!isElectron()) return AICore.makeGoogleRequest(endpoint, body, headers, options)
    const requestId = options?.requestId || genRequestId()
    return startSession(requestId, {
      provider: 'google',
      endpoint,
      body,
      headers,
    }, options)
  }

  // ---------- 统一聊天分派（store.sendToAI 与 kbAiClient 共用，单一实现） ----------

  /**
   * 统一 AI 聊天调用：按 provider 分派到对应执行器（Electron 走主进程，浏览器直连/代理）。
   * 与 store.sendToAI / kbAiClient.chat 共用，避免各模块重复维护 provider 分发。
   * @param provider 模型来源：ollama / lmstudio / openai / deepseek / gpustack / anthropic / google / azure / custom
   *                 （DeepSeek 是单来源：接口样式由 config.api_style 或历史别名 'deepseek-responses' 决定）
   * @param config   该来源连接配置（含 model / api_key / apiKeyRef / base_url / api_style 等）
   * @param llmConfig 通用 LLM 参数（stream / temperature / max_tokens / think / format 等）
   * @param messages OpenAI 风格消息数组
   * @param options  回调与工具（onStream/onComplete/onError/signal/tools/toolChoice/webSearch 等）
   */
  static async sendChat(provider: string, config: any, llmConfig: any, messages: any[], options?: any): Promise<string> {
    const cfg = config || {}
    const apiKey = await resolveApiKey(cfg)
    // DeepSeek 单来源：'deepseek-responses' 仅作历史别名；接口样式由 api_style 决定
    const type = normalizeLlmType(provider)
    const dsStyle = deepSeekStyleOf(provider, cfg)
    switch (type) {
      case 'ollama': {
        const c = { ...cfg, model: cfg.model || '', model_url: cfg.model_url || 'http://127.0.0.1:11434' }
        return AIUtils.sendToOllama(c, llmConfig, messages, options)
      }
      case 'lmstudio': {
        return AIUtils.sendToLMStudio({ ...cfg }, llmConfig, messages, options)
      }
      case 'deepseek': {
        if (dsStyle === 'responses') {
          // 注意：服务端联网搜索已被 DeepSeek 移除（内置 web_search 会被 API 忽略），
          // 联网搜索统一交给本地 web_search 工具（agent 模式）；官方端点为 /responses
          const body = AIUtils.buildDeepSeekResponsesRequest(cfg, llmConfig, messages, options)
          const endpoint = `${String(cfg.base_url || '').replace(/\/+$/, '')}/responses`
          const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiKey || cfg.api_key}`,
          }
          return AIUtils.makeDeepSeekResponsesRequest(endpoint, body, headers, options)
        }
        const c = { ...cfg, api_key: apiKey || cfg.api_key }
        const body = AIUtils.buildOpenAIRequest(c, llmConfig, messages)
        const endpoint = `${String(cfg.base_url || '').replace(/\/+$/, '')}/v1/chat/completions`
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey || cfg.api_key}`,
        }
        return AIUtils.makeAPIRequest(endpoint, body, headers, options)
      }
      case 'openai': {
        const c = { ...cfg, api_key: apiKey || cfg.api_key }
        const body = AIUtils.buildOpenAIRequest(c, llmConfig, messages)
        const endpoint = `${String(cfg.base_url || '').replace(/\/+$/, '')}/v1/chat/completions`
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey || cfg.api_key}`,
        }
        return AIUtils.makeAPIRequest(endpoint, body, headers, options)
      }
      // 历史别名（旧存档/旧调用）：等价于 deepseek + api_style='responses'
      case 'deepseek-responses': {
        return AIUtils.sendChat('deepseek', { ...cfg, api_style: 'responses' }, llmConfig, messages, options)
      }
      case 'gpustack': {
        // GPUStack：内置自托管来源，OpenAI 兼容端点（裸地址自动补 /v1-openai/chat/completions）
        const c = { ...cfg, api_key: apiKey || cfg.api_key }
        const body = AIUtils.buildOpenAIRequest(c, llmConfig, messages)
        const endpoint = AIUtils.buildCustomChatEndpoint(cfg.base_url)
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(apiKey || cfg.api_key ? { 'Authorization': `Bearer ${apiKey || cfg.api_key}` } : {}),
        }
        return AIUtils.makeAPIRequest(endpoint, body, headers, options)
      }
      case 'anthropic': {
        const headers = {
          'x-api-key': apiKey || cfg.api_key,
          'anthropic-version': cfg.api_version || '2023-06-01',
          'Content-Type': 'application/json',
        }
        const hasTools = !!options?.tools && Array.isArray(options.tools) && options.tools.length > 0
        if (hasTools) {
          const { system, messages: anthropicMessages } = AIUtils.translateOpenAIMessagesToAnthropic(messages)
          const body: any = {
            model: cfg.model,
            messages: anthropicMessages,
            max_tokens: llmConfig.max_tokens,
            temperature: llmConfig.temperature,
            top_p: llmConfig.top_p,
            stream: llmConfig.stream,
            tools: AIUtils.translateOpenAIToolsToAnthropic(options.tools),
            tool_choice: options?.toolChoice === 'none' ? { type: 'none' } : { type: 'auto' },
          }
          if (system) body.system = system
          return AIUtils.makeAnthropicRequest('https://api.anthropic.com/v1/messages', body, headers, options)
        }
        // 无工具：转换消息格式（支持多模态）
        const anthropicMessages = messages.map((msg: any) => {
          const formattedMsg: any = { role: msg.role === 'assistant' ? 'assistant' : 'user', content: [] }
          if (msg.content) formattedMsg.content.push({ type: 'text', text: msg.content })
          if (msg.images && msg.images.length > 0) {
            for (const image of msg.images) {
              const { mime, base64 } = AICore.normalizeImage(image)
              if (!base64) continue
              formattedMsg.content.push({ type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: base64 } })
            }
          }
          return formattedMsg
        })
        const body = {
          model: cfg.model,
          messages: anthropicMessages,
          max_tokens: llmConfig.max_tokens,
          temperature: llmConfig.temperature,
          top_p: llmConfig.top_p,
          stream: llmConfig.stream,
        }
        return AIUtils.makeAPIRequest('https://api.anthropic.com/v1/messages', body, headers, options)
      }
      case 'google': {
        const hasTools = !!options?.tools && Array.isArray(options.tools) && options.tools.length > 0
        const contents = hasTools
          ? AIUtils.translateOpenAIMessagesToGoogle(messages)
          : messages.map((msg: any) => {
              const parts: any[] = []
              if (msg.content) parts.push({ text: msg.content })
              if (msg.images && msg.images.length > 0) {
                for (const image of msg.images) {
                  const { mime, base64 } = AICore.normalizeImage(image)
                  if (!base64) continue
                  parts.push({ inline_data: { mime_type: mime || 'image/jpeg', data: base64 } })
                }
              }
              return { role: msg.role === 'assistant' ? 'model' : 'user', parts }
            })
        const body: any = {
          contents,
          generationConfig: { temperature: llmConfig.temperature, topP: llmConfig.top_p, maxOutputTokens: llmConfig.max_tokens },
        }
        if (hasTools) {
          body.tools = AIUtils.translateOpenAIToolsToGoogle(options.tools)
          body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
        }
        const baseEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${apiKey || cfg.api_key}`
        const headers = { 'Content-Type': 'application/json' }
        if (hasTools) {
          const stream = llmConfig.stream && !!options?.onStream
          body.stream = stream
          return AIUtils.makeGoogleRequest(stream ? `${baseEndpoint}&alt=sse` : baseEndpoint, body, headers, options)
        }
        return AIUtils.makeAPIRequest(baseEndpoint, body, headers, options)
      }
      case 'azure': {
        // 有图片时才转成 OpenAI content 块（原文把 messages 原样发出，images 字段会被服务端忽略）；
        // 纯文本保持原样，避免老部署/老模型对 content 数组形态的兼容问题
        const azureHasImages = messages.some((m: any) => m.images && m.images.length > 0)
        const body = {
          messages: azureHasImages ? AICore.toOpenAIMessages(messages) : messages,
          stream: llmConfig.stream,
          temperature: llmConfig.temperature,
          max_tokens: llmConfig.max_tokens,
          top_p: llmConfig.top_p,
          frequency_penalty: llmConfig.frequency_penalty,
          presence_penalty: llmConfig.presence_penalty,
        }
        const endpoint = `${String(cfg.endpoint || '').replace(/\/+$/, '')}/openai/deployments/${cfg.deployment}/chat/completions?api-version=${cfg.api_version}`
        const headers = { 'api-key': apiKey || cfg.api_key, 'Content-Type': 'application/json' }
        return AIUtils.makeAPIRequest(endpoint, body, headers, options)
      }
      case 'custom': {
        const endpoint = AIUtils.buildCustomChatEndpoint(cfg.api_url)
        const isGLM = endpoint.includes('bigmodel.cn') || endpoint.includes('open.bigmodel.cn')
        let body: any
        let headers: Record<string, string>
        if (isGLM) {
          body = {
            model: cfg.model || 'glm-4',
            messages,
            stream: llmConfig.stream,
            temperature: llmConfig.temperature,
            max_tokens: llmConfig.max_tokens,
            ...(cfg.request_body || {}),
          }
          headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || cfg.api_key}`, ...(cfg.headers || {}) }
        } else {
          // 通用格式：基于 request_body（深拷贝），缺失时注入 model/messages/stream
          body = cfg.request_body ? JSON.parse(JSON.stringify(cfg.request_body)) : {}
          if (!body.model) body.model = cfg.model
          if (!body.messages) body.messages = messages
          if (body.stream === undefined) body.stream = llmConfig.stream
          // 推理强度接线：Qwen3/vLLM 等 OpenAI 兼容后端（GPUStack、本地 vLLM）默认会输出
          // <think>，按 llmConfig.think 下发 chat_template_kwargs.enable_thinking 控制；
          // 若 request_body 已显式声明 chat_template_kwargs 则尊重用户配置、不覆盖。
          if (body.chat_template_kwargs === undefined) {
            body.chat_template_kwargs = { enable_thinking: normalizeReasoning(llmConfig?.think).enabled }
          }
          headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || cfg.api_key}`, ...(cfg.headers || {}) }
        }
        return AIUtils.makeAPIRequest(endpoint, body, headers, options)
      }
      default:
        throw new Error(`不支持的模型来源: ${provider}`)
    }
  }

  // ---------- 会话管理（断线续传 / 中止 / 释放） ----------

  /** 获取会话快照（内存/磁盘，主进程维护） */
  static async getSession(requestId: string) {
    if (!isElectron()) return null
    return invoke('ai:get', { requestId })
  }

  /**
   * 挂接实时监听（续接运行中的会话）：注册后到达的 stream/search/reasoning/tool*
   * 事件都会回调，done/error 时结束。不会回放已缓冲内容——调用方应先用
   * getSession(requestId) 取回主进程缓冲的部分内容并写入消息，再 attach 继续实时接收。
   */
  static attachLiveSession(requestId: string, options?: any): { attached: boolean } {
    if (!isElectron()) return { attached: false }
    const h: SessionHandler = {
      requestId,
      onStream: options?.onStream,
      onComplete: options?.onComplete,
      onError: options?.onError,
      onSearchStatus: options?.onSearchStatus,
      onReasoning: options?.onReasoning,
      onToolCalls: options?.onToolCalls,
      onToolCallArgs: options?.onToolCallArgs,
      signal: options?.signal,
    }
    if (options?.signal) {
      h._onAbort = () => {
        invoke('ai:abort', { requestId }).catch(() => {})
      }
      if (options.signal.aborted) {
        invoke('ai:abort', { requestId }).catch(() => {})
      } else {
        options.signal.addEventListener('abort', h._onAbort, { once: true })
      }
    }
    sessions.set(requestId, h)
    ensureListener()
    return { attached: true }
  }

  /** 中止会话（主进程保留已生成内容并停止） */
  static async abortSession(requestId: string) {
    if (!isElectron()) return { success: false }
    return invoke('ai:abort', { requestId })
  }

  /** 释放会话（主进程删除内存 + 磁盘文件） */
  static async releaseSession(requestId: string) {
    if (!isElectron()) return { success: true }
    return invoke('ai:release', { requestId })
  }

  /**
   * 解除本地监听（切模块/组件卸载时调用）：停止把流式事件写入已卸载组件状态，
   * 但主进程会话继续运行并缓冲完整回答，重进后用 resumeSession(requestId) 恢复。
   */
  static detachAllSessions(): void {
    for (const h of sessions.values()) {
      h.signal?.removeEventListener?.('abort', h._onAbort as any)
    }
    sessions.clear()
  }
}
