/**
 * appApi.ts — 渲染层「应用信息服务」（插件上下文里的 `ctx.app`）
 *
 * 只读暴露宿主自己的配置面，让插件能"选一个预设智能体""看看当前模型"而不用自己解析
 * localStorage。**基本不给写接口**（插件要改软件配置请引导用户去设置页），
 * 唯一的例外是 `setChromeHidden`：插件面板要全屏时必须能让宿主把外壳收起来，
 * 否则只能靠 `position:fixed` 去"盖住"顶栏——安卓 WebView 上不稳定（见 panelChrome.ts）。
 */

import { usestore } from '@/store'
import { panelChromeHidden, setPanelChromeHidden } from './panelChrome'

export interface PluginAgentPresetInfo {
  id: string
  name: string
  /** 预设的 system prompt（评审类插件用它当角色设定） */
  systemPrompt: string
  /** 预设名称下面的角色说明（可空） */
  role: string
  /** 该预设启用的工具名（只读展示） */
  tools: string[]
}

export interface PluginAppApi {
  /** 应用名 / 版本等基础信息 */
  info(): { name: string; version: string; language: string }
  /** 预设智能体清单（设置 → 智能体 → 预设，含内置预设） */
  agentPresets(): PluginAgentPresetInfo[]
  /**
   * 请求隐藏 / 恢复宿主外壳（顶栏 + 左侧导航 + 底部导航）：插件面板进入"全屏 / 沉浸"模式时用。
   * 宿主会在切换主面板或卸载插件时自动恢复，插件也应在自己退出全屏时传 false。
   */
  setChromeHidden(hidden: boolean): void
  /** 当前宿主外壳是否处于隐藏状态（供插件自查） */
  chromeHidden(): boolean
}

function pickString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function createPluginAppApi(): PluginAppApi {
  const safeStore = (): any => {
    try {
      return usestore()
    } catch {
      return null
    }
  }

  return {
    info() {
      const store = safeStore()
      return {
        name: 'AI-KM',
        version: '1.0.0',
        language: store?.locales === 'en' ? 'en' : 'zh',
      }
    },

    agentPresets() {
      const store = safeStore()
      const list: any[] = Array.isArray(store?.agentPresets) ? store.agentPresets : []
      return list.map((preset) => {
        const source = (preset ?? {}) as Record<string, unknown>
        const tools = Array.isArray(preset?.tools) ? preset.tools.map((t: unknown) => String(t)) : []
        const capabilities = preset?.capabilities && typeof preset.capabilities === 'object'
          ? Object.keys(preset.capabilities as Record<string, unknown>).filter((k) => (preset.capabilities as Record<string, unknown>)[k])
          : []
        return {
          id: pickString(source, ['id']) || String(preset?.name ?? ''),
          name: pickString(source, ['name']) || pickString(source, ['id']),
          systemPrompt: pickString(source, ['systemPrompt', 'system_prompt', 'prompt', 'instructions']),
          role: pickString(source, ['role', 'description', 'desc']),
          tools: tools.length ? tools : capabilities,
        }
      })
    },

    setChromeHidden(hidden) {
      setPanelChromeHidden(hidden === true)
    },

    chromeHidden() {
      return panelChromeHidden.value === true
    },
  }
}
