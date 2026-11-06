<!-- LearnExam.vue — 学习 · 考试 -->
<script setup lang="ts">
import { useLearningContext } from './context'
import examView from './examView.vue'

const ctx = useLearningContext()
</script>

<template>
  <div class="map-shell exam-host">
    <div class="view-wrap">
      <examView
        :store="ctx.store"
        :blocks="ctx.kb.blocks"
        :model="ctx.model"
        :kb-path="ctx.selectedPath"
        :exam-track="ctx.examTrack"
        @updateState="(s: any) => { ctx.stateMsg = s }"
        @updateLiveState="(s: any) => { ctx.liveMsg = s }"
        @update-exam-track="(v: any) => { ctx.examTrack = v }"
        @exam-graded="ctx.onExamGraded"
        @ask="ctx.ask"
      />
    </div>
  </div>
</template>

<style scoped>
.map-shell { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.exam-host { flex: 1; min-height: 0; }
.view-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.view-wrap > :deep(*) { flex: 1; min-height: 0; }
</style>
