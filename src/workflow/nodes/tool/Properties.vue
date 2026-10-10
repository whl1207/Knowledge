<!-- src/workflow/nodes/tool/Properties.vue -->
<!-- 工具节点：本地通过 MCP 服务执行（填服务配置 + 工具名 + 参数） -->
<template>
  <div>
    <div class="wf-field__hint" style="margin-bottom:10px">{{ t('panel.tool.hint') }}</div>

    <div class="wf-section-title">{{ t('panel.tool.server') }}</div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.tool.transport') }}</div>
      <el-select :model-value="transport" size="small" style="width:100%" @update:model-value="setServer('transport', $event)">
        <el-option label="stdio" value="stdio" />
        <el-option label="sse" value="sse" />
        <el-option label="http" value="http" />
      </el-select>
    </div>

    <template v-if="transport === 'stdio'">
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.tool.command') }}</div>
        <el-input :model-value="command" size="small" placeholder="npx" @update:model-value="setServer('command', $event)" />
      </div>
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.tool.args') }}</div>
        <el-input
          :model-value="argsText"
          size="small"
          type="textarea"
          :rows="2"
          placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;D:\data"
          @update:model-value="setArgs"
        />
        <div class="wf-field__hint">{{ t('panel.tool.argsHint') }}</div>
      </div>
    </template>
    <div v-else class="wf-field">
      <div class="wf-field__label">{{ t('panel.tool.serverUrl') }}</div>
      <el-input :model-value="serverUrl" size="small" placeholder="http://127.0.0.1:3000/sse" @update:model-value="setServer('server_url', $event)" />
    </div>

    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.tool.toolName') }}</div>
      <div class="wf-inline wf-inline--full">
        <el-select
          :model-value="toolName"
          size="small"
          filterable
          allow-create
          default-first-option
          style="flex:1"
          :placeholder="t('panel.tool.toolNamePlaceholder')"
          @update:model-value="set('tool_name', $event)"
        >
          <el-option v-for="name in toolNames" :key="name" :label="name" :value="name" />
        </el-select>
        <button class="wf-btn" :disabled="connecting" @click="loadTools">
          {{ connecting ? t('panel.tool.loading') : t('panel.tool.loadTools') }}
        </button>
      </div>
      <div v-if="toolError" class="wf-field__error">{{ toolError }}</div>
    </div>

    <div class="wf-section-title">{{ t('panel.tool.parameters') }}</div>
    <div class="wf-field__hint" style="margin-bottom:6px">{{ t('panel.tool.parametersHint') }}</div>
    <el-input
      :model-value="parametersText"
      type="textarea"
      :rows="6"
      class="wf-code"
      placeholder="{&#10;  &quot;path&quot;: &quot;{{#节点.变量#}}&quot;&#10;}"
      @update:model-value="setParameters"
    />
    <div v-if="parametersError" class="wf-field__error">{{ parametersError }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElInput, ElOption, ElSelect } from 'element-plus'
import { usestore } from '@/store'
import { createFlowT } from '@/workflow/ui/locales'
import { mcpManager } from '@/platform/mcpManager'
import type { NodePanelProps } from '../panelProps'

const props = defineProps<NodePanelProps>()
const store = usestore()
const t = createFlowT(store.locales || 'zh')

const raw = computed(() => props.data as unknown as Record<string, any>)

const server = computed<Record<string, any>>(() => {
  if (!raw.value.mcp_server || typeof raw.value.mcp_server !== 'object') {
    raw.value.mcp_server = { mode: 'inline', transport: 'stdio' }
  }
  return raw.value.mcp_server
})

const transport = computed(() => String(server.value.transport ?? 'stdio'))
const command = computed(() => String(server.value.command ?? ''))
const serverUrl = computed(() => String(server.value.server_url ?? ''))
const toolName = computed(() => String(raw.value.tool_name ?? ''))
const argsText = computed(() => {
  const value = server.value.args
  if (Array.isArray(value)) return value.join('\n')
  return String(value ?? '')
})

function set(key: string, value: unknown): void {
  raw.value[key] = value
}

function setServer(key: string, value: unknown): void {
  server.value[key] = value
}

/** 参数框：命令行式多行 → 数组 */
function setArgs(value: string): void {
  const rows = value.split('\n').map((line) => line.trim()).filter(Boolean)
  server.value.args = rows
}

/** 参数对象用 JSON 编辑（值可以是字面量或 {{#节点.变量#}} 变量模板） */
const parametersText = ref<string | null>(null)
const parametersError = ref('')

function parametersJson(): string {
  if (parametersText.value !== null) return parametersText.value
  try {
    return JSON.stringify(raw.value.tool_parameters ?? {}, null, 2)
  } catch {
    return '{}'
  }
}

function setParameters(value: string): void {
  parametersText.value = value
  try {
    raw.value.tool_parameters = value.trim() ? JSON.parse(value) : {}
    parametersError.value = ''
  } catch (error) {
    parametersError.value = `${t('panel.generic.invalidJson')}：${(error as Error).message}`
  }
}

// ── 连接 MCP 服务并列出工具（便于从下拉里选）──
const toolNames = ref<string[]>([])
const connecting = ref(false)
const toolError = ref('')

async function loadTools(): Promise<void> {
  connecting.value = true
  toolError.value = ''
  const connKey = `wf-tool-panel-${props.nodeId}`
  try {
    const config = { ...server.value }
    const connected = await mcpManager.connect(connKey, config)
    if (!connected) {
      toolError.value = t('panel.tool.connectFailed')
      return
    }
    const tools = await mcpManager.refreshTools(connKey, config)
    toolNames.value = tools.map((tool) => tool.name)
    if (!toolNames.value.length) toolError.value = t('panel.tool.noTools')
  } catch (error) {
    toolError.value = `${t('panel.tool.connectFailed')}：${(error as Error).message}`
  } finally {
    connecting.value = false
    await mcpManager.disconnect(connKey).catch(() => {})
  }
}
</script>

<style scoped>
.wf-code :deep(textarea) {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}
</style>
