/**
 * plugin-dsh-compat.ts — DSH 插件在 AI-KM 的兼容层（P4，宿主半边）
 *
 * 目标：让一个只有 `package.json.dsh` 的包（没有 `aikm` 字段）能被 AI-KM 当成插件装载，
 * 并把 DSH 的 ctx 形状映射到 AI-KM 的服务面。**界面半边（lib/client.js）不在本轮**（P5）。
 *
 * 设计取舍：
 * - 不引入 Cordis：DSH 插件只要 `apply(ctx, config)` 与 `ctx.get/provide/effect/on`，
 *   AI-KM 的 ctx 已经同构，薄适配即可；
 * - DSH 没有声明式权限，这里用**源码静态探测**生成清单里的 permissions（只提高知情度，
 *   不是沙箱；同进程插件仍可直接 import node 模块）；
 * - 未识别的 ctx 成员返回 undefined（与 DSH 一致），不抛错——否则可选服务会让插件直接崩。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { brand } from '@/types/ids'
import type { AikmPluginManifest, PluginContext, PluginPermission } from '@/types/plugin'
import type { ToolDefinition } from '@/types/tool'
import { toAssistantStreamPayload } from '@/shared/pluginEventAdapter'

/** 临时诊断：DSH 事件订阅/收帧写文件（排查“推理完成但插件没收到”）；稳定后删除 */
function dshDebug(line: string): void {
  try {
    fs.appendFileSync(
      path.join(process.env.TEMP || process.cwd(), 'aikm-dsh-debug.log'),
      `${new Date().toISOString()} ${line}\n`,
    )
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

/** 从 package.json 合成 AI-KM 清单（不是 DSH 包返回 null） */
export interface DshManifestResult {
  manifest: AikmPluginManifest
  /** 从 `cordis.patch.yml` 读到的默认配置（用户配置优先） */
  config: Record<string, unknown>
}

function readSource(dir: string, main: string): string {
  const candidates = [path.join(dir, main), path.join(dir, 'lib/index.js'), path.join(dir, 'index.js')]
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue
      return fs.readFileSync(file, 'utf8')
    } catch {
      /* 下一个 */
    }
  }
  return ''
}

/**
 * 静态探测能力 → 权限。
 *
 * 这是 D10 的"静态预告"：让用户在启用前看到它大概要什么。**检测不到不等于没能力**
 * （动态 import / 拼字符串都能绕过），所以它只用于清单展示与宿主服务注入的门槛。
 */
export function detectDshPermissions(dir: string, main: string): PluginPermission[] {
  const text = readSource(dir, main)
  const out = new Set<PluginPermission>()
  const has = (re: RegExp) => re.test(text)
  if (has(/sessionController/)) {
    out.add('agent')
    out.add('agent.control')
  }
  if (has(/\bsessions\b/) || has(/sessionProjections/) || has(/workspaceRegistry/)) out.add('agent')
  if (has(/\bagents\b/) || has(/approval\b|userQuestions|waterfall/)) out.add('agent.control')
  if (has(/assistant-stream|session\/created|agent\/turn-start/)) out.add('agent.observe')
  if (has(/webServer/)) out.add('net.listen')
  if (has(/node:child_process|child_process|spawn\(/)) out.add('process.spawn')
  if (has(/node:fs|from ['"]fs['"]/)) out.add('fs')
  if (has(/\bfetch\(/)) out.add('net')
  if (has(/sendFile|uploadMedia|attachments/)) out.add('attachments')
  if (has(/safeStorage|\bsecrets\b/)) out.add('secrets')
  if (has(/schedule\b|setInterval\(/)) out.add('schedule')
  return Array.from(out)
}

function parseScalar(raw: string): unknown {
  const text = raw.trim()
  if (!text) return ''
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  const quoted = text.match(/^['"](.*)['"]$/)
  if (quoted) return quoted[1]
  return text
}

/**
 * 只解析 `cordis.patch.yml` 里**第一行 insert 的 config**（P4 子集）。
 *
 * 不支持 group / isolate / !!js / 多行对象——遇到就只取扁平标量，其余忽略。
 * 这不是通用 YAML 解析器，故意写小：DSH 的完整 loader 语义不在本轮范围。
 */
export function parseDshPatchConfig(text: string): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const lines = String(text || '').split(/\r?\n/)
  let inConfig = false
  let baseIndent = 0
  for (const line of lines) {
    if (/^\s*-\s*id:\s*/.test(line)) {
      inConfig = false
      continue
    }
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true
      baseIndent = (line.match(/^\s*/) || [''])[0].length + 2
      continue
    }
    if (!inConfig) continue
    if (!line.trim()) continue
    const indent = (line.match(/^\s*/) || [''])[0].length
    if (indent < baseIndent) {
      inConfig = false
      continue
    }
    const match = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (match) config[match[1]] = parseScalar(match[2])
  }
  return config
}

/** 读 patch 文件里的默认配置（文件不存在 / 解析失败 → 空对象） */
export function readDshPatchConfig(dir: string, patchRel: unknown): Record<string, unknown> {
  const rels = Array.isArray(patchRel) ? patchRel : [patchRel]
  for (const rel of rels) {
    if (typeof rel !== 'string' || !rel.trim()) continue
    try {
      const file = path.join(dir, rel)
      if (!fs.existsSync(file)) continue
      return parseDshPatchConfig(fs.readFileSync(file, 'utf8'))
    } catch {
      /* 下一个 */
    }
  }
  return {}
}

/** 把只有 `dsh` 字段的 package.json 合成 AI-KM 清单 */
export function synthesizeDshManifest(pkg: any, dir: string, fallbackId: string): DshManifestResult | null {
  if (!pkg || typeof pkg !== 'object' || !pkg.dsh || typeof pkg.dsh !== 'object') return null
  const dsh = pkg.dsh as Record<string, any>
  const main =
    typeof pkg.main === 'string' && pkg.main
      ? pkg.main
      : typeof pkg.exports?.['.'] === 'string'
        ? pkg.exports['.']
        : 'index.js'
  const patchRel = dsh.bundle?.patch
  const config = readDshPatchConfig(dir, patchRel)
  const clientEntry =
    typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : 'lib/client.js'
  const manifest: AikmPluginManifest = {
    id: fallbackId,
    name: String(pkg.name || fallbackId),
    version: String(pkg.version || '0.0.0'),
    apiVersion: '^1',
    main,
    permissions: detectDshPermissions(dir, main),
    ...(typeof pkg.description === 'string' && pkg.description ? { description: pkg.description } : {}),
    // DSH 客户端半边（P5 用；经典脚本，不是 ESM）
    ...(dsh.client && typeof dsh.client === 'object' && dsh.client.platform === 'web'
      ? { client: { entry: clientEntry } }
      : {}),
  }
  return { manifest, config }
}

// ---------------------------------------------------------------------------
// ctx 适配
// ---------------------------------------------------------------------------

/** DSH 的 `parameters`（字段表）→ AI-KM 的 JSON Schema */
export function toInputSchema(parameters: any): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object') return { type: 'object', properties: {} }
  if (parameters.type === 'object' && parameters.properties && typeof parameters.properties === 'object') {
    return parameters
  }
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(parameters)) {
    if (!spec || typeof spec !== 'object') continue
    const copy = { ...(spec as Record<string, unknown>) }
    const isRequired = copy.required === true
    delete copy.required
    properties[key] = copy
    if (isRequired) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** DSH 工具定义 → AI-KM ToolDefinition（执行失败转 `{ok:false}`，不抛） */
export function adaptDshTool(def: any, register: (definition: ToolDefinition) => () => void): () => void {
  const name = String(def?.name || '').trim()
  if (!name) throw new Error('[dsh-compat] 工具缺少 name')
  return register({
    name: brand(name),
    description: String(def?.description || ''),
    inputSchema: toInputSchema(def?.parameters),
    handler: async (input: any) => {
      try {
        const value = await def.execute(input, {})
        return { ok: true, value }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

/**
 * 把 AI-KM 的 `PluginContext` 包成 DSH 插件期望的 ctx。
 *
 * 关键映射：
 * - `get/provide/effect/on/logger` 直接对应；
 * - `tools.register` 做工具形状转换；
 * - `agent/assistant-stream` 由 `assistant/chunk` 等事件**适配成 DSH 帧**；
 * - `approval/request` / `user-questions/request` 落到 `ctx.waterfall`；
 * - 未识别成员返回 undefined（DSH 语义），不抛错。
 */
export function createDshContext(
  base: PluginContext,
  options: { pluginId: string; config: Record<string, unknown>; home: string },
): any {
  const ctx: any = {
    config: options.config,
    logger: base.log,
    get(name: string): unknown {
      if (name === 'homePaths') return { home: options.home }
      if (name in ctx) return ctx[name]
      return base.getService(name)
    },
    provide(name: string, value: unknown): () => void {
      return base.service(name, value)
    },
    effect(fn: () => unknown): () => void {
      return base.effect(() => {
        const result = fn()
        if (typeof result === 'function') return result as () => void
        if (result && typeof (result as any)[Symbol.iterator] === 'function') {
          const offs = Array.from(result as Iterable<unknown>).filter((x): x is () => void => typeof x === 'function')
          return () => {
            for (const off of offs.reverse()) off()
          }
        }
        return undefined
      })
    },
    on(name: string, listener: (...args: any[]) => any, opts?: any): () => void {
      return subscribeDshEvent(base, name, listener, opts)
    },
  }

  // 服务直挂（DSH 插件直接 ctx.sessionController.*）
  const services: Record<string, unknown> = {
    sessions: base.sessions,
    sessionController: base.sessionController,
    sessionProjections: base.sessionProjections,
    agents: base.agents,
    workspaceRegistry: base.workspaceRegistry,
    approval: base.approval,
    userQuestions: base.userQuestions && {
      ask: (input: any, askOpts?: any) =>
        base.userQuestions!.ask(Array.isArray(input) ? input : (input?.questions ?? []), askOpts),
    },
    waterfall: base.waterfall,
    webServer: base.webServer,
    process: base.process,
    secrets: base.secrets,
    schedule: base.schedule,
    attachments: base.attachments,
    rpcHost: base.rpcHost,
  }
  for (const [name, value] of Object.entries(services)) {
    if (value !== undefined) ctx[name] = value
  }
  ctx.tools = {
    register: (def: any) => adaptDshTool(def, base.tool),
  }

  return ctx
}

/** DSH 事件名 → AI-KM 事件/服务 */
function subscribeDshEvent(base: PluginContext, name: string, listener: (...args: any[]) => any, opts?: any): () => void {
  if (name === 'approval/request' || name === 'user-questions/request') {
    if (!base.waterfall) return () => {}
    return base.waterfall.on(name as never, listener as never)
  }
  if (name === 'agent/assistant-stream') {
    const types = ['agent/turn-start', 'agent/step-start', 'assistant/chunk', 'assistant/message', 'agent/turn-end']
    dshDebug(`subscribe assistant-stream (${types.join(',')})`)
    const offs = types.map((type) =>
      base.on(type as never, ((ev: any) => {
        dshDebug(`recv ${type} keys=${Object.keys(ev || {}).join(',')} agentId=${String(ev?.agentId ?? '')}`)
        // `forwardAgentEvent` 的 envelope 只有 `{agentId, ...payload}`，**不带事件类型**；
        // 类型是订阅时就知道的，这里补回去，否则适配器 switch 永远匹配不到。
        const payload = toAssistantStreamPayload({ ...(ev || {}), type })
        dshDebug(`mapped ${type} -> session=${String((payload as any)?.sessionId ?? '')} frame=${String((payload as any)?.frame?.type ?? '')}`)
        if (payload) listener(payload)
      }) as never, { global: true }),
    )
    return () => {
      for (const off of offs) off()
    }
  }
  if (name === 'session/created') {
    return base.on('session/created', listener as never, { global: true })
  }
  if (name === 'tools/result') {
    return base.on('tool/post-execute' as never, listener as never, { global: true })
  }
  return base.on(name as never, listener as never, opts)
}
