<!--
  AttentionItemRow.vue — 「待我处理」里的一条（提问 / 计划评审）

  设计约束（见 docs/plan/待我处理收件箱-实施方案（逐文件）.md）：
  - 标题是**动作化的一句话**，来自数据（不由 UI 从状态码拼装）；空串用兜底文案；
  - 每行最多 2 个常驻按钮（主操作 + 打开原处），其余收进「更多」；
  - 提问类不提供「忽略」：只能回答，或明确「停止会话」（忽略一个还在等的 agent 等于把它晾死）；
  - 回答表单与聊天里的模态**共用** useAskForm 的口径（多题 / 单选 / 多选 / 自定义 / 跳过）。

  动作全部转发到 store/attention（最终走 agentBridge.answer / cancel，不新开通道）。
-->
<template>
  <div class="at-row" :class="[`at-${item.group}`, { 'at-answering': answering, 'at-keeping': keeping }]">
    <div class="at-head">
      <span class="at-dot"></span>
      <div class="at-body">
        <div class="at-title" :title="titleText">{{ titleText }}</div>
        <div class="at-meta">
          <span class="at-kind">{{ kindLabel }}</span>
          <span v-if="item.sessionLabel" class="at-src" :title="item.sessionLabel">{{ item.sessionLabel }}</span>
          <span v-if="timeText" class="at-time">{{ timeText }}</span>
        </div>

        <div class="at-actions">
          <button v-if="primaryAction" class="at-btn primary" :disabled="busy" @click.stop="onAction(primaryAction)">
            {{ primaryAction.label[lang] }}
          </button>
          <button v-if="openAction" class="at-btn" :disabled="busy" @click.stop="onAction(openAction)">
            {{ openAction.label[lang] }}
          </button>
          <button
            v-if="moreActions.length"
            class="at-btn at-more"
            :class="{ on: moreOpen }"
            :title="zh ? '更多' : 'More'"
            @click.stop="moreOpen = !moreOpen"
          ><i class="fa fa-ellipsis-h"></i></button>
        </div>

        <div v-if="moreOpen && moreActions.length" class="at-actions at-more-row">
          <button
            v-for="a in moreActions"
            :key="a.id"
            class="at-btn"
            :class="{ danger: a.danger }"
            :disabled="busy"
            @click.stop="onAction(a)"
          >{{ a.label[lang] }}</button>
        </div>
      </div>
    </div>

    <!-- 计划原文（点标题行展开）：批准前至少要能看见它 -->
    <div v-if="item.kind === 'plan'" class="at-plan-wrap">
      <button class="at-plan-toggle" @click.stop="planOpen = !planOpen">
        <i class="fa" :class="planOpen ? 'fa-chevron-down' : 'fa-chevron-right'"></i>
        {{ planOpen ? (zh ? '收起计划' : 'Hide plan') : (zh ? '查看计划' : 'View plan') }}
      </button>
      <div v-if="planOpen" class="at-plan agent-question-markdown scoll" v-html="planHtml"></div>
    </div>

    <!-- 继续完善：就地收反馈（与计划评审弹窗同一语义：feedback 进 answers[0].custom） -->
    <div v-if="keeping" class="at-inline">
      <el-input
        v-model="feedback"
        type="textarea"
        :rows="2"
        resize="none"
        :placeholder="zh ? '告诉它要改什么（可留空）' : 'What should change? (optional)'"
      />
      <div class="at-inline-foot">
        <el-button size="small" @click="keeping = false">{{ zh ? '取消' : 'Cancel' }}</el-button>
        <el-button size="small" type="primary" :disabled="busy" @click="submitKeep">{{ zh ? '提交反馈' : 'Send' }}</el-button>
      </div>
    </div>

    <!-- 行内回答（问句 + 选项 + 自定义；多题左/右翻页，与模态一致） -->
    <div v-if="answering" class="at-inline at-ask">
      <div v-if="current" class="at-q">
        <div class="at-q-head">
          <span v-if="current.header" class="at-q-header">{{ current.header }}</span>
          <span v-if="current.multiSelect" class="at-q-multi">{{ zh ? '可多选' : 'multi-select' }}</span>
        </div>
        <div class="at-q-text agent-question-markdown" v-html="renderMarkdown(current.question)"></div>

        <div v-if="current.options && current.options.length" class="at-options">
          <el-checkbox-group v-if="current.multiSelect" v-model="pick(current.id).selected" class="at-group">
            <el-checkbox v-for="o in current.options" :key="o.label" :value="o.label" class="at-option">
              <span class="at-option-label">{{ o.label }}</span>
              <span v-if="isRecommended(o.label)" class="at-reco">{{ zh ? '推荐' : 'Recommended' }}</span>
              <span v-if="o.description" class="at-option-desc">{{ o.description }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <el-radio-group v-else v-model="pick(current.id).single" class="at-group">
            <el-radio v-for="o in current.options" :key="o.label" :value="o.label" class="at-option">
              <span class="at-option-label">{{ o.label }}</span>
              <span v-if="isRecommended(o.label)" class="at-reco">{{ zh ? '推荐' : 'Recommended' }}</span>
              <span v-if="o.description" class="at-option-desc">{{ o.description }}</span>
            </el-radio>
          </el-radio-group>
        </div>

        <el-input
          v-model="pick(current.id).custom"
          class="at-custom"
          type="textarea"
          :rows="current.options && current.options.length ? 2 : 3"
          resize="none"
          :placeholder="current.options && current.options.length
            ? (zh ? '也可以直接写下你的答案（可留空；不选也不填 = 跳过本题）' : 'Or type your own answer (optional; leave empty to skip)')
            : (zh ? '请输入你的回答（留空 = 跳过本题）' : 'Type your answer (leave empty to skip)')"
        />
      </div>

      <div class="at-inline-foot">
        <div v-if="total > 1" class="at-pager">
          <button class="at-nav" :disabled="index <= 0" @click.stop="go(-1)"><i class="fa fa-chevron-left"></i></button>
          <span class="at-pager-count">{{ index + 1 }} / {{ total }}<span v-if="answeredCount" class="at-pager-answered">{{ zh ? `已答 ${answeredCount}` : `${answeredCount} answered` }}</span></span>
          <button class="at-nav" :disabled="index >= total - 1" @click.stop="go(1)"><i class="fa fa-chevron-right"></i></button>
        </div>
        <div class="at-inline-btns">
          <el-button size="small" @click="answering = false">{{ zh ? '取消' : 'Cancel' }}</el-button>
          <el-button
            v-if="canSkipSubmit"
            size="small"
            :disabled="busy"
            :title="zh ? '把未作答的题目按「跳过」返回并提交' : 'Return unanswered questions as skipped and submit'"
            @click="onSkipSubmit"
          >{{ zh ? '跳过并提交' : 'Submit skipped' }}</el-button>
          <el-button
            size="small"
            type="primary"
            :disabled="primaryDisabled"
            :title="primaryTitle"
            @click="onPrimary"
          >{{ primaryLabel }}</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElButton, ElCheckbox, ElCheckboxGroup, ElInput, ElRadio, ElRadioGroup } from 'element-plus'
import type { AttentionAction, AttentionItem } from '@/types/attention'
import { fallbackTitle, relativeTime } from '@/lib/attention/model'
import { renderQuestionMarkdown } from '@/lib/markdown/render'
import { useAskForm } from '@/composables/useAskForm'
import { answerItem, decideItem, openSource, stopSession } from '@/store/attention'
import { usestore } from '@/store'

const props = defineProps<{ item: AttentionItem }>()
const store = usestore()
const zh = computed(() => store.locales !== 'en')
const lang = computed<'zh' | 'en'>(() => (zh.value ? 'zh' : 'en'))

const busy = ref(false)
const moreOpen = ref(false)
const answering = ref(false)
const keeping = ref(false)
const planOpen = ref(false)
const feedback = ref('')

const titleText = computed(() => props.item.title || fallbackTitle(props.item.kind, zh.value))
const timeText = computed(() => relativeTime(props.item.at, Date.now(), zh.value))
const kindLabel = computed(() => {
  const k = props.item.kind
  if (k === 'question') return zh.value ? '提问' : 'Question'
  if (k === 'plan') return zh.value ? '计划评审' : 'Plan review'
  if (k === 'run-failed') return zh.value ? '运行失败' : 'Run failed'
  if (k === 'run-ready') return zh.value ? '待验收' : 'Ready'
  return zh.value ? '系统' : 'System'
})

const primaryAction = computed<AttentionAction>(() => props.item.actions.find((a) => a.primary) || props.item.actions[0])
const openAction = computed<AttentionAction | undefined>(() => props.item.actions.find((a) => a.id === 'open'))
const moreActions = computed<AttentionAction[]>(() => props.item.actions.filter((a) => a !== primaryAction.value && a !== openAction.value))

const planHtml = computed(() => renderQuestionMarkdown(String(props.item.payload.plan || '')))
const renderMarkdown = (s: string) => renderQuestionMarkdown(String(s || ''))

const { pick, index, total, current, go, answeredCount, allAnswered, firstUnansweredIndex, isRecommended, buildAnswers } =
  useAskForm(() => props.item.payload.questions)

const primaryDisabled = computed(() =>
  busy.value
  || (!allAnswered.value && index.value >= total.value - 1 && firstUnansweredIndex.value === index.value)
)
const primaryLabel = computed(() => {
  if (allAnswered.value) return zh.value ? '提交' : 'Submit'
  if (index.value < total.value - 1) return zh.value ? '下一题' : 'Next'
  if (firstUnansweredIndex.value === index.value) return zh.value ? '请先回答本题' : 'Answer this first'
  return zh.value ? '补答未答' : 'Go to unanswered'
})
const primaryTitle = computed(() => {
  if (allAnswered.value) return zh.value ? '提交全部答案' : 'Submit all answers'
  if (index.value < total.value - 1) return zh.value ? '还有题目未答，先进入下一题' : 'More questions remain; go to the next one'
  return zh.value ? '还有题目未答，先补答（也可用「跳过并提交」）' : 'Some questions are unanswered; go back to them (or submit with skips)'
})
const canSkipSubmit = computed(() => !allAnswered.value && answeredCount.value > 0)

function onPrimary(): void {
  if (busy.value) return
  if (allAnswered.value) {
    void submitAnswer()
    return
  }
  if (index.value < total.value - 1) {
    go(1)
    return
  }
  if (firstUnansweredIndex.value >= 0 && firstUnansweredIndex.value !== index.value) {
    index.value = firstUnansweredIndex.value
  }
}

function onSkipSubmit(): void {
  if (busy.value || !canSkipSubmit.value) return
  void submitAnswer()
}

async function onAction(action: AttentionAction): Promise<void> {
  if (!action || busy.value) return
  if (action.id === 'answer') {
    answering.value = true
    keeping.value = false
    return
  }
  if (action.id === 'open') {
    openSource(props.item)
    return
  }
  if (action.id === 'stop-session') {
    busy.value = true
    await stopSession(props.item)
    busy.value = false
    return
  }
  if (action.id === 'keep-planning') {
    keeping.value = true
    answering.value = false
    return
  }
  if (action.id === 'approve' || action.id === 'dismiss') {
    busy.value = true
    await decideItem(props.item, action.id === 'approve' ? 'approve' : 'dismiss')
    busy.value = false
  }
}

async function submitAnswer(): Promise<void> {
  if (busy.value) return
  busy.value = true
  const ok = await answerItem(props.item, buildAnswers())
  busy.value = false
  if (ok) answering.value = false
}

async function submitKeep(): Promise<void> {
  if (busy.value) return
  busy.value = true
  const ok = await decideItem(props.item, 'keep', feedback.value)
  busy.value = false
  if (ok) keeping.value = false
}
</script>

<style scoped>
.at-row {
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  padding: 7px 8px;
  margin-bottom: 6px;
  background: var(--backgroundColor);
}
.at-head { display: flex; align-items: flex-start; gap: 7px; }
/* 状态点：橙 = 等你决定，蓝 = 等你验收（P1 只会出现橙） */
.at-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-top: 5px;
  background: #e6a23c;
}
.at-decide .at-dot { background: #e6a23c; }
.at-answer .at-dot { background: #e6a23c; }
.at-review .at-dot { background: #409eff; }
.at-problem .at-dot { background: #f56c6c; }
.at-system .at-dot { background: #909399; }
.at-body { flex: 1; min-width: 0; }
.at-title {
  font-size: 12.5px; font-weight: 600; line-height: 1.45; color: var(--fontActiveColor);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.at-meta { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 10.5px; opacity: .62; min-width: 0; }
.at-kind { flex-shrink: 0; }
.at-src { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
.at-time { flex-shrink: 0; margin-left: auto; }
.at-actions { display: flex; align-items: center; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.at-actions.at-more-row { margin-top: 4px; }
.at-btn {
  height: 22px; padding: 0 8px; font-size: 11px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  transition: all .12s;
}
.at-btn:hover:not(:disabled) { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.at-btn.primary { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.at-btn.danger:hover:not(:disabled) { border-color: #f56c6c; color: #f56c6c; }
.at-btn:disabled { opacity: .45; cursor: default; }
.at-btn.at-more { width: 22px; padding: 0; }
.at-btn.at-more.on { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }

.at-plan-wrap { margin-top: 6px; }
.at-plan-toggle {
  border: none; background: none; padding: 0; cursor: pointer;
  font-size: 11px; color: var(--fontColor); opacity: .7;
}
.at-plan-toggle:hover { opacity: 1; color: var(--fontActiveColor); }
.at-plan {
  margin-top: 5px; max-height: 34vh; overflow: auto; font-size: 11.5px; line-height: 1.5;
  border-left: 2px solid var(--borderColor); padding: 2px 0 2px 8px;
}

.at-inline { margin-top: 7px; border-top: 1px dashed var(--borderColor); padding-top: 7px; }
.at-inline-foot { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.at-inline-btns { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.at-inline-foot :deep(.el-button) { width: auto; flex: none; }
.at-hint { font-size: 10.5px; opacity: .5; }
.at-pager { display: flex; align-items: center; gap: 8px; }
.at-nav {
  width: 20px; height: 20px; padding: 0; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  cursor: pointer; font-size: 10px;
}
.at-nav:hover:not(:disabled) { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.at-nav:disabled { opacity: .35; cursor: default; }
.at-pager-count { font-size: 10.5px; opacity: .75; min-width: 54px; text-align: center; }
.at-pager-answered { margin-left: 4px; opacity: .7; }

.at-q-head { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; min-height: 14px; }
.at-q-header { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: color-mix(in srgb, var(--fontColor) 10%, transparent); }
.at-q-multi { font-size: 10px; opacity: .55; }
.at-q-text { font-size: 12px; line-height: 1.5; }
.at-options { margin: 5px 0 2px 1px; }
.at-group { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; }
.at-option { display: flex; align-items: flex-start; width: 100%; height: auto; margin-right: 0; padding: 1px 0; white-space: normal; }
.at-option :deep(.el-radio__input), .at-option :deep(.el-checkbox__input) { flex-shrink: 0; margin-top: 1px; }
.at-option :deep(.el-radio__label), .at-option :deep(.el-checkbox__label) {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px;
  flex: 1; min-width: 0; padding-left: 6px; font-size: 12px; line-height: 1.45;
}
.at-option-label { font-size: 12px; }
.at-reco { font-size: 10px; padding: 0 5px; border-radius: 8px; color: #1a7f37; background: color-mix(in srgb, #1a7f37 14%, transparent); }
.at-option-desc { flex-basis: 100%; font-size: 11px; opacity: .6; line-height: 1.4; }
.at-custom { margin-top: 5px; }
</style>
