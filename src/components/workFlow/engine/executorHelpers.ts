/**
 * executorHelpers - 节点执行器的共享工具函数
 *
 * 从 WorkflowRunner 中提取的纯函数，供各节点执行器复用。
 */

import type { NodeData, DecisionBranch } from '@/components/workFlow/engine/WorkflowRunner'
import { deepSeekStyleOf, normalizeLlmType } from '@/shared/llmSources'

// ── 数据模板替换 ─────────────────────────────────────────

export function applyDataTemplate(template: string, context: Record<string, any>): string {
  if (!template) return ''
  let result = template
  if (context.input !== undefined) result = result.replace(/\{input\}/g, context.input)
  if (context.branchId !== undefined) result = result.replace(/\{branchId\}/g, context.branchId)
  if (context.branchName !== undefined) result = result.replace(/\{branchName\}/g, context.branchName)
  if (context.result !== undefined) result = result.replace(/\{result\}/g, context.result)
  return result
}

// ── 错误提取 ─────────────────────────────────────────────

export function extractErrorFromResult(result: string): string {
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object') {
      if (parsed.error) return parsed.error
      if (parsed.result && typeof parsed.result === 'string') {
        if (parsed.result.includes('错误') || parsed.result.includes('Error') || parsed.result.includes('error')) {
          return parsed.result
        }
      }
    }
    return result.substring(0, 100)
  } catch {
    return result.substring(0, 100)
  }
}

export function extractPythonErrorInfo(result: string): { error: string; traceback?: string } {
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && parsed.error) {
      const errorStr = String(parsed.error)
      const lines = errorStr.split('\n')
      const errorLines = lines.filter(line =>
        line.includes('Traceback') || line.includes('Error:') ||
        line.includes('Exception:') || line.includes('File')
      )
      if (errorLines.length > 0) {
        return { error: errorLines[0].replace('Error:', '').replace('Exception:', '').trim(), traceback: errorStr }
      }
      return { error: errorStr.substring(0, 200) }
    }
    return { error: extractErrorFromResult(result) }
  } catch {
    return { error: extractErrorFromResult(result) }
  }
}

// ── 分支ID提取 ───────────────────────────────────────────

export function extractBranchIdFromResponse(response: string, branches: DecisionBranch[]): string {
  const cleanResponse = response.trim().toLowerCase()
  for (const branch of branches) {
    if (cleanResponse.includes(branch.id.toLowerCase())) return branch.id
  }
  for (const branch of branches) {
    if (cleanResponse.includes(branch.name.toLowerCase())) return branch.id
  }
  const numberMatch = cleanResponse.match(/(\d+)/)
  if (numberMatch) {
    const index = parseInt(numberMatch[1]) - 1
    if (index >= 0 && index < branches.length) return branches[index].id
  }
  return branches[0].id
}

// ── 模型配置验证 ─────────────────────────────────────────

export function validateModelConfig(node: NodeData, store: any, t: (key: string) => string): { valid: boolean; message: string } {
  if (!node.model_type) return { valid: false, message: t('select_model_type') }
  if (!node.model) return { valid: false, message: t('select_model') }

  switch (node.model_type) {
    case 'ollama':
      break
    case 'lmstudio':
      if (!store.AIconfig?.llm?.lmstudio?.base_url) return { valid: false, message: t('lmstudio_url_required') }
      break
    case 'openai':
      if (!store.AIconfig?.llm?.openai?.api_key) return { valid: false, message: t('api_key_required') }
      break
    case 'deepseek':
    case 'deepseek-responses': {
      // DeepSeek 单来源：接口样式决定用哪套凭据（Responses 样式有独立记忆块）
      const llmDs: any = store.AIconfig?.llm
      const dsCfg: any = deepSeekStyleOf(node.model_type, llmDs?.deepseek) === 'responses' ? llmDs?.deepseekResponses : llmDs?.deepseek
      if (!dsCfg?.api_key && !dsCfg?.apiKeyRef) return { valid: false, message: t('api_key_required') }
      break
    }
    case 'gpustack':
      // GPUStack：自托管服务，本地部署允许无密钥
      break
    case 'anthropic':
      if (!store.AIconfig?.llm?.anthropic?.api_key) return { valid: false, message: t('api_key_required') }
      break
    case 'google':
      if (!store.AIconfig?.llm?.google?.api_key) return { valid: false, message: t('api_key_required') }
      break
    case 'azure':
      if (!store.AIconfig?.llm?.azure?.api_key || !store.AIconfig?.llm?.azure?.endpoint || !store.AIconfig?.llm?.azure?.deployment)
        return { valid: false, message: t('api_key_required') }
      break
    case 'custom': {
      // 自定义来源：以节点绑定的来源（customSourceIndex）为准，缺省用激活来源；扁平字段可能未对齐
      const c = store.AIconfig?.llm?.custom
      const srcs = Array.isArray(c?.sources) ? c.sources : []
      let idx = typeof c?.activeIndex === 'number' ? c.activeIndex : 0
      if (typeof node.customSourceIndex === 'number' && node.customSourceIndex >= 0 && node.customSourceIndex < srcs.length) {
        idx = node.customSourceIndex
      }
      const src = srcs[idx]
      const apiUrl = (src && src.api_url) || c?.api_url || ''
      if (!apiUrl) return { valid: false, message: t('api_url_required') }
      break
    }
  }
  return { valid: true, message: '' }
}

// ── 等待文本映射 ─────────────────────────────────────────

export function getWaitingText(type: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    text: 'waiting', local: 'waiting', web: 'waiting_search',
    webpage: 'waiting_fetch', reasoning: 'waiting_reasoning',
    decision: 'waiting_decision', python: 'waiting_execute',
    knowledge: 'waiting_retrieval', structured: 'waiting_structured',
    mcp: 'waiting', start: 'waiting_start', end: 'waiting_end'
  }
  return t(map[type] || 'waiting')
}

// ── 工作流 LLM 节点：来源类型 / 模型列表统一（与现行模型来源对齐） ──────────────────────────

/** 工作流 LLM 节点可用的模型来源类型（过滤被禁用的；custom 仅在存在启用自定义来源时显示） */
export function getWorkflowModelTypes(store: any): string[] {
  // 单来源列表：DeepSeek 只有一个来源（接口样式在设置页切换），不再单列 'deepseek-responses'
  const list = ['ollama', 'lmstudio', 'deepseek', 'gpustack', 'openai', 'anthropic', 'google', 'azure', 'custom']
  return list.filter(t =>
    !store?.isLlmSourceDisabled?.(t) &&
    (t !== 'custom' || !!store?.hasEnabledCustomSource?.())
  )
}

/** 获取某模型来源当前可用的模型列表（type 可为 custom:<index>，指定具体自定义来源） */
export function getWorkflowAvailableModels(store: any, type: string): string[] {
  const llm = store?.AIconfig?.llm
  if (!llm) return []
  // 单来源：历史别名归一到 'deepseek'
  type = normalizeLlmType(type)
  switch (type) {
    case 'ollama': return Array.isArray(llm.ollama?.available_models) ? llm.ollama.available_models : []
    case 'lmstudio': return Array.isArray(llm.lmstudio?.available_models) ? llm.lmstudio.available_models : []
    case 'openai': return Array.isArray(llm.openai?.available_models) ? llm.openai.available_models : []
    case 'deepseek': {
      // 单来源：模型列表取当前接口样式对应的配置块
      const dsCfg: any = llm.deepseek?.api_style === 'responses' ? llm.deepseekResponses : llm.deepseek
      return Array.isArray(dsCfg?.available_models) ? dsCfg.available_models : []
    }
    case 'gpustack':
      return llm.gpustack?.model ? [llm.gpustack.model]
        : (Array.isArray(llm.gpustack?.available_models) ? llm.gpustack.available_models : [])
    case 'anthropic':
      return llm.anthropic?.model ? [llm.anthropic.model]
        : ['claude-3-haiku-20240307', 'claude-3-sonnet-20240229', 'claude-3-opus-20240229']
    case 'google':
      return llm.google?.model ? [llm.google.model]
        : ['gemini-pro', 'gemini-pro-vision']
    case 'azure':
      return llm.azure?.deployment ? [llm.azure.deployment]
        : (Array.isArray(llm.azure?.available_models) ? llm.azure.available_models : [])
    case 'custom':
    default: {
      // 兼容 custom:<index>（指定具体来源）与裸 custom（激活来源）
      const c = llm.custom
      const srcs = Array.isArray(c?.sources) ? c.sources : []
      let idx = typeof c?.activeIndex === 'number' ? c.activeIndex : 0
      if (typeof type === 'string' && type.startsWith('custom:')) {
        const n = parseInt(type.slice('custom:'.length), 10)
        if (!isNaN(n) && n >= 0 && n < srcs.length) idx = n
      }
      const src = srcs[idx]
      if (src && Array.isArray(src.available_models) && src.available_models.length) return src.available_models
      if (Array.isArray(c?.available_models)) return c.available_models
      return []
    }
  }
}

/** 工作流 LLM 节点来源下拉选项：内置来源 + 每个自定义来源独立一项（value 编码 custom:<index>，label 用来源名） */
export function getWorkflowModelOptions(store: any, t: (key: string) => string): Array<{ value: string; label: string }> {
  const typeLabel = (type: string): string => {
    const map: Record<string, string> = {
      ollama: t('ollama'), lmstudio: 'LM Studio', openai: t('openai'),
      deepseek: t('deepseek'),
      anthropic: t('anthropic'), google: t('google'), azure: t('azure'), custom: t('custom'),
    }
    return map[type] || type
  }
  const options: Array<{ value: string; label: string }> = []
  for (const type of getWorkflowModelTypes(store)) {
    if (type !== 'custom') options.push({ value: type, label: typeLabel(type) })
  }
  // 自定义来源：逐个列出（名称 + 默认名回退；跳过被单独禁用的来源）
  const c = store?.AIconfig?.llm?.custom
  const srcs = Array.isArray(c?.sources) ? c.sources : []
  for (let i = 0; i < srcs.length; i++) {
    const src = srcs[i]
    if (store?.isLlmSourceDisabled?.('custom', src?.id)) continue
    const name = (src && src.name && String(src.name).trim()) ? String(src.name).trim() : typeLabel('custom')
    options.push({ value: `custom:${i}`, label: name })
  }
  return options
}

// ── AI 模型切换 ──────────────────────────────────────────

export function setAIModelConfig(store: any, node: NodeData): Record<string, any> {
  const originalConfig = JSON.parse(JSON.stringify(store.AIconfig?.llm || {}))
  // 单来源：历史别名归一到 'deepseek'
  const modelType = normalizeLlmType(node.model_type)
  if (store.AIconfig?.llm) store.AIconfig.llm.type = modelType

  switch (modelType) {
    case 'ollama':
      if (node.model && store.AIconfig?.llm?.ollama) store.AIconfig.llm.ollama.model = node.model
      break
    case 'lmstudio':
      if (node.model && store.AIconfig?.llm?.lmstudio) store.AIconfig.llm.lmstudio.model = node.model
      break
    case 'openai':
      if (store.AIconfig?.llm?.openai) store.AIconfig.llm.openai.model = node.model || store.AIconfig.llm.openai.model
      break
    case 'deepseek':
    case 'deepseek-responses':
      // 单来源：模型写回当前接口样式对应的配置块
      if (store.AIconfig?.llm) {
        const dsTarget: any = deepSeekStyleOf(node.model_type, store.AIconfig.llm.deepseek) === 'responses'
          ? store.AIconfig.llm.deepseekResponses
          : store.AIconfig.llm.deepseek
        if (dsTarget) dsTarget.model = node.model || dsTarget.model
      }
      break
    case 'gpustack':
      if (store.AIconfig?.llm?.gpustack) store.AIconfig.llm.gpustack.model = node.model || store.AIconfig.llm.gpustack.model
      break
    case 'anthropic':
      if (store.AIconfig?.llm?.anthropic) store.AIconfig.llm.anthropic.model = node.model || store.AIconfig.llm.anthropic.model
      break
    case 'google':
      if (store.AIconfig?.llm?.google) store.AIconfig.llm.google.model = node.model || store.AIconfig.llm.google.model
      break
    case 'azure':
      if (store.AIconfig?.llm?.azure) store.AIconfig.llm.azure.deployment = node.model || store.AIconfig.llm.azure.deployment
      break
    case 'custom': {
      // 自定义来源：按节点绑定的来源（customSourceIndex）应用；扁平字段可能未对齐，需先 apply 到权威来源
      if (store.AIconfig?.llm?.custom) {
        const c = store.AIconfig.llm.custom
        if (typeof node.customSourceIndex === 'number') {
          store.applyCustomSourceIndex?.(node.customSourceIndex)
        }
        c.model = node.model || c.model || ''
        const srcs = Array.isArray(c.sources) ? c.sources : []
        const src = srcs[typeof c.activeIndex === 'number' ? c.activeIndex : 0]
        if (src && node.model) src.model = node.model
      }
      break
    }
  }
  return originalConfig
}

// ── 网页内容提取 ─────────────────────────────────────────

export function extractMainContent(
  html: string,
  strategy: 'simple' | 'textDensity' | 'readability' = 'textDensity',
  baseUrl: string = 'https://example.com'
): { content: string; links: Array<{ text: string; url: string }> } {
  if (!html) return { content: '', links: [] }

  let content = html
  const links: Array<{ text: string; url: string }> = []

  const normalizeUrl = (href: string): string | null => {
    if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return null
    try { return new URL(href, baseUrl).href } catch { return null }
  }

  // Extract <a> links
  const aTagRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi
  content = content.replace(aTagRegex, (match, url, attrs, linkText) => {
    const cleanText = linkText.replace(/<[^>]*>/g, '').trim()
    const absoluteUrl = normalizeUrl(url)
    if (cleanText && absoluteUrl) links.push({ text: cleanText, url: absoluteUrl })
    return cleanText
  })

  // Extract markdown links
  const mdLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  let mdMatch
  while ((mdMatch = mdLinkRegex.exec(html)) !== null) {
    const [, text, url] = mdMatch
    const absoluteUrl = normalizeUrl(url)
    if (text && absoluteUrl) links.push({ text: text.trim(), url: absoluteUrl })
  }

  // Remove scripts/styles
  const htmlWithoutScripts = content
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')

  const getTextFromHtml = (htmlPart: string): string => {
    let text = htmlPart.replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ')
    return text.trim()
  }

  let candidateText = getTextFromHtml(htmlWithoutScripts)

  if (strategy === 'readability') {
    const articleMatch = html.match(/<(article|main|section)[^>]*>[\s\S]*?<\/\1>/gi)
    if (articleMatch && articleMatch.length > 0) {
      candidateText = articleMatch.map(block => getTextFromHtml(block)).join(' ')
    }
  } else if (strategy === 'textDensity') {
    const blocks = htmlWithoutScripts.split(/<\/(?:article|main|section|div|p|li|h[1-6])>/gi)
    const scoredBlocks = blocks.map(block => {
      const text = getTextFromHtml(block)
      const wordCount = text.length
      const tagCount = (block.match(/<[^>]+>/g) || []).length
      return { text, score: wordCount - tagCount * 3 }
    }).filter(b => b.text.length > 20)
    scoredBlocks.sort((a, b) => b.score - a.score)
    candidateText = scoredBlocks.slice(0, 5).map(b => b.text).join(' ')
    if (!candidateText) candidateText = getTextFromHtml(htmlWithoutScripts)
  }

  const sentences = candidateText.split(/([。！？.!?])/g)
  const meaningfulSentences: string[] = []
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].trim().length > 10) meaningfulSentences.push(sentences[i])
  }
  let finalContent = meaningfulSentences.join(' ').replace(/\s+/g, ' ').trim()

  const MAX_CONTENT_LENGTH = 5000
  if (finalContent.length > MAX_CONTENT_LENGTH) {
    const truncated = finalContent.substring(0, MAX_CONTENT_LENGTH)
    const lastPeriod = Math.max(truncated.lastIndexOf('。'), truncated.lastIndexOf('.'),
      truncated.lastIndexOf('！'), truncated.lastIndexOf('?'))
    if (lastPeriod > MAX_CONTENT_LENGTH * 0.8) finalContent = truncated.substring(0, lastPeriod + 1)
    else finalContent = truncated + '...'
  }

  return { content: finalContent, links }
}

// ── 数组解析（迭代 / 列表操作节点共享） ────────────────────

/** 尝试把任意值解析为数组；不是数组则返回 null */
export function tryParseArray(value: any): any[] | null {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!t) return null
  try {
    const parsed = JSON.parse(t)
    if (Array.isArray(parsed)) return parsed
  } catch { /* 非 JSON */ }
  return null
}

/** 常见承载数组的字段名（数据节点 rows/output/batches 等） */
const ARRAY_CONTAINER_KEYS = ['rows', 'output', 'batches', 'list', 'data', 'items', 'array']

/**
 * 从值中提取数组：数组本身 / JSON 数组字符串 / 包含数组字段的对象（如数据节点的
 * { rows: [...] }），均返回该数组；否则返回 null。
 */
export function extractArrayFromValue(value: any): any[] | null {
  const direct = tryParseArray(value)
  if (direct) return direct
  let obj: any = value
  if (typeof value === 'string' && value.trim()) {
    try { obj = JSON.parse(value) } catch { return null }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of ARRAY_CONTAINER_KEYS) {
      if (Array.isArray(obj[key])) return obj[key]
    }
  }
  return null
}

/**
 * 解析数组输入：
 * - 空 → 从上游节点上下文尝试提取数组（支持数据节点对象）
 * - 以 {{ 开头 → 优先用原始值解析（数据节点 rows/batches 直接返回全量缓存数组，避免大 JSON 字符串化），
 *   否则走字符串模板解析后再尝试解析数组
 * - 其余 → 按 JSON 数组解析
 * 全部失败时抛错。
 */
export async function resolveArrayInput(
  raw: string | undefined,
  ctx: {
    resolveTemplate(template: string, currentNodeId?: number): string
    resolveTemplateRaw?(template: string, currentNodeId?: number): any
    getNodeContextWithPorts(nodeId: number, decisionPaths?: Map<number, string>): Promise<string[]>
    decisionPaths: Map<number, string>
  },
  nodeId: number,
  t: (key: string) => string
): Promise<any[]> {
  const source = (raw || '').trim()
  if (!source) {
    const contexts = await ctx.getNodeContextWithPorts(nodeId, ctx.decisionPaths)
    for (const c of contexts) {
      const arr = extractArrayFromValue(c)
      if (arr) return arr
    }
    throw new Error(t('array_input_empty'))
  }
  if (source.startsWith('{{')) {
    // 原始值解析优先（数据节点全量缓存）
    if (typeof ctx.resolveTemplateRaw === 'function') {
      const rawValue = ctx.resolveTemplateRaw(source, nodeId)
      if (rawValue !== undefined && rawValue !== null) {
        const arr = extractArrayFromValue(rawValue)
        if (arr) return arr
      }
    }
    const resolved = ctx.resolveTemplate(source, nodeId)
    const arr = extractArrayFromValue(resolved)
    if (arr) return arr
    throw new Error(`${t('template_not_array')}: ${resolved.slice(0, 100)}`)
  }
  const arr = tryParseArray(source)
  if (arr) return arr
  throw new Error(`${t('input_must_be_array')}: ${source.slice(0, 100)}`)
}
