/**
 * skill-service.selftest.ts — 技能目录扫描（支持 2~3 级分类目录组织）
 *
 * 用户的实际组织方式是「根目录 / 分类 / 技能」甚至「根目录 / 分类 / 子分类 / 技能」，
 * 而旧实现只看根下第一层，于是 D:\AI知识库\4 技能 里所有技能都扫不到。
 *
 * 本套件在临时目录里搭一棵覆盖各层级的技能树，断言：
 *   1. 根下直接放技能（1 级）仍能扫到；
 *   2. 分类 / 技能（2 级）能扫到，folder 正确；
 *   3. 分类 / 子分类 / 技能（3 级）能扫到，folder 用 `/` 归一；
 *   4. 技能目录内部的 SKILL.md（资源目录）不会被当成独立技能；
 *   5. 隐藏目录 / 系统目录 / 没有 SKILL.md 的目录不算技能；
 *   6. 根目录不存在时返回空数组、不抛错。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkillRoot } from './skill-service'

interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: 自测技能 ${name}（用于技能目录扫描回归）\n---\n\n# ${name}\n\n按步骤一、二、三执行。\n`
}

/** 建目录并写入 SKILL.md（自动补齐父级） */
function makeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd(name), 'utf8')
}

export function runSkillServiceSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const root = mkdtempSync(join(tmpdir(), 'aikm-skill-scan-'))

  try {
    // 1 级：根下直接一个技能
    makeSkill(join(root, 'solo'), 'solo')

    // 2 级：分类 / 技能（用户真实结构之一：财务 / contract-compliance-check）
    makeSkill(join(root, '财务', 'contract-check'), 'contract-check')
    // 技能自带资源，不能被当成独立技能
    mkdirSync(join(root, '财务', 'contract-check', 'regulations'), { recursive: true })
    writeFileSync(join(root, '财务', 'contract-check', 'regulations', 'rule.md'), '# 规定', 'utf8')

    // 3 级：分类 / 子分类 / 技能（用户真实结构之一：办公 / 文档 / pdf）
    makeSkill(join(root, '办公', '文档', 'pdf'), 'pdf')
    mkdirSync(join(root, '办公', '文档', 'pdf', 'scripts'), { recursive: true })
    writeFileSync(join(root, '办公', '文档', 'pdf', 'scripts', 'run.py'), 'print(1)', 'utf8')

    // 技能目录内部再放一个 SKILL.md（某些模板技能会有嵌套目录）：不能变成第二个技能
    makeSkill(join(root, '办公', '文档', 'pdf', 'nested'), 'nested-should-not-appear')

    // 没有 SKILL.md 的分类目录 / 根目录说明文件：都不算技能
    mkdirSync(join(root, '空分类', '空子分类'), { recursive: true })
    writeFileSync(join(root, 'README.md'), '# 不是技能', 'utf8')

    // 隐藏目录跳过（.git / 编辑器临时目录里即使有 SKILL.md 也不算技能）
    makeSkill(join(root, '.hidden', 'secret'), 'hidden-skill')

    // 只认直接含 SKILL.md 的目录；只有子目录有 SKILL.md 的父目录不算技能
    makeSkill(join(root, '类别', '真实技能'), '真实技能')

    const found = scanSkillRoot(root, 'user', 100, 'user')
    const byName = new Map(found.map((s) => [s.name, s]))

    cases.push({
      name: '2~3 级分类目录里的技能都能扫到（共 4 个：solo / contract-check / pdf / 真实技能）',
      ok: found.length === 4 && !!byName.get('solo') && !!byName.get('contract-check') && !!byName.get('pdf') && !!byName.get('真实技能'),
      detail: `实际扫到：${found.map((s) => `${s.name}@${s.folder || '(root)'}`).join(', ')}`,
    })

    cases.push({
      name: '根下直接放技能：folder 为空串',
      ok: byName.get('solo')?.folder === '',
      detail: `folder=${JSON.stringify(byName.get('solo')?.folder)}`,
    })

    cases.push({
      name: '2 级技能：folder = 分类名',
      ok: byName.get('contract-check')?.folder === '财务',
      detail: `folder=${JSON.stringify(byName.get('contract-check')?.folder)}`,
    })

    cases.push({
      name: '3 级技能：folder 用 / 连接子分类',
      ok: byName.get('pdf')?.folder === '办公/文档',
      detail: `folder=${JSON.stringify(byName.get('pdf')?.folder)}`,
    })

    cases.push({
      name: '技能目录内部不再下钻（nested 的 SKILL.md 不算独立技能）',
      ok: !byName.has('nested-should-not-appear'),
      detail: '若出现 nested-should-not-appear 说明扫描穿透了技能目录',
    })

    cases.push({
      name: '隐藏目录 / 无 SKILL.md 的目录不算技能',
      ok: !byName.has('hidden-skill'),
      detail: '若出现 hidden-skill 说明没有跳过点号开头的目录',
    })

    // 技能路径与文件清单仍按技能自身目录解析（folder 只是元数据，不改变 path）
    const pdfPath = String(byName.get('pdf')?.path || '')
    const pdfFiles = byName.get('pdf')?.preview.files.map((f) => f.name) || []
    cases.push({
      name: '技能 path 指向技能自身目录，资源文件按技能目录收集',
      ok: pdfPath.replace(/\\/g, '/').endsWith('办公/文档/pdf') && pdfFiles.some((n) => n === 'scripts/run.py'),
      detail: `path=${pdfPath} files=${pdfFiles.join(',')}`,
    })

    cases.push({
      name: '根目录不存在 → 返回空数组且不抛错',
      ok: (() => {
        try {
          const empty = scanSkillRoot(join(root, '不存在的目录'), 'user', 100, 'user')
          return Array.isArray(empty) && empty.length === 0
        } catch {
          return false
        }
      })(),
    })
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响结论
    }
  }

  return cases
}
