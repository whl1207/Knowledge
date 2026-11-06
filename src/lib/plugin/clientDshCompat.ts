/**
 * clientDshCompat.ts — DSH 插件界面半边的 shim（P5）
 *
 * DSH 的 client bundle 是**经典脚本**（不是 ESM）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) → { apply, inject }
 * 它依赖 9 个词的平台表（react / react-dom / …）与 `ctx.slots`。
 *
 * 这个 shim 做四件事：
 * 1. 求值经典脚本（`new Function` 参数遮蔽 `require` / `fetch`）；
 * 2. 提供 React 18 与三个 UI 原子（Button / Input / Pill）的桩；
 * 3. 把 `settings.section` / `settings.general.item` 映射到 AI-KM 的
 *    `settings.tab` / `settings.card`，并用 Vue 包一层 React root；
 * 4. **作用域 fetch**：把 `/api/*` 重写到该插件的 `webServer`（`127.0.0.1:<port>`），
 *    否则生产环境 `file://` 下相对路径必然失败。
 *
 * 不做：通用 React 容器、79 个槽位映射、DSH 的 store / typert。跑不动就按约定重写设置页。
 */

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import { defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import type { PluginSnapshot } from '@/types/plugin'
import type { ClientPluginContext } from './runtime'
import { installDshThemeCompat } from './dshThemeCompat'
import { coreSlot } from './slots'
import { SETTINGS_CARD_SLOT, SETTINGS_TAB_SLOT } from './coreSlots'
import { slotRegistry } from './slots'

type AnyComponent = (props: any) => any

/** DSH 平台表里我们能给的三个 UI 原子（其余原子没有对应物） */
function passthrough(tag: string): AnyComponent {
  return function Stub(props: any) {
    const { variant: _variant, size: _size, children, ...rest } = props || {}
    return React.createElement(tag, rest, children)
  }
}

const Button = passthrough('button')
const Input = passthrough('input')
const Pill = passthrough('span')

/** 把 React 组件包成 Vue 组件（挂载 / 卸载 root；props 只在挂载时求值一次） */
function reactToVue(component: AnyComponent, getProps?: () => Record<string, unknown>): Component {
  return defineComponent({
    name: 'AikmDshReactSlot',
    setup() {
      const el = ref<HTMLElement | null>(null)
      let root: ReturnType<typeof createRoot> | null = null
      onMounted(() => {
        if (!el.value) return
        root = createRoot(el.value)
        root.render(React.createElement(component, (getProps?.() || {}) as any))
      })
      onBeforeUnmount(() => {
        try {
          root?.unmount()
        } catch {
          /* React 可能已卸载 */
        }
        root = null
      })
      return () => h('div', { ref: el, class: 'aikm-dsh-react-slot' })
    },
  })
}

/** 每个插件一个 scoped fetch：相对路径 → 插件的回环 webServer（实现见 scopedFetch.ts） */
export { createScopedFetch } from './scopedFetch'

/** 求值一个 DSH client bundle，返回它的导出（`{ apply, inject }`） */
export function evaluateDshClientBundle(code: string, scopedFetch: typeof fetch): any {
  let loaded: any = null
  const shim = {
    load(mod: any): void {
      loaded = mod
    },
  }
  const requireStub = (name: string): any => {
    switch (name) {
      case 'react':
        return React
      case 'react-dom':
        return ReactDOM
      case 'react-dom/client':
        return { createRoot }
      case 'react/jsx-runtime':
        return jsxRuntime
      case 'react/jsx-dev-runtime':
        return jsxRuntime
      case '@deepseek-ai/dsh-client-ui-primitives':
        return { Button, Input, Pill }
      case '@deepseek-ai/cordis':
        return {}
      default:
        throw new Error(`DSH 插件要求的模块在 AI-KM 侧不存在：${name}（请把它写进 dsh.client.external 或改用原生插件）`)
    }
  }

  const win: any = window
  const doc: any = (globalThis as any).document
  const previous = win.__ModuleLoader__
  win.__ModuleLoader__ = shim
  try {
    const fn = new Function('window', 'document', 'fetch', 'require', '__ModuleLoader__', code)
    fn(win, doc, scopedFetch, requireStub, shim)
  } finally {
    if (previous === undefined) delete win.__ModuleLoader__
    else win.__ModuleLoader__ = previous
  }
  if (!loaded || typeof loaded.factory !== 'function') {
    throw new Error('DSH client bundle 没有调用 __ModuleLoader__.load({ factory })')
  }
  const exports = loaded.factory(requireStub)
  if (!exports || typeof exports.apply !== 'function') {
    throw new Error('DSH client bundle 的 factory 没有返回 apply(ctx)')
  }
  return exports
}

/** 槽位映射：只映射语义真的对得上的两个 */
function targetOfSlot(name: string): { slot: string; card: boolean } | null {
  if (name === 'settings.section') return { slot: SETTINGS_TAB_SLOT, card: false }
  if (name === 'settings.general.item') return { slot: SETTINGS_CARD_SLOT, card: true }
  return null
}

function labelOf(label: unknown, fallback: string): string {
  try {
    if (typeof label === 'function') {
      const got = (label as () => unknown)()
      return typeof got === 'string' && got.trim() ? got : fallback
    }
  } catch {
    /* 取不到就用 fallback */
  }
  return typeof label === 'string' && label.trim() ? label : fallback
}

/**
 * 构造 DSH client 的 ctx（只覆盖两个插件真正用到的部分）。
 *
 * `inject = ['slots']` 由调用方检查；这里只给 slots / effect / config / plugin / on。
 */
export function createDshClientContext(
  base: ClientPluginContext,
  snapshot: PluginSnapshot,
): {
  ctx: any
  dispose: () => Promise<void>
} {
  const disposers: Array<() => void | Promise<void>> = []
  const track = (off: () => void | Promise<void>) => {
    disposers.push(off)
    return off
  }

  // DSH 设计令牌（--dsw-*）→ AI-KM 主题；只注入一次，作用于 .aikm-dsh-react-slot
  installDshThemeCompat()

  const registerMapped = (options: any, Component: AnyComponent): (() => void) => {
    const slotName = String(options?.name || '')
    const target = targetOfSlot(slotName)
    if (!target) {
      throw new Error(
        `DSH 插件的槽位 ${slotName || '(空)'} 在 AI-KM 没有对应物（只支持 settings.section / settings.general.item）`,
      )
    }
    const key = String(options?.id || options?.key || snapshot.id)
    const title = labelOf(options?.label, key)
    const def: any = {
      key,
      titleZh: title,
      titleEn: title,
      icon: target.card ? undefined : 'fa fa-plug',
      order: Number(options?.order) || 0,
      component: reactToVue(Component, typeof options?.inject === 'function' ? options.inject : undefined),
      owner: `plugin:${snapshot.id}`,
      ...(target.card ? { meta: { target: 'view' } } : {}),
    }
    return coreSlot(target.slot).register(def)
  }

  const ctx: any = {
    config: snapshot.config ?? {},
    plugin: { id: snapshot.id, name: snapshot.name, version: snapshot.version, dir: snapshot.dir },
    effect(fn: () => unknown): () => void {
      return base.effect(() => {
        const result = fn()
        if (typeof result === 'function') return result as () => void
        if (result && typeof (result as any)[Symbol.iterator] === 'function') {
          const offs = Array.from(result as Iterable<unknown>).filter((x): x is () => void => typeof x === 'function')
          return () => {
            for (const off of offs.reverse()) off()
          }
        }
        return undefined
      })
    },
    on: base.on,
    slots: {
      /** 槽位已声明就立刻执行；没声明则等下一拍（核心槽位在启动时已声明） */
      inject(name: string, cb: () => (() => void) | void): () => void {
        const target = targetOfSlot(String(name))
        if (!target) return () => {}
        const run = () => {
          try {
            const off = cb()
            if (typeof off === 'function') track(off)
          } catch {
            /* 由调用方的 apply 兜底 */
          }
        }
        if (slotRegistry.isDeclared(target.slot)) queueMicrotask(run)
        else queueMicrotask(run)
        return () => {}
      },
      register(options: any, Component: AnyComponent): () => void {
        return track(registerMapped(options, Component))
      },
    },
  }

  return {
    ctx,
    async dispose() {
      for (const off of disposers.splice(0).reverse()) {
        try {
          await off()
        } catch {
          /* 清理失败不阻断其余 */
        }
      }
    },
  }
}
