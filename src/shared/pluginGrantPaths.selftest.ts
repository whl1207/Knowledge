/**
 * pluginGrantPaths.selftest.ts — 文件授权「路径 × 模式」判定的自测
 *
 * 锁四件事：
 *   1. **旧存档默认只读**（引入"可写"不能让既有授权静默获得写权限）；
 *   2. 模式**只升不降**（再次以读模式选中不降级）；
 *   3. 目录授权覆盖子树，且**按路径段**比较（`/a/bc` 不是 `/a/bcd` 的根）；
 *   4. `need='write'` 时**只认写授权**，且拒绝原因要说清是"没授权"还是"只读"。
 *
 * 用法：`node scripts/run-selftests.mjs pluginGrantPaths`
 */

import {
  checkGrantAccess,
  isInsideGrantRoot,
  matchGrant,
  normalizeGrantRecord,
  normalizeGrantRecords,
  samePath,
  strongerMode,
  stripTrailingSep,
  type PluginGrantRecord,
} from './pluginGrantPaths'

export interface GrantCase {
  name: string
  ok: boolean
  detail?: string
}

const R = (path: string, mode: 'read' | 'write' = 'read'): PluginGrantRecord => ({ path, mode })

export function runPluginGrantPathsSelfTest(): GrantCase[] {
  const cases: GrantCase[] = []

  // ---------------- 归一化：旧存档必须只读 ----------------
  {
    const legacy = normalizeGrantRecord('/data/facts')
    const modern = normalizeGrantRecord({ path: '/data/facts', mode: 'write' })
    const badMode = normalizeGrantRecord({ path: '/data/facts', mode: 'WRITE' })
    cases.push({
      name: '**旧存档（裸字符串）归一成只读**；write 保留；非法 mode 回落只读',
      ok:
        legacy?.mode === 'read' &&
        modern?.mode === 'write' &&
        badMode?.mode === 'read',
      detail: `legacy=${legacy?.mode} modern=${modern?.mode} badMode=${badMode?.mode}`,
    })
  }
  {
    const nulls = [normalizeGrantRecord(''), normalizeGrantRecord('   '), normalizeGrantRecord(null), normalizeGrantRecord(42), normalizeGrantRecord({}), normalizeGrantRecord({ mode: 'write' })]
    cases.push({
      name: '空路径 / 非字符串 / 无 path 的对象 → null（不产生幽灵授权）',
      ok: nulls.every((x) => x === null),
      detail: JSON.stringify(nulls),
    })
  }
  {
    const merged = normalizeGrantRecords(['/a', { path: '/a', mode: 'write' }, { path: '/b', mode: 'read' }])
    cases.push({
      name: '去重时取更强模式（同一路径既是只读又是可写 → 可写），并保持顺序',
      ok: merged.length === 2 && merged[0].mode === 'write' && merged[1].mode === 'read',
      detail: JSON.stringify(merged),
    })
  }
  {
    const limited = normalizeGrantRecords(['/1', '/2', '/3', '/4'], 2)
    cases.push({
      name: '条数上限生效（插件反复弹选择框也撑不爆清单）',
      ok: limited.length === 2,
      detail: JSON.stringify(limited.map((g) => g.path)),
    })
  }

  // ---------------- 路径比较：按路径段，不做朴素 startsWith ----------------
  {
    const yes = [
      ['/a/b', '/a/b'],
      ['/a/b/c.md', '/a/b'],
      ['C:/data/facts/x.md', 'C:/data/facts'],
      ['/a/b/', '/a/b'],
    ]
    const no = [
      ['/a/bcd', '/a/bc'],   // ← 朴素 startsWith 会误判为命中
      ['/a/bc/d', '/a/b'],
      ['/other', '/a'],
      ['/a', '/a/b'],
    ]
    const bad = [
      ...yes.filter(([t, r]) => !isInsideGrantRoot(t, r)),
      ...no.filter(([t, r]) => isInsideGrantRoot(t, r)),
    ]
    cases.push({
      name: '**按路径段**判定：子项命中，兄弟目录 / 前缀相似的目录**不**命中',
      ok: bad.length === 0,
      detail: bad.length ? `误判：${bad.map(([t, r]) => `${t} vs ${r}`).join('；')}` : `${yes.length} 命中 + ${no.length} 不命中 全对`,
    })
  }
  {
    const win = isInsideGrantRoot('C:\\Data\\Facts\\X.md', 'c:\\data\\facts', true)
    const winStrict = isInsideGrantRoot('C:\\Data\\Facts\\X.md', 'c:\\data\\facts', false)
    cases.push({
      name: '大小写：Windows/macOS 模式忽略大小写，严格模式不忽略（默认严格，调用方按平台传）',
      ok: win === true && winStrict === false,
      detail: `ignoreCase=${win} strict=${winStrict}`,
    })
  }
  {
    const roots = [stripTrailingSep('C:\\'), stripTrailingSep('/'), stripTrailingSep('/a/b/'), stripTrailingSep('C:/')]
    cases.push({
      name: '末尾分隔符与根路径归一（`C:\\` 与 `C:/` 归一成同一个根，`/` 不被削成空串）',
      ok: roots[0] === 'C:' && roots[1] === '/' && roots[2] === '/a/b' && roots[3] === 'C:',
      detail: JSON.stringify(roots),
    })
  }
  {
    cases.push({
      name: 'samePath：默认严格、可选忽略大小写；strongerMode：write 优先',
      ok:
        samePath('/A', '/a') === false &&
        samePath('/A', '/a', true) === true &&
        strongerMode('read', 'write') === 'write' &&
        strongerMode('read', 'read') === 'read',
      detail: `samePath=${samePath('/A', '/a')}/${samePath('/A', '/a', true)}`,
    })
  }

  // ---------------- 访问判定 ----------------
  {
    const grants = [R('/data/readonly'), R('/data/writable', 'write')]
    const readInRead = checkGrantAccess('/data/readonly/a.md', grants, 'read')
    const writeInRead = checkGrantAccess('/data/readonly/a.md', grants, 'write')
    const writeInWrite = checkGrantAccess('/data/writable/a.md', grants, 'write')
    const readInWrite = checkGrantAccess('/data/writable/a.md', grants, 'read')
    const outside = checkGrantAccess('/etc/passwd', grants, 'write')
    cases.push({
      name: '**need=write 只认写授权**：只读授权可读不可写；写授权两者皆可；未授权一律拒',
      ok:
        readInRead.ok === true &&
        writeInRead.ok === false && /只读/.test(writeInRead.reason ?? '') &&
        writeInWrite.ok === true && writeInWrite.mode === 'write' &&
        readInWrite.ok === true &&
        outside.ok === false && /未授权/.test(outside.reason ?? ''),
      detail: `readInRead=${readInRead.ok} writeInRead=${writeInRead.ok} writeInWrite=${writeInWrite.ok} outside=${outside.ok}`,
    })
  }
  {
    const grants = [R('/a', 'read'), R('/a/b', 'write')]
    const hit = matchGrant('/a/b/c.md', grants)
    cases.push({
      name: '多条命中时取最强模式（`/a` 只读 + `/a/b` 可写 → 目标按可写放行）',
      ok: hit?.mode === 'write' && hit?.path === '/a/b',
      detail: JSON.stringify(hit),
    })
  }
  {
    const nested = checkGrantAccess('/a/b/c.md', [R('/a', 'read')], 'write')
    cases.push({
      name: 'meta：父目录只读时，子路径写入仍被拒（不会因为"在授权目录下"就放宽模式）',
      ok: nested.ok === false,
      detail: nested.reason ?? '',
    })
  }

  return cases
}

/** 命令行入口 */
export function logPluginGrantPathsSelfTest(): boolean {
  const cases = runPluginGrantPathsSelfTest()
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail}`)
  }
  return cases.every((c) => c.ok)
}
