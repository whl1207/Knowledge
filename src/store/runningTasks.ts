// src/store/runningTasks.ts
// 模块级「后台运行任务」登记表（非 pinia，单一事实源，供任意组件上报 / 任意组件读取）
//
// 背景：脚手架（.task 文件里的批量运行 / 采集 / 推理…）的运行标志是**组件内部 ref**，
// App.vue 拿不到这些内部状态：窗口关闭按钮与托盘提示因此无法判断「后台是否还有任务」，
// 误点关闭会直接杀掉正在跑的任务。
//
// 用法（组件内）：
//   watch(isRunning, (v) => reportInstanceRunning('pipeline', v))
// 只登记「脚手架」任务，聊天智能体 / 工作流 / 集群的运行态由各自的模块级 ref 直接读取。
//
// 登记 key = `scaffold:<脚手架 key>`（当前只有 scaffold:pipeline）。

import { ref, computed } from 'vue'

export interface RunningTaskInfo {
  /** 登记键（如 `scaffold:pipeline`） */
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

/** 脚手架 key → 名称（供关闭提醒 / 托盘提示展示）
 *  注：旧脚手架（批量 / 表格推理 / 文件采集 / 链接采集）的 .task 打开后会转成 pipeline 配置，
 *  运行态统一登记为 scaffold:pipeline；出现未知 key 时由调用方兜底显示原 key。 */
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

/**
 * 更新运行中任务的进度与预计剩余时间（脚手架计时器每秒调用）。
 * 未登记的 key 直接忽略；数值与上次相同则不写，避免无意义的响应式刷新。
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

/** 运行中的后台任务列表（响应式） */
export const runningTaskList = computed<RunningTaskInfo[]>(() => Object.values(registry.value))

/** 按当前语言取任务名列表（去重，供提示文案拼接） */
export function runningTaskNames(locale: string): string[] {
  const en = locale === 'en'
  const names = runningTaskList.value.map((t) => (en ? t.labelEn : t.labelZh))
  return Array.from(new Set(names.filter(Boolean)))
}
