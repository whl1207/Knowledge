import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'

const port = process.argv[2]
const urlPrefix = process.argv[3]
const action = process.argv[4]
const arg = process.argv[5]

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find((t) => t.url.startsWith(urlPrefix))
if (!target) throw new Error('target not found')

const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 200 * 1024 * 1024 })
let id = 0
const pending = new Map()
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
const send = (method, params = {}) => {
  const mid = ++id
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}

if (action === 'shot') {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(arg, Buffer.from(shot.data, 'base64'))
  console.log('saved', arg)
} else {
  const script = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg
  const r = await send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2))
}
ws.close()
