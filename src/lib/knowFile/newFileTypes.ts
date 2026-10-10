/**
 * newFileTypes.ts — 「新建」菜单可创建的文件类型。
 *
 * 文件树右键（panel.vue）与「文件」视图右键（view_file.vue）共用本列表，
 * 保证两处菜单项与类型弹窗完全一致；新增文件类型只改这里。
 *
 * `key` 同时是创建时的类型标识；`skeleton` 非空时，建好文件后立即写入初始内容，
 * 避免留下 0 字节文件（打开时与各编辑器的「默认新建」一致）。
 */
import { newDrawioXml } from '@/shared/drawioFile'
import { emptyTaskFileContent } from '@/lib/taskFile'

export type NewFileTypeKey = 'md' | 'excalidraw' | 'drawio' | 'flow' | 'data' | 'task'

export interface NewFileTypeDef {
  key: NewFileTypeKey
  /** 文件扩展名（含点） */
  ext: string
  /** 菜单 / 类型按钮图标 */
  icon: string
  labelZh: string
  labelEn: string
  /** 初始内容；不提供则创建空文件 */
  skeleton?: () => string
}

/** 新建菜单顺序即本数组顺序 */
export const NEW_FILE_TYPES: NewFileTypeDef[] = [
  { key: 'md', ext: '.md', icon: 'fa fa-file-text-o', labelZh: 'Markdown', labelEn: 'Markdown' },
  { key: 'excalidraw', ext: '.excalidraw', icon: 'fa fa-paint-brush', labelZh: 'Excalidraw', labelEn: 'Excalidraw' },
  // draw.io：先写入空白图表框架
  { key: 'drawio', ext: '.drawio', icon: 'fa fa-object-group', labelZh: 'draw.io', labelEn: 'draw.io', skeleton: () => newDrawioXml() },
  // 工作流（.flow.yml，Dify DSL）：空内容打开时编辑器写入「开始 → 结束」骨架
  { key: 'flow', ext: '.flow.yml', icon: 'fa fa-stumbleupon', labelZh: '工作流', labelEn: 'Workflow' },
  // 数据画布（.data）：空内容打开时画布给出一个空模型
  { key: 'data', ext: '.data', icon: 'fa fa-object-group', labelZh: '数据画布', labelEn: 'Data Canvas' },
  // 脚手架任务（.task）：图标与文件树 / 文件视图里 .task 的图标保持一致（见 store.icon 的 .task 分支）
  { key: 'task', ext: '.task', icon: 'fa fa-tasks', labelZh: '脚手架', labelEn: 'Scaffold', skeleton: () => emptyTaskFileContent('pipeline') },
]

/** 按 key 取新建类型定义（未知 key 返回 undefined） */
export function newFileType(key: string): NewFileTypeDef | undefined {
  return NEW_FILE_TYPES.find((t) => t.key === key)
}
