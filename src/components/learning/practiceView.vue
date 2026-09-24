<script setup lang="ts">
import { ref } from 'vue'
import type { PracticeItem } from '@/components/learning/types'

const props = defineProps<{
  store: any
  item: PracticeItem | null
}>()
const emit = defineEmits<{ result: [ok: boolean]; close: [] }>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)

// 显示开关：答案 / 参考切片（右上按钮，位于自评按钮左侧）
const showAns = ref(true)
const showSlice = ref(true)

const ans = (ok: boolean) => {
  if (!props.item) return
  emit('result', ok)
}
</script>

<template>
  <div class="lk-body">
    <!-- 完成态：无题目 -->
    <div v-if="!item" class="lk-empty">
      <i class="fa fa-flag-checkered"></i>
      <p>{{ tr('本组练习完成，可在下方状态栏查看本次对错', 'All done — see the session stats in the status bar below') }}</p>
      <button class="lk-btn" @click="emit('close')"><i class="fa fa-times"></i> {{ tr('结束', 'End') }}</button>
    </div>
    <!-- 答题卡：文件名/进度/对错在底部状态栏 -->
    <div v-else class="lk-card">
      <!-- 顶部条：问题标签 + 自评按钮（固定行，不随内容滚动） -->
      <div class="lk-headbar">
        <span class="lk-side-label"><i class="fa fa-question-circle-o"></i> {{ tr('问题 · 对照下方答案自评', 'Question · self-grade vs the answer below') }}</span>
        <span style="flex:1;"></span>
        <!-- 显示开关：答案 / 切片（位于自评按钮左侧） -->
        <button class="lk-btn toggle" :class="{ on: showAns }" @click="showAns = !showAns"
          :title="tr('显示/隐藏答案', 'Show / hide answer')">
          <i class="fa" :class="showAns ? 'fa-eye' : 'fa-eye-slash'"></i>{{ tr('答案', 'Answer') }}
        </button>
        <button v-if="item.hasAnswer && item.slices && item.slices.length" class="lk-btn toggle"
          :class="{ on: showSlice }" @click="showSlice = !showSlice"
          :title="tr('显示/隐藏参考切片', 'Show / hide reference slices')">
          <i class="fa" :class="showSlice ? 'fa-eye' : 'fa-eye-slash'"></i>{{ tr('切片', 'Slices') }}
        </button>
        <button class="lk-btn ok" @click="ans(true)" :title="tr('答对了，加深记忆', 'Got it right')"><i class="fa fa-check"></i> {{ tr('记得（对）', 'Knew it') }}</button>
        <button class="lk-btn" @click="ans(false)" :title="tr('印象模糊，近期再复习', 'Fuzzy — review soon')"><i class="fa fa-question"></i> {{ tr('模糊', 'Fuzzy') }}</button>
        <button class="lk-btn miss" @click="ans(false)" :title="tr('没答上来，标记为错', 'Forgot — mark as wrong')"><i class="fa fa-times"></i> {{ tr('忘了（错）', 'Forgot') }}</button>
        <span class="lk-sep"></span>
        <button class="lk-btn" @click="emit('close')" :title="tr('结束本组练习', 'End this session')"><i class="fa fa-times"></i></button>
      </div>
      <!-- 三段式：上=问题 / 中=答案 / 下=切片，各自独立滚动 -->
      <!-- 上段：题面正文 -->
      <div class="lk-front scoll">
        <div class="lk-qtext">{{ item.q }}</div>
      </div>

      <!-- 中段：答案（可开关） -->
      <div v-if="showAns" class="lk-panel lk-ans">
        <div class="lk-panel-head lk-side-label"><i class="fa" :class="item.hasAnswer ? 'fa-check-circle-o' : 'fa-file-text-o'"></i>
          {{ item.hasAnswer ? tr('答案', 'Answer') : tr('参考答案（来源切片）', 'Reference (source slice)') }}</div>
        <div class="lk-btext scoll">{{ item.back || tr('（无答案/正文）', '(no content)') }}</div>
      </div>

      <!-- 下段：参考切片（出处，可开关） -->
      <div v-if="showSlice && item.hasAnswer && item.slices && item.slices.length" class="lk-panel lk-sl">
        <div class="lk-panel-head lk-side-label"><i class="fa fa-files-o"></i> {{ tr('参考切片（出处）', 'Reference slices') }}</div>
        <div class="lk-slices scoll">
          <div v-for="(s, si) in item.slices" :key="si" class="lk-slice">
            <div class="lk-slice-label">[{{ si + 1 }}] {{ s.label }}</div>
            <div class="lk-slice-body">{{ s.content }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lk-body { padding: 4px; display: flex; flex-direction: column; gap: 5px; height: 100%; box-sizing: border-box; overflow: hidden; }
/* 统一按钮：等高、flex 内容居中 */
.lk-btn {
  cursor: pointer;
  border: 1px solid var(--borderColor, #d0d7de);
  background: var(--backgroundColor, #fff);
  color: var(--fontColor, #1f2328);
  border-radius: 5px;
  font-size: 12px;
  height: 30px;
  padding: 0 12px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.lk-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-btn.ok { color: #4CAF50; border-color: #4CAF50; }
.lk-btn.miss { color: #d93025; border-color: #d93025; }
.lk-btn.wide { min-width: 120px; }
/* 开关态（右上角 答案/切片） */
.lk-btn.toggle { padding: 0 8px; }
.lk-btn.toggle.on { color: var(--fontActiveColor, #0969da); border-color: var(--fontActiveColor, #0969da); background: var(--menuActiveColor, #e5e5e5); }
.lk-card { flex: 1; min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--borderColor, #d0d7de); border-radius: 8px; overflow: hidden; }
/* 顶部条：题面标签 + 右上操作按钮（固定行，不随题面滚动） */
.lk-headbar { display: flex; align-items: center; gap: 3px; padding: 2px 3px 1px; flex-shrink: 0; flex-wrap: wrap; }
/* 顶部条内按钮更紧凑：矮一点、内边距小一点 */
.lk-headbar .lk-btn { height: 24px; padding: 0 7px; font-size: 11px; gap: 3px; }
.lk-side-label { font-size: 11px; color: var(--borderColor, #888); white-space: nowrap; }
.lk-sep { width: 1px; height: 14px; background: var(--borderColor, #d0d7de); flex-shrink: 0; }

/* ===== 三段式：上=问题 / 中=答案 / 下=切片 ===== */
/* 上段：题面正文（固定顶部、不被压缩；内容过长才滚动） */
.lk-front { padding: 3px 6px; overflow-y: auto; flex: 0 0 auto; min-height: 0; max-height: 34%; }
.lk-qtext { font-size: 14px; line-height: 1.6; color: var(--fontColor, #1f2328); }
/* 中段 / 下段：面板（各自头部 + 可滚动体，段间以上边框分隔） */
.lk-panel { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--borderColor, #d0d7de); overflow: hidden; }
/* 答案段：高度按内容自适应（内容多少占多少）；内容过长时封顶滚动，避免挤掉切片 */
.lk-ans { flex: 0 1 auto; max-height: 45%; }
.lk-panel-head { display: flex; align-items: center; gap: 4px; padding: 3px 8px 1px; flex-shrink: 0; min-height: 20px; }
/* 答案正文：占满面板、pre-wrap 保留换行、滚动 */
.lk-btext { flex: 1; min-height: 0; overflow-y: auto; padding: 1px 8px 6px; font-size: 12.5px; line-height: 1.7; color: var(--fontColor, #1f2328); white-space: pre-wrap; }
/* 参考切片容器：占满面板、纵向滚动（scoll 美化滚动条） */
.lk-slices { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 8px 6px; display: flex; flex-direction: column; gap: 5px; }
.lk-slice { border: 1px dashed var(--borderColor, #d0d7de); border-radius: 5px; padding: 4px 6px; flex-shrink: 0; }
.lk-slice-label { font-size: 10px; color: var(--fontActiveColor, #0969da); margin-bottom: 3px; word-break: break-all; }
.lk-slice-body { font-size: 12px; line-height: 1.6; color: var(--fontColor, #1f2328); white-space: pre-wrap; }
.lk-empty { margin: auto; text-align: center; color: var(--borderColor, #888); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.lk-empty i { font-size: 18px; }
.lk-empty p { font-size: 12px; }
</style>
