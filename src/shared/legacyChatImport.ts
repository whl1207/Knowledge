/**
 * legacyChatImport.ts — 旧版 AI-KM 聊天 JSON 的解析与归一化（纯函数）
 *
 * 支持旧版可能出现的几种形态：
 * - 裸数组：`[{ id, title, messages, config, mode, ... }]`
 * - 当前导出包：`{ app:'ai-km', kind:'chats', chats:[...] }`
 * - 旧版整包备份：`{ app:'ai-km', kind:'backup', data:{ 'ai-chats':[...] } }`
 * - 以 id 为 key 的对象：`{ chats: { id: {...} } }` / `{ 'ai-chats': { ... } }`
 *
 * 只做“字段形状归一”，不写 localStorage / 不弹 UI；设置页的导入流程复用这里，
 * 因此可以单独做纯函数自测。
 *
 * 重要：导入的历史**不接管旧 agent 会话**（agentSessionId 置 null）。旧版每轮新建
 * agent，最后一条 agentViewId 指向的日志未必与当前配置兼容；继续对话时按当前配置
 * 新建会话更可预测。
 */

export interface LegacyChatsParseResult {
  chats: any[]
  /** 被跳过的无效条目数 */
  invalid: number
}

function extractChatArray(parsed: any): any[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return null
  const candidates = [
    parsed.chats,
    parsed['ai-chats'],
    parsed.data?.chats,
    parsed.data?.['ai-chats'],
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) return c
    if (c && typeof c === 'object') {
      const values = Object.values(c).filter(v => v && typeof v === 'object')
      if (values.length) return values
    }
  }
  // 单个聊天对象（有些旧版把一条会话直接保存成对象）
  if (Array.isArray(parsed.messages)) return [parsed]
  return null
}

/** 旧消息字段 → 当前字段（skillSteps / isSkillRunning / isWorkflowRunning 等） */
export function normalizeLegacyMessage(raw: any, now = Date.now(), zh = true): any | null {
  if (!raw || typeof raw !== 'object') return null
  const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system' ? raw.role : 'assistant'
  const msg: any = {
    ...raw,
    role,
    content: typeof raw.content === 'string' ? raw.content : (raw.content == null ? '' : String(raw.content)),
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : now,
  }

  // 旧技能时间线 → executionUnits
  if (!Array.isArray(msg.executionUnits) && Array.isArray(raw.skillSteps)) {
    msg.executionUnits = raw.skillSteps.map((step: any) => ({
      id: step?.id,
      status: step?.status,
      stepType: step?.type,
      description: step?.description,
      result: step?.result,
      error: step?.error,
      startTime: step?.startTime,
      endTime: step?.endTime,
    }))
  }

  // 旧执行态 → executionType / isExecuting；导入后一律停止，避免界面转圈
  const wasRunning = raw.isSkillRunning === true || raw.isWorkflowRunning === true || raw.isExecuting === true
  if (raw.isSkillRunning !== undefined || raw.skillResult !== undefined) {
    msg.executionType = msg.executionType || 'skill'
    msg.executionName = msg.executionName || raw.skillName
    if (msg.content === '' && raw.skillResult) msg.content = String(raw.skillResult)
  }
  if (raw.isWorkflowRunning !== undefined || raw.workflowResult !== undefined) {
    msg.executionType = 'workflow'
    if (msg.content === '' && raw.workflowResult) msg.content = String(raw.workflowResult)
  }

  // 旧 agent 会话引用不保留
  delete msg.agentViewId
  msg.isExecuting = false
  msg.streaming = false
  if (wasRunning && !msg.content) {
    msg.content = zh ? '（导入的旧会话已中断，请重新运行）' : '(imported session was interrupted; please rerun)'
  }
  return msg
}

/** 把一条旧聊天转换成当前 Chat 形状；无法识别返回 null */
export function normalizeLegacyChat(raw: any, index = 0, now = Date.now(), zh = true): any | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) return null
  const messages = raw.messages
    .map((m: any) => normalizeLegacyMessage(m, now, zh))
    .filter(Boolean)
  if (!messages.length) return null

  const rawConfig = raw.config && typeof raw.config === 'object' ? raw.config : {}
  const hasAgent = raw.messages.some((m: any) => m?.agentViewId || m?.executionType === 'skill')
    || messages.some((m: any) => m.executionType === 'skill')
  let mode = raw.mode
  if (mode === 'skill') mode = 'agent2'
  else if (mode === 'code') mode = 'agent'
  else if (!mode) {
    mode = hasAgent
      ? 'agent2'
      : rawConfig.workflowPath
        ? 'workflow'
        : rawConfig.kbPath
          ? 'retrieval'
          : 'normal'
  }

  const firstUser = messages.find((m: any) => m.role === 'user' && String(m.content || '').trim())
  const title = String(raw.title || '').trim()
    || String(firstUser?.content || '').replace(/\s+/g, ' ').slice(0, 30)
    || (zh ? `导入会话 ${index + 1}` : `Imported chat ${index + 1}`)
  const id = String(raw.id || `legacy-${now}-${index}`)

  const config: any = {
    llmType: typeof rawConfig.llmType === 'string' ? rawConfig.llmType : '',
    model: typeof rawConfig.model === 'string' ? rawConfig.model : '',
    temperature: typeof rawConfig.temperature === 'number' ? rawConfig.temperature : 0.7,
    maxTokens: typeof rawConfig.maxTokens === 'number' ? rawConfig.maxTokens : 2048,
    stream: rawConfig.stream !== false,
    functionIndex: typeof rawConfig.functionIndex === 'number' ? rawConfig.functionIndex : 0,
    ...rawConfig,
  }
  if (config.kbTopK === undefined && config.kbPath) config.kbTopK = 5
  if (config.retrievalStrategy === undefined) config.retrievalStrategy = 'similarity'

  return {
    ...raw,
    id,
    title,
    messages,
    config,
    mode,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : (messages[0]?.timestamp || now),
    schemaVersion: 2,
    // 显式不接管旧 agent 会话：导入的历史只作为聊天正文，继续对话时按当前配置新建
    agentSessionId: null,
    agentSessionSignature: null,
    isGenerating: false,
    activeRequestId: undefined,
    pendingPlanReview: null,
    planDecision: undefined,
    agentLastTool: null,
  }
}

/** 解析原始版本 ai-chats JSON；抛错表示文件结构不可识别 */
export function parseLegacyChatsFile(text: string, now = Date.now(), zh = true): LegacyChatsParseResult {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(zh ? '不是有效的 JSON 文件' : 'not a valid JSON file')
  }
  // 某些旧备份会把整个数组再 JSON.stringify 一层，读出来是字符串
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { /* 保持原值，下面报结构错误 */ }
  }
  const list = extractChatArray(parsed)
  if (!list) {
    throw new Error(zh
      ? '文件里没有聊天记录（需要旧版 ai-chats 数组或导出包）'
      : 'no chats found (an old ai-chats array or export package is required)')
  }

  const chats: any[] = []
  let invalid = 0
  const usedIds = new Set<string>()
  list.forEach((raw: any, i: number) => {
    const chat = normalizeLegacyChat(raw, i, now, zh)
    if (!chat) { invalid++; return }
    let id = chat.id
    if (usedIds.has(id)) id = `${id}-${i + 1}`
    chat.id = id
    usedIds.add(id)
    chats.push(chat)
  })
  if (!chats.length) {
    throw new Error(zh ? '文件里没有可导入的聊天（缺少 messages）' : 'no importable chats (messages missing)')
  }
  return { chats, invalid }
}
