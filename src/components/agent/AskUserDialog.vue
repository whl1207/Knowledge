<!--
  AskUserDialog.vue — ask_user 结构化问答弹窗（单选 / 多选 / 多题左右翻页 / 自定义回答）

  外观对齐「创建文件夹」那一类 ElMessageBox（见 style.css 的 .el-message-box 段）：
  8px 内边距、13px 标题 + 标题下分割线、12px 正文、1px var(--borderColor) 边框、居中。

  契约对齐 DSH ask_user_question：每题可给 options（radio 单选、checkbox 多选），
  也可以不给 options（自由填写）；**每题都留自定义回答位**，并与选项并存提交；
  留空且不选 = 跳过该题（回答里 selected 为空、无 custom）。

  多题：**一次只渲染一题，左右翻页**（避免长列表把弹窗撑高）。
  每题编辑态按 q.id 存在 state 里，翻页不丢答案；提交时仍按 questions 原顺序产出全部答案。

  纯展示组件：只收 questions + source，提交 answers / 取消两个事件；
  排队与 Promise 收口在 store/askUser.ts，宿主见 AskUserHost.vue。
-->
<template>
  <el-dialog
    :model-value="true"
    class="ask-user-dialog"
    :title="title"
    width="460px"
    align-center
    append-to-body
    :close-on-click-modal="false"
    @close="$emit('cancel')"
  >
    <div class="au-body scoll">
      <div v-if="current" class="au-q">
        <div class="au-q-head">
          <span v-if="current.header" class="au-q-header">{{ current.header }}</span>
          <span v-if="current.multiSelect" class="au-q-multi">{{ zh ? '可多选' : 'multi-select' }}</span>
        </div>
        <!-- 题干走 markdown 渲染（与聊天里其他 agent 文本一致） -->
        <div class="au-q-text agent-question-markdown" v-html="renderMarkdown(current.question)"></div>

        <div v-if="current.options && current.options.length" class="au-options">
          <el-checkbox-group v-if="current.multiSelect" v-model="pick(current.id).selected" class="au-group">
            <el-checkbox v-for="o in current.options" :key="o.label" :value="o.label" class="au-option">
              <span class="au-option-label">{{ o.label }}</span>
              <span v-if="isRecommended(o.label)" class="au-reco">{{ zh ? '推荐' : 'Recommended' }}</span>
              <span v-if="o.description" class="au-option-desc">{{ o.description }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <el-radio-group v-else v-model="pick(current.id).single" class="au-group">
            <el-radio v-for="o in current.options" :key="o.label" :value="o.label" class="au-option">
              <span class="au-option-label">{{ o.label }}</span>
              <span v-if="isRecommended(o.label)" class="au-reco">{{ zh ? '推荐' : 'Recommended' }}</span>
              <span v-if="o.description" class="au-option-desc">{{ o.description }}</span>
            </el-radio>
          </el-radio-group>
        </div>

        <el-input
          v-model="pick(current.id).custom"
          class="au-custom"
          type="textarea"
          :rows="current.options && current.options.length ? 2 : 3"
          resize="none"
          :placeholder="current.options && current.options.length
            ? (zh ? '也可以直接写下你的答案（可留空；不选也不填 = 跳过本题）' : 'Or type your own answer (optional; leave empty to skip)')
            : (zh ? '请输入你的回答（留空 = 跳过本题）' : 'Type your answer (leave empty to skip)')"
        />
      </div>
    </div>

    <template #footer>
      <div class="au-foot">
        <!-- 多题：左右翻页（单题不显示这行） -->
        <div v-if="total > 1" class="au-pager">
          <button
            class="au-nav" :disabled="index <= 0"
            :title="zh ? '上一题' : 'Previous question'"
            @click="go(-1)"
          ><i class="fa fa-chevron-left"></i></button>
          <span class="au-pager-count">
            {{ index + 1 }} / {{ total }}
            <span v-if="answeredCount" class="au-pager-answered">{{ zh ? `已答 ${answeredCount}` : `${answeredCount} answered` }}</span>
          </span>
          <button
            class="au-nav" :disabled="index >= total - 1"
            :title="zh ? '下一题' : 'Next question'"
            @click="go(1)"
          ><i class="fa fa-chevron-right"></i></button>
        </div>
        <div class="au-foot-main">
          <span class="au-hint">{{ zh ? '未作答的题目会以「跳过」返回给智能体' : 'Unanswered questions are returned as skipped' }}</span>
          <el-button size="small" @click="$emit('cancel')">{{ zh ? '取消' : 'Cancel' }}</el-button>
          <el-button size="small" type="primary" @click="onSubmit">{{ zh ? '提交' : 'Submit' }}</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
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

// ---- 分页：多题时一次只显示一题，左右翻页 ----
const index = ref(0)
const total = computed(() => props.questions.length)
const current = computed<AskUserQuestion | undefined>(() => props.questions[index.value])
function go(step: number) {
  const next = index.value + step
  if (next < 0 || next > total.value - 1) return
  index.value = next
}

/** 已作答题数（选项或自定义回答任一非空）；翻页进度旁给个提示 */
const answeredCount = computed(() => props.questions.filter((q) => {
  const st = state[q.id]
  if (!st) return false
  return !!st.single || st.selected.length > 0 || String(st.custom || '').trim() !== ''
}).length)

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
.au-body { max-height: 46vh; overflow-y: auto; padding-right: 2px; }
.au-q { padding: 0; }
.au-q-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; min-height: 15px; }
.au-q-header {
  font-size: 10px; padding: 1px 5px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 10%, transparent);
}
.au-q-multi { font-size: 10px; opacity: .55; }
.au-q-text { font-size: 12px; line-height: 1.5; }
.au-options { margin: 5px 0 2px 1px; }
.au-group { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; }
/* 选项行：圆点/勾选框固定，文字块占满剩余宽度（题干里带描述时描述另起一行、左对齐） */
.au-option {
  display: flex; align-items: flex-start; width: 100%; height: auto;
  margin-right: 0; padding: 1px 0; white-space: normal;
}
.au-option :deep(.el-radio__input),
.au-option :deep(.el-checkbox__input) { flex-shrink: 0; margin-top: 1px; }
.au-option :deep(.el-radio__label),
.au-option :deep(.el-checkbox__label) {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px;
  flex: 1; min-width: 0; padding-left: 6px; font-size: 12px; line-height: 1.45;
}
.au-option-label { font-size: 12px; }
.au-reco {
  font-size: 10px; padding: 0 5px; border-radius: 8px;
  color: #1a7f37; background: color-mix(in srgb, #1a7f37 14%, transparent);
}
.au-option-desc { flex-basis: 100%; font-size: 11px; opacity: .6; line-height: 1.4; }
.au-custom { margin-top: 5px; }

/* 页脚：第一行翻页（多题才有），第二行提示 + 取消/提交 */
.au-foot { display: flex; flex-direction: column; gap: 6px; }
.au-pager { display: flex; align-items: center; justify-content: center; gap: 8px; }
.au-nav {
  width: 20px; height: 20px; padding: 0; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  cursor: pointer; font-size: 10px; transition: all .12s;
}
.au-nav:hover:not(:disabled) { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.au-nav:disabled { opacity: .35; cursor: default; }
.au-pager-count { font-size: 11px; opacity: .8; min-width: 62px; text-align: center; }
.au-pager-answered { margin-left: 4px; opacity: .7; }
.au-foot-main { display: flex; align-items: center; gap: 6px; }
.au-hint { flex: 1; min-width: 0; text-align: left; font-size: 11px; opacity: .55; }
/* 底部按钮按内容宽：全局 style.css / 其他组件里存在 button{width:100%} 之类的规则，
   不写死宽度时按钮会被撑满整行、把左边的提示挤成竖排 */
.au-foot-main :deep(.el-button) { width: auto; flex: none; }
</style>

<!--
  弹窗外壳：el-dialog 的 DOM 根是 teleport 进 body 的 .el-dialog（Element Plus 内部组件），
  父组件的 data-v 作用域 id 传不到它身上，scoped 选择器配不上，因此外壳规则只能放全局块
  （与 workflow 的 .wf-dialog 同一套写法）。

  外观抄 style.css 里的 .el-message-box（创建文件夹/重命名那个框）：
  8px 内边距、13px 标题 + 标题下分割线、12px 正文、1px var(--borderColor) 边框；
  垂直水平居中由模板上的 align-center 负责。

  选择器都带 .el-dialog 前缀：Element Plus 自己在 .el-dialog 上也声明了这几个
  --el-dialog-* 变量（同权重、且顺序可能在后面），不加一层权重压不住。
-->
<style>
.el-dialog.ask-user-dialog {
  --el-dialog-padding-primary: 8px;
  --el-dialog-title-font-size: 13px;
  --el-dialog-content-font-size: 12px;
  border: 1px solid var(--borderColor, #d0d7de);
  border-radius: 6px;
  max-width: calc(100vw - 24px);
}
.el-dialog.ask-user-dialog .el-dialog__header {
  padding-bottom: 5px;
  padding-right: 24px;
  margin-right: 0;
  border-bottom: 1px solid var(--borderColor, #d0d7de);
}
.el-dialog.ask-user-dialog .el-dialog__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--fontActiveColor);
}
.el-dialog.ask-user-dialog .el-dialog__headerbtn {
  top: 0; right: 0; width: 26px; height: 26px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 14px;
}
.el-dialog.ask-user-dialog .el-dialog__body { padding: 8px 0 0; }
.el-dialog.ask-user-dialog .el-dialog__footer { padding-top: 8px; }
</style>
