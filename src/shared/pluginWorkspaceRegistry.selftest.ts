/**
 * pluginWorkspaceRegistry.selftest.ts — 工作区注册表（P4）的自测
 *
 * 微信插件把工作区放在 `<home>/dsh_wechat`（不是默认的 `<home>/workspace`）。
 * 只认单一根目录会让首条消息直接失败；这里钉住"根内任意子目录都能解析 / 创建"。
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceRegistry } from '../../electron/main/plugin-services/workspace'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runPluginWorkspaceRegistrySelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) =>
    Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))

  return (async () => {
    const root = path.join(os.tmpdir(), 'aikm-ws-selftest')
    const registry = createWorkspaceRegistry(root)

    await check('根内子目录可解析（dsh_wechat）', async () => {
      const target = path.join(root, 'dsh_wechat')
      const ws = await registry.resolveByPath(target)
      if (!ws) return '没有解析出工作区'
      if (path.resolve(ws.path) !== path.resolve(target)) return `path 不对：${ws.path}`
      return null
    })

    await check('同一路径 id 稳定；不同路径不同 id', async () => {
      const a1 = await registry.resolveByPath(path.join(root, 'dsh_wechat'))
      const a2 = await registry.resolveByPath(path.join(root, 'dsh_wechat'))
      const b = await registry.resolveByPath(path.join(root, 'workspace'))
      if (!a1 || !a2 || !b) return '解析失败'
      if (a1.id !== a2.id) return '同一路径 id 变了'
      if (a1.id === b.id) return '不同路径 id 相同'
      if (registry.get(a1.id)?.id !== a1.id) return '按 id 取不到'
      return null
    })

    await check('setTitle 生效（微信会设置「微信会话」）', async () => {
      const ws = await registry.resolveByPath(path.join(root, 'dsh_wechat'))
      if (!ws) return '解析失败'
      await ws.setTitle('微信会话')
      if (ws.title !== '微信会话') return `title 没更新：${ws.title}`
      return null
    })

    await check('根目录之外拒绝（不把任意宿主目录变成 cwd）', async () => {
      const outside = path.join(os.tmpdir(), 'aikm-ws-outside')
      if (await registry.resolveByPath(outside)) return 'resolve 越界成功了'
      try {
        await registry.create(outside)
        return 'create 越界成功了'
      } catch {
        /* expected */
      }
      return null
    })

    await check('list 至少包含根工作区', () => {
      const list = registry.list()
      if (!list.some((w) => path.resolve(w.path) === path.resolve(root))) return '根工作区不在 list 里'
      return null
    })

    return results
  })()
}
