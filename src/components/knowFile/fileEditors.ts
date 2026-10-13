/**
 * fileEditors.ts — 「专属文件类型 → 编辑器」的唯一注册点。
 *
 * 有六个文件类型各自带一个专属编辑器（不属于通用的浏览 / 源码编辑 / 可视编辑 / 导图 / 演示那一套）：
 *
 *   `.excalidraw` → 白板      `.drawio` → 图表       `.flow.yml` → 工作流编辑器
 *   `.data`       → 数据画布  `.task`   → 脚手架     `.mmd` → Mermaid 图表
 *
 * 打开它们的宿主有三处：主窗口 `components/knowFile/explorer.vue`（多面板视图）、
 * 独立窗口 `components/knowFile/FileWindow.vue`（单文件 + 视图切换）、
 * 以及 `components/knowFile/view/md_read.vue`（内嵌预览）。
 * 此前这三处各自写了一遍「后缀判别 + import 组件 + 视图范围」，同一份知识散在三处；
 * 本文件把它收敛成一张表 —— 改判别规则、改编辑器落点、改视图范围都只动这里。
 *
 * 只管「是什么类型 / 用哪个编辑器 / 在哪些视图下渲染」，不管挂载与传参：
 * 内嵌预览与整窗视图的包裹方式不同，各宿主仍保留自己的渲染分支。
 */

import { isDrawioFile } from '@/shared/drawioFile'
import { isFlowDslPath } from '@/shared/flowFile'
import { isTaskFile } from '@/lib/taskFile'
import { FILE_VIEW_NAMES, VIEW_BROWSE, VIEW_VISUAL } from '@/lib/knowFile/fileViews'

/** 专属编辑器类型 */
export type EditorKind = 'excalidraw' | 'drawio' | 'flow' | 'data' | 'task' | 'mermaid'

/** 判定依据：路径 / 扩展名 / 内容（三者都可缺省） */
export interface EditorSource {
  /** 文件路径 */
  path?: string
  /** 文件对象上的小写扩展名（含点，如 `.data`）——有些宿主手里只有它而没有完整路径 */
  extension?: string
  /** 文件内容（目前只有 draw.io 需要看内容：`.xml` 得内容像图表才算图表） */
  content?: string
}

export interface FileEditorDef {
  /** 是否为该类型 */
  match: (src: { path: string; extension: string; content: string }) => boolean
  /** 编辑器组件懒加载（组件路径集中在此，宿主不再各写一份 import） */
  load: () => Promise<any>
  /** 主窗口多面板下占用的「文件视图」；`null` = 全部视图都渲染（绘图类接管所有视图） */
  views: readonly string[] | null
}

/** 小写扩展名（含点）；没有扩展名返回 '' */
function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i >= 0 ? path.slice(i).toLowerCase() : ''
}

/** 后缀判定：扩展名命中，或路径以该后缀结尾（扩展名可能缺省，两条都要看） */
function suffixMatcher(suffix: string) {
  return (path: string, extension: string) => extension === suffix || path.toLowerCase().endsWith(suffix)
}

export const FILE_EDITORS: Record<EditorKind, FileEditorDef> = {
  // 白板：浏览 / 源码编辑 / 可视编辑 / 导图 / 演示统一渲染绘图界面
  excalidraw: {
    match: ({ path, extension }) => suffixMatcher('.excalidraw')(path, extension),
    load: () => import('@/components/knowFile/view/Excalidraw.vue'),
    views: null,
  },
  // 图表：同上；`.drawio` / `.dio` 按后缀，`.xml` 需内容像图表（见 shared/drawioFile）
  drawio: {
    match: ({ path, content }) => isDrawioFile(path, content),
    load: () => import('@/components/knowFile/view/Drawio.vue'),
    views: null,
  },
  // 工作流（Dify DSL）：浏览 / 可视编辑渲染流程画布，源码编辑保持 YAML 文本
  flow: {
    match: ({ path, extension }) => isFlowDslPath(path) || isFlowDslPath(extension),
    load: () => import('@/features/workflow/ui/WorkflowEditor.vue'),
    views: [VIEW_BROWSE, VIEW_VISUAL],
  },
  // 数据画布：浏览 / 可视编辑渲染画布，源码编辑保持 JSON 文本
  data: {
    match: ({ path, extension }) => suffixMatcher('.data')(path, extension),
    load: () => import('@/features/data-canvas/DataCanvasModule.vue'),
    views: [VIEW_BROWSE, VIEW_VISUAL],
  },
  // 脚手架任务：独立文件窗口固定用它打开（主窗口不特殊处理 .task，仍按文本预览）
  task: {
    match: ({ path }) => isTaskFile(path),
    load: () => import('@/features/agent-scaffold/PipelineScaffold.vue'),
    views: [VIEW_BROWSE],
  },
  // Mermaid 图表：浏览视图渲染图，源码编辑仍走通用 Monaco（同工作流 / 数据画布）。
  // 视图范围只给「浏览」：主窗口的其它全局视图（文件 / 图谱 / 表格…）不能被图表占掉
  mermaid: {
    match: ({ path, extension }) => suffixMatcher('.mmd')(path, extension) || suffixMatcher('.mermaid')(path, extension),
    load: () => import('@/components/knowFile/view/Mermaid.vue'),
    views: [VIEW_BROWSE],
  },
}

/** 依据路径 / 扩展名 / 内容判定专属编辑器类型；无匹配返回 null（该文件走通用视图） */
export function detectEditorKind(src: EditorSource): EditorKind | null {
  const path = String(src.path || '')
  const normalized = {
    path,
    extension: String(src.extension || '').toLowerCase() || extOf(path),
    content: String(src.content || ''),
  }
  for (const kind of Object.keys(FILE_EDITORS) as EditorKind[]) {
    if (FILE_EDITORS[kind].match(normalized)) return kind
  }
  return null
}

/** 专属编辑器是否应在该「文件视图」下渲染（主窗口多面板用） */
export function editorVisibleInView(kind: EditorKind, viewName: string): boolean {
  const views = FILE_EDITORS[kind].views
  return views === null ? FILE_VIEW_NAMES.includes(viewName) : views.includes(viewName)
}
