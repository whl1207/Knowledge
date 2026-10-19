/**
 * 文件关联（默认打开方式）读写
 * ---------------------------------------------------------------------------
 * 供「设置 → 其他 → 文件关联」使用：读取当前系统里各文件类型的关联状态，并按用户选择改写。
 *
 *  - Windows：写 HKCU\Software\Classes（当前用户，无需管理员）。
 *      · ProgID 与安装程序（electron-builder fileAssociations 的 name）保持一致，
 *        复用同一个 ProgID，避免「打开方式」里出现两个 AI-KM 条目。
 *      · 「设为默认」写扩展名默认值（覆盖前备份原值，取消时还原）；「加入打开方式」只写
 *        OpenWithProgids —— 后者不受 Windows UserChoice 保护限制，是可靠生效的方式。
 *      · Windows 8+ 若用户曾用「打开方式 → 始终使用」选定过默认程序，系统会记录
 *        UserChoice 并优先于我们的注册；这种情况会读取出来在前端提示，程序无法覆盖。
 *  - Linux：读写 ~/.config/mimeapps.list（XDG 规范），配合安装包提供的桌面条目
 *      （deb 装到 /usr/share/applications/<executableName>.desktop，Linux 上 executableName
 *      默认是产品名小写 → ai-km.desktop；旧版 / 手工安装可能是 AI-KM.desktop，两者都探测）。
 *      ⚠️ 桌面条目必须在 MimeType 里声明类型（见 package.json：标准类型走 build.linux.mimeTypes，
 *      两个自定义类型走 build.linux.fileAssociations[].mimeType，后者顺带装上 mime-info 定义），
 *      否则桌面环境不认这个处理程序，写 mimeapps.list 也不会生效。
 *  - macOS：不支持程序化修改，返回提示（由用户在「访达 → 显示简介 → 打开方式」设置）；
 *      安装包在 Info.plist 里声明 CFBundleDocumentTypes（package.json 的 build.mac.fileAssociations，
 *      rank=Alternate，不抢系统默认程序），AI-KM 因此会出现在「打开方式」列表里，双击经 open-file 事件送达。
 */

import { app, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type FileAssocMode = 'none' | 'openwith' | 'default'

export interface FileAssocEntry {
  /** 稳定标识（前端 key） */
  key: string
  labelZh: string
  labelEn: string
  /** 该条目覆盖的扩展名（不含点） */
  exts: string[]
  /** Windows ProgID —— 必须与 package.json build.fileAssociations[].name 一致 */
  progId: string
  /** ProgID 描述 / 默认值（与安装程序写入的一致） */
  desc: string
  /** Linux MIME 类型（缺省表示该类型在 Linux 上不支持由本软件设为默认） */
  mime?: string
  /**
   * 该类型的图标文件名（不含扩展名），资源在 resources/file-icons/<icon>.ico（写注册表用）
   * 与同名 .png（设置页预览用）。各类型图标不同，双击前在资源管理器里就能分清是哪种文件。
   */
  icon: string
}

/**
 * 文件类型清单 —— 顺序即设置页展示顺序。
 *
 * 除 pdf 外均与 package.json 的 build.fileAssociations 一一对应（增删需同步）。
 * pdf 为「可选关联」类型：安装程序**不**注册它（默认不关联系统 PDF 阅读器不会被打断），
 * 只有用户在「设置 → 通用 → 关联」里手动选择后，才由本模块写入注册表 / mimeapps.list。
 * 若将来把 pdf 加入 package.json 的 fileAssociations，请保持 name 与下方 progId 一致，
 * 否则「打开方式」列表会出现重复条目。
 */
export const FILE_ASSOC_ENTRIES: FileAssocEntry[] = [
  { key: 'kb', labelZh: '知识库文件', labelEn: 'Knowledge base', exts: ['kb'], progId: 'AI-KM Knowledge Base', desc: 'AI-KM Knowledge Base', mime: 'application/x-aikm-kb', icon: 'kb' },
  { key: 'md', labelZh: 'Markdown 文档', labelEn: 'Markdown document', exts: ['md', 'markdown', 'mdown', 'mkd'], progId: 'Markdown Document', desc: 'Markdown Document', mime: 'text/markdown', icon: 'md' },
  { key: 'txt', labelZh: '纯文本', labelEn: 'Plain text', exts: ['txt', 'log'], progId: 'Plain Text Document', desc: 'Plain Text Document', mime: 'text/plain', icon: 'txt' },
  { key: 'json', labelZh: 'JSON 文档', labelEn: 'JSON document', exts: ['json', 'jsonc'], progId: 'JSON Document', desc: 'JSON Document', mime: 'application/json', icon: 'json' },
  { key: 'html', labelZh: 'HTML 网页', labelEn: 'HTML document', exts: ['html', 'htm'], progId: 'HTML Document', desc: 'HTML Document', mime: 'text/html', icon: 'html' },
  { key: 'css', labelZh: '样式表（CSS/SCSS/LESS）', labelEn: 'Stylesheet (CSS/SCSS/LESS)', exts: ['css', 'scss', 'less'], progId: 'Stylesheet', desc: 'Stylesheet', mime: 'text/css', icon: 'css' },
  { key: 'xml', labelZh: 'XML 文档', labelEn: 'XML document', exts: ['xml'], progId: 'XML Document', desc: 'XML Document', mime: 'application/xml', icon: 'xml' },
  { key: 'yaml', labelZh: 'YAML 配置', labelEn: 'YAML document', exts: ['yaml', 'yml'], progId: 'YAML Document', desc: 'YAML Document', mime: 'application/x-yaml', icon: 'yaml' },
  { key: 'toml', labelZh: 'TOML 配置', labelEn: 'TOML document', exts: ['toml'], progId: 'TOML Document', desc: 'TOML Document', mime: 'application/toml', icon: 'toml' },
  { key: 'csv', labelZh: 'CSV 表格', labelEn: 'CSV document', exts: ['csv'], progId: 'CSV Document', desc: 'CSV Document', mime: 'text/csv', icon: 'csv' },
  { key: 'pdf', labelZh: 'PDF 文档（可选）', labelEn: 'PDF document (optional)', exts: ['pdf'], progId: 'PDF Document', desc: 'PDF Document', icon: 'pdf' },
  { key: 'ts', labelZh: 'TypeScript / Vue 源码', labelEn: 'TypeScript / Vue source', exts: ['ts', 'tsx', 'vue'], progId: 'TypeScript Source File', desc: 'TypeScript / Vue Source File', icon: 'ts' },
  { key: 'code', labelZh: '其他源码（Java/C/C++/C#/Go/Rust/SQL）', labelEn: 'Other source (Java/C/C++/C#/Go/Rust/SQL)', exts: ['java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'sql'], progId: 'Source Code File', desc: 'Source Code File', icon: 'code' },
  { key: 'excalidraw', labelZh: 'Excalidraw 白板', labelEn: 'Excalidraw drawing', exts: ['excalidraw'], progId: 'Excalidraw Drawing', desc: 'Excalidraw Whiteboard Drawing', mime: 'application/x-excalidraw', icon: 'excalidraw' },
  // 以下 4 类安装包也会注册（见 package.json build.fileAssociations），图标与打开方式同样在此管理
  { key: 'drawio', labelZh: 'draw.io 图表', labelEn: 'draw.io diagram', exts: ['drawio', 'dio'], progId: 'draw.io Diagram', desc: 'draw.io Diagram', icon: 'drawio' },
  { key: 'flow', labelZh: 'AI-KM 工作流', labelEn: 'AI-KM workflow', exts: ['flow', 'workflow'], progId: 'AI-KM Workflow', desc: 'AI-KM Workflow Diagram', icon: 'flow' },
  { key: 'data', labelZh: 'AI-KM 数据画布', labelEn: 'AI-KM data canvas', exts: ['data'], progId: 'AI-KM Data Canvas', desc: 'AI-KM Data Canvas', icon: 'data' },
  { key: 'mmd', labelZh: 'Mermaid 图表', labelEn: 'Mermaid diagram', exts: ['mmd', 'mermaid'], progId: 'Mermaid Diagram', desc: 'Mermaid Diagram Source File', icon: 'mmd' },
]

// ==================== 类型图标资源 ====================

/**
 * 每个文件类型一张自己的图标（彩色文档 + 类型缩写，见 scripts/make-file-icons.py）。
 * 注册表 DefaultIcon 指向这些 .ico；图标复制到 userData 后引用，因为：
 *  - 免安装版的 exe / 资源在临时目录，路径每次运行都变；
 *  - 安装目录可能被用户改到别处，userData 路径始终稳定。
 */
const ICON_DIR_NAME = 'file-icons'

/** 随包分发的图标目录：打包后 <resources>/file-icons，开发时 <项目>/resources/file-icons */
function bundledIconDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, ICON_DIR_NAME)
    : path.join(app.getAppPath(), 'resources', ICON_DIR_NAME)
}

/** 图标落地目录（userData/file-icons）——写进注册表的就是这里的绝对路径 */
function userIconDir(): string {
  return path.join(app.getPath('userData'), ICON_DIR_NAME)
}

let iconDirCache: string | null = null

/**
 * 把图标复制到 userData（已存在且大小一致就跳过），返回落地目录。
 * 源目录不存在时返回 ''（调用方退回软件图标）。
 */
export function ensureFileTypeIcons(): string {
  if (iconDirCache) return iconDirCache
  const src = bundledIconDir()
  if (!fs.existsSync(src)) return ''
  const dst = userIconDir()
  try {
    fs.mkdirSync(dst, { recursive: true })
    for (const e of FILE_ASSOC_ENTRIES) {
      for (const ext of ['.ico', '.png']) {
        const from = path.join(src, e.icon + ext)
        const to = path.join(dst, e.icon + ext)
        if (!fs.existsSync(from)) continue
        const a = fs.statSync(from)
        const b = fs.existsSync(to) ? fs.statSync(to) : null
        // 体积或修改时间不同就重拷（随版本更新的图标能落地）
        if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) fs.copyFileSync(from, to)
      }
    }
    iconDirCache = dst
    return dst
  } catch (err) {
    console.warn('[file-assoc] 复制文件类型图标失败:', err)
    return ''
  }
}

/** 某类型的 .ico 绝对路径（无可用图标时返回 ''） */
function iconPathOf(entry: FileAssocEntry): string {
  const dir = ensureFileTypeIcons()
  if (!dir) return ''
  const p = path.join(dir, entry.icon + '.ico')
  return fs.existsSync(p) ? p : ''
}

/**
 * DefaultIcon 的注册表值：图标文件 + 索引 0。
 * 路径可能带空格 / 中文，必须加引号；拿不到图标时退回「软件自己的图标」。
 */
function defaultIconValue(entry: FileAssocEntry, exe: string): string {
  const p = iconPathOf(entry)
  return p ? `"${p}",0` : `${exe},0`
}

/** 用于比较的规范化：去引号 / 小写 / 去首尾空白 */
function normalizeIconValue(v: string): string {
  return String(v || '').toLowerCase().replace(/"/g, '').trim()
}

/** 设置页预览用的 PNG（data URL）：解 ICO 需要额外的解码器，直接读同名 PNG 更省事 */
let iconUrlCache: Record<string, string> | null = null

export function fileIconDataUrls(): Record<string, string> {
  if (iconUrlCache) return iconUrlCache
  const dir = ensureFileTypeIcons()
  const out: Record<string, string> = {}
  if (!dir) return out
  for (const e of FILE_ASSOC_ENTRIES) {
    try {
      const buf = fs.readFileSync(path.join(dir, e.icon + '.png'))
      out[e.key] = `data:image/png;base64,${buf.toString('base64')}`
    } catch { /* 单个缺失不影响其它类型 */ }
  }
  // 一次运行内图标不会变，缓存起来避免每次读状态都重读 + 重编码
  if (Object.keys(out).length) iconUrlCache = out
  return out
}

/** Linux 下安装包的桌面条目名（electron-builder 用 executableName，Linux 默认 = 产品名小写） */
const DESKTOP_FILE_NAMES = ['ai-km.desktop', 'AI-KM.desktop']
/** 桌面条目可能出现的目录（系统级 + 用户级） */
const DESKTOP_DIRS = ['/usr/share/applications', '/usr/local/share/applications']

export interface FileAssocEntryState {
  /** 当前关联级别 */
  mode: FileAssocMode
  /** Windows UserChoice 记录的默认程序（存在且不是本软件时，双击仍会走它） */
  userChoice?: string
}

export interface FileAssocState {
  platform: NodeJS.Platform
  /** 当前平台是否支持由本软件改写关联 */
  supported: boolean
  /** 不支持时的原因码，由渲染层输出本地化文案 */
  reasonCode: 'ok' | 'macos' | 'no-desktop-entry' | 'no-command' | 'unsupported-platform'
  isPackaged: boolean
  /** 关联命令的目标可执行文件（Windows 用） */
  command: string
  /** 是否提供「加入打开方式列表」这一档（Windows 支持） */
  supportsOpenWith: boolean
  entries: FileAssocEntry[]
  /** key → 状态 */
  states: Record<string, FileAssocEntryState>
  /** key → 该类型图标的 PNG data URL（Windows 才有；设置页在类型名前展示，一眼看出区别） */
  icons?: Record<string, string>
}

// ==================== 通用子进程封装 ====================

interface RunResult { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], env?: Record<string, string>, timeout = 20000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      env: { ...process.env, ...(env || {}) },
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

// ==================== Windows（注册表） ====================

/** 运行 PowerShell 脚本（-EncodedCommand 避免引号/编码问题；参数经环境变量传入） */
async function runPowerShell(script: string, env: Record<string, string>): Promise<RunResult> {
  const prologue = "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
  const encoded = Buffer.from(prologue + script, 'utf16le').toString('base64')
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], env, 30000)
}

/** 批量读取各扩展名的关联状态：入参 map = { ext: progId } */
async function winReadStates(map: Record<string, string>): Promise<Record<string, FileAssocEntryState>> {
  const script = `
$map = $env:FA_MAP | ConvertFrom-Json
$res = [ordered]@{}
foreach ($p in $map.PSObject.Properties) {
  $ext = $p.Name
  $prog = [string]$p.Value
  $mode = 'none'
  $uc = ''
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Classes\\$ext")
  if ($k -ne $null) {
    if ([string]$k.GetValue('') -eq $prog) { $mode = 'default' }
    else {
      $ow = $k.OpenSubKey('OpenWithProgids')
      if ($ow -ne $null) {
        if (@($ow.GetValueNames()) -contains $prog) { $mode = 'openwith' }
        $ow.Close()
      }
    }
    $k.Close()
  }
  $uk = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\$ext\\UserChoice")
  if ($uk -ne $null) {
    $uc = [string]$uk.GetValue('ProgId')
    $uk.Close()
  }
  $res[$ext] = @{ mode = $mode; uc = $uc }
}
$res | ConvertTo-Json -Compress -Depth 5
`.trim()
  const r = await runPowerShell(script, { FA_MAP: JSON.stringify(map) })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'reg query failed').trim())
  const raw = JSON.parse(r.stdout.trim() || '{}')
  const out: Record<string, FileAssocEntryState> = {}
  for (const [ext, v] of Object.entries<any>(raw)) {
    out[ext] = { mode: (v?.mode || 'none') as FileAssocMode, userChoice: v?.uc || undefined }
  }
  return out
}

/** 设置单个扩展名的关联级别 */
async function winSetMode(ext: string, entry: FileAssocEntry, mode: FileAssocMode, exe: string, extraArgs: string, icon: string): Promise<void> {
  const script = `
$ext = $env:FA_EXT
$prog = $env:FA_PROG
$mode = $env:FA_MODE
$exe = $env:FA_EXE
$desc = $env:FA_DESC
$extra = $env:FA_EXTRA
$icon = $env:FA_ICON
$cu = [Microsoft.Win32.Registry]::CurrentUser
$cls = $cu.CreateSubKey("Software\\Classes\\$ext")
$bakName = $prog + '_backup'
if ($mode -eq 'default') {
  $cur = [string]$cls.GetValue('')
  if ($cur -ne $prog) {
    $bak = $cls.GetValue($bakName)
    if ($bak -eq $null) { $cls.SetValue($bakName, $cur, 'String') }
    $cls.SetValue('', $prog, 'String')
  }
} elseif ([string]$cls.GetValue('') -eq $prog) {
  # 从「默认」降级：还原覆盖前的默认值（备份为空则删除默认值）
  $bak = $cls.GetValue($bakName)
  if ($bak -ne $null -and [string]$bak -ne '') { $cls.SetValue('', [string]$bak, 'String') }
  else { $cls.DeleteValue('', $false) }
  $cls.DeleteValue($bakName, $false)
}
if ($mode -eq 'none') {
  $ow = $cls.OpenSubKey('OpenWithProgids', $true)
  if ($ow -ne $null) {
    $ow.DeleteValue($prog, $false)
    if (@($ow.GetValueNames()).Count -eq 0 -and @($ow.GetSubKeyNames()).Count -eq 0) {
      $ow.Close()
      try { $cls.DeleteSubKey('OpenWithProgids', $false) } catch { }
    } else { $ow.Close() }
  }
} else {
  $ow = $cls.CreateSubKey('OpenWithProgids')
  $ow.SetValue($prog, '', 'String')
  $ow.Close()
  # ProgID 定义（可能与其它扩展名共用，保留不删）
  $pk = $cu.CreateSubKey("Software\\Classes\\$prog")
  $pk.SetValue('', $desc, 'String')
  # 每个类型用**自己的**图标（PDF 红色、Markdown 蓝色…），不再是统一的软件图标
  $pk.CreateSubKey('DefaultIcon').SetValue('', $icon, 'String')
  $pk.CreateSubKey('shell').SetValue('', 'open', 'String')
  $pk.CreateSubKey('shell\\open').SetValue('', 'Open with AI-KM', 'String')
  $cmd = '"' + $exe + '" ' + $extra + '"%1"'
  $pk.CreateSubKey('shell\\open\\command').SetValue('', $cmd, 'String')
  $pk.Close()
}
$cls.Close()
# 取消关联后：若扩展名键已无任何值/子键（完全由本软件创建），一并删除
if ($mode -eq 'none') {
  $chk = $cu.OpenSubKey("Software\\Classes\\$ext")
  if ($chk -ne $null) {
    if (@($chk.GetValueNames()).Count -eq 0 -and @($chk.GetSubKeyNames()).Count -eq 0) {
      $chk.Close()
      try { $cu.DeleteSubKey("Software\\Classes\\$ext", $false) } catch { }
    } else { $chk.Close() }
  }
}
try {
  Add-Type -Namespace AIKM -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'
  [AIKM.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch { }
Write-Output 'ok'
`.trim()
  const r = await runPowerShell(script, {
    FA_EXT: ext,
    FA_PROG: entry.progId,
    FA_MODE: mode,
    FA_EXE: exe,
    FA_DESC: entry.desc,
    FA_EXTRA: extraArgs,
    FA_ICON: icon || `${exe},0`,
  })
  if (r.code !== 0 || !/ok/i.test(r.stdout)) {
    throw new Error((r.stderr || r.stdout || 'reg write failed').trim())
  }
}

/**
 * 删除 ProgID 定义键。
 * 调用时机：把某个 ProgID 覆盖的**全部**扩展名都取消关联之后 —— 避免残留指向旧安装路径的
 * shell\open\command（同一 ProgID 可能被多个扩展名共用，所以不能按单个扩展名删）。
 */
async function winDeleteProgId(progId: string): Promise<void> {
  const script = `
$prog = $env:FA_PROG
try { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree("Software\\Classes\\$prog", $false) } catch { }
try {
  Add-Type -Namespace AIKM -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'
  [AIKM.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch { }
Write-Output 'ok'
`.trim()
  const r = await runPowerShell(script, { FA_PROG: progId })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'reg cleanup failed').trim())
}

interface ProgIdInfo {
  /** ProgID 键是否存在 */
  exists: boolean
  /** 当前 DefaultIcon 值 */
  icon: string
  /** 当前 shell\open\command 值 */
  command: string
}

/** 批量读取 ProgID 的 DefaultIcon / 打开命令（一次 PowerShell，避免逐个启动进程） */
async function winReadProgIds(progIds: string[]): Promise<Record<string, ProgIdInfo>> {
  const script = `
$list = $env:FA_PROGS | ConvertFrom-Json
$cu = [Microsoft.Win32.Registry]::CurrentUser
$res = [ordered]@{}
foreach ($p in $list) {
  $info = @{ exists = $false; icon = ''; command = '' }
  $k = $cu.OpenSubKey("Software\\Classes\\$p")
  if ($k -ne $null) {
    $info.exists = $true
    $di = $k.OpenSubKey('DefaultIcon')
    if ($di -ne $null) { $info.icon = [string]$di.GetValue(''); $di.Close() }
    $oc = $k.OpenSubKey('shell\\open\\command')
    if ($oc -ne $null) { $info.command = [string]$oc.GetValue(''); $oc.Close() }
    $k.Close()
  }
  $res[$p] = $info
}
$res | ConvertTo-Json -Compress -Depth 5
`.trim()
  const r = await runPowerShell(script, { FA_PROGS: JSON.stringify(progIds) })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'reg read failed').trim())
  const raw = JSON.parse(r.stdout.trim() || '{}')
  const out: Record<string, ProgIdInfo> = {}
  for (const [prog, v] of Object.entries<any>(raw)) {
    out[prog] = { exists: !!v?.exists, icon: String(v?.icon || ''), command: String(v?.command || '') }
  }
  return out
}

/** 批量改写 DefaultIcon（一次 PowerShell），末尾刷新 shell 图标缓存 */
async function winWriteProgIcons(map: Record<string, string>): Promise<void> {
  if (!Object.keys(map).length) return
  const script = `
$map = $env:FA_ICONS | ConvertFrom-Json
$cu = [Microsoft.Win32.Registry]::CurrentUser
foreach ($p in $map.PSObject.Properties) {
  $k = $cu.CreateSubKey("Software\\Classes\\$($p.Name)\\DefaultIcon")
  $k.SetValue('', [string]$p.Value, 'String')
  $k.Close()
}
try {
  Add-Type -Namespace AIKM -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'
  [AIKM.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch { }
Write-Output 'ok'
`.trim()
  const r = await runPowerShell(script, { FA_ICONS: JSON.stringify(map) })
  if (r.code !== 0 || !/ok/i.test(r.stdout)) {
    throw new Error((r.stderr || r.stdout || 'reg write failed').trim())
  }
}

/**
 * 把「已经关联到本软件」的文件类型的 DefaultIcon 校正为该类型自己的图标。
 *
 * 为什么需要：安装包 / 旧版设置页写入的 DefaultIcon 统一是 `<AI-KM.exe>,0`，于是所有
 * 已关联类型在资源管理器里长得一样。启动时跑一次，用户不必手动把每个类型重设一遍。
 *
 * 只改「确实属于本软件」的 ProgID（打开命令指向本软件的可执行文件），且只在当前图标
 * 为空 / 仍是软件图标 / 指向旧的 file-icons 时才改 —— 用户自己换过的图标不动。
 */
export async function syncFileTypeIcons(): Promise<void> {
  if (process.platform !== 'win32') return
  const dir = ensureFileTypeIcons()
  if (!dir) {
    console.warn('[file-assoc] 未找到文件类型图标资源，跳过图标同步')
    return
  }
  const progIds = [...new Set(FILE_ASSOC_ENTRIES.map(e => e.progId))]
  const info = await winReadProgIds(progIds)
  const exeName = path.basename(process.execPath).toLowerCase()
  const changes: Record<string, string> = {}

  for (const e of FILE_ASSOC_ENTRIES) {
    const st = info[e.progId]
    if (!st?.exists) continue
    // 打开命令不是本软件 → 同名 ProgID 属于别的程序，不碰
    if (!st.command.toLowerCase().includes(exeName)) continue
    const desired = defaultIconValue(e, process.execPath)
    if (!desired.startsWith('"')) continue // 图标文件缺失，保持原样
    const cur = normalizeIconValue(st.icon)
    if (cur === normalizeIconValue(desired)) continue
    const ours = !cur || cur.includes('\\file-icons\\') || cur.includes(exeName)
    if (!ours) continue
    changes[e.progId] = desired
  }

  if (!Object.keys(changes).length) return
  await winWriteProgIcons(changes)
  console.info(`[file-assoc] 已为 ${Object.keys(changes).length} 个文件类型设置各自的图标`)
}

// ==================== Linux（mimeapps.list） ====================

function mimeAppsPath(): string {
  const xdg = (process.env.XDG_CONFIG_HOME || '').trim()
  return path.join(xdg || path.join(os.homedir(), '.config'), 'mimeapps.list')
}

type IniSections = Map<string, Map<string, string>>

function parseIni(text: string): IniSections {
  const sections: IniSections = new Map()
  sections.set('', new Map())
  let cur = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const m = line.match(/^\[(.+)\]$/)
    if (m) {
      cur = m[1].trim()
      if (!sections.has(cur)) sections.set(cur, new Map())
      continue
    }
    const i = line.indexOf('=')
    if (i < 0) continue
    sections.get(cur)!.set(line.slice(0, i).trim(), line.slice(i + 1).trim())
  }
  return sections
}

function serializeIni(sections: IniSections): string {
  const out: string[] = []
  for (const [name, kv] of sections) {
    if (!kv.size) continue
    if (name) out.push(`[${name}]`)
    for (const [k, v] of kv) out.push(`${k}=${v}`)
    out.push('')
  }
  return out.join('\n')
}

function splitList(v: string): string[] {
  return v.split(';').map(s => s.trim()).filter(Boolean)
}

/**
 * 找出实际安装的桌面条目名（写 mimeapps.list 时必须用它，写错名字关联就不生效）。
 * electron-builder 的 deb 把桌面条目装成 `/usr/share/applications/<executableName>.desktop`，
 * 而 Linux 上 executableName 默认是**产品名小写**（ai-km.desktop）；手工安装 / 旧版也可能是
 * 产品名原样（AI-KM.desktop）。两个名字都探测一遍，返回找到的那个。
 */
async function linuxDesktopFileName(): Promise<string | null> {
  const dirs = [...DESKTOP_DIRS, path.join(os.homedir(), '.local/share/applications')]
  for (const name of DESKTOP_FILE_NAMES) {
    for (const dir of dirs) {
      try { if (fs.existsSync(path.join(dir, name))) return name } catch { /* ignore */ }
    }
  }
  return null
}

async function linuxReadMimeStates(): Promise<IniSections> {
  try {
    return parseIni(await fsp.readFile(mimeAppsPath(), 'utf8'))
  } catch {
    return parseIni('')
  }
}

function linuxStateOf(sections: IniSections, mime: string, desktop: string): FileAssocMode {
  const def = splitList(sections.get('Default Applications')?.get(mime) || '')
  if (def[0] === desktop || def.includes(desktop)) return 'default'
  const added = splitList(sections.get('Added Associations')?.get(mime) || '')
  if (added.includes(desktop)) return 'openwith'
  return 'none'
}

async function linuxSetMode(mime: string, mode: FileAssocMode, desktop: string): Promise<void> {
  const file = mimeAppsPath()
  let sections: IniSections
  try {
    sections = parseIni(await fsp.readFile(file, 'utf8'))
  } catch {
    sections = parseIni('')
  }
  const get = (name: string) => {
    if (!sections.has(name)) sections.set(name, new Map())
    return sections.get(name)!
  }
  const setList = (secName: string, list: string[]) => {
    const sec = get(secName)
    if (list.length) sec.set(mime, list.join(';') + ';')
    else sec.delete(mime)
  }

  const defList = splitList(get('Default Applications').get(mime) || '').filter(x => x !== desktop)
  const addList = splitList(get('Added Associations').get(mime) || '').filter(x => x !== desktop)

  if (mode === 'default') {
    setList('Default Applications', [desktop, ...defList])
    setList('Added Associations', [desktop, ...addList])
  } else if (mode === 'openwith') {
    setList('Default Applications', defList)
    setList('Added Associations', [desktop, ...addList])
  } else {
    setList('Default Applications', defList)
    setList('Added Associations', addList)
  }

  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, serializeIni(sections), 'utf8')
}

// ==================== 对外接口 ====================

/** 关联命令：打包版直接指向 exe；开发版指向 electron + 项目路径（仅供调试，会在界面提示） */
function buildCommand(): { command: string; extraArgs: string; ok: boolean } {
  const exe = process.execPath
  if (app.isPackaged) {
    return { command: exe, extraArgs: '', ok: true }
  }
  const appPath = app.getAppPath()
  return { command: exe, extraArgs: `"${appPath}" `, ok: !!appPath }
}

export async function getFileAssocState(): Promise<FileAssocState> {
  const platform = process.platform
  const { command, extraArgs, ok } = buildCommand()
  const base: Omit<FileAssocState, 'supported' | 'reasonCode' | 'states' | 'supportsOpenWith'> = {
    platform,
    isPackaged: app.isPackaged,
    command: ok ? (extraArgs ? `${command} ${extraArgs}"%1"` : `${command} "%1"`) : '',
    entries: FILE_ASSOC_ENTRIES,
  }

  if (platform === 'win32') {
    // 汇总 ext → progId（注册表用带前导点的扩展名键，如 .md），一次性批量读取状态
    const map: Record<string, string> = {}
    for (const e of FILE_ASSOC_ENTRIES) for (const ext of e.exts) map[`.${ext}`] = e.progId
    let byExt: Record<string, FileAssocEntryState> = {}
    try {
      byExt = await winReadStates(map)
    } catch (err) {
      console.warn('[file-assoc] 读取注册表失败:', err)
    }
    const states: Record<string, FileAssocEntryState> = {}
    for (const e of FILE_ASSOC_ENTRIES) {
      // 同一 ProgID 覆盖多个扩展名：取组内「最先匹配到的非 none 状态」，全 none 则为 none
      let mode: FileAssocMode = 'none'
      let userChoice: string | undefined
      for (const ext of e.exts) {
        const s = byExt[`.${ext}`]
        if (!s) continue
        if (s.mode === 'default') mode = 'default'
        else if (s.mode === 'openwith' && mode === 'none') mode = 'openwith'
        if (!userChoice && s.userChoice && s.userChoice !== e.progId) userChoice = s.userChoice
      }
      states[e.key] = { mode, userChoice }
    }
    return {
      ...base,
      supported: true,
      reasonCode: 'ok',
      supportsOpenWith: true,
      states,
      icons: fileIconDataUrls(),
    }
  }

  if (platform === 'linux') {
    const desktop = await linuxDesktopFileName()
    const installed = desktop !== null
    const sections = await linuxReadMimeStates()
    const states: Record<string, FileAssocEntryState> = {}
    for (const e of FILE_ASSOC_ENTRIES) {
      states[e.key] = { mode: e.mime && desktop ? linuxStateOf(sections, e.mime, desktop) : 'none' }
    }
    return {
      ...base,
      supported: installed,
      reasonCode: installed ? 'ok' : 'no-desktop-entry',
      // Linux 没有独立的「加入打开方式列表」档位，统一按默认处理
      supportsOpenWith: false,
      states,
    }
  }

  const reasonCode: FileAssocState['reasonCode'] = platform === 'darwin' ? 'macos' : 'unsupported-platform'
  const states: Record<string, FileAssocEntryState> = {}
  for (const e of FILE_ASSOC_ENTRIES) states[e.key] = { mode: 'none' }
  return { ...base, supported: false, reasonCode, supportsOpenWith: false, states }
}

export async function setFileAssoc(key: string, mode: FileAssocMode): Promise<void> {
  const entry = FILE_ASSOC_ENTRIES.find(e => e.key === key)
  if (!entry) throw new Error(`未知的文件类型: ${key}`)

  if (process.platform === 'win32') {
    const { command, extraArgs, ok } = buildCommand()
    if (!ok) throw new Error('无法确定应用可执行文件路径')
    // 该类型自己的图标（找不到时回退软件图标）
    const icon = defaultIconValue(entry, command)
    // 逐扩展名写入（同一 ProgID 的所有扩展名保持一致；注册表键用带点的扩展名，如 .md）
    for (const ext of entry.exts) {
      await winSetMode(`.${ext}`, entry, mode, command, extraArgs, icon)
    }
    // 全部取消关联后清理 ProgID 定义键（该键为本条目独占，不会影响其它类型）
    if (mode === 'none') await winDeleteProgId(entry.progId)
    return
  }

  if (process.platform === 'linux') {
    if (!entry.mime) throw new Error('该类型在 Linux 上不支持由本软件设置默认打开方式')
    const desktop = await linuxDesktopFileName()
    if (!desktop) throw new Error('未找到桌面条目（ai-km.desktop / AI-KM.desktop），请使用 .deb 安装版')
    await linuxSetMode(entry.mime, mode, desktop)
    return
  }

  throw new Error('当前平台不支持在软件内设置默认打开方式')
}

export function registerFileAssocIpc() {
  ipcMain.handle('file-assoc:get-state', async () => {
    try {
      return { ok: true, data: await getFileAssocState() }
    } catch (err: any) {
      return { ok: false, error: { message: err?.message || String(err) } }
    }
  })

  ipcMain.handle('file-assoc:set', async (_e, payload: { key?: string; mode?: FileAssocMode } = {}) => {
    const key = typeof payload.key === 'string' ? payload.key : ''
    const mode = (payload.mode || 'none') as FileAssocMode
    try {
      await setFileAssoc(key, mode)
      return { ok: true, data: await getFileAssocState() }
    } catch (err: any) {
      return { ok: false, error: { message: err?.message || String(err) } }
    }
  })
}
