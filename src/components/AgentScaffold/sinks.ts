/**
 * sinks.ts — 结果汇聚器（Step 2 尾段）
 *   resultColumn：单值 → unit.result（批量智能体：结果写入指定列名）
 *   writeBack：  多值 → unit.data[列名]（表格定向推理：写回原表新列）
 * 约定：runner 统一负责状态迁移与空内容策略，汇聚器只做“结果是否有内容”的判定与落盘。
 */
import type { PipelineSchemaField, PipelineSink, PipelineUnit } from './types'

/** 单值结果列（batch 对等） */
export const resultColumnSink: PipelineSink = {
  kind: 'resultColumn',
  hasContent: (o) => Boolean(String(o.result || '').trim()),
  apply: (unit, o) => { if (o.result !== undefined) unit.result = o.result },
  applyEmptyText: (unit, text) => { unit.result = text },
}

/** 写回原表多列（tabreason 对等；空内容由各列自身决定，无“整体替换文本”语义） */
export const writeBackSink: PipelineSink = {
  kind: 'writeBack',
  hasContent: (o) => Object.values(o.values || {}).some((v) => String(v || '').trim() !== ''),
  apply: (unit, o) => {
    for (const [k, v] of Object.entries(o.values || {})) unit.data[k] = v
  },
}

/** 按 kind 取汇聚器（缺省 resultColumn） */
export function sinkOf(kind?: string): PipelineSink {
  return kind === 'writeBack' ? writeBackSink : resultColumnSink
}

// ==================== dataRows 汇聚（extract 执行器产物 → 数据集；CollectFile 对等） ====================
/** 字段名规范化：转小写、去空格、去下划线/连字符/括号/冒号等干扰字符 */
function normalizeFieldName(s: string): string {
  return String(s).toLowerCase().replace(/[\s_\-()（）\[\]：:：.。\/]/g, '').trim()
}

/** 按字段名取值（精确 → 忽略大小写/符号 → 包含匹配），与 CollectFile.getFieldValue 同构 */
function getFieldValue(data: Record<string, any>, fieldName: string): any {
  if (data[fieldName] !== undefined && data[fieldName] !== null) return data[fieldName]
  const lower = normalizeFieldName(fieldName)
  for (const key of Object.keys(data)) {
    if (normalizeFieldName(key) === lower) return data[key]
  }
  // 兜底：包含匹配（如 LLM 返回 "来源链接" 而字段是 "源链接"）
  for (const key of Object.keys(data)) {
    const k = normalizeFieldName(key)
    if (k.includes(lower) || lower.includes(k)) return data[key]
  }
  return undefined
}

/** 按 schema 对齐字段（缺失填空串；对象转 JSON 字符串避免显示成 [object Object]），与 CollectFile.alignData 同构 */
export function alignToSchema(raw: Record<string, any>, schema: PipelineSchemaField[]): Record<string, any> {
  const aligned: Record<string, any> = {}
  for (const field of schema) {
    const v = getFieldValue(raw, field.name)
    if (v === undefined || v === null) aligned[field.name] = ''
    else if (typeof v === 'object') aligned[field.name] = JSON.stringify(v)
    else aligned[field.name] = v
  }
  return aligned
}

/** dataRows 汇聚器依赖（数据集由 runner 持有；对齐/主键合并在此完成） */
export interface DataRowsSinkDeps {
  /** 提取字段定义（对齐 + 主键判定） */
  schema: () => PipelineSchemaField[] | undefined
  /** 数据集访问（runner 持有的数组，就地增改） */
  getData: () => Array<Record<string, any>>
  /** 数据变更通知（runner 转发 onDatasetUpdate） */
  notify: () => void
  /** 线程日志（可选） */
  log?: (level: string, message: string) => void
  /** 来源列取值（可选）：文本/链接源返回行内取值字段（url/text）；返回空串则回退到文件路径链 */
  sourceOf?: (unit: PipelineUnit) => string
  /** 行号（1 起；可选）：写进数据集记录 `_rowNo`，导出时按「产生该条数据的任务行」合并原表列 / 运行信息 */
  rowNoOf?: (unit: PipelineUnit) => number
  /** 重跑结果策略（可选；缺省 replace）：'replace' = 重跑时先清掉本行上次的记录 */
  rerunMode?: () => ('replace' | 'merge' | undefined)
}

/**
 * dataRows 汇聚：把提取出的多条数据按主键合并进数据集（CollectFile.collectExtracted 的本地部分）。
 * 与旧实现差异（v1）：主键冲突且字段有差异时，直接以非空新值覆盖对应字段（旧实现会再调一次 LLM 合并）；
 * 必填字段补全（completeRequiredFields）暂未移植。每条数据附带 `_source`（来源文件相对路径）
 * 与 `_rowNo`（产生该条数据的任务行号，1 起——导出时据此合并原表列 / 运行信息）。
 */
export function makeDataRowsSink(deps: DataRowsSinkDeps): PipelineSink {
  const log = deps.log || (() => {})
  return {
    kind: 'dataRows',
    hasContent: (o) => (o.rows || []).length > 0,
    /**
     * 重跑前置（rerunResultMode='replace'）：把该任务行上次产出的记录从数据集里删掉，
     * 使「重跑 = 替换」而不是越跑越多。只在本次结果落盘前调用，跑失败时旧结果保留。
     */
    resetRow: (unit) => {
      if ((deps.rerunMode?.() || 'replace') !== 'replace') return
      const rowNo = Number(deps.rowNoOf?.(unit) || 0) || 0
      if (rowNo <= 0) return
      const data = deps.getData()
      let removed = 0
      for (let i = data.length - 1; i >= 0; i--) {
        if ((Number(data[i]?._rowNo) || 0) !== rowNo) continue
        data.splice(i, 1)
        removed++
      }
      if (removed) {
        log('info', `重跑：已清除该行上次的 ${removed} 条结果（replace）`)
        deps.notify()
      }
    },
    apply: (unit, o) => {
      const schema = deps.schema() || []
      const pkField = schema.find(f => f.isPrimaryKey)
      const data = deps.getData()
      const rowNo = Number(deps.rowNoOf?.(unit) || 0) || 0
      const source = String(
        deps.sourceOf?.(unit) || unit.data?.relativePath || unit.data?.fileName || unit.data?.filePath || unit.data?.url || '',
      )
      let changed = false
      // 本行提取出的记录（对齐后；写入数据集的对象本身，合并时会同步更新）——挂到行上供详情表展示
      const mine: Array<Record<string, any>> = []
      for (const raw of o.rows || []) {
        const extracted = alignToSchema(raw, schema)
        // 主键匹配（支持 primaryKeyRegex；新旧都取正则命中片段比较）
        if (pkField) {
          const pkValue = extracted[pkField.name]
          const pkRegex = pkField.primaryKeyRegex ? new RegExp(pkField.primaryKeyRegex) : null
          const existing = pkValue
            ? data.find(d => {
                const oldPk = d[pkField.name]
                if (!oldPk) return false
                if (pkRegex) {
                  const mNew = String(pkValue).match(pkRegex)
                  const mOld = String(oldPk).match(pkRegex)
                  return !!(mNew && mOld && mNew[0] === mOld[0])
                }
                return String(oldPk).trim() === String(pkValue).trim()
              })
            : undefined
          if (existing) {
            // 完全相同 → 跳过；有差异 → 非空新值覆盖对应字段（v1：不做 LLM 合并）
            let isIdentical = true
            for (const f of schema) {
              if (String(existing[f.name] ?? '').trim() !== String(extracted[f.name] ?? '').trim()) { isIdentical = false; break }
            }
            if (isIdentical) {
              log('info', `跳过合并(数据完全相同): ${pkField.name}=${pkValue}`)
            } else {
              for (const [k, v] of Object.entries(extracted)) {
                if (String(v ?? '').trim()) existing[k] = v
              }
              if (source && existing._source !== source) {
                existing._source = existing._source ? `${existing._source}; ${source}` : source
              }
              changed = true
              log('info', `合并重复记录(主键: ${pkField.name}=${pkValue})，字段已更新`)
            }
            mine.push(existing)
            continue
          }
          if (!pkValue || String(pkValue).trim() === '') {
            log('warning', `主键 ${pkField.name} 为空，跳过该条数据: ${JSON.stringify(extracted).substring(0, 80)}`)
            continue
          }
        }
        const record: Record<string, any> = { ...extracted, _source: source }
        if (rowNo > 0) record._rowNo = rowNo
        data.push(record)
        mine.push(record)
        changed = true
        log('info', `提取数据: ${JSON.stringify(extracted).substring(0, 100)}...`)
      }
      // 本行的提取结果挂到行上（再次运行会整体替换；详情表 / 行详情弹层按字段展示）
      unit.extracted = mine
      if (changed) deps.notify()
    },
  }
}
