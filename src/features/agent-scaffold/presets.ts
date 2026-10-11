/**
 * presets.ts — 内置预设（Step 2 接入）
 *
 * 一个预设 = 一种「源 （Source）× 执行器（Executor）× 汇聚（Sink）」组合，
 * 即一个旧脚手架的迁移目标（batch / tabreason / file / collector 均已接入；
 * collector 为 v1：未含 LLM 相关性筛链接与提取结果 URL 臆造修复，见设计文档“差异清单”）。
 * 新建任务时用预设的 defaultConfig 生成初始配置；旧任务文件无 preset 字段时按 batch 处理。
 *
 * 约束（对照移植）：batch 预设的 defaultConfig 必须与 UI 平移版默认值逐字段一致，保证行为对等。
 */

import { DEFAULT_AGENT_MAX_STEPS } from '@/shared/agent-loop-rounds'
import type { PipelineConfig, PipelinePreset } from './types'

/** 内置预设注册表（key 与脚手架 key 一致） */
export const PIPELINE_PRESETS: Record<string, PipelinePreset> = {
    batch: {
        key: 'batch',
        labelZh: '批量智能体运行',
        labelEn: 'Batch Agent',
        source: 'table',
        executor: 'agent',
        sink: 'resultColumn',
        // 与 PipelineScaffold 平移版 config 初始值逐字段一致
        defaultConfig: (zh = true) => ({
            preset: 'batch',
            executorKind: 'agent',
            sinkKind: 'resultColumn',
            presetId: '',
            template: '',
            concurrency: 5,
            maxSteps: DEFAULT_AGENT_MAX_STEPS,
            retry: 0,
            // 结果列列名：按界面语言生成（英文界面用 result，不再出现中文表头）
            resultField: zh ? '结果' : 'result',
            keepUnmatched: false,
            toolsOverride: '',
            llmType: '',
            model: '',
            emptyAction: '',
            emptyReplaceText: '',
            emptyRetryLimit: 3,
            staggerMs: 300,
            autoSaveHours: 2,
            // 图谱默认开启（可在任务页「执行与配置」里关闭：不投影、不显示图谱标签页）
            graphEnabled: true,
            // 保存任务文件时默认不保留图谱数据 / 运行日志（勾选后才写进文件，见任务页「随任务文件保留」）
            keepTrace: false,
            keepLogs: false,
        }),
    },
    tabreason: {
        key: 'tabreason',
        labelZh: '表格定向推理',
        labelEn: 'Table Reasoning',
        source: 'table',
        // 统一后 = 结构化提取（输出字段 = 原「目标列」；结果进数据表、导出为新表）
        executor: 'extract',
        sink: 'dataRows',
        // 完整字段（输出字段 schema / structured）在接入 llm 执行器时补充
        defaultConfig: () => ({
            preset: 'tabreason',
            executorKind: 'extract',
            sinkKind: 'dataRows',
            concurrency: 5,
            retry: 0,
            autoSaveHours: 2,
        }),
    },
    file: {
        key: 'file',
        labelZh: '文件采集表格',
        labelEn: 'Collect File',
        source: 'folder',
        executor: 'extract',
        sink: 'dataRows',
        // 完整字段（folderPath / extensions / schema…）在接入 folder 源时补充
        defaultConfig: () => ({
            preset: 'file',
            executorKind: 'extract',
            sinkKind: 'dataRows',
            concurrency: 3,
            retry: 0,
            autoSaveHours: 2,
        }),
    },
    collector: {
        key: 'collector',
        labelZh: '链接采集表格',
        labelEn: 'Collect Web',
        source: 'text',
        executor: 'extract',
        sink: 'dataRows',
        // 链接采集 = 文本源（每行一个网址）+ 内容获取=抓取网页；默认同域跟随、深度 1、最多 50 页
        defaultConfig: () => ({
            preset: 'collector',
            sourceKind: 'text',
            textFieldName: 'url',
            contentSource: 'url',
            executorKind: 'extract',
            sinkKind: 'dataRows',
            concurrency: 3,
            retry: 0,
            autoSaveHours: 2,
            textInput: '',
            urlMaxDepth: 1,
            urlMaxPages: 50,
            urlFollow: 'same-host',
            urlKeywords: '',
            urlBody: 'text',
            maxContentPerFile: 8000,
        }),
    },
}

/** 按脚手架 key 取预设（未知 key 返回 undefined） */
export function pipelinePreset(key?: string): PipelinePreset | undefined {
    return key ? PIPELINE_PRESETS[key] : undefined
}

/**
 * 生成新建任务的初始配置：预设默认值 + batch 兜底（保证所有字段有值）。
 * @param presetKey 脚手架 key（batch / tabreason / file / collector）；未知 / 缺省 → batch
 * @param zh 界面语言（false = 英文：结果列默认名为 result）
 */
export function defaultPipelineConfig(presetKey?: string, zh = true): PipelineConfig {
    const fallback = PIPELINE_PRESETS.batch.defaultConfig(zh) as PipelineConfig
    const preset = pipelinePreset(presetKey)
    if (!preset || preset.key === 'batch') return { ...fallback }
    return { ...fallback, ...preset.defaultConfig(zh) }
}
