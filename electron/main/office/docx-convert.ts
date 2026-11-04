/**
 * docx-convert.ts — 旧版 .doc → .docx 转换（Office MCP 的 convert_doc_to_docx）
 *
 * .doc 是 OLE2 二进制格式，不能像 .docx 那样直接改 XML；这里不引入第三方库，
 * 优先调用本机 Microsoft Word 的 COM 自动化（Windows，Word 已安装时最稳），
 * 找不到 Word 时再尝试 LibreOffice 的无头转换。
 *
 * 转换是独立操作，不依赖 open_document 会话；输出默认与源文件同目录、同名 .docx。
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface DocxConvertResult {
  ok: true
  outputPath: string
  converter: 'word-com' | 'libreoffice'
  bytes: number
}
export interface DocxConvertError {
  ok: false
  error: string
  tried?: string[]
}

function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({ code: err?.code ?? (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') })
    })
  })
}

/** 用本机 Word COM 转换；成功返回输出路径 */
async function convertWithWord(input: string, output: string): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: 'Word COM 仅支持 Windows' }
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "$word=$null; $doc=$null",
    'try {',
    '  $word=New-Object -ComObject Word.Application',
    '  $word.Visible=$false',
    '  $word.DisplayAlerts=0',
    `  $doc=$word.Documents.Open(${psQuote(input)}, $false, $false)`,
    `  $doc.SaveAs2(${psQuote(output)}, 12)`,
    '  Write-Output "OK"',
    '} catch {',
    '  Write-Output ("ERR:" + $_.Exception.Message)',
    '  exit 1',
    '} finally {',
    '  if ($doc) { try { $doc.Close($false) } catch {} }',
    '  if ($word) { try { $word.Quit() } catch {} }',
    '}',
  ].join('\r\n')
  const scriptPath = path.join(os.tmpdir(), `aikm-doc2docx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`)
  fs.writeFileSync(scriptPath, script, 'utf8')
  try {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], 120_000)
    if (r.code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) return { ok: true }
    return { ok: false, error: (r.stdout || r.stderr || 'Word 转换失败').replace(/^ERR:/, '').trim() }
  } finally {
    try { fs.unlinkSync(scriptPath) } catch { /* ignore */ }
  }
}

/** LibreOffice 无头转换（Word 不可用时的后备） */
async function convertWithLibreOffice(input: string, output: string): Promise<{ ok: boolean; error?: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikm-lo-'))
  try {
    const candidates = process.platform === 'win32'
      ? ['soffice.exe', 'libreoffice.exe']
      : ['soffice', 'libreoffice']
    let lastErr = ''
    for (const bin of candidates) {
      const r = await run(bin, ['--headless', '--convert-to', 'docx', '--outdir', tmpDir, input], 120_000)
      if (r.code !== 0) { lastErr = r.stderr || r.stdout || `${bin} 转换失败`; continue }
      const produced = fs.readdirSync(tmpDir).find((f) => f.toLowerCase().endsWith('.docx'))
      if (!produced) { lastErr = 'LibreOffice 未生成 .docx'; continue }
      fs.copyFileSync(path.join(tmpDir, produced), output)
      return { ok: true }
    }
    return { ok: false, error: lastErr || '未找到 LibreOffice（soffice）' }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/**
 * 把 .doc 转成 .docx（保留原格式）。
 *
 * 只使用真正能保留版式的转换器：Microsoft Word COM 或 LibreOffice。
 * 两者都不可用时**直接报错**，不做“纯文本另存”的降级——那种结果会丢表格 / 图片 / 样式，
 * 对用户不是转换而是误导。
 *
 * @param inputPath 源 .doc 路径
 * @param outputPath 可选；默认同目录同名 .docx
 * @param overwrite 输出已存在时是否覆盖（默认 false）
 */
export async function convertDocToDocx(
  inputPath: string,
  outputPath?: string,
  overwrite = false,
): Promise<DocxConvertResult | DocxConvertError> {
  const input = path.resolve(String(inputPath || ''))
  if (!input) return { ok: false, error: '缺少 .doc 文件路径' }
  if (!fs.existsSync(input)) return { ok: false, error: `文件不存在：${input}` }
  if (path.extname(input).toLowerCase() !== '.doc') {
    return { ok: false, error: `只支持旧版 .doc → .docx；当前文件是 ${path.extname(input) || '无扩展名'}（.docx 无需转换）` }
  }
  const output = path.resolve(String(outputPath || '').trim() || input.replace(/\.doc$/i, '.docx'))
  if (path.extname(output).toLowerCase() !== '.docx') return { ok: false, error: `输出路径必须是 .docx：${output}` }
  if (input.toLowerCase() === output.toLowerCase()) return { ok: false, error: '输出路径不能与源文件相同' }
  if (fs.existsSync(output)) {
    if (!overwrite) return { ok: false, error: `输出文件已存在：${output}（如要覆盖请传 overwrite=true）` }
    try { fs.unlinkSync(output) } catch (e: any) { return { ok: false, error: `无法覆盖输出文件：${e?.message || e}` } }
  }
  try { fs.mkdirSync(path.dirname(output), { recursive: true }) } catch (e: any) {
    return { ok: false, error: `无法创建输出目录：${e?.message || e}` }
  }
  const tried: string[] = []
  const word = await convertWithWord(input, output)
  tried.push('Microsoft Word COM')
  if (word.ok) return { ok: true, outputPath: output, converter: 'word-com', bytes: fs.statSync(output).size }
  if (word.error) tried.push(`Word: ${word.error}`)
  // Word 失败可能留下半成品 / 锁定文件，清理后再让 LibreOffice 尝试
  try { if (fs.existsSync(output)) fs.unlinkSync(output) } catch { /* ignore */ }
  const lo = await convertWithLibreOffice(input, output)
  tried.push('LibreOffice')
  if (lo.ok) return { ok: true, outputPath: output, converter: 'libreoffice', bytes: fs.statSync(output).size }
  if (lo.error) tried.push(`LibreOffice: ${lo.error}`)
  return {
    ok: false,
    error: '转换失败：没有可用的格式保留转换器。内置 GenOffice 不支持旧版 .doc → .docx，请安装 Microsoft Word（Windows）或 LibreOffice 后重试；不会生成丢失格式的纯文本 .docx。',
    tried,
  }
}
