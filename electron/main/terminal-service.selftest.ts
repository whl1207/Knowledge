/**
 * terminal-service.selftest.ts — 右侧栏「终端」后端自测（真 node-pty，起真 shell）
 *
 * 覆盖（用 scripts/electron-stub.mjs 把 ipcMain 换成可调用表，因此在纯 node 下就能跑）：
 *   1. 安全策略不是门槛：safe / workspace / trusted / 缺省 都放行（起会话后立刻收掉）；
 *   2. 参数校验：缺 id / resize 不存在的会话 → 明确失败；
 *   3. 真 PTY：起 shell → 收到流式输出 → 写命令 → 输出里出现标记 → resize 成功 → kill 生效；
 *   4. 生命周期：kill 后再写 → 「终端会话不存在」。
 *
 * 平台差异：node-pty 在 Windows / macOS / Linux(x64) 用预编译包；若当前平台没有可用的预编译
 * 二进制（例如没装编译工具的 Linux），第 3 组会**显式标记为 skipped**，不把整套测试拖红。
 *
 * 用法：`node scripts/run-selftests.mjs terminal`
 */
import { ipcMain } from 'electron'
import { disposeAllTerminals, registerTerminalIpc } from './terminal-service'

export interface TerminalCase {
  name: string
  ok: boolean
  detail?: string
}

type Handler = (event: any, params: any) => any

/** 伪造的 webContents：记录主进程推给渲染层的事件 */
function makeSender() {
  const events: Array<{ channel: string; payload: any }> = []
  const sender = {
    id: 4242,
    isDestroyed: () => false,
    send: (channel: string, payload: any) => { events.push({ channel, payload }) },
    once: () => {},
  }
  return { sender, events }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等待条件成立（PTY 输出是异步的，不能一口气断言） */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(60)
  }
  return check()
}

export async function runTerminalSelfTest(): Promise<TerminalCase[]> {
  const cases: TerminalCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  registerTerminalIpc()
  const handlers = (ipcMain as any).__handlers as Map<string, Handler>
  const call = (channel: string, event: any, params: any) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`通道未注册：${channel}`)
    return fn(event, params)
  }

  // 1. 安全策略不是终端的门槛：任何档位都放行（起完立刻 kill，不留 shell）
  {
    const { sender } = makeSender()
    for (const mode of ['safe', 'workspace', 'trusted', undefined]) {
      const id = `allow-${String(mode)}`
      const res = await call('terminal:create', { sender }, { id, environment: mode, cwd: process.cwd() })
      // 没有 node-pty 预编译二进制时，放行之后会卡在加载 PTY 这一步，按跳过计
      const ptyMissing = res?.ok === false && /node-pty/.test(String(res?.error || ''))
      add(`策略：environment=${String(mode)} 不被拒绝`, res?.ok === true || ptyMissing,
        String(res?.error || '').slice(0, 60))
      if (res?.ok === true) add(`策略：environment=${String(mode)} 起会话后写入可用`,
        (await call('terminal:write', { sender }, { id, data: '' }))?.ok === true)
      await call('terminal:kill', { sender }, { id })
    }
  }

  // 2. 参数校验
  {
    const { sender } = makeSender()
    const res = await call('terminal:create', { sender }, { cols: 80 })
    add('校验：缺少 id 直接失败', res?.ok === false, String(res?.error || ''))
    const resize = await call('terminal:resize', { sender }, { id: '不存在的会话', cols: 80, rows: 24 })
    add('校验：resize 不存在的会话 → 失败', resize?.ok === false)
  }

  // 3. 真 PTY 全链路（无预编译二进制时显式跳过）
  const { sender, events } = makeSender()
  const id = 'selftest-term'
  const created = await call('terminal:create', { sender }, {
    id, cols: 90, rows: 24, cwd: process.cwd(),
  })
  const ptyUnavailable = created?.ok === false && /node-pty/.test(String(created?.error || ''))

  if (ptyUnavailable) {
    add('PTY：当前平台无可用 node-pty 预编译二进制（跳过）', true, 'skipped: ' + String(created?.error || '').slice(0, 80))
    add('PTY：跳过流式输出断言（skipped）', true)
    add('PTY：跳过写命令断言（skipped）', true)
    add('PTY：跳过 resize 断言（skipped）', true)
  } else {
    add('PTY：起会话成功', created?.ok === true, String(created?.error || created?.shell || ''))
    add('PTY：返回 shell 与会话 id', String(created?.id) === id && !!created?.shell, `${created?.shell || ''}`)

    const gotFirstOutput = await waitFor(
      () => events.some((e) => e.channel === 'terminal:data' && String(e.payload?.id) === id && String(e.payload?.data || '').length > 0),
      15000,
    )
    add('PTY：收到流式输出（shell 提示符）', gotFirstOutput)

    // 写一行命令，等标记出现在输出里（PowerShell / bash 都认 echo）
    const mark = `AIKM_SELFTEST_${Date.now().toString(36)}`
    const writeRes = await call('terminal:write', { sender }, { id, data: `echo ${mark}\r` })
    add('PTY：写入命令被受理', writeRes?.ok === true)
    const gotMark = await waitFor(
      () => events.some((e) => e.channel === 'terminal:data' && String(e.payload?.data || '').includes(mark)),
      15000,
    )
    add('PTY：命令输出回传到渲染层', gotMark, mark)

    const resizeRes = await call('terminal:resize', { sender }, { id, cols: 100, rows: 30 })
    add('PTY：resize 生效', resizeRes?.ok === true)

    const killRes = await call('terminal:kill', { sender }, { id })
    add('PTY：kill 成功', killRes?.ok === true)
    const afterKill = await call('terminal:write', { sender }, { id, data: 'echo x\r' })
    add('生命周期：kill 后再写 → 会话不存在', afterKill?.ok === false)
  }

  disposeAllTerminals()
  return cases
}

/** 打印自测结果并返回是否全通过 */
export async function logTerminalSelfTest(): Promise<boolean> {
  const cases = await runTerminalSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[terminal] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
