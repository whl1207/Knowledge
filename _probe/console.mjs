/**
 * _probe/console.mjs — 启动应用、收集渲染层 console 输出（找 [navdiag] 行）。
 * 用法: node console.mjs [port] [seconds]
 */
import { writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'console.json')
const TRACE = join(HERE, 'console.log')
writeFileSync(TRACE, '')
const trace = (m) => { try { appendFileSync(TRACE, `${Date.now()} ${m}\n`) } catch { /* ignore */ } }
const PORT = Number(process.argv[2] || 9223)
const SECONDS = Number(process.argv[3] || 25)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const main = async () => {
  // 等目标就绪
  let page = null
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && !String(t.url).includes('#'))
      if (page) break
    } catch { /* not yet */ }
    await sleep(500)
  }
  if (!page) throw new Error('no main target')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  const state = { id: 0, pending: new Map() }
  const lines = []
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (msg.id && state.pending.has(msg.id)) { state.pending.get(msg.id)(msg); state.pending.delete(msg.id); return }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      lines.push(`${msg.params.type}: ${text}`)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      lines.push('EXCEPTION: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 400))
    }
  })
  const send = (method, params = {}, t = 20000) => new Promise((res) => {
    const myId = ++state.id
    const timer = setTimeout(() => { state.pending.delete(myId); res({ timeout: true }) }, t)
    state.pending.set(myId, (m) => { clearTimeout(timer); res(m) })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  await send('Runtime.enable')
  await send('Page.enable')
  trace('connected; reloading')
  await send('Page.reload', { ignoreCache: true })
  await sleep(SECONDS * 1000)
  writeFileSync(OUT, JSON.stringify({ lines }, null, 2))
  for (const l of lines.filter((x) => x.includes('navdiag'))) console.log(l)
  trace('done, lines=' + lines.length)
  try { ws.close() } catch { /* ignore */ }
  process.exit(0)
}
main().catch((e) => { trace('ERROR ' + (e && e.stack || e)); console.error(String(e && e.message || e)); process.exit(1) })
