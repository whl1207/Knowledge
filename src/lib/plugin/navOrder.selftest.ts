/**
 * navOrder.selftest.ts — 「插件拖动排序 → 导航栏顺序」自测
 *
 * 断言的是这条链路的边界：
 * - 用户顺序能稳定地套到**已注册的表**上：排过序的插件按用户顺序靠前，没排过的按注册顺序排在后面；
 * - 同一插件的多个条目（owner = plugin:<id>）保持它们之间的相对顺序；
 * - 拖动落点用 **id** 而不是下标 —— 搜索过滤后列表只显示一部分，用下标重排全量列表必然错位，
 *   未显示的插件必须留在原位；
 * - 「放到最后」= 显式把该插件排到末尾，而不是从顺序里删掉（删掉会退回注册顺序，位置反而更靠前）；
 * - 顺序落盘后能读回、去重、丢掉已卸载的 id；「恢复默认」把顺序清空；
 * - 脏数据（非数组 / 非字符串 / 重复项）不抛错。
 *
 * 用法：`node scripts/run-selftests.mjs navOrder`
 */

import {
  PLUGIN_ORDER_LS_KEY,
  applyPluginOrder,
  commitPluginOrder,
  mergeWithAll,
  parsePluginOrder,
  pluginOrder,
  reorderPluginIds,
  resetPluginOrderCache,
  setPluginOrder,
  sortPluginsByOrder,
} from './navOrder'
import type { SlotDefinition } from './slots'

export interface NavOrderCase {
  name: string
  ok: boolean
  detail?: string
}

/** node 环境没有 localStorage：装一个最小实现（被测模块只用到 getItem / setItem） */
function installLocalStorageStub(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
  }
  return store
}

/** 造一个主面板槽位条目 */
function entry(key: string, owner: string): SlotDefinition {
  return { key, titleZh: key, titleEn: key, icon: 'fa fa-square', owner }
}

/** 每个用例都从「没有自定义顺序」开始：避免前面的用例污染后面的期望值 */
function fresh(store: Map<string, string>): void {
  store.delete(PLUGIN_ORDER_LS_KEY)
  resetPluginOrderCache()
}

export function runNavOrderSelfTest(): NavOrderCase[] {
  const cases: NavOrderCase[] = []
  const store = installLocalStorageStub()
  const push = (name: string, got: unknown, want: unknown) =>
    cases.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), detail: `got=${JSON.stringify(got)} want=${JSON.stringify(want)}` })

  // ---------- 纯解析 ----------
  push('解析：正常数组', parsePluginOrder('["a","b"]'), ['a', 'b'])
  push('解析：去重 + 丢空串', parsePluginOrder('["a","","a","b"]'), ['a', 'b'])
  push('解析：非数组按空处理', parsePluginOrder('{"a":1}'), [])
  push('解析：坏 JSON 按空处理（不抛错）', parsePluginOrder('{oops'), [])
  push('解析：非字符串项被丢掉', parsePluginOrder('["a",1,null,{"b":2},"c"]'), ['a', 'c'])

  // ---------- 落盘 / 读回 / 恢复默认 ----------
  fresh(store)
  push('初始：没有自定义顺序', pluginOrder(), [])
  push('落盘：写入顺序返回 true', setPluginOrder(['c', 'a']), true)
  push('落盘：重复写入同一顺序返回 false（不无谓刷新）', setPluginOrder(['c', 'a']), false)
  resetPluginOrderCache()
  push('读回：落盘后被持久化', pluginOrder(), ['c', 'a'])
  push('落盘：空数组 = 恢复默认', setPluginOrder([]), true)
  push('恢复默认后顺序为空', pluginOrder(), [])
  push('落盘内容就是顺序数组本身', store.get(PLUGIN_ORDER_LS_KEY), '[]')

  // ---------- 拖动重排：插到前面 / 后面 / 末尾 ----------
  fresh(store)
  push('拖动：A 插到 C 前面', reorderPluginIds('a', 'c', false, ['a', 'b', 'c']), ['b', 'a', 'c'])
  push('拖动：A 插到 C 后面', reorderPluginIds('a', 'c', true, ['a', 'b', 'c']), ['b', 'c', 'a'])
  push('拖动：C 放到最前面', reorderPluginIds('c', 'a', false, ['a', 'b', 'c']), ['c', 'a', 'b'])
  push('拖动：落到末尾（无目标）', reorderPluginIds('a', '', false, ['a', 'b', 'c']), ['b', 'c', 'a'])
  push('拖动：单插件列表不变', reorderPluginIds('a', '', false, ['a']), ['a'])
  // 搜索过滤：列表只显示 [a, c]，此时把 c 拖到 a 前面，b（未显示）必须留在原位而不是被甩到前面
  push('拖动（过滤后列表）：未显示的插件保持原位', reorderPluginIds('c', 'a', false, ['a', 'b', 'c']), ['c', 'a', 'b'])

  // ---------- 全量合并 ----------
  push('合并：未覆盖的按原顺序追加', mergeWithAll(['c'], ['a', 'b', 'c']), ['c', 'a', 'b'])
  push('合并：已卸载的 id 被丢掉', mergeWithAll(['gone', 'a'], ['a', 'b']), ['a', 'b'])

  // ---------- commitPluginOrder：想要的顺序 → 落盘的全量顺序 ----------
  fresh(store)
  commitPluginOrder(['c', 'b', 'a'], ['a', 'b', 'c'])
  push('提交：全量顺序落盘', pluginOrder(), ['c', 'b', 'a'])
  fresh(store)
  commitPluginOrder(['b'], ['a', 'b', 'c'])
  push('提交：只给一个 → 其余按列表顺序补在后面', pluginOrder(), ['b', 'a', 'c'])
  fresh(store)
  commitPluginOrder(['b', 'gone'], ['a', 'b'])
  push('提交：丢掉不存在的 id', pluginOrder(), ['b', 'a'])
  fresh(store)
  commitPluginOrder([], ['a', 'b'])
  push('提交：空 = 恢复默认（不留下自定义顺序）', pluginOrder(), [])

  // ---------- 套用到面板条目上（内置面板不参与重排） ----------
  fresh(store)
  const panels = [
    entry('主页', 'core'),
    entry('知识管理', 'core'),
    entry('插件丙面板', 'plugin:c'),
    entry('插件甲面板', 'plugin:a'),
    entry('插件乙面板', 'plugin:b'),
  ]
  push(
    '未自定义顺序：条目顺序不变',
    applyPluginOrder(panels).map((e) => e.key),
    ['主页', '知识管理', '插件丙面板', '插件甲面板', '插件乙面板'],
  )

  setPluginOrder(['b', 'a'])
  push(
    '自定义 b,a：排过的按用户顺序靠前，未排过的 c 排在后面，内置保持原位',
    applyPluginOrder(panels).map((e) => e.key),
    ['主页', '知识管理', '插件乙面板', '插件甲面板', '插件丙面板'],
  )

  // 「放到最后」是显式排到末尾（而不是从顺序里删掉）
  fresh(store)
  const movedToEnd = reorderPluginIds('a', '', false, ['a', 'b', 'c'])
  push('拖动到末尾：得到 b,c,a', movedToEnd, ['b', 'c', 'a'])
  commitPluginOrder(movedToEnd, ['a', 'b', 'c'])
  push('拖动到末尾：顺序已落盘', pluginOrder(), ['b', 'c', 'a'])
  push(
    '自定义 b,c,a（c 显式放到最后）：c 确实排在最后',
    applyPluginOrder(panels).map((e) => e.key),
    ['主页', '知识管理', '插件乙面板', '插件丙面板', '插件甲面板'],
  )

  // 同一插件的多个条目：相对顺序不能乱
  fresh(store)
  setPluginOrder(['x', 'y'])
  const multi = [
    entry('y1', 'plugin:y'),
    entry('x1', 'plugin:x'),
    entry('y2', 'plugin:y'),
    entry('x2', 'plugin:x'),
  ]
  push('同插件多条目：插件间按用户顺序、插件内保原序', applyPluginOrder(multi).map((e) => e.key), ['x1', 'x2', 'y1', 'y2'])

  fresh(store)
  setPluginOrder(['a'])
  push(
    '内置面板（owner=core）不被重排',
    applyPluginOrder([entry('主页', 'core'), entry('学习', 'core'), entry('A', 'plugin:a')]).map((e) => e.key),
    ['主页', '学习', 'A'],
  )

  // ---------- 插件列表排序（插件管理页左侧列表） ----------
  fresh(store)
  const plugins = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  push('列表排序：无自定义顺序 = 原样', sortPluginsByOrder(plugins).map((p) => p.id), ['a', 'b', 'c'])
  setPluginOrder(['c'])
  push('列表排序：排过的提前、没排过的保持相对位置', sortPluginsByOrder(plugins).map((p) => p.id), ['c', 'a', 'b'])
  fresh(store)
  push('列表排序：清空后回到原样', sortPluginsByOrder(plugins).map((p) => p.id), ['a', 'b', 'c'])

  return cases
}
