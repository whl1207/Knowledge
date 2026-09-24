<!-- src/components/workFlow/workFlow.vue -->
<!-- 主工作流编辑器 - 模块化重构版本（标签页布局） -->
<template>
  <div class="workflow-editor">
    <!-- ====== 顶部工具栏：标签按钮 + 工作流路径 + 文件操作 + 画布操作 + 统计 ====== -->
    <div class="top-bar">
      <div class="top-tabs">
        <button class="toolbar-btn tab-btn" :class="{ active: sidebarTab === 'files' && sidebarVisible }" @click="onTabClick('files')" :title="store.locales === 'en' ? 'Project' : '工程'">
          <i class="fa fa-stumbleupon"></i>
        </button>
        <button class="toolbar-btn tab-btn" :class="{ active: sidebarTab === 'nodes' && sidebarVisible }" @click="onTabClick('nodes')" :title="store.locales === 'en' ? 'Nodes' : '节点'">
          <i class="fa fa-cubes"></i>
        </button>
        <button class="toolbar-btn tab-btn" :class="{ active: sidebarTab === 'logs' && sidebarVisible }" @click="onTabClick('logs')" :title="store.locales === 'en' ? 'Run Logs' : '运行日志'">
          <i class="fa fa-list-alt"></i>
        </button>
        <button class="toolbar-btn tab-btn" :class="{ active: sidebarTab === 'test' }" @click="onTabClick('test')" :title="store.locales === 'en' ? 'Test' : '测试'">
          <i class="fa fa-flask"></i>
        </button>
      </div>

      <!-- 工程文件操作（原 sidebar-footer-actions） -->
      <div class="toolbar-actions">
        <button class="toolbar-btn" @click="addWorkflow" :title="store.locales === 'en' ? 'New Workflow' : '新建工作流'">
          <i class="fa fa-plus" style="color:#4CAF50"></i>
        </button>
        <button class="toolbar-btn" @click="openWorkflowFolder" :title="store.locales === 'en' ? 'Select Workflow Folder' : '选择工作流文件夹'">
          <i class="fa fa-folder-open"></i>
        </button>
        <button class="toolbar-btn" @click="openWorkflow" :title="store.locales === 'en' ? 'Open Workflow File' : '打开工作流文件'">
          <i class="fa fa-folder-open-o"></i>
        </button>
        <button class="toolbar-btn" @click="saveWorkflowHandler" :title="store.locales === 'en' ? 'Save Workflow' : '保存工作流'">
          <i class="fa fa-save"></i>
        </button>
      </div>

      <!-- 画布操作（原 canvas-stats 左侧按钮；未打开工作流时不显示） -->
      <div v-if="currentWorkflowFile" class="toolbar-actions">
        <button class="toolbar-btn" @click="runWorkflow" :disabled="!isWorkflowValid || runner?.isRunning" :title="store.locales === 'en' ? 'Run workflow' : '运行工作流'">
          <i class="fa fa-play" style="color:#4CAF50"></i>
        </button>
        <button v-if="hasResumableState" class="toolbar-btn" @click="continueWorkflow" :disabled="!isWorkflowValid || runner?.isRunning" :title="store.locales === 'en' ? 'Continue (skip completed)' : '继续执行（跳过已完成）'">
          <i class="fa fa-forward" style="color:#26A69A"></i>
        </button>
        <button class="toolbar-btn" @click="stopWorkflow" :disabled="!runner?.isRunning" :title="store.locales === 'en' ? 'Stop' : '停止运行'">
          <i class="fa fa-stop" style="color:#f44336"></i>
        </button>
        <button class="toolbar-btn" @click="resetNodeStatuses" :title="store.locales === 'en' ? 'Reset node status' : '重置节点状态'">
          <i class="fa fa-undo" style="color:#FF9800"></i>
        </button>
        <button class="toolbar-btn" @click="autoFitCanvas" :title="store.locales === 'en' ? 'Fit canvas' : '铺满画布'">
          <i class="fa fa-arrows-alt"></i>
        </button>
        <button class="toolbar-btn" @click="organizeLayout" :title="store.locales === 'en' ? 'Auto layout' : '自动布局'">
          <i class="fa fa-magic"></i>
        </button>
      </div>

      <!-- 画布统计（原 canvas-stats 右侧） -->
      <div class="canvas-stats">
        <span class="stat-item" :class="{ running: runner?.isRunning }">
          <i class="fa" :class="runner?.isRunning ? 'fa-spinner fa-spin' : 'fa-circle'"></i>
          {{ runner?.isRunning ? t('running') : t('idle') }}
        </span>
      </div>

      <!-- 当前工作流名称（工具栏最右侧） -->
      <div class="editor-header" :title="currentWorkflowFile || ''">
        <span class="editor-path">{{ workflowDisplayName }}</span>
        <span v-if="isDirty" class="dirty-mark">●</span>
      </div>
    </div>

    <!-- ====== 主内容区 ====== -->
    <div class="workflow-body">
      <!-- 左侧：工程/节点面板（互斥，点击对应图标可展开/关闭） -->
      <div v-if="sidebarVisible && sidebarTab !== 'test'" class="workflow-sidebar" :style="{ width: sidebarWidth + 'px' }">
        <!-- 拖拽调整侧栏宽度的手柄 -->
        <div class="sidebar-resizer" @mousedown.prevent="startSidebarResize" :title="store.locales === 'en' ? 'Drag to resize' : '拖动调整宽度'"></div>
        <!-- ===== 工程标签页：工作流文件列表 ===== -->
        <template v-if="sidebarTab === 'files' || sidebarTab === 'test'">
          <div class="sidebar-list scoll">
            <div v-if="loadingWorkflows" class="empty-hint">
              <i class="fa fa-spinner fa-spin" style="font-size:20px;"></i>
              <span>{{ store.locales === 'en' ? 'Loading...' : '加载中...' }}</span>
            </div>
            <div v-else-if="workflowFiles.length === 0" class="empty-hint">
              <i class="fa fa-cubes" style="font-size:24px;"></i>
              <span>{{ store.workflowPath ? (store.locales === 'en' ? 'No workflow files found' : '未找到工作流文件') : (store.locales === 'en' ? 'Please set a workflow folder first' : '请先设置工作流文件夹') }}</span>
            </div>
            <div
              v-for="wf in workflowFiles"
              :key="wf.name"
              class="file-item"
              :class="{ active: currentWorkflowFile === wf.path }"
              @click="loadWorkflowFile(wf)"
              @contextmenu.prevent="showFileMenu($event, wf)"
            >
              <div class="file-avatar"><i class="fa fa-stumbleupon"></i></div>
              <div class="file-info">
                <span class="file-name" :title="wf.name">{{ stripWorkflowExt(wf.name) }}</span>
                <span class="file-stats">
                  <span v-if="wf.size" class="stat stat-size" :title="store.locales === 'en' ? 'File size' : '文件大小'"><i class="fa fa-database"></i>{{ formatSize(wf.size) }}</span>
                  <span class="file-time">{{ formatTime(wf.mtime) }}</span>
                </span>
              </div>
              <button class="file-del-btn" @click.stop="deleteWorkflowFile(wf)" :title="store.locales === 'en' ? 'Delete' : '删除'">
                <i class="fa fa-trash"></i>
              </button>
            </div>
          </div>
        </template>

        <!-- 工程文件右键菜单（重命名/删除，样式参照 AgentSwarm 集群列表） -->
        <div v-if="fileMenu.visible" :style="fileMenu.style" class="context-menu file-menu" @click.stop @mouseleave="hideFileMenu">
          <div class="menu-item" @click="renameWorkflowFile(fileMenu.file); hideFileMenu()">
            <i class="fa fa-edit"></i> {{ store.locales === 'en' ? 'Rename' : '重命名' }}
          </div>
          <div class="menu-item" @click="deleteWorkflowFile(fileMenu.file); hideFileMenu()">
            <i class="fa fa-trash"></i> {{ store.locales === 'en' ? 'Delete' : '删除' }}
          </div>
        </div>

        <!-- ===== 节点标签页：可拖拽的节点面板 ===== -->
        <template v-if="sidebarTab === 'nodes'">
          <div class="sidebar-list scoll palette-list">
            <div
              v-for="nt in nodeTypes"
              :key="nt.type"
              class="palette-item"
              :style="{'--node-color': nt.color}"
              draggable="true"
              @dragstart="onPaletteDragStart($event, nt.type)"
            >
              <i class="fa" :class="nt.icon" :style="{color: nt.color}"></i>
              <div class="palette-info" :title="nt.desc">
                <span class="palette-label">{{ nt.label }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- ===== 日志标签页：运行日志列表（侧边栏内显示） ===== -->
        <template v-if="sidebarTab === 'logs'">
          <div class="sidebar-list scoll log-sidebar-list">
            <div v-if="logs.length === 0" class="empty-hint">
              <i class="fa fa-list-alt" style="font-size:20px;"></i>
              <span>{{ store.locales === 'en' ? 'No logs yet' : '暂无日志' }}</span>
            </div>
            <div v-for="(lg, i) in logs" :key="i" class="log-item" :class="lg.level">
              <span class="log-time">{{ lg.time }}</span>
              <span class="log-level"><i class="fa" :class="logLevelIcon(lg.level)"></i></span>
              <span class="log-message">{{ lg.message }}</span>
            </div>
          </div>
          <div class="sidebar-log-actions">
            <span class="log-count">{{ logs.length }} {{ store.locales === 'en' ? 'entries' : '条' }}</span>
            <button class="log-clear-btn" @click="exportLogs" :title="store.locales === 'en' ? 'Export logs' : '导出日志'">
              <i class="fa fa-download"></i>
            </button>
            <button class="log-clear-btn" @click="clearLogs" :title="store.locales === 'en' ? 'Clear logs' : '清空日志'">
              <i class="fa fa-trash"></i>
            </button>
          </div>
        </template>
      </div>

      <!-- 右侧：设计编辑器（工程/节点标签页时显示） -->
      <div v-if="sidebarTab !== 'test'" class="workflow-editor-area">
        <div v-if="currentWorkflowFile" class="editor-main">
          <WorkflowCanvas
            :t="t"
            :nodes="items"
            :links="links"
            :selectedNodeId="selectedNodeId"
            :hoveredNodeId="hoveredNodeId"
            :linking="operationMode === 'linking'"
            :linkSourceId="linkingSourceId"
            :linkSourcePort="linkingSourceConnector || linkingSourcePortId || linkingSourceStartPort"
            :linkSourceBranch="linkingSourceBranchId"
            :linkSourceStartPort="linkingSourceStartPort"
            :operationMode="operationMode"
            :transform="viewTransform"
            :mousePos="mousePosition"
            :scale="scale"
            @update:selectedNodeId="selectedNodeId = $event"
            @update:hoveredNodeId="hoveredNodeId = $event"
            @update:linking="operationMode = $event ? 'linking' : 'normal'"
            @update:linkSourceId="linkingSourceId = $event"
            @update:linkSourcePort="linkingSourceConnector = $event"
            @update:linkSourceBranch="linkingSourceBranchId = $event"
            @update:linkSourceStartPort="linkingSourceStartPort = $event"
            @update:operationMode="operationMode = $event"
            @update:mousePos="mousePosition = $event"
            @update:transform="viewTransform = $event"
            @update:scale="scale = $event"
            @connector-click="handleConnectorClick"
            @node-resize-start="startNodeResize"
            @branch-click="handleDecisionBranchConnectorClick"
            @file-port-click="handleFileNodeConnectorClick"
            @start-port-click="handleStartNodeConnectorClick"
            @delete-node="deleteNode"
            @delete-link="handleLinkDoubleClick"
            @canvas-click="handleCanvasClick"
            @context-menu="showContextMenu"
            @node-context-menu="showNodeContextMenu"
            @node-drag-start="startNodeDrag"
            @drop-node="onCanvasDropNode"
            @drop-files="onCanvasDropFiles"
          />
          <NodePropertiesPanel
            v-if="propertiesShow && selectedNode"
            :node="selectedNode"
            :t="t"
            :store="store"
            :links="links"
            :upstreamInfo="upstreamNodeInfo"
            :running="!!runner?.isRunning"
            @close="propertiesShow = false; selectedNodeId = null"
            @node-update="onNodePropertyUpdate"
            @add-branch="addDecisionBranch"
            @delete-branch="deleteDecisionBranch"
            @test-mcp="testMcpConnection"
            @connect-mcp="connectMcpNode"
            @disconnect-mcp="disconnectMcpNode"
            @refresh-mcp="refreshMcpTools"
            @validate-kb="validateKnowledgeBaseNode"
            @run-node="runSingleNode"
            @delete-node="() => { if (selectedNode) deleteNode(selectedNode.id) }"
            @save="saveWorkflowHandler"
          />
        </div>
        <div v-else class="editor-main" style="display:flex;align-items:center;justify-content:center;">
          <div class="empty-hint">
            <i class="fa fa-sitemap" style="font-size:48px;opacity:0.3;"></i>
            <span style="margin-top:12px;">{{ store.locales === 'en' ? 'Select or create a workflow to start' : '请选择或创建工作流' }}</span>
          </div>
        </div>
      </div>

      <!-- ====== 测试面板（悬浮居中，参照 set 设置面板：标题栏 + 左导航 + 右内容） ====== -->
      <div v-if="sidebarTab === 'test'" class="test-overlay" @click.self="closeTestPanel">
        <div class="test-content" @click.stop>
          <!-- 顶部标题栏（set 样式）：标题 + 测试配置 + 路径 + 关闭 -->
          <div class="settings-header">
            <span class="settings-header-title">
              <i class="fa fa-flask"></i> {{ store.locales === 'en' ? 'Test' : '测试' }}
            </span>

            <!-- 运行次数 -->
            <div class="test-config-row">
              <span class="test-config-label">{{ store.locales === 'en' ? 'Rounds' : '运行次数' }}</span>
              <select v-model="batchRunTimes" :disabled="isBatchRunning" class="test-stats-select">
                <option :value="1">1</option>
                <option :value="3">3</option>
                <option :value="5">5</option>
                <option :value="10">10</option>
                <option :value="20">20</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
                <option :value="200">200</option>
                <option :value="500">500</option>
                <option :value="1000">1000</option>
              </select>
            </div>

            <!-- 操作按钮（横向） -->
            <div class="test-config-btns">
              <button class="test-btn" @click="runWorkflowBatch" :disabled="!isWorkflowValid || runner?.isRunning || isBatchRunning" :title="t('batch_run')">
                <i class="fa" :class="isBatchRunning ? 'fa-spinner fa-spin' : 'fa-rocket'"></i>
                <span>{{ store.locales === 'en' ? 'Run' : '运行' }}</span>
              </button>
              <button class="test-btn" @click="saveBatchResultsToFolder" :disabled="batchResults.length === 0 || isBatchRunning" :title="t('save_batch_results')">
                <i class="fa fa-file-excel-o"></i>
                <span>{{ store.locales === 'en' ? 'Save' : '保存' }}</span>
              </button>
              <button class="test-btn" @click="clearBatchResults" :disabled="batchResults.length === 0 || isBatchRunning" :title="t('clear_batch_results')">
                <i class="fa fa-trash"></i>
                <span>{{ store.locales === 'en' ? 'Clear' : '清空' }}</span>
              </button>
            </div>

            <!-- 进度 -->
            <div v-if="isBatchRunning" class="test-progress-bar">
              <div class="progress-fill" :style="{ width: batchProgress + '%' }"></div>
              <span class="progress-text">{{ Math.round(batchProgress) }}% ({{ Math.round(batchProgress / 100 * batchRunTimes) }}/{{ batchRunTimes }})</span>
            </div>
            <div v-if="batchResults.length > 0" class="test-config-count">
              <i class="fa fa-flask"></i> {{ store.locales === 'en' ? `Results: ${batchResults.length}` : `结果: ${batchResults.length}` }}
            </div>

            <div class="settings-header-right">
              <span class="test-path" :title="currentWorkflowFile || ''">{{ currentWorkflowFile || (store.locales === 'en' ? 'No workflow open' : '未打开工作流') }}</span>
              <div class="settings-close" @click="closeTestPanel" :title="store.locales === 'en' ? 'Close (Esc)' : '关闭 (Esc)'">
                <i class="fa fa-times"></i>
              </div>
            </div>
          </div>

          <!-- 主体容器（set 样式：仅测试结果） -->
          <div class="settings-container">
          <!-- 测试结果 -->
          <div class="settings-content scoll">
            <div v-if="batchResults.length === 0 && !isBatchRunning" class="empty-hint" style="height:100%;">
              <i class="fa fa-flask" style="font-size:28px;"></i>
              <span>{{ t('batch_run') }} - {{ store.locales === 'en' ? 'Click Run to start testing' : '点击运行开始测试' }}</span>
            </div>
            <div v-for="(r, i) in batchResults" :key="i" class="batch-result-item" :class="{ success: r.success, error: !r.success }">
              <div class="batch-result-header">
                <span class="batch-result-index">#{{ i + 1 }}</span>
                <span class="batch-result-status">
                  <i :class="r.success ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
                  {{ r.success ? '成功' : '失败' }}
                </span>
                <span class="batch-result-time" v-if="r.time">{{ r.time }}</span>
              </div>
              <div class="batch-result-nodes" v-if="r.nodeResults && r.nodeResults.length > 0">
                <template
                  v-for="nr in sortByExecutionOrder(r.nodeResults, r.executionOrder)"
                  :key="`${r.round}-${nr.id}`"
                >
                  <span
                    class="node-status-tag"
                    :class="{ [nr.status]: true, expanded: expandedNodeResult === `${r.round}-${nr.id}` }"
                    :title="`${nr.name}: ${nr.status === 'success' ? '成功' : nr.status === 'error' ? '失败' : nr.status === 'running' ? '运行中' : '等待'} | 点击查看输出`"
                    @click="toggleNodeResult(r.round, nr)"
                  >
                    <i class="fa" :class="nr.status === 'success' ? 'fa-check-circle' : nr.status === 'error' ? 'fa-times-circle' : nr.status === 'running' ? 'fa-spinner fa-spin' : 'fa-circle-o'"></i>
                    {{ nr.name }}
                  </span>
                  <div v-if="expandedNodeResult === `${r.round}-${nr.id}`" class="expanded-node-output">
                    <!-- 表格展示（结果可解析为对象时） -->
                    <table class="result-table" v-if="expandedNodeParsed">
                      <tr v-for="(val, key) in expandedNodeParsed" :key="key">
                        <td class="result-key">{{ key }}</td>
                        <td class="result-val">
                          <template v-if="typeof val === 'object' && val !== null">
                            <pre class="scoll">{{ JSON.stringify(val, null, 2) }}</pre>
                          </template>
                          <template v-else>{{ val }}</template>
                        </td>
                      </tr>
                    </table>
                    <!-- 纯文本兜底 -->
                    <pre class="scoll" v-else>{{ expandedNodeOutput }}</pre>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 右键菜单 -->
  <teleport to="body">
    <div v-if="contextMenuVisible" class="context-menu-overlay" @click="hideContextMenu" @contextmenu.prevent="hideContextMenu"></div>
    <div v-if="contextMenuVisible" class="context-menu" :style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }">
      <!-- 节点上右键：复制 -->
      <template v-if="contextMenuOnNode">
        <div class="context-menu-item" @click="copyNode">
          <i class="fa fa-copy"></i> {{ store.locales === 'en' ? 'Copy' : '复制' }}
        </div>
        <div class="context-menu-divider"></div>
      </template>

      <!-- 空白处右键：粘贴（仅当有复制内容时） -->
      <template v-if="!contextMenuOnNode && copiedNode">
        <div class="context-menu-item" @click="pasteNode">
          <i class="fa fa-paste"></i> {{ store.locales === 'en' ? 'Paste' : '粘贴' }}
        </div>
        <div class="context-menu-divider"></div>
      </template>

      <!-- 添加节点（二级菜单） -->
      <div class="context-menu-item submenu-trigger">
        <i class="fa fa-plus-circle" style="color:#4CAF50"></i>
        <span>{{ store.locales === 'en' ? 'Add Node' : '添加节点' }}</span>
        <i class="fa fa-chevron-right submenu-arrow"></i>
        <div class="submenu">
          <div class="context-menu-item" @click="addNodeFromMenu('start')">
            <i class="fa fa-play-circle" style="color:#4CAF50"></i> {{ store.locales === 'en' ? 'Start' : '开始节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('end')">
            <i class="fa fa-flag-checkered" style="color:#f44336"></i> {{ store.locales === 'en' ? 'End' : '结束节点' }}
          </div>
          <div class="context-menu-divider"></div>
          <div class="context-menu-item" @click="addNodeFromMenu('text')">
            <i class="fa fa-tag" style="color:#FF5722"></i> {{ store.locales === 'en' ? 'Text' : '文本节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('local')">
            <i class="fa fa-file-text" style="color:#2196F3"></i> {{ store.locales === 'en' ? 'LocalFile' : '本地文件节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('web')">
            <i class="fa fa-search" style="color:#FF9800"></i> {{ store.locales === 'en' ? 'WebSearch' : '网络搜索节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('webpage')">
            <i class="fa fa-globe" style="color:#795548"></i> {{ store.locales === 'en' ? 'Webpage' : '网页节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('knowledge')">
            <i class="fa fa-database" style="color:#9C27B0"></i> {{ store.locales === 'en' ? 'KnowledgeBase' : '知识库节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('structured')">
            <i class="fa fa-table" style="color:#673AB7"></i> {{ store.locales === 'en' ? 'StructuredInput' : '结构化节点' }}
          </div>
          <div class="context-menu-divider"></div>
          <div class="context-menu-item" @click="addNodeFromMenu('reasoning')">
            <i class="fa fa-microchip" style="color:#4CAF50"></i> {{ store.locales === 'en' ? 'Reasoning' : '推理节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('decision')">
            <i class="fa fa-code-fork" style="color:#E91E63"></i> {{ store.locales === 'en' ? 'Decision' : '决策节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('python')">
            <i class="fa fa-code" style="color:#3776AB"></i> {{ store.locales === 'en' ? 'Python' : 'Python节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('mcp')">
            <i class="fa fa-plug" style="color:#00BCD4"></i> {{ store.locales === 'en' ? 'MCP' : 'MCP节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('subflow')">
            <i class="fa fa-sitemap" style="color:#FF6F00"></i> {{ store.locales === 'en' ? 'Subflow' : '子工作流节点' }}
          </div>
          <div class="context-menu-divider"></div>
          <div class="context-menu-item" @click="addNodeFromMenu('iteration')">
            <i class="fa fa-repeat" style="color:#00897B"></i> {{ store.locales === 'en' ? 'Iteration' : '迭代节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('aggregator')">
            <i class="fa fa-object-group" style="color:#5E35B1"></i> {{ store.locales === 'en' ? 'Aggregator' : '变量聚合节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('list')">
            <i class="fa fa-list" style="color:#00838F"></i> {{ store.locales === 'en' ? 'ListOperator' : '列表操作节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('data')">
            <i class="fa fa-file-excel-o" style="color:#546E7A"></i> {{ store.locales === 'en' ? 'DataCSV' : '数据(CSV)节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('agent')">
            <i class="fa fa-android" style="color:#512DA8"></i> {{ store.locales === 'en' ? 'Agent' : '智能体节点' }}
          </div>
          <div class="context-menu-item" @click="addNodeFromMenu('word')">
            <i class="fa fa-file-word-o" style="color:#2B579A"></i> {{ store.locales === 'en' ? 'Word Export' : 'Word 导出节点' }}
          </div>
        </div>
      </div>
    </div>

  </teleport>
</template>

<script setup lang="ts">
defineOptions({ name: 'Workflow' })
import { onMounted, onBeforeUnmount, onActivated, onDeactivated, ref, computed, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'
import { usestore } from '@/store'
import { WorkflowRunner, type WorkflowData } from '@/components/workFlow/engine/WorkflowRunner'
import { validateKnowledgeBase } from '@/shared/kbRetrieval'
import { getProviderConfig } from '@/shared/kbAiClient'
import { createT } from '@/components/workFlow/WorkflowLocales'
import { createNodeTemplates, createNodeDefaults, cloneFileTemplates, getWaitingText, defaultKbOptions, defaultDecisionBranches, defaultDecisionConfig, defaultMCPConfig, defaultStructuredConfig, defaultStructuredColumns, defaultFileTemplates } from '@/components/workFlow/WorkflowDefaults'
import { getNodeIconByType as getIconByType, getNodeColorByType as getColorByType } from '@/components/workFlow/WorkflowDefaults'
import { ensureMinNodeHeight } from '@/components/workFlow/WorkflowTypes'
import type { NodeData, Link, NodeType, Position, OperationMode, ConnectorPosition } from '@/components/workFlow/WorkflowTypes'
import { autoLayout } from '@/components/workFlow/engine/autoLayout'
import WorkflowCanvas from '@/components/workFlow/WorkflowCanvas.vue'
import NodePropertiesPanel from '@/components/workFlow/NodePropertiesPanel.vue'

const store = usestore()
const t = createT(store.locales || 'zh')

// ====== 响应式数据 ======
const items: import('vue').Ref<NodeData[]> = ref([])
const links: import('vue').Ref<Link[]> = ref([])
const selectedNodeId = ref<number | null>(null)
const hoveredNodeId = ref<number | null>(null)
const operationMode = ref<OperationMode>('normal')
const linkingSourceId = ref<number | null>(null)
const linkingSourceConnector = ref<ConnectorPosition | null>(null)
const linkingSourceBranchId = ref<string | null>(null)
const linkingSourcePortId = ref<string | null>(null)
const linkingSourceStartPort = ref<string | null>(null)
const propertiesShow = ref<boolean>(false)
const mousePosition = ref<Position>({ x: 0, y: 0 })
const scale = ref(1)
const viewTransform = ref({ x: 0, y: 0, k: 1 })

// 批量运行相关
const batchRunTimes = ref(10)
const isBatchRunning = ref(false)
const batchProgress = ref(0)
const batchResults = ref<any[]>([])

// 工作流运行器
const runner = ref<WorkflowRunner | null>(null)
const executionProgress = ref(0)

// 侧边栏标签页状态 ('files' | 'nodes' | 'test' | 'logs')
const sidebarTab = ref('files')
// 左侧工程/节点/日志面板是否显示（可展开/折叠）
const sidebarVisible = ref(true)

// 侧边栏宽度（可拖拽调整）
const sidebarWidth = ref(200)
let sidebarResizeStartX = 0
let sidebarResizeStartWidth = 0
const startSidebarResize = (e: MouseEvent): void => {
  sidebarResizeStartX = e.clientX
  sidebarResizeStartWidth = sidebarWidth.value
  document.addEventListener('mousemove', doSidebarResize)
  document.addEventListener('mouseup', stopSidebarResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}
const doSidebarResize = (e: MouseEvent): void => {
  const delta = e.clientX - sidebarResizeStartX
  const maxWidth = Math.max(150, Math.min(720, window.innerWidth - 240))
  sidebarWidth.value = Math.max(150, Math.min(maxWidth, sidebarResizeStartWidth + delta))
}
const stopSidebarResize = (): void => {
  document.removeEventListener('mousemove', doSidebarResize)
  document.removeEventListener('mouseup', stopSidebarResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  // 触发全局 resize，让画布等依赖容器尺寸的组件重新布局
  store.resize()
}

/** 关闭悬浮测试面板（回到工程标签并显示侧栏） */
const closeTestPanel = (): void => {
  sidebarTab.value = 'files'
  sidebarVisible.value = true
}

/** 点击标签按钮：工程/节点再次点击展开/折叠面板；测试切换悬浮层 */
const onTabClick = (tab: string): void => {
  if (tab === 'test') {
    if (sidebarTab.value === 'test') closeTestPanel()
    else sidebarTab.value = 'test'
    return
  }
  if (sidebarTab.value === tab) {
    // 再次点击同一标签 → 折叠/展开面板
    sidebarVisible.value = !sidebarVisible.value
  } else {
    sidebarTab.value = tab
    sidebarVisible.value = true
  }
}

// 节点面板列表
interface NodeTypeItem { type: NodeType; icon: string; color: string; label: string; desc: string }
const nodeTypes = computed<NodeTypeItem[]>(() => [
  { type: 'text',       icon: getIconByType('text'),       color: getColorByType('text'),       label: t('text_node'),       desc: '处理文本内容，支持模板变量' },
  { type: 'reasoning',  icon: getIconByType('reasoning'),  color: getColorByType('reasoning'),  label: t('reasoning_node'),  desc: '调用 AI 模型进行推理分析' },
  { type: 'decision',   icon: getIconByType('decision'),   color: getColorByType('decision'),   label: t('decision_node'),   desc: '根据条件分支执行不同路径' },
  { type: 'python',     icon: getIconByType('python'),     color: getColorByType('python'),     label: t('python_node'),     desc: '执行 Python 代码处理数据' },
  { type: 'web',        icon: getIconByType('web'),        color: getColorByType('web'),        label: t('web_node'),        desc: '搜索网络获取最新信息' },
  { type: 'webpage',    icon: getIconByType('webpage'),    color: getColorByType('webpage'),    label: t('webpage_node'),    desc: '获取并解析网页内容' },
  { type: 'local',      icon: getIconByType('local'),      color: getColorByType('local'),      label: t('local_node'),      desc: '读取本地文件内容' },
  { type: 'knowledge',  icon: getIconByType('knowledge'),  color: getColorByType('knowledge'),  label: t('knowledge_node'),  desc: '从知识库检索相关内容' },
  { type: 'structured', icon: getIconByType('structured'), color: getColorByType('structured'), label: t('structured_node'), desc: '以表格形式输入结构化数据' },
  { type: 'subflow',    icon: getIconByType('subflow'),    color: getColorByType('subflow'),    label: t('subflow_node'),    desc: '加载并执行外部子工作流' },
  { type: 'iteration',  icon: getIconByType('iteration'),  color: getColorByType('iteration'),  label: t('iteration_node'),  desc: '对数组逐项执行内部流水线并聚合结果' },
  { type: 'aggregator', icon: getIconByType('aggregator'), color: getColorByType('aggregator'), label: t('aggregator_node'), desc: '收集/合并多次执行的结果' },
  { type: 'list',       icon: getIconByType('list'),       color: getColorByType('list'),       label: t('list_node'),       desc: '对列表过滤/提取/排序/去重/切片' },
  { type: 'data',       icon: getIconByType('data'),       color: getColorByType('data'),       label: t('data_node'),       desc: '读取 CSV/TSV/JSON 并输出结构化数组' },
  { type: 'agent',      icon: getIconByType('agent'),      color: getColorByType('agent'),      label: t('agent_node'),      desc: '在工作流内调起现有智能体' },
  { type: 'word',       icon: getIconByType('word'),       color: getColorByType('word'),       label: t('word_node'),       desc: '把上游内容导出为 Word 文档（可选模板/位置）' },
  { type: 'mcp',        icon: getIconByType('mcp'),        color: getColorByType('mcp'),        label: t('mcp_node'),        desc: '通过 MCP 协议调用外部工具' },
])

const onPaletteDragStart = (event: DragEvent, type: NodeType): void => {
  event.dataTransfer?.setData('text/plain', type)
  event.dataTransfer!.effectAllowed = 'copy'
}

// 当前打开的工作流文件路径和脏状态
const currentWorkflowFile = ref<string | null>(null)
const isDirty = ref(false)
const isLoadingFile = ref(false) // 标记正在加载文件，避免误标记 dirty
const isNewWorkflow = ref(false) // 标记新建的工作流未保存

// 工作流管理
const workflowFiles = ref<any[]>([])
const loadingWorkflows = ref(false)

// 日志
const logs = ref<Array<{ time: string; message: string; level: string }>>([])
const MAX_LOGS = 2000 // 日志面板最多保留条数，防止大迭代刷爆内存
const pushLog = (message: string, level: 'info' | 'warning' | 'error' | 'success' = 'info'): void => {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  logs.value.push({
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`,
    message,
    level,
  })
  if (logs.value.length > MAX_LOGS) logs.value.splice(0, logs.value.length - MAX_LOGS)
}
const clearLogs = (): void => { logs.value = [] }

/** 导出运行日志为 .log 文本文件 */
const exportLogs = (): void => {
  if (logs.value.length === 0) {
    ElMessage.warning(store.locales === 'en' ? 'No logs to export' : '暂无日志可导出')
    return
  }
  const header = `# Workflow Run Logs\n# Exported: ${new Date().toLocaleString()}\n# Total: ${logs.value.length}\n\n`
  const body = logs.value.map(lg => `[${lg.time}] [${lg.level.toUpperCase()}] ${lg.message}`).join('\n')
  const blob = new Blob([header + body], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `workflow_logs_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`
  a.click()
  URL.revokeObjectURL(url)
}

// 运行日志已改为侧边栏标签页显示（sidebarTab === 'logs'），导出/清空见 exportLogs/clearLogs
const logLevelIcon = (level: string): string => {
  const icons: Record<string, string> = {
    'info': 'fa-info-circle', 'success': 'fa-check-circle',
    'warning': 'fa-exclamation-triangle', 'error': 'fa-times-circle',
  }
  return icons[level] || 'fa-circle'
}
/** 把节点结果转成适合日志展示的摘要文本（截断长度） */
const formatResultForLog = (result: string): string => {
  if (!result) return ''
  const trim = (s: string) => (s.length > 400 ? s.slice(0, 400) + '...' : s)
  try {
    const p = JSON.parse(result)
    if (p && typeof p === 'object') {
      if (p.type === 'iteration') {
        const s = typeof p.result === 'string' ? p.result : (p.result !== undefined ? JSON.stringify(p.result) : '')
        return trim(s) || '（迭代完成）'
      }
      if (p.type === 'data') {
        const rows = Array.isArray(p.rows) ? p.rows.length : 0
        const total = p.tooLarge ? '?' : (p.total ?? 0)
        return `共 ${total} 行，${Array.isArray(p.headers) ? p.headers.length : 0} 列（预览 ${rows} 行）`
      }
      const val = p.result !== undefined ? p.result : (p.output !== undefined ? p.output : null)
      if (val !== null && val !== undefined) return trim(typeof val === 'string' ? val : JSON.stringify(val))
    }
  } catch { /* 非 JSON 原样展示 */ }
  return trim(result)
}

// 保存状态提示（ElMessage toast）
const showSaveStatus = (message: string, type: 'success' | 'error') => {
  if (type === 'success') ElMessage.success(message)
  else ElMessage.error(message)
}

// 测试页节点结果展开
const expandedNodeResult = ref<string | null>(null)
const expandedNodeOutput = ref('')
const expandedNodeParsed = ref<Record<string, any> | null>(null)

const toggleNodeResult = (round: number, nr: any): void => {
  const key = `${round}-${nr.id}`
  if (expandedNodeResult.value === key) {
    expandedNodeResult.value = null
    expandedNodeOutput.value = ''
    expandedNodeParsed.value = null
  } else {
    expandedNodeResult.value = key
    expandedNodeOutput.value = nr.result || '(无输出)'
    try {
      const parsed = typeof nr.result === 'string' ? JSON.parse(nr.result) : nr.result
      if (typeof parsed === 'object' && parsed !== null) {
        expandedNodeParsed.value = parsed
      } else {
        expandedNodeOutput.value = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
        expandedNodeParsed.value = null
      }
    } catch {
      expandedNodeParsed.value = null
    }
  }
}

/** 按执行顺序排列节点 */
const sortByExecutionOrder = (nodes: any[], order?: number[]): any[] => {
  if (!order || order.length === 0) return nodes
  const sorted = [...nodes]
  sorted.sort((a, b) => {
    const ia = order.indexOf(a.id)
    const ib = order.indexOf(b.id)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })
  return sorted
}

// 监视 items/links 变化自动标记 dirty（排除文件加载中的赋值）
watch([items, links], () => {
  if (currentWorkflowFile.value && !isLoadingFile.value) isDirty.value = true
}, { deep: true })

// 字节 → 可读大小（参照 AgentSwarm）
const formatSize = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 格式化文件修改时间
const formatTime = (mtime?: number): string => {
  if (!mtime) return ''
  const d = new Date(mtime)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 右键菜单状态
const contextMenuVisible = ref(false)
const contextMenuPos = ref({ x: 0, y: 0 })
const contextMenuOnNode = ref(false) // 右键是否在节点上
const contextMenuOnNodeId = ref<number | null>(null) // 右键节点的 id

// 工程文件右键菜单状态
const fileMenu = ref<{ visible: boolean; style: Record<string, string>; file: any }>({ visible: false, style: {}, file: null })

// 复制/粘贴
const copiedNode = ref<Partial<NodeData> | null>(null)

// 切换到工程标签时自动刷新工作流文件
watch(sidebarTab, (tab) => {
  if (tab === 'files') {
    refreshWorkflowFiles()
  }
})

// 显示右键菜单（自动调整位置避免溢出屏幕）
const showContextMenu = (event: MouseEvent): void => {
  contextMenuOnNode.value = false
  contextMenuOnNodeId.value = null
  contextMenuPos.value = { x: event.clientX, y: event.clientY }
  contextMenuVisible.value = true
  // 渲染后根据实际尺寸校正位置
  requestAnimationFrame(() => {
    const menu = document.querySelector('.context-menu') as HTMLElement
    if (!menu) return
    const mr = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let fx = event.clientX
    let fy = event.clientY
    if (fy + mr.height > vh - 5) fy = vh - mr.height - 5
    if (fx + mr.width > vw - 5) fx = vw - mr.width - 5
    contextMenuPos.value = { x: Math.max(5, fx), y: Math.max(5, fy) }
    // 检测子菜单是否超出屏幕底部，若是则向上展开
    adjustSubmenuPosition(menu, fy, vh)
  })
}

// 显示节点右键菜单
const showNodeContextMenu = (nodeId: number, event: MouseEvent): void => {
  contextMenuOnNode.value = true
  contextMenuOnNodeId.value = nodeId
  contextMenuPos.value = { x: event.clientX, y: event.clientY }
  contextMenuVisible.value = true
  requestAnimationFrame(() => {
    const menu = document.querySelector('.context-menu') as HTMLElement
    if (!menu) return
    const mr = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let fx = event.clientX
    let fy = event.clientY
    if (fy + mr.height > vh - 5) fy = vh - mr.height - 5
    if (fx + mr.width > vw - 5) fx = vw - mr.width - 5
    contextMenuPos.value = { x: Math.max(5, fx), y: Math.max(5, fy) }
    // 检测子菜单是否超出屏幕底部，若是则向上展开
    adjustSubmenuPosition(menu, fy, vh)
  })
}

// 检测并调整子菜单展开方向
const adjustSubmenuPosition = (menu: HTMLElement, menuTop: number, vh: number): void => {
  const submenu = menu.querySelector('.submenu') as HTMLElement
  if (!submenu) return
  menu.classList.remove('submenu-upward')
  // 临时显示子菜单获取实际高度（visibility:hidden 避免闪烁）
  const origDisplay = submenu.style.display
  submenu.style.display = 'block'
  submenu.style.visibility = 'hidden'
  const subH = submenu.getBoundingClientRect().height
  submenu.style.display = origDisplay
  submenu.style.visibility = ''
  // 子菜单底部超出视口 → 向上展开
  if (menuTop + subH > vh - 5) {
    menu.classList.add('submenu-upward')
  }
}

// 隐藏右键菜单
const hideContextMenu = (): void => {
  contextMenuVisible.value = false
  contextMenuOnNode.value = false
  contextMenuOnNodeId.value = null
}

// 从右键菜单添加节点
const addNodeFromMenu = (type: NodeType): void => {
  hideContextMenu()
  // 创建一个模拟的 MouseEvent 传递给 addNode，用于计算画布位置
  const mockEvent = new MouseEvent('click', {
    clientX: contextMenuPos.value.x,
    clientY: contextMenuPos.value.y
  })
  addNode(type, mockEvent)
}

// 节点模板
const nodeTemplates = createNodeTemplates(t)

// ====== 计算属性 ======
const selectedNode = computed((): NodeData | null => {
  return items.value.find(item => item.id === selectedNodeId.value) || null
})

/** 去掉工作流文件后缀（.flow/.json/.workflow） */
const stripWorkflowExt = (name: string): string => name.replace(/\.[^/.]+$/, '')

/** 工作流显示名：仅文件名（去掉路径和后缀）；未打开时显示提示 */
const workflowDisplayName = computed((): string => {
  if (!currentWorkflowFile.value) return store.locales === 'en' ? 'No workflow open' : '未打开工作流'
  const name = currentWorkflowFile.value.split(/[\\/]/).pop() || ''
  return stripWorkflowExt(name)
})

const isWorkflowValid = computed(() => {
  const startNode = items.value.find(item => item.type === 'start')
  const endNode = items.value.find(item => item.type === 'end')
  const startCount = items.value.filter(item => item.type === 'start').length
  const endCount = items.value.filter(item => item.type === 'end').length
  return startCount === 1 && endCount === 1 && !!startNode && !!endNode
})

/** 是否存在可继续执行的部分成功状态（有成功节点或迭代断点，但工作流尚未完整跑完） */
const hasResumableState = computed((): boolean => {
  if (items.value.length === 0) return false
  const endNode = items.value.find(n => n.type === 'end')
  if (endNode && endNode.status === 'success') return false
  return items.value.some(n => n.status === 'success') || items.value.some(n => !!n._iterResume)
})

const upstreamNodeInfo = computed(() => {
  if (!selectedNode.value) return []
  return links.value
    .filter(link => link.target === selectedNode.value!.id)
    .map(link => {
      const sourceNode = items.value.find(n => n.id === link.source)
      return {
        node: sourceNode,
        exists: !!sourceNode,
        id: link.source,
        key: sourceNode ? `node_${sourceNode.id}` : `node_${link.source}`,
        name: sourceNode ? sourceNode.name : t('unknown_node'),
        type: sourceNode ? sourceNode.type : t('unknown_node'),
        icon: getNodeIconByType(sourceNode),
        iconColor: getNodeColor(sourceNode?.type || '')
      }
    })
})

const getNodeIconByType = (node: NodeData | undefined | null): string => {
  if (!node) return 'fa-circle'
  const modelIcons: Record<string, string> = {
    'ollama': 'fa-microchip', 'openai': 'fa-bolt', 'deepseek': 'fa-rocket',
    'anthropic': 'fa-robot', 'google': 'fa-google', 'azure': 'fa-cloud', 'custom': 'fa-cogs'
  }
  if (node.type === 'reasoning') return modelIcons[node.model_type] || 'fa-microchip'
  if (node.type === 'local') {
    const ext = (node.model || '').toLowerCase()
    const fileIcons: Record<string, string> = {
      '.txt': 'fa-file-text-o', '.md': 'fa-file-text-o', '.pdf': 'fa-file-pdf-o',
      '.docx': 'fa-file-word-o', '.xlsx': 'fa-file-excel-o', '.json': 'fa-file-code-o',
      '.csv': 'fa-file-excel-o', '.html': 'fa-file-code-o', '.py': 'fa-file-code-o'
    }
    return fileIcons[ext] || 'fa-file'
  }
  const icons: Record<string, string> = {
    'start': 'fa-play-circle', 'end': 'fa-flag-checkered', 'text': 'fa-tag',
    'local': 'fa-file-text', 'web': 'fa-search', 'webpage': 'fa-globe',
    'reasoning': 'fa-microchip', 'decision': 'fa-code-fork', 'python': 'fa-code',
    'knowledge': 'fa-database', 'structured': 'fa-table', 'mcp': 'fa-plug',
    'subflow': 'fa-sitemap', 'iteration': 'fa-repeat', 'aggregator': 'fa-object-group',
    'list': 'fa-list', 'data': 'fa-file-excel-o', 'agent': 'fa-android', 'word': 'fa-file-word-o'
  }
  return icons[node.type] || 'fa-circle'
}

const getNodeColor = (type: string): string => {
  const colors: Record<string, string> = {
    'start': '#4CAF50', 'end': '#f44336', 'text': '#FF5722',
    'local': '#2196F3', 'web': '#FF9800', 'webpage': '#795548',
    'reasoning': '#4CAF50', 'decision': '#E91E63', 'python': '#3776AB',
    'knowledge': '#9C27B0', 'structured': '#673AB7', 'mcp': '#00BCD4',
    'subflow': '#FF6F00', 'iteration': '#00897B', 'aggregator': '#5E35B1',
    'list': '#00838F', 'data': '#546E7A', 'agent': '#512DA8', 'word': '#2B579A'
  }
  return colors[type] || '#757575'
}

// ====== Ctrl+S 快捷保存 ======
const onKeydownSave = (e: KeyboardEvent): void => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    const en = store.locales === 'en'
    if (currentWorkflowFile.value) {
      saveWorkflowToFile().then(() => {
        // saveWorkflowToFile 成功时会把 isDirty 置 false，据此判断结果
        if (!isDirty.value) ElMessage.success(en ? 'Workflow saved' : '工作流已保存')
        else ElMessage.error(en ? 'Save failed' : '保存失败')
      })
    } else {
      saveWorkflow()
      saveToLocalStorage()
      ElMessage.success(en ? 'Workflow downloaded' : '工作流已下载')
    }
  }
}

/** 事件目标是否为可编辑控件（输入框内按 Del 应执行文本删除，而非删除节点） */
const isEditableTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return !!el.isContentEditable
}

/**
 * Delete / Backspace 删除画布上当前选中的节点（连同其连线）。
 * 不触发的情况：焦点在输入控件、正在运行/批量运行、测试悬浮面板或右键菜单打开。
 */
const onKeydownDelete = (e: KeyboardEvent): void => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
  if (isEditableTarget(e.target)) return
  if (contextMenuVisible.value) return
  if (document.querySelector('.test-overlay')) return
  if (runner.value?.isRunning || isBatchRunning.value) return
  const id = selectedNodeId.value
  if (id === null || id === undefined) return
  const node = items.value.find(n => n.id === id)
  if (!node) return
  e.preventDefault()
  deleteNode(id)
  ElMessage.success(store.locales === 'en' ? `Node deleted: ${node.name}` : `已删除节点：${node.name}`)
}

// ====== 生命周期 ======
onMounted(async () => {
  loadFromLocalStorage()
  store.getAIconfig()
  refreshWorkflowFiles()
  window.addEventListener('keydown', onKeydownSave)
  window.addEventListener('keydown', onKeydownDelete)
  document.addEventListener('click', closeFileMenu)
})

// KeepAlive 缓存：切回本面板时重新绑定事件监听（后台运行的工作流继续，状态已保留）
onActivated(() => {
  window.addEventListener('keydown', onKeydownSave)
  window.addEventListener('keydown', onKeydownDelete)
  document.addEventListener('click', closeFileMenu)
})

// KeepAlive 缓存：切走本面板时移除事件监听（避免后台误触）并保存状态；运行中的工作流继续后台执行
onDeactivated(() => {
  window.removeEventListener('keydown', onKeydownSave)
  window.removeEventListener('keydown', onKeydownDelete)
  document.removeEventListener('click', closeFileMenu)
  saveToLocalStorage()
  saveViewState()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydownSave)
  window.removeEventListener('keydown', onKeydownDelete)
  document.removeEventListener('click', closeFileMenu)
  saveToLocalStorage()
  saveViewState()
})

// ====== 节点操作 ======
const addNode = (type: NodeType, event?: MouseEvent | DragEvent): void => {
  if (type === 'start' && items.value.some(item => item.type === 'start')) { ElMessage.warning(t('multiple_start_nodes')); return }
  if (type === 'end' && items.value.some(item => item.type === 'end')) { ElMessage.warning(t('multiple_end_nodes')); return }

  // 从事件中计算画布坐标系下的位置
  let x = 200, y = 200
  if (event) {
    const canvasEl = (event.target as HTMLElement)?.closest?.('.canvas-container') || document.querySelector('.canvas-container') as HTMLElement
    if (canvasEl) {
      const rect = canvasEl.getBoundingClientRect()
      x = (event.clientX - rect.left - viewTransform.value.x) / viewTransform.value.k
      y = (event.clientY - rect.top - viewTransform.value.y) / viewTransform.value.k
    }
  }
  // 确保坐标有效
  x = isNaN(x) ? 200 : x; y = isNaN(y) ? 200 : y
  x -= (nodeTemplates[type]?.width || 250) / 2
  y -= (nodeTemplates[type]?.height || 70) / 2
  if (isNaN(x) || isNaN(y)) { x = 200; y = 200 }
  const template = nodeTemplates[type]
  const newNode: NodeData = {
    ...template,
    id: items.value.length > 0 ? Math.max(...items.value.map(n => n.id)) + 1 : 0,
    x, y
  }
  createNodeDefaults(newNode, store, t)
  items.value.push(newNode)
  if (runner.value) runner.value.setWorkflowData({ items: items.value, links: links.value })
  saveToLocalStorage()
}

const deleteNode = (id: number): void => {
  links.value = links.value.filter(link => link.source !== id && link.target !== id)
  const idx = items.value.findIndex(item => item.id === id)
  if (idx > -1) items.value.splice(idx, 1)
  if (selectedNodeId.value === id) { selectedNodeId.value = null; propertiesShow.value = false }
  if (runner.value) runner.value.setWorkflowData({ items: items.value, links: links.value })
  saveToLocalStorage()
}

// 复制节点
const copyNode = (): void => {
  if (contextMenuOnNodeId.value === null) return
  const node = items.value.find(n => n.id === contextMenuOnNodeId.value)
  if (!node) return
  // 深拷贝节点数据，排除 id 和运行时状态
  const { id, status, result, ...rest } = node
  copiedNode.value = { ...rest }
  hideContextMenu()
}

// 粘贴节点
const pasteNode = (): void => {
  if (!copiedNode.value) return
  const data = copiedNode.value
  // 计算粘贴位置（在右键点击处偏移避免重叠）
  const canvasEl = document.querySelector('.canvas-container') as HTMLElement
  let px = 200, py = 200
  if (canvasEl) {
    const rect = canvasEl.getBoundingClientRect()
    px = (contextMenuPos.value.x - rect.left - viewTransform.value.x) / viewTransform.value.k
    py = (contextMenuPos.value.y - rect.top - viewTransform.value.y) / viewTransform.value.k
  }
  px = isNaN(px) ? 200 : px
  py = isNaN(py) ? 200 : py
  const newId = items.value.length > 0 ? Math.max(...items.value.map(n => n.id)) + 1 : 0
  const newNode: NodeData = {
    ...data as any,
    id: newId,
    x: px - ((data.width || 250) / 2),
    y: py - ((data.height || 70) / 2),
    status: 'idle',
    result: ''
  } as NodeData
  createNodeDefaults(newNode, store, t)
  items.value.push(newNode)
  if (runner.value) runner.value.setWorkflowData({ items: items.value, links: links.value })
  saveToLocalStorage()
  hideContextMenu()
}

const onNodePropertyUpdate = (_node: NodeData): void => {
  // 本地文件节点切换模式时隐藏/恢复模板端口连线
  if (_node.type === 'local') {
    if (_node.fileMode === 'full' && _node.hiddenLinks === undefined) {
      // 从模板模式切换到完整文件模式：保存模板端口连线到节点，从画布移除
      const templateLinks = links.value.filter(l =>
        l.source === _node.id && l.sourcePort && l.sourcePort.startsWith('port_')
      )
      if (templateLinks.length > 0) {
        _node.hiddenLinks = templateLinks
        links.value = links.value.filter(l =>
          !(l.source === _node.id && l.sourcePort && l.sourcePort.startsWith('port_'))
        )
      } else {
        _node.hiddenLinks = []
      }
    } else if (_node.fileMode === 'template' && _node.hiddenLinks && _node.hiddenLinks.length > 0) {
      // 从完整文件模式切换回模板模式：恢复之前隐藏的连线
      links.value = [...links.value, ..._node.hiddenLinks]
      _node.hiddenLinks = []
    }
  }
  saveToLocalStorage()
}

const getCanvasMousePosition = (event: MouseEvent): Position => {
  const canvasEl = (event.target as HTMLElement).closest('.canvas-container') as HTMLElement | null
  if (!canvasEl) return { x: 0, y: 0 }
  const rect = canvasEl.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left - viewTransform.value.x) / viewTransform.value.k,
    y: (event.clientY - rect.top - viewTransform.value.y) / viewTransform.value.k
  }
}

// ====== 连接操作 ======
const handleConnectorClick = (nodeId: number, handleId: ConnectorPosition, event: MouseEvent): void => {
  event.stopPropagation()
  mousePosition.value = getCanvasMousePosition(event)

  // 判断是否为输入端口（左侧）或输出端口（右侧/底部）
  const isInput = handleId === 'input' || handleId === 'top'

  if (isInput) {
    // 点击输入端口：如果正在连线则完成连接
    if (operationMode.value === 'linking' && linkingSourceId.value !== null) {
      completeConnection(nodeId, handleId)
    }
    return
  }

  // 点击输出端口：开始/继续连线
  if (operationMode.value === 'linking') {
    if (linkingSourceId.value === null) {
      linkingSourceId.value = nodeId; linkingSourceConnector.value = handleId
      linkingSourceBranchId.value = null; linkingSourcePortId.value = null; linkingSourceStartPort.value = null
    } else if (linkingSourceId.value !== nodeId) { completeConnection(nodeId, handleId)
    } else { resetConnectionState() }
  } else {
    operationMode.value = 'linking'; linkingSourceId.value = nodeId; linkingSourceConnector.value = handleId
    linkingSourceBranchId.value = null; linkingSourcePortId.value = null; linkingSourceStartPort.value = null
  }
}

const handleDecisionBranchConnectorClick = (nodeId: number, branchId: string, event: MouseEvent): void => {
  event.stopPropagation()
  mousePosition.value = getCanvasMousePosition(event)
  if (operationMode.value === 'linking') {
    if (linkingSourceId.value === null) {
      linkingSourceId.value = nodeId; linkingSourceBranchId.value = branchId
      linkingSourceConnector.value = null; linkingSourcePortId.value = null; linkingSourceStartPort.value = null
    } else if (linkingSourceId.value !== nodeId) { ElMessage.warning('决策节点分支只能作为连接的起点，不能作为终点。'); resetConnectionState()
    } else { linkingSourceBranchId.value = branchId; linkingSourcePortId.value = null; linkingSourceStartPort.value = null }
  } else {
    operationMode.value = 'linking'; linkingSourceId.value = nodeId; linkingSourceBranchId.value = branchId
    linkingSourceConnector.value = null; linkingSourcePortId.value = null; linkingSourceStartPort.value = null
  }
}

const handleFileNodeConnectorClick = (nodeId: number, portId: string, event: MouseEvent): void => {
  event.stopPropagation()
  mousePosition.value = getCanvasMousePosition(event)
  if (operationMode.value === 'linking') {
    if (linkingSourceId.value === null) {
      linkingSourceId.value = nodeId; linkingSourcePortId.value = portId
      linkingSourceConnector.value = null; linkingSourceBranchId.value = null; linkingSourceStartPort.value = null
    } else if (linkingSourceId.value !== nodeId) { completeConnection(nodeId, 'top')
    } else { linkingSourcePortId.value = portId }
  } else {
    operationMode.value = 'linking'; linkingSourceId.value = nodeId; linkingSourcePortId.value = portId
    linkingSourceConnector.value = null; linkingSourceBranchId.value = null; linkingSourceStartPort.value = null
  }
}

const handleStartNodeConnectorClick = (nodeId: number, portType: 'prompt' | 'file', event: MouseEvent): void => {
  event.stopPropagation()
  mousePosition.value = getCanvasMousePosition(event)
  if (operationMode.value === 'linking') {
    if (linkingSourceId.value === null) {
      linkingSourceId.value = nodeId; linkingSourceStartPort.value = portType
      linkingSourceConnector.value = null; linkingSourceBranchId.value = null; linkingSourcePortId.value = null
    } else if (linkingSourceId.value !== nodeId) { ElMessage.warning('开始节点只能作为连接的起点，不能作为终点。'); resetConnectionState()
    } else { linkingSourceStartPort.value = portType }
  } else {
    operationMode.value = 'linking'; linkingSourceId.value = nodeId; linkingSourceStartPort.value = portType
    linkingSourceConnector.value = null; linkingSourceBranchId.value = null; linkingSourcePortId.value = null
  }
}

const completeConnection = (targetNodeId: number, targetHandleId: ConnectorPosition): void => {
  if (linkingSourceId.value === null) return
  const sourceNode = items.value.find(n => n.id === linkingSourceId.value)
  const targetNode = items.value.find(n => n.id === targetNodeId)
  if (!sourceNode || !targetNode) { resetConnectionState(); return }
  const linkData: any = {
    source: linkingSourceId.value!,
    target: targetNodeId,
    sourcePort: linkingSourceConnector.value || linkingSourcePortId.value || linkingSourceStartPort.value || undefined,
    targetPort: targetHandleId === 'top' ? 'input' : targetHandleId
  }
  if (sourceNode.type === 'decision' && linkingSourceBranchId.value !== null) {
    linkData.branch = linkingSourceBranchId.value
    linkData.sourcePort = `branch_${linkingSourceBranchId.value}`
  }
  const exists = links.value.some(l =>
    l.source === linkData.source && l.target === linkData.target &&
    (l.branch || null) === (linkData.branch || null) &&
    (l.sourcePort || null) === (linkData.sourcePort || null)
  )
  if (!exists) { links.value.push(linkData); saveToLocalStorage() }
  resetConnectionState()
}

const resetConnectionState = (): void => {
  linkingSourceId.value = null; linkingSourceConnector.value = null
  linkingSourceBranchId.value = null; linkingSourcePortId.value = null; linkingSourceStartPort.value = null
  operationMode.value = 'normal'; mousePosition.value = { x: 0, y: 0 }
}

const handleLinkDoubleClick = (link: Link): void => {
  const idx = links.value.findIndex(l =>
    l.source === link.source && l.target === link.target &&
    l.branch === link.branch && l.sourcePort === link.sourcePort
  )
  if (idx !== -1) { links.value.splice(idx, 1); saveToLocalStorage() }
}

// ====== 画布事件 ======
const handleCanvasClick = (): void => {
  selectedNodeId.value = null; propertiesShow.value = false
  operationMode.value = 'normal'; resetConnectionState()
}

const handleCanvasContextMenu = (event: MouseEvent): void => {
  if (operationMode.value === 'linking') { event.preventDefault(); resetConnectionState() }
}

const startNodeDrag = (nodeId: number, event: MouseEvent): void => {
  if (operationMode.value === 'linking') { event.stopPropagation(); return }
  const node = items.value.find(item => item.id === nodeId)
  if (!node) return
  const sx = event.clientX, sy = event.clientY
  const snx = node.x, sny = node.y
  let dragging = false
  selectedNodeId.value = nodeId; propertiesShow.value = true
  const onMove = (e: MouseEvent) => {
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (!dragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) dragging = true
    if (dragging) { node.x = snx + dx / viewTransform.value.k; node.y = sny + dy / viewTransform.value.k }
  }
  const onEnd = () => {
    if (dragging) saveToLocalStorage()
    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onEnd)
  }
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onEnd)
}

const startNodeResize = (nodeId: number, event: MouseEvent): void => {
  if (operationMode.value === 'linking') { event.stopPropagation(); return }
  const node = items.value.find(item => item.id === nodeId)
  if (!node) return
  const sx = event.clientX, sy = event.clientY
  const sw = node.width, sh = node.height
  let resizing = false
  const onMove = (e: MouseEvent) => {
    const dx = (e.clientX - sx) / viewTransform.value.k
    const dy = (e.clientY - sy) / viewTransform.value.k
    if (!resizing && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) resizing = true
    if (resizing) {
      node.width = Math.max(120, sw + dx)
      node.height = Math.max(60, sh + dy)
    }
  }
  const onEnd = () => {
    if (resizing) saveToLocalStorage()
    window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onEnd)
  }
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onEnd)
}

const onCanvasDropNode = (type: string, event: DragEvent): void => { addNode(type as NodeType, event) }

const onCanvasDropFiles = async (event: DragEvent): Promise<void> => {
  const files = event.dataTransfer?.files
  if (!files || files.length === 0) return
  const file = files[0]
  const canvasEl = (event.target as HTMLElement).closest('.canvas-container')
  let dropX = 200, dropY = 200
  if (canvasEl) {
    const rect = canvasEl.getBoundingClientRect()
    dropX = (event.clientX - rect.left - viewTransform.value.x) / viewTransform.value.k
    dropY = (event.clientY - rect.top - viewTransform.value.y) / viewTransform.value.k
  }
  const isKb = file.name.toLowerCase().endsWith('.kb') || (file.name.toLowerCase().endsWith('.json') && file.name.toLowerCase().includes('knowledge'))
  const x = dropX - (nodeTemplates.local?.width || 250) / 2
  const y = dropY - (nodeTemplates.local?.height || 70) / 2
  try {
    const content = await window.ipcRenderer.invoke('readFile', file.path)
    const newId = items.value.length > 0 ? Math.max(...items.value.map(n => n.id)) + 1 : 0
    if (isKb) {
      const nn: NodeData = { ...nodeTemplates.knowledge, id: newId, name: file.name.replace(/\.[^/.]+$/, ''), kbPath: file.path, kbQuery: t('input_search') + '...', kbOptions: { ...defaultKbOptions }, result: JSON.stringify({ result: t('waiting_retrieval'), type: 'knowledge_retrieval', success: false }), x, y, status: 'idle' }
      createNodeDefaults(nn, store, t); items.value.push(nn); await validateKnowledgeBaseNode(nn.id)
    } else {
      // .flow 文件 → 创建子工作流节点
      if (file.name.toLowerCase().endsWith('.flow')) {
        try {
          const content = await window.ipcRenderer.invoke('readFile', file.path)
          const newId = items.value.length > 0 ? Math.max(...items.value.map(n => n.id)) + 1 : 0
          const nn: NodeData = {
            ...nodeTemplates.subflow,
            id: newId, name: file.name.replace(/\.[^/.]+$/, ''),
            subflowPath: file.path, subflowName: file.name.replace(/\.[^/.]+$/, ''),
            prompt: file.path,
            result: JSON.stringify({ result: t('waiting'), subflow: file.name, type: 'subflow', success: false }),
            x, y, status: 'idle'
          }
          createNodeDefaults(nn, store, t)
          items.value.push(nn)
        } catch (e: any) {
          console.error('加载子工作流失败:', e)
        }
        if (runner.value) runner.value.setWorkflowData({ items: items.value, links: links.value })
        saveToLocalStorage()
        return
      }

      const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '')
      const nn: NodeData = { ...nodeTemplates.local, id: newId, name: file.name, model: ext, prompt: file.path, result: JSON.stringify({ result: content, filePath: file.path, filename: file.name, extension: ext, success: true, type: 'file' }), x, y, status: 'success', fileMode: 'full', fileTemplates: cloneFileTemplates(defaultFileTemplates) }
      items.value.push(nn)
    }
    if (runner.value) runner.value.setWorkflowData({ items: items.value, links: links.value })
    saveToLocalStorage()
  } catch (error: any) {
    const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '')
    const nn: NodeData = { ...nodeTemplates.local, id: items.value.length > 0 ? Math.max(...items.value.map(n => n.id)) + 1 : 0, name: file.name + ' (' + t('read_error') + ')', model: ext, prompt: file.path, result: `${t('file_read_error')}: ${error}`, x, y, status: 'error', fileMode: 'full', fileTemplates: cloneFileTemplates(defaultFileTemplates) }
    items.value.push(nn)
    if (runner.value) runner.value.setWorkflowData({ items: items.value, links: links.value })
    saveToLocalStorage()
  }
}

// ====== 缩放控制 ======
const zoomIn = () => { scale.value = Math.min(scale.value * 1.2, 5); viewTransform.value = { ...viewTransform.value, k: scale.value } }
const zoomOut = () => { scale.value = Math.max(scale.value * 0.8, 0.1); viewTransform.value = { ...viewTransform.value, k: scale.value } }
const resetZoom = () => { scale.value = 1; viewTransform.value = { x: 0, y: 0, k: 1 } }

/** 自动缩放平移画布，使所有节点居中且铺满 */
const autoFitCanvas = (): void => {
  if (items.value.length === 0) return resetZoom()
  const padding = 60
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  items.value.forEach(n => {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + (n.width || 250))
    maxY = Math.max(maxY, n.y + (n.height || 70))
  })
  const contentW = maxX - minX + padding * 2
  const contentH = maxY - minY + padding * 2
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  // 获取画布容器尺寸
  const canvasEl = document.querySelector('.canvas-container') as HTMLElement
  if (!canvasEl) return
  const rect = canvasEl.getBoundingClientRect()
  const scaleX = rect.width / contentW
  const scaleY = rect.height / contentH
  const k = Math.min(scaleX, scaleY, 2) // 最大放大至 2 倍
  scale.value = k
  viewTransform.value = {
    x: rect.width / 2 - centerX * k,
    y: rect.height / 2 - centerY * k,
    k
  }
}

/** 自动整理布局 */
const organizeLayout = (): void => {
  const result = autoLayout(items.value, links.value)
  if (result.message) console.warn(result.message)
  // 强制触发响应式更新
  items.value = [...items.value]
  saveToLocalStorage()
  // 整理后自动适应画布
  nextTick(() => autoFitCanvas())
}

const toggleLinkMode = () => {
  operationMode.value = operationMode.value === 'linking' ? 'normal' : 'linking'
  if (operationMode.value === 'normal') resetConnectionState()
}

// ====== 工作流运行 ======
const initWorkflowRunner = () => {
  runner.value = new WorkflowRunner({ items: items.value, links: links.value }, store, {
    onNodeStart: (id, name) => pushLog(`${name} 开始执行`, 'info'),
    onNodeComplete: (id, name, type, status, result) => {
      const level = status === 'error' ? 'error' : status === 'success' ? 'success' : 'info'
      pushLog(`${name} → ${status}${result ? `: ${formatResultForLog(result)}` : ''}`, level)
    },
    onMcpStatusChange: (nodeId, connected, tools) => {
      const node = items.value.find(item => item.id === nodeId)
      if (node && node.type === 'mcp') { node.mcpConnected = connected; if (tools) node.mcpTools = tools }
    },
    onProgress: (completed, total) => { executionProgress.value = Math.round((completed / total) * 100) },
    onComplete: () => { executionProgress.value = 0 },
    onNodeStatusUpdate: (nodeId, status, result) => {
      const node = items.value.find(item => item.id === nodeId)
      if (node) { node.status = status; if (result !== undefined) node.result = result }
    },
    onSaveWorkflow: () => saveToLocalStorage(),
    onLog: (message, level) => pushLog(message, level)
  })
}

const runWorkflow = async (): Promise<void> => {
  if (!runner.value) initWorkflowRunner()
  try { const result = await runner.value!.run(); if (!result.success) console.error('工作流执行失败:', result)
  } catch (error: any) { console.error('工作流执行异常:', error) }
}

/** 继续执行：跳过已成功的节点，仅执行未完成的节点（从上次中断处继续） */
const continueWorkflow = async (): Promise<void> => {
  if (!runner.value) initWorkflowRunner()
  try {
    const result = await runner.value!.run(undefined, { resume: true })
    if (!result.success) console.error('工作流继续执行失败:', result)
  } catch (error: any) { console.error('工作流继续执行异常:', error) }
}

const stopWorkflow = (): void => { runner.value?.stop() }

const runSingleNode = async (): Promise<void> => {
  if (selectedNodeId.value === null || !runner.value) return
  try { const s = await runner.value.executeSingleNode(selectedNodeId.value); console.log(s ? '成功' : '失败')
  } catch (error: any) { console.error('节点执行异常:', error) }
}

const resetNodeStatuses = async (): Promise<void> => {
  if (items.value.length === 0) return
  try {
    await ElMessageBox.confirm(t('reset_status_confirm'), store.locales === 'zh' ? '提示' : 'Prompt', {
      confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
      cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
      type: 'warning'
    })
    runner.value?.resetNodes(); saveToLocalStorage()
  } catch {}
}

// ====== 批量运行 ======
const runWorkflowBatch = async (): Promise<void> => {
  if (!isWorkflowValid.value || runner?.value?.isRunning || isBatchRunning.value) return
  try {
    await ElMessageBox.confirm(`确定要运行工作流 ${batchRunTimes.value} 次吗？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch { return }
  isBatchRunning.value = true; batchProgress.value = 0
  try {
    const origItems = JSON.parse(JSON.stringify(items.value))
    const origLinks = JSON.parse(JSON.stringify(links.value))
    for (let i = 0; i < batchRunTimes.value; i++) {
      const start = Date.now()
      items.value.forEach(item => { item.status = 'idle'; item.result = getWaitingText(item.type, t) })
      initWorkflowRunner()
      const result = await runner.value!.run()
      const currentRound = batchResults.value.length + 1
      const nodeResults = items.value.map(n => ({ id: n.id, name: n.name, type: n.type, status: n.status, result: n.result, timestamp: new Date().toISOString() }))
      batchResults.value.push({
        round: currentRound, timestamp: new Date().toISOString(), duration: Date.now() - start,
        success: result.success, result: result.result, aggregatedResults: result.aggregatedResults,
        executionStats: result.executionStats,
        nodeResults,
        executionOrder: runner.value?.executionOrder || []
      })
      // 自动展开结束节点
      const endNode = nodeResults.find(n => n.type === 'end')
      if (endNode) toggleNodeResult(currentRound, endNode)
      batchProgress.value = ((i + 1) / batchRunTimes.value) * 100
      items.value = JSON.parse(JSON.stringify(origItems))
      links.value = JSON.parse(JSON.stringify(origLinks))
      await new Promise(r => setTimeout(r, 500))
    }
    ElMessage.success(`批量运行完成！ 成功: ${batchResults.value.filter(r => r.success).length}/${batchRunTimes.value}`)
  } catch (error: any) { console.error('批量运行失败:', error); ElMessage.error(`批量运行失败: ${error.message}`)
  } finally { isBatchRunning.value = false; batchProgress.value = 0 }
}

const saveBatchResultsToFolder = async (): Promise<void> => {
  if (batchResults.value.length === 0) { ElMessage.warning('没有批量运行结果可保存'); return }
  try {
    const wb = XLSX.utils.book_new()
    const allIds = new Set<number>()
    const nameMap = new Map<number, string>()
    batchResults.value.forEach(r => r.nodeResults?.forEach((nr: any) => { allIds.add(nr.id); if (!nameMap.has(nr.id) && nr.name) nameMap.set(nr.id, nr.name) }))
    const order = Array.from(allIds).sort((a, b) => a - b)
    const h = ['Round', 'Timestamp', 'Status', 'Duration(ms)']
    order.forEach(id => h.push(`${nameMap.get(id)||`N${id}`}(${id})`))
    const rows: any[][] = [h]
    batchResults.value.forEach(r => {
      const row: any[] = [r.round, r.timestamp, r.success ? 'Success' : 'Failed', r.duration || 0]
      const map = new Map<number, any>(r.nodeResults?.map((nr: any) => [nr.id, nr]) || [])
      order.forEach(id => {
        const nr = map.get(id)
        if (nr?.result) { let c = typeof nr.result === 'string' ? nr.result : JSON.stringify(nr.result); row.push(c.length > 32000 ? c.substring(0, 32000) + '...(truncated)' : c) }
        else row.push('')
      })
      rows.push(row)
    })
    const sheet = XLSX.utils.aoa_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, sheet, '运行结果汇总')
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `batch_results_${ts}.xlsx`; a.click(); URL.revokeObjectURL(url)
  } catch (error: any) { console.error('保存失败:', error); ElMessage.error(`保存失败: ${error.message}`) }
}

const clearBatchResults = async (): Promise<void> => {
  if (batchResults.value.length === 0) return
  try {
    await ElMessageBox.confirm('确定要清空批量运行结果吗？', '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
    batchResults.value = []; batchProgress.value = 0
  } catch {}
}

// ====== MCP操作 ======
const testMcpConnection = async (nodeId: number): Promise<void> => { try { await runner.value?.testMcpConnection(nodeId) } catch {} }
const connectMcpNode = async (nodeId: number): Promise<void> => { try { await runner.value?.connectMcpNode(nodeId) } catch {} }
const disconnectMcpNode = async (nodeId: number): Promise<void> => { try { await runner.value?.disconnectMcpNode(nodeId) } catch {} }
const refreshMcpTools = async (nodeId: number): Promise<void> => { try { await runner.value?.refreshMcpTools(nodeId) } catch {} }

// ====== 决策节点操作 ======
const addDecisionBranch = (): void => {
  if (!selectedNode.value || selectedNode.value.type !== 'decision') return
  const branches = [...(selectedNode.value.decisionBranches || [])]
  if (branches.length >= 10) return
  branches.push({ id: `branch_${branches.length + 1}`, name: `${t('branch')} ${branches.length + 1}`, description: '', dataTemplate: '{input}' })
  selectedNode.value.decisionBranches = branches
  if (selectedNode.value.decisionConfig) selectedNode.value.decisionConfig.branches = [...branches]
  ensureMinNodeHeight(selectedNode.value)
  saveToLocalStorage()
}

const deleteDecisionBranch = (branchId: string): void => {
  if (!selectedNode.value || selectedNode.value.type !== 'decision' || !selectedNode.value.decisionBranches || selectedNode.value.decisionBranches.length <= 2) return
  selectedNode.value.decisionBranches = selectedNode.value.decisionBranches.filter(b => b.id !== branchId)
  if (selectedNode.value.decisionConfig) selectedNode.value.decisionConfig.branches = [...selectedNode.value.decisionBranches]
  links.value = links.value.filter(l => !(l.source === selectedNode.value!.id && l.branch === branchId))
  ensureMinNodeHeight(selectedNode.value, true)
  saveToLocalStorage()
}

// ====== 知识库验证 ======
const validateKnowledgeBaseNode = async (nodeId: number): Promise<void> => {
  const node = items.value.find(item => item.id === nodeId)
  if (!node || node.type !== 'knowledge') return
  if (!node.kbPath) { node.kbValidation = { valid: false, issues: [t('kb_file_required')] }; return }
  try {
    // 跟随默认模型来源校验（有的电脑没有 Ollama）；当前来源无嵌入模型时回退 Ollama 校验
    const llm = store.AIconfig?.llm
    const llmType = llm?.type || 'ollama'
    const result = await validateKnowledgeBase(node.kbPath, {
      llmType: llmType as any,
      providerConfig: getProviderConfig(llm, llmType) || undefined,
      ollamaHost: llm?.ollama?.model_url || 'http://127.0.0.1:11434',
      checkModelAvailability: true
    })
    node.kbValidation = result
    if (result.valid && result.availableModel) {
      if (!node.kbOptions) node.kbOptions = { ...defaultKbOptions }
      if (!node.kbOptions.embedModel) node.kbOptions.embedModel = result.availableModel
    }
  } catch (error: any) { node.kbValidation = { valid: false, issues: [`验证失败: ${error.message}`] } }
}

// ====== 工作流持久化 ======
const LOCAL_STORAGE_KEY = 'workflow'
const VIEW_STORAGE_KEY = 'workflow_view'

const loadFromLocalStorage = (): void => {
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!saved) return
    const data = JSON.parse(saved)
    if (data.items && Array.isArray(data.items)) {
      items.value = data.items
      items.value.forEach(item => {
        item.status = 'idle'
        if (!item.width || !item.height) { const tmpl = nodeTemplates[item.type]; if (tmpl) { item.width = tmpl.width; item.height = tmpl.height } }
        createNodeDefaults(item, store, t)
      })
    }
    if (data.links && Array.isArray(data.links)) links.value = data.links
    initWorkflowRunner()
    autoFitCanvas()
  } catch (error) { console.error('加载失败:', error); items.value = []; links.value = [] }
}

const saveToLocalStorage = (): void => {
  try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ items: items.value, links: links.value, lastSaved: new Date().toISOString() }))
  } catch (error) { console.error('保存失败:', error) }
}

const saveViewState = (): void => {
  try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ transform: viewTransform.value, scale: scale.value, lastSaved: new Date().toISOString() })) } catch {}
}

// ====== 文件操作 ======
const saveWorkflow = (): void => {
  const blob = new Blob([JSON.stringify({ items: items.value, links: links.value }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a')
  a.href = url; a.download = `${t('workflow')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.flow`; a.click(); URL.revokeObjectURL(url)
  showSaveStatus('已下载', 'success')
}

/** 保存处理：有当前文件则直接保存到文件，否则弹窗下载 */
const saveWorkflowHandler = (): void => {
  if (currentWorkflowFile.value) {
    saveWorkflowToFile()
  } else {
    saveWorkflow()
  }
}

const saveWorkflowToFile = async (): Promise<void> => {
  if (!currentWorkflowFile.value) return
  try {
    const content = JSON.stringify({ items: items.value, links: links.value }, null, 2)
    await window.ipcRenderer.invoke('writeFile', currentWorkflowFile.value, content)
    isDirty.value = false; isNewWorkflow.value = false
    saveToLocalStorage()
    showSaveStatus('保存成功', 'success')
  } catch (error) {
    console.error('保存工作流失败:', error)
    showSaveStatus('保存失败', 'error')
  }
}

const openWorkflow = async (): Promise<void> => {
  try {
    const result = await window.ipcRenderer.invoke('openFile')
    if (result?.content) {
      const data = JSON.parse(result.content)
      items.value = data.items || []; links.value = data.links || []
      items.value.forEach(item => { createNodeDefaults(item, store, t); if (item.type === 'knowledge' && item.kbPath) validateKnowledgeBaseNode(item.id) })
      initWorkflowRunner(); saveToLocalStorage()
      isDirty.value = false; isNewWorkflow.value = false
      autoFitCanvas()
    }
  } catch (error) { console.error('打开工作流失败:', error) }
}

const resetWorkflow = (): void => {
  if (runner.value?.isRunning) { ElMessage.warning('请先停止当前运行的工作流'); return }
  items.value = []; links.value = []; selectedNodeId.value = null; propertiesShow.value = false
  hoveredNodeId.value = null; operationMode.value = 'normal'; resetConnectionState()
  currentWorkflowFile.value = null; isDirty.value = false; isNewWorkflow.value = true
  initWorkflowRunner(); saveToLocalStorage()
}

const addWorkflow = async (): Promise<void> => {
  try {
    // 检查工作流文件夹是否已设置
    if (!store.workflowPath) {
      const path = await window.ipcRenderer.invoke('openFolderDialog')
      if (!path) return
      store.workflowPath = path
    }

    const { value } = await ElMessageBox.prompt('请输入工作流名称', '新建工作流', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputPattern: /\S/,
      inputErrorMessage: '名称不能为空',
    })
    if (!value) return

    // 创建空白工作流（含开始节点和结束节点）
    resetWorkflow()
    const startNode = { ...nodeTemplates.start, id: 0, x: 60, y: 120 }
    const endNode = { ...nodeTemplates.end, id: 1, x: 400, y: 120 }
    createNodeDefaults(startNode, store, t)
    createNodeDefaults(endNode, store, t)
    items.value = [startNode, endNode]
    initWorkflowRunner()

    // 保存到工作流文件夹
    const fileName = value.endsWith('.flow') ? value : `${value}.flow`
    const filePath = `${store.workflowPath.replace(/\\/g, '/')}/${fileName}`
    const content = JSON.stringify({ items: items.value, links: links.value }, null, 2)
    await window.ipcRenderer.invoke('writeFile', filePath, content)
    currentWorkflowFile.value = filePath
    isDirty.value = false
    isNewWorkflow.value = false

    // 刷新文件列表并进入设计
    await refreshWorkflowFiles()
    autoFitCanvas()
  } catch {
    // 用户取消
  }
}

const openWorkflowFolder = async (): Promise<void> => {
  let path = await window.ipcRenderer.invoke('openFolderDialog')
  if (path != null) {
    store.workflowPath = path
    await refreshWorkflowFiles()
  }
}

const refreshWorkflowFiles = async (): Promise<void> => {
  if (!store.workflowPath) { workflowFiles.value = []; return }
  loadingWorkflows.value = true
  try {
    const result = await window.ipcRenderer.invoke('getDirectoryTree', store.workflowPath)
    const files: any[] = []
    const walkTree = (nodes: any[]) => {
      for (const n of nodes) {
        if (!n || !n.label) continue
        if (n.type === 'file' && (n.label.endsWith('.json') || n.label.endsWith('.workflow') || n.label.endsWith('.flow'))) {
          files.push({ name: n.label, path: n.path, mtime: n.mtime, size: n.size || 0 })
        }
        if (n.children) walkTree(n.children)
      }
    }
    if (result && result.children) walkTree(result.children)
    else if (Array.isArray(result)) walkTree(result)
    workflowFiles.value = files
  } catch (e) {
    console.error('刷新工作流列表失败:', e)
    workflowFiles.value = []
  }
  loadingWorkflows.value = false
}

/** 点击左侧文件 → 若当前有未保存修改则提示，然后加载 */
const loadWorkflowFile = async (wf: any): Promise<void> => {
  if (isDirty.value && currentWorkflowFile.value) {
    try {
      await ElMessageBox.confirm(
        `"${currentWorkflowFile.value.split(/[\\/]/).pop()}" 有未保存的修改，是否放弃并切换？`,
        '提示',
        {
          confirmButtonText: '放弃并切换',
          cancelButtonText: '取消',
          type: 'warning'
        }
      )
    } catch { return }
  }
  if (sidebarTab.value !== 'test') sidebarTab.value = 'files'
  isLoadingFile.value = true
  try {
    const result = await window.ipcRenderer.invoke('readFile', wf.path)
    const data = JSON.parse(result)
    items.value = data.items || []
    links.value = data.links || []
    items.value.forEach(item => {
      createNodeDefaults(item, store, t)
      if (item.type === 'knowledge' && item.kbPath) validateKnowledgeBaseNode(item.id)
    })
    initWorkflowRunner()
    currentWorkflowFile.value = wf.path
    isDirty.value = false; isNewWorkflow.value = false
    // 在异步验证前同步计算缩放居中，与 items/links 同批次渲染
    autoFitCanvas()
    // 等待所有异步验证完成（避免完成后误标记 dirty）
    await Promise.all(
      items.value
        .filter(item => item.type === 'knowledge' && item.kbPath)
        .map(item => validateKnowledgeBaseNode(item.id))
    )
  } catch (error) {
    console.error('加载工作流失败:', error)
  } finally {
    isLoadingFile.value = false
  }
}

/** 删除工作流文件 */
const deleteWorkflowFile = async (wf: any): Promise<void> => {
  try {
    await ElMessageBox.confirm(`确定要删除工作流 "${wf.name}" 吗？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch { return }
  try {
    await window.ipcRenderer.invoke('deleteFile', wf.path)
    workflowFiles.value = workflowFiles.value.filter(f => f.path !== wf.path)
    if (currentWorkflowFile.value === wf.path) {
      currentWorkflowFile.value = null
      isDirty.value = false
      items.value = []; links.value = []
      initWorkflowRunner()
    }
  } catch (error) {
    console.error('删除工作流失败:', error)
  }
}

/** 显示工程文件右键菜单（自动调整位置避免超出屏幕） */
const showFileMenu = (e: MouseEvent, wf: any): void => {
  const estimatedHeight = 90
  const spaceBelow = window.innerHeight - e.clientY
  fileMenu.value = {
    visible: true,
    style: {
      left: Math.min(e.clientX, window.innerWidth - 180) + 'px',
      top: e.clientY + 'px',
      transform: estimatedHeight > spaceBelow ? 'translateY(-100%)' : '',
    },
    file: wf,
  }
}

/** 隐藏工程文件右键菜单 */
const hideFileMenu = (): void => { fileMenu.value.visible = false }
const closeFileMenu = (): void => { fileMenu.value.visible = false }

/** 重命名工作流文件（保留原后缀，同步当前打开文件路径） */
const renameWorkflowFile = async (wf: any): Promise<void> => {
  if (!wf) return
  const extMatch = String(wf.name || '').match(/\.([^./]+)$/)
  const ext = extMatch ? `.${extMatch[1]}` : ''
  const baseName = ext ? String(wf.name).slice(0, -ext.length) : String(wf.name)
  try {
    const { value } = await ElMessageBox.prompt(
      store.locales === 'en' ? 'Please enter a new name:' : '请输入新名称：',
      store.locales === 'en' ? 'Rename' : '重命名',
      {
        confirmButtonText: store.locales === 'en' ? 'OK' : '确定',
        cancelButtonText: store.locales === 'en' ? 'Cancel' : '取消',
        inputValue: baseName,
        inputPattern: /.+/,
        inputErrorMessage: store.locales === 'en' ? 'Name cannot be empty' : '名称不能为空',
      }
    )
    const trimmed = String(value || '').trim()
    if (!trimmed || trimmed === baseName) return
    const newName = ext ? `${trimmed}${ext}` : trimmed
    const result = await window.ipcRenderer.invoke('renameFile', wf.path, newName)
    if (result?.success) {
      if (currentWorkflowFile.value === wf.path) currentWorkflowFile.value = result.newPath
      await refreshWorkflowFiles()
      showSaveStatus(store.locales === 'en' ? 'Rename successful' : '重命名成功', 'success')
    } else {
      ElMessage.error(store.locales === 'en' ? `Rename failed: ${result?.error || ''}` : `重命名失败：${result?.error || ''}`)
    }
  } catch { /* 用户取消 */ }
}
</script>

<style scoped>
.workflow-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--backgroundColor);
  overflow: hidden;
}

/* ====== 顶部工具栏（标签按钮 + 路径 + 操作 + 统计） ====== */
.top-bar {
  display: flex;
  align-items: center;
  padding: 2px 6px;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
  background: var(--menuColor);
  min-height: 29px;
}

/* 工具栏分组（标签按钮组与操作按钮组统一样式） */
.top-tabs,
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  min-width: 0;
}

/* 标签按钮与其余工具栏按钮统一样式（选中态高亮） */
.top-bar .toolbar-btn.active {
  color: var(--fontActiveColor);
  background: var(--menuActiveColor);
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
  padding: 0;
  transition: all 0.15s;
  flex-shrink: 0;
}

.toolbar-btn:hover {
  background: var(--backgroundColor);
}

.toolbar-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* 工具栏内的路径（原 editor-header） */
.top-bar .editor-header {
  border-bottom: none;
  padding: 0;
  background: none;
  opacity: 1;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}

/* 工具栏内的画布统计（原 canvas-stats） */
.top-bar .canvas-stats {
  position: static;
  border-top: none;
  opacity: 1;
  min-height: 0;
  padding: 0;
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
}

/* ====== 管理标签页工具栏 ====== */
.manage-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0px;
  padding-right: 5px;
  background: var(--menuColor);
}

.folder-path {
  font-size: 11px;
  color: var(--fontColor);
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-count {
  font-size: 10px;
  color: var(--fontColor);
  white-space: nowrap;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--fontColor);
  background: var(--backgroundColor);
  white-space: nowrap;
  user-select: none;
  transition: all 0.15s;
  padding: 3px 8px;
  height: 22px;
}

.button:hover {
  background: var(--menuColor);
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button.small {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
}

.button.danger {
  background: #f44336;
  color: white;
  border-color: #f44336;
}

.button.danger:hover {
  background: #d32f2f;
}

/* ====== 工作流标签页（合并管理+设计） ====== */
.workflow-tab-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ====== 主内容区（顶部工具栏之下） ====== */
.workflow-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.workflow-sidebar {
  position: relative;
  width: 200px;
  min-width: 150px;
  max-width: calc(100% - 220px); /* 防止拖拽过宽导致溢出：右侧至少保留 220px */
  border-right: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  background: var(--menuColor);
}

/* 拖拽调整侧栏宽度手柄 */
.sidebar-resizer {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 10;
  transition: background-color 0.15s;
}
.sidebar-resizer:hover,
.sidebar-resizer:active {
  background-color: var(--fontActiveColor);
  opacity: 0.4;
}

.sidebar-header {
  padding: 0;
  font-size: 11px;
  font-weight: 500;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}

.sidebar-header-top {
  display: flex;
  line-height: 22px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
}

.sidebar-header-actions {
  display: flex;
  gap: 2px;
}

.sidebar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  border-radius: 3px;
  font-size: 13px;
  transition: all 0.15s;
}

.sidebar-btn:hover {
  background: var(--backgroundColor);
  color: var(--fontActiveColor);
}

/* 侧边栏标签页切换 */
.sidebar-tabs {
  display: flex;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.sidebar-tab {
  flex: 1;
  padding: 6px 4px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 11px;
  text-align: center;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  opacity: 0.6;
}
.sidebar-tab:hover { opacity: 1; background: var(--backgroundColor); }
.sidebar-tab.active {
  opacity: 1;
  border-bottom-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}

/* 节点面板拖拽列表（grid 多列，更紧凑） */
/* 使用 .sidebar-list.palette-list 提高特异性，覆盖后定义的 .sidebar-list 的 minmax(140px,1fr) */
.sidebar-list.palette-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(82px, 1fr));
  gap: 4px;
  padding: 4px;
  align-content: start;
}
.palette-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 5px;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: grab;
  font-size: 11px;
  color: var(--fontColor);
  transition: all 0.15s;
  user-select: none;
}
.palette-item:active { cursor: grabbing; }
.palette-item i { font-size: 13px; width: 15px; text-align: center; flex-shrink: 0; }
.palette-info { display: flex; flex-direction: column; min-width: 0; flex: 1; overflow: hidden; }
.palette-info .palette-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.palette-item:hover {
  background: var(--backgroundColor);
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 4px rgba(var(--fontActiveColor-rgb,33,150,243),0.3);
}

/* 工程页底部操作栏 */
.sidebar-footer-actions {
  display: flex;
  gap: 2px;
  padding: 6px 10px;
  border-top: 1px solid var(--borderColor);
  flex-shrink: 0;
  justify-content: flex-start;
  align-items: center;
}

.sidebar-footer-actions .save-status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  white-space: nowrap;
  animation: fadeInOut 3s ease-in-out;
  margin-left: 4px;
}
.sidebar-footer-actions .save-status.success {
  color: #4CAF50;
}
.sidebar-footer-actions .save-status.error {
  color: #f44336;
}

.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
  background: var(--backgroundColor);
  /* grid 布局：侧栏变宽时工程/节点项可多列显示 */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px;
  align-content: start;
}

/* ====== 日志侧边栏（单列显示，占满整行；覆盖 sidebar-list 的 grid） ====== */
.log-sidebar-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 2px 4px;
}
.log-sidebar-list .empty-hint {
  min-height: 120px;
}
/* 日志操作条（导出/清空/条数） */
.sidebar-log-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 4px 6px;
  border-top: 1px solid var(--borderColor);
  flex-shrink: 0;
  background: var(--menuColor);
}
.sidebar-log-actions .log-count {
  margin-right: auto;
}
.sidebar-log-actions .log-clear-btn {
  padding: 2px 6px;
  font-size: 10px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
  margin-bottom: 2px;
}

.file-item:hover {
  background: var(--backgroundColor);
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 4px rgba(var(--fontActiveColor-rgb,33,150,243),0.3);
}

.file-item.active {
  background: rgba(33, 150, 243, 0.12);
  border-color: #2196F3;
  box-shadow: 0 0 4px rgba(33,150,243,0.3);
}

/* 圆形图标背景（参照 AgentSwarm swarm-file-avatar） */
.file-avatar {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
}
.file-avatar i {
  font-size: 13px;
  color: var(--fontActiveColor);
}

/* 文件信息行：大小 + 时间（参照 AgentSwarm swarm-file-stats） */
.file-info .file-stats {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.75;
  margin-top: 1px;
}
.file-info .file-stats .stat {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
.file-info .file-stats .stat i {
  font-size: 8px;
}
.file-info .file-stats .stat-size {
  color: var(--fontActiveColor);
}
.file-info .file-stats .file-time {
  font-size: 8px;
  color: var(--fontColor);
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-info .file-name {
  display: block;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-info .file-path-hint {
  display: block;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-del-btn {
  display: none;
  border: none;
  background: none;
  color: #f44336;
  cursor: pointer;
  padding: 2px;
  font-size: 11px;
  flex-shrink: 0;
}

.file-item:hover .file-del-btn {
  display: inline-flex;
}

.workflow-editor-area {
  flex: 1;
  min-width: 0; /* 允许收缩，避免被固定宽度的侧边栏挤出容器 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dirty-mark {
  color: #FF9800;
  font-weight: bold;
  margin-left: 2px;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fontColor);
  opacity: 0.5;
  font-size: 13px;
  height: 100%;
  min-height: 200px;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--fontColor);
  background: var(--backgroundColor);
  white-space: nowrap;
  user-select: none;
  transition: all 0.15s;
  padding: 3px 8px;
  height: 22px;
}

.button:hover {
  background: var(--menuColor);
}

.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button.small {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
}

.button.danger {
  background: #f44336;
  color: white;
  border-color: #f44336;
}

.button.danger:hover {
  background: #d32f2f;
}

/* ====== 编辑器顶部路径栏 ====== */
.editor-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 7px 12px;
  font-size: 12px;
  color: var(--fontColor);
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  opacity: 0.85;
  margin-left: 10px
}

.editor-header .editor-path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ====== 设计编辑器 ====== */
.editor-main {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* ====== 画布底部状态栏 ====== */
.canvas-stats {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1px 12px;
  background: var(--menuColor);
  opacity: 0.85;
  border-top: 1px solid var(--borderColor);
  font-size: 11px;
  z-index: 10;
  pointer-events: auto;
  min-height: 32px;
  gap: 5px;
}

.stats-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.stats-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.canvas-stats .stat-item {
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--fontColor);
  opacity: 0.8;
}

.canvas-stats .stat-item.running {
  color: #2196F3;
  font-weight: bold;
}

.canvas-stats .stat-divider {
  width: 1px;
  height: 14px;
  background: var(--borderColor);
  opacity: 0.5;
  flex-shrink: 0;
}

.canvas-stats .canvas-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  border-radius: 3px;
  font-size: 12px;
  padding: 0;
  transition: all 0.15s;
  flex-shrink: 0;
}

.canvas-stats .canvas-btn:hover {
  background: var(--backgroundColor);
  opacity: 1;
}

.canvas-stats .canvas-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.canvas-stats .save-status {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  white-space: nowrap;
  animation: fadeInOut 3s ease-in-out;
}

.canvas-stats .save-status.success {
  color: #4CAF50;
}

.canvas-stats .save-status.error {
  color: #f44336;
}

@keyframes fadeInOut {
  0% { opacity: 0; }
  10% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}

/* ====== 测试面板（悬浮居中，参照 set 设置面板） ====== */
.test-overlay {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: rgba(0, 0, 0, 0.35);
}

.test-content {
  width: min(1024px, calc(100% - 96px));
  height: min(720px, calc(100% - 96px));
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  background: var(--backgroundColor);
}

/* 标题栏右侧（路径 + 关闭按钮，居右） */
.test-content .settings-header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  margin-left: auto;
}

.test-content .settings-close {
  width: 26px;
  height: 26px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
  flex-shrink: 0;
}

.test-content .settings-close:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

/* 顶部标题栏（set 样式）：标题 + 测试配置 + 路径 + 关闭 */
.test-content .settings-header {
  flex-shrink: 0;
  min-height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 12px;
  background-color: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-top-left-radius: 10px;
  border-top-right-radius: 10px;
  user-select: none;
}

.test-content .settings-header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fontColor);
}

.test-content .settings-header-title i {
  color: var(--fontActiveColor);
}

.test-content .test-path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.7;
  max-width: 50%;
}

/* 主体容器（set 样式） */
.test-content .settings-container {
  flex: 1;
  min-height: 0;
  display: flex;
  background-color: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-top: none;
  border-bottom-left-radius: 10px;
  border-bottom-right-radius: 10px;
  overflow: hidden;
}

/* 测试配置项（位于标题栏内，横向排列） */
.test-config-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fontColor);
  flex-shrink: 0;
}

.test-config-label {
  white-space: nowrap;
  opacity: 0.85;
}

.test-config-btns {
  display: flex;
  flex-direction: row;
  gap: 2px;
  flex-shrink: 0;
}

.test-config-btns .test-btn {
  justify-content: center;
  width: auto;
  padding: 3px 7px;
  border-radius: 4px;
}

.test-config-count {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--fontActiveColor);
  flex-shrink: 0;
  white-space: nowrap;
}

/* 标题栏内的进度条不收缩 */
.test-content .settings-header .test-progress-bar {
  flex-shrink: 0;
}

/* ====== 运行日志面板（复用测试面板悬浮样式） ====== */
.log-count {
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.7;
  white-space: nowrap;
}
.log-clear-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.log-clear-btn:hover { border-color: #f44336; color: #f44336; }
.log-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px;
  font-family: Consolas, Monaco, monospace;
}
.log-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
  color: var(--fontColor);
  border-bottom: 1px solid rgba(0,0,0,0.04);
}
.log-item:hover { background: rgba(0,0,0,0.03); }
.log-item .log-time { flex-shrink: 0; color: var(--fontColor); opacity: 0.55; white-space: nowrap; }
.log-item .log-level { flex-shrink: 0; width: 14px; text-align: center; }
.log-item .log-message { flex: 1; min-width: 0; white-space: pre-wrap; }
.log-item.info .log-level { color: #2196F3; }
.log-item.success .log-level { color: #4CAF50; }
.log-item.warning .log-level { color: #FF9800; }
.log-item.error .log-level { color: #f44336; }
.log-item.error .log-message { color: #f44336; }

/* 右侧内容（set 样式） */
.test-content .settings-content {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  border-bottom-right-radius: 10px;
  padding: 4px 8px;
}

/* 测试页底部状态栏（与画布状态栏风格一致） */
.test-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1px 12px;
  background: var(--menuColor);
  opacity: 0.85;
  border-top: 1px solid var(--borderColor);
  font-size: 11px;
  flex-shrink: 0;
  min-height: 32px;
  gap: 8px;
}

.test-stats .stats-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.test-stats .stats-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-stats-select {
  font-size: 11px;
  padding: 2px 4px;
  margin: 0;
  width: auto;
  flex-shrink: 0;
  border-radius: 3px;
  color: var(--fontColor);
  cursor: pointer;
  border:0px
}
.test-stats-select option {
  background: var(--menuColor, var(--backgroundColor));
  color: var(--fontColor);
}

.test-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 3px 6px;
  border: none;
  background: none;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
  transition: all 0.15s;
  flex-shrink: 0;
}

.test-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.test-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.test-progress-bar {
  position: relative;
  width: 140px;
  height: 20px;
  background: var(--borderColor);
  border-radius: 4px;
  overflow: hidden;
}

.test-progress-bar .progress-fill {
  height: 100%;
  background: #4CAF50;
  border-radius: 4px;
  transition: width 0.3s;
}

.test-progress-bar .progress-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 10px;
  color: #fff;
  text-shadow: 0 0 3px rgba(0,0,0,0.5);
  white-space: nowrap;
}

.test-workflow-name {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--fontActiveColor);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.test-split {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.test-results {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}

.batch-progress-bar {
  position: relative;
  height: 24px;
  background: var(--borderColor);
  border-radius: 4px;
  margin: 8px 0;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #2196F3;
  transition: width 0.3s;
  border-radius: 4px;
}

.progress-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 11px;
  color: #fff;
  font-weight: 600;
  text-shadow: 0 0 2px rgba(0,0,0,0.5);
}

.batch-result-item {
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  margin-bottom: 4px;
  overflow: hidden;
}

.batch-result-item.success { border-color: rgba(76, 175, 80, 0.3); }
.batch-result-item.error { border-color: rgba(244, 67, 54, 0.3); }

.batch-result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 11px;
  background: var(--menuColor);
  border-bottom: 1px solid var(--borderColor);
}

.batch-result-index { font-weight: 600; color: var(--fontActiveColor); }
.batch-result-status { display: flex; align-items: center; gap: 4px; }
.batch-result-item.success .batch-result-status { color: #4CAF50; }
.batch-result-item.error .batch-result-status { color: #f44336; }
.batch-result-time { margin-left: auto; font-size: 10px; color: var(--fontColor); opacity: 0.6; }
.batch-result-body { padding: 6px 8px; }
.batch-result-body pre { margin: 0; font-size: 10px; line-height: 1.4; white-space: pre-wrap; word-break: break-all; color: var(--fontColor); max-height: 120px; overflow-y: auto; }

.batch-result-nodes {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--borderColor);
}

.node-status-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
}

.node-status-tag.success {
  color: #4CAF50;
  border-color: rgba(76, 175, 80, 0.3);
  background: rgba(76, 175, 80, 0.08);
}

.node-status-tag.error {
  color: #f44336;
  border-color: rgba(244, 67, 54, 0.3);
  background: rgba(244, 67, 54, 0.08);
}

.node-status-tag.idle,
.node-status-tag.waiting {
  color: var(--fontColor);
  opacity: 0.6;
}

.node-status-tag.running {
  color: #2196F3;
  border-color: rgba(33, 150, 243, 0.3);
  background: rgba(33, 150, 243, 0.08);
}

.node-status-tag.expanded {
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 3px rgba(33, 150, 243, 0.4);
}

.expanded-node-output {
  width: 100%;
  padding: 4px 0;
}

.expanded-node-output .result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
  line-height: 1.4;
}
.expanded-node-output .result-table tr {
  border-bottom: 1px solid var(--borderColor);
}
.expanded-node-output .result-table tr:last-child {
  border-bottom: none;
}
.expanded-node-output .result-table td {
  height: 10px
}
.expanded-node-output .result-key {
  vertical-align: top;
  padding: 3px 6px;
  font-weight: 600;
  color: var(--fontColor);
  white-space: nowrap;
  width: 1%;
}
.expanded-node-output .result-val {
  vertical-align: top;
  padding: 3px 6px;
  color: var(--fontColor);
  word-break: break-all;
}
.expanded-node-output .result-val pre {
  margin: 0;
  font-size: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ====== 右键菜单 ====== */
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

.context-menu-header {
  padding: 6px 12px;
  font-size: 10px;
  font-weight: 600;
  color: var(--fontColor);
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--borderColor);
  margin-bottom: 2px;
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

/* ====== 工程文件右键菜单项（参照 AgentSwarm 集群列表菜单） ====== */
.file-menu {
  min-width: 150px;
}
.file-menu .menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  color: var(--fontColor);
  transition: background 0.12s;
  font-size: 12px;
  white-space: nowrap;
  user-select: none;
}
.file-menu .menu-item:hover {
  background: color-mix(in srgb, var(--fontActiveColor) 14%, transparent);
}
.file-menu .menu-item i {
  width: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--fontActiveColor);
}

/* 二级菜单 */
.submenu-trigger {
  position: relative;
}

.submenu-arrow {
  margin-left: auto;
  font-size: 10px !important;
  opacity: 0.5;
  width: auto !important;
}

.submenu {
  display: none;
  position: absolute;
  left: 100%;
  top: -4px;
  min-width: 160px;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  padding: 4px 0;
  font-size: 12px;
  z-index: 1001;
}

/* 子菜单向上展开（避免超出屏幕底部） */
.submenu-upward .submenu {
  top: auto;
  bottom: 0;
}

.submenu-trigger:hover .submenu,
.submenu-trigger:focus-within .submenu {
  display: block;
}

.submenu .context-menu-item {
  white-space: nowrap;
}
</style>
