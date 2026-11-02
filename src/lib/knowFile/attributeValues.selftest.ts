/**
 * attributeValues.selftest.ts — 图谱属性值归一化的自测
 *
 * 重点回归：旧实现直接对属性值调用 `.split()`，数字 / 布尔 / 数组 / 对象属性一展开就抛
 * `TypeError: ...split is not a function`（用户上报的图谱视图崩溃）。这里逐个类型验证
 * 不抛异常且标签符合展示约定。
 */

import { attributeItemsOf, formatAttributeDate, MAX_ATTRIBUTE_ITEMS } from '@/lib/knowFile/attributeValues'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b)

export function runAttributeValuesSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })
  const labels = (v: any) => attributeItemsOf(v)

  // 字符串：沿用 `;` / `；` 分隔多个值的既有约定，去空白、丢空项
  check('字符串按中英文分号拆分', eq(labels('AI; 知识库；笔记'), ['AI', '知识库', '笔记']), JSON.stringify(labels('AI; 知识库；笔记')))
  check('空串 → 空数组', eq(labels(''), []))
  check('纯分隔符 → 空数组', eq(labels(' ;; ；'), []))
  check('多行文本按行拆分（标签里不带换行）', eq(labels('第一行\n第二行'), ['第一行', '第二行']), JSON.stringify(labels('第一行\n第二行')))

  // 旧实现在下面这些类型上必崩
  check('数字 → 标签（不再抛 TypeError）', eq(labels(2024), ['2024']))
  check('布尔 → 标签', eq(labels(true), ['true']), JSON.stringify(labels(true)))
  check('数组 → 逐项展开', eq(labels(['AI', 3, ['知识库']]), ['AI', '3', '知识库']))
  check('日期 → 格式化文案', eq(labels(new Date(2024, 0, 2, 3, 4, 5)), ['2024-01-02 03:04:05']), JSON.stringify(labels(new Date(2024, 0, 2, 3, 4, 5))))
  check('空值 → 空数组', eq(labels(null), []) && eq(labels(undefined), []))

  // 对象：常见「带名字的对象」取名字，其余退化为 JSON，不能出现 [object Object]
  check('对象优先取 name', eq(labels({ name: '某某' }), ['某某']))
  check('对象没有名字时输出 JSON', eq(labels({ url: 'https://example.com' }), ['{"url":"https://example.com"}']), JSON.stringify(labels({ url: 'https://example.com' })))
  check('对象永不输出 [object Object]', !labels({ foo: 1 }).some((s: string) => s.includes('[object Object]')))

  // 去重 / 上限：同一值不重复建节点；超长数组不会把图画爆
  check('重复值去重', eq(labels(['AI', 'AI', 'AI']), ['AI']))
  check('去重时保留首次出现顺序', eq(labels(['b', 'a', 'b']), ['b', 'a']))
  const many = Array.from({ length: MAX_ATTRIBUTE_ITEMS + 50 }, (_, i) => 'v' + i)
  check('超长数组按上限截断', labels(many).length === MAX_ATTRIBUTE_ITEMS, String(labels(many).length))

  // 格式化函数本身对非法日期的兜底
  check('非法日期 → 空串', formatAttributeDate(new Date('nope')) === '')

  return cases
}
