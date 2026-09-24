<template>
  <div class="ai-chat-container">
    <!-- 聊天列表侧边栏（收起时用宽度动画滑出，不再 v-show 直接消失） -->
    <div class="chat-sidebar" :class="{ collapsed: !showSidebar }">
      <!-- 顶部工具栏：搜索 + 新建聊天 -->
      <div class="chat-toolbar">
        <!-- 搜索框（展开状态） -->
        <div v-if="searchActive" class="chat-search-box">
          <i class="fa fa-search"></i>
          <input
            v-model="searchQuery"
            class="chat-search-input"
            :placeholder="store.locales == 'zh' ? '搜索聊天内容...' : 'Search chats...'"
            @keydown.esc="closeSearch"
          />
          <div v-if="searchQuery" class="chat-search-clear" @click="searchQuery = ''" :title="store.locales == 'zh' ? '清除' : 'Clear'">
            <i class="fa fa-times-circle"></i>
          </div>
        </div>
        <!-- 搜索按钮（收起状态） -->
        <div v-else class="chat-search-toggle" @click="openSearch" :title="store.locales == 'zh' ? '搜索聊天' : 'Search chats'">
          <i class="fa fa-search"></i>
        </div>
        <!-- 新建聊天按钮 -->
        <div class="chat-new-btn" @click="onToolbarNewChat" :title="store.locales == 'zh' ? '新建聊天' : 'New chat'">
          <i class="fa fa-plus"></i>
        </div>
      </div>
      <!-- 普通聊天列表（vuedraggable 支持整行拖拽调整顺序） -->
      <draggable
        v-model="rootChats"
        item-key="chat.id"
        class="chat-list scoll"
        :animation="150"
        ghost-class="chat-item-ghost"
      >
        <template #item="{ element }">
          <div 
            class="chat-item"
            v-show="isChatMatched(element.chat)"
            :class="{ 
              active: activeRootIndex === element.originalIndex,
              generating: isChatRunning(element.chat),
              'has-background-execution': globalExecutionState.isExecuting && globalExecutionState.chatId === element.chat.id && currentChatIndex !== element.originalIndex,
              'chat-retrieval': element.chat.mode === 'retrieval',
              'chat-workflow': element.chat.mode === 'workflow',
              'chat-agent': element.chat.mode === 'agent',
              'chat-agent2': element.chat.mode === 'agent2',
              'chat-swarm': element.chat.mode === 'swarm',
              'chat-code': element.chat.mode === 'code'
            }"
            @click="switchChat(element.originalIndex)"
            @contextmenu.prevent="onSidebarContextMenu($event, element.originalIndex)"
          >
            <div class="chat-item-body">
              <div class="chat-item-header">
                <span class="chat-title">
                  <div v-if="element.chat.mode === 'normal'" class="mode-icon" title="普通模式">
                    <i class="fa fa-user-o"></i>
                  </div>
                  <div v-if="element.chat.mode === 'retrieval'" class="mode-icon" title="知识库模式">
                    <i class="fa fa-book"></i>
                  </div>
                  <div v-else-if="element.chat.mode === 'workflow'" class="mode-icon" title="工作流模式">
                    <i class="fa fa-stumbleupon"></i>
                  </div>
                  <div v-else-if="element.chat.mode === 'agent'" class="mode-icon" title="智能体（Agent 预设）">
                    <i class="fa fa-user-circle"></i>
                  </div>
                  <div v-else-if="element.chat.mode === 'agent2'" class="mode-icon" title="智能体（通用）">
                    <i class="fa fa-android"></i>
                  </div>
                  <div v-else-if="element.chat.mode === 'swarm'" class="mode-icon" title="集群（多智能体协作）">
                    <i class="fa fa-users"></i>
                  </div>
                  <div v-else-if="element.chat.mode === 'code'" class="mode-icon" :title="store.locales=='zh' ? 'PTC（程序化工具调用）' : 'PTC (programmatic tool call)'">
                    <i class="fa fa-code"></i>
                  </div>
                  {{ element.chat.title || `聊天 ${element.originalIndex + 1}` }}
                </span>
                <span class="chat-time">{{ getChatTimeText(element.chat) }}</span>
                <div class="chat-item-right">
                  <!-- 删除按钮 -->
                  <div class="chat-actions" @click.stop="deleteChat(element.originalIndex)" title="删除聊天">
                    <i class="fa fa-trash"></i>
                  </div>
                  <!-- 当前聊天的运行指示器（生成中 / 集群运行中 / 后台执行） -->
                  <div v-if="isChatRunning(element.chat) || shouldShowBackgroundExecution(element.chat, element.originalIndex)" 
                   class="execution-indicator" 
                   :title="chatRunningTitle(element.chat)">
                    <i class="fa fa-spinner fa-spin"></i>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </draggable>

    </div>
    
    <!-- 主聊天区域 -->
    <div class="chat-main" :class="{ 'sidebar-hidden': !showSidebar, 'empty-chat': isEmptyChat }"
      :style="{ '--composer-shift': composerShift + 'px' }">
      <!-- 聊天头部 -->
      <div class="chat-header" ref="chatHeaderRef" @wheel="handleHeaderWheel">
        <!-- 聊天列表开关（fa-bars）：纯图标（不用按钮盒子样式），初始不显示聊天列表，点这里展开 / 收起 -->
        <div class="sidebar-toggle-btn" @click="toggleSidebar"
          :title="showSidebar
            ? (store.locales=='zh' ? '隐藏聊天列表' : 'Hide chat list')
            : (store.locales=='zh' ? '显示聊天列表' : 'Show chat list')">
          <i class="fa fa-bars"></i>
        </div>
        <!-- 聊天标题（有历史消息时才显示；空白聊天时头部只留开关/模型等） -->
        <input 
          v-if="!isEmptyChat"
          v-model="currentChat.title" 
          :placeholder="store.locales=='zh' ? '输入聊天标题...' : 'Enter Chat Title...'"
          class="chat-title-input"
          @change="saveChats"
        />
        <!-- 上下文占用圆环（参考 DeepSeek Harness） -->
        <div v-if="contextUsageVisible" class="context-usage" :title="contextUsageTooltip">
          <svg class="context-ring" viewBox="0 0 36 36">
            <circle class="context-ring-bg" cx="18" cy="18" r="15.5"></circle>
            <circle class="context-ring-val" cx="18" cy="18" r="15.5"
              :style="{ stroke: contextRingColor, strokeDasharray: contextRingLen + ' ' + contextRingCirc }"
              transform="rotate(-90 18 18)"></circle>
          </svg>
        </div>
        <!-- 集群模式：执行时用各成员预设里的模型，右上角模型选择不参与 → 隐藏 -->
        <select 
          v-if="currentChat.mode !== 'swarm'"
          v-model="llmTypeSelectModel"
          class="model-select"
          title="模型类型"
          :disabled="isAnyExecuting"
        >
          <template v-for="type in enabledLlmTypeOptions.types" :key="type">
            <template v-if="type === 'custom'">
              <!-- 每个启用的自定义来源一个独立选项（value 编码为 custom:<来源索引>） -->
              <option v-for="item in enabledLlmTypeOptions.customEnabled" :key="'custom-' + (item.src.id || item.i)" :value="'custom:' + item.i">
                {{ getCustomSourceLabel(item.src) }}
              </option>
            </template>
            <option v-else :value="type">
              {{ getLlmTypeDisplayName(type) }}
            </option>
          </template>
        </select>
        <select 
          v-if="currentChat.mode !== 'swarm'"
          v-model="currentChat.config.model" 
          @click="refreshModels"
          class="model-select"
          :disabled="!availableModels.length || isAnyExecuting"
          title="选择模型"
        >
          <option value="">select model</option>
          <option v-for="model in availableModels" :value="model">
            {{ model }}
          </option>
        </select>
        <div v-if="hasBranches" class="button branch-btn" @click="toggleBranchView" :class="{ active: showBranchView }" :title="store.locales=='zh' ? '分支对话视图' : 'Branch View'">
          <i class="fa fa-sitemap"></i>
        </div>
        <div v-if="currentChat.mode === 'retrieval' && currentChat.config.kbPath" class="parameter" :title="store.locales=='zh' ? '知识库片段数量' : 'Knowledge Base Fragment Count'">
          <label>{{ currentChat.config.kbTopK || 5 }}</label>
          <input 
            type="range" 
            v-model.number="currentChat.config.kbTopK" 
            min="3" 
            max="20" 
            step="1"
            class="param-slider"
            :disabled="isAnyExecuting"
          >
        </div>
      </div>
      
      <!-- 消息区域 -->
      <div 
        class="message-container scoll" 
        id="messageContainer" 
        ref="messageContainer"
        @wheel="handleWheel"
        @scroll="handleScroll"
        @contextmenu.prevent="onMessageContextMenu"
      >
        <!-- 合并的消息显示（集群模式的成员汇报同为 chat.messages 消息，共用同一渲染） -->
        <div 
          v-for="(message, index) in currentChat.messages" 
          :key="index" 
          class="message-item"
          :class="{
            'user-message': message.role === 'user',
            'assistant-message': message.role === 'assistant',
            'system-message': message.role === 'system'
          }"
        >
          <div class="message-header">
            <span class="message-role">
              <!-- 集群成员消息：直接显示成员名（不加 🤖 前缀，也不再用工作流的 [名称] 后缀） -->
              <template v-if="message.swarmAgent">{{ message.swarmAgent.idx >= 0 ? message.swarmAgent.name : (store.locales=='zh' ? '群主' : 'Host') }}</template>
              <template v-else>{{ getRoleDisplay(message.role) }}</template>
            <span v-if="message.executionName && !message.swarmAgent" class="message-node-name">[{{ message.executionName }}]</span>
              <!-- 运行中引导：本条用户消息是作为「引导」投递给正在执行的智能体的 -->
              <span
                v-if="message.steer"
                class="message-steer-tag"
                :title="store.locales=='zh' ? '运行中引导：不打断本轮执行，智能体在下一个 step 带上该要求' : 'Live guidance: sent while the agent was running, applied at its next step'"
              >
                <i class="fa fa-bullhorn"></i>
                {{ store.locales=='zh' ? '引导' : 'Guidance' }}
              </span>
              <span v-if="message.isExecuting" class="execution-dot" title="执行中...">
                <i class="fa fa-circle-o-notch fa-spin"></i>
              </span>
            </span>
            
            <!-- 右侧信息：时间 + Token统计 -->
            <span class="message-right-info">
              <!-- Token 统计 - 仅对 assistant 消息显示 -->
              <span v-if="message.role === 'assistant' && message.tokenStats" class="token-stats" :title="getTokenTooltip(message)">
                <span class="token-count">
                  <i class="fa fa-file-text-o"></i>
                  {{ message.tokenStats.completionTokens || 0 }}
                </span>
                <span v-if="message.tokenStats.speed" class="token-speed">
                  <i class="fa fa-tachometer"></i>
                  {{ message.tokenStats.speed.toFixed(1) }} tok/s
                </span>
              </span>
              
              <!-- 执行耗时 - 对 execution 消息显示 -->
              <span v-if="message.executionTime && message.executionTime > 0" class="execution-time" :title="store.locales=='zh' ? '执行耗时' : 'Execution Time'">
                <i class="fa fa-clock-o"></i>
                {{ (message.executionTime / 1000).toFixed(2) }}s
              </span>
              
              <!-- 时间 -->
              <span class="message-time">
                {{ formatTime(message.timestamp) }}
              </span>
            </span>
            
            <div class="action-button" @click.stop="deleteMessage(index)" title="删除">
              <i class="fa fa-times"></i>
            </div>
          </div>
          
          <!-- 图片预览区域 -->
          <div v-if="message.images && message.images.length > 0" class="image-preview-container">
            <div 
              v-for="(imageData, imgIndex) in message.images" 
              :key="imgIndex" 
              class="image-preview-item"
            >
              <img 
                :src="getImageSrc(imageData)" 
                alt="用户上传的图片"
                class="message-image"
                @click="openImagePreview(imageData)"
              />
              <div class="image-actions">
                <div class="image-action-button" @click.stop="removeImageFromMessage(index, imgIndex)" title="删除图片">
                  <i class="fa fa-times"></i>
                </div>
              </div>
            </div>
          </div>
          
          <!-- 知识库来源（仅助理消息显示） -->
          <div v-if="message.role === 'assistant' && message.kbInfo?.relevantBlocks?.length && !message.isExecuting" class="kb-sources">
            <div class="kb-sources-header">
              <i class="fa fa-book"></i>
              <span>{{ store.locales=='zh' ? '参考了' : 'Sources' }} {{ message.kbInfo.relevantBlocks.length }} {{ store.locales=='zh' ? '个知识片段' : 'knowledge chunks' }}</span>
            </div>
            <div
              v-for="(block, bi) in message.kbInfo.relevantBlocks"
              :key="bi"
              class="kb-block-item"
              @click="toggleKbBlock(bi)"
            >
              <div class="kb-block-header">
                <span class="kb-block-label">{{ block.label || ('#' + (bi+1)) }}</span>
                <span class="kb-block-score">{{ (block.similarity * 100).toFixed(0) }}%</span>
                <i class="fa fa-chevron-down" :class="{ expanded: expandedKbBlock === bi }"></i>
              </div>
              <div v-if="expandedKbBlock === bi" class="kb-block-content scoll">{{ block.content }}</div>
            </div>
          </div>
          <!-- 联网搜索状态与来源（普通聊天显示；智能体模式的结果已内联到「服务端搜索」tool-box 卡片中，
               避免同一结果重复展示） -->
          <div v-if="message.role === 'assistant' && message.webSearch && message.executionType !== 'skill'" class="web-search-info">
            <div v-if="message.webSearch.status === 'searching'" class="web-search-status">
              <i class="fa fa-globe fa-spin"></i>
              <span>{{ store.locales=='zh' ? '正在联网搜索...' : 'Searching the web...' }}</span>
              <span v-if="message.webSearch.query" class="web-search-query">“{{ message.webSearch.query }}”</span>
            </div>
            <div v-if="message.webSearch.results && message.webSearch.results.length > 0" class="web-search-sources">
              <div class="web-search-header">
                <i class="fa fa-globe"></i>
                <span>{{ store.locales=='zh' ? '联网搜索到' : 'Web search found' }} {{ message.webSearch.results.length }} {{ store.locales=='zh' ? '条结果' : 'results' }}</span>
              </div>
              <div v-for="(r, ri) in message.webSearch.results" :key="ri" class="web-search-item">
                <a v-if="r.url" :href="r.url" target="_blank" rel="noopener noreferrer" class="web-search-link" :title="r.url">{{ getWebSearchTitle(r, ri) }}</a>
                <span v-else class="web-search-link" :title="r.title || ('#' + (ri+1))">{{ r.title || ('#' + (ri+1)) }}</span>
                <div v-if="r.url" class="web-search-open" @click="openWebResult(r)" :title="store.locales=='zh' ? '打开网页' : 'Open webpage'">
                  <i class="fa fa-external-link"></i>
                </div>
              </div>
            </div>
          </div>
          <!-- 智能体/工作流模式：工具调用列表（tool-box 风格：标题 + 参数 + 结果，按时间线排列在内容之前） -->
          <div v-if="message.executionUnits && message.executionUnits.length" class="execution-unit-list">
            <template
              v-for="(unit, ui) in sortedExecutionUnits(message.executionUnits)"
              :key="unit.id || ui"
            >
            <!-- content 单元（思考/正文）：与最终输出同款 message-content 样式，按时间顺序穿插 -->
            <div
              v-if="unit.stepType === 'content'"
              class="message-content"
              v-html="renderMarkdown(unitResultText(unit))"
            ></div>
            <!-- 运行中引导单元：用户在执行期间补充的要求（直接插在它生效的位置，后续步骤排在其下） -->
            <div
              v-else-if="unit.stepType === 'guidance'"
              class="guidance-unit"
            >
              <div class="guidance-unit-head">
                <i class="fa fa-bullhorn"></i>
                <span>{{ store.locales=='zh' ? '用户引导' : 'User guidance' }}</span>
                <span class="guidance-unit-time">{{ formatTime(unit.startTime) }}</span>
              </div>
              <div class="guidance-unit-body">{{ unitResultText(unit) }}</div>
            </div>
            <div
              v-else-if="!isToolUnitClosed(message.timestamp, unit.id || ui)"
              class="tool-box"
              :class="{ 'tool-box-collapsed': !isToolUnitExpanded(message.timestamp, unit.id || ui) }"
            >
              <div class="tool-box-header">
                <i class="fa" :class="unitToolIcon(unit)"></i>
                <span class="tool-box-name" :title="unitLabel(unit)">{{ unitLabel(unit) }}</span>
                <span class="tool-box-status" :class="unit.status">
                  <i v-if="unit.status === 'running'" class="fa fa-circle-o-notch fa-spin"></i>
                  <i v-else-if="unit.status === 'success'" class="fa fa-check-circle"></i>
                  <i v-else-if="unit.status === 'error'" class="fa fa-times-circle"></i>
                  <i v-else class="fa fa-clock-o"></i>
                </span>
                <!-- 网页文件的「打开」按钮：工具写入的是本地 .html/.htm 时，用内置浏览器打开 -->
                <span
                  v-if="openableWebPagePath(unit)"
                  class="tool-box-open"
                  :title="store.locales=='zh' ? '用内置浏览器打开' : 'Open in built-in browser'"
                  @click.stop="openWebPageInBrowser(unit)"
                >
                  <i class="fa fa-external-link"></i>
                </span>
                <!-- 展开/折叠开关：默认折叠只显示单行摘要，点击展开后显示完整输入/输出详情 -->
                <span
                  class="tool-box-toggle"
                  :class="{ expanded: isToolUnitExpanded(message.timestamp, unit.id || ui) }"
                  :title="isToolUnitExpanded(message.timestamp, unit.id || ui)
                    ? (store.locales=='zh' ? '收起' : 'Collapse')
                    : (store.locales=='zh' ? '展开详情' : 'Expand details')"
                  @click.stop="toggleToolUnitExpanded(message.timestamp, unit.id || ui)"
                >
                  <i class="fa fa-chevron-down"></i>
                </span>
                <span
                  v-if="unit.description === 'update_plan' || unit.description === 'update_todo'"
                  class="tool-box-close"
                  :title="store.locales=='zh' ? '关闭' : 'Close'"
                  @click="closeToolUnit(message.timestamp, unit.id || ui)"
                >
                  <i class="fa fa-times"></i>
                </span>
              </div>
              <!-- 折叠态：单行摘要（不换行、无多余空格，超出省略；点击摘要也可展开） -->
              <div
                v-if="!isToolUnitExpanded(message.timestamp, unit.id || ui)"
                class="tool-box-preview"
                :title="getToolCollapsedText(unit) || unitLabel(unit)"
                @click="toggleToolUnitExpanded(message.timestamp, unit.id || ui)"
              >{{ getToolCollapsedText(unit) || '…' }}</div>
              <!-- 展开态：完整输入（参数/代码）与输出（结果/思考/计划）详情 -->
              <template v-else>
                <div v-if="shouldShowUnitArgs(unit)" class="tool-code-box scoll">
                  <span v-if="unit.description === 'run_code' && getRunCodeProgram(unit)" v-html="highlightCodeHtml(getRunCodeProgram(unit), 'typescript')"></span>
                  <span v-else-if="unit.description === 'run_python' && getRunPythonCode(unit)" v-html="highlightCodeHtml(getRunPythonCode(unit), 'python')"></span>
                  <template v-else-if="unit.description === 'write_file'">
                    <div v-if="getWriteFilePath(unit)" :title="getWriteFilePath(unit)">{{ getWriteFilePath(unit) }}</div>
                    <template v-else>{{ unitArgsText(unit) }}</template>
                  </template>
                  <template v-else>{{ unitArgsText(unit) }}</template>
                </div>
                <!-- 思考块：该 step 的模型思维链（流式，markdown 渲染；thinking 中闪烁） -->
                <div v-else-if="unit.stepType === 'reasoning'" class="tool-reasoning-line scoll" :class="{ streaming: unit.status === 'running' }" v-html="renderMarkdown(unitResultText(unit))"></div>
                <!-- 计划/清单类工具：参数区省略；更新计划用 Markdown 渲染 -->
                <div v-else-if="unit.description === 'update_plan'" class="tool-plan-line scoll" v-html="renderMarkdown(unitArgsText(unit))"></div>
                <div v-else-if="unit.description === 'update_todo'" class="tool-plan-line scoll">{{ unitArgsText(unit) }}</div>
                <div v-if="shouldShowUnitResult(unit) && unit.error" class="tool-result-box tool-result-error scoll">{{ unit.error }}</div>
                <!-- 编辑类工具：行级差异预览（只展示变更块 ± 上下文，红绿着色；对齐 pi 的 edit diff） -->
                <template v-else-if="editDiffFilesOf(unit).length">
                  <div class="tool-diff-box scoll">
                    <template v-for="(f, fi) in editDiffFilesOf(unit)" :key="fi">
                      <div v-if="editDiffAllFiles(unit).length > 1" class="tool-diff-head" :title="f.path">{{ f.path }}</div>
                      <div class="tool-diff-lines">
                        <div
                          v-for="(l, li) in f.lines"
                          :key="li"
                          class="tool-diff-line"
                          :class="'td-' + l.t"
                        >
                          <span class="tool-diff-no">{{ l.o ?? '' }}</span>
                          <span class="tool-diff-no">{{ l.n ?? '' }}</span>
                          <span class="tool-diff-sign">{{ editDiffSign(l.t) }}</span>
                          <span class="tool-diff-text">{{ editDiffLineText(l) }}</span>
                        </div>
                      </div>
                      <div v-if="f.omitted" class="tool-diff-note">
                        {{ store.locales == 'zh' ? `… 另有 ${f.omitted} 行未显示` : `… ${f.omitted} more lines hidden` }}
                      </div>
                    </template>
                  </div>
                </template>
                <template v-else-if="unit.description === 'write_file'">
                  <!-- 内容（代码时高亮渲染）与 Python 的 result-box 一致 -->
                  <div v-if="getWriteFileContent(unit)" class="tool-result-box scoll" v-html="highlightCodeHtml(getWriteFileContent(unit), getWriteFileLang(unit))"></div>
                </template>
                <!-- PTC（run_code）：返回值 + console 日志 + 程序内实际调用的工具（对齐原脚手架「程序」页） -->
                <template v-else-if="unit.description === 'run_code'">
                  <div v-if="ptcOutputOf(unit)" class="tool-ptc-result">
                    <div v-if="ptcLogs(unit).length" class="tool-result-box scoll tool-ptc-logs">
                      <div v-for="(l, li) in ptcLogs(unit)" :key="li" class="tool-ptc-log" :class="l.type">
                        <span class="tool-ptc-log-tag">{{ l.type }}</span><span class="tool-ptc-log-text">{{ l.text }}</span>
                      </div>
                    </div>
                    <div class="tool-result-box scoll tool-ptc-return">{{ ptcResultText(unit) }}</div>
                    <div v-if="ptcInternalTools(unit).length" class="tool-ptc-internal">
                      <div class="tool-ptc-internal-head">
                        <i class="fa fa-sitemap"></i>
                        {{ store.locales == 'zh' ? '程序内调用的工具' : 'Tools called inside the program' }} ({{ ptcInternalTools(unit).length }})
                      </div>
                      <div v-for="(tc, ti) in ptcInternalTools(unit)" :key="ti" class="tool-ptc-internal-item" :class="tc.ok ? 'ok' : 'err'">
                        <i class="fa" :class="tc.ok ? 'fa-check-circle-o' : 'fa-times-circle-o'"></i>
                        <span class="tool-ptc-internal-name">{{ tc.name }}</span>
                        <span class="tool-ptc-internal-input" :title="tc.inputText">{{ tc.inputText }}</span>
                        <span v-if="tc.error" class="tool-ptc-internal-err">{{ tc.error }}</span>
                      </div>
                    </div>
                  </div>
                  <div v-else-if="unit.error" class="tool-result-box tool-result-error scoll">{{ unit.error }}</div>
                  <div v-else class="tool-result-box tool-ptc-running">
                    {{ store.locales == 'zh' ? '程序执行中…' : 'Running program…' }}
                  </div>
                </template>
                <div v-else-if="shouldShowUnitResult(unit) && unitResultText(unit)" class="tool-result-box scoll">{{ unitResultText(unit) }}</div>
              </template>
            </div>
            </template>
          </div>
          
          <!-- 深度思考（<think>…</think>）：折叠展示思考过程，不混入正文（Agent 时间线除外） -->
          <div
            v-if="message.role === 'assistant' && renderedReasoning(message) && !(message.executionUnits && message.executionUnits.length)"
            class="think-block"
            :class="{ 'think-collapsed': isMsgThinkCollapsed(message) }"
          >
            <div class="think-block-header" @click="toggleMsgThinkCollapsed(message)">
              <i class="fa fa-lightbulb-o"></i>
              <span>{{ store.locales == 'zh' ? '思考过程' : 'Thinking' }}</span>
              <i class="fa think-toggle" :class="isMsgThinkCollapsed(message) ? 'fa-chevron-down' : 'fa-chevron-up'"></i>
            </div>
            <div v-show="!isMsgThinkCollapsed(message)" class="think-block-body scoll" v-html="renderMarkdown(renderedReasoning(message))"></div>
          </div>
          <!-- 消息内容：生成中（含 step 间停顿，用 isExecuting 判断而非 streaming）若时间线已有
               content 单元展示正文，则隐藏消息区避免重复；完成后（finalReplyDone 已移除最后一个
               content 单元）由消息区显示最终输出。renderedContent 剥离 <think> 思考段 -->
          <div
            v-if="renderedContent(message) && !(message.isExecuting && message.executionUnits && message.executionUnits.some((u: any) => u.stepType === 'content'))"
            class="message-content"
            v-html="renderMarkdown(renderedContent(message))"
          ></div>
          
          <!-- 思考中占位（仅当完全无内容且生成中时显示；联网搜索中不显示；与 message-content 解耦，避免流式正文被隐藏时误显三点动画） -->
          <div
            v-if="!message.content && message.role === 'assistant' && index === currentChat.messages.length - 1 && currentChat.isGenerating && !(message.webSearch && message.webSearch.status === 'searching')"
            class="thinking-placeholder"
          >
            <div class="thinking-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
          
          <!-- 文件附件（仅用户消息显示） -->
          <div v-if="message.role === 'user' && message.fileAttachments && message.fileAttachments.length > 0" class="message-file-attachments">
            <div 
              v-for="(file, fi) in message.fileAttachments" 
              :key="fi" 
              class="file-attachment-chip"
              :title="`${file.name} · ${file.charCount}字`"
            >
              <i class="fa fa-file-text-o"></i>
              <span class="file-attachment-name">{{ file.name }}</span>
              <span class="file-attachment-chars">{{ file.charCount }}字</span>
            </div>
          </div>
          
        </div>
      </div>
      
      <!-- 右键菜单 -->
      <teleport to="body">
        <div v-if="contextMenuVisible" class="context-menu-overlay" @click="hideContextMenu" @contextmenu.prevent="hideContextMenu"></div>
        <div v-if="contextMenuVisible" class="context-menu" :style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }" @mouseleave="hideContextMenu">
          <!-- 消息区右键菜单 -->
          <template v-if="!isInputContextMenu">
            <div v-if="contextMenuTargetIndex !== null" class="context-menu-item" @click="copyFromMenu">
              <i class="fa fa-copy"></i> {{ store.locales=='zh' ? '复制文本' : 'Copy Text' }}
            </div>
            <div v-if="contextMenuTargetIndex !== null" class="context-menu-item" @click="ttsFromMenu">
              <i class="fa fa-volume-up"></i> {{ store.locales=='zh' ? '朗读文本' : 'Read Aloud' }}
            </div>
            <div v-if="contextMenuTargetIndex !== null" class="context-menu-item" @click="branchFromContextMenu">
              <i class="fa fa-code-fork"></i> {{ store.locales=='zh' ? '从此处分支' : 'Branch from here' }}
            </div>
            <div class="context-menu-item" @click="stopTTSFromMenu" v-if="isTTSSpeaking">
              <i class="fa fa-stop"></i> {{ store.locales=='zh' ? '停止朗读' : 'Stop Reading' }}
            </div>
            <div class="context-menu-item" @click="clearCurrentChatFromMenu">
              <i class="fa fa-trash"></i> {{ store.locales=='zh' ? '清空聊天' : 'Clear Chat' }}
            </div>
            <div class="context-menu-item has-submenu" style="position:relative;">
              <i class="fa fa-download"></i>
              <span style="flex:1">{{ contextMenuTargetIndex !== null ? (store.locales=='zh' ? '导出此消息' : 'Export This Message') : (store.locales=='zh' ? '导出全部' : 'Export All') }}</span>
              <i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
              <ul class="submenu">
                <li v-if="store.root" @click.stop="exportChatToKbFromMenu"><i class="fa fa-book"></i> {{ store.locales=='zh' ? '知识库' : 'Knowledge Base' }}</li>
                <li @click.stop="exportChatFromMenu"><i class="fa fa-file-text-o"></i> Markdown</li>
                <li @click.stop="exportChatToWord"><i class="fa fa-file-word-o"></i> Word</li>
              </ul>
            </div>
          </template>
          <!-- 输入栏右键菜单：仅粘贴 -->
          <template v-if="isInputContextMenu">
            <div class="context-menu-item" @click="pasteToInput">
              <i class="fa fa-paste"></i> {{ store.locales=='zh' ? '粘贴' : 'Paste' }}
            </div>
            <div class="context-menu-item" @click="stopTTSFromMenu" v-if="isTTSSpeaking">
              <i class="fa fa-stop"></i> {{ store.locales=='zh' ? '停止朗读' : 'Stop Reading' }}
            </div>
          </template>
        </div>
        <!-- 侧边栏右键菜单 -->
        <div v-if="sidebarContextMenuVisible" class="context-menu-overlay" @click="hideSidebarContextMenu" @contextmenu.prevent="hideSidebarContextMenu"></div>
        <div v-if="sidebarContextMenuVisible" class="context-menu" :style="{ left: sidebarContextMenuPos.x + 'px', top: sidebarContextMenuPos.y + 'px' }" @mouseleave="hideSidebarContextMenu">
          <div class="context-menu-item" @click="deleteChatFromSidebarMenu">
            <i class="fa fa-trash"></i> {{ store.locales=='zh' ? '删除聊天' : 'Delete Chat' }}
          </div>
        </div>
        <!-- 分支树右键菜单 -->
        <div v-if="branchContextMenuVisible" class="context-menu-overlay" @click="hideBranchContextMenu" @contextmenu.prevent="hideBranchContextMenu"></div>
        <div v-if="branchContextMenuVisible" ref="branchContextMenuRef" class="context-menu" :style="{ left: branchContextMenuPos.x + 'px', top: branchContextMenuPos.y + 'px' }" @mouseleave="hideBranchContextMenu">
          <template v-if="branchContextMenuNode">
            <div class="context-menu-item" @click="deleteBranchFromContextMenu">
              <i class="fa fa-trash"></i> {{ branchContextMenuNode.depth === 0
                ? (store.locales=='zh' ? '删除对话' : 'Delete Chat')
                : (store.locales=='zh' ? '删除分支' : 'Delete Branch')
              }}
            </div>
            <div class="context-menu-divider"></div>
          </template>
          <div class="context-menu-item" @click="resetBranchView">
            <i class="fa fa-undo"></i> {{ store.locales=='zh' ? '重置视图' : 'Reset View' }}
          </div>
          <div class="context-menu-item" @click="toggleBranchTitles">
            <i class="fa" :class="showBranchTitles ? 'fa-check-square-o' : 'fa-square-o'"></i>
            {{ showBranchTitles
              ? (store.locales=='zh' ? '隐藏标题' : 'Hide Titles')
              : (store.locales=='zh' ? '显示标题' : 'Show Titles')
            }}
          </div>
        </div>
      </teleport>
      
      <!-- 输入区域 -->
      <div class="input-area">
        <!-- 空聊天引导提示（仅没有任何历史消息时显示，随输入卡片一起垂直居中） -->
        <div v-if="isEmptyChat" class="empty-chat-hint">
          <div class="empty-chat-hint-title">{{ store.locales=='zh' ? '有什么可以帮你的？' : 'How can I help you today?' }}</div>
          <div class="empty-chat-hint-sub">{{ emptyChatHintSub }}</div>
        </div>
        
        <!-- 智能体模式：任务清单（update_todo 维护，显示在输入框上方；可手动标记/清空） -->
        <div v-if="currentChat.agentTodos && currentChat.agentTodos.length" class="agent-todos-panel scoll">
          <div class="agent-todos-header">
            <i class="fa fa-tasks"></i>
            <span>{{ store.locales=='zh' ? '任务清单' : 'Todos' }}</span>
            <span class="agent-todos-count">{{ currentChat.agentTodos.filter(t => t.status === 'done').length }}/{{ currentChat.agentTodos.length }}</span>
            <span class="agent-todos-actions">
              <span class="agent-todos-action" :title="store.locales=='zh' ? '全部标记完成' : 'Mark all done'" @click="markAllTodosDone">
                <i class="fa fa-check-double"></i>
              </span>
              <span class="agent-todos-action" :title="store.locales=='zh' ? '清空任务清单' : 'Clear todos'" @click="clearAgentTodos">
                <i class="fa fa-trash-o"></i>
              </span>
            </span>
          </div>
          <div class="agent-todos-list">
            <div
              v-for="t in currentChat.agentTodos"
              :key="t.id"
              class="agent-todo-item"
              :class="'at-' + t.status"
              @click="toggleAgentTodo(t.id)"
              :title="t.status === 'done' ? (store.locales=='zh' ? '点击恢复为未完成' : 'Click to mark not done') : (store.locales=='zh' ? '点击标记完成' : 'Click to mark done')"
            >
              <i class="fa" :class="t.status === 'done' ? 'fa-check-circle' : t.status === 'running' ? 'fa-circle-o-notch fa-spin' : t.status === 'cancelled' ? 'fa-ban' : 'fa-circle-o'"></i>
              <span class="agent-todo-title" :title="t.detail || t.title">{{ t.title }}</span>
            </div>
          </div>
        </div>
        
        <!-- 图片预览区域 -->
        <div v-if="currentUploads.length > 0" class="preview-area">
          <div class="preview-header">
            <span>{{store.locales === 'en' ? 'Uploaded items' : '已上传'}} ({{ currentUploads.length }})</span>
            <div class="clear-uploads-button" @click="clearAllUploads" title="清除所有">
              <i class="fa fa-trash"></i>
            </div>
          </div>
          <div class="preview-list scoll">
            <div 
              v-for="(item, index) in currentUploads" 
              :key="index" 
              class="preview-item-small"
            >
              <!-- 图片类型 -->
              <template v-if="item.kind === 'image'">
                <img 
                  :src="getImageSrc(item.data)" 
                  alt="预览图片"
                  class="preview-image"
                />
              </template>
              <!-- 文件类型 -->
              <template v-else>
                <div class="preview-file-icon">
                  <i class="fa fa-file-text-o"></i>
                </div>
              </template>
              <div class="preview-actions">
                <div class="preview-action-button" @click="removeUpload(index)" title="删除">
                  <i class="fa fa-times"></i>
                </div>
              </div>
              <div 
                class="preview-filename" 
                :title="item.kind === 'file' && item.charCount !== undefined ? `${item.name} · ${item.charCount}字` : item.name"
              >
                {{ item.name }}
              </div>
            </div>
          </div>
        </div>
        
        <!-- 输入区域拖动条 -->
        <div
          class="input-resize-handle"
          @mousedown="onResizeStart"
          :title="store.locales=='zh' ? '拖动调整输入框高度' : 'Drag to resize input'"
        ></div>
        <!-- 输入模式 -->
        <div class="input-container">
          <textarea
            v-model="inputText"
            :placeholder="getInputPlaceholder()"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.enter.shift.exact.prevent="inputText += '\n'"
            @contextmenu.prevent="onInputContextMenu"
            ref="textInput"
            class="message-input scoll"
            style="width:100%"
            rows="3"
          ></textarea>
          <div class="input-controls">
            <!-- 对话模式选择下拉框 -->
            <div class="mode-select-wrap">
              <!-- 已关联项（放在模式下拉**左侧**）：点击重新选择对应的知识库/工作流/Agent 预设 -->
              <span
                v-if="currentChat.mode === 'retrieval'"
                class="mode-linked-chip"
                :class="{ empty: getKbLinkedEmpty() }"
                @click="selectKnowledgeBase"
                :title="getKbButtonTitle()"
              >
                <i class="fa fa-book"></i>
                <span class="mode-linked-name">{{ getKbLinkedLabel() }}</span>
              </span>
              <span
                v-if="currentChat.mode === 'workflow'"
                class="mode-linked-chip"
                :class="{ empty: !currentChat.config.workflowPath, error: workflowError }"
                @click="selectWorkflow"
                :title="getWorkflowButtonTitle()"
              >
                <i class="fa fa-stumbleupon"></i>
                <span class="mode-linked-name">{{ currentChat.config.workflowPath ? getLinkedFileName(currentChat.config.workflowPath) : (store.locales=='zh' ? '选择工作流...' : 'Select Workflow...') }}</span>
              </span>
              <span
                v-if="currentChat.mode === 'agent' || currentChat.mode === 'agent2'"
                class="mode-linked-chip"
                @click="showAgentPresetPicker = !showAgentPresetPicker"
                :title="getAgentButtonTitle()"
              >
                <i class="fa fa-user-circle"></i>
                <span class="mode-linked-name">{{ currentChat.config.presetId ? getAgentPresetName() : (store.locales=='zh' ? '通用智能体' : 'General Agent') }}</span>
              </span>

              <!-- PTC 模式：只读说明胶囊（无可配置项；步数跟随「设置 → 智能体预设 → 通用智能体」） -->
              <span
                v-if="currentChat.mode === 'code'"
                class="mode-linked-chip mode-chip-static"
                :title="store.locales=='zh'
                  ? 'PTC（程序化工具调用）：模型不逐个调用工具，而是写一段 TypeScript 程序经 run_code 组合调用工具；最大执行步数跟随「设置 → 智能体预设 → 通用智能体」的循环轮数'
                  : 'PTC (programmatic tool call): instead of calling tools one by one the model writes a TypeScript program that calls them through run_code. Max steps follows Settings → Agent → Presets → General Agent.'"
              >
                <i class="fa fa-code"></i>
                <span class="mode-linked-name">{{ store.locales=='zh' ? '程序化调用 run_code' : 'Programmatic (run_code)' }}</span>
              </span>

              <!-- 集群模式：成员 + 运行方式 + 总结全部收进这一个入口（输入区只多一个控件） -->
              <span
                v-if="currentChat.mode === 'swarm'"
                class="mode-linked-chip"
                :class="{ empty: !(currentChat.config.swarmPresetIds || []).length, error: swarmMissingPresets.length > 0 }"
                @click="showSwarmMemberPicker = !showSwarmMemberPicker; syncSwarmMembers()"
                :title="store.locales=='zh' ? '集群设置：参与成员（勾选顺序即发言顺序）、运行方式与群主总结；各成员使用自己预设里的模型' : 'Swarm settings: members (tick order = speaking order), run mode and host summary; each member uses the model from its preset'"
              >
                <i class="fa fa-users"></i>
                <span class="mode-linked-name">{{ swarmChipLabel }}</span>
              </span>

              <!-- 对话模式下拉：放在「已关联项」胶囊右侧（同一行：胶囊 → 下拉 → 检索策略） -->
              <select
                class="mode-select"
                :value="modeSelectValue"
                @change="onModeSelect"
                :disabled="isAnyExecuting"
                :title="store.locales=='zh' ? '选择对话模式' : 'Select chat mode'"
              >
                <option v-for="m in modeOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
              </select>

              <!-- 集群设置浮层（成员多选 + 运行方式 + 群主总结 + 管理预设） -->
              <div v-if="showSwarmMemberPicker" class="agent-preset-picker swarm-picker scoll" @click.stop>
                <div v-if="!(store.agentPresets || []).length" class="preset-picker-empty">
                  {{ store.locales=='zh' ? '还没有预设：请先在「设置 → 预设」中创建' : 'No presets yet — create one in Settings → Presets' }}
                </div>
                <template v-else>
                  <div
                    v-for="p in store.agentPresets"
                    :key="p.id"
                    class="preset-picker-item"
                    :class="{ active: (currentChat.config.swarmPresetIds || []).includes(p.id) }"
                    @click="toggleSwarmMember(p.id)"
                    :title="store.locales=='zh' ? '点击勾选/取消（勾选顺序即发言顺序）' : 'Click to toggle (tick order = speaking order)'"
                  >
                    <i class="fa" :class="(currentChat.config.swarmPresetIds || []).includes(p.id) ? 'fa-check-square-o' : 'fa-square-o'"></i>
                    <span class="swarm-picker-name">{{ p.name || (store.locales=='zh' ? '未命名' : 'Unnamed') }}</span>
                    <span v-if="swarmMemberOrder(p.id) > 0" class="swarm-picker-order">{{ swarmMemberOrder(p.id) }}</span>
                  </div>
                  <template v-if="swarmMissingPresets.length">
                    <div class="shared-kb-divider"></div>
                    <div class="preset-picker-item swarm-missing" @click="pruneSwarmMissing()">
                      <i class="fa fa-exclamation-triangle"></i>
                      <span>{{ (store.locales=='zh' ? '清理已失效引用 ' : 'Prune missing ') + swarmMissingPresets.length }}</span>
                    </div>
                  </template>
                </template>

                <!-- 运行方式（单选） -->
                <div class="shared-kb-divider"></div>
                <div class="swarm-picker-caption">{{ store.locales=='zh' ? '运行方式' : 'Run mode' }}</div>
                <div
                  v-for="m in swarmRunModeOptions"
                  :key="m.value"
                  class="preset-picker-item"
                  :class="{ active: swarmRunMode === m.value }"
                  @click="swarmRunMode = m.value"
                >
                  <i class="fa" :class="swarmRunMode === m.value ? 'fa-dot-circle-o' : 'fa-circle-o'"></i>
                  <span class="swarm-picker-name">{{ m.label }}</span>
                </div>

                <!-- 群主总结 -->
                <div class="shared-kb-divider"></div>
                <div
                  class="preset-picker-item"
                  :class="{ active: swarmHostSummary }"
                  @click="toggleSwarmHostSummary"
                  :title="store.locales=='zh' ? '任务结束后由群主汇总结果（默认关闭）' : 'Host summarizes at the end (default off)'"
                >
                  <i class="fa" :class="swarmHostSummary ? 'fa-check-square-o' : 'fa-square-o'"></i>
                  <span class="swarm-picker-name">{{ store.locales=='zh' ? '结束由群主总结' : 'Host summary at end' }}</span>
                </div>

                <!-- 管理预设 -->
                <div class="shared-kb-divider"></div>
                <div class="preset-picker-item" @click="goManageAgentPresets()">
                  <i class="fa fa-cog"></i>
                  <span class="swarm-picker-name">{{ store.locales=='zh' ? '管理预设...' : 'Manage presets...' }}</span>
                </div>
              </div>

              <!-- 知识库模式：检索策略选择（样式与 mode-select 统一） -->
              <select
                v-if="currentChat.mode === 'retrieval'"
                v-model="currentChat.config.retrievalStrategy"
                @change="saveChats"
                class="mode-select strategy-select"
                :disabled="isAnyExecuting"
                :title="store.locales=='zh' ? '选择检索策略' : 'Select retrieval strategy'"
              >
                <option v-for="s in retrievalStrategyOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>

              <!-- Agent 预设选择浮层（含「通用智能体」） -->
              <div v-if="showAgentPresetPicker" class="agent-preset-picker scoll" @click.stop>
                <div
                  class="preset-picker-item"
                  :class="{ active: !currentChat.config.presetId }"
                  @click="selectGeneralAgent"
                >
                  <i class="fa fa-android"></i>
                  <span>{{ store.locales=='zh' ? '通用智能体' : 'General Agent' }}</span>
                </div>
                <div
                  v-for="p in store.agentPresets"
                  :key="p.id"
                  class="preset-picker-item"
                  :class="{ active: currentChat.config.presetId === p.id }"
                  @click="selectAgentPreset(p)"
                >
                  <i class="fa fa-user"></i>
                  <span>{{ p.name || (store.locales=='zh' ? '未命名' : 'Unnamed') }}</span>
                </div>
              </div>

              <!-- 浏览器模式：共享知识库（主机目录）/ 上传自己的文件 选择浮层 -->
              <div v-if="showSharedKbPicker" class="shared-kb-picker scoll" @click.stop>
                <div class="preset-picker-item" @click="openKbFilePicker(); showSharedKbPicker = false">
                  <i class="fa fa-upload"></i>
                  <span>{{ store.locales=='zh' ? '上传 .kb 知识库文件' : 'Upload .kb KB file' }}</span>
                </div>
                <div class="shared-kb-divider"></div>
                <div class="shared-kb-title">{{ store.locales=='zh' ? '共享知识库（主机目录）' : 'Shared KB (host folder)' }}</div>
                <div v-if="sharedKbLoading" class="preset-picker-empty"><i class="fa fa-spinner fa-spin"></i> {{ store.locales=='zh' ? '加载中...' : 'Loading...' }}</div>
                <div v-else-if="!sharedKbList.length" class="preset-picker-empty">{{ store.locales=='zh' ? '主机未配置知识库共享目录，或目录中没有 .kb' : 'No shared KB from the host folder' }}</div>
                <template v-else>
                  <div
                    v-for="f in sharedKbList"
                    :key="f.name"
                    class="preset-picker-item"
                    :class="{ active: currentChat.config.sharedKb?.name === f.name }"
                    @click="pickSharedKb(f.name, f.size)"
                  >
                    <i class="fa fa-file-text-o"></i>
                    <span class="shared-kb-name">{{ f.name }}</span>
                  </div>
                </template>
              </div>
            </div>
            <!-- 文件/图片上传按钮（浏览器模式下知识库模式退化为上传文件）
                 生成 / 执行中也可以继续添加附件（随下一条消息发送，与前一轮互不影响） -->
            <div class="button" v-if="currentChat.mode === 'normal' || (isBrowser && currentChat.mode === 'retrieval')" @click="onUploadClick" :title="getUploadButtonTitle()">
              <i class="fa fa-paperclip"></i>
              <input 
                type="file" 
                ref="fileInput"
                @change="handleFileUpload"
                accept="image/*,.md,.docx,.pdf,.txt,.html,.htm,.json,.csv,.js,.py"
                multiple
                style="display: none;"
              />
              <input
                v-if="isBrowser"
                type="file"
                ref="kbFileInput"
                @change="handleKbFileUpload"
                accept=".kb"
                multiple
                style="display: none;"
              />
            </div>
            <!-- 生成状态 / 连接测试 / 执行提示：图标位占附件按钮右侧的空白，
                 只显示图标（完整提示在图标 title 上），大小与附件按钮一致 -->
            <div v-if="showStepInfoContainer" class="step-info-container">
              <!-- 系统 / 模型服务返回的错误：只显示图标，完整文字在 title 上，点击可关闭 -->
              <div
                v-if="systemErrorText"
                class="step-indicator step-error clickable"
                :title="systemErrorText"
                @click="systemErrorText = ''"
              >
                <i class="fa fa-exclamation-triangle"></i>
              </div>
              <!-- 聊天生成状态（仅图标，提示见 title）- 普通对话时显示（step 状态为空时隐藏，避免 agent 模式出现空白指示器） -->
              <div v-if="currentChat.isGenerating && !isAnotherChatExecuting && (stepIcon || currentStep)" class="step-indicator" :class="stepIndicatorClass" :title="currentStep">
                <i :class="stepIcon || 'fa fa-refresh fa-spin'"></i>
              </div>

              <!-- 连接测试状态（仅图标，提示见 title） -->
              <div v-if="connectionTestStatus" class="step-indicator" :class="connectionTestClass" :title="connectionTestStatus">
                <i :class="connectionTestIcon"></i>
              </div>

              <!-- 统一的执行状态（仅图标，提示见 title） - 只在当前聊天有执行时显示（工作流/技能） -->
              <div v-if="shouldShowExecution" class="step-indicator" :class="`step-${currentExecutionType}`" :title="getStepDescription()">
                <i class="fa" :class="getStepIcon()"></i>
              </div>

              <!-- 显示其他聊天后台执行提示（仅图标，提示见 title） -->
              <div v-else-if="isAnyExecuting && globalExecutionState.chatId !== currentChat.id" class="step-indicator step-info" :title="store.locales=='zh' ? '其他聊天正在后台执行中...' : 'Other chat executing in background...'">
                <i class="fa fa-info-circle"></i>
              </div>

              <!-- 检索统计信息 - 只在有检索结果且不是执行状态时显示（贴右） -->
              <div v-if="retrievalStats && !isExecuting && !shouldShowExecution" class="retrieval-stats">
                <div class="stat-item" title="总知识片段数量">
                  <i class="fa fa-cubes"></i>
                  <span>{{ retrievalStats.totalBlocks }}</span>
                </div>
                <div class="stat-item" title="返回的片段数量">
                  <i class="fa fa-check-circle"></i>
                  <span>{{ retrievalStats.returnedBlocks }}</span>
                </div>
                <div class="stat-item" title="最大相似度">
                  <i class="fa fa-chart-line"></i>
                  <span>{{ retrievalStats.maxSimilarity }}</span>
                </div>
                <div v-if="retrievalStats.averageSimilarity" class="stat-item" title="平均相似度">
                  <i class="fa fa-chart-bar"></i>
                  <span>{{ retrievalStats.averageSimilarity }}</span>
                </div>
              </div>
            </div>
            <!-- 右侧操作组：语音输入 + 发送（整组贴右下，不拉伸） -->
            <div class="input-right-group">
              <!-- 语音输入按钮 -->
              <div 
                v-if="showASRButton"
                class="button asr-button"
                :class="{ 
                  'asr-recording': isASRRecording,
                  'asr-processing': isASRProcessing
                }"
                @mousedown="onASRPress"
                @mouseup="onASRRelease"
                @mouseleave="onASRLeave"
                :title="getASRButtonTitle()"
              >
                <!-- 录音中：波形动画 -->
                <template v-if="isASRRecording">
                  <span v-for="i in 5" :key="i" class="asr-wave-dot" :style="{ animationDelay: (i * 0.15) + 's' }"></span>
                </template>
                <!-- 识别中：旋转圆环 + 麦克风（与录音区分，避免看起来卡住） -->
                <template v-else-if="isASRProcessing">
                  <span class="asr-processing-wrap">
                    <span class="asr-processing-ring"></span>
                    <i class="fa fa-microphone asr-processing-mic"></i>
                  </span>
                </template>
                <!-- 空闲：麦克风图标 -->
                <i v-else :class="getASRIcon()"></i>
                <!-- ASR 错误提示气泡 -->
                <div v-if="asrErrorMessage" class="asr-error-tooltip">
                  <i class="fa fa-exclamation-triangle"></i>
                  {{ asrErrorMessage }}
                </div>
              </div>
              <!-- 停止生成 / 发送：同一位置互斥（生成/执行中显示停止，空闲显示发送） -->
              <div 
                v-if="showStopButton"
                class="button stop-button"
                @click="stopCurrentGeneration"
                :title="store.locales=='zh' ? '停止生成' : 'Stop Generation'"
              >
                <i class="fa fa-stop"></i>
              </div>
              <div 
                v-else
                class="button send-button" 
                @click="sendMessage" 
                :disabled="isSendButtonDisabled"
                :class="{ 'send-disabled': isSendButtonDisabled }"
                :title="getSendButtonTitle()"
              >
                <i class="fa" :class="canSteerRun ? 'fa-bullhorn' : 'fa-play'"></i>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 分支图面板 - D3 树状图 -->
    <div v-if="showBranchView" class="branch-panel">
      <div class="branch-panel-content">
        <div ref="d3TreeContainer" class="d3-tree-container" @contextmenu.prevent="onBranchPanelContextMenu($event)"></div>
      </div>
    </div>
    
    <!-- 图片预览模态框 -->
    <div v-if="showImagePreview" class="image-preview-modal" @click="closeImagePreview">
      <div class="modal-content" @click.stop>
        <img :src="previewImageSrc" alt="预览图片" class="full-size-image" />
        <div class="modal-actions">
          <button class="modal-button" @click="downloadImage(previewImageSrc)" title="下载图片">
            <i class="fa fa-download"></i> <span>下载</span>
          </button>
          <button class="modal-button" @click="closeImagePreview" title="关闭">
            <i class="fa fa-times"></i> <span>关闭</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Mermaid 图查看（放大/平移/导出，复用共享组件） -->
    <MermaidViewer ref="mermaidViewerRef" />

    <!-- 导出为 Word：另存为对话框（导出样式 + 保存位置；聊天无源目录时默认落系统下载目录） -->
    <WordExportDialog v-model="wordExportVisible" :markdown="wordExportMarkdown" :title="wordExportTitle" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUpdated, onBeforeUnmount, type Ref } from 'vue'
import { usestore } from '@/store'
import { retrieveKnowledge, resolveStrategyId } from '@/shared/kbRetrieval'
import { buildEmbedFallbackFromStore } from '@/shared/kbAiClient'
import { listSharedKbs, searchSharedKb, searchUploadedKbTexts } from '@/platform/lanKb'
import { getEnabledStrategies, setUserStrategies } from '@/shared/graphrag/strategy'
import { WorkflowRunner, type WorkflowData, type ExecutionCallback, type NodeType } from '@/components/workFlow/engine/WorkflowRunner'
import { hashContent, renderMermaidSvgLenient, getCachedSvgLenient, clearMermaidCache, ensureMermaidInit } from '@/lib/markdown/mermaid'
import MermaidViewer from '@/components/MermaidViewer.vue'
import WordExportDialog from '@/components/export/WordExportDialog.vue'
import { AIUtils } from '@/services/ai-utils'
import { deepSeekStyleOf, normalizeLlmType, resolveLlmSource } from '@/shared/llmSources'
import {
  estimateChatContextTokens,
  resolveContextLimit,
  manualContextWindow,
  probedContextWindow,
  rememberProbedContextWindow,
  realContextWindowCacheKey,
  getCachedRealContextWindow,
  getCachedLoadedContextWindow,
  hasProbedRealContextWindow,
  contextWindowCacheAt,
  setCachedRealContextWindow,
} from '@/lib/contextUsage'
import { md, renderMarkdown, highlightCodeHtml, normalizeMermaidSource } from '@/lib/markdown/render'
// PTC（Code Mode）：run_code 输出解析（返回值 / console 日志 / 程序内调用的工具）
import { extractPtcRunOutput, formatPtcValue, type PtcRunOutput } from '@/lib/agent/ptc'
import type { EditDiffFilePreview } from '@/shared/editDiff'
import type { ChatMode, RelevantBlock, ExecutionUnit, WorkflowUnit, UploadItem, ChatMessage, ChatConfig, Chat, RetrievalStats } from '@/types/chat'
import { useChatModels } from '@/composables/useChatModels'
import { useAgentRun } from '@/composables/useAgentRun'
// 集群模式（多 Agent 协作）：成员 = Agent 预设引用（改预设即改成员），执行复用集群运行时
import { agents as swarmAgents, swarmMode, settings as swarmSettings, debateRounds as swarmDebateRounds, setSwarmRunChatId, running as swarmRunning, swarmRunChatId } from '@/store/swarmState'
import { runSwarm, runNamedTask, stopSwarm } from '@/store/swarmRunner'
import { applyMembers } from '@/composables/swarm/useSwarmMembers'
import { loadSkillList } from '@/composables/swarm/useSwarmAgents'
import { chatsRef, currentChatIndexRef, globalExecutionStateRef, workflowStartTimeRef, workflowErrorRef, ensureInitialChat } from '@/store/chats'
// 导入技能管理器
import { getSkillManager, type Skill } from '@/services/agentSkills'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as d3 from 'd3'
import draggable from 'vuedraggable'

const store = usestore()

// 浏览器模式（LAN 共享）：无 ipcRenderer，知识库退化为上传文件
const isBrowser = typeof window !== 'undefined' && !(window as any).ipcRenderer

// 聊天领域类型已抽到 src/types/chat.ts（见上方 import type）

// ==================== 全局执行状态管理 ====================
// 全局执行状态提升为模块级共享 ref：切模块卸载后，后台技能/工作流执行仍更新同一状态
const globalExecutionState = globalExecutionStateRef as unknown as Ref<{
  isExecuting: boolean
  executionType: 'workflow' | 'skill' | null
  chatId: string | null
  skillLoading: boolean
  currentStep: string
  stepIcon: string
  stepIndicatorClass: string
  workflowRunner: WorkflowRunner | null
  abortController: AbortController | null
}>

// 技能管理器实例
const skillManager = getSkillManager(store)

// 技能相关状态
const availableSkills = ref<Skill[]>([])

// 响应式数据：chats 提升为模块级共享 ref（切模块卸载后后台执行仍写入同一数据源）
const isFirstInit = ensureInitialChat(createNewChatData)
const chats = chatsRef as Ref<Chat[]>
// 当前聊天索引提升为模块级共享 ref：卸载模块后保留现场，重进回到同一聊天栏
const currentChatIndex = currentChatIndexRef
// 持久化当前聊天栏（供应用重启后恢复）
watch(currentChatIndex, (idx) => {
  localStorage.setItem('ai-chats-index', String(idx))
}, { immediate: true })
const inputText = ref<string>('')

const showSidebar = ref(false)  // 聊天列表侧边栏：初始不显示，由聊天标题左侧的 fa-bars 开关展开
const showBranchView = ref(false)  // 分支树视图开关

// 聊天列表搜索
const searchActive = ref(false)
const searchQuery = ref('')

/** 打开搜索框并聚焦 */
const openSearch = () => {
  searchActive.value = true
  nextTick(() => {
    document.querySelector<HTMLInputElement>('.chat-search-input')?.focus()
  })
}

/** 关闭搜索框并清空关键词 */
const closeSearch = () => {
  searchActive.value = false
  searchQuery.value = ''
}

/** 顶部新建聊天：关闭搜索后新建 */
const onToolbarNewChat = () => {
  searchActive.value = false
  searchQuery.value = ''
  createNewChat()
}

/** 聊天列表搜索匹配：标题 / 消息内容 / 模型名 / 模式名 */
const isChatMatched = (chat: Chat): boolean => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return true
  const text = [
    chat.title,
    chat.config.model,
    ...(chat.messages || []).map(m => m.content)
  ].filter(Boolean).join('\n').toLowerCase()
  return text.includes(q)
}
const showBranchTitles = ref(false)  // 分支树是否显示标题文字
const isTTSSpeaking = ref(false)
const autoScrollEnabled = ref(true)

// ASR 语音输入状态
const isASRRecording = ref(false)
const isASRProcessing = ref(false)
const asrErrorMessage = ref('')
let asrErrorTimer: any = null
let asrManagerInstance: any = null
// funasr-online 流式：实时 partial 写入输入框。记录录音开始时的输入为 base，partial 追加在其后；
// 每完成一句（VAD/停止）把 base 前滚，避免覆盖用户已输入内容，也支持多句连续
let asrPartialFill = false
let asrBaseText = ''
const isUserScrolling = ref(false)
const scrollTimeout = ref<NodeJS.Timeout | null>(null)
const messageContainer = ref<HTMLElement | null>(null)
const showKbDetails = ref<Record<number, boolean>>({})

// 文件/图片上传相关状态
const currentUploads = ref<UploadItem[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
// 浏览器模式知识库退化为上传文件的隐藏文件输入
const kbFileInput = ref<HTMLInputElement | null>(null)
// 浏览器模式：共享知识库（主机目录）选择浮层
const showSharedKbPicker = ref(false)
const sharedKbList = ref<{ name: string; size: number; mtime: number }[]>([])
const sharedKbLoading = ref(false)
const showImagePreview = ref(false)
const previewImageSrc = ref<string>('')
const previewImageData = ref<string | Uint8Array | ArrayBuffer>('')

// Mermaid 查看（复用共享组件 MermaidViewer：放大/平移/导出/适应窗口）
const mermaidViewerRef = ref<InstanceType<typeof MermaidViewer> | null>(null)
const openMermaidModal = (source: string) => { mermaidViewerRef.value?.open({ source }) }

// 状态变量
const retrievalStats = ref<RetrievalStats | null>(null)
const expandedKbBlock = ref<number | null>(null)

const toggleKbBlock = (index: number) => {
  expandedKbBlock.value = expandedKbBlock.value === index ? null : index
}

// 打开联网搜索结果对应的网页
const openWebResult = (result: any) => {
  if (!result?.url) return
  // Electron 主进程通过 setWindowOpenHandler 拦截并调用 shell.openExternal 打开外部浏览器
  window.open(result.url, '_blank')
}

// 网页标题缓存，避免重复请求
const webTitleCache = new Map<string, string>()

// 后台获取联网搜索结果对应的真实网页标题（通过 Electron 主进程 IPC，浏览器环境自动跳过）
const enrichWebSearchTitles = async (results: any[]) => {
  if (!results || results.length === 0) return
  for (const r of results) {
    if (!r?.url) continue
    if (r.title && r.title !== r.url) continue // 已有真实标题，跳过
    if (webTitleCache.has(r.url)) {
      r.title = webTitleCache.get(r.url) || r.title
      continue
    }
    if (window.ipcRenderer) {
      window.ipcRenderer.invoke('fetchWebPageTitle', r.url)
        .then((title: string) => {
          if (title) {
            webTitleCache.set(r.url, title)
            r.title = title
          }
        })
        .catch(() => {})
    }
  }
}

// 获取联网搜索结果的显示标题：有真实标题用标题，否则从 URL 推导友好的显示名
const getWebSearchTitle = (r: any, index: number): string => {
  if (r.title && r.title !== r.url) return r.title
  if (r.url) {
    try {
      const u = new URL(r.url)
      const host = u.hostname.replace(/^www\./, '')
      const pathPart = u.pathname.split('/').filter(Boolean).pop()
      // 去掉常见文件扩展名/片段，让标题更友好
      const label = pathPart ? `${host}/${pathPart}` : host
      return decodeURIComponent(label).slice(0, 60)
    } catch (e) {
      return r.url
    }
  }
  return `#${index + 1}`
}

// 连接测试状态
// 连接测试状态（connectionTestStatus/Icon/Class/Timeout）已由 useChatModels 提供（见文末接线）

// 工作流相关状态
const workflowError = workflowErrorRef

// 右键菜单状态
const contextMenuVisible = ref(false)
const contextMenuPos = ref({ x: 0, y: 0 })
const contextMenuTargetIndex = ref<number | null>(null)
const isInputContextMenu = ref(false)
/** 右键打开菜单时保存的用户选中文字 */
const contextMenuSelectedText = ref('')

// 侧边栏右键菜单状态
const sidebarContextMenuVisible = ref(false)
const sidebarContextMenuPos = ref({ x: 0, y: 0 })
const sidebarContextMenuChatIndex = ref<number | null>(null)

// 分支树右键菜单状态
const branchContextMenuVisible = ref(false)
const branchContextMenuPos = ref({ x: 0, y: 0 })
const branchContextMenuNode = ref<any>(null)
const branchContextMenuRef = ref<HTMLElement | null>(null)

const hideContextMenu = () => {
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
  isInputContextMenu.value = false
  contextMenuSelectedText.value = ''
}

const hideSidebarContextMenu = () => {
  sidebarContextMenuVisible.value = false
  sidebarContextMenuChatIndex.value = null
}

const onSidebarContextMenu = (e: MouseEvent, index: number) => {
  e.preventDefault()
  sidebarContextMenuChatIndex.value = index
  sidebarContextMenuPos.value = {
    x: Math.min(e.clientX, window.innerWidth - 200),
    y: e.clientY
  }
  sidebarContextMenuVisible.value = true
}

const onMessageContextMenu = (e: MouseEvent) => {
  if (currentChat.value.messages.length === 0) return
  e.preventDefault()
  
  // 右键时保存用户选中的文字（点击菜单项后选中状态可能丢失）
  const sel = window.getSelection()
  contextMenuSelectedText.value = sel?.toString().trim() || ''
  
  // 查找右键点击的是哪条消息
  const target = e.target as HTMLElement
  const msgItem = target.closest('.message-item')
  if (msgItem) {
    const container = messageContainer.value
    if (container) {
      const items = container.querySelectorAll('.message-item')
      items.forEach((item, i) => {
        if (item === msgItem) {
          contextMenuTargetIndex.value = i
        }
      })
    }
  } else {
    contextMenuTargetIndex.value = null
  }
  
  contextMenuPos.value = {
    x: Math.min(e.clientX, window.innerWidth - 200),
    y: e.clientY
  }
  contextMenuVisible.value = true
}

const clearCurrentChatFromMenu = async () => {
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
  await clearCurrentChat()
}

const exportChatFromMenu = () => {
  const msgIdx = contextMenuTargetIndex.value
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
  exportChat(msgIdx)
}

const exportChatToKbFromMenu = () => {
  const msgIdx = contextMenuTargetIndex.value
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
  exportChatToKb(msgIdx)
}

// 「导出为 Word」另存为对话框的状态（Markdown 源 + 标题）
const wordExportVisible = ref(false)
const wordExportMarkdown = ref('')
const wordExportTitle = ref('文档')

const exportChatToWord = () => {
  const msgIdx = contextMenuTargetIndex.value
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
  const chat = currentChat.value
  const title = chat.title?.trim() || `聊天${currentChatIndex.value + 1}`
  const messages = msgIdx !== null && chat.messages[msgIdx] ? [chat.messages[msgIdx]] : chat.messages
  // 将所有消息拼接为 markdown 文本，交给统一 Word 导出管线（含样式皮肤）
  const lines: string[] = []
  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleString('zh-CN')
    const roleLabel = msg.role === 'user' ? '👤 用户' : msg.role === 'assistant' ? '🤖 助理' : '⚙️ 系统'
    const cleanedMsg = stripToolBadges(msg.content || '')
    lines.push(`**${roleLabel}** · ${time}`)
    lines.push('')
    lines.push(cleanedMsg || '')
    lines.push('')
    lines.push('---')
    lines.push('')
  }
  // 弹出另存为对话框（导出样式 + 保存位置）；聊天没有源文件目录，默认落系统下载目录
  wordExportMarkdown.value = lines.join('\n')
  wordExportTitle.value = title
  wordExportVisible.value = true
}

const ttsFromMenu = () => {
  const idx = contextMenuTargetIndex.value
  if (idx !== null && currentChat.value.messages[idx]) {
    store.tts(currentChat.value.messages[idx].content)
    isTTSSpeaking.value = true
  }
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
}

const stopTTSFromMenu = () => {
  store.stopTTS()
  isTTSSpeaking.value = false
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
}

/** 右键菜单：从此处分支 */
const branchFromContextMenu = () => {
  const msgIdx = contextMenuTargetIndex.value
  if (msgIdx !== null) {
    createBranch(currentChatIndex.value, msgIdx)
  }
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
}

const copyFromMenu = () => {
  // 优先复制右键时保存的选中文字
  if (contextMenuSelectedText.value) {
    copyMessage(contextMenuSelectedText.value)
  } else {
    const idx = contextMenuTargetIndex.value
    if (idx !== null && currentChat.value.messages[idx]) {
      copyMessage(currentChat.value.messages[idx].content)
    }
  }
  contextMenuVisible.value = false
  contextMenuTargetIndex.value = null
  contextMenuSelectedText.value = ''
}

// 输入框右键菜单：粘贴
const pasteToInput = async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      inputText.value += text
    }
  } catch (err) {
    console.error('粘贴失败:', err)
  }
  contextMenuVisible.value = false
  isInputContextMenu.value = false
}

const onInputContextMenu = (e: MouseEvent) => {
  contextMenuPos.value = {
    x: Math.min(e.clientX, window.innerWidth - 200),
    y: e.clientY
  }
  isInputContextMenu.value = true
  contextMenuTargetIndex.value = null
  contextMenuVisible.value = true
}


// ==================== 计算属性 ====================
const currentChat = computed(() => chats.value[currentChatIndex.value])

/** 当前聊天没有任何历史消息（含未开始生成）：输入区在剩余空间里垂直居中 */
const isEmptyChat = computed(() => {
  const chat = currentChat.value
  if (!chat) return true
  if (chat.isGenerating) return false
  return (chat.messages?.length || 0) === 0
})

/** 空聊天的引导提示（按当前对话模式给一句更贴合的话） */
const emptyChatHintSub = computed(() => {
  const zh = store.locales === 'zh'
  switch (currentChat.value?.mode || 'normal') {
    case 'retrieval':
      return zh ? '先选择知识库，再提问：会先检索相关片段再作答' : 'Pick a knowledge base, then ask — relevant snippets are retrieved first'
    case 'workflow':
      return zh ? '先选择工作流，再描述要执行的任务' : 'Pick a workflow, then describe the task to run'
    case 'agent':
      return zh ? '交给智能体预设：自主规划并调用工具完成' : 'Hand it to an agent preset: it plans and uses tools autonomously'
    case 'agent2':
      return zh ? '交给通用智能体：自主规划并调用工具完成' : 'Hand it to the general agent: it plans and uses tools autonomously'
    case 'swarm':
      return zh ? '多智能体集群：拆解任务、分工协作完成' : 'Swarm: several agents split up and complete the work'
    case 'code':
      return zh ? 'PTC 模式：写一段程序组合多步工具调用' : 'PTC mode: write a program that chains several tool calls'
    default:
      return zh
        ? '直接提问，或上传文件 / 图片一起分析；也可切换下方模式做知识库检索、跑工作流或交给智能体'
        : 'Ask anything, or upload files / images for context; switch modes below for retrieval, workflows or agents'
  }
})

/**
 * 空聊天时输入区上移的距离（= 消息区高度的一半，即居中位置到贴底位置的距离）。
 * 用 transform + 过渡实现（auto 边距不能过渡）：发送第一条消息后输入区能「往下」平滑滑回常规位置。
 */
const composerShift = ref(0)
let composerResizeObserver: ResizeObserver | null = null
const updateComposerShift = () => {
  const box = messageContainer.value
  composerShift.value = box ? Math.max(0, Math.round(box.clientHeight / 2)) : 0
}
// 空态变化（发第一条消息 / 清空聊天 / 切到别的聊天）后重算位移：布局已更新再测量
watch(isEmptyChat, () => { void nextTick(updateComposerShift) })

// 是否显示 ASR 语音按钮：ONNX Whisper 本地模式下需配置模型路径否则隐藏
const showASRButton = computed(() => {
  if (store.AIconfig.asr.type === 'onnx-whisper' && !store.AIconfig.asr.onnx.modelPath) {
    return false
  }
  return true
})

let mermaidRenderTimer: number | null = null
let mermaidLastRunAt = 0
let mermaidRenderPendingForce = false
// 同一份源码的并发渲染去重（流式重建后可能反复命中同一个 wrapper）
const mermaidInflight = new Set<string>()
// 已确认无法渲染的源码（规范化后）：只显示一次源码兜底，避免每次流式更新都反复解析失败
const mermaidFailedCache = new Set<string>()

const clearPendingMermaidRender = () => {
  if (mermaidRenderTimer !== null) {
    clearTimeout(mermaidRenderTimer)
    mermaidRenderTimer = null
  }
}

// 节流调度（最小间隔 ~delay ms，且总是保留尾部一次执行）：
// 流式输出期间内容每 ~30ms 更新一次，若用 debounce 会把任务无限后延，
// 导致 mermaid 全部拖到「生成结束」才渲染——这里改为固定节流，持续流式也会定期触发。
const scheduleMermaidRender = (force = false, delay = 140) => {
  if (force) mermaidRenderPendingForce = true
  if (mermaidRenderTimer !== null) return
  const wait = Math.max(30, delay - (Date.now() - mermaidLastRunAt))
  mermaidRenderTimer = window.setTimeout(() => {
    mermaidRenderTimer = null
    const f = mermaidRenderPendingForce
    mermaidRenderPendingForce = false
    mermaidLastRunAt = Date.now()
    void renderMermaidDiagrams(f)
  }, wait)
}

watch(
  () => currentChat.value?.messages?.map((message) => `${message.timestamp}:${message.content}`).join('\n'),
  async () => {
    await nextTick()
    scheduleMermaidRender()
  },
  { flush: 'post', deep: true }
)

// 计算当前是否应该显示执行状态
const shouldShowExecution = computed(() => {
  return globalExecutionState.value.isExecuting && 
         globalExecutionState.value.chatId === currentChat.value.id
})

// 计算是否处于执行中
const isAnyExecuting = computed(() => globalExecutionState.value.isExecuting)

// 是否有其他聊天正在执行（不是当前聊天）
const isAnotherChatExecuting = computed(() => {
  return globalExecutionState.value.isExecuting && globalExecutionState.value.chatId !== currentChat.value.id
})

// 当前聊天是否在执行中
const isExecuting = computed(() => {
  const hasExecutingMessage = currentChat.value.messages.some(msg => msg.isExecuting === true)
  const isGenerating = currentChat.value.isGenerating === true
  const isGlobalExecutingForThisChat = globalExecutionState.value.isExecuting && 
                                       globalExecutionState.value.chatId === currentChat.value.id
  
  return hasExecutingMessage || isGenerating || isGlobalExecutingForThisChat
})

// 当前聊天是否有智能体会话正在执行（用于显示「停止」按钮；agent 不走 globalExecutionState）
const isAgentRunActive = computed(() =>
  (currentChat.value.messages || []).some(
    (m) => m.executionType === 'skill' && m.isExecuting === true
  )
)

// 是否显示「停止生成」按钮：四种模式任一在当前聊天生成/执行（普通/知识库流式 isGenerating、
// 工作流全局执行、智能体 skill 会话），或存在其它聊天后台全局执行（工作流等）
const showStopButton = computed(() => {
  // 集群模式：运行中显示停止（集群运行态不在 globalExecutionState 中）
  if (currentChat.value?.mode === 'swarm' && swarmRunning.value) return true
  if (isAnyExecuting.value) return true
  if (isAgentRunActive.value) return true
  const chat = currentChat.value
  if (!chat) return false
  if (chat.isGenerating === true) return true
  return (chat.messages || []).some(m => m.role === 'assistant' && m.isExecuting === true)
})

/**
 * 当前聊天是否处于「运行中引导」状态：智能体（智能体/预设/PTC/技能）或集群成员正在执行时，
 * 输入框不锁死——用户可继续输入要求，Enter 即为**引导**（steer）：
 * 不打断当前执行，投递到智能体下一个 step 边界生效（对齐主流 agent 客户端）。
 */
const canSteerRun = computed(() => {
  const chat = currentChat.value
  if (!chat) return false
  if (isAgentRunActive.value) return true
  // 集群：仅当本次集群运行就属于当前对话时才可引导（其它集群聊天里不给引导）
  return chat.mode === 'swarm' && swarmRunning.value && swarmRunChatId.value === chat.id
})

// 输入行内的「系统错误」提示（图标 + 悬停 title 显示完整错误）：
// 来源 1：请求失败（onError / 发送异常）直接写入；来源 2：对话里新增的「系统」消息（如集群执行的报错）。
// 目的：错误除了在对话里有一条消息，也能在输入行不占地方地提示（悬停看全文，点一下关闭）。
const systemErrorText = ref('')
const setSystemError = (text: string) => {
  const t = String(text || '').trim()
  if (t) systemErrorText.value = t
}

// 对话里出现新的「系统」消息（最后一条）→ 同步到输入行提示
watch(
  () => {
    const msgs: any[] = currentChat.value?.messages || []
    const last: any = msgs.length ? msgs[msgs.length - 1] : null
    // 只关心「新消息」与「系统消息内容变化」，避免流式时每次都触发
    return last ? `${last.timestamp}|${last.role}|${last.role === 'system' ? String(last.content || '').length : 0}` : ''
  },
  () => {
    const msgs: any[] = currentChat.value?.messages || []
    const last: any = msgs.length ? msgs[msgs.length - 1] : null
    if (last && last.role === 'system' && String(last.content || '').trim()) {
      systemErrorText.value = String(last.content).trim()
    }
  }
)
// 切换对话时清掉：错误提示不跨对话残留（重进模块时也不恢复旧错）
watch(currentChatIndex, () => { systemErrorText.value = '' })

// 输入框上方「步骤指示 + 统计」容器：仅当确有内容可显示时才渲染。
// 避免 agent 模式（step 状态为空）下仅因 currentChat.isGenerating / isExecuting
// 而出现空白容器 + 空白指示器（<i class=""></i> 空块）。
const showStepInfoContainer = computed(() => {
  if (systemErrorText.value) return true
  if (connectionTestStatus.value) return true
  if (shouldShowExecution.value) return true
  // 当前聊天生成指示器：step 状态非空才显示（agent 循环 step 为空时不占位）
  if (currentChat.value.isGenerating && !isAnotherChatExecuting.value && (stepIcon.value || currentStep.value)) return true
  // 其他聊天后台执行提示
  if (isAnyExecuting.value && globalExecutionState.value.chatId !== currentChat.value.id) return true
  // 检索统计（非执行状态时）
  if (retrievalStats.value && !isExecuting.value && !shouldShowExecution.value) return true
  return false
})

const skillLoading = computed({
  get: () => globalExecutionState.value.skillLoading,
  set: (value) => { globalExecutionState.value.skillLoading = value }
})

const currentExecutionType = computed({
  get: () => globalExecutionState.value.executionType,
  set: (value) => { globalExecutionState.value.executionType = value }
})

const currentStep = computed({
  get: () => globalExecutionState.value.currentStep,
  set: (value) => { globalExecutionState.value.currentStep = value }
})

const stepIcon = computed({
  get: () => globalExecutionState.value.stepIcon,
  set: (value) => { globalExecutionState.value.stepIcon = value }
})

const stepIndicatorClass = computed({
  get: () => globalExecutionState.value.stepIndicatorClass,
  set: (value) => { globalExecutionState.value.stepIndicatorClass = value }
})

const abortController = computed({
  get: () => globalExecutionState.value.abortController,
  set: (value) => { globalExecutionState.value.abortController = value }
})

const workflowRunner = computed({
  get: () => globalExecutionState.value.workflowRunner,
  set: (value) => { globalExecutionState.value.workflowRunner = value }
})

const isSendButtonDisabled = computed(() => {
  const chat = currentChat.value
  const isSwarm = chat.mode === 'swarm'
  // 运行中引导：智能体/集群执行期间输入框保持可用（Enter = 投递引导，不打断本轮）
  const steerMode = canSteerRun.value
  return Boolean(
    // 仅当前对话执行中时禁用发送；其它对话在后台推理不影响本对话发送
    (isExecuting.value && !steerMode) ||
    // 集群：本对话的集群运行中不可重发（运行时为模块级单例，需等本轮结束）
    (isSwarm && swarmRunning.value && !steerMode) ||
    (!inputText.value.trim() && currentUploads.value.length === 0) ||
    // 集群不要求顶层模型（各成员用自己预设的模型）
    (!isSwarm && !chat.config.model)
  )
})

const availableModels = computed(() => {
  const llmType = currentChat.value.config.llmType
  const config = store.AIconfig.llm
  let list: any[] = []

  switch(llmType) {
    case 'ollama':
      list = config.ollama.available_models || []
      break
    case 'lmstudio':
      list = config.lmstudio?.available_models || []
      break
    case 'openai':
      list = config.openai.available_models || []
      break
    case 'deepseek':
    case 'deepseek-responses': {
      // 单来源：按当前接口样式取该样式自己的模型列表；始终包含已配置/默认模型，
      // 避免下拉框停留在 "select model"（'deepseek-responses' 仅为历史存档别名）
      const dsCfg = deepSeekStyleOf(llmType, config.deepseek) === 'responses' ? config.deepseekResponses : config.deepseek
      list = (dsCfg?.available_models || []).filter(Boolean)
      const model = dsCfg?.model
      if (model && !list.includes(model)) list = [model, ...list]
      break
    }
    case 'gpustack': {
      list = config.gpustack?.available_models || []
      const model = config.gpustack?.model
      if (model && !list.includes(model)) list = [model, ...list]
      break
    }
    case 'anthropic':
      list = [config.anthropic.model]
      break
    case 'google':
      list = [config.google.model]
      break
    case 'azure':
      list = config.azure.deployment ? [config.azure.deployment] : []
      break
    case 'custom': {
      // 按聊天绑定的来源取模型列表（多来源下可切换各来源的模型）；绑定来源被禁用时回退到第一个启用来源
      const c = store.AIconfig.llm.custom
      const sources = Array.isArray(c?.sources) ? c.sources : []
      const enabled = (sources as any[])
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => !store.isLlmSourceDisabled('custom', s?.id))
      let idx = typeof currentChat.value.config.customSourceIndex === 'number'
        ? currentChat.value.config.customSourceIndex
        : (c?.activeIndex ?? 0)
      if (sources.length && !enabled.some(({ i }) => i === idx)) idx = enabled[0]?.i ?? c?.activeIndex ?? 0
      const src = sources[idx]
      list = (src && Array.isArray(src.available_models)) ? src.available_models.filter(Boolean) : []
      break
    }
    default:
      return []
  }

  // 已选模型不在列表时置顶补入：保证右上角「模型种类」始终能显示/保持当前聊天所选模型
  // （选中预设或切换来源后，即使该来源模型列表尚未拉取，下拉框也能跟随显示所选模型）
  const currentModel = currentChat.value.config.model
  if (currentModel && !list.includes(currentModel)) list = [currentModel, ...list]
  return list
})

/** 分支树节点接口 */
interface BranchTreeNode {
  chat: Chat
  index: number
  children: BranchTreeNode[]
  depth: number
}

/** 构建分支树 */
const branchTree = computed<BranchTreeNode[]>(() => {
  const chatList = chats.value
  const map = new Map<string, BranchTreeNode>()
  const roots: BranchTreeNode[] = []

  // 先创建所有节点
  chatList.forEach((chat, idx) => {
    map.set(chat.id, { chat, index: idx, children: [], depth: 0 })
  })

  // 建立父子关系
  chatList.forEach((chat) => {
    const node = map.get(chat.id)!
    if (chat.parentId && map.has(chat.parentId)) {
      const parent = map.get(chat.parentId)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  })

  return roots
})

/** 根聊天列表（过滤掉所有分支聊天，只显示无 parentId 的根聊天）
 * 可写：拖拽排序时按根聊天顺序重排 chats.value，每个根的分支聊天跟随其一起移动 */
const rootChats = computed<{ chat: Chat; originalIndex: number }[]>({
  get: () => {
    return chats.value
      .map((chat, idx) => ({ chat, originalIndex: idx }))
      .filter(item => !item.chat.parentId)
  },
  set: (newList) => {
    const byId = new Map(chats.value.map(c => [c.id, c]))
    // 收集根聊天及其全部后代分支（家族）
    const familyOf = (rootId: string): Chat[] => {
      const out: Chat[] = []
      const seen = new Set<string>()
      const collect = (id: string) => {
        if (seen.has(id)) return
        seen.add(id)
        const c = byId.get(id)
        if (!c) return
        out.push(c)
        chats.value.forEach(child => {
          if (child.parentId === id) collect(child.id)
        })
      }
      collect(rootId)
      return out
    }
    const reordered: Chat[] = []
    const placed = new Set<string>()
    for (const item of newList) {
      if (placed.has(item.chat.id)) continue
      for (const c of familyOf(item.chat.id)) {
        if (!placed.has(c.id)) {
          reordered.push(c)
          placed.add(c.id)
        }
      }
    }
    // 防御：追加未被覆盖的聊天（正常不应发生）
    chats.value.forEach(c => {
      if (!placed.has(c.id)) {
        reordered.push(c)
        placed.add(c.id)
      }
    })
    chats.value = reordered
    saveChats()
  }
})

/** 当前聊天所在分支家族是否有分支节点 */
const hasBranches = computed(() => currentBranchFamily.value.length > 1)

/** 检查指定聊天是否有子分支 */
const chatHasBranches = (chatId: string): boolean => {
  const findInTree = (nodes: BranchTreeNode[]): boolean => {
    for (const node of nodes) {
      if (node.chat.id === chatId) {
        return node.children.length > 0
      }
      if (findInTree(node.children)) return true
    }
    return false
  }
  return findInTree(branchTree.value)
}

/** 当前聊天的根祖先在 chats 中的索引（用于侧边栏高亮） */
const activeRootIndex = computed(() => {
  const currentId = currentChat.value.id
  const chatMap = new Map(chats.value.map(c => [c.id, c]))
  let chat = chatMap.get(currentId)
  if (!chat) return currentChatIndex.value
  while (chat.parentId && chatMap.has(chat.parentId)) {
    chat = chatMap.get(chat.parentId)!
  }
  return chats.value.findIndex(c => c.id === chat.id)
})

/** 当前聊天所在分支家族树（先序遍历扁平列表） */
const currentBranchFamily = computed<BranchTreeNode[]>(() => {
  const currentId = currentChat.value.id
  const chatMap = new Map(chats.value.map(c => [c.id, c]))

  // 找到当前聊天的根祖先
  let root = chatMap.get(currentId)
  if (!root) return []

  while (root.parentId && chatMap.has(root.parentId)) {
    root = chatMap.get(root.parentId)!
  }
  const rootId = root.id

  // 从 branchTree 中找到根节点，提取其完整子树
  const findRootInTree = (nodes: BranchTreeNode[]): BranchTreeNode | null => {
    for (const node of nodes) {
      if (node.chat.id === rootId) return node
      const found = findRootInTree(node.children)
      if (found) return found
    }
    return null
  }

  const rootNode = findRootInTree(branchTree.value)
  if (!rootNode) return []

  // 先序遍历收集子树节点
  const result: BranchTreeNode[] = []
  const traverse = (node: BranchTreeNode) => {
    result.push(node)
    for (const child of node.children) {
      traverse(child)
    }
  }
  traverse(rootNode)
  return result
})

const chatHeaderRef = ref<HTMLElement | null>(null)
const d3TreeContainer = ref<HTMLElement | null>(null)

// ==================== 辅助函数 ====================

// 判断是否应该显示后台执行指示器
const shouldShowBackgroundExecution = (chat: Chat, index: number) => {
  return globalExecutionState.value.isExecuting && 
         globalExecutionState.value.chatId === chat.id && 
         currentChatIndex.value !== index
}

// 该聊天是否正在执行：普通生成（isGenerating）或**集群运行**（swarmRunning 且本次运行属于该对话）。
// 用于聊天列表项的转圈图标 / 脉冲边框（与智能体运行时一致）。
const isChatRunning = (chat: Chat): boolean => {
  if (!chat) return false
  if (chat.isGenerating) return true
  return chat.mode === 'swarm' && swarmRunning.value && swarmRunChatId.value === chat.id
}

// 聊天列表项运行图标的悬停说明
const chatRunningTitle = (chat: Chat): string => {
  const zh = store.locales == 'zh'
  if (chat.mode === 'swarm' && swarmRunning.value && swarmRunChatId.value === chat.id) {
    return zh ? '集群运行中...' : 'Swarm running...'
  }
  if (chat.isGenerating) return zh ? '正在生成中...' : 'Generating...'
  return zh ? '后台执行中...' : 'Running in background...'
}

// 合并重复标签
const mergeDuplicateLabels = (blocks: RelevantBlock[]): Array<{label: string, contents: string[], similarity: number}> => {
  const mergedMap = new Map<string, {contents: string[], maxSimilarity: number}>()
  
  blocks.forEach(block => {
    if (!mergedMap.has(block.label)) {
      mergedMap.set(block.label, {
        contents: block.content ? [block.content] : [],
        maxSimilarity: block.similarity
      })
    } else {
      const existing = mergedMap.get(block.label)!
      if (block.content && block.content.trim()) {
        if (!existing.contents.includes(block.content)) {
          existing.contents.push(block.content)
        }
      }
      if (block.similarity > existing.maxSimilarity) {
        existing.maxSimilarity = block.similarity
      }
    }
  })
  
  return Array.from(mergedMap.entries()).map(([label, data]) => ({
    label,
    contents: data.contents,
    similarity: data.maxSimilarity
  }))
}

// 图片处理相关函数
const getImageSrc = (imageData: string | Uint8Array | ArrayBuffer): string => {
  if (typeof imageData === 'string') {
    if (imageData.startsWith('data:')) {
      return imageData
    }
    return `data:image/jpeg;base64,${imageData}`
  } else if (imageData instanceof Uint8Array || imageData instanceof ArrayBuffer) {
    const bytes = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData)
    const binary = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '')
    const base64 = btoa(binary)
    return `data:image/jpeg;base64,${base64}`
  }
  return ''
}

const getImageName = (item: UploadItem): string => {
  return item.name || `file_${Date.now()}`
}

// 获取知识库按钮标题
const getKbButtonTitle = (): string => {
  if (currentChat.value.mode !== 'retrieval') {
    return store.locales=='zh' ? '点击切换到知识库模式' : 'Click to switch to retrieval mode'
  }
  // 浏览器模式：知识库退化为上传文件 / 共享 .kb
  if (isBrowser) {
    const shared = currentChat.value.config.sharedKb
    if (shared?.name) {
      return store.locales=='zh' ? `共享知识库：${shared.name}（点击切换/管理）` : `Shared KB: ${shared.name} (click to manage)`
    }
    const files = currentChat.value.config.kbFiles || []
    if (files.length === 0) {
      return store.locales=='zh' ? '选择主机共享知识库或上传文件（浏览器模式）' : 'Pick shared KB or upload files (browser mode)'
    }
    return store.locales=='zh' ? `已关联 ${files.length} 个文件（点击上传更多/管理）` : `${files.length} files linked (click to manage)`
  }
  const kbPath = currentChat.value.config.kbPath
  if (!kbPath) {
    return store.locales=='zh' ? '选择知识库文件' : 'Select knowledge base file'
  }
  
  const fileName = kbPath.split(/[\\/]/).pop() || kbPath
  return store.locales=='zh' ? `已关联: ${fileName}` : `Linked: ${fileName}`
}

// 获取工作流按钮标题
const getWorkflowButtonTitle = (): string => {
  if (currentChat.value.mode !== 'workflow') {
    return store.locales=='zh' ? '点击切换到工作流模式' : 'Click to switch to workflow mode'
  }
  
  const workflowPath = currentChat.value.config.workflowPath
  if (!workflowPath) {
    return store.locales=='zh' ? '选择工作流文件' : 'Select workflow file'
  }
  
  const fileName = workflowPath.split(/[\\/]/).pop() || workflowPath
  let title = store.locales=='zh' ? `工作流: ${fileName}` : `Workflow: ${fileName}`
  
  if (isExecuting.value && currentExecutionType.value === 'workflow') {
    title += store.locales=='zh' ? ' (运行中)' : ' (Running)'
  } else if (workflowError.value) {
    title += store.locales=='zh' ? ' (有错误)' : ' (Error)'
  }
  
  return title
}

// Agent 预设模式标签标题（合并后的「智能体」入口：通用智能体 或 指定预设）
const getAgentButtonTitle = (): string => {
  if (currentChat.value.config.presetId) {
    const preset = store.agentPresets.find((c: any) => c.id === currentChat.value.config.presetId)
    const name = preset?.name || ''
    return store.locales=='zh'
      ? `Agent 预设：${name}（点击切换）`
      : `Agent preset: ${name} (click to switch)`
  }
  return store.locales=='zh' ? '通用智能体（点击切换预设）' : 'General agent (click to switch preset)'
}

// 获取输入框占位符
const getInputPlaceholder = (): string => {
  // 运行中引导：智能体/集群执行期间输入框可用，Enter 即投递引导（下一个 step 生效）
  if (canSteerRun.value) {
    return store.locales == 'zh'
      ? '智能体运行中：输入要求可引导它（下一轮带上，Enter发送引导）'
      : 'Agent is running: type to guide it (applied next round, Enter to send guidance)'
  }
  switch (currentChat.value.mode) {
    case 'skill':
      return store.locales == 'zh' 
        ? '输入需求，AI将自动使用技能... (Enter发送，Shift+Enter换行)'
        : 'Enter your request, AI will use skills automatically... (Enter to send, Shift+Enter for new line)';
    case 'agent':
      return store.locales == 'zh'
        ? (currentChat.value.config.presetId ? '以 Agent 预设角色对话... (Enter发送，Shift+Enter换行)' : '以通用智能体自主执行任务... (Enter发送，Shift+Enter换行)')
        : (currentChat.value.config.presetId ? 'Chat as the Agent preset role... (Enter to send, Shift+Enter for new line)' : 'Chat with the general agent... (Enter to send, Shift+Enter for new line)');
    case 'agent2':
      return store.locales == 'zh'
        ? '以通用智能体自主执行任务... (Enter发送，Shift+Enter换行)'
        : 'Chat with the general agent... (Enter to send, Shift+Enter for new line)';
    case 'swarm':
      return store.locales == 'zh'
        ? '向集群派发任务，@成员名可点名... (Enter发送，Shift+Enter换行)'
        : 'Dispatch a task to the swarm; @member to name one... (Enter to send, Shift+Enter for new line)';
    case 'code':
      return store.locales == 'zh'
        ? '描述需求，AI 将写程序调用工具完成... (Enter发送，Shift+Enter换行)'
        : 'Describe the task; the AI writes a program calling tools... (Enter to send, Shift+Enter for new line)';
    case 'workflow':
    case 'retrieval':
      return store.locales == 'zh'
        ? '输入问题，将检索知识库后回答... (Enter发送，Shift+Enter换行)'
        : 'Enter question, will retrieve from knowledge base... (Enter to send, Shift+Enter for new line)';
    default:
      if (currentUploads.value.length > 0) {
        return store.locales == 'zh'
          ? '输入描述... (Enter发送，Shift+Enter换行)'
          : 'Enter description... (Enter to send, Shift+Enter for new line)';
      }
      return store.locales == 'zh'
        ? '输入消息... (Enter发送，Shift+Enter换行)'
        : 'Enter message... (Enter to send, Shift+Enter for new line)';
  }
}

// 获取发送按钮标题
const getSendButtonTitle = (): string => {
  if (skillLoading.value) {
    return 'Skill executing...'
  }
  // 运行中引导：发送按钮变成「发送引导」
  if (canSteerRun.value) {
    return store.locales == 'zh'
      ? '发送引导（智能体下一轮采用，不打断当前执行）(Enter)'
      : 'Send guidance (agent adopts it next round, run continues) (Enter)'
  }
  if (isExecuting.value) {
    // 推理/执行中：输入框可打字起草，但发送需等本次推理结束（按钮禁用 + sendMessage 拦截）
    return store.locales == 'zh'
      ? '推理中… 完成后可发送'
      : 'Reasoning… send after it finishes'
  }
  switch (currentChat.value.mode) {
    case 'swarm':
      return store.locales == 'zh' ? '派发集群任务 (Enter)' : 'Dispatch swarm task (Enter)'
    case 'skill':
    case 'agent2':
    case 'agent':
    case 'code':
      return store.locales == 'zh' ? '执行智能体任务 (Enter)' : 'Run Agent task (Enter)'
    case 'workflow':
      return 'Run workflow (Enter)'
    case 'retrieval':
      return '检索并回答 (Enter)'
    default:
      if (currentUploads.value.length > 0) {
        return store.locales == 'zh' ? '发送消息 (Enter)' : 'Send message (Enter)'
      }
      return store.locales == 'zh' ? '发送 (Enter)' : 'Send (Enter)'
  }
}

// Markdown 渲染函数（md 实例与渲染辅助已抽到 src/lib/markdown/render.ts）
ensureMermaidInit()

/** 将渲染好的 SVG 挂到 mermaid wrapper（替换隐藏源码，绑定点击放大） */
const mountSvgIntoWrapper = (wrapper: HTMLElement, rawText: string, hash: string, svgString: string) => {
  wrapper.innerHTML = ''
  const svgContainer = document.createElement('div')
  svgContainer.className = 'mermaid-rendered-svg mermaid-clickable'
  svgContainer.setAttribute('data-mermaid-hash', hash)
  svgContainer.setAttribute('data-mermaid-src', rawText)
  svgContainer.innerHTML = svgString
  svgContainer.addEventListener('click', (e) => {
    e.stopPropagation()
    openMermaidModal(rawText)
  })
  wrapper.appendChild(svgContainer)
}

/**
 * 判断某 mermaid wrapper 是否为「仍在生成的活动尾部」：
 * - 属于当前聊天最后一条消息，且当前聊天正在生成/执行；
 * - 并且是该消息内容区里最后一个有效节点（代码围栏可能还未闭合、图块仍在增长）。
 * 活动尾部的源码还在变，现在渲染会得到残缺图或反复重渲染，故等它不再是尾部
 * （模型继续写后面内容）或生成结束（force）后再渲染。
 */
const isLiveStreamingTail = (wrapper: HTMLElement): boolean => {
  const contentEl = wrapper.parentElement
  const container = messageContainer.value
  if (!contentEl || !container) return false
  const msgItem = contentEl.closest('.message-item')
  if (!msgItem) return false
  const items = container.querySelectorAll<HTMLElement>('.message-item')
  if (!items.length || items[items.length - 1] !== msgItem) return false
  if (!currentChat.value?.isGenerating && !isExecuting.value) return false
  const children = Array.from(contentEl.childNodes)
  for (let i = children.length - 1; i >= 0; i--) {
    const n = children[i]
    if (n.nodeType === Node.ELEMENT_NODE) return n === wrapper
    if (n.nodeType === Node.TEXT_NODE && n.textContent && n.textContent.trim()) return false
  }
  return true
}

/**
 * 同步恢复已缓存的 SVG：v-html 每次内容更新会重建整条消息 DOM（已渲染的图被清空），
 * 这里在每次 DOM 更新后立即把缓存里的图放回去——不重新解析，也没有空窗闪烁。
 * 返回是否发现「已定型但尚未渲染」的块（需要调度异步渲染）。
 */
const mountCachedMermaid = (): boolean => {
  const container = messageContainer.value
  if (!container) return false
  const wrappers = Array.from(container.querySelectorAll<HTMLElement>('.message-content .mermaid-wrapper'))
  if (!wrappers.length) return false
  let needsWork = false
  for (const wrapper of wrappers) {
    const srcEl = wrapper.querySelector<HTMLElement>('.mermaid-src')
    if (!srcEl) continue
    const rawText = srcEl.textContent?.trim() ?? ''
    if (!rawText) continue
    if (wrapper.querySelector('.mermaid-rendered-svg')) continue // 已恢复/已冻结
    if (wrapper.dataset.mermaidFailed) continue
    const normalizedText = normalizeMermaidSource(rawText)
    // 已确认无法渲染：显示源码兜底，不再反复尝试
    if (mermaidFailedCache.has(normalizedText)) {
      wrapper.innerHTML = `<pre class="mermaid-fallback">${md.utils.escapeHtml(rawText)}</pre>`
      continue
    }
    const svg = getCachedSvgLenient(rawText)
    if (!svg) {
      // 仍在增长的活动尾部：先不处理
      if (isLiveStreamingTail(wrapper)) continue
      // 已定型但尚未渲染：需要触发异步渲染
      needsWork = true
      // 异步渲染期间显示「渲染中」占位符，避免切换聊天/初次进入时图表突然出现
      if (!wrapper.querySelector('.mermaid-rendering')) {
        const ph = document.createElement('div')
        ph.className = 'mermaid-rendering'
        ph.innerHTML = `<i class="fa fa-circle-o-notch fa-spin"></i><span>${store.locales == 'zh' ? '正在渲染 Mermaid 图…' : 'Rendering diagram…'}</span>`
        wrapper.appendChild(ph)
      }
      continue
    }
    mountSvgIntoWrapper(wrapper, rawText, hashContent(rawText), svg)
  }
  return needsWork
}

/** DOM 每次更新后调用：恢复缓存图 + 有需要时调度工作拍 */
const refreshRenderedMermaid = () => {
  if (mountCachedMermaid()) {
    scheduleMermaidRender(false, 120)
  }
}

// 任何组件重渲染（消息正文/内容单元流式追加都会触发）后立即恢复缓存图，消除闪烁
onUpdated(() => {
  refreshRenderedMermaid()
})

/**
 * Mermaid 工作拍（节流触发）：只渲染「已定型」的图，完成后按源码哈希缓存。
 * - 已渲染过的块（wrapper 内已有 svg / 缓存命中）直接跳过 → 不会重复渲染该部分；
 * - 还在增长的活动尾部先跳过，等它定型后由后续工作拍渲染；
 * - force 用于生成结束/切换消息等兜底（把活动尾部也一并渲染）。
 */
const renderMermaidDiagrams = async (force = false) => {
  const messageContainerEl = messageContainer.value
  if (!messageContainerEl) return

  const wrappers = Array.from(messageContainerEl.querySelectorAll<HTMLElement>('.message-content .mermaid-wrapper'))
  if (!wrappers.length) return

  for (const wrapper of wrappers) {
    if (!wrapper.isConnected) continue
    const srcEl = wrapper.querySelector<HTMLElement>('.mermaid-src')
    if (!srcEl) continue

    const rawText = srcEl.textContent?.trim() ?? ''
    if (!rawText) continue
    const hash = wrapper.getAttribute('data-mermaid-hash') || hashContent(rawText)

    // 已有渲染结果 → 冻结，不再处理
    if (wrapper.querySelector('.mermaid-rendered-svg')) continue
    // 已确认失败 → 不再反复尝试
    if (wrapper.dataset.mermaidFailed) continue

    // 缓存命中：直接恢复（无需解析）
    const normalizedText = normalizeMermaidSource(rawText)
    // 已确认无法渲染：直接显示源码兜底，不再反复解析
    if (mermaidFailedCache.has(normalizedText)) {
      wrapper.innerHTML = `<pre class="mermaid-fallback">${md.utils.escapeHtml(rawText)}</pre>`
      continue
    }
    const cachedSvg = getCachedSvgLenient(rawText)
    if (cachedSvg) {
      mountSvgIntoWrapper(wrapper, rawText, hash, cachedSvg)
      continue
    }

    // 仍在生成的活动尾部：等它定型（force 用于生成结束/切换时的兜底渲染）
    if (!force && isLiveStreamingTail(wrapper)) continue

    if (mermaidInflight.has(hash)) continue
    mermaidInflight.add(hash)
    try {
      const svgString = await renderMermaidSvgLenient(rawText)
      if (!wrapper.isConnected) continue
      mountSvgIntoWrapper(wrapper, rawText, hash, svgString)
    } catch (error) {
      console.error('Mermaid render failed:', error)
      if (!wrapper.isConnected) continue
      // 生成中仍可能增长的尾部不显示报错占位（避免闪烁）；否则显示源码兜底并记录失败，避免反复重试
      if (force || !isLiveStreamingTail(wrapper)) {
        mermaidFailedCache.add(normalizedText)
        wrapper.dataset.mermaidFailed = '1'
        wrapper.innerHTML = `<pre class="mermaid-fallback">${md.utils.escapeHtml(rawText)}</pre>`
      }
    } finally {
      mermaidInflight.delete(hash)
    }
  }
}

// 处理鼠标滚轮事件
const handleWheel = (event: WheelEvent) => {
  if (!messageContainer.value) return
  
  const container = messageContainer.value
  const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 10
  
  if (event.deltaY < 0 && !isAtBottom) {
    autoScrollEnabled.value = false
    isUserScrolling.value = true
    
    if (scrollTimeout.value) {
      clearTimeout(scrollTimeout.value)
    }
    scrollTimeout.value = setTimeout(() => {
      autoScrollEnabled.value = true
      isUserScrolling.value = false
    }, 30000)
  }
  
  if (isAtBottom) {
    autoScrollEnabled.value = true
    isUserScrolling.value = false
    if (scrollTimeout.value) {
      clearTimeout(scrollTimeout.value)
      scrollTimeout.value = null
    }
  }
}

// 处理滚动事件
const handleScroll = () => {
  if (!messageContainer.value) return
  
  const container = messageContainer.value
  const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 10
  
  if (isAtBottom) {
    autoScrollEnabled.value = true
    isUserScrolling.value = false
    if (scrollTimeout.value) {
      clearTimeout(scrollTimeout.value)
      scrollTimeout.value = null
    }
  }
}

// 自动滚动到底部（低频调用：切换消息/发送等）
const scrollToBottom = () => {
  if (!messageContainer.value || !autoScrollEnabled.value) return
  
  nextTick(() => {
    const container = messageContainer.value
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      })
    }
  })
}

// 流式高频滚动：rAF 合并（同一帧只滚一次），直接赋值避免 smooth 动画排队导致的迟钝
let autoScrollRaf = 0
const scheduleAutoScroll = () => {
  if (autoScrollRaf) return
  autoScrollRaf = requestAnimationFrame(() => {
    autoScrollRaf = 0
    const container = messageContainer.value
    if (container && autoScrollEnabled.value) {
      container.scrollTop = container.scrollHeight
    }
  })
}

// 流式渲染节流：保持 markdown 渲染（代码高亮/格式可见），但把频率限制到每 ~30ms 一次，
// 避免每个 chunk 都全量重渲染大消息导致的卡顿
let streamRenderTimer: ReturnType<typeof setTimeout> | null = null
let streamRenderFlush: (() => void) | null = null
const scheduleStreamRender = (flush: () => void) => {
  streamRenderFlush = flush
  if (streamRenderTimer !== null) return
  streamRenderTimer = setTimeout(() => {
    streamRenderTimer = null
    const fn = streamRenderFlush
    streamRenderFlush = null
    fn?.()
  }, 30)
}
const flushStreamRender = () => {
  if (streamRenderTimer !== null) {
    clearTimeout(streamRenderTimer)
    streamRenderTimer = null
  }
  const fn = streamRenderFlush
  streamRenderFlush = null
  fn?.()
}

// 处理头部滚轮事件
const handleHeaderWheel = (event: WheelEvent) => {
  const header = chatHeaderRef.value
  if (header) {
    header.scrollLeft += event.deltaY
    event.preventDefault()
  }
}

// ==================== D3 树状图渲染 ====================

const renderD3Tree = () => {
  const container = d3TreeContainer.value
  if (!container) return

  const family = currentBranchFamily.value
  if (!family.length) return

  const rootNode = family[0]

  // 清空容器
  container.innerHTML = ''

  // 使用 getBoundingClientRect 获取精确尺寸
  const rect = container.getBoundingClientRect()
  const width = Math.max(rect.width || 240, 240)
  const height = Math.max(rect.height || 400, 100)
  const isZh = store.locales == 'zh'

  // 创建 SVG（不设 CSS 宽高，由属性控制）
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .style('display', 'block')

  const g = svg.append('g')

  // 缩放行为
  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform)
    })

  svg.call(zoom)

  // 构建层级结构
  const root = d3.hierarchy(rootNode, d => d.children)
  const treeLayout = d3.tree<typeof rootNode>()
    .nodeSize([60, 80])

  const treeData = treeLayout(root)

  // 计算边界
  let x0 = Infinity, x1 = -Infinity
  let y0 = Infinity, y1 = -Infinity
  treeData.descendants().forEach(d => {
    if (d.x < x0) x0 = d.x
    if (d.x > x1) x1 = d.x
    if (d.y < y0) y0 = d.y
    if (d.y > y1) y1 = d.y
  })

  // 居中（横向 + 纵向）
  const treeWidth = x1 - x0 + 120
  const treeHeight = y1 - y0 + 80
  const scale = Math.min(width / treeWidth, height / treeHeight, 1.8)
  const tx = (width - (x0 + x1) * scale) / 2
  const ty = (height - (y0 + y1) * scale) / 2

  const initialTransform = d3.zoomIdentity.translate(tx, ty).scale(scale)
  svg.call(zoom.transform, initialTransform)

  // 绘制连接线
  g.selectAll('.link')
    .data(treeData.links())
    .enter()
    .append('path')
    .attr('fill', 'none')
    .attr('stroke', 'var(--borderColor)')
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', 0.5)
    .attr('d', d3.linkVertical<any, any>()
      .x(d => d.x)
      .y(d => d.y)
    )

  // 绘制节点
  const node = g.selectAll('.node')
    .data(treeData.descendants())
    .enter()
    .append('g')
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .style('cursor', 'pointer')
    .on('click', (_event, d) => {
      switchToBranchChat({ chat: d.data.chat, index: d.data.index, children: [] as any, depth: d.data.depth })
      // 点击后重绘以更新高亮
      renderD3Tree()
    })
    .on('contextmenu', (event, d) => {
      event.preventDefault()
      event.stopPropagation()
      showBranchContextMenu(event.clientX, event.clientY, d)
    })

  // 圆形节点
  node.append('circle')
    .attr('r', d => d.data.index === currentChatIndex.value ? 15 : 13)
    .attr('fill', d => d.data.index === currentChatIndex.value
      ? 'var(--menuActiveColor)'
      : 'var(--backgroundColor)')
    .attr('stroke', d => d.data.index === currentChatIndex.value
      ? 'var(--fontActiveColor)'
      : 'var(--borderColor)')
    .attr('stroke-width', d => d.data.index === currentChatIndex.value ? 2.5 : 1.5)

  // 根节点装饰圆点
  node.append('circle')
    .attr('r', 3)
    .attr('fill', d => d.depth === 0 ? 'var(--fontActiveColor)' : 'transparent')
    .attr('stroke', 'none')

  // 可选的标题文字（由 showBranchTitles 控制）
  if (showBranchTitles.value) {
    node.append('text')
      .attr('text-anchor', 'middle')
      .attr('dy', 22)
      .attr('fill', 'var(--fontColor)')
      .attr('font-size', '9px')
      .text(d => {
        const title = d.data.chat.title || d.data.chat.branchLabel || `Chat ${d.data.index + 1}`
        return title.length > 10 ? title.substring(0, 9) + '...' : title
      })
  }

  // 鼠标悬浮提示（标题 + 消息数，始终显示）
  node.append('title')
    .text(d => {
      const title = d.data.chat.title || d.data.chat.branchLabel || `Chat ${d.data.index + 1}`
      return `${title}\n${d.data.chat.messages.length} ${isZh ? '条消息' : 'messages'}`
    })
}

// D3 树渲染 watcher
watch(showBranchView, (newVal) => {
  if (newVal) {
    nextTick(() => {
      // 等两帧，让面板动画完成、布局稳定后再渲染
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          renderD3Tree()
        })
      })
    })
  }
})

watch(currentBranchFamily, () => {
  if (showBranchView.value) {
    nextTick(() => renderD3Tree())
  }
}, { deep: true })

// 标题变更时重绘
watch(() => currentChat.value.title, () => {
  if (showBranchView.value) {
    renderD3Tree()
  }
})

// 设置连接测试状态
// 连接测试状态与模型管理已抽到 src/composables/useChatModels.ts（见文末接线）

// 格式化智能体模式消息的显示内容：翻译工具标记、隐藏闭合标记
/** 工具名称 → Font Awesome 图标映射 */
const toolIcons: Record<string, string> = {
  'read_file': 'fa-file-text-o',
  'write_file': 'fa-pencil-square-o',
  'replace_in_file': 'fa-eraser',
  'multi_replace': 'fa-files-o',
  'list_dir': 'fa-folder-open-o',
  'search_files': 'fa-search',
  'web_search': 'fa-search',
  'web_fetch': 'fa-globe',
  'server-search': 'fa-globe',
  'server-search-query': 'fa-search',
  'server-search-visit': 'fa-external-link',
  'run_code': 'fa-file-code-o',
  'run_python': 'fa-code',
  'shell': 'fa-terminal',
  'kb_search': 'fa-book',
  'skill': 'fa-cubes',
  'run_subagent': 'fa-sitemap',
  'export_word': 'fa-file-word-o',
  'update_plan': 'fa-tasks',
  'update_todo': 'fa-list-ol',
  'ask_user': 'fa-question-circle',
  'mcp_call': 'fa-plug',
  'reasoning': 'fa-lightbulb-o'
}

/** 工具名称 → 中文/英文标签映射 */
const getToolLabel = (name: string): string => {
  const isZh = store.locales == 'zh'
  const labels: Record<string, string> = {
    'read_file': isZh ? '读取文件' : 'Read File',
    'write_file': isZh ? '写入文件' : 'Write File',
    'replace_in_file': isZh ? '替换片段' : 'Replace In File',
    'multi_replace': isZh ? '多处替换' : 'Multi Replace',
    'list_dir': isZh ? '列出目录' : 'List Directory',
    'search_files': isZh ? '搜索文件' : 'Search Files',
    'web_search': isZh ? '搜索' : 'Search',
    'web_fetch': isZh ? '获取网页' : 'Fetch Web',
    'server-search': isZh ? '服务端搜索' : 'Server Search',
    'server-search-query': isZh ? '搜索' : 'Search',
    'server-search-visit': isZh ? '访问网站' : 'Visited',
    'run_code': isZh ? '程序化调用' : 'Run Code',
    'run_python': isZh ? '执行Python' : 'Run Python',
    'shell': isZh ? '执行Shell' : 'Run Shell',
    'kb_search': isZh ? '知识库检索' : 'Knowledge Search',
    'skill': isZh ? '技能' : 'Skill',
    'run_subagent': isZh ? '子智能体' : 'Subagent',
    'export_word': isZh ? '导出 Word' : 'Export Word',
    'update_plan': isZh ? '更新计划' : 'Update Plan',
    'update_todo': isZh ? '任务清单' : 'Todo',
    'ask_user': isZh ? '询问用户' : 'Ask User',
    'mcp_call': isZh ? 'MCP工具' : 'MCP Tool',
    'reasoning': isZh ? '思考' : 'Reasoning'
  }
  return labels[name] || name
}

/** 生成工具徽章 HTML */
const makeToolBadge = (toolName: string): string => {
  const icon = toolIcons[toolName] || 'fa-cog'
  const label = getToolLabel(toolName)
  return `<span class="tool-badge"><i class="fa ${icon}"></i> ${label}</span>`
}

// 格式化技能模式消息的显示内容
const formatToolDisplay = (content: string): string => {
  if (!content) return content
  // 将字面量 \n（反斜杠+n）替换为实际换行，修复 LLM 输出转义换行符的问题
  return content.replace(/\\n/g, '\n')
}

// 反转义 JSON 字符串的部分片段（不要求闭合引号，容忍流式截断）
const unescapePartialJsonString = (s: string): string => {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '\\') { out += ch; continue }
    const next = s[i + 1]
    if (next === 'n') { out += '\n'; i++ }
    else if (next === 't') { out += '\t'; i++ }
    else if (next === 'r') { out += '\r'; i++ }
    else if (next === '"') { out += '"'; i++ }
    else if (next === '\\') { out += '\\'; i++ }
    else if (next === '/') { out += '/'; i++ }
    else if (next === 'u') {
      const hex = s.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5 }
      else out += ch
    } else { out += ch }
  }
  return out
}

// 从流式累积/未闭合的 JSON 参数中提取某个字符串字段的值（run_python→code、write_file→content、
// update_plan→plan 等；未闭合时从原文按 key 提取并容错反转义；未找到返回 ''）
const extractStreamedJsonField = (raw: string, key: string): string => {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj[key] === 'string') return obj[key]
  } catch { /* 未闭合，走部分提取 */ }
  // 搜索 key 出现的任意位置（write_file 的 path 在前、content 在后，不能用「开头即 key」的匹配）
  const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*)$`))
  if (!m) return ''
  const rest = m[1]
  // 找到未转义的闭合引号（偶数个反斜杠前缀）
  let end = -1
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '"') continue
    let bs = 0
    let j = i - 1
    while (j >= 0 && rest[j] === '\\') { bs++; j-- }
    if (bs % 2 === 0) { end = i; break }
  }
  const content = end === -1 ? rest : rest.slice(0, end)
  return unescapePartialJsonString(content)
}

/** 提取 run_python 参数中的代码（已解析对象或流式未闭合 JSON 均支持） */
const getRunPythonCode = (unit: any): string => {
  const args = unit.args
  if (!args) return ''
  if (typeof args === 'string') return extractStreamedJsonField(args, 'code')
  return typeof args?.code === 'string' ? args.code : ''
}

/** 提取 run_code 参数中的程序代码（已解析对象或流式未闭合 JSON 均支持） */
const getRunCodeProgram = (unit: any): string => {
  const args = unit?.args
  if (!args) return ''
  if (typeof args === 'string') return extractStreamedJsonField(args, 'code')
  return typeof args?.code === 'string' ? args.code : ''
}

/** run_code 单元 → PTC 执行输出（未完成时为 null） */
const ptcOutputOf = (unit: any): PtcRunOutput | null => {
  const raw = unit?.result !== undefined && unit?.result !== null ? unit.result : unit?.resultPreview
  return extractPtcRunOutput(raw)
}
/** 程序内 console 日志 */
const ptcLogs = (unit: any): PtcRunOutput['logs'] => ptcOutputOf(unit)?.logs || []
/** 程序内实际调用的工具（入参优先取 preview：模型可见值里已不再包含入参） */
const ptcInternalTools = (unit: any): Array<{ name: string; ok: boolean; error?: string; inputText: string }> => {
  const p = unit?.preview
  const calls: any[] = (p && p.kind === 'ptc-run' && Array.isArray(p.toolCalls))
    ? p.toolCalls
    : (ptcOutputOf(unit)?.toolCalls || [])
  return calls.map((tc: any) => ({
    name: tc.name,
    ok: tc.ok !== false,
    error: tc.error,
    inputText: (() => {
      try {
        const s = JSON.stringify(tc.input)
        return s && s.length > 140 ? s.slice(0, 140) + '…' : (s || '')
      } catch { return String(tc.input) }
    })(),
  }))
}/** run_code 返回值文本 */
const ptcResultText = (unit: any): string => formatPtcValue(ptcOutputOf(unit)?.result)

/** 提取 write_file 要写入的内容（已解析对象或流式未闭合 JSON 均支持） */const getWriteFileContent = (unit: any): string => {
  const args = unit.args
  if (!args) return ''
  if (typeof args === 'string') return extractStreamedJsonField(args, 'content')
  return typeof args?.content === 'string' ? args.content : ''
}

/** 提取 write_file 目标路径（流式未闭合 JSON 时尽力从原文提取） */
const getWriteFilePath = (unit: any): string => {
  const args = unit.args
  if (!args) return ''
  if (typeof args === 'string') {
    const m = args.match(/"path"\s*:\s*"([^"]*)"/)
    return m ? m[1] : ''
  }
  return typeof args?.path === 'string' ? args.path : ''
}

/** 工具卡片「打开」按钮：写入 / 改写的是本地网页（.html / .htm）时给出路径，否则返回 '' */
const openableWebPagePath = (unit: any): string => {
  const n = String(unit?.description || '')
  if (n !== 'write_file' && n !== 'replace_in_file' && n !== 'multi_replace') return ''
  if (unit?.status && unit.status !== 'success') return ''
  const p = getWriteFilePath(unit)
  if (!p) return ''
  const low = p.split('?')[0].toLowerCase()
  return (low.endsWith('.html') || low.endsWith('.htm')) ? p : ''
}

/** 工具给的是相对路径时，按工作区根目录补成绝对路径（内置浏览器只接受绝对路径） */
const toAbsoluteToolPath = (p: string): string => {
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p
  const root = (store.roots && store.roots[0]) || store.root || ''
  if (!root) return p
  return `${String(root).replace(/[\\/]+$/, '')}/${p.replace(/^[\\/]+/, '')}`
}

/** 用内置浏览器打开工具写入的网页（与知识管理里双击 html 的行为一致） */
const openWebPageInBrowser = async (unit: any) => {
  const p = openableWebPagePath(unit)
  if (!p) return
  if (!window.ipcRenderer) {
    ElMessage.warning(store.locales == 'zh' ? '浏览器模式下无法打开本地文件' : 'Cannot open local files in browser mode')
    return
  }
  try {
    const r = await window.ipcRenderer.invoke('browser-agent:open-file', { path: toAbsoluteToolPath(p) })
    if (r && r.ok === false) throw new Error(r.error || '打开失败')
  } catch (e: any) {
    ElMessage.error(store.locales == 'zh' ? `打开失败：${e?.message || e}` : `Open failed: ${e?.message || e}`)
  }
}

/** 根据 write_file 目标路径的扩展名推断代码语言（highlight.js） */
const getWriteFileLang = (unit: any): string => {
  const ext = getWriteFilePath(unit).toLowerCase().split('.').pop() || ''
  const langMap: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', dart: 'dart',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml',
    toml: 'ini', ini: 'ini', conf: 'ini',
    sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'bat', cmd: 'bat', ps1: 'powershell',
    sql: 'sql', xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte',
    txt: 'plaintext', text: 'plaintext', log: 'plaintext',
  }
  return langMap[ext] || 'plaintext'
}

// 生成带工具类型标题的盒子 HTML（技能模式展示运行的工具类型）
const makeToolBoxHtml = (name: string, inner: string): string => {
  const icon = toolIcons[name] || 'fa-cog'
  const label = getToolLabel(name)
  return `<div class="tool-box"><div class="tool-box-header"><i class="fa ${icon}"></i>${label}</div>${inner}</div>`
}

// 获取步骤图标
const getStepIcon = (): string => {
  if (skillLoading.value) return 'fa-spinner fa-spin'
  if (currentExecutionType.value === 'workflow') return 'fa-stumbleupon fa-spin'
  if (currentExecutionType.value === 'skill') return 'fa-cubes fa-spin'
  return 'fa-spinner fa-spin'
}

// 获取步骤描述
const getStepDescription = (): string => {
  if (skillLoading.value) {
    return currentStep.value || (store.locales == 'zh' ? '正在执行技能...' : 'Executing skill...')
  }
  if (currentExecutionType.value === 'workflow') {
    return currentStep.value || (store.locales == 'zh' ? '工作流执行中...' : 'Workflow running...')
  }
  if (currentExecutionType.value === 'skill') {
    return currentStep.value || (store.locales == 'zh' ? '技能执行中...' : 'Skill executing...')
  }
  return currentStep.value || (store.locales == 'zh' ? '执行中...' : 'Executing...')
}

// ==================== 文件/图片上传相关方法 ====================

const triggerFileUpload = () => {
  if (fileInput.value) {
    fileInput.value.click()
  }
}

/** 图片 MIME → 扩展名映射 */
const imageExtMap: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
}

/** 判断是否为可解析的文档扩展名 */
const isParseableFile = (fileName: string): boolean => {
  const ext = fileName.toLowerCase().split('.').pop()
  return ['md', 'docx', 'pdf', 'txt', 'html', 'htm', 'json', 'csv', 'js', 'py', 'xlsx', 'kb'].includes(ext || '')
}

const handleFileUpload = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const files = target.files
  
  if (!files || files.length === 0) return
  
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      
      // 图片处理
      if (file.type.startsWith('image/')) {
        if (file.size > 5 * 1024 * 1024) {
          ElMessage.warning(`图片 ${file.name} 大小超过5MB限制`)
          continue
        }
        const base64String = await AIUtils.imageToBase64(file)
        const ext = imageExtMap[file.type] || '.png'
        currentUploads.value.push({
          kind: 'image',
          data: base64String,
          name: file.name || `image${ext}`,
          size: file.size
        })
        continue
      }
      
      // 文档文件处理（Markdown / Word / PDF 等）
      if (isParseableFile(file.name)) {
        if (file.size > 20 * 1024 * 1024) {
          ElMessage.warning(`文件 ${file.name} 大小超过20MB限制`)
          continue
        }
        
        // 通过 Electron IPC 读取并解析文件
        let parsedContent = ''
        if (typeof window !== 'undefined' && (window as any).ipcRenderer) {
          parsedContent = await (window as any).ipcRenderer.invoke('readFile', file.path || file.name)
        } else {
          // 浏览器环境：尝试用 FileReader 读取文本文件
          const text = await file.text()
          parsedContent = text
        }
        
        if (typeof parsedContent === 'string' && parsedContent.startsWith('Error reading file:')) {
          ElMessage.error(`文件 ${file.name} 读取失败`)
          continue
        }
        
        const charCount = parsedContent.length
        currentUploads.value.push({
          kind: 'file',
          data: '',
          name: file.name,
          size: file.size,
          parsedContent: parsedContent,
          charCount: charCount
        })
      } else {
        ElMessage.warning(`不支持的文件类型: ${file.name}`)
        continue
      }
    }
    
    target.value = ''
    
    if (currentUploads.value.length > 0 && !inputText.value.trim()) {
      const textInput = document.querySelector('.message-input') as HTMLTextAreaElement
      if (textInput) {
        textInput.focus()
      }
    }
    
  } catch (error) {
    console.error('文件上传失败:', error)
    ElMessage.error('文件/图片上传失败，请重试')
  }
}

const removeUpload = (index: number) => {
  currentUploads.value.splice(index, 1)
}

const clearAllUploads = () => {
  currentUploads.value = []
}

/** 从 currentUploads 构建消息内容（文件内容前置）和图片数据 */
const buildUserMessageFromUploads = (message: string): {
  content: string
  images: Array<string | Uint8Array | ArrayBuffer> | undefined
  fileAttachments: Array<{ name: string; content: string; charCount: number }> | undefined
} => {
  const imageData: Array<string | Uint8Array | ArrayBuffer> = []
  const fileAttachments: Array<{ name: string; content: string; charCount: number }> = []

  for (const item of currentUploads.value) {
    if (item.kind === 'file' && item.parsedContent) {
      fileAttachments.push({
        name: item.name,
        content: item.parsedContent,
        charCount: item.charCount || item.parsedContent.length
      })
    } else if (item.kind === 'image') {
      imageData.push(item.data)
    }
  }

  return {
    content: message,
    images: imageData.length > 0 ? imageData : undefined,
    fileAttachments: fileAttachments.length > 0 ? fileAttachments : undefined
  }
}

const openImagePreview = (imageData: string | Uint8Array | ArrayBuffer) => {
  previewImageSrc.value = getImageSrc(imageData)
  previewImageData.value = imageData
  showImagePreview.value = true
}

const closeImagePreview = () => {
  showImagePreview.value = false
  previewImageSrc.value = ''
  previewImageData.value = ''
}

const downloadImage = (imageSrc: string) => {
  const link = document.createElement('a')
  link.href = imageSrc
  link.download = `image_${Date.now()}.png`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

const removeImageFromMessage = (messageIndex: number, imageIndex: number) => {
  const message = currentChat.value.messages[messageIndex]
  if (message.images) {
    message.images.splice(imageIndex, 1)
    if (message.images.length === 0) {
      delete message.images
    }
    saveChats()
  }
}

// ==================== 初始化 ====================

// 智能体运行状态周期对账（只在实际存在「执行中的智能体消息」时才真正扫描，空闲时零开销）：
// 事件触发式对账（挂载/切聊天/停止兜底）无法覆盖「主进程异常退出/异常停止后永远等不到 idle 事件」
// 的场景——没有周期兜底时，残留的执行中消息会让该聊天永久转圈且无法发送。
// 此 3s 定时器确保任何卡死的执行中消息最终被清理解锁（已生成记录保留）。
let agentReconcileTimer: ReturnType<typeof setInterval> | null = null
const stopAgentReconcileTimer = () => {
  if (agentReconcileTimer !== null) {
    clearInterval(agentReconcileTimer)
    agentReconcileTimer = null
  }
}
const startAgentReconcileTimer = () => {
  stopAgentReconcileTimer()
  agentReconcileTimer = setInterval(() => {
    // 快筛：执行中的智能体消息必然伴随 chat.isGenerating=true（启动与清理解锁成对出现），
    // 空闲时只做 O(聊天数) 的顶层判断，不深入消息数组，避免周期扫描拖慢大历史。
    const anyActive = (chats.value || []).some((c: any) => c && c.isGenerating === true)
    if (anyActive) reconcileAgentRuns()
  }, 3000)
}

onMounted(async () => {
  // 初次渲染后立即恢复/渲染已有消息里的 mermaid 图
  void nextTick(() => refreshRenderedMermaid())
  // 空聊天输入区居中：按消息区高度算位移（窗口缩放 / 输入框高度变化时由 ResizeObserver 重算）
  updateComposerShift()
  if (typeof ResizeObserver !== 'undefined') {
    composerResizeObserver = new ResizeObserver(() => updateComposerShift())
    const mainEl = messageContainer.value?.parentElement
    if (mainEl) composerResizeObserver.observe(mainEl)
    const inputEl = document.querySelector('.input-area') as HTMLElement | null
    if (inputEl) composerResizeObserver.observe(inputEl)
  }
  window.addEventListener('resize', updateComposerShift)
  if (isFirstInit || chats.value.length === 0) {
    loadChatsFromStorage()
  }
  // 周期对账兜底：异常停止/主进程失联导致收尾事件缺失时，自动清转圈解锁聊天
  startAgentReconcileTimer()
  // 监听设置页「清空聊天记录」事件
  window.addEventListener('ai-chats-cleared', onAiChatsCleared)
  // 监听设置独立窗口的聊天记录变更（导入/清空）→ 从本地存档重新加载
  window.ipcRenderer?.on('chats-changed', onChatsChangedRemote)
  checkCurrentModelConnection()
  if (isFirstInit) {
    // 首次初始化：普通聊天可从主进程磁盘缓冲续接（应用重启后恢复完整回答）
    resumeActiveChat()
  } else {
    // 重进模块：后台技能/工作流/普通流式仍写入共享 chats，恢复现场即可
    restoreExecutionView()
  }
  
  // 监听 store.skillsPath 的变化
  watch(() => store.skillsPath, async (newPath) => {
    // 智能体模式（含已并入的技能模式）需要技能目录：变化时重新加载
    if ((currentChat.value.mode === 'agent2' || currentChat.value.mode === 'skill') && newPath) {
      await loadSkills()
    }
  })
  
  watch(() => currentChat.value.messages.length, () => {
    if (currentChat.value.isGenerating || isExecuting.value) {
      scrollToBottom()
    }
  }, { immediate: true })
  
  watch(() => currentChat.value.isGenerating, (newVal) => {
    if (newVal) {
      autoScrollEnabled.value = true
      scrollToBottom()
      // 智能体模式不显示"正在生成回复"指示（agent 循环自带状态，避免 fa-refresh 残留）
      if (currentChat.value.mode === 'agent2' || currentChat.value.mode === 'skill' || currentChat.value.mode === 'agent') {
        return
      }
      // 设置初始步骤
      if (!globalExecutionState.value.currentStep) {
        setStep(store.locales == 'zh' ? '正在生成回复...' : 'Generating response...', 'fa fa-refresh fa-spin', 'step-generating')
      }
    } else {
      // 不清空步骤，让 onComplete 处理
    }
  })
  
  watch(() => currentChat.value.config, (newConfig) => {
    currentChat.value.online = false
    saveChats()
  }, { deep: true })
  
  watch(() => isExecuting.value, (newVal) => {
    if (newVal) {
      autoScrollEnabled.value = true
      scrollToBottom()
    }
  })

  // 如果当前聊天是智能体模式（含已并入的技能模式），加载技能目录供 $技能名 触发
  if (currentChat.value.mode === 'agent2' || currentChat.value.mode === 'skill') {
    await loadSkills()
  }

  // 智能体运行状态对账：仅在本模块挂载（打开/重进）时跑一次——
  // 清理「主进程已结束但仍转圈/锁定」的残留状态，并恢复切模块期间漏掉的实时投影
  void nextTick(() => reconcileAgentRuns())
  
  // 点击外部关闭 Agent 预设选择浮层
  document.addEventListener('mousedown', onDocMouseDownForPresetPicker)
  
  // 预初始化 ASR 管理器（必须在注册快捷键之前完成）
  import('@/services/asr/manager').then(({ createASRManager }) => {
    asrManagerInstance = createASRManager(store.AIconfig.asr, {
      onResult: (result: any) => {
        if (!result.isFinal) {
          // 流式 partial（funasr-online）：base + 当前句实时文本
          if (asrPartialFill) {
            inputText.value = asrBaseText + result.text
          }
          return
        }
        if (asrPartialFill) {
          // 本句完成：base + 最终文本，并作为下一句的 base（VAD 多句/停止都走这里）
          inputText.value = asrBaseText + result.text
          asrBaseText = inputText.value
        } else {
          if (inputText.value && !inputText.value.endsWith(' ')) {
            inputText.value += ' '
          }
          inputText.value += result.text
        }
        if (store.AIconfig.asr.autoSend) {
          setTimeout(() => sendMessage(), 100)
        }
      },
      onStatusChange: (status: string) => {
        if (status === 'idle') {
          isASRRecording.value = false
          isASRProcessing.value = false
          asrPartialFill = false
        } else if (status === 'listening') {
          isASRRecording.value = true
          isASRProcessing.value = false
        } else if (status === 'processing') {
          isASRRecording.value = false
          isASRProcessing.value = true
        } else if (status === 'error') {
          isASRRecording.value = false
          isASRProcessing.value = false
        }
      },
      onError: (error: string) => {
        console.error('[ASR] 语音输入错误:', error)
        isASRRecording.value = false
        isASRProcessing.value = false
        asrPartialFill = false
        // 显示错误信息 5 秒后自动清除
        asrErrorMessage.value = error
        if (asrErrorTimer) clearTimeout(asrErrorTimer)
        asrErrorTimer = setTimeout(() => {
          asrErrorMessage.value = ''
          asrErrorTimer = null
        }, 5000)
      }
    })

    // 预热音频采集图（不加载模型）：消除按住录音时开头几秒丢失的问题；失败静默
    asrManagerInstance.warmup?.().catch(() => {})

    // 不预加载模型，点击录音按钮后再加载
    
    // ASR 管理器就绪后再注册快捷键和监听器
    if (window.ipcRenderer) {
      // 监听 ASR 全局快捷键（来自 Electron 主进程）
      window.ipcRenderer.on('asr-shortcut-toggle', () => {
        if (isASRRecording.value) {
          stopASR()
        } else {
          startASR()
        }
      })
      
      // 注册 ASR 快捷键
      registerASRShortcut()
    }
  })
})

onBeforeUnmount(() => {
  clearPendingMermaidRender()
  // 停掉周期对账定时器（重新挂载会重新启动）
  stopAgentReconcileTimer()
  // 空聊天位移的监听清理
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  window.removeEventListener('resize', updateComposerShift)
  store.saveConfig()
  window.removeEventListener('ai-chats-cleared', onAiChatsCleared)
  window.ipcRenderer?.off('chats-changed', onChatsChangedRemote)
  if (scrollTimeout.value) {
    clearTimeout(scrollTimeout.value)
  }
  if (connectionTestTimeout.value) {
    clearTimeout(connectionTestTimeout.value)
  }
  // 切模块卸载：不中断技能/工作流执行、不中止 AI 会话——后台执行与普通流式
  // 继续写入模块级共享 chats，重进组件自动恢复实时状态
  // 仅持久化现场（供整体重启后恢复）
  saveChats()
  
  // 清理 Agent 预设浮层外部点击监听
  document.removeEventListener('mousedown', onDocMouseDownForPresetPicker)

  // 退订全部 agent 会话的流式订阅（不中断主进程执行；重进组件会重新订阅）
  disposeAgentRun?.()
  
  // 清理 ASR
  if (asrManagerInstance) {
    asrManagerInstance.destroy()
    asrManagerInstance = null
  }
  if (window.ipcRenderer) {
    window.ipcRenderer.invoke('unregisterASRShortcut').catch(() => {})
  }
})

// ==================== 技能相关函数 ====================

// 加载技能
const loadSkills = async (forceRefresh: boolean = false) => {
  if (!store.skillsPath) {
    //console.warn('技能路径未配置')
    return
  }
  
  if (!forceRefresh && availableSkills.value.length > 0) {
    //console.log('技能已加载，跳过扫描')
    return
  }
  
  skillLoading.value = true
  try {
    availableSkills.value = await skillManager.loadSkills(store.skillsPath)
    
    if (availableSkills.value.length > 0) {
      const skillNames = availableSkills.value.map(s => s.name).join(', ')
      //console.log(`可用技能: ${skillNames}`)
      
      // 智能体模式（agent2）：技能仅作静默预加载，不显示 step-success 成功指示
      if (currentChat.value.mode === 'agent2' || currentChat.value.mode === 'skill') {
        globalExecutionState.value.currentStep = ''
        globalExecutionState.value.stepIcon = ''
        globalExecutionState.value.stepIndicatorClass = ''
      } else {
        globalExecutionState.value.currentStep = store.locales == 'zh' 
          ? `已加载 ${availableSkills.value.length} 个技能`
          : `Loaded ${availableSkills.value.length} skills`
        globalExecutionState.value.stepIcon = 'fa fa-check-circle'
        globalExecutionState.value.stepIndicatorClass = 'step-success'
        
        setTimeout(() => {
          if (globalExecutionState.value.currentStep.includes('技能') || globalExecutionState.value.currentStep.includes('skill')) {
            globalExecutionState.value.currentStep = ''
          }
        }, 3000)
      }
    } else {
      console.warn('未找到任何技能文件')
      globalExecutionState.value.currentStep = store.locales == 'zh' 
        ? '未找到技能文件'
        : 'No skills found'
      globalExecutionState.value.stepIcon = 'fa fa-exclamation-triangle'
      globalExecutionState.value.stepIndicatorClass = 'step-error'
      
      setTimeout(() => {
        if (globalExecutionState.value.currentStep.includes('技能') || globalExecutionState.value.currentStep.includes('skill')) {
          globalExecutionState.value.currentStep = ''
        }
      }, 3000)
    }
  } catch (error) {
    console.error('加载技能失败:', error)
    globalExecutionState.value.currentStep = store.locales == 'zh' 
      ? '技能加载失败'
      : 'Skill loading failed'
    globalExecutionState.value.stepIcon = 'fa fa-exclamation-circle'
    globalExecutionState.value.stepIndicatorClass = 'step-error'
    
    setTimeout(() => {
      if (globalExecutionState.value.currentStep.includes('技能') || globalExecutionState.value.currentStep.includes('skill')) {
        globalExecutionState.value.currentStep = ''
      }
    }, 3000)
    
    availableSkills.value = []
  } finally {
    skillLoading.value = false
  }
}

// ==================== Agent 预设模式 ====================

// Agent 预设选择浮层显示状态
const showAgentPresetPicker = ref(false)

/** 选择通用智能体：清空预设，走通用 agent 循环（agent2 语义） */
const selectGeneralAgent = () => {
  currentChat.value.mode = 'agent2'
  currentChat.value.config.presetId = undefined
  currentChat.value.config.workflowPath = undefined
  currentChat.value.config.workflowData = undefined
  currentChat.value.config.kbPath = undefined
  showAgentPresetPicker.value = false
  saveChats()
}

/** 选择预设：切换当前聊天为 Agent 预设模式，并应用预设的模型配置。
 *  写回聊天配置 → 右上角「模型来源/模型种类」随预设一起更新；
 *  之后在右上角改动来源/模型时，执行以右上角（聊天配置）为准。 */
const selectAgentPreset = (preset: any) => {
  currentChat.value.mode = 'agent'
  currentChat.value.config.presetId = preset.id
  const presetType = normalizeLlmType(preset.llmType) || currentChat.value.config.llmType || store.AIconfig.llm.type
  currentChat.value.config.llmType = presetType
  currentChat.value.config.model = preset.model || ''
  // 预设本身不绑定具体自定义来源（跟随全局激活来源）：切到 custom 预设时让右上角跟随该来源
  if (presetType === 'custom') {
    currentChat.value.config.customSourceIndex = store.AIconfig.llm.custom?.activeIndex ?? 0
  }
  currentChat.value.config.temperature = typeof preset.temperature === 'number' ? preset.temperature : currentChat.value.config.temperature
  // 清除其他模式配置
  currentChat.value.config.workflowPath = undefined
  currentChat.value.config.workflowData = undefined
  currentChat.value.config.kbPath = undefined
  showAgentPresetPicker.value = false
  saveChats()
}

// ==================== 知识库模式切换 ====================

const selectKnowledgeBase = async () => {
  // 浏览器环境（LAN 共享）：弹出「共享知识库（主机目录）/ 上传自己的文件」选择浮层
  if (!window.ipcRenderer) {
    await toggleSharedKbPicker()
    return
  }
  // 如果已经是检索模式，可以选择新的知识库或退出
  if (currentChat.value.mode === 'retrieval') {
    try {
      const filePath = await window.ipcRenderer.invoke('selectFile')
      if (filePath == null) {
        // 如果取消选择，退出检索模式
        currentChat.value.mode = 'normal'
        currentChat.value.config.kbPath = undefined
      } else if (filePath && filePath.endsWith('.kb')) {
        currentChat.value.config.kbPath = filePath
        if (currentChat.value.config.kbTopK === undefined) {
          currentChat.value.config.kbTopK = 5
        }
        console.log(`已关联知识库: ${filePath}`)
      } else if (filePath && !filePath.endsWith('.kb')) {
        ElMessage.warning('请选择.kb格式的知识库文件')
        return
      }
    } catch (error) {
      console.error('选择知识库文件失败:', error)
    }
  } else {
    // 切换到检索模式
    try {
      const filePath = await window.ipcRenderer.invoke('selectFile')
      if (filePath && filePath.endsWith('.kb')) {
        currentChat.value.mode = 'retrieval'
        // 清除其他模式的配置
        currentChat.value.config.workflowPath = undefined
        currentChat.value.config.workflowData = undefined
        currentChat.value.config.kbPath = filePath
        if (currentChat.value.config.kbTopK === undefined) {
          currentChat.value.config.kbTopK = 5
        }
        console.log(`已关联知识库: ${filePath}`)
      } else if (filePath && !filePath.endsWith('.kb')) {
        ElMessage.warning('请选择.kb格式的知识库文件')
      }
    } catch (error) {
      console.error('选择知识库文件失败:', error)
    }
  }
  saveChats()
}

// ==================== 浏览器模式：知识库退化为上传文件 ====================

// 加载主机共享目录中的 .kb（浏览器模式；由局域网 HTTP 服务提供）
const loadSharedKbs = async () => {
  sharedKbLoading.value = true
  try {
    const res = await listSharedKbs()
    sharedKbList.value = res.files || []
    return res.enabled
  } catch (e) {
    console.warn('获取共享知识库失败:', e)
    sharedKbList.value = []
    return false
  } finally {
    sharedKbLoading.value = false
  }
}

// 切换「共享知识库 / 上传」浮层（点击知识库标签触发）
const toggleSharedKbPicker = async () => {
  showSharedKbPicker.value = !showSharedKbPicker.value
  if (showSharedKbPicker.value) await loadSharedKbs()
}

// 选用主机共享目录中的某个 .kb 作为本聊天知识库（与「上传文件」互斥）
const pickSharedKb = async (name: string, size?: number) => {
  const chat = currentChat.value
  chat.mode = 'retrieval'
  chat.config.sharedKb = { name, size }
  chat.config.kbFiles = []
  chat.config.kbPath = undefined
  chat.config.workflowPath = undefined
  chat.config.workflowData = undefined
  chat.config.presetId = undefined
  showSharedKbPicker.value = false
  saveChats()
  ElMessage.success(store.locales == 'zh' ? `已使用共享知识库：${name}` : `Using shared KB: ${name}`)
}

// 打开浏览器知识库文件选择器（无文件直接上传，有文件询问上传更多或清除）
const openKbFilePicker = async () => {
  // 走「上传自己的文件」入口：清除已关联的共享 .kb（二者互斥）
  currentChat.value.config.sharedKb = undefined
  const files = currentChat.value.config.kbFiles || []
  if (files.length > 0) {
    try {
      await ElMessageBox.confirm(
        store.locales == 'zh' ? '已有上传的 .kb 知识库，是否继续上传更多 .kb 文件？' : '.kb knowledge base already uploaded, upload more .kb files?',
        store.locales == 'zh' ? '知识库管理' : 'Knowledge Base',
        {
          confirmButtonText: store.locales == 'zh' ? '上传更多' : 'Upload More',
          cancelButtonText: store.locales == 'zh' ? '清除全部' : 'Clear All',
          distinguishCancelAndClose: true,
          type: 'info'
        }
      )
      // 确认 → 上传更多
      kbFileInput.value?.click()
    } catch (action: any) {
      // 取消（清除全部按钮）→ 清除；关闭弹窗 → 不处理
      if (action === 'cancel') {
        clearKbFiles()
      }
    }
    return
  }
  kbFileInput.value?.click()
}

// 清除浏览器模式的知识库（共享 .kb 与上传文件都清掉）
const clearKbFiles = () => {
  currentChat.value.config.kbFiles = []
  currentChat.value.config.sharedKb = undefined
  saveChats()
  ElMessage.info(store.locales == 'zh' ? '已清除知识库' : 'Knowledge base cleared')
}

// 浏览器模式知识库文件上传处理：读取文件内容持久化到当前聊天的 kbFiles
const handleKbFileUpload = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const files = target.files
  if (!files || files.length === 0) return
  try {
    const chat = currentChat.value
    // 确保处于检索模式
    if (chat.mode !== 'retrieval') {
      chat.mode = 'retrieval'
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
    }
    if (!chat.config.kbFiles) chat.config.kbFiles = []
    // 选择了上传自己的文件 → 清除主机共享 .kb（二者互斥）
    chat.config.sharedKb = undefined
    const MAX_KB_FILE = 50 * 1024 * 1024
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      // 知识库模式仅允许 .kb；其他类型文件请切到「普通」模式作为附件上传
      if (!file.name.toLowerCase().endsWith('.kb')) {
        ElMessage.warning(store.locales == 'zh'
          ? `知识库模式仅支持 .kb 知识库文件（已跳过: ${file.name}）。其他类型文件请切换到「普通」模式作为附件上传。`
          : `KB mode only accepts .kb files (skipped: ${file.name}). Upload other files as attachments in Normal mode.`)
        continue
      }
      if (file.size > MAX_KB_FILE) {
        ElMessage.warning(`文件 ${file.name} 大小超过50MB限制`)
        continue
      }
      try {
        const text = await file.text()
        if (!text || text.length === 0) {
          ElMessage.warning(store.locales == 'zh' ? `文件 ${file.name} 内容为空` : `File ${file.name} is empty`)
          continue
        }
        // 校验为有效的 .kb（JSON 且含 blocks）
        let parsed: any = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        if (!parsed || !Array.isArray(parsed.blocks) || parsed.blocks.length === 0) {
          ElMessage.warning(store.locales == 'zh' ? `文件 ${file.name} 不是有效的 .kb 知识库` : `${file.name} is not a valid .kb file`)
          continue
        }
        chat.config.kbFiles.push({ name: file.name, content: text, charCount: text.length })
      } catch (e) {
        console.error(`读取文件 ${file.name} 失败:`, e)
        ElMessage.error(store.locales == 'zh' ? `文件 ${file.name} 读取失败` : `Failed to read ${file.name}`)
      }
    }
    target.value = ''
    if (chat.config.kbFiles.length > 0) {
      ElMessage.success(store.locales == 'zh' ? `已添加 ${chat.config.kbFiles.length} 个 .kb 知识库文件` : `${chat.config.kbFiles.length} .kb file(s) added as knowledge base`)
    }
    saveChats()
  } catch (e) {
    console.error('知识库文件上传失败:', e)
    ElMessage.error(store.locales == 'zh' ? '知识库文件上传失败' : 'Knowledge base file upload failed')
  }
}

// 上传按钮点击：普通模式上传附件；浏览器知识库模式上传知识库文件
const onUploadClick = () => {
  if (isBrowser && currentChat.value.mode === 'retrieval') {
    kbFileInput.value?.click()
  } else {
    triggerFileUpload()
  }
}

// 浏览器知识库模式已关联标签显示文本
const getKbLinkedLabel = (): string => {
  if (isBrowser) {
    const shared = currentChat.value.config.sharedKb
    if (shared?.name) return shared.name
    const files = currentChat.value.config.kbFiles || []
    if (files.length === 0) return store.locales == 'zh' ? '选择共享知识库或上传 .kb...' : 'Shared KB or upload .kb...'
    if (files.length === 1) return files[0].name
    return store.locales == 'zh' ? `已上传 ${files.length} 个文件` : `${files.length} files`
  }
  const kbPath = currentChat.value.config.kbPath
  return kbPath ? getLinkedFileName(kbPath) : (store.locales == 'zh' ? '选择知识库...' : 'Select KB...')
}

// 浏览器知识库模式已关联标签是否为空
const getKbLinkedEmpty = (): boolean => {
  if (isBrowser) {
    return !currentChat.value.config.sharedKb && (currentChat.value.config.kbFiles || []).length === 0
  }
  return !currentChat.value.config.kbPath
}

// 上传按钮标题（浏览器知识库模式提示上传文件作为知识库）
const getUploadButtonTitle = (): string => {
  if (isBrowser && currentChat.value.mode === 'retrieval') {
    return store.locales == 'zh' ? '上传 .kb 知识库文件（web 知识库仅支持 .kb）' : 'Upload .kb KB file (web KB mode only accepts .kb)'
  }
  return store.locales == 'zh' ? '上传文件或图片（普通模式附件）' : 'Upload File or Image (attachments in Normal mode)'
}

// ==================== 工作流模式切换 ====================

const selectWorkflow = async () => {
  // 浏览器环境不支持文件选择
  if (!window.ipcRenderer) {
    ElMessage.warning(store.locales=='zh' ? '文件选择仅桌面版支持' : 'File selection is only supported in desktop app')
    return
  }
  // 如果已经是工作流模式，可以选择新的工作流或退出
  if (currentChat.value.mode === 'workflow') {
    try {
      const filePath = await window.ipcRenderer.invoke('selectFile', {
        filters: [
          { name: '工作流文件', extensions: ['flow', 'json'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      
      if (filePath == null) {
        // 如果取消选择，退出工作流模式
        currentChat.value.mode = 'normal'
        currentChat.value.config.workflowPath = undefined
        currentChat.value.config.workflowData = undefined
        workflowError.value = false
      } else if (filePath && (filePath.endsWith('.flow') || filePath.endsWith('.json'))) {
        await loadWorkflowFile(filePath)
      } else if (filePath && !filePath.endsWith('.flow') && !filePath.endsWith('.json')) {
        ElMessage.warning('请选择.flow或.json格式的工作流文件')
      }
    } catch (error: any) {
      console.error('选择工作流文件失败:', error)
    }
  } else {
    // 切换到工作流模式
    try {
      const filePath = await window.ipcRenderer.invoke('selectFile', {
        filters: [
          { name: '工作流文件', extensions: ['flow', 'json'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      
      if (filePath && (filePath.endsWith('.flow') || filePath.endsWith('.json'))) {
        currentChat.value.mode = 'workflow'
        // 清除其他模式的配置
        currentChat.value.config.kbPath = undefined
        await loadWorkflowFile(filePath)
      } else if (filePath && !filePath.endsWith('.flow') && !filePath.endsWith('.json')) {
        ElMessage.warning('请选择.flow或.json格式的工作流文件')
      }
    } catch (error: any) {
      console.error('选择工作流文件失败:', error)
    }
  }
  saveChats()
}

// ==================== 对话模式下拉框切换 ====================

// 模式下拉显示值：内部 mode 'agent2'（通用智能体）在下拉中显示为 'agent'（智能体）
const modeSelectValue = computed(() => {
  return currentChat.value.mode === 'agent2' ? 'agent' : currentChat.value.mode
})

// 模式下拉选项（普通 / 知识库 / 工作流 / 智能体）
// 「智能体」= 通用智能体（agent2 语义，默认）与 Agent 预设（agent）的统一入口：
// 选择「智能体」默认走通用智能体，可在旁边的预设选择器中切换为某个预设。
const modeOptions = computed(() => {
  const isZh = store.locales == 'zh'
  const all = [
    { value: 'normal', label: isZh ? '普通' : 'Normal' },
    { value: 'retrieval', label: isZh ? '知识库' : 'Knowledge Base' },
    { value: 'workflow', label: isZh ? '工作流' : 'Workflow' },
    // 技能模式已并入「智能体」：输入 $技能名 或「技能列表/help」自动识别
    { value: 'agent', label: isZh ? '智能体' : 'Agent' },
    // PTC（程序化工具调用 / Code Mode）：模型写 TS 程序，经 run_code 调用工具
    { value: 'code', label: 'PTC' },
    // 集群：多 Agent 预设协作（成员 = 预设引用，改预设即改成员）
    { value: 'swarm', label: isZh ? '集群' : 'Swarm' }
  ]
  // 浏览器模式（LAN 共享）：工作流/技能/Agent 预设依赖本地文件系统，仅保留普通对话与知识库（退化为上传文件）
  if (isBrowser) {
    return all.filter(m => m.value === 'normal' || m.value === 'retrieval')
  }
  return all
})

// 策略注册表（与 RAG 设置共享；配置 UI 写入 localStorage 后在此合并）
const strategyRegistryVersion = ref(0)
const loadPersistedStrategies = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('knowrag_strategies') || '[]')
    setUserStrategies(saved)
  } catch {
    setUserStrategies([])
  }
}
loadPersistedStrategies()

// 知识库检索策略选项（与 RAG 设置中的策略配置一致，含自定义/改名策略；仅启用的策略可选）
const retrievalStrategyOptions = computed(() => {
  void strategyRegistryVersion.value
  return getEnabledStrategies().map(s => ({ value: s.id, label: s.label }))
})

// 从 .kb 文件读取保存的检索策略并应用到当前会话（策略名称对应不上时回退 similarity）
const syncStrategyFromKb = async (kbPath: string) => {
  if (!window.ipcRenderer || !kbPath) return
  try {
    const content = await window.ipcRenderer.invoke('readFile', kbPath)
    const data = JSON.parse(content)
    const saved = data?.config?.searchConfig?.strategy
    if (saved) {
      currentChat.value.config.retrievalStrategy = resolveStrategyId(saved)
    }
  } catch (error) {
    console.warn('读取知识库保存的检索策略失败:', error)
  }
}

// 关联知识库后，优先使用 .kb 保存的检索策略
watch(() => currentChat.value.config.kbPath, (path) => {
  if (path) syncStrategyFromKb(path)
})

// 从路径取文件名（用于已关联标签显示）
const getLinkedFileName = (path: string): string => {
  return path.split(/[\\/]/).pop() || path
}

// 当前已选 Agent 预设名称
const getAgentPresetName = (): string => {
  const preset = store.agentPresets.find((c: any) => c.id === currentChat.value.config.presetId)
  return preset?.name || (store.locales=='zh' ? '未命名' : 'Unnamed')
}

// 点击模式下拉框：切换模式并触发对应的子项选择（知识库/工作流/技能/Agent 预设）
const onModeSelect = async (event: Event) => {
  const target = event.target as HTMLSelectElement
  const mode = target.value as ChatMode
  if (isAnyExecuting.value) return
  const chat = currentChat.value

  // 先关闭 Agent 预设浮层（若切到 agent 模式会重新打开）
  showAgentPresetPicker.value = false

  // 选择的是当前模式：不重复处理（重新选择文件请点击旁边的已关联标签）
  if (chat.mode === mode) return

  switch (mode) {
    case 'normal': {
      chat.mode = 'normal'
      chat.config.kbPath = undefined
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      saveChats()
      break
    }
    case 'skill': {
      chat.mode = 'skill'
      chat.config.kbPath = undefined
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      saveChats()
      if (!store.skillsPath) {
        ElMessage.warning(store.locales == 'zh' ? '请先在配置中设置技能目录路径' : 'Please set the skills directory path in configuration')
      } else {
        globalExecutionState.value.currentStep = store.locales == 'zh' ? '正在扫描技能...' : 'Scanning skills...'
        globalExecutionState.value.stepIcon = 'fa fa-search fa-spin'
        globalExecutionState.value.stepIndicatorClass = 'step-skill-matching'
        await loadSkills(true)
        setTimeout(() => {
          if (globalExecutionState.value.currentStep.includes('技能') || globalExecutionState.value.currentStep.includes('skill')) {
            globalExecutionState.value.currentStep = ''
          }
        }, 2000)
      }
      break
    }
    case 'retrieval': {
      chat.mode = 'retrieval'
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      saveChats()
      // 不直接弹出文件选择框：等用户点击旁边的已关联标签（mode-linked-chip）后再选择知识库
      break
    }
    case 'workflow': {
      chat.mode = 'workflow'
      chat.config.kbPath = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      saveChats()
      // 不直接弹出文件选择框：等用户点击旁边的已关联标签（mode-linked-chip）后再选择工作流
      break
    }
    case 'agent': {
      // 「智能体」统一入口：默认进入通用智能体（agent2 语义，预设选择器可切到指定预设）
      chat.mode = 'agent2'
      chat.config.kbPath = undefined
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      saveChats()
      if (!window.dsh?.agent) {
        ElMessage.warning(store.locales == 'zh' ? '智能体模式需要桌面版（window.dsh.agent 不可用）' : 'Agent mode requires the desktop app (window.dsh.agent unavailable)')
      } else if (store.skillsPath) {
        // 预热技能目录（供 $技能名 / 技能列表 / help 自动识别）
        void loadSkills(false)
      }
      break
    }
    case 'code': {
      // PTC（程序化工具调用）：工具呈现坍缩为 run_code（模型写程序调用工具）；步数沿用通用智能体设置
      chat.mode = 'code'
      chat.config.kbPath = undefined
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      saveChats()
      if (!window.dsh?.agent) {
        ElMessage.warning(store.locales == 'zh' ? 'PTC 模式需要桌面版（window.dsh.agent 不可用）' : 'PTC mode requires the desktop app (window.dsh.agent unavailable)')
      } else if (store.skillsPath) {
        // 预热技能目录（技能清单进系统提示）
        void loadSkills(false)
      }
      break
    }
    case 'swarm': {
      // 集群：多 Agent 预设协作；成员由预设派生（config.swarmPresetIds），配置随对话保存
      chat.mode = 'swarm'
      chat.config.kbPath = undefined
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      if (!Array.isArray(chat.config.swarmPresetIds)) chat.config.swarmPresetIds = []
      saveChats()
      if (!window.dsh?.agent) {
        ElMessage.warning(store.locales == 'zh' ? '集群模式需要桌面版（window.dsh.agent 不可用）' : 'Swarm mode requires the desktop app (window.dsh.agent unavailable)')
      } else if (!(store.agentPresets || []).length) {
        ElMessage.warning(store.locales == 'zh' ? '还没有 Agent 预设，请先在「设置 → 预设」中创建' : 'No agent presets yet — create one in Settings → Presets')
      } else if (store.skillsPath) {
        // 预热技能目录：成员若启用技能能力，执行时需按需加载 SKILL.md
        void loadSkillList()
      }
      break
    }
    case 'agent2': {
      // 智能体模式：Agent 循环 + 统一工具注册表（技能模式已并入，$技能名/技能列表/help 自动识别）
      chat.mode = 'agent2'
      chat.config.kbPath = undefined
      chat.config.workflowPath = undefined
      chat.config.workflowData = undefined
      chat.config.presetId = undefined
      workflowError.value = false
      saveChats()
      if (!window.dsh?.agent) {
        ElMessage.warning(store.locales == 'zh' ? '智能体模式需要桌面版（window.dsh.agent 不可用）' : 'Agent Loop mode requires the desktop app (window.dsh.agent unavailable)')
      } else if (store.skillsPath) {
        // 预热技能目录（供 $技能名 / 技能列表 / help 自动识别）
        void loadSkills(false)
      }
      break
    }
  }
}

// ==================== 集群模式（多 Agent 预设协作） ====================
// 成员 = Agent 预设引用（config.swarmPresetIds，有序 = 发言顺序）；不做群内成员特化，
// 改预设即改成员。执行复用集群运行时（composables/swarm/swarmRunner）。

/** 成员选择浮层显隐 */
const showSwarmMemberPicker = ref(false)
/** 引用失效的预设 id（预设被删/改名），UI 提示后一键清理 */
const swarmMissingPresets = ref<string[]>([])

/** 运行方式（写回对话 config，随对话保存） */
const swarmRunMode = computed({
  get: () => currentChat.value.config.swarmOptions?.runMode || 'auto',
  set: (v: 'auto' | 'host' | 'debate') => {
    currentChat.value.config.swarmOptions = { ...(currentChat.value.config.swarmOptions || {}), runMode: v }
    saveChats()
  }
})
/** 结束群主总结开关（默认关闭） */
const swarmHostSummary = computed({
  get: () => currentChat.value.config.swarmOptions?.hostSummary === true,
  set: (v: boolean) => {
    currentChat.value.config.swarmOptions = { ...(currentChat.value.config.swarmOptions || {}), hostSummary: v }
    saveChats()
  }
})
const toggleSwarmHostSummary = () => { swarmHostSummary.value = !swarmHostSummary.value }

/** 成员在勾选列表中的序号（1 起；未选中返回 0）——同时表达发言顺序 */
const swarmMemberOrder = (id: string): number => (currentChat.value.config.swarmPresetIds || []).indexOf(id) + 1

/** 运行方式选项（集群设置浮层内单选） */
const swarmRunModeOptions = computed(() => {
  const zh = store.locales == 'zh'
  return [
    { value: 'auto' as const, label: zh ? '全员响应' : 'All respond' },
    { value: 'host' as const, label: zh ? '群主撮合' : 'Host-led' },
    { value: 'debate' as const, label: zh ? '辩论' : 'Debate' },
  ]
})

/**
 * 集群入口 chip 文本：成员数 + 当前运行方式/总结。
 * 输入区只保留这一个控件，因此把关键设置压进文本，保证不展开也能感知当前配置。
 */
const swarmChipLabel = computed(() => {
  const zh = store.locales == 'zh'
  const ids = currentChat.value.config.swarmPresetIds || []
  if (!ids.length) return zh ? '选择成员...' : 'Pick members...'
  const o = currentChat.value.config.swarmOptions || {}
  const parts = [zh ? `成员 ${ids.length}` : `${ids.length} members`]
  if (o.runMode === 'host') parts.push(zh ? '撮合' : 'Host-led')
  else if (o.runMode === 'debate') parts.push(zh ? '辩论' : 'Debate')
  if (o.hostSummary) parts.push(zh ? '总结' : 'Summary')
  return parts.join(' · ')
})

/** 把当前对话的成员预设同步进集群运行时（发送前 / 勾选后调用） */
const syncSwarmMembers = () => {
  const ids = currentChat.value.config.swarmPresetIds || []
  const { members, missing } = applyMembers(ids, swarmAgents)
  swarmMissingPresets.value = missing
  return members
}

/** 勾选 / 取消成员（顺序即发言顺序） */
const toggleSwarmMember = (id: string) => {
  const chat = currentChat.value
  const ids = [...(chat.config.swarmPresetIds || [])]
  const i = ids.indexOf(id)
  if (i >= 0) ids.splice(i, 1)
  else ids.push(id)
  chat.config.swarmPresetIds = ids
  saveChats()
  syncSwarmMembers()
}

/** 清理失效预设引用 */
const pruneSwarmMissing = () => {
  const chat = currentChat.value
  chat.config.swarmPresetIds = (chat.config.swarmPresetIds || []).filter(id => !swarmMissingPresets.value.includes(id))
  saveChats()
  syncSwarmMembers()
}

/** 跳转「设置 → 预设」管理成员配置（成员即预设，不做群内特化） */
const goManageAgentPresets = () => {
  showSwarmMemberPicker.value = false
  // 桌面版打开独立设置窗口并定位到「预设」；浏览器/LAN 模式退回窗口内浮层
  store.openSettings('agentpreset')
}

/** 把对话内的集群选项写入运行时（运行方式 / 群主 / 前文注入 / 辩论轮数） */
const applySwarmOptions = () => {
  const o = currentChat.value.config.swarmOptions || {}
  const runMode = o.runMode || 'auto'
  // 运行时用 swarmMode + settings.collabMode 组合表达三档：全员响应 / 群主撮合 / 辩论
  swarmMode.value = runMode === 'debate' ? 'debate' : 'auto'
  swarmSettings.value = {
    ...swarmSettings.value,
    collabMode: runMode === 'host' ? 'host' : 'mention',
    enableHostSummary: o.hostSummary === true,
    managerAgentIdx: typeof o.hostIdx === 'number' ? o.hostIdx : -1,
    injectHistory: o.injectHistory !== false,
  }
  swarmDebateRounds.value = o.debateRounds || 2
}

/** 解析任务文本中 @到的成员下标（未匹配返回空数组，由发送层回落为全员协作） */
const collectSwarmNamed = (text: string): number[] => {
  const out: number[] = []
  swarmAgents.value.forEach((a, i) => {
    const nm = (a.name || '').trim()
    if (nm && text.includes(`@${nm}`)) out.push(i)
  })
  return [...new Set(out)]
}

/** 集群模式发送入口：同步成员 → 应用选项 → @点名 或全员协作 */
const handleSwarmMode = async (message: string) => {
  const members = syncSwarmMembers()
  if (!members.length) {
    ElMessage.warning(store.locales == 'zh'
      ? '请先选择参与成员（点击输入区的成员标签）'
      : 'Please pick members first (click the member chip)')
    return
  }
  applySwarmOptions()
  // 本次运行归属当前对话：成员汇报写入它的 messages（与其它模式同一套渲染/持久化）
  setSwarmRunChatId(currentChat.value.id)
  // 复用同一个输入框状态：任务先捕获到局部变量，再清空输入框（与其它模式一致）
  inputText.value = ''
  currentUploads.value = []
  // 技能目录可能尚未预热（本对话未切换过模式、或本次会话刚启动）；扫描成本低，发送前刷新一次
  if (store.skillsPath) void loadSkillList()
  const named = collectSwarmNamed(message)
  if (named.length) await runNamedTask(named, message)
  else await runSwarm(message)
  // 首次任务完成后自动生成对话标题（与其它模式一致）
  const chat = currentChat.value
  if (!chat.title?.trim()) {
    const last = [...(chat.messages || [])].reverse().find((m: any) => m.role === 'assistant' && m.content)
    if (last?.content) generateChatTitle(last.content, chat)
  }
}

// 点击模式选择区域外部时关闭 Agent 预设 / 共享知识库 / 集群成员 浮层
const onDocMouseDownForPresetPicker = (e: MouseEvent) => {
  if (!showAgentPresetPicker.value && !showSharedKbPicker.value && !showSwarmMemberPicker.value) return
  const wrap = document.querySelector('.mode-select-wrap') as HTMLElement | null
  if (wrap && !wrap.contains(e.target as Node)) {
    showAgentPresetPicker.value = false
    showSharedKbPicker.value = false
    showSwarmMemberPicker.value = false
  }
}

const loadWorkflowFile = async (filePath: string) => {
  if (!window.ipcRenderer) {
    ElMessage.error(store.locales=='zh' ? '文件读取仅桌面版支持' : 'File reading is only supported in desktop app')
    return
  }
  try {
    const content = await window.ipcRenderer.invoke('readFile', filePath)
    const workflowData = JSON.parse(content)
    
    if (!workflowData.items || !Array.isArray(workflowData.items)) {
      throw new Error('无效的工作流文件格式')
    }
    
    const startNode = workflowData.items.find((item: any) => item.type === 'start')
    const endNode = workflowData.items.find((item: any) => item.type === 'end')
    
    if (!startNode) {
      throw new Error('工作流缺少开始节点')
    }
    
    if (!endNode) {
      throw new Error('工作流缺少结束节点')
    }
    
    currentChat.value.config.workflowPath = filePath
    currentChat.value.config.workflowData = workflowData
    workflowError.value = false
    
    initWorkflowRunner()
    
    if (startNode.prompt && startNode.prompt.trim()) {
      inputText.value = startNode.prompt
    } else {
      inputText.value = ''
    }
    
    console.log(`已加载工作流: ${filePath}`)
    
    try {
      const isValid = await validateWorkflow()
      if (!isValid) {
        ElMessage.warning('工作流验证失败，请检查配置')
        workflowError.value = true
      }
    } catch (error: any) {
      ElMessage.error(`工作流验证错误: ${error.message}`)
      workflowError.value = true
    }
    
  } catch (error: any) {
    console.error('加载工作流失败:', error)
    ElMessage.error(`加载工作流失败: ${error.message}`)
    currentChat.value.config.workflowPath = undefined
    currentChat.value.config.workflowData = undefined
    workflowError.value = true
  }
}

// ==================== 技能帮助和列表处理函数 ====================

// 处理技能帮助请求
const handleSkillHelp = async (skillName: string) => {
  try {
    const helpContent = await skillManager.getSkillHelp(skillName)
    
    const helpMessage: ChatMessage = {
      role: 'assistant',
      content: helpContent,
      timestamp: Date.now()
    }
    
    currentChat.value.messages.push(helpMessage)
    
    scrollToBottom()
    saveChats()
    
  } catch (error: any) {
    console.error('获取技能帮助失败:', error)
    
    const errorMessage: ChatMessage = {
      role: 'assistant',
      content: `获取技能帮助失败: ${error.message}`,
      timestamp: Date.now()
    }
    
    currentChat.value.messages.push(errorMessage)
    scrollToBottom()
  }
}

// 处理技能列表请求（只展示已启用的技能）
const handleSkillList = async () => {
  const disabled = new Set(store.disabledSkills || [])
  const skills = skillManager.getSkills().filter(s => !disabled.has(s.name))
  
  if (skills.length === 0) {
    const noSkillsMessage: ChatMessage = {
      role: 'assistant',
      content: store.locales == 'zh' 
        ? '📋 当前没有可用的技能。请先在配置中设置技能目录路径。' 
        : '📋 No skills available. Please set the skills directory path in configuration.',
      timestamp: Date.now()
    }
    currentChat.value.messages.push(noSkillsMessage)
  } else {
    let listContent = store.locales == 'zh' 
      ? `📋 **当前可用的技能列表（共 ${skills.length} 个）**\n\n` 
      : `📋 **Available Skills (${skills.length})**\n\n`
    
    skills.forEach((skill, index) => {
      listContent += `### ${index + 1}. ${skill.name}\n`
      listContent += `> ${skill.description}\n`
      
      if (skill.metadata.tags && skill.metadata.tags.length > 0) {
        listContent += `> ${store.locales == 'zh' ? '标签:' : 'Tags: '} \`${skill.metadata.tags.join('`, `')}\`\n`
      }
      
      const fileTotal = skill.fileCount ?? skill.files?.length ?? 0
      if (fileTotal > 0) {
        listContent += `>  ${fileTotal} ${store.locales == 'zh' ? '个文件' : 'Files'}\n`
      }
      
      listContent += '\n'
    })
    
    const listMessage: ChatMessage = {
      role: 'assistant',
      content: listContent,
      timestamp: Date.now()
    }
    
    currentChat.value.messages.push(listMessage)
  }
  
  scrollToBottom()
  saveChats()
}

// ==================== 停止执行函数 ====================

const stopExecution = (abortAI: boolean = true) => {
  //console.log('停止执行')
  
  if (globalExecutionState.value.workflowRunner) {
    globalExecutionState.value.workflowRunner.stop()
  }
  
  // abortAI=false（切模块卸载时）：不中止主进程 AI 会话，让其在后台继续缓冲完整回答
  if (abortAI && globalExecutionState.value.abortController) {
    globalExecutionState.value.abortController.abort()
  }
  
  // 记录「全局执行」所属的聊天，复位时只清该聊天的执行态——避免误把其它聊天里
  // 后台运行中的智能体/技能消息一并标停（保留其已生成记录）。
  const execChatId = globalExecutionState.value.chatId
  
  globalExecutionState.value = {
    isExecuting: false,
    executionType: null,
    chatId: null,
    skillLoading: false,
    currentStep: '',
    stepIcon: '',
    stepIndicatorClass: '',
    workflowRunner: null,
    abortController: null
  }
  
  const targetChats = execChatId
    ? chats.value.filter(c => c.id === execChatId)
    : (currentChat.value ? [currentChat.value] : [])
  targetChats.forEach(chat => {
    if (!chat) return
    const executingMessage = (chat.messages || []).find(msg => msg.isExecuting)
    if (executingMessage) {
      executingMessage.isExecuting = false
      executingMessage.streaming = false
      // 仅当没有已生成内容时写「已停止」提示，避免覆盖正在执行/已生成的部分结果
      if (!executingMessage.content) {
        executingMessage.content = store.locales=='zh' ? '执行已停止' : 'Execution stopped'
      }
    }
    if (chat.isGenerating) chat.isGenerating = false
  })
  
  nextTick(() => {
    //console.log('停止执行后状态:', globalExecutionState.value)
  })
  
  saveChats()
}

const setStep = (step: string, icon: string, stepClass: string) => {
  globalExecutionState.value.currentStep = step
  globalExecutionState.value.stepIcon = icon
  globalExecutionState.value.stepIndicatorClass = stepClass
}

// ==================== 保存和加载聊天 ====================

const saveChats = () => {
  localStorage.setItem('ai-chats', JSON.stringify(chats.value))
  localStorage.setItem('ai-chats-index', String(currentChatIndex.value))
}

// 设置页「清空聊天记录」联动：外部清空 ai-chats 后重置内存为单个空会话
const onAiChatsCleared = () => {
  currentUploads.value = []
  chats.value = [createNewChatData()]
  currentChatIndex.value = 0
  saveChats()
}

/**
 * 其它窗口（设置独立窗口）导入/清空聊天后的同步：两窗口共享同一份 ai-chats 存档，
 * 不重新加载的话主窗口下一次 saveChats 会把导入结果覆盖掉。
 * 正在执行/流式时不做整体替换（避免打断当前回答），只把新增的聊天追加进来。
 */
const onChatsChangedRemote = () => {
  try {
    const saved = localStorage.getItem('ai-chats')
    const incoming: any[] = saved ? (JSON.parse(saved) || []) : []
    const busy = globalExecutionState.value.isExecuting || currentChat.value?.isGenerating === true
    if (!busy) {
      if (Array.isArray(incoming) && incoming.length) {
        loadChatsFromStorage()
        void nextTick(() => refreshRenderedMermaid())
      } else {
        onAiChatsCleared() // 存档被清空
      }
      return
    }
    const known = new Set((chats.value || []).map((c: any) => String(c?.id ?? '')))
    const added = (Array.isArray(incoming) ? incoming : []).filter((c: any) => c && !known.has(String(c?.id ?? '')))
    if (!added.length) return
    chats.value = [...chats.value, ...added]
    saveChats()
    void nextTick(() => refreshRenderedMermaid())
  } catch { /* 存档损坏时忽略 */ }
}

const loadChatsFromStorage = () => {
  const saved = localStorage.getItem('ai-chats')
  if (saved) {
    try {
      const loadedChats = JSON.parse(saved)
      chats.value = loadedChats
      // 恢复关闭前的聊天栏（卸载模块回来回到同一栏）
      const savedIdx = parseInt(localStorage.getItem('ai-chats-index') || '0', 10)
      currentChatIndex.value = Number.isFinite(savedIdx) ? Math.min(Math.max(savedIdx, 0), chats.value.length - 1) : 0
      chats.value.forEach(chat => {
        // 兼容旧数据：如果没有mode字段，根据配置推断
        if (chat.mode === undefined) {
          if (chat.config.workflowPath) {
            chat.mode = 'workflow'
          } else if (chat.config.kbPath) {
            chat.mode = 'retrieval'
          } else {
            chat.mode = 'normal'
          }
        }

        // 技能模式已并入「智能体」：旧存档的 mode='skill' 一律迁移到 agent2
        if (chat.mode === 'skill') {
          chat.mode = 'agent2'
        }

        // DeepSeek 单来源迁移：旧聊天绑定的历史别名 'deepseek-responses' → 'deepseek'
        // （接口样式跟随当前设置的 deepseek.api_style；缺失时回退当前全局来源）
        if (chat.config) {
          chat.config.llmType = normalizeLlmType(chat.config.llmType) || store.AIconfig.llm.type
        }
        
        if (chat.online === undefined) chat.online = false
        if (chat.config.functionIndex === undefined) chat.config.functionIndex = 0
        if (chat.config.kbTopK === undefined && chat.config.kbPath) {
          chat.config.kbTopK = 5
        }
        if (chat.config.retrievalStrategy === undefined) {
          chat.config.retrievalStrategy = 'similarity'
        }
        if (chat.isGenerating === undefined) chat.isGenerating = false
        
        // 兼容旧数据 - 使用类型断言处理可能的旧字段
        chat.messages.forEach((msg: any) => {
          // 将旧的工作流字段转换为新格式
          if (msg.isWorkflowRunning || msg.workflowResult) {
            msg.executionType = 'workflow'
            msg.isExecuting = msg.isWorkflowRunning
            if (msg.workflowStats) {
              msg.executionStats = {
                total: msg.workflowStats.totalNodes,
                success: msg.workflowStats.completedNodes,
                failed: msg.workflowStats.failedNodes,
                time: msg.workflowStats.executionTime,
                errors: msg.workflowStats.errors
              }
            }
            delete msg.isWorkflowRunning
            delete msg.workflowResult
            delete msg.workflowStats
          }
          
          // 将旧的技能字段转换为新格式
          if (msg.isSkillRunning || msg.skillResult) {
            msg.executionType = 'skill'
            msg.isExecuting = msg.isSkillRunning
            msg.executionName = msg.skillName
            if (msg.skillSteps) {
              msg.executionUnits = msg.skillSteps.map((step: any) => ({
                id: step.id,
                status: step.status,
                stepType: step.type,
                description: step.description,
                result: step.result,
                error: step.error,
                startTime: step.startTime,
                endTime: step.endTime
              }))
            }
            if (msg.skillStats) {
              msg.executionStats = {
                total: msg.skillStats.totalSteps,
                success: msg.skillStats.successSteps,
                failed: msg.skillStats.failedSteps,
                time: msg.skillStats.executionTime
              }
            }
            delete msg.isSkillRunning
            delete msg.skillResult
            delete msg.skillName
            delete msg.skillSteps
            delete msg.skillStats
          }

          // 应用重启后，技能/工作流的执行循环已死，把“执行中”标记为已中断；
          // 同步复位聊天级生成态（isGenerating/activeRequestId），避免重启后该聊天仍锁死/转圈无法发送
          if (msg.isExecuting && (msg.executionType === 'skill' || msg.executionType === 'workflow')) {
            msg.isExecuting = false
            msg.streaming = false
            chat.isGenerating = false
            chat.activeRequestId = undefined
            if (!msg.content) {
              msg.content = store.locales=='zh' ? '（执行已中断，请重新运行）' : '(execution interrupted, please rerun)'
            }
          }
        })
        
        if (chat.config.workflowPath && chat.config.workflowData && chat.mode === 'workflow') {
          setTimeout(() => {
            initWorkflowRunner()
          }, 100)
        }
      })
    } catch (e) {
      console.error('加载聊天记录失败:', e)
    }
  }
}

function createNewChatData(): Chat {
  const isCustom = store.AIconfig.llm.type === 'custom'
  const customIndex = isCustom ? (store.AIconfig.llm.custom.activeIndex ?? 0) : undefined
  return {
    id: Date.now().toString(),
    title: '',
    messages: [],
    config: {
      llmType: store.AIconfig.llm.type,
      customSourceIndex: customIndex,
      model: getDefaultModel(store.AIconfig.llm.type, customIndex),
      temperature: store.AIconfig.llm.temperature,
      maxTokens: Math.floor(store.AIconfig.llm.max_tokens),
      stream: true,
      functionIndex: 0,
      kbPath: undefined,
      kbTopK: 5,
      retrievalStrategy: 'similarity',
      workflowPath: undefined,
      workflowData: undefined
    },
    createdAt: Date.now(),
    online: false,
    isGenerating: false,
    mode: 'normal'  // 默认普通模式
  }
}

function getDefaultModel(llmType: string, customIndex?: number): string {
  switch(llmType) {
    case 'custom': {
      const c = store.AIconfig.llm.custom
      const sources = Array.isArray(c.sources) ? c.sources : []
      const src = (typeof customIndex === 'number' && sources[customIndex]) ? sources[customIndex] : undefined
      return (src && src.model) || c.model || ''
    }
    case 'ollama':
      return store.AIconfig.llm.ollama.model || ''
    case 'lmstudio':
      return store.AIconfig.llm.lmstudio?.model || ''
    case 'openai':
      return store.AIconfig.llm.openai.model || 'gpt-4o-mini'
    case 'deepseek':
    case 'deepseek-responses': {
      // 单来源：默认模型取当前接口样式对应配置块（'deepseek-responses' 为历史别名）
      const dsCfg = deepSeekStyleOf(llmType, store.AIconfig.llm.deepseek) === 'responses'
        ? store.AIconfig.llm.deepseekResponses
        : store.AIconfig.llm.deepseek
      return dsCfg?.model || 'deepseek-flash'
    }
    case 'gpustack':
      return store.AIconfig.llm.gpustack?.model || ''
    default:
      return ''
  }
}

const createNewChat = () => {
  currentUploads.value = []
  chats.value.push(createNewChatData())
  currentChatIndex.value = chats.value.length - 1
  saveChats()
}

const switchChat = async (index: number) => {
  currentUploads.value = []
  
  if (currentChatIndex.value === index) return
  
  currentChatIndex.value = index
  
  // 切换聊天时，如果新聊天没有分支则隐藏分支面板
  if (showBranchView.value && !hasBranches.value) {
    showBranchView.value = false
  }
  
  await checkCurrentModelConnection()
  
  // 根据当前聊天的模式初始化
  if (currentChat.value.mode === 'workflow' && currentChat.value.config.workflowPath && currentChat.value.config.workflowData) {
    initWorkflowRunner()
  } else if (currentChat.value.mode === 'agent2' || currentChat.value.mode === 'skill') {
    // 智能体模式（含旧存档技能模式）：切换时加载技能目录供 $技能名 触发
    await loadSkills()
  }
  
  // 清除临时状态
  retrievalStats.value = null
  globalExecutionState.value.currentStep = ''
  
  // 如果切到的聊天正在生成（切走时未完成），续接其主进程缓冲的完整回答
  if (currentChat.value.isGenerating && currentChat.value.activeRequestId) {
    resumeActiveChat()
  }

  // 智能体运行状态对账：切入/打开该聊天时兜底清理残留的「执行中」状态，
  // 并在该聊天存在切模块期间仍在后台运行的 agent 时恢复实时投影
  reconcileAgentRuns()
}

const deleteChat = async (index: number) => {
  if (chats.value.length <= 1) return
  
  if (globalExecutionState.value.isExecuting && globalExecutionState.value.chatId === chats.value[index].id) {
    try {
      await ElMessageBox.confirm(
        store.locales=='zh' ? '该聊天正在执行中，确定要删除吗？' : 'This chat is executing, are you sure you want to delete it?',
        store.locales == 'zh' ? '提示' : 'Confirm',
        { confirmButtonText: store.locales == 'zh' ? '确定' : 'OK', cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel', type: 'warning' }
      )
      stopExecution()
    } catch {
      return
    }
  }
  
  // 删除前取消该聊天仍执行中的智能体会话（避免主进程遗留孤儿 agent）
  const deletingChat = chats.value[index]
  if (deletingChat && (deletingChat.messages || []).some(
    (m: any) => m?.role === 'assistant' && m?.executionType === 'skill' && m?.isExecuting
  )) {
    stopAgentsInChat?.(deletingChat)
  }
  
  try {
    await ElMessageBox.confirm(
      store.locales == 'zh' ? '确定删除这个聊天吗？' : 'Are you sure you want to delete this chat?',
      store.locales == 'zh' ? '提示' : 'Confirm',
      { confirmButtonText: store.locales == 'zh' ? '确定' : 'OK', cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel', type: 'warning' }
    )
    
    chats.value[index].messages.forEach(msg => {
      delete showKbDetails.value[msg.timestamp]
    })
    
    chats.value.splice(index, 1)
    if (currentChatIndex.value >= chats.value.length) {
      currentChatIndex.value = chats.value.length - 1
    }
    saveChats()
  } catch {
    // 用户取消删除
  }
}

const deleteChatFromSidebarMenu = async () => {
  sidebarContextMenuVisible.value = false
  const index = sidebarContextMenuChatIndex.value
  sidebarContextMenuChatIndex.value = null
  if (index !== null) {
    await deleteChat(index)
  }
}

const hideBranchContextMenu = () => {
  branchContextMenuVisible.value = false
  branchContextMenuNode.value = null
}

/** 根据视口边界调整菜单位置，防止溢出 */
const adjustMenuToViewport = (x: number, y: number): { x: number, y: number } => {
  let adjustedX = x
  let adjustedY = y
  nextTick(() => {
    if (!branchContextMenuRef.value) return
    const rect = branchContextMenuRef.value.getBoundingClientRect()
    if (adjustedX + rect.width > window.innerWidth) {
      adjustedX = x - rect.width
    }
    if (adjustedY + rect.height > window.innerHeight) {
      adjustedY = y - rect.height
    }
    branchContextMenuPos.value = {
      x: Math.max(0, adjustedX),
      y: Math.max(0, adjustedY)
    }
  })
  return { x: adjustedX, y: adjustedY }
}

/** 显示分支上下文菜单（自动适配视口边界） */
const showBranchContextMenu = (x: number, y: number, node: any = null) => {
  branchContextMenuNode.value = node
  branchContextMenuPos.value = { x, y }
  branchContextMenuVisible.value = true
  adjustMenuToViewport(x, y)
}

/** 分支面板空白处右键 */
const onBranchPanelContextMenu = (event: MouseEvent) => {
  showBranchContextMenu(event.clientX, event.clientY)
}

/** 重置分支视图（居中铺满） */
const resetBranchView = () => {
  hideBranchContextMenu()
  renderD3Tree()
}

/** 切换分支标题显示 */
const toggleBranchTitles = () => {
  showBranchTitles.value = !showBranchTitles.value
  hideBranchContextMenu()
  renderD3Tree()
}

/** 删除分支节点及其所有子节点 */
const deleteBranchTree = async (node: any) => {
  const chatId = node.data.chat.id
  // 收集该节点及其所有后代在 chats 中的索引
  const indicesToRemove: number[] = []
  const collect = (n: any) => {
    const idx = chats.value.findIndex(c => c.id === n.data.chat.id)
    if (idx !== -1) indicesToRemove.push(idx)
    if (n.children) n.children.forEach((child: any) => collect(child))
  }
  collect(node)

  // 按从大到小排序，从后往前删除
  indicesToRemove.sort((a, b) => b - a)
  for (const idx of indicesToRemove) {
    chats.value[idx].messages.forEach(msg => {
      delete showKbDetails.value[msg.timestamp]
    })
    chats.value.splice(idx, 1)
  }

  if (currentChatIndex.value >= chats.value.length) {
    currentChatIndex.value = chats.value.length - 1
  }
  saveChats()
}

const deleteBranchFromContextMenu = async () => {
  const node = branchContextMenuNode.value
  hideBranchContextMenu()
  if (!node) return

  const isRoot = node.depth === 0
  try {
    await ElMessageBox.confirm(
      isRoot
        ? (store.locales == 'zh' ? '确定删除这个聊天吗？（分支也会被删除）' : 'Are you sure you want to delete this chat? (Branches will also be deleted)')
        : (store.locales == 'zh' ? `确定删除此分支及其所有子分支吗？` : 'Are you sure you want to delete this branch and all its sub-branches?'),
      store.locales == 'zh' ? '提示' : 'Confirm',
      { confirmButtonText: store.locales == 'zh' ? '确定' : 'OK', cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel', type: 'warning' }
    )
    await deleteBranchTree(node)
    // 删除后重绘树
    if (showBranchView.value) {
      nextTick(() => renderD3Tree())
    }
  } catch {
    // 用户取消
  }
}

const clearCurrentChat = async () => {
  try {
    await ElMessageBox.confirm(
      store.locales == 'zh' ? '确定清空当前聊天记录吗？' : 'Are you sure you want to clear the current chat history?',
      store.locales == 'zh' ? '提示' : 'Confirm',
      {
        confirmButtonText: store.locales == 'zh' ? '确定' : 'OK',
        cancelButtonText: store.locales == 'zh' ? '取消' : 'Cancel',
        type: 'warning'
      }
    )
    
    if (isExecuting.value || isAgentRunActive.value) {
      // 统一停止：工作流→stopExecution；智能体→取消会话并保留/清理；普通→abort
      stopCurrentGeneration()
    }
    
    currentChat.value.messages.forEach(msg => {
      delete showKbDetails.value[msg.timestamp]
    })
    
    currentUploads.value = []
    currentChat.value.messages = []
    // 清空后重新提问应重新生成标题：重置标题与智能体执行展示状态
    currentChat.value.title = ''
    currentChat.value.agentTodos = []
    currentChat.value.agentLastTool = null
    saveChats()
  } catch {
    // 用户取消操作，不做处理
  }
}

// ==================== 模型相关函数 ====================

// ==================== 模型配置 / 连接检测（已抽到 composables/useChatModels.ts） ====================
const {
  connectionTestStatus,
  connectionTestIcon,
  connectionTestClass,
  connectionTestTimeout,
  setConnectionTestStatus,
  updateStoreModelConfig,
  restoreStoreModelConfig,
  getCurrentModelFromStore,
  onModelTypeChange,
  checkCurrentModelConnection,
  testCurrentModelConnection,
  refreshModels,
} = useChatModels({
  getCurrentChat: () => currentChat.value,
  saveChats,
  getDefaultModel,
})

/** 启用的来源选项：内置（过滤禁用）+ 自定义（过滤禁用，保留原索引） */
const enabledLlmTypeOptions = computed(() => {
  const types = store.enabledLlmTypes || []
  const customSources = store.AIconfig.llm.custom?.sources || []
  const customEnabled = (customSources as any[])
    .map((src, i) => ({ src, i }))
    .filter(({ src }) => !store.isLlmSourceDisabled('custom', src?.id))
  return { types, customEnabled }
})

/** 模型来源下拉值：custom 编码为 `custom:<来源索引>`，从而把每个自定义来源作为独立选项 */
const llmTypeSelectModel = computed<string>({
  get: () => {
    const cfg = currentChat.value?.config
    if (!cfg) return ''
    if (cfg.llmType === 'custom') {
      const sources = store.AIconfig.llm.custom?.sources || []
      const enabledIdx = (sources as any[])
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => !store.isLlmSourceDisabled('custom', s?.id))
        .map(({ i }) => i)
      let idx = typeof cfg.customSourceIndex === 'number'
        ? cfg.customSourceIndex
        : (store.AIconfig.llm.custom.activeIndex ?? 0)
      // 绑定的来源可能已被禁用/删除：回退到第一个启用的来源
      if (sources.length && !enabledIdx.includes(idx)) {
        idx = enabledIdx[0] ?? store.AIconfig.llm.custom.activeIndex ?? 0
      }
      return `custom:${idx}`
    }
    return cfg.llmType
  },
  set: (val: string) => {
    const chat = currentChat.value
    if (!chat) return
    if (typeof val === 'string' && val.startsWith('custom:')) {
      chat.config.llmType = 'custom'
      chat.config.customSourceIndex = parseInt(val.slice('custom:'.length), 10) || 0
    } else {
      chat.config.llmType = val
      chat.config.customSourceIndex = undefined
    }
    onModelTypeChange()
  },
})


// ==================== 发送消息 - 统一入口 ====================

/**
 * 把「运行中引导」记录进**正在执行的那条助手消息的时间线**（紧跟已产生的步骤之后，
 * 之后生成的步骤自然排在它下面）——比另发一条用户气泡更直观：引导就出现在它生效的位置。
 */
const insertGuidanceUnit = (chat: any, text: string): boolean => {
  const msgs = (chat?.messages || []).filter((m: any) =>
    m && m.role === 'assistant' && m.isExecuting === true &&
    (m.executionType === 'skill' || m.swarmAgent)
  )
  const target = msgs[msgs.length - 1]
  if (!target) return false
  const now = Date.now()
  const unit = {
    id: `guidance-${now}`,
    status: 'success' as const,
    stepType: 'guidance' as any,
    description: 'user-guidance',
    result: text,
    startTime: now,
    endTime: now,
  }
  target.executionUnits = [...(target.executionUnits || []), unit]
  return true
}

/**
 * 运行中「引导」发送（steer）：当前聊天有正在执行的智能体/集群会话时，把输入框内容投递给它——
 * **下一个 step 边界生效，不打断当前执行**（对齐主流 agent 客户端：运行中也能补充要求）。
 * 返回 true 表示本次输入已按「引导」处理（调用方结束发送流程）；false 表示按正常发送处理。
 */
const trySteerRunningAgent = async (): Promise<boolean> => {
  if (!canSteerRun.value) return false
  const raw = inputText.value.trim()
  if (!raw && currentUploads.value.length === 0) return false

  const chat = currentChat.value
  const { content: msgContent, images, fileAttachments } = buildUserMessageFromUploads(raw)
  // 图片（多模态附图）无法随 steer 投递（引导只带文本）：提示等本轮结束后再发，避免被静默丢弃
  if (images && images.length > 0) {
    ElMessage.warning(store.locales == 'zh'
      ? '智能体运行中不支持发送图片引导，请等本轮结束后再发送'
      : 'Images cannot be sent as guidance while the agent is running — wait for this run to end')
    return true
  }
  // 附件正文与智能体模式同格式前置（steer 只带文本，把文件内容带进引导里）
  const fileBlocks = (fileAttachments || []).map(f =>
    `[文件: ${f.name} (${f.charCount}字)]\n\`\`\`\n${f.content}\n\`\`\``
  )
  const fileContext = fileBlocks.join('\n\n')
  const steerText = fileContext ? (msgContent ? `${fileContext}\n\n${msgContent}` : fileContext) : msgContent
  if (!steerText.trim()) return false
  // 时间线上展示的文本：用户实际输入（没打字只传文件时列出文件名，避免一片空白）
  const displayText = msgContent.trim()
    || (fileAttachments?.length ? fileAttachments.map(f => f.name).join('、') : '')

  const delivered = await steerRunningAgents(chat, steerText)
  if (delivered === 0) {
    // 本轮刚好结束（或正在停止）：引导无处投递。
    // 若该聊天已解锁 → 交回正常发送流程（本条输入作为新一轮任务发出）；
    // 仍在执行中（停止中/状态未回）→ 保留输入并提示，稍后重发即可。
    const stillRunning = isExecuting.value || (chat.mode === 'swarm' && swarmRunning.value)
    if (!stillRunning) return false
    ElMessage.info(store.locales == 'zh'
      ? '智能体刚好结束了本轮，引导未投递；请稍后重新发送'
      : 'The agent just finished this round, guidance not delivered — please resend')
    return true
  }

  // 记进「正在执行的那条助手消息」的时间线（紧跟已产生的步骤，后续步骤排在它下面）
  insertGuidanceUnit(chat, displayText || steerText)
  inputText.value = ''
  currentUploads.value = []
  autoScrollEnabled.value = true
  scrollToBottom()
  saveChats()
  ElMessage.success(store.locales == 'zh'
    ? '已作为引导发送：智能体将在下一轮（下一个 step）带上这条要求'
    : 'Sent as guidance — the agent will pick it up in its next round')
  return true
}

const sendMessage = async () => {
  const message = inputText.value.trim()

  // 智能体/集群运行中：输入作为「引导」投递（下一个 step 生效，不打断本轮）
  if (await trySteerRunningAgent()) return

  // 仅拦截「当前对话」执行中：A 对话在后台推理时，切到 B 应能正常输入发送
  // （isAnyExecuting 是全局的，若用它拦截，任何对话执行时其它对话都无法发送）
  if (isExecuting.value) {
    return
  }
  
  if (!currentChat.value.config.model) {
    console.log('请先选择模型')
    return
  }
  
  if (!message && currentUploads.value.length === 0) {
    console.log('请输入消息或上传文件')
    return
  }
  
  // 集群模式：模型来自各成员的 Agent 预设（群主用全局设置），与当前对话的模型配置无关 → 跳过连接检查
  if (currentChat.value.mode !== 'swarm' && !currentChat.value.online) {
    if(!testCurrentModelConnection()){
      try {
        await ElMessageBox.confirm('模型未连接，是否继续发送？', '提示', {
          confirmButtonText: '继续发送',
          cancelButtonText: '取消',
          type: 'warning'
        })
      } catch { return }
    }
  }

  // 根据当前聊天模式处理（技能模式已并入「智能体」：mode='skill' 的旧存档统一走 agent 循环）
  switch (currentChat.value.mode) {
    case 'swarm':
      await handleSwarmMode(message)
      break
    case 'skill':
    case 'agent2':
      await handleAgentLoopMode(message)
      break
    case 'agent':
      await handleAgentMode(message)
      break
    case 'code':
      await handlePtcMode(message)
      break
    case 'workflow':
      await runWorkflow(message)
      break
    case 'retrieval':
      await sendChatMessage(message)
      break
    default:
      await sendChatMessage(message)
  }
}

// ==================== Agent 循环模式（agent2）/ 技能新路径 / 预设工具 ====================
// 执行逻辑已抽到 composables/useAgentRun.ts（此处仅接线，名称保持与模板一致）
const {
  buildAgentProviderConfig,
  attachAgentToChat,
  startAgentSessionInChat,
  handleAgentLoopMode,
  handleAgentPresetMode,
  handlePtcMode,
  steerRunningAgents,
  reconcileAgentRuns,
  stopAgentsInChat,
  disposeAgentRun,
} = useAgentRun({
  getCurrentChat: () => currentChat.value,
  saveChats,
  scrollToBottom,
  scheduleAutoScroll,
  buildUserMessageFromUploads,
  inputText,
  currentUploads,
  autoScrollEnabled,
  skillManager,
  onSkillList: () => handleSkillList(),
  onSkillHelp: (name: string) => handleSkillHelp(name),
  generateChatTitle: (firstResponse: string, chat?: any) => generateChatTitle(firstResponse, chat),
  // 智能体运行结束：清空步骤指示器（避免 step-success 等残留显示）
  clearStepIndicator: () => {
    globalExecutionState.value.currentStep = ''
    globalExecutionState.value.stepIcon = ''
    globalExecutionState.value.stepIndicatorClass = ''
  },
})

/** Agent 预设模式发送：已迁移到 agent 循环 + 统一工具注册表（useAgentRun.handleAgentPresetMode）。
 *   systemPrompt = 预设提示（角色 + 知识库能力说明），能力槽 → 工具白名单，
 *   kbPaths = 预设关联知识库，seedHistory = 聊天历史种子保持上下文。 */
const handleAgentMode = async (message: string) => {
  const preset = store.agentPresets.find((c: any) => c.id === currentChat.value.config.presetId)
  if (!preset) return
  await handleAgentPresetMode(message, preset)
}


// ==================== 工作流相关函数 ====================

const initWorkflowRunner = () => {
  if (!currentChat.value.config.workflowData) {
    globalExecutionState.value.workflowRunner = null
    return
  }
  // 该聊天的工作流正在后台执行（切模块未中断）时复用现有 runner，避免重复创建
  const runningWorkflowMsg = currentChat.value.messages.find(m => m.isExecuting && m.executionType === 'workflow')
  if (runningWorkflowMsg && globalExecutionState.value.workflowRunner) {
    return
  }
  
  const callbacks: ExecutionCallback = {
    onNodeStart: (nodeId, nodeName, nodeType) => {
      console.log(`工作流节点开始: ${nodeName} (${nodeType})`)
      
      const messages = currentChat.value.messages
      const workflowMessage = messages.find(msg => msg.isExecuting && msg.executionType === 'workflow')
      
      if (workflowMessage && workflowMessage.executionUnits) {
        const existingIndex = workflowMessage.executionUnits.findIndex(u => u.id === nodeId)
        const unit: WorkflowUnit = {
          id: nodeId,
          name: nodeName,
          nodeType: nodeType,
          status: 'running',
          startTime: Date.now()
        }
        
        if (existingIndex !== -1) {
          workflowMessage.executionUnits.splice(existingIndex, 1, { ...workflowMessage.executionUnits[existingIndex], ...unit })
        } else {
          workflowMessage.executionUnits.push(unit)
        }
        
        workflowMessage.executionUnits = [...workflowMessage.executionUnits]
        
        workflowMessage.executionProgress = {
          completed: workflowMessage.executionUnits.filter(u => u.status === 'success' || u.status === 'error').length,
          total: currentChat.value.config.workflowData!.items.length
        }
      }
      
      setStep(`执行节点: ${nodeName}`, 'fa fa-cog fa-spin', 'step-executing')
      scrollToBottom()
    },
    
    onNodeComplete: (nodeId, nodeName, nodeType, status, result) => {
      console.log(`工作流节点完成: ${nodeName} - ${status}`, result)
      
      const messages = currentChat.value.messages
      const workflowMessage = messages.find(msg => msg.isExecuting && msg.executionType === 'workflow')
      
      if (workflowMessage && workflowMessage.executionUnits) {
        const nodeIndex = workflowMessage.executionUnits.findIndex(u => u.id === nodeId)
        if (nodeIndex !== -1) {
          const unit = workflowMessage.executionUnits[nodeIndex] as WorkflowUnit
          const updatedUnit: WorkflowUnit = {
            ...unit,
            status: (status === 'idle' ? 'pending' : status) as 'pending' | 'running' | 'success' | 'error',
            endTime: Date.now()
          }
          
          if (result) {
            try {
              const parsedResult = JSON.parse(result)
              if (parsedResult.result) {
                if (nodeType === 'reasoning' || nodeType === 'python') {
                  updatedUnit.resultPreview = typeof parsedResult.result === 'string' 
                    ? parsedResult.result
                    : JSON.stringify(parsedResult.result, null, 2)
                } else {
                  updatedUnit.resultPreview = typeof parsedResult.result === 'string' 
                    ? parsedResult.result.substring(0, 200) + (parsedResult.result.length > 200 ? '...' : '')
                    : JSON.stringify(parsedResult.result).substring(0, 200) + '...'
                }
              } else {
                if (nodeType === 'python') {
                  updatedUnit.resultPreview = typeof result === 'string' ? result : String(result)
                } else {
                  updatedUnit.resultPreview = typeof result === 'string' 
                    ? result.substring(0, 300)
                    : String(result).substring(0, 300)
                }
              }
            } catch {
              if (nodeType === 'python') {
                updatedUnit.resultPreview = typeof result === 'string' ? result : String(result)
              } else {
                updatedUnit.resultPreview = typeof result === 'string' 
                  ? result.substring(0, 300)
                  : String(result).substring(0, 300)
              }
            }
          }
          
          workflowMessage.executionUnits.splice(nodeIndex, 1, updatedUnit)
          workflowMessage.executionUnits = [...workflowMessage.executionUnits]
        }
        
        workflowMessage.executionProgress = {
          completed: workflowMessage.executionUnits.filter(u => u.status === 'success' || u.status === 'error').length,
          total: currentChat.value.config.workflowData!.items.length
        }
      }
      
      scrollToBottom()
    },
    
    onNodeStatusUpdate: (nodeId, status, result) => {
      if (result) {
        try {
          const parsedResult = JSON.parse(result)
          // 修复1: 确保流式内容正确累积，不重复
          if (parsedResult.streaming && parsedResult.result) {
            const messages = currentChat.value.messages
            const workflowMessage = messages.find(msg => msg.isExecuting && msg.executionType === 'workflow')
            
            if (workflowMessage && workflowMessage.executionUnits) {
              const nodeIndex = workflowMessage.executionUnits.findIndex(u => u.id === nodeId)
              if (nodeIndex !== -1) {
                const unit = workflowMessage.executionUnits[nodeIndex] as WorkflowUnit
                if (unit.nodeType === 'reasoning') {
                  // 修复: 检查是否是重复发送，通过比较长度避免重复
                  const newContent = parsedResult.result
                  if (!unit.streamContent) {
                    unit.streamContent = ''
                  }
                  
                  // 避免重复累积 - 如果新内容不是现有内容的简单追加，则替换
                  // 这可以防止由于网络问题导致的内容重叠
                  if (!unit.streamContent.endsWith(newContent) && newContent.length > unit.streamContent.length) {
                    unit.streamContent = newContent
                  }
                  
                  unit.resultPreview = unit.streamContent
                  
                  if (unit.resultPreview && unit.resultPreview.length > 5000) {
                    unit.resultPreview = unit.resultPreview.substring(0, 5000) + '...'
                  }
                  
                  workflowMessage.executionUnits[nodeIndex] = { ...unit }
                  workflowMessage.executionUnits = [...workflowMessage.executionUnits]
                }
              }
            }
          }
        } catch {}
      }
    },
    
    onPythonError: (nodeId, nodeName, error, traceback) => {
      console.error(`工作流Python节点错误: ${nodeName} - ${error}`)
      
      const messages = currentChat.value.messages
      const workflowMessage = messages.find(msg => msg.isExecuting && msg.executionType === 'workflow')
      
      if (workflowMessage && workflowMessage.executionUnits) {
        const nodeIndex = workflowMessage.executionUnits.findIndex(u => u.id === nodeId)
        if (nodeIndex !== -1) {
          const updatedUnit = {
            ...workflowMessage.executionUnits[nodeIndex],
            error: error
          }
          workflowMessage.executionUnits.splice(nodeIndex, 1, updatedUnit)
          workflowMessage.executionUnits = [...workflowMessage.executionUnits]
        }
      }
      
      if (!workflowMessage?.executionStats) {
        workflowMessage!.executionStats = { total: 0, success: 0, failed: 0, time: 0, errors: [] }
      }
      if (!workflowMessage!.executionStats.errors) {
        workflowMessage!.executionStats.errors = []
      }
      workflowMessage!.executionStats.errors.push({
        id: nodeId,
        name: nodeName,
        error: error
      })
    },
    
    onDecisionBranchSelected: (nodeId, nodeName, branchId, branchName, reason) => {
      console.log(`决策节点分支选择: ${nodeName} -> ${branchName} (${branchId})`)
      
      const messages = currentChat.value.messages
      const workflowMessage = messages.find(msg => msg.isExecuting && msg.executionType === 'workflow')
      
      if (workflowMessage && workflowMessage.executionUnits) {
        const nodeIndex = workflowMessage.executionUnits.findIndex(u => u.id === nodeId)
        if (nodeIndex !== -1) {
          const unit = workflowMessage.executionUnits[nodeIndex] as WorkflowUnit
          const updatedUnit = {
            ...unit,
            decisionInfo: `${store.locales=='zh' ? '选择分支: ' : 'Selected branch: '}${branchName}`
          }
          workflowMessage.executionUnits.splice(nodeIndex, 1, updatedUnit)
          workflowMessage.executionUnits = [...workflowMessage.executionUnits]
        }
      }
      
      scrollToBottom()
    },
    
    onProgress: (completed, total, currentNode) => {
      const messages = currentChat.value.messages
      const workflowMessage = messages.find(msg => msg.isExecuting && msg.executionType === 'workflow')
      
      if (workflowMessage) {
        workflowMessage.executionProgress = {
          completed,
          total
        }
      }
    },
    
    onComplete: (success, finalResult, aggregatedResults) => {
      const messages = currentChat.value.messages
      const workflowMessageIndex = messages.findIndex(msg => msg.isExecuting && msg.executionType === 'workflow')
      
      if (workflowMessageIndex !== -1) {
        const workflowMessage = messages[workflowMessageIndex]
        workflowMessage.isExecuting = false
        workflowMessage.content = success ? finalResult : `${store.locales=='zh' ? '工作流执行失败: ' : 'Workflow execution failed: '} ${finalResult}`
        workflowMessage.executionTime = Date.now() - workflowStartTime.value
        
        if (success && aggregatedResults && aggregatedResults.executionStats) {
          workflowMessage.executionStats = {
            total: aggregatedResults.executionStats.totalNodes,
            success: aggregatedResults.executionStats.completedNodes,
            failed: aggregatedResults.executionStats.failedNodes,
            time: aggregatedResults.executionStats.executionTime,
            errors: aggregatedResults.executionStats.errors
          }
        }
      }
      
      if (!success) {
        workflowError.value = true
      }
      
      globalExecutionState.value = {
        ...globalExecutionState.value,
        isExecuting: false,
        executionType: null,
        chatId: null,
        currentStep: '',
        stepIcon: '',
        stepIndicatorClass: ''
      }
      
      saveChats()
      
      setStep(success ? (store.locales=='zh' ? '工作流执行完成' : 'Workflow execution completed') : (store.locales=='zh' ? '工作流执行失败' : 'Workflow execution failed'), 
              success ? 'fa fa-check-circle' : 'fa fa-exclamation-circle', 
              success ? 'step-success' : 'step-error')
      
      setTimeout(() => {
        setStep('', '', '')
      }, 3000)
      
      scrollToBottom()
    },
    
    onLog: (message, level) => {
      //console.log(`[工作流 ${level}] ${message}`)
    }
  }
  
  globalExecutionState.value.workflowRunner = new WorkflowRunner(
    currentChat.value.config.workflowData,
    store,
    callbacks
  )
}

const workflowStartTime = workflowStartTimeRef

const validateWorkflow = async (): Promise<boolean> => {
  if (!globalExecutionState.value.workflowRunner || !currentChat.value.config.workflowData) {
    return false
  }
  
  try {
    const workflowData = currentChat.value.config.workflowData
    
    if (!workflowData.items || !Array.isArray(workflowData.items)) {
      throw new Error('无效的工作流文件格式')
    }
    
    const nodeTypes = new Set(workflowData.items.map((item: any) => item.type))
    const requiredTypes = ['start', 'end']
    
    for (const type of requiredTypes) {
      if (!nodeTypes.has(type)) {
        throw new Error(`工作流缺少${type}节点`)
      }
    }
    
    if (!workflowData.links || !Array.isArray(workflowData.links)) {
      throw new Error('工作流连接数据无效')
    }
    
    return true
  } catch (error: any) {
    console.error('工作流验证失败:', error)
    workflowError.value = true
    return false
  }
}

const runWorkflow = async (userInput: string) => {
  if (!globalExecutionState.value.workflowRunner || !currentChat.value.config.workflowData) {
    ElMessage.warning('工作流未正确初始化')
    return
  }
  
  const chatId = currentChat.value.id
  const currentChatData = currentChat.value
  
  workflowError.value = false
  
  globalExecutionState.value = {
    ...globalExecutionState.value,
    isExecuting: true,
    executionType: 'workflow',
    chatId: chatId
  }
  
  // 用户消息
  const { content: msgContent, images, fileAttachments } = buildUserMessageFromUploads(userInput)
  const userMessage: ChatMessage = {
    role: 'user',
    content: msgContent,
    timestamp: Date.now(),
    images,
    fileAttachments
  }
  currentChatData.messages.push(userMessage)
  currentUploads.value = []
  inputText.value = ''
  autoScrollEnabled.value = true
  scrollToBottom()
  
  // 节点消息映射：nodeId → 占位消息对象
  const nodeMessages = new Map<number, ChatMessage>()
  
  // 保存原回调引用
  const runner = globalExecutionState.value.workflowRunner
  
  // 构建带文件内容的工作流输入
  let workflowInput = userInput
  if (userMessage.fileAttachments && userMessage.fileAttachments.length > 0) {
    const fileBlocks = userMessage.fileAttachments.map(f =>
      `[文件: ${f.name} (${f.charCount}字)]\n\`\`\`\n${f.content}\n\`\`\``
    )
    const fileContext = fileBlocks.join('\n\n')
    workflowInput = userInput ? `${fileContext}\n\n${userInput}` : fileContext
  }

  try {
    workflowStartTime.value = Date.now()
    
    if (!runner?.setStartNodeInput(workflowInput)) {
      throw new Error('设置起始节点输入失败')
    }
    
    // 临时替换回调以实现每步独立消息框
    const stepCallbacks: ExecutionCallback = {
      onNodeStart: (nodeId, nodeName, nodeType) => {
        // 开始/结束节点不创建消息框（开始节点即用户输入，结束节点内容冗余）
        if (nodeType === 'start' || nodeType === 'end') return
        
        // 创建该节点独立的占位消息
        const stepMsg: ChatMessage = {
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          executionType: 'workflow',
          isExecuting: true,
          executionName: nodeName
        }
        currentChatData.messages.push(stepMsg)
        nodeMessages.set(nodeId, stepMsg)
        
        setStep(`执行节点: ${nodeName}`, 'fa fa-cog fa-spin', 'step-executing')
        scrollToBottom()
      },
      
      onNodeStream: (nodeId, chunk, accumulated) => {
        const stepMsg = nodeMessages.get(nodeId)
        if (stepMsg) {
          stepMsg.content = accumulated
          stepMsg.streaming = true
          const idx = currentChatData.messages.findIndex(m => m.timestamp === stepMsg.timestamp)
          if (idx !== -1) {
            currentChatData.messages[idx] = { ...stepMsg }
          }
          scheduleAutoScroll()
        }
      },
      
      onNodeComplete: (nodeId, nodeName, nodeType, status, result) => {
        // 开始/结束节点不管
        if (nodeType === 'start' || nodeType === 'end') return
        
        const stepMsg = nodeMessages.get(nodeId)
        if (stepMsg) {
          if (!stepMsg.content && result) {
            try {
              const parsed = typeof result === 'string' ? JSON.parse(result) : result
              stepMsg.content = parsed.result || parsed.response || JSON.stringify(parsed)
              
              // 知识检索节点：提取相关片段到 kbInfo
              if (nodeType === 'knowledge' && parsed.relevantBlocks) {
                stepMsg.kbInfo = {
                  kbPath: parsed.kbPath || '',
                  relevantBlocks: parsed.relevantBlocks.map((b: any) => ({
                    label: b.metadata?.source || b.label || '',
                    content: b.text || b.content || '',
                    similarity: b.similarity || 0
                  }))
                }
              }
            } catch {
              stepMsg.content = String(result)
            }
          }
          stepMsg.isExecuting = false
          stepMsg.streaming = false
          const idx = currentChatData.messages.findIndex(m => m.timestamp === stepMsg.timestamp)
          if (idx !== -1) {
            currentChatData.messages[idx] = { ...stepMsg }
          }
        }
      }
    }
    
    // 保存原回调，替换为每步独立消息框的回调
    const origCallbacks = runner.callbacks
    runner.callbacks = stepCallbacks
    
    await runner.run()
    
    // 恢复原回调
    runner.callbacks = origCallbacks

    // 生成聊天标题（取最后一条助理消息的内容；传 currentChatData 以定位实际所属聊天）
    const lastAssistantMsg = [...currentChatData.messages].reverse().find(m => m.role === 'assistant')
    if (lastAssistantMsg?.content) {
      generateChatTitle(lastAssistantMsg.content, currentChatData)
    }
    
  } catch (error: any) {
    console.error('运行工作流失败:', error)
    
    // 如果有正在执行的节点消息，标记为失败
    for (const [, stepMsg] of nodeMessages) {
      if (stepMsg.isExecuting) {
        stepMsg.isExecuting = false
        stepMsg.content = stepMsg.content || `${store.locales=='zh' ? '执行失败: ' : 'Failed: '} ${error.message}`
        const idx = currentChatData.messages.findIndex(m => m.timestamp === stepMsg.timestamp)
        if (idx !== -1) {
          currentChatData.messages[idx] = { ...stepMsg }
        }
      }
    }
    
    workflowError.value = true
    
    globalExecutionState.value = {
      ...globalExecutionState.value,
      isExecuting: false,
      executionType: null,
      chatId: null,
      currentStep: '',
      stepIcon: '',
      stepIndicatorClass: ''
    }
    
    setStep(store.locales=='zh' ? '工作流执行失败' : 'Workflow execution failed', 'fa fa-exclamation-circle', 'step-error')
    setTimeout(() => {
      setStep('', '', '')
    }, 3000)
  } finally {
    globalExecutionState.value = {
      ...globalExecutionState.value,
      isExecuting: false,
      executionType: null,
      chatId: null
    }
    saveChats()
    scrollToBottom()
  }
}

// ==================== 普通聊天消息发送（包含检索模式） ====================

// 生成主进程 AI 会话 id
const genRequestId = (): string => {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

// 完成一条助手回复：写入最终内容 + token 统计 + 清理生成状态（发送与续接共用）
const completeAssistantReply = (chatData: any, content: string, metadata?: any) => {
  flushStreamRender()
  const lastMessage = chatData.messages[chatData.messages.length - 1]
  if (lastMessage?.role === 'assistant') {
    // 深度思考：把 <think>…</think> 从正文剥离，单独存 reasoning（供折叠展示 / 标题 / 统计），
    // 正文不再带标签，避免把思考内容污染历史与后续上下文回传
    const split = splitThinkText(content || '')
    content = split.content
    lastMessage.content = content
    if (split.reasoning) lastMessage.reasoning = split.reasoning
    lastMessage.streaming = false
    // 兜底：只要模型回复已结束，就关闭正在执行的 spinner；不再依赖 update_todo 是否同步更新。
    lastMessage.isExecuting = false

    // 记录 Token 统计（优先用 API 返回的 metadata，否则估算）
    if (metadata) {
      const promptTokens = metadata.prompt_tokens || metadata.promptTokens || 0
      const completionTokens = metadata.completion_tokens || metadata.completionTokens || 0
      const totalTokens = metadata.total_tokens || metadata.totalTokens || (promptTokens + completionTokens)
      const duration = Date.now() - (lastMessage._startTime || Date.now())
      const speed = duration > 0 ? (completionTokens / (duration / 1000)) : 0
      lastMessage.tokenStats = {
        promptTokens: promptTokens || 0,
        completionTokens: completionTokens || 0,
        totalTokens: totalTokens || 0,
        speed: speed || 0,
        duration: duration || 0
      }
    } else {
      const duration = Date.now() - (lastMessage._startTime || Date.now())
      const estimatedTokens = Math.ceil(content.length / 4)
      lastMessage.tokenStats = {
        promptTokens: 0,
        completionTokens: estimatedTokens || 0,
        totalTokens: estimatedTokens || 0,
        speed: duration > 0 ? (estimatedTokens / (duration / 1000)) : 0,
        duration: duration || 0
      }
    }
    delete lastMessage._startTime
  }

  // 只要标题为空，且当前会话已有用户与助手消息，就应在首条有效回复完成时自动命名。
  // 不能再把条件绑死在“恰好两条消息”上，否则带工具、附件、流程步骤的聊天会永远跳过命名。
  if (!chatData.title && chatData.messages.some((m: any) => m.role === 'user') && chatData.messages.some((m: any) => m.role === 'assistant')) {
    generateChatTitle(content, chatData)
  }

  chatData.isGenerating = false
  chatData.activeRequestId = undefined
  chatData.messages.forEach((msg: any) => {
    if (msg?.role === 'assistant' && msg.isExecuting) {
      msg.isExecuting = false
      msg.streaming = false
    }
  })
  retrievalStats.value = null
  globalExecutionState.value.currentStep = ''
  globalExecutionState.value.stepIcon = ''
  globalExecutionState.value.stepIndicatorClass = ''
  globalExecutionState.value.abortController = null
  saveChats()
  scrollToBottom()
  void nextTick(() => {
    refreshRenderedMermaid()
    scheduleMermaidRender(true, 60)
  })
}

// 重进模块时续接生成：用主进程按 requestId 缓冲的完整/部分回答恢复前端显示
/**
 * 解析 Qwen3/vLLM 深度思考的内联 <think>…</think> 标签（兼容流式中未闭合的段）：
 * - content：剥离思考后的正文；reasoning：思考文本（未闭合时开放标签后的内容都算思考）
 */
function splitThinkText(raw: string): { content: string; reasoning: string } {
  const text = String(raw || '')
  const openIdx = text.search(/<think>/i)
  if (openIdx === -1) {
    const closeIdx = text.search(/<\/think>/i)
    // 畸形输出兼容（GPUStack/vLLM 对 Qwen3 显式 enable_thinking 时只给 </think> 收尾、丢 <think> 开标签）：
    // 首个 </think> 之前的内容视为思考，其后为正文
    if (closeIdx === -1) return { content: text, reasoning: '' }
    return {
      content: text.slice(closeIdx + 8).replace(/<\/think>/gi, ''),
      reasoning: text.slice(0, closeIdx),
    }
  }
  const re = /<\/?think>/gi
  let content = ''
  let reasoning = ''
  let depth = 0
  let last = 0
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(text))) {
    const seg = text.slice(last, m.index)
    if (depth > 0) reasoning += seg
    else content += seg
    if (m[0].startsWith('</')) depth = Math.max(0, depth - 1)
    else depth++
    last = m.index + m[0].length
  }
  const tail = text.slice(last)
  if (depth > 0) reasoning += tail // 思考未闭合（仍在流式），尾部也属于思考
  else content += tail
  return { content, reasoning }
}
/** 消息可展示的思考文本：优先已归一化的 reasoning；旧格式（content 仍带 think 标签）现场拆分。
 * 兼容 GPUStack/vLLM 畸形输出（丢 <think> 开标签、只留 </think>）：把首个 </think> 前内容当思考 */
const renderedReasoning = (msg: any): string => {
  if (!msg || msg.role !== 'assistant') return ''
  if (msg.reasoning) return msg.reasoning
  const c = typeof msg.content === 'string' ? msg.content : ''
  return /<\/?think>/i.test(c) ? splitThinkText(c).reasoning : ''
}
/** 消息可展示的正文：剥离 think 标签（含畸形只收尾形态）后的内容（历史/流式均正确显示） */
const renderedContent = (msg: any): string => {
  if (!msg) return ''
  const c = typeof msg.content === 'string' ? msg.content : ''
  if (msg.reasoning || !/<\/?think>/i.test(c)) return c
  return splitThinkText(c).content
}
/** 思考块折叠状态：用户手动点过以手动为准；否则“思考中（未出正文）展开可见，出结果后自动折叠” */
const isMsgThinkCollapsed = (msg: any): boolean => {
  if (!msg) return true
  if (msg.thinkCollapsed !== undefined) return !!msg.thinkCollapsed
  // 未手动操作过：有正文（已出结果）→ 折叠；仍在思考（无正文）→ 展开以便实时查看思考过程
  const hasResult = renderedContent(msg).trim() !== ''
  return hasResult
}
const toggleMsgThinkCollapsed = (msg: any) => {
  if (!msg) return
  // 基于当前实际折叠态取反并显式固化（此后以手动选择为准，不再随流式自动切换）
  msg.thinkCollapsed = !isMsgThinkCollapsed(msg)
}
const resumeActiveChat = async () => {
  // 仅 Electron 模式有主进程会话可续接；浏览器/LAN 模式无主进程，跳过
  if (typeof window === 'undefined' || !window.ipcRenderer) return

  // 定位生成中的聊天：当前聊天未在生成时，扫描其它聊天（上次切走时正在生成的）
  let chat = currentChat.value
  let requestId = chat?.activeRequestId
  if (!requestId || !chat?.isGenerating) {
    const idx = chats.value.findIndex(c => c.isGenerating && c.activeRequestId)
    if (idx !== -1) {
      currentChatIndex.value = idx
      chat = chats.value[idx]
      requestId = chat?.activeRequestId
    }
  }
  if (!chat?.isGenerating || !requestId) return

  const lastMessage = chat.messages[chat.messages.length - 1]
  if (!lastMessage || lastMessage.role !== 'assistant') return

  const snap: any = await AIUtils.getSession(requestId).catch(() => null)
  if (!snap) {
    // 主进程会话已不存在（如过期清理）
    chat.isGenerating = false
    chat.activeRequestId = undefined
    if (!lastMessage.content) {
      lastMessage.content = store.locales=='zh' ? '（会话已失效，请重新提问）' : '(session expired, please retry)'
    }
    saveChats()
    return
  }

  const controller = new AbortController()
  globalExecutionState.value.abortController = controller

  const callbacks: any = {
    onStream: (chunk: string) => {
      const last = chat.messages[chat.messages.length - 1]
      if (last?.role === 'assistant') {
        last.content = (last.content || '') + chunk
      }
      scheduleAutoScroll()
      void nextTick(() => refreshRenderedMermaid())
    },
    onSearchStatus: (info: any) => {
      const lastMsg = chat.messages[chat.messages.length - 1]
      if (lastMsg && lastMsg.role === 'assistant') {
        lastMsg.webSearch = lastMsg.webSearch || { status: 'idle', results: [] }
        if (info.status === 'searching') {
          lastMsg.webSearch.status = 'searching'
          if (info.query) lastMsg.webSearch.query = info.query
        } else if (info.status === 'completed') {
          lastMsg.webSearch.status = 'completed'
          if (info.query) lastMsg.webSearch.query = info.query
          if (info.results && info.results.length > 0) {
            const existing = lastMsg.webSearch.results || []
            const seen = new Set(existing.map((r: any) => r?.url))
            const merged = [...existing]
            info.results.forEach((r: any) => {
              if (r?.url) {
                if (!seen.has(r.url)) {
                  seen.add(r.url)
                  merged.push(r)
                }
              } else if (!existing.includes(r)) {
                merged.push(r)
              }
            })
            lastMsg.webSearch.results = merged
            enrichWebSearchTitles(merged)
          }
        }
      }
      if (autoScrollEnabled.value) {
        void nextTick(() => scrollToBottom())
      }
    },
    onReasoning: (text: string) => {
      const lastMsg = chat.messages[chat.messages.length - 1]
      if (lastMsg?.role === 'assistant') {
        ;(lastMsg as any).reasoning = text
      }
    },
    onToolCalls: (calls: any[]) => {
      const lastMsg = chat.messages[chat.messages.length - 1]
      if (lastMsg?.role === 'assistant') {
        ;(lastMsg as any).toolCalls = calls
      }
    },
    onComplete: (content: string, metadata?: any) => {
      // 若期间用户已手动停止 / 已开始新一轮生成，丢弃旧会话收尾，避免覆盖新消息
      if (chat.activeRequestId !== requestId) return
      completeAssistantReply(chat, content, metadata)
    },
    onError: (error: Error) => {
      console.error('续接失败:', error)
      const lastMsg = chat.messages[chat.messages.length - 1]
      if (lastMsg?.role === 'assistant' && !lastMsg.content) {
        lastMsg.content = '抱歉，续接失败：' + error.message
      }
      chat.isGenerating = false
      chat.activeRequestId = undefined
      retrievalStats.value = null
      globalExecutionState.value.currentStep = ''
      globalExecutionState.value.stepIcon = ''
      globalExecutionState.value.stepIndicatorClass = ''
      globalExecutionState.value.abortController = null
      saveChats()
    },
    signal: controller.signal
  }

  if (snap.status === 'completed' || snap.status === 'aborted') {
    // 已完成：直接回放最终结果
    if (snap.toolCalls?.length) callbacks.onToolCalls?.(snap.toolCalls)
    if (snap.searchResults?.length) callbacks.onSearchStatus?.({ status: 'completed', results: snap.searchResults })
    if (snap.reasoning) callbacks.onReasoning?.(snap.reasoning)
    completeAssistantReply(chat, snap.content || '', snap.metadata)
  } else if (snap.status === 'error') {
    callbacks.onError(new Error(snap.error || 'AI 请求失败'))
  } else {
    // running：先用主进程缓冲的部分内容覆盖本地，再挂接实时监听继续接收
    if (snap.content) lastMessage.content = snap.content
    if (snap.searchResults?.length) callbacks.onSearchStatus?.({ status: 'completed', results: snap.searchResults })
    chat.isGenerating = true
    setStep(store.locales=='zh' ? '正在续接生成中...' : 'Resuming generation...', 'fa fa-refresh fa-spin', 'step-generating')
    AIUtils.attachLiveSession(requestId, callbacks)
  }
}

// 重进模块：恢复后台执行现场（步骤指示、滚动），但不自动跳转到执行中的聊天
// （currentChatIndex 已共享并持久化，回到卸载前所在的聊天栏）
const restoreExecutionView = () => {
  if (globalExecutionState.value.isExecuting && !globalExecutionState.value.currentStep) {
    setStep(
      store.locales=='zh' ? '执行中...' : 'Executing...',
      globalExecutionState.value.executionType === 'workflow' ? 'fa fa-cog fa-spin' : 'fa fa-cubes fa-spin',
      'step-executing'
    )
  }
  scrollToBottom()
}

// 后台执行产生输出（消息内容增长）时：
// - 若输出来自「当前正在查看」的对话 → 滚动到底部（保持查看进度）
// - 若来自其它对话 → 不强制跳转：用户主动切换后应停留在当前对话输入/推理，
//   不会被正在推理的其它对话拉回（侧边栏「后台执行」标识可提示用户自行点回）
const backgroundOutputLens: Record<string, number> = {}
watch(
  () => chats.value.map(c => {
    const executing = c.isGenerating ||
      (Array.isArray(c.messages) && c.messages.some((m: any) => m.isExecuting))
    const contentLen = (Array.isArray(c.messages) ? c.messages : [])
      .reduce((s: number, m: any) => s + (m.content ? m.content.length : 0), 0)
    return { id: c.id, executing, contentLen }
  }),
  (arr) => {
    for (const item of arr) {
      const prevLen = backgroundOutputLens[item.id] ?? item.contentLen
      if (item.executing && item.contentLen > prevLen) {
        // 仅当前查看的对话自身有输出时滚动；其它对话只记录长度，不切换 currentChatIndex
        if (item.id === currentChat.value?.id) {
          scrollToBottom()
        }
      }
      backgroundOutputLens[item.id] = item.contentLen
    }
  }
)

const sendChatMessage = async (message: string) => {
  const currentChatData = currentChat.value
  
  const { content: msgContent, images, fileAttachments } = buildUserMessageFromUploads(message)
  const userMessage: ChatMessage = {
    role: 'user',
    content: msgContent,
    timestamp: Date.now(),
    images,
    fileAttachments
  }
  
  currentChatData.messages.push(userMessage)
  currentChatData.isGenerating = true
  
  // 设置初始状态
  setStep(store.locales=='zh' ? '正在发送请求...' : 'Sending request...', 'fa fa-paper-plane', 'step-sending')
    // 新一轮请求开始：清掉上一次的系统错误提示
    systemErrorText.value = ''
  inputText.value = ''
  currentUploads.value = []
  
  autoScrollEnabled.value = true
  scrollToBottom()

  const originalType = store.AIconfig.llm.type
  const originalModel = getCurrentModelFromStore()
  // 快照自定义来源扁平配置（发送后恢复，避免聊天绑定的来源污染设置页当前激活来源）
  const originalCustom = originalType === 'custom'
    ? { ...store.AIconfig.llm.custom, available_models: [...(store.AIconfig.llm.custom.available_models || [])] }
    : null
  
  // 快照真实的聊天绑定来源：执行前写入 store 供请求层使用
  store.AIconfig.llm.type = normalizeLlmType(currentChatData.config.llmType)
  if (currentChatData.config.llmType === 'custom') {
    store.applyCustomSourceIndex(currentChatData.config.customSourceIndex)
  }
  updateStoreModelConfig(currentChatData.config)

  const kbPath = currentChatData.config.kbPath
  // 浏览器模式：知识库退化为上传文件（无 kbPath，使用 kbFiles）
  const kbFiles = currentChatData.config.kbFiles
  const browserKbActive = isBrowser && currentChatData.mode === 'retrieval' && !kbPath && kbFiles && kbFiles.length > 0
  let retrievedContext = message
  // 如果有文件附件，将文件内容注入到 LLM 上下文中（不显示在消息气泡中）
  if (userMessage.fileAttachments && userMessage.fileAttachments.length > 0) {
    const fileBlocks = userMessage.fileAttachments.map(f =>
      `[文件: ${f.name} (${f.charCount}字)]\n\`\`\`\n${f.content}\n\`\`\``
    )
    const fileContext = fileBlocks.join('\n\n')
    retrievedContext = message ? `${fileContext}\n\n${message}` : fileContext
  }
  let relevantBlocks: RelevantBlock[] = []
  // 使用局部变量存储 kbInfo，而不是全局变量
  let tempKbInfo: {
    kbPath: string
    relevantBlocks: RelevantBlock[]
    debugInfo?: any
  } | null = null

  // 知识库检索阶段（仅在检索模式且有知识库时）
  if (currentChatData.mode === 'retrieval' && kbPath) {
    try {
      setStep(store.locales=='zh' ? '正在检索知识库...' : `Retrieving knowledge base: ${kbPath}`, 'fa fa-search fa-spin', 'step-retrieving')
      
      const topK = currentChatData.config.kbTopK || 5
      const retrievalStrategy = resolveStrategyId(currentChatData.config.retrievalStrategy || 'similarity')

      // 知识库检索统一走全局 AI 来源（与聊天同一套 provider 配置），
      // 嵌入模型优先用 .kb 文件配置，缺失时回退到当前来源的默认嵌入模型/可用模型
      const _llmCfg = store.AIconfig?.llm
      // 单来源：DeepSeek 只传 'deepseek'，接口样式随 providerConfig.api_style 一起下发
      const _llmType = normalizeLlmType((_llmCfg?.type as string) || 'ollama')
      const _providerCfg = resolveLlmSource(_llmCfg, _llmType).config
      // 嵌入兜底（设置页「嵌入兜底」）：当前来源无嵌入能力时用该来源做向量化（默认 Ollama）
      const _embedFallback = buildEmbedFallbackFromStore(store)
      const retrievalResult = await retrieveKnowledge(
        message,
        kbPath,
        {
          topK: topK,
          summaryWeight: 0.7,
          strategy: retrievalStrategy,
          debug: true,
          llmType: _llmType as any,
          providerConfig: _providerCfg || undefined,
          // 当前来源无嵌入模型时回退到「嵌入兜底」设置的来源（默认 Ollama；聊天仍用当前来源）
          embedFallbackType: _embedFallback?.llmType,
          embedFallbackProviderConfig: _embedFallback?.config,
          embedFallbackModel: _embedFallback?.embed,
          // 环境中缺少 .kb 配置的嵌入模型时：回退到可用模型（并告警维度不一致），避免直接报错
          missingModelStrategy: 'fallback'
        }
      )
      console.log(retrievalResult)
      retrievedContext = retrievalResult.context
      relevantBlocks = retrievalResult.relevantBlocks || []
      
      const lastUserMessageIndex = [...currentChatData.messages].reverse().findIndex(msg => msg.role === 'user')
      if (lastUserMessageIndex !== -1) {
        const actualIndex = currentChatData.messages.length - 1 - lastUserMessageIndex
        const userMsg = currentChatData.messages[actualIndex]
        userMsg.kbInfo = {
          kbPath: kbPath,
          relevantBlocks: relevantBlocks,
          debugInfo: retrievalResult.debugInfo
        }
        
        // 保存到临时变量，用于助理消息
        tempKbInfo = {
          kbPath: kbPath,
          relevantBlocks: relevantBlocks,
          debugInfo: retrievalResult.debugInfo
        }
      }
      
      if (retrievalResult.debugInfo) {
        const debug = retrievalResult.debugInfo
        retrievalStats.value = {
          totalBlocks: debug.totalBlocks,
          returnedBlocks: debug.selectedCount,
          maxSimilarity: `${(debug.similarityStats.max * 100).toFixed(1)}%`,
          averageSimilarity: `${(debug.similarityStats.avg * 100).toFixed(1)}%`
        }
      } else if (relevantBlocks && relevantBlocks.length > 0) {
        const maxSim = Math.max(...relevantBlocks.map(b => b.similarity))
        const avgSim = relevantBlocks.reduce((sum, b) => sum + b.similarity, 0) / relevantBlocks.length
        
        retrievalStats.value = {
          totalBlocks: relevantBlocks.length,
          returnedBlocks: relevantBlocks.length,
          maxSimilarity: `${(maxSim * 100).toFixed(1)}%`,
          averageSimilarity: `${(avgSim * 100).toFixed(1)}%`
        }
      }
      
      setStep(store.locales=='zh' ? '检索完成，正在思考...' : 'Retrieval complete, thinking...', 'fa fa-cog fa-spin', 'step-thinking')
      
    } catch (error) {
      setStep(store.locales=='zh' ? '检索失败，继续思考...' : 'Retrieval failed, continuing thinking...', 'fa fa-exclamation-triangle', 'step-error')
    }
  } else if (isBrowser && currentChatData.mode === 'retrieval' && !kbPath && currentChatData.config.sharedKb?.name) {
    // 浏览器模式：使用主机「局域网共享→知识库目录」中的现有 .kb（由主进程局域网服务完成检索）
    const sharedName = currentChatData.config.sharedKb.name
    setStep(store.locales=='zh' ? `正在检索共享知识库：${sharedName}...` : `Searching shared KB: ${sharedName}...`, 'fa fa-search fa-spin', 'step-retrieving')
    try {
      const topK = currentChatData.config.kbTopK || 5
      const res = await searchSharedKb(sharedName, message, topK)
      retrievedContext = (res && res.context) ? res.context : message
      relevantBlocks = (res?.blocks || []).map((b: any) => ({ label: b.label, content: b.content, similarity: b.similarity }))
      tempKbInfo = {
        kbPath: `shared://${sharedName}`,
        relevantBlocks: relevantBlocks,
        debugInfo: { totalBlocks: res.total, selectedCount: relevantBlocks.length }
      }
      // 挂到用户消息，便于展示召回片段
      const lastUserMessageIndex = [...currentChatData.messages].reverse().findIndex(msg => msg.role === 'user')
      if (lastUserMessageIndex !== -1) {
        const actualIndex = currentChatData.messages.length - 1 - lastUserMessageIndex
        const userMsg = currentChatData.messages[actualIndex]
        userMsg.kbInfo = { ...tempKbInfo }
      }
      const sims = relevantBlocks.map(b => b.similarity)
      retrievalStats.value = {
        totalBlocks: res.total || 0,
        returnedBlocks: relevantBlocks.length,
        maxSimilarity: sims.length ? `${(Math.max(...sims) * 100).toFixed(1)}%` : '0%',
        averageSimilarity: sims.length ? `${((sims.reduce((s, v) => s + v, 0) / sims.length) * 100).toFixed(1)}%` : '0%'
      }
      setStep(store.locales=='zh' ? '共享知识库检索完成，正在思考...' : 'Shared KB retrieved, thinking...', 'fa fa-cog fa-spin', 'step-thinking')
    } catch (e) {
      console.error('共享知识库检索失败:', e)
      setStep(store.locales=='zh' ? '共享知识库检索失败，继续思考...' : 'Shared KB search failed, continue...', 'fa fa-exclamation-triangle', 'step-error')
    }
  } else if (browserKbActive && kbFiles) {
    // 浏览器模式：知识库 = 上传的 .kb（web 模式仅允许 .kb）→ 本地词法检索；
    // 兼容旧存档中非 .kb 文本条目：仅作为兜底整段注入
    const kbEntries = kbFiles.filter(f => (f.name || '').toLowerCase().endsWith('.kb'))
    const legacyEntries = kbFiles.filter(f => !(f.name || '').toLowerCase().endsWith('.kb'))
    let didKbSearch = false
    if (kbEntries.length) {
      setStep(store.locales=='zh' ? '正在本地检索上传的 .kb 知识库...' : 'Searching uploaded .kb locally...', 'fa fa-search fa-spin', 'step-retrieving')
      const topK = currentChatData.config.kbTopK || 5
      try {
        const res = searchUploadedKbTexts(kbEntries.map(e => e.content || ''), message, topK)
        if (res && res.blocks && res.blocks.length) {
          didKbSearch = true
          retrievedContext = res.context
          relevantBlocks = res.blocks.map(b => ({ label: b.label, content: b.content, similarity: b.similarity }))
          tempKbInfo = {
            kbPath: `browser-kb://${kbEntries.map(e => e.name).join(',')}`,
            relevantBlocks,
            debugInfo: { totalBlocks: res.total, selectedCount: relevantBlocks.length, method: res.method }
          }
          const lastUserMessageIndex = [...currentChatData.messages].reverse().findIndex(msg => msg.role === 'user')
          if (lastUserMessageIndex !== -1) {
            const actualIndex = currentChatData.messages.length - 1 - lastUserMessageIndex
            const userMsg = currentChatData.messages[actualIndex]
            userMsg.kbInfo = { ...tempKbInfo }
          }
          const sims = relevantBlocks.map(b => b.similarity)
          retrievalStats.value = {
            totalBlocks: res.total,
            returnedBlocks: relevantBlocks.length,
            maxSimilarity: sims.length ? `${(Math.max(...sims) * 100).toFixed(1)}%` : '0%',
            averageSimilarity: sims.length ? `${((sims.reduce((s, v) => s + v, 0) / sims.length) * 100).toFixed(1)}%` : '0%'
          }
          setStep(store.locales=='zh' ? '本地 .kb 检索完成，正在思考...' : 'Local .kb searched, thinking...', 'fa fa-cog fa-spin', 'step-thinking')
        }
      } catch (e) {
        console.error('本地 .kb 检索失败:', e)
      }
    }
    // 旧存档非 .kb 文本：整段注入兜底（新上传已不再允许此类文件作为知识库）
    if (!didKbSearch && legacyEntries.length) {
      setStep(store.locales=='zh' ? '正在读取旧版知识库内容...' : 'Reading legacy KB content...', 'fa fa-book fa-spin', 'step-retrieving')
      const kbBlocks = legacyEntries.map(f =>
        `[知识库文件: ${f.name} (${f.charCount}字)]\n\`\`\`\n${f.content}\n\`\`\``
      )
      const kbContext = kbBlocks.join('\n\n')
      retrievedContext = message ? `${kbContext}\n\n${message}` : kbContext
      relevantBlocks = legacyEntries.map(f => ({ label: f.name, content: f.content, similarity: 1 }))
      const kbDebugInfo = {
        totalBlocks: legacyEntries.length,
        selectedCount: legacyEntries.length,
        similarityStats: { min: 1, max: 1, avg: 1 }
      }
      tempKbInfo = { kbPath: 'browser-kb', relevantBlocks, debugInfo: kbDebugInfo }
      const lastUserMessageIndex = [...currentChatData.messages].reverse().findIndex(msg => msg.role === 'user')
      if (lastUserMessageIndex !== -1) {
        const actualIndex = currentChatData.messages.length - 1 - lastUserMessageIndex
        const userMsg = currentChatData.messages[actualIndex]
        userMsg.kbInfo = { kbPath: 'browser-kb', relevantBlocks, debugInfo: kbDebugInfo }
      }
      retrievalStats.value = {
        totalBlocks: legacyEntries.length,
        returnedBlocks: legacyEntries.length,
        maxSimilarity: '100%',
        averageSimilarity: '100%'
      }
      setStep(store.locales=='zh' ? '知识库内容已加载，正在思考...' : 'KB loaded, thinking...', 'fa fa-cog fa-spin', 'step-thinking')
    } else if (!didKbSearch) {
      // .kb 检索无命中：不带额外知识上下文直接思考
      setStep(store.locales=='zh' ? '正在思考...' : 'Thinking...', 'fa fa-cog fa-spin', 'step-thinking')
    }
  } else {
    setStep(store.locales=='zh' ? '正在思考...' : 'Thinking...', 'fa fa-cog fa-spin', 'step-thinking')
  }
  
  // 生成主进程 AI 会话 id：切模块/中断后重进时用该 id 从主进程取回完整回答
  const requestId = genRequestId()
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    model: currentChatData.config.model,
    requestId,
    _startTime: Date.now()
  }
  currentChatData.activeRequestId = requestId

  // 如果有临时保存的 kbInfo，添加到助理消息
  if (tempKbInfo) {
    assistantMessage.kbInfo = { ...tempKbInfo }
  }
  
  currentChatData.messages.push(assistantMessage)
  scrollToBottom()
  
  try {
    let messages
    if (userMessage.images && userMessage.images.length > 0) {
      messages = buildMultimodalMessages(currentChatData, retrievedContext, userMessage.images)
    } else {
      messages = buildMessagesWithFunction(currentChatData, retrievedContext)
    }
    // Agent 预设模式：注入预设系统提示（角色设定已合并进预设 systemPrompt）
    if (currentChatData.mode === 'agent' && currentChatData.config.presetId) {
      const preset = store.agentPresets.find((c: any) => c.id === currentChatData.config.presetId)
      if (preset) {
        const sysContent = preset.systemPrompt?.trim()
          || (store.locales == 'zh' ? '你是一个乐于助人的AI助手。' : 'You are a helpful AI assistant.')
        messages = [{ role: 'system', content: sysContent }, ...messages]
      }
    }
    // 流式渲染缓冲（节流：每 ~100ms 才写入一次消息，避免每 chunk 全量 markdown 重渲染卡顿）
    let streamBuffer = ''
    
    // 获取模型显示名称
    const modelDisplayName = getModelDisplayName(currentChatData.config)
    
    // 设置生成回复状态 - 显示模型名称
    if (currentChatData.mode === 'retrieval' && kbPath) {
      setStep(
        store.locales == 'zh' 
          ? `正在使用 ${modelDisplayName} 总结结论...` 
          : `Using ${modelDisplayName} to summarize...`,
        'fa fa-refresh fa-spin',
        'step-generating'
      )
    } else {
      setStep(
        store.locales == 'zh' 
          ? `正在使用 ${modelDisplayName} 生成回复...` 
          : `Using ${modelDisplayName} to generate response...`,
        'fa fa-refresh fa-spin',
        'step-generating'
      )
    }
    
    const controller = new AbortController()
    globalExecutionState.value.abortController = controller

    await store.sendToAI(
      messages,
      {
        onStream: (chunk: string) => {
          streamBuffer += chunk
          // 节流渲染：保持 markdown 渲染但限制频率（每 ~100ms 一次）
          scheduleStreamRender(() => {
            const last = currentChatData.messages[currentChatData.messages.length - 1]
            if (last?.role === 'assistant') {
              // 深度思考：流式中实时拆分，正文不含 <think>，思考内容单独进 reasoning（思考块展示）
              const split = splitThinkText(streamBuffer)
              last.content = split.content
              if (split.reasoning) last.reasoning = split.reasoning
            }
            scheduleAutoScroll()
            void nextTick(() => refreshRenderedMermaid())
          })
        },
        onReasoning: (text: string) => {
          // 深度思考过程：<think>…</think> 已在解析层剥离并经 onReasoning 推送（整段累积），
          // 实时写入消息 reasoning，供「💡思考过程」折叠块展示（思考中展开，出结果后自动折叠）
          const last = currentChatData.messages[currentChatData.messages.length - 1]
          if (last?.role === 'assistant') {
            last.reasoning = text
          }
          scheduleAutoScroll()
        },
        onSearchStatus: (info: any) => {
          const lastMessage = currentChatData.messages[currentChatData.messages.length - 1]
          if (lastMessage && lastMessage.role === 'assistant') {
            lastMessage.webSearch = lastMessage.webSearch || { status: 'idle', results: [] }
            if (info.status === 'searching') {
              lastMessage.webSearch.status = 'searching'
              if (info.query) lastMessage.webSearch.query = info.query
            } else if (info.status === 'completed') {
              lastMessage.webSearch.status = 'completed'
              if (info.query) lastMessage.webSearch.query = info.query
              if (info.results && info.results.length > 0) {
                // 累积去重合并（不覆盖），保证搜索过程中的链接持续显示不消失
                const existing = lastMessage.webSearch.results || []
                const seen = new Set(existing.map((r: any) => r?.url))
                const merged = [...existing]
                info.results.forEach((r: any) => {
                  if (r?.url) {
                    if (!seen.has(r.url)) {
                      seen.add(r.url)
                      merged.push(r)
                    }
                  } else if (!existing.includes(r)) {
                    merged.push(r)
                  }
                })
                lastMessage.webSearch.results = merged
                enrichWebSearchTitles(merged)
              }
            }
          }
          if (autoScrollEnabled.value) {
            void nextTick(() => scrollToBottom())
          }
        },
        onComplete: (content: string, metadata?: any) => {
          // 流结束：统一收尾（写最终内容 + token 统计 + 清理生成状态）。
          // 若期间用户已手动停止（activeRequestId 被清空）或已开始新一轮生成（换成新 id），
          // 丢弃本会话的收尾，避免用旧内容覆盖新消息 / 误触发标题生成。
          if (currentChatData.activeRequestId !== requestId) return
          completeAssistantReply(currentChatData, content, metadata)
        },
        onError: (error: Error) => {
          console.error('AI请求失败:', error)
          const lastMessage = currentChatData.messages[currentChatData.messages.length - 1]
          if (lastMessage.role === 'assistant') {
            lastMessage.content = '抱歉，请求失败：' + error.message
            // 清除开始时间标记
            delete lastMessage._startTime
          }
          // 除对话里的错误消息外，再在输入行给一个图标提示（悬停看全文）
          setSystemError('抱歉，请求失败：' + error.message)
          
          currentChatData.isGenerating = false
          currentChatData.activeRequestId = undefined
          retrievalStats.value = null
          // 修复3: 清除步骤指示器
          globalExecutionState.value.currentStep = ''
          globalExecutionState.value.stepIcon = ''
          globalExecutionState.value.stepIndicatorClass = ''
          globalExecutionState.value.abortController = null
          saveChats()
        },
        signal: controller.signal,
        requestId
      }
    )
  } catch (error) {
    console.error('发送消息失败:', error)
    const lastMessage = currentChatData.messages[currentChatData.messages.length - 1]
    if (lastMessage.role === 'assistant') {
      lastMessage.content = '请求失败，请检查网络连接和模型配置'
    }
    // 输入行也提示（悬停看全文）
    setSystemError('请求失败，请检查网络连接和模型配置')
    
    currentChatData.isGenerating = false
    currentChatData.activeRequestId = undefined
    retrievalStats.value = null
    // 修复3: 清除步骤指示器
    globalExecutionState.value.currentStep = ''
    globalExecutionState.value.stepIcon = ''
    globalExecutionState.value.stepIndicatorClass = ''
    globalExecutionState.value.abortController = null
    saveChats()
  } finally {
    store.AIconfig.llm.type = originalType
    if (originalType === 'custom' && originalCustom) {
      // 恢复设置页当前激活的自定义来源配置（applyCustomSourceIndex 可能已切到聊天绑定的来源）
      const c = store.AIconfig.llm.custom
      c.activeIndex = originalCustom.activeIndex
      c.name = originalCustom.name
      c.api_url = originalCustom.api_url
      c.api_key = originalCustom.api_key
      c.apiKeyRef = originalCustom.apiKeyRef
      c.model = originalCustom.model
      c.embed_model = originalCustom.embed_model
      c.available_models = originalCustom.available_models
    } else if (originalType === currentChatData.config.llmType) {
      restoreStoreModelConfig(originalType, originalModel)
    }
    saveChats()
  }
}

const getTokenTooltip = (message: ChatMessage): string => {
  if (!message.tokenStats) return ''
  const stats = message.tokenStats
  const parts = []
  if (stats.promptTokens > 0) parts.push(`输入: ${stats.promptTokens} tokens`)
  if (stats.completionTokens > 0) parts.push(`输出: ${stats.completionTokens} tokens`)
  if (stats.totalTokens > 0) parts.push(`总计: ${stats.totalTokens} tokens`)
  if (stats.duration) parts.push(`耗时: ${(stats.duration / 1000).toFixed(2)}s`)
  if (stats.speed) parts.push(`速度: ${stats.speed.toFixed(1)} tok/s`)
  return parts.join('\n')
}

/** ===== 上下文占用圆环（参考 DeepSeek Harness） ===== */
// token 估算、窗口上限解析（来源级手填 > 真实探测 > 模型/来源默认表 > 未知兜底）
// 与真实值缓存统一收敛在 @/lib/contextUsage
/**
 * 该聊天实际生效的「来源 + 模型」：智能体预设可在聊天未选模型时兜底提供。
 * 圆环分母与真实窗口探测都必须用它——否则聊天没选模型时会沿用上一个聊天探测到的
 * 分母（如上一轮 Ollama 的 131072 被用到 DeepSeek 聊天上）。
 */
const chatModelContext = computed(() => {
  const chat = currentChat.value
  const cfg: any = chat?.config || {}
  const preset = (chat?.mode === 'agent' && cfg.presetId)
    ? store.agentPresets.find((p: any) => p.id === cfg.presetId)
    : null
  return {
    provider: normalizeLlmType(String(cfg.llmType || preset?.llmType || store.AIconfig.llm.type || '')),
    model: String(cfg.model || preset?.model || ''),
    customSourceIndex: typeof cfg.customSourceIndex === 'number' ? cfg.customSourceIndex : undefined,
  }
})
/** 真实窗口探测结果存在模块级 Map（跨聊天/跨模型缓存），Map 非响应式 → 用该 tick 通知分母重算 */
const contextWindowRealTick = ref(0)
/** 「已加载窗口」会随手动设置变化的本地后端（请求完成后值得重探） */
const LOAD_DEPENDENT_LLM_TYPES = new Set(['ollama', 'lmstudio'])
/** 请求完成后重探的最小间隔（毫秒）：已读到实际值时按此节流，避免每轮回复都发探测请求 */
const CTX_WINDOW_REFRESH_MS = 15_000
/** 尚未读到「已加载实际值」时的最小间隔：仍需尽快校正，但防突发重复请求 */
const CTX_WINDOW_REFRESH_MIN_MS = 2_000
/**
 * 异步读取模型真实上下文窗口（Ollama 实际 num_ctx / LM Studio / Google），按「来源+模型」缓存。
 * @param force 本轮请求刚结束：本地后端此刻模型才真正加载，而用户在 Ollama 侧手动调小的
 *   上下文长度只体现在 /api/ps 的已加载实例上 → 允许在节流窗口外重新探测一次。
 */
const loadContextWindowReal = async (force = false) => {
  const { provider, model, customSourceIndex } = chatModelContext.value
  const llm = store.AIconfig.llm
  if (!provider || !model) {
    // 无法判定模型（聊天与预设都没选）→ 清掉展示值，避免残留其它来源的分母
    llm.contextWindowReal = 0
    return
  }
  const key = realContextWindowCacheKey(provider, model, customSourceIndex)
  if (hasProbedRealContextWindow(key)) {
    llm.contextWindowReal = getCachedRealContextWindow(key) || 0
    // 重探条件：调用方要求（请求已完成）+ 窗口随加载而变的本地后端 + 已过节流窗口。
    // 云端来源（DeepSeek/OpenAI/…）的窗口不会因加载变化，命中否定缓存后不再发请求。
    const loadedKnown = getCachedLoadedContextWindow(key) !== undefined
    const refreshAfter = loadedKnown ? CTX_WINDOW_REFRESH_MS : CTX_WINDOW_REFRESH_MIN_MS
    const canRefresh = force
      && LOAD_DEPENDENT_LLM_TYPES.has(provider)
      && (Date.now() - contextWindowCacheAt(key)) > refreshAfter
    if (!canRefresh) return
  }
  const cfg = (llm as any)[provider] || {}
  // 用带来源的探测：loaded = 已加载实例真正生效的值（含 Ollama 手动设置的上下文长度），
  // 它才能压过「上次记住的值」；模型未加载时拿到的只能是模型上限（model-max）。
  const probe = await AIUtils.fetchModelContextWindowDetail(provider, cfg, model)
  setCachedRealContextWindow(key, probe?.limit || 0, probe?.from === 'loaded')
  contextWindowRealTick.value++ // Map 非响应式 → 手动通知分母重算
  // 记住实际读到的值（跨会话）：Ollama 手动设置的上下文长度只在模型已加载时读得到，
  // 卸载后就没了 → 持久化下来，下次启动尚未加载时不会错回退到模型上限。
  if (probe?.from === 'loaded' && rememberProbedContextWindow(llm, key, probe.limit)) store.saveConfig()
  // 竞态保护：探测期间可能已切来源/换模型，只有目标未变才回写展示值
  const now = chatModelContext.value
  if (now.provider === provider && now.model === model) llm.contextWindowReal = probe?.limit || 0
}
// 来源 / 模型变化时刷新（智能体预设的模型变化同样体现在 chatModelContext 上）
watch(
  () => [chatModelContext.value.provider, chatModelContext.value.model],
  () => { void loadContextWindowReal() },
  { immediate: true }
)
// 任何一轮生成结束（普通/知识库/智能体/工作流）后重探：本地后端此刻模型才真正加载，
// 而 Ollama 侧手动调小的上下文长度只体现在 /api/ps 的已加载实例上 → 让圆环分母跟上。
watch(
  () => currentChat.value?.isGenerating,
  (now, prev) => { if (prev === true && now === false) void loadContextWindowReal(true) }
)
/** 窗口上限（圆环分母）：手填覆盖 > 后端真实值 > 模型名默认 > 来源默认 > 未知兜底 */
const contextLimitInfo = computed(() => {
  void contextWindowRealTick.value // 依赖：探测（含请求完成后的重探）结束时刷新分母
  const { provider, model, customSourceIndex } = chatModelContext.value
  const key = realContextWindowCacheKey(provider, model, customSourceIndex)
  return resolveContextLimit({
    manual: manualContextWindow(store.AIconfig.llm, provider, customSourceIndex),
    // 已加载实例真正生效的值（最可信；Ollama 手动设置的上下文长度只有它能反映）
    realLoaded: getCachedLoadedContextWindow(key),
    // 模型未加载时 /api/ps 读不到 → 用「上次读到的实际值」，它比模型上限更接近实际
    probed: probedContextWindow(store.AIconfig.llm, key),
    real: getCachedRealContextWindow(key),
    provider,
    model,
  })
})
const contextLimit = computed(() => contextLimitInfo.value.limit)
/** 最后一条助手消息：圆环只认它（更早消息的 tokenStats 属于上一轮的旧上下文，不能当现值用） */
const lastAssistantMessage = computed(() => {
  const msgs = currentChat.value?.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') return msgs[i]
  return undefined
})
/** 已用 token 是否来自后端回传的真实 usage（否则为估算值，tooltip 会标注「估算」） */
const contextUsedExact = computed(() => (lastAssistantMessage.value?.tokenStats?.promptTokens || 0) > 0)
/** 已用 token：最后一条助手的真实 promptTokens 优先，否则按实际请求口径估算（见 lib/contextUsage） */
const contextUsedTokens = computed(() =>
  contextUsedExact.value
    ? (lastAssistantMessage.value!.tokenStats!.promptTokens)
    : estimateChatContextTokens(currentChat.value)
)
/** 无 assistant 消息时不显示圆环；集群模式不显示（每个成员各有独立上下文，该数值无意义） */
const contextUsageVisible = computed(() =>
  currentChat.value?.mode !== 'swarm' &&
  (currentChat.value?.messages || []).some((m) => m.role === 'assistant')
)
const contextRingCirc = 2 * Math.PI * 15.5
const contextUsagePct = computed(() => {
  if (!contextUsageVisible.value) return 0
  return Math.min(100, Math.round((contextUsedTokens.value / Math.max(1, contextLimit.value)) * 100))
})
const contextRingLen = computed(() => (contextUsagePct.value / 100) * contextRingCirc)
/** 占用率颜色：<70% 主题色，70~90% 橙，≥90% 红 */
const contextRingColor = computed(() => {
  const pct = contextUsagePct.value
  if (pct >= 90) return '#f56c6c'
  if (pct >= 70) return '#e6a23c'
  return 'var(--fontActiveColor)'
})
/** 分母来源说明（tooltip） */
const contextLimitSourceLabel = computed(() => {
  const zh = store.locales === 'zh'
  switch (contextLimitInfo.value.source) {
    case 'manual': return zh ? '手动设置' : 'manual'
    case 'real': return zh ? '模型实际 context' : 'model context'
    case 'probed': return zh ? '上次读到的实际值' : 'last seen actual'
    case 'model-default': return zh ? '模型上限（未读到实际值）' : 'model max (not probed)'
    case 'model-name': return zh ? '模型名默认值' : 'model-name default'
    case 'provider-default': return zh ? '来源默认值' : 'provider default'
    default: return zh ? '来源未知，按 128K 估算' : 'source unknown, assumed 128K'
  }
})
const contextUsageTooltip = computed(() => {
  if (!contextUsageVisible.value) return ''
  const used = contextUsedTokens.value.toLocaleString()
  const limit = contextLimit.value.toLocaleString()
  const approx = contextUsedExact.value ? '' : (store.locales === 'zh' ? '（估算）' : ' (estimated)')
  return store.locales === 'zh'
    ? `上下文占用：${contextUsagePct.value}%\n已用约 ${used}${approx} / 上限 ${limit} tokens（${contextLimitSourceLabel.value}）`
    : `Context usage: ${contextUsagePct.value}%\n~${used}${approx} / ${limit} tokens (${contextLimitSourceLabel.value})`
})

const buildMultimodalMessages = (chat: Chat, context: string, images: Array<string | Uint8Array | ArrayBuffer>) => {
  const historyMessages = chat.messages
    .slice(0, -1)
    .map(msg => {
      if (msg.images && msg.images.length > 0) {
        return {
          role: msg.role,
          content: msg.content,
          images: msg.images
        }
      } else {
        return {
          role: msg.role,
          content: msg.content
        }
      }
    })
  
  const currentMessage = {
    role: 'user' as const,
    content: context,
    images: images
  }
  
  return [ ...historyMessages, currentMessage]
}

const buildMessagesWithFunction = (chat: Chat, context: string) => {  
  const historyMessages = chat.messages
    .slice(0, -1)
    .map(msg => ({
      role: msg.role,
      content: msg.content
    }))
  
  const lastMessage = {
    role: 'user' as const,
    content: context
  }
  
  return [ ...historyMessages, lastMessage]
}

// ==================== 输入框拖动缩放 ====================

/** 开始拖动调整输入框高度 */
const onResizeStart = (e: MouseEvent) => {
  e.preventDefault()
  const textarea = (e.currentTarget as HTMLElement).parentElement?.querySelector('.message-input') as HTMLTextAreaElement
  if (!textarea) return
  const startY = e.clientY
  const startHeight = textarea.offsetHeight

  const onMouseMove = (ev: MouseEvent) => {
    const delta = startY - ev.clientY // 上拖为正（变大），下拖为负（变小）
    const newHeight = Math.max(40, startHeight + delta) // 最小 40px
    textarea.style.height = newHeight + 'px'
    textarea.style.minHeight = newHeight + 'px'
    // 移除 rows 属性，改用固定像素高度
    textarea.removeAttribute('rows')
  }

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

/**
 * 立即复位某聊天的「执行中」UI 状态：清转圈、解锁输入，但**保留**已生成的内容与
 * 工具时间线记录（智能体/普通对话未完成的部分原样留在聊天里，供后续继续读取上下文）。
 * 仅当「全局执行（工作流/技能）」确属该聊天时才一并复位全局字段，避免误停其它聊天的后台执行。
 */
const resetChatExecutionUi = (chatData: any) => {
  if (!chatData) return
  const g = globalExecutionState.value
  const wasGenerating = chatData.isGenerating === true
  if (g.chatId === chatData.id) {
    if (g.workflowRunner) g.workflowRunner.stop()
    g.isExecuting = false
    g.executionType = null
    g.chatId = null
    g.skillLoading = false
    g.workflowRunner = null
    g.abortController = null
    g.currentStep = ''
    g.stepIcon = ''
    g.stepIndicatorClass = ''
  }
  // 该聊天的「生成中/执行中」一律复位（普通流式不占用 global.chatId，仅置 isGenerating）
  chatData.isGenerating = false
  chatData.activeRequestId = undefined
  for (const m of chatData.messages || []) {
    if (m?.role === 'assistant' && m.isExecuting) {
      m.isExecuting = false
      m.streaming = false
    }
  }
  // 普通/知识库流式被中止且尚未产生任何内容时，给最后一条空助手消息补「已停止」提示，
  // 避免出现无法解释的空白气泡（已有部分内容则原样保留）。
  if (wasGenerating) {
    const last = chatData.messages?.[chatData.messages.length - 1]
    if (last && last.role === 'assistant' && !last.content) {
      const hadAnything = Boolean(
        (last.images && last.images.length) ||
        (last.executionUnits && last.executionUnits.length) ||
        (last.webSearch && last.webSearch.results && last.webSearch.results.length) ||
        (last.kbInfo && last.kbInfo.relevantBlocks && last.kbInfo.relevantBlocks.length)
      )
      if (!hadAnything) {
        last.content = store.locales == 'zh' ? '（已停止）' : '(Stopped)'
      }
    }
  }
  // 清掉当前聊天对应的主进程流式会话中止句柄（abort 已由调用方触发）
  if (g.abortController && currentChat.value?.id === chatData.id) {
    g.abortController = null
  }
  saveChats()
  void nextTick(() => refreshRenderedMermaid())
}

/**
 * 停止生成（四种模式统一入口）：
 *  - 普通 / 知识库（主进程流式会话）：abort → 主进程保留已生成内容并回传完成，立即复位解锁；
 *  - 工作流：stopExecution（终止节点执行并复位全局执行状态）；
 *  - 智能体（agent2 / agent 预设 / 技能）：取消会话但**保留记录**（供后续智能体读取上下文），立即复位解锁。
 */
const stopCurrentGeneration = () => {
  const chat = currentChat.value
  const g = globalExecutionState.value
  if (!chat) return

  // 0) 集群：停止本轮所有成员会话（级联取消）
  if (chat.mode === 'swarm' && swarmRunning.value) {
    void stopSwarm()
    return
  }

  // 1) 工作流（当前聊天正在执行全局工作流）→ 统一停止并复位
  if (g.isExecuting && g.executionType === 'workflow' && g.chatId === chat.id) {
    stopExecution()
    return
  }

  // 2) 智能体：取消当前聊天所有执行中的 agent 会话并立即复位（保留已生成记录）。
  //    stopAgentsInChat 返回 true 表示确有会话被停止；再触发一次强制对账兜底，
  //    防止主进程 cancel 后 idle 事件缺失导致的残留转圈。
  if (stopAgentsInChat?.(chat)) {
    setTimeout(() => reconcileAgentRuns(true, chat.id), 300)
    return
  }

  // 3) 普通 / 知识库：中止主进程流式会话（abort 后主进程保留已生成内容并 emit done(aborted)，
  //    onComplete → completeAssistantReply 幂等收尾），本地立即复位解锁
  if (chat.isGenerating || g.abortController) {
    const ctl = g.abortController
    if (ctl) ctl.abort()
    resetChatExecutionUi(chat)
    return
  }

  // 4) 兜底：存在其它聊天/全局后台执行（如后台工作流）→ 停止全局执行
  if (g.isExecuting) {
    stopExecution()
    return
  }

  // 5) 最后兜底：复位当前聊天（防御，无副作用）
  resetChatExecutionUi(chat)
}

// 生成聊天标题。chatData 为实际所属聊天（后台推理完成时不能依赖 currentChat.value ——
// 用户可能已切到其它聊天，导致标题被写到当前激活的聊天）；缺省时回退到当前聊天。
async function generateChatTitle(firstResponse: string, chatData?: any) {
  try {
    // 深度思考过滤：标题只基于最终正文生成——剔除 <think>…</think> 思考段与任何残留标签，
    // 避免思考内容/标签进入标题（home、工作流、Agent 回调都经此统一入口）
    const thinkSplit = splitThinkText(String(firstResponse || ''))
    firstResponse = thinkSplit.content.replace(/<\/?think>/gi, '').trim()
    if (!firstResponse) return

    const targetChat: Chat = chatData ?? currentChat.value

    // 已有标题则不覆盖
    if (targetChat.title && targetChat.title.trim() !== '') {
      return
    }

    // 至少需要有一条用户消息和一条助理消息
    const hasUser = targetChat.messages.some((m: ChatMessage) => m.role === 'user')
    const hasAssistant = targetChat.messages.some((m: ChatMessage) => m.role === 'assistant')
    if (!hasUser || !hasAssistant) {
      return
    }

    // 标题语言跟随界面语言：英文界面生成英文标题，中文界面生成中文标题（各限 10 字 / 6 词以内）
    const titlePrompt = (store.locales === 'en')
      ? `Summarize the following conversation as a short English title (at most 6 words), output the title only:\n${firstResponse.substring(0, 100)}`
      : `请根据以下对话内容生成一个简短的中文标题（不超过10个字），不要其他内容：\n${firstResponse.substring(0, 100)}`

    // 标题生成必须用「目标聊天」绑定的模型来源/模型（与 sendChatMessage 一致的快照/应用/恢复）：
    // 智能体/预设会按聊天绑定自定义来源或独立模型，后台会话结束时全局 store.AIconfig.llm
    // 并不一定是该聊天的来源/模型——直接用全局配置发标题请求会命中错误来源（或空模型）而生成失败。
    const llm = store.AIconfig.llm
    const originalType = llm.type
    const originalModel = getCurrentModelFromStore()
    const originalTemperature = llm.temperature
    const originalMaxTokens = llm.max_tokens
    const originalStream = llm.stream
    const originalThink = llm.think
    // 目标聊天绑定的来源/模型（快照其当前值，便于发送后精确还原被 updateStoreModelConfig 改掉的模型）
    const targetType = targetChat.config.llmType
    const readModelByType = (t: string): string => {
      const saved = llm.type
      llm.type = t
      const m = getCurrentModelFromStore()
      llm.type = saved
      return m
    }
    const originalTargetModel = targetType !== originalType ? readModelByType(targetType) : originalModel
    // 只要会触碰「自定义来源扁平配置」（applyCustomSourceIndex）就整份快照，用于发送后完整还原
    const needCustomRestore = originalType === 'custom' || targetType === 'custom'
    const originalCustom = needCustomRestore
      ? { ...llm.custom, available_models: [...(llm.custom.available_models || [])] }
      : null

    llm.type = targetType
    if (targetType === 'custom') {
      store.applyCustomSourceIndex(targetChat.config.customSourceIndex)
    }
    updateStoreModelConfig(targetChat.config)
    // 标题生成不需要深度思考：临时关闭（'none' = 关闭思考），避免标题模型输出“思考 + </think> + 标题”污染标题
    llm.think = 'none'

    let title = ''
    try {
      title = await store.sendToAI([{ role: 'user', content: titlePrompt }])
    } finally {
      // 恢复原全局配置（type / 温度 / 生成参数 / 来源与模型）
      llm.type = originalType
      llm.temperature = originalTemperature
      llm.max_tokens = originalMaxTokens
      llm.stream = originalStream
      llm.think = originalThink
      if (needCustomRestore && originalCustom) {
        const c = llm.custom
        c.activeIndex = originalCustom.activeIndex
        c.name = originalCustom.name
        c.api_url = originalCustom.api_url
        c.api_key = originalCustom.api_key
        c.apiKeyRef = originalCustom.apiKeyRef
        c.model = originalCustom.model
        c.embed_model = originalCustom.embed_model
        c.available_models = originalCustom.available_models
      } else {
        restoreStoreModelConfig(originalType, originalModel)
        // 目标来源不同于全局来源时，把被改过的目标来源模型也还原
        if (targetType !== originalType && targetType !== 'custom') {
          restoreStoreModelConfig(targetType, originalTargetModel)
        }
      }
    }

    if (title && String(title).trim()) {
      // 深度思考过滤兜底：即使已禁用思考，个别后端仍可能返回“思考 + </think> + 标题”形态，
      // 剥离思考段/残留标签后再作为标题，避免标题混入思考内容
      const cleanTitle = splitThinkText(String(title)).content
        .replace(/<\/?think>/gi, '').replace(/["']/g, '').trim()
      if (cleanTitle) {
        targetChat.title = cleanTitle
        saveChats()
      }
    }
  } catch (error) {
    console.error('生成标题失败:', error)
  }
}

const deleteMessage = (index: number) => {
  const message = currentChat.value.messages[index]
  delete showKbDetails.value[message.timestamp]
  
  currentChat.value.messages.splice(index, 1)
  saveChats()
}

const copyMessage = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content)
  } catch (err) {
    console.error('复制失败:', err)
    const textarea = document.createElement('textarea')
    textarea.value = content
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}

/** 去除消息内容中的工具调用徽章 HTML，保留工具执行结果 */
const stripToolBadges = (content: string): string => {
  if (!content) return content
  // 移除 <span class="tool-badge">...</span> 工具徽章
  return content.replace(/<span class="tool-badge">.*?<\/span>/g, '')
}

const exportChat = (messageIndex?: number | null) => {
  const chat = currentChat.value
  const now = new Date()
  
  let fileName = ''
  if (chat.title && chat.title.trim() !== '') {
    fileName = chat.title.replace(/[\\/:*?"<>|]/g, '_').trim()
  } else {
    fileName = `聊天${currentChatIndex.value + 1}`
  }
  
  const timestamp = now.toISOString().split('T')[0] + '_' + 
                   now.getHours().toString().padStart(2, '0') + 
                   now.getMinutes().toString().padStart(2, '0')
  // 单条消息导出时追加消息序号
  const suffix = messageIndex !== null && messageIndex !== undefined && chat.messages[messageIndex] ? `_msg${messageIndex + 1}` : ''
  fileName = `${fileName}${suffix}_${timestamp}.md`
  
  let markdownContent = ''
  
  // 封面信息（YAML frontmatter 会被 PPT 自动去除，这里直接用普通文字）
  markdownContent += `# ${chat.title || '对话记录'}\n\n`
  markdownContent += `> **导出时间**: ${now.toLocaleString('zh-CN')}\n`
  markdownContent += `> **模型类型**: ${getLlmTypeDisplayName(chat.config.llmType, chat.config.customSourceIndex)}\n`
  markdownContent += `> **模型名称**: ${chat.config.model || '未设置'}\n`
  if (chat.mode === 'retrieval' && chat.config.kbPath) {
    const kbName = chat.config.kbPath.split(/[\\/]/).pop() || chat.config.kbPath
    markdownContent += `> **知识库模式**: ${kbName}\n`
  }
  if (chat.mode === 'workflow' && chat.config.workflowPath) {
    const workflowName = chat.config.workflowPath.split(/[\\/]/).pop() || chat.config.workflowPath
    markdownContent += `> **工作流模式**: ${workflowName}\n`
  }
  if (chat.mode === 'skill') {
    markdownContent += `> **技能模式**: 已并入「智能体」\n`
  }
  const msgCount = messageIndex !== null && messageIndex !== undefined && chat.messages[messageIndex] ? 1 : chat.messages.length
  markdownContent += `> **消息数量**: ${msgCount}\n\n`
  markdownContent += `---\n\n`

  // 确定要导出的消息列表
  const exportMessages = messageIndex !== null && messageIndex !== undefined && chat.messages[messageIndex]
    ? [chat.messages[messageIndex]]
    : chat.messages

  // 将消息按 (用户+助理) 配对，每组作为一张 PPT 幻灯片
  let i = 0
  while (i < exportMessages.length) {
    const msg = exportMessages[i]
    const nextMsg = i + 1 < exportMessages.length ? exportMessages[i + 1] : null

    // 如果当前是用户消息且下一条是助理消息 → 配对作为一张幻灯片
    if (msg.role === 'user' && nextMsg && nextMsg.role === 'assistant') {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
      // 幻灯片标题取用户消息的前 40 字
      const titleText = msg.content.trim().substring(0, 40).replace(/\n/g, ' ') || '问题'
      markdownContent += `## 👤 ${titleText}\n\n`
      markdownContent += `> 📅 ${time}\n\n`

      // 用户消息内容
      const cleanedUserContent = stripToolBadges(msg.content)
      if (cleanedUserContent.trim()) {
        markdownContent += `${cleanedUserContent}\n\n`
      }

      // 助理回复
      const asst = nextMsg
      const asstTime = new Date(asst.timestamp).toLocaleString('zh-CN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
      let header = `### 🤖 助理`
      if (asst.executionType) {
        const typeIcon = asst.executionType === 'workflow' ? '⚙️' : '🧩'
        const typeName = asst.executionType === 'workflow' ? '工作流' : '技能'
        header += ` ${typeIcon} ${typeName}生成`
        if (asst.executionName) header += ` (${asst.executionName})`
      } else if (asst.kbInfo?.relevantBlocks?.length) {
        header += ` 📚 知识库生成`
      }
      header += ` · ${asstTime}`
      markdownContent += `${header}\n\n`
      const cleanedAsstContent = stripToolBadges(asst.content || '')
      markdownContent += `${cleanedAsstContent || '*(空消息)*'}\n\n`

      // 助理消息的执行统计
      appendExecutionStats(asst)
      appendKbInfo(asst)

      i += 2 // 跳过已处理的两条消息
    } else {
      // 单条消息（无配对），作为独立幻灯片
      const time = new Date(msg.timestamp).toLocaleString('zh-CN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      })
      const roleIcon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️'
      const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助理' : '系统'
      const titleText = msg.content.trim().substring(0, 40).replace(/\n/g, ' ') || roleLabel
      markdownContent += `## ${roleIcon} ${titleText}\n\n`
      markdownContent += `> 📅 ${time}\n\n`
      if (msg.images && msg.images.length > 0) {
        markdownContent += `**📷 包含 ${msg.images.length} 张图片**\n\n`
      }
      const cleanedMsgContent = stripToolBadges(msg.content || '')
      markdownContent += `${cleanedMsgContent || '*(空消息)*'}\n\n`
      appendExecutionStats(msg)
      appendKbInfo(msg)
      i++
    }

    // 幻灯片之间用 --- 分隔（PPT 切分依据）
    if (i < exportMessages.length) {
      markdownContent += `---\n\n`
    }
  }

  // 追加执行统计（直接修改 markdownContent）
  function appendExecutionStats(msg: ChatMessage) {
    if (!msg.executionStats) return
    const typeName = msg.executionType === 'workflow' ? '工作流' : '技能'
    markdownContent += `**${typeName}执行统计:**\n\n`
    markdownContent += `- **总${msg.executionType === 'workflow' ? '节点' : '步骤'}数**: ${msg.executionStats.total}\n`
    markdownContent += `- **成功**: ${msg.executionStats.success}\n`
    markdownContent += `- **失败**: ${msg.executionStats.failed}\n`
    markdownContent += `- **执行耗时**: ${msg.executionStats.time}ms\n\n`
    if (msg.executionStats.errors && msg.executionStats.errors.length > 0) {
      markdownContent += `**执行错误:**\n\n`
      msg.executionStats.errors.forEach((error: any, errorIndex: number) => {
        markdownContent += `${errorIndex + 1}. **${error.name}**: ${error.error}\n`
      })
      markdownContent += `\n`
    }
  }

  // 追加知识库信息（直接修改 markdownContent）
  function appendKbInfo(msg: ChatMessage) {
    if (!msg.kbInfo?.relevantBlocks?.length) return
    markdownContent += `**召回文件标签 (${msg.kbInfo.relevantBlocks.length}个):**\n\n`
    const mergedTags = mergeDuplicateLabels(msg.kbInfo.relevantBlocks)
    mergedTags.forEach(tag => {
      markdownContent += `- **${tag.label}** (相似度: ${(tag.similarity * 100).toFixed(1)}%)\n`
      if (tag.contents && tag.contents.length > 0) {
        tag.contents.forEach((content: string, contentIndex: number) => {
          if (content && content.trim()) {
            markdownContent += `  ${contentIndex + 1}. ${content}\n`
          }
        })
      }
    })
    markdownContent += `\n`
  }
  
  const dataBlob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(dataBlob)
  
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const exportChatToKb = async (messageIndex?: number | null) => {
  const chat = currentChat.value
  const rootDir = store.root
  if (!rootDir) return
  // 浏览器环境不支持写入本地文件
  if (!window.ipcRenderer) {
    ElMessage.warning(store.locales=='zh' ? '导出功能仅桌面版支持' : 'Export is only supported in desktop app')
    return
  }

  // 使用 store.root 作为导出目录
  const separator = rootDir.includes('\\') ? '\\' : '/'
  const dir = rootDir.replace(/[\\/]$/, '') // 去掉末尾分隔符
  
  const now = new Date()
  
  let fileName = ''
  if (chat.title && chat.title.trim() !== '') {
    fileName = chat.title.replace(/[\\/:*?"<>|]/g, '_').trim()
  } else {
    fileName = `聊天${currentChatIndex.value + 1}`
  }
  
  const timestamp = now.toISOString().split('T')[0] + '_' + 
                   now.getHours().toString().padStart(2, '0') + 
                   now.getMinutes().toString().padStart(2, '0')
  // 单条消息导出时追加消息序号
  const suffix = messageIndex !== null && messageIndex !== undefined && chat.messages[messageIndex] ? `_msg${messageIndex + 1}` : ''
  const fullFileName = `${fileName}${suffix}_${timestamp}.md`
  const filePath = `${dir}${separator}${fullFileName}`
  
  // 确定要导出的消息列表
  const exportMessages = messageIndex !== null && messageIndex !== undefined && chat.messages[messageIndex]
    ? [chat.messages[messageIndex]]
    : chat.messages
  
  let markdownContent = ''
  
  markdownContent += `---\n`
  markdownContent += `导出时间: ${now.toLocaleString('zh-CN')}\n`
  markdownContent += `模型类型: ${getLlmTypeDisplayName(chat.config.llmType, chat.config.customSourceIndex)}\n`
  markdownContent += `模型名称: ${chat.config.model || '未设置'}\n`
  if (chat.mode === 'retrieval' && chat.config.kbPath) {
    const kbName = chat.config.kbPath.split(/[\\/]/).pop() || chat.config.kbPath
    markdownContent += `知识库模式: ${kbName}\n`
    if (chat.config.kbTopK) {
      markdownContent += `知识库片段数: ${chat.config.kbTopK}\n`
    }
  }
  if (chat.mode === 'workflow' && chat.config.workflowPath) {
    const workflowName = chat.config.workflowPath.split(/[\\/]/).pop() || chat.config.workflowPath
    markdownContent += `工作流模式: ${workflowName}\n`
  }
  if (chat.mode === 'skill') {
    markdownContent += `技能模式: 已并入「智能体」\n`
  }
  markdownContent += `温度参数: ${chat.config.temperature}\n`
  markdownContent += `最大令牌: ${chat.config.maxTokens}\n`
  markdownContent += `消息数量: ${exportMessages.length}\n`
  markdownContent += `---\n\n`
  
  exportMessages.forEach((message, index) => {
    const time = new Date(message.timestamp).toLocaleString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    
    const roleIcon = message.role === 'user' ? '👤' : 
                    message.role === 'assistant' ? '🤖' : '⚙️'
    
    const roleLabel = message.role === 'user' ? '用户' : 
                     message.role === 'assistant' ? '助理' : '系统'
    
    markdownContent += `### ${roleIcon} ${roleLabel}`
    
    if (message.executionType) {
      const typeIcon = message.executionType === 'workflow' ? '⚙️' : '🧩'
      const typeName = message.executionType === 'workflow' ? '工作流' : '技能'
      markdownContent += ` ${typeIcon} ${typeName}生成`
      if (message.executionName) {
        markdownContent += ` (${message.executionName})`
      }
    } else if (message.kbInfo?.relevantBlocks?.length) {
      markdownContent += ` 📚 知识库生成`
    }
    
    markdownContent += ` · ${time}\n\n`
    
    if (message.images && message.images.length > 0) {
      markdownContent += `**📷 包含 ${message.images.length} 张图片**\n\n`
    }
    
    const cleanedContent = stripToolBadges(message.content || '')
    if (cleanedContent.trim() !== '') {
      markdownContent += `${cleanedContent}\n\n`
    } else {
      markdownContent += `*(空消息)*\n\n`
    }
    
    if (message.executionStats) {
      const typeName = message.executionType === 'workflow' ? '工作流' : '技能'
      markdownContent += `**${typeName}执行统计:**\n\n`
      markdownContent += `- **总${message.executionType === 'workflow' ? '节点' : '步骤'}数**: ${message.executionStats.total}\n`
      markdownContent += `- **成功**: ${message.executionStats.success}\n`
      markdownContent += `- **失败**: ${message.executionStats.failed}\n`
      markdownContent += `- **执行耗时**: ${message.executionStats.time}ms\n\n`
      
      if (message.executionStats.errors && message.executionStats.errors.length > 0) {
        markdownContent += `**执行错误:**\n\n`
        message.executionStats.errors.forEach((error, errorIndex) => {
          markdownContent += `${errorIndex + 1}. **${error.name}**: ${error.error}\n`
        })
        markdownContent += `\n`
      }
    }
    
    if (message.kbInfo?.relevantBlocks?.length) {
      markdownContent += `**召回文件标签 (${message.kbInfo.relevantBlocks.length}个):**\n\n`
      
      const mergedTags = mergeDuplicateLabels(message.kbInfo.relevantBlocks)
      mergedTags.forEach(tag => {
        markdownContent += `- **${tag.label}** (相似度: ${(tag.similarity * 100).toFixed(1)}%)\n`
        if (tag.contents && tag.contents.length > 0) {
          tag.contents.forEach((content, contentIndex) => {
            if (content && content.trim()) {
              markdownContent += `  ${contentIndex + 1}. ${content}\n`
            }
          })
        }
      })
      markdownContent += `\n`
    }
    
    if (index < exportMessages.length - 1) {
      markdownContent += `---\n\n`
    }
  })
  
  try {
    await window.ipcRenderer.invoke('writeFile', filePath, markdownContent)
    const msg = store.locales=='zh' 
      ? `已导出到知识库: ${fullFileName}` 
      : `Exported to knowledge base: ${fullFileName}`
    ElMessage.success(msg)
    console.log(`聊天已导出到: ${filePath}`)
  } catch (error: any) {
    console.error('导出到知识库失败:', error)
    ElMessage.error(store.locales=='zh' ? '导出失败: ' + error.message : 'Export failed: ' + error.message)
  }
}

// ================ ASR 语音输入 ================

// 获取 ASR 按钮图标
const getASRIcon = () => {
  if (isASRProcessing.value) return 'fa fa-spinner fa-spin'
  if (isASRRecording.value) return 'fa fa-microphone fa-fade'
  return 'fa fa-microphone'
}

// 获取 ASR 按钮标题
const getASRButtonTitle = () => {
  if (isASRRecording.value) {
    return store.locales === 'zh' ? '录音中，松开以识别' : 'Recording, release to transcribe'
  }
  if (isASRProcessing.value) {
    return store.locales === 'zh' ? '识别中...' : 'Transcribing...'
  }
  return store.locales === 'zh' ? '单击切换·按住说话（语音输入）' : 'Click toggle · Hold to talk (Voice Input)'
}

let asrPressStartTime = 0
let asrWasRecordingBeforePress = false
let asrPointerDown = false // 指针是否仍按在按钮上（区分“按住说话”与“单击切换”）
const ASR_CLICK_THRESHOLD = 300 // 毫秒，短按视为点击

// 按下按钮（立即录音，不等待模型加载）
function onASRPress() {
  asrPointerDown = true
  asrPressStartTime = Date.now()
  // 记录按下前的录音状态：短按（单击）切换判断以此为准，
  // 避免 start() 异步置位 isASRRecording 导致松开时误判为“正在录音”而立刻停止
  asrWasRecordingBeforePress = isASRRecording.value || isASRProcessing.value
  
  if (isASRRecording.value || isASRProcessing.value) return
  
  if (!asrManagerInstance) {
    console.warn('[ASR] 管理器尚未初始化')
    return
  }
  
  asrManagerInstance.start()
}

// 松开按钮
function onASRRelease() {
  asrPointerDown = false
  const pressDuration = Date.now() - asrPressStartTime
  
  if (pressDuration < ASR_CLICK_THRESHOLD) {
    // 短按（单击）→ 切换持续收音：
    // 按下前已在录音/识别 → 关闭（停止）；否则保持 onASRPress 启动的录音（开启）
    if (asrWasRecordingBeforePress) {
      stopASR()
    }
  } else {
    // 长按（按住说话）→ 松开停止
    stopASR()
  }
}

// 移出按钮：仅“按住说话”且拖出时取消录音；
// 单击切换开启的持续收音（指针已松开）移开鼠标不停止
function onASRLeave() {
  if (!asrPointerDown) return
  asrPointerDown = false
  if (isASRRecording.value) {
    if (asrManagerInstance) {
      asrManagerInstance.abort()
    }
    isASRRecording.value = false
    asrPartialFill = false
  }
}

// 开始语音识别
function startASR() {
  if (isASRRecording.value || isASRProcessing.value) return
  
  if (!asrManagerInstance) {
    console.warn('[ASR] 管理器尚未初始化')
    return
  }
  
  // 流式引擎（funasr-online；或 Qwen3-ASR 的分段准流式）：
  // 记录录音开始时的输入为 base（后续片段追加其后，不覆盖已输入）
  asrPartialFill = store.AIconfig.asr.type === 'funasr-online'
    || (store.AIconfig.asr.type === 'qwen3-asr' && store.AIconfig.asr.qwen3.mode === 'segment')
  if (asrPartialFill) asrBaseText = inputText.value
  asrManagerInstance.start()
}

// 停止语音识别
async function stopASR() {
  if (!isASRRecording.value) return
  isASRProcessing.value = true
  
  if (asrManagerInstance) {
    await asrManagerInstance.stop()
  }
  
  asrPartialFill = false
  isASRProcessing.value = false
}

// 注册/更新 ASR 全局快捷键
async function registerASRShortcut() {
  if (window.ipcRenderer && store.AIconfig.asr.shortcut) {
    try {
      const result = await window.ipcRenderer.invoke('registerASRShortcut', store.AIconfig.asr.shortcut)
      if (!result.success) {
        console.warn('[ASR] 注册全局快捷键失败:', result.error)
      }
    } catch (error) {
      console.warn('[ASR] 注册全局快捷键出错:', error)
    }
  }
}

const toggleSidebar = () => {
  showSidebar.value = !showSidebar.value
}

// ==================== 分支对话 ====================

/** 切换分支树视图 */
const toggleBranchView = () => {
  showBranchView.value = !showBranchView.value
  // 切换分支视图时强制显示侧边栏
  if (showBranchView.value) {
    showSidebar.value = true
  }
}

/** 从某条消息提取简短标签（取前 20 字） */
const getMessagePreview = (content: string, maxLen = 20): string => {
  if (!content) return '空消息'
  const cleaned = content.replace(/\n/g, ' ').trim()
  return cleaned.length > maxLen ? cleaned.substring(0, maxLen) + '...' : cleaned
}

/** 创建分支聊天 */
const createBranch = (parentIndex: number, msgIndex: number) => {
  const parentChat = chats.value[parentIndex]
  if (!parentChat) return

  // 复制父聊天的上下文（分支点之前的消息 + 配置）
  const branchMessages = parentChat.messages.slice(0, msgIndex + 1)
  const branchMsg = parentChat.messages[msgIndex]
  const label = branchMsg ? getMessagePreview(branchMsg.content, 25) : '分支'

  const branchChat: Chat = {
    ...createNewChatData(),
    parentId: parentChat.id,
    branchMsgIndex: msgIndex,
    branchLabel: label,
    title: label,
    messages: branchMessages.map(m => ({
      ...m,
      images: m.images ? [...m.images] : undefined,
      fileAttachments: m.fileAttachments ? m.fileAttachments.map(f => ({ ...f })) : undefined,
      kbInfo: m.kbInfo ? { ...m.kbInfo, relevantBlocks: m.kbInfo.relevantBlocks ? [...m.kbInfo.relevantBlocks] : undefined } : undefined,
      tokenStats: m.tokenStats ? { ...m.tokenStats } : undefined,
      webSearch: m.webSearch ? { ...m.webSearch, results: m.webSearch.results ? [...m.webSearch.results] : undefined } : undefined,
      executionUnits: m.executionUnits ? [...m.executionUnits] : undefined,
      executionStats: m.executionStats ? { ...m.executionStats, errors: m.executionStats.errors ? [...m.executionStats.errors] : undefined } : undefined,
      executionProgress: m.executionProgress ? { ...m.executionProgress } : undefined
    })),
    config: { ...parentChat.config }
  }

  chats.value.push(branchChat)
  currentChatIndex.value = chats.value.length - 1
  saveChats()
  
  // 自动切换到新聊天
  switchChat(currentChatIndex.value)
}

/** 分支树节点点击：切换到该聊天 */
const switchToBranchChat = (node: BranchTreeNode) => {
  switchChat(node.index)
}

const getModelDisplayName = (config: ChatConfig): string => {
  if (config.model) {
    const name = config.model.length > 20 ? config.model.substring(0, 20) + '...' : config.model
    // 自定义来源：来源名 / 模型名（如 GPUStack / model），多来源下可区分
    if (config.llmType === 'custom') {
      return `${getCustomSourceNameByIndex(config.customSourceIndex)} / ${name}`
    }
    return name
  }
  return getLlmTypeDisplayName(config.llmType, config.customSourceIndex) + (store.locales == 'zh' ? ' (未选择)' : ' (not selected)')
}

/** 自定义来源显示名（默认名回退） */
function getCustomSourceLabel(src?: any): string {
  const name = src && src.name
  return (name && String(name).trim()) ? String(name).trim() : (store.locales == 'zh' ? '自定义' : 'Custom')
}

/** 按来源索引取自定义来源名；未指定时用当前激活来源 */
function getCustomSourceNameByIndex(index?: number): string {
  const c = store.AIconfig.llm.custom
  const sources = Array.isArray(c?.sources) ? c.sources : []
  const src = (typeof index === 'number' && sources[index]) ? sources[index] : sources[c?.activeIndex ?? 0]
  return getCustomSourceLabel(src)
}

/** 模型来源显示名：custom 显示自定义来源名（按索引，缺省取激活来源），其余用品牌名/首字母大写 */
const LLM_TYPE_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gpustack: 'GPUStack',
  anthropic: 'Anthropic',
  google: 'Google',
  azure: 'Azure',
}
function getLlmTypeDisplayName(type: string, customIndex?: number): string {
  if (type === 'custom') return getCustomSourceNameByIndex(customIndex)
  return LLM_TYPE_LABELS[type] || (type.charAt(0).toUpperCase() + type.slice(1))
}

const getRoleDisplay = (role: string): string => {
  // Agent 预设模式：助理显示预设角色名
  if (role === 'assistant' && currentChat.value && currentChat.value.mode === 'agent' && currentChat.value.config.presetId) {
    const preset = store.agentPresets.find((c: any) => c.id === currentChat.value.config.presetId)
    if (preset && preset.name) return preset.name
  }
  if (store.locales == 'zh') {
    const roles: Record<string, string> = {
      'user': '👤 用户',
      'assistant': '🤖 助理',
      'system': '⚙️ 系统'
    }
    return roles[role] || role;
  } else {
    const roles: Record<string, string> = {
      'user': '👤 User',
      'assistant': '🤖 Assistant',
      'system': '⚙️ System'
    }
    return roles[role] || role;
  }
}

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 工具单元图标（智能体：工具名映射；工作流节点：默认齿轮） */
const unitToolIcon = (unit: any): string => {
  if (unit.stepType === 'content') return 'fa-lightbulb-o'
  const toolName = unit.description
  if (toolName && toolIcons[toolName]) return toolIcons[toolName]
  return unit.nodeType === 'python' ? 'fa-code' : 'fa-cog'
}

/** 工具单元标题（智能体：工具中文名；工作流：节点名） */
const unitLabel = (unit: any): string => {
  if (unit.stepType === 'content') return store.locales == 'zh' ? '思考过程' : 'Thinking'
  const toolName = unit.description
  if (toolName) return getToolLabel(toolName)
  if (unit.name) return String(unit.name)
  return store.locales == 'zh' ? '工具调用' : 'Tool call'
}

/** 是否显示工具参数框（python 显示代码输入；计划/清单以文本形式单独呈现） */
const shouldShowUnitArgs = (unit: any): boolean => {
  const n = unit.description
  if (unit.stepType === 'reasoning' || unit.stepType === 'content') return false // 思考/正文走独立块，无参数区
  if (n === 'update_plan' || n === 'update_todo') return false // 计划/清单直接以文本呈现，参数区省略
  if (n === 'server-search-visit') return false // 访问网站：无入参
  if (n === 'server-search-query') return false // 旧数据兼容（老卡片：查询词在结果区）
  // server-search：查询词作为入参显示在参数区，结果在结果区（与 web_search 工具卡片一致）
  return true
}

/** 是否显示工具结果框（计划/清单/run_code 的结果分别由专用块渲染，省略通用结果框） */
const shouldShowUnitResult = (unit: any): boolean => {
  const n = unit.description
  if (unit.stepType === 'reasoning' || unit.stepType === 'content') return false
  if (n === 'update_plan' || n === 'update_todo') return false
  if (n === 'run_code') return false
  return true
}

/** 工具名 → 参数中用于流式展示的字符串字段 key（配合 extractStreamedJsonField，避免流式时显示原始 JSON） */
const toolArgStreamKey = (n: string): string | null => {
  switch (n) {
    case 'read_file':
    case 'list_dir':
    case 'write_file': return 'path'
    case 'run_python': return 'code'
    case 'run_code': return 'code'
    case 'shell': return 'command'
    case 'web_fetch': return 'url'
    case 'web_search':
    case 'server-search':
    case 'kb_search':
    case 'search_files': return 'query'
    case 'skill': return 'name'
    case 'ask_user': return 'question'
    case 'run_subagent': return 'prompt'
    case 'update_plan': return 'plan'
    default: return null
  }
}

/** 工具单元参数文本（按工具类型只提取关键参数，避免整段 JSON） */
const unitArgsText = (unit: any): string => {
  const args = unit.args
  if (args === undefined || args === null) return ''
  const n = unit.description
  const isZh = store.locales == 'zh'
  // 流式未闭合：args 是原始 JSON 字符串，按工具提取对应字段，避免展示原始 JSON
  if (typeof args === 'string') {
    if (n === 'update_todo') return isZh ? '待办清单更新中...' : 'Updating todos...'
    const key = toolArgStreamKey(n)
    if (key) {
      const v = extractStreamedJsonField(args, key)
      if (v !== '') return v
    }
    return prettyJson(args)
  }
  switch (n) {
    case 'run_python':
      return typeof args?.code === 'string' ? args.code : prettyJson(args)
    case 'run_code':
      // PTC：参数即模型提交的 TS 程序（模板里按 TS 高亮渲染）
      return typeof args?.code === 'string' ? args.code : prettyJson(args)
    case 'read_file':
    case 'list_dir':
      return typeof args?.path === 'string' ? args.path : prettyJson(args)
    case 'write_file':
      // 只显示目标路径，内容可能很长不展示
      if (typeof args?.path === 'string') return isZh ? `写入: ${args.path}` : `Write: ${args.path}`
      return prettyJson(args)
    case 'shell':
      return typeof args?.command === 'string' ? args.command : prettyJson(args)
    case 'web_fetch':
      return typeof args?.url === 'string' ? args.url : prettyJson(args)
    case 'web_search':
      return typeof args?.query === 'string' ? args.query : prettyJson(args)
    case 'server-search':
      // 服务端搜索（deepseek-responses）：查询词作为入参显示
      return typeof args?.query === 'string' ? args.query : prettyJson(args)
    case 'kb_search':
      return typeof args?.query === 'string' ? args.query : prettyJson(args)
    case 'skill':
      // 只显示技能名（loadSkill 的入参就是 name）
      return typeof args?.name === 'string' ? args.name : prettyJson(args)
    case 'search_files':
      if (typeof args?.query === 'string') {
        return args.filePattern ? `${args.query} (${args.filePattern})` : args.query
      }
      return prettyJson(args)
    case 'ask_user':
      return typeof args?.question === 'string' ? args.question : prettyJson(args)
    case 'run_subagent':
      if (typeof args?.prompt === 'string') {
        return args.prompt.length > 120 ? args.prompt.slice(0, 120) + '…' : args.prompt
      }
      return prettyJson(args)
    case 'update_plan': {
      // 只显示 plan 字段的值：对象取 plan；流式未闭合时从原文提取
      let plan: any = null
      if (args && typeof args === 'object') plan = args.plan
      else if (typeof args === 'string') plan = extractStreamedJsonField(args, 'plan')
      // 容错：参数里没拿到计划文本时，回退到工具返回值的 plan（模型偶发传 null/空 时兜底）
      if ((plan === undefined || plan === null || plan === '') && unit.result && typeof unit.result === 'object') {
        plan = unit.result.plan
      }
      return typeof plan === 'string' ? plan : ''
    }
    case 'update_todo':
      return Array.isArray(args?.todos)
        ? isZh ? `待办清单 (${args.todos.length} 项)` : `Todo list (${args.todos.length} items)`
        : prettyJson(args)
    default:
      return prettyJson(args)
  }
}

// ---------------------------------------------------------------------------
// 编辑类工具的差异预览（preview 由工具结果单独携带，不进模型上下文）
// ---------------------------------------------------------------------------

/** 取单元上的差异预览文件列表（无则空数组） */
const editDiffAllFiles = (unit: any): EditDiffFilePreview[] => {
  const p = unit?.preview
  if (!p || p.kind !== 'edit-diff' || !Array.isArray(p.files)) return []
  return p.files as EditDiffFilePreview[]
}

/** 可渲染差异的文件（排除新建：新建文件直接展示内容更直观） */
const editDiffFilesOf = (unit: any): EditDiffFilePreview[] =>
  editDiffAllFiles(unit).filter((f) => !!f && Array.isArray(f.lines) && f.lines.length > 0 && !f.created)

/** 折叠态摘要：`路径 +N -M`（多文件时汇总） */
const editDiffSummary = (unit: any): string => {
  const files = editDiffAllFiles(unit)
  if (!files.length || !files.some((f) => !!f?.stats)) return ''
  const added = files.reduce((a, f) => a + (f?.stats?.added || 0), 0)
  const removed = files.reduce((a, f) => a + (f?.stats?.removed || 0), 0)
  const stat = `+${added} -${removed}`
  if (files.length === 1) return `${files[0].path} ${stat}`
  return store.locales == 'zh' ? `${files.length} 个文件 ${stat}` : `${files.length} files ${stat}`
}

/** 差异行前缀符号（add/del；上下文与 gap 为空） */
const editDiffSign = (t: string): string => (t === 'add' ? '+' : t === 'del' ? '-' : '')

/** 差异行显示文本（gap 行显示省略提示） */
const editDiffLineText = (l: any): string => {
  if (l?.t !== 'gap') return String(l?.s ?? '')
  return store.locales == 'zh' ? `⋯ 省略 ${l.c ?? 0} 行` : `⋯ ${l.c ?? 0} lines hidden`
}

/** 工具单元结果文本（按工具类型只提取关键结果） */
const unitResultText = (unit: any): string => {
  const r = unit.result !== undefined && unit.result !== null
    ? unit.result
    : unit.resultPreview !== undefined && unit.resultPreview !== null
      ? unit.resultPreview
      : unit.streamContent
  if (r === undefined || r === null || r === '') return ''
  const n = unit.description
  const isZh = store.locales == 'zh'
  switch (n) {
    case 'reasoning':
      // 思考文本：直接返回全量字符串（流式更新）
      return typeof r === 'string' ? r : prettyJson(r)
    case 'run_python': {
      // 只显示执行返回的结果（output/result 字段），不显示完整对象
      if (typeof r === 'string') return r
      const out = r?.output ?? r?.result ?? r?.stdout ?? r?.text
      if (typeof out === 'string' && out.trim()) return out
      return prettyJson(r)
    }
    case 'run_code': {
      // PTC：折叠摘要 = 返回值（字符串直接用；无返回值时提示程序内调用了几次工具）
      const out = ptcOutputOf(unit)
      if (!out) return typeof r === 'string' ? r : ''
      if (typeof out.result === 'string' && out.result.trim()) return out.result
      if (out.toolCalls.length) {
        return isZh ? `程序内调用 ${out.toolCalls.length} 个工具` : `${out.toolCalls.length} tool call(s) inside the program`
      }
      return formatPtcValue(out.result)
    }
    case 'web_fetch': {
      if (typeof r === 'string') return r
      if (typeof r?.text === 'string' && r.text.trim()) return r.text
      return prettyJson(r)
    }
    case 'web_search': {
      if (typeof r === 'string') return r
      const results = Array.isArray(r?.results) ? r.results : Array.isArray(r) ? r : []
      if (results.length) {
        return results.map((it: any, i: number) => {
          const title = it?.title || ''
          const url = it?.url || ''
          const summary = it?.summary || it?.snippet || it?.text || ''
          const base = `${i + 1}. ${title}${url ? `\n   ${url}` : ''}`
          return summary ? `${base}\n   ${summary}` : base
        }).join('\n')
      }
      return prettyJson(r)
    }
    case 'ask_user':
      if (typeof r === 'string') return r
      if (typeof r?.answer === 'string') return isZh ? `回答: ${r.answer}` : `Answer: ${r.answer}`
      return prettyJson(r)
    case 'update_plan':
      // 只显示 plan 字段的值：对象取 plan；字符串视为 plan 本身；其余不显示
      if (r && typeof r === 'object') {
        return typeof r.plan === 'string' ? r.plan : ''
      }
      return typeof r === 'string' ? r : ''
    case 'update_todo':
      return typeof r?.count === 'number'
        ? (isZh ? `已更新待办清单 (${r.count} 项)` : `Todo list updated (${r.count} items)`)
        : prettyJson(r)
    case 'skill':
      // 只显示技能描述（loadSkill 返回的 description），不展示完整技能内容
      if (typeof r === 'string') return r
      if (typeof r?.description === 'string') return r.description
      return prettyJson(r)
    case 'write_file': {
      // 只给路径 + 行数摘要（具体差异由编辑预览面板展示，避免整文件重复刷屏）
      if (!r || typeof r !== 'object') return typeof r === 'string' ? r : prettyJson(r)
      const st = r.stats ? ` +${r.stats.added} -${r.stats.removed}` : ''
      const createdTip = r.created ? (isZh ? '（新建）' : ' (new)') : ''
      return `${isZh ? '写入' : 'Write'} ${r.path ?? ''}${createdTip}${st}`
    }
    case 'replace_in_file':
    case 'multi_replace': {
      if (!r || typeof r !== 'object') return typeof r === 'string' ? r : prettyJson(r)
      const st = r.stats ? ` +${r.stats.added} -${r.stats.removed}` : ''
      if (n === 'replace_in_file') return `${isZh ? '已修改' : 'Modified'} ${r.path ?? ''}${st}`
      const cnt = Array.isArray(r.files) ? r.files.length : 0
      return isZh ? `已修改 ${cnt} 个文件${st}` : `Modified ${cnt} files${st}`
    }
    default:
      if (typeof r === 'string') return r
      return prettyJson(r)
  }
}

/** 格式化 JSON（对象 → 缩进 JSON；字符串原样） */
const prettyJson = (val: any): string => {
  if (val === undefined || val === null) return ''
  if (typeof val === 'string') return val
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

/** 手动标记/取消任务完成（本地 UI 操作，保存聊天） */
const toggleAgentTodo = (todoId: string) => {
  const chat = currentChat.value
  if (!chat?.agentTodos) return
  const item = chat.agentTodos.find(t => t.id === todoId)
  if (!item) return

  if (item.status === 'done') {
    item.status = 'pending'
  } else if (item.status === 'running' || item.status === 'pending' || item.status === 'cancelled') {
    item.status = 'done'
  }

  saveChats()
}

/** 手动关闭的工具盒子（update_plan / update_todo 可关闭；key = 消息时间戳 + 单元 id） */
const closedToolUnits = ref<Record<string, boolean>>({})
const closedToolUnitKey = (msgTs: number, unitId: string | number) => `${msgTs}:${unitId}`
const isToolUnitClosed = (msgTs: number, unitId: string | number): boolean => !!closedToolUnits.value[closedToolUnitKey(msgTs, unitId)]
const closeToolUnit = (msgTs: number, unitId: string | number) => {
  closedToolUnits.value = { ...closedToolUnits.value, [closedToolUnitKey(msgTs, unitId)]: true }
}

/** 工具卡片展开/折叠状态（key = 消息时间戳 + 单元 id；默认折叠，仅保留单行摘要） */
const expandedToolUnits = ref<Record<string, boolean>>({})
const toolExpandedKey = (msgTs: number, unitId: string | number) => `${msgTs}:${unitId}`
const isToolUnitExpanded = (msgTs: number, unitId: string | number): boolean =>
  !!expandedToolUnits.value[toolExpandedKey(msgTs, unitId)]
const toggleToolUnitExpanded = (msgTs: number, unitId: string | number) => {
  const k = toolExpandedKey(msgTs, unitId)
  expandedToolUnits.value = { ...expandedToolUnits.value, [k]: !isToolUnitExpanded(msgTs, unitId) }
}
/** 折叠态单行摘要：优先输出，其次输入/路径/错误；压缩换行与连续空白为单个空格（不换行、无多余空格） */
const getToolCollapsedText = (unit: any): string => {
  if (!unit) return ''
  // 编辑类工具：优先显示 `路径 +N -M`（对齐 pi 的 edit 摘要）
  const diffSummary = editDiffSummary(unit)
  if (diffSummary) return diffSummary.replace(/\s+/g, ' ').trim()
  let text = unitResultText(unit) || ''
  if (!String(text).trim() && unit.error) text = unit.error
  if (!String(text).trim()) {
    if (unit.description === 'write_file') text = getWriteFilePath(unit) || ''
    else text = unitArgsText(unit) || ''
  }
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * 执行单元按发生时间排序（思考 / 服务端搜索 / 工具调用按真实时间穿插展示）。
 * 使用 startTime 稳定排序；无 startTime 的旧数据保持原顺序。
 */
const sortedExecutionUnits = (units: any[] | undefined): any[] => {
  if (!units || units.length <= 1) return units || []
  return [...units].sort((a, b) => {
    const ta = a?.startTime || 0
    const tb = b?.startTime || 0
    if (ta && tb && ta !== tb) return ta - tb
    // 同时间戳：按 id 序号（reasoning-tl-N / server-search-q-N 等，N 递增即创建序）
    const na = Number(String(a?.id || '').match(/(\d+)$/)?.[1] || 0)
    const nb = Number(String(b?.id || '').match(/(\d+)$/)?.[1] || 0)
    if (na || nb) return na - nb
    return 0
  })
}

/** 全部标记完成 */
const markAllTodosDone = () => {
  const chat = currentChat.value
  if (!chat?.agentTodos) return
  chat.agentTodos.forEach(t => { t.status = 'done' })
  saveChats()
}

/** 清空任务清单 */
const clearAgentTodos = () => {
  const chat = currentChat.value
  if (!chat) return
  chat.agentTodos = []
  saveChats()
}

/** 聊天列表时间显示：刚刚 / X分钟前 / 今天HH:mm / 今年M月D日 / 往年YYYY年M月D日 */
const getChatTimeText = (chat: Chat): string => {
  const t = chat.createdAt || Date.now()
  const now = Date.now()
  const diff = now - t
  if (diff < 60 * 1000) {
    return store.locales === 'zh' ? '刚刚' : 'just now'
  }
  if (diff < 60 * 60 * 1000) {
    return store.locales === 'zh' ? `${Math.floor(diff / 60000)}分钟前` : `${Math.floor(diff / 60000)}m ago`
  }
  const date = new Date(t)
  const today = new Date()
  const isToday = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  if (isToday) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  if (date.getFullYear() === today.getFullYear()) {
    return store.locales === 'zh' ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getMonth() + 1}/${date.getDate()}`
  }
  return store.locales === 'zh' ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

const unitDisplayModes = ref<Map<string | number, 'single' | 'all'>>(new Map())

// 获取单元的显示模式
const getUnitDisplayMode = (unitId: string | number): 'single' | 'all' => {
  return unitDisplayModes.value.get(unitId) || 'single'
}

// 切换单元的显示模式
const toggleUnitDisplayMode = (unitId: string | number) => {
  const current = getUnitDisplayMode(unitId)
  unitDisplayModes.value.set(unitId, current === 'single' ? 'all' : 'single')
  
  // 如果是展开模式，滚动到该单元
  if (current === 'single') {
    nextTick(() => {
      // 找到对应的单元元素并滚动到可见位置
      const unitElement = document.querySelector(`[data-unit-id="${unitId}"]`)
      if (unitElement) {
        unitElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    })
  }
}

// 当新单元创建时，默认设置为单行模式
// 在 onStepStart 或 onStream 中调用
const initUnitDisplayMode = (unitId: string | number) => {
  if (!unitDisplayModes.value.has(unitId)) {
    unitDisplayModes.value.set(unitId, 'single')
  }
}

// 在流式更新时，自动滚动到最新内容
const scrollDetailsContentToBottom = (element: HTMLElement) => {
  if (!element) return
  // 只在展开模式下自动滚动
  const unitId = element.closest('[data-unit-id]')?.getAttribute('data-unit-id')
  if (unitId && getUnitDisplayMode(unitId) === 'all') {
    element.scrollTop = element.scrollHeight
  }
}
</script>

<style scoped>
/* 样式保持不变，与原代码相同 */

.ai-chat-container {
  display: flex;
  height: 100%;
  background-color: var(--backgroundColor);
  position: relative;
  /* 聊天列表侧栏展开宽度（窄屏在媒体查询里改这个变量） */
  --chat-sidebar-w: 220px;
}

/* ====== 分支按钮样式 ====== */
.branch-btn:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.branch-btn.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

/* ====== 分支图面板 - D3 树状图 ====== */
.branch-panel {
  width: 240px;
  border-left: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  background-color: var(--backgroundColor);
  animation: branchPanelFadeIn 0.25s ease;
  overflow: hidden;
  position: relative;
}

@keyframes branchPanelFadeIn {
  from { opacity: 0; transform: translateX(20px); }
  to { opacity: 1; transform: translateX(0); }
}

.branch-panel-content {
  flex: 1;
  overflow: hidden;
  padding: 0;
}

/* D3 树容器 */
.d3-tree-container {
  width: 100%;
  height: 100%;
}

.d3-tree-container svg {
  display: block;
}

/* 侧边栏样式 */
.chat-sidebar {
  width: var(--chat-sidebar-w);
  border-right: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
  /* 展开 / 收缩动画：宽度滑动（内容定宽，过程中不重排，整块随侧栏滑出） */
  transition: width .22s cubic-bezier(.22, .61, .36, 1), border-right-color .22s ease;
}

.chat-sidebar.collapsed {
  width: 0;
  border-right-width: 0;
  border-right-color: transparent;
}

/* 侧栏内容定宽：宽度动画时内容不重排；
   border-box 保证「内容宽 = 侧栏宽」（否则 padding 会让内容比侧栏宽 10px、右侧被裁掉） */
.chat-sidebar > .chat-toolbar,
.chat-sidebar > .chat-list {
  box-sizing: border-box;
  width: var(--chat-sidebar-w);
  flex-shrink: 0;
}

/* 侧边栏顶部工具栏：搜索 + 新建聊天
   与右侧 .chat-header 同一行高（40px 内容 + 1px 边框），控件垂直居中对齐 */
.chat-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 43px;
  padding: 0 5px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}

.chat-search-toggle {
  flex: 1;
  min-width: 0;
  /* 高度与右侧聊天标题输入框 / 下拉框一致（30px） */
  height: 30px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  background-color: var(--backgroundColor);
  font-size: 12px;
  transition: all 0.15s ease;
}
.chat-search-toggle:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.chat-search-box {
  flex: 1;
  min-width: 0;
  /* 高度与右侧聊天标题输入框 / 下拉框一致（30px） */
  height: 30px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--borderColor);
  font-size: 12px;
}
.chat-search-box > i {
  flex-shrink: 0;
  font-size: 12px;
}
.chat-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.chat-search-clear {
  flex-shrink: 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--borderColor);
}
.chat-search-clear:hover {
  color: var(--fontActiveColor);
}

.chat-new-btn {
  flex-shrink: 0;
  /* 高度与右侧聊天标题输入框 / 下拉框一致（30px） */
  width: 30px;
  height: 30px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  background-color: var(--backgroundColor);
  font-size: 12px;
  transition: all 0.15s ease;
}
.chat-new-btn:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.button {
  margin: 0px;
  background-color: var(--backgroundColor);
}

.button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.button.send-disabled {
  cursor: not-allowed;
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 5px;
}

.chat-item {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  /* 与上方搜索/新建按钮、右侧标题框同高（30px） */
  min-height: 30px;
  padding: 4px 6px;
  margin-bottom: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  background-color: var(--backgroundColor);
  position: relative;
}

.chat-item:hover {
  background-color: var(--menuActiveColor);
}

/* 聊天列表拖拽排序（整行可拖拽，无拖动图标） */
.chat-item-body {
  flex: 1;
  min-width: 0;
}
.chat-item-ghost {
  opacity: 0.4;
}

.chat-item.active {
  border-color: var(--fontActiveColor);
  background-color: var(--menuColor);
}

.chat-item.generating {
  border-color: var(--fontActiveColor);
  animation: pulse-border 2s infinite;
}

.chat-item.has-background-execution {
  border-color: rgba(255, 165, 0, 0.5);
  background-color: rgba(255, 165, 0, 0.05);
  animation: pulse-orange 2s infinite;
}

@keyframes pulse-orange {
  0% { border-color: rgba(255, 165, 0, 0.5); }
  50% { border-color: rgba(255, 165, 0, 0.2); }
  100% { border-color: rgba(255, 165, 0, 0.5); }
}

@keyframes pulse-border {
  0% { border-color: var(--fontActiveColor); }
  50% { border-color: rgba(var(--fontActiveColor-rgb), 0.3); }
  100% { border-color: var(--fontActiveColor); }
}

.chat-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  position: relative;
}

.chat-title {
  font-weight: bold;
  font-size: 12px;
  color: var(--fontColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  padding-right: 4px; /* 与右侧时间之间保留少量间距，尽可能多地显示标题 */
}

.chat-item-right {
  display: flex;
  align-items: center;
  gap: 4px;
  position: absolute;
  right: 0px;
  /* 垂直居中：行高变化后时间/删除按钮不会贴到项的上边 */
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
}

/* 模式图标样式 */
.mode-icon {
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px; /* 固定宽度，保证不同图标占位一致 */
  flex-shrink: 0; /* 防止图标被压缩 */
  margin-right: 3px;
}

.chat-item.chat-retrieval .mode-icon {
  color: #f39c12;
}

.chat-item.chat-workflow .mode-icon {
  color: #3498db;
}

.chat-item.chat-skill .mode-icon {
  color: #9b59b6;
}

.chat-item.chat-agent .mode-icon {
  color: #16a085;
}

/* 智能体模式（agent2）：mode-icon 使用技能紫色 rgb(155, 89, 182)，与原版一致 */
.chat-item.chat-agent2 .mode-icon {
  color: #9b59b6;
}

/* 集群模式（swarm）：多智能体协作，使用青蓝色区分 */
.chat-item.chat-swarm .mode-icon {
  color: #2d8cf0;
}

/* PTC 模式（code）：程序化工具调用，使用青色区分 */
.chat-item.chat-code .mode-icon {
  color: #00bcd4;
}

/* Agent 预设选择浮层 */
.agent-preset-picker {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  min-width: 180px;
  max-width: 220px;
  max-height: 175px;
  overflow-y: auto;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  z-index: 1000;
  padding: 4px;
}
.preset-picker-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fontColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 集群成员浮层：失效引用（预设已删/改名）提示行 */
.preset-picker-item.swarm-missing {
  color: #e6a23c;
}
/* 集群设置浮层：比单纯预设列表内容多（成员 + 运行方式 + 总结 + 管理预设），放宽高度与宽度 */
.agent-preset-picker.swarm-picker {
  min-width: 200px;
  max-width: 240px;
  max-height: 300px;
}
/* 集群设置浮层：名称自适应 + 勾选序号徽标（发言顺序）+ 分组标题 */
.swarm-picker-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.swarm-picker-order {
  flex-shrink: 0;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 10px;
  text-align: center;
  color: var(--backgroundColor);
  background: #2d8cf0;
}
.swarm-picker-caption {
  padding: 4px 8px 2px;
  font-size: 11px;
  opacity: 0.6;
}
.preset-picker-item:hover {
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
}
.preset-picker-item.active {
  background: color-mix(in srgb, var(--fontActiveColor) 15%, transparent);
  color: var(--fontActiveColor);
}
.preset-picker-item i {
  color: var(--fontActiveColor);
  flex-shrink: 0;
}
.preset-picker-empty {
  padding: 8px;
  font-size: 11px;
  color: var(--borderColor);
  text-align: center;
}

/* 浏览器模式：共享知识库 / 上传 选择浮层 */
.shared-kb-picker {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  min-width: 220px;
  max-width: 260px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  z-index: 1001;
  padding: 4px;
}
.shared-kb-divider {
  height: 1px;
  background: var(--borderColor);
  margin: 4px 0;
}
.shared-kb-title {
  padding: 4px 8px 2px;
  font-size: 10px;
  color: var(--borderColor);
  white-space: nowrap;
}
.shared-kb-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 对话模式下拉框 */
.mode-select-wrap {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.mode-select {
  flex: 0 0 auto;
  width: 108px;
  height: 31px;
  padding: 0 4px;
  margin: 0;
  font-size: 12px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
}

.mode-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 知识库检索策略选择：样式与 mode-select 统一，仅宽度不同 */
.strategy-select {
  width: 96px;
}

/* 已关联项标签（点击重新选择） */
.mode-linked-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 80px;
  height: 29px;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  font-size: 11px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.mode-linked-chip:hover {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}

.mode-linked-chip i {
  font-size: 11px;
  flex-shrink: 0;
}

.mode-linked-chip.empty {
  color: var(--borderColor);
  font-style: italic;
}

.mode-linked-chip.error {
  border-color: rgba(231, 76, 60, 0.5);
  color: #e74c3c;
}

/* PTC 模式的只读说明胶囊：仅展示（无可配置项），不作出可点击的暗示 */
.mode-linked-chip.mode-chip-static {
  cursor: default;
  color: #00bcd4;
  border-color: rgba(0, 188, 212, 0.45);
  max-width: 150px;
}
.mode-linked-chip.mode-chip-static:hover {
  border-color: rgba(0, 188, 212, 0.45);
  color: #00bcd4;
}

.mode-linked-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 浏览器模式：知识库文件清除按钮 */
.kb-clear-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  border: 1px solid var(--borderColor);
  border-radius: 50%;
  font-size: 10px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.kb-clear-chip:hover {
  border-color: #e74c3c;
  color: #e74c3c;
}

.chat-actions {
  position: relative;
  right: auto;
  top: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.execution-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 2px;
  color: var(--fontActiveColor);
}

.execution-indicator i {
  font-size: 12px;
  animation: spin 2s infinite linear;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(359deg); }
}

.chat-actions {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
  padding: 2px;
  border-radius: 3px;
  font-size: 12px;
}

.chat-item:hover .chat-actions {
  opacity: 0.6;
  pointer-events: auto;
}

.chat-actions:hover {
  opacity: 1 !important;
  color: var(--fontActiveColor);
}

.chat-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--borderColor);
  white-space: nowrap;
  margin-left: 6px;
}

/* 悬浮（或右侧有生成/后台执行指示器）时隐藏时间，让删除按钮/指示器占据最右侧 */
.chat-item:hover .chat-time,
.chat-item.generating .chat-time,
.chat-item.has-background-execution .chat-time {
  display: none;
}

/* 主聊天区域 */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
}

.chat-header {
  padding: 1px 5px;
  border-bottom: 1px solid var(--borderColor);
  display: flex;
  align-items: center;
  flex-shrink: 0;
  height: 40px;
  width: calc(100% - 10px);
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
  gap: 5px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.chat-header::-webkit-scrollbar {
  display: none;
}

/* 上下文占用圆环（chat-header 左侧） */
.context-usage {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}
.context-ring {
  width: 20px;
  height: 20px;
}
.context-ring-bg {
  fill: none;
  stroke: var(--borderColor);
  stroke-width: 2.5;
}
.context-ring-val {
  fill: none;
  stroke-width: 3;
  stroke-linecap: round;
  transition: stroke-dasharray .3s ease, stroke .3s ease;
}

.chat-title-input {
  flex: 2;
  border: 0px;
  height: 30px;
  padding: 0 6px;
  margin: 0;
  background-color: var(--backgroundColor);
  min-width: 100px;
}

.model-select {
  max-width: 150px;
  flex: 1;
  height: 30px;
  padding: 0 4px;
  margin: 0px;
  min-width: 85px;
  /* 无边框（与输入卡片内的控件风格统一），但保留**正常背景色** */
  border: 0;
  border-radius: 6px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
}
.model-select:hover:not(:disabled) {
  /* 悬浮只用中性淡色（不用菜单高亮色）：与正常背景同一色系 */
  background-color: color-mix(in srgb, var(--fontColor) 7%, var(--backgroundColor));
  color: var(--fontActiveColor);
}
/* 下拉列表项：也用正常背景色（否则展开的选项列表会跟着菜单底色） */
.model-select option,
.mode-select option {
  background-color: var(--backgroundColor);
  color: var(--fontColor);
}

select {
  flex: 1;
  background-color: var(--backgroundColor);
}

/* 消息区域 */
.message-container {
  flex: 1;
  overflow-y: auto;
  /* 底部留白：最后一条消息与下方输入卡片之间保留间距，不贴边 */
  padding: 5px 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-height: 0;
}

/* 聊天头部左侧的聊天列表开关（fa-bars）：纯图标，不加按钮边框/底色 */
.chat-header .sidebar-toggle-btn {
  margin: 0 2px 0 0;
  padding: 0;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background-color: transparent;
  color: var(--fontColor);
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition: background-color .15s ease, color .15s ease;
}
.chat-header .sidebar-toggle-btn:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

/* 空聊天（还没有任何历史消息）：
   - 输入卡片用 transform 上移到剩余空间的垂直中部（位移量由 --composer-shift 提供）；
   - 卡片样式本身与有消息时完全相同（见 .input-container 基础规则），只是位置不同；
   - 卡片上方给出引导提示；
   - 发送第一条消息后 .empty-chat 移除 → 卡片平滑「往下」滑回贴底位置。 */
.chat-main.empty-chat .input-area {
  transform: translateY(calc(-1 * var(--composer-shift, 0px)));
}
/* 居中卡片不需要拖动高度（高度由内容决定） */
.chat-main.empty-chat .input-resize-handle {
  display: none;
}

/* 卡片内的配置行由 .input-controls 的基础对齐规则统一（空态与常规态一致，无需单列） */
/* 空聊天引导提示（与卡片同宽、居中对齐：宽度在 .empty-chat 分组规则里统一） */
.chat-main.empty-chat .empty-chat-hint {
  margin-bottom: 10px;
  text-align: center;
  user-select: none;
  animation: fadeIn .3s ease;
}
.chat-main.empty-chat .empty-chat-hint-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--fontColor);
  margin-bottom: 4px;
}
.chat-main.empty-chat .empty-chat-hint-sub {
  font-size: 11px;
  line-height: 1.6;
  color: var(--fontColor);
  opacity: .6;
}

/* 集群模式：成员汇报与其它模式共用消息渲染，无需额外容器样式 */

.message-item {
  border-radius: 6px;
  padding: 8px;
  min-width: 80px;
  max-width: 85%;
  animation: fadeIn 0.2s ease;
  position: relative;
  transition: all 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

.user-message {
  margin-left: auto;
  border: 1px solid var(--borderColor);
}

.assistant-message {
  margin-right: auto;
  border: 1px solid var(--borderColor);
}

.execution-message {
  border-width: 2px;
}

/* 知识片段来源列表 */
.kb-sources {
  margin-top: 8px;
  border-top: 1px solid var(--borderColor, #e0e0e0);
  padding-top: 6px;
}

.kb-sources-header {
  font-size: 11px;
  color: var(--fontColor, #333);
  opacity: 0.7;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.kb-block-item {
  font-size: 12px;
  margin-bottom: 3px;
  border: 1px solid var(--borderColor, #e0e0e0);
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s;
}

.kb-block-item:hover {
  border-color: var(--accentColor, #0078d4);
}

.kb-block-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--accentColorTransparent, rgba(0,120,212,0.05));
}

.kb-block-label {
  flex: 1;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kb-block-score {
  font-size: 10px;
  color: var(--fontColor, #333);
  opacity: 0.6;
}

.kb-block-item .fa-chevron-down {
  font-size: 10px;
  transition: transform 0.2s;
  color: var(--fontColor, #333);
  opacity: 0.4;
}

.kb-block-item .fa-chevron-down.expanded {
  transform: rotate(180deg);
}

.kb-block-content {
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fontColor, #333);
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid var(--borderColor, #e0e0e0);
  max-height: 85px;
  overflow-y: auto;
}

/* 联网搜索状态与来源 */
.web-search-info {
  margin-top: 8px;
  border-top: 1px solid var(--borderColor, #e0e0e0);
  padding-top: 6px;
}

.web-search-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--accentColor, #0078d4);
  opacity: 0.85;
}

.web-search-query {
  color: var(--fontColor, #333);
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.web-search-sources {
  font-size: 12px;
}

.web-search-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fontColor, #333);
  opacity: 0.7;
  margin-bottom: 4px;
}

.web-search-item {
  display: flex;
  align-items: center;
  margin-bottom: 3px;
  border: 1px solid var(--borderColor, #e0e0e0);
  border-radius: 4px;
  overflow: hidden;
  transition: border-color 0.15s;
}

.web-search-item:hover {
  border-color: var(--accentColor, #0078d4);
}

.web-search-link {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accentColor, #0078d4);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.web-search-link:hover {
  text-decoration: underline;
}

.web-search-open {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--fontColor, #333);
  opacity: 0.6;
  border-left: 1px solid var(--borderColor, #e0e0e0);
  background: var(--accentColorTransparent, rgba(0, 120, 212, 0.05));
  transition: all 0.15s;
}

.web-search-open:hover {
  opacity: 1;
  color: var(--accentColor, #0078d4);
}

.execution-running {
  animation: pulse-execution 2s infinite;
}

.execution-workflow {
  border-color: rgba(52, 152, 219, 0.3);
  background-color: rgba(52, 152, 219, 0.03);
}

.execution-skill {
  border-color: rgba(155, 89, 182, 0.3);
  background-color: rgba(155, 89, 182, 0.03);
}

.execution-running.execution-workflow {
  border-color: rgba(52, 152, 219, 0.5);
  background-color: rgba(52, 152, 219, 0.08);
  animation: pulse-workflow 2s infinite;
}

.execution-running.execution-skill {
  border-color: rgba(155, 89, 182, 0.5);
  background-color: rgba(155, 89, 182, 0.08);
  animation: pulse-skill 2s infinite;
}

@keyframes pulse-workflow {
  0% { border-color: rgba(52, 152, 219, 0.5); }
  50% { border-color: rgba(52, 152, 219, 0.2); }
  100% { border-color: rgba(52, 152, 219, 0.5); }
}

@keyframes pulse-skill {
  0% { border-color: rgba(155, 89, 182, 0.5); }
  50% { border-color: rgba(155, 89, 182, 0.2); }
  100% { border-color: rgba(155, 89, 182, 0.5); }
}

.message-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 10px;
  color: var(--borderColor);
  position: relative;
}

.message-role {
  font-weight: bold;
  color: var(--fontColor);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* 运行中引导标记（用户消息是在智能体执行中作为 steer 投递的） */
.message-steer-tag {
  font-weight: normal;
  font-size: 11px;
  color: var(--accentColor, #0078d4);
  background: var(--accentColorTransparent, rgba(0, 120, 212, 0.1));
  border: 1px solid var(--accentColorTransparent, rgba(0, 120, 212, 0.25));
  padding: 0 6px;
  border-radius: 4px;
  white-space: nowrap;
}

/* 运行中引导单元：直接插在步骤时间线里它生效的位置（后续步骤排在其下，比另发气泡更直观） */
.guidance-unit {
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px dashed var(--accentColorTransparent, rgba(0, 120, 212, 0.35));
  background: var(--accentColorTransparent, rgba(0, 120, 212, 0.07));
}

.guidance-unit-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: bold;
  color: var(--accentColor, #0078d4);
}

.guidance-unit-time {
  margin-left: auto;
  font-weight: normal;
  font-size: 11px;
  opacity: 0.7;
}

.guidance-unit-body {
  margin-top: 4px;
  font-size: 13px;
  color: var(--fontColor);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}

.message-node-name {
  font-weight: normal;
  font-size: 12px;
  color: var(--accentColor, #0078d4);
  background: var(--accentColorTransparent, rgba(0,120,212,0.1));
  padding: 0 6px;
  border-radius: 4px;
  white-space: nowrap;
}

.message-node-name {
  font-weight: normal;
  font-size: 12px;
  color: var(--accentColor, #0078d4);
  background: var(--accentColorTransparent, rgba(0,120,212,0.1));
  padding: 0 6px;
  border-radius: 4px;
  white-space: nowrap;
}

.message-node-name {
  font-weight: normal;
  font-size: 12px;
  color: var(--accentColor, #0078d4);
  background: var(--accentColorTransparent, rgba(0,120,212,0.1));
  padding: 0 6px;
  border-radius: 4px;
  white-space: nowrap;
}

/* 思考中占位样式 */
.thinking-placeholder {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
}

.thinking-dots {
  display: flex;
  align-items: center;
  gap: 5px;
}

.thinking-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--fontActiveColor, #3498db);
  animation: thinkingBounce 1.4s ease-in-out infinite both;
}

.thinking-dots span:nth-child(1) {
  animation-delay: -0.32s;
}

.thinking-dots span:nth-child(2) {
  animation-delay: -0.16s;
}

.thinking-dots span:nth-child(3) {
  animation-delay: 0s;
}

@keyframes thinkingBounce {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes thinkingPulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

/* highlight.js 自适应主题 — 使用 CSS 变量，随主题自动切换 */
.message-content :deep(.hljs) {
  color: var(--fontColor, #333);
  background: transparent;
}

.message-content :deep(.hljs-keyword),
.message-content :deep(.hljs-literal),
.message-content :deep(.hljs-built_in),
.message-content :deep(.hljs-type) {
  color: var(--hljs-keyword, #d73a49);
}

.message-content :deep(.hljs-string),
.message-content :deep(.hljs-regexp),
.message-content :deep(.hljs-addition),
.message-content :deep(.hljs-attribute) {
  color: var(--hljs-string, color-mix(in srgb, #032f62 55%, var(--fontColor)));
}

.message-content :deep(.hljs-number),
.message-content :deep(.hljs-boolean) {
  color: var(--hljs-number, #005cc5);
}

.message-content :deep(.hljs-title),
.message-content :deep(.hljs-title.class_),
.message-content :deep(.hljs-title.class_.inherited__),
.message-content :deep(.hljs-title.function_) {
  color: var(--hljs-title, #6f42c1);
}

.message-content :deep(.hljs-comment),
.message-content :deep(.hljs-quote) {
  color: var(--hljs-comment, #6a737d);
  font-style: italic;
}

.message-content :deep(.hljs-variable),
.message-content :deep(.hljs-template-variable) {
  color: var(--hljs-variable, #e36209);
}

.message-content :deep(.hljs-params) {
  color: var(--fontColor, #333);
}

.message-content :deep(.hljs-subst) {
  color: var(--hljs-subst, var(--fontColor));
  font-weight: 600;
  padding: 0 2px;
  border-radius: 2px;
}

.message-content :deep(.hljs-meta),
.message-content :deep(.hljs-selector-tag),
.message-content :deep(.hljs-section) {
  color: var(--hljs-meta, #22863a);
}

.message-content :deep(.hljs-deletion),
.message-content :deep(.hljs-selector-id) {
  color: var(--hljs-deletion, #b31d28);
}

.message-content :deep(.hljs-link) {
  text-decoration: underline;
}

/* HTML/XML 标签与标签名（nnfx-dark 中为白色，浅色主题下不可见，补红色系） */
.message-content :deep(.hljs-tag),
.message-content :deep(.hljs-name) {
  color: var(--hljs-keyword, #d73a49);
}
/* HTML 属性名 / 元信息字符串（补蓝绿色系，与 string 同色） */
.message-content :deep(.hljs-attr),
.message-content :deep(.hljs-meta-string),
.message-content :deep(.hljs-meta .hljs-string) {
  color: var(--hljs-string, color-mix(in srgb, #032f62 55%, var(--fontColor)));
}
/* 符号 / 列表标记（同变量橙色系） */
.message-content :deep(.hljs-symbol),
.message-content :deep(.hljs-bullet) {
  color: var(--hljs-variable, #e36209);
}
/* 纯代码片段：跟随正文 */
.message-content :deep(.hljs-code) {
  color: var(--fontColor, #333);
}
/* 选择器 class / 伪类（同 meta 绿色系） */
.message-content :deep(.hljs-selector-class),
.message-content :deep(.hljs-selector-pseudo) {
  color: var(--hljs-meta, #22863a);
}
/* 文档标签（@param/@return 等）：加粗增强 */
.message-content :deep(.hljs-doctag) {
  font-weight: 600;
}

.message-content :deep(pre) {
  background-color: var(--hljs-bg, rgba(0,0,0,0.04));
  padding: 6px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 4px 0;
  font-size: 11px;
}

.message-content :deep(code) {
  background-color: var(--hljs-bg, rgba(0,0,0,0.04));
  padding: 2px 4px;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  font-size: 11px;
}

.execution-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.execution-badge-workflow {
  background-color: rgba(52, 152, 219, 0.2);
  color: #3498db;
}

.execution-badge-skill {
  background-color: rgba(155, 89, 182, 0.2);
  color: #9b59b6;
}

.execution-badge-retrieval {
  background-color: rgba(243, 156, 18, 0.2);
  color: #f39c12;
}

.execution-progress {
  margin-left: 4px;
  font-size: 8px;
  opacity: 0.8;
}

.action-button {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  color: var(--fontColor);
  transition: all 0.2s ease;
}

.action-button:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.message-content {
  word-wrap: break-word;
  line-height: 1.4;
  font-size: 13px;
}

.message-content :deep(p) {
  margin: 4px 0;
}

.message-content :deep(ul), .message-content :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}

.message-content :deep(li) {
  margin: 2px 0;
}

.message-content :deep(.mermaid-wrapper) {
  margin: 8px 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background-color: rgba(255, 255, 255, 0.03);
  overflow: hidden;
}

.message-content :deep(.mermaid-rendering) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--fontColor);
  opacity: 0.7;
  user-select: none;
}

.message-content :deep(.mermaid-rendering .fa) {
  color: var(--fontColor);
}

.message-content :deep(.mermaid-rendered-svg) {
  overflow-x: auto;
  padding: 8px;
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.message-content :deep(.mermaid-rendered-svg:hover) {
  border-color: rgba(52, 152, 219, 0.4);
}

.message-content :deep(.mermaid-rendered-svg svg) {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;
}

.message-content :deep(.mermaid-fallback) {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.4;
  color: var(--fontColor);
  padding: 8px;
}

.message-content :deep(.mermaid-clickable) {
  position: relative;
}

.message-content :deep(.mermaid-clickable)::after {
  font-family: 'FontAwesome';
  content: '\f002';
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 14px;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.message-content :deep(.mermaid-clickable:hover)::after {
  opacity: 0.7;
}

.message-content :deep(.mermaid svg) {
  max-width: 100%;
  height: auto;
}

.execution-status-container {
  margin: 0;
  padding: 5px;
  border-radius: 8px;
  animation: slideInDown 0.3s ease;
}

.execution-workflow .execution-status-container {
  border: 1px solid rgba(52, 152, 219, 0.3);
  background-color: rgba(52, 152, 219, 0.05);
}

.execution-skill .execution-status-container {
  border: 1px solid rgba(155, 89, 182, 0.3);
  background-color: rgba(155, 89, 182, 0.05);
}

@keyframes slideInDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.execution-progress-bar {
  height: 6px;
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}

.progress-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.progress-workflow {
  background-color: #3498db;
}

.progress-skill {
  background-color: #9b59b6;
}

.execution-unit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}

.execution-unit-item {
  padding: 4px;
  border-radius: 4px;
  border-left: 3px solid #95a5a6;
  background-color: var(--backgroundColor);
}

.unit-skill.unit-pending {
  border-left-color: #95a5a6;
  opacity: 0.6;
}

.unit-skill.unit-running {
  border-left-color: #9b59b6;
  background-color: rgba(155, 89, 182, 0.05);
}

.unit-skill.unit-success {
  border-left-color: #2ecc71;
  background-color: rgba(46, 204, 113, 0.05);
}

.unit-skill.unit-error {
  border-left-color: #e74c3c;
  background-color: rgba(231, 76, 60, 0.05);
}

/* 智能体模式：工具调用列表（tool-box 风格容器） */
.execution-unit-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}
.execution-unit-list :deep(.tool-box) {
  margin-top: 0;
}

/* 智能体模式：任务清单面板（输入框上方；可手动标记/清空） */
.agent-todos-panel {
  margin-bottom: 5px;
  border: 1px solid var(--borderColor, #333);
  border-radius: 6px;
  padding: 6px 8px;
  max-height: 90px;
  overflow-y: auto;
  flex-shrink: 0;
}
.agent-todos-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}
.agent-todos-count { font-size: 11px; opacity: .6; margin-left: auto; }
.agent-todos-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
}
.agent-todos-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  opacity: .65;
  color: var(--fontColor);
  transition: all .15s;
}
.agent-todos-action:hover {
  opacity: 1;
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.agent-todos-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  height:auto;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
.agent-todos-list::-webkit-scrollbar {
  width: 7px;
}
.agent-todos-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 999px;
}
.agent-todos-list::-webkit-scrollbar-track {
  background: transparent;
}
.agent-todo-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
  transition: background-color .15s;
}
.agent-todo-item:hover { background-color: rgba(128, 128, 128, 0.08); }
.agent-todo-item.at-done { opacity: .55; }
.agent-todo-item.at-done i { color: #4CAF50; }
.agent-todo-item.at-running i { color: #2196F3; }
.agent-todo-item.at-cancelled i { color: #9e9e9e; }
.agent-todo-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.agent-todo-item.at-done .agent-todo-title { text-decoration: line-through; }

.unit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  margin-bottom: 2px;
  padding-right: 4px;
}

.unit-header-left {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
}

.unit-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.unit-header i {
  font-size: 10px;
  width: 12px;
}

.unit-type {
  font-size: 10px;
  color: #7f8c8d;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
}

.unit-description {
  font-size: 10px;
  color: var(--fontColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.unit-duration {
  font-size: 9px;
  color: #7f8c8d;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
}

.unit-index {
  font-size: 10px;
  color: #7f8c8d;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 1px 6px;
  border-radius: 10px;
  white-space: nowrap;
}

.unit-details {
  padding: 0px;
  background-color: rgba(0, 0, 0, 0.02);
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  animation: fadeIn 0.2s ease;
}

.unit-stream-content,
.unit-result-preview {
  border-radius: 3px;
  background-color: var(--backgroundColor);
}

.details-content-wrapper {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

.details-content {
  flex: 1;
  font-size: 10px;
  color: var(--fontColor);
  line-height: 1.4;
  max-height: 200px;
  overflow-y: auto;
  padding: 5px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: monospace;
  transition: max-height 0.3s ease;
}

.details-content.single-line {
  max-height: 22px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  /* 添加以下属性，让内容从右向左滚动显示最新内容 */
  direction: rtl;
  text-align: left;
}


/* 展开模式 */
.details-content:not(.single-line) {
  max-height: 200px;
  overflow-y: auto;
}

/* 切换按钮 */
.toggle-details-btn {
  flex-shrink: 0;
  border-radius: 4px;
  color: var(--fontColor);
  cursor: pointer;
  padding: 2px 6px;
  font-size: 10px;
  transition: all 0.2s ease;
  opacity: 0.6;
  height: 22px;
  width: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  margin-right: 1px;
  border:0px
}

.toggle-details-btn:hover {
  background: var(--menuActiveColor);
  opacity: 1;
  border-color: var(--fontActiveColor);
}

.toggle-details-btn i {
  font-size: 10px;
}

/* 滚动条美化 */
.details-content::-webkit-scrollbar {
  width: 3px;
  height: 3px;
}

.details-content::-webkit-scrollbar-track {
  background: var(--backgroundColor);
}

.details-content::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}

/* 单行模式的滚动条隐藏 */
.details-content.single-line::-webkit-scrollbar {
  display: none;
}

.unit-error-message {
  margin-top: 4px;
  padding: 4px;
  background-color: rgba(231, 76, 60, 0.1);
  border-radius: 4px;
  font-size: 10px;
  color: #e74c3c;
  display: flex;
  align-items: center;
  gap: 4px;
  border-left: 3px solid #e74c3c;
}

.execution-stats {
  margin-top: 10px;
  padding: 8px;
  border-radius: 6px;
}

.stats-workflow {
  border: 1px solid rgba(52, 152, 219, 0.2);
  background-color: rgba(52, 152, 219, 0.03);
}

.stats-skill {
  border: 1px solid rgba(155, 89, 182, 0.2);
  background-color: rgba(155, 89, 182, 0.03);
}

.stats-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: bold;
  margin-bottom: 8px;
}

.stats-workflow .stats-header {
  color: #3498db;
}

.stats-skill .stats-header {
  color: #9b59b6;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  color: var(--fontColor);
}

.stat-label {
  opacity: 0.7;
}

.stat-value {
  font-weight: bold;
}

.stats-workflow .stat-value {
  color: #3498db;
}

.stats-skill .stat-value {
  color: #9b59b6;
}

/* 工具返回结果可滚动容器（:deep 使 scoped 样式穿透 v-html 渲染的内容） */
:deep(.tool-result-box) {
  max-height: 320px;
  overflow-y: auto;
  overflow-x: auto;
  font-size: 11px;
  padding: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: monospace;
  margin-top: 4px;
}
/* 工具结果内的列表紧凑化（避免搜索结果等被 markdown 渲染出大间距 ol/li） */
:deep(.tool-result-box ol),
:deep(.tool-result-box ul) {
  margin: 0;
  padding-left: 16px;
}
:deep(.tool-result-box li),
:deep(.tool-result-box p) {
  margin: 1px 0;
  line-height: 1.35;
}

/* Python 代码块（原生 function calling 下代码不在流式文本中，单独展示） */
:deep(.tool-code-box) {
  max-height: 320px;
  overflow-y: auto;
  overflow-x: auto;
  font-size: 11px;
  padding: 6px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: rgba(0, 0, 0, 0.03);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: monospace;
  margin-top: 4px;
}

/* 工具盒子（标题 + 代码 + 结果，技能模式展示工具类型） */
:deep(.tool-box) {
  margin-top: 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  overflow: hidden;
}
:deep(.tool-box-header) {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fontActiveColor);
  background-color: var(--menuColor);
}
:deep(.tool-box-header i) {
  font-size: 11px;
}
:deep(.tool-box .tool-code-box),
:deep(.tool-box .tool-result-box) {
  margin-top: 0;
  border: none;
  border-radius: 0;
  border-top: 1px solid var(--borderColor);
}
/* 编辑类工具的差异预览（变更块 ± 上下文，红绿着色；对齐 pi 的 edit diff 展示） */
.tool-diff-box {
  max-height: 420px;
  overflow: auto;
  font-size: 11px;
  font-family: monospace;
  line-height: 1.45;
  background-color: rgba(0, 0, 0, 0.03);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  margin-top: 4px;
}
.tool-box .tool-diff-box {
  margin-top: 0;
  border: none;
  border-radius: 0;
  border-top: 1px solid var(--borderColor);
}
.tool-diff-head {
  position: sticky;
  top: 0;
  padding: 3px 8px;
  font-weight: 600;
  color: var(--fontActiveColor);
  background-color: var(--menuColor);
  border-bottom: 1px solid var(--borderColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-diff-line {
  display: flex;
  align-items: flex-start;
  padding: 0 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-diff-no {
  flex: 0 0 34px;
  padding-right: 6px;
  text-align: right;
  opacity: .45;
  user-select: none;
}
.tool-diff-sign {
  flex: 0 0 10px;
  opacity: .8;
  user-select: none;
}
.tool-diff-text {
  flex: 1 1 auto;
  min-width: 0;
}
.td-add {
  background-color: rgba(63, 185, 80, 0.14);
}
.td-add .tool-diff-sign,
.td-add .tool-diff-text {
  color: #2ea043;
}
.td-del {
  background-color: rgba(248, 81, 73, 0.12);
}
.td-del .tool-diff-sign,
.td-del .tool-diff-text {
  color: #f85149;
}
.td-gap .tool-diff-text {
  opacity: .5;
  font-style: italic;
}
.tool-diff-note {
  padding: 2px 8px;
  font-size: 10px;
  opacity: .6;
  border-top: 1px dashed var(--borderColor);
}
/* 流式生成中的代码框（闪烁提示正在生成） */
:deep(.tool-code-box.streaming) {
  animation: toolStreamPulse 1.2s ease-in-out infinite;
}
@keyframes toolStreamPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* 工具调用徽章（:deep 穿透 v-html） */
:deep(.tool-badge) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 4px;
  background-color: var(--accentColorTransparent, rgba(0,120,212,0.1));
  border: 1px solid var(--borderColor);
  color: var(--fontColor);
  white-space: nowrap;
  vertical-align: middle;
  line-height: 1.6;
}
:deep(.tool-badge i) {
  font-size: 11px;
  opacity: 0.8;
}
:deep(.tool-badge:hover) {
  background-color: var(--menuActiveColor);
  border-color: var(--fontActiveColor);
}

/* 智能体模式工具调用（tool-box 风格）：标题、状态与错误结果 */
.tool-box-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-box-status {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}
.tool-box-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  cursor: pointer;
  opacity: .55;
  flex-shrink: 0;
  transition: all .15s;
}
.tool-box-close:hover {
  opacity: 1;
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
/* 展开/折叠开关（状态图标右侧） */
.tool-box-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  cursor: pointer;
  opacity: .55;
  flex-shrink: 0;
  transition: all .15s;
  color: var(--fontColor);
}
/* 「打开」按钮（写入本地网页时出现在展开开关左侧）：用内置浏览器打开该网页 */
.tool-box-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  cursor: pointer;
  opacity: .55;
  flex-shrink: 0;
  transition: all .15s;
  color: var(--fontColor);
}
.tool-box-open:hover {
  opacity: 1;
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.tool-box-open i {
  font-size: 10px;
}
.tool-box-toggle:hover {
  opacity: 1;
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.tool-box-toggle i {
  font-size: 10px;
  transition: transform .18s ease;
}
.tool-box-toggle.expanded i {
  transform: rotate(180deg);
}
/* 折叠态单行摘要：不换行、无多余空格，超出省略（点击可展开） */
.tool-box-preview {
  display: block;
  padding: 5px 8px;
  border-top: 1px solid var(--borderColor);
  font-size: 11px;
  line-height: 1.4;
  color: var(--fontColor);
  opacity: .9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
}
.tool-box-preview:hover {
  background-color: var(--menuColor);
  color: var(--fontActiveColor);
}
.tool-box-status.running i { color: #2196F3; }
.tool-box-status.success i { color: #4CAF50; }
.tool-box-status.error i { color: #f44336; }
/* PTC（run_code）执行块：console 日志 / 返回值 / 程序内调用的工具 */
:deep(.tool-ptc-result) { display: flex; flex-direction: column; }
:deep(.tool-ptc-logs) { max-height: 160px; }
:deep(.tool-ptc-log) { display: flex; gap: 6px; line-height: 1.5; }
:deep(.tool-ptc-log-tag) { flex: none; width: 34px; font-size: 9px; text-transform: uppercase; opacity: .65; }
:deep(.tool-ptc-log.warn) { color: #FFC107; }
:deep(.tool-ptc-log.error) { color: #f44336; }
:deep(.tool-ptc-return) { max-height: 240px; }
:deep(.tool-ptc-running) { opacity: .75; font-style: italic; }
:deep(.tool-ptc-internal) { display: flex; flex-direction: column; gap: 2px; padding: 5px 8px; border-top: 1px solid var(--borderColor); }
:deep(.tool-ptc-internal-head) { display: flex; align-items: center; gap: 5px; font-size: 10px; opacity: .75; }
:deep(.tool-ptc-internal-item) { display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 1.5; }
:deep(.tool-ptc-internal-item.err) { color: #f44336; }
:deep(.tool-ptc-internal-item.ok > i) { color: #4CAF50; }
:deep(.tool-ptc-internal-name) { flex: none; font-weight: 500; }
:deep(.tool-ptc-internal-input) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
:deep(.tool-ptc-internal-err) { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:deep(.tool-result-box.tool-result-error) {
  color: #f44336;
  background-color: rgba(244, 67, 54, 0.06);
}
/* tool-code-box 内嵌 highlight.js 代码（python 渲染）与容器对齐，去掉自带边框 */
:deep(.tool-code-box .hljs) {
  background: transparent;
  padding: 0;
  margin: 0;
  font-size: inherit;
  border: none;
  overflow-x: auto;
}
:deep(.tool-code-box .hljs code) {
  background: transparent;
  padding: 0;
  border: none;
}
/* tool-result-box 内嵌 write_file 内容高亮（同 code-box 对齐，去掉自带边框） */
:deep(.tool-result-box .hljs) {
  background: transparent;
  padding: 0;
  margin: 0;
  font-size: inherit;
  border: none;
  overflow-x: auto;
}
:deep(.tool-result-box .hljs code) {
  background: transparent;
  padding: 0;
  border: none;
}
/* 计划/清单类工具的文本行（update_plan / update_todo） */
.tool-plan-line {
  font-size: 12px;
  padding: 6px 8px;
  border-top: 1px solid var(--borderColor);
  word-break: break-word;
  color: var(--fontColor);
}
/* ---- 深度思考折叠块（home 普通聊天 <think>…</think> 展示） ---- */
.think-block {
  margin: 4px 0 10px;
  border: 1px solid var(--borderColor, #e0e0e0);
  border-radius: 8px;
  background: color-mix(in srgb, #d0a64a 6%, transparent);
  overflow: hidden;
}
.think-block-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  color: var(--fontColor, #888);
  font-size: 12px;
  user-select: none;
}
.think-block-header > i:first-child { color: #d0a64a; }
.think-block-header .think-toggle {
  margin-left: auto;
  font-size: 10px;
  color: var(--borderColor);
}
.think-block-body {
  padding: 0 12px 8px;
  max-height: 320px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fontColor);
  opacity: 0.9;
  word-break: break-word;
}
.think-block-body :deep(p) { margin: 2px 0; }
.think-block-body :deep(pre),
.think-block-body :deep(code) { font-size: 11px; }
/* 思考块（reasoning 单元）：流式思维链，弱化配色 + 可滚动 */
.tool-reasoning-line {
  font-size: 12px;
  padding: 6px 8px;
  border-top: 1px solid var(--borderColor);
  word-break: break-word;
  color: var(--fontColor);
  opacity: 0.85;
  background-color: rgba(255, 193, 7, 0.04);
  max-height: 380px;
  overflow-y: auto;
}
/* 思考进行中：闪烁提示（复用 toolStreamPulse keyframes） */
.tool-reasoning-line.streaming {
  animation: toolStreamPulse 1.2s ease-in-out infinite;
}
/* 思考内容 markdown 紧凑排版，避免大间距 */
.tool-reasoning-line :deep(p) {
  margin: 2px 0;
}
.tool-reasoning-line :deep(ul),
.tool-reasoning-line :deep(ol) {
  margin: 2px 0;
  padding-left: 18px;
}
.tool-reasoning-line :deep(li) {
  margin: 1px 0;
  line-height: 1.45;
}
.tool-reasoning-line :deep(pre),
.tool-reasoning-line :deep(code) {
  font-size: 11px;
}
.tool-reasoning-line :deep(h1),
.tool-reasoning-line :deep(h2),
.tool-reasoning-line :deep(h3),
.tool-reasoning-line :deep(h4) {
  margin: 4px 0 2px;
  font-size: 13px;
}
.tool-reasoning-line :deep(strong) {
  font-weight: 600;
}
/* Markdown 渲染的计划内容：紧凑排版，避免大间距 */
.tool-plan-line :deep(p) {
  margin: 2px 0;
}
.tool-plan-line :deep(ul),
.tool-plan-line :deep(ol) {
  margin: 2px 0;
  padding-left: 18px;
}
.tool-plan-line :deep(li) {
  margin: 1px 0;
  line-height: 1.45;
}
.tool-plan-line :deep(pre),
.tool-plan-line :deep(code) {
  font-size: 11px;
}
.tool-plan-line :deep(h1),
.tool-plan-line :deep(h2),
.tool-plan-line :deep(h3),
.tool-plan-line :deep(h4) {
  margin: 4px 0 2px;
  font-size: 13px;
}
.tool-plan-line :deep(strong) {
  font-weight: 600;
}

.execution-error-summary {
  margin-top: 6px;
  padding: 4px 6px;
  background-color: rgba(231, 76, 60, 0.1);
  border-radius: 4px;
  font-size: 10px;
  color: #e74c3c;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 图片预览区域 */
/* 消息气泡中的文件附件标签 */
.message-file-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(52, 152, 219, 0.12);
}

.file-attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background-color: rgba(52, 152, 219, 0.08);
  border: 1px solid rgba(52, 152, 219, 0.15);
  border-radius: 4px;
  font-size: 11px;
  color: var(--fontColor);
  cursor: default;
  transition: background-color 0.15s ease;
}

.file-attachment-chip:hover {
  background-color: rgba(52, 152, 219, 0.15);
}

.file-attachment-chip i {
  font-size: 12px;
  color: var(--fontActiveColor);
}

.file-attachment-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-attachment-chars {
  opacity: 0.6;
  font-size: 10px;
}

.image-preview-container {
  margin: 0px;
  padding: 0px;
  border: 1px solid rgba(52, 152, 219, 0.2);
  border-radius: 5px;
  background-color: rgba(52, 152, 219, 0.05);
}

.image-preview-item {
  position: relative;
  display: inline-block;
  margin: 0px;
  border-radius: 5px;
  overflow: hidden;
  transition: all 0.2s ease;
}

.image-preview-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0,0,0,0.1);
}

.message-image {
  max-width: 200px;
  max-height: 200px;
  border-radius: 4px;
  cursor: pointer;
  transition: transform 0.2s ease;
}

.message-image:hover {
  transform: scale(1.05);
}

.image-actions {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.image-preview-item:hover .image-actions {
  opacity: 1;
}

.image-action-button {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.6);
  border-radius: 4px;
  color: white;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}

.image-action-button:hover {
  background-color: var(--fontActiveColor);
  transform: scale(1.1);
}

/* 输入区域的文件/图片预览 */
.preview-area {
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid rgba(52, 152, 219, 0.2);
  border-radius: 8px;
  background-color: rgba(52, 152, 219, 0.05);
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--fontColor);
  font-weight: 500;
}

.clear-uploads-button {
  padding: 2px 6px;
  border-radius: 4px;
  background-color: rgba(231, 76, 60, 0.1);
  color: #e74c3c;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 11px;
}

.clear-uploads-button:hover {
  background-color: rgba(231, 76, 60, 0.2);
}

.preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 100px;
  overflow-y: auto;
}

.preview-item-small {
  position: relative;
  width: 60px;
  height: 60px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid rgba(52, 152, 219, 0.15);
}

.preview-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-file-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(52, 152, 219, 0.08);
  color: var(--fontColor);
  font-size: 22px;
}

.preview-actions {
  position: absolute;
  top: 2px;
  right: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: 2;
}

.preview-item-small:hover .preview-actions {
  opacity: 1;
}

.preview-action-button {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.6);
  border-radius: 50%;
  color: white;
  cursor: pointer;
  font-size: 10px;
}

.preview-filename {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: rgba(0, 0, 0, 0.6);
  color: white;
  font-size: 9px;
  padding: 2px 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-charcount {
  font-size: 8px;
  opacity: 0.85;
}

/* 图片预览模态框 */
.image-preview-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s ease;
}

.modal-content {
  max-width: 90%;
  max-height: 90%;
  background-color: var(--backgroundColor);
  border-radius: 12px;
  padding: 5px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.3);
}

.full-size-image {
  max-width: 100%;
  max-height: calc(90vh - 80px);
  border-radius: 5px;
  display: block;
  margin: 0 auto;
}

.modal-actions {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
}

.modal-button {
  padding: 5px;
  border: none;
  border-radius: 6px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: 1;
  min-width: 100px;
  font-size: 14px;
}

.modal-button i {
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-button span {
  display: inline-block;
  text-align: center;
}

.modal-button {
  line-height: 1.5;
  height: 40px;
}
.modal-button:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

/* 知识库标签样式 */
.kb-tags-container {
  margin-top: 8px;
  padding: 6px;
  border: 1px solid rgba(52, 152, 219, 0.1);
  border-radius: 6px;
  font-size: 11px;
}

.kb-tags-header {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
  color: var(--fontActiveColor);
  font-weight: 500;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s ease;
}

.kb-tags-header i {
  font-size: 10px;
  transition: transform 0.2s ease;
}

.kb-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.kb-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background-color: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 12px;
  cursor: help;
  transition: all 0.2s ease;
  max-width: 200px;
  overflow: hidden;
}

.kb-tag:hover {
  border-color: var(--fontActiveColor);
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.tag-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fontColor);
  font-size: 10px;
}

.tag-similarity {
  font-size: 9px;
  font-weight: bold;
  color: var(--fontActiveColor);
  min-width: 30px;
  text-align: right;
}

.kb-tag .tag-similarity {
  color: var(--similarity-color);
}

.kb-details {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(52, 152, 219, 0.1);
}

.kb-detail-item {
  margin-bottom: 6px;
  padding: 4px;
  background-color: var(--backgroundColor);
  border-radius: 4px;
  border-left: 3px solid var(--fontActiveColor);
}

.kb-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2px;
  font-size: 10px;
}

.detail-label {
  font-weight: bold;
  color: var(--fontColor);
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-similarity {
  font-size: 9px;
  font-weight: bold;
  color: var(--fontActiveColor);
}

.kb-detail-content {
  font-size: 10px;
  color: var(--fontColor);
  line-height: 1.3;
  max-height: 60px;
  overflow-y: auto;
  padding: 2px;
  border-radius: 2px;
}

/* 问答模式样式 */
.question-container {
  width: 100%;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.question-message {
  font-size: 13px;
  color: var(--fontColor);
  padding-bottom: 5px;
  border-radius: 4px;
  word-break: break-word;
}

.question-input-area {
  width: 100%;
}

.question-textarea {
  width: calc(100% - 12px);
  min-height: 60px;
  max-height: 120px;
  font-size: 12px;
  padding: 5px;
  line-height: 1.4;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  resize: vertical;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-family: inherit;
}

.question-textarea:focus {
  outline: none;
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 0 2px rgba(var(--fontActiveColor-rgb), 0.1);
}

.question-actions {
  display: flex;
  flex-direction: row;
  gap: 5px;
}

.question-actions .button {
  background-color: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}

.question-actions .button:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.question-actions .button i {
  font-size: 14px;
}

/* 输入区域：空聊天与有消息时都是同一张「圆角矩形输入卡片」，
   区别只有垂直位置（空态居中、有消息时贴底）与卡片上方是否显示引导提示。 */
.input-area {
  /* 上边不再留空白：卡片紧贴消息区底部（仅左右/下保留间距） */
  padding: 0 6px 8px;
  flex-shrink: 0;
  position: relative;
  /* 空聊天→常规布局的位移过渡（居中↔贴底） */
  transition: transform .32s cubic-bezier(.22, .61, .36, 1);
}

/* 输入卡片：包住输入框与下方操作行（模式选择 / 附件 / 语音 / 发送）。
   有消息时**通栏**（不限制最大宽度）；只有空白聊天时才收窄居中（见下方 .empty-chat 规则）。 */
.input-container {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 10px;
  /* 卡片用正常背景色（卡片内的输入框 / 下拉框也是同一个色，整体素白） */
  background-color: var(--backgroundColor);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.07);
  transition: border-color .2s ease, box-shadow .2s ease, width .32s ease;
}
/* 聚焦时卡片高亮（现代输入条的典型反馈） */
.input-container:focus-within {
  border-color: var(--menuActiveColor);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.12);
}
/* 卡片上方的任务清单 / 预览区：有消息时与卡片同宽（通栏，不限制最大宽度） */
.input-area > .agent-todos-panel,
.input-area > .preview-area {
  box-sizing: border-box;
  width: 100%;
}
/* 空白聊天：卡片 / 引导提示 / 上方面板统一收窄居中，保证三者对齐 */
.chat-main.empty-chat .input-container,
.chat-main.empty-chat .empty-chat-hint,
.chat-main.empty-chat .input-area > .agent-todos-panel,
.chat-main.empty-chat .input-area > .preview-area {
  width: min(820px, calc(100% - 20px));
  margin-left: auto;
  margin-right: auto;
}

/* 输入框拖动缩放条 - 完全不可见，仅悬停改变光标；
   绝对定位叠加在输入区顶部，不占布局高度（避免输入框上方多出一条空白挡住消息） */
.input-resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  z-index: 2;
  cursor: row-resize;
  user-select: none;
}

.step-info-container {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 5px;
  flex-wrap: wrap;
  gap: 5px;
}

.step-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 8px;
  animation: pulse 2s infinite;
  flex-shrink: 0;
}

.step-indicator.step-sending {
  background-color: rgba(52, 152, 219, 0.1);
  color: #3498db;
  border: 1px solid rgba(52, 152, 219, 0.2);
}

.step-indicator.step-retrieving {
  background-color: rgba(243, 156, 18, 0.1);
  color: #f39c12;
  border: 1px solid rgba(243, 156, 18, 0.2);
}

.step-indicator.step-thinking {
  background-color: rgba(46, 204, 113, 0.1);
  color: #2ecc71;
  border: 1px solid rgba(46, 204, 113, 0.2);
}

.step-indicator.step-generating {
  background-color: rgba(155, 89, 182, 0.1);
  color: #9b59b6;
  border: 1px solid rgba(155, 89, 182, 0.2);
}

.step-indicator.step-skill-matching {
  background-color: rgba(52, 152, 219, 0.1);
  color: #3498db;
  border: 1px solid rgba(52, 152, 219, 0.2);
}

.step-indicator.step-skill-executing {
  background-color: rgba(155, 89, 182, 0.1);
  color: #9b59b6;
  border: 1px solid rgba(155, 89, 182, 0.2);
}

.step-indicator.step-executing {
  background-color: rgba(46, 204, 113, 0.1);
  color: #2ecc71;
  border: 1px solid rgba(46, 204, 113, 0.2);
}

.step-indicator.step-progress {
  background-color: rgba(52, 152, 219, 0.1);
  color: #3498db;
  border: 1px solid rgba(52, 152, 219, 0.2);
}

.step-indicator.step-error {
  background-color: rgba(231, 76, 60, 0.1);
  color: #e74c3c;
  border: 1px solid rgba(231, 76, 60, 0.2);
}

.step-indicator.step-success {
  background-color: rgba(46, 204, 113, 0.1);
  color: #2ecc71;
  border: 1px solid rgba(46, 204, 113, 0.2);
}

.step-indicator.step-info {
  background-color: rgba(52, 152, 219, 0.1);
  color: #3498db;
  border: 1px solid rgba(52, 152, 219, 0.2);
}

.step-indicator.step-testing {
  background-color: rgba(52, 152, 219, 0.1);
  color: #3498db;
  border: 1px solid rgba(52, 152, 219, 0.2);
}

.step-indicator.step-workflow {
  background-color: rgba(52, 152, 219, 0.1);
  color: #3498db;
  border: 1px solid rgba(52, 152, 219, 0.2);
}

.step-indicator.step-skill {
  background-color: rgba(155, 89, 182, 0.1);
  color: #9b59b6;
  border: 1px solid rgba(155, 89, 182, 0.2);
}

.step-indicator i {
  font-size: 12px;
}

@keyframes pulse {
  0% { opacity: 0.9; }
  50% { opacity: 1; }
  100% { opacity: 0.9; }
}

.retrieval-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 10px;
  background-color: rgba(52, 152, 219, 0.05);
  border: 1px solid rgba(52, 152, 219, 0.1);
  border-radius: 8px;
  padding: 4px 8px;
  margin-left: auto;
  flex-shrink: 0;
}

.retrieval-stats .stat-item {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--fontColor);
  white-space: nowrap;
}

.retrieval-stats .stat-item i {
  font-size: 10px;
  color: var(--fontActiveColor);
}

.retrieval-stats .stat-item span {
  font-weight: bold;
  color: var(--fontActiveColor);
}

.message-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 60px;
  max-height: 120px;
  font-size: 12px;
  /* 内边距与卡片一致地保持紧凑（文字区左右对称，不再留 20px 右侧空白） */
  padding: 6px 6px 2px;
  line-height: 1.4;
  /* 文字输入区：无边框，背景与下方下拉框一致（正常背景色） */
  border: 0;
  border-radius: 6px;
  background-color: var(--backgroundColor);
  resize: none;
}

.input-controls {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 5px;
  /* 与输入框保持固定间距（空态卡片 / 常规态一致） */
  margin-top: 4px;
}

/* 输入行操作控件（对话模式 / 附件 / 语音 / 发送）：统一为**无边框**控件——
   去掉边框与深色盒底，只保留图标 / 下拉；空聊天（居中卡片）与常规态外观完全一致，
   悬停 / 激活才给底色反馈。高度也统一（原本下拉 31px、按钮 23px 看着不齐）。 */
.input-controls .button,
.input-controls .mode-select {
  height: 28px;
  border: 0;
  border-radius: 6px;
  box-shadow: none;
  color: var(--fontColor);
}
/* 图标按钮：无边框、透明底（幽灵样式） */
.input-controls .button {
  background-color: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 7px;
}
/* 下拉框：无边框但用**正常背景色**（不用透明 / 菜单底色） */
.input-controls .mode-select {
  background-color: var(--backgroundColor);
  padding: 0 4px;
  font-size: 12px;
}
.input-controls .button:hover:not(.send-disabled):not(.disabled) {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
/* 下拉框悬浮：保持正常背景色系（不用菜单高亮色） */
.input-controls .mode-select:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--fontColor) 7%, var(--backgroundColor));
  color: var(--fontActiveColor);
}

/* 发送/语音等右侧操作组：整组贴到输入行最右侧（吃掉左侧空白），宽度按内容，不拉伸占满 */
.input-controls .input-right-group {
  margin-left: auto;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 5px;
}
.input-controls .send-button {
  flex: 0 0 auto;
  min-width: 30px;
}

/* 生成状态 / 连接测试 / 执行提示 / 检索统计（原在输入框上方）：
   现占附件按钮右侧的空白，样式与输入卡片统一 —— 无边框、无深色底，只用弱化的文字色，
   过长时省略（不把右侧的语音/发送挤走）。 */
.input-controls .step-info-container {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: nowrap;
  gap: 6px;
  overflow: hidden;
}
/* 状态图标：与附件按钮同尺寸（28px 方型幽灵控件），只显示图标，完整提示在 title 上 */
.input-controls .step-info-container .step-indicator {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  min-width: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background-color: transparent;
  animation: none;
  color: var(--fontActiveColor);
  opacity: .8;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}
.input-controls .step-info-container .step-indicator i {
  margin: 0;
  font-size: 13px;
}
/* 错误提示：保持红色 + 可点击关闭 */
.input-controls .step-info-container .step-indicator.step-error {
  color: #e74c3c;
}
.input-controls .step-info-container .step-indicator.clickable {
  cursor: pointer;
}
.input-controls .step-info-container .retrieval-stats {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 0;
  border: 0;
  background-color: transparent;
  opacity: .6;
}

.parameter {
  display: flex;
  align-items: center;
  font-size: 11px;
  color: var(--fontColor);
}

.parameter label {
  white-space: nowrap;
  min-width: 20px;
  padding: 0px;
}

.param-slider {
  width: 80px;
  height: 4px;
  background: var(--borderColor);
  border-radius: 2px;
  outline: none;
}

.param-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--fontActiveColor);
  cursor: pointer;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  white-space: nowrap;
  padding: 0;
  font-size: 11px;
}

.checkbox-label input[type="checkbox"] {
  width: 12px;
  height: 12px;
  margin: 0;
}

.button.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.button.workflow-running,
.button.execution-active {
  animation: pulse-execution 2s infinite;
}

.button.workflow-error {
  background-color: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
}

.button.execution-loading {
  background-color: rgba(155, 89, 182, 0.2);
  color: #9b59b6;
  animation: pulse-skill-button 2s infinite;
}
.unit-decision-info{
  font-size: 10px;
  color: var(--fontColor);
  background-color: rgba(0, 0, 0, 0.02);
  padding: 4px;
}

.message-right-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: var(--borderColor);
  flex-shrink: 0;
}

/* Token 统计样式 */
.token-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--borderColor);
  padding: 1px 6px;
  border-radius: 10px;
  cursor: help;
  transition: all 0.2s ease;
}

.token-count {
  display: flex;
  align-items: center;
  gap: 3px;
}

.token-count i {
  font-size: 9px;
}

.token-speed {
  display: flex;
  align-items: center;
  gap: 3px;
}

.token-speed i {
  font-size: 9px;
}

/* 消息时间 */
.message-time {
  font-size: 10px;
  color: var(--fontColor);
  flex-shrink: 0;
}

/* 消息头部布局调整 */
.message-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 10px;
  color: var(--borderColor);
  position: relative;
  flex-wrap: wrap;
  gap: 4px;
}

.message-role {
  font-weight: bold;
  color: var(--fontColor);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
}

@keyframes pulse-execution {
  0% { box-shadow: 0 0 0 0 rgba(52, 152, 219, 0.4); }
  70% { box-shadow: 0 0 0 4px rgba(52, 152, 219, 0); }
  100% { box-shadow: 0 0 0 0 rgba(52, 152, 219, 0); }
}

@keyframes pulse-skill-button {
  0% { box-shadow: 0 0 0 0 rgba(155, 89, 182, 0.4); }
  70% { box-shadow: 0 0 0 4px rgba(155, 89, 182, 0); }
  100% { box-shadow: 0 0 0 0 rgba(155, 89, 182, 0); }
}

/* 响应式调整 */
@media (max-width: 768px) {
  .ai-chat-container {
    /* 窄屏侧栏变窄；宽度与内容都由该变量推导（收起时不留空位） */
    --chat-sidebar-w: 150px;
  }
  
  .step-indicator {
    font-size: 10px;
    padding: 4px 8px;
  }
  
  .param-slider {
    width: 40px;
  }

  .retrieval-stats {
    font-size: 9px;
    gap: 8px;
    padding: 3px 6px;
  }
  
  .retrieval-stats .stat-item {
    gap: 3px;
  }
  
  .retrieval-stats .stat-item i {
    font-size: 9px;
  }
  
  .kb-tags-container {
    font-size: 10px;
  }
  
  .kb-tag {
    max-width: 150px;
    padding: 1px 4px;
  }
  
  .tag-label {
    font-size: 9px;
  }
  
  .tag-similarity {
    font-size: 8px;
    min-width: 25px;
  }
  
  .kb-detail-item {
    font-size: 9px;
  }
  
  .detail-label {
    max-width: 60%;
  }
  
  .typing-dots-inline {
    margin-left: 4px;
  }
  
  .typing-dots-inline span {
    width: 3px;
    height: 3px;
  }
  
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .unit-type {
    min-width: 50px;
  }
}

/* 右键菜单样式 */
.context-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 999;
}

.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 150px;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  padding: 4px 0;
  font-size: 12px;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--fontColor);
  transition: background 0.1s;
}

.context-menu-item:hover {
  background: var(--menuActiveColor);
}

.context-menu-item i {
  width: 16px;
  text-align: center;
  font-size: 13px;
}

.context-menu-divider {
  height: 1px;
  background: var(--borderColor);
  margin: 3px 0;
}

/* 右键菜单子菜单 */
.context-menu-item.has-submenu {
  position: relative;
}

.context-menu-item.has-submenu .submenu {
  display: none;
  position: absolute;
  left: 100%;
  top: 0;
  min-width: 160px;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  padding: 4px 0;
  list-style: none;
  margin: 0;
  z-index: 1001;
}

.context-menu-item.has-submenu:hover .submenu,
.context-menu-item.has-submenu .submenu:hover {
  display: block;
}

.context-menu-item.has-submenu .submenu li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--fontColor);
  font-size: 12px;
  transition: background 0.1s;
  white-space: nowrap;
}

.context-menu-item.has-submenu .submenu li:hover {
  background: var(--menuActiveColor);
}

.context-menu-item.has-submenu .submenu li i {
  width: 16px;
  text-align: center;
  font-size: 13px;
}

/* ASR 语音输入按钮 */
.asr-button {
  transition: all 0.2s ease;
  min-width: 30px; /* 略微加宽，容纳波形动画 */
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

/* 录音/识别中的波形动画条（参照编辑视图 asr-wave-wrap） */
.asr-wave-dot {
  display: inline-block;
  width: 3px;
  height: 4px;
  border-radius: 2px;
  background: var(--fontActiveColor);
  animation: asr-dot-bounce 0.6s ease-in-out infinite alternate;
}
@keyframes asr-dot-bounce {
  0%   { height: 4px; }
  50%  { height: 14px; }
  100% { height: 4px; }
}

/* ASR 错误提示气泡 */
.asr-error-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background-color: #e74c3c;
  color: var(--fontColor);
  font-size: 11px;
  padding: 5px 10px;
  border-radius: 6px;
  white-space: nowrap;
  z-index: 100;
  animation: asr-error-fadein 0.2s ease;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  pointer-events: none;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.asr-error-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: #e74c3c;
}

.asr-error-tooltip i {
  margin-right: 4px;
  font-size: 10px;
}

@keyframes asr-error-fadein {
  from { opacity: 0; transform: translateX(-50%) translateY(5px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

.asr-button.asr-recording {
  animation: asr-pulse 1.2s ease-in-out infinite;
}

.asr-button.asr-processing {
  color: var(--fontColor) !important;
  border-color: var(--fontActiveColor) !important;
}

/* 识别中：旋转圆环 + 麦克风（处理动画，避免看起来卡住） */
.asr-processing-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}
.asr-processing-ring {
  position: absolute;
  inset: 0;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: var(--fontColor);
  border-radius: 50%;
  animation: asr-ring-spin 0.8s linear infinite;
}
.asr-processing-mic {
  font-size: 9px;
  color: var(--fontColor);
}
@keyframes asr-ring-spin {
  to { transform: rotate(360deg); }
}

@keyframes asr-pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.4);
  }
  50% {
    transform: scale(1.05);
    box-shadow: 0 0 0 6px rgba(231, 76, 60, 0);
  }
}

/* fa-fade 动画覆盖 */
.fa-fade {
  animation: fa-fade 1.2s ease-in-out infinite;
}

@keyframes fa-fade {
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
}


</style>
