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
  // 内嵌图表（`![](图.drawio)`）：与浏览 / 可视编辑 / 导图共用同一套占位 + 回填（见 lib/markdown/drawioFigure）
  import { installDrawioImageRule, renderDrawioFigures } from '@/lib/markdown/drawioFigure'
  import { preprocessMath as sharedPreprocessMath } from '@/lib/markdown/render'
  import { applyMdLinkRule } from '@/lib/markdown/mdLinkPolicy'
  import { handleMdContainerClick, openMdFileLink } from '@/lib/knowFile/mdLinkOpen'
  // 点击内嵌图表时还原 `data-drawio-path` 里可能残留的百分号编码（中文 / 空格路径）
  import { decodeDiagramPath, readDiagramFile } from '@/shared/drawioRender'
  // 图表形状（宽高）用于「按图片长宽选布局」：直接解析图表 XML 估算，不走离屏渲染
  import { estimateDiagramSizes, pickDiagramSize } from '@/lib/markdown/drawioFigure'
  import MermaidViewer from '@/components/MermaidViewer.vue'
  import { useSwipeNav } from '@/composables/useSwipeNav'
  import mermaid from 'mermaid'
  import { ElMessage } from 'element-plus'
import { getPlatform, hasCapability } from '@/platform'

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
/** watchedFileChanged 退订句柄（onMounted 注册 / onBeforeUnmount 释放） */
let unsubWatchedFile: (() => void) | null = null

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

  // 图表文件（`![](diagram.drawio)`）：先渲染成占位卡片，幻灯片挂上 DOM 后再由 renderDrawio() 填 SVG
  installDrawioImageRule(md, { getBasePath: () => mdBasePath, isZh: () => store.locales === 'zh' })

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

  // 链接策略：相对路径链接打上 md-file-link + data-path（绝对路径），点击由 handleSlideLinkClick 处理；
  // 否则相对 href 会被当成应用内地址，点 md 链接会跳错/跳走
  applyMdLinkRule(md, () => mdBasePath)

  // 幻灯片内 Markdown 链接点击：本地文件按当前文档目录解析后打开（与浏览 / 导图视图一致）
  const handleSlideLinkClick = (e: MouseEvent) => {
    // 内嵌图表：点哪一页就打开图表编辑器的哪一页（与浏览视图一致）
    const fig = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.md-drawio-figure')
    if (fig) {
      const path = decodeDiagramPath(fig.getAttribute('data-drawio-path') || '')
      const canvas = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.md-drawio-canvas')
      const page = canvas?.dataset.drawioPage || fig.getAttribute('data-drawio-page') || ''
      if (path) {
        void openMdFileLink(path, { page })
        return
      }
    }
    void handleMdContainerClick(e, mdBasePath)
  }

  // ===== 图文智能排版 =====
  // 一页的内容怎么摆：按图片形状选布局（与幻灯片同形 → 图片独占一页；竖图 → 文字左 / 图右；
  // 宽图 → 文字上 / 图下），文字过多时按块自动分页，尽量不让内容超出单页范围。

  /** 幻灯片可用宽高比（auto 模式没有固定比例，取 16:10 作为判定基准） */
  const slideRatio = () => (ratioMode.value === '16:9' ? 16 / 9 : ratioMode.value === '4:3' ? 4 / 3 : 1.6)
  /** 图片与幻灯片「形状相同」的容忍幅度：比例差在 ±25% 内即视作同形 */
  const RATIO_TOLERANCE = 1.25
  /** 单页容量（估分值）：纯文字页 */
  const CAP_TEXT_ONLY = 1100
  /**
   * 图文混排页里「文字最多能占多少」：图越多，留给文字的比例越小 ——
   * 否则文字会把图片挤成一条缝（这是之前图片被压扁的根因）。
   */
  const textShareFor = (figureCount: number) =>
    figureCount >= 4 ? 0.22 : figureCount === 3 ? 0.26 : figureCount === 2 ? 0.32 : 0.42
  /** 低于此分值的文字视作「图注」：与图同页，而不是另起一页 */
  const CAPTION_SCORE = 80

  /** 某段因「真的装不下」而收紧过几次容量（每收紧一次：单页容量 ÷1.6） */
  const sectionTighten = new Map<string, number>()
  /** 每一页的来源段键 / 是否可再分页（与 prepList 一一对应，供运行期溢出兜底使用） */
  let slideKeys: string[] = []
  let slideSplittable: boolean[] = []
  /** 本轮构建里因溢出重建过几次（防止来回抖动） */
  let overflowRebuilds = 0
  let overflowTimer: ReturnType<typeof setTimeout> | null = null

  /** 图片尺寸缓存（布局决策用；量不到存 null，按竖图兜底走左右布局） */
  const figSizeCache = new Map<string, { w: number; h: number } | null>()

  /** 读取图片固有尺寸（超时 / 失败返回 null） */
  const loadImageSize = (src: string, timeout = 3000): Promise<{ w: number; h: number } | null> =>
    new Promise((resolve) => {
      if (!src) {
        resolve(null)
        return
      }
      const img = new Image()
      let done = false
      const finish = (v: { w: number; h: number } | null) => {
        if (done) return
        done = true
        resolve(v)
      }
      const timer = window.setTimeout(() => {
        img.src = ''
        finish(null)
      }, timeout)
      img.onload = () => {
        window.clearTimeout(timer)
        finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null)
      }
      img.onerror = () => {
        window.clearTimeout(timer)
        finish(null)
      }
      img.src = src
    })

  /** 量出一页里所有图片 / 图表的尺寸（顺序与 figures 一致） */
  const measureFigures = (figures: Element[]): Promise<Array<{ w: number; h: number } | null>> =>
    Promise.all(
      figures.map(async (fig) => {
        const drawio = fig.classList.contains('md-drawio-figure')
        const path = fig.getAttribute('data-drawio-path') || ''
        const page = fig.getAttribute('data-drawio-page') || ''
        const img = drawio ? null : fig.tagName === 'IMG' ? (fig as HTMLImageElement) : fig.querySelector('img')
        const src = img?.getAttribute('src') || ''
        const key = drawio ? `drawio:${path}#${page}` : `img:${src}`
        if (figSizeCache.has(key)) return figSizeCache.get(key)!
        let size: { w: number; h: number } | null = null
        try {
          if (drawio) {
            // 估算图表形状（解析 XML，不渲染）：排版只需要"竖图 / 方图 / 宽图"，省下离屏渲染的等待
            const xml = await readDiagramFile(path)
            if (xml) size = pickDiagramSize(await estimateDiagramSizes(xml), page)
          } else {
            size = await loadImageSize(src)
          }
        } catch (e) {
          console.warn('[PPT] 图片尺寸测量失败，按竖图排版:', key, e)
        }
        figSizeCache.set(key, size)
        return size
      }),
    )

  /** 页面估分：正文长度 + 块数 + 表格行数（与 calcAutoScale 同一口径）；mermaid 源码长度与图大小无关，按固定体积计 */
  const blockScore = (el: Element): number => {
    const clone = el.cloneNode(true) as Element
    clone.querySelectorAll('.mermaid-src').forEach((n) => n.remove())
    const mermaid = clone.querySelectorAll('.mermaid').length
    const textLen = (clone.textContent || '').replace(/\s+/g, '').length
    const blocks = clone.querySelectorAll('li, p, h1, h2, h3, h4, h5, h6, pre, table, blockquote, figure').length
    // 表格按行计：一行的实际高度接近一行文字，只按字符数算会严重低估（长表格因此挤掉图片）
    const tableRows = clone.querySelectorAll('table tr').length
    return textLen + blocks * 8 + tableRows * 20 + mermaid * 260
  }

  /** 按容量把块分成多页：先按总量算需要几页，再让每页装得差不多满（避免最后一页只剩两行） */
  const groupBlocks = (blocks: Element[], cap: number): Element[][] => {
    if (blocks.length <= 1) return blocks.length ? [blocks] : []
    const scores = blocks.map(blockScore)
    const total = scores.reduce((a, b) => a + b, 0)
    if (total <= cap) return [blocks]
    const pageCount = Math.ceil(total / cap)
    const target = total / pageCount
    const groups: Element[][] = []
    let cur: Element[] = []
    let curScore = 0
    for (let i = 0; i < blocks.length; i++) {
      cur.push(blocks[i])
      curScore += scores[i]
      const pagesLeft = pageCount - groups.length
      const blocksLeft = blocks.length - i - 1
      // 本页已装到均分量、且后面的块还够填满剩余页 → 断页
      if (pagesLeft > 1 && curScore >= target && blocksLeft >= pagesLeft - 1) {
        groups.push(cur)
        cur = []
        curScore = 0
      }
    }
    if (cur.length) groups.push(cur)
    return groups
  }

  const isPictureFigure = (el: Element | null): boolean =>
    !!el &&
    el.tagName === 'FIGURE' &&
    (el.classList.contains('md-image-figure') || el.classList.contains('md-drawio-figure'))

  /** 图片形状相对幻灯片比例的分类 */
  const figureShapeOf = (size: { w: number; h: number } | null): 'same' | 'tall' | 'wide' => {
    // 量不到尺寸时按竖图（左右布局）兜底：与原行为一致，也不会把文字挤到别的页
    if (!size || !(size.w > 0) || !(size.h > 0)) return 'tall'
    const r = size.w / size.h
    const base = slideRatio()
    if (r > base * RATIO_TOLERANCE) return 'wide'
    if (r < base / RATIO_TOLERANCE) return 'tall'
    return 'same'
  }

  const textBlocksHtml = (blocks: Element[]) => blocks.map((el) => el.outerHTML).join('')

  /** 文字在左 / 图片在右 */
  const mixedRowHtml = (texts: Element[], figures: Element[]) =>
    `<div class="slide-layout-row"><div class="slide-layout-text">${textBlocksHtml(texts)}</div>` +
    `<div class="slide-layout-image">${figures.map((f) => f.outerHTML).join('')}</div></div>`

  /** 文字在上 / 图片在下（宽图） */
  const mixedStackHtml = (texts: Element[], figures: Element[]) =>
    `<div class="slide-layout-stack"><div class="slide-layout-text">${textBlocksHtml(texts)}</div>` +
    `<div class="slide-layout-image">${figures.map((f) => f.outerHTML).join('')}</div></div>`

  /**
   * 多图同页的列数：优先并排展示，但如果「放在一起」会把图压得明显比单张更小
   * （小于单张高度的 70%），就退到更少的列；没有合适方案时返回 0 —— 调用方改为
   * 「一图一页」（例如 3 张与幻灯片同形的图，挤在一页上每人只剩一小块，不如各占一页）。
   */
  const chooseGridColumns = (sizes: Array<{ w: number; h: number } | null>, hasText: boolean): number => {
    const n = sizes.length
    if (n <= 1) return n
    // 网格能分到的页面高度份额（有文字时文字要占一部分）
    const availH = hasText ? 0.7 : 0.92
    const ratioOf = (s: { w: number; h: number } | null) => (s && s.h > 0 ? s.w / s.h : slideRatio())
    /** 这张图独占一页时占页面高度的比例 */
    const alone = (s: { w: number; h: number } | null) => Math.min(1, 1 / ratioOf(s))
    /** 这张图在 cols×rows 网格里占页面高度的比例 */
    const share = (s: { w: number; h: number } | null, cols: number, rows: number) =>
      Math.min(availH / rows, 1 / (cols * ratioOf(s)))
    const candidates = n === 2 ? [2, 1] : n === 3 ? [3, 1] : n === 4 ? [2, 4, 1] : [3, 2, 1]
    for (const cols of candidates) {
      const rows = Math.ceil(n / cols)
      if (sizes.every((s) => share(s, cols, rows) >= alone(s) * 0.7)) return cols
    }
    return 0
  }

  /** 多图网格：列数由内容决定（内联 grid-template-columns），其余交给 CSS（等高行 + 每格等比缩放） */
  const gridHtml = (figures: Element[], cols: number) =>
    `<div class="slide-layout-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">` +
    figures.map((f) => `<div class="slide-layout-cell">${f.outerHTML}</div>`).join('') +
    `</div>`

  /** 图片独占一页：等比缩放到整页内并居中 */
  const imagePageHtml = (figures: Element[]) =>
    figures
      .map((f) => {
        const clone = f.cloneNode(true) as Element
        clone.classList.add('slide-layout-page-image')
        return clone.outerHTML
      })
      .join('')

  /** 图文同页（多图）：标题固定在顶部，图与文字按原文顺序摆，网格吃掉剩余高度 */
  const multiPageHtml = (heading: Element | null, texts: Element[], grid: string, figuresFirst: boolean) => {
    const head = heading ? heading.outerHTML : ''
    const textHtml = textBlocksHtml(texts)
    const textBlock = textHtml ? `<div class="slide-layout-textblocks">${textHtml}</div>` : ''
    return (
      `<div class="slide-layout-multi">${head}` +
      (figuresFirst ? `${grid}${textBlock}` : `${textBlock}${grid}`) +
      `</div>`
    )
  }

  interface SlidePart {
    html: string
    /** 这一页还能不能再分页（运行期发现溢出时据此决定要不要收紧容量重建） */
    splittable: boolean
  }

  /**
   * 把一段的渲染结果整理成 1~N 张幻灯片。
   *
   * @param sectionKey 来源段标识（运行期溢出兜底时按它收紧这一段的容量）
   * @param allowSplit 是否允许自动分页（智能切分模式开；`---` 模式尊重用户的显式分页，只挑布局）
   */
  const buildSlideParts = async (
    renderedHtml: string,
    sectionKey: string,
    allowSplit: boolean,
    headingInBreadcrumb: boolean,
  ): Promise<SlidePart[]> => {
    const tmp = document.createElement('div')
    tmp.innerHTML = renderedHtml
    // 顶层子节点（排除浏览器隐式闭合 <p> 产生的空 <p>）
    const blocks = Array.from(tmp.children).filter(
      (el) => !(el.tagName === 'P' && !el.children.length && !(el.textContent || '').trim()),
    )
    if (!blocks.length) return []

    const figures: Element[] = []
    const texts: Element[] = []
    for (const b of blocks) {
      if (isPictureFigure(b)) figures.push(b)
      else if (b.children.length === 1 && isPictureFigure(b.children[0])) figures.push(b.children[0])
      else texts.push(b)
    }
    // 标题单独拿出来：续页 / 图片页都要在顶部重复标题（目录里只登记一次，见 init）
    const heading = texts.length && /^H[1-6]$/.test(texts[0].tagName) ? texts[0] : null
    const bodyTexts = heading ? texts.slice(1) : texts
    // 原文里第一个非标题块是不是图片：是的话这一页就「图在上、文字在下」（尊重原文顺序）
    const firstBody = blocks.find((b) => !/^H[1-6]$/.test(b.tagName))
    const figuresFirst =
      isPictureFigure(firstBody ?? null) ||
      (!!firstBody && firstBody.children.length === 1 && isPictureFigure(firstBody.children[0]))

    const sizes = await measureFigures(figures)
    const capOf = (base: number) => base / Math.pow(1.6, sectionTighten.get(sectionKey) || 0)
    const headingScore = heading ? blockScore(heading) : 0
    const textCap = () => Math.max(260, capOf(CAP_TEXT_ONLY) - headingScore)
    const textScore = bodyTexts.reduce((n, el) => n + blockScore(el), 0)
    // 单个块就超过一页（超长代码 / 表格）：这一页再拆也没有用，别让运行期反复收紧
    const atomic = bodyTexts.some((el) => blockScore(el) > textCap() * 0.9)
    /** 纯文字页（文字过多按块分页，每页顶部都带标题） */
    const textPages = (): SlidePart[] => {
      if (!bodyTexts.length) return [{ html: renderedHtml, splittable: false }]
      return groupBlocks(bodyTexts, textCap()).map((g) => ({
        html: (heading ? heading.outerHTML : '') + textBlocksHtml(g),
        splittable: !atomic && bodyTexts.length > 1,
      }))
    }
    const headingHtml = heading ? heading.outerHTML : ''
    /**
     * 图片页（整页只有图，没有正文）用的标题：
     * 幻灯片最上方的面包屑已经写着这条标题了，页内再来一次是多余的 —— 去掉它图能大一圈。
     * 标题不在面包屑里时（如没有 `#` 的 setext 标题、第一个标题之前的内容）仍然保留，否则标题就没了。
     */
    const imageHeadingHtml = headingInBreadcrumb ? '' : headingHtml

    // 没有图：纯文字页（文字过多就分页）
    if (!figures.length) {
      return allowSplit ? textPages() : [{ html: renderedHtml, splittable: false }]
    }

    // 只有图：整页居中展示（多张按网格铺开；压得太小则一图一页）
    if (!bodyTexts.length && !heading) {
      if (figures.length === 1) return [{ html: imagePageHtml(figures), splittable: false }]
      const cols = chooseGridColumns(sizes, false)
      if (cols === 0) {
        return figures.map((f) => ({ html: imagePageHtml([f]), splittable: false }))
      }
      return [{ html: gridHtml(figures, cols), splittable: false }]
    }

    const mixedCap = Math.max(180, capOf(CAP_TEXT_ONLY) * textShareFor(figures.length))
    const fitsMixed = textScore <= mixedCap
    // 混排页在文字变多时也能靠「收回容量」把文字挪到单独一页 → 允许运行期收紧
    const mixedSplittable = !atomic && bodyTexts.length > 1

    // 多图：能同页就图文同页（图在上 / 下按原文顺序）；会被压得太小就一图一页；文字放不下就单独分页
    if (figures.length >= 2) {
      const cols = chooseGridColumns(sizes, bodyTexts.length > 0)
      // 一图一页（例如 3 张与幻灯片同形的图）
      const imagePages: SlidePart[] = figures.map((f) => ({
        html: imageHeadingHtml + imagePageHtml([f]),
        splittable: false,
      }))
      if (cols === 0) {
        if (!bodyTexts.length) return imagePages
        const textsOnly = textPages()
        return figuresFirst ? [...imagePages, ...textsOnly] : [...textsOnly, ...imagePages]
      }
      const grid = gridHtml(figures, cols)
      if (!allowSplit || fitsMixed) {
        return [{ html: multiPageHtml(heading, bodyTexts, grid, figuresFirst), splittable: allowSplit && mixedSplittable }]
      }
      // 只有图的网格页也省掉页内标题（面包屑里已经有了）
      const gridPart: SlidePart = {
        html: multiPageHtml(headingInBreadcrumb ? null : heading, [], grid, true),
        splittable: false,
      }
      const textsOnly = textPages()
      return figuresFirst ? [gridPart, ...textsOnly] : [...textsOnly, gridPart]
    }

    // 只有标题 + 一张图（正文为空）：图占满整页（标题在面包屑里，页内不再重复）
    if (!bodyTexts.length) {
      return [{ html: imageHeadingHtml + imagePageHtml(figures), splittable: false }]
    }

    const shape = figureShapeOf(sizes[0])

    // `---` 模式：只挑布局，不自动分页（同形图片也走左右，避免把文字挪到别的页）
    if (!allowSplit) {
      return [
        { html: shape === 'wide' ? mixedStackHtml(texts, figures) : mixedRowHtml(texts, figures), splittable: false },
      ]
    }

    // 与幻灯片同形：图片独占一页（文字另起一页）；文字很短时当图注留在同一页
    if (shape === 'same') {
      if (textScore <= CAPTION_SCORE) {
        return [
          {
            html: `<div class="slide-layout-image-only">${imagePageHtml(figures)}<div class="slide-layout-caption">${headingHtml}${textBlocksHtml(bodyTexts)}</div></div>`,
            splittable: mixedSplittable,
          },
        ]
      }
      return [...textPages(), { html: imageHeadingHtml + imagePageHtml(figures), splittable: false }]
    }

    // 竖图 → 左右布局；宽图 → 上下布局；文字放不下则图文各占一页
    if (fitsMixed) {
      return [
        {
          html: shape === 'tall' ? mixedRowHtml(texts, figures) : mixedStackHtml(texts, figures),
          splittable: mixedSplittable,
        },
      ]
    }
    return [...textPages(), { html: imageHeadingHtml + imagePageHtml(figures), splittable: false }]
  }

  // 幻灯片面包屑路径列表
  let slideBreadcrumbs = ref<string[]>([])
  // 树状导航数据
  let slideTree = ref<any[]>([])
  // 树状导航开关
  let navOpen = ref(false)
  /** 首次构建是否已完成：没完成时不要显示「无可演示内容」的空状态（否则开屏会闪一下） */
  const buildFinished = ref(false)
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
  // 缩放比例（0.5 ~ 2.0）；Ctrl + 滚轮可无级调节，用于看单页细节
  let zoomScale = ref(1)

  /** 设置缩放（夹在 0.5~2.0，保留两位小数）；缩回 1 后重新做一次自适应排版 */
  const setZoom = (v: number) => {
    const next = Math.max(0.5, Math.min(2, Math.round(v * 100) / 100))
    if (next === zoomScale.value) return
    zoomScale.value = next
    if (next === 1) scheduleLayoutPass(120)
  }

  /**
   * 每页的「实测适配系数」：估算系数（autoScales）只按字数估，铺不满或装不下都常见；
   * 页面上真正的可用高度只有排完版才知道，所以显示时按实测再微调一次，
   * 让文字尽量铺满整页（装得下就放大、溢出就缩小，缩放范围 0.7~2.6）。
   */
  const fitScales = ref<number[]>([])
  const slideScale = (index: number | string) => {
    const i = Number(index)
    return (autoScales.value[i] || 1) * (fitScales.value[i] || 1)
  }

  // ===== 隐藏量测台：翻页前先把这一页的字号量好 =====
  // 估算系数只按字数算，铺不满或装不下都常见；而「显示之后再按实测调字号」会让页面明显伸缩一下。
  // 所以这里放一块与真实幻灯片**同结构同尺寸**的隐藏量测台（见模板 .slide-wrapper.measure-wrapper），
  // 目标页显示之前就在里面把字号逼近到位 → 页面一出来就是最终字号。
  const measureWrapperRef = ref<HTMLElement | null>(null)
  const measureBodyRef = ref<HTMLElement | null>(null)
  const measureHtml = ref('')
  const measureBreadcrumb = ref('')
  /** 量测台里当前是第几页（字号跟着它的 fitScales 走，改一次就自动重排一次） */
  const measureIndex = ref(-1)
  const measureFontEm = computed(() => (measureIndex.value >= 0 ? slideFontEm(measureIndex.value) : 1))
  /** 每页的实测系数是否已算好（fitScales 里的 1 既可能是默认值，也可能是「算出来正好是 1」） */
  const fitReady = ref<boolean[]>([])
  /** 内容构建代数：每次重建 +1，用于丢弃「量到一半内容被换掉」的结果 */
  let buildGeneration = 0
  /** 上次量测所用的基准（见 fitBasis / syncFitBasis） */
  let fitBasisKey = ''

  const changeRatio = (mode: string) => {
    if (ratioMode.value === mode) return
    ratioMode.value = mode
    // 幻灯片比例变了 → 图片形状的判定基准跟着变，需要重新排版（停在原来那一页）
    void rebuildKeepingSlide()
  }
  const zoomIn = () => setZoom(zoomScale.value + 0.1)

  const zoomOut = () => setZoom(zoomScale.value - 0.1)

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
    void (async () => {
      await init()
      showIndex.value = 0
      // 重建后先把第 1 页量好，避免显示后再伸缩
      await ensureFitScale(0)
      await nextTick()
      renderMermaid()
      renderDrawio()
    })()
  }

  // 全屏
  const toggleFullscreen = () => {
    // 用组件自己的容器：全局 querySelector 在多实例（应用内多窗口 / 分屏）时会全屏到别人身上
    const el = pptContainerRef.value
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
  /** 全屏切换后布局尺寸变化，面板需要重新贴回按钮上方；同时开始 / 结束沉浸计时 */
  const repositionThemePanel = () => {
    if (showThemeSettings.value) setTimeout(() => updateThemePanelPos(), 80)
  }
  const onFullscreenChange = () => {
    repositionThemePanel()
    syncFullscreenChrome()
  }

  // 窗口/容器自适应系数：字号因子随可用区域缩放（与手动 zoomScale 相乘）。
  // 以宽 1300px / 高 820px 为基准 1.0，窗口放大则字放大、缩小则字缩小。
  const viewScale = ref(1)
  const refreshViewScale = () => {
    nextTick(() => {
      const root = pptContainerRef.value
      if (!root) { viewScale.value = 1; return }
      // 用隐藏量测台（与真实幻灯片同尺寸，且总览打开时也在）作基准：可用区域大小不随总览开合跳变
      const wrapper = measureWrapperRef.value || root.querySelector<HTMLElement>('.slide-wrapper')
      const el = (wrapper && wrapper.clientWidth) ? wrapper : root
      const w = el.clientWidth || root.clientWidth
      const h = el.clientHeight || root.clientHeight
      const s = Math.min(w / 1300, h / 820)
      // 窗口变小不再把字压到 0.55（那是「压缩太多」的主因），下限抬到 0.72
      viewScale.value = Math.min(1.6, Math.max(0.72, s))
      // 幻灯片 em 基准（.slide 的内联 font-size 就是相对它算的）——字号保底要用
      const base = parseFloat(getComputedStyle(root).fontSize) || 0
      emBasePx.value = Number.isFinite(base) && base > 0 ? base : 16
      // 容器尺寸变了（窗口缩放 / 全屏 / 目录展开）→ 基准变了，缓存作废，按实测重新适配字号
      scheduleLayoutPass(260)
      scheduleFitPrefetch(360)
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
    const raw = 1.4 * zoomScale.value * viewScale.value * slideScale(index)
    const minEm = MIN_SLIDE_FONT_PX / (emBasePx.value || 16)
    return Math.max(raw, minEm)
  }
  /** 总览缩略图字号（固定 0.5 倍，不加保底——缩略图本来就该小） */
  const overviewFontEm = (index: number | string) =>
    0.5 * 1.4 * zoomScale.value * viewScale.value * slideScale(index)
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

  /**
   * 主幻灯片元素（排除总览缩略图与隐藏量测台）。
   *
   * 隐藏量测台（见模板里的 .measure-wrapper / .measure-slide）与真实幻灯片同结构同尺寸，
   * 所以凡是要「找当前真正显示的那一页」的地方都必须把它排除掉。
   */
  const currentSlideEl = (): HTMLElement | null =>
    (pptContainerRef.value?.querySelector(
      '.slide:not(.overview-slide-real):not(.measure-slide)',
    ) as HTMLElement | null) || null

  /** 主幻灯片的正文区（.slide-body：真正滚动 / 承载内容的那一层） */
  const currentSlideBody = (): HTMLElement | null => {
    const slide = currentSlideEl()
    return (slide?.querySelector(':scope > .slide-body') as HTMLElement | null) || null
  }

  // 获取当前幻灯片中可滚动的容器（在组件根元素范围内查找）
  const getScrollContainer = (): HTMLElement | null => {
    const root = pptContainerRef.value
    if (!root) return null
    // 排除总览网格中的 .overview-slide-real，只找主幻灯片的 .slide
    const slide = currentSlideEl()
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
    // Ctrl（或 ⌘）+ 滚轮：缩放当前页看细节，不翻页
    if (e.ctrlKey || e.metaKey) {
      const dy = normalizeWheel(e)
      if (!dy) return
      e.preventDefault()
      wheelAccum = 0
      setZoom(zoomScale.value + (dy < 0 ? 0.05 : -0.05))
      return
    }
    if (showOverview.value || animating.value) { wheelAccum = 0; return }
    // 目录 / 主题面板 / 总览 / 大图查看器内的滚动不参与翻页
    // （查看器的 @wheel.prevent 只挡默认行为、不挡冒泡，漏掉它会在缩放图片时把页面翻走）
    const target = e.target as HTMLElement | null
    if (target?.closest('.nav-panel, .theme-settings, .overview-grid, .mermaid-viewer-overlay')) {
      wheelAccum = 0
      return
    }
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
    const base = navTarget >= 0 ? navTarget : Number(showIndex.value)
    const next = base + dir
    if (next < 0 || next > prepList.value.length - 1) return
    goToSlide(next)
  }

  // 上一页 / 下一页（键盘、底部按钮、触屏滑动共用）：先算好目标页字号再切，见 stepSlide / goToSlide
  const goPrevSlide = () => stepSlide(-1)
  const goNextSlide = () => stepSlide(1)

  /**
   * 当前焦点是否在「正在输入」的地方（输入框 / 文本域 / 下拉 / 可编辑块）。
   *
   * 演示视图的键盘监听挂在 window 上，不做这个判断就会把应用里搜索框、智能体输入框的方向键
   * 一并抢走（与 md_mind / PdfViewer / view_image 等视图同一套判断）。
   */
  const isTypingTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null
    if (!el) return false
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  }

  /** Mermaid 大图查看器是否开着（开着时键盘 / 滚轮都归它，不要翻页） */
  const mermaidViewerOpen = () => !!mermaidViewerRef.value?.isOpen?.()

  /** 焦点是否在可交互控件上（按钮 / 链接 / 输入）：空格、回车要留给它们自己 */
  const isInteractiveTarget = (target: EventTarget | null): boolean =>
    !!(target as HTMLElement | null)?.closest?.('button, a, input, textarea, select, [contenteditable="true"]')

  /** Esc 的退让顺序：大图查看器 → 主题面板 → 总览 → 目录 → 退出全屏 */
  const handleEscape = () => {
    if (mermaidViewerOpen()) {
      mermaidViewerRef.value?.close?.()
      return
    }
    if (showThemeSettings.value) {
      showThemeSettings.value = false
      return
    }
    if (showOverview.value) {
      showOverview.value = false
      return
    }
    if (navOpen.value) {
      navOpen.value = false
      return
    }
    if (document.fullscreenElement) void document.exitFullscreen?.()?.catch?.(() => {})
  }

  // 键盘控制：上下键滚动当前页，左右 / 空格 / PageUp / PageDown 翻页，Home / End 首末页
  const handleKeydown = (e: KeyboardEvent) => {
    // 有键盘动作就说明人在用：先把全屏里淡出的工具栏叫回来
    wakeChrome()
    // 输入框 / 文本域里打字：一概不接管（否则方向键会变成翻页，没法移动光标）
    if (isTypingTarget(e.target)) return
    // 大图查看器开着：只有 Esc（关掉它）交给这里，其余按键不动页面
    if (mermaidViewerOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleEscape()
      }
      return
    }
    if (e.key === 'Escape') {
      handleEscape()
      return
    }
    // Ctrl / ⌘ + 0：把缩放复位（看细节后一键回到正常排版）
    if ((e.ctrlKey || e.metaKey) && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
      e.preventDefault()
      setZoom(1)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // 翻页键：方向键、空格、回车、PageUp / PageDown（翻页笔与遥控器多发 PageUp / PageDown）
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault()
      goNextSlide()
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault()
      goPrevSlide()
    } else if ((e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') && !isInteractiveTarget(e.target)) {
      e.preventDefault()
      goNextSlide()
    } else if (e.key === 'Home') {
      e.preventDefault()
      goToSlide(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      goToSlide(prepList.value.length - 1)
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

  // 触屏：左右滑动翻页（触屏手机 / 平板；总览网格里不翻页，
  // 代码块等横向可滚动区域先滚到边缘，再滑动才翻页 —— 与滚轮翻页规则一致）
  useSwipeNav(pptContainerRef, {
    enabled: () => !showOverview.value,
    ignore: '.toolbar, .nav-panel, .theme-settings, .overview-grid, .mermaid-viewer-overlay',
    respectInnerScrollX: true,
    onSwipeLeft: goNextSlide,
    onSwipeRight: goPrevSlide,
  })

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

  /** 该段是否只有标题、下面没有任何正文（如「## 4. 结论与局限」紧跟「### 4.1 结论」） */
  function isHeadingOnlySection(section: string): boolean {
    const lines = section.trim().split('\n')
    if (!lines.length || !/^#{1,6}\s/.test(lines[0].trim())) return false
    return !lines.slice(1).some((l) => l.trim() && !l.trim().startsWith('#'))
  }

  /**
   * 纯标题段与其后一段合并成同一页（标题仍作为该页标题与面包屑）。
   *
   * 否则「## 4. 结论与局限」（下面没有正文）会单独占一页，页面上只有一个标题，很浪费；
   * 末尾若仍是纯标题段则保持原样（没有可合并的内容，标题页总比丢掉好）。
   */
  function mergeHeadingOnlySections(sections: string[]): string[] {
    const out: string[] = []
    let pending: string[] = []
    for (const section of sections) {
      if (isHeadingOnlySection(section)) {
        pending.push(section.trim())
        continue
      }
      out.push(pending.length ? pending.join('\n\n') + '\n\n' + section : section)
      pending = []
    }
    if (pending.length) out.push(pending.join('\n\n'))
    return out
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
    // 没有激活文件（或标签被关掉）时也给个空对象：这样会走到「没有可演示的内容」的空状态，
    // 而不是在这里抛异常、把整个视图停在空白上
    data = store.data[store.index] || {}
    if(data.content==undefined) data.content=""
    // 内容真的换了：清掉上一份内容留下的「容量收紧 / 溢出重建」记录
    if (currentSourceKey() !== lastRenderedSourceKey) {
      sectionTighten.clear()
    }
    // 每次重建最多再修 2 页（防止一次构建里反复重建）：逐次翻页会继续收敛，
    // 且每段只收紧一次，所以不会来回抖动
    overflowRebuilds = 0
    // 先构建到局部数组，全部就绪后一次性替换：
    // 重建（改比例 / 溢出收紧 / 外部改动）期间旧的那套幻灯片仍可正常翻页，
    // 否则中途 prepList 只有一两页，左右键会「按不动」。
    const firstBuild = prepList.value.length === 0
    const slides: string[] = []
    const breadcrumbs: string[] = []
    const scales: number[] = []
    const keys: string[] = []
    const splittables: boolean[] = []
    /** 构建完成后原子替换 */
    const commit = () => {
      prepList.value = slides
      slideBreadcrumbs.value = breadcrumbs
      autoScales.value = scales
      // 新的页集合：实测适配系数重新开始（访问到哪一页就为哪一页收敛）
      fitScales.value = new Array(slides.length).fill(1)
      fitReady.value = new Array(slides.length).fill(false)
      // 内容重建过：正在量测中的那一页作废（否则会拿旧内容的测量结果标记「已算好」）
      buildGeneration += 1
      slideKeys = keys
      slideSplittable = splittables
      slideTree.value = buildTree(allHeadings)
    }
    let allHeadings: { level: number; text: string; slideIndex: number }[] = []
    if(data.extension==".md"||data.extension==""){
      // 去除 YAML frontmatter，避免内容页显示元信息
      const content = data.content.replace(/^\s*---[\s\S]*?---\s*\n?/, '')
      // 切分幻灯片：先按 --- 分隔，过长的段再按原规则二次切分
      const MAX_SLIDE_LINES = 18
      let sections = splitSections(content, MAX_SLIDE_LINES)
      // 纯标题段（下面没有正文）与其后一段合并，避免出现只有标题的空白页；
      // `---` 模式是用户显式分页，保持原样
      if (splitMode.value === 'smart') sections = mergeHeadingOnlySections(sections)

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
        slides.push(coverHtml)
        keys.push('cover')
        splittables.push(false)
        breadcrumbs.push('')
        scales.push(1) // 封面页内部已有大标题排版，不额外缩放
        // 首次打开：先把封面挂上，长文档构建期间不至于一片空白（构建完成后再整体替换）
        if (firstBuild) {
          prepList.value = [coverHtml]
          slideBreadcrumbs.value = ['']
          autoScales.value = [1]
          fitScales.value = [1]
          fitReady.value = [false]
          slideKeys = ['cover']
          slideSplittable = [false]
        }
      }

      // 标题层级栈
      const headingStack: { level: number; text: string }[] = []

      // 设置图片相对路径的基目录
      if (data.path) {
        const normalizedPath = data.path.replace(/\\/g, '/')
        const lastSlash = normalizedPath.lastIndexOf('/')
        mdBasePath = lastSlash >= 0 ? normalizedPath.substring(0, lastSlash + 1) : ''
      } else {
        mdBasePath = ''
      }

      // 智能切分模式才自动分页；`---` 模式尊重用户在 Markdown 里写的显式分页
      const allowSplit = splitMode.value === 'smart'
      let sectionIdx = 0
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
        // 从原始文本第一行提取标题：**先更新标题栈**，因为面包屑要在建页之前算出来
        // （图片页据此判断「标题已在最上方的面包屑里」，从而省掉页内重复的标题）
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
          // 只有这一节的第一页登记标题：续页 / 图片页共用同一个面包屑，目录里也不会出现重复项
          allHeadings.push({ level, text, slideIndex: slides.length })
        }

        // 面包屑路径，直接用标题文本
        const breadcrumb = headingStack.map(h => h.text).join(' / ')

        // 智能排版：按图片长宽选布局（同形 → 图片独占一页 / 竖图 → 左右 / 宽图 → 上下），
        // 文字过多时自动分页，一段可能变成多张幻灯片
        const sectionKey = `${sectionIdx++}|${section.trim().slice(0, 48)}`
        const parts = await buildSlideParts(renderedContent, sectionKey, allowSplit, !!breadcrumb)

        for (const part of parts) {
          slides.push(part.html)
          keys.push(sectionKey)
          splittables.push(part.splittable)
          breadcrumbs.push(breadcrumb)
          scales.push(calcAutoScale(part.html, false)) // 按该页内容密度设置字号因子
        }
        // debug: 检查当前幻灯片是否包含 mermaid
        if (renderedContent.includes('mermaid')) {
          console.log('[PPT] slide包含mermaid, 前80字符:', renderedContent.substring(0, 80))
        }
      }
    }
    commit()
    // 记录本次构建来源（路径+内容），供 refreshPpt 去重
    lastRenderedSourceKey = currentSourceKey()
    buildFinished.value = true
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
      const res = await getPlatform().host.python.execute({ code, environment, input: '' })
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
  /**
   * 渲染指定容器里所有待渲染的 Mermaid。
   * root 传幻灯片容器（跳过隐藏量测台）或量测台本身（导出 PDF 时要把图表真画出来）。
   */
  const renderMermaidIn = async (root: HTMLElement | null | undefined, opts: { ignore?: string } = {}) => {
    await nextTick()
    if (!root) return
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.mermaid:not([data-processed])')).filter(
      (n) => !opts.ignore || !n.closest(opts.ignore),
    )
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

  /** 渲染当前显示页里的 Mermaid（隐藏量测台里的留到导出时再画，避免每页画两遍） */
  const renderMermaid = () => renderMermaidIn(pptContainerRef.value, { ignore: '.measure-wrapper' })

  /**
   * 内嵌图表（`![](图.drawio)`）渲染：把图表占位卡片填成 SVG。
   * 与 mermaid 同源——slide 用 v-if 每次进入都会重建，所以每次翻页 / 重建后都要重跑一次
   * （渲染器自带内容哈希缓存，同一份图表不会重复渲染）。
   */
  const renderDrawio = () => {
    void renderDrawioFigures(pptContainerRef.value, {
      zh: store.locales === 'zh',
      // 隐藏量测台里的图表占位不渲染（只用来量高度，真图由显示出来的那一页渲染）
      ignore: '.measure-wrapper',
    }).then(() => {
      // 图表填进占位后这页的高度才算最终确定 → 稍后统一跑「裁表格 + 溢出检查」
      scheduleLayoutPass(700)
    })
  }

  /**
   * 超长表格：**尽量不跨页拆分**（拆成两页的表格没人看得懂），改为按实际可放高度裁行——
   * 保留表头与放得下的行，末尾标出省略了多少行（完整表格看浏览视图 / 导出文件）。
   * 只裁「的确放不下」的那张表：按表的顶边到正文底边的实际空间算，页面被别的长内容占满时不裁。
   */
  const trimOverflowingTables = () => {
    const body = currentSlideBody()
    if (!body || body.clientHeight < 60) return
    const bodyBottom = body.getBoundingClientRect().bottom
    const zh = store.locales === 'zh'
    for (const table of Array.from(body.querySelectorAll<HTMLTableElement>('table'))) {
      const top = table.getBoundingClientRect().top
      // 整张表都在可视区之外：说明前面的内容已经占满，交给自动分页处理
      if (top >= bodyBottom - 4) break
      // 提示文字也要占一行高度，先留出来
      const available = bodyBottom - top - 26
      const rows = () => {
        const tbody = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'))
        return tbody.length ? tbody : Array.from(table.querySelectorAll<HTMLTableRowElement>('tr')).slice(1)
      }
      const rowH = Math.max(1, (rows()[0] || table).getBoundingClientRect().height)
      // 塞不下三行说明这一页主要被别的内容占了，裁表没有意义
      if (available < rowH * 3 || table.offsetHeight <= available) continue
      let guard = 0
      let removed = 0
      while (table.offsetHeight > available && guard < 400) {
        const list = rows()
        if (list.length <= 1) break
        const cut = Math.max(1, Math.min(list.length - 1, Math.ceil((table.offsetHeight - available) / rowH)))
        for (let i = 0; i < cut; i++) {
          const r = list[list.length - 1 - i]
          if (!r) break
          r.remove()
          removed += 1
        }
        guard += 1
      }
      if (!removed) continue
      const note = document.createElement('div')
      note.className = 'slide-table-trimmed'
      note.textContent = zh
        ? `表格过长，已省略 ${removed} 行（完整数据见浏览视图）`
        : `Table trimmed: ${removed} rows omitted (see Browse view for all rows)`
      table.insertAdjacentElement('afterend', note)
    }
  }

  /**
   * 运行期兜底：文字长度只是估算，代码块 / 表格 / 公式 / 图片的实际高度只有排完版才知道。
   * 当前页真的装不下、且这一页还能再分页时，把该段容量收紧一档并重建（内容自动多分一页）；
   * 每段最多收紧一次、每轮构建最多重建两次，并保持用户停留的那一页，避免翻页"被弹回去"。
   */
  const checkSlideOverflow = () => {
    if (showOverview.value || animating.value) return
    const idx = Number(showIndex.value)
    if (!slideSplittable[idx]) return
    const key = slideKeys[idx]
    if (!key || (sectionTighten.get(key) || 0) >= 1 || overflowRebuilds >= 2) return
    const body = currentSlideBody()
    if (!body || body.clientHeight < 40) return
    // 图本身已占满整页（它就该独占一页）：拆文字救不了，这不是「文字溢出」
    const pageSizedFigure = Array.from(body.querySelectorAll<HTMLElement>('figure')).some(
      (f) => f.getBoundingClientRect().height > body.clientHeight * 0.92,
    )
    if (pageSizedFigure) return
    // 只要真的溢出了（>8px，即最后一行被切）就收紧一档；装得下时不动
    if (body.scrollHeight - body.clientHeight <= 8) return
    sectionTighten.set(key, (sectionTighten.get(key) || 0) + 1)
    overflowRebuilds += 1
    // 记住用户停在这一节的第几页，重建后停在同样的位置（而不是被弹回本节第一页）
    const partOffset = idx - slideKeys.indexOf(key)
    void rebuildKeepingSlide(key, partOffset)
  }

  /**
   * 「先裁表格、再按实测调字号、最后查溢出」的统一入口：必须等翻页动画结束
   * （动画期间幻灯片是绝对定位，高度量不准）、图表填进占位之后再量。
   * 重复调用只保留最后一次。
   */
  const scheduleLayoutPass = (delay = 700) => {
    if (overflowTimer) clearTimeout(overflowTimer)
    overflowTimer = setTimeout(() => {
      overflowTimer = null
      if (showOverview.value || animating.value) {
        scheduleLayoutPass(320)
        return
      }
      trimOverflowingTables()
      // 纯文字页的字号在翻页前就算好了 → 不再延期重排（否则页面显示约一秒后又伸缩一下，看起来像闪烁）；
      // 含图 / 图表的页（图是显示后才填进占位的）以及没来得及预算的页，仍然要量一次收尾
      syncFitBasis()
      const body = currentSlideBody()
      if (pageNeedsPostFit(body) || !fitReady.value[Number(showIndex.value)]) {
        void autoFitCurrentSlide().then(() => {
          trimOverflowingTables()
          checkSlideOverflow()
        })
      } else {
        checkSlideOverflow()
      }
    }, delay)
  }

  /** 内容实际用掉的高度（未溢出时布局容器会撑满，得往里找文字块） */
  const contentUsedHeight = (body: HTMLElement): number => {
    const bodyTop = body.getBoundingClientRect().top
    let bottom = bodyTop
    for (const kid of Array.from(body.children) as HTMLElement[]) {
      const el = kid.querySelector<HTMLElement>('.slide-layout-text, .slide-layout-textblocks') || kid
      const r = el.getBoundingClientRect()
      const mb = parseFloat(getComputedStyle(el).marginBottom) || 0
      bottom = Math.max(bottom, r.bottom + mb)
    }
    return bottom - bodyTop
  }

  /**
   * 等一帧（rAF，带上超时兜底）：窗口被隐藏 / 最小化时 rAF 会被节流甚至不触发，
   * 只等 rAF 会让后面的排版流程整条卡住，所以必须有超时兜底。
   */
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      const timer = window.setTimeout(finish, 60)
      try {
        requestAnimationFrame(() => {
          window.clearTimeout(timer)
          finish()
        })
      } catch {
        window.clearTimeout(timer)
        finish()
      }
    })

  /**
   * 量测基准：幻灯片可用盒子 + 比例 / 缩放 / 字号基准。
   * 基准一变（窗口缩放、全屏、比例切换、目录开关、缩放比例），已算好的实测系数就都不作数了。
   */
  const fitBasis = () => {
    const host = measureWrapperRef.value
    const w = host?.clientWidth || 0
    const h = host?.clientHeight || 0
    return `${w}x${h}|${ratioMode.value}|${zoomScale.value.toFixed(2)}|${viewScale.value.toFixed(3)}|${emBasePx.value.toFixed(2)}`
  }
  /** 基准变了：缓存的实测系数全部作废，下次显示某页前重算（不强改当前页，避免无谓跳动） */
  const syncFitBasis = () => {
    const key = fitBasis()
    if (key === fitBasisKey) return
    fitBasisKey = key
    fitReady.value = new Array(prepList.value.length).fill(false)
    // 尺寸已经不是量它时的尺寸了：正在量测中的那一页也作废
    buildGeneration += 1
  }
  /** 写某一页的适配系数（整体替换数组，保证响应式） */
  const setFitScale = (index: number, value: number) => {
    const arr = fitScales.value.slice()
    arr[index] = value
    fitScales.value = arr
  }
  /** 标记某页的实测系数已算好 */
  const markFitReady = (index: number) => {
    const arr = fitReady.value.slice()
    arr[index] = true
    fitReady.value = arr
  }
  /** 这一页显示之后高度还会变（图片 / drawio / mermaid 都是显示后才填进占位的）→ 字号得等它们 */
  const pageNeedsPostFit = (body: HTMLElement | null) => !!body?.querySelector('figure, .mermaid, img')
  /** 同上，但输入是渲染好的 HTML（预算字号时用，拿不到 DOM） */
  const htmlHasLateFigure = (html: string) => /<figure|class="[^"]*mermaid|<img[\s>]/i.test(html)

  /**
   * 按实测把某一页字号逼近到「刚好铺满」（0.7~2.6 倍，最多 iterations 次）。
   *
   * bodyEl 既可以是隐藏量测台里的正文区（翻页前预排版），也可以是可见页的 —— 两者同结构同尺寸，
   * 量法完全一样，所以共用这一份实现。
   */
  const fitBodyIteratively = async (
    bodyEl: HTMLElement,
    index: number,
    opts: { allowGrow: boolean; resetFirst: boolean; iterations?: number; aggressive?: boolean },
  ) => {
    const iterations = opts.iterations ?? 6
    // 先把之前可能过冲的系数收回来，再按实测逼近（避免上一轮留下的溢出一直存在）
    if (opts.resetFirst && (fitScales.value[index] || 1) > 1) setFitScale(index, 1)
    for (let i = 0; i < iterations; i++) {
      await nextTick()
      await nextFrame()
      const h = bodyEl.clientHeight
      if (!h) break
      const overflowing = bodyEl.scrollHeight > h + 1
      const used = overflowing ? bodyEl.scrollHeight : contentUsedHeight(bodyEl)
      if (!used) break
      const ratio = h / used
      // 已经贴合（差 3% 以内）就收手：既不留明显空白，也不切掉最后一行
      if (ratio >= 0.97 && ratio <= 1.01) break
      if (!overflowing && !opts.allowGrow) break // 图占位时只缩小、不放大
      const cur = fitScales.value[index] || 1
      const raw = ratio * 0.99
      /**
       * 目标：内容高度 ≈ 可用高度。
       * - 可见页（默认）：放大 / 缩小都限幅（0.8~1.15 / 0.75~0.95），单步幅度小 → 不会看着来回震荡；
       * - 隐藏量测台（aggressive）：放手按实测比例走（0.62~1.6），过冲了下一轮就修回来。
       *   稀疏页（整页只有一句话）用保守步子要迭代七八次才收敛，翻页会明显变慢。
       */
      const step = opts.aggressive
        ? Math.min(1.6, Math.max(0.62, raw))
        : overflowing
          ? Math.min(0.95, Math.max(0.75, raw))
          : Math.min(1.15, Math.max(0.8, raw))
      const next = Math.max(0.7, Math.min(2.6, cur * step))
      if (Math.abs(next - cur) < 0.012) break
      setFitScale(index, next)
    }
    // 收尾保底：迭代结束仍溢出（步长限幅导致）就按实测比例再收一次，绝不留最后一行被切
    await nextTick()
    await nextFrame()
    const hEnd = bodyEl.clientHeight
    const overEnd = hEnd ? bodyEl.scrollHeight - hEnd : 0
    if (overEnd > 1) {
      const cur = fitScales.value[index] || 1
      const next = Math.max(0.7, Math.min(2.6, cur * (hEnd / bodyEl.scrollHeight) * 0.99))
      if (next < cur - 0.005) setFitScale(index, next)
    }
  }

  /** 正在量测的页（预排版与可见页收尾不会同时对同一页动手） */
  const fitBusy = new Set<number>()
  /** 量测台只有一块：所有量测排队执行，避免两次量测互相把里面的内容换掉 */
  let measureQueue: Promise<void> = Promise.resolve()
  const measureExclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = measureQueue.then(task, task)
    measureQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 在隐藏量测台里把第 index 页的字号适配算好。
   *
   * 这是「翻页不再伸缩」的关键：页面显示之前字号就已经是最终值，显示后不需要再调。
   * 已经算过（且量测基准没变）直接返回；量不了（缩放看细节 / 总览打开）也不阻塞翻页。
   */
  const ensureFitScale = (index: number): Promise<void> => {
    const i = Number(index)
    if (!Number.isFinite(i) || i < 0 || i >= prepList.value.length) return Promise.resolve()
    if (zoomScale.value !== 1 || showOverview.value) return Promise.resolve()
    // 先看量测基准有没有变：变了就把缓存的实测系数作废，否则会拿「按旧尺寸算的」结果直接返回
    syncFitBasis()
    if (fitReady.value[i] || fitBusy.has(i)) return Promise.resolve()
    return measureExclusive(async () => {
      // 排队期间基准可能又变了（窗口缩放），进来再确认一次
      syncFitBasis()
      if (fitReady.value[i] || fitBusy.has(i) || i >= prepList.value.length) return
      const body = measureBodyRef.value
      if (!body) return
      fitBusy.add(i)
      const gen = buildGeneration
      try {
        const html = prepList.value[i] || ''
        measureIndex.value = i
        measureHtml.value = html
        measureBreadcrumb.value = slideBreadcrumbs.value[i] || ''
        // 量测台的字号跟着 fitScales[i] 走（见 measureFontEm），所以每次 setFitScale 都会重排
        await nextTick()
        await nextFrame()
        // 含图 / 图表的页在量测台里只有占位（真图是显示后才填进去的）→ 只缩小、不放大；
        // 剩下的偏差由显示后的实测收尾处理
        const allowGrow = !htmlHasLateFigure(html)
        // 先放开步子快速逼近，再用保守步子收到「刚好贴合」（都不在屏幕上，看不见过程）
        await fitBodyIteratively(body, i, { allowGrow, resetFirst: false, iterations: 4, aggressive: true })
        await fitBodyIteratively(body, i, { allowGrow, resetFirst: false, iterations: 3 })
        // 量测台当时没有布局尺寸（视图被切到后台等）→ 这次量测无效：不标记「已算好」，
        // 显示后的实测收尾照旧会兜住，文字也不会因为把 0 当成「刚好」而永远铺不满
        if (body.clientHeight <= 0) {
          console.warn('[PPT] 量测台没有布局尺寸，跳过本页字号预排版:', i + 1)
          return
        }
        // 量测期间内容被重建过（改文件 / 换标签）→ 这次结果作废，别标记成已算好
        if (gen === buildGeneration) markFitReady(i)
      } finally {
        fitBusy.delete(i)
      }
    })
  }

  /**
   * 可见页的实测收尾：**只有**「含图 / 图表」或「没来得及预算」的页才需要跑。
   * 纯文字页在翻页前已经量好，这里直接跳过 —— 否则页面显示约一秒后又为铺满而伸缩，看起来像闪烁。
   */
  let fitRunning = false
  const autoFitCurrentSlide = async (iterations = 6) => {
    if (fitRunning || showOverview.value || animating.value || zoomScale.value !== 1) return
    const body = currentSlideBody()
    if (!body || body.clientHeight < 40) return
    const idx = Number(showIndex.value)
    syncFitBasis()
    // 有整页图片 / 图表时不放大：图由容器定尺寸，放大文字只会把图挤小
    const hasFigure = pageNeedsPostFit(body)
    if (!hasFigure && (fitReady.value[idx] || fitBusy.has(idx))) return
    fitRunning = true
    try {
      await fitBodyIteratively(body, idx, { allowGrow: !hasFigure, resetFirst: true, iterations })
      markFitReady(idx)
    } finally {
      fitRunning = false
    }
  }

  // ===== 翻页：先把目标页的字号算好，再切过去 =====
  /** 连续按键 / 滑动时以「最后一次请求的目标」为基准推进（预排版是异步的，不能等 showIndex 更新） */
  let navTarget = -1
  let navQueue: Promise<void> = Promise.resolve()

  /** 翻到指定页（键盘 / 按钮 / 滚轮 / 滑动 / 目录共用）：先预算目标页字号，再显示 */
  const goToSlide = (target: number) => {
    const count = prepList.value.length
    if (!count) return
    const idx = Math.max(0, Math.min(count - 1, Math.round(Number(target) || 0)))
    navTarget = idx
    navQueue = navQueue
      .then(async () => {
        await ensureFitScale(idx)
        if (navTarget === idx) navTarget = -1
        showIndex.value = idx
      })
      .catch(() => {
        /* 量测失败也要能翻页 */
        showIndex.value = idx
      })
  }

  /** 上一页 / 下一页：按最后一次请求的目标走，连按也能逐页推进 */
  const stepSlide = (dir: 1 | -1) => {
    const base = navTarget >= 0 ? navTarget : Number(showIndex.value)
    goToSlide(base + dir)
  }

  /** 预取相邻页的字号：翻页时直接就有结果，不必等量测（用户翻页通常比量测慢得多） */
  let fitPrefetchTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleFitPrefetch = (delay = 260) => {
    if (fitPrefetchTimer) clearTimeout(fitPrefetchTimer)
    fitPrefetchTimer = setTimeout(() => {
      fitPrefetchTimer = null
      void (async () => {
        const cur = Number(showIndex.value)
        // 当前页（重建 / 缩放后收尾）→ 下一页 → 上一页
        for (const i of [cur, cur + 1, cur - 1]) await ensureFitScale(i)
      })()
    }, delay)
  }

  // ===== 全屏沉浸：空闲时淡出工具栏与进度条（鼠标一动就回来）=====
  /** 空闲多久开始淡出 */
  const CHROME_IDLE_MS = 2600
  const isFullscreen = ref(false)
  const chromeHidden = ref(false)
  let chromeTimer: ReturnType<typeof setTimeout> | null = null
  /** 唤醒工具栏并重新计时（鼠标移动 / 按键 / 切页时调用） */
  const wakeChrome = () => {
    chromeHidden.value = false
    if (chromeTimer) clearTimeout(chromeTimer)
    if (!isFullscreen.value) return
    chromeTimer = setTimeout(() => {
      // 面板 / 查看器开着时不淡出：用户正要操作它们
      if (showOverview.value || showThemeSettings.value || navOpen.value || mermaidViewerOpen()) return
      chromeHidden.value = true
    }, CHROME_IDLE_MS)
  }
  /** 全屏状态变化：进入全屏开始计时，退出立刻恢复工具栏 */
  const syncFullscreenChrome = () => {
    isFullscreen.value = !!document.fullscreenElement
    if (!isFullscreen.value) {
      if (chromeTimer) {
        clearTimeout(chromeTimer)
        chromeTimer = null
      }
      chromeHidden.value = false
      return
    }
    wakeChrome()
  }

  // ===== 跳页：点页码输入 / 点进度条 =====
  const pageInputOpen = ref(false)
  const pageInput = ref('')
  const pageInputRef = ref<HTMLInputElement | null>(null)
  const openPageInput = () => {
    if (!prepList.value.length) return
    pageInput.value = ''
    pageInputOpen.value = true
    void nextTick(() => pageInputRef.value?.focus())
  }
  const commitPageInput = () => {
    const n = parseInt(pageInput.value, 10)
    pageInputOpen.value = false
    if (Number.isFinite(n) && n >= 1) goToSlide(Math.min(prepList.value.length, n) - 1)
  }
  /** 点进度条任意位置 → 跳到对应页 */
  const seekByProgress = (e: MouseEvent) => {
    const bar = e.currentTarget as HTMLElement | null
    const n = prepList.value.length
    if (!bar || n <= 1) return
    const rect = bar.getBoundingClientRect()
    if (!rect.width) return
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    goToSlide(Math.round(ratio * (n - 1)))
  }

  // ===== 导出幻灯片 PDF（一页一张）=====
  const pdfBusy = ref(false)
  /** 打印页尺寸（mm）：A4 横向，四边留 0；页面盒再小 1mm，避免四舍五入挤出空白页 */
  const PDF_PAGE_W_MM = 296
  const PDF_PAGE_H_MM = 209
  const mmToPx = (mm: number) => (mm * 96) / 25.4

  /**
   * 导出页要用到的样式：把当前文档里的样式原样带上。
   *
   * 必须带上（至少是幻灯片正文用到的那部分）：导出文档若换了字体 / 字号口径，
   * 同样的文字会变高 → 正文溢出量测时量好的框 → 打印时整块不绘制（详见打印层里关于
   * 「滚动容器」的注释）。
   */
  const collectExportStyles = (): string => {
    const parts: string[] = []
    document.querySelectorAll('style').forEach((el) => {
      const css = el.textContent || ''
      if (css.trim()) parts.push(css)
    })
    if (!parts.length) console.warn('[PPT] 导出 PDF：没有取到样式，导出结果会比屏幕上朴素')
    return parts.join('\n')
  }

  /**
   * 把一页套成一份「单页打印文档」。
   *
   * 一页一份（而不是把整套放进一个 HTML）：Chromium 的打印分页会把「按页面尺寸缩放过的页面盒」
   * 再拆开，页数翻好几倍且关不掉；单页文档只会打印成一页，稳定可靠（合并交给主进程）。
   *
   * 返回 [文档头, 页面片段, 文档尾]：样式只随「文档头」走一份，避免每页都重复几百 KB 的 CSS。
   */
  const buildSlidePdfHtml = (pages: Array<{ html: string; w: number; h: number }>): { head: string; slides: string[]; tail: string } => {
    const pageW = mmToPx(PDF_PAGE_W_MM)
    const pageH = mmToPx(PDF_PAGE_H_MM)
    const themeClass = document.documentElement.className || ''
    const bodyClass = document.body.className || ''
    // 应用把主题变量写成 <html> 上的内联样式（--backgroundColor / --fontColor …）：
    // 不带过去的话，导出文档里这些变量是空的，幻灯片会丢掉主题底色与文字颜色
    const rootVars = document.documentElement.getAttribute('style') || ''
    // 幻灯片字号是 em（相对 .ppt-container 的字号）：导出文档里必须给出同一个基准，否则排版会变。
    // 字体也必须一致：导出文档若换一套字体，同样的文字会变高 → 正文溢出 → 打印时整块不绘制
    // （见打印层里关于「滚动容器」的注释）
    const slideStyle = currentSlideEl() ? getComputedStyle(currentSlideEl()!) : null
    const baseFont = `${emBasePx.value || 16}px`
    const fontFamily = slideStyle?.fontFamily || 'inherit'
    const lineHeight = slideStyle?.lineHeight || '1.7'
    const slides = pages.map((p) => {
      const w = Math.max(1, p.w)
      const h = Math.max(1, p.h)
      const k = Math.min(pageW / w, pageH / h)
      // .ppt-container[data-theme=...] 是各套幻灯片主题的作用域祖先（主题规则挂在它上面），必须带上
      const themed = `<div class="ppt-container" data-theme="${pptTheme.value}" style="font-size:${baseFont};font-family:${fontFamily};line-height:${lineHeight};width:${w}px;height:${h}px;background:none">${p.html}</div>`
      return (
        `<section class="pdf-page"><div class="pdf-fit" style="width:${(w * k).toFixed(2)}px;height:${(h * k).toFixed(2)}px">` +
        `<div class="pdf-raw" style="width:${w}px;height:${h}px;transform:scale(${k.toFixed(5)})">${themed}</div>` +
        `</div></section>`
      )
    })
    const head = `<!DOCTYPE html>
<html class="${themeClass}" style="${md.utils.escapeHtml(rootVars)}">
<head>
<meta charset="utf-8">
<title>${md.utils.escapeHtml(String(data?.label || 'slide'))}</title>
<style>${collectExportStyles()}</style>
<style>
  /* 打印层：A4 横向、无边距，一页一张幻灯片。
     这一层排在原样搬进来的 App 样式之后，用来压住应用外壳的
     html/body{height:100%;overflow:hidden} 之类规则（不压住就会只剩一页）。 */
  @page { size: A4 landscape; margin: 0; }
  html, body {
    margin: 0 !important; padding: 0 !important; background: #fff !important;
    width: auto !important; height: auto !important; min-height: 0 !important;
    max-height: none !important; overflow: visible !important;
    display: block !important; position: static !important; float: none !important;
  }
  .pdf-page {
    width: ${PDF_PAGE_W_MM}mm !important; height: ${PDF_PAGE_H_MM}mm !important;
    min-height: 0 !important; max-height: none !important;
    display: flex !important; flex-direction: row !important;
    align-items: center !important; justify-content: center !important;
    overflow: hidden !important; box-sizing: border-box !important;
    position: static !important; margin: 0 !important; padding: 0 !important;
    transform: none !important; visibility: visible !important; opacity: 1 !important;
    break-after: page; page-break-after: always;
  }
  .pdf-page:last-child { break-after: auto !important; page-break-after: auto !important; }
  /* 缩放后的盒子：绝对定位的原始尺寸内容按 transform 缩放（矢量内容不会糊） */
  .pdf-fit {
    position: relative !important; overflow: hidden !important;
    display: block !important; margin: 0 !important; padding: 0 !important;
    transform: none !important;
  }
  .pdf-raw {
    position: absolute !important; top: 0 !important; left: 0 !important;
    display: block !important; margin: 0 !important; padding: 0 !important;
    transform-origin: top left !important;
  }
  /* ⚠️ 关键：打印文档里不能出现「内容溢出的滚动容器」。
     Chromium 打印这种盒子时会整块不绘制（页面在、内容全空白，正是「导出的 PDF 全是空白页」的原因）。
     幻灯片在屏幕上正是靠 .slide / .slide-body 滚动（overflow-y:auto + 固定高度），
     所以导出时把它们改成「按内容撑开、不裁剪」；框高在 exportSlidesPdf 里已经按内容量好，
     内容装得下就不会溢出，也就不会跨页拆分。 */
  .pdf-raw .slide,
  .pdf-raw .slide-body {
    overflow: visible !important;
    max-height: none !important;
    min-height: 0 !important;
  }
  .pdf-raw .slide { height: 100% !important; }
  .pdf-raw .slide-body { height: auto !important; }
  /* 屏幕上的交互件不进 PDF */
  .python-run-bar, .python-result, .mermaid-clickable::after { display: none !important; }
</style>
</head>
<body class="${bodyClass}">
`
    return { head, slides, tail: '\n</body>\n</html>\n' }
  }

  /** 导出页的兜底尺寸（量不到量测台尺寸时用）：按当前比例给一个合理的幻灯片框 */
  const pdfFallbackBox = () => {
    const ratio = slideRatio()
    return ratio >= 1 ? { w: 1280, h: Math.round(1280 / ratio) } : { w: Math.round(960 * ratio), h: 960 }
  }

  /**
   * 量测台在导出时可能「没有布局尺寸」（视图处于隐藏 / 未布局状态时，clientWidth/Height 全是 0）。
   * 那种情况下按 0 尺寸算出来的缩放比会大到离谱，PDF 会整本空白（页数正常、内容看不见），
   * 所以这里必须判断并退回一个合理的幻灯片框。
   */
  const sanitizePdfBox = (w: number, h: number): { w: number; h: number; fallback: boolean } => {
    const ok = (v: number, lo: number) => Number.isFinite(v) && v >= lo
    if (ok(w, 200) && ok(h, 150) && w <= 20000 && h <= 20000) {
      return { w: Math.round(w), h: Math.round(h), fallback: false }
    }
    return { ...pdfFallbackBox(), fallback: true }
  }

  /**
   * 导出全部幻灯片为 PDF：逐页放进隐藏量测台（= 屏幕上的真实排版），
   * 量出实际尺寸后按页缩放，交给主进程的打印通道（隐藏窗口 printToPDF）落盘。
   */
  const exportSlidesPdf = async () => {
    const n = prepList.value.length
    const stage = measureWrapperRef.value
    if (!n || !stage || pdfBusy.value) return
    const zh = store.locales === 'zh'
    pdfBusy.value = true
    if (n > 3) ElMessage.info(zh ? `正在排版 ${n} 页幻灯片…` : `Laying out ${n} slides…`)
    try {
      const pages: Array<{ html: string; w: number; h: number }> = []
      /** 首页量到有效尺寸后固定用它（保证整本 PDF 尺寸一致）；量不到就整本用兜底尺寸 */
      let lockedBox: { w: number; h: number } | null = null
      for (let i = 0; i < n; i++) {
        const html = prepList.value[i] || ''
        measureIndex.value = i
        measureHtml.value = html
        measureBreadcrumb.value = slideBreadcrumbs.value[i] || ''
        await nextTick()
        await nextFrame()
        const slideEl = stage.querySelector<HTMLElement>('.measure-slide')
        if (!slideEl) continue
        // 兜底：万一 Vue 没把这一页写进量测台（渲染时机问题），直接把内容同步进 DOM，别导出空页
        const stageBody = slideEl.querySelector<HTMLElement>(':scope > .slide-body')
        if (stageBody && html && stageBody.innerHTML !== html) stageBody.innerHTML = html
        // 导出要真图：量测台平时跳过图表渲染，这里补上（同一份图表有缓存，通常很快）
        await renderMermaidIn(stage)
        await renderDrawioFigures(stage, { zh })
        await nextTick()
        await nextFrame()
        const measured = sanitizePdfBox(slideEl.clientWidth, slideEl.clientHeight)
        if (measured.fallback && lockedBox) {
          // 开头能量、后面量不到了：多半是视图被切到后台（量测台不再参与布局）→ 宁可中止也别导出空白 PDF
          console.warn('[PPT] 导出 PDF 中断：量测台失去尺寸', { page: i + 1 })
          ElMessage.warning(
            zh
              ? '导出已中断：演示视图似乎被切到了后台，请保持它在最前面再试一次'
              : 'Export stopped: keep the presentation view in the foreground and retry',
          )
          return
        }
        if (measured.fallback) {
          console.warn('[PPT] 导出 PDF：量测台尺寸异常，整本改用兜底尺寸', { measuredW: slideEl.clientWidth, measuredH: slideEl.clientHeight })
        }
        if (!lockedBox) lockedBox = { w: measured.w, h: measured.h }
        const w = lockedBox.w
        const boxH = lockedBox.h
        // 屏幕上需要滚动的页（内容比框高）：PDF 里把框加高，宁可比屏幕上略小也不丢内容。
        // 注意溢出发生在 .slide-body 里（.slide 自己高度固定），所以要按 body 的溢出量补高度。
        const bodyEl = slideEl.querySelector<HTMLElement>(':scope > .slide-body')
        const bodyOverflow = bodyEl ? Math.max(0, bodyEl.scrollHeight - bodyEl.clientHeight) : 0
        const slideOverflow = Math.max(0, slideEl.scrollHeight - slideEl.clientHeight)
        // 内容最多按 3 倍框高导出（防止某页内容异常时把整页缩到看不见）；留 6px 余量，
        // 免得四舍五入后差一点点又挤出一张空白页
        const h = Math.min(boxH * 3, Math.max(boxH, boxH + bodyOverflow + slideOverflow) + 6)
        pages.push({ html: slideEl.outerHTML, w, h })
      }
      if (!pages.length) return
      // 内容自检：页面全空（例如量测台里没有内容）时不要静默导出一本空白 PDF
      const textLen = pages.reduce((n, p) => {
        const tmp = document.createElement('div')
        tmp.innerHTML = p.html
        return n + (tmp.textContent || '').replace(/\s+/g, '').length
      }, 0)
      if (!textLen && !pages.some((p) => /<(img|svg|figure)\b/i.test(p.html))) {
        console.warn('[PPT] 导出 PDF：页面内容为空，已中止')
        ElMessage.warning(zh ? '导出失败：没有取到幻灯片内容，请保持演示视图在前台后重试' : 'Export failed: no slide content captured')
        return
      }
      const title = String(data?.label || data?.path || 'slides').replace(/\.[^.]+$/, '') || 'slides'
      // 一页一份打印文档：交给宿主逐页打印再合并（一个文档里放多页会被 Chromium 的分页拆开）
      const doc = buildSlidePdfHtml(pages)
      const res: any = await getPlatform().host.docs.printSlidesPdf({
        head: doc.head,
        slides: doc.slides,
        tail: doc.tail,
        title,
      })
      if (res?.success) {
        const count = Number(res.pages) || pages.length
        ElMessage.success(zh ? `已导出 ${count} 页 PDF` : `Exported ${count} slides to PDF`)
      } else if (res?.error && res.error !== '用户取消' && res.error !== 'not-supported') {
        ElMessage.error(zh ? `导出 PDF 失败：${res.error}` : `PDF export failed: ${res.error}`)
      } else if (res?.error === 'not-supported') {
        ElMessage.warning(zh ? '当前环境不支持导出 PDF' : 'PDF export is not available here')
      }
    } catch (e: any) {
      console.error('[PPT] 导出 PDF 失败:', e)
      ElMessage.error(zh ? `导出 PDF 失败：${e?.message || e}` : `PDF export failed: ${e?.message || e}`)
    } finally {
      pdfBusy.value = false
      // 量测台清空（否则导出用的那一页会一直留在隐藏层里，下次预排版也要重设）
      measureIndex.value = -1
      measureHtml.value = ''
      measureBreadcrumb.value = ''
    }
  }


  /** 就地重建并停在原来那一页（按来源段键 + 节内页偏移定位；比例切换 / 溢出收紧后用） */
  const rebuildKeepingSlide = async (key?: string, partOffset = 0) => {
    const cur = key || slideKeys[Number(showIndex.value)] || ''
    const offset = key ? partOffset : Math.max(0, Number(showIndex.value) - slideKeys.indexOf(cur))
    await init()
    const base = cur ? slideKeys.indexOf(cur) : -1
    let target: number
    if (base >= 0) {
      // 本节页数（重建后可能变多）：停在同样的第 k 页
      let count = 0
      while (base + count < slideKeys.length && slideKeys[base + count] === cur) count += 1
      target = Math.min(base + offset, base + count - 1)
    } else {
      target = Math.max(0, Math.min(prepList.value.length - 1, Number(showIndex.value)))
    }
    // 重建后 fitScales 被清空：先把目标页量好再显示，避免出现「先按估算显示、随后又伸缩」
    await ensureFitScale(target)
    showIndex.value = target
    await nextTick()
    renderMermaid()
    renderDrawio()
  }

  // 翻页 / 从总览切回后：slide 用 v-if 每次都会重建，需对当前页重新渲染 mermaid / 内嵌图表
  watch(showIndex, () => {
    void nextTick(() => {
      void renderMermaid()
      renderDrawio()
    })
    // 相邻页的字号提前算好，下一次翻页就不必等量测
    scheduleFitPrefetch(260)
    scheduleLayoutPass(1000)
    wakeChrome()
  })
  watch(showOverview, (ov: boolean) => { if (!ov) void nextTick(() => { void renderMermaid(); renderDrawio() }) })

  /** 统一刷新入口：来源（路径/内容）真的变化才重建演示（保留当前页码）。
   *  由 标签切换 / 内容变化监听 / 外部文件变更 共用，天然去重。 */
  const refreshPpt = async () => {
    if (!store.data[store.index]) return
    if (currentSourceKey() === lastRenderedSourceKey) return
    const prevIndex = showIndex.value
    await init()
    const target = Math.max(0, Math.min(prepList.value.length - 1, prevIndex))
    await ensureFitScale(target)
    showIndex.value = target
    await nextTick()
    renderMermaid()
    renderDrawio()
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
  // 载荷统一按 unknown 收下再断言：宿主事件总线没有跨进程类型契约，见 platform/contract 的 EventsPort
  const handleFileChanged = async (payload: unknown) => {
    const changedPath = (payload as { path?: string } | null)?.path
    const curPath = store.data[store.index]?.path
    if (!changedPath || !curPath || curPath !== changedPath) return
    // 重新读取文件内容并同步到 store —— 上方内容监听（refreshPpt）据此重建；内容未变则自动跳过
    const newContent = await getPlatform().fs.readText(curPath)
    if (store.data[store.index] && store.data[store.index].content !== newContent) {
      store.data[store.index].content = newContent
    }
  }

  onMounted(async ()=>{
    await init()
    // 首页的字号先量好（此后每次翻页都会这样预先算好，显示出来即最终字号）
    await ensureFitScale(showIndex.value)
    nextTick(() => {
      renderMermaid()
      renderDrawio()
      attachPythonRunHandler()
      scheduleLayoutPass(800)
    })
    // 容器尺寸自适应（跟随窗口缩放字号）
    refreshViewScale()
    viewResizeObserver = new ResizeObserver(() => {
      refreshViewScale()
      if (showThemeSettings.value) updateThemePanelPos()
    })
    if (pptContainerRef.value) viewResizeObserver.observe(pptContainerRef.value)
    window.addEventListener('keydown', handleKeydown)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // 监听文件变更
    unsubWatchedFile = getPlatform().events.on('watchedFileChanged', handleFileChanged)
    // 启动文件监听
    const curPath = store.data[store.index]?.path
    if (curPath) {
      getPlatform().watch.watchFile(curPath)
    }
  })

  onBeforeUnmount(() => {
    if (viewResizeObserver) { viewResizeObserver.disconnect(); viewResizeObserver = null }
    window.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    if (chromeTimer) { clearTimeout(chromeTimer); chromeTimer = null }
    // 移除文件监听
    unsubWatchedFile?.()
    unsubWatchedFile = null
    getPlatform().watch.unwatchFile()
    if (timeInterval) clearInterval(timeInterval)
  })
</script>

<template >
  <div class="ppt-container" ref="pptContainerRef" :data-theme="pptTheme" :class="{ 'chrome-idle': chromeHidden }"
       @wheel="handleWheel" @click="handleSlideLinkClick" @mousemove="wakeChrome">
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

    <!-- 空状态：空文件 / 非 Markdown 内容（构建完成却一页都没有）时给个明确提示，
         否则整屏空白、页码显示 1/0，看不出发生了什么 -->
    <div v-if="buildFinished && !prepList.length" class="ppt-empty">
      <i class="fa fa-file-text-o"></i>
      <div class="ppt-empty-title">{{ store.locales == 'zh' ? '这个文件没有可演示的内容' : 'Nothing to present in this file' }}</div>
      <div class="ppt-empty-hint">{{
        store.locales == 'zh'
          ? '演示视图只处理 Markdown（.md）正文；空文件或纯元信息的文件不会有幻灯片。'
          : 'The presentation view renders Markdown (.md) body text; empty files or metadata-only files produce no slides.'
      }}</div>
    </div>

    <!-- 幻灯片卡片 -->
    <div v-if="!showOverview && prepList.length" class="slide-wrapper" :class="'ratio-' + ratioMode" :style="{ left: navOpen ? '260px' : '20px' }">
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

    <!-- 隐藏量测台：与真实幻灯片同结构同尺寸，但不可见、不参与交互。
         翻页前先把目标页放进来量出「要多大字号才铺满」，等页面真正显示时就已经是最终字号
         （否则会先按估算显示、过一会儿再伸缩一下，看起来像闪烁）。 -->
    <div ref="measureWrapperRef" class="slide-wrapper measure-wrapper" :class="'ratio-' + ratioMode"
         :style="{ left: navOpen ? '260px' : '20px' }" aria-hidden="true">
      <div class="slide-container" :class="{ 'fs-container': ratioMode !== 'auto' }">
        <div>
          <div class="slide scoll measure-slide" :style="{ fontSize: measureFontEm + 'em' }">
            <div v-if="measureBreadcrumb" class="slide-breadcrumb">
              <span class="breadcrumb-text">{{ measureBreadcrumb }}</span>
              <span class="breadcrumb-filename">{{ (data?.label || '').replace(/\.md$/i, '') }}</span>
            </div>
            <div ref="measureBodyRef" class="slide-body scoll" v-html="measureHtml"></div>
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
               @click="goToSlide(+node.slideIndex)">
            <span class="tree-dot"></span>
            <span class="tree-text">{{ node.text }}</span>
          </div>
        </template>
        <div v-if="flatTree.length === 0" class="nav-panel-empty">{{store.locales=='zh'?'暂无标题':'No headings'}}</div>
      </div>
    </div>

    <!-- 底部工具栏（左：操作按钮 / 右：状态元素）；全屏演示时空闲会自动淡出（见 immersive） -->
    <div class="toolbar" :class="{ 'chrome-hidden': chromeHidden }" @mousemove="wakeChrome">
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

          <button class="tool-btn tool-btn-icon" @click="toggleFullscreen" :title="store.locales=='zh'?'全屏':'Fullscreen'">
            <i class="fa fa-arrows-alt"></i>
          </button>

          <span class="toolbar-sep"></span>

          <!-- 比例选择 -->
          <button class="tool-btn" :class="{ active: ratioMode === 'auto' }" @click="changeRatio('auto')" :title="store.locales=='zh'?'自动':'Auto'">{{ store.locales=='zh'?'自适应':'Auto' }}</button>
          <button class="tool-btn" :class="{ active: ratioMode === '16:9' }" @click="changeRatio('16:9')" title="16:9">16:9</button>
          <button class="tool-btn" :class="{ active: ratioMode === '4:3' }" @click="changeRatio('4:3')" title="4:3">4:3</button>

          <span class="toolbar-sep"></span>

          <!-- 上一页 / 下一页 -->
          <button class="nav-btn" @click="goPrevSlide" :disabled="!prepList.length || showIndex===0">
            <i class="fa fa-chevron-left"></i>
          </button>
          <button class="nav-btn" @click="goNextSlide" :disabled="!prepList.length || showIndex>=prepList.length-1">
            <i class="fa fa-chevron-right"></i>
          </button>

          <span class="toolbar-sep"></span>

          <!-- 切分模式切换 -->
          <button class="tool-btn" @click="toggleSplitMode" :title="store.locales=='zh'?'切换切分方式':'Toggle split mode'">
            {{ splitModeLabel }}
          </button>

          <!-- 导出幻灯片 PDF（一页一张，走主进程的打印通道） -->
          <button class="tool-btn tool-btn-icon" @click="exportSlidesPdf" :disabled="!prepList.length || pdfBusy"
                  :title="store.locales=='zh'?'导出 PDF（一页一张）':'Export PDF (one slide per page)'">
            <i :class="pdfBusy ? 'fa fa-spinner fa-spin' : 'fa fa-file-pdf-o'"></i>
          </button>

          <!-- 主题设置 -->
          <button ref="themeBtnRef" class="tool-btn tool-btn-icon" @click="toggleThemeSettings" :class="{ active: showThemeSettings }" :title="store.locales=='zh'?'主题':'Theme'">
            <i class="fa fa-cog"></i>
          </button>
        </div>

        <!-- ===== 右侧：状态元素 ===== -->
        <div class="tb-right">
          <!-- 缩放（状态 + 微调）；Ctrl+滚轮或 Ctrl+0 复位 -->
          <button class="tool-btn zoom-btn" @click="zoomOut" :disabled="zoomScale <= 0.5" :title="store.locales=='zh'?'缩小':'Zoom out'">
            <i class="fa fa-minus"></i>
          </button>
          <span class="zoom-label">{{ zoomPercent }}</span>
          <button class="tool-btn zoom-btn" @click="zoomIn" :disabled="zoomScale >= 2" :title="store.locales=='zh'?'放大':'Zoom in'">
            <i class="fa fa-plus"></i>
          </button>

          <span class="toolbar-sep"></span>

          <!-- 页码：点一下可以直接跳到某一页 -->
          <span class="slide-indicator">
            <template v-if="!pageInputOpen">
              <span class="slide-current" role="button" tabindex="0"
                    :title="store.locales=='zh'?'点击跳页':'Click to jump'"
                    @click="openPageInput">{{ prepList.length ? showIndex + 1 : 0 }}</span>
              <span class="slide-separator">/</span>
              <span class="slide-total">{{prepList.length}}</span>
            </template>
            <template v-else>
              <input ref="pageInputRef" v-model="pageInput" class="page-input" type="text" inputmode="numeric"
                     :placeholder="String(showIndex + 1)"
                     @keydown.enter.prevent="commitPageInput"
                     @keydown.esc.prevent="pageInputOpen = false"
                     @blur="pageInputOpen = false" />
              <span class="slide-separator">/</span>
              <span class="slide-total">{{prepList.length}}</span>
            </template>
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

    <!-- 进度条（点任意位置跳页；全屏空闲时与工具栏一起淡出） -->
    <div class="progress-bar" :class="{ 'chrome-hidden': chromeHidden }" @click="seekByProgress" @mousemove="wakeChrome">
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

  /* 空状态：文件里没有可演示的内容 */
  .ppt-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 40px;
    text-align: center;
    color: var(--fontColor);
    opacity: 0.75;
  }
  .ppt-empty > i {
    font-size: 40px;
    opacity: 0.5;
  }
  .ppt-empty-title {
    font-size: 16px;
    font-weight: 600;
  }
  .ppt-empty-hint {
    font-size: 13px;
    max-width: 520px;
    line-height: 1.6;
    opacity: 0.8;
  }

  /* 全屏沉浸：空闲时工具栏 / 进度条淡出，鼠标也藏起来（鼠标一动就回来） */
  .toolbar.chrome-hidden,
  .progress-bar.chrome-hidden {
    opacity: 0;
    pointer-events: none;
  }
  .ppt-container.chrome-idle {
    cursor: none;
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
  /* 隐藏量测台：与真实幻灯片同结构同尺寸（.slide-wrapper + .slide-container + .slide），
     但整体不可见、不可点、不参与交互 —— 只用于翻页前量出这一页需要多大字号 */
  .slide-wrapper.measure-wrapper {
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
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
    max-height: calc(60vh / var(--ui-zoom, 1));
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

  /* ===== 图文智能排版 =====
     统一原则：布局容器占满正文区的剩余高度（flex:1 + min-height:0），容器里的图片一律
     `max-width/max-height:100%` 等比缩放 —— 图片永远不会比幻灯片还高，也不再依赖 vh 单位。 */

  /* 左文字右图片 */
  .slide :deep(.slide-layout-row) {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: row;
    gap: 24px;
    /* safe center：内容装得下就垂直居中；装不下时退回顶部对齐，
       否则溢出的上半部分会被推到滚动区之外、滚不上去 */
    align-items: safe center;
  }
  .slide :deep(.slide-layout-text) {
    /* 横向（左右布局）时按容器宽度等分：必须是可伸缩的，否则长段落会拉成一行、把图挤扁 */
    flex: 1 1 0;
    min-width: 0;
  }
  .slide :deep(.slide-layout-image) {
    flex: 2 1 0;
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* 文字在上 / 图片在下（宽图） */
  .slide :deep(.slide-layout-stack) {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .slide :deep(.slide-layout-stack) .slide-layout-text {
    /* 纵向（上下布局）时按内容高度撑开：被压缩到内容以下会让文字溢出、糊到图片上 */
    flex: 0 0 auto;
  }
  .slide :deep(.slide-layout-stack) .slide-layout-image {
    flex: 1 1 0;
    /* 高度下限：文字多时也不把图压扁 */
    min-height: 38%;
    height: auto;
  }

  /* 多图 + 文字同页：标题 / 文字 / 网格 依序排，网格吃掉剩余高度 */
  .slide :deep(.slide-layout-multi) {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .slide :deep(.slide-layout-multi) > h1,
  .slide :deep(.slide-layout-multi) > h2,
  .slide :deep(.slide-layout-multi) > h3,
  .slide :deep(.slide-layout-multi) > h4,
  .slide :deep(.slide-layout-multi) > h5,
  .slide :deep(.slide-layout-multi) > h6 {
    flex-shrink: 0;
    margin-top: 0;
  }
  .slide :deep(.slide-layout-textblocks) {
    flex: 0 0 auto;
    min-width: 0;
  }

  /* 图片容器：单元格内「图占满 + 图注贴底」，图片按格等比缩放 */
  .slide :deep(.slide-layout-image) figure,
  .slide :deep(.slide-layout-grid) .slide-layout-cell figure,
  .slide :deep(.slide-layout-page-image) {
    margin: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    justify-items: center;
    align-items: center;
  }
  .slide :deep(.slide-layout-image) img,
  .slide :deep(.slide-layout-grid) .slide-layout-cell img,
  .slide :deep(.slide-layout-page-image) img {
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
  }

  /* 多图网格：列数由内容决定（内联 grid-template-columns），行数自动均分剩余高度 */
  .slide :deep(.slide-layout-grid) {
    flex: 1 1 45%;
    /* 高度下限：文字再多也不许把图压成一条缝（页面因此放不下时交给自动分页处理） */
    min-height: 34%;
    display: grid;
    grid-auto-rows: minmax(0, 1fr);
    gap: 16px;
    margin: 0;
  }
  .slide :deep(.slide-layout-grid) .slide-layout-cell {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
  }

  /* 图片独占一页（图片与幻灯片同形） */
  .slide :deep(.slide-layout-page-image) {
    flex: 1 1 0;
    height: auto;
  }
  /* 内嵌 drawio 图表：卡片与 SVG 一起按框等比缩放，**不出现滚动条**（放不下就整体缩小） */
  .slide :deep(.slide-layout-image) .md-drawio-body,
  .slide :deep(.slide-layout-grid) .slide-layout-cell .md-drawio-body,
  .slide :deep(.slide-layout-page-image) .md-drawio-body {
    height: 100%;
    max-height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .slide :deep(.slide-layout-image) .md-drawio-canvas,
  .slide :deep(.slide-layout-grid) .slide-layout-cell .md-drawio-canvas,
  .slide :deep(.slide-layout-page-image) .md-drawio-canvas {
    flex: 1 1 auto;
    min-height: 0;
    max-width: 100%;
    max-height: 100%;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .slide :deep(.slide-layout-image) .md-drawio-canvas svg,
  .slide :deep(.slide-layout-grid) .slide-layout-cell .md-drawio-canvas svg,
  .slide :deep(.slide-layout-page-image) .md-drawio-canvas svg {
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    display: block;
  }

  /* 被裁剪的表格：末尾提示省略了多少行 */
  .slide :deep(.slide-table-trimmed) {
    flex-shrink: 0;
    margin-top: 6px;
    font-size: 0.7em;
    opacity: 0.65;
    text-align: right;
  }

  /* 同形图片 + 一句话图注：图占满剩余空间，图注贴着底部 */
  .slide :deep(.slide-layout-image-only) {
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .slide :deep(.slide-layout-caption) {
    flex-shrink: 0;
    text-align: center;
    opacity: 0.8;
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
    transition: opacity 0.25s ease;
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
    cursor: pointer;
    padding: 0 2px;
    border-radius: 3px;
  }
  .slide-current:hover {
    background: var(--menuActiveColor, rgba(127, 127, 127, 0.2));
  }
  /* 页码输入（点页码后出现） */
  .page-input {
    width: 44px;
    height: 18px;
    padding: 0 4px;
    font-size: 12px;
    text-align: center;
    color: var(--fontColor);
    background: var(--backgroundColor);
    border: 1px solid var(--borderColor);
    border-radius: 3px;
    outline: none;
  }
  .slide-separator {
    color: var(--borderColor);
  }
  .slide-total {
    color: var(--fontColor);
    opacity: 0.6;
  }

  /* 进度条（可点击跳页） */
  .progress-bar {
    position: absolute;
    bottom: 24px;
    left: 0;
    right: 0;
    height: 3px;
    background: var(--borderColor);
    cursor: pointer;
    transition: opacity 0.25s ease;
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
    max-height: calc(50vh / var(--ui-zoom, 1));
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
  /* 必须用视口单位：写 min(60vh, 100%) 时百分比相对父高，而父高又由本 svg 决定（循环），
     Chrome 会忽略该百分比 → 布局高用自然高、绘制时按 60vh 缩 → 容器被撑高、四周留白 ✗
     （除以 --ui-zoom 只是折算界面缩放，仍然是视口口径） */
  max-height: calc(50vh / var(--ui-zoom, 1));
  object-fit: contain;
  overflow: hidden;
}
/* 渲染完成的 mermaid：右上 hover 放大查看图标（点击打开 MermaidViewer） */
.ppt-container .mermaid.mermaid-clickable {
  position: relative;
  cursor: pointer;
}
.ppt-container .mermaid.mermaid-clickable::after {
  font-family: 'Font Awesome 5 Free';
  font-weight: 900;
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
