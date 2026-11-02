/**
 * skillFolders.selftest.ts — 技能按文件夹分组的纯逻辑
 *
 * 技能管理面板与预设技能 tab 共用这份分组（src/lib/agent/skillFolders.ts）：
 * 组顺序 / 根目录组位置 / folder 归一（反斜杠、首尾斜杠、空白）/ 组内排序，
 * 任一条错了界面上就会出现「技能跑到别的文件夹」「根目录技能消失」这类问题。
 */

import {
  SKILL_ROOT_FOLDER_ID,
  groupSkillRowsByFolder,
  normalizeSkillFolder,
  skillFolderGroupId,
  skillFolderLabel,
} from './skillFolders'

interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

interface Row {
  name: string
  folder?: string
  path?: string
}

export function runSkillFoldersSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []

  cases.push({
    name: 'folder 归一：反斜杠 / 首尾斜杠 / 重复斜杠 / 空白段都归一成 a/b',
    ok: (() => {
      const got = [
        normalizeSkillFolder('财务\\合同'),
        normalizeSkillFolder('/办公/文档/'),
        normalizeSkillFolder('办公//文档'),
        normalizeSkillFolder('  办公 / 文档  '),
        normalizeSkillFolder(''),
        normalizeSkillFolder(undefined as any),
      ]
      return JSON.stringify(got) === JSON.stringify(['财务/合同', '办公/文档', '办公/文档', '办公/文档', '', ''])
    })(),
  })

  cases.push({
    name: '分组标题：层级用「 / 」展示，根目录给「未分类」文案（中英各一份）',
    ok: (() => {
      return (
        skillFolderLabel('办公/文档', true) === '办公 / 文档' &&
        skillFolderLabel('办公/文档', false) === '办公 / 文档' &&
        skillFolderLabel('', true) === '未分类（根目录）' &&
        skillFolderLabel('', false) === 'Uncategorized (root)'
      )
    })(),
  })

  cases.push({
    name: '组 id：分类用 folder 前缀、根目录用固定 id（空串不能当 key）',
    ok:
      skillFolderGroupId('财务') === 'folder:财务' &&
      skillFolderGroupId('财务\\合同') === 'folder:财务/合同' &&
      skillFolderGroupId('') === SKILL_ROOT_FOLDER_ID &&
      skillFolderGroupId(undefined as any) === SKILL_ROOT_FOLDER_ID,
  })

  const rows: Row[] = [
    { name: 'beta', folder: '财务' },
    { name: 'alpha', folder: '财务' },
    { name: 'doc-pdf', folder: '办公/文档' },
    { name: 'doc-nested', folder: '办公/文档/子级' },
    { name: 'solo-b', folder: '' },
    { name: 'solo-a' }, // folder 缺失 = 根目录
    { name: 'win', folder: '办公\\文档' },
  ]

  const sections = groupSkillRowsByFolder(rows, { zh: true })
  const ids = sections.map((s) => s.id)
  const namesOf = (id: string) => sections.find((s) => s.id === id)?.rows.map((r) => r.name) || []

  cases.push({
    name: '分类组按路径升序、根目录组固定排在最后',
    ok: JSON.stringify(ids) === JSON.stringify([
      'folder:办公/文档',
      'folder:办公/文档/子级',
      'folder:财务',
      SKILL_ROOT_FOLDER_ID,
    ]),
    detail: ids.join(' | '),
  })

  cases.push({
    name: '反斜杠 folder 与正斜杠合并到同一组',
    ok: JSON.stringify(namesOf('folder:办公/文档')) === JSON.stringify(['doc-pdf', 'win']),
    detail: namesOf('folder:办公/文档').join(','),
  })

  cases.push({
    name: '组内按技能名升序（扫描顺序不稳定，UI 要稳）',
    ok: JSON.stringify(namesOf('folder:财务')) === JSON.stringify(['alpha', 'beta']),
    detail: namesOf('folder:财务').join(','),
  })

  cases.push({
    name: 'folder 缺失 / 空串都进根目录组，且同样排序',
    ok: JSON.stringify(namesOf(SKILL_ROOT_FOLDER_ID)) === JSON.stringify(['solo-a', 'solo-b']),
    detail: namesOf(SKILL_ROOT_FOLDER_ID).join(','),
  })

  cases.push({
    name: '没有行时返回空数组（面板显示空态而不是崩）',
    ok: groupSkillRowsByFolder([], { zh: true }).length === 0,
  })

  cases.push({
    name: '只传 rows 时不会丢字段（自定义字段原样带进组，行插槽要用）',
    ok: (() => {
      const withExtra = [{ name: 'x', folder: '分类', path: '/tmp/x', emoji: '🧩' }]
      const g = groupSkillRowsByFolder(withExtra, { zh: true })
      return g[0]?.rows[0]?.path === '/tmp/x' && (g[0]?.rows[0] as any)?.emoji === '🧩'
    })(),
  })

  return cases
}
