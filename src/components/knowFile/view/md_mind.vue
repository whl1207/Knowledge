<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { usestore } from '@/store'
import { Transformer } from 'markmap-lib'
import * as markmap from 'markmap-view'
import { readImageAsDataUrl } from '@/lib/export/docx'
import { prepareTalkPage } from '@/lib/mindmap-talk'
import MermaidViewer from '@/components/MermaidViewer.vue'

const store = usestore()

let id = ref("mindmap" + Date.now())
let map = null as any
const containerRef = ref<HTMLElement | null>(null)

// 思维导图内 mermaid：源码登记 + 查看组件引用（点击“🧩 Mermaid 图 [k]”节点打开）
let mmMermaidSources: string[] = []
const mermaidViewerRef = ref<InstanceType<typeof MermaidViewer> | null>(null)

// 最近一次整图渲染/刷新所在文件的路径 —— 区分“同文件内容原地刷新(保留视口)”与“切换文件(整树适配)”
let _lastRenderedPath = ''
// 刷新进行中标记：合并同一轮 index+content 同时变化的重复触发，避免一次事件重复重建
let _refreshBusy = false

// 节点文字换行宽度（px，可在底部状态栏点击调节）。注意 markmap maxWidth 只接受数字（函数会被忽略）
const nodeTextWidth = ref(0)
let _savedW = 360
const nodeWidthMin = 60
const nodeWidthMax = 800
try { _savedW = Number(localStorage.getItem('md_mind_node_width')) || 360 } catch { /* ignore */ }
nodeTextWidth.value = Math.max(nodeWidthMin, Math.min(nodeWidthMax, _savedW))

// 计算实际传给 markmap 的 maxWidth（不超过画布宽度）
const resolveMaxWidth = () => Math.min(nodeTextWidth.value, (containerRef.value ? containerRef.value.clientWidth - 40 : 800))

// 设置文字宽度并立即按新宽度重建（保持当前展开级别）
const applyNodeTextWidth = (w: number) => {
  nodeTextWidth.value = Math.max(nodeWidthMin, Math.min(nodeWidthMax, w))
  try { localStorage.setItem('md_mind_node_width', String(nodeTextWidth.value)) } catch { /* ignore */ }
  if (map && document.getElementById(id.value)) expandToLevel(currentLevel.value)
}
const changeNodeTextWidth = (delta: number) => applyNodeTextWidth(nodeTextWidth.value + delta)
const resetNodeTextWidth = () => applyNodeTextWidth(360)

// 状态变量
let colorMode = ref('color') // 'color' 或 'monochrome'
let currentLevel = ref(2)   // 当前展开到的级别（1 = 最顶层）
let maxTreeDepth = ref(0)   // transform 后真实树的最大深度（与 markmap state.depth 计数一致）

// 可展开的级别列表：1 .. 真实树最大深度
const levelList = computed(() => {
  const arr: number[] = []
  for (let l = 1; l <= maxTreeDepth.value; l++) arr.push(l)
  return arr
})

// 顺滑展开到指定层级：不重建整树——按目标层级重设所有节点的 fold，
// 让 markmap 在现有实例上增量重排（带过渡动画并自动 fit）。
// 注意 fold 语义与 markmap 的 initialExpandLevel 完全一致：目标层及更深（depth>=eff）都折叠。
// 只有“有子节点的层”真正收成入口；若仅折叠更深的无子叶子则看不出差别（最后两层切换无效）。
function smoothExpandLevel(level: number) {
  const root = map && map.state && map.state.data
  if (!map || !root || !map.renderData) {
    if (map) expandToLevel(level)
    return
  }
  const eff = level <= 0 ? 1 : level
  const applyNode = (n: any, depth: number) => {
    n.payload = { ...n.payload, fold: depth >= eff ? 1 : 0 }
    for (const c of (n && n.children) || []) applyNode(c, depth + 1)
  }
  applyNode(root, 1)
  map.renderData() // autoFit:true 时内部会平滑过渡到新布局
  if (colorMode.value === 'monochrome') {
    setTimeout(() => applyMonochromeTheme(), 60)
  }
}

// 直接点击级别：展开到对应层级（顺滑动画，不重建）
const pickLevel = (level: number) => {
  if (currentLevel.value === level) return
  currentLevel.value = level
  smoothExpandLevel(level)
}

// 计算真实树的深度（根为 1 级，每层子节点 +1，与 markmap 的展开级别计数一致）
const computeTreeDepth = function(node: any, depth: number = 1): number {
  let max = depth
  if (node && Array.isArray(node.children)) {
    for (const child of node.children) {
      max = Math.max(max, computeTreeDepth(child, depth + 1))
    }
  }
  return max
}

// 去除开头的 YAML frontmatter（避免混入正文 / 干扰根标题）
function stripFrontmatter(text: string): string {
  if (!text) return text
  return text.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

// 把相对图片路径解析为绝对路径（与浏览视图一致），避免导图里图片找不到
function resolveRelativeImages(md: string): string {
  const filePath = store.data[store.index]?.path || ''
  if (!filePath || !md) return md
  const normalizedPath = filePath.replace(/\\/g, '/')
  const lastSlash = normalizedPath.lastIndexOf('/')
  if (lastSlash < 0) return md
  const dir = normalizedPath.substring(0, lastSlash + 1) // 含结尾 /

  const isExternal = (s: string) => !s || /^(https?:|data:|file:\/\/|\/|[A-Za-z]:)/i.test(s)

  // 解析 ./ 与 ../ 片段
  const toAbsolute = (src: string) => {
    const parts: string[] = []
    for (const seg of (dir + src.replace(/\\/g, '/')).split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') { parts.pop(); continue }
      parts.push(seg)
    }
    return parts.join('/')
  }

  // 1) markdown 图片：![alt](相对路径)
  md = md.replace(/!\[([^\]]*)\]\((\S+?)(?:\s+("[^"]*"|'[^']*'))?\s*\)/g, (m, alt, src, title) => {
    src = (src || '').trim()
    if (isExternal(src)) return m
    const abs = toAbsolute(src)
    return title ? `![${alt}](${abs} ${title})` : `![${alt}](${abs})`
  })

  // 2) 内联 HTML：<img ... src="相对路径" ...>
  md = md.replace(/<img([^>]*?)\ssrc="([^"]+)"([^>]*?)>/gi, (m, pre, src, post) => {
    src = (src || '').trim()
    if (isExternal(src)) return m
    return `<img${pre} src="${toAbsolute(src)}"${post}>`
  })

  return md
}

// 取当前文档内容：去 frontmatter + 解析相对图片为绝对路径
function getResolvedContent(): string {
  const raw = store.data[store.index] && store.data[store.index].content
  return resolveRelativeImages(stripFrontmatter(String(raw || '')))
}

// markmap 只保留“位于标题下”的图片；若图片行紧挨在下一个标题之上会被整段丢弃。
// 这里把这类“紧邻标题上方”的图片行挪到该标题之后（通常图片就是为该小节配的图）。
function relocateImagesBeforeHeadings(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let pendingImages: string[] = []
  let inFence = false
  const isHeadingLine = (s: string) => !inFence && /^#{1,6}\s/.test(s)
  const isImgOnlyLine = (s: string) => !inFence && /^!\[[^\]]*\]\([^)]*\)\s*$/.test(s)
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (isHeadingLine(line)) {
      out.push(line)
      if (pendingImages.length) {
        out.push('')
        out.push(...pendingImages)
        pendingImages = []
      }
      continue
    }
    if (isImgOnlyLine(line)) {
      pendingImages.push(line)
      continue
    }
    if (line.trim()) pendingImages = []
    out.push(line)
  }
  if (pendingImages.length) {
    if (out.length) out.push('')
    out.push(...pendingImages)
  }
  return out.join('\n')
}

// 把本地图片内联为 data URL（foreignObject 内更可靠，规避路径/file 访问/测量时机问题）
async function toMindMapMarkdown(): Promise<string> {
  const md = relocateImagesBeforeHeadings(getResolvedContent()).replace(/\r\n?/g, '\n')
  // 注意：上方已把 md 统一为 LF 换行（CRLF 会让行尾锚点类正则失配，例如 mermaid 代码块收敛）
  // 收集本地绝对路径图片（Windows 盘符路径），跳过 http/data/file 外链
  const localSrcs: string[] = []
  const collect = (s: string) => {
    const t = (s || '').trim()
    if (t && /^[A-Za-z]:/.test(t)) localSrcs.push(t)
  }
  let mm: RegExpExecArray | null
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)/g
  while ((mm = mdRe.exec(md))) collect(mm[1])
  const htmlRe = /<img[^>]*?\ssrc="([^"]+)"/gi
  while ((mm = htmlRe.exec(md))) collect(mm[1])

  const unique = [...new Set(localSrcs)]
  const urlMap = new Map<string, string>()
  await Promise.all(unique.map(async (p) => {
    try {
      const dataUrl = await readImageAsDataUrl(p)
      if (dataUrl) urlMap.set(p, dataUrl)
    } catch (e) {
      console.warn('[md_mind] 图片内联失败:', p, e)
    }
  }))

  let out = md
  for (const [abs, dataUrl] of urlMap) {
    const esc = abs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(\\!\\[[^\\]]*\\]\\()${esc}(\\))`, 'g'), `$1${dataUrl}$2`)
    out = out.replace(new RegExp(`(<img[^>]*?\\ssrc=")${esc}(")`, 'gi'), `$1${dataUrl}$2`)
  }

  // 思维导图：把 mermaid 代码块收敛为“🧩 Mermaid 图 [k]”标记叶节点并登记源码，
  // 避免整段代码以 <pre> 形式铺在导图里；点击标记经 MermaidViewer 查看原图
  mmMermaidSources.length = 0
  out = out.replace(/```mermaid[^\n]*\r?\n([\s\S]*?)```[ \t]*(?:\r?\n|$)/gi, (_w, src: string) => {
    mmMermaidSources.push(src.trim())
    return '\n- 🧩 Mermaid 图 [' + (mmMermaidSources.length - 1) + ']\n'
  })
  return out
}

// 取纯文本（去掉 HTML 标签）
function toPlain(html: string): string {
  return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * 确保一级（根）节点有文字：**统一用文件名**（不含扩展名）。
 *
 * markmap 只在「文档恰好只有一个一级标题」时才把该 H1 提升为根节点；
 * 而 Word 转出的 Markdown 往往有多个一级标题（`# 1. 范围` / `# 2. 引用文档` …），
 * 此时 markmap 会留一个**空根**、把各级标题都当成子节点。
 * 旧实现在这种情况下拿「第一个 H1 文本」当根文字 —— 于是根节点成了第一个章节名，
 * 而同一个一级标题又作为子节点出现（重复显示）。
 * 现在与 .md 文件保持一致：根 = 文件名，一级标题作为子节点照常展示。
 */
function ensureRootText(root: any) {
  if (toPlain(root && root.content)) return
  const p = store.data[store.index]?.path || ''
  const base = p ? (p.replace(/\\/g, '/').split('/').pop() || '') : ''
  const label = base.replace(/\.[^.]+$/, '') || base || (store.locales === 'zh' ? '未命名文档' : 'Untitled')
  if (label) {
    root.content = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}

  // 思维导图内 mermaid：点击“🧩 Mermaid 图 [k]”叶节点 → MermaidViewer 查看原图
  // svg 元素常驻（内容在内部重建），只需委托绑定一次，读取最新 mmMermaidSources
  function bindMindmapMermaidClick() {
    const svgEl = document.getElementById(id.value)
    if (!svgEl || (svgEl as any)._mmOpenBound) return
    ;(svgEl as any)._mmOpenBound = true
    svgEl.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as Element
      const g = target && target.closest ? target.closest('g.markmap-node') : null
      if (!g) return
      const m = (g.textContent || '').match(/🧩 Mermaid 图\s*\[(\d+)\]/)
      if (!m) return
      const src = mmMermaidSources[Number(m[1])]
      if (src) mermaidViewerRef.value?.open({ source: src })
    })
  }

const init = async function() {
  ensureRichFixStyle() // 富文本测量校准须在 Markmap.create（内部触发测量）之前注入
  await nextTick()
  if (!containerRef.value || !document.getElementById(id.value)) return
  
  // 清空容器
  const svgElement = document.getElementById(id.value)!
  svgElement.innerHTML = ""
  
  let markdown = await toMindMapMarkdown()
  const transformer = new Transformer()
  const { root, features } = transformer.transform(markdown)
  maxTreeDepth.value = computeTreeDepth(root)
  ensureRootText(root)
  // 初始展开两级，但不超过真实深度
  currentLevel.value = Math.min(Math.max(1, currentLevel.value), maxTreeDepth.value)

  const { Markmap } = markmap

  // 创建 markmap，使用默认彩色
  const options = {
    duration: 500,
    nodeMinHeight: 16,
    spacingVertical: 10,
    spacingHorizontal: 80,
    paddingX: 10,
    autoFit: true,
    fitRatio: 0.95,
    zoom: true,
    pan: true,
    initialExpandLevel: currentLevel.value,
    // maxWidth 只接受数字（单位 px）；由 resolveMaxWidth 计算并受画布宽度约束
    maxWidth: resolveMaxWidth(),
  } as any

  map = Markmap.create('#' + id.value, options, root)
  
  // 保存原始数据引用
  if (!map.state) map.state = {}
  map.state.data = root
  _lastRenderedPath = store.data[store.index]?.path || '' // 记录来源文件：首次同文件刷新即可保留视口

  // 应用样式（但不覆盖颜色）
  setTimeout(() => {
    applyCustomStyles()
  }, 100)
  
  // 监听主题变化
  const observer = new MutationObserver(() => {
    if (map) {
      applyCustomStyles()
    }
  })
  
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class']
  })
  
  window.addEventListener('resize', handleResize)
}

// 切换颜色模式
const toggleColorMode = async function() {
  colorMode.value = colorMode.value === 'color' ? 'monochrome' : 'color'
  
  if (colorMode.value === 'monochrome') {
    // 切换到单色模式
    applyMonochromeTheme()
  } else {
    // 切换回彩色模式，重新初始化让 markmap 恢复默认彩色
    await init()
  }
}

// 应用单色主题
function applyMonochromeTheme() {
  const svgElement = document.getElementById(id.value)
  if (!svgElement) return
  
  const rootStyle = getComputedStyle(document.documentElement)
  const monoColor = rootStyle.getPropertyValue('--fontActiveColor') || '#42b883'
  
  // 统一所有线条颜色
  const links = svgElement.querySelectorAll('.markmap-link')
  links.forEach(link => {
    link.setAttribute('stroke', monoColor)
  })
  
  // 统一节点线条
  const nodeLines = svgElement.querySelectorAll('.markmap-node line')
  nodeLines.forEach(line => {
    line.setAttribute('stroke', monoColor)
  })
  
  // 统一箭头颜色
  const arrows = svgElement.querySelectorAll('.markmap-arrow')
  arrows.forEach(arrow => {
    arrow.setAttribute('fill', monoColor)
    arrow.setAttribute('stroke', monoColor)
  })
  
  // 统一节点圆圈颜色
  const circles = svgElement.querySelectorAll('.markmap-node circle')
  circles.forEach(circle => {
    circle.setAttribute('stroke', monoColor)
  })
  
  // 统一文字颜色
  const texts = svgElement.querySelectorAll('.markmap-node text')
  const textColor = rootStyle.getPropertyValue('--fontColor') || '#333'
  texts.forEach(text => {
    text.setAttribute('fill', textColor)
  })
}

// 展开到指定级别
const expandToLevel = async function(level: number) {
  ensureRichFixStyle() // 重建前确保富文本测量校准 CSS 已就位
  if (!containerRef.value || !document.getElementById(id.value)) return
  
  // 清空容器
  const svgElement = document.getElementById(id.value)!
  svgElement.innerHTML = ""
  
  // 获取当前内容
  const markdown = await toMindMapMarkdown()
  const transformer = new Transformer()
  const { root } = transformer.transform(markdown)
  maxTreeDepth.value = computeTreeDepth(root)
  ensureRootText(root)
  
  // 根据级别设置展开选项
  let expandLevel = level
  if (level === 0) expandLevel = 1 // 至少展开1级
  
  const { Markmap } = markmap
  const options = {
    duration: 500,
    nodeMinHeight: 16,
    spacingVertical: 10,
    spacingHorizontal: 80,
    paddingX: 10,
    autoFit: true,
    fitRatio: 0.95,
    zoom: true,
    pan: true,
    initialExpandLevel: expandLevel, // 使用指定的展开级别
    // maxWidth 只接受数字（单位 px）；由 resolveMaxWidth 计算并受画布宽度约束
    maxWidth: resolveMaxWidth(),
  } as any
  
  // 销毁旧实例
  if (map) {
    map.destroy()
  }
  
  // 创建新实例
  map = Markmap.create('#' + id.value, options, root)
  
  // 保存数据引用
  if (!map.state) map.state = {}
  map.state.data = root
  
  // 应用样式
  setTimeout(() => {
    applyCustomStyles()
    // 如果当前是单色模式，重新应用
    if (colorMode.value === 'monochrome') {
      applyMonochromeTheme()
    }
  }, 100)
}

// 应用自定义样式（不覆盖颜色）
function applyCustomStyles() {
  const svgElement = document.getElementById(id.value)
  if (!svgElement) return
  
  // 创建样式元素
  let styleElement = document.getElementById('markmap-custom-styles')
  if (!styleElement) {
    styleElement = document.createElement('style')
    styleElement.id = 'markmap-custom-styles'
    document.head.appendChild(styleElement)
  }
  
  // 获取当前主题颜色
  const rootStyle = getComputedStyle(document.documentElement)
  const backgroundColor = rootStyle.getPropertyValue('--backgroundColor') || '#fff'
  const textColor = rootStyle.getPropertyValue('--fontColor') || '#333'
  const borderColor = rootStyle.getPropertyValue('--borderColor') || '#ccc'
  
  // 只修复布局相关样式，不覆盖颜色
  styleElement.textContent = `
    /* 确保文本有透明背景并使用主题色 */
    #${id.value} .markmap-foreign {
      background-color: transparent !important;
      overflow: visible !important;
      color: ${textColor} !important;
    }
    
    /* 修复文字颜色使用主题色 */
    #${id.value} .markmap-node text {
      fill: ${textColor} !important;
      stroke: none !important;
    }
    
    /* foreignObject 内部的文字 */
    #${id.value} .markmap-foreign div,
    #${id.value} .markmap-foreign span {
      color: ${textColor} !important;
    }
    
    /* 普通文本超长自动换行（折行宽度由 maxWidth / --markmap-max-width 决定） */
    #${id.value} .markmap-foreign div,
    #${id.value} .markmap-foreign p,
    #${id.value} .markmap-foreign span {
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    /* 代码块：不折行、按代码原始宽度展示（配合测量端豁免，foreignObject 宽度足够放下最长行） */
    #${id.value} .markmap-foreign pre,
    #${id.value} .markmap-foreign pre code {
      white-space: pre;
      word-break: normal;
      overflow-wrap: normal;
    }
    /* 表格：单元格允许折行 + 限宽，避免不可折长串把表格撑出外框 / 外框高度虚高 */
    #${id.value} .markmap-foreign table {
      max-width: 100%;
    }
    #${id.value} .markmap-foreign th,
    #${id.value} .markmap-foreign td {
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    
    /* 修复文字背景 */
    #${id.value} .markmap-node-text-bg {
      fill: ${backgroundColor} !important;
      stroke: ${backgroundColor} !important;
    }
    
    /* 修复节点圆圈背景 */
    #${id.value} .markmap-node circle {
      fill: ${backgroundColor} !important;
      stroke: ${borderColor} !important;
      stroke-width: 2px !important;
    }
    
    /* 悬停效果 */
    #${id.value} .markmap-node:hover circle {
      fill: ${textColor} !important;
      stroke: ${textColor} !important;
    }
  `
}

// 富文本节点的“测量尺寸校准”（作用于 Markmap.create / setData 前的测量阶段）：
// markmap 会先在 document.body 的隐藏容器（class 形如 `<svgId>-g`，即 markmap-container markmap <id>-g）
// 里“预测量”每个节点的尺寸，再把测量值写回 foreignObject 宽/高并用于布局。若测量与真实渲染不一致，
// 就会出现内容比外框大 / 外框虚高等问题。这里按富文本类型分别校准：
//  · 含 <pre> 代码块：取消测量组 max-width → 测量宽度 = 代码原始宽度（代码不折行、按原宽完整放下）；
//  · 含 <table> 表格：允许单元格折行 + 表格限宽 → 测量高度不再虚高，与真实渲染一致；
// 普通文本段落不受影响，仍按 maxWidth 折行。
// 必须在 Markmap.create / setData（内部会触发测量）之前注入，故各重建入口都会 ensure（幂等、按实例隔离）。
const RICHTEXT_FIX_STYLE_ID = 'md-mind-richtext-fix-'
function ensureRichFixStyle() {
  const sid = RICHTEXT_FIX_STYLE_ID + id.value
  if (document.getElementById(sid)) return
  const st = document.createElement('style')
  st.id = sid
  st.textContent = `
    /* 含代码块(<pre>)的测量组：按代码原始宽度测量，不被 maxWidth 截断 */
    .${id.value}-g .markmap-foreign-testing-max:has(pre) {
      max-width: none !important;
    }
    /* 含表格的测量组：单元格可折行 + 表格限宽，避免测量高度虚高 */
    .${id.value}-g .markmap-foreign table {
      max-width: 100%;
    }
    .${id.value}-g .markmap-foreign th,
    .${id.value}-g .markmap-foreign td {
      word-break: break-word;
      overflow-wrap: anywhere;
    }
  `
  ;(document.head || document.documentElement).appendChild(st)
}

// ==================== 讲解 / 演示模式（类似 XMind 演示：左右键逐级下钻 / 回退） ====================
// 收集某标题子树中“本页可见”的全部“🧩 Mermaid 图 [k]”标记叶下标（DFS 先序；本页多张依次展示）。
// 折叠节点（页内只显示标题入口、其子树不可见）不深入——避免把深处/后面的图误算作本页图
function collectVisibleMermaidList(node: any, isRoot = true): number[] {
  const res: number[] = []
  const walk = (n: any, rootFlag: boolean) => {
    if (!n) return
    const m = toPlain(n.content || '').match(/🧩 Mermaid 图\s*\[(\d+)\]/)
    if (m) { res.push(Number(m[1])); return } // 图标记叶无子，收集后无需下钻
    // 根节点自身总是可见；其余节点若被折叠则其子树不在当前演讲页中，不再深入
    if (!rootFlag && n.payload && n.payload.fold) return
    for (const c of (n && n.children) || []) walk(c, false)
  }
  walk(node, isRoot)
  return res
}
const inTalk = ref(false)          // 是否处于讲解模式
const talkIndex = ref(0)           // 当前讲解步骤下标（0 起）
const talkTotal = ref(0)           // 讲解步骤总数
const TALK_ANIM_MS = 560           // 等 markmap 过渡完成后再加高亮 / 微调
let _talkSaveLevel = 2             // 进入讲解时记录的展开层级，退出时恢复
let _talkList: any[] = []          // 讲解步骤：有子级的标题节点，深度优先先序（不含根）
let _talkRoot: any = null          // 整树快照（进入讲解时记录，供导航/面包屑；讲解期间画布树会切换为焦点页）
let _talkParents = new Map<any, any>() // 子 -> 父（基于整树快照）
let _talkFocus: any = null         // 当前聚焦节点
const talkPageMermaidList = ref<number[]>([]) // 当前标题页可见的 mermaid 下标列表（本页多张时依次 → 展示）
const talkMermaidCursor = ref(-1)  // 已展示到列表中的位置；-1 = 尚未看图（停在结构页）

// 讲解页固定两层的页内折叠规则见 src/lib/mindmap-talk.ts（prepareTalkPage）

// 面包屑：整条祖先路径（如 文档 › 第1章 › 1.2）。
// 状态栏里原样完整显示，不做字符裁剪；宽度不够时由 CSS 在前面加「…」（见 talkCrumbTrunc）。
const talkPathFull = computed(() => {
  void talkIndex.value
  if (!_talkFocus) return ''
  return _talkAncestors(_talkFocus)
    .map((n) => toPlain(n.content).trim())
    .filter(Boolean)
    .join(' › ')
})

// 面包屑过长：路径比状态栏可用宽度还长时，给条目加 .bc-trunc ——
// 文本右对齐、左侧被裁掉，配合 ::before 的「…」实现**前面省略**（保留尾部=当前所在层级）。
// 不用 CSS 的 direction:rtl 技巧：中文标题 + 数字编号混排会被 bidi 重排、文字乱序。
const talkCrumbEl = ref<HTMLElement | null>(null)
const talkCrumbTrunc = ref(false)
const updateCrumbTrunc = () => {
  const el = talkCrumbEl.value
  const txt = el ? (el.querySelector('.bc-text') as HTMLElement | null) : null
  if (!el || !txt || !el.clientWidth) {
    talkCrumbTrunc.value = false
    return
  }
  // .bc-text 始终 flex:0 0 auto（宽度 = 文本实际宽度），所以这个比较在两种状态下都稳定、不会震荡
  talkCrumbTrunc.value = txt.getBoundingClientRect().width > el.clientWidth + 1
}
watch(talkPathFull, () => { void nextTick(updateCrumbTrunc) })
// 容器宽度变化（窗口或布局变化）也要重新判断：窗口 resize 之外，面板/标签布局变化不会触发 window.resize
let _crumbRO: ResizeObserver | null = null

// 从当前渲染树构建讲解步骤列表（DFS 先序；正文/图片叶子并入其标题，不作为单独步骤）。
// 文档总标题（map 根 = ensureRootText 填成的「文件名」节点）也作为第 1 页，
// 即首页 = 总标题 + 它的下一层总览（封面/总览页），不再是“只有一个节点的空标题页”。
function _collectTalkList(): any[] {
  const root = map && map.state && map.state.data
  if (!root) return []
  _talkRoot = root
  _talkParents = new Map()
  const out: any[] = []
  const visit = (n: any, p: any) => {
    if (p) _talkParents.set(n, p)
    if (n.children && n.children.length) out.push(n) // 含 root（总标题），DFS 先序即 root 在最前
    if (n.children) for (const c of n.children) visit(c, n)
  }
  visit(root, null)
  return out
}

// 根到 node 的祖先链（含 node）
function _talkAncestors(node: any): any[] {
  const chain: any[] = []
  let cur: any = node
  while (cur) {
    chain.push(cur)
    cur = _talkParents.get(cur)
  }
  return chain.reverse()
}

function _talkSvg(): SVGElement | null {
  return document.getElementById(id.value) as SVGElement | null
}

function _clearTalkHighlight() {
  const svg = _talkSvg()
  if (!svg) return
  svg.classList.remove('mm-talk-on')
  svg.querySelectorAll('.mm-talk-focus, .mm-talk-path').forEach((el) => {
    el.classList.remove('mm-talk-focus', 'mm-talk-path')
  })
}

// 页内高亮：本页所有可见节点都清晰显示（标题 + 它的直接子节点作为一页内容），
// 遇到折叠的子标题入口也标记为可见（作为可下钻节点），但不再深入其子树；焦点加光环。
function _applyTalkHighlight(focus: any) {
  const svg = _talkSvg()
  const root = map && map.state && map.state.data // 页根（focus 自身）
  if (!svg || !map || !map.findElement || !root) return
  svg.classList.add('mm-talk-on')
  const mark = (n: any, cls: string) => {
    const hit = map.findElement(n)
    if (hit && hit.g) hit.g.classList.add(cls)
  }
  const walk = (n: any, isRoot: boolean) => {
    if (!n) return
    mark(n, isRoot ? 'mm-talk-focus' : 'mm-talk-path')
    if (n.payload && n.payload.fold) return // 子标题入口：显示为节点，但不再向下展开
    if (n.children) for (const c of n.children) walk(c, false)
  }
  walk(root, true)
}

// 聚焦到某一步：把“焦点标题 + 它的下一层”作为一页整图渲染（页式讲解）。
// 直接复用同一 map 实例 setData 切换（不销毁重建）；initialExpandLevel 传 -1，
// 避免 initializeData 按层级覆盖我们预置的页内折叠。
function _focusTalkStep(node: any) {
  if (!map || !node) return
  _talkFocus = node
  prepareTalkPage(node) // 预置页内折叠：焦点展开，第 2 层子标题收成入口（一页固定两层）
  void nextTick(updateCrumbTrunc) // 面包屑文本变了：重新判断是否需要前面省略
  // 收集本页可见的 mermaid（可能多张）：先进页展示整页导图结构，按“→”依次弹出各图，不直接盖住本页
  talkPageMermaidList.value = collectVisibleMermaidList(node)
  talkMermaidCursor.value = -1
  mermaidViewerRef.value?.close()
  map.setData(node, { initialExpandLevel: -1 })
  setTimeout(() => {
    _clearTalkHighlight()
    _applyTalkHighlight(node)
    if (colorMode.value === 'monochrome') applyMonochromeTheme() // 重排后重应用单色
  }, TALK_ANIM_MS)
}

// 进入讲解模式：从第一个标题开始
function startTalk() {
  if (inTalk.value || !map || !map.state || !map.state.data) return
  const list = _collectTalkList()
  if (!list.length) {
    console.warn('[md_mind] 没有可讲解的层级标题')
    return
  }
  _talkSaveLevel = currentLevel.value
  _talkList = list
  talkTotal.value = list.length
  talkIndex.value = 0
  inTalk.value = true
  _focusTalkStep(list[0])
}

// 下一步：逐级下钻；到底后按 DFS 自动“返回上一层并移动下一个标题”
function talkNext() {
  if (!inTalk.value) return
  // 依次看图：本页有多张图时，每次 → 显示下一张；全部看完再 → 才进入下一标题页
  if (talkMermaidCursor.value < talkPageMermaidList.value.length - 1) {
    const src = mmMermaidSources[talkPageMermaidList.value[talkMermaidCursor.value + 1]]
    if (src) {
      talkMermaidCursor.value += 1
      mermaidViewerRef.value?.open({ source: src })
      return
    }
  }
  // 无更多图（或本页无图）：关闭弹层并前进到下一个标题（下一标题先展示结构，其图再按 → 查看）
  mermaidViewerRef.value?.close()
  talkMermaidCursor.value = -1
  talkPageMermaidList.value = []
  if (talkIndex.value < _talkList.length - 1) {
    talkIndex.value += 1
    _focusTalkStep(_talkList[talkIndex.value])
  }
}

// 上一步：回退到前一个标题
function talkPrev() {
  if (!inTalk.value) return
  // 正在看图：← 先退回上一张图；第一张时关闭回到本页结构页
  if (talkMermaidCursor.value >= 0) {
    if (talkMermaidCursor.value > 0) {
      const src = mmMermaidSources[talkPageMermaidList.value[talkMermaidCursor.value - 1]]
      if (src) {
        talkMermaidCursor.value -= 1
        mermaidViewerRef.value?.open({ source: src })
        return
      }
    }
    mermaidViewerRef.value?.close()
    talkMermaidCursor.value = -1
    return
  }
  if (talkIndex.value > 0) {
    talkIndex.value -= 1
    _focusTalkStep(_talkList[talkIndex.value])
  }
}

// 静默离开讲解（内容/索引变化时调用，交由 update() setData 重建恢复）
function forceLeaveTalk() {
  if (!inTalk.value) return
  inTalk.value = false
  talkPageMermaidList.value = []
  talkMermaidCursor.value = -1
  mermaidViewerRef.value?.close()
  talkTotal.value = 0
  _clearTalkHighlight()
  _talkFocus = null
  _talkList = []
}

// 用户主动退出：重建并恢复进入前的展开层级
function exitTalk() {
  if (!inTalk.value) return
  inTalk.value = false
  talkPageMermaidList.value = []
  talkMermaidCursor.value = -1
  mermaidViewerRef.value?.close()
  talkTotal.value = 0
  _clearTalkHighlight()
  _talkFocus = null
  _talkList = []
  currentLevel.value = _talkSaveLevel
  if (map) expandToLevel(currentLevel.value)
}

// 上一步：看图时先退回上一张；已在讲解第一页（且没在看图）则退回全局预览（退出讲解）
function talkPrevOrExit() {
  if (!inTalk.value) return
  if (talkIndex.value <= 0 && talkMermaidCursor.value < 0) {
    exitTalk()
    return
  }
  talkPrev()
}

// 讲解模式下的键盘 ← / → 控制：
//  - 未播放：→/↓ 直接进入讲解模式的第一页（总标题页）；←/↑ 不做事
//  - 播放中：→/↓ 下一步；←/↑ 上一步，已在第一页则退回全局预览（退出讲解）
function onTalkKeydown(e: KeyboardEvent) {
  // 本组件不可见（切走视图）时不响应
  if (!containerRef.value || containerRef.value.offsetParent === null) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return
  const isNext = e.key === 'ArrowRight' || e.key === 'ArrowDown'
  const isPrev = e.key === 'ArrowLeft' || e.key === 'ArrowUp'
  if (!isNext && !isPrev) return

  if (!inTalk.value) {
    if (!isNext) return
    e.preventDefault()
    startTalk()
    return
  }

  e.preventDefault()
  if (isNext) talkNext()
  else talkPrevOrExit()
}

async function update(preserveView = false) {
  ensureRichFixStyle() // setData 前确保富文本测量校准 CSS 已就位
  if (!map || !store.data[store.index]) return
  forceLeaveTalk() // 若在讲解中，先退出（update 会 setData 重建恢复）
  
  let markdown = await toMindMapMarkdown()
  const transformer = new Transformer()
  const { root } = transformer.transform(markdown)
  maxTreeDepth.value = computeTreeDepth(root)
  ensureRootText(root)
  if (currentLevel.value > maxTreeDepth.value) currentLevel.value = maxTreeDepth.value
  // 同文件内容原地刷新（如其他窗口保存后广播 → store 内容更新）：保留当前视口（缩放/平移/焦点区域），
  // 避免每次保存后“整树适配”把视图重置回全图。临时关闭 autoFit 防止 setData→renderData 内部自动 fit。
  if (preserveView) {
    map.setOptions({ autoFit: false })
    map.setData(root, { initialExpandLevel: currentLevel.value })
    map.setOptions({ autoFit: true })
    map.state.data = root
    requestAnimationFrame(() => {
      if (colorMode.value === 'monochrome') {
        setTimeout(() => applyMonochromeTheme(), 50)
      }
    })
    return
  }
  
  // 恢复按当前层级折叠（讲解页会把 map 的 initialExpandLevel 改成 -1，避免内容更新后整树全展开）
  map.setData(root, { initialExpandLevel: currentLevel.value })
  map.state.data = root
  
  requestAnimationFrame(() => {
    map.fit()
    setTimeout(() => {
      if (map && map.fit) {
        map.fit()
      }
      // 如果当前是单色模式，重新应用
      if (colorMode.value === 'monochrome') {
        setTimeout(() => applyMonochromeTheme(), 50)
      }
    }, 100)
  })
}

// 处理窗口大小变化
function handleResize() {
  updateCrumbTrunc() // 窗口变窄/变宽都会影响面包屑是否能完整显示
  if (map && map.fit) {
    requestAnimationFrame(() => {
      map.fit()
    })
  }
}

// 思维导图刷新入口：文件/内容变化时重建整图。
//  - 同文件内容原地刷新（编辑保存 / 其他窗口保存广播同步到 store）：保留当前视口；
//  - 切换文件/标签：整树适配（新文件视角）。
async function refreshMap() {
  if (_refreshBusy) return
  if (!map || !store.data[store.index]) return
  _refreshBusy = true
  try {
    const path = store.data[store.index].path || ''
    // 路径与最近一次渲染相同 = 同文件内容原地刷新 → 保留视口；路径变化（切换文件）→ 整树适配
    const preserveView = path !== '' && path === _lastRenderedPath
    _lastRenderedPath = path
    await update(preserveView)
  } finally {
    _refreshBusy = false
  }
}

// 监听索引变化（切换文件/标签）
watch(() => store.index, () => {
  void refreshMap()
})

// 监听内容变化（同文件被编辑保存 / 其他窗口保存广播同步到 store）
watch(() => store.data[store.index]?.content, () => {
  void refreshMap()
})

onMounted(() => {
  init()
  bindMindmapMermaidClick()
  window.addEventListener('keydown', onTalkKeydown)
  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    _crumbRO = new ResizeObserver(() => updateCrumbTrunc())
    _crumbRO.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  window.removeEventListener('keydown', onTalkKeydown)
  if (_crumbRO) { _crumbRO.disconnect(); _crumbRO = null }
  const styleElement = document.getElementById('markmap-custom-styles')
  if (styleElement) {
    styleElement.remove()
  }
  const fixStyle = document.getElementById(RICHTEXT_FIX_STYLE_ID + id.value)
  if (fixStyle) {
    fixStyle.remove()
  }
  if (map) {
    map.destroy()
  }
})
</script>
  
<template>
  <div class="mindmap-container" v-if="store.data[store.index] != undefined">
    <div class="mindmap" ref="containerRef">
      <svg :id="id" class="mindmap-svg"></svg>
      <!-- Mermaid 图查看（放大/平移/导出，复用共享组件） -->
      <MermaidViewer ref="mermaidViewerRef" />

      <!-- 底部状态栏（样式与 md_read / PdfViewer / Edit_Code 一致） -->
      <div class="mind-statusbar">
        <!-- ============ 普通工具栏 ============ -->
        <template v-if="!inTalk">
          <!-- 讲解 / 演示入口（放在状态栏最左侧） -->
          <button class="statusbar-btn talk-start-btn" :disabled="!map" @click="startTalk()" :title="store.locales==='zh' ? '讲解模式：从第一个标题开始，→/↓ 下一步、←/↑ 上一步（多图页依次看图）；未播放时按 →/↓ 直接进入第一页' : 'Talk mode: ←/→/↑/↓ to step (press →/↓ to start)'">
            <i class="fa fa-play"></i>
          </button>

          <!-- 适应窗口 / 刷新 -->
          <button class="statusbar-btn" @click="map && map.fit()" :title="store.locales==='zh' ? '适应窗口' : 'Fit to window'">
            <i class="fa fa-arrows-alt"></i>
          </button>
          <button class="statusbar-btn" @click="init()" :title="store.locales==='zh' ? '刷新' : 'Refresh'">
            <i class="fa fa-refresh"></i>
          </button>

          <span class="statusbar-sep"></span>

          <!-- 单色 / 彩色切换 -->
          <button class="statusbar-btn" :class="{ active: colorMode === 'monochrome' }" @click="toggleColorMode()" :title="colorMode === 'color' ? (store.locales==='zh' ? '切换为单色' : 'Switch to monochrome') : (store.locales==='zh' ? '切换为彩色' : 'Switch to color')">
            <i :class="colorMode === 'color' ? 'fa fa-adjust' : 'fa fa-paint-brush'"></i>
            <span>{{ colorMode === 'color' ? (store.locales==='zh' ? '单色' : 'Mono') : (store.locales==='zh' ? '彩色' : 'Color') }}</span>
          </button>

          <span class="statusbar-sep"></span>

          <!-- 节点文字宽度 -->
          <span class="statusbar-item mind-w-label" :title="store.locales==='zh' ? '节点文字折行宽度' : 'Node text wrap width'"><i class="fa fa-arrows-h"></i></span>
          <button class="statusbar-btn" @click="changeNodeTextWidth(-20)" :title="store.locales==='zh' ? '变窄 (px)' : 'Narrower (px)'"><i class="fa fa-minus"></i></button>
          <span class="statusbar-item mind-w-value" @click="resetNodeTextWidth" :title="store.locales==='zh' ? '点击恢复默认 360px' : 'Click to reset to 360px'">{{ nodeTextWidth }}</span>
          <button class="statusbar-btn" @click="changeNodeTextWidth(20)" :title="store.locales==='zh' ? '加宽 (px)' : 'Wider (px)'"><i class="fa fa-plus"></i></button>

          <span class="statusbar-spacer"></span>

          <!-- 展开层级（放在状态栏最右侧）：可直接点击 -->
          <span class="statusbar-item mind-lv-label"><i class="fa fa-sitemap"></i> {{ store.locales==='zh' ? '层级' : 'Level' }}</span>
          <button v-for="l in levelList" :key="l" class="statusbar-btn" :class="{ active: currentLevel === l }" @click="pickLevel(l)" :title="store.locales==='zh' ? ('展开到第 ' + l + ' 级') : ('Expand to level ' + l)">
            {{ l }}
          </button>
        </template>

        <!-- ============ 讲解模式工具栏（整条切换） ============ -->
        <template v-else>
          <!-- 左侧：状态 + 当前标题 / 路径（标题弹性占满中间空位） -->
          <span class="statusbar-item talk-step">{{ store.locales==='zh' ? '步骤' : 'Step' }} {{ talkIndex + 1 }} / {{ talkTotal }}</span>
          <span v-if="talkMermaidCursor >= 0" class="statusbar-item talk-mermaid-step"><i class="fa fa-picture-o"></i> {{ store.locales==='zh' ? '图' : 'Fig' }} {{ talkMermaidCursor + 1 }}/{{ talkPageMermaidList.length }}</span>
          <span ref="talkCrumbEl" class="statusbar-item talk-breadcrumb" :class="{ 'bc-trunc': talkCrumbTrunc }" :title="talkPathFull">
            <span class="bc-text">{{ talkPathFull || (store.locales==='zh' ? '（无标题）' : '(no title)') }}</span>
          </span>

          <!-- 右侧：上一步 / 下一步 + 退出（页内固定两层，不再提供“结构 N”调节） -->
          <span class="statusbar-sep"></span>
          <button class="statusbar-btn" @click="talkPrevOrExit()" :title="store.locales==='zh' ? '上一步（看图时先退回上一张；已在第一页则退出讲解、回到全局预览） / ←/↑' : 'Previous / ←/↑ (at first page: back to overview)'">
            <i class="fa fa-chevron-left"></i> {{ store.locales==='zh' ? '上一步' : 'Prev' }}
          </button>
          <button class="statusbar-btn talk-main" :disabled="talkIndex >= talkTotal - 1 && talkMermaidCursor >= talkPageMermaidList.length - 1" @click="talkNext()" :title="store.locales==='zh' ? '下一步（多图页依次看图 / 下钻 / →/↓）' : 'Next / →/↓'">
            {{ store.locales==='zh' ? '下一步' : 'Next' }} <i class="fa fa-chevron-right"></i>
          </button>

          <span class="statusbar-sep"></span>
          <button class="statusbar-btn talk-exit" @click="exitTalk()" :title="store.locales==='zh' ? '退出讲解模式（恢复展开）' : 'Exit talk mode'">
            <i class="fa fa-close"></i> {{ store.locales==='zh' ? '退出' : 'Exit' }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
  
<style scoped>
.mindmap-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  flex: 1;
}

.mindmap {
  position: relative;
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--backgroundColor);
}

.mindmap-svg {
  width: 100%;
  height: 100%;
  flex: 1;
  min-height: 0;
  display: block;
  overflow: visible;
}

/* 底部状态栏（样式与 md_read 状态栏一致） */
.mind-statusbar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  flex-shrink: 0;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  box-sizing: border-box;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.mind-statusbar .statusbar-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.85;
}
.mind-statusbar .statusbar-item i {
  font-size: 11px;
  opacity: 0.7;
}
.mind-statusbar .mind-lv-label {
  margin-right: 2px;
}.mind-statusbar .mind-w-label {
  margin-right: 2px;
}
.mind-statusbar .mind-w-value {
  min-width: 38px;
  text-align: center;
  cursor: pointer;
  height: 18px;
  padding: 0 6px;
  border-radius: 3px;
  justify-content: center;
  box-sizing: border-box;
}
.mind-statusbar .mind-w-value:hover {
  background-color: var(--menuActiveColor);
  opacity: 1;
}.mind-statusbar .statusbar-sep {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  margin: 0 6px;
  opacity: 0.6;
  flex-shrink: 0;
}
.mind-statusbar .statusbar-btn {
  margin: 0;
  padding: 0 6px;
  width: auto;
  height: 18px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 0.15s;
  flex-shrink: 0;
}
.mind-statusbar .statusbar-btn:hover {
  background-color: var(--menuActiveColor);
  opacity: 1;
}
.mind-statusbar .statusbar-btn.active {
  color: var(--fontActiveColor);
  opacity: 1;
  font-weight: 600;
}
.mind-statusbar .statusbar-spacer {
  flex: 1;
}
.mind-statusbar .statusbar-btn:disabled {
  opacity: 0.35;
  cursor: default;
  pointer-events: none;
}
.mind-statusbar .talk-step {
  min-width: 76px;
}
.mind-statusbar .talk-mermaid-step {
  color: var(--fontActiveColor);
  opacity: 1;
  min-width: 46px;
  margin-right: 2px;
}
.mind-statusbar .talk-mermaid-step i {
  opacity: 0.8;
}
.mind-statusbar .talk-breadcrumb {
  /* 完整展示标题层级：宽度够就全文显示（不预先裁字符）；
     放不下时（.bc-trunc）文本右对齐、左侧被裁掉，再用 ::before 的「…」做出
     「前面省略」的观感 —— 保留尾部（当前所在层级与它最近的父级）。
     始终单行，不换行、不撑高状态栏。:title 仍是完整路径，可悬浮看全文。 */
  display: flex;
  align-items: center;
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  margin: 0 8px 0 4px;
  overflow: hidden;
  white-space: nowrap;
}
.mind-statusbar .talk-breadcrumb .bc-text {
  /* 宽度始终等于文本实际宽度：父级 fit 判断不会因截断状态而震荡 */
  flex: 0 0 auto;
  white-space: nowrap;
}
.mind-statusbar .talk-breadcrumb.bc-trunc {
  justify-content: flex-end;   /* 文本靠右，溢出部分裁在左侧 */
}
.mind-statusbar .talk-breadcrumb.bc-trunc::before {
  content: '…';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  /* 2px 余量：盖住左侧被栏边裁到一半的那个字 */
  padding-right: 2px;
  /* 用状态栏底色挡住盖在「…」下面的半截文字（不能透明，否则会重叠） */
  background: var(--menuColor);
}
.mind-statusbar .talk-main {
  color: var(--fontActiveColor);
  font-weight: 600;
}
</style>

<style>
/* ===== 讲解模式：markmap 动态节点的聚焦高亮（须非 scoped） ===== */
.mm-talk-on .markmap-node {
  opacity: 0.22;
  transition: opacity 0.45s ease;
}
.mm-talk-on .markmap-link {
  opacity: 0.25;
  transition: opacity 0.45s ease;
}
.mm-talk-on .markmap-node.mm-talk-path {
  opacity: 1;
}
.mm-talk-on .markmap-node.mm-talk-focus {
  opacity: 1;
}
.mm-talk-on .markmap-node.mm-talk-focus circle {
  fill: var(--fontActiveColor, #42b883) !important;
  stroke: var(--fontActiveColor, #42b883) !important;
  stroke-width: 3px !important;
  r: 9px;
}
.mm-talk-on .markmap-node.mm-talk-focus .markmap-foreign {
  /* 用同色细描边做“视觉加粗”强调，避免 font-weight 改变文本布局宽度：
     markmap 按“未加粗”文本测量折行宽度，聚焦时若加粗、文字会变宽，
     接近折行临界宽度的标题就会多出孤字换行；不聚焦（不加粗）时即恢复 */
  -webkit-text-stroke: 0.6px var(--fontColor, #333);
}
.mm-talk-on .markmap-node.mm-talk-focus > line {
  stroke: var(--fontActiveColor, #42b883) !important;
  stroke-width: 2.5px !important;
}
</style>