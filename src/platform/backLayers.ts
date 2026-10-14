/**
 * backLayers.ts — 系统返回手势（安卓返回键 / 边缘内划）的「界面层」注册表
 *
 * 为什么需要它：返回手势属于**系统**事件，但本应用的界面栈是**各模块自己的状态**
 * （设置里「分类列表 ⇄ 内容」、主页「聊天列表 ⇄ 对话」、知识管理「文件树抽屉 ⇄ 视图」…），
 * App.vue 看不到这些状态。因此各模块在这里登记「我这一层能不能回退、怎么回退」，
 * 由 App.vue 按优先级从内到外询问，谁先能回退就谁处理：
 *
 * ```
 * 高 ← Element Plus 弹窗（App 直接处理）
 *      应用内文件窗口
 *      设置内子面板（模型来源 / 插件 / MCP… 的「列表 ⇄ 内容」）
 *      设置（「分类列表 ⇄ 设置内容」）
 *      设置浮层本身（关掉设置）
 *      模块内导航（主页聊天列表 / 知识管理文件树抽屉）
 *      主面板回主页 → 连按两次退出应用 → 低
 * ```
 *
 * 这里刻意**不依赖 Vue**（便于 Node 侧自检），Vue 侧封装见 `composables/useBackLayer`。
 */

/** 一层可回退的界面 */
export interface BackLayer {
  /** 层标识（调试 / 自检用；同一 id 重复注册时后注册的生效） */
  id: string
  /**
   * 优先级：**数值越大越靠内层**（越先被询问）。
   * 覆盖在别人之上的层（如文件窗口、设置）数值更大，保证「先关上层，再退下层」。
   */
  order: number
  /** 当前是否有东西可回退（模块据此检查自身可见性与内部状态；false = 不抢这次返回） */
  canGoBack: () => boolean
  /** 执行回退（canGoBack 为 true 时才会被调用） */
  goBack: () => void
}

const layers: BackLayer[] = []

/**
 * 注册一层；返回注销函数。
 * 同一 id 再次注册会替换旧的（KeepAlive 面板「激活」时重新注册即用此语义）。
 */
export function registerBackLayer(layer: BackLayer): () => void {
  const off = () => {
    const i = layers.findIndex((l) => l === layer)
    if (i >= 0) layers.splice(i, 1)
  }
  const sameId = layers.findIndex((l) => l.id === layer.id)
  if (sameId >= 0) layers.splice(sameId, 1)
  layers.push(layer)
  return off
}

/**
 * 询问最内层可回退的界面并回退。
 * 返回 true = 已处理（不退出应用）；false = 本层都回无可回，调用方继续往外层走。
 */
export function runTopBackLayer(): boolean {
  const ordered = layers.slice().sort((a, b) => b.order - a.order)
  for (const layer of ordered) {
    let ok = false
    try {
      ok = layer.canGoBack() === true
    } catch {
      ok = false
    }
    if (!ok) continue
    try {
      layer.goBack()
    } catch (e) {
      console.error(`[back] 层级 ${layer.id} 回退失败:`, e)
      continue
    }
    return true
  }
  return false
}

/** 当前登记的层（按优先级从内到外；调试 / 自检用） */
export function backLayerIds(): string[] {
  return layers.slice().sort((a, b) => b.order - a.order).map((l) => l.id)
}

/** 清空全部登记（自检用） */
export function clearBackLayers(): void {
  layers.length = 0
}

/**
 * 层级优先级常量（集中定义，避免各模块各写一个魔法数字后互相插队）。
 * 数值越大越靠内层。
 */
export const BACK_ORDER = {
  /** 模块内导航：主页聊天列表、知识管理文件树抽屉、文件阅读内的翻页等 */
  moduleNav: 10,
  /** 设置浮层本身（关掉设置回到主界面） */
  settingsOverlay: 40,
  /** 设置：分类列表 ⇄ 设置内容 */
  settingsNav: 43,
  /** 设置内子面板：列表 ⇄ 内容（模型来源 / 插件管理 / MCP / 搜索源 / 预设 / 控制台 / 日志） */
  settingsPanel: 45,
  /** 应用内文件窗口浮层（安卓 / 网页端打开文件） */
  fileWindow: 50,
} as const
