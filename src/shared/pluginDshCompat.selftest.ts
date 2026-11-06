/**
 * pluginDshCompat.selftest.ts — DSH 兼容层（P4 宿主半边）的自测
 *
 * 不启动 Electron：只测"清单合成 / patch 默认配置 / DSH 工具形状 / ctx 映射"。
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  adaptDshTool,
  createDshContext,
  parseDshPatchConfig,
  synthesizeDshManifest,
  toInputSchema,
} from '../../electron/main/plugin-dsh-compat'

export interface SelfTestResult {
  name: string
  ok: boolean
  detail?: string
}

export function runPluginDshCompatSelfTest(): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = []
  const check = (name: string, fn: () => string | null | Promise<string | null>) =>
    Promise.resolve()
      .then(fn)
      .then((problem) => results.push({ name, ok: !problem, ...(problem ? { detail: problem } : {}) }))
      .catch((e) => results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }))

  return (async () => {
    await check('patch 只取 config 里的扁平标量', () => {
    const config = parseDshPatchConfig(
      [
        '- insert:',
        '    - id: dsh-demo',
        "      name: 'dsh-demo'",
        '      config:',
        '        autoStart: true',
        '        maxItems: 3',
        "        label: '你好'",
      ].join('\n'),
    )
    if (config.autoStart !== true) return `autoStart=${String(config.autoStart)}`
    if (config.maxItems !== 3) return `maxItems=${String(config.maxItems)}`
    if (config.label !== '你好') return `label=${String(config.label)}`
    return null
  })

  await check('合成清单：dsh 包 + 权限探测 + patch 默认配置', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikm-dsh-'))
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'dsh-demo', version: '1.2.3', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )
      fs.writeFileSync(
        path.join(dir, 'index.js'),
        "import { sessionController } from 'x'\nimport { webServer } from 'y'\nimport 'node:child_process'\nfetch('https://x')\nctx.on('agent/assistant-stream', () => {})",
      )
      fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), ['- insert:', '    - id: dsh-demo', '      config:', '        autoStart: true'].join('\n'))
      const got = synthesizeDshManifest(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), dir, 'dsh-demo')
      if (!got) return '没有合成出清单'
      if (got.manifest.id !== 'dsh-demo') return 'id 不对'
      if (got.manifest.apiVersion !== '^1') return 'apiVersion 不对'
      if (got.config.autoStart !== true) return 'patch 配置没读到'
      const perms = new Set(got.manifest.permissions ?? [])
      for (const need of ['agent', 'agent.control', 'agent.observe', 'net.listen', 'process.spawn', 'net']) {
        if (!perms.has(need as never)) return `缺少探测到的权限：${need}（实际 ${Array.from(perms).join(',')}）`
      }
      return null
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await check('DSH parameters（字段表）→ JSON Schema', () => {
    const schema = toInputSchema({
      q: { type: 'string', required: true, description: '查询' },
      limit: { type: 'number', description: '条数' },
    }) as any
    if (schema.type !== 'object') return 'type 不是 object'
    if (schema.properties?.q?.required !== undefined) return 'required 没被移进数组'
    if (schema.required?.join(',') !== 'q') return `required 不对：${JSON.stringify(schema.required)}`
    return null
  })

  await check('DSH 工具执行：成功包装 / 异常转 ok:false', async () => {
    const registered: any[] = []
    const register = (def: any) => {
      registered.push(def)
      return () => {}
    }
    adaptDshTool(
      { name: 'dsh_ok', parameters: { x: { type: 'string' } }, execute: async (args: any) => ({ got: args.x }) },
      register,
    )
    adaptDshTool(
      { name: 'dsh_fail', parameters: {}, execute: async () => { throw new Error('boom') } },
      register,
    )
    if (registered.length !== 2) return '注册数量不对'
    const ok = await registered[0].handler({ x: 'hi' })
    if (ok.ok !== true || ok.value.got !== 'hi') return `成功结果不对：${JSON.stringify(ok)}`
    const bad = await registered[1].handler({})
    if (bad.ok !== false || !/boom/.test(bad.error)) return `失败结果不对：${JSON.stringify(bad)}`
    return null
  })

  await check('ctx 映射：homePaths / getService / tools.register', () => {
    const registered: any[] = []
    const calls: string[] = []
    const base: any = {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      tool: (def: any) => {
        registered.push(def)
        return () => {}
      },
      service: (name: string) => {
        calls.push(`provide:${name}`)
        return () => {}
      },
      getService: (name: string) => (name === 'customSvc' ? { v: 1 } : undefined),
      effect: (fn: any) => {
        fn()
        return () => {}
      },
      on: () => () => {},
      sessionController: { create: async () => ({ sessionId: 's1' }) },
      sessions: { get: () => undefined },
      sessionProjections: { cachedSnapshot: () => undefined },
      agents: { get: () => undefined },
      workspaceRegistry: { list: () => [] },
      approval: { request: async () => 'rejected' },
      userQuestions: { ask: async () => [] },
      waterfall: { on: () => () => {} },
      webServer: { port: 0, register: () => () => {} },
      process: { spawn: () => ({}) },
      secrets: {},
      schedule: {},
      attachments: {},
      rpcHost: { handle: () => () => {} },
    }
    const ctx = createDshContext(base, { pluginId: 'p', config: { a: 1 }, home: 'C:/home' })
    const home = ctx.get('homePaths') as any
    if (home?.home !== 'C:/home') return 'homePaths 不对'
    if ((ctx.get('customSvc') as any)?.v !== 1) return 'getService 没接上'
    if (ctx.config.a !== 1) return 'config 没挂上'
    if (typeof ctx.sessionController.create !== 'function') return 'sessionController 没映射'
    ctx.tools.register({ name: 'dsh_t', parameters: {}, execute: async () => 1 })
    if (registered.length !== 1 || registered[0].name !== 'dsh_t') return 'tools.register 没映射'
    return null
  })

  await check('ctx.effect 接受可迭代 disposer（Cordis 语义）', () => {
    const offs: string[] = []
    const base: any = {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      tool: () => () => {},
      service: () => () => {},
      getService: () => undefined,
      effect: (fn: any) => fn(),
      on: () => () => {},
    }
    const ctx = createDshContext(base, { pluginId: 'p', config: {}, home: '' })
    const cleanup = ctx.effect(() => [() => offs.push('a'), () => offs.push('b')])
    if (typeof cleanup !== 'function') return 'effect 没返回 disposer'
    ;(cleanup as any)()
    if (offs.join(',') !== 'b,a') return `逆序清理不对：${offs.join(',')}`
    return null
  })

    return results
  })()
}
