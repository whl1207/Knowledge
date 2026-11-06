/**
 * pluginSessionRegistry.selftest.ts — 逻辑会话登记表的自测（纯逻辑）
 *
 * 盯住"换模型 / 重建 agent 后逻辑 id 不变"这条契约：它是 DSH 插件会话映射能跨重启、
 * 跨模型切换活下来的前提。这里不碰 Electron / agent-loop，只钉表本身。
 */

import { PluginSessionRegistry, PLUGIN_SESSION_PREVIOUS_LIMIT, PLUGIN_SESSION_REQUEST_LIMIT } from './pluginSessionRegistry'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

const model = (name: string) => ({ provider: 'ollama', model: name })

export function runPluginSessionRegistrySelfTest(): SelfTestResult[] {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null) => {
    try {
      const problem = fn()
      results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) })
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  check('upsert 幂等且能按物理 id 反查', () => {
    const reg = new PluginSessionRegistry()
    const a = reg.upsert({ id: 's1', agentId: 'a1', cwd: 'C:/w', now: 1 })
    const b = reg.upsert({ id: 's1', agentId: 'a1', now: 2 })
    if (a !== b) return '同 id 应返回同一条记录'
    if (reg.get('s1')?.createdAt !== 1) return 'createdAt 被覆盖'
    if (reg.getByAgent('a1')?.id !== 's1') return '反查失败'
    if (reg.size !== 1) return `size 应为 1，实际 ${reg.size}`
    return null
  })

  check('换物理 agent 时逻辑 id 不变、旧 id 进历史', () => {
    const reg = new PluginSessionRegistry()
    reg.upsert({ id: 's1', agentId: 'a1' })
    reg.setAgent('s1', 'a2')
    const rec = reg.get('s1')
    if (!rec) return '记录丢了'
    if (rec.agentId !== 'a2') return '物理 id 没换'
    if (rec.previousAgentIds[0] !== 'a1') return '旧物理 id 没进历史'
    if (reg.getByAgent('a1')) return '旧物理 id 还能反查（应删掉）'
    if (reg.getByAgent('a2')?.id !== 's1') return '新物理 id 反查失败'
    return null
  })

  check('历史物理 id 有上限（不无限增长）', () => {
    const reg = new PluginSessionRegistry()
    reg.upsert({ id: 's1', agentId: 'a0' })
    for (let i = 1; i <= 20; i++) reg.setAgent('s1', `a${i}`)
    const rec = reg.get('s1')
    if (!rec) return '记录丢了'
    if (rec.previousAgentIds.length > PLUGIN_SESSION_PREVIOUS_LIMIT) return `历史长度 ${rec.previousAgentIds.length} 超过上限`
    if (rec.previousAgentIds[0] !== 'a19') return '最近一次历史不在最前'
    return null
  })

  check('requestId 幂等：第二次返回 false', () => {
    const reg = new PluginSessionRegistry()
    reg.upsert({ id: 's1', agentId: 'a1' })
    if (!reg.rememberRequest('s1', 'r1')) return '首次应返回 true'
    if (reg.rememberRequest('s1', 'r1')) return '重复应返回 false'
    if (!reg.rememberRequest('s1', 'r2')) return '不同 requestId 应返回 true'
    return null
  })

  check('requestId 窗口有上限（老记录被挤掉）', () => {
    const reg = new PluginSessionRegistry()
    reg.upsert({ id: 's1', agentId: 'a1' })
    for (let i = 0; i < PLUGIN_SESSION_REQUEST_LIMIT + 5; i++) reg.rememberRequest('s1', `r${i}`)
    const rec = reg.get('s1')
    if (!rec) return '记录丢了'
    if (rec.requests.length > PLUGIN_SESSION_REQUEST_LIMIT) return '超过窗口上限'
    if (rec.requests[0] !== 'r5') return '最老的记录没被挤掉'
    return null
  })

  check('pendingModel 生效后清空，model 更新', () => {
    const reg = new PluginSessionRegistry()
    reg.upsert({ id: 's1', agentId: 'a1', model: model('m1') })
    reg.setPendingModel('s1', model('m2'))
    if (reg.get('s1')?.pendingModel?.model !== 'm2') return 'pending 没记上'
    reg.setModel('s1', model('m2'))
    const rec = reg.get('s1')
    if (rec?.model?.model !== 'm2') return 'model 没更新'
    if (rec?.pendingModel !== null) return 'pending 没清空'
    return null
  })

  check('list 按最近活跃排序', () => {
    const reg = new PluginSessionRegistry()
    reg.upsert({ id: 's1', agentId: 'a1', now: 10 })
    reg.upsert({ id: 's2', agentId: 'a2', now: 30 })
    reg.upsert({ id: 's3', agentId: 'a3', now: 20 })
    const ids = reg.list().map((r) => r.id)
    if (ids.join(',') !== 's2,s3,s1') return `排序不对：${ids.join(',')}`
    return null
  })

  check('remove / clear 清掉两张表', () => {
    const reg = new PluginSessionRegistry()
    reg.upsert({ id: 's1', agentId: 'a1' })
    reg.upsert({ id: 's2', agentId: 'a2' })
    reg.remove('s1')
    if (reg.get('s1')) return '按 id 仍能取到'
    if (reg.getByAgent('a1')) return '按物理 id 仍能取到'
    if (reg.size !== 1) return `size 应为 1，实际 ${reg.size}`
    reg.clear()
    if (reg.list().length !== 0) return 'clear 后 size 不为 0'
    if (reg.getByAgent('a2')) return 'clear 后仍能反查'
    return null
  })

  check('缺少 id / agentId 时 fail-loud', () => {
    const reg = new PluginSessionRegistry()
    try {
      reg.upsert({ id: '', agentId: 'a1' })
      return '空 id 没抛错'
    } catch {
      /* expected */
    }
    try {
      reg.upsert({ id: 's1', agentId: '' })
      return '空 agentId 没抛错'
    } catch {
      /* expected */
    }
    return null
  })

  return results
}
