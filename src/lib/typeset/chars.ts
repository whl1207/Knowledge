/**
 * chars.ts — 排版用的字符分类与中文禁则（避头尾）表
 *
 * 只做「是否可断、是否可拉伸」相关的判断，不涉及宽度。
 */

/** 是否 CJK / 全角字符（汉字、假名、全角标点、emoji 等）——这类字符之间可以逐字断行 */
export function isCJK(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (
    (c >= 0x1100 && c <= 0x11ff) || // 韩文字母
    (c >= 0x2e80 && c <= 0x303f) || // 部首扩展 + CJK 符号与标点（、。〈〉《》「」等）
    (c >= 0x3040 && c <= 0x30ff) || // 平假名 / 片假名
    (c >= 0x3130 && c <= 0x318f) || // 韩文兼容字母
    (c >= 0x3400 && c <= 0x4dbf) || // CJK 扩展 A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK 基本区
    (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xac00 && c <= 0xd7af) || // 韩文音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容汉字
    (c >= 0xfe10 && c <= 0xfe4f) || // 竖排标点 / 小写形式
    (c >= 0xff00 && c <= 0xffef) || // 全角字符
    (c >= 0x1f300 && c <= 0x1faff) || // emoji / 符号
    (c >= 0x20000 && c <= 0x3ffff) // CJK 扩展 B 及以上
  )
}

/** 空白（空格 / 制表 / 换行），排版时统一当作「可断可伸的胶」 */
export function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\u00a0'
}

/** 行首禁则：这些字符不能出现在行首（必须跟在上一行末尾） */
export const NO_LINE_START = new Set(
  Array.from(
    '、。，．,.;:!?！？：；）)】］｝〕〉》」』”’"' +
      "'·…—～-‐‑–ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ%‰℃°"
  )
)

/** 行尾禁则：这些字符不能出现在行尾（必须与后面的内容同行） */
export const NO_LINE_END = new Set(Array.from('（(【［｛〔〈《「『“‘'))

/**
 * 两个字之间能否断行。
 * - 行首禁则 / 行尾禁则：直接不允许（DP 会自动把断点挪到邻近位置，等价于「追出 / 追入」）
 * - 连续标点之间允不允许？允许，交给 penalty 控制
 */
export function canBreakBetween(prev: string, next: string): boolean {
  if (!prev || !next) return false
  if (NO_LINE_START.has(next)) return false
  if (NO_LINE_END.has(prev)) return false
  return true
}

/** 该边界是否适合拉伸（标点前后不留空隙：中文行内加空隙应在汉字之间） */
export function stretchableAt(prev: string, next: string): boolean {
  if (!prev || !next) return false
  if (NO_LINE_START.has(next) || NO_LINE_END.has(prev)) return false
  // 标点（含西文标点）附近不拉伸
  if (/[，。、；：！？（）【】《》「」『』〔〕]/.test(prev) || /[，。、；：！？（）【】《》「」『』〔〕]/.test(next)) return false
  return true
}
