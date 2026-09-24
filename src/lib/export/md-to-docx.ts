/**
 * Markdown → Word (.docx) 统一导出管线
 *
 * 将三处导出入口（md_read.vue 文件阅读 / home.vue 聊天导出 / SwarmRunPanel 输出导出）
 * 收敛为同一函数 exportMarkdownAsWord：
 *   1. （可选）去除 YAML frontmatter
 *   2. 导出专用 markdown-it 渲染（数学公式 / 删除线 / 带 alt 图片标题）
 *   3. mermaid 源码块 → PNG 图片内嵌
 *   4. 本地图片内联为 base64 data URL
 *   5. （可选）套用用户指定的 .docx 段落样式皮肤（仅 styles.xml / theme1.xml）
 *   6. 构建并下载 .docx
 *
 * 皮肤文件来自设置页「Word 导出」中选择的 .docx；未选或读取失败则用内置默认样式。
 */
import MarkdownIt from 'markdown-it'
import mathjax3 from 'markdown-it-mathjax3'
import mark from 'markdown-it-mark'
import { ElMessage } from 'element-plus'
import { renderMermaidSvgForExport, svgToPngDataUrl } from '@/lib/markdown/mermaid'
import { normalizeMermaidSource } from '@/lib/markdown/mermaid-normalize'
import { allowLocalFileLinks } from '@/lib/markdown/mdLinkPolicy'
import { inlineLocalImagesAsDataUrls, downloadAsWord, blobToBase64, type WordSaveResult } from '@/lib/export/download'
import { type DocxSkin, type DocxPageProfile, getDocxTemplatePreset } from '@/lib/export/docx'
import { usestore } from '@/store'

export interface MarkdownToWordOptions {
  /** 导出文件名（不含扩展名） */
  title?: string
  /** markdown 源文件所在目录（以 / 结尾），用于解析相对图片路径的兜底基目录 */
  baseDir?: string
  /** 是否去除开头的 YAML frontmatter（默认 false） */
  stripFrontmatter?: boolean
  /** 导出模板 key：gongwen/cn/en/custom；缺省读全局配置 store.UI.wordExportTemplate（默认公文） */
  template?: string
  /** 段落样式 .docx 路径（仅 custom 模板用）；省略时读全局配置 store.UI.wordExportStylePath */
  stylePath?: string
  /** 保存目标路径（绝对路径，如“Markdown 所在目录/标题.docx”）；只给文件名则落系统下载目录 */
  targetPath?: string
  /** 允许覆盖同名文件（路径已由用户通过「另存为」确认时传 true；默认重名自动加 (1)） */
  overwrite?: boolean
}

// ===== 导出专用 markdown-it（与预览解耦，不含 toc/搜索等 UI 增强） =====
const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
}).use(mathjax3 as any)
  .use(mark as any)

// 放开 file: 链接：Word 预览图片以 file:/// 引用缓存文件，
// 默认策略会拒绝该协议 → 图片语法不成立，导出时图片会整张丢失
allowLocalFileLinks(md)

// 图片规则：带 alt 的图包一层 figure + figcaption，便于 Word 导出居中并带图注
const defaultImageRender = md.renderer.rules.image || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const imgHtml = defaultImageRender(tokens, idx, options, env, self)
  const altText = token.content ? md.utils.escapeHtml(token.content.trim()) : ''
  if (altText) {
    return `<figure class="md-image-figure">${imgHtml}<figcaption>${altText}</figcaption></figure>`
  }
  return imgHtml
}

// fence 规则：mermaid 代码块转成 wrapper（源码存 .mermaid-src），供 renderMermaidToImages 换成 PNG
const defaultFence = md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim() : ''
  const langName = info ? info.split(/\s+/g)[0] : ''
  if (langName === 'mermaid') {
    const content = token.content.trim()
    const escaped = md.utils.escapeHtml(content)
    return `<div class="mermaid-wrapper"><div class="mermaid-src" style="display:none">${escaped}</div></div>`
  }
  return defaultFence(tokens, idx, options, env, self)
}

// ===== YAML frontmatter =====
function stripFrontmatter(content: string): string {
  if (!content || typeof content !== 'string') return content
  const fmRegex = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/
  if (fmRegex.test(content)) {
    return content.replace(fmRegex, '').replace(/^\s+/, '')
  }
  return content
}

/** 读取最近持久化的界面配置（localStorage 'UI'），供导出时跨窗口即时取到最新设置 */
function readLatestUiSettings(): any {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem('UI')
    if (!raw) return {}
    const u = JSON.parse(raw)
    return u && typeof u === 'object' ? u : {}
  } catch {
    return {}
  }
}

// ===== LaTeX 预处理（复用 md_read 的逻辑，统一 \(..\) → $..$、\[..\] → $$..$$） =====
function preprocessMath(str: string): string {
  if (!str) return str
  const blocks: string[] = []
  let result = str.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m)
    return `\x00BLOCK${blocks.length - 1}\x00`
  })
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, '$$\n$1\n$$')
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => {
    return '$' + (inner as string).trim() + '$'
  })
  result = result.replace(/(?<!\$)\$([\s\S]*?)\$(?!\$)/g, (raw, inner) => {
    const trimmed = (inner as string).trim()
    if (!trimmed) return raw
    if (!/[\\_{}^]/.test(trimmed)) return raw
    return '\x00MATH\x00' + trimmed + '\x00/MATH\x00'
  })
  result = result.replace(/\x00\/MATH\x00(?=\d)/g, '\x00/MATH\x00\u200B')
  result = result.replace(/\x00MATH\x00/g, '$').replace(/\x00\/MATH\x00/g, '$')
  result = result.replace(/\x00BLOCK(\d+)\x00/g, (_, idx) => blocks[+idx])
  return result
}

// ===== CJK 紧邻加粗（**…**）修复 =====
// markdown-it（CommonMark）的加粗邻接判定按“西文空格/标点”设计：当 `**` 紧贴中文字/全角标点时
// （如 “…（RAG）**属于”“是**加粗**”），不会被解析成 <strong>，而是原样输出字面星号。
// 修复：渲染前在 CJK 与 `**` 相邻处临时补一个 ASCII 空格让 markdown-it 正确配对；
// 渲染后再把“紧邻 <strong>/</strong> 且外侧为中文字符”的空格移除，避免中文排版出现空隙。
// 代码块（fence）与行内代码（反引号）保持原样，不受影响。
const CJK_NEAR_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uff60\uf900-\ufaff\uac00-\ud7af\u3040-\u30ff]/
const isCjkNear = (ch?: string): boolean => !!ch && CJK_NEAR_RE.test(ch)

function padCjkStrong(markdown: string): string {
  if (!markdown || !markdown.includes('**')) return markdown
  const lines = markdown.split('\n')
  let inFence = false
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line }
    if (inFence) return line
    return padCjkStrongLine(line)
  }).join('\n')
}

function padCjkStrongLine(line: string): string {
  let out = ''
  let i = 0
  const n = line.length
  let expectClose = false
  while (i < n) {
    const ch = line[i]
    if (ch === '`') { // 行内代码整段跳过
      let j = i
      while (j < n && line[j] === '`') j++
      const run = line.slice(i, j)
      const close = line.indexOf(run, j)
      if (close >= 0) { out += line.slice(i, close + run.length); i = close + run.length; continue }
      out += run
      i = j
      continue
    }
    if (ch === '\\' && i + 1 < n && (line[i + 1] === '*' || line[i + 1] === '_')) {
      out += ch + line[i + 1]
      i += 2
      continue
    }
    if (line.startsWith('**', i)) {
      if (!expectClose) {
        // 开标记：若前邻是中文，则在前面补空格，避免无法“开 emphasis”
        const prev = i > 0 ? line[i - 1] : ''
        out += (prev && !/\s/.test(prev) && isCjkNear(prev)) ? ' **' : '**'
        expectClose = true
      } else {
        // 闭标记：若后邻是中文，则在后面补空格，避免无法“关 emphasis”
        const next = i + 2 < n ? line[i + 2] : ''
        out += '**'
        if (next && !/\s/.test(next) && isCjkNear(next)) out += ' '
        expectClose = false
      }
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 渲染后移除 CJK 加粗临时补的空格（紧邻 <strong> 且外侧为中文/全角字符） */
function stripCjkStrongPad(html: string): string {
  if (!html || !html.includes('<strong>')) return html
  return html
    .replace(/([\u2e80-\u9fff\u3000-\u303f\uff00-\uff60\uf900-\ufaff\uac00-\ud7af\u3040-\u30ff]) +(?=<strong>)/g, '$1')
    .replace(/(<\/strong>) +([\u2e80-\u9fff\u3000-\u303f\uff00-\uff60\uf900-\ufaff\uac00-\ud7af\u3040-\u30ff])/g, '$1$2')
}

// ===== Mermaid 源码规范化：实现已归口到 ./mermaid-normalize（顶部 import），此处不再重复 =====

// mermaid 源码块 → PNG 图片（Word 无法解析 mermaid，需转图内嵌）
async function renderMermaidToImages(html: string): Promise<string> {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }
  const wrappers = Array.from(doc.querySelectorAll<HTMLElement>('.mermaid-wrapper'))
  if (!wrappers.length) return html
  await Promise.all(wrappers.map(async (wrapper) => {
    const srcEl = wrapper.querySelector<HTMLElement>('.mermaid-src')
    const rawText = srcEl?.textContent?.trim()
    if (!rawText) return
    try {
      const normalizedText = normalizeMermaidSource(rawText)
      const svgString = await renderMermaidSvgForExport(normalizedText)
      const pngDataUrl = await svgToPngDataUrl(svgString)
      const img = doc.createElement('img')
      img.src = pngDataUrl
      img.alt = ''
      img.style.cssText = 'max-width:100%;height:auto;'
      wrapper.replaceWith(img)
    } catch (e) {
      console.warn('[export] mermaid 渲染失败:', e)
    }
  }))
  return doc.body ? doc.body.innerHTML : html
}

// ===== 皮肤读取：从 .docx（zip）解析出 styles.xml / theme1.xml =====

interface ZipEntry { name: string; method: number; compSize: number; localOffset: number }

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 扫描 ZIP 中央目录，返回目标条目（仅关心 styles / theme） */
function scanZipEntries(bytes: Uint8Array, targets: Set<string>): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: ZipEntry[] = []
  // 从尾部找 EOCD（PK\x05\x06）
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return out
  const cdSize = dv.getUint32(eocd + 12, true)
  const cdOffset = dv.getUint32(eocd + 16, true)
  const decoder = new TextDecoder('utf-8')
  let pos = cdOffset
  const end = cdOffset + cdSize
  while (pos + 46 <= end) {
    if (dv.getUint32(pos, true) !== 0x02014b50) { pos++; continue }
    const method = dv.getUint16(pos + 10, true)
    const compSize = dv.getUint32(pos + 20, true)
    const nameLen = dv.getUint16(pos + 28, true)
    const extraLen = dv.getUint16(pos + 30, true)
    const commentLen = dv.getUint16(pos + 32, true)
    const localOffset = dv.getUint32(pos + 42, true)
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    if (targets.has(name)) {
      out.push({ name, method, compSize, localOffset })
    }
    pos += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 解压单个条目数据（method 0 存储 / method 8 deflate-raw） */
async function inflateEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const nameLen = dv.getUint16(entry.localOffset + 26, true)
  const extraLen = dv.getUint16(entry.localOffset + 28, true)
  const dataStart = entry.localOffset + 30 + nameLen + extraLen
  const comp = bytes.subarray(dataStart, dataStart + entry.compSize)
  if (entry.method === 0) return comp
  if (entry.method === 8) {
    const DS = (globalThis as any).DecompressionStream
    if (typeof DS !== 'undefined') {
      try {
        const cs = new DS('deflate-raw')
        const writer = cs.writable.getWriter()
        writer.write(comp)
        writer.close()
        const buf = await new Response(cs.readable).arrayBuffer()
        return new Uint8Array(buf)
      } catch { /* fallthrough */ }
    }
  }
  return comp
}

/** 从本地 .docx 读取段落样式皮肤；失败返回 undefined（调用方自动回退默认样式） */
export async function readDocxStyleSkin(path: string): Promise<DocxSkin | undefined> {
  try {
    const dataUrl = await (window as any).ipcRenderer.invoke('readFileBase64', path)
    if (typeof dataUrl !== 'string') return undefined
    const m = /;base64,(.+)$/s.exec(dataUrl)
    if (!m) return undefined
    const bytes = base64ToUint8(m[1])
    const entries = scanZipEntries(bytes, new Set(['word/styles.xml', 'word/theme/theme1.xml']))
    const skin: DocxSkin = {}
    for (const entry of entries) {
      const raw = await inflateEntry(bytes, entry)
      const xml = new TextDecoder('utf-8').decode(raw)
      if (entry.name === 'word/styles.xml') skin.stylesXml = xml
      else if (entry.name === 'word/theme/theme1.xml') skin.themeXml = xml
    }
    if (!skin.stylesXml) {
      console.warn('[export] 样式文件未包含 word/styles.xml，回退默认样式:', path)
      return undefined
    }
    return skin
  } catch (e) {
    console.warn('[export] 读取样式文件失败，回退默认样式:', path, e)
    return undefined
  }
}

// ===== 统一导出入口 =====

/** 已就绪的 Word 导出素材（供下载 / 工作流「Word 导出节点」复用） */
export interface PreparedDocxHtml {
  /** 已渲染 HTML：公式已转 OMML/图片、mermaid 已转 PNG、本地图片已内联 base64 */
  html: string
  /** 样式皮肤（自定义模板读取失败时 undefined → 用内置默认样式） */
  skin?: DocxSkin
  /** 页面版式（随模板） */
  page: DocxPageProfile
  /** 实际生效的模板 key（gongwen/cn/en/custom） */
  templateKey: string
}

/**
 * 把 Markdown 渲染成可构建 .docx 的 HTML，并解析导出模板与样式皮肤。
 * 步骤：frontmatter(可选) → markdown-it 渲染（数学/删除线/图片图注）→ mermaid 转 PNG →
 * 本地图片内联 base64 → 模板预设（opts.template 优先，其次设置页，最后公文）。
 * 供 exportMarkdownAsWord（下载）与工作流「Word 导出节点」（写指定路径）共用。
 */
export async function prepareMarkdownDocxHtml(markdown: string, opts: MarkdownToWordOptions = {}): Promise<PreparedDocxHtml | null> {
  const mdContent = markdown || ''
  if (!mdContent) return null

  // 1. frontmatter（可选）
  const stripped = opts.stripFrontmatter ? stripFrontmatter(mdContent) : mdContent
  // 2. 渲染 HTML（含数学公式 / 带 alt 图片标题）；先修 CJK 紧邻加粗，渲染后回删补的空格
  const rendered = stripCjkStrongPad(md.render(padCjkStrong(preprocessMath(stripped))))
  // 3. mermaid → PNG
  const withMermaid = await renderMermaidToImages(rendered)
  // 4. 本地图片内联 base64
  const html = await inlineLocalImagesAsDataUrls(withMermaid, opts.baseDir)
  // 5. 模板与样式：读最近持久化 UI（localStorage 优先，跨窗口即时反映设置变更），再回退内存 store
  const latestUi = (typeof window !== 'undefined') ? readLatestUiSettings() : {}
  let template = opts.template || latestUi.wordExportTemplate || ''
  if (!template && typeof window !== 'undefined') {
    try { template = usestore().UI.wordExportTemplate || '' } catch { template = '' }
  }
  const preset = getDocxTemplatePreset(template || 'gongwen')
  let skin: DocxSkin | undefined
  if (preset.key === 'custom') {
    // 自定义模板：导入外部 .docx 用其段落样式；未选/读取失败则退回公文默认样式
    let stylePath = opts.stylePath || latestUi.wordExportStylePath || ''
    if (!stylePath && typeof window !== 'undefined') {
      try { stylePath = usestore().UI.wordExportStylePath || '' } catch { stylePath = '' }
    }
    if (stylePath) skin = await readDocxStyleSkin(stylePath)
  } else if (preset.stylesXml) {
    skin = { stylesXml: preset.stylesXml }
  }
  return { html, skin, page: preset.page, templateKey: preset.key }
}

/**
 * 把已构建的 .docx Blob 写到指定路径（Electron 主进程 exportDocx IPC）。
 * targetPath 非绝对路径（只有文件名）时主进程落系统下载目录；
 * overwrite=false（默认）时重名自动追加 (1)，避免静默覆盖。
 */
export async function saveDocxBlob(blob: Blob, targetPath: string, overwrite = false): Promise<{ ok: boolean; path?: string; error?: string }> {
  const ipc: any = (typeof window !== 'undefined') ? (window as any).ipcRenderer : null
  if (!ipc || typeof ipc.invoke !== 'function') return { ok: false, error: 'not-electron' }
  try {
    return await ipc.invoke('exportDocx', { base64: await blobToBase64(blob), targetPath, overwrite })
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// ===== 统一导出入口 =====
export async function exportMarkdownAsWord(markdown: string, opts: MarkdownToWordOptions = {}): Promise<WordSaveResult | undefined> {
  // 1-5：渲染 HTML + 解析模板/皮肤（与工作流 Word 导出节点共用）
  const prep = await prepareMarkdownDocxHtml(markdown, opts)
  if (!prep) return undefined
  // 6. 下载 + 结果反馈（导出耗时较长，成功/失败都要给出明确提示）
  const title = opts.title || '文档'
  const en = isEnglishUi()
  try {
    const saved = await downloadAsWord(prep.html, title, prep.skin, prep.page, {
      targetPath: opts.targetPath,
      overwrite: opts.overwrite,
    })
    // 主进程静默落盘（不弹框），把实际保存路径一并告知；拿不到路径就只报文件名
    ElMessage({
      type: 'success',
      message: saved.path
        ? (en ? `Word document saved: ${saved.path}` : `Word 文档已保存：${saved.path}`)
        : (en ? `Word document exported: ${saved.name}` : `Word 文档导出成功：${saved.name}`),
      duration: 4000,
      showClose: true,
    })
    return saved
  } catch (e) {
    console.error('[export] Word 导出失败:', e)
    ElMessage.error(en ? 'Word export failed, please retry' : 'Word 导出失败，请重试')
    throw e
  }
}

/** 当前界面语言是否为英文（取不到 store 时按中文处理） */
function isEnglishUi(): boolean {
  try {
    return usestore().locales === 'en'
  } catch {
    return false
  }
}
