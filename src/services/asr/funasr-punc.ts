// src/services/asr/funasr-punc.ts
// FunASR 官方 ct-punc（CT-Transformer 标点恢复）离线运行时的 TypeScript 移植。
// 参考：scripts/funasr-online-ref/funasr_onnx/punc_bin.py 的 CT_Transformer（非实时版）
//       + utils/utils.py 的 code_mix_split_words / split_to_mini_sentence
//
// 设计：纯算法、与 UI / onnxruntime-web 解耦。文本分批推理经注入接口 FunasrPuncInference 完成
// （由 funasr-punc-ipc.ts 用 asr-onnx-worker 的 init-punc / run-punc 协议实现）。
//
// 语义 = 官方离线补标点：输入无标点文本 → 分词 → mini_sentence 分批（split_size=20）
//   → 每批 CT-Transformer 预测逐词标点标签（argmax）→ 句间缓存（未到句号/问号的尾部留到下批）
//   → 拼接出带标点文本，句末补/换句号。

import type { FunasrPuncConfig } from '@/services/asr/funasr-punc-config'

export interface FunasrPuncInference {
  // 输入整段 token id（int32），返回逐 token 标点 logits（行主序：L * numPunc）
  runText(ids: Int32Array): Promise<Float32Array>
}

const MINI_LIMIT = 20 // split_size
const CACHE_POP_LIMIT = 200 // cache_pop_trigger_limit

// 是否以 ASCII（单字节）字符开头——决定中英混排是否补空格（与官方 len(x.encode())==1 一致）
function isAsciiChar(ch: string): boolean {
  return ch.charCodeAt(0) < 128
}

// 官方 code_mix_split_words：按空白切段，段内 ASCII 连续拼成整词，中文逐字成词
export function codeMixSplitWords(text: string): string[] {
  const words: string[] = []
  for (const seg of text.split(/\s+/)) {
    if (!seg) continue
    let cur = ''
    for (const c of seg) {
      if (isAsciiChar(c)) cur += c
      else {
        if (cur) { words.push(cur); cur = '' }
        words.push(c)
      }
    }
    if (cur) words.push(cur)
  }
  return words
}

// 官方 split_to_mini_sentence：把词列表切成 ≤ limit 的小句（不整除时余量成最后一块）
export function splitToMiniSentence<T>(list: T[], limit: number = MINI_LIMIT): T[][] {
  if (limit <= 1) return [list.slice()]
  if (list.length <= limit) return [list]
  const out: T[][] = []
  const full = Math.floor(list.length / limit)
  for (let i = 0; i < full; i++) out.push(list.slice(i * limit, (i + 1) * limit))
  const rem = list.length % limit
  if (rem > 0) out.push(list.slice(full * limit))
  return out
}

// 纯算法引擎：注入配置与推理实现后即可对一段无标点文本补标点
export class FunasrPuncEngine {
  private cfg: FunasrPuncConfig
  private inf: FunasrPuncInference

  constructor(cfg: FunasrPuncConfig, inf: FunasrPuncInference) {
    this.cfg = cfg
    this.inf = inf
  }

  private puncCharOf(idx: number): string {
    const s = this.cfg.puncList[idx]
    if (!s || s === '_' || s === '<unk>') return ''
    return s
  }

  // 逐块拼装：把某块（可能已被 cache 截断）的词 + 标点追加到 out；词间 ASCII 相邻补空格
  private appendBlock(out: string[], words: string[], puncIdx: number[]): void {
    const { puncList } = this.cfg
    for (let k = 0; k < words.length; k++) {
      const w = words[k]
      if (k > 0 && isAsciiChar(w[0]) && isAsciiChar(words[k - 1][0])) out.push(' ' + w)
      else out.push(w)
      const c = puncList[puncIdx[k]]
      if (c && c !== '_' && c !== '<unk>') out.push(c)
    }
  }

  // 对一段（无标点）文本补标点；失败/空输入原样返回
  async punctuate(text: string): Promise<string> {
    if (!text) return text
    const { cfg, inf } = this
    const words = codeMixSplitWords(text)
    if (!words.length) return text
    const ids = words.map((w) => cfg.token2id.get(w) ?? cfg.unkId)

    const wordBatches = splitToMiniSentence(words, MINI_LIMIT)
    const idBatches = splitToMiniSentence(ids, MINI_LIMIT)
    let cacheWords: string[] = []
    let cacheIds: number[] = []
    const out: string[] = []

    for (let bi = 0; bi < wordBatches.length; bi++) {
      const curWords = wordBatches[bi]
      const curIds = idBatches[bi]
      const miniWords = cacheWords.concat(curWords)
      const miniIds = cacheIds.concat(curIds)

      const logits = await inf.runText(Int32Array.from(miniIds))
      const L = miniWords.length
      const numPunc = L > 0 ? Math.floor(logits.length / L) : cfg.puncList.length
      // argmax → 每词标点标签
      const punc: number[] = new Array(L)
      for (let r = 0; r < L; r++) {
        let best = 0
        let bestV = -Infinity
        const base = r * numPunc
        for (let c = 0; c < numPunc; c++) {
          const v = logits[base + c]
          if (v > bestV) { bestV = v; best = c }
        }
        punc[r] = best
      }

      let cut = L
      if (bi < wordBatches.length - 1) {
        // 从后往前找最后一个 。/？（作为本块已稳定的部分）；否则超长句找逗号强制切
        let sentenceEnd = -1
        let lastComma = -1
        for (let j = L - 2; j >= 1; j--) {
          const c = cfg.puncList[punc[j]]
          if (c === '。' || c === '？') { sentenceEnd = j; break }
          if (lastComma < 0 && c === '，') lastComma = j
        }
        if (sentenceEnd < 0 && L > CACHE_POP_LIMIT && lastComma >= 0 && cfg.periodIdx >= 0) {
          sentenceEnd = lastComma
          punc[sentenceEnd] = cfg.periodIdx
        }
        cut = sentenceEnd + 1
        cacheWords = miniWords.slice(cut)
        cacheIds = miniIds.slice(cut)
        this.appendBlock(out, miniWords.slice(0, cut), punc.slice(0, cut))
      } else {
        this.appendBlock(out, miniWords, punc)
      }
    }

    let result = out.join('')
    if (!result) return text
    // 句末处理（官方）：末尾为 ，/、 → 换 。；非 。/？ 结尾 → 补 。
    if (result.endsWith('，') || result.endsWith('、')) result = result.slice(0, -1) + '。'
    else if (!result.endsWith('。') && !result.endsWith('？') && !result.endsWith('！')) result += '。'
    return result
  }
}
