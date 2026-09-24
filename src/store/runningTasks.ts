// src/store/runningTasks.ts
// 模块级「后台运行任务」登记表（非 pinia，单一事实源，供任意组件上报 / 任意组件读取）
//
// 背景：Agent脚手架实例（批量运行 / 采集 / 推理…）的运行标志是**组件内部 ref**，
// 且组件被 AgentScaffold 的 KeepAlive 缓存 —— 切换到别的脚手架或别的主面板后任务仍在后台跑，
// 但 App.vue 拿不到这些内部状态。关闭按钮因此无法判断「后台是否还有任务」，
// 误点关闭会直接杀掉正在跑的任务。
//
// 用法（组件内）：
//   watch(isRunning, (v) => reportInstanceRunning(instanceId, v))
// 只登记「脚手架」实例，聊天智能体 / 工作流 / 集群的运行态由各自的模块级 ref 直接读取。
//
// 实例化（多开）后：登记 key = `scaffold:<实例 id>`（如 scaffold:batch:1a2b），
// 脚手架组件由宿主 AgentScaffold 通过 props.instanceId 拿到自己的 id；
// 未接入实例的旧脚手架传脚手架 key（scaffold:<key>）仍兼容。

import { ref, computed } from 'vue'

export interface RunningTaskInfo {
  /** 登记键（如 `scaffold:batch:1a2b`）——供宿主把它映射回实例（取实例标题） */
  id?: string
  /** 归属类型：脚手架 / 聊天智能体 / 工作流 / 集群 */
  kind: 'scaffold' | 'agent' | 'workflow' | 'cluster' | 'other'
  labelZh: string
  labelEn: string
  /** 进度与预计剩余时间（可选：脚手架运行时每秒上报，供托盘悬停提示显示「剩余时间」） */
  progress?: RunningTaskProgress
}

/** 运行进度（done/total + 预计剩余毫秒，etaMs = null 表示尚在估算） */
export interface RunningTaskProgress {
  done: number
  total: number
  etaMs: number | null
}

/** 脚手架 key → 名称（与 store/index.ts 的 SCAFFOLDS 文案保持一致，供关闭提醒展示）
 *  注：'canvas' 已独立为顶层主面板，其余四个旧 key 已并入 Agent脚手架 且不再登记脚手架运行态；
 *  当前仅 pipeline 在列，旧 key 出现时由调用方兜底显示原 key。 */
const SCAFFOLD_LABELS: Record<string, { labelZh: string; labelEn: string }> = {
  pipeline: { labelZh: 'Agent脚手架', labelEn: 'Agent Scaffold' },
}

// 登记表：id → 任务信息（同一 id 重复登记覆盖，保证幂等）
const registry = ref<Record<string, RunningTaskInfo>>({})

/** 登记 / 注销一个后台运行任务（info 传 null 表示该任务已结束） */
export function setRunningTask(id: string, info: RunningTaskInfo | null): void {
  if (!id) return
  if (info) {
    registry.value[id] = { ...info, id }
  } else if (registry.value[id]) {
    delete registry.value[id]
  }
}

/** 脚手架运行态上报（running=true 登记，false 注销）
 *  key 传「实例 id」（多开）或「脚手架 key」（旧用法，未接入实例的脚手架） */
export function reportScaffoldRunning(key: string, running: boolean, extra?: Partial<RunningTaskInfo>): void {
    const label = SCAFFOLD_LABELS[key] || { labelZh: key, labelEn: key }
    setRunningTask(`scaffold:${key}`, running
        ? { kind: 'scaffold', labelZh: label.labelZh, labelEn: label.labelEn, ...extra }
        : null)
}

/** 实例专属运行态上报（对齐 reportScaffoldRunning；实例 id 形如 `batch:1a2b`）
 *  标签优先取实例标题（extra.labelZh/En），否则按实例 id 前缀回退到脚手架名称 */
export function reportInstanceRunning(instanceId: string, running: boolean, extra?: Partial<RunningTaskInfo>): void {
    if (!instanceId) return
    const type = instanceId.split(':')[0]
    const label = SCAFFOLD_LABELS[type]
    setRunningTask(`scaffold:${instanceId}`, running
        ? {
            kind: 'scaffold',
            labelZh: extra?.labelZh || label?.labelZh || type,
            labelEn: extra?.labelEn || label?.labelEn || type,
            ...extra,
        }
        : null)
}

/** 指定实例是否正在后台运行（供导航栏状态点 / 关闭确认使用） */
export function isInstanceRunning(instanceId: string): boolean {
    return !!registry.value[`scaffold:${instanceId}`]
}

/**
 * 更新运行中实例的进度与预计剩余时间（脚手架计时器每秒调用）。
 * 未登记的实例直接忽略；数值与上次相同则不写，避免无意义的响应式刷新。
 */
export function reportInstanceProgress(key: string, done: number, total: number, etaMs: number | null): void {
    if (!key) return
    const id = `scaffold:${key}`
    const cur = registry.value[id]
    if (!cur) return
    const next = etaMs == null || !Number.isFinite(etaMs) ? null : Math.max(0, Math.round(etaMs))
    const p = cur.progress
    if (p && p.done === done && p.total === total && p.etaMs === next) return
    registry.value[id] = { ...cur, id, progress: { done, total, etaMs: next } }
}

/** 登记键 → 实例 id（`scaffold:batch:1a2b` → `batch:1a2b`；非脚手架登记返回空串） */
export function runningTaskInstanceId(info: RunningTaskInfo | undefined | null): string {
    const id = info?.id || ''
    return id.startsWith('scaffold:') ? id.slice('scaffold:'.length) : ''
}

// ==================== 实例任务状态（常驻上报，与「是否在跑」解耦） ====================
// 为什么单独一张表：running 登记只在运行期间存在，实例空闲时不留痕迹；
// 而实例栏需要按「这个实例现在有没有活可干」来决定显示 / 隐藏「开始」「暂停」按钮。
/**
 * 实例任务状态（脚手架常驻上报；变化时才写，避免无意义刷新）：
 * - pending > 0 = 有待处理的行（「开始」有用）
 * - canStart = 未在运行且有待处理行（= 实例栏显示「开始」的条件）
 */
export interface InstanceTaskState {
    /** 待处理行数（statusCounts.pending） */
    pending: number
    /** 正在执行的行数 */
    runningRows: number
    /** 总行数（未导入表格 / 未扫描文件夹时为 0） */
    rows: number
    /** 是否可开始（未运行且有可执行的行） */
    canStart: boolean
}
const instanceStates = ref<Record<string, InstanceTaskState>>({})

/** 上报实例任务状态（传 null = 实例已卸载 / 关闭，清除记录） */
export function reportInstanceState(instanceId: string, state: InstanceTaskState | null): void {
    if (!instanceId) return
    if (!state) {
        if (instanceStates.value[instanceId]) delete instanceStates.value[instanceId]
        return
    }
    const cur = instanceStates.value[instanceId]
    if (cur && cur.pending === state.pending && cur.runningRows === state.runningRows
        && cur.rows === state.rows && cur.canStart === state.canStart) return
    instanceStates.value[instanceId] = { ...state }
}

/** 读某实例的任务状态（响应式；从未上报过返回 null = 状态未知） */
export function instanceTaskState(instanceId: string): InstanceTaskState | null {
    return instanceStates.value[instanceId] || null
}

/** 当前正在运行的实例 id 集合（供导航栏批量判断） */
export function isAnyInstanceRunning(ids: string[]): boolean {
    return ids.some(id => isInstanceRunning(id))
}

/** 运行中的后台任务列表（响应式） */
export const runningTaskList = computed<RunningTaskInfo[]>(() => Object.values(registry.value))

/** 指定脚手架是否正在后台运行（供「打开 .task 覆盖当前状态」等场景提示用） */
export function isScaffoldRunning(key: string): boolean {
  return !!registry.value[`scaffold:${key}`]
}

/** 是否仍有后台任务在运行 */
export const hasRunningTask = computed<boolean>(() => runningTaskList.value.length > 0)

/** 按当前语言取任务名列表（去重，供提示文案拼接） */
export function runningTaskNames(locale: string): string[] {
  const en = locale === 'en'
  const names = runningTaskList.value.map((t) => (en ? t.labelEn : t.labelZh))
  return Array.from(new Set(names.filter(Boolean)))
}
