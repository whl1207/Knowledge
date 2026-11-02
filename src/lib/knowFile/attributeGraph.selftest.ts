/**
 * attributeGraph.selftest.ts — 图谱属性展开（派生节点/边重建）的自测
 *
 * 这些用例覆盖用户上报崩溃背后的整条链路：
 *   - 非字符串属性值（数字 / 布尔 / 数组 / 日期 / 对象）不能抛错；
 *   - 反复开关、正反方向切换只留一套边，不叠加双向边；
 *   - 两个字段共用同一个属性值时，收起其中一个不能把另一个的节点/边带走；
 *   - 属性节点 id 不能与已有节点撞车（下一条边指向错误节点 / forceLink 找不到节点）；
 *   - 收起后基础节点、层级边必须原样保留。
 */

import {
  applyAttributeGraph,
  buildAttributeExpansion,
  linkEndIds,
  nextNodeId,
  stripAttributeGraph,
} from '@/lib/knowFile/attributeGraph'

export interface SelfTestCase {
  name: string
  ok: boolean
  detail?: string
}

const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b)
const labelsOf = (nodes: any[], type?: string) =>
  nodes.filter((n) => (type ? n.type === type : n.type !== 'file' && n.type !== 'folder')).map((n) => n.label)
const idsOf = (nodes: any[]) => nodes.map((n) => n.id)
const hasDuplicate = (arr: any[]) => new Set(arr).size !== arr.length

/** 基础图：id 故意留空档（模拟真实数据里节点被删过 / id 不连续） */
function baseGraph() {
  return {
    nodes: [
      { id: 0, label: '甲.md', type: 'file', path: 'C:/vault/甲.md', attributes: { 标签: 'AI', 分类: 'AI', 年份: 2024 } },
      { id: 5, label: '乙.md', type: 'file', path: 'C:/vault/乙.md', attributes: { 标签: 'AI; 知识库', 年份: 2025 } },
    ],
    links: [{ source: 0, target: 5 }], // 层级边（无 type）
  }
}

export function runAttributeGraphSelfTest(): SelfTestCase[] {
  const cases: SelfTestCase[] = []
  const check = (name: string, ok: boolean, detail?: string) =>
    cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 1. 非字符串值不再抛错，且都能变成节点
  {
    const { nodes, links } = baseGraph()
    let error = ''
    try {
      applyAttributeGraph(nodes, links, [{ name: '年份', state: 1 }])
    } catch (e: any) {
      error = String(e && e.message)
    }
    check('数字属性展开不抛错', error === '', error)
    check('数字属性生成节点', eq(labelsOf(nodes).sort(), ['2024', '2025']), JSON.stringify(labelsOf(nodes)))
    check('每个文件各一条属性边', links.filter((l: any) => l.type === '年份').length === 2)
  }

  // 2. 值方向：state = -1 时边从属性值指向文件
  {
    const { nodes, links } = baseGraph()
    applyAttributeGraph(nodes, links, [{ name: '标签', state: -1 }])
    const valueNode = nodes.find((n: any) => n.label === 'AI')
    const edge = links.find((l: any) => l.type === '标签')
    check('反向展开：边起点是属性值节点', !!valueNode && !!edge && edge.source === valueNode.id && edge.target === 0,
      JSON.stringify({ edge, valueId: valueNode?.id }))
  }

  // 3. 反复展开 / 切换方向：每次只有一套边，不叠加双向边
  {
    const { nodes, links } = baseGraph()
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }])
    const once = links.filter((l: any) => l.type === '标签').length
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }])
    const twice = links.filter((l: any) => l.type === '标签').length
    applyAttributeGraph(nodes, links, [{ name: '标签', state: -1 }])
    const reversed = links.filter((l: any) => l.type === '标签')
    const backward = reversed.filter((l: any) => {
      const s = nodes.find((n: any) => n.id === l.source)
      return s && s.type === '标签'
    }).length
    check('重复展开不叠加边', once === twice, `${once} vs ${twice}`)
    check('切换方向后只剩反向边', reversed.length === once && backward === once, JSON.stringify({ once, total: reversed.length, backward }))
  }

  // 4. 两个字段共用同一个值：收起其中一个，另一个的节点/边必须还在
  {
    const { nodes, links } = baseGraph()
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }, { name: '分类', state: 1 }])
    const shared = nodes.filter((n: any) => n.label === 'AI')
    check('共用值只建一个属性节点', shared.length === 1, JSON.stringify(labelsOf(nodes)))
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 0 }, { name: '分类', state: 1 }])
    const 分类Edge = links.filter((l: any) => l.type === '分类')
    check('收起一个字段不影响另一字段的边', 分类Edge.length === 1 && nodes.some((n: any) => n.label === 'AI'),
      JSON.stringify({ edges: 分类Edge.length, labels: labelsOf(nodes) }))
    check('被收起的字段不残留边', !links.some((l: any) => l.type === '标签'))
  }

  // 5. 属性值等于文件自身名称：不画自环
  {
    const nodes = [{ id: 0, label: 'AI', type: 'file', path: 'C:/vault/AI', attributes: { 标签: 'AI' } }]
    const links: any[] = []
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }])
    check('属性值等于自身文件名时不画自环', links.length === 0 && nodes.length === 1, JSON.stringify(links))
  }

  // 6. 属性值撞上另一个文件的名称：连到那个真实节点，不重复建点
  {
    const nodes = [
      { id: 0, label: 'AI', type: 'file', path: 'C:/vault/AI', attributes: {} },
      { id: 1, label: '笔记.md', type: 'file', path: 'C:/vault/笔记.md', attributes: { 标签: 'AI' } },
    ]
    const links: any[] = []
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }])
    check('属性值命中已有文件节点时复用', nodes.length === 2 && links.length === 1 && links[0].target === 0,
      JSON.stringify({ nodes: nodes.length, links }))
  }

  // 7. id 分配：不能用 length（稀疏 id 会撞车）
  {
    const { nodes, links } = baseGraph()
    check('nextNodeId 取最大 id + 1', nextNodeId(nodes) === 6, String(nextNodeId(nodes)))
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }, { name: '年份', state: 1 }])
    check('属性节点 id 全局唯一', !hasDuplicate(idsOf(nodes)), JSON.stringify(idsOf(nodes)))
    // 收起后重建，仍不能撞到留下的基础节点
    applyAttributeGraph(nodes, links, [{ name: '分类', state: 1 }])
    check('收起再展开后 id 仍唯一', !hasDuplicate(idsOf(nodes)), JSON.stringify(idsOf(nodes)))
  }

  // 8. 布尔 / 数组 / 日期 / 对象值都能展开（回归：旧实现在这些类型上 .split 崩溃）
  {
    const nodes = [
      {
        id: 0, label: '甲.md', type: 'file', path: 'C:/vault/甲.md',
        attributes: { 完成: false, 标签: ['AI', '知识库'], 时间: new Date(2024, 0, 2, 3, 4, 5), 来源: { name: '某处' } },
      },
    ]
    const links: any[] = []
    let error = ''
    try {
      applyAttributeGraph(nodes, links, [
        { name: '完成', state: 1 }, { name: '标签', state: 1 }, { name: '时间', state: 1 }, { name: '来源', state: 1 },
      ])
    } catch (e: any) {
      error = String(e && e.message)
    }
    check('布尔/数组/日期/对象属性展开不抛错', error === '', error)
    const labels = labelsOf(nodes)
    check('各类值都变成节点',
      labels.includes('false') && labels.includes('AI') && labels.includes('知识库')
      && labels.includes('2024-01-02 03:04:05') && labels.includes('某处'),
      JSON.stringify(labels))
  }

  // 9. 重复值只生成一条边；层级边/基础节点在收起后原样保留
  {
    const nodes = [{ id: 0, label: '甲.md', type: 'file', path: 'C:/vault/甲.md', attributes: { 标签: 'AI;AI；AI' } }]
    const links: any[] = [{ source: 0, target: 9 }]
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }])
    check('同一文件里的重复值只连一条边', links.filter((l: any) => l.type === '标签').length === 1, JSON.stringify(links))
    applyAttributeGraph(nodes, links, [])
    check('全部收起后基础节点与层级边保留', nodes.length === 1 && links.length === 1 && !links[0].type, JSON.stringify({ nodes: nodes.length, links }))
  }

  // 10. d3 把端点改成节点对象后，linkEndIds 仍能取到 id（旧实现用数字比较会失效）
  {
    check('linkEndIds 兼容节点对象端点', eq(linkEndIds({ source: { id: 3 }, target: { id: 4 } }), [3, 4]))
    const nodes = [{ id: 0, label: '甲.md', type: 'file', path: 'C:/vault/甲.md', attributes: { 标签: 'AI' } }]
    const links: any[] = []
    buildAttributeExpansion(nodes, links, '标签', 1)
    // 模拟 d3.forceLink：把端点换成节点对象后再重建
    links[0].source = nodes.find((n: any) => n.id === links[0].source)
    links[0].target = nodes.find((n: any) => n.id === links[0].target)
    applyAttributeGraph(nodes, links, [{ name: '标签', state: 1 }])
    check('端点被 d3 改写后重建仍正确', links.filter((l: any) => l.type === '标签').length === 1, JSON.stringify(links))
  }

  // 11. strip 只清属性节点与属性边
  {
    const nodes = [
      { id: 0, label: 'A', type: 'folder' },
      { id: 1, label: 'B', type: 'file' },
      { id: 2, label: 'AI', type: '标签' },
    ]
    const links: any[] = [{ source: 0, target: 1 }, { source: 1, target: 2, type: '标签' }]
    stripAttributeGraph(nodes, links)
    check('strip 保留文件/文件夹与层级边', eq(nodes.map((n) => n.id), [0, 1]) && links.length === 1 && !links[0].type)
  }

  return cases
}
