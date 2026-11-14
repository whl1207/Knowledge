<!-- EvidencePanel.vue — 行级证据判定卡（可选，默认关闭） -->
<template>
  <div class="evidence-panel">
    <div v-if="!row.evidence" class="evidence-empty">
      <i class="fa fa-info-circle"></i>
      {{ zh ? '本行未采集证据（任务未开启证据模式，或尚未运行）' : 'No evidence captured for this row (evidence mode is off, or the row has not run).' }}
    </div>

    <template v-else>
      <section class="evidence-card">
        <div class="evidence-card-head">
          <span class="evidence-state" :class="'state-' + row.evidence.state">{{ stateLabel }}</span>
          <span class="evidence-action" :class="'action-' + row.evidence.action"
                :title="zh ? 'v1 先记录建议动作；retrieve/switch 的自动执行在 attempt 层接入' : 'v1 records the suggested action; automatic retrieve/switch is handled by the attempt layer'">{{ actionLabel }}</span>
        </div>
        <div v-if="row.evidence.answer" class="evidence-answer">
          <span class="evidence-kicker">{{ zh ? '结论' : 'Answer' }}</span>
          <span class="evidence-answer-text">{{ row.evidence.answer }}</span>
        </div>
        <div v-if="row.evidence.rationale" class="evidence-rationale">
          <span class="evidence-kicker">{{ zh ? '为什么' : 'Why' }}</span>
          <span>{{ row.evidence.rationale }}</span>
        </div>
        <div class="evidence-meta">
          <span>{{ zh ? '来源数' : 'Sources' }}: {{ row.evidence.sources.length }}</span>
          <span v-if="row.evidence.generatedAt">{{ zh ? '生成于' : 'Generated' }}: {{ row.evidence.generatedAt }}</span>
        </div>
      </section>

      <section class="evidence-sources">
        <h4 class="evidence-section-title">
          <i class="fa fa-link"></i>
          {{ zh ? '来源与原文片段' : 'Sources and quoted spans' }}
        </h4>
        <div v-if="!row.evidence.sources.length" class="evidence-empty small">
          {{ zh ? '没有可核验的来源。' : 'No verifiable source was captured.' }}
        </div>
        <ul v-else class="evidence-source-list">
          <li v-for="(s, i) in row.evidence.sources" :key="i" class="evidence-source-item">
            <div class="evidence-source-head">
              <span class="evidence-source-kind">{{ s.kind }}</span>
              <a v-if="isUrl(s.locator)" :href="s.locator" target="_blank" rel="noopener" class="evidence-source-link">{{ s.label || s.locator }}</a>
              <span v-else class="evidence-source-label">{{ s.label || s.locator }}</span>
            </div>
            <div v-if="s.quote" class="evidence-quote">“{{ s.quote }}”</div>
            <div v-if="s.retrievedAt" class="evidence-source-time">{{ s.retrievedAt }}</div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { BatchRow } from './types'

const props = defineProps<{ row: BatchRow; zh?: boolean }>()
const zh = computed(() => props.zh !== false)

const STATE_LABELS: Record<string, { zh: string; en: string }> = {
  sufficient: { zh: '证据充分', en: 'Sufficient' },
  conflicting: { zh: '证据冲突', en: 'Conflicting' },
  stale: { zh: '证据过时', en: 'Stale' },
  incomplete: { zh: '证据不完整', en: 'Incomplete' },
  ambiguous: { zh: '证据歧义', en: 'Ambiguous' },
  out_of_scope: { zh: '不适用证据评估', en: 'Out of scope' },
}
const ACTION_LABELS: Record<string, { zh: string; en: string }> = {
  answer: { zh: '回答', en: 'Answer' },
  retrieve_more: { zh: '继续检索', en: 'Retrieve more' },
  switch_executor: { zh: '切换执行器', en: 'Switch executor' },
  ask_human: { zh: '转人工', en: 'Ask human' },
  abstain: { zh: '弃答', en: 'Abstain' },
}

const stateLabel = computed(() => {
  const s = props.row.evidence?.state || ''
  return (STATE_LABELS[s] || { zh: s, en: s })[zh.value ? 'zh' : 'en']
})
const actionLabel = computed(() => {
  const a = props.row.evidence?.action || ''
  return (ACTION_LABELS[a] || { zh: a, en: a })[zh.value ? 'zh' : 'en']
})

function isUrl(v: string): boolean {
  return /^https?:\/\//i.test(v || '')
}
</script>

<style scoped>
.evidence-panel { display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow: auto; height: 100%; }
.evidence-empty { color: var(--fontColor); opacity: .65; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.evidence-empty.small { font-size: 11px; }
.evidence-card { border: 1px solid var(--borderColor, #ddd); border-radius: 6px; padding: 10px 12px; background: var(--cardBg, #fff); }
.evidence-card-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.evidence-state, .evidence-action { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid transparent; }
.state-sufficient { color: #1e6b3a; background: #e6f4ea; }
.state-conflicting { color: #a61b1b; background: #fde9e9; }
.state-stale { color: #8a5a00; background: #fff4d6; }
.state-incomplete { color: #8a5a00; background: #fff4d6; }
.state-ambiguous { color: #5b3a8a; background: #f0e9fb; }
.state-out_of_scope { color: #555; background: #eee; }
.action-answer { color: #1e6b3a; background: #eef7f1; }
.action-retrieve_more, .action-switch_executor { color: #1f4e79; background: #eaf2fb; }
.action-ask_human { color: #8a5a00; background: #fff4d6; }
.action-abstain { color: #a61b1b; background: #fde9e9; }
.evidence-answer, .evidence-rationale { font-size: 12px; line-height: 1.5; margin: 4px 0; display: flex; gap: 8px; }
.evidence-kicker { color: var(--fontColor); opacity: .6; flex: 0 0 auto; }
.evidence-answer-text { font-weight: 600; word-break: break-word; }
.evidence-meta { display: flex; gap: 14px; font-size: 10px; color: var(--fontColor); opacity: .6; margin-top: 6px; }
.evidence-section-title { font-size: 12px; margin: 0 0 6px; display: flex; gap: 6px; align-items: center; }
.evidence-source-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.evidence-source-item { border-left: 2px solid var(--borderColor, #ddd); padding-left: 8px; }
.evidence-source-head { display: flex; gap: 6px; align-items: baseline; font-size: 11px; }
.evidence-source-kind { font-size: 9px; text-transform: uppercase; color: var(--fontColor); opacity: .55; border: 1px solid var(--borderColor, #ddd); border-radius: 3px; padding: 0 3px; }
.evidence-source-link { color: #1f4e79; text-decoration: underline; word-break: break-all; }
.evidence-source-label { word-break: break-all; }
.evidence-quote { font-size: 11px; line-height: 1.5; color: var(--fontColor); opacity: .8; margin-top: 2px; word-break: break-word; }
.evidence-source-time { font-size: 9px; color: var(--fontColor); opacity: .45; margin-top: 2px; }
</style>
