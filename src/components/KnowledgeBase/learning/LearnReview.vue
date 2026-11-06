<!-- LearnReview.vue — 学习 · 复习 -->
<script setup lang="ts">
import { useLearningContext } from './context'
import reviewView from './reviewView.vue'

const ctx = useLearningContext()
</script>

<template>
  <div class="view-wrap">
    <reviewView :store="ctx.store" :due="ctx.dueList" @start-all="ctx.startReviewAll" @review="ctx.startReviewOne" />
  </div>
</template>

<style scoped>
.view-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.view-wrap > :deep(*) { flex: 1; min-height: 0; }
</style>
