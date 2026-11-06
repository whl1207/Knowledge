/** 知识库模块分区导航的共享类型（桌面左栏 / 窄屏一级列表共用） */
export interface NavItem {
  key: string
  label: string
  icon: string
  count?: number
  dot?: boolean
}

export interface NavGroup {
  label?: string
  items: NavItem[]
}
