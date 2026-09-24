<!-- EntryView.vue - 数据录入视图（基础参数 + 表单数据，均来自画布节点） -->
<template>
  <div class="dc-entry-view">
    <!-- 所有参数/数据表节点标签页（不区分类型，直接并列） -->
    <!-- 左侧：节点标签垂直侧边栏（可拖拽排序，顺序随数据包持久化） -->
    <div class="dc-entry-rail" v-if="entryNodes.length">
      <div class="dc-entry-rail-tabs">
        <button
          v-for="n in orderedEntryNodes"
          :key="n.id"
          class="dc-tab"
          :class="{ active: currentTab === n.id, dragging: draggingTabId === n.id }"
          draggable="true"
          :title="tabTitle(n)"
          @click="onTabClick(n.id)"
          @dragstart="onTabDragStart(n.id, $event)"
          @dragover.prevent
          @drop="onTabDrop(n.id, $event)"
          @dragend="onTabDragEnd"
        >
          <i class="fa" :class="nodeIcon(n)"></i>
          <span class="dc-tab-name">{{ n.name }}</span>
        </button>
      </div>
      <div class="dc-entry-rail-footer">
        <button class="dc-btn dc-btn-sm dc-btn-primary" @click="openSmartEntryModal" :disabled="!currentNode">
          <i class="fa fa-magic"></i> {{ t('智能录入') }}
        </button>
      </div>
    </div>

    <div class="dc-entry-body">
      <!-- 参数节点：键只读 + 值可编辑（无表头/删除/添加按钮） -->
      <template v-if="currentNode && currentNode.type === 'parameter'">
        <!-- 参数组使用说明（置于最上方，只读显示，来自画布参数节点配置） -->
        <div v-if="currentNode.data.description" class="dc-param-desc">
          <i class="fa fa-info-circle"></i>
          <span class="dc-param-desc-text">{{ currentNode.data.description }}</span>
        </div>
        <div v-for="(p, i) in currentNode.data.params" :key="i" class="dc-param-row">
          <span class="dc-param-key">{{ paramLabel(p, i) }}</span>
          <input v-model="p.value" class="dc-input dc-param-value" :placeholder="t('值')" @change="commitNode(currentNode)" />
          <span v-if="p.unit" class="dc-param-unit" :title="t('参数单位')">{{ p.unit }}</span>
        </div>
        <div v-if="!currentNode.data.params?.length" class="dc-empty">{{ t('该节点暂无参数') }}</div>
      </template>

      <!-- 数据表节点：表单录入模式（侧边栏+表单） 或 默认表格录入 -->
      <template v-else-if="currentNode && currentNode.type === 'table'">
        <!-- 表格使用说明（只读显示，来自画布数据表节点配置） -->
        <div v-if="currentNode.data.description" class="dc-param-desc">
          <i class="fa fa-info-circle"></i>
          <span class="dc-param-desc-text">{{ currentNode.data.description }}</span>
        </div>
        <!-- ====== 表单录入模式 ====== -->
        <template v-if="currentNode.data.formEntry">
          <div class="dc-form-entry">
            <!-- 左侧：数据侧边栏（显示数据标题） -->
            <div class="dc-form-sidebar">
              <div class="dc-form-sidebar-head">
                <button class="dc-btn dc-btn-sm" @click="triggerTableImport(currentNode)"><i class="fa fa-file-excel-o"></i> {{ t('导入 Excel') }}</button>
                <button class="dc-btn dc-btn-sm" @click="exportTableToExcel(currentNode)"><i class="fa fa-file-excel-o"></i> {{ t('导出 Excel') }}</button>
                <button class="dc-btn dc-btn-sm dc-btn-primary" @click="startNewFormRecord"><i class="fa fa-plus"></i> {{ t('新增记录') }}</button>
              </div>
              <div class="dc-form-sidebar-list">
                <div
                  v-if="formIsNew"
                  class="dc-form-sidebar-item active"
                  :title="t('新记录（尚未保存）')"
                  @click="selectFormNew"
                >
                  <i class="fa fa-file-o"></i> {{ t('新记录') }}
                </div>
                <div
                  v-for="(row, ri) in currentNode.data.rows"
                  :key="ri"
                  class="dc-form-sidebar-item"
                  :class="{ active: !formIsNew && currentFormIndex === ri }"
                  :title="formRowTitle(row, ri)"
                  @click="selectFormRow(ri)"
                >
                  <i class="fa fa-file-text-o"></i> {{ formRowTitle(row, ri) }}
                </div>
                <div v-if="!currentNode.data.rows?.length && !formIsNew" class="dc-form-sidebar-empty">{{ t('暂无记录') }}</div>
              </div>
            </div>
            <!-- 右侧：按字段录入方式渲染的表单 -->
            <div class="dc-form-main">
              <div class="dc-form-actions">
                <button class="dc-btn dc-btn-primary" @click="saveFormRecord" :disabled="!currentNode.data.columns?.length">
                  <i class="fa fa-check"></i> {{ t('保存') }}
                </button>
                <button class="dc-btn" @click="clearFormDraft"><i class="fa fa-eraser"></i> {{ t('清空') }}</button>
                <button class="dc-btn dc-danger" @click="deleteFormRecord" :disabled="formIsNew || currentFormIndex < 0">
                  <i class="fa fa-trash-o"></i> {{ t('删除') }}
                </button>
              </div>
              <div v-for="c in currentNode.data.columns" :key="c" class="dc-form-field">
                <label class="dc-form-label" :title="c">{{ c }}</label>
                <div class="dc-form-control">
                  <input
                    v-if="columnInputType(c) === 'text'"
                    class="dc-input"
                    :value="formDraft[c] ?? ''"
                    @input="onFormDraftInput(c, $event)"
                    :placeholder="t('请输入')"
                  />
                  <textarea
                    v-else-if="columnInputType(c) === 'textarea'"
                    class="dc-input dc-form-textarea"
                    :value="formDraft[c] ?? ''"
                    @input="onFormDraftInput(c, $event)"
                    rows="3"
                    :placeholder="t('请输入')"
                  ></textarea>
                  <input
                    v-else-if="columnInputType(c) === 'number'"
                    type="number"
                    class="dc-input"
                    :value="formDraft[c] ?? ''"
                    @input="onFormDraftInput(c, $event)"
                  />
                  <input
                    v-else-if="columnInputType(c) === 'date'"
                    type="date"
                    class="dc-input"
                    :value="formDraft[c] ?? ''"
                    @input="onFormDraftInput(c, $event)"
                  />
                  <label v-else-if="columnInputType(c) === 'boolean'" class="dc-form-bool">
                    <input type="checkbox" :checked="!!formDraft[c]" @change="onFormDraftBool(c, $event)" />
                    <span>{{ t('是 / 否') }}</span>
                  </label>
                  <select
                    v-else-if="columnInputType(c) === 'select'"
                    class="dc-input"
                    :value="formDraft[c] ?? ''"
                    @change="onFormDraftInput(c, $event)"
                  >
                    <option value="">{{ t('（请选择）') }}</option>
                    <option v-for="op in columnInputOptions(c)" :key="op" :value="op">{{ op }}</option>
                  </select>
                  <input
                    v-else
                    class="dc-input"
                    :value="formDraft[c] ?? ''"
                    @input="onFormDraftInput(c, $event)"
                    :placeholder="t('请输入')"
                  />
                </div>
              </div>
              <div v-if="!currentNode.data.columns?.length" class="dc-empty">{{ t('该表暂无列，请先在画布「列定义」中配置') }}</div>
            </div>
          </div>
        </template>

        <!-- ====== 默认表格录入模式 ====== -->
        <template v-else>
        <div class="dc-entry-rowbtns">
          <button class="dc-btn" @click="addTableRow(currentNode)"><i class="fa fa-plus"></i> {{ t('添加行') }}</button>
          <button class="dc-btn" @click="triggerTableImport(currentNode)"><i class="fa fa-file-excel-o"></i> {{ t('导入 Excel') }}</button>
          <button class="dc-btn" @click="copyTableToClipboard(currentNode)"><i class="fa fa-copy"></i> {{ t('复制到剪贴板') }}</button>
          <button class="dc-btn" @click="pasteTableFromClipboard(currentNode)"><i class="fa fa-clipboard"></i> {{ t('从剪贴板粘贴') }}</button>
          <button class="dc-btn" @click="exportTableToExcel(currentNode)"><i class="fa fa-file-excel-o"></i> {{ t('导出 Excel') }}</button>
        </div>
        <div class="dc-table-edit" v-if="currentNode.data.columns?.length && currentNode.data.rows?.length">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th v-for="c in currentNode.data.columns" :key="c">{{ c }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, ri) in currentNode.data.rows" :key="ri">
                <td>{{ Number(ri) + 1 }}</td>
                <td v-for="c in currentNode.data.columns" :key="c">
                  <input class="dc-input dc-cell" :value="row[c]" @input="onNodeCellInput(currentNode, row, String(c), $event)" />
                </td>
                <td><button class="dc-btn dc-btn-sm dc-danger" @click="removeTableRow(currentNode, Number(ri))"><i class="fa fa-times"></i></button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="currentNode.data.columns?.length" class="dc-empty">{{ t('暂无数据行') }}</div>
        <div v-else class="dc-empty">{{ t('该表暂无列，可点击「导入 Excel」') }}</div>
        </template>
      </template>

      <div v-else class="dc-empty">{{ t('画布中暂无参数/数据表节点，请先在画布中添加') }}</div>
    </div>

    <!-- Excel 导入 input（默认表格与表单录入模式共用，始终渲染） -->
    <input type="file" ref="tableFileInput" accept=".xlsx,.xls" style="display:none" @change="handleTableImport" />

    <div v-if="smartEntryModalVisible" class="dc-smart-entry-overlay" @click.self="closeSmartEntryModal">
      <div class="dc-smart-entry-modal">
        <div class="dc-smart-entry-header">
          <strong>{{ t('智能录入') }}</strong>
          <button class="dc-btn dc-btn-sm" @click="closeSmartEntryModal"><i class="fa fa-times"></i></button>
        </div>
        <div class="dc-smart-entry-body">
          <label class="dc-smart-entry-label">{{ t('请输入要分析的文本') }}</label>
          <textarea v-model="smartEntryInput" class="dc-textarea" rows="8" :placeholder="t('例如：姓名：张三，年龄：18，城市：北京；姓名：李四，年龄：25，城市：上海')"></textarea>
          <div v-if="smartEntryError" class="dc-smart-entry-error">{{ smartEntryError }}</div>
          <div v-if="smartEntryLoading" class="dc-smart-entry-loading"><i class="fa fa-spinner fa-spin"></i> {{ t('正在分析...') }}</div>
          <div v-else-if="smartEntryPreview" class="dc-smart-entry-preview">
            <div class="dc-smart-entry-preview-title">{{ t('录入预览') }}</div>
            <div v-if="currentNode?.type === 'parameter'" class="dc-smart-entry-preview-table-wrap">
              <table class="dc-smart-entry-preview-table">
                <thead>
                  <tr>
                    <th>{{ t('字段') }}</th>
                    <th>{{ t('值') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(item, index) in smartEntryPreview.params || []" :key="`${item.key || 'field'}-${index}`">
                    <td>{{ item.key }}</td>
                    <td>{{ item.value }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else-if="currentNode?.type === 'table'" class="dc-smart-entry-preview-table-wrap">
              <table class="dc-smart-entry-preview-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th v-for="(column, index) in smartEntryPreview.columns || []" :key="`${column}-${index}`">{{ column }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in smartEntryPreview.rows || []" :key="`row-${rowIndex}`">
                    <td>{{ Number(rowIndex) + 1 }}</td>
                    <td v-for="(column, columnIndex) in smartEntryPreview.columns || []" :key="`${column}-${columnIndex}`">{{ row?.[column] ?? '' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="dc-smart-entry-preview-json">{{ JSON.stringify(smartEntryPreview, null, 2) }}</div>
          </div>
        </div>
        <div class="dc-smart-entry-actions">
          <button class="dc-btn" @click="closeSmartEntryModal">{{ t('取消') }}</button>
          <button v-if="!smartEntryPreview" class="dc-btn dc-btn-primary" @click="runSmartEntry" :disabled="smartEntryLoading || !smartEntryInput.trim()">
            {{ t('开始分析') }}
          </button>
          <button v-else class="dc-btn dc-btn-primary" @click="applySmartEntryPreview">{{ t('确认录入') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import * as XLSX from 'xlsx'
import { useDataCanvas } from '@/components/DataCanvas/store'
import { parseExcelFile } from '@/components/DataCanvas/excel'
import { AIUtils } from '@/services/ai-utils'
import { usestore } from '@/store'
import { deepSeekConfig } from '@/shared/llmSources'

const store = useDataCanvas()
const hostStore = usestore()
const activeModel = computed(() => store.activeModel.value)

// ==================== 按节点划分的标签页（参数节点 + 数据表节点并列） ====================
const currentTab = ref<string>('')

const entryNodes = computed(() => {
  const m = activeModel.value
  if (!m) return []
  return m.nodes.filter((n) => n.type === 'parameter' || n.type === 'table')
})
const currentNode = computed(() => entryNodes.value.find((n) => n.id === currentTab.value) ?? null)

// ==================== 标签页顺序（可拖拽调整，持久化到模型 meta） ====================
const tabOrder = ref<string[]>([])
const draggingTabId = ref<string | null>(null)
let lastDragEndTime = 0

// 已排序的标签页列表
const orderedEntryNodes = computed(() => {
  const byId = new Map(entryNodes.value.map((n) => [n.id, n]))
  const ordered: any[] = []
  tabOrder.value.forEach((id) => { const n = byId.get(id); if (n) ordered.push(n) })
  entryNodes.value.forEach((n) => { if (!ordered.some((x) => x.id === n.id)) ordered.push(n) })
  return ordered
})

// 节点变化时同步标签顺序（优先使用模型已保存顺序，其次保留当前顺序）；
// 同时自动选中「自定义拖动排序后排在第一」的标签页（而非画布原始顺序的第一个）
watch(entryNodes, (nodes) => {
  const ids = nodes.map((n) => n.id)
  const saved = (activeModel.value?.meta?.entryTabOrder || [])
  let order = saved.length ? [...saved] : [...tabOrder.value]
  order = order.filter((id) => ids.includes(id))
  ids.forEach((id) => { if (!order.includes(id)) order.push(id) })
  tabOrder.value = order
  if (!nodes.length) {
    currentTab.value = ''
  } else if (!nodes.some((n) => n.id === currentTab.value)) {
    currentTab.value = order[0] ?? nodes[0].id
  }
}, { immediate: true })

function persistTabOrder() {
  const m = activeModel.value
  if (!m) return
  if (!m.meta) m.meta = { params: [], formFields: [], formRecords: [] }
  m.meta.entryTabOrder = [...tabOrder.value]
  store.updateModel(m.id, { meta: { ...m.meta } })
}

// 标签图标：表单录入模式的表节点用表单图标，其余参数/表格用原图标
function nodeIcon(n: any): string {
  if (n.type === 'parameter') return 'fa-cog'
  if (n.data?.formEntry) return 'fa-edit'
  return 'fa-table'
}
function tabTitle(n: any): string {
  const parts: string[] = []
  if (n.data?.formEntry) parts.push('表单录入模式')
  parts.push('拖拽调整顺序')
  return parts.join(' · ')
}

// ==================== 标签拖拽排序 ====================
function onTabClick(id: string) {
  if (Date.now() - lastDragEndTime < 300) return
  currentTab.value = id
}
function onTabDragStart(id: string, e: DragEvent) {
  draggingTabId.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}
function onTabDrop(targetId: string, e: Event) {
  e.preventDefault()
  const fromId = draggingTabId.value
  if (fromId && fromId !== targetId) {
    const list = [...tabOrder.value]
    const from = list.indexOf(fromId)
    const to = list.indexOf(targetId)
    if (from >= 0 && to >= 0) {
      list.splice(from, 1)
      list.splice(list.indexOf(targetId), 0, fromId)
      tabOrder.value = list
      persistTabOrder()
    }
  }
  draggingTabId.value = null
}
function onTabDragEnd() {
  draggingTabId.value = null
  lastDragEndTime = Date.now()
}

// ==================== 节点数据编辑（同步到画布） ====================
function commitNode(node: any) {
  store.updateNode(node.id, { data: { ...node.data } })
}

// 参数显示名：优先使用 key，否则显示"参数N"（避免模板内 + 拼接的类型推断问题）
function paramLabel(p: any, i: string | number): string {
  const index = typeof i === 'number' ? i : Number(i)
  return p.key ? String(p.key) : `参数${index + 1}`
}

function addTableRow(node: any) {
  if (!node.data.rows) node.data.rows = []
  const row: Record<string, any> = {}
  ;(node.data.columns || []).forEach((c: string) => { row[c] = '' })
  node.data.rows.push(row)
  commitNode(node)
}
function removeTableRow(node: any, ri: number) {
  node.data.rows.splice(ri, 1)
  commitNode(node)
}
function onNodeCellInput(node: any, row: Record<string, any>, col: string, e: Event) {
  row[col] = (e.target as HTMLInputElement).value
  commitNode(node)
}

// ==================== 表单录入模式（数据表节点） ====================
// 当前正在编辑的记录行索引：-1 表示"新记录"（未写入 rows）
const currentFormIndex = ref(-1)
// 表单草稿（未保存前不写入 rows）
const formDraft = ref<Record<string, any>>({})
const formIsNew = computed(() => currentFormIndex.value < 0)

// 数据标题字段（在画布列定义中配置，互斥单选）
function formTitleField(node: any): string {
  return node?.data?.titleField || ''
}
// 侧边栏记录标题：优先使用标题字段值，否则显示"记录N"
function formRowTitle(row: Record<string, any>, ri: number | string): string {
  const tf = formTitleField(currentNode.value)
  if (tf) {
    const v = row?.[tf]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
  }
  return `记录${Number(ri) + 1}`
}

// 列录入方式与选项（在画布列定义中配置）
function columnInputType(col: string): string {
  return currentNode.value?.data?.columnInputs?.[col]?.type || 'text'
}
function columnInputOptions(col: string): string[] {
  const cfg = currentNode.value?.data?.columnInputs?.[col]
  return cfg?.options?.length ? cfg.options : []
}

// 初始化草稿（所有列置空）
function resetFormDraft() {
  const node = currentNode.value
  const draft: Record<string, any> = {}
  ;(node?.data?.columns || []).forEach((c: string) => { draft[c] = '' })
  formDraft.value = draft
}

// 选择"新记录"模式（侧边栏顶部的"新记录"项）
function selectFormNew() {
  currentFormIndex.value = -1
  resetFormDraft()
}
function startNewFormRecord() {
  selectFormNew()
}
// 选择已有记录，加载到表单
function selectFormRow(ri: number | string) {
  const node = currentNode.value
  const idx = Number(ri)
  const row = node?.data?.rows?.[idx]
  if (!node || !row) return
  currentFormIndex.value = idx
  formDraft.value = { ...row }
}
// 表单草稿编辑
function onFormDraftInput(col: string, e: Event) {
  formDraft.value[col] = (e.target as HTMLInputElement | HTMLSelectElement).value
}
function onFormDraftBool(col: string, e: Event) {
  formDraft.value[col] = (e.target as HTMLInputElement).checked
}
// 保存：新记录追加到 rows，已有记录覆盖
function saveFormRecord() {
  const node = currentNode.value
  if (!node) return
  if (!node.data.rows) node.data.rows = []
  if (currentFormIndex.value >= 0) {
    node.data.rows[currentFormIndex.value] = { ...formDraft.value }
  } else {
    node.data.rows.push({ ...formDraft.value })
    currentFormIndex.value = node.data.rows.length - 1
  }
  commitNode(node)
  ElMessage.success('已保存记录')
}
function clearFormDraft() {
  resetFormDraft()
}
function deleteFormRecord() {
  const node = currentNode.value
  if (!node || currentFormIndex.value < 0) return
  node.data.rows.splice(currentFormIndex.value, 1)
  currentFormIndex.value = -1
  resetFormDraft()
  commitNode(node)
  ElMessage.success('已删除记录')
}

// 切换节点时重置表单状态：有记录则选中第一条，否则进入"新记录"
watch(() => currentNode.value?.id, () => {
  const node = currentNode.value
  if (!node || node.type !== 'table') return
  if (node.data.rows?.length) {
    selectFormRow(0)
  } else {
    selectFormNew()
  }
}, { immediate: true })

function copyTableToClipboard(node: any) {
  if (!node || node.type !== 'table') return
  const columns = Array.isArray(node.data.columns) ? node.data.columns : []
  const rows = Array.isArray(node.data.rows) ? node.data.rows : []
  if (!columns.length) {
    ElMessage.warning('当前表格暂无列，无法复制')
    return
  }
  const lines = [columns.join('\t')]
  rows.forEach((row: Record<string, any>) => {
    lines.push(columns.map((c: string) => String(row?.[c] ?? '')).join('\t'))
  })
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => ElMessage.success('已复制到剪贴板'))
    .catch(() => ElMessage.error('复制失败'))
}

function parseClipboardTable(text: string, fallbackColumns: string[] = []) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return null
  const cells = lines.map((line) => line.split(/\t|,/).map((cell) => cell.trim()))
  const header = cells[0] || []
  const columns = fallbackColumns.length === header.length ? [...fallbackColumns] : header.map((c, idx) => c || `col${idx + 1}`)
  const rows: Record<string, any>[] = []
  for (let i = 1; i < cells.length; i++) {
    const values = cells[i] || []
    const row: Record<string, any> = {}
    columns.forEach((col, idx) => {
      row[col] = values[idx] ?? ''
    })
    rows.push(row)
  }
  return { columns, rows }
}

async function pasteTableFromClipboard(node: any) {
  if (!node || node.type !== 'table') return
  try {
    const text = await navigator.clipboard.readText()
    const parsed = parseClipboardTable(text, Array.isArray(node.data.columns) ? node.data.columns : [])
    if (!parsed) {
      ElMessage.warning('剪贴板中没有可粘贴的表格数据')
      return
    }
    node.data.columns = parsed.columns
    node.data.rows = parsed.rows
    commitNode(node)
    ElMessage.success('已从剪贴板粘贴表格数据')
  } catch (err: any) {
    ElMessage.error('粘贴失败: ' + (err?.message || String(err)))
  }
}

function exportTableToExcel(node: any) {
  if (!node || node.type !== 'table') return
  const columns = Array.isArray(node.data.columns) ? node.data.columns : []
  const rows = Array.isArray(node.data.rows) ? node.data.rows : []
  if (!columns.length) {
    ElMessage.warning('当前表格暂无列，无法导出 Excel')
    return
  }
  const worksheetData = [columns, ...rows.map((row: Record<string, any>) => columns.map((c: string) => row?.[c] ?? ''))]
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetData)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  const blob = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
  const fileBlob = new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(fileBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(node.name || 'table').replace(/[\\/:*?"<>|]/g, '-')}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('已导出 Excel')
}

// ==================== Excel 导入（数据表节点） ====================
const tableFileInput = ref<HTMLInputElement | null>(null)
const pendingTableNodeId = ref<string | null>(null)
function triggerTableImport(node: any) {
  pendingTableNodeId.value = node.id
  tableFileInput.value?.click()
}
async function handleTableImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const nodeId = pendingTableNodeId.value
  pendingTableNodeId.value = null
  if (!file || !nodeId) return
  try {
    const { columns, rows } = await parseExcelFile(file)
    const node = activeModel.value?.nodes.find((n) => n.id === nodeId)
    if (!node) return
    node.data.columns = columns
    node.data.rows = rows
    commitNode(node)
  } catch (err: any) {
    ElMessage.error('Excel 导入失败: ' + (err?.message || String(err)))
  }
}

const smartEntryModalVisible = ref(false)
const smartEntryInput = ref('')
const smartEntryLoading = ref(false)
const smartEntryPreview = ref<any>(null)
const smartEntryError = ref('')

function openSmartEntryModal() {
  if (!currentNode.value) {
    ElMessage.warning('请先选择一个参数或表格节点')
    return
  }
  smartEntryModalVisible.value = true
  smartEntryPreview.value = null
  smartEntryError.value = ''
}

function closeSmartEntryModal() {
  smartEntryModalVisible.value = false
  smartEntryPreview.value = null
  smartEntryError.value = ''
}

async function runSmartEntry() {
  const node = currentNode.value
  if (!node || !smartEntryInput.value.trim()) return
  smartEntryLoading.value = true
  smartEntryError.value = ''
  smartEntryPreview.value = null
  try {
    // 收集当前节点已有的字段名（参数节点 key / 表格节点列名），注入提示让模型强制复用，保证结果能关联回现有结构
    let existingFieldsText = ''
    if (node.type === 'parameter') {
      const keys = (node.data.params || []).map((p: any) => String(p?.key || '').trim()).filter(Boolean)
      existingFieldsText = keys.length
        ? `当前参数节点已有的参数名为：${keys.join('、')}。请只从这些名称中选择作为 key，不要新增、不要改名。`
        : '当前参数节点暂无参数名，你可以根据文本合理创建参数名。'
    } else if (node.type === 'table') {
      const columns = (node.data.columns || []).map((c: any) => String(c).trim()).filter(Boolean)
      existingFieldsText = columns.length
        ? `当前表格节点已有的列名为：${columns.join('、')}。请只使用这些列名作为 columns，不要新增、不要改名。`
        : '当前表格节点暂无列名，你可以根据文本合理创建列名。'
    }
    const prompt = `请根据下面的文本，提取结构化录入数据。若当前节点是参数节点，请输出 {"params":[{"key":"字段名","value":"字段值"}]}；若当前节点是表格节点，请输出 {"columns":["列1","列2"],"rows":[{"列1":"值1","列2":"值2"}]}`
    const systemPrompt = `你是一个数据录入助手。请只输出 JSON，不要解释。当前节点类型是 ${node.type}。${existingFieldsText}如果文本中的信息无法匹配到上述现有字段，请忽略该信息而不要新增字段。用户输入如下：\n${smartEntryInput.value}`
    const response = await callSmartEntryModel(prompt, systemPrompt)
    const parsed = parseSmartEntryResponse(response)
    if (!parsed) {
      throw new Error('模型返回内容无法解析为可录入的数据')
    }
    smartEntryPreview.value = mapSmartEntryToExisting(node, parsed)
  } catch (err: any) {
    smartEntryError.value = err?.message || '分析失败'
  } finally {
    smartEntryLoading.value = false
  }
}

async function callSmartEntryModel(prompt: string, systemPrompt: string): Promise<string> {
  // 自愈：ollama model 为空时自动回填真实模型，避免空 model 调用报 "model not found"
  await hostStore.ensureLlmReady()
  const llm = hostStore.AIconfig.llm
  const commonConfig = {
    stream: false,
    temperature: llm.temperature,
    top_p: llm.top_p,
    max_tokens: Math.min(4000, llm.max_tokens || 4000),
    frequency_penalty: llm.frequency_penalty,
    presence_penalty: llm.presence_penalty,
  }

  switch (llm.type) {
    case 'ollama':
      return AIUtils.sendToOllama(
        { model_url: llm.ollama.model_url, model: llm.ollama.model },
        commonConfig as any,
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      )
    case 'lmstudio':
      return AIUtils.sendToLMStudio(
        { base_url: llm.lmstudio.base_url, model: llm.lmstudio.model, api_key: (await hostStore.resolveApiKey(llm.lmstudio)) || llm.lmstudio.api_key, available_models: llm.lmstudio.available_models || [] },
        commonConfig as any,
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      )
    case 'openai': {
      const apiKey = (await hostStore.resolveApiKey(llm.openai)) || llm.openai.api_key || 'not-needed'
      const endpoint = `${(llm.openai.base_url || 'https://api.openai.com/v1').replace(/\/$/, '')}/v1/chat/completions`
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      }
      const body = AIUtils.buildOpenAIRequest(
        { model: llm.openai.model, api_key: apiKey, base_url: llm.openai.base_url },
        commonConfig,
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      )
      return AIUtils.makeAPIRequest(endpoint, body, headers)
    }
    case 'deepseek': {
      // 单来源：按当前接口样式取模型/密钥/地址（历史别名兼容）
      const ds = deepSeekConfig(llm)
      const apiKey = (await hostStore.resolveApiKey(ds)) || ds.api_key || 'not-needed'
      const endpoint = `${(ds.base_url || 'https://api.deepseek.com').replace(/\/$/, '')}/v1/chat/completions`
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      }
      const body = AIUtils.buildOpenAIRequest(
        { model: ds.model, api_key: apiKey, base_url: ds.base_url },
        commonConfig,
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      )
      return AIUtils.makeAPIRequest(endpoint, body, headers)
    }
    default:
      throw new Error('当前大模型类型暂不支持智能录入，请切换为 Ollama / LM Studio / OpenAI / DeepSeek')
  }
}

function normalizeFieldName(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function findMatchingFieldName(name: string, existingFields: string[]): string | null {
  const target = normalizeFieldName(name)
  if (!target) return null
  for (const field of existingFields) {
    const normalizedField = normalizeFieldName(field)
    if (!normalizedField) continue
    if (normalizedField === target || normalizedField.includes(target) || target.includes(normalizedField)) {
      return field
    }
  }
  return null
}

function mapSmartEntryToExisting(node: any, preview: any) {
  if (!node || !preview) return preview
  if (node.type === 'parameter') {
    const existingKeys = (node.data.params || []).map((p: any) => String(p?.key || '').trim()).filter(Boolean)
    const mapped = (preview.params || []).map((item: any) => {
      const key = String(item?.key || item?.name || '字段').trim()
      const matchedKey = findMatchingFieldName(key, existingKeys) || key
      return {
        key: matchedKey,
        value: item?.value ?? '',
        type: item?.type || 'string',
      }
    })
    return { ...preview, params: mapped }
  }
  if (node.type === 'table') {
    const existingColumns = (node.data.columns || []).map((c: string) => String(c).trim()).filter(Boolean)
    const mappedColumns = existingColumns.length ? existingColumns : []
    const mappedRows = (preview.rows || []).map((row: any) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return {}
      const mappedRow: Record<string, any> = {}
      existingColumns.forEach((column: string) => {
        const matchedSourceKey = Object.keys(row).find((key: string) => {
          const normalizedColumn = normalizeFieldName(column)
          const normalizedKey = normalizeFieldName(key)
          return normalizedKey === normalizedColumn || normalizedKey.includes(normalizedColumn) || normalizedColumn.includes(normalizedKey)
        })
        mappedRow[column] = matchedSourceKey ? row[matchedSourceKey] : ''
      })
      return mappedRow
    })
    return { ...preview, columns: mappedColumns, rows: mappedRows }
  }
  return preview
}

function parseSmartEntryResponse(text: string): any {
  const trimmed = String(text || '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  const jsonText = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed
  const parsed = JSON.parse(jsonText)
  if (!parsed || typeof parsed !== 'object') return null
  const node = currentNode.value
  if (!node) return null
  if (node.type === 'parameter') {
    if (Array.isArray(parsed.params)) {
      return {
        type: 'parameter',
        params: parsed.params.map((item: any) => ({
          key: String(item?.key || item?.name || '字段'),
          value: item?.value ?? '',
          type: 'string',
        })),
      }
    }
    if (parsed.key || parsed.value) {
      return {
        type: 'parameter',
        params: [{ key: String(parsed.key || '字段'), value: parsed.value ?? '', type: 'string' }],
      }
    }
    return null
  }
  if (node.type === 'table') {
    const columns = Array.isArray(parsed.columns) ? parsed.columns.map((c: any) => String(c)) : []
    const rawRows = Array.isArray(parsed.rows) ? parsed.rows : []
    if (!columns.length && Array.isArray(parsed.data)) {
      const first = parsed.data[0]
      if (Array.isArray(first)) {
        return { type: 'table', columns: first.map((_, index: number) => `col${index + 1}`), rows: parsed.data.slice(1).map((row: any[]) => Object.fromEntries(row.map((value, index) => [`col${index + 1}`, value]))) }
      }
      if (first && typeof first === 'object') {
        const keys = Object.keys(first)
        return { type: 'table', columns: keys, rows: parsed.data.map((row: Record<string, any>) => row) }
      }
    }
    return { type: 'table', columns, rows: rawRows.map((row: any) => (row && typeof row === 'object' ? row : {})) }
  }
  return null
}

function applySmartEntryPreview() {
  const node = currentNode.value
  const preview = smartEntryPreview.value
  if (!node || !preview) return
  const mappedPreview = mapSmartEntryToExisting(node, preview)
  if (node.type === 'parameter') {
    const params = Array.isArray(mappedPreview.params) ? mappedPreview.params : []
    const existingParams = Array.isArray(node.data.params) ? [...node.data.params] : []
    const byKey = new Map(existingParams.map((item: any) => [String(item?.key || '').trim().toLowerCase(), item]))
    params.forEach((item: any) => {
      const key = String(item?.key || item?.name || '字段').trim()
      if (!key) return
      const normalizedKey = key.toLowerCase()
      const existing = byKey.get(normalizedKey)
      if (existing) {
        existing.key = key
        existing.value = item?.value ?? ''
        existing.type = item?.type || existing.type || 'string'
      } else {
        existingParams.push({ key, value: item?.value ?? '', type: item?.type || 'string' })
        byKey.set(normalizedKey, existingParams[existingParams.length - 1])
      }
    })
    node.data.params = existingParams
  } else if (node.type === 'table') {
    const previewRows = Array.isArray(mappedPreview.rows) ? mappedPreview.rows : []
    const existingColumns = Array.isArray(node.data.columns) ? [...node.data.columns] : []
    const existingRows = Array.isArray(node.data.rows) ? [...node.data.rows] : []

    const nextRows = previewRows.map((row: any) => {
      const normalizedRow: Record<string, any> = {}
      existingColumns.forEach((column: string) => {
        const name = String(column).trim()
        const matchedSourceKey = Object.keys(row || {}).find((key: string) => {
          const normalizedColumn = normalizeFieldName(name)
          const normalizedKey = normalizeFieldName(key)
          return normalizedKey === normalizedColumn || normalizedKey.includes(normalizedColumn) || normalizedColumn.includes(normalizedKey)
        })
        normalizedRow[name] = matchedSourceKey ? row?.[matchedSourceKey] : ''
      })
      return normalizedRow
    })

    node.data.columns = existingColumns
    node.data.rows = [...existingRows, ...nextRows]
  }
  commitNode(node)
  ElMessage.success('已写入当前节点')
  closeSmartEntryModal()
}

const isEn = ref(false)
function t(zh: string): string { return isEn.value ? zh : zh }
</script>

<style scoped>
.dc-entry-view {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  overflow: hidden;
}
/* ====== 左侧节点标签垂直侧边栏（可拖拽排序） ====== */
.dc-entry-rail {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 150px;
  border-right: 1px solid var(--borderColor);
  background: var(--menuColor);
  overflow: hidden;
}
.dc-entry-rail-tabs { display: flex; flex-direction: column; gap: 2px; padding: 4px; flex: 1; min-height: 0; overflow-y: auto; }
.dc-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: grab;
  font-size: 12px;
  text-align: left;
  border-radius: 4px;
  user-select: none;
  box-sizing: border-box;
}
.dc-tab i { flex: 0 0 auto; width: 14px; text-align: center; }
.dc-tab-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-tab:active { cursor: grabbing; }
.dc-tab.dragging { opacity: 0.45; }
.dc-tab.active { background: var(--backgroundColor); color: var(--fontActiveColor); }
.dc-tab:hover { background: var(--backgroundColor); }
/* 底部固定：智能录入 */
.dc-entry-rail-footer { margin-top: auto; padding: 6px; border-top: 1px solid var(--borderColor); }
.dc-entry-rail-footer .dc-btn { width: 100%; justify-content: center; }

.dc-param-desc { padding: 6px 8px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--menuColor); font-size: 11px; color: var(--fontColor); white-space: pre-wrap; word-break: break-word; display: flex; gap: 5px; line-height: 1.5; }
.dc-param-desc i { color: var(--fontActiveColor); }
.dc-param-desc .dc-param-desc-text { flex: 1; min-width: 0; }
.dc-entry-body { flex: 1; overflow-y: auto; padding: 5px; display: flex; flex-direction: column; gap: 5px; }
.dc-entry-rowbtns { display: flex; gap: 5px; flex-wrap: nowrap; align-items: center; overflow-x: auto; }
.dc-entry-rowbtns .dc-btn { flex: 0 0 auto; margin-top: 0; white-space: nowrap; }

.dc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  padding: 3px 9px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; cursor: pointer;
}
.dc-btn:hover { background: var(--menuColor); }
.dc-btn.active { background: rgba(33,150,243,0.18); border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.dc-btn-primary { background: var(--menuActiveColor); border-color: transparent; color: var(--fontActiveColor); }
.dc-btn-sm { padding: 1px 6px; font-size: 10px; }
.dc-danger { color: #f44336; }
.dc-btn-block { width: 100%; justify-content: center; margin-top: 4px; }

.dc-input {
  width: 100%; box-sizing: border-box; margin: 0; padding: 3px 5px; border-radius: 4px; border: 0px; border-bottom: 1px solid var(--borderColor);
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; height: auto;
}

.dc-param-table { border-collapse: collapse; width: 100%; font-size: 11px; }
.dc-param-table th, .dc-param-table td { border: 1px solid var(--borderColor); padding: 3px 5px; }
.dc-param-table th { background: var(--menuColor); text-align: left; font-weight: 600; }

/* 参数面板：键只读 + 值可编辑 */
.dc-param-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dc-param-key {
  flex: 0 0 50px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fontActiveColor);
  font-size: 12px;
  font-weight: 600;
  text-align: right;
}
.dc-param-value { flex: 1; min-width: 0; }
.dc-param-unit { flex: 0 0 auto; min-width: 32px; font-size: 11px; color: var(--fontActiveColor); text-align: left; white-space: nowrap; }

.dc-empty { color: var(--borderColor); padding: 20px; text-align: center; font-size: 12px; }
.dc-textarea {
  width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--borderColor);
  border-radius: 6px; background: var(--backgroundColor); color: var(--fontColor);
  resize: vertical; min-height: 120px;
}
.dc-smart-entry-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; z-index: 2000;
}
.dc-smart-entry-modal {
  width: min(720px, calc(100vw - 32px)); background: var(--backgroundColor); border: 1px solid var(--borderColor); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); overflow: hidden;
}
.dc-smart-entry-header {
  display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--borderColor); background: var(--menuColor);
}
.dc-smart-entry-body { padding: 5px; display: flex; flex-direction: column; gap: 5px; }
.dc-smart-entry-label { font-size: 12px; font-weight: 600; }
.dc-smart-entry-error { color: #f44336; font-size: 12px; }
.dc-smart-entry-loading { color: var(--fontActiveColor); font-size: 12px; }
.dc-smart-entry-preview { border: 1px solid var(--borderColor); border-radius: 6px; padding: 5px; background: var(--menuColor); max-height: 220px; overflow: auto; }
.dc-smart-entry-preview-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.dc-smart-entry-preview-table-wrap { overflow-x: auto; }
.dc-smart-entry-preview-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.dc-smart-entry-preview-table th, .dc-smart-entry-preview-table td { border: 1px solid var(--borderColor); padding: 4px 6px; text-align: left; }
.dc-smart-entry-preview-table th { background: var(--backgroundColor); }
.dc-smart-entry-preview-json { margin: 0; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.dc-smart-entry-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--borderColor); }
.fa-spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.dc-section-title { font-size: 12px; font-weight: 600; margin-top: 8px; }

/* 按节点划分子标签 */
.dc-entry-sub { border-bottom: 1px solid var(--borderColor); flex-wrap: wrap; }
.dc-sub-hint { font-size: 10px; color: var(--borderColor); font-weight: normal; }

/* 数据表节点编辑 */
.dc-table-edit { flex: 1; min-height: 0; max-height: none; overflow: auto; border: 1px solid var(--borderColor); border-radius: 4px; }
.dc-table-edit table { border-collapse: collapse; font-size: 10px; width: 100%; }
.dc-table-edit th, .dc-table-edit td { border: 1px solid var(--borderColor); padding: 1px 3px; white-space: nowrap; }
.dc-table-edit th { background: var(--menuColor); position: sticky; top: 0; }
.dc-table-edit .dc-cell { width: 100%; min-width: 70px; box-sizing: border-box; }

/* ====== 表单录入模式 ====== */
.dc-form-entry { flex: 1; min-height: 0; display: flex; gap: 6px; align-items: stretch; }
.dc-form-sidebar {
  flex: 0 0 150px; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  border: 1px solid var(--borderColor); border-radius: 4px; overflow: hidden;
  background: var(--menuColor);
}
.dc-form-sidebar-head { padding: 5px; border-bottom: 1px solid var(--borderColor); flex: 0 0 auto; display: flex; flex-direction: column; gap: 4px; }
.dc-form-sidebar-head .dc-btn { width: 100%; }
.dc-form-sidebar-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 3px; display: flex; flex-direction: column; gap: 2px; }
.dc-form-sidebar-item {
  flex-shrink: 0; /* 数据多时不压缩条目，超出高度溢出以触发滚动 */
  display: flex; align-items: center; gap: 5px; padding: 4px 6px; border-radius: 4px;
  cursor: pointer; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border: 1px solid transparent; color: var(--fontColor);
}
.dc-form-sidebar-item:hover { background: var(--backgroundColor); }
.dc-form-sidebar-item.active { background: rgba(33,150,243,0.18); border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.dc-form-sidebar-empty { color: var(--borderColor); padding: 12px; text-align: center; font-size: 11px; }

.dc-form-main {
  flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--borderColor); border-radius: 4px; padding: 8px; overflow-y: auto;
}
.dc-form-field { display: flex; align-items: center; gap: 6px; }
.dc-form-label {
  flex: 0 0 76px; font-size: 11px; font-weight: 600; color: var(--fontActiveColor);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right;
  padding: 0px
}
.dc-form-control { flex: 1; min-width: 0; }
.dc-form-control .dc-input { width: 100%; box-sizing: border-box; }
/* textarea 字段：标签顶部对齐，避免多行文本框相对标签居中显得错位 */
.dc-form-field:has(.dc-form-textarea) { align-items: flex-start; }
.dc-form-field:has(.dc-form-textarea) .dc-form-label { padding-top: 4px; }
.dc-form-textarea { min-height: 56px; resize: vertical; font-family: inherit; }
.dc-form-bool { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; color: var(--fontColor); }
.dc-form-bool input { margin: 0; }
.dc-form-actions { display: flex; gap: 5px; margin-bottom: 4px; padding-bottom: 8px; border-bottom: 1px solid var(--borderColor); }

/* 滚动条（与主系统一致） */
.dc-entry-view ::-webkit-scrollbar { width: 4px; height: 4px; }
.dc-entry-view ::-webkit-scrollbar-track { background: var(--backgroundColor); }
.dc-entry-view ::-webkit-scrollbar-thumb { background: var(--borderColor); border-radius: 2px; }
.dc-entry-view ::-webkit-scrollbar-thumb:hover { background: var(--fontActiveColor); }
</style>
