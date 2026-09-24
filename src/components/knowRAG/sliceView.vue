<!-- /sliceView.vue - 切片视图（工具栏 + 卡片网格）；逻辑/数据由父壳 knowRAG 注入 -->
<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import block_md from '@/components/block_md.vue'

defineOptions({ name: 'SliceView' })

// ---------------- 组件接口 ----------------
interface Props {
  store: any
  model: any                       // 引用对象；sliceStrategy 字段由本组件直接修改
  documents: Array<{ name: string }>
  documentName: string
  blocks: any[]
  filteredBlocks: any[]
  displayedBlocks: any[]
  displayedCount: number
  hasMoreBlocks: boolean
  isLoadingMore: boolean
  loadChunkSize: number
  sliceViewCfg: any
  sliceZoom: number
  isSliced: boolean
  isEmbedded: boolean
  ingestRunning: boolean
  incrementalRunning: boolean
  embeddedCount: number
  // 回调注入（父壳实现）
  onSlice?: () => void
  onEmbed?: () => void
  onIngestion?: () => void
  onIncremental?: () => void
  onResetZoom?: () => void
  onScroll?: (e: any) => void
  onWheel?: (e: any) => void
  /** 切片搜索关键字（父壳已在 filteredBlocks 内按关键词过滤） */
  searchKeyword: string
  /** 搜索回调：关键字变化实时上报父壳 */
  onSearch?: (kw: string) => void
}
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'changeDocument', name: string): void }>()

const onScroll = (e: any) => props.onScroll?.(e)
const onWheel = (e: any) => props.onWheel?.(e)
const doSlice = () => props.onSlice?.()
const doEmbed = () => props.onEmbed?.()
const doIngestion = () => props.onIngestion?.()
const doIncremental = () => props.onIncremental?.()
const doResetZoom = () => props.onResetZoom?.()

// ===== 切片本地搜索（展示层过滤）：基于全库 blocks 直接过滤可见卡片，输入即刻生效，不依赖父壳 filteredBlocks 重算 =====
const localKw = ref('')
const isSearching = computed(() => !!localKw.value.trim())
const trimKw = computed(() => localKw.value.trim().toLowerCase())
const matchSlice = (b: any, kw: string) =>
    (b.label && b.label.toLowerCase().includes(kw)) ||
    (b.A && b.A.toLowerCase().includes(kw)) ||
    (b.filePath && b.filePath.toLowerCase().includes(kw)) ||
    (b.Q && b.Q !== '问题未推理' && b.Q.toLowerCase().includes(kw))
// 命中切片总数（跨全库 blocks）；无关键词时为父壳已过滤数（按文档）
const matchTotal = computed(() => {
    const kw = trimKw.value
    return kw ? props.blocks.filter((b: any) => matchSlice(b, kw)).length : props.filteredBlocks.length
})
// 展示列表：有关键词 → 本地过滤后按父壳分页数截断（随滚动继续加载）；否则用父壳已分页列表
const visibleBlocks = computed(() => {
    const kw = trimKw.value
    if (!kw) return props.displayedBlocks
    const hits = props.blocks.filter((b: any) => matchSlice(b, kw))
    const take = Math.max(1, Math.min(props.displayedCount, hits.length))
    return hits.slice(0, take)
})
const isEmpty = computed(() => (isSearching.value ? matchTotal.value === 0 : props.filteredBlocks.length === 0))
const onSearchInput = (val: string) => {
    localKw.value = val
    props.onSearch?.(val) // 同步父壳（文档切换/状态一致性）；展示由本地过滤驱动
}
const clearSearch = () => onSearchInput('')
// 外部（如父壳重置/加载）同步关键字
watch(() => props.searchKeyword, (v) => { if (v !== localKw.value) localKw.value = v ?? '' })

// 底部计数（兼顾“按文档浏览”与“搜索命中”两种模式）
const totalShown = computed(() => (isSearching.value ? visibleBlocks.value.length : props.displayedCount))
const totalAll = computed(() => (isSearching.value ? matchTotal.value : props.filteredBlocks.length))
const showAllFooter = computed(() => {
    if (isSearching.value) return matchTotal.value > 0 && visibleBlocks.value.length >= matchTotal.value
    return !props.hasMoreBlocks && props.filteredBlocks.length > props.loadChunkSize
})
const showMoreFooter = computed(() => {
    if (isSearching.value) return matchTotal.value > visibleBlocks.value.length
    return props.hasMoreBlocks
})
</script>

<template>
  <div style="display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden;box-sizing:border-box;">
    <!-- 工具栏（与本体等统一 kt-*；单行图标按钮 + title） -->
    <div class="kt-toolbar">
      <!-- 切片内容搜索：跨全库切片检索（label/正文/问题/文件路径），命中后显示在卡片区；空词恢复按文档浏览 -->
      <div class="kt-search" style="width:180px;flex:0 1 180px;min-width:110px;">
        <i class="fa fa-search"></i>
        <input :value="localKw" class="kt-search-input"
          :placeholder="store.locales=='zh' ? '搜索切片内容...' : 'Search slice content...'"
          @input="onSearchInput(($event.target as any).value)" />
        <i v-if="isSearching" class="fa fa-times-circle" style="cursor:pointer;color:var(--borderColor);flex-shrink:0;"
           :title="store.locales=='zh' ? '清除搜索' : 'Clear search'" @click="clearSearch"></i>
      </div>
      <select :value="documentName" class="kt-select" style="flex:0 1 220px;min-width:120px;" title="选择文档切片"
        @change="emit('changeDocument', ($event.target as any).value)">
        <option v-for="(option, index) in documents" :key="index" :value="option.name">
          {{ option.name }}
        </option>
      </select>
      <select v-model="model.sliceStrategy" class="kt-select" style="width:88px;" title="切片策略">
        <option value="语义">{{ store.locales=='zh'?'语义':'semantic' }}</option>
        <option value="智能">{{ store.locales=='zh'?'智能':'smart' }}</option>
        <option value="标识符">{{ store.locales=='zh'?'标识符':'identifier' }}</option>
      </select>
      <div class="kt-btn" :class="{ active: isSliced }" :title="store.locales == 'zh' ? '切片（读取文件并按策略切分）' : 'Slice (read files and split)'" @click="doSlice">
        <i class="fa fa-scissors"></i>
      </div>
      <div class="kt-btn" :class="{ active: isEmbedded }" :title="store.locales == 'zh' ? '向量化（对未向量化切片生成嵌入）' : 'Embed (generate vectors for unembedded slices)'" @click="doEmbed">
        <i class="fa fa-magnet"></i>
      </div>
      <div class="kt-btn" :class="{ active: ingestRunning }" :title="store.locales == 'zh' ? '处理管线（按当前策略执行语义增强/本体推理等）' : 'Ingestion pipeline (run per current strategy)'" @click="doIngestion">
        <i class="fa fa-cogs" :class="{ 'fa-spin': ingestRunning }"></i>
      </div>
      <div class="kt-btn" :class="{ active: incrementalRunning }" :title="store.locales == 'zh' ? '增量更新（检测文件变更并同步切片/摘要/本体/社区/报告）' : 'Incremental update (detect file changes and sync slices/summary/ontology/communities/reports)'" @click="doIncremental">
        <i class="fa fa-refresh" :class="{ 'fa-spin': incrementalRunning }"></i>
      </div>
      <span v-if="incrementalRunning" class="kt-label warn"><i class="fa fa-spinner fa-spin"></i> {{ store.locales == 'zh' ? '增量更新中...' : 'Updating...' }}</span>
      <span v-if="ingestRunning" class="kt-label warn"><i class="fa fa-spinner fa-spin"></i> {{ store.locales == 'zh' ? '处理中...' : 'Processing...' }}</span>
      <span class="kt-spacer"></span>
      <span v-if="isSearching" class="kt-label ok"
            :title="store.locales=='zh' ? '命中的切片数 / 总切片数' : 'matched slices / total slices'">
        <i class="fa fa-search"></i> {{ matchTotal }} / {{ blocks.length }}
      </span>
      <span class="kt-label" style="cursor:pointer;" :title="store.locales=='zh' ? '按住 Ctrl 滚动滚轮缩放卡片，点击恢复 100%' : 'Hold Ctrl and scroll to zoom cards, click to reset to 100%'" @click="doResetZoom">
        <i class="fa fa-search-plus"></i> {{ Math.round(sliceZoom * 100) }}%
      </span>
      <span class="kt-label" :class="isEmbedded ? 'ok' : 'warn'" :title="store.locales=='zh' ? '已向量化切片/总切片' : 'embedded/total slices'">
        <i class="fa fa-magnet"></i> {{ embeddedCount }}/{{ blocks.length }}
      </span>
    </div>

    <!-- 卡片网格 -->
    <div class="blocks scoll" style="flex:1;min-height:0;" @dragover.prevent @scroll="onScroll" @wheel="onWheel"
      :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${sliceViewCfg.minColWidth}px, 1fr))` }">
      <!-- 无切片 / 无命中提示 -->
      <div v-if="isEmpty" style="grid-column:1/-1;position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--borderColor);font-size:12px;">
        <i :class="blocks.length === 0 ? 'fa fa-scissors' : (isSearching ? 'fa fa-search' : 'fa fa-folder-open-o')" style="font-size:20px;"></i>
        <div style="margin-top:8px;">
          <template v-if="blocks.length === 0">
            {{ store.locales=='zh' ? '暂无切片，请点击上方切片按钮或读取知识库' : 'No slices yet, click the slice button above or load the knowledge base' }}
          </template>
          <template v-else-if="isSearching">
            {{ store.locales=='zh' ? '未找到包含检索词的切片，请更换关键词' : 'No slices match your keyword, try another term' }}
          </template>
          <template v-else>
            {{ store.locales=='zh' ? '当前文档没有切片，请选择其他文档' : 'No slices for this document, choose another document' }}
          </template>
        </div>
      </div>
      <div v-for="(block, index) in visibleBlocks" :key="index" class="block scoll" :style="{ height: sliceViewCfg.cardHeight + 'px' }">
        <div class="label" :style="{ fontSize: sliceViewCfg.labelSize + 'px' }">
          <span class="ellipsis" :style="{color:block.state?'var(--fontActiveColor)':''}" :title="(block.A_vector?.length > 0 ? (store.locales=='zh' ? '[已向量化] ' : '[embedded] ') : (store.locales=='zh' ? '[未向量化] ' : '[not embedded] ')) + block.label">
            <i :class="store.icon(block.extension)"></i> 
            {{ block.label }}
          </span>
          <!-- 已向量化标记：普通图标（非按钮），未向量化时不显示；不展示相似度 -->
          <span v-if="block.A_vector?.length" class="slice-vec-ic"
                :title="block.A_vector.length + (store.locales=='zh' ? ' 维向量' : '-dim vector')">
            <i class="fa fa-magnet"></i>
          </span>
        </div>
        <hr />
        <block_md :content="block.A" :fontSize="sliceViewCfg.contentSize + 'px'" :maxHeight="sliceViewCfg.contentMaxHeight + 'px'"/>
      </div>

      <div v-if="isLoadingMore" style="grid-column:1/-1;text-align:center;padding:5px;color:var(--borderColor);">
        <i class="fa fa-spinner fa-spin"></i> {{ store.locales=='zh'?'正在加载...':'Loading...' }}
      </div>
      <div v-else-if="showAllFooter" style="grid-column:1/-1;text-align:center;padding:5px;color:var(--borderColor);">
        <i class="fa fa-check-circle"></i> {{ store.locales=='zh'?'已显示全部 ':'All ' }}{{ totalAll }} {{ store.locales=='zh'?'个切片':'slices loaded' }}
      </div>
      <div v-else-if="showMoreFooter" style="grid-column:1/-1;text-align:center;padding:5px;font-size:11px;color:var(--borderColor);">
        {{ totalShown }} / {{ totalAll }} · {{ store.locales=='zh'?'向下滚动加载更多':'scroll to load more' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 由 knowRAG 迁出的切片卡片样式（原为父组件 scoped，抽壳后随视图迁移） */
.blocks {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  align-items: start;
  align-content: start;
  padding: 0 5px;
  position: relative;
  box-sizing: border-box;
}
.block {
  position: relative;
  word-wrap: break-word;
  border: 1px solid var(--borderColor);
  margin: 0 5px 5px 0;
  border-radius: 5px;
  height: 150px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.block hr {
  width: calc(100% - 6px);
  border-color: var(--borderColor);
  margin: 2px;
}
.block .label {
  font-size: 10px;
  width: calc(100% - 6px);
  margin: 3px;
  display: flex;
  align-items: center;
}
.ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
/* 已向量化标记：普通图标（无 button 样式），图标本体固定用主题色 */
.slice-vec-ic {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  margin-left: 5px;
  color: #4CAF50;
  font-size: inherit;
}
.slice-vec-ic i { color: inherit; }
</style>
