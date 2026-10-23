/**
 * shortcuts.ts — 插件快捷键服务（P2 服务化）
 *
 * 让插件注册全局快捷键：`ctx.shortcuts.register('Ctrl+Shift+K', fn, { descriptionZh: '…' })`。
 *
 * 设计取舍：
 * - **单一监听器**：整个应用只在 window 上装一个 keydown 监听（插件的每条绑定不各自添加监听），
 *   符合「注册即副作用、卸载即撤销」且不会因插件多开造成监听器泄漏；
 * - **不在输入区抢键**：焦点在 input / textarea / select / contenteditable 时默认跳过
 *   （`allowInInput: true` 可覆盖），避免插件键位打断用户打字；
 * - **组合键语义**：`Mod` = Windows/Linux 的 Ctrl、macOS 的 Cmd（平台判定由宿主注入）；
 * - 纯逻辑（解析 / 匹配 / 格式化）与监听解耦，便于单测与将来换载体。
 */

export interface ParsedBinding {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** 归一化后的主键（小写；单字符或 'escape' / 'f2' / 'arrowup' …） */
  key: string
}

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta' | 'mod'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  mod: 'mod',
  super: 'meta',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  spacebar: ' ',
  del: 'delete',
  ins: 'insert',
  plus: '+',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
}

/**
 * 解析绑定串，如 `Ctrl+Shift+K` / `Mod+/` / `F2` / `Escape`。
 * 无法解析（缺主键 / 只有修饰键）返回 null —— 调用方应显式报错，不做静默降级。
 */
export function parseBinding(binding: string, isMac = false): ParsedBinding | null {
  if (typeof binding !== 'string' || !binding.trim()) return null
  const parts = binding.split('+').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null

  const parsed: ParsedBinding = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]
    const alias = MODIFIER_ALIASES[raw.toLowerCase()]
    const isLast = i === parts.length - 1
    // 修饰键不能出现在末位（`Ctrl+` 这种残缺写法直接判非法）
    if (alias && !isLast) {
      if (alias === 'mod') {
        if (isMac) parsed.meta = true
        else parsed.ctrl = true
      } else {
        parsed[alias] = true
      }
      continue
    }
    if (isLast) {
      // 末位必须是真正的主键：`Ctrl+` / `Ctrl+Shift` 这种残缺写法要判非法，不能把修饰键当主键
      if (MODIFIER_ALIASES[raw.toLowerCase()]) return null
      const key = KEY_ALIASES[raw.toLowerCase()] ?? raw.toLowerCase()
      parsed.key = key
      continue
    }
    return null
  }
  if (!parsed.key) return null
  return parsed
}

/** 键盘事件 → 归一化主键（与 parseBinding 的 key 形式对齐） */
export function normalizeEventKey(event: { key: string }): string {
  const key = String(event?.key ?? '')
  if (key === ' ' || key === 'Spacebar') return ' '
  const lower = key.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

/** 事件是否命中该绑定（修饰键必须精确匹配：多按了 Shift 就不算命中） */
export function matchesKeyboardEvent(
  parsed: ParsedBinding,
  event: { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean },
): boolean {
  if (normalizeEventKey(event) !== parsed.key) return false
  return (
    !!event.ctrlKey === parsed.ctrl &&
    !!event.shiftKey === parsed.shift &&
    !!event.altKey === parsed.alt &&
    !!event.metaKey === parsed.meta
  )
}

/** 绑定串的规范展示形式（大写修饰键 + 主键） */
export function formatBinding(binding: string, isMac = false): string {
  const parsed = parseBinding(binding, isMac)
  if (!parsed) return binding
  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.shift) parts.push('Shift')
  if (parsed.alt) parts.push(isMac ? 'Option' : 'Alt')
  if (parsed.meta) parts.push(isMac ? 'Cmd' : 'Win')
  const key =
    parsed.key.length === 1
      ? parsed.key.toUpperCase()
      : parsed.key
        .replace(/^arrow/, 'Arrow ')
        .replace(/^f(\d+)$/, (m, d: string) => `F${d}`)
        .replace(/^capslock$/, 'CapsLock')
  parts.push(key)
  return parts.join('+')
}

export interface PluginShortcutDefinition {
  /** 绑定串（见 parseBinding） */
  binding: string
  handler: (event: KeyboardEvent) => void
  /** 中文说明（设置页展示；不填则只显示键位） */
  descriptionZh?: string
  descriptionEn?: string
  /** 命中时是否阻止默认行为（默认 true） */
  preventDefault?: boolean
  /** 焦点在输入框时是否仍然触发（默认 false） */
  allowInInput?: boolean
  /** 额外条件：返回 false 则本次不触发（如仅在某面板可见时生效） */
  when?: () => boolean
}

export interface ShortcutRecord {
  owner: string
  binding: string
  display: string
  descriptionZh: string
  descriptionEn: string
}

interface RegisteredShortcut extends ShortcutRecord {
  definition: PluginShortcutDefinition
  parsed: ParsedBinding
}

/** 需要键盘输入的目标元素判定（默认实现：input / textarea / select / contenteditable） */
export function isEditableElement(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const node = el as { tagName?: string; isContentEditable?: boolean }
  const tag = String(node.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return node.isContentEditable === true
}

export interface ShortcutServiceOptions {
  /** 事件源（浏览器传 window） */
  target: { addEventListener: Function; removeEventListener: Function }
  isMac?: boolean
  isEditableTarget?: (target: unknown) => boolean
  onWarning?: (message: string) => void
}

export class PluginShortcutService {
  private records: RegisteredShortcut[] = []
  private listener: ((ev: KeyboardEvent) => void) | null = null
  private readonly isMac: boolean
  private readonly isEditable: (target: unknown) => boolean
  private readonly warn: (message: string) => void

  constructor(private readonly options: ShortcutServiceOptions) {
    this.isMac = !!options.isMac
    this.isEditable = options.isEditableTarget ?? isEditableElement
    this.warn = options.onWarning ?? ((m) => console.warn(m))
  }

  /** 注册一条快捷键；返回 disposer。绑定非法或有冲突时抛错（fail-loud） */
  register(definition: PluginShortcutDefinition, owner: string): () => void {
    const parsed = parseBinding(definition?.binding ?? '', this.isMac)
    if (!parsed) {
      throw new Error(`快捷键绑定非法："${String(definition?.binding)}"（示例：Ctrl+Shift+K / Mod+K / F2）`)
    }
    if (typeof definition.handler !== 'function') throw new Error('快捷键缺少 handler')

    const canonical = formatBinding(definition.binding, this.isMac)
    const conflict = this.records.find((r) => r.display === canonical)
    if (conflict) {
      // 冲突只警告并让先注册者生效：快捷键冲突是常见功能重叠，不值得让插件加载失败
      this.warn(
        `[plugin-shortcuts] 键位冲突：${canonical} 已被 ${conflict.owner} 占用，${owner} 的注册不会生效`,
      )
      return () => {}
    }

    const record: RegisteredShortcut = {
      owner,
      binding: definition.binding,
      display: canonical,
      descriptionZh: definition.descriptionZh ?? '',
      descriptionEn: definition.descriptionEn ?? '',
      definition,
      parsed,
    }
    this.records.push(record)
    this.ensureListener()
    return () => {
      const index = this.records.indexOf(record)
      if (index !== -1) this.records.splice(index, 1)
      if (!this.records.length) this.removeListener()
    }
  }

  /** 已注册快捷键（设置页「插件详情」展示） */
  list(): ShortcutRecord[] {
    return this.records.map((r) => ({
      owner: r.owner,
      binding: r.binding,
      display: r.display,
      descriptionZh: r.descriptionZh,
      descriptionEn: r.descriptionEn,
    }))
  }

  /** 撤销全部注册（渲染层插件运行时销毁时调用） */
  dispose(): void {
    this.records = []
    this.removeListener()
  }

  private ensureListener(): void {
    if (this.listener) return
    this.listener = (ev: KeyboardEvent) => this.handle(ev)
    this.options.target.addEventListener('keydown', this.listener)
  }

  private removeListener(): void {
    if (!this.listener) return
    this.options.target.removeEventListener('keydown', this.listener)
    this.listener = null
  }

  private handle(ev: KeyboardEvent): void {
    if ((ev as { defaultPrevented?: boolean }).defaultPrevented) return
    const inEditable = this.isEditable(ev.target)
    for (const record of this.records.slice()) {
      if (inEditable && !record.definition.allowInInput) continue
      if (!matchesKeyboardEvent(record.parsed, ev)) continue
      try {
        if (record.definition.when && !record.definition.when()) continue
      } catch (e) {
        this.warn(`[plugin-shortcuts] ${record.display} 的 when 抛错（跳过本次）: ${String(e)}`)
        continue
      }
      if (record.definition.preventDefault !== false) ev.preventDefault()
      try {
        record.definition.handler(ev)
      } catch (e) {
        this.warn(`[plugin-shortcuts] ${record.display} 的 handler 抛错: ${String(e)}`)
      }
      return
    }
  }
}
