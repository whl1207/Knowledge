/**
 * fsContract.selftest.ts — 文件能力契约层的纯逻辑自测
 *
 * 验的是"两个半边共用同一份判定"这件事：
 * - 路径归一化（同一文件的不同写法必须得到同一个 `targetKey`）；
 * - 版本串与 `isFsVersion`；
 * - 字面量编辑的三态（命中 1 处 / 0 处 / 多处）与 `all` 语义、多笔编辑的顺序语义；
 * - 能力表与成员表一致（加了能力却漏了成员表 → 这里红）。
 *
 * 用 `runFsContractSelfTest()` 返回数组，由 `scripts/run-selftests.mjs` 执行（esbuild 打包）。
 */

import {
  applyLiteralEdits,
  fsTargetOf,
  fsVersionOf,
  isFsErrorCode,
  isFsVersion,
  normalizeFsPath,
} from '@/shared/fsContract'
import { PLUGIN_CAPABILITIES, PLUGIN_CAPABILITY_NAMES, capabilityOfErrorCode, capabilityPermission } from '@/shared/pluginCapabilities'
import { CLIENT_CTX_MEMBERS, MAIN_CTX_MEMBERS } from '@/shared/pluginApiMembers'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

export function runFsContractSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // ---- 路径归一化 ----
  check('盘符小写 + 分隔符统一', normalizeFsPath('C:\\Users\\admin\\a.md') === 'c:/Users/admin/a.md', normalizeFsPath('C:\\Users\\admin\\a.md'))
  check('折叠 .. 与 .', normalizeFsPath('c:/a/./b/../c.md') === 'c:/a/c.md', normalizeFsPath('c:/a/./b/../c.md'))
  check('去掉尾部斜杠', normalizeFsPath('c:/a/b/') === 'c:/a/b', normalizeFsPath('c:/a/b/'))
  check('POSIX 根保留', normalizeFsPath('/a/b/../c') === '/a/c', normalizeFsPath('/a/b/../c'))
  check('相对路径拼 cwd', normalizeFsPath('notes/a.md', 'c:/w') === 'c:/w/notes/a.md', normalizeFsPath('notes/a.md', 'c:/w'))
  check('相对路径的 .. 不逃出 cwd', normalizeFsPath('../../x', 'c:/w/a') === 'c:/x', normalizeFsPath('../../x', 'c:/w/a'))

  // ---- 目标身份：同一文件的两种写法 → 同一个 targetKey ----
  const t1 = fsTargetOf('C:\\w\\notes\\a.md')
  const t2 = fsTargetOf('c:/w/./notes/../notes/a.md')
  check('同一文件不同写法 → 同一 targetKey', t1.targetKey === t2.targetKey, `${t1.targetKey} vs ${t2.targetKey}`)
  check('displayPath 保留归一结果', t1.displayPath === 'c:/w/notes/a.md', t1.displayPath)
  check('已是 FsTarget 时原样返回', fsTargetOf(t1).targetKey === t1.targetKey)
  check('空路径 → 空 targetKey', fsTargetOf('').targetKey === '')

  // ---- 版本 ----
  check('版本串 = size:mtime', fsVersionOf(12, 1700000000123) === '12:1700000000123', fsVersionOf(12, 1700000000123))
  const fractional = fsVersionOf(12, 1700000000123.4567)
  check(
    '版本串**不做取整**（同长度覆盖靠亚毫秒区分）',
    fractional.startsWith('12:') && fractional.split(':')[1].includes('.'),
    fractional,
  )
  check('版本串带 ctime 时是三段', fsVersionOf(12, 1700000000123, 1700000000456) === '12:1700000000123:1700000000456')
  check('isFsVersion 认合法串', isFsVersion('12:1700000000123') && isFsVersion('12:1700000000123.5:1700000000456'))
  check('isFsVersion 拒非法串', !isFsVersion('v1') && !isFsVersion('12') && !isFsVersion(12))
  check('错误码族识别 FS_*', isFsErrorCode('FS_STALE_VERSION'))
  check('错误码族拒绝捏造', !isFsErrorCode('FS_NOT_A_REAL_CODE'))

  // ---- 字面量编辑 ----
  const one = applyLiteralEdits('a\nb\nc', [{ find: 'b', replace: 'B' }])
  check('命中 1 处 → 替换成功', one.ok === true && (one as any).text === 'a\nB\nc', JSON.stringify(one))

  const zero = applyLiteralEdits('abc', [{ find: 'zzz', replace: 'x' }])
  check('命中 0 处 → FS_AMBIGUOUS_EDIT', zero.ok === false && (zero as any).code === 'FS_AMBIGUOUS_EDIT', JSON.stringify(zero))

  const many = applyLiteralEdits('x x x', [{ find: 'x', replace: 'y' }])
  check(
    '命中多处且未声明 all → 报出命中次数',
    many.ok === false && (many as any).code === 'FS_AMBIGUOUS_EDIT' && String((many as any).message).includes('3'),
    JSON.stringify(many),
  )

  const all = applyLiteralEdits('x x x', [{ find: 'x', replace: 'y', all: true }])
  check('all: true → 全替换', all.ok === true && (all as any).text === 'y y y' && (all as any).applied === 3, JSON.stringify(all))

  const seq = applyLiteralEdits('ab', [
    { find: 'a', replace: 'A' },
    { find: 'A', replace: 'AA' },
  ])
  check('多笔编辑按顺序生效（后者看到前者结果）', seq.ok === true && (seq as any).text === 'AAb', JSON.stringify(seq))

  const empty = applyLiteralEdits('abc', [])
  check('空 edits → FS_FAILED', empty.ok === false && (empty as any).code === 'FS_FAILED', JSON.stringify(empty))

  const blank = applyLiteralEdits('abc', [{ find: '', replace: 'x' }])
  check('空 find → FS_FAILED', blank.ok === false && (blank as any).code === 'FS_FAILED', JSON.stringify(blank))

  // ---- 能力表与成员表一致 ----
  for (const name of PLUGIN_CAPABILITY_NAMES) {
    const def = PLUGIN_CAPABILITIES[name]
    const inClient = Object.prototype.hasOwnProperty.call(CLIENT_CTX_MEMBERS, def.ctxMember)
    const inMain = Object.prototype.hasOwnProperty.call(MAIN_CTX_MEMBERS, def.ctxMember)
    const expected = def.halves.includes('client') ? inClient : true
    const expectedMain = def.halves.includes('main') ? inMain : true
    check(`能力 ${name} 在成员表里存在（半边一致）`, expected && expectedMain, `client=${inClient} main=${inMain}`)
    check(`能力 ${name} 的服务名与 ctx 成员同名`, def.service === def.ctxMember, `${def.service} vs ${def.ctxMember}`)
    check(`能力 ${name} 的错误码前缀可反查`, capabilityOfErrorCode(`${def.errorPrefix}_SOMETHING`) === name)
    check(`能力 ${name} 的权限可读`, capabilityPermission(name) === def.permission, String(capabilityPermission(name)))
  }
  check('未知错误码前缀 → null', capabilityOfErrorCode('NOT_AN_ERROR') === null)

  return cases
}
