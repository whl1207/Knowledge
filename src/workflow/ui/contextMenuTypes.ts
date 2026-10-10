/** 右键菜单的菜单项定义（独立文件：`<script setup>` 不能导出类型） */
export interface ContextMenuItem {
  key: string
  label: string
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  /** 有子菜单（内容由调用方通过 #sub 插槽提供） */
  children?: boolean
}
