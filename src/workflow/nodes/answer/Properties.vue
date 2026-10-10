<!-- src/workflow/nodes/answer/Properties.vue -->
<!-- 直接回复节点：正文支持 {{#节点.变量#}} 引用，引用列表随正文自动同步 -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">
      {{ t('panel.answer.hint') }}
    </div>

    <div class="wf-field">
      <div class="wf-field__head">
        <span class="wf-field__label">{{ t('panel.answer.content') }}</span>
        <VariableSelector
          insert-mode
          :nodes="nodes"
          :edges="edges"
          :current-node-id="nodeId"
          :environment-variables="environmentVariables"
          :conversation-variables="conversationVariables"
          :placeholder="t('panel.insertVariable')"
          @pick="insertVariable"
        />
      </div>
      <el-input
        ref="textareaRef"
        :model-value="answer"
        type="textarea"
        :rows="10"
        :placeholder="t('panel.answer.placeholder')"
        @update:model-value="onInput"
      />
    </div>

    <div class="wf-section-title">{{ t('panel.answer.references') }}</div>
    <div v-if="!references.length" class="wf-empty-hint">{{ t('panel.answer.noReferences') }}</div>
    <div v-for="(ref, index) in references" :key="index" class="wf-inline" style="margin-bottom:4px">
      <span class="wf-tag">{{ describe(ref) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElInput } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import VariableSelector from '@/workflow/ui/VariableSelector.vue'
import { extractSelectors, insertVariableAtCursor, selectorKey } from '@/workflow/dsl/variable'
import { describeSelector, type VariableOption } from '@/workflow/ui/variables'
import type { NodePanelProps } from '../panelProps'
import type { ValueSelector } from '@/workflow/dsl/types'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const textareaRef = ref<{ textarea?: HTMLTextAreaElement } | null>(null)

const answer = computed<string>(() => String((props.data as unknown as Record<string, unknown>).answer ?? ''))

const namespaceLabels = computed<Record<string, string>>(() => ({
  sys: t('var.namespace.sys'),
  env: t('var.namespace.env'),
  conversation: t('var.namespace.conversation'),
  rag: t('var.namespace.rag'),
}))

/** 已引用变量（按首次出现顺序去重） */
const references = computed<ValueSelector[]>(() => {
  const seen = new Set<string>()
  const result: ValueSelector[] = []
  for (const selector of extractSelectors(answer.value)) {
    const key = selectorKey(selector)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(selector)
  }
  return result
})

function describe(selector: ValueSelector): string {
  return describeSelector(selector, props.nodes, namespaceLabels.value)
}

/** 正文变化：写入 answer，并把引用列表同步到 data.variables（Dify 的 answer 节点有该字段） */
function onInput(value: string): void {
  const data = props.data as unknown as Record<string, unknown>
  data.answer = value
  data.variables = extractSelectors(value).map((selector) => ({
    variable: selector[1],
    value_selector: selector,
  }))
}

/** 从变量选择器插入到光标处 */
function insertVariable(option: VariableOption): void {
  const el = textareaRef.value?.textarea
  const current = answer.value
  const cursor = el ? el.selectionStart ?? current.length : current.length
  const next = insertVariableAtCursor(current, cursor, option.selector)
  onInput(next.text)
  requestAnimationFrame(() => {
    const target = textareaRef.value?.textarea
    if (!target) return
    target.focus()
    target.setSelectionRange(next.cursor, next.cursor)
  })
}
</script>
