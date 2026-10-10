<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import block_md from '@/components/block_md.vue'
import * as kbAi from '@/shared/kbAiClient'
import { diagramPrompt } from '@/services/learningPrompt'
import { explainCacheKey } from '@/services/learningRecord'
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
  result: [ok: boolean]
  close: []
  /** 生成完成：由父级写回 .learning */
  explainSave: [key: string, text: string, kind: 'explain' | 'diagram', lang: 'zh' | 'en']
  /** 重新生成前清旧值 */
  explainDrop: [key: string]
}>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)
/** AI 输出的语言：界面中文 + 知识库非英文 → 中文；界面英文或英文库 → 英文 */
const promptZh = () => props.store.locales === 'zh' && props.lang !== 'en'

// 答案区显示开关（自测用：整块面板可隐藏）
const showPanel = ref(true)

const ans = (ok: boolean) => {
  if (!props.item) return
  emit('result', ok)
}

// ==================== 三标签：答案 / 解析 / 参考切片 ====================
// - 答案：item.back（问题库生成的答案，或来源切片正文）
// - 解析：按需调用大模型生成（一句话核心 / 前置概念 / 分步推理 / 易混点 / 知识结构图）
// - 参考切片：出处切片，用 block_md 渲染（支持公式 / 表格 / mermaid）
const midTab = ref<'ans' | 'explain' | 'slices'>('ans')
const explain = ref('')
const explainLoading = ref(false)
const explainStreaming = ref(false)   // 流式追写中（显示光标）
const explainAt = ref(0)              // 已保存解析的生成时间（0=本次新生成未落盘/无缓存）
const hasSlices = computed(() => !!(props.item?.slices && props.item.slices.length))
/** 解析缓存 key：随题目变化（题干改了 -> 指纹变了 -> 自动重新生成） */
const explainKey = computed(() => (props.item ? explainCacheKey('diagram', props.item.blockId, props.item.q) : ''))
/** 该题已保存的解析 */
const cachedExplain = computed(() => (explainKey.value ? props.explains?.[explainKey.value] : undefined))

watch(() => props.item, () => {
  midTab.value = 'ans'
  explain.value = ''
  explainLoading.value = false
  explainStreaming.value = false
  explainAt.value = 0
})

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
/** 切换标签（解析按需生成；同时确保面板可见） */
function setTab(tab: 'ans' | 'explain' | 'slices') {
  midTab.value = tab
  showPanel.value = true
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
      <!-- 顶部条：问题标签 + 自评按钮（固定行，不随内容滚动） -->
      <div class="lk-headbar">
        <span class="lk-side-label"><i class="fa fa-question-circle-o"></i> {{ tr('问题 · 对照下方自评', 'Question · self-grade below') }}</span>
        <span style="flex:1;"></span>
        <!-- 自测：整块答案区可隐藏 -->
        <button class="lk-btn toggle" :class="{ on: showPanel }" @click="showPanel = !showPanel"
          :title="tr('显示/隐藏答案区（自测时可先隐藏）', 'Show / hide the answer area (hide it for self-testing)')">
          <i class="fa" :class="showPanel ? 'fa-eye' : 'fa-eye-slash'"></i>{{ tr('答案区', 'Answer area') }}
        </button>
        <button class="lk-btn ok" @click="ans(true)" :title="tr('答对了，加深记忆', 'Got it right')"><i class="fa fa-check"></i> {{ tr('记得（对）', 'Knew it') }}</button>
        <button class="lk-btn" @click="ans(false)" :title="tr('印象模糊，近期再复习', 'Fuzzy — review soon')"><i class="fa fa-question"></i> {{ tr('模糊', 'Fuzzy') }}</button>
        <button class="lk-btn miss" @click="ans(false)" :title="tr('没答上来，标记为错', 'Forgot — mark as wrong')"><i class="fa fa-times"></i> {{ tr('忘了（错）', 'Forgot') }}</button>
        <span class="lk-sep"></span>
        <button class="lk-btn" @click="emit('close')" :title="tr('结束本组练习', 'End this session')"><i class="fa fa-times"></i></button>
      </div>
      <!-- 上段：题面正文 -->
      <div class="lk-front scoll">
        <div class="lk-qtext">{{ item.q }}</div>
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
