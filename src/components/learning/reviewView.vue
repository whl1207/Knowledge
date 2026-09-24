<script setup lang="ts">
import { fmtDue, fmtPct } from '@/services/learningCore'
import type { LvmItem } from '@/components/learning/types'

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
        <div class="lk-main">
          <span class="lk-name">{{ it.label }}</span>
          <span class="lk-meta">{{ fmtDue(it.dueAt, store.locales === 'zh') }} · {{ it.attempts }} {{ tr('作答', 'answers') }} · {{ tr('掌握', 'mastery') }} {{ fmtPct(it.mastery) }}</span>
        </div>
        <span class="lk-tag due">{{ tr('到期', 'Due') }}</span>
        <button class="lk-btn" @click="emit('review', it.key)"><i class="fa fa-refresh"></i> {{ tr('复习', 'Review') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lk-body { padding: 5px; display: flex; flex-direction: column; gap: 6px; height: 100%; box-sizing: border-box; overflow: hidden; }
.lk-head { display: flex; align-items: center; font-size: 13px; flex-shrink: 0; }
.lk-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.lk-row { display: flex; align-items: center; gap: 10px; border: 1px solid var(--borderColor, #d0d7de); border-radius: 6px; padding: 8px 10px; }
.lk-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.lk-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lk-meta { font-size: 11px; color: var(--fontColor); }
.lk-tag.due { font-size: 11px; color: #d93025; border: 1px solid #d93025; border-radius: 8px; padding: 1px 6px; }
.lk-btn { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 4px; font-size: 12px; padding: 3px 8px; }
.lk-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-empty { margin: auto; text-align: center; color: var(--borderColor, #888); }
.lk-empty i { font-size: 18px; }
.lk-empty p { font-size: 12px; }
</style>
