/**
 * RTF → 纯文本（最小实现）
 *
 * 用途只有一个：兜住「扩展名是 .doc、内容其实是 RTF」的文件（部分系统 / 导出工具会这样存）。
 * 真正的 Word 97-2003 二进制由 word-extractor 读取，不走这里。
 *
 * 只提取正文：控制字、`\'hh` 字节转义、`\uN` Unicode、段落 / 换行 / 制表符；
 * 字体表、颜色表、样式表、图片、页眉页脚、域代码等「目的地」整组跳过。
 * 不做排版还原 —— 调用方随后按段落把文本转成 Markdown。
 */

/** 整组内容都不是正文的 RTF 目的地（destination） */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'objclass',
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'annotation', 'fldinst', 'listtable', 'listoverridetable', 'listpicture',
  'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'filetbl', 'revtbl', 'pnseclvl', 'wgrffmtfilter', 'mmathpr',
])

/** 常见控制字 → 文本（其余控制字只影响排版，直接忽略） */
const SYMBOL_TEXT: Record<string, string> = {
  par: '\n',
  line: '\n',
  sect: '\n',
  page: '\n',
  tab: '\t',
  // 表格：\cell 结束单元格、\row 结束行 → 与 .doc 一致用制表符 / 换行表达，供上层还原管道表格
  cell: '\t',
  row: '\n',
  emdash: '\u2014',
  endash: '\u2013',
  bullet: '\u2022',
  lquote: '\u2018',
  rquote: '\u2019',
  ldblquote: '\u201c',
  rdblquote: '\u201d',
}

/** 取文档声明的 ANSI 代码页（只读文件头，避免在正文里误匹配） */
function ansicpgOf(src: string): number | undefined {
  const m = /\\ansicpg(\d+)/.exec(src.slice(0, 4096))
  return m ? parseInt(m[1], 10) : undefined
}

/** 代码页 → TextDecoder（不认识的代码页按 windows-1252 处理，至少不会整体乱码） */
function decoderFor(codepage: number | undefined): TextDecoder {
  const label =
    codepage === 936 ? 'gbk'
      : codepage === 950 ? 'big5'
        : codepage === 932 ? 'shift_jis'
          : codepage === 949 ? 'euc-kr'
            : codepage === 65001 ? 'utf-8'
              : 'windows-1252'
  try {
    return new TextDecoder(label)
  } catch {
    return new TextDecoder('windows-1252')
  }
}

/** RTF 源文件 → 纯文本（`rtf` 可传字符串或原始字节） */
export function rtfToText(rtf: string | Buffer): string {
  // RTF 本身是 7 位 ASCII，非 ASCII 字节都经 `\'hh` 转义；按 latin1 解码可逐字节还原
  const src = typeof rtf === 'string' ? rtf : rtf.toString('latin1')
  const decoder = decoderFor(ansicpgOf(src))
  const out: string[] = []
  /** 连续 `\'hh` 字节（多字节字符要一起解码，不能逐字节转） */
  let hexBytes: number[] = []
  let i = 0
  let skip = false
  const stack: boolean[] = []
  let ucSkip = 1

  const flushHex = (): void => {
    if (!hexBytes.length) return
    if (!skip) out.push(decoder.decode(new Uint8Array(hexBytes)))
    hexBytes = []
  }
  const emit = (text: string): void => {
    flushHex()
    if (!skip) out.push(text)
  }
  /** `\uN` 后面的 ANSI 回退字符：按 \ucN 声明的个数跳过（\'hh 与普通字符各算一个） */
  const skipFallback = (): void => {
    let left = Math.max(0, ucSkip)
    while (left > 0 && i < src.length) {
      if (src[i] === '\\' && src[i + 1] === "'") {
        i += 4
        left--
        continue
      }
      if (src[i] === '\\') {
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i))
        if (m) {
          i += m[0].length
          left--
          continue
        }
        i += 2
        left--
        continue
      }
      if (src[i] === '{' || src[i] === '}') return
      i++
      left--
    }
  }

  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      flushHex()
      stack.push(skip)
      i++
      continue
    }
    if (ch === '}') {
      flushHex()
      skip = stack.pop() ?? false
      i++
      continue
    }
    if (ch === '\\') {
      const next = src[i + 1]
      if (next === "'") {
        const byte = parseInt(src.slice(i + 2, i + 4), 16)
        if (Number.isFinite(byte)) hexBytes.push(byte)
        i += 4
        continue
      }
      if (next === '\\' || next === '{' || next === '}') {
        emit(next)
        i += 2
        continue
      }
      if (next === '~') {
        emit('\u00a0')
        i += 2
        continue
      }
      if (next === '_') {
        emit('-')
        i += 2
        continue
      }
      if (next === '*') {
        // `\*` 标记「可忽略目的地」（如生成器信息）：整组不取
        skip = true
        i += 2
        continue
      }
      if (next === '\n' || next === '\r') {
        i += 2
        continue
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i))
      if (!m) {
        i += 2
        continue
      }
      const word = m[1]
      const param = m[2] === undefined ? undefined : parseInt(m[2], 10)
      i += m[0].length
      if (word === 'uc' && param !== undefined) {
        ucSkip = param
        continue
      }
      if (word === 'u' && param !== undefined) {
        const code = param < 0 ? param + 65536 : param
        emit(String.fromCodePoint(code))
        skipFallback()
        continue
      }
      if (word === 'bin' && param !== undefined) {
        // 二进制数据（通常是图片）：跳过声明的字节数
        i += Math.max(0, param)
        continue
      }
      const symbol = SYMBOL_TEXT[word]
      if (symbol !== undefined) {
        emit(symbol)
        continue
      }
      if (SKIP_DESTINATIONS.has(word)) {
        skip = true
        continue
      }
      continue
    }
    if (ch === '\r' || ch === '\n') {
      // RTF 源文件里的换行只用于分隔控制字，不是正文
      i++
      continue
    }
    if (!skip) {
      flushHex()
      out.push(ch)
    }
    i++
  }
  flushHex()
  return out.join('')
}
