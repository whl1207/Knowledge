<!-- nodes/structured/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 表格描述 -->
    <div class="property-row">
      <label class="property-label">{{ t('table_description') }}</label>
      <div class="property-input">
        <input type="text" :value="config.tableDescription" @input="onConfig('tableDescription', ($event.target as HTMLInputElement).value)"
          :placeholder="t('input_table_description')" style="width:calc(100% - 8px);" />
      </div>
    </div>

    <!-- 列管�?-->
    <div class="property-group" style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.02);border-radius:5px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
        <h4 style="margin:0;font-size:14px;"><i class="fa fa-columns"></i> {{ t('column_management') }}</h4>
        <button class="wf-btn primary small" @click="onAddColumn">
          <i class="fa fa-plus"></i> {{ t('add_column') }}
        </button>
      </div>
      
      <div v-if="columns.length > 0">
        <table class="columns-table" style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:rgba(0,0,0,0.05);">
              <th style="padding:4px;border:1px solid var(--borderColor);">{{ t('column_name') }}</th>
              <th style="padding:4px;border:1px solid var(--borderColor);width:80px;">{{ t('column_type') }}</th>
              <th style="padding:4px;border:1px solid var(--borderColor);width:60px;text-align:center;">{{ t('required') }}</th>
              <th style="padding:4px;border:1px solid var(--borderColor);width:40px;text-align:center;">{{ t('delete') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="col in columns" :key="col.id">
              <td style="padding:2px;border:1px solid var(--borderColor);">
                <input :value="col.name" @input="onColumnUpdate(col.id, 'name', ($event.target as HTMLInputElement).value)"
                  style="width:calc(100% - 8px);padding:3px;font-size:11px;" />
              </td>
              <td style="padding:2px;border:1px solid var(--borderColor);">
                <select :value="col.type" @change="onColumnUpdate(col.id, 'type', ($event.target as HTMLSelectElement).value)"
                  style="width:100%;padding:3px;font-size:11px;">
                  <option value="text">{{ t('text_type') }}</option>
                  <option value="number">{{ t('number_type') }}</option>
                  <option value="boolean">{{ t('boolean_type') }}</option>
                  <option value="date">{{ t('date_type') }}</option>
                </select>
              </td>
              <td style="padding:2px;border:1px solid var(--borderColor);text-align:center;">
                <input type="checkbox" :checked="col.required" @change="onColumnUpdate(col.id, 'required', ($event.target as HTMLInputElement).checked)"
                  :disabled="columns.indexOf(col) < 2" />
              </td>
              <td style="padding:2px;border:1px solid var(--borderColor);text-align:center;">
                <button class="wf-btn danger small" @click="onDeleteColumn(col.id)"
                  :disabled="columns.length <= 2">
                  <i class="fa fa-trash"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 数据表格 -->
    <div class="property-group" style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.02);border-radius:5px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
        <h4 style="margin:0;font-size:14px;"><i class="fa fa-table"></i> {{ t('data_table') }}</h4>
        <button class="wf-btn primary small" @click="onAddRow">
          <i class="fa fa-plus"></i> {{ t('add_row') }}
        </button>
      </div>
      
      <div v-if="rows.length > 0">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="position:sticky;top:0;background:var(--backgroundColor);z-index:1;">
              <th style="padding:4px;text-align:center;width:30px;border:1px solid var(--borderColor);">{{ t('row_number') }}</th>
              <th v-for="col in columns" :key="col.id" style="padding:4px;border:1px solid var(--borderColor);min-width:80px;font-size:10px;">
                {{ col.name }}<span v-if="col.required" style="color:#f44336;margin-left:2px;">*</span>
              </th>
              <th style="padding:4px;text-align:center;width:40px;border:1px solid var(--borderColor);">{{ t('delete') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td style="text-align:center;padding:4px;border:1px solid var(--borderColor);font-size:10px;opacity:0.7;">
                {{ rows.indexOf(row) + 1 }}
              </td>
              <td v-for="col in columns" :key="col.id" style="padding:2px;border:1px solid var(--borderColor);">
                <input :value="row.columns[col.id.toString()] || ''" 
                  @input="onRowUpdate(row.id, col.id.toString(), ($event.target as HTMLInputElement).value)"
                  style="width:calc(100% - 8px);padding:3px;font-size:11px;" />
              </td>
              <td style="padding:2px;border:1px solid var(--borderColor);text-align:center;">
                <button class="wf-btn danger small" @click="onDeleteRow(row.id)">
                  <i class="fa fa-trash"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="code-help" style="text-align:center;padding:10px;">
        <small>{{ t('empty_table') }}</small>
      </div>
    </div>

    <!-- 格式选项 -->
    <div class="property-group" style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.02);border-radius:5px;">
      <h4 style="margin:0 0 8px 0;font-size:14px;"><i class="fa fa-cog"></i> {{ t('format_options') }}</h4>
      <div class="property-row">
        <label class="property-label" style="width:80px;">{{ t('output_format') }}</label>
        <select :value="config.outputFormat" @change="onConfig('outputFormat', ($event.target as HTMLSelectElement).value)"
          style="flex:1;">
          <option value="json">{{ t('format_json') }}</option>
          <option value="markdown">{{ t('format_markdown') }}</option>
          <option value="text">{{ t('format_text') }}</option>
          <option value="csv">{{ t('format_csv') }}</option>
        </select>
      </div>
      <div class="property-row">
        <label class="property-label" style="width:80px;">{{ t('include_headers') }}</label>
        <input type="checkbox" :checked="config.includeHeaders" @change="onConfig('includeHeaders', ($event.target as HTMLInputElement).checked)" />
      </div>
    </div>

    <div class="code-help">
      <small>{{ t('structured_help') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { NodeData, StructuredColumn, StructuredRow, StructuredConfig } from '@/components/workFlow/WorkflowTypes'
import { defaultStructuredConfig, defaultStructuredColumns } from '@/components/workFlow/WorkflowDefaults'

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
}>()

const config = computed(() => props.node.structuredConfig || { ...defaultStructuredConfig })
const columns = computed(() => props.node.structuredColumns || [...defaultStructuredColumns.map(c => ({ ...c }))])
const rows = computed(() => props.node.structuredData || [])

const onConfig = (key: string, value: any) => {
  const cfg = { ...config.value, [key]: value }
  emit('update', { structuredConfig: cfg })
}

const onAddColumn = () => {
  const cols = [...columns.value]
  const newId = cols.length > 0 ? Math.max(...cols.map(c => c.id)) + 1 : 0
  cols.push({ id: newId, name: `${props.t('column')} ${cols.length + 1}`, type: 'text', required: false })
  const data = rows.value.map(r => ({ ...r, columns: { ...r.columns, [newId.toString()]: '' } }))
  emit('update', { structuredColumns: cols, structuredData: data })
}

const onDeleteColumn = (colId: number) => {
  let cols = [...columns.value]
  if (cols.length <= 2) return
  cols = cols.filter(c => c.id !== colId)
  const data = rows.value.map(r => {
    const cols_ = { ...r.columns }
    delete cols_[colId.toString()]
    return { ...r, columns: cols_ }
  })
  emit('update', { structuredColumns: cols, structuredData: data })
}

const onColumnUpdate = (colId: number, field: string, value: any) => {
  const cols = columns.value.map(c => c.id === colId ? { ...c, [field]: value } : { ...c })
  emit('update', { structuredColumns: cols })
}

const onAddRow = () => {
  const data = [...rows.value]
  const newId = data.length > 0 ? Math.max(...data.map(r => r.id)) + 1 : 0
  const rowCols: Record<string, string> = {}
  columns.value.forEach(c => { rowCols[c.id.toString()] = '' })
  data.push({ id: newId, columns: rowCols })
  emit('update', { structuredData: data })
}

const onDeleteRow = (rowId: number) => {
  const data = rows.value.filter(r => r.id !== rowId)
  emit('update', { structuredData: data })
}

const onRowUpdate = (rowId: number, colId: string, value: string) => {
  const data = rows.value.map(r => {
    if (r.id === rowId) {
      return { ...r, columns: { ...r.columns, [colId]: value } }
    }
    return r
  })
  emit('update', { structuredData: data })
}
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.property-btn.small { font-size: 11px; padding: 3px 6px; height: auto; }
.property-btn.primary { background-color: var(--fontActiveColor); color: var(--backgroundColor); border: none; border-radius: 4px; cursor: pointer; }
.property-btn.danger { background-color: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; }
</style>

