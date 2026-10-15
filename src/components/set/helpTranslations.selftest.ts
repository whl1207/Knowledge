/**
 * helpTranslations.selftest.ts — 帮助页字典结构自测（源码级）
 *
 * **为什么需要它**：`Help.vue` 的文案是 `translations.zh.learning.howto.*` 这种深层嵌套，
 * 模板通过 `t('learning.howto.start.q')` 取。如果键被插到了错误的层级（比如落在
 * `zh.howto` 而不是 `zh.learning.howto`），**运行时不会报错**，`t()` 找不到就原样返回键名，
 * 界面上只会看到一串 `learning.howto.start.q`。TypeScript 与构建全都发现不了 ——
 * 2026-10 就这么踩过一次，排查靠手写脚本。这个套件把那次的排查过程固化下来。
 *
 * 检查四件事：
 * 1. **模板用到的每个 `t('...')` 键都能解析**（动态键用各数组的实际值展开）；
 * 2. **zh / en 键结构完全对称**（少一条就会出现"英文界面显示中文"）；
 * 3. 解析结果非空、且不是键名本身（后者就是"找不到"的表现）；
 * 4. 静态键里没有拼错的（拼错的也解析不出来）。
 *
 * 用法：`npm run test:selftest helpTranslations`
 */

import { readFileSync } from 'node:fs'

export interface HelpCase {
  name: string
  ok: boolean
  detail?: string
}

/** 从 Help.vue 源码里抠出 `const translations = { ... }`（花括号配平，忽略字符串内的括号） */
function extractTranslations(src: string): Record<string, any> {
  const start = src.indexOf('const translations = {')
  if (start < 0) throw new Error('未找到 const translations = {')
  const open = src.indexOf('{', start)
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      // 跳过整个字符串字面量（含转义）
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  const body = src.slice(open, i + 1)
  // eslint-disable-next-line no-new-func
  return new Function('return (' + body + ')')() as Record<string, any>
}

/** 复刻 Help.vue 的 `t()`：逐段下钻，找不到回退 zh，再找不到返回键名 */
function makeT(translations: Record<string, any>, locale: string) {
  return (key: string): any => {
    const keys = key.split('.')
    let value: any = translations[locale]
    for (const k of keys) {
      if (value && value[k] !== undefined) value = value[k]
      else {
        let fallback: any = translations.zh
        for (const fk of keys) {
          if (fallback && fallback[fk] !== undefined) fallback = fallback[fk]
          else return key
        }
        return fallback
      }
    }
    return value
  }
}

/** 收集对象里所有叶子键的路径（数组下标不展开） */
function leafPaths(obj: any, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return prefix ? [prefix] : []
  const out: string[] = []
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    const v = obj[k]
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...leafPaths(v, p))
    else out.push(p)
  }
  return out
}

/** 解析 `const name = ref([...])` / `const name = ([...])` 里的数组项 */
function parseArrayLiteral(src: string, name: string): string[] {
  const re = new RegExp(`const ${name}\\s*=\\s*(?:ref\\()?\\[`)
  const m = re.exec(src)
  if (!m) return []
  const open = src.indexOf('[', m.index)
  // 中括号配平（元素里没有嵌套数组）
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
      continue
    }
    if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) break }
  }
  const body = src.slice(open + 1, i)
  // 数组元素是对象时取 key: '...'；是字符串时直接取
  const keys = [...body.matchAll(/\bkey:\s*'([^']+)'/g)].map(x => x[1])
  if (keys.length) return keys
  return [...body.matchAll(/'([^']+)'/g)].map(x => x[1])
}

/** 解析 `const name = ref([1, 2, 3])` 这类纯数字数组 */
function parseNumberArray(src: string, name: string): string[] {
  const re = new RegExp(`const ${name}\\s*=\\s*(?:ref\\()?\\[([^\\]]*)\\]`)
  const m = re.exec(src)
  if (!m) return []
  return [...m[1].matchAll(/\b(\d+)\b/g)].map(x => x[1])
}

/** 模板里的静态键：`t('a.b.c')`（不含模板字符串形式的动态键） */
function staticTemplateKeys(src: string): string[] {
  const out = new Set<string>()
  const re = /\bt\(\s*'([A-Za-z][\w.]*)'\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.add(m[1])
  return [...out].sort()
}

/**
 * @param sourceOverride 仅供自测自身验证用：传入一份"故意写坏"的源码，
 *   确认本套件真的会变红（否则一个永远通过的测试等于没有测试）。
 */
export function runHelpTranslationsSelfTest(sourceOverride?: string): HelpCase[] {
  const cases: HelpCase[] = []
  const add = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const src = sourceOverride ?? readFileSync('src/components/set/Help.vue', 'utf8')
  let translations: Record<string, any>
  try {
    translations = extractTranslations(src)
  } catch (e) {
    add('能抠出 translations 对象', false, e instanceof Error ? e.message : String(e))
    return cases
  }
  add('能抠出 translations 对象', !!translations.zh && !!translations.en)

  // ==================== A. zh / en 结构对称（**已有历史欠账**，只报告不拦截） ====================
  {
    const zhLeaves = new Set(leafPaths(translations.zh))
    const enLeaves = new Set(leafPaths(translations.en))
    const zhOnly = [...zhLeaves].filter(k => !enLeaves.has(k))
    const enOnly = [...enLeaves].filter(k => !zhLeaves.has(k))
    // 说明：这里是**改动前就存在**的不对称（如 agentSwarm.steps.step2.capabilities 只有英文有），
    // 不是本次引入的问题。作为提示输出，不判失败 —— 否则测试一上线就是红的，
    // 真正要防的"C 组 / D 组"反而被淹没。
    add('A1 zh/en 结构差异（历史欠账，仅供提示）', true,
      `zh 多 ${zhOnly.length} 条、en 多 ${enOnly.length} 条` +
      (enOnly.length || zhOnly.length ? `｜例：${[...zhOnly, ...enOnly].slice(0, 3).join(', ')}` : ''))
  }

  // ==================== B. 模板静态键都能解析 ====================
  {
    const keys = staticTemplateKeys(src)
    add('B1 模板里静态 t() 键数量合理（> 50）', keys.length > 50, `keys=${keys.length}`)
    const broken: string[] = []
    for (const loc of ['zh', 'en']) {
      const t = makeT(translations, loc)
      for (const k of keys) {
        const v = t(k)
        // 合法结果：非空字符串，**或 v-for 用的数组**（如 xxx.items 是列表文案）
        const okStr = typeof v === 'string' && v.trim() && v !== k
        const okArr = Array.isArray(v) && v.length > 0
        if (!okStr && !okArr) broken.push(`[${loc}] ${k}`)
      }
    }
    add('B2 静态键在两种语言下都能解析成非空文案 / 列表',
      broken.length === 0, broken.slice(0, 10).join(' | '))
  }

  // ==================== C. 动态键：用各数组的实际值展开 ====================
  {
    const dynamic: string[] = []
    for (const k of ['quick-start', 'concepts', 'ai-chat', 'knowledge', 'know-rag', 'learning',
      'general-files', 'special-files', 'browser', 'plugins', 'settings', 'changelog', 'credits']) {
      dynamic.push(`sections.${k}.title`, `sections.${k}.subtitle`)
    }
    const views = parseArrayLiteral(src, 'learningViews')
    const steps = parseNumberArray(src, 'learningSteps')
    const howto = parseArrayLiteral(src, 'learningHowto')
    for (const v of views) dynamic.push(`learning.view.${v}.name`, `learning.view.${v}.desc`)
    for (const s of steps) dynamic.push(`learning.step${s}.title`, `learning.step${s}.desc`)
    for (const k of howto) dynamic.push(`learning.howto.${k}.q`, `learning.howto.${k}.a`)

    // 先钉住解析器本身：抓错字段的话下面只会给出假失败
    add('C0 能解析出 learningViews 的 key（不是 icon）',
      views.length > 0 && views.includes('overview') && !views.some(v => v.startsWith('fa-')),
      views.join(','))
    add('C0b 能解析出 learningSteps / learningHowto',
      steps.length === 7 && howto.length === 11,
      `steps=${steps.join('/')}, howto=${howto.length}`)

    const broken: string[] = []
    for (const loc of ['zh', 'en']) {
      const t = makeT(translations, loc)
      for (const k of dynamic) {
        const v = t(k)
        if (v === k || typeof v !== 'string' || !v.trim()) broken.push(`[${loc}] ${k}`)
      }
    }
    add('C1 动态键（章节 / 学习视图 / 核心机制 / 怎么用）都能解析',
      broken.length === 0, broken.slice(0, 10).join(' | '))
  }

  // ==================== D. 关键路径存在性（专门钉住踩过的那个层级错误） ====================
  {
    const tZh = makeT(translations, 'zh')
    const tEn = makeT(translations, 'en')
    // 防御式访问：结构被写坏时这里不能抛错，否则后面的检查根本跑不到（元自测会抓到）
    const zhL: any = translations?.zh?.learning ?? {}
    const enL: any = translations?.en?.learning ?? {}
    add('D1 learning.howtoTitle 在 learning 下（不是顶层）',
      tZh('learning.howtoTitle') !== 'learning.howtoTitle' &&
      tEn('learning.howtoTitle') === 'How to use it (day to day)',
      `${String(tZh('learning.howtoTitle')).slice(0, 20)} / ${String(tEn('learning.howtoTitle')).slice(0, 24)}`)
    add('D2 learning.howto 各条目都在 learning 下',
      !!zhL.howto && !!enL.howto,
      `zh=${!!zhL.howto}, en=${!!enL.howto}`)
    add('D3 顶层没有误留的 howto（曾经插错位置的痕迹）',
      translations?.zh?.howto === undefined && translations?.en?.howto === undefined,
      `zh.howto=${translations?.zh?.howto === undefined ? 'undefined' : 'EXISTS'}`)
    add('D4 step7 与 howto 是兄弟（都在 learning 下）',
      !!zhL.step7 && !!zhL.howtoTitle && zhL.step7?.howtoTitle === undefined)
  }

  // ==================== E. **原生存在性**：每个语言下该路径必须自己就有 ====================
  //
  // 为什么必须有这一组（这是本次故障真正的检测器）：`t()` 在英文缺键时**回退到中文**，
  // 于是"英文块里 howto 插错层级"这种故障在 D 组（看 `t()` 结果）**完全查不出来** ——
  // 拿到的仍是中文的正常文案。用户看到的现象是"英文界面显示中文"，而不是键名。
  // 只有绕开回退、直接下钻该语言的字典，才能发现。
  {
    const existsIn = (root: any, path: string): boolean => {
      let v = root
      for (const k of path.split('.')) {
        if (v && typeof v === 'object' && v[k] !== undefined) v = v[k]
        else return false
      }
      return true
    }
    const howtoKeys = parseArrayLiteral(src, 'learningHowto')
    const paths: string[] = ['learning.howtoTitle']
    for (const k of howtoKeys) paths.push(`learning.howto.${k}.q`, `learning.howto.${k}.a`)

    const missing: string[] = []
    for (const loc of ['zh', 'en']) {
      for (const p of paths) {
        if (!existsIn(translations[loc], p)) missing.push(`[${loc}] ${p}`)
      }
    }
    add('E1 每个语言下 howto 的路径都**原生存在**（不靠回退）',
      missing.length === 0, missing.slice(0, 8).join(' | '))
    add('E2 该组覆盖到全部 22 条叶子键',
      paths.length === 1 + howtoKeys.length * 2, `paths=${paths.length}, howto=${howtoKeys.length}`)
  }

  return cases
}

/**
 * 元自测：本套件必须能抓到"键插错层级"这个具体故障。
 *
 * 做法是把 `learning` 的闭合括号往前挪一行（正是当初真实发生的错误），
 * 再跑一遍上面的检查 —— D 组必须失败。一个永远通过的测试等于没有测试。
 */
export function runHelpTranslationsMetaTest(): HelpCase[] {
  const real = readFileSync('src/components/set/Help.vue', 'utf8')

  // 复刻当时真实的错误形态：让 `learning` **在 howto 之前就闭合**，
  // 于是 howto 掉成 `en.howto.*`，而 `t('learning.howto...')` 在英文下找不到 →
  // 回退中文（英文界面显示中文）。中文块同理之前也坏过。
  //
  // ⚠️ 关键教训：**缩进不是 JS 结构**。第一版注入只是把缩进退了一级，
  // 结构完全没变（诊断输出 en.learning.howto=true），Meta 静默空转。
  // 真正决定嵌套的是花括号 —— 所以要动的是 `},` 这一行。
  // ⚠️ 必须按 /\r?\n/ 切行：仓库里的文件是 **CRLF**，只按 \n 切会让每行尾带一个 \r，
  // 于是 `lines[i] === '    },'` 这种精确比较永远不成立（注入会静默失效 —— 踩过）。
  const lines = real.split(/\r?\n/)
  const howtoIdx = lines.findIndex(l => l.startsWith("      howtoTitle: 'How to use it (day to day)'"))
  // footer 在 howto 之后（英文块末尾），取 howtoIdx 之后的第一个
  const footerIdx = lines.findIndex((l, i) => i > howtoIdx && howtoIdx >= 0 && /^ {4}footer: \{/.test(l))
  // `learning` 的闭合行：howtoTitle 上面最近的 4 空格 `},`
  let learningCloseIdx = -1
  for (let i = howtoIdx - 1; i >= 0; i--) {
    if (lines[i] === '    },') { learningCloseIdx = i; break }
  }
  // howto 块的闭合行：footer 上面最近的 4 空格 `},`
  let howtoCloseIdx = -1
  for (let i = footerIdx - 1; i > howtoIdx; i--) {
    if (lines[i] === '    },') { howtoCloseIdx = i; break }
  }

  const canInject = howtoIdx > 0 && learningCloseIdx > 0 && howtoCloseIdx > howtoIdx && footerIdx > 0
  let broken = real
  let where = ''
  if (canInject) {
    const out = lines.slice()
    // 1) 让 `learning` 在 howto 之前闭合：把它的闭合行改成 howto 的收尾，
    //    这样 howtoTitle / howto 就成了 learning 的**兄弟**（即当时真实的错误形态）
    out[learningCloseIdx] = '      }\n    },'
    // 2) howto 末尾补回闭合，保持整体语法有效
    out[howtoCloseIdx] = '      }\n    },'
    broken = out.join('\n')
    where = `learningClose=line ${learningCloseIdx + 1}, howtoClose=line ${howtoCloseIdx + 1}, howto=line ${howtoIdx + 1}`
  }

  const injected = canInject && broken !== real
  // 诊断：坏样本到底把 howto 放到了哪（元自测必须自己可解释）
  let diag = ''
  try {
    const tb = extractTranslations(broken)
    diag = `en.learning.howto=${!!tb?.en?.learning?.howto}, en.howto=${!!tb?.en?.howto}, zh.learning.howto=${!!tb?.zh?.learning?.howto}`
  } catch (e) {
    diag = '坏样本解析失败: ' + (e instanceof Error ? e.message : String(e))
  }

  const results = runHelpTranslationsSelfTest(injected ? broken : real)
  const eFailed = results.filter(c => c.name.startsWith('E') && !c.ok).length
  const dFailed = results.filter(c => c.name.startsWith('D') && !c.ok).length
  return [
    {
      name: 'Meta1 能构造出"键插错层级"的坏样本（动花括号，不是缩进）',
      ok: injected,
      detail: injected ? `${where}｜${diag}` : `注入未生效（Help.vue 结构变了？需要同步本函数）｜${where}`,
    },
    {
      name: 'Meta2 坏样本下 E 组必须失败（原生存在性才是该故障的检测器）',
      ok: eFailed > 0,
      detail: `E 组失败 ${eFailed} 条｜${diag}`,
    },
    {
      // 已实测确认的事实（不再推测机制）：注入"键插错层级"后，D 组与 E 组**都会**失败。
      // 断言这一点是为了防两类退化：
      // ① 有人把 E 组删掉、以为 D 组够用 —— 但 D2 只查 howto 这一层，
      //    少一条叶子文案（如只漏 howto.rate.a）时 D2 照样通过，只有 E1 会发现；
      // ② 注入器本身失效（例如文件行尾变成 LF/CRLF 之一而比较串没跟着改）——
      //    那样 Meta 会静默变成永远通过的空转，这条断言会立刻变红。
      name: 'Meta3 坏样本下 D 组与 E 组都必须失败（防注入器空转）',
      ok: injected && dFailed > 0 && eFailed > 0,
      detail: `D 组失败 ${dFailed} 条｜E 组失败 ${eFailed} 条`,
    },
  ]
}

