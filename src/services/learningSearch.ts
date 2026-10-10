/**
 * 学习模块 · 本地关键词检索兜底（无可用嵌入模型时的降级检索）
 *
 * 背景：答疑/图解讲解依赖 .kb 检索，而检索要先做向量化（嵌入模型）。当当前模型来源没有
 * 可用的嵌入模型时（例如 LM Studio 只加载了对话模型、Ollama 没装嵌入模型），
 * retrieveKnowledge 会直接抛错（如 HTTP 400 No models loaded），导致答疑整体不可用。
 *
 * 这里提供一个**不依赖任何模型**的中文友好检索，用于降级：
 * - 分词：拉丁词 / 数字按 run 切分；CJK 连续串切成二元组（中文无空格，二元组召回更稳）
 * - 打分：BM25（k1=1.5，b=0.75），再按最大分归一化到 0..1
 * - 只返回得分 > 0 的切片，最多 topK 条
 */
export interface KeywordHit {
  label: string
  content: string
  similarity: number
}

/** 轻量分词（拉丁词 + CJK 二元组；仅供本地兜底打分用，不求语言学正确） */
export function tokenizeForSearch(text: string): string[] {
  const out: string[] = []
  const s = String(text || '').toLowerCase()
  const re = /[a-z0-9_]+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const seg = m[0]
    if (/^[a-z0-9_]+$/.test(seg)) {
      out.push(seg)
      continue
    }
    if (seg.length === 1) out.push(seg)
    else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
  }
  return out
}

/**
 * 关键词兜底检索：返回按 BM25 归一化得分排序的切片（得分 > 0 才有结果）。
 * blocks 传 `{ label, content }` 即可（学习模块里 content 取切片正文 b.A）。
 */
export function keywordSearchBlocks(
  query: string,
  blocks: Array<{ label?: string; content: string }>,
  topK = 5
): KeywordHit[] {
  const qTokens = [...new Set(tokenizeForSearch(query))]
  if (!qTokens.length || !blocks.length) return []
  const docs = blocks.map(b => String(b?.content || ''))
  const docTokens = docs.map(tokenizeForSearch)
  const N = docs.length
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / (N || 1)
  if (!avgLen) return []

  const df = new Map<string, number>()
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1)
  }

  const K1 = 1.5
  const B = 0.75
  const scores = docTokens.map(toks => {
    if (!toks.length) return 0
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    let score = 0
    for (const q of qTokens) {
      const f = tf.get(q)
      if (!f) continue
      const n = df.get(q) || 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * toks.length) / avgLen))
    }
    return score
  })

  const max = Math.max(...scores, 0)
  if (max <= 0) return []
  const hits: KeywordHit[] = []
  for (let i = 0; i < N; i++) {
    if (scores[i] <= 0) continue
    hits.push({ label: String(blocks[i]?.label || ''), content: docs[i], similarity: scores[i] / max })
  }
  hits.sort((x, y) => y.similarity - x.similarity)
  return hits.slice(0, Math.max(1, topK))
}
