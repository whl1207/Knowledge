/**
 * skill-install.selftest.ts — 「安装技能」的文件拷贝与冲突处理自测
 *
 * 为什么值得测：安装是**从用户磁盘复制文件**的唯一入口，
 * 判错一次就会覆盖同名技能或只复制一半（技能看起来在、资源却缺）。
 * 这里用临时目录固定四件事：
 *   1. 正常复制（含子目录资源）；
 *   2. 同名未确认 → SKILL_EXISTS（不覆盖）；
 *   3. 确认覆盖 → 旧目录整体替换；
 *   4. 缺 SKILL.md / 没设技能目录 → 明确报错，不写任何文件。
 *
 * 用法：`node scripts/run-selftests.mjs skillInstall`
 * 说明：`dialog` 由 scripts/electron-stub.mjs 顶掉（默认「用户取消」），
 * 测试一律走 installSkillFromDir 跳过弹框。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installSkillFromDir } from './skill-install'

export interface SkillInstallCase {
  name: string
  ok: boolean
  detail?: string
}

export async function runSkillInstallSelfTest(): Promise<SkillInstallCase[]> {
  const cases: SkillInstallCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })
  const root = mkdtempSync(join(tmpdir(), 'aikm-skillinstall-'))

  const makeSkill = (dirName: string, body = '# skill\n'): string => {
    const dir = join(root, 'sources', dirName)
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${dirName}\ndescription: 测试用技能，验证安装复制。\n---\n\n${body}`, 'utf8')
    writeFileSync(join(dir, 'references', 'a.md'), '# a\n', 'utf8')
    return dir
  }

  try {
    const skillsRoot = join(root, 'skills')

    // 1. 正常安装
    const src = makeSkill('demo-skill')
    const res = await installSkillFromDir(skillsRoot, src)
    add('正常安装：返回名称与目标路径', res.name === 'demo-skill' && !!res.path && !res.replaced, JSON.stringify(res))
    add('正常安装：SKILL.md 已复制',
      existsSync(join(skillsRoot, 'demo-skill', 'SKILL.md')) &&
      readFileSync(join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8').includes('name: demo-skill'))
    add('正常安装：子目录资源一起复制', existsSync(join(skillsRoot, 'demo-skill', 'references', 'a.md')))

    // 2. 同名未确认
    let existsErr: any = null
    try {
      await installSkillFromDir(skillsRoot, src)
    } catch (e: any) {
      existsErr = e
    }
    add('同名且未确认 → SKILL_EXISTS（不覆盖）', existsErr?.code === 'SKILL_EXISTS', existsErr?.message || 'no error')

    // 3. 确认覆盖
    const srcV2 = makeSkill('demo-skill', '# skill v2\n')
    const replaced = await installSkillFromDir(skillsRoot, srcV2, true)
    add('确认覆盖：replaced=true', replaced.replaced === true, JSON.stringify(replaced))
    add('确认覆盖：内容已是新版本',
      readFileSync(join(skillsRoot, 'demo-skill', 'SKILL.md'), 'utf8').includes('skill v2'))

    // 4. 校验失败
    const badDir = join(root, 'sources', 'no-md')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'readme.md'), 'x', 'utf8')
    let badErr: any = null
    try {
      await installSkillFromDir(skillsRoot, badDir)
    } catch (e: any) {
      badErr = e
    }
    add('缺 SKILL.md → INVALID_ARGUMENT', badErr?.code === 'INVALID_ARGUMENT', badErr?.message || 'no error')
    add('缺 SKILL.md 时不会创建目标目录', !existsSync(join(skillsRoot, 'no-md')))

    let rootErr: any = null
    try {
      await installSkillFromDir('', src)
    } catch (e: any) {
      rootErr = e
    }
    add('未设置技能目录 → INVALID_ARGUMENT', rootErr?.code === 'INVALID_ARGUMENT', rootErr?.message || 'no error')

    // 5. 文件而非目录
    const filePath = join(root, 'sources', 'a-file.txt')
    writeFileSync(filePath, 'x', 'utf8')
    let fileErr: any = null
    try {
      await installSkillFromDir(skillsRoot, filePath)
    } catch (e: any) {
      fileErr = e
    }
    add('传文件而不是文件夹 → INVALID_ARGUMENT', fileErr?.code === 'INVALID_ARGUMENT', fileErr?.message || 'no error')
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return cases
}
