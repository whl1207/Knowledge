/**
 * officeSkeleton.ts — 「新建」Word / Excel / PPT 时写入的空白文件骨架（base64）。
 *
 * 三种格式都是 OOXML（zip）包：建一个 0 字节文件，预览/编辑器只会报「文件已损坏」，
 * 因此这里生成各自最小的**合法**空白文件——Word 一个空段落（A4 纵向）、
 * Excel 一个空工作簿、PPT 一张空白幻灯片（16:9）。
 *
 * Word / PPT 的最小部件在这里手写并用内置 ZIP 写入器打包（不压缩：产物仅几 KB，
 * 而 CompressionStream 并非所有运行环境都有）；Excel 交给已依赖的 SheetJS 生成，
 * 免得手写共享字符串 / 样式表这些容易出错的部分。
 */

export type OfficeBlankKind = 'docx' | 'xlsx' | 'pptx'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

// ==================== 内置 ZIP 写入器（stored，不压缩） ====================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 打一个 stored（不压缩）zip 包；部件名均为 ASCII，无需 UTF-8 标志位 */
function zipStored(parts: { name: string; text: string }[]): Uint8Array {
  const encoder = new TextEncoder()
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const part of parts) {
    const nameBytes = encoder.encode(part.name)
    const data = encoder.encode(part.text)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: stored
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // compressed size = size
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    chunks.push(local)

    const cd = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, dosTime, true)
    cv.setUint16(14, dosDate, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    cd.set(nameBytes, 46)
    central.push(cd)

    offset += local.length
  }

  const cdSize = central.reduce((s, p) => s + p.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, parts.length, true)
  ev.setUint16(10, parts.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + cdSize + eocd.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) { out.set(c, pos); pos += c.length }
  for (const c of central) { out.set(c, pos); pos += c.length }
  out.set(eocd, pos)
  return out
}

/** 字节 → base64（分段拼接，避免大数组触发 apply 参数上限） */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

// ==================== Word（.docx） ====================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOC_NS =
  `xmlns:w="${W_NS}" ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'

/** 标题 1-6：与 Word 内置标题同名（sizeHalfPoints 为半磅值） */
function headingStyleXml(level: number, sizeHalfPoints: number): string {
  // 3 级及以后：Word 只在文档用到时才在样式库里列出（semiHidden + unhideWhenUsed）
  const hidden = level >= 3 ? '<w:semiHidden/><w:unhideWhenUsed/>' : ''
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
    `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/>${hidden}<w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="${level <= 2 ? 240 : 160}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${sizeHalfPoints}"/><w:szCs w:val="${sizeHalfPoints}"/></w:rPr></w:style>`
  )
}

/** 项目符号 / 编号定义：各 5 级，numId 1 = 圆点、numId 2 = 数字（与 Word 新建文档一致） */
function numberingXml(): string {
  const levels = (kind: 'bullet' | 'decimal') => {
    let xml = ''
    for (let ilvl = 0; ilvl < 5; ilvl++) {
      const ind = `<w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>`
      const rPr = kind === 'bullet'
        ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>'
        : ''
      xml += kind === 'bullet'
        ? `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61623;"/><w:lvlJc w:val="left"/>${ind}${rPr}</w:lvl>`
        : `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${ilvl + 1}."/><w:lvlJc w:val="left"/>${ind}</w:lvl>`
    }
    return xml
  }
  return (
    XML_DECL +
    `<w:numbering xmlns:w="${W_NS}">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' + levels('bullet') + '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>' + levels('decimal') + '</w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>'
  )
}

function docxParts(): { name: string; text: string }[] {
  const styles =
    XML_DECL +
    `<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults>' +
    // eastAsia 留「等线」：中文正文不指定字体时不会退回宋体/乱码
    '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="等线" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    headingStyleXml(1, 32) + headingStyleXml(2, 28) + headingStyleXml(3, 26) +
    headingStyleXml(4, 24) + headingStyleXml(5, 22) + headingStyleXml(6, 22) +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>' +
    '<w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '</w:styles>'

  return [
    {
      name: '[Content_Types].xml',
      text:
        XML_DECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      text:
        XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      text:
        XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/styles.xml', text: styles },
    { name: 'word/numbering.xml', text: numberingXml() },
    {
      name: 'word/document.xml',
      text:
        XML_DECL +
        `<w:document ${DOC_NS}><w:body><w:p/>` +
        // A4 纵向 + 上下左右 2.54cm 页边距（与 Word 默认「普通」页面一致）
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
        '</w:sectPr></w:body></w:document>',
    },
  ]
}

// ==================== PPT（.pptx） ====================

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const EMPTY_SP_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>'

function pptxParts(): { name: string; text: string }[] {
  const rels = (items: string) => XML_DECL + `<Relationships xmlns="${RELS_NS}">${items}</Relationships>`
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`

  const fillStyles =
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  const lnStyles =
    '<a:lnStyleLst>' +
    ['6350', '12700', '19050'].map((w) =>
      `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`,
    ).join('') +
    '</a:lnStyleLst>'
  const effectStyles =
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  const bgFillStyles =
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'

  // 空白主题：只放 clrScheme / fontScheme / fmtScheme 这三个 themeElements 必需项
  const theme =
    XML_DECL +
    `<a:theme xmlns:a="${A_NS}" name="Office">` +
    '<a:themeElements>' +
    '<a:clrScheme name="Office">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
    '</a:clrScheme>' +
    // fontScheme 的 latin/ea/cs 必须齐全；中文按 Hans 指定「等线」，避免不同机器落到不同字体
    '<a:fontScheme name="Office">' +
    '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont>' +
    '</a:fontScheme>' +
    `<a:fmtScheme name="Office">${fillStyles}${lnStyles}${effectStyles}${bgFillStyles}</a:fmtScheme>` +
    '</a:themeElements></a:theme>'

  return [
    {
      name: '[Content_Types].xml',
      text:
        XML_DECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        '</Types>',
    },
    { name: '_rels/.rels', text: rels(rel('rId1', 'officeDocument', 'ppt/presentation.xml')) },
    {
      // 16:9（12192000 × 6858000 EMU），母版 + 一张空白幻灯片
      name: 'ppt/presentation.xml',
      text:
        XML_DECL +
        `<p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
        '</p:presentation>',
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      text: rels(rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml') + rel('rId2', 'slide', 'slides/slide1.xml')),
    },
    {
      name: 'ppt/slideMasters/slideMaster1.xml',
      text:
        XML_DECL +
        `<p:sldMaster xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
        `<p:cSld>${EMPTY_SP_TREE}</p:cSld>` +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
        '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>' +
        '</p:sldMaster>',
    },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      text: rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') + rel('rId2', 'theme', '../theme/theme1.xml')),
    },
    {
      name: 'ppt/slideLayouts/slideLayout1.xml',
      text:
        XML_DECL +
        `<p:sldLayout xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}" type="blank" preserve="1">` +
        `<p:cSld name="Blank">${EMPTY_SP_TREE}</p:cSld>` +
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
    },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      text: rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')),
    },
    {
      name: 'ppt/slides/slide1.xml',
      text:
        XML_DECL +
        `<p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">` +
        `<p:cSld>${EMPTY_SP_TREE}</p:cSld>` +
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      text: rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')),
    },
    { name: 'ppt/theme/theme1.xml', text: theme },
  ]
}

// ==================== Excel（.xlsx） ====================

async function blankXlsxBytes(): Promise<Uint8Array> {
  // 动态引入：SheetJS 较大，只在真的要新建 Excel 时才加载（不拖慢知识管理面板首屏）
  const XLSX: any = await import('xlsx')
  const book = XLSX.utils.book_new()
  // 一个空工作表（默认名 Sheet1），与 Excel 新建工作簿观感一致
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[]]), 'Sheet1')
  const out = XLSX.write(book, { bookType: 'xlsx', type: 'array' })
  return new Uint8Array(out)
}

// ==================== 对外入口 ====================

/** 生成空白 Office 文件内容（base64，不含 data: 前缀）；失败返回 '' */
export async function blankOfficeFileBase64(kind: OfficeBlankKind): Promise<string> {
  try {
    if (kind === 'xlsx') return toBase64(await blankXlsxBytes())
    const bytes = zipStored(kind === 'pptx' ? pptxParts() : docxParts())
    return toBase64(bytes)
  } catch (e) {
    console.warn('[new-file] 生成空白 Office 文件失败:', e)
    return ''
  }
}
