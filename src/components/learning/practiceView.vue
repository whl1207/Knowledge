<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import block_md from '@/components/block_md.vue'
import * as kbAi from '@/shared/kbAiClient'
import { diagramPrompt } from '@/services/learningPrompt'
import { explainCacheKey } from '@/services/learningRecord'
import { gradeAnswer, isAutoGradable, type PracticeVerdict } from '@/lib/learning/learningGrade'
import { aiGradePrompt, parseAiGrade, parseQualitativeVerdict, qualitativeAssessPrompt } from '@/services/learningPrompt'
import { ratingFromVerdict, RATING_LABELS, SRS_RATINGS, type SrsRating } from '@/services/learningCore'
import type { PracticeItem } from '@/components/learning/types'

const props = defineProps<{
  store: any
  item: PracticeItem | null
  model?: any
  /** 知识库内容语言（'en' 时 AI 解析用英文，否则优先中文） */
  lang?: 'zh' | 'en'
  /** 已持久化的解析缓存（key=explainCacheKey；命中直接用，不再调模型） */
  explains?: Record<string, { text: string; at: number }>
}>()
const emit = defineEmits<{
  /**
   * 一次作答的结算。
   *
   * - `rating` 四档评分（P1）：判得出分的题由判分结果直接给 good / again，
   *   **不给学习者改判的机会**（对齐 DeepTutor `rate(correct ? 'good' : 'again')`）；
   *   判不了分的题由学习者自评 again / hard / good / easy。
   * - `independent=false` 表示本次作答前展开过答案区；
   * - `hintsUsed` = 本次作答前看过答案/解析的次数（0..3），供证据质量折算。
   */
  result: [ok: boolean, independent: boolean, hintsUsed: number, rating: SrsRating]
  close: []
  /** 生成完成：由父级写回 .learning */
  explainSave: [key: string, text: string, kind: 'explain' | 'diagram', lang: 'zh' | 'en']
  /** 重新生成前清旧值 */
  explainDrop: [key: string]
}>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)
/** AI 输出的语言：界面中文 + 知识库非英文 → 中文；界面英文或英文库 → 英文 */
const promptZh = () => props.store.locales === 'zh' && props.lang !== 'en'

// ==================== 状态声明（必须早于 resetForItem：watch immediate 会立刻调用它） ====================
/**
 * 答案区显示开关。
 *
 * 判得出分的题**默认藏起来**：判分只在学习者的作答之后发生，默认摊开答案等于把
 * "先想再对答案"这条唯一的纪律取消了（对齐 DeepTutor 的
 * "Try recalling the answer before revealing it."）。判不了分的题保持默认显示。
 */
const showPanel = ref(true)
/** 本题展开过答案区 / 未展开（展开即记为一次提示，影响证据质量；换题复位） */
const peeked = ref(false)
/** 被看过几次（展开答案区 / 生成解析各计一次），上限 3——再多也不改变结论 */
const peeks = ref(0)

// ==================== 三标签：答案 / 解析 / 参考切片 ====================
// - 答案：item.back（问题库生成的答案，或来源切片正文）
// - 解析：按需调用大模型生成（一句话核心 / 前置概念 / 分步推理 / 易混点 / 知识结构图）
// - 参考切片：出处切片，用 block_md 渲染（支持公式 / 表格 / mermaid）
const midTab = ref<'ans' | 'explain' | 'slices'>('ans')
const explain = ref('')
const explainLoading = ref(false)
const explainStreaming = ref(false)   // 流式追写中（显示光标）
const explainAt = ref(0)              // 已保存解析的生成时间（0=本次新生成未落盘/无缓存）

// ==================== 作答与判分状态 ====================
/** 学习者的作答原文（选项题存标签） */
const answerText = ref('')

// ==================== 选择题（选项题） ====================
/** 本题的选项表（标签 → 正文）；没有则按文本题处理 */
const choiceMap = computed<Record<string, string> | null>(() => {
  const m = props.item?.choiceMap
  return m && Object.keys(m).length ? m : null
})
/** 选项列表（按标签排序，保证 A–D 稳定） */
const choiceList = computed(() => {
  const m = choiceMap.value
  if (!m) return [] as { label: string; body: string }[]
  return Object.keys(m).sort().map(label => ({ label, body: String(m[label] ?? '') }))
})
/** 多选：答案里有多个标签（`A,C`） */
const isMultiChoice = computed(() => String(props.item?.expectedAnswer || '').includes(','))
/** 已选标签（单选只留一个） */
const picked = ref<string[]>([])
/**
 * 选择/取消一个选项。单选点新的就换，多选点一下切换。
 * 选择本身就是"作答"，所以答案区保持收起（没看答案就答了，是独立作答）。
 */
function pickOption(label: string) {
  if (revealed.value || settled.value) return
  const L = String(label).toUpperCase()
  if (isMultiChoice.value) {
    const i = picked.value.indexOf(L)
    if (i >= 0) picked.value.splice(i, 1)
    else picked.value = [...picked.value, L].sort()
  } else {
    picked.value = [L]
  }
  answerText.value = picked.value.join(',')
}
/** 判分结果：true 对 / false 错 / null 不判（尚未检查或判不出来） */
const verdict = ref<PracticeVerdict>(null)
/** 是否已经"检查并揭示"过（判分走过的路径） */
const revealed = ref(false)
/**
 * 揭示答案时**手上有没有作答**。
 *
 * 这是独立性的第二个来源：没写答案就点「检查并揭示」，等于只是把答案摊开看 ——
 * 此时 `peeked` 若仍为 false，之后的自评就会被当独立回忆记账（
 * "先想过再对答案"和"直接看答案"在证据上必须区分开）。
 */
const revealedWithAnswer = ref(false)
/** 是否已结算（结算后禁用一切作答控件，避免重复记账） */
const settled = ref(false)

/** 载入题目：复位一切状态；判得出分的题把答案区收起来 */
function resetForItem(it: PracticeItem | null) {
  answerText.value = ''
  picked.value = []
  verdict.value = null
  revealed.value = false
  revealedWithAnswer.value = false
  settled.value = false
  peeked.value = false
  peeks.value = 0
  assessLoading.value = false
  assessFeedback.value = ''
  assessPassed.value = null
  assessUnavailable.value = false
  aiJudgeLoading.value = false
  aiJudgeCorrect.value = null
  aiJudgeReason.value = ''
  midTab.value = 'ans'
  explain.value = ''
  explainLoading.value = false
  explainStreaming.value = false
  explainAt.value = 0
  showPanel.value = !(it && isAutoGradable({
    type: it.qType,
    expectedAnswer: it.expectedAnswer,
    choiceMap: it.choiceMap,
  }))
}

/**
 * 是否可自动判分：只有拿到**独立于切片正文**的期望答案（问题库的 extraAnswer）才行。
 * 复述题 / 只有来源切片的题 → false，直接走四档自评。
 */
const canAutoGrade = computed(() => (props.item ? isAutoGradable({
  type: props.item.qType,
  expectedAnswer: props.item.expectedAnswer,
  choiceMap: props.item.choiceMap,
}) : false))

/**
 * 是否是**质性**知识点（concept / design，且没有可判分的答案键）。
 *
 * 这类知识点不用正确率判掌握：它"很少有一个唯一正确答案可以拿来比字符串"，
 * 所以改成让学习者用自己的话讲一遍，再由导师判定是否足够（对齐 DeepTutor 的 `mastery_assess`）。
 */
const isQualitative = computed(() => props.item?.qType === 'qualitative')

/** 质性判定的模型评分状态 */
const assessLoading = ref(false)
const assessFeedback = ref('')
const assessPassed = ref<boolean | null>(null)
/** 模型不可用时（或判定解析失败）退回四档自评，而不是卡住 */
const assessUnavailable = ref(false)

// ==================== AI 复核判分（P1-4，learner 主动触发） ====================
/**
 * 字符串判分**只能证明"像是答对了"**：措辞、同义词、语序都会让相似度掉下来，
 * 所以它拿不准时一律返回 `null`（不判），交给四档自评。
 * 学习者想知道"我这句到底算不算对"时，唯一有依据的方式就是让模型看语义 ——
 * 这就是这个按钮的定位：**可选的复核**，不替代即时判定（否则每答一题都要等模型）。
 */
const aiJudgeLoading = ref(false)
const aiJudgeReason = ref('')
/** 模型给的裁决；null = 没判出来或模型主动说"说不清"（退回自评） */
const aiJudgeCorrect = ref<boolean | null>(null)

/**
 * 什么时候显示四档自评？**四档是兜底出口，必须常驻可达**（学习者不该
 * 因为"没写答案"或"判不出来"就卡在卡上）。
 * - 质性题：始终可达（模型判定是可选动作，不是必须过的关）；
 * - 判分题 / 文本题：只要还没有裁决就给（选了选项但没判定也算）。
 */
const showRatings = computed(() => !settled.value && !hasVerdict.value)
/** 已经有裁决（字符串判分给了对/错，或 AI 复核给了裁决） */
const hasVerdict = computed(() => verdict.value !== null || aiJudgeCorrect.value !== null)
/** 当前生效的裁决（AI 复核优先于字符串判分） */
const effectiveVerdict = computed<boolean | null>(() => aiJudgeCorrect.value ?? verdict.value)
/**
 * 是否显示"检查并揭示答案"。有钥匙就能查（判不出来会转自评）；
 * AI 复核已经跑过之后不再显示（避免重复点）。
 */
const canCheck = computed(() => canAutoGrade.value && !revealed.value && !settled.value)
/** 文本题（非选择题）才需要"请 AI 判分"——选择题有唯一答案，字符串判定就是有依据的 */
const canAiJudge = computed(() =>
  revealed.value && !settled.value && !hasVerdict.value &&
  !choiceList.value.length && !!props.item?.expectedAnswer)

/** 四档评分选项（自评型用） */
const ratings = computed(() => SRS_RATINGS.map(v => ({ value: v, ...RATING_LABELS[v] })))

/** 记录"看过一次"：展开答案区 / 生成解析都算，上限 3（再多也不改变结论） */
const notePeek = () => { peeked.value = true; peeks.value = Math.min(3, peeks.value + 1) }

/** 显示 / 隐藏答案区。从隐藏翻到显示记为一次提示 */
function togglePanel() {
  const next = !showPanel.value
  if (next && !showPanel.value) notePeek()
  showPanel.value = next
}

/** 结算一次作答（唯一出口：所有按钮都汇到这里） */
function settle(ok: boolean, rating: SrsRating) {
  if (settled.value || !props.item) return
  settled.value = true
  // 质性判定：把讲解原文与模型短评回填到题目上，供父级落盘为证据
  if (isQualitative.value) {
    props.item.explanation = answerText.value.trim()
    props.item.feedback = assessFeedback.value
  }
  // 两个来源任一成立即算"不是独立回忆"：
  // ① 作答前展开过答案区/解析；② 揭示答案时手上没有作答（只是把答案摊开看）
  const independent = !peeked.value && !(revealed.value && !revealedWithAnswer.value)
  emit('result', ok, independent, independent ? 0 : Math.max(peeks.value, 1), rating)
}

/**
 * 「检查并揭示答案」：判分 + 把答案与解析揭示出来。
 * 判分是确定性的纯函数，判不出来（`null`）就转交自评 —— **绝不判错**。
 */
function reveal() {
  if (settled.value || revealed.value || !props.item) return
  const it = props.item
  // 选择题：选了选项就算作答过；文本题看文本框
  revealedWithAnswer.value = choiceList.value.length ? picked.value.length > 0 : !!answerText.value.trim()
  verdict.value = gradeAnswer({
    type: it.qType,
    expected: it.expectedAnswer || '',
    answer: answerText.value,
    choiceMap: it.choiceMap || null,
  })
  revealed.value = true
  showPanel.value = true
}

/** 判分型：按裁决结算，学习者无从改判 */
function rateAuto() {
  const v = effectiveVerdict.value
  if (v === null) return
  settle(v, ratingFromVerdict(v))
}

/**
 * 「请 AI 判分」：把题目 / 参考答案 / 学习者作答 / 来源切片交给模型看语义。
 *
 * 与「检查并揭示答案」的分工：那个是**即时、免费、离线**的字符串判定（只能证明"像对"）；
 * 这个是**按需付费**的语义复核（能证明"确实对"或"确实错"）。两者都在，
 * 学习者自己决定要不要花这一次调用。
 */
async function aiJudge() {
  const it = props.item
  if (!it || aiJudgeLoading.value || settled.value) return
  if (!props.model?.chat && !props.model?.process) {
    // 没模型：明确告知，并保持四档自评可达
    aiJudgeReason.value = tr('没有可用的 AI 模型，请用右侧四档自行评分', 'No AI model available — self-assess with the ratings on the right')
    return
  }
  aiJudgeLoading.value = true
  try {
    const prompt = aiGradePrompt(promptZh(), it.q, it.expectedAnswer || '', answerText.value.trim(), sliceTextOf(it))
    const spec = kbAi.buildSpecFromModel(props.model, props.store)
    const out = await kbAi.streamChat(spec, [{ role: 'user', content: prompt }], () => {})
    const parsed = parseAiGrade(out)
    if (!parsed) {
      // 模型没给结论（或输出解析不出来）：**不硬判**，保持自评可达
      aiJudgeCorrect.value = null
      aiJudgeReason.value = tr('AI 没有给出明确结论，请用右侧四档自行评分', 'The AI reached no clear verdict — self-assess with the ratings on the right')
    } else {
      aiJudgeCorrect.value = parsed.correct
      aiJudgeReason.value = parsed.reason
    }
  } catch (e) {
    aiJudgeCorrect.value = null
    aiJudgeReason.value = tr('AI 判分失败：', 'AI grading failed: ') + (e instanceof Error ? e.message : String(e))
  } finally {
    aiJudgeLoading.value = false
  }
}

/** 自评型：四档评分 */
function rateSelf(rating: SrsRating) {
  const ok = rating !== 'again'
  // 走"看答案"路径后答对的，标记为看过答案（不算独立回忆）
  settle(ok, rating)
}

/**
 * 质性判定（concept / design：「用自己的话讲一遍」）。
 *
 * 对齐 DeepTutor 的 `mastery_assess`：**不由字符串判分**，而是把学习者的讲解交给模型，
 * 由它判断"是否正确且完整到足以算掌握"。三种结局都要有出路：
 * - 判定成功 → 显示通过与否 + 模型短评，由学习者确认后结算；
 * - 没配模型 → `assessUnavailable`，退回四档自评（**不卡住学习者**）；
 * - 模型输出解析不出来 → 同样退回自评（**解析失败 ≠ 判不过**）。
 */
async function assess() {
  const it = props.item
  if (!it || assessLoading.value || settled.value || revealed.value) return
  const explanation = answerText.value.trim()
  if (!explanation) return
  if (!props.model?.chat && !props.model?.process) { assessUnavailable.value = true; return }
  assessLoading.value = true
  assessUnavailable.value = false
  try {
    const prompt = qualitativeAssessPrompt(promptZh(), it.q, explanation, sliceTextOf(it))
    const spec = kbAi.buildSpecFromModel(props.model, props.store)
    const out = await kbAi.streamChat(spec, [{ role: 'user', content: prompt }], () => {})
    const parsed = parseQualitativeVerdict(out)
    if (!parsed) { assessUnavailable.value = true; return }
    assessPassed.value = parsed.passed
    assessFeedback.value = parsed.feedback
    // 质性判定也走"揭示答案"，且此时手上**有**讲解 → 算独立
    revealedWithAnswer.value = true
    revealed.value = true
    showPanel.value = true
  } catch (e) {
    assessUnavailable.value = true
  } finally {
    assessLoading.value = false
  }
}

/** 质性判定通过/不通过 → 结算（由模型裁决，学习者不能改判） */
function rateAssess() {
  if (assessPassed.value === null) return
  settle(assessPassed.value, ratingFromVerdict(assessPassed.value))
}

const hasSlices = computed(() => !!(props.item?.slices && props.item.slices.length))
/** 解析缓存 key：随题目变化（题干改了 -> 指纹变了 -> 自动重新生成） */
const explainKey = computed(() => (props.item ? explainCacheKey('diagram', props.item.blockId, props.item.q) : ''))
/** 该题已保存的解析 */
const cachedExplain = computed(() => (explainKey.value ? props.explains?.[explainKey.value] : undefined))

// 换题即整体复位（含作答、判分、独立性标记、答案区默认开合）。
// immediate：首题挂载时也要应用"判得出分的题把答案区收起来"。
watch(() => props.item, (it) => resetForItem(it || null), { immediate: true })

function sliceTextOf(it: PracticeItem): string {
  const parts: string[] = []
  if (it.back) parts.push(`【${it.hasAnswer ? '参考答案' : '来源切片'}】\n${it.back}`)
  for (const s of it.slices || []) parts.push(`【${s.label}】\n${s.content}`)
  return parts.join('\n\n')
}

/** 生成解析（force=true 忽略缓存重新生成）；命中缓存则不调模型 */
async function ensureExplain(force = false) {
  const it = props.item
  if (!it || explainLoading.value || explainStreaming.value) return
  const key = explainKey.value
  // 已保存过：直接展开缓存内容（不烧 token）
  if (!force && cachedExplain.value?.text) {
    explain.value = cachedExplain.value.text
    explainAt.value = cachedExplain.value.at || 0
    return
  }
  if (!props.model?.chat && !props.model?.process) {
    explain.value = tr('未配置可用的 AI 模型（请到设置-模型配置）', 'No AI model configured (Settings → Models)')
    return
  }
  if (force && key) emit('explainDrop', key)   // 重新生成：先清旧缓存
  explainLoading.value = true
  explain.value = ''
  explainStreaming.value = true
  try {
    const prompt = diagramPrompt(promptZh(), it.q, sliceTextOf(it))
    const spec = kbAi.buildSpecFromModel(props.model, props.store)
    // 流式：逐段追写并实时渲染 Markdown（节流，避免每个 chunk 都重渲染 mermaid）
    let acc = ''
    let lastPaint = 0
    const out = await kbAi.streamChat(spec, [{ role: 'user', content: prompt }], (chunk: string) => {
      acc += chunk
      const now = Date.now()
      if (now - lastPaint > 120) { lastPaint = now; explain.value = acc }
    })
    explain.value = String(out || acc || '').trim() || tr('（无返回内容）', '(empty response)')
    expectSaved()
  } catch (e) {
    explain.value = tr('解析失败：', 'Explain failed: ') + (e instanceof Error ? e.message : String(e))
  } finally {
    explainLoading.value = false
    explainStreaming.value = false
  }
}

/** 生成成功后写回 .learning（父级落盘） */
function expectSaved() {
  const body = String(explain.value || '').trim()
  if (!body || !explainKey.value) return
  explainAt.value = Date.now()
  emit('explainSave', explainKey.value, body, 'diagram', promptZh() ? 'zh' : 'en')
}

/** 「重新生成」按钮 */
function regenExplain() { ensureExplain(true) }

/** 缓存时间显示（MM-DD HH:mm） */
function fmtExplainAt(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
/** 切换标签（解析按需生成；同时确保面板可见）。答案 / 解析一经展开即记为「看过」。 */
function setTab(tab: 'ans' | 'explain' | 'slices') {
  midTab.value = tab
  showPanel.value = true
  if (tab === 'ans' || tab === 'explain') notePeek()
  if (tab === 'explain') ensureExplain()
}
</script>

<template>
  <div class="lk-body">
    <!-- 完成态：无题目 -->
    <div v-if="!item" class="lk-empty">
      <i class="fa fa-flag-checkered"></i>
      <p>{{ tr('本组练习完成，可在下方状态栏查看本次对错', 'All done — see the session stats in the status bar below') }}</p>
      <button class="lk-btn" @click="emit('close')"><i class="fa fa-times"></i> {{ tr('结束', 'End') }}</button>
    </div>
    <!-- 答题卡：文件名/进度/对错在底部状态栏 -->
    <div v-else class="lk-card">
      <!-- 顶部条：题目标签 + 答案区开合（作答/评分按钮移到题面下方） -->
      <div class="lk-headbar">
        <span class="lk-side-label"><i class="fa fa-question-circle-o"></i> {{ tr('问题 · 先在下方作答，再对答案', 'Question · answer below, then check') }}</span>
        <span style="flex:1;"></span>
        <!-- 自测：整块答案区可隐藏。从隐藏翻到显示 = 一次 hint（含"我只想快速扫一眼"） -->
        <button class="lk-btn toggle" :class="{ on: showPanel }" @click="togglePanel()"
          :title="tr('显示/隐藏答案区（自测时可先隐藏；显示即记为一次提示）', 'Show / hide the answer area (hide it for self-testing; showing counts as a hint)')">
          <i class="fa" :class="showPanel ? 'fa-eye' : 'fa-eye-slash'"></i>{{ tr('答案区', 'Answer area') }}
        </button>
        <!-- 独立性提示：看过答案之后的「记得」不算独立回忆，掌握度要按证据质量折算 -->
        <span v-if="peeked" class="lk-hint-note"
          :title="tr('本题展开过答案区/解析：答对仍计入复习，但掌握度按「看过答案」折算，不足以判定为已掌握',
                    'Answer area / explanation was opened for this question: a correct answer still counts for review, but mastery is discounted and will not mark the point mastered')">
          <i class="fa fa-info-circle"></i>{{ tr('已计提示', 'hinted') }}
        </span>
        <span class="lk-sep"></span>
        <button class="lk-btn" @click="emit('close')" :title="tr('结束本组练习', 'End this session')"><i class="fa fa-times"></i></button>
      </div>
      <!-- 上段：题面正文 -->
      <div class="lk-front scoll">
        <div class="lk-qtext">{{ item.q }}</div>
        <div v-if="item.hint" class="lk-qhint">{{ item.hint }}</div>
      </div>

      <!-- 作答区：判得出分的题在这里写答案 → 检查并揭示 → 按裁决结算 -->
      <div class="lk-answer">
        <!-- 选择题：点选项作答（选择本身就是作答，所以答案区保持收起） -->
        <div v-if="choiceList.length" class="lk-choices">
          <button v-for="c in choiceList" :key="c.label" type="button"
            class="lk-choice" :class="{
              on: picked.includes(c.label),
              ok: revealed && verdict !== null && String(item.expectedAnswer || '').split(',').map(s => s.trim().toUpperCase()).includes(c.label),
              no: revealed && verdict === false && picked.includes(c.label),
            }"
            :disabled="revealed || settled"
            @click="pickOption(c.label)">
            <span class="lk-choice-l">{{ c.label }}</span>
            <span class="lk-choice-b">{{ c.body }}</span>
          </button>
          <div v-if="isMultiChoice" class="lk-qhint">{{ tr('多选：选中所有正确项', 'Multiple answers: pick all that apply') }}</div>
        </div>
        <textarea v-else-if="canAutoGrade || isQualitative" v-model="answerText" class="lk-atext scoll"
          :disabled="revealed || settled || assessLoading"
          :rows="2"
          :placeholder="canAutoGrade
            ? tr('先凭记忆写下你的答案，再对答案…', 'Try recalling the answer before revealing it.')
            : tr('用自己的话把这个知识点讲一遍（这是「概念/设计」型的判定方式）…', 'Explain this point in your own words — that is how concept/design objectives are judged.')" />
        <div class="lk-headbar">
          <!-- ① 质性型：用自己的话讲一遍 → 模型判定（对齐 mastery_assess 的 Feynman 检查） -->
          <template v-if="isQualitative">
            <button v-if="!hasVerdict" class="lk-btn ok" :disabled="settled || assessLoading || !answerText.trim()" @click="assess()">
              <i class="fa" :class="assessLoading ? 'fa-spinner fa-spin' : 'fa-comments-o'"></i>
              {{ assessLoading ? tr('正在判定…', 'Judging…') : tr('提交讲解，请老师判定', 'Submit explanation for judging') }}
            </button>
            <template v-else>
              <span class="lk-verdict" :class="assessPassed ? 'ok' : 'no'">
                <i class="fa" :class="assessPassed ? 'fa-check-circle' : 'fa-times-circle'"></i>
                {{ assessPassed ? tr('讲解足够，判定通过', 'Explanation sufficient — passed') : tr('还不够，判定未通过', 'Not sufficient yet — not passed') }}
              </span>
              <button class="lk-btn ok" :disabled="settled" @click="rateAssess()">
                {{ assessPassed ? tr('掌握 · 下一题', 'Mastered · Next question') : tr('本轮再练', 'Practice again') }}
              </button>
            </template>
            <span v-if="assessUnavailable && !hasVerdict" class="lk-ungraded">
              <i class="fa fa-info-circle"></i>
              {{ tr('AI 判定不可用，请用右侧四档自行评分', 'AI judging unavailable — self-assess with the ratings on the right') }}
            </span>
          </template>
          <!-- ② 判分型：检查并揭示（即时、免费、离线的字符串判定） -->
          <template v-else-if="canAutoGrade">
            <button v-if="canCheck" class="lk-btn ok" :disabled="settled" @click="reveal()">
              <i class="fa fa-search"></i> {{ tr('检查并揭示答案', 'Check and reveal answer') }}
            </button>
            <!-- 字符串判分给了裁决（目前只有选择题会给）：按裁决结算，不允许改判 -->
            <template v-if="hasVerdict">
              <span class="lk-verdict" :class="effectiveVerdict ? 'ok' : 'no'">
                <i class="fa" :class="effectiveVerdict ? 'fa-check-circle' : 'fa-times-circle'"></i>
                {{ effectiveVerdict ? tr('答对了', 'Correct') : tr('需要再来一次', 'Needs another try') }}
              </span>
              <button class="lk-btn ok" :disabled="settled" @click="rateAuto()">
                {{ effectiveVerdict ? tr('掌握 · 下一题', 'Mastered · Next question') : tr('本轮再练', 'Practice again') }}
              </button>
            </template>
            <!-- 文本题拿不准：**不判错**。可让 AI 看语义复核，也可直接自评 -->
            <template v-else-if="revealed">
              <button v-if="canAiJudge" class="lk-btn" :disabled="aiJudgeLoading" @click="aiJudge()"
                :title="tr('字符串判分只能证明「像对」，证明不了「错」。让模型按语义复核一次', 'String matching can only prove a likely match, never a mismatch — have the model check the meaning once')">
                <i class="fa" :class="aiJudgeLoading ? 'fa-spinner fa-spin' : 'fa-magic'"></i>
                {{ aiJudgeLoading ? tr('AI 正在判分…', 'AI grading…') : tr('请 AI 判分', 'Let AI grade it') }}
              </button>
              <span class="lk-ungraded">
                <i class="fa fa-info-circle"></i>
                {{ tr('字符串判分拿不准（措辞差异证明不了答错），请自评或让 AI 复核', 'String matching is inconclusive (wording differences prove nothing) — self-assess, or let the AI check') }}
              </span>
            </template>
          </template>
          <!-- ③ 其余：直接自评 -->
          <span v-else class="lk-ungraded">
            <i class="fa fa-info-circle"></i>
            {{ tr('先凭记忆说一遍，再对照答案自评', 'Say it from memory first, then self-assess against the answer') }}
          </span>
          <span style="flex:1;"></span>
          <!-- 四档自评：**常驻可达的兜底出口**（没有裁决就给，不必先作答；判不出来也给） -->
          <template v-if="showRatings">
            <button v-for="r in ratings" :key="r.value" class="lk-btn" :class="{ ok: r.value === 'good' || r.value === 'easy', miss: r.value === 'again' }"
              :title="tr(r.hintZh, r.hintEn)" @click="rateSelf(r.value)">
              {{ tr(r.zh, r.en) }}
            </button>
          </template>
          <button class="lk-btn" @click="emit('close')" :title="tr('结束本组练习', 'End this session')">
            <i class="fa fa-times"></i> {{ tr('结束', 'End') }}
          </button>
        </div>
        <!-- AI 复核的结论与理由 -->
        <div v-if="aiJudgeReason" class="lk-assess-fb"
          :class="{ 'lk-fb-ok': aiJudgeCorrect === true, 'lk-fb-no': aiJudgeCorrect === false }">
          <i class="fa" :class="aiJudgeCorrect === true ? 'fa-check-circle' : aiJudgeCorrect === false ? 'fa-times-circle' : 'fa-comment-o'"></i>
          {{ aiJudgeReason }}
        </div>
        <!-- 质性判定的模型短评（"讲对了什么 / 缺什么"） -->
        <div v-if="isQualitative && revealed && assessFeedback" class="lk-assess-fb">
          <i class="fa fa-comment-o"></i> {{ assessFeedback }}
        </div>
      </div>

      <!-- 下段：三标签面板（答案 / 解析 / 参考切片） -->
      <div v-if="showPanel" class="lk-panel">
        <div class="lk-panel-head">
          <button class="lk-mini lk-side-label" :class="{ on: midTab === 'ans' }" @click="setTab('ans')"
            :title="tr('参考答案', 'Reference answer')">
            <i class="fa" :class="item.hasAnswer ? 'fa-check-circle-o' : 'fa-file-text-o'"></i>{{ tr('答案', 'Answer') }}
          </button>
          <button class="lk-mini lk-side-label" :class="{ on: midTab === 'explain' }" @click="setTab('explain')"
            :title="tr('AI 解析：一句话核心 / 前置概念 / 分步推理 / 易混点 / 知识结构图', 'AI explanation: core / prerequisites / steps / confusions / knowledge map')">
            <i class="fa fa-sitemap"></i>{{ tr('解析', 'Explain') }}
          </button>
          <button v-if="hasSlices" class="lk-mini lk-side-label" :class="{ on: midTab === 'slices' }" @click="setTab('slices')"
            :title="tr('参考切片（出处），按 Markdown 渲染', 'Reference slices (sources), rendered as Markdown')">
            <i class="fa fa-files-o"></i>{{ tr('参考切片', 'Slices') }} {{ item.slices?.length || 0 }}
          </button>
        </div>

        <!-- 答案 -->
        <div v-if="midTab === 'ans'" class="lk-btext scoll">{{ item.back || tr('（无答案/正文）', '(no content)') }}</div>
        <!-- 解析（按需生成，流式输出并实时渲染 Markdown；已生成的结果存在 .learning 里，再打开直接显示） -->
        <div v-else-if="midTab === 'explain'" class="lk-diag scoll learn-md">
          <div v-if="explainLoading && !explain" class="lk-diag-loading"><i class="fa fa-spinner fa-spin"></i> {{ tr('正在生成解析…', 'Generating explanation…') }}</div>
          <block_md v-else-if="explain" :content="explain" :fontSize="'13px'" />
          <span v-if="explainStreaming" class="lk-caret"></span>
          <div v-if="explain && !explainLoading && !explainStreaming" class="lk-diag-foot">
            <span v-if="explainAt"><i class="fa fa-database"></i> {{ tr('已存入学习记录', 'Saved to learning record') }} {{ fmtExplainAt(explainAt) }}</span>
            <span v-else>{{ tr('未保存（本次生成）', 'Not saved yet') }}</span>
            <span style="flex:1;"></span>
            <button class="lk-mini" :title="tr('重新调用模型生成一份', 'Regenerate with the model')" @click="regenExplain"><i class="fa fa-refresh"></i> {{ tr('重新生成', 'Regenerate') }}</button>
          </div>
        </div>
        <!-- 参考切片（Markdown 渲染） -->
        <div v-else class="lk-slices scoll">
          <div v-for="(s, si) in item.slices" :key="si" class="lk-slice">
            <div class="lk-slice-label">[{{ si + 1 }}] {{ s.label }}</div>
            <div class="learn-md"><block_md :content="s.content" :fontSize="'13px'" /></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lk-body { padding: 4px; display: flex; flex-direction: column; gap: 5px; height: 100%; box-sizing: border-box; overflow: hidden; }
/* 统一按钮：等高、flex 内容居中 */
.lk-btn {
  cursor: pointer;
  border: 1px solid var(--borderColor, #d0d7de);
  background: var(--backgroundColor, #fff);
  color: var(--fontColor, #1f2328);
  border-radius: 5px;
  font-size: 12px;
  height: 30px;
  padding: 0 12px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.lk-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-btn.ok { color: #4CAF50; border-color: #4CAF50; }
.lk-btn.miss { color: #d93025; border-color: #d93025; }
.lk-btn.wide { min-width: 120px; }
/* 开关态（右上角 答案/切片） */
.lk-btn.toggle { padding: 0 8px; }
.lk-btn.toggle.on { color: var(--fontActiveColor, #0969da); border-color: var(--fontActiveColor, #0969da); background: var(--menuActiveColor, #e5e5e5); }
.lk-card { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--borderColor, #d0d7de); border-radius: 8px; overflow: hidden; }
/* 顶部条：题面标签 + 右上操作按钮（固定行，不随题面滚动） */
.lk-headbar { display: flex; align-items: center; gap: 3px; padding: 2px 3px 1px; flex-shrink: 0; flex-wrap: wrap; }
/* 顶部条内按钮更紧凑：矮一点、内边距小一点 */
.lk-headbar .lk-btn { height: 24px; padding: 0 7px; font-size: 11px; gap: 3px; }
.lk-side-label { font-size: 11px; color: var(--borderColor, #888); white-space: nowrap; }
/* 独立性提示：看过答案后出现，说明本次掌握的记账方式 */
.lk-hint-note { font-size: 10.5px; color: #FF9800; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; cursor: help; }
/* 题面下的一行引导（复述题等） */
.lk-qhint { font-size: 11px; color: var(--borderColor, #888); margin-top: 3px; }
/* 作答区：输入框 + 按钮行（固定在题面与答案面板之间） */
.lk-answer { flex-shrink: 0; display: flex; flex-direction: column; gap: 3px; padding: 0 3px 2px; border-bottom: 1px solid var(--borderColor, #d0d7de); }
/* 选择题：选项按钮列表（点选即作答） */
.lk-choices { display: flex; flex-direction: column; gap: 3px; }
.lk-choice { display: flex; align-items: flex-start; gap: 7px; text-align: left; cursor: pointer;
  border: 1px solid var(--borderColor, #d0d7de); border-radius: 5px; background: var(--backgroundColor, #fff);
  color: var(--fontColor, #1f2328); padding: 4px 8px; font-family: inherit; font-size: 12.5px; line-height: 1.55; }
.lk-choice:hover:not(:disabled) { background: var(--menuActiveColor, #e5e5e5); }
.lk-choice:disabled { cursor: default; }
.lk-choice.on { border-color: var(--fontActiveColor, #0969da); background: var(--menuActiveColor, #e5e5e5); }
.lk-choice.ok { border-color: #4CAF50; background: rgba(76, 175, 80, .10); }
.lk-choice.no { border-color: #d93025; background: rgba(217, 48, 37, .08); }
.lk-choice-l { flex-shrink: 0; width: 17px; height: 17px; border-radius: 50%; border: 1px solid currentColor;
  display: inline-flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 600; margin-top: 1px; }
.lk-choice.on .lk-choice-l { background: var(--fontActiveColor, #0969da); color: var(--backgroundColor, #fff); border-color: var(--fontActiveColor, #0969da); }
.lk-choice.ok .lk-choice-l { background: #4CAF50; color: #fff; border-color: #4CAF50; }
.lk-choice.no .lk-choice-l { background: #d93025; color: #fff; border-color: #d93025; }
.lk-choice-b { min-width: 0; overflow-wrap: anywhere; }
.lk-atext { width: 100%; box-sizing: border-box; resize: vertical; min-height: 34px; max-height: 96px; padding: 5px 7px;
  border: 1px solid var(--borderColor, #d0d7de); border-radius: 5px; background: var(--backgroundColor, #fff);
  color: var(--fontColor, #1f2328); font-family: inherit; font-size: 12.5px; line-height: 1.55; outline: none; }
.lk-atext:focus { border-color: var(--fontActiveColor, #0969da); }
.lk-atext:disabled { opacity: .6; }
/* 判分裁决 */
.lk-verdict { font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.lk-verdict.ok { color: #4CAF50; }
.lk-verdict.no { color: #d93025; }
/* 「判不了分」说明：中性色，明确区别于"答错" */
.lk-ungraded { font-size: 11px; color: var(--borderColor, #888); display: inline-flex; align-items: center; gap: 4px; }
/* 质性判定的模型短评：讲对了什么 / 缺什么 */
.lk-assess-fb { font-size: 12px; line-height: 1.6; color: var(--fontColor, #1f2328); background: var(--menuColor, #f6f6f6);
  border-left: 2px solid var(--fontActiveColor, #0969da); border-radius: 4px; padding: 4px 8px; display: flex; gap: 5px; align-items: flex-start; }
/* AI 复核结论按裁决着色（中性=没给结论） */
.lk-assess-fb.lk-fb-ok { border-left-color: #4CAF50; }
.lk-assess-fb.lk-fb-no { border-left-color: #d93025; }
.lk-sep { width: 1px; height: 14px; background: var(--borderColor, #d0d7de); flex-shrink: 0; }

/* ===== 两段式：上=题面 / 下=三标签面板（答案 / 解析 / 参考切片） ===== */
/* 上段：题面正文（固定顶部、不被压缩；内容过长才滚动） */
.lk-front { padding: 3px 6px; overflow-y: auto; flex: 0 0 auto; min-height: 0; max-height: 34%; }
.lk-qtext { font-size: 14px; line-height: 1.6; color: var(--fontColor, #1f2328); }
/* 面板：头部（标签）+ 可滚动体，占满剩余高度 */
.lk-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--borderColor, #d0d7de); overflow: hidden; }
.lk-panel-head { display: flex; align-items: center; gap: 4px; padding: 3px 8px 1px; flex-shrink: 0; min-height: 20px; }
/* 面板内 答案/解析/参考切片 小标签（同一行内切换，未选中为灰） */
.lk-mini { cursor: pointer; border: none; background: none; padding: 1px 6px; border-radius: 5px; display: inline-flex; align-items: center; gap: 4px; }
.lk-mini:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-mini.on { color: var(--fontActiveColor, #0969da); background: var(--menuActiveColor, #e5e5e5); font-weight: 500; }
/* 解析：Markdown 渲染（不可用 pre-wrap，会撑开标签间空白）；粗细排版见全局 .learn-md */
.lk-diag { flex: 1; min-height: 0; overflow-y: auto; padding: 1px 8px 6px; }
.lk-diag-loading { font-size: 12px; color: var(--borderColor, #888); }
/* 解析页脚：持久化状态 + 重新生成 */
.lk-diag-foot { display: flex; align-items: center; gap: 6px; margin-top: 4px; padding-top: 3px; border-top: 1px dashed var(--borderColor, #d0d7de); font-size: 10.5px; color: var(--borderColor, #888); }
/* 流式输出光标（与 home/答疑一致） */
.lk-caret { display: inline-block; width: 6px; height: 13px; margin-left: 2px; vertical-align: -2px; background: var(--fontActiveColor, #0969da); animation: lk-blink 1s steps(1) infinite; }
@keyframes lk-blink { 50% { opacity: 0; } }
/* 答案正文：占满面板、pre-wrap 保留换行、滚动 */
.lk-btext { flex: 1; min-height: 0; overflow-y: auto; padding: 1px 8px 6px; font-size: 12.5px; line-height: 1.7; color: var(--fontColor, #1f2328); white-space: pre-wrap; }
/* 参考切片容器：占满面板、纵向滚动（scoll 美化滚动条）；每片用 block_md 渲染 */
.lk-slices { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 6px; display: flex; flex-direction: column; gap: 5px; }
.lk-slice { border: 1px dashed var(--borderColor, #d0d7de); border-radius: 5px; padding: 4px 6px; flex-shrink: 0; min-width: 0; overflow-wrap: anywhere; }
.lk-slice-label { font-size: 10px; color: var(--fontActiveColor, #0969da); margin-bottom: 3px; word-break: break-all; }
/* 切片内的宽内容（长代码/表格/图）在片内滚动，不撑宽面板 */
.lk-slice :deep(pre), .lk-slice :deep(table) { max-width: 100%; overflow-x: auto; }
.lk-slice :deep(img), .lk-slice :deep(svg) { max-width: 100%; height: auto; }
.lk-slice :deep(.mermaid-wrapper) { max-width: 100%; overflow: hidden; }
.lk-empty { margin: auto; text-align: center; color: var(--borderColor, #888); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.lk-empty i { font-size: 18px; }
.lk-empty p { font-size: 12px; }
</style>
