/**
 * chatDock.selftest.ts — 主页右侧栏（dock）纯逻辑自测（不依赖 Vue / DOM）
 *
 * 覆盖：默认状态（**空面板**，与新标签页一致）、存档归一化（脏数据 / 旧存档 / 未知类型 /
 * 重复 id / 空标签保持空）、宽度夹取、加标签 / 关标签后当前标签的落点、标签命名、
 * 以及「值没变就返回原对象」（Vue 里可以据此避免无意义的重渲染与落盘）。
 *
 * 用法（开发期）：
 *   import { runChatDockSelfTest } from '@/shared/chatDock.selftest'
 *   console.table(runChatDockSelfTest())
 * 或命令行：`node scripts/run-selftests.mjs chatDock`
 */

import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  activateDockTab,
  activeDockTab,
  addDockTab,
  clampDockWidth,
  closeDockTab,
  createDockTab,
  defaultDockState,
  dockTabTitle,
  normalizeDockState,
  setDockOpen,
  setDockWidth,
  type ChatDockState,
} from './chatDock'

export interface ChatDockCase {
  name: string
  ok: boolean
  detail?: string
}

/** 造一个「三个标签都在」的状态（多数用例的基准） */
function threeTabs(seed = 1000): ChatDockState {
  const s = defaultDockState()
  const files = createDockTab('files', [], seed)
  const terminal = createDockTab('terminal', [files], seed + 1)
  const browser = createDockTab('browser', [files, terminal], seed + 2)
  return { open: true, width: DOCK_DEFAULT_WIDTH, tabs: [files, terminal, browser], activeTabId: files.id }
}

export function runChatDockSelfTest(): ChatDockCase[] {
  const cases: ChatDockCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 宽度夹取
  add('宽度：NaN → 默认值', clampDockWidth('abc') === DOCK_DEFAULT_WIDTH)
  add('宽度：undefined → 默认值', clampDockWidth(undefined) === DOCK_DEFAULT_WIDTH)
  add('宽度：过小 → 下限', clampDockWidth(10) === DOCK_MIN_WIDTH)
  add('宽度：过大 → 上限', clampDockWidth(99999) === DOCK_MAX_WIDTH)
  add('宽度：合法值四舍五入保留', clampDockWidth(411.6) === 412, String(clampDockWidth(411.6)))
  add('宽度：字符串数字可用', clampDockWidth('520') === 520)

  // 2. 默认状态：空面板（与新标签页一样，用户自己选使用方式）+ 默认收起
  {
    const s = defaultDockState()
    add('默认：收起状态', s.open === false)
    add('默认：宽度为默认值', s.width === DOCK_DEFAULT_WIDTH)
    add('默认：没有任何标签（空面板）', s.tabs.length === 0, `tabs=${s.tabs.length}`)
    add('默认：没有当前标签', s.activeTabId === undefined, String(s.activeTabId))
    add('默认：activeDockTab 为空', activeDockTab(s) === undefined)
  }

  // 3. 标签 id 冲突时自动加序号
  {
    const first = createDockTab('terminal', [], 500)
    const second = createDockTab('terminal', [first], 500)
    const third = createDockTab('terminal', [first, second], 500)
    add('id：同种子重复时自动加序号', second.id === `${first.id}-2` && third.id === `${first.id}-3`, `${first.id} / ${second.id} / ${third.id}`)
    add('id：类型前缀正确', first.id.startsWith('terminal-'))
  }

  // 4. 归一化：旧存档 / 脏数据
  {
    add('归一化：undefined → 默认（旧存档没有 dock 字段）', normalizeDockState(undefined).tabs.length === 0)
    add('归一化：字符串 → 默认', normalizeDockState('nope').tabs.length === 0)
    add('归一化：null → 默认', normalizeDockState(null).tabs.length === 0)

    const dirty = normalizeDockState({
      open: 'yes',
      width: 5,
      activeTabId: '不存在的标签',
      tabs: [
        { id: 'a', kind: 'files' },
        { id: 'b', kind: '未知类型' },
        { id: 'a', kind: 'terminal' },
        { id: '', kind: 'terminal' },
        null,
        { id: 'c', kind: 'browser', title: '  我的网页  ' },
      ],
    })
    add('归一化：open 只认 true', dirty.open === false)
    add('归一化：宽度被夹到下限', dirty.width === DOCK_MIN_WIDTH, String(dirty.width))
    add('归一化：丢掉未知类型 / 重复 id / 空 id', dirty.tabs.map((t) => t.id).join(',') === 'a,c', dirty.tabs.map((t) => t.id).join(','))
    add('归一化：当前标签失效 → 回落第一个', dirty.activeTabId === 'a')
    add('归一化：自定义标题去空白', dirty.tabs[1].title === '我的网页', dirty.tabs[1].title)

    const empty = normalizeDockState({ tabs: [] })
    add('归一化：没有标签就保持空（不再兜底文件面板）', empty.tabs.length === 0 && empty.activeTabId === undefined)

    const openTrue = normalizeDockState({ open: true, tabs: [{ id: 'x', kind: 'terminal' }] })
    add('归一化：open=true 保留，单标签生效', openTrue.open === true && openTrue.activeTabId === 'x')

    // 旧版本会预置 文件/终端/浏览器 三标签：现在默认空面板，老存档要清掉这层预置
    const seeded = normalizeDockState({
      open: true,
      activeTabId: 'files-1',
      tabs: [
        { id: 'files-1', kind: 'files' },
        { id: 'terminal-2', kind: 'terminal' },
        { id: 'browser-3', kind: 'browser' },
      ],
    })
    add('归一化：清掉旧版自动预置的三标签', seeded.tabs.length === 0 && seeded.activeTabId === undefined)

    const userMade = normalizeDockState({
      open: true,
      activeTabId: 't1',
      tabs: [
        { id: 't1', kind: 'files', title: '我的文件' },
        { id: 't2', kind: 'terminal' },
        { id: 't3', kind: 'browser' },
      ],
    })
    add('归一化：带自定义名的三标签不会被误清', userMade.tabs.length === 3 && userMade.activeTabId === 't1')
  }

  // 5. 加标签：追加 + 切过去 + 自动展开
  {
    const s0 = defaultDockState()
    const s1 = addDockTab(s0, 'terminal', 3000)
    add('加标签：空面板 → 1 个标签', s1.tabs.length === 1)
    add('加标签：自动切到新标签', activeDockTab(s1)?.kind === 'terminal')
    add('加标签：自动展开右侧栏', s1.open === true)
    add('加标签：不原地修改原状态', s0.tabs.length === 0)
    const s2 = addDockTab(s1, 'files', 3001)
    add('加标签：同名类型可多个且各占一个 id', s2.tabs.length === 2 && s2.tabs[0].id !== s2.tabs[1].id)
  }

  // 6. 关标签：当前标签的落点
  {
    const base = threeTabs()
    const [t1, t2, t3] = base.tabs.map((t) => t.id)
    const closeOther = closeDockTab(base, t2)
    add('关标签：关掉非当前标签，当前不变', closeOther.activeTabId === t1 && closeOther.tabs.length === 2)

    const activeMiddle = closeDockTab({ ...base, activeTabId: t2 }, t2)
    add('关标签：关当前 → 切到右邻', activeMiddle.activeTabId === t3, String(activeMiddle.activeTabId))

    const activeLast = closeDockTab({ ...base, activeTabId: t3 }, t3)
    add('关标签：关最后一个 → 切到左邻', activeLast.activeTabId === t2, String(activeLast.activeTabId))

    const closeAll = closeDockTab(closeDockTab(closeDockTab(base, t1), t2), t3)
    add('关标签：关光后是空面板', closeAll.tabs.length === 0 && closeAll.activeTabId === undefined)

    add('关标签：未知 id 原样返回（同一对象）', closeDockTab(base, '不存在') === base)
  }

  // 7. 切标签
  {
    const base = threeTabs(4000)
    const other = base.tabs[2].id
    add('切标签：切到指定标签', activateDockTab(base, other).activeTabId === other)
    add('切标签：已在目标上返回原对象', activateDockTab(base, base.activeTabId!) === base)
    add('切标签：无效 id 返回原对象', activateDockTab(base, '不存在') === base)
    add('切标签：activeDockTab 与 activeTabId 一致', activeDockTab(base)?.id === base.activeTabId)
  }

  // 8. 开关与宽度：值没变就返回原对象（避免无意义的重渲染 / 落盘）
  {
    const base = defaultDockState()
    add('开关：同值返回原对象', setDockOpen(base, false) === base)
    add('开关：改变返回新对象', setDockOpen(base, true) !== base && setDockOpen(base, true).open === true)
    add('宽度：同值返回原对象', setDockWidth(base, base.width) === base)
    add('宽度：改变返回新对象且被夹取', setDockWidth(base, 10).width === DOCK_MIN_WIDTH)
  }

  // 9. 标签命名：单标签用类型名，同类型多个带序号，自定义名优先
  {
    const s = threeTabs(6000)
    add('命名：单个文件标签 = 文件', dockTabTitle(s.tabs[0], s.tabs, true) === '文件')
    add('命名：英文界面 = Files', dockTabTitle(s.tabs[0], s.tabs, false) === 'Files')
    const two = addDockTab(s, 'terminal', 7000)
    const terminals = two.tabs.filter((t) => t.kind === 'terminal')
    add('命名：两个终端带序号', dockTabTitle(terminals[1], two.tabs, true) === '终端 2', dockTabTitle(terminals[1], two.tabs, true))
    const custom: ChatDockState = { ...s, tabs: [{ id: 'c', kind: 'browser', title: '预览' }], activeTabId: 'c' }
    add('命名：自定义名优先', dockTabTitle(custom.tabs[0], custom.tabs, true) === '预览')
  }

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logChatDockSelfTest(): boolean {
  const cases = runChatDockSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[chatDock] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
