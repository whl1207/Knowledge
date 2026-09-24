<!-- src/components/set/McpSettings.vue
     设置页 · MCP 服务管理
     左右布局（参照 AgentPreset contact-sidebar / SkillManagement 技能列表）：
       左侧 = MCP 服务导航栏（每项显示启用开关 + 连接状态 + 传输徽标）
       右侧 = 选中服务的「配置（可直接编辑自动保存）/ 函数(工具) / 说明」，
              连接/断开、测试、刷新、删除均为右上角图标按钮（title 说明）
     服务器配置持久化到 store.mcpServers（localStorage），运行时由主进程 mcp-service 承载，
     本组件通过 mcpManager（IPC 桥）完成连接 / 测试 / 工具查询。 -->
<template>
  <div class="mcp-settings">
    <!-- ===================== 左侧：MCP 服务导航（开关 + 状态） ===================== -->
    <aside class="mcp-sidebar">
      <div class="mcp-toolbar">
        <button class="toolbar-action-btn mcp-add-btn" @click="newServer" :title="zh ? '新增 MCP 服务' : 'Add MCP server'">
          <i class="fa fa-plus"></i><span>{{ zh ? '新增服务' : 'Add Server' }}</span>
        </button>
        <button
          class="toolbar-action-btn"
          @click="refreshAllStatus"
          :disabled="refreshing"
          :title="zh ? '刷新全部服务连接状态' : 'Refresh connection status'"
        >
          <i class="fa" :class="refreshing ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
        </button>
      </div>
      <div class="mcp-nav-list">
        <div v-if="servers.length === 0" class="mcp-empty">
          <i class="fa fa-plug" style="font-size:22px;"></i>
          <span>{{ zh ? '尚未配置 MCP 服务，点击上方「新增服务」创建。' : 'No MCP servers yet. Click "Add Server" to create one.' }}</span>
        </div>
        <div
          v-for="s in servers"
          :key="s.id"
          class="mcp-nav-item"
          :class="{ active: selectedId === s.id, disabled: !isEnabled(s) }"
          @click="selectServer(s.id)"
          :title="s.transport === 'stdio' ? (s.command || '') + (s.args ? ' ' + argsText(s) : '') : s.serverUrl"
        >
          <div class="mcp-nav-top">
            <span class="mcp-nav-icon" :class="{ on: isConnected(s.id) }">
              <i :class="statusIcon(s.id)"></i>
            </span>
            <span class="mcp-nav-name">{{ s.name || (zh ? '未命名' : 'Unnamed') }}</span>
            <span
              class="mcp-nav-toggle"
              :class="{ on: isEnabled(s) }"
              :title="isEnabled(s) ? (zh ? '点击禁用（不连接、不注入工具）' : 'Click to disable') : (zh ? '点击启用' : 'Click to enable')"
              @click.stop="toggleEnabled(s)"
            >
              <span class="toggle-knob"></span>
            </span>
          </div>
          <div class="mcp-nav-meta">
            <span class="mcp-nav-status">
              <i :class="'mcp-status-dot dot-' + statusOf(s.id)"></i>
              {{ statusText(s.id) }}
            </span>
            <span class="mcp-nav-badge">{{ badgeOf(s) }}</span>
            <span v-if="toolsOf(s.id).length" class="mcp-nav-tools">
              <i class="fa fa-wrench"></i>{{ toolsOf(s.id).length }}
            </span>
          </div>
        </div>
      </div>
    </aside>

    <!-- ===================== 右侧：配置 / 按钮 / 函数 / 说明 ===================== -->
    <section class="mcp-content scoll">
      <!-- ── 查看 / 编辑详情（选中服务；配置可直接编辑自动保存） ── -->
      <template v-if="selected">
        <!-- 标题：名称 + 徽标 + 状态（右：启用开关 + 连接/测试/刷新/删除 图标按钮） -->
        <div class="mcp-pane-head">
          <div class="mcp-pane-head-left">
            <span class="mcp-pane-name">{{ selected.name || (zh ? '未命名' : 'Unnamed') }}</span>
            <span class="mcp-nav-badge">{{ badgeOf(selected) }}</span>
            <span class="mcp-status-pill" :class="'mcp-status-' + statusOf(selected.id)">
              <i :class="statusIcon(selected.id)"></i>{{ statusText(selected.id) }}
            </span>
            <span
              class="mcp-conn-chip"
              :class="{ manual: selected.autoConnect === false }"
              :title="zh ? '连接类型：启动时自动连接 / 手动连接' : 'Connect mode: auto-connect at startup / manual'"
            >
              <i class="fa" :class="selected.autoConnect !== false ? 'fa-bolt' : 'fa-mouse-pointer'"></i>
              {{ selected.autoConnect !== false ? (zh ? '自动连接' : 'Auto') : (zh ? '手动连接' : 'Manual') }}
            </span>
          </div>
          <div class="mcp-pane-head-actions">
            <!-- 启用开关 -->
            <span
              class="mcp-toggle on-off"
              :class="{ on: isEnabled(selected) }"
              :title="isEnabled(selected) ? (zh ? '已启用，点击禁用（不连接、不注入工具）' : 'Enabled, click to disable') : (zh ? '已禁用，点击启用' : 'Disabled, click to enable')"
              @click="toggleEnabled(selected)"
            >
              <span class="toggle-knob"></span>
            </span>
            <!-- 自动连接（置于右上角，界面更紧凑） -->
            <label class="mcp-auto-check" :title="zh ? '启动软件时自动连接该服务' : 'Auto connect this server at startup'">
              <input type="checkbox" v-model="autoConnectVal" />
              <span>{{ zh ? '自动连接' : 'Auto connect' }}</span>
            </label>
            <span class="mcp-head-divider"></span>
            <div class="mcp-head-btns">
              <!-- 连接 / 断开 -->
              <button
                class="head-btn"
                :class="{ on: isConnected(selected.id) }"
                :disabled="testingId === selected.id"
                @click="toggleConnect(selected)"
                :title="isConnected(selected.id) ? (zh ? '断开连接' : 'Disconnect') : (zh ? '连接服务' : 'Connect')"
              >
                <i class="fa" :class="testingId === selected.id ? 'fa-spinner fa-spin' : (isConnected(selected.id) ? 'fa-power-off' : 'fa-plug')"></i>
              </button>
              <!-- 测试连接 -->
              <button
                class="head-btn"
                :disabled="testingId === selected.id"
                @click="testServer(selected)"
                :title="zh ? '测试连接（临时连接，发现可用函数）' : 'Test connection (temporary, discover tools)'"
              >
                <i class="fa" :class="testingId === selected.id ? 'fa-spinner fa-spin' : 'fa-bolt'"></i>
              </button>
              <!-- 刷新函数 -->
              <button
                class="head-btn"
                :disabled="testingId === selected.id || !isConnected(selected.id)"
                @click="refreshTools(selected)"
                :title="zh ? '刷新函数（重新拉取工具列表）' : 'Refresh tools'"
              >
                <i class="fa fa-refresh"></i>
              </button>
              <!-- 删除（内置服务不可删除） -->
              <button v-if="!selected.builtin" class="head-btn danger" @click="removeServer(selected)" :title="zh ? '删除此服务' : 'Delete this server'">
                <i class="fa fa-trash"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- ③ 配置（详情内直接编辑，改动自动保存；JSON 字段失焦后提交） -->
        <div class="mcp-group">
          <div class="mcp-group-title">
            <i class="fa fa-cog"></i><span>{{ zh ? '配置' : 'Configuration' }}</span>
            <span class="mcp-group-note">{{ zh ? '修改自动保存' : 'Auto-saved' }}</span>
          </div>
          <div class="mcp-edit-form">
            <!-- 名称 + 传输类型同排：名称输入框右侧紧跟传输下拉框 -->
            <div class="form-group mcp-name-row">
              <label>{{ zh ? '名称' : 'Name' }}</label>
              <input v-model="nameText" :placeholder="zh ? '例如：filesystem' : 'e.g. filesystem'" />
              <select v-model="transportVal" class="mcp-transport-sel" :title="zh ? '传输类型' : 'Transport'">
                <option value="stdio">{{ zh ? 'STDIO（本地）' : 'STDIO (local)' }}</option>
                <option value="sse">{{ zh ? 'SSE（远程）' : 'SSE (remote)' }}</option>
                <option value="http">{{ zh ? 'HTTP（远程）' : 'HTTP (remote)' }}</option>
              </select>
            </div>
            <!-- 调用超时（单次工具调用等待上限；留空 = 默认 60 秒） -->
            <div class="form-group">
              <label>{{ zh ? '调用超时（秒）' : 'Call timeout (s)' }}</label>
              <input
                v-model="timeoutSecText"
                type="number"
                min="1"
                :placeholder="zh ? '留空 = 默认 60' : 'empty = default 60'"
                :title="zh ? '单次 MCP 工具调用的等待上限；网页加载、大文件读写等慢服务可调大，留空使用默认 60 秒' : 'Max wait per MCP tool call; raise it for slow services (page loads, large files). Empty = default 60 s'"
              />
            </div>
            <template v-if="selected.transport === 'stdio'">
              <div class="form-group">
                <label>{{ zh ? '命令 command' : 'Command' }}</label>
                <input v-model="commandText" :placeholder="zh ? '例如：npx' : 'e.g. npx'" />
              </div>
              <div class="form-group">
                <label>{{ zh ? '参数 args' : 'Arguments' }}</label>
                <input v-model="argsEditText" :placeholder="zh ? '例如：-y @modelcontextprotocol/server-filesystem /path' : 'e.g. -y @modelcontextprotocol/server-filesystem /path'" />
              </div>
              <div class="form-group form-group-top">
                <label>{{ zh ? '环境变量 env (JSON)' : 'Env vars (JSON)' }}</label>
                <textarea v-model="envRaw" rows="7" placeholder='{"KEY":"VALUE"}' :title="envFieldTip" @change="commitJsonField('env')"></textarea>
              </div>
            </template>
            <template v-else>
              <div class="form-group">
                <label>{{ zh ? '服务器 URL' : 'Server URL' }}</label>
                <input v-model="serverUrlText" placeholder="https://example.com/mcp" />
              </div>
              <div class="form-group form-group-top">
                <label>{{ zh ? '请求头 headers (JSON)' : 'Headers (JSON)' }}</label>
                <textarea v-model="headersRaw" rows="7" placeholder='{"Authorization":"Bearer ..."}' :title="headersFieldTip" @change="commitJsonField('headers')"></textarea>
              </div>
            </template>
          </div>
        </div>

        <!-- ④ 函数（工具） -->
        <div class="mcp-group">
          <div class="mcp-group-title">
            <i class="fa fa-wrench"></i><span>{{ zh ? '函数 / 工具' : 'Tools' }}</span>
            <span v-if="toolsOf(selected.id).length" class="mcp-group-count">{{ toolsOf(selected.id).length }}</span>
          </div>
          <div v-if="!isConnected(selected.id)" class="mcp-tools-hint mcp-pad-hint">
            <i class="fa fa-info-circle"></i>
            {{ zh ? '服务未连接：先点右上角「连接服务」或「测试连接」，即可发现该服务暴露的函数。' : 'Not connected: click the top-right "Connect" or "Test" to discover this server\'s tools.' }}
          </div>
          <div v-else-if="toolsOf(selected.id).length === 0" class="mcp-tools-hint mcp-pad-hint">
            <i class="fa fa-info-circle"></i>
            {{ zh ? '已连接，但未发现任何函数（可点右上角「刷新函数」重试）。' : 'Connected but no tools found (try top-right "Refresh tools").' }}
          </div>
          <div v-else class="mcp-tool-list">
            <div v-for="tool in toolsOf(selected.id)" :key="tool.name" class="mcp-tool" :title="tool.name">
              <span class="mcp-tool-name">{{ tool.name }}</span>
              <span class="mcp-tool-desc">{{ tool.description || (zh ? '（无描述）' : '(no description)') }}</span>
            </div>
          </div>
        </div>

        <!-- ⑤ 说明 -->
        <div class="mcp-group">
          <div class="mcp-group-title">
            <i class="fa fa-question-circle-o"></i><span>{{ zh ? '说明' : 'About' }}</span>
          </div>
          <!-- 内置服务：对外 HTTP 暴露开关 -->
          <div v-if="selected.builtin" class="mcp-expose-bar">
            <span class="mcp-expose-label"><i class="fa fa-globe"></i>{{ zh ? '对外 HTTP 暴露' : 'External HTTP' }}</span>
            <span
              class="mcp-nav-toggle"
              :class="{ on: isExposeOn(selected.id) }"
              :title="isExposeOn(selected.id) ? (zh ? '关闭对外暴露（其他软件将无法连接该端点）' : 'Disable external access') : (zh ? '开启对外暴露（其他软件可通过下方地址连接）' : 'Enable external access')"
              @click="toggleExpose(selected.id)"
            >
              <span class="toggle-knob"></span>
            </span>
            <span class="mcp-expose-state" :class="{ off: !isExposeOn(selected.id) }">
              {{ isExposeOn(selected.id) ? (zh ? '已开启' : 'On') : (zh ? '已关闭' : 'Off') }}
            </span>
          </div>
          <ul class="mcp-doc-list">
            <li v-for="(line, i) in docLines" :key="i">{{ line }}</li>
          </ul>
        </div>
      </template>

      <!-- ── 未选择 ── -->
      <div v-else class="mcp-content-empty">
        <i class="fa fa-plug" style="font-size:30px;"></i>
        <span>{{ zh ? '从左侧选择一个 MCP 服务，查看并管理其配置 / 连接 / 函数。' : 'Select an MCP server from the left to manage its config, connection and tools.' }}</span>
        <button class="button primary" @click="newServer"><i class="fa fa-plus"></i>{{ zh ? '新增服务' : 'Add Server' }}</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { usestore } from '@/store'
import { ElMessage, ElMessageBox } from 'element-plus'
import { mcpManager } from '@/platform/mcpManager'
import type { McpServerConfig, McpTool } from '@/types/mcp'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

// 徽标：内置本地服务（如浏览器 Agent）显示 LOCAL，否则显示传输类型大写
const badgeOf = (s: McpServerConfig | undefined): string =>
  s?.builtin ? 'LOCAL' : (s?.transport || 'stdio').toUpperCase()

// ===================== 服务列表 / 选中 =====================
// 服务器列表（直接引用 store，保证与工作流共享）
const servers = computed(() => store.mcpServers)

const selectedId = ref<string | null>(null)
const selected = computed<McpServerConfig | undefined>(() =>
  servers.value.find(s => s.id === selectedId.value)
)

const selectServer = (id: string) => {
  if (selectedId.value !== id) {
    selectedId.value = id
  }
}

// 当外部删除了当前选中服务时回退到列表第一项
watch(
  () => servers.value.map(s => s.id).join(','),
  () => {
    if (!selected.value && servers.value.length) {
      selectedId.value = servers.value[0].id
    }
  }
)

// ===================== 运行状态（连接 / 工具缓存） =====================
interface McpUiStatus {
  status: string
  tools: McpTool[]
}
const statusMap = reactive<Record<string, McpUiStatus>>({})

const testingId = ref<string | null>(null)
const refreshing = ref(false)

const statusOf = (id: string): string => statusMap[id]?.status || 'disconnected'
const toolsOf = (id: string): McpTool[] => statusMap[id]?.tools || []
const isConnected = (id: string): boolean => statusOf(id) === 'connected'
const statusIcon = (id: string): string => {
  const s = statusOf(id)
  if (s === 'connected') return 'fa fa-check-circle'
  if (s === 'connecting') return 'fa fa-spinner fa-spin'
  if (s === 'error') return 'fa fa-exclamation-circle'
  return 'fa fa-circle-o'
}
const statusText = (id: string): string => {
  const s = statusOf(id)
  if (s === 'connected') return zh.value ? '已连接' : 'Connected'
  if (s === 'connecting') return zh.value ? '连接中' : 'Connecting'
  if (s === 'error') return zh.value ? '连接失败' : 'Error'
  return zh.value ? '未连接' : 'Disconnected'
}
const argsText = (s: McpServerConfig): string =>
  Array.isArray(s.args) ? s.args.join(' ') : s.args || ''

const updateStatus = (id: string, status: string, tools?: McpTool[]) => {
  const cur = statusMap[id] || { status: 'disconnected', tools: [] }
  statusMap[id] = { status, tools: tools || cur.tools }
}

// 主进程状态广播监听
const onStatusChanged = (_e: any, payload: any) => {
  if (!payload?.serverId) return
  updateStatus(payload.serverId, payload.status, payload.tools)
}

// 逐个服务查询并恢复状态（供挂载 / 左侧刷新按钮）
const refreshAllStatus = async () => {
  refreshing.value = true
  for (const s of servers.value) {
    try {
      const r = await mcpManager.queryStatus(s.id)
      if (r.connected) {
        const tools = await mcpManager.refreshTools(s.id, s, s.id)
        updateStatus(s.id, 'connected', tools || [])
      } else {
        updateStatus(s.id, 'disconnected')
      }
    } catch {
      updateStatus(s.id, 'disconnected')
    }
  }
  refreshing.value = false
}

// ===================== 连接 / 测试 / 刷新工具 =====================
const toggleConnect = async (s: McpServerConfig) => {
  if (isConnected(s.id)) {
    await mcpManager.disconnect(s.id, s.id)
    updateStatus(s.id, 'disconnected')
    return
  }
  testingId.value = s.id
  const ok = await mcpManager.connect(s.id, s, s.id)
  testingId.value = null
  if (ok) {
    updateStatus(s.id, 'connected', mcpManager.getTools(s.id, s.id))
    ElMessage.success(zh.value ? `「${s.name}」连接成功` : `Connected: ${s.name}`)
  } else {
    updateStatus(s.id, 'error')
    ElMessage.error(zh.value ? `「${s.name}」连接失败` : `Failed to connect: ${s.name}`)
  }
}

const testServer = async (s: McpServerConfig) => {
  testingId.value = s.id
  const res = await mcpManager.testConnection(s)
  testingId.value = null
  if (res.success) {
    updateStatus(s.id, isConnected(s.id) ? 'connected' : 'disconnected', res.tools || [])
    ElMessage.success(zh.value ? '连接测试成功，发现 ' + (res.tools?.length || 0) + ' 个函数' : `Test OK, ${res.tools?.length || 0} tools found`)
  } else {
    ElMessage.error(zh.value ? '测试失败: ' + (res.error || '') : 'Test failed: ' + (res.error || ''))
  }
}

const refreshTools = async (s: McpServerConfig) => {
  if (!isConnected(s.id)) {
    const ok = await mcpManager.connect(s.id, s, s.id)
    if (!ok) return
  }
  testingId.value = s.id
  const tools = await mcpManager.refreshTools(s.id, s, s.id)
  testingId.value = null
  updateStatus(s.id, 'connected', tools)
}

// 函数（工具）说明：随连接后与函数名同行直接展示，无需展开// ===================== 启用开关 =====================
const isEnabled = (s: McpServerConfig): boolean => s.enabled !== false

const toggleEnabled = (s: McpServerConfig) => {
  const next = !isEnabled(s)
  store.updateMcpServer(s.id, { enabled: next })
  if (!next && isConnected(s.id)) {
    mcpManager.disconnect(s.id, s.id)
    updateStatus(s.id, 'disconnected')
  }
  ElMessage.success(next
    ? (zh.value ? `「${s.name}」已启用` : `Enabled: ${s.name}`)
    : (zh.value ? `「${s.name}」已禁用` : `Disabled: ${s.name}`))
}

// ===================== 删除 =====================
const removeServer = async (s: McpServerConfig) => {
  // 内置服务（如浏览器 Agent）不可删除：防止误删后无法恢复 / 浏览器工具失效
  if (s.builtin) {
    ElMessage.info(zh.value ? '内置服务不可删除（可关闭启用开关，或仅编辑其配置）' : 'Built-in server cannot be deleted (disable it with the toggle, or edit its config)')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh.value ? `确定删除 MCP 服务「${s.name}」吗？` : `Delete MCP server "${s.name}"?`,
      zh.value ? '删除确认' : 'Confirm',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '删除' : 'Delete',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      }
    )
  } catch {
    return
  }
  await mcpManager.disconnect(s.id, s.id)
  store.removeMcpServer(s.id)
  delete statusMap[s.id]
  if (selectedId.value === s.id) {
    selectedId.value = servers.value.length ? servers.value[0].id : null
  }
  ElMessage.success(zh.value ? '已删除' : 'Deleted')
}

// ===================== 新增 =====================
const newServer = () => {
  const server = store.addMcpServer({
    name: zh.value ? '新服务' : 'New Server',
    transport: 'stdio',
    autoConnect: true,
  })
  selectedId.value = server.id
  ElMessage.success(zh.value ? '已创建，请在右侧编辑配置' : 'Created, edit config on the right')
}

// ===================== 配置：详情内直接编辑（自动保存） =====================
// 保存单个字段：updateMcpServer 会合并 patch 并立即持久化（不替换对象引用）
const patchSelected = (patch: Partial<McpServerConfig>) => {
  const s = selected.value
  if (s) store.updateMcpServer(s.id, patch)
}

// 标量字段：改动即存
const nameText = computed<string>({
  get: () => selected.value?.name ?? '',
  set: (v: string) => patchSelected({ name: v })
})
const transportVal = computed<string>({
  get: () => selected.value?.transport ?? 'stdio',
  set: (v: string) => patchSelected({ transport: v as McpServerConfig['transport'] })
})
const commandText = computed<string>({
  get: () => selected.value?.command ?? '',
  set: (v: string) => patchSelected({ command: v })
})
const serverUrlText = computed<string>({
  get: () => selected.value?.serverUrl ?? '',
  set: (v: string) => patchSelected({ serverUrl: v })
})
const argsEditText = computed<string>({
  get: () => (selected.value ? argsText(selected.value) : ''),
  set: (v: string) => patchSelected({ args: v.split(/\s+/).filter(Boolean) })
})
const autoConnectVal = computed<boolean>({
  get: () => selected.value?.autoConnect !== false,
  set: (v: boolean) => patchSelected({ autoConnect: v })
})
// 调用超时（秒，留空 = 默认 60 秒；存储为毫秒）
const timeoutSecText = computed<string>({
  get: () => {
    const ms = Number(selected.value?.timeoutMs)
    return Number.isFinite(ms) && ms > 0 ? String(Math.round(ms / 1000)) : ''
  },
  set: (v: string) => {
    const sec = Number(String(v).trim())
    patchSelected({ timeoutMs: Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : undefined })
  }
})

// JSON 输入框的悬停说明（仅 title 提示，界面不直接显示说明行）
const envFieldTip = computed<string>(() => zh.value
  ? 'STDIO：启动本地命令进程并双向通信（需本机已装 node / python 等运行时）。示例：command = npx，args = -y @modelcontextprotocol/server-filesystem C:\\data。环境变量可传 API Key。'
  : 'STDIO: spawns a local command process (requires node/python etc.). e.g. command = npx, args = -y @modelcontextprotocol/server-filesystem C:\\data. env may carry API keys.')
const headersFieldTip = computed<string>(() => zh.value
  ? '远程：serverUrl 指向支持 MCP 的 HTTP 端点（SSE 或 Streamable HTTP），如需鉴权在 headers 填写，例如 Authorization: Bearer <token>。'
  : 'Remote: serverUrl points to an MCP-capable HTTP endpoint (SSE or Streamable HTTP); put auth in headers, e.g. Authorization: Bearer <token>.')

// JSON 字段（env / headers）：本地文本编辑，失焦（@change）时解析并保存
const envRaw = ref('')
const headersRaw = ref('')
watch(
  () => selected.value?.id,
  () => {
    const s = selected.value
    envRaw.value = s ? JSON.stringify(s.env || {}, null, 2) : ''
    headersRaw.value = s ? JSON.stringify(s.headers || {}, null, 2) : ''
  },
  { immediate: true }
)
const commitJsonField = (kind: 'env' | 'headers') => {
  const s = selected.value
  if (!s) return
  const raw = kind === 'env' ? envRaw.value : headersRaw.value
  try {
    const val = raw.trim() ? JSON.parse(raw) : {}
    if (kind === 'env') {
      patchSelected({ env: val })
    } else {
      patchSelected({ headers: val })
    }
  } catch {
    ElMessage.warning(zh.value
      ? (kind === 'env' ? '环境变量' : '请求头') + '格式不是合法 JSON，已保留当前文本待修改'
      : (kind === 'env' ? 'env' : 'headers') + ' is not valid JSON; kept as-is for editing')
  }
}

// ===================== PostgreSQL 内置服务：连接配置指引 =====================
function pushPostgresLines(lines: string[], zhLang: boolean) {
  if (zhLang) {
    lines.push('【PostgreSQL 查询 · 连接配置】在「配置 → 环境变量 env」里填库连接信息（JSON），改完点右上角「连接服务」生效：')
    lines.push('{"PGHOST":"127.0.0.1","PGPORT":"5432","PGDATABASE":"openalex","PGUSER":"aikm_ro","PGPASSWORD":"密码"}')
    lines.push('也可只填一条连接串：{"PG_MCP_CONNECTION_STRING":"postgresql://user:pwd@host:5432/db"}；远程库需要 SSL 时加 "PGSSL":"true"。')
    lines.push('可选调参：PG_MCP_MAX_ROWS 默认返回行数（默认 50 / 上限 500）、PG_MCP_STATEMENT_TIMEOUT_MS 语句超时，单位毫秒（默认 30000 = 30 秒；大库人名/模糊检索建议 180000）、PG_MCP_SCHEMA 显式指定 schema（不填则自动把唯一的用户 schema 设为 search_path）。')
    lines.push('作者消歧提速：PG_MCP_RESOLVE_CONCURRENCY 消歧并发上限（1–8；不填时检测到姓名索引自动用 4、否则串行 1）、PG_MCP_INDEX_PLANS 每条姓名用的前缀计划数（默认 4）、PG_MCP_FORCE_NAME_SCAN=1 强制全表扫（精度优先，排查用）。')
    lines.push('想让人名检索快起来：在数据库侧建一条姓名表达式索引即可（只读账号建不了，需库管理员执行），建好后本服务会自动走索引快路（单次消歧从 15–20 秒降到毫秒级）：CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authors_norm_name_pattern ON <schema>.authors (translate(lower(display_name), \'.\', \' \') text_pattern_ops); —— 当前库是否已检测到索引、以及可复制执行的完整语句，看 pg_status 的输出。')
    lines.push('七个只读工具：pg_resolve_author（作者消歧：人名 + 可选机构 → 候选/机构历史/代表作/分档）、pg_status（连通性自检）、pg_list_schemas、pg_list_tables、pg_describe_table、pg_sample_rows、pg_query（只读 SQL，自动补 LIMIT）。服务端强制只读事务，仍建议再使用只读数据库账号（GRANT SELECT）。')
    lines.push('密码保存在本机软件设置中，不会随智能体请求发送给模型服务商。')
  } else {
    lines.push('[PostgreSQL · Connection] Fill the DB connection as JSON in "Configuration → Env vars (JSON)", then click "Connect" on the top-right to apply:')
    lines.push('{"PGHOST":"127.0.0.1","PGPORT":"5432","PGDATABASE":"openalex","PGUSER":"aikm_ro","PGPASSWORD":"password"}')
    lines.push('Or a single connection string: {"PG_MCP_CONNECTION_STRING":"postgresql://user:pwd@host:5432/db"}; add "PGSSL":"true" for remote TLS.')
    lines.push('Optional tuning: PG_MCP_MAX_ROWS (default 50 / max 500), PG_MCP_STATEMENT_TIMEOUT_MS in **milliseconds** (default 30000 = 30 s; use 180000 for large databases), PG_MCP_SCHEMA to pin a schema (otherwise the single user schema is set as search_path).')
    lines.push('Author-resolution tuning: PG_MCP_RESOLVE_CONCURRENCY (1–8; auto: 4 when a name index is detected, else serial 1), PG_MCP_INDEX_PLANS (prefix plans per name, default 4), PG_MCP_FORCE_NAME_SCAN=1 to force a full scan (accuracy-first / troubleshooting).')
    lines.push('To make name lookups fast, ask the DB admin to create the name expression index (a read-only role cannot): CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authors_norm_name_pattern ON <schema>.authors (translate(lower(display_name), \'.\', \' \') text_pattern_ops); — the service then takes the indexed fast path automatically (15–20 s → milliseconds). pg_status reports whether the index was detected and prints the ready-to-run statement.')
    lines.push('Seven read-only tools: pg_resolve_author (author disambiguation: name + optional institution → candidates / institution history / representative works / tier), pg_status, pg_list_schemas, pg_list_tables, pg_describe_table, pg_sample_rows, pg_query (read-only SQL, auto LIMIT). A read-only transaction is enforced server-side; a read-only DB role (GRANT SELECT) is still recommended.')
    lines.push('The password stays in this app\'s local settings and is never sent to the model provider.')
  }
}

// ===================== 内置服务对外暴露信息（说明区展示外部接入方法） =====================
const exposeInfo = ref<any>(null)
const endpointOf = (id?: string) => exposeInfo.value?.endpoints?.find((e: any) => e.id === id)
const isExposeOn = (id: string) => exposeInfo.value?.endpoints?.find((e: any) => e.id === id)?.enabled !== false
const toggleExpose = async (id: string) => {
  if (!window.ipcRenderer) return
  const next = !isExposeOn(id)
  try {
    exposeInfo.value = await window.ipcRenderer.invoke('mcp-expose-set', { id, enabled: next })
  } catch (e) { console.warn('[mcp-expose] toggle failed', e) }
}
function pushExternalLines(lines: string[], id?: string) {
  const ep = endpointOf(id)
  if (!ep) return
  const url = ep.url
  if (ep.enabled === false) {
    if (zh.value) lines.push(`【对外 HTTP 暴露 · 已关闭】端点 ${url} 当前已关闭，其他软件暂无法连接；如需要请点击上方「对外 HTTP 暴露」开关开启。`)
    else lines.push(`[External HTTP · OFF] Endpoint ${url} is disabled; enable the "External HTTP" toggle above to let other apps connect.`)
    return
  }
  if (zh.value) {
    lines.push(`【对外暴露 · 供其他软件连接】本内置服务已通过 Streamable HTTP 暴露到本机：${url}。其他 MCP 客户端（Claude Desktop / Claude Code / Cursor 等）或其它应用可按该地址接入；接入时本软件必须保持运行。`)
    lines.push('接入配置示例（type 填 http，url 填上面地址）：')
    lines.push(JSON.stringify({ mcpServers: { [ep.id]: { type: 'http', url } } }, null, 2))
    lines.push(`浏览器访问 http://127.0.0.1:${exposeInfo.value?.port || ''}/health 可查看状态与工具列表。`)
  } else {
    lines.push(`[Expose to other apps] This built-in server is reachable over MCP Streamable HTTP at: ${url}. Any MCP client (Claude Desktop / Claude Code / Cursor, etc.) can connect using this URL while this app is running.`)
    lines.push('Example config (type http, url above):')
    lines.push(JSON.stringify({ mcpServers: { [ep.id]: { type: 'http', url } } }, null, 2))
    lines.push(`Open http://127.0.0.1:${exposeInfo.value?.port || ''}/health in a browser to inspect status and tools.`)
  }
}

// ===================== 右侧说明文案 =====================
const docLines = computed<string[]>(() => {
  const s = selected.value
  if (zh.value) {
    const lines = [
      'MCP（Model Context Protocol）让本软件通过标准协议连接外部能力服务，服务暴露的「函数」可被通用智能体 / Agent 预设 / 工作流 MCP 节点调用。',
      '连接类型：STDIO 启动本地命令进程并双向通信；SSE / HTTP 连接远程 HTTP 端点（Streamable），可携带鉴权请求头。',
      '「启用」开关：关闭后该服务不会被连接、其函数也不会注入智能体上下文；开启并「自动连接」后，启动时会自动建立连接。',
      '右上角按钮：连接 / 断开、测试连接（临时连接，用于发现函数）、刷新函数；确认可用后请保持「连接」状态供智能体调用。',
      '调用超时：单次工具调用的等待上限（默认 60 秒，留空即默认）；网页加载、大文件读写等慢服务可调大，超时提示会显示服务名与实际等待秒数。',
    ]
    if (s?.transport === 'stdio') {
      lines.push('STDIO 提示：请确认本机已安装命令所需运行时（node / python / uvx 等），参数需用空格分隔，环境变量以 JSON 传入。')
    } else {
      lines.push('远程提示：serverUrl 必须是 MCP 服务端点；需要鉴权时在「请求头 headers」填写，例如 Authorization: Bearer <token>。')
    }
    if (s?.id === 'builtin-postgres') pushPostgresLines(lines, true)
    if (s?.builtin) pushExternalLines(lines, s.id)
    return lines
  }
  const lines = [
    'MCP (Model Context Protocol) lets the app connect to external capability servers via a standard protocol; the "tools" they expose can be called by the general agent, Agent presets, and workflow MCP nodes.',
    'Transport: STDIO spawns a local command process; SSE / HTTP connect to a remote HTTP endpoint (Streamable), optionally with auth headers.',
    'The enable toggle prevents the server from connecting and its tools from being injected; when enabled with auto-connect, the server is connected at startup.',
    'Top-right buttons: Connect/Disconnect, Test (temporary, to discover tools), and Refresh tools; keep it connected so agents can call it.',
    'Call timeout: max wait per tool call (default 60 s; empty = default). Raise it for slow services (page loads, large files); timeout errors show the server name and the actual wait.',
  ]
  if (s?.transport === 'stdio') {
    lines.push('STDIO: make sure the runtime (node / python / uvx …) is installed; space-separate args and pass env as JSON.')
  } else {
    lines.push('Remote: serverUrl must be an MCP endpoint; put auth in headers, e.g. Authorization: Bearer <token>.')
  }
  if (s?.id === 'builtin-postgres') pushPostgresLines(lines, false)
  if (s?.builtin) pushExternalLines(lines, s.id)
  return lines
})

onMounted(async () => {
  // 内置浏览器 Agent 服务确保存在（防误删后丢失；幂等）
  store.ensureBuiltinMcpServer()
  if (servers.value.length) {
    selectedId.value = servers.value[0].id
  }
  if (window.ipcRenderer) {
    window.ipcRenderer.on('mcp-status-changed', onStatusChanged)
    refreshAllStatus()
    // 内置服务对外暴露信息（说明区展示外部接入 URL / 配置示例）
    try { exposeInfo.value = await window.ipcRenderer.invoke('mcp-expose-info') } catch { /* 忽略 */ }
  }
})

onBeforeUnmount(() => {
  if (window.ipcRenderer) {
    window.ipcRenderer.off('mcp-status-changed', onStatusChanged)
  }
})
</script>

<style scoped>
/* ========== 根容器：左右分栏（参照 AgentPreset .agent-preset） ========== */
.mcp-settings {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--backgroundColor);
  color: var(--fontColor);
}

/* ========== 左侧：服务导航栏 ========== */
.mcp-sidebar {
  width: 205px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--borderColor);
  background: var(--menuColor);
}
/* 顶部工具栏 */
.mcp-toolbar {
  display: flex;
  gap: 5px;
  padding: 5px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.mcp-toolbar .toolbar-action-btn {
  flex-shrink: 0;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  transition: all .12s;
}
.mcp-toolbar .toolbar-action-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.mcp-toolbar .toolbar-action-btn:disabled { opacity: .5; cursor: default; }
.mcp-add-btn { flex: 1; }
/* 服务列表 */
.mcp-nav-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
  background-color: var(--backgroundColor);
}
.mcp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  min-height: 120px;
  padding: 12px;
  text-align: center;
  color: var(--fontColor);
  opacity: .65;
  font-size: 12px;
  line-height: 1.6;
}
.mcp-nav-item {
  padding: 5px 6px;
  margin-bottom: 2px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all .12s;
  background: transparent;
}
.mcp-nav-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.mcp-nav-item.active {
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  border-color: var(--fontActiveColor);
}
.mcp-nav-item.disabled { opacity: .55; }
.mcp-nav-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.mcp-nav-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--fontColor);
  opacity: .6;
}
.mcp-nav-icon.on { color: #4CAF50; opacity: 1; }
.mcp-nav-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-nav-toggle {
  width: 26px;
  height: 14px;
  border-radius: 7px;
  flex-shrink: 0;
  background: var(--borderColor);
  position: relative;
  cursor: pointer;
  transition: all .15s;
}
.mcp-nav-toggle .toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.mcp-nav-toggle.on { background: var(--fontActiveColor); }
.mcp-nav-toggle.on .toggle-knob { left: 14px; }
.mcp-nav-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding-left: 24px;
  min-width: 0;
  font-size: 10px;
}
.mcp-nav-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--fontColor);
  opacity: .72;
  white-space: nowrap;
}
.mcp-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
  font-style: normal;
}
.mcp-status-dot.dot-connected { background: #4CAF50; }
.mcp-status-dot.dot-connecting { background: #FF9800; animation: mcp-blink 1s infinite; }
.mcp-status-dot.dot-error { background: #F44336; }
.mcp-status-dot.dot-disconnected { background: var(--borderColor); }
@keyframes mcp-blink { 50% { opacity: .3; } }
.mcp-nav-badge {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--borderColor);
  color: var(--fontActiveColor);
  opacity: .85;
  white-space: nowrap;
  flex-shrink: 0;
}
.mcp-nav-tools {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  color: var(--fontActiveColor);
  opacity: .9;
  white-space: nowrap;
  font-size: 10px;
}

/* ========== 右侧：内容区 ========== */
.mcp-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mcp-content-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--fontColor);
  opacity: .65;
  font-size: 13px;
  text-align: center;
  padding: 20px;
  line-height: 1.6;
}

/* 标题行 */
.mcp-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--borderColor);
  padding-bottom: 8px;
  flex-shrink: 0;
}
.mcp-pane-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mcp-pane-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--fontColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--borderColor);
  white-space: nowrap;
  flex-shrink: 0;
}
.mcp-status-connected { color: #4CAF50; }
.mcp-status-connecting { color: #FF9800; }
.mcp-status-error { color: #F44336; }
/* 右上角：启用开关 + 图标操作按钮组 */
.mcp-pane-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.mcp-toggle {
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background: var(--borderColor);
  position: relative;
  cursor: pointer;
  transition: all .15s;
}
.mcp-toggle .toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.mcp-toggle.on { background: var(--fontActiveColor); }
.mcp-toggle.on .toggle-knob { left: 16px; }
.mcp-head-btns {
  display: flex;
  align-items: center;
  gap: 4px;
}
.head-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  transition: all .12s;
}
.head-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.head-btn.on { color: #4CAF50; border-color: color-mix(in srgb, #4CAF50 45%, transparent); }
.head-btn.danger { color: #F44336; }
.head-btn.danger:hover { border-color: color-mix(in srgb, #F44336 45%, transparent); }
.head-btn:disabled { opacity: .4; cursor: default; }

/* 连接类型 chip（pane-head：自动连接 / 手动连接） */
.mcp-conn-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--fontActiveColor);
  border: 1px solid color-mix(in srgb, var(--fontActiveColor) 40%, transparent);
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
}
.mcp-conn-chip i { font-size: 10px; }
.mcp-conn-chip.manual {
  color: var(--fontColor);
  opacity: .8;
  border-color: var(--borderColor);
  background: color-mix(in srgb, var(--fontColor) 5%, transparent);
}

/* 分组 */
.mcp-group {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  overflow: hidden;
  flex-shrink: 0;
}
.mcp-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fontActiveColor);
  border-bottom: 1px solid color-mix(in srgb, var(--borderColor) 60%, transparent);
  background: color-mix(in srgb, var(--fontColor) 3%, transparent);
}
.mcp-group-title > i { font-size: 12px; }
.mcp-group-count {
  font-size: 10px;
  font-weight: normal;
  padding: 1px 6px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
}
.mcp-group-note {
  margin-left: auto;
  font-size: 10px;
  font-weight: normal;
  color: var(--fontColor);
  opacity: .5;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mcp-pad-hint { padding: 8px 10px; }

/* 函数列表：函数名 + 说明同一行展示（说明直接可见，无需点击展开） */
.mcp-tool-list {
  padding: 4px 10px 8px;
  display: flex;
  flex-direction: column;
}
.mcp-tool {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  transition: all .12s;
}
.mcp-tool + .mcp-tool {
  border-top: 1px dashed color-mix(in srgb, var(--borderColor) 70%, transparent);
}
.mcp-tool:hover { background: color-mix(in srgb, var(--fontColor) 5%, transparent); }
.mcp-tool-name {
  flex: 0 0 190px;
  width: 190px;
  min-width: 0;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  color: var(--fontActiveColor);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-top: 1px;
}
.mcp-tool-desc {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--fontColor);
  opacity: .85;
  line-height: 1.55;
  word-break: break-word;
}
.mcp-tools-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fontColor);
  opacity: .7;
  line-height: 1.6;
}

/* 说明列表 */
.mcp-doc-list {
  margin: 0;
  padding: 8px 14px 10px 26px;
  font-size: 12px;
  color: var(--fontColor);
  opacity: .9;
  line-height: 1.7;
}
.mcp-doc-list li { margin-bottom: 4px; }

/* 内置服务：对外 HTTP 暴露开关行 */
.mcp-expose-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--borderColor);
}
.mcp-expose-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fontColor);
  flex: 1;
  min-width: 0;
}
.mcp-expose-label i { color: var(--fontActiveColor); font-size: 12px; }
.mcp-expose-state { font-size: 11px; color: #2ecc71; flex-shrink: 0; }
.mcp-expose-state.off { color: var(--fontColor); opacity: .6; }

/* ========== 配置表单（详情内直接编辑） ========== */
.mcp-edit-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 4px;
}
.mcp-edit-form .form-group {
  display: flex;
  align-items: center;
  margin-bottom: 0;
}
.mcp-edit-form .form-group-top { align-items: flex-start; }
.mcp-edit-form .form-group label {
  width: 150px;
  min-width: 150px;
  color: var(--fontColor);
  font-size: 12px;
  line-height: normal;
  user-select: none;
  padding: 0;
  flex-shrink: 0;
}
.mcp-edit-form .form-group input:not([type="checkbox"]):not([type="radio"]) {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 13px;
  font-family: inherit;
}
/* 名称行内的传输下拉框：定宽，紧邻名称输入框右侧（不再单独占一行） */
.mcp-edit-form .mcp-name-row .mcp-transport-sel {
  flex: 0 0 150px;
  width: 150px;
  min-width: 0;
  margin: 0 0 0 8px;
  padding: 4px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  box-sizing: border-box;
}
/* 名称行：flex 拉伸，使输入框与传输下拉高度一致 */
.mcp-edit-form .form-group.mcp-name-row {
  align-items: stretch;
}
.mcp-edit-form .mcp-name-row label {
  align-self: center;
}
/* 名称行：输入框与传输下拉严格等高（某些平台下拉 UA 默认高度偏矮，显式锁定同一像素） */
.mcp-edit-form .mcp-name-row input {
  height: 27px;
  box-sizing: border-box;
}
.mcp-edit-form .mcp-name-row .mcp-transport-sel {
  height: 27px;
  box-sizing: border-box;
}
.mcp-edit-form .form-group textarea {
  flex: 1;
  min-width: 0;
  /* 环境变量 / 请求头 JSON 常见多行（如 PostgreSQL 的 PGHOST~PGPASSWORD）→ 给足高度，不够可拖拽放大 */
  min-height: 156px;
  padding: 4px 8px;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  font-family: Consolas, 'Courier New', monospace;
  resize: vertical;
}
.mcp-edit-form .form-group input:focus,
.mcp-edit-form .form-group select:focus,
.mcp-edit-form .form-group textarea:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}
/* 自动连接复选框（右上角 head-actions，界面更紧凑）：只固定几何，勾选皮肤由全局 :checked 提供 */
.mcp-pane-head-actions .mcp-auto-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 2px 0 4px;
  padding: 0;
  line-height: 1;
  font-size: 11px;
  color: var(--fontColor);
  opacity: .92;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;
}
.mcp-pane-head-actions .mcp-auto-check:hover { opacity: 1; }
.mcp-pane-head-actions .mcp-auto-check input[type="checkbox"] {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
}
.mcp-head-divider {
  width: 1px;
  height: 16px;
  background: var(--borderColor);
  margin: 0 2px;
  flex-shrink: 0;
}
</style>
