<script setup lang="ts">
import { ref } from 'vue'
import * as kbAi from '@/shared/kbAiClient'
import type { ErrType } from '@/services/learningRecord'

const props = defineProps<{
  store: any
  kb: any
  model: any
  wrong: { key: string; label: string; a: { id: string; q: string; at: number; src: string; blockId: any; note?: string; errType?: ErrType; answer?: string; hasAnswer?: boolean } }[]
}>()
const emit = defineEmits<{
  practiceOne: [key: string, blockId: any]
  updateErr: [key: string, id: string, errType: ErrType]
}>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)
const zh = () => props.store.locales === 'zh'

type WrongItem = (typeof props.wrong)[number]

/** 右侧详情当前选中的错题（null=已关闭） */
const active = ref<WrongItem | null>(null)
const isActive = (w: WrongItem) => !!active.value && active.value.a.id === w.a.id
function openToggle(w: WrongItem) {
  active.value = isActive(w) ? null : w
}
function closeDetail() {
  active.value = null
}

const expl = ref<Record<string, string>>({})
const explaining = ref<Record<string, boolean>>({})
const srcLabel = (s: string) =>
  s === 'self' ? tr('自测', 'Self') : s === 'exam' ? tr('考试', 'Exam') : tr('复习', 'Review')

// 错因标签选项（P2.5）
const ERR_OPTS: { key: ErrType; zh: string; en: string; cls: string }[] = [
  { key: 'memory', zh: '记忆混淆', en: 'Memory lapse', cls: 'm' },
  { key: 'concept', zh: '概念不清', en: 'Concept', cls: 'c' },
  { key: 'procedure', zh: '步骤错误', en: 'Procedure', cls: 'p' },
  { key: 'careless', zh: '粗心', en: 'Careless', cls: 'l' },
]
const errLabel = (t?: ErrType) => {
  const o = ERR_OPTS.find(x => x.key === t)
  return o ? (zh() ? o.zh : o.en) : ''
}
const errText = (o: { zh: string; en: string }) => (zh() ? o.zh : o.en)

function blockBack(blockId: any): string {
  const b = (props.kb?.blocks || []).find((x: any) => String(x.id) === String(blockId))
  return b ? String(b.A || '') : ''
}
/** 详情答案：优先作答时固化的快照；无快照的旧记录回退当前来源切片正文 */
function ansText(w: WrongItem): string {
  const ans = w.a.answer && w.a.answer.trim()
  if (ans) return ans
  return blockBack(w.a.blockId)
}
function fmt(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 就地 AI 讲解：基于来源切片解释该题要点（不跳转 QA） */
async function explain(w: WrongItem) {
  const id = w.a.id
  if (explaining.value[id]) return
  if (!props.model?.chat && !props.model?.process) {
    expl.value[id] = tr('未配置可用的 AI 模型（请到设置-模型配置）', 'No AI model configured (Settings → Models)')
    return
  }
  explaining.value[id] = true
  try {
    const slice = (w.a.answer && w.a.answer.trim()) || blockBack(w.a.blockId) || w.a.note || '(无切片原文)'
    const prompt = zh()
      ? `你是知识讲解老师。请针对下面这道错题，基于参考切片讲清核心知识点与正确答案的依据，用中文，200 字内，不要前后缀。\n\n题目：${w.a.q}\n\n【参考切片】\n${slice}`
      : `You are a tutor. Explain the key point and why the correct answer is right for this missed question, based on the reference slice, within 200 words.\n\nQuestion: ${w.a.q}\n\n[Reference]\n${slice}`
    const spec = kbAi.buildSpecFromModel(props.model, props.store)
    const out = await kbAi.chat(spec, [{ role: 'user', content: prompt }])
    expl.value[id] = String(out || '').trim() || tr('（无返回内容）', '(empty response)')
  } catch (e) {
    expl.value[id] = tr('讲解失败：', 'Explain failed: ') + (e instanceof Error ? e.message : String(e))
  } finally {
    explaining.value[id] = false
  }
}
</script>

<template>
  <div class="lk-body">
    <!-- 左侧：错题列表 -->
    <div class="lk-listcol scoll">
      <div v-if="!wrong.length" class="lk-empty">
        <i class="fa fa-thumbs-o-up"></i>
        <p>{{ tr('暂无错题。答错的题目会保留在这里。', 'No mistakes yet. Wrong answers are kept here.') }}</p>
      </div>
      <div
        v-for="(w, i) in wrong"
        :key="w.a.id || i"
        class="lk-item"
        :class="{ on: isActive(w) }"
        :title="w.a.q"
        @click="openToggle(w)"
      >
        <div class="lk-item-top">
          <span class="lk-src" :class="w.a.src">{{ srcLabel(w.a.src) }}</span>
          <span v-if="w.a.errType" class="lk-etag" :class="w.a.errType">{{ errLabel(w.a.errType) }}</span>
          <span style="flex:1;"></span>
          <span class="lk-time">{{ fmt(w.a.at) }}</span>
        </div>
        <div class="lk-q">{{ w.a.q }}</div>
      </div>
    </div>

    <!-- 右侧：点击后的详情（可关闭） -->
    <div class="lk-detailpane scoll">
      <template v-if="active">
        <div class="lk-detail-head">
          <span class="lk-file" :title="active.key"><i class="fa fa-file-text-o"></i> {{ active.label }}</span>
          <span class="lk-meta-line">{{ srcLabel(active.a.src) }} · {{ fmt(active.a.at) }}</span>
          <span style="flex:1;"></span>
          <!-- 操作按钮固定在头部（关闭按钮左侧）：切片过长时也不用到最底部找 -->
          <button class="lk-btn" @click="emit('practiceOne', active.key, active.a.blockId)"><i class="fa fa-pencil-square-o"></i> {{ tr('重练此题', 'Retry') }}</button>
          <button class="lk-btn" @click="explain(active)"><i class="fa fa-graduation-cap"></i> {{ tr('AI 讲解', 'Explain') }}</button>
          <button class="lk-close" @click="closeDetail" :title="tr('关闭详情', 'Close')"><i class="fa fa-times"></i></button>
        </div>
        <!-- 详情正文：头部固定，正文在此滚动 -->
        <div class="lk-detail-body scoll">
          <div class="lk-question">{{ active.a.q }}</div>
          <!-- 错因标注 -->
          <div class="lk-errs">
            <span class="lk-errs-title">{{ tr('错因', 'Reason') }}</span>
            <button
              v-for="o in ERR_OPTS"
              :key="o.key"
              class="lk-err"
              :class="[o.cls, { on: active.a.errType === o.key }]"
              :title="tr('标注此题为：' + errText(o), 'Tag this miss as: ' + errText(o))"
              @click="emit('updateErr', active.key, active.a.id, active.a.errType === o.key ? '' : o.key)"
            >{{ errText(o) }}</button>
            <button v-if="active.a.errType" class="lk-err clear" @click="emit('updateErr', active.key, active.a.id, '')">{{ tr('清除', 'Clear') }}</button>
          </div>
          <!-- 答案（优先作答时快照；无快照的旧记录回退当前来源切片） -->
          <div v-if="ansText(active)" class="lk-ref ans">
            <span class="lk-ref-label"><i class="fa" :class="active.a.hasAnswer ? 'fa-check-circle-o' : 'fa-file-text-o'"></i>
              {{ active.a.hasAnswer ? tr('答案', 'Answer') : tr('参考答案（来源切片）', 'Reference (source slice)') }}</span>{{ ansText(active) }}
          </div>
          <!-- 参考切片出处（问题库生成答案场景：可与答案对照） -->
          <div v-if="active.a.hasAnswer && blockBack(active.a.blockId)" class="lk-ref src">
            <span class="lk-ref-label"><i class="fa fa-files-o"></i> {{ tr('参考切片（出处）', 'Reference slices') }}</span>{{ blockBack(active.a.blockId) }}
          </div>
          <div v-if="!ansText(active)" class="lk-ref none">
            <span class="lk-ref-label">{{ tr('无答案', 'No answer') }}</span>{{ tr('（作答时未记录答案，且对应来源切片已更新/移除）', '(answer was not saved, and the source slice was updated/removed)') }}
          </div>
          <div v-if="explaining[active.a.id]" class="lk-expl"><i class="fa fa-spinner fa-spin"></i> {{ tr('讲解中…', 'Explaining…') }}</div>
          <div v-else-if="expl[active.a.id]" class="lk-expl">{{ expl[active.a.id] }}</div>
        </div>
      </template>
      <div v-else class="lk-detail-empty">
        <i class="fa fa-hand-pointer-o"></i>
        <p>{{ tr('在左侧选择一条错题，在此查看详情与错因标注', 'Pick a mistake on the left to see its details') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 主从两栏布局 */
.lk-body { padding: 5px; display: flex; gap: 6px; height: 100%; box-sizing: border-box; overflow: hidden; }
.lk-listcol { flex: 0 0 min(44%, 340px); min-width: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 2px; }
.lk-detailpane { flex: 1; min-width: 0; overflow: hidden; border: 1px solid var(--borderColor, #d0d7de); border-radius: 6px; display: flex; flex-direction: column; }
/* 左侧列表项 */
.lk-item { border: 1px solid var(--borderColor, #d0d7de); border-radius: 6px; padding: 6px 8px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.lk-item:hover { border-color: var(--fontActiveColor); }
.lk-item.on { border-color: var(--fontActiveColor); background: var(--menuActiveColor, #eee); }
.lk-item-top { display: flex; align-items: center; gap: 6px; }
.lk-src { font-size: 10px; padding: 0 5px; border-radius: 6px; border: 1px solid #d93025; color: #d93025; white-space: nowrap; }
.lk-etag { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--borderColor, #888); white-space: nowrap; }
.lk-etag.memory { color: #d93025; border-color: #d93025; }
.lk-etag.concept { color: #7c4dff; border-color: #7c4dff; }
.lk-etag.procedure { color: #FF9800; border-color: #FF9800; }
.lk-etag.careless { color: var(--borderColor, #888); }
.lk-time { font-size: 10px; color: var(--borderColor, #888); white-space: nowrap; }
.lk-q { font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--fontColor, #1f2328); }
/* 右侧详情 */
.lk-detail-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--borderColor, #d0d7de); flex-shrink: 0; flex-wrap: wrap; }
/* 头部操作按钮紧凑，随头部固定 */
.lk-detail-head .lk-btn { padding: 2px 8px; font-size: 11px; }
.lk-file { font-size: 12px; font-weight: 500; color: var(--fontColor, #1f2328); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lk-file i { margin-right: 4px; color: var(--borderColor, #888); }
.lk-meta-line { font-size: 11px; color: var(--borderColor, #888); white-space: nowrap; }
.lk-close { cursor: pointer; border: none; background: none; color: var(--borderColor, #888); font-size: 14px; padding: 2px 4px; border-radius: 4px; }
.lk-close:hover { color: #d93025; background: var(--menuActiveColor, #eee); }
.lk-question { font-size: 15px; line-height: 1.7; color: var(--fontColor, #1f2328); padding: 10px 12px 4px; white-space: pre-wrap; }
.lk-errs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 8px 12px; }
.lk-errs-title { font-size: 11px; color: var(--borderColor, #888); margin-right: 2px; }
.lk-err { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 8px; font-size: 11px; padding: 1px 8px; }
.lk-err.on { background: var(--menuActiveColor, #eee); font-weight: 500; }
.lk-err.m.on { color: #d93025; border-color: #d93025; }
.lk-err.c.on { color: #7c4dff; border-color: #7c4dff; }
.lk-err.p.on { color: #FF9800; border-color: #FF9800; }
.lk-err.l.on { color: var(--borderColor, #888); border-color: var(--borderColor, #888); }
.lk-ref { font-size: 12px; color: var(--fontColor, #1f2328); white-space: pre-wrap; line-height: 1.6; margin: 0 12px; border: 1px dashed var(--borderColor, #d0d7de); border-radius: 6px; padding: 8px; }
.lk-ref-label { display: block; font-size: 11px; color: #4CAF50; margin-bottom: 2px; }
.lk-ref.ans .lk-ref-label { color: #4CAF50; }
.lk-ref.src .lk-ref-label { color: var(--fontActiveColor, #0969da); }
.lk-ref.none { color: var(--borderColor, #888); }
/* 详情正文（头部固定，正文滚动） */
.lk-detail-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.lk-btn { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 4px; font-size: 12px; padding: 3px 10px; }
.lk-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-expl { font-size: 12px; line-height: 1.6; color: var(--fontColor, #1f2328); white-space: pre-wrap; background: var(--backgroundColor, #fff); border: 1px solid var(--borderColor, #d0d7de); border-radius: 4px; padding: 6px 8px; margin: 0 12px 10px; }
.lk-empty { margin: auto; text-align: center; color: var(--borderColor, #888); padding: 20px; }
.lk-empty i { font-size: 26px; }
.lk-empty p { font-size: 12px; }
.lk-detail-empty { margin: auto; text-align: center; color: var(--borderColor, #888); padding: 20px; }
.lk-detail-empty i { font-size: 30px; }
.lk-detail-empty p { font-size: 12px; }
</style>
