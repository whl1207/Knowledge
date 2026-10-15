/**
 * voiceTargetCore.ts — 全局语音输入落点的**纯逻辑**（不碰 DOM、不引任何 UI / 编辑器依赖）
 *
 * 从 voiceTarget.ts 拆出来的原因：那边为了支持代码编辑器会动态 import monaco-editor，
 * 而自测（scripts/run-selftests.mjs，esbuild 打 node 包）不该被编辑器依赖拖进来。
 * 这里只放「谁能当落点」和「一句话写进去时的文本规则」，两边共用同一份实现。
 */

/** 可输入元素的「形状」描述：由 voiceTarget.readEditableDescriptor 从真实 DOM 上读出来 */
export interface EditableDescriptor {
  /** 大写标签名：INPUT / TEXTAREA / 其它 */
  tagName: string
  isContentEditable?: boolean
  /** INPUT 的 type（小写） */
  inputType?: string
  readOnly?: boolean
  disabled?: boolean
  /** 焦点在该元素的祖先 .monaco-editor 里（monaco 的是隐藏 textarea，不能按文本插入） */
  insideMonaco?: boolean
  /** 焦点在其它「代理输入框」里（xterm 等：同样是隐藏 textarea，不能当落点） */
  insideProxyEditor?: boolean
  /** 元素有布局盒（v-show / display:none 隐藏时没有，隐藏元素不能当落点） */
  hasLayout?: boolean
  /** 祖先上有 aria-hidden="true" */
  ariaHidden?: boolean
  /** 落点兜底名（读不到 placeholder / aria-label 时用），由调用方按语言选择 */
  kind: 'input' | 'textarea' | 'editable'
}

/** 这些 INPUT type 不是「打字」控件：语音结果没有可插入的位置 */
export const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden',
])

/** 焦点所在元素是不是「可以用语音往里写字」的落点 */
export function isVoiceEditable(d: EditableDescriptor): boolean {
  if (!d || d.disabled || d.ariaHidden) return false
  if (d.insideMonaco || d.insideProxyEditor) return false
  if (d.hasLayout === false) return false
  if (d.tagName === 'INPUT') {
    if (d.readOnly) return false
    return !NON_TEXT_INPUT_TYPES.has(String(d.inputType || 'text').toLowerCase())
  }
  if (d.tagName === 'TEXTAREA') return !d.readOnly
  return !!d.isContentEditable
}

/** ASCII 字母 / 数字：只有两侧都是 ASCII 词字符时才需要补空格（中文之间不补） */
export function isAsciiWordChar(ch: string): boolean {
  return !!ch && /[0-9A-Za-z]/.test(ch)
}

/**
 * 一句话最终写进输入框时的文本规则：
 * 光标前是 ASCII 词字符（如 `hello`）时补一个前导空格；文本以 ASCII 词字符结尾时补一个尾随空格，
 * 这样连续两句英文不会粘成一个词，而中文（「今天天气」+「不错」）不会被塞进多余空格。
 */
export function speechInsertText(text: string, beforeChar = ''): string {
  const raw = String(text ?? '')
  if (!raw) return ''
  const head = isAsciiWordChar(raw[0]) && isAsciiWordChar(beforeChar) ? ' ' : ''
  const last = raw[raw.length - 1]
  const tail = raw.endsWith('\n') || raw.endsWith(' ') || !isAsciiWordChar(last) ? '' : ' '
  return head + raw + tail
}
