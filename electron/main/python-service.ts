// src/main/python-service.ts
import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { buildSandboxEnv, writeSitecustomizeSandbox } from './python-sandbox'

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

// Python 安装状态接口
export interface PythonInstallation {
  installed: boolean
  version: string | null
  command: string | null
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

// Python 包信息接口
export interface PythonPackageInfo {
  name: string
  version: string
}

export class PythonService {
  private pythonCommand: string | null = null
  private isPythonInstalled: boolean = false
  private pythonVersion: string | null = null

  /**
   * 初始化 Python 服务
   */
  async initialize(): Promise<PythonInstallation> {
    try {
      // 先尝试 python
      try {
        const { stdout } = await execAsync('python --version')
        this.pythonCommand = 'python'
        this.pythonVersion = stdout.trim()
        this.isPythonInstalled = true
      } catch {
        // 再尝试 python3
        try {
          const { stdout } = await execAsync('python3 --version')
          this.pythonCommand = 'python3'
          this.pythonVersion = stdout.trim()
          this.isPythonInstalled = true
        } catch {
          this.isPythonInstalled = false
          this.pythonCommand = null
          this.pythonVersion = null
        }
      }

      return {
        installed: this.isPythonInstalled,
        version: this.pythonVersion,
        command: this.pythonCommand
      }
    } catch (error) {
      console.error('初始化 Python 服务失败:', error)
      return {
        installed: false,
        version: null,
        command: null
      }
    }
  }

  /**
   * 检查 Python 是否安装
   */
  async checkInstallation(): Promise<PythonInstallation> {
    if (this.pythonCommand !== null) {
      return {
        installed: true,
        version: this.pythonVersion,
        command: this.pythonCommand
      }
    }
    return await this.initialize()
  }

  /**
   * 执行 Python 代码
   */
  async executeCode(code: string, input: any = '', cwd?: string, sandboxMode: 'safe' | 'workspace' = 'safe'): Promise<PythonExecutionResult> {
    // 梯度 1：Python-lite 沙箱 —— sitecustomize 目录（audit hook + setrlimit），执行后清理
    let sandboxDir: string | null = null
    const cleanupSandbox = () => {
      if (sandboxDir) {
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch (e) { /* ignore */ }
        sandboxDir = null
      }
    }
    try {
      const pythonCheck = await this.checkInstallation()
      if (!pythonCheck.installed) {
        return {
          success: false,
          error: '未检测到 Python 环境，请先安装 Python',
          logs: ['Python 环境未安装']
        }
      }

      // 验证代码安全性（workspace 模式放行文件写入与网络）
      const securityCheck = this.validateCodeSecurity(code, sandboxMode)
      if (!securityCheck.isValid) {
        return {
          success: false,
          error: `代码安全验证失败: ${securityCheck.issues?.join(', ')}`,
          logs: securityCheck.issues || []
        }
      }

      // 创建安全执行的 Python 脚本（支持 pulp 和 gurobipy，按沙箱模式调整限制）
      // 梯度 1：Python-lite 沙箱 —— sitecustomize（audit hook + setrlimit）+ -I -E -P + 白名单 env
      const tempDir = app.getPath('temp')
      sandboxDir = path.join(tempDir, `aikm_sandbox_${Date.now()}_${randomUUID().substring(0, 8)}`)
      try {
        writeSitecustomizeSandbox(sandboxDir, sandboxMode)
      } catch (e) {
        console.warn('[Python沙箱] 写入 sitecustomize 失败，降级为无审计钩子执行:', e)
      }

      const safeScript = this.createSafePythonScript(code, input, sandboxMode, sandboxDir)
      
      // 创建临时文件来执行 Python 代码
      const tempFile = path.join(tempDir, `python_exec_${Date.now()}_${randomUUID().substring(0, 8)}.py`)
      
      fs.writeFileSync(tempFile, safeScript, 'utf-8')
      
      try {
        // 直接执行生成的 Python 脚本（-I 隔离模式隐含 -E -P；白名单 env 防泄漏 API key）
        const { stdout, stderr } = await execAsync(`${pythonCheck.command} -I -E -P "${tempFile}"`, {
          timeout: 180000, // 180秒超时（给优化求解更多时间）
          maxBuffer: 1024 * 1024 * 10, // 10MB输出限制
          env: buildSandboxEnv(sandboxMode),
          cwd: resolveExecCwd(cwd) // 工作目录（不存在时回退，避免 spawn cmd.exe ENOENT）
        })
        
        // 清理临时文件与沙箱目录
        try {
          fs.unlinkSync(tempFile)
        } catch (e) {
          // 忽略清理错误
        }
        cleanupSandbox()
        
        if (stderr && stderr.trim()) {
          console.warn('Python stderr:', stderr)
        }
        
        try {
          // 尝试从 stdout 中提取 JSON 结果
          // 查找最后一个有效的 JSON 对象
          const jsonStart = stdout.lastIndexOf('{')
          const jsonEnd = stdout.lastIndexOf('}') + 1
          
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            const jsonStr = stdout.substring(jsonStart, jsonEnd)
            
            const result = JSON.parse(jsonStr)
            
            return {
              success: result.success !== false,
              result: result.result || result.output || '',
              output: result.output || result.result || '',
              logs: result.logs || [],
              captured: result.captured || [],
              executionTime: result.executionTime || 0,
              rawOutput: stdout
            }
          } else {
            // 如果没有找到 JSON，返回原始输出
            return {
              success: true,
              result: stdout.trim(),
              output: stdout.trim(),
              logs: [],
              rawOutput: stdout
            }
          }
        } catch (parseError) {
          // 如果解析失败，返回原始输出
          return {
            success: true,
            result: stdout.trim(),
            output: stdout.trim(),
            logs: [],
            rawOutput: stdout
          }
        }
      } catch (execError: any) {
        // 清理临时文件与沙箱目录
        try {
          fs.unlinkSync(tempFile)
        } catch (e) {
          // 忽略清理错误
        }
        cleanupSandbox()
        
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
      cleanupSandbox()
      return {
        success: false,
        error: error.message,
        logs: [error.message]
      }
    }
  }

/**
 * 创建安全的 Python 执行脚本（支持 pulp 和 gurobipy 库）
 */
private createSafePythonScript(code: string, input: any, sandboxMode: 'safe' | 'workspace' = 'safe', sandboxHookDir: string | null = null): string {
  // 处理输入数据
  let inputData = input
  if (typeof input === 'string') {
    try {
      // 尝试解析为 JSON，如果失败，则保留为字符串
      inputData = JSON.parse(input)
    } catch {
      // 保持为字符串
      inputData = input
    }
  }
  
  // 将输入数据序列化为安全的 JSON 字符串
  let inputJson = '""' // 默认为空字符串
  
  try {
    if (typeof inputData === 'string') {
      // 如果输入是字符串，直接使用 JSON.stringify 来正确处理转义
      inputJson = JSON.stringify(inputData)
    } else {
      // 如果是对象，正常序列化
      inputJson = JSON.stringify(inputData)
    }
  } catch (error) {
    console.error('序列化输入失败:', error)
    inputJson = '""'
  }
  
  // 将代码序列化为安全的 JSON 字符串
  const escapedCode = JSON.stringify(code)
  
  // 创建 Python 脚本模板，使用 Python 字符串处理而不是 JavaScript 正则表达式
  return `
import sys
import os
${sandboxHookDir ? `_sandbox_hook_dir = ${JSON.stringify(sandboxHookDir)}
if _sandbox_hook_dir not in sys.path:
    sys.path.insert(0, _sandbox_hook_dir)
import sitecustomize  # AI-KM Python-lite 沙箱（audit hook + setrlimit）
` : ''}
import json
import sys
import traceback
import time
import math
import re
import datetime
import random
import itertools
import collections
import statistics
import io
import csv

# 沙箱模式（借鉴 Codex sandbox_mode）：safe=只读 / workspace=工作区写入（放行文件写入与网络）
sandbox_mode = ${JSON.stringify(sandboxMode)}

# 设置标准输出的编码为 UTF-8
if sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    except:
        pass

# 尝试导入 pulp 库（用于线性规划）
try:
    import pulp
    PULP_AVAILABLE = True
except ImportError:
    PULP_AVAILABLE = False
    pulp = None

# 尝试导入 gurobipy 库（用于高性能优化求解）
try:
    import gurobipy as gp
    from gurobipy import GRB, Model, Var, Constr, LinExpr, QuadExpr
    GUROBI_AVAILABLE = True
except ImportError:
    GUROBI_AVAILABLE = False
    gp = None
    GRB = None

# 尝试导入 numpy 库（处理可能的导入问题）
try:
    # 首先尝试标准导入
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    try:
        # 如果标准导入失败，尝试直接导入核心模块
        import numpy.core as np_core
        # 手动创建 np 对象
        class NumpyStub:
            def __init__(self):
                self.array = lambda *args, **kwargs: list(*args, **kwargs)
                self.zeros = lambda shape: [0] * shape[0] if isinstance(shape, tuple) else [0] * shape
                self.ones = lambda shape: [1] * shape[0] if isinstance(shape, tuple) else [1] * shape
                self.ndarray = list
                self.float64 = float
                self.int64 = int
                # 添加其他常用函数
                self.sum = sum
                self.mean = lambda arr: sum(arr) / len(arr) if len(arr) > 0 else 0
                self.dot = lambda a, b: sum(x*y for x, y in zip(a, b))
                self.linalg = type('obj', (object,), {'norm': lambda x: math.sqrt(sum(xi*xi for xi in x))})
        np = NumpyStub()
        NUMPY_AVAILABLE = True
    except:
        NUMPY_AVAILABLE = False
        np = None

# 尝试导入 pandas 库（用于数据处理）
try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False
    pd = None

# 尝试导入 scipy 科学计算库（优化/线性代数/统计/积分/信号等，workspace 模式放行）
try:
    import scipy
    from scipy import optimize, linalg, stats, integrate, interpolate, signal, sparse, special, ndimage, cluster, fft, constants
    import scipy.io as scipy_io
    SCIPY_AVAILABLE = True
except ImportError:
    SCIPY_AVAILABLE = False
    scipy = None
    optimize = linalg = stats = integrate = interpolate = signal = sparse = special = ndimage = cluster = fft = constants = None
    scipy_io = None

# 尝试导入 matplotlib 绘图库（workspace 模式放行 savefig 写文件）
try:
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib import pyplot as plt
    from matplotlib import cm
    MATPLOTLIB_AVAILABLE = True
except ImportError:
    MATPLOTLIB_AVAILABLE = False
    plt = None
    cm = None

# 尝试导入 sympy 符号计算库
try:
    import sympy
    SYMPY_AVAILABLE = True
except ImportError:
    SYMPY_AVAILABLE = False
    sympy = None

# 尝试导入 seaborn 统计绘图库（基于 matplotlib）
try:
    import seaborn as sns
    SEABORN_AVAILABLE = True
except ImportError:
    SEABORN_AVAILABLE = False
    sns = None

# 安全环境类
class SafeEnvironment:
    def __init__(self, input_data):
        self.logs = []
        self.output_buffer = []  # 用于存储所有输出
        self.start_time = time.time()
        
        # 处理输入数据
        if isinstance(input_data, str):
            # 检查是否看起来像是 pulp 代码
            if 'from pulp import' in input_data or 'import pulp' in input_data:
                self.input = input_data
            else:
                try:
                    # 尝试解析为 JSON
                    self.input = json.loads(input_data)
                except:
                    # 如果解析失败，保持为字符串
                    self.input = input_data
        else:
            self.input = input_data
        
        # 提供安全的导入函数
        self.safe_import = self._safe_import
        
        # 允许的模块及其别名
        self.allowed_modules = {
            'math': math,
            're': re,
            'datetime': datetime,
            'random': random,
            'itertools': itertools,
            'collections': collections,
            'statistics': statistics,
            'json': json,
            'sys': sys,
            'traceback': traceback,
            'time': time,
            'io': io,
            'csv': csv
        }
        
        # 如果可用，添加优化求解库
        if PULP_AVAILABLE:
            self.allowed_modules['pulp'] = pulp
            self.logs.append("pulp 库已加载")
        
        if GUROBI_AVAILABLE:
            self.allowed_modules['gurobipy'] = gp
            self.allowed_modules['gp'] = gp
            # 导入 GRB 的常量
            self.allowed_modules['GRB'] = GRB
            # Gurobi 常用类
            self.allowed_modules['Model'] = Model
            self.allowed_modules['Var'] = Var
            self.allowed_modules['Constr'] = Constr
            self.allowed_modules['LinExpr'] = LinExpr
            self.allowed_modules['QuadExpr'] = QuadExpr
            
            self.logs.append("gurobipy 库已加载")
            # 检查 Gurobi 许可证
            try:
                with gp.Env(empty=True) as env:
                    env.setParam('OutputFlag', 0)
                    env.start()
                    test_model = gp.Model("test", env=env)
                    test_var = test_model.addVar(vtype=GRB.CONTINUOUS, name="x")
                    test_model.update()
                    test_model.dispose()
                self.logs.append("Gurobi 许可证有效")
            except Exception as e:
                self.logs.append(f"Gurobi 许可证检查: {str(e)}")
        
        if NUMPY_AVAILABLE:
            self.allowed_modules['numpy'] = np
            self.allowed_modules['np'] = np
            self.logs.append("numpy 库已加载")
        
        if PANDAS_AVAILABLE:
            self.allowed_modules['pandas'] = pd
            self.allowed_modules['pd'] = pd
            self.logs.append("pandas 库已加载")
        
        # workspace 模式：放行网络模块（requests/urllib）
        if sandbox_mode == 'workspace':
            try:
                import requests
                self.allowed_modules['requests'] = requests
                self.logs.append("requests 库已加载（workspace 模式）")
            except ImportError:
                pass
            try:
                import urllib.request
                self.allowed_modules['urllib'] = urllib.request
                self.allowed_modules['urllib.request'] = urllib.request
                self.logs.append("urllib 库已加载（workspace 模式）")
            except ImportError:
                pass

            # workspace 模式：放行科学计算与绘图库（scipy/matplotlib/sympy/seaborn）
            if SCIPY_AVAILABLE:
                self.allowed_modules['scipy'] = scipy
                self.allowed_modules['scipy.optimize'] = optimize
                self.allowed_modules['scipy.linalg'] = linalg
                self.allowed_modules['scipy.stats'] = stats
                self.allowed_modules['scipy.integrate'] = integrate
                self.allowed_modules['scipy.interpolate'] = interpolate
                self.allowed_modules['scipy.signal'] = signal
                self.allowed_modules['scipy.sparse'] = sparse
                self.allowed_modules['scipy.special'] = special
                self.allowed_modules['scipy.ndimage'] = ndimage
                self.allowed_modules['scipy.cluster'] = cluster
                self.allowed_modules['scipy.fft'] = fft
                self.allowed_modules['scipy.io'] = scipy_io
                self.allowed_modules['scipy.constants'] = constants
                self.logs.append("scipy 库已加载（workspace 模式）")
            if MATPLOTLIB_AVAILABLE:
                self.allowed_modules['matplotlib'] = matplotlib
                self.allowed_modules['matplotlib.pyplot'] = plt
                self.allowed_modules['plt'] = plt
                self.allowed_modules['cm'] = cm
                self.logs.append("matplotlib 库已加载（workspace 模式）")
            if SYMPY_AVAILABLE:
                self.allowed_modules['sympy'] = sympy
                self.logs.append("sympy 库已加载（workspace 模式）")
            if SEABORN_AVAILABLE:
                self.allowed_modules['seaborn'] = sns
                self.allowed_modules['sns'] = sns
                self.logs.append("seaborn 库已加载（workspace 模式）")

    def _safe_import(self, name, globals=None, locals=None, fromlist=(), level=0):
        """安全的导入函数，匹配 __import__ 的完整签名"""
        module_name = name

        if module_name in self.allowed_modules:
            module = self.allowed_modules[module_name]
            # import x.y 时 Python 期望返回顶层模块 x（以便把名字 x 绑定到包上）
            if not fromlist and '.' in module_name:
                top = module_name.split('.')[0]
                if top in self.allowed_modules:
                    return self.allowed_modules[top]
            # 直接返回真实模块：from x.y import name 由 Python 的 fromlist 机制负责解析属性
            return module
        else:
            raise ImportError(f"不允许导入模块: {module_name}")
    
    def log(self, *args, **kwargs):
        """日志记录函数"""
        try:
            message = ' '.join(str(arg) for arg in args)
            if kwargs:
                message += ' ' + str(kwargs)
            # 避免 Unicode 字符可能引起的问题
            safe_message = message.encode('utf-8', errors='replace').decode('utf-8')
            self.logs.append(safe_message)
        except Exception as e:
            self.logs.append(f"日志记录错误: {str(e)}")
    
    def capture_output(self, text):
        """捕获输出"""
        if text and text.strip():
            clean_text = text.rstrip('\\n')
            # 确保文本是安全的 UTF-8 字符串
            try:
                safe_text = clean_text.encode('utf-8', errors='replace').decode('utf-8')
                self.output_buffer.append(safe_text)
            except:
                self.output_buffer.append(str(clean_text))
    
    def execute(self, code):
        """执行用户代码"""
        try:
            # 记录环境信息
            self.logs.append(f"Python 版本: {sys.version}")
            self.logs.append(f"输入类型: {type(self.input)}")
            
            if not PULP_AVAILABLE:
                self.logs.append("pulp 库未安装，规划功能将不可用")
            
            if not GUROBI_AVAILABLE:
                self.logs.append("gurobipy 库未安装，Gurobi 求解功能将不可用")
            
            # 创建安全的执行环境
            exec_globals = {
                '__builtins__': {
                    'str': str, 'int': int, 'float': float, 'bool': bool,
                    'list': list, 'dict': dict, 'tuple': tuple, 'set': set,
                    'len': len, 'range': range, 'enumerate': enumerate,
                    'zip': zip, 'sorted': sorted, 'reversed': reversed,
                    'abs': abs, 'max': max, 'min': min, 'sum': sum,
                    'round': round, 'pow': pow, 'divmod': divmod,
                    'isinstance': isinstance, 'type': type, 'repr': repr,
                    'hasattr': hasattr, 'getattr': getattr, 'setattr': setattr,
                    '__import__': self.safe_import,
                    'print': lambda *args, **kwargs: self._custom_print(*args, **kwargs),
                    'input': lambda prompt="": str(self.input),
                    # 添加 map 函数支持
                    'map': map,
                    'filter': filter,
                    # 添加其他常用内置函数
                    'any': any, 'all': all,
                    'chr': chr, 'ord': ord,
                    'bin': bin, 'hex': hex, 'oct': oct,
                    'dir': dir, 'id': id,
                    'callable': callable,
                    'issubclass': issubclass,
                    'iter': iter, 'next': next,
                    'slice': slice,
                    'super': super,
                    'property': property,
                    'staticmethod': staticmethod,
                    'classmethod': classmethod
                },
                # workspace 模式：放行文件读写（open）
                **({'open': open} if sandbox_mode == 'workspace' else {}),
                'input': self.input,
                'log': self.log,
                'json': json,
                'math': math,
                're': re,
                'datetime': datetime,
                'random': random,
                'itertools': itertools,
                'collections': collections,
                'statistics': statistics,
                'sys': sys,
                'traceback': traceback,
                'time': time,
                'io': io,
                # 添加 map 函数到全局命名空间
                'map': map,
                'filter': filter,
                'any': any,
                'all': all
            }
            
            # 添加可用的科学计算库和优化库
            if PULP_AVAILABLE:
                exec_globals['pulp'] = pulp
                self.logs.append("在环境中添加 pulp 库")
            
            if GUROBI_AVAILABLE:
                exec_globals['gurobipy'] = gp
                exec_globals['gp'] = gp
                exec_globals['GRB'] = GRB
                exec_globals['Model'] = Model
                exec_globals['Var'] = Var
                exec_globals['Constr'] = Constr
                exec_globals['LinExpr'] = LinExpr
                exec_globals['QuadExpr'] = QuadExpr
                self.logs.append("在环境中添加 gurobipy 库")
            
            if NUMPY_AVAILABLE:
                exec_globals['numpy'] = np
                exec_globals['np'] = np
                self.logs.append("在环境中添加 numpy 库")
            
            if PANDAS_AVAILABLE:
                exec_globals['pandas'] = pd
                exec_globals['pd'] = pd
                self.logs.append("在环境中添加 pandas 库")

            # workspace 模式：把科学计算/绘图库注入全局命名空间，用户可免 import 直接使用
            if sandbox_mode == 'workspace':
                if SCIPY_AVAILABLE:
                    exec_globals['scipy'] = scipy
                    exec_globals['scipy.optimize'] = optimize
                    exec_globals['scipy.linalg'] = linalg
                    exec_globals['scipy.stats'] = stats
                    exec_globals['scipy.integrate'] = integrate
                    exec_globals['scipy.interpolate'] = interpolate
                    exec_globals['scipy.signal'] = signal
                    exec_globals['scipy.sparse'] = sparse
                    exec_globals['scipy.special'] = special
                    exec_globals['scipy.ndimage'] = ndimage
                    exec_globals['scipy.cluster'] = cluster
                    exec_globals['scipy.fft'] = fft
                    exec_globals['scipy.io'] = scipy_io
                    exec_globals['scipy.constants'] = constants
                    self.logs.append("在环境中添加 scipy 库")
                if MATPLOTLIB_AVAILABLE:
                    exec_globals['matplotlib'] = matplotlib
                    exec_globals['matplotlib.pyplot'] = plt
                    exec_globals['plt'] = plt
                    exec_globals['cm'] = cm
                    self.logs.append("在环境中添加 matplotlib 库")
                if SYMPY_AVAILABLE:
                    exec_globals['sympy'] = sympy
                    self.logs.append("在环境中添加 sympy 库")
                if SEABORN_AVAILABLE:
                    exec_globals['seaborn'] = sns
                    exec_globals['sns'] = sns
                    self.logs.append("在环境中添加 seaborn 库")
            
            # 自定义 print 函数
            def custom_print(*args, **kwargs):
                sep = kwargs.get('sep', ' ')
                end = kwargs.get('end', '\\n')
                file = kwargs.get('file', None)
                flush = kwargs.get('flush', False)
                
                message = sep.join(str(arg) for arg in args)
                if end:
                    message += end
                
                # 只捕获输出，不输出到实际的标准输出
                self.capture_output(message.rstrip('\\n'))
            
            exec_globals['__builtins__']['print'] = custom_print
            
            # 检查代码安全性（简化检查，重点阻止危险操作）
            self._check_code_safety(code)
            
            # 执行用户代码
            exec(code, exec_globals)
            
            # 获取用户可能设置的 result 变量
            user_result = exec_globals.get('result', '')
            user_output = exec_globals.get('output', '')
            
            execution_time = time.time() - self.start_time
            
            # 准备结果 - 优先使用捕获的输出
            result_output = '\\n'.join(self.output_buffer) if self.output_buffer else ''
            
            # 如果用户显式设置了 output 变量，使用它
            if user_output and isinstance(user_output, str):
                result_output = user_output if not result_output else result_output + '\\n' + user_output
            # 其次使用 result 变量
            elif user_result and not result_output:
                try:
                    result_output = str(user_result)
                except:
                    pass
            
            self.logs.append(f"执行时间: {execution_time:.4f}秒")
            self.logs.append("执行完成")
            
            return {
                "success": True,
                "result": result_output,
                "output": result_output,
                "logs": self.logs,
                "executionTime": execution_time,
                "captured": self.output_buffer
            }
            
        except Exception as e:
            error_type = type(e).__name__
            error_msg = str(e)
            tb_lines = traceback.format_exc().split('\\n')
            
            self.logs.append(f"错误类型: {error_type}")
            self.logs.append(f"错误信息: {error_msg}")
            
            for line in tb_lines:
                if line.strip():
                    self.logs.append(f"追踪: {line}")
            
            return {
                "success": False,
                "error": error_msg,
                "errorType": error_type,
                "logs": self.logs,
                "traceback": tb_lines,
                "executionTime": time.time() - self.start_time
            }
    
    def _custom_print(self, *args, **kwargs):
        """自定义的 print 函数"""
        sep = kwargs.get('sep', ' ')
        end = kwargs.get('end', '\\n')
        message = sep.join(str(arg) for arg in args)
        # 确保消息是安全的字符串
        try:
            safe_message = message.encode('utf-8', errors='replace').decode('utf-8')
            self.capture_output(safe_message)
        except:
            self.capture_output(message)
    
    def _check_code_safety(self, code: str):
        """简化的代码安全检查，主要阻止危险操作（workspace 模式放行文件写入与网络）"""
        # 基础危险操作（所有模式均禁止：系统级/动态执行/反序列化等）
        dangerous_patterns = [
            (r'os\\.', '操作系统访问'),
            (r'subprocess\\.', '子进程执行'),
            (r'exec\\(', '动态代码执行'),
            (r'eval\\(', '动态代码执行'),
            (r'__import__\\(', '动态导入'),
            (r'compile\\(', '代码编译'),
            (r'socket\\.', '网络套接字'),
            (r'shutil\\.', '文件操作'),
            (r'pickle\\.', '序列化'),
            (r'__getattribute__\\(', '属性访问'),
            (r'__setattr__\\(', '属性设置'),
            (r'__delattr__\\(', '属性删除'),
        ]
        
        # safe（只读）模式额外禁止：文件写入与网络请求
        if sandbox_mode != 'workspace':
            dangerous_patterns += [
                (r'open\\(', '文件操作'),
                (r'requests\\.', '网络请求'),
                (r'urllib\\.', '网络请求'),
                (r'http\\.', 'HTTP协议'),
            ]
        
        for pattern, desc in dangerous_patterns:
            if re.search(pattern, code, re.IGNORECASE):
                raise SecurityError(f"安全检查失败: 检测到 {desc}")

class SecurityError(Exception):
    """安全错误"""
    pass

def safe_json_dumps(obj):
    """安全的 JSON 序列化，处理编码问题"""
    try:
        # 尝试使用 ensure_ascii=False 输出 Unicode
        return json.dumps(obj, ensure_ascii=False)
    except UnicodeEncodeError:
        # 如果失败，回退到 ensure_ascii=True
        return json.dumps(obj, ensure_ascii=True)

def main():
    try:
        # 设置标准输出的编码为 UTF-8
        import sys
        import io
        
        # 强制设置标准输出为 UTF-8
        if sys.stdout.encoding != 'utf-8':
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        
        # 解析输入数据
        input_data_raw = ${inputJson}
        
        # 解析代码
        user_code = ${escapedCode}
        
        # 创建安全环境并执行
        env = SafeEnvironment(input_data_raw)
        result = env.execute(user_code)
        
        # 使用安全的 JSON 输出
        output_json = safe_json_dumps(result)
        
        # 直接打印，不通过 print 函数
        sys.stdout.write(output_json)
        sys.stdout.write('\\n')
        sys.stdout.flush()
        
    except Exception as e:
        error_result = {
            "success": False,
            "error": f"脚本执行失败: {str(e)}",
            "logs": [str(e)],
            "traceback": traceback.format_exc().split('\\n')
        }
        # 使用安全的 JSON 输出
        output_json = safe_json_dumps(error_result)
        sys.stdout.write(output_json)
        sys.stdout.write('\\n')
        sys.stdout.flush()

if __name__ == "__main__":
    main()
`
}

  /**
   * 安装必要的 Python 包（包括 pulp 和 gurobipy）
   */
  async installRequiredPackages(): Promise<{ 
    success: boolean; 
    message: string; 
    details: {[key: string]: string}
  }> {
    try {
      const pythonCheck = await this.checkInstallation()
      if (!pythonCheck.installed) {
        return {
          success: false,
          message: '未检测到 Python 环境',
          details: {}
        }
      }
      
      const packages = ['pulp', 'numpy']
      const results: {[key: string]: string} = {}
      
      // 注意：gurobipy 通常需要商业许可证，我们不自动安装它
      // 但可以检查是否已安装
      try {
        const { stdout } = await execAsync(`${pythonCheck.command} -m pip show gurobipy`)
        if (stdout.includes('Version:')) {
          results['gurobipy'] = '已安装（需要独立许可证）'
        } else {
          results['gurobipy'] = '未安装（需要商业许可证）'
        }
      } catch {
        results['gurobipy'] = '未安装（需要商业许可证）'
      }
      
      for (const pkg of packages) {
        try {
          // 先检查是否已安装
          const { stdout } = await execAsync(`${pythonCheck.command} -m pip show ${pkg}`)
          if (stdout.includes('Version:')) {
            results[pkg] = '已安装'
            continue
          }
        } catch {
          // 未安装，继续安装
        }
        
        try {
          this.log(`正在安装 ${pkg}...`)
          const { stdout, stderr } = await execAsync(`${pythonCheck.command} -m pip install ${pkg} --user`, {
            timeout: 120000 // 120秒超时
          })
          
          if (stderr && stderr.includes('ERROR')) {
            results[pkg] = `安装失败: ${stderr.split('\\n')[0]}`
          } else {
            results[pkg] = '安装成功'
          }
        } catch (error: any) {
          results[pkg] = `安装失败: ${error.message}`
        }
      }
      
      return {
        success: true,
        message: '包安装完成',
        details: results
      }
    } catch (error: any) {
      return {
        success: false,
        message: `安装过程出错: ${error.message}`,
        details: {}
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
      const pythonCheck = await this.checkInstallation()
      if (!pythonCheck.installed) {
        return {
          success: false,
          message: '未检测到 Python 环境'
        }
      }
      
      // 检查是否是允许安装的包
      const allowedPackages = ['pulp', 'numpy', 'scipy', 'pandas', 'matplotlib', 'gurobipy']
      const normalizedPackageName = packageName.toLowerCase()
      if (!allowedPackages.includes(normalizedPackageName)) {
        return {
          success: false,
          message: `包 ${packageName} 不在允许安装列表中`
        }
      }
      
      // 对于 gurobipy，需要额外提示
      if (normalizedPackageName === 'gurobipy') {
        // 检查是否已有许可证
        try {
          const { stdout } = await execAsync(`${pythonCheck.command} -c "import gurobipy; print('GUROBI_AVAILABLE')"`, {
            timeout: 10000
          })
          if (stdout.includes('GUROBI_AVAILABLE')) {
            return {
              success: true,
              message: 'gurobipy 已安装且许可证有效'
            }
          }
        } catch {
          // 继续安装
        }
        
        // 提示用户 gurobipy 需要商业许可证
        const confirmMessage = `gurobipy 需要商业许可证。您确认要安装吗？安装后需要配置 Gurobi 许可证。`
        
        // 这里实际应用中应该弹出用户确认对话框
        console.warn(confirmMessage)
      }
      
      const { stdout, stderr } = await execAsync(`${pythonCheck.command} -m pip install ${packageName}`, {
        timeout: 120000 // 120秒超时
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
    packages?: PythonPackageInfo[]; 
    error?: string 
  }> {
    try {
      const pythonCheck = await this.checkInstallation()
      if (!pythonCheck.installed) {
        return {
          success: false,
          error: '未检测到 Python 环境'
        }
      }
      
      const { stdout } = await execAsync(`${pythonCheck.command} -m pip list --format=json`)
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
   * 执行 Python 脚本文件
   */
  async executeScript(scriptPath: string, args: string[] = []): Promise<{ 
    success: boolean; 
    output?: string; 
    error?: string 
  }> {
    try {
      const pythonCheck = await this.checkInstallation()
      if (!pythonCheck.installed) {
        return {
          success: false,
          error: '未检测到 Python 环境'
        }
      }
      
      if (!fs.existsSync(scriptPath)) {
        return {
          success: false,
          error: '脚本文件不存在'
        }
      }
      
      const argsStr = args.map(arg => `"${arg}"`).join(' ')
      const { stdout, stderr } = await execAsync(`${pythonCheck.command} "${scriptPath}" ${argsStr}`, {
        timeout: 180000, // 180秒超时（给优化求解更多时间）
        maxBuffer: 1024 * 1024 * 10 // 10MB输出限制
      })
      
      return {
        success: true,
        output: stdout,
        error: stderr
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

/**
 * 验证 Python 代码安全性
 */
validateCodeSecurity(code: string, sandboxMode: 'safe' | 'workspace' = 'safe'): { 
  isValid: boolean; 
  issues?: string[] 
} {
  const issues: string[] = []
  
  // workspace 模式放行文件写入（open）与网络（requests/urllib），仍禁系统级操作
  const allowNetworkAndFiles = sandboxMode === 'workspace'
  
  // 禁止的危险模块（基础安全）
  const dangerousModules = allowNetworkAndFiles
    ? ['os', 'subprocess', 'shutil', 'socket', 'webbrowser', 'pickle', 'eval', 'exec', '__import__']
    : ['os', 'subprocess', 'shutil', 'socket', 'requests', 'urllib', 'webbrowser', 'pickle', 'eval', 'exec', '__import__', 'open']
  
  // 检查危险模块的导入
  for (const module of dangerousModules) {
    const regex = new RegExp(`(import\\s+${module}|from\\s+${module}\\s+import|__import__\\(\\s*['"]${module}['"])`, 'i')
    if (regex.test(code)) {
      issues.push(`禁止导入模块: ${module}`)
    }
  }
  
  // 检查危险函数调用（workspace 放行 open(）
  const dangerousCalls = allowNetworkAndFiles
    ? ['exec\\(', 'eval\\(', 'compile\\(', '__import__\\(', 'getattr\\(', 'setattr\\(', 'os\\.', 'sys\\.', 'subprocess\\.', 'shutil\\.', 'socket\\.']
    : ['open\\(', 'exec\\(', 'eval\\(', 'compile\\(', '__import__\\(', 'getattr\\(', 'setattr\\(', 'os\\.', 'sys\\.', 'subprocess\\.', 'shutil\\.', 'socket\\.']
  
  for (const call of dangerousCalls) {
    const regex = new RegExp(call, 'i')
    if (regex.test(code)) {
      issues.push(`禁止调用危险函数: ${call.replace('\\', '')}`)
    }
  }
  
  // 导入检查：危险模块已在上面拦截；其余导入按"已知安全库宽放 + 未知名库放行并提示"处理。
  // 不做"不在白名单即拒绝"——Python 生态庞大，白名单必然误伤合法库
  // （如 import linprog / import csv / import sqlite3），应允许运行由运行时层 _check_code_safety 兜底。
  // 常见安全库（科学计算 / 数据分析 / 可视化 / 优化求解 / 常用标准库）
  const knownSafeLibs = [
    // 科学计算与优化
    'numpy', 'scipy', 'pandas', 'matplotlib', 'pulp', 'gurobipy', 'linprog', 'ortools', 'cvxpy', 'sympy',
    'sklearn', 'scikit', 'statsmodels', 'pymoo', 'deap', 'z3', 'pulp_lp', 'mip',
    // 标准库（无害常用）
    'math', 'json', 'time', 'datetime', 're', 'random', 'itertools', 'collections', 'statistics',
    'functools', 'operator', 'copy', 'textwrap', 'string', 'decimal', 'fractions', 'enum',
    'pathlib', 'glob', 'csv', 'sqlite3', 'io', 'base64', 'binascii', 'hashlib', 'uuid',
    'typing', 'dataclasses', 'abc', 'warnings', 'logging', 'traceback', 'sys',
    // 网络（workspace 模式放行）
    'requests', 'urllib', 'http', 'httpx', 'aiohttp', 'bs4', 'beautifulsoup', 'lxml', 'html.parser', 'json',
  ]
  const importRegex = /(import\s+([\w\s,]+)|from\s+([\w.]+)\s+import)/gi;
  const imports = code.match(importRegex);

  if (imports) {
    imports.forEach(importStmt => {
      const trimmed = importStmt.trim()
      // __future__ 一律放行
      if (trimmed.includes('__future__')) return
      // 从导入语句中提取目标模块名（from x.y import z → x.y；import a, b → a）
      const fromMatch = /^from\s+([\w.]+)/i.exec(trimmed)
      const importMatch = /^import\s+([\w]+)/i.exec(trimmed)
      const targetModule = (fromMatch?.[1] || importMatch?.[1] || '').toLowerCase()
      if (!targetModule) return
      // 危险模块已在上方拦截，这里直接跳过（双保险）
      if (dangerousModules.some((m) => targetModule === m || targetModule.startsWith(m + '.'))) return
      // 已知安全库：放行
      if (knownSafeLibs.some((lib) => targetModule === lib || targetModule.startsWith(lib + '.'))) return
      // 其余未知名导入：放行（运行时层 _check_code_safety 仍会拦截危险调用），仅提示
      issues.push(`注意: 未知名导入 ${trimmed}`)
    })
  }
  
  // 将"注意"类提示与硬性错误区分：未知名导入不阻塞执行
  const fatalIssues = issues.filter(i => i.startsWith('禁止'))
  const warningIssues = issues.filter(i => i.startsWith('注意'))
  if (fatalIssues.length > 0) {
    return { isValid: false, issues: fatalIssues }
  }
  return {
    isValid: true,
    issues: warningIssues.length > 0 ? warningIssues : undefined
  }
}

  /**
   * 检查 Gurobi 可用性
   */
  async checkGurobiAvailability(): Promise<{
    available: boolean;
    version?: string;
    licenseStatus?: string;
    message: string;
  }> {
    try {
      const pythonCheck = await this.checkInstallation()
      if (!pythonCheck.installed) {
        return {
          available: false,
          message: 'Python 环境未安装'
        }
      }

      // 创建检查脚本
      const checkScript = `
try:
    import gurobipy as gp
    from gurobipy import GRB
    
    # 获取版本信息
    version = gp.gurobi.version()
    
    # 检查许可证
    try:
        with gp.Env(empty=True) as env:
            env.setParam('OutputFlag', 0)
            env.start()
            model = gp.Model("license_check", env=env)
            x = model.addVar(vtype=GRB.CONTINUOUS, name="x")
            model.update()
            model.dispose()
        license_status = "有效"
    except Exception as e:
        license_status = f"问题: {str(e)}"
    
    print(f"GUROBI_VERSION:{version}")
    print(f"GUROBI_LICENSE:{license_status}")
    print("GUROBI_AVAILABLE:True")
    
except ImportError:
    print("GUROBI_AVAILABLE:False")
except Exception as e:
    print(f"GUROBI_ERROR:{str(e)}")
`

      const tempDir = app.getPath('temp')
      const tempFile = path.join(tempDir, `gurobi_check_${Date.now()}.py`)
      fs.writeFileSync(tempFile, checkScript, 'utf-8')

      try {
        const { stdout } = await execAsync(`${pythonCheck.command} "${tempFile}"`, {
          timeout: 3600000
        })

        // 清理临时文件
        fs.unlinkSync(tempFile)

        if (stdout.includes('GUROBI_AVAILABLE:True')) {
          const lines = stdout.split('\n')
          let version = '未知'
          let licenseStatus = '未知'

          for (const line of lines) {
            if (line.startsWith('GUROBI_VERSION:')) {
              version = line.substring('GUROBI_VERSION:'.length)
            } else if (line.startsWith('GUROBI_LICENSE:')) {
              licenseStatus = line.substring('GUROBI_LICENSE:'.length)
            }
          }

          return {
            available: true,
            version,
            licenseStatus,
            message: `Gurobi ${version} 已安装，许可证状态: ${licenseStatus}`
          }
        } else {
          return {
            available: false,
            message: 'gurobipy 未安装或导入失败'
          }
        }
      } catch (error: any) {
        return {
          available: false,
          message: `检查失败: ${error.message}`
        }
      }
    } catch (error: any) {
      return {
        available: false,
        message: `检查过程出错: ${error.message}`
      }
    }
  }

  /**
   * 日志记录辅助函数
   */
  private log(...args: any[]): void {
    console.log('[PythonService]', ...args)
  }
}

// 创建单例实例
export const pythonService = new PythonService()