<!--
  PlanReviewHost.vue — 计划评审弹窗宿主（挂在 App.vue，全局唯一）

  把 store/planReview 的队首计划渲染成 PlanReviewDialog，并把裁决转发回队列。
  普通聊天 / 集群成员 / 控制台都通过 store/planReview.requestPlanReview 排队，
  因此评审界面只有这一份。
-->
<template>
  <PlanReviewDialog
    v-if="currentReview"
    :key="currentReview.reviewId"
    :plan="currentReview.plan"
    :source="currentReview.source"
    @approve="onApprove"
    @keep="onKeep"
    @dismiss="onDismiss"
  />
</template>

<script setup lang="ts">
import PlanReviewDialog from '@/components/agent/PlanReviewDialog.vue'
import { currentReview, submitPlanReview } from '@/store/planReview'

function onApprove() {
  submitPlanReview('approve')
}
function onKeep(feedback: string) {
  submitPlanReview('keep', feedback)
}
function onDismiss() {
  submitPlanReview('dismiss')
}
</script>
