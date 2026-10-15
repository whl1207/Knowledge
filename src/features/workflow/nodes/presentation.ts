/**
 * 节点外观元数据（图标 / 配色 / 名称键）
 *
 * 图标沿用项目既有的 Font Awesome 字形方案，保证与软件其他部分一致；
 * 与 Dify 的视觉对齐由卡片布局和配色承担（P1 画布期细化）。
 *
 * ## 升级到 Font Awesome 5 时的两个要点（改 glyph 前必读）
 * 1. **字族名变了**：`FontAwesome` → `Font Awesome 5 Free`。用到这些 glyph 的 CSS
 *    （DifyNodeCard / NodePicker / PropertiesPanel）已经改为新字族名，并统一走
 *    `font-weight: var(--node-glyph-weight, 900)`。
 * 2. **线框与实心靠「字重」区分，不是不同码位**：FA5 把 FA4 的 `-o` 线框变体与实心变体
 *    合并成同一个码位，只能用 400（线框）/ 900（实心）区分。
 *    所以原来用 `-o` 图标的条目必须显式写 `weight: 400`，否则会**静默变成实心字形**。
 *    本表里 5 个图标（`-o` 来源）需要 400：`\f044`、`\f15c`、`\f017`、`\f1c2`、`\f1c3`。
 *    注意 `\f15c` 有两处来源不同 —— `document-extractor` 原本是 `fa-file-text-o`（要 400），
 *    而 `ai-km-file` 原本是实心的 `fa-file-text`（保持默认 900），**不要一律当成线框**。
 */

export interface NodePresentation {
  /** 节点名称的本地化键 */
  labelKey: string
  /** Font Awesome 字形（码位） */
  glyph: string
  /**
   * 字形字重：400 = FA4 的 `-o` 线框变体，900（默认）= 实心。
   * FA5 用字重而非码位区分线框/实心，所以这个字段对 `-o` 来源的图标是必需的。
   */
  weight?: 400 | 900
  /** 卡片主色 */
  color: string
}

const DEFAULT_PRESENTATION: NodePresentation = {
  labelKey: '',
  glyph: '\u{f128}',
  color: '#64748b',
}

export const NODE_PRESENTATION: Record<string, NodePresentation> = {
  start: { labelKey: 'node.start', glyph: '\u{f144}', color: '#22c55e' },
  'start-placeholder': { labelKey: 'node.start-placeholder', glyph: '\u{f144}', color: '#22c55e' },
  end: { labelKey: 'node.end', glyph: '\u{f11e}', color: '#ef4444' },
  answer: { labelKey: 'node.answer', glyph: '\u{f075}', color: '#3b82f6' },
  llm: { labelKey: 'node.llm', glyph: '\u{f2db}', color: '#6366f1' },
  'knowledge-retrieval': { labelKey: 'node.knowledge-retrieval', glyph: '\u{f1c0}', color: '#8b5cf6' },
  'question-classifier': { labelKey: 'node.question-classifier', glyph: '\u{f126}', color: '#ec4899' },
  'if-else': { labelKey: 'node.if-else', glyph: '\u{f0e8}', color: '#ec4899' },
  code: { labelKey: 'node.code', glyph: '\u{f121}', color: '#0ea5e9' },
  'template-transform': { labelKey: 'node.template-transform', glyph: '\u{f362}', color: '#14b8a6' },
  'http-request': { labelKey: 'node.http-request', glyph: '\u{f0ac}', color: '#f59e0b' },
  tool: { labelKey: 'node.tool', glyph: '\u{f0ad}', color: '#0d9488' },
  'variable-aggregator': { labelKey: 'node.variable-aggregator', glyph: '\u{f247}', color: '#7c3aed' },
  'variable-assigner': { labelKey: 'node.variable-assigner', glyph: '\u{f044}', weight: 400, color: '#0891b2' },
  assigner: { labelKey: 'node.assigner', glyph: '\u{f044}', weight: 400, color: '#0891b2' },
  'parameter-extractor': { labelKey: 'node.parameter-extractor', glyph: '\u{f022}', color: '#d946ef' },
  iteration: { labelKey: 'node.iteration', glyph: '\u{f01e}', color: '#0d9488' },
  'iteration-start': { labelKey: 'node.iteration-start', glyph: '\u{f04b}', color: '#0d9488' },
  loop: { labelKey: 'node.loop', glyph: '\u{f021}', color: '#0284c7' },
  'loop-start': { labelKey: 'node.loop-start', glyph: '\u{f04b}', color: '#0284c7' },
  'loop-end': { labelKey: 'node.loop-end', glyph: '\u{f04d}', color: '#0284c7' },
  'document-extractor': { labelKey: 'node.document-extractor', glyph: '\u{f15c}', weight: 400, color: '#0284c7' },
  'list-operator': { labelKey: 'node.list-operator', glyph: '\u{f03a}', color: '#0891b2' },
  agent: { labelKey: 'node.agent', glyph: '\u{f17b}', color: '#7c3aed' },
  'agent-v2': { labelKey: 'node.agent-v2', glyph: '\u{f17b}', color: '#7c3aed' },
  'human-input': { labelKey: 'node.human-input', glyph: '\u{f007}', color: '#64748b' },
  datasource: { labelKey: 'node.datasource', glyph: '\u{f1e6}', color: '#0ea5e9' },
  'datasource-empty': { labelKey: 'node.datasource-empty', glyph: '\u{f1e6}', color: '#0ea5e9' },
  'knowledge-index': { labelKey: 'node.knowledge-index', glyph: '\u{f02d}', color: '#8b5cf6' },
  'trigger-schedule': { labelKey: 'node.trigger-schedule', glyph: '\u{f017}', weight: 400, color: '#f59e0b' },
  'trigger-webhook': { labelKey: 'node.trigger-webhook', glyph: '\u{f0e7}', color: '#f59e0b' },
  'trigger-plugin': { labelKey: 'node.trigger-plugin', glyph: '\u{f12e}', color: '#f59e0b' },
  'ai-km-word': { labelKey: 'node.ai-km-word', glyph: '\u{f1c2}', weight: 400, color: '#2b579a' },
  'ai-km-csv': { labelKey: 'node.ai-km-csv', glyph: '\u{f1c3}', weight: 400, color: '#217346' },
  'ai-km-file': { labelKey: 'node.ai-km-file', glyph: '\u{f15c}', color: '#0284c7' },
  'ai-km-knowledge': { labelKey: 'node.ai-km-knowledge', glyph: '\u{f1c0}', color: '#7c3aed' },
  'ai-km-mcp': { labelKey: 'node.ai-km-mcp', glyph: '\u{f1e6}', color: '#0891b2' },
  'ai-km-subflow': { labelKey: 'node.ai-km-subflow', glyph: '\u{f0e8}', color: '#ea580c' },
}

/** 取节点外观；未知类型回落到通用外观并把类型名当名称 */
export function getNodePresentation(type: string): NodePresentation {
  return NODE_PRESENTATION[type] ?? { ...DEFAULT_PRESENTATION, labelKey: '' }
}
