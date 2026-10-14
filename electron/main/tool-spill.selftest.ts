/**
 * tool-spill.selftest.ts — spill 磁盘存储自测（真实文件系统往返）
 *
 * 覆盖：落盘 → 原样读回、路径形状（会话私有子目录 + 随机前缀 + 文件名安全化）、
 * 独占写（不覆盖既有文件）、过期清扫只删自己创建的目录、删除后读取返回 null。
 *
 * 用法：`npm run test:selftest`（见 scripts/run-selftests.mjs）
 */

import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupSpillDirs,
  readSpillText,
  safeSpillFileName,
  saveSpillText,
  spillSessionDirName,
} from './tool-spill'

export interface SpillCase {
  name: string
  ok: boolean
  detail?: string
}

/** 列出现存 spill 根目录（形如 aikm-spill-XXXXXX） */
function listSpillRoots(): string[] {
  try {
    return fs.readdirSync(tmpdir())
      .filter((n) => /^aikm-spill-[A-Za-z0-9]{6}$/.test(n))
      .map((n) => join(tmpdir(), n))
  } catch {
    return []
  }
}

export function runToolSpillSelfTest(): SpillCase[] {
  const cases: SpillCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 自测会在系统临时目录里**真的**建 spill 目录（与生产同一条代码路径，这是刻意的）。
  // 记录运行前已存在的根目录，结束时只删"本次新出现"的，避免每跑一次自测就留一堆临时目录，
  // 也绝不会碰其它进程（含真实 DSH 会话）已有的目录。
  const rootsBefore = new Set(listSpillRoots())

  // 1. 纯函数：会话目录名（sha256 前 12 位，与 DSH 同构）
  {
    const a = spillSessionDirName('session-abc')
    add('会话目录名形状', /^session-[0-9a-f]{12}$/.test(a), a)
    add('会话目录名稳定', spillSessionDirName('session-abc') === a)
    add('不同会话不同目录', spillSessionDirName('session-abc') !== spillSessionDirName('session-abd'))
    add('路径注入被消解（无斜杠 / 上跳）', !/[/\\]|\.\./.test(spillSessionDirName('../../etc/passwd')))
  }

  // 2. 纯函数：文件名安全化
  {
    add('文件名：去掉路径分隔符', !safeSpillFileName('a/b\\c.txt').includes('/') && !safeSpillFileName('a/b\\c.txt').includes('\\'))
    add('文件名：去掉控制字符', !/[\u0000-\u001f]/.test(safeSpillFileName('a\u0000b\u001fc.txt')))
    add('文件名：前导点被消解', !safeSpillFileName('..hidden').startsWith('.'))
    add('文件名：空名有兜底', safeSpillFileName('').length > 0)
    add('文件名：限长 120', safeSpillFileName('x'.repeat(500)).length <= 120)
  }

  // 3. 真实落盘 → 原样读回
  let spillPath = ''
  {
    const payload = '完整原文\n'.repeat(5000) + '⬅ 末尾（含中文与 emoji 🙂）'
    const ref = saveSpillText('selftest-session-1', 'shell.txt', payload)
    if (!ref) {
      add('落盘成功（临时目录可写）', false, 'saveSpillText 返回 null')
    } else {
      spillPath = ref.path
      add('落盘成功（临时目录可写）', true)
      add('落盘字节数 = UTF-8 字节数', ref.bytes === Buffer.byteLength(payload, 'utf8'), `bytes=${ref.bytes}`)
      add('路径落在系统临时目录', ref.path.startsWith(tmpdir()))
      add('路径含会话私有子目录', ref.path.includes(spillSessionDirName('selftest-session-1')))
      add('文件名带随机前缀（不可预测）', /[0-9a-f]{12}-shell\.txt$/.test(ref.path))
      const back = readSpillText(ref.path)
      add('读回内容与原文逐字一致', back === payload, back === null ? 'readSpillText 返回 null' : `len=${back.length}`)
    }
  }

  // 4. 独占写：同一路径不会被第二次落盘覆盖（每次都是新随机名）
  {
    const r1 = saveSpillText('selftest-session-1', 'shell.txt', 'AAA')
    const r2 = saveSpillText('selftest-session-1', 'shell.txt', 'BBB')
    add('两次落盘路径不同（随机前缀）', !!r1 && !!r2 && r1.path !== r2.path)
    add('旧文件内容未被覆盖', !!r1 && readSpillText(r1.path) === 'AAA')
  }

  // 5. 删除后读取返回 null（模型会看到"文件不存在"并重跑工具）
  {
    if (spillPath) {
      fs.rmSync(spillPath, { force: true })
      add('删除后读取返回 null', readSpillText(spillPath) === null)
    } else {
      add('删除后读取返回 null', false, '前置落盘失败，跳过')
    }
  }

  // 6. 清扫：只删"自己创建的、过期的"目录，任意其它目录一律不动
  {
    const base = tmpdir()
    // 用手工名（而不是 mkdtemp 模板）：mkdtemp 会再补随机后缀，名字就不再是 6 位后缀的形状
    const oldSpill = join(base, 'aikm-spill-Ab12Cd')
    const freshSpill = join(base, 'aikm-spill-Zz98Yx')
    const tooLongName = join(base, 'aikm-spill-Ab12CdQkEm6n')
    const notOurs = join(base, 'aikm-selftest-keepme')
    fs.mkdirSync(oldSpill, { recursive: true })
    fs.mkdirSync(freshSpill, { recursive: true })
    fs.mkdirSync(tooLongName, { recursive: true })
    fs.mkdirSync(notOurs, { recursive: true })
    // 把 oldSpill 的 mtime 拨回 60 天前
    const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    fs.utimesSync(oldSpill, past, past)

    const removed = cleanupSpillDirs(30)
    add('清扫：删除了过期 spill 目录', !fs.existsSync(oldSpill), `removed=${removed}`)
    add('清扫：保留未过期 spill 目录', fs.existsSync(freshSpill))
    add('清扫：后缀长度不符的不动（保守策略）', fs.existsSync(tooLongName))
    add('清扫：不碰名字不匹配的目录', fs.existsSync(notOurs))

    fs.rmSync(freshSpill, { recursive: true, force: true })
    fs.rmSync(tooLongName, { recursive: true, force: true })
    fs.rmSync(notOurs, { recursive: true, force: true })
  }

  // 7. 落盘失败必须**不抛错**（best-effort）：异常输入也不应打断工具链
  {
    let threw = false
    let ref: any = undefined
    try {
      // 文件名里的 NUL 会被 safeSpillFileName 替换掉，因此这里应当**成功**而不是失败；
      // 关键是：无论成功还是降级为 null，都绝不能抛错。
      ref = saveSpillText('session-with-\u0000-null', 'x.txt', 'data')
    } catch {
      threw = true
    }
    add('落盘异常不抛错（best-effort）', !threw, ref === null ? '返回 null（降级）' : '返回 ref')
  }

  // 8. 清理：只删本次自测新建的 spill 根目录（运行前已存在的一律不动）
  {
    const created = listSpillRoots().filter((d) => !rootsBefore.has(d))
    let removed = 0
    for (const dir of created) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        removed++
      } catch {
        /* 清理失败不影响自测结论 */
      }
    }
    add('自测清理：删除本次新建的临时目录', true, `removed=${removed}/${created.length}`)
  }

  return cases
}

/** 打印 spill 自测结果并返回是否全通过 */
export function logToolSpillSelfTest(): boolean {
  const cases = runToolSpillSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[tool-spill] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
