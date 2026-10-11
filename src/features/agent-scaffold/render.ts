/**
 * render.ts — 占位符引擎（agent 模板与 llm 列指令共用）
 *
 * 平移自 batchRunnerAgent.ts（renderTemplate / extractPlaceholders）。
 * Step 2 后续接入 llm 执行器时，在此补充 renderPrompt（= 未匹配清空 + trim 的变体）。
 */

import type { PipelineSchemaField } from './types'

// ==================== 占位符引擎 ====================
// 支持 {{列名}} 双花括号占位符；特殊占位符 {{rowIndex}} = 行号（1 起）
export function renderTemplate(template: string, data: Record<string, any>, rowIndex: number, keepUnmatched: boolean): string {
  if (!template) return ''
  let out = String(template)
  // 特殊占位符：行号
  out = out.split('{{rowIndex}}').join(String(rowIndex + 1))
  // 逐列替换（先长列名后短列名无关紧要，因为用 split/join 精确匹配完整键名）
  for (const [key, val] of Object.entries(data || {})) {
    if (val === null || val === undefined) continue
    out = out.split(`{{${key}}}`).join(String(val))
  }
  // 未匹配占位符：清空（{{xxx}} → ''）或保留原样
  if (!keepUnmatched) {
    out = out.replace(/\{\{([^{}]+)\}\}/g, '')
  }
  return out
}

/** 提取模板中引用的全部占位符名（含未匹配列） */
export function extractPlaceholders(template: string): string[] {
  if (!template) return []
  const re = /\{\{([^{}]+)\}\}/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    const name = m[1].trim()
    if (name && name !== 'rowIndex' && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 用行数据替换 {{列名}} 占位符；未匹配的占位符清空（llm 执行器的列指令用，语义同 TableReason.renderPrompt）。
 * 注：调用方可传入含 rowIndex 键的数据以支持 {{rowIndex}}。
 */
export function renderPrompt(template: string, data: Record<string, any>): string {
  if (!template) return ''
  let out = String(template)
  for (const [key, val] of Object.entries(data || {})) {
    if (val === null || val === undefined) continue
    out = out.split(`{{${key}}}`).join(String(val))
  }
  out = out.replace(/\{\{([^{}]+)\}\}/g, '')
  return out.trim()
}

// ==================== 结构化输出的提示词片段（extract / 智能体结构化输出共用） ====================
/** 字段清单文本（与 extract 原有格式逐字一致） */
export function schemaFieldList(schema: PipelineSchemaField[]): string {
  return schema.map(f => `- ${f.name}: ${f.description || f.type}${f.required ? '【必填，不允许留空】' : ''}`).join('\n')
}

/** 基于真实字段名生成示例 JSON（避免 LLM 自行翻译/改写字段名） */
export function schemaExampleJson(schema: PipelineSchemaField[]): string {
  const exampleObj: Record<string, any> = {}
  for (const f of schema) {
    exampleObj[f.name] = f.type === 'number' ? 0 : f.type === 'date' ? '2024-01-01' : ''
  }
  return JSON.stringify(exampleObj, null, 2)
}

/**
 * 结构化输出的收尾指令：附加在智能体任务指令之后，要求最后只输出 JSON（→ 解析后按字段合并进数据表）。
 */
export function buildStructuredOutputInstruction(schema: PipelineSchemaField[]): string {
  return `完成上述任务后，请只输出一个 JSON 对象（多条数据时输出 JSON 数组），不要包含任何其他文字或代码块标记。JSON 的键必须与下列字段名完全一致（包括大小写，禁止翻译或改写）:
${schemaFieldList(schema)}

返回格式示例:
${schemaExampleJson(schema)}`
}
