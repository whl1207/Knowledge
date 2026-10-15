/**
 * voiceTarget.ts — 全局语音输入的「落点」：现在光标在哪个可输入元素里，识别结果就写进哪个元素。
 *
 * 为什么单独抽一层（而不是各模块各写一遍）：
 *   应用里能用语音输入的地方很多（聊天输入框、搜索框、设置里的各种字段、块编辑器的源码 textarea、
 *   代码编辑器 monaco…）。如果每处都自己接一遍 ASR，就会出现「有的地方能输入、有的地方不能」、
 *   快捷键归属互相打架、提示样式各不相同。这里把它收敛成**一份判断 + 一份插入逻辑**：
 *     · 谁能当落点（isVoiceEditable：可见的 input / textarea / contenteditable）；
 *     · 落点叫什么（给浮层显示「正在输入到：搜索框」）；
 *     · 怎么把一句话写进去（insertVoiceText：execCommand 保撤销 + 兜底 setRangeText）；
 *     · 代码编辑器例外（焦点是其隐藏 textarea）→ monaco 分支走编辑器 API。
 *   「谁算可输入元素」「一句话怎么补空格」两条纯逻辑在 voiceTargetCore.ts（可跑自测，不引编辑器依赖）。
 */
import {
  isVoiceEditable,
  speechInsertText,
  type EditableDescriptor,
} from './voiceTargetCore'

export { isVoiceEditable, speechInsertText } from './voiceTargetCore'
export type { EditableDescriptor } from './voiceTargetCore'

const MONACO_SELECTOR = '.monaco-editor'
/** 其它把真实输入藏在隐藏 textarea 后面的控件（终端等）：不能按文本插入，交给调用方兜底 */
const PROXY_EDITOR_SELECTOR = '.xterm'

/** 从真实 DOM 读出「形状描述」（唯一读 DOM 的地方，其余判断都是纯函数） */
export function readEditableDescriptor(el: Element | null): EditableDescriptor | null {
  if (!el || typeof (el as HTMLElement).tagName !== 'string') return null
  const node = el as HTMLElement
  const input = node as HTMLInputElement
  const tagName = node.tagName.toUpperCase()
  const closest = typeof node.closest === 'function' ? (sel: string) => node.closest(sel) : () => null
  const ariaHidden = !!closest('[aria-hidden="true"]')
  const hasLayout = typeof node.getClientRects === 'function'
    ? node.getClientRects().length > 0 || node.offsetWidth > 0 || node.offsetHeight > 0
    : true
  return {
    tagName,
    isContentEditable: !!(node as any).isContentEditable,
    inputType: tagName === 'INPUT' ? String(input.type || 'text').toLowerCase() : undefined,
    readOnly: tagName === 'INPUT' ? !!input.readOnly : tagName === 'TEXTAREA' ? !!(node as HTMLTextAreaElement).readOnly : undefined,
    disabled: tagName === 'INPUT' ? !!input.disabled : tagName === 'TEXTAREA' ? !!(node as HTMLTextAreaElement).disabled : undefined,
    // 只有 monaco 的**隐藏 textarea**（编辑器真正接键的那一个）算「代理输入框」：
    // 往它里面写值不会进编辑器，必须走编辑器 API。编辑器里的查找框等真实 input 不算。
    insideMonaco: tagName === 'TEXTAREA' && !!closest(MONACO_SELECTOR),
    insideProxyEditor: !!closest(PROXY_EDITOR_SELECTOR),
    hasLayout,
    ariaHidden,
    kind: tagName === 'INPUT' ? 'input' : tagName === 'TEXTAREA' ? 'textarea' : 'editable',
  }
}

/** 落点描述（给浮层显示「正在输入到：xxx」） */
export interface VoiceTarget {
  /** dom：普通可输入元素；monaco：代码编辑器（焦点是它的隐藏 textarea，只能走编辑器 API） */
  kind: 'dom' | 'monaco'
  /** dom = 真实输入元素本身；monaco = .monaco-editor 根节点 */
  el: HTMLElement
  /** 展示名（placeholder / aria-label / 本地化的兜底名） */
  label: string
}

/** 最近一次「有布局的可输入元素」：焦点临时跑到按钮 / 空白处（body）时仍能接着上一次的位置输入 */
let lastEditable: HTMLElement | null = null
let listenerInstalled = false

/** 记下一个候选落点（只有真的是可输入元素才记） */
function noteEditable(el: Element | null): void {
  const desc = readEditableDescriptor(el)
  if (desc && isVoiceEditable(desc)) lastEditable = el as HTMLElement
}

/** 装上「记住最近可输入元素」的监听（整个应用只需要一次，重复调用无副作用） */
export function installVoiceTargetTracking(): void {
  if (listenerInstalled || typeof document === 'undefined') return
  listenerInstalled = true
  // focusin 冒泡（捕获阶段）拿到最终获得焦点的元素；mousedown 用事件目标兜底
  // （点进 contenteditable 等场景，焦点变化与鼠标事件顺序在个别控件上不一致）
  document.addEventListener('focusin', onDocumentFocusIn, true)
  document.addEventListener('mousedown', onDocumentMouseDown, true)
}

function onDocumentFocusIn(): void {
  noteEditable(document.activeElement)
}

function onDocumentMouseDown(e: MouseEvent): void {
  noteEditable(e.target as Element | null)
}

export function resetVoiceTargetTracking(): void {
  if (!listenerInstalled || typeof document === 'undefined') return
  listenerInstalled = false
  document.removeEventListener('focusin', onDocumentFocusIn, true)
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  lastEditable = null
}

/** 读一个元素的展示名：优先 placeholder / aria-label / title / 关联 label，其次是本地化兜底名 */
function describeTarget(el: HTMLElement, zh: boolean): string {
  const attr = (name: string) => el.getAttribute(name) || ''
  const id = el.getAttribute('id')
  let labelText = ''
  if (id && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    try {
      labelText = (document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLElement | null)?.innerText || ''
    } catch { labelText = '' }
  }
  const raw = (attr('placeholder') || attr('aria-label') || attr('title') || labelText || '').trim()
  if (raw) return raw.length > 20 ? `${raw.slice(0, 20)}…` : raw
  const desc = readEditableDescriptor(el)
  const kind = desc?.kind ?? 'input'
  if (zh) return kind === 'textarea' ? '文本框' : kind === 'editable' ? '编辑区' : '输入框'
  return kind === 'textarea' ? 'text area' : kind === 'editable' ? 'editable area' : 'text field'
}

/**
 * 解析本次语音的落点（录音开始时调用一次并锁定：录音中焦点再跑掉也不影响结果落点）：
 *   1. 焦点在 monaco 里 → 代码编辑器分支；
 *   2. 焦点本身是可输入元素 → 直接用它；
 *   3. 焦点在按钮 / 空白处 → 退回「最近一次可输入元素」（仍然挂在文档里时）。
 * 都没有则返回 null（由控制器兜底：结果复制到剪贴板并提示）。
 */
export function resolveVoiceTarget(zh: boolean): VoiceTarget | null {
  if (typeof document === 'undefined') return null
  const active = (document.activeElement as HTMLElement | null) ?? null
  const activeDesc = readEditableDescriptor(active)
  // 1. 焦点本身是可输入元素（含 monaco 编辑器里的查找框等真实输入框）→ 直接用它
  if (active && activeDesc && isVoiceEditable(activeDesc)) {
    return { kind: 'dom', el: active, label: describeTarget(active, zh) }
  }
  // 2. 焦点在代码编辑器里（拿到的是它的隐藏 textarea）→ 交给 monaco 分支
  const monacoRoot = active?.closest?.('.monaco-editor') as HTMLElement | null
  if (monacoRoot) return { kind: 'monaco', el: monacoRoot, label: zh ? '代码编辑器' : 'Code editor' }
  // 3. 焦点在终端等代理输入框 / 内嵌文档（drawio 那类 iframe）里：
  //    既写不进去，也不该退回别的输入框（否则字会悄悄跑到别处）→ 交给剪贴板兜底
  if (activeDesc?.insideProxyEditor) return null
  const tag = active?.tagName?.toUpperCase?.() || ''
  if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') return null
  // 4. 焦点在按钮 / 空白处 → 退回「最近一次可输入元素」（仍然挂在文档里时）
  if (lastEditable && lastEditable.isConnected) {
    const lastDesc = readEditableDescriptor(lastEditable)
    if (lastDesc && isVoiceEditable(lastDesc)) {
      return { kind: 'dom', el: lastEditable, label: describeTarget(lastEditable, zh) }
    }
  }
  return null
}

/** 光标前一个字符（用于 speechInsertText 判断要不要补空格） */
function charBeforeCaret(el: HTMLElement): string {
  const node = el as HTMLInputElement | HTMLTextAreaElement
  if (typeof node.selectionStart === 'number') {
    const pos = node.selectionStart
    return pos > 0 ? String(node.value ?? '')[pos - 1] ?? '' : ''
  }
  const sel = window.getSelection()
  const anchor = sel?.anchorNode
  if (anchor && anchor.nodeType === Node.TEXT_NODE) {
    const text = anchor.textContent ?? ''
    const off = sel!.anchorOffset
    return off > 0 ? text[off - 1] ?? '' : ''
  }
  return ''
}

/** 内容可编辑区：先试 execCommand（保留撤销栈），失败再用 Range 兜底 */
function insertIntoContentEditable(el: HTMLElement, text: string): boolean {
  el.focus({ preventScroll: true } as FocusOptions)
  const before = el.textContent ?? ''
  try {
    if (document.execCommand('insertText', false, text)) {
      if ((el.textContent ?? '') !== before) return true
    }
  } catch { /* 兜底路径见下 */ }
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  } catch {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return true
}

/** input / textarea：先试 execCommand（Chromium 下可撤销且会派发 input，v-model 与各组件都能收到） */
function insertIntoField(el: HTMLInputElement | HTMLTextAreaElement, text: string): boolean {
  el.focus({ preventScroll: true } as FocusOptions)
  const before = String(el.value ?? '')
  try {
    if (document.execCommand('insertText', false, text)) {
      // execCommand 对 number / date 等类型会「成功但不写入」：用值是否变化来判定
      if (String(el.value ?? '') !== before) return true
    }
  } catch { /* 兜底路径见下 */ }
  const start = el.selectionStart ?? before.length
  const end = el.selectionEnd ?? start
  try {
    el.setRangeText(text, start, end, 'end')
  } catch {
    el.value = before.slice(0, start) + text + before.slice(end)
    try { el.setSelectionRange(start + text.length, start + text.length) } catch { /* 部分类型不支持选区 */ }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  // 值真的变了才算写入成功：number / date 这类输入框会「接受事件但拒绝文字」，
  // 那种情况返回 false，由控制器兜底复制到剪贴板，而不是假装已输入
  return String(el.value ?? '') !== before
}

/**
 * 代码编辑器（monaco）分支：焦点在它的隐藏 textarea 上，不能按文本插入。
 * 用 monaco 自己的编辑器实例在**当前选区**执行编辑（保撤销栈），
 * 与编辑器内的「语音输入」按钮（Edit_Code）走同一条 API，落点自然一致。
 */
async function insertIntoMonaco(root: HTMLElement, text: string): Promise<boolean> {
  try {
    const monaco = await import('monaco-editor')
    const editors = ((monaco.editor as any).getEditors?.() ?? []) as any[]
    const editor = editors.find((e) => e?.getDomNode?.()?.contains(root))
    if (!editor) return false
    // 只读编辑器（含 diff 的原始页）不写
    if (editor.getOption?.(monaco.editor.EditorOption.readOnly)) return false
    const model = editor.getModel?.()
    const selection = editor.getSelection?.()
    if (!model || !selection) return false
    const beforeChar = selection.startColumn > 1
      ? model.getValueInRange({
          startLineNumber: selection.startLineNumber,
          startColumn: selection.startColumn - 1,
          endLineNumber: selection.startLineNumber,
          endColumn: selection.startColumn,
        })
      : ''
    editor.pushUndoStop?.()
    editor.executeEdits('voice-input', [
      { range: selection, text: speechInsertText(text, beforeChar), forceMoveMarkers: true },
    ])
    editor.pushUndoStop?.()
    editor.focus?.()
    return true
  } catch {
    return false
  }
}

/** 把一段识别结果写进落点；返回是否真的写入（false 时由控制器复制到剪贴板并提示） */
export async function insertVoiceText(target: VoiceTarget, text: string): Promise<boolean> {
  const raw = String(text ?? '')
  if (!raw || !target?.el?.isConnected) return false
  if (target.kind === 'monaco') return insertIntoMonaco(target.el, raw)
  const el = target.el
  const value = speechInsertText(raw, charBeforeCaret(el))
  if (el.isContentEditable) return insertIntoContentEditable(el, value)
  return insertIntoField(el as HTMLInputElement, value)
}
