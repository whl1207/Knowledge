/**
 * skill-dev-check.selftest.ts — 「技能设计师」自检与参考正文的自测
 *
 * 为什么值得测：`skill_dev_check` 是「技能设计师」交付前的唯一闸门（写错了不会有人肉眼发现），
 * 而它判断的又是一堆容易写错的细节：frontmatter 解析、目录名与 name 一致、`$` 触发规则、
 * 资源引用、体积上限。这里用临时目录把这些边界固定下来，顺带验证参考正文没有退化
 * （话题正文是纯字符串，vue-tsc 查不出内容缺失）。
 *
 * 用法：`node scripts/run-selftests.mjs skillDevCheck`
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkSkillDir } from './skill-dev-check'
import { SKILL_DEV_TEMPLATE_KEYS, SKILL_DEV_TOOL_SPECS, skillDevTopic } from './skill-dev-guide'

export interface SkillDevCheckCase {
  name: string
  ok: boolean
  detail?: string
}

const VALID = `---
name: hello-skill
description: 把一段文字改写成三条要点。用户要求"提炼要点 / 总结成三条"时使用。
version: 1.0.0
tags: [summary, writing]
emoji: "📝"
---

# 三条要点

## 何时使用
- 用户给一段文字，要提炼成几条。

## 步骤
1. 读内容；如果是文件路径，先用 read_file 读取。
2. 找出三个信息点。
3. 看 \`/references/style.md\` 的写法约定。

## 输出格式
1. ……
2. ……
3. ……
`

export function runSkillDevCheckSelfTest(): SkillDevCheckCase[] {
  const cases: SkillDevCheckCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })
  const root = mkdtempSync(join(tmpdir(), 'aikm-skilldev-'))

  const writeSkill = (dirName: string, content: string, extra: Record<string, string> = {}): string => {
    const dir = join(root, dirName)
    mkdirSync(dir, { recursive: true })
    if (content !== '') writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
    for (const [rel, text] of Object.entries(extra)) {
      const abs = join(dir, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, text, 'utf8')
    }
    return dir
  }

  try {
    // ---- 1. 合法技能 ----
    const good = writeSkill('hello-skill', VALID, { 'references/style.md': '# 写法\n' })
    const goodText = checkSkillDir(good)
    add('合法技能：结论为可交付', goodText.includes('结论：✓'), goodText)
    add('合法技能：没有 ✗', !goodText.includes('✗ 必须修'), goodText)
    add('合法技能：识别出 name 与正文', goodText.includes('hello-skill') && goodText.includes('SKILL.md'))

    // ---- 2. 结构性错误 ----
    const noSkillMd = writeSkill('no-skill-md', '')
    add('缺 SKILL.md = ✗', checkSkillDir(noSkillMd).includes('✗ 缺少 SKILL.md'))
    add('目录不存在 = ✗', checkSkillDir(join(root, 'nope')).includes('✗ 目录不存在'))

    const noName = writeSkill('no-name', '---\ndescription: 只有描述。\n---\n\n## 步骤\n做点事。\n')
    add('缺 name = ✗', checkSkillDir(noName).includes('缺少 name'))
    const noDesc = writeSkill('no-desc', '---\nname: no-desc\n---\n\n## 步骤\n做点事。\n')
    add('缺 description = ✗', checkSkillDir(noDesc).includes('缺少 description'))
    const badYaml = writeSkill('bad-yaml', '---\nname: [unclosed\ndescription: x\n---\n\n正文\n')
    add('YAML 不合法 = ✗', checkSkillDir(badYaml).includes('frontmatter 解析失败'))
    const noFrontmatter = writeSkill('no-fm', '# 只有正文\n')
    add('没有 frontmatter = ✗', checkSkillDir(noFrontmatter).includes('不是 `---` 包裹的 YAML frontmatter'))
    const emptyBody = writeSkill('empty-body', '---\nname: empty-body\ndescription: 有描述但正文为空。\n---\n')
    add('正文为空 = ✗', checkSkillDir(emptyBody).includes('正文为空'))

    // ---- 3. 命名 / 触发规则 ----
    const cnName = writeSkill('中文名', '---\nname: 中文名\ndescription: 中文名字的技能，用来验证 $ 触发规则会被提醒。\n---\n\n## 步骤\n做点事。\n')
    add('中文 name = 警告（$ 触发不了）', checkSkillDir(cnName).includes('无法显式触发'))
    const mismatch = writeSkill('folder-x', '---\nname: name-y\ndescription: 目录名和 name 不一致，用来验证提醒。\n---\n\n## 步骤\n做点事。\n')
    add('目录名 ≠ name = 警告', checkSkillDir(mismatch).includes('与 frontmatter name'))
    const vagueDesc = writeSkill('vague', '---\nname: vague\ndescription: use this skill when needed to help the user do things\n---\n\n## 步骤\n做点事。\n')
    add('占位式 description = 警告', checkSkillDir(vagueDesc).includes('占位描述'))

    // ---- 4. 资源引用 ----
    const missingRef = writeSkill('missing-ref', '---\nname: missing-ref\ndescription: 引用了一个不存在的资源，用来验证检查能抓到。\n---\n\n## 步骤\n看 `/references/nope.md`。\n')
    add('引用的资源不存在 = ✗', checkSkillDir(missingRef).includes('引用的资源不存在'))
    const existingRefMd = writeSkill('link-ref', '---\nname: link-ref\ndescription: 用 Markdown 链接引用存在的资源，应该通过。\n---\n\n## 步骤\n见 [写法](/references/a.md)。\n', { 'references/a.md': '# a\n' })
    add('Markdown 链接存在 = 不报错', !checkSkillDir(existingRefMd).includes('引用的资源不存在'))

    // ---- 5. 体积 ----
    const hugeBody = writeSkill('huge', `---\nname: huge\ndescription: 正文超大，用来验证硬上限会被拦下。\n---\n\n${'x'.repeat(41000)}\n`)
    add('正文超硬上限 = ✗', checkSkillDir(hugeBody).includes('超过硬上限'))
    const bigBody = writeSkill('big', `---\nname: big\ndescription: 正文超过建议上限，用来验证只给警告。\n---\n\n${'x'.repeat(9000)}\n`)
    const bigText = checkSkillDir(bigBody)
    add('正文超建议上限 = 警告而非错误', bigText.includes('超过建议上限') && bigText.includes('结论：✓'), bigText)

    // ---- 6. 重名 ----
    const dupText = checkSkillDir(good, { installed: [{ name: 'hello-skill', path: join(root, 'other', 'hello-skill') }] })
    add('与已装技能重名 = 警告', dupText.includes('已存在同名技能'))

    // ---- 7. 未知字段 / always ----
    const typoKey = writeSkill('typo', '---\nname: typo\ndescription: 拼错字段名，用来验证会被指出来。\ntag: [a]\n---\n\n## 步骤\n做点事。\n')
    add('未知 frontmatter 字段 = 警告', checkSkillDir(typoKey).includes('未知字段「tag」'))
    const alwaysSkill = writeSkill('always', '---\nname: always\ndescription: 常驻技能，用来验证 always 的上下文成本提醒。\nalways: true\n---\n\n## 步骤\n做点事。\n')
    add('always: true = 警告', checkSkillDir(alwaysSkill).includes('每轮都会注入'))

    // ---- 8. 参考正文 ----
    add('话题清单齐全（schema/writing/constraints/templates/faq）',
      ['schema', 'writing', 'constraints', 'templates', 'faq'].every((t) => SKILL_DEV_TOOL_SPECS.some((s) => s.topic === t)))
    add('每个静态话题都有正文', SKILL_DEV_TOOL_SPECS.every((s) => (s.topic === 'templates' ? skillDevTopic('templates', 'minimal') : skillDevTopic(s.topic)).length > 300),
      JSON.stringify(SKILL_DEV_TOOL_SPECS.map((s) => [s.topic, skillDevTopic(s.topic).length])))
    add('静态话题都在 12k 字符以内',
      SKILL_DEV_TOOL_SPECS.every((s) => (s.topic === 'templates' ? skillDevTopic('templates', 'minimal') : skillDevTopic(s.topic)).length < 12000),
      JSON.stringify(SKILL_DEV_TOOL_SPECS.map((s) => [s.topic, skillDevTopic(s.topic).length])))
    add('模板正文包含 frontmatter 与 name 示例',
      SKILL_DEV_TEMPLATE_KEYS.every((k) => {
        const text = skillDevTopic('templates', k)
        return text.includes('---') && text.includes('name:')
      }))
    add('未知模板 key 返回目录而不是空白',
      skillDevTopic('templates', 'nope').includes('技能模板目录'))
    add('schema 提到 $ 触发与 / 相对路径',
      skillDevTopic('schema').includes('$技能名') && skillDevTopic('schema').includes('/references/'))
    add('writing 提到 description 是唯一触发器', skillDevTopic('writing').includes('唯一触发器'))
    add('constraints 覆盖硬约束（目录名 = name / UTF-8 / 体积）',
      skillDevTopic('constraints').includes('与目录名一致') &&
      skillDevTopic('constraints').includes('UTF-8') &&
      skillDevTopic('constraints').includes('8000'))
    add('faq 覆盖"不触发"与"读不到资源"',
      skillDevTopic('faq').includes('不触发') && skillDevTopic('faq').includes('读不到'))
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return cases
}
