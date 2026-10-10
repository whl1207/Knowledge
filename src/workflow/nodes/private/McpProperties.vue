<!-- src/workflow/nodes/private/McpProperties.vue -->
<!-- 本地扩展：MCP 工具（内联服务配置或引用设置里的服务） -->
<template>
  <div>
    <div class="wf-field">
      <div class="wf-field__label">{{ t('panel.mcp.mode') }}</div>
      <el-radio-group :model-value="mode" size="small" @update:model-value="setMode($event as string)">
        <el-radio-button value="server">{{ t('panel.mcp.modeServer') }}</el-radio-button>
        <el-radio-button value="inline">{{ t('panel.mcp.modeInline') }}</el-radio-button>
      </el-radio-group>
    </div>

    <template v-if="mode === 'server'">
      <div class="wf-field">
        <div class="wf-field__label">{{ t('panel.mcp.service') }}</div>
        <el-select :model-value="serverId" size="small" style="width:100%" :placeholder="t('panel.mcp.selectService')" @update:model-value="setServerId($event)">
          <el-option v-for="item in services" :key="item.id" :label="item.name || item.id" :value="item.id" />
        </el-select>
        <div v-if="!services.length" class="wf-field__error">{{ t('panel.mcp.noService') }}</div>
      </div>
    </template>

    <template v-else>
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
          <el-input :model-value="argsText" size="small" type="textarea" :rows="3" @update:model-value="setArgs" />
          <div class="wf-field__hint">{{ t('panel.tool.argsHint') }}</div>
        </div>
      </template>
      <div v-else class="wf-field">
        <div class="wf-field__label">{{ t('panel.tool.serverUrl') }}</div>
        <el-input :model-value="serverUrl" size="small" placeholder="http://127.0.0.1:3000/sse" @update:model-value="setServer('server_url', $event)" />
      </div>
    </template>

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
      @update:model-value="setParameters"
    />
    <div v-if="parametersError" class="wf-field__error">{{ parametersError }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElInput, ElOption, ElRadioButton, ElRadioGroup, ElSelect } from 'element-plus'
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
  if (!raw.value.mcp_server.mode) raw.value.mcp_server.mode = 'inline'
  return raw.value.mcp_server
})

const mode = computed(() => String(server.value.mode ?? 'inline'))
const serverId = computed(() => String(server.value.server_id ?? ''))
const transport = computed(() => String(server.value.transport ?? 'stdio'))
const command = computed(() => String(server.value.command ?? ''))
const serverUrl = computed(() => String(server.value.server_url ?? ''))
const toolName = computed(() => String(raw.value.tool_name ?? ''))
const services = computed<Array<{ id: string; name?: string }>>(() =>
  Array.isArray(store.mcpServers) ? (store.mcpServers as Array<{ id: string; name?: string }>) : [],
)

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

function setMode(value: string): void {
  server.value.mode = value
}

function setServerId(value: string): void {
  server.value.server_id = value
}

function setArgs(value: string): void {
  server.value.args = value.split('\n').map((line) => line.trim()).filter(Boolean)
}

const parametersText = ref<string | null>(null)
const parametersError = ref('')

function setParameters(value: string): void {
  parametersText.value = value
  try {
    raw.value.tool_parameters = value.trim() ? JSON.parse(value) : {}
    parametersError.value = ''
  } catch (error) {
    parametersError.value = `${t('panel.generic.invalidJson')}：${(error as Error).message}`
  }
}

const toolNames = ref<string[]>([])
const connecting = ref(false)
const toolError = ref('')

function currentServerConfig(): Record<string, any> {
  if (mode.value === 'server') {
    const configured = services.value.find((item) => item.id === serverId.value) as Record<string, any> | undefined
    if (!configured) return {}
    return {
      transport: configured.transport ?? 'stdio',
      command: configured.command,
      args: configured.args,
      env: configured.env,
      server_url: configured.serverUrl ?? configured.server_url,
    }
  }
  return { ...server.value }
}

async function loadTools(): Promise<void> {
  connecting.value = true
  toolError.value = ''
  const connKey = `wf-mcp-panel-${props.nodeId}`
  try {
    const config = currentServerConfig()
    const connected = await mcpManager.connect(connKey, config, mode.value === 'server' ? serverId.value : undefined)
    if (!connected) {
      toolError.value = t('panel.tool.connectFailed')
      return
    }
    const tools = await mcpManager.refreshTools(connKey, config, mode.value === 'server' ? serverId.value : undefined)
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
