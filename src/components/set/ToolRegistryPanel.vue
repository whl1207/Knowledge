<!-- ToolRegistryPanel.vue - 工具注册表：查看主进程统一工具注册表实际注册的工具（运行时事实层） -->
<template>
  <div class="tool-registry-panel">
    <div class="settings-group">
      <!-- 标题行：h3 在左，注册表头部（计数 + 刷新）在右（与工具管理 h3 样式统一） -->
      <div class="group-title-row">
        <h3>{{ store.locales === 'zh' ? '统一工具注册表' : 'Unified Tool Registry' }}</h3>
        <div class="registry-head">
          <div class="registry-head-info">
            <span class="registry-head-title">{{ store.locales === 'zh' ? `已注册（${registryTools.length}）` : `Registered (${registryTools.length})` }}</span>
            <span v-if="disabledCount > 0" class="registry-head-disabled" :title="disabledSummaryHint">
              {{ store.locales === 'zh' ? `· 已禁用 ${disabledCount}` : `· ${disabledCount} disabled` }}
            </span>
            <span class="registry-head-desc" :title="registryHeadHint">
              {{ store.locales === 'zh'
                ? '主进程 toolRegistry 实际注册的工具（运行时事实层）：Agent 循环 / PTC SDK / 工具类工作流节点由它分发执行；MCP 服务工具不在此列，须经 mcp_call 调用。'
                : 'Tools actually registered in the main-process toolRegistry (runtime source of truth): the agent loop / PTC SDK / tool-based workflow nodes dispatch through it; MCP service tools are not listed here and must be called via mcp_call.' }}
            </span>
          </div>
          <div class="registry-actions">
            <div class="button icon-btn" @click="loadRegistry" :title="store.locales === 'zh' ? '刷新' : 'Refresh'">
              <i class="fa fa-refresh"></i>
            </div>
          </div>
        </div>
      </div>

      <div v-if="registryUnavailable" class="registry-unavailable">
        <i class="fa fa-info-circle"></i>
        {{ store.locales === 'zh' ? '注册表仅桌面版可用（window.dsh.tools 不可用）' : 'Registry requires the desktop app (window.dsh.tools unavailable)' }}
      </div>

      <div v-else class="registry-list">
        <div v-for="tool in registryTools" :key="tool.name" class="registry-item" :class="{ 'is-disabled': isToolDisabled(tool.name) }">
          <div class="registry-info">
            <div class="registry-name-row">
              <code class="registry-key">{{ tool.name }}</code>
              <span class="registry-badge" :class="tool.hasInputSchema ? 'has-schema' : 'no-schema'">
                {{ tool.hasInputSchema ? (store.locales === 'zh' ? '有参数 schema' : 'Has schema') : (store.locales === 'zh' ? '无参数 schema' : 'No schema') }}
              </span>
              <span v-if="tool.scope" class="registry-badge scope-badge">
                <i class="fa fa-sitemap"></i> {{ tool.scope }}
              </span>
              <span v-else class="registry-badge scope-badge">
                <i class="fa fa-globe"></i> {{ store.locales === 'zh' ? '全局' : 'Global' }}
              </span>
              <span v-if="isToolDisabled(tool.name)" class="registry-badge disabled-badge" :title="disabledBadgeHint">
                <i class="fa fa-eye-slash"></i> {{ store.locales === 'zh' ? '已禁用' : 'Disabled' }}
              </span>
            </div>
            <div class="registry-desc" :title="tool.description">{{ tool.description }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usestore } from '@/store'
import { SKILL_AGENT_DEFAULT_TOOLS } from '@/lib/agent/skill'
import { AGENT_TOOL_REGISTRY } from '@/services/agentSkills'

const store = usestore()

const registryTools = ref<Array<{ name: string; description: string; hasInputSchema: boolean; scope?: string }>>([])
const registryUnavailable = ref(false)

/** 始终启用的引擎核心工具（注册表中此类不受白名单影响） */
const alwaysOnTools = new Set(AGENT_TOOL_REGISTRY.filter((t) => t.alwaysOn).map((t) => t.name))

/** 是否已在「设置 → 工具管理」显式配置白名单（未配置 = 运行时回退默认可见集） */
const whitelistConfigured = computed(() => Array.isArray(store.agentTools))

/**
 * 当前生效的工具白名单（与 Agent 循环运行时同源）：
 *  - 已配置 → `store.agentTools`（`[]` = 全部关闭）
 *  - 未配置（null）→ 运行时回退 Agent 循环默认可见集 `SKILL_AGENT_DEFAULT_TOOLS`
 * 注意：Agent 预设用各自的能力槽；工作流 MCP 节点与 MCP 服务工具不受此白名单约束。
 */
const enabledToolNames = computed<Set<string>>(() => {
  const stored = store.agentTools
  const base = Array.isArray(stored) ? stored : [...SKILL_AGENT_DEFAULT_TOOLS]
  return new Set<string>([...base, ...alwaysOnTools])
})

/** 该注册工具是否不在当前生效白名单内（= 已注册但未启用） */
const isToolDisabled = (name: string): boolean => !enabledToolNames.value.has(name)

/** 已注册但未启用的数量（头部展示） */
const disabledCount = computed(() => registryTools.value.filter((t) => isToolDisabled(t.name)).length)

const registryHeadHint = computed(() => {
  return store.locales === 'zh'
    ? '主进程 toolRegistry 实际注册的工具（运行时事实层，含作用域与参数 schema 信息）。\n'
      + '· 执行路径：Agent 循环、PTC（Code Mode）的 ctx SDK、工作流「网络搜索 / 智能体」等节点均经 toolRegistry.execute 走 pre-execute → execute → post-execute 管线分发；\n'
      + '· 不在注册表：MCP 服务（builtin-office / builtin-drawio / 外部服务）的工具只存在于 MCP 目录，须经 mcp_call 调用；\n'
      + '· 灰化 + 「已禁用」：不在当前生效的工具白名单内（白名单 =「设置 → 工具管理」，未配置时按 Agent 循环默认可见集）。Agent 预设有各自的能力槽、工作流 MCP 节点不受该白名单限制，故此处只反映全局默认。'
    : 'Tools actually registered in the main-process toolRegistry (runtime source of truth, incl. scope & input schema).\n'
      + '· Dispatch: the agent loop, the PTC (Code Mode) ctx SDK and tool-based workflow nodes (web search / agent) all execute via toolRegistry.execute through the pre-execute → execute → post-execute pipeline;\n'
      + '· Not listed: MCP service tools (builtin-office / builtin-drawio / external servers) live only in the MCP catalog and are reachable via mcp_call;\n'
      + '· Grayed + Disabled: not in the active tool whitelist (Settings → Tools; when unconfigured the agent-loop default set applies). Agent presets use their own capability slots and workflow MCP nodes ignore this whitelist, so this reflects the global default only.'
})

const disabledSummaryHint = computed(() => store.locales === 'zh'
  ? (whitelistConfigured.value
      ? '已注册但未启用的数量（按「设置 → 工具管理」的全局白名单；Agent 预设有各自能力槽）'
      : '已注册但不在 Agent 循环默认可见集内的数量（「设置 → 工具管理」尚未配置，运行时回退默认集）')
  : (whitelistConfigured.value
      ? 'Registered but not enabled (per the global whitelist in Settings → Tools; agent presets use their own slots)'
      : 'Registered but not in the agent-loop default tool set (whitelist unconfigured → runtime falls back to the default set)'))

const disabledBadgeHint = computed(() => store.locales === 'zh'
  ? (whitelistConfigured.value
      ? '该工具已注册，但不在「设置 → 工具管理」的全局白名单内 → Agent 循环不会把它暴露给模型（仍可经 tools:execute IPC / mcp_call 调用）'
      : '该工具已注册，但不在 Agent 循环默认可见集（SKILL_AGENT_DEFAULT_TOOLS）内 → 默认不暴露给模型（可在「设置 → 工具管理」中显式启用）')
  : (whitelistConfigured.value
      ? 'Registered, but not in the global whitelist (Settings → Tools) → the agent loop will not expose it to the model (still callable via the tools:execute IPC / mcp_call)'
      : 'Registered, but not in the agent-loop default tool set (SKILL_AGENT_DEFAULT_TOOLS) → not exposed to the model by default (enable it explicitly in Settings → Tools)'))

const loadRegistry = async () => {
  if (!window.dsh?.tools) {
    registryUnavailable.value = true
    return
  }
  try {
    registryTools.value = await window.dsh.tools.list()
    registryUnavailable.value = false
  } catch (e: any) {
    console.error('[ToolRegistryPanel] 加载工具注册表失败:', e)
    registryUnavailable.value = true
  }
}

onMounted(loadRegistry)
</script>

<style scoped>
.tool-registry-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--fontColor);
}
.tool-registry-panel .settings-group {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
}
/* 标题行：h3 在左，注册表头部在右（与工具管理 h3 样式统一） */
.group-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 10px 0;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.group-title-row h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0;
  padding: 0 0 8px 10px;
  border-bottom: none;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}
.group-title-row h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}
.registry-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}
.registry-head-info {
  flex: none;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.registry-head-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--fontActiveColor);
  white-space: nowrap;
  flex-shrink: 0;
  opacity: 0.9;
}
.registry-head-disabled {
  font-size: 10px;
  font-weight: 600;
  color: #909399;
  white-space: nowrap;
  flex-shrink: 0;
}
.registry-head-desc {
  font-size: 10px;
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: 220px;
}
.registry-actions {
  display: flex;
  gap: 5px;
  flex-shrink: 0;
}
/* 图标按钮：默认仅显示图标（无边框），悬停 title 显示说明 */
.icon-btn {
  width: 23px;
  height: 23px;
  margin: 0;
  padding: 0;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.registry-unavailable {
  padding: 14px;
  text-align: center;
  color: #888;
  font-size: 12px;
  border: 1px dashed var(--borderColor);
  border-radius: 5px;
}
.registry-list {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 6px;
  align-content: start;
  overflow-y: auto;
  padding-right: 2px;
  width: 100%;
}
.registry-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  transition: border-color 0.12s;
  min-width: 0;
}
.registry-item:hover {
  border-color: var(--fontActiveColor);
}
/* 已禁用（已注册但不在当前生效白名单内）：整体灰化，悬停恢复便于阅读 */
.registry-item.is-disabled {
  opacity: 0.5;
}
.registry-item.is-disabled:hover {
  opacity: 1;
}
.registry-info {
  flex: 1;
  min-width: 0;
}
.registry-name-row {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.registry-key {
  font-size: 12px;
  font-weight: 600;
  padding: 0 5px;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  border: 1px solid var(--borderColor);
  border-radius: 3px;
  color: var(--fontActiveColor);
  font-family: Consolas, monospace;
}
.registry-badge {
  font-size: 9px;
  padding: 0 5px;
  border-radius: 3px;
  white-space: nowrap;
}
.registry-badge.has-schema {
  background: color-mix(in srgb, #4caf50 14%, transparent);
  color: #4caf50;
}
.registry-badge.no-schema {
  background: color-mix(in srgb, #f39c12 14%, transparent);
  color: #f39c12;
}
.registry-badge.scope-badge {
  background: color-mix(in srgb, #409eff 14%, transparent);
  color: #409eff;
}
.registry-badge.disabled-badge {
  background: color-mix(in srgb, #909399 16%, transparent);
  color: #909399;
}
.registry-desc {
  font-size: 10px;
  opacity: 0.75;
  margin-top: 3px;
  line-height: 1.4;
  /* 最多三行，超出省略号；完整描述见 title 悬停提示 */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: anywhere;
}
.registry-list::-webkit-scrollbar {
  width: 4px;
}
.registry-list::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}
</style>
