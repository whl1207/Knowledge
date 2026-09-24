/**
 * Excalidraw appState 落盘 / 恢复过滤（主进程与渲染进程共用）
 *
 * 背景：Excalidraw 的 `appState` 里有一批「运行时字段」的类型是 Map 或实例，
 * 例如 `collaborators`（Map<socketId, Collaborator>）。一旦被 JSON 化（写盘、
 * 经 WebSocket 传输后再落盘），Map 会退化成 `{}`；下次打开时它作为 initialData
 * 喂回 Excalidraw，内部 `UserList` 会执行 `collaborators.forEach(...)` →
 * `TypeError: collaborators.forEach is not a function` → 整块白板渲染崩溃（空白）。
 *
 * 因此：**写盘前**与**读取文件后**都必须过滤掉这些键（过滤后 Excalidraw 会用
 * 自己的默认值，协同光标由运行时的 awareness 重新注入，不影响功能）。
 */
const RUNTIME_APPSTATE_KEYS = new Set([
  'collaborators', // Map<socketId, Collaborator> —— 崩溃根因
  'activeEmbeddable',
  'draggingElement',
  'editingElement',
  'editingGroupId',
  'editingLinearElement',
  'multiElement',
  'selectionElement',
  'newElement',
  'resizingElement',
  'hoveredElementId',
  'openPopup',
  'openDialog',
  'contextMenu',
])

/** 过滤出可安全持久化 / 恢复的 appState（浅拷贝，不改动入参） */
export function cleanExcalidrawAppState(appState: unknown): Record<string, any> {
  const out: Record<string, any> = {}
  if (!appState || typeof appState !== 'object') return out
  for (const [k, v] of Object.entries(appState as Record<string, any>)) {
    if (RUNTIME_APPSTATE_KEYS.has(k)) continue
    out[k] = v
  }
  return out
}
