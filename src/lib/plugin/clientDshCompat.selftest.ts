/**
 * clientDshCompat.selftest.ts — DSH 界面半边 shim 的自测
 *
 * 覆盖：经典脚本求值（__ModuleLoader__）、require 平台表、槽位映射（settings.section →
 * settings.tab / settings.general.item → settings.card）与撤销。
 * 不做真实 DOM 挂载（React root 需要浏览器）。
 */

import { declareCoreSlots, slotRegistry } from './slots'
import {
  createDshClientContext,
  evaluateDshClientBundle,
} from './clientDshCompat'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

const log: any = { debug() {}, info() {}, warn() {}, error() {} }

export function runClientDshCompatSelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) =>
    Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))

  return (async () => {
    declareCoreSlots()
    const previousWindow = (globalThis as any).window
    ;(globalThis as any).window = {}

    await check('经典脚本：__ModuleLoader__ + factory(require) 可求值', () => {
      const code = [
        "window.__ModuleLoader__.load({ id: 'demo', factory: function (require) {",
        "  const React = require('react')",
        '  return { apply: function () {}, hasReact: !!React.createElement }',
        '} })',
      ].join('\n')
      const fakeFetch = (async () => ({})) as unknown as typeof fetch
      const exports = evaluateDshClientBundle(code, fakeFetch)
      if (typeof exports.apply !== 'function') return '没有 apply'
      if (!exports.hasReact) return 'require(react) 没给到 React'
      return null
    })

    await check('未知 require 明确抛错（不是静默 undefined）', () => {
      const code = [
        "window.__ModuleLoader__.load({ id: 'demo2', factory: function (require) {",
        "  require('@deepseek-ai/dsh-client-store')",
        '  return { apply: function () {} }',
        '} })',
      ].join('\n')
      try {
        evaluateDshClientBundle(code, (async () => ({})) as unknown as typeof fetch)
        return '未知模块没抛错'
      } catch (e) {
        if (!/不存在/.test(e instanceof Error ? e.message : String(e))) return '错误信息不对'
      }
      return null
    })

    await check('settings.section → settings.tab，且可撤销', () => {
      const base: any = {
        config: {},
        effect: (fn: () => unknown) => {
          fn()
          return () => {}
        },
        on: () => () => {},
      }
      const snapshot: any = { id: 'demo', name: 'Demo', version: '1.0.0', dir: '/x', config: {} }
      const handle = createDshClientContext(base, snapshot)
      const Demo = () => null
      const off = handle.ctx.slots.register({ name: 'settings.section', id: 'demo-tab', label: '演示' }, Demo)
      const entry = slotRegistry.snapshot().find((s) => s.slot === 'settings.tab')?.entries.find((e) => e.key === 'demo-tab')
      if (!entry) return '没有注册到 settings.tab'
      if (!entry.hasComponent) return '条目没有组件'
      off()
      const after = slotRegistry.snapshot().find((s) => s.slot === 'settings.tab')?.entries.find((e) => e.key === 'demo-tab')
      if (after) return '撤销后条目还在'
      return null
    })

    await check('settings.general.item → settings.card（meta.target=view）', () => {
      const base: any = {
        config: {},
        effect: (fn: () => unknown) => {
          fn()
          return () => {}
        },
        on: () => () => {},
      }
      const snapshot: any = { id: 'demo', name: 'Demo', version: '1.0.0', dir: '/x', config: {} }
      const handle = createDshClientContext(base, snapshot)
      const off = handle.ctx.slots.register({ name: 'settings.general.item', id: 'demo-card', label: '卡片' }, () => null)
      const state = slotRegistry.snapshot().find((s) => s.slot === 'settings.card')
      const entry = state?.entries.find((e) => e.key === 'demo-card')
      if (!entry) return '没有注册到 settings.card'
      off()
      return null
    })

    await check('未映射槽位明确抛错（不静默丢弃）', () => {
      const base: any = { config: {}, effect: (fn: () => unknown) => { fn(); return () => {} }, on: () => () => {} }
      const snapshot: any = { id: 'demo', name: 'Demo', version: '1.0.0', dir: '/x', config: {} }
      const handle = createDshClientContext(base, snapshot)
      try {
        handle.ctx.slots.register({ name: 'main', id: 'x' }, () => null)
        return '未知槽位没抛错'
      } catch (e) {
        if (!/没有对应物/.test(e instanceof Error ? e.message : String(e))) return '错误信息不对'
      }
      return null
    })

    if (previousWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = previousWindow

    return results
  })()
}
