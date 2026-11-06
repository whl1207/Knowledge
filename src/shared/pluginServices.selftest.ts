/**
 * pluginServices.selftest.ts — 服务面契约的**一致性自测**（纯逻辑）
 *
 * 盯住三类漂移：
 * 1. 服务名清单、服务元数据、类型映射三者不同步（加了一个忘了另一个）；
 * 2. 服务声明的权限不在 `SUPPORTED_PLUGIN_PERMISSIONS` 里（作者声明了却装不上）；
 * 3. 界面半边的"可见 / 不存在"两张表与服务元数据矛盾。
 */

import {
  PLUGIN_CLIENT_ABSENT_SERVICES,
  PLUGIN_CLIENT_VISIBLE_SERVICES,
  PLUGIN_GLOBAL_EVENTS,
  PLUGIN_SERVICE_ERROR_CODES,
  PLUGIN_SERVICE_NAMES,
  PLUGIN_SERVICES,
  PluginServiceError,
  isPluginServiceError,
  isPluginServiceErrorCode,
} from './pluginServices'
import { SUPPORTED_PLUGIN_PERMISSIONS } from './pluginManifest'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runPluginServicesSelfTest(): SelfTestResult[] {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null) => {
    try {
      const problem = fn()
      results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) })
    } catch (e) {
      results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  check('每个服务名恰好一条元数据', () => {
    const names = new Set<string>()
    for (const spec of PLUGIN_SERVICES) {
      if (names.has(spec.name)) return `重复的服务元数据：${spec.name}`
      names.add(spec.name)
    }
    const declared = PLUGIN_SERVICE_NAMES as readonly string[]
    const missing = declared.filter((n) => !names.has(n))
    const extra = Array.from(names).filter((n) => !declared.includes(n))
    if (missing.length) return `缺少元数据：${missing.join(', ')}`
    if (extra.length) return `元数据里有未声明的服务：${extra.join(', ')}`
    return null
  })

  check('服务权限都在受支持清单里', () => {
    const supported = new Set<string>(SUPPORTED_PLUGIN_PERMISSIONS)
    for (const spec of PLUGIN_SERVICES) {
      if (spec.permission === null) continue
      if (!supported.has(spec.permission)) return `${spec.name} 声明了未支持的权限 ${spec.permission}`
    }
    return null
  })

  check('界面半边可见表与元数据一致', () => {
    const both = PLUGIN_SERVICES.filter((s) => s.half === 'both').map((s) => s.name).sort()
    const visible = [...PLUGIN_CLIENT_VISIBLE_SERVICES].sort()
    if (both.join(',') !== visible.join(',')) {
      return `可见表不一致：both=${both.join(',')} visible=${visible.join(',')}`
    }
    return null
  })

  check('界面半边不存在表覆盖所有主进程服务', () => {
    const mainOnly = PLUGIN_SERVICES.filter((s) => s.half === 'main').map((s) => s.name)
    const missing = mainOnly.filter((n) => !(n in PLUGIN_CLIENT_ABSENT_SERVICES))
    if (missing.length) return `缺少"不存在"说明：${missing.join(', ')}`
    return null
  })

  check('错误码唯一且判定函数可用', () => {
    const unique = new Set(PLUGIN_SERVICE_ERROR_CODES)
    if (unique.size !== PLUGIN_SERVICE_ERROR_CODES.length) return '错误码有重复'
    for (const code of PLUGIN_SERVICE_ERROR_CODES) {
      if (!isPluginServiceErrorCode(code)) return `判定函数不认自己的错误码：${code}`
    }
    if (isPluginServiceErrorCode('NOT_A_CODE')) return '判定函数把未知字符串当成错误码'
    return null
  })

  check('PluginServiceError 携带 code / service / permission', () => {
    const err = new PluginServiceError('PLUGIN_PERMISSION_DENIED', 'nope', {
      service: 'sessionController',
      permission: 'agent.control',
    })
    if (err.code !== 'PLUGIN_PERMISSION_DENIED') return 'code 不对'
    if (err.service !== 'sessionController') return 'service 不对'
    if (err.permission !== 'agent.control') return 'permission 不对'
    if (!isPluginServiceError(err)) return '判定函数不认自己的错误实例'
    if (!isPluginServiceError({ code: 'PLUGIN_NOT_FOUND', message: 'x' })) return '判定函数不认同形状普通对象'
    if (isPluginServiceError(new Error('plain'))) return '判定函数把普通 Error 当服务错误'
    return null
  })

  check('全局事件名唯一且非空', () => {
    if (!PLUGIN_GLOBAL_EVENTS.length) return '没有全局事件'
    if (new Set(PLUGIN_GLOBAL_EVENTS).size !== PLUGIN_GLOBAL_EVENTS.length) return '事件名有重复'
    return null
  })

  return results
}
