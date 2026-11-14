/**
 * skill-dev-check.ts — 内置 MCP 服务 builtin-skill-dev 的自检工具（skill_dev_check）
 *
 * 为什么要有它：技能是**磁盘上的目录**，写错一个字段就可能变成「装上了但永远不触发」，
 * 或者「正文引用了不存在的 references」——这些在对话里肉眼看不出，只有跑一遍检查才暴露。
 * 与 plugin_dev_check 同一套纪律：交付前必须跑，有 ✗ 就改到没有。
 *
 * 判据来源：
 *  - 元数据解析直接复用主进程 skill-service 的 parseSkillMetadata（宿主真实实现，不是另写一份）；
 *  - 目录 / name / `$` 触发规则、资源引用约定来自 skill-service 与 src/services/agentSkills.ts；
 *  - 体积与写法建议来自 skill-creator 的渐进披露实践（正文 < 500 行、长内容拆 references）。
 *
 * 纯 Node 实现（不依赖 electron），可以单独跑自测（scripts/run-selftests.mjs skillDevCheck）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { parseSkillMetadata } from '../skill-service'

/** 正文建议上限（字符；约 500 行 Markdown） */
const BODY_SOFT_LIMIT = 8000
/** 正文硬上限（超过基本等于把一整本手册塞进上下文） */
const BODY_HARD_LIMIT = 40000
/** 单技能总大小建议上限（字节） */
const TOTAL_SOFT_LIMIT = 2 * 1024 * 1024
/** description 建议长度（字符） */
const DESCRIPTION_SOFT_LIMIT = 300

/** frontmatter 已知字段（其余字段会被忽略；拼错的字段名会丢元数据） */
const KNOWN_FRONTMATTER_KEYS = new Set([
  'name', 'description', 'version', 'author', 'tags', 'emoji', 'homepage', 'always',
  'skillKey', 'primaryEnv', 'os', 'requires', 'install',
  // 兼容字段（AI-KM 读取 short-description 的变体）
  'shortDescription', 'short_description', 'short-description', 'metadata', 'source',
])

export interface SkillCheckOptions {
  /** 已装技能清单（用于重名判断） */
  installed?: Array<{ name: string; path?: string }>
}

interface Finding {
  level: 'error' | 'warn' | 'info'
  message: string
}

/** 递归统计目录大小与文件数 */
function walkSize(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (d: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        files++
        try { bytes += statSync(p).size } catch { /* ignore */ }
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/** 逐行扫描：检测「引用了技能目录里不存在的资源」 */
function checkResourceRefs(skillDir: string, body: string): string[] {
  const missing: string[] = []
  const seen = new Set<string>()
  const candidates: string[] = []

  // 1) Markdown 链接 / 图片：[x](./references/a.md) / ![x](/assets/logo.png)
  for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    candidates.push(m[1])
  }
  // 2) 反引号里以 / 开头的路径：`/references/schema.md`
  for (const m of body.matchAll(/`(\/[^`\s]+)`/g)) {
    candidates.push(m[1])
  }

  for (const raw of candidates) {
    let ref = String(raw || '').trim()
    if (!ref) continue
    // 跳过外链、锚点、协议、模板占位
    if (/^(https?:|mailto:|tel:|#|data:)/i.test(ref)) continue
    if (ref.startsWith('<')) continue
    ref = ref.split('#')[0].split('?')[0]
    if (!ref || ref.startsWith('..')) continue
    // 以 `/` 开头 = 相对技能目录（这是本项目的约定）。注意 path.isAbsolute('/x') 在
    // Windows 上也是 true，所以必须先判 `/` 前缀，不能先调 isAbsolute。
    const abs = ref.startsWith('/')
      ? join(skillDir, ref.replace(/^\/+/, ''))
      : isAbsolute(ref)
        ? normalize(ref)
        : join(skillDir, ref)
    if (seen.has(abs)) continue
    seen.add(abs)
    if (!existsSync(abs)) missing.push(raw)
  }
  return missing
}

/**
 * 检查一个技能目录。
 * @param dir 技能目录绝对路径
 * @param opts.installed 已装技能清单（重名检查；拿不到就跳过）
 */
export function checkSkillDir(dir: string, opts: SkillCheckOptions = {}): string {
  const findings: Finding[] = []
  const add = (level: Finding['level'], message: string) => findings.push({ level, message })
  const target = String(dir || '').trim()

  if (!target) {
    return '✗ 缺少 dir：传技能目录的绝对路径，或技能名（由宿主在技能目录下解析）。'
  }
  if (!existsSync(target)) {
    return `✗ 目录不存在：${target}\n· 用 skill_dev_host 确认技能目录的绝对路径；目录名要等于 frontmatter 的 name。`
  }
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(target)
  } catch (e: any) {
    return `✗ 读不了目录：${target}（${e?.message || e}）`
  }
  if (!stat.isDirectory()) {
    return `✗ 不是目录：${target}\n· 技能是「一个目录 + 里面的 SKILL.md」，不是单个文件。`
  }

  // ---- 1. SKILL.md 是否存在 / 可读 / 编码 ----
  const skillMd = join(target, 'SKILL.md')
  if (!existsSync(skillMd)) {
    return [
      `✗ 缺少 SKILL.md：${target}`,
      '· 技能目录里必须有 SKILL.md（文件名大小写要完全一致）。',
      '· 最小结构见 skill_dev_templates 的 minimal。',
    ].join('\n')
  }
  let content = ''
  try {
    content = readFileSync(skillMd, 'utf8')
  } catch (e: any) {
    return `✗ 读不了 SKILL.md：${e?.message || e}`
  }
  if (!content.trim()) return '✗ SKILL.md 是空的：至少要有 frontmatter（name / description）与正文。'
  if (content.includes('\uFFFD')) {
    add('warn', 'SKILL.md 里有替换字符（�）：可能不是 UTF-8 保存的，中文会乱码。请用 UTF-8 重存。')
  }

  // ---- 2. frontmatter ----
  if (!/^\uFEFF?---\r?\n/.test(content)) {
    add('error', 'SKILL.md 开头不是 `---` 包裹的 YAML frontmatter：没有 frontmatter 技能会整条被跳过。')
  } else {
    const meta = parseSkillMetadata(content)
    if (!meta) {
      add('error', 'frontmatter 解析失败（YAML 不合法）。最常见的两个原因：① 值里有 `: ` 却没加引号；② 缩进不齐 / 列表写法混用。')
    } else {
      const name = typeof meta.name === 'string' ? meta.name.trim() : ''
      const description = typeof meta.description === 'string' ? meta.description.trim() : ''

      if (!name) {
        add('error', 'frontmatter 缺少 name（必填，且只能用 [A-Za-z0-9_-]）。')
      } else {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) {
          add('warn', `name「${name}」含 [A-Za-z0-9_-] 之外的字符：\`$${name}\` 无法显式触发（仍可被模型按描述命中）。建议改成英文小写短横线。`)
        }
        const folder = basename(normalize(target))
        if (folder !== name) {
          add('warn', `目录名「${folder}」与 frontmatter name「${name}」不一致：宿主按 name 识别技能，改名 / 迁移时容易混乱。建议保持两者一致。`)
        }
      }

      if (!description) {
        add('error', 'frontmatter 缺少 description：它是**唯一的自动触发依据**，没有它技能永远不会被选中。')
      } else {
        if (description.length < 12) {
          add('warn', `description 太短（${description.length} 字符）：写清"做什么 + 什么场景 + 用户会怎么说"，否则基本不会触发。`)
        }
        if (description.length > DESCRIPTION_SOFT_LIMIT) {
          add('warn', `description 偏长（${description.length} 字符，建议 ≤ ${DESCRIPTION_SOFT_LIMIT}）：它常驻系统提示，太长会挤占上下文。把细节移到正文。`)
        }
        if (/^(when needed|as needed|helps? (the )?user|a skill for|use this skill)/i.test(description)) {
          add('warn', 'description 像是"占位描述"（没有具体触发场景）：把用户可能的说法与任务写进去。')
        }
      }

      // 未知/拼错字段
      for (const key of Object.keys(meta)) {
        if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
          add('warn', `frontmatter 里有未知字段「${key}」：会被忽略，确认不是拼错（如 descripton / tag）。`)
        }
      }
      if (meta.always === true) {
        add('warn', 'frontmatter 里 always: true：该技能每轮都会注入正文，明显增加上下文成本。确认确实需要常驻。')
      }
      if (meta.requires && typeof meta.requires === 'object' && Array.isArray((meta.requires as any).bins) && (meta.requires as any).bins.length) {
        add('info', `声明了依赖命令：${(meta.requires as any).bins.join('、')}（正文里要写清没装时怎么办）。`)
      }

      // 重名（同一技能目录下）
      const installed = (opts.installed || []).filter((s) => s && s.name === name)
      const other = installed.find((s) => s.path && normalize(s.path) !== normalize(target))
      if (other) {
        add('warn', `已存在同名技能「${name}」（${other.path}）：同名时后加载的会覆盖先加载的，建议换一个唯一名字。`)
      } else if (installed.length) {
        add('info', `同名技能已安装（${installed[0].path || '当前目录'}）：写入将更新它。`)
      }
    }
  }

  // ---- 3. 正文 ----
  const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const bodyLen = body.trim().length
  if (!bodyLen) {
    add('error', '正文为空：frontmatter 之后要写操作手册（何时用 / 步骤 / 输出格式 / 失败处理）。')
  } else {
    if (bodyLen > BODY_HARD_LIMIT) {
      add('error', `正文 ${bodyLen} 字符，超过硬上限 ${BODY_HARD_LIMIT}：模型一次读不完，长内容必须拆 references/。`)
    } else if (bodyLen > BODY_SOFT_LIMIT) {
      add('warn', `正文 ${bodyLen} 字符，超过建议上限 ${BODY_SOFT_LIMIT}（约 500 行）：把细节拆进 references/，正文只留流程与"何时读哪份"。`)
    }
    if (bodyLen < 120) {
      add('warn', `正文只有 ${bodyLen} 字符：太短，通常缺少可执行步骤或输出格式。`)
    }
    if (!/^##\s+/m.test(body)) {
      add('info', '正文没有二级标题：建议按「何时使用 / 步骤 / 输出格式 / 失败处理 / 检查清单」分节。')
    }
    const missing = checkResourceRefs(target, body)
    for (const ref of missing.slice(0, 12)) {
      add('error', `引用的资源不存在：${ref}（以 / 开头的路径相对技能目录，必须真实存在）`)
    }
    if (missing.length > 12) add('warn', `还有 ${missing.length - 12} 处资源引用不存在（只列了前 12 条）。`)
  }

  // ---- 4. 体积 / 文件清单 ----
  const { bytes, files } = walkSize(target)
  const mb = bytes / 1024 / 1024
  if (bytes > TOTAL_SOFT_LIMIT) {
    add('warn', `技能目录共 ${mb.toFixed(2)} MB（${files} 个文件），超过建议上限 2 MB：技能应只放文档与小脚本，大资产请放工作区。`)
  }
  if (files === 0) add('info', '技能目录里除 SKILL.md 没有其它文件：只用正文的技能是合法的，需要脚本/模板时再加 references/scripts/assets。')

  // ---- 5. 输出 ----
  const errors = findings.filter((f) => f.level === 'error')
  const warns = findings.filter((f) => f.level === 'warn')
  const infos = findings.filter((f) => f.level === 'info')
  const lines: string[] = [
    `【技能自检】${basename(normalize(target))}`,
    `目录：${target}`,
    `SKILL.md：${content.length} 字符（正文 ${bodyLen}）· 目录共 ${files} 个文件 / ${mb.toFixed(2)} MB`,
    '',
  ]
  if (errors.length) {
    lines.push(`✗ 必须修（${errors.length}）：`)
    lines.push(...errors.map((f) => `  ✗ ${f.message}`))
  }
  if (warns.length) {
    lines.push(`! 建议改（${warns.length}，不阻断）：`)
    lines.push(...warns.map((f) => `  ! ${f.message}`))
  }
  if (infos.length) {
    lines.push(`· 提示（${infos.length}）：`)
    lines.push(...infos.map((f) => `  · ${f.message}`))
  }
  if (!errors.length && !warns.length && !infos.length) lines.push('✓ 没有发现问题。')
  lines.push('')
  lines.push(errors.length
    ? `结论：✗ 还有 ${errors.length} 项必须修；改完文件后再跑一次 skill_dev_check，直到没有 ✗ 才交付。`
    : `结论：✓ 可以交付${warns.length ? `（有 ${warns.length} 条建议，交付说明里可以提一句）` : ''}。交付时给出 \`$技能名\` 与 2~3 条试跑 prompt。`)
  return lines.join('\n')
}
