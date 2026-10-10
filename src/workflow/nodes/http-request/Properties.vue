<!-- src/workflow/nodes/http-request/Properties.vue -->
<!-- HTTP 请求：方法 / 地址 / 参数 / 请求头 / 请求体 / 鉴权 / 超时 -->
<template>
  <div>
    <div class="wf-inline wf-inline--full" style="margin-bottom:10px">
      <el-select :model-value="method" size="small" style="width:110px;flex:0 0 110px" @update:model-value="set('method', $event)">
        <el-option v-for="item in METHODS" :key="item" :label="item.toUpperCase()" :value="item" />
      </el-select>
      <el-input
        :model-value="url"
        size="small"
        :placeholder="t('panel.http.urlPlaceholder')"
        @update:model-value="set('url', $event)"
      />
    </div>

    <div class="wf-section-title">{{ t('panel.http.params') }}</div>
    <KeyValueRows :rows="params" :key-placeholder="t('panel.http.key')" :value-placeholder="t('panel.http.value')" :add-label="t('panel.http.addParam')" />
    <div v-if="!params.length" class="wf-empty-hint">{{ t('panel.http.noParams') }}</div>

    <div class="wf-section-title">{{ t('panel.http.headers') }}</div>
    <KeyValueRows :rows="headers" :key-placeholder="t('panel.http.key')" :value-placeholder="t('panel.http.value')" :add-label="t('panel.http.addHeader')" />
    <div v-if="!headers.length" class="wf-empty-hint">{{ t('panel.http.noHeaders') }}</div>

    <div class="wf-section-title">{{ t('panel.http.body') }}</div>
    <el-select :model-value="bodyType" size="small" style="width:100%;margin-bottom:6px" @update:model-value="setBodyType">
      <el-option v-for="item in BODY_TYPES" :key="item.value" :label="t(item.labelKey)" :value="item.value" />
    </el-select>
    <KeyValueRows
      v-if="bodyType === 'json' || bodyType === 'form-data'"
      :rows="bodyRows"
      :key-placeholder="t('panel.http.key')"
      :value-placeholder="t('panel.http.value')"
      :add-label="t('panel.http.addBodyField')"
    />
    <el-input
      v-else-if="bodyType === 'raw-text'"
      :model-value="rawBody"
      type="textarea"
      :rows="5"
      @update:model-value="setRawBody"
    />
    <div v-else-if="bodyType === 'none'" class="wf-empty-hint">{{ t('panel.http.noBody') }}</div>

    <div class="wf-section-title">{{ t('panel.http.auth') }}</div>
    <el-select :model-value="authType" size="small" style="width:100%;margin-bottom:6px" @update:model-value="setAuthType">
      <el-option :label="t('panel.http.authNone')" value="no-auth" />
      <el-option :label="t('panel.http.authApiKey')" value="api-key" />
    </el-select>
    <template v-if="authType === 'api-key'">
      <el-select :model-value="authConfig.type ?? 'bearer'" size="small" style="width:100%;margin-bottom:6px" @update:model-value="setAuthField('type', $event)">
        <el-option :label="t('panel.http.authBearer')" value="bearer" />
        <el-option :label="t('panel.http.authHeader')" value="header" />
      </el-select>
      <el-input
        v-if="authConfig.type === 'header'"
        :model-value="String(authConfig.header ?? '')"
        size="small"
        :placeholder="t('panel.http.authHeaderName')"
        style="margin-bottom:6px"
        @update:model-value="setAuthField('header', $event)"
      />
      <el-input
        :model-value="String(authConfig.api_key ?? '')"
        size="small"
        :placeholder="t('panel.http.authKey')"
        @update:model-value="setAuthField('api_key', $event)"
      />
    </template>

    <div class="wf-section-title">{{ t('panel.http.timeout') }}</div>
    <el-input-number
      :model-value="readTimeout"
      size="small"
      :min="1000"
      :step="1000"
      controls-position="right"
      style="width:100%"
      @update:model-value="setReadTimeout($event as number)"
    />
    <div class="wf-field__hint">{{ t('panel.http.timeoutHint') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import KeyValueRows from '../KeyValueRows.vue'
import type { NodePanelProps } from '../panelProps'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head']
const BODY_TYPES = [
  { value: 'none', labelKey: 'panel.http.bodyNone' },
  { value: 'json', labelKey: 'panel.http.bodyJson' },
  { value: 'form-data', labelKey: 'panel.http.bodyForm' },
  { value: 'raw-text', labelKey: 'panel.http.bodyRaw' },
]

interface Row { key?: string; value?: string }

const raw = computed(() => props.data as unknown as Record<string, any>)

const method = computed(() => String(raw.value.method ?? 'get'))
const url = computed(() => String(raw.value.url ?? ''))
const authType = computed(() => String(raw.value.authorization?.type ?? 'no-auth'))
const authConfig = computed<Record<string, any>>(() => raw.value.authorization?.config ?? {})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

const headers = computed<Row[]>(() => ensureRows('headers'))
const params = computed<Row[]>(() => ensureRows('params'))

function ensureRows(key: string): Row[] {
  if (!Array.isArray(raw.value[key])) raw.value[key] = []
  return raw.value[key] as Row[]
}

const bodyType = computed(() => String(raw.value.body?.type ?? 'none'))
const bodyRows = computed<Row[]>(() => {
  if (!raw.value.body || typeof raw.value.body !== 'object') raw.value.body = { type: 'none', data: [] }
  if (!Array.isArray(raw.value.body.data)) raw.value.body.data = []
  return raw.value.body.data as Row[]
})
const rawBody = computed(() => (typeof raw.value.body?.data === 'string' ? raw.value.body.data : ''))

function setBodyType(value: string): void {
  if (!raw.value.body || typeof raw.value.body !== 'object') raw.value.body = { type: 'none', data: [] }
  raw.value.body.type = value
  if (value === 'raw-text' && typeof raw.value.body.data !== 'string') raw.value.body.data = ''
  if ((value === 'json' || value === 'form-data') && !Array.isArray(raw.value.body.data)) raw.value.body.data = []
}

function setRawBody(value: string): void {
  setBodyType('raw-text')
  raw.value.body.data = value
}

function setAuthType(value: string): void {
  raw.value.authorization = { type: value, config: raw.value.authorization?.config ?? {} }
}

function setAuthField(key: string, value: unknown): void {
  if (!raw.value.authorization) raw.value.authorization = { type: 'api-key', config: {} }
  if (!raw.value.authorization.config) raw.value.authorization.config = {}
  raw.value.authorization.config[key] = value
}

const readTimeout = computed(() => Number(raw.value.timeout?.read ?? 30000))

/** 读写超时（毫秒）；用独立函数名，避免与全局 setTimeout 冲突 */
function setReadTimeout(value: number): void {
  if (!raw.value.timeout || typeof raw.value.timeout !== 'object') raw.value.timeout = {}
  raw.value.timeout.read = value
}
</script>
