/**
 * plugin-ipc.ts — 插件管理 IPC（`plugin:*` 命名空间）
 *
 * 分两类，**审批模型不同**（对齐 dsh 的 plugin_manager：每个工具操作都要求
 * danger-full-access 或本次调用批准）：
 * - 只读：list / inspect / getConfig / logs / openDir —— 不需要审批；
 * - 变更：enable / disable / reload / uninstall / setConfig —— 必须 `confirm: true`。
 *   未确认时抛 `PERMISSION_DENIED` 且**不改变任何状态**（UI 弹确认框后带 confirm 重试），
 *   同时写一条 [audit] 日志。门槛逻辑见 plugin-approval.ts。
 *
 * 事件出口：`plugin:event` 广播（PluginHost 通过 init 注入的 eventSink 推送）。
 */

import { BrowserWindow, dialog, shell } from 'electron'
import { IPCError } from '@/types/ipc'
import type { PluginEvent, PluginSnapshot } from '@/types/plugin'
import { registerIpc, sendToAll } from './ipc-registry'
import { pluginHost } from './plugin-host'
import { jobRegistry } from './job-registry'
import { sessionLog } from './session-log'
import { requirePluginApproval } from './plugin-approval'

/** 启动插件宿主（app ready 时调用一次；在创建窗口之前，保证首个会话就能看到插件工具） */
export function initPluginHost(): Promise<void> {
  return pluginHost.init({
    eventSink: (event: PluginEvent) => sendToAll('plugin:event', event),
    // 应用侧服务注入（宿主自身只懂 tools / shell）
    builtinServices: { sessionLog, jobs: jobRegistry },
  })
}

/** 注册 `plugin:*` 通道（在 registerNamespacedIpc 之后调用；单独调用以避免模块循环依赖） */
export function registerPluginIpc(): void {
  registerIpc('plugin:list', () => ({
    plugins: pluginHost.list(),
    rootDir: pluginHost.rootDir(),
    /** 是否为用户在设置里选的自定义目录（false = 默认 userData/plugins） */
    customRoot: pluginHost.hasCustomRoot(),
    services: pluginHost.serviceNames(),
  }))

  registerIpc('plugin:inspect', (payload) => {
    const spec = readString(payload?.spec, 'spec')
    return pluginHost.inspect(spec)
  })

  registerIpc('plugin:enable', async (payload) => {
    const id = readString(payload?.id, 'id')
    requirePluginApproval(payload, `启用插件 ${id}`)
    return pluginHost.enable(id)
  })

  registerIpc('plugin:disable', async (payload) => {
    const id = readString(payload?.id, 'id')
    requirePluginApproval(payload, `禁用插件 ${id}`)
    return pluginHost.disable(id)
  })

  registerIpc('plugin:reload', async (payload) => {
    const id = readString(payload?.id, 'id')
    requirePluginApproval(payload, `重新加载插件 ${id}`)
    return pluginHost.reload(id)
  })

  registerIpc('plugin:uninstall', async (payload) => {
    const id = readString(payload?.id, 'id')
    requirePluginApproval(payload, `移除插件 ${id}`)
    return pluginHost.uninstall(id, payload?.deleteFiles === true)
  })

  registerIpc('plugin:get-config', (payload) => {
    const id = readString(payload?.id, 'id')
    return pluginHost.getConfig(id)
  })

  registerIpc('plugin:set-config', (payload) => {
    const id = readString(payload?.id, 'id')
    requirePluginApproval(payload, `修改插件 ${id} 的配置`)
    const patch = payload?.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new IPCError('INVALID_ARGUMENT', 'patch 必须是对象')
    }
    return pluginHost.setConfig(id, patch as Record<string, unknown>)
  })

  registerIpc('plugin:set-root', async (payload) => {
    requirePluginApproval(payload, '选择插件目录')
    const provided = typeof payload?.path === 'string' && payload.path.trim() ? payload.path.trim() : ''
    let target = provided
    if (!target) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, {
        title: '选择插件目录（每个子文件夹即一个插件）',
        buttonLabel: '使用此目录',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths?.[0]) return { cancelled: true as const, rootDir: pluginHost.rootDir() }
      target = result.filePaths[0]
    }
    const rootDir = await pluginHost.setRoot(target)
    return { cancelled: false as const, rootDir }
  })

  // 恢复默认插件目录（userData/plugins）
  registerIpc('plugin:reset-root', async (payload) => {
    requirePluginApproval(payload, '恢复默认插件目录')
    const rootDir = await pluginHost.setRoot(null)
    return { cancelled: false as const, rootDir }
  })

  registerIpc('plugin:logs', (payload) => {
    const id = readString(payload?.id, 'id')
    return pluginHost.logs(id)
  })

  // 渲染层半边的 bundle 源码（只读，无需审批）：渲染层用 Blob URL 动态 import
  registerIpc('plugin:client-bundle', (payload) => {
    const id = readString(payload?.id, 'id')
    return pluginHost.readClientBundle(id)
  })

  /**
   * 从本地文件夹安装插件（P2 本地安装；无在线商店）。
   * 主进程弹系统目录选择框 → 复制到插件目录 → 立即加载。
   * `replace` 为真表示用户已确认覆盖同名插件（UI 在收到 PLUGIN_EXISTS 后询问）。
   */
  registerIpc('plugin:install', async (payload) => {
    requirePluginApproval(payload, '安装本地插件')
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择插件文件夹（包含 package.json 与 aikm 清单）',
      buttonLabel: '安装此插件',
      properties: ['openDirectory'],
    })
    const picked = result.filePaths?.[0]
    if (result.canceled || !picked) return { cancelled: true as const, snapshot: null }
    const snapshot = await pluginHost.installFromDirectory(picked, { replace: payload?.replace === true })
    return { cancelled: false as const, snapshot }
  })

  registerIpc('plugin:open-dir', async (payload) => {
    const id = payload?.id
    const dir = typeof id === 'string' && id ? pluginHost.get(id)?.dir : pluginHost.rootDir()
    if (!dir) throw new IPCError('PLUGIN_NOT_FOUND', `插件不存在：${String(id)}`)
    const error = await shell.openPath(dir)
    if (error) throw new IPCError('INTERNAL', `打开目录失败：${error}`)
    return { path: dir }
  })
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IPCError('INVALID_ARGUMENT', `缺少或非法的 ${field}`)
  }
  return value.trim()
}

/** 供设置页类型标注使用（避免同形类型在多处重复声明） */
export type PluginListResult = {
  plugins: PluginSnapshot[]
  rootDir: string
  services: string[]
}
