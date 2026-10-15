<!--
  AskUserDialog.vue — ask_user 结构化问答弹窗（单选 / 多选 / 多题 / 自定义回答）

  契约对齐 DSH ask_user_question：每题可给 options（radio 单选、checkbox 多选），
  也可以不给 options（自由填写）；**每题都留自定义回答位**，并与选项并存提交；
  留空且不选 = 跳过该题（回答里 selected 为空、无 custom）。

  纯展示组件：只收 questions + source，提交 answers / 取消两个事件；
  排队与 Promise 收口在 store/askUser.ts，宿主见 AskUserHost.vue。
-->
<template>
  <el-dialog
    :model-value="true"
    class="ask-user-dialog"
    :title="title"
    width="640px"
    top="8vh"
    append-to-body
    :close-on-click-modal="false"
    @close="$emit('cancel')"
  >
    <div class="au-body scoll">
      <div v-for="(q, i) in questions" :key="q.id" class="au-q">
        <div class="au-q-head">
          <span v-if="q.header" class="au-q-header">{{ q.header }}</span>
          <span class="au-q-index" v-if="questions.length > 1">{{ i + 1 }}/{{ questions.length }}</span>
          <span v-if="q.multiSelect" class="au-q-multi">{{ zh ? '可多选' : 'multi-select' }}</span>
        </div>
        <!-- 题干走 markdown 渲染（与聊天里其他 agent 文本一致） -->
        <div class="au-q-text agent-question-markdown" v-html="renderMarkdown(q.question)"></div>

        <div v-if="q.options && q.options.length" class="au-options">
          <el-checkbox-group v-if="q.multiSelect" v-model="pick(q.id).selected" class="au-group">
            <el-checkbox v-for="o in q.options" :key="o.label" :value="o.label" class="au-option">
              <span class="au-option-label">{{ o.label }}</span>
              <span v-if="isRecommended(o.label)" class="au-reco">{{ zh ? '推荐' : 'Recommended' }}</span>
              <span v-if="o.description" class="au-option-desc">{{ o.description }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <el-radio-group v-else v-model="pick(q.id).single" class="au-group">
            <el-radio v-for="o in q.options" :key="o.label" :value="o.label" class="au-option">
              <span class="au-option-label">{{ o.label }}</span>
              <span v-if="isRecommended(o.label)" class="au-reco">{{ zh ? '推荐' : 'Recommended' }}</span>
              <span v-if="o.description" class="au-option-desc">{{ o.description }}</span>
            </el-radio>
          </el-radio-group>
        </div>

        <el-input
          v-model="pick(q.id).custom"
          class="au-custom"
          type="textarea"
          :rows="q.options && q.options.length ? 2 : 3"
          resize="none"
          :placeholder="q.options && q.options.length
            ? (zh ? '也可以直接写下你的答案（可留空；不选也不填 = 跳过本题）' : 'Or type your own answer (optional; leave empty to skip)')
            : (zh ? '请输入你的回答（留空 = 跳过本题）' : 'Type your answer (leave empty to skip)')"
        />
      </div>
    </div>

    <template #footer>
      <span class="au-hint">{{ zh ? '未作答的题目会以「跳过」返回给智能体' : 'Unanswered questions are returned as skipped' }}</span>
      <el-button size="small" @click="$emit('cancel')">{{ zh ? '取消' : 'Cancel' }}</el-button>
      <el-button size="small" type="primary" @click="onSubmit">{{ zh ? '提交' : 'Submit' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { ElButton, ElCheckbox, ElCheckboxGroup, ElDialog, ElInput, ElRadio, ElRadioGroup } from 'element-plus'
import type { AskUserAnswer, AskUserQuestion } from '@/types/agent'
import { ASK_CUSTOM_MAX } from '@/shared/agentAsk'
import { renderQuestionMarkdown } from '@/lib/markdown/render'
import { usestore } from '@/store'
const store = usestore()

const props = defineProps<{
  questions: AskUserQuestion[]
  /** 提问方（智能体名 / 群成员名），用于标题 */
  source?: string
}>()

const emit = defineEmits<{
  (e: 'submit', answers: AskUserAnswer[]): void
  (e: 'cancel'): void
}>()

const zh = computed(() => store.locales !== 'en')
const title = computed(() => {
  const who = props.source ? `${props.source} · ` : ''
  return zh.value ? `${who}智能体提问` : `${who}Agent asks`
})

/** 每题一份编辑态：单选存单值，多选存数组，自定义回答单独存 */
const state = reactive<Record<string, { single: string; selected: string[]; custom: string }>>({})
function reset() {
  for (const key of Object.keys(state)) delete state[key]
  for (const q of props.questions) {
    state[q.id] = { single: '', selected: [], custom: '' }
  }
}
watch(() => props.questions, reset, { immediate: true, deep: false })

/** 惰性取某题的编辑态（正常由上面 watch 预建；这里兜底，模板可安全访问） */
function pick(id: string) {
  if (!state[id]) state[id] = { single: '', selected: [], custom: '' }
  return state[id]
}

const renderMarkdown = (s: string) => renderQuestionMarkdown(String(s || ''))

/** DSH 约定：推荐项放在第一位并在 label 末尾加 "(Recommended)" —— 这里只做视觉标记，不改 label */
function isRecommended(label: string): boolean {
  return /\(\s*recommend(ed)?\s*\)|（\s*推荐\s*）|\(推荐\)/i.test(String(label || ''))
}

function onSubmit() {
  const answers: AskUserAnswer[] = props.questions.map((q) => {
    const st = pick(q.id)
    const selected = q.multiSelect
      ? st.selected.slice()
      : (st.single ? [st.single] : [])
    const custom = String(st.custom || '').trim().slice(0, ASK_CUSTOM_MAX)
    const answer: AskUserAnswer = { id: q.id, selected }
    if (custom) answer.custom = custom
    return answer
  })
  emit('submit', answers)
}
</script>

<style scoped>
.au-body { max-height: 60vh; overflow-y: auto; padding-right: 4px; }
.au-q { padding: 10px 0; border-top: 1px dashed color-mix(in srgb, var(--fontColor) 14%, transparent); }
.au-q:first-child { border-top: none; padding-top: 0; }
.au-q-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.au-q-header {
  font-size: 11px; padding: 1px 6px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 10%, transparent);
}
.au-q-index, .au-q-multi { font-size: 11px; opacity: .55; }
.au-q-text { font-size: 13px; line-height: 1.6; }
.au-options { margin: 6px 0 4px 2px; }
.au-group { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.au-option { height: auto; margin-right: 0; padding: 2px 0; white-space: normal; }
.au-option-label { font-size: 13px; }
.au-reco {
  margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: 8px;
  color: #1a7f37; background: color-mix(in srgb, #1a7f37 14%, transparent);
}
.au-option-desc { display: block; font-size: 11px; opacity: .6; line-height: 1.5; }
.au-custom { margin-top: 6px; }
.au-hint { float: left; font-size: 11px; opacity: .55; line-height: 32px; }
</style>
