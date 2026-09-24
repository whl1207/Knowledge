<!-- strategyConfig.vue - 检索策略配置（样式参照 AgentPreset：左栏策略列表 + 右栏 tab 配置） -->
<template>
  <div class="agent-preset sc-strategy">
    <!-- ====== 左侧：策略列表 ====== -->
    <div class="contact-sidebar">
      <div class="top-toolbar contact-toolbar">
        <div class="notes-search-box">
          <i class="fa fa-search"></i>
          <input v-model="keyword" class="notes-search-input" :placeholder="t('搜索策略', 'Search strategies')" />
          <div v-if="keyword" class="notes-search-clear" @click="keyword = ''" :title="t('清除', 'Clear')">
            <i class="fa fa-times-circle"></i>
          </div>
        </div>
        <button class="toolbar-action-btn sc-toolbar-add" @click="addStrategy" :title="t('新建策略', 'New Strategy')">
          <i class="fa fa-plus"></i>
        </button>
      </div>
      <div class="contact-sidebar-list scoll">
        <div v-if="filteredStrategies.length === 0" class="empty-hint" style="height:auto;padding:16px 0;">
          <i class="fa fa-cubes" style="font-size:20px;"></i>
          <span>{{ t('暂无匹配策略', 'No matching strategies') }}</span>
        </div>
        <div
          v-for="s in filteredStrategies" :key="s.id"
          class="contact-item" :class="{ active: s.id === selectedId, off: s.enabled === false }"
          @click="selectedId = s.id">
          <div class="contact-item-avatar"><i :class="kindIcon(s.kind)"></i></div>
          <div class="contact-item-info">
            <span class="contact-item-name">{{ s.label }}</span>
            <span class="contact-item-tags">
              <span class="contact-tag-chip">{{ s.builtin ? t('内置', 'builtin') : t('自定义', 'custom') }}</span>
              <span v-if="s.enabled === false" class="contact-tag-chip sc-off-tag">{{ t('已停用', 'off') }}</span>
              <span v-if="s.kind === 'pipeline'" class="contact-tag-chip">{{ s.steps.length }}{{ t('步', ' steps') }}</span>
            </span>
          </div>
          <!-- 启用/停用开关（与技能面板一致：列表项右侧直接切换） -->
          <span class="preset-tool-toggle sc-list-toggle" :class="{ on: s.enabled !== false }"
                :title="s.enabled === false
                  ? t('启用该策略（用于测试与问答下拉）', 'Enable this strategy (for tests & QA dropdown)')
                  : t('停用该策略（不参与测试与问答下拉）', 'Disable this strategy (excluded from tests & QA dropdown)')"
                @click.stop="toggleStrategyEnabled(s)">
            <i class="preset-toggle-knob"></i>
          </span>
          <button v-if="!s.builtin" class="contact-item-del" @click.stop="deleteStrategy(s.id)" :title="t('删除策略', 'Delete')">
            <i class="fa fa-trash"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- ====== 右侧：策略配置编辑 ====== -->
    <div class="contact-content">
      <div v-if="!selected" class="empty-hint" style="height:100%;">
        <i class="fa fa-cubes" style="font-size:36px;"></i>
        <span>{{ t('选择左侧策略进行编辑', 'Select a strategy on the left to edit') }}</span>
      </div>
      <div v-else class="ae-body scoll">
        <!-- 通用：名称 / 类型（置于最上方，类型可切换以支持智能路由 / 社区全局等） -->
        <div class="cfg-row column cfg-box">
          <div class="cfg-row" ref="headRowRef">
            <label>{{ t('名称', 'Name') }}</label>
            <input v-model="selected.label" class="sc-kind-name" :placeholder="t('策略名称', 'Strategy name')" />
            <label class="sc-kind-label">{{ t('类型', 'Kind') }}</label>
            <select v-model="selected.kind" class="sc-kind-select" @change="onKindChange"
                    :title="t('策略类型：管线组合 / 社区全局 / 智能路由', 'Kind: pipeline / mapreduce / agentic')">
              <option value="pipeline">{{ kindLabel('pipeline') }}</option>
              <option value="mapreduce">{{ kindLabel('mapreduce') }}</option>
              <option value="agentic">{{ kindLabel('agentic') }}</option>
              <option value="hybrid">{{ kindLabel('hybrid') }}</option>
            </select>
            <button v-if="selected.builtin" ref="resetBtnRef" class="sc-reset-btn" @click="resetStrategy(selected.id)" :title="t('恢复该内置策略的默认设置', 'Reset to defaults')">
              <i class="fa fa-undo"></i>
            </button>
          </div>
        </div>

        <!-- Tab 栏（名称/类型下方；仅管线组合需要 tab 切换；社区全局 / 智能路由合并为一页） -->
        <div v-if="selected.kind === 'pipeline'" class="ae-tabs">
          <button class="ae-tab" :class="{ on: activeTab === 'ingest' }" @click="activeTab = 'ingest'">
            <i class="fa fa-cogs"></i> <span class="ae-tab-text">{{ t('处理管线', 'Ingest') }}</span>
            <span v-if="missingIngestDeps.length" class="sc-dep-badge" :title="t('检索管线缺少依赖的处理原语', 'Retrieval pipeline missing required ingestion primitives')">{{ missingIngestDeps.length }}</span>
          </button>
          <button class="ae-tab" :class="{ on: activeTab === 'pipeline' }" @click="activeTab = 'pipeline'">
            <i class="fa fa-cubes"></i> <span class="ae-tab-text">{{ t('检索管线', 'Pipeline') }}</span>
          </button>
          <button class="ae-tab" :class="{ on: activeTab === 'params' }" @click="activeTab = 'params'">
            <i class="fa fa-sliders"></i> <span class="ae-tab-text">{{ t('检索参数', 'Params') }}</span>
          </button>
        </div>

        <!-- 处理管线（仅管线组合，tab 页） -->
        <div v-if="activeTab === 'ingest' && selected.kind === 'pipeline'" class="ae-tab-body">
          <div class="cap-body">
            <!-- 检索管线依赖缺失提示：检索管线有步骤但处理管线缺依赖原语 -->
            <div v-if="missingIngestDeps.length" class="sc-dep-warn">
              <div class="sc-dep-warn-title">
                <i class="fa fa-exclamation-triangle"></i>
                {{ t('检索管线缺少依赖的处理原语', 'Retrieval pipeline is missing required ingestion primitives') }}
              </div>
              <div v-for="w in missingIngestDeps" :key="w.retrieval" class="sc-dep-warn-row">
                <span class="sc-dep-warn-prim">{{ t(PRIMITIVE_META[w.retrieval]?.label || w.retrieval, PRIMITIVE_META[w.retrieval]?.labelEn || w.retrieval) }}</span>
                <i class="fa fa-arrow-right sc-dep-warn-arrow"></i>
                <span v-for="p in w.missing" :key="p" class="contact-tag-chip sc-dep-chip-missing">
                  {{ t(PRIMITIVE_META[p]?.label || p, PRIMITIVE_META[p]?.labelEn || p) }}
                </span>
              </div>
              <button class="skill-bulk-btn sc-dep-add-all" @click="addMissingIngestDeps">
                <i class="fa fa-plus"></i> {{ t('一键补齐以上处理原语', 'Add missing primitives') }}
              </button>
            </div>
            <div class="preset-tool-list">
              <div v-for="(step, idx) in selected.ingestionSteps" :key="'i' + idx" class="preset-tool-item sc-step-item"
                :title="t(PRIMITIVE_META[step.primitive]?.description || '', PRIMITIVE_META[step.primitive]?.descriptionEn || '')">
                <select v-model="step.primitive" class="sc-inline-select sc-primitive-select" @change="onIngestPrimitiveChange(step)">
                  <option v-for="(p, pid) in ingestionPrimitives" :key="pid" :value="pid">{{ t(p.label, p.labelEn) }}</option>
                </select>
                <span v-if="paramFields(step.primitive).length" class="sc-step-params">
                  <span v-for="f in paramFields(step.primitive)" :key="f.key" class="sc-param">
                    <label class="sc-param-label">{{ t(f.label, f.labelEn) }}:</label>
                    <input v-if="f.type === 'text'" type="text" v-model="step.params[f.key]" class="sc-inline-input sc-param-text" :placeholder="t(f.placeholder || '', f.placeholderEn || '')" />
                  </span>
                </span>
                <span class="sc-step-ops">
                  <i class="fa fa-arrow-up sc-op" :class="{ disabled: idx === 0 }" :title="t('上移', 'Up')" @click="moveIngestStep(idx, -1)"></i>
                  <i class="fa fa-arrow-down sc-op" :class="{ disabled: idx === selected.ingestionSteps.length - 1 }" :title="t('下移', 'Down')" @click="moveIngestStep(idx, 1)"></i>
                  <i class="fa fa-times sc-op danger" :title="t('移除', 'Remove')" @click="removeIngestStep(idx)"></i>
                </span>
              </div>
              <!-- 添加处理原语：置于列表内部底部（与检索管线「添加检索原语」同款虚线按钮） -->
              <button class="preset-tool-item sc-step-item sc-add-step" @click="addIngestStep">
                <span class="sc-add-step-icon"><i class="fa fa-plus"></i></span>
                <span class="sc-add-step-text">{{ t('添加处理原语', 'Add Primitive') }}</span>
              </button>
            </div>
            <p class="sc-special-hint" style="margin-top:6px;">{{ t('处理管线在构建/提取阶段执行（问题增强：问题由独立问题库承载，每条带向量并经关联切片索引参与检索）；对已处理数据自动跳过（幂等）。', 'Ingestion pipeline runs at build time (question enhance: questions live in the question bank with vectors, joined to slices via index); already-processed data is skipped (idempotent).') }}</p>
          </div>
        </div>

        <!-- 检索管线：查询阶段原语编辑（仅管线组合，tab 页） -->
        <div v-if="activeTab === 'pipeline' && selected.kind === 'pipeline'" class="ae-tab-body">
          <div class="cap-body">
            <!-- 问题增强通道开关：策略含 dense_score 步骤时显示；联动增强权重与处理管线的 semantic_enhance -->
            <div v-if="hasDenseScore" class="cfg-row sc-channel-row">
              <label>{{ t('问题增强通道', 'Question Channel') }}</label>
              <label class="preset-checkbox">
                <input type="checkbox" v-model="semanticChannel" />
                <span>{{ t('启用问题增强通道（问题库中关联切片的问题向量参与检索；关闭=纯切片向量）', 'Enable question enhance channel (question vectors joined to slices participate in retrieval; off = pure slice vectors)') }}</span>
              </label>
              <span class="sc-channel-state" :class="semanticChannelOn ? 'on' : ''">
                {{ semanticChannelOn ? t('已开启', 'On') : t('已关闭', 'Off') }}
              </span>
            </div>
            <div class="preset-tool-list">
              <div v-for="(step, idx) in selected.steps" :key="'r' + idx" class="preset-tool-item sc-step-item"
                :title="t(PRIMITIVE_META[step.primitive]?.description || '', PRIMITIVE_META[step.primitive]?.descriptionEn || '')">
                <select v-model="step.primitive" class="sc-inline-select sc-primitive-select" @change="onPrimitiveChange(step)">
                  <option v-for="(p, pid) in retrievalPrimitives" :key="pid" :value="pid">{{ t(p.label, p.labelEn) }}</option>
                </select>
                <select v-model="step.mode" class="sc-inline-select sc-mode-select">
                  <option value="set">{{ t('设置基础分', 'Set') }}</option>
                  <option value="multiply">{{ t('乘性提升', 'Multiply') }}</option>
                  <option value="weighted">{{ t('加权融合', 'Weighted') }}</option>
                  <option value="max">{{ t('取最大', 'Max') }}</option>
                </select>
                <span v-if="paramFields(step.primitive).length" class="sc-step-params">
                  <span v-for="f in paramFields(step.primitive)" :key="f.key" class="sc-param">
                    <label v-if="f.type !== 'checkbox'" class="sc-param-label">{{ t(f.label, f.labelEn) }}:</label>
                    <input v-if="f.type === 'number'" type="number" v-model.number="step.params[f.key]" :min="f.min" :max="f.max" :step="f.step" class="sc-inline-input" />
                    <label v-else-if="f.type === 'checkbox'" class="preset-checkbox sc-param-check">
                      <input type="checkbox" v-model="step.params[f.key]" />
                      <span>{{ t(f.label, f.labelEn) }}</span>
                    </label>
                    <select v-else v-model="step.params[f.key]" class="sc-inline-select sc-param-select">
                      <option v-for="o in f.options" :key="o.value" :value="o.value">{{ t(o.label, o.labelEn || o.label) }}</option>
                    </select>
                  </span>
                </span>
                <span class="sc-step-ops">
                  <i class="fa fa-arrow-up sc-op" :class="{ disabled: idx === 0 }" :title="t('上移', 'Up')" @click="moveStep(idx, -1)"></i>
                  <i class="fa fa-arrow-down sc-op" :class="{ disabled: idx === selected.steps.length - 1 }" :title="t('下移', 'Down')" @click="moveStep(idx, 1)"></i>
                  <i class="fa fa-times sc-op danger" :title="t('移除', 'Remove')" @click="removeStep(idx)"></i>
                </span>
              </div>
              <button class="preset-tool-item sc-step-item sc-add-step" @click="addStep">
                <span class="sc-add-step-icon"><i class="fa fa-plus"></i></span>
                <span class="sc-add-step-text">{{ t('添加检索原语', 'Add Primitive') }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 检索参数（仅管线组合，tab 页） -->
        <div v-if="activeTab === 'params' && selected.kind === 'pipeline'" class="ae-tab-body">
          <div class="cfg-row column cfg-box">
            <div class="cfg-row">
              <label>{{ t('召回数量', 'TopK') }}</label>
              <input type="number" v-model.number="model.searchNum" min="1" max="20" />
            </div>
            <div class="cfg-row">
              <label>{{ t('检索模式', 'Mode') }}</label>
              <select v-model="model.searchMode">
                <option v-for="m in searchModes" :key="m" :value="m">{{ t(m, m) }}</option>
              </select>
            </div>
            <div v-if="model.searchMode === '按匹配率'" class="cfg-row">
              <label>{{ t('匹配率阈值', 'Ratio') }}</label>
              <input type="number" v-model.number="model.matchRatio" min="0" max="1" step="0.01" />
            </div>
            <div v-else-if="model.searchMode === '按字符'" class="cfg-row">
              <label>{{ t('字符限制', 'Chars') }}</label>
              <input type="number" v-model.number="model.searchCharacter" min="100" max="10000" />
            </div>
            <div class="cfg-row">
              <label>{{ t('BM25', 'BM25') }}</label>
              <label class="preset-checkbox">
                <input type="checkbox" v-model="model.bm25Enabled" />
                <span>{{ t('启用', 'Enable') }}</span>
              </label>
            </div>
            <div v-if="model.bm25Enabled" class="cfg-row">
              <label>{{ t('BM25权重', 'BM25W') }}</label>
              <input type="range" v-model.number="model.bm25Weight" min="0" max="1" step="0.01" style="flex:1;" />
              <span style="font-size:10px;min-width:24px;text-align:right;">{{ model.bm25Weight.toFixed(2) }}</span>
            </div>
          </div>
        </div>

        <!-- 社区全局 / 智能路由：处理管线 + 检索参数合并为一页（无需 tab 切换） -->
        <div v-if="selected.kind !== 'pipeline'" class="ae-tab-body">
          <div class="cfg-row column cfg-box">
            <!-- 涉及原语 / Agentic 工具与处理依赖 -->
            <template v-if="selected.kind === 'agentic'">
              <label>{{ t('Agentic 工具与处理依赖', 'Agent Tools & Dependencies') }}</label>
              <div class="sc-tool-dep-grid">
                <div v-for="opt in AGENT_TOOL_OPTIONS" :key="opt.key"
                     class="preset-tool-item sc-agent-tool"
                     :class="{ on: !!selected.agentTools![opt.key] }"
                     @click="selected.agentTools![opt.key] = !selected.agentTools![opt.key]"
                     :title="t(opt.desc, opt.descEn)">
                  <span class="preset-tool-icon"><i class="fa" :class="opt.icon"></i></span>
                  <span class="preset-tool-info">
                    <span class="preset-tool-name">{{ t(opt.label, opt.labelEn) }}</span>
                    <span class="sc-tool-deps">
                      <span v-for="p in (AGENT_TOOL_INGESTION[opt.key] || [])" :key="p" class="contact-tag-chip sc-dep-chip">
                        {{ t(PRIMITIVE_META[p]?.label || p, PRIMITIVE_META[p]?.labelEn || p) }}
                      </span>
                    </span>
                  </span>
                  <span class="preset-tool-toggle" :class="{ on: !!selected.agentTools![opt.key] }"><i class="preset-toggle-knob"></i></span>
                </div>
              </div>
              <div class="cfg-row" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--borderColor);">
                <label>{{ t('处理管线（按工具合并，只读）', 'Ingestion pipeline (merged, read-only)') }}</label>
                <span class="sc-kind-primitives">
                  <span v-for="st in agentIngestionSteps" :key="st.primitive" class="contact-tag-chip">
                    {{ t(PRIMITIVE_META[st.primitive]?.label || st.primitive, PRIMITIVE_META[st.primitive]?.labelEn || st.primitive) }}
                  </span>
                </span>
              </div>
              <p class="sc-special-hint" style="margin-top:8px;">{{ agenticPrinciple }}</p>
            </template>
            <template v-else-if="selected.kind === 'hybrid'">
              <label>{{ t('召回通道与处理依赖', 'Recall Channels & Dependencies') }}</label>
              <div class="sc-tool-dep-grid">
                <div v-for="opt in CHANNEL_OPTIONS" :key="opt.key"
                     class="preset-tool-item sc-agent-tool"
                     :class="{ on: !!selected.channels![opt.key] }"
                     @click="selected.channels![opt.key] = !selected.channels![opt.key]"
                     :title="t(opt.desc, opt.descEn)">
                  <span class="preset-tool-icon"><i class="fa" :class="opt.icon"></i></span>
                  <span class="preset-tool-info">
                    <span class="preset-tool-name">{{ t(opt.label, opt.labelEn) }}</span>
                    <span class="sc-tool-deps">
                      <span v-for="p in (CHANNEL_INGESTION[opt.key] || [])" :key="p" class="contact-tag-chip sc-dep-chip">
                        {{ t(PRIMITIVE_META[p]?.label || p, PRIMITIVE_META[p]?.labelEn || p) }}
                      </span>
                    </span>
                  </span>
                  <span class="preset-tool-toggle" :class="{ on: !!selected.channels![opt.key] }"><i class="preset-toggle-knob"></i></span>
                </div>
              </div>
              <div class="cfg-row" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--borderColor);">
                <label>{{ t('处理管线（按通道合并，只读）', 'Ingestion pipeline (merged, read-only)') }}</label>
                <span class="sc-kind-primitives">
                  <span v-for="st in hybridIngestionSteps" :key="st.primitive" class="contact-tag-chip">
                    {{ t(PRIMITIVE_META[st.primitive]?.label || st.primitive, PRIMITIVE_META[st.primitive]?.labelEn || st.primitive) }}
                  </span>
                </span>
              </div>
              <div class="cfg-row" style="margin-top:8px;">
                <label>{{ t('排序方式', 'Rerank') }}</label>
                <select v-model="selected.rerank!.metric" style="width:110px;">
                  <option value="cosine">{{ t('余弦重排', 'Cosine') }}</option>
                  <option value="rrf">{{ t('RRF 排名融合', 'RRF') }}</option>
                </select>
                <label style="margin-left:10px;">{{ t('TopK', 'TopK') }}</label>
                <input type="number" v-model.number="selected.rerank!.topK" min="1" max="30" style="width:56px;" />
              </div>
              <p class="sc-special-hint" style="margin-top:8px;">{{ hybridPrinciple }}</p>
            </template>
            <template v-else>
              <div class="cfg-row">
                <label>{{ t('涉及原语', 'Primitives') }}</label>
                <span class="sc-kind-primitives">
                  <span v-for="p in kindPrimitives(selected.kind)" :key="p" class="contact-tag-chip">
                    {{ t(PRIMITIVE_META[p]?.label || p, PRIMITIVE_META[p]?.labelEn || p) }}
                  </span>
                </span>
              </div>
              <p class="sc-special-hint" style="margin-top:8px;">{{ kindDescription(selected.kind) }}</p>
            </template>

            <!-- 检索参数 -->
            <div v-if="selected.kind === 'agentic'" class="cfg-row">
              <label>{{ t('Agentic 最大步数', 'Agent Max Rounds') }}</label>
              <input type="number" v-model.number="selected.maxRounds" min="1" max="10" step="1" />
            </div>
            <div class="cfg-row">
              <label>{{ t('召回数量', 'TopK') }}</label>
              <input type="number" v-model.number="model.searchNum" min="1" max="20" />
            </div>
            <div class="cfg-row">
              <label>{{ t('检索模式', 'Mode') }}</label>
              <select v-model="model.searchMode">
                <option v-for="m in searchModes" :key="m" :value="m">{{ t(m, m) }}</option>
              </select>
            </div>
            <div v-if="model.searchMode === '按匹配率'" class="cfg-row">
              <label>{{ t('匹配率阈值', 'Ratio') }}</label>
              <input type="number" v-model.number="model.matchRatio" min="0" max="1" step="0.01" />
            </div>
            <div v-else-if="model.searchMode === '按字符'" class="cfg-row">
              <label>{{ t('字符限制', 'Chars') }}</label>
              <input type="number" v-model.number="model.searchCharacter" min="100" max="10000" />
            </div>
            <div class="cfg-row">
              <label>{{ t('BM25', 'BM25') }}</label>
              <label class="preset-checkbox">
                <input type="checkbox" v-model="model.bm25Enabled" />
                <span>{{ t('启用', 'Enable') }}</span>
              </label>
            </div>
            <div v-if="model.bm25Enabled" class="cfg-row">
              <label>{{ t('BM25权重', 'BM25W') }}</label>
              <input type="range" v-model.number="model.bm25Weight" min="0" max="1" step="0.01" style="flex:1;" />
              <span style="font-size:10px;min-width:24px;text-align:right;">{{ model.bm25Weight.toFixed(2) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { getBuiltinStrategies, getStrategies, setUserStrategies, deriveAgentIngestion, deriveChannelIngestion, AGENT_TOOL_INGESTION, CHANNEL_INGESTION } from '@/shared/graphrag/strategy'
import { PRIMITIVE_META } from '@/shared/graphrag/primitives'
import type { RetrievalPrimitiveId, IngestionPrimitiveId } from '@/shared/graphrag/primitives'

interface Props {
  store: any
  model: any
}
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'change'): void }>()

const t = (zh: string, en: string) => (props.store?.locales === 'zh' ? zh : en)

const STORAGE_KEY = 'knowrag_strategies'

interface EditableStep {
  primitive: RetrievalPrimitiveId
  mode: string
  params: any
}
interface EditableIngestStep {
  primitive: IngestionPrimitiveId
  params: any
}
interface EditableStrategy {
  id: string
  label: string
  kind: 'pipeline' | 'mapreduce' | 'agentic' | 'hybrid'
  steps: EditableStep[]
  ingestionSteps: EditableIngestStep[]
  agentTools?: Record<string, boolean>
  maxRounds?: number
  channels?: Record<string, boolean>
  channelTopN?: Record<string, number>
  rerank?: { metric?: 'cosine' | 'rrf'; topK?: number }
  builtin?: boolean
  /** 开关：停用后不参与测试与问答下拉 */
  enabled?: boolean
}

const strategies = ref<EditableStrategy[]>([])
const selectedId = ref('')
const keyword = ref('')
const activeTab = ref('ingest')

const selected = computed(() => strategies.value.find(s => s.id === selectedId.value))

// 名称/类型头部行与其“恢复默认”按钮：运行时测量使按钮与左侧输入框同高（避免硬编码把输入压矮）
const headRowRef = ref<HTMLElement | null>(null)
const resetBtnRef = ref<HTMLElement | null>(null)
function syncResetHeight() {
  nextTick(() => {
    const row = headRowRef.value
    if (!row) return
    const input = row.querySelector('input') as HTMLElement | null
    const sel = row.querySelector('select') as HTMLElement | null
    const btn = resetBtnRef.value
    // 取类型下拉 / 名称输入中的实际较高者，让三者（名称输入、类型下拉、恢复默认）等高
    const h = Math.max(input?.offsetHeight || 0, sel?.offsetHeight || 0)
    if (!h) return
    if (input) input.style.height = `${h}px`
    if (btn) btn.style.height = `${h}px`
  })
}
watch(() => [selectedId.value, selected.value?.builtin, selected.value?.kind], () => syncResetHeight())

const filteredStrategies = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return strategies.value
  return strategies.value.filter(s => s.label.toLowerCase().includes(kw) || s.id.toLowerCase().includes(kw))
})

const searchModes = ['按数量', '按匹配率', '按字符']

// 检索原语（查询阶段，可放入检索管线）
const retrievalPrimitives = Object.entries(PRIMITIVE_META)
  .filter(([, m]) => m.category === 'retrieval')
  .reduce<Record<string, { label: string; labelEn: string }>>((acc, [id, m]) => {
    acc[id] = { label: m.label, labelEn: m.labelEn }
    return acc
  }, {})

// 处理原语（摄取阶段，可放入处理管线）
const ingestionPrimitives = Object.entries(PRIMITIVE_META)
  .filter(([, m]) => m.category === 'ingestion')
  .reduce<Record<string, { label: string; labelEn: string }>>((acc, [id, m]) => {
    acc[id] = { label: m.label, labelEn: m.labelEn }
    return acc
  }, {})

// 原语参数定义（type: 'number' | 'select' | 'text' | 'checkbox'）
const PARAM_FIELDS: Record<string, Array<{ key: string; label: string; labelEn: string; type: 'number' | 'select' | 'text' | 'checkbox'; min?: number; max?: number; step?: number; placeholder?: string; placeholderEn?: string; options?: Array<{ value: string; label: string; labelEn?: string }> }>> = {
  dense_score: [
    { key: 'summaryWeight', label: '增强权重', labelEn: 'Enhance', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  file_score: [
    { key: 'weight', label: '文件打分权重', labelEn: 'File Weight', type: 'number', min: 0, max: 1, step: 0.05 },
  ],
  graph_hop: [
    { key: 'hops', label: '跳数', labelEn: 'Hops', type: 'number', min: 1, max: 3 },
    { key: 'maxPerHop', label: '上限', labelEn: 'Max', type: 'number', min: 1, max: 10 },
  ],
  boost: [
    {
      key: 'source', label: '来源', labelEn: 'Source', type: 'select',
      options: [
        { value: 'entity', label: '实体', labelEn: 'Entity' },
        { value: 'hop', label: '多跳', labelEn: 'Multi-hop' },
        { value: 'community', label: '社区', labelEn: 'Community' },
      ],
    },
    { key: 'boostWeight', label: '倍率', labelEn: 'Weight', type: 'number', min: 1, max: 3, step: 0.1 },
  ],
  semantic_enhance: [
    {
      key: 'processPrompt', label: '问题生成提示词', labelEn: 'Prompt', type: 'text',
      placeholder: '请阅读下面的资料，列出这些资料能够解答的若干问题。只输出问题本身，每行一个，不要编号/标题/分组/解释...',
      placeholderEn: 'Read the info and list several questions it can answer. Output only questions, one per line, no numbering/headings...',
    },
  ],
  summarize_file: [
    {
      key: 'fileSummaryPrompt', label: '文件摘要提示词', labelEn: 'Summary Prompt', type: 'text',
      placeholder: '你是知识库索引助手。请阅读下面的文件内容，通过推理提炼出该文件的摘要...',
      placeholderEn: 'You are a KB index assistant. Read the file content and reason out its summary...',
    },
  ],
}

const paramFields = (primitive: string) => PARAM_FIELDS[primitive] || []

// 原语参数值回填默认值（text 参数为空时使用全局配置，见 runIngestion）
const ensureParams = (step: any) => {
  if (!step.params) step.params = {}
  return step.params
}

function kindIcon(kind: string): string {
  return kind === 'pipeline' ? 'fa fa-cubes' : kind === 'mapreduce' ? 'fa fa-users' : kind === 'hybrid' ? 'fa fa-th-large' : 'fa fa-magic'
}

function kindLabel(kind: string): string {
  return kind === 'pipeline' ? t('管线组合', 'Pipeline')
    : kind === 'mapreduce' ? t('社区全局', 'Map-Reduce')
    : kind === 'hybrid' ? t('多路混合', 'Hybrid')
    : t('智能路由', 'Agentic')
}

function kindDescription(kind: string): string {
  if (kind === 'pipeline') return t('按配置的原语顺序执行并融合打分（可包含实体链接 / 多跳 / 社区等）', 'Executes primitives in order and fuses scores (may include entity link / multi-hop / community)')
  if (kind === 'mapreduce') return t('基于社区报告的全局 Map-Reduce 搜索，需要先构建本体并生成社区报告。', 'Global Map-Reduce search over community reports. Requires ontology + community reports.')
  if (kind === 'hybrid') return t('确定性多通道召回（语义/实体/文件/社区/图谱），候选合并后统一排序取 topK，无 LLM 路由，结果稳定可复现。', 'Deterministic multi-channel recall (dense/entity/file/community/graph), candidates merged and ranked by a unified scorer, no LLM routing, stable and reproducible.')
  return t('LLM 在 kb_search / file_search / entity_link / graph_hop / community_search 等检索原语之间自主路由，自适应选择检索策略。', 'LLM autonomously routes among kb_search / file_search / entity_link / graph_hop / community_search primitives.')
}

// 非管线策略涉及的原语（只读展示，解释为什么没有可编辑步骤）
const KIND_PRIMITIVES: Record<string, RetrievalPrimitiveId[]> = {
  mapreduce: ['community_select', 'dense_score'],
}
const kindPrimitives = (kind: string): RetrievalPrimitiveId[] => KIND_PRIMITIVES[kind] || []

// Agentic 可配置工具（开关，对应 buildAgenticTools 的 6 个检索工具）
const AGENT_TOOL_OPTIONS = [
  { key: 'kb_search', label: 'kb_search · 事实检索', labelEn: 'kb_search · factual', icon: 'fa-search', desc: '知识库稠密 + 文件语义检索', descEn: 'Dense + file-semantic KB search' },
  { key: 'file_search', label: 'file_search · 文件搜索', labelEn: 'file_search · file', icon: 'fa-files-o', desc: '检索文件摘要索引，返回整文件级信息', descEn: 'Search file summary index, returns whole-file info' },
  { key: 'entity_link', label: 'entity_link · 实体定位', labelEn: 'entity_link · entity', icon: 'fa-bullseye', desc: '定位查询中的本体实体', descEn: 'Locate ontology entities in query' },
  { key: 'entity_slice', label: 'entity_slice · 实体切片', labelEn: 'entity_slice · entity slices', icon: 'fa-th-list', desc: '收敛检索实体直接关联的切片', descEn: 'Converge on slices linked to an entity' },
  { key: 'graph_hop', label: 'graph_hop · 图谱多跳', labelEn: 'graph_hop · multi-hop', icon: 'fa-sitemap', desc: '沿关系边 1~2 跳扩展推理', descEn: 'Expand 1-2 hops over relations' },
  { key: 'community_search', label: 'community_search · 社区搜索', labelEn: 'community_search · community', icon: 'fa-users', desc: '检索社区报告全局概览', descEn: 'Retrieve community reports overview' },
]
const ensureAgentTools = (t?: Record<string, boolean>): Record<string, boolean> => ({
  kb_search: true, file_search: true, entity_link: true, entity_slice: true, graph_hop: true, community_search: true,
  ...(t || {}),
})

// Hybrid 可配置召回通道（开关，对应 runHybrid 的通道）
const CHANNEL_OPTIONS = [
  { key: 'dense', label: 'dense · 语义召回', labelEn: 'dense · semantic', icon: 'fa-search', desc: '切片稠密检索（+文件语义融合）', descEn: 'Dense slice retrieval (+file fusion)' },
  { key: 'entity', label: 'entity · 实体召回', labelEn: 'entity · entity', icon: 'fa-bullseye', desc: '定位实体直接关联的切片', descEn: 'Slices linked to located entities' },
  { key: 'file', label: 'file · 文件召回', labelEn: 'file · file', icon: 'fa-files-o', desc: '命中文件的切片', descEn: 'Slices of matched files' },
  { key: 'community', label: 'community · 社区召回', labelEn: 'community · community', icon: 'fa-users', desc: '命中社区的成员切片', descEn: 'Slices of matched communities' },
  { key: 'graph', label: 'graph · 图谱召回', labelEn: 'graph · graph', icon: 'fa-sitemap', desc: '多跳关联切片（可选）', descEn: 'Multi-hop linked slices (optional)' },
]
const ensureChannels = (c?: Record<string, boolean>): Record<string, boolean> => ({
  dense: true, entity: true, file: true, community: true, graph: false,
  ...(c || {}),
})
const ensureRerank = (r?: any): { metric: 'cosine' | 'rrf'; topK: number } => ({
  metric: (r && r.metric === 'rrf') ? 'rrf' : 'cosine',
  topK: (r && typeof r.topK === 'number' && r.topK > 0) ? r.topK : 10,
})

// Agentic 处理管线（由启用的工具推导，只读展示）
const agentIngestionSteps = computed(() => {
  const sel = selected.value
  if (!sel || sel.kind !== 'agentic') return []
  return deriveAgentIngestion(sel.agentTools || {})
})

// Hybrid 处理管线（由启用的通道推导，只读展示）
const hybridIngestionSteps = computed(() => {
  const sel = selected.value
  if (!sel || sel.kind !== 'hybrid') return []
  return deriveChannelIngestion(sel.channels || {})
})

// Hybrid 策略原理说明
const hybridPrinciple = computed(() => {
  if (selected.value?.kind !== 'hybrid') return ''
  return props.store?.locales === 'zh'
    ? '原理：按启用的通道并行召回候选切片（语义/实体/文件/社区/图谱），按切片 id 去重后统一排序（余弦重排或 RRF 排名融合），取 topK 进入上下文。无 LLM 路由，结果确定、可复现，适合消融对比。处理管线按启用的通道自动合并生成（只读）。'
    : 'Principle: enabled channels recall candidate slices in parallel (dense/entity/file/community/graph), dedup by slice id, then unified ranking (cosine rerank or RRF), topK into context. No LLM routing; deterministic & reproducible for ablations. Ingestion pipeline is auto-merged from enabled channels (read-only).'
})

// Agentic 策略原理说明（工具 ↔ 处理依赖 + 检索路由机制）
const agenticPrinciple = computed(() => {
  if (selected.value?.kind !== 'agentic') return ''
  return props.store?.locales === 'zh'
    ? '原理：LLM 将检索原语作为工具自主编排检索路径——单点事实用 kb_search（稠密检索 + 文件语义增强）；文件级/跨文档主题用 file_search（检索文件摘要索引，返回整文件信息），并可先用 file_search 定位文件、再以 kb_search 的 file 参数限定在该文件内检索切片（文件→切片两阶段检索）；关系/因果问题先用 entity_link 定位实体，再用 entity_slice 收敛检索该实体直接关联的切片（按问题相关度排序），或用 graph_hop 沿关系多跳扩展；全局/主题问题用 community_search 检索社区报告；复杂问题组合调用。多轮循环收集并合并证据后，基于资料给出带《引用》的回答。每个工具依赖相应的处理管线原语（离线构建索引），处理管线按启用的工具自动合并生成（只读），最大检索步数可在「检索参数」中配置。'
    : 'Principle: LLM routes among retrieval primitives as tools — kb_search for facts (dense + file-semantic), file_search for file-level/cross-document themes (over the file summary index); it may first use file_search to locate files then kb_search with the file param to search slices within those files (file→slice two-stage retrieval), entity_link then entity_slice to converge on slices linked to the located entity (ranked by question relevance), or graph_hop for relational/multi-hop expansion, community_search for global/theme overview, combined for complex ones. Evidence is merged across rounds before citing answers. Each tool depends on its ingestion primitives (offline indexing); the ingestion pipeline is auto-merged from enabled tools (read-only); max rounds is configurable in Params.'
})

// ===== 检索原语 ↔ 处理原语 依赖（自定义管线组合缺失提示） =====
// 检索原语 → 依赖的处理原语（结构化检索所需的本体/社区/文件摘要；dense_score 随增强权重变化单独处理）
const RETRIEVAL_INGEST_DEPS: Record<string, IngestionPrimitiveId[]> = {
  entity_link: ['extract_entities'],
  graph_hop: ['extract_entities'],
  community_select: ['extract_entities', 'build_communities'],
  file_score: ['summarize_file'],
  boost: [], // boost 依赖随 source 参数变化，见 BOOST_SOURCE_DEPS
}
// boost 的 source 参数 → 依赖的处理原语
const BOOST_SOURCE_DEPS: Record<string, IngestionPrimitiveId[]> = {
  entity: ['extract_entities'],
  hop: ['extract_entities'],
  community: ['extract_entities', 'build_communities'],
}
// dense_score 的有效增强权重：步骤参数优先，未设则取全局配置（默认 0.7）；=0 时增强通道不参与打分，无需 semantic_enhance
const effectiveSummaryWeight = (step: EditableStep): number => {
  const stepW = step.params?.summaryWeight
  if (stepW !== undefined && stepW !== null && stepW !== '') return Number(stepW)
  const global = props.model?.summaryWeight
  return global !== undefined && global !== null ? Number(global) : 0.7
}

// 策略是否含 dense_score 步骤（决定是否显示「语义增强通道」开关）
const hasDenseScore = computed(() => {
  const sel = selected.value
  return !!sel && sel.kind === 'pipeline' && sel.steps.some(s => s.primitive === 'dense_score')
})

// 语义增强通道当前是否开启：任一 dense_score 步骤的有效增强权重 > 0
const semanticChannelOn = computed(() => {
  const sel = selected.value
  if (!sel || sel.kind !== 'pipeline') return false
  return sel.steps.some(s => s.primitive === 'dense_score' && effectiveSummaryWeight(s) > 0)
})

// 可写通道状态：复选框 v-model 与此值双向绑定，勾选框与右侧状态徽标永远同步
const semanticChannel = computed<boolean>({
  get: () => semanticChannelOn.value,
  set: (v: boolean) => toggleSemanticChannel(v),
})

// 开关联动：开 → dense_score 增强权重设为 0.7（保留已设的非 0 权重）且处理管线补 semantic_enhance；
// 关 → 增强权重归 0 且移除处理管线的 semantic_enhance（退回纯切片向量打分）
const toggleSemanticChannel = (on: boolean) => {
  const sel = selected.value
  if (!sel || sel.kind !== 'pipeline') return
  for (const step of sel.steps) {
    if (step.primitive !== 'dense_score') continue
    if (on) {
      if (effectiveSummaryWeight(step) <= 0) step.params.summaryWeight = 0.7
    } else {
      step.params.summaryWeight = 0
    }
  }
  const idx = sel.ingestionSteps.findIndex(s => s.primitive === 'semantic_enhance')
  if (on) {
    if (idx === -1) sel.ingestionSteps.push({ primitive: 'semantic_enhance', params: {} })
  } else if (idx !== -1) {
    sel.ingestionSteps.splice(idx, 1)
  }
  touch()
}

// 检索管线已配置、但处理管线缺少依赖处理原语的提示（仅自定义管线组合可能出现）
const missingIngestDeps = computed(() => {
  const sel = selected.value
  if (!sel || sel.kind !== 'pipeline') return []
  const present = new Set(sel.ingestionSteps.map(s => s.primitive))
  const out: Array<{ retrieval: RetrievalPrimitiveId; missing: IngestionPrimitiveId[] }> = []
  for (const step of sel.steps) {
    let required: IngestionPrimitiveId[] = []
    if (step.primitive === 'boost') {
      required = BOOST_SOURCE_DEPS[String(step.params?.source || 'entity')] || []
    } else if (step.primitive === 'dense_score') {
      // 问题增强：由问题库经关联索引提供，不再依赖 semantic_enhance 摄取原语
      required = []
    } else {
      required = RETRIEVAL_INGEST_DEPS[step.primitive] || []
    }
    const missing = required.filter(p => !present.has(p))
    if (missing.length) out.push({ retrieval: step.primitive, missing })
  }
  return out
})

// 一键补齐缺失的处理原语（去重追加到处理管线末尾并保存）
const addMissingIngestDeps = () => {
  const sel = selected.value
  if (!sel) return
  const present = new Set(sel.ingestionSteps.map(s => s.primitive))
  const toAdd: IngestionPrimitiveId[] = []
  for (const w of missingIngestDeps.value) {
    for (const p of w.missing) {
      if (!present.has(p) && !toAdd.includes(p)) toAdd.push(p)
    }
  }
  for (const p of toAdd) sel.ingestionSteps.push({ primitive: p, params: {} })
  if (toAdd.length) touch()
}

// ===== 加载 / 保存（增量：仅保存改名或改动的内置策略 + 自定义策略） =====
function normalizeSteps(steps: any[]): any[] {
  return (steps || []).map(st => ({
    primitive: st.primitive,
    mode: st.mode || 'set',
    params: st.params || {},
  }))
}

function load() {
  let saved: EditableStrategy[] = []
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { saved = [] }
  setUserStrategies(saved)
  strategies.value = getStrategies().map(s => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    steps: (s.steps || []).map(st => ({
      primitive: st.primitive,
      mode: st.mode || 'set',
      params: st.params || {},
    })),
    ingestionSteps: (s.ingestionSteps || []).map(st => ({
      primitive: st.primitive,
      params: st.params || {},
    })),
    agentTools: ensureAgentTools((s as any).agentTools),
    maxRounds: s.kind === 'agentic' ? (s.maxRounds ?? 5) : undefined,
    channels: ensureChannels((s as any).channels),
    channelTopN: { ...((s as any).channelTopN || {}) },
    rerank: ensureRerank((s as any).rerank),
    builtin: !!s.builtin,
    enabled: (s as any).enabled !== false,
  }))
  if (!strategies.value.find(s => s.id === selectedId.value)) {
    selectedId.value = strategies.value[0]?.id || ''
  }
  const sel = selected.value
  activeTab.value = 'ingest'
}

function normalizeIngestSteps(steps: any[] | undefined): any[] {
  return (steps || []).map(st => ({
    primitive: st.primitive,
    params: st.params || {},
  }))
}

function saveDeltas() {
  const builtins = getBuiltinStrategies()
  const deltas: EditableStrategy[] = []
  for (const s of strategies.value) {
    const b = builtins.find(x => x.id === s.id)
    if (!b) {
      deltas.push(JSON.parse(JSON.stringify({ ...s, builtin: false })))
    } else {
      const modified =
        s.label !== b.label ||
        s.kind !== b.kind ||
        s.enabled === false ||
        JSON.stringify(s.agentTools || {}) !== JSON.stringify((b as any).agentTools || {}) ||
        (s.kind === 'agentic' && (s.maxRounds ?? 5) !== ((b as any).maxRounds ?? 5)) ||
        JSON.stringify(s.channels || {}) !== JSON.stringify((b as any).channels || {}) ||
        JSON.stringify(s.channelTopN || {}) !== JSON.stringify((b as any).channelTopN || {}) ||
        JSON.stringify(s.rerank || {}) !== JSON.stringify((b as any).rerank || {}) ||
        (s.kind !== 'agentic' && JSON.stringify(normalizeSteps(s.steps)) !== JSON.stringify(normalizeSteps(b.steps))) ||
        (s.kind !== 'agentic' && JSON.stringify(normalizeIngestSteps(s.ingestionSteps)) !== JSON.stringify(normalizeIngestSteps(b.ingestionSteps)))
      if (modified) deltas.push(JSON.parse(JSON.stringify(s)))
    }
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(deltas)) } catch { /* ignore */ }
  setUserStrategies(deltas)
  emit('change')
}

function touch() { saveDeltas() }

// ===== 策略操作 =====
function addStrategy() {
  const id = `custom_${Date.now()}`
  strategies.value.push({
    id,
    label: t('新策略', 'New Strategy'),
    kind: 'pipeline',
    steps: [{ primitive: 'dense_score', mode: 'set', params: {} }],
    ingestionSteps: [{ primitive: 'semantic_enhance', params: {} }],
    builtin: false,
    enabled: true,
  })
  selectedId.value = id
  activeTab.value = 'ingest'
  touch()
}

function deleteStrategy(id: string) {
  strategies.value = strategies.value.filter(s => s.id !== id)
  if (selectedId.value === id) selectedId.value = strategies.value[0]?.id || ''
  touch()
}

function resetStrategy(id: string) {
  const builtin = getBuiltinStrategies().find(b => b.id === id)
  const s = strategies.value.find(x => x.id === id)
  if (!builtin || !s) return
  s.label = builtin.label
  s.kind = builtin.kind
  s.steps = (builtin.steps || []).map(st => ({
    primitive: st.primitive,
    mode: st.mode || 'set',
    params: st.params || {},
  }))
  s.ingestionSteps = (builtin.ingestionSteps || []).map(st => ({
    primitive: st.primitive,
    params: st.params || {},
  }))
  s.agentTools = ensureAgentTools((builtin as any).agentTools)
  s.maxRounds = (builtin as any).maxRounds ?? 5
  s.channels = ensureChannels((builtin as any).channels)
  s.channelTopN = { ...((builtin as any).channelTopN || {}) }
  s.rerank = ensureRerank((builtin as any).rerank)
  s.enabled = true
  touch()
}

// 开关策略：停用后不参与测试与问答下拉（列表项右上角滑钮直接切换，与技能面板一致）
function toggleStrategyEnabled(s: EditableStrategy) {
  s.enabled = s.enabled === false ? true : false
  touch()
}

// 切换策略类型：初始化对应字段（支持把自定义/内置策略改成智能路由 / 社区全局等）
function onKindChange() {
  const s = selected.value
  if (!s) return
  if (s.kind === 'agentic') {
    s.agentTools = ensureAgentTools(s.agentTools)
    if (!s.maxRounds) s.maxRounds = 5
    s.steps = []
    s.ingestionSteps = []
  } else if (s.kind === 'hybrid') {
    s.channels = ensureChannels(s.channels)
    s.channelTopN = { ...((s as any).channelTopN || {}) }
    s.rerank = ensureRerank(s.rerank)
    s.steps = []
    s.ingestionSteps = []
  } else if (s.kind === 'mapreduce') {
    s.steps = []
    if (!s.ingestionSteps || s.ingestionSteps.length === 0) {
      s.ingestionSteps = [
        { primitive: 'extract_entities', params: {} },
        { primitive: 'build_communities', params: {} },
        { primitive: 'generate_reports', params: {} },
      ]
    }
  } else { // pipeline
    if (!s.steps || s.steps.length === 0) s.steps = [{ primitive: 'dense_score', mode: 'set', params: {} }]
    if (!s.ingestionSteps || s.ingestionSteps.length === 0) s.ingestionSteps = [{ primitive: 'semantic_enhance', params: {} }]
  }
  activeTab.value = 'ingest'
  touch()
}

// ===== 步骤操作 =====
function addStep() {
  if (!selected.value) return
  selected.value.steps.push({ primitive: 'dense_score', mode: 'set', params: { summaryWeight: 0.5 } })
  touch()
}

function removeStep(index: number) {
  if (!selected.value) return
  selected.value.steps.splice(index, 1)
  touch()
}

function moveStep(index: number, dir: number) {
  if (!selected.value) return
  const target = index + dir
  if (target < 0 || target >= selected.value.steps.length) return
  const [item] = selected.value.steps.splice(index, 1)
  selected.value.steps.splice(target, 0, item)
  touch()
}

function onPrimitiveChange(step: EditableStep) {
  if (step.primitive === 'boost') step.mode = 'multiply'
  else if (step.primitive === 'dense_score') {
    step.mode = 'set'
    step.params = { summaryWeight: 0.5 }
  } else {
    step.params = {}
  }
  touch()
}

// ===== 处理管线步骤操作 =====
function addIngestStep() {
  if (!selected.value) return
  selected.value.ingestionSteps.push({ primitive: 'semantic_enhance', params: {} })
  touch()
}

function removeIngestStep(index: number) {
  if (!selected.value) return
  selected.value.ingestionSteps.splice(index, 1)
  touch()
}

function moveIngestStep(index: number, dir: number) {
  if (!selected.value) return
  const target = index + dir
  if (target < 0 || target >= selected.value.ingestionSteps.length) return
  const [item] = selected.value.ingestionSteps.splice(index, 1)
  selected.value.ingestionSteps.splice(target, 0, item)
  touch()
}

function onIngestPrimitiveChange(step: EditableIngestStep) {
  step.params = {}
  touch()
}

onMounted(() => { load(); syncResetHeight() })
</script>

<style scoped>
/* ====== 样式参照 AgentPreset（contact-sidebar / ae-tabs / preset-tool-item / cfg-row） ====== */
.agent-preset {
  display: flex; height: 100%; flex: 1; overflow: hidden;
  background: var(--backgroundColor); color: var(--fontColor);
}
/* 左侧列表 */
.contact-sidebar {
  width: 150px; display: flex; flex-direction: column;
  border-right: 1px solid var(--borderColor);
}
.contact-sidebar-list { flex: 1; overflow-y: auto; padding: 2px; background-color: var(--backgroundColor); }
.contact-toolbar {
  display: flex; flex-direction: row; align-items: center; gap: 5px;
  flex-shrink: 0; padding: 5px; border-bottom: 1px solid var(--borderColor);
}
/* 搜索框尽量占满左侧，新建按钮固定小尺寸在右侧 */
.contact-toolbar .notes-search-box {
  flex: 1 1 auto; min-width: 0; height: 26px;
  display: flex; align-items: center; gap: 6px; padding: 0 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background-color: var(--backgroundColor); color: var(--borderColor); font-size: 12px;
}
.contact-toolbar .notes-search-box > i { flex-shrink: 0; font-size: 12px; }
.contact-toolbar .notes-search-input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--fontColor); font-size: 12px; margin: 0;
}
.contact-toolbar .notes-search-clear { flex-shrink: 0; cursor: pointer; font-size: 12px; color: var(--borderColor); }
.contact-toolbar .notes-search-clear:hover { color: var(--fontActiveColor); }
.sc-toolbar-add {
  flex-shrink: 0; width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  cursor: pointer; font-size: 12px; transition: all .12s;
}
.sc-toolbar-add:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.contact-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px; margin-bottom: 1px; border-radius: 3px;
  cursor: pointer; transition: all .12s; border: 1px solid transparent;
}
.contact-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.contact-item.active { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); border-color: var(--fontActiveColor); }
.contact-item.off { opacity: .55; }
.contact-item.off .contact-item-avatar i { color: var(--borderColor); }
.contact-tag-chip.sc-off-tag { color: var(--fontActiveColor); opacity: .85; }
.contact-item-avatar {
  width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); border-radius: 50%; flex-shrink: 0;
}
.contact-item-avatar i { font-size: 13px; color: var(--fontActiveColor); }
.contact-item-info { flex: 1; min-width: 0; }
.contact-item-name { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contact-item-tags { display: flex; align-items: center; gap: 2px; margin-top: 2px; overflow: hidden; }
.contact-tag-chip {
  flex-shrink: 0; max-width: 64px; font-size: 9px; line-height: 1;
  padding: 2px 4px; border-radius: 3px;
  color: var(--fontColor);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.contact-item-del {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border: none; background: none; color: var(--borderColor);
  cursor: pointer; font-size: 10px; border-radius: 2px; flex-shrink: 0; padding: 0;
  opacity: 0; transition: all .12s;
}
.contact-item:hover .contact-item-del { opacity: 1; }
.contact-item-del:hover { color: var(--fontColor); background: color-mix(in srgb, var(--fontColor) 12%, transparent); }

/* 右侧 */
.contact-content { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.ae-body { flex: 1; overflow-y: auto; padding: 5px; display: flex; flex-direction: column; min-height: 0; gap: 5px; }
.ae-tabs { display: flex; gap: 3px; flex-shrink: 0; }
.ae-tab-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ae-tab {
  flex: 1; padding: 8px; font-size: 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid transparent; border-radius: 4px;
  background: transparent; color: var(--fontColor); opacity: .75;
  cursor: pointer; transition: all .12s;
}
.ae-tab i { font-size: 10px; }
.ae-tab:hover { opacity: 1; color: var(--fontActiveColor); }
.ae-tab.on { opacity: 1; color: var(--fontActiveColor); font-weight: 600; border-color: var(--borderColor); background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); }
.ae-tab-body { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 0; }
.ae-tab-body > .cfg-box { flex: 1 1 auto; min-height: 0; }

/* 配置表单 */
.cfg-row { display: flex; align-items: center; gap: 5px; }
.cfg-row.column { flex-direction: column; align-items: stretch; }
.cfg-row label { font-size: 10px; color: var(--fontColor); min-width: 56px; flex-shrink: 0; padding: 0px; }
/* checkbox/radio 走全局自定义样式（appearance:none + :checked 填充 + ::after 对勾），
   需从文字输入规则中排除，否则选中填充色与对勾会被 background/border 覆盖而永远显示为未勾选 */
.cfg-row input:not([type="checkbox"]):not([type="radio"]), .cfg-row select {
  flex: 1; min-width: 0; padding: 2px 5px; border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; outline: none; margin: 0px;
}
.cfg-row input[type="range"] { padding: 0; border: none; }
.cfg-row input[type="checkbox"], .cfg-row input[type="radio"] {
  flex: none; width: 15px; height: 15px; padding: 0; margin: 2px 4px 0 0;
}
.cfg-box { gap: 5px; padding: 6px; border: 1px solid var(--borderColor); border-radius: 6px; overflow-y: auto; }
.cfg-box > label { min-width: 0; font-weight: 600; }
.cap-body { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 0; }
.skill-box-head { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.skill-box-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.skill-bulk-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; font-size: 10px;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--menuColor); color: var(--fontColor); cursor: pointer;
  transition: all .12s;
}
.skill-bulk-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.skill-bulk-btn i { font-size: 10px; }

/* 语义增强通道开关行 */
.sc-channel-row {
  padding: 4px 8px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: color-mix(in srgb, var(--fontActiveColor) 4%, transparent);
  flex-wrap: wrap;
}
.sc-channel-row > label { min-width: 0; }
.sc-channel-row .preset-checkbox { flex: 1 1 auto; min-width: 0; }
.sc-channel-state {
  flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 3px;
  background: var(--borderColor); color: var(--fontColor); opacity: .8;
}
.sc-channel-state.on { background: #2196F3; color: #fff; opacity: 1; }

/* 管线步骤：每行一个原语（纵向列表） */
.preset-tool-list {
  display: flex;
  flex-direction: column;
  gap: 4px; flex: 1 1 auto; min-height: 0;
  overflow-y: auto; overflow-x: auto; padding-right: 2px;
  border: 1px solid var(--borderColor); border-radius: 5px; padding: 5px;
}
.preset-tool-list::-webkit-scrollbar { width: 4px; height: 4px; }
.preset-tool-list::-webkit-scrollbar-thumb { background: var(--borderColor); border-radius: 2px; }
/* 步骤卡片：占满容器宽、强制单行（原语下拉伸缩填充，右侧按钮靠右，无空白） */
.sc-step-item {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 3px;
  flex-wrap: nowrap;
  flex-shrink: 1;
  min-width: 0;
}
/* 原语下拉伸缩以补齐右侧空白（用更高优先级选择器覆盖 .sc-inline-select 的 flex:0 0 auto） */
.sc-step-item .sc-primitive-select { flex: 1 1 auto; min-width: 0; width: auto; }
.preset-tool-item {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 4px 6px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); transition: all .12s; flex-shrink: 0;
}
.preset-tool-item:hover { border-color: var(--fontActiveColor); }
.preset-tool-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.preset-tool-desc { font-size: 10px; opacity: 0.75; line-height: 1.4; }
/* Agentic 工具开关：卡片 + 滑钮（样式与工具设置 AgentPreset 一致） */
.sc-tool-toggle-grid {
  display: flex; flex-wrap: wrap; gap: 5px;
}
.sc-agent-tool {
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.preset-tool-item.on { border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.preset-tool-icon {
  width: 22px; height: 22px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  border-radius: 4px; color: var(--fontColor); font-size: 11px;
}
.preset-tool-item.on .preset-tool-icon {
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
  color: var(--fontActiveColor);
}
.preset-tool-name { font-size: 11px; color: var(--fontColor); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-tool-item.on .preset-tool-name { color: var(--fontActiveColor); font-weight: 600; }
.preset-tool-toggle {
  width: 26px; height: 14px; border-radius: 7px; margin-left: auto; flex-shrink: 0;
  background: var(--borderColor); position: relative; transition: all .15s;
}
.preset-tool-toggle .preset-toggle-knob {
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.preset-tool-toggle.on { background: var(--fontActiveColor); }
.preset-tool-toggle.on .preset-toggle-knob { left: 14px; }
/* 左侧列表项的启用开关：与右侧技能面板滑钮同形（不随 hover 放大） */
.sc-list-toggle { flex-shrink: 0; margin-left: auto; }
.contact-item .sc-list-toggle { opacity: .9; }
.contact-item.off .sc-list-toggle { opacity: .45; }
.contact-item:hover .sc-list-toggle { opacity: 1; }
/* Agentic 工具 ↔ 依赖关系（grid 布局；依赖写在卡片 info 区，与工具设置一致） */
.sc-tool-dep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 5px;
}
.sc-agent-tool .preset-tool-info { gap: 2px; }
.sc-tool-deps { display: flex; flex-wrap: wrap; gap: 2px; }
.sc-dep-chip { max-width: none; }
.sc-inline-select, .sc-inline-input {
  flex: 0 0 auto; min-width: 0; padding: 1px 4px; border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 10px; outline: none; margin: 0;
}
.sc-mode-select { width: 100px; flex-shrink: 0; }
.sc-inline-input { width: 34px; flex-shrink: 0; }
.sc-param-text { width: 180px !important; flex-shrink: 0; }
.sc-step-row2 { display: flex; align-items: center; gap: 3px; flex-wrap: nowrap; }
.sc-step-params { display: inline-flex; align-items: center; gap: 3px; flex-wrap: nowrap; flex-shrink: 0; min-width: 0; }
.sc-param { display: inline-flex; align-items: center; gap: 1px; flex-shrink: 0; }
.sc-param-label { font-size: 8px; color: var(--fontColor); opacity: .8; flex-shrink: 0; white-space: nowrap; padding: 0; }
.sc-step-ops { display: flex; flex-direction: column; align-items: center; gap: 1px; flex-shrink: 0; }
.sc-op { font-size: 8px; color: var(--borderColor); cursor: pointer; padding: 1px; }
.sc-op:hover { color: var(--fontActiveColor); }
.sc-op.danger:hover { color: #f56c6c; }
.sc-op.disabled { opacity: .3; cursor: not-allowed; }
/* 添加检索原语：置于列表内部底部，样式贴近步骤卡片（虚线 + 弹性填充） */
.sc-add-step {
  width: 100%;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  border-style: dashed;
  color: var(--borderColor);
  background: transparent;
  transition: all .12s;
}
.sc-add-step:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 6%, transparent); }
.sc-add-step-icon { display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.sc-add-step-text { font-size: 11px; }
.sc-kind-text { font-size: 11px; opacity: .85; }
/* 名称/类型同行：类型标签窄化 + 下拉固定宽度；控件款式与下方管线内联控件一致（紧凑小号） */
.cfg-row .sc-kind-label { min-width: auto; margin-left: 8px; }
.cfg-row .sc-kind-select {
  flex: 0 0 auto; width: 112px;
  padding: 1px 4px; font-size: 10px; box-sizing: border-box;
}
/* 名称输入：同管线内联控件款式，但撑宽随行弹性伸缩（不固定窄宽度） */
.cfg-row input:not([type="checkbox"]):not([type="radio"]).sc-kind-name {
  flex: 1 1 auto; min-width: 0; width: auto;
  padding: 1px 4px; font-size: 10px; box-sizing: border-box;
}
/* 恢复默认：仅图标；实际高度运行时按同行“名称”输入框测量对齐（见 syncResetHeight），不压缩输入框 */
.sc-reset-btn {
  flex: 0 0 auto; width: 26px; height: 24px; padding: 0; margin-left: 2px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--menuColor); color: var(--fontColor); cursor: pointer;
  font-size: 11px; box-sizing: border-box; transition: all .12s;
}
.sc-reset-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
/* 开关策略：与重置按钮同尺寸，状态可点击切换 */
.sc-enable-btn {
  flex: 0 0 auto; width: 26px; height: 24px; padding: 0; margin-left: 2px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--menuColor); color: var(--fontActiveColor); cursor: pointer;
  font-size: 13px; transition: all .12s;
}
.sc-enable-btn:hover { border-color: var(--fontActiveColor); filter: brightness(1.08); }
.sc-enable-btn.off { color: var(--borderColor); }
.sc-enable-btn.off:hover { color: #f56c6c; border-color: #f56c6c; }
/* 检索管线依赖缺失提示 */
.sc-dep-badge {
  min-width: 14px; height: 14px; padding: 0 3px; margin-left: 2px; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; line-height: 1; color: #fff; background: #f56c6c; flex-shrink: 0;
}
.sc-dep-warn {
  display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;
  padding: 6px; border: 1px solid color-mix(in srgb, #f56c6c 50%, transparent); border-radius: 5px;
  background: color-mix(in srgb, #f56c6c 8%, transparent);
}
.sc-dep-warn-title { font-size: 11px; font-weight: 600; color: #f56c6c; display: flex; align-items: center; gap: 4px; }
.sc-dep-warn-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 10px; }
.sc-dep-warn-prim { color: var(--fontColor); }
.sc-dep-warn-arrow { color: var(--borderColor); font-size: 9px; }
.sc-dep-chip-missing { border: 1px solid color-mix(in srgb, #f56c6c 45%, transparent); background: color-mix(in srgb, #f56c6c 16%, transparent); color: #f56c6c; }
.sc-dep-add-all { align-self: flex-start; border-color: #f56c6c; color: #f56c6c; }
.sc-dep-add-all:hover { background: color-mix(in srgb, #f56c6c 12%, transparent); }
.preset-checkbox { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; cursor: pointer; }
.preset-checkbox input { flex: none; }
.sc-special-hint { font-size: 11px; line-height: 1.7; opacity: .85; margin: 0; }
.empty-hint {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; color: var(--borderColor); font-size: 12px; padding: 10px;
}
</style>
