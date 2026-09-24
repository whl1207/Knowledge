// src/main/trusted-python-service.ts
import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'

const execAsync = promisify(exec)

/** 解析有效的工作目录：cwd 不存在或非目录时回退到主进程当前目录（否则 exec 会报 spawn cmd.exe ENOENT） */
function resolveExecCwd(cwd?: string): string {
  if (cwd) {
    try {
      const st = fs.statSync(cwd)
      if (st.isDirectory()) return cwd
    } catch { /* 无效路径，回退 */ }
  }
  return process.cwd()
}

// Python 执行结果接口
export interface PythonExecutionResult {
  success: boolean
  result?: string
  error?: string
  logs?: string[]
  executionTime?: number
  rawOutput?: string
  output?: string
  captured?: string[]
}

export class TrustedPythonService {
  private pythonCommand: string | null = null
  private isPythonInstalled: boolean = false
  private pythonVersion: string | null = null

  /**
   * 初始化 Python 服务
   */
  async initialize(): Promise<boolean> {
    try {
      // 先尝试 python
      try {
        const { stdout } = await execAsync('python --version', { encoding: 'utf-8' }) // 修复这里
        this.pythonCommand = 'python'
        this.pythonVersion = stdout.trim()
        this.isPythonInstalled = true
      } catch {
        // 再尝试 python3
        try {
          const { stdout } = await execAsync('python3 --version', { encoding: 'utf-8' }) // 修复这里
          this.pythonCommand = 'python3'
          this.pythonVersion = stdout.trim()
          this.isPythonInstalled = true
        } catch {
          this.isPythonInstalled = false
          this.pythonCommand = null
          this.pythonVersion = null
        }
      }

      return this.isPythonInstalled
    } catch (error) {
      console.error('初始化可信 Python 服务失败:', error)
      return false
    }
  }

  /**
   * 检查 Python 是否安装
   */
  async checkInstallation(): Promise<boolean> {
    if (this.pythonCommand !== null) {
      return true
    }
    return await this.initialize()
  }

  /**
   * 执行 Python 代码（无任何安全检查）
   */
  async executeCode(code: string, input: any = '', cwd?: string): Promise<PythonExecutionResult> {
    try {
      const isPythonInstalled = await this.checkInstallation()
      if (!isPythonInstalled) {
        return {
          success: false,
          error: '未检测到 Python 环境，请先安装 Python',
          logs: ['Python 环境未安装']
        }
      }

      // 创建临时文件来执行 Python 代码
      const tempDir = app.getPath('temp')
      const tempFile = path.join(tempDir, `trusted_python_exec_${Date.now()}_${randomUUID().substring(0, 8)}.py`)
      
      // 直接将用户代码写入文件（无任何包装）
      fs.writeFileSync(tempFile, code, 'utf-8')
      
      try {
        const startTime = Date.now()
        
        // 创建带有 UTF-8 编码的环境变量
        const env = {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }
        
        // 准备输入数据
        let inputData = ''
        if (input !== undefined && input !== null && input !== '') {
          if (typeof input === 'object') {
            // 如果是对象，创建临时输入文件
            const inputFile = path.join(tempDir, `input_${Date.now()}.json`)
            fs.writeFileSync(inputFile, JSON.stringify(input, null, 2), 'utf-8')
            
            // 执行时传递输入文件路径作为参数
            const { stdout, stderr } = await execAsync(`${this.pythonCommand} "${tempFile}" "${inputFile}"`, {
              timeout: 3600000, // 1小时超时（给复杂操作更多时间）
              maxBuffer: 1024 * 1024 * 50, // 50MB输出限制
              encoding: 'utf-8', // 明确指定编码
              env: env, // 添加环境变量
              cwd: resolveExecCwd(cwd) // 工作目录（不存在时回退，避免 spawn cmd.exe ENOENT）
            })
            
            // 清理输入文件
            try {
              fs.unlinkSync(inputFile)
            } catch (e) {
              // 忽略清理错误
            }
            
            const executionTime = Date.now() - startTime
            
            return {
              success: true,
              result: stdout.trim(),
              output: stdout.trim(),
              logs: [],
              executionTime: executionTime,
              rawOutput: stdout + (stderr ? `\n${stderr}` : '')
            }
          } else {
            // 如果是字符串，直接作为参数传递
            const escapedInput = JSON.stringify(input)
            const { stdout, stderr } = await execAsync(`${this.pythonCommand} "${tempFile}" ${escapedInput}`, {
              timeout: 300000,
              maxBuffer: 1024 * 1024 * 50,
              encoding: 'utf-8', // 明确指定编码
              env: env, // 添加环境变量
              cwd: resolveExecCwd(cwd) // 工作目录（不存在时回退，避免 spawn cmd.exe ENOENT）
            })
            
            const executionTime = Date.now() - startTime
            
            return {
              success: true,
              result: stdout.trim(),
              output: stdout.trim(),
              logs: [],
              executionTime: executionTime,
              rawOutput: stdout + (stderr ? `\n${stderr}` : '')
            }
          }
        } else {
          // 无输入参数
          const { stdout, stderr } = await execAsync(`${this.pythonCommand} "${tempFile}"`, {
            timeout: 300000,
            maxBuffer: 1024 * 1024 * 50,
            encoding: 'utf-8', // 明确指定编码
            env: env, // 添加环境变量
            cwd: resolveExecCwd(cwd) // 工作目录（不存在时回退，避免 spawn cmd.exe ENOENT）
          })
          
          const executionTime = Date.now() - startTime
          
          return {
            success: true,
            result: stdout.trim(),
            output: stdout.trim(),
            logs: [],
            executionTime: executionTime,
            rawOutput: stdout + (stderr ? `\n${stderr}` : '')
          }
        }
      } catch (execError: any) {
        // 清理临时文件
        try {
          fs.unlinkSync(tempFile)
        } catch (e) {
          // 忽略清理错误
        }
        
        let errorMessage = `Python执行错误: ${execError.message || '未知错误'}`
        
        // 尝试从 stderr 提取更多信息
        if (execError.stderr) {
          errorMessage += `\n${execError.stderr}`
        }
        
        return {
          success: false,
          error: errorMessage,
          logs: [execError.message, execError.stderr].filter(Boolean)
        }
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        logs: [error.message]
      }
    }
  }

  /**
   * 执行 Python 脚本文件
   */
  async executeScript(scriptPath: string, args: string[] = []): Promise<{ 
    success: boolean; 
    output?: string; 
    error?: string;
    scriptPath?: string; // 返回实际使用的路径用于调试
  }> {
    try {
      const isPythonInstalled = await this.checkInstallation()
      if (!isPythonInstalled) {
        return {
          success: false,
          error: '未检测到 Python 环境',
          scriptPath: scriptPath
        }
      }
      
      // 将路径转换为绝对路径
      let absolutePath = scriptPath
      if (!path.isAbsolute(scriptPath)) {
        // 如果是相对路径，基于当前工作目录转换
        absolutePath = path.resolve(process.cwd(), scriptPath)
      }
      
      // 尝试不同方式检查文件
      const exists = fs.existsSync(absolutePath)
      const stats = exists ? fs.statSync(absolutePath) : null
      
      console.log(`检查脚本文件:
      原始路径: ${scriptPath}
      绝对路径: ${absolutePath}
      文件存在: ${exists}
      文件类型: ${stats?.isFile() ? '文件' : stats?.isDirectory() ? '目录' : '未知'}
      文件大小: ${stats?.size} 字节
      `)
      
      if (!exists || !stats?.isFile()) {
        // 列出当前目录文件帮助调试
        const dir = path.dirname(absolutePath)
        let dirContents: string[] = []
        try {
          if (fs.existsSync(dir)) {
            dirContents = fs.readdirSync(dir)
          }
        } catch (e) {
          console.error('无法读取目录:', e)
        }
        
        return {
          success: false,
          error: `脚本文件不存在或不是文件:
          检查路径: ${absolutePath}
          目录内容: ${dirContents.join(', ')}`,
          scriptPath: absolutePath
        }
      }
      
      // 检查文件权限
      try {
        fs.accessSync(absolutePath, fs.constants.R_OK)
      } catch (accessError: any) {
        return {
          success: false,
          error: `无读取权限: ${accessError.message}`,
          scriptPath: absolutePath
        }
      }
      
      // 构建执行命令
      const escapedPath = absolutePath.replace(/"/g, '\\"')
      const argsStr = args.map(arg => {
        // 转义参数中的特殊字符
        const escapedArg = arg.replace(/"/g, '\\"').replace(/'/g, "\\'")
        return `"${escapedArg}"`
      }).join(' ')
      
      const command = `${this.pythonCommand} "${escapedPath}" ${argsStr}`
      console.log('执行命令:', command)
      
      // 创建带有 UTF-8 编码的环境变量
      const env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
      
      const { stdout, stderr } = await execAsync(command, {
        timeout: 300000,
        maxBuffer: 1024 * 1024 * 50,
        cwd: resolveExecCwd(path.dirname(absolutePath)),
        encoding: 'utf-8',
        env: env // 添加环境变量
      })
      
      return {
        success: true,
        output: stdout,
        error: stderr,
        scriptPath: absolutePath
      }
    } catch (error: any) {
      console.error('执行脚本失败:', error)
      return {
        success: false,
        error: error.message,
        scriptPath: scriptPath
      }
    }
  }

  /**
   * 安装 Python 包
   */
  async installPackage(packageName: string): Promise<{ 
    success: boolean; 
    message: string; 
    output?: string; 
    error?: string 
  }> {
    try {
      const isPythonInstalled = await this.checkInstallation()
      if (!isPythonInstalled) {
        return {
          success: false,
          message: '未检测到 Python 环境'
        }
      }
      
      const env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
      
      const { stdout, stderr } = await execAsync(`${this.pythonCommand} -m pip install ${packageName}`, {
        timeout: 180000,
        encoding: 'utf-8', // 添加编码
        env: env // 添加环境变量
      })
      
      return {
        success: true,
        message: `包 ${packageName} 安装成功`,
        output: stdout,
        error: stderr
      }
    } catch (error: any) {
      return {
        success: false,
        message: `包 ${packageName} 安装失败: ${error.message}`,
        error: error.message
      }
    }
  }

  /**
   * 列出已安装的 Python 包
   */
  async listPackages(): Promise<{ 
    success: boolean; 
    packages?: any[]; 
    error?: string 
  }> {
    try {
      const isPythonInstalled = await this.checkInstallation()
      if (!isPythonInstalled) {
        return {
          success: false,
          error: '未检测到 Python 环境'
        }
      }
      
      const env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
      
      const { stdout } = await execAsync(`${this.pythonCommand} -m pip list --format=json`, {
        encoding: 'utf-8', // 添加编码
        env: env // 添加环境变量
      })
      
      const packages = JSON.parse(stdout)
      
      return {
        success: true,
        packages: packages
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  /**
   * 日志记录辅助函数
   */
  private log(...args: any[]): void {
    console.log('[TrustedPythonService]', ...args)
  }
}

// 创建单例实例
export const trustedPythonService = new TrustedPythonService()