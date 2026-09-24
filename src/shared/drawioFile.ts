/**
 * drawioFile.ts — draw.io 图表文件的识别与初始内容（渲染进程 / 主进程共用，保持无 DOM 依赖）
 *
 * draw.io 的两种常见落盘格式：
 *  1) 未压缩：<mxfile><diagram name="..."><mxGraphModel>…</mxGraphModel></diagram></mxfile>
 *  2) 压缩：  <diagram> 内为 base64(raw deflate(URI 编码 XML)) 密文（draw.io 桌面版默认）
 * 两种格式都**原样交给 drawio 编辑器加载**即可（它内部自行解压），本模块不做解压/压缩。
 */

/** 随应用打包的 drawio webapp 目录（相对文档基址：dev 走 vite publicDir，生产走 dist，局域网共享走 dist） */
export const DRAWIO_ASSET_DIR = 'drawio/'

/** drawio 图表文件后缀（含双后缀，匹配用 endsWith 而非取 extname） */
const DRAWIO_SUFFIXES = ['.drawio', '.dio', '.drawio.xml']

/** 路径是否为 drawio 图表文件（只看扩展名） */
export function isDrawioPath(path?: string | null): boolean {
  const p = String(path || '').toLowerCase()
  return DRAWIO_SUFFIXES.some((s) => p.endsWith(s))
}

/** 内容是否像 drawio 的 XML（用于 .xml 文件嗅探） */
export function looksLikeDrawioXml(content?: string | null): boolean {
  if (!content) return false
  const head = String(content).slice(0, 4096)
  return head.includes('<mxfile') || head.includes('<mxGraphModel')
}

/**
 * 是否用 drawio 视图打开：
 * - `.drawio` / `.dio` / `.drawio.xml` 按扩展名直接判定；
 * - `.xml` 需内容嗅探（避免把所有 xml 都当图表）。
 */
export function isDrawioFile(path?: string | null, content?: string | null): boolean {
  if (isDrawioPath(path)) return true
  const p = String(path || '').toLowerCase()
  return p.endsWith('.xml') && looksLikeDrawioXml(content)
}

/** 新建空白图表的初始内容（单页，页面设置与 drawio 默认一致） */
export function newDrawioXml(): string {
  const id = 'p' + Math.random().toString(36).slice(2, 12)
  return (
    [
      '<mxfile host="AIKM">',
      `  <diagram id="${id}" name="Page-1">`,
      '    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">',
      '      <root>',
      '        <mxCell id="0" />',
      '        <mxCell id="1" parent="0" />',
      '      </root>',
      '    </mxGraphModel>',
      '  </diagram>',
      '</mxfile>',
    ].join('\n') + '\n'
  )
}
