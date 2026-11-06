<!-- LearnOverview.vue — 学习 · 总览 -->
<script setup lang="ts">
import { useLearningContext } from './context'
import overview from './overview.vue'

const ctx = useLearningContext()
</script>

<template>
  <div class="view-wrap">
    <overview
      :store="ctx.store"
      :vm="ctx.vm"
      :streak="ctx.streak"
      :days="ctx.trendTotals"
      :days30="ctx.trend30Totals"
      :wrong-count="ctx.wrongList.length"
      :total-practice="ctx.stats.totalPractice"
      :total-correct="ctx.stats.totalCorrect"
      @review="ctx.startReviewAll"
      @practice="(k: any) => ctx.startPractice(k)"
      @mistakes="ctx.go('mistakes')"
      @map="ctx.go('map')"
    />
  </div>
</template>

<style scoped>
.view-wrap { display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
.view-wrap > :deep(*) { flex:1; min-height:0; }
</style>
