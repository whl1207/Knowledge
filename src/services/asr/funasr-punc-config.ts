// src/services/asr/funasr-punc-config.ts
// 解析官方 ct-punc（CT-Transformer 标点恢复）ONNX 模型目录里的 config.yaml / tokens.json，
// 产出 FunasrPuncConfig。参考官方 punc_bin.py：
//   scripts/funasr-online-ref/funasr_onnx/punc_bin.py
//
// config.yaml 只需提取 model_conf.punc_list（YAML 序列；inline `[...]` 或 block `- xxx`），
//   官方 punc_list 形如：['<unk>', '_', '，', '。', '？', '、', ...]，可能用 ASCII ',' '?' '.'。
// tokens.json：官方 TokenIDConverter 接收 list（index = id，最后一个作 <unk>）；
//   兼容少数导出为对象 {token: id} 的情况（自动判方向）。

export interface FunasrPuncConfig {
  puncList: string[] // 归一化后的输出字符表（含 <unk>/_/全角标点；ASCII , ? . 已转全角）
  periodIdx: number // puncList 中句号索引（用于超长句逗号强制切句/句末替换）；找不到为 -1
  token2id: Map<string, number>
  unkId: number
}

// YAML 单行 list：punc_list: [<unk>, _, '，', "。"]
// 标点本身可能含逗号（',' 作元素值），因此必须按「引号外逗号」切分。
function splitYamlInlineList(inner: string): string[] {
  const items: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ',') {
      items.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim() || items.length) items.push(cur)
  return items.map(cleanYamlItem).filter((x) => x !== null) as string[]
}

function cleanYamlItem(raw: string): string | null {
  let s = raw.trim()
  // 去掉行内注释
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash).trim()
  if (!s) return null
  // 剥成对引号
  if (s.length >= 2 && ((s[0] === "'" && s[s.length - 1] === "'") || (s[0] === '"' && s[s.length - 1] === '"'))) {
    s = s.slice(1, -1)
  }
  return s || null
}

// 从 config.yaml 提取 punc_list（支持 inline 与 block 两种 YAML 写法）
export function parsePuncListFromYaml(yamlText: string): string[] | null {
  if (!yamlText) return null
  // inline：[...]（可能跨行）
  const inlineRe = /(?:^|\n)\s*punc_list\s*:\s*\[([\s\S]*?)\]/m
  const inlineM = inlineRe.exec(yamlText)
  if (inlineM) return splitYamlInlineList(inlineM[1])
  // block：punc_list: 之后逐行收集 "- xxx" 项，直到遇到非列表项
  const headRe = /(?:^|\n)([ \t]*)punc_list\s*:/
  const headM = headRe.exec(yamlText)
  if (!headM) return null
  const after = yamlText.slice(headM.index + headM[0].length)
  const items: string[] = []
  for (const line of after.split(/\r?\n/)) {
    const itemM = /^([ \t]*)-[ \t]*(.+)$/.exec(line)
    if (!itemM) {
      if (line.trim() === '' || /^[ \t]*#/.test(line)) continue
      break // 非列表项（如下一个 key / 更浅缩进）→ 结束
    }
    const v = cleanYamlItem(itemM[2])
    if (v !== null) items.push(v)
  }
  return items.length ? items : null
}

// punc_list 归一化：与官方 punc_bin.py 一致（',' → '，'、'?' → '？'），
// 另把 '.' 视为句号输出 '。'（兼容 ASCII 版本导出），并记录句号索引。
export function normalizePuncList(raw: string[]): { puncList: string[]; periodIdx: number } {
  const puncList = raw.slice()
  let periodIdx = -1
  for (let i = 0; i < puncList.length; i++) {
    let s = puncList[i]
    if (s === ',') s = '，'
    else if (s === '?') s = '？'
    else if (s === '.') s = '。'
    puncList[i] = s
    if (s === '。') periodIdx = i
  }
  return { puncList, periodIdx }
}

// 解析 tokens.json → token→id 映射 + unkId
export function parsePuncTokens(content: string): { token2id: Map<string, number>; unkId: number } {
  const token2id = new Map<string, number>()
  const data = JSON.parse(content)
  if (Array.isArray(data)) {
    // index = id；最后一个通常是 <unk>/<blank>
    for (let i = 0; i < data.length; i++) {
      if (typeof data[i] === 'string') token2id.set(data[i], i)
    }
  } else if (data && typeof data === 'object') {
    const entries = Object.entries(data) as [string, unknown][]
    const numericKeys = entries.filter(([k]) => !isNaN(Number(k))).length
    const tokenFirst = numericKeys < entries.length / 2
    for (const [a, b] of entries) {
      if (tokenFirst && typeof b === 'number') token2id.set(a, Number(b))
      else if (!tokenFirst && typeof b === 'string' && !isNaN(Number(a))) token2id.set(b, Number(a))
    }
  }
  // unk：优先含 'unk' 的键；次选最后一个；兜底 0
  let unkId = 0
  let lastId = -1
  for (const [tok, id] of token2id) {
    if (/unk/i.test(tok)) { unkId = id; break }
    lastId = id
  }
  if (!token2id.size) return { token2id, unkId: 0 }
  // 数组中最后一个元素 id 最大者即官方 unk（token_list[-1]）
  if (![...token2id.keys()].some((k) => /unk/i.test(k))) {
    unkId = Math.max(...token2id.values())
  }
  return { token2id, unkId: lastId < 0 ? unkId : unkId }
}

export interface FunasrPuncDirFiles {
  yamlText: string
  tokensText: string
}

export function buildFunasrPuncConfig(files: FunasrPuncDirFiles): FunasrPuncConfig {
  const raw = parsePuncListFromYaml(files.yamlText) || ['<unk>', '_', '，', '。', '？', '、']
  const { puncList, periodIdx } = normalizePuncList(raw)
  let tokens: { token2id: Map<string, number>; unkId: number }
  try {
    tokens = parsePuncTokens(files.tokensText)
  } catch (e) {
    tokens = { token2id: new Map(), unkId: 0 }
  }
  return { puncList, periodIdx, token2id: tokens.token2id, unkId: tokens.unkId }
}
