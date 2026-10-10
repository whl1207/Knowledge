<!-- src/workflow/ui/AppSettingsDialog.vue -->
<!-- 应用设置：应用信息 / 功能开关（features）/ 全局变量（环境变量、会话变量） -->
<template>
  <el-dialog
    :model-value="modelValue"
    class="wf-dialog"
    :title="t('app.title')"
    width="640px"
    top="6vh"
    append-to-body
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <el-tabs v-model="activeTab">
      <!-- 应用信息 -->
      <el-tab-pane :label="t('app.tab.info')" name="info">
        <div class="wf-field">
          <div class="wf-field__label">{{ t('app.name') }}</div>
          <el-input :model-value="app.name" size="small" @update:model-value="setApp('name', $event)" />
        </div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('app.description') }}</div>
          <el-input :model-value="app.description ?? ''" size="small" type="textarea" :rows="2" @update:model-value="setApp('description', $event)" />
        </div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('app.icon') }}</div>
          <el-input :model-value="app.icon ?? ''" size="small" style="width:120px" @update:model-value="setApp('icon', $event)" />
          <div class="wf-field__hint">{{ t('app.iconHint') }}</div>
        </div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('app.mode') }}</div>
          <el-select :model-value="app.mode" size="small" style="width:100%" @update:model-value="setApp('mode', $event)">
            <el-option :label="t('app.mode.workflow')" value="workflow" />
            <el-option :label="t('app.mode.advanced-chat')" value="advanced-chat" />
          </el-select>
        </div>
      </el-tab-pane>

      <!-- 功能开关 -->
      <el-tab-pane :label="t('app.tab.features')" name="features">
        <div class="wf-field">
          <div class="wf-field__label">{{ t('app.opening') }}</div>
          <el-input :model-value="features.opening_statement ?? ''" size="small" type="textarea" :rows="2" @update:model-value="setFeature('opening_statement', $event)" />
        </div>
        <div class="wf-field">
          <div class="wf-field__label">{{ t('app.suggestedQuestions') }}</div>
          <el-input
            :model-value="suggestedQuestionsText"
            size="small"
            type="textarea"
            :rows="3"
            :placeholder="t('app.suggestedQuestionsPlaceholder')"
            @update:model-value="setSuggestedQuestions"
          />
          <div class="wf-field__hint">{{ t('app.suggestedQuestionsHint') }}</div>
        </div>

        <div class="wf-inline" style="margin-bottom:8px">
          <el-switch :model-value="!!features.file_upload?.enabled" size="small" @update:model-value="(v: string | number | boolean) => setFileUpload(!!v)" />
          <span class="wf-field__label">{{ t('app.fileUpload') }}</span>
        </div>
        <div v-if="features.file_upload?.enabled" class="wf-field">
          <div class="wf-field__label">{{ t('app.fileUploadLimit') }}</div>
          <el-input-number
            :model-value="Number(features.file_upload?.number_limits ?? 3)"
            size="small"
            :min="1"
            :max="20"
            controls-position="right"
            style="width:100%"
            @update:model-value="(v: number | undefined) => setFeature('file_upload', { ...features.file_upload, number_limits: Number(v ?? 3) })"
          />
        </div>

        <div class="wf-inline" style="margin-bottom:8px">
          <el-switch :model-value="features.retriever_resource?.enabled !== false" size="small" @update:model-value="(v: string | number | boolean) => setNested('retriever_resource', !!v)" />
          <span class="wf-field__label">{{ t('app.retrieverResource') }}</span>
        </div>
        <div class="wf-inline" style="margin-bottom:8px">
          <el-switch :model-value="!!features.sensitive_word_avoidance?.enabled" size="small" @update:model-value="(v: string | number | boolean) => setNested('sensitive_word_avoidance', !!v)" />
          <span class="wf-field__label">{{ t('app.sensitiveWord') }}</span>
        </div>
        <div class="wf-inline">
          <el-switch :model-value="!!features.speech_to_text?.enabled" size="small" @update:model-value="(v: string | number | boolean) => setNested('speech_to_text', !!v)" />
          <span class="wf-field__label">{{ t('app.speechToText') }}</span>
        </div>
      </el-tab-pane>

      <!-- 全局变量 -->
      <el-tab-pane :label="t('app.tab.variables')" name="variables">
        <div class="wf-section-title">{{ t('app.envVars') }}</div>
        <div class="wf-field__hint" style="margin-bottom:8px">{{ t('app.envVarsHint') }}</div>
        <VariableRows :rows="environmentVariables" :add-label="t('app.addEnvVar')" />

        <div class="wf-section-title">{{ t('app.convVars') }}</div>
        <div class="wf-field__hint" style="margin-bottom:8px">{{ t('app.convVarsHint') }}</div>
        <VariableRows :rows="conversationVariables" :add-label="t('app.addConvVar')" />
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <button class="wf-btn" @click="$emit('update:modelValue', false)">{{ t('app.close') }}</button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElDialog, ElInput, ElInputNumber, ElOption, ElSelect, ElSwitch, ElTabPane, ElTabs } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from './locales'
import VariableRows from './VariableRows.vue'
import type { ConversationVariable, DslDocument, EnvironmentVariable } from '@/workflow/dsl/types'

const props = defineProps<{
  modelValue: boolean
  document: DslDocument | null
}>()

defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const store = usestore()
const t = createFlowT(store.locales || 'zh')

const activeTab = ref('info')

const app = computed<Record<string, any>>(() => props.document?.app ?? {})
const features = computed<Record<string, any>>(() => {
  if (!props.document) return {}
  if (!props.document.workflow.features || typeof props.document.workflow.features !== 'object') {
    props.document.workflow.features = {}
  }
  return props.document.workflow.features as Record<string, any>
})

const environmentVariables = computed<EnvironmentVariable[]>(() => {
  if (!props.document) return []
  if (!Array.isArray(props.document.workflow.environment_variables)) props.document.workflow.environment_variables = []
  return props.document.workflow.environment_variables
})

const conversationVariables = computed<ConversationVariable[]>(() => {
  if (!props.document) return []
  if (!Array.isArray(props.document.workflow.conversation_variables)) props.document.workflow.conversation_variables = []
  return props.document.workflow.conversation_variables
})

const suggestedQuestionsText = computed(() =>
  Array.isArray(features.value.suggested_questions) ? (features.value.suggested_questions as string[]).join('\n') : '',
)

function setApp(key: string, value: unknown): void {
  if (!props.document) return
  props.document.app = { ...props.document.app, [key]: value } as DslDocument['app']
}

function setFeature(key: string, value: unknown): void {
  features.value[key] = value
}

function setNested(key: string, enabled: boolean): void {
  const current = features.value[key]
  features.value[key] = { ...(current && typeof current === 'object' ? current : {}), enabled }
}

function setFileUpload(enabled: boolean): void {
  const current = features.value.file_upload
  features.value.file_upload = { ...(current && typeof current === 'object' ? current : {}), enabled }
}

function setSuggestedQuestions(value: string): void {
  features.value.suggested_questions = value.split('\n').map((line) => line.trim()).filter(Boolean)
}
</script>
