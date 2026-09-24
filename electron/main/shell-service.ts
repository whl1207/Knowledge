// electron/main/shell-service.ts
// Shell 命令执行服务（借鉴 Codex exec / shell_command 工具）。
// 安全说明：shell 可执行任意程序，比 Python 危险得多。本服务只负责执行，
// 安全门槛由渲染层控制（agentSkills 的 shell 工具仅在 pythonSandbox === 'trusted' 时放行）。
import { exec } from 'child_process'
import { promisify } from 'util'
import { TextDecoder } from 'util'
import { asUint8 } from './buffer-view'

const execAsync = promisify(exec)

// 智能解码：优先 UTF-8（现代程序/PowerShell），失败回退 GBK（Windows cmd 本地化消息），最后 latin1
// 解决 Windows 下 cmd 内建命令（如 dir、ls 不存在时的错误消息）输出 GBK 导致乱码的问题
function decodeOutput(buf: Buffer | undefined | null): string {
  if (!buf || buf.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(asUint8(buf))
  } catch {
    try {
      return new TextDecoder('gbk').decode(asUint8(buf))
    } catch {
      return buf.toString('latin1')
    }
  }
}

// Shell 执行结果接口
export interface ShellExecutionResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode?: number
  error?: string
  executionTime?: number
}

export class ShellService {
  /**
   * 执行 shell 命令
   * @param command 要执行的命令
   * @param cwd 工作目录（默认主进程 cwd）
   */
  async executeCommand(command: string, cwd?: string): Promise<ShellExecutionResult> {
    const startTime = Date.now()
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 120000, // 120 秒超时
        maxBuffer: 1024 * 1024 * 10, // 10MB 输出限制
        cwd: cwd || process.cwd(), // 工作目录
        windowsHide: true, // Windows 下隐藏控制台窗口
        encoding: 'buffer' // 取原始字节，用 smart decode 解决 GBK/UTF-8 编码问题
      })
      return {
        success: true,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        exitCode: 0,
        executionTime: Date.now() - startTime
      }
    } catch (error: any) {
      // execAsync 在命令退出码非 0 或超时时抛错，error 上附带 stdout/stderr/code（Buffer）
      return {
        success: false,
        stdout: decodeOutput(error?.stdout),
        stderr: decodeOutput(error?.stderr),
        exitCode: typeof error?.code === 'number' ? error.code : undefined,
        error: error?.message || String(error),
        executionTime: Date.now() - startTime
      }
    }
  }
}

export const shellService = new ShellService()
