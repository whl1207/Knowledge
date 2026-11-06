<!-- /sliceView.vue - 切片视图（工具栏 + 卡片网格）；逻辑/数据由父壳 knowRAG 注入 -->
<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import block_md from '@/components/block_md.vue'
import { matchSliceKeyword } from '@/shared/kbSliceSearch'

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
  /** 滚动到底部附近时触发；由父壳增加 displayedCount */
  onLoadMore?: () => void
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

// ===== 切片本地搜索（展示层过滤）：输入防抖，命中结果只算一次 =====
const localKw = ref('')
/** 实际参与过滤的关键词（输入后 160ms 生效，避免每个按键都全量扫切片） */
const displayKw = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
const isSearching = computed(() => !!displayKw.value.trim())
const trimKw = computed(() => displayKw.value.trim().toLowerCase())
// 匹配逻辑与父壳共用（@/shared/kbSliceSearch）：按切片缓存小写文本，避免每次输入重复 toLowerCase 整段正文
const matchSlice = (b: any, kw: string) => matchSliceKeyword(b, kw)
// 命中切片只过滤一次，计数和展示共用
const searchHits = computed(() => {
    const kw = trimKw.value
    return kw ? props.blocks.filter((b: any) => matchSlice(b, kw)) : []
})
const matchTotal = computed(() => (isSearching.value ? searchHits.value.length : props.filteredBlocks.length))
const visibleBlocks = computed(() => {
    if (!isSearching.value) return props.displayedBlocks
    const take = Math.max(1, Math.min(props.displayedCount, searchHits.value.length))
    return searchHits.value.slice(0, take)
})
const isEmpty = computed(() => (isSearching.value ? matchTotal.value === 0 : props.filteredBlocks.length === 0))
const onSearchInput = (val: string) => {
    localKw.value = val
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
        searchTimer = null
        displayKw.value = val
        props.onSearch?.(val)
    }, 160)
}
const clearSearch = () => {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
    localKw.value = ''
    displayKw.value = ''
    props.onSearch?.('')
}
// 外部（如父壳重置/加载）同步关键字
watch(() => props.searchKeyword, (v) => {
    const kw = v ?? ''
    if (kw !== localKw.value) {
        localKw.value = kw
        displayKw.value = kw
    }
})
onBeforeUnmount(() => {
    if (searchTimer) clearTimeout(searchTimer)
})

// ===== 卡片懒渲染：默认纯文本摘要，进入视口 / 点击后再渲染 block_md =====
const sliceRoot = ref<HTMLElement | null>(null)
const loadSentinel = ref<HTMLElement | null>(null)
const mdReady = ref<Set<string>>(new Set())
const expandedCards = ref<Set<string>>(new Set())
const cardEls = new Map<string, Element>()
let cardObserver: IntersectionObserver | null = null
let loadObserver: IntersectionObserver | null = null
const supportsIO = typeof IntersectionObserver !== 'undefined'

function cardKey(block: any, index: number): string {
    return String(block?.id ?? block?.label ?? index)
}
function markMdReady(key: string): void {
    if (mdReady.value.has(key)) return
    const next = new Set(mdReady.value)
    next.add(key)
    mdReady.value = next
}
function bindCard(el: any, key: string): void {
    if (!el) return
    el.dataset.sliceKey = key
    cardEls.set(key, el)
    cardObserver?.observe(el)
}
function shouldRenderMd(block: any, index: number): boolean {
    if (!supportsIO) return true
    const key = cardKey(block, index)
    return expandedCards.value.has(key) || mdReady.value.has(key)
}
function toggleCard(block: any, index: number): void {
    const key = cardKey(block, index)
    const next = new Set(expandedCards.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expandedCards.value = next
    markMdReady(key)
}
function plainPreview(block: any): string {
    const text = String(block?.A || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#>*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    return text.length > 220 ? `${text.slice(0, 220)}…` : text
}

onMounted(() => {
    if (!supportsIO) return
    cardObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue
            const key = (entry.target as HTMLElement).dataset.sliceKey
            if (key) markMdReady(key)
        }
    }, { root: sliceRoot.value, rootMargin: '240px 0px' })
    for (const el of cardEls.values()) cardObserver.observe(el)
    if (loadSentinel.value) {
        loadObserver = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting) && props.hasMoreBlocks && !props.isLoadingMore) {
                props.onLoadMore?.()
            }
        }, { root: sliceRoot.value, rootMargin: '400px 0px' })
        loadObserver.observe(loadSentinel.value)
    }
})
onBeforeUnmount(() => {
    cardObserver?.disconnect()
    loadObserver?.disconnect()
})

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
    <div class="blocks scoll" ref="sliceRoot" style="flex:1;min-height:0;" @dragover.prevent @wheel="onWheel"
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
      <div
        v-for="(block, index) in visibleBlocks"
        :key="block.id ?? block.label ?? index"
        :ref="(el: any) => bindCard(el, cardKey(block, index))"
        class="block scoll"
        :style="{ height: sliceViewCfg.cardHeight + 'px' }"
        @click="toggleCard(block, index)"
      >
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
        <block_md v-if="shouldRenderMd(block, index)" :content="block.A" :fontSize="sliceViewCfg.contentSize + 'px'" :maxHeight="sliceViewCfg.contentMaxHeight + 'px'"/>
        <div v-else class="slice-preview">{{ plainPreview(block) }}</div>
      </div>

      <!-- 无限滚动哨兵：进入视口附近才加下一批，不再监听 scroll -->
      <div ref="loadSentinel" class="slice-load-sentinel" aria-hidden="true"></div>

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
/* 工具栏换行而不是横向滚动：窄屏/条目多时所有按钮都能点到 */
.kt-toolbar {
  overflow-x: hidden;
  flex-wrap: wrap;
  row-gap: 4px;
}
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
  cursor: pointer;
  content-visibility: auto;
  contain-intrinsic-size: 150px 220px;
}
.slice-preview {
  padding: 2px 6px 6px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--fontColor);
  opacity: .82;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
}
.slice-load-sentinel {
  grid-column: 1 / -1;
  width: 100%;
  height: 1px;
  pointer-events: none;
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
