/**
 * evidence.ts — 轻量证据层（可选，默认 off）
 *
 * 设计边界：
 *  - 不新增 agent 工具：来源全部从现有 tool trace / 输入字段投影；
 *  - 不改变现有执行语义：本文件只读 PipelineUnit，不写回结果；
 *  - generic 任务也使用同一套 EvidenceState，避免 UI 与论文出现两套词表；
 *  - 自动动作（retrieve/switch）由 runner/attempt 层负责，本文件只给出建议动作。
 */
import type {
  BatchRowTraceCall,
  EvidenceDecision,
  EvidenceSource,
  EvidenceState,
  EpistemicAction,
  PipelineUnit,
} from './types'
import { normalizeUrl } from './fetch'

const URL_RE = /https?:\/\/[^\s"'<>()\]]+/gi

/** 从任意文本里抽取 URL（去重、去掉尾部标点） */
export function extractUrls(text?: string): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of String(text).match(URL_RE) || []) {
    const url = normalizeUrl(raw.replace(/[.,;:]+$/, ''))
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function sourceKindOf(name: string, url: string): EvidenceSource['kind'] {
  const n = (name || '').toLowerCase()
  if (n.includes('openalex')) return 'openalex'
  if (n.includes('crossref')) return 'crossref'
  if (n.includes('fetch') || n.includes('http') || n.includes('web')) return 'web'
  if (n.includes('file') || n.includes('read')) return 'file'
  if (n.includes('kb') || n.includes('knowledge') || n.includes('search')) return 'kb'
  if (n.includes('mcp')) return 'mcp'
  if (url.includes('doi.org')) return 'doi'
  return 'tool'
}

function callSources(call: BatchRowTraceCall): EvidenceSource[] {
  const name = String(call.name || '')
  const args = String(call.args || '')
  const result = String(call.result || '')
  const urls = [...new Set([...extractUrls(args), ...extractUrls(result)])].slice(0, 3)
  const quote = result.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (urls.length) {
    return urls.map((url) => ({
      kind: sourceKindOf(name, url),
      locator: url,
      label: name,
      quote,
      toolCallId: call.callId,
    }))
  }
  // 没有 URL 的工具（本地文件 / KB / MCP）：仍然记录一个来源，便于审计
  if (name) {
    return [{
      kind: sourceKindOf(name, ''),
      locator: name,
      label: name,
      quote,
      toolCallId: call.callId,
    }]
  }
  return []
}

function outputText(row: PipelineUnit): string {
  if (row.result && String(row.result).trim()) return String(row.result).trim()
  if (Array.isArray(row.extracted) && row.extracted.length) {
    try { return JSON.stringify(row.extracted[0]) } catch { return '' }
  }
  if (row.values && Object.keys(row.values).length) {
    try { return JSON.stringify(row.values) } catch { return '' }
  }
  return ''
}

/** 诊断证据状态（generic 默认策略；领域 profile 可覆盖） */
export function diagnoseEvidence(row: PipelineUnit, sources: EvidenceSource[]): EvidenceState {
  const hasOutput = Boolean(outputText(row))
  if (!hasOutput) return 'incomplete'
  const calls = (row.trace || []).flatMap((s) => s.toolCalls || [])
  const failed = calls.filter((c) => String(c.status || '').toLowerCase() === 'error')
  // 纯生成任务：没有工具、没有错误、没有外部来源 → 不适用证据评估
  if (!calls.length && !sources.length) return 'out_of_scope'
  if (failed.length && !sources.length) return 'incomplete'
  if (!sources.length) return 'incomplete'
  // generic 不做语义冲突判断；有来源且输出存在 → sufficient
  return 'sufficient'
}

/** 建议动作（v1 只记录；runner 的 attempt 层负责执行 retrieve/switch） */
export function chooseEvidenceAction(state: EvidenceState): EpistemicAction {
  if (state === 'sufficient' || state === 'out_of_scope') return 'answer'
  if (state === 'incomplete') return 'retrieve_more'
  if (state === 'stale') return 'retrieve_more'
  if (state === 'conflicting' || state === 'ambiguous') return 'ask_human'
  return 'abstain'
}

export function buildEvidence(row: PipelineUnit): EvidenceDecision {
  const calls = (row.trace || []).flatMap((s) => s.toolCalls || [])
  const seen = new Set<string>()
  const sources: EvidenceSource[] = []
  for (const call of calls) {
    for (const src of callSources(call)) {
      const key = `${src.kind}|${src.locator}`
      if (seen.has(key)) continue
      seen.add(key)
      sources.push({ ...src, retrievedAt: row.finishedAt || row.startedAt })
    }
    if (sources.length >= 12) break
  }
  const state = diagnoseEvidence(row, sources)
  const action = chooseEvidenceAction(state)
  const answer = outputText(row).slice(0, 500)
  const rationale = state === 'out_of_scope'
    ? 'No external evidence is applicable to this task.'
    : state === 'sufficient'
      ? `${sources.length} source(s) recorded; output is traceable to tool calls.`
      : state === 'incomplete'
        ? 'Output exists but no usable source/quote was captured.'
        : `${sources.length} source(s); the evidence needs review.`
  return {
    state,
    action,
    answer: answer || undefined,
    rationale,
    sources,
    generatedAt: new Date().toISOString(),
  }
}
