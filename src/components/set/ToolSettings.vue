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
            <span
              v-if="isDefaultWhitelist"
              class="tool-head-badge"
              :title="store.locales === 'zh'
                ? '当前是「默认」态：未写入显式白名单，按注册表默认启用。组内全开 / 全关会写成显式名单（可用右侧「恢复默认」还原）。'
                : 'Currently “default”: no explicit whitelist is stored, registry defaults apply. Group All / None writes an explicit list (use Reset Default to undo).'"
            >{{ store.locales === 'zh' ? '默认' : 'Default' }}</span>
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

      <!-- 工具列表（白名单配置）：按能力域分组，行样式仍由本面板决定（见 ToolGroupList 的 #row 插槽） -->
      <div class="form-group tool-list-group">
        <ToolGroupList class="tool-groups" :rows="groupRows" layout="grid" @bulk="applyBulk">
          <template #row="{ row }">
            <div class="tool-item" :class="{ disabled: !row.on && !row.alwaysOn }">
              <!-- 上半：图标 / 标题（名称 + 工具名 + 徽标）/ 沙箱与审批 / 开关 -->
              <div class="tool-main">
                <div class="tool-icon" :class="{ muted: !row.on && !row.alwaysOn }">
                  <i :class="'fa ' + row.icon"></i>
                </div>
                <div class="tool-info">
                  <div class="tool-name-row">
                    <span class="tool-name">{{ row.srcKind === 'plugin' ? row.name : (store.locales === 'zh' ? row.labelZh : row.labelEn) }}</span>
                    <code v-if="row.srcKind !== 'plugin'" class="tool-key">{{ row.name }}</code>
                    <span v-if="row.alwaysOn" class="tool-badge always-on">{{ store.locales === 'zh' ? '核心' : 'Core' }}</span>
                    <!-- 来源标识：来自某个插件（默认关闭，勾选后通用智能体才能调用） -->
                    <span v-if="row.srcKind === 'plugin'" class="tool-badge plugin-src"
                      :title="store.locales === 'zh'
                        ? `由插件「${row.srcLabel}」提供；默认关闭，需要在这里勾选后通用智能体才能调用`
                        : `Provided by plugin “${row.srcLabel}”; off by default — tick it here so the general agent can call it`">
                      <i class="fa fa-puzzle-piece"></i> {{ row.srcLabel }}
                    </span>
                  </div>
                  <div class="tool-meta">
                    <span class="meta-item" :title="store.locales === 'zh' ? '沙箱偏好' : 'Sandbox preference'">
                      <i class="fa fa-lock"></i> {{ sandboxLabel(row) }}
                    </span>
                    <span class="meta-item" :title="store.locales === 'zh' ? '审批要求' : 'Approval requirement'">
                      <i class="fa fa-gavel"></i> {{ approvalLabel(row) }}
                    </span>
                  </div>
                </div>
                <div
                  class="tool-toggle"
                  :class="{ on: row.on, 'always-on': !!row.alwaysOn }"
                  :title="row.alwaysOn ? (store.locales === 'zh' ? '核心工具，始终启用' : 'Core tool, always enabled') : (row.on ? (store.locales === 'zh' ? '点击禁用' : 'Click to disable') : (store.locales === 'zh' ? '点击启用' : 'Click to enable'))"
                  @click="toggleTool(row)"
                >
                  <span class="toggle-knob"></span>
                </div>
              </div>
              <!-- 说明：独占底部一行，占满整卡宽度（悬停看全文），不再挤在标题与元信息之间的窄列里 -->
              <div v-if="row.description" class="tool-desc" :title="row.description">{{ row.description }}</div>
            </div>
          </template>
        </ToolGroupList>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { usestore } from '@/store'
import { getSkillManager } from '@/services/agentSkills'
import ToolGroupList from '@/components/set/ToolGroupList.vue'
import { computeEnabledTools, persistableToolNames, whitelistToolRows, type WhitelistToolRow } from '@/lib/agent/toolWhitelist'

const store = usestore()
const skillManager = getSkillManager(store)

/**
 * 工具行 = 静态注册表 + **插件工具**（后者带来源标识，见 lib/agent/toolWhitelist.ts）。
 *
 * 为什么必须并进来（方案 B）：插件工具改为"显式勾选才生效"后，**没有选任何预设的通用智能体**
 * 只受这份全局白名单约束 —— 而这里以前只认静态表 AGENT_TOOL_REGISTRY，于是插件工具
 * 既不显示、还会被当成非法名**过滤掉**，用户在这里根本没有办法让通用智能体用上插件工具。
 */
const allRows = computed<WhitelistToolRow[]>(() => whitelistToolRows())

/**
 * 渲染行：白名单行 + 当前启用态 + 归一化来源。
 * `srcKind` 统一成必填（内置 / 插件），分组外壳（ToolGroupList）按它把插件工具归到「MCP 与插件」。
 */
type ManageToolRow = Omit<WhitelistToolRow, 'srcKind'> & {
  srcKind: 'builtin' | 'plugin'
  on: boolean
}

// 工具列表头部完整说明（悬停提示）
const toolHeadHint = computed(() => {
  return store.locales === 'zh'
    ? '配置「智能体」模式（Agent 循环）的全局默认工具白名单：未配置=使用全部默认工具，全部关闭=模型不调用任何工具，仅启用列表中的工具。\n「询问用户 / 更新计划 / 任务清单」也可在此开关。\n「Agent 预设」模式使用预设自身的能力槽配置，不受此白名单影响。\n「PTC 程序化调用」模式自动启用 run_code（呈现工具，不在此配置）；其程序内 SDK 可用的能力 = 本白名单。预设把「呈现方式」设为 PTC 时同理（自动启用 run_code，程序内 SDK 可用能力 = 该预设启用的工具）。'
    : 'Configure the global default tool whitelist for the Agent Loop mode: unset = all default tools, all off = no tools callable, list = only listed tools.\nAsk User / Update Plan / Update Todo can also be toggled here.\n"Agent Preset" mode uses each preset\'s own capability slots, unaffected by this whitelist.\nPTC (programmatic call) mode enables run_code automatically (a presentation tool, not configured here); the capabilities available to its in-program SDK = this whitelist. The same holds when a preset\'s presentation is set to PTC (run_code is enabled automatically; the in-program SDK exposes the tools that preset enables).'
})

const tools = computed<WhitelistToolRow[]>(() => allRows.value)

// 当前启用集合（响应式）
const enabledSet = ref<Set<string>>(new Set())

/** 是否「默认」态（未写入显式白名单）：判定与 computeEnabledTools 一致（非数组即默认） */
const isDefaultWhitelist = computed(() => !Array.isArray(store.agentTools))

/** 传给分组外壳的行（顺序沿用注册表，组内顺序因此稳定） */
const groupRows = computed<ManageToolRow[]>(() => allRows.value.map((row) => ({
  ...row,
  on: enabledSet.value.has(row.name),
  srcKind: row.srcKind === 'plugin' ? 'plugin' : 'builtin',
})))

// 加载当前启用的工具（优先 store 持久化配置，其次注册表默认）；规则见 lib/agent/toolWhitelist.ts
const loadEnabled = () => {
  enabledSet.value = computeEnabledTools(store.agentTools, allRows.value)
}

// 持久化当前启用集合到 store（alwaysOn 不落盘；插件工具要落盘，否则重启即丢）
const persist = () => {
  const names = persistableToolNames(enabledSet.value, allRows.value)
  store.agentTools = names
  store.saveConfig()
  // 同步到 SkillManager 单例
  skillManager.setEnabledTools(names)
}

const toggleTool = (tool: ManageToolRow) => {
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

/**
 * 组内全开 / 全关：只改传进来的行（分组外壳过滤后交给我们的可见行），恒开工具跳过。
 * 注意这会把白名单从「默认（null）」落成显式名单 —— 头部因此有「默认 / 显式」提示，
 * 想回到默认态用「恢复默认」。
 */
const applyBulk = ({ rows, on }: { rows: ManageToolRow[]; on: boolean }) => {
  const next = new Set(enabledSet.value)
  for (const row of rows) {
    if (row.alwaysOn) continue
    if (on) next.add(row.name)
    else next.delete(row.name)
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

const sandboxLabel = (tool: ManageToolRow): string => {
  const zh = store.locales === 'zh'
  switch (tool.sandboxPreference) {
    case 'readonly': return zh ? '只读' : 'Read-only'
    case 'workspace-write': return zh ? '工作区写入' : 'Workspace'
    case 'full-access': return zh ? '完全访问' : 'Full Access'
    default: return zh ? '无限制' : 'None'
  }
}

const approvalLabel = (tool: ManageToolRow): string => {
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

// 插件工具名单变化（启用/停用插件）时重新裁决：停用后它的工具要从列表与启用集里消失
watch(allRows, () => {
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
/* 「默认 / 显式」态徽标：写在白名单里的是 null 还是具体名单，用户要能一眼看出来 */
.tool-head-badge {
  font-size: 9px; line-height: 1.5; padding: 0 5px; border-radius: 3px;
  border: 1px solid var(--borderColor); color: var(--fontColor);
  opacity: 0.7; flex-shrink: 0; cursor: default;
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

/* 工具列表（占满剩余空间；分组 / 搜索 / 批量由 ToolGroupList 负责，行样式仍在下方） */
.tool-settings .tool-list-group {
  flex: 1; min-height: 0; display: flex; flex-direction: column; margin-bottom:0px;
  /* 本组是 align-items:flex-start（上面 .form-group 的默认），子级必须自己撑满，
     否则分组外壳会被收缩到内容宽度，网格只算得出两列、右边剩一大片空白 */
  align-items: stretch;
}
.tool-groups { flex: 1; min-height: 0; width: 100%; }
.tool-item {
  display: flex; flex-direction: column; gap: 3px;
  padding: 6px 8px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--menuColor);
  transition: all .12s;
  min-width: 0;
}
.tool-item:hover { border-color: var(--fontActiveColor); }
.tool-item.disabled { opacity: 0.55; }

/* 上半行：图标 / 标题与元信息 / 开关 */
.tool-main { display: flex; align-items: center; gap: 8px; min-width: 0; }

.tool-icon {
  width: 28px; height: 28px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  border-radius: 5px; color: var(--fontActiveColor); font-size: 13px;
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
/* 插件来源徽标：同样用主题变量，深色下不依赖反色 */
.tool-badge.plugin-src {
  display: inline-flex; align-items: center; gap: 3px;
  max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border: 1px solid var(--fontActiveColor);
  background: transparent;
}
/* 说明独占卡片底部一行：整卡宽度、单行省略，悬停 title 看全文（比挤在窄列里换行更紧凑） */
.tool-desc {
  font-size: 10px; opacity: 0.7; line-height: 1.3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  width: 100%; min-width: 0; cursor: default;
  /* 同一网格行里卡片被拉齐高度时，说明统一压在底部 */
  margin-top: auto;
}
.tool-meta { display: flex; gap: 10px; margin-top: 1px; }
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
</style>
