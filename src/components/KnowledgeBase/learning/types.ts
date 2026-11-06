/** 学习模块共享类型（P1） */
import type { KbType } from '@/services/learningCore'
import type { PracticeOption, PracticeQType } from '@/lib/learning/learningGrade'

/** 学习地图/总览用到的对象视图模型（由 learning.vue 由 LData.objects 派生） */
export interface LvmItem {
  key: string
  label: string
  type: KbType             // 知识类型（分型复习）
  sliceCount: number     // 切片数（命中当前 .kb 的）
  qCount: number         // 可练问题数（由切片 Q 拆分合计）
  attempts: number
  mastery: number        // 0..1（声明掌握时为 1）
  status: 'new' | 'learning' | 'mastered'
  due: boolean           // SRS 到期（有作答且未过期标记）
  dueAt: number          // 到期时间戳（未到期为 0）
  stale?: boolean
  learnerClaimed?: boolean // 声明已掌握（跳测）
  /** 走质性门控（概念 / 设计）：靠「用自己的话讲一遍」判定，不是刷正确率（P1-2） */
  qualitativeGate?: boolean
}

/** 学习地图 · 实体轴视图模型（由文件作答经 entityNames/entityToBlocks 投影） */
export interface EntityItem {
  name: string
  label: string
  blockCount: number   // 命中当前 .kb 的切片数
  fileCount: number    // 覆盖来源文件数
  attempts: number
  mastery: number      // 0..1
  status: 'new' | 'learning' | 'mastered'
  due: boolean
}

/** 练习会话中的一道题（闪卡） */
export interface PracticeItem {
  q: string
  back: string           // 参考答案：优先问题库生成的答案(extraAnswer)，否则来源切片正文
  /** back 是否来自问题库生成答案（true 时 back=答案、slices=参考切片；false 时 back 即来源切片正文） */
  hasAnswer?: boolean
  /** 参考切片（问题库 answerBlocks 解析；供 reveal 后查看出处） */
  slices?: { label: string; content: string }[]
  objKey: string         // 所属文件对象 key
  filePath: string
  blockId: any
  entityNames: string[]
  // ==================== 判分（P1） ====================
  /**
   * 题型，决定怎么判。缺省按 'short'。
   * `qualitative` 是「用自己的话讲一遍」，永远不由字符串判分（留给 LLM 质性门控）。
   */
  qType?: PracticeQType
  /**
   * **可判分的期望答案** —— 只来自问题库的独立答案（`extraAnswer`），
   * **绝不**用来源切片正文冒充（那样等于把原文当答案，判出来必然无意义）。
   * 为空的题：`isAutoGradable` 返回 false，UI 直接走四档自评。
   */
  expectedAnswer?: string
  /** 选择题的选项表（标签 → 正文）；本仓库的题库暂不产出，保留给导入/考试复用 */
  choiceMap?: Record<string, PracticeOption['body']> | null
  /**
   * 可选的「先测后教」提示文本（题面下的一行引导），用于无答案的复述题
   */
  hint?: string
  /** 质性判定：学习者的讲解原文（由 practiceView 回填，父级落盘为证据） */
  explanation?: string
  /** 质性判定：模型短评（讲对了什么 / 缺什么） */
  feedback?: string
}
