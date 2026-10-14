/**
 * kbSliceSearch.ts — 切片页搜索的关键字匹配（label / 正文 / 文件路径 / 关联问题）
 *
 * 性能要点：切片的正文（A）通常很长，而「切片页搜索」是一个字符一个字符即时过滤全库切片的。
 * 如果每次输入都对每段正文重新 toLowerCase()，时间会随「切片数 × 正文长度」线性放大，
 * 大库上打字会明显发卡。这里按切片对象（WeakMap，不阻止 GC）缓存一次小写文本，
 * 之后每次输入只做 includes 比较。
 */
interface LoweredSlice {
  label: string
  a: string
  path: string
  q: string
}

const lowerCache = new WeakMap<object, LoweredSlice>()

const lowerOf = (block: any): LoweredSlice => {
  let cached = lowerCache.get(block)
  if (!cached) {
    cached = {
      label: String(block?.label ?? '').toLowerCase(),
      a: String(block?.A ?? '').toLowerCase(),
      path: String(block?.filePath ?? '').toLowerCase(),
      // 与旧逻辑一致：「问题未推理」占位不算作可搜索内容
      q: (block?.Q && block.Q !== '问题未推理') ? String(block.Q).toLowerCase() : '',
    }
    lowerCache.set(block, cached)
  }
  return cached
}

/** 关键字是否命中该切片；kwLower 需已 trim + toLowerCase（空串视为全部命中） */
export const matchSliceKeyword = (block: any, kwLower: string): boolean => {
  if (!kwLower) return true
  const t = lowerOf(block)
  return t.label.includes(kwLower) || t.a.includes(kwLower) || t.path.includes(kwLower) || (t.q ? t.q.includes(kwLower) : false)
}
