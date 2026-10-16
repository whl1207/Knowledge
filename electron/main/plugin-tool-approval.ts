/**
 * plugin-tool-approval.ts — 「插件的工具需要用户审批」这件事的**执行点**（pre-execute 门禁）
 *
 * ## 为什么会有这个模块
 *
 * `ToolDefinition.requiresApproval` 一直被**设置**（`plugin-tools.ts` 对声明了 `fs` / `shell`
 * 的插件默认置 true），但**从来没有消费方** —— 界面与指南里那句"带此权限的插件工具默认需要
 * 用户审批"长期只是文案。本模块在 `toolRegistry` 的 **pre-execute** 阶段拦一次，把它变成事实
 * （DSH 也正是在 pre-execute 放这一类门禁：`tools/pre-execute` 是可扩展的允许/拒绝门禁）。
 *
 * 三态（`allow` / `ask` / `deny`，按**插件**记）与存储见 `plugin-tool-approval-store.ts`。
 * 为什么按插件而不是按工具：用户要回答的是"我信不信任**这个插件**"，而不是逐条权衡它注册的
 * 五个工具里的哪三个。逐工具开关另有其地（「设置 → 工具 → 管理」）。
 *
 * ## 边界
 *
 * - **只管插件工具**：按工具名归因到某个已装插件（`pluginHost.get(id).tools`）；宿主内置工具
 *   不受影响（它们的审批模型在「设置 → 工具 → 管理」那一套里）。
 * - 没标 `requiresApproval` 的插件工具**完全不进这一层**。
 * - 无窗口时 **fail-closed 到拒绝**（不能"问不到就放行"）。
 */

import { BrowserWindow, dialog } from 'electron'

import { IPCError } from '@/types/ipc'
import { toolRegistry } from '@/shared/toolRegistry'
import type { PluginSnapshot } from '@/types/plugin'
import { registerIpc } from './ipc-registry'
import { logInfo } from './log'
import { pluginHost } from './plugin-host'
import { requirePluginApproval } from './plugin-approval'
import {
  setToolApproval,
  toolApprovalOf,
  type PluginToolApproval,
} from './plugin-tool-approval-store'

/** 同一次运行内，同一个插件的弹框不并发弹两次（并发的工具调用共用同一个答案） */
const asking = new Map<string, Promise<PluginToolApproval | null>>()

/**
 * 该工具属于哪个已装插件（按插件记录的 `tools` 名单归因）。
 *
 * 找一个就够：插件工具名必须自带前缀且**不得与宿主工具重名**（注册时校验），
 * 所以一个工具名最多属于一个插件。
 */
export function ownerPluginOfTool(toolName: string): PluginSnapshot | null {
  const name = String(toolName || '').trim()
  if (!name) return null
  for (const p of pluginHost.list()) {
    if ((p.tools ?? []).includes(name)) return p
  }
  return null
}

/** 某插件里**需要审批**的工具名（设置页展示"这个插件有哪些工具会问你"） */
export function approvalToolsOf(pluginId: string): string[] {
  const snap = pluginHost.get(String(pluginId || '').trim())
  if (!snap) return []
  return (snap.tools ?? []).filter((n) => toolRegistry.get(n, `plugin:${snap.id}`)?.requiresApproval === true)
}

/**
 * 弹框问一次（只在 `ask` 状态下走到这里）。
 * 返回本次决定；`null` = 没法问（无窗口）→ 调用方按拒绝处理（fail-closed）。
 */
async function askOnce(plugin: PluginSnapshot, toolName: string): Promise<PluginToolApproval | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return null

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['允许', '每次都问', '拒绝'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
    title: '插件想调用工具',
    message: `插件「${plugin.name}」想调用工具 ${toolName}`,
    detail:
      '这个插件声明了文件或命令权限，所以它的工具默认需要你确认。\n\n'
      + '「允许」= 以后这个插件的工具不再询问；「每次都问」= 每次调用都确认；'
      + '「拒绝」= 这次及以后都拒绝（可在「设置 → 插件 → 权限」里改回来）。',
  })
  const decided: PluginToolApproval = response === 0 ? 'allow' : response === 1 ? 'ask' : 'deny'
  if (decided !== 'ask') setToolApproval(plugin.id, decided)
  logInfo('main', `[plugin-tool-approval] [audit] ${plugin.id} → ${decided}（工具 ${toolName}）`)
  return decided
}

/**
 * 注册执行点。返回 disposer（应用退出 / 测试收尾时可以撤掉）。
 *
 * 放在 `toolRegistry` 的 pre-execute 阶段：**所有**执行入口（agent 循环 / 技能 / 工作流节点）
 * 都汇聚到 `toolRegistry.execute`，所以门禁放在这里不会漏路径。
 */
export function registerPluginToolApproval(): () => void {
  return toolRegistry.addPreHook(async ({ name }) => {
    const toolName = String(name)
    const owner = ownerPluginOfTool(toolName)
    if (!owner) return undefined // 宿主内置工具：不归本模块管
    if (toolRegistry.get(toolName, `plugin:${owner.id}`)?.requiresApproval !== true) return undefined

    const state = toolApprovalOf(owner.id)
    if (state === 'allow') return undefined
    if (state === 'deny') {
      return {
        skip: true,
        result: {
          ok: false,
          error: `用户已拒绝插件「${owner.name}」的工具调用（可在「设置 → 插件 → 权限」里改回）`,
        },
      }
    }

    // state === 'ask'：弹一次（同插件并发调用共用同一个答案）
    let pending = asking.get(owner.id)
    if (!pending) {
      pending = askOnce(owner, toolName).finally(() => asking.delete(owner.id))
      asking.set(owner.id, pending)
    }
    const decided = await pending
    if (decided === 'allow' || decided === 'ask') return undefined
    return {
      skip: true,
      result: {
        ok: false,
        error: decided === null
          ? `插件「${owner.name}」的工具需要你确认，但当前没有可用窗口来询问 —— 已按拒绝处理（fail-closed）`
          : `你拒绝了插件「${owner.name}」的工具调用 ${toolName}`,
      },
    }
  })
}

/** 设置页改写三态（需 confirm，与其它「插件权限」写入同一口径） */
export function registerPluginToolApprovalIpc(): void {
  registerIpc('plugin:tool-approval-set', (payload) => {
    const pluginId = String(payload?.pluginId ?? '').trim()
    if (!pluginId) throw new IPCError('INVALID_ARGUMENT', '缺少 pluginId')
    if (!pluginHost.get(pluginId)) throw new IPCError('NOT_FOUND', `插件未装载：${pluginId}`)
    requirePluginApproval(payload, `修改插件 ${pluginId} 的工具审批`)
    const state = String(payload?.state ?? '').trim() as PluginToolApproval
    if (!setToolApproval(pluginId, state)) {
      throw new IPCError('INVALID_ARGUMENT', `非法状态：${state}（可用 allow / ask / deny）`)
    }
    logInfo('main', `[plugin-tool-approval] [audit] ${pluginId} 工具审批 → ${toolApprovalOf(pluginId)}`)
    return { pluginId, state: toolApprovalOf(pluginId) }
  })
}
