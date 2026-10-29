/**
 * 无类型声明的可选运行时依赖的最小环境声明。
 *
 * sherpa-onnx-node：本地 TTS 原生 N-API 二进制包（Kokoro / Piper），
 * npm 上没有 @types 包，仅在 tts-worker.ts 中懒加载使用
 * （不依赖其类型信息，避免为它引入类型维护成本）。
 */
declare module 'sherpa-onnx-node'

/**
 * word-extractor：纯 JS 的 Word 97-2003 / .docx 读取器（npm 上没有 @types）。
 * 这里只声明项目用到的部分：extract() 与文档访问器。
 */
declare module 'word-extractor' {
  interface WordExtractorOptions {
    /** false 时保留弯引号等 Unicode 原字符（项目需要原样正文，故总是传 false） */
    filterUnicode?: boolean
  }
  interface WordTextboxOptions extends WordExtractorOptions {
    includeHeadersAndFooters?: boolean
    includeBody?: boolean
  }
  interface ExtractedWordDocument {
    getBody(options?: WordExtractorOptions): string
    getHeaders(options?: WordExtractorOptions & { includeFooters?: boolean }): string
    getFooters(options?: WordExtractorOptions): string
    getFootnotes(options?: WordExtractorOptions): string
    getEndnotes(options?: WordExtractorOptions): string
    getAnnotations(options?: WordExtractorOptions): string
    getTextboxes(options?: WordTextboxOptions): string
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<ExtractedWordDocument>
  }
}
