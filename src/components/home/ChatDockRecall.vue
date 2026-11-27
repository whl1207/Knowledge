<!-- ChatDockRecall.vue — 右侧栏「知识召回」面板：按对话轮次查看每一轮实际召回的切片
     与知识库 qa-side-list 同一套阅读方式：轮次选择 + 可滚动的证据列表 + 完整正文（默认不折叠）。 -->
<template>
  <div class="dock-recall">
    <div class="dock-recall-head">
      <div class="dock-recall-title">
        <i class="fa fa-book"></i>
        <span>{{ zh ? '知识召回' : 'Knowledge recall' }}</span>
        <span class="dock-recall-count">{{ activeEntry ? activeEntry.blocks.length : 0 }}</span>
      </div>
      <select
        v-if="entries.length"
        class="dock-recall-select"
        :value="activeKey"
        :title="zh ? '切换对话轮次' : 'Switch turn'"
        @change="onSelect"
      >
        <option v-for="entry in entries" :key="entry.key" :value="entry.key">
          {{ turnLabel(entry) }}
        </option>
      </select>
    </div>

    <div v-if="!entries.length" class="dock-recall-empty">
      <i class="fa fa-book"></i>
      <span>{{ zh ? '本对话还没有知识召回：在知识库模式提问后，召回片段会按轮次出现在这里。' : 'No knowledge recall yet — ask in knowledge-base mode and the retrieved chunks appear here by turn.' }}</span>
    </div>

    <template v-else-if="activeEntry">
      <div class="dock-recall-path" v-if="activeEntry.kbPath" :title="activeEntry.kbPath">
        <i class="fa fa-database"></i>
        <span>{{ activeEntry.kbPath }}</span>
      </div>

      <div class="qa-side-list scoll">
        <div v-for="(block, idx) in activeEntry.blocks" :key="idx" class="recall-item">
          <div class="recall-item-head">
            <span class="recall-idx">{{ idx + 1 }}</span>
            <span class="recall-label" :title="block.label">{{ block.label || ('#' + (idx + 1)) }}</span>
            <span v-if="typeof block.similarity === 'number'" class="recall-score">
              {{ (block.similarity * 100).toFixed(0) }}%
            </span>
          </div>
          <div class="recall-content scoll">
            <block_md :content="String(block.content || '')" :fontSize="'11px'" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import block_md from '@/components/block_md.vue'
import type { ChatDockRecallEntry } from '@/shared/chatDock'

const props = defineProps<{
  entries: ChatDockRecallEntry[]
  activeKey: string
  zh: boolean
}>()
const emit = defineEmits<{
  (e: 'select', key: string): void
}>()

const activeEntry = computed(() => props.entries.find((e) => e.key === props.activeKey) || props.entries[props.entries.length - 1] || null)

const turnName = (entry: ChatDockRecallEntry) => props.zh ? `第 ${entry.turn} 轮` : `Turn ${entry.turn}`
const turnLabel = (entry: ChatDockRecallEntry) => {
  const q = String(entry.question || '').replace(/\s+/g, ' ').trim().slice(0, 28)
  return turnName(entry) + (q ? ` · ${q}` : '')
}
const onSelect = (e: Event) => emit('select', String((e.target as HTMLSelectElement).value || ''))
</script>

<style scoped>
.dock-recall {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  box-sizing: border-box;
}
.dock-recall-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dock-recall-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.dock-recall-title .fa { color: var(--fontActiveColor); }
.dock-recall-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  font-size: 10px;
  font-weight: 500;
  text-align: center;
}
.dock-recall-select {
  flex: 1 1 auto;
  margin: 0;
  min-width: 0;
  max-width: none;
  width: auto;
  height: 24px;
  padding: 0 5px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
}
.dock-recall-path {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 10px;
  opacity: .55;
}
.dock-recall-path span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-recall-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  border: 1px dashed var(--borderColor);
  border-radius: 8px;
  text-align: center;
  font-size: 11px;
  line-height: 1.7;
  opacity: .65;
}
.dock-recall-empty .fa { font-size: 22px; opacity: .6; }
.qa-side-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--borderColor);
  border-radius: 7px;
  padding: 6px;
  box-sizing: border-box;
}
.recall-item {
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  margin-bottom: 5px;
  background: var(--backgroundColor);
  overflow: hidden;
}
.recall-item:last-child { margin-bottom: 0; }
.recall-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 7px;
  min-width: 0;
}
.recall-idx {
  flex: 0 0 auto;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  border-radius: 8px;
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
  font-size: 9px;
  text-align: center;
}
.recall-label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
}
.recall-score {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--fontActiveColor);
}
.recall-content {
  max-height: 240px;
  overflow-y: auto;
  padding: 0 7px 7px;
  font-size: 11px;
  line-height: 1.6;
}
</style>
