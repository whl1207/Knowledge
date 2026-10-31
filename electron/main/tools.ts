/**
 * tools.ts — 主进程核心工具注册（统一工具注册表的第一个消费者）
 *
 * 在 `toolRegistry` 上注册一组模型可调用的核心工具。它们与 skill 步骤、
 * 工作流节点共用同一套执行管线（pre/execute/post）与统一 `ToolResult`。
 *
 * 设计约束：
 * - **路径围栏**：read_file/write_file/list_dir 在提供 `ctx.cwd`（工作区根）
 *   时拒绝越界访问（fail-closed），未提供 cwd 时退化为全盘可读（对齐旧的
 *   渲染进程行为，未来由沙箱策略接管）；
 * - **结果统一**：一律返回 `{ ok, value | error }`，错误不外泄堆栈；
 * - 新增工具 = 在 `registerCoreTools` 里加一行 `toolRegistry.register(...)`。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, BrowserWindow } from 'electron'
// 主进程是 Node 环境：pdfjs 必须用 legacy 构建（现代构建会在导入时警告并要求换 legacy）
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs'
import xlsx from 'xlsx'
import { toolRegistry, defineTool } from '@/shared/toolRegistry'
import type { ToolResult, ToolExecutionContext } from '@/types/tool'
import { pythonService } from './python-service'
import { wordToMarkdown } from './office/word-to-markdown'
import {
  shellService,
  startShell,
  resolveShellKind,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
  type ShellExecutionResult,
  type ShellRun,
} from './shell-service'
import { renderShellText } from '@/shared/shellText'
import { trustedPythonService } from './trusted-python-service'
import { logInfo } from './log'
import { resolvePolicy, isShellAllowed } from './sandbox-policy'
import { retrieveKnowledge } from '@/shared/kbRetrieval'
import { keywordSearchBlocks } from '@/services/learningSearch'
import { isBotChallengePage, extractDoiFromUrl, fetchDoiViaCrossref } from '@/shared/webFetchHelpers'
import { computeEditDiff, makeEditDiffPreview, countTextLines, EDIT_DIFF_MAX_CHARS, type EditDiffFilePreview } from '@/shared/editDiff'
import { toolResultBudgetForWindow } from '@/shared/toolResultBudget'
import {
  runDeepSeekSearchApi,
  runDeepSeekFetchApi,
} from '@/shared/deepseekApi'
import {
  normalizeWebFetchConfig,
  normalizeDeepSeekFetchConfig,
  enabledWebFetchChannels,
  webFetchChannelMeta,
  type WebFetchConfig,
} from '@/shared/webFetch'
import { skillService } from './skill-service'
import { requestQuestions, requestPlanReview, setAgentPlan, setAgentTodos, getAgentTodos, createAgent, getAgent, disposeAgent, awaitAgentTurn, requestRendererTask } from './agent-loop'
import { globFilesInRoot, searchFilesInRoot, SEARCH_FILES_DESCRIPTION } from './file-search'
import { saveSpillText } from './tool-spill'
import { jobRegistry } from './job-registry'
import { parseTodoList } from '@/shared/agentTodo'
import { parseAskQuestions, askAnswersToModel, askAnswersText } from '@/shared/agentAsk'
import { planReviewMessage } from '@/shared/agentPlanReview'
import type { TodoItem } from '@/types/agent'
import { sessionLog } from './session-log'
import { mcpService } from './mcp-service'
import { browserAgentService } from './browser-agent'
import { asUint8 } from './buffer-view'
import {
  atomicWrite,
  stageWrite,
  commitStagedChecked,
  commitStagedCreateIfAbsent,
  discardStagedWrite,
  type StagedWrite,
} from './atomic-write'
import { broadcastFileChanged } from './file-change-broadcast'
import { setWorkingDir, workingDirKey, cwdFor } from './working-directory'
import { getReadCache, setReadCache } from './read-cache'
import { READ_MAX_LINES, renderReadWindow } from '@/shared/readWindow'
import {
  applyLiteralEdits,
  locateLiteralMatches,
  type LiteralEdit,
  type LiteralMatch,
} from '@/shared/literalEdit'
import { RUN_CODE_DESCRIPTION, RUN_CODE_INPUT_SCHEMA, runCodeHandler } from './code-sdk'
import { excludeFromAppZoom } from './window-zoom'
import { registerTeamTools } from './team-tools'
import {
  normalizeWebSearchConfig,
  normalizeDeepSeekSearchConfig,
  findWebSearchCustomSource,
  webSearchProviderMeta,
  type WebSearchConfig,
  type WebSearchCustomSource,
  type WebSearchItem,
  type WebSearchProviderId,
  type WebSearchRunResult,
} from '@/shared/webSearch'
import {
  buildFirecrawlSearchRequest,
  firecrawlErrorMessage,
  parseFirecrawlSearchResponse,
} from '@/shared/webSearchFirecrawl'

// ---------------------------------------------------------------------------
// 路径围栏
// ---------------------------------------------------------------------------

/** 读取类文件大小上限（100KB）：超大文件的"开头样本"按这个量取 */
const READ_CAP_BYTES = 100 * 1024
/** 纯文本可整文件读入内存的上限（超过则只给开头样本 + run_python 引导） */
const TEXT_FULL_READ_MAX_BYTES = 16 * 1024 * 1024
/** 单次读取的正文字符硬上限（再大就只按行分页，不一次吐完） */
const MAX_READ_CHARS = 100 * 1024

/**
 * 单次读取的**默认**窗口（字符）：跟随该窗口下工具结果的有界预算（复刻 DSH 的 `read` 分页）。
 *
 * 为什么不能固定 100KB：这些字符最后会被 `toolResultBudget` 掐到该窗口的 ~12%，
 * 在 32K 窗口下等于"读进来 100KB、只留下 6KB"——白读一次、白花一次 token，
 * 还多占一轮上下文。让读取窗口跟着预算走，就没有这段浪费。
 *
 * 下限 25KB：窗口未知 / 很大时保持接近原先的手感，避免退化成频繁续读。
 */
const READ_WINDOW_FLOOR_CHARS = 25 * 1024

/** 该会话窗口下 read_file 的默认读取窗口（字符） */
function defaultReadWindowChars(windowTokens?: number): number {
  const budgetChars = toolResultBudgetForWindow(windowTokens).thresholdChars
  return Math.max(READ_WINDOW_FLOOR_CHARS, Math.min(MAX_READ_CHARS, budgetChars))
}

/**
 * 解析并校验路径：
 * - **相对路径**：锚定到 ctx.cwd（工作区根），提供 cwd 时拒绝越界（fail-closed）；
 * - **绝对路径**（含 Windows 驱动器路径如 `D:\`、`D:/`）：视为用户显式授权
 *   （如用户要求查看 D 盘 / 指定文件路径），放行；
 * - **驱动器相对路径**（如 `D:`）：归一化为该驱动器根目录 `D:\`（Windows
 *   上 `path.isAbsolute('D:')` 为 false，若不处理会被误当相对路径解析到工作区）。
 * 返回绝对路径；非法时返回 null。
 */
function resolveWithinCwd(rawPath: string, ctx: ToolExecutionContext): string | null {
  if (!rawPath) return null
  // Windows 驱动器相对路径（如 D:）→ 驱动器根目录
  const driveMatch = /^([a-zA-Z]):$/.exec(rawPath.trim())
  if (driveMatch) {
    return `${driveMatch[1]}:${path.sep}`
  }
  if (path.isAbsolute(rawPath)) {
    // 用户显式给出的绝对路径 → 放行（agent 的绝对路径访问视为用户授权）
    return rawPath
  }
  const abs = path.resolve(ctx.cwd || process.cwd(), rawPath)
  if (ctx.cwd) {
    const root = path.resolve(ctx.cwd)
    if (abs !== root && !abs.startsWith(root + path.sep)) return null
  }
  return abs
}

// ---------------------------------------------------------------------------
// 先读后写（对齐 DSH 的 `fs-observation-policy`）
// ---------------------------------------------------------------------------
//
// 为什么需要：模型凭记忆整体重写一个已有文件，是"改坏用户文件"的头号来源——
// 它没读过原文，却用自己想象的内容覆盖。DSH 的做法是让 write/edit 在覆盖前必须
// 有一次成功的 read（记录版本），版本在读取后变了就拒绝并提示重新读。
//
// 这里把同一套语义落在核心文件工具上：
// - read_file 成功 → 记录该文件的 size/mtime/ctime 版本；
// - write_file / replace_in_file / multi_replace 改**已存在**的文件 → 无观察记录则拒绝；
//   有记录但版本已变 → 拒绝并提示重新 read；新建文件不受限制；
// - 本会话内自己刚写过的文件会自动记录新版本，连续修改不需要反复读。
//
// 观察状态只存在内存里，**不跨进程 / 会话持久化**（与 DSH 一致）：恢复会话必须重新读。

/**
 * 是否启用「先读后写」；置 false 或设置环境变量 `AIKM_FS_OBSERVATION=0` 可退回旧行为。
 * （保留逃生口：某些自动化流程会覆盖自己刚生成的文件，不需要交互式读取。）
 */
const FS_OBSERVATION_POLICY = process.env.AIKM_FS_OBSERVATION !== '0'
/** 每个会话最多记住多少个已读文件（超出按最早记录淘汰） */
const OBSERVATION_MAX_FILES = 200
/** 最多保留多少个会话的观察表（防止长进程里 agent 不断新建导致泄漏） */
const OBSERVATION_MAX_OWNERS = 50

interface FileObservation {
  version: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

const observationsByOwner = new Map<string, Map<string, FileObservation>>()

function observationOwner(ctx: ToolExecutionContext): string {
  return String(ctx.agentId || ctx.sessionId || ctx.cwd || 'default')
}

/** 观察表的键：规范化绝对路径（Windows 大小写不敏感，统一小写） */
function observationKey(abs: string): string {
  const p = path.resolve(abs)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function fileVersionOf(st: fs.Stats): string {
  return `${st.size}:${Math.trunc(st.mtimeMs)}:${Math.trunc(st.ctimeMs)}`
}

/** 让本次写入至少把 mtime 推进 1ms：等长覆盖也能产生新版本（版本防护不会静默失效） */
function nextMtimeMs(abs: string): number | undefined {
  try {
    return fs.statSync(abs).mtimeMs + 1
  } catch {
    return undefined
  }
}

function observationTable(owner: string): Map<string, FileObservation> {
  let table = observationsByOwner.get(owner)
  // 重新插入以刷新 Map 的插入顺序：owner 淘汰按"最久未活动"而不是"最早创建"。
  if (table) observationsByOwner.delete(owner)
  if (!table) table = new Map()
  observationsByOwner.set(owner, table)
  return table
}

/** 记录一次成功的读取 / 写入：后续修改以这个版本为基准 */
function noteFileObserved(abs: string, ctx: ToolExecutionContext): void {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) return
    const table = observationTable(observationOwner(ctx))
    const key = observationKey(abs)
    table.delete(key)
    table.set(key, {
      version: fileVersionOf(st),
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
    })
    while (table.size > OBSERVATION_MAX_FILES) {
      const oldest = table.keys().next().value
      if (oldest === undefined) break
      table.delete(oldest)
    }
    while (observationsByOwner.size > OBSERVATION_MAX_OWNERS) {
      const oldestOwner = observationsByOwner.keys().next().value
      if (oldestOwner === undefined) break
      observationsByOwner.delete(oldestOwner)
    }
  } catch {
    /* 记录失败不影响工具本身；下一次修改会按"未观察"处理（fail-closed 的方向是安全的） */
  }
}

/**
 * 门禁结果：放行时把「模型读到的版本」带出来，供提交时做乐观并发（CAS）比对。
 *
 * DSH 的对应设计是 `fs/write-intent` 返回 `{createIfAbsent}` 或 `{replaceIfVersion, version}`，
 * 由 provider 在写锁内原子执行。这里没有独立 provider，就把"版本"透传出来，交给
 * `commitStagedChecked` / `commitStagedCreateIfAbsent` 在提交时校验。
 */
interface MutationGate {
  ok: true
  /** 目标当前是否存在（存在 → replaceIfVersion；不存在 → createIfAbsent） */
  exists: boolean
  /** 读到时的版本（exists=false 时为 null） */
  version: string | null
  /** 是否来自"本会话已读"的记录（false = 无策略 / 非 agent 调用，仅按当前 stat 兜底） */
  observed: boolean
}
type MutationGateResult = MutationGate | { ok: false; error: string }

/**
 * 修改已有文件前的门禁（先读后写 + 版本新鲜度）。
 *
 * 只约束 agent 的智能体循环：工作流 / 插件 / 直接调用没有"会话已读"的概念，
 * 强行要求会误伤正常写入（它们有自己的授权与围栏），这里只回当前版本供 CAS 兜底。
 */
function evaluateMutation(abs: string, ctx: ToolExecutionContext, action: '覆盖' | '修改'): MutationGateResult {
  const statNow = (): { exists: boolean; isFile: boolean; version: string | null } => {
    try {
      const st = fs.statSync(abs)
      return { exists: true, isFile: st.isFile(), version: st.isFile() ? fileVersionOf(st) : null }
    } catch {
      return { exists: false, isFile: false, version: null }
    }
  }

  if (!FS_OBSERVATION_POLICY || !ctx.agentId) {
    const cur = statNow()
    if (cur.exists && !cur.isFile) {
      return { ok: false, error: `无法${action}「${abs}」：目标不是普通文件（是目录或特殊文件）。` }
    }
    return { ok: true, exists: cur.exists, version: cur.version, observed: false }
  }

  const cur = statNow()
  if (!cur.exists) return { ok: true, exists: false, version: null, observed: false }
  if (!cur.isFile) {
    return { ok: false, error: `无法${action}「${abs}」：目标不是普通文件（是目录或特殊文件）。` }
  }
  const rec = observationsByOwner.get(observationOwner(ctx))?.get(observationKey(abs))
  if (!rec) {
    return {
      ok: false,
      error: `拒绝${action}「${abs}」：本会话尚未读取该文件（先读后写策略）。`
        + '请先用 read_file 读取；只改局部优先用 replace_in_file。'
        + '如果确实是整篇重写、不需要保留原内容，read_file 传 limit=1 确认文件存在与版本即可（不必读全文），然后再写入。',
    }
  }
  if (rec.version !== cur.version) {
    return {
      ok: false,
      error: `拒绝${action}「${abs}」：文件在读取后已被修改（版本已变化）。请重新 read_file 后再重试。`,
    }
  }
  return { ok: true, exists: true, version: rec.version, observed: true }
}

/**
 * 修改已有文件前的门禁（旧签名，返回拒绝原因或 null）。
 * 只关心"能不能改"的调用方（replace_in_file / multi_replace）用它；它们随后自己读盘，
 * 并以**自己读到的版本**做提交时 CAS。
 */
function checkMutationObserved(
  abs: string,
  ctx: ToolExecutionContext,
  action: '覆盖' | '修改',
): string | null {
  const gate = evaluateMutation(abs, ctx, action)
  // tsconfig.node.json 未开 strict，判别式联合按 ok 收窄不生效，故按字段是否存在收窄
  return 'error' in gate ? gate.error : null
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/**
 * 按技能名解析技能目录（绝对路径）。
 *
 * 供 read_file / list_dir / search_files 的 `skill` 参数使用：把 `path` 锚定到技能目录，
 * 让 SKILL.md 里 `regulations/x.md` / `references/x.md` 这类相对写法**逐字可用**，
 * 而不必依赖工具 cwd（cwd 恒为用户工作区，见 promptContext / useAgentRun）。
 */
function resolveSkillDir(rawSkill: string): { base?: string; error?: string } {
  const name = String(rawSkill ?? '').trim()
  if (!name) return { error: 'skill 参数为空' }
  const resolved = resolveSkillCandidate(name)
  const candidate = resolved.candidate
  if (!candidate) return { error: `技能不存在: ${name}。${resolved.hint || ''}`.trim() }
  const base = String(candidate.path || '').trim()
  if (!base) return { error: `技能「${candidate.name}」没有可用的目录路径` }
  return { base }
}

/**
 * 解析工具的 path（+ 可选 skill）→ 绝对路径。
 *
 * - **传 `skill`**：`path` 相对该技能目录解析（技能名容错匹配，失败时回可用技能名）；
 *   相对路径越出技能目录时 fail-closed；绝对路径仍按「显式授权」放行。
 * - **不传 `skill`**：与原语义完全一致（绝对路径放行；相对路径锚定工作区根）。
 */
function resolveToolPath(
  rawPath: string,
  rawSkill: unknown,
  ctx: ToolExecutionContext,
): { abs?: string; error?: string } {
  const skillName = String(rawSkill ?? '').trim()
  if (!skillName) {
    const abs = resolveWithinCwd(rawPath, ctx)
    return abs ? { abs } : { error: '路径越界或缺失（path 参数必填）' }
  }
  const dir = resolveSkillDir(skillName)
  const base = dir.base
  if (!base) return { error: dir.error }
  const raw = String(rawPath ?? '').trim() || '.'
  if (path.isAbsolute(raw)) return { abs: raw }
  const abs = path.resolve(base, raw)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { error: `路径越出技能目录: ${raw}（技能「${skillName}」目录：${base}）` }
  }
  return { abs }
}

/** 解析 read_file 的 offset / limit（单位：**行**，1-based；对齐 DSH 的 read） */
function parseLineWindow(input: any): { offsetLine: number; maxLines: number } {
  const rawOffset = Number(input?.offset)
  const offsetLine = Number.isFinite(rawOffset) && rawOffset >= 1 ? Math.floor(rawOffset) : 1
  const rawLimit = Number(input?.limit)
  const maxLines =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), READ_MAX_LINES) : READ_MAX_LINES
  return { offsetLine, maxLines }
}

/** 该会话窗口下 read_file 的正文字符预算（页眉/页脚另留一点余量，免得被二次裁剪砍掉 footer） */
function readWindowCharBudget(ctx: ToolExecutionContext): number {
  return Math.max(4000, defaultReadWindowChars(ctx.windowTokens) - 400)
}

/**
 * 把一段文本渲染成 read_file 的结果。
 *
 * 关键：`modelText` 是**模型看到的原文**（带行号 + footer），由 `serializeToolValue` 直接透传；
 * 其余字段只服务 UI / 日志，不进模型上下文。
 */
function buildReadValue(opts: {
  rawText: string
  displayPath: string
  input: any
  ctx: ToolExecutionContext
  size: number
  format?: string
}): ToolResult {
  const { offsetLine, maxLines } = parseLineWindow(opts.input)
  const label = opts.format ? `${opts.displayPath} · ${opts.format}` : opts.displayPath
  const out = renderReadWindow(opts.rawText, label, {
    offsetLine,
    maxLines,
    maxChars: Math.min(MAX_READ_CHARS, readWindowCharBudget(opts.ctx)),
  })
  // tsconfig.node.json 未开 strict：按字段是否存在收窄
  if ('error' in out) return { ok: false, code: 'FS_NOT_FOUND', error: out.error }
  const w = out.window
  return {
    ok: true,
    value: {
      path: opts.input?.path,
      format: opts.format,
      offset: w.startLine,
      endLine: w.endLine,
      totalLines: w.totalLines,
      nextOffset: w.nextOffset,
      truncated: w.nextOffset !== undefined,
      capped: w.capped,
      size: opts.size,
      // 模型可见的那一份（纯文本，不做 JSON 转义）
      modelText: w.text,
    },
  }
}

async function readFileImpl(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const resolved = resolveToolPath(String(input?.path ?? ''), input?.skill, ctx)
  const abs = resolved.abs
  if (!abs) return { ok: false, error: resolved.error || '路径越界或缺失（path 参数必填）' }
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${input.path}` }
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) return { ok: false, error: `是目录而非文件: ${input.path}` }

    // PDF 文件：用 pdfjs-dist 提取正文文本（不能按 UTF-8 文本读取，否则得到二进制乱码）
    const isPdfExt = /\.pdf$/i.test(abs)
    const headBuf = Buffer.alloc(4)
    const headFd = fs.openSync(abs, 'r')
    const headRead = fs.readSync(headFd, asUint8(headBuf), 0, 4, 0)
    fs.closeSync(headFd)
    const isPdfMagic = headRead >= 4 && headBuf[0] === 0x25 && headBuf[1] === 0x50 && headBuf[2] === 0x44 && headBuf[3] === 0x46 // %PDF
    if (isPdfExt || isPdfMagic) {
      try {
        const pdfText = await parsePdfBytes(new Uint8Array(fs.readFileSync(abs)))
        if (!pdfText || pdfText.trim().length === 0) {
          return { ok: false, error: 'PDF 解析结果为空（可能是扫描件/图片型 PDF，建议改用 OCR）' }
        }
        return buildReadValue({
          rawText: pdfText,
          displayPath: String(input?.path ?? ''),
          input,
          ctx,
          size: stat.size,
          format: 'pdf',
        })
      } catch (e: any) {
        return { ok: false, error: `PDF 解析失败: ${e?.message || String(e)}` }
      }
    }

    // Word 文档：.docx 走 mammoth（标题 atx / 表格管道化），.doc 走 word-extractor（纯文本 + 管道表格）
    const ext = path.extname(abs).toLowerCase()
    if (ext === '.docx' || ext === '.doc') {
      try {
        const docText = await parseWordFile(abs)
        if (!docText || docText.trim().length === 0) {
          return { ok: false, error: 'Word 文档解析结果为空' }
        }
        return buildReadValue({
          rawText: docText,
          displayPath: String(input?.path ?? ''),
          input,
          ctx,
          size: stat.size,
          format: ext === '.docx' ? 'docx' : 'doc',
        })
      } catch (e: any) {
        return { ok: false, error: `Word 解析失败: ${e?.message || String(e)}` }
      }
    }

    // Excel 表格：.xlsx/.xls 用 SheetJS 提取为 Markdown 表格
    if (ext === '.xlsx' || ext === '.xls') {
      try {
        const xlsText = await parseXlsxFile(abs)
        if (!xlsText || xlsText.trim().length === 0) {
          return { ok: false, error: 'Excel 解析结果为空' }
        }
        return buildReadValue({
          rawText: xlsText,
          displayPath: String(input?.path ?? ''),
          input,
          ctx,
          size: stat.size,
          format: ext === '.xlsx' ? 'xlsx' : 'xls',
        })
      } catch (e: any) {
        return { ok: false, error: `Excel 解析失败: ${e?.message || String(e)}` }
      }
    }

    if (stat.size > TEXT_FULL_READ_MAX_BYTES) {
      // 超大文本文件：不整文件读入内存，只给开头样本 + run_python 引导（仍按行号渲染）
      const fd = fs.openSync(abs, 'r')
      const buf = Buffer.alloc(READ_CAP_BYTES)
      const read = fs.readSync(fd, asUint8(buf), 0, READ_CAP_BYTES, 0)
      fs.closeSync(fd)
      // 回退到完整 UTF-8 字符边界，避免末尾出现半截字符
      let cut = read
      while (cut > 0 && cut < read && (buf[cut] & 0xc0) === 0x80) cut--
      const sample = buf.toString('utf-8', 0, cut)
      const out = renderReadWindow(sample, `${String(input?.path ?? '')}（仅前 100KB 样本）`, {
        offsetLine: 1,
        maxLines: READ_MAX_LINES,
        maxChars: readWindowCharBudget(ctx),
      })
      // tsconfig.node.json 未开 strict：按字段是否存在收窄
  if ('error' in out) return { ok: false, code: 'FS_NOT_FOUND', error: out.error }
      const note = `（文件 ${stat.size} 字节，超过 16MB：只返回开头样本，不能按行续读；读取全文请用 run_python）`
      return {
        ok: true,
        value: {
          path: input.path,
          size: stat.size,
          totalLines: out.window.totalLines,
          truncated: true,
          capped: out.window.capped,
          sampleBytes: Buffer.byteLength(sample, 'utf-8'),
          modelText: `${out.window.text}\n${note}`,
        },
      }
    }

    // 普通文本：按「行」窗口切片（对齐 DSH 的 read：offset/limit 都是行号）
    const buf = fs.readFileSync(abs)
    return buildReadValue({
      rawText: buf.toString('utf-8'),
      displayPath: String(input?.path ?? ''),
      input,
      ctx,
      size: stat.size,
    })
  } catch (e: any) {
    return { ok: false, error: `读取失败: ${e?.message || String(e)}` }
  }
}

/** read_file 的"同轮重复读取"短路缓存（实现在 read-cache.ts：与 agent-loop 共用，避免循环 import） */
function readCacheKey(ctx: ToolExecutionContext, abs: string): string {
  return `${String(ctx.agentId || ctx.sessionId || 'default')}|${observationKey(abs)}`
}

/** read_file：主体走 readFileImpl，成功后登记「已读版本」（供先读后写门禁） */
async function readFile(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const force = input?.force === true
  const rawPath = String(input?.path ?? '')
  let abs = ''
  let version = ''
  try {
    const resolved = resolveToolPath(rawPath, input?.skill, ctx)
    if (resolved.abs) {
      abs = resolved.abs
      const st = fs.statSync(abs)
      if (st.isFile()) version = fileVersionOf(st)
    }
  } catch {
    /* 读不到就不走缓存，交给 readFileImpl 报错 */
  }

  // 同一轮内、同一路径、同一窗口、版本没变 → 只回"未变化"，不重发整段正文
  if (abs && version && !force) {
    const hit = getReadCache(readCacheKey(ctx, abs))
    const { offsetLine, maxLines } = parseLineWindow(input)
    if (hit && hit.turn === Number(ctx.turn) && hit.version === version
      && hit.offset === offsetLine && hit.limit === maxLines) {
      return {
        ok: true,
        value: {
          path: input?.path,
          offset: hit.startLine,
          endLine: hit.endLine,
          totalLines: hit.totalLines,
          unchanged: true,
          modelText: `${rawPath}（共 ${hit.totalLines} 行）\n`
            + `（第 ${hit.startLine}-${hit.endLine} 行与本次请求相同，内容未变化，不再重复输出。`
            + '如需重看原文，传 force=true 再读一次。）',
        },
      }
    }
  }

  const result = await readFileImpl(input, ctx)
  if (result.ok) {
    try {
      if (abs) noteFileObserved(abs, ctx)
      const value = result.value as any
      if (abs && value && typeof value.offset === 'number') {
        const { offsetLine, maxLines } = parseLineWindow(input)
        setReadCache(readCacheKey(ctx, abs), {
          turn: Number(ctx.turn) || 0,
          version,
          offset: offsetLine,
          limit: maxLines,
          startLine: value.offset,
          endLine: typeof value.endLine === 'number' ? value.endLine : value.offset,
          totalLines: typeof value.totalLines === 'number' ? value.totalLines : 0,
        })
      }
    } catch {
      /* 缓存只是优化：失败不影响读取结果 */
    }
  }
  return result
}

/**
 * agent 单次写入的字节上限。
 *
 * 这不是"模型的输出上限"（那个由 max_tokens 决定），而是**兜底**：真撞到这个数量级，
 * 说明调用本身就不该走一次 write_file（模型也几乎不可能吐出 1 MiB 参数）。
 * 与其让 IPC / 磁盘慢慢吞下去，不如立刻返回结构化错误，让模型改成分段写或 run_python 生成。
 */
const MAX_AGENT_WRITE_BYTES = 1024 * 1024

async function writeFile(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const abs = resolveWithinCwd(String(input?.path ?? ''), ctx)
  if (!abs) return { ok: false, error: '路径越界或缺失（path 参数必填）' }
  const content = String(input?.content ?? '')
  const rawPath = String(input?.path ?? '')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_AGENT_WRITE_BYTES) {
    return {
      ok: false,
      code: 'CONTENT_TOO_LARGE',
      error: `写入内容过大（${bytes} 字节，单次上限 ${MAX_AGENT_WRITE_BYTES} 字节）：本次没有写入任何内容。`
        + '请拆成多次写入——先 write_file 写骨架，再用 replace_in_file 逐段追加；'
        + '内容能由程序生成时改用 run_python / run_code 直接写文件。',
    }
  }

  // 先读后写门禁；放行时带回"模型读到的版本"，提交阶段据此做 CAS（DSH 的 replaceIfVersion）
  const gate = evaluateMutation(abs, ctx, '覆盖')
  if ('error' in gate) return { ok: false, error: gate.error }

  const before = readOldTextForDiff(abs)

  // 内容未变化：不写盘、不推进 mtime、不触发 watcher（否则界面会弹一个"文件已更新"的假变更）
  if ('text' in before && before.text === content) {
    return {
      ok: true,
      value: {
        path: input.path,
        bytes: content.length,
        byteSize: bytes,
        created: false,
        unchanged: true,
        stats: { added: 0, removed: 0 },
      },
    }
  }

  // 暂存 → 提交（存在：CAS；不存在：create-if-absent，防止盖掉别人刚建的文件）
  let staged: StagedWrite
  try {
    staged = await stageWrite(abs, content, { minMtimeMs: nextMtimeMs(abs) })
  } catch (e: any) {
    return { ok: false, code: 'WRITE_FAILED', error: `写入失败: ${e?.message || String(e)}` }
  }

  const rollback = async (): Promise<boolean> => {
    try {
      if ('text' in before) {
        await atomicWrite(abs, before.text, { minMtimeMs: nextMtimeMs(abs) })
        return true
      }
      if ('missing' in before) {
        fs.rmSync(abs, { force: true })
        return true
      }
    } catch {
      /* 回滚失败：调用方如实报告 */
    }
    return false
  }

  if (gate.exists) {
    const committed = await commitStagedForEdit(staged, gate.version ?? '')
    if ('reason' in committed) {
      if (committed.reason === 'verify') {
        const rolledBack = await rollback()
        return {
          ok: false,
          code: 'WRITE_VERIFY_FAILED',
          error: `${committed.message}${rolledBack ? '；已把原内容写回' : '；回滚未成功，请检查该文件'}`,
        }
      }
      if (committed.reason === 'stale') {
        return {
          ok: false,
          code: 'STALE_VERSION',
          error: `${committed.message}（${rawPath}）；本次写入已放弃，请重新 read_file 后再试。`,
        }
      }
      return { ok: false, code: 'WRITE_FAILED', error: `写入失败: ${committed.message}` }
    }
  } else {
    const created = await commitStagedCreateIfAbsent(staged)
    if ('reason' in created) {
      if (created.reason === 'verify') {
        const rolledBack = await rollback()
        return {
          ok: false,
          code: 'WRITE_VERIFY_FAILED',
          error: `${created.message}${rolledBack ? '；已回滚' : '；回滚未成功，请检查该文件'}`,
        }
      }
      if (created.reason === 'exists') {
        return {
          ok: false,
          code: 'FILE_EXISTS',
          error: `${created.message}（${rawPath}）；本次没有覆盖它。请先 read_file 读一遍，确认后再用 write_file 覆盖。`,
        }
      }
      return { ok: false, code: 'WRITE_FAILED', error: `写入失败: ${created.message}` }
    }
  }

  noteFileObserved(abs, ctx)
  // agent 写盘不走编辑器保存路径，必须自己广播，否则已打开的视图一直是旧内容
  broadcastFileChanged(abs, content)

  // 差异预览：仅在能拿到可读原文时算行级 diff；新建/过大/二进制只给行数摘要
  const created = 'missing' in before
  const diff: EditDiffFilePreview = created
    ? { path: rawPath, absPath: abs, created: true, stats: { added: countTextLines(content), removed: 0 }, lines: [] }
    : 'text' in before
      ? { path: rawPath, absPath: abs, ...computeEditDiff(before.text, content) }
      : { path: rawPath, absPath: abs, lines: [], skipped: before.reason }
  return {
    ok: true,
    value: {
      path: input.path,
      // 字符数（给模型看"写了多少"）；字节数与落盘校验口径一致，便于排查编码差异
      bytes: content.length,
      byteSize: bytes,
      created,
      stats: diff.stats,
    },
    preview: makeEditDiffPreview([diff]),
  }
}

/**
 * 读取写盘前的文件内容（供差异预览）。
 * 不抛异常：不存在 → missing（新建）；目录/过大/二进制 → 返回 reason（跳过 diff）。
 */
function readOldTextForDiff(abs: string): { text: string } | { missing: true } | { reason: 'too-large' | 'binary' } {
  try {
    const st = fs.statSync(abs)
    if (st.isDirectory()) return { reason: 'too-large' }
    if (st.size > EDIT_DIFF_MAX_CHARS) return { reason: 'too-large' }
    const text = fs.readFileSync(abs, 'utf-8')
    if (text.includes('\u0000')) return { reason: 'binary' }
    return { text }
  } catch {
    return { missing: true }
  }
}

// ---------------------------------------------------------------------------
// 精确编辑工具（replace_in_file / multi_replace）
//
// 与 write_file（全量覆盖）互补：模型只给出"待替换原文段 + 新文段"，工具负责
// 定位、唯一性校验与落盘，不改动文件其余部分。语义要点：
// - 匹配以整段精确为准，自动做 EOL 归一（兼容 CRLF/LF 差异）；
// - 默认要求全文唯一（fail-closed：多处命中宁可报错也不猜测，防止"以为改 A 处实际改了
//   B 处"）；`occurrence` 指定第几处，`replace_all` 显式全替换；
// - multi_replace 先对全部条目定位、内存拼装，再**两阶段提交**（全部写临时文件 → 逐个
//   rename，带版本比对），任一环节失败都不会留下"改了一半"的文件。
//
// 换行归一 / 命中收集 / 行号 / 唯一性判定都在 `@/shared/literalEdit`（与渲染层共用一份），
// 这里只负责：读盘 → 定位（带"可复制候选片段"的错误提示）→ 拼装 → 两阶段落盘。
// ---------------------------------------------------------------------------

/**
 * 生成"未命中"提示：给出**可直接复制的候选片段**（让模型“抄作业”），而不只是“附近几行”。
 *
 * 未命中的两个典型形态：① old_string 抄漏/抄多了行；② 行内空白或字词被改写。
 * 做法：以 old_string 中能在文件里对上的行作锚点，按锚点在 old_string 内的偏移回推目标
 * 区域行号，并原样（含缩进）回显锚点附近的片段，明确要求"原样复制"。
 * 回显最多 MAX_HINT_LINES 行，避免"整文件 old_string"把错误信息本身擑爆上下文。
 */
function suggestNearMatch(content: string, oldRaw: string): string {
  const MAX_HINT_LINES = 30
  const oldLines = oldRaw.split(/\r\n|\r|\n/)
  const fileLines = content.split(/\r\n|\r|\n/)
  const fileTrim = fileLines.map((l) => l.trim())

  /** 在文件里找某行（trim 后完全一致）；返回命中行下标（最多 5 个） */
  const findHits = (needle: string): number[] => {
    const hits: number[] = []
    for (let i = 0; i < fileTrim.length && hits.length < 5; i++) {
      if (fileTrim[i] === needle) hits.push(i)
    }
    return hits
  }

  // 锚点：old_string 中最靠前的、能在文件中对上的非平凡行（≥ 4 字符，避免 "}" 之类误命中）
  const tried = new Set<string>()
  for (let k = 0; k < oldLines.length; k++) {
    const anchor = oldLines[k].trim()
    if (anchor.length < 4 || tried.has(anchor)) continue
    tried.add(anchor)
    const hits = findHits(anchor)
    if (!hits.length) continue

    // 按锚点偏移回推"模型想要的区域"，上下各放宽 1 行便于取舍
    const guessStart = Math.max(0, hits[0] - k)
    const guessEnd = Math.min(fileLines.length, guessStart + Math.max(oldLines.length, 1))
    const from = Math.max(0, guessStart - 1)
    const to = Math.min(fileLines.length, Math.max(guessEnd + 1, hits[0] + 2))

    // 回显窗口：以锚点为中心，最多 MAX_HINT_LINES 行
    let s = from
    let e = to
    if (e - s > MAX_HINT_LINES) {
      s = Math.max(from, hits[0] - Math.floor(MAX_HINT_LINES / 2))
      e = Math.min(to, s + MAX_HINT_LINES)
    }

    const lines: string[] = []
    const multi = hits.length > 1 ? `（该行在文件中出现 ${hits.length} 处，请连同上下文一起复制以保证唯一）` : ''
    lines.push(`old_string 第 ${k + 1} 行（\`${anchor}\`）在文件里能对上，但整段无法匹配${multi}。`)
    if (k > 0) {
      lines.push(`注意：你的 old_string 从第 ${k + 1} 行才开始与文件对上（前 ${k} 行在该位置附近不存在）——常见原因是抽漏了文件里的某几行。`)
    }
    lines.push(`文件第 ${guessStart + 1}-${guessEnd} 行大致对应你要改的区域（当前文件共 ${fileLines.length} 行）。`)
    if (s > from || e < to) {
      lines.push(`下面只回显第 ${s + 1}-${e} 行（如需完整区域请 read_file 读该区间）：`)
    } else {
      lines.push('该区域原文如下（原样回显，含缩进）：')
    }
    lines.push('----- 复制开始 -----', fileLines.slice(s, e).join('\n'), '----- 复制结束 -----')
    lines.push('请对上面这段做【原样复制】作为 old_string 重试（只改需要改的行，并保留相邻行以保证唯一）；不要凭记忆手写 old_string。')
    return lines.join('\n')
  }

  // 一行都对不上：退回"前缀包含"模糊匹配（应对行内空白/字词被改写）
  const first = oldLines.find((l) => l.trim().length >= 4)
  if (first) {
    const key = first.trim().slice(0, 24)
    const i = fileTrim.findIndex((t) => key.length >= 8 && t.includes(key))
    if (i >= 0) {
      const s = Math.max(0, i - 2)
      const e = Math.min(fileLines.length, i + 3)
      return [
        `文件里没有与 old_string 完全一致的行；第 ${i + 1} 行附近内容相似：`,
        '----- 复制开始 -----',
        fileLines.slice(s, e).join('\n'),
        '----- 复制结束 -----',
        '请先 read_file 读取该区域，再把要修改的行【原样复制】为 old_string。',
      ].join('\n')
    }
  }
  return ''
}

/** 读取文件文本并做编辑前置校验（仅文本文件允许替换）；`version` 供落盘前做一次乐观并发比对 */
function readTextFileForEdit(
  rawPath: string,
  abs: string,
): { ok: true; text: string; version: string } | { ok: false; error: string } {
  try {
    const st = fs.statSync(abs)
    if (st.isDirectory()) return { ok: false, error: `是目录而非文件: ${rawPath}` }
    const text = fs.readFileSync(abs, 'utf-8')
    if (text.includes('\u0000')) return { ok: false, error: `文件「${rawPath}」疑似二进制（含 NUL 字节），拒绝文本替换。` }
    return { ok: true, text, version: fileVersionOf(st) }
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, error: `文件不存在: ${rawPath}` }
    return { ok: false, error: `读取失败: ${e?.message || String(e)}` }
  }
}

/** 一次定位结果：命中位置 + 新内容（落盘前统一交给 `applyLiteralEdits` 拼装） */
interface LocatedEdit extends LiteralEdit {
  /** 文件绝对路径（按文件分组用） */
  abs: string
  /** 模型给的原始路径（回执 / 预览里显示） */
  rawPath: string
  /** 这条编辑来自入参的第几条（1-based；replace_all 的派生命中沿用同一个序号） */
  entry?: number
}

/**
 * 在单个文件内容中定位替换（`replace_all` 时可能是多笔）。
 *
 * 匹配 / 唯一性 / 换行归一 / 空操作拒绝都在 `@/shared/literalEdit`（与渲染层共用一份），
 * 这里只补"给模型看"的部分：可复制的候选片段、行号、以及下一步该怎么做。
 */
function locateReplacements(
  rawPath: string,
  abs: string,
  content: string,
  oldRaw: string,
  newRaw: string,
  opts: { occurrence?: number; replaceAll?: boolean } = {},
): { ok: true; edits: LocatedEdit[]; hitCount: number } | { ok: false; error: string } {
  const located = locateLiteralMatches(content, oldRaw, newRaw, opts)
  // tsconfig.node.json 未开 strict，判别式联合按 `ok` 收窄不生效，故按字段是否存在收窄
  if ('matches' in located) {
    return {
      ok: true,
      hitCount: located.hitCount,
      edits: located.matches.map((m: LiteralMatch) => ({ ...m, abs, rawPath, newText: located.newText })),
    }
  }
  switch (located.code) {
    case 'EMPTY_OLD':
      return { ok: false, error: `old_string 不能为空（${rawPath}）` }
    case 'NOOP':
      return { ok: false, error: `old_string 与 new_string 相同（${rawPath}）：这次替换不会改变任何内容，已跳过（不会写盘）。` }
    case 'OUT_OF_RANGE':
      return {
        ok: false,
        error: `occurrence=${opts.occurrence} 越界：old_string 在「${rawPath}」中共出现 ${located.hits.length} 处（第 ${located.lines.join('、')} 行；occurrence 从 1 开始）。`,
      }
    case 'AMBIGUOUS':
      return {
        ok: false,
        error: `old_string 在文件「${rawPath}」中出现 ${located.hits.length} 处（第 ${located.lines.join('、')} 行）。为安全起见未执行替换：请补充更多上下文使其唯一，或传 occurrence 指定第几处（从 1 起）；要把这些出现全部替换掉，传 replace_all: true。`,
      }
    default:
      return {
        ok: false,
        error: `old_string 未在文件「${rawPath}」中找到。${suggestNearMatch(content, oldRaw) || '请先用 read_file 读取该文件，再原样复制要修改的片段作为 old_string。'}`,
      }
  }
}

/** 提交一份暂存写入：先做乐观并发比对（版本），再交给 atomic-write 落盘 */
async function commitStagedForEdit(staged: StagedWrite, expectedVersion: string) {
  return await commitStagedChecked(staged, expectedVersion, (st) => fileVersionOf(st as fs.Stats))
}

/** 在内存构造同一文件的一组编辑后的新内容（无 IO，供批量两阶段提交） */
function buildNewContent(
  text: string,
  edits: LocatedEdit[],
  rawPath: string,
): { ok: true; content: string } | { ok: false; error: string } {
  if (edits.length === 0) return { ok: true, content: text }
  const applied = applyLiteralEdits(text, edits)
  if ('text' in applied) return { ok: true, content: applied.text }
  const ordered = [...edits].sort((a, b) => a.index - b.index)
  const at = Math.min(Math.max(applied.index, 0), ordered.length - 1)
  if (applied.reason === 'overlap') {
    const prev = ordered[Math.max(0, at - 1)]
    const cur = ordered[at]
    // 公共片段：两条区间真正重叠的字符（用来告诉模型"撞在哪段代码"）
    const prevEnd = prev.index + prev.length
    const sharedEnd = Math.min(prevEnd, cur.index + cur.length)
    const sharedRaw = sharedEnd > cur.index ? text.slice(cur.index, sharedEnd) : ''
    const shared = sharedRaw.trim().split(/\r?\n/)[0]?.slice(0, 80) || cur.rawPath
    const who = prev.entry && cur.entry && prev.entry !== cur.entry
      ? `第 ${prev.entry} 条与第 ${cur.entry} 条替换`
      : '有两条替换'
    return {
      ok: false,
      error: `文件「${rawPath}」${who}重叠（第 ${Math.min(prev.startLine, cur.startLine)}-${Math.max(prev.startLine, cur.startLine)} 行附近）：`
        + `两条 old_string 都包含「${shared}」。`
        + '请把它们合并成一条（两段都写进同一个 old/new），或让其中一条不要包含这段后重试；'
        + '两条 old_string 不允许共享任何一行。',
    }
  }
  return {
    ok: false,
    error: `文件「${rawPath}」应用第 ${ordered[at]?.startLine ?? '?'} 行替换时校验失败（原文已变化），已整体回滚（未写盘）。`,
  }
}

/** 单点精确替换（replace_in_file）：一个文件的一处（或 replace_all 时全部）替换 */
async function replaceInFile(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const rawPath = String(input?.path ?? '')
  const oldRaw = String(input?.old_string ?? '')
  const newRaw = String(input?.new_string ?? '')
  const abs = resolveWithinCwd(rawPath, ctx)
  if (!abs) return { ok: false, error: '路径越界或缺失（path 参数必填）' }
  const denied = checkMutationObserved(abs, ctx, '修改')
  if (denied) return { ok: false, error: denied }
  const rd = readTextFileForEdit(rawPath, abs)
  if (!rd.ok) return rd
  const occurrence =
    input?.occurrence === undefined || input?.occurrence === null ? undefined : Number(input.occurrence)
  const loc = locateReplacements(rawPath, abs, rd.text, oldRaw, newRaw, {
    occurrence,
    replaceAll: input?.replace_all === true,
  })
  if (!loc.ok) return loc
  const built = buildNewContent(rd.text, loc.edits, rawPath)
  if (!built.ok) return built
  // 差异预览：编辑前文本（rd.text）与编辑后内容（built.content）
  const diff: EditDiffFilePreview = { path: rawPath, absPath: abs, ...computeEditDiff(rd.text, built.content) }

  // 先写临时文件 → 版本比对 → rename：读取之后有人保存过就整笔放弃，不覆盖别人的改动
  let staged: StagedWrite
  try {
    staged = await stageWrite(abs, built.content, { minMtimeMs: nextMtimeMs(abs) })
  } catch (e: any) {
    return { ok: false, error: `写入失败: ${e?.message || String(e)}` }
  }
  const committed = await commitStagedForEdit(staged, rd.version)
  if ('reason' in committed) {
    if (committed.reason === 'verify') {
      // 盘上已是坏文件：把编辑前的原文写回去
      let rolledBack = false
      try {
        await atomicWrite(abs, rd.text, { minMtimeMs: nextMtimeMs(abs) })
        rolledBack = true
      } catch {
        /* 回滚失败如实报告 */
      }
      return {
        ok: false,
        code: 'WRITE_VERIFY_FAILED',
        error: `${committed.message}${rolledBack ? '；已把原内容写回' : '；回滚未成功，请检查该文件'}`,
      }
    }
    if (committed.reason === 'stale' || committed.reason === 'missing') {
      return {
        ok: false,
        code: 'STALE_VERSION',
        error: `${committed.message}（${rawPath}）；本次替换已放弃，请重新 read_file 后重试。`,
      }
    }
    return { ok: false, code: 'WRITE_FAILED', error: `写入失败: ${committed.message}` }
  }
  noteFileObserved(abs, ctx)
  // agent 写盘不走编辑器保存路径，必须自己广播，否则已打开的视图一直是旧内容
  broadcastFileChanged(abs, built.content)

  const first = loc.edits[0]
  const last = loc.edits[loc.edits.length - 1]
  return {
    ok: true,
    value: {
      path: rawPath,
      applied: loc.edits.length,
      changedLines: { start: first.startLine, end: last.endLine },
      locations: loc.edits.map((e) => ({ start: e.startLine, end: e.endLine })),
      deleted: loc.edits.every((e) => e.newText.length === 0),
      stats: diff.stats,
    },
    preview: makeEditDiffPreview([diff]),
  }
}

/**
 * 批量替换（multi_replace）：**整批生效或整批不动**。
 *
 * 两阶段提交（见 `atomic-write.ts` 的 stage/commit）：
 * ① 全部条目先定位、在内存拼出每份新内容（任一条失败 → 一个字节都不写）；
 * ② 全部写成**同目录临时文件**（这一步失败也只是清理临时文件，目标文件没动过）；
 * ③ 逐个做版本比对 + rename（读取后被人保存过 → 整笔放弃）；
 * ④ 提交阶段失败时，用写前内容把已提交的文件回滚。
 *
 * 这与 DSH 的 `replaceIfVersion` 同口径（乐观并发 + 恢复指引），只是把"单文件原子"
 * 扩到了多文件。
 */
async function multiReplace(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const list = Array.isArray(input?.replacements)
    ? input.replacements
    : Array.isArray(input?.edits)
      ? input.edits
      : []
  if (!list.length) return { ok: false, error: 'replacements 参数必填（至少一项，数组形式）' }
  const fallbackPath = String(input?.path ?? '')

  interface FileState {
    rawPath: string
    abs: string
    text: string
    version: string
  }
  interface PendingEdit {
    index: number
    rawPath: string
    oldRaw: string
    newRaw: string
    occurrence?: number
    replaceAll: boolean
    state: FileState
  }

  // 阶段一：解析路径 + 读取文本（同一文件只读一次，并记下读到的版本）
  const fileCache = new Map<string, FileState>()
  const pending: PendingEdit[] = []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (!r || typeof r !== 'object') return { ok: false, error: `第 ${i + 1} 条：替换项必须是对象` }
    const rawPath = String((r as any).path ?? fallbackPath ?? '')
    const oldRaw = String((r as any).old_string ?? '')
    const newRaw = String((r as any).new_string ?? '')
    if (!rawPath) return { ok: false, error: `第 ${i + 1} 条：缺 path（也可在顶层传 path 作为默认路径）` }
    if (!oldRaw) return { ok: false, error: `第 ${i + 1} 条：old_string 不能为空` }
    const abs = resolveWithinCwd(rawPath, ctx)
    if (!abs) return { ok: false, error: `第 ${i + 1} 条：路径越界或缺失: ${rawPath}` }
    const denied = checkMutationObserved(abs, ctx, '修改')
    if (denied) return { ok: false, error: denied }
    let state = fileCache.get(abs)
    if (!state) {
      const rd = readTextFileForEdit(rawPath, abs)
      if (!rd.ok) return rd
      state = { rawPath, abs, text: rd.text, version: rd.version }
      fileCache.set(abs, state)
    }
    const rawOccurrence = (r as any).occurrence
    pending.push({
      index: i,
      rawPath,
      oldRaw,
      newRaw,
      occurrence: rawOccurrence === undefined || rawOccurrence === null ? undefined : Number(rawOccurrence),
      replaceAll: (r as any).replace_all === true,
      state,
    })
  }

  // 阶段二：全部定位（任一条失败 → 整批不落盘；标明第几条，便于模型定位）
  const byFile = new Map<string, { state: FileState; edits: LocatedEdit[] }>()
  for (const p of pending) {
    const loc = locateReplacements(p.rawPath, p.state.abs, p.state.text, p.oldRaw, p.newRaw, {
      occurrence: p.occurrence,
      replaceAll: p.replaceAll,
    })
    if ('error' in loc) return { ok: false, error: `第 ${p.index + 1}/${list.length} 条替换失败：${loc.error}` }
    const bucket = byFile.get(p.state.abs) ?? { state: p.state, edits: [] }
    // 打上"第几条"标记：重叠报错要能直接指回入参，模型才知道该合并哪两条
    bucket.edits.push(...loc.edits.map((ed) => ({ ...ed, entry: p.index + 1 })))
    byFile.set(p.state.abs, bucket)
  }

  // 阶段三：内存里拼出每份新内容（无副作用）
  interface Target {
    state: FileState
    content: string
    diff: EditDiffFilePreview
    edits: LocatedEdit[]
  }
  const targets: Target[] = []
  for (const [abs, bucket] of byFile) {
    const built = buildNewContent(bucket.state.text, bucket.edits, bucket.state.rawPath)
    if (!built.ok) return built
    targets.push({
      state: bucket.state,
      content: built.content,
      edits: bucket.edits,
      diff: { path: bucket.state.rawPath, absPath: abs, ...computeEditDiff(bucket.state.text, built.content) },
    })
  }

  // 阶段四：全部写成临时文件（这一步失败：目标文件一个都没动）
  interface StagedTarget {
    target: Target
    staged: StagedWrite
  }
  const stagedList: StagedTarget[] = []
  for (const target of targets) {
    try {
      const staged = await stageWrite(target.state.abs, target.content, {
        minMtimeMs: nextMtimeMs(target.state.abs),
      })
      stagedList.push({ target, staged })
    } catch (e: any) {
      for (const item of stagedList) await discardStagedWrite(item.staged)
      return {
        ok: false,
        error: `写入失败（未改动任何文件）：${target.state.rawPath}：${e?.message || String(e)}`,
      }
    }
  }

  // 阶段五：逐个提交（版本比对 + rename）
  const committed: StagedTarget[] = []
  for (const item of stagedList) {
    const result = await commitStagedForEdit(item.staged, item.target.state.version)
    if (!('reason' in result)) {
      committed.push(item)
      noteFileObserved(item.target.state.abs, ctx)
      continue
    }
    // 提交失败：把已经提交的文件写回原内容（尽力而为），并清理剩下的临时文件
    const rolledBack: string[] = []
    for (const done of committed) {
      try {
        await atomicWrite(done.target.state.abs, done.target.state.text, {
          minMtimeMs: nextMtimeMs(done.target.state.abs),
        })
        rolledBack.push(done.target.state.rawPath)
        noteFileObserved(done.target.state.abs, ctx)
      } catch {
        /* 回滚失败：下面如实报告，不谎称已恢复 */
      }
    }
    // 校验失败的这一份：盘上已经是坏文件，也要写回原文
    if (result.reason === 'verify') {
      try {
        await atomicWrite(item.target.state.abs, item.target.state.text, {
          minMtimeMs: nextMtimeMs(item.target.state.abs),
        })
        rolledBack.push(item.target.state.rawPath)
        noteFileObserved(item.target.state.abs, ctx)
      } catch {
        /* 同上 */
      }
    }
    for (const rest of stagedList) {
      if (!committed.includes(rest)) await discardStagedWrite(rest.staged)
    }
    const detail = result.reason === 'io' || result.reason === 'verify'
      ? `写入失败：${result.message}`
      : `${result.message}；已放弃本次替换`
    const rollbackNote = committed.length || result.reason === 'verify'
      ? rolledBack.length === committed.length + (result.reason === 'verify' ? 1 : 0)
        ? `（已写入的文件已回滚）`
        : `（回滚未完全成功：${committed.length + (result.reason === 'verify' ? 1 : 0) - rolledBack.length} 个文件仍是新内容，请检查后再重试）`
      : '（未改动任何文件）'
    return {
      ok: false,
      code: result.reason === 'verify' ? 'WRITE_VERIFY_FAILED' : result.reason === 'stale' ? 'STALE_VERSION' : 'WRITE_FAILED',
      error: `${detail}（${item.target.state.rawPath}）${rollbackNote}。请重新 read_file 后重试。`,
    }
  }

  // 批量提交全部成功：逐个文件广播，让已打开的视图立刻刷新
  for (const t of targets) broadcastFileChanged(t.state.abs, t.content)

  const files = targets.map((t) => ({
    path: t.state.rawPath,
    replaced: t.edits.length,
    replacements: t.edits.map((ed) => ({
      changedLines: { start: ed.startLine, end: ed.endLine },
      deleted: ed.newText.length === 0,
    })),
    stats: t.diff.stats,
    diff: t.diff,
  }))
  return {
    ok: true,
    value: {
      applied: files.reduce((n, f) => n + f.replaced, 0),
      files: files.map((f) => ({ path: f.path, replaced: f.replaced, replacements: f.replacements, stats: f.stats })),
    },
    preview: makeEditDiffPreview(files.map((f) => f.diff)),
  }
}

async function listDir(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const resolved = resolveToolPath(String(input?.path ?? '.'), input?.skill, ctx)
  const abs = resolved.abs
  if (!abs) return { ok: false, error: resolved.error || '路径越界或缺失（path 参数必填）' }
  try {
    if (!fs.existsSync(abs)) return { ok: false, error: `目录不存在: ${input.path || '.'}` }
    const entries = fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other',
    }))
    return { ok: true, value: { path: input.path || '.', entries } }
  } catch (e: any) {
    return { ok: false, error: `读取目录失败: ${e?.message || String(e)}` }
  }
}

async function runPython(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const code = String(input?.code ?? '')
  if (!code.trim()) return { ok: false, error: 'code 参数必填' }
  try {
    // 统一沙箱策略解析（路线图 2.5）：ctx.sandboxMode 可为 'safe' | 'workspace' | 'trusted'
    const policy = resolvePolicy((ctx as any).sandboxMode, { workspaceRoot: ctx.cwd })
    const sandboxMode: 'safe' | 'workspace' | 'trusted' = policy.mode
    const res = sandboxMode === 'trusted'
      ? await trustedPythonExecute(code, ctx.cwd, ctx.signal)
      : await pythonService.executeCode(code, input?.input ?? '', ctx.cwd, sandboxMode, ctx.signal)
    // 与 shell 同口径：脚本报错也是「结果」（带 [exit code: 1] 与 stderr 段），不是工具故障——
    // 旧实现返回 ok:false，模型只能看到 `ERROR: …` 一行，res.result / logs 里的诊断信息全丢。
    const stdoutText = String((res as any)?.result ?? (res as any)?.output ?? (res as any)?.rawOutput ?? '')
    const stderrText = String((res as any)?.error ?? '')
    return {
      ok: true,
      value: {
        ...res,
        sandbox: policy,
        modelText: renderShellText({
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: (res as any)?.success === false || stderrText ? 1 : 0,
        }),
      },
    }
  } catch (e: any) {
    return { ok: false, error: `Python 执行失败: ${e?.message || String(e)}` }
  }
}

// trusted 模式走完整访问服务（与 executePython IPC 一致）
// 静态导入即可：该服务在 index.ts 里本来就是静态导入的（模块必然已加载），
// 这里用动态 import 只会让打包器报「dynamic import will not move module into another chunk」。
async function trustedPythonExecute(code: string, cwd?: string, signal?: AbortSignal) {
  return trustedPythonService.executeCode(code, '', cwd, signal)
}

// ---------------------------------------------------------------------------
// shell 后台任务（对齐 DSH 的 job 交接：前台超时 → 同一个 job 继续跑）
// ---------------------------------------------------------------------------

/** 单个后台 shell 任务最多保留多少字符输出（超出丢最旧的） */
const SHELL_JOB_OUTPUT_MAX = 512 * 1024
/** 同时最多保留几个后台 shell 任务（防止模型无限开进程） */
const SHELL_MAX_LIVE_JOBS = 8

/** 消费式输出环：`job_output` 读到的就是"上次之后的新输出"（DSH 同语义） */
class ShellOutputRing {
  private parts: string[] = []
  private size = 0
  private dropped = 0

  push(text: string): void {
    if (!text) return
    this.parts.push(text)
    this.size += text.length
    while (this.size > SHELL_JOB_OUTPUT_MAX && this.parts.length > 1) {
      const head = this.parts.shift()!
      this.size -= head.length
      this.dropped += head.length
    }
  }

  consume(): { text: string; dropped: number } {
    const text = this.parts.join('')
    const dropped = this.dropped
    this.parts = []
    this.size = 0
    this.dropped = 0
    return { text, dropped }
  }

  /** 只看不取（界面轮询用；不影响 job_output 的消费游标） */
  peek(maxChars = 4000): string {
    const text = this.parts.join('')
    return text.length > maxChars ? text.slice(-maxChars) : text
  }
}

interface ShellJob {
  id: string
  command: string
  description: string
  cwd: string
  run: ShellRun
  out: ShellOutputRing
  err: ShellOutputRing
  startedAt: number
  finished: boolean
  exitCode?: number
  signal?: string
  error?: string
  /** 是否由"前台超时转后台"产生 */
  promoted: boolean
}

const shellJobs = new Map<string, ShellJob>()

/** 界面用：列出当前后台 shell 任务（含尾部输出；不影响 job_output 的消费游标） */
export function listShellJobsForUi(): Array<{
  id: string
  command: string
  description: string
  cwd: string
  status: 'running' | 'completed' | 'error'
  exitCode?: number
  signal?: string
  startedAt: number
  output: string
}> {
  return Array.from(shellJobs.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((job) => ({
      id: job.id,
      command: job.command,
      description: job.description,
      cwd: job.cwd,
      status: job.finished ? (job.error ? 'error' : 'completed') : 'running',
      exitCode: job.exitCode,
      signal: job.signal,
      startedAt: job.startedAt,
      output: [job.out.peek(6000), job.err.peek(2000)].filter(Boolean).join('\n'),
    }))
}

/** 界面用：停止一个后台 shell 任务 */
export function killShellJobForUi(id: string): { ok: boolean; error?: string } {
  const job = shellJobs.get(String(id || ''))
  if (!job) return { ok: false, error: `未找到后台任务 ${id}` }
  if (job.finished) return { ok: true }
  job.run.killTree()
  jobRegistry.cancel(job.id, '已在界面停止')
  return { ok: true }
}

/** 界面用：移除已结束的任务记录（只清列表，不杀进程） */
export function dismissShellJobForUi(id: string): { ok: boolean } {
  const key = String(id || '')
  const job = shellJobs.get(key)
  if (job && !job.finished) return { ok: false }
  shellJobs.delete(key)
  return { ok: true }
}

/** 注册一个后台 shell 任务；超出并发上限返回 null（调用方负责回退到前台/杀掉） */
function registerShellJob(opts: {
  command: string
  description: string
  cwd: string
  run: ShellRun
  out: ShellOutputRing
  err: ShellOutputRing
  promoted: boolean
  owner: string
}): ShellJob | null {
  // 到上限时先淘汰已结束的任务（它们的输出仍可再读一次，但不再占并发）
  if (shellJobs.size >= SHELL_MAX_LIVE_JOBS) {
    for (const [id, job] of shellJobs) {
      if (job.finished) { shellJobs.delete(id); break }
    }
  }
  if (shellJobs.size >= SHELL_MAX_LIVE_JOBS) return null
  const title = opts.description || opts.command.slice(0, 80)
  const info = jobRegistry.start('shell', opts.owner, title, { detail: opts.command.slice(0, 200) })
  const job: ShellJob = {
    id: info.id,
    command: opts.command,
    description: opts.description,
    cwd: opts.cwd,
    run: opts.run,
    out: opts.out,
    err: opts.err,
    startedAt: Date.now(),
    finished: false,
    promoted: opts.promoted,
  }
  shellJobs.set(info.id, job)
  void opts.run.waitExit().then((res) => {
    job.finished = true
    job.exitCode = res.exitCode
    job.signal = res.signal
    job.error = res.error
    // 退出时的最后一段输出补进环里（流式订阅通常已经拿到了，这里兜底）
    if (res.stdout) job.out.push(res.stdout.slice(-2000))
    if (res.stderr) job.err.push(res.stderr.slice(-2000))
    if (res.error) jobRegistry.fail(info.id, res.error)
    else jobRegistry.complete(info.id, { exitCode: res.exitCode, signal: res.signal, executionTime: res.executionTime })
  })
  return job
}

/** 把一次 shell 结果转成工具返回值（统一形状 + modelText） */
function shellResultValue(
  res: ShellExecutionResult,
  meta: { command: string; description: string; timeoutMs: number; policy: any; extra?: Record<string, unknown> },
): ToolResult {
  return {
    ok: true,
    value: {
      command: meta.command,
      description: meta.description,
      cwd: res.cwd,
      shell: res.shell,
      exitCode: res.exitCode,
      signal: res.signal,
      timedOut: res.timedOut,
      aborted: res.aborted,
      truncated: res.truncated,
      truncatedPaths: res.truncatedPaths,
      stdout: res.stdout,
      stderr: res.stderr,
      executionTime: res.executionTime,
      sandbox: meta.policy,
      ...(meta.extra || {}),
      modelText: renderShellText({
        ...res,
        timeoutMs: meta.timeoutMs,
        ...(res.aborted ? { abortReason: '调用被取消（用户停止 / turn 取消）' } : {}),
      }),
    },
  }
}

/**
 * 沙箱拒绝时的一次性升权：带 `sandbox_permissions: 'escalate'` + `justification` 时
 * 通过 ask_user 的问答通道向用户确认，**只放行这一条命令**（对齐 DSH 的单次升权）。
 */
async function escalateShellOnce(
  input: any,
  ctx: ToolExecutionContext,
  command: string,
): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const policy = resolvePolicy((ctx as any).sandboxMode, { workspaceRoot: ctx.cwd })
  const denied = (extra: string): { ok: false; result: ToolResult } => ({
    ok: false,
    result: {
      ok: false,
      code: 'SANDBOX_DENIED',
      error: `shell 执行被沙箱策略拒绝：当前模式 ${policy.mode}（enforcement: ${policy.enforcement}）。${extra}`,
    },
  })
  const wantsEscalate = String(input?.sandbox_permissions ?? '').trim() === 'escalate'
  const justification = String(input?.justification ?? '').trim()
  if (!wantsEscalate || !justification) {
    return denied(
      '仅「完全访问（trusted）」模式允许执行 shell。若确实需要执行，可带 sandbox_permissions:"escalate" 与 justification 重新调用——确认后只会放行这一条命令；也可在「设置 → 通用 → 其他 → 安全策略」切换模式。',
    )
  }
  if (!ctx.agentId) {
    return denied('升权需要向用户确认，但当前不在 agent 会话内，无法发起确认。')
  }
  try {
    const answers = await requestQuestions(ctx.agentId, [
      {
        id: 'shell-escalate',
        header: '执行 shell 命令',
        question: `智能体请求在「${policy.mode}」模式下执行一条 shell 命令：\n\n${command.slice(0, 800)}\n\n理由：${justification.slice(0, 400)}\n\n是否允许本次执行？（只放行这一条）`,
        options: [
          { label: '允许执行', description: '仅本次命令，执行后策略不变' },
          { label: '拒绝', description: '本次不执行' },
        ],
      },
    ])
    if (Array.isArray(answers) && answers[0]?.selected?.includes('允许执行')) return { ok: true }
    return {
      ok: false,
      result: { ok: false, code: 'SANDBOX_DENIED', error: '用户拒绝了本次 shell 执行（一次性升权未获批准）。' },
    }
  } catch (e: any) {
    return denied(`未能获得用户确认：${e?.message || String(e)}`)
  }
}

/**
 * shell —— 对齐 DSH 的 `bash` / `pwsh` 语义：
 * - 每次调用一个全新进程（状态不保留，换目录用 workdir）；
 * - **非零退出不是工具错误**，而是结果里的一条 `[exit code: N]` 标记；
 * - 超时 / 取消会杀掉整棵进程树，并分别标记 `[timed out after Xms]` / `[stopped: …]`；
 * - 前台超时**不杀进程**，转成后台 job（`[still running after Xms; moved to background job <id>]`）；
 * - 输出超限时只保留尾部，完整内容落盘（标记里给路径，可用 read_file 回读）。
 */
async function runShell(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const command = String(input?.command ?? '')
  if (!command.trim()) return { ok: false, error: 'command 参数必填', code: 'INVALID_ARGS' }

  // shell 是最高危执行面：统一策略解析，仅 trusted 放行；不然走一次性升权（用户确认）
  const policy = resolvePolicy((ctx as any).sandboxMode, { workspaceRoot: ctx.cwd })
  if (!isShellAllowed(policy)) {
    const escalated = await escalateShellOnce(input, ctx, command)
    // tsconfig.node.json 未开 strict：按字段是否存在收窄
    if ('result' in escalated) return escalated.result
  }

  // 方言：Windows 默认 cmd，POSIX 默认 sh；可用 shell 参数指定
  const kindRes = resolveShellKind(input?.shell)
  if ('error' in kindRes) return { ok: false, code: 'INVALID_ARGS', error: kindRes.error }

  // workdir：相对路径基于工作区根，绝对路径放行；必须是已存在的目录
  const rawWorkdir = String(input?.workdir ?? '').trim()
  let cwd = ctx.cwd || process.cwd()
  if (rawWorkdir) {
    const abs = path.isAbsolute(rawWorkdir) ? rawWorkdir : path.resolve(cwd, rawWorkdir)
    try {
      if (!fs.statSync(abs).isDirectory()) {
        return { ok: false, code: 'INVALID_ARGS', error: `workdir 不是目录：${abs}` }
      }
      cwd = abs
    } catch {
      return { ok: false, code: 'INVALID_ARGS', error: `workdir 不存在：${abs}` }
    }
  }

  const rawTimeout = Number(input?.timeoutMs ?? input?.timeout_ms)
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(SHELL_MAX_TIMEOUT_MS, Math.max(1000, Math.floor(rawTimeout)))
    : SHELL_DEFAULT_TIMEOUT_MS

  const description = String(input?.description ?? '').trim()
  const sessionId = String(ctx.sessionId || ctx.agentId || 'shell')
  const owner = String(ctx.agentId || ctx.sessionId || 'shell')
  const runOpts = { cwd, shellKind: kindRes.kind, sessionId }

  // ---- 后台模式：立即返回 job id ----
  if (input?.run_in_background === true) {
    const out = new ShellOutputRing()
    const err = new ShellOutputRing()
    const run = startShell(command, runOpts)
    run.onOutput((stream, text) => (stream === 'stdout' ? out : err).push(text))
    const job = registerShellJob({ command, description, cwd, run, out, err, promoted: false, owner })
    if (!job) {
      run.killTree()
      return { ok: false, code: 'SHELL_FAILED', error: `后台 shell 任务已达上限（${SHELL_MAX_LIVE_JOBS} 个）：请先 job_kill 结束旧任务，或改前台执行。` }
    }
    return {
      ok: true,
      value: {
        command,
        description,
        cwd,
        shell: kindRes.kind,
        jobId: job.id,
        status: 'running',
        sandbox: policy,
        modelText: `started background job ${job.id}\n（用 job_output(job_id="${job.id}") 读取输出，job_kill(job_id="${job.id}") 停止）`,
      },
    }
  }

  // ---- 前台：超时转后台（不杀进程） ----
  const out = new ShellOutputRing()
  const err = new ShellOutputRing()
  const run = startShell(command, runOpts)
  run.onOutput((stream, text) => (stream === 'stdout' ? out : err).push(text))

  let timer: ReturnType<typeof setTimeout> | null = null
  let aborted = false
  const onAbort = () => {
    aborted = true
    run.killTree()
  }
  if (ctx.signal?.aborted) onAbort()
  else ctx.signal?.addEventListener('abort', onAbort, { once: true })
  const timeoutHit = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    if (timer && typeof (timer as any).unref === 'function') (timer as any).unref()
  })
  const first = await Promise.race([
    run.waitExit().then((r) => ({ kind: 'exit' as const, r })),
    timeoutHit.then(() => ({ kind: 'timeout' as const })),
  ])
  if (timer) clearTimeout(timer)
  try { ctx.signal?.removeEventListener('abort', onAbort) } catch { /* 忽略 */ }

  if (first.kind === 'exit') {
    if (first.r.error) return { ok: false, code: 'SHELL_FAILED', error: `shell 启动失败：${first.r.error}` }
    return shellResultValue({ ...first.r, aborted }, { command, description, timeoutMs, policy })
  }

  // 取消（turn 停止）：已经杀过进程树，按"被停止"返回，不转后台
  if (aborted) {
    const res = { ...(await run.waitExit()), aborted: true, timedOut: false }
    return shellResultValue(res, { command, description, timeoutMs, policy })
  }

  // 超时：把它交给后台任务继续跑（DSH 的 promoteOnTimeout）
  const job = registerShellJob({ command, description, cwd, run, out, err, promoted: true, owner })
  const so_far_out = out.consume()
  const so_far_err = err.consume()
  const partial = renderShellText({ stdout: so_far_out.text, stderr: so_far_err.text })
  if (!job) {
    run.killTree()
    const res = { ...(await run.waitExit()), timedOut: true, aborted: false }
    return shellResultValue(res, { command, description, timeoutMs, policy })
  }
  return {
    ok: true,
    value: {
      command,
      description,
      cwd,
      shell: kindRes.kind,
      jobId: job.id,
      timedOut: true,
      status: 'running',
      sandbox: policy,
      modelText: `${partial}\n[still running after ${timeoutMs}ms; moved to background job ${job.id}]\n`
        + `（用 job_output(job_id="${job.id}") 继续读取输出，job_kill(job_id="${job.id}") 停止）`,
    },
  }
}

/** 知识库切片内存缓存（关键词兜底用；按 mtime 失效，最多留 4 个库） */
const kbBlockCache = new Map<string, { mtime: number; blocks: Array<{ label: string; content: string }> }>()

/**
 * 读取 .kb 的切片（仅 label + 正文），供向量检索不可用时做本地关键词兜底。
 * 纯本地计算，不依赖任何模型：嵌入模型未加载 / 服务端不支持 embeddings 时仍能检索。
 */
function loadKbBlocksForKeyword(kbPath: string): Array<{ label: string; content: string }> {
  try {
    const st = fs.statSync(kbPath)
    const hit = kbBlockCache.get(kbPath)
    if (hit && hit.mtime === st.mtimeMs) return hit.blocks
    const data = JSON.parse(fs.readFileSync(kbPath, 'utf8'))
    const blocks = (Array.isArray(data?.blocks) ? data.blocks : [])
      .map((b: any) => ({ label: String(b?.label || ''), content: String(b?.A || '') }))
      .filter((b: { content: string }) => b.content.trim())
    if (kbBlockCache.size > 4) kbBlockCache.clear()
    kbBlockCache.set(kbPath, { mtime: st.mtimeMs, blocks })
    return blocks
  } catch {
    return []
  }
}

async function kbSearch(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const query = String(input?.query ?? '')
  if (!query) return { ok: false, error: 'query 参数必填' }

  // 检索范围：input.kbPath（单个）→ input.kbPaths（数组）→ ctx.kbPaths（预设模式候选）
  const explicitPaths = input?.kbPath
    ? [String(input.kbPath)]
    : Array.isArray(input?.kbPaths) && input.kbPaths.length
      ? input.kbPaths.map(String)
      : Array.isArray(ctx.kbPaths) && ctx.kbPaths.length
        ? ctx.kbPaths.map(String)
        : []
  if (explicitPaths.length === 0) return { ok: false, error: '未指定知识库（kbPath/kbPaths，或预设关联的知识库）' }

  // kb 名称过滤（对齐原渲染进程 executeAgentPresetTool 语义）
  const kbFilter = typeof input?.kb === 'string' && input.kb.trim() ? input.kb.trim() : undefined
  const topK = Math.max(
    1,
    Math.min(20, typeof input?.topK === 'number' ? input.topK : typeof ctx.kbTopK === 'number' ? ctx.kbTopK : 5),
  )

  const allBlocks: any[] = []
  let ragContext = ''
  let lastError = ''
  for (const kbPath of explicitPaths) {
    const kbName = String(kbPath).split(/[/\\]/).pop() || String(kbPath)
    if (kbFilter && kbName !== kbFilter && String(kbPath) !== kbFilter) continue
    if (!fs.existsSync(kbPath)) continue
    // 向量检索失败 / 无结果时的本地关键词兜底（不依赖模型）
    const keywordFallback = (reason: string) => {
      const kw = keywordSearchBlocks(query, loadKbBlocksForKeyword(kbPath), topK)
      if (!kw.length) return false
      allBlocks.push(...kw)
      ragContext += `【知识库：${kbName}】（${reason}；已退回关键词匹配）\n${kw.map(b => String(b.content)).join('\n')}\n`
      return true
    }
    try {
      const result = await retrieveKnowledge(query, kbPath, {
        // 来源 / 嵌入兜底 / 检索策略由调用方（渲染进程）下发；缺省时退回 ollama 默认（兼容旧调用）
        ...(((ctx as any)?.retrieval as any) || {}),
        topK,
        debug: !!input?.debug,
        missingModelStrategy: 'fallback',
      } as any)
      const blocks = (result as any)?.relevantBlocks || []
      if (Array.isArray(blocks) && blocks.length > 0) {
        allBlocks.push(...blocks)
        if ((result as any)?.context) ragContext += `【知识库：${kbName}】\n${(result as any).context}\n`
      } else if (!keywordFallback('向量检索无结果')) {
        ragContext += `【知识库：${kbName}】未匹配到相关内容\n`
      }
    } catch (e: any) {
      lastError = e?.message || String(e)
      if (!keywordFallback(`向量检索失败：${lastError}`)) {
        ragContext += `【知识库：${kbName}】检索失败：${lastError}\n`
      }
    }
  }

  // 确实什么都没检索到：返回 ok:false（让 agent 知道是“检索失败/无结果”而不是“库里没有”），并带上原因
  if (!allBlocks.length) {
    const tail = lastError ? `（向量检索失败：${lastError}）` : ''
    return {
      ok: false,
      error: `未检索到与「${query}」相关的内容${tail}。可换关键词重试；若持续失败，请检查「设置 → 模型 → 嵌入」的嵌入模型/嵌入兜底配置。`,
    }
  }
  const preview = ragContext.length > 6000 ? ragContext.slice(0, 6000) + '\n...(内容过长已截断)' : ragContext
  return {
    ok: true,
    value: {
      query,
      kbPaths: explicitPaths,
      count: allBlocks.length,
      context: preview,
      blocks: allBlocks.slice(0, 10),
      debug: (input as any)?.debug ? allBlocks : undefined,
      // 纯文本通道：context 里已经带【知识库：…】分组，直接给模型，免得 JSON 转义整段正文
      modelText: `检索「${query}」（${allBlocks.length} 段相关切片）\n${preview}`,
    },
  }
}

/**
 * 技能名归一化：忽略大小写与 `_`/空格差异（模型常把 kebab-case 技能名写歪）
 */
function normalizeSkillName(s: string): string {
  return String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/**
 * 按名解析技能（容错）：精确 → 忽略大小写/分隔符 → 唯一的前缀/包含匹配。
 * 未命中时给出可用技能清单：模型凭印象编技能名（如 contract-audit-skill）时，
 * 能直接看到真实技能名并改正，而不是反复重猜（旧实现只回「技能不存在」）。
 */
function resolveSkillCandidate(name: string): { candidate?: ReturnType<typeof skillService.get>; hint?: string } {
  const exact = skillService.get(name)
  if (exact) return { candidate: exact }
  const all = skillService.list()
  if (all.length === 0) {
    return { hint: '当前技能库为空（技能文件夹未设置或未加载）：请先在 设置 → 技能 中选择技能文件夹。' }
  }
  const norm = normalizeSkillName(name)
  const sameNorm = all.filter((c) => normalizeSkillName(c.name) === norm)
  if (sameNorm.length === 1) return { candidate: sameNorm[0] }
  const partial = all.filter((c) => {
    const n = normalizeSkillName(c.name)
    return n.startsWith(norm) || norm.startsWith(n) || n.includes(norm)
  })
  if (partial.length === 1) return { candidate: partial[0] }
  return { hint: `可用技能：${all.map((c) => c.name).join('、')}。请从中原文择一重新调用。` }
}

async function loadSkill(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const name = String(input?.name ?? '')
  if (!name) return { ok: false, error: 'name 参数必填（kebab-case 技能名）' }
  // 技能管理中关闭的技能：拒绝加载（ctx.disabledSkills 由 agent 循环注入）
  const disabledSkills = Array.isArray((ctx as any)?.disabledSkills) ? (ctx as any).disabledSkills as string[] : []
  if (disabledSkills.includes(name)) {
    return { ok: false, error: `技能「${name}」已禁用，禁止加载（可在技能管理中启用）` }
  }
  const resolved = resolveSkillCandidate(name)
  const candidate = resolved.candidate
  if (!candidate) return { ok: false, error: `技能不存在: ${name}。${resolved.hint || ''}`.trim() }
  if (candidate.name !== name && disabledSkills.includes(candidate.name)) {
    return { ok: false, error: `技能「${candidate.name}」已禁用，禁止加载（可在技能管理中启用）` }
  }
  // 返回内容包裹明确的执行指令：技能一旦加载即视为"指令已获得"，
  // 防止模型反复调用 skill 工具而不进入实际执行（死循环）。
  // 资源提示对齐 DSH"资源按需加载、结果不枚举技能目录"：只给技能目录 + 真实
  // 总数 + 少量示例，不把超大技能（如 1w+ 模板文件）的全量清单塞进工具结果。
  const sampled = (candidate.preview.files || []).slice(0, 20)
  const fileCount = candidate.preview.fileCount ?? candidate.preview.files?.length ?? 0
  const instruction = [
    `技能「${candidate.name}」已加载成功。`,
    '请立即按照下面的技能指令继续执行任务（生成代码用 run_python 执行、需要资料用 read_file / kb_search、需要联网用 web_search）。',
    '不要再次调用 skill 工具重复加载本技能。',
    `技能目录：${candidate.path}（共 ${fileCount} 个文件）。资源按需加载：不要枚举或读取全部文件，需要时用 read_file / list_dir / search_files 并**传 skill="${candidate.name}" + 相对路径**（例：read_file({"skill":"${candidate.name}","path":"references/x.md"})）查找读取——这样不受当前工作区影响（注意：不带 skill 的相对路径锚定的是当前工作区）。`,
    sampled.length > 0
      ? `参考文件示例（前 ${sampled.length} 个，便于快速定位）：\n${sampled.map((f) => `- ${f.name}`).join('\n')}`
      : '',
    '--- 技能指令开始 ---',
    candidate.preview.content,
    '--- 技能指令结束 ---',
  ].join('\n')
  return {
    ok: true,
    value: {
      name: candidate.name,
      description: candidate.description,
      source: candidate.source,
      promptVersion: candidate.promptVersion,
      content: instruction,
      resourceBase: candidate.path,
      fileCount,
      files: sampled.map((f) => f.name),
      // 纯文本通道：技能指令本身就是 Markdown，别让 JSON 转义把换行变成 \n
      modelText: instruction,
    },
  }
}

// ---------------------------------------------------------------------------
// 交互与状态工具（依赖 agent 循环的接缝）
// ---------------------------------------------------------------------------

/**
 * ask_user：向用户提问，等待渲染进程经 agent:answer 回复（结构化回答批）。
 *
 * 契约参照 DSH `ask_user_question`：一次可问多题，每题可给选项（单选 / 多选）并留自定义回答；
 * 回答按问题 id 回填 `{ id, selected: string[], custom? }`，跳过的题 selected 为空且无 custom。
 */
async function askUser(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (!ctx.agentId) return { ok: false, error: 'ask_user 只能在 agent 循环内使用' }
  const parsed = parseAskQuestions(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const { questions, legacy } = parsed
  try {
    const answers = await requestQuestions(ctx.agentId, questions)
    return {
      ok: true,
      value: {
        ...askAnswersToModel(questions, answers, legacy),
        summary: askAnswersText(questions, answers),
      },
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || '用户未回答' }
  }
}

/**
 * exit_plan_mode：把完整计划提交给用户评审（对齐 DSH 计划模式的核心闭环）。
 *
 * 语义（与 DSH 一致）：
 * - **批准** → 返回成功 `{ approved: true, plan }`，表示可以开始执行；
 * - **继续完善** → 返回**失败**并把用户反馈带回（模型据此修订后重新提交）；
 * - **关闭评审** → 返回**失败**并说明用户接手（模型不要擅自继续推进）。
 */
async function exitPlanMode(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (!ctx.agentId) return { ok: false, error: 'exit_plan_mode 只能在 agent 会话内使用' }
  const raw = input?.plan
  if (raw !== undefined && typeof raw !== 'string') {
    return { ok: false, error: 'plan 必须是字符串（Markdown 文本；通常 update_plan 里已经写过一份）' }
  }
  const plan = typeof raw === 'string' ? raw.trim() : ''
  if (!plan) return { ok: false, error: 'plan 参数必填：请提交完整计划（Markdown，从标题开始书写）供用户评审' }
  if (plan.length > PLAN_MAX_CHARS) {
    return { ok: false, error: `计划过长（${plan.length} 字符，上限 ${PLAN_MAX_CHARS}）：评审的是步骤与关键决策，细节请写进工作区文件` }
  }
  // 提交评审的计划同时成为"当前计划"（UI 与后续步骤都看这一份；落盘 plan/write）
  setAgentPlan(ctx.agentId, plan)
  try {
    const outcome = await requestPlanReview(ctx.agentId, plan)
    const verdict = planReviewMessage(outcome)
    if (verdict.ok) return { ok: true, value: { approved: true, plan, message: verdict.text } }
    return { ok: false, error: verdict.text }
  } catch (e: any) {
    return { ok: false, error: `计划评审未完成：${e?.message || '已取消'}` }
  }
}

/** 计划文本上限（字符）：计划是给人看的执行摘要，不是长文正文 */
const PLAN_MAX_CHARS = 20000

/**
 * update_plan：创建/更新执行计划（随 agent/plan 事件广播给 UI）。
 *
 * 参照 DSH 计划模式的工具逻辑：
 * - 计划是**人看的 Markdown**（`# 标题` + 步骤列表），由 UI 原样展示；
 * - 传空字符串 = 清除计划（任务完成或计划作废时调用，避免旧计划留在界面上误导用户）；
 * - 写入前做规模校验并 fail-loud，超长计划直接拒绝而不是塞进 UI。
 */
async function updatePlan(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (!ctx.agentId) return { ok: false, error: 'update_plan 只能在 agent 会话内使用' }
  const raw = input?.plan
  if (raw !== undefined && typeof raw !== 'string') {
    return { ok: false, error: 'plan 必须是字符串（Markdown 文本；传空字符串清除计划）' }
  }
  const plan = typeof raw === 'string' ? raw.trim() : ''
  if (plan.length > PLAN_MAX_CHARS) {
    return {
      ok: false,
      error: `计划过长（${plan.length} 字符，上限 ${PLAN_MAX_CHARS}）：计划只列步骤与关键约束，细节请写进工作区文件`,
    }
  }
  setAgentPlan(ctx.agentId, plan || null)
  if (!plan) {
    return { ok: true, value: { plan: null, cleared: true, message: '执行计划已清除。' } }
  }
  const steps = plan.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length
  return {
    ok: true,
    value: {
      plan,
      cleared: false,
      chars: plan.length,
      steps,
      message: `执行计划已更新（${plan.length} 字符${steps ? `，约 ${steps} 个步骤` : ''}），已展示给用户；执行过程中请在有变化时继续调用本工具保持计划最新。`,
    },
  }
}

/**
 * update_todo：维护结构化待办清单（随 agent/todos 事件广播给 UI）。
 *
 * 参照 DSH `todo_write` 的工具逻辑：整表替换 + 写入前强校验 + 单活跃项 + 返回计数。
 * 校验失败一律 fail-loud（返回 ok:false 让模型重写），避免脏数据进 UI / 存档。
 */
async function updateTodo(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  if (!ctx.agentId) return { ok: false, error: 'update_todo 只能在 agent 会话内使用' }
  const parsed = parseTodoList(input?.todos, getAgentTodos(ctx.agentId))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  setAgentTodos(ctx.agentId, parsed.todos)
  return {
    ok: true,
    value: { todos: parsed.todos, counts: parsed.counts, cleared: parsed.cleared, message: parsed.message },
  }
}

// ---------------------------------------------------------------------------
// search_files：工作区文本搜索（对齐 index.ts 的 searchInWorkspace 语义）
// ---------------------------------------------------------------------------

async function searchFiles(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const query = String(input?.query ?? '').trim()
  if (!query) return { ok: false, error: 'query 参数必填', code: 'INVALID_ARGS' }
  // 搜索根优先级：skill（技能目录）→ 显式 root（可绝对/相对工作区）→ 工具上下文 cwd
  const skillName = String(input?.skill ?? '').trim()
  let root: string | undefined
  if (skillName) {
    const dir = resolveSkillDir(skillName)
    const base = dir.base
    if (!base) return { ok: false, error: dir.error }
    root = base
  } else if (input?.root) {
    const abs = resolveWithinCwd(String(input.root), ctx)
    if (!abs) return { ok: false, error: `搜索根路径越界: ${input.root}` }
    root = abs
  } else {
    root = ctx.cwd
  }
  if (!root) return { ok: false, error: '缺少搜索目录（skill 或 root，或工具上下文 cwd）' }

  const result = await searchFilesInRoot({
    root,
    query,
    regex: input?.regex === true,
    ignoreCase: input?.ignoreCase === true,
    // 旧调用（caseSensitive:false = 忽略大小写）继续兼容
    caseSensitive: typeof input?.caseSensitive === 'boolean' ? input.caseSensitive : undefined,
    filePattern: input?.filePattern ? String(input.filePattern) : undefined,
    maxResults: typeof input?.maxResults === 'number' ? input.maxResults : 30,
    contextLines: typeof input?.contextLines === 'number' ? input.contextLines : 0,
    maxFileSizeMB: typeof input?.maxFileSizeMB === 'number' ? input.maxFileSizeMB : 2,
    includeHidden: input?.includeHidden === true,
    respectGitignore: input?.respectGitignore !== false,
    signal: ctx.signal,
  })
  return attachSearchOverflow(result, ctx, `search-${Date.now()}.txt`)
}

/**
 * 把"超出内联上限的完整命中"落盘成 spill 文件，并把定位提示拼到 modelText 末尾。
 *
 * 与 DSH 的 `grep` 达到 `grepMaxMatches` 后落盘、返回 locator 的做法一致：
 * 模型拿到的是"前 N 条 + 一份可回读的完整结果"，而不是一个只能自己缩小范围的死胡同。
 */
function attachSearchOverflow(result: ToolResult, ctx: ToolExecutionContext, fileName: string): ToolResult {
  if (!result.ok || !result.value || typeof result.value !== 'object') return result
  const value = result.value as Record<string, any>
  const overflow = typeof value.overflowText === 'string' ? value.overflowText : ''
  if (!overflow) return result
  let modelText = String(value.modelText || '')
  const spill = saveSpillText(String(ctx.sessionId || ctx.agentId || 'agent'), fileName, overflow)
  modelText += spill
    ? `\n（完整结果已保存到：${spill.path}\n用 read_file 读取该路径即可看到被省略的命中，可带 offset / limit 分段查看）`
    : '\n（命中过多，完整列表未能保存；请加 filePattern、缩小 root 或换更精确的关键词后重试）'
  const { overflowText: _omit, ...rest } = value
  return { ok: true, value: { ...rest, modelText } }
}

/** 按路径 / 文件名查找文件（`glob`）：与 `search_files` 同一套遍历与忽略规则 */
async function globFiles(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const pattern = String(input?.pattern ?? '').trim()
  if (!pattern) return { ok: false, error: 'pattern 参数必填（如 **/*.md）', code: 'INVALID_ARGS' }
  const skillName = String(input?.skill ?? '').trim()
  let root: string | undefined
  if (skillName) {
    const dir = resolveSkillDir(skillName)
    if (!dir.base) return { ok: false, error: dir.error }
    root = dir.base
  } else if (input?.root) {
    const abs = resolveWithinCwd(String(input.root), ctx)
    if (!abs) return { ok: false, error: `查找根路径越界: ${input.root}` }
    root = abs
  } else {
    root = ctx.cwd
  }
  if (!root) return { ok: false, error: '缺少查找目录（skill 或 root，或工具上下文 cwd）' }

  const result = await globFilesInRoot({
    root,
    pattern,
    maxResults: typeof input?.maxResults === 'number' ? input.maxResults : 100,
    includeHidden: input?.includeHidden === true,
    respectGitignore: input?.respectGitignore !== false,
    signal: ctx.signal,
  })
  if (result.ok && result.value && typeof result.value === 'object') {
    const merged: ToolResult = { ok: true, value: { ...(result.value as Record<string, unknown>), root } }
    // 与 search_files 同一套：超出内联上限的完整列表落盘，模型可用 read_file 回读
    return attachSearchOverflow(merged, ctx, `glob-${Date.now()}.txt`)
  }
  return result
}

// ---------------------------------------------------------------------------
// 联网工具（web_search / web_fetch）
//
// web_search 支持多搜索源（设置页「工具 → 搜索」切换）：
// - 免 Key：bing（默认，隐藏浏览器渲染）/ baidu / duckduckgo
// - 免 Key 的搜索 API：firecrawl（不填 Key 走官方免费额度，填了换用自己的额度）
// - 自建：searxng（实例地址 + JSON 接口）
// - API Key：bocha 博查 / zhipu 智谱 / tavily / brave
// 配置由渲染进程经 IPC（webSearch:set-config）注入，默认保持原 Bing 行为不变。
// ---------------------------------------------------------------------------

/** 当前生效的搜索源配置（默认 Bing 免 Key；setWebSearchConfig 覆盖） */
let webSearchConfig: WebSearchConfig = normalizeWebSearchConfig(null)

/** 注入搜索源配置（IPC webSearch:set-config / 测试搜索共用），返回归一化后的配置 */
export function setWebSearchConfig(cfg: unknown): WebSearchConfig {
  webSearchConfig = normalizeWebSearchConfig(cfg)
  return JSON.parse(JSON.stringify(webSearchConfig))
}

/** 读取当前搜索源配置（深拷贝，避免调用方改动内部状态） */
export function getWebSearchConfig(): WebSearchConfig {
  return JSON.parse(JSON.stringify(webSearchConfig))
}

/** 当前生效的抓取通道配置（默认 direct + browser，与旧行为一致；setWebFetchConfig 覆盖） */
let webFetchConfig: WebFetchConfig = normalizeWebFetchConfig(null)

/** 注入抓取通道配置（IPC webFetch:set-config / 测试抓取共用），返回归一化后的配置 */
export function setWebFetchConfig(cfg: unknown): WebFetchConfig {
  webFetchConfig = normalizeWebFetchConfig(cfg)
  return JSON.parse(JSON.stringify(webFetchConfig))
}

/** 读取当前抓取通道配置（深拷贝，避免调用方改动内部状态） */
export function getWebFetchConfig(): WebFetchConfig {
  return JSON.parse(JSON.stringify(webFetchConfig))
}

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 解析 Bing 网页搜索结果（title/url/snippet），容器为 <li class="b_algo"> */
function parseBingResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const out: Array<{ title: string; url: string; snippet: string }> = []
  // 逐个提取结果块（class 可能带额外修饰，如 b_algo b_amoyo，用属性包含匹配）
  const algoRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = algoRe.exec(html)) !== null) {
    const block = m[1]
    // 标题链接：<h2><a href="...">标题</a></h2>（标题内可能有 <strong> 高亮标签）
    const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const url = decodeEntities(a[1])
    const title = stripTags(decodeEntities(a[2]))
    if (!url || !title) continue
    // 摘要：<div class="b_caption"><p class="b_lineclamp2">…</p></div>
    const cap = block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i)
    const snippet = cap ? stripTags(decodeEntities(cap[1])) : ''
    out.push({ title, url, snippet })
  }
  return out
}

/** Bing 结果提取器（隐藏浏览器内执行；li.b_algo 块） */
const BING_EXTRACTOR = `(() => {
  const items = Array.from(document.querySelectorAll('li.b_algo')).slice(0, 10)
  const out = []
  for (const li of items) {
    const a = li.querySelector('h2 a') || li.querySelector('a[href]')
    if (!a) continue
    const href = a.getAttribute('href') || ''
    const title = (a.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!href || !title) continue
    const cap = li.querySelector('.b_caption, .b_snippet, .b_lineclamp2, .b_algo p')
    const snippet = (cap ? cap.textContent : '').replace(/\\s+/g, ' ').trim()
    out.push({ title, url: href, snippet })
  }
  return out
})()`

/** 百度结果提取器（隐藏浏览器内执行；#content_left 下的结果卡片） */
const BAIDU_EXTRACTOR = `(() => {
  const nodes = Array.from(document.querySelectorAll('#content_left > div')).slice(0, 12)
  const out = []
  for (const node of nodes) {
    const a = node.querySelector('h3 a[href]') || node.querySelector('a[href]')
    if (!a) continue
    const href = a.href || a.getAttribute('href') || ''
    const title = (a.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!href || !title || !/^https?:/i.test(href)) continue
    const cap = node.querySelector('[class*="content-right"], .c-abstract, [class*="c-span-last"], [class*="c-color-text"]')
    const snippet = (cap ? cap.textContent : '').replace(/\\s+/g, ' ').trim()
    out.push({ title, url: href, snippet })
  }
  return out
})()`

/** DuckDuckGo 结果提取器（隐藏浏览器内执行；html.duckduckgo.com） */
const DDG_EXTRACTOR = `(() => {
  const nodes = Array.from(document.querySelectorAll('.result, .web-result')).slice(0, 12)
  const out = []
  for (const node of nodes) {
    const a = node.querySelector('a.result__a') || node.querySelector('a[href]')
    if (!a) continue
    const href = a.href || ''
    const title = (a.textContent || '').replace(/\\s+/g, ' ').trim()
    if (!href || !title) continue
    const cap = node.querySelector('.result__snippet')
    const snippet = (cap ? cap.textContent : '').replace(/\\s+/g, ' ').trim()
    out.push({ title, url: href, snippet })
  }
  return out
})()`

/** 反爬兜底：在隐藏 Chromium 中真正加载搜索页，等 JS 渲染后用 extractor 从 DOM 提取结果。 */
async function searchViaBrowser(url: string, extractor: string, label: string, timeoutMs = 25000): Promise<WebSearchItem[]> {
  return new Promise<WebSearchItem[]>((resolve, reject) => {
    let settled = false
    let win: BrowserWindow | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (win && !win.isDestroyed()) win.destroy() } catch { /* 忽略 */ }
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${label} 浏览器搜索超时`)))
    }, timeoutMs)
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          sandbox: true,
        },
      })
      // 隐藏抓取窗口：不参与全局窗口缩放（缩放会改变页面布局，影响抓取结果）
      excludeFromAppZoom(win)
      const wc = win.webContents
      wc.on('did-finish-load', async () => {
        try {
          await new Promise(r => setTimeout(r, 1500))
          const data = await wc.executeJavaScript(extractor) as WebSearchItem[]
          if (Array.isArray(data) && data.length > 0) {
            finish(() => resolve(data.map((it) => ({
              title: String(it?.title || '').trim(),
              url: String(it?.url || '').trim(),
              snippet: String(it?.snippet || '').trim(),
              summary: String(it?.snippet || '').trim(),
            })).filter((it) => it.title && it.url)))
          } else {
            finish(() => reject(new Error(`${label} 浏览器页面中未解析到搜索结果`)))
          }
        } catch (e: any) {
          finish(() => reject(new Error(`${label} 浏览器提取失败: ${e?.message || String(e)}`)))
        }
      })
      wc.on('did-fail-load', (_e, code, desc) => {
        finish(() => reject(new Error(`${label} 浏览器加载失败 (${code}): ${desc}`)))
      })
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.loadURL(url)
    } catch (e: any) {
      finish(() => reject(new Error(`${label} 浏览器启动失败: ${e?.message || String(e)}`)))
    }
  })
}

/** Bing 网页搜索对中文查询的拆词/实体识别不稳定：
 *  1. 句中「的」会导致整句崩坏（「最新款的小米手机」→ 只命中「最」）；
 *  2. 「如何/怎么/怎样 + 动词 + 名词」结构会把动词当核心（「如何制作咖啡」→ 需把「咖啡」置前）。
 *  改写为关键词查询：去掉「的」与疑问语气词，并尽量把核心名词短语放到前面。 */
function rewriteQueryForBing(q: string): string {
  let s = q.trim()
  if (!s) return q
  // 去掉句末标点与疑问语气词（有哪些/是什么/什么样/如何/怎么/多少…）
  s = s.replace(/[？?。！!～~]+$/g, '')
  s = s.replace(
    /(有哪些|是哪些|是什么样|是怎么样|是啥样|是什么|是啥|怎么样|什么样|如何|怎么|怎样|多少|什么|哪款|哪些|吗|呢|吧|啊|哦|呀|的)$/g,
    '',
  )
  // 句中「的」全部去掉（Bing 对带「的」的长句拆词极不稳定）
  s = s.replace(/的/g, '')
  // 动词前置重排：把「如何/怎么/怎样 + 动词 + 名词短语」改为「名词短语（+ 动词）」，
  // 让核心名词出现在查询开头（Bing 以首段为实体识别锚点）。
  // 例：「如何制作咖啡」→「咖啡制作」；「怎么泡手冲咖啡」→「手冲咖啡」（单字动词拼上反而破坏实体识别）。
  // 动词用常见表识别（避免把「制作」猜成单字「制」）。
  const ASK_VERBS = ['制作', '学习', '使用', '选择', '设置', '安装', '下载', '操作', '练习', '掌握', '泡', '做', '写', '煮', '冲', '调', '查', '找', '开', '买', '用', '学']
  const askRe = /^(如何|怎么|怎样|怎么样|咋)(.+)$/u
  const am = s.match(askRe)
  if (am) {
    const body = am[2]
    const v = ASK_VERBS.find(vb => body.startsWith(vb))
    if (v && body.length > v.length) {
      const rest = body.slice(v.length).trim()
      if (rest.length >= 2) {
        // 双字及以上动词（制作/学习/使用…）拼到名词后，Bing 识别为「名词+动词」短语；
        // 单字动词（泡/煮/冲/做…）拼接会破坏名词实体（「手冲咖啡泡」→ 崩），只保留名词短语
        s = v.length >= 2 ? `${rest}${v}` : rest
      }
    }
  }
  // 修饰语开头后置：Bing 把查询首段当作核心实体，「最新款/详细/新款/新版/2026」等
  // 修饰语开头会导致实体识别失败（「最新款小米手机」→ 只命中「最」）。
  // 把这些修饰语移到名词短语之后（「最新款小米手机」→「小米手机最新款」）。
  const MOD_PREFIX = /^(最新款|新款|新版|详细|完整的?|全面|超详细|高级|高端|入门|基础|专业|简易|简单|2026年?|2025年?|2024年?)/u
  const mp = s.match(MOD_PREFIX)
  if (mp && s.length > mp[0].length) {
    const rest = s.slice(mp[0].length)
    if (rest.length >= 2) s = `${rest}${mp[0].replace(/年$/, '')}`
  }
  // 归一空白（去除后重排产生的多余空格）
  s = s.replace(/\s+/g, '').trim()
  return s || q
}

// ---------------------------------------------------------------------------
// 搜索结果解析（HTML 兜底通道）/ 通用 HTTP / 各搜索源实现
// ---------------------------------------------------------------------------

/** 解析百度搜索结果页（结果卡片 → 标题/链接/摘要） */
function parseBaiduResults(html: string): WebSearchItem[] {
  const out: WebSearchItem[] = []
  const blockRe = /<div[^>]*class="[^"]*result[^"]*c-container[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*result[^"]*c-container|<\/body>)/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1]
    const a = block.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const url = decodeEntities(a[1])
    const title = stripTags(decodeEntities(a[2]))
    if (!/^https?:/i.test(url) || !title) continue
    const cap = block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || block.match(/<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    out.push({ title, url, snippet: cap ? stripTags(decodeEntities(cap[1])) : '' })
  }
  return out
}

/** DuckDuckGo 跳转链接（//duckduckgo.com/l/?uddg=...）还原为真实 URL */
function unwrapDdgUrl(u: string): string {
  try {
    if (!/duckduckgo\.com\/l\//.test(u)) return u
    const abs = u.startsWith('//') ? `https:${u}` : u
    const target = new URL(abs).searchParams.get('uddg')
    return target ? decodeURIComponent(target) : u
  } catch {
    return u
  }
}

/** 解析 DuckDuckGo HTML 端点（result__a 标题 + result__snippet 摘要） */
function parseDdgResults(html: string): WebSearchItem[] {
  const out: WebSearchItem[] = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = unwrapDdgUrl(decodeEntities(m[1]))
    const title = stripTags(decodeEntities(m[2]))
    if (!url || !title) continue
    out.push({ title, url, snippet: '' })
  }
  // 摘要单独扫一遍（与标题顺序一一对应）
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let i = 0
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html)) !== null && i < out.length) {
    out[i].snippet = stripTags(decodeEntities(sm[1]))
    i++
  }
  return out
}

/** GET 文本（搜索页兜底通道；带浏览器 UA 与超时） */
async function fetchSearchText(url: string, headers: Record<string, string> = {}, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': SEARCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 请求 JSON 接口（各 API 搜索源；失败时截取响应片段，便于定位 Key/额度问题） */
async function fetchSearchJson(url: string, init: RequestInit = {}, timeoutMs = 25000): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': SEARCH_UA,
        Accept: 'application/json',
        ...((init.headers as Record<string, string>) || {}),
      },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`响应不是合法 JSON：${text.slice(0, 200)}`)
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 统一清洗结果（去空值、只保留 http(s) 链接；长摘要与正文一并保留供模型阅读） */
function cleanSearchItems(items: any[]): WebSearchItem[] {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      title: String(it?.title || '').trim(),
      url: String(it?.url || '').trim(),
      snippet: String(it?.snippet || it?.summary || '').trim(),
      ...(typeof it?.summary === 'string' && it.summary.trim() ? { summary: it.summary.trim() } : {}),
      ...(typeof it?.content === 'string' && it.content.trim() ? { content: it.content.trim().slice(0, 4000) } : {}),
    }))
    .filter((it) => it.title && /^https?:/i.test(it.url))
}

/** 单次搜索产物：结果列表 + 实际通道（browser / html-fallback / html / json / api / deepseek-api …） */
interface SearchOutcome {
  items: WebSearchItem[]
  via: string
}

/** Bing：隐藏浏览器渲染为主，HTML 解析兜底 */
async function searchBingWeb(query: string): Promise<SearchOutcome> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`
  try {
    const items = await searchViaBrowser(url, BING_EXTRACTOR, 'Bing')
    if (items.length) return { items, via: 'browser' }
    throw new Error('未解析到搜索结果')
  } catch (browserError: any) {
    const html = await fetchSearchText(url)
    const items = parseBingResults(html)
    if (items.length) return { items, via: 'html-fallback' }
    throw new Error(`未解析到搜索结果（浏览器通道：${browserError?.message || String(browserError)}）`)
  }
}

/** 百度：隐藏浏览器渲染为主，HTML 解析兜底 */
async function searchBaiduWeb(query: string): Promise<SearchOutcome> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`
  try {
    const items = await searchViaBrowser(url, BAIDU_EXTRACTOR, '百度')
    if (items.length) return { items, via: 'browser' }
    throw new Error('未解析到搜索结果')
  } catch (browserError: any) {
    const html = await fetchSearchText(url)
    const items = parseBaiduResults(html)
    if (items.length) return { items, via: 'html-fallback' }
    throw new Error(`未解析到搜索结果（浏览器通道：${browserError?.message || String(browserError)}）`)
  }
}

/** DuckDuckGo：HTML 端点为主，隐藏浏览器兜底 */
async function searchDuckDuckGoWeb(query: string): Promise<SearchOutcome> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  try {
    const html = await fetchSearchText(url)
    const items = parseDdgResults(html)
    if (items.length) return { items, via: 'html' }
    throw new Error('HTML 页面中未解析到结果')
  } catch (htmlError: any) {
    const items = await searchViaBrowser(url, DDG_EXTRACTOR, 'DuckDuckGo')
    if (items.length) return { items, via: 'browser' }
    throw new Error(`未解析到搜索结果（HTML 通道：${htmlError?.message || String(htmlError)}）`)
  }
}

/** SearXNG：自建实例 JSON 接口（实例需开启 format=json） */
async function searchSearxng(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.searxng.apiHost || '').trim().replace(/\/+$/, '')
  if (!host) throw new Error('未配置 SearXNG 实例地址')
  const params = new URLSearchParams({ q: query, format: 'json' })
  if (cfg.searxng.engines) params.set('engines', cfg.searxng.engines)
  if (cfg.searxng.language && cfg.searxng.language !== 'auto') params.set('language', cfg.searxng.language)
  const data = await fetchSearchJson(`${host}/search?${params.toString()}`)
  return {
    items: cleanSearchItems((data?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: r?.content ?? r?.snippet,
    }))),
    via: 'json',
  }
}

/** 博查 Bocha：POST /v1/web-search（Bearer） */
async function searchBocha(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.bocha.apiHost || 'https://api.bochaai.com').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.bocha.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置博查 API Key')
  const data = await fetchSearchJson(`${host}/v1/web-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: cfg.maxResults, summary: true }),
  })
  if (data?.code !== undefined && Number(data.code) !== 200) {
    throw new Error(`博查返回错误：${data?.msg || data?.code}`)
  }
  return {
    items: cleanSearchItems((data?.data?.webPages?.value || []).map((r: any) => ({
      title: r?.name, url: r?.url, snippet: r?.summary || r?.snippet,
    }))),
    via: 'api',
  }
}

/** 智谱 BigModel：POST /web_search（Bearer；search_std / search_pro） */
async function searchZhipu(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.zhipu.apiHost || 'https://open.bigmodel.cn/api/paas/v4').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.zhipu.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置智谱 API Key')
  const data = await fetchSearchJson(`${host}/web_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      search_query: query,
      search_engine: cfg.zhipu.searchEngine || 'search_std',
      count: cfg.maxResults,
    }),
  })
  return {
    items: cleanSearchItems((data?.search_result || []).map((r: any) => ({
      title: r?.title, url: r?.link || r?.url, snippet: stripTags(String(r?.content || '')),
    }))),
    via: 'api',
  }
}

/** Tavily：POST /search（Bearer） */
async function searchTavily(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {  const host = String(cfg.tavily.apiHost || 'https://api.tavily.com').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.tavily.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 Tavily API Key')
  const data = await fetchSearchJson(`${host}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: cfg.maxResults }),
  })
  return {
    items: cleanSearchItems((data?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: r?.content,
    }))),
    via: 'api',
  }
}

/**
 * Firecrawl（免 Key 可用）：POST `<host>/v2/search`。
 *
 * 与其它 API 源的关键差别：**apiKey 可以留空**——留空时不发 `Authorization` 头，
 * 走 Firecrawl 官方的免 Key 免费额度（按 **IP** 计量，约 1000 credits/月、一次搜索约 2 credits）；
 * 填了 Key 则用 Bearer 发出、换用用户自己的额度（官方正好收这个头）。
 * 因此这里**绝不能**像别的源那样在缺 Key 时抛错。
 *
 * 请求组装 / 响应解析 / 错误翻译都是纯函数，放在 `@/shared/webSearchFirecrawl`
 * （渲染层用同一份，避免两端行为漂移）。
 */
async function searchFirecrawl(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const apiKey = String(cfg.firecrawl.apiKey || '').trim()
  const req = buildFirecrawlSearchRequest({
    query,
    maxResults: cfg.maxResults,
    apiHost: cfg.firecrawl.apiHost,
    apiKey,
  })
  let data: any
  try {
    data = await fetchSearchJson(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    })
    const items = parseFirecrawlSearchResponse(data, cfg.maxResults)
    if (!items.length) throw new Error('Firecrawl 未返回可用结果')
    return { items, via: 'api' }
  } catch (e: any) {
    throw new Error(firecrawlErrorMessage(e, !!apiKey))
  }
}

/** Brave Search：GET /res/v1/web/search（X-Subscription-Token） */
async function searchBrave(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const host = String(cfg.brave.apiHost || 'https://api.search.brave.com').trim().replace(/\/+$/, '')
  const apiKey = String(cfg.brave.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 Brave Search API Key')
  const params = new URLSearchParams({ q: query, count: String(cfg.maxResults) })
  const data = await fetchSearchJson(`${host}/res/v1/web/search?${params.toString()}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  return {
    items: cleanSearchItems((data?.web?.results || []).map((r: any) => ({
      title: r?.title, url: r?.url, snippet: stripTags(String(r?.description || '')),
    }))),
    via: 'api',
  }
}

// ---------------------------------------------------------------------------
// 自定义（内网）搜索源
//
// 设置页可添加任意数量的自定义源（`config.customs`，搜索源 id 形如 `cs:<id>`）：
// - searxng：内网 SearXNG 兼容实例（`<地址>/search?q=&format=json`）
// - json：通用 HTTP JSON 接口（URL 模板 `{query}` 占位 / POST 请求体 / 请求头 / 字段映射）
// 地址允许不带协议（自动补 http://），结果中的相对链接按请求地址补全为绝对地址。
// ---------------------------------------------------------------------------

/** 归一化自定义源地址（去尾斜杠；缺协议时补 http://，便于内网 IP:端口 直接填写） */
function normalizeCustomHost(raw: string): string {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`
  return s
}

/** 点号路径取值（`data.list` / `hits.hits`）；路径为空时返回原对象 */
function pickJsonPath(root: any, pathStr: string): any {
  const keys = String(pathStr || '').split('.').map((k) => k.trim()).filter(Boolean)
  let cur = root
  for (const k of keys) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

/** 未填「结果路径」时按常见字段自动识别结果数组 */
const AUTO_ITEMS_PATHS = [
  'results', 'data.results', 'data.list', 'data.items', 'data.data', 'data',
  'items', 'list', 'hits.hits', 'webPages.value', 'search_result', 'documents', 'docs',
]

function resolveItemsArray(data: any, itemsPath: string): any[] {
  if (itemsPath) {
    const v = pickJsonPath(data, itemsPath)
    return Array.isArray(v) ? v : []
  }
  if (Array.isArray(data)) return data
  for (const p of AUTO_ITEMS_PATHS) {
    const v = pickJsonPath(data, p)
    if (Array.isArray(v) && v.length) return v
  }
  return []
}

/** 结果项字段取值（支持点号路径；未配置字段时按候选名依次尝试） */
function pickItemField(item: any, field: string, fallbacks: string[]): string {
  for (const f of field ? [field] : fallbacks) {
    const v = pickJsonPath(item, f)
    if (v == null) continue
    const s = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
    if (s.trim()) return s.trim()
  }
  return ''
}

/** 解析自定义请求头文本（每行 `Key: Value`；值中的 `{key}` 替换为 API Key） */
function parseCustomHeaderLines(text: string, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf(':')
    if (i <= 0) continue
    const key = s.slice(0, i).trim()
    if (!key) continue
    out[key] = s.slice(i + 1).trim().replace(/\{key\}/g, apiKey)
  }
  return out
}

/** 自定义源请求头（自定义头 + 未指定 Authorization 时用 API Key 补 Bearer） */
function buildCustomHeaders(cs: WebSearchCustomSource, apiKey: string): Record<string, string> {
  const headers = parseCustomHeaderLines(cs.headers, apiKey)
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
  if (apiKey && !hasAuth) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

/** 请求 URL 拼接：含 `{query}` 占位则替换；否则 POST 用原地址，GET 自动追加 `q` 参数 */
function buildCustomUrl(base: string, query: string, method: 'GET' | 'POST'): string {
  if (!base) throw new Error('未配置请求地址')
  if (base.includes('{query}')) return base.replace(/\{query\}/g, encodeURIComponent(query))
  if (method === 'POST') return base
  return `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`
}

/** 把内网源返回的相对链接补全为绝对地址（http/https 或 // 开头原样返回） */
function resolveItemUrl(raw: string, base: string): string {
  const u = String(raw || '').trim()
  if (!u) return ''
  if (/^https?:/i.test(u)) return u
  if (u.startsWith('//')) return `https:${u}`
  if (!base) return ''
  try {
    return new URL(u, base).toString()
  } catch {
    return ''
  }
}

/** 自定义（内网）搜索源：searxng 兼容实例 / 通用 HTTP JSON 接口 */
async function searchCustomSource(
  cs: WebSearchCustomSource,
  query: string,
  config: WebSearchConfig,
): Promise<SearchOutcome> {
  const name = cs.name || '自定义源'
  const apiKey = String(cs.apiKey || '').trim()
  const base = normalizeCustomHost(cs.apiHost)
  if (!base) throw new Error(`自定义源「${name}」未配置请求地址`)

  // SearXNG 兼容实例：GET <地址>/search?q=&format=json
  if (cs.kind === 'searxng') {
    const params = new URLSearchParams({ q: query, format: 'json' })
    if (cs.engines) params.set('engines', cs.engines)
    if (cs.language && cs.language !== 'auto') params.set('language', cs.language)
    const data = await fetchSearchJson(`${base}/search?${params.toString()}`, {
      headers: buildCustomHeaders(cs, apiKey),
    })
    return {
      items: cleanSearchItems((data?.results || []).map((r: any) => ({
        title: r?.title,
        url: resolveItemUrl(String(r?.url || ''), base),
        snippet: r?.content ?? r?.snippet,
      }))),
      via: 'custom-searxng',
    }
  }

  // 通用 HTTP JSON 接口：URL 模板 / POST 请求体 / 自定义头 / 字段映射
  const url = buildCustomUrl(base, query, cs.method)
  const init: RequestInit = { method: cs.method, headers: buildCustomHeaders(cs, apiKey) }
  if (cs.method === 'POST') {
    const tpl = String(cs.bodyTemplate || '').trim()
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
    // `{query}` 原样替换（JSON 模板请自行加引号）；转义反斜杠与双引号避免拼出非法 JSON
    init.body = tpl
      ? tpl.replace(/\{query\}/g, query.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
      : JSON.stringify({ query, count: config.maxResults })
  }
  const data = await fetchSearchJson(url, init)
  const arr = resolveItemsArray(data, String(cs.itemsPath || '').trim())
  if (!arr.length) {
    throw new Error(`自定义源「${name}」响应中未解析到结果数组（可在「结果路径」填 data.list 之类的字段路径）`)
  }
  return {
    items: cleanSearchItems(arr.slice(0, Math.max(config.maxResults, 20)).map((it: any) => ({
      title: pickItemField(it, cs.titleField, ['title', 'name', 'subject', 'heading', 'docTitle']),
      url: resolveItemUrl(pickItemField(it, cs.urlField, ['url', 'link', 'href', 'uri', 'path']), base),
      snippet: pickItemField(it, cs.snippetField, ['snippet', 'content', 'summary', 'description', 'text', 'abstract']),
    }))),
    via: 'custom-json',
  }
}

/**
 * DeepSeek 官方搜索：走原生 **Search API**（`POST <base>/v1/tools/search`）。
 *
 * 与旧实现（Anthropic 兼容 Messages + 服务端 `web_search` 工具）的关键区别：
 *  1. **不再是一次模型调用**——直接返回结构化结果，延迟与费用都按请求次数计；
 *  2. 手机 / 网页端也能用（纯 HTTP + Bearer，不依赖 Anthropic 端点）；
 *  3. 空 `results` 是合法的“无匹配”，由上层按回退策略处理，而不是抛“服务端没触发搜索”。
 *
 * 请求组装 / 响应解析 / 错误翻译在 `@/shared/deepseekApi`（纯逻辑有自测覆盖）。
 */
async function searchDeepSeekOfficial(query: string, cfg: WebSearchConfig): Promise<SearchOutcome> {
  const ds = normalizeDeepSeekSearchConfig((cfg as any).deepseek)
  const apiKey = String(ds.apiKey || '').trim()
  if (!apiKey) throw new Error('未配置 DeepSeek API Key（可在「工具 → 搜索」填，或让对话使用 DeepSeek 以复用凭据）')

  const items = await runDeepSeekSearchApi({
    query,
    maxResults: cfg.maxResults,
    needContent: !!ds.needContent,
    apiHost: ds.apiHost,
    apiKey,
  })
  // 官方结果带长摘要（summary）：原样保留，模型读依据比只看短摘要可靠
  return { items: cleanSearchItems(items), via: 'deepseek-api' }
}

/** 单个搜索源执行（Bing/百度 走查询改写；其余源保持原句） */
async function runSingleSearch(
  provider: WebSearchProviderId,
  query: string,
  config: WebSearchConfig,
): Promise<SearchOutcome> {
  // 自定义（内网）源：按配置中的类型与字段映射执行
  const custom = findWebSearchCustomSource(config, provider)
  if (custom) return searchCustomSource(custom, query, config)
  // Bing 对长中文句拆词/实体识别不稳定 → 仅 Bing 走查询改写（其余源保持原句）
  const q = provider === 'bing' && config.rewriteZhQuery ? (rewriteQueryForBing(query) || query) : query
  switch (provider) {
    case 'baidu': return searchBaiduWeb(q)
    case 'duckduckgo': return searchDuckDuckGoWeb(q)
    case 'searxng': return searchSearxng(q, config)
    case 'bocha': return searchBocha(q, config)
    case 'zhipu': return searchZhipu(q, config)
    case 'deepseek': return searchDeepSeekOfficial(q, config)
    case 'tavily': return searchTavily(q, config)
    case 'brave': return searchBrave(q, config)
    case 'firecrawl': return searchFirecrawl(q, config)
    case 'bing':
    default: return searchBingWeb(q)
  }
}

/** 结果清洗 + 截断到 maxResults（统一工具返回值形状） */
function toSearchItems(items: WebSearchItem[], maxResults: number): WebSearchItem[] {
  return items.slice(0, maxResults).map((it) => ({
    title: it.title,
    url: it.url,
    snippet: it.snippet || '',
    summary: it.summary || it.snippet || '',
    ...(it.content ? { content: it.content } : {}),
  }))
}

/** 按 URL 去重合并多个源的结果（保持源顺序；同 URL 保留先出现的项） */
function mergeSearchItems(groups: WebSearchItem[][], maxResults: number): WebSearchItem[] {
  const seen = new Set<string>()
  const out: WebSearchItem[] = []
  for (const group of groups) {
    for (const it of group) {
      const key = String(it.url || '').replace(/\/+$/, '').toLowerCase() || `${it.title}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(it)
      if (out.length >= maxResults) return out
    }
  }
  return out
}

/**
 * 执行一次联网搜索（web_search 工具与设置页「测试搜索」共用）。
 * 支持多源：`fallback` 依次回退（第一个有结果的源胜出）/ `merge` 并行后合并去重。
 * 全部源失败或均无结果时抛错（错误信息带各源原因）。
 */
export async function runWebSearch(rawQuery: string, cfg: WebSearchConfig = webSearchConfig): Promise<WebSearchRunResult> {
  const query = String(rawQuery ?? '').trim()
  if (!query) throw new Error('搜索关键词不能为空')
  const config = normalizeWebSearchConfig(cfg)
  const providers = config.providers
  const started = Date.now()

  if (config.strategy === 'merge') {
    // 并行聚合：所有启用源同时执行，成功的结果按源顺序合并去重
    const settled = await Promise.allSettled(providers.map((id) => runSingleSearch(id, query, config)))
    const groups: WebSearchItem[][] = []
    const attempts: Array<{ provider: WebSearchProviderId; ok: boolean; error?: string }> = []
    settled.forEach((s, i) => {
      const id = providers[i]
      if (s.status === 'fulfilled' && s.value.items.length) {
        groups.push(s.value.items)
        attempts.push({ provider: id, ok: true })
      } else {
        attempts.push({
          provider: id,
          ok: false,
          error: s.status === 'fulfilled' ? '未返回结果' : (s.reason?.message || String(s.reason)),
        })
      }
    })
    const results = mergeSearchItems(groups, config.maxResults)
    if (!results.length) {
      const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join('；')
      throw new Error(`全部搜索源均未返回结果 —— ${detail}`)
    }
    return {
      query,
      provider: attempts.find((a) => a.ok)!.provider,
      providers,
      via: 'merge',
      results,
      elapsedMs: Date.now() - started,
      attempts,
    }
  }

  // 回退：按配置顺序逐个尝试，第一个有结果的源胜出
  const attempts: Array<{ provider: WebSearchProviderId; ok: boolean; error?: string }> = []
  for (const id of providers) {
    try {
      const outcome = await runSingleSearch(id, query, config)
      if (outcome.items.length) {
        attempts.push({ provider: id, ok: true })
        return {
          query,
          provider: id,
          providers,
          via: outcome.via,
          results: toSearchItems(outcome.items, config.maxResults),
          elapsedMs: Date.now() - started,
          attempts,
        }
      }
      attempts.push({ provider: id, ok: false, error: '未返回结果' })
    } catch (e: any) {
      attempts.push({ provider: id, ok: false, error: e?.message || String(e) })
    }
  }
  const detail = attempts.map((a) => `${a.provider}: ${a.error || '失败'}`).join('；')
  throw new Error(`全部搜索源均失败 —— ${detail}`)
}

async function webSearch(input: any): Promise<ToolResult> {
  const rawQuery = String(input?.query ?? '')
  if (!rawQuery.trim()) return { ok: false, error: 'query 参数必填' }
  try {
    const r = await runWebSearch(rawQuery)
    if (!r.results.length) return { ok: false, error: `搜索失败（搜索源：${r.provider}）：未返回结果` }
    return {
      ok: true,
      value: {
        query: rawQuery,
        provider: r.provider,
        providers: r.providers,
        via: r.via,
        results: r.results,
      },
    }
  } catch (e: any) {
    // 错误链用搜索源显示名（自定义源显示用户起的名字，比 cs:xxx 直观）
    const chain = webSearchConfig.providers
      .map((id) => webSearchProviderMeta(id, webSearchConfig).label)
      .join(' → ')
    return { ok: false, error: `搜索失败（搜索源：${chain}）：${e?.message || String(e)}` }
  }
}

/** 从 HTML 提取正文文本（去掉 script/style/标签，压缩空白） */
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 反爬兜底：用 Electron 无头 BrowserWindow 加载页面（真实 Chromium 执行 JS，
 * 可过知乎 zh-zse-ck 等 JS 加密挑战），页面加载完成后提取正文文本。
 * 仅作为 webFetch 直接 fetch 失败（403/网络错误）时的降级通道。
 */
async function fetchViaBrowser(url: string, timeoutMs = 25000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let win: BrowserWindow | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (win && !win.isDestroyed()) win.destroy() } catch { /* 忽略 */ }
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('浏览器抓取超时')))
    }, timeoutMs)
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: {
          // 不需要 preload；禁用 node 集成避免页面脚本触碰主进程
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          sandbox: true,
        },
      })
      // 隐藏抓取窗口：不参与全局窗口缩放（缩放会改变页面布局，影响抓取结果）
      excludeFromAppZoom(win)
      const wc = win.webContents
      wc.on('did-finish-load', async () => {
        try {
          // 等一小段让页面 JS 渲染（知乎挑战/懒加载内容）
          await new Promise(r => setTimeout(r, 1200))
          const text = await wc.executeJavaScript(`document.body ? document.body.innerText : ''`)
          if (text && String(text).trim().length > 0) {
            finish(() => resolve(String(text).trim()))
          } else {
            finish(() => reject(new Error('页面无内容')))
          }
        } catch (e: any) {
          finish(() => reject(new Error(`提取失败: ${e?.message || String(e)}`)))
        }
      })
      wc.on('did-fail-load', (_e, code, desc) => {
        finish(() => reject(new Error(`页面加载失败 (${code}): ${desc}`)))
      })
      // 拦截弹窗/新窗口（避免导航跳出）
      wc.setWindowOpenHandler(() => ({ action: 'deny' }))
      wc.loadURL(url)
    } catch (e: any) {
      finish(() => reject(new Error(`浏览器抓取启动失败: ${e?.message || String(e)}`)))
    }
  })
}

/** 用 pdfjs-dist 从 PDF 字节流提取全文（与 index.ts readPdf 同款实现） */
async function parsePdfBytes(uint8: Uint8Array): Promise<string> {
  const loadingTask = PDFJS.getDocument({ data: uint8 })
  const pdfDocument = await loadingTask.promise
  const pageCount = pdfDocument.numPages
  const parts: string[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDocument.getPage(i)
    const content = await page.getTextContent()
    const strings = (content as { items: { str: string }[] }).items.map((item) => item.str)
    parts.push(strings.join(' '))
  }
  return parts.join('\n')
}

/** 从 Word（.docx / .doc）提取 Markdown 文本（统一走 office/word-to-markdown：atx 标题 / 管道表格 /
 *  编号回填 / 公式 LaTeX；工具场景只要正文文字，故不提取图片，避免写盘） */
async function parseWordFile(filePath: string): Promise<string> {
  return wordToMarkdown({ filePath, extractImages: false })
}

/** 二维数组 → Markdown 表格（与 index.ts convertToMarkdown 同款） */
function rowsToMarkdown(data: any[][]): string {
  let markdown = ''
  const headers = data[0] || []
  markdown += '| ' + headers.join(' | ') + ' |\n'
  markdown += '| ' + headers.map(() => '---').join(' | ') + ' |\n'
  for (let i = 1; i < data.length; i++) {
    markdown += '| ' + (data[i] || []).join(' | ') + ' |\n'
  }
  return markdown
}

/** 用 SheetJS 从 .xlsx/.xls 提取 Markdown 表格文本（与 index.ts 同款实现，逐工作表输出） */
async function parseXlsxFile(filePath: string): Promise<string> {
  const workbook = xlsx.readFile(filePath)
  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName]
    const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 }) as any[][]
    if (!Array.isArray(jsonData) || jsonData.length === 0) continue
    parts.push(`## ${sheetName}\n\n${rowsToMarkdown(jsonData)}`)
  }
  return parts.join('\n\n')
}

/**
 * 直接访问通道：HTTP 请求 + HTML 正文提取 / PDF 解析。
 * 失败（HTTP 非 2xx / 超时 / 内容为空 / 反爬验证页）一律抛错，由上层决定是否回退。
 * 命中反爬验证页且目标是 DOI 时，先试 Crossref 元数据（无需 Key），失败再抛错。
 */
async function fetchViaDirect(url: string, doi: string | null): Promise<{ text: string; via: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': SEARCH_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': new URL(url).origin + '/',
        'Upgrade-Insecure-Requests': '1',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // 先读二进制：既能用魔数识别 PDF，也可回退按 UTF-8 解码为 HTML
    const buf = new Uint8Array(await res.arrayBuffer())
    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    const isPdfUrl = /\.pdf($|\?)/i.test(url)
    const isPdfMagic = buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 // %PDF
    if (ctype.includes('application/pdf') || isPdfUrl || isPdfMagic) {
      // PDF 文档：用 pdfjs-dist 提取正文文本（不能按 HTML 文本解码，否则得到 %PDF 乱码）
      let pdfText = ''
      try {
        pdfText = await parsePdfBytes(buf)
      } catch (e: any) {
        throw new Error(`PDF 解析失败: ${e?.message || String(e)}`)
      }
      if (!pdfText || !pdfText.trim()) {
        throw new Error('PDF 解析结果为空（可能是扫描件/图片型 PDF，建议改用 OCR 或截图）')
      }
      return { text: pdfText, via: 'pdf' }
    }
    const html = new TextDecoder().decode(buf)
    const text = extractTextFromHtml(html)
    if (text.length <= 50) throw new Error('页面内容为空')
    // 检测到反爬验证页（人机验证/WAF/Cloudflare）：不当作成功内容返回
    if (isBotChallengePage(text)) {
      if (doi) {
        const crossrefText = await fetchDoiViaCrossref(doi, controller.signal)
        if (crossrefText) return { text: crossrefText, via: 'crossref' }
      }
      throw new Error('目标站点需要人机验证（验证页）')
    }
    return { text, via: 'fetch' }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('请求超时')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** DeepSeek Fetch 通道：官方接口在服务端抓取并返回 Markdown 正文 */
async function fetchViaDeepSeek(url: string, config: WebFetchConfig): Promise<string> {
  const ds = normalizeDeepSeekFetchConfig(config.deepseek)
  const apiKey = String(ds.apiKey || '').trim()
  if (!apiKey) {
    throw new Error('未配置 DeepSeek API Key（可在「工具 → 抓取」填，或让对话使用 DeepSeek 以复用凭据）')
  }
  const page = await runDeepSeekFetchApi({ url, apiKey, apiHost: ds.apiHost })
  return page.content
}

/**
 * 执行一次网页抓取（web_fetch 工具与设置页「测试抓取」共用）。
 *
 * 按配置里的顺序依次尝试**已开启**的通道：direct → deepseek → browser（顺序可调）。
 * 每个通道失败都只记下原因并继续；全部失败时抛错，错误信息里带每个通道的具体原因。
 */
export async function runWebFetch(
  rawUrl: string,
  cfg: WebFetchConfig = webFetchConfig,
): Promise<{ url: string; text: string; length: number; via: string }> {
  const url = String(rawUrl ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('url 参数必填（http/https）')
  const config = normalizeWebFetchConfig(cfg)
  const channels = enabledWebFetchChannels(config)
  if (!channels.length) throw new Error('抓取通道全部关闭：请在「工具 → 抓取」中至少开启一种')

  // 目标可能为 DOI 链接（doi.org 或裸 DOI）：命中反爬验证页时可用 Crossref 降级获取元数据
  const doi = extractDoiFromUrl(url)
  const failures: string[] = []

  for (const channel of channels) {
    const label = webFetchChannelMeta(channel).label
    try {
      let text = ''
      let via: string = channel
      if (channel === 'direct') {
        const r = await fetchViaDirect(url, doi)
        text = r.text
        via = r.via
      } else if (channel === 'deepseek') {
        text = await fetchViaDeepSeek(url, config)
      } else {
        text = await fetchViaBrowser(url)
      }

      const trimmed = String(text || '').trim()
      if (!trimmed) throw new Error('返回内容为空')
      // DeepSeek 返回的已经是服务端提取好的 Markdown，不做验证页特征匹配（避免正文误判）
      if (channel !== 'deepseek' && isBotChallengePage(trimmed)) throw new Error('返回人机验证页')
      return { url, text: trimmed.slice(0, 20000), length: trimmed.length, via }
    } catch (e: any) {
      failures.push(`${label}：${e?.message || String(e)}`)
    }
  }

  // 全通道失败后的最后兜底：DOI 目标用 Crossref 元数据（direct 关闭时也能救回来）
  if (doi) {
    try {
      const crossrefText = await fetchDoiViaCrossref(doi)
      if (crossrefText && crossrefText.trim()) {
        return {
          url,
          text: crossrefText.slice(0, 20000),
          length: crossrefText.length,
          via: 'crossref',
        }
      }
    } catch {
      /* Crossref 也失败：保留下面的通道错误 */
    }
  }

  throw new Error(`抓取失败 —— ${failures.join('；')}`)
}

async function webFetch(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const url = String(input?.url ?? '')
  if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'url 参数必填（http/https）' }
  try {
    const r = await runWebFetch(url)
    return {
      ok: true,
      value: {
        url: r.url,
        text: r.text,
        length: r.length,
        via: r.via,
        modelText: `${r.url}（${r.via}，${r.length} 字符）\n\n${r.text}`,
      },
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

// ---------------------------------------------------------------------------
// MCP 调用（统一工具注册表中的 mcp_call，供 Agent 预设/集群控制场景使用）
// ---------------------------------------------------------------------------

/** 参数名归一化比较键（workbook_id ≡ workbookId、sheet_name ≡ sheetName） */
function normArgKey(k: string): string {
  return String(k).toLowerCase().replace(/[_-]/g, '')
}

/**
 * 会话类参数（workbookId / docId …）：不作为前置硬拦截项——
 * 服务端可自动复用唯一已打开的会话，或给出带「当前会话列表」的精确提示。
 */
const SESSION_ARG_RE = /^(workbookid|bookid|wbid|docid|documentid)$/

/** 按工具 inputSchema 找出缺失的非会话必填参数（schema 缺失或无 required 时返回空数组 = 不拦截） */
function missingRequiredArgs(schema: any, args: Record<string, any>): string[] {
  const required: string[] = Array.isArray(schema?.required) ? schema.required.map(String) : []
  if (required.length === 0) return []
  const have = new Set(Object.keys(args || {}).map(normArgKey))
  return required.filter((k) => !SESSION_ARG_RE.test(normArgKey(k)) && !have.has(normArgKey(k)))
}

async function mcpCall(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const ctxServerIds: string[] = (ctx as any).mcpServerIds || ((ctx as any).mcpServerId ? [(ctx as any).mcpServerId] : [])
  // LLM 常把 tool/serverId 误放进 args 内层（或用 toolName 命名）——多层级兜底
  const innerArgs = input?.args && typeof input.args === 'object' && !Array.isArray(input.args) ? (input.args as any) : {}
  const toolName = String(
    input?.tool || input?.toolName || innerArgs.tool || innerArgs.toolName || ''
  )
  if (!toolName) return { ok: false, error: 'mcp_call 缺少 tool 参数' }

  // serverId 解析优先级：模型显式传入 > ctx 中唯一服务 > 主进程已连接服务按工具名自动匹配（唯一）
  let serverId = String(input?.serverId || innerArgs.serverId || innerArgs.server_id || (ctxServerIds.length === 1 ? ctxServerIds[0] : ''))
  if (!serverId && toolName) {
    // LLM 常省略可选参数 serverId：按目标工具名在已连接服务中匹配，唯一命中时自动使用
    const matches = mcpService.findServersByTool(toolName)
    if (matches.length === 1) serverId = matches[0].serverId
    else if (matches.length > 1) {
      const candidates = matches.map((m) => `  - ${m.serverName || m.serverId}（serverId: ${m.serverId}）`).join('\n')
      return {
        ok: false,
        error: `mcp_call 缺少 serverId 且无法自动确定：有 ${matches.length} 个已连接服务都能提供工具「${toolName}」，请在 mcp_call 参数中显式传入 serverId。候选服务：\n${candidates}`,
      }
    }
  }
  if (!serverId) {
    return {
      ok: false,
      error: 'mcp_call 缺少 serverId：请在「设置 → MCP 服务」中启用并连接 MCP 服务，并在「设置 → 工具管理」中启用 mcp_call（智能体/预设模式会自动携带已启用的服务）；也可在 mcp_call 参数中显式传入 serverId。',
    }
  }

  const ctxConfigs: any[] = (ctx as any).mcpServerConfigs || ((ctx as any).mcpServerConfig ? [(ctx as any).mcpServerConfig] : [])
    let config = input?.config || ctxConfigs.find((c: any) => c?.id === serverId) || ctxConfigs[0] || {}
  if (typeof config === 'string') {
    try { config = JSON.parse(config) } catch { config = {} }
  }
  if (!config || typeof config !== 'object') config = {}

  let args = (input as any)?.args ?? (input as any)?.arguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = { _raw: args } }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}

  // 若 tool/serverId 取自 args 内层，从转发参数中剔除，避免污染远端工具入参
  if (!input?.tool && (args.tool !== undefined || args.toolName !== undefined)) {
    delete args.tool
    delete args.toolName
  }
  if (!input?.serverId && (args.serverId !== undefined || args.server_id !== undefined)) {
    delete args.serverId
    delete args.server_id
  }

  // 模型常见错误：把工具入参直接放在 mcp_call 顶层（例如 preset_write 的 preset 与 args 平级）。
  // 按目标工具的 inputSchema 把顶层同名键并入 args（只补缺失的，不覆盖已给的），
  // 避免「参数其实给了、只是放错层」被前置校验直接拒绝。
  const toolSchema = mcpService.getToolSchema(serverId, toolName)
  const schemaProps = toolSchema?.properties && typeof toolSchema.properties === 'object'
    ? Object.keys(toolSchema.properties)
    : []
  const META_KEYS = new Set(['serverId', 'server_id', 'tool', 'toolName', 'args', 'arguments', 'config'])
  for (const key of schemaProps) {
    if (META_KEYS.has(key)) continue
    if (args[key] === undefined && input && input[key] !== undefined) args[key] = input[key]
  }

  // 必填参数前置校验：按工具 schema 检查（别名归一后比较：workbook_id ≡ workbookId、sheet_name ≡ sheetName）。
  // 缺参直接回可操作的提示，不再把空参透传到服务端只换回一句晦涩错误；
  // 会话 ID（workbookId / docId）不在硬拦截之列——见 SESSION_ARG_RE 注释。
  const missing = missingRequiredArgs(toolSchema, args)
  if (missing.length) {
    return {
      ok: false,
      error: `mcp_call 调用 ${toolName} 缺少必填参数：${missing.join('、')}（参数名支持别名，如 workbook_id ≡ workbookId、sheet_name ≡ sheetName；参数请放进 args，直接放在 mcp_call 顶层也可以）`,
    }
  }

  try {
    const res = await mcpService.callTool(serverId, config, toolName, args, String(ctx?.sessionId || ctx?.agentId || '') || undefined)
    if (res.success) {
      let data: any = res.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch { /* 保留原文 */ }
      }
      return { ok: true, value: { serverId, tool: toolName, data } }
    }
    return { ok: false, error: res.error || `MCP 工具 ${toolName} 调用失败` }
  } catch (e: any) {
    return { ok: false, error: `MCP 调用异常: ${e?.message || String(e)}` }
  }
}


// ---------------------------------------------------------------------------
// 子代理接缝（路线图 2.6：ctx.subagents 的 in-process provider）
//
// 模型可用 run_subagent 派生一个独立的 agent 会话执行子任务（复用 agent 循环）。
// 工具逻辑参照 DSH 的 @deepseek-ai/dsh-tool-subagent：
// - **前台默认**：等待子代理本轮收敛后取回最终输出；`run_in_background: true` 则
//   立即返回 jobId，父 Agent 继续干活，稍后用 `job_output` 收集、`job_kill` 停止；
// - **递归预算**：子代理深度逐层 +1，超过上限直接拒绝（DSH 的 assertSubagentMaxDepth）；
// - **能力继承**：默认继承调用方的工具白名单与沙箱/MCP/知识库配置，并剔除
//   `run_subagent` 自身（无深度预算的旧实现靠"禁止递归"，现在两者都有）；
// - **中止可解释**：超时 / 父级取消都返回「已中止 + 中止前的部分输出」，
//   绝不把部分结果当成功（DSH 的 stopReasonError + partial output）。
// ---------------------------------------------------------------------------

/** 子代理嵌套深度上限（根 agent = 0）。超过即拒绝，防止自我复制式递归。 */
const SUBAGENT_MAX_DEPTH = 3
/** 单个子代理默认超时（10 分钟）与上限（1 小时） */
const SUBAGENT_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const SUBAGENT_MAX_TIMEOUT_MS = 60 * 60 * 1000
/** 运行期 job 记录：jobId → 子代理会话（供 job_output / job_kill 定位真实 agent） */
const subagentJobs = new Map<string, { childId: string; label: string; owner: string; startedAt: number }>()

function clampSubagentTimeout(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return SUBAGENT_DEFAULT_TIMEOUT_MS
  return Math.min(SUBAGENT_MAX_TIMEOUT_MS, Math.max(5000, Math.round(n)))
}

/**
 * 解析子代理的工具白名单。
 *
 * 一层委派默认就够，因此继承来的白名单一律剔除 `run_subagent`（避免"子代理再开子代理"
 * 的意外分支）；需要多层委派时调用方在 `tools` 里显式写出 `run_subagent`，
 * 由深度预算（SUBAGENT_MAX_DEPTH）兜住上限。
 */
function resolveChildTools(input: any, ctx: ToolExecutionContext): string[] {
  if (Array.isArray(input?.tools)) return input.tools.map(String).filter(Boolean)
  const parentTools = (ctx as any).tools
  if (Array.isArray(parentTools)) return parentTools.map(String).filter((t) => t !== 'run_subagent')
  if (parentTools === null) {
    // 父级 = 全部工具：按该作用域可见的工具清单物化（等价继承，且能去掉 run_subagent）
    return toolRegistry.list(ctx.scope).map((d) => String(d.name)).filter((t) => t !== 'run_subagent')
  }
  return ['read_file', 'write_file', 'replace_in_file', 'multi_replace', 'list_dir', 'search_files', 'run_python', 'kb_search', 'web_search', 'web_fetch', 'ask_user', 'update_plan', 'update_todo']
}

/** 子代理默认系统提示（无 systemPrompt / member 时用） */
const SUBAGENT_DEFAULT_SYSTEM_PROMPT =
  '你是一个子代理（subagent），负责独立完成父任务分配给你的子任务：自己做调研、自己动手改文件，' +
  '最后直接输出可被父代理采用的结果（结论 + 依据 + 涉及的文件路径）。不要反问父代理，信息不足时按最合理的假设推进并说明假设。'

async function runSubagent(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const prompt = String(input?.prompt ?? '')
  if (!prompt.trim()) return { ok: false, error: 'prompt 参数必填（子任务的完整描述）' }
  const parentId = ctx.agentId || ctx.sessionId
  if (!parentId) return { ok: false, error: 'run_subagent 只能在 agent 会话内使用' }

  // ---- 群成员身份（AgentSwarm 注入 ctx.swarmMembers；缺省 = 通用子代理）----
  const memberName = String(input?.member ?? '').trim()
  const members: Record<string, any> | undefined = (ctx as any).swarmMembers
  let member: any
  if (memberName) {
    if (!members || typeof members !== 'object') {
      return {
        ok: false,
        error: `member="${memberName}" 不可用：当前会话没有群成员名册。群内协作请直接 @点名（由群聊调度），` +
          'run_subagent 只用于委派临时的通用子任务（不要传 member）。',
      }
    }
    member = members[memberName]
    if (!member) {
      const names = Object.keys(members)
      return { ok: false, error: `未找到群成员 "${memberName}"${names.length ? `；可用成员：${names.join('、')}` : ''}` }
    }
  }

  // ---- 递归预算（DSH maxDepth 语义）----
  const depth = Number((ctx as any).swarmDepth) || 0
  if (depth >= SUBAGENT_MAX_DEPTH) {
    return {
      ok: false,
      error: `子代理嵌套深度已达上限（${SUBAGENT_MAX_DEPTH} 层，当前第 ${depth + 1} 层）：请把剩下的工作在本层完成，不要再派生下一级`,
    }
  }

  const childTools = resolveChildTools(input, ctx)

  const labelBase = String(input?.description ?? '').trim() || prompt.replace(/\s+/g, ' ').slice(0, 24)
  const label = memberName ? `subagent:${memberName}` : `subagent:${labelBase}`

  const child = createAgent({
    systemPrompt: String(input?.systemPrompt || member?.systemPrompt || SUBAGENT_DEFAULT_SYSTEM_PROMPT),
    provider: input?.provider || member?.provider || 'ollama',
    config: input?.config ?? member?.config,
    llmConfig: input?.llmConfig ?? member?.llmConfig,
    tools: Array.isArray(input?.tools) ? childTools : (member?.tools ?? childTools),
    cwd: member?.cwd || ctx.cwd,
    label,
    maxSteps: Math.min(50, Math.max(1, Number(input?.maxSteps ?? member?.maxSteps) || 10)),
    sandboxMode: (ctx as any).sandboxMode ?? member?.sandboxMode,
    mcpServerIds: (ctx as any).mcpServerIds ?? member?.mcpServerIds,
    mcpServerConfigs: (ctx as any).mcpServerConfigs ?? member?.mcpServerConfigs,
    mcpEquipmentIds: (ctx as any).mcpEquipmentIds ?? member?.mcpEquipmentIds,
    kbPaths: (ctx as any).kbPaths ?? member?.kbPaths,
    kbTopK: (ctx as any).kbTopK,
    parentId,
    // 递归预算：子代理再派生子代理时据此拒绝
    swarmDepth: depth + 1,
    swarmChain: [...((ctx as any).swarmChain || []), memberName].filter(Boolean),
  })

  const timeoutMs = clampSubagentTimeout(input?.timeout_ms ?? input?.timeoutMs)
  const background = input?.run_in_background === true
  // 后台模式必须能收结果：调用方白名单里没有 job_output 时，jobId 交出去也收不回来——
  // 直接拒绝并给出两条可走的路，而不是让模型拿到一个永远收不到结果的句柄。
  if (background) {
    const callerTools = (ctx as any).tools
    if (Array.isArray(callerTools) && !callerTools.includes('job_output')) {
      return {
        ok: false,
        error: 'run_in_background 需要 job_output 工具来收集结果，但当前会话的工具白名单里没有它：' +
          '请改用前台模式（去掉 run_in_background，直接等它返回），或先在工具管理里启用 job_output / job_kill。',
      }
    }
  }

  // ---- 后台模式：登记 job 后立即返回，父 Agent 继续干活 ----
  if (background) {
    const job = jobRegistry.start('subagent', parentId, label, { progress: null, detail: '后台子代理运行中' })
    subagentJobs.set(job.id, { childId: child.id, label, owner: parentId, startedAt: Date.now() })
    void (async () => {
      try {
        const r = await awaitAgentTurn(child.id, prompt, { timeoutMs, source: 'subagent' })
        if (r.ok) {
          jobRegistry.complete(job.id, { agentId: child.id, output: r.output })
        } else {
          jobRegistry.fail(job.id, [r.error, r.output ? `已产出的部分输出：\n${r.output}` : ''].filter(Boolean).join('\n'))
        }
      } catch (e: any) {
        jobRegistry.fail(job.id, `子代理执行失败: ${e?.message || String(e)}`)
      } finally {
        subagentJobs.delete(job.id)
        await disposeAgent(child.id)
      }
    })()
    return {
      ok: true,
      value: {
        kind: 'background',
        jobId: job.id,
        agentId: child.id,
        message: `后台子代理已启动（jobId=${job.id}）。继续你的工作，需要结果时用 job_output(job_id="${job.id}") 收集（可传 wait:true 阻塞等待）；不再需要时用 job_kill 停止。`,
      },
    }
  }

  // ---- 前台模式：等本轮收敛，超时/取消都带上部分输出 ----
  try {
    const r = await awaitAgentTurn(child.id, prompt, { timeoutMs, signal: ctx.signal, source: 'subagent' })
    const partial = r.output.trim()
    if (!r.ok) {
      const head = r.error || '子代理未正常完成'
      return {
        ok: false,
        error: partial ? `${head}\n\n子代理中止前已产出的部分输出（可作为不完整结果参考）：\n${partial}` : head,
      }
    }
    if (!partial) {
      return { ok: false, error: '子代理没有产出任何文本结果（可能只调用了工具就结束了）：请把任务描述写得更具体，或在 prompt 中要求它直接给出结论' }
    }
    return {
      ok: true,
      value: {
        kind: 'foreground',
        agentId: child.id,
        output: partial,
        ...(memberName ? { member: memberName } : {}),
      },
    }
  } catch (e: any) {
    return { ok: false, error: `子代理执行失败: ${e?.message || String(e)}` }
  } finally {
    await disposeAgent(child.id)
  }
}

// ---------------------------------------------------------------------------
// 后台任务工具（job_output / job_kill）
//
// 对应 DSH 的 @deepseek-ai/dsh-tool-jobs：后台子代理（run_in_background）启动后，
// 用 job_output 收集结果（可选阻塞等待）、job_kill 停止。job 记录与任务面板同源
// （job-registry），因此界面上也能看到进度。
// ---------------------------------------------------------------------------

/** job_output：读取后台任务状态与结果（wait=true 时阻塞等待其结束） */
async function jobOutput(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const jobId = String(input?.job_id ?? input?.jobId ?? '').trim()
  if (!jobId) return { ok: false, error: 'job_id 参数必填（run_subagent / shell 后台返回的 jobId）' }

  // 后台 shell：输出是**消费式**的——每次 job_output 只返回"上次之后的新输出"（DSH 同语义）
  const shellJob = shellJobs.get(jobId)
  if (shellJob) {
    const wait = input?.wait === true
    const waitTimeout = Math.min(30 * 60 * 1000, Math.max(1000, Number(input?.timeout_ms) || 5 * 60 * 1000))
    const deadline = Date.now() + waitTimeout
    while (wait && !shellJob.finished && Date.now() < deadline && !ctx.signal?.aborted) {
      await new Promise((r) => setTimeout(r, 200))
    }
    const out = shellJob.out.consume()
    const err = shellJob.err.consume()
    const dropped = out.dropped + err.dropped
    const text = renderShellText({
      stdout: out.text,
      stderr: err.text,
      exitCode: shellJob.finished ? shellJob.exitCode : undefined,
      signal: shellJob.signal,
    })
    const notes: string[] = []
    if (dropped > 0) notes.push(`（更早的输出已丢弃：${dropped} 字符；如需完整日志请让命令把输出写进文件）`)
    if (!shellJob.finished) notes.push(`[still running] 用 job_output(job_id="${shellJob.id}") 继续读取新增输出，job_kill 停止`)
    return {
      ok: true,
      value: {
        jobId: shellJob.id,
        kind: 'shell',
        status: shellJob.finished ? (shellJob.error ? 'error' : 'completed') : 'running',
        command: shellJob.command,
        cwd: shellJob.cwd,
        exitCode: shellJob.exitCode,
        signal: shellJob.signal,
        modelText: [text, ...notes].join('\n'),
      },
    }
  }

  const job = jobRegistry.get(jobId)
  if (!job) return { ok: false, error: `未找到后台任务 ${jobId}（可能已完成并被清理，或只属于其它会话）` }

  const wait = input?.wait === true
  const timeoutMs = Math.min(30 * 60 * 1000, Math.max(1000, Number(input?.timeout_ms) || 5 * 60 * 1000))
  const deadline = Date.now() + timeoutMs
  while (wait && job.status === 'running' && Date.now() < deadline) {
    if (ctx.signal?.aborted) break
    await new Promise((r) => setTimeout(r, 200))
    const fresh = jobRegistry.get(jobId)
    if (!fresh) return { ok: false, error: `后台任务 ${jobId} 已被清理` }
    Object.assign(job, fresh)
  }

  return {
    ok: true,
    value: {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      detail: job.detail,
      result: job.result,
      error: job.error,
      ...(job.status === 'running'
        ? { message: `任务仍在运行（${Math.round((Date.now() - job.createdAt) / 1000)}s）：稍后再用 job_output(job_id="${job.id}", wait=true) 收集结果。` }
        : {}),
    },
  }
}

/** job_kill：停止一个后台任务（子代理任务会同时取消其 agent 会话） */
async function jobKill(input: any, _ctx: ToolExecutionContext): Promise<ToolResult> {
  const jobId = String(input?.job_id ?? input?.jobId ?? '').trim()
  if (!jobId) return { ok: false, error: 'job_id 参数必填' }

  // 后台 shell：直接杀进程树（连同它拉起的子进程），输出仍可再读一次
  const shellJob = shellJobs.get(jobId)
  if (shellJob) {
    if (shellJob.finished) {
      return { ok: true, value: { jobId, kind: 'shell', status: 'completed', killed: false, message: '该命令已结束，无需停止。' } }
    }
    shellJob.run.killTree()
    jobRegistry.cancel(jobId, '已被 job_kill 停止')
    return {
      ok: true,
      value: {
        jobId,
        kind: 'shell',
        status: 'cancelled',
        killed: true,
        modelText: `[stopped: job_kill]\n已停止该 shell 任务（连同子进程）。可用 job_output 再读一次它退出前的输出。`,
      },
    }
  }

  const job = jobRegistry.get(jobId)
  if (!job) return { ok: false, error: `未找到后台任务 ${jobId}` }
  if (job.status !== 'running') return { ok: true, value: { jobId, status: job.status, killed: false, message: `任务已结束（${job.status}），无需停止` } }

  jobRegistry.cancel(jobId, '已被 job_kill 停止')
  const entry = subagentJobs.get(jobId)
  if (entry) {
    subagentJobs.delete(jobId)
    const child = getAgent(entry.childId)
    if (child) child.cancel('job-killed')
  }
  return { ok: true, value: { jobId, status: 'cancelled', killed: true, message: '已请求停止；它派生的下级子代理会继续运行到结束。' } }
}

/**
 * job_list —— 列出本会话的后台任务（对齐 DSH `tool-jobs` 的 list）。
 * 模型被打断后不必凭记忆找 jobId：先 list 再 output / kill。
 */
async function jobList(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const owner = String(ctx.agentId || ctx.sessionId || '')
  const kind = String(input?.kind ?? '').trim()
  const jobs = jobRegistry.list()
    .filter((job) => (!owner || job.owner === owner) && (!kind || job.kind === kind))
    .sort((a, b) => b.createdAt - a.createdAt)

  if (!jobs.length) {
    return { ok: true, value: { jobs: [], modelText: '（当前没有后台任务）' } }
  }
  const lines = jobs.map((job) => {
    const elapsed = Math.max(0, Math.round((Date.now() - job.createdAt) / 1000))
    const status = job.status === 'running' ? `running ${elapsed}s` : job.status
    return `- ${job.id}（${job.kind}）${status}：${job.title}`
  })
  return {
    ok: true,
    value: {
      jobs: jobs.map((job) => ({
        id: job.id,
        kind: job.kind,
        title: job.title,
        status: job.status,
        createdAt: job.createdAt,
        detail: job.detail,
        error: job.error,
      })),
      modelText: `后台任务（${jobs.length}）\n${lines.join('\n')}\n（用 job_output(job_id) 读输出 / 收结果，job_kill 停止）`,
    },
  }
}

/**
 * working_directory —— 切换本会话的工作目录（对齐 DSH 的 `working_directory`）。
 * 只允许切到工作区内；传空字符串重置回工作区根。切换后所有文件工具的相对路径都跟着走。
 */
async function workingDirectory(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const key = workingDirKey(ctx)
  if (!key) return { ok: false, code: 'INVALID_ARGS', error: '当前不在 agent 会话内，无法切换工作目录' }
  const root = String((ctx as any).workspaceRoot || ctx.cwd || '')
  const raw = String(input?.path ?? '').trim()

  if (!raw) {
    setWorkingDir(key, '')
    return {
      ok: true,
      value: { cwd: root, workspaceRoot: root, reset: true, modelText: `工作目录已重置为工作区根：${root}` },
    }
  }

  const base = cwdFor({ agentId: ctx.agentId, sessionId: ctx.sessionId, cwd: ctx.cwd }) || process.cwd()
  const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, raw))
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return { ok: false, code: 'FS_NOT_FOUND', error: `目录不存在：${abs}` }
  }
  if (!st.isDirectory()) return { ok: false, code: 'INVALID_ARGS', error: `不是目录：${abs}` }

  // 只允许在工作区内移动（否则等于让模型把写盘范围挪到工作区外）
  if (root) {
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
    const r = norm(root)
    const a = norm(abs)
    if (a !== r && !a.startsWith(r + path.sep)) {
      return { ok: false, code: 'INVALID_ARGS', error: `只能切到工作区内（${root}）：${abs}` }
    }
  }
  setWorkingDir(key, abs)
  return {
    ok: true,
    value: {
      cwd: abs,
      workspaceRoot: root,
      modelText: `当前工作目录：${abs}（后续文件工具的相对路径都相对它解析；传 path:"" 可重置）`,
    },
  }
}

/** 支持的图片格式（按文件头识别，不信扩展名） */
const READ_IMAGE_MAX_BYTES = 8 * 1024 * 1024

function sniffImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('latin1')
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/**
 * read_image —— 把本地图片作为图片内容交给模型（对齐 DSH 的 `read_image`）。
 * 只认 PNG / JPEG / WebP / GIF（按魔数），单张上限 8MB；模型不支持图片输入时会由接口报错。
 */
async function readImage(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const rawPath = String(input?.path ?? '')
  const abs = resolveWithinCwd(rawPath, ctx)
  if (!abs) return { ok: false, code: 'INVALID_ARGS', error: '路径越界或缺失（path 参数必填）' }
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return { ok: false, code: 'FS_NOT_FOUND', error: `文件不存在：${rawPath}` }
  }
  if (!st.isFile()) return { ok: false, code: 'INVALID_ARGS', error: `不是文件：${rawPath}` }
  if (st.size > READ_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      code: 'FS_TOO_LARGE',
      error: `图片过大（${Math.round(st.size / 1024)} KB，上限 ${READ_IMAGE_MAX_BYTES / 1024 / 1024} MB）：请先压缩 / 裁剪后再读。`,
    }
  }
  const buf = fs.readFileSync(abs)
  const mime = sniffImageMime(buf)
  if (!mime) {
    return {
      ok: false,
      code: 'FS_NOT_TEXT',
      error: `不是受支持的图片（只认 PNG / JPEG / WebP / GIF，按文件头判断）：${rawPath}`,
    }
  }
  return {
    ok: true,
    value: {
      path: rawPath,
      mime,
      bytes: st.size,
      modelText: `图片：${rawPath}（${mime}，${Math.round(st.size / 1024)} KB）`,
    },
    images: [{ mime, data: buf.toString('base64') }],
  }
}

// ---------------------------------------------------------------------------
// Word 导出接缝（export_word）
//
// 渲染 / MathJax / mermaid / canvas 能力只在渲染进程具备，故主进程只负责
// 「取内容 + 定位置 + 路径围栏」，实际导出经 requestRendererTask 交由渲染层执行
// 并复用 md-to-docx / docx.ts 同一套代码（效果与手动导出完全一致）。
// ---------------------------------------------------------------------------

/** 单次导出的 Markdown 规模上限（3MB：防止超长内容撑爆 IPC 与导出管线） */
const EXPORT_WORD_MAX_BYTES = 3 * 1024 * 1024

async function exportWord(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const agentId = ctx.agentId
  if (!agentId) return { ok: false, error: 'export_word 只能在智能体会话内使用' }

  const markdownArg = typeof input?.markdown === 'string' ? input.markdown : ''
  const pathArg = String(input?.path ?? '').trim()
  if (!markdownArg.trim() && !pathArg) {
    return { ok: false, error: '需要提供 markdown（Markdown 内容）或 path（.md 文件路径）之一' }
  }

  // 1. 内容来源：显式内容优先，否则读文件（走统一路径围栏）
  let markdown = markdownArg
  if (!markdown.trim()) {
    const abs = resolveWithinCwd(pathArg, ctx)
    if (!abs) return { ok: false, error: `路径越界或非法: ${pathArg}` }
    try {
      if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在: ${pathArg}` }
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) return { ok: false, error: `是目录而非文件: ${pathArg}` }
      if (stat.size > EXPORT_WORD_MAX_BYTES) {
        return { ok: false, error: `Markdown 文件过大（${Math.round(stat.size / 1024)}KB，上限 ${EXPORT_WORD_MAX_BYTES / 1024}KB），请拆分后再导出` }
      }
      markdown = fs.readFileSync(abs, 'utf-8')
    } catch (e: any) {
      return { ok: false, error: `读取 Markdown 失败: ${e?.message || String(e)}` }
    }
  }
  if (!markdown.trim()) return { ok: false, error: 'Markdown 内容为空' }
  if (Buffer.byteLength(markdown, 'utf8') > EXPORT_WORD_MAX_BYTES) {
    return { ok: false, error: `Markdown 内容过大（超过 ${EXPORT_WORD_MAX_BYTES / 1024}KB），请拆分后再导出` }
  }

  // 2. 保存位置：output_path 可以是 .docx 完整路径，也可以是目录（目录 → 拼 file_name）
  const rawName = String(input?.file_name ?? input?.fileName ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
  const fileName = rawName || '导出文档'
  let targetPath = String(input?.output_path ?? input?.outputPath ?? '').trim()
  if (targetPath) {
    try {
      const isDirPath = /[\\/]$/.test(targetPath)
      if (isDirPath || (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory())) {
        targetPath = path.join(targetPath, /\.docx$/i.test(fileName) ? fileName : `${fileName}.docx`)
      } else if (!/\.docx$/i.test(targetPath)) {
        // 既不是目录也缺扩展名：按 .docx 处理，避免写出无后缀文件
        targetPath = `${targetPath}.docx`
      }
    } catch { /* 路径不可判定时按原样交给写盘层 */ }
  } else {
    // 未指定位置：只给文件名，由主进程 exportDocx 落到系统下载目录
    targetPath = /\.docx$/i.test(fileName) ? fileName : `${fileName}.docx`
  }

  // 3. 交由渲染层执行（复用统一导出管线），结果原样返回给模型
  try {
    const res = await requestRendererTask(agentId, 'export_word', {
      markdown,
      targetPath,
      template: String(input?.template ?? '').trim(),
      overwrite: input?.overwrite === true,
    })
    return { ok: true, value: res && typeof res === 'object' ? res : { path: targetPath } }
  } catch (e: any) {
    return { ok: false, error: `Word 导出失败: ${e?.message || String(e)}` }
  }
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

/** 注册全部核心工具（应用启动时调用一次；幂等） */
// ============ 浏览器 Agent 工具（M0/M1：进程内 MCP server 同名内核工具，通用智能体可直接调用） ============
/** 浏览器工具默认超时（导航单独放宽）：页面挂起/弹窗阻塞时给模型可读的失败，而不是永久卡住 step */
const BROWSER_TOOL_TIMEOUT_MS = 30_000
const BROWSER_NAV_TIMEOUT_MS = 45_000

const runBrowserAgentTool = (tool: string) => async (args: any, ctx: ToolExecutionContext): Promise<ToolResult> => {
  const input = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
  // 把调用方 agent 会话 id（agentId/sessionId）传给浏览器服务 → 工具只作用于该会话自己的标签，
  // 新建的 AI 标签带属主，会话 idle/dispose 时主进程可精确回收。
  const owner = (ctx?.sessionId || ctx?.agentId) ? String(ctx?.sessionId || ctx?.agentId) : undefined
  const timeoutMs = tool === 'browser_navigate'
    ? BROWSER_NAV_TIMEOUT_MS
    : tool === 'browser_run'
      ? 90_000
      : tool === 'browser_download_wait'
        ? 130_000
        : BROWSER_TOOL_TIMEOUT_MS
  // 超时/用户停止都汇总成一个 AbortController：让浏览器服务停掉加载，且排队中的调用一开始就失败。
  const ctrl = new AbortController()
  let abortedBy: 'timeout' | 'user' | null = null
  const abort = (by: 'timeout' | 'user') => {
    if (ctrl.signal.aborted) return
    abortedBy = by
    ctrl.abort()
    try { browserAgentService.stopOwner(owner) } catch { /* 忽略 */ }
  }
  const onUserAbort = () => abort('user')
  if (ctx?.signal) {
    if (ctx.signal.aborted) onUserAbort()
    else ctx.signal.addEventListener('abort', onUserAbort, { once: true })
  }
  const timer = setTimeout(() => abort('timeout'), timeoutMs)
  try {
    const result = await browserAgentService.executeTool(tool, input, { owner, signal: ctrl.signal })
    return { ok: true, value: result.text, images: result.images }
  } catch (err: any) {
    const raw = err?.message || String(err)
    if (abortedBy === 'timeout') {
      return {
        ok: false,
        error: `浏览器工具 ${tool} 超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已中止（页面可能加载挂起、弹出了 alert/confirm，或目标元素一直不出现）。可稍后重试、换用 browser_extract_text 检查页面状态，或让用户先处理页面弹窗。`,
      }
    }
    if (abortedBy === 'user') return { ok: false, error: '浏览器操作已被用户停止' }
    return { ok: false, error: raw }
  } finally {
    clearTimeout(timer)
    try { ctx?.signal?.removeEventListener('abort', onUserAbort) } catch { /* 忽略 */ }
  }
}

export function registerCoreTools(): void {
  // ============ 浏览器 Agent 工具（进程内 MCP server 同名内核工具；单一 schema 来源 = browserAgentService.toolDefinitions()） ============
  for (const def of browserAgentService.toolDefinitions()) {
    toolRegistry.register(
      defineTool(def.name, def.description, runBrowserAgentTool(def.name), {
        inputSchema: def.inputSchema,
      }),
    )
  }
  toolRegistry.register(
    defineTool('read_file', '读取文本文件，返回**带行号**的内容（PDF / Word / Excel 自动提取文本）。offset / limit 单位都是**行**（默认一次 2000 行、约 50KB）；末尾写「本次第 a-b 行 / 共 T 行」，没读完就用 offset=下一行 续读，直到「已读到文件末尾」。单行超 2000 字符会截断；offset 越界直接报错。传 skill 时按技能目录解析。', readFile, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径可访问任意文件；相对路径基于当前工作目录，传 skill 时基于技能目录）' },
          skill: { type: 'string', description: '可选。技能名（kebab-case，容错匹配）：path 按该技能目录解析，用于读取技能自带资源' },
          offset: { type: 'integer', description: '可选。起始行号（1-based，默认 1）；续读时填结果末尾提示里的 offset' },
          limit: { type: 'integer', description: '可选。本次最多返回多少行（默认 2000，上限 2000）' },
          force: { type: 'boolean', description: '可选。同一轮内重复读同一窗口会返回"内容未变化"；确实要重看原文时传 true' },
        },
        required: ['path'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('read_image', '读取本地图片并作为图片内容交给模型（PNG / JPEG / WebP / GIF，按文件头识别，单张上限 8MB）。仅当模型支持图片输入时使用；不要用它读文本或 PDF（用 read_file）。', readImage, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片路径（绝对路径或相对当前工作目录）' },
        },
        required: ['path'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('write_file', '写入文件（UTF-8，自动创建父目录）。覆盖已存在文件前必须先用 read_file 读过（先读后写）；只改局部优先用 replace_in_file。单次建议 ≤20000 字符、硬上限 1 MiB，更大的分段写；写盘后按字节复核，失败会回滚。', writeFile, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径或相对工作区根）' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('replace_in_file', '把文件里一段唯一原文替换为新内容（其余部分不变）。old_string 必须从 read_file 读到的原文里原样复制（含缩进）；默认要求全文唯一，命中多处会报行号，可传 occurrence 指定第几处或 replace_all 全部替换。new_string 传空串表示删除；与 old_string 相同会被拒绝。落盘前比对版本，读取后被改过就放弃。', replaceInFile, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径或相对工作区根）' },
          old_string: { type: 'string', description: '要被替换的精确原文段（含足够上下文，默认要求全文唯一）' },
          new_string: { type: 'string', description: '替换后的新内容；传空字符串表示删除该段' },
          occurrence: { type: 'integer', description: '可选。old_string 出现多处时指定替换第几处（从 1 起）；不传则要求唯一' },
          replace_all: { type: 'boolean', description: '可选。true = 替换 old_string 的全部出现（结果里的 applied 是实际替换处数）' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('multi_replace', '批量替换（可跨文件）：所有条目全部命中才落盘，任一条未命中 / 不唯一则整批不生效（两阶段提交，失败会回滚）。每条 old_string 同样要原样复制；默认唯一，可传 occurrence 或 replace_all。同一文件的替换区间不能重叠；单处替换用 replace_in_file。', multiReplace, {
      inputSchema: {
        type: 'object',
        properties: {
          replacements: {
            type: 'array',
            description: '要执行的替换列表（按命中位置应用，与条目顺序无关）',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '文件路径（绝对路径或相对工作区根；省略时用顶层 path）' },
                old_string: { type: 'string', description: '要被替换的精确原文段（默认要求在该文件中唯一）' },
                new_string: { type: 'string', description: '替换后的新内容；传空字符串表示删除该段' },
                occurrence: { type: 'integer', description: '可选。old_string 命中多处时只替换第几处（从 1 起）' },
                replace_all: { type: 'boolean', description: '可选。true = 该条把 old_string 的全部出现都替换掉' },
              },
              required: ['old_string', 'new_string'],
            },
          },
          path: { type: 'string', description: '可选。所有条目的默认文件路径（条目自带 path 时以条目为准）' },
        },
        required: ['replacements'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('working_directory', '切换本会话的工作目录（之后 read_file / write_file / search_files / shell 等的相对路径都相对它解析）。只能切到工作区内；传 path:"" 重置回工作区根。命令内部的 cd 不会保留，需要换目录就用它或 workdir 参数。', workingDirectory, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标目录（相对当前工作目录或绝对路径；传空字符串 = 重置回工作区根）' },
        },
      },
    }),
  )
  toolRegistry.register(
    defineTool('list_dir', '列出目录条目（名称与类型）。可用绝对路径查看任意目录（如 D:\\），相对路径基于当前工作目录；传 skill 时改为列出该技能目录。', listDir, {
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径（绝对路径可访问任意位置；相对路径基于当前工作目录，传 skill 时基于技能目录；默认 .）' },
          skill: { type: 'string', description: '可选。技能名（kebab-case，容错匹配）：改为列出该技能目录（path 相对该目录解析）' },
        },
      },
    }),
  )
  toolRegistry.register(
    defineTool('search_files', SEARCH_FILES_DESCRIPTION, searchFiles, {
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词；regex=true 时按正则解释' },
          root: { type: 'string', description: '可选，搜索根目录（绝对路径或相对工作区根；缺省用工作区根）' },
          skill: { type: 'string', description: '可选。技能名（kebab-case，容错匹配）：在该技能目录内搜索（优先于 root）' },
          filePattern: { type: 'string', description: '可选，文件过滤：".ts" / "*.ts" / "src/**/*.vue"，逗号分隔多个' },
          regex: { type: 'boolean', description: '可选，query 是否按正则解释（默认 false = 字面量包含）' },
          ignoreCase: { type: 'boolean', description: '可选，是否忽略大小写（默认 false = 大小写敏感，与 grep / rg 一致）' },
          contextLines: { type: 'number', description: '可选，命中行前后各返回几行上下文（0~5，默认 0）' },
          maxResults: { type: 'number', description: '可选，内联展示的最大命中数（默认 30，上限 500）；超出的完整列表会另存为临时文件' },
          includeHidden: { type: 'boolean', description: '可选，是否搜索隐藏目录/文件（默认 false）' },
          respectGitignore: { type: 'boolean', description: '可选，是否遵守根目录 .gitignore（默认 true）' },
          maxFileSizeMB: { type: 'number', description: '可选，单文件大小上限 MB（默认 2）' },
        },
        required: ['query'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('glob', '按**路径 / 文件名**查找文件（不是内容搜索；找文件内容用 search_files）。pattern 用 glob 语法：`*.yml` 找任意目录下的 yml 文件，`src/**/*.vue` 限定在 src 下，`**/*` 列出全部文件；不含 `/` 的模式匹配任意深度。结果**按修改时间倒序**（最近改的在前），默认最多 100 条；默认排除 node_modules / .git 等目录并遵守工作区 .gitignore。传 skill 时在该技能目录内查找。返回的路径相对搜索根。', globFiles, {
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 "*.md" / "src/**/*.ts" / "**/*"（必填）' },
          root: { type: 'string', description: '可选，查找根目录（绝对路径或相对工作区根；缺省用工作区根）' },
          skill: { type: 'string', description: '可选。技能名：在该技能目录内查找（优先于 root）' },
          maxResults: { type: 'number', description: '可选，最多返回多少个（默认 100，上限 1000）' },
          includeHidden: { type: 'boolean', description: '可选，是否包含隐藏目录/文件（默认 false）' },
          respectGitignore: { type: 'boolean', description: '可选，是否遵守根目录 .gitignore（默认 true）' },
        },
        required: ['pattern'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('run_python', '执行 Python 代码。沙箱档位由用户在「设置 → 通用 → 其他 → 安全策略」统一决定（只读安全 / 工作区写入 / 完全访问），工具本身没有 sandbox 参数；档位不够时报错会说明当前档位与去哪切换。第三方库（pandas / openpyxl / scipy 等）在工作区写入与完全访问下均可正常导入，只有 os / subprocess / socket 这类系统级模块在非完全访问档位被拦。', runPython, {
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 Python 代码' },
          input: { description: '作为 input 注入执行环境的输入' },
        },
        required: ['code'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('shell', '执行 shell 命令（默认只允许「完全访问」模式；被拒绝时可带 sandbox_permissions:"escalate" + justification 申请一次性放行）。每次都是新进程：换目录用 workdir，不依赖 `cd`。**非零退出不算失败**（输出带 `[exit code: N]`）。Windows 默认 cmd（可传 shell:"powershell"），macOS/Linux 默认 sh（可传 "bash"）。长命令用 run_in_background:true 拿 job id，再 job_output / job_kill；前台超时也会转后台。超时杀整棵进程树；输出过大只留尾部，完整内容在 `[output truncated; full output: <path>]` 给路径。', runShell, {
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '可选。一句话说明这条命令要做什么（5~10 个词），会显示在界面卡片上' },
          command: { type: 'string', description: '要执行的命令（Windows 默认 cmd 语法；macOS / Linux 默认 sh 语法）' },
          workdir: { type: 'string', description: '可选。工作目录（相对工作区根，或绝对路径）；缺省用当前工作区' },
          timeoutMs: { type: 'integer', description: `可选。前台等待的毫秒数（默认 ${SHELL_DEFAULT_TIMEOUT_MS}，上限 ${SHELL_MAX_TIMEOUT_MS}）；超时后会转成后台任务继续跑` },
          shell: { type: 'string', description: '可选。方言：Windows 可传 "cmd" / "powershell"；macOS / Linux 可传 "sh" / "bash"。缺省用平台默认' },
          run_in_background: { type: 'boolean', description: '可选。true = 立即返回 job id，用 job_output 读取输出、job_kill 停止（不设执行超时）' },
          sandbox_permissions: { type: 'string', description: '可选。仅当策略拒绝 shell 且你确实需要执行时传 "escalate"（配合 justification），用户确认后只放行这一条命令' },
          justification: { type: 'string', description: '可选。向用户说明为什么需要执行这条命令（用用户当前提问的语言写，一句话）' },
        },
        required: ['command'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('run_subagent', '派生子代理：一个独立的 agent 会话，在它自己的上下文里完成你交给它的子任务，你只拿到它的最终结果（看不到中间步骤），因此不会占用你的上下文。适合可独立完成、边界清晰的调研 / 实现 / 分析；彼此独立的子任务可以在同一条消息里发起多次调用。默认等待其完成后返回结果（run_in_background=true 则立即返回 jobId，用 job_output 收集、job_kill 停止；后台模式需已启用 job_output）。派单请写清：要它做什么、交付什么形态的结果、是只读调研还是可以改文件。子代理逐层继承你的工具白名单（默认不含 run_subagent；需要多层委派时在 tools 里显式列出），嵌套深度上限 3 层，超时会中止并返回已产出的部分输出。', runSubagent, {
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '3-5 个词的短标签，用于界面展示（如「调研 DSH 工具系统」）' },
          prompt: { type: 'string', description: '子任务的完整描述：它看不到你的对话上下文，必须自带全部必要信息（目标、约束、交付形态、涉及路径）' },
          member: { type: 'string', description: '可选。群成员名（AgentSwarm 群聊场景下以该成员的角色/模型/工具/知识库执行；无群成员名册时会报错）' },
          systemPrompt: { type: 'string', description: '可选。子代理系统提示词；缺省用通用子代理提示（member 时用成员设定）' },
          provider: { type: 'string', description: '可选。LLM provider；缺省继承调用方（member 时用成员的 provider）' },
          config: { type: 'object', description: '可选。provider 配置' },
          llmConfig: { type: 'object', description: '可选。通用 LLM 配置' },
          maxSteps: { type: 'number', description: '可选。子代理单轮最大 step 数（默认 10，上限 50）' },
          tools: { type: 'array', items: { type: 'string' }, description: '可选。子代理工具白名单；缺省继承调用方白名单（不含 run_subagent）' },
          run_in_background: { type: 'boolean', description: '可选。true = 后台运行并立即返回 jobId（默认 false：等待子代理完成后返回结果）' },
          timeout_ms: { type: 'number', description: '可选。子代理超时毫秒数（默认 600000，即 10 分钟；上限 1 小时）。超时会中止并返回已产出的部分输出' },
        },
        required: ['prompt'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('job_output', '收集后台任务（run_subagent run_in_background=true 启动的子代理）的状态与结果。默认立即返回当前状态；wait=true 时阻塞等待到任务结束（或超时）。任务结束前只能拿到状态，结束后 result 里是子代理的最终输出。', jobOutput, {
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'run_subagent 返回的 jobId' },
          wait: { type: 'boolean', description: '可选。true = 阻塞等待任务结束（默认 false，立即返回状态）' },
          timeout_ms: { type: 'number', description: '可选。wait=true 时最多等待多少毫秒（默认 300000，即 5 分钟）' },
        },
        required: ['job_id'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('job_kill', '停止一个后台任务（后台子代理）。调用后立即返回，不等待它真正停下；已产出的结果不再返回。', jobKill, {
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: '要停止的 jobId' } },
        required: ['job_id'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('job_list', '列出当前会话的后台任务（id / 类型 / 状态 / 标题）。被打断或记不住 jobId 时先用它查，再 job_output 读输出或 job_kill 停止。', jobList, {
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '可选。按类型过滤：shell / agent 等' },
        },
      },
    }),
  )
  toolRegistry.register(
    defineTool('kb_search', '从本地知识库文件（.kb）检索与查询相关的知识切片，返回切片内容。关联了多个知识库时会在全部库中检索（可用 kb 参数按文件名过滤）。', kbSearch, {
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索查询' },
          kbPath: { type: 'string', description: '单个知识库 .kb 文件的绝对路径（与 kbPaths 二选一）' },
          kbPaths: { type: 'array', items: { type: 'string' }, description: '多个知识库 .kb 文件的绝对路径' },
          kb: { type: 'string', description: '可选，按知识库文件名过滤' },
          topK: { type: 'number', description: '每个库返回切片数（默认 5）' },
        },
        required: ['query'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('skill', '加载一个已安装技能的完整指令（只调用一次）。返回的技能指令就是你接下来要执行的步骤：加载成功后请立即按指令行动（写代码用 run_python 执行），不要再调用 skill 重复加载。', loadSkill, {
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名（kebab-case）' } },
        required: ['name'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('export_word', '把 Markdown 导出为 Word 文档（.docx，可在 Word 中继续编辑；公式转为 Word 原生公式、mermaid 转为图片、标题/表格/列表样式随导出模板）。内容二选一：markdown（直接给内容）或 path（.md 文件路径）。output_path 可给完整 .docx 路径或目录（目录则用 file_name 命名，缺省“导出文档.docx”；都为空时存到系统下载目录）。template 可选 gongwen(公文)/cn(中文论文)/en(英文论文 APA)/custom(自定义模板)，缺省跟随设置页。', exportWord, {
      inputSchema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: 'Markdown 内容（与 path 二选一）' },
          path: { type: 'string', description: 'Markdown 文件路径（.md；与 markdown 二选一）' },
          output_path: { type: 'string', description: '可选，保存的 .docx 完整路径或目标目录（为空则存到系统下载目录）' },
          file_name: { type: 'string', description: '可选，文件名（不含扩展名；output_path 为目录或为空时使用）' },
          template: { type: 'string', description: '可选，导出模板：gongwen/cn/en/custom（缺省跟随设置页）' },
          overwrite: { type: 'boolean', description: '可选，是否覆盖同名文件（默认 false，重名自动追加 (1)）' },
        },
      },
    }),
  )
  toolRegistry.register(
    defineTool('exit_plan_mode', '把已完成的计划提交给用户评审（Approve / 继续完善）。改动大、不可逆、或方向需要用户拍板的任务，先用 update_plan 画出计划，再用本工具请求批准；用户批准后才开始动手。计划要用 Markdown 从标题开始书写、步骤各占一行。若用户选择「继续完善」，工具会失败并带回反馈，请据此修订后重新提交。', exitPlanMode, {
      inputSchema: {
        type: 'object',
        properties: { plan: { type: 'string', description: '完整计划文本（Markdown，建议从标题开始；通常与 update_plan 提交的一致）' } },
        required: ['plan'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('ask_user', '向用户提问并等待回答（用户回答会作为工具结果返回）。需要确认、做选择、或缺少关键信息时使用；能从工作区推断的不要问。一次可问多题：每题给 options 就是选择题（multi_select=true 可多选），不给 options 就是自由填写；每题都允许用户补充自定义回答，用户也可以跳过某题（该题返回空 selected 且无 custom）。选择题请把推荐项放第一位并在 label 末尾加 "(Recommended)"。用面向用户的说法，不要提内部名称或背景工作。', askUser, {
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '旧式单问：一个自由填写的问题文本（与 questions 二选一）' },
          questions: {
            type: 'array',
            description: '要问用户的问题清单（按顺序展示；最多 8 题）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: '本题的稳定 id（同一批内唯一，回答按它回填）' },
                question: { type: 'string', description: '具体要问的问题' },
                header: { type: 'string', description: '可选短标题，如「确认」「选择模式」' },
                options: {
                  type: 'array',
                  description: '可选选项；不给出就是自由填写题（推荐项放第一位并加 "(Recommended)"）',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      label: { type: 'string', description: '面向用户的简短选项标签' },
                      description: { type: 'string', description: '可选，一句话说明取舍或影响' },
                    },
                    required: ['label'],
                  },
                },
                multi_select: { type: 'boolean', description: '是否允许选择多个选项（默认 false = 单选）' },
              },
              required: ['id', 'question'],
            },
          },
        },
      },
    }),
  )
  toolRegistry.register(
    defineTool('update_plan', '为当前任务制定/更新执行计划（Markdown，会展示给用户）。步骤各占一行、每步一句话；新的信息推翻原计划时就更新它，任务完成或计划作废时传空字符串清除。计划只是给人看的摘要，正文与长内容请写进工作区文件。', updatePlan, {
      inputSchema: {
        type: 'object',
        properties: { plan: { type: 'string', description: '完整计划文本（Markdown；传空字符串清除计划）' } },
        required: ['plan'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('update_todo', '记录并更新任务清单，用于规划多步工作并展示进度（单步的琐碎任务不必使用）。开工前先为每个具体步骤建一项；工作进行中让正在做的那一项保持 running（同一时刻最多一项）；每完成一步立即置为 done，做不了就置为 cancelled。每次调用必须传入**完整清单**（整表替换，未列出的项会被移除），全部完成后传空数组清除。', updateTodo, {
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整任务清单（整表替换；清空传 []）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: { type: 'string', description: '任务内容 —— 一句简短的祈使句（同一清单内不可重复）' },
                status: {
                  type: 'string',
                  enum: ['pending', 'running', 'done', 'cancelled'],
                  description: 'pending（未开始）| running（进行中，同一时刻最多一项）| done（已完成）| cancelled（已放弃、不再做）',
                },
                detail: { type: 'string', description: '可选。细节或验收标准（展示用，不影响状态机）' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    }),
  )
    toolRegistry.register(
      defineTool('mcp_call', '通过 MCP 服务调用外部工具或控制装备。需要指定 tool 和 args；若 Agent 预设已配置 MCP 服务，可省略 serverId。', mcpCall, {
        inputSchema: {
          type: 'object',
          properties: {
            serverId: { type: 'string', description: 'MCP 服务 ID（可选，预设已配置时可省略）' },
            tool: { type: 'string', description: '要调用的 MCP 工具名' },
            args: { type: 'object', description: '工具参数（JSON 对象）' },
            config: { type: 'object', description: '可选，MCP 服务配置；缺省使用预设/上下文携带的配置' },
          },
          required: ['tool'],
        },
      }),
    )

  // PTC（Code Mode）：程序化工具调用。模型不逐个调用工具，而是写一段 TS 程序用 ctx SDK 组合多步操作。
  toolRegistry.register(
    defineTool('run_code', RUN_CODE_DESCRIPTION, runCodeHandler, {
      inputSchema: RUN_CODE_INPUT_SCHEMA,
    }),
  )

  toolRegistry.register(
    defineTool('web_search', '搜索互联网获取信息（返回标题/链接/摘要列表），搜索源可在设置页「工具 → 搜索」中配置。搜索后请挑选相关链接用 web_fetch 读取具体页面内容，仅凭摘要不足以完成任务。', webSearch, {
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词' } },
        required: ['query'],
      },
    }),
  )
  toolRegistry.register(
    defineTool('web_fetch', '获取网页完整内容（自动过滤 HTML 标签）。按设置页「工具 → 抓取」中开启的通道（直接访问 / DeepSeek Fetch / 虚拟浏览器）依次尝试并自动回退。用于 web_search 之后深入阅读具体页面并提取信息。', webFetch, {
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的网页 URL' } },
        required: ['url'],
      },
    }),
  )

  // 每个工具的单次 deadline（注册表执行器统一套 AbortController + 超时结果）。
  // ask_user / exit_plan_mode 不设：它们本来就要等用户，不能按时间判失败。
  const CORE_TOOL_TIMEOUTS: Record<string, number> = {
    read_file: 60_000,
    write_file: 60_000,
    replace_in_file: 60_000,
    multi_replace: 120_000,
    list_dir: 30_000,
    search_files: 90_000,
    run_python: 300_000,
    shell: 130_000,
    run_subagent: 3_900_000,
    job_output: 360_000,
    job_kill: 30_000,
    kb_search: 60_000,
    skill: 30_000,
    export_word: 120_000,
    update_plan: 15_000,
    update_todo: 15_000,
    mcp_call: 120_000,
    run_code: 300_000,
    web_search: 90_000,
    web_fetch: 90_000,
  }
  for (const [name, ms] of Object.entries(CORE_TOOL_TIMEOUTS)) {
    const def = toolRegistry.get(name)
    if (def && def.timeoutMs === undefined) def.timeoutMs = ms
  }
  // 浏览器工具自己有导航 / 动作超时；这里再加一层上限，避免某个动作把 turn 卡死
  for (const def of toolRegistry.list()) {
    if (String(def.name).startsWith('browser_') && def.timeoutMs === undefined) def.timeoutMs = 90_000
  }

  // Agent Teams 协议工具（群聊 = Agent Teams）：主进程只转发，语义在渲染层
  registerTeamTools()

  logInfo('tools', `${toolRegistry.snapshot().length} core tools registered`)
}
