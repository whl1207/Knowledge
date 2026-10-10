<!-- src/workflow/nodes/start/Properties.vue -->
<!-- 开始节点：定义对外输入变量（下游通过 [startId, variable] 引用） -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">
      {{ t('panel.start.hint') }}
    </div>

    <div v-for="(item, index) in variables" :key="index" class="wf-card">
      <div class="wf-card__head">
        <span class="wf-card__title">{{ t('panel.start.variable') }} {{ index + 1 }}</span>
        <button class="wf-icon-btn" :title="t('panel.moveUp')" @click="move(index, -1)">↑</button>
        <button class="wf-icon-btn" :title="t('panel.moveDown')" @click="move(index, 1)">↓</button>
        <button class="wf-icon-btn is-danger" :title="t('panel.delete')" @click="remove(index)">✕</button>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.start.name') }}</div>
        <el-input v-model="item.variable" size="small" :placeholder="t('panel.start.namePlaceholder')" />
        <div v-if="nameError(item, index)" class="wf-field__error">{{ nameError(item, index) }}</div>
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.start.label') }}</div>
        <el-input v-model="item.label" size="small" :placeholder="t('panel.start.labelPlaceholder')" />
      </div>

      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.start.type') }}</div>
        <el-select v-model="item.type" size="small" style="width:100%">
          <el-option v-for="opt in VAR_INPUT_TYPES" :key="opt" :label="t('varType.' + opt)" :value="opt" />
        </el-select>
      </div>

      <div v-if="item.type === 'text-input' || item.type === 'paragraph'" class="wf-field">
        <div class="wf-field__label">{{ t('panel.start.maxLength') }}</div>
        <el-input-number
          :model-value="item.max_length ?? undefined"
          size="small"
          :min="1"
          :max="100000"
          controls-position="right"
          style="width:100%"
          @update:model-value="item.max_length = ($event as number)"
        />
      </div>

      <div v-if="item.type === 'select'" class="wf-field">
        <div class="wf-field__label">{{ t('panel.start.options') }}</div>
        <el-input
          :model-value="currentOptionsText(index, item)"
          size="small"
          :placeholder="t('panel.start.optionsPlaceholder')"
          @update:model-value="optionsText[index] = $event"
          @change="syncOptions(index)"
        />
        <div class="wf-field__hint">{{ t('panel.start.optionsHint') }}</div>
      </div>

      <div class="wf-inline">
        <el-switch v-model="item.required" size="small" />
        <span class="wf-field__label">{{ t('panel.start.required') }}</span>
      </div>
    </div>

    <button class="wf-add-btn" @click="add">+ {{ t('panel.start.addVariable') }}</button>

    <div v-if="!variables.length" class="wf-empty-hint">{{ t('panel.start.empty') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import type { NodePanelProps } from '../panelProps'
import type { StartVariable } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

/** 开始节点支持的外部输入类型（对齐 Dify 的 start 变量类型） */
const VAR_INPUT_TYPES = [
  'text-input',
  'paragraph',
  'select',
  'number',
  'url',
  'files',
  'file-list',
  'json_object',
  'checkbox',
] as const

const variables = computed<StartVariable[]>(() => {
  const data = props.data as unknown as Record<string, unknown>
  if (!Array.isArray(data.variables)) data.variables = []
  return data.variables as StartVariable[]
})

/** select 类型的选项用逗号分隔编辑，单独保存编辑态文本 */
const optionsText = ref<Record<number, string>>({})

function currentOptionsText(index: number, item: StartVariable): string {
  if (optionsText.value[index] !== undefined) return optionsText.value[index]
  return Array.isArray(item.options) ? item.options.join(', ') : ''
}

function syncOptions(index: number): void {
  const item = variables.value[index]
  if (!item) return
  item.options = (optionsText.value[index] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/** 变量名必须是合法标识符且不重复（Dify 同样要求） */
function nameError(item: StartVariable, index: number): string {
  const name = String(item.variable || '').trim()
  if (!name) return t('panel.start.nameRequired')
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return t('panel.start.nameInvalid')
  const duplicated = variables.value.some((other, i) => i !== index && other.variable === name)
  return duplicated ? t('panel.start.nameDuplicated') : ''
}

function add(): void {
  variables.value.push({
    variable: '',
    label: '',
    type: 'text-input',
    required: true,
    max_length: 48,
    options: [],
  })
}

function remove(index: number): void {
  variables.value.splice(index, 1)
  delete optionsText.value[index]
}

function move(index: number, delta: number): void {
  const target = index + delta
  if (target < 0 || target >= variables.value.length) return
  const [item] = variables.value.splice(index, 1)
  variables.value.splice(target, 0, item)
}
</script>
