/**
 * parsers.ts — 模型输出解析工具
 * 平移自 TableReason/tableReasonAgent.ts 的 parseJsonObject（行为不变）。
 * 另含三级容错 JSON 解析 tryParseJson（原在 executors/extract.ts；extract 与「智能体结构化输出」共用）。
 */

/**
 * 从模型输出中提取 JSON 对象（容错：Markdown 代码块围栏 / 前后多余文字 / 单引号 / 纯文本 key: value）。
 * @param wanted 目标列名白名单（仅宽松兜底时使用，避免把源列内容误当结果）
 */
export function parseJsonObject(text: string, wanted?: string[]): Record<string, any> | null {
  if (!text) return null
  let s = String(text).trim()
  // 去掉 ```json ... ``` / ``` ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) s = fence[1].trim()

  const tryParse = (t: string): Record<string, any> | null => {
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, any>
      // 数组形态：[{...}] → 取首元素
      if (Array.isArray(o) && o.length && o[0] && typeof o[0] === 'object') return o[0] as Record<string, any>
      return null
    } catch { return null }
  }

  let obj = tryParse(s)
  if (obj) return obj
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i !== -1 && j > i) {
    obj = tryParse(s.slice(i, j + 1))
    if (obj) return obj
  }
  // 宽松兜底：逐行 "键": 值（仅收白名单列名）
  const names = (wanted || []).map((w) => String(w).trim()).filter(Boolean)
  if (!names.length) return null
  const out: Record<string, any> = {}
  const re = /["“]?([^"\n:：{}]+?)["”]?\s*[:：]\s*(?:"([^"]*)"|'([^']*)'|([^\n,]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const k = (m[1] || '').trim()
    if (!names.includes(k)) continue
    out[k] = String(m[2] ?? m[3] ?? m[4] ?? '').trim()
  }
  return Object.keys(out).length ? out : null
}

// ==================== 三级容错 JSON 解析（原在 executors/extract.ts，现共用） ====================
/** 提取完整 JSON 对象（支持嵌套，处理截断情况） */
export function extractJsonObjects(text: string): Array<Record<string, any>> {
  const results: Array<Record<string, any>> = []
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('{', i)
    if (start === -1) break
    let depth = 0
    let j = start
    let inString = false
    let stringChar = ''
    while (j < text.length) {
      const ch = text[j]
      if (inString) {
        if (ch === '\\') { j += 2; continue }
        if (ch === stringChar) inString = false
      } else {
        if (ch === '"' || ch === "'") { inString = true; stringChar = ch }
        else if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) break }
      }
      j++
    }
    if (depth !== 0) break
    const objStr = text.substring(start, j + 1)
    try {
      const obj = JSON.parse(objStr)
      if (typeof obj === 'object' && obj !== null && Object.keys(obj).length > 0) {
        results.push(obj)
      }
    } catch { /* 跳过无法解析的片段 */ }
    i = j + 1
  }
  return results
}

/** 三级容错解析：去围栏直解 → 数组切片 → 逐对象提取；失败返回 null */
export function tryParseJson(text: string): Array<Record<string, any>> | null {
  const clean = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(clean)
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.keys(parsed).length > 0 ? [parsed] : []
    }
  } catch { /* 非标准格式，继续尝试 */ }
  const arrayMatch = clean.match(/^\[[\s\S]*\]$/m)
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[0])
      if (Array.isArray(arr) && arr.length > 0) return arr
    } catch { /* 继续尝试 */ }
  }
  const objects = extractJsonObjects(clean)
  if (objects.length > 0) return objects
  return null
}
