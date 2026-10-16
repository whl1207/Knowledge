/**
 * _probe/comp.mjs — 读 Vue 组件实例的真实状态（App 的 setupState），确认 launcherVisible 等值。
 * 用法: node comp.mjs [port]
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const TRACE = join(HERE, 'comp.log')
writeFileSync(TRACE, '')
const trace = (m) => { try { appendFileSync(TRACE, `${Date.now()} ${m}\n`) } catch { /* ignore */ } }
const PORT = Number(process.argv[2] || 9223)

const EXPR = `(() => {
  const root = document.getElementById('app');
  const findRoot = () => {
    let el = root;
    while (el) {
      if (el.__vue_app__) return el;
      el = el.firstElementChild;
    }
    return null;
  };
  const el = findRoot();
  const app = el ? el.__vue_app__ : null;
  if (!app) return { err: 'no vue app' };
  // 从根实例往下找带 navOverflow 的组件
  const seen = new Set();
  const hits = [];
  const walk = (inst, depth) => {
    if (!inst || seen.has(inst) || depth > 12) return;
    seen.add(inst);
    try {
      const s = inst.setupState || {};
      const keys = Object.keys(s);
      if (keys.includes('navOverflow') || keys.includes('visiblePluginNavButtons') || keys.includes('pluginNavButtons')) {
        let ov = null, vis = null, all = null;
        try { ov = JSON.parse(JSON.stringify(s.navOverflow)) } catch { ov = String(s.navOverflow) }
        try { vis = s.visiblePluginNavButtons ? JSON.parse(JSON.stringify(s.visiblePluginNavButtons)).length : null } catch { vis = 'err' }
        try { all = s.pluginNavButtons ? JSON.parse(JSON.stringify(s.pluginNavButtons)).length : null } catch { all = 'err' }
        const row = document.querySelector('.panel-nav-plugins');
        hits.push({
          type: inst.type && (inst.type.__name || inst.type.name) || '(anon)',
          navOverflow: ov,
          visibleCount: vis,
          allCount: all,
          rowInlineDisplay: row ? (row.style.display || '(empty)') : 'no-row',
          rowComputed: row ? getComputedStyle(row).display : 'no-row',
          pluginLauncherOpen: s.store ? undefined : undefined,
        });
      }
    } catch (e) { /* ignore */ }
    const kids = inst.subTree ? [inst.subTree] : [];
    const walkVNode = (v) => {
      if (!v || typeof v !== 'object') return;
      if (v.component) walk(v.component, depth + 1);
      const ch = v.children;
      if (Array.isArray(ch)) ch.forEach(walkVNode);
      if (v.dynamicChildren) v.dynamicChildren.forEach(walkVNode);
    };
    kids.forEach(walkVNode);
    // 也顺着父链/子组件列表走
    try { (inst.subTree && inst.subTree.component && walk(inst.subTree.component, depth + 1)) } catch { /* ignore */ }
  };
  walk(app._instance, 0);
  return { appFound: !!app, hits };
})()`

const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && !String(t.url).includes('#'))
  if (!page) throw new Error('no main target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const state = { id: 0, pending: new Map() }
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (msg.id && state.pending.has(msg.id)) { state.pending.get(msg.id)(msg); state.pending.delete(msg.id) }
  })
  const send = (method, params = {}, t = 25000) => new Promise((res) => {
    const myId = ++state.id
    const timer = setTimeout(() => { state.pending.delete(myId); res({ timeout: true }) }, t)
    state.pending.set(myId, (m) => { clearTimeout(timer); res(m) })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })
  const out = r.timeout ? { timeout: true } : (r.result?.result?.value ?? { err: JSON.stringify(r).slice(0, 400), exception: r.result?.exceptionDetails })
  console.log(JSON.stringify(out, null, 2))
  trace('done')
  try { ws.close() } catch { /* ignore */ }
  process.exit(0)
}
main().catch((e) => { trace('ERROR ' + (e && e.stack || e)); console.error(String(e && e.message || e)); process.exit(1) })
