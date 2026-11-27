<script setup lang="ts">
import { fmtDue, fmtPct } from '@/services/learningCore'
import type { LvmItem } from '@/components/KnowledgeBase/learning/types'

const props = defineProps<{ store: any; due: LvmItem[] }>()
const emit = defineEmits<{ startAll: []; review: [key: string] }>()
const tr = (zh: string, en: string) => (props.store?.locales === 'zh' ? zh : en)
</script>

<template>
  <div class="lk-body">
    <div class="lk-head">
      <span style="flex:1;"></span>
      <button v-if="due.length" class="lk-btn" @click="emit('startAll')"><i class="fa fa-play"></i> {{ tr('复习全部', 'Review all') }}</button>
    </div>
    <div class="lk-list scoll">
      <div v-if="!due.length" class="lk-empty">
        <i class="fa fa-check-circle-o"></i>
        <p>{{ tr('暂无到期复习。掌握的对象会按间隔自动加入此队列。', 'Nothing due. Mastered objects re-enter here on schedule.') }}</p>
      </div>
      <div v-for="it in due" :key="it.key" class="lk-row">
        <div class="lk-row-top">
          <span class="lk-name" :title="it.label">{{ it.label }}</span>
          <span class="lk-tag due">{{ tr('到期', 'Due') }}</span>
        </div>
        <div class="lk-meta">{{ fmtDue(it.dueAt, store.locales === 'zh') }} · {{ it.attempts }} {{ tr('作答', 'answers') }}</div>
        <div class="lk-bar" :title="tr('掌握度', 'Mastery') + ' ' + fmtPct(it.mastery)">
          <span :style="{ width: Math.round(it.mastery * 100) + '%' }"></span>
        </div>
        <div class="lk-row-foot">
          <span class="lk-pct">{{ tr('掌握', 'Mastery') }} {{ fmtPct(it.mastery) }}</span>
          <button class="lk-btn" @click="emit('review', it.key)"><i class="fa fa-refresh"></i> {{ tr('复习', 'Review') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lk-body { padding: 5px; display: flex; flex-direction: column; gap: 6px; height: 100%; box-sizing: border-box; overflow: hidden; }
.lk-head { display: flex; align-items: center; font-size: 13px; flex-shrink: 0; }
.lk-list { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; align-content: start; padding: 2px; }
.lk-row { display: flex; flex-direction: column; align-items: stretch; gap: 6px; border: 1px solid var(--borderColor, #d0d7de); border-radius: 8px; padding: 10px; background: var(--backgroundColor, #fff); min-width: 0; }
.lk-row-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.lk-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lk-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lk-meta { font-size: 11px; color: var(--fontColor); opacity: .8; }
.lk-bar { height: 4px; border-radius: 2px; overflow: hidden; background: var(--menuActiveColor, #e5e5e5); }
.lk-bar span { display: block; height: 100%; border-radius: 2px; background: var(--fontActiveColor, #0969da); }
.lk-row-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.lk-pct { font-size: 10px; color: var(--borderColor, #888); }
.lk-tag.due { flex: 0 0 auto; font-size: 11px; color: #d93025; border: 1px solid #d93025; border-radius: 8px; padding: 1px 6px; }
.lk-btn { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 4px; font-size: 12px; padding: 3px 8px; }
.lk-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-empty { grid-column: 1 / -1; margin: auto; text-align: center; color: var(--borderColor, #888); }
.lk-empty i { font-size: 18px; }
.lk-empty p { font-size: 12px; }
</style>
