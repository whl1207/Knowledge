/**
 * kbTestSnapshot.ts — 知识库测试结果快照（模块级，非 pinia）
 *
 * 为什么放在模块级：「知识处理」面板一旦被销毁重挂（KeepAlive 未命中、窗口重载等），
 * 它内部的所有 ref 都会重置 —— 批量测试结果、位次分析、策略统计随之消失。
 * 而 testManager 每次跑完都会 emitTestData() 把完整快照交给父壳，
 * 父壳只需把它写在这里：重挂后作为 props.testData 传回，testManager 用已有的
 * restoreTestData() 原样恢复（测试结果 / 位次 / 统计 / 切片明细 id 都能回来）。
 *
 * 注意：这里只做「内存快照」，不落盘；是否写入 .kb 文件仍由「保存测试结果到 KB 文件」开关决定。
 */
import { ref } from 'vue'

export const kbTestSnapshot = ref<any>(null)

/** 清空快照（用户主动清空批量测试结果时调用） */
export function clearKbTestSnapshot(): void {
  kbTestSnapshot.value = null
}
