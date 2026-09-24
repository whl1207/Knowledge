<!-- AgentPreset.vue - Agent 预设：常用 Agent 模板库管理 -->
<template>
  <div class="agent-preset">
    <!-- ====== 左侧：预设列表（ToDo 风格 top-toolbar：搜索 / 新建 / 打开文件夹） ====== -->
    <div class="contact-sidebar">
      <div class="top-toolbar contact-toolbar">
        <div class="contact-actions-row">
          <button class="toolbar-action-btn" @click="addPreset" :title="store.locales === 'en' ? 'New Preset' : '新建预设'">
            <i class="fa fa-plus"></i>
          </button>
          <button class="toolbar-action-btn" @click="openPresetFolder" :title="store.locales === 'en' ? 'import all .agent files' : '导入其中所有 .agent 文件'">
            <i class="fa fa-download"></i>
          </button>
          <button class="toolbar-action-btn" @click="exportAllPresets" :title="store.locales === 'en' ? 'Export all presets to folder' : '导出全部预设到文件夹'">
            <i class="fa fa-upload"></i>
          </button>
          <button class="toolbar-action-btn" @click="importAgentFile" :title="store.locales === 'en' ? 'Import .agent file' : '导入 .agent 文件'">
            <i class="fa fa-file-o"></i>
          </button>
        </div>
        <div class="notes-search-box">
          <i class="fa fa-search"></i>
          <input v-model="presetKeyword" class="notes-search-input"
            :placeholder="store.locales === 'en' ? 'Search presets' : '搜索预设'" />
          <div v-if="presetKeyword" class="notes-search-clear" @click="presetKeyword = ''" :title="store.locales === 'en' ? 'Clear' : '清除'">
            <i class="fa fa-times-circle"></i>
          </div>
        </div>
      </div>
      <div class="contact-sidebar-list scoll">
        <!-- 通用智能体内置项：固定置顶，不可删除 / 拖动 / 右键菜单，仅可调整循环轮数 -->
        <div
          class="contact-item general-preset-item"
          :class="{ active: selectedId === GENERAL_PRESET_ID }"
          @click="selectPreset(GENERAL_PRESET_ID)"
          @contextmenu.prevent.stop
          :title="store.locales === 'en' ? 'General agent (built-in; only loop rounds adjustable)' : '通用智能体（内置，仅可调整循环轮数）'"
        >
          <div class="contact-item-avatar"><i class="fa fa-android"></i></div>
          <div class="contact-item-info">
            <span class="contact-item-name">{{ store.locales === 'en' ? 'General Agent' : '通用智能体' }}</span>
            <span class="contact-item-tags"><span class="contact-tag-chip">{{ store.locales === 'en' ? 'built-in' : '内置' }}</span></span>
          </div>
          <span class="contact-item-lock" :title="store.locales === 'en' ? 'Built-in, cannot be deleted' : '内置项，不可删除'"><i class="fa fa-lock"></i></span>
        </div>
        <div v-if="filteredContacts.length === 0" class="empty-hint" style="height:auto;padding:16px 0;">
          <i class="fa fa-address-book-o" style="font-size:20px;"></i>
          <span>{{ store.locales === 'en' ? 'No matching presets' : (presetKeyword ? '无匹配预设' : '暂无 Agent 预设，点击上方 + 新建') }}</span>
        </div>
        <draggable
          v-model="store.agentPresets"
          item-key="id"
          class="contact-drag-list"
          :animation="150"
          ghost-class="contact-item-ghost"
        >
          <template #item="{ element }">
            <div
              v-show="matchesKeyword(element)"
              class="contact-item" :class="{ active: selectedId === element.id }"
              @click="selectPreset(element.id)"
              @contextmenu.prevent="showPresetMenu($event, element)">
              <div class="contact-item-avatar"><i class="fa fa-user"></i></div>
              <div class="contact-item-info">
                <span class="contact-item-name">{{ element.name || (store.locales === 'en' ? 'Unnamed' : '未命名') }}</span>
                <span v-if="element.tags && element.tags.length" class="contact-item-tags">
                  <span v-for="t in element.tags.slice(0, 3)" :key="t" class="contact-tag-chip">{{ t }}</span>
                  <span v-if="element.tags.length > 3" class="contact-tag-more">+{{ element.tags.length - 3 }}</span>
                </span>
              </div>
              <button class="contact-item-del" @click.stop="removePreset(element.id)" :title="store.locales === 'en' ? 'Delete' : '删除'">
                <i class="fa fa-trash"></i>
              </button>
            </div>
          </template>
        </draggable>
      </div>
    </div>

    <!-- ====== 右侧：预设配置编辑 ====== -->
    <div class="contact-content">
      <div v-if="!selected" class="empty-hint" style="height:100%;">
        <i class="fa fa-address-book-o" style="font-size:36px;"></i>
        <span>{{ store.locales === 'en' ? 'Select a preset on the left to edit' : '选择左侧 Agent 预设进行编辑' }}</span>
      </div>
      <div v-else class="ae-body scoll">
        <!-- 通用智能体专用面板：仅可调整循环轮数，其余为系统内置、不可修改 -->
        <div v-if="isGeneral" class="cfg-row column cfg-box scoll">
          <div class="general-panel-head">
            <i class="fa fa-android"></i>
            <span>{{ store.locales === 'en' ? 'General Agent' : '通用智能体' }}</span>
            <span class="general-panel-badge">{{ store.locales === 'en' ? 'Built-in' : '内置' }}</span>
          </div>
          <div class="general-panel-desc">
            {{ store.locales === 'en'
              ? 'The general agent is the default autonomous agent used when no preset is bound. Other options are system built-in and cannot be edited here; only the loop rounds can be adjusted.'
              : '通用智能体是未绑定预设时聊天窗口默认使用的自主规划智能体。其他配置为系统内置、不可修改，此处仅可调整循环轮数。' }}
          </div>
          <div class="exec-config-row">
            <div class="exec-config-item">
              <span class="exec-config-label">{{ store.locales === 'en' ? 'Loop Rounds (Max Steps)' : '循环轮数（最大步数）' }}</span>
              <input type="number" v-model.number="store.generalAgentMaxSteps" :min="1" :max="AGENT_MAX_STEPS_MAX" step="1" class="exec-config-input"
                @change="store.saveConfig()" />
              <span class="exec-config-hint">{{ store.locales === 'en' ? `max tool/thinking steps per turn (default ${DEFAULT_AGENT_MAX_STEPS})` : `单个回合最大工具/思考步数（默认 ${DEFAULT_AGENT_MAX_STEPS}）` }}</span>
            </div>
          </div>
          <div class="loop-help-block">
            <i class="fa fa-lock"></i>
            <span>{{ store.locales === 'en' ? 'This built-in item cannot be deleted; tools / MCP and other capabilities are adjusted in the corresponding global settings below.' : '该内置项不可删除；工具 / MCP 等能力请通过下方对应的全局设置调整。' }}</span>
          </div>
          <div class="loop-help-block general-link-hint">
            <i class="fa fa-wrench"></i>
            <span class="general-link-text">{{ store.locales === 'en'
              ? 'Available tools: follow the global tool whitelist in "Settings → Tools → Management"; the default tool set is used when none is configured.'
              : '可用工具：通用智能体使用「设置 → 工具 → 管理（工具管理）」中的全局工具白名单；未配置时使用默认工具全集。' }}</span>
            <button class="general-link-btn" @click="store.settingsNav = 'tools'" :title="store.locales === 'en' ? 'Open Tool Management' : '打开工具管理'">
              {{ store.locales === 'en' ? 'Go' : '前往' }} <i class="fa fa-chevron-right"></i>
            </button>
          </div>
          <div class="loop-help-block general-link-hint">
            <i class="fa fa-plug"></i>
            <span class="general-link-text">{{ store.locales === 'en'
              ? 'MCP services: follow "Settings → Tools → MCP"; only enabled services can be called by the general agent.'
              : 'MCP 服务：通用智能体自动调用「设置 → 工具 → MCP（MCP 服务）」中已启用的服务。' }}</span>
            <button class="general-link-btn" @click="store.settingsNav = 'mcp'" :title="store.locales === 'en' ? 'Open MCP Settings' : '打开 MCP 服务设置'">
              {{ store.locales === 'en' ? 'Go' : '前往' }} <i class="fa fa-chevron-right"></i>
            </button>
          </div>
          <div class="loop-help-block general-link-hint">
            <i class="fa fa-book"></i>
            <span class="general-link-text">{{ store.locales === 'en'
              ? 'Skills: manage in "Settings → Skills → Management"; disabled skills are not injected into the general agent.'
              : '技能：在「设置 → 技能 → 管理（技能管理）」中启用/禁用；被禁用的技能不会注入通用智能体。' }}</span>
            <button class="general-link-btn" @click="store.settingsNav = 'agentskill'" :title="store.locales === 'en' ? 'Open Skill Management' : '打开技能管理'">
              {{ store.locales === 'en' ? 'Go' : '前往' }} <i class="fa fa-chevron-right"></i>
            </button>
          </div>
        </div>
        <!-- 完整编辑面板（普通预设） -->
        <template v-else>
        <!-- Tab 栏：技能/MCP/知识库在对应能力开启后才可进入（参考 SwarmAgentCard ae-tabs）；窄宽度时只显示图标 -->
        <div class="ae-tabs">
          <button class="ae-tab" :class="{ on: activeTab === 'general' }" @click="activeTab = 'general'">
            <i class="fa fa-user"></i> <span class="ae-tab-text">{{ store.locales === 'en' ? 'General' : '通用' }}</span>
          </button>
          <button class="ae-tab" :class="{ on: activeTab === 'tools' }" @click="activeTab = 'tools'"
            :title="store.locales === 'en' ? 'Tool capabilities for this preset' : '该预设的工具能力槽'">
            <i class="fa fa-wrench"></i> <span class="ae-tab-text">{{ store.locales === 'en' ? 'Tools' : '工具' }}</span>
          </button>
          <button class="ae-tab" :class="{ on: activeTab === 'skills', disabled: !skillsEnabled }"
            :title="skillsEnabled ? '' : (store.locales === 'en' ? 'Enable Skill in General first' : '请先在「通用」开启技能')"
            @click="skillsEnabled && (activeTab = 'skills')">
            <i class="fa fa-book"></i> <span class="ae-tab-text">{{ store.locales === 'en' ? 'Skills' : '技能' }}</span>
          </button>
          <button class="ae-tab" :class="{ on: activeTab === 'mcp', disabled: !mcpEnabled }"
            :title="mcpEnabled ? '' : (store.locales === 'en' ? 'Enable MCP in General first' : '请先在「通用」开启 MCP')"
            @click="mcpEnabled && (activeTab = 'mcp')">
            <i class="fa fa-plug"></i> <span class="ae-tab-text">MCP</span>
          </button>
          <button class="ae-tab" :class="{ on: activeTab === 'kb', disabled: !kbEnabled }"
            :title="kbEnabled ? '' : (store.locales === 'en' ? 'Enable Knowledge Base in General first' : '请先在「通用」开启知识库')"
            @click="kbEnabled && (activeTab = 'kb')">
            <i class="fa fa-database"></i> <span class="ae-tab-text">{{ store.locales === 'en' ? 'KB' : '知识库' }}</span>
          </button>
          <button class="ae-tab" :class="{ on: activeTab === 'loop' }" @click="activeTab = 'loop'"
            :title="store.locales === 'en' ? 'Agent loop prompt & execution settings' : 'Agent 循环提示词与执行参数'">
            <i class="fa fa-refresh"></i> <span class="ae-tab-text">{{ store.locales === 'en' ? 'Loop' : '循环' }}</span>
          </button>
        </div>

        <!-- 通用：基础配置（名称 / 来源 / 模型 / 温度 / 标签 / 系统提示） -->
        <div v-if="activeTab === 'general'" class="ae-tab-body">
          <div class="cfg-row column cfg-box scoll">
            <div class="cfg-row"><label>{{ store.locales === 'en' ? 'Name' : '名称' }}</label><input v-model="selected.name" :placeholder="store.locales === 'en' ? 'Agent Name' : 'Agent 名称'" /></div>
            <div class="cfg-row">
              <label>{{ store.locales === 'en' ? 'Source' : '来源' }}</label>
              <select v-model="selected.llmType" @change="onLlmTypeChange">
                <option v-for="t in llmTypes" :key="t" :value="t">{{ llmTypeLabel(t) }}</option>
              </select>
            </div>
            <div class="cfg-row">
              <label>{{ store.locales === 'en' ? 'Model' : '模型' }}</label>
              <select v-model="selected.model" style="flex:1;min-width:0">
                <option value="">{{ store.locales === 'en' ? '-- Select Model --' : '-- 选择模型 --' }}</option>
                <option v-for="m in getModelsForAgent(selected)" :key="m" :value="m">{{ m }}</option>
              </select>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px;flex-shrink:0" @click="refreshAgentModels()"
                  :title="store.locales === 'en' ? 'Refresh model list of this source' : '刷新该来源的模型列表'">
                <i class="fa" :class="modelListLoading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
              </div>
            </div>
            <div class="cfg-row">
              <label>{{ store.locales === 'en' ? 'Temp' : '温度' }}</label>
              <input type="range" v-model.number="selected.temperature" min="0" max="2" step="0.1" style="flex:1;" />
              <span style="font-size:10px;min-width:24px;text-align:right;">{{ selected.temperature }}</span>
            </div>
            <div class="cfg-row">
              <label>{{ store.locales === 'en' ? 'Tags' : '标签' }}</label>
              <div class="preset-tags">
                <span v-for="(t, i) in selected.tags || []" :key="i" class="preset-tag" :title="store.locales === 'en' ? 'Click × to remove' : '点击 × 移除标签'">
                  {{ t }}
                  <i class="fa fa-times" @click.stop="removeTag(selected, i)"></i>
                </span>
                <input v-model="tagInput" class="preset-tag-input"
                  :placeholder="store.locales === 'en' ? 'Add tag + Enter' : '输入后回车添加标签'"
                  @keydown.enter.prevent="addTag(selected)"
                  @keydown.delete="onTagBackspace(selected)"
                  @blur="addTag(selected)" />
              </div>
            </div>
            <div class="cfg-row column system-prompt-row">
              <label>{{ store.locales === 'en' ? 'System Prompt' : '系统提示' }}</label>
              <textarea class="scoll" v-model="selected.systemPrompt" :placeholder="store.locales === 'en' ? 'e.g. You are a data analyst... (role description goes here)' : '（智能体设定直接写在此处）'" rows="15"></textarea>
            </div>
          </div>

        </div>

        <!-- 工具：逐真实工具开关（统一数据源 AGENT_TOOL_REGISTRY；写文件=write_file/replace_in_file/multi_replace、读取=read_file+search_files、网页=web_search/web_fetch 各自独立开关） -->
        <div v-if="activeTab === 'tools'" class="ae-tab-body">
          <div class="cfg-row column cfg-box">
            <div class="cap-body">
              <div class="preset-tool-list">
                <div v-for="t in toolRows" :key="t.name"
                  class="preset-tool-item"
                  :class="{ on: t.on }"
                  :title="t.description || t.name"
                  @click="togglePresetTool(t.name)">
                  <span class="preset-tool-icon"><i class="fa" :class="t.icon"></i></span>
                  <span class="preset-tool-info">
                    <span class="preset-tool-name">{{ store.locales === 'zh' ? t.labelZh : t.labelEn }}</span>
                    <code class="preset-tool-key">{{ t.name }}</code>
                    <span v-if="store.locales === 'zh'" class="preset-tool-desc">{{ t.description }}</span>
                  </span>
                  <span class="preset-tool-toggle" :class="{ on: t.on }"><i class="preset-toggle-knob"></i></span>
                </div>
              </div>
              <div class="preset-tools-hint">
                <i class="fa fa-info-circle"></i>
                {{ store.locales === 'en'
                  ? 'Each tool toggles independently (same granularity as Tool Management) and is persisted per tool. Writing = write_file / replace_in_file / multi_replace; reading = read_file / search_files; web = web_search / web_fetch. Enabling KB / MCP / Skill opens their config tabs.'
                  : '每个工具独立开关并精确持久化（与「工具管理」同粒度）。写入文件 = write_file / replace_in_file / multi_replace；读取文件 = read_file / search_files；网页 = web_search / web_fetch。开启 知识库 / MCP / 技能 后可在对应页配置。' }}
              </div>
            </div>
          </div>
        </div>

        <!-- 技能（需在「通用」开启技能库） -->
        <div v-if="activeTab === 'skills'" class="ae-tab-body">
          <div class="cfg-row column cfg-box">
            <div class="skill-box-head" style="justify-content:flex-end;">
              <div class="skill-box-actions">
                <button class="skill-bulk-btn" @click="selectAllSkills" :title="store.locales === 'en' ? 'Select all skills' : '全选所有技能'">
                  <i class="fa fa-check-square-o"></i> {{ store.locales === 'en' ? 'All' : '全选' }}
                </button>
                <button class="skill-bulk-btn" @click="selectNoneSkills" :title="store.locales === 'en' ? 'Deselect all skills' : '全部不选技能'">
                  <i class="fa fa-square-o"></i> {{ store.locales === 'en' ? 'None' : '全不选' }}
                </button>
              </div>
            </div>
            <div v-if="skillList.length === 0" class="preset-skill-empty">
              {{ store.locales === 'en' ? 'No available skills, please check skill management' : '暂无可用技能，请到「技能管理」中查看' }}
            </div>
            <div v-else class="preset-tool-list">
              <div v-for="sk in skillList" :key="sk.path"
                class="preset-tool-item"
                :class="{ on: isSkillSelected(sk.path) }"
                :title="sk.description"
                @click="onSkillSelect(sk.path)">
                <span class="preset-tool-icon"><span v-if="sk.emoji" class="preset-skill-emoji">{{ sk.emoji }}</span><i v-else class="fa fa-cube"></i></span>
                <span class="preset-tool-info">
                  <span class="preset-tool-name">{{ sk.name }}</span>
                  <span class="preset-tool-desc">{{ sk.description }}</span>
                </span>
                <span class="preset-tool-toggle" :class="{ on: isSkillSelected(sk.path) }"><i class="preset-toggle-knob"></i></span>
              </div>
            </div>
            <div class="preset-tools-hint">
              <i class="fa fa-info-circle"></i>
              {{ store.locales === 'en'
                ? 'Selected skills are available to this agent. All selected by default = same as the general agent (skill tool loads them on demand).'
                : '勾选的技能对该智能体可用；默认全选＝与通用智能体一致（skill 工具按需加载）。' }}
            </div>
          </div>
        </div>

        <!-- MCP（需在「通用」开启 MCP 控制） -->
        <div v-if="activeTab === 'mcp'" class="ae-tab-body">
          <div class="cfg-row column cfg-box">
            <div v-if="mcpServers.length === 0" class="preset-skill-empty">
              {{ store.locales === 'en' ? 'No MCP services configured. Please add them in Settings → MCP.' : '暂无 MCP 服务，请到「设置 → MCP 服务」中添加。' }}
            </div>
            <div v-else class="preset-tool-list">
              <div v-for="s in mcpServers" :key="s.id"
                class="preset-tool-item"
                :class="{ on: isMcpServerSelected(selected, s.id) }"
                :title="s.name"
                @click="toggleMcpServer(selected, s.id)">
                <span class="preset-tool-icon"><i class="fa fa-plug"></i></span>
                <span class="preset-tool-name">{{ s.name }}</span>
                <span class="preset-tool-toggle" :class="{ on: isMcpServerSelected(selected, s.id) }"><i class="preset-toggle-knob"></i></span>
              </div>
            </div>
            <div v-if="mcpEquipmentOptions.length" class="preset-tool-list">
              <div v-for="eq in mcpEquipmentOptions" :key="eq.key"
                class="preset-tool-item"
                :class="{ on: isMcpEquipmentSelected(selected, eq.key) }"
                :title="`${eq.name} (${eq.type || 'equipment'})`"
                @click="toggleMcpEquipment(selected, eq.key)">
                <span class="preset-tool-icon"><i class="fa fa-plug"></i></span>
                <span class="preset-tool-name">{{ eq.name }}</span>
                <span class="preset-tool-toggle" :class="{ on: isMcpEquipmentSelected(selected, eq.key) }"><i class="preset-toggle-knob"></i></span>
              </div>
            </div>
            <div class="preset-tools-hint">
              <i class="fa fa-info-circle"></i>
              {{ store.locales === 'en'
                ? 'Enable MCP access so this preset can call mcp_call. If no equipment is selected, the swarm relation page can assign equipment later.'
                : '开启后该预设可调用 mcp_call 工具；不勾选装备时，可由集群关系页分配装备。' }}
            </div>
          </div>
        </div>

        <!-- 知识库（需在「通用」开启访问知识库） -->
        <div v-if="activeTab === 'kb'" class="ae-tab-body">
          <div class="cfg-row column cfg-box">
            <div class="skill-box-head" style="justify-content:flex-end;">
              <div class="kb-recall-inline" :title="store.locales === 'en' ? 'Chunks per query' : '每次检索召回片段数'">
                <span class="kb-recall-label">{{ store.locales === 'en' ? 'Recall' : '召回' }}</span>
                <input type="number" v-model.number="selected.kbTopK" min="1" max="20" step="1" />
              </div>
            </div>
            <div v-if="selected.capabilities.knowledgeBaseFiles.length > 0" class="preset-tool-list">
              <div v-for="f in selected.capabilities.knowledgeBaseFiles" :key="f" class="preset-tool-item">
                <span class="preset-tool-icon"><i class="fa fa-database"></i></span>
                <span class="preset-tool-name" :title="f">{{ kbLabel(f) }}</span>
                <button class="kb-file-del" @click.stop="removeKbFile(selected, f)" :title="store.locales === 'en' ? 'Remove' : '移除'">
                  <i class="fa fa-times"></i>
                </button>
              </div>
            </div>
            <div v-else class="preset-skill-empty">
              {{ store.locales === 'en' ? 'No KB files. Click below to add.' : '未添加知识库文件，点击下方添加。' }}
            </div>
            <div class="kb-file-add" @click="addKbFile(selected)">
              <i class="fa fa-plus"></i> {{ store.locales === 'en' ? 'Add KB file' : '添加知识库文件' }}
            </div>
          </div>
        </div>

        <!-- AgentLoop：执行参数 + 未来提示词面板（兼容 Pi / Codex / Copilot / DeepSeek Harness） -->
        <div v-if="activeTab === 'loop'" class="ae-tab-body">
          <div class="cfg-row column cfg-box scoll">
            <div class="exec-config-row">
              <div class="exec-config-item">
                <span class="exec-config-label">{{ store.locales === 'en' ? 'Max Steps' : '最大步数' }}</span>
                <input type="number" v-model.number="selected.maxSteps" :min="1" :max="AGENT_MAX_STEPS_MAX" step="1" class="exec-config-input" />
                <span class="exec-config-hint">{{ store.locales === 'en' ? `per turn (default ${DEFAULT_AGENT_MAX_STEPS})` : `单个回合最大工具/思考步数（默认 ${DEFAULT_AGENT_MAX_STEPS}）` }}</span>
              </div>
              <div class="exec-config-item">
                <label class="exec-config-check">
                  <input type="checkbox" v-model="selected.seedHistory" />
                  <span>{{ store.locales === 'en' ? 'Inherit chat history' : '继承聊天上下文' }}</span>
                </label>
                <span class="exec-config-hint">{{ store.locales === 'en' ? 'seed prior messages into the agent session' : '把聊天历史写入 agent 会话（推荐开启）' }}</span>
              </div>
            </div>
            <div class="skill-box-head" style="justify-content:flex-end;">
              <select v-model="selected.loopPromptMode" class="loop-mode-select">
                <option value="auto">{{ store.locales === 'en' ? 'Auto assemble' : '自动组装' }}</option>
                <option value="sections">{{ store.locales === 'en' ? 'Sections' : '指令段' }}</option>
              </select>
            </div>

            <div v-if="selected.loopPromptMode === 'sections'" class="loop-sections-body">
              <!-- 预设模板（借鉴 Pi / Codex / Copilot / DeepSeek Harness 提示词结构） -->
              <div class="loop-templates">
                <span class="loop-templates-label">{{ store.locales === 'en' ? 'Templates:' : '预设模板：' }}</span>
                <button v-for="tp in loopTemplates" :key="tp.id" class="loop-template-btn" @click="applyLoopTemplate(tp.id)" :title="tp.desc">
                  <i class="fa" :class="tp.icon"></i> {{ tp.label }}
                </button>
                <button class="loop-template-btn danger" @click="clearLoopSections" :title="store.locales === 'en' ? 'Clear all sections' : '清除全部指令段'">
                  <i class="fa fa-trash-o"></i> {{ store.locales === 'en' ? 'Clear' : '清除' }}
                </button>
              </div>

              <div v-for="(sec, i) in selected.loopSections || []" :key="sec.id" class="loop-section">
                <div class="loop-section-head">
                  <input v-model="sec.title" :placeholder="store.locales === 'en' ? 'Section title' : '指令段标题'" class="loop-section-title" />
                  <div class="loop-section-actions">
                    <button class="loop-sec-btn" :title="store.locales === 'en' ? 'Move up' : '上移'" @click="moveLoopSection(i, -1)"><i class="fa fa-arrow-up"></i></button>
                    <button class="loop-sec-btn" :title="store.locales === 'en' ? 'Move down' : '下移'" @click="moveLoopSection(i, 1)"><i class="fa fa-arrow-down"></i></button>
                    <button class="loop-sec-btn danger" :title="store.locales === 'en' ? 'Remove' : '删除'" @click="removeLoopSection(i)"><i class="fa fa-times"></i></button>
                  </div>
                </div>
                <textarea v-model="sec.text" rows="4" class="loop-section-text scoll"
                  :placeholder="store.locales === 'en' ? 'Section content (supports {{variables}})' : '指令段正文（支持 {{变量}}）'"></textarea>
              </div>

              <button class="loop-add-section" @click="addLoopSection">
                <i class="fa fa-plus"></i> {{ store.locales === 'en' ? 'Add section' : '添加指令段' }}
              </button>

              <div class="loop-preview">
                <div class="loop-preview-head" @click="loopPreviewOpen = !loopPreviewOpen">
                  <span>{{ store.locales === 'en' ? 'Preview final prompt' : '预览最终提示词' }}</span>
                  <i class="fa" :class="loopPreviewOpen ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
                </div>
                <pre v-if="loopPreviewOpen" class="loop-preview-body scoll">{{ loopPromptPreview }}</pre>
              </div>
            </div>
            <div class="loop-help-block">
              <i class="fa" :class="selected.loopPromptMode === 'sections' ? 'fa-th-list' : 'fa-magic'"></i>
              <span>{{ selected.loopPromptMode === 'sections' ? loopGuide : loopAutoHint }}</span>
            </div>
            <div class="loop-help-block">
              <i class="fa fa-code"></i>
              <span>{{ loopVarHint }}</span>
            </div>
          </div>
        </div>
        </template>
      </div>
    </div>

    <!-- 预设右键菜单：复制 / 导出 .agent -->
    <teleport to="body">
      <div v-if="presetMenu.visible" class="preset-ctx-overlay" @click="hidePresetMenu" @contextmenu.prevent="hidePresetMenu"></div>
      <div v-if="presetMenu.visible" class="preset-ctx-menu" :style="{ left: presetMenu.x + 'px', top: presetMenu.y + 'px' }">
        <div class="menu-item" @click="duplicatePreset(presetMenu.preset); hidePresetMenu()">
          <i class="fa fa-copy"></i> {{ store.locales === 'en' ? 'Duplicate' : '复制' }}
        </div>
        <div class="menu-item" @click="exportPreset(presetMenu.preset); hidePresetMenu()">
          <i class="fa fa-download"></i> {{ store.locales === 'en' ? 'Export .agent' : '导出 .agent 文件' }}
        </div>
        <div class="menu-divider"></div>
        <div class="menu-item danger" @click="removePresetFromMenu(); hidePresetMenu()">
          <i class="fa fa-trash"></i> {{ store.locales === 'en' ? 'Delete' : '删除' }}
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import draggable from 'vuedraggable'
import { mcpManager } from '@/platform/mcpManager'
import { toolsFromCapabilities, setToolEnabled, toolOn } from '@/lib/agent/capabilities'
import { AGENT_TOOL_REGISTRY, type AgentToolInfo } from '@/services/agentSkills'
import {
  scanAgentPresets, writeAgentPreset, removeAgentPreset, agentFilePath,
  openAgentPresetFolder as openPresetFolder, exportAllAgentPresets,
} from '@/composables/useAgentPresets'
import { renderLoopSections } from '@/lib/agent/skill'
import { AGENT_MAX_STEPS_MAX, DEFAULT_AGENT_MAX_STEPS } from '@/shared/agent-loop-rounds'
import { deepSeekStyleOf, normalizeLlmTypeList } from '@/shared/llmSources'

const store = usestore()

// ====== 搜索 ======
const presetKeyword = ref('')
const matchesKeyword = (c: any): boolean => {
  const kw = presetKeyword.value.trim().toLowerCase()
  if (!kw) return true
  const tags = Array.isArray(c.tags) ? c.tags.join(' ') : ''
  return (c.name || '').toLowerCase().includes(kw) ||
    (c.systemPrompt || '').toLowerCase().includes(kw) ||
    tags.toLowerCase().includes(kw)
}
const filteredContacts = computed(() => (store.agentPresets as any[]).filter(matchesKeyword))

// ====== 标签 ======
const tagInput = ref('')
/** 添加标签：回车 / 失焦触发；去首尾空格、去重 */
const addTag = (agent: AgentPreset | undefined) => {
  if (!agent) return
  const val = tagInput.value.trim()
  tagInput.value = ''
  if (!val) return
  if (!Array.isArray(agent.tags)) agent.tags = []
  if (!agent.tags.some(t => t.toLowerCase() === val.toLowerCase())) {
    agent.tags.push(val)
  }
}
/** 移除标签 */
const removeTag = (agent: AgentPreset | undefined, index: number) => {
  if (!agent || !Array.isArray(agent.tags)) return
  agent.tags.splice(index, 1)
}
/** 删除键：输入框为空时删除最后一个标签 */
const onTagBackspace = (agent: AgentPreset | undefined) => {
  if (!agent || tagInput.value !== '') return
  if (Array.isArray(agent.tags) && agent.tags.length > 0) {
    agent.tags.pop()
  }
}

// ====== 类型 ======
interface AgentPresetCapabilities {
  readFiles: boolean
  executeCode: boolean
  webSearch: boolean
  accessKnowledgeBase: boolean
  browseWebsites: boolean
  writeFiles: boolean
  listDirs: boolean
  runShell: boolean
  runSubagent: boolean
  skills: boolean
    askUser: boolean
    updatePlan: boolean
    updateTodo: boolean
      mcpAccess: boolean
      mcpServerIds?: string[]
      mcpEquipmentIds?: string[]
      /** 逐工具启用集（精确到工具名；缺省/undefined = 旧模式，由下方能力槽布尔推导） */
      enabledTools?: string[]
  knowledgeBaseFiles: string[]
}
interface AgentPreset {
  id: string
  name: string
  /** 预设标签（用于按名称/标签搜索） */
  tags: string[]
  llmType: string
  model: string
  systemPrompt: string
  temperature: number
  /** 知识库检索召回切片数（accessKnowledgeBase 启用时生效） */
  kbTopK?: number
  /** 多选技能路径数组（新建预设默认全选，与通用智能体一致） */
  selectedSkills: string[]
  capabilities: AgentPresetCapabilities
  /** Agent 循环：单个回合最大 step 数（默认 500；未配置时回退通用智能体的循环轮数） */
  maxSteps?: number
  /** 是否继承聊天窗口上下文（默认 true） */
  seedHistory?: boolean
  /** AgentLoop 提示词模式：'auto'=自动组装（默认）；'sections'=使用下方指令段自定义组装 */
  loopPromptMode?: 'auto' | 'sections'
  /** 指令段（loopPromptMode='sections' 时生效）：按序渲染为 system prompt，支持 {{变量}} */
  loopSections?: Array<{ id: string; title: string; text: string }>
}

const defaultCapabilities = (): AgentPresetCapabilities => ({
  readFiles: false,
  executeCode: false,
  webSearch: false,
  accessKnowledgeBase: false,
  browseWebsites: false,
  writeFiles: false,
  listDirs: false,
  runShell: false,
  runSubagent: false,
  skills: false,
    askUser: true,
    updatePlan: true,
    updateTodo: true,
      mcpAccess: false,
      mcpServerIds: [],
      mcpEquipmentIds: [],
      enabledTools: ['ask_user', 'update_plan', 'update_todo'],
  knowledgeBaseFiles: [],
})

// 工具标签页：逐真实工具行（数据源 AGENT_TOOL_REGISTRY，与「工具管理」面板同粒度）
type ToolRow = AgentToolInfo & { on: boolean }
const toolRows = computed<ToolRow[]>(() =>
  AGENT_TOOL_REGISTRY.map((t) => ({ ...t, on: toolOn(selected.value?.capabilities, t.name) }))
)

/** 逐工具开关；关闭 kb_search / mcp_call 时联动清空已关联项（对齐旧 onCapToggle 行为） */
const togglePresetTool = (tool: string) => {
  const caps = selected.value?.capabilities as any
  if (!caps) return
  const wasOn = toolOn(caps, tool)
  setToolEnabled(caps, tool, !wasOn)
  if (wasOn) {
    if (tool === 'mcp_call') {
      caps.mcpServerIds = []
      caps.mcpEquipmentIds = []
      mcpEquipmentOptions.value = []
    } else if (tool === 'kb_search') {
      caps.knowledgeBaseFiles = []
    }
  }
}

// ====== LLM 来源 ======
const llmTypes = computed<string[]>(() => {
  const all: string[] = normalizeLlmTypeList(store.AIconfig.llm.types || ['ollama', 'openai', 'lmstudio', 'anthropic', 'google', 'azure', 'custom'])
  const enabled = all.filter((t: string) => !store.isLlmSourceDisabled(t))
  // custom 仅在存在已启用的自定义来源时显示
  return enabled.filter((t: string) => t !== 'custom' || store.hasEnabledCustomSource())
})
const llmTypeLabel = (t: string) => {
  const map: Record<string, string> = {
    ollama: 'Ollama', openai: 'OpenAI', lmstudio: 'LM Studio',
    deepseek: 'DeepSeek',
    gpustack: 'GPUStack',
    anthropic: 'Anthropic', google: 'Google', azure: 'Azure',
  }
  if (t === 'custom') return customSourceName()
  return map[t] || t
}
/** 自定义来源显示名：预设未绑定具体来源，跟随全局当前激活来源（与主聊天一致）；空名回退默认 */
const customSourceName = (): string => {
  const c = store.AIconfig.llm.custom
  const sources = Array.isArray(c?.sources) ? c.sources : []
  const src = sources[typeof c?.activeIndex === 'number' ? c.activeIndex : 0]
  const name = src && src.name
  return (name && String(name).trim()) ? String(name).trim() : (store.locales === 'en' ? 'Custom' : '自定义')
}
const getModelsForAgent = (agent: AgentPreset): string[] => {
  const cfg = store.AIconfig.llm
  if (!cfg) return []
  const type = agent.llmType || cfg.type
  let list: string[] = []
  switch (type) {
    case 'ollama':
      list = (cfg.ollama?.available_models || []).map((m: any) => m.name || m).filter(Boolean)
      if (!list.length && cfg.ollama?.model) list = [String(cfg.ollama.model)]
      break
    case 'lmstudio':
      list = (cfg.lmstudio?.available_models || []).filter(Boolean)
      if (!list.length && cfg.lmstudio?.model) list = [String(cfg.lmstudio.model)]
      break
    case 'openai':
      list = (cfg.openai?.available_models || []).length
        ? cfg.openai.available_models
        : [String(cfg.openai?.model || '')]; break
    case 'deepseek':
    case 'deepseek-responses': {
      // 单来源：模型列表取当前接口样式对应的配置块（历史别名统一按 responses）
      const dsCfg: any = deepSeekStyleOf(agent.llmType, cfg.deepseek) === 'responses' ? cfg.deepseekResponses : cfg.deepseek
      list = (dsCfg?.available_models || []).filter(Boolean) as string[]
      if (!list.length) list = [String(dsCfg?.model || 'deepseek-flash')]
      break
    }
    case 'gpustack':
      list = (cfg.gpustack?.available_models || []).filter(Boolean) as string[]
      if (!list.length && cfg.gpustack?.model) list = [String(cfg.gpustack.model)]
      break
    // 无模型列表接口的类型：以「当前配置的 model / 默认候选」作为可选值，避免下拉空白
    case 'anthropic': list = [String(cfg.anthropic?.model || 'claude-3-haiku-20240307')]; break
    case 'google': list = [String(cfg.google?.model || 'gemini-pro')]; break
    case 'azure': list = [String(cfg.azure?.deployment || '')]; break
    case 'custom': {
      // 预设未绑定具体来源：使用全局激活来源（与通用智能体一致）；优先其已拉取的模型列表，空则回退当前模型
      const c = cfg.custom
      const sources = Array.isArray(c?.sources) ? c.sources : []
      const src = sources[typeof c?.activeIndex === 'number' ? c.activeIndex : 0]
      const models = (src && Array.isArray(src.available_models))
        ? src.available_models.filter(Boolean)
        : (Array.isArray(c?.available_models) ? c.available_models.filter(Boolean) : [])
      list = models.length ? models : [String(c?.model || '')]
      break
    }
    default: return []
  }
  // 合并当前预设已保存的模型名（可能不在候选列表，如手填/custom），保证下拉能显示已选值
  const saved = String(agent?.model || '').trim()
  if (saved && !list.includes(saved)) list = [saved, ...list]
  return list.filter(Boolean)
}

// ====== 技能列表 ======
interface SkillInfo { name: string; path: string; description: string; emoji: string }
const skillList = ref<SkillInfo[]>([])
const loadSkillList = async () => {
  if (!store.skillsPath) { skillList.value = []; return }
  try {
    const loaded = await window.ipcRenderer.invoke('loadSkills', store.skillsPath)
    const disabled = new Set(store.disabledSkills || [])
    skillList.value = (loaded || [])
      .filter((s: any) => !disabled.has(s.name))
      .map((s: any) => ({
        name: s.name,
        path: s.path,
        description: s.description || '',
        emoji: s.metadata?.emoji || '',
      }))
  } catch { skillList.value = [] }
}
/** 技能卡片（与工具管理一致）：判断是否已选中 */
const isSkillSelected = (path: string) => (selected.value?.selectedSkills || []).includes(path)

/** 技能卡片：点击切换选中状态 */
const onSkillSelect = (path: string) => {
  if (!selected.value) return
  const arr = selected.value.selectedSkills || []
  selected.value.selectedSkills = arr.includes(path) ? arr.filter(p => p !== path) : [...arr, path]
}

/** 全选：勾选所有可用技能（＝与通用智能体一致） */
const selectAllSkills = () => {
  if (!selected.value) return
  selected.value.selectedSkills = skillList.value.map(s => s.path)
}

/** 全部不选 */
const selectNoneSkills = () => {
  if (!selected.value) return
  selected.value.selectedSkills = []
}

// ====== 知识库文件列表 ======
interface KbFileInfo { label: string; path: string }
const knowledgeBaseList = ref<KbFileInfo[]>([])
const scanKnowledgeBases = async () => {
  if (!store.root) return
  try {
    const result = await window.ipcRenderer.invoke('getFilesRelation', store.root, 1)
    const fileList: any[] = result?.fileList || []
    knowledgeBaseList.value = fileList
      .filter((f: any) => f.path?.endsWith('.kb'))
      .map((f: any) => ({ label: f.label || f.path.split(/[/\\]/).pop(), path: f.path }))
  } catch { /* 静默忽略 */ }
}

// ====== MCP 配置（多服务开关版） ======
interface McpEquipmentOption { key: string; serverId: string; id: string; name: string; type: string }
const mcpServers = computed(() => (store.mcpServers || []).filter((s: any) => s && s.transport !== 'inmemory' && s.enabled !== false))
const mcpEquipmentOptions = ref<McpEquipmentOption[]>([])

const isMcpServerSelected = (agent: AgentPreset, serverId: string) =>
  (agent.capabilities.mcpServerIds || []).includes(serverId)

const toggleMcpServer = async (agent: AgentPreset, serverId: string) => {
  const arr = agent.capabilities.mcpServerIds || []
  agent.capabilities.mcpServerIds = arr.includes(serverId) ? arr.filter(x => x !== serverId) : [...arr, serverId]
  // 关闭服务时，清空该服务下已选装备
  if (!agent.capabilities.mcpServerIds.includes(serverId)) {
    agent.capabilities.mcpEquipmentIds = (agent.capabilities.mcpEquipmentIds || []).filter(k => !k.startsWith(`${serverId}:`))
  }
  await loadMcpEquipments(agent)
}

const loadMcpEquipments = async (agent: AgentPreset) => {
  const serverIds = agent.capabilities.mcpServerIds || []
  const all: McpEquipmentOption[] = []
  for (const serverId of serverIds) {
    const server = (store.mcpServers || []).find((s: any) => s.id === serverId)
    if (!server) continue
    try {
      const ok = await mcpManager.connect(serverId, server, serverId)
      if (!ok) continue
      const res = await mcpManager.callTool(serverId, 'list_agents', {}, serverId, 35000)
      let data: any = res?.data
      if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = [] } }
      const list = Array.isArray(data) ? data : (Array.isArray(data?.agents) ? data.agents : [])
      for (const a of list.filter((x: any) => x && typeof x === 'object')) {
        const id = String(a.id || a.name || `eq-${Math.random().toString(36).slice(2, 8)}`)
        all.push({
          key: `${serverId}:${id}`,
          serverId,
          id,
          name: a.name || a.id || 'Equipment',
          type: String(a.type || ''),
        })
      }
    } catch {
      /* 单个服务失败不影响其它服务 */
    }
  }
  mcpEquipmentOptions.value = all
}

const isMcpEquipmentSelected = (agent: AgentPreset, key: string) =>
  (agent.capabilities.mcpEquipmentIds || []).includes(key)

const toggleMcpEquipment = (agent: AgentPreset, key: string) => {
  const arr = agent.capabilities.mcpEquipmentIds || []
  agent.capabilities.mcpEquipmentIds = arr.includes(key) ? arr.filter(x => x !== key) : [...arr, key]
}

// 添加知识库文件（追加到已选列表）
const addKbFile = async (agent: AgentPreset) => {
  const path = await window.ipcRenderer.invoke('selectFile')
  if (path && !agent.capabilities.knowledgeBaseFiles.includes(path)) {
    agent.capabilities.knowledgeBaseFiles.push(path)
  }
}

// 移除知识库文件
const removeKbFile = (agent: AgentPreset, path: string) => {
  agent.capabilities.knowledgeBaseFiles = agent.capabilities.knowledgeBaseFiles.filter(p => p !== path)
  if (agent.capabilities.knowledgeBaseFiles.length === 0) {
    // 无文件时同步关闭 kb_search 工具与其镜像布尔（对齐旧“移除完即关能力”语义）
    setToolEnabled(agent.capabilities as any, 'kb_search', false)
  }
}

// 知识库文件显示名（label 或文件名）
const kbLabel = (path: string): string => {
  const found = knowledgeBaseList.value.find(k => k.path === path)
  return found ? found.label : String(path).split(/[/\\]/).pop() || path
}

// ====== 状态 ======
const selectedId = ref<string>('')
/** 通用智能体内置项固定 id（不进入 agentPresets：不删除、不导出、不拖动） */
const GENERAL_PRESET_ID = '__general__'
/** 当前选中是否为通用智能体内置项 */
const isGeneral = computed(() => selectedId.value === GENERAL_PRESET_ID)
const selected = computed<AgentPreset | undefined>(() => {
  if (selectedId.value === GENERAL_PRESET_ID) {
    // 通用智能体内置虚拟预设：仅 maxSteps 生效（绑定 store.generalAgentMaxSteps），其余为占位、不可编辑
    return {
      id: GENERAL_PRESET_ID,
      name: store.locales === 'en' ? 'General Agent' : '通用智能体',
      tags: [],
      llmType: '',
      model: '',
      systemPrompt: '',
      temperature: 0.7,
      selectedSkills: [],
      capabilities: defaultCapabilities(),
      maxSteps: store.generalAgentMaxSteps,
      seedHistory: true,
      loopPromptMode: 'auto',
      loopSections: [],
    } as AgentPreset
  }
  return store.agentPresets.find((c: AgentPreset) => c.id === selectedId.value)
})

// ====== 配置 Tab（参考 SwarmAgentCard ae-tabs：通用 / 技能 / MCP / 知识库 / AgentLoop） ======
const activeTab = ref<'general' | 'tools' | 'skills' | 'mcp' | 'kb' | 'loop'>('general')
/** 技能/MCP/知识库 tab：对应能力开启后才可进入 */
const skillsEnabled = computed(() => !!selected.value?.capabilities?.skills)
const mcpEnabled = computed(() => !!selected.value?.capabilities?.mcpAccess)
const kbEnabled = computed(() => !!selected.value?.capabilities?.accessKnowledgeBase)
/** AgentLoop 指令段模式：变量说明（含 {{变量}} 字样，须在 JS 中定义避免被模板插值解析） */
const loopVarHint = computed(() =>
  store.locales === 'en'
    ? 'Variables: {{toolUsage}} (available tools) · {{kbHint}} (knowledge base) · {{skills}} (skill library) · {{cwd}} (workspace) · {{model}} · {{provider}}'
    : '可用变量：{{toolUsage}}（可用工具）· {{kbHint}}（知识库能力）· {{skills}}（技能库清单）· {{cwd}}（工作目录）· {{model}}（模型）· {{provider}}（来源）'
)
/** 自动模式说明（置于底部使用说明区） */
const loopAutoHint = computed(() =>
  store.locales === 'en'
    ? 'Auto mode: the system prompt is assembled automatically from this preset\'s capabilities / skills / knowledge base (same autonomous-planning prompt as the general agent, plus tool / KB / skill / MCP context). Switch to "Sections" to fully customize the prompt structure.'
    : '自动模式：系统提示由预设的能力 / 技能 / 知识库自动组装（与通用智能体一致的自主规划提示 + 工具说明 + 知识库 / 技能 / MCP 上下文）。切到「指令段」可完全自定义提示词结构。'
)
/** 指令段模式使用指南（置于底部使用说明区） */
const loopGuide = computed(() =>
  store.locales === 'en'
    ? 'Sections mode: click "Add section" to create segments and use ↑/↓ to reorder. At runtime all sections are merged IN ORDER into ONE system prompt injected into the model. Variables in the text are replaced with real values (tools / KB / skills / cwd / model / provider). Use "Preview final prompt" to check the merged result. MCP service context is appended at the end automatically.'
    : '指令段模式：点「添加指令段」创建多个段落，用 ↑/↓ 调整顺序。运行时所有指令段按顺序合并为一份系统提示注入模型；正文中的 {{变量}} 会替换为实际值（可用工具 / 知识库能力 / 技能清单 / 工作目录 / 模型 / 来源）。可展开「预览最终提示词」查看合并结果。MCP 服务上下文会自动追加到末尾。'
)
/** 预览展开状态 */
const loopPreviewOpen = ref(false)
/** 预览用：预设能力槽 → 工具名列表（统一数据源 agentCapabilities.ts，与运行时一致） */
const presetTools = computed<string[]>(() => toolsFromCapabilities((selected.value?.capabilities || {}) as any))
/** 预览：渲染指令段为最终 system prompt */
const loopPromptPreview = computed(() => {
  const p = selected.value
  if (!p || p.loopPromptMode !== 'sections') return ''
  const sections = p.loopSections || []
  if (!sections.some((s) => s && s.text && s.text.trim())) return ''
  const kbCapHint = (p.capabilities?.accessKnowledgeBase && p.capabilities?.knowledgeBaseFiles?.length)
    ? (store.locales === 'zh' ? '你拥有「访问知识库」能力，需要引用知识库资料时请使用 kb_search 工具自主检索，可更换检索词多次检索以获得更全面信息。' : 'You have the "Access Knowledge Base" capability; use the kb_search tool to retrieve from your knowledge base when you need to reference it.')
    : ''
  const skillLib = (p.capabilities?.skills && skillList.value.length > 0)
    ? [
        '你拥有一个已安装的技能库（skill 库），可用 skill 工具加载其中的技能并按其指令执行：',
        ...skillList.value.map((s) => `   - ${s.name}${s.description ? `：${s.description}` : ''}`),
        '用户问"有什么技能 / 会什么"时，直接列出上面的技能清单；',
      ].join('\n')
    : ''
  return renderLoopSections(sections, {
    tools: presetTools.value,
    kbHint: kbCapHint,
    skills: skillLib,
    cwd: store.root || undefined,
    model: p.model,
    provider: p.llmType,
  })
})
/** 指令段：确保字段存在（兼容旧数据） */
const ensureLoopSections = (p: AgentPreset | undefined) => {
  if (!p) return
  if (p.loopPromptMode !== 'sections' && p.loopPromptMode !== 'auto') p.loopPromptMode = 'auto'
  if (!Array.isArray(p.loopSections)) p.loopSections = []
}

/** 指令段预设模板（体现 Pi / Codex / Copilot / DeepSeek Harness 的提示词结构与风格；正文可含 {{变量}}） */
interface LoopTemplate { id: string; label: string; icon: string; desc: string; sections: Array<{ title: string; text: string }> }
const loopTemplates: LoopTemplate[] = [
  {
    id: 'pi',
    label: 'Pi',
    icon: 'fa-terminal',
    desc: '简约编码助手：身份 + 工具 + 简洁响应（参考 Pi coding agent）',
    sections: [
      { title: '身份', text: '你是一名运行在 Pi（编码智能体框架）中的专业编程助手，帮助用户读取文件、执行命令、编辑代码与编写新文件。' },
      { title: '工具', text: '你可以使用以下工具：\n{{toolUsage}}\n请精确使用工具，保持改动最小化。' },
      { title: '响应', text: '回复保持简洁；涉及文件时清晰展示文件路径。执行工具前，先用一两句话说明你接下来要做什么。' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: 'fa-terminal',
    desc: '终端编码智能体：计划 + 任务执行 + 最终汇报（参考 OpenAI Codex）',
    sections: [
      { title: '身份', text: '你是一名运行在 Codex CLI 中的编码智能体，需要精确、安全、乐于助人。' },
      { title: '计划', text: '对于复杂多步任务，先用 update_plan 工具制定简短计划（每步一句话），执行时保持恰好一个 in_progress，逐步标记完成。' },
      { title: '任务执行', text: '在你结束回合前，把任务完全解决；不要猜测或编造答案。改动要精准、最小化，必要时用测试或构建验证。' },
      { title: '最终汇报', text: '最终回答像一位简洁的队友交接工作：简短分段标题、按重要性分组的要点、用行内代码标注文件路径。' },
    ],
  },
  {
    id: 'copilot',
    label: 'Copilot',
    icon: 'fa-code',
    desc: '编辑器内协作：计划 + 多文件编辑 + 验证（参考 GitHub Copilot agent 模式）',
    sections: [
      { title: '身份', text: '你是用户编辑器中的编码助手，与用户一起规划、编辑与构建。' },
      { title: '任务', text: '分析代码、跨文件提出修改、运行测试并验证结果。改动尽量外科手术式、与现有代码风格保持一致。' },
      { title: '技能', text: '你拥有已安装的技能库，可按需用 skill 工具加载并执行技能：\n{{skills}}' },
      { title: '协作', text: '非平凡的多步工作先制定计划，重大改动前先与用户确认；执行中用简短话语同步进度。' },
    ],
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    icon: 'fa-cubes',
    desc: 'Harness 组装式提示词：身份 + 环境 + 工具 + 规划（参考 DeepSeek Harness）',
    sections: [
      { title: '身份', text: '你是一个由 DeepSeek Harness 驱动的智能体，运行在 {{provider}}，模型为 {{model}}。' },
      { title: '环境', text: '当前工作目录：{{cwd}}' },
      { title: '工具', text: '你可以使用以下工具：\n{{toolUsage}}\n{{kbHint}}\n{{skills}}' },
      { title: '规划', text: '多步任务用计划与任务清单工具跟踪进度；信息不足时用 ask_user 向用户提问。' },
    ],
  },
]
/** 应用模板：以模板指令段替换当前指令段 */
const applyLoopTemplate = (id: string) => {
  if (!selected.value) return
  const tp = loopTemplates.find((t) => t.id === id)
  if (!tp) return
  ensureLoopSections(selected.value)
  selected.value.loopSections = tp.sections.map((s) => ({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: s.title,
    text: s.text,
  }))
  ElMessage.success(store.locales === 'en' ? `Applied ${tp.label} template` : `已应用「${tp.label}」模板`)
}
/** 清除：清空全部指令段 */
const clearLoopSections = () => {
  if (!selected.value) return
  ensureLoopSections(selected.value)
  selected.value.loopSections = []
  ElMessage.success(store.locales === 'en' ? 'Sections cleared' : '已清除全部指令段')
}
const addLoopSection = () => {
  if (!selected.value) return
  ensureLoopSections(selected.value)
  selected.value.loopSections!.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, title: '', text: '' })
}
const removeLoopSection = (i: number) => {
  if (!selected.value || !Array.isArray(selected.value.loopSections)) return
  selected.value.loopSections.splice(i, 1)
}
const moveLoopSection = (i: number, dir: number) => {
  if (!selected.value || !Array.isArray(selected.value.loopSections)) return
  const arr = selected.value.loopSections
  const j = i + dir
  if (j < 0 || j >= arr.length) return
  const tmp = arr[i]
  arr[i] = arr[j]
  arr[j] = tmp
}

const selectPreset = (id: string) => { selectedId.value = id; activeTab.value = 'general' }

// ====== 右键菜单：复制 / 导出 .agent ======
const presetMenu = ref<{ visible: boolean; x: number; y: number; preset: AgentPreset | null }>({
  visible: false, x: 0, y: 0, preset: null,
})
const showPresetMenu = (e: MouseEvent, preset: AgentPreset) => {
  // 限制在视口内，避免菜单溢出（含分隔线 + 删除项，高度约 110）
  const menuW = 180, menuH = 110
  const x = Math.min(e.clientX, window.innerWidth - menuW - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuH - 8)
  presetMenu.value = { visible: true, x, y, preset }
}
const hidePresetMenu = () => { presetMenu.value.visible = false }

/** 复制：克隆一个预设（新 id + 「副本」后缀，写入 .agent 文件） */
const duplicatePreset = async (preset: AgentPreset | null) => {
  if (!preset) return
  const clone: AgentPreset = {
    ...JSON.parse(JSON.stringify(preset)),
    id: genId(),
    name: `${preset.name || 'Agent'}${store.locales === 'en' ? ' (copy)' : ' 副本'}`,
  }
  store.agentPresets.push(clone)
  selectedId.value = clone.id
  store.saveConfig()
  const ok = await writeAgentPreset(clone)
  ElMessage.success(store.locales === 'en'
    ? (ok ? 'Preset duplicated' : 'Copied, but file not saved due to name conflict')
    : (ok ? '已复制预设' : '已复制预设（文件名冲突，未写入文件）'))
}

/** 导出：保存对话框选择路径 → 写 .agent 文件（JSON） */
const exportPreset = async (preset: AgentPreset | null) => {
  if (!preset) return
  try {
    const safeName = String(preset.name || 'agent').replace(/[\\/:*?"<>|\s]+/g, '_')
    const filePath = await window.ipcRenderer.invoke('saveFileDialog', {
      defaultPath: `${safeName}.agent`,
      filters: [
        { name: 'Agent Preset', extensions: ['agent'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (filePath) {
      await window.ipcRenderer.invoke('writeFile', filePath, JSON.stringify(preset, null, 2))
      ElMessage.success(store.locales === 'en' ? 'Exported' : '已导出 .agent 文件')
    }
  } catch (e: any) {
    ElMessage.error(store.locales === 'en' ? `Export failed: ${e?.message || e}` : `导出失败：${e?.message || e}`)
  }
}

/** 删除：右键菜单调用（复用 removePreset，删除 .agent 文件并移出列表） */
const removePresetFromMenu = () => {
  const p = presetMenu.value.preset
  if (!p || p.id === GENERAL_PRESET_ID) return // 内置通用智能体不可删除
  removePreset(p.id)
}

// 切换预设或修改 MCP 服务时，自动刷新可选装备（需在 selected 定义之后，避免 TDZ 错误）
watch(
  () => selected.value?.capabilities.mcpServerIds?.join(','),
  async (serverIds) => {
    if (selected.value?.capabilities.mcpAccess && serverIds) {
      await loadMcpEquipments(selected.value)
    } else {
      mcpEquipmentOptions.value = []
    }
  },
)

// 切换预设时也刷新 MCP 装备列表（避免两个预设使用同一服务时不刷新）
watch(
  () => selected.value?.id,
  async () => {
    // 切换预设时回到「通用」tab
    activeTab.value = 'general'
    if (selected.value?.capabilities.mcpAccess && (selected.value.capabilities.mcpServerIds || []).length) {
      await loadMcpEquipments(selected.value)
    } else {
      mcpEquipmentOptions.value = []
    }
  },
)

const genId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

/** 新建预设（写入 .agent 文件） */
const addPreset = async () => {
  const preset: AgentPreset = {
    id: genId(),
    name: store.locales === 'en' ? 'New Agent' : '新 Agent',
    tags: [],
    llmType: store.AIconfig.llm.type,
    // 默认跟随全局当前模型（DeepSeek 按当前接口样式取对应配置块）
    model: String(deepSeekStyleOf(store.AIconfig.llm.type, store.AIconfig.llm.deepseek) === 'responses'
      ? (store.AIconfig.llm as any).deepseekResponses?.model
      : (store.AIconfig.llm as any)[store.AIconfig.llm.type]?.model || ''),
    systemPrompt: '',
    temperature: 0.7,
    kbTopK: 3,
    // 默认全选所有已启用技能（＝与通用智能体一致）
    selectedSkills: [...skillList.value.map(s => s.path)],
    // 工具能力默认全开（对齐通用智能体默认工具集：读写/搜索/执行代码/浏览网页/技能库）
    capabilities: {
      readFiles: true, executeCode: true, webSearch: true, accessKnowledgeBase: false,
      browseWebsites: true, writeFiles: true, listDirs: true, runShell: false,
      runSubagent: false, skills: true,
        askUser: true, updatePlan: true, updateTodo: true,
          mcpAccess: false, mcpServerIds: [], mcpEquipmentIds: [],
        knowledgeBaseFiles: [],
    },
    maxSteps: DEFAULT_AGENT_MAX_STEPS,
    seedHistory: true,
    loopPromptMode: 'auto',
    loopSections: [],
  }
  store.agentPresets.push(preset)
  selectedId.value = preset.id
  store.saveConfig()
  const ok = await writeAgentPreset(preset)
  if (!ok) {
    ElMessage.warning(store.locales === 'en'
      ? 'Created, but file not saved due to name conflict'
      : '已新建预设（文件名冲突，未写入文件）')
  }
}

/** 删除预设（删除 .agent 文件 + 移出列表） */
const removePreset = async (id: string) => {
  if (id === GENERAL_PRESET_ID) return // 内置通用智能体不可删除
  const idx = store.agentPresets.findIndex((c: AgentPreset) => c.id === id)
  if (idx >= 0) {
    await removeAgentPreset(id)
    if (selectedId.value === id) {
      selectedId.value = store.agentPresets.length > 0
        ? store.agentPresets[Math.min(idx, store.agentPresets.length - 1)].id
        : ''
    }
    store.saveConfig()
  }
}

/** 导出全部预设为 .agent 文件到所选文件夹 */
const exportAllPresets = async () => {
  if (store.agentPresets.length === 0) {
    ElMessage.warning(store.locales === 'en' ? 'No presets to export' : '没有可导出的预设')
    return
  }
  const ok = await exportAllAgentPresets()
  if (ok === -1) return // 用户取消选择文件夹
  ElMessage.success(store.locales === 'en'
    ? `Exported ${ok}/${store.agentPresets.length} presets to folder`
    : `已导出 ${ok}/${store.agentPresets.length} 个预设到文件夹`)
}

/** 导入单个 .agent 文件到预设列表（并写入预设文件夹，与其它预设一致持久化） */
const importAgentFile = async () => {
  const path = await window.ipcRenderer.invoke('selectFile', {
    filters: [
      { name: 'Agent Preset', extensions: ['agent'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (!path) return
  try {
    const text = await window.ipcRenderer.invoke('readFile', path)
    const data = JSON.parse(text)
    if (!data || !data.id || typeof data.id !== 'string') {
      ElMessage.error(store.locales === 'en' ? 'Invalid .agent file (missing id)' : '无效的 .agent 文件（缺少 id）')
      return
    }
    if ((store.agentPresets as any[]).some(c => c.id === data.id)) {
      ElMessage.warning(store.locales === 'en' ? 'This preset already exists' : '该预设已存在')
      return
    }
    // 同名冲突：避免写入时覆盖已有预设的文件（文件名 = 名称清洗后）
    const dir = store.agentPresetPath
    if (dir) {
      const target = agentFilePath(data, dir)
      const conflict = (store.agentPresets as any[]).find(c => c.id !== data.id && agentFilePath(c, dir) === target)
      if (conflict) {
        ElMessage.warning(store.locales === 'en'
          ? `Name conflicts with "${conflict.name}", please rename it first`
          : `与预设「${conflict.name}」同名，请先重命名再导入`)
        return
      }
    }
    // 补齐/迁移可能缺失的字段（与新建预设、onMounted 迁移一致）
    if (!Array.isArray(data.selectedSkills)) {
      data.selectedSkills = data.selectedSkill ? [data.selectedSkill] : []
      delete data.selectedSkill
    }
    if (!data.capabilities) data.capabilities = defaultCapabilities()
    if (data.capabilities) {
      if (typeof data.capabilities.askUser === 'undefined') data.capabilities.askUser = true
      if (typeof data.capabilities.updatePlan === 'undefined') data.capabilities.updatePlan = true
      if (typeof data.capabilities.updateTodo === 'undefined') data.capabilities.updateTodo = true
      if (typeof data.capabilities.mcpAccess === 'undefined') {
        data.capabilities.mcpAccess = false
        data.capabilities.mcpServerIds = []
        data.capabilities.mcpEquipmentIds = []
      } else {
        if (!Array.isArray(data.capabilities.mcpServerIds) && data.capabilities.mcpServerId) {
          data.capabilities.mcpServerIds = [data.capabilities.mcpServerId]
        } else if (!Array.isArray(data.capabilities.mcpServerIds)) {
          data.capabilities.mcpServerIds = []
        }
        if (!Array.isArray(data.capabilities.mcpEquipmentIds)) data.capabilities.mcpEquipmentIds = []
      }
    }
    if (typeof data.maxSteps === 'undefined') data.maxSteps = DEFAULT_AGENT_MAX_STEPS
    if (typeof data.seedHistory === 'undefined') data.seedHistory = true
    if (data.loopPromptMode !== 'sections' && data.loopPromptMode !== 'auto') data.loopPromptMode = 'auto'
    if (!Array.isArray(data.loopSections)) data.loopSections = []
    if (typeof data.kbTopK === 'undefined') data.kbTopK = 3
    if (typeof data.temperature === 'undefined') data.temperature = 0.7
    if (typeof data.llmType === 'undefined') data.llmType = store.AIconfig.llm.type
    if (typeof data.model === 'undefined') data.model = ''
    if (!Array.isArray(data.tags)) data.tags = []

    store.agentPresets.push(data)
    selectedId.value = data.id
    store.saveConfig()
    await writeAgentPreset(data)
    ElMessage.success(store.locales === 'en' ? 'Preset imported' : '已导入预设')
  } catch (e: any) {
    ElMessage.error(store.locales === 'en' ? `Import failed: ${e?.message || e}` : `导入失败：${e?.message || e}`)
  }
}

/** 正在拉取候选模型（切换来源/手动刷新时） */
const modelListLoading = ref(false)
/**
 * 拉取某来源的候选模型列表（复用 store.testLlmSource：探测并回填该来源的 available_models）。
 * 说明：各来源的 available_models 只在「探测过」后才有值（服务离线/未访问过设置页时为空），
 * 因此切换来源时必须主动拉一次，否则本模块的模型下拉会是空的。
 */
const refreshAgentModels = async (type?: string) => {
  const t = type || selected.value?.llmType || store.AIconfig.llm.type
  if (!t || modelListLoading.value) return
  modelListLoading.value = true
  try {
    await store.testLlmSource(t)
  } catch (e) {
    console.warn('[AgentPreset] 拉取模型列表失败:', t, e)
  } finally {
    modelListLoading.value = false
  }
}
/** 修改来源时清空模型，并自动拉取该来源的候选模型（否则下拉为空） */
const onLlmTypeChange = () => {
  if (selected.value) selected.value.model = ''
  refreshAgentModels()
}
// 切换预设/来源后，候选列表为空时自动拉一次（已拉取过的不重复请求）
watch(() => [selected.value?.id, selected.value?.llmType], () => {
  if (selected.value && getModelsForAgent(selected.value).length === 0) refreshAgentModels()
})

// 编辑自动保存：localStorage 备份 + 防抖写入 .agent 文件（.agent 文件模式）
let presetSaveTimer: ReturnType<typeof setTimeout> | null = null
watch(() => store.agentPresets, () => {
  store.saveConfig()
  if (!store.agentPresetPath) return
  if (presetSaveTimer) clearTimeout(presetSaveTimer)
  presetSaveTimer = setTimeout(() => {
    for (const c of store.agentPresets as any[]) {
      writeAgentPreset(c)
    }
  }, 600)
}, { deep: true })

onMounted(async () => {
  // .agent 文件模式：先扫描预设文件夹（有 agentPresetPath 时以文件为准）
  await scanAgentPresets()
  // 兼容迁移：旧数据 selectedSkill(string) → selectedSkills(string[])
  for (const c of store.agentPresets as any[]) {
    if (!Array.isArray(c.selectedSkills)) {
      c.selectedSkills = c.selectedSkill ? [c.selectedSkill] : []
      delete c.selectedSkill
    }
    // 兼容迁移：旧预设没有 tags 字段 → 初始化为空数组
    if (!Array.isArray(c.tags)) c.tags = []

    if (c.capabilities) {
      if (typeof c.capabilities.askUser === 'undefined') c.capabilities.askUser = true
      if (typeof c.capabilities.updatePlan === 'undefined') c.capabilities.updatePlan = true
      if (typeof c.capabilities.updateTodo === 'undefined') c.capabilities.updateTodo = true

      if (typeof c.capabilities.mcpAccess === 'undefined') {
        c.capabilities.mcpAccess = false
        c.capabilities.mcpServerIds = []
        c.capabilities.mcpEquipmentIds = []
      } else {
        // 兼容旧版单选 mcpServerId → 新的多选 mcpServerIds
        if (!Array.isArray(c.capabilities.mcpServerIds) && c.capabilities.mcpServerId) {
          c.capabilities.mcpServerIds = [c.capabilities.mcpServerId]
        } else if (!Array.isArray(c.capabilities.mcpServerIds)) {
          c.capabilities.mcpServerIds = []
        }
      }
    }
    // AgentLoop 提示词：兼容迁移
    if (c.loopPromptMode !== 'sections' && c.loopPromptMode !== 'auto') c.loopPromptMode = 'auto'
    if (!Array.isArray(c.loopSections)) c.loopSections = []
  }

  loadSkillList()
  scanKnowledgeBases()

  // 默认打开通用智能体内置项（而不是预设列表中的第一个）
  if (!selectedId.value) {
    selectedId.value = GENERAL_PRESET_ID
  }
})
</script>

<style scoped>
.agent-preset {
  display: flex; height: 100%; flex: 1; overflow: hidden;
  background: var(--backgroundColor); color: var(--fontColor);
}
/* ====== 左侧列表 ====== */
.contact-sidebar {
  width: 180px; display: flex; flex-direction: column;
  border-right: 1px solid var(--borderColor); background: var(--menuColor);
}
.contact-sidebar-list { flex: 1; overflow-y: auto; padding: 2px; background-color: var(--backgroundColor); }
/* ====== 顶部工具栏（ToDo top-toolbar 同款：搜索 / 新建 / 打开文件夹） ====== */
.contact-toolbar {
  display: flex; flex-direction: column; gap: 5px;
  flex-shrink: 0;
  padding: 5px; border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}
/* 第一行：四个操作按钮均匀分布（新建 / 导入文件夹 / 导出全部 / 导入单个） */
.contact-actions-row {
  display: flex; gap: 5px; width: 100%;
}
.contact-actions-row .toolbar-action-btn {
  flex: 1; height: 28px;
}
.contact-toolbar .notes-search-box {
  flex: none; width: calc(100% - 14px); min-width: 0; height: 26px;
  display: flex; align-items: center; gap: 6px;
  padding: 0 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--borderColor); font-size: 12px;
}
.contact-toolbar .notes-search-box > i { flex-shrink: 0; font-size: 12px; }
.contact-toolbar .notes-search-input {
  flex: 1; min-width: 0;
  border: none; outline: none; background: transparent;
  color: var(--fontColor); font-size: 12px; margin: 0;
}
.contact-toolbar .notes-search-clear { flex-shrink: 0; cursor: pointer; font-size: 12px; color: var(--borderColor); }
.contact-toolbar .notes-search-clear:hover { color: var(--fontActiveColor); }
.contact-toolbar .toolbar-action-btn {
  flex-shrink: 0; width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  cursor: pointer; font-size: 12px; transition: all .12s;
}
.contact-toolbar .toolbar-action-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.contact-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 6px; margin-bottom: 1px; border-radius: 3px;
  cursor: pointer; transition: all .12s; border: 1px solid transparent;
}
.contact-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.contact-item.active { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); border-color: var(--fontActiveColor); }
.contact-item-avatar {
  width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); border-radius: 50%; flex-shrink: 0;
}
.contact-item-avatar i { font-size: 13px; color: var(--fontActiveColor); }
.contact-item-info { flex: 1; min-width: 0; }
.contact-item-name { display: block; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 左侧列表项：标签展示 */
.contact-item-tags {
  display: flex; align-items: center; gap: 2px;
  margin-top: 2px; overflow: hidden;
}
.contact-tag-chip {
  flex-shrink: 0; max-width: 52px;
  font-size: 9px; line-height: 1;
  padding: 2px 4px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.contact-tag-more { flex-shrink: 0; font-size: 9px; color: var(--borderColor); }
/* 右侧：标签编辑输入区 */
.preset-tags {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  padding: 0px;
  background: var(--backgroundColor); min-height: 26px;
}
.preset-tags:focus-within { border-color: var(--fontActiveColor); }
.preset-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; line-height: 1;
  padding: 3px 6px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
  color: var(--fontActiveColor);
}
.preset-tag i {
  font-size: 10px; cursor: pointer; opacity: .65;
}
.preset-tag i:hover { opacity: 1; color: #f56c6c; }
.preset-tag-input {
  flex: 1; width: 110px; border: none; outline: none;
  background: transparent; color: var(--fontColor); font-size: 11px; margin: 0; padding: 0;
}
.contact-item-del {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border: none; background: none; color: var(--borderColor);
  cursor: pointer; font-size: 10px; border-radius: 2px; flex-shrink: 0; padding: 0;
  opacity: 0; transition: all .12s;
}
.contact-item:hover .contact-item-del { opacity: 1; }
.contact-item-del:hover { color: var(--fontColor); background: color-mix(in srgb, var(--fontColor) 12%, transparent); }

/* 通用智能体内置项（左侧列表固定置顶：不可删除 / 拖动） */
.general-preset-item {
  border-bottom: 1px solid color-mix(in srgb, var(--fontActiveColor) 20%, transparent);
  margin-bottom: 2px;
}
.contact-item-lock {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; flex-shrink: 0;
  color: var(--borderColor); font-size: 10px; opacity: .8;
}
/* 通用智能体面板（右侧：仅可调整循环轮数） */
.general-panel-head {
  display: flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 600; padding: 2px 0 6px;
}
.general-panel-head i { color: var(--fontActiveColor); }
.general-panel-badge {
  font-size: 10px; font-weight: normal; line-height: 1;
  padding: 2px 6px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor);
}
.general-panel-desc {
  font-size: 12px; line-height: 1.6; opacity: .85;
  padding: 4px 0 10px; border-bottom: 1px dashed var(--borderColor);
}

/* ====== 拖拽排序 ====== */
.contact-drag-list { display: flex; flex-direction: column; }
.contact-item-ghost { opacity: 0.4; }
.contact-item-ghost .contact-item-del { opacity: 0; }

/* ====== 预设右键菜单（复制 / 导出 .agent） ======
   注意：该组件位于设置面板（.set-overlay z-index:1500）内，而菜单 teleport 到 body，
   需高于 1500 才不被设置层盖住；同时低于 Element Plus 弹窗（2000），保持层级一致。 */
.preset-ctx-overlay {
  position: fixed; inset: 0; z-index: 1600;
}
.preset-ctx-menu {
  position: fixed; z-index: 1601;
  min-width: 160px; padding: 3px;
  background: var(--menuColor); border: 1px solid var(--borderColor);
  border-radius: 4px; box-shadow: 0 4px 16px rgba(0,0,0,.25);
  font-size: 12px; user-select: none;
}
.preset-ctx-menu .menu-item {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 3px; cursor: pointer;
  color: var(--fontColor); white-space: nowrap;
}
.preset-ctx-menu .menu-item:hover { background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent); }
.preset-ctx-menu .menu-item i { font-size: 11px; color: var(--fontActiveColor); }
/* 删除项：分隔线 + 红色警示 */
.preset-ctx-menu .menu-divider { height: 1px; background: var(--borderColor); margin: 3px 0; }
.preset-ctx-menu .menu-item.danger { color: #f56c6c; }
.preset-ctx-menu .menu-item.danger:hover { background: color-mix(in srgb, #f56c6c 14%, transparent); }
.preset-ctx-menu .menu-item.danger i { color: #f56c6c; }

/* ====== 右侧：配置编辑（tab 布局，参考 SwarmAgentCard ae-body） ====== */
.contact-content { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.ae-body {
  flex: 1; overflow-y: auto; padding: 5px;
  display: flex; flex-direction: column; gap: 8px; min-height: 0;
}

/* ====== Tab 栏（与 SwarmAgentCard ae-tabs 一致；窄宽度时隐藏文字只留图标） ====== */
.ae-tabs {
  display: flex; gap: 3px;
  border-bottom: 1px solid var(--borderColor); padding-bottom: 5px;
  flex-shrink: 0;
  container-type: inline-size;
}
.ae-tab-text {
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@container (max-width: 420px) {
  .ae-tab-text { display: none; }
}
.ae-tab {
  flex: 1; padding: 3px 4px; font-size: 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 1px solid transparent; border-radius: 4px;
  background: transparent; color: var(--fontColor); opacity: .75;
  cursor: pointer; transition: all .12s;
}
.ae-tab i { font-size: 10px; }
.ae-tab:hover:not(.disabled) { opacity: 1; color: var(--fontActiveColor); }
.ae-tab.on {
  opacity: 1; color: var(--fontActiveColor); font-weight: 600;
  border-color: var(--borderColor);
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
}
.ae-tab.disabled { opacity: .4; cursor: not-allowed; }
.ae-tab-body { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 0; }
/* 配置分组框占满 tab 高度，避免下方留白 */
.ae-tab-body > .cfg-box { flex: 1 1 auto; min-height: 0; }

/* ====== 配置表单 ====== */
.cfg-row { display: flex; align-items: center; gap: 5px; }
.cfg-row.column { flex-direction: column; align-items: stretch; }
.cfg-row label { font-size: 10px; color: var(--fontColor); min-width: 44px; flex-shrink: 0; padding: 0px; }
.cfg-row input:not([type="checkbox"]):not([type="radio"]), .cfg-row select {
  flex: 1; min-width: 0; padding: 2px 5px; border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; outline: none; margin: 0px;
}
.cfg-row textarea {
  padding: 2px 5px; border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px;
  resize: vertical; font-family: inherit; outline: none; width: calc(100% - 12px);
}
/* 系统提示输入框：占满基础配置框剩余高度，带最小高度兜底；高度过小时收缩不超出容器 */
.system-prompt-row { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.system-prompt-row textarea { flex: 1; min-height: 48px; max-height: 100%; }
.cfg-row input[type="range"] { padding: 0; border: none; width: calc(100% - 70px); }

.cap-body { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 0; }

/* ====== 工具管理网格（参照设置中工具管理样式，grid 卡片布局，精简描述） ====== */
.preset-tool-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 5px;
  flex: 1 1 auto;
  min-height: 0;
  align-content: start;
  overflow-y: auto; padding-right: 2px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  padding:5px;
}
.preset-tool-list::-webkit-scrollbar { width: 4px; }
.preset-tool-list::-webkit-scrollbar-thumb { background: var(--borderColor); border-radius: 2px; }
.preset-tool-item {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); cursor: pointer;
  transition: all .12s; flex-shrink: 0;
}
.preset-tool-item:hover { border-color: var(--fontActiveColor); }
.preset-tool-item.on { border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.preset-tool-icon {
  width: 22px; height: 22px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  border-radius: 4px; color: var(--fontColor); font-size: 11px;
}
.preset-tool-item.on .preset-tool-icon {
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
  color: var(--fontActiveColor);
}
.preset-tool-name { font-size: 11px; color: var(--fontColor); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-tool-item.on .preset-tool-name { color: var(--fontActiveColor); font-weight: 600; }
/* 工具/技能卡片信息区（参照工具管理面板 tool-info：名称 + 工具 key + 介绍） */
.preset-tool-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.preset-tool-key {
  font-size: 9px; color: var(--fontColor); opacity: 0.55;
  font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.preset-tool-desc {
  font-size: 10px; opacity: 0.75; line-height: 1.4; margin-top: 1px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  line-clamp: 2; overflow: hidden;
}
.preset-tool-toggle {
  width: 26px; height: 14px; border-radius: 7px; margin-left: auto; flex-shrink: 0;
  background: var(--borderColor); position: relative; transition: all .15s;
}
.preset-tool-toggle .preset-toggle-knob {
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.preset-tool-toggle.on { background: var(--fontActiveColor); }
.preset-tool-toggle.on .preset-toggle-knob { left: 14px; }

/* ====== 配置分组框（工具管理 / 知识库 / 技能共用：圆角边框；极小窗口时内部滚动） ====== */
.cfg-box { gap: 5px; padding: 6px; border: 1px solid var(--borderColor); border-radius: 6px; overflow-y: auto; }
.cfg-box > label { min-width: 0; font-weight: 600; }

/* ====== 知识库配置（卡片样式与工具管理 .preset-tool-item 完全一致：复用其类名） ====== */
.kb-file-del {
  display: flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border: none; background: none; cursor: pointer;
  color: var(--borderColor); font-size: 10px; border-radius: 2px; flex-shrink: 0; padding: 0;
  margin-left: auto;
}
.kb-file-del:hover { color: var(--fontColor); background: color-mix(in srgb, var(--fontColor) 12%, transparent); }
.kb-file-add {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 4px 6px; border: 1px dashed var(--borderColor); border-radius: 4px;
  cursor: pointer; font-size: 11px; color: var(--fontColor); opacity: 0.75;
  transition: all .12s;
}
.kb-file-add:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); opacity: 1; }
/* 召回切片数：知识库标签右侧，与技能面板按钮类似的小控件 */
.kb-recall-inline {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; font-size: 10px;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--menuColor); color: var(--fontColor);
}
.kb-recall-inline .kb-recall-label { opacity: 0.8; flex-shrink: 0; }
.kb-recall-inline input {
  width: 38px; padding: 0 2px; border: none; background: transparent;
  color: var(--fontColor); font-size: 10px; outline: none; text-align: center;
}

/* ====== 技能配置（卡片样式与工具管理 .preset-tool-item 完全一致：直接复用其类名） ====== */
.skill-box-head {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
}
.skill-box-head label {
  min-width: 0; font-weight: 600; font-size: 10px; color: var(--fontColor); padding: 0;
}
.skill-box-actions { display: flex; gap: 4px; }
.skill-bulk-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; font-size: 10px;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--menuColor); color: var(--fontColor); cursor: pointer;
  transition: all .12s;
}
.skill-bulk-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.skill-bulk-btn i { font-size: 10px; }
.preset-tool-icon .preset-skill-emoji { font-size: 12px; line-height: 1; }
.preset-skill-empty { font-size: 10px; opacity: .6; padding: 4px 0; }

.empty-hint { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--borderColor); gap: 6px; height: 100%; }
.empty-hint i { font-size: 28px; }
.empty-hint span { font-size: 11px; }

/* 能力槽说明 / 生效工具预览 / 执行参数 */
.preset-tools-hint {
  font-size: 10px; opacity: 0.6; margin-top: 6px;
  display: inline-flex; align-items: center; gap: 4px; line-height: 1.5;
  flex-shrink: 0;
}
.effective-tool-chip {
  font-size: 10px; padding: 0 5px;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  border: 1px solid var(--borderColor); border-radius: 3px;
  color: var(--fontActiveColor); font-family: Consolas, monospace;
}
.exec-config-row { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.exec-config-item { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.exec-config-label { font-size: 11px; min-width: 64px; }
.exec-config-input {
  width: 64px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor); padding: 2px 6px; font-size: 12px;
}
.exec-config-hint { font-size: 10px; opacity: 0.55; }
.exec-config-check { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; cursor: pointer; }
.exec-config-check input { accent-color: #409eff; cursor: pointer; }

/* ====== AgentLoop 提示词（指令段配置） ====== */
.loop-mode-select {
  width: 110px; padding: 1px 4px; font-size: 11px;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); outline: none;
}
.loop-sections-body { display: flex; flex-direction: column; gap: 6px; }
.loop-section {
  display: flex; flex-direction: column; gap: 4px;
  padding: 5px; border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor);
}
.loop-section-head { display: flex; align-items: center; gap: 5px; }
.loop-section-title {
  flex: 1; min-width: 0; padding: 2px 5px; font-size: 11px;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); outline: none;
}
.loop-section-actions { display: flex; gap: 2px; flex-shrink: 0; }
.loop-sec-btn {
  width: 20px; height: 20px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--menuColor); color: var(--fontColor);
  cursor: pointer; font-size: 10px; transition: all .12s;
}
.loop-sec-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.loop-sec-btn.danger:hover { color: #f56c6c; border-color: #f56c6c; }
.loop-section-text {
  padding: 2px 5px; font-size: 11px;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor);
  resize: vertical; font-family: inherit; outline: none;
}
.loop-add-section {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 4px 6px; font-size: 11px;
  border: 1px dashed var(--borderColor); border-radius: 4px;
  background: transparent; color: var(--fontColor); opacity: .75; cursor: pointer;
  transition: all .12s;
}
.loop-add-section:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); opacity: 1; }
.loop-preview {
  border: 1px solid var(--borderColor); border-radius: 4px; overflow: hidden;
}
.loop-preview-head {
  display: flex; align-items: center; justify-content: space-between; gap: 5px;
  padding: 3px 6px; font-size: 11px; color: var(--fontColor);
  cursor: pointer; user-select: none; background: var(--menuColor);
}
.loop-preview-head i { font-size: 10px; opacity: .7; }
.loop-preview-body {
  margin: 0; padding: 6px; max-height: 220px; overflow: auto;
  font-size: 10px; font-family: Consolas, monospace; white-space: pre-wrap; word-break: break-all;
  color: var(--fontColor); background: var(--backgroundColor);
}
/* 循环 tab 底部使用说明 */
.loop-help { gap: 6px; }
.loop-help-block {
  display: flex; align-items: flex-start; gap: 5px;
  font-size: 10px; opacity: 0.85; line-height: 1.6;
}
.loop-help-block i { font-size: 10px; margin-top: 2px; color: var(--fontActiveColor); flex-shrink: 0; }
/* 通用智能体面板：工具 / MCP 调整入口提醒（视觉强调：淡背景 + 左侧色条） */
.general-link-hint {
  padding: 5px 8px; margin-top: 2px; border-radius: 3px;
  background: color-mix(in srgb, var(--fontActiveColor) 7%, transparent);
  border-left: 2px solid var(--fontActiveColor);
  opacity: 1;
}
.general-link-hint i { margin-top: 3px; }
.general-link-text { flex: 1; min-width: 0; }
.general-link-btn {
  flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 3px;
  border: 1px solid var(--borderColor);
  background: var(--menuColor); color: var(--fontActiveColor);
  cursor: pointer; transition: all .12s;
}
.general-link-btn:hover { border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); }
/* 指令段预设模板 */
.loop-templates { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.loop-templates-label { font-size: 10px; opacity: .7; flex-shrink: 0; }
.loop-template-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; font-size: 10px;
  border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--menuColor); color: var(--fontColor); cursor: pointer;
  transition: all .12s;
}
.loop-template-btn:hover {
  border-color: var(--fontActiveColor); color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
}
.loop-template-btn.danger:hover {
  border-color: #f56c6c; color: #f56c6c;
  background: color-mix(in srgb, #f56c6c 8%, transparent);
}
.loop-template-btn i { font-size: 10px; }
</style>
