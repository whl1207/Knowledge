/**
 * actions.ts — 元素解析 + 可操作性检查 + 可信输入（CDP Input.*）
 *
 * 与 P0 的 `el.click()` 相比，这里全部走浏览器输入管线（isTrusted=true）：
 * - 先 scrollIntoView，再用 getBoundingClientRect 算视口坐标；
 * - 可见/禁用/hit-target（elementFromPoint）检查，失败给出可操作原因；
 * - click 派发 mouseMoved → mousePressed → mouseReleased；
 * - fill 用 focus + select + Input.insertText；press 用 dispatchKeyEvent；
 * - 每个动作返回轻量 receipt（url/title/读回值）。
 */
import type { CdpSession } from './cdp'
import type { RefEntry } from './snapshot'

export interface ActionTarget {
  ref?: string | number
  selector?: string
  text?: string
  index?: number
}

export interface ActionReceipt {
  ok: true
  action: string
  url: string
  title: string
  detail: string
}

export class BrowserActionError extends Error {
  code: 'STALE_REF' | 'NOT_FOUND' | 'NOT_VISIBLE' | 'DISABLED' | 'OCCLUDED' | 'NOT_EDITABLE' | 'BAD_ARGUMENT'
  hint?: string
  constructor(code: BrowserActionError['code'], message: string, hint?: string) {
    super(message)
    this.name = 'BrowserActionError'
    this.code = code
    this.hint = hint
  }
}

interface Resolved {
  backendNodeId: number
  objectId: string
  label: string
}

interface Probe {
  visible: boolean
  disabled: boolean
  cx: number
  cy: number
  width: number
  height: number
  tag: string
  text: string
  hitTag?: string
  hitText?: string
  contains: boolean
  vw?: number
  vh?: number
}

const PROBE_FN = `function () {
  const el = this;
  if (!(el instanceof Element)) return { visible: false, disabled: false, cx: 0, cy: 0, width: 0, height: 0, tag: '', text: '', contains: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
  // 点击点取「元素矩形 ∩ 视口」的中心：大元素/半屏元素也能点到实际可见部分
  const ix1 = Math.max(0, r.left), iy1 = Math.max(0, r.top);
  const ix2 = Math.min(window.innerWidth, r.right), iy2 = Math.min(window.innerHeight, r.bottom);
  const cx = (ix1 + ix2) / 2, cy = (iy1 + iy2) / 2;
  const hit = document.elementFromPoint(cx, cy);
  const contains = !!(hit && (el === hit || el.contains(hit) || hit.contains(el)));
  return {
    visible, disabled, cx, cy, width: r.width, height: r.height,
    tag: el.tagName || '', text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80),
    hitTag: hit ? hit.tagName : '', hitText: hit ? String(hit.innerText || '').slice(0, 60) : '',
    contains, vw: window.innerWidth, vh: window.innerHeight,
  };
}`

export interface ResolveOptions {
  /** ref 失效时（页面 DOM 变化但未导航）重新快照，并按 role+name 找回同一节点后重试一次 */
  refresh?: () => Promise<Map<number, RefEntry>>
}

export async function clickElement(cdp: CdpSession, refs: Map<number, RefEntry>, target: ActionTarget, opts: { button?: string; clickCount?: number } = {}, resolveOpts?: ResolveOptions): Promise<ActionReceipt> {
  const resolved = await resolveElement(cdp, refs, target, resolveOpts)
  const probe = await inspect(cdp, resolved)
  assertActionable(probe, resolved)
  const button = normalizeButton(opts.button)
  const clickCount = opts.clickCount === 2 ? 2 : 1
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.cx, y: probe.cy, button: 'none' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.cx, y: probe.cy, button, clickCount })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.cx, y: probe.cy, button, clickCount })
  return await receipt(cdp, 'click', `已点击 ${resolved.label}${probe.text ? `（${probe.text}）` : ''}`)
}

export async function hoverElement(cdp: CdpSession, refs: Map<number, RefEntry>, target: ActionTarget, resolveOpts?: ResolveOptions): Promise<ActionReceipt> {
  const resolved = await resolveElement(cdp, refs, target, resolveOpts)
  const probe = await inspect(cdp, resolved)
  assertActionable(probe, resolved)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.cx, y: probe.cy, button: 'none' })
  await sleep(120)
  return await receipt(cdp, 'hover', `已悬停 ${resolved.label}`)
}

export async function fillElement(cdp: CdpSession, refs: Map<number, RefEntry>, target: ActionTarget, text: string, opts: { clear?: boolean } = {}, resolveOpts?: ResolveOptions): Promise<ActionReceipt> {
  const resolved = await resolveElement(cdp, refs, target, resolveOpts)
  const probe = await inspect(cdp, resolved)
  assertActionable(probe, resolved)
  // <select> 没有可编辑文本：按 value/label 选中（与 browser_select 同语义）
  if (String(probe.tag || '').toUpperCase() === 'SELECT') {
    const res = await cdp.send<any>('Runtime.callFunctionOn', {
      objectId: resolved.objectId,
      returnByValue: true,
      functionDeclaration: `function (want) {
        const el = this;
        const opts = Array.from(el.options || []);
        const opt = opts.find(o => o.value === want) || opts.find(o => o.label === want || o.text === want);
        if (!opt) return { ok: false };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, label: opt.label, value: opt.value };
      }`,
      arguments: [{ value: text }],
    })
    const v = res?.result?.value
    if (!v?.ok) throw new BrowserActionError('NOT_FOUND', `select 中找不到选项「${text}」`, '用 browser_snapshot 查看 option，或改用 browser_select')
    return await receipt(cdp, 'fill', `已选择 ${resolved.label} → ${v.label || v.value}`)
  }
  const clear = opts.clear !== false
  // 聚焦 + 选中既有内容（clear 时由 insertText 替换选中区；不 clear 时把光标放到末尾）
  await cdp.send('Runtime.callFunctionOn', {
    objectId: resolved.objectId,
    returnByValue: true,
    functionDeclaration: `function (clear) {
      const el = this;
      if (typeof el.focus === 'function') el.focus();
      if (clear) {
        if (el.isContentEditable) {
          const r = document.createRange(); r.selectNodeContents(el);
          const s = window.getSelection(); if (s) { s.removeAllRanges(); s.addRange(r); }
          return 'range';
        }
        if (typeof el.select === 'function') { el.select(); return 'select'; }
        return 'none';
      }
      if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
        const n = el.value.length; try { el.setSelectionRange(n, n) } catch { /* 忽略 */ }
      }
      return 'end';
    }`,
    arguments: [{ value: clear }],
  })
  if (text) await cdp.send('Input.insertText', { text })
  const readback = await readValue(cdp, resolved.objectId)
  return await receipt(cdp, 'fill', `已输入 ${resolved.label}${readback ? `，当前值：${readback}` : ''}`)
}

export async function selectOption(cdp: CdpSession, refs: Map<number, RefEntry>, target: ActionTarget, choice: { value?: string; label?: string; index?: number }, resolveOpts?: ResolveOptions): Promise<ActionReceipt> {
  const resolved = await resolveElement(cdp, refs, target, resolveOpts)
  const probe = await inspect(cdp, resolved)
  assertActionable(probe, resolved)
  const res = await cdp.send<any>('Runtime.callFunctionOn', {
    objectId: resolved.objectId,
    returnByValue: true,
    functionDeclaration: `function (value, label, index) {
      const el = this;
      if (!(el instanceof HTMLSelectElement)) return { ok: false, reason: 'not-select' };
      const opts = Array.from(el.options || []);
      const opt = (typeof index === 'number' && index >= 0) ? opts[index]
        : label ? (opts.find(o => o.label === label || o.text === label))
        : opts.find(o => o.value === value);
      if (!opt) return { ok: false, reason: 'option-not-found', options: opts.slice(0, 20).map(o => ({ value: o.value, label: o.label })) };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value, label: opt.label };
    }`,
    arguments: [{ value: choice.value ?? null }, { value: choice.label ?? null }, { value: typeof choice.index === 'number' ? choice.index : null }],
  })
  const v = res?.result?.value
  if (!v?.ok) {
    throw new BrowserActionError('NOT_FOUND', `选择失败：${v?.reason === 'not-select' ? '目标不是 <select>' : '找不到匹配的选项'}${v?.options ? `，可选：${v.options.map((o: any) => o.label || o.value).join(' / ')}` : ''}`)
  }
  return await receipt(cdp, 'select', `已选择 ${resolved.label} → ${v.label || v.value}`)
}

export async function pressKey(cdp: CdpSession, refs: Map<number, RefEntry>, target: ActionTarget | null, keySpec: string, resolveOpts?: ResolveOptions): Promise<ActionReceipt> {
  if (target && (target.ref !== undefined || target.selector || target.text)) {
    const resolved = await resolveElement(cdp, refs, target, resolveOpts)
    const probe = await inspect(cdp, resolved)
    assertActionable(probe, resolved)
    await cdp.send('Runtime.callFunctionOn', { objectId: resolved.objectId, returnByValue: true, functionDeclaration: 'function(){ if (this.focus) this.focus(); return true; }' })
  }
  const parsed = parseKey(keySpec)
  if (!parsed) throw new BrowserActionError('BAD_ARGUMENT', `不支持的按键：${keySpec}`, '示例：Enter / Tab / Escape / ArrowDown / ControlOrMeta+A / a')
  const base = {
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.vk,
    nativeVirtualKeyCode: parsed.vk,
    modifiers: parsed.modifiers,
  }
  const isPrintable = parsed.text.length > 0 && parsed.modifiers === 0
  if (isPrintable) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: parsed.text, unmodifiedText: parsed.text })
  } else {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  return await receipt(cdp, 'press', `已按键 ${keySpec}`)
}

/** 解析 ref/selector/text → backendNodeId + objectId */
export async function resolveElement(cdp: CdpSession, refs: Map<number, RefEntry>, target: ActionTarget, opts?: ResolveOptions): Promise<Resolved> {
  let backendNodeId: number | undefined
  let label = ''
  let refEntry: RefEntry | undefined

  if (target.ref !== undefined && target.ref !== null && String(target.ref).trim() !== '') {
    const raw = String(target.ref).trim().replace(/^@/, '')
    const n = Number(raw)
    const entry = Number.isFinite(n) ? refs.get(n) : undefined
    if (!entry) {
      throw new BrowserActionError('STALE_REF', `ref @${raw} 已失效（页面变化或还没做过快照）`, '先调用 browser_snapshot，再用新的 ref 操作')
    }
    backendNodeId = entry.backendNodeId
    refEntry = entry
    label = `@${raw} ${entry.role}${entry.name ? ` "${entry.name}"` : ''}`
  } else if (target.selector) {
    const doc = await cdp.send<any>('DOM.getDocument', { depth: 0 })
    const rootNodeId = doc?.root?.nodeId
    if (!rootNodeId) throw new BrowserActionError('NOT_FOUND', '无法访问页面 DOM')
    let nodeId = 0
    if (typeof target.index === 'number' && target.index >= 0) {
      const all = await cdp.send<any>('DOM.querySelectorAll', { nodeId: rootNodeId, selector: target.selector })
      const ids: number[] = Array.isArray(all?.nodeIds) ? all.nodeIds : []
      if (target.index >= ids.length) {
        throw new BrowserActionError('NOT_FOUND', `选择器 ${target.selector} 只匹配到 ${ids.length} 个元素（index=${target.index} 越界）`, '用 browser_snapshot 查看可交互元素，或减小 index')
      }
      nodeId = ids[target.index]
    } else {
      const q = await cdp.send<any>('DOM.querySelector', { nodeId: rootNodeId, selector: target.selector })
      nodeId = Number(q?.nodeId) || 0
    }
    if (!nodeId) {
      throw new BrowserActionError('NOT_FOUND', `未找到元素：${target.selector}`, '先用 browser_snapshot 查看页面可交互元素（CSS 选择器在动态站点上可能失效）')
    }
    const desc = await cdp.send<any>('DOM.describeNode', { nodeId })
    if (!desc?.node?.backendNodeId) throw new BrowserActionError('NOT_FOUND', `无法定位元素：${target.selector}`)
    backendNodeId = Number(desc.node.backendNodeId)
    label = `${desc.node.nodeName || 'element'} ${target.selector}`
  } else if (target.text) {
    const wanted = target.text
    const evalRes = await cdp.send<any>('Runtime.evaluate', {
      expression: `(() => {
        const want = ${JSON.stringify(wanted)}.trim();
        const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('button,a,summary,label,input,textarea,select,[role],[contenteditable="true"]'));
        const exact = candidates.find(el => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title')) === want);
        const partial = candidates.find(el => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title')).includes(want));
        return exact || partial || null;
      })()`,
      returnByValue: false,
    })
    const objectId = evalRes?.result?.objectId
    if (!objectId) throw new BrowserActionError('NOT_FOUND', `页面上找不到文本为「${wanted}」的可操作元素`, '先用 browser_snapshot 确认文本')
    const node = await cdp.send<any>('DOM.requestNode', { objectId })
    if (!node?.nodeId) throw new BrowserActionError('NOT_FOUND', `无法定位「${wanted}」`)
    const desc = await cdp.send<any>('DOM.describeNode', { nodeId: node.nodeId })
    backendNodeId = Number(desc?.node?.backendNodeId)
    label = `文本「${wanted}」`
  } else {
    throw new BrowserActionError('BAD_ARGUMENT', '缺少目标：请提供 ref / selector / text 之一', '推荐先 browser_snapshot，再用 ref 操作')
  }

  let resolvedNode: any
  try {
    resolvedNode = await cdp.send<any>('DOM.resolveNode', { backendNodeId })
  } catch (err) {
    // ref 的 backendNodeId 已随 DOM 更新失效：重新快照，按 role+name 唯一匹配找回同一节点后重试一次
    if (!opts?.refresh || !refEntry) throw err
    const fresh = await opts.refresh()
    const candidates = [...fresh.values()].filter((r) => r.role === refEntry!.role && r.name === refEntry!.name)
    if (candidates.length !== 1) {
      throw new BrowserActionError('STALE_REF', `ref @${refEntry.ref} 已失效，且无法按「${refEntry.role} ${refEntry.name}」唯一定位`, '先 browser_snapshot 查看当前页面，再用新的 ref 操作')
    }
    backendNodeId = candidates[0].backendNodeId
    label = `@${candidates[0].ref} ${candidates[0].role}${candidates[0].name ? ` "${candidates[0].name}"` : ''}（ref 已自动刷新）`
    resolvedNode = await cdp.send<any>('DOM.resolveNode', { backendNodeId })
  }
  const objectId = resolvedNode?.object?.objectId
  if (!objectId) throw new BrowserActionError('NOT_FOUND', `元素已失效：${label}`, '页面可能已变化，重新 browser_snapshot')
  return { backendNodeId: backendNodeId!, objectId, label }
}

/** 滚动到视野内 + 可见/禁用/遮挡检查 */
export async function inspect(cdp: CdpSession, resolved: Resolved): Promise<Probe> {
  try { await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: resolved.backendNodeId }, 8_000) } catch { /* 忽略 */ }
  await sleep(60)
  let probe = await probeElement(cdp, resolved.objectId)
  // 大元素/固定布局下中心点可能仍在视口外：再用元素自身的 scrollIntoView 兜底
  if (probe && (probe.cx < 0 || probe.cy < 0 || probe.cx > (probe.vw || 0) || probe.cy > (probe.vh || 0))) {
    try {
      await cdp.send('Runtime.callFunctionOn', {
        objectId: resolved.objectId,
        returnByValue: true,
        functionDeclaration: 'function(){ try { this.scrollIntoView({ block: "center", inline: "center" }) } catch {} return true; }',
      })
      await sleep(80)
      probe = await probeElement(cdp, resolved.objectId)
    } catch { /* 忽略 */ }
  }
  return probe
}

async function probeElement(cdp: CdpSession, objectId: string): Promise<Probe> {
  const res = await cdp.send<any>('Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: PROBE_FN,
  })
  return res?.result?.value as Probe
}

function assertActionable(probe: Probe, resolved: Resolved): void {
  if (!probe) throw new BrowserActionError('NOT_FOUND', `无法读取元素状态：${resolved.label}`)
  if (!probe.visible) throw new BrowserActionError('NOT_VISIBLE', `元素不可见：${resolved.label}`, '可能被折叠/隐藏，先展开或滚动到该区域')
  if (probe.disabled) throw new BrowserActionError('DISABLED', `元素已禁用：${resolved.label}`)
  if (!probe.contains) {
    throw new BrowserActionError('OCCLUDED', `元素被遮挡：${resolved.label} 的中心点命中了 <${probe.hitTag || '未知'}>${probe.hitText ? `「${probe.hitText}」` : ''}`, '先关闭弹层/等待动画结束再重试')
  }
}

async function receipt(cdp: CdpSession, action: string, detail: string): Promise<ActionReceipt> {
  await sleep(120)
  let url = ''
  let title = ''
  try {
    const r = await cdp.send<any>('Runtime.evaluate', { expression: '({url: location.href, title: document.title})', returnByValue: true }, 5_000)
    url = String(r?.result?.value?.url || '')
    title = String(r?.result?.value?.title || '')
  } catch { /* 导航中可能执行失败 */ }
  return { ok: true, action, url, title, detail }
}

async function readValue(cdp: CdpSession, objectId: string): Promise<string> {
  try {
    const r = await cdp.send<any>('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const el = this;
        if (el && typeof el.value === 'string') return el.value.slice(0, 120);
        return String(el && el.textContent || '').trim().slice(0, 120);
      }`,
    })
    return String(r?.result?.value ?? '')
  } catch {
    return ''
  }
}

function normalizeButton(button?: string): string {
  const b = String(button || 'left').toLowerCase()
  return b === 'right' || b === 'middle' ? b : 'left'
}

interface ParsedKey {
  key: string
  code: string
  vk: number
  modifiers: number
  text: string
}

const KEY_TABLE: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
}

function parseKey(spec: string): ParsedKey | null {
  const raw = String(spec || '').trim()
  if (!raw) return null
  const parts = raw.split('+').map((s) => s.trim()).filter(Boolean)
  const keyName = parts.pop() || ''
  let modifiers = 0
  for (const mod of parts) {
    const m = mod.toLowerCase()
    if (m === 'shift') modifiers |= 8
    else if (m === 'alt' || m === 'option') modifiers |= 1
    else if (m === 'control' || m === 'ctrl') modifiers |= 2
    else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'controlormeta') modifiers |= process.platform === 'darwin' ? 4 : 2
    else return null
  }
  const known = KEY_TABLE[keyName.toLowerCase()]
  if (known) return { key: known.key, code: known.code, vk: known.vk, modifiers, text: known.text || '' }
  if (keyName.length === 1) {
    const ch = keyName
    const upper = ch.toUpperCase()
    return {
      key: ch,
      code: /[a-z]/i.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : '',
      vk: upper.charCodeAt(0),
      modifiers,
      text: modifiers === 0 ? ch : '',
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
