<!-- /cardView.vue - 百科（实体卡片）视图；搜索/推理/描述编辑等逻辑由父壳注入 -->
<script setup lang="ts">
defineOptions({ name: 'CardView' })

interface Props {
  store: any
  entityCards: any[]
  filteredEntityCards: any[]
  reasoningCardsSet: Set<string>
  isBatchReasoning: boolean
  batchReasoningProgress: number
  batchReasoningProgressText: string
  showDetail: boolean
  selected: any
  entityCardDetailBlocks: any[]
  isReasoningDetail: boolean
  editing: boolean
  searchKeyword: string
  // 回调（父壳实现）
  onSearch?: (kw: string) => void
  onAddEntity?: () => void
  onClearOntology?: () => void
  onBatchReason?: () => void
  onStopBatch?: () => void
  onSelect?: (entity: any) => void
  onDelete?: (entity: any) => void
  onCloseDetail?: () => void
  onReasonDetail?: () => void
  onToggleEdit?: (on: boolean) => void
  onSaveDescription?: () => void
  onViewBlock?: (block: any) => void
  onGetFileIcon?: (ext: string) => string
  onGetBlockFileInfo?: (block: any) => { extension: string; name: string }
  // 百科构建（抽取切片实体概念 = 本体构建）：由百科页发起并显示进度
  buildProgress?: { isRunning: boolean; isPaused: boolean; currentBatchIndex: number; totalBatches: number; savedOntologyState?: any | null }
  buildProgressPercent?: number
  buildProgressText?: string
  onStartBuild?: () => void
  onPauseBuild?: () => void
  onStopBuild?: () => void
  onContinueBuild?: () => void
}
const props = defineProps<Props>()

const fileInfo = (b: any) => (props.onGetBlockFileInfo ? props.onGetBlockFileInfo(b) : { extension: '', name: '' })
const iconOf = (b: any) => (props.onGetFileIcon ? props.onGetFileIcon(fileInfo(b).extension) : 'fa fa-file-o')
</script>

<template>
  <div style="display: flex; flex-direction: column; height: 100%; width: 100%; overflow: hidden; box-sizing: border-box;">
    <!-- 搜索和操作栏（kt-* 统一） -->
    <div class="kt-toolbar">
      <div class="kt-search">
        <i class="fa fa-search"></i>
        <input :value="searchKeyword" class="kt-search-input"
          :placeholder="store.locales == 'zh' ? '搜索实体名称或描述...' : 'Search entity name or description...'"
          @input="onSearch && onSearch(($event.target as any).value)" />
      </div>
      <!-- 抽取实体概念（百科构建 = 本体构建；由此发起；进度显示在底部状态栏） -->
      <template v-if="buildProgress && buildProgress.isRunning && !buildProgress.isPaused">
        <div class="kt-btn" :title="store.locales == 'zh' ? '暂停抽取实体' : 'Pause extract'" @click="onPauseBuild && onPauseBuild()"><i class="fa fa-pause"></i></div>
        <div class="kt-btn" :title="store.locales == 'zh' ? '停止抽取实体' : 'Stop extract'" @click="onStopBuild && onStopBuild()"><i class="fa fa-stop"></i></div>
      </template>
      <template v-else-if="buildProgress && buildProgress.isPaused">
        <!-- 存在未完成断点（加载/暂停恢复）：只提供「继续」，避免误点“开始”而从零重建 -->
        <div v-if="buildProgress.savedOntologyState" class="kt-btn" :title="store.locales == 'zh' ? '继续抽取实体（从断点恢复）' : 'Resume extract (from checkpoint)'" @click="onContinueBuild && onContinueBuild()"><i class="fa fa-repeat"></i></div>
        <template v-else>
          <div class="kt-btn" :title="store.locales == 'zh' ? '开始抽取实体' : 'Start extract'" @click="onStartBuild && onStartBuild()"><i class="fa fa-play"></i></div>
          <div class="kt-btn" :title="store.locales == 'zh' ? '继续抽取实体' : 'Resume extract'" @click="onContinueBuild && onContinueBuild()"><i class="fa fa-repeat"></i></div>
        </template>
      </template>
      <template v-else>
        <div class="kt-btn" :title="store.locales == 'zh' ? '开始构建：抽取切片中的实体概念，生成百科条目（实体/关系/描述推理）；进度显示在底部状态栏' : 'Start build: extract entity concepts from slices to build the encyclopedia (entities/relations/descriptions); progress shows in the bottom status bar'" @click="onStartBuild && onStartBuild()"><i class="fa fa-play"></i></div>
      </template>
      <div class="kt-btn" :title="store.locales == 'zh' ? '手动添加实体' : 'Add Entity Manually'" @click="onAddEntity && onAddEntity()"><i class="fa fa-plus"></i></div>
      <div class="kt-btn" :title="store.locales == 'zh' ? '批量推理所有卡片' : 'Batch reasoning for all cards'" @click="onBatchReason && onBatchReason()"><i class="fa fa-certificate"></i></div>
      <div class="kt-btn" v-if="isBatchReasoning" :title="store.locales == 'zh' ? '停止批量推理' : 'Stop batch reasoning'" @click="onStopBatch && onStopBatch()"><i class="fa fa-stop"></i></div>
      <div class="kt-btn" style="color:#F56C6C;" :title="store.locales == 'zh' ? '清空本体/百科：删除全部实体（即百科卡片）及其实体间关系与派生的社区（无法撤销）' : 'Clear ontology/encyclopedia: remove all entities (the cards), their relations and derived communities (cannot be undone)'" @click="onClearOntology && onClearOntology()"><i class="fa fa-trash"></i></div>
      <span class="kt-spacer"></span>
      <span v-if="filteredEntityCards.length !== entityCards.length" class="kt-label">
        {{ store.locales == 'zh' ? `显示 ${filteredEntityCards.length}/${entityCards.length}` : `Showing ${filteredEntityCards.length}/${entityCards.length}` }}
      </span>
      <span v-if="isBatchReasoning" class="kt-label warn" style="gap:6px;">
        <span class="kt-progress"><span class="kt-progress-fill" :style="{width: batchReasoningProgress + '%'}"></span></span>
        <span>{{ batchReasoningProgressText }}</span>
        <i class="fa fa-spinner fa-spin"></i>
      </span>
    </div>

    <!-- 卡片内容区域 -->
    <div style="display: flex; flex: 1; min-height: 0; width: 100%;">
      <!-- 左侧卡片列表 - 可滚动 -->
      <div class="cards-container scoll" @dragover.prevent style="flex: 1; overflow-y: auto; height: 100%;">
        <div class="cards-grid">
          <div
            v-for="entity in filteredEntityCards"
            :key="entity.id"
            class="entity-card"
            @click="onSelect && onSelect(entity)"
          >
            <div class="card-header">
              <i class="fa fa-cube"></i>
              <span class="card-title">{{ entity.name }}</span>
              <span class="card-layer" :class="entity.layer">
                {{ store.locales == 'zh' ? '数据' : 'Data' }}
              </span>
            </div>
            <div class="card-description" :class="{ 'reasoning-pulse': reasoningCardsSet.has(entity.id) }">
              <div v-if="reasoningCardsSet.has(entity.id)" class="reasoning-indicator">
                <i class="fa fa-spinner fa-spin"></i> {{ store.locales == 'zh' ? '推理中...' : 'Reasoning...' }}
              </div>
              <div style="display: -webkit-box;line-clamp: 5;-webkit-line-clamp: 5;-webkit-box-orient: vertical;overflow: hidden;height:30px" v-else>
                {{ entity.description }}
              </div>
            </div>
            <div class="card-footer">
              <span class="card-stat">
                <i class="fa fa-file-text-o"></i> {{ entity.associatedBlocks?.length || 0 }} {{ store.locales == 'zh' ? "个切片" : "blocks" }}
              </span>
              <span class="card-stat">
                <i class="fa fa-file-o"></i> {{ entity.associatedFiles?.length || 0 }} {{ store.locales == 'zh' ? "个文件" : "files" }}
              </span>
              <span v-if="entity.description && entity.description !== '无描述'" class="card-stat" style="color: #4CAF50;">
                <i class="fa fa-check-circle"></i> {{ store.locales == 'zh' ? '已推理' : 'Reasoned' }}
              </span>
            </div>
          </div>
        </div>

        <div v-if="filteredEntityCards.length === 0" class="cards-empty">
          <i class="fa fa-cubes empty-icon"></i>
          <div>{{ store.locales == 'zh' ? "暂无本体数据" : "No Ontology Data Available" }}</div>
          <div class="empty-hint">{{ store.locales == 'zh' ? "请先点击上方「开始构建」抽取切片中的实体概念来生成百科；或加载已含本体的知识库" : "Click \"Start build\" above to extract entity concepts from slices; or load a KB that already contains an ontology" }}</div>
          <div v-if="searchKeyword" class="empty-hint">{{ store.locales == 'zh' ? `没有找到包含 "${searchKeyword}" 的卡片` : `No cards found containing "${searchKeyword}"` }}</div>
        </div>
      </div>

      <!-- 卡片详情侧边栏 -->
      <div v-if="showDetail && selected" class="card-detail-sidebar" @click.stop>
        <div class="detail-header">
          <div class="detail-title">
            <i class="fa fa-cube"></i>
            <span>{{ selected.name }}</span>
          </div>
          <button class="detail-close" :title="store.locales == 'zh' ? '删除实体' : 'Delete Entity'" @click="onDelete && onDelete(selected)">
            <i class="fa fa-trash-o"></i>
          </button>
          <button class="detail-close" @click="onCloseDetail && onCloseDetail()">
            <i class="fa fa-times"></i>
          </button>
        </div>

        <div class="detail-body scoll">
          <div class="detail-section">
            <div class="section-title">
              <span style="flex:1;">
                <i class="fa fa-info-circle"></i> {{ store.locales == 'zh' ? "描述" : "Description" }}
              </span>
              <div style="cursor: pointer;" @click="onReasonDetail && onReasonDetail()" :disabled="isReasoningDetail">
                <i class="fa fa-bullseye"></i> {{ store.locales == 'zh' ? '重新推理' : 'Re-reason' }}
              </div>
              <div style="cursor: pointer;" @click="editing ? (onSaveDescription && onSaveDescription()) : (onToggleEdit && onToggleEdit(true))" :disabled="isReasoningDetail">
                <i class="fa" :class="editing ? 'fa-save' : 'fa-edit'"></i>
                {{ editing ? (store.locales == 'zh' ? '保存' : 'Save') : (store.locales == 'zh' ? '编辑' : 'Edit') }}
              </div>
              <div style="cursor: pointer;" @click="onToggleEdit && onToggleEdit(false)" v-if="editing">
                <i class="fa fa-sign-out"></i>
                {{ (store.locales == 'zh' ? '退出' : 'Exit') }}
              </div>
            </div>
            <div class="section-content">
              <!-- 显示模式 -->
              <div v-if="!editing" class="description-display">
                {{ selected.description || (store.locales == 'zh' ? '无描述' : 'No description') }}
              </div>
              <!-- 编辑模式 -->
              <div v-else class="description-edit">
                <textarea
                  v-model="selected.description"
                  :placeholder="store.locales == 'zh' ? '输入描述...' : 'Enter description...'"
                  style="padding:5px; resize: vertical; overflow: auto; width: calc(100% - 12px); font-size: 10px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--backgroundColor); color: var(--fontColor);"
                  rows="8"
                  @blur="onSaveDescription && onSaveDescription()"
                ></textarea>
              </div>
            </div>
            <div v-if="isReasoningDetail" style="margin-top: 8px; font-size: 10px; color: #FF9800;">
              <i class="fa fa-spinner fa-spin"></i> {{ store.locales == 'zh' ? '推理中...' : 'Reasoning...' }}
            </div>
          </div>

          <div class="detail-section">
            <div class="section-title">
              <i class="fa fa-tag"></i> {{ store.locales == 'zh' ? "元信息" : "Metadata" }}
            </div>
            <div class="meta-grid">
              <div class="meta-item">
                <span class="meta-label">{{ store.locales == 'zh' ? "层级:" : "Layer:" }}</span>
                <span class="meta-value">{{ store.locales == 'zh' ? "数据" : "Data" }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">ID:</span>
                <span class="meta-value mono">{{ selected.id }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">{{ store.locales == 'zh' ? "关联切片:" : "Associated Blocks:" }}</span>
                <span class="meta-value">{{ entityCardDetailBlocks.length }} 个</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">{{ store.locales == 'zh' ? "关联文件:" : "Associated Files:" }}</span>
                <span class="meta-value">{{ selected.associatedFiles?.length || 0 }} 个</span>
              </div>
            </div>
          </div>

          <div class="detail-section" v-if="entityCardDetailBlocks.length > 0">
            <div class="section-title">
              <i class="fa fa-file-text-o"></i> {{ store.locales == 'zh' ? "关联切片" : "Associated Blocks" }}
            </div>
            <div class="blocks-list">
              <div
                v-for="block in entityCardDetailBlocks"
                :key="block.id"
                class="detail-block-card"
                @click="onViewBlock && onViewBlock(block)"
              >
                <div class="block-header">
                  <i :class="iconOf(block)"></i>
                  <span class="block-name">{{ fileInfo(block).name }}</span>
                </div>
                <div class="block-preview">{{ block.preview }}</div>
                <div class="block-footer">
                  <span class="block-size">{{ block.A?.length || 0 }} {{ store.locales == 'zh' ? "字符" : "characters" }}</span>
                  <span class="view-link">{{ store.locales == 'zh' ? "查看详情 →" : "View Details →" }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 卡片视图样式（由 knowRAG 迁出，随百科视图维护） */
.cards-container { height: 100%; overflow-y: auto; display: block; flex: 1; position: relative; }
.cards-grid { display: grid; flex: 1; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 5px; padding: 4px; align-content: start; }
.entity-card { background: var(--backgroundColor); border: 1px solid var(--borderColor); border-radius: 5px; padding: 5px; cursor: pointer; transition: all 0.2s ease; }
.entity-card:hover { border-color: #2196F3; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(33, 150, 243, 0.1); }
.card-header { display: flex; align-items: center; gap: 5px; margin-bottom: 5px; }
.card-header i { color: var(--fontActiveColor); font-size: 14px; }
.card-title { font-weight: 500; font-size: 13px; color: var(--fontActiveColor); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-layer { font-size: 9px; padding: 2px 4px; border-radius: 5px; background: rgba(33, 150, 243, 0.1); color: var(--fontActiveColor); }
.card-description { font-size: 10px; color: var(--fontColor); line-height: 1.4; min-height: 30px; }
.card-footer { display: flex; gap: 5px; padding-top: 5px; border-top: 1px solid var(--borderColor); }
.card-stat { font-size: 9px; color: var(--borderColor); display: flex; align-items: center; gap: 4px; }
.card-stat i { font-size: 9px; }
.cards-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--borderColor); text-align: center; }
.empty-icon { font-size: 40px; margin-bottom: 10px; }
.empty-hint { font-size: 10px; margin-top: 5px; opacity: 0.7; }
.reasoning-pulse { position: relative; }
.reasoning-indicator { display: flex; align-items: center; gap: 6px; color: #FF9800; font-size: 10px; height: 30px; }
.reasoning-indicator i { animation: cspin 1s linear infinite; }
@keyframes cspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.card-detail-sidebar { width: 250px; background: var(--backgroundColor); border-left: 1px solid var(--borderColor); display: flex; flex-direction: column; z-index: 100; box-shadow: -2px 0 8px rgba(0, 0, 0, 0.1); animation: slideInRight 0.3s ease; }
@keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
.detail-header { display: flex; justify-content: space-between; align-items: center; padding: 2px 5px; border-bottom: 1px solid var(--borderColor); }
.detail-title { display: flex; align-items: center; gap: 5px; font-size: 14px; font-weight: 500; color: var(--fontColor); flex: 1; }
.detail-title i { color: #2196F3; }
.detail-close { background: none; border: none; color: var(--borderColor); cursor: pointer; padding: 4px 8px; border-radius: 4px; width: 25px; }
.detail-body { flex: 1; overflow-y: auto; padding: 5px; }
.detail-section { margin-bottom: 5px; }
.section-title { font-size: 11px; font-weight: 500; color: #2196F3; margin-bottom: 5px; display: flex; align-items: center; gap: 5px; padding-bottom: 4px; border-bottom: 1px solid var(--borderColor); }
.section-content { font-size: 10px; color: var(--fontColor); line-height: 1.5; padding: 5px; background: var(--backgroundColor); border-radius: 5px; }
.meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.meta-item { display: flex; flex-direction: row; gap: 2px; padding: 2px; background: var(--backgroundColor); border-radius: 5px; }
.meta-label { font-size: 8px; color: var(--borderColor); }
.meta-value { font-size: 8px; color: var(--fontColor); }
.meta-value.mono { font-family: monospace; font-size: 9px; }
.blocks-list { display: flex; flex-direction: column; gap: 5px; }
.detail-block-card { background: var(--backgroundColor); border: 1px solid var(--borderColor); border-radius: 6px; padding: 8px; cursor: pointer; transition: all 0.2s; }
.detail-block-card:hover { border-color: #2196F3; background: rgba(33, 150, 243, 0.05); }
.detail-block-card .block-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 10px; font-weight: 500; color: #FF5722; }
.detail-block-card .block-preview { font-size: 9px; color: var(--fontColor); line-height: 1.3; margin-bottom: 6px; overflow: hidden; display: -webkit-box; line-clamp: 4; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.detail-block-card .block-footer { display: flex; justify-content: space-between; align-items: center; font-size: 8px; color: var(--borderColor); }
.view-link { color: #2196F3; }
</style>
