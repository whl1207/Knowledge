/**
 * recorder.ts — 浏览器「录制操作 → 站点经验 / Playbook」的纯逻辑
 *
 * 设计取舍：
 * - 录制发生在**页面内**（事件监听器），不依赖用户装扩展；
 * - 事件通过 console.log 前缀回传主进程，主进程再过滤，避免为了录制引入额外 IPC 通道；
 * - 只记录可复现的语义动作（goto / click / fill / select），不记录像素坐标；
 * - 密码、隐藏字段、文件选择不记录（避免把凭据写进 Playbook）。
 */

export interface RecordedBrowserStep {
  type: 'goto' | 'click' | 'fill' | 'select'
  url?: string
  selector?: string
  value?: string
  label?: string
  text?: string
}

/** 页面内注入的录制脚本：重复注入是幂等的（用 window.__AIKM_RECORDING__ 守护） */
export const RECORDER_SCRIPT = `(function () {
  if (window.__AIKM_RECORDING__) return 'already';
  window.__AIKM_RECORDING__ = true;
  var PREFIX = '__AIKM_RECORD__';
  function send(payload) {
    try { console.log(PREFIX + JSON.stringify(payload)); } catch (e) { /* 忽略 */ }
  }
  function css(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/["\\\\]/g, '\\\\$&');
  }
  function unique(selector) {
    try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; }
  }
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) {
      var byId = '#' + css(el.id);
      if (unique(byId)) return byId;
    }
    var attrs = ['data-testid', 'data-test', 'data-test-id', 'name', 'aria-label'];
    for (var i = 0; i < attrs.length; i += 1) {
      var attr = attrs[i];
      var val = el.getAttribute(attr);
      if (val) {
        var attrSel = el.tagName.toLowerCase() + '[' + attr + '="' + String(val).replace(/"/g, '\\\\"') + '"]';
        if (unique(attrSel)) return attrSel;
      }
    }
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      var tag = node.tagName.toLowerCase();
      if (node.id) {
        tag = '#' + css(node.id);
        path.unshift(tag);
        var idSel = path.join(' > ');
        if (unique(idSel)) return idSel;
        break;
      }
      var parent = node.parentElement;
      if (!parent) break;
      var siblings = [];
      for (var j = 0; j < parent.children.length; j += 1) {
        if (parent.children[j].tagName === node.tagName) siblings.push(parent.children[j]);
      }
      if (siblings.length > 1) tag += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      path.unshift(tag);
      var full = path.join(' > ');
      if (unique(full)) return full;
      node = parent;
    }
    return path.join(' > ');
  }
  function isSensitive(el) {
    if (!el || !el.tagName) return true;
    var tag = String(el.tagName).toUpperCase();
    if (tag === 'INPUT') {
      var type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'file') return true;
      var ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.indexOf('current-password') >= 0 || ac.indexOf('new-password') >= 0 || ac.indexOf('one-time-code') >= 0) return true;
    }
    var name = String(el.getAttribute('name') || '').toLowerCase();
    var id = String(el.id || '').toLowerCase();
    return /pass(word)?|secret|token|api[_-]?key|credit|card/.test(name + ' ' + id);
  }
  function fieldValue(el) {
    if (el.isContentEditable) return String(el.innerText || '');
    if (el.tagName === 'SELECT') {
      var opt = el.selectedOptions && el.selectedOptions[0];
      return { value: String(el.value || ''), label: opt ? String(opt.label || opt.text || '') : '' };
    }
    return { value: String(el.value || '') };
  }
  document.addEventListener('click', function (event) {
    if (!window.__AIKM_RECORDING__) return;
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var el = target.closest('a,button,[role="button"],[role="link"],[role="menuitem"],summary,input[type="checkbox"],input[type="radio"]');
    if (!el || isSensitive(el)) return;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      send({ type: 'click', selector: selectorOf(el), text: String(el.value || '') });
      return;
    }
    send({
      type: 'click',
      selector: selectorOf(el),
      text: String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    });
  }, true);
  document.addEventListener('change', function (event) {
    if (!window.__AIKM_RECORDING__) return;
    var el = event.target;
    if (!el || isSensitive(el)) return;
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT' && !el.isContentEditable) return;
    var v = fieldValue(el);
    if (el.tagName === 'SELECT') {
      send({ type: 'select', selector: selectorOf(el), value: v.value, label: v.label });
    } else {
      send({ type: 'fill', selector: selectorOf(el), value: typeof v === 'string' ? v : v.value });
    }
  }, true);
  var inputTimers = new WeakMap();
  document.addEventListener('input', function (event) {
    if (!window.__AIKM_RECORDING__) return;
    var el = event.target;
    if (!el || isSensitive(el)) return;
    if (!el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
    var prev = inputTimers.get(el);
    if (prev) clearTimeout(prev);
    inputTimers.set(el, setTimeout(function () {
      var value = el.isContentEditable ? String(el.innerText || '') : String(el.value || '');
      send({ type: 'fill', selector: selectorOf(el), value: value });
    }, 450));
  }, true);
  return 'recording';
})();`

/** 把录制步骤转成可在 browser.* API 里执行的 Playbook 代码 */
export function buildPlaybookCode(steps: RecordedBrowserStep[]): string {
  const lines: string[] = [
    '// 由用户录制生成；请检查选择器与步骤后再批准。',
  ]
  const pushGoto = (url: string) => {
    if (!url) return
    if (lines.length && lines[lines.length - 1].includes('browser.goto')) return
    lines.push(`await browser.goto(${JSON.stringify(url)}, { waitUntil: 'load' });`)
  }
  for (const step of steps) {
    if (step.type === 'goto') { pushGoto(String(step.url || '')); continue }
    if (!step.selector) continue
    if (step.type === 'click') {
      lines.push(`await browser.click({ selector: ${JSON.stringify(step.selector)} });`)
      continue
    }
    if (step.type === 'fill') {
      const line = `await browser.fill({ selector: ${JSON.stringify(step.selector)} }, ${JSON.stringify(String(step.value || ''))});`
      const prev = lines[lines.length - 1] || ''
      if (prev.startsWith('await browser.fill({ selector: ' + JSON.stringify(step.selector))) lines.pop()
      lines.push(line)
      continue
    }
    if (step.type === 'select') {
      const choice = step.value
        ? `{ value: ${JSON.stringify(String(step.value))} }`
        : `{ label: ${JSON.stringify(String(step.label || ''))} }`
      lines.push(`await browser.select({ selector: ${JSON.stringify(step.selector)} }, ${choice});`)
    }
  }
  return lines.join('\n')
}

/** 录制结果的可读摘要（写入 site learnings，Agent 下次同站点任务能直接读到） */
export function buildRecordingNotes(url: string, steps: RecordedBrowserStep[]): string {
  const lines = [
    '## 用户录制流程',
    `- 起点：${url || '(未知)'}`,
    `- 步骤数：${steps.filter((s) => s.type !== 'goto').length}`,
    '',
    '| # | 动作 | 目标 | 值 |',
    '| --- | --- | --- | --- |',
  ]
  let n = 0
  for (const step of steps) {
    if (step.type === 'goto') continue
    n += 1
    const target = String(step.selector || '')
    const value = step.type === 'fill' ? String(step.value || '') : step.type === 'select' ? String(step.label || step.value || '') : String(step.text || '')
    const clean = (v: string) => v.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160)
    lines.push(`| ${n} | ${step.type} | \`${clean(target)}\` | ${clean(value)} |`)
  }
  return lines.join('\n')
}
