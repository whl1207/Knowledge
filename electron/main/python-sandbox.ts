// electron/main/python-sandbox.ts
// AI-KM Python-lite 沙箱（梯度 1）：用 Python 解释器自带能力加固执行环境。
//
// 定位：防误用 / 防事故 / 降噪声 —— 不是安全边界（恶意代码可用 ctypes 直调 libc 绕过）。
// 强隔离（防恶意）请使用容器后端（Docker/Podman/WSL2）。
//
// 组成：
//   1. 启动开关 -I -E -P（隔离模式：忽略 PYTHON* 环境变量、不把 cwd 加入 sys.path）
//   2. sitecustomize.py 注入：
//        - resource.setrlimit 资源限制（Unix：CPU/内存/文件数/进程数）
//        - sys.addaudithook 审计钩子（按 sandbox_mode 放行/拒绝 open/子进程/网络等）
//   3. 白名单环境变量（不继承 process.env 全量，避免泄漏 API key 等敏感信息）
import * as fs from 'fs'
import * as path from 'path'

/** Python 启动开关：隔离模式（隐含 -E 忽略环境变量、-P 不加 cwd 到 sys.path） */
export const PYTHON_SANDBOX_FLAGS = ['-I', '-E', '-P']

/** 传给 Python 子进程的白名单环境变量键（刻意不含任何 API key / 敏感配置） */
const ENV_ALLOWLIST = [
  'PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'ProgramData', 'APPDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]

/** 构造 Python 子进程的环境：白名单 + 沙箱标记 + UTF-8 输出。
 *  返回值只包含白名单键（不是 process.env 全量）；而 electron-env.d.ts 把
 *  DIST / VITE_PUBLIC 等声明为 ProcessEnv 必填项，故此处显式断言为 ProcessEnv 以兼容 exec 参数类型。 */
export function buildSandboxEnv(sandboxMode: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {}
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  env.AIKM_SANDBOX_MODE = sandboxMode
  if (extra) Object.assign(env, extra)
  return env as NodeJS.ProcessEnv
}

/**
 * 在指定目录写入 sitecustomize.py（含 setrlimit 资源限制 + audit hook 审计钩子），
 * 返回该目录。执行完成后应由调用方删除整个目录。
 */
export function writeSitecustomizeSandbox(
  dirPath: string,
  _sandboxMode: string,
  opts?: { cpuSec?: number; memBytes?: number; nofile?: number; nproc?: number }
): string {
  fs.mkdirSync(dirPath, { recursive: true })
  const cpu = opts?.cpuSec ?? 120
  const mem = opts?.memBytes ?? 1024 * 1024 * 1024
  const nofile = opts?.nofile ?? 128
  const nproc = opts?.nproc ?? 32
  const source = SITECUSTOMIZE_TEMPLATE
    .replace('__AIKM_CPU_SEC__', String(cpu))
    .replace('__AIKM_MEM_BYTES__', String(mem))
    .replace('__AIKM_NOFILE__', String(nofile))
    .replace('__AIKM_NPROC__', String(nproc))
  fs.writeFileSync(path.join(dirPath, 'sitecustomize.py'), source, 'utf-8')
  return dirPath
}

// sitecustomize.py 模板（占位符 __AIKM_*__ 在 writeSitecustomizeSandbox 中替换为数字字面量）
const SITECUSTOMIZE_TEMPLATE = `# AI-KM Python-lite sandbox (Gradient 1)
# 定位: 防误用 / 防事故 / 降噪声, 不是安全边界（恶意代码可用 ctypes 绕过）。
# 由主进程生成: electron/main/python-sandbox.ts
import os
import sys

_SANDBOX_MODE = os.environ.get('AIKM_SANDBOX_MODE', 'safe')

# ---- -I 隔离模式会禁用 pip install --user 的包，这里把 user site 加回 ----
try:
    import site as _site
    _usp = _site.getusersitepackages()
    if _usp and os.path.isdir(_usp) and _usp not in sys.path:
        sys.path.append(_usp)
except Exception:
    pass

# ---------------- 资源限制 (Unix only) ----------------
try:
    import resource as _resource
    def _setrlimit(which, soft, hard):
        try:
            _resource.setrlimit(which, (soft, hard))
        except Exception:
            pass
    _setrlimit(_resource.RLIMIT_CPU, __AIKM_CPU_SEC__, __AIKM_CPU_SEC__)
    _setrlimit(_resource.RLIMIT_DATA, __AIKM_MEM_BYTES__, __AIKM_MEM_BYTES__)
    _setrlimit(_resource.RLIMIT_NOFILE, __AIKM_NOFILE__, __AIKM_NOFILE__)
    _setrlimit(_resource.RLIMIT_NPROC, __AIKM_NPROC__, __AIKM_NPROC__)
except Exception:
    pass  # Windows: resource 模块不可用

# ---------------- audit hook ----------------
# 已知求解器二进制白名单（workspace 模式放行其子进程；其余子进程仍拒绝）
_SOLVER_BIN = ('cbc', 'cbc.exe', 'glpsol', 'glpsol.exe', 'highs', 'highs.exe',
               'cplex', 'cplex.exe', 'gurobi', 'gurobi.exe', 'scip', 'scip.exe', 'xpress')
_env_solver = os.environ.get('AIKM_SOLVER_WHITELIST', '')
if _env_solver:
    _SOLVER_BIN = _SOLVER_BIN + tuple(x.strip().lower() for x in _env_solver.split(',') if x.strip())

def _is_solver_exec(audit_args):
    # audit 事件 subprocess.Popen 的参数: (executable, args, cwd, env)
    # 注意: args 可能是 list（[可执行, 参数...]），也可能是单个字符串命令行
    #       （pulp 在 Windows 上把整条命令作为字符串传给 Popen）
    exe = audit_args[0] if audit_args else None
    cmd = audit_args[1] if len(audit_args) > 1 else None
    candidate = exe
    if not candidate:
        if isinstance(cmd, (list, tuple)) and cmd:
            candidate = cmd[0]
        elif isinstance(cmd, str):
            _s = cmd.strip()
            if _s.startswith('"'):
                _end = _s.find('"', 1)
                candidate = _s[1:_end] if _end > 0 else _s
            else:
                candidate = _s.split(' ', 1)[0].split('\t', 1)[0]
    if not candidate:
        return False
    name = os.path.basename(str(candidate)).lower()
    if name not in _SOLVER_BIN:
        return False
    # 仅放行随库分发在 site-packages 内的求解器，不放行系统任意同名程序
    return 'site-packages' in str(candidate).replace('\\\\', '/')

def _audit_hook(event, args):
    try:
        # 子进程/系统命令: safe 全拒; workspace 仅放行 site-packages 内已知求解器
        if event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn'):
            if (_SANDBOX_MODE == 'workspace' and event == 'subprocess.Popen'
                    and _is_solver_exec(args)):
                return
            raise PermissionError('AI-KM 沙箱: 禁止启动子进程/系统命令 (' + event + ')')
        if _SANDBOX_MODE == 'safe':
            if event == 'open':
                _path, _mode, _flags = args[0], args[1], args[2]
                # 写标志: O_WRONLY=1 | O_RDWR=2 | O_CREAT=0o100 | O_TRUNC=0o1000 | O_APPEND=0o2000
                _write_bits = 0o1 | 0o2 | 0o100 | 0o1000 | 0o2000
                if isinstance(_flags, int) and (_flags & _write_bits):
                    raise PermissionError('AI-KM 沙箱: safe 模式禁止写入文件 open(' + repr(_path) + ')')
                if isinstance(_mode, str) and any(c in _mode for c in 'wax+'):
                    raise PermissionError('AI-KM 沙箱: safe 模式禁止写入文件 open(' + repr(_path) + ')')
                return
            if event.startswith('socket.'):
                raise PermissionError('AI-KM 沙箱: safe 模式禁止网络访问 (' + event + ')')
            if event in ('os.remove', 'os.unlink', 'os.rename', 'os.rmdir', 'os.mkdir', 'os.makedirs',
                         'os.fork', 'os.forkpty', 'os.open'):
                raise PermissionError('AI-KM 沙箱: safe 模式禁止文件系统写操作 (' + event + ')')
    except PermissionError:
        raise
    except Exception:
        pass

try:
    sys.addaudithook(_audit_hook)
except Exception:
    pass
`
