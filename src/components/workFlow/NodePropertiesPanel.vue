<!-- src/components/workFlow/NodePropertiesPanel.vue -->
<template>
  <div v-if="node" class="right-panel workflow-props" :style="{ width: panelWidth + 'px' }">
    <div class="resize-handle" @mousedown.prevent="startResize"></div>
    <!-- 标签页切换 + 关闭按钮 -->
    <div class="panel-tabs">
      <button class="panel-tab" :class="{ active: panelTab === 'properties' }" @click="panelTab = 'properties'">
        <i class="fa fa-sliders"></i> {{ t('properties') }}
      </button>
      <button class="panel-tab" :class="{ active: panelTab === 'output' }" @click="panelTab = 'output'">
        <i class="fa fa-file-text-o"></i> {{ t('output') }}
      </button>
      <button class="panel-tabs-close" @click="$emit('close')" :title="t('close')">
        <i class="fa fa-times"></i>
      </button>
    </div>

    <div class="right-panel-content scoll">
      <!-- ===== 属性标签页 ===== -->
      <template v-if="panelTab === 'properties'">
        <!-- 通用属性 -->
        <div class="property-group">
          <div class="property-row">
            <label class="property-label">{{ t('node_name') }}</label>
            <div class="property-input">
              <input type="text" :value="node.name" @input="onNodeUpdate({ name: ($event.target as HTMLInputElement).value })" />
            </div>
          </div>
        </div>
        
        <!-- 按节点类型加载对应的属性组件 -->
        <NodePropertiesStart v-if="node.type === 'start'"
          :node="node" :t="t" :upstream="upstreamInfo"
          @update="onNodeUpdate" />
        
        <NodePropertiesEnd v-else-if="node.type === 'end'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesText v-else-if="node.type === 'text'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesLocal v-else-if="node.type === 'local'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesWebSearch v-else-if="node.type === 'web'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesWebpage v-else-if="node.type === 'webpage'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesReasoning v-else-if="node.type === 'reasoning'"
          :node="node" :t="t" :store="store" :upstream="upstreamInfo"
          @update="onNodeUpdate" />
        
        <NodePropertiesDecision v-else-if="node.type === 'decision'"
          :node="node" :t="t" :store="store" :links="links"
          @update="onNodeUpdate" @add-branch="onAddBranch" @delete-branch="onDeleteBranch" />
        
        <NodePropertiesPython v-else-if="node.type === 'python'"
          :node="node" :t="t" :upstream="upstreamInfo"
          @update="onNodeUpdate" />
        
        <NodePropertiesKnowledge v-else-if="node.type === 'knowledge'"
          :node="node" :t="t" :store="store" :upstream="upstreamInfo"
          @update="onNodeUpdate" @validate="onValidateKb" />
        
        <NodePropertiesStructured v-else-if="node.type === 'structured'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesSubflow v-else-if="node.type === 'subflow'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <McpNodeProperties v-else-if="node.type === 'mcp'"
          :node="node"
          @test-mcp-connection="(id: number) => $emit('test-mcp', id)"
          @connect-mcp-node="(id: number) => $emit('connect-mcp', id)"
          @disconnect-mcp-node="(id: number) => $emit('disconnect-mcp', id)"
          @refresh-mcp-tools="(id: number) => $emit('refresh-mcp', id)"
          @save="onSave" />
        
        <NodePropertiesIteration v-else-if="node.type === 'iteration'"
          :node="node" :t="t" :store="store"
          @update="onNodeUpdate" />
        
        <NodePropertiesAggregator v-else-if="node.type === 'aggregator'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesList v-else-if="node.type === 'list'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesData v-else-if="node.type === 'data'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesAgent v-else-if="node.type === 'agent'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <NodePropertiesWord v-else-if="node.type === 'word'"
          :node="node" :t="t"
          @update="onNodeUpdate" />
        
        <!-- 操作按钮 -->
        <div class="property-row">
          <button class="property-btn primary" @click="$emit('run-node')"
            :disabled="node.status === 'running' || running">
            <i class="fa fa-play"></i> 
            {{ node.status === 'running' ? t('running') : t('run') }}
          </button>
          <span class="status-badge" :class="node.status">
            <i class="fa" :class="getStatusIcon(node.status)"></i>
            {{ getStatusText(node.status) }}
          </span>
          <button class="property-btn danger" @click="$emit('delete-node')"
            :disabled="running" :title="t('delete')">
            <i class="fa fa-trash"></i>
          </button>
        </div>
      </template>

      <!-- ===== 输出标签页 ===== -->
      <template v-if="panelTab === 'output'">
        <div v-if="node.type === 'data' && dataPreview && dataPreview.rows.length" class="data-preview-wrap">
          <div class="data-preview-meta">
            <i class="fa fa-table"></i> {{ dataPreview.meta }}
          </div>
          <div class="data-preview-scroll scoll">
            <table class="data-preview-table">
              <thead>
                <tr>
                  <th v-for="h in dataPreview.headers" :key="'h-' + h">{{ h }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in dataPreview.rows" :key="'r-' + ri">
                  <td v-for="h in dataPreview.headers" :key="'c-' + ri + '-' + h" :title="String((row && row[h]) ?? '')">
                    {{ String((row && row[h]) ?? '') }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else-if="node.type === 'data' && dataPreview" class="output-empty-hint">
          <i class="fa fa-table"></i>
          <span>{{ dataPreview.meta }}</span>
        </div>
        <div v-else-if="node.type === 'iteration' && iterationPreview" class="data-preview-wrap">
          <div class="data-preview-meta">
            <i class="fa fa-repeat"></i> {{ iterationPreview.meta }}
          </div>
          <div class="iteration-preview-list scoll">
            <div v-for="it in iterationPreview.items" :key="it.index" class="iteration-preview-item" :title="it.text">
              <span class="iteration-preview-index">{{ it.index }}</span>
              <span class="iteration-preview-text">{{ it.text }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="node.result" style="flex:1;border-radius:5px;border:1px solid var(--borderColor);overflow:hidden;">
          <block_md :content="getResultContent(node.result)" />
        </div>
        <div v-else class="output-empty-hint">
          <i class="fa fa-file-text-o"></i>
          <span>{{ store?.locales === 'en' ? 'No output yet' : '暂无输出' }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import type { NodeData, NodeType, Link } from '@/components/workFlow/WorkflowTypes'
import { ensureMinNodeHeight } from '@/components/workFlow/WorkflowTypes'
import { getStatusIcon, getStatusColor } from '@/components/workFlow/WorkflowDefaults'
import block_md from '@/components/block_md.vue'
import NodePropertiesStart from '@/components/workFlow/nodes/start/Properties.vue'
import NodePropertiesEnd from '@/components/workFlow/nodes/end/Properties.vue'
import NodePropertiesText from '@/components/workFlow/nodes/text/Properties.vue'
import NodePropertiesLocal from '@/components/workFlow/nodes/local/Properties.vue'
import NodePropertiesWebSearch from '@/components/workFlow/nodes/web/Properties.vue'
import NodePropertiesWebpage from '@/components/workFlow/nodes/webpage/Properties.vue'
import NodePropertiesReasoning from '@/components/workFlow/nodes/reasoning/Properties.vue'
import NodePropertiesDecision from '@/components/workFlow/nodes/decision/Properties.vue'
import NodePropertiesPython from '@/components/workFlow/nodes/python/Properties.vue'
import NodePropertiesKnowledge from '@/components/workFlow/nodes/knowledge/Properties.vue'
import NodePropertiesStructured from '@/components/workFlow/nodes/structured/Properties.vue'
import McpNodeProperties from '@/components/workFlow/nodes/mcp/Properties.vue'
import NodePropertiesSubflow from '@/components/workFlow/nodes/subflow/Properties.vue'
import NodePropertiesIteration from '@/components/workFlow/nodes/iteration/Properties.vue'
import NodePropertiesAggregator from '@/components/workFlow/nodes/aggregator/Properties.vue'
import NodePropertiesList from '@/components/workFlow/nodes/list/Properties.vue'
import NodePropertiesData from '@/components/workFlow/nodes/data/Properties.vue'
import NodePropertiesAgent from '@/components/workFlow/nodes/agent/Properties.vue'
import NodePropertiesWord from '@/components/workFlow/nodes/word/Properties.vue'

const props = defineProps<{
  node: NodeData | null | undefined
  t: (key: string) => string
  store: any
  links: Link[]
  upstreamInfo: any[]
  running: boolean
}>()

const emit = defineEmits<{
  close: []
  'run-node': []
  'delete-node': []
  'node-update': [node: NodeData]
  'test-mcp': [id: number]
  'connect-mcp': [id: number]
  'disconnect-mcp': [id: number]
  'refresh-mcp': [id: number]
  'add-branch': []
  'delete-branch': [branchId: string]
  'validate-kb': [nodeId: number]
  save: []
}>()

const nodeTypeLabel = computed(() => {
  if (!props.node) return ''
  const labels: Record<NodeType, string> = {
    'start': props.t('start_node'), 'end': props.t('end_node'),
    'text': props.t('text_node'), 'local': props.t('local_node'),
    'web': props.t('web_node'), 'webpage': props.t('webpage_node'),
    'reasoning': props.t('reasoning_node'), 'decision': props.t('decision_node'),
    'python': props.t('python_node'), 'knowledge': props.t('knowledge_node'),
    'structured': props.t('structured_node'), 'mcp': props.t('mcp_node'),
    'subflow': props.t('subflow_node'),
    'iteration': props.t('iteration_node'), 'aggregator': props.t('aggregator_node'),
    'list': props.t('list_node'), 'data': props.t('data_node'),
    'agent': props.t('agent_node'),
    'word': props.t('word_node')
  }
  return labels[props.node.type] || props.node.type
})

/** 数据节点输出预览（表格化，单行截断，title 显示完整内容） */
const dataPreview = computed<{ headers: string[]; rows: any[]; meta: string } | null>(() => {
  const n = props.node
  if (!n || n.type !== 'data' || !n.result) return null
  try {
    const parsed = JSON.parse(n.result)
    if (!parsed || parsed.type !== 'data' || !parsed.success) return null
    const headers: string[] = Array.isArray(parsed.headers) ? parsed.headers : []
    const rows: any[] = Array.isArray(parsed.rows) ? parsed.rows : []
    if (headers.length === 0 || rows.length === 0) return null
    const total = parsed.tooLarge ? '?' : (parsed.total ?? 0)
    const loaded = rows.length < (parsed.total ?? 0) ? `（显示前 ${rows.length} 行）` : ''
    const meta = `共 ${total} 行${loaded}，${headers.length} 列${parsed.batchCount ? `，${parsed.batchCount} 批` : ''}${parsed.tooLarge ? '，文件过大仅统计' : ''}`
    return { headers, rows, meta }
  } catch { return null }
})

/** 迭代节点输出预览（运行期显示进度+最近 N 步结果；完成后显示前 100 项结果） */
const iterationPreview = computed<{ meta: string; items: Array<{ index: number; text: string }> } | null>(() => {
  const n = props.node
  if (!n || n.type !== 'iteration' || !n.result) return null
  try {
    const parsed = JSON.parse(n.result)
    if (!parsed || parsed.type !== 'iteration') return null
    if (parsed.streaming) {
      const recent = Array.isArray(parsed.recentResults) ? parsed.recentResults : []
      return {
        meta: `${props.t('iterating')} ${parsed.progress ?? 0}/${parsed.total ?? 0}${recent.length ? `（显示最近 ${recent.length} 项）` : ''}`,
        items: recent.map((r: any) => ({ index: Number(r?.index) || 0, text: String(r?.text ?? '') })),
      }
    }
    const outputs = Array.isArray(parsed.output) ? parsed.output : []
    const shown = outputs.slice(0, 100)
    const meta = `共 ${parsed.count ?? 0} 项，成功 ${parsed.succeeded ?? 0}${parsed.failed ? `，失败 ${parsed.failed}` : ''}${outputs.length > shown.length ? `，显示前 ${shown.length} 项` : ''}`
    return {
      meta,
      items: shown.map((o: any, i: number) => {
        // row 模式每项是对象：只显示 result 字段（结果），避免整行 JSON
        let text = typeof o === 'string' ? o : JSON.stringify(o)
        if (o && typeof o === 'object' && 'result' in o) text = String(o.result ?? '')
        return { index: i + 1, text }
      }),
    }
  } catch { return null }
})

const getStatusText = (status: string): string => {
  const texts: Record<string, string> = {
    'idle': props.t('status_idle'), 'running': props.t('status_running'),
    'success': props.t('status_success'), 'error': props.t('status_error')
  }
  return texts[status] || status
}

const onNodeUpdate = (updated: Partial<NodeData>) => {
  if (!props.node) return
  Object.assign(props.node, updated)
  ensureMinNodeHeight(props.node, true)  // shrink=true：增删端口后同步调整高度
  emit('node-update', props.node)
}

const onAddBranch = () => emit('add-branch')
const onDeleteBranch = (branchId: string) => emit('delete-branch', branchId)
const onValidateKb = (nodeId: number) => emit('validate-kb', nodeId)
const onSave = () => emit('save')

/* ---- 标签页切换 ---- */
const panelTab = ref<'properties' | 'output'>('properties')

/* ---- 拖拽调整面板宽度 ---- */
const panelWidth = ref(320)
let resizeStartX = 0
let resizeStartWidth = 0

const startResize = (e: MouseEvent) => {
  resizeStartX = e.clientX
  resizeStartWidth = panelWidth.value
  document.addEventListener('mousemove', doResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

const doResize = (e: MouseEvent) => {
  const delta = resizeStartX - e.clientX  // 向左拖 => 宽度增加
  const newWidth = resizeStartWidth + delta
  panelWidth.value = Math.max(200, Math.min(800, newWidth))
}

const stopResize = () => {
  document.removeEventListener('mousemove', doResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onBeforeUnmount(() => {
  stopResize()
})

const getResultContent = (result: string): string => {
  if (!result) return ''
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object') {
      // Handle various node result types
      if (parsed.type === 'local') {
        if (parsed.success) {
          let content = `# ${props.t('local_node')}\n\n**${props.t('file_path')}**: ${parsed.filePath}\n**处理模式**: ${parsed.mode === 'full' ? props.t('full_file_mode') : props.t('template_mode')}\n`
          if (parsed.mode === 'full') {
            const maxLen = 10000
            content += `\n## ${props.t('file_content')}:\n\n`
            content += parsed.content && parsed.content.length > maxLen
              ? parsed.content.substring(0, maxLen) + `\n\n... (还有 ${parsed.content.length - maxLen} 个字符)`
              : (parsed.content || '')
          } else {
            content += `\n## 模板切片:\n\n`
            const slices = parsed.slices || {}
            Object.entries(slices).forEach(([key, val]: [string, any]) => {
              content += `**${key}**: ${val ? val.substring(0, 200) : '(空)'}\n\n`
            })
          }
          return content
        }
        return `**${props.t('read_error')}**: ${parsed.error || parsed.result}`
      }
      if (parsed.type === 'knowledge_retrieval' && parsed.success) {
        let c = `# ${props.t('retrieval_result')}\n\n**查询**: ${parsed.query}\n\n**检索到的片段数**: ${parsed.relevantBlocks?.length || 0}\n\n`
        if (parsed.relevantBlocks?.length) {
          c += '## 相关片段:\n\n'
          parsed.relevantBlocks.forEach((b: any, i: number) => {
            c += `### 片段 ${i+1}\n${b.content}\n\n`
          })
        }
        return c
      }
      if (parsed.type === 'structured' && parsed.success) {
        let c = `# ${props.t('structured_input')}\n\n**输出格式**: ${parsed.format}\n**行数**: ${parsed.rowCount}\n**列数**: ${parsed.columnCount}\n\n`
        if (parsed.format === 'json') c += '```json\n' + parsed.result + '\n```'
        else c += '```\n' + parsed.result + '\n```'
        return c
      }
      if (parsed.type === 'decision' && parsed.success) {
        let c = `# ${props.t('decision_node')}\n\n**决策模式**: ${parsed.mode === 'llm' ? props.t('llm_decision') : props.t('rule_decision')}\n`
        c += `**${props.t('selected_branch')}**: ${parsed.selectedBranchName || parsed.selectedBranch}\n`
        c += `**决策理由**: ${parsed.reason || props.t('none')}\n`
        return c
      }
      if (parsed.type === 'mcp') {
        if (parsed.success) {
          let c = `# ${props.t('mcp_node')}\n\n**工具**: ${parsed.tool || props.t('none')}\n`
          c += `**${props.t('status')}**: ${props.t('mcp_connected')}\n\n`
          if (parsed.result) c += `## 执行结果:\n\n${typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, null, 2)}`
          return c
        }
        return `**${props.t('mcp_connection_error')}**: ${parsed.error || parsed.result}`
      }
      if (parsed.type === 'start' && parsed.success) {
        let c = `# ${props.t('start')}\n\n**提示词**: ${parsed.prompt}\n`
        if (parsed.filePath) c += `**${props.t('file_path')}**: ${parsed.filePath}\n`
        c += `\n## 输入内容:\n\n${parsed.result}`
        return c
      }
      if (parsed.type === 'data') {
        if (!parsed.success) {
          return `**${props.t('data_read_error')}**: ${parsed.error || parsed.result}`
        }
        const headers: string[] = Array.isArray(parsed.headers) ? parsed.headers : []
        const rows: any[] = Array.isArray(parsed.rows) ? parsed.rows : []
        const esc = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
        let c = `# ${props.t('data_node')}\n\n**${props.t('file_path')}**: ${parsed.filePath}\n`
        const totalTxt = parsed.tooLarge ? '?' : (parsed.total ?? 0)
        c += `**共 ${totalTxt} 行**`
        if (parsed.preview) c += `（预览 ${rows.length} 行）`
        else if (rows.length !== (parsed.total ?? 0)) c += `（加载 ${rows.length} 行）`
        if (parsed.batches?.length) c += `，${parsed.batches.length} 批`
        c += '\n\n'
        if (rows.length > 0) {
          if (headers.length > 0) {
            c += '| ' + headers.map(esc).join(' | ') + ' |\n'
            c += '| ' + headers.map(() => '---').join(' | ') + ' |\n'
            rows.forEach(r => {
              c += '| ' + headers.map(h => esc((r && r[h]) ?? '')).join(' | ') + ' |\n'
            })
          } else {
            c += '```json\n' + JSON.stringify(rows.slice(0, 50), null, 2) + '\n```'
          }
        } else if (parsed.tooLarge) {
          c += '（文件过大，仅统计）'
        } else {
          c += '（无数据行）'
        }
        return c
      }
      if (parsed.type === 'iteration') {
        if (parsed.streaming) {
          const recent = Array.isArray(parsed.recentResults) ? parsed.recentResults : []
          let c = `# 迭代进行中\n\n${parsed.progress ?? 0}/${parsed.total ?? 0}\n\n`
          recent.forEach((r: any) => {
            c += `### 第 ${r?.index ?? 0} 项\n${r?.text ?? ''}\n`
          })
          return c
        }
        let c = `# 迭代完成\n\n**共 ${parsed.count ?? 0} 项**，成功 ${parsed.succeeded ?? 0}${parsed.failed ? `，失败 ${parsed.failed}` : ''}\n\n`
        const outputs = Array.isArray(parsed.output) ? parsed.output : []
        c += outputs.slice(0, 100).map((o: any, i: number) => `### 第 ${i + 1} 项\n\n${typeof o === 'string' ? o : JSON.stringify(o, null, 2)}\n`).join('\n')
        if (outputs.length > 100) c += `\n...（共 ${outputs.length} 项，仅显示前 100 项）`
        return c
      }
      if (parsed.result !== undefined) {
        return typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, null, 2)
      }
      return JSON.stringify(parsed, null, 2)
    }
  } catch {}
  return result
}

</script>

<style scoped>
.right-panel {
  border-left: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background-color: var(--backgroundColor);
  position: relative;
  top:0px;
  height:calc(100%)
}

/* 拖拽调整宽度的手柄 */
.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 10;
  transition: background-color 0.15s;
}
.resize-handle:hover,
.resize-handle:active {
  background-color: var(--fontActiveColor);
  opacity: 0.4;
}
/* 属性/输出标签页切换 */
.panel-tabs {
  display: flex;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
  align-items: stretch;
}
.panel-tab {
  flex: 1;
  padding: 6px 4px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  text-align: center;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  opacity: 0.6;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.panel-tab:hover { opacity: 1; background: var(--backgroundColor); }
.panel-tab.active {
  opacity: 1;
  border-bottom-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}
.panel-tabs-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 14px;
  padding: 6px 8px;
  display: flex;
  align-items: center;
  opacity: 0.6;
  transition: all 0.15s;
}
.panel-tabs-close:hover {
  opacity: 1;
  background: var(--backgroundColor);
  color: #f44336;
}
.right-panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 5px;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  container-name: wfprops;
}
.property-group { margin-bottom: 5px; border-bottom: 1px solid var(--borderColor); }
.property-row {
  display: flex;
  flex-direction: row;
  gap: 5px;
}
.property-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--fontColor);
  opacity: 0.9;
  /* 不使用固定 width，与下方专用属性组统一由非 scoped 的 min-width:62px 控制，
     避免通用组标签 70px / 专用组标签 62px 导致输入框宽度不一致 */
  line-height: 30px;
}
.property-input { flex:1; text-align: center; line-height: 30px; }
.property-input input:not([type="checkbox"]):not([type="radio"]) { margin: 5px 0px; width: calc(100% - 6px); }
.property-input select { margin: 5px 0px; background-color: var(--backgroundColor); }
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 11px;
  color: white;
}
.status-badge.idle { background-color: #757575; }
.status-badge.running { background-color: #2196F3; }
.status-badge.success { background-color: #4CAF50; }
.status-badge.error { background-color: #f44336; }
.property-btn {
  flex: 1;
  padding: 5px 10px;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  height: 30px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.property-btn.primary { background-color: var(--fontActiveColor); color: var(--backgroundColor); }
.property-btn.primary:hover:not(:disabled) { opacity: 0.9; }
.property-btn.primary:disabled { opacity: 0.6; cursor: not-allowed; }
.property-btn.danger { background-color: #f44336; color: white; flex: 0; padding: 10px 12px; }
.property-btn.danger:hover { background-color: #d32f2f; }
.output-empty-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--fontColor);
  opacity: 0.4;
  font-size: 14px;
  min-height: 100px;
}
.output-empty-hint i { font-size: 28px; }

/* 数据节点输出预览表格（单行、截断、title 完整） */
.data-preview-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  overflow: hidden;
}
.data-preview-meta {
  flex-shrink: 0;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.85;
  border-bottom: 1px solid var(--borderColor);
  background-color: rgba(0,0,0,0.03);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.data-preview-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.data-preview-table {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
  font-size: 11px;
}
.data-preview-table th,
.data-preview-table td {
  max-width: 160px;
  min-width: 40px;
  border: 1px solid var(--borderColor);
  padding: 3px 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.data-preview-table th {
  position: sticky;
  top: 0;
  background-color: var(--backgroundColor);
  z-index: 1;
  font-weight: 600;
}
.data-preview-table td { cursor: default; }

/* 迭代节点输出预览列表 */
.iteration-preview-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.iteration-preview-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid rgba(0,0,0,0.05);
  font-size: 11px;
}
.iteration-preview-item:hover { background-color: rgba(0,0,0,0.03); }
.iteration-preview-index {
  flex-shrink: 0;
  color: var(--fontActiveColor);
  font-weight: 600;
  min-width: 26px;
  text-align: right;
}
.iteration-preview-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

<style>
/* ===== 工作流属性面板统一样式（作用域限定在 .workflow-props 内） ===== */
.workflow-props .property-group { margin-bottom: 6px; padding: 2px 0; }
.workflow-props .property-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  margin-bottom: 2px;
}
.workflow-props .property-label {
  flex-shrink: 0;
  min-width: 62px;
  line-height: 24px;
  white-space: nowrap;
  text-align: left;
  font-size: 12px;
  font-weight: 500;
  color: var(--fontColor);
  opacity: 0.9;
}
.workflow-props .property-input {
  flex: 1;
  min-width: 0 !important;
  line-height: normal;
  text-align: left;
}

/* 统一输入控件（!important 覆盖各处内联/局部样式，保证宽度一致不溢出）
   注：排除 checkbox/radio，否则它们会被拉伸成满宽的一条线（看不见勾选框） */
.workflow-props .property-input input:not([type="checkbox"]):not([type="radio"]),
.workflow-props .property-input select,
.workflow-props .property-input textarea {
  box-sizing: border-box !important;
  width: calc(100% - 5px) !important;
  max-width: 100% !important;
  min-width: 0 !important;
  min-height: 26px;
  padding: 3px 6px;
  font-size: 12px;
  font-family: inherit;
  color: var(--fontColor);
  background-color: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  outline: none;
  transition: border-color 0.15s;
  margin: 0px
}
.workflow-props .property-input input:focus,
.workflow-props .property-input select:focus,
.workflow-props .property-input textarea:focus {
  border-color: var(--fontActiveColor);
}
.workflow-props .property-input textarea { resize: vertical; }

/* 勾选框/单选框：只复位尺寸与布局，外观仍由全局皮肤（appearance:none + border/background + ::after 对勾）绘制。
   ⚠️ 切勿在此覆盖 border/background —— 会把勾选框变成透明方块，浅色主题下"既看不到框也看不到勾" */
.workflow-props .property-input input[type="checkbox"],
.workflow-props .property-input input[type="radio"] {
  flex: 0 0 auto !important;
  width: 15px !important;
  max-width: 15px !important;
  min-width: 15px !important;
  height: 15px !important;
  max-height: 15px !important;
  min-height: 15px !important;
  margin: 0 !important;
  padding: 0 !important;
  cursor: pointer;
}

/* 统一按钮 */
.workflow-props .wf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 4px 10px;
  min-height: 24px;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.workflow-props .wf-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.workflow-props .wf-btn.primary {
  background-color: var(--fontActiveColor);
  color: var(--backgroundColor);
  border-color: var(--fontActiveColor);
}
.workflow-props .wf-btn.primary:hover { opacity: 0.9; color: var(--backgroundColor); }
.workflow-props .wf-btn.danger { border-color: #f44336; color: #f44336; }
.workflow-props .wf-btn.danger:hover { background-color: #f44336; color: #fff; }
.workflow-props .wf-btn.small { font-size: 11px; padding: 2px 7px; min-height: 22px; }
.workflow-props .wf-btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* 响应式：面板较窄时标签与输入控件上下两行 */
@container wfprops (max-width: 300px) {
  .workflow-props .property-row {
    flex-direction: column;
    align-items: stretch;
  }
  .workflow-props .property-label { min-width: 0; }
}
</style>
