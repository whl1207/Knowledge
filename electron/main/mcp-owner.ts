/**
 * mcp-owner.ts — MCP 调用的 owner 透传（AsyncLocalStorage）
 *
 * 为什么需要：内置 MCP 服务（如 builtin-browser）走 `mcp_call → InMemoryTransport → Server
 * CallTool handler`，协议本身不携带「是哪个 agent 会话发起的」，导致新建标签没有属主、
 * 会话结束无法精确回收。这里用 ALS 在 `mcp-service.callTool` 的调用栈里带上 owner，
 * 服务端 handler 读取后传给 `browserAgentService.executeTool`。
 *
 * 外部 HTTP MCP（其他软件连进来）没有本进程调用栈，ALS 为空，由服务端自行归到
 * `external:mcp`（与桌面内 agent 的标签隔离）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<{ owner: string }>()

/** 在带 owner 的上下文里执行一次 MCP 调用（owner 为空则原样执行） */
export function runWithMcpOwner<T>(owner: string | undefined, fn: () => Promise<T>): Promise<T> {
  const clean = String(owner || '').trim()
  if (!clean) return fn()
  return storage.run({ owner: clean }, fn)
}

/** 当前 MCP 调用所属的 agent 会话 id（非内置调用路径返回 undefined） */
export function currentMcpOwner(): string | undefined {
  return storage.getStore()?.owner
}
