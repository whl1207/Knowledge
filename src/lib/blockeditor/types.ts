/**
 * blockeditor/types.ts — 块编辑器数据模型
 *
 * 设计要点
 * - Markdown 是唯一存储格式，内存模型只是它的结构化视图。
 * - 每个块 = 若干「原样保留的行」+ 缩进信息 + 类型（类型是派生出来的，方便 UI 用）。
 * - `lines` 里存的是**去掉首行缩进后**的原文；缩进放在 `indent`。
 * - `dirty` 标记用户是否改过这个块：只有改过的块才会在序列化时被规范化重写，
 *   未改动的块逐字节原样输出，避免「打开→保存」产生整文件 diff。
 */

/** 块类型（覆盖 M1 要求的全部类型） */
export type BlockType =
  | 'paragraph' // 段落（可含软换行，多行）
  | 'heading' // 标题 1-6
  | 'bullet' // 无序列表
  | 'ordered' // 有序列表
  | 'todo' // 待办清单
  | 'quote' // 引用
  | 'code' // 围栏代码块（含 mermaid）
  | 'divider' // 分割线
  | 'table' // 表格
  | 'math' // 块级数学公式 $$...$$
  | 'raw' // 未识别语法，原样保留

export interface BlockProps {
  /** heading: 1-6 */
  level?: number
  /** ordered: 起始编号 */
  start?: number
  /** todo: 是否勾选 */
  checked?: boolean
  /** code: 围栏语言（```lang） */
  lang?: string
  /** code: 围栏 info 的剩余部分（```lang extra） */
  info?: string
  /** ordered: 编号分隔符 . 或 ) */
  delimiter?: string
  /** 表格：对齐行原文（渲染预览用） */
  align?: string
}

export interface Block {
  /** 稳定 id，用于 Vue key 与拖拽识别 */
  id: string
  type: BlockType
  /** 块正文行（不含首行缩进前缀；代码块/表格等多行块的后续行保持原样） */
  lines: string[]
  /** 首行原始缩进字符串（逐字节保留原文用） */
  indent: string
  /** 缩进层级（派生，0 起）。非列表/非引用恒为 0 */
  indentLevel: number
  props: BlockProps
  /** 该块之后的空行数量（原文保留） */
  blankAfter: number
  /** 用户是否编辑过该块（决定序列化时是否规范化重写） */
  dirty: boolean
}

export interface ParsedDoc {
  blocks: Block[]
  /** 文件开头的空行数 */
  leadingBlank: number
  /** 原文件是否以换行结尾 */
  trailingNewline: boolean
  /** 缩进单位（推断得出，用于 dirty 块重写缩进） */
  indentUnit: string
  /** 原文件换行符 */
  eol: '\n' | '\r\n'
}

/** 具备「缩进 = 嵌套层级」语义的块类型 */
export const LIST_TYPES: BlockType[] = ['bullet', 'ordered', 'todo']

/** 多行块（缩进只作用于首行，后续行属于内容，不能乱动） */
export const MULTILINE_TYPES: BlockType[] = ['code', 'math', 'table', 'raw']

/** 可在块前加缩进前缀的类型（段落的软换行续行不参与整体缩进） */
export const INDENTABLE_TYPES: BlockType[] = ['paragraph', 'heading', 'bullet', 'ordered', 'todo', 'quote']

let seq = 0
/** 生成块 id（会话内唯一即可，不落盘） */
export function uid(): string {
  seq += 1
  return `b${seq.toString(36)}${Date.now().toString(36).slice(-4)}`
}

/** 缩进字符串的视觉宽度（tab 记 4 列） */
export function indentWidth(indent: string): number {
  let w = 0
  for (const ch of indent) w += ch === '\t' ? 4 : 1
  return w
}

/** 创建空块（供 UI「回车插入」等命令使用） */
export function createBlock(type: BlockType = 'paragraph', over: Partial<Block> = {}): Block {
  return {
    id: uid(),
    type,
    lines: [''],
    indent: '',
    indentLevel: 0,
    props: {},
    blankAfter: 0,
    dirty: true,
    ...over,
  }
}
