<!-- ToolRegistryPanel.vue - 工具注册表：查看主进程统一工具注册表实际注册的工具（运行时事实层） -->
<template>
  <div class="tool-registry-panel">
    <div class="settings-group">
      <!-- 标题行：h3 在左，注册表头部（计数 + 刷新）在右（与工具管理 h3 样式统一） -->
      <div class="group-title-row">
        <h3>{{ store.locales === 'zh' ? '统一工具注册表' : 'Unified Tool Registry' }}</h3>
        <div class="registry-head">
          <div class="registry-head-info">
            <span class="registry-head-title">
              {{ store.locales === 'zh'
                ? (isFiltered ? `匹配 ${filteredTools.length} / ${registryTools.length}` : `已注册（${registryTools.length}）`)
                : (isFiltered ? `${filteredTools.length} / ${registryTools.length} matched` : `Registered (${registryTools.length})`) }}
            </span>
            <span v-if="scopeActive" class="registry-head-enabled">
              {{ zh ? `· 启用 ${enabledCount}` : `· ${enabledCount} enabled` }}
            </span>
            <span v-if="disabledCount > 0" class="registry-head-disabled" :title="disabledSummaryHint">
              {{ zh ? `· ${disabledLabel} ${disabledCount}` : `· ${disabledCount} ${disabledLabel}` }}
            </span>
            <span class="registry-head-desc" :title="registryHeadHint">
              {{ zh
                ? '主进程 toolRegistry 实际注册的工具（运行时事实层）：Agent 循环 / PTC SDK / 工具类工作流节点由它分发执行；MCP 服务工具不在此列，须经 mcp_call 调用。启用状态默认不显示，用左侧下拉选口径。'
                : 'Tools actually registered in the main-process toolRegistry (runtime source of truth): the agent loop / PTC SDK / tool-based workflow nodes dispatch through it; MCP service tools are not listed here and must be called via mcp_call. Enable state is hidden by default — pick a scope on the left.' }}
            </span>
          </div>
          <div class="registry-actions">
            <div class="button icon-btn" @click="refreshAndRefocus" :title="store.locales === 'zh' ? '刷新' : 'Refresh'">
              <i class="fa fa-refresh"></i>
            </div>
          </div>
        </div>
      </div>

      <div v-if="registryUnavailable" class="registry-unavailable">
        <i class="fa fa-info-circle"></i>
        {{ store.locales === 'zh' ? '注册表仅桌面版可用（桌面 IPC 不可用）' : 'Registry requires the desktop app (desktop IPC unavailable)' }}
      </div>

      <div v-else-if="registryLoading" class="registry-unavailable">
        <i class="fa fa-spinner fa-spin"></i>
        {{ store.locales === 'zh' ? '正在读取工具注册表…' : 'Loading tool registry…' }}
      </div>

      <template v-else>
        <!-- 搜索行：注册表动辄上百条（插件工具一多更难找），按名字 / 描述 / 作用域过滤 -->
        <div class="registry-search-row">
          <!-- 查看口径：默认不显示启用状态；也可按某个智能体预设 / 某个运行中的会话判 -->
          <select v-model="scopeValue" class="registry-scope-select" :title="scopeSelectHint">
            <option value="">{{ zh ? '不显示启用状态' : 'No enable state' }}</option>
            <option value="global">{{ zh ? '全局默认（工具管理）' : 'Global default (Tools)' }}</option>
            <optgroup v-if="scopeGroups.preset.length" :label="zh ? '智能体预设' : 'Agent presets'">
              <option v-for="o in scopeGroups.preset" :key="o.value" :value="o.value">{{ o.label }}</option>
            </optgroup>
            <optgroup v-if="scopeGroups.agent.length" :label="zh ? '运行中的会话' : 'Live sessions'">
              <option v-for="o in scopeGroups.agent" :key="o.value" :value="o.value">{{ o.label }}</option>
            </optgroup>
          </select>
          <div class="registry-search-box">
            <i class="fa fa-search registry-search-icon"></i>
            <input
              ref="searchInput"
              v-model="searchText"
              class="registry-search-input"
              type="text"
              :placeholder="store.locales === 'zh'
                ? '搜索工具名 / 描述 / 作用域（如 mathproof、plugin: 前缀）'
                : 'Search name / description / scope (e.g. mathproof, plugin:)'"
              @keydown.esc="searchText = ''"
            />
            <i
              v-if="searchText"
              class="fa fa-times-circle registry-search-clear"
              :title="store.locales === 'zh' ? '清空' : 'Clear'"
              @click="clearSearch"
            ></i>
          </div>
          <div
            class="button icon-btn"
            :class="{ 'is-active': onlyPluginTools }"
            :title="store.locales === 'zh' ? '只看插件注册的工具（scope = plugin:…）' : 'Only plugin-provided tools (scope = plugin:…)'"
            @click="onlyPluginTools = !onlyPluginTools"
          >
            <i class="fa fa-puzzle-piece"></i>
          </div>
        </div>

        <!-- 作用域说明（仅选中口径时显示）+ 会话清单加载中 / 预设里注册表缺失的名字 -->
        <div v-if="scopeNote || sessionLoading || missingNames.length" class="registry-scope-note">
          <template v-if="scopeNote">{{ scopeNote }}</template>
          <template v-if="sessionLoading">
            <i class="fa fa-spinner fa-spin"></i>
            {{ zh ? '正在读取该会话的工具清单…' : 'Loading that session’s tool list…' }}
          </template>
          <span v-if="missingNames.length" class="registry-scope-missing">
            <i class="fa fa-exclamation-triangle"></i>
            {{ zh
              ? `该口径启用但注册表里没有的工具 ${missingNames.length} 个：${missingNames.join('、')}（插件未加载 / 由渲染层实现）`
              : `${missingNames.length} enabled tool(s) missing from the registry: ${missingNames.join(', ')} (plugin not loaded / renderer-side tool)` }}
          </span>
        </div>

        <div v-if="!filteredTools.length" class="registry-unavailable">
          <i class="fa fa-search"></i>
          {{ store.locales === 'zh'
            ? `没有匹配的工具（共已注册 ${registryTools.length} 个）`
            : `No matching tool (${registryTools.length} registered in total)` }}
        </div>

        <div v-else class="registry-list">
          <div v-for="tool in filteredTools" :key="tool.name" class="registry-item" :class="{ 'is-disabled': isToolDisabled(tool.name) }">
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
                  <i class="fa fa-eye-slash"></i> {{ disabledLabel }}
                </span>
              </div>
              <div class="registry-desc" :title="tool.description">{{ tool.description }}</div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { aikmDsh } from '@/lib/aikmIpc'
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { usestore } from '@/store'
import { SKILL_AGENT_DEFAULT_TOOLS } from '@/lib/agent/skill'
import { AGENT_TOOL_REGISTRY } from '@/services/agentSkills'
import {
  REGISTRY_SCOPE_NONE,
  disabledNamesOf,
  enabledNamesForScope,
  missingNamesOf,
  parseRegistryScope,
  registryScopeOptions,
  scopeTargetAlive,
} from '@/lib/agent/toolRegistryView'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const registryTools = ref<Array<{ name: string; description: string; hasInputSchema: boolean; scope?: string }>>([])
const registryUnavailable = ref(false)
/**
 * 加载中标记。**必须有**：registryUnavailable 初值是 false，而列表为空时渲染的是"暂无工具"，
 * 所以不标加载中的话，面板每次打开 / 每次点刷新都会先闪一下"没有工具"——看起来像注册表是空的。
 */
const registryLoading = ref(true)

// ---- 搜索 / 过滤（注册表动辄上百条，插件一多就翻不动）----

const searchText = ref('')
const onlyPluginTools = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
/** 刷新后把焦点还给搜索框：用户的动作多半是"先搜、再点刷新看最新" */
const refocusSearch = ref(false)

const normalizedQuery = computed(() => searchText.value.trim().toLowerCase())
/** 按空白分词：每个词都得命中一处，`math proof` 这类多词查询才有用 */
const queryTerms = computed(() => (normalizedQuery.value ? normalizedQuery.value.split(/\s+/) : []))
const isFiltered = computed(() => queryTerms.value.length > 0 || onlyPluginTools.value)

const filteredTools = computed(() => {
  let list = registryTools.value
  if (onlyPluginTools.value) list = list.filter((t) => String(t.scope || '').startsWith('plugin:'))
  const terms = queryTerms.value
  if (!terms.length) return list
  return list.filter((t) => {
    const hay = `${t.name} ${t.description || ''} ${t.scope || ''}`.toLowerCase()
    return terms.every((k) => hay.includes(k))
  })
})

const clearSearch = () => {
  searchText.value = ''
  void nextTick(() => searchInput.value?.focus())
}

/** 始终启用的引擎核心工具（注册表中此类不受白名单影响） */
const alwaysOnTools = new Set(AGENT_TOOL_REGISTRY.filter((t) => t.alwaysOn).map((t) => t.name))

/** 是否已在「设置 → 工具管理」显式配置白名单（未配置 = 运行时回退默认可见集） */
const whitelistConfigured = computed(() => Array.isArray(store.agentTools))

// ---------------------------------------------------------------------------
// 查看作用域：默认**不判状态**（只看注册表事实），也可按「预设」或「运行中的会话」判
//   - 全局：与通用智能体 / 技能触发 / 批量的运行时同源（store.agentTools，未配置回退默认集）
//   - 预设：与预设运行时同源（能力槽 → 工具名）
//   - 会话：主进程 agent:tools 返回的该会话**实际下发清单**
// 判定的全部规则见 lib/agent/toolRegistryView.ts（纯逻辑，带自测）。
// ---------------------------------------------------------------------------

const scopeValue = ref<string>(REGISTRY_SCOPE_NONE)
const scope = computed(() => parseRegistryScope(scopeValue.value))

const presets = computed<Array<{ id: string; name?: string; capabilities?: unknown }>>(() => {
  const list = (store as any).agentPresets
  return Array.isArray(list) ? list : []
})

/** 运行中的会话（agent:list；已结束的不列出也不选中） */
const sessions = ref<Array<{ id: string; label?: string; status?: string }>>([])

/** 选中的会话当前生效的工具清单（agent:tools）；null = 还没取到 → 不判状态 */
const sessionToolNames = ref<string[] | null>(null)
const sessionLoading = ref(false)

const scopeGroups = computed(() => registryScopeOptions({
  presets: presets.value,
  agents: sessions.value,
  zh: zh.value,
}))

/** 当前作用域的启用集；null = **不显示启用状态**（默认口径 / 目标已消失 / 会话清单未取到） */
const enabledNames = computed<Set<string> | null>(() => enabledNamesForScope({
  scope: scope.value,
  globalStored: store.agentTools,
  globalDefaultTools: SKILL_AGENT_DEFAULT_TOOLS,
  globalAlwaysOn: [...alwaysOnTools],
  presets: presets.value,
  agentToolNames: sessionToolNames.value,
}))

const registeredNames = computed(() => registryTools.value.map((t) => t.name))
const disabledNames = computed(() => disabledNamesOf(registeredNames.value, enabledNames.value))

/** 该注册工具在当前作用域下是否未被启用（不判状态时恒为 false） */
const isToolDisabled = (name: string): boolean => disabledNames.value.has(name)

/** 是否正在按某个作用域判状态（默认口径为 false） */
const scopeActive = computed(() => enabledNames.value !== null)

const enabledCount = computed(() => (scopeActive.value
  ? registeredNames.value.length - disabledNames.value.size
  : 0))
const disabledCount = computed(() => disabledNames.value.size)

/** 未启用徽标文案：全局说「已禁用」，预设说「未启用」，会话说「不在本会话」（三种口径不是一回事） */
const disabledLabel = computed(() => {
  if (scope.value.kind === 'global') return zh.value ? '已禁用' : 'disabled'
  if (scope.value.kind === 'agent') return zh.value ? '不在本会话' : 'not in session'
  return zh.value ? '未启用' : 'off'
})

/** 预设口径下：预设声明了、但注册表里没有的名字（插件未加载 / 由渲染层实现） */
const missingNames = computed(() => (scope.value.kind === 'preset'
  ? missingNamesOf(enabledNames.value, registeredNames.value)
  : []))

const scopeSelectHint = computed(() => (zh.value
  ? '查看口径（默认不显示启用状态）：\n'
    + '· 不显示启用状态 —— 只看注册表事实（名字 / 参数 schema / 作用域）；\n'
    + '· 全局默认 —— 按「设置 → 工具管理」的白名单判（通用智能体 / 技能触发 / 批量这条入口的默认）；\n'
    + '· 智能体预设 —— 按该预设能力槽判（与预设运行时同源）；\n'
    + '· 运行中的会话 —— 按该会话实际下发给模型的清单判（含跨层解析到的插件工具）。'
  : 'View scope (enable state hidden by default):\n'
    + '· No enable state — registry facts only (name / input schema / scope);\n'
    + '· Global default — judged by the whitelist in Settings → Tools (default for the general agent / skill runs / batch);\n'
    + '· Agent preset — judged by that preset\'s capability slots (same source as the preset runtime);\n'
    + '· Live session — judged by what that session actually sends to the model (plugin tools resolved across layers).'))

/** 作用域说明行（选中后显示；默认口径不显示，避免正文变长） */
const scopeNote = computed(() => {
  if (scope.value.kind === 'global') {
    return zh.value
      ? '全局口径：按「设置 → 工具管理」的白名单判定（未配置时按 Agent 循环默认集）。它只代表通用智能体 / 技能触发 / 批量这条入口的默认 —— Agent 预设、工作流节点、子代理各有自己的白名单。'
      : 'Global scope: judged by the whitelist in Settings → Tools (agent-loop default set when unconfigured). This is only the default for the general agent / skill runs / batch — presets, workflow nodes and subagents have their own whitelists.'
  }
  if (scope.value.kind === 'preset') {
    const p = presets.value.find((x) => x.id === scope.value.id)
    const name = p?.name || scope.value.id
    return zh.value
      ? `预设口径：「${name}」能力槽产出的工具（与预设运行时同源）。未标出的工具在该预设下不会下发给模型。`
      : `Preset scope: tools produced by “${name}” capability slots (same source as the preset runtime). Tools not marked here are not sent to the model under this preset.`
  }
  if (scope.value.kind === 'agent') {
    const s = sessions.value.find((x) => x.id === scope.value.id)
    const name = s?.label || scope.value.id.slice(0, 8)
    return zh.value
      ? `会话口径：「${name}」实际下发给模型的清单（scope 层 + 白名单，含跨层解析到的插件工具）。PTC（代码模式）会话下模型只见 run_code，但程序内 SDK 可用的正是这份清单。`
      : `Session scope: what “${name}” actually sends to the model (scope layer + whitelist, plugin tools resolved across layers). In a PTC (code-mode) session the model only sees run_code, but this is exactly what the in-program SDK can call.`
  }
  return ''
})

const registryHeadHint = computed(() => {
  return store.locales === 'zh'
    ? '主进程 toolRegistry 实际注册的工具（运行时事实层，含作用域与参数 schema 信息）。\n'
      + '· 执行路径：Agent 循环、PTC（Code Mode）的 ctx SDK、工作流「网络搜索 / 智能体」等节点均经 toolRegistry.execute 走 pre-execute → execute → post-execute 管线分发；\n'
      + '· 不在注册表：MCP 服务（builtin-office / builtin-drawio / 外部服务）的工具只存在于 MCP 目录，须经 mcp_call 调用；\n'
      + '· 启用状态：默认不显示（只看注册表事实：名字 / 参数 schema / 作用域）；在左侧下拉里选一个口径才有含义 —— 全局（「设置 → 工具管理」的白名单）、某个智能体预设（该预设能力槽）、或某个运行中的会话（它实际下发给模型的清单）。'
    : 'Tools actually registered in the main-process toolRegistry (runtime source of truth, incl. scope & input schema).\n'
      + '· Dispatch: the agent loop, the PTC (Code Mode) ctx SDK and tool-based workflow nodes (web search / agent) all execute via toolRegistry.execute through the pre-execute → execute → post-execute pipeline;\n'
      + '· Not listed: MCP service tools (builtin-office / builtin-drawio / external servers) live only in the MCP catalog and are reachable via mcp_call;\n'
      + '· Enable state: hidden by default (registry facts only: name / input schema / scope); pick a scope on the left to make it meaningful — global (the whitelist in Settings → Tools), an agent preset (its capability slots), or a live session (what it actually sends to the model).'
})

const disabledSummaryHint = computed(() => {
  if (scope.value.kind === 'agent') {
    return zh.value
      ? '该会话下没有下发给模型的工具（这是本会话的事，不是"被全局白名单禁用"）'
      : 'Not sent to the model in this session (this is a per-session fact, not a global-whitelist decision)'
  }
  if (scope.value.kind === 'preset') {
    return zh.value
      ? '该预设没有启用的工具（由预设能力槽 / 逐工具勾选决定；Agent 预设不受「工具管理」的全局白名单影响）'
      : 'Tools this preset does not enable (decided by its capability slots / per-tool ticks; presets ignore the global whitelist in Settings → Tools)'
  }
  return whitelistConfigured.value
    ? (zh.value
        ? '已注册但未启用的数量（按「设置 → 工具管理」的全局白名单；Agent 预设有各自能力槽）'
        : 'Registered but not enabled (per the global whitelist in Settings → Tools; agent presets use their own slots)')
    : (zh.value
        ? '已注册但不在 Agent 循环默认可见集内的数量（「设置 → 工具管理」尚未配置，运行时回退默认集）'
        : 'Registered but not in the agent-loop default tool set (whitelist unconfigured → runtime falls back to the default set)')
})

const disabledBadgeHint = computed(() => {
  if (scope.value.kind === 'agent') {
    return zh.value
      ? '该工具已注册，但不在这个会话下发给模型的清单里：可能是本会话白名单没勾它，也可能是该会话的作用域看不到它（插件工具按名跨层解析）'
      : 'Registered, but not in what this session sends to the model: either its whitelist excludes it, or the session scope cannot see it (plugin tools are resolved across layers by name)'
  }
  if (scope.value.kind === 'preset') {
    return zh.value
      ? '该工具已注册，但该预设没有启用它（预设能力槽 / 逐工具勾选）→ 该预设不会把它下发给模型'
      : 'Registered, but this preset does not enable it (capability slots / per-tool ticks) → the preset will not send it to the model'
  }
  return whitelistConfigured.value
    ? (zh.value
        ? '该工具已注册，但不在「设置 → 工具管理」的全局白名单内 → Agent 循环不会把它暴露给模型（仍可经 tools:execute IPC / mcp_call 调用）'
        : 'Registered, but not in the global whitelist (Settings → Tools) → the agent loop will not expose it to the model (still callable via the tools:execute IPC / mcp_call)')
    : (zh.value
        ? '该工具已注册，但不在 Agent 循环默认可见集（SKILL_AGENT_DEFAULT_TOOLS）内 → 默认不暴露给模型（可在「设置 → 工具管理」中显式启用）'
        : 'Registered, but not in the agent-loop default tool set (SKILL_AGENT_DEFAULT_TOOLS) → not exposed to the model by default (enable it explicitly in Settings → Tools)')
})

const loadRegistry = async () => {
  if (!aikmDsh?.tools) {
    registryUnavailable.value = true
    registryLoading.value = false
    return
  }
  registryLoading.value = true
  try {
    registryTools.value = await aikmDsh.tools.list()
    registryUnavailable.value = false
  } catch (e: any) {
    console.error('[ToolRegistryPanel] 加载工具注册表失败:', e)
    registryUnavailable.value = true
  } finally {
    registryLoading.value = false
    if (refocusSearch.value) {
      refocusSearch.value = false
      void nextTick(() => searchInput.value?.focus())
    }
  }
}

/** 运行中的会话清单（agent:list）。桌面端没有该命名空间时静默留空（会话口径只是可选视角） */
const loadSessions = async () => {
  const api: any = (aikmDsh as any)?.agent
  if (!api?.list) {
    sessions.value = []
    return
  }
  try {
    const list = await api.list()
    sessions.value = Array.isArray(list) ? list : []
  } catch (e) {
    console.warn('[ToolRegistryPanel] 读取运行中的会话失败:', e)
  }
}

/**
 * 选中的会话**实际下发给模型**的工具清单（agent:tools；主进程侧与 visibleTools 同源）。
 * 写回前再确认一次仍选中同一个会话：快速切换下拉时旧请求不能覆盖新结果。
 */
const loadSessionTools = async (id: string) => {
  const api: any = (aikmDsh as any)?.agent
  const stillSelected = () => scope.value.kind === 'agent' && scope.value.id === id
  if (!api?.tools || !id) {
    sessionToolNames.value = null
    return
  }
  sessionLoading.value = true
  try {
    const list = await api.tools(id)
    if (!stillSelected()) return
    sessionToolNames.value = Array.isArray(list) ? list.map((t: any) => String(t?.name ?? t)) : null
  } catch (e) {
    console.warn('[ToolRegistryPanel] 读取会话工具清单失败:', e)
    if (stillSelected()) sessionToolNames.value = null
  } finally {
    if (stillSelected()) sessionLoading.value = false
  }
}

// 切换口径：进入会话口径就取一次清单；离开时清空（回到"不判状态"）
watch(scope, (s) => {
  if (s.kind !== 'agent') {
    sessionToolNames.value = null
    sessionLoading.value = false
    return
  }
  sessionToolNames.value = null
  void loadSessionTools(s.id)
})

/**
 * 会话清单轮询：agent 会随会话结束而消失，选中的目标没了就**回落默认口径** ——
 * 否则面板会停在一个永远空的名单上（看起来像"这些工具全都没启用"）。
 */
const refreshSessions = async () => {
  await loadSessions()
  if (!scopeTargetAlive(scope.value, { presets: presets.value, agents: sessions.value })) {
    scopeValue.value = REGISTRY_SCOPE_NONE
    return
  }
  if (scope.value.kind === 'agent') void loadSessionTools(scope.value.id)
}

const SESSION_POLL_MS = 5000
let sessionTimer: number | null = null

/**
 * 刷新按钮的入口：点了刷新就把焦点留在搜索框（用户多半是"搜完再刷一次看最新"），
 * 否则焦点会丢失、要重新用鼠标点一次输入框。
 */
const refreshAndRefocus = () => {
  refocusSearch.value = true
  void loadRegistry()
  void refreshSessions()
}

onMounted(() => {
  void loadRegistry()
  void loadSessions()
  if (typeof window !== 'undefined') {
    sessionTimer = window.setInterval(() => { void refreshSessions() }, SESSION_POLL_MS)
  }
})

onUnmounted(() => {
  if (sessionTimer !== null) {
    window.clearInterval(sessionTimer)
    sessionTimer = null
  }
})
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
.registry-head-enabled {
  font-size: 10px;
  font-weight: 600;
  color: #4caf50;
  white-space: nowrap;
  flex-shrink: 0;
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
/* 搜索行：与列表同宽，不撑高（列表自己 flex:1 + overflow 滚动） */
.registry-search-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px 0;
  flex-shrink: 0;
}
.registry-search-box {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
/* 查看口径下拉：原生 select 同样要自带前景/背景色（深色主题下不设就是白底白字） */
.registry-scope-select {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 210px;
  height: 26px;
  margin: 0;
  padding: 0 4px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  line-height: normal;
}
.registry-scope-select:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}
/* 作用域说明行：选中口径后才出现（默认口径不占正文空间） */
.registry-scope-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin: 0 0 8px 0;
  padding: 5px 7px;
  border: 1px dashed var(--borderColor);
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.5;
  opacity: 0.85;
  flex-shrink: 0;
}
.registry-scope-missing {
  color: #f39c12;
  opacity: 0.95;
}
.registry-search-icon {
  position: absolute;
  left: 7px;
  font-size: 11px;
  opacity: 0.5;
  pointer-events: none;
}
/* 原生 input 必须自带前景/背景色：应用全局样式给的是 31px 高、calc(100% - 10px) 宽，
   深色主题下不设颜色就会白底白字（插件开发指南里记的同一条坑） */
.registry-search-input {
  width: 100%;
  box-sizing: border-box;
  height: 26px;
  margin: 0;
  padding: 0 22px 0 24px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  line-height: normal;
}
.registry-search-input::placeholder {
  color: var(--fontColor);
  opacity: 0.42;
}
.registry-search-input:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}
.registry-search-clear {
  position: absolute;
  right: 6px;
  font-size: 12px;
  opacity: 0.5;
  cursor: pointer;
}
.registry-search-clear:hover {
  opacity: 0.9;
}
/* 图标按钮的激活态（只看插件工具） */
.icon-btn.is-active {
  color: var(--fontActiveColor);
  border: 1px solid var(--fontActiveColor);
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
