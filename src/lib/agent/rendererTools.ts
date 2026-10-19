/**
 * rendererTools.ts — 渲染层智能体的工具集（无宿主环境：安卓壳 / 网页）
 *
 * 定位：桌面版的工具在主进程（`electron/main/tools.ts`，可执行 Python / shell / MCP / 插件工具）。
 * 安卓壳与网页没有主进程，智能体循环改在渲染层跑（见 `src/platform/rendererAgent.ts`），
 * 因此这里提供「渲染层能自持」的那部分工具实现：
 *
 * | 工具 | 实现方式 |
 * | --- | --- |
 * | `list_dir` / `read_file` / `search_files` | 平台文件端口（安卓 = SAF 授权目录 / 应用私有目录） |
 * | `write_file` / `replace_in_file` / `multi_replace` | 同上（真写进手机目录） |
 * | `kb_search` | 渲染层检索（`shared/kbRetrieval`，与主页问答同一套） |
 * | `web_fetch` / `web_search` | 渲染层 `fetch`（受浏览器同源策略约束，失败时给出可操作提示） |
 * | `ask_user` / `update_plan` / `update_todo` | 纯界面状态 |
 *
 * 语义尽量对齐主进程实现（返回形状、唯一性校验、原子多替换、差异预览、截断续读），
 * 但**不追求逐字一致**：凡是宿主独有的能力（跑代码 / shell / 子代理 / MCP / 技能 / 插件工具）
 * 一律不在本层暴露，被点名调用时明确报「当前环境不支持」，而不是静默失败。
 */

import { getPlatform } from '@/platform'
import { computeEditDiff, makeEditDiffPreview, countTextLines, type EditDiffFilePreview } from '@/shared/editDiff'
import { parseTodoList } from '@/shared/agentTodo'
import { parseAskQuestions, askAnswersToModel, askAnswersText } from '@/shared/agentAsk'
import { planReviewMessage, type PlanReviewOutcome } from '@/shared/agentPlanReview'
import { enabledWebFetchChannels, normalizeWebFetchConfig, webFetchChannelMeta } from '@/shared/webFetch'
import { isBotChallengePage } from '@/shared/webFetchHelpers'
import { runDeepSeekFetchApi } from '@/shared/deepseekApi'
import type { TodoItem, AskUserAnswer, AskUserQuestion } from '@/types/agent'

export interface RendererToolResult {
  ok: boolean
  value?: any
  error?: string
  /** UI 专用差异预览（不进模型上下文） */
  preview?: any
}

export interface RendererToolContext {
  /** 工作区根（安卓 = `saf:知识库` 这类平台路径） */
  cwd?: string
  kbPaths?: string[]
  kbTopK?: number
  retrieval?: any
  signal?: AbortSignal
  /** ask_user：向用户提问并等待结构化回答（由 agent 循环实现） */
  askUser: (questions: AskUserQuestion[]) => Promise<AskUserAnswer[]>
  /** exit_plan_mode：提交计划请用户评审（由 agent 循环实现） */
  reviewPlan: (plan: string) => Promise<PlanReviewOutcome>
  setPlan: (plan: string | null) => void
  setTodos: (todos: TodoItem[]) => void
  getTodos: () => TodoItem[]
}

// ---------------------------------------------------------------------------
// 工具清单与 schema
// ---------------------------------------------------------------------------

/** 渲染层能执行的工具（其余一律不暴露给模型） */
export const RENDERER_TOOL_NAMES = [
  'read_file', 'write_file', 'replace_in_file', 'multi_replace',
  'list_dir', 'search_files', 'kb_search',
  'web_fetch', 'web_search',
  'ask_user', 'update_plan', 'update_todo', 'exit_plan_mode',
] as const

export type RendererToolName = (typeof RENDERER_TOOL_NAMES)[number]

const SUPPORTED = new Set<string>(RENDERER_TOOL_NAMES)

/** 该工具在渲染层是否可执行 */
export function isRendererTool(name: string): boolean {
  return SUPPORTED.has(String(name || ''))
}

/** 宿主独有能力（点名调用时给出比「未知工具」更有用的说明） */
const HOST_ONLY_HINTS: Record<string, string> = {
  run_python: '执行 Python 需要桌面端（手机 / 网页没有本地运行时）',
  shell: '执行 shell 命令需要桌面端',
  run_subagent: '派生子代理需要桌面端',
  job_output: '后台任务（子代理）需要桌面端',
  job_kill: '后台任务（子代理）需要桌面端',
  mcp_call: 'MCP 调用需要桌面端或主机',
  skill: '技能库需要桌面端（技能在文件系统里，手机端请改用 read_file 直接读技能目录）',
  run_code: '代码模式（PTC）需要桌面端的工具注册表',
}

/** 未支持工具的说明（供循环回给模型，指导它换写法） */
export function hostOnlyToolError(name: string): string {
  const hint = HOST_ONLY_HINTS[String(name || '')]
  return hint
    ? `工具 ${name} 在当前环境（手机 / 网页）不可用：${hint}。请改用可用工具（read_file / write_file / replace_in_file / list_dir / search_files / kb_search / web_fetch / web_search / ask_user / update_plan / update_todo）完成任务。`
    : `工具 ${name} 在当前环境（手机 / 网页）不可用，请改用可用工具完成任务。`
}

function fn(name: string, description: string, properties: Record<string, any>, required: string[] = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    },
  }
}

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })

/** 工具 schema（与主进程同名工具的 schema 对齐，参数含义一致） */
const SCHEMAS: Record<string, any> = {
  read_file: fn('read_file', '读取文件内容（UTF-8 文本；PDF 自动抽取文字）。单次返回有上限，超出时返回 truncated=true 与 nextOffset，把 nextOffset 作为 offset 再调用一次即可续读。', {
    path: str('文件路径（工作区内的相对路径；也接受安卓授权目录的 saf: 路径）'),
    offset: num('起始字符偏移（续读时传上次的 nextOffset）'),
    limit: num('单次读取的最大字符数（默认 40000，上限 102400）'),
  }, ['path']),
  write_file: fn('write_file', '写入文件（UTF-8，自动创建父目录）。已存在则整体覆盖；只改一小段请优先用 replace_in_file。', {
    path: str('文件路径'),
    content: str('完整文件内容'),
  }, ['path', 'content']),
  replace_in_file: fn('replace_in_file', '在文件中定位一段唯一原文并替换（其余部分不变）。old_string 必须与文件内容精确一致（建议 ≥3 行）；出现多处会报错，可用 occurrence 指定第几处。new_string 传空字符串表示删除。', {
    path: str('文件路径'),
    old_string: str('要替换的原文（须与文件内容精确一致）'),
    new_string: str('替换后的新内容（空字符串 = 删除）'),
    occurrence: num('第几处命中（默认要求全文唯一）'),
  }, ['path', 'old_string', 'new_string']),
  multi_replace: fn('multi_replace', '在一次调用中批量替换多处（可跨文件），全部命中才整体落盘（原子）。任一未命中或不唯一则整批不生效。', {
    path: str('当所有 edits 都在同一文件时的文件路径（可与 edits[].path 混用）'),
    edits: {
      type: 'array',
      description: '替换条目列表',
      items: {
        type: 'object',
        properties: {
          path: str('文件路径（同一批内有 path 时可省）'),
          old_string: str('要替换的原文'),
          new_string: str('替换后的新内容'),
          occurrence: num('第几处命中'),
        },
        required: ['old_string', 'new_string'],
      },
    },
  }, ['edits']),
  list_dir: fn('list_dir', '列出目录条目（名称与类型）。', {
    path: str('目录路径（省略 = 工作区根）'),
  }),
  search_files: fn('search_files', '按文本搜索文件内容，返回文件路径、行号与内容片段。', {
    query: str('要搜索的文本'),
    path: str('搜索起点（省略 = 工作区根）'),
    max_results: num('最多返回多少条（默认 50）'),
  }, ['query']),
  kb_search: fn('kb_search', '从本地知识库文件（.kb）检索与查询相关的知识切片。', {
    query: str('检索问题'),
    kb: str('按知识库文件名过滤（可选）'),
  }, ['query']),
  web_fetch: fn('web_fetch', '获取网页内容并转为纯文本（按「设置 → 工具 → 抓取」开启的通道依次回退；手机 / 网页端支持直接访问与 DeepSeek Fetch）。', {
    url: str('要抓取的网页地址（http/https）'),
  }, ['url']),
  web_search: fn('web_search', '搜索互联网，返回标题 / 链接 / 摘要列表。', {
    query: str('搜索关键词'),
  }, ['query']),
  ask_user: fn('ask_user', '向用户提问并等待回答（回答会作为工具结果返回）。需要确认、做选择、或缺少关键信息时使用。一次可问多题：每题给 options 就是选择题（multi_select=true 可多选），不给 options 就是自由填写；每题都允许用户补充自定义回答，也可跳过某题（返回空 selected 且无 custom）。推荐项放第一位并在 label 末尾加 "(Recommended)"。', {
    question: str('旧式单问：一个自由填写的问题文本（与 questions 二选一）'),
    questions: {
      type: 'array',
      description: '要问用户的问题清单（按顺序展示；最多 8 题）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: str('本题的稳定 id（同一批内唯一，回答按它回填）'),
          question: str('具体要问的问题'),
          header: str('可选短标题，如「确认」「选择模式」'),
          options: {
            type: 'array',
            description: '可选选项；不给出就是自由填写题',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: str('面向用户的简短选项标签'),
                description: str('可选，一句话说明取舍或影响'),
              },
              required: ['label'],
            },
          },
          multi_select: { type: 'boolean', description: '是否允许多选（默认 false = 单选）' },
        },
        required: ['id', 'question'],
      },
    },
  }),
  update_plan: fn('update_plan', '为当前任务制定/更新执行计划（Markdown，会展示给用户）。步骤各占一行、每步一句话；计划变化时更新它，任务完成或作废时传空字符串清除。计划只是给人看的摘要，长内容请写进文件。', {
    plan: str('完整计划文本（Markdown；传空字符串清除计划）'),
  }, ['plan']),
  update_todo: fn('update_todo', '记录并更新任务清单，用于规划多步工作并展示进度（单步琐碎任务不必使用）。开工前为每个具体步骤建一项；正在做的那一项保持 running（同一时刻最多一项）；每完成一步立即置为 done，做不了置为 cancelled。每次调用必须传入完整清单（整表替换，未列出的项会被移除），全部完成后传空数组清除。', {
    todos: {
      type: 'array',
      description: '完整任务清单（整表替换；清空传 []）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: str('任务内容 —— 一句简短的祈使句（同一清单内不可重复）'),
          status: { type: 'string', enum: ['pending', 'running', 'done', 'cancelled'], description: 'pending（未开始）| running（进行中，同一时刻最多一项）| done（已完成）| cancelled（已放弃）' },
          detail: str('可选。细节或验收标准（展示用）'),
        },
        required: ['content', 'status'],
      },
    },
  }, ['todos']),
  exit_plan_mode: fn('exit_plan_mode', '把已完成的计划提交给用户评审（Approve / 继续完善）。改动大、不可逆、或方向需要用户拍板的任务，先用 update_plan 画出计划，再用本工具请求批准；批准后才开始动手。用户选择「继续完善」时本工具会失败并带回反馈，请修订后重新提交。', {
    plan: str('完整计划文本（Markdown，建议从标题开始）'),
  }, ['plan']),
}

/** 按白名单取工具 schema（过滤掉本层不支持的，避免模型调用必然失败的工具） */
export function rendererToolSchemas(names: readonly string[] | null | undefined): any[] {
  const list = Array.isArray(names) ? names : Array.from(RENDERER_TOOL_NAMES)
  const out: any[] = []
  for (const name of list) {
    const schema = SCHEMAS[String(name)]
    if (schema) out.push(schema)
  }
  return out
}

// ---------------------------------------------------------------------------
// 路径工具（渲染层的路径是平台口径：saf:… / data:… / 工作区相对路径）
// ---------------------------------------------------------------------------

function normSlashes(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').trim()
}

/** 平台前缀路径（saf: / data:）不需要拼工作区 */
function isPrefixed(p: string): boolean {
  return /^(saf|data):/i.test(p)
}

function join(base: string, rel: string): string {
  const b = normSlashes(base).replace(/\/+$/, '')
  const r = normSlashes(rel).replace(/^\/+/, '')
  return b ? `${b}/${r}` : r
}

function dirOf(p: string): string {
  const s = normSlashes(p)
  const i = s.lastIndexOf('/')
  if (i > 0) return s.slice(0, i)
  // `saf:知识库/a.md` 这类没有更多斜杠时，父目录就是授权根本身
  const m = /^([a-z]+:[^/]*)$/i.exec(s)
  if (m) return s.slice(0, s.indexOf(':') + 1)
  return ''
}

function nameOf(p: string): string {
  return normSlashes(p).split('/').filter(Boolean).pop() || ''
}

/** 把模型给的路径解析为平台路径；不可用时返回错误说明 */
function resolvePath(raw: string, cwd?: string): { path: string } | { error: string } {
  const s = normSlashes(raw)
  if (!s) return { error: 'path 参数必填' }
  if (isPrefixed(s)) {
    if (s.split('/').includes('..')) return { error: '路径不能包含 ..' }
    return { path: s }
  }
  // Windows / POSIX 绝对路径在手机上没有意义（安卓没有可枚举的绝对路径，必须走 SAF 授权）
  if (/^[a-zA-Z]:\//.test(s) || s.startsWith('/')) {
    return { error: `当前环境不支持绝对路径（${raw}）：请改用工作区内的相对路径，或用「打开文件夹」授权的目录（saf:…）` }
  }
  if (s.split('/').includes('..')) return { error: '路径不能包含 ..' }
  if (!cwd) return { path: s }
  return { path: join(cwd, s) }
}

// ---------------------------------------------------------------------------
// 文件工具
// ---------------------------------------------------------------------------

const READ_DEFAULT_LIMIT = 40_000
const READ_MAX_LIMIT = 102_400
const EDIT_DIFF_MAX_CHARS = 400_000

function textOf(r: string): string | null {
  if (typeof r !== 'string') return null
  if (r.startsWith('Error reading file')) return null
  return r
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const fs = getPlatform().fs
    const raw = await fs.readText(path)
    return textOf(raw)
  } catch {
    return null
  }
}

/** PDF 抽文字（渲染层有 pdfjs；与插件 ctx.files 同一路径） */
async function readPdfText(path: string): Promise<string | null> {
  try {
    const fs = getPlatform().fs
    const bytes = await fs.readBinary(path)
    if (!bytes) return null
    const pdfjs: any = await import('pdfjs-dist')
    const { PDFJS_RUNTIME_OPTIONS } = await import('@/lib/pdfjs')
    const doc = await pdfjs.getDocument({ data: bytes.slice(), ...(PDFJS_RUNTIME_OPTIONS || {}) }).promise
    const pages: string[] = []
    for (let i = 1; i <= Math.min(doc.numPages, 200); i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push((content.items || []).map((it: any) => String(it?.str ?? '')).join(' '))
    }
    return pages.join('\n\n')
  } catch {
    return null
  }
}

/** 差异预览的原文快照：读不到（新建/过大/二进制）时给出对应说明 */
function oldTextForDiff(text: string | null, missing: boolean): string | 'too-large' | 'binary' {
  if (missing) return ''
  if (text === null) return 'binary'
  if (text.length > EDIT_DIFF_MAX_CHARS) return 'too-large'
  return text
}

async function toolReadFile(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const r = resolvePath(String(input?.path ?? ''), ctx.cwd)
  if ('error' in r) return { ok: false, error: r.error }
  const offset = Math.max(0, Math.floor(Number(input?.offset) || 0))
  const limit = Math.min(READ_MAX_LIMIT, Math.max(1000, Math.floor(Number(input?.limit) || READ_DEFAULT_LIMIT)))

  let text: string | null
  if (/\.pdf$/i.test(r.path)) text = await readPdfText(r.path)
  else if (/\.(docx|xlsx|xls|pptx)$/i.test(r.path)) {
    return { ok: false, error: '当前环境（手机 / 网页）暂不支持直接读取 Office 文档内容，请在应用里打开该文件查看' }
  } else text = await readTextOrNull(r.path)

  if (text === null) return { ok: false, error: `读取失败或文件不存在：${r.path}` }
  const slice = text.slice(offset, offset + limit)
  const nextOffset = offset + slice.length
  const truncated = nextOffset < text.length
  return {
    ok: true,
    value: {
      // 控制字段（路径 / 续读锚点）排在 content **之前**：超预算的 read_file 结果会被掐中段
      // （read_file 走 headOnly 只保开头，见 shared/toolResultBudget.ts），把 nextOffset
      // 放在尾部会在截断时丢失，模型就再也读不到后半篇。
      path: r.path,
      truncated,
      ...(truncated ? { nextOffset } : {}),
      content: slice,
      chars: text.length,
      lines: countTextLines(text),
    },
  }
}

async function toolWriteFile(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const r = resolvePath(String(input?.path ?? ''), ctx.cwd)
  if ('error' in r) return { ok: false, error: r.error }
  const content = String(input?.content ?? '')
  const before = await readTextOrNull(r.path)
  const missing = before === null
  try {
    const res = await getPlatform().fs.writeText(r.path, content)
    if (!res?.success) return { ok: false, error: `写入失败：${res?.error || '未知错误'}` }
  } catch (e: any) {
    return { ok: false, error: `写入失败：${e?.message || String(e)}` }
  }
  const prev = oldTextForDiff(before, missing)
  const shownPath = String(input?.path ?? r.path)
  const diff: EditDiffFilePreview = missing
    ? { path: shownPath, created: true, stats: { added: countTextLines(content), removed: 0 }, lines: [] }
    : typeof prev === 'string'
      ? { path: shownPath, ...computeEditDiff(prev, content) }
      : { path: shownPath, lines: [], skipped: prev }
  return {
    ok: true,
    value: { path: r.path, bytes: content.length, created: missing, stats: diff.stats },
    preview: makeEditDiffPreview([diff]),
  }
}

/** 收集 needle 在 hay 中的所有命中偏移（升序、不重叠） */
function collectOccurrences(hay: string, needle: string): number[] {
  const hits: number[] = []
  if (!needle) return hits
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i === -1) break
    hits.push(i)
    from = i + needle.length
  }
  return hits
}

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function toFileEol(s: string, eol: '\r\n' | '\n'): string {
  const lf = s.replace(/\r\n/g, '\n')
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

interface ReplaceEdit { path: string; oldString: string; newString: string; occurrence?: number }

interface PlannedEdit {
  path: string
  index: number
  replaced: string
  /** 该文件累积后的内容 */
  content: string
}

/** 定位全部待替换条目（任一失败即返回 error，调用方据此整体不落盘） */
function planEdits(
  edits: ReplaceEdit[],
  files: Map<string, string>,
): { plans: PlannedEdit[] } | { error: string } {
  const plans: PlannedEdit[] = []
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    const current = files.get(e.path)
    if (current === undefined) return { error: `第 ${i + 1} 条：读取失败或文件不存在：${e.path}` }
    const eol = detectEol(current)
    const oldEol = toFileEol(e.oldString, eol)
    const newEol = toFileEol(e.newString, eol)
    if (!oldEol) return { error: `第 ${i + 1} 条：old_string 不能为空` }
    const hits = collectOccurrences(current, oldEol)
    if (!hits.length) {
      return { error: `第 ${i + 1} 条：未找到 old_string 指定的原文（${e.path}）。请先用 read_file 读取该区域并原样复制，注意缩进与换行。` }
    }
    let index = 0
    if (typeof e.occurrence === 'number' && e.occurrence > 0) {
      if (e.occurrence > hits.length) {
        return { error: `第 ${i + 1} 条：occurrence=${e.occurrence} 超出命中数（共 ${hits.length} 处）` }
      }
      index = e.occurrence - 1
    } else if (hits.length > 1) {
      const lines = hits.map((h) => current.slice(0, h).split('\n').length).join('、')
      return { error: `第 ${i + 1} 条：old_string 在 ${e.path} 中命中 ${hits.length} 处（行 ${lines}），请补充上下文使其唯一，或传 occurrence 指定第几处` }
    }
    const at = hits[index]
    const content = current.slice(0, at) + newEol + current.slice(at + oldEol.length)
    files.set(e.path, content)
    plans.push({ path: e.path, index: i, replaced: e.oldString.slice(0, 60), content })
  }
  return { plans }
}

async function applyEdits(
  edits: ReplaceEdit[],
  ctx: RendererToolContext,
  label: string,
): Promise<RendererToolResult> {
  if (!edits.length) return { ok: false, error: '未提供任何替换条目' }
  const files = new Map<string, string>()
  const before = new Map<string, string>()
  for (const e of edits) {
    if (files.has(e.path)) continue
    const text = await readTextOrNull(e.path)
    if (text === null) return { ok: false, error: `${label}：读取失败或文件不存在：${e.path}` }
    files.set(e.path, text)
    before.set(e.path, text)
  }
  const planned = planEdits(edits, files)
  if ('error' in planned) return { ok: false, error: planned.error }

  // 全部命中才落盘（原子）：写失败时直接报错，不留「改了一半」的静默状态
  const written: string[] = []
  const previews: EditDiffFilePreview[] = []
  for (const [path, content] of files) {
    const res = await getPlatform().fs.writeText(path, content)
    if (!res?.success) {
      return { ok: false, error: `写入失败（${path}）：${res?.error || '未知错误'}${written.length ? `；已写入：${written.join('、')}` : ''}` }
    }
    written.push(path)
    const prev = before.get(path) ?? ''
    previews.push({ path, ...computeEditDiff(prev, content) })
  }
  return {
    ok: true,
    value: { edited: files.size, files: Array.from(files.keys()), replacements: edits.length },
    preview: makeEditDiffPreview(previews),
  }
}

async function toolReplaceInFile(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const r = resolvePath(String(input?.path ?? ''), ctx.cwd)
  if ('error' in r) return { ok: false, error: r.error }
  return await applyEdits([{
    path: r.path,
    oldString: String(input?.old_string ?? ''),
    newString: String(input?.new_string ?? ''),
    occurrence: typeof input?.occurrence === 'number' ? input.occurrence : undefined,
  }], ctx, 'replace_in_file')
}

async function toolMultiReplace(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const raw = Array.isArray(input?.edits) ? input.edits : []
  const fallbackPath = input?.path ? resolvePath(String(input.path), ctx.cwd) : null
  if (fallbackPath && 'error' in fallbackPath) return { ok: false, error: fallbackPath.error }
  const edits: ReplaceEdit[] = []
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] || {}
    const rawPath = String(e.path || (fallbackPath && 'path' in fallbackPath ? fallbackPath.path : ''))
    const r = resolvePath(rawPath, ctx.cwd)
    if ('error' in r) return { ok: false, error: `第 ${i + 1} 条：${r.error}` }
    edits.push({
      path: r.path,
      oldString: String(e.old_string ?? ''),
      newString: String(e.new_string ?? ''),
      occurrence: typeof e.occurrence === 'number' ? e.occurrence : undefined,
    })
  }
  return await applyEdits(edits, ctx, 'multi_replace')
}

async function toolListDir(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const target = input?.path ? resolvePath(String(input.path), ctx.cwd) : (ctx.cwd ? { path: ctx.cwd } : { path: '' })
  if ('error' in target) return { ok: false, error: target.error }
  try {
    const nodes = await getPlatform().fs.listTree(target.path, 2)
    const entries: Array<{ name: string; type: string; size?: number }> = []
    for (const node of nodes || []) {
      entries.push({ name: nameOf(node?.path) || String(node?.label || ''), type: node?.type === 'folder' ? 'dir' : 'file', size: node?.size })
    }
    return { ok: true, value: { path: target.path, count: entries.length, entries } }
  } catch (e: any) {
    return { ok: false, error: `读取目录失败：${e?.message || String(e)}` }
  }
}

async function toolSearchFiles(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const query = String(input?.query ?? '')
  if (!query.trim()) return { ok: false, error: 'query 参数必填' }
  const root = input?.path ? resolvePath(String(input.path), ctx.cwd) : (ctx.cwd ? { path: ctx.cwd } : { path: '' })
  if ('error' in root) return { ok: false, error: root.error }
  const maxResults = Math.min(200, Math.max(1, Math.floor(Number(input?.max_results) || 50)))
  const fs = getPlatform().fs
  const hits: Array<{ path: string; line: number; text: string }> = []
  const skip = /\.(png|jpe?g|gif|webp|ico|pdf|zip|rar|7z|exe|dll|mp[34]|wav|woff2?|ttf|docx|xlsx|pptx|db|sqlite|bin)$/i
  const walk = async (dir: string, depth: number) => {
    if (hits.length >= maxResults || depth > 6) return
    let nodes: any[] = []
    try {
      nodes = await fs.listTree(dir, 1)
    } catch {
      return
    }
    for (const node of nodes || []) {
      if (hits.length >= maxResults) return
      if (node?.type === 'folder') { await walk(node.path, depth + 1); continue }
      const name = nameOf(node?.path)
      if (skip.test(name)) continue
      const text = await readTextOrNull(node.path)
      if (!text) continue
      const lines = text.split(/\r\n|\r|\n/)
      for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
        if (lines[i].includes(query)) hits.push({ path: node.path, line: i + 1, text: lines[i].slice(0, 240) })
      }
    }
  }
  await walk(root.path, 0)
  return {
    ok: hits.length > 0,
    value: hits.length ? { query, count: hits.length, matches: hits } : undefined,
    error: hits.length ? undefined : `未找到包含「${query}」的文件内容`,
  }
}

// ---------------------------------------------------------------------------
// 知识库检索
// ---------------------------------------------------------------------------

async function toolKbSearch(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const query = String(input?.query ?? '')
  if (!query.trim()) return { ok: false, error: 'query 参数必填' }
  const wanted = String(input?.kb || '').trim().toLowerCase()
  const paths = (ctx.kbPaths || []).filter((p) => !wanted || nameOf(p).toLowerCase().includes(wanted))
  if (!paths.length) {
    return { ok: false, error: '当前会话没有关联知识库文件（.kb）：请在智能体预设里关联知识库后再试' }
  }
  const topK = Math.max(1, Math.floor(Number(ctx.kbTopK) || 5))
  const ret = ctx.retrieval || {}
  const { retrieveKnowledge, resolveStrategyId } = await import('@/shared/kbRetrieval')
  const blocks: any[] = []
  const failed: string[] = []
  for (const kbPath of paths) {
    try {
      const result: any = await retrieveKnowledge(query, kbPath, {
        topK,
        summaryWeight: 0.7,
        strategy: resolveStrategyId(ret.strategy),
        chatModel: ret.chatModel || '',
        llmType: ret.llmType,
        providerConfig: ret.providerConfig,
        embedFallbackType: ret.embedFallbackType,
        embedFallbackProviderConfig: ret.embedFallbackProviderConfig,
        embedFallbackModel: ret.embedFallbackModel,
        missingModelStrategy: 'fallback',
      })
      for (const b of result?.relevantBlocks || []) blocks.push(b)
      if (!result?.context && !(result?.relevantBlocks || []).length) failed.push(`${nameOf(kbPath)}（无命中）`)
    } catch (e: any) {
      failed.push(`${nameOf(kbPath)}：${e?.message || String(e)}`)
    }
  }
  if (!blocks.length) return { ok: false, error: `知识库检索无结果。${failed.length ? `明细：${failed.join('；')}` : ''}` }
  return {
    ok: true,
    value: {
      query,
      count: blocks.length,
      blocks: blocks.slice(0, topK * Math.max(1, paths.length)).map((b: any) => ({
        source: b?.source || b?.file || '',
        content: String(b?.content ?? b?.text ?? '').slice(0, 4000),
      })),
      ...(failed.length ? { warnings: failed } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// 联网（渲染层 fetch；受浏览器同源策略约束，失败时给出可操作提示）
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 浏览器网络错误的统一提示（跨域 / 无网络 / 被拦都会落到这里） */
function netErrorHint(e: any): string {
  const msg = String(e?.message || e)
  return /Failed to fetch|NetworkError|Load failed/i.test(msg)
    ? '请求被浏览器安全策略拦截或无网络（跨域限制）：手机端只能访问允许跨域的站点；如需抓取任意网页，请连桌面主机执行'
    : msg
}

/** 直接访问通道（渲染层）：HTTP 请求 + HTML 转文本 */
async function fetchDirectInRenderer(url: string): Promise<{ content: string; contentType: string }> {
  const res = await fetch(url, { headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = String(res.headers.get('content-type') || '')
  const body = await res.text()
  const content = contentType.includes('json') ? body : htmlToText(body)
  if (!content.trim()) throw new Error('页面内容为空')
  // 200 的验证页也是失败（否则会挡住后面的 DeepSeek Fetch 回退）
  if (isBotChallengePage(content)) throw new Error('目标站点需要人机验证（验证页）')
  return { content, contentType }
}

/**
 * web_fetch（渲染层）：按设置页「工具 → 抓取」的通道顺序依次尝试。
 *
 * 渲染层只有 direct / deepseek 两条 HTTP 通道，「虚拟浏览器」需要桌面端的隐藏 Chromium，
 * 因此在手机上它会明确报「仅桌面端可用」并继续下一个通道（配置里默认就带着它）。
 */
async function toolWebFetch(input: any): Promise<RendererToolResult> {
  const url = String(input?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url 参数必填且需为 http/https 地址' }

  // 抓取通道配置在渲染层存档里（设置 → 工具 → 抓取）；DeepSeek 的 Key 在这一步解析成明文
  let rawCfg: any = null
  try {
    const { usestore } = await import('@/store')
    const store: any = usestore()
    try {
      rawCfg = typeof store?.buildWebFetchPayload === 'function'
        ? await store.buildWebFetchPayload()
        : store?.webFetch
    } catch {
      // 凭据解析失败也照样用原始配置（至少 direct / browser 通道还能工作）
      rawCfg = store?.webFetch || null
    }
  } catch { /* 取不到配置时按默认通道处理 */ }

  const config = normalizeWebFetchConfig(rawCfg)
  const channels = enabledWebFetchChannels(config)
  const failures: string[] = []

  for (const channel of channels) {
    const label = webFetchChannelMeta(channel).label
    try {
      if (channel === 'direct') {
        const r = await fetchDirectInRenderer(url)
        return {
          ok: true,
          value: {
            url,
            via: 'direct',
            contentType: r.contentType,
            chars: r.content.length,
            content: r.content.slice(0, 40_000),
            truncated: r.content.length > 40_000,
          },
        }
      }
      if (channel === 'deepseek') {
        const ds: any = config.deepseek || {}
        const apiKey = String(ds.apiKey || '').trim()
        if (!apiKey) {
          throw new Error('未配置 DeepSeek API Key（可在「工具 → 抓取」填，或让对话使用 DeepSeek 以复用凭据）')
        }
        const page = await runDeepSeekFetchApi({ url, apiKey, apiHost: ds.apiHost })
        return {
          ok: true,
          value: {
            url,
            via: 'deepseek',
            contentType: 'text/markdown',
            chars: page.content.length,
            content: page.content.slice(0, 40_000),
            truncated: page.content.length > 40_000,
          },
        }
      }
      // browser
      throw new Error('虚拟浏览器抓取仅在桌面端可用')
    } catch (e: any) {
      failures.push(`${label}：${netErrorHint(e)}`)
    }
  }

  return { ok: false, error: `抓取失败 —— ${failures.join('；')}` }
}

async function toolWebSearch(input: any): Promise<RendererToolResult> {
  const query = String(input?.query ?? '').trim()
  if (!query) return { ok: false, error: 'query 参数必填' }
  // 搜索源配置在渲染层存档里（设置 → 工具 → 搜索）；DeepSeek 的 Key 在这一步解析成明文
  let cfg: any = null
  try {
    const { usestore } = await import('@/store')
    const store: any = usestore()
    try {
      cfg = typeof store?.buildWebSearchPayload === 'function'
        ? await store.buildWebSearchPayload()
        : store?.webSearch
    } catch {
      cfg = store?.webSearch || null
    }
  } catch { /* 取不到配置时按未配置处理 */ }
  try {
    const { runRendererWebSearch } = await import('@/lib/agent/webSearchRunner')
    const r = await runRendererWebSearch(query, cfg)
    return { ok: true, value: r }
  } catch (e: any) {
    return { ok: false, error: `搜索失败：${netErrorHint(e)}` }
  }
}

// ---------------------------------------------------------------------------
// 会话状态类工具
// ---------------------------------------------------------------------------

async function toolAskUser(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const parsed = parseAskQuestions(input)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const { questions, legacy } = parsed
  const answers = await ctx.askUser(questions)
  return {
    ok: true,
    value: {
      ...askAnswersToModel(questions, answers, legacy),
      summary: askAnswersText(questions, answers),
    },
  }
}

async function toolUpdatePlan(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const raw = input?.plan
  if (raw !== undefined && typeof raw !== 'string') {
    return { ok: false, error: 'plan 必须是字符串（Markdown 文本；传空字符串清除计划）' }
  }
  const plan = typeof raw === 'string' ? raw.trim() : ''
  if (plan.length > 20000) {
    return { ok: false, error: `计划过长（${plan.length} 字符，上限 20000）：计划只列步骤与关键约束，细节请写进文件` }
  }
  ctx.setPlan(plan || null)
  const steps = plan ? plan.split('\n').filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length : 0
  return plan
    ? { ok: true, value: { plan, cleared: false, chars: plan.length, steps, message: `执行计划已更新（${plan.length} 字符${steps ? `，约 ${steps} 个步骤` : ''}），已展示给用户。` } }
    : { ok: true, value: { plan: null, cleared: true, message: '执行计划已清除。' } }
}

async function toolUpdateTodo(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const parsed = parseTodoList(input?.todos, ctx.getTodos())
  if (!parsed.ok) return { ok: false, error: parsed.error }
  ctx.setTodos(parsed.todos)
  return { ok: true, value: { todos: parsed.todos, counts: parsed.counts, cleared: parsed.cleared, message: parsed.message } }
}

async function toolExitPlanMode(input: any, ctx: RendererToolContext): Promise<RendererToolResult> {
  const plan = String(input?.plan ?? '').trim()
  if (!plan) return { ok: false, error: 'plan 参数必填：请提交完整计划（Markdown，从标题开始书写）供用户评审' }
  if (plan.length > 20000) {
    return { ok: false, error: `计划过长（${plan.length} 字符，上限 20000）：评审的是步骤与关键决策，细节请写进文件` }
  }
  // 评审的计划同时成为"当前计划"（界面与后续步骤都看这一份）
  ctx.setPlan(plan)
  const outcome = await ctx.reviewPlan(plan)
  const verdict = planReviewMessage(outcome)
  return verdict.ok ? { ok: true, value: { approved: true, plan, message: verdict.text } } : { ok: false, error: verdict.text }
}

// ---------------------------------------------------------------------------
// 执行入口
// ---------------------------------------------------------------------------

/** 执行一个工具（未支持的工具返回明确错误，不抛异常） */
export async function executeRendererTool(
  name: string,
  input: any,
  ctx: RendererToolContext,
): Promise<RendererToolResult> {
  if (!isRendererTool(name)) return { ok: false, error: hostOnlyToolError(name) }
  try {
    switch (name) {
      case 'read_file': return await toolReadFile(input, ctx)
      case 'write_file': return await toolWriteFile(input, ctx)
      case 'replace_in_file': return await toolReplaceInFile(input, ctx)
      case 'multi_replace': return await toolMultiReplace(input, ctx)
      case 'list_dir': return await toolListDir(input, ctx)
      case 'search_files': return await toolSearchFiles(input, ctx)
      case 'kb_search': return await toolKbSearch(input, ctx)
      case 'web_fetch': return await toolWebFetch(input)
      case 'web_search': return await toolWebSearch(input)
      case 'ask_user': return await toolAskUser(input, ctx)
      case 'update_plan': return await toolUpdatePlan(input, ctx)
      case 'update_todo': return await toolUpdateTodo(input, ctx)
      case 'exit_plan_mode': return await toolExitPlanMode(input, ctx)
      default: return { ok: false, error: hostOnlyToolError(name) }
    }
  } catch (e: any) {
    return { ok: false, error: `工具执行失败：${e?.message || String(e)}` }
  }
}
