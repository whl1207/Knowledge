<!-- LearnMap.vue — 学习 · 地图（按文件 / 实体 / 本体图谱） -->
<script setup lang="ts">
import { useLearningContext } from './context'
import mapView from './mapView.vue'
import entityView from './entityView.vue'
import graphView from './graphView.vue'

const ctx = useLearningContext()
const tr = (zh: string, en: string) => (ctx.store.locales === 'zh' ? zh : en)
</script>

<template>
  <div class="map-shell">
    <div class="map-axis">
      <button class="axis-btn" :class="{ active: ctx.mapAxis === 'file' }" @click="ctx.mapAxis = 'file'" :title="tr('按文件：以来源文件为学习单位', 'By file: files as learning units')"><i class="fa fa-file-text-o"></i> {{ tr('按文件', 'By file') }}</button>
      <button class="axis-btn" :class="{ active: ctx.mapAxis === 'entity' }" @click="ctx.mapAxis = 'entity'" :title="tr('按实体：以本体实体为学习单位（由文件作答投影）', 'By entity: entities as learning units (projected from file answers)')"><i class="fa fa-eercast"></i> {{ tr('按实体', 'By entity') }}</button>
      <button class="axis-btn" :class="{ active: ctx.mapAxis === 'graph' }" @click="ctx.mapAxis = 'graph'" :title="tr('本体图谱：把本体（实体 + 关系）画成图谱，节点颜色即掌握状态；需先在「知识库」构建本体。右侧范围下拉可选 全部/仅已练习实体、带问题节点、切片+问题、文件+问题', 'Ontology graph: draws the ontology (entities + relations); node colour = mastery; build it in Knowledge Processing first. The scope dropdown on the right adds questions / slices / files or filters to practised items')"><i class="fa fa-sitemap"></i> {{ tr('本体图谱', 'Ontology graph') }}</button>
      <span style="flex:1;"></span>
      <select
        v-if="ctx.mapAxis === 'file'"
        v-model="ctx.filterSel"
        class="axis-select"
        :title="tr('对象范围：仅有效 / 含过期（知识库更新后被标记，记录保留）', 'Scope: active only / include stale (marked after KB update, records kept)')"
      >
        <option value="active">{{ tr('仅有效', 'Active only') }}</option>
        <option value="all">{{ tr('含过期', 'Include stale') }}</option>
      </select>
      <select
        v-else-if="ctx.mapAxis === 'entity'"
        v-model="ctx.filterSel"
        class="axis-select"
        :title="tr('实体范围：全部实体 / 仅已有练习的实体', 'Entity scope: all / only with attempts')"
      >
        <option value="all">{{ tr('全部实体', 'All entities') }}</option>
        <option value="active">{{ tr('仅已练习', 'With attempts') }}</option>
      </select>
      <select
        v-else
        v-model="ctx.graphFilterSel"
        class="axis-select"
        :title="tr('图谱范围：显示内容（实体 / 切片+问题 / 文件+问题）+ 实体范围 + 是否带问题节点', 'Graph scope: content (entities / slices+questions / files+questions) + entity range + question nodes')"
      >
        <option value="all">{{ tr('全部实体', 'All entities') }}</option>
        <option value="active">{{ tr('仅已练习', 'With attempts') }}</option>
        <option value="all+q">{{ tr('全部实体 + 问题', 'All entities + questions') }}</option>
        <option value="active+q">{{ tr('仅已练习 + 问题', 'With attempts + questions') }}</option>
        <option value="slice+q">{{ tr('切片 + 问题', 'Slices + questions') }}</option>
        <option value="file+q">{{ tr('文件 + 问题', 'Files + questions') }}</option>
      </select>
    </div>
    <div class="view-wrap">
      <mapView
        v-if="ctx.mapAxis === 'file'"
        :store="ctx.store"
        :vm="ctx.vm"
        :show-stale="ctx.showStale"
        @practice="(k: any) => ctx.startPractice(k)"
        @review="ctx.startReviewOne"
        @clear-stale="ctx.doClearStale"
        @relearn="ctx.doRelearn"
        @claim-mastered="ctx.doClaimMastered"
        @set-type="ctx.doSetType"
      />
      <entityView v-else-if="ctx.mapAxis === 'entity'" :store="ctx.store" :items="ctx.entityVM" :show-all="ctx.entityShowAll" @practice="ctx.startEntityPractice" @review="ctx.startEntityReview" />
      <graphView v-else :store="ctx.store" :entities="ctx.kb.entities" :relations="ctx.kb.relations" :items="ctx.entityVM" :show-all="ctx.entityShowAll" :questions="ctx.kb.questions" :with-questions="ctx.graphQuestions" :entity-to-blocks="ctx.kb.entityToBlocks || []" :mode="ctx.graphMode" :blocks="ctx.kb.blocks" :files="ctx.kb.files" :file-items="ctx.vm" :block-stats="ctx.blockStats" @practice="ctx.startEntityPractice" @review="ctx.startEntityReview" @practice-block="(fp: any, bid: any) => ctx.startPractice(fp, bid)" @practice-file="(fp: any) => ctx.startPractice(fp)" />
    </div>
  </div>
</template>

<style scoped>
.map-shell { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.map-axis { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--borderColor); flex-shrink: 0; background: var(--menuColor); }
.axis-btn { cursor: pointer; border: 1px solid var(--borderColor); background: var(--backgroundColor); color: var(--fontColor); border-radius: 4px; font-size: 12px; padding: 2px 10px; }
.axis-btn:hover { background: var(--menuActiveColor); }
.axis-btn.active { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: var(--menuActiveColor); }
.axis-select {
  height: 24px;
  box-sizing: border-box;
  flex-shrink: 0;
  max-width: 130px;
  background-color: var(--backgroundColor);
  border: 0;
  outline: none;
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
  margin: 0px
}
.axis-select:hover { color: var(--fontActiveColor); }
.view-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.view-wrap > :deep(*) { flex: 1; min-height: 0; }
</style>
