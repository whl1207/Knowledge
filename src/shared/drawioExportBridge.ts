/**
 * drawio 内嵌编辑器的「导出 / 另存为」桥接（宿主侧）
 *
 * 背景（本机 Electron 30.5.1 实测）：
 *  - drawio 内嵌模式里，「文件 → 导出为 → 下载 / 设备」走两条内部路径：
 *      ① EditorUi.prototype.doSaveLocalFile() → 造 <a download href="blob:…"> 点一下，交给浏览器下载
 *      ② window.showSaveFilePicker()          → File System Access API（「设备」保存 / 另存为到设备）
 *  - 在本应用里这两条路都表现为「点了没反应」：
 *      ① Electron 默认把下载静默写进系统下载目录（不弹框、不提示，用户以为没发生）
 *      ② Electron 只提供了 showSaveFilePicker 的 API 外壳、没接原生选择框 → Promise **永不 settle**（挂死）
 *
 * 解决：把这两条路径都接到宿主（渲染层 → 主进程原生保存对话框）：
 *      doSaveLocalFile  → host.save()  弹「另存为」并写盘（文本或 base64 二进制）
 *      showSaveFilePicker → host.pick() 拿路径 + createWritable() → host.write()
 * 另外主进程还有 will-download 兜底（万一某条路径仍走了浏览器下载，也不会静默丢文件）。
 *
 * 该模块只依赖注入的 host，便于单测 / 浏览器探针复用。
 */

export interface DrawioExportPayload {
  filename: string
  mime: string
  isBase64: boolean
  data: string
}

/** 一页 PDF：svg 为内容；width/height 是 drawio 纸张尺寸（有则按纸张排版，无则按内容裁剪） */
export interface DrawioPdfPage {
  svg: string
  width?: number
  height?: number
}

export interface DrawioExportHost {
  /** 弹原生「另存为」并按内容写盘 */
  save(p: DrawioExportPayload): Promise<{ canceled: boolean; path?: string }>
  /** 只弹原生「另存为」，返回目标路径（给 showSaveFilePicker 用；取消返回 null） */
  pick(suggestedName: string): Promise<string | null>
  /** 往已确定的路径写内容 */
  write(path: string, p: { isBase64: boolean; data: string }): Promise<boolean>
  /** 导出 PDF（本地打印通道：隐藏窗口逐页渲染 SVG → printToPDF → 合并），filename 不含扩展名也可 */
  pdf(p: { filename: string; pages: DrawioPdfPage[] }): void | Promise<void>
  /** 打印（系统打印对话框；drawio 内嵌模式的 window.print 走这里） */
  print(p: { filename: string; svg: string }): void | Promise<void>
}

const DONE_FLAG = '__aimDrawioExportBridge'
const PICKER_FLAG = '__aimDrawioSavePickerBridge'
const PDF_FLAG = '__aimDrawioPdfBridge'
const PRINT_FLAG = '__aimDrawioPrintBridge'
const PRINT_WIN_FLAG = '__aimDrawioPrintWinBridge'
const UI_CAPTURE_FLAG = '__aimDrawioUiCaptureBridge'
const IMAGE_API_FLAG = '__aimDrawioImageApi'

/** 扩展名（小写，不含点） */
export function exportExt(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''))
  return m ? m[1].toLowerCase() : ''
}

/** 从 mime 猜扩展名（doSaveLocalFile 有时只给 mime） */
function extFromMime(mime: string): string {
  const m = /^[a-z]+\/([a-z0-9.+-]+)$/i.exec(String(mime || ''))
  const sub = m ? m[1].toLowerCase() : ''
  return sub === 'jpeg' ? 'jpg' : sub === 'svg+xml' ? 'svg' : sub === 'vnd.ms-visio.drawing' ? 'vsdx' : sub
}

const EXT_LABELS: Record<string, string> = {
  drawio: 'draw.io 图表',
  xml: 'XML 文件',
  svg: 'SVG 矢量图',
  png: 'PNG 图片',
  jpg: 'JPEG 图片',
  gif: 'GIF 图片',
  html: 'HTML 网页',
  pdf: 'PDF 文档',
  json: 'JSON 文件',
  csv: 'CSV 表格',
  txt: '文本文件',
  vsdx: 'Visio 绘图',
}

/** 保存对话框的过滤器（按扩展名给出，附带「所有文件」） */
export function exportFilters(filename: string, zh = true): Array<{ name: string; extensions: string[] }> {
  const ext = exportExt(filename)
  const list: Array<{ name: string; extensions: string[] }> = []
  if (ext) list.push({ name: EXT_LABELS[ext] || ext.toUpperCase() + (zh ? ' 文件' : ' file'), extensions: [ext] })
  list.push({ name: zh ? '所有文件' : 'All Files', extensions: ['*'] })
  return list
}

/** 去掉 base64 的 data URI 前缀（drawio 两种情况都会出现） */
export function stripDataUri(s: string): string {
  const v = String(s ?? '')
  const i = v.indexOf('base64,')
  return i >= 0 ? v.slice(i + 7) : v
}

/** Uint8Array → base64（分块，避免超大图栈溢出） */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)) as unknown as number[])
  }
  return btoa(out)
}

/** createWritable().write() 的入参可能是 string / Blob / ArrayBuffer / TypedArray */
export async function toExportPayload(data: any): Promise<{ isBase64: boolean; data: string }> {
  if (typeof data === 'string') return { isBase64: false, data }
  if (data && typeof data.arrayBuffer === 'function') {
    return { isBase64: true, data: bytesToBase64(new Uint8Array(await data.arrayBuffer())) }
  }
  if (data instanceof ArrayBuffer) return { isBase64: true, data: bytesToBase64(new Uint8Array(data)) }
  if (ArrayBuffer.isView(data)) {
    return { isBase64: true, data: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) }
  }
  return { isBase64: false, data: String(data ?? '') }
}

interface BridgeState {
  /** 最近一次调用过导出/打印的 EditorUi 实例（window.print 兜底时需要） */
  ui?: any
  /** PDF 导出进行中（切换页面取图期间防止重复触发） */
  pdfBusy?: boolean
}

/**
 * 把 iframe 内的导出/保存接到宿主。幂等：可重复调用（iframe 重载、协议 load 事件都会调）。
 * 返回本次新装的补丁数量（0 = 已装过或不适用）。
 */
export function installDrawioExportBridge(
  w: any,
  host: DrawioExportHost,
  log: (...args: any[]) => void = () => {},
  state: BridgeState = {},
): number {
  if (!w) return 0
  let patched = 0

  // ① 「导出为 → 下载 / 设备」：接住 doSaveLocalFile，改走宿主原生「另存为」
  const UI = w.EditorUi
  if (UI && UI.prototype && typeof UI.prototype.doSaveLocalFile === 'function' && !UI.prototype[DONE_FLAG]) {
    UI.prototype.doSaveLocalFile = function (data: any, filename?: string, mime?: string, isBase64?: boolean) {
      const ext = exportExt(filename || '') || extFromMime(mime || '') || 'drawio'
      const name = String(filename || '') || `export.${ext}`
      void host.save({
        filename: name,
        mime: String(mime || ''),
        isBase64: !!isBase64,
        data: String(data ?? ''),
      })
    }
    UI.prototype[DONE_FLAG] = true
    patched++
  } else if (!UI) {
    log('未找到 iframe 内的 EditorUi，导出桥未安装（drawio 版本变更？）')
  }

  // ② 「另存为到设备」：Electron 未实现 File System Access 选择框（Promise 挂死）→ 换成宿主对话框
  if (typeof w.showSaveFilePicker === 'function' && !w[PICKER_FLAG]) {
    const picker = async (opts: any = {}) => {
      const suggested = String(opts?.suggestedName || '') || 'untitled.drawio'
      const target = await host.pick(suggested)
      if (!target) {
        const err: any = new Error('用户取消保存')
        err.name = 'AbortError'
        throw err
      }
      let buffered: any = null
      let wrote = false
      const handle: any = {
        kind: 'file',
        name: target.split(/[\\/]/).pop() || suggested,
        getFile: async () => new w.File([buffered ?? ''], handle.name),
        createWritable: async () => ({
          write: async (d: any) => {
            buffered = d
          },
          close: async () => {
            const p = await toExportPayload(buffered)
            wrote = await host.write(target, p)
          },
          abort: async () => {
            buffered = null
          },
        }),
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        isSameEntry: async () => false,
        __aimWrote: () => wrote,
      }
      return handle
    }
    try {
      Object.defineProperty(w, 'showSaveFilePicker', { configurable: true, writable: true, value: picker })
      w[PICKER_FLAG] = true
      patched++
    } catch (e) {
      log('覆写 showSaveFilePicker 失败：', e)
    }
  }

  /** 带基名的文件名（drawio 的 getBaseFilename 拿当前文件名） */
  const baseName = (ui: any, fallback = 'diagram') => {
    try {
      const n = ui.getBaseFilename?.(false)
      if (n && String(n).trim()) return String(n).trim()
    } catch {
      /* ignore */
    }
    return fallback
  }

  /**
   * 取当前页 SVG：直接用 drawio 自己的 graph.getSvg（高保真：形状/字体/图片都按编辑器所见），
   * 签名参考它内部导出 SVG 的调法 (background, scale, border, nocrop, crisp, ignoreSelection)。
   */
  const currentSvg = (ui: any): string => {
    const graph = ui?.editor?.graph
    if (!graph || typeof graph.getSvg !== 'function') return ''
    const NONE = w.mxConstants?.NONE
    let bg = graph.background
    if (bg === NONE || bg === 'none') bg = null
    const el = graph.getSvg(bg, null, null, null, null, true)
    if (!el) return ''
    const xml = w.mxUtils?.getXml ? w.mxUtils.getXml(el) : new w.XMLSerializer().serializeToString(el)
    return String(xml || '')
  }

  /** 当前页在 drawio 里设置的纸张尺寸（pageWidth/pageHeight）；页面视图关掉时返回 null（按内容裁剪） */
  const pageSizeOf = (ui: any): { width: number; height: number } | null => {
    const g = ui?.editor?.graph
    if (!g || !g.pageFormat) return null
    if (g.pageVisible === false || g.pageVisible === '0') return null
    const width = Number(g.pageFormat.width)
    const height = Number(g.pageFormat.height)
    return width > 0 && height > 0 ? { width, height } : null
  }

  /**
   * 逐页取 SVG。内嵌协议同一时刻只渲染当前页，所以要临时切页：
   * 取完恢复原页，页面顺序与 drawio 的页签一致。
   */
  const collectPages = async (ui: any): Promise<DrawioPdfPage[]> => {
    const pages: any[] = Array.isArray(ui?.pages) ? ui.pages.slice() : []
    const start = ui?.currentPage
    const out: DrawioPdfPage[] = []
    const snap = () => {
      const svg = currentSvg(ui)
      if (!svg) return
      out.push({ svg, ...(pageSizeOf(ui) || {}) })
    }
    if (pages.length <= 1 || typeof ui.selectPage !== 'function') {
      snap()
      return out
    }
    for (const page of pages) {
      try {
        if (ui.currentPage !== page) ui.selectPage(page)
        // 切页后 pageFormat / 模型都已同步更新，留一拍确保导出读到的就是这一页
        await new Promise((r) => setTimeout(r, 30))
        snap()
      } catch (e) {
        log('导出 PDF 跳过一页：', e)
      }
    }
    if (start && ui.currentPage !== start) {
      try {
        ui.selectPage(start)
      } catch {
        /* ignore */
      }
    }
    return out
  }

  // ③ 「导出为 → PDF」：drawio 在离线 / 无法用云端导出服务时，exportPdf 动作会把
  //    showPrintDialog 的 callback 置空、退回 window.print() —— 在 Electron 里就是那个
  //    「ELECTRON / 此应用不支持打印预览」的空窗口。这里统一改走宿主本地通道：
  //    逐页取 SVG → 预览 → printToPDF → pdf-lib 合并成一份多页 PDF。
  const UI2 = w.EditorUi
  const exportPdf = (ui: any) => {
    if (state.pdfBusy) return
    state.pdfBusy = true
    const filename = baseName(ui) + '.pdf'
    void collectPages(ui)
      .then((pages) => {
        if (!pages.length) {
          log('PDF 导出失败：未能获取图表 SVG')
          return
        }
        return host.pdf({ filename, pages })
      })
      .finally(() => {
        state.pdfBusy = false
      })
  }

  if (UI2 && UI2.prototype && typeof UI2.prototype.downloadFile === 'function' && !UI2.prototype[PDF_FLAG]) {
    const original = UI2.prototype.downloadFile
    UI2.prototype.downloadFile = function (format: string, ...rest: any[]) {
      state.ui = this
      if (String(format) === 'pdf') {
        exportPdf(this)
        return
      }
      return original.apply(this, [format, ...rest])
    }
    UI2.prototype[PDF_FLAG] = true
    patched++
  }

  // ④ showPrintDialog 同时承担「导出为 PDF」和「文件 → 打印」两条入口：
  //    - 标题是 formatPdf → 无论 callback 有没有都走本地 PDF 通道（预览 + 合并）；
  //    - 其余（真正的打印）→ 仍走窗口打印。
  if (UI2 && UI2.prototype && typeof UI2.prototype.showPrintDialog === 'function' && !UI2.prototype[PRINT_FLAG]) {
    const origPrintDialog = UI2.prototype.showPrintDialog
    UI2.prototype.showPrintDialog = function (title: string, callback?: any) {
      state.ui = this
      let pdfTitle = ''
      try {
        pdfTitle = String(w.mxResources?.get?.('formatPdf') || '')
      } catch {
        /* ignore */
      }
      if (pdfTitle && (String(title || '') === pdfTitle || String(title || '').trim().toUpperCase() === 'PDF')) {
        exportPdf(this)
        return
      }
      // callback 为空 = drawio 准备走 window.print()（浏览器打印 / 另存为 PDF）
      if (callback == null) {
        const svg = currentSvg(this)
        if (svg) {
          void host.print({ filename: baseName(this) + '.pdf', svg })
          return
        }
      }
      return origPrintDialog.apply(this, arguments as any)
    }
    UI2.prototype[PRINT_FLAG] = true
    patched++
  }

  // ④b window.print 兜底（万一某条路径绕过 showPrintDialog）
  if (typeof w.print === 'function' && !w[PRINT_WIN_FLAG]) {
    try {
      const origWindowPrint = w.print
      w.print = function () {
        const svg = state.ui ? currentSvg(state.ui) : ''
        if (svg) {
          void host.print({ filename: baseName(state.ui) + '.pdf', svg })
          return
        }
        log('window.print 未能取到图表 SVG，已忽略（Electron 下原生 print 无对话框）')
        try {
          origWindowPrint.apply(w, arguments as any)
        } catch {
          /* ignore */
        }
      }
      w[PRINT_WIN_FLAG] = true
      patched++
    } catch (e) {
      log('覆写 window.print 失败：', e)
    }
  }

  // ⑤ 捕获 EditorUi 实例：宿主「复制为图片」要自己取画布内容（内嵌模式下 drawio 自带的
  //    copyAsImage 不可见——Editor.enableNativeClipboard 要求 window === window.top），
  //    而取图要用 ui.editor.graph。挂两个必被调用的钩子，只记 this、不改行为：
  //      updateActionStates：编辑器初始化完成、以及每次选中变化都会调
  //      getFileData：任何导出 / 保存都会调（宿主可用一次 xml 导出「催」出首次捕获）
  if (UI2 && UI2.prototype && !UI2.prototype[UI_CAPTURE_FLAG]) {
    for (const name of ['updateActionStates', 'getFileData']) {
      const orig = UI2.prototype[name]
      if (typeof orig !== 'function') continue
      UI2.prototype[name] = function (this: any) {
        if (!state.ui) state.ui = this
        return orig.apply(this, arguments as any)
      }
    }
    UI2.prototype[UI_CAPTURE_FLAG] = true
    patched++
  }

  // ⑥ 暴露给宿主的取图接口（只读；有选中元素时只画选中的那几个，与 drawio 原生行为一致）
  w[IMAGE_API_FLAG] = {
    ready: () => !!(state.ui && state.ui.editor && state.ui.editor.graph),
    /** 当前打开的页（0 起）+ 页名/页数；拿不到返回 null */
    currentPage: (): { index: number; id: string; name: string; total: number } | null => {
      const ui = state.ui
      if (!ui || !ui.editor || !ui.editor.graph) return null
      try {
        const index = typeof ui.getSelectedPageIndex === 'function' ? Number(ui.getSelectedPageIndex()) : -1
        const page = ui.currentPage
        return {
          index: Number.isFinite(index) ? index : -1,
          id: page && typeof page.getId === 'function' ? String(page.getId()) : '',
          name: page && typeof page.getName === 'function' ? String(page.getName()) : '',
          total: ui.pages ? ui.pages.length : 0,
        }
      } catch {
        return null
      }
    },
    /**
     * 切到指定页（序号 0 起，或页 id）。
     * 用途：`{action:'load'}` 重建内容后编辑器会回到第 1 页（实测），预览 / 回退 / 重同步后要切回来。
     */
    selectPage: (indexOrId: number | string): boolean => {
      const ui = state.ui
      if (!ui || !ui.pages || typeof ui.selectPage !== 'function') return false
      try {
        const page =
          typeof indexOrId === 'number'
            ? ui.pages[indexOrId]
            : typeof ui.getPageById === 'function'
              ? ui.getPageById(indexOrId)
              : null
        if (!page) return false
        ui.selectPage(page)
        return true
      } catch (e) {
        log('切换页面失败：', e)
        return false
      }
    },
    /** 全部页（序号 0 起 + 页 id / 页名）；拿不到返回空数组。内嵌渲染按页取图时用它列页。 */
    pages: (): Array<{ index: number; id: string; name: string }> => {
      const ui = state.ui
      if (!ui || !ui.pages) return []
      try {
        return ui.pages.map((p: any, i: number) => ({
          index: i,
          id: p && typeof p.getId === 'function' ? String(p.getId()) : '',
          name: p && typeof p.getName === 'function' ? String(p.getName()) : '',
        }))
      } catch {
        return []
      }
    },
    selectionCount: () => {
      try {
        const graph = state.ui && state.ui.editor && state.ui.editor.graph
        return graph ? graph.getSelectionCells().length : 0
      } catch {
        return 0
      }
    },
    /**
     * 取当前页 SVG 文本。走 drawio 自己的 graph.getSvg（与它内部导出 SVG / 复制为图片同一条路径）：
     * selectionOnly !== false 且确有选中时，只导出选中单元（getTopmostCells 避免容器子单元重复）。
     */
    svgForCopy: (opts: {
      scale?: number
      border?: number
      background?: string | null
      theme?: string
      selectionOnly?: boolean
    } = {}) => {
      try {
        const graph = state.ui && state.ui.editor && state.ui.editor.graph
        if (!graph || typeof graph.getSvg !== 'function') return ''
        let cells: any[] | null = null
        if (opts.selectionOnly !== false) {
          const sel = graph.getSelectionCells()
          if (sel && sel.length) {
            const top = graph.model.getTopmostCells(sel)
            cells = w.mxUtils && w.mxUtils.sortCells ? w.mxUtils.sortCells(top) : top
          }
        }
        const el = graph.getSvg(
          opts.background === undefined ? '#ffffff' : opts.background,
          opts.scale === undefined ? 1 : opts.scale,
          opts.border === undefined ? 8 : opts.border,
          null,
          null,
          null,
          null,
          null,
          null,
          graph.shadowVisible,
          null,
          opts.theme === undefined ? 'light' : opts.theme,
          null,
          cells,
        )
        if (!el) return ''
        return String(w.mxUtils && w.mxUtils.getXml ? w.mxUtils.getXml(el) : new w.XMLSerializer().serializeToString(el))
      } catch (e) {
        log('取画布内容失败：', e)
        return ''
      }
    },
  }

  return patched
}
