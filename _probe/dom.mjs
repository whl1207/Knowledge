/**
 * _probe/dom.mjs — 看 .panel-nav 的直接子元素与行内 style，确认 v-show 到底写了什么。
 * 用法: node dom.mjs [port]
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const TRACE = join(HERE, 'dom.log')
writeFileSync(TRACE, '')
const trace = (m) => { try { appendFileSync(TRACE, `${Date.now()} ${m}\n`) } catch { /* ignore */ } }
const PORT = Number(process.argv[2] || 9223)

const EXPR = `(() => {
  const nav = document.querySelector('.panel-nav');
  const rows = [...document.querySelectorAll('.panel-nav-plugins')];
  const grid = document.querySelector('.plg-grid');
  return {
    navChildCount: nav.children.length,
    children: [...nav.children].map((e, i) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        i,
        cls: String(e.className) || '(none)',
        inlineDisplay: e.style.display || '(unset)',
        computedDisplay: cs.display,
        w: Math.round(r.width),
        pluginKeys: e.querySelectorAll('[data-plugin-key]').length,
        hasThLarge: !!e.querySelector('.fa-th-large'),
        text: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 30),
      };
    }),
    rowsTotal: rows.length,
    rows: rows.map((r) => ({ inlineDisplay: r.style.display || '(unset)', computed: getComputedStyle(r).display, w: Math.round(r.getBoundingClientRect().width), scrollW: r.scrollWidth })),
    gridOpen: !!grid,
  };
})()`

const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && String(t.url).includes('dist/index.html') && !String(t.url).includes('#'))
  if (!page) throw new Error('no main target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const state = { id: 0, pending: new Map() }
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (msg.id && state.pending.has(msg.id)) { state.pending.get(msg.id)(msg); state.pending.delete(msg.id) }
  })
  const send = (method, params = {}, t = 20000) => new Promise((res) => {
    const myId = ++state.id
    const timer = setTimeout(() => { state.pending.delete(myId); res({ timeout: true }) }, t)
    state.pending.set(myId, (m) => { clearTimeout(timer); res(m) })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })
  console.log(JSON.stringify(r.timeout ? { timeout: true } : r.result?.result?.value, null, 2))
  trace('done')
  try { ws.close() } catch { /* ignore */ }
  process.exit(0)
}
main().catch((e) => { trace('ERROR ' + (e && e.stack || e)); console.error(String(e && e.message || e)); process.exit(1) })
