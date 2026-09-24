/**
 * src/lib/taskFile.ts — Agent脚手架任务文件（.task）通用工具
 *
 * 无状态纯函数集：扩展名判定 + 任务文件包装 + 从文件内容（或其头部片段）识别任务所属脚手架。
 *
 * 文件格式（v2，所有脚手架统一）：
 *   { "version": 2, "scaffold": "<脚手架 key>", "savedAt": "<ISO>", ...各脚手架自己的状态字段 }
 * 新建实例**不再**自动落盘占位文件（首次「保存」时才选择路径）：`emptyTaskFileContent` 仍供数据画布等
 * 创建占位文件，`isEmptyTaskFile` 用于识别旧占位文件（自动加载时跳过，避免覆盖当前状态）。
 *
 * 兼容：v1 旧文件没有 `scaffold` 字段，按各脚手架状态对象的特征键推断（detectTaskScaffold ② 段）。
 * 供 store（打开 .task 时识别并跳转实例）与各脚手架组件共享。
 */

/** 可保存 .task 任务的脚手架 key。
 *  注意：'canvas' 已独立为顶层主面板；'batch' / 'file' / 'collector' / 'tabreason' 已并入「Agent脚手架」
 *  （见 MERGED_SCAFFOLD_KEYS）——它们不再是 Agent脚手架，但 .task 仍可识别，
 *  打开时由 store.openTaskFileByPath 路由（canvas → 数据画布面板；其余 → pipeline 并自动转换）。 */
export const TASK_SCAFFOLD_KEYS = ['collector', 'file', 'batch', 'tabreason', 'canvas', 'pipeline'] as const

/** 已并入「Agent脚手架」的旧脚手架 key（2026-09-21 收尾）：其 .task 由 pipeline 打开并自动转换配置 */
export const MERGED_SCAFFOLD_KEYS = ['batch', 'file', 'collector', 'tabreason'] as const

/** 已并入脚手架的显示名（打开旧任务文件时的提示文案用） */
export const MERGED_SCAFFOLD_LABELS: Record<string, { labelZh: string; labelEn: string }> = {
    batch: { labelZh: '批量智能体运行', labelEn: 'Batch Agent' },
    file: { labelZh: '文件采集表格', labelEn: 'Collect File' },
    collector: { labelZh: '链接采集表格', labelEn: 'Collect Web' },
    tabreason: { labelZh: '表格定向推理', labelEn: 'Table Reasoning' },
}

/**
 * 已下线的脚手架 key：其 .task 文件仍可被识别，但不再有对应实例类型。
 * 打开时给出明确提示（例：agent = 程序化工具调用，已迁移为主页 PTC 模式）。
 */
export const RETIRED_TASK_SCAFFOLDS = ['agent'] as const
export type RetiredTaskScaffoldKey = typeof RETIRED_TASK_SCAFFOLDS[number]

/** 已下线脚手架的显示名（提示文案用） */
export const RETIRED_SCAFFOLD_LABELS: Record<string, { labelZh: string; labelEn: string }> = {
    agent: { labelZh: '程序化工具调用', labelEn: 'Programmatic Tool Call' },
}

export type TaskScaffoldKey = typeof TASK_SCAFFOLD_KEYS[number]

/** 当前任务文件格式版本 */
export const TASK_FILE_VERSION = 2

/** 是否为脚手架任务文件（按扩展名） */
export function isTaskFile(path?: string | null): boolean {
    return String(path || '').toLowerCase().endsWith('.task')
}

/** 是否为已知脚手架 key */
export function isTaskScaffoldKey(key?: string | null): key is TaskScaffoldKey {
    return !!key && (TASK_SCAFFOLD_KEYS as readonly string[]).includes(key)
}

/** 是否为已下线脚手架 key */
export function isRetiredTaskScaffold(key?: string | null): key is RetiredTaskScaffoldKey {
    return !!key && (RETIRED_TASK_SCAFFOLDS as readonly string[]).includes(key)
}

/**
 * 包装任务文件对象：统一写入版本 + 所属脚手架 + 保存时间。
 * payload 为各脚手架自己的状态字段（放在 spread 之后，避免其覆盖三个元字段）。
 */
export function wrapTaskFile(scaffold: string, payload: Record<string, any>): Record<string, any> {
    return { ...payload, version: TASK_FILE_VERSION, scaffold, savedAt: new Date().toISOString() }
}

/** 新建实例的占位任务文件内容（尚未写入任何状态；自动加载时会被跳过，避免覆盖当前状态） */
export function emptyTaskFileContent(scaffold: string): string {
    return JSON.stringify({ version: TASK_FILE_VERSION, scaffold, savedAt: new Date().toISOString(), empty: true }, null, 2)
}

/** 判断任务文件内容是否为「占位空文件」（新建实例时创建，尚无状态）。传入可以是完整内容或头部片段 */
export function isEmptyTaskFile(text?: string | null): boolean {
    return /"empty"\s*:\s*true/.test(String(text || ''))
}

/** 识别 .task 内容所属脚手架；无法识别时返回 null。
 *  传入内容可以是完整文件或仅文件头部片段（键名均位于 JSON 开头部分）。 */
export function detectTaskScaffold(text?: string | null): string | null {
    const s = String(text || '')
    if (!s) return null

    // ① 首选显式标记（v2 起所有脚手架保存时写入）
    const marked = s.match(/"scaffold"\s*:\s*"([a-zA-Z]+)"/)
    if (marked) {
        if (isTaskScaffoldKey(marked[1])) return marked[1]
        // 显式标记但不是在册脚手架（如已下线的 agent）→ 由 detectRetiredTaskScaffold 单独识别并提示
        return null
    }

    const hasKey = (key: string) => s.includes(`"${key}"`)

    // ② 旧文件（v1，无 scaffold 标记）：按各脚手架状态对象的特征键推断
    // 数据画布：models + activeModelId（.task 化之前的 .data 内容同构）
    if (hasKey('activeModelId') || (hasKey('models') && hasKey('data'))) return 'canvas'
    // 注意：程序化工具调用（type: 'agent-task' / requirementInput）为已下线脚手架，见 detectRetiredTaskScaffold
    // 链接采集 / 文件采集：均为 taskConfig + dataSchema，用 files / graphData·cachedPages 区分
    if (hasKey('taskConfig')) {
        if (hasKey('graphData') || hasKey('cachedPages') || hasKey('sources')) return 'collector'
        if (hasKey('files')) return 'file'
    }
    // 表格定向推理 / 批量智能体执行：均为 config + results，用 targetColumns / maxSteps·template 区分
    if (hasKey('config')) {
        if (hasKey('targetColumns') || hasKey('exportColumns')) return 'tabreason'
        if (hasKey('maxSteps') || hasKey('template') || hasKey('resultField')) return 'batch'
    }
    // 兜底（仅有单一标志键的残缺文件）
    if (hasKey('models')) return 'canvas'
    if (hasKey('sources')) return 'collector'
    if (hasKey('files')) return 'file'
    return null
}

/** 识别是否为「已下线脚手架」的任务文件（v2 显式标记，或 v1 特征键——如 PTC 的 type:'agent-task' / requirementInput）；
 *  用于打开旧 .task 时给出明确提示（不再创建实例）。无法识别时返回 null。 */
export function detectRetiredTaskScaffold(text?: string | null): RetiredTaskScaffoldKey | null {
    const s = String(text || '')
    if (!s) return null
    const marked = s.match(/"scaffold"\s*:\s*"([a-zA-Z]+)"/)
    if (marked && isRetiredTaskScaffold(marked[1])) return marked[1]
    if (/"type"\s*:\s*"agent-task"/.test(s) || s.includes('"requirementInput"')) return 'agent'
    return null
}
