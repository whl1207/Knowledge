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
    @suspend="onSuspend"
    @abort="onAbort"
  />
</template>

<script setup lang="ts">
import AskUserDialog from '@/components/agent/AskUserDialog.vue'
import { abortAsk, currentAsk, submitAsk, suspendAsk } from '@/store/askUser'
import { pushNotice } from '@/store/notices'
import { usestore } from '@/store'
import type { AskUserAnswer } from '@/types/agent'

function onSubmit(answers: AskUserAnswer[]) {
  submitAsk(answers)
}
/**
 * 关闭 / 「稍后回答」= 挂起：只收起弹窗，**不中止 agent turn**。
 * 问题仍在主进程会话的 pendingQuestion 里，会出现在「待我处理」收件箱；
 * 用户可以在那里回答，或点「停止会话」明确中止。
 */
function onSuspend() {
  // 弹窗被 agent 侧收口（dismissAsk）而卸载时也可能触发 close：队列已空则什么都不做，
  // 不能误报「已挂起」（那时任务其实已经结束/被取消）。
  if (!currentAsk.value) return
  suspendAsk()
  const zh = usestore().locales !== 'en'
  pushNotice('info', zh
    ? '提问已挂起：智能体仍在等你回答，可在「待我处理」里作答或停止。'
    : 'Question suspended: the agent is still waiting. Answer or stop it from “Needs me”.')
}
/** 只有弹窗里的「中止任务」才真正停掉 turn */
function onAbort() {
  abortAsk()
}
</script>
