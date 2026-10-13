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
  const buildSlideParts = async (renderedHtml: string, sectionKey: string, allowSplit: boolean): Promise<SlidePart[]> => {
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
        html: headingHtml + imagePageHtml([f]),
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
      const gridPart: SlidePart = { html: multiPageHtml(heading, [], grid, true), splittable: false }
      const textsOnly = textPages()
      return figuresFirst ? [gridPart, ...textsOnly] : [...textsOnly, gridPart]
    }

    // 只有标题 + 一张图（正文为空）：图占满整页，标题留着做面包屑
    if (!bodyTexts.length) {
      return [{ html: headingHtml + imagePageHtml(figures), splittable: false }]
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
      return [...textPages(), { html: headingHtml + imagePageHtml(figures), splittable: false }]
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
    return [...textPages(), { html: headingHtml + imagePageHtml(figures), splittable: false }]
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
    init()
    showIndex.value = 0
    nextTick(() => {
      renderMermaid()
      renderDrawio()
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
      // 容器尺寸变了（窗口缩放 / 全屏 / 目录展开）→ 重新按实测适配字号
      scheduleLayoutPass(260)
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

  // 上一页 / 下一页（键盘、底部按钮、触屏滑动共用）
  const goPrevSlide = () => { showIndex.value = Math.max(0, showIndex.value - 1) }
  const goNextSlide = () => { showIndex.value = Math.min(prepList.value.length - 1, showIndex.value + 1) }

  // 键盘控制：上下键滚动当前页，左右键翻页
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goPrevSlide()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      goNextSlide()
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
    data=store.data[store.index]
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
        // 智能排版：按图片长宽选布局（同形 → 图片独占一页 / 竖图 → 左右 / 宽图 → 上下），
        // 文字过多时自动分页，一段可能变成多张幻灯片
        const sectionKey = `${sectionIdx++}|${section.trim().slice(0, 48)}`
        const parts = await buildSlideParts(renderedContent, sectionKey, allowSplit)

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
          // 只有这一节的第一页登记标题：续页 / 图片页共用同一个面包屑，目录里也不会出现重复项
          allHeadings.push({ level, text, slideIndex: slides.length })
        }

        // 面包屑路径，直接用标题文本
        const breadcrumb = headingStack.map(h => h.text).join(' / ')

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

  /**
   * 内嵌图表（`![](图.drawio)`）渲染：把图表占位卡片填成 SVG。
   * 与 mermaid 同源——slide 用 v-if 每次进入都会重建，所以每次翻页 / 重建后都要重跑一次
   * （渲染器自带内容哈希缓存，同一份图表不会重复渲染）。
   */
  const renderDrawio = () => {
    void renderDrawioFigures(pptContainerRef.value, { zh: store.locales === 'zh' }).then(() => {
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
    const slide = pptContainerRef.value?.querySelector<HTMLElement>('.slide:not(.overview-slide-real)')
    const body = slide?.querySelector<HTMLElement>(':scope > .slide-body')
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
    const slide = pptContainerRef.value?.querySelector<HTMLElement>('.slide:not(.overview-slide-real)')
    const body = slide?.querySelector<HTMLElement>(':scope > .slide-body')
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
      void autoFitCurrentSlide().then(() => {
        trimOverflowingTables()
        checkSlideOverflow()
      })
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
   * 按实测把当前页字号调到「刚好铺满」：估算系数只按字数算，偏保守时文字不大、
   * 下方还留一段空白。这里量真实高度后微调（装得下就放大、溢出就缩小，0.7~2.6 倍），
   * 最多迭代 6 次；Ctrl+滚轮放大看细节时不参与（那不是排版问题）。
   */
  let fitRunning = false
  const autoFitCurrentSlide = async (iterations = 6) => {
    if (fitRunning || showOverview.value || animating.value || zoomScale.value !== 1) return
    const slide = pptContainerRef.value?.querySelector<HTMLElement>('.slide:not(.overview-slide-real)')
    const body = slide?.querySelector<HTMLElement>(':scope > .slide-body')
    if (!body || body.clientHeight < 40) return
    const idx = Number(showIndex.value)
    // 有整页图片 / 图表时不放大：图由容器定尺寸，放大文字只会把图挤小
    const hasFigure = !!body.querySelector('figure')
    fitRunning = true
    try {
      // 先把之前可能过冲的系数收回来，再按实测逼近（避免上一轮留下的溢出一直存在）
      const current = fitScales.value[idx] || 1
      if (current > 1) {
        const arr = fitScales.value.slice()
        arr[idx] = 1
        fitScales.value = arr
      }
      for (let i = 0; i < iterations; i++) {
        await nextTick()
        await nextFrame()
        const h = body.clientHeight
        if (!h) break
        const overflowing = body.scrollHeight > h + 1
        const used = overflowing ? body.scrollHeight : contentUsedHeight(body)
        if (!used) break
        const ratio = h / used
        // 已经贴合（差 3% 以内）就收手：既不留明显空白，也不切掉最后一行
        if (ratio >= 0.97 && ratio <= 1.01) break
        if (!overflowing && hasFigure) break // 图占位时只缩小、不放大
        const cur = fitScales.value[idx] || 1
        // 目标：内容高度 ≈ 可用高度。放大 / 缩小都限幅（0.8~1.15 / 0.75~0.95），
        // 让迭代单调收敛，不会一步放大过头、下一步又缩回去来回震荡
        const raw = ratio * 0.99
        const step = overflowing ? Math.min(0.95, Math.max(0.75, raw)) : Math.min(1.15, Math.max(0.8, raw))
        const next = Math.max(0.7, Math.min(2.6, cur * step))
        if (Math.abs(next - cur) < 0.012) break
        const arr = fitScales.value.slice()
        arr[idx] = next
        fitScales.value = arr
      }
      // 收尾保底：迭代结束仍溢出（步长限幅导致）就按实测比例再收一次，绝不留最后一行被切
      await nextTick()
      await nextFrame()
      const hEnd = body.clientHeight
      const overEnd = hEnd ? body.scrollHeight - hEnd : 0
      if (overEnd > 1) {
        const cur = fitScales.value[idx] || 1
        const next = Math.max(0.7, Math.min(2.6, (cur * (hEnd / body.scrollHeight)) * 0.99))
        if (next < cur - 0.005) {
          const arr = fitScales.value.slice()
          arr[idx] = next
          fitScales.value = arr
        }
      }
    } finally {
      fitRunning = false
    }
  }

  /** 就地重建并停在原来那一页（按来源段键 + 节内页偏移定位；比例切换 / 溢出收紧后用） */
  const rebuildKeepingSlide = async (key?: string, partOffset = 0) => {
    const cur = key || slideKeys[Number(showIndex.value)] || ''
    const offset = key ? partOffset : Math.max(0, Number(showIndex.value) - slideKeys.indexOf(cur))
    await init()
    const base = cur ? slideKeys.indexOf(cur) : -1
    if (base >= 0) {
      // 本节页数（重建后可能变多）：停在同样的第 k 页
      let count = 0
      while (base + count < slideKeys.length && slideKeys[base + count] === cur) count += 1
      showIndex.value = Math.min(base + offset, base + count - 1)
    } else {
      showIndex.value = Math.max(0, Math.min(prepList.value.length - 1, Number(showIndex.value)))
    }
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
    scheduleLayoutPass(1000)
  })
  watch(showOverview, (ov: boolean) => { if (!ov) void nextTick(() => { void renderMermaid(); renderDrawio() }) })

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
    document.addEventListener('fullscreenchange', repositionThemePanel)
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
    document.removeEventListener('fullscreenchange', repositionThemePanel)
    // 移除文件监听
    unsubWatchedFile?.()
    unsubWatchedFile = null
    getPlatform().watch.unwatchFile()
    if (timeInterval) clearInterval(timeInterval)
  })
</script>

<template >
  <div class="ppt-container" ref="pptContainerRef" :data-theme="pptTheme" @wheel="handleWheel" @click="handleSlideLinkClick">
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
          <button class="nav-btn" @click="goPrevSlide" :disabled="showIndex===0">
            <i class="fa fa-chevron-left"></i>
          </button>
          <button class="nav-btn" @click="goNextSlide" :disabled="showIndex===prepList.length-1">
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
