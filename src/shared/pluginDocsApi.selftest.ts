/**
 * pluginDocsApi.selftest.ts — 插件开发指南里的 `ctx.*` 名字必须真的存在（源码级防回归）
 *
 * 背景（2026-11 真实缺陷）：指南 `src/lib/plugin/devGuide.ts` 是模型写插件的**唯一权威**，
 * 它却把主进程半边的宿主能力写成 `ctx.shell.runShell` / `ctx.net.fetch` / `ctx.sessions.list()`，
 * 而真实 API 是 `ctx.host.runShell` / `ctx.host.fetch` / `ctx.host.sessions.list()`
 * （见 src/types/plugin.ts 的 PluginHostApi）。同一份指南第 105-107 行恰恰写着
 * 「只调用本指南列出的宿主 API，不要凭名字猜」——指南自相矛盾，而且是**最坏的一种错**：
 * 模型照事实表写完，`plugin_dev_check` 事后报错，但代码已经交付了。
 *
 * 根因不是手滑，而是「同一份事实写了两遍」（校验器一份、指南一份），迟早对不上。
 * 因此：成员表与校验函数提到 `src/shared/pluginApiMembers.ts` 作为单一事实源，
 * 本自测用**同一份实现**去校验指南文本，两边不可能再各说各话。
 *
 * ⚠️ 指南里有一批**故意**提到的不存在成员（用来告诉模型「这些是臆造的，别写」），
 * 它们在 KNOWN_ABSENT_MENTIONS 里显式列出；新增一条必须在这里登记，否则自测会红。
 */
import {
  ANY_CTX_MEMBERS,
  CTX_USAGE_PROSE_RE,
  checkCtxUsage,
} from '@/shared/pluginApiMembers'
import {
  CONSTRAINTS_EN,
  CONSTRAINTS_ZH,
  PLUGIN_DEV_FACTS,
  PLUGIN_DEV_FAQ,
  PLUGIN_DEV_MINIMAL_EN,
  PLUGIN_DEV_MINIMAL_MAIN_ZH,
  PLUGIN_DEV_MINIMAL_ZH,
  PLUGIN_DEV_SECTIONS,
  PLUGIN_DEV_USAGE_EN,
  PLUGIN_DEV_USAGE_ZH,
} from '@/lib/plugin/devGuide'

export interface PluginDocsCase {
  name: string
  ok: boolean
  detail?: string
}

/**
 * 指南**故意**点名的不存在成员（反面教材）。
 * 每一条都对应指南里「这些是臆造的 / 不存在」的说明文字；新增需谨慎 —— 它同时也放过了真正的错写。
 *
 * 注意：`ctx.service` / `ctx.storage` / `ctx.host` **不在**这里 —— 它们在主进程半边真实存在，
 * 指南提到它们是为了说明「界面半边没有」（两半边串用），按两半边并集判定即可通过。
 */
const KNOWN_ABSENT_MENTIONS = new Set([
  'ctx.mcp',
  'ctx.mcp.call',
  'ctx.files.readFile',
  'ctx.llm.chatStream',
  'ctx.shell',
  'ctx.net',
])

/** 指南里**曾经写错、必须不再出现**的宿主能力拼法（真实缺陷固化） */
const FORBIDDEN_SPELLINGS = [
  'ctx.shell.runShell',
  'ctx.net.fetch',
  'ctx.sessions.list',
]

/** 指南**必须**写对的宿主能力拼法（防止「清理」时被顺手删掉） */
const REQUIRED_SPELLINGS = [
  'ctx.host.runShell',
  'ctx.host.fetch',
  'ctx.host.sessions',
]

interface LabeledText {
  label: string
  text: string
}

function guideTexts(): LabeledText[] {
  const out: LabeledText[] = []
  const push = (label: string, text: unknown) => {
    if (typeof text === 'string' && text) out.push({ label, text })
  }

  push('CONSTRAINTS_ZH', CONSTRAINTS_ZH)
  push('CONSTRAINTS_EN', CONSTRAINTS_EN)
  push('PLUGIN_DEV_USAGE_ZH', PLUGIN_DEV_USAGE_ZH)
  push('PLUGIN_DEV_USAGE_EN', PLUGIN_DEV_USAGE_EN)
  push('PLUGIN_DEV_MINIMAL_ZH', PLUGIN_DEV_MINIMAL_ZH)
  push('PLUGIN_DEV_MINIMAL_MAIN_ZH', PLUGIN_DEV_MINIMAL_MAIN_ZH)
  push('PLUGIN_DEV_MINIMAL_EN', PLUGIN_DEV_MINIMAL_EN)

  PLUGIN_DEV_FACTS.forEach((f, i) => {
    push(`FACTS[${i}].name`, f.name)
    push(`FACTS[${i}].descZh`, f.descZh)
    push(`FACTS[${i}].descEn`, f.descEn)
  })
  PLUGIN_DEV_FAQ.forEach((q, i) => {
    push(`FAQ[${i}].qZh`, q.qZh)
    push(`FAQ[${i}].qEn`, q.qEn)
    push(`FAQ[${i}].aZh`, q.aZh)
    push(`FAQ[${i}].aEn`, q.aEn)
  })
  PLUGIN_DEV_SECTIONS.forEach((s) => {
    push(`SECTIONS[${s.key}].titleZh`, s.titleZh)
    push(`SECTIONS[${s.key}].descZh`, s.descZh)
    push(`SECTIONS[${s.key}].bodyZh`, s.bodyZh)
    push(`SECTIONS[${s.key}].bodyEn`, s.bodyEn)
  })
  return out
}

/** 把文本里所有 `ctx.x` / `ctx.x.y` 写法抽出来（散文规则，见 CTX_USAGE_PROSE_RE） */
function ctxMentions(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(CTX_USAGE_PROSE_RE)) {
    found.push(m[2] ? `ctx.${m[1]}.${m[2]}` : `ctx.${m[1]}`)
  }
  return found
}

/**
 * 指南文本 → 不存在的 `ctx.*` 引用。
 * 用与运行时校验器**同一个** checkCtxUsage（但散文模式 + absent 传空表，好让「不存在」与
 * 「两半边串用」都归到同一条报告里，便于一眼看出是拼错还是串了半边）。
 */
function unknownRefs(entries: LabeledText[], allow: Set<string>): string[] {
  const problems: string[] = []
  for (const { label, text } of entries) {
    for (const issue of checkCtxUsage(text, ANY_CTX_MEMBERS, {}, { prose: true })) {
      // checkCtxUsage 的两种问题形状：
      //   「用了宿主不存在的 ctx.mcp（这里可用的只有：…）」      → 顶层成员不存在
      //   「ctx.files 没有 readFile（可用：…）」                 → 子成员不存在
      const missingSub = /^(ctx\.[A-Za-z_$][\w$]*) 没有 ([A-Za-z_$][\w$]*)/.exec(issue)
      const absentTop = /^用了宿主不存在的 (ctx\.[A-Za-z_$][\w$]*)/.exec(issue)
      const key = missingSub ? `${missingSub[1]}.${missingSub[2]}` : absentTop ? absentTop[1] : null
      if (key && allow.has(key)) continue
      problems.push(`${label}: ${issue}`)
    }
  }
  return problems
}

export function runPluginDocsApiSelfTest(): PluginDocsCase[] {
  const cases: PluginDocsCase[] = []
  const all = guideTexts()
  const joined = all.map((e) => e.text).join('\n')

  // 1) 全部指南文本里出现的 ctx.* 都必须真实存在（已知反面教材除外）
  const unknown = unknownRefs(all, KNOWN_ABSENT_MENTIONS)
  cases.push({
    name: '指南里的 ctx.* 名字都真实存在',
    ok: unknown.length === 0,
    detail: unknown.length
      ? `${unknown.length} 处：\n  - ${unknown.join('\n  - ')}`
      : `${all.length} 段文本全部通过（已知反面教材 ${KNOWN_ABSENT_MENTIONS.size} 条已登记）`,
  })

  // 2) 事实表（API 速查表）是规范性内容：连反面教材都不许出现
  const factsOnly = all.filter((e) => e.label.startsWith('FACTS['))
  const factsBad = unknownRefs(factsOnly, new Set())
  cases.push({
    name: 'API 速查表（PLUGIN_DEV_FACTS）里没有臆造成员',
    ok: factsBad.length === 0,
    detail: factsBad.length ? factsBad.join('\n  - ') : `${factsOnly.length} 条全部通过`,
  })

  // 3) 曾经写错的拼法不得再出现（本次修复的回归锁）
  const stale = FORBIDDEN_SPELLINGS.filter((s) => joined.includes(s))
  cases.push({
    name: '指南不再出现 ctx.shell.* / ctx.net.* / ctx.sessions.* 旧拼法',
    ok: stale.length === 0,
    detail: stale.length
      ? `仍出现：${stale.join('、')}（真实 API 是 ctx.host.runShell / ctx.host.fetch / ctx.host.sessions.list）`
      : `已全部改为 ctx.host.*：${FORBIDDEN_SPELLINGS.join('、')} 均未出现`,
  })

  // 4) 正确的拼法必须还在（防止将来「清理」时顺手删掉能力说明）
  const missing = REQUIRED_SPELLINGS.filter((s) => !joined.includes(s))
  cases.push({
    name: '指南仍完整记录主进程半边的 ctx.host.* 能力',
    ok: missing.length === 0,
    detail: missing.length ? `缺少：${missing.join('、')}` : REQUIRED_SPELLINGS.join('、'),
  })

  // 5) 反面教材清单本身要「真的不存在」——否则它会掩盖一个真错误
  const bogus: string[] = []
  for (const mention of KNOWN_ABSENT_MENTIONS) {
    const parts = mention.split('.') // ['ctx', top, sub?]
    const top = parts[1]
    if (!(top in ANY_CTX_MEMBERS)) continue
    if (parts.length === 3 && !(ANY_CTX_MEMBERS[top] ?? []).includes(parts[2])) continue
    bogus.push(`${mention}（它其实存在，不该出现在反面教材里）`)
  }
  cases.push({
    name: '反面教材清单里没有「其实存在」的成员',
    ok: bogus.length === 0,
    detail: bogus.length ? bogus.join('；') : `${ctxMentions(joined).length} 处 ctx.* 引用、${KNOWN_ABSENT_MENTIONS.size} 条豁免已核对`,
  })

  return cases
}

/** 命令行 / 应用内一致的自检入口（run-selftests.mjs 走这个） */
export function logPluginDocsApiSelfTest(): boolean {
  const cases = runPluginDocsApiSelfTest()
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    if (c.detail) console.log(`      ${c.detail.split('\n').join('\n      ')}`)
  }
  return cases.every((c) => c.ok)
}

/**
 * 元自测：证明上面那套检查**真的能抓到**它要防的故障，而不是恒真。
 * （本仓库的习惯：一个永远通过的测试等于没有测试。）
 */
export function runPluginDocsApiMetaTest(): PluginDocsCase[] {
  const cases: PluginDocsCase[] = []
  const prose = { prose: true }
  const has = (text: string, opts?: { prose?: boolean }) =>
    checkCtxUsage(text, ANY_CTX_MEMBERS, {}, opts).length > 0

  cases.push({
    name: 'meta: 旧拼法 ctx.shell.runShell 会被判为不存在',
    ok: has('主进程半边：ctx.shell.runShell(command, { cwd })'),
    detail: '还原 2026-11 那次真实缺陷',
  })
  cases.push({
    name: 'meta: 正确拼法 ctx.host.runShell 不被误判',
    ok: !has('主进程半边：ctx.host.runShell(command, { cwd })'),
  })
  cases.push({
    name: 'meta: 臆造子成员 ctx.files.readFile 会被判为不存在',
    ok: has('读文件用 ctx.files.readFile(path)'),
  })
  cases.push({
    name: 'meta: 散文模式不会把句末句号读成子成员',
    ok: !has('the UI half has no ctx.vue / ctx.files / ctx.slots. The host half has ctx.tool.', prose),
    detail: '同一段文本用代码正则会误报，故散文单独用 CTX_USAGE_PROSE_RE',
  })
  cases.push({
    name: 'meta: 代码模式确实会误报同一段散文（说明两种模式都必要）',
    ok: has('the UI half has no ctx.vue / ctx.files / ctx.slots. The host half has ctx.tool.'),
  })
  cases.push({
    name: 'meta: 豁免清单里的反面教材确实不存在于成员表',
    ok: KNOWN_ABSENT_MENTIONS.has('ctx.shell') && !('shell' in ANY_CTX_MEMBERS),
  })

  return cases
}
