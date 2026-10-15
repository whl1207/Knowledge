<!--
  PlanReviewDialog.vue — 计划人工评审弹窗（exit_plan_mode）

  对齐 DSH 计划模式的退出评审：完整计划以 Markdown 原文呈现，用户三选一——
  - **批准执行**（Approve）：离开评审，agent 开始执行；
  - **继续完善**（Keep planning）：可附反馈，agent 据此修订后重新提交；
  - **关闭**（右上角 / 取消）：用户接手，agent 停下等指示。

  纯展示组件：收 plan + source，抛出 approve / keep / dismiss 三个事件。
-->
<template>
  <el-dialog
    :model-value="true"
    class="plan-review-dialog"
    :title="title"
    width="720px"
    top="6vh"
    append-to-body
    :close-on-click-modal="false"
    @close="$emit('dismiss')"
  >
    <div class="pr-body scoll">
      <div class="pr-tip">
        <i class="fa fa-hand-paper-o"></i>
        {{ zh ? '请审阅这份计划：批准后智能体才会开始动手。' : 'Review this plan — the agent starts only after you approve.' }}
      </div>
      <!-- 计划原文按 Markdown 渲染（与聊天里的 agent 正文同一套渲染） -->
      <div class="pr-plan agent-question-markdown" v-html="planHtml"></div>

      <div class="pr-feedback">
        <div class="pr-feedback-label">{{ zh ? '反馈（选择「继续完善」时告诉它要改什么）' : 'Feedback (for “Keep planning”)' }}</div>
        <el-input
          v-model="feedback"
          type="textarea"
          :rows="3"
          resize="none"
          :placeholder="zh ? '例如：第 2 步改成先备份数据库；不要动生产配置…' : 'e.g. back up the DB first; do not touch production config…'"
        />
      </div>
    </div>

    <template #footer>
      <el-button size="small" @click="$emit('dismiss')">{{ zh ? '关闭' : 'Close' }}</el-button>
      <el-button size="small" @click="onKeep">{{ zh ? '继续完善' : 'Keep planning' }}</el-button>
      <el-button size="small" type="primary" @click="$emit('approve')">{{ zh ? '批准执行' : 'Approve' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElButton, ElDialog, ElInput } from 'element-plus'
import { renderQuestionMarkdown } from '@/lib/markdown/render'
import { usestore } from '@/store'

const props = defineProps<{
  plan: string
  /** 提问方（智能体名 / 群成员名），用于标题 */
  source?: string
}>()

const emit = defineEmits<{
  (e: 'approve'): void
  (e: 'keep', feedback: string): void
  (e: 'dismiss'): void
}>()

const store = usestore()
const zh = computed(() => store.locales !== 'en')
const title = computed(() => {
  const who = props.source ? `${props.source} · ` : ''
  return zh.value ? `${who}计划评审` : `${who}Plan review`
})
const planHtml = computed(() => renderQuestionMarkdown(String(props.plan || '')))
const feedback = ref('')

function onKeep() {
  emit('keep', feedback.value.trim())
}
</script>

<style scoped>
.pr-body { max-height: 62vh; overflow-y: auto; padding-right: 4px; }
.pr-tip {
  font-size: 12px; opacity: .7; margin-bottom: 8px;
  display: flex; align-items: center; gap: 6px;
}
.pr-plan {
  font-size: 13px; line-height: 1.7; padding: 10px 12px; border-radius: 6px;
  background: color-mix(in srgb, var(--fontColor) 5%, transparent);
}
.pr-feedback { margin-top: 12px; }
.pr-feedback-label { font-size: 12px; opacity: .7; margin-bottom: 4px; }
</style>
