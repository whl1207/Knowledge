<!-- ToolSettings.vue - 工具管理：显示可用工具列表，配置智能体模式默认可调用的工具 -->
<template>
  <div class="tool-settings">
    <div class="settings-group">
      <!-- 标题行：h3 在左，工具列表头部（可用工具 + 操作按钮）在右 -->
      <div class="group-title-row">
        <h3>{{ store.locales === 'zh' ? '工具管理' : 'Tool Management' }}</h3>
        <div class="tool-list-head">
          <div class="tool-head-info">
            <span class="tool-head-title">{{ store.locales === 'zh' ? `可用工具（${tools.length}）` : `Available Tools (${tools.length})` }}</span>
            <span class="tool-head-desc" :title="toolHeadHint">
              {{ store.locales === 'zh'
                ? '配置智能体模式（Agent 循环）执行时可调用的全局默认工具白名单，关闭的工具不会被注入提示词。'
                : 'Configure the global default tool whitelist for Agent mode (agent loop); disabled tools are not injected.' }}
            </span>
          </div>
          <div class="tool-actions">
            <div class="button icon-btn" @click="enableAll" :title="store.locales === 'zh' ? '全部启用' : 'Enable All'">
              <i class="fa fa-check-circle-o"></i>
            </div>
            <div class="button icon-btn" @click="restoreDefault" :title="store.locales === 'zh' ? '恢复默认' : 'Reset Default'">
              <i class="fa fa-undo"></i>
            </div>
          </div>
        </div>
      </div>

      <!-- 工具列表（白名单配置） -->
      <div class="form-group tool-list-group">
        <div class="tool-list">
          <div v-for="tool in tools" :key="tool.name" class="tool-item" :class="{ disabled: !enabledSet.has(tool.name) && !tool.alwaysOn }">
            <div class="tool-icon" :class="{ muted: !enabledSet.has(tool.name) && !tool.alwaysOn }">
              <i :class="'fa ' + tool.icon"></i>
            </div>
            <div class="tool-info">
              <div class="tool-name-row">
                <span class="tool-name">{{ store.locales === 'zh' ? tool.labelZh : tool.labelEn }}</span>
                <code class="tool-key">{{ tool.name }}</code>
                <span v-if="tool.alwaysOn" class="tool-badge always-on">{{ store.locales === 'zh' ? '核心' : 'Core' }}</span>
              </div>
              <div class="tool-desc">{{ tool.description }}</div>
              <div class="tool-meta">
                <span class="meta-item" :title="store.locales === 'zh' ? '沙箱偏好' : 'Sandbox preference'">
                  <i class="fa fa-lock"></i> {{ sandboxLabel(tool) }}
                </span>
                <span class="meta-item" :title="store.locales === 'zh' ? '审批要求' : 'Approval requirement'">
                  <i class="fa fa-gavel"></i> {{ approvalLabel(tool) }}
                </span>
              </div>
            </div>
            <div
              class="tool-toggle"
              :class="{ on: enabledSet.has(tool.name), 'always-on': !!tool.alwaysOn }"
              :title="tool.alwaysOn ? (store.locales === 'zh' ? '核心工具，始终启用' : 'Core tool, always enabled') : (enabledSet.has(tool.name) ? (store.locales === 'zh' ? '点击禁用' : 'Click to disable') : (store.locales === 'zh' ? '点击启用' : 'Click to enable'))"
              @click="toggleTool(tool)"
            >
              <span class="toggle-knob"></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { usestore } from '@/store'
import { getSkillManager, AGENT_TOOL_REGISTRY, type AgentToolInfo } from '@/services/agentSkills'

const store = usestore()
const skillManager = getSkillManager(store)

// 工具列表头部完整说明（悬停提示）
const toolHeadHint = computed(() => {
  return store.locales === 'zh'
    ? '配置「智能体」模式（Agent 循环）的全局默认工具白名单：未配置=使用全部默认工具，全部关闭=模型不调用任何工具，仅启用列表中的工具。\n「询问用户 / 更新计划 / 任务清单」也可在此开关。\n「Agent 预设」模式使用预设自身的能力槽配置，不受此白名单影响。\n「PTC 程序化调用」模式自动启用 run_code（呈现工具，不在此配置）；其程序内 SDK 可用的能力 = 本白名单。'
    : 'Configure the global default tool whitelist for the Agent Loop mode: unset = all default tools, all off = no tools callable, list = only listed tools.\nAsk User / Update Plan / Update Todo can also be toggled here.\n"Agent Preset" mode uses each preset\'s own capability slots, unaffected by this whitelist.\nPTC (programmatic call) mode enables run_code automatically (a presentation tool, not configured here); the capabilities available to its in-program SDK = this whitelist.'
})

const tools = ref<AgentToolInfo[]>(AGENT_TOOL_REGISTRY)

// 当前启用集合（响应式）
const enabledSet = ref<Set<string>>(new Set())

// 加载当前启用的工具（优先 store 持久化配置，其次注册表默认）
const loadEnabled = () => {
  const stored = store.agentTools
  if (Array.isArray(stored)) {
    // null=未配置使用默认；[]=全部关闭；[names]=仅启用列表中工具；始终合并 alwaysOn
    const valid = stored.filter(n => AGENT_TOOL_REGISTRY.some(t => t.name === n))
    const alwaysOn = AGENT_TOOL_REGISTRY.filter(t => t.alwaysOn).map(t => t.name)
    enabledSet.value = new Set([...new Set([...valid, ...alwaysOn])])
  } else {
    enabledSet.value = new Set(AGENT_TOOL_REGISTRY.filter(t => t.defaultEnabled || t.alwaysOn).map(t => t.name))
  }
}

// 持久化当前启用集合到 store
const persist = () => {
  // 仅保存非 alwaysOn 的用户配置（alwaysOn 始终包含，无需持久化）
  const names = AGENT_TOOL_REGISTRY
    .filter(t => !t.alwaysOn && enabledSet.value.has(t.name))
    .map(t => t.name)
  store.agentTools = names
  store.saveConfig()
  // 同步到 SkillManager 单例
  skillManager.setEnabledTools(names)
}

const toggleTool = (tool: AgentToolInfo) => {
  if (tool.alwaysOn) return
  const next = new Set(enabledSet.value)
  if (next.has(tool.name)) {
    next.delete(tool.name)
  } else {
    next.add(tool.name)
  }
  enabledSet.value = next
  persist()
}

const enableAll = () => {
  enabledSet.value = new Set(tools.value.map(t => t.name))
  persist()
}

const restoreDefault = () => {
  // 恢复为「未配置」（null），使用注册表默认值，未来新增工具也自动纳入
  store.agentTools = null
  store.saveConfig()
  skillManager.setEnabledTools(null)
  loadEnabled()
}

const sandboxLabel = (tool: AgentToolInfo): string => {
  const zh = store.locales === 'zh'
  switch (tool.sandboxPreference) {
    case 'readonly': return zh ? '只读' : 'Read-only'
    case 'workspace-write': return zh ? '工作区写入' : 'Workspace'
    case 'full-access': return zh ? '完全访问' : 'Full Access'
    default: return zh ? '无限制' : 'None'
  }
}

const approvalLabel = (tool: AgentToolInfo): string => {
  const zh = store.locales === 'zh'
  switch (tool.approvalRequirement) {
    case 'on-request': return zh ? '请求时询问' : 'On Request'
    case 'forbidden': return zh ? '禁止' : 'Forbidden'
    default: return zh ? '自动' : 'Auto'
  }
}

onMounted(() => {
  loadEnabled()
})

// store.agentTools 被外部修改时同步 UI
watch(() => store.agentTools, () => {
  loadEnabled()
})
</script>

<style scoped>
.tool-settings {
  display: flex; flex-direction: column;
  height: 100%; min-height: 0;
  color: var(--fontColor);
}
/* 自包含样式（Set.vue 的 scoped 样式不会透传，需在此定义） */
.tool-settings .settings-group {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;  padding: 8px;
}
/* 标题行：h3 在左，工具列表头部在右（统一参照 h3 标题样式） */
.group-title-row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
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
.tool-settings .form-group {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  margin-bottom: 8px;
  flex-shrink: 0;
}
.tool-settings .config-description {
  flex: 1;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.8;
}

/* 工具列表头部（位于标题行右侧） */
.tool-list-head {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  flex-shrink: 0; min-width: 0;
}
.tool-head-info {
  flex: none; min-width: 0;
  display: flex; align-items: baseline; gap: 6px;
}
.tool-head-title {
  font-size: 11px; opacity: 0.9; font-weight: 600;
  white-space: nowrap; flex-shrink: 0;
}
.tool-head-desc {
  font-size: 10px; opacity: 0.6;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0; max-width: 220px;
}
.tool-actions { display: flex; gap: 5px; flex-shrink: 0; }
/* 图标按钮：默认仅显示图标（无边框），悬停 title 显示说明 */
.icon-btn {
  width: 23px; height: 23px;
  margin: 0; padding: 0;
  border: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px;
}

/* 工具列表（占满剩余空间，内部滚动，2-3 列网格） */
.tool-settings .tool-list-group {
  flex: 1; min-height: 0; display: flex; flex-direction: column; margin-bottom:0px
}
.tool-list {
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 6px;
  align-content: start;
  overflow-y: auto; padding-right: 2px; width: 100%;
}
.tool-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor);
  transition: all .12s;
  min-width: 0;
}
.tool-item:hover { border-color: var(--fontActiveColor); }
.tool-item.disabled { opacity: 0.55; }

.tool-icon {
  width: 32px; height: 32px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  border-radius: 5px; color: var(--fontActiveColor); font-size: 15px;
}
.tool-icon.muted { background: color-mix(in srgb, var(--fontColor) 8%, transparent); color: var(--fontColor); }

.tool-info { flex: 1; min-width: 0; }
.tool-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tool-name { font-size: 12px; font-weight: 600; }
.tool-key {
  font-size: 10px; padding: 0 4px;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  border: 1px solid var(--borderColor); border-radius: 3px;
  color: var(--fontActiveColor); font-family: Consolas, monospace;
}
.tool-badge {
  font-size: 9px; padding: 0 5px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor);
}
.tool-desc { font-size: 10px; opacity: 0.75; margin-top: 1px; }
.tool-meta { display: flex; gap: 10px; margin-top: 2px; }
.meta-item { font-size: 9px; opacity: 0.6; display: inline-flex; align-items: center; gap: 3px; }

/* 开关 */
.tool-toggle {
  width: 30px; height: 16px; border-radius: 8px; flex-shrink: 0;
  background: var(--borderColor); position: relative; cursor: pointer;
  transition: all .15s;
}
.tool-toggle .toggle-knob {
  position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.tool-toggle.on { background: var(--fontActiveColor); }
.tool-toggle.on .toggle-knob { left: 16px; }
.tool-toggle.always-on { cursor: default; opacity: 0.8; }
.tool-toggle.always-on.on { background: color-mix(in srgb, var(--fontActiveColor) 55%, transparent); }

/* 滚动条 */
.tool-list::-webkit-scrollbar { width: 4px; }
.tool-list::-webkit-scrollbar-thumb { background: var(--borderColor); border-radius: 2px; }
</style>
