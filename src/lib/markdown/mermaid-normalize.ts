/**
 * Mermaid 源码规范化 —— 唯一实现（归口模块）
 *
 * 以下三件套曾在 6 个文件重复复制：
 *   src/lib/markdown/render.ts、src/lib/export/md-to-docx.ts、
 *   src/components/block_md.vue、src/components/knowFile/view/md_read.vue、
 *   src/components/knowFile/view/md_ppt.vue
 * 2026-09 归口到此模块，各消费方统一从这里 import（src/lib/markdown/render.ts 仅做
 * re-export 以兼容既有外部导入；原重复实现的 utils/markdownRender.ts 已删除）。
 *
 * 已知坑（勿回退，改动前先看这里）：
 * - 行首单个 `%` → 自动改为 `%%`：mermaid 注释必须是 `%%`，单个 `%` 会 parse error；
 * - `[]` 方括号文本自动加引号：文本含半角括号等特殊字符时 mermaid 解析失败；
 * - `{}` 菱形文本同样加引号：如 `C{...第二次世界大战 (WWII)}` 的 `( )` 会 parse error；
 * - 标签已是 `"..."` 引号字符串时跳过，避免二次包裹（如 `subgraph R["..."]`）；
 * - 加引号前先把行内已有 `"..."` 遮成占位符：否则边标签里的 `{…}` 会被二次加引号
 *   （`A --"attempt{id,ok}"--> B` → `A --"attempt{"id,ok"}"--> B`，引号套引号反而报错）。
 *   这个坑曾让「未加引号标签」修好了，却把「已加引号的边标签」弄坏。
 */

/** 清洗 Mermaid 标识符（类名/节点 id）：替换非法字符，数字开头补 C 前缀 */
export const sanitizeMermaidIdentifier = (value: string): string => {
  const base = value
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'C$1')

  return base || 'Node'
}

/** 规范化 classDiagram：转换为 flowchart LR（关系/类体 → 节点与连线） */
export const normalizeClassDiagramSource = (source: string): string => {
  const lines = source.split(/\r?\n/)
  const flowchartLines: string[] = ['flowchart LR']
  const classBodies = new Map<string, string[]>()
  let currentClass: string | null = null

  lines.forEach((rawLine) => {
    const line = rawLine.trim()
    if (!line || line.startsWith('%%') || line.startsWith('direction')) return

    const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)\s*\{$/)
    if (classMatch) {
      currentClass = classMatch[1]
      classBodies.set(currentClass, [])
      return
    }

    if (currentClass && line === '}') {
      currentClass = null
      return
    }

    if (currentClass) {
      const bodyLine = line.replace(/^\+\s*/, '').replace(/^\-\s*/, '').trim()
      if (bodyLine) {
        const items = classBodies.get(currentClass) || []
        items.push(bodyLine)
        classBodies.set(currentClass, items)
      }
      return
    }

    const relationMatch = line.match(/^([A-Za-z0-9_]+)\s*(<\|--|-->|--\*|\-\*|-->|--)\s*([A-Za-z0-9_]+)(?:\s*:\s*(.+))?$/)
    if (relationMatch) {
      const [, left, _operator, right, label] = relationMatch
      const leftId = sanitizeMermaidIdentifier(left)
      const rightId = sanitizeMermaidIdentifier(right)
      const relationLabel = label ? `|${label.replace(/\|/g, ' ')}|` : ''
      flowchartLines.push(`    ${leftId} -->${relationLabel} ${rightId}`)
    }
  })

  Array.from(classBodies.entries()).forEach(([name, bodyLines]) => {
    const nodeId = sanitizeMermaidIdentifier(name)
    const label = [name, ...bodyLines].join('<br/>')
    flowchartLines.push(`    ${nodeId}["${label.replace(/"/g, '\\"')}"]`)
  })

  return flowchartLines.join('\n')
}

/** 标签是否本来就是引号字符串（含已被遮罩成占位符的情况）——是则不要二次包裹 */
const isQuotedLabel = (label: string): boolean =>
  /^"[^"]*"$/.test(label) || /^\u0000\d+\u0000$/.test(label)

/** 规范化 Mermaid 源码：classDiagram → flowchart；修正单 % 注释；[]/{} 标签加引号 */
export const normalizeMermaidSource = (source: string): string => {
  if (!source) return ''

  const trimmed = source.trim()
  if (/^classDiagram\b/i.test(trimmed)) {
    return normalizeClassDiagramSource(trimmed)
  }

  return source
    .split(/\r?\n/)
    .map((line) => {
      const trimmedLine = line.trim()
      if (!trimmedLine) return line
      // 已是 %% 注释：原样返回
      if (trimmedLine.startsWith('%%')) return line
      // 单个 % 注释：mermaid 语法要求 %%（单 % 会解析失败），这里自动修正
      if (/^%(\s|$)/.test(trimmedLine)) return line.replace(/^(\s*)%/, '$1%%')

      // 先把行内已有的 "..." 片段遮起来再做加引号处理。
      // 否则边标签里的 {…} 会被二次加引号：A --"attempt{id,ok}"--> B
      //   → A --"attempt{"id,ok"}"--> B（引号套引号，反而变成 parse error）
      const quoted: string[] = []
      const masked = line.replace(/"[^"]*"/g, (m) => {
        quoted.push(m)
        return '\u0000' + (quoted.length - 1) + '\u0000'
      })

      const replaced = masked
        .replace(/(\b[A-Za-z0-9_.\-$]+)\[([^\]]*)\]/g, (match, id, label) => {
          // 标签已是引号字符串（如 subgraph R["..."]）时跳过，避免二次包裹导致语法错误
          if (isQuotedLabel(label)) return match
          const safeLabel = label
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\r?\n/g, '<br/>')
          return `${id}["${safeLabel}"]`
        })
        // 菱形 {…} 文本同样加引号：mermaid 中 {…} 文本含半角括号等字符会解析失败
        .replace(/(\b[A-Za-z0-9_.\-$]+)\{([^}]*)\}/g, (match, id, label) => {
          if (isQuotedLabel(label)) return match
          const safeLabel = label
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\r?\n/g, '<br/>')
          return `${id}{"${safeLabel}"}`
        })

      return replaced.replace(/\u0000(\d+)\u0000/g, (_m, i) => quoted[Number(i)] ?? '')
    })
    .join('\n')
}
