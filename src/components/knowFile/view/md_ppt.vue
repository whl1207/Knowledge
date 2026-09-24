<script setup lang="ts">

  import { usestore } from '@/store'
  import { ref,reactive,computed,watch,onMounted,onBeforeUnmount,nextTick } from 'vue'

  import MarkdownIt from 'markdown-it'
  import yaml from 'js-yaml'
  import frontMatter from 'markdown-it-front-matter'
  //import katex from 'markdown-it-katex'
  import mathjax3 from 'markdown-it-mathjax3'
  //import replacelink from 'markdown-it-replace-link'
  import tocAndAnchor from 'markdown-it-toc-and-anchor'
  import mark from 'markdown-it-mark'
  import hljs from 'highlight.js'
  import 'highlight.js/styles/nnfx-dark.min.css'
  import { normalizeMermaidSource } from '@/lib/markdown/mermaid-normalize'
  import { preprocessMath as sharedPreprocessMath } from '@/lib/markdown/render'
  import MermaidViewer from '@/components/MermaidViewer.vue'
  import mermaid from 'mermaid'

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'default',
    flowchart: { htmlLabels: true }
  })

  //读取并解构数据
  const store=usestore()
  let data = {} as any
  let prepList = ref([]) as any //预览列表
  let showIndex = ref(0)
  let currentTime = ref('')
  const updateTime = () => {
    const now = new Date()
    currentTime.value = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  updateTime()
  const timeInterval = setInterval(updateTime, 30000)

  // 当前 Markdown 文件所在目录，用于解析相对图片路径
  let mdBasePath = ''

  const md: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: function (str:any, lang:any) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const highlighted = hljs.highlight(str,{language: lang, ignoreIllegals: true }).value
          return `<pre class="hljs scoll" data-lang="${md.utils.escapeHtml(lang)}"><code>${highlighted}</code></pre>`;
        } catch (__) {}
      }
      return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
    },
  }).use(frontMatter, (fm:any) => {
    yaml.load(fm)// 解析YAML
  }).use(mathjax3)
  .use(tocAndAnchor, { anchorLink:false })
  .use(mark)

  // 重写图片渲染规则：解析相对路径 + 添加描述
  const defaultImageRender = md.renderer.rules.image || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const srcIndex = token.attrIndex('src')
    if (srcIndex >= 0 && mdBasePath) {
      let src = token.attrs![srcIndex][1]
      // 判断是否为相对路径（不以协议、data:、file://、/、盘符开头）
      if (src && !/^(https?:|data:|file:\/\/|\/|[A-Za-z]:)/i.test(src)) {
        const normalizedSrc = src.replace(/\\/g, '/')
        src = mdBasePath + normalizedSrc
        token.attrs![srcIndex][1] = src
      }
    }
    const imgHtml = defaultImageRender(tokens, idx, options, env, self)
    const altText = token.content ? md.utils.escapeHtml(token.content.trim()) : ''
    if (altText) {
      return `<figure class="md-image-figure">${imgHtml}<figcaption class="md-image-caption">${altText}</figcaption></figure>`
    }
    return imgHtml
  }

  // Mermaid fence：```mermaid → 图表占位（源码隐藏存放，未渲染前不裸露代码），
  // 与 src/lib/markdown/render 等模块做法一致；实际渲染由下方 renderMermaid() 完成
  const defaultFence = md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info ? token.info.trim() : ''
    const langName = info ? info.split(/\s+/g)[0] : ''
    if (langName === 'mermaid') {
      const content = token.content.trim()
      const escaped = md.utils.escapeHtml(content)
      return `<div class="mermaid"><div class="mermaid-src" style="display:none">${escaped}</div><div class="mermaid-ph"><i class="fa fa-picture-o"></i></div></div>`
    }
    return defaultFence(tokens, idx, options, env, self)
  }

  // 智能图片排版：根据图片数量和文本内容自动布局
  function processSlideLayout(html: string): string {
    const temp = document.createElement('div')
    temp.innerHTML = html

    // 查找所有 figure 图片（可能被 <p> 包裹，但 <figure> 在 <p> 内不合法，浏览器会隐式闭合 <p>）
    const allFigures = Array.from(temp.querySelectorAll<HTMLElement>('figure.md-image-figure'))
    if (allFigures.length === 0) return html

    // 收集所有顶层子节点，但排除因浏览器隐式闭合 <p> 产生的空 <p></p>
    const children = Array.from(temp.children).filter((child) => {
      // 跳过空 <p>（浏览器隐式闭合 <p> 产生）
      if (child.tagName === 'P' && child.children.length === 0 && !child.textContent?.trim()) {
        return false
      }
      return true
    })

    const imageBlocks: Element[] = []
    const textBlocks: Element[] = []

    for (const child of children) {
      // 检查当前元素是否为 figure，或其唯一子元素为 figure
      let figure: Element | null = null
      if (child.tagName === 'FIGURE' && child.classList.contains('md-image-figure')) {
        figure = child
      } else if (child.children.length === 1 &&
                 child.children[0].tagName === 'FIGURE' &&
                 child.children[0].classList.contains('md-image-figure')) {
        figure = child.children[0] as Element
      }

      if (figure) {
        imageBlocks.push(figure)
      } else {
        textBlocks.push(child)
      }
    }

    if (imageBlocks.length === 0) return html

    const result = document.createElement('div')
    result.className = 'slide-layout-wrapper'

    if (imageBlocks.length === 1 && textBlocks.length > 0) {
      // 一张图片 + 有文字 → 左文字右图片
      const row = document.createElement('div')
      row.className = 'slide-layout-row'

      const textCol = document.createElement('div')
      textCol.className = 'slide-layout-text'
      for (const tb of textBlocks) textCol.appendChild(tb.cloneNode(true))

      const imgCol = document.createElement('div')
      imgCol.className = 'slide-layout-image'
      imgCol.appendChild(imageBlocks[0].cloneNode(true))

      row.appendChild(textCol)
      row.appendChild(imgCol)
      result.appendChild(row)
    } else if (imageBlocks.length >= 2) {
      // 两张及以上图片 → 文字在上，图片在下并排
      for (const tb of textBlocks) result.appendChild(tb.cloneNode(true))

      const grid = document.createElement('div')
      grid.className = imageBlocks.length === 2 ? 'slide-layout-grid-2' : 'slide-layout-grid-n'
      for (const ib of imageBlocks) {
        const cell = document.createElement('div')
        cell.className = 'slide-layout-cell'
        cell.appendChild(ib.cloneNode(true))
        grid.appendChild(cell)
      }
      result.appendChild(grid)
    } else {
      // 仅一张图片无文字 → 直接居中
      result.appendChild(imageBlocks[0].cloneNode(true))
    }

    return result.innerHTML
  }

  // 幻灯片面包屑路径列表
  let slideBreadcrumbs = ref<string[]>([])
  // 树状导航数据
  let slideTree = ref<any[]>([])
  // 树状导航开关
  let navOpen = ref(false)
  // 展平的树节点列表（递归拍平，用于模板循环）
  const flatTree = computed(() => {
    const flatten = (nodes: any[]): any[] => {
      const result: any[] = []
      for (const node of nodes) {
        result.push(node)
        if (node.children && node.children.length > 0) {
          result.push(...flatten(node.children))
        }
      }
      return result
    }
    return flatten(slideTree.value)
  })
  let ratioMode = ref('auto') // 'auto' | '16:9' | '4:3'
  // 缩放比例（0.5 ~ 2.0）
  let zoomScale = ref(1)

  const changeRatio = (mode: string) => {
    ratioMode.value = mode
  }

  const zoomIn = () => {
    zoomScale.value = Math.min(2, +(zoomScale.value + 0.1).toFixed(1))
  }

  const zoomOut = () => {
    zoomScale.value = Math.max(0.5, +(zoomScale.value - 0.1).toFixed(1))
  }

  const zoomPercent = computed(() => Math.round(zoomScale.value * 100) + '%')
  // 翻页动画状态
  const prevIndex = ref(-1)
  const direction = ref('')
  const animating = ref(false)
  let animationTimer: ReturnType<typeof setTimeout> | null = null
  const ANIMATION_DURATION = 300
  // 主题配置
  const themes = [
    { id: 'default', labelZH: '默认', labelEN: 'Default' },
    { id: 'academic-blue', labelZH: '学术蓝', labelEN: 'Academic Blue' },
    { id: 'nature-green', labelZH: '自然绿', labelEN: 'Nature Green' },
    { id: 'ieee-dark', labelZH: 'IEEE 深色', labelEN: 'IEEE Dark' },
    { id: 'classic-gold', labelZH: '经典金', labelEN: 'Classic Gold' },
    { id: 'clean-white', labelZH: '洁净白', labelEN: 'Clean White' }
  ]
  const pptTheme = ref('default')
  const showThemeSettings = ref(false)

  const themeLabel = computed(() => {
    const t = themes.find(t => t.id === pptTheme.value)
    return store.locales === 'zh' ? t?.labelZH : t?.labelEN
  })

  const themePreviewStyle = (id: string) => {
    const colors: Record<string, { bg: string; text: string }> = {
      default: { bg: 'var(--backgroundColor)', text: 'var(--fontColor)' },
      'academic-blue': { bg: '#ffffff', text: '#1a3a5c' },
      'nature-green': { bg: '#fafaf8', text: '#2d4a2d' },
      'ieee-dark': { bg: '#1c2331', text: '#c8d0e0' },
      'classic-gold': { bg: '#f8f5f0', text: '#5c3a1a' },
      'clean-white': { bg: '#ffffff', text: '#2c2c2c' }
    }
    const c = colors[id] || colors.default
    return { background: c.bg, color: c.text }
  }

  // 总览网格开关
  let showOverview = ref(false)
  // 切分模式：'smart' = 智能切分（按标题/空行，保护代码块），'separator' = 仅按 --- 切分
  // 每页内容密度 -> 字号因子（内容多则缩小、只有几个字则放大，智能适配单页排版）
  let autoScales = ref<number[]>([])
  const calcAutoScale = (html: string, isCover: boolean): number => {
    if (isCover) return 1 // 封面页内部已有大标题排版，不额外缩放
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    const textLen = (tmp.textContent || '').replace(/\s+/g, '').length
    const blockCount = tmp.querySelectorAll('li, p, h1, h2, h3, h4, h5, h6, pre, table, blockquote, figure').length
    const score = textLen + blockCount * 8
    if (score <= 30) return 1.5   // 只有几个字 / 一句：放大
    if (score <= 80) return 1.2
    if (score <= 180) return 1.0
    // 内容多时向下压缩，但别一下压太狠（原为 0.82 / 0.68 / 0.56，实际字号会小到看不清）：
    // 分档更细、每档只降一点，最小 0.66；再不够小就靠下面的「字号保底」兜住。
    if (score <= 360) return 0.9
    if (score <= 650) return 0.8
    if (score <= 1000) return 0.72
    return 0.66
  }

  const splitMode = ref<'smart' | 'separator'>('smart')
  const splitModeLabel = computed(() => {
    return store.locales === 'zh'
      ? (splitMode.value === 'smart' ? '智能切分' : '---切分')
      : (splitMode.value === 'smart' ? 'Smart Split' : '--- Split')
  })
  /** 切换切分模式后重新初始化 */
  const toggleSplitMode = () => {
    splitMode.value = splitMode.value === 'smart' ? 'separator' : 'smart'
    init()
    showIndex.value = 0
    nextTick(() => {
      renderMermaid()
    })
  }

  // 全屏
  const toggleFullscreen = () => {
    const el = document.querySelector('.ppt-container') as HTMLElement
    const after = () => setTimeout(() => refreshViewScale(), 60)
    if (!document.fullscreenElement) {
      el?.requestFullscreen?.()?.then?.(after)?.catch?.(() => {})
    } else {
      document.exitFullscreen?.()?.then?.(after)?.catch?.(() => {})
    }
  }

  // 当前幻灯片根元素引用
  const pptContainerRef = ref<HTMLElement | null>(null)

  // ===== 主题选择面板定位（锚在主题齿轮按钮正上方，不再固定在窗口最右侧）=====
  const themeBtnRef = ref<HTMLElement | null>(null)
  const themePanelStyle = ref<Record<string, string>>({})
  const THEME_PANEL_WIDTH = 300
  /** 计算面板位置：水平对齐按钮左缘（并夹在容器内），垂直贴在按钮上方 8px */
  const updateThemePanelPos = () => {
    const btn = themeBtnRef.value
    const root = pptContainerRef.value
    if (!btn || !root) return
    const rRect = root.getBoundingClientRect()
    const bRect = btn.getBoundingClientRect()
    const left = Math.max(8, Math.min(bRect.left - rRect.left, rRect.width - THEME_PANEL_WIDTH - 8))
    themePanelStyle.value = {
      left: `${Math.round(left)}px`,
      bottom: `${Math.round(rRect.bottom - bRect.top + 8)}px`,
    }
  }
  const toggleThemeSettings = () => {
    showThemeSettings.value = !showThemeSettings.value
    if (showThemeSettings.value) nextTick(() => updateThemePanelPos())
  }
  /** 全屏切换后布局尺寸变化，面板需要重新贴回按钮上方 */
  const repositionThemePanel = () => {
    if (showThemeSettings.value) setTimeout(() => updateThemePanelPos(), 80)
  }

  // 窗口/容器自适应系数：字号因子随可用区域缩放（与手动 zoomScale 相乘）。
  // 以宽 1300px / 高 820px 为基准 1.0，窗口放大则字放大、缩小则字缩小。
  const viewScale = ref(1)
  const refreshViewScale = () => {
    nextTick(() => {
      const root = pptContainerRef.value
      if (!root) { viewScale.value = 1; return }
      const wrapper = root.querySelector<HTMLElement>('.slide-wrapper')
      const el = (wrapper && wrapper.clientWidth) ? wrapper : root
      const w = el.clientWidth || root.clientWidth
      const h = el.clientHeight || root.clientHeight
      const s = Math.min(w / 1300, h / 820)
      // 窗口变小不再把字压到 0.55（那是「压缩太多」的主因），下限抬到 0.72
      viewScale.value = Math.min(1.6, Math.max(0.72, s))
      // 幻灯片 em 基准（.slide 的内联 font-size 就是相对它算的）——字号保底要用
      const base = parseFloat(getComputedStyle(root).fontSize) || 0
      emBasePx.value = Number.isFinite(base) && base > 0 ? base : 16
    })
  }

  /**
   * 单页字号保底：内容很多 / 窗口很小时，上面的系数可能把正文压到看不清。
   * 这里保证「幻灯片基准字号」不低于 MIN_SLIDE_FONT_PX（标题等相对字号仍按原比例放大）。
   */
  const MIN_SLIDE_FONT_PX = 12
  const emBasePx = ref(16)
  /** 主幻灯片字号（em，含保底）；index 允许 string（v-for 索引在 any[] 上是 string | number） */
  const slideFontEm = (index: number | string) => {
    const raw = 1.4 * zoomScale.value * viewScale.value * (autoScales.value[Number(index)] || 1)
    const minEm = MIN_SLIDE_FONT_PX / (emBasePx.value || 16)
    return Math.max(raw, minEm)
  }
  /** 总览缩略图字号（固定 0.5 倍，不加保底——缩略图本来就该小） */
  const overviewFontEm = (index: number | string) =>
    0.5 * 1.4 * zoomScale.value * viewScale.value * (autoScales.value[Number(index)] || 1)
  let viewResizeObserver: ResizeObserver | null = null
  // 布局变化（目录/总览/比例）时刷新容器系数
  watch([navOpen, showOverview, ratioMode], () => refreshViewScale())

  // 监听翻页，滑动动画
  watch(showIndex, (newVal, oldVal) => {
    if (oldVal === undefined || oldVal < 0) return
    prevIndex.value = oldVal
    direction.value = newVal > oldVal ? 'right' : 'left'
    animating.value = true
    if (animationTimer) clearTimeout(animationTimer)
    animationTimer = setTimeout(() => {
      animating.value = false
    }, ANIMATION_DURATION)
  })

  // 获取当前幻灯片中可滚动的容器（在组件根元素范围内查找）
  const getScrollContainer = (): HTMLElement | null => {
    const root = pptContainerRef.value
    if (!root) return null
    // 排除总览网格中的 .overview-slide-real，只找主幻灯片的 .slide
    const slide = root.querySelector('.slide:not(.overview-slide-real)') as HTMLElement | null
    if (!slide) return null
    // 真正滚动的是 .slide-body（.slide 自身高度固定 100%，内容溢出由 body 承担）；没有则退回 .slide
    return (slide.querySelector(':scope > .slide-body') as HTMLElement | null) || slide
  }

  // ===== 滚轮翻页：单页内已滚到顶/底后，继续同方向滚动 → 上一页 / 下一页 =====
  const WHEEL_TURN_PX = 90    // 累积位移阈值（已按 deltaMode 归一化）
  const WHEEL_LOCK_MS = 320   // 翻页后的短暂锁定，避免一次惯性滚动连翻多页
  let wheelAccum = 0
  let wheelLockUntil = 0
  /** 归一化滚轮位移：行模式/页模式换算为像素 */
  const normalizeWheel = (e: WheelEvent) =>
    e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
  const handleWheel = (e: WheelEvent) => {
    if (showOverview.value || animating.value) { wheelAccum = 0; return }
    // 目录 / 主题面板内的滚动不参与翻页
    const target = e.target as HTMLElement | null
    if (target?.closest('.nav-panel, .theme-settings, .overview-grid')) { wheelAccum = 0; return }
    const el = getScrollContainer()
    if (!el) return
    const dy = normalizeWheel(e)
    if (!dy) return
    const scrollable = el.scrollHeight - el.clientHeight > 2
    const atTop = !scrollable || el.scrollTop <= 1
    const atBottom = !scrollable || el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    // 本页内还能滚 → 交给浏览器，并清掉累积
    if (!((dy > 0 && atBottom) || (dy < 0 && atTop))) { wheelAccum = 0; return }
    const now = Date.now()
    if (now < wheelLockUntil) { e.preventDefault(); return }
    // 方向改变则重新累积
    if (dy > 0 !== wheelAccum > 0) wheelAccum = 0
    wheelAccum += dy
    if (Math.abs(wheelAccum) < WHEEL_TURN_PX) { e.preventDefault(); return }
    const dir = wheelAccum > 0 ? 1 : -1
    wheelAccum = 0
    wheelLockUntil = now + WHEEL_LOCK_MS
    e.preventDefault()
    const next = showIndex.value + dir
    if (next < 0 || next > prepList.value.length - 1) return
    showIndex.value = next
  }

  // 键盘控制：上下键滚动当前页，左右键翻页
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      showIndex.value = Math.max(0, showIndex.value - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      showIndex.value = Math.min(prepList.value.length - 1, showIndex.value + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const el = getScrollContainer()
      if (el) el.scrollTop -= 60
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const el = getScrollContainer()
      if (el) el.scrollTop += 60
    }
  }

  // 构建树状导航数据
  const buildTree = (headings: { level: number; text: string; slideIndex: number }[]) => {
    const root: any[] = []
    const stack: any[] = []
    for (const h of headings) {
      const node = { ...h, children: [] }
      while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
        stack.pop()
      }
      if (stack.length === 0) {
        root.push(node)
      } else {
        stack[stack.length - 1].children.push(node)
      }
      stack.push(node)
    }
    return root
  }

  /** 检查文本中指定位置是否在代码块内部（支持 ``` 和 ~~~ 围栏代码块） */
  function isInsideCodeBlock(text: string, start: number, end: number): boolean {
    // 逐行扫描，用状态机追踪围栏代码块的开关
    const before = text.substring(0, Math.max(start, end))
    const lines = before.split('\n')
    let inCodeBlock = false
    for (const line of lines) {
      // 围栏代码块：以 ``` 或 ~~~ 开头（允许后面跟语言标识）
      if (/^\s*(```|~~~)/.test(line.trim())) {
        inCodeBlock = !inCodeBlock
      }
    }
    return inCodeBlock
  }

  /** 分割字符串，但跳过代码块内部的分割点 */
  function splitSkippingCodeBlocks(text: string, pattern: RegExp): string[] {
    const parts: string[] = []
    let lastIndex = 0
    const regex = new RegExp(pattern.source, 'g')
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const splitPos = match.index
      const matchLen = match[0].length
      // 零宽匹配（如前瞻断言）须强制推进，否则死循环
      if (matchLen === 0) {
        regex.lastIndex = splitPos + 1
      }
      const endPos = matchLen > 0 ? splitPos + matchLen : splitPos
      if (!isInsideCodeBlock(text, splitPos, endPos)) {
        parts.push(text.substring(lastIndex, splitPos))
        lastIndex = endPos
      }
    }
    parts.push(text.substring(lastIndex))
    return parts
  }

  // 切分幻灯片
  function splitSections(raw: string, maxLines: number): string[] {
    if (splitMode.value === 'separator') {
      // ---切分：仅按 --- 分隔，保护代码块
      const parts = splitSkippingCodeBlocks(raw, /(?:^|\n)\s*---\s*(?:\n|$)/)
      return parts.map(s => s.trim()).filter(s => s.length > 0)
    }

    // 智能切分：先按 --- 分隔（保护代码块），过长的段再按标题/空行二次切分（也保护代码块）
    const initial = splitSkippingCodeBlocks(raw, /(?:^|\n)\s*---\s*(?:\n|$)/)
      .map(s => s.trim()).filter(s => s.length > 0)

    const result: string[] = []
    for (const section of initial) {
      const lineCount = section.split('\n').filter(l => l.trim()).length
      if (lineCount > maxLines) {
        // 过长：按标题或空行二次切分，保护代码块不被切断
        const subs = splitSkippingCodeBlocks(section, /\n{3,}|(?=\n#{1,6}\s)/)
          .map(s => s.trim())
          .filter(s => s.length > 0)
        result.push(...subs)
      } else {
        result.push(section)
      }
    }
    return result
  }

  // 标题页增强：只有标题无内容的页，自动列出下一级子标题
  function enrichHeadingOnlySlides(sections: string[]): string[] {
    const result: string[] = []
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]
      const lines = section.trim().split('\n')
      const headingMatch = lines[0]?.match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        const level = headingMatch[1].length
        const hasBody = lines.slice(1).some(l => l.trim() && !l.trim().startsWith('#'))
        if (!hasBody) {
          // 仅标题：从后续段落收集下一级标题
          const subs: string[] = []
          for (let j = i + 1; j < sections.length; j++) {
            const nl = sections[j].trim().split('\n')
            const nm = nl[0]?.match(/^(#{1,6})\s+(.+)$/)
            if (!nm) continue
            const nlv = nm[1].length
            if (nlv <= level) break
            if (nlv === level + 1) subs.push(nm[2].trim())
          }
          if (subs.length > 0) {
            result.push(section + '\n\n' + subs.map(s => '- ' + s).join('\n'))
            continue
          }
        }
      }
      result.push(section)
    }
    return result
  }

  /** 预处理 LaTeX：统一沿用共享实现（`@/lib/markdown/render` 的 preprocessMath）
   *  —— 各处自建副本曾因 replace 替换串里的 `$$` 转义把块级公式降级成行内公式 */
  const preprocessMath = sharedPreprocessMath

  // 演示来源（当前激活标签的 路径+内容），用于内容变化去重：同一内容不重复重建
  const currentSourceKey = () => {
    const cur = store.data[store.index]
    return cur ? (cur.path || '') + '\u0000' + String(cur.content ?? '') : ''
  }
  // 最近一次构建所用的来源（供 refreshPpt / init 判断内容是否真的变化）
  let lastRenderedSourceKey = ''

  // 从原始 markdown 解析标题并构建面包屑
  const init=async function(){
    prepList.value=[]
    slideBreadcrumbs.value=[]
    autoScales.value=[]
    slideTree.value=[]
    data=store.data[store.index]
    if(data.content==undefined) data.content=""
    if(data.extension==".md"||data.extension==""){
      // 去除 YAML frontmatter，避免内容页显示元信息
      const content = data.content.replace(/^\s*---[\s\S]*?---\s*\n?/, '')
      // 切分幻灯片：先按 --- 分隔，过长的段再按原规则二次切分
      const MAX_SLIDE_LINES = 18
      let sections = splitSections(content, MAX_SLIDE_LINES)
      // 标题页增强：纯标题页自动列出下一级子标题
      sections = enrichHeadingOnlySlides(sections)

      // 生成封面页（取文件元数据中的标题和关键词）
      const meta = data.attributes || {}
      const titleText = (meta.title || data.label || '').replace(/\.md$/i, '')
      const keywordsText = meta.keywords || meta.tags || ''
      const summaryText = meta.summary || ''
      // 封面元信息：过长的直接忽略（如摘要/说明等很长的字段），避免首页被长文本撑爆
      const COVER_TEXT_MAX = 120 // 字符数上限，超过则忽略该元信息
      const isTooLong = (s: unknown) => String(s ?? '').length > COVER_TEXT_MAX
      if (titleText) {
        // 关键词：数量过多或总长过长时忽略
        const kwArr = (Array.isArray(keywordsText) ? keywordsText : String(keywordsText || '').split(/[,，、]/))
          .map((s: string) => s.trim()).filter(Boolean)
        const kwHtml = kwArr.length && kwArr.length <= 8 && !isTooLong(kwArr.join(''))
          ? kwArr.map((k: string) => `<span class="cover-keyword">${md.utils.escapeHtml(k)}</span>`).join('') : ''
        const summaryHtml = (!summaryText || isTooLong(summaryText))
          ? '' : `<div class="cover-summary">${md.utils.escapeHtml(String(summaryText))}</div>`
        // 收集其他字段（排除已显示的），在底部显示；过长字段直接忽略
        const excludeFields = ['title', 'keywords', 'tags', 'summary']
        const otherFieldsHtml = Object.entries(meta)
          .filter(([k]) => !excludeFields.includes(k))
          .map(([k, v]) => {
            const val = Array.isArray(v) ? v.join(', ') : String(v)
            if (!val || isTooLong(val)) return ''
            return `<span class="cover-field"><span class="cover-field-key">${md.utils.escapeHtml(k)}</span><span class="cover-field-val">${md.utils.escapeHtml(val)}</span></span>`
          })
          .filter(Boolean)
          .join('')
        // 构建封面 HTML
        const coverHtml = `<div class="slide-layout-wrapper" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
          <h1 class="cover-title">${md.utils.escapeHtml(titleText)}</h1>
          ${kwHtml ? `<div class="cover-keywords">${kwHtml}</div>` : ''}
          ${summaryHtml}
          ${otherFieldsHtml ? `<div class="cover-fields">${otherFieldsHtml}</div>` : ''}
        </div>`
        prepList.value.push(coverHtml)
        slideBreadcrumbs.value.push('')
        autoScales.value.push(1) // 封面页内部已有大标题排版，不额外缩放
      }

      // 标题层级栈
      const headingStack: { level: number; text: string }[] = []
      // 收集所有标题以备构建树
      const allHeadings: { level: number; text: string; slideIndex: number }[] = []

      // 设置图片相对路径的基目录
      if (data.path) {
        const normalizedPath = data.path.replace(/\\/g, '/')
        const lastSlash = normalizedPath.lastIndexOf('/')
        mdBasePath = lastSlash >= 0 ? normalizedPath.substring(0, lastSlash + 1) : ''
      } else {
        mdBasePath = ''
      }

      for (const section of sections) {
        let renderedContent = md.render(preprocessMath(section))
        if (renderedContent === '') continue
        // 后处理：为 Python 代码块包裹可运行容器（data-lang 由 highlight 函数注入）
        // 用数据属性 data-code-base64 存储编码后的代码，避免 HTML 实体冲突
        renderedContent = renderedContent.replace(
          /<pre class="hljs[^"]* scoll" data-lang="python"><code>([\s\S]*?)<\/code><\/pre>/gi,
          (_match: string, codeContent: string) => {
            // 解码 HTML 实体并去除语法高亮的 span 标签，提取纯文本代码
            const decoded = codeContent
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&#x27;/g, "'")
              .replace(/&apos;/g, "'")
              .replace(/<[^>]+>/g, '') // 去除所有 HTML 标签
            const encoded = btoa(unescape(encodeURIComponent(decoded)))
            return `<div class="python-block-wrapper"><pre class="hljs scoll" data-lang="python"><code>${codeContent}</code></pre><div class="python-run-bar"><button class="python-run-btn" type="button" data-code="${encoded}"><i class="fa fa-play"></i> ${store.locales=='zh'?'运行 Python':'Run Python'}</button></div><div class="python-result" style="display:none"></div></div>`
          }
        )
        // 应用智能图片排版
        renderedContent = processSlideLayout(renderedContent)

        // 从原始文本第一行提取标题
        const firstLine = section.split('\n')[0].trim()
        const headingMatch = firstLine.match(/^(#{1,6})\s+(.+)$/)

        if (headingMatch) {
          const level = headingMatch[1].length
          const text = headingMatch[2].trim()

          // 弹出比当前级别更深或同级的标题
          while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
            headingStack.pop()
          }
          headingStack.push({ level, text })
          allHeadings.push({ level, text, slideIndex: prepList.value.length })
        }

        // 面包屑路径，直接用标题文本
        const breadcrumb = headingStack.map(h => h.text).join(' / ')

        prepList.value.push(renderedContent)
        slideBreadcrumbs.value.push(breadcrumb)
        autoScales.value.push(calcAutoScale(renderedContent, false)) // 按该页内容密度设置字号因子
        // debug: 检查当前幻灯片是否包含 mermaid
        if (renderedContent.includes('mermaid')) {
          console.log('[PPT] slide包含mermaid, 前80字符:', renderedContent.substring(0, 80))
        }
      }

      slideTree.value = buildTree(allHeadings)
    }
    // 记录本次构建来源（路径+内容），供 refreshPpt 去重
    lastRenderedSourceKey = currentSourceKey()
  }
  // Mermaid 源文本规范化已迁移至 '@/lib/markdown/mermaid-normalize'（顶部 import 的 normalizeMermaidSource）

  // ===== Python 代码运行（事件委托） =====
  const handlePythonRunClick = async (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.python-run-btn') as HTMLElement | null
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const wrapper = btn.closest('.python-block-wrapper') as HTMLElement | null
    if (!wrapper) return
    const resultEl = wrapper.querySelector<HTMLElement>('.python-result')
    if (!resultEl) return
    // 从 data-code 属性获取 Base64 编码的代码
    const encoded = btn.getAttribute('data-code') || ''
    let code = ''
    try {
      code = decodeURIComponent(escape(atob(encoded)))
    } catch { return }

    resultEl.style.display = 'block'
    resultEl.innerHTML = `<div class="python-result-loading"><i class="fa fa-spinner fa-spin"></i> ${store.locales=='zh'?'执行中...':'Running...'}</div>`
    try {
      const environment = store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe') || 'safe'
      const res = await window.ipcRenderer.invoke('executePython', { code, environment, input: '' })
      if (res.success) {
        const output = res.output?.trim() || res.result?.trim() || ''
        resultEl.innerHTML = output
          ? `<pre class="python-result-output">${md.utils.escapeHtml(output)}</pre>`
          : `<div class="python-result-empty">${store.locales=='zh'?'执行成功（无输出）':'Success (no output)'}</div>`
        if (res.executionTime) {
          resultEl.innerHTML += `<div class="python-result-time">⏱ ${(res.executionTime / 1000).toFixed(2)}s</div>`
        }
      } else {
        const err = res.error || res.output || '执行失败'
        resultEl.innerHTML = `<pre class="python-result-error">${md.utils.escapeHtml(err)}</pre>`
      }
    } catch (err: any) {
      resultEl.innerHTML = `<pre class="python-result-error">${md.utils.escapeHtml(err.message || String(err))}</pre>`
    }
  }

  // 将 Python 运行事件绑定到幻灯片容器
  const attachPythonRunHandler = () => {
    const container = pptContainerRef.value
    if (!container) return
    // 移除旧监听避免重复
    container.removeEventListener('click', handlePythonRunClick as any)
    container.addEventListener('click', handlePythonRunClick as any)
  }

  const mermaidViewerRef = ref<InstanceType<typeof MermaidViewer> | null>(null)
  let mermaidIdCounter = 0
  // 已渲染图的 SVG 缓存（同一份源码不重复 render，翻页/回退时瞬时恢复）
  const mermaidSvgCache = new Map<string, string>()
  // 渲染当前可见页面中所有 Mermaid 图表（render API；slide 用 v-if 每次进入都需重渲）
  const renderMermaid = async () => {
    await nextTick()
    const container = pptContainerRef.value
    if (!container) return
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('.mermaid:not([data-processed])'))
    if (!nodes.length) return
    for (const node of nodes) {
      // 源码优先取隐藏的 .mermaid-src（fence 规则产出）；兼容旧结构回退取 textContent
      const srcEl = node.querySelector<HTMLElement>('.mermaid-src')
      const rawText = (srcEl ? srcEl.textContent : node.textContent)?.trim()
      if (!rawText) { node.setAttribute('data-processed', 'true'); continue }
      const normalizedText = normalizeMermaidSource(rawText)
      try {
        node.setAttribute('data-processed', 'true')
        let svg = mermaidSvgCache.get(normalizedText)
        if (!svg) {
          const id = 'ppt-mermaid-' + (++mermaidIdCounter)
          const rendered = await mermaid.render(id, normalizedText)
          svg = rendered.svg
          mermaidSvgCache.set(normalizedText, svg)
        }
        node.innerHTML = svg
        // 用 viewBox 给 svg 固有尺寸，并去掉 mermaid 写的 width="100%"/内联 max-width：
        // 否则 svg 恒等于容器宽度，限高后四周会空出一大块（尤其窄高图）。
        const svgEl = node.querySelector('svg')
        if (svgEl) {
          const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
          if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            svgEl.setAttribute('width', String(vb[2]))
            svgEl.setAttribute('height', String(vb[3]))
          }
          svgEl.removeAttribute('style')
          svgEl.style.width = 'auto'
          svgEl.style.height = 'auto'
        }
        // 复用 MermaidViewer：图右上 hover 显示查看图标，点击打开大图（缩放/平移/导出）
        node.classList.add('mermaid-clickable')
        if (mermaidViewerRef.value && !(node as any)._mmBound) {
          ;(node as any)._mmBound = true
          const viewer = mermaidViewerRef.value
          node.addEventListener('click', (ev: MouseEvent) => {
            ev.stopPropagation()
            viewer?.open({ svg, title: rawText.split('\n')[0]?.substring(0, 50) || 'Mermaid 图表' })
          })
        }
      } catch (error) {
        console.error('Mermaid render failed:', error)
        // 已标记 data-processed 防重复尝试；只显示错误占位，不把源码裸露出来
        node.innerHTML = `<div class="mermaid-ph mermaid-err"><i class="fa fa-exclamation-triangle"></i></div>`
      }
    }
  }

  // 翻页 / 从总览切回后：slide 用 v-if 每次都会重建，需对当前页重新渲染 mermaid
  watch(showIndex, () => { void nextTick(() => { void renderMermaid() }) })
  watch(showOverview, (ov: boolean) => { if (!ov) void nextTick(() => { void renderMermaid() }) })

  /** 统一刷新入口：来源（路径/内容）真的变化才重建演示（保留当前页码）。
   *  由 标签切换 / 内容变化监听 / 外部文件变更 共用，天然去重。 */
  const refreshPpt = async () => {
    if (!store.data[store.index]) return
    if (currentSourceKey() === lastRenderedSourceKey) return
    const prevIndex = showIndex.value
    await init()
    showIndex.value = Math.max(0, Math.min(prepList.value.length - 1, prevIndex))
    await nextTick()
    renderMermaid()
    attachPythonRunHandler()
  }

  // 监听激活标签切换 或 内容变化：
  //  - 同窗口 编辑/块编辑 保存（内容写入 store）后实时刷新演示
  //  - 其他窗口保存后经广播同步到 store，同样实时刷新
  watch(
    [() => store.data[store.index], () => store.data[store.index]?.content],
    () => { void refreshPpt() }
  )

  // 文件变更自动刷新（外部工具/磁盘直接改动：主进程 fs 监听通知，主窗口收到）
  const handleFileChanged = async (_event: any, { path: changedPath }: { path: string }) => {
    const curPath = store.data[store.index]?.path
    if (!curPath || curPath !== changedPath) return
    // 重新读取文件内容并同步到 store —— 上方内容监听（refreshPpt）据此重建；内容未变则自动跳过
    const newContent = await window.ipcRenderer.invoke('readFile', curPath)
    if (store.data[store.index] && store.data[store.index].content !== newContent) {
      store.data[store.index].content = newContent
    }
  }

  onMounted(async ()=>{
    await init()
    nextTick(() => {
      renderMermaid()
      attachPythonRunHandler()
    })
    // 容器尺寸自适应（跟随窗口缩放字号）
    refreshViewScale()
    viewResizeObserver = new ResizeObserver(() => {
      refreshViewScale()
      if (showThemeSettings.value) updateThemePanelPos()
    })
    if (pptContainerRef.value) viewResizeObserver.observe(pptContainerRef.value)
    window.addEventListener('keydown', handleKeydown)
    document.addEventListener('fullscreenchange', repositionThemePanel)
    // 监听文件变更
    window.ipcRenderer.on('watchedFileChanged', handleFileChanged)
    // 启动文件监听
    const curPath = store.data[store.index]?.path
    if (curPath) {
      window.ipcRenderer.invoke('watchFile', curPath)
    }
  })

  onBeforeUnmount(() => {
    if (viewResizeObserver) { viewResizeObserver.disconnect(); viewResizeObserver = null }
    window.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('fullscreenchange', repositionThemePanel)
    // 移除文件监听
    window.ipcRenderer.off('watchedFileChanged', handleFileChanged)
    window.ipcRenderer.invoke('unwatchFile')
    if (timeInterval) clearInterval(timeInterval)
  })
</script>

<template >
  <div class="ppt-container" ref="pptContainerRef" :data-theme="pptTheme" @wheel="handleWheel">
    <!-- 总览网格 -->
    <div v-if="showOverview" class="overview-grid scoll">
      <div v-for="(item, index) in prepList" :key="index" class="overview-item" @click="showIndex = +index; showOverview = false">
        <div class="overview-slide" :class="'ratio-' + ratioMode">
          <div class="slide overview-slide-real" :style="{ fontSize: overviewFontEm(index) + 'em' }">
            <div v-if="slideBreadcrumbs[Number(index)]" class="slide-breadcrumb">{{ slideBreadcrumbs[Number(index)] }}</div>
            <div v-html="item"></div>
          </div>
          <div class="overview-index">{{ Number(index) + 1 }}</div>
        </div>
      </div>
    </div>

    <!-- 幻灯片卡片 -->
    <div v-if="!showOverview" class="slide-wrapper" :class="'ratio-' + ratioMode" :style="{ left: navOpen ? '260px' : '20px' }">
      <div class="slide-container" :class="{ 'fs-container': ratioMode !== 'auto' }">
        <div v-for="(item, index) in prepList" :key="index">
          <div v-if="showIndex===index || (animating && index === prevIndex)" class="slide scoll"
               :class="{
                 'slide-in-left': animating && index === showIndex && direction === 'left',
                 'slide-in-right': animating && index === showIndex && direction === 'right',
                 'slide-out-left': animating && index === prevIndex && direction === 'right',
                 'slide-out-right': animating && index === prevIndex && direction === 'left',
                 'slide-animating': animating && (index === showIndex || index === prevIndex)
               }"
               :style="{ fontSize: slideFontEm(index) + 'em' }">
            <!-- 面包屑导航 + 文件名 -->
            <div v-if="slideBreadcrumbs[Number(index)]" class="slide-breadcrumb">
              <span class="breadcrumb-text">{{ slideBreadcrumbs[Number(index)] }}</span>
              <span class="breadcrumb-filename">{{ (data?.label || '').replace(/\.md$/i, '') }}</span>
            </div>
            <div class="slide-body scoll" v-html="item"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 树状导航面板 -->
    <div v-if="navOpen" class="nav-panel">
      <div class="nav-panel-header">
        <span>{{store.locales=='zh'?'目录':'Outline'}}</span>
        <button class="nav-panel-close" @click="navOpen=false">&times;</button>
      </div>
      <div class="nav-panel-body scoll">
        <template v-for="(node, idx) in flatTree" :key="idx">
          <div class="tree-node" :style="{ paddingLeft: (node.level - 1) * 16 + 8 + 'px' }"
               :class="{ 'tree-active': showIndex === node.slideIndex }"
               @click="showIndex = +node.slideIndex">
            <span class="tree-dot"></span>
            <span class="tree-text">{{ node.text }}</span>
          </div>
        </template>
        <div v-if="flatTree.length === 0" class="nav-panel-empty">{{store.locales=='zh'?'暂无标题':'No headings'}}</div>
      </div>
    </div>

    <!-- 底部工具栏（左：操作按钮 / 右：状态元素） -->
    <div class="toolbar">
      <div class="toolbar-inner">
        <!-- ===== 左侧：操作按钮 ===== -->
        <div class="tb-left">
          <!-- 树状导航切换 -->
          <button class="tool-btn tool-btn-icon" @click="navOpen = !navOpen" :class="{ active: navOpen }" :title="store.locales=='zh'?'目录':'Outline'">
            <i class="fa fa-list-ul"></i>
          </button>

          <!-- 总览切换 -->
          <button class="tool-btn tool-btn-icon" @click="showOverview = !showOverview" :class="{ active: showOverview }" :title="store.locales=='zh'?'总览':'Overview'">
            <i class="fa fa-th"></i>
          </button>

          <button class="tool-btn tool-btn-icon" @click="toggleFullscreen" title="全屏">
            <i class="fa fa-arrows-alt"></i>
          </button>

          <span class="toolbar-sep"></span>

          <!-- 比例选择 -->
          <button class="tool-btn" :class="{ active: ratioMode === 'auto' }" @click="changeRatio('auto')" title="自动">自适应</button>
          <button class="tool-btn" :class="{ active: ratioMode === '16:9' }" @click="changeRatio('16:9')" title="16:9">16:9</button>
          <button class="tool-btn" :class="{ active: ratioMode === '4:3' }" @click="changeRatio('4:3')" title="4:3">4:3</button>

          <span class="toolbar-sep"></span>

          <!-- 上一页 / 下一页 -->
          <button class="nav-btn" @click="showIndex=Math.max(0,showIndex-1)" :disabled="showIndex===0">
            <i class="fa fa-chevron-left"></i>
          </button>
          <button class="nav-btn" @click="showIndex=Math.min(prepList.length-1,showIndex+1)" :disabled="showIndex===prepList.length-1">
            <i class="fa fa-chevron-right"></i>
          </button>

          <span class="toolbar-sep"></span>

          <!-- 切分模式切换 -->
          <button class="tool-btn" @click="toggleSplitMode" :title="store.locales=='zh'?'切换切分方式':'Toggle split mode'">
            {{ splitModeLabel }}
          </button>

          <!-- 主题设置 -->
          <button ref="themeBtnRef" class="tool-btn tool-btn-icon" @click="toggleThemeSettings" :class="{ active: showThemeSettings }" :title="store.locales=='zh'?'主题':'Theme'">
            <i class="fa fa-cog"></i>
          </button>
        </div>

        <!-- ===== 右侧：状态元素 ===== -->
        <div class="tb-right">
          <!-- 缩放（状态 + 微调） -->
          <button class="tool-btn zoom-btn" @click="zoomOut" :disabled="zoomScale <= 0.5" title="缩小">
            <i class="fa fa-minus"></i>
          </button>
          <span class="zoom-label">{{ zoomPercent }}</span>
          <button class="tool-btn zoom-btn" @click="zoomIn" :disabled="zoomScale >= 2" title="放大">
            <i class="fa fa-plus"></i>
          </button>

          <span class="toolbar-sep"></span>

          <!-- 页码 -->
          <span class="slide-indicator">
            <span class="slide-current">{{showIndex+1}}</span>
            <span class="slide-separator">/</span>
            <span class="slide-total">{{prepList.length}}</span>
          </span>

          <span class="toolbar-sep"></span>

          <!-- 时间 -->
          <span class="tb-time"><i class="fa fa-clock-o"></i> {{ currentTime }}</span>
        </div>
      </div>
    </div>

    <!-- 主题设置面板（定位在主题齿轮按钮正上方，位置由 updateThemePanelPos 计算） -->
    <div v-if="showThemeSettings" class="theme-settings" :style="themePanelStyle">
      <div class="theme-settings-header">
        <span>{{ store.locales == 'zh' ? '选择主题' : 'Select Theme' }}</span>
        <button class="theme-close" @click="showThemeSettings = false">&times;</button>
      </div>
      <div class="theme-list">
        <div v-for="t in themes" :key="t.id" class="theme-cell" @click="pptTheme = t.id">
          <div class="theme-item" :class="{ active: pptTheme === t.id }" :style="themePreviewStyle(t.id)">
            <div class="theme-preview">
              <div class="theme-preview-text">Aa</div>
            </div>
          </div>
          <span class="theme-name">{{ store.locales == 'zh' ? t.labelZH : t.labelEN }}</span>
        </div>
      </div>
    </div>

    <!-- 进度条 -->
    <div class="progress-bar">
      <div class="progress-fill" :style="{width: prepList.length > 1 ? (showIndex/(prepList.length-1)*100)+'%' : '0%'}"></div>
    </div>
    <!-- Mermaid 图查看（放大/平移/导出，复用共享组件） -->
    <MermaidViewer ref="mermaidViewerRef" />
  </div>
</template>

<style scoped>
  .ppt-container {
    width: 100%;
    height: 100%;
    position: relative;
    margin: 0;
    display: flex;
    flex: 1;
    background: var(--backgroundColor);
    overflow: hidden;
  }

  /* 树状导航面板 */
  .nav-panel {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 26px;
    width: 240px;
    background: var(--backgroundColor);
    border-right: 1px solid var(--borderColor);
    z-index: 20;
    display: flex;
    flex-direction: column;
  }
  .nav-panel-header {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--borderColor);
    background: var(--menuColor);
    font-weight: 600;
    font-size: 14px;
  }
  .nav-panel-header span {
    flex: 1;
  }
  .nav-panel-close {
    width: auto;
    padding: 0 6px;
    font-size: 18px;
    line-height: 1;
    background: none;
    border: none;
    color: var(--fontColor);
    cursor: pointer;
  }
  .nav-panel-close:hover {
    opacity: 0.7;
  }
  .nav-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    border-bottom: 1px solid var(--borderColor);
  }
  .nav-panel-empty {
    padding: 16px;
    color: var(--borderColor);
    font-size: 13px;
    text-align: center;
  }
  .tree-node {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    cursor: pointer;
    font-size: 13px;
    color: var(--fontColor);
    opacity: 0.7;
    transition: all 0.15s ease;
    user-select: none;
  }
  .tree-node:hover {
    opacity: 1;
    background: var(--menuColor);
  }
  .tree-node.tree-active {
    opacity: 1;
    background: var(--menuColor);
    color: var(--fontActiveColor);
  }
  .tree-node.tree-active .tree-dot {
    background: var(--fontActiveColor);
  }
  .tree-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--borderColor);
    flex-shrink: 0;
  }
  .tree-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 幻灯片容器 */
  .slide-wrapper {
    position: absolute;
    top: 20px;
    left: 20px;
    right: 20px;
    bottom: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* 总览网格 */
  .overview-grid {
    position: absolute;
    top: 10px;
    left: 10px;
    right: 10px;
    bottom: 40px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px 20px;
    padding: 10px 20px;
    overflow-y: auto;
    align-content: flex-start;
    justify-content: center;
  }
  .overview-item {
    flex: 0 0 300px; /* 固定宽度 */
    max-height: 300px; /* 固定最大高度 */
    cursor: pointer;
    border: 2px solid transparent;
    border-radius: 8px;
    transition: border-color 0.2s ease, transform 0.15s ease;
    background: var(--backgroundColor);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    overflow: hidden;
    /* 🔧 关键修复：确保网格项不溢出 */
    min-height: 0;
    /* 🔧 可选：限制最大高度防止过长撑坏布局 */
    max-height: 400px;
  }
  .overview-item:hover {
    border-color: var(--fontActiveColor);
    transform: translateY(-3px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  }
  .overview-slide {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
    /* 🔧 确保内容不溢出 */
    height: 100%;
  }
  .overview-slide.ratio-16\:9 {
    aspect-ratio: 16 / 9;
  }
  .overview-slide.ratio-4\:3 {
    aspect-ratio: 4 / 3;
  }
  /* 总览中复用的 .slide 类，等比例缩小 */
  .overview-slide-real {
    position: absolute;
    top: 0;
    left: 0;
    width: 100% !important;
    height: 100% !important;
    padding: 5% 6% !important;
    margin: 0 !important;
    border: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    display: flex;
    flex-direction: column;
    box-sizing: border-box !important;
    animation: none !important;
    line-height: 1.5;
    overflow: hidden !important; /* 🔧 改为 hidden，防止内容溢出撑大容器 */
  }
  .overview-slide-real :deep(img) {
    max-width: 100%;
    height: auto;
  }
  .overview-slide-real :deep(table) {
    max-width: 100%;
    font-size: inherit;
  }
  .overview-slide-real .slide-breadcrumb {
    font-size: 0.65em;
    padding: 1px 0 5px 0;
    margin-bottom: 6px;
  }
  .overview-index {
    position: absolute;
    top: 4px;
    right: 8px;
    font-size: 0.7em;
    color: var(--borderColor);
    font-weight: 600;
    pointer-events: none;
    user-select: none;
  }

  /* 幻灯片内容容器，始终填满父容器 */
  .slide-container {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .slide-container.fs-container {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* v-for 外层 div：自适应模式重叠定位，比例模式 flex 居中 */
  .slide-container > div {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    pointer-events: none
  }
  .slide-container.fs-container > div {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .slide-container > div .slide {
    pointer-events: auto;  /* 恢复鼠标交互 */
    overflow-y: auto;      /* 恢复滚动 */
    overflow-x: hidden;
  }
  .slide {
    width: 100%;
    height: 100%;
    padding: 40px 48px;
    background: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.06);
    font-size: 1.4em;
    line-height: 1.7;
    color: var(--fontColor);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
  .slide > .slide-breadcrumb {
    flex-shrink: 0;
  }
  .slide > .slide-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
  }
  .slide > .slide-body :deep(.slide-layout-wrapper) {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* 翻页滑动动画 */
  .slide-animating {
    position: absolute;
    top: 50%;
    left: 0;
    width: 100%;
  }
  .slide-in-left {
    animation: slideInLeft 0.3s ease-out forwards;
  }
  .slide-in-right {
    animation: slideInRight 0.3s ease-out forwards;
  }
  .slide-out-left {
    animation: slideOutLeft 0.3s ease-out forwards;
  }
  .slide-out-right {
    animation: slideOutRight 0.3s ease-out forwards;
  }

  @keyframes slideInLeft {
    from { transform: translateX(-100%) translateY(-50%); opacity: 0.5; }
    to   { transform: translateX(0) translateY(-50%); opacity: 1; }
  }
  @keyframes slideInRight {
    from { transform: translateX(100%) translateY(-50%); opacity: 0.5; }
    to   { transform: translateX(0) translateY(-50%); opacity: 1; }
  }
  @keyframes slideOutLeft {
    from { transform: translateX(0) translateY(-50%); opacity: 1; }
    to   { transform: translateX(-100%) translateY(-50%); opacity: 0; }
  }
  @keyframes slideOutRight {
    from { transform: translateX(0) translateY(-50%); opacity: 1; }
    to   { transform: translateX(100%) translateY(-50%); opacity: 0; }
  }

  /* 固定比例时居中显示，并铺满可用空间 */
  .slide-wrapper.ratio-16\:9,
  .slide-wrapper.ratio-4\:3 {
    background: var(--menuColor);
  }
  .ratio-16\:9 .slide,
  .ratio-4\:3 .slide {
    width: 100%;
    height: auto;
    max-width: 100%;
    max-height: 100%;
  }
  .ratio-16\:9 .slide {
    aspect-ratio: 16 / 9;
  }
  .ratio-4\:3 .slide {
    aspect-ratio: 4 / 3;
  }

  /* 幻灯片面包屑导航 */
  .slide-breadcrumb {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.65em;
    color: var(--borderColor);
    padding: 2px 0 10px 0;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--borderColor);
    letter-spacing: 0.3px;
    user-select: none;
  }
  .breadcrumb-filename {
    text-align: right;
    flex-shrink: 0;
    margin-left: 12px;
  }
  /* 时间 */
  .slide-time {
    position: absolute;
    bottom: 4px;
    left: 12px;
    font-size: 0.65em;
    color: var(--borderColor);
    letter-spacing: 0.3px;
    user-select: none;
    z-index: 10;
    pointer-events: none;
  }
  /* 页码 */
  .slide-page-num {
    position: absolute;
    bottom: 4px;
    right: 12px;
    font-size: 0.65em;
    color: var(--borderColor);
    letter-spacing: 0.3px;
    user-select: none;
    z-index: 10;
    pointer-events: none;
  }

  /* 幻灯片内标题样式 */
  .slide :deep(h1) {
    font-size: 2em;
    margin-bottom: 0.5em;
    padding-bottom: 0.3em;
    border-bottom: 2px solid var(--fontActiveColor);
    color: var(--fontActiveColor);
  }
  .slide :deep(h2) {
    font-size: 1.6em;
    margin: 0.8em 0 0.4em;
    color: var(--fontActiveColor);
  }
  .slide :deep(h3) {
    font-size: 1.3em;
    margin: 0.6em 0 0.3em;
    color: var(--fontColor);
  }
  .slide :deep(p) {
    margin: 0.6em 0;
  }
  .slide :deep(ul), .slide :deep(ol) {
    padding-left: 1.5em;
    margin: 0.5em 0;
  }
  .slide :deep(li) {
    margin: 0.3em 0;
    height: auto;
    line-height: 1.6;
  }
  .slide :deep(blockquote) {
    border-left: 4px solid var(--fontActiveColor);
    margin: 0.8em 0;
    padding: 0.5em 1em;
    background: var(--menuColor);
    border-radius: 0 6px 6px 0;
    color: var(--fontColor);
  }
  .slide :deep(code) {
    font-size: 0.8em;
    padding: 0.15em 0.4em;
    background: var(--menuColor);
    border-radius: 4px;
  }
  .slide :deep(pre) {
    font-size: 0.7em;
    border-radius: 8px;
    margin: 0.8em 0;
  }
  .slide :deep(img) {
    max-width: 100%;
    max-height: 60vh;
    height: auto;
    display: block;
    margin: 0 auto;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  }

  .slide :deep(.md-image-figure) {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 16px 0;
  }

  .slide :deep(.md-image-caption) {
    margin-top: 6px;
    font-size: 0.7em;
    color: var(--fontColor);
    opacity: 0.65;
    text-align: center;
    font-style: italic;
  }

  /* ===== 封面页 ===== */
  .slide :deep(.cover-title) {
    font-size: 2.4em;
    color: var(--fontActiveColor);
    margin: 0 0 24px 0;
    padding: 0;
    border: none;
    font-weight: 700;
  }
  .slide :deep(.cover-keywords) {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: center;
    margin-bottom: 16px;
  }
  .slide :deep(.cover-keyword) {
    display: inline-block;
    padding: 6px 16px;
    border-radius: 20px;
    background: var(--menuColor);
    border: 1px solid var(--borderColor);
    color: var(--fontColor);
    font-size: 0.7em;
  }
  .slide :deep(.cover-summary) {
    font-size: 0.75em;
    color: var(--fontColor);
    opacity: 0.7;
    max-width: 80%;
    line-height: 1.6;
  }
  .slide :deep(.cover-fields) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    justify-content: center;
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--borderColor);
    max-width: 70%;
  }
  .slide :deep(.cover-field) {
    font-size: 0.65em;
    color: var(--fontColor);
    opacity: 0.55;
  }
  .slide :deep(.cover-field-key) {
    margin-right: 4px;
  }
  .slide :deep(.cover-field-key)::after {
    content: ':';
  }
  .slide :deep(.cover-field-val) {
    opacity: 0.8;
  }

  /* ===== 智能图片排版 ===== */

  /* 有图片排版时：slide 切换为 flex 列，让 v-html 容器撑满 */
  .slide:has(.slide-layout-wrapper) {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .slide:has(.slide-layout-wrapper) :deep(> :last-child) {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* 排版容器：至少撑满 v-html 容器，让行可居中 */
  .slide :deep(.slide-layout-wrapper) {
    min-height: 100%;
    display: flex;
    flex-direction: column;
  }

  /* 左文字右图片 — margin:auto 居中，内容长时自然撑开触发 slide 滚动 */
  .slide :deep(.slide-layout-row) {
    display: flex;
    flex-direction: row;
    gap: 24px;
    align-items: center;
    margin-top: auto;
    margin-bottom: auto;
  }
  .slide :deep(.slide-layout-text) {
    flex: 1;
    min-width: 0;
  }
  .slide :deep(.slide-layout-image) {
    flex: 2 1 0;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .slide :deep(.slide-layout-image) figure {
    margin: 0;
    width: 100%;
  }
  .slide :deep(.slide-layout-image) img {
    width: 100%;
    max-height: 60vh;
    height: auto;
    object-fit: contain;
  }

  /* 双图并排 — 高度一致，宽度自适应 */
  .slide :deep(.slide-layout-grid-2) {
    display: flex;
    flex-direction: row;
    gap: 20px;
    margin: 16px 0;
    align-items: flex-start;
  }
  .slide :deep(.slide-layout-grid-2) .slide-layout-cell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .slide :deep(.slide-layout-grid-2) .slide-layout-cell figure {
    margin: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .slide :deep(.slide-layout-grid-2) .slide-layout-cell img {
    width: auto;
    height: 35vh;
    max-width: 100%;
    object-fit: contain;
  }

  /* 多图网格 */
  .slide :deep(.slide-layout-grid-n) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin: 16px 0;
  }
  .slide :deep(.slide-layout-grid-n) .slide-layout-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .slide :deep(.slide-layout-grid-n) .slide-layout-cell figure {
    margin: 0;
    width: 100%;
  }
  .slide :deep(.slide-layout-grid-n) .slide-layout-cell img {
    max-width: 100%;
    max-height: 40vh;
    height: auto;
  }
  /* 幻灯片内表格：全部颜色走 --ppt-table-* 变量（各幻灯片主题各自赋值；default ⊆ 全局 var()）。
     背景必须显式设成 transparent/变量：全局 style.css 里有
table{background-color:var(--backgroundColor)} 与 table tr:nth-child(odd){...}，
     不盖住的话单元格背景会一直跟着「应用主题」而不是「幻灯片主题」。 */
  .slide :deep(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.8em 0;
    font-size: 0.8em;
    background: var(--ppt-table-bg, transparent);
    border: none;
  }
  .slide :deep(tr) {
    background: var(--ppt-table-row-bg, transparent);
  }
  .slide :deep(th), .slide :deep(td) {
    border: 1px solid var(--ppt-table-border, var(--borderColor));
    padding: 8px 12px;
    text-align: left;
    background: var(--ppt-table-cell-bg, transparent);
    color: var(--ppt-table-text, var(--fontColor));
  }
  .slide :deep(th) {
    background: var(--ppt-table-head-bg, var(--menuColor));
    color: var(--ppt-table-head-text, var(--fontColor));
    font-weight: 600;
  }
  .slide :deep(hr) {
    border: none;
    border-top: 1px solid var(--borderColor);
    margin: 1em 0;
  }

  /* 底部工具栏（状态栏式：与思维导图/代码编辑下方状态栏一致） */
  .toolbar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px;
    box-sizing: border-box;
    border-top: 1px solid var(--borderColor);
    background: var(--menuColor);
    font-size: 12px;
    color: var(--fontColor);
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
  }

  .toolbar-inner {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
  }
  /* 左操作组（占满剩余空间，过长可裁） */
  .tb-left {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    overflow: hidden;
  }
  /* 右状态组（固定在右侧） */
  .tb-right {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .tb-time {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }

  .nav-btn {
    height: 18px;
    min-width: 22px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fontColor);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    padding: 0 5px;
    opacity: 0.85;
    transition: background-color 0.15s;
    margin: 0;
  }
  .nav-btn:hover:not(:disabled) {
    background: var(--menuActiveColor);
    opacity: 1;
    color: var(--fontActiveColor);
  }
  .nav-btn:disabled {
    opacity: 0.35;
    cursor: default;
    pointer-events: none;
  }

  .slide-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--fontColor);
    user-select: none;
    min-width: 46px;
    justify-content: center;
    font-variant-numeric: tabular-nums;
  }
  .slide-current {
    font-weight: 700;
    color: var(--fontActiveColor);
  }
  .slide-separator {
    color: var(--borderColor);
  }
  .slide-total {
    color: var(--fontColor);
    opacity: 0.6;
  }

  /* 进度条 */
  .progress-bar {
    position: absolute;
    bottom: 24px;
    left: 0;
    right: 0;
    height: 3px;
    background: var(--borderColor);
  }
  .progress-fill {
    height: 100%;
    background: var(--fontActiveColor);
    transition: width 0.3s ease;
    border-radius: 0 2px 2px 0;
  }

  /* 工具栏分割线（状态栏分隔线） */
  .toolbar-sep {
    width: 1px;
    height: 14px;
    background: var(--borderColor);
    margin: 0 6px;
    opacity: 0.6;
    flex-shrink: 0;
  }

  /* 工具栏按钮（状态栏按钮样式） */
  .tool-btn {
    margin: 0;
    padding: 0 6px;
    height: 18px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fontColor);
    cursor: pointer;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    opacity: 0.85;
    transition: background-color 0.15s;
    white-space: nowrap;
    user-select: none;
    flex-shrink: 0;
  }
  .tool-btn:hover {
    background: var(--menuActiveColor);
    opacity: 1;
  }
  .tool-btn.active {
    color: var(--fontActiveColor);
    opacity: 1;
    font-weight: 600;
  }
  .tool-btn-icon {
    height: 18px;
    width: auto;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
  }
  .tool-btn:disabled {
    opacity: 0.35;
    cursor: default;
    pointer-events: none;
  }

  /* 缩放按钮 */
  .zoom-btn {
    height: 18px;
    min-width: 22px;
    padding: 0 5px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--fontColor);
    cursor: pointer;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.85;
    transition: background-color 0.15s;
    margin: 0;
  }
  .zoom-btn:hover:not(:disabled) {
    background: var(--menuActiveColor);
    opacity: 1;
  }
  .zoom-btn:disabled {
    opacity: 0.35;
    cursor: default;
    pointer-events: none;
  }

  /* 缩放比例标签 */
  .zoom-label {
    font-size: 12px;
    color: var(--fontColor);
    min-width: 34px;
    text-align: center;
    user-select: none;
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
  }

  /* 主题设置面板：left/bottom 由内联样式给出（锚在主题齿轮按钮正上方），
     下面两条只是首帧兜底；宽度上限避免窄窗口下溢出 */
  .theme-settings {
    position: absolute;
    left: 10px;
    bottom: 28px;
    width: 300px;
    max-width: calc(100% - 16px);
    max-height: 300px;
    background: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    z-index: 100;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .theme-settings-header {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--borderColor);
    background: var(--menuColor);
    font-weight: 600;
    font-size: 13px;
  }
  .theme-settings-header span { flex: 1; }
  .theme-close {
    border: none;
    background: none;
    color: var(--fontColor);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
  }
  .theme-list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    padding: 10px;
    overflow-y: auto;
  }
  /* 一格 = 色卡 + 名称；名称必须放在 .theme-item 之外，
     否则会继承色卡的 inline color（幻灯片主题文字色），在浅底/深底上看不清 */
  .theme-cell {
    cursor: pointer;
    text-align: center;
  }
  .theme-item {
    border-radius: 8px;
    padding: 8px;
    text-align: center;
    border: 2px solid transparent;
    transition: border-color 0.2s;
  }
  .theme-item:hover { border-color: var(--fontActiveColor); }
  .theme-item.active { border-color: var(--fontActiveColor); }
  .theme-preview {
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 0;
    overflow: hidden;
    background: rgba(0,0,0,0.08);
  }
  .theme-preview-text {
    font-size: 20px;
    font-weight: 700;
  }
  .theme-name {
    display: block;
    margin-top: 4px;
    font-size: 11px;
    color: var(--fontColor);
    opacity: 0.75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ===== PPT 主题 ===== */
  /* 默认 — 跟随系统 */
  .ppt-container[data-theme="default"] .slide {
    background: var(--backgroundColor);
    color: var(--fontColor);
  }
  .ppt-container[data-theme="default"] .slide :deep(.hljs) { color: var(--fontColor, #333); background: transparent; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-keyword),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-literal),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-built_in),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-type) { color: #d73a49; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-string),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-regexp),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-addition),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-attribute) { color: #22863a; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-number),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-boolean) { color: #005cc5; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-title),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-title.class_),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-title.class_.inherited__),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-title.function_) { color: #6f42c1; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-comment),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-quote) { color: #6a737d; font-style: italic; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-subst) { color: var(--fontColor, #333); }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-variable),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-template-variable) { color: #e36209; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-meta),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-selector-tag),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-section) { color: #22863a; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-deletion),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-selector-id) { color: #b31d28; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-link) { text-decoration: underline; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-attr),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-meta-string),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-meta .hljs-string) { color: #22863a; }
  .ppt-container[data-theme="default"] .slide :deep(.hljs-tag),
  .ppt-container[data-theme="default"] .slide :deep(.hljs-name) { color: #d73a49; }
  .ppt-container[data-theme="default"] .slide-breadcrumb {
    color: var(--fontColor);
    border-bottom-color: var(--borderColor);
  }

  /* 学术蓝 — 白底藏蓝，Nature/Science 风格 */
  .ppt-container[data-theme="academic-blue"] .slide {
    background: #ffffff;
    color: #1a3a5c;
    border-color: #c8d8e8;
  }
  .ppt-container[data-theme="academic-blue"] .slide :deep(h1),
  .ppt-container[data-theme="academic-blue"] .slide :deep(h2) {
    color: #1a5276;
    border-bottom-color: #2980b9;
  }
  .ppt-container[data-theme="academic-blue"] .slide :deep(h3) { color: #2c6b9e; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(p) { color: #2c3e50; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(blockquote) {
    border-left-color: #2980b9;
    background: #f0f6fb;
    color: #34495e;
  }
  .ppt-container[data-theme="academic-blue"] .slide :deep(code) {
    background: #eef3f8;
    color: #2c3e50;
  }
  .ppt-container[data-theme="academic-blue"] .slide :deep(pre) {
    background: #f5f8fc;
    border: 1px solid #dde6ef;
  }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs) { color: #2c3e50; background: transparent; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-keyword),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-literal),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-built_in),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-type) { color: #c0392b; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-string),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-regexp),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-addition),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-attribute) { color: #1a7a3a; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-number),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-boolean) { color: #1a5276; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-title),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-title.class_),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-title.class_.inherited__),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-title.function_) { color: #6f42c1; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-comment),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-quote) { color: #7a8a9a; font-style: italic; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-subst) { color: #2c3e50; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-variable),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-template-variable) { color: #d35400; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-meta),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-selector-tag),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-section) { color: #1a7a3a; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-deletion),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-selector-id) { color: #b31d28; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-link) { text-decoration: underline; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-attr),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-meta-string),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-meta .hljs-string) { color: #1a7a3a; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-tag),
  .ppt-container[data-theme="academic-blue"] .slide :deep(.hljs-name) { color: #c0392b; }
  .ppt-container[data-theme="academic-blue"] .slide :deep(a) { color: #2980b9; }
  .ppt-container[data-theme="academic-blue"] .slide-breadcrumb {
    color: #8aaec8;
    border-bottom-color: #d0dce8;
  }
  .ppt-container[data-theme="academic-blue"] .slide-wrapper.ratio-16\:9,
  .ppt-container[data-theme="academic-blue"] .slide-wrapper.ratio-4\:3 {
    background: #eef3f8;
  }

  /* 自然绿 — 米白底墨绿，生态/环境类论文风格 */
  .ppt-container[data-theme="nature-green"] .slide {
    background: #fafaf8;
    color: #2d4a2d;
    border-color: #c8d8c0;
  }
  .ppt-container[data-theme="nature-green"] .slide :deep(h1),
  .ppt-container[data-theme="nature-green"] .slide :deep(h2) {
    color: #1e6b3a;
    border-bottom-color: #2e8b4a;
  }
  .ppt-container[data-theme="nature-green"] .slide :deep(h3) { color: #2d7a3d; }
  .ppt-container[data-theme="nature-green"] .slide :deep(p) { color: #3a4a3a; }
  .ppt-container[data-theme="nature-green"] .slide :deep(blockquote) {
    border-left-color: #4a9a5a;
    background: #f0f6ee;
    color: #3a5a3a;
  }
  .ppt-container[data-theme="nature-green"] .slide :deep(code) {
    background: #edf3ea;
    color: #2d4a2d;
  }
  .ppt-container[data-theme="nature-green"] .slide :deep(pre) {
    background: #f3f7f0;
    border: 1px solid #d8e4d0;
  }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs) { color: #2d4a2d; background: transparent; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-keyword),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-literal),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-built_in),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-type) { color: #b83a2a; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-string),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-regexp),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-addition),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-attribute) { color: #1a7a3a; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-number),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-boolean) { color: #1e6b3a; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-title),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-title.class_),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-title.class_.inherited__),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-title.function_) { color: #6f42c1; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-comment),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-quote) { color: #7a9a7a; font-style: italic; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-subst) { color: #2d4a2d; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-variable),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-template-variable) { color: #b86a1a; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-meta),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-selector-tag),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-section) { color: #1a7a3a; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-deletion),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-selector-id) { color: #b31d28; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-link) { text-decoration: underline; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-attr),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-meta-string),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-meta .hljs-string) { color: #1a7a3a; }
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-tag),
  .ppt-container[data-theme="nature-green"] .slide :deep(.hljs-name) { color: #b83a2a; }
  .ppt-container[data-theme="nature-green"] .slide-breadcrumb {
    color: #8aaa88;
    border-bottom-color: #c8d8c0;
  }
  .ppt-container[data-theme="nature-green"] .slide-wrapper.ratio-16\:9,
  .ppt-container[data-theme="nature-green"] .slide-wrapper.ratio-4\:3 {
    background: #eef3ec;
  }

  /* IEEE 深色 — 深蓝灰底，经典工程/计算机论文风格 */
  .ppt-container[data-theme="ieee-dark"] .slide {
    background: #1c2331;
    color: #c8d0e0;
    border-color: #3a4a6a;
  }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(h1),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(h2) {
    color: #6a9fe0;
    border-bottom-color: #4a7ab8;
  }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(h3) { color: #8ab8f0; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(p) { color: #bcc8dc; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(blockquote) {
    border-left-color: #6a9fe0;
    background: rgba(106,159,224,0.08);
    color: #bcc8dc;
  }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(code) {
    background: rgba(255,255,255,0.06);
    color: #c8d0e0;
  }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(pre) {
    background: rgba(0,0,0,0.2);
    border: 1px solid #3a4a6a;
  }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs) { color: #c8d0e0; background: transparent; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-keyword),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-literal),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-built_in),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-type) { color: #e06c75; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-string),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-regexp),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-addition),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-attribute) { color: #98c379; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-number),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-boolean) { color: #d19a66; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-title),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-title.class_),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-title.class_.inherited__),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-title.function_) { color: #61afef; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-comment),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-quote) { color: #5c6370; font-style: italic; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-subst) { color: #c8d0e0; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-variable),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-template-variable) { color: #e06c75; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-meta),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-selector-tag),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-section) { color: #61afef; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-deletion),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-selector-id) { color: #e06c75; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-link) { text-decoration: underline; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-attr),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-meta-string),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-meta .hljs-string) { color: #98c379; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-tag),
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.hljs-name) { color: #e06c75; }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(a) { color: #6a9fe0; }
  .ppt-container[data-theme="ieee-dark"] .slide-breadcrumb {
    color: #8ab8f0;
    border-bottom-color: #3a4a6a;
  }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.cover-field) {
    color: #8ab8f0;
    opacity: 0.8;
  }
  .ppt-container[data-theme="ieee-dark"] .slide :deep(.cover-field-key)::after {
    color: #6a9fe0;
  }
  .ppt-container[data-theme="ieee-dark"] .slide-wrapper.ratio-16\:9,
  .ppt-container[data-theme="ieee-dark"] .slide-wrapper.ratio-4\:3 {
    background: #141a28;
  }

  /* 经典金 — 暖米底深棕金，人文/社科论文风格 */
  .ppt-container[data-theme="classic-gold"] .slide {
    background: #f8f5f0;
    color: #5c3a1a;
    border-color: #d8ccbc;
  }
  .ppt-container[data-theme="classic-gold"] .slide :deep(h1),
  .ppt-container[data-theme="classic-gold"] .slide :deep(h2) {
    color: #8a6a3a;
    border-bottom-color: #b8964a;
  }
  .ppt-container[data-theme="classic-gold"] .slide :deep(h3) { color: #7a5a3a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(p) { color: #5a4a3a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(blockquote) {
    border-left-color: #b8964a;
    background: #f3efe8;
    color: #6a5a4a;
  }
  .ppt-container[data-theme="classic-gold"] .slide :deep(code) {
    background: #ede8e0;
    color: #5c3a1a;
  }
  .ppt-container[data-theme="classic-gold"] .slide :deep(pre) {
    background: #f0ece4;
    border: 1px solid #d8ccbc;
  }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs) { color: #5c3a1a; background: transparent; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-keyword),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-literal),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-built_in),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-type) { color: #b84a2a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-string),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-regexp),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-addition),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-attribute) { color: #5a7a3a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-number),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-boolean) { color: #8a6a3a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-title),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-title.class_),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-title.class_.inherited__),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-title.function_) { color: #6f42c1; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-comment),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-quote) { color: #9a8a7a; font-style: italic; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-subst) { color: #5c3a1a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-variable),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-template-variable) { color: #b86a1a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-meta),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-selector-tag),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-section) { color: #5a7a3a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-deletion),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-selector-id) { color: #b31d28; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-link) { text-decoration: underline; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-attr),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-meta-string),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-meta .hljs-string) { color: #5a7a3a; }
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-tag),
  .ppt-container[data-theme="classic-gold"] .slide :deep(.hljs-name) { color: #b84a2a; }
  .ppt-container[data-theme="classic-gold"] .slide-breadcrumb {
    color: #b8a890;
    border-bottom-color: #d8ccbc;
  }
  .ppt-container[data-theme="classic-gold"] .slide-wrapper.ratio-16\:9,
  .ppt-container[data-theme="classic-gold"] .slide-wrapper.ratio-4\:3 {
    background: #ece6dc;
  }

  /* 洁净白 — 纯白底深灰，最简洁的学术风格 */
  .ppt-container[data-theme="clean-white"] .slide {
    background: #ffffff;
    color: #2c2c2c;
    border-color: #d8d8d8;
  }  .ppt-container[data-theme="clean-white"] .slide :deep(h1),
  .ppt-container[data-theme="clean-white"] .slide :deep(h2) {
    color: #1a1a1a;
    border-bottom-color: #2c2c2c;
    font-weight: 700;
  }
  .ppt-container[data-theme="clean-white"] .slide :deep(h3) { color: #3a3a3a; }
  .ppt-container[data-theme="clean-white"] .slide :deep(p) { color: #3a3a3a; }
  .ppt-container[data-theme="clean-white"] .slide :deep(blockquote) {
    border-left-color: #2c2c2c;
    background: #f8f8f8;
    color: #4a4a4a;
  }
  .ppt-container[data-theme="clean-white"] .slide :deep(code) {
    background: #f2f2f2;
    color: #2c2c2c;
  }
  .ppt-container[data-theme="clean-white"] .slide :deep(pre) {
    background: #f6f6f6;
    border: 1px solid #e0e0e0;
  }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs) { color: #2c2c2c; background: transparent; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-keyword),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-literal),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-built_in),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-type) { color: #d73a49; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-string),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-regexp),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-addition),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-attribute) { color: #22863a; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-number),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-boolean) { color: #005cc5; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-title),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-title.class_),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-title.class_.inherited__),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-title.function_) { color: #6f42c1; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-comment),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-quote) { color: #6a737d; font-style: italic; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-subst) { color: #2c2c2c; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-variable),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-template-variable) { color: #e36209; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-meta),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-selector-tag),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-section) { color: #22863a; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-deletion),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-selector-id) { color: #b31d28; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-link) { text-decoration: underline; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-attr),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-meta-string),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-meta .hljs-string) { color: #22863a; }
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-tag),
  .ppt-container[data-theme="clean-white"] .slide :deep(.hljs-name) { color: #d73a49; }
  .ppt-container[data-theme="clean-white"] .slide-breadcrumb {
    color: #b0b0b0;
    border-bottom-color: #d8d8d8;
  }
  .ppt-container[data-theme="clean-white"] .slide-wrapper.ratio-16\:9,
  .ppt-container[data-theme="clean-white"] .slide-wrapper.ratio-4\:3 {
    background: #f0f0f0;
  }

  /* 各幻灯片主题的表格配色：只定义变量，具体规则见 .slide :deep(table/th/td) */
  .ppt-container[data-theme="academic-blue"] .slide {
    --ppt-table-border: #c8d8e8;
    --ppt-table-head-bg: #e8eef6;
    --ppt-table-head-text: #1a5276;
    --ppt-table-text: #2c3e50;
    --ppt-mermaid-border: #c8d8e8;
    --ppt-mermaid-bg: #f5f8fc;
    --ppt-mermaid-icon: #1a5276;
  }
  /* 各幻灯片主题的 Mermaid 外框/放大图标配色（default 不定义 → 跟随应用主题）*/
  .ppt-container[data-theme="nature-green"] .slide {
    --ppt-table-border: #c8d8c0;
    --ppt-table-head-bg: #eaf0e6;
    --ppt-table-head-text: #1a7a3a;
    --ppt-table-text: #2d4a2d;
    --ppt-mermaid-border: #c8d8c0;
    --ppt-mermaid-bg: #f3f7f0;
    --ppt-mermaid-icon: #1e6b3a;
  }
  .ppt-container[data-theme="ieee-dark"] .slide {
    --ppt-table-border: #3a4a6a;
    --ppt-table-head-bg: rgba(106, 159, 224, 0.14);
    --ppt-table-head-text: #8ab8f0;
    --ppt-table-text: #c8d0e0;
    --ppt-mermaid-border: #3a4a6a;
    --ppt-mermaid-bg: rgba(106, 159, 224, 0.06);
    --ppt-mermaid-icon: #8ab8f0;
  }
  .ppt-container[data-theme="classic-gold"] .slide {
    --ppt-table-border: #d8ccbc;
    --ppt-table-head-bg: #f0e8d8;
    --ppt-table-head-text: #8a6a3a;
    --ppt-table-text: #5a4a3a;
    --ppt-mermaid-border: #d8ccbc;
    --ppt-mermaid-bg: #f3efe8;
    --ppt-mermaid-icon: #8a6a3a;
  }
  .ppt-container[data-theme="clean-white"] .slide {
    --ppt-table-border: #d8d8d8;
    --ppt-table-head-bg: #f2f2f2;
    --ppt-table-head-text: #1a1a1a;
    --ppt-table-text: #3a3a3a;
    --ppt-mermaid-border: #d8d8d8;
    --ppt-mermaid-bg: #fafafa;
    --ppt-mermaid-icon: #3a3a3a;
  }

  /* 全屏模式：隐藏其他元素，幻灯片保持比例居中 */
  .ppt-container:fullscreen .nav-panel,
  .ppt-container:fullscreen .toolbar,
  .ppt-container:fullscreen .progress-bar {
    display: none;
  }
  .ppt-container:fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9999;
    background: var(--backgroundColor);
  }
  .ppt-container:fullscreen .slide-wrapper {
    top: 0;
    left: 0 !important;
    right: 0;
    bottom: 0;
  }
  /* 全屏背景跟随当前主题的页面底色，避免幻灯片四周出现纯黑边 */
  .ppt-container[data-theme="default"]:fullscreen,
  .ppt-container[data-theme="default"]:fullscreen .slide-wrapper { background: var(--backgroundColor); }
  .ppt-container[data-theme="academic-blue"]:fullscreen,
  .ppt-container[data-theme="academic-blue"]:fullscreen .slide-wrapper { background: #ffffff; }
  .ppt-container[data-theme="nature-green"]:fullscreen,
  .ppt-container[data-theme="nature-green"]:fullscreen .slide-wrapper { background: #fafaf8; }
  .ppt-container[data-theme="ieee-dark"]:fullscreen,
  .ppt-container[data-theme="ieee-dark"]:fullscreen .slide-wrapper { background: #1c2331; }
  .ppt-container[data-theme="classic-gold"]:fullscreen,
  .ppt-container[data-theme="classic-gold"]:fullscreen .slide-wrapper { background: #f8f5f0; }
  .ppt-container[data-theme="clean-white"]:fullscreen,
  .ppt-container[data-theme="clean-white"]:fullscreen .slide-wrapper { background: #ffffff; }
  .ppt-container:fullscreen .slide-container {
    width: 100%;
    height: 100%;
  }
  .ppt-container:fullscreen .slide-container > div {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ppt-container:fullscreen .slide {
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
  .ppt-container:fullscreen .slide-wrapper.ratio-16\:9 .slide,
  .ppt-container:fullscreen .slide-wrapper.ratio-4\:3 .slide {
    width: 100%;
    height: auto;
    max-width: 100%;
    max-height: 100%;
  }
  .ppt-container:fullscreen .slide-wrapper.ratio-auto .slide {
    max-width: 100%;
    max-height: 100%;
  }
  /* Mermaid 图表样式 */
  .mermaid {
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow: hidden;
    max-width: 100%;
    margin: 8px 0;
    padding: 8px;
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    background-color: rgba(255,255,255,0.03);
  }
  .mermaid svg {
    display: block;
    width: 100%;
    height: auto;
    max-width: 100%;
    max-height: 50vh;
    object-fit: contain;
    overflow: hidden;
  }
</style>

<style>
/* ===== PPT 内 Mermaid 兜底样式（slide 内容经 v-html 注入，scoped 样式不会命中） ===== */
.ppt-container .mermaid {
  display: flex;
  justify-content: center;
  align-items: center;
  /* 宽度贴合图形（fit-content）：避免整页宽的空框把图围出大片留白 */
  width: fit-content;
  max-width: 100%;
  margin: 8px auto;
  /* 高度由图形自身决定（flex-shrink:0 保证不被压缩）；min-height 只给未渲染占位图标留空间。
     注意不要用大 min-height 顶高：那会在小图上下制造大片空白 */
  min-height: 3em;
  /* 不参与 flex 压缩：宁可让 .slide-body 出现滚动，也不把图压小 */
  flex-shrink: 0;
  padding: 8px;
  /* 边框/底色跟随幻灯片主题（未定义变量的 default 主题回落应用变量）*/
  border: 1px solid var(--ppt-mermaid-border, var(--borderColor));
  border-radius: 6px;
  background-color: var(--ppt-mermaid-bg, rgba(255, 255, 255, 0.03));
  box-sizing: border-box;
}
/* 总览缩略图里的小格子需要保持可压缩，避免撑破固定尺寸的缩略图 */
.overview-slide-real .mermaid {
  flex-shrink: 1;
  min-height: 0;
}
.ppt-container .mermaid .mermaid-ph {
  font-size: 20px;
  color: var(--fontColor);
  opacity: 0.45;
  line-height: 1;
}
.ppt-container .mermaid .mermaid-ph.mermaid-err {
  color: #e74c3c;
  opacity: 0.8;
}
.ppt-container .mermaid svg {
  display: block;
  /* 尺寸由固有尺寸（viewBox）决定，超界时由 max-* 等比缩放，不留内部空白 */
  width: auto;
  height: auto;
  max-width: 100%;
  /* 必须用纯视口单位：写 min(60vh, 100%) 时百分比相对父高，而父高又由本 svg 决定（循环），
     Chrome 会忽略该百分比 → 布局高用自然高、绘制时按 60vh 缩 → 容器被撑高、四周留白 ✗ */
  max-height: 50vh;
  object-fit: contain;
  overflow: hidden;
}
/* 渲染完成的 mermaid：右上 hover 放大查看图标（点击打开 MermaidViewer） */
.ppt-container .mermaid.mermaid-clickable {
  position: relative;
  cursor: pointer;
}
.ppt-container .mermaid.mermaid-clickable::after {
  font-family: 'FontAwesome';
  content: '\f002';
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  font-size: 14px;
  /* 图标颜色跟随幻灯片主题（原来用 --fontColor 只看应用主题，深底上看不见）*/
  color: var(--ppt-mermaid-icon, var(--fontColor));
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.ppt-container .mermaid.mermaid-clickable:hover::after {
  opacity: 0.75;
}
/* ===== Python 代码块运行按钮（非 scoped） ===== */
.python-block-wrapper {
  margin: 8px 0;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
}
.python-block-wrapper pre {
  margin: 0 !important;
  border-radius: 0 !important;
  border: none !important;
  overflow-x: auto !important;
}
.python-run-bar {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  background: var(--menuColor);
  border-top: 1px solid var(--borderColor);
}
.python-run-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 11px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.15s ease;
}
.python-run-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.python-run-btn i {
  font-size: 10px;
}
.python-result {
  border-top: 1px solid var(--borderColor);
  padding: 8px;
  font-size: 12px;
  line-height: 1.5;
  background: rgba(0,0,0,0.02);
}
.python-result-loading {
  color: var(--fontColor);
  opacity: 0.7;
  display: flex;
  align-items: center;
  gap: 6px;
}
.python-result-output {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Courier New', monospace;
  font-size: 11px;
  color: var(--fontColor);
}
.python-result-error {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Courier New', monospace;
  font-size: 11px;
  color: #e74c3c;
}
.python-result-empty {
  color: var(--fontColor);
  opacity: 0.5;
  font-style: italic;
}
.python-result-time {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.5;
}
</style>
