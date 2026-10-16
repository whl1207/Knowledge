/**
 * _probe/check.mjs — 最终校验：导航栏是否只剩聚合图标 + 聚合网格是否显示（截图）。
 * 用法: node check.mjs [port]
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const TRACE = join(HERE, 'check.log')
writeFileSync(TRACE, '')
const trace = (m) => { try { appendFileSync(TRACE, `${Date.now()} ${m}\n`) } catch { /* ignore */ } }
const PORT = Number(process.argv[2] || 9223)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const NAV = `(() => {
  const nav = document.querySelector('.panel-nav');
  if (!nav) return { err: 'no nav' };
  const row = document.querySelector('.panel-nav-plugins');
  const launcher = [...nav.children].find((e) => e !== row && e.querySelector('.fa-th-large') && !String(e.className).includes('panel-nav-plugins'));
  const iconRects = [...nav.querySelectorAll('[data-plugin-key]')].map((e) => {
    const r = e.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), visible: r.width > 0 && r.right <= nav.getBoundingClientRect().right + 1 };
  });
  return {
    navRight: Math.round(nav.getBoundingClientRect().right),
    pluginIconCount: nav.querySelectorAll('[data-plugin-key]').length,
    visiblePluginIcons: iconRects.filter((x) => x.visible).length,
    coreCount: nav.querySelectorAll('[data-core-key]').length,
    rowDisplay: row ? getComputedStyle(row).display : 'no-row',
    rowClientW: row ? row.clientWidth : -1,
    rowScrollW: row ? row.scrollWidth : -1,
    launcherPresent: !!launcher,
    gridOpen: !!document.querySelector('.plg-grid'),
  };
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
  const evaluate = async (expression, t = 25000) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, t)
    return r.timeout ? { timeout: true } : (r.result?.result?.value ?? { err: JSON.stringify(r).slice(0, 300) })
  }

  await send('Runtime.enable')
  await sleep(12000)
  const out = {}
  out.nav = await evaluate(NAV)
  trace('nav: ' + JSON.stringify(out.nav))
  out.click = await evaluate(`(() => {
    const nav = document.querySelector('.panel-nav');
    const row = document.querySelector('.panel-nav-plugins');
    const l = [...nav.children].find((e) => e !== row && e.querySelector('.fa-th-large') && !String(e.className).includes('panel-nav-plugins'));
    if (!l) return 'no-launcher';
    l.click(); return 'clicked';
  })()`)
  await sleep(1500)
  out.afterClick = await evaluate(NAV)
  const png = await send('Page.captureScreenshot', { format: 'png' }, 30000)
  if (png.result?.data) { writeFileSync(join(HERE, 'final.png'), Buffer.from(png.result.data, 'base64')); out.screenshot = 'final.png' }
  console.log(JSON.stringify(out, null, 2))
  trace('done')
  try { ws.close() } catch { /* ignore */ }
  process.exit(0)
}
main().catch((e) => { trace('ERROR ' + (e && e.stack || e)); console.error(String(e && e.message || e)); process.exit(1) })
