<script setup lang="ts">
import { computed } from 'vue'
import { fmtPct } from '@/services/learningCore'
import type { EntityItem } from '@/components/learning/types'

const props = defineProps<{ store: any; items: EntityItem[]; showAll: boolean }>()
const emit = defineEmits<{ practice: [name: string]; review: [name: string] }>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)

const sorted = computed(() => {
  const arr = props.items.filter(it => props.showAll || it.attempts > 0 || it.blockCount === 0)
  return arr.slice().sort((a, b) => {
    if ((a.due ? 1 : 0) !== (b.due ? 1 : 0)) return b.due ? 1 : -1
    if (a.attempts !== b.attempts) return b.attempts - a.attempts
    return a.label.localeCompare(b.label)
  })
})
const pct = (m: number) => Math.round(m * 100)
const stLabel = (s: string) =>
  s === 'mastered' ? tr('已掌握', 'Mastered') : s === 'learning' ? tr('学习中', 'Learning') : ''
</script>

<template>
  <div class="lk-body scoll">
    <div v-if="!sorted.length" class="lk-empty">
      <i class="fa fa-eercast"></i>
      <p>{{ tr('没有可显示的实体。先在「按文件」练习，作答会按切片关联到本体实体。', 'No entities to show. Practice by file first; answers project onto ontology entities.') }}</p>
    </div>
    <div v-for="it in sorted" :key="it.name" class="lk-card">
      <!-- 头部：左=实体名/元信息，右=操作按钮（练习在右上方） -->
      <div class="lk-head">
        <div class="lk-title" @click="it.blockCount > 0 && emit('practice', it.name)" :title="tr('开始练习该实体关联切片', 'Practice this entity')">
          <span class="lk-name">
            {{ it.label }}
            <i v-if="it.blockCount === 0 && it.attempts > 0" class="fa fa-exclamation-triangle" :title="tr('关联切片已不在当前知识库', 'Linked slices no longer in KB')"></i>
          </span>
          <span class="lk-meta">
            {{ it.blockCount }} {{ tr('切片', 'slices') }} · {{ it.fileCount }} {{ tr('文件', 'files') }} · {{ it.attempts }} {{ tr('作答', 'answers') }}
            <span v-if="it.due" class="lk-due"> · {{ tr('到期', 'Due') }}</span>
          </span>
        </div>
        <div class="lk-actions">
          <button class="lk-icon act" :disabled="it.blockCount === 0" @click="emit('practice', it.name)" :title="tr('练习该实体关联切片', 'Practice this entity')"><i class="fa fa-pencil-square-o"></i></button>
          <button v-if="it.due && it.blockCount > 0" class="lk-icon due" @click="emit('review', it.name)" :title="tr('到期复习', 'Review')"><i class="fa fa-refresh"></i></button>
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
    </div>
  </div>
</template>

<style scoped>
/* lk-body：多列卡片网格（与地图一致） */
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
.lk-due { color: #d93025; }
.lk-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 2px; flex-shrink: 0; }
/* 纯图标按钮：无边框无背景 */
.lk-icon { background: none; border: none; padding: 3px 5px; cursor: pointer; font-size: 14px; color: var(--fontColor, #1f2328); border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; }
.lk-icon:hover:not(:disabled) { background: var(--menuActiveColor, #e5e5e5); color: var(--fontActiveColor); }
.lk-icon:disabled { opacity: 0.35; cursor: not-allowed; }
.lk-icon.act { color: var(--fontActiveColor); }
.lk-icon.due { color: #FF9800; }
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
</style>
