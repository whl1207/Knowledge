<!--
  AskUserHost.vue — ask_user 弹窗宿主（挂在 App.vue，全局唯一）

  只做两件事：把 store/askUser 的队首问题渲染成 AskUserDialog；把提交/取消转发回队列。
  所有入口（普通聊天 / 集群成员 / 控制台 / 工作流）都通过 store/askUser.requestUserAnswers 提问，
  因此弹窗样式与交互只有这一份。
-->
<template>
  <AskUserDialog
    v-if="currentAsk"
    :key="currentAsk.askId"
    :questions="currentAsk.questions"
    :source="currentAsk.source"
    @submit="onSubmit"
    @cancel="onCancel"
  />
</template>

<script setup lang="ts">
import AskUserDialog from '@/components/agent/AskUserDialog.vue'
import { cancelAsk, currentAsk, submitAsk } from '@/store/askUser'
import type { AskUserAnswer } from '@/types/agent'

function onSubmit(answers: AskUserAnswer[]) {
  submitAsk(answers)
}
function onCancel() {
  cancelAsk()
}
</script>
