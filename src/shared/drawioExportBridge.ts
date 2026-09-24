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

export interface DrawioExportHost {
  /** 弹原生「另存为」并按内容写盘 */
  save(p: DrawioExportPayload): Promise<{ canceled: boolean; path?: string }>
  /** 只弹原生「另存为」，返回目标路径（给 showSaveFilePicker 用；取消返回 null） */
  pick(suggestedName: string): Promise<string | null>
  /** 往已确定的路径写内容 */
  write(path: string, p: { isBase64: boolean; data: string }): Promise<boolean>
  /** 导出 PDF（本地打印通道：隐藏窗口渲染 SVG → printToPDF），filename 不含扩展名也可 */
  pdf(p: { filename: string; svg: string }): void | Promise<void>
  /** 打印（系统打印对话框；drawio 内嵌模式的 window.print 走这里） */
  print(p: { filename: string; svg: string }): void | Promise<void>
}

const DONE_FLAG = '__aimDrawioExportBridge'
const PICKER_FLAG = '__aimDrawioSavePickerBridge'
const PDF_FLAG = '__aimDrawioPdfBridge'
const PRINT_FLAG = '__aimDrawioPrintBridge'
const PRINT_WIN_FLAG = '__aimDrawioPrintWinBridge'

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

  // ③ 「导出为 → PDF」：drawio 在浏览器/Electron 下会把 SVG 上传到它的云端导出服务换 PDF
  //    （离线直接失败），改为走宿主本地打印通道（隐藏窗口 + printToPDF）
  const UI2 = w.EditorUi
  if (UI2 && UI2.prototype && typeof UI2.prototype.downloadFile === 'function' && !UI2.prototype[PDF_FLAG]) {
    const original = UI2.prototype.downloadFile
    UI2.prototype.downloadFile = function (format: string, ...rest: any[]) {
      state.ui = this
      if (String(format) === 'pdf') {
        const svg = currentSvg(this)
        if (!svg) {
          log('PDF 导出失败：未能获取当前页 SVG')
          return
        }
        void host.pdf({ filename: baseName(this) + '.pdf', svg })
        return
      }
      return original.apply(this, [format, ...rest])
    }
    UI2.prototype[PDF_FLAG] = true
    patched++
  }

  // ④ 「文件 → 打印」：drawio 在浏览器里靠 window.print()（Electron 下什么都不发生，也没法在
  //    window.print 里拿到 EditorUi 实例）→ 直接在 showPrintDialog 上拦截“本地打印”分支
  if (UI2 && UI2.prototype && typeof UI2.prototype.showPrintDialog === 'function' && !UI2.prototype[PRINT_FLAG]) {
    const origPrintDialog = UI2.prototype.showPrintDialog
    UI2.prototype.showPrintDialog = function (title: string, callback?: any) {
      state.ui = this
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

  return patched
}
