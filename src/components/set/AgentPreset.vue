<!-- AgentPreset.vue - Agent 预设：常用 Agent 模板库管理 -->
<template>
  <div class="agent-preset" :class="{ tall: isTallLayout }">
    <!-- ====== 左侧：智能体导航（参照「插件 → 管理」：安装 / 搜索 / 列表 / 底栏） ======
         细长窗口下与右侧编辑区各占满整屏互相切换（见 .tall 样式） -->
    <div class="contact-sidebar" v-show="!isTallLayout || showNavScreen">
      <div class="top-toolbar contact-toolbar">
        <div class="contact-actions-row">
          <button class="toolbar-action-btn primary" @click="installAgentFiles"
            :title="store.locales === 'en' ? 'Install Agent preset(s) from .agent files' : '安装智能体：从 .agent 文件导入到预设文件夹'">
            <i class="fa fa-plus"></i><span class="ap-toolbar-label">{{ store.locales === 'en' ? 'Install' : '安装' }}</span>
          </button>
          <button class="toolbar-action-btn" @click="addPreset" :title="store.locales === 'en' ? 'New preset' : '新建预设'">
            <i class="fa fa-file-o"></i>
          </button>
          <button class="toolbar-action-btn" @click="rescanFolder" :disabled="!store.agentPresetPath"
            :title="store.locales === 'en' ? 'Rescan preset folder' : '重新扫描预设文件夹'">
            <i class="fa fa-search-plus"></i>
          </button>
          <button class="toolbar-action-btn" @click="revealFolder" :disabled="!store.agentPresetPath"
            :title="store.locales === 'en' ? 'Open preset folder in Explorer' : '在资源管理器中打开预设文件夹'">
            <i class="fa fa-external-link"></i>
          </button>
          <button class="toolbar-action-btn" @click="chooseFolder"
            :title="store.locales === 'en' ? 'Select preset folder' : '选择预设文件夹'">
            <i class="fa fa-folder-open"></i>
          </button>
        </div>
      </div>
      <!-- 搜索行（与「插件 → 管理」「技能 → 管理」同一套：独立一行、自带边框，不再挤在工具栏里） -->
      <div class="ap-nav-search">
        <i class="fa fa-search"></i>
        <input v-model="presetKeyword" spellcheck="false"
          :placeholder="store.locales === 'en' ? 'Search presets (name / tags / prompt)' : '搜索预设（名称 / 标签 / 提示词）'" />
        <i v-if="presetKeyword" class="fa fa-times-circle ap-search-clear" @click="presetKeyword = ''"
          :title="store.locales === 'en' ? 'Clear' : '清除'"></i>
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
          <div class="ap-nav-top">
            <span class="ap-nav-icon"><i class="fa fa-android"></i></span>
            <span class="ap-nav-name">{{ store.locales === 'en' ? 'General Agent' : '通用智能体' }}</span>
            <span class="contact-item-lock" :title="store.locales === 'en' ? 'Built-in, cannot be deleted' : '内置项，不可删除'"><i class="fa fa-lock"></i></span>
          </div>
          <div class="ap-nav-meta">
            <span class="contact-tag-chip">{{ store.locales === 'en' ? 'built-in' : '内置' }}</span>
            <span class="ap-nav-meta-text">{{ store.locales === 'en' ? 'default entry' : '默认入口' }}</span>
          </div>
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
          @end="enforcePresetOrder"
        >
          <template #item="{ element }">
            <div
              v-show="matchesKeyword(element)"
              class="contact-item" :class="{ active: selectedId === element.id }"
              @click="selectPreset(element.id)"
              @contextmenu.prevent="showPresetMenu($event, element)">
              <div class="ap-nav-top">
                <span class="ap-nav-icon"><i class="fa" :class="presetIcon(element)"></i></span>
                <span class="ap-nav-name">{{ element.name || (store.locales === 'en' ? 'Unnamed' : '未命名') }}</span>
                <span v-if="element.builtin" class="contact-item-lock" :title="store.locales === 'en' ? 'Built-in, cannot be deleted' : '内置项，不可删除'"><i class="fa fa-lock"></i></span>
                <button v-else class="contact-item-del" @click.stop="removePreset(element.id)" :title="store.locales === 'en' ? 'Delete' : '删除'">
                  <i class="fa fa-trash"></i>
                </button>
              </div>
              <div class="ap-nav-meta">
                <span v-if="element.builtin" class="contact-tag-chip">{{ store.locales === 'en' ? 'built-in' : '内置' }}</span>
                <span v-for="t in (element.tags || []).slice(0, 3)" :key="t" class="contact-tag-chip">{{ t }}</span>
                <span v-if="(element.tags || []).length > 3" class="contact-tag-more">+{{ (element.tags || []).length - 3 }}</span>
                <span v-if="!element.builtin && !(element.tags || []).length" class="ap-nav-meta-text">{{ store.locales === 'en' ? 'custom' : '自定义' }}</span>
                <span class="ap-nav-tools" :title="store.locales === 'en' ? 'Enabled tools' : '启用的工具数'">
                  <i class="fa fa-wrench"></i>{{ presetToolCount(element) }}
                </span>
              </div>
            </div>
          </template>
        </draggable>
      </div>

      <!-- 底栏（与技能 / 插件管理一致）：一行显示 数量 + 存储位置 + 操作图标；窄栏时路径只留图标 -->
      <div class="sk-nav-foot">
        <span class="sk-foot-count">
          {{ presetKeyword ? `${filteredContacts.length} / ${store.agentPresets.length}` : store.agentPresets.length }}
          {{ store.locales === 'en' ? 'presets' : '个预设' }}
        </span>
        <span class="sk-foot-path" @click="openFolderPanel"
          :title="store.agentPresetPath || (store.locales === 'en' ? 'Presets are stored in localStorage' : '预设存在本地存储中')">
          <i class="fa" :class="store.agentPresetPath ? 'fa-folder' : 'fa-database'"></i>
          <span class="sk-foot-path-text">{{ store.agentPresetPath || (store.locales === 'en' ? 'Local storage' : '本地存储') }}</span>
        </span>
        <span class="sk-foot-icons">
          <i v-if="presetIsDefaultFolder" class="fa fa-home sk-foot-icon" :title="store.locales === 'en' ? 'Default preset folder' : '默认预设目录'"></i>
          <i v-else-if="store.agentPresetPath" class="fa fa-undo sk-foot-icon action"
            :title="store.locales === 'en' ? 'Restore the default preset folder' : '恢复默认预设目录'" @click="resetFolder"></i>
          <i class="fa fa-sliders sk-foot-icon action" :title="store.locales === 'en' ? 'Preset storage settings' : '预设存储位置设置'" @click="openFolderPanel"></i>
        </span>
      </div>
    </div>

    <!-- ====== 右侧：预设配置编辑 ====== -->
    <div class="contact-content" v-show="!isTallLayout || !showNavScreen">
      <!-- 细长窗口：编辑屏左上角返回（回到整屏预设列表） -->
      <div v-if="isTallLayout" class="ap-back-bar">
        <div class="ap-back" @click="showNavScreen = true"
          :title="store.locales === 'en' ? 'Back to preset list' : '返回预设列表'">
          <i class="fa fa-arrow-left"></i>
        </div>
        <span class="ap-back-title">{{ store.locales === 'en' ? 'Preset Editor' : '预设编辑' }}</span>
      </div>
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
            <span class="prompt-token-badge" :title="promptTokenTitle">{{ promptTokenLabel }}</span>
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
          <!-- 内置预设才有「出厂默认」：改坏了可一键还原（用户自建预设不显示） -->
          <button v-if="isBuiltinSelected" class="ae-tab ae-tab-reset" @click="resetSelectedToDefault"
            :title="store.locales === 'en'
              ? `Restore “${selected?.name}” to its factory settings (name / model / prompt / tools / skills / MCP / loop sections)`
              : `把「${selected?.name}」恢复为出厂默认（名称 / 模型 / 系统提示 / 工具 / 技能 / MCP / 指令段）`">
            <i class="fa fa-undo"></i> <span class="ae-tab-text">{{ store.locales === 'en' ? 'Reset' : '恢复默认' }}</span>
          </button>
        </div>

        <!-- 通用：基础配置（名称 / 来源 / 模型 / 温度 / 标签 / 系统提示） -->
        <div v-if="activeTab === 'general'" class="ae-tab-body">
          <div class="cfg-row column cfg-box scoll">
            <div class="cfg-row"><label>{{ store.locales === 'en' ? 'Name' : '名称' }}</label><input v-model="selected.name" :placeholder="store.locales === 'en' ? 'Agent Name' : 'Agent 名称'" /></div>
            <div class="cfg-row">
              <label>{{ store.locales === 'en' ? 'Source' : '来源' }}</label>
              <select v-model="sourceValue" @change="onLlmTypeChange">
                <!-- 跟随默认：不绑定具体来源，运行时读「设置 → 模型」的当前来源（换来源 / 换环境无需重配） -->
                <option :value="FOLLOW_DEFAULT_LLM">{{ store.locales === 'en' ? 'Follow default' : '跟随默认' }}</option>
                <option v-for="t in llmTypes" :key="t" :value="t">{{ llmTypeLabel(t) }}</option>
              </select>
            </div>
            <div class="cfg-row">
              <label>{{ store.locales === 'en' ? 'Model' : '模型' }}</label>
              <select v-model="selected.model" style="flex:1;min-width:0" :disabled="sourceFollowsDefault">
                <option value="">{{ sourceFollowsDefault
                  ? (store.locales === 'en' ? '-- Follow default source model --' : '-- 跟随默认来源的模型 --')
                  : (store.locales === 'en' ? '-- Select Model --' : '-- 选择模型 --') }}</option>
                <option v-for="m in getModelsForAgent(selected)" :key="m" :value="m">{{ m }}</option>
              </select>
              <div class="button" style="width:30px;margin:0px;padding:4px 0px;flex-shrink:0" @click="refreshAgentModels()"
                  :title="store.locales === 'en' ? 'Refresh model list of this source' : '刷新该来源的模型列表'">
                <i class="fa" :class="modelListLoading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>
              </div>
            </div>
            <div v-if="sourceFollowsDefault" class="cfg-row">
              <span class="preset-follow-hint">
                <i class="fa fa-refresh"></i>
                {{ store.locales === 'en'
                  ? 'This preset uses whatever source / model is current in Settings → Model, so switching source or moving to another environment needs no reconfiguration here.'
                  : '该预设跟随「设置 → 模型」里的当前来源与模型：之后换来源、换环境都无需再回来改这里。' }}
              </span>
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
              <div class="system-prompt-head">
                <label>{{ store.locales === 'en' ? 'System Prompt' : '系统提示' }}</label>
                <span class="prompt-token-badge" :title="promptTokenTitle">{{ promptTokenLabel }}</span>
              </div>
              <textarea class="scoll" v-model="selected.systemPrompt" :placeholder="store.locales === 'en' ? 'e.g. You are a data analyst... (role description goes here)' : '（智能体设定直接写在此处）'" rows="15"></textarea>
            </div>
          </div>

        </div>

        <!-- 工具：逐真实工具开关（统一数据源 AGENT_TOOL_REGISTRY；写文件=write_file/replace_in_file/multi_replace、读取=read_file+search_files、网页=web_search/web_fetch 各自独立开关） -->
        <div v-if="activeTab === 'tools'" class="ae-tab-body">
          <div class="cfg-row column cfg-box">
            <div class="cap-body">
              <!-- 工具呈现方式 + 能力模板：同一行，说明文字只放 title，不占界面高度 -->
              <div class="preset-tool-config-row">
                <div class="preset-tool-config-item" :title="presentationHint">
                  <span class="exec-config-label">{{ store.locales === 'en' ? 'Presentation' : '呈现方式' }}</span>
                  <select v-model="presentationValue" class="loop-mode-select" :title="presentationHint">
                    <option value="native">{{ store.locales === 'en' ? 'One by one' : '逐个调用' }}</option>
                    <option value="ptc">PTC</option>
                  </select>
                </div>
                <div class="preset-tool-config-item" :title="toolProfileHint">
                  <span class="exec-config-label">{{ store.locales === 'en' ? 'Profile' : '能力模板' }}</span>
                  <select
                    class="loop-mode-select preset-tool-profile-select"
                    :value="activeToolProfile"
                    :title="toolProfileHint"
                    @change="onToolProfileChange"
                  >
                    <option v-for="p in TOOL_PROFILES" :key="p.id" :value="p.id">
                      {{ store.locales === 'en' ? p.labelEn : p.labelZh }}
                    </option>
                    <option value="custom">{{ store.locales === 'en' ? 'Custom' : '自定义' }}</option>
                  </select>
                </div>
              </div>
              <ToolGroupList
                class="preset-tool-groups"
                :rows="toolRows"
                layout="grid"
                @bulk="applyPresetToolBulk"
              >
                <!-- 与搜索 / 已启用过滤 / 展开收起同一条工具条，不再单独占一行 -->
                <template #toolbar-before>
                  <span class="preset-tool-count">
                    {{ store.locales === 'en'
                      ? `${enabledPresetToolCount}/${toolRows.length}`
                      : `已启用 ${enabledPresetToolCount} / ${toolRows.length}` }}
                  </span>
                  <button
                    class="preset-tool-bulkbtn"
                    :title="store.locales === 'en' ? 'Disable all tools' : '全部关闭'"
                    @click="setAllPresetTools(false)"
                  ><i class="fa fa-toggle-off"></i></button>
                  <button
                    class="preset-tool-bulkbtn"
                    :title="store.locales === 'en' ? 'Enable all tools' : '全部开启'"
                    @click="setAllPresetTools(true)"
                  ><i class="fa fa-toggle-on"></i></button>
                </template>
                <template #row="{ row }">
                  <div
                    class="preset-tool-item preset-tool-card"
                    :class="{ on: row.on, gated: row.on && !!row.gateReason }"
                    :title="row.description || row.name"
                    @click="togglePresetTool(row.name)"
                  >
                    <!-- 上半：图标 / 名称与来源、工具名 / 开关 -->
                    <span class="preset-tool-main">
                      <span class="preset-tool-icon"><i class="fa" :class="row.icon"></i></span>
                      <span class="preset-tool-info">
                        <span class="preset-tool-name">{{ row.srcKind === 'plugin' ? row.name : (store.locales === 'zh' ? row.labelZh : row.labelEn) }}</span>
                        <span class="preset-tool-meta">
                          <!-- 来源标识：内置 / 来自某个插件（用户要求：工具名右侧能看出它是内置还是插件给的） -->
                          <span class="preset-tool-src" :class="row.srcKind"
                            :title="row.srcKind === 'plugin'
                              ? (store.locales === 'zh' ? `由插件「${row.srcLabelZh}」提供` : `Provided by plugin “${row.srcLabelEn}”`)
                              : (store.locales === 'zh' ? '应用内置工具' : 'Built-in tool')">
                            <i class="fa" :class="row.srcKind === 'plugin' ? 'fa-puzzle-piece' : 'fa-cube'"></i>
                            {{ row.srcKind === 'plugin' ? row.srcLabelZh : (store.locales === 'zh' ? row.srcLabelZh : row.srcLabelEn) }}
                          </span>
                          <code v-if="row.srcKind !== 'plugin'" class="preset-tool-key">{{ row.name }}</code>
                          <span
                            v-if="row.on && row.gateReason"
                            class="preset-tool-gate"
                            :title="row.gateReason"
                          ><i class="fa fa-pause-circle"></i> {{ store.locales === 'en' ? 'auto' : '自动' }}</span>
                        </span>
                      </span>
                      <span class="preset-tool-toggle" :class="{ on: row.on }"><i class="preset-toggle-knob"></i></span>
                    </span>
                    <!-- 说明：独占底部一行（内置工具描述是中文，英文界面不显示，与原先一致） -->
                    <span
                      v-if="row.srcKind !== 'plugin' && store.locales === 'zh'"
                      class="preset-tool-desc"
                      :title="row.description"
                    >{{ row.description }}</span>
                  </div>
                </template>
              </ToolGroupList>
              <div class="preset-tools-hint">
                <i class="fa fa-info-circle"></i>
                {{ store.locales === 'en'
                  ? 'Each tool toggles independently (same granularity as Tool Management) and is persisted per tool. Writing = write_file / replace_in_file / multi_replace; reading = read_file / search_files; web = web_search / web_fetch. Enabling KB / MCP / Skill opens their config tabs. Plugin tools (marked with a puzzle icon and the plugin name) are NOT enabled by default — tick them here to let this preset call them.'
                  : '每个工具独立开关并精确持久化（与「工具管理」同粒度）。写入文件 = write_file / replace_in_file / multi_replace；读取文件 = read_file / search_files；网页 = web_search / web_fetch。开启 知识库 / MCP / 技能 后可在对应页配置。带拼图图标与插件名的工具由插件提供，**默认不勾选**——要让这个预设能用它，在这里勾上。' }}
              </div>
            </div>
          </div>
        </div>

        <!-- 技能（需在「通用」开启技能库） -->
        <div v-if="activeTab === 'skills'" class="ae-tab-body">
          <div class="cfg-row column cfg-box preset-skill-box">
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
            <!-- 技能按文件夹分组（与「设置 → 技能 → 管理」共用 ToolGroupList + SkillCard，样式一致） -->
            <div v-else class="preset-skill-body">
              <ToolGroupList
                class="preset-skill-groups"
                :sections="skillSections"
                layout="grid"
                :search-placeholder="store.locales === 'en' ? 'Search skills (name / description / folder)' : '搜索技能（名称 / 描述 / 文件夹）'"
                :empty-text="store.locales === 'en' ? 'No matching skills' : '没有匹配的技能'"
                :only-enabled-text="store.locales === 'en' ? 'Selected' : '已选'"
                :bulk-on-text="store.locales === 'en' ? 'All' : '全选'"
                :bulk-off-text="store.locales === 'en' ? 'None' : '全不选'"
                @bulk="applySkillBulk"
              >
                <template #row="{ row }">
                  <SkillCard
                    :name="row.name"
                    :description="row.description"
                    :emoji="row.emoji"
                    :on="row.on"
                    compact
                    highlight-on
                    :toggle-title-on="store.locales === 'en' ? 'Selected for this agent, click to deselect' : '已选中：该智能体可用，点击取消'"
                    :toggle-title-off="store.locales === 'en' ? 'Not selected, click to select' : '未选中：点击勾选给该智能体'"
                    @open="onSkillSelect(row.path)"
                    @toggle="onSkillSelect(row.path)"
                  />
                </template>
              </ToolGroupList>
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
        <div v-if="!presetMenu.preset?.builtin" class="menu-item danger" @click="removePresetFromMenu(); hidePresetMenu()">
          <i class="fa fa-trash"></i> {{ store.locales === 'en' ? 'Delete' : '删除' }}
        </div>
      </div>
    </teleport>

    <!-- 预设存储位置（文件夹管理）：与「插件目录」同一套心智 —— 选目录 / 重新扫描 / 打开目录 / 改回本地 -->
    <teleport to="body">
      <div v-if="folderPanelOpen" class="apf-overlay" @click.self="folderPanelOpen = false">
        <div class="apf-panel">
          <div class="apf-head">
            <i class="fa fa-folder-open-o"></i>
            <span class="apf-title">{{ store.locales === 'en' ? 'Preset storage' : '预设存储位置' }}</span>
            <button class="apf-close" @click="folderPanelOpen = false"
              :title="store.locales === 'en' ? 'Close' : '关闭'"><i class="fa fa-times"></i></button>
          </div>
          <div class="apf-body">
            <div class="apf-mode">
              <span class="apf-badge" :class="{ folder: !!folderInfo.folder }">
                {{ folderInfo.folder ? (store.locales === 'en' ? 'Folder mode' : '文件夹模式') : (store.locales === 'en' ? 'Local storage' : '本地存储') }}
              </span>
              <span v-if="folderInfo.folder" class="apf-path" :title="folderInfo.folder">{{ folderInfo.folder }}</span>
              <span v-else class="apf-path dim">{{ store.locales === 'en' ? 'browser localStorage (agentPresets)' : '浏览器 localStorage（agentPresets）' }}</span>
              <em v-if="presetIsDefaultFolder" class="apf-default-badge">{{ store.locales === 'en' ? 'default' : '默认位置' }}</em>
            </div>

            <div class="apf-hint">
              <template v-if="folderInfo.folder">
                {{ store.locales === 'en'
                  ? 'Each preset is one .agent (JSON) file in this folder. Edits are written back on save, deletes remove the file. Built-in presets are never written here.'
                  : '文件夹模式下：每个预设 = 文件夹里的一个 .agent（JSON）文件。编辑后自动写回文件，删除预设会删掉对应文件；内置预设永不写入此目录（由软件按 id 提供）。' }}
              </template>
              <template v-else>
                {{ store.locales === 'en'
                  ? 'Presets live in browser localStorage: they survive restarts but cannot be edited with external tools. Choose a folder to store each preset as a .agent file.'
                  : '当前预设存在浏览器本地存储：重启不丢，但无法用外部工具编辑 / 版本管理。选择一个文件夹后，每个预设会存成独立的 .agent 文件。' }}
              </template>
            </div>

            <div class="apf-actions">
              <button class="apf-btn primary" :disabled="folderBusy" @click="chooseFolder">
                <i class="fa fa-folder-o"></i>
                {{ folderInfo.folder ? (store.locales === 'en' ? 'Change folder…' : '更换文件夹…') : (store.locales === 'en' ? 'Choose folder…' : '选择文件夹…') }}
              </button>
              <button class="apf-btn" :disabled="folderBusy || !folderInfo.folder" @click="rescanFolder">
                <i class="fa fa-refresh"></i> {{ store.locales === 'en' ? 'Rescan' : '重新扫描' }}
              </button>
              <button class="apf-btn" :disabled="!folderInfo.folder" @click="revealFolder">
                <i class="fa fa-external-link"></i> {{ store.locales === 'en' ? 'Open folder' : '在资源管理器中打开' }}
              </button>
              <button class="apf-btn" :disabled="folderBusy" @click="exportAllPresets">
                <i class="fa fa-upload"></i> {{ store.locales === 'en' ? 'Export all…' : '导出全部…' }}
              </button>
              <button class="apf-btn" :disabled="folderBusy || !folderInfo.folder" @click="useLocalStorage">
                <i class="fa fa-database"></i> {{ store.locales === 'en' ? 'Back to local storage' : '改回本地存储' }}
              </button>
              <button class="apf-btn" :disabled="folderBusy || !folderInfo.folder || presetIsDefaultFolder" @click="resetFolder">
                <i class="fa fa-undo"></i> {{ store.locales === 'en' ? 'Default folder' : '恢复默认位置' }}
              </button>
            </div>

            <div class="apf-status">
              <span v-if="folderInfo.folder">
                <i class="fa fa-file-o"></i>
                {{ store.locales === 'en' ? `${folderInfo.fileCount} .agent file(s)` : `${folderInfo.fileCount} 个 .agent 文件` }}
                <span v-if="!folderInfo.exists" class="apf-warn">
                  {{ store.locales === 'en' ? '(folder unavailable)' : '（目录不可读）' }}
                </span>
              </span>
              <span><i class="fa fa-list"></i> {{ store.locales === 'en' ? `${store.agentPresets.length} preset(s)` : `${store.agentPresets.length} 个预设` }}</span>
              <span class="apf-status-note">{{ store.locales === 'en' ? 'Built-in presets stay out of the folder.' : '内置预设不写入文件夹。' }}</span>
            </div>

            <div v-if="lastScan" class="apf-scan">
              <i class="fa" :class="lastScan.ok ? 'fa-check-circle-o ok' : 'fa-exclamation-triangle err'"></i>
              <span v-if="lastScan.ok">
                {{ store.locales === 'en'
                  ? `Scanned ${lastScan.files} file(s): loaded ${lastScan.loaded}${lastScan.skipped ? `, skipped ${lastScan.skipped} invalid` : ''}${lastScan.skippedBuiltin ? `, ignored ${lastScan.skippedBuiltin} built-in id` : ''}`
                  : `已扫描 ${lastScan.files} 个文件：载入 ${lastScan.loaded} 个${lastScan.skipped ? `，跳过 ${lastScan.skipped} 个损坏/缺 id` : ''}${lastScan.skippedBuiltin ? `，忽略 ${lastScan.skippedBuiltin} 个占用内置 id 的文件` : ''}` }}
              </span>
              <span v-else>{{ store.locales === 'en' ? `Cannot read folder: ${lastScan.error || 'unknown error'}` : `目录不可读：${lastScan.error || '未知错误'}` }}</span>
            </div>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'
import { ElMessage, ElMessageBox } from 'element-plus'
import draggable from 'vuedraggable'
import { mcpManager } from '@/platform/mcpManager'
import { toolsFromCapabilities, setToolEnabled, toolOn, getPluginToolNames, isPluginTool, syncCapabilityBooleans, selectedToolOn, migratePresetToolBundles, CAPABILITY_TOOL_SLOTS, slotToolsOf } from '@/lib/agent/capabilities'
import { TOOL_PROFILES, profileOfBundles, profileOfTools } from '@/lib/agent/toolProfiles'
import { autoToolsOf, groupTools as bundleGroupTools, selectedToolsOf, setBundleEnabled, toolGateReason as sharedToolGateReason, type ToolGateEnv } from '@/lib/agent/toolBundles'
import { TOOL_GROUPS } from '@/lib/agent/toolGroups'
import { modelSupportsVision } from '@/shared/visionSupport'
import { pluginDisplayName, pluginToolScopes } from '@/lib/plugin/runtime'
import { AGENT_TOOL_REGISTRY, type AgentToolInfo } from '@/services/agentSkills'
import ToolGroupList from '@/components/set/ToolGroupList.vue'
import SkillCard from '@/components/set/SkillCard.vue'
import { groupSkillRowsByFolder } from '@/lib/agent/skillFolders'
import type { GroupableToolRow } from '@/lib/agent/toolGroups'
import {
  scanAgentPresets, writeAgentPreset, removeAgentPreset, agentFilePath, exportAllAgentPresets,
  chooseAgentPresetFolder, closeAgentPresetFolder, revealAgentPresetFolder, agentPresetFolderInfo,
  type AgentPresetScanSummary,
} from '@/composables/useAgentPresets'
import { ensureDefaultAgentPresetFolder, resetAgentPresetFolderToDefault, isDefaultAgentPresetFolder } from '@/composables/useDefaultStorage'
import { renderLoopSections, SKILL_AGENT_DEFAULT_TOOLS } from '@/lib/agent/skill'
import { assembleAgentSystemPrompt } from '@/lib/agent/promptContext'
import { estimateTokens } from '@/shared/contextBudget'
import { AGENT_MAX_STEPS_MAX, DEFAULT_AGENT_MAX_STEPS } from '@/shared/agent-loop-rounds'
import { BUILTIN_AGENT_PRESET_IDS, isBuiltinAgentPreset, resetBuiltinAgentPreset, builtinPresetDefaultsFromStore, ensureBuiltinAgentPresets } from '@/shared/builtinAgentPresets'
import { FOLLOW_DEFAULT_LLM, deepSeekStyleOf, normalizeLlmTypeList, presetFollowsDefaultLlm } from '@/shared/llmSources'
import { getPlatform, hasCapability } from '@/platform'
import { useTallLayout } from '@/composables/useTallLayout'
import { useMobileBackScreen } from '@/composables/useBackLayer'

const store = usestore()

// 细长窗口（高宽比 > 16:9，如手机竖屏）：预设列表与编辑区不再并排（并排会把编辑区挤到只剩
// 一两百像素），而是各占满整屏互相切换（与设置导航 / 知识管理文件树 / MCP 设置同一套做法）。
// true = 预设列表屏，false = 编辑屏；宽窗口下两者并排，本状态无意义。
const isTallLayout = useTallLayout()
const showNavScreen = ref(true)

// 安卓返回手势：细长窗口下本面板是「列表 ⇄ 内容」两屏，内容屏按返回回到列表（见 composables/useBackLayer）
useMobileBackScreen('settings:agentpreset', isTallLayout, showNavScreen)

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

/** 列表头像图标：内置预设用各自图标（代码 / 办公 / PTC），其余为用户图标 */
const presetIcon = (p: any): string =>
  p?.id === BUILTIN_AGENT_PRESET_IDS.code ? 'fa-code'
    : p?.id === BUILTIN_AGENT_PRESET_IDS.office ? 'fa-briefcase'
      : p?.id === BUILTIN_AGENT_PRESET_IDS.ptc ? 'fa-file-code-o'
        : p?.id === BUILTIN_AGENT_PRESET_IDS.plugin ? 'fa-puzzle-piece'
          : p?.id === BUILTIN_AGENT_PRESET_IDS.pi ? 'fa-terminal'
            : p?.id === BUILTIN_AGENT_PRESET_IDS.dsh ? 'fa-cubes'
              : p?.id === BUILTIN_AGENT_PRESET_IDS.codex ? 'fa-window-maximize'
                : p?.id === BUILTIN_AGENT_PRESET_IDS.skillDesigner ? 'fa-book'
                  : p?.id === BUILTIN_AGENT_PRESET_IDS.designer ? 'fa-magic'
                    : 'fa-user'

/** 列表 meta 行：该预设启用的工具数（旧预设有能力槽、没有 enabledTools 时按能力槽推导） */
const presetToolCount = (p: any): number => toolsFromCapabilities(p?.capabilities || {}).length

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
      /** 'auto' = 由 toolBundles + toolOverrides 解析（新）；'custom'/缺省 = enabledTools 旧模式 */
      toolMode?: 'auto' | 'custom'
      /** 已选能力域（TOOL_GROUPS.id）；新工具登记进这些域后会自动进入预设 */
      toolBundles?: string[]
      /** 单工具偏差：include 额外加、exclude 单独关 */
      toolOverrides?: { include?: string[]; exclude?: string[] }
  knowledgeBaseFiles: string[]
}
interface AgentPreset {
  id: string
  name: string
  /** 是否为出厂内置预设（代码智能体 / 办公智能体）：不可删除 */
  builtin?: boolean
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
  /**
   * 工具呈现方式（对齐 DeepSeek-Harness 的 preset `mode`）：
   * 'native'（缺省）= 逐个工具 schema 暴露；'ptc' = 只暴露 run_code，模型写程序经 SDK 调工具。
   */
  presentation?: 'native' | 'ptc'
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

// 工具标签页：逐真实工具行（内置来自 AGENT_TOOL_REGISTRY；插件来自已激活插件同步过来的名单）
// 每行带 **来源**：内置，或某个插件（方案 B：插件工具与内置工具一视同仁，勾了才生效）
type ToolRow = AgentToolInfo & {
  on: boolean
  srcKind: 'builtin' | 'plugin'
  srcLabelZh: string
  srcLabelEn: string
  /** 自动门控原因（仍可手动开关；运行时会被对应条件过滤） */
  gateReason?: string
}

/** `plugin:math-proof-graph` → `math-proof-graph`；非插件 scope 返回空串 */
const pluginNameOfScope = (scope: unknown): string => {
  const s = String(scope || '')
  return s.startsWith('plugin:') ? (s.slice('plugin:'.length).split('/')[0] || '') : ''
}

/** 已激活插件提供的工具行（名字与来源都来自渲染层同步的名单） */
const pluginToolRows = computed<ToolRow[]>(() => {
  const caps: any = selected.value?.capabilities
  const scopes = pluginToolScopes.value
  return getPluginToolNames().map((name) => {
    const pid = pluginNameOfScope(scopes[name])
    // 插件清单里的 aikm.name 就是它唯一的显示名（插件名没有中英两套），中英界面都显示它
    const zh = pluginDisplayName(pid)
    return {
      // 插件工具没有静态展示元数据：标签留空，界面直接显示工具名本身
      name,
      labelZh: '',
      labelEn: '',
      icon: 'fa-puzzle-piece',
      description: '',
      sandboxPreference: 'none',
      approvalRequirement: 'on-request',
      defaultEnabled: false,
      on: toolOn(caps, name),
      srcKind: 'plugin',
      srcLabelZh: zh,
      srcLabelEn: zh,
    } as ToolRow
  })
})

/** 工具是否被用户勾选：自动模式看包 + 覆盖；旧模式看 enabledTools（插件仍按可用判定） */
const presetToolSelected = (caps: any, name: string): boolean => selectedToolOn(caps, name)

const toolRows = computed<ToolRow[]>(() => [
  ...AGENT_TOOL_REGISTRY.map((t) => ({
    ...t,
    on: presetToolSelected(selected.value?.capabilities, t.name),
    srcKind: 'builtin' as const,
    srcLabelZh: '内置',
    srcLabelEn: 'Built-in',
    gateReason: presetToolGateReason(t.name),
  })),
  ...pluginToolRows.value,
])
/** 当前预设实际启用的工具数（与卡片上的工具数同一份数据源） */
const enabledPresetToolCount = computed(() => toolRows.value.filter((r) => r.on).length)

/**
 * 当前模型是否支持图片输入（三态）。只用于界面提示「read_image 会自动暂停」，
 * 不改变用户的选择；运行时的图片降级由 agent-loop 处理。
 */
const presetVisionSupport = computed<boolean | undefined>(() => {
  const p: any = selected.value
  if (!p) return undefined
  const provider = String(p.llmType || store.AIconfig.llm.type || '')
  const cfg: any = store.AIconfig.llm as any
  let model = String(p.model || '')
  if (!model) {
    if (provider === 'custom') model = String(cfg.custom?.model || '')
    else model = String(cfg?.[provider]?.model || '')
  }
  return modelSupportsVision(provider, model)
})

/**
 * 当前工具集匹配的能力模板；手工增删后自动显示「自定义」。
 * 插件工具不参与模板匹配（模板只管理内置工具，插件工具仍按用户勾选）。
 */
const activeToolProfile = computed(() => {
  const caps = selected.value?.capabilities as any
  // 自动模式按能力域集合匹配：单工具覆盖不会把「编码助手」跳成「自定义」。
  if (caps?.toolMode === 'auto') return profileOfBundles(caps.toolBundles)
  // 旧模式按实际工具集匹配（不经过运行时过滤）。
  const builtin = (Array.isArray(caps?.enabledTools) ? caps.enabledTools : toolsFromCapabilities(caps))
    .filter((t: string) => !isPluginTool(t))
  return profileOfTools(builtin)
})

/** 预设编辑界面的门控环境：与聊天运行时同一套字段，界面提示和实际过滤保持一致 */
const presetGateEnv = computed<ToolGateEnv>(() => {
  const caps: any = selected.value?.capabilities
  const mcpServers = Array.isArray(caps?.mcpServerIds) ? caps.mcpServerIds.length : 0
  const mcpEquipment = Array.isArray(caps?.mcpEquipmentIds) ? caps.mcpEquipmentIds.length : 0
  const sandboxMode = String(store.pythonSandbox || (store.TrustedPython ? 'trusted' : 'safe'))
  return {
    supportsVision: presetVisionSupport.value,
    sandboxMode,
    hasKnowledge: Array.isArray(caps?.knowledgeBaseFiles) && caps.knowledgeBaseFiles.length > 0,
    hasMcpServers: !!caps?.mcpAccess && (mcpServers + mcpEquipment > 0),
    browserAvailable: caps?.browseWebsites ? undefined : false,
    interactive: true,
    nestedDepth: 0,
  }
})

/** 自动门控原因：只影响展示与运行时过滤，不改变用户勾选（勾选仍可手动改） */
const presetToolGateReason = (tool: string): string => {
  if (!selected.value?.capabilities) return ''
  return sharedToolGateReason(tool, presetGateEnv.value, store.locales === 'zh')
}

/** 选择能力模板：写入该场景的能力域（新工具以后会自动进入这些域）；插件工具保持原样 */
const onToolProfileChange = (event: Event) => {
  const id = String((event.target as HTMLSelectElement).value || '')
  const caps = selected.value?.capabilities as any
  if (!caps || !id || id === 'custom') return
  const profile = TOOL_PROFILES.find((p) => p.id === id)
  if (!profile) return
  const pluginTools = selectedToolsOf(caps).filter((t: string) => isPluginTool(t))
  caps.toolMode = 'auto'
  caps.toolBundles = profile.groups.slice()
  caps.toolOverrides = pluginTools.length ? { include: pluginTools } : {}
  caps.enabledTools = autoToolsOf(caps)
  syncCapabilityBooleans(caps)
}

/** 逐工具开关；关闭 kb_search / mcp_call 时联动清空已关联项（对齐旧 onCapToggle 行为） */
const togglePresetTool = (tool: string) => {
  const caps = selected.value?.capabilities as any
  if (!caps) return
  const wasOn = presetToolSelected(caps, tool)
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

/**
 * 组内全开 / 全关：与单工具开关同语义（逐工具写 `caps.enabledTools`），恒开工具跳过。
 * 关掉 mcp_call / kb_search 时联动清空已关联的服务 / 库文件（与 togglePresetTool 一致），
 * 否则会出现“工具关了但配置还挂着”的半截状态。
 */
const applyPresetToolBulk = ({ rows, on, groupId }: { rows: ToolRow[]; on: boolean; groupId?: string }) => {
  const caps = selected.value?.capabilities as any
  if (!caps) return
  // 自动模式：当前可见行覆盖整组时，直接切换能力域（以后该域新增工具会自动跟随）；
  // 搜索/过滤导致只看到部分行时，退回逐工具覆盖，避免误改没显示的工具。
  if (caps.toolMode === 'auto' && groupId) {
    const groupTools = bundleGroupTools(groupId)
    const noPlugins = rows.every((r) => r.srcKind !== 'plugin')
    if (noPlugins && groupTools.length > 0 && rows.length === groupTools.length) {
      setBundleEnabled(caps, groupId, on)
      // 浏览器的「全开/全关」历史上同时覆盖核心与扩展两组，保持一致
      if (groupId === 'browser') setBundleEnabled(caps, 'browser-extra', on)
      syncCapabilityBooleans(caps)
      if (!on && groupId === 'integration') {
        caps.mcpServerIds = []
        caps.mcpEquipmentIds = []
        mcpEquipmentOptions.value = []
      }
      if (!on && groupId === 'knowledge') caps.knowledgeBaseFiles = []
      return
    }
  }
  let turnedOffMcp = false
  let turnedOffKb = false
  for (const row of rows) {
    if (row.alwaysOn) continue
    const wasOn = presetToolSelected(caps, row.name)
    setToolEnabled(caps, row.name, on)
    if (wasOn && !on) {
      if (row.name === 'mcp_call') turnedOffMcp = true
      else if (row.name === 'kb_search') turnedOffKb = true
    }
  }
  // 浏览器自动化有一批工具只存在于能力槽里（browser_learning_* / browser_claim_tab /
  // browser_playbook_* 等），没有卡片。整组全关/全开时也要一起处理，否则统一工具注册表
  // 会显示它们仍然开着（用户实测「全关」后还剩 17 个）。
  if (caps.toolMode !== 'auto' && groupId === 'browser') {
    const browserTools = slotToolsOf('browseWebsites')
    const list = new Set<string>(Array.isArray(caps.enabledTools) ? caps.enabledTools : toolsFromCapabilities(caps))
    for (const name of browserTools) {
      if (on) list.add(name)
      else list.delete(name)
    }
    caps.enabledTools = Array.from(list)
    syncCapabilityBooleans(caps)
  }
  if (turnedOffMcp) {
    caps.mcpServerIds = []
    caps.mcpEquipmentIds = []
    mcpEquipmentOptions.value = []
  }
  if (turnedOffKb) caps.knowledgeBaseFiles = []
}

/** 一键全部开启 / 关闭当前预设的所有工具（含未出现在卡片里的浏览器扩展工具） */
const setAllPresetTools = (on: boolean) => {
  const caps = selected.value?.capabilities as any
  if (!caps) return
  if (caps.toolMode === 'auto') {
    if (on) {
      caps.toolBundles = TOOL_GROUPS.map((g) => g.id)
      const plugins = toolRows.value.filter((r) => r.srcKind === 'plugin').map((r) => r.name)
      caps.toolOverrides = plugins.length ? { include: plugins } : {}
    } else {
      caps.toolBundles = []
      caps.toolOverrides = {}
    }
    caps.enabledTools = autoToolsOf(caps)
    syncCapabilityBooleans(caps)
  } else if (on) {
    const seeded: any = { ...caps, enabledTools: undefined }
    for (const slot of CAPABILITY_TOOL_SLOTS) seeded[slot.key] = true
    const all = new Set<string>(toolsFromCapabilities(seeded))
    for (const row of toolRows.value) all.add(row.name)
    caps.enabledTools = Array.from(all)
    syncCapabilityBooleans(caps)
  } else {
    caps.enabledTools = []
    syncCapabilityBooleans(caps)
  }
  if (!on) {
    caps.mcpServerIds = []
    caps.mcpEquipmentIds = []
    caps.knowledgeBaseFiles = []
    mcpEquipmentOptions.value = []
  }
}

// 工具呈现方式（缺省 native）：写入预设顶层 presentation 字段，运行时据此叠 SDK 段 / 补 run_code
const presentationValue = computed<string>({
  get: () => (selected.value?.presentation === 'ptc' ? 'ptc' : 'native'),
  set: (v: string) => {
    if (!selected.value) return
    selected.value.presentation = v === 'ptc' ? 'ptc' : 'native'
  },
})
const presentationHint = computed(() => (store.locales === 'en'
  ? 'One by one: every enabled tool is exposed as a function schema. PTC: the model only sees run_code and composes the enabled tools inside a TypeScript program (run_code is turned on automatically and is not listed here).'
  : '逐个调用：每个启用的工具以函数 schema 暴露给模型。PTC（程序化工具调用）：模型只看到 run_code，用一段 TypeScript 程序组合调用下面启用的工具（run_code 自动启用，不在列表中）。'))
const toolProfileHint = computed(() => (store.locales === 'en'
  ? 'Apply a profile to fill this preset’s built-in tools in one click; every group and individual tool below still toggles as before.'
  : '选择模板可一键填入该场景的内置工具；下方仍按组 / 按工具逐项开关，和以前一样。'))

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
/** 当前预设是否「跟随默认」（来源 / 模型都读全局配置） */
const sourceFollowsDefault = computed(() => presetFollowsDefaultLlm(selected.value))
/**
 * 来源下拉的取值：跟随默认显示哨兵档位（空串是历史数据里的「未配置」，两者都归到该档）。
 * 写回时**只往预设里写空串 / 具体来源键**，哨兵值不落盘。
 */
const sourceValue = computed<string>({
  get: () => (sourceFollowsDefault.value ? FOLLOW_DEFAULT_LLM : String(selected.value?.llmType || '')),
  set: (v: string) => {
    if (!selected.value) return
    selected.value.llmType = v === FOLLOW_DEFAULT_LLM ? '' : v
  },
})
const getModelsForAgent = (agent: AgentPreset): string[] => {
  const cfg = store.AIconfig.llm
  if (!cfg) return []
  // 跟随默认：来源与模型都读全局，模型候选也用全局来源的列表
  const follow = presetFollowsDefaultLlm(agent)
  const type = follow ? String(cfg.type || '') : (agent.llmType || cfg.type)
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
  // 跟随默认时预设不持有模型 → 不合并，避免残留旧模型名让人以为还在绑定
  const saved = follow ? '' : String(agent?.model || '').trim()
  if (saved && !list.includes(saved)) list = [saved, ...list]
  return list.filter(Boolean)
}

// ====== 技能列表 ======
interface SkillInfo {
  name: string
  path: string
  description: string
  emoji: string
  /** 分类目录（相对技能根，`/` 分隔；根下为空串），主进程扫描时给出 */
  folder?: string
}
const skillList = ref<SkillInfo[]>([])
const loadSkillList = async () => {
  if (!store.skillsPath) { skillList.value = []; return }
  try {
    const loaded = await getPlatform().host.skills.list(store.skillsPath)
    const disabled = new Set(store.disabledSkills || [])
    skillList.value = (loaded || [])
      .filter((s: any) => !disabled.has(s.name))
      .map((s: any) => ({
        name: s.name,
        path: s.path,
        description: s.description || '',
        emoji: s.metadata?.emoji || '',
        folder: s.folder || '',
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

/** 分组列表的行数据：ToolGroupList 要的字段（GroupableToolRow）+ 技能卡片 / 选中逻辑要的字段 */
interface PresetSkillRow extends GroupableToolRow {
  path: string
  folder: string
  emoji: string
}

const presetSkillRows = computed<PresetSkillRow[]>(() => skillList.value.map((s) => ({
  name: s.name,
  labelZh: s.name,
  labelEn: s.name,
  icon: 'fa-cube',
  description: s.description || '',
  on: isSkillSelected(s.path),
  srcKind: 'builtin',
  path: s.path,
  folder: s.folder || '',
  emoji: s.emoji || '',
})))

/** 按文件夹分组（与「设置 → 技能 → 管理」共用 skillFolders 那份逻辑；2~3 级目录显示成 分类 / 子分类） */
const skillSections = computed(() => groupSkillRowsByFolder(presetSkillRows.value, { zh: store.locales === 'zh' }))

/** 组内全选 / 全不选：只改当前预设的 selectedSkills（与工具 tab 的组内批量同一套语义，只作用于可见行） */
const applySkillBulk = ({ rows, on }: { rows: PresetSkillRow[]; on: boolean }) => {
  if (!selected.value) return
  const paths = new Set(selected.value.selectedSkills || [])
  for (const row of rows) {
    if (on) paths.add(row.path)
    else paths.delete(row.path)
  }
  selected.value.selectedSkills = Array.from(paths)
}

// ====== 知识库文件列表 ======
interface KbFileInfo { label: string; path: string }
const knowledgeBaseList = ref<KbFileInfo[]>([])
const scanKnowledgeBases = async () => {
  if (!store.root) return
  try {
    const result = await getPlatform().fs.listTreeWithRelations(store.root, 1)
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
      // 仅当服务确实提供 list_agents 时才查询装备：向不支持该工具的服务（Web Agent / Office / drawio / 文献检索 等）
      // 盲发调用会把未知工具名交给主进程执行，产生无谓副作用（浏览器 Agent 会被拉起窗口）
      const tools = mcpManager.getTools(serverId, serverId) || []
      if (!tools.some((t: any) => t && t.name === 'list_agents')) continue
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
  const path = await getPlatform().dialog.pickFile()
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
/** 当前选中的是出厂内置预设（只有内置项有「出厂默认」可恢复） */
const isBuiltinSelected = computed(() => !!selected.value && isBuiltinAgentPreset(selected.value))

/**
 * 把当前内置预设恢复为出厂默认：确认后按 id 就地还原内容（名称 / 模型 / 提示词 / 工具 / 技能 / MCP / 指令段）。
 * 出厂定义里来源与模型为空时沿用当前全局配置（与首次注入内置预设的行为一致）。
 */
const resetSelectedToDefault = async () => {
  const p = selected.value
  if (!p || !isBuiltinAgentPreset(p)) return
  try {
    await ElMessageBox.confirm(
      store.locales === 'en'
        ? `Restore “${p.name}” to factory settings? Everything you edited on this preset (name / model / prompt / tools / skills / MCP / loop sections) will be replaced by the built-in defaults. Its source goes back to “Follow default” too.`
        : `把「${p.name}」恢复为出厂默认？你在这个预设上改过的名称 / 模型 / 系统提示 / 工具 / 技能 / MCP / 指令段都会被内置默认值替换，来源也会恢复为「跟随默认」。`,
      store.locales === 'en' ? 'Restore built-in preset' : '恢复内置预设',
      {
        type: 'warning',
        confirmButtonText: store.locales === 'en' ? 'Restore' : '恢复',
        cancelButtonText: store.locales === 'en' ? 'Cancel' : '取消',
      },
    )
  } catch {
    return
  }
  if (resetBuiltinAgentPreset(store.agentPresets as any[], p.id, builtinPresetDefaultsFromStore(store))) {
    activeTab.value = 'general'
    // 恢复后能力槽 / 工具集可能与当前所在 tab 不再匹配（如技能被关掉），回到「通用」页最稳妥
    ElMessage.success(store.locales === 'en' ? 'Restored to factory settings' : '已恢复为出厂默认')
  }
}
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
/** 技能清单 → 系统提示词组装所需的简要技能信息 */
const promptSkillBriefs = computed(() => skillList.value.map((s) => ({
  name: s.name,
  path: s.path,
  description: s.description,
})))
/**
 * 当前「通用」面板配置下的系统提示词占用（实时估算）：
 * 与运行时共用 assembleAgentSystemPrompt，因此系统提示、工具说明、技能库、知识库提示、
 * 指令段 / 工作区提示等配置一改，数字立即跟着变。通用智能体（内置虚拟项）按默认工具集 + 全部技能估算。
 */
const promptTokenEstimate = computed(() => {
  const p = selected.value
  if (!p) return 0
  const general = isGeneral.value
  const assembled = assembleAgentSystemPrompt({
    store,
    preset: general ? null : p,
    tools: general
      ? (store.agentTools === null ? [...SKILL_AGENT_DEFAULT_TOOLS] : [...store.agentTools])
      : presetTools.value,
    enabledSkills: promptSkillBriefs.value,
    disabledSkills: store.disabledSkills || [],
    model: p.model || undefined,
    provider: p.llmType || undefined,
    workspace: store.root || undefined,
  })
  return estimateTokens(assembled.systemPrompt)
})
const promptTokenLabel = computed(() => {
  const zh = store.locales === 'zh'
  const n = promptTokenEstimate.value.toLocaleString()
  return zh ? `系统提示词 ≈ ${n} tokens` : `System prompt ≈ ${n} tokens`
})
const promptTokenTitle = computed(() => store.locales === 'zh'
  ? '按当前系统提示词 / 工具 / 技能 / 知识库配置实时估算（不含对话历史与工具 schema）'
  : 'Live estimate from the current system prompt / tools / skills / knowledge-base config (excludes chat history and tool schemas)')
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

const selectPreset = (id: string) => { selectedId.value = id; activeTab.value = 'general'; showNavScreen.value = false }

/**
 * 拖动结束后强制「内置在上、自定义在下」：
 * 允许内置项之间 / 自定义项之间调整顺序，但不允许把自定义项拖到内置项上面
 * （下一次启动时 ensureBuiltinAgentPresets 也会做同样的整理，这里让拖完立刻归位）。
 */
const enforcePresetOrder = () => {
  if (ensureBuiltinAgentPresets(store.agentPresets as any[])) store.saveConfig()
}

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
    name: uniquePresetName(`${preset.name || 'Agent'}${store.locales === 'en' ? ' (copy)' : ' 副本'}`),
  }
  // 副本是普通预设：不带内置标记（否则会变成“不可删除”）
  delete (clone as any).builtin
  store.agentPresets.push(clone)
  selectedId.value = clone.id
  showNavScreen.value = false   // 细长窗口：副本建好后直接进编辑屏
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
    const filePath = await getPlatform().dialog.saveFile({
      defaultPath: `${safeName}.agent`,
      filters: [
        { name: 'Agent Preset', extensions: ['agent'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (filePath) {
      await getPlatform().fs.writeText(filePath, JSON.stringify(preset, null, 2))
      ElMessage.success(store.locales === 'en' ? 'Exported' : '已导出 .agent 文件')
    }
  } catch (e: any) {
    ElMessage.error(store.locales === 'en' ? `Export failed: ${e?.message || e}` : `导出失败：${e?.message || e}`)
  }
}

/** 删除：右键菜单调用（复用 removePreset，删除 .agent 文件并移出列表） */
const removePresetFromMenu = () => {
  const p = presetMenu.value.preset
  // 内置项不可删除：通用智能体（虚拟项）+ 出厂预设（代码智能体 / 办公智能体）
  if (!p || p.id === GENERAL_PRESET_ID || isBuiltinAgentPreset(p)) return
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

/** 生成不重名的预设名：新 Agent / 新 Agent 2 / 新 Agent 3 …（文件夹里也不会互相覆盖） */
const uniquePresetName = (base: string): string => {
  const used = new Set((store.agentPresets as any[]).map((p) => String(p?.name || '').trim()).filter(Boolean))
  const root = String(base || '').trim() || (store.locales === 'en' ? 'New Agent' : '新 Agent')
  if (!used.has(root)) return root
  let n = 2
  while (used.has(`${root} ${n}`)) n++
  return `${root} ${n}`
}

/** 新建预设（写入 .agent 文件） */
const addPreset = async () => {
  const preset: AgentPreset = {
    id: genId(),
    name: uniquePresetName(store.locales === 'en' ? 'New Agent' : '新 Agent'),
    tags: [],
    // 默认「跟随默认」：不绑定来源与模型，运行时读全局「设置 → 模型」的当前值
    // （换来源 / 换环境后无需回头逐个改预设；想钉死某个来源时在「通用」页手动选）
    llmType: '',
    model: '',
    systemPrompt: '',
    temperature: 0.7,
    kbTopK: 3,
    // 默认全选所有已启用技能（＝与通用智能体一致）
    selectedSkills: [...skillList.value.map(s => s.path)],
    // 工具能力默认：读写 / 搜索 / 代码 / 联网搜索 / 技能 / 计划待办，浏览器自动化默认关闭
    // enabledTools 是唯一权威（显式给出），避免旧模式能力槽推导漏关/多算
    capabilities: (() => {
      const caps = defaultCapabilities()
      Object.assign(caps, {
        readFiles: true, executeCode: true, webSearch: true,
        accessKnowledgeBase: false, browseWebsites: false,
        writeFiles: true, listDirs: true, runShell: false,
        runSubagent: false, skills: true,
        askUser: true, updatePlan: true, updateTodo: true,
        mcpAccess: false, mcpServerIds: [], mcpEquipmentIds: [],
        knowledgeBaseFiles: [],
      })
      caps.enabledTools = toolsFromCapabilities({ ...caps, enabledTools: undefined })
      // 新预设直接进入「能力包 + 覆盖」模式：以后新增工具会自动跟随对应能力域
      migratePresetToolBundles(caps)
      syncCapabilityBooleans(caps)
      return caps
    })(),
    maxSteps: DEFAULT_AGENT_MAX_STEPS,
    seedHistory: true,
    loopPromptMode: 'auto',
    loopSections: [],
  }
  store.agentPresets.push(preset)
  selectedId.value = preset.id
  showNavScreen.value = false   // 细长窗口：新建后直接进编辑屏
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
  const target = store.agentPresets.find((c: AgentPreset) => c.id === id)
  if (isBuiltinAgentPreset(target)) return // 出厂内置预设（代码智能体 / 办公智能体）不可删除
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

// ====== 预设存储位置（文件夹管理，对齐「插件 → 管理」的目录操作）======
/** 面板开关 */
const folderPanelOpen = ref(false)
/** 当前目录现状（空 folder = 本地存储模式） */
const folderInfo = ref<{ folder: string; exists: boolean; fileCount: number }>({ folder: '', exists: false, fileCount: 0 })
/** 最近一次扫描结果（选目录 / 重新扫描后展示「载入了几个、跳过了几个」） */
const lastScan = ref<AgentPresetScanSummary | null>(null)
/** 目录操作进行中（避免重复点按钮） */
const folderBusy = ref(false)

/** 路径末段（侧栏 chip 上只显示文件夹名，悬浮才给完整路径） */
const folderNameOf = (p: string): string => {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p || '')
}

/** 当前目录是否是**默认位置**（userData/agent-presets）；决定「默认位置」徽标与「恢复默认位置」按钮 */
const presetIsDefaultFolder = ref(false)
const refreshFolderInfo = async () => {
  folderInfo.value = await agentPresetFolderInfo()
  presetIsDefaultFolder.value = await isDefaultAgentPresetFolder()
}

const openFolderPanel = async () => {
  folderPanelOpen.value = true
  await refreshFolderInfo()
}

/** 选择文件夹并启用文件夹模式（文件为准；空目录会把当前自建预设写进去，避免"切过去就空了"） */
const chooseFolder = async () => {
  if (folderBusy.value) return
  folderBusy.value = true
  try {
    // 快照：scan 会用文件夹内容替换内存列表，所以必须在此之前把当前自建预设留下来
    const presetsBefore = (store.agentPresets as any[])
      .filter((p) => !isBuiltinAgentPreset(p))
      .map((p) => JSON.parse(JSON.stringify(p)))
    const summary = await chooseAgentPresetFolder({ seedPresets: presetsBefore })
    if (!summary) return // 用户取消
    lastScan.value = summary
    await refreshFolderInfo()
    store.ensureBuiltinAgentPresets()
    if (!summary.ok) {
      ElMessage.error(store.locales === 'en'
        ? `Folder selected but cannot be read: ${summary.error || 'unknown error'}`
        : `已选择文件夹，但读不了：${summary.error || '未知错误'}`)
      return
    }
    const seeded = Number(summary.seeded || 0)
    ElMessage.success(store.locales === 'en'
      ? `Folder mode on: loaded ${summary.loaded} preset(s) from ${summary.files} file(s)${summary.skipped ? `, skipped ${summary.skipped}` : ''}${seeded ? `, wrote ${seeded} existing preset(s) into the empty folder` : ''}`
      : `已启用文件夹模式：从 ${summary.files} 个文件载入 ${summary.loaded} 个预设${summary.skipped ? `，跳过 ${summary.skipped} 个` : ''}${seeded ? `；目录原本是空的，已把 ${seeded} 个现有预设写成 .agent 文件` : ''}`)
  } finally {
    folderBusy.value = false
  }
}

/** 重新扫描（目录里手动增删 .agent 后不用重启） */
const rescanFolder = async () => {
  if (folderBusy.value) return
  folderBusy.value = true
  try {
    const summary = await scanAgentPresets()
    lastScan.value = summary
    await refreshFolderInfo()
    store.ensureBuiltinAgentPresets()
    if (summary.ok) {
      ElMessage.success(store.locales === 'en'
        ? `Rescanned: ${summary.loaded} preset(s)`
        : `已重新扫描：${summary.loaded} 个预设`)
    } else {
      ElMessage.error(store.locales === 'en'
        ? `Rescan failed: ${summary.error || 'folder unavailable'}`
        : `重新扫描失败：${summary.error || '目录不可读'}`)
    }
  } finally {
    folderBusy.value = false
  }
}

/** 在系统文件管理器里打开预设文件夹 */
const revealFolder = async () => {
  if (!folderInfo.value.folder) return
  const ok = await revealAgentPresetFolder()
  if (!ok) {
    ElMessage.warning(store.locales === 'en'
      ? 'Cannot open the folder on this platform'
      : '当前平台打不开文件夹（请手动前往该路径）')
  }
}

/** 改回本地存储（不删磁盘文件；当前列表写进 localStorage 后保持） */
const useLocalStorage = async () => {
  try {
    await ElMessageBox.confirm(
      store.locales === 'en'
        ? 'Switch back to browser localStorage? Current presets stay in the list and are saved there. Files in the folder are NOT deleted.'
        : '改回浏览器本地存储？当前预设会保留在列表里并写入本地存储；文件夹里的 .agent 文件不会被删除。',
      store.locales === 'en' ? 'Back to local storage' : '改回本地存储',
      { type: 'warning', confirmButtonText: store.locales === 'en' ? 'Switch' : '改回', cancelButtonText: store.locales === 'en' ? 'Cancel' : '取消' },
    )
  } catch { return }
  folderBusy.value = true
  try {
    await closeAgentPresetFolder()
    lastScan.value = null
    await refreshFolderInfo()
    ElMessage.success(store.locales === 'en' ? 'Now using local storage' : '已改回本地存储')
  } finally {
    folderBusy.value = false
  }
}

/** 恢复默认预设目录（userData/agent-presets）；不删旧目录里的文件，空目录时会把当前预设落进去 */
const resetFolder = async () => {
  if (folderBusy.value) return
  try {
    await ElMessageBox.confirm(
      store.locales === 'en'
        ? 'Back to the default preset folder (application data → agent-presets)? Files in the current folder are NOT deleted; if the default folder is empty, current presets are written into it.'
        : '恢复到默认预设目录（应用数据目录 → agent-presets）？当前文件夹里的 .agent 文件不会被删除；默认目录为空时会把当前预设写进去。',
      store.locales === 'en' ? 'Default preset folder' : '恢复默认预设目录',
      { type: 'info', confirmButtonText: store.locales === 'en' ? 'Restore' : '恢复', cancelButtonText: store.locales === 'en' ? 'Cancel' : '取消' },
    )
  } catch { return }
  folderBusy.value = true
  try {
    const presetsBefore = (store.agentPresets as any[])
      .filter((p) => !isBuiltinAgentPreset(p))
      .map((p) => JSON.parse(JSON.stringify(p)))
    const summary = await resetAgentPresetFolderToDefault(presetsBefore)
    if (!summary) {
      ElMessage.warning(store.locales === 'en' ? 'No default preset folder on this platform' : '当前平台没有默认预设目录')
      return
    }
    lastScan.value = summary
    await refreshFolderInfo()
    store.ensureBuiltinAgentPresets()
    if (!summary.ok) {
      ElMessage.error(store.locales === 'en'
        ? `Restore failed: ${summary.error || 'unknown error'}`
        : `恢复默认目录失败：${summary.error || '未知错误'}`)
      return
    }
    ElMessage.success(store.locales === 'en'
      ? `Default folder in use: ${summary.loaded} preset(s)`
      : `已恢复默认预设目录：${summary.loaded} 个预设`)
  } finally {
    folderBusy.value = false
  }
}

/**
 * 从某个 .agent 文件导入一份预设（「安装」与旧的「导入」共用）。
 * 校验 id → 剥掉内置标记 → 同名文件冲突检查 → 补齐旧字段 → 写进 store 与预设文件夹。
 * @returns 导入后的预设 id
 * @throws 带可读中文原因（调用方负责提示）
 */
const importAgentFromPath = async (path: string): Promise<string> => {
  const text = await getPlatform().fs.readText(path)
  const data = JSON.parse(text)
  if (!data || !data.id || typeof data.id !== 'string') {
    throw new Error(store.locales === 'en' ? 'invalid .agent file (missing id)' : '无效的 .agent 文件（缺少 id）')
  }
  if ((store.agentPresets as any[]).some(c => c.id === data.id)) {
    throw new Error(store.locales === 'en' ? 'this preset already exists' : '该预设已存在')
  }
  // 导入的是普通预设：剥掉内置标记（内置预设由软件自己按 id 注入）
  delete data.builtin
  // 同名冲突：避免写入时覆盖已有预设的文件（文件名 = 名称清洗后）
  const dir = store.agentPresetPath
  if (dir) {
    const target = agentFilePath(data, dir)
    const conflict = (store.agentPresets as any[]).find(c => c.id !== data.id && agentFilePath(c, dir) === target)
    if (conflict) {
      throw new Error(store.locales === 'en'
        ? `name conflicts with "${conflict.name}" — rename it first`
        : `与预设「${conflict.name}」同名，请先重命名再安装`)
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
  showNavScreen.value = false   // 细长窗口：安装后直接进编辑屏
  store.saveConfig()
  await writeAgentPreset(data)
  return String(data.id)
}

/**
 * 安装智能体：多选 `.agent` 文件 → 逐个导入到预设文件夹
 * （与「插件 → 管理 → 安装」同一套心智；也支持直接把文件放进文件夹后「重新扫描」）。
 */
const installAgentFiles = async () => {
  if (!store.agentPresetPath) await ensureDefaultAgentPresetFolder()
  if (!store.agentPresetPath) {
    await openFolderPanel()
    ElMessage.warning(store.locales === 'en' ? 'Choose a preset folder first' : '请先选择预设文件夹')
    return
  }
  const paths = await getPlatform().dialog.pickFiles({
    filters: [
      { name: 'Agent Preset', extensions: ['agent'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  })
  if (!paths?.length) return
  let ok = 0
  const failures: string[] = []
  for (const p of paths) {
    try {
      await importAgentFromPath(p)
      ok++
    } catch (e: any) {
      failures.push(`${folderNameOf(p)}：${e?.message || e}`)
    }
  }
  store.ensureBuiltinAgentPresets()
  if (ok > 0) {
    ElMessage.success(store.locales === 'en'
      ? `Installed ${ok} preset(s)${failures.length ? `, skipped ${failures.length}` : ''}`
      : `已安装 ${ok} 个预设${failures.length ? `，跳过 ${failures.length} 个` : ''}`)
  }
  if (failures.length) {
    ElMessage.warning((store.locales === 'en' ? 'Skipped: ' : '跳过：') + failures.slice(0, 3).join('；'))
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
  // 跟随默认时按全局当前来源拉取候选模型（预设自身没有来源可拉）
  const t = type || (sourceFollowsDefault.value ? store.AIconfig.llm.type : selected.value?.llmType) || store.AIconfig.llm.type
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
/**
 * 修改来源：清空已选模型并自动拉取该来源的候选模型（否则下拉为空）。
 * 切到「跟随默认」时模型一并清空（跟随档不持有模型，由全局配置兜底）。
 */
const onLlmTypeChange = () => {
  if (selected.value) selected.value.model = ''
  refreshAgentModels()
}
// 切换预设/来源后，候选列表为空时自动拉一次（已拉取过的不重复请求）
watch(() => [selected.value?.id, selected.value?.llmType, store.AIconfig.llm.type], () => {
  if (selected.value && getModelsForAgent(selected.value).length === 0) refreshAgentModels()
})

// 编辑自动保存：localStorage 备份 + 防抖写入 .agent 文件（.agent 文件模式）
let presetSaveTimer: ReturnType<typeof setTimeout> | null = null
/** 立即把当前内存里的自建预设写回文件夹（内置预设不落盘） */
const flushPresetFiles = () => {
  if (!store.agentPresetPath) return
  for (const c of store.agentPresets as any[]) {
    // 内置预设不落盘：由软件按 id 幂等提供，避免在用户预设文件夹里多出非自建文件
    if (isBuiltinAgentPreset(c)) continue
    // 写入失败不阻塞编辑；下次编辑会再试
    void writeAgentPreset(c)
  }
}
watch(() => store.agentPresets, () => {
  store.saveConfig()
  if (!store.agentPresetPath) return
  if (presetSaveTimer) clearTimeout(presetSaveTimer)
  // 200ms 防抖：编辑停下就写盘，同时避免每个按键都触发一次文件写入
  presetSaveTimer = setTimeout(() => {
    presetSaveTimer = null
    flushPresetFiles()
  }, 200)
}, { deep: true })
// 关闭设置页 / 应用前把未落盘的编辑刷掉，保证把 .agent 文件直接发给别人时是最新内容
const flushPresetFilesOnHide = () => {
  if (presetSaveTimer) {
    clearTimeout(presetSaveTimer)
    presetSaveTimer = null
  }
  flushPresetFiles()
}
onBeforeUnmount(() => {
  flushPresetFilesOnHide()
  window.removeEventListener('beforeunload', flushPresetFilesOnHide)
})
window.addEventListener('beforeunload', flushPresetFilesOnHide)

onMounted(async () => {
  // 默认存储位置：预设默认存到 userData/agent-presets（老用户会从 localStorage 迁过去）。
  // 必须在首次扫描之前完成，否则会先按"无文件夹"渲染一屏再跳成文件夹模式。
  await ensureDefaultAgentPresetFolder()
  // .agent 文件模式：先扫描预设文件夹（有 agentPresetPath 时以文件为准）；
  // 扫描结果留在面板里（载入 / 跳过了几个），并把目录现状显示到侧栏 chip
  lastScan.value = await scanAgentPresets()
  await refreshFolderInfo()
  // 出厂内置预设（代码智能体 / 办公智能体）幂等兜底：旧存档 / 文件夹模式下缺失也能补上
  store.ensureBuiltinAgentPresets()
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
  /* 与「插件 → 管理」左栏一致：230px（安装按钮 + 四个图标按钮能排在一行） */
  width: 230px; flex-shrink: 0; display: flex; flex-direction: column;
  border-right: 1px solid var(--borderColor); background: var(--menuColor);
  /* 底栏按左栏可用宽度自适应（窄栏时路径收成图标） */
  container-type: inline-size;
  container-name: manage-foot;
}
.contact-sidebar-list { flex: 1; overflow-y: auto; padding: 0 4px 4px; background-color: var(--backgroundColor); }
/* ====== 顶部工具栏（与「插件 → 管理」一致：只有按钮行，横线在按钮下方） ====== */
.contact-toolbar {
  display: flex; flex-shrink: 0;
  padding: 5px; border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.contact-actions-row {
  /* 与「插件 → 管理」工具栏同一行：安装占满剩余宽度，其余四个图标按钮固定 26px */
  display: flex; gap: 4px; width: 100%; flex-wrap: nowrap;
}
.contact-toolbar .toolbar-action-btn {
  flex-shrink: 0; width: 26px; height: 26px; min-width: 26px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); color: var(--fontColor);
  cursor: pointer; font-size: 12px; transition: all .12s;
}
.contact-toolbar .toolbar-action-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
/* 搜索行：独立一块（与「插件 → 管理」「技能 → 管理」同一个盒子样式），不再挤在工具栏里 */
.ap-nav-search {
  display: flex; align-items: center; gap: 6px;
  margin: 5px; padding: 0 8px; height: 26px; flex-shrink: 0;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background: var(--backgroundColor); color: var(--borderColor);
}
.ap-nav-search:focus-within { border-color: var(--fontActiveColor); }
.ap-nav-search > i.fa-search { font-size: 11px; opacity: .6; flex-shrink: 0; }
.ap-nav-search input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--fontColor); font-size: 12px; margin: 0;
}
.ap-search-clear { cursor: pointer; font-size: 12px; opacity: .55; flex-shrink: 0; }
.ap-search-clear:hover { opacity: 1; color: var(--fontActiveColor); }
/* 左侧列表项：与「插件 → 管理」的 plugin-nav-item 同一套结构（两行：主行 + meta 行） */
.contact-item {
  padding: 5px 6px; margin-bottom: 2px; border-radius: 4px;
  border: 1px solid transparent; cursor: pointer; transition: all .12s;
  user-select: none; -webkit-user-select: none;
  box-sizing: border-box; min-height: 44px;
}
.contact-item:hover { background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.contact-item.active { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); border-color: var(--fontActiveColor); }
/* 主行：图标 + 名称 + 右侧锁定/删除 */
.ap-nav-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ap-nav-icon {
  width: 16px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--fontColor); opacity: .6;
}
.contact-item.active .ap-nav-icon { color: var(--fontActiveColor); opacity: 1; }
.ap-nav-name {
  flex: 1; min-width: 0; font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* meta 行：标签 / 自定义 / 工具数。始终渲染（min-height 占位），没有标签的预设行不会变矮 */
.ap-nav-meta {
  display: flex; align-items: center; gap: 4px;
  margin-top: 2px; padding-left: 22px;
  min-width: 0; min-height: 14px; font-size: 10px; overflow: hidden;
}
.ap-nav-meta-text { opacity: .45; font-size: 9px; white-space: nowrap; }
.ap-nav-tools {
  margin-left: auto; flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 9px; opacity: .6;
}
/* 左侧列表项：标签展示 */
.contact-tag-chip {
  flex-shrink: 0; max-width: 52px;
  font-size: 9px; line-height: 1;
  padding: 1px 3px; border-radius: 3px;
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
/* 系统提示词实时占用（通用面板 / 通用标签页） */
.prompt-token-badge {
  margin-left: auto;
  font-size: 10px; font-weight: normal; line-height: 1;
  padding: 2px 6px; border-radius: 3px;
  color: var(--fontColor);
  background: color-mix(in srgb, var(--fontColor) 7%, transparent);
  white-space: nowrap;
}
.system-prompt-head {
  display: flex; align-items: center; gap: 8px;
}
.system-prompt-head .prompt-token-badge { margin-left: auto; }
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
/* 内置预设的「恢复默认」：右对齐、与其它 tab 同一套观感，但常驻可见（改坏了要找得到） */
.ae-tab-reset {
  flex: 0 0 auto;
  margin-left: auto;
  border-color: var(--borderColor);
  opacity: .8;
}
.ae-tab-reset:hover {
  opacity: 1;
  color: #b45309;
  border-color: #b45309;
}
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
/* 工具页：呈现方式 + 能力模板同一行；两栏等宽占满整行，说明只放 title，不占界面高度 */
.preset-tool-config-row {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: center; gap: 18px; width: 100%;
  flex-shrink: 0; padding: 2px 0 4px; font-size: 11px;
}
.preset-tool-config-item { display: flex; align-items: center; gap: 6px; min-width: 0; }
.preset-tool-config-item .exec-config-label { min-width: 52px; font-weight: 600; }
.preset-tool-config-item .loop-mode-select { flex: 1 1 auto; width: auto; min-width: 0; }
.preset-tool-profile-select { width: auto; flex: 1 1 auto; min-width: 0; }
/* 工具页：计数 + 全部开关放进 ToolGroupList 的同一条工具条（图标按钮，文案走 title） */
.preset-tool-count { opacity: .65; flex-shrink: 0; font-size: 10px; white-space: nowrap; }
.preset-tool-bulkbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; flex-shrink: 0;
  font-size: 11px; line-height: 1.2;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--menuColor); color: var(--fontColor); cursor: pointer;
}
.preset-tool-bulkbtn:hover {
  border-color: var(--fontActiveColor); color: var(--fontActiveColor);
}
/* 工具分组外壳（ToolGroupList）：占满剩余高度，列宽比工具管理页更紧凑 */
.preset-tool-groups { flex: 1 1 auto; min-height: 0; --tgl-min: 180px; }
/* 技能分组外壳：与工具分组同一套外壳与高度策略；卡片样式由 SkillCard.vue 统一提供，
   所以这里的技能卡片和「设置 → 技能 → 管理」里的完全一致 */
.preset-skill-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.preset-skill-groups { flex: 1 1 auto; min-height: 0; width: 100%; --tgl-min: 180px; }
/* 技能配置框交给分组外壳滚动，自己不再出滚动条（避免两层滚动） */
.preset-skill-box { overflow: hidden; }
/* 工具卡片（仅工具页用；技能 / MCP / 知识库仍复用基础 .preset-tool-item 的横向布局）：
   上半是图标 / 名称、来源、工具名 / 开关，说明独占底部一行 —— 比原先挤在窄列里省高度 */
.preset-tool-card { flex-direction: column; align-items: stretch; gap: 2px; }
/* 自动门控中的工具：仍可手动开关，只做弱化提示，避免被误以为已关闭 */
.preset-tool-card.gated { border-style: dashed; opacity: .82; }
.preset-tool-gate {
  display: inline-flex; align-items: center; gap: 2px;
  font-size: 9px; line-height: 1.4; padding: 0 4px; border-radius: 3px;
  color: #c47f00; border: 1px solid color-mix(in srgb, #c47f00 45%, transparent);
  background: color-mix(in srgb, #c47f00 9%, transparent);
  flex-shrink: 0;
}
.preset-tool-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
.preset-tool-meta { display: flex; align-items: center; gap: 4px; min-width: 0; }
.preset-tool-card .preset-tool-src { align-self: center; }
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
/* 来源标识：内置（fa-cube）/ 来自某个插件（fa-puzzle-piece）——用户要求工具名旁能看出处 */
.preset-tool-src {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 9px; line-height: 1.5; padding: 0 4px; border-radius: 3px;
  align-self: flex-start; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.preset-tool-src.builtin { color: var(--fontColor); opacity: 0.45; border: 1px solid var(--borderColor); }
.preset-tool-src.plugin { color: var(--fontActiveColor); border: 1px solid var(--fontActiveColor); }
.preset-tool-src.plugin i { font-size: 9px; }
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
/* 工具卡片的说明：整卡宽度、单行省略（悬停 title 看全文） */
.preset-tool-card .preset-tool-desc {
  display: block; margin-top: auto; font-size: 9px; line-height: 1.35; opacity: 0.7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
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
/* 「跟随默认」提示（来源 / 模型两行下方的一行说明） */
.preset-follow-hint {
  font-size: 10px; opacity: 0.6; display: inline-flex; align-items: center; gap: 4px;
  line-height: 1.5; margin-left: 2px;
}
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

/* ====== 细长窗口（高宽比 > 16:9，如手机竖屏）：预设列表 / 编辑区各占满整屏互相切换 ======
   不再并排（并排会把编辑区挤到只剩一两百像素）。两屏都用 v-show 隐藏，切回来时表单状态还在。 */
.agent-preset.tall .contact-sidebar {
  width: 100%;
  border-right: 0;
}
/* 预设条目按钢琴键式整宽条目呈现：行高够手指点 */
.agent-preset.tall .contact-sidebar-list {
  padding: 8px;
}
.agent-preset.tall .contact-item {
  min-height: 56px;
  padding: 8px 12px;
  margin-bottom: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background-color: var(--menuColor);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.agent-preset.tall .contact-item.active {
  background-color: var(--menuActiveColor);
}
.agent-preset.tall .ap-nav-name {
  font-size: 14px;
}
.agent-preset.tall .contact-content {
  width: 100%;
}
/* 编辑屏顶部的返回条（只在细长窗口出现） */
.ap-back-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}
.ap-back {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  cursor: pointer;
  color: var(--fontColor);
  font-size: 14px;
  transition: all 0.15s ease;
}
.ap-back:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.ap-back-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fontActiveColor);
}
/* tab 栏：细长窗口整屏后宽度仍偏窄（< 420px）会按容器查询只留图标，这里保留文字并允许横向滑动 */
.agent-preset.tall .ae-tabs {
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.agent-preset.tall .ae-tabs::-webkit-scrollbar { display: none; }
.agent-preset.tall .ae-tab {
  flex: 0 0 auto;
  padding: 4px 8px;
  font-size: 11px;
}
.agent-preset.tall .ae-tab-reset { margin-left: 0; }
.agent-preset.tall .ae-tab-text { display: inline; }

/* ====== 智能体导航（参照「插件 → 管理」）：工具栏主按钮 + 底栏 ====== */
/* 左栏 230px：安装按钮占满剩余宽度，四个图标按钮固定宽度，全部排在同一行 */
.contact-actions-row .toolbar-action-btn.primary {
  /* 安装按钮占满剩余宽度（图标 + 文字），其余四个固定 26px */
  flex: 1 1 auto; width: auto; min-width: 0; gap: 5px; padding: 0 6px;
  border-color: color-mix(in srgb, var(--fontActiveColor) 45%, var(--borderColor));
  color: var(--fontActiveColor);
}
.contact-actions-row .toolbar-action-btn.primary:hover { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); }
.ap-toolbar-label { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 底栏（与技能 / 插件管理同一套）：一行显示 数量 + 存储位置 + 图标；窄栏时路径只留图标 */
.sk-nav-foot {
  flex-shrink: 0; display: flex; flex-direction: row; align-items: center; gap: 6px;
  padding: 5px 7px; border-top: 1px solid var(--borderColor);
  background: var(--menuColor); font-size: 10px; min-width: 0;
}
.sk-foot-count { flex-shrink: 0; white-space: nowrap; opacity: .8; }
.sk-foot-icons { flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
.sk-foot-icon { font-size: 10px; }
.sk-foot-icon.action { cursor: pointer; }
.sk-foot-icon.action:hover { color: var(--fontActiveColor); opacity: 1; }
.sk-foot-path {
  flex: 1 1 auto; min-width: 18px; display: flex; align-items: center; gap: 5px;
  font-size: 10px; opacity: .65; cursor: pointer;
}
.sk-foot-path:hover { opacity: 1; }
.sk-foot-path i { flex-shrink: 0; }
.sk-foot-path-text {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  direction: rtl; text-align: left;
}
@container manage-foot (max-width: 300px) {
  .sk-nav-foot { gap: 4px; }
  .sk-foot-path-text { display: none; }
  .sk-foot-path { min-width: 14px; flex: 0 0 auto; }
}

/* ====== 存储位置 chip（侧栏顶部，一行高） ====== */
.apf-chip {  display: flex; align-items: center; gap: 5px;
  margin: 4px 6px 0; padding: 3px 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  font-size: 10px; color: var(--fontColor); opacity: .8;
  cursor: pointer; min-width: 0;
}
.apf-chip:hover { opacity: 1; background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.apf-chip i { font-size: 10px; color: var(--fontActiveColor); flex-shrink: 0; }
.apf-chip.folder { opacity: 1; border-color: color-mix(in srgb, var(--fontActiveColor) 35%, var(--borderColor)); }
.apf-chip-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apf-chip-count {
  flex-shrink: 0; font-size: 9px; padding: 0 4px; border-radius: 6px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
}

/* ====== 预设存储位置面板（teleport 到 body；层级与右键菜单一致） ====== */
.apf-overlay {
  position: fixed; inset: 0; z-index: 1600;
  background: rgba(0, 0, 0, .35);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.apf-panel {
  width: min(560px, 100%); max-height: 86vh; overflow: auto;
  background: var(--menuColor); color: var(--fontColor);
  border: 1px solid var(--borderColor); border-radius: 6px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, .35);
  font-size: 12px;
}
.apf-head {
  display: flex; align-items: center; gap: 7px;
  padding: 9px 11px; border-bottom: 1px solid var(--borderColor);
}
.apf-head i { color: var(--fontActiveColor); }
.apf-title { font-size: 13px; font-weight: 600; color: var(--fontActiveColor); flex: 1; }
.apf-close {
  width: 22px; height: 22px; border: none; background: transparent;
  color: var(--fontColor); cursor: pointer; border-radius: 3px;
}
.apf-close:hover { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); }
.apf-body { padding: 10px 11px; display: flex; flex-direction: column; gap: 9px; }
.apf-mode { display: flex; align-items: center; gap: 7px; min-width: 0; }
.apf-badge {
  flex-shrink: 0; padding: 1px 6px; border-radius: 8px; font-size: 10px;
  border: 1px solid var(--borderColor); opacity: .85;
}
.apf-badge.folder { border-color: color-mix(in srgb, var(--fontActiveColor) 45%, var(--borderColor)); color: var(--fontActiveColor); }
.apf-path {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--monoFont, Consolas, monospace); font-size: 11px;
  direction: rtl; text-align: left;
}
.apf-path.dim { opacity: .6; font-family: inherit; direction: ltr; }
/* 「默认位置」徽标：目录仍是 userData/agent-presets（没被改成自定义目录） */
.apf-default-badge {
  flex-shrink: 0; font-style: normal; font-size: 9px;
  padding: 0 4px; border-radius: 6px; border: 1px solid var(--borderColor);
  opacity: .75;
}
.apf-hint { font-size: 11px; line-height: 1.55; opacity: .8; }
.apf-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.apf-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 9px; font-size: 11px; cursor: pointer;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: transparent; color: var(--fontColor);
}
.apf-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); }
.apf-btn:disabled { opacity: .4; cursor: not-allowed; }
.apf-btn.primary { border-color: color-mix(in srgb, var(--fontActiveColor) 45%, var(--borderColor)); color: var(--fontActiveColor); }
.apf-btn.danger:hover:not(:disabled) { color: #f56c6c; border-color: #f56c6c; }
.apf-status {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  font-size: 10px; opacity: .75; border-top: 1px dashed var(--borderColor); padding-top: 7px;
}
.apf-status i { font-size: 10px; }
.apf-status-note { opacity: .8; }
.apf-warn { color: #f56c6c; }
.apf-scan { font-size: 11px; display: flex; align-items: flex-start; gap: 5px; line-height: 1.5; }
.apf-scan .ok { color: #67c23a; }
.apf-scan .err { color: #f56c6c; }
</style>
