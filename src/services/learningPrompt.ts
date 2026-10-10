/**
 * 学习模块的提示词工厂（纯函数，无 IO/UI 依赖）
 *
 * 覆盖 P1 三项能力：
 * 1. 图解讲解（diagramPrompt）—— 分步拆解 + mermaid 图，供 practiceView / mistakesView 复用
 * 2. 真题仿写（styleProfilePrompt / mimicQuestionPrompt）—— 抽取样卷风格档案，再按档案出题
 * 3. 答疑 Solver（solverPrompt）—— 绑切片上下文作答并强制行内引用
 *
 * 约定：所有提示词都要求「仅依据切片作答」，禁止模型用切片外知识编造；
 * 语言随界面（zh/en）切换，与 examView 现有出题提示词保持一致。
 */

/** 真题风格档案（由样卷文本抽取；mimic 出题时作为风格约束注入） */
export interface ExamStyleProfile {
  /** 样卷题量（仅作参考，实际题数取用户输入） */
  count: number
  /** 题型题量配比（按样卷统计；缺省 0） */
  types: { single: number; multi: number; judge: number; essay: number }
  /** 题干措辞风格（人称/提问方式/是否带材料引导语…） */
  stemStyle: string
  /** 选项风格（长度、是否含"以上都对"、字母序号格式…） */
  optionStyle: string
  /** 难度描述（识记/理解/计算/综合…） */
  difficulty: string
  /** 参考答案与解析风格 */
  refStyle: string
  /** 其他观察（分段、分值标注、语言…） */
  notes: string
}

export function emptyStyleProfile(): ExamStyleProfile {
  return {
    count: 0,
    types: { single: 0, multi: 0, judge: 0, essay: 0 },
    stemStyle: '',
    optionStyle: '',
    difficulty: '',
    refStyle: '',
    notes: '',
  }
}

/** 容错解析风格档案（模型可能返回字符串/数组形式的字段） */
export function normalizeStyleProfile(raw: any): ExamStyleProfile {
  const p = emptyStyleProfile()
  if (!raw || typeof raw !== 'object') return p
  const num = (v: any) => {
    const n = Number(v)
    return isNaN(n) ? 0 : Math.max(0, Math.round(n))
  }
  const str = (v: any): string => {
    if (v == null) return ''
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).join('；')
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v).trim()
  }
  p.count = num(raw.count ?? raw.total ?? raw.questionCount)
  const t = raw.types ?? raw.typeMix ?? raw.mix ?? {}
  p.types = {
    single: num(t.single ?? t['单选'] ?? t.singleChoice),
    multi: num(t.multi ?? t['多选'] ?? t.multiChoice),
    judge: num(t.judge ?? t['判断'] ?? t.trueFalse),
    essay: num(t.essay ?? t['问答'] ?? t['简答'] ?? t.shortAnswer),
  }
  p.stemStyle = str(raw.stemStyle ?? raw.stem ?? raw['题干风格'])
  p.optionStyle = str(raw.optionStyle ?? raw.options ?? raw['选项风格'])
  p.difficulty = str(raw.difficulty ?? raw.level ?? raw['难度'])
  p.refStyle = str(raw.refStyle ?? raw.reference ?? raw['答案风格'] ?? raw['解析风格'])
  p.notes = str(raw.notes ?? raw.other ?? raw['备注'] ?? raw['其他'])
  return p
}

/** 风格档案 → 一句话摘要（面板上展示给用户看） */
export function styleProfileSummary(p: ExamStyleProfile, zh: boolean): string {
  const mix: string[] = []
  const label: Record<keyof ExamStyleProfile['types'], string> = zh
    ? { single: '单选', multi: '多选', judge: '判断', essay: '问答' }
    : { single: 'single', multi: 'multi', judge: 'T/F', essay: 'essay' }
  for (const k of Object.keys(p.types) as (keyof ExamStyleProfile['types'])[]) {
    if (p.types[k] > 0) mix.push(`${label[k]} ${p.types[k]}`)
  }
  const segs = [
    mix.length ? (zh ? `题型配比：${mix.join(' · ')}` : `Type mix: ${mix.join(' · ')}`) : '',
    p.difficulty ? (zh ? `难度：${p.difficulty}` : `Difficulty: ${p.difficulty}`) : '',
    p.stemStyle ? (zh ? `题干：${p.stemStyle}` : `Stem: ${p.stemStyle}`) : '',
  ].filter(Boolean)
  return segs.join('　|　')
}

/** 风格档案 → 出题提示词的风格约束段（模型可读的自然语言） */
export function styleProfileBlock(p: ExamStyleProfile, zh: boolean): string {
  const lines: string[] = []
  const push = (k: string, v: string) => { if (v) lines.push(`- ${k}${v}`) }
  if (zh) {
    push('题型与题量配比（仅作风格参考）：', styleProfileSummary({ ...p, difficulty: '', stemStyle: '' }, true))
    push('题干措辞风格：', p.stemStyle)
    push('选项风格：', p.optionStyle)
    push('难度定位：', p.difficulty)
    push('参考答案风格：', p.refStyle)
    push('其他风格观察：', p.notes)
    return lines.join('\n')
  }
  push('Type/number mix (style reference only): ', styleProfileSummary({ ...p, difficulty: '', stemStyle: '' }, false))
  push('Stem wording style: ', p.stemStyle)
  push('Option style: ', p.optionStyle)
  push('Difficulty level: ', p.difficulty)
  push('Reference answer style: ', p.refStyle)
  push('Other observations: ', p.notes)
  return lines.join('\n')
}

// ==================== 0. 语言判定 ====================

/**
 * 判定知识库正文语言：中文占比达到阈值即视为中文库。
 * 用于决定 AI 讲解 / 图解的**输出语言**（优先中文，知识库本身是英文时用英文）。
 * 只扫描前 ~2 万字，避免大库卡顿。
 */
export function detectContentLanguage(texts: (string | undefined | null)[]): 'zh' | 'en' {
  let cjk = 0
  let latin = 0
  let scanned = 0
  for (const t of texts) {
    const s = String(t || '')
    for (let i = 0; i < s.length && scanned < 20000; i++) {
      const c = s.charCodeAt(i)
      if (c >= 0x4e00 && c <= 0x9fff) cjk++
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++
      scanned++
    }
    if (scanned >= 20000) break
  }
  if (!cjk) return 'en'                       // 完全没有中文 → 英文库
  return cjk * 5 >= latin ? 'zh' : 'en'       // 中文字数达拉丁字母 1/5 即算中文库
}

// ==================== 1. 图解讲解 ====================

/** 纯文字讲解（错题本「AI 讲解」沿用原行为） */
export function explainPrompt(zh: boolean, question: string, slice: string): string {
  return zh
    ? `你是知识讲解老师。请针对下面这道错题，基于参考切片讲清核心知识点与正确答案的依据，用中文，200 字内，不要前后缀。\n\n题目：${question}\n\n【参考切片】\n${slice}`
    : `You are a tutor. Explain the key point and why the correct answer is right for this missed question, based on the reference slice, within 200 words.\n\nQuestion: ${question}\n\n[Reference]\n${slice}`
}

/**
 * 图解讲解：要求模型输出「一句话核心 + 前置概念 + 分步说明 + 易混点 + 一张 mermaid 图」的 Markdown。
 * mermaid 图约定用 flowchart（方框节点 + 带引号标签），降低解析失败概率。
 */
export function diagramPrompt(zh: boolean, question: string, slice: string): string {
  if (zh) {
    return `你是知识讲解老师。请把下面这道题涉及的知识点讲成「图文结合」的复习材料，只输出 Markdown，不要任何前后缀解释。

题目：${question}

【参考切片】
${slice || '(无切片原文，仅依据题目讲解)'}

输出结构（严格按此顺序，小标题用 ## ）：
## 一句话核心
用一句话说清这道题考的是什么。

## 前置概念
2-4 条列表，每条一行，解释读懂本题必须先知道的术语。

## 分步推理
按 1. 2. 3. 编号，逐步说明从题目条件推到正确答案的过程，每步一句话。

## 易混点
1-3 条列表，写清容易错在哪、和什么概念容易混。

## 知识结构图
用 mermaid flowchart 画一张结构图（节点不超过 8 个），必须满足：
1) 用 \`\`\`mermaid 代码块包裹；
2) 只写 flowchart 图（如 flowchart TD），不要写其它类型；
3) 每个节点标签用英文双引号包起来，例如 A["前置概念"]；
4) 标签内不要出现括号、冒号、引号、换行等特殊符号；
5) 只用 --> 连线，不要用样式类或 subgraph；
6) 节点标签必须是中文，与正文同语言（专有名词/缩写可保留英文，如 LP、KKT、GDP），不要写英文短语、拼音或保留英文小标题。

要求：正文与**图内标签**全部用中文；只依据切片与题目，不要引入切片外的知识；无法从切片确定的结论要标注「切片未说明」。`
  }
  return `You are a tutor. Turn this question's knowledge points into an illustrated revision note. Output Markdown ONLY, no extra text.

Question: ${question}

[Reference slice]
${slice || '(no slice text; explain from the question alone)'}

Structure (exactly this order, use ## headings):
## One-line core
One sentence on what this question tests.

## Prerequisites
2-4 bullets: terms you must know before reading the answer.

## Step-by-step reasoning
Numbered 1. 2. 3. steps from the given conditions to the correct answer, one sentence each.

## Common confusions
1-3 bullets on typical mistakes and what gets mixed up.

## Knowledge map
A mermaid flowchart with at most 8 nodes:
1) wrapped in a \`\`\`mermaid code block;
2) flowchart only (e.g. flowchart TD);
3) every node label wrapped in double quotes, e.g. A["Prerequisite"];
4) no parentheses, colons, quotes or newlines inside labels;
5) only --> edges, no style classes or subgraph;
6) node labels must be in English, matching the prose (keep technical abbreviations as-is).

Use English throughout, including diagram labels; rely only on the slice and the question; mark anything not covered as "not stated in the slice".`
}

// ==================== 2. 真题仿写 ====================

/** 抽取样卷风格档案 */
export function styleProfilePrompt(zh: boolean, examText: string): string {
  if (zh) {
    return `你是考试命题研究员。请阅读下面的「真题/样卷」，抽取它的出题风格，严格按 JSON 输出单个对象：
{"count":<题目总数，整数>,"types":{"single":<单选题数>,"multi":<多选题数>,"judge":<判断题数>,"essay":<问答题数>},"stemStyle":"题干措辞风格（人称、提问方式、是否带材料引导语、句子长短）","optionStyle":"选项风格（数量、长度、是否含'以上都对'、序号格式）","difficulty":"难度定位（识记/理解/应用/综合，可含大致比例）","refStyle":"参考答案与解析的写法风格","notes":"其他可复制的形式特征（分值标注、大题分段、语言等）"}
要求：1) 只描述风格，不要照抄原题；2) 数值字段必须是整数，无法判断时填 0；3) 文本字段用中文，每条 40 字内；4) 只输出 JSON，不要任何解释或代码围栏。

真题/样卷全文：
${examText}`
  }
  return `You are an exam design researcher. Read the reference exam below and extract its style. Output ONE JSON object:
{"count":<total questions, int>,"types":{"single":<count>,"multi":<count>,"judge":<count>,"essay":<count>},"stemStyle":"stem wording style","optionStyle":"option style","difficulty":"difficulty level","refStyle":"reference answer style","notes":"other reusable formal traits"}
Rules: 1) describe style only, never copy the original questions; 2) numeric fields must be integers, use 0 if unknown; 3) text fields in English, one short sentence each; 4) JSON only, no prose or code fences.

Reference exam:
${examText}`
}

/** 按风格档案 + 切片出 1 道题（JSON 结构同 examView 通用出题） */
export function mimicQuestionPrompt(
  zh: boolean,
  slice: { label: string; content: string },
  type: string,
  typeRuleZh: string,
  typeRuleEn: string,
  typeZh: string,
  typeEn: string,
  profile: ExamStyleProfile
): string {
  const style = styleProfileBlock(profile, zh)
  if (zh) {
    return `你是知识库出题老师。请【模仿给定真题的风格】、依据下面切片出 1 道${typeZh}${typeRuleZh}。
真题风格档案（模仿它的题干措辞、选项写法、难度与答案风格，但内容必须来自切片）：
${style || '- （未提供）'}

严格按 JSON 输出单个对象：
{"type":"${type}","prompt":"题干（只放题目，不要包含选项）","options":["选项1","选项2","选项3","选项4"（只放纯选项文本，不带 A/B 序号）],"correct":[0],"judge":true,"ref":"参考答案"}
要求：1) prompt 字段绝不要出现选项内容；2) 每题必须【仅依据切片内容】即可确定答案；3) 禁止"计算…/求…的值"这类需要公式计算或切片外数据的题；4) 不要编造切片中不存在的具体数字或结论；5) 题干直接提问，不要"根据提供的文本"这类引导前缀；6) 语言用中文。
说明：single 的 correct 为 1 个下标；multi 为多个下标；judge 用 judge 字段（true/false）且 options 可为空；essay 用 ref 字段。
只输出 JSON，不要任何解释或前后缀。

切片：
${slice.label}
${slice.content}`
  }
  return `You are a KB exam teacher. Write ONE ${typeEn}${typeRuleEn} that MIMICS the given reference exam's style, based on the slice below.
Reference style profile (mimic its wording, options, difficulty and answer style; content must come from the slice):
${style || '- (none provided)'}

Output ONE JSON object:
{"type":"${type}","prompt":"stem only (NO options inside)","options":["option1","option2","option3","option4" (plain text, NO A/B/C prefixes)],"correct":[0],"judge":true,"ref":"reference answer"}
Rules: 1) prompt must NOT contain option text; 2) the question must be answerable SOLELY from the slice; 3) no calculation questions or facts outside the slice; 4) do not invent numbers/conclusions absent from the slice; 5) ask directly, no "According to the text" filler; 6) write in English.
For single correct=[one idx]; multi=[several idx]; judge uses judge (true/false) with empty options; essay uses ref.
JSON only, no prose or code fences.

Slice:
${slice.label}
${slice.content}`
}

// ==================== 3. 答疑 Solver ====================

/**
 * 答疑智能体的系统提示词（agent 模式用）：把「学习答疑」的角色、工具用法与引用纪律写死，
 * 使 agent 循环（kb_search / search_files / read_file）产出与本地模式一致的、带 [n] 引用的讲解。
 */
export function solverAgentPrompt(
  zh: boolean,
  ctx: { kbName: string; kbPath: string; workspace?: string; overview?: boolean }
): string {
  const kb = ctx.kbName || (zh ? '当前知识库' : 'the current KB')
  if (zh) {
    return `你是「知识库答疑」智能体，服务对象是正在学习这份材料的学生：把知识库内容讲清楚，并给出可核对的依据。

工作区：${ctx.workspace || '（未设置）'}
绑定知识库：${kb}（${ctx.kbPath}）

【可用工具与用法】
- kb_search：在当前知识库中检索切片，是本任务的首选工具；可按不同侧面多次调用，不要只查一次就作答。
- search_files：在工作区文件中按文本查找（找散落在文件里的原文/出处）。
- read_file / list_dir：需要看原文或了解文件构成时使用（read_file 单次有长度上限，truncated=true 时用 nextOffset 续读）。

【工作方式】
1. 先判断问题类型：具体问题 → 用 kb_search 检索（关键词不理想时换词重试）；总览/概览类问题（如“整体讲了什么”“有哪些核心概念”）→ 分多轮覆盖不同侧面（topK 可设 10~15），必要时先用 list_dir 了解文件构成。
2. 只依据工具实际返回的内容作答，禁止使用你自己的知识补充或推测。
3. 【检索预算】kb_search 总数不超过 4 次，每次换一个角度/关键词，不要用同一个词反复重试；search_files 同理。连续几次检索都为空时，不要继续换工具空转（不要反复试 list_dir/read_file 碰运气），直接用一句话说明“知识库未检索到相关内容”并给出原因（如嵌入模型未配置 / 切片为空），然后结束本轮。
4. 【工具边界】list_dir 只能传目录，不要对 .md/.kb 等文件路径调用；要看文件内容用 read_file。若工具报错，读懂错误信息后再决定是否换用法，不要重复同一个错误调用。
5. 若 kb_search 报“嵌入模型不可用/检索失败”，改用 search_files（mode="keyword"）在文件中查找，并在回答里说明本次为关键词查找。
6. 输出 Markdown，结构为：先「结论」段（1-3 句直接回答），再「依据」段（逐条说明推理，每条句末用 [编号] 标注所依据的切片，编号对应 kb_search 返回的顺序）。
7. 最后一步必须是生成最终回答（不要再调工具）；不要写“根据提供的切片”这类套话。${ctx.overview ? '\n\n【本轮提示】该问题属于总览型：请分多轮检索覆盖整体，不要只用一片内容作答。' : ''}`
  }
  return `You are the "KB tutor" agent. Your reader is a student studying this material: explain the KB content clearly and cite verifiable sources.

Workspace: ${ctx.workspace || '(not set)'}
Bound knowledge base: ${kb} (${ctx.kbPath})

[Tools]
- kb_search: retrieve slices from the bound KB — the primary tool; call it multiple times for different aspects, never answer from a single call.
- search_files: literal text search across workspace files (locate original text).
- read_file / list_dir: read original text or inspect the file layout (read_file is length-capped; continue with nextOffset when truncated=true).

[How to work]
1. Classify the question: specific → kb_search (retry with other keywords if needed); overview-style ("what does it cover", "list the core concepts") → multiple rounds covering different aspects (topK 10-15), optionally list_dir first.
2. Answer ONLY from what the tools actually returned; never add your own knowledge or guesses.
3. [Retrieval budget] kb_search at most 4 times, each with a different angle/keyword — do not repeat the same query; same for search_files. If several retrievals come back empty, stop trying other tools hoping for luck; state in one sentence that the KB has no matching content and why (e.g. embedding model not configured / no slices), then end the turn.
4. [Tool boundaries] list_dir takes directories only — never pass a .md/.kb file path; use read_file for file content. When a tool errors, read the error before changing approach; never repeat the same failing call.
5. If kb_search reports the embedding model is unavailable, fall back to search_files mode="keyword" and say so in the answer.
6. Output Markdown: a "Conclusion" paragraph (1-3 sentences) then an "Evidence" section with [n] citations referencing the kb_search result order.
7. The final step must be the answer itself (no more tool calls); no filler like "According to the provided slices".${ctx.overview ? '\n\n[Note] This is an overview question: retrieve across multiple rounds instead of answering from one slice.' : ''}`
}


/**
 * 答疑：把检索到的切片编号后交给模型，要求逐句标注 [n] 引用。
 * contextText 由调用方拼好（形如「[1] 标签\n正文」）。
 */
export function solverPrompt(zh: boolean, question: string, contextText: string): string {
  if (zh) {
    return `你是知识库答疑老师。请【只依据】下面编号的参考切片回答学生问题，用中文，Markdown 格式，结构如下：
1) 先给「结论」段，用 1-3 句话直接回答问题；
2) 再给「依据」段，逐条说明推理过程，每条句末用 [编号] 标注所依据的切片（可多个，形如 [1][3]）；
3) 若涉及步骤或对比，可用短的编号列表或一张 mermaid flowchart 辅助说明（可选）。

硬性要求：
- 只使用参考切片中的信息，禁止使用你自己的知识补充或推测；
- 每条结论都要有 [编号] 引用；引用编号只能取参考切片里出现过的编号；
- 若切片不足以回答，明确说「切片未覆盖该问题」，并说明还缺什么信息；
- 不要写"根据提供的切片"之类套话，直接作答。

学生问题：${question}

【参考切片】
${contextText}`
  }
  return `You are a KB Q&A tutor. Answer the student's question using ONLY the numbered reference slices below. Answer in English, Markdown, structured as:
1) a "Conclusion" paragraph answering directly in 1-3 sentences;
2) an "Evidence" section explaining the reasoning, citing slice ids at the end of each claim, e.g. [1][3];
3) optionally a short numbered list or a mermaid flowchart for steps/comparisons.

Hard rules:
- use ONLY information from the reference slices, no outside knowledge or guessing;
- every claim needs a [n] citation; only cite ids that appear in the slices;
- if the slices are insufficient, say "the slices do not cover this" and state what is missing;
- no filler like "According to the provided slices".

Student question: ${question}

[Reference slices]
${contextText}`
}
