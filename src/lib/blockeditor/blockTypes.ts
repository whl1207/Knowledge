/**
 * blockeditor/blockTypes.ts — 块类型菜单数据
 *
 * 放在纯 TS 模块里（而不是 SFC 的 `<script setup>` 中），因为 `<script setup>`
 * 不允许 ES 模块导出，跨组件复用类型会报错。
 */

import type { BlockType } from './types'

export interface BlockTypeItem {
  /** 唯一 key（code 有多个子项，靠 level / lang 区分） */
  key: string
  type: BlockType
  level?: number
  lang?: string
  label: string
  icon: string
  hint?: string
}

/** 生成块类型菜单项（zh 控制中英文） */
export function buildBlockTypeItems(zh: boolean): BlockTypeItem[] {
  return [
    { key: 'paragraph', type: 'paragraph', label: zh ? '正文' : 'Text', icon: 'fa fa-font' },
    { key: 'h1', type: 'heading', level: 1, label: zh ? '标题 1' : 'Heading 1', icon: 'fa fa-header' },
    { key: 'h2', type: 'heading', level: 2, label: zh ? '标题 2' : 'Heading 2', icon: 'fa fa-header' },
    { key: 'h3', type: 'heading', level: 3, label: zh ? '标题 3' : 'Heading 3', icon: 'fa fa-header' },
    { key: 'bullet', type: 'bullet', label: zh ? '无序列表' : 'Bulleted list', icon: 'fa fa-list-ul' },
    { key: 'ordered', type: 'ordered', label: zh ? '有序列表' : 'Numbered list', icon: 'fa fa-list-ol' },
    { key: 'todo', type: 'todo', label: zh ? '待办清单' : 'To-do list', icon: 'fa fa-check-square-o' },
    { key: 'quote', type: 'quote', label: zh ? '引用' : 'Quote', icon: 'fa fa-quote-right' },
    { key: 'code', type: 'code', label: zh ? '代码块' : 'Code', icon: 'fa fa-terminal' },
    { key: 'divider', type: 'divider', label: zh ? '分割线' : 'Divider', icon: 'fa fa-minus' },
    { key: 'table', type: 'table', label: zh ? '表格' : 'Table', icon: 'fa fa-table' },
    { key: 'math', type: 'math', label: zh ? '公式' : 'Math', icon: 'fa fa-superscript' },
    { key: 'mermaid', type: 'code', lang: 'mermaid', label: 'Mermaid', icon: 'fa fa-sitemap' },
  ]
}
