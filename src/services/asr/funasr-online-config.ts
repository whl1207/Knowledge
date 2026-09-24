// src/services/asr/funasr-online-config.ts
// 解析 FunASR online 模型目录里的 config.yaml / am.mvn / tokens.json，
// 产出 FunasrOnlineModelConfig（供 FunasrOnlineRuntime + worker 双 session 使用）。
//
// config.yaml 只提取我们用到的标量键（这些键在整个文件里唯一，用全局正则即可）：
//   frontend_conf: fs/frame_length/frame_shift/n_mels/lfr_m/lfr_n
//   encoder_conf: output_size        decoder_conf: num_blocks / kernel_size
//   predictor_conf: threshold / tail_threshold
// am.mvn：kaldi/<Nnet> 文本，取 <AddShift> 与 <Rescale> 方括号内数值（(x+shift)*scale）
// tokens.json：数组（index=id）

import type { FunasrOnlineModelConfig } from '@/services/asr/funasr-online'

export interface FunasrDirConfig {
  fs: number
  frameLengthMs: number
  frameShiftMs: number
  nMels: number
  lfrM: number
  lfrN: number
  lowFreq: number
  highFreq: number
  encoderOutputSize: number
  fsmnLayers: number
  fsmnLorder: number
  cifThreshold: number
  tailThreshold: number
}

function firstNum(text: string, key: string, def: number): number {
  const re = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*([-+]?[0-9.]+(?:e[-+]?[0-9]+)?)`, 'i')
  const m = re.exec(text)
  return m ? Number(m[1]) : def
}

// 在某节（如 decoder_conf:）作用域内找 key（num_blocks/kernel_size 等在不同节重复出现）
function sectionNum(text: string, section: string, key: string, def: number): number {
  const secRe = new RegExp(`^\\s*${section}\\s*:`, 'm')
  const secMatch = secRe.exec(text)
  if (!secMatch) return def
  const start = secMatch.index + secMatch[0].length
  // 节内容到下一个"顶格 xxx:" 或文件尾
  const nextRe = /^[A-Za-z_][\w-]*\s*:/gm
  let end = text.length
  nextRe.lastIndex = start
  let m2: RegExpExecArray | null
  while ((m2 = nextRe.exec(text))) {
    if (m2.index > start && text.lastIndexOf('\n', m2.index - 1) < m2.index) {
      // 仅接受行首顶格（前面只有行首，无缩进）
      const lineStart = text.lastIndexOf('\n', m2.index - 1) + 1
      if (m2.index === lineStart) {
        end = m2.index
        break
      }
      // 缩进的子节（如 frontend_conf 下不再有）也跳过
    }
  }
  const slice = text.slice(start, end)
  return firstNum(slice, key, def)
}

export function parseFunasrConfigYaml(text: string): FunasrDirConfig {
  const cfg = {
    fs: firstNum(text, 'fs', 16000),
    frameLengthMs: firstNum(text, 'frame_length', 25),
    frameShiftMs: firstNum(text, 'frame_shift', 10),
    nMels: firstNum(text, 'n_mels', 80),
    lfrM: firstNum(text, 'lfr_m', 7),
    lfrN: firstNum(text, 'lfr_n', 6),
    lowFreq: 20,
    highFreq: 0, // 0 = nyquist（kaldi/knf 默认）
    encoderOutputSize: firstNum(text, 'output_size', 512),
    fsmnLayers: sectionNum(text, 'decoder_conf', 'num_blocks', 16),
    fsmnLorder: 0,
    cifThreshold: firstNum(text, 'threshold', 1.0),
    tailThreshold: firstNum(text, 'tail_threshold', 0.45)
  }
  const kernel = sectionNum(text, 'decoder_conf', 'kernel_size', 11)
  cfg.fsmnLorder = kernel - 1
  return cfg
}

export interface MvnPair {
  shift: Float32Array
  scale: Float32Array
}

// 解析 FunASR am.mvn（kaldi 文本；兼容 <AddShift>/<Rescale> 单/跨行、FunASR <Nnet> <LearnRateCoef> 布局）。
// 返回的 shift/scale 即方括号内数值，用法 (x + shift) * scale（与官方 frontend.apply_cmvn 一致）。
export function parseAmMvn(content: string): MvnPair | null {
  if (!content || content.includes('\0')) return null
  content = content.replace(/^\uFEFF/, '')
  const lines = content.split(/\r?\n/)
  let parsingShift = false
  let parsingScale = false
  let bracketOpen = false
  const shiftValues: number[] = []
  const scaleValues: number[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(<AddShift>|<Rescale>|<\/)/.test(trimmed)) {
      if (trimmed.startsWith('<AddShift>')) { parsingShift = true; parsingScale = false }
      else if (trimmed.startsWith('<Rescale>')) { parsingShift = false; parsingScale = true }
      else if (trimmed.startsWith('</')) { parsingShift = false; parsingScale = false }
      bracketOpen = false
    }
    if (!parsingShift && !parsingScale) continue
    const hasOpen = trimmed.includes('[')
    const hasClose = trimmed.includes(']')
    let inner = ''
    if (hasOpen && hasClose) {
      inner = trimmed.slice(trimmed.indexOf('[') + 1, trimmed.lastIndexOf(']'))
      bracketOpen = false
    } else if (hasOpen) {
      inner = trimmed.slice(trimmed.indexOf('[') + 1)
      bracketOpen = true
    } else if (bracketOpen) {
      inner = hasClose ? trimmed.slice(0, trimmed.lastIndexOf(']')) : trimmed
      if (hasClose) bracketOpen = false
    }
    const nums = inner.trim().split(/\s+/).filter((tk) => tk !== '').map(Number).filter((n) => !isNaN(n))
    if (parsingShift) shiftValues.push(...nums)
    else if (parsingScale) scaleValues.push(...nums)
  }
  if (shiftValues.length < 8 || scaleValues.length < 8) return null
  return { shift: Float32Array.from(shiftValues), scale: Float32Array.from(scaleValues) }
}

// tokens.json：优先数组（index=id）；对象则自动判方向（兼容少数仓库）
export function parseTokensJson(content: string): string[] {
  const data = JSON.parse(content)
  if (Array.isArray(data)) return data.filter((t): t is string => typeof t === 'string')
  if (data && typeof data === 'object') {
    const entries = Object.entries(data) as [string, unknown][]
    const numericKeys = entries.filter(([k]) => !isNaN(Number(k))).length
    const tokenFirst = numericKeys < entries.length / 2
    const out: string[] = []
    for (const [a, b] of entries) {
      if (tokenFirst && typeof b === 'number' && typeof a === 'string') out[Number(b)] = a
      else if (!tokenFirst && typeof b === 'string' && !isNaN(Number(a))) out[Number(a)] = b
    }
    return out
  }
  return []
}

export interface FunasrDirFiles {
  yamlText: string
  mvnText: string | null
  tokensText: string
}

export function buildFunasrOnlineConfig(files: FunasrDirFiles, chunkSize: [number, number, number] = [5, 10, 5]): FunasrOnlineModelConfig {
  const d = parseFunasrConfigYaml(files.yamlText)
  const mvn = files.mvnText ? parseAmMvn(files.mvnText) : null
  const vocab = parseTokensJson(files.tokensText)
  return {
    fs: d.fs,
    frameLengthMs: d.frameLengthMs,
    frameShiftMs: d.frameShiftMs,
    nMels: d.nMels,
    lfrM: d.lfrM,
    lfrN: d.lfrN,
    lowFreq: d.lowFreq,
    highFreq: d.highFreq,
    cmvnShift: mvn ? mvn.shift : null,
    cmvnScale: mvn ? mvn.scale : null,
    encoderOutputSize: d.encoderOutputSize,
    fsmnLayers: d.fsmnLayers,
    fsmnLorder: d.fsmnLorder,
    cifThreshold: d.cifThreshold,
    tailThreshold: d.tailThreshold,
    vocab,
    chunkSize
  }
}
