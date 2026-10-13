/**
 * tts-worker.ts — 本地 ONNX TTS（Kokoro / Piper）工作线程
 *
 * 把 sherpa-onnx 的模型加载与语音合成从 Electron 主进程搬到 worker 线程，
 * 避免同步推理阻塞主进程事件循环（否则窗口拖动/菜单/IPC 会卡死）。
 *
 * 运行时用原生 N-API 版（sherpa-onnx-node）而非 WASM 版：WASM 版在 Node 下
 * 强制单线程（"WASM does not support multi-threading"），Kokoro 这类大模型
 * 实测 RTF ≈ 3.7，原生多线程可降到 RTF ≈ 0.3。
 *
 * 通信协议（主进程 → worker）：
 *   { id, type: 'status' | 'load' | 'synthesize' | 'dispose', payload }
 * worker → 主进程：
 *   { id, ok: true, data }           —— data.wav 为 Uint8Array（带 transfer）
 *   { id, ok: false, error }
 */

import { parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** 主进程传入的可写缓存目录（用于 espeak 数据目录的 ASCII 映射） */
const cacheDir: string = (workerData as any)?.cacheDir || ''

// ---------- sherpa-onnx 懒加载 ----------

let sherpa: any = null
let sherpaLoadPromise: Promise<any> | null = null

async function loadSherpa(): Promise<any> {
  if (sherpa) return sherpa
  if (sherpaLoadPromise) return sherpaLoadPromise
  sherpaLoadPromise = (async () => {
    const mod: any = await import('sherpa-onnx-node')
    const s = mod?.default ?? mod
    if (typeof s?.OfflineTts !== 'function') {
      throw new Error('sherpa-onnx-node 缺少 OfflineTts')
    }
    sherpa = s
    return s
  })()
  return sherpaLoadPromise
}

/** 切换模型 / 卸载时释放实例（原生运行时由 GC 回收，带 free() 的实现则显式调用） */
function releaseTts(tts: any): void {
  try {
    if (typeof tts?.free === 'function') tts.free()
  } catch { /* ignore */ }
}

/**
 * espeak-ng / openfst 内部按 ANSI 处理路径，非 ASCII 的辅助文件路径会直接
 * 崩掉原生运行时（espeak 报找不到 phontab；ruleFsts 在 createOfflineTts 时
 * 触发 0xC0000409）。这里把这类路径映射到缓存目录下的 ASCII 链接/副本。
 */
const ASCII_PATH_RE = /^[\x20-\x7E]+$/

function asciiCacheRoot(): string {
  return cacheDir || path.join(os.tmpdir(), 'ai-km-tts')
}

function hashPath(p: string): string {
  return createHash('sha1').update(p).digest('hex').slice(0, 12)
}

/** 非 ASCII 目录 → 缓存目录下的 ASCII 同名目录（优先建链接，失败则复制） */
function ensureAsciiDir(srcDir: string): string {
  if (!srcDir || ASCII_PATH_RE.test(srcDir)) return srcDir
  const target = `${path.join(asciiCacheRoot(), 'espeak-ng-data')}-${hashPath(srcDir)}`
  const usable = () => {
    try {
      return fs.readdirSync(target).length > 0
    } catch {
      return false
    }
  }
  try {
    if (!usable()) {
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      try {
        fs.symlinkSync(srcDir, target, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        fs.cpSync(srcDir, target, { recursive: true })
      }
    }
    if (usable()) return target
  } catch (err: any) {
    console.warn(`[TTS-WORKER] 数据目录 ASCII 映射失败，回退原路径: ${err?.message || err}`)
  }
  return srcDir
}

/** 非 ASCII 文件 → 缓存目录下的 ASCII 副本（ruleFsts 等小文件） */
function ensureAsciiFile(srcFile: string): string {
  if (!srcFile || ASCII_PATH_RE.test(srcFile)) return srcFile
  const target = path.join(asciiCacheRoot(), 'rules', `${hashPath(srcFile)}-${path.basename(srcFile)}`)
  try {
    const src = fs.statSync(srcFile)
    const same = (() => {
      try {
        const dst = fs.statSync(target)
        return dst.size === src.size && dst.mtimeMs >= src.mtimeMs
      } catch {
        return false
      }
    })()
    if (!same) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(srcFile, target)
    }
    return target
  } catch (err: any) {
    console.warn(`[TTS-WORKER] 规则文件 ASCII 映射失败，回退原路径: ${err?.message || err}`)
    return srcFile
  }
}

// ---------- 模型目录文件探测 ----------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findFile(dir: string, names: string[]): string | null {
  for (const name of names) {
    if (name.includes('*')) {
      try {
        const regex = new RegExp('^' + name.split('*').map(escapeRegExp).join('.*') + '$', 'i')
        const hit = fs.readdirSync(dir).find((f) => regex.test(f))
        if (hit) return path.join(dir, hit)
      } catch { /* ignore */ }
      continue
    }
    const full = path.join(dir, name)
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
    } catch { /* ignore */ }
  }
  return null
}

function findDataDir(dir: string): string {
  for (const c of ['espeak-ng-data', 'espeak_data']) {
    const full = path.join(dir, c)
    try {
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return full
    } catch { /* ignore */ }
  }
  return ''
}

function findLexicons(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^lexicon[\w.-]*\.txt$/i.test(f))
      .map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

interface ResolvedEntry {
  engine: 'Kokoro' | 'Piper'
  tts: any
  modelDir: string
  lang?: string
  /** 是否中文模型（中文 VITS/Piper 或 Kokoro）——决定是否做 =/数字→中文归一 */
  chinese?: boolean
  resolved: Record<string, string>
}

// ---------- 模型实例缓存 ----------

const cache = new Map<string, ResolvedEntry>()

function cacheKey(engine: string, modelDir: string, lang?: string): string {
  return `${engine}|${modelDir}|${lang || ''}`
}

// kokoro 多语言模型：lang='zh' 前端遇英文/数字会抛 C++ 异常（WASM 报裸数字），
// lang='en'（misaki G2P）可同时正确处理中英文。这里记录每个目录"实际可用"的语言，
// 一旦某语言合成失败并切换成功，后续直接复用，避免每次都重建 310MB 模型。
const kokoroLangOverride = new Map<string, string>()

function kokoroEffectiveLang(engine: string, modelDir: string, requested?: string): string | undefined {
  if (engine !== 'Kokoro') return requested
  return kokoroLangOverride.get(modelDir) || requested || 'en'
}

async function getTts(engine: string, modelDir: string, lang?: string): Promise<ResolvedEntry> {
  const key = cacheKey(engine, modelDir, lang)
  const cached = cache.get(key)
  if (cached) return cached

  if (!modelDir) throw new Error('未设置模型目录')
  if (!fs.existsSync(modelDir)) throw new Error(`模型目录不存在: ${modelDir}`)

  let modelConfig: Record<string, any>
  let resolvedEngine: 'Kokoro' | 'Piper'
  let entryChinese = false
  let ruleFsts = ''
  const resolved: Record<string, string> = { engine: engine === 'Piper' ? 'Piper' : 'Kokoro' }

  if (engine === 'Kokoro') {
    const model = findFile(modelDir, ['model.onnx', 'model.int8.onnx', 'kokoro.onnx', '*.onnx'])
    const voices = findFile(modelDir, ['voices.bin', 'kokoro-voices.bin'])
    const tokens = findFile(modelDir, ['tokens.txt'])
    if (!model || !voices || !tokens) {
      throw new Error('Kokoro 模型目录缺少文件（需要 model.onnx + voices.bin + tokens.txt）')
    }
    const dataDir = ensureAsciiDir(findDataDir(modelDir))
    const lexicons = findLexicons(modelDir)
    // 默认 en：lang='zh' 遇英文/数字会崩，'en' 中英文混合都正常
    const effectiveLang = lang || 'en'
    resolvedEngine = 'Kokoro'
    entryChinese = true // Kokoro 支持中文，= / 数字→中文归一
    resolved.model = model
    resolved.voices = voices
    resolved.tokens = tokens
    resolved.dataDir = dataDir
    resolved.lexicon = lexicons.join(',')
    resolved.lang = effectiveLang
    modelConfig = {
      model, voices, tokens, dataDir,
      lexicon: lexicons.join(','), lang: effectiveLang,
    }
  } else {
    // Piper / VITS
    const model = findFile(modelDir, ['model.onnx', 'vits-*.onnx', '*.onnx'])
    const tokens = findFile(modelDir, ['tokens.txt'])
    if (!model || !tokens) {
      throw new Error('Piper 模型目录缺少文件（需要 *.onnx + tokens.txt）')
    }
    const dataDir = ensureAsciiDir(findDataDir(modelDir))
    const lexicon = findFile(modelDir, ['lexicon.txt', 'lexicon-us-en.txt', 'lexicon-zh.txt'])
    // 中文 VITS 模型（如 vits-zh-hf-*）需 =/数字→中文归一；英文 Piper 不归一
    const isChinese = /(?:^|[-_])zh(?:[-_]|$)/i.test(modelDir) || /(?:^|[-_])zh(?:[-_]|$)/i.test(path.basename(model))
    // 中文 VITS 的 ruleFsts（数字/日期/电话规范化）与 dictDir（jieba 分词），
    // 官方对 vits-zh-hf-* 系列必需，否则数字读法错误、前端退化为逐字；
    // 原生运行时的 openfst 读不了非 ASCII 路径，需先映射（否则崩在 createOfflineTts）
    const fstNames = ['phone.fst', 'date.fst', 'number.fst', 'new_heteronym.fst', '*.fst']
    const fsts = [...new Set(fstNames.map((f) => findFile(modelDir, [f])).filter(Boolean) as string[])]
      .map(ensureAsciiFile)
    const dictDir = path.join(modelDir, 'dict')
    const hasDict = fs.existsSync(dictDir) && fs.statSync(dictDir).isDirectory()
    resolvedEngine = 'Piper'
    resolved.model = model
    resolved.tokens = tokens
    resolved.dataDir = dataDir
    resolved.lexicon = lexicon || ''
    resolved.fsts = fsts.join(',')
    resolved.dictDir = hasDict ? dictDir : ''
    modelConfig = {
      model, tokens, dataDir, lexicon: lexicon || '',
      ...(hasDict ? { dictDir } : {}),
      noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0,
    }
    ruleFsts = fsts.join(',')
    entryChinese = isChinese
  }

  const s = await loadSherpa()

  // 释放同引擎不同目录的旧实例，避免内存堆积
  for (const [k, v] of cache) {
    if (v.engine === resolvedEngine && k !== key) {
      releaseTts(v.tts)
      cache.delete(k)
    }
  }

  // 原生运行时支持多线程：按逻辑核数的一半取（上限 8，留出核心给界面）
  const cpus = os.cpus()?.length || 2
  const numThreads = Math.max(1, Math.min(8, Math.round(cpus / 2)))

  const config = {
    model: {
      ...(resolvedEngine === 'Kokoro' ? { kokoro: modelConfig } : { vits: modelConfig }),
      numThreads,
      debug: 0,
      provider: 'cpu',
    },
    ruleFsts: ruleFsts,
    ruleFars: '',
    maxNumSentences: 1,
    silenceScale: 0.2,
  }

  let tts: any
  try {
    tts = new s.OfflineTts(config)
  } catch (err: any) {
    throw new Error(`创建 TTS 失败（模型文件损坏或格式不支持？）: ${err?.message || err}`)
  }
  if (!tts || !tts.sampleRate) {
    throw new Error('创建 TTS 失败：模型未加载成功')
  }

  const entry: ResolvedEntry = { engine: resolvedEngine, tts, modelDir, lang, chinese: entryChinese, resolved }
  cache.set(key, entry)
  return entry
}

// ---------- WAV 编码（Float32 → 16-bit PCM mono） ----------

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const int16 = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]
    if (s >= 1) s = 1
    else if (s <= -1) s = -1
    int16[i] = s * 32767
  }
  const bytesPerSample = 2
  const dataSize = int16.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  view.setUint32(0, 0x46464952, true)          // 'RIFF'
  view.setUint32(4, 36 + dataSize, true)
  view.setUint32(8, 0x45564157, true)          // 'WAVE'
  view.setUint32(12, 0x20746d66, true)         // 'fmt '
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)                  // PCM
  view.setUint16(22, 1, true)                  // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)                 // 16-bit
  view.setUint32(36, 0x61746164, true)         // 'data'
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < int16.length; i++) {
    view.setInt16(44 + i * 2, int16[i], true)
  }
  return new Uint8Array(buffer)
}

// ---------- 中文数字归一（Kokoro 合成用） ----------

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 1-4 位数字转中文（去前导零），如 100 → 一百、10 → 十 */
function group4ToCn(s: string): string {
  s = s.replace(/^0+/, '')
  if (!s) return ''
  const units = ['', '十', '百', '千']
  let r = ''
  const len = s.length
  for (let i = 0; i < len; i++) {
    const d = s.charCodeAt(i) - 48
    const unit = units[len - 1 - i]
    if (d === 0) {
      if (r && !r.endsWith('零')) r += '零'
    } else if (d === 1 && unit === '十' && i === 0 && len > 1) {
      r += '十' // 10 → 十，而非 一十
    } else {
      r += CN_DIGITS[d] + unit
    }
  }
  return r.replace(/零+/g, '零').replace(/零$/, '')
}

/** 整数转中文，支持 亿/万，如 1000000 → 一百万、2025 → 二千零二十五 */
function intToCn(nStr: string): string {
  nStr = nStr.replace(/^0+/, '')
  if (!nStr) return '零'
  const groups: string[] = []
  let n = nStr
  while (n.length > 4) {
    groups.unshift(n.slice(-4))
    n = n.slice(0, -4)
  }
  groups.unshift(n)
  const bigUnits = ['', '万', '亿', '万亿']
  let r = ''
  const gCount = groups.length
  for (let g = 0; g < gCount; g++) {
    const gStr = group4ToCn(groups[g])
    if (!gStr) continue
    if (g > 0 && groups[g].startsWith('0')) r += '零'
    r += gStr + bigUnits[gCount - 1 - g]
  }
  return r.replace(/零+/g, '零').replace(/零+$/, '')
}

/** 数字串（含可选小数）转中文，如 52.7 → 五十二点七 */
function cnNumber(match: string): string {
  if (!match.includes('.')) return intToCn(match)
  const [i, d] = match.split('.')
  return intToCn(i) + '点' + d.split('').map((c) => CN_DIGITS[+c]).join('')
}

/** 把 = 替换为"等于"、数字替换为中文数字（如 1.6 万亿 → 一点六万亿、3元 → 三元） */
function normalizeChineseText(text: string): string {
  return text
    .replace(/[＝=]+/g, '等于')
    .replace(/\d+(?:\.\d+)?/g, (m) => cnNumber(m))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 中文模型（Kokoro / 中文 VITS-Piper）合成前：= / 数字归一为中文；英文 Piper 原样（读不了中文数字） */
function prepareText(entry: ResolvedEntry, text: string): string {
  if (entry.chinese || entry.engine === 'Kokoro') return normalizeChineseText(text)
  return text
}

// ---------- 文本清洗 ----------

/**
 * 清洗文本，避免 sherpa-onnx 前端遇到非常用符号（如 =、emoji、控制符）时
 * 抛出 C++ 异常（报错形如 "Error: <数字>"，导致整段合成失败）。
 * 常规模式保留汉字/日韩/拉丁/数字 + 常用标点；aggressive 模式只留汉字/字母/数字/空白。
 */
function sanitizeTextForTts(text: string, aggressive = false): string {
  let s = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
  if (aggressive) {
    // 激进：去掉所有标点/符号，只保留汉字、日文假名、韩文、拉丁字母、数字、空白
    s = s.replace(/[^\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7afA-Za-z0-9\s]/g, ' ')
  } else {
    // 常规：额外保留常用中英文标点
    s = s.replace(/[^\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7afA-Za-z0-9\s，。！？；：、（）《》〈〉“”‘’·—…,.!?;:()'"’\-]/g, ' ')
  }
  return s.replace(/\s+/g, ' ').trim()
}

/** 合成一段（先做引擎相关归一，再常规清洗；失败则激进清洗重试一次） */
function generateWithFallback(entry: ResolvedEntry, text: string, sid: number, speed: number): any {
  const prepared = prepareText(entry, text)
  // enableExternalBuffer=false：Electron 禁止外部 ArrayBuffer，原生运行时默认开启会抛错
  try {
    return entry.tts.generate({ text: sanitizeTextForTts(prepared), sid, speed, enableExternalBuffer: false })
  } catch (e1: any) {
    console.warn(`[TTS-WORKER] 常规清洗合成失败，尝试激进清洗: ${e1?.message || String(e1)}`)
    return entry.tts.generate({ text: sanitizeTextForTts(prepared, true), sid, speed, enableExternalBuffer: false })
  }
}

// ---------- 消息处理 ----------

const port = parentPort
if (!port) {
  throw new Error('tts-worker 必须在 worker_threads 中运行')
}

port.on('message', async (msg: any) => {
  const { id, type, payload } = msg || {}
  try {
    let data: any
    if (type === 'status') {
      try {
        await loadSherpa()
        data = { available: true, version: sherpa?.version || '' }
      } catch (err: any) {
        data = { available: false, version: '', error: err?.message || String(err) }
      }
    } else if (type === 'load') {
      const entry = await getTts(payload?.engine, payload?.modelDir, kokoroEffectiveLang(payload?.engine, payload?.modelDir, payload?.lang))
      data = {
        engine: entry.engine,
        modelDir: entry.modelDir,
        modelFile: entry.resolved.model || '',
        sampleRate: entry.tts.sampleRate,
        numSpeakers: entry.tts.numSpeakers || 0,
        resolved: entry.resolved,
      }
    } else if (type === 'synthesize') {
      if (!payload?.text) throw new Error('合成文本为空')
      const engine = payload.engine
      const modelDir = payload.modelDir
      const effectiveLang = kokoroEffectiveLang(engine, modelDir, payload.lang)
      const sid = payload.sid ?? 0
      const speed = payload.speed ?? 1.0
      let audio: any = null
      let entry: ResolvedEntry
      try {
        entry = await getTts(engine, modelDir, effectiveLang)
        audio = generateWithFallback(entry, payload.text, sid, speed)
      } catch (e1: any) {
        // kokoro：当前语言遇英文/数字崩溃时，换另一种语言重试（zh<->en），并记录覆盖
        const altLang = effectiveLang === 'zh' ? 'en' : 'zh'
        entry = await getTts(engine, modelDir, altLang)
        try {
          audio = generateWithFallback(entry, payload.text, sid, speed)
          kokoroLangOverride.set(modelDir, altLang)
          console.warn(`[TTS-WORKER] ${modelDir} 已切换 kokoro lang=${altLang}`)
        } catch (e2: any) {
          throw new Error(`合成失败: ${e2?.message || String(e2)}`)
        }
      }
      if (!audio || !audio.samples || audio.samples.length === 0) {
        throw new Error('TTS 合成结果为空（文本过短或 sid 越界？）')
      }
      const wav = encodeWav(audio.samples, audio.sampleRate || entry.tts.sampleRate)
      data = { wav }
      // 转移 wav 的 ArrayBuffer，避免主进程额外拷贝（encodeWav 返回独占 buffer 的 Uint8Array）
      port.postMessage({ id, ok: true, data }, [wav.buffer as ArrayBuffer])
      return
    } else if (type === 'dispose') {
      for (const [, v] of cache) {
        releaseTts(v.tts)
      }
      cache.clear()
      kokoroLangOverride.clear()
      data = { success: true }
    } else {
      throw new Error(`未知消息类型: ${type}`)
    }
    port.postMessage({ id, ok: true, data })
  } catch (err: any) {
    port.postMessage({ id, ok: false, error: err?.message || String(err) })
  }
})
