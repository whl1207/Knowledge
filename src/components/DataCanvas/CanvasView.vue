<!-- CanvasView.vue - 数据画布编辑器（节点拖拽建模 / 连线 / 子画布嵌套 / 属性编辑） -->
<template>
  <div class="dc-canvas-view">
    <!-- ====== 顶部工具栏（hideToolbar 时隐藏：由宿主模块提升到标签栏右侧渲染） ====== -->
    <div class="dc-toolbar" v-if="!hideToolbar">
      <div class="dc-toolbar-left">
        <div class="dc-breadcrumb">
          <span class="dc-crumb" @click="navigateRoot()"><i class="fa fa-home"></i> {{ t('根画布') }}</span>
          <!-- 跳过 crumbPath 第一项（根模型本身），避免重复显示"默认模型" -->
          <template v-for="(p, idx) in crumbPath.slice(1)" :key="p.id">
            <span class="dc-crumb-sep"><i class="fa fa-angle-right"></i></span>
            <span class="dc-crumb" :class="{ active: idx === crumbPath.length - 2 }" @click="goTo(p.id)">
              <i class="fa fa-cubes"></i> {{ p.name }}
            </span>
          </template>
        </div>
      </div>

      <div class="dc-toolbar-right">
        <button class="dc-btn" :title="t('保存并通知宿主')" @click="handleSave"><i class="fa fa-save"></i> {{ t('保存') }}</button>
        <div class="dc-seg">
          <button class="dc-btn" :class="{ active: !connectMode }" @click="connectMode = false" :title="t('选择/拖拽模式')"><i class="fa fa-arrows"></i></button>
          <button class="dc-btn" :class="{ active: connectMode }" @click="toggleConnect" :title="t('连线模式')"><i class="fa fa-share-alt"></i></button>
        </div>
        <select v-model="pendingEdgeType" class="dc-select dc-inline" :title="t('连线类型')">
          <option v-for="et in EDGE_TYPES" :key="et" :value="et">{{ EDGE_TYPE_META[et].label }}</option>
        </select>
        
        <button class="dc-btn" :class="{ active: snapToGrid }" @click="snapToGrid = !snapToGrid" :title="t('吸附网格')"><i class="fa fa-magnet"></i></button>
        <div class="dc-seg">
          <button class="dc-btn" @click="zoomBy(1.2)" :title="t('放大')"><i class="fa fa-search-plus"></i></button>
          <button class="dc-btn" @click="zoomBy(1 / 1.2)" :title="t('缩小')"><i class="fa fa-search-minus"></i></button>
          <button class="dc-btn" @click="resetView" :title="t('重置视图')"><i class="fa fa-home"></i></button>
          <span class="dc-zoom-label">{{ Math.round(view.k * 100) }}%</span>
        </div>
        <button class="dc-btn dc-btn-primary" @click="run" :title="t('重新计算')"><i class="fa fa-play"></i> {{ t('计算') }}</button>
        <template v-if="config.showImportExport">
          <button class="dc-btn" @click="exportModel" :title="t('导出')"><i class="fa fa-download"></i></button>
          <button class="dc-btn" @click="triggerImport" :title="t('导入')"><i class="fa fa-folder-open"></i></button>
        </template>
      </div>
    </div>

    <!-- 数据包导入 input（放在工具栏外，即使 hideToolbar 也始终存在，保证导入可用） -->
    <input type="file" ref="fileInput" accept=".data,.json" style="display:none" @change="handleImportFile" />

    <!-- ====== 主体：调色板 + 画布 + 属性面板 ====== -->
    <div class="dc-canvas-body">
      <!-- 左侧：工程树 / 节点调色板 -->
      <div class="dc-palette">
        <div class="dc-palette-tabs">
          <button class="dc-palette-tab" :class="{ active: paletteTab === 'project' }" @click="paletteTab = 'project'"><i class="fa fa-sitemap"></i> {{ t('工程') }}</button>
          <button class="dc-palette-tab" :class="{ active: paletteTab === 'nodes' }" @click="paletteTab = 'nodes'"><i class="fa fa-cubes"></i> {{ t('节点') }}</button>
        </div>

        <!-- 工程树 -->
        <div v-if="paletteTab === 'project'" class="dc-project-tree">
          <div
            v-for="item in projectTree"
            :key="item.id"
            class="dc-tree-item"
            :class="{ 'is-subcanvas': item.type === 'subcanvas' }"
            :style="{ paddingLeft: item.depth * 14 + 6 + 'px' }"
            @click="onTreeClick(item)"
          >
            <i class="fa" :class="NODE_TYPE_META[item.type].icon" :style="{ color: NODE_TYPE_META[item.type].color }"></i>
            <span v-if="item.type === 'subcanvas'" class="dc-tree-chevron" @click.stop="toggleCollapse(item)"><i class="fa" :class="collapsed.has(item.id) ? 'fa-caret-right' : 'fa-caret-down'"></i></span>
            <span class="dc-tree-name" :title="item.name">{{ item.name }}</span>
          </div>
          <div v-if="!projectTree.length" class="dc-palette-hint">
            <i class="fa fa-info-circle"></i>
            <span>{{ t('画布中暂无节点') }}</span>
          </div>
        </div>

        <!-- 节点调色板 -->
        <template v-else>
          <div
            v-for="nt in NODE_TYPES"
            :key="nt"
            class="dc-palette-item"
            :class="{ disabled: nt === 'subcanvas' && !config.allowSubCanvas }"
            draggable="true"
            @dragstart="onPaletteDrag(nt, $event)"
            @dblclick="addNodeAtCenter(nt)"
          >
            <span class="dc-node-icon" :style="{ background: NODE_TYPE_META[nt].color }"><i class="fa" :class="NODE_TYPE_META[nt].icon"></i></span>
            <span>{{ NODE_TYPE_META[nt].label }}</span>
          </div>
          <div class="dc-palette-hint">
            <i class="fa fa-info-circle"></i>
            <span>{{ t('拖拽到画布或双击添加，双击子画布节点可进入') }}</span>
          </div>
        </template>

        <div v-if="connectMode" class="dc-connect-hint">
          <i class="fa fa-share-alt"></i>
          <span>{{ pendingSource ? t('请点击目标节点') : t('请点击源节点') }}</span>
        </div>
      </div>

      <!-- 画布区域 -->
      <div class="dc-canvas-wrap" ref="wrapRef" @pointerdown="onCanvasPointerDown" @wheel.prevent="onCanvasWheel">
        <div class="dc-canvas-inner" ref="innerRef" :style="innerStyle" @dragover.prevent @drop="onDrop" @click.self="clearSelection" @contextmenu.prevent="openContextMenu">
          <!-- 坐标轴 -->
          <svg class="dc-axis" :width="canvasW" :height="canvasH">
            <line x1="0" y1="0" x2="0" :y2="canvasH" class="dc-axis-line" />
            <line x1="0" y1="0" :x2="canvasW" y2="0" class="dc-axis-line" />
            <text v-for="tx in xTicks" :key="'x' + tx" :x="tx" y="12" class="dc-axis-text">{{ tx }}</text>
            <text v-for="ty in yTicks" :key="'y' + ty" x="8" :y="ty + 4" class="dc-axis-text">{{ ty }}</text>
          </svg>
          <!-- 连线 SVG -->
          <svg class="dc-edges" :width="canvasW" :height="canvasH">
            <defs>
              <marker v-for="et in EDGE_TYPES" :key="et" :id="`dc-arrow-${et}`" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path :d="`M0,0 L8,4 L0,8 z`" :fill="EDGE_TYPE_META[et].color" />
              </marker>
            </defs>
            <path
              v-for="edge in activeModel?.edges || []"
              :key="edge.id"
              :d="edgePath(edge)"
              :stroke="EDGE_TYPE_META[edge.type].color"
              :marker-end="`url(#dc-arrow-${edge.type})`"
              fill="none"
              stroke-width="2"
              class="dc-edge"
              :class="[`edge-type-${edge.type}`, { selected: selectedEdge === edge.id }]"
              @click.stop="selectEdge(edge.id)"
              @dblclick.stop="removeEdge(edge.id)"
            >
              <title>{{ edgeLabel(edge) }}</title>
            </path>
            <!-- 拖拽连线临时线 -->
            <line
              v-if="tempEdge"
              :x1="tempEdge.sx"
              :y1="tempEdge.sy"
              :x2="tempEdge.tx"
              :y2="tempEdge.ty"
              class="dc-edge-temp"
            />
          </svg>

          <!-- 节点 -->
          <div
            v-for="node in activeModel?.nodes || []"
            :key="node.id"
            class="dc-node"
            :class="{ selected: selectedNodeId === node.id, connecting: connectMode }"
            :data-node-id="node.id"
            :style="nodeStyle(node)"
            @pointerdown="onNodePointerDown(node, $event)"
            @dblclick.stop="onNodeDblClick(node)"
            @click.stop="selectNode(node)"
            @contextmenu.stop.prevent="openNodeContextMenu(node, $event)"
          >
            <div class="dc-node-head" :style="{ background: NODE_TYPE_META[node.type].color }">
              <i class="fa" :class="NODE_TYPE_META[node.type].icon"></i>
              <span class="dc-node-name" :title="node.name">{{ node.name }}</span>
              <span v-if="node.type === 'subcanvas'" class="dc-node-depth">{{ depthOf(node) }}</span>
              <span v-else-if="node.type === 'table'" class="dc-node-depth">{{ (node.data.rows || []).length }} {{ t('行') }}</span>
            </div>
            <div class="dc-node-body">
              <div v-if="resultOf(node)?.error" class="dc-node-err"><i class="fa fa-exclamation-triangle"></i> {{ resultOf(node).error }}</div>
              <template v-else-if="node.type === 'parameter'">
                <div v-for="p in (node.data.params || [])" :key="p.key" class="dc-kv"><span>{{ p.key }}</span><em>=</em><b>{{ String(p.value) }}</b></div>
                <div v-if="!node.data.params?.length" class="dc-node-empty">{{ t('无参数') }}</div>
              </template>
              <template v-else-if="node.type === 'table'">
                <div v-for="c in (node.data.columns || [])" :key="c" class="dc-field-row">
                  <span class="dc-field-name" :title="c">{{ c }}</span>
                </div>
                <div v-if="!(node.data.columns || []).length" class="dc-node-empty">{{ t('无字段') }}</div>
              </template>
              <template v-else-if="node.type === 'sql'">
                <div class="dc-var-line">
                  <span class="dc-var-formula" :title="node.data.sql">{{ node.data.sql || t('(空SQL)') }}</span>
                  <span class="dc-var-result" :title="sqlResultText(node)">{{ sqlResultText(node) }}</span>
                </div>
              </template>
              <template v-else-if="node.type === 'variable'">
                <div class="dc-var-line">
                  <span class="dc-var-formula" :title="node.data.formula">{{ node.data.formula || t('(空公式)') }}</span>
                  <span class="dc-var-result" :title="formatResult(resultOf(node))">{{ formatResult(resultOf(node)) }}</span>
                </div>
              </template>
              <template v-else-if="node.type === 'chart'">
                <div class="dc-node-empty"><i class="fa" :class="chartIcon(node.data.chartType)"></i> {{ chartLabel(node.data.chartType) }}</div>
              </template>
              <template v-else-if="node.type === 'subcanvas'">
                <div class="dc-node-empty"><i class="fa fa-cubes"></i> {{ subNodeSummary(node) }}</div>
              </template>
              <div v-if="resultSummary(node)" class="dc-node-result">{{ resultSummary(node) }}</div>
            </div>
            <!-- 输入端口（节点左侧，表格字段端口支持表关联连线） -->
            <div
              v-for="p in inputPorts(node)"
              :key="p.id"
              class="dc-port dc-port-in"
              :data-node-id="node.id"
              :data-field="node.type === 'table' ? p.id : undefined"
              :style="inPortTop(node, p)"
              :title="p.label"
              @pointerdown.stop="onInputPortDown(node, p, $event)"
              @click.stop="onInputPortClick(node, p)"
            ></div>
            <!-- 输出端口（拖拽连线） -->
            <div
              v-for="p in outputPorts(node)"
              :key="p.id"
              class="dc-port dc-port-out"
              :style="{ top: outPortTop(node, p) }"
              :title="p.label"
              @pointerdown.stop="onOutputPortDown(node, p, $event)"
            ></div>
            <!-- 输出端口标签 -->
            <span
              v-for="p in outputPorts(node)"
              :key="'lbl-' + p.id"
              class="dc-port-label"
              :style="{ top: outPortTop(node, p), color: p.color || 'var(--borderColor)' }"
              v-show="p.id !== 'out'"
            >{{ p.label }}</span>
            <!-- 右下角缩放手柄 -->
            <div class="dc-node-resize" @pointerdown.stop="onResizePointerDown(node, $event)" :title="t('拖动调整大小')"></div>
          </div>

          <!-- 连线模式提示 -->
          <div v-if="connectMode && pendingSource" class="dc-connect-tip">{{ t('从') }} “{{ pendingSource.name }}” {{ t('开始连线') }}</div>
        </div>
      </div>

      <!-- 右侧属性面板 -->
      <div class="dc-inspector" v-if="selectedNode" :style="{ width: inspectorWidth + 'px' }">
        <div class="dc-inspector-resize" @pointerdown.stop="onInspectorResizeDown($event)" :title="t('拖动调整宽度')"></div>
        <div class="dc-inspector-head">
          <i class="fa" :class="NODE_TYPE_META[selectedNode.type].icon" :style="{ color: NODE_TYPE_META[selectedNode.type].color }"></i>
          <span>{{ NODE_TYPE_META[selectedNode.type].label }}</span>
          <div class="dc-flex1"></div>
          <span class="dc-xy-badge" :title="t('节点位置')">x:{{ selectedNode.x }} y:{{ selectedNode.y }}</span>
          <button class="dc-btn dc-btn-sm" @click="selectedNode = null"><i class="fa fa-times"></i></button>
        </div>
        <div class="dc-inspector-body">
          <div class="dc-field">
            <label>{{ t('名称') }}</label>
            <input v-model="selectedNode.name" class="dc-input" />
          </div>

          <div v-if="canExposeToParent" class="dc-expose-check">
            <label class="dc-check"><input type="checkbox" :checked="isExposedToParent" @change="toggleExposeToParent" /> {{ t('暴露到外部') }}</label>
          </div>

          <!-- 参数节点 -->
          <template v-if="selectedNode.type === 'parameter'">
            <div class="dc-field" style="flex-direction: column; align-items: stretch; gap: 4px;">
              <label style="flex: 0 0 auto;">{{ t('使用说明') }}</label>
              <textarea v-model="selectedNode.data.description" class="dc-textarea" rows="3" :placeholder="t('描述这个参数组怎么使用（将显示在数据录入界面参数组下方）')" @change="commitSelectedNode"></textarea>
            </div>
            <div class="dc-inspector-title">{{ t('参数列表') }}</div>
            <div v-for="(p, i) in selectedNode.data.params" :key="i" class="dc-param-row">
              <input v-model="p.key" class="dc-input" placeholder="key" />
              <input v-model="p.value" class="dc-input" placeholder="value" />
              <input v-model="p.unit" class="dc-input dc-param-unit-input" :placeholder="t('单位')" :title="t('参数单位')" />
              <select v-model="p.type" class="dc-input">
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="date">date</option>
              </select>
              <button class="dc-btn dc-btn-sm dc-danger" @click="selectedNode.data.params.splice(i, 1)"><i class="fa fa-trash-o"></i></button>
            </div>
            <button class="dc-btn dc-btn-block" @click="selectedNode.data.params.push({ key: '', value: '', type: 'string', unit: '' })"><i class="fa fa-plus"></i> {{ t('添加参数') }}</button>
          </template>

          <!-- 数据表节点 -->
          <template v-if="selectedNode.type === 'table'">
            <div class="dc-field" style="flex-direction: column; align-items: stretch; gap: 4px;">
              <label style="flex: 0 0 auto;">{{ t('使用说明') }}</label>
              <textarea v-model="selectedNode.data.description" class="dc-textarea" rows="3" :placeholder="t('描述这个数据表怎么使用（显示在数据录入界面数据面板上方）')" @change="commitSelectedNode"></textarea>
            </div>
            <div class="dc-field">
              <label class="dc-check dc-form-entry-check" :title="t('表单录入模式：勾选后，数据录入页使用左侧侧边栏 + 表单方式录入')">
                <input type="checkbox" :checked="!!selectedNode.data.formEntry" @change="setFormEntry(selectedNode, $event)" />
                <i class="fa fa-edit"></i>
              </label>
              <button class="dc-btn" @click="triggerTableImport(selectedNode)"><i class="fa fa-file-excel-o"></i> {{ t('导入 Excel') }}</button>
              <button class="dc-btn" @click="copyTableAsMarkdown"><i class="fa fa-copy"></i> {{ t('复制 Markdown') }}</button>
            </div>
            <input type="file" ref="tableFileInput" accept=".xlsx,.xls" style="display:none" @change="handleTableImport" />
            <div class="dc-inspector-title">{{ t('列定义') }}</div>
            <div class="dc-cols-def">
              <div v-for="(c, ci) in selectedNode.data.columns" :key="ci" class="dc-col-def">
                <div class="dc-col-def-row">
                  <input class="dc-input dc-col-name" v-model="selectedNode.data.columns[ci]" @change="commitSelectedNode" :placeholder="t('列名')" :title="c" />
                  <select class="dc-input dc-col-dtype" :value="colType(selectedNode, c)" @change="setColType(selectedNode, c, $event)" :title="t('数据类型')">
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="date">date</option>
                    <option value="boolean">boolean</option>
                  </select>
                  <label class="dc-check dc-col-title-check" :class="{ on: isTitleField(selectedNode, c) }" :title="t('设为数据标题字段（互斥，用于录入侧边栏记录标题）')">
                    <input type="checkbox" :checked="isTitleField(selectedNode, c)" @change="setTitleField(selectedNode, c, $event)" />
                    <i class="fa fa-header"></i>
                  </label>
                  <select class="dc-input dc-col-inputtype" :value="columnInputType(selectedNode, c)" @change="setColumnInputType(selectedNode, c, $event)" :title="t('录入方式')">
                    <option v-for="it in COLUMN_INPUT_TYPES" :key="it.value" :value="it.value">{{ it.label }}</option>
                  </select>
                  <input class="dc-input dc-col-unit" :value="columnUnit(selectedNode, c)" @input="setColumnUnit(selectedNode, c, $event)" :placeholder="t('单位')" :title="t('列单位（图表中显示）')" />
                  <button class="dc-btn dc-btn-sm dc-danger" @click="removeColumn(Number(ci))"><i class="fa fa-trash-o"></i></button>
                </div>
                <div v-if="columnInputType(selectedNode, c) === 'select'" class="dc-col-def-options">
                  <input class="dc-input" :value="columnInputOptions(selectedNode, c)" @input="setColumnInputOptions(selectedNode, c, $event)" :placeholder="t('选项，用逗号分隔，如：A,B,C')" />
                </div>
              </div>
              <div v-if="!selectedNode.data.columns?.length" class="dc-hint">{{ t('暂无列，可点击下方「添加列」或导入 Excel') }}</div>
            </div>
            <button class="dc-btn dc-btn-block" @click="addColumn"><i class="fa fa-plus"></i> {{ t('添加列') }}</button>
            <div class="dc-inspector-title">{{ t('数据行') }} ({{ selectedNode.data.rows.length }})</div>
            <div class="dc-table-edit">
              <table>
                <thead>
                  <tr><th>#</th><th v-for="c in selectedNode.data.columns" :key="c">{{ c }}</th><th></th></tr>
                </thead>
                <tbody>
                  <tr v-for="(row, ri) in selectedNode.data.rows" :key="ri">
                    <td>{{ Number(ri) + 1 }}</td>
                    <td v-for="c in selectedNode.data.columns" :key="c">
                      <input class="dc-input dc-cell" :value="row[c]" @input="onCellInput(row, c, $event)" />
                    </td>
                    <td><button class="dc-btn dc-btn-sm dc-danger" @click="selectedNode.data.rows.splice(ri, 1)"><i class="fa fa-times"></i></button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <button class="dc-btn dc-btn-block" @click="addRow"><i class="fa fa-plus"></i> {{ t('添加行') }}</button>
          </template>

          <!-- SQL 节点 -->
          <template v-if="selectedNode.type === 'sql'">
            <div class="dc-inspector-title">{{ t('自然语言生成 SQL') }}</div>
            <textarea v-model="selectedNode.data.nl" class="dc-textarea" rows="3" :placeholder="t('用自然语言描述查询需求，如：统计每个部门的平均工资')" @change="commitSelectedNode"></textarea>
            <button class="dc-btn dc-btn-block dc-btn-primary" @click="generateSql" :disabled="generatingSql">
              <i class="fa" :class="generatingSql ? 'fa-spinner fa-spin' : 'fa-magic'"></i> {{ generatingSql ? t('生成中...') : t('生成 SQL') }}
            </button>
            <div class="dc-inspector-title">{{ t('SQL 语句') }}</div>
            <textarea v-model="selectedNode.data.sql" class="dc-textarea" rows="6" spellcheck="false" @change="commitSelectedNode"></textarea>
            <div class="dc-field" style="margin-top:4px">
              <button class="dc-btn" @click="sqlShowResult = true"><i class="fa fa-play"></i> {{ t('测试') }}</button>
              <div class="dc-flex1"></div>
              <span v-if="sqlTestResult && sqlTestResult.error" class="dc-sql-status error" :title="sqlTestResult.error"><i class="fa fa-times-circle"></i></span>
              <span v-else-if="sqlTestResult" class="dc-sql-status ok"><i class="fa fa-check-circle"></i></span>
            </div>
            <div class="dc-result-box" v-if="sqlShowResult && sqlTestResult">
              <template v-if="sqlTestResult.error">
                <div class="dc-sql-error"><i class="fa fa-exclamation-triangle"></i> {{ sqlTestResult.error }}</div>
              </template>
              <template v-else>
                <div>{{ t('查询结果') }}: {{ sqlTestResult.rows?.length || 0 }} {{ t('行') }}</div>
                <div class="dc-sql-preview" v-if="sqlTestResult.rows?.length">
                  <table>
                    <thead><tr><th v-for="c in sqlTestResult.columns" :key="c">{{ c }}</th></tr></thead>
                    <tbody>
                      <tr v-for="(row, ri) in sqlTestResult.rows.slice(0, 5)" :key="ri">
                        <td v-for="c in sqlTestResult.columns" :key="c">{{ String(row[c]) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
            </div>
            <div class="dc-hint"><i class="fa fa-info-circle"></i> {{ t('可用输入表') }}: {{ incomingTableNames.join(', ') || t('（无）') }}<br />{{ t('支持 SELECT/WHERE/GROUP BY/ORDER BY/LIMIT/JOIN') }}</div>
          </template>

          <!-- 变量节点 -->
          <template v-if="selectedNode.type === 'variable'">
            <div class="dc-field">
              <label class="dc-check dc-form-entry-check" :title="t('勾选后该变量显示在主页（看板）中；取消则不显示')">
                <input type="checkbox" v-model="selectedNode.data.showInDashboard" @change="commitSelectedNode" />
                {{ t('在主页显示') }}
              </label>
            </div>
            <div class="dc-field">
              <label>{{ t('单位') }}</label>
              <input v-model="selectedNode.data.unit" class="dc-input" :placeholder="t('单位（主页数值卡片显示在数值后）')" @change="commitSelectedNode" />
            </div>
            <div class="dc-inspector-title">{{ t('计算公式') }}</div>
            <textarea v-model="selectedNode.data.formula" class="dc-textarea" rows="6" spellcheck="false" placeholder="例如：a * 1.1 + SUM(b)"></textarea>
            <div class="dc-hint"><i class="fa fa-info-circle"></i> {{ t('可用输入变量') }}: {{ incomingVarNames.join(', ') || t('（无）') }}<br />{{ t('支持 + - * / 与 SUM/AVG/MIN/MAX/COUNT 等') }}</div>
            <div class="dc-result-box" v-if="resultOf(selectedNode)">
              {{ t('结果') }}: <b>{{ formatResult(resultOf(selectedNode)) }}</b>
            </div>
          </template>

          <!-- 图表节点 -->
          <template v-if="selectedNode.type === 'chart'">
            <div class="dc-field">
              <label>{{ t('图表类型') }}</label>
              <select v-model="selectedNode.data.chartType" class="dc-input" @change="commitSelectedNode">
                <option value="bar">柱状图</option>
                <option value="line">折线图</option>
                <option value="pie">饼图</option>
                <option value="map">地图</option>
              </select>
            </div>
            <div class="dc-field">
              <label>{{ t('标题') }}</label>
              <input v-model="selectedNode.data.title" class="dc-input" @change="commitSelectedNode" />
            </div>
            <div class="dc-field">
              <label class="dc-check dc-form-entry-check" :title="t('勾选后该图表显示在主页（看板）中；取消则不显示')">
                <input type="checkbox" v-model="selectedNode.data.showInDashboard" @change="commitSelectedNode" />
                {{ t('在主页显示') }}
              </label>
            </div>
            <!-- 地图：经度/纬度/数值（点大小）/标签字段 -->
            <template v-if="selectedNode.data.chartType === 'map'">
              <div class="dc-field">
                <label>{{ t('经度字段') }}</label>
                <select v-model="selectedNode.data.lngField" class="dc-input" @change="commitSelectedNode">
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="dc-field">
                <label>{{ t('纬度字段') }}</label>
                <select v-model="selectedNode.data.latField" class="dc-input" @change="commitSelectedNode">
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="dc-field">
                <label>{{ t('数值字段') }}</label>
                <select v-model="selectedNode.data.valueField" class="dc-input" @change="commitSelectedNode">
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="dc-field">
                <label>{{ t('标记名称') }}</label>
                <select v-model="selectedNode.data.labelField" class="dc-input" @change="commitSelectedNode">
                  <option value="">{{ t('（不显示名称）') }}</option>
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <!-- GeoJSON 数据（可选，优先于字段点渲染；随画布数据包保存） -->
              <div class="dc-field" style="flex-direction: column; align-items: stretch; gap: 4px;">
                <label style="flex: 0 0 auto;">{{ t('GeoJSON 数据') }}</label>
                <div class="dc-row2">
                  <input type="file" ref="geojsonFileInput" accept=".geojson,.json" style="display:none" @change="handleGeojsonImport" />
                  <button class="dc-btn dc-btn-sm" @click="triggerGeojsonImport"><i class="fa fa-upload"></i> {{ t('导入 GeoJSON') }}</button>
                  <button v-if="selectedNode.data.geojson" class="dc-btn dc-btn-sm" @click="clearGeojson"><i class="fa fa-times"></i> {{ t('清除') }}</button>
                </div>
                <div v-if="selectedNode.data.geojson" class="dc-hint">
                  <i class="fa fa-check"></i> {{ geojsonLabel }}（{{ geojsonFeatureCount(selectedNode.data.geojson) }} 个要素）
                </div>
              </div>
              <!-- 显示样式：GeoJSON 填充/边界颜色 + 数据点样式/颜色 -->
              <div class="dc-field dc-color-field">
                <label>{{ t('GeoJSON 填充') }}</label>
                <input type="color" :value="selectedNode.data.geojsonFill || '#2196F3'" @input="setMapColor('geojsonFill', $event)" :title="t('省份面填充颜色')" />
              </div>
              <div class="dc-field dc-color-field">
                <label>{{ t('GeoJSON 边界') }}</label>
                <input type="color" :value="selectedNode.data.geojsonStroke || '#4FC3F7'" @input="setMapColor('geojsonStroke', $event)" :title="t('省份边界线颜色')" />
              </div>
              <div class="dc-field">
                <label>{{ t('数据点样式') }}</label>
                <select v-model="selectedNode.data.mapPointStyle" class="dc-input" @change="commitSelectedNode">
                  <option v-if="!selectedNode.data.mapPointStyle" value="circle">{{ t('圆形气泡（默认）') }}</option>
                  <option value="circle">{{ t('圆形气泡') }}</option>
                  <option value="bar">{{ t('柱状柱') }}</option>
                  <option value="gradient">{{ t('分级配色') }}</option>
                  <option value="diamond">{{ t('菱形') }}</option>
                </select>
              </div>
              <div class="dc-field dc-color-field">
                <label>{{ t('数据点颜色') }}</label>
                <input type="color" :value="selectedNode.data.mapPointColor || '#2196F3'" @input="setMapColor('mapPointColor', $event)" :title="t('流入数据标记颜色')" />
              </div>
              <!-- 透明度滑杆 -->
              <div class="dc-field dc-opacity-field">
                <label>{{ t('填充透明度') }}</label>
                <input type="range" min="0" max="100" :value="Math.round((selectedNode.data.geojsonFillOpacity ?? 0.45) * 100)" @input="setMapOpacity('geojsonFillOpacity', $event)" />
                <span class="dc-opacity-val">{{ Math.round((selectedNode.data.geojsonFillOpacity ?? 0.45) * 100) }}%</span>
              </div>
              <div class="dc-field dc-opacity-field">
                <label>{{ t('边界透明度') }}</label>
                <input type="range" min="0" max="100" :value="Math.round((selectedNode.data.geojsonStrokeOpacity ?? 1) * 100)" @input="setMapOpacity('geojsonStrokeOpacity', $event)" />
                <span class="dc-opacity-val">{{ Math.round((selectedNode.data.geojsonStrokeOpacity ?? 1) * 100) }}%</span>
              </div>
              <div class="dc-field dc-opacity-field">
                <label>{{ t('数据点透明度') }}</label>
                <input type="range" min="0" max="100" :value="Math.round(mapPointOpacityDisplay * 100)" @input="setMapOpacity('mapPointOpacity', $event)" />
                <span class="dc-opacity-val">{{ Math.round(mapPointOpacityDisplay * 100) }}%</span>
              </div>
            </template>
            <!-- 柱状图/折线图：X 字段=标签，Y 字段=数值 -->
            <template v-else-if="selectedNode.data.chartType !== 'pie'">
              <div class="dc-field">
                <label>{{ t('X 字段（标签）') }}</label>
                <select v-model="selectedNode.data.xField" class="dc-input" @change="commitSelectedNode">
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="dc-field">
                <label>{{ t('Y 字段（数值）') }}</label>
                <select v-model="selectedNode.data.yField" class="dc-input" @change="commitSelectedNode">
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
            </template>
            <!-- 饼图：标签/数值字段 -->
            <template v-else>
              <div class="dc-field">
                <label>{{ t('标签字段') }}</label>
                <select v-model="selectedNode.data.labelField" class="dc-input" @change="commitSelectedNode">
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="dc-field">
                <label>{{ t('数值字段') }}</label>
                <select v-model="selectedNode.data.valueField" class="dc-input" @change="commitSelectedNode">
                  <option v-for="c in chartSourceColumns" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
            </template>
            <div class="dc-hint"><i class="fa fa-info-circle"></i> {{ t('单条连线（表格/SQL）：用字段作为标签与数值；多条连线（参数/变量数值）：按端口名自动生成类别') }}</div>
            <div class="dc-inspector-title">{{ t('图表预览') }}</div>
            <div class="dc-chart-preview">
              <div v-if="!chartMiniData(selectedNode).length" class="dc-chart-preview-empty">{{ t('暂无数据，请连接数据源') }}</div>
              <template v-else-if="selectedNode.data.chartType === 'map'">
                <div class="dc-chart-preview-map">
                  <div
                    v-for="(d, i) in chartMiniData(selectedNode)"
                    :key="i"
                    class="dc-preview-map-dot"
                    :style="{ width: mapDotSize(selectedNode, d.value) + 'px', height: mapDotSize(selectedNode, d.value) + 'px' }"
                    :title="String(d.label) + ': ' + d.value"
                  ></div>
                </div>
                <div class="dc-hint">{{ t('地图气泡预览') }}：{{ chartMiniData(selectedNode).length }} {{ t('个点') }}</div>
              </template>
              <template v-else-if="selectedNode.data.chartType !== 'pie'">
                <svg class="dc-chart-preview-svg" viewBox="0 0 100 48" preserveAspectRatio="none">
                  <template v-if="selectedNode.data.chartType === 'line'">
                    <polyline :points="miniLinePoints(selectedNode)" fill="none" stroke="#E91E63" stroke-width="1.5" />
                  </template>
                  <template v-else>
                    <rect
                      v-for="(d, i) in chartMiniData(selectedNode)"
                      :key="i"
                      :x="miniBarX(selectedNode, i)"
                      :y="miniBarY(selectedNode, d)"
                      :width="miniBarW(selectedNode)"
                      :height="miniBarH(selectedNode, d)"
                      fill="#2196F3"
                    />
                  </template>
                  <text v-for="(d, i) in chartMiniData(selectedNode)" :key="'t' + i" :x="miniLabelX(selectedNode, i)" y="46" text-anchor="middle" class="dc-preview-label">{{ d.label }}</text>
                </svg>
              </template>
              <div v-else class="dc-chart-preview-pie-wrap">
                <div class="dc-chart-preview-pie" :style="{ background: conicGradient(chartMiniData(selectedNode)) }"></div>
                <div class="dc-chart-preview-legend">
                  <div v-for="(d, i) in chartMiniData(selectedNode)" :key="i" class="dc-preview-legend-item">
                    <span class="dc-preview-legend-dot" :style="{ background: pieColor(i) }"></span>
                    <span class="dc-preview-legend-label" :title="String(d.label)">{{ d.label }}</span>
                    <span class="dc-preview-legend-value">{{ d.value }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- 子画布节点 -->
          <template v-if="selectedNode.type === 'subcanvas'">
            <div class="dc-field">
              <button class="dc-btn dc-btn-block dc-btn-primary" @click="openSubCanvas(selectedNode)"><i class="fa fa-cubes"></i> {{ t('打开子画布') }}</button>
            </div>
            <div class="dc-inspector-title">{{ t('暴露端口（供父层连线）') }}</div>
            <div v-if="subModelNodes(selectedNode).length" class="dc-expose-list">
              <div v-for="sn in subModelNodes(selectedNode)" :key="sn.id" class="dc-expose-row">
                <i class="fa" :class="NODE_TYPE_META[sn.type].icon" :style="{ color: NODE_TYPE_META[sn.type].color }"></i>
                <span class="dc-expose-name">{{ sn.name }}</span>
                <input v-model="sn.exposeName" class="dc-input dc-sm" :placeholder="sn.name" @change="syncExpose(selectedNode, sn)" />
                <button
                  class="dc-btn dc-btn-sm"
                  :class="{ active: isExposed(selectedNode, sn.id) }"
                  @click="toggleExpose(selectedNode, sn)"
                >
                  <i class="fa" :class="isExposed(selectedNode, sn.id) ? 'fa-check' : 'fa-plus'"></i>
                </button>
              </div>
            </div>
            <div v-else class="dc-hint">{{ t('子画布中尚无节点') }}</div>
          </template>
        </div>
      </div>

      <!-- 空白占位提示 -->
      <div v-else-if="!selectedNode && !activeModel?.nodes?.length" class="dc-inspector dc-inspector-empty" :style="{ width: inspectorWidth + 'px' }">
        <i class="fa fa-object-group"></i>
        <span>{{ t('从左侧拖入节点开始建模') }}</span>
      </div>
    </div>

    <!-- 右键菜单：节点操作（删除/复制）或空白新建/粘贴 -->
    <div v-if="ctxMenu.visible" class="dc-ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
      <template v-if="ctxMenu.nodeId">
        <div class="dc-ctx-item" @click="ctxDeleteNode"><i class="fa fa-trash-o"></i> {{ t('删除节点') }}</div>
        <div class="dc-ctx-item" @click="ctxCopyNode"><i class="fa fa-copy"></i> {{ t('复制节点') }}</div>
        <template v-if="isCtxSubcanvas">
          <div class="dc-ctx-sep"></div>
          <div class="dc-ctx-item" @click="ctxImportSubcanvasData"><i class="fa fa-folder-open"></i> {{ t('导入子画布数据') }}</div>
          <div class="dc-ctx-item" @click="ctxExportSubcanvasData"><i class="fa fa-download"></i> {{ t('导出子画布数据') }}</div>
        </template>
      </template>
      <template v-else>
        <div v-if="copiedNode" class="dc-ctx-item" @click="ctxPasteNode"><i class="fa fa-clipboard"></i> {{ t('粘贴节点') }}</div>
        <div v-if="copiedNode" class="dc-ctx-sep"></div>
        <div class="dc-ctx-item" @click="ctxAddNode('parameter')"><i class="fa fa-cog"></i> {{ t('参数节点') }}</div>
        <div class="dc-ctx-item" @click="ctxAddNode('table')"><i class="fa fa-table"></i> {{ t('数据表') }}</div>
        <div class="dc-ctx-item" @click="ctxAddNode('sql')"><i class="fa fa-code"></i> {{ t('SQL节点') }}</div>
        <div class="dc-ctx-item" @click="ctxAddNode('variable')"><i class="fa fa-refresh"></i> {{ t('变量节点') }}</div>
        <div class="dc-ctx-item" @click="ctxAddNode('chart')"><i class="fa fa-line-chart"></i> {{ t('图表节点') }}</div>
        <div v-if="config.allowSubCanvas" class="dc-ctx-item" @click="ctxAddNode('subcanvas')"><i class="fa fa-cubes"></i> {{ t('子画布') }}</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { useDataCanvas } from '@/components/DataCanvas/store'
import { usestore } from '@/store'
import { computeModel, type ComputeResults } from '@/components/DataCanvas/compute'
import { parseExcelFile, parseExcelSheets } from '@/components/DataCanvas/excel'
import {
  createNode, uid, NODE_TYPES, EDGE_TYPES, NODE_TYPE_META, EDGE_TYPE_META, COLUMN_INPUT_TYPES,
  type NodeType, type DcNode, type DcEdge, type Model,
} from '@/components/DataCanvas/types'

const store = useDataCanvas()
const config = store.config

// 宿主 store（用于调用 AI 生成 SQL）
const hostStore = usestore()

// hideToolbar：工具栏由宿主模块提升到标签栏右侧渲染时，隐藏本视图内工具栏
const props = withDefaults(defineProps<{ hideToolbar?: boolean }>(), { hideToolbar: false })

// 保存事件（由 DataCanvasModule 处理：持久化 + 通知宿主）
const emit = defineEmits<{ (e: 'save'): void }>()
function handleSave() {
  store.persist()
  emit('save')
}

// ==================== 国际化（跟随宿主 store，这里简单兼容） ====================
const isEn = ref(false)
function t(zh: string): string {
  return isEn.value ? zh : zh // 保持中文，宿主可扩展
}

// ==================== 状态 ====================
const activeModel = computed(() => store.activeModel.value)
const wrapRef = ref<HTMLElement | null>(null)
const innerRef = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const selectedNodeId = ref<string | null>(null)
const selectedEdgeId = ref<string | null>(null)
const connectMode = ref(false)
const pendingSourceId = ref<string | null>(null)
const pendingSourcePortId = ref<string | null>(null)
const pendingEdgeType = ref<DcEdge['type']>('dataflow')
const ctxMenu = ref<{ visible: boolean; x: number; y: number; nodeId: string | null }>({ visible: false, x: 0, y: 0, nodeId: null })
// 右键位置（相对画布 wrap 的客户端坐标，供粘贴换算画布坐标）
const ctxPos = ref({ cx: 0, cy: 0 })
const paletteTab = ref<'project' | 'nodes'>('project')
const collapsed = ref<Set<string>>(new Set())

// 视图变换（平移 + 缩放）
const view = reactive({ x: 0, y: 0, k: 1 })
// 属性面板宽度（可拖动调整）
const inspectorWidth = ref(300)
// 吸附网格
const snapToGrid = ref(false)
const GRID = 20

const selectedNode = computed<DcNode | null>(() => {
  if (!selectedNodeId.value) return null
  return activeModel.value?.nodes.find((n) => n.id === selectedNodeId.value) ?? null
})
const pendingSource = computed<DcNode | null>(() => {
  if (!pendingSourceId.value) return null
  return activeModel.value?.nodes.find((n) => n.id === pendingSourceId.value) ?? null
})
const selectedEdge = computed<string | null>(() => selectedEdgeId.value)

// 计算画布尺寸（随内容增长）
const canvasW = ref(2000)
const canvasH = ref(1500)
const innerStyle = computed(() => ({
  width: canvasW.value + 'px',
  height: canvasH.value + 'px',
  transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
}))

// 客户端坐标 → 画布坐标（考虑平移缩放）
function toCanvas(clientX: number, clientY: number): { x: number; y: number } {
  const wrap = wrapRef.value
  if (!wrap) return { x: 0, y: 0 }
  const rect = wrap.getBoundingClientRect()
  return {
    x: (clientX - rect.left - view.x) / view.k,
    y: (clientY - rect.top - view.y) / view.k,
  }
}

// 坐标轴刻度
const xTicks = computed(() => {
  const arr: number[] = []
  for (let v = 100; v < canvasW.value; v += 100) arr.push(v)
  return arr
})
const yTicks = computed(() => {
  const arr: number[] = []
  for (let v = 100; v < canvasH.value; v += 100) arr.push(v)
  return arr
})

// 面包屑
const crumbPath = computed(() => store.pathNames())

// 计算引擎
const computeResults = computed<ComputeResults>(() => computeModel(activeModel.value, store.models.value))

function resultOf(node: DcNode): any {
  return computeResults.value[node.id]
}

function resultSummary(node: DcNode): string {
  const r = resultOf(node)
  if (!r) return ''
  if (r.error) return ''
  if (r.type === 'value') return ''
  if (r.type === 'chart') return r.source ? `${r.source.rows.length} ${isEn.value ? 'rows' : '行'}` : ''
  if (r.type === 'subcanvas') return ''
  return ''
}

function formatResult(r: any): string {
  if (!r) return '-'
  if (r.type === 'value') return String(r.value)
  if (r.error) return r.error
  return JSON.stringify(r).slice(0, 80)
}

// ==================== 节点样式 / 端口 ====================
// 数据表/参数/子画布节点最小高度：按字段/参数/暴露端口数量增长，避免端口溢出到节点外侧；其他节点保持原有高度
function minNodeHeight(node: DcNode): number {
  const head = NODE_HEAD_H + BODY_PAD
  if (node.type === 'table') {
    return Math.max(NODE_TYPE_META.table.height, head + BODY_PAD + (node.data.columns || []).length * PARAM_ROW_H)
  }
  if (node.type === 'parameter') {
    return Math.max(NODE_TYPE_META.parameter.height, head + BODY_PAD + (node.data.params || []).length * PARAM_ROW_H)
  }
  if (node.type === 'subcanvas') {
    return Math.max(NODE_TYPE_META.subcanvas.height, head + BODY_PAD + (node.data.exposed || []).length * PARAM_ROW_H)
  }
  return node.height
}
// 实际显示宽/高（考虑内容驱动的最小高度）
function nodeW(node: DcNode): number {
  return node.width
}
function nodeH(node: DcNode): number {
  return Math.max(node.height, minNodeHeight(node))
}
function nodeStyle(node: DcNode): Record<string, string> {
  return {
    left: node.x + 'px',
    top: node.y + 'px',
    width: nodeW(node) + 'px',
    height: nodeH(node) + 'px',
  }
}

function nodeCenter(node: DcNode): { x: number; y: number } {
  return { x: node.x + nodeW(node) / 2, y: node.y + nodeH(node) / 2 }
}

// ==================== 端口定义 ====================
interface DcPortDef {
  id: string
  label: string
  side: 'in' | 'out'
  color?: string
}

// 输入端口：参数节点/子画布无需输入；数据表节点每个字段一个输入端口（用于表关联连线）
function inputPorts(node: DcNode): DcPortDef[] {
  if (node.type === 'parameter' || node.type === 'subcanvas') return []
  if (node.type === 'table') {
    return (node.data.columns || []).map((c: string) => ({
      id: String(c),
      label: String(c),
      side: 'in' as const,
      color: NODE_TYPE_META.table.color,
    }))
  }
  return [{ id: 'in', label: '输入', side: 'in' }]
}

// 输出端口：参数节点按参数、表节点按列生成多个端口
function outputPorts(node: DcNode): DcPortDef[] {
  // 参数节点：输出端口数量与参数严格对应（无参数时无输出端口）
  if (node.type === 'parameter') {
    const ps = node.data.params || []
    return ps.map((p: any, i: number) => {
      const id = p.key ? String(p.key) : `param_${i}`
      return { id, label: String(p.key || `参数${i + 1}`), side: 'out' as const }
    })
  }
  // 数据表节点：仅单个输出（通过 SQL 节点计算）
  if (node.type === 'table') {
    return [{ id: 'out', label: '输出', side: 'out' }]
  }
  // 子画布：输出端口数量与内部暴露节点严格对应（无暴露时无输出端口）；
  // 参数节点按参数数量展开为多个端口（端口 id = nodeId:paramKey，标签预览 key = value）
  if (node.type === 'subcanvas') {
    const exposed = node.data.exposed || []
    const sub = store.getSubModel(node)
    const defs: DcPortDef[] = []
    for (const e of exposed) {
      const inner = sub?.nodes.find((n) => n.id === e.nodeId)
      if (inner?.type === 'parameter') {
        const ps = inner.data.params || []
        for (const p of ps) {
          defs.push({
            id: `${e.nodeId}:${p.key || ''}`,
            label: `${p.key || '?'} = ${String(p.value ?? '')}`,
            side: 'out' as const,
            color: NODE_TYPE_META.parameter.color,
          })
        }
      } else {
        defs.push({
          id: String(e.nodeId),
          label: String(e.name || e.nodeId),
          side: 'out' as const,
          color: inner ? NODE_TYPE_META[inner.type].color : undefined,
        })
      }
    }
    return defs
  }
  return [{ id: 'out', label: '输出', side: 'out' }]
}

const NODE_HEAD_H = 24
const BODY_PAD = 4
const PARAM_ROW_H = 18
// 参数节点：端口与参数行对齐（头部 + 内边距 + 行序号*行高 + 行高/2）
function paramPortYRel(node: DcNode, portId: string): number | null {
  const ps = node.data.params || []
  const idx = ps.findIndex((p: any, i: number) => (p.key ? String(p.key) === portId : `param_${i}` === portId))
  if (idx < 0) return null
  return NODE_HEAD_H + BODY_PAD + idx * PARAM_ROW_H + PARAM_ROW_H / 2
}
// 数据表节点：字段端口与字段行对齐（头部 + 内边距 + 行序号*行高 + 行高/2）
function tableFieldYRel(node: DcNode, portId: string): number | null {
  const cols = node.data.columns || []
  const idx = cols.indexOf(portId)
  if (idx < 0) return null
  return NODE_HEAD_H + BODY_PAD + idx * PARAM_ROW_H + PARAM_ROW_H / 2
}
// 输入端口 top 定位（数据表字段端口按行对齐，其他默认 50%）
function inPortTop(node: DcNode, p: DcPortDef): Record<string, string> {
  if (node.type === 'table') {
    const y = tableFieldYRel(node, p.id)
    if (y !== null) return { top: `${Math.round(y)}px` }
  }
  return {}
}
// 子画布：输出端口从上到下顺序排布（固定行高，不随高度拉伸）
function subPortYRel(node: DcNode, idx: number): number {
  return NODE_HEAD_H + BODY_PAD + idx * PARAM_ROW_H + PARAM_ROW_H / 2
}
// 通用多端口：按节点高度均分（兜底）
function portYRel(node: DcNode, idx: number, count: number): number {
  const h = nodeH(node)
  const bodyH = Math.max(h - NODE_HEAD_H, 20)
  return NODE_HEAD_H + (bodyH * (idx + 1)) / (count + 1)
}
const VAR_ROW_H = 18
// 变量/SQL 节点：单行内容，端口与该行对齐
function isLineNode(node: DcNode): boolean {
  return node.type === 'variable' || node.type === 'sql'
}
function lineRowYRel(node: DcNode): number {
  return NODE_HEAD_H + BODY_PAD + VAR_ROW_H / 2
}
function outPortTop(node: DcNode, p: DcPortDef): string {
  if (isLineNode(node)) return `${Math.round(lineRowYRel(node))}px`
  if (node.type === 'parameter') {
    const y = paramPortYRel(node, p.id)
    if (y !== null) return `${Math.round(y)}px`
  }
  if (node.type === 'subcanvas') {
    const ports = outputPorts(node)
    const idx = ports.findIndex((x) => x.id === p.id)
    if (idx >= 0) return `${Math.round(subPortYRel(node, idx))}px`
  }
  const ports = outputPorts(node)
  if (ports.length <= 1) return '50%'
  const idx = ports.findIndex((x) => x.id === p.id)
  if (idx < 0) return '50%'
  return `${Math.round(portYRel(node, idx, ports.length))}px`
}
function sourcePortY(node: DcNode, portId: string): number {
  if (isLineNode(node)) return node.y + lineRowYRel(node)
  if (node.type === 'parameter') {
    const y = paramPortYRel(node, portId)
    if (y !== null) return node.y + y
  }
  if (node.type === 'subcanvas') {
    const ports = outputPorts(node)
    const idx = ports.findIndex((p) => p.id === portId)
    if (idx >= 0) return node.y + subPortYRel(node, idx)
  }
  if (node.type === 'table') {
    const y = tableFieldYRel(node, portId)
    if (y !== null) return node.y + y
  }
  const ports = outputPorts(node)
  if (ports.length <= 1) return node.y + nodeH(node) / 2
  const idx = ports.findIndex((p) => p.id === portId)
  if (idx < 0) return node.y + nodeH(node) / 2
  return node.y + portYRel(node, idx, ports.length)
}

function edgePath(edge: DcEdge): string {
  const model = activeModel.value
  if (!model) return ''
  // 源/目标端口 id 可能含冒号（子画布参数端口 nodeId:paramKey），只拆第一段冒号
  const sIdx = edge.source.indexOf(':')
  const srcId = sIdx >= 0 ? edge.source.slice(0, sIdx) : edge.source
  const srcPort = sIdx >= 0 ? edge.source.slice(sIdx + 1) : undefined
  const tIdx = edge.target.indexOf(':')
  const tgtId = tIdx >= 0 ? edge.target.slice(0, tIdx) : edge.target
  const tgtPort = tIdx >= 0 ? edge.target.slice(tIdx + 1) : undefined
  const src = model.nodes.find((n) => n.id === srcId)
  const tgt = model.nodes.find((n) => n.id === tgtId)
  if (!src || !tgt) return ''
  // 表关联连线：源从字段端口（左侧）出发，目标到字段端口（左侧）
  const isRelation = edge.type === 'relation'
  const sx = isRelation ? src.x : src.x + nodeW(src)
  const sy = isRelation
    ? (src.y + (tableFieldYRel(src, srcPort || '') ?? nodeH(src) / 2))
    : sourcePortY(src, srcPort || 'out')
  // 终点：目标节点输入端口（左侧，表关联对齐字段行）
  const tx = tgt.x
  const ty = isRelation
    ? (tgt.y + (tableFieldYRel(tgt, tgtPort || '') ?? nodeH(tgt) / 2))
    : tgt.y + nodeH(tgt) / 2
  if (isRelation) {
    // 表关联：两端都在左侧，控制点从各自端口向左水平延伸，形成平滑 S 形曲线
    const dx = Math.max(48, Math.abs(tx - sx) / 2)
    return `M ${sx} ${sy} C ${sx - dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
  }
  const mx = (sx + tx) / 2
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`
}

function edgeLabel(edge: DcEdge): string {
  return `${EDGE_TYPE_META[edge.type].label}: ${edge.source} → ${edge.target}`
}

// ==================== 节点拖拽 ====================
let dragState: { node: DcNode; dx: number; dy: number } | null = null

function onNodePointerDown(node: DcNode, e: PointerEvent) {
  if (connectMode.value) {
    startConnect(node)
    return
  }
  selectNode(node)
  const c = toCanvas(e.clientX, e.clientY)
  dragState = { node, dx: c.x - node.x, dy: c.y - node.y }
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  } catch {
    // 捕获失败时仍通过 window 监听器拖拽
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  e.preventDefault()
  e.stopPropagation()
}

function onPointerMove(e: PointerEvent) {
  if (!dragState) return
  const { node, dx, dy } = dragState
  const c = toCanvas(e.clientX, e.clientY)
  let nx = Math.max(0, Math.round(c.x - dx))
  let ny = Math.max(0, Math.round(c.y - dy))
  // 吸附网格
  if (snapToGrid.value) {
    nx = Math.round(nx / GRID) * GRID
    ny = Math.round(ny / GRID) * GRID
  }
  node.x = nx
  node.y = ny
  // 扩展画布（使用实际显示尺寸）
  if (nx + nodeW(node) > canvasW.value) canvasW.value = Math.max(canvasW.value, nx + nodeW(node) + 200)
  if (ny + nodeH(node) > canvasH.value) canvasH.value = Math.max(canvasH.value, ny + nodeH(node) + 200)
}

function onPointerUp() {
  if (dragState) {
    const moved = dragState.node
    dragState = null
    // 提交位置变化（触发一次持久化+通知）
    store.updateNode(moved.id, { x: moved.x, y: moved.y })
  }
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
}

// ==================== 画布平移（拖拽空白处）与缩放 ====================
let panState: { startX: number; startY: number; originX: number; originY: number } | null = null

function onCanvasPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  panState = {
    startX: e.clientX,
    startY: e.clientY,
    originX: view.x,
    originY: view.y,
  }
  window.addEventListener('pointermove', onPanMove)
  window.addEventListener('pointerup', onPanUp)
  e.preventDefault()
}
function onPanMove(e: PointerEvent) {
  if (!panState) return
  view.x = panState.originX + (e.clientX - panState.startX)
  view.y = panState.originY + (e.clientY - panState.startY)
}
function onPanUp() {
  panState = null
  window.removeEventListener('pointermove', onPanMove)
  window.removeEventListener('pointerup', onPanUp)
}

// 缩放（以指针/视口中心为锚点，不限于左上角）
const MIN_ZOOM = 0.2
const MAX_ZOOM = 3
function zoomAt(clientX: number, clientY: number, factor: number) {
  const wrap = wrapRef.value
  if (!wrap) return
  const rect = wrap.getBoundingClientRect()
  const px = clientX - rect.left
  const py = clientY - rect.top
  const newK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor))
  const ratio = newK / view.k
  view.x = px - (px - view.x) * ratio
  view.y = py - (py - view.y) * ratio
  view.k = newK
}
function zoomBy(factor: number) {
  const wrap = wrapRef.value
  if (!wrap) return
  zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, factor)
}
function onCanvasWheel(e: WheelEvent) {
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
  zoomAt(e.clientX, e.clientY, factor)
}
function resetView() {
  view.x = 0
  view.y = 0
  view.k = 1
}

// ==================== 节点缩放（右下角手柄） ====================
const MIN_NODE_W = 120
const MIN_NODE_H = 50
let resizeState: { node: DcNode; startW: number; startH: number; startX: number; startY: number } | null = null

function onResizePointerDown(node: DcNode, e: PointerEvent) {
  e.stopPropagation()
  e.preventDefault()
  resizeState = { node, startW: node.width, startH: node.height, startX: e.clientX, startY: e.clientY }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeUp)
}
function onResizeMove(e: PointerEvent) {
  if (!resizeState) return
  const { node, startW, startH, startX, startY } = resizeState
  let w = Math.max(MIN_NODE_W, Math.round(startW + (e.clientX - startX) / view.k))
  let h = Math.max(MIN_NODE_H, Math.round(startH + (e.clientY - startY) / view.k))
  // 吸附网格：缩放尺寸也按网格对齐
  if (snapToGrid.value) {
    w = Math.round(w / GRID) * GRID
    h = Math.round(h / GRID) * GRID
  }
  node.width = w
  node.height = h
}
function onResizeUp() {
  if (resizeState) {
    const n = resizeState.node
    resizeState = null
    store.updateNode(n.id, { width: n.width, height: n.height })
  }
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeUp)
}

// ==================== 属性面板宽度拖拽 ====================
let inspectorResizeState: { startX: number; startW: number } | null = null
function onInspectorResizeDown(e: PointerEvent) {
  e.preventDefault()
  inspectorResizeState = { startX: e.clientX, startW: inspectorWidth.value }
  window.addEventListener('pointermove', onInspectorResizeMove)
  window.addEventListener('pointerup', onInspectorResizeUp)
}
function onInspectorResizeMove(e: PointerEvent) {
  if (!inspectorResizeState) return
  inspectorWidth.value = Math.max(220, Math.min(520, inspectorResizeState.startW - (e.clientX - inspectorResizeState.startX)))
}
function onInspectorResizeUp() {
  inspectorResizeState = null
  window.removeEventListener('pointermove', onInspectorResizeMove)
  window.removeEventListener('pointerup', onInspectorResizeUp)
}

// ==================== 选择 / 连线 ====================
function selectNode(node: DcNode) {
  selectedNodeId.value = node.id
  selectedEdgeId.value = null
}
function clearSelection() {
  selectedNodeId.value = null
  selectedEdgeId.value = null
}
function selectEdge(id: string) {
  selectedEdgeId.value = id
  selectedNodeId.value = null
}
function removeEdge(id: string) {
  store.removeEdge(id)
  if (selectedEdgeId.value === id) selectedEdgeId.value = null
}

function toggleConnect() {
  connectMode.value = !connectMode.value
  pendingSourceId.value = null
  pendingSourcePortId.value = null
  if (connectMode.value) selectedNodeId.value = null
}

function startConnect(node: DcNode) {
  if (!connectMode.value) {
    // 端口点击自动进入连线模式
    connectMode.value = true
  }
  if (!pendingSourceId.value) {
    pendingSourceId.value = node.id
    // 表关联连线：源为表格节点时默认使用第一个字段端口
    if (pendingEdgeType.value === 'relation' && node.type === 'table') {
      pendingSourcePortId.value = String((node.data.columns || [])[0] ?? '')
    } else {
      pendingSourcePortId.value = null // 默认输出端口
    }
  } else if (pendingSourceId.value !== node.id) {
    finishConnect(node)
  }
}

// 输入端口按下：数据表字段端口可拖拽连线（表关联）；其他输入端口仅点击完成
function onInputPortDown(node: DcNode, p: DcPortDef, e: PointerEvent) {
  if (node.type !== 'table') return
  e.stopPropagation()
  e.preventDefault()
  connectMode.value = true
  pendingSourceId.value = node.id
  pendingSourcePortId.value = p.id
  selectedNodeId.value = null
  const start = toCanvas(e.clientX, e.clientY)
  const y = tableFieldYRel(node, p.id) ?? nodeH(node) / 2
  tempEdge.value = { sx: node.x, sy: node.y + y, tx: start.x, ty: start.y }
  window.addEventListener('pointermove', onPortDragMove)
  window.addEventListener('pointerup', onPortDragUp)
}

// 输入端口点击：完成连线（在已有源时）
function onInputPortClick(node: DcNode, p: DcPortDef) {
  if (pendingSourceId.value && pendingSourceId.value !== node.id) {
    finishConnect(node, p.id)
  }
}

// 拖拽连线临时线（画布坐标）
const tempEdge = ref<{ sx: number; sy: number; tx: number; ty: number } | null>(null)

// 输出端口按下：开始拖拽连线
function onOutputPortDown(node: DcNode, port: DcPortDef, e: PointerEvent) {
  connectMode.value = true
  pendingSourceId.value = node.id
  pendingSourcePortId.value = port.id
  selectedNodeId.value = null
  const start = toCanvas(e.clientX, e.clientY)
  tempEdge.value = { sx: node.x + nodeW(node), sy: sourcePortY(node, port.id), tx: start.x, ty: start.y }
  window.addEventListener('pointermove', onPortDragMove)
  window.addEventListener('pointerup', onPortDragUp)
  e.preventDefault()
  e.stopPropagation()
}
function onPortDragMove(e: PointerEvent) {
  if (!tempEdge.value) return
  const c = toCanvas(e.clientX, e.clientY)
  tempEdge.value.tx = c.x
  tempEdge.value.ty = c.y
}
function onPortDragUp(e: PointerEvent) {
  // 判断落点是否为节点（或表格字段端口）
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  const nodeEl = el?.closest('.dc-node') as HTMLElement | null
  const nodeId = nodeEl?.getAttribute('data-node-id')
  const portEl = el?.closest('.dc-port[data-field]') as HTMLElement | null
  const field = portEl?.getAttribute('data-field') || undefined
  const target = nodeId ? activeModel.value?.nodes.find((n) => n.id === nodeId) : null
  window.removeEventListener('pointermove', onPortDragMove)
  window.removeEventListener('pointerup', onPortDragUp)
  tempEdge.value = null
  if (target && pendingSourceId.value && pendingSourceId.value !== target.id) {
    // 表关联连线：目标为表格节点时，若未精确命中字段端口，按落点 y 就近选择字段端口
    if (pendingEdgeType.value === 'relation' && target.type === 'table' && !field) {
      const c = toCanvas(e.clientX, e.clientY)
      const field2 = nearestTableField(target, c.y)
      if (field2) {
        finishConnect(target, field2)
      } else {
        pendingSourceId.value = null
        pendingSourcePortId.value = null
      }
    } else {
      finishConnect(target, field)
    }
  } else {
    pendingSourceId.value = null
    pendingSourcePortId.value = null
  }
  connectMode.value = false
}

// 根据落点 y 坐标就近选择表格字段端口
function nearestTableField(node: DcNode, canvasY: number): string | undefined {
  const cols = node.data.columns || []
  let best: string | undefined
  let bestDist = Infinity
  for (const c of cols) {
    const y = node.y + (tableFieldYRel(node, String(c)) ?? nodeH(node) / 2)
    const d = Math.abs(y - canvasY)
    if (d < bestDist) {
      bestDist = d
      best = String(c)
    }
  }
  return best
}

function finishConnect(target: DcNode, targetField?: string) {
  const srcId = pendingSourceId.value
  const srcPort = pendingSourcePortId.value
  pendingSourceId.value = null
  pendingSourcePortId.value = null
  if (!srcId || !activeModel.value) return
  const src = activeModel.value.nodes.find((n) => n.id === srcId)
  if (!src || src.id === target.id) return
  let source = srcId
  let targetId = target.id
  if (pendingEdgeType.value === 'relation') {
    // 表关联：源/目标都必须精确到表格字段端口（编码 nodeId:field）
    if (src.type === 'table' && srcPort) {
      source = `${srcId}:${srcPort}`
    } else {
      ElMessage.warning('表关联连线必须从数据表的字段端口出发')
      return
    }
    if (target.type === 'table' && targetField) {
      targetId = `${target.id}:${targetField}`
    } else {
      ElMessage.warning('表关联连线必须连接到数据表的字段端口')
      return
    }
  } else if (srcPort && srcPort !== 'out') {
    // 多端口（参数 key/子画布内部节点端口）：编码为 nodeId:portId
    source = `${srcId}:${srcPort}`
  }
  store.addEdge({
    id: uid('e'),
    type: pendingEdgeType.value,
    source,
    target: targetId,
  })
}

// ==================== 子画布 ====================
function depthOf(node: DcNode): number {
  const sub = store.getSubModel(node)
  return sub?.hierarchy.depth ?? 1
}
function onNodeDblClick(node: DcNode) {
  if (node.type === 'subcanvas') {
    openSubCanvas(node)
    return
  }
  // 其他节点双击：选中并聚焦属性面板
  selectNode(node)
}
function openSubCanvas(node: DcNode) {
  if (!config.allowSubCanvas) return
  if (depthOf(node) >= (config.maxDepth || 5)) return
  store.ensureSubModel(node)
  store.navigateTo(node.data.modelId)
  selectedNodeId.value = null
}
function subNodeSummary(node: DcNode): string {
  const sub = store.getSubModel(node)
  if (!sub) return '0 ' + t('节点')
  return `${sub.nodes.length} ${t('节点')}`
}

// ==================== 子画布暴露端口 ====================
interface SubNodeVM extends DcNode {
  exposeName?: string
}
function subModelNodes(node: DcNode): SubNodeVM[] {
  const sub = store.getSubModel(node)
  if (!sub) return []
  const exposed = node.data.exposed || []
  return sub.nodes.map((n) => {
    const ex = exposed.find((e: any) => e.nodeId === n.id)
    return { ...n, exposeName: ex?.name || '' }
  })
}
function isExposed(node: DcNode, nodeId: string): boolean {
  return (node.data.exposed || []).some((e: any) => e.nodeId === nodeId)
}
function toggleExpose(node: DcNode, sn: SubNodeVM) {
  const exposed = node.data.exposed || []
  const idx = exposed.findIndex((e: any) => e.nodeId === sn.id)
  if (idx >= 0) exposed.splice(idx, 1)
  else exposed.push({ nodeId: sn.id, name: sn.exposeName || sn.name })
  store.updateNode(node.id, { data: { ...node.data, exposed } })
}
function syncExpose(node: DcNode, sn: SubNodeVM) {
  const exposed = node.data.exposed || []
  const e = exposed.find((x: any) => x.nodeId === sn.id)
  if (e) e.name = sn.exposeName || sn.name
  store.updateNode(node.id, { data: { ...node.data, exposed } })
}

// ==================== 节点「暴露到外部」（子画布内节点 → 父层端口） ====================
const canExposeToParent = computed(() => !!selectedNodeId.value && !!store.getParentSubCanvasNode())
const isExposedToParent = computed(() => {
  const parentSub = store.getParentSubCanvasNode()
  if (!parentSub) return false
  return (parentSub.data.exposed || []).some((e: any) => e.nodeId === selectedNodeId.value)
})
function toggleExposeToParent() {
  const parentSub = store.getParentSubCanvasNode()
  const node = selectedNode.value
  if (!parentSub || !node) return
  const exposed = parentSub.data.exposed || []
  const idx = exposed.findIndex((e: any) => e.nodeId === node.id)
  if (idx >= 0) exposed.splice(idx, 1)
  else exposed.push({ nodeId: node.id, name: node.name })
  store.updateNode(parentSub.id, { data: { ...parentSub.data, exposed } })
}

// ==================== 输入提示 ====================
function incomingNodes(node: DcNode): DcNode[] {
  const model = activeModel.value
  if (!model) return []
  return model.edges
    .filter((e) => e.target === node.id && e.type === 'dataflow')
    .map((e) => model.nodes.find((n) => n.id === e.source.split(':')[0]))
    .filter(Boolean) as DcNode[]
}
const incomingTableNames = computed(() => {
  const node = selectedNode.value
  const model = activeModel.value
  const names = incomingNodes(node || ({} as DcNode)).map((n) => n.name)
  // 表关联（relation）连线涉及的表也作为可用来源
  if (model) {
    for (const e of model.edges) {
      if (e.type !== 'relation') continue
      const src = model.nodes.find((n) => n.id === e.source.split(':')[0])
      const tgt = model.nodes.find((n) => n.id === e.target.split(':')[0])
      if (src && src.type === 'table') names.push(src.name)
      if (tgt && tgt.type === 'table') names.push(tgt.name)
    }
  }
  return [...new Set(names)]
})
// 可用输入变量名（多端口连接时显示端口名；参数节点整表连接时显示各参数 key）
const incomingVarNames = computed(() => {
  const node = selectedNode.value
  const model = activeModel.value
  if (!node || !model) return []
  const names: string[] = []
  for (const e of model.edges) {
    if (e.target !== node.id || e.type !== 'dataflow') continue
    const [srcId, portId] = e.source.split(':')
    const src = model.nodes.find((n) => n.id === srcId)
    if (!src) continue
    if (src.type === 'parameter') {
      if (portId) {
        names.push(portId)
      } else {
        for (const p of src.data.params || []) {
          if (p.key) names.push(String(p.key))
        }
      }
    } else {
      names.push(portId ? String(portId).split(':').pop() || src.name : src.name)
    }
  }
  return names
})

// ==================== SQL 节点：自然语言生成 + 测试 ====================
const sqlShowResult = ref(false)
const generatingSql = ref(false)

// SQL 节点计算结果（供测试显示）
const sqlTestResult = computed(() => {
  const node = selectedNode.value
  if (!node || node.type !== 'sql') return null
  return resultOf(node) || null
})
// SQL 节点结果文本（节点体上显示）
function sqlResultText(node: DcNode): string {
  const r = resultOf(node)
  if (!r) return ''
  if (r.error) return t('错误')
  if (r.type === 'table') return `${r.rows.length} ${isEn.value ? 'rows' : '行'}`
  return ''
}
// 图表节点上游数据表的列（供 X/Y 字段选择）
const chartSourceColumns = computed(() => {
  const node = selectedNode.value
  const model = activeModel.value
  if (!node || node.type !== 'chart' || !model) return []
  const cols: string[] = []
  const pushNodeCols = (src: DcNode) => {
    if (src.type === 'table') cols.push(...(src.data.columns || []))
    else if (src.type === 'sql') {
      const r = resultOf(src)
      if (r?.columns) cols.push(...r.columns)
    } else if (src.type === 'subcanvas') {
      const sub = store.getSubModel(src)
      if (sub) {
        for (const sn of sub.nodes) {
          if (sn.type === 'table') cols.push(...(sn.data.columns || []))
          else if (sn.type === 'sql') {
            const r2 = resultOf(sn)
            if (r2?.columns) cols.push(...r2.columns)
          }
        }
      }
    }
  }
  for (const e of model.edges) {
    if (e.target !== node.id || e.type !== 'dataflow') continue
    const src = model.nodes.find((n) => n.id === e.source.split(':')[0])
    if (!src) continue
    pushNodeCols(src)
  }
  return [...new Set(cols)]
})

// 收集 SQL 节点连接的数据表信息（含子画布暴露的表节点 + 表关联连线涉及的表）
function incomingTablesForSql(): { name: string; columns: string[]; rows: number }[] {
  const node = selectedNode.value
  const model = activeModel.value
  if (!node || !model) return []
  const out: { name: string; columns: string[]; rows: number }[] = []
  const pushTable = (n: DcNode, prefix = '') => {
    if (n.type !== 'table') return
    out.push({ name: prefix ? `${prefix}.${n.name}` : n.name, columns: (n.data.columns || []) as string[], rows: (n.data.rows || []).length })
  }
  for (const e of model.edges) {
    if (e.target !== node.id || e.type !== 'dataflow') continue
    const src = model.nodes.find((n) => n.id === e.source.split(':')[0])
    if (!src) continue
    if (src.type === 'table') {
      pushTable(src)
    } else if (src.type === 'subcanvas') {
      const sub = store.getSubModel(src)
      if (sub) {
        for (const n of sub.nodes) pushTable(n, src.name)
      }
    }
  }
  // 表关联（relation）连线涉及的表：作为多表联查的可用来源
  for (const e of model.edges) {
    if (e.type !== 'relation') continue
    const src = model.nodes.find((n) => n.id === e.source.split(':')[0])
    const tgt = model.nodes.find((n) => n.id === e.target.split(':')[0])
    if (src) pushTable(src)
    if (tgt) pushTable(tgt)
  }
  // 去重（同一表可能同时被 dataflow 与 relation 引用）
  const seen = new Set<string>()
  return out.filter((t) => {
    if (seen.has(t.name)) return false
    seen.add(t.name)
    return true
  })
}

// 收集表关联（relation）连线：主外键关系描述（用于注入 SQL 生成上下文）
function relationDescriptionsForSql(): string[] {
  const node = selectedNode.value
  const model = activeModel.value
  if (!node || !model) return []
  const nameOf = (id: string) => model.nodes.find((n) => n.id === id)?.name || id
  const fieldOf = (ref: string) => {
    const idx = ref.indexOf(':')
    return idx >= 0 ? ref.slice(idx + 1) : ''
  }
  const out: string[] = []
  for (const e of model.edges) {
    if (e.type !== 'relation') continue
    const srcF = fieldOf(e.source)
    const tgtF = fieldOf(e.target)
    if (!srcF || !tgtF) continue
    out.push(`${nameOf(e.source.split(':')[0])}.${srcF} = ${nameOf(e.target.split(':')[0])}.${tgtF}`)
  }
  return out
}

function extractSql(text: string): string {
  const block = (text || '').trim().match(/```(?:sql)?\s*([\s\S]*?)```/i)
  if (block) return block[1].trim()
  return (text || '').trim().replace(/^```(?:sql)?\s*/i, '').replace(/\s*```\s*$/i, '')
}

async function generateSql() {
  const node = selectedNode.value
  if (!node) return
  const nl = (node.data.nl || '').trim()
  if (!nl) {
    ElMessage.warning('请先输入自然语言描述')
    return
  }
  if (!hostStore.AIconfig?.llm?.online) {
    ElMessage.warning('AI 服务未连接，请先检查 AI 配置')
    return
  }
  const tables = incomingTablesForSql()
  const rels = relationDescriptionsForSql()
  const schemaText = tables.length
    ? tables.map((t) => `- ${t.name}（字段：${t.columns.join(', ') || '无'}，${t.rows} 行）`).join('\n')
    : '（无输入表）'
  const relText = rels.length
    ? `\n表关联关系（主外键，多表联查时作为 JOIN ON 条件）：\n${rels.map((r) => `- ${r}`).join('\n')}`
    : ''
  const system = '你是一个 SQL 专家。请根据给定的数据表结构，将用户的自然语言需求转换为一条可执行的 SQL 查询语句。'
  const prompt = `现有数据表结构：\n${schemaText}${relText}\n\n用户需求：\n${nl}\n\n生成要求：\n1. 只输出 SQL 语句本身，不要任何解释、注释或 markdown 代码块\n2. 必须使用上述表名和字段名\n3. 支持 SELECT/WHERE/GROUP BY/ORDER BY/LIMIT/JOIN\n4. 多表查询时，JOIN ON 条件必须采用上面给出的表关联关系（如 a.字段 = b.字段）\n5. 列名含特殊字符时使用反引号包裹`
  generatingSql.value = true
  try {
    const content = await hostStore.sendToAI([
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ])
    node.data.sql = extractSql(content)
    store.updateNode(node.id, { data: { ...node.data } })
  } catch (err: any) {
    ElMessage.error('SQL 生成失败: ' + (err?.message || String(err)))
  } finally {
    generatingSql.value = false
  }
}

// ==================== 调色板 / 拖放 ====================
function onPaletteDrag(type: NodeType, e: DragEvent) {
  if (type === 'subcanvas' && !config.allowSubCanvas) {
    e.preventDefault()
    return
  }
  e.dataTransfer?.setData('application/dc-node-type', type)
}
function addNodeAtCenter(type: NodeType) {
  if (type === 'subcanvas' && !config.allowSubCanvas) return
  const x = Math.max(20, Math.round(canvasW.value / 2 - NODE_TYPE_META[type].width / 2))
  const y = Math.max(20, Math.round(canvasH.value / 2 - NODE_TYPE_META[type].height / 2))
  store.addNode(createNode(type, x, y))
}
function onDrop(e: DragEvent) {
  // 文件拖放：.xlsx/.xls → 多 sheet 数据表节点；.data 数据包 → 作为子画布节点导入
  const files = e.dataTransfer?.files
  if (files?.length) {
    const f = files[0]
    if (/\.(xlsx|xls)$/i.test(f.name)) {
      importExcelAsTables(f, e)
    } else {
      importDataAsSubcanvas(f, e)
    }
    return
  }
  const type = e.dataTransfer?.getData('application/dc-node-type') as NodeType
  if (!type || !NODE_TYPES.includes(type)) return
  if (type === 'subcanvas' && !config.allowSubCanvas) return
  const c = toCanvas(e.clientX, e.clientY)
  const x = Math.max(0, Math.round(c.x - NODE_TYPE_META[type].width / 2))
  const y = Math.max(0, Math.round(c.y - NODE_TYPE_META[type].height / 2))
  store.addNode(createNode(type, x, y))
}

// 将 .data 数据包导入为子画布节点（拖拽到画布时）
async function importDataAsSubcanvas(file: File, e: DragEvent) {
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    const srcModels: Model[] = Array.isArray(data.models) ? data.models : data.model ? [data.model] : []
    if (!srcModels.length) {
      ElMessage.warning('文件不是有效的数据包')
      return
    }
    // 根模型：data.activeModelId 或第一个
    const root = srcModels.find((m) => m.id === data.activeModelId) || srcModels[0]
    const c = toCanvas(e.clientX, e.clientY)
    const x = Math.max(0, Math.round(c.x - NODE_TYPE_META.subcanvas.width / 2))
    const y = Math.max(0, Math.round(c.y - NODE_TYPE_META.subcanvas.height / 2))
    const node = createNode('subcanvas', x, y)
    node.name = root.name
    const idMap = new Map<string, string>()
    idMap.set(root.id, node.id)
    const newModelId = uid('m')
    node.data.modelId = newModelId
    cloneModelTree(srcModels, root.id, newModelId, idMap, activeModel.value?.id ?? '', (root as any).hierarchy?.depth ?? 0, store.models.value)
    // 重映射暴露端口 nodeId（根模型本身无 exposed，但安全处理）
    const exposed = node.data.exposed || []
    node.data.exposed = exposed.map((ex: any) => ({ ...ex, nodeId: idMap.get(ex.nodeId) || ex.nodeId }))
    store.addNode(node)
    selectedNodeId.value = node.id
    ElMessage.success('已导入为子画布节点')
  } catch (err: any) {
    ElMessage.error('数据包导入失败: ' + (err?.message || String(err)))
  }
}

// 拖入 Excel 文件：解析所有 sheet，每个 sheet 生成一个数据表节点（重名加序号）
async function importExcelAsTables(file: File, e: DragEvent) {
  try {
    const sheets = await parseExcelSheets(file)
    if (!sheets.length) {
      ElMessage.warning('Excel 文件中没有可导入的工作表')
      return
    }
    const model = activeModel.value
    if (!model) return
    // 已占用名称：当前画布已有节点名 + 本次导入已用名
    const used = new Set(model.nodes.map((n) => n.name))
    const c = toCanvas(e.clientX, e.clientY)
    const stepX = NODE_TYPE_META.table.width + 20
    const stepY = NODE_TYPE_META.table.height + 24
    const cols = Math.max(1, Math.ceil(Math.sqrt(sheets.length)))
    sheets.forEach((s, i) => {
      const name = uniqueNodeName(s.name, used)
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = Math.max(0, Math.round(c.x - NODE_TYPE_META.table.width / 2) + col * stepX)
      const y = Math.max(0, Math.round(c.y - NODE_TYPE_META.table.height / 2) + row * stepY)
      const node = createNode('table', x, y, name)
      node.data.columns = s.columns
      node.data.rows = s.rows
      store.addNode(node)
    })
    selectedNodeId.value = null
    ElMessage.success(`已导入 ${sheets.length} 个数据表`)
  } catch (err: any) {
    ElMessage.error('Excel 导入失败: ' + (err?.message || String(err)))
  }
}

// 生成不重复的节点名（重名时追加序号，如 Sheet1、Sheet1-2）
function uniqueNodeName(base: string, used: Set<string>): string {
  const trimmed = (base || 'Sheet').trim()
  if (!used.has(trimmed)) {
    used.add(trimmed)
    return trimmed
  }
  let i = 2
  while (used.has(`${trimmed}-${i}`)) i++
  const name = `${trimmed}-${i}`
  used.add(name)
  return name
}

// ==================== 右键菜单 ====================
// 剪贴板：复制的节点（含子画布模型快照）
const copiedNode = ref<DcNode | null>(null)
const pendingSubcanvasNodeId = ref<string | null>(null)
const ctxNode = computed(() => {
  const id = ctxMenu.value.nodeId
  return activeModel.value?.nodes.find((n) => n.id === id) ?? null
})
const isCtxSubcanvas = computed(() => ctxNode.value?.type === 'subcanvas')

function openContextMenu(e: MouseEvent) {
  const root = (e.currentTarget as HTMLElement)?.closest('.dc-canvas-view') as HTMLElement | null
  const rect = root?.getBoundingClientRect()
  if (!rect) return
  ctxMenu.value = { visible: true, x: e.clientX - rect.left, y: e.clientY - rect.top, nodeId: null }
  const wrap = wrapRef.value
  if (wrap) {
    const wr = wrap.getBoundingClientRect()
    ctxPos.value = { cx: e.clientX - wr.left, cy: e.clientY - wr.top }
  }
  attachCtxClose()
}
function openNodeContextMenu(node: DcNode, e: MouseEvent) {
  selectNode(node)
  const root = (e.currentTarget as HTMLElement)?.closest('.dc-canvas-view') as HTMLElement | null
  const rect = root?.getBoundingClientRect()
  if (!rect) return
  ctxMenu.value = { visible: true, x: e.clientX - rect.left, y: e.clientY - rect.top, nodeId: node.id }
  const wrap = wrapRef.value
  if (wrap) {
    const wr = wrap.getBoundingClientRect()
    ctxPos.value = { cx: e.clientX - wr.left, cy: e.clientY - wr.top }
  }
  attachCtxClose()
}
function attachCtxClose() {
  window.removeEventListener('pointerdown', closeCtxOnOutside)
  window.addEventListener('pointerdown', closeCtxOnOutside)
}
function closeCtxOnOutside(e: PointerEvent) {
  // 点击菜单内部不关闭（保证菜单项 click 能触发）；点击外部才关闭
  const target = e.target as HTMLElement | null
  if (target?.closest('.dc-ctx-menu')) return
  ctxMenu.value.visible = false
  window.removeEventListener('pointerdown', closeCtxOnOutside)
}
function ctxAddNode(type: NodeType) {
  ctxMenu.value.visible = false
  window.removeEventListener('pointerdown', closeCtxOnOutside)
  const x = Math.max(0, ctxMenu.value.x - NODE_TYPE_META[type].width / 2)
  const y = Math.max(0, ctxMenu.value.y - 20)
  store.addNode(createNode(type, x, y))
}
// 删除节点（连同其子画布模型）
function ctxDeleteNode() {
  const id = ctxMenu.value.nodeId
  ctxMenu.value.visible = false
  window.removeEventListener('pointerdown', closeCtxOnOutside)
  if (!id) return
  store.removeNode(id)
  if (selectedNodeId.value === id) selectedNodeId.value = null
  ElMessage.success('已删除节点')
}
function ctxImportSubcanvasData() {
  const node = ctxNode.value
  if (!node || node.type !== 'subcanvas') return
  ctxMenu.value.visible = false
  window.removeEventListener('pointerdown', closeCtxOnOutside)
  pendingSubcanvasNodeId.value = node.id
  fileInput.value?.click()
}
function ctxExportSubcanvasData() {
  const node = ctxNode.value
  if (!node || node.type !== 'subcanvas') return
  ctxMenu.value.visible = false
  window.removeEventListener('pointerdown', closeCtxOnOutside)
  exportSubcanvasData(node)
}
// 复制节点：深拷贝节点 + 子画布模型快照
function ctxCopyNode() {
  const id = ctxMenu.value.nodeId
  const node = activeModel.value?.nodes.find((n) => n.id === id)
  ctxMenu.value.visible = false
  window.removeEventListener('pointerdown', closeCtxOnOutside)
  if (!node) return
  copiedNode.value = deepCloneNode(node)
  ElMessage.success('已复制节点，可在空白处右键粘贴')
}
// 粘贴节点：在右键位置创建副本
function ctxPasteNode() {
  ctxMenu.value.visible = false
  window.removeEventListener('pointerdown', closeCtxOnOutside)
  const src = copiedNode.value
  if (!src) return
  // 右键位置（相对画布 wrap）→ 画布坐标
  const cx = (ctxPos.value.cx - view.x) / view.k
  const cy = (ctxPos.value.cy - view.y) / view.k
  const node = pasteNodeAt(src, cx, cy)
  if (node) {
    selectedNodeId.value = node.id
    ElMessage.success('已粘贴节点')
  }
}

// 深拷贝节点（普通对象，避免响应式代理）
function deepCloneNode<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

// 在指定画布坐标创建节点副本（含子画布模型递归复制）
function pasteNodeAt(src: DcNode, x: number, y: number): DcNode | null {
  const model = activeModel.value
  if (!model) return null
  const copy = deepCloneNode(src)
  copy.id = uid('node')
  copy.x = Math.max(0, Math.round(x - copy.width / 2))
  copy.y = Math.max(0, Math.round(y - copy.height / 2))
  copy.name = src.name + ' 副本'
  // 子画布：复制整个模型树（新 id 映射）
  if (copy.type === 'subcanvas' && src.data.modelId) {
    const idMap = new Map<string, string>()
    idMap.set(src.id, copy.id)
    const newModelId = uid('m')
    copy.data.modelId = newModelId
    cloneModelTree(store.models.value, src.data.modelId, newModelId, idMap, model.id, (src as any).hierarchy?.depth ?? 0, store.models.value)
    // 重映射暴露端口的 nodeId
    const exposed = copy.data.exposed || []
    copy.data.exposed = exposed.map((e: any) => ({ ...e, nodeId: idMap.get(e.nodeId) || e.nodeId }))
    // 重映射暴露端口的 name 保持不变
  }
  store.addNode(copy)
  return copy
}

// 递归复制模型树（源模型列表 + 目标模型列表分离，用于粘贴或外部 .data 导入为子画布）
function cloneModelTree(
  srcModels: Model[],
  srcModelId: string,
  newModelId: string,
  idMap: Map<string, string>,
  parentId: string,
  depth: number,
  targetModels: Model[],
) {
  const srcModel = srcModels.find((m) => m.id === srcModelId)
  if (!srcModel) return
  const nodes: DcNode[] = []
  for (const n of srcModel.nodes) {
    const cn = deepCloneNode(n)
    cn.id = uid('node')
    idMap.set(n.id, cn.id)
    if (cn.type === 'subcanvas' && n.data.modelId) {
      const childModelId = uid('m')
      cn.data.modelId = childModelId
      cloneModelTree(srcModels, n.data.modelId, childModelId, idMap, newModelId, (n as any).hierarchy?.depth ?? depth + 1, targetModels)
      // 子画布内部暴露端口重映射
      const exposed = cn.data.exposed || []
      cn.data.exposed = exposed.map((e: any) => ({ ...e, nodeId: idMap.get(e.nodeId) || e.nodeId }))
    }
    nodes.push(cn)
  }
  // 重映射连线（源/目标节点 id）
  const edges: DcEdge[] = srcModel.edges.map((e) => {
    const ce = deepCloneNode(e)
    ce.id = uid('e')
    const [srcId, srcPort] = splitEdgeSource(e.source)
    const [tgtId, tgtPort] = splitEdgeSource(e.target)
    ce.source = (idMap.get(srcId) || srcId) + (srcPort ? `:${srcPort}` : '')
    ce.target = (idMap.get(tgtId) || tgtId) + (tgtPort ? `:${tgtPort}` : '')
    return ce
  })
  const newModel: Model = {
    id: newModelId,
    name: srcModel.name,
    nodes,
    edges,
    hierarchy: { parentId, depth: depth + 1 },
    meta: srcModel.meta ? deepCloneNode(srcModel.meta) : undefined,
    updatedAt: Date.now(),
  }
  targetModels.push(newModel)
}

// 拆分连线源：nodeId 或 nodeId:portId（端口 id 可能含冒号）
function splitEdgeSource(source: string): [string, string | undefined] {
  const idx = source.indexOf(':')
  return idx >= 0 ? [source.slice(0, idx), source.slice(idx + 1)] : [source, undefined]
}

// ==================== 表格节点编辑 ====================
function addColumn() {
  const n = selectedNode.value
  if (!n) return
  const name = `col${(n.data.columns || []).length + 1}`
  n.data.columns.push(name)
  if (!n.data.columnTypes) n.data.columnTypes = {}
  n.data.columnTypes[name] = 'string'
  if (!n.data.columnInputs) n.data.columnInputs = {}
  n.data.columnInputs[name] = { type: 'text', options: [], optionsText: '' }
  if (!n.data.columnUnits) n.data.columnUnits = {}
  n.data.rows.forEach((r: any) => { r[name] = '' })
  commitSelectedNode()
}
function addRow() {
  const n = selectedNode.value
  if (!n) return
  const row: Record<string, any> = {}
  ;(n.data.columns || []).forEach((c: string) => { row[c] = '' })
  n.data.rows.push(row)
  commitSelectedNode()
}
function onCellInput(row: Record<string, any>, col: string, e: Event) {
  row[col] = (e.target as HTMLInputElement).value
  commitSelectedNode()
}
// 列类型
function colType(node: DcNode, col: string): string {
  return node.data.columnTypes?.[col] || 'string'
}
function setColType(node: DcNode, col: string, e: Event) {
  if (!node.data.columnTypes) node.data.columnTypes = {}
  node.data.columnTypes[col] = (e.target as HTMLSelectElement).value
  commitSelectedNode()
}
// 列单位（图表中数值显示单位）
function columnUnit(node: DcNode, col: string): string {
  return node.data.columnUnits?.[col] || ''
}
function setColumnUnit(node: DcNode, col: string, e: Event) {
  if (!node.data.columnUnits) node.data.columnUnits = {}
  node.data.columnUnits[col] = (e.target as HTMLInputElement).value
  commitSelectedNode()
}
function removeColumn(ci: number) {
  const n = selectedNode.value
  if (!n) return
  const col = n.data.columns[ci]
  n.data.columns.splice(ci, 1)
  if (col && n.data.columnTypes) delete n.data.columnTypes[col]
  if (col && n.data.columnInputs) delete n.data.columnInputs[col]
  if (col && n.data.columnUnits) delete n.data.columnUnits[col]
  if (col && n.data.titleField === col) n.data.titleField = ''
  n.data.rows.forEach((r: any) => { delete r[col] })
  commitSelectedNode()
}
function commitSelectedNode() {
  const n = selectedNode.value
  if (!n) return
  store.updateNode(n.id, { data: { ...n.data } })
}

// ==================== 表单录入模式 / 列录入方式 ====================
// 表单录入模式开关
function setFormEntry(node: DcNode, e: Event) {
  node.data.formEntry = !!(e.target as HTMLInputElement).checked
  commitSelectedNode()
}
// 标题字段：互斥单选（勾选当前列时自动取消其他列）
function isTitleField(node: DcNode, col: string): boolean {
  return node.data.titleField === col
}
function setTitleField(node: DcNode, col: string, e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  node.data.titleField = checked ? col : (node.data.titleField === col ? '' : node.data.titleField)
  commitSelectedNode()
}
// 列录入方式
function columnInputType(node: DcNode, col: string): string {
  return node.data.columnInputs?.[col]?.type || 'text'
}
function setColumnInputType(node: DcNode, col: string, e: Event) {
  if (!node.data.columnInputs) node.data.columnInputs = {}
  if (!node.data.columnInputs[col]) node.data.columnInputs[col] = { type: 'text', options: [], optionsText: '' }
  node.data.columnInputs[col].type = (e.target as HTMLSelectElement).value
  commitSelectedNode()
}
// 列选项（录入方式=选项 时编辑，逗号分隔文本 + 解析后的数组）
function columnInputOptions(node: DcNode, col: string): string {
  const cfg = node.data.columnInputs?.[col]
  if (cfg?.optionsText !== undefined) return cfg.optionsText
  return (cfg?.options || []).join(',')
}
function setColumnInputOptions(node: DcNode, col: string, e: Event) {
  if (!node.data.columnInputs) node.data.columnInputs = {}
  if (!node.data.columnInputs[col]) node.data.columnInputs[col] = { type: 'text', options: [], optionsText: '' }
  const text = (e.target as HTMLInputElement).value
  node.data.columnInputs[col].optionsText = text
  node.data.columnInputs[col].options = text.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean)
  commitSelectedNode()
}

// 复制表格为 Markdown
async function copyTableAsMarkdown() {
  const n = selectedNode.value
  if (!n) return
  const cols = (n.data.columns || []) as string[]
  const rows = (n.data.rows || []) as Record<string, any>[]
  if (!cols.length) {
    ElMessage.warning('表格暂无列')
    return
  }
  const header = '| ' + cols.join(' | ') + ' |'
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |'
  const body = rows.map((r) => '| ' + cols.map((c) => String(r[c] ?? '')).join(' | ') + ' |').join('\n')
  const md = [header, sep, body].filter(Boolean).join('\n')
  try {
    await navigator.clipboard.writeText(md)
    ElMessage.success('已复制 Markdown 表格到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
}

// ==================== 表格节点 Excel 导入 ====================
const tableFileInput = ref<HTMLInputElement | null>(null)
const pendingTableNodeId = ref<string | null>(null)
function triggerTableImport(node: DcNode) {
  pendingTableNodeId.value = node.id
  tableFileInput.value?.click()
}
async function handleTableImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const nodeId = pendingTableNodeId.value
  pendingTableNodeId.value = null
  if (!file || !nodeId) return
  try {
    const { columns, rows } = await parseExcelFile(file)
    const node = activeModel.value?.nodes.find((n) => n.id === nodeId)
    if (!node) return
    node.data.columns = columns
    node.data.rows = rows
    store.updateNode(nodeId, { data: { ...node.data } })
  } catch (err: any) {
    ElMessage.error('Excel 导入失败: ' + (err?.message || String(err)))
  }
}

// ==================== 图表节点 GeoJSON 导入（随画布数据包保存） ====================
const geojsonFileInput = ref<HTMLInputElement | null>(null)
function triggerGeojsonImport() {
  geojsonFileInput.value?.click()
}
const geojsonLabel = computed(() => {
  const g = selectedNode.value?.data?.geojson
  return g?.name || selectedNode.value?.data?.geojsonName || 'GeoJSON'
})
function geojsonFeatureCount(gj: any): number {
  if (!gj) return 0
  if (Array.isArray(gj.features)) return gj.features.length
  return gj.geometry ? 1 : 0
}
async function handleGeojsonImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const node = selectedNode.value
  if (!file || !node) return
  try {
    const text = await file.text()
    const gj = JSON.parse(text)
    // 校验为 GeoJSON
    const isGeoJson = gj && gj.type === 'FeatureCollection'
      ? Array.isArray(gj.features)
      : !!(gj && gj.type && gj.geometry)
    if (!isGeoJson) {
      ElMessage.warning('不是有效的 GeoJSON 数据')
      return
    }
    const nodeId = node.id
    const m = activeModel.value?.nodes.find((n) => n.id === nodeId)
    if (!m) return
    // name 用于地图 popup 标题；数据本身随节点 data 保存（导出数据包自动包含）
    m.data.geojson = { ...gj, name: file.name }
    m.data.geojsonName = file.name
    store.updateNode(nodeId, { data: { ...m.data } })
    ElMessage.success(`GeoJSON 已导入（${geojsonFeatureCount(gj)} 个要素）`)
  } catch (err: any) {
    ElMessage.error('GeoJSON 导入失败: ' + (err?.message || String(err)))
  }
}
// 地图显示样式颜色（GeoJSON 填充/边界、数据点颜色）——立即保存
function setMapColor(key: string, e: Event) {
  const node = selectedNode.value
  if (!node) return
  node.data[key] = (e.target as HTMLInputElement).value
  commitSelectedNode()
}
// 地图显示样式透明度（滑杆 0~100 → 0~1 保存）
function setMapOpacity(key: string, e: Event) {
  const node = selectedNode.value
  if (!node) return
  node.data[key] = Number((e.target as HTMLInputElement).value) / 100
  commitSelectedNode()
}
// 数据点透明度显示值：未设置时按当前样式取默认（保持既有观感）
const mapPointOpacityDisplay = computed(() => {
  const n = selectedNode.value
  if (!n) return 0.6
  if (typeof n.data.mapPointOpacity === 'number') return n.data.mapPointOpacity
  const style = n.data.mapPointStyle || 'circle'
  return style === 'bar' ? 0.75 : style === 'diamond' ? 0.6 : style === 'gradient' ? 0.8 : 0.35
})
function clearGeojson() {
  const node = selectedNode.value
  if (!node) return
  delete node.data.geojson
  delete node.data.geojsonName
  store.updateNode(node.id, { data: { ...node.data } })
}

// ==================== 面包屑 ====================
function goTo(modelId: string) {
  const idx = store.modelPath.value.indexOf(modelId)
  if (idx >= 0) {
    store.modelPath.value = store.modelPath.value.slice(0, idx + 1)
    store.persist()
  }
}
function navigateRoot() {
  store.navigateRoot()
}

// ==================== 暴露给宿主模块（工具栏提升到标签栏右侧后由 DataCanvasModule 调用） ====================
defineExpose({
  save: handleSave,
  run,
  zoomBy,
  resetView,
  exportModel,
  triggerImport,
  toggleConnect,
  goTo,
  navigateRoot,
  // 响应式状态：DataCanvasModule 通过暴露代理直接读写/展示
  connectMode,
  pendingEdgeType,
  snapToGrid,
  view,
  crumbPath,
})

// ==================== 工程树 ====================
interface ProjectTreeItem {
  id: string
  name: string
  type: NodeType
  depth: number
  nodeId: string
  modelId: string
  hasChildren: boolean
}

const projectTree = computed<ProjectTreeItem[]>(() => {
  const out: ProjectTreeItem[] = []
  const walk = (modelId: string, depth: number) => {
    const m = store.getModelById(modelId)
    if (!m || depth > (config.maxDepth || 5)) return
    for (const n of m.nodes) {
      const hasChildren = n.type === 'subcanvas' && !!store.getSubModel(n)
      out.push({ id: n.id, name: n.name, type: n.type, depth, nodeId: n.id, modelId: m.id, hasChildren })
      if (n.type === 'subcanvas' && !collapsed.value.has(n.id)) {
        walk(n.data.modelId, depth + 1)
      }
    }
  }
  walk(store.currentModelId.value ?? '', 0)
  return out
})

function toggleCollapse(item: ProjectTreeItem) {
  const s = new Set(collapsed.value)
  if (s.has(item.id)) s.delete(item.id)
  else s.add(item.id)
  collapsed.value = s
}

function onTreeClick(item: ProjectTreeItem) {
  if (item.type === 'subcanvas') {
    // 点击子画布：打开子画布
    const m = store.getModelById(item.modelId)
    const node = m?.nodes.find((n) => n.id === item.nodeId)
    if (node?.data.modelId) {
      store.modelPath.value = store.pathToModel(node.data.modelId)
      store.persist()
      selectedNodeId.value = null
    }
    return
  }
  // 点击普通节点：跳转到其所在模型并选中
  store.modelPath.value = store.pathToModel(item.modelId)
  store.persist()
  selectedNodeId.value = item.nodeId
  selectedEdgeId.value = null
  nextTick(() => scrollToNode(item.nodeId))
}

function scrollToNode(nodeId: string) {
  const model = store.activeModel.value
  const wrap = wrapRef.value
  if (!model || !wrap) return
  const n = model.nodes.find((x) => x.id === nodeId)
  if (!n) return
  // 将节点居中到视口（使用实际显示尺寸）
  view.x = wrap.clientWidth / 2 - (n.x + nodeW(n) / 2) * view.k
  view.y = wrap.clientHeight / 2 - (n.y + nodeH(n) / 2) * view.k
}

// ==================== 计算 / 导入导出 ====================
function run() {
  // 触发重新计算（computed 依赖变化自动更新）
  store.refresh()
}
function exportSubcanvasData(node: DcNode) {
  const subModel = store.getSubModel(node) || store.ensureSubModel(node)
  const payload = {
    model: deepCloneNode(subModel),
    activeModelId: subModel.id,
    version: 1,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(node.name || subModel.name || 'subcanvas').replace(/[\\/:*?"<>|]/g, '-')}.data`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('已导出子画布数据')
}
function removeModelSubtree(modelId: string) {
  const toDelete = new Set<string>()
  const walk = (id: string) => {
    if (toDelete.has(id)) return
    toDelete.add(id)
    const m = store.getModelById(id)
    if (!m) return
    for (const n of m.nodes) {
      if (n.type === 'subcanvas' && n.data.modelId) walk(n.data.modelId)
    }
  }
  walk(modelId)
  store.models.value = store.models.value.filter((m) => !toDelete.has(m.id))
}
function resolveImportedSubcanvasModel(data: any): Model | null {
  if (data?.model && typeof data.model === 'object') {
    const model = data.model as Partial<Model>
    if (Array.isArray(model.nodes) && Array.isArray(model.edges)) return model as Model
  }
  const candidates = Array.isArray(data?.models) ? data.models : []
  if (!candidates.length) return null
  const root = candidates.find((m: Model) => m.id === data.activeModelId) || candidates[0]
  if (root && Array.isArray(root.nodes) && Array.isArray(root.edges)) return root as Model
  return null
}
function replaceSubcanvasModel(node: DcNode, data: any) {
  const importedModel = resolveImportedSubcanvasModel(data)
  if (!importedModel) {
    ElMessage.warning('文件不是有效的子画布数据包')
    return
  }
  const modelId = node.data.modelId || uid('m')
  removeModelSubtree(modelId)
  const replacement: Model = {
    ...deepCloneNode(importedModel),
    id: modelId,
    name: importedModel.name || node.name,
    hierarchy: {
      parentId: activeModel.value?.id || importedModel.hierarchy?.parentId,
      depth: (activeModel.value?.hierarchy?.depth ?? 0) + 1,
    },
    updatedAt: Date.now(),
  }
  replacement.nodes = Array.isArray(replacement.nodes) ? replacement.nodes : []
  replacement.edges = Array.isArray(replacement.edges) ? replacement.edges : []
  replacement.meta = replacement.meta || { params: [], formFields: [], formRecords: [] }
  node.data.modelId = modelId
  store.models.value.push(replacement)
  store.persist()
  store.refresh()
  ElMessage.success('已替换子画布数据')
}
// 导出 .data 数据包（data 格式：{ models, activeModelId }）
function exportModel() {
  const data = { models: store.models.value, activeModelId: store.activeModelId.value }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${activeModel.value?.name || 'data-canvas'}.data`
  a.click()
  URL.revokeObjectURL(url)
}
function triggerImport() {
  fileInput.value?.click()
}
// 选择打开：作为根画布导入（替换整个模型数据）
async function handleImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  try {
    const data = JSON.parse(text)
    const targetNodeId = pendingSubcanvasNodeId.value
    pendingSubcanvasNodeId.value = null
    if (targetNodeId) {
      const node = activeModel.value?.nodes.find((n) => n.id === targetNodeId)
      if (node && node.type === 'subcanvas') {
        replaceSubcanvasModel(node, data)
      } else {
        ElMessage.warning('当前目标不是子画布节点')
      }
    } else {
      await store.importData(data)
    }
  } catch (err: any) {
    ElMessage.error('导入失败: ' + err?.message)
  }
  input.value = ''
}

// ==================== 图表辅助 ====================
function chartIcon(type: string): string {
  return type === 'bar' ? 'fa-bar-chart' : type === 'line' ? 'fa-line-chart' : type === 'map' ? 'fa-map-marker' : 'fa-pie-chart'
}
function chartLabel(type: string): string {
  return type === 'bar' ? '柱状图' : type === 'line' ? '折线图' : type === 'map' ? '地图' : '饼图'
}

// ==================== 图表节点迷你预览 ====================
function chartMiniData(node: DcNode): { label: string; value: number }[] {
  const r = resultOf(node)
  const d = node.data || {}
  // 多条连线（柱状/折线/饼图通用）：每条连线一个类别（key=端口名/节点名）
  if (r?.multiSeries?.length) {
    return r.multiSeries.map((s: any) => ({ label: String(s.key), value: Number(s.value) || 0 }))
  }
  const src = r?.source
  if (!src?.rows?.length) return []
  const xf = d.chartType === 'pie' ? d.labelField : d.chartType === 'map' ? d.labelField || d.latField : d.xField
  const yf = d.chartType === 'pie' ? d.valueField : d.chartType === 'map' ? d.valueField : d.yField
  const out: { label: string; value: number }[] = []
  for (const row of src.rows) {
    out.push({ label: String(row[xf] ?? ''), value: Number(row[yf]) || 0 })
  }
  return out
}
function miniMax(node: DcNode): number {
  return Math.max(1, ...chartMiniData(node).map((d) => d.value))
}
function miniBarX(node: DcNode, i: number): number {
  const n = chartMiniData(node).length
  return (100 / n) * i
}
function miniBarW(node: DcNode): number {
  const n = chartMiniData(node).length
  return Math.max(2, 100 / n - 1)
}
function miniBarH(node: DcNode, d: { value: number }): number {
  return Math.max(2, (d.value / miniMax(node)) * 32)
}
function miniBarY(node: DcNode, d: { value: number }): number {
  return 36 - miniBarH(node, d)
}
function miniLinePoints(node: DcNode): string {
  const data = chartMiniData(node)
  if (data.length <= 1) return ''
  const step = 100 / (data.length - 1)
  return data.map((d, i) => `${i * step},${36 - (d.value / miniMax(node)) * 32}`).join(' ')
}
// map 气泡预览：点直径按数值映射（2 ~ 20 px）
function mapDotSize(node: DcNode, value: number): number {
  return Math.max(2, 2 + (Math.max(0, value) / miniMax(node)) * 18)
}
// 标签 X 坐标：折线对齐数据点，柱状/其他居中对齐每根柱子
function miniLabelX(node: DcNode, i: number): number {
  const n = chartMiniData(node).length
  if (n <= 1) return 50
  if (node.data.chartType === 'line') {
    return (100 / (n - 1)) * i
  }
  return (100 / n) * i + (100 / n) / 2
}
const PIE_COLORS = ['#2196F3', '#4CAF50', '#FF9800', '#E91E63', '#9C27B0', '#00BCD4', '#FDD835', '#8BC34A']
function pieColor(i: number): string {
  return PIE_COLORS[i % PIE_COLORS.length]
}
function conicGradient(data: { label: string; value: number }[]): string {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0) || 1
  let acc = 0
  const stops = data.map((d, i) => {
    const start = (acc / total) * 100
    acc += Math.max(0, d.value)
    const end = (acc / total) * 100
    return `${PIE_COLORS[i % PIE_COLORS.length]} ${start}% ${end}%`
  })
  return `conic-gradient(${stops.join(', ')})`
}

// ==================== 画布切换时重置视图 ====================
// 切换主画布 / 进入离开子画布 / 工程树跳转都会改变当前模型 id，重置平移缩放
watch(
  () => store.currentModelId.value,
  () => {
    resetView()
    selectedNodeId.value = null
    selectedEdgeId.value = null
  },
)

// ==================== 生命周期 ====================
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointermove', onPanMove)
  window.removeEventListener('pointerup', onPanUp)
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeUp)
  window.removeEventListener('pointermove', onInspectorResizeMove)
  window.removeEventListener('pointerup', onInspectorResizeUp)
  window.removeEventListener('pointermove', onPortDragMove)
  window.removeEventListener('pointerup', onPortDragUp)
})
</script>

<style scoped>
/* ====== 数据画布（dc- 前缀，样式隔离，参照主系统 CSS 变量） ====== */
.dc-canvas-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  overflow: hidden;
  position: relative;
}

.dc-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.dc-toolbar-left, .dc-toolbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.dc-breadcrumb { display: flex; align-items: center; gap: 2px; font-size: 11px; }
.dc-crumb { cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.dc-crumb:hover { background: var(--backgroundColor); }
.dc-crumb.active { color: var(--fontActiveColor); }
.dc-crumb-sep { color: var(--fontColor); }
.dc-model-name input { font-size: 12px; font-weight: 600; }

.dc-seg { display: flex; gap: 0; border: 1px solid var(--borderColor); border-radius: 4px; overflow: hidden; }
.dc-seg .dc-btn { border: none; border-radius: 0; }

.dc-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 9px;
  height: 24px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.dc-btn:hover { background: var(--menuColor); }
.dc-btn.active { background: rgba(33, 150, 243, 0.18); border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.dc-btn-primary { background: rgba(33, 150, 243, 0.85); border-color: transparent; color: #fff; }
.dc-btn-primary:hover { background: #1976d2; }
.dc-btn-sm { padding: 1px 6px; font-size: 10px; }
.dc-danger { color: #f44336; }
.dc-btn-block { width: 100%; justify-content: center; margin-top: 4px; }
.dc-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.dc-select { height: 26px; font-size: 11px; margin: 0; width: auto; }
.dc-inline { width: auto; display: inline-block; }

.dc-canvas-body { flex: 1; display: flex; min-height: 0; }

/* 调色板 */
.dc-palette {
  width: 160px;
  flex-shrink: 0;
  border-right: 1px solid var(--borderColor);
  padding: 6px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dc-palette-tabs { display: flex; border: 1px solid var(--borderColor); border-radius: 4px; overflow: hidden; flex-shrink: 0; }
.dc-palette-tab { flex: 1; padding: 4px 0; border: none; background: var(--menuColor); color: var(--fontColor); font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; }
.dc-palette-tab.active { background: rgba(33,150,243,0.18); color: var(--fontActiveColor); }
.dc-project-tree { display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }
.dc-tree-item { display: flex; align-items: center; gap: 5px; padding: 4px 4px; border-radius: 4px; cursor: pointer; font-size: 11px; }
.dc-tree-item:hover { background: var(--backgroundColor); }
.dc-tree-item.is-subcanvas { font-weight: 600; }
.dc-tree-chevron { width: 14px; text-align: center; color: var(--borderColor); flex-shrink: 0; }
.dc-tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-palette-title { font-size: 11px; font-weight: 600; padding: 2px 4px; }
.dc-palette-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: grab;
  font-size: 11px;
  background: var(--menuColor);
}
.dc-palette-item:hover { background: var(--backgroundColor); }
.dc-palette-item.disabled { opacity: 0.4; cursor: not-allowed; }
.dc-node-icon { width: 18px; height: 18px; border-radius: 3px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; flex-shrink: 0; }
.dc-palette-hint { font-size: 10px; color: var(--borderColor); padding: 6px 4px; line-height: 1.5; }
.dc-connect-hint { font-size: 11px; color: var(--fontActiveColor); padding: 6px 4px; border: 1px dashed var(--fontActiveColor); border-radius: 4px; }

/* 画布 */
.dc-canvas-wrap { flex: 1; overflow: hidden; position: relative; min-width: 0; background: var(--backgroundColor); background-image: radial-gradient(circle, var(--borderColor) 1px, transparent 1px); background-size: 24px 24px; }
.dc-canvas-inner { position: relative; transform-origin: 0 0; }
.dc-axis { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 0; }
.dc-axis-line { stroke: rgba(128, 128, 128, 0.35); stroke-width: 1; }
.dc-axis-text { fill: var(--borderColor); font-size: 9px; }
.dc-zoom-label { display: inline-flex; align-items: center; padding: 0 6px; font-size: 10px; color: var(--fontColor); min-width: 40px; justify-content: center; }
.dc-edges { position: absolute; left: 0; top: 0; pointer-events: none; }
.dc-edge { pointer-events: stroke; cursor: pointer; }
.dc-edge.selected { filter: drop-shadow(0 0 3px var(--fontActiveColor)); stroke-width: 3; }
/* 连线样式与动画 */
.dc-edge.edge-type-dataflow { stroke-dasharray: 8 6; animation: dc-edge-flow 0.8s linear infinite; }
.dc-edge.edge-type-relation { stroke-dasharray: 6 4; }

@keyframes dc-edge-flow { to { stroke-dashoffset: -14; } }
.dc-edge-temp { stroke: var(--fontActiveColor); stroke-width: 2; stroke-dasharray: 6 4; pointer-events: none; }

.dc-node {
  position: absolute;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--menuColor);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  cursor: grab;
  user-select: none;
  display: flex;
  flex-direction: column;
}
.dc-node.selected { border-color: var(--fontActiveColor); box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.3); }
.dc-node.connecting { cursor: crosshair; }
.dc-node-head { display: flex; align-items: center; gap: 5px; padding: 4px 6px; color: #fff; font-size: 11px; flex-shrink: 0; border-radius: 5px 5px 0 0; }
.dc-node-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-node-depth { background: rgba(0,0,0,0.25); border-radius: 8px; padding: 0 5px; font-size: 9px; }
.dc-node-body { flex: 1; padding: 4px 6px; overflow: hidden; font-size: 10px; color: var(--fontColor); }
.dc-node-empty { color: var(--fontColor); }
.dc-field-row { height: 18px; line-height: 18px; overflow: hidden; }
.dc-field-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fontActiveColor); margin-left: 4px}
.dc-node-snippet { font-family: monospace; font-size: 9px; white-space: pre-wrap; word-break: break-all; color: var(--fontColor); max-height: 60px; overflow: hidden; }
.dc-node-err { color: #f44336; font-size: 10px; }
.dc-chart-preview { border: 1px solid var(--borderColor); border-radius: 4px; padding: 4px; background: var(--backgroundColor); }
.dc-chart-preview-svg { width: 100%; height: 140px; display: block; }
.dc-chart-preview-map { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px; min-height: 120px; padding: 8px; }
.dc-preview-map-dot { border-radius: 50%; background: rgba(76,175,80,0.55); border: 1px solid #4CAF50; flex-shrink: 0; }
.dc-preview-label { font-size: 4px; fill: var(--fontColor); }
.dc-chart-preview-pie-wrap { display: flex; gap: 10px; align-items: center; justify-content: center; padding: 4px; }
.dc-chart-preview-pie { width: 90px; height: 90px; border-radius: 50%; flex-shrink: 0; }
.dc-chart-preview-legend { flex: 0 1 auto; width: auto; max-width: 55%; min-width: 0; display: flex; flex-direction: column; gap: 3px; font-size: 10px; }
.dc-preview-legend-item { display: flex; align-items: center; gap: 4px; }
.dc-preview-legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.dc-preview-legend-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-preview-legend-value { margin-left: auto; color: var(--fontActiveColor); }
.dc-chart-preview-empty { display: flex; align-items: center; justify-content: center; height: 120px; color: var(--borderColor); font-size: 11px; }
.dc-node-result { margin-top: 3px; color: var(--fontActiveColor); font-size: 10px; }
.dc-kv { display: flex; gap: 4px; align-items: center; height: 18px; line-height: 18px; overflow: hidden; }
.dc-kv span { color: var(--fontActiveColor); flex-shrink: 0; }
.dc-kv em { color: var(--fontColor); font-style: normal; }
.dc-kv b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-var-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 18px; line-height: 18px; }
.dc-var-formula { font-family: monospace; font-size: 9px; color: var(--fontColor); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; margin-left: 4px; }
.dc-var-result { font-size: 10px; color: var(--fontActiveColor); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; margin-right: 4px; }
.dc-port {
  position: absolute;
  width: 10px; height: 10px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid #2196F3;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
}
.dc-port-in { left: -6px; }
.dc-port-out { right: -6px; }
.dc-port-label { position: absolute; right: 14px; transform: translateY(-50%); font-size: 8px; color: var(--borderColor); pointer-events: none; white-space: nowrap; z-index: 1; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.dc-node-resize { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: se-resize; z-index: 3; }
.dc-node-resize::after { content: ''; position: absolute; right: 2px; bottom: 2px; width: 8px; height: 8px; border-right: 2px solid var(--borderColor); border-bottom: 2px solid var(--borderColor); border-radius: 0 0 3px 0; }
.dc-node-resize:hover::after { border-color: var(--fontActiveColor); }
.dc-connect-tip { position: absolute; left: 10px; top: 10px; background: rgba(33,150,243,0.15); border: 1px solid var(--fontActiveColor); color: var(--fontActiveColor); padding: 4px 8px; border-radius: 4px; font-size: 11px; pointer-events: none; }

/* 属性面板 */
.dc-inspector {
  width: 350px;
  flex-shrink: 0;
  border-left: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  background: var(--menuColor);
  position: relative;
}
.dc-inspector-resize { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 5; }
.dc-inspector-resize:hover { background: rgba(33, 150, 243, 0.2); }
.dc-inspector-empty { align-items: center; justify-content: center; color: var(--borderColor); gap: 8px; font-size: 11px; }
.dc-inspector-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--borderColor); font-weight: 600; font-size: 12px; flex-shrink: 0; }
.dc-xy-badge { font-size: 10px; color: var(--borderColor); font-family: monospace; margin-right: 6px; white-space: nowrap; }
.dc-flex1 { flex: 1; }
.dc-inspector-body { flex: 1; overflow-y: auto; padding: 8px; }
.dc-inspector-title { font-size: 11px; font-weight: 600; margin: 8px 0 4px; color: var(--fontActiveColor); }
.dc-field { margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
.dc-field label { flex: 0 0 70px; font-size: 10px; color: var(--fontColor); margin-bottom: 0; line-height: 14px; }
.dc-field > .dc-input { flex: 1; min-width: 0; }
.dc-field input { margin: 0; }
.dc-expose-check { display: flex; align-items: center; margin-bottom: 6px; }
.dc-expose-check .dc-check { font-size: 11px; color: var(--fontActiveColor); cursor: pointer; }
.dc-row2 { display: flex; gap: 6px; }
.dc-row2 > div { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
.dc-row2 > div label { flex: 0 0 auto; }
.dc-row2 > div .dc-input { flex: 1; min-width: 0; }
.dc-input {
  width: 100%; box-sizing: border-box;
  margin: 0; padding: 3px 5px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  height: auto;
}
.dc-input.dc-sm { width: auto; flex: 1; }
.dc-textarea { width: 100%; box-sizing: border-box; min-height: 70px; padding: 4px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--backgroundColor); color: var(--fontColor); font-family: monospace; font-size: 11px; resize: vertical; }
.dc-hint { font-size: 10px; color: var(--borderColor); line-height: 1.5; margin-top: 4px; }
/* 地图显示样式颜色选择器 */
.dc-color-field label { flex: 0 0 auto; min-width: 64px; }
.dc-color-field input[type="color"] { width: 26px; height: 22px; padding: 0; border: 1px solid var(--borderColor); border-radius: 4px; background: transparent; cursor: pointer; flex: 0 0 auto; }
/* 地图显示样式透明度滑杆 */
.dc-opacity-field label { flex: 0 0 auto; min-width: 64px; }
.dc-opacity-field input[type="range"] { flex: 1; min-width: 0; accent-color: var(--fontActiveColor); }
.dc-opacity-val { flex: 0 0 34px; text-align: right; font-size: 10px; color: var(--borderColor); }
.dc-sql-status { font-size: 13px; }
.dc-sql-status.ok { color: #4CAF50; }
.dc-sql-status.error { color: #f44336; }
.dc-sql-error { color: #f44336; word-break: break-all; }
.dc-sql-preview { overflow: auto; max-height: 160px; margin-top: 4px; border: 1px solid var(--borderColor); border-radius: 4px; }
.dc-sql-preview table { border-collapse: collapse; font-size: 10px; width: 100%; }
.dc-sql-preview th, .dc-sql-preview td { border: 1px solid var(--borderColor); padding: 2px 5px; white-space: nowrap; }
.dc-sql-preview th { background: var(--menuColor); }
.dc-result-box { margin-top: 6px; padding: 6px; border: 1px solid var(--borderColor); border-radius: 4px; background: var(--backgroundColor); font-size: 11px; word-break: break-all; }

.dc-param-row { display: flex; gap: 3px; margin-bottom: 3px; align-items: center; }
.dc-param-row .dc-input { flex: 1; min-width: 0; }
.dc-param-row select { flex: 0 0 50px; width: 50px; }
.dc-param-row .dc-param-unit-input { flex: 0 0 44px; width: 44px; }

.dc-col-row { display: flex; gap: 3px; flex-wrap: wrap; align-items: center; }
.dc-col-row .dc-input { flex: 0 0 auto; width: 50px; }
/* 表单录入模式开关（与导入/复制按钮同行，仅图标 + title 提示） */
.dc-field .dc-form-entry-check { flex: 0 0 auto; margin: 0; display: inline-flex; align-items: center; gap: 3px; cursor: pointer; color: var(--fontActiveColor); }
.dc-form-entry-check input { margin: 0; }
.dc-form-entry-check i { font-size: 12px; }

/* 列定义（单行紧凑卡片：列名 + 类型 + 标题 + 录入方式 + 删除） */
.dc-cols-def { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; border: 1px solid var(--borderColor); border-radius: 4px; padding: 4px; background: var(--backgroundColor); }
.dc-col-def { border: 1px solid var(--borderColor); border-radius: 4px; padding: 3px 4px; background: var(--menuColor); }
.dc-col-def-row { display: flex; gap: 4px; align-items: center; }
.dc-col-name { flex: 1; min-width: 0; }
.dc-col-dtype { flex: 0 0 62px; width: 62px; }
.dc-col-title-check { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 2px; cursor: pointer; color: var(--borderColor); }
.dc-col-title-check input { margin: 0; }
.dc-col-title-check.on { color: var(--fontActiveColor); }
.dc-col-inputtype { flex: 0 0 66px; width: 66px; }
.dc-col-unit { flex: 0 0 42px; width: 42px; }
.dc-col-def-options { margin-top: 3px; }
.dc-col-def-options .dc-input { width: 100%; }

.dc-table-edit { overflow: auto; max-height: 220px; border: 1px solid var(--borderColor); border-radius: 4px; }
.dc-table-edit table { border-collapse: collapse; font-size: 10px; }
.dc-table-edit th, .dc-table-edit td { border: 1px solid var(--borderColor); padding: 1px 3px; white-space: nowrap; }
.dc-table-edit th { background: var(--menuColor); position: sticky; top: 0; }
.dc-cell { width: 100%; min-width: 70px; box-sizing: border-box; }

.dc-expose-list { display: flex; flex-direction: column; gap: 3px; }
.dc-expose-row { display: flex; align-items: center; gap: 4px; }
.dc-expose-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }

.dc-ctx-menu {
  position: absolute;
  z-index: 100;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  padding: 4px;
  min-width: 120px;
}
.dc-ctx-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
.dc-ctx-item:hover { background: var(--backgroundColor); }
.dc-ctx-sep { height: 1px; background: var(--borderColor); margin: 3px 4px; }

/* ====== 滚动条（与主系统一致） ====== */
.dc-canvas-view ::-webkit-scrollbar { width: 4px; height: 4px; }
.dc-canvas-view ::-webkit-scrollbar-track { background: var(--backgroundColor); }
.dc-canvas-view ::-webkit-scrollbar-thumb { background: var(--borderColor); border-radius: 2px; }
.dc-canvas-view ::-webkit-scrollbar-thumb:hover { background: var(--fontActiveColor); }
</style>
