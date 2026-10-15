/**
 * kbTestRun.ts — 「知识库评测 / 批量测试」的全局运行态（模块级，非 pinia）
 *
 * 为什么需要它：批量测试的进度原先只存在于 testManager（属于「知识处理」主面板）内部——
 * 一旦切到别的模块（主页 / 知识管理 / 学习…），那里看不到任何进度，用户无法判断「还在跑 / 跑完了」。
 * 这里把运行态放到模块级单例：testManager 每秒上报，App.vue 在任意模块都能画出底角进度条，
 * 点击即可跳回「知识处理 → 测试」。
 *
 * 同时配合 store/runningTasks：把评测登记为后台任务，窗口关闭确认与托盘提示都会带上它
 * （避免长达几十分钟的评测被误关窗口杀掉）。
 */

import { reactive, ref } from 'vue'

export interface KbTestRunState {
  /** 是否正在批量测试 */
  running: boolean
  /** 第一行：核心进度（如「批量测试 45% · 相似度 12/616」） */
  text: string
  /** 第二行：时间信息（已用 / 预计剩余） */
  detail: string
  /** 0~100 */
  progress: number
}

export const kbTestRun = reactive<KbTestRunState>({
  running: false,
  text: '',
  detail: '',
  progress: 0,
})

/** 上报运行态（只覆盖传入字段） */
export function reportKbTestRun(patch: Partial<KbTestRunState>): void {
  Object.assign(kbTestRun, patch)
}

/** 结束：清空运行态（底角进度条随之消失） */
export function clearKbTestRun(): void {
  kbTestRun.running = false
  kbTestRun.text = ''
  kbTestRun.detail = ''
  kbTestRun.progress = 0
}

/**
 * 「跳回测试页」请求令牌：App.vue 的全局进度条点击时自增；
 * knowRAG 监听它 → 把视图切到「测试」标签（mainPanel 由 App 负责切到「知识处理」）。
 */
export const kbTestViewRequest = ref(0)
export function requestKbTestView(): void {
  kbTestViewRequest.value++
}
