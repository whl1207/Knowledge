<script setup lang="ts">
  import { usestore } from '@/store'
  import { ref,watch,onMounted,onBeforeUnmount,computed,nextTick } from 'vue'
  import { ElMessage } from 'element-plus'
  import ImageZoom from '@/components/knowFile/view/view_image.vue' // 导入图片组件

  import MarkdownIt from 'markdown-it'
  import yaml from 'js-yaml'
  import mathjax3 from 'markdown-it-mathjax3'
  import tocAndAnchor from 'markdown-it-toc-and-anchor'
  import mark from 'markdown-it-mark'
  import hljs from 'highlight.js'
  import 'highlight.js/styles/nnfx-dark.min.css'
  import { hashContent, renderMermaidSvgLenient, getCachedSvgLenient, ensureMermaidInit } from '@/lib/markdown/mermaid'
  import { preprocessMath as sharedPreprocessMath } from '@/lib/markdown/render'
  import MermaidViewer from '@/components/MermaidViewer.vue'
  import WordExportDialog from '@/components/export/WordExportDialog.vue'
  import { typesetRoot, scheduleTypeset, installTypesetCopyFix } from '@/lib/typeset'
  import { inlineLocalImagesAsDataUrls } from '@/lib/export/download'
  import { allowLocalFileLinks, applyMdLinkRule, normalizeAnchorText } from '@/lib/markdown/mdLinkPolicy'
  import { readImageAsDataUrl } from '@/lib/export/docx'
  import PdfViewer from '@/components/knowFile/view/PdfViewer.vue'
  import { defineAsyncComponent } from 'vue'
  import DocTocPanel from '@/components/knowFile/view/DocTocPanel.vue'
  import { loadDocTocWidth, saveDocTocWidth, loadDocTocOpen, saveDocTocOpen, flattenTocTree, DOC_TOC_MIN_WIDTH, DOC_TOC_MAX_WIDTH } from '@/lib/markdown/toc'
  import { loadDocChatWidth, saveDocChatWidth, DOC_CHAT_MIN_WIDTH, DOC_CHAT_MAX_WIDTH } from '@/lib/knowFile/panelWidths'
  import { isDrawioFile as detectDrawioFile } from '@/shared/drawioFile'
  // 智能操作：与当前 md / Word 文档对话（右侧面板，懒加载）
  const DocChatPanel = defineAsyncComponent(() => import('@/components/knowFile/view/DocChatPanel.vue'))
  // Excalidraw 白板（懒加载，避免 React/Excalidraw 拖慢首屏）
  const Excalidraw = defineAsyncComponent(() => import('@/components/knowFile/view/Excalidraw.vue'))
  // draw.io 图表（懒加载）
  const Drawio = defineAsyncComponent(() => import('@/components/knowFile/view/Drawio.vue'))
  // 音视频多媒体播放器（懒加载，统一处理音频/视频）
  const Media = defineAsyncComponent(() => import('@/components/knowFile/view/Media.vue'))

  // Media 组件内部切歌（上一首/下一首）时向上透传新路径
  function onMediaPathChange(path: string) {
    emit('update:path', path)
  }

  //读取并解构数据
  const store=usestore()

  const props = defineProps<{
    path?: string;
    content?: string;
    /** 远程只读文件标识 */
    isRemote?: boolean;
    /** 远程文件 base64 内容（裸 base64，无 data: 前缀），由 panel.vue 读取后注入 */
    remoteBase64?: string;
    /** 远程 Word 转好的 Markdown 文本（由 panel.vue 经 docxToMarkdown IPC 转换） */
    remoteText?: string;
    /** 宿主是否正在读文件内容（大文件读盘/远程拉取期间为 true）：避免此时误显示“文件无内容和数据” */
    loading?: boolean;
  }>()

  const emit = defineEmits<{
    (e: 'update:path', path: string): void
  }>()

  // ---- 阅读字号（.prep 正文基础字号，A-/A+ 调节，localStorage 记忆） ----
  const READ_FONT_MIN = 12
  const READ_FONT_MAX = 36
  let _savedReadFont = 16
  try { _savedReadFont = Number(localStorage.getItem('md_read_font_size')) || 16 } catch (e) { /* ignore */ }
  const readFontSize = ref(Math.max(READ_FONT_MIN, Math.min(READ_FONT_MAX, _savedReadFont)))
  const changeReadFont = (delta: number) => {
    readFontSize.value = Math.max(READ_FONT_MIN, Math.min(READ_FONT_MAX, readFontSize.value + delta))
    try { localStorage.setItem('md_read_font_size', String(readFontSize.value)) } catch (e) { /* ignore */ }
  }

  // Word文档内容缓存
  const wordContent = ref('')

  const data = computed(() => {
    const content = props.content ?? ''
    const path = props.path ?? ''
    
    let extension = ''
    if (path) {
      const lastDotIndex = path.lastIndexOf('.')
      if (lastDotIndex !== -1) {
        extension = path.slice(lastDotIndex).toLowerCase()
      }
    } else if (content) {
      // 如果没有路径但有内容，尝试从内容推断
      if (/^\s*#/.test(content)) {
        extension = '.md'
      }
    }
    
    // 表格类（xlsx/xls/csv）主进程已转为 Markdown 表格文本，按 Markdown 渲染
    const isMd = extension === '.md' || (extension === '' && /^\s*#/.test(content)) || extension === '.xlsx' || extension === '.xls' || extension === '.csv'
    const isWord = extension === '.docx' || extension === '.doc'
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'].includes(extension)
    const isVideo = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.mkv', '.m4v', '.3gp', '.ts', '.mpg', '.mpeg'].includes(extension)
    const isAudio = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape', '.aiff'].includes(extension)
    const isTxt = extension === '.txt'
    const isPdf = extension === '.pdf'
    const isExcalidraw = extension === '.excalidraw'
    // draw.io 图表：.drawio/.dio 按后缀；.xml 需内容像图表
    const isDrawio = detectDrawioFile(path, content)
    const isHtml = extension === '.html' || extension === '.htm'
    
    // 远程文件：图片走 data URL，PDF 走 PdfViewer base64
    const remoteBase64 = props.isRemote ? (props.remoteBase64 || '') : ''
    const imageMime: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
    }
    const imageDataUrl = remoteBase64 && imageMime[extension]
      ? `data:${imageMime[extension]};base64,${remoteBase64}`
      : ''
    
    return { 
      content, 
      path, 
      extension, 
      isMd, 
      isWord,
      isImage, 
      isVideo, 
      isAudio,
      isTxt,
      isPdf,
      isExcalidraw,
      isDrawio,
      isHtml,
      isRemote: !!props.isRemote,
      remoteBase64,
      imageDataUrl,
      isMedia: isImage || isVideo || isTxt
    }
  })

  // 浏览器模式（LAN 共享）无法通过 file:// 加载本地文件，改用 srcdoc 渲染
  const isBrowserMode = typeof window !== 'undefined' && !(window as any).ipcRenderer
  // 本地 HTML 文件 → file:/// URL（相对资源/脚本可正常加载）
  const htmlSrc = computed(() => {
    const p = data.value.path
    if (!p) return ''
    return 'file:///' + p.replace(/\\/g, '/')
  })

  let prep = ref("") //预览

  // ---- 渲染/加载状态（大文档打开时不能先闪一句“文件无内容和数据”）----
  // md.render + mermaid + MathJax + 两端对齐排版在长文上耗时明显；宿主读盘/远程拉取期间 content 也为空，
  // 这两种情况都归为“正在渲染”（与可视编辑视图 BlockEditor 的 be-rendering-mask 体验一致）。
  const isRendering = ref(false)
  /** 宿主未传 loading 时的兜底：内容迟迟未到也先按“加载中”处理，宽限期后才显示空内容提示 */
  const CONTENT_WAIT_GRACE_MS = 2500
  const waitingContent = ref(false)
  let contentWaitTimer: any = 0

  const isTextDoc = computed(() => data.value.isMd || data.value.isTxt)

  const showRenderingState = computed(() => {
    if (!isTextDoc.value) return false
    if (isRendering.value || props.loading) return true
    return waitingContent.value && !prep.value
  })

  const renderingLabel = computed(() => {
    const zh = store.locales === 'zh'
    if (data.value.isTxt) return zh ? '正在加载…' : 'Loading…'
    return zh ? '正在渲染…' : 'Rendering…'
  })

  /** on=true 进入“等待内容”态并启动宽限计时（真正空文件宽限期后落到空内容提示） */
  function scheduleContentWait(on: boolean) {
    clearTimeout(contentWaitTimer)
    if (!on) { waitingContent.value = false; return }
    waitingContent.value = true
    contentWaitTimer = setTimeout(() => { waitingContent.value = false }, CONTENT_WAIT_GRACE_MS)
  }

  // 内容/路径变化：文本类文档还没拿到内容（且尚未渲染出东西）→ 视为加载中
  watch(() => [data.value.content, data.value.path, prep.value] as const, () => {
    scheduleContentWait(isTextDoc.value && !data.value.content && !prep.value)
  }, { immediate: true })
  // 是否显示目录（用 const：v-model 绑定 ref 时编译器会写入 .value）
  // 初始值跟其它视图共享：在任一处打开目录后，切到别的视图也会打开
  const iftoc=ref(loadDocTocOpen())
  /** 显式开合目录（状态栏按钮 / 面板关闭按钮）：写回共享状态，其它视图跟随 */
  const setTocOpen = (v: boolean) => { iftoc.value = v; saveDocTocOpen(v) }

  /** 目录项（来自 markdown-it-toc-and-anchor 的 tocCallback，自带真实锚点 id） */
  interface TocItem { text: string; level: number; anchor: string }
  let toc=ref([] as TocItem[]) //目录

  // 层级目录树计算属性：将扁平 toc 转为嵌套树结构（目录项 id 由共享展平函数按前序分配）
  interface TocNode {
    text: string
    href: string
    anchor: string
    level: number
    children: TocNode[]
  }
  const tocTree = computed<TocNode[]>(() => {
    const root: TocNode[] = []
    const stack: TocNode[] = []
    for (const item of toc.value) {
      const level = item.level || 1
      const node: TocNode = {
        text: item.text,
        href: '#' + item.anchor,
        anchor: item.anchor,
        level,
        children: [],
      }
      // 弹出栈中所有 >= 当前层级的节点
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
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
  })

  // 将树结构展平为带深度和层级线的列表（层级线规则统一在 lib/markdown/toc.ts，各视图不再手写）。
  // id = 前序遍历序号 +1 = 文档顺序，与正文标题的 data-toc-idx（下标+1）一一对位。
  const tocFlat = computed(() =>
    flattenTocTree(tocTree.value, (node) => ({ text: node.text, href: node.href, anchor: node.anchor }))
  )

  let metaVisible = ref(false)
  let metaForm = ref([] as any)
  let isLoadingWord = ref(false) // Word文档加载状态
  let wordError = ref('') // Word文档错误信息



  ensureMermaidInit()

  // Mermaid 源文本规范化已迁移至 '@/lib/markdown/mermaid-normalize'（顶部 import 的 normalizeMermaidSource）

  // 每次 md.render 时由 markdown-it-toc-and-anchor 回填的标题列表（含真实锚点 id）
  let lastHeadingAnchors: any[] = []
  
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
  }).use(mathjax3)
  .use(tocAndAnchor, {
    anchorLink: false,
    // 捕获本次渲染的标题（含插件生成的 id 锚点），目录据此构建 → 与正文标题精确对位
    tocCallback: (_tocMarkdown: any, tocArray: any) => {
      lastHeadingAnchors = Array.isArray(tocArray) ? tocArray : []
    }
  })
  .use(mark)

  // 放开 file: 链接：Word 预览图片以 file:/// 引用缓存文件（docx-media/…/imageN.png），
  // markdown-it 默认 validateLink 会拒绝 file: → 图片语法不成立，会原样显示 `![alt](file:///…)` 文本
  allowLocalFileLinks(md)

  // 当前 Markdown 文件所在目录，用于解析相对图片路径
  let mdBasePath = ''

  /** 是否为本地文件图片（file:/// 或盘符绝对路径）——可能被个别环境拦截，需要 onerror 兜底 */
  const isLocalFileSrc = (src: string) => /^(file:\/\/|[A-Za-z]:[\\/]|\\\\)/i.test(src || '')

  // 重写图片渲染规则，将相对路径转为基于文件所在目录的绝对路径，并添加图片描述
  const defaultImageRender = md.renderer.rules.image || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const srcIndex = token.attrIndex('src')
    if (srcIndex >= 0 && mdBasePath) {
      let src = token.attrs![srcIndex][1]
      // 判断是否为相对路径（不以协议、data:、file://、/、盘符开头）
      if (src && !/^(https?:|data:|file:\/\/|\/|[A-Za-z]:)/i.test(src)) {
        // 将反斜杠统一为正斜杠，并拼接基路径
        const normalizedSrc = src.replace(/\\/g, '/')
        src = mdBasePath + normalizedSrc
        token.attrs![srcIndex][1] = src
      }
    }
    // 本地文件图片（Word 转换出的 file:/// 缓存图、md 相对路径解析出的绝对路径）：
    // 个别环境会拦截 file:// 子资源加载 → 挂 onerror，由全局兜底改用 IPC 读文件转 data URL
    if (srcIndex >= 0 && isLocalFileSrc(token.attrs![srcIndex][1]) && token.attrIndex('onerror') < 0) {
      token.attrPush(['onerror', 'window.__mdFixLocalImg&&window.__mdFixLocalImg(this)'])
    }
    // 先渲染默认的 <img> 标签
    const imgHtml = defaultImageRender(tokens, idx, options, env, self)
    // 获取 alt 文本作为图片描述
    const altText = token.content ? md.utils.escapeHtml(token.content.trim()) : ''
    if (altText) {
      return `<figure class="md-image-figure">${imgHtml}<figcaption class="md-image-caption">${altText}</figcaption></figure>`
    }
    return imgHtml
  }

  /**
   * 本地图片兜底：`<img onerror>` 触发时，经 IPC 读取本地文件换成 data URL 再显示。
   * 只改 DOM，不改存储的 Markdown（存储里必须保持 file:/// 短引用，否则会撑爆 localStorage）。
   */
  const mdFixLocalImg = async (img: HTMLImageElement) => {
    try {
      if (!img || img.dataset.localFixTried === '1') return
      img.dataset.localFixTried = '1'
      const src = img.getAttribute('src') || ''
      if (!isLocalFileSrc(src)) return
      const filePath = /^file:\/\//i.test(src) ? src.replace(/^file:\/\/\/?/i, '') : src
      const dataUrl = await readImageAsDataUrl(filePath)
      if (dataUrl) {
        img.setAttribute('src', dataUrl)
      } else {
        console.warn('[md_read] 本地图片兜底读取失败:', src)
      }
    } catch (e) {
      console.warn('[md_read] 本地图片兜底异常:', e)
    }
  }

  // 链接渲染规则：页内锚点（Word 目录 `#_Toc…` 等）打 md-anchor-link，相对路径打 md-file-link
  // （旧实现把 `#_Toc123456` 当相对路径拼成 `D:/dir/#_Toc123456`，打开后报 Error reading file: ENOENT）
  applyMdLinkRule(md, () => mdBasePath)

  const defaultFence = md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const info = token.info ? token.info.trim() : ''
    const langName = info ? info.split(/\s+/g)[0] : ''

    if (langName === 'mermaid') {
      const content = token.content.trim()
      const h = hashContent(content)
      const escaped = md.utils.escapeHtml(content)
      return `<div class="mermaid-wrapper" data-mermaid-hash="${h}"><div class="mermaid-src" style="display:none">${escaped}</div></div>`
    }

    return defaultFence(tokens, idx, options, env, self)
  }

  const renderMermaidDiagrams = async (root?: HTMLElement | null) => {
    const container = root || document.querySelector('.prep')
    if (!container) return

    const wrappers = Array.from(container.querySelectorAll<HTMLElement>('.mermaid-wrapper'))
    if (!wrappers.length) return

    for (const wrapper of wrappers) {
      const srcEl = wrapper.querySelector<HTMLElement>('.mermaid-src')
      if (!srcEl) continue

      const rawText = srcEl.textContent?.trim()
      if (!rawText) continue

      // 如果已有渲染结果，跳过
      if (wrapper.querySelector('.mermaid-rendered-svg')) continue

      // 检查缓存（键 = 规范化后的源码，与 renderMermaidSvgLenient 一致）
      const cachedSvg = getCachedSvgLenient(rawText)
      if (cachedSvg) {
        wrapper.innerHTML = ''
        const svgContainer = document.createElement('div')
        svgContainer.className = 'mermaid-rendered-svg mermaid-clickable'
        svgContainer.innerHTML = cachedSvg
        svgContainer.setAttribute('data-mermaid-src', rawText)
        svgContainer.addEventListener('click', (e) => {
          e.stopPropagation()
          openMermaidModal(rawText)
        })
        wrapper.appendChild(svgContainer)
        continue
      }

      // 渲染（规范化 + 失败回退原始源码，与块编辑器/展开弹窗完全同一入口）
      try {
        const svgString = await renderMermaidSvgLenient(rawText)
        wrapper.innerHTML = ''
        const svgContainer = document.createElement('div')
        svgContainer.className = 'mermaid-rendered-svg mermaid-clickable'
        svgContainer.innerHTML = svgString
        svgContainer.setAttribute('data-mermaid-src', rawText)
        svgContainer.addEventListener('click', (e) => {
          e.stopPropagation()
          openMermaidModal(rawText)
        })
        wrapper.appendChild(svgContainer)
      } catch (error) {
        console.error('Mermaid render failed:', error)
        wrapper.innerHTML = `<pre class="mermaid-fallback">${md.utils.escapeHtml(rawText)}</pre>`
      }
    }
  }

  // ===== Python 代码执行 =====
  // 为 Python 代码块添加「运行」按钮
  const enhancePythonBlocks = async (root?: HTMLElement | null) => {
    const container = root || document.querySelector('.prep')
    if (!container) return
    // 只处理尚未增强的 Python 代码块
    const pres = Array.from(container.querySelectorAll<HTMLElement>('pre[data-lang="python"]:not([data-python-enhanced])'))
    for (const pre of pres) {
      pre.setAttribute('data-python-enhanced', 'true')
      // 创建包裹容器
      const wrapper = document.createElement('div')
      wrapper.className = 'python-block-wrapper'
      pre.parentNode?.insertBefore(wrapper, pre)
      wrapper.appendChild(pre)
      // 添加运行按钮
      const btnBar = document.createElement('div')
      btnBar.className = 'python-run-bar'
      btnBar.innerHTML = `<button class="python-run-btn" type="button"><i class="fa fa-play"></i> ${store.locales=='zh'?'运行 Python':'Run Python'}</button>`
      wrapper.appendChild(btnBar)
      // 结果区域
      const resultDiv = document.createElement('div')
      resultDiv.className = 'python-result'
      resultDiv.style.display = 'none'
      wrapper.appendChild(resultDiv)
    }
  }

  // 执行 Python 代码
  const runPythonCode = async (code: string, resultEl: HTMLElement) => {
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

  // 在 handlePrepClick 中委托处理 Python 运行按钮点击
  const handlePythonRunClick = async (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.python-run-btn') as HTMLElement | null
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    const wrapper = btn.closest('.python-block-wrapper') as HTMLElement | null
    if (!wrapper) return
    const pre = wrapper.querySelector<HTMLElement>('pre[data-lang="python"]')
    if (!pre) return
    const codeEl = pre.querySelector('code')
    if (!codeEl) return
    // 从高亮后的 code 元素提取纯文本
    const code = codeEl.textContent || ''
    const resultEl = wrapper.querySelector<HTMLElement>('.python-result')
    if (!resultEl) return
    await runPythonCode(code, resultEl)
  }

  // 加载Word文档内容
  const loadWordContent = async function() {
    const cur = data.value
    if (!cur.isWord) return
    
    isLoadingWord.value = true
    wordError.value = ''
    
    // 远程 Word：内容已由 panel.vue 通过 docxToMarkdown 转换好（Markdown 文本）
    if (props.isRemote) {
      const md = props.remoteText || props.content || ''
      if (md) {
        wordContent.value = md
        await RenderMarkdown(md)
      } else {
        wordError.value = '远程 Word 内容为空'
      }
      isLoadingWord.value = false
      return
    }
    
    if (!cur.path) {
      isLoadingWord.value = false
      return
    }
    
    try {
      const result = await window.ipcRenderer.invoke('readFile', cur.path)
      
      // 处理后端返回的对象格式
      let content = ''
      if (typeof result === 'object' && result !== null) {
        if (result.success === false) {
          wordError.value = result.content || result.error || '读取Word文档失败'
          content = ''
        } else {
          content = result.content || ''
        }
      } else {
        content = result || ''
      }
      
      wordContent.value = content
      
      // 如果有内容，渲染为Markdown
      if (content) {
        await RenderMarkdown(content)
      }
    } catch (err: any) {
      console.error('加载Word文档失败:', err)
      wordError.value = err.message || '加载Word文档失败'
    } finally {
      isLoadingWord.value = false
    }
  }

  //更新目录和预览
  const init=async function(){
    prep.value=''
    
    // 如果没有通过 props 传入数据，则不处理
    const hasProp = props.content !== undefined || props.path !== undefined
    if (!hasProp) return;
    
    const cur = data.value
    if (!cur) return;
    
    // 如果是Word文档，加载Word内容
    if (cur.isWord) {
      await loadWordContent()
      return
    }
    
    // 如果是PDF文件，由 PdfViewer 组件自行处理
    if (cur.isPdf) return
    
    const content = cur.content ?? ''
    if (cur.isMd){
      // 维持「正在渲染」状态：长文 md.render + mermaid/公式排版 + 两端对齐排版耗时明显
      isRendering.value = true
      try { await RenderMarkdown(content) } finally { isRendering.value = false }
    }
  }
  
  // 目录文字兜底：还原 markdown 转义（如 turndown 把段首「2. 」转义成的「2\. 」）。
  // 行内标记（**加粗** / `代码`）由 setupScrollSpy 里「以正文渲染文字为准」进一步处理。
  const tocPlainText = (s: any) =>
    String(s ?? '')
      .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()

  //渲染markdown
  const RenderMarkdown= async function(content?: string) {
    const cur = data.value
    const mdContent = content ?? (cur && cur.content) ?? ''
    if(mdContent!=''){
      // 让「正在渲染」提示先绘制出来：md.render 是同步重活，长文上会一直占着主线程
      await new Promise((r) => setTimeout(r, 0))
      // 在渲染前去除 YAML frontmatter
      const stripped = stripFrontmatter(mdContent)
      // 设置图片相对路径的基目录
      if (cur.path) {
        const normalizedPath = cur.path.replace(/\\/g, '/')
        const lastSlash = normalizedPath.lastIndexOf('/')
        mdBasePath = lastSlash >= 0 ? normalizedPath.substring(0, lastSlash + 1) : ''
      } else {
        mdBasePath = ''

      }
      prep.value = md.render(preprocessMath(stripped))
      // 目录：直接取本次渲染的标题锚点（与正文 h1~h6 一一对应，含 Word 转出的标题）。
      // 旧实现用正则自行重算标题与锚点，与插件生成的 id 不一致（且 setext/非 # 标题会漏），
      // 导致 Word 文档目录点不动 / 跳到错误章节。
      // 文字先去掉 markdown 转义与标记：turndown 会把段首「2. 」转义为「2\. 」（避免被当作有序列表），
      // 正文渲染后并不显示反斜杠，目录若直接用原始文本就会漏出转义符。
      toc.value = lastHeadingAnchors
        .filter((t: any) => t && t.anchor && String(t.content || '').trim())
        .map((t: any) => ({
          text: tocPlainText(t.content),
          level: Number(t.level) || 1,
          anchor: String(t.anchor),
        }))
      await nextTick()
      await renderMermaidDiagrams(document.querySelector<HTMLElement>('.prep'))
      await enhancePythonBlocks(document.querySelector<HTMLElement>('.prep'))
      // 只读态两端对齐排版（K-P 断行 + 逐行拉伸）；再延后一次兜住 MathJax / 图片尺寸变化
      typesetPrepared()
      observeTypeset()
      scheduleTypeset(prepRef.value, {}, 400)
      // 初始化 TOC 滚动联动（给标题标记序号，与 tocFlat 的 id 对位）
      setupScrollSpy()
      // 内容更新后清除旧的搜索高亮
      clearSearchMarks()
      searchMatches = []
      searchMatchCount.value = 0
      searchIndex.value = -1
      searchResults.value = []
    }
  }
  
  // 去除文本开头的 YAML frontmatter（以 `---` 包围）以便预览时不显示元数据
  function stripFrontmatter(content: string) {
    if (!content || typeof content !== 'string') return content
    const fmRegex = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/
    if (fmRegex.test(content)) {
      return content.replace(fmRegex, '').replace(/^\s+/, '')
    }
    return content
  }

  /** 预处理 LaTeX：统一沿用共享实现（`@/lib/markdown/render` 的 preprocessMath）
   *  —— 各处自建副本曾因 replace 替换串里的 `$$` 转义把块级公式降级成行内公式 */
  const preprocessMath = sharedPreprocessMath
  
  let selectedText = ref("");

  // 朗读状态（是否正在朗读）
  const isSpeaking = ref(false)
  // 定时刷新朗读状态（用于右键菜单切换"朗读/停止朗读"）
  let ttsStateTimer: ReturnType<typeof setInterval> | null = null

  const refreshTTSState = () => {
    const state = store.getTTSState()
    isSpeaking.value = !!(state && state.isSpeaking)
  }

  //发声（有选中文字时只朗读选中内容；正在朗读时点击则停止）
  async function speak() {
    if (isSpeaking.value) {
      store.stopTTS()
      hideContextMenu()
      refreshTTSState()
      return
    }

    let text = "";
    const cur = data.value
    
    if (cur.isWord) {
      text = wordContent.value || '';
    } else {
      text = cur.content || '';
    }
    
    if(selectedText.value!=""){
      text = selectedText.value;
    }
    store.tts(text)
    hideContextMenu()
    refreshTTSState()
  }
  
  //获取选中的文字
  const handleSelection=function() {
    selectedText.value = window.getSelection()?.toString()||'';
  }

  // 点击相对路径文件链接时，在 explorer 中打开对应文件
  const handlePrepClick = async function(e: MouseEvent) {
    // 优先检查 Python 运行按钮
    await handlePythonRunClick(e)
    if ((e.target as HTMLElement).closest('.python-run-btn')) return

    const target = e.target as HTMLElement

    // 1) 页内锚点链接（Word 目录页码 / 交叉引用 `#_Toc…`、markdown 内链 `#标题`）：
    //    只做页内滚动，绝不开子窗口，也不改动 URL hash（应用用 hash 路由）
    const anchorLink = target.closest('a.md-anchor-link') as HTMLAnchorElement | null
    if (anchorLink) {
      e.preventDefault()
      e.stopPropagation()
      scrollToAnchorLink(
        anchorLink.getAttribute('data-anchor') || (anchorLink.getAttribute('href') || '').replace(/^#/, ''),
        anchorLink.textContent || ''
      )
      return
    }

    // 2) 相对路径文件链接（可能是 <a> 本身或子元素）
    const link = target.closest('a.md-file-link') as HTMLAnchorElement | null
    if (!link) return

    let filePath = link.getAttribute('data-path')
    if (!filePath) return

    e.preventDefault()
    e.stopPropagation()

    // 解码可能被 markdown-it URL 编码的路径（如 %20 → 空格）
    try {
      filePath = decodeURI(filePath)
    } catch {
      // decodeURI 失败时尝试 decodeURIComponent
      try { filePath = decodeURIComponent(filePath) } catch {}
    }

    // 打开前先确认目标存在（远程只读模式跳过校验）：
    // 否则会弹出子窗口后只显示 `Error reading file: ENOENT`
    if (!props.isRemote) {
      try {
        const info = await (window as any).ipcRenderer?.invoke?.('getInf', filePath)
        if (!info) {
          ElMessage.warning(store.locales === 'zh' ? `目标文件不存在：${filePath}` : `File not found: ${filePath}`)
          return
        }
      } catch (err) {
        // 校验失败时按原逻辑继续打开
        console.warn('[md_read] 链接目标校验失败:', err)
      }
    }

    // 如果文件已打开，直接切换到对应标签页，避免重复读取
    const existingIndex = store.data.findIndex((d: any) => d.path === filePath)
    if (existingIndex >= 0) {
      store.index = existingIndex
      return
    }

    // 未打开时调用 store.openFileByMode 打开（按文件操作模式；知识库 .kb 跳转知识处理）
    await store.openFileByMode({
      path: filePath,
      label: filePath.replace(/\\/g, '/').split('/').pop() || 'file',
      type: 'file',
      extension: filePath.substring(filePath.lastIndexOf('.'))
    })
  }
  
  //当点击保存后刷新本页
  async function save(e:any) {
    if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)){
      e.preventDefault();
      await sleep(10)
      init()
    }
  }
  
  function sleep(interval:any){
    return new Promise((resolve)=>    
      setTimeout(resolve, interval)
    )
  }
  
  // 右键菜单状态
  const contextMenu = ref({ visible: false, x: 0, y: 0 })
  const hasSelection = ref(false)

  // 显示右键菜单
  const showContextMenu = function(e: MouseEvent) {
    e.preventDefault()
    selectedText.value = window.getSelection()?.toString() || ''
    hasSelection.value = !!selectedText.value
    refreshTTSState()
    contextMenu.value = { visible: true, x: e.clientX, y: e.clientY }
    // 朗读进行中时，定时刷新状态（播放可能自动结束）
    if (ttsStateTimer) clearInterval(ttsStateTimer)
    if (isSpeaking.value) {
      ttsStateTimer = setInterval(() => {
        refreshTTSState()
        if (!isSpeaking.value) {
          if (ttsStateTimer) clearInterval(ttsStateTimer)
          ttsStateTimer = null
        }
      }, 500)
    }
  }

  // 隐藏右键菜单
  const hideContextMenu = function() {
    contextMenu.value.visible = false
    if (ttsStateTimer) {
      clearInterval(ttsStateTimer)
      ttsStateTimer = null
    }
  }

  // 复制选中文字
  const copySelected = function() {
    const selected = window.getSelection()?.toString() || ''
    if (selected) {
      store.copyToClipboard(selected)
      ElMessage.success(store.locales === 'zh' ? '复制成功' : 'Copied')
    }
  }

  // 复制全文
  const copyFull = function() {
    store.copyToClipboard(data.value.isWord ? wordContent.value : data.value.content)
    ElMessage.success(store.locales === 'zh' ? '复制成功' : 'Copied')
  }

  // 点击页面其他区域关闭菜单
  const onDocumentClick = function() {
    hideContextMenu()
  }

  // 「导出为 Word」另存为对话框（样式 + 保存位置；默认定位到当前文件所在目录）
  const wordExportVisible = ref(false)
  const wordExportMarkdown = ref('')
  const wordExportTitle = ref('文档')
  const wordExportDir = ref('')

  // 打开「导出为 Word」另存为对话框（Unified 导出管线：数学公式 OMML / mermaid→PNG / 图片内联 + 可选样式皮肤）
  const exportToWord = function() {
    const mdContent = data.value.isWord ? wordContent.value : data.value.content
    if (!mdContent) return
    let title = ''
    if (data.value.path) {
      title = data.value.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '文档'
    } else {
      title = '文档'
    }
    // 计算文件所在目录（以 / 结尾）：既作相对图片路径的兜底基目录，也作对话框里默认的保存位置
    let baseDir = ''
    const curPath = data.value.path || ''
    if (curPath) {
      const normalized = curPath.replace(/\\/g, '/')
      const lastSlash = normalized.lastIndexOf('/')
      baseDir = lastSlash >= 0 ? normalized.substring(0, lastSlash + 1) : ''
    }
    wordExportMarkdown.value = mdContent
    wordExportTitle.value = title
    wordExportDir.value = baseDir
    wordExportVisible.value = true
  }

  const exportToMarkdown = function() {
    // Word 文档：导出主进程转换好的 Markdown（方便 Word → .md 转化）；
    // Markdown 文档：导出当前内容副本
    const mdContent = data.value.isWord ? wordContent.value : data.value.content
    if (!mdContent) return
    let title = ''
    if (data.value.path) {
      title = data.value.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '文档'
    } else {
      title = '文档'
    }
    const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // 导出当前文档为 PDF（隐藏窗口渲染 HTML → printToPDF）
  const exportToPdf = async function() {
    const container = prepRef.value
    const mdContent = data.value.isWord ? wordContent.value : data.value.content
    if (!container || !mdContent) return
    let title = '文档'
    if (data.value.path) {
      title = data.value.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || '文档'
    }
    // 克隆已渲染内容（含 mermaid SVG、公式等），不影响当前页面
    const clone = container.cloneNode(true) as HTMLElement
    // 将本地图片内联为 base64 data URL，保证隐藏窗口渲染 PDF 时图片可用（不依赖 file:// 访问权限）
    const inlinedHtml = await inlineLocalImagesAsDataUrls(clone.innerHTML)
    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${md.utils.escapeHtml(title)}</title>
<style>
  body { font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif; font-size: 14px; line-height: 1.8; color: #222; }
  h1 { font-size: 24px; margin: 24px 0 12px; }
  h2 { font-size: 20px; margin: 20px 0 10px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 17px; margin: 16px 0 8px; }
  h4, h5, h6 { margin: 12px 0 6px; }
  p { margin: 8px 0; }
  blockquote { border-left: 4px solid #ccc; margin: 12px 0; padding: 4px 16px; color: #555; background: #f9f9f9; }
  pre { background: #f5f5f5; border: 1px solid #ddd; padding: 10px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; font-size: 12.5px; }
  code { font-family: 'Courier New', Consolas, monospace; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 12.5px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #aaa; padding: 6px 10px; text-align: left; }
  th { background: #efefef; }
  img { max-width: 100%; height: auto; }
  a { color: #0066cc; }
  hr { border: none; border-top: 1px solid #ccc; }
  ul, ol { padding-left: 24px; }
  .mermaid svg { max-width: 100%; height: auto; }
  figure { margin: 12px 0; text-align: center; }
  figcaption { font-size: 12px; color: #888; margin-top: 4px; }
  .python-run-btn, .python-result, .md-search-bar, mark.search-mark { display: none !important; }
</style>
</head>
<body>
${inlinedHtml}
</body>
</html>`
    try {
      const res = await window.ipcRenderer.invoke('exportPdf', { html: fullHtml, title })
      if (res && res.success) {
        ElMessage.success(store.locales === 'zh' ? 'PDF 导出成功' : 'PDF exported successfully')
      } else if (res && res.error !== '用户取消') {
        ElMessage.error(store.locales === 'zh' ? 'PDF 导出失败' : 'PDF export failed')
      }
    } catch (err) {
      console.error('导出 PDF 失败:', err)
      ElMessage.error(store.locales === 'zh' ? 'PDF 导出失败' : 'PDF export failed')
    }
  }

  const openMetaEditor = async function(e?: any){
    if (e && e.stopPropagation) e.stopPropagation()
    const path = data.value.path
    console.log('md_read.openMetaEditor path=', path)
    if (!path) return
    try {
      let cfg = await window.ipcRenderer.invoke('getConfig', path)
      // 如果 getConfig 未返回有效元数据，尝试从文件 frontmatter 回退解析
      if (!cfg || Object.keys(cfg).length === 0) {
        try {
          const content = await window.ipcRenderer.invoke('readFile', path)
          const fmMatch = (content || '').match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/) 
          if (fmMatch && fmMatch[1]) {
            try {
              const parsed = yaml.load(fmMatch[1])
              if (parsed && typeof parsed === 'object') cfg = parsed
            } catch (e) {
              console.warn('yaml parse failed', e)
            }
          }
        } catch (e) {
        }
      }
      
      const entries: any[] = []
      if (cfg && typeof cfg === 'object') {
        for (const [k, v] of Object.entries(cfg)) {
          let valueStr = ''
          if (v === null || v === undefined) {
            valueStr = ''
          } else if (typeof v === 'object') {
            try {
              valueStr = JSON.stringify(v)
            } catch {
              valueStr = String(v)
            }
          } else {
            valueStr = String(v)
          }
          entries.push({ key: String(k), value: valueStr })
        }
      }
      
      const idx = entries.findIndex((e2: any) => e2.key === 'summary')
      if (idx > -1) entries.unshift(entries.splice(idx, 1)[0])
      
      // 确保使用响应式方式更新
      metaForm.value = entries
      
    } catch (err) {
      metaForm.value = []
    }
    // 左侧栏互斥：打开标签编辑时关闭目录 / 搜索
    iftoc.value = false
    searchVisible.value = false
    metaVisible.value = true
  }

  // 保存元数据（写回 frontmatter）
  const saveMeta = async function() {
    const path = data.value.path
    if (!path) return
    try {
      const obj: any = {}
      for (const entry of metaForm.value) {
        if (!entry || !entry.key) continue
        const key = String(entry.key)
        let val: any = entry.value
        try {
          const parsed = JSON.parse(entry.value)
          val = parsed
        } catch (e) {
          val = entry.value
        }
        obj[key] = val
      }
      const ok = await window.ipcRenderer.invoke('saveFileMetadata', path, obj)
      if (ok) {
        metaVisible.value = false
        // 尝试刷新当前渲染（如果内容来自磁盘则重新读取）
        if (!props.content && props.path) {
          const content = await window.ipcRenderer.invoke('readFile', props.path)
          await RenderMarkdown(content)
        } else {
          await init()
        }
      }
    } catch (e) {
      console.error('保存元数据失败', e)
    }
  }

  const openToc = async function(){
    const cur = data.value
    let content = ''
    
    if (cur.isWord) {
      content = wordContent.value || ''
    } else {
      content = cur?.content ?? ''
    }
    
    await RenderMarkdown(content)
    iftoc.value = true
  }
  
  // 监听图片缩放变化
  const onScaleChange = (scale: number) => {

  }
  
  // 监听图片重置
  const onImageReset = () => {
    console.log('图片已重置')
  }
  
  // 监听 props 的变化以刷新渲染
  watch(()=>[props.content, props.path], ()=>{
    init()
    // 路径更新时重新启动文件监听（先停止旧监听）
    const cur = data.value
    if (cur.path) {
      window.ipcRenderer.invoke('unwatchFile').then(() => {
        window.ipcRenderer.invoke('watchFile', cur.path)
      })
    }
  })

  // 文件变更自动刷新
  const handleFileChanged = async (event: any, { path: changedPath }: { path: string }) => {
    const cur = data.value
    if (!cur.path || cur.path !== changedPath) return
    // 外部变更：底部状态栏短暂提示已自动刷新
    flashFileChanged()
    // 重新读取文件内容
    const newContent = await window.ipcRenderer.invoke('readFile', cur.path)
    if (props.path) {
      // 通过 props 传入路径时，直接重新 init
      await init()
    } else if (store.data[store.index]?.path === cur.path) {
      store.data[store.index].content = newContent
      await init()
    }
  }
  
  // 子菜单溢出检测：当子菜单超出视口时自动翻转展开方向
  const handleSubmenuOverflow = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest('.has-submenu')
    if (!target) return
    const submenu = target.querySelector(':scope > .submenu') as HTMLElement
    if (!submenu) return

    requestAnimationFrame(() => {
      submenu.classList.remove('submenu-up', 'submenu-left')

      const rect = submenu.getBoundingClientRect()
      const viewportW = window.innerWidth
      const viewportH = window.innerHeight

      if (rect.bottom > viewportH) {
        submenu.classList.add('submenu-up')
      }
      if (rect.right > viewportW) {
        submenu.classList.add('submenu-left')
      }
    })
  }

  // ===== 全文搜索 =====
  const searchVisible = ref(false)
  const searchQuery = ref('')
  const searchMatchCount = ref(0)
  const searchIndex = ref(-1)
  const prepRef = ref<HTMLElement | null>(null)

  /** 排版正文（只读态）；已在排版中的异常不影响阅读 */
  const typesetPrepared = () => {
    const el = prepRef.value
    if (!el) return
    try {
      typesetRoot(el)
    } catch (e) {
      console.warn('[md_read] 排版失败：', e)
    }
  }
  /** 正文宽度变化（目录 / 对话面板 / 窗口）→ 防抖重排 */
  let typesetObserver: ResizeObserver | null = null
  let disposeCopyFix: (() => void) | null = null
  const observeTypeset = () => {
    const el = prepRef.value
    if (!el || typeof ResizeObserver === 'undefined') return
    disposeCopyFix?.()
    disposeCopyFix = installTypesetCopyFix(el)
    typesetObserver?.disconnect()
    typesetObserver = new ResizeObserver(() => scheduleTypeset(prepRef.value, {}, 120))
    typesetObserver.observe(el)
  }
  onMounted(() => {
    nextTick(observeTypeset)
  })
  onBeforeUnmount(() => {
    typesetObserver?.disconnect()
    typesetObserver = null
    disposeCopyFix?.()
    disposeCopyFix = null
  })
  const searchInputRef = ref<HTMLInputElement | null>(null)
  let searchMatches: HTMLElement[] = []
  const searchResults = ref<{ idx: number; html: string }[]>([])

  // 清除文档中所有搜索高亮
  const clearSearchMarks = () => {
    const container = prepRef.value
    if (!container) return
    container.querySelectorAll('mark.search-mark').forEach((m) => {
      const parent = m.parentNode
      if (!parent) return
      parent.replaceChild(document.createTextNode(m.textContent || ''), m)
      parent.normalize()
    })
  }

  // 跳转到第 dir 个（相对当前）匹配项
  const gotoSearchMatch = (dir: 1 | -1) => {
    if (searchMatches.length === 0) return
    searchIndex.value = (searchIndex.value + dir + searchMatches.length) % searchMatches.length
    const el = searchMatches[searchIndex.value]
    searchMatches.forEach((m, i) => m.classList.toggle('search-current', i === searchIndex.value))
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    searchInputRef.value?.focus()
  }

  const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

  // 为搜索结果列表生成摘要（匹配文字高亮，前后各截取一段上下文）
  const buildSearchResults = (marks: HTMLElement[]) => {
    const res: { idx: number; html: string }[] = []
    marks.forEach((m, i) => {
      const parent = m.parentElement
      if (!parent) return
      const full = parent.textContent || ''
      const matched = m.textContent || ''
      const start = full.indexOf(matched)
      const ctxBefore = Math.max(0, start - 26)
      const endAt = start + matched.length + 64
      const before = full.slice(ctxBefore, start)
      const after = full.slice(start + matched.length, Math.min(endAt, full.length))
      const prefix = ctxBefore > 0 ? '…' : ''
      const suffix = endAt < full.length ? '…' : ''
      res.push({ idx: i, html: `${prefix}${escHtml(before)}<mark class="md-res-hl">${escHtml(matched)}</mark>${escHtml(after)}${suffix}` })
    })
    return res
  }

  // 全文搜索：遍历文本节点并用 <mark> 高亮所有匹配
  const doSearch = () => {
    clearSearchMarks()
    const container = prepRef.value
    const q = searchQuery.value.trim()
    searchMatches = []
    searchMatchCount.value = 0
    searchIndex.value = -1
    searchResults.value = []
    if (!q || !container) return

    const textNodes: Text[] = []
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const parent = node.parentElement
      if (!parent) continue
      if (parent.closest('svg')) continue
      if (parent.classList.contains('search-mark')) continue
      textNodes.push(node)
    }

    const lowerQ = q.toLowerCase()
    textNodes.forEach((node) => {
      const text = node.nodeValue || ''
      if (!text.toLowerCase().includes(lowerQ)) return
      const frag = document.createDocumentFragment()
      let rest = text
      while (rest.length > 0) {
        const idx = rest.toLowerCase().indexOf(lowerQ)
        if (idx === -1) {
          frag.appendChild(document.createTextNode(rest))
          break
        }
        if (idx > 0) {
          frag.appendChild(document.createTextNode(rest.slice(0, idx)))
        }
        const mark = document.createElement('mark')
        mark.className = 'search-mark'
        mark.textContent = rest.slice(idx, idx + q.length)
        frag.appendChild(mark)
        searchMatches.push(mark)
        rest = rest.slice(idx + q.length)
      }
      node.parentNode?.replaceChild(frag, node)
    })

    searchResults.value = buildSearchResults(searchMatches)
    searchMatchCount.value = searchMatches.length
    // 高亮是包在行内的 <mark>，宽度会微变 → 重排一次（防抖）
    scheduleTypeset(prepRef.value, {}, 150)
    if (searchMatches.length > 0) {
      gotoSearchMatch(1)
    } else {
      searchIndex.value = -1
    }
  }

  // 点击结果列表项 → 跳转到正文对应匹配
  const gotoSearchResult = (i: number) => {
    if (!searchMatches.length || i < 0 || i >= searchMatches.length) return
    searchIndex.value = i
    const el = searchMatches[i]
    searchMatches.forEach((m, j) => m.classList.toggle('search-current', j === i))
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const openSearch = () => {
    // 左侧栏互斥：打开搜索时关闭目录 / 标签
    iftoc.value = false
    metaVisible.value = false
    searchVisible.value = true
    nextTick(() => {
      searchInputRef.value?.focus()
      searchInputRef.value?.select()
    })
  }

  const closeSearch = () => {
    clearSearchMarks()
    searchVisible.value = false
    searchQuery.value = ''
    searchMatches = []
    searchMatchCount.value = 0
    searchIndex.value = -1
    searchResults.value = []
  }

  // Ctrl+F 打开搜索 / Esc 关闭
  const handleSearchKey = (e: KeyboardEvent) => {
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault()
      openSearch()
    } else if (e.key === 'Escape' && searchVisible.value) {
      closeSearch()
    }
  }

  // ===== TOC 滚动联动 =====
  const activeTocIndex = ref(-1)
  // 与 tocFlat 顺序一致的正文标题元素（点击目录时按下标精确跳转，不再依赖 DOM 全局序号）
  let headingEls: HTMLElement[] = []

  // 给渲染后的标题标记 data-toc-idx（与 tocFlat 的 id 对应）
  const setupScrollSpy = () => {
    const container = prepRef.value
    if (!container) return
    const anchors = new Set(toc.value.map((t) => t.anchor))
    const all = Array.from(container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    // 只保留目录中登记过的标题（正文内手工 HTML 标题不进目录，避免索引错位）
    const matched = all.filter((h) => anchors.has(h.getAttribute('id') || ''))
    headingEls = matched.length > 0 ? matched : all
    headingEls.forEach((h, i) => h.setAttribute('data-toc-idx', String(i + 1)))
    // 目录文字最终以正文渲染结果为准（与阅读所见完全一致：无转义符、无 markdown 标记；
    // 若个别标题 textContent 为空（如纯公式标题）则保留原文字）
    if (headingEls.length === toc.value.length) {
      toc.value = toc.value.map((t, i) => {
        const shown = (headingEls[i].textContent || '').replace(/\s+/g, ' ').trim()
        return shown ? { ...t, text: shown } : t
      })
    }
    onPrepScroll()
  }

  // 滚动时更新阅读进度 / 当前章节（供目录高亮与状态栏显示）
  const onPrepScroll = () => {
    const container = prepRef.value
    if (!container) return

    // 阅读进度（滚动位置百分比）
    const maxScroll = container.scrollHeight - container.clientHeight
    readingProgress.value = maxScroll > 0 ? Math.min(100, Math.round((container.scrollTop / maxScroll) * 100)) : 0

    const headings = headingEls
    if (headings.length === 0) {
      activeTocIndex.value = -1
      currentSectionText.value = ''
      return
    }
    const anchor = container.getBoundingClientRect().top + 60
    let currentIdx = -1
    headings.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= anchor) {
        currentIdx = i + 1
      }
    })
    activeTocIndex.value = currentIdx
    // 当前章节文字（供底部状态栏展示）
    if (currentIdx > 0) {
      currentSectionText.value = (headings[currentIdx - 1]?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    } else {
      currentSectionText.value = ''
    }
  }

  // 点击目录项平滑滚动到对应标题
  const scrollToToc = (id: number) => {
    const el = headingEls[id - 1]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      activeTocIndex.value = id
    }
  }

  // ===== 正文页内锚点跳转（Word 目录页码链接、markdown 内链） =====
  /** 按文字匹配正文标题（Word 内部书签在转 Markdown 时丢失，只能靠目录文字回退定位） */
  const findHeadingByText = (text: string): HTMLElement | null => {
    const key = normalizeAnchorText(text)
    if (!key) return null
    const candidates = headingEls.length
      ? headingEls
      : Array.from(prepRef.value?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') || [])
    let loose: HTMLElement | null = null
    for (const h of candidates) {
      const hk = normalizeAnchorText(h.textContent || '')
      if (!hk) continue
      if (hk === key) return h
      if (!loose && (hk.includes(key) || key.includes(hk))) loose = h
    }
    return loose
  }

  /** 页内锚点跳转：先按 id/name 找目标；找不到再按链接文字匹配标题 */
  const scrollToAnchorLink = (rawId: string, linkText: string) => {
    const container = prepRef.value
    if (!container) return
    let id = rawId || ''
    try { id = decodeURIComponent(id) } catch { /* 保留原值 */ }
    const esc = (v: string) =>
      (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
        ? CSS.escape(v)
        : v.replace(/["\\\]]/g, '\\$&')
    let target: HTMLElement | null = null
    if (id) {
      target = container.querySelector<HTMLElement>(`[id="${esc(id)}"], [name="${esc(id)}"]`)
    }
    // Word 目录/交叉引用指向 Word 内部书签（_Toc/_Ref…），转换后该 id 已丢失
    if (!target) target = findHeadingByText(linkText)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const idx = headingEls.indexOf(target)
    if (idx >= 0) activeTocIndex.value = idx + 1
    // 平滑滚动期间 scroll 事件滞后，立即刷新一次当前章节/进度
    onPrepScroll()
  }

  // ===== 底部状态栏 =====
  const showStatusbar = computed(() => {
    const d = data.value
    if (d.isTxt || d.isMd) return d.content !== ''
    if (d.isWord) return wordContent.value !== ''
    return false
  })

  // 文档统计（字数/字符）—— 纯函数计算，避免滚动时重复触发
  const computeStats = (text: string) => {
    if (!text) return { words: 0, chars: 0 }
    const stripped = stripFrontmatter(text)
    // 去掉代码块/行内代码
    const noCode = stripped
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
    // 去掉 markdown 图片语法、标题标记等；链接保留文字
    const plain = noCode
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[#>*+\-\s]{1,8}\s*/gm, ' ')
      .replace(/[*_~|]/g, ' ')
    // CJK 按字计数；拉丁/数字按单词计数
    const cjk = (plain.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
    const latin = (plain
      .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
      .match(/[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/g) || []).length
    return { words: cjk + latin, chars: plain.replace(/\s+/g, '').length }
  }
  const docStats = computed(() => {
    const d = data.value
    if (d.isWord) return computeStats(wordContent.value)
    if (d.isMd || d.isTxt) return computeStats(d.content || '')
    return { words: 0, chars: 0 }
  })
  const formatNum = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const docWordsLabel = computed(() => {
    const base = formatNum(docStats.value.words)
    return base + (store.locales === 'zh' ? ' 字' : ' words')
  })

  // 阅读进度 / 当前章节（由 onPrepScroll 驱动）
  const readingProgress = ref(0)
  const currentSectionText = ref('')
  const scrollToTop = () => {
    const c = prepRef.value
    if (!c) return
    c.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // 文件外部变更提示（自动刷新后短暂提示）
  const fileChangedTip = ref(false)
  let fileChangedTipTimer: ReturnType<typeof setTimeout> | null = null
  const flashFileChanged = () => {
    fileChangedTip.value = true
    if (fileChangedTipTimer) clearTimeout(fileChangedTipTimer)
    fileChangedTipTimer = setTimeout(() => { fileChangedTip.value = false }, 3000)
  }

  // ===== 左侧栏互斥工具（目录 / 标签 / 搜索） =====
  const toggleToc = async () => {
    if (iftoc.value) { setTocOpen(false); return }
    // 目录尚未计算时先渲染补齐（通常内容加载时已算好，避免重渲染导致阅读位置丢失）
    if (toc.value.length === 0) await openToc()
    setTocOpen(true)
    metaVisible.value = false
    searchVisible.value = false
  }
  const toggleMeta = () => {
    if (metaVisible.value) { metaVisible.value = false; return }
    openMetaEditor()
  }
  const toggleSearch = () => {
    if (searchVisible.value) { closeSearch(); return }
    openSearch()
  }

  // TTS 朗读状态轮询（store 无事件订阅，低频轮询保持状态栏同步）
  let ttsPollTimer: ReturnType<typeof setInterval> | null = null
  const startTtsPoll = () => {
    if (ttsPollTimer) return
    refreshTTSState()
    ttsPollTimer = setInterval(() => refreshTTSState(), 600)
  }
  const stopTtsPoll = () => {
    if (ttsPollTimer) { clearInterval(ttsPollTimer); ttsPollTimer = null }
  }

  // 导出下拉菜单
  const exportMenuOpen = ref(false)
  const closeExportMenu = () => { exportMenuOpen.value = false }
  const toggleExportMenu = () => {
    if (exportMenuOpen.value) {
      closeExportMenu()
      document.removeEventListener('click', closeExportMenu)
    } else {
      exportMenuOpen.value = true
      document.addEventListener('click', closeExportMenu)
    }
  }
  const chooseExport = async (kind: 'md' | 'word' | 'pdf') => {
    exportMenuOpen.value = false
    document.removeEventListener('click', closeExportMenu)
    if (kind === 'md') exportToMarkdown()
    else if (kind === 'word') await exportToWord()
    else await exportToPdf()
  }

  // ===== 左侧栏（目录 / 标签 / 搜索 互斥共用，宽度可拖动并记忆） =====
  // 目录面板已抽成共享组件 DocTocPanel，标签/搜索仍用这里的原左侧栏；
  // 宽度与其它视图共用一个 key + 同一个初始值（见 lib/markdown/toc.ts）
  const tocNavWidth = ref(loadDocTocWidth())
  // 目录面板现在走共享组件（DocTocPanel）拖宽 → 宽度变化时就持久化（组件内部不会再回调拖拽结束）
  watch(tocNavWidth, (v) => saveDocTocWidth(v))
  let tocDrag: { startX: number; startW: number } | null = null
  const onTocDragMove = (e: MouseEvent) => {
    if (!tocDrag) return
    const next = tocDrag.startW + (e.clientX - tocDrag.startX)
    tocNavWidth.value = Math.max(DOC_TOC_MIN_WIDTH, Math.min(DOC_TOC_MAX_WIDTH, next))
  }
  const onTocDragEnd = () => {
    tocDrag = null
    document.removeEventListener('mousemove', onTocDragMove)
    document.removeEventListener('mouseup', onTocDragEnd)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    saveDocTocWidth(tocNavWidth.value)
  }
  const startTocDrag = (e: MouseEvent) => {
    e.preventDefault()
    tocDrag = { startX: e.clientX, startW: tocNavWidth.value }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onTocDragMove)
    document.addEventListener('mouseup', onTocDragEnd)
  }

  // ===== 右侧「智能操作」文档对话面板（与 md / Word / txt 文档对话） =====
  const chatOpen = ref(false)
  // 宽度与其它视图（源码编辑 / 可视编辑 / PDF）共用同一个 key 与默认值
  const chatPanelWidth = ref(loadDocChatWidth())
  let chatDrag: { startX: number; startW: number } | null = null
  const onChatDragMove = (e: MouseEvent) => {
    if (!chatDrag) return
    // 面板在右侧：向左拖动 = 变宽
    const next = chatDrag.startW - (e.clientX - chatDrag.startX)
    chatPanelWidth.value = Math.max(DOC_CHAT_MIN_WIDTH, Math.min(DOC_CHAT_MAX_WIDTH, next))
  }
  const onChatDragEnd = () => {
    chatDrag = null
    document.removeEventListener('mousemove', onChatDragMove)
    document.removeEventListener('mouseup', onChatDragEnd)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    saveDocChatWidth(chatPanelWidth.value)
  }
  const startChatDrag = (e: MouseEvent) => {
    e.preventDefault()
    chatDrag = { startX: e.clientX, startW: chatPanelWidth.value }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onChatDragMove)
    document.addEventListener('mouseup', onChatDragEnd)
  }
  const toggleChat = () => { chatOpen.value = !chatOpen.value }

  // 上下文 1：整篇文档（md / Word / txt），与预览一致地去掉 frontmatter
  const docContextFull = (): string => {
    const d = data.value
    const raw = d.isWord ? (wordContent.value || '') : (d.content || '')
    return stripFrontmatter(raw || '')
  }
  // 上下文 2：当前章节（当前标题 → 下一个同级/更高级标题之前；未滚动到标题时取第一章）
  const docContextSection = (): string => {
    const container = prepRef.value
    if (!container || headingEls.length === 0) return ''
    let idx = activeTocIndex.value - 1
    if (idx < 0) idx = 0
    const start = headingEls[idx]
    if (!start) return ''
    const level = Number((start.tagName || '').slice(1)) || 1
    let endEl: HTMLElement | null = null
    for (let i = idx + 1; i < headingEls.length; i++) {
      if ((Number((headingEls[i].tagName || '').slice(1)) || 1) <= level) { endEl = headingEls[i]; break }
    }
    try {
      const range = document.createRange()
      range.setStartBefore(start)
      if (endEl) range.setEndBefore(endEl)
      else range.setEnd(container, container.childNodes.length)
      return range.toString().replace(/\n{2,}/g, '\n').trim()
    } catch {
      return ''
    }
  }
  // 上下文 3：当前选中文字（点输入框会失焦丢选区，用面板记下的快照兜底）
  const docContextSelection = (): string => (window.getSelection()?.toString() || '').trim()
  const getDocContext = (key: string, snapshot?: string): string => {
    if (key === 'full') return docContextFull()
    if (key === 'section') return docContextSection()
    if (key === 'selection') return docContextSelection() || (snapshot || '').trim()
    return ''
  }
  // 可附带的上下文（按钮顺序即展示顺序，full 为默认附带项）
  const chatAttachOptions = computed(() => {
    const zh = store.locales === 'zh'
    const isWord = data.value.isWord
    // 让选项数组随「当前章节 / 当前选区 / 文档内容」重建：面板随之重渲染，
    // 悬浮提示里的字数才不会停在第一次统计的旧数字上（这三个都不是数组自身的依赖）
    void activeTocIndex.value
    void selectedText.value
    void (data.value.content || '').length
    return [
      {
        key: 'full',
        // 按钮统一叫「全文」（与 PDF 对话面板一致）
        label: zh ? '全文' : 'Full',
        icon: 'fa-align-left',
        title: zh ? '附带整篇文档内容' : 'Attach full document',
        // 气泡/参考标签仍标明文档类型，便于区分附带了什么
        tag: zh ? (isWord ? 'Word 全文' : '文档全文') : 'Full document',
        default: true,
        // 悬浮时统计字符数；版本用正文长度，内容变了就失效重算
        count: () => docContextFull().length,
        countRev: () => (data.value.content || wordContent.value || '').length,
      },
      {
        key: 'section',
        label: zh ? '当前章节' : 'Section',
        // Font Awesome 4.7 无 fa-heading（FA5 才有），须用 fa-header
        icon: 'fa-header',
        title: zh ? '附带当前阅读到的章节' : 'Attach current section',
        // 章节内容随阅读位置变化 → 版本用当前标题下标，滚动后悬浮看到的是新的字数
        count: () => docContextSection().length,
        countRev: () => activeTocIndex.value,
      },
      {
        key: 'selection',
        label: zh ? '选中文字' : 'Selection',
        icon: 'fa-i-cursor',
        title: zh ? '附带当前选中的文字' : 'Attach selected text',
        usesSelection: true,
        // 没有选区时返回 NaN（面板会忽略，不显示「0 字符」）；版本用当前选区长度，换选区即失效
        count: () => { const t = docContextSelection(); return t ? t.length : NaN },
        countRev: () => `${selectedText.value.length}:${docContextSelection().length}`,
      },
    ]
  })

  onMounted(()=>{
    // 本地图片 onerror 兜底（须在 init 前注册，避免图片先于兜底函数加载）
    ;(window as any).__mdFixLocalImg = mdFixLocalImg
    init()
    window.addEventListener('keydown', save)
    window.addEventListener('keydown', handleSearchKey)
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('mouseover', handleSubmenuOverflow)
    // 监听文件变更
    window.ipcRenderer.on('watchedFileChanged', handleFileChanged)
    // 启动文件监听
    const cur = data.value
    if (cur.path) {
      window.ipcRenderer.invoke('watchFile', cur.path)
    }
    // 启动 TTS 状态轮询（供底部状态栏/右键菜单实时反映朗读状态）
    startTtsPoll()
  })
  
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', save)
    window.removeEventListener('keydown', handleSearchKey)
    document.removeEventListener('click', onDocumentClick)
    document.removeEventListener('mouseover', handleSubmenuOverflow)
    // 移除文件监听
    window.ipcRenderer.off('watchedFileChanged', handleFileChanged)
    window.ipcRenderer.invoke('unwatchFile')
    // 停止 TTS 轮询 / 清理导出菜单监听 / 清理变更提示定时器 / 清理目录与对话面板拖拽
    stopTtsPoll()
    document.removeEventListener('click', closeExportMenu)
    if (fileChangedTipTimer) clearTimeout(fileChangedTipTimer)
    onTocDragEnd()
    onChatDragEnd()
    // 仅当全局兜底仍是本实例注册的才清理（同窗口可能存在多个 md_read 实例）
    if ((window as any).__mdFixLocalImg === mdFixLocalImg) delete (window as any).__mdFixLocalImg
  })

  // ===== Mermaid 查看（复用共享组件 MermaidViewer：放大/平移/导出） =====
  const mermaidViewerRef = ref<InstanceType<typeof MermaidViewer> | null>(null)
  const openMermaidModal = (source: string) => { mermaidViewerRef.value?.open({ source }) }
</script>

<template >
  <div class="md" :style="{ '--md-read-font': readFontSize + 'px' }">
    <!-- 目录：共享组件（结构与样式与源码编辑 / 块编辑完全一致）。
         注意两处让位，否则左侧会同时出现两个目录面板：
         1) PDF 的目录（书签）由内嵌的 PdfViewer 用同一套 DocTocPanel 渲染，这里不渲染；
         2) 没有标题（含图片 / 音视频 / 白板等无标题文档）时不渲染空目录面板，
            与状态栏「目录」按钮的显示条件（toc.length > 0）保持一致。 -->
    <DocTocPanel
      v-if="!data.isPdf && toc.length > 0"
      :open="iftoc"
      @update:open="setTocOpen"
      v-model:width="tocNavWidth"
      :items="tocFlat"
      :active-id="activeTocIndex > 0 ? activeTocIndex : null"
      :min-width="DOC_TOC_MIN_WIDTH"
      :max-width="DOC_TOC_MAX_WIDTH"
      reserve-statusbar
      @select="scrollToToc"
    />

    <!-- 编辑标签 / 全文搜索：沿用原左侧栏（与目录互斥） -->
    <div class="nav resize" v-if="metaVisible || searchVisible" :style="{ width: tocNavWidth + 'px' }">
      <div class="toc-resizer" @mousedown.prevent.stop="startTocDrag" :title="store.locales==='zh' ? '拖动调整宽度' : 'Drag to resize'"></div>

      <!-- 编辑标签 -->
      <div v-if="metaVisible" class="left-body">
        <div class="left-panel-head">
          <span class="left-panel-title"><i class="fa fa-tags"></i> {{ store.locales==='zh' ? '编辑标签' : 'Edit Tags' }}</span>
          <button class="left-panel-close" @click="metaVisible=false" :title="store.locales==='zh' ? '关闭' : 'Close'"><i class="fa fa-times"></i></button>
        </div>
        <div class="left-scroll scoll meta-scroll">
          <div v-if="metaForm.length===0" class="meta-editor-empty">{{store.locales==='zh'?'暂无元数据':'No metadata'}}</div>
          <div v-for="(entry, idx) in metaForm" :key="idx" class="meta-card">
            <div class="meta-card-top">
              <input v-model="entry.key" class="meta-card-key" :placeholder="store.locales==='zh' ? '字段名 / key' : 'Field / key'" />
              <button class="meta-card-del" @click="metaForm.splice(idx,1)" :title="store.locales==='zh' ? '删除该字段' : 'Delete field'"><i class="fa fa-trash"></i></button>
            </div>
            <textarea v-model="entry.value" class="meta-card-value scoll" rows="3" :placeholder="store.locales==='zh' ? '内容 / value（可粘贴 JSON）' : 'Value (JSON ok)'"></textarea>
          </div>
        </div>
        <div class="left-panel-actions">
          <button class="meta-editor-btn" @click="metaForm.push({key:'',value:''})"><i class="fa fa-plus"></i> {{store.locales==='zh'?'添加字段':'Add field'}}</button>
          <div class="meta-editor-spacer"></div>
          <button class="meta-editor-btn" @click="metaVisible=false">{{store.locales==='zh'?'取消':'Cancel'}}</button>
          <button class="meta-editor-btn meta-editor-btn-primary" @click="saveMeta"><i class="fa fa-check"></i> {{store.locales==='zh'?'保存':'Save'}}</button>
        </div>
      </div>

      <!-- 全文搜索 -->
      <div v-else-if="searchVisible" class="left-body">
        <div class="left-panel-head md-search-head">
          <span class="left-panel-title"><i class="fa fa-search"></i> {{ store.locales==='zh' ? '全文搜索' : 'Search' }}</span>
          <div class="left-head-tools">
            <span class="md-search-count" :title="searchQuery ? (searchMatchCount ? (store.locales==='zh' ? searchMatchCount + ' 个结果' : searchMatchCount + ' results') : (store.locales==='zh' ? '无匹配' : 'No match')) : ''">{{ searchMatchCount ? (searchIndex + 1) + '/' + searchMatchCount : '0/0' }}</span>
            <button class="md-search-btn" @click="gotoSearchMatch(-1)" :disabled="!searchMatchCount" :title="store.locales=='zh'?'上一个':'Previous'"><i class="fa fa-chevron-up"></i></button>
            <button class="md-search-btn" @click="gotoSearchMatch(1)" :disabled="!searchMatchCount" :title="store.locales=='zh'?'下一个':'Next'"><i class="fa fa-chevron-down"></i></button>
            <button class="left-panel-close" @click="closeSearch" :title="store.locales==='zh' ? '关闭搜索 (Esc)' : 'Close search (Esc)'"><i class="fa fa-times"></i></button>
          </div>
        </div>
        <!-- 输入框：单独一行 -->
        <div class="md-search-bar">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            class="md-search-input"
            :placeholder="store.locales=='zh'?'在文档中搜索...':'Search in document...'"
            @input="doSearch"
            @keydown.enter.prevent="gotoSearchMatch(1)"
            @keydown.shift.enter.prevent="gotoSearchMatch(-1)"
          />
        </div>
        <!-- 结果列表 -->
        <div class="md-search-list scoll">
          <div v-for="r in searchResults" :key="r.idx" class="md-search-item" :class="{ current: r.idx === searchIndex }" @click="gotoSearchResult(r.idx)" v-html="r.html"></div>
        </div>
      </div>
    </div>
    
    <div class="content" :class="{ 'content-full': !showStatusbar }" @contextmenu.prevent="showContextMenu">
      <!-- 右键菜单 -->
      <div v-if="contextMenu.visible && data && (data.isMd || data.isWord)" 
           class="context-menu" 
           :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
           @click.stop="hideContextMenu">
        <div class="menu-item" v-if="hasSelection" @click.stop="copySelected(); hideContextMenu()"><i class="fa fa-copy"></i> {{store.locales=='zh'?'复制文字':'Copy Text'}}</div>
        <div class="menu-item" v-if="!hasSelection" @click.stop="copyFull(); hideContextMenu()"><i class="fa fa-copy"></i> {{store.locales=='zh'?'复制全文':'Copy Full Text'}}</div>
        <div class="menu-item" @click.stop="speak()"><i :class="isSpeaking ? 'fa fa-stop' : 'fa fa-volume-up'"></i> {{ isSpeaking ? (store.locales=='zh'?'停止朗读':'Stop Reading') : (hasSelection ? (store.locales=='zh'?'朗读选中文字':'Read Selection') : (store.locales=='zh'?'朗读文章':'Read Article')) }}</div>
      </div>
      
      <!-- 正在渲染/加载（与可视编辑视图的渲染遮罩一致）：大文档读盘 + 渲染耗时较长，
           这期间不能显示“文件无内容和数据” -->
      <div v-if="showRenderingState" class="loading-state">
        <i class="fa fa-spinner fa-spin"></i>
        <span>{{ renderingLabel }}</span>
      </div>

      <!-- 空内容提示 -->
      <div class="nodata" v-if="!showRenderingState && !data.isWord && !data.isPdf && !data.isExcalidraw && !data.isDrawio && !data.isHtml && data.content=='' && !data.isImage && !data.isVideo && !data.isAudio">
        <h5 style="width: 100%;text-align: center;">{{store.locales=='zh'?'文件无内容和数据':'No Data'}}</h5>
      </div>
      
      <!-- Word文档加载状态 -->
      <div v-if="data.isWord && isLoadingWord" class="loading-state">
        <i class="fa fa-spinner fa-spin"></i>
        <span>{{store.locales=='zh'?'正在加载Word文档...':'Loading Word document...'}}</span>
      </div>
      
      <!-- Word文档错误信息 -->
      <div v-else-if="data.isWord && wordError" class="error-state">
        <i class="fa fa-exclamation-triangle"></i>
        <span>{{ wordError }}</span>
        <button @click="loadWordContent" class="retry-btn">
          <i class="fa fa-refresh"></i> {{store.locales=='zh'?'重试':'Retry'}}
        </button>
      </div>
      
      <!-- Word文档内容（渲染为Markdown） -->
      <div v-else-if="data.isWord && wordContent && prep!=''" ref="prepRef" class="prep scoll" v-html="prep" @mouseup="handleSelection" @keyup="handleSelection" @click="handlePrepClick" @scroll="onPrepScroll">
      </div>
      
      <!-- 音视频文件显示（统一使用 Media 播放器） -->
      <div v-if="data.isVideo || data.isAudio" class="nodata">
        <Media :path="data.path" :content="data.content" @update:path="onMediaPathChange" />
      </div>
      
      <!-- 图片文件显示 - 使用独立的图片组件 -->
      <div v-if="data.isImage && data.path" class="nodata">
        <ImageZoom 
          :path="data.path" 
          :src="data.imageDataUrl || undefined"
          :enable-dragging="true"
          :min-scale="0.1"
          :max-scale="8"
          :wheel-step="0.05"
          :show-controls="true"
          @scale-change="onScaleChange"
          @update:path="onMediaPathChange"
        />
      </div>
      
      <!-- 纯文本文件显示 -->
      <div v-if="data.isTxt&&data.content!=''" ref="prepRef" class="prep scoll" v-html="data.content" @mouseup="handleSelection" @keyup="handleSelection" @scroll="onPrepScroll">
      </div>
      
      <!-- PDF 文件显示 -->
      <PdfViewer v-if="data.isPdf" :path="data.path" :base64="data.remoteBase64" />
      
      <!-- Excalidraw 白板显示（预览 + 编辑） -->
      <Excalidraw v-if="data.isExcalidraw" :path="data.path" :content="data.content" />

      <!-- draw.io 图表显示（预览 + 编辑，远程文件只读） -->
      <Drawio v-if="data.isDrawio" :path="data.path" :content="data.content" :readonly="data.isRemote" />
      
      <!-- HTML 文件显示（iframe 渲染） -->
      <div v-if="data.isHtml" class="html-preview">
        <iframe v-if="!isBrowserMode && htmlSrc" class="html-frame" :src="htmlSrc" :title="data.path" />
        <iframe v-else class="html-frame" :srcdoc="data.content || ''" :title="data.path" />
      </div>
      
      <!-- Markdown 文件显示 -->
      <div v-if="data.isMd&&prep!=''" ref="prepRef" class="prep scoll" v-html="prep" @mouseup="handleSelection" @keyup="handleSelection" @click="handlePrepClick" @scroll="onPrepScroll">
      </div>
      
      <!-- 其他格式文件处理 -->
      <div class="nodata" v-if="!data.isMd && !data.isWord && !data.isImage && !data.isVideo && !data.isAudio && !data.isTxt && !data.isPdf && !data.isExcalidraw && !data.isDrawio && !data.isHtml && data.content!=''">
      </div>
    </div>

    <!-- 右侧：智能操作（与当前 md / Word 文档对话，无标题栏，靠状态栏图标开关） -->
    <aside v-if="chatOpen" class="md-chat-panel" :class="{ full: !showStatusbar }" :style="{ width: chatPanelWidth + 'px' }">
      <div class="md-chat-resizer" @mousedown.prevent.stop="startChatDrag" :title="store.locales==='zh' ? '拖动调整宽度' : 'Drag to resize'"></div>
      <DocChatPanel
        :doc-key="data.path"
        :attach-options="chatAttachOptions"
        :get-context="getDocContext"
        :hint="store.locales==='zh'
          ? (data.isWord ? '对这份 Word 文档提问（可附全文 / 当前章节 / 选中文字）' : '对这份文档提问（可附全文 / 当前章节 / 选中文字）')
          : 'Ask about this document (attach full text / section / selection)'"
      />
    </aside>

    <!-- 底部状态栏（样式与 PdfViewer / Edit_Code 一致） -->
    <div class="md-statusbar" v-if="showStatusbar" @contextmenu.prevent>
      <!-- 操作按钮（左侧） -->
      <!-- 目录开/关 -->
      <button v-if="toc.length > 0" class="statusbar-btn" :class="{ active: iftoc }" @click="toggleToc" :title="store.locales==='zh' ? (iftoc ? '关闭目录' : '打开目录') : (iftoc ? 'Close TOC' : 'Open TOC')">
        <i class="fa fa-bars"></i>
      </button>
      <!-- 编辑标签（本机 md，左栏） -->
      <button v-if="data.isMd && data.path && !data.isRemote" class="statusbar-btn" :class="{ active: metaVisible }" @click="toggleMeta" :title="store.locales==='zh' ? (metaVisible ? '关闭标签编辑' : '编辑标签') : (metaVisible ? 'Close tags' : 'Edit tags')">
        <i class="fa fa-tags"></i>
      </button>
      <!-- 全文搜索开关 -->
      <button class="statusbar-btn" :class="{ active: searchVisible }" @click="toggleSearch" :title="store.locales==='zh' ? (searchVisible ? '关闭搜索 (Esc)' : '搜索 (Ctrl+F)') : (searchVisible ? 'Close search (Esc)' : 'Search (Ctrl+F)')">
        <i class="fa fa-search"></i>
      </button>
      <!-- 回到顶部 -->
      <button class="statusbar-btn" @click="scrollToTop" :title="store.locales==='zh' ? '回到顶部' : 'Back to top'">
        <i class="fa fa-arrow-up"></i>
      </button>
      <!-- 复制全文 -->
      <button class="statusbar-btn" @click="copyFull" :title="store.locales==='zh' ? '复制全文' : 'Copy full text'">
        <i class="fa fa-copy"></i>
      </button>
      <!-- 导出（md / word） -->
      <span v-if="data.isMd || data.isWord" class="md-sb-export">
        <button class="statusbar-btn" :class="{ active: exportMenuOpen }" @click.stop="toggleExportMenu" :title="store.locales==='zh' ? '导出文档' : 'Export document'">
          <i class="fa fa-download"></i>
        </button>
        <div v-if="exportMenuOpen" class="md-sb-export-menu" @click.stop>
          <div class="md-sb-export-item" @click.stop="chooseExport('md')"><i class="fa fa-file-text-o"></i>{{ store.locales==='zh' ? '导出 Markdown' : 'Export Markdown' }}</div>
          <div class="md-sb-export-item" @click.stop="chooseExport('word')"><i class="fa fa-file-word-o"></i>{{ store.locales==='zh' ? '导出 Word' : 'Export Word' }}</div>
          <div class="md-sb-export-item" @click.stop="chooseExport('pdf')"><i class="fa fa-file-pdf-o"></i>{{ store.locales==='zh' ? '导出 PDF' : 'Export PDF' }}</div>
        </div>
      </span>
      <!-- 朗读 / 停止 -->
      <button class="statusbar-btn" :class="{ active: isSpeaking, 'sb-speaking': isSpeaking }" @click="speak" :title="isSpeaking ? (store.locales==='zh' ? '停止朗读' : 'Stop reading') : (store.locales==='zh' ? '朗读全文' : 'Read aloud')">
        <i :class="isSpeaking ? 'fa fa-stop' : 'fa fa-volume-up'"></i>
      </button>
      <!-- 阅读字号调节：A- / A+ -->
      <button class="statusbar-btn" @click="changeReadFont(-1)" :disabled="readFontSize <= READ_FONT_MIN" :title="store.locales==='zh' ? '减小字号 (A-)' : 'Decrease font size (A-)'">
        <span class="md-sb-font-label">A-</span>
      </button>
      <button class="statusbar-btn" @click="changeReadFont(1)" :disabled="readFontSize >= READ_FONT_MAX" :title="store.locales==='zh' ? '增大字号 (A+)' : 'Increase font size (A+)'">
        <span class="md-sb-font-label">A+</span>
      </button>

      <span class="statusbar-spacer"></span>
      <span class="statusbar-sep"></span>

      <!-- 状态显示（右下角） -->
      <!-- 文件外部变更提示（短暂显示） -->
      <span v-if="fileChangedTip" class="statusbar-item md-sb-changed" :title="store.locales==='zh' ? '文件已在外部更新，已自动刷新' : 'File changed externally, reloaded'">
        <i class="fa fa-refresh"></i>
        <span>{{ store.locales==='zh' ? '已更新' : 'Updated' }}</span>
      </span>

      <!-- 当前章节 -->
      <span v-if="toc.length > 0" class="statusbar-item md-sb-section" :title="currentSectionText || (store.locales==='zh' ? '当前章节' : 'Current section')">
        <i class="fa fa-header"></i>
        <span class="md-sb-section-text">{{ currentSectionText || (store.locales==='zh' ? '文档开头' : 'Top') }}</span>
      </span>

      <!-- 阅读进度（点击回到顶部） -->
      <span class="statusbar-item md-sb-progress" @click="scrollToTop" :title="store.locales==='zh' ? '阅读进度 · 点击回到顶部' : 'Reading progress · click to top'">
        <i class="fa fa-eye"></i>
        {{ readingProgress }}%
      </span>

      <!-- 字数统计 -->
      <span class="statusbar-item" :title="store.locales==='zh' ? ('约 ' + docStats.chars + ' 个字符（不含格式）') : (docStats.chars + ' chars (excl. markup)')">
        <i class="fa fa-file-text-o"></i>
        {{ docWordsLabel }}
      </span>

      <!-- 智能操作：与当前文档对话（仅图标，与 PdfViewer 状态栏同款） -->
      <button class="statusbar-btn" :class="{ active: chatOpen }" @click="toggleChat" :title="store.locales==='zh' ? '智能操作：与当前文档智能对话' : 'Smart: chat about this document'">
        <i class="fa fa-magic"></i>
      </button>
    </div>
  </div>

  <!-- Mermaid 图查看（放大/平移/导出，复用共享组件） -->
  <MermaidViewer ref="mermaidViewerRef" />

  <!-- 导出为 Word：另存为对话框（导出样式 + 保存位置，默认当前文件目录） -->
  <WordExportDialog v-model="wordExportVisible" :markdown="wordExportMarkdown" :title="wordExportTitle"
                    :default-dir="wordExportDir" :base-dir="wordExportDir" :strip-frontmatter="!data.isWord" />

  <!-- 编辑标签 已移入左侧栏 -->
</template>

<style scoped>
  .md{
    width:100%;
    height: 100%;
    position:relative;
    margin: 0px;
    display: flex;
    flex:1;
  }
  .iftoc:hover{
    opacity: 1;
  }
  ul{
    list-style: none;
    margin: 0px;
    padding:5px;
    padding-top:5px;
    margin-block-end:0px;
  }
  li{
    color:var(--fontColor);
    clear:both;
    height:24px;
    cursor:pointer;
    line-height:28px;
    position: relative;
    white-space:nowrap;
  }
  td{
    padding: 0px;
    text-align: center;
  }
  li:hover{
    color: var(--fontActiveColor);
  }
  li:hover .del{
    display: inline-block;
    text-shadow: 1px 1px 2px black;
  }

  .content{
    flex: 1;
    min-width: 0;
    height:calc(100% - 24px);
    color:var(--fontColor);
    padding: 0px;
    position: relative;
  }
  /* 无底部状态栏的类型（图片/音视频/PDF/白板/HTML 等）填满整高，避免底部 24px 空白 */
  .content.content-full{
    height: 100%;
  }

  /* 底部状态栏（样式与 PdfViewer / Edit_Code 一致） */
  .md-statusbar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 24px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 8px;
    font-size: 12px;
    color: var(--fontColor);
    background-color: var(--menuColor);
    border-top: 1px solid var(--borderColor);
    box-sizing: border-box;
    user-select: none;
    white-space: nowrap;
    z-index: 60;
  }
  .md-statusbar .statusbar-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    opacity: 0.85;
    flex-shrink: 1;
  }
  .md-statusbar .statusbar-item i {
    font-size: 11px;
    opacity: 0.7;
  }
  .md-statusbar .statusbar-spacer {
    flex: 1;
  }
  .md-statusbar .statusbar-sep {
    width: 1px;
    height: 14px;
    background: var(--borderColor);
    margin: 0 4px;
    opacity: 0.6;
    flex-shrink: 0;
  }
  /* 覆盖全局 button{width:100%}，避免状态栏按钮被撑满整行 */
  .md-statusbar button {
    width: auto;
  }
  .md-statusbar .statusbar-btn {
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
    gap: 3px;
    cursor: pointer;
    opacity: 0.85;
    transition: background-color 0.15s;
    flex-shrink: 0;
  }
  .md-statusbar .statusbar-btn:hover {
    background-color: var(--menuActiveColor);
    opacity: 1;
  }
  .md-statusbar .statusbar-btn.active {
    color: var(--fontActiveColor);
    opacity: 1;
  }
  .md-statusbar .statusbar-btn:disabled {
    opacity: 0.35;
    cursor: default;
    pointer-events: none;
  }
  .md-statusbar .statusbar-btn:disabled:hover {
    background-color: transparent;
  }
  /* 字号加减按钮文本（A- / A+） */
  .md-statusbar .md-sb-font-label {
    font-weight: 600;
    font-size: 12px;
    letter-spacing: -0.5px;
  }
  .md-statusbar .statusbar-btn.sb-speaking i {
    color: #f56c6c;
    animation: md-sb-pulse 0.9s ease-in-out infinite alternate;
  }
  @keyframes md-sb-pulse {
    from { opacity: 0.5; }
    to { opacity: 1; }
  }
  /* 文件外部变更提示 */
  .md-statusbar .md-sb-changed {
    color: #e6a23c;
    opacity: 1;
  }
  .md-statusbar .md-sb-changed i {
    opacity: 1;
    animation: md-sb-pulse 0.8s ease-in-out infinite alternate;
  }
  /* 当前章节文字（超长省略，可收缩） */
  .md-statusbar .md-sb-section {
    min-width: 0;
    overflow: hidden;
  }
  .md-statusbar .md-sb-section-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .md-statusbar .md-sb-progress {
    cursor: pointer;
    min-width: 46px;
    justify-content: center;
  }
  .md-statusbar .md-sb-progress:hover {
    background-color: var(--menuActiveColor);
    border-radius: 3px;
  }
  /* 导出下拉菜单 */
  .md-statusbar .md-sb-export {
    position: relative;
    display: inline-flex;
  }
  .md-statusbar .md-sb-export-menu {
    position: absolute;
    left: 0;
    bottom: calc(100% + 2px);
    min-width: 160px;
    background: var(--menuColor);
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    padding: 4px;
    z-index: 200;
    display: flex;
    flex-direction: column;
  }
  .md-statusbar .md-sb-export-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    color: var(--fontColor);
    white-space: nowrap;
  }
  .md-statusbar .md-sb-export-item:hover {
    background-color: var(--menuActiveColor);
    color: var(--fontActiveColor);
  }
  .md-statusbar .md-sb-export-item i {
    font-size: 12px;
    opacity: 0.8;
  }
  /* ===== 右侧「智能操作」文档对话面板 ===== */
  .md-chat-panel{
    flex: 0 0 auto;
    height: calc(100% - 24px);
    /* 窗口较窄时限制面板占比，避免把正文挤成 0 宽（超出才横向溢出） */
    max-width: 60%;
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border-left: 1px solid var(--borderColor);
    background: var(--backgroundColor);
    box-sizing: border-box;
  }
  /* 无底部状态栏时填满整高（避免底部 24px 空白） */
  .md-chat-panel.full{
    height: 100%;
  }
  .md-chat-resizer{
    position: absolute;
    top: 0;
    left: 0;
    width: 5px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
    user-select: none;
  }
  .md-chat-resizer:hover{
    background: rgba(128,128,128,0.15);
  }
  .Columns{
    position: relative;
    height: 100%;
    display: flex;
    flex-wrap:nowrap;
    flex-direction:row
  }  .Column{
    width: calc(100% - 2px);
    height:calc(100%);
    position: relative;
    display: inline-block;
    border-right:1px solid var(--borderColor);
    overflow-y: auto;
    overflow-x: hidden;
  }
  .Column::-webkit-scrollbar {
    display: none;
  }
  .prep{
    position: absolute;
    float: left;
    width:calc(100% - 2px);
    height:calc(100% - 2px);
    color:var(--fontColor);
    overflow-y: auto;
    overflow-x: hidden;
    padding: 10px;
    font-size: var(--md-read-font, 16px);
    box-sizing: border-box;
  }

  /* HTML 文件预览（iframe 渲染） */
  .html-preview{
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .html-frame{
    width: 100%;
    height: 100%;
    border: none;
    background: #fff;
  }

  .prep :deep(img) {
    max-width: 100%;
    max-height: min(70vh, 600px);
    height: auto;
    display: block;
    margin: 0 auto;
    object-fit: contain;
  }

  .prep :deep(.md-image-figure) {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 16px 0;
  }

  .prep :deep(.md-image-caption) {
    margin-top: 6px;
    font-size: 14px;
    color: var(--fontColor);
    opacity: 0.7;
    text-align: center;
    font-style: italic;
  }

  .mermaid svg {
    display: block;
    width: 100%;
    height: auto;
    max-width: 100%;
    max-height: min(70vh, 100%);
    object-fit: contain;
    overflow: hidden;
  }
  .nav{
    width:300px;
    min-width:180px;
    max-width:560px;
    height:calc(100% - 24px);
    position: relative;
    border-right:1px solid var(--borderColor);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--backgroundColor);
  }
  .nav::-webkit-scrollbar {
    display: none;
  }
  .toc-resizer{
    position: absolute;
    top: 0;
    right: 0;
    width: 5px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
    user-select: none;
  }
  .toc-resizer:hover{
    background: rgba(128,128,128,0.15);
  }
  /* 左侧栏面板通用结构 */
  .left-body{
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .left-panel-head{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--borderColor);
    flex-shrink: 0;
    font-size: 13px;
    color: var(--fontColor);
  }
  .left-panel-title{
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .left-panel-title i{
    font-size: 12px;
    opacity: 0.8;
  }
  .left-panel-close{
    width: auto;
    padding: 0 6px;
    background: none;
    border: none;
    color: var(--fontColor);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    flex-shrink: 0;
  }
  .left-panel-close:hover{
    color: #e74c3c;
  }
  .left-head-tools{
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .md-search-head .left-panel-title{
    flex: 1;
    min-width: 0;
  }
  .left-scroll{
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .left-panel-actions{
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-top: 1px solid var(--borderColor);
    flex-shrink: 0;
  }
  .info{
    padding:5px;
    width:calc(100% - 10px);
    border-bottom: 1px solid var(--borderColor);
    height: fit-content;
    max-height: 200px;
    overflow-y: auto;
  }
  .info table tr td{
    white-space: nowrap;
    overflow: none;
    width:calc(100%);
    max-width: 90px;
    text-overflow: ellipsis;
    font-size: 12px;
    padding: 0px;
    height:20px
  }
  .toc{
    overflow: hidden;
    overflow-y: auto;
  }
  .toc-tree{
    list-style: none;
    margin: 0;
    padding: 4px 0;
    font-size: 13px;
  }
  .toc-tree-item{
    display: flex;
    align-items: center;
    height: 28px;
    line-height: 28px;
    padding-right: 8px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    position: relative;
    transition: background-color 0.15s;
  }
  .toc-tree-item:hover{
    background-color: var(--menuColor);
    color: var(--fontActiveColor);
  }
  .toc-tree-item:hover .toc-link{
    color: var(--fontActiveColor);
  }
  /* 祖先层级竖线：绝对定位（不占布局宽度，层级缩进完全由 li 的 paddingLeft 决定） */
  .toc-line{
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 1px solid var(--borderColor);
    pointer-events: none;
  }
  .toc-line-blank{
    border-left-color: transparent;
  }
  .toc-connector{
    display: inline-block;
    width: 18px;
    height: 100%;
    flex-shrink: 0;
    position: relative;
  }
  .toc-connector::before{
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 18px;
    height: 50%;
    border-bottom: 1px solid var(--borderColor);
    border-left: 1px solid var(--borderColor);
  }
  .toc-connector-last::after{
    content: '';
    position: absolute;
    top: 50%;
    left: 0;
    width: 18px;
    height: 50%;
    border-left: 0;
  }
  .toc-connector-mid::after{
    content: '';
    position: absolute;
    top: 50%;
    left: 0;
    width: 18px;
    height: 50%;
    border-left: 1px solid var(--borderColor);
  }
  .toc-link{
    display: inline-block;
    color: var(--fontColor);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 4px;
    flex: 1;
    min-width: 0;
  }
  .toc-link:hover{
    color: var(--fontActiveColor);
  }
  .toc-link.active{
    color: var(--fontActiveColor);
    font-weight: 600;
  }
  .toc-tree-item.active{
    background-color: var(--menuColor);
  }
  .toc-depth-0{
    font-weight: 600;
  }
  /* 全文搜索条（位于左侧栏内） */
  .md-search-bar{
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--borderColor);
    flex-shrink: 0;
  }
  .md-search-tip{
    padding: 8px;
    font-size: 12px;
    color: var(--fontColor);
    opacity: 0.6;
    line-height: 1.6;
  }
  .md-search-input{
    flex: 1;
    min-width: 0;
    width: auto;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--borderColor);
    border-radius: 4px;
    background: var(--inputColor);
    color: var(--fontColor);
    font-size: 13px;
    outline: none;
    margin: 0;
  }
  .md-search-count{
    font-size: 11px;
    color: var(--fontColor);
    opacity: 0.8;
    min-width: 36px;
    text-align: center;
    flex-shrink: 0;
  }
  .md-search-btn{
    margin: 0;
    padding: 2px 6px;
    border: none;
    background: transparent;
    color: var(--fontColor);
    font-size: 13px;
    cursor: pointer;
    border-radius: 3px;
    opacity: 0.8;
  }
  .md-search-btn:hover:not(:disabled){
    background: var(--menuActiveColor);
    opacity: 1;
  }
  .md-search-btn:disabled{
    opacity: 0.35;
    cursor: default;
  }
  /* 搜索结果列表 */
  .md-search-list{
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 6px;
  }
  .md-search-item{
    padding: 6px 8px;
    margin-bottom: 6px;
    border: 1px solid var(--borderColor);
    border-radius: 6px;
    background: var(--backgroundColor);
    font-size: 12px;
    line-height: 1.6;
    color: var(--fontColor);
    cursor: pointer;
    word-break: break-all;
  }
  .md-search-item:hover{
    background: var(--menuColor);
  }
  .md-search-item.current{
    border-color: var(--fontActiveColor);
    background: var(--menuColor);
  }
  /* 搜索高亮 */
  .prep :deep(mark.search-mark){
    background: rgba(255, 213, 0, 0.45);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  .prep :deep(mark.search-mark.search-current){
    background: #ff9632;
    color: #000;
  }
  .img{
    text-align: center;
    width:100%;
    height: 100%;
  }
  .img img{
    display: table-cell;
    width: 100%;
    height: 100%;
    object-fit:contain;
    z-index:-100;
  }
  button{
    width: 100%;
  }
  input{
    border-color: 1px solid var(--borderColor);
    margin: 0px
  }
  .meta-editor-body{
    padding: 5px;
    max-height: 40vh;
    overflow-y: auto;
  }
  .meta-editor-empty{
    color: var(--borderColor);
    margin-bottom: 8px;
    font-size: 13px;
  }
  .meta-editor-row{
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .meta-editor-key{
    width: 20%;
    min-width: 80px;
    border: 1px solid var(--borderColor);
    background: var(--backgroundColor);
    color: var(--fontColor);
    padding: 4px 6px;
    border-radius: 3px;
    font-size: 13px;
  }
  .meta-editor-value{
    flex: 1;
    border: 1px solid var(--borderColor);
    background: var(--backgroundColor);
    color: var(--fontColor);
    padding: 4px 6px;
    border-radius: 3px;
    font-size: 13px;
    margin:0px
  }
  .meta-editor-del{
    width: auto;
    padding: 2px 8px;
    background: none;
    border: none;
    color: var(--fontColor);
    cursor: pointer;
    font-size: 14px;
  }
  .meta-editor-del:hover{
    color: #e74c3c;
  }
  .meta-scroll{
    padding: 8px;
  }
  .meta-card-top{
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .meta-card-key{
    flex: 1;
    min-width: 0;
    border: 1px solid var(--borderColor);
    background: var(--backgroundColor);
    color: var(--fontColor);
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 13px;
    margin: 0;
  }
  .meta-card-del{
    width: auto;
    padding: 0 6px;
    background: none;
    border: none;
    color: var(--fontColor);
    cursor: pointer;
    font-size: 13px;
    flex-shrink: 0;
  }
  .meta-card-del:hover{
    color: #e74c3c;
  }
  .meta-card-value{
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--borderColor);
    background: var(--backgroundColor);
    color: var(--fontColor);
    padding: 5px;
    border-radius: 4px;
    font-size: 13px;
    resize: vertical;
    font-family: inherit;
    line-height: 1.5;
    margin: 0;
  }
  .meta-editor-actions{
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 5px;
  }
  .meta-editor-spacer{
    flex: 1;
  }
  .meta-editor-btn{
    width: auto;
    padding: 5px;
    border: 1px solid var(--borderColor);
    border-radius: 3px;
    background: var(--backgroundColor);
    color: var(--fontColor);
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
  }
  .meta-editor-btn:hover{
    opacity: 0.85;
  }
  .meta-editor-btn-primary{
    background: var(--menuColor);
    font-weight: 600;
  }

  /* 右键菜单样式统一在 explorer.vue 中定义 */
  .context-menu {
    min-width: 160px;
  }
  .active{
    background-color: var(--menuColor);
  }
  .loading{
    background-color: var(--backgroundColor);
    padding:5px;
    border: 1px solid var(--borderColor);
  }
  hr{
    background-color:var(--fontColor);
  }
  .nodata{
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100%;
    user-select: none;
    overflow: hidden;
  }
  .nodata .panel {
    height:fit-content;
    width:150px;
    font-size: 16px;
    text-align: center;
  }
  .nodata button {
    height:35px;
    border-radius: 5px;
    width:150px;
    margin: 5px;
    background-color: var(--menuColor);
    border: 1px solid var(--borderColor);
    font-size: 16px;
  }
  .loading-state, .error-state {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100%;
    gap: 15px;
    color: var(--fontColor);
  }
  .loading-state i {
    font-size: 30px;
    margin-bottom: 10px;
  }
  .error-state i {
    font-size: 40px;
    color: #ff6b6b;
    margin-bottom: 10px;
  }
  .retry-btn {
    width: auto;
    padding: 8px 16px;
    margin-top: 10px;
    cursor: pointer;
  }
  .retry-btn i {
    font-size: 14px;
    margin-right: 5px;
  }
  input{
    border-radius: 5px;
    margin: 2px;
    border: 1px solid var(--borderColor);
  }

  /* Mermaid 包装器 */
  :deep(.mermaid-wrapper) {
    margin: 8px 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    background-color: rgba(255, 255, 255, 0.03);
    overflow: hidden;
  }
  :deep(.mermaid-rendered-svg) {
    overflow-x: auto;
    padding: 8px;
    cursor: pointer;
    transition: border-color 0.2s ease;
  }
  :deep(.mermaid-rendered-svg:hover) {
    border-color: rgba(52, 152, 219, 0.4);
  }
  :deep(.mermaid-rendered-svg svg) {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0 auto;
  }
  :deep(.mermaid-fallback) {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 11px;
    line-height: 1.4;
    color: var(--fontColor);
    padding: 8px;
  }
  :deep(.mermaid-clickable) {
    position: relative;
  }
  :deep(.mermaid-clickable::after) {
    font-family: 'FontAwesome';
    content: '\f002';
    position: absolute;
    top: 4px;
    right: 4px;
    font-size: 14px;
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  :deep(.mermaid-clickable:hover::after) {
    opacity: 0.7;
  }

  /* PDF 预览样式 */
</style>

<style>
/* 搜索结果摘要高亮（v-html 注入，需非 scoped） */
.md-res-hl{
  background: rgba(255, 213, 0, 0.45);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

/* ===== Python 代码块运行按钮 ===== */
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