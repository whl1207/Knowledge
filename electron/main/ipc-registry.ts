/**
 * ipc-registry.ts — IPC 通道收编（命名空间注册 + 统一错误信封）
 *
 * 借鉴 DeepSeek-Harness 的命令/能力分层思想：
 * - 每个新通道形如 `<namespace>:<method>`（agent:create / sessionLog:derive …）；
 * - 统一返回 `{ ok, data } | { ok: false, error: { code, message } }`，
 *   渲染进程 `invokeIpc()` 解包并抛出带 code 的 `IPCError`；
 * - 注册集中在 `registerNamespacedIpc()`，一次调用挂载全部新通道；
 * - 既有 80+ 个裸通道（loadSkills / ai:start / executeShell …）保持原样，
 *   迁移清单见 docs/subsystems/ipc.md。
 */

import { ipcMain, BrowserWindow, app, type IpcMainInvokeEvent } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { IPCError, toIpcError, type IpcResponse } from '@/types/ipc'
import * as aiService from './ai-service'
import * as agentLoop from './agent-loop'
import { sessionLog } from './session-log'
import { skillService } from './skill-service'
import { toolRegistry } from '@/shared/toolRegistry'
import { jobRegistry } from './job-registry'
import { credentialStore } from './credentials'
import { generateSdkDocs } from './code-sdk'

type IpcHandler = (payload: any, event: IpcMainInvokeEvent) => Promise<any> | any

const handlers = new Map<string, IpcHandler>()

/**
 * 把任意值净化为纯 JSON（structured clone 安全）。
 * 防御纵深：即使渲染进程（旧 preload / 未走 JSON 净化的调用方）把 Vue
 * reactive proxy、类实例等非克隆对象送进来，也在此处被剥掉；返回值同理，
 * 避免主进程返回非克隆对象导致 `An object could not be cloned`。
 */
function toPlainJson(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = JSON.stringify(value)
  if (text === undefined) return undefined
  return JSON.parse(text)
}

/** 注册一个命名空间通道；返回注销函数。重复注册直接抛错（fail-loud）。 */
export function registerIpc(channel: string, handler: IpcHandler): () => void {
  if (handlers.has(channel)) {
    throw new Error(`[ipc-registry] 通道重复注册: ${channel}`)
  }
  handlers.set(channel, handler)
  ipcMain.handle(channel, async (event, payload): Promise<IpcResponse<any>> => {
    try {
      // 入参净化：结构化克隆前剥掉一切非 JSON 值
      const plainPayload = toPlainJson(payload)
      const data = await handler(plainPayload, event)
      // 返回值净化：避免把非克隆对象（如类实例、Proxy）发回渲染进程
      return { ok: true, data: toPlainJson(data) }
    } catch (err) {
      console.error(`[ipc] ${channel} 失败:`, err)
      return { ok: false, error: toIpcError(err) }
    }
  })
  return () => {
    handlers.delete(channel)
  }
}

/** 向所有窗口广播（用于 agent:event / skill:change 等推送通道） */
export function sendToAll(channel: string, payload: unknown): void {
  // 与 registerIpc 同样的净化：广播载荷也必须是纯 JSON，避免推送时
  // structured clone 失败（An object could not be cloned）。字符串/数字走快路径。
  const safe =
    typeof payload === 'string' || typeof payload === 'number' || payload === null || payload === undefined
      ? payload
      : toPlainJson(payload)
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.webContents.send(channel, safe)
  })
}

/** 挂载全部命名空间通道（app ready 时调用一次） */
export function registerNamespacedIpc(): void {
  // ---------------- sessionLog:*（会话事件日志，单一事实源） ----------------
  registerIpc('sessionLog:list', () => {
    return sessionLog.listSessions()
  })
  registerIpc('sessionLog:search', (payload) => {
    const keyword = payload?.keyword
    if (typeof keyword !== 'string') throw new IPCError('INVALID_ARGUMENT', '缺少 keyword')
    return sessionLog.searchSessions(keyword)
  })
  registerIpc('sessionLog:events', (payload) => {
    const requestId = payload?.requestId
    if (!requestId) throw new IPCError('INVALID_ARGUMENT', '缺少 requestId')
    const { limit, beforeSeq } = payload || {}
    return aiService.getSessionEvents(requestId, {
      limit: typeof limit === 'number' && limit > 0 ? Math.floor(limit) : undefined,
      beforeSeq: typeof beforeSeq === 'number' && beforeSeq > 0 ? Math.floor(beforeSeq) : undefined,
    })
  })
  registerIpc('sessionLog:derive', (payload) => {
    const requestId = payload?.requestId
    if (!requestId) throw new IPCError('INVALID_ARGUMENT', '缺少 requestId')
    return aiService.deriveMessages(requestId)
  })
  registerIpc('sessionLog:integrity', (payload) => {
    const requestId = payload?.requestId
    if (!requestId) throw new IPCError('INVALID_ARGUMENT', '缺少 requestId')
    return aiService.checkSessionLogIntegrity(requestId)
  })
  registerIpc('sessionLog:append', (payload) => {
    const { requestId, type, event } = payload || {}
    if (!requestId || !type) throw new IPCError('INVALID_ARGUMENT', '缺少 requestId/type')
    if (type !== 'tool/result' && type !== 'user/message') {
      throw new IPCError('UNSUPPORTED', `不允许从渲染进程追加事件类型: ${type}`)
    }
    const res = aiService.appendSessionEvent(requestId, type, event)
    if (!res.success) throw new IPCError('INVALID_ARGUMENT', res.error || '追加失败')
    return { success: true }
  })
  registerIpc('sessionLog:clearAll', () => {
    sessionLog.clearAll()
    return { success: true }
  })
  registerIpc('sessionLog:clearBefore', (payload) => {
    const cutoffTs = payload?.cutoffTs
    const cutoff = typeof cutoffTs === 'number' && cutoffTs > 0 ? cutoffTs : null
    return { removed: sessionLog.clearBefore(cutoff) }
  })

  // ---------------- agent:*（Agent 循环标准化） ----------------
  registerIpc('agent:create', (payload) => {
    const options = payload?.options
    if (!options?.provider) throw new IPCError('INVALID_ARGUMENT', '缺少 provider')
    const agent = agentLoop.createAgent(options)
    return { id: agent.id }
  })
  registerIpc('agent:send', (payload) => {
    const { id, content, source, images } = payload || {}
    if (!id || content === undefined) throw new IPCError('INVALID_ARGUMENT', '缺少 id/content')
    const agent = agentLoop.getAgent(id)
    if (!agent) throw new IPCError('NOT_FOUND', `agent 不存在: ${id}`)
    agent.send(String(content), source, Array.isArray(images) ? images : undefined)
    return { success: true }
  })
  registerIpc('agent:steer', (payload) => {
    const { id, content } = payload || {}
    if (!id || content === undefined) throw new IPCError('INVALID_ARGUMENT', '缺少 id/content')
    const agent = agentLoop.getAgent(id)
    if (!agent) throw new IPCError('NOT_FOUND', `agent 不存在: ${id}`)
    // 「转向/引导」只投递给**正在执行的 turn**（在下一个 step 边界消费，不打断当前执行）。
    // 会话已 idle（本轮已结束）时 steer 会被驱动器当成新任务另开一轮，与调用方
    // （聊天区「运行中输入引导」）的预期不符 → 直接回报未受理，由渲染进程回退为正常发送。
    if (agent.status !== 'running') return { success: false, reason: 'not-running' }
    agent.steer(String(content))
    return { success: true }
  })
  registerIpc('agent:inject', (payload) => {
    const { id, content } = payload || {}
    if (!id || content === undefined) throw new IPCError('INVALID_ARGUMENT', '缺少 id/content')
    const agent = agentLoop.getAgent(id)
    if (!agent) throw new IPCError('NOT_FOUND', `agent 不存在: ${id}`)
    agent.inject(String(content))
    return { success: true }
  })
  registerIpc('agent:cancel', (payload) => {
    const { id, cause, keepInbox } = payload || {}
    if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少 id')
    const agent = agentLoop.getAgent(id)
    if (!agent) throw new IPCError('NOT_FOUND', `agent 不存在: ${id}`)
    agent.cancel(cause || 'user', { keepInbox: !!keepInbox })
    return { success: true }
  })
  registerIpc('agent:list', () => agentLoop.listAgents())
  registerIpc('agent:dispose', async (payload) => {
    const { id } = payload || {}
    if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少 id')
    await agentLoop.disposeAgent(id)
    return { success: true }
  })
  registerIpc('agent:tools', (payload) => {
    const { agentId, scope } = payload || {}
    return agentLoop.listAgentTools(agentId, scope)
  })
  registerIpc('agent:state', (payload) => {
    const { id } = payload || {}
    if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少 id')
    const state = agentLoop.getAgentState(id)
    if (!state) throw new IPCError('NOT_FOUND', `agent 不存在: ${id}`)
    return state
  })
  registerIpc('agent:answer', (payload) => {
    const { id, askId, message } = payload || {}
    if (!id || !askId || message === undefined) {
      throw new IPCError('INVALID_ARGUMENT', '缺少 id/askId/message')
    }
    const ok = agentLoop.resolveAnswer(id, askId, String(message))
    if (!ok) throw new IPCError('NOT_FOUND', `未找到待回答的问题: ${askId}`)
    return { success: true }
  })
  // 渲染层任务接缝：claim 抢占执行权（先到先得，避免多窗口重复执行）
  registerIpc('agent:renderer-claim', (payload) => {
    const { id, taskId } = payload || {}
    if (!id || !taskId) throw new IPCError('INVALID_ARGUMENT', '缺少 id/taskId')
    return { claimed: agentLoop.claimRendererTask(String(id), String(taskId)) }
  })
  // 渲染层任务接缝：回传执行结果（{ ok, value | error }）
  registerIpc('agent:renderer-result', (payload) => {
    const { id, taskId, result } = payload || {}
    if (!id || !taskId) throw new IPCError('INVALID_ARGUMENT', '缺少 id/taskId')
    const ok = agentLoop.resolveRendererTask(String(id), String(taskId), result)
    if (!ok) throw new IPCError('NOT_FOUND', `未找到待回传的渲染层任务: ${taskId}`)
    return { success: true }
  })
  // 编排并发意图：AgentBatch 等运行期把「远端大模型并发」拉到自身并发数；结束/停止时撤销
  registerIpc('agent:concurrency:declare', (payload) => {
    const scopeId = String(payload?.scopeId || '').trim()
    const concurrency = Number(payload?.concurrency)
    if (!scopeId || !Number.isFinite(concurrency)) throw new IPCError('INVALID_ARGUMENT', '缺少 scopeId 或非法 concurrency')
    agentLoop.declareRemoteConcurrency(scopeId, concurrency)
    return { success: true }
  })
  registerIpc('agent:concurrency:revoke', (payload) => {
    const scopeId = String(payload?.scopeId || '').trim()
    if (!scopeId) throw new IPCError('INVALID_ARGUMENT', '缺少 scopeId')
    agentLoop.revokeRemoteConcurrency(scopeId)
    return { success: true }
  })
  // 工作流智能体节点：创建 agent → 发送输入 → 等待收敛 → 返回最终 assistant 内容
  registerIpc('agent:run', async (payload) => {
    const { options, input, timeoutMs } = payload || {}
    if (!options?.provider) throw new IPCError('INVALID_ARGUMENT', '缺少 provider')
    return agentLoop.runAgentAndAwait(options, String(input ?? ''), timeoutMs)
  })
  // PTC（Code Mode）：生成模型可见的 SDK 声明文本（渲染进程取回后拼进系统提示词）
  registerIpc('agent:sdkDocs', (payload) => {
    return generateSdkDocs(payload?.scope, payload?.whitelist)
  })

  // ---------------- skill:*（技能多根发现 + watcher） ----------------
  registerIpc('skill:list', (payload) => {
    const roots = payload?.roots
    if (Array.isArray(roots)) skillService.setRoots(roots)
    return skillService.list()
  })
  registerIpc('skill:get', (payload) => {
    const name = payload?.name
    if (!name) throw new IPCError('INVALID_ARGUMENT', '缺少 name')
    const candidate = skillService.get(String(name))
    if (!candidate) throw new IPCError('NOT_FOUND', `技能不存在: ${name}`)
    return candidate
  })
  registerIpc('skill:refresh', () => {
    skillService.refresh()
    return { success: true }
  })

  // ---------------- tools:*（统一工具注册表） ----------------
  registerIpc('tools:list', (payload) => {
    return toolRegistry.snapshot(payload?.scope)
  })
  registerIpc('tools:execute', async (payload) => {
    const { name, input, ctx } = payload || {}
    if (!name) throw new IPCError('INVALID_ARGUMENT', '缺少工具名')
    return toolRegistry.execute(String(name), input, ctx || {})
  })

  // ---------------- jobs:*（后台任务运行时，路线图 2.4） ----------------
  registerIpc('jobs:list', () => jobRegistry.list())
  registerIpc('jobs:get', (payload) => {
    const id = payload?.id
    if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少 id')
    return jobRegistry.get(String(id))
  })
  registerIpc('jobs:cancel', (payload) => {
    const { id, cause } = payload || {}
    if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少 id')
    jobRegistry.cancel(String(id), cause)
    return { success: true }
  })
  // 渲染进程长任务注册/上报（知识库构建、本体抽取等；owner 可传页面/会话标识）
  registerIpc('jobs:start', (payload) => {
    const { kind, owner, title } = payload || {}
    if (!kind || typeof kind !== 'string' || !title || typeof title !== 'string') {
      throw new IPCError('INVALID_ARGUMENT', '缺少 kind/title')
    }
    return jobRegistry.start(String(kind), String(owner || 'renderer'), String(title))
  })
  registerIpc('jobs:progress', (payload) => {
    const { id, progress, detail } = payload || {}
    if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少 id')
    jobRegistry.progress(String(id), typeof progress === 'number' ? progress : null, detail)
    return { success: true }
  })
  registerIpc('jobs:complete', (payload) => {
    const { id, result } = payload || {}
    if (!id) throw new IPCError('INVALID_ARGUMENT', '缺少 id')
    jobRegistry.complete(String(id), result)
    return { success: true }
  })
  registerIpc('jobs:fail', (payload) => {
    const { id, error } = payload || {}
    if (!id || !error) throw new IPCError('INVALID_ARGUMENT', '缺少 id/error')
    jobRegistry.fail(String(id), String(error))
    return { success: true }
  })

  // ---------------- credentials:*（凭据接缝，路线图 2.3） ----------------
  registerIpc('credentials:list', () => credentialStore.list())
  registerIpc('credentials:set', (payload) => {
    const { name, value } = payload || {}
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new IPCError('INVALID_ARGUMENT', '缺少凭据名 name')
    }
    if (!value || typeof value !== 'string') {
      throw new IPCError('INVALID_ARGUMENT', '缺少凭据值 value')
    }
    return credentialStore.set(name.trim(), value)
  })
  registerIpc('credentials:delete', (payload) => {
    const { name } = payload || {}
    if (!name || typeof name !== 'string') throw new IPCError('INVALID_ARGUMENT', '缺少凭据名 name')
    return { success: credentialStore.delete(name) }
  })
  // 请求时按操作解析：渲染进程在发起 LLM 请求前用它把 apiKeyRef 换成明文
  // （仅用于构造请求头；管理 UI 仍只见脱敏信息）
  registerIpc('credentials:resolve', (payload) => {
    const { name } = payload || {}
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new IPCError('INVALID_ARGUMENT', '缺少凭据名 name')
    }
    return { value: credentialStore.resolveValue(name.trim()) }
  })

  // ---------------- interfaceConfig:*（界面配置随软件分发） ----------------
  // 开启后界面配置保存到软件根目录 interface-config.json，便于整机换机分发；
  // 开发版落在项目根目录，打包版落在 exe 所在目录。
  registerIpc('interfaceConfig:save', (payload) => {
    const config = payload?.config
    if (!config || typeof config !== 'object') throw new IPCError('INVALID_ARGUMENT', '缺少 config')
    const file = getInterfaceConfigPath()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
      return { success: true, path: file }
    } catch (err: any) {
      throw new IPCError('IO_ERROR', `写入界面配置文件失败: ${err?.message || err}`)
    }
  })
  registerIpc('interfaceConfig:load', () => {
    const file = getInterfaceConfigPath()
    if (!fs.existsSync(file)) return null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  })
  registerIpc('interfaceConfig:path', () => getInterfaceConfigPath())
}

/** 软件根目录下的界面配置文件路径（生产=exe 所在目录；开发=项目根目录） */
function getInterfaceConfigPath(): string {
  const rootDir = process.env.VITE_DEV_SERVER_URL
    ? path.join(__dirname, '../..') // electron/main → 项目根
    : path.dirname(app.getPath('exe'))
  return path.join(rootDir, 'interface-config.json')
}
