/** 学习模块共享类型（P1） */
import type { KbType } from '@/services/learningCore'

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
}
