/**
 * legacy.ts — 旧脚手架任务文件（.task）→ Agent脚手架 状态 的兼容转换
 *
 * Agent脚手架 收敛旧脚手架（批量智能体 / 表格定向推理 / 文件采集 / 链接采集）后，
 * 「读取任务状态」可能打开旧格式文件——本模块把旧状态归一化为本模块的形状：
 *   · batch     ：config + results，与本模块同构，仅补 preset / 运行维度
 *   · tabreason ：config（targetColumns…）+ results（每行 values 写回值）
 *   · file      ：taskConfig + settings + dataSchema + files + collectedData
 *   · collector ：taskConfig + settings + dataSchema + sources + collectedData（+ graphData 反推父子）
 * 转换结果仍交给 PipelineScaffold.applyTaskState 继续处理（units / dataset / config…）。
 */

import { defaultPipelineConfig } from './presets'
import type { PipelineConfig, PipelineSchemaField } from './types'

/** 旧 SchemaField（CollectFile / CollectWeb）→ 本模块字段定义（同构，仅补 id） */
const normalizeSchema = (arr: any): PipelineSchemaField[] =>
  (Array.isArray(arr) ? arr : []).map((f: any) => ({
    id: String(f?.id || `field_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    name: String(f?.name || ''),
    type: String(f?.type || 'text'),
    description: String(f?.description || ''),
    isPrimaryKey: f?.isPrimaryKey === true,
    primaryKeyRegex: String(f?.primaryKeyRegex || ''),
    required: f?.required === true,
  }))

/** 旧行/文件状态 → 本模块行状态（处理中断的退为待处理，保持可续跑） */
const mapStatus = (s: any): string => {
  const v = String(s || '').toLowerCase()
  if (v === 'completed') return 'completed'
  if (v === 'failed') return 'failed'
  if (v === 'skipped') return 'skipped'
  return 'pending' // pending / processing / running / 未知
}

/** 逗号（中英）/分号 / 空白分隔的列表文本 → 数组（旧设置里 extensions 等为字符串） */
const asList = (v: any): string[] =>
  Array.isArray(v)
    ? v.map(String).map(s => s.trim()).filter(Boolean)
    : String(v || '').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean)

export interface LegacyNormalizeResult {
  /** 归一化后的状态（未识别时原样返回） */
  state: any
  /** 识别出的旧脚手架 key（'' = 未识别/无需转换） */
  migratedFrom: string
}

/**
 * 把旧脚手架任务文件状态归一化为本模块状态（不修改入参）。
 * 仅对「确认为旧格式」的状态做转换：显式 scaffold 标记，或（无标记时）按特征键推断。
 */
export function normalizeLegacyState(raw: any): LegacyNormalizeResult {
  if (!raw || typeof raw !== 'object') return { state: raw, migratedFrom: '' }
  const scaffold = String(raw.scaffold || '')
  if (scaffold === 'pipeline') return { state: raw, migratedFrom: '' }

  // ---- 表格定向推理（tabreason）：config + results（每行 values 写回值） ----
  if (scaffold === 'tabreason' || (!scaffold && raw.config && (raw.config.targetColumns || raw.config.exportColumns))) {
    const cfg: Record<string, any> = { ...(raw.config || {}) }
    // 旧导出勾选字段（exportColumns / sourceExportColumns）不再使用，避免回写进任务文件
    delete cfg.exportColumns
    delete cfg.sourceExportColumns
    cfg.preset = 'tabreason'
    cfg.sourceKind = cfg.sourceKind || 'table'
    // 统一后「表格定向推理」= 结构化提取（结果进数据表、导出为新表，不再写回原表）
    cfg.executorKind = 'extract'
    cfg.sinkKind = 'dataRows'
    if (cfg.autoSaveHours === undefined) cfg.autoSaveHours = 2
    return { state: { ...raw, config: cfg }, migratedFrom: 'tabreason' }
  }

  // ---- 批量智能体（batch）：config + results，与本模块同构 ----
  if (scaffold === 'batch' || (!scaffold && raw.config)) {
    const cfg: Record<string, any> = { ...(raw.config || {}) }
    if (!cfg.preset) cfg.preset = 'batch'
    return { state: { ...raw, config: cfg }, migratedFrom: 'batch' }
  }

  // ---- 文件采集（file）：taskConfig + settings + files + collectedData ----
  if (scaffold === 'file' || (!scaffold && raw.taskConfig && raw.files)) {
    const tc: any = raw.taskConfig || {}
    const st: any = raw.settings || {}
    const config: PipelineConfig = {
      ...defaultPipelineConfig('file'),
      sourceKind: 'folder',
      folderPath: String(st.folderPath || ''),
      extensions: asList(st.extensions),
      excludeDirs: asList(st.excludeDirs),
      maxFiles: Number(st.maxFiles) || 5000,
      maxContentPerFile: Number(st.maxContentPerFile) || 8000,
      concurrency: Number(st.concurrency) || 3,
      goal: String(tc.goal || ''),
      schema: normalizeSchema(raw.dataSchema),
      contentSource: 'file',
    }
    const units = (Array.isArray(raw.files) ? raw.files : []).map((f: any) => ({
      data: {
        relativePath: String(f?.relativePath || ''),
        fileName: String(f?.fileName || ''),
        filePath: String(f?.filePath || ''),
        extension: String(f?.extension || ''),
        size: f?.size ?? 0,
      },
      status: mapStatus(f?.status),
      error: f?.error,
    }))
    const dataset = (Array.isArray(raw.collectedData) ? raw.collectedData : []).map((c: any) => ({
      ...(c?.data && typeof c.data === 'object' ? c.data : {}),
      _source: String(c?.filePath || ''),
    }))
    return { state: { ...raw, config, units, dataset, results: undefined }, migratedFrom: 'file' }
  }

  // ---- 链接采集（collector）：taskConfig + settings + sources + collectedData（+ graphData 反推父子） ----
  if (scaffold === 'collector' || (!scaffold && raw.taskConfig && (raw.sources || raw.graphData))) {
    const tc: any = raw.taskConfig || {}
    const st: any = raw.settings || {}
    const sources: any[] = Array.isArray(raw.sources) ? raw.sources : []
    const urlOf = new Map<string, string>(sources.map((s: any) => [String(s?.id || ''), String(s?.url || s?.filePath || '')]))
    // 旧 graphData 的边（父节点 → 子节点）反推出每行的父链接（新模块的爬取轨迹按 parentUrl 投影）
    const nodeMap = new Map<string, any>((Array.isArray(raw.graphData?.nodes) ? raw.graphData.nodes : []).map((n: any) => [String(n?.id || ''), n]))
    const parentUrl = new Map<string, string>()
    for (const e of (Array.isArray(raw.graphData?.edges) ? raw.graphData.edges : [])) {
      const from = nodeMap.get(String(e?.source || ''))?.sourceId
      const to = nodeMap.get(String(e?.target || ''))?.sourceId
      if (from && to && urlOf.get(String(from))) parentUrl.set(String(to), urlOf.get(String(from)) || '')
    }
    const config: PipelineConfig = {
      ...defaultPipelineConfig('collector'),
      sourceKind: 'text',
      textFieldName: 'url',
      textInput: sources.map((s: any) => String(s?.url || s?.filePath || '')).filter(Boolean).join('\n').slice(0, 400000),
      contentSource: 'url',
      goal: String(tc.goal || ''),
      urlMaxDepth: Number(tc.maxDepth) || 0,
      urlMaxPages: Number(tc.maxPages) || 50,
      urlFollow: st.linkKeywords ? 'keyword' : 'all',
      urlKeywords: String(st.linkKeywords || ''),
      urlBody: st.linkAnalysisMode ? 'links' : 'text',
      maxContentPerFile: Number(st.maxContentPerBatch) || 8000,
      concurrency: Number(st.concurrency) || 3,
      schema: normalizeSchema(raw.dataSchema),
    }
    const units = sources.map((s: any) => ({
      data: { url: String(s?.url || s?.filePath || ''), title: String(s?.note || '') },
      depth: Number(s?.depth) || 0,
      parentUrl: parentUrl.get(String(s?.id || '')) || '',
      status: mapStatus(s?.status),
      error: s?.error,
    }))
    const dataset = (Array.isArray(raw.collectedData) ? raw.collectedData : []).map((c: any) => ({
      ...(c?.data && typeof c.data === 'object' ? c.data : {}),
      _source: String(c?.sourceUrl || (c?.sourceId ? urlOf.get(String(c.sourceId)) : '') || ''),
    }))
    return { state: { ...raw, config, units, dataset, results: undefined }, migratedFrom: 'collector' }
  }

  return { state: raw, migratedFrom: '' }
}
