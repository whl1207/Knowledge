<!-- LearnMistakes.vue — 学习 · 错题本 -->
<script setup lang="ts">
import { useLearningContext } from './context'
import mistakesView from './mistakesView.vue'

const ctx = useLearningContext()
</script>

<template>
  <div class="view-wrap">
    <mistakesView
      :store="ctx.store"
      :kb="ctx.kb"
      :model="ctx.model"
      :lang="ctx.contentLang"
      :explains="ctx.explains"
      :wrong="ctx.wrongList"
      @explain-save="ctx.doSaveExplain"
      @explain-drop="ctx.doDropExplain"
      @practice-one="(k: any, bid: any) => ctx.startPractice(k, bid)"
      @update-err="ctx.doSetErr"
      @ask="ctx.ask"
    />
  </div>
</template>

<style scoped>
.view-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.view-wrap > :deep(*) { flex: 1; min-height: 0; }
</style>
