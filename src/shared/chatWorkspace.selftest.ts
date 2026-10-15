/**
 * chatWorkspace.selftest.ts — 每聊天工作区 + 按工作区分组的纯逻辑自测
 *
 * 覆盖：回落到默认工作区、路径末段取名、只差结尾斜杠/分隔符的路径算同组、
 * 组顺序（注册表顺序优先、其余按首次出现、未选择工作区永远最后）、
 * 以及「不改动入参」。
 *
 * 用法：`node scripts/run-selftests.mjs chatWorkspace`
 */

import { groupByWorkspace, readChatWorkspace, workspaceBaseName } from './chatWorkspace'

export interface ChatWorkspaceCase {
  name: string
  ok: boolean
  detail?: string
}

export function runChatWorkspaceSelfTest(): ChatWorkspaceCase[] {
  const cases: ChatWorkspaceCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  // 1. 读「聊天自己那份」工作区，没有就回落到默认
  add('读：自己有工作区就用自己那份', readChatWorkspace({ workspace: 'D:/b' }, 'D:/default') === 'D:/b')
  add('读：自己没选 → 用默认工作区', readChatWorkspace({}, 'D:/default') === 'D:/default')
  add('读：chat 为空 → 用默认工作区', readChatWorkspace(null, 'D:/default') === 'D:/default')
  add('读：chat 为空且无默认 → 空串', readChatWorkspace(undefined, '') === '')
  add('读：两侧都只有空白 → 空串', readChatWorkspace({ workspace: '   ' }, '  ') === '')
  add('读：自己那份会去掉首尾空白', readChatWorkspace({ workspace: '  D:/x  ' }, 'D:/y') === 'D:/x')

  // 2. 路径末段
  add('取名：正斜杠路径', workspaceBaseName('D:/proj/aikm') === 'aikm')
  add('取名：反斜杠 + 结尾斜杠', workspaceBaseName('D:\\proj\\aikm\\') === 'aikm')
  add('取名：根路径 → 空串', workspaceBaseName('/') === '')
  add('取名：空串 → 空串', workspaceBaseName('') === '')

  // 3. 分组：顺序与内容
  {
    const items = [
      { id: 'c1', ws: 'D:/a' },
      { id: 'c2', ws: 'D:/b' },
      { id: 'c3', ws: 'D:/a' },
    ]
    const groups = groupByWorkspace(items, (i) => i.ws)
    add('分组：两个工作区 → 两组', groups.length === 2, `groups=${groups.length}`)
    add('分组：组顺序按首次出现', groups[0].workspace === 'D:/a' && groups[1].workspace === 'D:/b')
    add('分组：组内保持原顺序', groups[0].items.map((i) => i.id).join(',') === 'c1,c3')
    add('分组：展示名取路径末段', groups[0].label === 'a' && groups[1].label === 'b')
    add('分组：不改动入参', items.length === 3 && items[0].id === 'c1')
  }

  // 4. 未选择工作区：兜底桶，永远最后
  {
    const items = [
      { id: 'x', ws: '' },
      { id: 'y', ws: 'D:/a' },
      { id: 'z', ws: '   ' },
    ]
    const groups = groupByWorkspace(items, (i) => i.ws, { emptyLabel: '未选择工作区' })
    add('分组：未选择工作区排最后', groups[groups.length - 1].workspace === '')
    add('分组：未选择工作区用兜底名', groups[groups.length - 1].label === '未选择工作区')
    add('分组：空白路径并入兜底桶', groups[groups.length - 1].items.map((i) => i.id).join(',') === 'x,z')
  }

  // 5. 只差结尾斜杠 / 分隔符 → 同一组（保留首次出现的写法）
  {
    const items = [
      { id: 'a1', ws: 'D:/proj/' },
      { id: 'a2', ws: 'D:\\proj' },
    ]
    const groups = groupByWorkspace(items, (i) => i.ws)
    add('分组：分隔符/结尾斜杠不同算同一组', groups.length === 1 && groups[0].items.length === 2)
    add('分组：保留首次出现的原始写法', groups[0].workspace === 'D:/proj/', groups[0].workspace)
  }

  // 6. 注册表顺序优先，其余按首次出现，空桶仍最后
  {
    const items = [
      { id: '1', ws: 'D:/unknown' },
      { id: '2', ws: '' },
      { id: '3', ws: 'D:/second' },
      { id: '4', ws: 'D:/first' },
    ]
    const groups = groupByWorkspace(items, (i) => i.ws, {
      emptyLabel: '未选择',
      order: ['D:/first', 'D:/second'],
    })
    add('分组：注册表里登记的按注册表顺序',
      groups[0].workspace === 'D:/first' && groups[1].workspace === 'D:/second',
      groups.map((g) => g.workspace).join(' | '))
    add('分组：未登记的按首次出现追加在后面', groups[2].workspace === 'D:/unknown')
    add('分组：空桶仍在最后', groups[groups.length - 1].workspace === '')

    const onlyFirst = groupByWorkspace(items, (i) => i.ws, { order: ['D:/second', 'D:/first'] })
    add('分组：注册表顺序可整体改变组序',
      onlyFirst[0].workspace === 'D:/second' && onlyFirst[1].workspace === 'D:/first')
  }

  // 7. 空输入
  add('分组：空列表 → 空数组', groupByWorkspace([], (i: any) => i.ws).length === 0)

  return cases
}

/** 打印自测结果并返回是否全通过 */
export function logChatWorkspaceSelfTest(): boolean {
  const cases = runChatWorkspaceSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[chatWorkspace] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
