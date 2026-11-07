<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessageBox } from 'element-plus'
import { exportMarkdownAsWord } from '@/lib/export/md-to-docx'
import block_md from '@/components/block_md.vue'
import { usestore } from '@/store'
import * as kbAi from '@/shared/kbAiClient'
import * as XLSX from 'xlsx'
import { getPlatform, hasCapability } from '@/platform'
import {
  styleProfilePrompt, mimicQuestionPrompt, normalizeStyleProfile, styleProfileSummary,
  emptyStyleProfile, type ExamStyleProfile,
} from '@/services/learningPrompt'

// 定义组件接口
interface Props {
  store: any
  blocks: any[]
  model: any
  kbPath?: string       // 当前知识库路径（真题风格档案按知识库分别保存）
  examTrack?: boolean   // 考试结果是否计入学习对象（父级状态）
  getModel?: () => Promise<void>
  cosineSimilarity?: (vecA: number[], vecB: number[]) => number
  files?: any[]
}

const props = defineProps<Props>()
const store = usestore()

// 统一模型来源客户端（多 provider）：连接配置取自 store.AIconfig.llm[llmType]
const kbSpec = () => kbAi.buildSpecFromModel(props.model, props.store)
const kbChat = async (messages: any[], opts?: any) => kbAi.chat(kbSpec(), messages, opts)

// 定义发射事件（出题/判分进度 → 底部状态栏；表单校验 → 状态提示；判分结果 → 供父组件计入学习对象）
const emit = defineEmits<{
  updateState: [state: string]
  updateLiveState: [state: string]
  updateExamTrack: [v: boolean]
  examGraded: [rows: { q: string; ok: boolean; score: number; blockId: any; filePath: string }[]]
  ask: [question: string]
}>()

// 计入学习对象开关（工具栏图标按钮；说明放 title）
const examTrack = computed(() => !!props.examTrack)
const toggleExamTrack = () => emit('updateExamTrack', !examTrack.value)
const examTrackTitle = computed(() => {
  const zh = store.locales === 'zh'
  if (examTrack.value) {
    return zh
      ? '考试计入学习对象：已开启——交卷后每题作答计入来源文件（掌握度/间隔复习/错题），点击关闭'
      : 'Feed into learning: ON — graded answers feed the source file (mastery/SRS/mistakes). Click to turn off'
  }
  return zh
    ? '考试计入学习对象：已关闭——开启后交卷每题作答计入来源文件学习对象（仅由切片出题的题目可计入）'
    : 'Feed into learning: OFF — when on, graded answers feed the source file learning object (slice-generated only)'
})

// ==================== 考试标签页（exam） ====================
type ExamQuestionType = 'single' | 'multi' | 'judge' | 'essay'

interface ExamSourceSlice {
  label: string
  content: string
  blockId?: any       // 来源切片 id（计入学习对象用）
  filePath?: string   // 来源文件（计入学习对象用）
}

interface ExamQuestion {
  id: string
  type: ExamQuestionType
  prompt: string
  options: string[]
  correctOption: number[]       // 单选题 [i]；多选题 [i,j]；判断题/问答题 []
  judgeAnswer: boolean | null   // 判断题正确值
  essayRef: string              // 问答题参考答案（手动输入/大模型给出）
  sourceSlices: ExamSourceSlice[]
  userOption: number[]
  userJudge: boolean | null
  userEssay: string
  result: {
    correct: boolean | null
    score: number
    comment: string
    reference: string
  } | null
  _showSrc?: boolean
  _explaining?: boolean
}

/** 保存到 <库名>.exams.json 的一张试卷（模板 + 本次作答 + 成绩） */
interface SavedExamPaper {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  mode: 'random' | 'select' | 'manual' | 'mimic'
  types: Record<ExamQuestionType, boolean>
  count: number
  elapsed: number
  graded: boolean
  flagged: string[]
  questions: ExamQuestion[]
}

interface ExamPaperFile {
  version: number
  kb: string
  updatedAt: string
  papers: SavedExamPaper[]
}

const examTypeLabels: Record<ExamQuestionType, { zh: string, en: string }> = {
  single: { zh: '单选题', en: 'Single Choice' },
  multi: { zh: '多选题', en: 'Multi Choice' },
  judge: { zh: '判断题', en: 'True/False' },
  essay: { zh: '问答题', en: 'Essay' }
}

// 出题方式：随机采样 / 自选切片 / 手动输入 / 真题仿写
const examMode = ref<'random' | 'select' | 'manual' | 'mimic'>('random')
const examCount = ref(5)  // 随机出题的题数（= 采样切片数）
// 题数输入框：随机/自选模式写 examCount，仿写模式写 mimicCount（模板共用同一个输入框）
const countValue = computed<number>({
  get: () => (examMode.value === 'mimic' ? mimicCount.value : examCount.value),
  set: (v: number) => { if (examMode.value === 'mimic') mimicCount.value = v; else examCount.value = v },
})
const examTypes = reactive<Record<ExamQuestionType, boolean>>({ single: true, multi: true, judge: true, essay: true })
const examQuestions = ref<ExamQuestion[]>([])
const examGenerating = ref(false)
const examStartedAt = ref(0)
const examElapsed = ref(0)
let examTimer: ReturnType<typeof setInterval> | null = null
const flaggedIds = ref<string[]>([])
const showNavigator = ref(true)
const examGrading = ref(false)
const examGraded = ref(false)
const examStarted = ref(false)
const examPhase = computed<'setup' | 'answering' | 'result'>(() => examGraded.value ? 'result' : (examStarted.value && examQuestions.value.length ? 'answering' : 'setup'))
const examSummaryOpen = ref(false)  // 考试结果弹窗开关（判分完成后可切换）
// ===== 试卷库：<库名>.exams.json（模板 + 作答 + 成绩） =====
const papers = ref<SavedExamPaper[]>([])
const paperLibraryOpen = ref(false)
const currentPaperId = ref('')
const currentPaperTitle = ref('')
const paperSaving = ref(false)
const paperLoading = ref(false)
const paperMsg = ref('')
const paperFilePath = computed(() => {
  const p = String(props.kbPath || '').trim()
  return p ? p.replace(/\.kb$/i, '') + '.exams.json' : ''
})
const paperKbName = computed(() => {
  const p = String(props.kbPath || '').trim()
  if (!p) return ''
  return (p.replace(/\\/g, '/').split('/').pop() || '').replace(/\.kb$/i, '')
})

// 自选切片：按在可用切片中的下标勾选；支持「按文件 / 按切片」两类勾选
const examSliceKeyword = ref('')
const examFileKeyword = ref('')
const examSelKind = ref<'file' | 'slice'>('file')
const examSelectOpen = ref(true)  // 自选面板开关（select 模式左侧侧边栏）
const examSelectedSliceIdx = ref<number[]>([])

// 手动出题草稿
const examDraft = reactive<{
  type: ExamQuestionType
  prompt: string
  options: string[]
  optionCorrect: number[]
  judgeAnswer: boolean | null
  essayRef: string
}>({ type: 'single', prompt: '', options: ['', ''], optionCorrect: [], judgeAnswer: null, essayRef: '' })

// 可用切片（有内容）
const examUsableSlices = computed(() => (props.blocks || []).filter((b: any) => b?.A && String(b.A).trim()))

// 自选模式切片列表（搜索过滤 + 截断 200 条，避免渲染上千条卡顿）
const examFilteredSlices = computed(() => {
  const kw = examSliceKeyword.value.trim().toLowerCase()
  const usable = examUsableSlices.value
  const out: Array<{ idx: number, block: any }> = []
  for (let i = 0; i < usable.length && out.length < 200; i++) {
    const b = usable[i]
    if (kw) {
      const hay = ((b.label || '') + ' ' + String(b.A)).toLowerCase()
      if (!hay.includes(kw)) continue
    }
    out.push({ idx: i, block: b })
  }
  return out
})

// 按文件分组（filePath/path/label 作为 key；label 为显示名，含切片数与下标集合）
const examFiles = computed(() => {
  const usable = examUsableSlices.value
  const map = new Map<string, { key: string, label: string, extension: string, count: number, idxs: number[] }>()
  for (let i = 0; i < usable.length; i++) {
    const b = usable[i]
    const key = b.filePath || b.path || b.label || ('file-' + i)
    let e = map.get(key)
    if (!e) {
      e = { key, label: b.label || key, extension: b.extension || '', count: 0, idxs: [] }
      map.set(key, e)
    }
    e.count++
    e.idxs.push(i)
  }
  return [...map.values()]
})

// 文件列表搜索过滤
const examFilteredFiles = computed(() => {
  const kw = examFileKeyword.value.trim().toLowerCase()
  return examFiles.value.filter(f => !kw || f.label.toLowerCase().includes(kw) || f.key.toLowerCase().includes(kw))
})

// 启用题型列表
const enabledExamTypes = computed(() => (Object.keys(examTypes) as ExamQuestionType[]).filter(t => examTypes[t]))

const examTypeLabel = (t: string) => (store.locales=='zh' ? examTypeLabels[t as ExamQuestionType]?.zh : examTypeLabels[t as ExamQuestionType]?.en) || t

// 题型图标（按钮只显示图标，详细说明放 title）
const examTypeIcons: Record<ExamQuestionType, string> = {
  single: 'fa-dot-circle-o',
  multi: 'fa-check-square-o',
  judge: 'fa-toggle-on',
  essay: 'fa-question-circle-o'
}
const examTypeIcon = (t: string) => examTypeIcons[t as ExamQuestionType] || 'fa-question-circle-o'

const toggleExamType = (key: string) => {
  const k = key as ExamQuestionType
  examTypes[k] = !examTypes[k]
}

function shuffleArr<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function examShortId(): string {
  return 'ex' + Math.random().toString(36).slice(2, 10)
}

function sameArray(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

// 从大模型输出中容错解析出题目数组
// 支持：```json 围栏 / 顶层数组 / {questions:[...]} / 多个独立 JSON 对象（逐行拼接）
function parseExamJsonArray(text: string): any[] {
  let t = (text || '').trim()
  t = t.replace(/```(?:json)?/gi, '').trim()
  const out: any[] = []
  let i = 0
  while (i < t.length) {
    while (i < t.length && t[i] !== '[' && t[i] !== '{') i++
    if (i >= t.length) break
    let depth = 0
    let inStr = false
    let end = -1
    for (let k = i; k < t.length; k++) {
      const ch = t[k]
      if (ch === '"') { if (t[k - 1] !== '\\') inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '[' || ch === '{') depth++
      else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    if (end === -1) break
    const chunk = t.slice(i, end + 1)
    try {
      const parsed = JSON.parse(chunk)
      if (Array.isArray(parsed)) {
        out.push(...parsed)
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.questions)) out.push(...parsed.questions)
        else if (Array.isArray(parsed.items)) out.push(...parsed.items)
        else out.push(parsed)
      }
    } catch { /* 忽略无法解析的片段，继续找下一个 */ }
    i = end + 1
  }
  return out
}

function normalizeOptions(v: any): string[] {
  if (Array.isArray(v)) return v.map((o: any) => String(o).trim()).filter((o: string) => o)
  if (typeof v === 'string') {
    return v.split(/\r?\n/).map((l: string) => l.trim().replace(/^[A-Ha-h][\.、)．]\s*/, '')).filter((o: string) => o)
  }
  return []
}

function normalizeIndices(v: any, len: number): number[] {
  if (v == null || len <= 0) return []
  const out: number[] = []
  const push = (n: number) => { if (n >= 0 && n < len) out.push(n) }
  const pushOne = (x: any) => {
    if (typeof x === 'number') push(x)
    else if (typeof x === 'string') {
      const s = x.trim()
      if (/^[A-Ha-h]$/.test(s)) push(s.toUpperCase().charCodeAt(0) - 65)
      else if (!isNaN(Number(s))) push(Number(s))
    }
  }
  if (Array.isArray(v)) v.forEach(pushOne)
  else pushOne(v)
  return [...new Set(out)]
}

function toJudgeBool(v: any): boolean | null {
  if (v === true || v === 'true' || v === '对' || v === '正确' || v === '√' || v === '是') return true
  if (v === false || v === 'false' || v === '错' || v === '错误' || v === '×' || v === '否') return false
  return null
}

// 从题干文本中拆分混入的选项（形如 "A. xxx / B、yyy"），返回题干与选项
function splitOptionsFromPrompt(prompt: string): { stem: string, options: string[] } {
  const lines = prompt.split(/\r?\n/)
  const optPattern = /^\s*[A-Ha-h][\.、)．]\s*(.+)$/
  const options: string[] = []
  const stemLines: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = trimmed.match(optPattern)
    if (m) options.push(m[1].trim())
    else stemLines.push(trimmed)
  }
  if (options.length < 2) return { stem: prompt, options: [] }
  return { stem: stemLines.join(' '), options }
}

// 清洗选项列表：去掉字母序号前缀、过滤明显非选项的内容（答案说明/纯序号）
function cleanOptionList(options: any[]): string[] {
  const out: string[] = []
  for (const raw of options) {
    let o = String(raw).trim()
    o = o.replace(/^[A-Ha-h][\.、)．]\s*/, '').trim()
    if (!o) continue
    if (/^(答案|正确答案|解析|解释)[：:]/.test(o)) continue
    if (/^[A-Ha-h][\.、)．]$/.test(o)) continue
    out.push(o)
  }
  return out
}

// 把大模型返回的原始条目规整为 ExamQuestion
function normalizeExamItem(it: any, slice: ExamSourceSlice | undefined, idx: number): ExamQuestion | null {
  let type = (['single', 'multi', 'judge', 'essay'].includes(it?.type) ? it.type : null) as ExamQuestionType | null
  let prompt = String(it?.prompt || it?.question || '').trim()
  if (!prompt) return null
  let options = normalizeOptions(it?.options)
  if (!type) type = options.length >= 2 ? 'single' : 'essay'
  let correctOption: number[] = []
  let judgeAnswer: boolean | null = null
  let essayRef = String(it?.ref || it?.reference || '').trim()
  if (type === 'single' || type === 'multi') {
    // 结构化清洗：若选项不足，尝试从题干中拆分混入的选项，保持题干与选项分离
    if (options.length < 2) {
      const splitted = splitOptionsFromPrompt(prompt)
      if (splitted.options.length >= 2) {
        prompt = splitted.stem
        options = splitted.options
      }
    }
    options = cleanOptionList(options)
    // 选择题选项不足 → 降级为问答题，避免坏题
    if (options.length < 2) {
      type = 'essay'
    } else {
      correctOption = normalizeIndices(it?.correct ?? it?.answer ?? it?.correctAnswer, options.length)
      if (!correctOption.length && type === 'single') correctOption = [0]
      if (!correctOption.length) {
        // 无法确定正确选项 → 降级为问答题
        type = 'essay'
        essayRef = essayRef || (options.join('；'))
      }
    }
  } else if (type === 'judge') {
    judgeAnswer = toJudgeBool(it?.judge ?? it?.answer)
    if (judgeAnswer == null) judgeAnswer = true
  } else {
    essayRef = essayRef || String(it?.answer || '').trim()
  }
  return {
    id: examShortId() + '-' + idx,
    type,
    prompt,
    options: (type === 'single' || type === 'multi') ? options : [],
    correctOption,
    judgeAnswer,
    essayRef,
    sourceSlices: slice ? [slice] : [],
    userOption: [],
    userJudge: null,
    userEssay: '',
    result: null
  }
}

// 疑似“无法根据切片作答”的坏题（计算题/需外部数据/正确选项与切片无依据）
function isLikelyUnanswerable(q: ExamQuestion, slice: ExamSourceSlice): boolean {
  const stem = q.prompt
  if (/(计算|推导|算出|求和)/.test(stem)) return true
  const firstCorrect = (q.type === 'single' || q.type === 'multi') && q.correctOption.length ? q.options[q.correctOption[0]] : ''
  if (/(是多少|等于多少|值为|结果是)/.test(stem) && firstCorrect && !slice.content.includes(firstCorrect)) return true
  if (firstCorrect && /[0-9]/.test(firstCorrect) && firstCorrect.length > 1 && !slice.content.includes(firstCorrect)) return true
  return false
}

// 生成题目：随机采样 / 自选切片 → 逐片调用大模型出题，生成一题立即出现在答题区
async function generateExamQuestions() {
  if (examGenerating.value) return
  currentPaperId.value = ''
  currentPaperTitle.value = ''
  examStarted.value = false
  examGraded.value = false
  examSummaryOpen.value = false
  const usable = examUsableSlices.value
  let pool: ExamSourceSlice[] = []
  let target = 0
  if (examMode.value === 'random') {
    if (!usable.length) {
      emit('updateLiveState', store.locales=='zh' ? '知识库切片为空，无法出题' : 'No slices available')
      return
    }
    target = Math.min(Math.max(1, Number(examCount.value) || 1), usable.length)
    // 出题池 = 打乱后的全部可用切片：某片出题失败时自动用下一片补足，尽量保证最终达到目标题数 target
    pool = shuffleArr(usable).map((b: any) => ({ label: b.label || b.id || '', content: String(b.A).trim(), blockId: b.id, filePath: b.filePath || b.path || b.label }))
  } else if (examMode.value === 'select') {
    if (!examSelectedSliceIdx.value.length) {
      emit('updateLiveState', store.locales=='zh' ? '请先勾选切片再出题' : 'Select slices first')
      return
    }
    const idxSet = new Set(examSelectedSliceIdx.value)
    let sel = usable.filter((b: any, i: number) => idxSet.has(i))
    // 勾选切片数超过题数时打乱后依次取用（某片失败会用下一片补足）；不够时全部使用（题数上限 = 勾选切片数）
    const n = Math.max(1, Number(examCount.value) || 1)
    if (sel.length > n) sel = shuffleArr(sel)
    pool = sel.map((b: any) => ({ label: b.label || b.id || '', content: String(b.A).trim(), blockId: b.id, filePath: b.filePath || b.path || b.label }))
    target = Math.min(n, pool.length)
  } else {
    return  // manual 模式走手动编辑器
  }
  if (!pool.length) {
    emit('updateLiveState', store.locales=='zh' ? '未找到可用切片' : 'No usable slices')
    return
  }
  if (!enabledExamTypes.value.length) {
    emit('updateLiveState', store.locales=='zh' ? '请至少勾选一种题型' : 'Enable at least one question type')
    return
  }
  examGenerating.value = true
  examGraded.value = false
  // 注意：不再清空旧试卷，新生成的题目向后追加到已有题目之后
  try {
    const genModel = props.model.process || props.model.chat
    const types = enabledExamTypes.value
    // 构造单题提示词（题型可变）
    const makePrompt = (s: ExamSourceSlice, t: ExamQuestionType) => {
      const typeRule = t === 'single' ? '（1 个正确答案，4 个选项）' : t === 'multi' ? '（2~4 个正确答案，4 个选项）' : t === 'judge' ? '（对/错）' : '（简答，给出参考答案）'
      return (store.locales=='zh'
        ? `你是知识库出题老师。请依据下面切片出 1 道${examTypeLabels[t].zh}${typeRule}。重要：无论切片是什么语言，题干、选项、正确答案和参考答案都必须用中文书写（必要时将切片内容翻译为中文），绝不使用切片原始语言出题。严格按 JSON 输出单个对象：\n{"type":"${t}","prompt":"题干（只放题目，不要包含选项）","options":["选项1","选项2","选项3","选项4"（只放纯选项文本，不要带 A/B 序号，不要写“答案”字样）],"correct":[0],"judge":true,"ref":"参考答案"}\n要求：1) prompt 字段绝不要出现选项内容；2) options 每一项只是纯选项文本，不带 A/B/C/D 序号，也不包含“正确答案”等字样；3) 题目必须【仅依据切片内容】即可确定答案，答案需能在切片中找到依据或直接推理得出——禁止“计算…/求…的值/…是多少”这类需要公式计算或切片外数据才能回答的题，禁止需要模型自身知识/常识补充才能回答的题；4) 选择题的正确答案选项要与切片内容明确相关，不要编造切片中不存在的具体数字或结论；5) 题干要直接提问，干净简洁——不要加“根据提供的文本/材料/文章/上述内容”这类引导前缀，也不要“从文中可知”“请问根据材料”等套话。\n说明：single 的 correct 为 1 个下标；multi 为多个下标；judge 用 judge 字段（true/false）且 options 可为空；essay 用 ref 字段。\n只输出 JSON，不要任何解释或前后缀。\n\n切片：\n${s.label}\n${s.content}`
        : `You are a KB exam teacher. Raise ONE ${examTypeLabels[t].en} question from the slice. IMPORTANT: always write the question stem, options, correct answer and reference in ENGLISH, no matter what language the source slice is in (translate the slice content as needed) - never write the question in the slice's language. Output ONLY a JSON object: {"type":"${t}","prompt":"stem only (NO options inside)","options":["option1","option2","option3","option4" (plain text only, NO A/B/C/D prefixes, NO 'answer' wording)],"correct":[0],"judge":true,"ref":"..."}. Rules: 1) prompt must NOT contain option text; 2) each option is plain text without letter prefix; 3) the question MUST be answerable SOLELY from the slice (answer supported by or directly inferable from the slice) - FORBIDDEN: calculation/derivation questions ("calculate...", "what is the value of..."), questions needing external data or model's own knowledge; 4) the correct choice must be clearly relevant to the slice content - do NOT invent specific numbers or conclusions absent from the slice; 5) the stem must ask directly and cleanly - do NOT prefix with phrases like "According to the text/passage", "Based on the above" or similar filler. For single correct=[one idx]; multi=[several idx]; judge uses judge (true/false); essay uses ref. JSON only.\n\nSlice:\n${s.label}\n${s.content}`)
    }
    // 生成单个题目：先按主题型，失败再依次换其他已启用题型（同一切片多题型尝试，避免该切片被浪费）
    const generateOne = async (s: ExamSourceSlice, typeList: ExamQuestionType[], qIdx: number): Promise<ExamQuestion | null> => {
      for (const t of typeList) {
        const singlePrompt = makePrompt(s, t)
        // 单题生成失败或疑似“无法根据切片作答”（计算题/编造题）时重试，最多 3 次
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const rr = await kbChat([{ role: 'user', content: singlePrompt }])
            const pp = parseExamJsonArray(rr || '')
            if (pp.length) {
              const cand = normalizeExamItem(pp[0], s, qIdx)
              if (cand && !isLikelyUnanswerable(cand, s)) return cand
            }
          } catch (e) {
            console.error('出题失败:', e)
          }
        }
      }
      return null
    }
    // 逐片生成：生成一题立即 push 到答题区（实时可见）；某片各题型都失败则用下一片补足，直到达到目标题数或切片耗尽
    // 不清空已有题目：新题追加到已有题目之后，本次目标 target 指新增题数
    let poolIdx = 0
    let made = 0  // 本次新增题数
    while (made < target && poolIdx < pool.length) {
      const s = pool[poolIdx]
      poolIdx++
      const qIdx = examQuestions.value.length  // 已有题数 + 本次已新增，用于题型轮换与题目 id
      // 题型从启用列表中按已生成题数轮换，保证多样且不超出用户勾选；失败时回退到其他已启用题型
      const primary = types[qIdx % types.length]
      const typeList = [primary, ...types.filter(x => x !== primary)]
      emit('updateLiveState', store.locales=='zh' ? `正在生成第 ${qIdx + 1} 题（本次新增 ${made + 1}/${target}）...` : `Generating question ${qIdx + 1} (+${made + 1}/${target})...`)
      const q = await generateOne(s, typeList, qIdx)
      if (q) {
        examQuestions.value.push(q)  // 生成一题立即出现在答题区
        made++
      }
    }
    // 汇总状态：本次新增题数（含可能因切片不足导致的差异）
    const summary = made >= target
      ? (store.locales=='zh' ? `本次新增 ${made} 道题，共 ${examQuestions.value.length} 题` : `Added ${made} questions, total ${examQuestions.value.length}`)
      : made
        ? (store.locales=='zh' ? `本次新增 ${made}/${target} 道题（切片不足或均无法出题，已尽量补足），共 ${examQuestions.value.length} 题` : `Added ${made}/${target} questions (slices limited), total ${examQuestions.value.length}`)
        : (store.locales=='zh' ? '出题失败：大模型未返回合法题目' : 'Generation failed: invalid questions')
    emit('updateLiveState', summary)
  } catch (e) {
    console.error('出题失败:', e)
    emit('updateLiveState', store.locales=='zh' ? '出题失败：' + String(e) : 'Generation failed: ' + String(e))
  } finally {
    examGenerating.value = false
  }
}

// ==================== 真题仿写（P1：样卷风格档案 → 仿写命题） ====================
// 流程：导入/粘贴真题 → 分析出风格档案（JSON，按知识库持久化在 localStorage）→ 按档案 + 切片出题
const mimicSource = ref('')            // 真题全文（导入或粘贴）
const mimicSourceName = ref('')        // 来源文件名（仅展示）
const mimicProfile = ref<ExamStyleProfile | null>(null)
const mimicAnalyzing = ref(false)      // 分析风格中
const mimicCount = ref(5)              // 本次生成题数
const mimicPanelOpen = ref(true)       // 左侧仿写面板开关
const mimicShowProfile = ref(false)    // 展开查看风格档案原文

function mimicStorageKey(): string {
  return 'learning:mimicStyle:' + (props.kbPath || 'default')
}
function loadMimicProfile() {
  try {
    const raw = localStorage.getItem(mimicStorageKey())
    mimicProfile.value = raw ? normalizeStyleProfile(JSON.parse(raw)) : null
  } catch { mimicProfile.value = null }
}
function saveMimicProfile() {
  try {
    if (mimicProfile.value) localStorage.setItem(mimicStorageKey(), JSON.stringify(mimicProfile.value))
    else localStorage.removeItem(mimicStorageKey())
  } catch { /* localStorage 不可用时仅保留内存态 */ }
}
watch(() => props.kbPath, () => { loadMimicProfile() }, { immediate: true })

function mimicLive(msg: string) { emit('updateLiveState', msg) }
function mimicState(msg: string) { emit('updateState', msg) }

/** 读取样卷文本：.pdf 走 pdfjs 逐页取文本（按需加载 pdfjs），.md/.txt/.docx/.doc 走主进程 readFile */
async function readExamText(filePath: string): Promise<string> {
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') {
    // 按需引入 pdfjs（仅导入 PDF 时才加载该依赖，不增加学习模块默认体积）
    // 注意：文本提取同样需要 CMap 数据——预定义 CMap 的字体缺数据时提取不出文字（与渲染同理）
    const { getDocument } = await import('pdfjs-dist')
    const { PDFJS_RUNTIME_OPTIONS } = await import('@/lib/pdfjs')
    const result = await getPlatform().fs.readDataUrl(filePath)
    if (typeof result !== 'string' || !result.startsWith('data:')) throw new Error('读取 PDF 失败')
    const binary = atob(result.split(',')[1] || '')
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const pdf = await getDocument({ data: bytes, ...PDFJS_RUNTIME_OPTIONS }).promise
    let text = ''
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      text += (content.items as any[]).map((it: any) => it.str).join(' ') + '\n\n'
    }
    try { pdf.destroy() } catch { /* 忽略 */ }
    return text.trim()
  }
  const r: any = await getPlatform().fs.readText(filePath)
  const text = (r && typeof r === 'object') ? String(r.content || '') : String(r ?? '')
  if (/^Error reading file/.test(text) || /^不支持的文件格式/.test(text)) throw new Error(text)
  return text.trim()
}

/** 导入真题文件（.md/.txt/.docx/.doc/.pdf） */
async function importMimicFile() {
  const path = await getPlatform().dialog.pickFile({
    filters: [
      { name: store.locales == 'zh' ? '真题/样卷' : 'Reference exam', extensions: ['md', 'txt', 'docx', 'doc', 'pdf'] },
      { name: store.locales == 'zh' ? '所有文件' : 'All Files', extensions: ['*'] },
    ],
  })
  if (!path) return
  try {
    const text = await readExamText(path)
    if (!text) { mimicState(store.locales == 'zh' ? '文件内容为空' : 'File is empty'); return }
    mimicSource.value = text
    mimicSourceName.value = String(path).split(/[\\/]/).pop() || ''
    mimicState(store.locales == 'zh' ? `已导入样卷：${mimicSourceName.value}（${text.length} 字）` : `Imported ${mimicSourceName.value}`)
  } catch (e) {
    mimicState(store.locales == 'zh' ? '导入失败：' + (e instanceof Error ? e.message : String(e)) : 'Import failed: ' + String(e))
  }
}

/** 分析风格：把样卷交给大模型抽取风格档案（结果按知识库落盘，可反复使用） */
async function analyzeMimicStyle() {
  if (mimicAnalyzing.value) return
  const src = mimicSource.value.trim()
  if (!src) { mimicState(store.locales == 'zh' ? '请先导入或粘贴真题内容' : 'Import or paste a reference exam first'); return }
  if (!props.model?.chat && !props.model?.process) { mimicState(store.locales == 'zh' ? '未配置可用的 AI 模型' : 'No AI model configured'); return }
  mimicAnalyzing.value = true
  try {
    mimicLive(store.locales == 'zh' ? '正在分析真题风格...' : 'Analyzing exam style...')
    // 样卷过长时截断，避免超出上下文（风格靠开头题目即可判断）
    const prompt = styleProfilePrompt(store.locales == 'zh', src.slice(0, 12000))
    const out = await kbChat([{ role: 'user', content: prompt }])
    const parsed = parseExamJsonArray(out || '')
    const p = normalizeStyleProfile(parsed[0] || null)
    if (!parsed.length) { mimicLive(store.locales == 'zh' ? '风格分析失败：模型未返回合法 JSON' : 'Style analysis failed: invalid JSON'); return }
    mimicProfile.value = p
    saveMimicProfile()
    const mixTotal = p.types.single + p.types.multi + p.types.judge + p.types.essay
    if (mixTotal > 0) mimicCount.value = Math.min(50, Math.max(1, mixTotal))
    mimicShowProfile.value = true
    mimicLive(store.locales == 'zh' ? '风格分析完成' : 'Style analyzed')
  } catch (e) {
    mimicLive(store.locales == 'zh' ? '风格分析失败：' + String(e) : 'Style analysis failed: ' + String(e))
  } finally {
    mimicAnalyzing.value = false
  }
}

/** 仿写题型轮换：优先按样卷题量配比抽样，配比缺失时回退为勾选题型轮换 */
function pickMimicType(qIdx: number, types: ExamQuestionType[]): ExamQuestionType {
  const p = mimicProfile.value
  if (p) {
    const weighted: ExamQuestionType[] = []
    for (const t of types) {
      const n = Math.max(0, Math.round(p.types[t] || 0))
      for (let i = 0; i < n; i++) weighted.push(t)
    }
    if (weighted.length) return weighted[qIdx % weighted.length]
  }
  return types[qIdx % types.length]
}

/** 仿写单题：同题型失败后换其他已启用题型，最多 3 次重试 */
async function generateMimicOne(
  s: ExamSourceSlice, typeList: ExamQuestionType[], qIdx: number, style: ExamStyleProfile
): Promise<ExamQuestion | null> {
  for (const t of typeList) {
    const ruleZh = t === 'single' ? '（1 个正确答案，4 个选项）' : t === 'multi' ? '（2~4 个正确答案，4 个选项）' : t === 'judge' ? '（对/错）' : '（简答，给出参考答案）'
    const ruleEn = t === 'single' ? ' (1 correct answer, 4 options)' : t === 'multi' ? ' (2-4 correct answers, 4 options)' : t === 'judge' ? ' (true/false)' : ' (short answer with reference)'
    const prompt = mimicQuestionPrompt(
      store.locales == 'zh', { label: s.label, content: s.content },
      t, ruleZh, ruleEn, examTypeLabels[t].zh, examTypeLabels[t].en, style
    )
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rr = await kbChat([{ role: 'user', content: prompt }])
        const pp = parseExamJsonArray(rr || '')
        if (pp.length) {
          const cand = normalizeExamItem(pp[0], s, qIdx)
          if (cand && !isLikelyUnanswerable(cand, s)) return cand
        }
      } catch (e) {
        console.error('仿写出题失败:', e)
      }
    }
  }
  return null
}

/** 按风格档案生成试卷（新题追加到已有题之后，与其它模式一致） */
async function generateMimicQuestions() {
  if (examGenerating.value) return
  currentPaperId.value = ''
  currentPaperTitle.value = ''
  examStarted.value = false
  examGraded.value = false
  examSummaryOpen.value = false
  if (!mimicProfile.value) { mimicLive(store.locales == 'zh' ? '请先分析真题风格' : 'Analyze the exam style first'); return }
  const usable = examUsableSlices.value
  if (!usable.length) { mimicLive(store.locales == 'zh' ? '知识库切片为空，无法出题' : 'No slices available'); return }
  const types = enabledExamTypes.value
  if (!types.length) { mimicLive(store.locales == 'zh' ? '请至少勾选一种题型' : 'Enable at least one question type'); return }
  const target = Math.min(50, Math.max(1, Number(mimicCount.value) || 1))
  const pool = shuffleArr(usable).map((b: any) => ({
    label: b.label || b.id || '', content: String(b.A).trim(),
    blockId: b.id, filePath: b.filePath || b.path || b.label,
  } as ExamSourceSlice))
  examGenerating.value = true
  examGraded.value = false
  try {
    const style = mimicProfile.value
    let poolIdx = 0
    let made = 0
    while (made < target && poolIdx < pool.length) {
      const s = pool[poolIdx]
      poolIdx++
      const qIdx = examQuestions.value.length
      const primary = pickMimicType(qIdx, types)
      const typeList = [primary, ...types.filter(x => x !== primary)]
      mimicLive(store.locales == 'zh' ? `正在仿写第 ${qIdx + 1} 题（本次新增 ${made + 1}/${target}）...` : `Writing question ${qIdx + 1} (+${made + 1}/${target})...`)
      const q = await generateMimicOne(s, typeList, qIdx, style)
      if (q) { examQuestions.value.push(q); made++ }
    }
    const summary = made
      ? (store.locales == 'zh' ? `本次新增 ${made}/${target} 道仿写题，共 ${examQuestions.value.length} 题` : `Added ${made}/${target} mimic questions, total ${examQuestions.value.length}`)
      : (store.locales == 'zh' ? '仿写出题失败：大模型未返回合法题目' : 'Mimic generation failed: invalid questions')
    mimicLive(summary)
  } catch (e) {
    console.error('仿写出题失败:', e)
    mimicLive(store.locales == 'zh' ? '仿写出题失败：' + String(e) : 'Mimic generation failed: ' + String(e))
  } finally {
    examGenerating.value = false
  }
}

/** 清空真题仿写状态（保留已生成的题目） */
function resetMimic() {
  mimicSource.value = ''
  mimicSourceName.value = ''
  mimicProfile.value = null
  mimicShowProfile.value = false
  saveMimicProfile()
  mimicState(store.locales == 'zh' ? '已清空真题与风格档案' : 'Reference exam and style cleared')
}

// 自选切片勾选
function toggleExamSlice(idx: number) {
  const i = examSelectedSliceIdx.value.indexOf(idx)
  if (i >= 0) examSelectedSliceIdx.value.splice(i, 1)
  else examSelectedSliceIdx.value.push(idx)
}
function selectAllExamSlices() {
  if (examSelKind.value === 'file') {
    const idxs: number[] = []
    for (const f of examFilteredFiles.value) for (const i of f.idxs) if (!idxs.includes(i)) idxs.push(i)
    examSelectedSliceIdx.value = idxs
  } else {
    examSelectedSliceIdx.value = examFilteredSlices.value.map(f => f.idx)
  }
}
function clearExamSliceSelection() {
  examSelectedSliceIdx.value = []
}

// 文件全选 / 部分选中判定
function isExamFileAllSelected(f: { idxs: number[] }): boolean {
  return f.idxs.length > 0 && f.idxs.every(i => examSelectedSliceIdx.value.includes(i))
}
function isExamFilePartSelected(f: { idxs: number[] }): boolean {
  return f.idxs.some(i => examSelectedSliceIdx.value.includes(i)) && !isExamFileAllSelected(f)
}

// 切换文件勾选（全选 / 全不选该文件的所有切片）
function toggleExamFile(f: { idxs: number[] }) {
  const set = new Set(f.idxs)
  if (isExamFileAllSelected(f)) {
    examSelectedSliceIdx.value = examSelectedSliceIdx.value.filter(i => !set.has(i))
  } else {
    const cur = new Set(examSelectedSliceIdx.value)
    for (const i of f.idxs) cur.add(i)
    examSelectedSliceIdx.value = [...cur]
  }
}

// 手动出题：编辑器中标记正确选项
function toggleManualOptionCorrect(oi: number) {
  if (examDraft.type === 'single') examDraft.optionCorrect = [oi]
  else {
    const i = examDraft.optionCorrect.indexOf(oi)
    if (i >= 0) examDraft.optionCorrect.splice(i, 1)
    else examDraft.optionCorrect.push(oi)
  }
}

// 手动添加题目到试卷
function addManualExamQuestion() {
  if (!examQuestions.value.length) {
    currentPaperId.value = ''
    currentPaperTitle.value = ''
    examStarted.value = false
    examGraded.value = false
    examSummaryOpen.value = false
  }
  const prompt = examDraft.prompt.trim()
  if (!prompt) {
    emit('updateState', store.locales=='zh' ? '请输入题干' : 'Enter the question stem')
    return
  }
  const type = examDraft.type
  let q: ExamQuestion
  if (type === 'single' || type === 'multi') {
    const opts = examDraft.options.map(o => o.trim()).filter(o => o)
    if (opts.length < 2) {
      emit('updateState', store.locales=='zh' ? '选择题至少需要 2 个选项' : 'Choices need at least 2 options')
      return
    }
    const correct = examDraft.optionCorrect.filter(i => i >= 0 && i < opts.length)
    if (!correct.length) {
      emit('updateState', store.locales=='zh' ? '请标记正确答案' : 'Mark the correct option')
      return
    }
    q = { id: examShortId(), type, prompt, options: opts, correctOption: correct, judgeAnswer: null, essayRef: '', sourceSlices: [], userOption: [], userJudge: null, userEssay: '', result: null }
  } else if (type === 'judge') {
    if (examDraft.judgeAnswer == null) {
      emit('updateState', store.locales=='zh' ? '请选择正确值（对/错）' : 'Pick the correct value')
      return
    }
    q = { id: examShortId(), type, prompt, options: [], correctOption: [], judgeAnswer: examDraft.judgeAnswer, essayRef: '', sourceSlices: [], userOption: [], userJudge: null, userEssay: '', result: null }
  } else {
    q = { id: examShortId(), type, prompt, options: [], correctOption: [], judgeAnswer: null, essayRef: examDraft.essayRef.trim(), sourceSlices: [], userOption: [], userJudge: null, userEssay: '', result: null }
  }
  examQuestions.value.push(q)
  examDraft.prompt = ''
  examDraft.options = ['', '']
  examDraft.optionCorrect = []
  examDraft.judgeAnswer = null
  examDraft.essayRef = ''
  examGraded.value = false
}

// 答题交互（已判分后锁定）
function toggleUserOption(q: ExamQuestion, oi: number) {
  if (q.result) return
  if (q.type === 'single') q.userOption = [oi]
  else {
    const i = q.userOption.indexOf(oi)
    if (i >= 0) q.userOption.splice(i, 1)
    else q.userOption.push(oi)
  }
}
function setUserJudge(q: ExamQuestion, v: boolean) {
  if (q.result) return
  q.userJudge = v
}

// 问答题：大模型判分
async function gradeEssay(q: ExamQuestion, genModel: string) {
  const ref = q.sourceSlices.length
    ? q.sourceSlices.map(s => `【${s.label}】\n${s.content}`).join('\n\n')
    : q.essayRef || ''
  const prompt = (store.locales=='zh'
    ? `你是知识库考试阅卷老师。请依据下面的参考切片评阅考生答案，给出 0-100 的整数分数。评语与标准参考答案始终用中文输出，无论切片是什么语言。\n\n题目：${q.prompt}\n\n【参考切片】\n${ref || '(无)'}\n\n【考生答案】\n${q.userEssay}\n\n严格按 JSON 输出：{"score":<0-100整数>,"comment":"简短评语","reference":"标准参考答案"}，只输出 JSON。`
    : `You are a KB exam grader. Grade the answer based on the reference slice, give an integer score 0-100. Write the "comment" and "reference" in ENGLISH regardless of the slice language.\n\nQuestion: ${q.prompt}\n\n[Reference]\n${ref || '(none)'}\n\n[Student answer]\n${q.userEssay}\n\nOutput ONLY JSON: {"score":<0-100 int>,"comment":"brief comment","reference":"standard answer"}.`)
  try {
    const out0 = await kbChat([{ role: 'user', content: prompt }])
    const parsed = parseExamJsonArray(out0 || '')
    const obj = parsed[0] || {}
    const n = Number(obj.score)
    const score = isNaN(n) ? 0 : Math.max(0, Math.min(100, n))
    q.result = {
      correct: score >= 60,
      score,
      comment: String(obj.comment || ''),
      reference: String(obj.reference || '')
    }
  } catch (e) {
    q.result = { correct: null, score: 0, comment: store.locales=='zh' ? '判分失败' : 'Grading failed', reference: '' }
  }
}

// 客观题：大模型生成解析（不改变本机已判对错）
async function explainObjective(q: ExamQuestion, genModel: string) {
  const optsText = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')
  const correctText = q.correctOption.map(i => String.fromCharCode(65 + i)).join('、')
  const ref = q.sourceSlices.length
    ? q.sourceSlices.map(s => `【${s.label}】\n${s.content}`).join('\n\n')
    : ''
  const prompt = (store.locales=='zh'
    ? `你是知识库考试阅卷老师。请用 1-2 句话解析下面这道${examTypeLabels[q.type].zh}的答案依据（依据参考切片）。无论切片是什么语言，解析始终用中文输出。\n\n题目：${q.prompt}\n${optsText}\n正确答案：${correctText}\n\n【参考切片】\n${ref || '(无)'}\n\n只输出解析文本，不要任何前后缀。`
    : `You are a KB exam grader. Explain in 1-2 sentences why the answer to this ${examTypeLabels[q.type].en} is correct, based on the reference slice. Write the explanation in ENGLISH regardless of the slice language.\n\nQuestion: ${q.prompt}\n${optsText}\nCorrect answer: ${correctText}\n\n[Reference]\n${ref || '(none)'}\n\nOutput ONLY the explanation text.`)
  try {
    const out0 = await kbChat([{ role: 'user', content: prompt }])
    const txt = String(out0 || '').trim()
    if (txt && q.result) q.result.comment = txt
  } catch { /* 解析失败保留本机评语 */ }
}

// 客观题：按需生成解析（点击「生成解析」时调用大模型，不改变已判定的对错）
async function explainOneQuestion(q: ExamQuestion) {
  if (q._explaining || !q.result || !q.sourceSlices.length) return
  q._explaining = true
  try {
    const genModel = props.model.process || props.model.chat
    await explainObjective(q, genModel)
  } catch (e) {
    console.error('生成解析失败:', e)
  } finally {
    q._explaining = false
  }
}

// 交卷判分：客观题本机比对（立即，零大模型依赖）+ 问答题由大模型评分
async function submitExam(): Promise<void> {
  const n = unansweredCount.value
  if (n > 0) {
    try {
      await ElMessageBox.confirm(
        store.locales === 'zh' ? `还有 ${n} 题未作答，确定仍然交卷吗？` : `${n} question(s) unanswered. Submit anyway?`,
        store.locales === 'zh' ? '交卷确认' : 'Submit exam',
        {
          confirmButtonText: store.locales === 'zh' ? '仍然交卷' : 'Submit anyway',
          cancelButtonText: store.locales === 'zh' ? '继续答题' : 'Keep answering',
          type: 'warning',
        },
      )
    } catch { return }
  }
  await gradeExam(n > 0)
}

async function gradeExam(forceUnanswered = false) {
  if (examGrading.value) return
  const unanswered = examQuestions.value.filter(q => !hasAnswer(q))
  if (unanswered.length && !forceUnanswered) {
    emit('updateLiveState', store.locales=='zh' ? `还有 ${unanswered.length} 题未作答，请完成后再交卷` : `${unanswered.length} unanswered, finish first`)
    return
  }
  examGrading.value = true
  try {
    const genModel = props.model.process || props.model.chat
    // 1) 客观题（单选/多选/判断）：本机直接比对出题时已包含的正确答案，立即判定，不调用大模型
    for (const q of examQuestions.value) {
      if (q.type === 'single' || q.type === 'multi') {
        const correct = sameArray(q.userOption, q.correctOption)
        const L = (i: number) => String.fromCharCode(65 + i)
        let comment = correct ? (store.locales=='zh' ? '回答正确' : 'Correct') : (store.locales=='zh' ? '回答错误' : 'Wrong')
        if (!correct && q.type === 'multi') {
          const missed = q.correctOption.filter(i => !q.userOption.includes(i))
          const extra = q.userOption.filter(i => !q.correctOption.includes(i))
          if (store.locales=='zh') {
            if (missed.length) comment += `，漏选：${missed.map(L).join('、')}`
            if (extra.length) comment += `，多选：${extra.map(L).join('、')}`
          } else {
            if (missed.length) comment += `, missed: ${missed.map(L).join(',')}`
            if (extra.length) comment += `, extra: ${extra.map(L).join(',')}`
          }
        }
        q.result = {
          correct,
          score: correct ? 100 : 0,
          comment,
          reference: q.correctOption.map(i => `${String.fromCharCode(65 + i)}. ${q.options[i]}`).join('；')
        }
      } else if (q.type === 'judge') {
        const correct = q.userJudge === q.judgeAnswer
        q.result = {
          correct,
          score: correct ? 100 : 0,
          comment: correct ? (store.locales=='zh' ? '回答正确' : 'Correct') : (store.locales=='zh' ? '回答错误' : 'Wrong'),
          reference: q.judgeAnswer ? (store.locales=='zh' ? '正确' : 'True') : (store.locales=='zh' ? '错误' : 'False')
        }
      }
    }
    // 2) 问答题：由大模型按切片内容评分（客观题已即时判定，无需大模型）
    const essayTasks: Promise<void>[] = []
    for (const q of examQuestions.value) {
      if (q.type === 'essay') essayTasks.push(gradeEssay(q, genModel))
    }
    if (essayTasks.length) {
      emit('updateLiveState', store.locales=='zh' ? '客观题已判定，问答题由大模型评分...' : 'Objective graded, essays graded by LLM...')
      await Promise.all(essayTasks)
    }
    // 交卷后附带每题归属切片（供父组件“计入学习对象”）
    const trackedRows: { q: string; ok: boolean; score: number; blockId: any; filePath: string }[] = []
    for (const q of examQuestions.value) {
      if (!q.result) continue
      const src = q.sourceSlices && q.sourceSlices.length ? q.sourceSlices[0] : undefined
      if (src && src.blockId !== undefined && src.blockId !== null && src.blockId !== '' && src.filePath) {
        trackedRows.push({ q: q.prompt, ok: q.result.correct === true, score: q.result.score || 0, blockId: src.blockId, filePath: src.filePath })
      }
    }
    if (trackedRows.length) emit('examGraded', trackedRows)
    examGraded.value = true
    examSummaryOpen.value = false  // 结果改为结果页，不再弹窗
    emit('updateLiveState', store.locales=='zh' ? '判分完成' : 'Grading completed')
  } catch (e) {
    console.error('判分失败:', e)
    emit('updateLiveState', store.locales=='zh' ? '判分失败：' + String(e) : 'Grading failed: ' + String(e))
  } finally {
    examGrading.value = false
  }
}

// 清除交卷状态，保留题目与已作答内容，可修改答案后重新交卷
function resetExamGrading() {
  examGraded.value = false
  examStarted.value = true
  examSummaryOpen.value = false
  for (const q of examQuestions.value) {
    q.result = null
    q._showSrc = false
    q._explaining = false
  }
  if (examQuestions.value.length) startTimer()
}

// 清空重来
function resetExam() {
  examQuestions.value = []
  currentPaperId.value = ''
  currentPaperTitle.value = ''
  examGraded.value = false
  examSummaryOpen.value = false
  resetTimerAndFlags()
  examSelectedSliceIdx.value = []
  examSliceKeyword.value = ''
  examFileKeyword.value = ''
  examSelKind.value = 'file'
  examSelectOpen.value = true
  examDraft.prompt = ''
  examDraft.options = ['', '']
  examDraft.optionCorrect = []
  examDraft.judgeAnswer = null
  examDraft.essayRef = ''
}

// 导出试卷为 Excel（含题干、选项、正确答案、参考答案/解析、依据切片；判分后含你的答案/得分/判定/评语）
function exportExamExcel() {
  const qs = examQuestions.value
  if (!qs.length) {
    emit('updateState', store.locales=='zh' ? '当前没有可导出的题目' : 'No questions to export')
    return
  }
  try {
    const zh = store.locales=='zh'
    // 选项列字母（A、B、… Z、AA…）
    const colLetter = (n: number): string => {
      let s = ''
      let k = n + 1
      while (k > 0) {
        const r = (k - 1) % 26
        s = String.fromCharCode(65 + r) + s
        k = Math.floor((k - 1) / 26)
      }
      return s
    }
    const optCols = Math.max(0, ...qs.map(q => q.options.length))
    const graded = examGraded.value
    // 表头
    const header: string[] = [
      zh ? '序号' : 'No.',
      zh ? '题型' : 'Type',
      zh ? '题干' : 'Question',
      ...Array.from({ length: optCols }, (_, oi) => `${zh ? '选项' : 'Option'} ${colLetter(oi)}`),
      zh ? '正确答案' : 'Correct Answer',
      zh ? '参考答案/解析' : 'Reference / Explanation',
      ...(graded ? [zh ? '你的答案' : 'Your Answer', zh ? '得分' : 'Score', zh ? '判定' : 'Result', zh ? '解析/评语' : 'Comment'] : []),
      zh ? '依据切片' : 'Source Slice'
    ]
    const rows: any[][] = [header]
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i]
      const typeName = zh ? examTypeLabels[q.type]?.zh : examTypeLabels[q.type]?.en
      // 正确答案（字母/对错/问答题参考）
      let correctText = ''
      if (q.type === 'single' || q.type === 'multi') correctText = q.correctOption.map(colLetter).join('、')
      else if (q.type === 'judge') correctText = q.judgeAnswer ? (zh ? '正确' : 'True') : (zh ? '错误' : 'False')
      else correctText = q.essayRef || ''
      // 参考答案/解析（判分后用 result.reference，否则取题内自带答案）
      let refText = q.result?.reference || ''
      if (!refText) {
        if (q.type === 'single' || q.type === 'multi') refText = q.correctOption.map(oi => `${colLetter(oi)}. ${q.options[oi]}`).join('；')
        else if (q.type === 'judge') refText = q.judgeAnswer ? (zh ? '正确' : 'True') : (zh ? '错误' : 'False')
        else refText = q.essayRef || ''
      }
      // 你的答案（判分后）
      let userAns = ''
      let verdict = ''
      let comment = ''
      if (graded && q.result) {
        if (q.type === 'single' || q.type === 'multi') userAns = q.userOption.map(colLetter).join('、') || '-'
        else if (q.type === 'judge') userAns = q.userJudge ? (zh ? '正确' : 'True') : (zh ? '错误' : 'False')
        else userAns = (q.userEssay || '').trim() || '-'
        verdict = q.result.correct === true ? (zh ? '对' : 'Correct') : q.result.correct === false ? (zh ? '错' : 'Wrong') : '-'
        comment = q.result.comment || ''
      }
      const sliceText = q.sourceSlices.map(s => `【${s.label}】\n${String(s.content).slice(0, 120)}`).join('\n\n')
      rows.push([
        i + 1,
        typeName,
        q.prompt,
        ...Array.from({ length: optCols }, (_, oi) => q.options[oi] ?? ''),
        correctText,
        refText,
        ...(graded && q.result ? [userAns, q.result.score, verdict, comment] : []),
        sliceText
      ])
    }
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = [
      { wch: 6 }, { wch: 10 }, { wch: 40 },
      ...Array.from({ length: optCols }, () => ({ wch: 18 })),
      { wch: 14 }, { wch: 40 },
      ...(graded ? [{ wch: 18 }, { wch: 8 }, { wch: 8 }, { wch: 30 }] : []),
      { wch: 30 }
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, zh ? '试卷' : 'Exam')
    const ts = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `exam_${ts}.xlsx`)
    emit('updateState', zh ? `已导出 ${qs.length} 题到 Excel` : `Exported ${qs.length} questions to Excel`)
  } catch (e) {
    console.error('导出题目失败:', e)
    emit('updateState', store.locales=='zh' ? '导出失败' : 'Export failed')
  }
}

// ===== 考试阶段 / 计时 / 题号导航 =====
function hasAnswer(q: ExamQuestion): boolean {
  if (q.type === 'essay') return !!(q.userEssay || '').trim()
  if (q.type === 'judge') return q.userJudge != null
  return Array.isArray(q.userOption) && q.userOption.length > 0
}
const answeredCount = computed(() => examQuestions.value.filter(hasAnswer).length)
const unansweredCount = computed(() => examQuestions.value.filter(q => !hasAnswer(q)).length)
const timerText = computed(() => {
  const sec = Math.max(0, Math.floor(examElapsed.value / 1000))
  const h = String(Math.floor(sec / 3600)).padStart(2, '0')
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return h === '00' ? `${m}:${s}` : `${h}:${m}:${s}`
})
function startTimer(initialMs = 0): void {
  stopTimer()
  examStartedAt.value = Date.now() - initialMs
  examElapsed.value = initialMs
  examTimer = setInterval(() => { examElapsed.value = Date.now() - examStartedAt.value }, 1000)
}
function stopTimer(): void {
  if (examTimer) { clearInterval(examTimer); examTimer = null }
}
function toggleFlag(q: ExamQuestion): void {
  flaggedIds.value = flaggedIds.value.includes(q.id)
    ? flaggedIds.value.filter(id => id !== q.id)
    : [...flaggedIds.value, q.id]
}
function scrollToQuestion(qid: string): void {
  const el = document.getElementById('exam-q-' + qid)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function startExam(): void {
  if (!examQuestions.value.length) return
  examStarted.value = true
  stopTimer()
  startTimer(0)
}
function resetTimerAndFlags(): void {
  stopTimer()
  examStarted.value = false
  examStartedAt.value = 0
  examElapsed.value = 0
  flaggedIds.value = []
}
watch(() => examQuestions.value.length, (n) => {
  if (n > 0 && examStarted.value && !examGraded.value && !examTimer) startTimer()
  if (!n) resetTimerAndFlags()
})
watch(examGraded, (graded) => {
  if (graded) {
    examElapsed.value = Math.max(examElapsed.value, examStartedAt.value ? Date.now() - examStartedAt.value : 0)
    stopTimer()
  }
})
onBeforeUnmount(stopTimer)

const wrongQuestions = computed(() => examQuestions.value.filter(q => q.result && q.result.correct === false))
const typeBreakdown = computed(() => {
  const rows = Object.keys(examTypeLabels).map((key) => {
    const qs = examQuestions.value.filter(q => q.type === key)
    const correct = qs.filter(q => q.result?.correct).length
    return { type: key, total: qs.length, correct }
  })
  return rows.filter(r => r.total > 0)
})

// ===== 试卷库读写：同目录 <库名>.exams.json =====
function paperId(): string {
  return `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
function paperTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function snapshotQuestion(q: ExamQuestion): ExamQuestion {
  const copy: ExamQuestion = JSON.parse(JSON.stringify({
    ...q,
    sourceSlices: (q.sourceSlices || []).map(s => ({ ...s, content: String(s.content || '').slice(0, 500) })),
    _showSrc: false,
    _explaining: false,
  }))
  return copy
}
async function loadPaperLibrary(): Promise<void> {
  paperMsg.value = ''
  if (!paperFilePath.value) { papers.value = []; return }
  paperLoading.value = true
  try {
    const result: any = await getPlatform().fs.readText(paperFilePath.value)
    const raw = typeof result === 'string' ? result : (result?.content || '')
    if (!raw) { papers.value = []; return }
    const data = JSON.parse(raw) as ExamPaperFile
    papers.value = (Array.isArray(data?.papers) ? data.papers : [])
      .filter(p => p && p.id && Array.isArray(p.questions))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (e: any) {
    // 文件不存在是正常空库；解析失败才提示
    if (String(e?.message || e).includes('ENOENT')) papers.value = []
    else paperMsg.value = store.locales === 'zh' ? '试卷库读取失败' : 'Failed to read paper library'
    papers.value = []
  } finally {
    paperLoading.value = false
  }
}
async function persistPaperLibrary(): Promise<boolean> {
  if (!paperFilePath.value) {
    paperMsg.value = store.locales === 'zh' ? '请先保存知识库，试卷库需要写入 .kb 同目录' : 'Save the KB first; the paper library lives beside the .kb'
    return false
  }
  const payload: ExamPaperFile = {
    version: 1,
    kb: paperKbName.value,
    updatedAt: new Date().toISOString(),
    papers: papers.value,
  }
  const ok = await getPlatform().fs.saveText(paperFilePath.value, JSON.stringify(payload, null, 2))
  paperMsg.value = ok
    ? (store.locales === 'zh' ? `已保存 ${papers.value.length} 张试卷` : `${papers.value.length} paper(s) saved`)
    : (store.locales === 'zh' ? '试卷库写入失败' : 'Failed to write paper library')
  return !!ok
}
async function saveCurrentPaper(): Promise<void> {
  if (!examQuestions.value.length) {
    paperMsg.value = store.locales === 'zh' ? '当前没有可保存的题目' : 'No questions to save'
    return
  }
  if (!paperFilePath.value) {
    paperMsg.value = store.locales === 'zh' ? '自动知识库请先保存为 .kb，再保存试卷' : 'Save the auto KB as .kb first'
    return
  }
  if (paperSaving.value) return
  const zh = store.locales === 'zh'
  const defaultTitle = currentPaperTitle.value || `${paperKbName.value || (zh ? '知识库' : 'KB')} ${zh ? '考试' : 'Exam'} ${paperTime(Date.now())}`
  let title = defaultTitle
  try {
    const { value } = await ElMessageBox.prompt(zh ? '试卷名称：' : 'Paper title:', zh ? '保存试卷' : 'Save paper', {
      inputValue: defaultTitle,
      confirmButtonText: zh ? '保存' : 'Save',
      cancelButtonText: zh ? '取消' : 'Cancel',
      inputValidator: (v: string) => !!(v && v.trim()) || (zh ? '名称不能为空' : 'Title is required'),
    })
    title = String(value || '').trim() || defaultTitle
  } catch { return }
  paperSaving.value = true
  try {
    const existing = papers.value.find(p => p.id === currentPaperId.value)
    const now = Date.now()
    const paper: SavedExamPaper = {
      id: existing?.id || paperId(),
      title,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      mode: examMode.value,
      types: { ...examTypes },
      count: countValue.value,
      elapsed: examElapsed.value,
      graded: examGraded.value,
      flagged: [...flaggedIds.value],
      questions: examQuestions.value.map(snapshotQuestion),
    }
    const idx = papers.value.findIndex(p => p.id === paper.id)
    if (idx >= 0) papers.value[idx] = paper
    else papers.value.push(paper)
    papers.value.sort((a, b) => b.updatedAt - a.updatedAt)
    currentPaperId.value = paper.id
    currentPaperTitle.value = title
    await persistPaperLibrary()
    emit('updateState', zh ? `已保存试卷：${title}` : `Paper saved: ${title}`)
  } finally {
    paperSaving.value = false
  }
}
async function openPaper(p: SavedExamPaper): Promise<void> {
  const zh = store.locales === 'zh'
  if (examQuestions.value.length) {
    try {
      await ElMessageBox.confirm(zh ? '打开试卷会替换当前试卷，继续？' : 'Opening will replace the current paper. Continue?', zh ? '打开试卷' : 'Open paper', {
        confirmButtonText: zh ? '打开' : 'Open',
        cancelButtonText: zh ? '取消' : 'Cancel',
      })
    } catch { return }
  }
  stopTimer()
  examQuestions.value = (p.questions || []).map(q => snapshotQuestion(q))
  examGraded.value = !!p.graded
  examStarted.value = true
  examElapsed.value = Number(p.elapsed) || 0
  flaggedIds.value = Array.isArray(p.flagged) ? [...p.flagged] : []
  examMode.value = p.mode || 'random'
  if (p.mode === 'mimic') mimicCount.value = Number(p.count) || mimicCount.value
  else examCount.value = Number(p.count) || examCount.value
  if (p.types) Object.assign(examTypes, p.types)
  examSummaryOpen.value = false
  currentPaperId.value = p.id
  currentPaperTitle.value = p.title
  paperLibraryOpen.value = false
  if (!examGraded.value) startTimer(Number(p.elapsed) || 0)
}
async function deletePaper(p: SavedExamPaper): Promise<void> {
  const zh = store.locales === 'zh'
  try {
    await ElMessageBox.confirm(zh ? `删除试卷「${p.title}」？` : `Delete "${p.title}"?`, zh ? '删除试卷' : 'Delete paper', { type: 'warning' })
  } catch { return }
  papers.value = papers.value.filter(x => x.id !== p.id)
  if (currentPaperId.value === p.id) currentPaperId.value = ''
  await persistPaperLibrary()
}
async function renamePaper(p: SavedExamPaper): Promise<void> {
  const zh = store.locales === 'zh'
  try {
    const { value } = await ElMessageBox.prompt(zh ? '新的试卷名称：' : 'New title:', zh ? '重命名试卷' : 'Rename paper', {
      inputValue: p.title,
      inputValidator: (v: string) => !!(v && v.trim()) || (zh ? '名称不能为空' : 'Title is required'),
    })
    const title = String(value || '').trim()
    if (!title) return
    p.title = title
    p.updatedAt = Date.now()
    if (currentPaperId.value === p.id) currentPaperTitle.value = title
    papers.value.sort((a, b) => b.updatedAt - a.updatedAt)
    await persistPaperLibrary()
  } catch { /* cancel */ }
}
async function copyPaper(p: SavedExamPaper): Promise<void> {
  const now = Date.now()
  const copy: SavedExamPaper = {
    ...JSON.parse(JSON.stringify(p)),
    id: paperId(),
    title: `${p.title} ${store.locales === 'zh' ? '副本' : 'copy'}`,
    createdAt: now,
    updatedAt: now,
  }
  papers.value.push(copy)
  papers.value.sort((a, b) => b.updatedAt - a.updatedAt)
  await persistPaperLibrary()
}

function paperToMarkdown(p: SavedExamPaper): string {
  const zh = store.locales === 'zh'
  const lines: string[] = [`# ${p.title}`, '']
  lines.push(zh ? `保存时间：${paperTime(p.updatedAt)}` : `Saved: ${paperTime(p.updatedAt)}`)
  if (p.graded) {
    const total = p.questions.reduce((s, q) => s + (q.result?.score || 0), 0)
    const correct = p.questions.filter(q => q.result?.correct).length
    lines.push('', zh
      ? `得分：${(total / Math.max(1, p.questions.length)).toFixed(1)} · 正确 ${correct}/${p.questions.length}`
      : `Score: ${(total / Math.max(1, p.questions.length)).toFixed(1)} · ${correct}/${p.questions.length} correct`)
  }
  p.questions.forEach((q, i) => {
    lines.push('', `## ${i + 1}. ${q.prompt}`, '', `**${zh ? '题型' : 'Type'}：** ${examTypeLabel(q.type)}`)
    if (q.type === 'single' || q.type === 'multi') {
      q.options.forEach((o, oi) => lines.push(`- ${String.fromCharCode(65 + oi)}. ${o}`))
      const correct = q.correctOption.map(oi => String.fromCharCode(65 + oi)).join('、')
      lines.push('', `**${zh ? '正确答案' : 'Answer'}：** ${correct || '-'}`)
      if (p.graded) {
        const user = (q.userOption || []).map(oi => String.fromCharCode(65 + oi)).join('、') || '-'
        lines.push(`**${zh ? '你的答案' : 'Your answer'}：** ${user}`)
      }
    } else if (q.type === 'judge') {
      lines.push('', `**${zh ? '正确答案' : 'Answer'}：** ${q.judgeAnswer ? (zh ? '正确' : 'True') : (zh ? '错误' : 'False')}`)
      if (p.graded) lines.push(`**${zh ? '你的答案' : 'Your answer'}：** ${q.userJudge == null ? '-' : q.userJudge ? (zh ? '正确' : 'True') : (zh ? '错误' : 'False')}`)
    } else {
      lines.push('', `**${zh ? '参考答案' : 'Reference'}：** ${q.essayRef || '-'}`)
      if (p.graded) lines.push('', `**${zh ? '你的答案' : 'Your answer'}：** ${q.userEssay || '-'}`)
    }
    if (p.graded && q.result) {
      lines.push('', `**${zh ? '得分' : 'Score'}：** ${q.result.score}`)
      if (q.result.comment) lines.push('', `**${zh ? '评语' : 'Comment'}：** ${q.result.comment}`)
      if (q.result.reference && q.type === 'essay') lines.push('', `**${zh ? '标准答案' : 'Reference answer'}：** ${q.result.reference}`)
    }
  })
  return lines.join('\n')
}

async function exportPaperWord(p: SavedExamPaper): Promise<void> {
  try {
    await exportMarkdownAsWord(paperToMarkdown(p), { title: p.title })
  } catch (e: any) {
    emit('updateState', store.locales === 'zh' ? `导出 Word 失败：${String(e?.message || e)}` : `Word export failed: ${String(e?.message || e)}`)
  }
}
onMounted(() => { void loadPaperLibrary() })
watch(() => props.kbPath, () => {
  currentPaperId.value = ''
  currentPaperTitle.value = ''
  void loadPaperLibrary()
})
const examSummary = computed(() => {
  const qs = examQuestions.value
  if (!qs.length || !examGraded.value) return null
  const total = qs.reduce((s, q) => s + (q.result?.score || 0), 0)
  const correctCount = qs.filter(q => q.result?.correct).length
  return {
    avg: total / qs.length,
    correctCount,
    count: qs.length,
    rate: correctCount / qs.length
  }
})
</script>

<template>
  <div class="exam-manager">
    <!-- 顶部：三阶段 + 当前阶段操作（设置/答题/结果） -->
    <div class="exam-toolbar exam-toolbar-v2">
      <div class="exam-phases">
        <span class="exam-phase" :class="{ on: examPhase === 'setup', done: examPhase !== 'setup' }"><b>1</b><span class="exam-phase-label">{{ store.locales === 'zh' ? '设置' : 'Setup' }}</span></span>
        <i class="fa fa-angle-right exam-phase-sep"></i>
        <span class="exam-phase" :class="{ on: examPhase === 'answering', done: examPhase === 'result' }"><b>2</b><span class="exam-phase-label">{{ store.locales === 'zh' ? '答题' : 'Answer' }}</span></span>
        <i class="fa fa-angle-right exam-phase-sep"></i>
        <span class="exam-phase" :class="{ on: examPhase === 'result' }"><b>3</b><span class="exam-phase-label">{{ store.locales === 'zh' ? '结果' : 'Result' }}</span></span>
      </div>
      <span class="exam-spacer"></span>
      <template v-if="examPhase === 'answering'">
        <span class="exam-head-stat">{{ store.locales === 'zh' ? `已答 ${answeredCount}/${examQuestions.length}` : `${answeredCount}/${examQuestions.length} answered` }}</span>
        <span class="exam-head-stat"><i class="fa fa-clock-o"></i> {{ timerText }}</span>
        <button class="exam-tool-btn ghost" @click="showNavigator = !showNavigator" :title="store.locales === 'zh' ? '题号导航' : 'Question navigator'">
          <i class="fa fa-th"></i>
        </button>
        <button class="exam-tool-btn primary" :disabled="examGrading || examGenerating" @click="submitExam">
          <i class="fa" :class="examGrading ? 'fa-spinner fa-spin' : 'fa-check'"></i>
          {{ examGrading ? (store.locales === 'zh' ? '判分中…' : 'Grading…') : (store.locales === 'zh' ? '交卷' : 'Submit') }}
        </button>
      </template>
      <template v-else-if="examPhase === 'result'">
        <button class="exam-tool-btn ghost" @click="resetExamGrading"><i class="fa fa-undo"></i> {{ store.locales === 'zh' ? '重新作答' : 'Retry' }}</button>
        <button class="exam-tool-btn primary" @click="resetExam"><i class="fa fa-plus"></i> {{ store.locales === 'zh' ? '新试卷' : 'New exam' }}</button>
      </template>
      <template v-else>
        <span class="exam-head-stat">{{ examGenerating ? (store.locales === 'zh' ? '正在生成…' : 'Generating…') : examQuestions.length ? (store.locales === 'zh' ? `已生成 ${examQuestions.length} 题，点击开始答题` : `${examQuestions.length} questions ready — start when ready`) : (store.locales === 'zh' ? '配置试卷后生成' : 'Configure and generate') }}</span>
      </template>
      <button v-if="examQuestions.length" class="exam-tool-btn ghost" @click="saveCurrentPaper" :disabled="paperSaving" :title="store.locales === 'zh' ? '保存到试卷库' : 'Save to paper library'">
        <i class="fa" :class="paperSaving ? 'fa-spinner fa-spin' : 'fa-save'"></i>
        {{ store.locales === 'zh' ? '保存' : 'Save' }}
      </button>
      <button class="exam-tool-btn ghost" @click="paperLibraryOpen = true" :title="store.locales === 'zh' ? '管理已保存的试卷' : 'Manage saved papers'">
        <i class="fa fa-folder-open-o"></i>
        {{ store.locales === 'zh' ? '试卷库' : 'Papers' }}
        <span v-if="papers.length" class="exam-paper-count">{{ papers.length }}</span>
      </button>
      <button v-if="examQuestions.length" class="exam-tool-btn ghost" @click="exportExamExcel" :title="store.locales === 'zh' ? '导出 Excel' : 'Export Excel'">
        <i class="fa fa-file-excel-o"></i>
      </button>
    </div>
    <!-- 考试页面（随机/自选切片出题 → 答题 → 大模型判分） -->
    <div class="exam-main">
      <!-- 真题仿写面板（mimic 模式 + 开启时显示） -->
      <div v-if="examMode==='mimic' && mimicPanelOpen && examPhase === 'setup'" class="exam-select-panel">
        <div class="exam-select-toolbar">
          <span class="exam-editor-title" style="font-size:12px;"><i class="fa fa-clone"></i> {{ store.locales=='zh'?'真题仿写':'Mimic exam' }}</span>
          <span class="exam-spacer"></span>
          <button class="exam-panel-btn" @click="importMimicFile" :title="store.locales=='zh'?'导入真题文件（.md/.txt/.docx/.pdf）':'Import reference exam (.md/.txt/.docx/.pdf)'"><i class="fa fa-folder-open-o"></i></button>
          <button class="exam-panel-btn" @click="mimicPanelOpen=false" :title="store.locales=='zh'?'收起面板':'Collapse'"><i class="fa fa-times"></i></button>
        </div>
        <div class="exam-select-list scoll">
          <div class="exam-mimic-hint">
            {{ store.locales=='zh'
              ? '① 导入或粘贴真题/样卷 → ② 分析风格 → ③ 工具栏设置题数并点「生成」，即按其次风格出题（风格档案按知识库保存在本机）'
              : '① Import or paste a reference exam → ② Analyze style → ③ Set the count in the toolbar and click Generate. The style profile is stored locally per KB.' }}
          </div>
          <textarea v-model="mimicSource" class="exam-mimic-src" spellcheck="false"
                    :placeholder="store.locales=='zh'?'在此粘贴真题全文，或点右上角文件夹导入…':'Paste the exam text here, or use the folder button above…'"></textarea>
          <div class="exam-mimic-file">{{ (mimicSourceName || (store.locales=='zh'?'未选择文件':'no file')) }} · {{ mimicSource.length }} {{ store.locales=='zh'?'字':'chars' }}</div>
          <button class="exam-mimic-btn" :disabled="mimicAnalyzing" @click="analyzeMimicStyle">
            <i class="fa" :class="mimicAnalyzing ? 'fa-spinner fa-spin' : 'fa-magic'"></i> {{ store.locales=='zh'?'分析真题风格':'Analyze style' }}
          </button>
          <template v-if="mimicProfile">
            <div class="exam-mimic-sum">{{ styleProfileSummary(mimicProfile, store.locales=='zh') }}</div>
            <div class="exam-mimic-actions">
              <button class="exam-mimic-btn ghost" @click="mimicShowProfile = !mimicShowProfile"><i class="fa fa-code"></i> {{ store.locales=='zh'?'查看风格档案':'View profile' }}</button>
              <button class="exam-mimic-btn ghost" @click="resetMimic"><i class="fa fa-eraser"></i> {{ store.locales=='zh'?'清空':'Clear' }}</button>
            </div>
            <pre v-if="mimicShowProfile" class="exam-mimic-json">{{ JSON.stringify(mimicProfile, null, 2) }}</pre>
          </template>
        </div>
        <div class="exam-select-footer">
          <i class="fa" :class="mimicProfile ? 'fa-check-circle-o exam-icon-check' : 'fa-square-o exam-icon-check'"></i>
          <span>{{ mimicProfile ? (store.locales=='zh'?'风格档案已就绪':'Style profile ready') : (store.locales=='zh'?'尚未分析风格':'No style profile yet') }}</span>
        </div>
      </div>

      <!-- 右侧主区 -->
      <div class="exam-body">

      <!-- 设置阶段：出题方式 / 题型 / 题数 / 生成 -->
      <div v-if="examPhase === 'setup'" class="exam-setup scoll" :class="{ 'has-grid': examMode === 'select' }">
        <div class="exam-setup-head">
          <span class="exam-setup-title"><i class="fa fa-sliders"></i> {{ store.locales === 'zh' ? '设置试卷' : 'Exam setup' }}</span>
          <span class="exam-setup-sub">{{ store.locales === 'zh' ? '选好后直接生成' : 'Configure, then generate' }}</span>
          <span class="exam-spacer"></span>
          <label v-if="examMode !== 'manual'" class="exam-setup-count">
            {{ store.locales === 'zh' ? '题数' : 'N' }}
            <input v-model.number="countValue" type="number" min="1" max="50" step="1" />
          </label>
          <button class="exam-track-toggle" :class="{ on: examTrack }" @click="toggleExamTrack" :title="examTrackTitle">
            <i class="fa" :class="examTrack ? 'fa-link' : 'fa-unlink'"></i>
            {{ store.locales === 'zh' ? '计入学习' : 'Track' }}
          </button>
        </div>
        <div v-if="examQuestions.length && !examGenerating" class="exam-ready">
          <span><i class="fa fa-check-circle"></i> {{ store.locales === 'zh' ? `已生成 ${examQuestions.length} 题` : `${examQuestions.length} question(s) ready` }}</span>
          <button class="exam-tool-btn primary" @click="startExam"><i class="fa fa-play"></i> {{ store.locales === 'zh' ? '开始答题' : 'Start exam' }}</button>
          <button class="exam-tool-btn ghost" @click="resetExam"><i class="fa fa-rotate-left"></i> {{ store.locales === 'zh' ? '重新出题' : 'Regenerate' }}</button>
        </div>
        <div class="exam-inline-row">
          <span class="exam-inline-label">{{ store.locales === 'zh' ? '出题方式' : 'Source' }}</span>
          <div class="exam-mode-grid">
            <button class="exam-mode-card" :class="{ on: examMode === 'random' }" @click="examMode = 'random'">
              <i class="fa fa-random"></i>
              <b>{{ store.locales === 'zh' ? '随机切片' : 'Random' }}</b>
              <span>{{ store.locales === 'zh' ? '随机采样' : 'Sample' }}</span>
            </button>
            <button class="exam-mode-card" :class="{ on: examMode === 'select' }" @click="examMode = 'select'; examSelectOpen = true">
              <i class="fa fa-list-ul"></i>
              <b>{{ store.locales === 'zh' ? '自选切片' : 'Select' }}</b>
              <span>{{ store.locales === 'zh' ? '按文件/切片' : 'Files/slices' }}</span>
            </button>
            <button class="exam-mode-card" :class="{ on: examMode === 'manual' }" @click="examMode = 'manual'">
              <i class="fa fa-pencil"></i>
              <b>{{ store.locales === 'zh' ? '手动出题' : 'Manual' }}</b>
              <span>{{ store.locales === 'zh' ? '自己输入' : 'Write your own' }}</span>
            </button>
            <button class="exam-mode-card" :class="{ on: examMode === 'mimic' }" @click="examMode = 'mimic'; mimicPanelOpen = true">
              <i class="fa fa-clone"></i>
              <b>{{ store.locales === 'zh' ? '真题仿写' : 'Mimic' }}</b>
              <span>{{ store.locales === 'zh' ? '按样卷风格' : 'Follow style' }}</span>
            </button>
          </div>
        </div>
        <div class="exam-inline-row">
          <span class="exam-inline-label">{{ store.locales === 'zh' ? '题型' : 'Types' }}</span>
          <div class="exam-type-chips">
            <button v-for="(t, key) in examTypes" :key="key" class="exam-type-chip" :class="{ on: t }" @click="toggleExamType(key)">
              <i class="fa" :class="examTypeIcon(key)"></i> {{ examTypeLabel(key) }}
            </button>
          </div>
        </div>
        <div class="exam-setup-row exam-setup-actions">
          <span class="exam-spacer"></span>
          <button v-if="examMode !== 'manual'" class="exam-tool-btn primary" :disabled="examGenerating" @click="examMode === 'mimic' ? generateMimicQuestions() : generateExamQuestions()">
            <i class="fa" :class="examGenerating ? 'fa-spinner fa-spin' : 'fa-magic'"></i>
            {{ examGenerating ? (store.locales === 'zh' ? '生成中…' : 'Generating…') : (store.locales === 'zh' ? '生成试卷' : 'Generate exam') }}
          </button>
        </div>
        <div v-if="examMode === 'manual'" class="exam-setup-hint">
          {{ store.locales === 'zh' ? '在下方编辑器添加题目；添加第一题后自动进入答题。' : 'Add questions in the editor below; the first one starts the exam.' }}
        </div>

        <!-- 自选切片：设置卡下方的 grid 卡片，不再使用左侧列表 -->
        <div v-if="examMode === 'select'" class="exam-slice-grid-wrap">
          <div class="exam-slice-grid-toolbar">
            <div class="exam-seg">
              <button class="exam-mode-btn" :class="{ active: examSelKind === 'file' }" @click="examSelKind = 'file'"><i class="fa fa-file-text-o"></i> {{ store.locales === 'zh' ? '按文件' : 'Files' }}</button>
              <button class="exam-mode-btn" :class="{ active: examSelKind === 'slice' }" @click="examSelKind = 'slice'"><i class="fa fa-th-large"></i> {{ store.locales === 'zh' ? '按切片' : 'Slices' }}</button>
            </div>
            <input v-if="examSelKind === 'file'" v-model="examFileKeyword" class="exam-slice-grid-search" :placeholder="store.locales === 'zh' ? '搜索文件…' : 'Search files…'" />
            <input v-else v-model="examSliceKeyword" class="exam-slice-grid-search" :placeholder="store.locales === 'zh' ? '搜索切片…' : 'Search slices…'" />
            <span class="exam-spacer"></span>
            <span class="exam-slice-grid-count">{{ examSelectedSliceIdx.length }} {{ store.locales === 'zh' ? '已选' : 'selected' }}</span>
            <button class="exam-tool-btn ghost" @click="selectAllExamSlices">{{ store.locales === 'zh' ? '全选' : 'All' }}</button>
            <button class="exam-tool-btn ghost" @click="clearExamSliceSelection">{{ store.locales === 'zh' ? '清空' : 'Clear' }}</button>
          </div>
          <div v-if="examSelKind === 'file'" class="exam-slice-grid scoll">
            <button v-for="f in examFilteredFiles" :key="f.key" class="exam-slice-card" :class="{ on: isExamFileAllSelected(f), part: isExamFilePartSelected(f) }" @click="toggleExamFile(f)" :title="f.label">
              <i class="exam-slice-card-check fa" :class="isExamFileAllSelected(f) ? 'fa-check-square-o' : (isExamFilePartSelected(f) ? 'fa-minus-square-o' : 'fa-square-o')"></i>
              <i class="exam-slice-card-file fa" :class="store.icon(f.extension) || 'fa-file-text-o'"></i>
              <span class="exam-slice-card-name">{{ f.label }}</span>
              <span class="exam-slice-card-meta">{{ f.idxs.filter(i => examSelectedSliceIdx.includes(i)).length }}/{{ f.count }} {{ store.locales === 'zh' ? '切片' : 'slices' }}</span>
            </button>
            <div v-if="examFilteredFiles.length === 0" class="exam-select-empty">{{ store.locales === 'zh' ? '无可用文件' : 'No files' }}</div>
          </div>
          <div v-else class="exam-slice-grid scoll">
            <button v-for="f in examFilteredSlices" :key="f.idx" class="exam-slice-card slice" :class="{ on: examSelectedSliceIdx.includes(f.idx) }" @click="toggleExamSlice(f.idx)">
              <i class="exam-slice-card-check fa" :class="examSelectedSliceIdx.includes(f.idx) ? 'fa-check-square-o' : 'fa-square-o'"></i>
              <span class="exam-slice-card-name">{{ f.block.label }}</span>
              <span class="exam-slice-card-preview">{{ String(f.block.A).trim().slice(0, 70) }}</span>
            </button>
            <div v-if="examFilteredSlices.length === 0" class="exam-select-empty">{{ store.locales === 'zh' ? '无可用切片（请先切片入库）' : 'No usable slices' }}</div>
          </div>
        </div>
      </div>

      <!-- 手动出题编辑器 -->
      <div v-if="examMode==='manual'" class="exam-editor">
        <div class="exam-flex">
          <span class="exam-editor-title"><i class="fa fa-pencil"></i> {{ store.locales=='zh'?'手动添加题目':'Manual add' }}</span>
          <select v-model="examDraft.type" class="exam-editor-select">
            <option v-for="(t, key) in examTypeLabels" :key="key" :value="key">{{ store.locales=='zh' ? t.zh : t.en }}</option>
          </select>
          <template v-if="examDraft.type==='single' || examDraft.type==='multi'">
            <div class="button exam-btn-mt" @click="examDraft.options.push('')"><i class="fa fa-plus"></i> {{ store.locales=='zh'?'添加选项':'Add option' }}</div>
          </template>
          <div class="button exam-btn-mt6" @click="addManualExamQuestion"><i class="fa fa-plus"></i> {{ store.locales=='zh'?'添加到试卷':'Add to paper' }}</div>
          <span v-if="examDraft.type==='single' || examDraft.type==='multi'" class="exam-hint">
            {{ store.locales=='zh' ? (examDraft.type==='single' ? '选项（点击 ○ 标记唯一正确答案）' : '选项（点击 □ 标记所有正确答案）') : 'Options (click to mark correct)' }}
          </span>
        </div>
        <textarea v-model="examDraft.prompt" class="scoll exam-textarea" :placeholder="store.locales=='zh'?'输入题干…':'Enter question stem…'"></textarea>

        <!-- 选择题选项编辑 -->
        <div v-if="examDraft.type==='single' || examDraft.type==='multi'" class="exam-section">
          <div v-for="(o, oi) in examDraft.options" :key="oi" class="exam-opt-row">
            <i class="fa exam-opt-correct" :class="examDraft.type==='single' ? (examDraft.optionCorrect.includes(oi) ? 'fa-dot-circle-o' : 'fa-circle-o') : (examDraft.optionCorrect.includes(oi) ? 'fa-check-square-o' : 'fa-square-o')"
               @click="toggleManualOptionCorrect(oi)"></i>
            <span class="exam-opt-prefix">{{ String.fromCharCode(65+oi) }}.</span>
            <input v-model="examDraft.options[oi]" type="text" class="exam-opt-input" :placeholder="store.locales=='zh' ? ('选项 ' + (oi+1)) : 'Option ' + (oi+1)" />
            <i v-if="examDraft.options.length > 2" class="fa exam-opt-remove" @click="examDraft.options.splice(oi,1)"></i>
          </div>
        </div>

        <!-- 判断题正确值 -->
        <div v-if="examDraft.type==='judge'" class="exam-judge-row">
          <span class="exam-dim">{{ store.locales=='zh'?'正确值':'Correct value' }}:</span>
          <div class="exam-mode-btn" :class="{active: examDraft.judgeAnswer===true}" @click="examDraft.judgeAnswer=true"><i class="fa fa-check"></i> {{ store.locales=='zh'?'正确':'True' }}</div>
          <div class="exam-mode-btn" :class="{active: examDraft.judgeAnswer===false}" @click="examDraft.judgeAnswer=false"><i class="fa fa-times"></i> {{ store.locales=='zh'?'错误':'False' }}</div>
        </div>

        <!-- 问答题参考答案 -->
        <textarea v-if="examDraft.type==='essay'" v-model="examDraft.essayRef" class="scoll exam-textarea" :placeholder="store.locales=='zh'?'参考答案（判分依据）…':'Reference answer…'"></textarea>
      </div>

      <!-- 答题区 -->
      <div v-if="examPhase !== 'setup'" class="scoll exam-answer-area">
        <!-- 题号导航 -->
        <div v-if="showNavigator" class="exam-nav-grid">
          <button v-for="(q, qi) in examQuestions" :key="'nav-' + q.id" class="exam-nav-btn"
            :class="{ answered: hasAnswer(q), flagged: flaggedIds.includes(q.id), wrong: q.result && q.result.correct === false }"
            @click="scrollToQuestion(q.id)" :title="q.prompt">
            {{ qi + 1 }}
          </button>
        </div>

        <!-- 结果阶段：结果页替代弹窗 -->
        <div v-if="examPhase === 'result' && examSummary" class="exam-result-page">
          <div class="exam-result-score">
            <span class="exam-result-avg">{{ examSummary.avg.toFixed(1) }}</span>
            <span class="exam-result-unit">{{ store.locales === 'zh' ? '分' : 'pts' }}</span>
          </div>
          <div class="exam-result-main">
            <div class="exam-result-row">
              <span>{{ store.locales === 'zh' ? '正确率' : 'Accuracy' }}</span>
              <b>{{ (examSummary.rate * 100).toFixed(0) }}%</b>
              <span>{{ store.locales === 'zh' ? '答对' : 'Correct' }}</span>
              <b>{{ examSummary.correctCount }}/{{ examSummary.count }}</b>
              <span><i class="fa fa-clock-o"></i> {{ timerText }}</span>
            </div>
            <div class="exam-result-types">
              <span v-for="r in typeBreakdown" :key="r.type">{{ examTypeLabel(r.type) }} {{ r.correct }}/{{ r.total }}</span>
              <span v-if="wrongQuestions.length" class="exam-result-wrong">✕ {{ wrongQuestions.length }} {{ store.locales === 'zh' ? '错题' : 'wrong' }}</span>
            </div>
            <div class="exam-result-actions">
              <button v-if="wrongQuestions.length" class="exam-tool-btn ghost" @click="scrollToQuestion(wrongQuestions[0].id)"><i class="fa fa-exclamation-circle"></i> {{ store.locales === 'zh' ? '查看错题' : 'View wrong' }}</button>
              <button class="exam-tool-btn ghost" @click="resetExamGrading"><i class="fa fa-undo"></i> {{ store.locales === 'zh' ? '重新作答' : 'Retry' }}</button>
              <button class="exam-tool-btn ghost" @click="resetExam"><i class="fa fa-plus"></i> {{ store.locales === 'zh' ? '新试卷' : 'New exam' }}</button>
              <button class="exam-tool-btn ghost" @click="exportExamExcel"><i class="fa fa-file-excel-o"></i> {{ store.locales === 'zh' ? '导出成绩' : 'Export' }}</button>
            </div>
          </div>
        </div>

        <div v-if="examQuestions.length===0" class="exam-empty">
          <i class="fa fa-graduation-cap exam-empty-icon"></i>
          {{ store.locales=='zh' ? '暂无题目。选择出题方式后点「生成题目」，或切到「手动输入」添加题目。' : 'No questions yet. Generate from slices or add manually.' }}
        </div>
        <div v-for="(q, qi) in examQuestions" :key="q.id" class="exam-q-card" :id="'exam-q-' + q.id">
          <div class="exam-flex">
            <span class="exam-q-index">{{ qi + 1 }}.</span>
            <span class="exam-type-badge" :class="q.type">{{ examTypeLabel(q.type) }}</span>
            <span v-if="q.result" class="exam-result-badge" :class="q.result.correct===true ? 'ok' : (q.result.correct===false ? 'no' : 'na')">
              <i class="fa" :class="q.result.correct===true ? 'fa-check' : (q.result.correct===false ? 'fa-times' : 'fa-question')"></i>
              {{ q.result.score }}
            </span>
            <span v-if="q.sourceSlices.length" class="exam-q-src">{{ store.locales=='zh'?'依据':'Src' }}: {{ q.sourceSlices[0].label }}</span>
            <span class="exam-src-toggle" @click="q._showSrc = !q._showSrc">
              <i class="fa" :class="q._showSrc ? 'fa-caret-down' : 'fa-caret-right'"></i> {{ store.locales=='zh'?'查看依据切片':'View source slices' }} ({{ q.sourceSlices.length }})
            </span>
            <span v-if="q.result && q.type !== 'essay'" class="exam-explain-link" @click="explainOneQuestion(q)">
              <i class="fa" :class="q._explaining ? 'fa-spinner fa-spin' : 'fa-commenting-o'"></i> {{ store.locales=='zh'?'生成解析':'Explain' }}
            </span>
            <span class="exam-explain-link" @click="emit('ask', q.prompt)"><i class="fa fa-comments-o"></i> {{ store.locales=='zh'?'问一下':'Ask' }}</span>
            <button class="exam-flag-btn" :class="{ on: flaggedIds.includes(q.id) }" @click="toggleFlag(q)" :title="store.locales === 'zh' ? '标记此题' : 'Flag question'">
              <i class="fa" :class="flaggedIds.includes(q.id) ? 'fa-flag' : 'fa-flag-o'"></i>
            </button>
          </div>
          <div class="exam-q-prompt learn-md"><block_md :content="q.prompt" :fontSize="'13px'" /></div>

          <!-- 选择题选项（左侧选项框含字母，答案文本在框外） -->
          <div v-if="q.type==='single' || q.type==='multi'">
            <div v-for="(o, oi) in q.options" :key="oi" class="exam-option"
                 :class="{ selected: q.userOption.includes(oi), correct: q.result && q.correctOption.includes(oi), wrong: q.result && q.userOption.includes(oi) && !q.correctOption.includes(oi) }"
                 @click="toggleUserOption(q, oi)">
              <span class="exam-opt-box" :class="q.type">
                <span class="exam-opt-letter">{{ String.fromCharCode(65 + oi) }}</span>
              </span>
              <div class="exam-q-option-text learn-md"><block_md :content="o" :fontSize="'13px'" /></div>
              <i v-if="q.result && q.correctOption.includes(oi)" class="fa exam-opt-flag"
                 :class="q.userOption.includes(oi) ? 'ok fa-check' : 'miss fa-check-circle-o'"
                 :title="q.userOption.includes(oi) ? (store.locales=='zh'?'答对':'Correct') : (store.locales=='zh'?'漏选':'Missed')"></i>
              <i v-else-if="q.result && q.userOption.includes(oi)" class="fa exam-opt-flag bad fa-times"
                 :title="store.locales=='zh'?'多选/选错':'Wrong pick'"></i>
            </div>
          </div>

          <!-- 判断题 -->
          <div v-if="q.type==='judge'" class="exam-q-judge">
            <div class="exam-option" :class="{ selected: q.userJudge===true }" @click="setUserJudge(q, true)"><i class="fa" :class="q.userJudge===true?'fa-check-circle-o':'fa-circle-o'"></i> {{ store.locales=='zh'?'正确':'True' }}</div>
            <div class="exam-option" :class="{ selected: q.userJudge===false }" @click="setUserJudge(q, false)"><i class="fa" :class="q.userJudge===false?'fa-times-circle-o':'fa-circle-o'"></i> {{ store.locales=='zh'?'错误':'False' }}</div>
          </div>

          <!-- 问答题 -->
          <textarea v-if="q.type==='essay'" v-model="q.userEssay" class="scoll exam-answer-textarea" :placeholder="store.locales=='zh'?'输入你的答案…':'Your answer…'" :disabled="!!q.result"></textarea>

          <!-- 依据切片（折叠查看：仅展开查看时渲染该区域） -->
          <div v-if="q._showSrc && q.sourceSlices.length" class="exam-section">
            <div class="exam-src-box">
              <block_md v-for="(s, si) in q.sourceSlices" :key="si" :content="s.content" :fontSize="'10px'" :maxHeight="'150px'" />
            </div>
          </div>

          <!-- 判分结果 -->
          <div v-if="q.result" class="exam-result-box">
            <div v-if="q.result.comment" class="exam-result-comment learn-md"><block_md :content="(store.locales=='zh'?'解析：':'Comment: ') + q.result.comment" :fontSize="'12px'" /></div>
            <div v-if="q.result.reference" class="exam-result-ref learn-md"><block_md :content="(store.locales=='zh'?'参考答案：':'Reference: ') + q.result.reference" :fontSize="'12px'" /></div>
          </div>
        </div>
      </div>

      <!-- 考试结果弹窗（判分汇总） -->
      <div v-if="examGraded && examSummary && examSummaryOpen" class="exam-modal-overlay" @click.self="examSummaryOpen = false">
        <div class="exam-modal-content">
          <div class="exam-modal-header">
            <span><i class="fa fa-bar-chart"></i> {{ store.locales=='zh'?'考试结果':'Exam Result' }}</span>
            <button class="exam-modal-close" @click="examSummaryOpen = false" :title="store.locales=='zh'?'关闭':'Close'"><i class="fa fa-times"></i></button>
          </div>
          <div class="exam-modal-body">
            <div class="exam-summary-grid">
              <div class="exam-summary-cell">
                <span class="exam-summary-label">{{ store.locales=='zh'?'平均得分':'Avg score' }}</span>
                <span class="exam-summary-avg" :style="{color: (examSummary.avg>=60?'#4CAF50':'#f44336')}">{{ examSummary.avg.toFixed(1) }}</span>
              </div>
              <div class="exam-summary-cell">
                <span class="exam-summary-label">{{ store.locales=='zh'?'正确率':'Accuracy' }}</span>
                <span class="exam-summary-rate" :style="{color: (examSummary.rate>=0.6?'#4CAF50':'#f44336')}">{{ (examSummary.rate*100).toFixed(0) }}%</span>
              </div>
              <div class="exam-summary-cell">
                <span class="exam-summary-label">{{ store.locales=='zh'?'答对':'Correct' }}</span>
                <span class="exam-summary-count">{{ examSummary.correctCount }}/{{ examSummary.count }}</span>
              </div>
            </div>
            <div class="exam-modal-list">
              <div v-for="(q, qi) in examQuestions" :key="q.id" class="exam-modal-item">
                <span class="exam-modal-item-idx">{{ qi + 1 }}.</span>
                <span class="exam-modal-item-badge" :class="q.result ? (q.result.correct===true ? 'ok' : (q.result.correct===false ? 'no' : 'na')) : ''">
                  <i class="fa" :class="q.result ? (q.result.correct===true ? 'fa-check' : (q.result.correct===false ? 'fa-times' : 'fa-question')) : 'fa-circle-o'"></i>
                </span>
                <span class="exam-modal-item-prompt" :title="q.prompt">{{ q.prompt }}</span>
                <span class="exam-modal-item-score">{{ q.result ? q.result.score : '-' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>

    <!-- 试卷库：管理 <库名>.exams.json 中的试卷 -->
    <div v-if="paperLibraryOpen" class="exam-paper-backdrop" @click.self="paperLibraryOpen = false">
      <div class="exam-paper-modal">
        <div class="exam-paper-head">
          <span><i class="fa fa-folder-open-o"></i> {{ store.locales === 'zh' ? '试卷库' : 'Paper library' }}</span>
          <span v-if="paperKbName" class="exam-paper-kb">{{ paperKbName }}.exams.json</span>
          <button class="exam-tool-btn ghost" @click="paperLibraryOpen = false"><i class="fa fa-times"></i></button>
        </div>
        <div class="exam-paper-toolbar">
          <button class="exam-tool-btn primary" :disabled="paperSaving || !examQuestions.length" @click="saveCurrentPaper">
            <i class="fa" :class="paperSaving ? 'fa-spinner fa-spin' : 'fa-save'"></i>
            {{ store.locales === 'zh' ? '保存当前试卷' : 'Save current paper' }}
          </button>
          <span class="exam-paper-msg">{{ paperMsg }}</span>
          <span class="exam-spacer"></span>
          <button class="exam-tool-btn ghost" @click="loadPaperLibrary" :disabled="paperLoading"><i class="fa fa-refresh" :class="{ 'fa-spin': paperLoading }"></i></button>
        </div>
        <div class="exam-paper-list scoll">
          <div v-if="!papers.length" class="exam-paper-empty">
            <i class="fa fa-folder-open-o"></i>
            <span>{{ paperFilePath ? (store.locales === 'zh' ? '还没有保存的试卷' : 'No saved papers') : (store.locales === 'zh' ? '自动知识库请先保存为 .kb' : 'Save the auto KB as .kb first') }}</span>
          </div>
          <div v-for="p in papers" :key="p.id" class="exam-paper-row" :class="{ current: currentPaperId === p.id }">
            <div class="exam-paper-main">
              <b :title="p.title">{{ p.title }}</b>
              <span>{{ p.questions.length }} {{ store.locales === 'zh' ? '题' : 'questions' }} · {{ p.graded ? (store.locales === 'zh' ? '已判分' : 'graded') : (store.locales === 'zh' ? '未判分' : 'ungraded') }} · {{ paperTime(p.updatedAt) }}</span>
            </div>
            <div class="exam-paper-actions">
              <button class="exam-tool-btn ghost" @click="openPaper(p)">{{ store.locales === 'zh' ? '打开' : 'Open' }}</button>
              <button class="exam-tool-btn ghost" @click="renamePaper(p)">{{ store.locales === 'zh' ? '重命名' : 'Rename' }}</button>
              <button class="exam-tool-btn ghost" @click="copyPaper(p)">{{ store.locales === 'zh' ? '复制' : 'Copy' }}</button>
              <button class="exam-tool-btn ghost" @click="exportPaperWord(p)"><i class="fa fa-file-word-o"></i> Word</button>
              <button class="exam-tool-btn ghost danger" @click="deletePaper(p)"><i class="fa fa-trash-o"></i></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 考试管理器容器 ===== */
.exam-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
}
/* 工具栏右侧按钮紧凑化：去掉上下 margin、高度压小，避免把标签栏撑高 */
.exam-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  flex-shrink: 0;
  overflow: visible;
  border-bottom: 1px solid var(--borderColor);
  padding: 0 5px;
  min-height: 30px;
}
.exam-toolbar .button {
  margin: 0 0 0 5px;
  height: 22px;
  padding: 0 7px;
  line-height: 22px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* 工具栏内输入框/选择框同样压到 22px，避免把标签栏撑高 */
.exam-toolbar input,
.exam-toolbar select {
  height: 22px !important;
  box-sizing: border-box;
  padding: 0 4px;
  font-size: 12px;
}

.scoll { overflow: auto; }

.button {
  background-color: var(--backgroundColor);
}
.button:hover {
  background-color: var(--menuColor);
}
.button.active {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  background-color: color-mix(in srgb, var(--fontActiveColor) 16%, var(--backgroundColor));
}
.button.active:hover {
  background-color: color-mix(in srgb, var(--fontActiveColor) 22%, var(--backgroundColor));
}

/* ===== 考试标签页通用布局与元素 ===== */
.exam-main { flex: 1; border-radius: 5px; display: flex; flex-direction: row; overflow: hidden; min-height: 0; }
.exam-body { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.exam-flex { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.exam-spacer { flex: 1; }
.exam-dim { font-size: 11px; color: var(--borderColor); }
.exam-name { flex-shrink: 0; font-weight: bold; color: var(--fontActiveColor); font-size: 11px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exam-name-sm { max-width: 100px; }
.exam-icon-check { flex-shrink: 0; color: var(--fontActiveColor); }
.exam-icon-file { flex-shrink: 0; color: var(--fontActiveColor); font-size: 12px; }
.exam-count { flex-shrink: 0; font-size: 10px; color: var(--borderColor); }
.exam-sel-num { flex-shrink: 0; font-size: 10px; }
.exam-mode-btn {
  padding: 3px 10px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fontColor);
  transition: all .15s;
  user-select: none;
}
.exam-mode-btn:hover { background-color: rgba(33, 150, 243, .12); }
.exam-mode-btn.active { background-color: var(--backgroundColor); color: var(--fontActiveColor); }

/* 自选面板内部 */
.exam-select-panel {
  flex-shrink: 0;
  width: 260px;
  max-width: 80%;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  border-right: 1px solid var(--borderColor);
  box-shadow: 2px 0 12px rgba(0, 0, 0, .18);
  overflow: hidden;
  margin-right: 6px;
}
.exam-select-toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 5px; border-bottom: 1px solid var(--borderColor); flex-wrap: wrap; }
.exam-seg { display: flex; gap: 2px; align-items: center; background: var(--menuColor); border-radius: 4px; padding: 2px; }
.exam-select-search { display: flex; align-items: center; padding: 5px; border-bottom: 1px solid var(--borderColor); }
.exam-select-search-input {
  box-sizing: border-box;
  width: 100%;
  height: 22px;
  margin: 0;
  padding: 0 6px;
  font-size: 11px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  outline: none;
}
.exam-select-list { flex: 1; overflow-y: auto; padding: 4px; }
.exam-select-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--fontColor);
  border-top: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.exam-select-empty { padding: 20px 10px; text-align: center; color: var(--borderColor); font-size: 11px; }
/* ===== 真题仿写面板（mimic） ===== */
.exam-mimic-hint { font-size: 11px; line-height: 1.6; color: var(--borderColor); padding: 2px 4px 6px; }
.exam-mimic-src {
  width: 100%; min-height: 130px; max-height: calc(40vh / var(--ui-zoom, 1)); resize: vertical; box-sizing: border-box;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; line-height: 1.5;
  border: 1px solid var(--borderColor); border-radius: 4px; padding: 4px 6px;
}
.exam-mimic-file { font-size: 10px; color: var(--borderColor); padding: 3px 2px; word-break: break-all; }
.exam-mimic-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 5px;
  cursor: pointer; font-size: 12px; padding: 5px 8px; margin: 2px 0; border-radius: 4px;
  border: 1px solid var(--fontActiveColor); color: var(--fontActiveColor); background: var(--backgroundColor);
}
.exam-mimic-btn:hover { background: rgba(33, 150, 243, .12); }
.exam-mimic-btn:disabled { opacity: .6; cursor: default; }
.exam-mimic-btn.ghost { border-color: var(--borderColor); color: var(--fontColor); }
.exam-mimic-actions { display: flex; gap: 4px; }
.exam-mimic-sum { font-size: 11px; line-height: 1.6; color: var(--fontColor); padding: 6px; margin-top: 4px; border: 1px dashed var(--borderColor); border-radius: 4px; }
.exam-mimic-json {
  font-size: 10px; line-height: 1.5; white-space: pre-wrap; word-break: break-all;
  max-height: calc(30vh / var(--ui-zoom, 1)); overflow: auto; margin: 4px 0 0; padding: 6px;
  background: var(--menuColor); color: var(--fontColor); border-radius: 4px;
}
.exam-panel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 11px;
  border-radius: 3px;
  opacity: .65;
  transition: all .15s;
}
.exam-panel-btn:hover { opacity: 1; background: var(--backgroundColor); color: var(--fontActiveColor); }
.exam-slice-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  cursor: pointer;
  font-size: 11px;
  border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 40%, transparent);
}
.exam-slice-item:hover { background-color: rgba(33, 150, 243, .08); }
.exam-slice-item.on { background-color: rgba(76, 175, 80, .12); }
.exam-slice-item.part { background-color: rgba(255, 152, 0, .12); }
.exam-slice-preview { flex: 1; font-size: 11px; color: var(--borderColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 手动出题编辑器 */
.exam-editor { flex-shrink: 0; border: 1px solid var(--borderColor); border-radius: 4px; margin: 5px; padding: 5px; }
.exam-editor-title { font-size: 11px; font-weight: bold; }
.exam-editor-select { height: 22px; box-sizing: border-box; font-size: 11px; padding: 0 4px; margin: 0px; width: auto; flex-shrink: 0;}
.exam-textarea { width: calc(100% - 4px); margin-top: 4px; min-height: 42px; font-size: 12px; padding: 4px; box-sizing: border-box; }
.exam-section { margin-top: 0px; }
.exam-hint { font-size: 11px; color: var(--borderColor); margin-bottom: 2px; margin-left: auto; white-space: nowrap; }
.exam-opt-row { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.exam-opt-correct { color: #4CAF50; cursor: pointer; }
.exam-opt-prefix { font-size: 11px; width: 16px; }
.exam-opt-input { flex: 1; height: 24px; font-size: 11px; padding: 0 4px; margin: 0px }
.exam-opt-remove { cursor: pointer; color: var(--borderColor); }
.exam-judge-row { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
.exam-btn-mt { margin-top: 4px; display: inline-flex; align-items: center; padding: 2px 8px; font-size: 11px; margin:0px; height: 22px; box-sizing: border-box;}
.exam-btn-mt6 { display: inline-flex; align-items: center; margin: 0px; font-size: 11px; padding: 2px 8px; height: 22px; box-sizing: border-box; }

/* 答题区 */
.exam-answer-area { flex: 1; overflow: auto; padding: 5px; min-height: 0; }
.exam-empty { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--borderColor); }
.exam-empty-icon { font-size: 32px; display: block; margin-bottom: 8px; }
.exam-q-card { border: 1px solid var(--borderColor); border-radius: 5px; padding: 5px; margin-bottom: 5px; background: var(--backgroundColor); }
.exam-q-index { font-weight: bold; font-size: 12px; }
.exam-q-src { font-size: 10px; color: var(--borderColor); }
.exam-q-prompt { font-size: 13px; margin-top: 4px; word-break: break-word; }
.exam-q-option-text { font-size: 12px; }
.exam-q-judge { margin-top: 6px; display: flex; gap: 8px; }
.exam-answer-textarea { width: calc(100% - 4px); margin-top: 6px; min-height: 56px; font-size: 12px; padding: 4px; box-sizing: border-box; }
.exam-type-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; color: #fff; }
.exam-type-badge.single { background: #2196F3; }
.exam-type-badge.multi { background: #9C27B0; }
.exam-type-badge.judge { background: #FF9800; }
.exam-type-badge.essay { background: #4CAF50; }
.exam-result-badge { font-size: 11px; font-weight: bold; padding: 1px 6px; border-radius: 3px; }
.exam-result-badge.ok { background: rgba(76, 175, 80, .15); color: #4CAF50; }
.exam-result-badge.no { background: rgba(244, 67, 54, .15); color: #f44336; }
.exam-result-badge.na { background: rgba(255, 152, 0, .15); color: #FF9800; }
.exam-option {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  margin: 3px 6px 3px 0;
  border-radius: 4px;
  border: 1px solid var(--borderColor);
  cursor: pointer;
  font-size: 12px;
  background: var(--backgroundColor);
  user-select: none;
}
.exam-option:hover { border-color: var(--fontActiveColor); }
/* 判分后配色通道分离：
   - 蓝色 = 你已选（.selected 最后声明，保证不被绿色/红色吞掉，始终可见）
   - 绿色 ✓ = 正确答案（含你漏选的项）
   - 红色 ✗ = 你多选/选错 */
.exam-option.correct { border-color: #4CAF50; background: rgba(76, 175, 80, .10); }
.exam-option.wrong { border-color: #f44336; background: rgba(244, 67, 54, .08); }
.exam-option.selected { border-color: #2196F3; background: rgba(33, 150, 243, .10); }
/* 选项框：单选圆形 / 多选方形，字母序号在框内，答案文本在框外 */
.exam-opt-box {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border: 1.5px solid var(--borderColor);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all .15s;
}
.exam-opt-box.single { border-radius: 50%; }
.exam-opt-box.multi { border-radius: 4px; }
.exam-opt-letter { font-size: 11px; font-weight: 600; color: var(--borderColor); }
/* 未选中的正确项：绿色框 + 绿色字母 */
.exam-option.correct .exam-opt-box { border-color: #4CAF50; background: rgba(76, 175, 80, .15); }
.exam-option.correct .exam-opt-letter { color: #4CAF50; }
/* 选错的项：红色框 + 红色字母 */
.exam-option.wrong .exam-opt-box { border-color: #f44336; background: rgba(244, 67, 54, .15); }
.exam-option.wrong .exam-opt-letter { color: #f44336; }
/* 你已选：蓝色框 + 蓝色字母（最后声明，叠加对错时仍显示选中态） */
.exam-option.selected .exam-opt-box { border-color: #2196F3; background: rgba(33, 150, 243, .15); }
.exam-option.selected .exam-opt-letter { color: #2196F3; }
/* 判分状态图标：✓ 正确 / ✗ 选错，独立于选中态显示 */
.exam-opt-flag { margin-left: 4px; font-size: 12px; flex-shrink: 0; }
.exam-opt-flag.ok { color: #4CAF50; }
.exam-opt-flag.miss { color: #4CAF50; opacity: .8; }
.exam-opt-flag.bad { color: #f44336; }
.exam-src-toggle { font-size: 10px; color: var(--borderColor); cursor: pointer; }
.exam-src-box { border: 1px solid var(--borderColor); border-radius: 4px; padding: 6px; margin-top: 4px; background: var(--menuColor); }
.exam-result-box { margin-top: 6px; border-top: 1px dashed var(--borderColor); padding-top: 6px; }
.exam-result-comment { font-size: 12px; margin-top: 3px; color: var(--fontColor); }
.exam-result-ref { font-size: 12px; margin-top: 3px; color: #2196F3; }
.exam-explain-link { margin-left: auto; cursor: pointer; font-size: 11px; color: #2196F3; white-space: nowrap; }
.exam-explain-link:hover { text-decoration: underline; }

/* 考试结果弹窗（判分汇总） */
.exam-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}
.exam-modal-content {
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  width: 460px;
  max-width: calc(90vw / var(--ui-zoom, 1));
  max-height: calc(80vh / var(--ui-zoom, 1));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  animation: examModalSlideIn 0.3s ease;
}
@keyframes examModalSlideIn {
  from { opacity: 0; transform: translateY(-20px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.exam-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 13px;
  font-weight: 600;
  color: var(--fontColor);
  background: var(--menuColor);
  user-select: none;
}
.exam-modal-close {
  border: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 14px;
  cursor: pointer;
  padding: 0 6px;
  opacity: 0.6;
  border-radius: 3px;
}
.exam-modal-close:hover { opacity: 1; background: var(--backgroundColor); color: var(--fontActiveColor); }
.exam-modal-body {
  padding: 12px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.exam-summary-grid {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.exam-summary-cell {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--menuColor);
}
.exam-summary-label { font-size: 11px; color: var(--borderColor); }
.exam-summary-avg { font-size: 24px; font-weight: bold; }
.exam-summary-rate { font-size: 18px; font-weight: bold; }
.exam-summary-count { font-size: 14px; font-weight: bold; color: var(--fontColor); }
.exam-modal-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: calc(40vh / var(--ui-zoom, 1));
  overflow-y: auto;
}
.exam-modal-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 4px;
  background: var(--menuColor);
  border: 1px solid transparent;
}
.exam-modal-item:hover { border-color: var(--borderColor); }
.exam-modal-item-idx { flex-shrink: 0; font-size: 11px; color: var(--borderColor); width: 20px; text-align: right; }
.exam-modal-item-badge { flex-shrink: 0; width: 18px; text-align: center; font-size: 12px; }
.exam-modal-item-badge.ok { color: #4CAF50; }
.exam-modal-item-badge.no { color: #f44336; }
.exam-modal-item-badge.na { color: #FF9800; }
.exam-modal-item-prompt {
  flex: 1;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fontColor);
}
.exam-modal-item-score {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: bold;
  color: #FF9800;
}
/* ===== 三阶段考试 UI ===== */
.exam-toolbar-v2 { min-height: 34px; flex-wrap: wrap; gap: 5px; padding: 4px 7px; }
.exam-phases { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.exam-phase { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px; border-radius: 11px; font-size: 10px; color: var(--fontColor); opacity: .5; }
.exam-phase b { width: 15px; height: 15px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; background: var(--borderColor); color: var(--backgroundColor); }
.exam-phase.on { opacity: 1; color: var(--fontActiveColor); background: var(--menuActiveColor); }
.exam-phase.on b { background: var(--fontActiveColor); color: var(--backgroundColor); }
.exam-phase.done { opacity: .8; }
.exam-phase-sep { font-size: 9px; opacity: .3; }
.exam-head-stat { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--fontColor); opacity: .65; white-space: nowrap; }
.exam-tool-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 26px; padding: 0 9px; border: 1px solid var(--borderColor); border-radius: 5px; background: var(--backgroundColor); color: var(--fontColor); font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
.exam-tool-btn:hover:not(:disabled) { background: var(--menuActiveColor); color: var(--fontActiveColor); }
.exam-tool-btn.primary { background: var(--fontActiveColor); border-color: var(--fontActiveColor); color: var(--backgroundColor); font-weight: 600; }
.exam-tool-btn.primary:hover:not(:disabled) { opacity: .9; }
.exam-tool-btn.ghost { background: transparent; }
.exam-tool-btn:disabled { opacity: .55; cursor: default; }
.exam-setup { flex: 0 1 auto; max-height: 100%; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; }
.exam-setup.has-grid { flex: 1; overflow: hidden; }
.exam-manager input, .exam-manager select { margin: 0; }
.exam-setup-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.exam-ready { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 8px 10px; border: 1px solid var(--fontActiveColor); border-radius: 8px; background: var(--menuActiveColor); font-size: 11px; color: var(--fontColor); }
.exam-ready > span { display: inline-flex; align-items: center; gap: 5px; }
.exam-ready .fa-check-circle { color: #3fb950; }
.exam-setup-title { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; color: var(--fontColor); }
.exam-setup-title .fa { color: var(--fontActiveColor); }
.exam-setup-sub { font-size: 9px; color: var(--fontColor); opacity: .5; }
.exam-inline-row { display: grid; grid-template-columns: 58px minmax(0, 1fr); align-items: center; gap: 6px; }
.exam-inline-label { font-size: 9px; color: var(--fontColor); opacity: .5; white-space: nowrap; }
.exam-setup-actions { padding-top: 0; border-top: 0; justify-content: flex-end; }
.exam-setup-title { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--fontColor); }
.exam-setup-title .fa { color: var(--fontActiveColor); }
.exam-setup-title span { font-size: 10px; font-weight: 400; opacity: .55; margin-left: 4px; }
.exam-setup-label { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; opacity: .5; margin-top: 2px; }
.exam-mode-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.exam-mode-card { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 9px 10px; border: 1px solid var(--borderColor); border-radius: 8px; background: var(--backgroundColor); color: var(--fontColor); text-align: left; cursor: pointer; }
.exam-mode-card i { font-size: 14px; color: var(--fontActiveColor); }
.exam-mode-card b { font-size: 11px; font-weight: 600; }
.exam-mode-card span { font-size: 9px; opacity: .55; line-height: 1.35; }
.exam-mode-card:hover { border-color: var(--fontActiveColor); }
.exam-mode-card.on { border-color: var(--fontActiveColor); background: var(--menuActiveColor); }
.exam-type-chips { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.exam-type-chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px; border: 1px solid var(--borderColor); border-radius: 13px; background: transparent; color: var(--fontColor); font-size: 10px; cursor: pointer; }
.exam-type-chip.on { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: var(--menuActiveColor); }
.exam-setup-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 4px; border-top: 1px solid var(--borderColor); }
.exam-setup-count { display: inline-flex; align-items: center; gap: 5px; padding: 0; font-size: 11px; color: var(--fontColor); }
.exam-setup-count input { width: 48px; height: 26px; box-sizing: border-box; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; text-align: center; }
.exam-track-toggle { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border: 1px solid var(--borderColor); border-radius: 5px; background: transparent; color: var(--fontColor); font-size: 10px; cursor: pointer; }
.exam-track-toggle.on { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: var(--menuActiveColor); }
.exam-setup-hint { font-size: 10px; color: var(--fontColor); opacity: .55; }
.exam-nav-grid { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; padding: 4px 0 8px; }
.exam-nav-btn { width: 24px; height: 24px; border: 1px solid var(--borderColor); border-radius: 5px; background: var(--backgroundColor); color: var(--fontColor); font-size: 10px; cursor: pointer; }
.exam-nav-btn.answered { border-color: #3fb950; color: #3fb950; }
.exam-nav-btn.flagged { box-shadow: inset 0 0 0 1px #d29922; }
.exam-nav-btn.wrong { border-color: #f56c6c; color: #f56c6c; }
.exam-flag-btn { margin-left: 2px; width: 22px; height: 22px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--fontColor); opacity: .5; cursor: pointer; }
.exam-flag-btn.on, .exam-flag-btn:hover { opacity: 1; color: #d29922; }
.exam-result-page { display: flex; align-items: stretch; gap: 14px; padding: 10px 12px; margin-bottom: 8px; border: 1px solid var(--borderColor); border-radius: 9px; background: var(--menuColor); }
.exam-result-score { display: flex; align-items: baseline; gap: 3px; flex-shrink: 0; }
.exam-result-avg { font-size: 34px; line-height: 1; font-weight: 700; color: var(--fontActiveColor); }
.exam-result-unit { font-size: 11px; opacity: .55; }
.exam-result-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.exam-result-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10px; color: var(--fontColor); opacity: .8; }
.exam-result-row b { color: var(--fontActiveColor); font-size: 11px; }
.exam-result-types { display: flex; gap: 8px; flex-wrap: wrap; font-size: 10px; color: var(--fontColor); opacity: .65; }
.exam-result-wrong { color: #f56c6c; opacity: 1; }
.exam-result-actions { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 2px; }
@media (max-width: 700px) {
  .exam-mode-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .exam-inline-row { grid-template-columns: 1fr; gap: 3px; }
  .exam-result-page { flex-direction: column; }
  .exam-phase { padding: 0 4px; }
  .exam-phase span { display: none; }
}
/* 自选切片：设置卡下方 grid 卡片 */
.exam-slice-grid-wrap { display: flex; flex-direction: column; gap: 6px; min-height: 0; flex: 1; padding-top: 6px; border-top: 1px solid var(--borderColor); }
.exam-slice-grid-toolbar { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.exam-slice-grid-search { flex: 1 1 150px; min-width: 100px; height: 26px; box-sizing: border-box; padding: 0 7px; border: 1px solid var(--borderColor); border-radius: 5px; background: var(--backgroundColor); color: var(--fontColor); font-size: 10px; outline: none; }
.exam-slice-grid-count { font-size: 10px; color: var(--fontActiveColor); white-space: nowrap; }
.exam-slice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; flex: 1; min-height: 0; max-height: none; overflow-y: auto; align-content: start; padding: 2px; }
.exam-slice-card { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-height: 62px; padding: 8px 9px; box-sizing: border-box; border: 1px solid var(--borderColor); border-radius: 7px; background: var(--backgroundColor); color: var(--fontColor); text-align: left; cursor: pointer; overflow: hidden; }
.exam-slice-card:hover { border-color: var(--fontActiveColor); }
.exam-slice-card.on { border-color: var(--fontActiveColor); background: var(--menuActiveColor); }
.exam-slice-card.part { border-style: dashed; }
.exam-slice-card-check { position: absolute; top: 6px; right: 6px; font-size: 11px; opacity: .6; }
.exam-slice-card.on .exam-slice-card-check { opacity: 1; color: var(--fontActiveColor); }
.exam-slice-card-file { font-size: 13px; color: var(--fontActiveColor); }
.exam-slice-card-name { font-size: 10px; font-weight: 600; max-width: calc(100% - 16px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exam-slice-card-meta { font-size: 9px; opacity: .55; }
.exam-slice-card-preview { font-size: 9px; line-height: 1.4; opacity: .55; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
/* 试卷库 */
.exam-paper-count { display: inline-flex; align-items: center; justify-content: center; min-width: 14px; height: 14px; padding: 0 4px; border-radius: 7px; background: var(--fontActiveColor); color: var(--backgroundColor); font-size: 9px; }
.exam-paper-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, .28); display: flex; align-items: center; justify-content: center; padding: 18px; box-sizing: border-box; }
.exam-paper-modal { width: min(680px, 100%); max-height: min(78vh, 620px); display: flex; flex-direction: column; border: 1px solid var(--borderColor); border-radius: 10px; background: var(--backgroundColor); box-shadow: 0 18px 50px rgba(0, 0, 0, .28); overflow: hidden; }
.exam-paper-head { display: flex; align-items: center; gap: 7px; padding: 9px 11px; border-bottom: 1px solid var(--borderColor); font-size: 12px; font-weight: 600; color: var(--fontColor); }
.exam-paper-head .fa { color: var(--fontActiveColor); }
.exam-paper-kb { font-size: 9px; font-weight: 400; opacity: .45; margin-left: 2px; }
.exam-paper-head .exam-tool-btn { margin-left: auto; border: 0; }
.exam-paper-toolbar { display: flex; align-items: center; gap: 6px; padding: 7px 11px; border-bottom: 1px solid var(--borderColor); flex-wrap: wrap; }
.exam-paper-msg { font-size: 9px; color: var(--fontColor); opacity: .55; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.exam-paper-list { flex: 1; min-height: 90px; overflow-y: auto; padding: 7px 11px 11px; }
.exam-paper-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 34px 10px; color: var(--borderColor); font-size: 11px; text-align: center; }
.exam-paper-empty .fa { font-size: 22px; }
.exam-paper-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid var(--borderColor); border-radius: 7px; margin-bottom: 6px; background: var(--backgroundColor); }
.exam-paper-row.current { border-color: var(--fontActiveColor); background: var(--menuActiveColor); }
.exam-paper-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.exam-paper-main b { font-size: 11px; color: var(--fontColor); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exam-paper-main span { font-size: 9px; color: var(--fontColor); opacity: .55; }
.exam-paper-actions { display: flex; gap: 2px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.exam-paper-actions .exam-tool-btn { height: 23px; padding: 0 5px; font-size: 9px; border-color: transparent; }
.exam-tool-btn.danger { color: #f56c6c; }
.exam-tool-btn.danger:hover { background: rgba(245, 108, 108, .1); color: #f56c6c; }
@media (max-width: 700px) {
  .exam-paper-row { align-items: flex-start; flex-direction: column; }
  .exam-paper-actions { width: 100%; justify-content: flex-start; }
  .exam-paper-msg { max-width: 100%; }
}
@media (max-width: 700px) {
  .exam-toolbar-v2 { padding: 4px 6px; gap: 4px; }
  .exam-phase { padding: 0 4px; }
  .exam-phase-label { display: none; }
  .exam-head-stat { display: none; }
  .exam-setup { padding: 6px; gap: 5px; }
  .exam-slice-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .exam-slice-grid-toolbar .exam-slice-grid-search { flex: 1 1 100%; }
  .exam-paper-backdrop { padding: 8px; }
  .exam-paper-modal { max-height: 88vh; }
}
@media (max-width: 460px) {
  .exam-mode-grid { grid-template-columns: 1fr; }
  .exam-inline-row { grid-template-columns: 1fr; }
  .exam-tool-btn { height: 25px; padding: 0 7px; font-size: 10px; }
}
</style>
