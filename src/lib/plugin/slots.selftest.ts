/**
 * slots.selftest.ts — 槽位注册表的「重复 key」边界自测
 *
 * 背景（真实故障）：插件界面半边 `apply()` 只注册一次 `panel.main`，但重载时旧句柄的 disposer
 * 偶尔没跑到，残留条目会让下一次注册抛「key 重复」→ 用户点「重新载入」永远失败。
 * 因此注册表对**同一插件**的重复 key 做「接管残留」，而真正的接线错误必须继续响亮地报错。
 *
 * 断言：
 *  1) 同一 owner 重复注册同一个 key → 不抛错，只留最新一条（旧条目的子槽位一并撤销）；
 *  2) 不同插件抢同一个 key → 抛错，且报错里能同时看到双方 owner（否则不知道该改谁）；
 *  3) 内置条目（owner = core / 未提供）重复注册 → 仍然抛错；
 *  4) 同一 owner 的不同 key → 两条都保留；
 *  5) 正常 dispose 之后重新注册 → 不受影响。
 *
 * 用法：`node scripts/run-selftests.mjs slots`
 */

import { slotRegistry, type SlotHandleImpl } from './slots'

export interface SlotsCase {
  name: string
  ok: boolean
  detail?: string
}

let seq = 0

/** 每个用例一个独立槽位：不碰内置槽位，也不必 reset 全局注册表 */
function newSlot(): SlotHandleImpl {
  seq += 1
  return slotRegistry.declare(`selftest.slots.${seq}`, 'list')
}

function entry(component: unknown, owner: string, extra: Record<string, unknown> = {}) {
  return { key: 'same-key', titleZh: '自测条目', titleEn: 'selftest', icon: 'fa fa-square', component, owner, ...extra }
}

function throws(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export async function runSlotsSelfTest(): Promise<SlotsCase[]> {
  const cases: SlotsCase[] = []
  const push = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 1) 同一 owner 重复注册：接管残留，不抛错
  {
    const scope = newSlot()
    const first = scope.register(entry('old', 'plugin:stale'))
    const second = scope.register(entry('new', 'plugin:stale'))
    const all = slotRegistry.entriesAll(scope.name)
    push('同一插件重复注册 → 不抛错', true)
    push('同一插件重复注册 → 只留最新一条', all.length === 1 && all[0].component === 'new', `len=${all.length}`)
    // 旧 disposer 仍可安全调用（幂等），不能把新条目删掉
    first()
    push('旧 disposer 不会误删新条目', slotRegistry.entriesAll(scope.name).length === 1)
    second()
    push('条目 disposer 正常移除', slotRegistry.entriesAll(scope.name).length === 0)
    scope.dispose()
  }

  // 2) 不同插件抢同一个 key：必须抛错，且带上双方 owner
  {
    const scope = newSlot()
    scope.register(entry('a', 'plugin:alpha'))
    const message = throws(() => scope.register(entry('b', 'plugin:beta')))
    push('不同插件抢同一 key → 抛错', !!message, message ?? '(未抛错)')
    push(
      '报错里带双方 owner',
      !!message && message.includes('plugin:alpha') && message.includes('plugin:beta'),
      message ?? '',
    )
    scope.dispose()
  }

  // 3) 内置条目（core / 未提供 owner）重复注册：照旧抛错
  {
    const scope = newSlot()
    scope.register(entry('a', 'core'))
    const message = throws(() => scope.register(entry('b', 'core')))
    push('内置条目重复注册 → 仍然抛错', !!message, message ?? '(未抛错)')
    scope.dispose()
  }
  {
    const scope = newSlot()
    scope.register(entry('a', ''))
    const message = throws(() => scope.register(entry('b', '')))
    push('无 owner 的重复注册 → 仍然抛错', !!message, message ?? '(未抛错)')
    scope.dispose()
  }

  // 4) 同一 owner 的不同 key：互不影响
  {
    const scope = newSlot()
    scope.register(entry('a', 'plugin:multi'))
    scope.register({ ...entry('b', 'plugin:multi'), key: 'another-key' })
    push('同一插件不同 key → 都保留', slotRegistry.entriesAll(scope.name).length === 2)
    scope.dispose()
  }

  // 5) 正常卸载后重新注册：行为不变
  {
    const scope = newSlot()
    const dispose = scope.register(entry('a', 'plugin:reload'))
    dispose()
    const message = throws(() => scope.register(entry('b', 'plugin:reload')))
    push('dispose 后重新注册 → 不抛错', message === null, message ?? '')
    push('dispose 后重新注册 → 只有一条', slotRegistry.entriesAll(scope.name).length === 1)
    scope.dispose()
  }

  return cases
}
