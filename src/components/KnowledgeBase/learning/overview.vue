<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LvmItem } from '@/components/KnowledgeBase/learning/types'

const props = defineProps<{
  store: any
  vm: LvmItem[]
  streak: number
  days: number[]
  days30: number[]
  wrongCount: number
  totalPractice: number
  totalCorrect: number
}>()
const emit = defineEmits<{ review: []; practice: [key: string]; mistakes: []; map: [] }>()
const tr = (zh: string, en: string) => (props.store.locales === 'zh' ? zh : en)

const viewDays = ref<'7' | '30'>('7')
const bars = computed(() => (viewDays.value === '7' ? props.days : props.days30))
const daysMax = computed(() => Math.max(1, ...bars.value))
const todayN = computed(() => (bars.value.length ? bars.value[bars.value.length - 1] : 0))

const active = computed(() => props.vm.filter(it => !it.stale))
const counted = computed(() => {
  const c = { mastered: 0, learning: 0, nnew: 0, due: 0 }
  for (const it of active.value) {
    if (it.due) c.due++
    if (it.status === 'mastered') c.mastered++
    else if (it.status === 'learning') c.learning++
    else c.nnew++
  }
  return c
})
/** 统计条（整体掌握 / 正确率 / 累计练习）：口径与移入前一致 —— 掌握%=已掌握/有效文件，正确%=正确/总作答 */
const pct = computed(() => {
  const n = active.value.length
  return n ? Math.round((counted.value.mastered / n) * 100) : 0
})
const totalActive = computed(() => active.value.length)
const masteryRingStyle = computed(() => {
  const total = Math.max(1, totalActive.value)
  const m = (counted.value.mastered / total) * 100
  const l = ((counted.value.mastered + counted.value.learning) / total) * 100
  return {
    background: `conic-gradient(#3fb950 0 ${m}%, #d29922 ${m}% ${l}%, var(--borderColor) ${l}% 100%)`,
  }
})
const masteryLegend = computed(() => [
  { key: 'mastered', color: '#3fb950', label: tr('已掌握', 'Mastered'), count: counted.value.mastered },
  { key: 'learning', color: '#d29922', label: tr('学习中', 'Learning'), count: counted.value.learning },
  { key: 'new', color: 'var(--borderColor)', label: tr('未开始', 'New'), count: counted.value.nnew },
])
const acc = computed(() =>
  props.totalPractice ? Math.round((props.totalCorrect / props.totalPractice) * 100) : 0
)
/** 建议练习的薄弱文件：有作答、未掌握、掌握度最低 */
const weakest = computed<LvmItem | null>(() => {
  const cands = active.value.filter(it => it.attempts > 0 && it.status === 'learning')
  if (!cands.length) return null
  return cands.slice().sort((a, b) => a.mastery - b.mastery)[0]
})
/** 尚未开始的文件（用于“开始学新文件”建议） */
const newCandidate = computed<LvmItem | null>(() => {
  const cands = active.value.filter(it => it.status === 'new')
  if (!cands.length) return null
  return cands.slice().sort((a, b) => a.label.localeCompare(b.label))[0]
})
const hasPractice = computed(() => active.value.some(it => it.attempts > 0))

const next = computed<{ icon: string; zh: string; en: string; btn?: { zh: string; en: string; act: 'review' | 'practice' | 'mistakes' | 'map'; key?: string } }>(() => {
  if (counted.value.due > 0) {
    return {
      icon: 'fa-refresh', zh: `有 ${counted.value.due} 个文件到期复习，趁热打铁巩固一下？`, en: `${counted.value.due} files are due for review — refresh them now?`,
      btn: { zh: '开始复习', en: 'Review now', act: 'review' },
    }
  }
  if (props.wrongCount > 0) {
    return {
      icon: 'fa-exclamation-circle', zh: `${props.wrongCount} 道错题待重练，先消灭薄弱点`, en: `${props.wrongCount} mistakes to retry — fix weak spots first`,
      btn: { zh: '去错题本', en: 'To mistakes', act: 'mistakes' },
    }
  }
  if (weakest.value) {
    return {
      icon: 'fa-pencil-square-o', zh: `「${weakest.value.label}」掌握度最低，练一练更快掌握`, en: `"${weakest.value.label}" has the lowest mastery — practice it`,
      btn: { zh: '练习此文件', en: 'Practice', act: 'practice', key: weakest.value.key },
    }
  }
  if (newCandidate.value) {
    return {
      icon: 'fa-plus-circle', zh: `还有 ${counted.value.nnew} 个文件没开始，先从「${newCandidate.value.label}」学起？`, en: `${counted.value.nnew} files not started — begin with "${newCandidate.value.label}"?`,
      btn: { zh: '开始学习', en: 'Start', act: 'practice', key: newCandidate.value.key },
    }
  }
  return {
    icon: 'fa-map-o',
    zh: hasPractice.value ? '都已掌握，可去学习地图复习或换个知识库' : '这个知识库还没有可学习的切片，先去「知识库」切片并保存 .kb',
    en: hasPractice.value ? 'All mastered — review in Map or switch KB' : 'No practiceable slices yet — slice & save in Knowledge Processing first',
    btn: { zh: tr('去学习地图', 'Go to Map'), en: 'Go to Map', act: 'map' },
  }
})

function doNext() {
  const b = next.value.btn
  if (!b) return
  if (b.act === 'review') emit('review')
  else if (b.act === 'practice' && b.key) emit('practice', b.key)
  else if (b.act === 'mistakes') emit('mistakes')
  else emit('map')
}
</script>

<template>
  <div class="lk-body scoll">
    <!-- 顶部：下一步建议（主视觉） -->
    <div class="lk-hero" @click="doNext">
      <div class="lk-hero-icon"><i class="fa" :class="next.icon"></i></div>
      <div class="lk-hero-main">
        <span class="lk-hero-eyebrow">{{ tr('下一步建议', 'Next step') }}</span>
        <div class="lk-hero-text">{{ props.store.locales === 'zh' ? next.zh : next.en }}</div>
      </div>
      <button v-if="next.btn" class="lk-hero-cta" @click.stop="doNext">
        {{ props.store.locales === 'zh' ? next.btn.zh : next.btn.en }}
        <i class="fa fa-arrow-right"></i>
      </button>
    </div>

    <!-- 主区：左=KPI + 趋势；右=掌握环图 -->
    <div class="lk-main">
      <div class="lk-left">
        <!-- KPI：整体掌握 / 正确率 / 累计练习 -->
        <div class="lk-kpis">
          <div class="lk-kpi">
            <span class="lk-kpi-label">{{ tr('整体掌握', 'Mastery') }}</span>
            <div class="lk-kpi-value">{{ pct }}<i>%</i></div>
            <span class="lk-kpi-sub">{{ counted.mastered }} / {{ totalActive }} {{ tr('文件', 'files') }}</span>
          </div>
          <div class="lk-kpi">
            <span class="lk-kpi-label">{{ tr('正确率', 'Accuracy') }}</span>
            <div class="lk-kpi-value">{{ acc }}<i>%</i></div>
            <span class="lk-kpi-sub">{{ totalCorrect }} / {{ totalPractice }} {{ tr('作答', 'answers') }}</span>
          </div>
          <div class="lk-kpi">
            <span class="lk-kpi-label">{{ tr('累计练习', 'Practice') }}</span>
            <div class="lk-kpi-value">{{ totalPractice }}<i>{{ tr('次', 'x') }}</i></div>
            <span class="lk-kpi-sub">{{ tr('连续', 'Streak') }} {{ streak }} {{ tr('天', 'd') }}</span>
          </div>
        </div>
        <!-- 左·下：连续打卡 + 7/30 天柱状 -->
        <div class="lk-card lk-trend-card">
        <div class="lk-t-head">
          <span class="lk-t-fire"><i class="fa fa-fire"></i> {{ tr('连续学习', 'Streak') }} <b>{{ streak }}</b> {{ tr('天', 'd') }}</span>
          <span class="lk-t-note">{{ tr('近 ' + viewDays + ' 天练习次数', 'Practice, last ' + viewDays + 'd') }} · {{ tr('今日', 'Today') }} {{ todayN }} {{ tr('次', 'x') }}</span>
          <span style="flex:1;"></span>
          <div class="lk-days-switch">
            <button class="lk-btn lk-btn-xs" :class="{ active: viewDays === '7' }" @click="viewDays = '7'">7{{ tr('天', 'd') }}</button>
            <button class="lk-btn lk-btn-xs" :class="{ active: viewDays === '30' }" @click="viewDays = '30'">30{{ tr('天', 'd') }}</button>
          </div>
        </div>
        <div class="lk-t-chart">
          <div class="lk-t-bars" :class="{ thin: viewDays === '30' }" :title="tr('柱高=当日练习次数（右=今天）', 'bar height = practice count (right = today)')">
            <div
              v-for="(n, i) in bars"
              :key="viewDays + '-' + i"
              class="lk-t-bar"
              :class="{ today: i === bars.length - 1, none: n === 0 }"
              :style="{ height: (n > 0 ? Math.max(6, Math.round((n / daysMax) * 100)) : 3) + '%' }"
              :title="tr('当天练习', 'that day') + ' ' + n"
            ></div>
          </div>
        </div>
      </div>

      </div>

      <!-- 右：整体掌握环图 -->
      <div class="lk-card lk-mastery">
        <div class="lk-m-title">{{ tr('整体掌握', 'Overall mastery') }}</div>
        <div class="lk-ring-wrap">
          <div class="lk-ring" :style="masteryRingStyle">
            <div class="lk-ring-hole">
              <b>{{ counted.mastered }}</b>
              <span>/ {{ totalActive }}</span>
            </div>
          </div>
          <div class="lk-ring-legend">
            <div v-for="item in masteryLegend" :key="item.key" class="lk-ring-item">
              <i class="lk-ring-dot" :style="{ background: item.color }"></i>
              <span>{{ item.label }}</span>
              <b>{{ item.count }}</b>
            </div>
            <div v-if="counted.due" class="lk-ring-item due">
              <i class="lk-ring-dot"></i>
              <span>{{ tr('到期复习', 'Due') }}</span>
              <b>{{ counted.due }}</b>
            </div>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 总览：响应式 dashboard —— 撑满视口、无纵向滚动（桌面） */
.lk-body { padding: 8px; display: flex; flex-direction: column; gap: 8px; height: 100%; box-sizing: border-box; overflow: hidden; }
.lk-card { border: 1px solid var(--borderColor, #d0d7de); border-radius: 10px;}
/* ===== 顶部：下一步建议 ===== */
.lk-next { display: flex; align-items: center; gap: 8px; padding: 8px; cursor: pointer; transition: border-color 0.2s; flex-shrink: 0; }
.lk-next:hover { border-color: var(--fontActiveColor); }
.lk-next-ico { width: 26px; height: 26px; border-radius: 8px; background: var(--fontActiveColor); color: var(--backgroundColor); display: inline-flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
.lk-next-main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; }
.lk-next-label { font-size: 11px; color: var(--fontActiveColor); letter-spacing: 1px; text-transform: uppercase; white-space: nowrap; }
.lk-next-text { font-size: 14px; color: var(--fontColor, #1f2328); font-weight: 500; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lk-btn { cursor: pointer; border: 1px solid var(--borderColor, #d0d7de); background: var(--backgroundColor, #fff); color: var(--fontColor, #1f2328); border-radius: 6px; font-size: 12px; padding: 3px 12px; flex-shrink: 0; }
.lk-btn:hover { background: var(--menuActiveColor, #e5e5e5); }
.lk-btn-go { border-color: var(--fontActiveColor); color: var(--fontActiveColor); font-weight: 500; }
/* ===== 主区两栏：趋势(左) | 整体掌握(右) ===== */
.lk-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 8px; }
/* ---- 左列：掌握统计条（上） + 连续学习趋势卡（下） ---- */
.lk-left { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
/* 掌握统计条：整体掌握 / 正确率 / 累计练习 —— flex 三项均分占满 */
.lk-card.lk-stats { display: flex; align-items: center; gap: 6px; padding: 10px 10px; flex-shrink: 0; }
.lk-stat { display: flex; align-items: center; justify-content: center; gap: 7px; min-width: 0; flex: 1 1 0; }
.lk-stat i { color: var(--fontActiveColor, #0969da); font-size: 13px; flex-shrink: 0; }
.lk-stat-body { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.lk-stat-lbl { font-size: 11px; color: var(--fontColor, #888); white-space: nowrap; }
.lk-stat b { font-size: 15px; color: var(--fontColor, #1f2328); }
.lk-stat-sep { width: 1px; height: 16px; background: var(--borderColor, #d0d7de); flex-shrink: 0; }
/* ---- 左·下：连续学习 / 趋势 ---- */
.lk-trend-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; min-height: 0; overflow: hidden; flex: 1; }
.lk-t-head { display: flex; align-items: center; gap: 12px; font-size: 12px; flex-shrink: 0; }
.lk-t-fire { color: var(--fontActiveColor); white-space: nowrap; }
.lk-t-fire b { font-size: 14px; }
.lk-t-note { font-size: 11px; color: var(--borderColor, #888); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lk-days-switch { display: inline-flex; gap: 2px; flex-shrink: 0; }
.lk-btn.lk-btn-xs { padding: 1px 8px; font-size: 11px; }
.lk-btn.lk-btn-xs.active { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: var(--menuActiveColor); }
/* 柱状图占满剩余高度，随窗口缩放 */
.lk-t-chart { flex: 1; min-height: 60px; display: flex; flex-direction: column; }
.lk-t-bars { flex: 1; min-height: 0; display: flex; align-items: flex-end; gap: 3px; }
.lk-t-bars.thin { gap: 1px; }
.lk-t-bar { flex: 1 1 0; min-width: 0; background: #4CAF50; border-radius: 2px 2px 0 0; transition: height 0.3s; }
.lk-t-bar.today { background: var(--fontActiveColor); }
.lk-t-bar.none { background: var(--borderColor, #d0d7de); }
/* ---- 右：整体掌握 ---- */
.lk-mastery { display: flex; flex-direction: column; gap: 8px; padding: 8px; min-height: 0; }
.lk-m-title { font-size: 12px; color: var(--fontColor, #1f2328); flex-shrink: 0; }
/* 2×2 统计卡（填满面板剩余高度） */
.lk-m-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: minmax(0, 1fr); gap: 6px; }
.lk-mstat { display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 8px; padding: 6px 10px; min-height: 0; }
.lk-mstat i { font-size: 18px; }
.lk-mstat b { font-size: 22px; font-weight: 700; line-height: 1.1; color: var(--fontColor, #1f2328); }
.lk-mstat.m i { color: #4CAF50; }
.lk-mstat.l i { color: #FF9800; }
.lk-mstat.n i { color: var(--borderColor, #888); }
.lk-mstat.d i { color: #d93025; }
/* 窄窗口：单列堆叠，允许纵向滚动 */
@media (max-width: 500px) {
  .lk-main { grid-template-columns: 1fr; overflow-y: auto; align-content: start; }
  .lk-trend-card, .lk-mastery { min-height: 0; }
  .lk-t-chart { min-height: 140px; }
}
/* ===== 新版总览：主视觉 / KPI / 环图 ===== */
.lk-hero {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; flex-shrink: 0; cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--fontActiveColor) 28%, var(--borderColor));
  border-radius: 14px;
  background:
    radial-gradient(circle at 0 0, color-mix(in srgb, var(--fontActiveColor) 18%, transparent), transparent 55%),
    linear-gradient(135deg, var(--menuColor), var(--backgroundColor));
  transition: border-color .2s, transform .2s;
}
.lk-hero:hover { border-color: var(--fontActiveColor); transform: translateY(-1px); }
.lk-hero-icon {
  width: 42px; height: 42px; border-radius: 12px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--fontActiveColor); color: var(--backgroundColor);
  font-size: 20px; box-shadow: 0 6px 18px color-mix(in srgb, var(--fontActiveColor) 28%, transparent);
}
.lk-hero-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.lk-hero-eyebrow { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--fontActiveColor); opacity: .8; }
.lk-hero-text { font-size: 15px; line-height: 1.45; font-weight: 500; color: var(--fontColor); }
.lk-hero-cta {
  display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
  height: 32px; padding: 0 13px; border: 0; border-radius: 8px;
  background: var(--fontActiveColor); color: var(--backgroundColor);
  font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
}
.lk-hero-cta:hover { opacity: .9; }
.lk-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; flex-shrink: 0; }
.lk-kpi {
  display: flex; flex-direction: column; gap: 3px; min-width: 0;
  padding: 10px 12px; border: 1px solid var(--borderColor); border-radius: 11px;
  background: var(--backgroundColor);
}
.lk-kpi-label { font-size: 9px; letter-spacing: .04em; color: var(--fontColor); opacity: .55; white-space: nowrap; }
.lk-kpi-value { font-size: 28px; line-height: 1.05; font-weight: 700; color: var(--fontColor); letter-spacing: -.02em; }
.lk-kpi-value i { font-size: 12px; font-style: normal; font-weight: 500; margin-left: 2px; opacity: .45; }
.lk-kpi-sub { font-size: 9px; color: var(--fontColor); opacity: .45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lk-mastery { padding: 12px 14px; gap: 8px; }
.lk-m-title { font-size: 11px; font-weight: 600; opacity: .8; }
.lk-ring-wrap { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; gap: 18px; flex-wrap: wrap; }
.lk-ring {
  width: 132px; height: 132px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 22px color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
}
.lk-ring-hole {
  width: 92px; height: 92px; border-radius: 50%; background: var(--backgroundColor);
  display: flex; align-items: center; justify-content: center; gap: 3px;
  border: 1px solid var(--borderColor);
}
.lk-ring-hole b { font-size: 25px; font-weight: 700; color: var(--fontColor); }
.lk-ring-hole span { font-size: 10px; color: var(--fontColor); opacity: .5; }
.lk-ring-legend { display: flex; flex-direction: column; gap: 7px; min-width: 100px; }
.lk-ring-item { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--fontColor); }
.lk-ring-item b { margin-left: auto; font-size: 12px; }
.lk-ring-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.lk-ring-item.due { color: #d93025; }
.lk-ring-item.due .lk-ring-dot { background: #d93025; }
@media (max-width: 500px) {
  .lk-kpis { grid-template-columns: 1fr 1fr; }
  .lk-kpi-value { font-size: 24px; }
  .lk-hero { align-items: flex-start; flex-wrap: wrap; }
  .lk-hero-cta { margin-left: 54px; }
  .lk-ring-wrap { gap: 12px; }
}
@media (max-width: 700px) {
  .lk-body { height: 100%; min-height: 0; overflow-y: auto; padding: 8px; }
  .lk-main { display: flex; flex-direction: column; flex: 0 0 auto; overflow: visible; gap: 8px; }
  .lk-left { flex: 0 0 auto; gap: 8px; }
  .lk-kpis { grid-template-columns: 1fr 1fr; }
  .lk-kpi:last-child { grid-column: 1 / -1; }
  .lk-hero { padding: 12px; gap: 10px; border-radius: 12px; }
  .lk-hero-text { font-size: 14px; }
  .lk-hero-cta { width: 100%; margin-left: 0; justify-content: center; }
  .lk-trend-card { flex: 0 0 auto; min-height: 210px; }
  .lk-t-note { display: none; }
  .lk-mastery { min-height: 235px; }
  .lk-ring-wrap { flex-direction: column; gap: 10px; }
}
@media (max-width: 420px) {
  .lk-kpis { grid-template-columns: 1fr; }
  .lk-kpi:last-child { grid-column: auto; }
  .lk-ring { width: 112px; height: 112px; }
  .lk-ring-hole { width: 78px; height: 78px; }
  .lk-ring-hole b { font-size: 22px; }
  .lk-hero-icon { width: 38px; height: 38px; font-size: 18px; }
}
</style>
