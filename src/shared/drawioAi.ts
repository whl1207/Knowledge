/**
 * drawio「智能操作」：把自然语言需求变成可应用到当前图表的 mxGraphModel 片段。
 *
 * 本模块只做纯数据加工（不依赖 Vue / store / drawio），便于单独验证：
 *   collectDrawioContext()  解析当前图表 → 已有图形/连线清单 + 新图形的建议排布起点
 *   buildDrawioMessages()   组装提示词（强约束：只输出合法 mxGraphModel；支持增/改/删）
 *   extractGraphFragment()  从模型回复里抽出 XML 片段（容忍 ``` 围栏与前后废话）
 *   mergeDrawioFragment()   片段 → 按 id 区分「新增 / 就地调整 / 删除」，再拼回当前 mxfile
 */

export interface DrawioShapeHint {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
}

export interface DrawioEdgeHint {
  id: string
  source: string
  target: string
  /** 连线上的文字（关系/动作标签），空串表示无文字 */
  label: string
}

export interface DrawioContext {
  /** 已有顶点（供模型参考、作为连线端点，也是可被调整/删除的对象） */
  shapes: DrawioShapeHint[]
  /** 已有连线（带 id，模型要删除/改接某条线时用它） */
  edges: DrawioEdgeHint[]
  /** 新图形的建议排布起点：已有内容的右侧留白，避免与旧内容重叠 */
  origin: { x: number; y: number }
  /** 页数（>1 时只改第 1 页，UI 会提示） */
  pages: number
}

export interface DrawioMergeResult {
  /** 合并后的完整 XML（可直接 load 进编辑器） */
  xml: string
  /** 新增单元数（顶点 + 连线） */
  added: number
  /** 被就地调整的既有单元数 */
  updated: number
  /** 被删除的既有单元数 */
  removed: number
  /** 新增顶点的文本（预览列表用） */
  labels: string[]
  /** 新增连线上的文字（预览列表用） */
  edgeLabels: string[]
  /** 被调整顶点的文本 */
  updatedLabels: string[]
  /** 页码（1 起）与总页数 */
  pageIndex: number
  pages: number
}

export interface DrawioMergeError { error: string }

const DEFAULT_W = 120
const DEFAULT_H = 60
/** 新内容与旧内容之间的留白 */
const GAP = 40
const GRID = 10
/** 顶点最小尺寸（防止 0/负数；提示词里给模型也写了这个下限） */
const MIN_SIZE = 20
/** 单元上的控制标记：由宿主解释，**不会**写进最终 XML */
const CONTROL_ATTRS = ['remove', 'front', 'back']

function stripControlAttrs(el: Element) {
  for (const name of CONTROL_ATTRS) el.removeAttribute(name)
}

// ---------------- XML 小工具 ----------------

function parseXml(text: string): Document | null {
  if (!text || !text.trim()) return null
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml')
    if (doc.getElementsByTagName('parsererror').length) return null
    return doc
  } catch {
    return null
  }
}

/**
 * 修复模型常见的非法 XML：
 * - 属性值里的裸 & （不是已定义实体）
 * - 属性值里的裸 < / >（典型是 value="第一行<br>第二行" —— 模型直接抺了一整个 <br>）
 * - 控制字符
 */
function repairXml(text: string): string {
  const escaped = text.replace(
    /="([^"]*)"/g,
    (_m, inner: string) => '="' + inner.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '"',
  )
  return escaped.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function rootElement(doc: Document): Element | null {
  const model = doc.getElementsByTagName('mxGraphModel')[0]
  if (model) return model.getElementsByTagName('root')[0] || null
  const root = doc.getElementsByTagName('root')[0]
  return root || null
}

/** root 下的直接子 mxCell（不含嵌套 group 的子单元） */
function topCells(root: Element): Element[] {
  const out: Element[] = []
  for (let i = 0; i < root.children.length; i++) {
    const el = root.children[i]
    if (el.tagName === 'mxCell' || el.localName === 'mxCell') out.push(el)
  }
  return out
}

function geometryOf(cell: Element): Element | null {
  for (let i = 0; i < cell.children.length; i++) {
    const el = cell.children[i]
    const name = el.tagName || el.localName
    if (name !== 'mxGeometry' && name !== 'geometry') continue
    // 边上的 <mxGeometry relative="1" as="geometry"> 也算几何
    return el
  }
  return null
}

function numAttr(el: Element | null, name: string, dflt: number): number {
  if (!el) return dflt
  const raw = el.getAttribute(name)
  if (raw === null || raw === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) ? n : dflt
}

function roundToGrid(n: number): number {
  return Math.round(n / GRID) * GRID
}

// ---------------- 上下文 ----------------

/** 解析当前图表：已有图形/连线（带 id）+ 建议的新图形起点（已有内容右侧留白） */
export function collectDrawioContext(xml: string): DrawioContext {
  const empty: DrawioContext = { shapes: [], edges: [], origin: { x: 40, y: 40 }, pages: 1 }
  const doc = parseXml(xml)
  if (!doc) return empty
  const root = rootElement(doc)
  if (!root) return empty

  const shapes: DrawioShapeHint[] = []
  const edges: DrawioEdgeHint[] = []
  for (const cell of topCells(root)) {
    const id = cell.getAttribute('id') || ''
    if (!id || id === '0' || id === '1') continue
    if (cell.getAttribute('vertex') === '1') {
      const g = geometryOf(cell)
      shapes.push({
        id,
        label: String(cell.getAttribute('value') || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        x: numAttr(g, 'x', 0),
        y: numAttr(g, 'y', 0),
        w: numAttr(g, 'width', DEFAULT_W),
        h: numAttr(g, 'height', DEFAULT_H),
      })
    } else if (cell.getAttribute('edge') === '1') {
      const s = cell.getAttribute('source') || ''
      const t = cell.getAttribute('target') || ''
      if (s || t) {
        edges.push({
          id,
          source: s || '?',
          target: t || '?',
          label: String(cell.getAttribute('value') || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        })
      }
    }
  }

  const pages = Math.max(1, doc.getElementsByTagName('diagram').length)
  const origin = shapes.length
    ? {
        x: roundToGrid(Math.max(...shapes.map((s) => s.x + s.w)) + GAP),
        // 与旧内容顶部对齐（负数也允许，drawio 画布无边界）
        y: roundToGrid(Math.min(...shapes.map((s) => s.y))),
      }
    : { x: 40, y: 40 }

  // 只把前 80 个图形喂给模型，避免提示词过长（大图也不至于失控）
  return { shapes: shapes.slice(0, 80), edges: edges.slice(0, 80), origin, pages }
}

// ---------------- 提示词 ----------------

const SYSTEM_ZH = [
  '你是 draw.io 图表编辑助手。用户用自然语言描述对当前图表的修改（新增图形、调整布局/位置/文字/样式、删除连线或图形、建立关系），你要输出可直接应用到该图表的 mxGraphModel XML 片段。',
  '',
  '硬性要求：',
  '1. 只输出一个 XML 片段，禁止解释、禁止 Markdown 代码块标记、禁止注释。',
  '2. 根元素必须是 <mxGraphModel>，其中包含 <root>，且 <root> 里必须有 <mxCell id="0"/> 与 <mxCell id="1" parent="0"/>。',
  '3. 顶点写法：<mxCell id="a1" value="文本" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>',
  '4. 连线写法：<mxCell id="a9" value="提交后" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;fontSize=12;labelBackgroundColor=#ffffff;" edge="1" parent="1" source="a1" target="a2"><mxGeometry relative="1" as="geometry"/></mxCell>。',
  '5. **连线要带文字**（value=）：表达动作 / 条件 / 关系 / 多重度时写短标签（如「提交给」「审核通过」「1..*」），建议 ≤ 8 字；用户说「描述它们之间的行为和关系」时，主要就是把文字写在连线上（必要时再补几个中间顶点）。确实无语义时才省略 value。给连线加 labelBackgroundColor=#ffffff，压在线上也看得清。',
  '6. style 只用 draw.io 标准片段：矩形 rounded=0;whiteSpace=wrap;html=1; / 圆角 rounded=1; / 椭圆 ellipse;whiteSpace=wrap;html=1; / 菱形 rhombus;whiteSpace=wrap;html=1; / 圆柱 shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;',
  '7. 所有坐标必须是数字且为 10 的整数倍；width/height 不小于 40；同一层的图形横向间隔 ≥ 60，上下层纵向间隔 ≥ 60。',
  '8. id 规则：**新增**的单元用自定义唯一 id（a1、a2…，只用字母/数字/下划线）；**要修改或删除已有单元时必须沿用它的原 id**；把已有 id 作为 source/target 时不要重新定义它们。',
  '9. **转义**：value 等属性值里绝对不允许出现裸的 & < > —— 换行写 &lt;br&gt;，& 写 &amp;，< 写 &lt;，> 写 &gt;（例：value="第一行&lt;br&gt;第二行"）。引用已有图形的文本时，先把它里面的标签转义。',
  '10. 颜色默认只在这几对标准色里选：浅蓝 #dae8fc/#6c8ebf、浅绿 #d5e8d4/#82b366、浅橙 #ffe6cc/#d79b00、浅红 #f8cecc/#b85450、浅紫 #e1d5e7/#9673a6、灰 #f5f5f5/#666666；**用户明确指定颜色/色号时按其给的值用**（如“改红色”用 #f8cecc/#b85450，“用 #ff6633”就写 #ff6633），不要自造其它色号。',
  '11. **可以调整已有图形，不只是新增**：移动位置、改尺寸、改文字、改颜色/样式、改连线的 source/target 都能做。做法是用**原 id** 重新输出该单元，带上你要改的属性（建议给完整定义：mxGeometry / style / value）；**没带上来的属性会保持原值**，所以只写要改的部分也可以。',
  '12. **只输出需要改动的单元**，不要把整张图重发一遍；不需要改的已有图形/连线一律不要出现在输出里。',
  '13. **删除**已有图形或连线：输出 <mxCell id="原id" remove="1"/>。',
  '14. 只需补连线或排布局时：只输出需要的新增/变动单元，source/target 用已有 id，不要重复输出未改动的已有顶点。',
  '15. 如果本次要调整布局（移动已有图形），新图形按你给的坐标放置（宿主不会再自动挪位）；请自己保证整体不重叠、对齐 10 的倍数网格。若是纯新增（不改动/删除任何已有单元），新图形会被自动放到已有内容右侧空白区。',
  '16. 用户说「还需要连线」「再加一条线」时，就按第 14 条做（记得写连线文字）；千万不要输出空片段。',
  '17. **常用操作速查**（都靠「用原 id 重新输出该单元」或新增单元实现）：',
  '   · 改尺寸：改 mxGeometry 的 width/height（可以只写这两个，x/y 会保持原值），最小 20；“更大/更小”按 20 的步长调。',
  '   · 改文字排版：style 里加 fontSize=16;（字号）、fontStyle=1;（1 粗体 / 2 斜体 / 4 下划线，可相加）、fontColor=#333333;、align=left;、verticalAlign=top;、labelPosition=left;',
  '   · 换形状：改 style 里的形状片段（rounded=1; / ellipse; / rhombus; / shape=cylinder3; 等），其余片段保留；再加对应该形状的填充/描边色。',
  '   · 旋转与翻转：style 里加 rotation=45;（角度）、flipH=1; / flipV=1;',
  '   · 对齐与等距分布：自己算好新坐标，把涉及的顶点用原 id 逐个重新输出（左对齐=同一个 x；纵向排列= y 等间距）。',
  '   · 复制图形：用**新 id** 输出一份相同定义（x/y 换到空白处），不要改动原图形。',
  '   · 改文字：只重写 value（此时不必带 style/几何）。',
  '18. **连线相关操作**：',
  '   · 改接/换端点：用原连线 id 重新输出，改 source/target；不再需要就 <mxCell id="原id" remove="1"/>。',
  '   · 线型：虚线 dashed=1;dashPattern=8 8; 、双向 startArrow=classic; 、无箭头 endArrow=none; 、曲线 curved=1; 、折线 edgeStyle=orthogonalEdgeStyle; / entityRelationEdgeStyle;',
  '   · 接线位置（接到图形的上/下/左/右）：style 里加 exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0;（0/0.5/1 分别代表左或上 / 中 / 右或下）',
  '   · 连线文字：用原连线 id 重写 value 即可（不必给几何）。',
  '   · 层级：<mxCell id="原id" front="1"/> 置顶、<mxCell id="原id" back="1"/> 置底（宿主按 root 里的顺序调层，这两个标记不会写进单元）；这两个标记也能和别的属性写在同一个 mxCell 里。',
  '19. **XML 细节（最容易造成「插入失败」的地方）**：',
  '   · **连线必须有 <mxGeometry relative="1" as="geometry"/>**（哪怕不需要 x/y 路由），绝不能把连线写成自闭合的 <mxCell …/>，否则 draw.io 会报错或直接丢弃该连线。',
  '   · 顶点必须有 <mxGeometry x="…" y="…" width="…" height="…" as="geometry"/>；缺 width/height 会变成 0 尺寸图形。',
  '   · 禁止 XML 注释（<!-- -->）与 XML 声明（<?xml …?>），片段直接从 <mxGraphModel> 开始。',
  '   · 换行只能用 &lt;br&gt; 或 &#xa;（配合 html=1），**不能在 value 里直接换行**；style 用英文分号分隔、结尾带分号，不要用中文标点。',
  '20. **一次给结果，不要纠结**：不要罗列多个方案、不要写「或者也可以」、不要在说明文字里推导坐标——直接输出一套完整可用的片段。（真正需要先看效果的场景，宿主会让你确认后再写入。）',
  '21. **统一网格**（让结果整齐不重叠）：x = 40 + 180×列号，y = 40 + 120×行号；普通节点 140×60，判定/菱形 140×80；同一行的 y 相同，同一列的 x 相同。',
  '22. **按图类型选连线样式**：流程/架构图 edgeStyle=orthogonalEdgeStyle;（折线）；ER 图 entityRelationEdgeStyle;endArrow=ERone;startArrow=ERmany;endFill=0;；状态图/时序图用 curved=1; 或直线；只要带文字就加 fontSize=12;labelBackgroundColor=#ffffff;。',
  '23. **容器 / 分组 / 图层 / 属性**：把节点放进泳道或容器时，子节点写 parent="容器id" 且 x/y 用**相对容器**的坐标（swimlane 还要再减去约 30px 标题高度）；**跨容器的连线 parent 保持 "1"**，不要设成容器 id。新图层：<mxCell id="L9" value="图层名" parent="0"/>；给单元加标签/业务属性：<object id="原id" label="文本" tags="重要 待评审" owner="张三"><mxCell …/></object>（属性值同样要转义）。',
  '24. **不要写死背景色**：不要给 <mxGraphModel> 加 background=#ffffff（本应用支持暗色主题，写死白底会看不清）；需要区分颜色时只改单元自身的 fillColor/strokeColor。',
].join('\n')

const SYSTEM_EN = [
  'You are a draw.io diagram editing assistant. The user describes changes to the current diagram (add shapes, adjust layout/position/text/style, delete edges or shapes, relate shapes). Output an mxGraphModel XML fragment that can be applied directly.',
  '',
  'Hard requirements:',
  '1. Output ONLY one XML fragment. No prose, no markdown code fences, no comments.',
  '2. Root element must be <mxGraphModel> containing <root>, and <root> must contain <mxCell id="0"/> and <mxCell id="1" parent="0"/>.',
  '3. Vertex: <mxCell id="a1" value="text" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>',
  '4. Edge: <mxCell id="a9" value="after submit" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;fontSize=12;labelBackgroundColor=#ffffff;" edge="1" parent="1" source="a1" target="a2"><mxGeometry relative="1" as="geometry"/></mxCell>.',
  '5. **Edges must carry text** (value=): label actions / conditions / relations / multiplicities with a short label ("submits to", "approved", "1..*"), <= 8 chars. When the user asks to "describe the behaviour/relationship between them", this mainly means putting text on the edges (plus a few intermediate vertices if needed). Omit value only when there is really no meaning. Add labelBackgroundColor=#ffffff so the label stays readable over the line.',
  '6. Use only standard draw.io style snippets (rounded=1;whiteSpace=wrap;html=1; / ellipse; / rhombus; / shape=cylinder3;).',
  '7. All coordinates must be numbers and multiples of 10; width/height >= 40; keep >= 60 px horizontal and vertical spacing.',
  '8. Ids: NEW cells get custom unique ids (a1, a2, ... alphanumeric); to MODIFY or DELETE an existing cell you MUST reuse its original id; using an existing id as source/target must not redefine it.',
  '9. **Escaping**: attribute values (value=) must never contain raw & < > — write a line break as &lt;br&gt;, & as &amp;, < as &lt;, > as &gt;.',
  '10. By default use only these colour pairs: #dae8fc/#6c8ebf, #d5e8d4/#82b366, #ffe6cc/#d79b00, #f8cecc/#b85450, #e1d5e7/#9673a6, #f5f5f5/#666666; **if the user explicitly names a colour/code, use that value** ("make it red" -> #f8cecc/#b85450, "use #ff6633" -> #ff6633). Do not invent any other colours.',
  '11. **You may adjust existing shapes, not just add**: move, resize, retitle, recolour/restyle, re-wire edges (source/target). Re-emit the cell with its ORIGINAL id and include the attributes you want to change (a complete definition - mxGeometry / style / value - is best); **attributes you leave out keep their current value**, so a partial re-emit is fine too.',
  '12. Output ONLY the cells that change. Do not resend the whole diagram; untouched existing cells must not appear.',
  '13. To DELETE an existing shape or edge: emit <mxCell id="originalId" remove="1"/>.',
  '14. To add connections or rearrange only: emit just the new/changed cells (source/target may be existing ids) and remember the edge labels; do not repeat untouched existing vertices.',
  '15. If the request changes the layout (moves existing shapes), new shapes are placed exactly where you put them (no auto-offset); keep the result non-overlapping and grid-aligned. For pure additions the host will offset new shapes into the free area on the right.',
  '16. When the user says "also add connections", follow rule 14 (and label the edges); never output an empty fragment.',
  '17. **Operation cheat-sheet** (all via "re-emit the cell with its original id" or by adding new cells):',
  '   - Resize: change width/height in mxGeometry (you may send only those two; x/y keep their values). Minimum 20; use steps of 20 for "bigger/smaller".',
  '   - Text styling: add fontSize=16;, fontStyle=1; (1 bold / 2 italic / 4 underline, addable), fontColor=#333333;, align=left;, verticalAlign=top;, labelPosition=left;',
  '   - Change shape: edit the shape part of the style (rounded=1; / ellipse; / rhombus; / shape=cylinder3;) and keep the rest; add matching fill/stroke colours.',
  '   - Rotate / flip: rotation=45; , flipH=1; / flipV=1; in the style.',
  '   - Align / distribute: compute the new coordinates yourself and re-emit each affected vertex with its original id (left align = same x; vertical stack = evenly spaced y).',
  '   - Duplicate: emit an identical definition with a NEW id (move x/y into free space); never modify the original.',
  '   - Change text: just rewrite value (no style/geometry needed).',
  '18. **Edge operations**:',
  '   - Re-wire / change endpoints: re-emit the edge with its original id and new source/target; to drop it use <mxCell id="originalId" remove="1"/>.',
  '   - Line style: dashed=1;dashPattern=8 8; , bidirectional startArrow=classic; , no arrow endArrow=none; , curved curved=1; , orthogonal edgeStyle=orthogonalEdgeStyle; / entityRelationEdgeStyle;',
  '   - Connection sides (top/bottom/left/right): add exitX=0.5;exitY=0;exitDx=0;exitDy=0;entryX=0.5;entryY=1;entryDx=0;entryDy=0; (0 / 0.5 / 1 = left-or-top / middle / right-or-bottom)',
  '   - Edge label: re-emit the edge with its original id and an updated value (geometry not needed).',
  '   - Z-order: <mxCell id="originalId" front="1"/> to bring to front, back="1" to send to back (the host reorders inside <root>; these markers are not written into the cell). They may be combined with other attributes in the same mxCell.',
  '19. **XML details (the top cause of “insert failed”)**:',
  '   - **Every edge MUST contain <mxGeometry relative="1" as="geometry"/>** (even without x/y routing). Never write an edge as a self-closing <mxCell .../>, or draw.io will error out or drop the edge.',
  '   - Every vertex MUST contain <mxGeometry x="..." y="..." width="..." height="..." as="geometry"/>; a missing width/height yields a zero-size shape.',
  '   - No XML comments (<!-- -->) and no XML declaration (<?xml ...?>); start the fragment directly with <mxGraphModel>.',
  '   - Line breaks inside value= must be &lt;br&gt; or &#xa; (with html=1); **never a real newline**. Separate style entries with plain ASCII semicolons and end with one; no CJK punctuation in style.',
  '20. **Decide once, no dithering**: do not list alternatives, do not write “or alternatively”, do not derive coordinates in prose — just output one complete usable fragment. (When a preview is truly needed, the host lets the user confirm before writing.)',
  '21. **One consistent grid** (keeps the result tidy and non-overlapping): x = 40 + 180*col, y = 40 + 120*row; regular node 140x60, decision/diamond 140x80; same row = same y, same column = same x.',
  '22. **Pick the edge style by diagram type**: flow/architecture -> edgeStyle=orthogonalEdgeStyle; ; ER -> entityRelationEdgeStyle;endArrow=ERone;startArrow=ERmany;endFill=0; ; state/sequence -> curved=1; or a straight line; whenever labelled add fontSize=12;labelBackgroundColor=#ffffff;.',
  '23. **Containers / groups / layers / attributes**: to place nodes inside a swimlane or container, give the child parent="containerId" with x/y **relative to the container** (subtract ~30 px title height for a swimlane); **edges that span containers keep parent="1"**, never the container id. New layer: <mxCell id="L9" value="Layer name" parent="0"/>; tags/business attributes on a cell: <object id="originalId" label="text" tags="core v1" owner="Alice"><mxCell .../></object> (escape those values too).',
  '24. **Never hard-code a background colour**: do not add background=#ffffff to <mxGraphModel> (this app supports dark themes — a hard-coded white background becomes unreadable); colour only the individual cells via fillColor/strokeColor.',
].join('\n')

/** 组装提示词：系统约束 + 当前图表上下文 + 用户需求 */
export function buildDrawioMessages(requirement: string, ctx: DrawioContext, zh: boolean, mode: 'auto' | 'add' = 'auto') {
  const lines: string[] = []
  if (zh) {
    lines.push('当前图表已有内容（可作为连线端点；要修改/删除时请直接使用这些 id）：')
    if (ctx.shapes.length) {
      for (const s of ctx.shapes) {
        lines.push(`- 顶点 id=${s.id} 文本="${s.label}" 位置=(${s.x},${s.y}) 尺寸=${s.w}x${s.h}`)
      }
    } else {
      lines.push('- （无顶点）')
    }
    for (const e of ctx.edges) {
      lines.push(`- 连线 id=${e.id}: ${e.source} -> ${e.target}${e.label ? ` 文本="${e.label}"` : ''}`)
    }
    if (!ctx.edges.length) lines.push('- （无连线）')
    lines.push(`建议的新图形排布起点：x=${ctx.origin.x}, y=${ctx.origin.y}（纯新增时会自动挪到这里；若你在调整布局，请自己给坐标）`)
    if (ctx.pages > 1) lines.push(`注意：这是多页图表（共 ${ctx.pages} 页），本次只会改第 1 页。`)
    if (mode === 'add') lines.push('【本次模式：仅新增】不要修改或删除任何已有图形/连线。')
    lines.push('', '用户需求：', requirement.trim())
  } else {
    lines.push('Existing diagram content (usable as edge endpoints; reuse these ids to modify/delete):')
    if (ctx.shapes.length) {
      for (const s of ctx.shapes) {
        lines.push(`- vertex id=${s.id} text="${s.label}" pos=(${s.x},${s.y}) size=${s.w}x${s.h}`)
      }
    } else {
      lines.push('- (no vertices)')
    }
    for (const e of ctx.edges) {
      lines.push(`- edge id=${e.id}: ${e.source} -> ${e.target}${e.label ? ` text="${e.label}"` : ''}`)
    }
    if (!ctx.edges.length) lines.push('- (no edges)')
    lines.push(`Suggested origin for new shapes: x=${ctx.origin.x}, y=${ctx.origin.y} (pure additions are auto-offset there; if you rearrange the layout, give your own coordinates)`)
    if (ctx.pages > 1) lines.push(`Note: multi-page diagram (${ctx.pages} pages); only page 1 will be updated.`)
    if (mode === 'add') lines.push('[Mode: ADD ONLY] Do not modify or delete any existing shape or edge.')
    lines.push('', 'User requirement:', requirement.trim())
  }
  return [
    { role: 'system', content: zh ? SYSTEM_ZH : SYSTEM_EN },
    { role: 'user', content: lines.join('\n') },
  ]
}

// ---------------- 解析模型输出 ----------------

/** 从模型回复中抽出 mxGraphModel 片段（容忍 ``` 围栏、前后说明、mxfile 包裹） */
export function extractGraphFragment(text: string): string | null {
  let s = String(text || '').trim()
  if (!s) return null
  const fence = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(s)
  if (fence && fence[1]) s = fence[1].trim()

  const model = /<mxGraphModel\b[\s\S]*?<\/mxGraphModel>/i.exec(s)
  if (model) return model[0]
  // mxfile 包裹但只给了 <root>
  const innerRoot = /<root\b[\s\S]*?<\/root>/i.exec(s)
  if (innerRoot) return `<mxGraphModel>${innerRoot[0]}</mxGraphModel>`
  // 只给了一串裸 mxCell
  const cells = s.match(/<mxCell\b[\s\S]*?(?:\/>|<\/mxCell>)/gi)
  if (cells && cells.length) {
    const body = cells.filter((c) => !/id="(?:0|1)"/.test(c)).join('')
    if (body) return `<mxGraphModel dx="0" dy="0" grid="1" gridSize="10"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${body}</root></mxGraphModel>`
  }
  return null
}

// ---------------- 合并进当前图表 ----------------

/**
 * 把模型片段应用到当前图表 XML（按 id 是否已存在自动区分三类操作）：
 * - 新 id → **新增**：重编唯一 id（避免撞车）、解析 parent/source/target、补全几何、
 *   整体平移到「已有内容右侧空白区」
 * - 既有 id → **调整**：用片段里的定义就地覆盖该单元（属性 + 几何；只给 style 不给几何时保留原几何/坐标）
 * - `<mxCell id="X" remove="1"/>` → **删除**该单元
 * 引用既有图形 id 的连线保留（可连到老图形上）；端点解析不出来的连线整条丢弃。
 */
export function mergeDrawioFragment(
  baseXml: string,
  fragment: string,
  opts: { allowEdit?: boolean } = {},
): DrawioMergeResult | DrawioMergeError {
  const allowEdit = opts.allowEdit !== false
  const baseDoc = parseXml(baseXml)
  if (!baseDoc) return { error: '当前图表内容无法解析' }
  const baseRoot = rootElement(baseDoc)
  if (!baseRoot) return { error: '无法定位图表内容（压缩格式或非 mxGraphModel），请先在编辑器中做一次改动后再试' }

  const fragDoc = parseXml(fragment) || parseXml(repairXml(fragment))
  if (!fragDoc) return { error: '模型输出的不是合法 XML' }
  const fragRoot = rootElement(fragDoc)
  if (!fragRoot) return { error: '模型输出缺少 <mxGraphModel><root>' }

  const existing = new Map<string, Element>()
  for (const c of topCells(baseRoot)) {
    const id = c.getAttribute('id')
    if (id) existing.set(id, c)
  }

  const rawCells = topCells(fragRoot).filter((c) => {
    const id = c.getAttribute('id') || ''
    return !!id && id !== '0' && id !== '1'
  })
  if (!rawCells.length) return { error: '模型没有生成任何图形' }

  // 1) 只有「新 id」才重编；既有 id（调整）与 remove 标记必须保持原 id
  const prefix = 'ai' + Date.now().toString(36).slice(-5)
  const idMap = new Map<string, string>()
  rawCells.forEach((c, i) => {
    const old = c.getAttribute('id') || ''
    if (!old || existing.has(old) || c.getAttribute('remove') === '1') return
    idMap.set(old, `${prefix}_${i + 1}`)
  })

  // 2) 逐单元处理：删除 / 就地调整 / 新增
  const imported: Element[] = []
  const updatedIds: string[] = []
  const removedIds: string[] = []
  const dropped: string[] = []
  const resolveRef = (ref: string | null): string | null => {
    if (!ref) return null
    if (idMap.has(ref)) return idMap.get(ref)!
    return existing.has(ref) ? ref : null
  }
  const normalizeNewVertexGeom = (geom: Element) => {
    geom.setAttribute('x', String(roundToGrid(numAttr(geom, 'x', 0))))
    geom.setAttribute('y', String(roundToGrid(numAttr(geom, 'y', 0))))
    geom.setAttribute('width', String(Math.max(MIN_SIZE, roundToGrid(numAttr(geom, 'width', DEFAULT_W)))))
    geom.setAttribute('height', String(Math.max(MIN_SIZE, roundToGrid(numAttr(geom, 'height', DEFAULT_H)))))
  }

  /** 置顶/置底：靠 <root> 里的顺序表达层级（后出现的在上层） */
  const moveLayer = (el: Element, toFront: boolean) => {
    if (toFront) {
      baseRoot.appendChild(el)
      return
    }
    // 置底：插到第一个非根单元之前
    let anchor: Element | null = null
    for (let i = 0; i < baseRoot.children.length; i++) {
      const c = baseRoot.children[i]
      if (c === el) continue
      const cid = c.getAttribute('id')
      if (!cid || cid === '0' || cid === '1') continue
      anchor = c
      break
    }
    if (anchor) baseRoot.insertBefore(el, anchor)
    else baseRoot.appendChild(el)
  }

  for (const src of rawCells) {
    const oldId = src.getAttribute('id') || ''

    // 2a) 删除：<mxCell id="X" remove="1"/>
    if (src.getAttribute('remove') === '1') {
      if (!allowEdit) continue
      const target = existing.get(oldId)
      if (target && target.parentNode === baseRoot) {
        baseRoot.removeChild(target)
        removedIds.push(oldId)
      }
      continue
    }

    // 2b) 调整既有单元：属性**只覆盖片段里给出的**（未给出的沿用旧值 —— 否则「只移动位置」
    //     的片段会把文字/样式清掉），几何只在新片段给了才替换，且片段只给部分几何时缺失的沿用旧值
    if (existing.has(oldId)) {
      if (!allowEdit) continue
      const el = existing.get(oldId)!
      const toFront = src.getAttribute('front') === '1'
      const toBack = src.getAttribute('back') === '1'
      const oldGeom = geometryOf(el)
      const newGeom = geometryOf(src)
      const oldPos = {
        x: numAttr(oldGeom, 'x', 0),
        y: numAttr(oldGeom, 'y', 0),
        w: numAttr(oldGeom, 'width', DEFAULT_W),
        h: numAttr(oldGeom, 'height', DEFAULT_H),
      }
      for (const a of Array.from(src.attributes)) {
        if (a.name === 'id') continue
        if (CONTROL_ATTRS.includes(a.name)) continue // 控制标记不写进单元
        if (a.name === 'source' || a.name === 'target' || a.name === 'parent') {
          // 引用指向本次新增单元时需改写；既有 id 原样；解析不出来就照抄（可能本身就是空引用）
          const resolved = resolveRef(a.value)
          el.setAttribute(a.name, resolved || a.value)
          continue
        }
        el.setAttribute(a.name, a.value)
      }
      // 子节点：片段带了 mxGeometry 就整体替换，否则保留旧几何（含连线折点）
      if (newGeom) {
        while (el.firstChild) el.removeChild(el.firstChild)
        for (const ch of Array.from(src.childNodes)) el.appendChild(baseDoc.importNode(ch, true))
      }
      if (el.getAttribute('vertex') === '1') {
        let geom = geometryOf(el)
        if (!geom) {
          geom = baseDoc.createElement('mxGeometry')
          geom.setAttribute('as', 'geometry')
          el.appendChild(geom)
        }
        const use = (name: string, fallback: number) =>
          String(roundToGrid(newGeom && newGeom.hasAttribute(name) ? numAttr(newGeom, name, fallback) : fallback))
        geom.setAttribute('x', use('x', oldPos.x))
        geom.setAttribute('y', use('y', oldPos.y))
        geom.setAttribute('width', String(Math.max(MIN_SIZE, Number(use('width', oldPos.w)))))
        geom.setAttribute('height', String(Math.max(MIN_SIZE, Number(use('height', oldPos.h)))))
      }
      if (toFront || toBack) moveLayer(el, toFront)
      updatedIds.push(oldId)
      continue
    }

    // 2c) 新增
    const cell = baseDoc.importNode(src, true) as Element
    stripControlAttrs(cell)
    const newId = idMap.get(oldId) || ''
    if (!newId) continue
    cell.setAttribute('id', newId)

    // parent：内部引用改写，根 → '1'，指向既有图形 → '1'（不做嵌套）
    const oldParent = cell.getAttribute('parent') || '1'
    cell.setAttribute('parent', idMap.get(oldParent) || '1')

    if (cell.getAttribute('edge') === '1') {
      // 端点：内部引用 → 改写；既有 id → 保留（连到老图形）；解析不出来 → 整条连线丢弃
      const source = resolveRef(cell.getAttribute('source'))
      const target = resolveRef(cell.getAttribute('target'))
      if (!source || !target) {
        dropped.push(oldId)
        continue
      }
      cell.setAttribute('source', source)
      cell.setAttribute('target', target)
      const hasGeom = geometryOf(cell)
      if (!hasGeom) {
        const g = baseDoc.createElement('mxGeometry')
        g.setAttribute('relative', '1')
        g.setAttribute('as', 'geometry')
        cell.appendChild(g)
      }
    } else {
      // 顶点：几何必须完整
      let g = geometryOf(cell)
      if (!g) {
        g = baseDoc.createElement('mxGeometry')
        g.setAttribute('as', 'geometry')
        cell.appendChild(g)
      }
      normalizeNewVertexGeom(g)
    }
    imported.push(cell)
  }
  if (!imported.length && !updatedIds.length && !removedIds.length) {
    return { error: '模型输出的图形不完整，无法应用' }
  }

  // 3) 只有「纯新增」才自动挪到空白区；含调整/删除时布局由模型自己负责
  const autoPlace = !updatedIds.length && !removedIds.length
  const tops = autoPlace
    ? imported.filter((c) => c.getAttribute('vertex') === '1' && (c.getAttribute('parent') || '1') === '1')
    : []
  if (tops.length) {
    let minX = Infinity
    let minY = Infinity
    for (const c of tops) {
      const g = geometryOf(c)
      minX = Math.min(minX, numAttr(g, 'x', 0))
      minY = Math.min(minY, numAttr(g, 'y', 0))
    }
    const ctx = collectDrawioContext(baseXml)
    const dx = ctx.origin.x - minX
    const dy = ctx.origin.y - minY
    if (dx || dy) {
      for (const c of tops) {
        const g = geometryOf(c)
        if (!g) continue
        g.setAttribute('x', String(numAttr(g, 'x', 0) + dx))
        g.setAttribute('y', String(numAttr(g, 'y', 0) + dy))
        // 绝对折点同步平移（相对偏移 as="offset" 不动）
        for (const pt of Array.from(g.getElementsByTagName('mxPoint'))) {
          if (pt.getAttribute('as') === 'offset') continue
          pt.setAttribute('x', String(numAttr(pt, 'x', 0) + dx))
          pt.setAttribute('y', String(numAttr(pt, 'y', 0) + dy))
        }
      }
      // 连线上挂的绝对折点
      for (const c of imported.filter((c) => c.getAttribute('edge') === '1')) {
        const g = geometryOf(c)
        if (!g) continue
        for (const pt of Array.from(g.getElementsByTagName('mxPoint'))) {
          if (pt.getAttribute('as') === 'offset') continue
          pt.setAttribute('x', String(numAttr(pt, 'x', 0) + dx))
          pt.setAttribute('y', String(numAttr(pt, 'y', 0) + dy))
        }
      }
    }
  }

  // 4) 拼进目标的 <root>（多页时取第 1 页）
  for (const cell of imported) baseRoot.appendChild(cell)
  const xml = new XMLSerializer().serializeToString(baseDoc)

  // 5) 自检：结果必须仍能解析，且单元数 = 原有 - 删除 + 新增
  const checkDoc = parseXml(xml)
  if (!checkDoc) return { error: '合并后的内容校验失败' }
  const checkRoot = rootElement(checkDoc)
  const expectCells = existing.size - removedIds.length + imported.length
  if (!checkRoot || topCells(checkRoot).length < expectCells) {
    return { error: '合并后的内容不完整，已取消应用' }
  }

  const textOf = (c: Element) =>
    String(c.getAttribute('value') || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  const labels = imported
    .filter((c) => c.getAttribute('vertex') === '1')
    .map(textOf)
    .filter(Boolean)
  const edgeLabels = imported
    .filter((c) => c.getAttribute('edge') === '1')
    .map(textOf)
    .filter(Boolean)
  const updatedLabels = updatedIds
    .map((id) => {
      const el = existing.get(id)
      return el ? textOf(el) : ''
    })
    .filter(Boolean)

  return {
    xml,
    added: imported.length,
    updated: updatedIds.length,
    removed: removedIds.length,
    labels: labels.slice(0, 20),
    edgeLabels: edgeLabels.slice(0, 20),
    updatedLabels: updatedLabels.slice(0, 20),
    pageIndex: 1,
    pages: Math.max(1, baseDoc.getElementsByTagName('diagram').length),
  }
}
