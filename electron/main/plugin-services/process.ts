/**
 * process.ts — `ctx.process`（P3）
 *
 * 只接受**二进制 + 参数数组**，不接受 shell 字符串（字符串要过 shell 解析，等于把注入面
 * 重新打开）。二进制必须在白名单里；每个子进程都登记，插件卸载时杀进程树。
 *
 * 白名单是"减少误用"，不是沙箱：进程内插件仍可自己 `child_process`。诚实边界见方案 R4。
 */

import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { PluginServiceError } from '@/shared/pluginServices'
import type { PluginProcessService, SpawnedProcess } from '@/shared/pluginServices'
import type { PluginLogger } from '@/types/plugin'

/** 允许启动的二进制（basename，小写、去 .exe）。新增要逐条评审。 */
const PROCESS_ALLOWLIST: ReadonlySet<string> = new Set([
  'cloudflared',
  'git',
  'node',
])

/** 单次写出的最大块（防一次 read 把日志/内存打爆） */
const MAX_CHUNK = 64 * 1024

export interface PluginProcessHandle extends PluginProcessService {
  dispose(): void
}

function kindOf(bin: string): string {
  return path.basename(bin).replace(/\.exe$/i, '').toLowerCase()
}

function killTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
      return
    }
    child.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
}

export function createPluginProcess(pluginId: string, log: PluginLogger): PluginProcessHandle {
  const children = new Set<ChildProcess>()

  return {
    spawn(bin: string, args: readonly string[] = [], options = {}): SpawnedProcess {
      const raw = String(bin || '').trim()
      if (!raw) {
        throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', '缺少要启动的程序', { service: 'process' })
      }
      const kind = kindOf(raw)
      if (!PROCESS_ALLOWLIST.has(kind)) {
        throw new PluginServiceError(
          'PLUGIN_PERMISSION_DENIED',
          `不在进程白名单：${kind}（可用的：${Array.from(PROCESS_ALLOWLIST).join(' / ')}）`,
          { service: 'process', permission: 'process.spawn' },
        )
      }
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new PluginServiceError('PLUGIN_INVALID_ARGUMENT', 'args 必须是字符串数组（不要传 shell 命令串）', {
          service: 'process',
        })
      }

      const child = nodeSpawn(raw, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
      children.add(child)
      log.info(`[process] ${pluginId} 启动 ${kind} pid=${child.pid ?? '?'}`)

      let exited = false
      let exitInfo: { code: number | null; signal: string | null } | null = null
      const exitListeners = new Set<(code: number | null, signal: string | null) => void>()

      child.once('exit', (code, signal) => {
        exited = true
        exitInfo = { code, signal }
        children.delete(child)
        for (const cb of Array.from(exitListeners)) {
          try {
            cb(code, signal)
          } catch (e) {
            log.warn(`[process] onExit 监听器异常: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      })

      if (options.signal) {
        const onAbort = () => killTree(child)
        if (options.signal.aborted) onAbort()
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }

      const pipe = (stream: NodeJS.ReadableStream | null, listeners: Set<(chunk: string) => void>) => {
        if (!stream) return () => {}
        const onData = (data: Buffer | string) => {
          const text = String(data)
          const chunk = text.length > MAX_CHUNK ? text.slice(0, MAX_CHUNK) : text
          for (const cb of Array.from(listeners)) {
            try {
              cb(chunk)
            } catch (e) {
              log.warn(`[process] 输出监听器异常: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
        stream.on('data', onData)
        return () => {
          stream.off('data', onData)
        }
      }

      const stdoutListeners = new Set<(chunk: string) => void>()
      const stderrListeners = new Set<(chunk: string) => void>()
      const offStdout = pipe(child.stdout, stdoutListeners)
      const offStderr = pipe(child.stderr, stderrListeners)

      return {
        get pid(): number | undefined {
          return child.pid
        },
        onStdout(listener: (chunk: string) => void): () => void {
          stdoutListeners.add(listener)
          return () => {
            stdoutListeners.delete(listener)
            if (!stdoutListeners.size) offStdout()
          }
        },
        onStderr(listener: (chunk: string) => void): () => void {
          stderrListeners.add(listener)
          return () => {
            stderrListeners.delete(listener)
            if (!stderrListeners.size) offStderr()
          }
        },
        onExit(listener: (code: number | null, signal: string | null) => void): () => void {
          if (exited && exitInfo) {
            const info = exitInfo
            queueMicrotask(() => listener(info.code, info.signal))
            return () => {}
          }
          exitListeners.add(listener)
          return () => {
            exitListeners.delete(listener)
          }
        },
        kill(signal?: string): boolean {
          try {
            if (child.exitCode !== null) return false
            if (signal && process.platform !== 'win32') child.kill(signal as NodeJS.Signals)
            else killTree(child)
            return true
          } catch {
            return false
          }
        },
      }
    },

    dispose(): void {
      for (const child of Array.from(children)) killTree(child)
      children.clear()
    },
  }
}
