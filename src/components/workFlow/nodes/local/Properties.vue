<!-- nodes/local/Properties.vue -->
<template>
  <div class="property-group">
    <!-- 文件路径 -->
    <div class="property-row">
      <label class="property-label">{{ t('file_path') }}</label>
      <div class="property-input">
        <div style="display:flex;gap:5px;">
          <input type="text" :value="node.prompt" @input="onUpdate('prompt', ($event.target as HTMLInputElement).value)"
            :placeholder="t('select_file')" style="flex:1;" />
          <button class="wf-btn small" @click="$emit('select-file')">
            <i class="fa fa-folder-open"></i>
          </button>
        </div>
      </div>
    </div>
    
    <!-- 文件扩展�?-->
    <div class="property-row">
      <label class="property-label">{{ t('file_type') }}</label>
      <div class="property-input">
        <select :value="node.model" @input="onUpdate('model', ($event.target as HTMLSelectElement).value)">
          <option value=".txt">.txt</option>
          <option value=".md">.md</option>
          <option value=".pdf">.pdf</option>
          <option value=".docx">.docx</option>
          <option value=".json">.json</option>
          <option value=".csv">.csv</option>
          <option value=".html">.html</option>
          <option value=".py">.py</option>
        </select>
      </div>
    </div>
    
    <!-- 处理模式 -->
    <div class="property-row">
      <label class="property-label">{{ t('file_processing_mode') }}</label>
      <div class="property-input">
        <select :value="node.fileMode" @change="onFileModeChange(($event.target as HTMLSelectElement).value)">
          <option value="full">{{ t('full_file_mode') }}</option>
          <option value="template">{{ t('template_mode') }}</option>
        </select>
      </div>
    </div>

    <!-- 完整文件模式说明 -->
    <div v-if="node.fileMode === 'full'" class="code-help">
      <small>{{ t('full_file_mode_help') }}</small>
    </div>

    <!-- 模板匹配模式 -->
    <div v-if="node.fileMode === 'template'">
      <div class="property-group" style="margin-top:10px;padding:8px;background:rgba(0,0,0,0.02);border-radius:5px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
          <h4 style="margin:0;font-size:14px;"><i class="fa fa-files-o"></i> {{ t('template_configuration') }}</h4>
          <button class="wf-btn primary small" @click="onAddTemplate">
            <i class="fa fa-plus"></i> {{ t('add_template') }}
          </button>
        </div>
        <table class="templates-table" style="width:100%;border-collapse:collapse;font-size:11px;">
          <thead>
            <tr style="background:rgba(0,0,0,0.05);">
              <th style="padding:4px;border:1px solid var(--borderColor);">{{ t('template_name') }}</th>
              <th style="padding:4px;border:1px solid var(--borderColor);">{{ t('pattern') }}</th>
              <th style="padding:4px;border:1px solid var(--borderColor);">{{ store.locales=='zh'?'大小':'size' }}</th>
              <th style="padding:4px;border:1px solid var(--borderColor);width:40px;text-align:center;">{{ t('delete') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(tmpl, idx) in node.fileTemplates" :key="idx">
              <td style="padding:2px;border:1px solid var(--borderColor);">
                <input :value="tmpl.name" @input="onTemplateUpdate(idx, 'name', ($event.target as HTMLInputElement).value)"
                  :placeholder="t('template_name_placeholder')" style="width:calc(100% - 6px);padding:2px;font-size:11px;" />
              </td>
              <td style="padding:2px;border:1px solid var(--borderColor);">
                <input :value="tmpl.pattern" @input="onTemplateUpdate(idx, 'pattern', ($event.target as HTMLInputElement).value)"
                  :placeholder="t('pattern_placeholder')" style="width:calc(100% - 6px);padding:2px;font-size:11px;" />
              </td>
              <td style="padding:2px;border:1px solid var(--borderColor);text-align:right;white-space:nowrap;">
                {{ getSliceSize(idx) }}
              </td>
              <td style="padding:2px;border:1px solid var(--borderColor);text-align:center;">
                <button class="wf-btn danger small" @click="onDeleteTemplate(idx)">
                  <i class="fa fa-trash"></i>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="code-help" style="margin-top:5px;font-size:10px;">
          <small>{{ t('template_examples') }}</small>
        </div>
      </div>
      
      <!-- 刷新端口按钮 -->
      <div style="margin-top:5px;display:flex;gap:5px;">
        <button class="wf-btn primary small" @click="$emit('refresh-ports')">
          <i class="fa fa-refresh"></i> {{ t('refresh_ports') }}
        </button>
      </div>
    </div>

    <div class="code-help" style="margin-top:10px;">
      <small>{{ t('local_node_help_new') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NodeData, FileMode } from '@/components/workFlow/WorkflowTypes'
import { usestore } from '@/store'
const store = usestore()

const props = defineProps<{
  node: NodeData
  t: (key: string) => string
}>()

const emit = defineEmits<{
  update: [data: Partial<NodeData>]
  'select-file': []
  'refresh-ports': []
}>()

const onUpdate = (key: string, value: any) => emit('update', { [key]: value })

const onFileModeChange = (mode: string) => {
  const fileMode = mode as FileMode
  const updates: Partial<NodeData> = { fileMode }
  if (fileMode === 'template' && (!props.node.fileTemplates || props.node.fileTemplates.length === 0)) {
    updates.fileTemplates = [
      { name: 'chapter_1', pattern: 'chapter_1', outputName: 'chapter_1' },
      { name: 'chapter_2', pattern: 'chapter_2', outputName: 'chapter_2' }
    ]
  }
  emit('update', updates)
}

const onAddTemplate = () => {
  const templates = [...(props.node.fileTemplates || [])]
  templates.push({ name: `template ${templates.length + 1}`, pattern: '', outputName: `t${templates.length + 1}` })
  emit('update', { fileTemplates: templates })
}

const onDeleteTemplate = (idx: number) => {
  const templates = [...(props.node.fileTemplates || [])]
  if (templates.length > 0) templates.splice(idx, 1)
  emit('update', { fileTemplates: templates })
}

const onTemplateUpdate = (idx: number, field: string, value: string) => {
  const templates = [...(props.node.fileTemplates || [])]
  if (templates[idx]) {
    (templates[idx] as any)[field] = value
    emit('update', { fileTemplates: templates })
  }
}

const getSliceSize = (idx: number): string => {
  if (!props.node.result) return '-'
  try {
    const parsed = JSON.parse(props.node.result)
    if (parsed && typeof parsed === 'object' && parsed.slices) {
      const sliceKey = `output${idx + 1}`
      const content = parsed.slices[sliceKey]
      if (typeof content === 'string') {
        return `${content.length}`
      }
    }
  } catch {
    // ignore parse errors
  }
  return '-'
}
</script>

<style scoped>
.code-help { margin-top: 8px; font-size: 11px; color: var(--fontColor); opacity: 0.7; }
.property-btn.small { font-size: 11px; padding: 3px 6px; height: auto; }
.property-btn.primary { background-color: var(--fontActiveColor); color: var(--backgroundColor); border: none; border-radius: 4px; cursor: pointer; }
.property-btn.danger { background-color: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; }
td input {margin:0px}
</style>

