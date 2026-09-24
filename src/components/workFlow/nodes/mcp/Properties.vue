<!-- nodes/mcp/Properties.vue -->
<template>
  <div class="mcp-node-properties">
    <!-- MCP连接状�?-->
    <div class="mcp-connection-status">
      <div class="property-row" style="margin-bottom: 10px;">
        <div class="property-label" style="width: 80px;">{{ t('connection_status') }}</div>
        <div class="property-input">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="status-indicator" :class="{ connected: node.mcpConnected }">
              <i class="fa" :class="node.mcpConnected ? 'fa-plug connected' : 'fa-unplug'"></i>
              <span>{{ node.mcpConnected ? t('connected') : t('disconnected') }}</span>
            </div>
            <div class="tool-count" v-if="node.mcpConnected && node.mcpTools">
              <i class="fa fa-wrench"></i>
              <span>{{ node.mcpTools.length }} {{ t('tools_available') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- MCP配置 -->
    <div class="property-group" style="margin-top: 10px; padding: 8px; background-color: rgba(0, 0, 0, 0.02); border-radius: 5px;">
      <h4 style="margin: 0 0 8px 0; font-size: 14px; display: flex; align-items: center; gap: 5px;">
        <i class="fa fa-cog"></i> {{ t('mcp_configuration') }}
      </h4>

      <!-- 使用方式：内联配置 / 引用设置中的服务 -->
      <div class="property-row">
        <label class="property-label">{{ t('mcp_mode') }}</label>
        <div class="property-input">
          <select v-model="mcpMode" @change="onModeChange">
            <option value="inline">{{ t('mcp_mode_inline') }}</option>
            <option value="server">{{ t('mcp_mode_server') }}</option>
          </select>
        </div>
      </div>

      <!-- 引用设置中的 MCP 服务 -->
      <div v-if="mcpMode === 'server'" class="property-row">
        <label class="property-label">{{ t('select_service') }}</label>
        <div class="property-input">
          <select v-model="mcpServerId" @change="onServerIdChange">
            <option value="">{{ t('select_service_placeholder') }}</option>
            <option v-for="s in availableServers" :key="s.id" :value="s.id">
              {{ s.name }} ({{ (s.transport || 'stdio').toUpperCase() }})
            </option>
          </select>
        </div>
      </div>
      <div v-if="mcpMode === 'server' && selectedServerDesc" class="code-help">
        <small>{{ selectedServerDesc }}</small>
      </div>
      <div v-if="mcpMode === 'server' && availableServers.length === 0" class="code-help" style="color: #F44336;">
        <small>{{ t('no_services_hint') }}</small>
      </div>

      <!-- 传输类型 -->
      <div class="property-row" v-if="mcpMode !== 'server'">
        <label class="property-label">{{ t('transport_type') }}</label>
        <div class="property-input">
          <select v-model="mcpTransport" @change="onTransportTypeChange">
            <option value="stdio">STDIO</option>
            <option value="sse">SSE</option>
            <option value="http">HTTP</option>
          </select>
        </div>
      </div>

      <!-- STDIO配置 -->
      <div v-if="mcpMode !== 'server' && node.mcpConfig?.transport === 'stdio'">
        <div class="property-row">
          <label class="property-label">{{ t('command') }}</label>
          <div class="property-input">
            <input 
              type="text" 
              v-model="mcpCommand" 
              :placeholder="t('command_placeholder')" 
            />
          </div>
        </div>
        <div class="property-row">
          <label class="property-label">{{ t('arguments') }}</label>
          <div class="property-input">
            <input 
              type="text" 
              v-model="mcpArgs" 
              :placeholder="t('args_placeholder')" 
            />
          </div>
        </div>
        <div class="code-help">
          <small>{{ t('stdio_help') }}</small>
        </div>
      </div>

      <!-- SSE/HTTP配置 -->
      <div v-if="mcpMode !== 'server' && (node.mcpConfig?.transport === 'sse' || node.mcpConfig?.transport === 'http')">
        <div class="property-row">
          <label class="property-label">{{ t('server_url') }}</label>
          <div class="property-input">
            <input type="text" v-model="mcpServerUrl" :placeholder="t('server_url_placeholder')" />
          </div>
        </div>
        <div class="code-help">
          <small>{{ t('server_url_help') }}</small>
        </div>
      </div>

      <!-- 环境变量 -->
      <div class="property-row" v-if="mcpMode !== 'server'">
        <label class="property-label">{{ t('environment_vars') }}</label>
        <div class="property-input">
          <textarea 
            v-model="mcpConfigEnv"
            rows="3" 
            placeholder='{"KEY1":"VALUE1","KEY2":"VALUE2"}'
            style="width: calc(100% - 8px); font-size: 11px;"
          ></textarea>
        </div>
      </div>

      <!-- 连接选项 -->
      <div class="property-row">
        <div class="property-label">{{ t('connection_options') }}</div>
        <div class="property-input">
          <div style="display: flex; align-items: center; gap: 10px;">
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px;">
              <input type="checkbox" v-model="mcpAutoConnect"/>
              {{ t('auto_connect') }}
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- 工具选择和测�?-->
    <div v-if="node.mcpConnected && node.mcpTools && node.mcpTools.length > 0" 
         class="property-group" style="margin-top: 10px; padding: 8px; background-color: rgba(0, 0, 0, 0.02); border-radius: 5px;">
      <h4 style="margin: 0 0 8px 0; font-size: 14px; display: flex; align-items: center; gap: 5px;">
        <i class="fa fa-wrench"></i> {{ t('tool_selection') }}
      </h4>

      <!-- 工具选择 -->
      <div class="property-row">
        <label class="property-label">{{ t('select_tool') }}</label>
        <div class="property-input">
          <select v-model="mcpSelectedTool" @change="onToolSelectionChange">
            <option value="">{{ t('select_tool_placeholder') }}</option>
            <option v-for="tool in node.mcpTools" :key="tool.name" :value="tool.name">
              {{ tool.name }}
            </option>
          </select>
        </div>
      </div>

      <!-- 选中工具的参数配�?-->
      <div v-if="node.mcpConfig?.selectedTool" class="property-row">
        <div class="property-input">
            <div class="tool-parameters">
            <div class="parameter-header">
                <i class="fa fa-cogs"></i>
                <span>{{ t('tool_parameters') }}</span>
            </div>
            <div class="parameter-fields">
                <!-- 动态参数输�?-->
                <div v-if="selectedToolInfo && selectedToolInfo.inputSchema" class="parameter-fields-scroll">
                <div v-for="(param, paramName) in (selectedToolInfo.inputSchema.properties as Record<string, any>)" :key="paramName" class="parameter-field">
                    <label>{{ paramName }}</label>
                    <div class="parameter-input">
                    <input 
                        type="text" 
                        :value="(node.mcpConfig && node.mcpConfig.toolArguments) ? node.mcpConfig.toolArguments[paramName] : ''"
                        @input="updateMcpToolArgument(paramName as string, ($event.target as HTMLInputElement).value)"
                        :placeholder="param.description || paramName"
                    />
                    </div>
                </div>
                </div>
                <div v-else class="no-schema-info">
                <i class="fa fa-info-circle"></i>
                <span>{{ t('no_schema_info') }}</span>
                </div>
            </div>
            </div>
        </div>
        </div>

      <!-- 工具按钮 -->
      <div class="property-row" style="margin-top: 10px;">
        <div class="property-input" style="display: flex; gap: 8px;">
          <button class="wf-btn primary small" @click="testMcpConnection" :disabled="!node.mcpConfig">
            <i class="fa fa-bolt"></i> {{ t('test_connection') }}
          </button>
          <button class="wf-btn primary small" @click="connectMcpNode" 
            :disabled="node.mcpConnected || !node.mcpConfig">
            <i class="fa fa-plug"></i> {{ t('connect') }}
          </button>
          <button class="wf-btn danger small" @click="disconnectMcpNode" :disabled="!node.mcpConnected">
            <i class="fa fa-unplug"></i> {{ t('disconnect') }}
          </button>
          <button class="wf-btn small" @click="refreshMcpTools" :disabled="!node.mcpConnected">
            <i class="fa fa-refresh"></i> {{ t('refresh_tools') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 连接按钮（当未连接时显示�?-->
    <div v-else class="property-group" style="margin-top: 10px; padding: 8px; background-color: rgba(0, 0, 0, 0.02); border-radius: 5px;">
      <h4 style="margin: 0 0 8px 0; font-size: 14px; display: flex; align-items: center; gap: 5px;">
        <i class="fa fa-wrench"></i> {{ t('tool_management') }}
      </h4>
      <div class="property-row">
        <div class="property-input" style="display: flex; gap: 8px;">
          <button class="wf-btn primary" @click="testMcpConnection" :disabled="!node.mcpConfig">
            <i class="fa fa-bolt"></i> {{ t('test_connection') }}
          </button>
          <button class="wf-btn primary" @click="connectMcpNode" 
            :disabled="node.mcpConnected || !node.mcpConfig">
            <i class="fa fa-plug"></i> {{ t('connect') }}
          </button>
        </div>
      </div>
    </div>

    <!-- MCP节点说明 -->
    <div class="code-help" style="margin-top: 10px;">
      <small>{{ t('mcp_node_help') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import type { NodeData, McpConfig } from '@/components/workFlow/WorkflowTypes'
import { usestore } from '@/store'

// 定义props
const props = defineProps<{
  node: NodeData
}>()

// 定义emits
const emit = defineEmits<{
  'update:node': [value: NodeData]
  'test-mcp-connection': [nodeId: number]
  'connect-mcp-node': [nodeId: number]
  'disconnect-mcp-node': [nodeId: number]
  'refresh-mcp-tools': [nodeId: number]
  'save': []
}>()

// 本地化函数（从父组件传入或独立定义）
const t = (key: string): string => {
  // 这里应该从父组件传入或使用独立的本地化逻辑
  // 简化版本，实际使用时应该传入或使用独立的本地化模块
  const localeDict: Record<string, string> = {
    'connection_status': '连接状态',
    'connected': '已连接',
    'disconnected': '未连接',
    'tools_available': '个工具可连接',
    'mcp_configuration': 'MCP配置',
    'transport_type': '传输类型',
    'command': '命令',
    'command_placeholder': '输入可执行文件路径',
    'arguments': '参数',
    'args_placeholder': '命令行参数，用空格分割',
    'environment_vars': '环境变量',
    'server_url': '服务器URL',
    'server_url_placeholder': 'http://localhost:3000',
    'connection_options': '连接选项',
    'auto_connect': '自动连接',
    'tool_selection': '工具选择',
    'select_tool': '选择工具',
    'select_tool_placeholder': '请选择工具',
    'tool_parameters': '工具参数',
    'test_connection': '测试连接',
    'refresh_tools': '刷新工具',
    'tool_management': '工具管理',
    'mcp_node_help': 'MCP节点支持连接到Model Context Protocol服务器，使用远程工具。支持STDIO、SSE和HTTP三种传输方式',
    'stdio_help': 'STDIO模式：直接执行本地命令，适合本地MCP服务',
    'server_url_help': 'SSE/HTTP模式：连接到远程MCP服务',
    'no_schema_info': '该工具未提供参数模式信息',
    'connect': '连接',
    'disconnect': '断开连接',
    'mcp_mode': '使用方式',
    'mcp_mode_inline': '内联配置（自定义工具）',
    'mcp_mode_server': '引用设置中的服务',
    'select_service': '选择服务',
    'select_service_placeholder': '请选择已配置的 MCP 服务',
    'selected_server': '服务',
    'no_services_hint': '设置中尚未配置 MCP 服务，请先在「设置 → MCP 服务」中添加'
  }
  return localeDict[key] || key
}

// 计算属�?
const selectedToolInfo = computed(() => {
  if (!props.node.mcpConfig?.selectedTool || !props.node.mcpTools) {
    return null
  }
  
  return props.node.mcpTools.find(tool => tool.name === props.node.mcpConfig!.selectedTool)
})

// 设置中配置的 MCP 服务（引用模式使用）
const store = usestore()
const availableServers = computed(() => (store.mcpServers || []).filter((s: any) => s && s.enabled !== false))

// 使用方式：内联配置 / 引用设置服务
const mcpMode = computed({
  get: () => props.node.mcpConfig?.mode || 'inline',
  set: (value: string) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.mode = value as 'inline' | 'server'
      emit('save')
    }
  }
})

const mcpServerId = computed({
  get: () => props.node.mcpConfig?.serverId || '',
  set: (value: string) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.serverId = value || undefined
      emit('save')
    }
  }
})

const selectedServerDesc = computed(() => {
  const s = availableServers.value.find(x => x.id === mcpServerId.value)
  if (!s) return ''
  return (s.transport === 'stdio' ? s.command : s.serverUrl) || s.name
})

// MCP配置的计算属�?
const mcpTransport = computed({
  get: () => props.node.mcpConfig?.transport || 'stdio',
  set: (value: string) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.transport = value as 'stdio' | 'sse' | 'http'
      emit('save')
    }
  }
})

const mcpCommand = computed({
  get: () => props.node.mcpConfig?.command || '',
  set: (value: string) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.command = value
      emit('save')
    }
  }
})

const mcpArgs = computed<string>({
  get: () => {
    const args = props.node.mcpConfig?.args
    if (Array.isArray(args)) {
      return args.join(' ')
    }
    return args || ''
  },
  set: (value: string) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.args = value.split(/\s+/).filter(arg => arg.trim())
      emit('save')
    }
  }
})

const mcpServerUrl = computed({
  get: () => props.node.mcpConfig?.serverUrl || '',
  set: (value: string) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.serverUrl = value
      emit('save')
    }
  }
})

const mcpConfigEnv = computed({
  get() {
    const env = props.node.mcpConfig?.env
    if (!env) return ''
    if (typeof env === 'string') return env
    return JSON.stringify(env, null, 2)
  },
  set(value: string) {
    if (!props.node.mcpConfig) return
    try {
      props.node.mcpConfig.env = JSON.parse(value)
    } catch {
      props.node.mcpConfig.env = value
    }
    emit('save')
  }
})

const mcpAutoConnect = computed({
  get: () => props.node.mcpConfig?.autoConnect ?? true,
  set: (value: boolean) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.autoConnect = value
      emit('save')
    }
  }
})

const mcpSelectedTool = computed({
  get: () => props.node.mcpConfig?.selectedTool || '',
  set: (value: string) => {
    if (props.node.mcpConfig) {
      props.node.mcpConfig.selectedTool = value
      // 清空工具参数
      props.node.mcpConfig.toolArguments = {}
      emit('save')
    }
  }
})

// 方法
const onModeChange = (): void => {
  if (!props.node.mcpConfig) return

  // 切换使用方式后重置连接状态与所选工具
  props.node.mcpConnected = false
  props.node.mcpTools = []
  props.node.mcpConfig.selectedTool = ''
  props.node.mcpConfig.toolArguments = {}
  if (props.node.mcpConfig.mode !== 'server') {
    props.node.mcpConfig.serverId = undefined
  }

  emit('save')
}

const onServerIdChange = (): void => {
  if (!props.node.mcpConfig) return

  // 更换引用服务后重置连接状态与所选工具
  props.node.mcpConnected = false
  props.node.mcpTools = []
  props.node.mcpConfig.selectedTool = ''
  props.node.mcpConfig.toolArguments = {}

  emit('save')
}

const onTransportTypeChange = (): void => {
  if (!props.node.mcpConfig) return
  
  const config = props.node.mcpConfig
  if (config.transport === 'stdio') {
    config.serverUrl = ''
  } else {
    config.command = ''
    config.args = ''
  }
  
  // 重置连接状�?
  props.node.mcpConnected = false
  props.node.mcpTools = []
  props.node.mcpConfig!.selectedTool = ''
  props.node.mcpConfig!.toolArguments = {}
  
  emit('save')
}

const onToolSelectionChange = (): void => {
  if (!props.node.mcpConfig) return
  
  // 清空工具参数
  props.node.mcpConfig.toolArguments = {}
  emit('save')
}

const updateMcpToolArgument = (paramName: string, value: string): void => {
  if (!props.node.mcpConfig) return

  if (!props.node.mcpConfig.toolArguments || typeof props.node.mcpConfig.toolArguments !== 'object') {
    props.node.mcpConfig.toolArguments = {}
  }

  props.node.mcpConfig.toolArguments[paramName] = value
  emit('save')
}

const testMcpConnection = (): void => {
  emit('test-mcp-connection', props.node.id)
}

const connectMcpNode = (): void => {
  emit('connect-mcp-node', props.node.id)
}

const disconnectMcpNode = (): void => {
  emit('disconnect-mcp-node', props.node.id)
}

const refreshMcpTools = (): void => {
  emit('refresh-mcp-tools', props.node.id)
}
</script>

<style scoped>
/* MCP相关样式 */
.mcp-connection-status .status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.mcp-connection-status .status-indicator.connected {
  background-color: rgba(76, 175, 80, 0.1);
  color: #4CAF50;
}

.mcp-connection-status .status-indicator:not(.connected) {
  background-color: rgba(158, 158, 158, 0.1);
  color: #757575;
}

.mcp-connection-status .tool-count {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.7;
}

.tool-parameters {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  overflow: hidden;
}

.tool-parameters .parameter-header {
  padding: 6px 10px;
  background-color: rgba(0, 0, 0, 0.03);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fontColor);
}

.tool-parameters .parameter-fields {
  padding: 8px;
}

.tool-parameters .parameter-fields-scroll {
  max-height: 150px;
  overflow-y: auto;
}

.tool-parameters .parameter-field {
  margin-bottom: 8px;
}

.tool-parameters .parameter-field label {
  display: block;
  margin-bottom: 3px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.8;
}

.tool-parameters .parameter-field .parameter-input input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
}

.tool-parameters .no-schema-info {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px;
  color: var(--fontColor);
  opacity: 0.6;
  font-size: 11px;
  justify-content: center;
}

.property-row {
  display: flex;
  flex-direction: row;
  gap: 5px;
  margin-bottom: 8px;
}

.property-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--fontColor);
  opacity: 0.9;
  width: 80px;
}

.property-input {
  flex: 1;
}

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

.property-btn.primary {
  background-color: var(--fontActiveColor);
  color: var(--backgroundColor);
}

.property-btn.primary:hover:not(:disabled) {
  background-color: var(--fontActiveColor);
  opacity: 0.9;
}

.property-btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.property-btn.danger {
  background-color: #f44336;
  color: white;
  flex: 0;
  padding: 10px 12px;
}

.property-btn.danger:hover {
  background-color: #d32f2f;
}

.property-btn.small {
  font-size: 11px;
  padding: 3px 6px;
  height: auto;
}

.property-group {
  margin-bottom: 5px;
  border-bottom: 1px solid var(--borderColor);
}

.code-help {
  margin-top: 8px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.7;
}
</style>

