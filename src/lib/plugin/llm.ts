/**
 * llm.ts — 渲染层「插件大模型服务」（插件上下文里的 `ctx.llm`）
 *
 * 为什么由宿主提供：插件 bundle 是 Blob URL 加载的单文件 ESM，**不能 import 应用内部模块**，
 * 而「按来源/模型发起一次对话」必须复用宿主已有的来源配置（`store.llm`）与请求封装
 * （`AIUtils.sendChat`，覆盖 Ollama / LM Studio / OpenAI / DeepSeek / Anthropic / Google / Azure / 自定义）。
 * 由宿主注入既避免插件重造一套，也保证与软件其它功能走**完全相同的来源与密钥**。
 *
 * 权限：只有清单声明 `permissions: ['llm']` 的插件才会拿到可用实现——未声明时
 * `available === false`，任何调用直接抛错。这样「设置页展示的权限」与「真实能力」始终一致；
 * 大模型调用会消耗用户额度/算力，属于必须显式声明的能力。
 */

import { AIUtils } from '@/services/ai-utils'
import { LLM_SOURCE_KEYS, llmConfigByKey, llmSourceLabel, normalizeLlmType } from '@/shared/llmSources'
import {
  checkAgainstSchema,
  classifyLlmError,
  extractJson,
  schemaInstruction,
  toPlainMessages,
  toChatMessages,
  type ChatMessageInput,
  type LlmChunk,
  type LlmErrorCode,
  type LlmMessage,
  type LlmSchemaRequest,
} from '@/shared/llmContract'
import { usestore } from '@/store'

/** 带稳定 code 的错误（插件按 code 分支，不解析文案） */
function llmError(code: LlmErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code?: LlmErrorCode }
  err.code = code
  return err
}

/** 一个可用的模型来源（含该来源当前选中的模型） */
export interface PluginLlmSourceInfo {
  key: string
  label: string
  /** 该来源配置里已选的模型（可能为空：本地服务可以先拉清单再选） */
  model: string
  /** 是否已填写必要配置（地址 / 密钥 / 模型） */
  configured: boolean
}

export interface PluginLlmMessage {
  role: string
  content: string
}

export interface PluginLlmChatRequest {
  /** 来源键（ollama / lmstudio / openai / deepseek / gpustack / anthropic / google / azure / custom）；缺省跟随软件当前来源 */
  source?: string
  /** 模型名；缺省用该来源配置里的模型 */
  model?: string
  messages: PluginLlmMessage[]
  /** 便捷写法：会作为第一条 system 消息插到最前 */
  system?: string
  temperature?: number
  maxTokens?: number
  /**
   * 是否让模型「深度思考」（默认关闭：LM Studio 走 reasoning_effort='none'、Ollama/OpenAI 兼容走 think）。
   * 一次性任务通常不需要思维链，关掉可显著降低延迟与 token 消耗。
   */
  think?: boolean
  /** 超时（默认 90s）；超时会 abort 请求并抛错 */
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * 结构化输出：宿主负责"要求模型只输出 JSON + 解析 + 浅校验"，成功后结果在 `value` 里。
   * 解析/校验失败会抛 `code === 'LLM_INVALID_OUTPUT'` 的错误（不会把半截文本当成功）。
   */
  schema?: LlmSchemaRequest
}

export interface PluginLlmChatResult {
  text: string
  source: string
  model: string
  elapsedMs: number
  /** 给了 `schema` 且解析/校验成功时的结构化结果 */
  value?: unknown
}

/**
 * 流式请求：消息用**内容块**（与 `ctx.fs` 一样，形状对齐 DSH），其余参数与 `chat` 同义。
 *
 * 当前只支持文本块：含 `image` 会在流里以 `finish{code:'LLM_UNSUPPORTED_CONTENT'}` 结束
 * （拼接 base64 进 prompt 只会让模型看到乱码，不如明确拒绝）。
 */
export interface PluginLlmStreamRequest extends Omit<PluginLlmChatRequest, 'messages' | 'schema'> {
  messages: LlmMessage[]
  schema?: LlmSchemaRequest
}

export interface PluginLlmModelList {
  online: boolean
  models: string[]
  error?: string
}

export interface PluginLlmApi {
  /** 该插件是否有 llm 权限（false 时下面方法一律抛错） */
  readonly available: boolean
  /** 不可用时的原因（可用时为空串） */
  readonly reason: string
  /** 软件里配置过的来源清单（顺序即设置页顺序） */
  sources(): PluginLlmSourceInfo[]
  /** 软件当前生效的来源与模型 */
  current(): { source: string; model: string }
  /** 拉取某来源的可用模型清单（本地服务可先拉清单再选模型） */
  models(source?: string): Promise<PluginLlmModelList>
  /**
   * 发起一次「一次性」对话（非流式），返回完整文本。
   * 传了 `schema` 时宿主会要求模型只输出 JSON、解析并浅校验，结果放在 `value`。
   */
  chat(request: PluginLlmChatRequest): Promise<PluginLlmChatResult>
  /**
   * 流式对话：产出 `block-start` / `text-delta` / `finish` 分片，**必然以 `finish` 结束**。
   * `finish.kind` 是 `ok` / `error` / `aborted`；`error` 时带稳定 `code`（`LLM_*`）。
   * 失败与取消**不抛异常**（与 `ctx.agent.run` 的 `termination` 同一套哲学）。
   */
  stream(request: PluginLlmStreamRequest): AsyncIterable<LlmChunk>
}

interface LlmApiDeps {
  pluginId: string
  permitted: boolean
  log: { warn(...args: unknown[]): void; info(...args: unknown[]): void }
}

const DEFAULT_TIMEOUT_MS = 90_000

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 与 ai-core 同一套代理规则：仅「页面由局域网主机投递」时走 /__proxy，其余直连 */
function apiUrl(url: string): string {
  const w = typeof window !== 'undefined' ? (window as unknown as { ipcRenderer?: unknown; dsh?: unknown; __AIKM_HOST__?: unknown; location: Location }) : null
  if (!w) return url
  if (w.ipcRenderer || w.dsh) return url
  if (!w.__AIKM_HOST__) return url
  return `${w.location.origin}/__proxy?url=${encodeURIComponent(url)}`
}

const stripSlash = (url: string): string => String(url || '').replace(/\/+$/, '')

/** 把「聊天端点」换成同源的模型清单端点（GPUStack / 自定义这类基址推导出来的端点） */
function modelsEndpointFromChat(chatEndpoint: string): string {
  return String(chatEndpoint || '').replace(/\/chat\/completions$/, '/models').replace(/\/completions$/, '/models')
}

export function createPluginLlmApi(deps: LlmApiDeps): PluginLlmApi {
  const reason = deps.permitted
    ? ''
    : `插件 ${deps.pluginId} 未声明 "llm" 权限（package.json 的 aikm.permissions 加 "llm"，然后在插件页重载）`

  const guard = (): void => {
    if (!deps.permitted) throw new Error(reason)
  }

  /**
   * 取 store 里的模型配置树。
   * 注意：配置挂在 `store.AIconfig.llm` 上（持久化键同名 AIconfig），不是 `store.llm`——
   * 写错会表现为「所有来源都没配置」（来源下拉只剩「跟随设置」一项），实际踩过。
   */
  const llmState = (): any => {
    try {
      const store: any = usestore()
      return store?.AIconfig?.llm ?? store?.llm ?? {}
    } catch {
      // store 尚未就绪（极早期调用）时按空配置处理
      return {}
    }
  }

  const configOf = (source: string): any => llmConfigByKey(llmState(), source) || {}
  const labelOf = (source: string): string => {
    if (normalizeLlmType(source) !== 'custom') return llmSourceLabel(source)
    const custom = configOf('custom')
    return String(custom?.name || custom?.label || 'Custom')
  }
  const currentOf = (): { source: string; model: string } => {
    const state = llmState()
    const source = normalizeLlmType(state?.type) || 'ollama'
    const model = String(configOf(source)?.model || '')
    return { source, model }
  }
  const resolveSource = (source?: string): string => normalizeLlmType(source) || currentOf().source

  const isConfigured = (source: string): boolean => {
    const cfg = configOf(source)
    if (!cfg) return false
    switch (normalizeLlmType(source)) {
      case 'ollama': return !!cfg.model_url
      case 'lmstudio': return !!cfg.base_url || !!cfg.model
      case 'openai': return !!cfg.api_key || !!cfg.base_url
      case 'deepseek': return !!cfg.api_key
      case 'gpustack': return !!cfg.base_url
      case 'anthropic': return !!cfg.api_key
      case 'google': return !!cfg.api_key
      case 'azure': return !!cfg.endpoint
      case 'custom': return !!cfg.api_url
      default: return false
    }
  }

  /** OpenAI 兼容来源的模型清单 */
  const openAiCompatibleModels = async (endpoint: string, apiKey?: string): Promise<PluginLlmModelList> => {
    try {
      const res = await fetch(apiUrl(endpoint), {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      })
      if (!res.ok) return { online: false, models: [], error: `HTTP ${res.status}` }
      const data: any = await res.json()
      const rows: any[] = data?.data || data?.models || []
      const models = rows.map((m) => String(m?.id ?? m?.name ?? '')).filter(Boolean)
      if (models.length) return { online: true, models }
      // LM Studio 的 /v1/models 一定有条目；空清单多为服务在跑但不是 OpenAI 兼容端点
      return { online: false, models: [], error: '端点未返回模型清单' }
    } catch (e: any) {
      return { online: false, models: [], error: e?.message || String(e) }
    }
  }

  return {
    get available() {
      return deps.permitted
    },
    get reason() {
      return reason
    },

    sources(): PluginLlmSourceInfo[] {
      guard()
      return LLM_SOURCE_KEYS.map((key) => ({
        key,
        label: labelOf(key),
        model: String(configOf(key)?.model || ''),
        configured: isConfigured(key),
      }))
    },

    current(): { source: string; model: string } {
      guard()
      return currentOf()
    },

    async models(source?: string): Promise<PluginLlmModelList> {
      guard()
      const key = resolveSource(source)
      const cfg = configOf(key)
      if (normalizeLlmType(key) === 'ollama') {
        const res = await AIUtils.listOllamaModels(cfg)
        const models = (res.models || []).map((m) => String(m.name || '')).filter(Boolean)
        return { online: res.online, models, ...(res.error ? { error: res.error } : {}) }
      }
      if (normalizeLlmType(key) === 'lmstudio') {
        const native = await AIUtils.listLmStudioModels(cfg)
        const models = (native.models || []).map((m) => String(m.id || '')).filter(Boolean)
        if (models.length) return { online: true, models }
        // 原生端点不可用（旧版本 / 关了服务）时退回 OpenAI 兼容端点
        return await openAiCompatibleModels(`${stripSlash(cfg.base_url || 'http://127.0.0.1:1234')}/v1/models`, cfg.api_key)
      }
      if (normalizeLlmType(key) === 'google') {
        const models = await openAiCompatibleModels(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(String(cfg.api_key || ''))}`,
        )
        return { ...models, models: models.models.map((m) => m.replace(/^models\//, '')) }
      }
      if (normalizeLlmType(key) === 'anthropic') {
        try {
          const res = await fetch(apiUrl('https://api.anthropic.com/v1/models'), {
            headers: {
              'x-api-key': String(cfg.api_key || ''),
              'anthropic-version': String(cfg.api_version || '2023-06-01'),
              'Content-Type': 'application/json',
            },
          })
          if (!res.ok) return { online: false, models: [], error: `HTTP ${res.status}` }
          const data: any = await res.json()
          return { online: true, models: ((data?.data || []) as any[]).map((m) => String(m?.id || '')).filter(Boolean) }
        } catch (e: any) {
          return { online: false, models: [], error: e?.message || String(e) }
        }
      }
      if (normalizeLlmType(key) === 'azure') {
        return { online: false, models: [], error: 'Azure 使用部署名，请直接在设置里填写模型/部署名' }
      }
      const endpoint = normalizeLlmType(key) === 'gpustack' || normalizeLlmType(key) === 'custom'
        ? modelsEndpointFromChat(AIUtils.buildCustomChatEndpoint(String(cfg.base_url || cfg.api_url || '')))
        : `${stripSlash(String(cfg.base_url || ''))}/v1/models`
      return await openAiCompatibleModels(endpoint, cfg.api_key)
    },

    async chat(request: PluginLlmChatRequest): Promise<PluginLlmChatResult> {
      guard()
      const source = resolveSource(request?.source)
      const cfg: any = { ...configOf(source) }
      const model = String(request?.model || cfg.model || '').trim()
      if (!model) {
        throw llmError('LLM_NO_MODEL', `来源「${labelOf(source)}」还没有选择模型：请先在插件里（或设置 → 模型）指定模型名`)
      }
      cfg.model = model

      const messages: PluginLlmMessage[] = []
      if (request?.system) messages.push({ role: 'system', content: String(request.system) })
      // 内容块必须转成纯文本（直接 String(content) 会得到 "[object Object]" 发给模型）
      const converted = toChatMessages(Array.isArray(request?.messages) ? (request.messages as ChatMessageInput[]) : [])
      if (!converted.ok) throw llmError(converted.code, converted.message)
      for (const m of converted.messages) messages.push({ role: m.role, content: m.content })
      if (!messages.length) throw llmError('LLM_FAILED', 'chat 需要至少一条消息')

      // 结构化输出：把约束写进最后一条 system 指令（不依赖 provider 私有参数）
      const schema = request?.schema && typeof request.schema === 'object' ? request.schema : undefined
      if (schema) messages.push({ role: 'system', content: schemaInstruction(schema) })

      const llmConfig: any = {
        stream: false,
        temperature: clampNumber(request?.temperature, 0, 2, 0.8),
        top_p: 0.9,
        max_tokens: clampNumber(request?.maxTokens, 16, 16_384, 1024),
        ...(typeof request?.think === 'boolean' ? { think: request.think } : {}),
      }
      if (source === 'ollama') {
        llmConfig.options = { temperature: llmConfig.temperature, top_p: llmConfig.top_p, num_predict: llmConfig.max_tokens }
        llmConfig.keep_alive = '5m'
      }

      const controller = new AbortController()
      const timeoutMs = clampNumber(request?.timeoutMs, 1_000, 10 * 60_000, DEFAULT_TIMEOUT_MS)
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      // 合并调用方 signal（AbortSignal.any 在部分 Electron 版本不可用，手写监听更稳）
      const external = request?.signal
      const forward = () => controller.abort()
      if (external) {
        if (external.aborted) controller.abort()
        else external.addEventListener('abort', forward, { once: true })
      }

      const startedAt = Date.now()
      try {
        const text = String(
          (await AIUtils.sendChat(source, cfg, llmConfig, messages as any, { signal: controller.signal })) ?? '',
        ).trim()
        const result: PluginLlmChatResult = { text, source, model, elapsedMs: Date.now() - startedAt }
        if (!schema) return result
        const parsed = extractJson(text)
        if (!parsed.ok) {
          throw llmError('LLM_INVALID_OUTPUT', `模型没有返回可解析的 JSON（${parsed.message}）`)
        }
        const checked = checkAgainstSchema(parsed.value, schema.schema ?? {})
        if (!checked.ok) throw llmError('LLM_INVALID_OUTPUT', `模型返回的 JSON 不符合 schema：${checked.message}`)
        return { ...result, value: parsed.value }
      } catch (e: any) {
        const timedOut = controller.signal.aborted && !external?.aborted
        const message = timedOut
          ? `调用超时（${Math.round(timeoutMs / 1000)} 秒）`
          : (e?.message || String(e))
        deps.log.warn(`[plugin:${deps.pluginId}] 大模型调用失败（${labelOf(source)} / ${model}）：${message}`)
        // 已有 code 的（结构化输出失败等）原样抛出，别把分类盖掉
        if (e && typeof e.code === 'string' && e.code.startsWith('LLM_')) throw e
        throw llmError(classifyLlmError(e, controller.signal.aborted), message)
      } finally {
        clearTimeout(timer)
        if (external) external.removeEventListener('abort', forward)
      }
    },

    /**
     * 流式对话：把 `sendChat` 的 `onStream` 回调转成 `AsyncIterable`，并**保证以 `finish` 结束**。
     *
     * 关键约定（与 `ctx.agent.run` 同源）：
     * - `aborted` / `error` 也是 `finish`，**不抛异常** —— 消费方用 `for await` 不必包 try；
     * - `finish.text` 是结束时的完整文本：成功时是全部输出，失败时是**中止前拿到的部分**（不丢弃）；
     * - 给了 `schema` 时先攒全文再解析（结构化输出不能边流边解析），成功才带 `value`。
     */
    stream(request: PluginLlmStreamRequest): AsyncIterable<LlmChunk> {
      const queue: LlmChunk[] = []
      // 用一个"信箱"对象而不是裸变量：跨闭包赋值时 TS 会把裸变量窄化成 null（never 不可调用）
      const mailbox: { wake: (() => void) | null } = { wake: null }
      let done = false
      const push = (chunk: LlmChunk): void => {
        queue.push(chunk)
        const notify = mailbox.wake
        mailbox.wake = null
        notify?.()
      }
      const startedAt = Date.now()

      // 立刻开始跑（返回的迭代器只是在消费队列）；错误一律转成 finish，不往外抛
      void (async () => {
        const source = resolveSource(request?.source)
        const cfg: any = { ...configOf(source) }
        const model = String(request?.model || cfg.model || '').trim()
        const external = request?.signal
        const controller = new AbortController()
        const forward = () => controller.abort()
        const timeoutMs = clampNumber(request?.timeoutMs, 1_000, 10 * 60_000, DEFAULT_TIMEOUT_MS)
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        if (external) {
          if (external.aborted) controller.abort()
          else external.addEventListener('abort', forward, { once: true })
        }
        let text = ''
        try {
          if (!deps.permitted) throw llmError('LLM_FAILED', reason)
          if (!model) throw llmError('LLM_NO_MODEL', `来源「${labelOf(source)}」还没有选择模型`)
          cfg.model = model

          const plain = toPlainMessages(Array.isArray(request?.messages) ? request.messages : [])
          if (!plain.ok) throw llmError(plain.code, plain.message)
          const messages: PluginLlmMessage[] = []
          if (request?.system) messages.push({ role: 'system', content: String(request.system) })
          for (const m of plain.messages) messages.push({ role: m.role, content: m.content })
          if (!messages.length) throw llmError('LLM_FAILED', 'stream 需要至少一条消息')
          const schema = request?.schema && typeof request.schema === 'object' ? request.schema : undefined
          if (schema) messages.push({ role: 'system', content: schemaInstruction(schema) })

          const llmConfig: any = {
            stream: true,
            temperature: clampNumber(request?.temperature, 0, 2, 0.8),
            top_p: 0.9,
            max_tokens: clampNumber(request?.maxTokens, 16, 16_384, 1024),
            ...(typeof request?.think === 'boolean' ? { think: request.think } : {}),
          }
          if (source === 'ollama') {
            llmConfig.options = { temperature: llmConfig.temperature, top_p: llmConfig.top_p, num_predict: llmConfig.max_tokens }
            llmConfig.keep_alive = '5m'
          }

          push({ type: 'block-start', block: { kind: 'text' } })
          const full = await AIUtils.sendChat(source, cfg, llmConfig, messages as any, {
            signal: controller.signal,
            onStream: (chunk: string) => {
              const delta = String(chunk ?? '')
              if (!delta) return
              text += delta
              push({ type: 'text-delta', text: delta })
            },
          })
          // 有的来源在 onStream 之外才给出完整文本（或根本没回调）：以返回值为准补一段
          const finalText = String(full ?? '')
          if (finalText && finalText !== text) {
            const rest = finalText.startsWith(text) ? finalText.slice(text.length) : finalText
            if (rest) {
              text = finalText
              push({ type: 'text-delta', text: rest })
            }
          }

          let value: unknown
          if (schema) {
            const parsed = extractJson(text)
            if (!parsed.ok) throw llmError('LLM_INVALID_OUTPUT', `模型没有返回可解析的 JSON（${parsed.message}）`)
            const checked = checkAgainstSchema(parsed.value, schema.schema ?? {})
            if (!checked.ok) throw llmError('LLM_INVALID_OUTPUT', `模型返回的 JSON 不符合 schema：${checked.message}`)
            value = parsed.value
          }
          push({ type: 'finish', kind: 'ok', text, ...(schema ? { value } : {}) })
        } catch (e: any) {
          const aborted = controller.signal.aborted
          const timedOut = aborted && !external?.aborted
          const message = timedOut ? `调用超时（${Math.round(timeoutMs / 1000)} 秒）` : (e?.message || String(e))
          const code: LlmErrorCode = e && typeof e.code === 'string' && e.code.startsWith('LLM_')
            ? (e.code as LlmErrorCode)
            : classifyLlmError(e, aborted)
          if (code !== 'LLM_ABORTED') {
            deps.log.warn(`[plugin:${deps.pluginId}] 大模型流失败（${labelOf(source)} / ${model || '?'}）：${message}`)
          }
          push({
            type: 'finish',
            kind: aborted ? 'aborted' : 'error',
            code,
            message,
            text,
          })
        } finally {
          clearTimeout(timer)
          if (external) external.removeEventListener('abort', forward)
          done = true
          const notify = mailbox.wake
          mailbox.wake = null
          notify?.()
        }
        void startedAt
      })()

      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<LlmChunk>> {
              for (;;) {
                if (queue.length) return { value: queue.shift() as LlmChunk, done: false }
                if (done) return { value: undefined, done: true }
                await new Promise<void>((resolve) => {
                  mailbox.wake = resolve
                })
              }
            },
          }
        },
      }
    },
  }
}
