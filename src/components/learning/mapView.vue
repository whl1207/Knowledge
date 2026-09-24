<script setup lang="ts">
import { computed, ref } from 'vue'
import { fmtDue, fmtPct, kbTypeLabel, kbTypeIcon, type KbType } from '@/services/learningCore'
import type { LvmItem } from '@/components/learning/types'

const props = defineProps<{
  store: any
  vm: LvmItem[]
  showStale: boolean
}>()
const emit = defineEmits<{
  practice: [key: string]
  review: [key: string]
  clearStale: [key: string]
  relearn: [key: string]
  claimMastered: [key: string]
  setType: [key: string, type: KbType]
}>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)

const sorted = computed(() => {
  const rank = (s: string) => (s === 'mastered' ? 2 : s === 'learning' ? 1 : 0)
  const arr = props.vm.filter(it => props.showStale || !it.stale)
  return arr.slice().sort((a, b) => {
    if ((a.due ? 1 : 0) !== (b.due ? 1 : 0)) return b.due ? 1 : -1
    if (rank(a.status) !== rank(b.status)) return rank(b.status) - rank(a.status)
    return a.label.localeCompare(b.label)
  })
})
const confirm = ref('')
const pct = (m: number) => Math.round(m * 100)
const stLabel = (s: string) =>
  s === 'mastered' ? tr('已掌握', 'Mastered') : s === 'learning' ? tr('学习中', 'Learning') : ''
// 知识类型：显示 + 循环切换
const TYPE_CYCLE: KbType[] = ['memory', 'procedure', 'concept', 'design']
const typeLabel = (t?: KbType) => kbTypeLabel(t || 'memory', props.store.locales === 'zh')
const typeIcon = (t?: KbType) => kbTypeIcon(t || 'memory')
function cycleType(it: LvmItem) {
  const i = TYPE_CYCLE.indexOf(it.type)
  const nx = TYPE_CYCLE[(i + 1) % TYPE_CYCLE.length]
  emit('setType', it.key, nx)
}
</script>

<template>
  <div class="lk-body scoll">
    <div v-if="!sorted.length" class="lk-empty">
      <i class="fa fa-map-o"></i>
      <p>{{ tr('暂无学习对象。去「考试」或选择文件开始练习后会在此出现。', 'No objects yet. They appear after you practice.') }}</p>
    </div>
    <div v-for="it in sorted" :key="it.key" class="lk-card">
      <!-- 头部：左=文件名/元信息，右=操作按钮（练习在右上方） -->
      <div class="lk-head">
        <div class="lk-title" @click="emit('practice', it.key)" :title="tr('开始练习本文件', 'Practice this file')">
          <span class="lk-name">
            {{ it.label }}
            <i v-if="it.stale" class="fa fa-exclamation-triangle" :title="tr('知识库已更新，此记录已过期', 'KB updated, records stale')"></i>
          </span>
          <span class="lk-meta">
            <span class="lk-type" :title="tr('知识类型（点击图标可切换，影响复习节奏）', 'Knowledge type (click its icon to switch review pacing)')">[{{ typeLabel(it.type) }}]</span>
            {{ it.sliceCount }} {{ tr('切片', 'slices') }} · {{ it.qCount }} {{ tr('题', 'Q') }} · {{ it.attempts }} {{ tr('作答', 'answers') }}
            <span v-if="it.due" class="lk-due"> · {{ fmtDue(it.dueAt, store.locales === 'zh') }}</span>
          </span>
        </div>
        <div class="lk-actions">
          <button class="lk-icon type" @click="cycleType(it)" :title="tr('类型：' + typeLabel(it.type) + '（点击切换）', 'Type: ' + typeLabel(it.type) + ' (click to change)')"><i class="fa" :class="typeIcon(it.type)"></i></button>
          <button v-if="it.status !== 'mastered' && !it.stale" class="lk-icon claim" @click="emit('claimMastered', it.key)" :title="tr('声明已掌握（跳测：认为已会，跳过学习）', 'Claim mastered (test-out: skip studying it)')"><i class="fa fa-check-circle"></i></button>
          <button class="lk-icon act" @click="emit('practice', it.key)" :title="tr('练习本文件', 'Practice this file')"><i class="fa fa-pencil-square-o"></i></button>
          <button v-if="it.due && !it.stale" class="lk-icon due" @click="emit('review', it.key)" :title="tr('到期复习', 'Review')"><i class="fa fa-refresh"></i></button>
          <template v-if="it.stale">
            <button class="lk-icon" @click="emit('clearStale', it.key)" :title="tr('清除过期标记（记录保留）', 'Clear stale marker (records kept)')"><i class="fa fa-undo"></i></button>
            <button class="lk-icon danger" @click="confirm = it.key" :title="tr('清空此文件作答并重新学习', 'Reset attempts & relearn')"><i class="fa fa-eraser"></i></button>
          </template>
        </div>
      </div>
      <!-- 底部：横向掌握进度条（颜色按状态，new 为空条） -->
      <div class="lk-foot">
        <div class="lk-prog" :class="it.status">
          <div class="lk-prog-fill" :style="{ width: pct(it.mastery) + '%' }"></div>
        </div>
        <span v-if="stLabel(it.status)" class="lk-stat" :class="it.status">{{ stLabel(it.status) }}</span>
        <span class="lk-pct">{{ fmtPct(it.mastery) }}</span>
      </div>
      <!-- 重置确认 -->
      <div v-if="confirm === it.key" class="lk-confirm">
        <span>{{ tr('确定清空该文件全部作答记录并重学？', 'Reset all attempts of this file & relearn?') }}</span>
        <button class="lk-btn danger" @click="emit('relearn', it.key); confirm = ''">{{ tr('确定清空', 'Yes, reset') }}</button>
        <button class="lk-btn" @click="confirm = ''">{{ tr('取消', 'Cancel') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* lk-body：多列卡片网格（窄卡 tile） */
.lk-body { padding: 5px; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 6px; align-content: start; height: 100%; box-sizing: border-box; overflow-y: auto; }
.lk-body:has(.lk-empty) { display: flex; align-items: center; justify-content: center; }
.lk-empty { text-align: center; color: var(--borderColor, #888); }
.lk-empty i { font-size: 18px; }
.lk-empty p { font-size: 12px; }
.lk-card { border: 1px solid var(--borderColor, #d0d7de); border-radius: 6px; display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; }
/* 头部：标题区 + 右上按钮 */
.lk-head { display: flex; align-items: flex-start; gap: 8px; }
.lk-title { flex: 1; min-width: 0; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.lk-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fontActiveColor); }
.lk-name i { margin-left: 4px; color: #FF9800; }
.lk-meta { font-size: 11px; color: var(--fontColor); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lk-type { color: var(--fontActiveColor); }
.lk-due { color: #d93025; }
.lk-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 2px; flex-shrink: 0; }
/* 纯图标按钮：无边框无背景 */
.lk-icon { background: none; border: none; padding: 3px 5px; cursor: pointer; font-size: 14px; color: var(--fontColor, #1f2328); border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; }
.lk-icon:hover { background: var(--menuActiveColor, #e5e5e5); color: var(--fontActiveColor); }
.lk-icon.act { color: var(--fontActiveColor); }
.lk-icon.type { color: var(--borderColor, #888); }
.lk-icon.claim { color: #4CAF50; }
.lk-icon.due { color: #FF9800; }
.lk-icon.danger { color: #d93025; }
.lk-btn { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 4px; font-size: 11px; padding: 2px 8px; white-space: nowrap; }
.lk-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-btn.danger { color: #d93025; border-color: #d93025; }
/* 底部横向掌握进度条 */
.lk-foot { display: flex; align-items: center; gap: 8px; }
.lk-prog { flex: 1; min-width: 0; height: 6px; border-radius: 3px; background: var(--borderColor, #d0d7de); overflow: hidden; }
.lk-prog-fill { height: 100%; border-radius: 3px; background: #9aa0a6; transition: width 0.3s; }
.lk-prog.mastered .lk-prog-fill { background: #4CAF50; }
.lk-prog.learning .lk-prog-fill { background: #FF9800; }
.lk-stat { font-size: 11px; white-space: nowrap; }
.lk-stat.mastered { color: #4CAF50; }
.lk-stat.learning { color: #FF9800; }
.lk-pct { font-size: 11px; color: var(--fontColor, #1f2328); min-width: 34px; text-align: right; white-space: nowrap; }
.lk-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--fontColor, #1f2328); }
</style>
