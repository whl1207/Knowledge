/**
 * attributeValues.ts — 图谱「属性值 → 节点」的取值归一化
 *
 * 属性值直接来自 Markdown 文件头部的 YAML frontmatter（主进程 `getConfig`，js-yaml 解析），
 * 类型并不确定：
 *   - 字符串：可能用 `;` / `；` 分隔多个值（项目的既有约定），也可能带换行；
 *   - 数字 / 布尔：如 `年份: 2024`、`完成: true`；
 *   - 日期：js-yaml 会把 `2024-01-02` 这类 ISO 日期直接解析成 Date；
 *   - 数组：如 `标签: [AI, 知识库]`；
 *   - 对象：如 `来源: { name: 某某 }`。
 *
 * 图谱按字段展开节点时必须先把它们统一成「标签字符串数组」。旧实现直接对值调用
 * `.split()`，遇到非字符串就抛 `TypeError: ...split is not a function`，
 * 点开字段开关即崩溃（这也是图谱视图报错的根因）。
 *
 * 展示约定与表格/搜索保持一致：数组逐项展开、日期输出 `yyyy-MM-dd HH:mm:ss`（与
 * store.StampToDate 相同格式，但这里不依赖 store，便于纯计算自测）、对象优先取
 * name/title/label/text/value，否则输出 JSON 文本，避免出现 `[object Object]`。
 */

/** 单个字段最多生成多少个属性节点：防止一个超长数组把图画成上万个节点 */
export const MAX_ATTRIBUTE_ITEMS = 200

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 日期属性值的展示文案；非法日期返回空串（调用方会丢弃空标签） */
export function formatAttributeDate(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 对象属性值的展示文案：常见「带名字的对象」取名字，其它对象退化为 JSON */
function objectLabelOf(value: any): string {
  for (const key of ['name', 'title', 'label', 'text', 'value']) {
    const v = value?.[key]
    if (typeof v === 'string' || typeof v === 'number') return String(v)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * 把任意 frontmatter 属性值归一成去重后的标签数组。
 * 空值（null / undefined / 空串）返回空数组，绝不抛异常。
 */
export function attributeItemsOf(value: any): string[] {
  const items: string[] = []
  const seen = new Set<string>()

  const push = (label: string) => {
    const text = label.trim()
    if (!text || seen.has(text) || items.length >= MAX_ATTRIBUTE_ITEMS) return
    seen.add(text)
    items.push(text)
  }

  const walk = (v: any) => {
    if (v === null || v === undefined) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (v instanceof Date) {
      push(formatAttributeDate(v))
      return
    }
    if (typeof v === 'object') {
      push(objectLabelOf(v))
      return
    }
    if (typeof v === 'number') {
      if (Number.isFinite(v)) push(String(v))
      return
    }
    if (typeof v === 'boolean' || typeof v === 'bigint') {
      push(String(v))
      return
    }
    // 字符串（含 YAML 多行文本）：分隔符与换行都拆开，避免节点标签里带换行
    for (const part of String(v).split(/[;；\r\n]+/)) push(part)
  }

  walk(value)
  return items
}
