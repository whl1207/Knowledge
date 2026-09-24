<template>
<div class="bg">
  <div class="home" ref="homeRef">
    <div class="side-column">
      <!-- 工具栏（左侧面板上方） -->
      <div class="top-toolbar">
    <!-- 视图选择（最左侧） -->
    <select v-model="currentView" class="toolbar-select" :title="store.locales === 'zh' ? '切换视图' : 'Switch view'">
      <option v-for="v in viewModes" :key="v.id" :value="v.id">{{ v.title }}</option>
    </select>
    <!-- 分类筛选（第一行右侧） -->
    <select v-model="selectedStatus" class="toolbar-select" :title="store.locales === 'zh' ? '分类筛选' : 'Filter by category'">
      <option value="">{{ store.locales === 'zh' ? '全部分类' : 'All categories' }}</option>
      <option v-for="status in statusOptions" :key="status.value" :value="status.value">{{ status.label }}</option>
      <option value="__undefined__">{{ store.locales === 'zh' ? '其他' : 'Other' }}</option>
    </select>
    <!-- 显示/隐藏筛选（默认显示；可看隐藏、全部） -->
    <select v-model="visibilityFilter" class="toolbar-select" :title="store.locales === 'zh' ? '显示/隐藏筛选' : 'Show / Hide filter'">
      <option value="show">{{ store.locales === 'zh' ? '显示' : 'Show' }}</option>
      <option value="hidden">{{ store.locales === 'zh' ? '隐藏' : 'Hidden' }}</option>
      <option value="all">{{ store.locales === 'zh' ? '全部' : 'All' }}</option>
    </select>
    <!-- 搜索框（展开状态） -->
    <div v-if="noteSearchActive" class="notes-search-box">
      <i class="fa fa-search"></i>
      <input
        v-model="searchText"
        class="notes-search-input"
        :placeholder="getSearchPlaceholder()"
        @keydown.esc="closeNoteSearch"
      />
      <div v-if="searchText" class="notes-search-clear" @click="searchText = ''" :title="store.locales === 'zh' ? '清除' : 'Clear'">
        <i class="fa fa-times-circle"></i>
      </div>
    </div>
    <!-- 搜索按钮（收起状态） -->
    <div v-else class="notes-search-toggle" @click="openNoteSearch" :title="store.locales === 'zh' ? '搜索' : 'Search'">
      <i class="fa fa-search"></i>
    </div>
    <!-- 新建笔记按钮 -->
    <div class="notes-new-btn" :class="{ active: !editingItem || !selectedItem }" @click="startNewNote()" :title="store.locales === 'zh' ? '新建' : 'New'">
      <i class="fa fa-plus"></i>
    </div>
    <!-- 设置（储存方案 / 导入导出） -->
    <button class="toolbar-action-btn" @click="showSettings = true" :title="store.locales === 'zh' ? '设置' : 'Settings'">
      <i class="fa fa-cog"></i>
    </button>
    </div>

    <!-- 左侧内容：条目列表（随手记视图） -->
    <div v-if="currentView === 'notes'" class="notes-list-panel">
      <div class="notes-list scoll">
        <!-- 所有条目卡片（含项目，可置顶，支持排序方式 / 正倒序） -->
        <div
          v-for="item in filteredEntries"
          :key="item.id"
          class="note-card"
          :class="{ pinned: item.pinned, active: selectedItem && selectedItem.id === item.id }"
          :style="item.color ? { borderLeftColor: item.color } : undefined"
          :title="getItemPath(item) || undefined"
          @click="selectItem(item)"
          @contextmenu.prevent="openTreeContextMenu($event, item)"
        >
          <div class="note-card-header">
            <span class="note-card-color" :style="{ backgroundColor: item.color || '#e9ecef' }" :title="getStatusLabel(item.status)">
              <i :class="getStatusIcon(item.status)"></i>
            </span>
            <span class="note-card-title">{{ item.title || '无标题' }}</span>
            <span class="note-card-time">{{ formatItemTime(item) }}</span>
            <div class="note-card-actions">
              <button class="note-action-btn" :class="{ active: item.pinned }" @click.stop="togglePin(item)" :title="store.locales === 'zh' ? '置顶' : 'Pin'">
                <i class="fa fa-thumb-tack"></i>
              </button>
              <button class="note-action-btn" :class="{ active: item.hidden }" @click.stop="toggleHide(item)" :title="store.locales === 'zh' ? (item.hidden ? '显示' : '隐藏') : (item.hidden ? 'Show' : 'Hide')">
                <i :class="item.hidden ? 'fa fa-eye-slash' : 'fa fa-eye'"></i>
              </button>
              <button class="note-action-btn" @click.stop="deleteItem(item)" :title="store.locales === 'zh' ? '删除' : 'Delete'">
                <i class="fa fa-trash"></i>
              </button>
            </div>
          </div>
        </div>

        <div v-if="filteredEntries.length === 0" class="empty-state">
          <i class="fa fa-sticky-note-o"></i>
          <p v-if="!searchText">{{ store.locales === 'zh' ? '还没有内容，先记下一个想法吧' : 'No entries yet — capture a quick idea first' }}</p>
          <p v-else>{{ store.locales === 'zh' ? '没有找到匹配的内容' : 'No matching entries found' }}</p>
        </div>
      </div>
    </div>

    <!-- 树状图 -->
    <div v-else-if="currentView === 'tree'" class="tree-panel">
      <div class="tree-container scoll">
        <div class="tree-view">
          <el-tree
            ref="todoTreeRef"
            class="todo-el-tree"
            :data="treeItems"
            node-key="id"
            empty-text=""
            :props="{ label: 'title', children: 'children' }"
            :default-expanded-keys="expandedKeys"
            :auto-expand-parent="false"
            :expand-on-click-node="true"
            draggable
            :allow-drop="allowTreeDrop"
            @node-click="onTreeNodeClick"
            @node-drop="onTreeNodeDrop"
            @node-expand="onTreeNodeExpand"
            @node-collapse="onTreeNodeCollapse"
          >
            <template #default="{ data }">
              <div class="el-tree-node-custom" :class="{ active: selectedItem && selectedItem.id === data.id }" @contextmenu.prevent="openTreeContextMenu($event, data)">
                <span class="el-tree-color" :style="{ backgroundColor: data.color || '#e9ecef' }" :title="getStatusLabel(data.status)">
                  <i :class="getStatusIcon(data.status)"></i>
                </span>
                <span class="el-tree-label">{{ data.title }}</span>
                <span class="el-tree-time">{{ formatItemTime(data) }}</span>
              </div>
            </template>
          </el-tree>
        </div>

        <!-- 空状态 -->
        <div v-if="treeItems.length === 0" class="empty-state full-size">
          <i class="fa fa-sitemap"></i>
          <p v-if="selectedStatus || searchText">没有符合条件的项目</p>
          <p v-else>暂无内容，点击 + 新建</p>
        </div>
      </div>
    </div>

    <!-- 完整模式左侧：月视图 -->
    <div class="month-container" v-else-if="currentView === 'month'">
      <div class="month-toolbar">
        <span class="month-title"><i class="fa fa-calendar"></i> {{ currentMonth }}</span>
        <button class="month-icon-btn" @click="goToday" :title="store.locales === 'zh' ? '回到今天' : 'Back to today'">
          <i class="fa fa-crosshairs"></i>
        </button>
        <div class="month-nav">
          <button class="month-icon-btn" @click="prev" :title="store.locales === 'zh' ? '上个月' : 'Previous month'">
            <i class="fa fa-chevron-left"></i>
          </button>
          <button class="month-icon-btn" @click="next" :title="store.locales === 'zh' ? '下个月' : 'Next month'">
            <i class="fa fa-chevron-right"></i>
          </button>
        </div>
      </div>
      <table class="month-table">
        <thead>
          <tr>
            <th v-for="day in daysOfWeek" :key="day">{{ day }}</th>
          </tr>
        </thead>
        <tbody class="month-table-body">
          <tr v-for="(week,w) in weeks" :key="w">
            <td v-for="(date,d) in week" :key="d" 
                :class="{
                  'date-cell': true,
                  'today': isToday(date.dateObject),
                  'selected-date': isSameDay(selectedDate, date.dateObject),
                  'drag-over': dragOverDate && isSameDay(dragOverDate, date.dateObject)
                }" 
                @click="onDateCellClick(date.dateObject)"
                @dragover.prevent="onCellDragOver($event, date.dateObject)"
                @drop.prevent="onCellDrop($event, date.dateObject)">
              <div class="date-title" :class="{ today: isToday(date.dateObject) }">
                <span>{{ date.day }}</span>
                <span class="date-title-right">
                  <button class="date-add-btn" :title="store.locales === 'zh' ? '新建' : 'New'" @click.stop="startNewNoteOnDate(date.dateObject)">
                    <i class="fa fa-plus"></i>
                  </button>
                  <span v-if="countTodo(date.dateObject) > 0" class="date-count">{{ countTodo(date.dateObject) }}</span>
                </span>
              </div>
              <div class="date-items scoll">
                <div v-for="item in getItemsForDate(date.dateObject)" 
                     :key="item.id" 
                     class="task-span"
                     :class="{ dragging: dragItemId === item.id }"
                     :style="getItemSpanStyle(item, date.dateObject)"
                     :title="getItemPath(item) || undefined"
                     draggable="true"
                     @click.stop="selectItem(item)"
                     @dragstart="onTaskDragStart($event, item)"
                     @dragend="onTaskDragEnd">
                  <div class="task-span-content">
                    <span class="task-span-title">{{ item.title }}</span>
                    <span class="task-status-icon" :title="getStatusLabel(item.status)">
                      <i :class="getStatusIcon(item.status)"></i>
                    </span>
                    <button class="task-span-del-btn" draggable="false" :title="store.locales === 'zh' ? '删除' : 'Delete'" @click.stop="deleteItem(item)">
                      <i class="fa fa-trash"></i>
                    </button>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 完整模式左侧：周视图 -->
    <div class="week-container" v-else-if="currentView === 'week'">
      <div class="week-toolbar">
        <span class="week-title"><i class="fa fa-calendar"></i> {{ currentWeekLabel }}</span>
        <button class="month-icon-btn" @click="goToday" :title="store.locales === 'zh' ? '回到今天' : 'Back to today'">
          <i class="fa fa-crosshairs"></i>
        </button>
        <div class="month-nav">
          <button class="month-icon-btn" @click="prev" :title="store.locales === 'zh' ? '上一周' : 'Previous week'">
            <i class="fa fa-chevron-left"></i>
          </button>
          <button class="month-icon-btn" @click="next" :title="store.locales === 'zh' ? '下一周' : 'Next week'">
            <i class="fa fa-chevron-right"></i>
          </button>
        </div>
      </div>
      <table class="month-table week-table">
        <thead>
          <tr>
            <th v-for="(day, d) in daysOfWeek" :key="day" :class="{ 'week-head-today': isToday(weekDays[d]) }">{{ day }}</th>
          </tr>
        </thead>
        <tbody class="month-table-body">
          <tr>
            <td v-for="(date,d) in weekDays" :key="d"
                :class="{
                  'date-cell': true,
                  'today': isToday(date),
                  'selected-date': isSameDay(selectedDate, date),
                  'drag-over': dragOverDate && isSameDay(dragOverDate, date)
                }"
                @click="onDateCellClick(date)"
                @dragover.prevent="onCellDragOver($event, date)"
                @drop.prevent="onCellDrop($event, date)">
              <div class="date-title" :class="{ today: isToday(date) }">
                <span>{{ formatMonthDay(date) }}</span>
                <span class="date-title-right">
                  <button class="date-add-btn" :title="store.locales === 'zh' ? '新建' : 'New'" @click.stop="startNewNoteOnDate(date)">
                    <i class="fa fa-plus"></i>
                  </button>
                  <span v-if="countTodo(date) > 0" class="date-count">{{ countTodo(date) }}</span>
                </span>
              </div>
              <div class="date-items scoll">
                <div v-for="item in getItemsForDate(date)"
                     :key="item.id"
                     class="task-span"
                     :class="{ dragging: dragItemId === item.id }"
                     :style="getItemSpanStyle(item, date)"
                     :title="getItemPath(item) || undefined"
                     draggable="true"
                     @click.stop="selectItem(item)"
                     @dragstart="onTaskDragStart($event, item)"
                     @dragend="onTaskDragEnd">
                  <div class="task-span-content">
                    <span class="task-span-title">{{ item.title }}</span>
                    <span class="task-status-icon" :title="getStatusLabel(item.status)">
                      <i :class="getStatusIcon(item.status)"></i>
                    </span>
                    <button class="task-span-del-btn" draggable="false" :title="store.locales === 'zh' ? '删除' : 'Delete'" @click.stop="deleteItem(item)">
                      <i class="fa fa-trash"></i>
                    </button>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    </div>

    <!-- 拖拽分隔条：位于右侧编辑器左边缘 -->
    <div class="resize-handle" :class="{ active: isResizing }" :style="{ right: (editorWidth + 5) + 'px' }" @mousedown="startResize"></div>

    <!-- 右侧：编辑器（笔记 / 灵感项目共用，始终显示，宽度可拖拽调整） -->
    <div class="notes-editor-panel" :style="{ width: editorWidth + 'px' }">
      <div class="notes-editor">
        <div class="notes-editor-title">
          <input
            v-model="editorTitle"
            class="notes-input"
            :placeholder="store.locales === 'zh' ? '标题' : 'Title'"
            @keyup.enter="saveEditor"
          />
        </div>
        <div class="notes-editor-content">
          <div ref="noteEditorHost" class="notes-textarea notes-block-editor-host scoll">
            <BlockEditor
              ref="noteBeRef"
              :value="noteEditorValue"
              :doc-key="String(selectedItem?.id ?? '')"
              :placeholder="store.locales === 'zh' ? '开始记录你的想法...' : 'Start writing your notes...'"
              @change="onNoteEditorChange"
              @save="saveEditor"
            />
          </div>
        </div>
        <!-- 选项按钮 + 颜色（一行，在下方） -->
        <div class="notes-editor-options">
          <!-- 预设颜色（单独一行） -->
          <div class="notes-preset-colors">
            <!-- 自定义颜色取色器（最左） -->
            <label class="notes-color-btn" :style="{ backgroundColor: editorColor }" :title="store.locales === 'zh' ? '设置颜色' : 'Set color'">
              <input type="color" :value="editorColor" @input="onEditorColorInput" />
              <i class="fa fa-paint-brush"></i>
            </label>
            <span
              v-for="c in colorOptions"
              :key="c"
              class="notes-preset-color"
              :class="{ selected: editorColor === c }"
              :style="{ backgroundColor: c }"
              :title="c"
              @click="setEditorColor(c)"
            ></span>
          </div>
          <!-- 第二行：状态 / 日期 / 操作（铺满一行，超宽才滚动） -->
          <div class="notes-editor-toolbar">
          <!-- 统一条目：状态 / 日期 / 操作 -->
          <template v-if="editingItem">
            <select class="notes-opt-select" :value="editingItem.status" @change="updateItemStatus($event)" title="状态">
              <option v-if="!hasStatusOption(editingItem.status)" :value="editingItem.status">{{ store.locales === 'zh' ? '其他' : 'Other' }}</option>
              <option v-for="s in statusOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
            <template v-if="editingItem.status !== '灵感'">
              <input type="date" class="notes-opt-date" :value="formatDateForInput(editingItem.startTime)" @change="updateStartTime($event, editingItem)" title="开始时间" />
              <input type="date" class="notes-opt-date" :value="formatDateForInput(editingItem.endTime)" @change="updateEndTime($event, editingItem)" title="结束时间" />
            </template>
            <button class="notes-icon-btn" @click="addChildItem(editingItem)" title="添加子项"><i class="fa fa-plus"></i></button>
            <button class="notes-icon-btn" @click="togglePin(editingItem)" :class="{ active: editingItem.pinned }" title="置顶"><i class="fa fa-thumb-tack"></i></button>
            <button class="notes-icon-btn" @click="toggleHide(editingItem)" :class="{ active: editingItem.hidden }" :title="store.locales === 'zh' ? (editingItem.hidden ? '显示' : '隐藏') : (editingItem.hidden ? 'Show' : 'Hide')"><i :class="editingItem.hidden ? 'fa fa-eye-slash' : 'fa fa-eye'"></i></button>
            <button class="notes-icon-btn primary" @click="saveEditor" title="保存 (Ctrl+S)"><i class="fa fa-save"></i></button>
            <button class="notes-icon-btn danger" @click="deleteItem(editingItem)" title="删除"><i class="fa fa-trash"></i></button>
          </template>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 设置模态框（ElMessage 风格） -->
  <div v-if="showSettings" class="settings-overlay" @click.self="showSettings = false">
    <div class="settings-modal">
      <div class="settings-modal-header">
        <span class="settings-modal-title">{{ store.locales === 'zh' ? '设置' : 'Settings' }}</span>
        <button class="settings-close" @click="showSettings = false"><i class="fa fa-times"></i></button>
      </div>
      <div class="settings-modal-body">
        <div class="settings-section">
          <div class="settings-label">{{ store.locales === 'zh' ? '状态分类' : 'Status categories' }}</div>
          <div class="stats-crumbs">
            <span class="crumb">
              <span class="crumb-label"><i class="fa fa-sticky-note-o"></i> {{ store.locales === 'zh' ? '总笔记' : 'Total notes' }}</span>
              <span class="crumb-num">{{ statsSummary.totalNotes }}</span>
            </span>
            <span class="crumb" v-for="s in statsSummary.statusCounts" :key="s.value">
              <span class="crumb-label"><i :class="s.icon"></i> {{ s.label }}</span>
              <span class="crumb-num">{{ s.count }}</span>
              <button class="status-chip-remove" @click="removeStatusOption(s.value)" :title="store.locales === 'zh' ? '删除分类' : 'Remove category'"><i class="fa fa-times"></i></button>
            </span>
            <span v-if="statsSummary.undefinedCount > 0" class="crumb" :title="store.locales === 'zh' ? '不属于任何分类的笔记/项目' : 'Entries not in any category'">
              <span class="crumb-label"><i class="fa fa-tag"></i> {{ store.locales === 'zh' ? '其他' : 'Other' }}</span>
              <span class="crumb-num">{{ statsSummary.undefinedCount }}</span>
            </span>
          </div>
          <div class="settings-row">
            <input v-model="newStatusName" class="settings-input" :placeholder="store.locales === 'zh' ? '新分类名称' : 'New category name'" @keyup.enter="addStatusOption" />
            <button class="settings-btn" @click="addStatusOption"><i class="fa fa-plus"></i> {{ store.locales === 'zh' ? '添加' : 'Add' }}</button>
            <button class="settings-btn" @click="resetStatusOptions"><i class="fa fa-refresh"></i> {{ store.locales === 'zh' ? '恢复默认' : 'Reset categories' }}</button>
          </div>
        </div>
        <div class="settings-section">
          <div class="settings-label">{{ store.locales === 'zh' ? '导入 / 导出' : 'Import / Export' }}</div>
          <div class="settings-row">
            <button class="settings-btn" @click="onMigrateLegacyNotes">
              <i class="fa fa-download"></i> {{ store.locales === 'zh' ? '迁移旧版笔记数据' : 'Migrate legacy notes' }}
            </button>
            <button class="settings-btn" @click="importNotesFromFolder">
              <i class="fa fa-folder-open"></i> {{ store.locales === 'zh' ? '导入笔记（从文件夹）' : 'Import notes from folder' }}
            </button>
            <button class="settings-btn" @click="exportNotesToFile">
              <i class="fa fa-upload"></i> {{ store.locales === 'zh' ? '导出笔记（备份）' : 'Export notes (backup)' }}
            </button>
            <button class="settings-btn danger-btn" @click="clearAllEntries">
              <i class="fa fa-trash"></i> {{ store.locales === 'zh' ? '清空笔记' : 'Clear all entries' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 树状图右键菜单（排序 / 添加子项 / 删除），鼠标移出自动关闭 -->
  <div v-if="treeContextMenu.visible" class="tree-context-menu" :style="{ left: treeContextMenu.x + 'px', top: treeContextMenu.y + 'px' }" @mouseleave="closeTreeContextMenu">
    <div class="ctx-item has-sub">
      <i class="fa fa-sort"></i> {{ store.locales === 'zh' ? '排序方式' : 'Sort by' }}
      <i class="fa fa-chevron-right ctx-sub-arrow"></i>
      <div class="ctx-submenu">
        <div class="ctx-item" :class="{ checked: treeSortMode === 'default' }" @click="setTreeSort('default')">{{ store.locales === 'zh' ? '默认（拖拽顺序）' : 'Default' }}</div>
        <div class="ctx-item" :class="{ checked: treeSortMode === 'name' }" @click="setTreeSort('name')">
          {{ store.locales === 'zh' ? '名称' : 'Name' }}
          <span v-if="treeSortMode === 'name'" class="ctx-sort-dir">{{ treeSortDir === 'asc' ? '↑ 正序' : '↓ 倒序' }}</span>
        </div>
        <div class="ctx-item" :class="{ checked: treeSortMode === 'updated' }" @click="setTreeSort('updated')">
          {{ store.locales === 'zh' ? '修改时间' : 'Updated time' }}
          <span v-if="treeSortMode === 'updated'" class="ctx-sort-dir">{{ treeSortDir === 'asc' ? '↑ 正序' : '↓ 倒序' }}</span>
        </div>
        <div class="ctx-item" :class="{ checked: treeSortMode === 'start' }" @click="setTreeSort('start')">
          {{ store.locales === 'zh' ? '开始时间' : 'Start time' }}
          <span v-if="treeSortMode === 'start'" class="ctx-sort-dir">{{ treeSortDir === 'asc' ? '↑ 正序' : '↓ 倒序' }}</span>
        </div>
        <div class="ctx-item" :class="{ checked: treeSortMode === 'end' }" @click="setTreeSort('end')">
          {{ store.locales === 'zh' ? '结束时间' : 'End time' }}
          <span v-if="treeSortMode === 'end'" class="ctx-sort-dir">{{ treeSortDir === 'asc' ? '↑ 正序' : '↓ 倒序' }}</span>
        </div>
        <div class="ctx-item" v-if="!selectedStatus" :class="{ checked: treeSortMode === 'status' }" @click="setTreeSort('status')">
          {{ store.locales === 'zh' ? '状态' : 'Status' }}
          <span v-if="treeSortMode === 'status'" class="ctx-sort-dir">{{ treeSortDir === 'asc' ? '↑ 正序' : '↓ 倒序' }}</span>
        </div>
      </div>
    </div>
    <div class="ctx-item" v-if="currentView === 'tree'" @click="treeMenuAddChild"><i class="fa fa-plus"></i> {{ store.locales === 'zh' ? '添加子项' : 'Add child' }}</div>
    <div class="ctx-item danger" @click="treeMenuDelete"><i class="fa fa-trash"></i> {{ store.locales === 'zh' ? '删除' : 'Delete' }}</div>
  </div>
</div>
</template>

<style scoped>
.bg {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.home {
  width: 100%;
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: row;
  gap: 5px;
  padding: 5px;
  overflow: hidden;
  box-sizing: border-box;
}

/* 左侧面板容器（填满剩余空间） */
.side-column {
  position: relative;
  flex: 1 1 auto;
  min-width: 180px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 拖拽分隔条：浮动在右侧编辑器左边缘，不占布局宽度（right 由模板按 editorWidth 动态绑定） */
.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 2px;
  cursor: col-resize;
  background: transparent;
  border-radius: 2px;
  z-index: 20;
  transition: background 0.15s ease;
}
/* 仅在拖动时显示颜色（不拖动/悬停都保持透明） */
.resize-handle.active {
  background: var(--borderColor);
}

/* ========== 顶部工具栏 ========== */
.top-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  flex-wrap: wrap;
  background: var(--backgroundColor);
  margin-bottom: 5px;
}

.toolbar-sep {
  width: 1px;
  height: 20px;
  background: var(--borderColor);
  margin: 0 2px;
  flex-shrink: 0;
}

/* 工具栏第二行（视图选择 / 分类筛选） */
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-basis: 100%;
  flex-wrap: wrap;
  padding-top: 2px;
}

.toolbar-select {
  height: 28px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  padding: 0 4px;
  cursor: pointer;
  flex-shrink: 0;
  width:auto;
  margin: 0px;
}

.toolbar-action-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  background-color: var(--backgroundColor);
  font-size: 12px;
  padding: 0;
  transition: all 0.15s ease;
}

.toolbar-action-btn:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.toolbar-action-btn.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

/* 视图选择下拉框（最左侧，固定宽度不随 flex 拉伸） */
.view-select {
  flex: 0 0 auto;
  width: 76px;
}

/* ========== 左侧面板：树状图 ========== */
.tree-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  overflow: hidden;
  background: var(--backgroundColor);
}

/* 左侧面板：笔记列表（简单模式 / 瀑布流），宽时可多列 */
.notes-list-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  overflow: hidden;
  background: var(--backgroundColor);
}

/* 右侧编辑器：固定像素宽度（不随窗口拉伸），宽度由拖拽调整 */
.notes-editor-panel {
  flex: 0 0 auto;
  min-width: 240px;
  max-width: 70%;
}

.notes-editor {
  height: 100%;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: var(--backgroundColor);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  box-sizing: border-box;
  min-height: 0;
}

.notes-input,
.notes-textarea {
  width: 100%;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  padding: 6px 8px;
  margin: 0px;
  box-sizing: border-box;
  font-family: inherit;
  font-size: 13px;
}

.notes-editor-content {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 编辑器底部选项行：预设颜色一行 + 操作一行 */
.notes-editor-options {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding-top: 6px;
  border-top: 1px solid var(--borderColor);
  flex-wrap: wrap;
}

/* 第二行：状态/日期/操作（flex:1 铺满一行，超宽才横向滚动） */
.notes-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--borderColor) transparent;
}
.notes-editor-toolbar::-webkit-scrollbar {
  height: 4px;
}
.notes-editor-toolbar::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}
.notes-editor-toolbar::-webkit-scrollbar-track {
  background: transparent;
}

.notes-opt-select,
.notes-opt-date {
  height: 22px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  padding: 0 4px;
  cursor: pointer;
  max-width: 100px;
  margin: 0;
  flex-shrink: 0;
}
/* 状态下拉框：撑满所在行剩余宽度 */
.notes-opt-select {
  flex: 1;
  flex-shrink: 1;
  min-width: 60px;
  max-width: none;
}

.notes-icon-btn.danger {
  color: #e74c3c;
}
.notes-icon-btn.danger:hover {
  background: #fde8e8;
  color: #c0392b;
}

.notes-textarea {
  flex: 1;
  resize: none;
  min-height: 0;
  overflow-y: auto;
}

.notes-block-editor-host {
  overflow: hidden;
  padding: 0;
}

/* 标题栏：输入框 + 右侧图标按钮 */
.notes-editor-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.notes-editor-title .notes-input {
  flex: 1;
  min-width: 0;
  width: auto;
}

.notes-editor-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 标题栏右侧图标按钮 */
.notes-icon-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  flex-shrink: 0;
  transition: all 0.15s ease;
}
.notes-icon-btn:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
/* 置顶等激活态：强调色边框（与工具栏 active 一致） */
.notes-icon-btn.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.notes-icon-btn.primary {
  background: var(--menuColor);
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}
.notes-icon-btn.primary:hover {
  background-color: var(--menuActiveColor);
}

/* 颜色设置：取色器（与预设色块均分颜色行宽度） */
.notes-color-btn {
  position: relative;
  flex: 1;
  min-width: 16px;
  max-width: none;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--borderColor);
  border-radius: 3px;
  box-sizing: border-box;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.15s ease;
}
.notes-color-btn:hover {
  border-color: var(--fontActiveColor);
}
.notes-color-btn input[type="color"] {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border: none;
  padding: 0;
  opacity: 0;
  cursor: pointer;
}
.notes-color-btn i {
  font-size: 9px;
  color: #fff;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 50%;
  width: 10px;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

/* 预设颜色：单独一行（超宽横向滚动，不换行） */
.notes-preset-colors {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-basis: 100%;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--borderColor) transparent;
  padding-bottom: 2px;
}
.notes-preset-colors::-webkit-scrollbar {
  height: 4px;
}
.notes-preset-colors::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}
.notes-preset-colors::-webkit-scrollbar-track {
  background: transparent;
}
.notes-preset-color {
  flex: 1;
  min-width: 14px;
  height: 14px;
  border-radius: 3px;
  cursor: pointer;
  border: 2px solid transparent;
  box-sizing: border-box;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.notes-preset-color:hover {
  transform: scale(1.15);
  border-color: var(--fontActiveColor);
}
.notes-preset-color.selected {
  border-color: var(--fontActiveColor);
  box-shadow: 0 0 0 1px var(--fontActiveColor);
}

/* 笔记侧边栏工具栏：搜索 + 新建（参照 home 侧边栏） */
.notes-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 5px 0 5px;
  flex-shrink: 0;
}

.notes-search-toggle {
  flex: 2;
  min-width: 0;
  height: 26px;
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
.notes-search-toggle:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.notes-search-box {
  flex: 1;
  min-width: 0;
  height: 26px;
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
.notes-search-box > i {
  flex-shrink: 0;
  font-size: 12px;
}
.notes-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.notes-search-clear {
  flex-shrink: 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--borderColor);
}
.notes-search-clear:hover {
  color: var(--fontActiveColor);
}

.notes-new-btn {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
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
.notes-new-btn:hover {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.notes-new-btn.active {
  background-color: var(--menuActiveColor);
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}

.notes-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 2px 0;
}

.notes-list-title {
  font-weight: 600;
  font-size: 13px;
}

.notes-list-count {
  font-size: 11px;
  opacity: 0.7;
}

.notes-list {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 4px;
  align-content: start;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  padding: 5px;
}

.note-card {
  border: 1px solid var(--borderColor);
  border-left: 3px solid var(--borderColor);
  border-radius: 4px;
  padding: 4px 6px;
  background: var(--backgroundColor);
  display: flex;
  flex-direction: column;
  gap: 3px;
  cursor: pointer;
  transition: all 0.15s ease;
  position: relative;
}

.note-card:hover {
  background-color: var(--menuActiveColor);
}

.note-card.active {
  border-color: var(--fontActiveColor);
  background-color: var(--menuColor);
}

.note-card.pinned {
  border-left-color: var(--fontActiveColor);
}

/* 瀑布流项目卡片：状态色块 + 图标 */
.note-card .note-card-color {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.note-card .note-card-color i {
  font-size: 9px;
  color: var(--fontColor);
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
}

.note-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  width: 100%;
  position: relative;
}

.note-card-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

/* 时间默认显示在最右侧；悬浮时隐藏，让图标按钮占据最右（参照 home 侧边栏） */
.note-card-time {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--fontColor);
  white-space: nowrap;
  margin-left: 4px;
}
.note-card:hover .note-card-time {
  display: none;
}

/* 操作按钮默认折叠隐藏（不占位，时间因此位于最右），悬浮时展开显示 */
.note-card-actions {
  display: flex;
  align-items: center;
  gap: 0;
  flex-shrink: 0;
}

.note-action-btn {
  width: 0;
  height: 20px;
  margin-left: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
  transition: opacity 0.2s, width 0.15s ease, margin-left 0.15s ease;
}
.note-card:hover .note-action-btn {
  width: 20px;
  margin-left: 2px;
  opacity: 0.6;
  pointer-events: auto;
}
.note-action-btn:hover {
  opacity: 1 !important;
  color: var(--fontActiveColor);
}
.note-action-btn.active {
  width: 20px;
  margin-left: 2px;
  opacity: 1;
  pointer-events: auto;
  color: var(--fontActiveColor);
}

/* 笔记列表空状态（紧凑） */
.notes-list .empty-state {
  grid-column: 1 / -1;
}
.notes-list .empty-state i {
  font-size: 32px;
  margin-bottom: 8px;
}
.notes-list .empty-state p {
  font-size: 12px;
}


/* ========== 瀑布流视图 ========== */
.grid-scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 5px;
  position: relative;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: var(--backgroundColor);
}

.grid-container {
  display: grid;
  grid-template-columns: repeat(var(--column-count, 3), 1fr);
  gap: 5px;
  padding-bottom: 5px;
}

.grid-column {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.grid-card {
  position: relative;
  border: 1px solid var(--borderColor);
  border-left: 5px solid var(--borderColor);
  border-radius: 5px;
  padding: 3px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--backgroundColor);
  width: 100%;
  box-sizing: border-box;
  break-inside: avoid;
}

.grid-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.grid-card-content {
  flex: 1;
  margin: 3px 0px;
  line-height: 1.5;
  font-size: 14px;
  color: var(--fontColor);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  max-height: 200px;
  overflow-y: auto;
}

.grid-card-title {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
  color: var(--fontColor);
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  flex-direction: row;
  line-clamp: 3;
  max-height: 4.5em;
}

.grid-card-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px;
  font-size: 11px;
  text-align: right;
}

.grid-card-dates {
  margin: 0;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.8;
}

.date-range {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--menuActiveColor);
  border-radius: 3px;
  padding: 3px 6px;
}

.date-range i {
  font-size: 10px;
}

.date-text {
  white-space: nowrap;
}

.date-separator {
  opacity: 0.6;
}

.list-container {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 5px;
}

.list-item {
  border: 1px solid var(--borderColor);
  border-left: 5px solid var(--borderColor);
  border-radius: 5px;
  padding: 5px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--backgroundColor);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.list-item:hover {
  transform: translateX(2px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.list-item-content {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.list-item-title {
  flex: 1;
  font-size: 14px;
  color: var(--fontColor);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.list-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.8;
  flex-wrap: wrap;
  margin-top: 4px;
}

.list-item-dates {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  flex-shrink: 0;
  background: var(--menuActiveColor);
  border-radius: 3px;
  padding: 2px 6px;
}

.list-item-dates i {
  font-size: 10px;
}

/* ========== 树状图视图 ========== */
.tree-container {
  flex: 1;
  overflow-y: auto;
  padding: 5px;
  position: relative;
}

.tree-view {
  min-height: 100%;
}

/* el-tree 树状图 */
.todo-el-tree {
  width: 100%;
  background: transparent;
  --el-tree-node-hover-bg-color: var(--menuActiveColor);
}

.todo-el-tree :deep(.el-tree-node__content) {
  height: 28px;
  background: transparent;
}

.todo-el-tree :deep(.el-tree-node:focus > .el-tree-node__content) {
  background: var(--menuActiveColor);
}

.todo-el-tree :deep(.el-tree-node__expand-icon) {
  color: var(--fontColor);
}

.el-tree-node-custom {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  padding-right: 4px;
}

.el-tree-node-custom .el-tree-color {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.el-tree-node-custom .el-tree-color i {
  font-size: 9px;
  color: var(--fontColor);
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.4);
}

.el-tree-node-custom .el-tree-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fontColor);
}

.el-tree-node-custom.active .el-tree-label {
  color: var(--fontActiveColor);
  font-weight: 600;
}

.el-tree-node-custom .el-tree-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--fontColor);
  opacity: 0.7;
  white-space: nowrap;
}

/* 树状图右键菜单 */
.tree-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 130px;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  padding: 4px;
}
.tree-context-menu .ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  font-size: 12px;
  white-space: nowrap;
}
.tree-context-menu .ctx-item:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.tree-context-menu .ctx-item.danger {
  color: #e74c3c;
}
.tree-context-menu .ctx-item.danger:hover {
  background: #fde8e8;
  color: #c0392b;
}

/* 排序方式二级菜单 */
.tree-context-menu .ctx-item.has-sub {
  position: relative;
}
.tree-context-menu .ctx-submenu {
  display: none;
  position: absolute;
  left: 100%;
  top: -4px;
  min-width: 150px;
  background: var(--menuColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  padding: 4px;
  z-index: 1001;
}
.tree-context-menu .ctx-item.has-sub:hover .ctx-submenu {
  display: block;
}
.tree-context-menu .ctx-sub-arrow {
  margin-left: auto;
  font-size: 10px;
  opacity: 0.6;
}
.tree-context-menu .ctx-item.checked {
  color: var(--fontActiveColor);
}
/* 排序方向指示（正序/倒序箭头） */
.tree-context-menu .ctx-sort-dir {
  margin-left: auto;
  font-size: 10px;
  color: var(--fontActiveColor);
  opacity: 0.9;
}

/* ========== 月历视图 ========== */
.month-container {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-radius: 5px;
  overflow: hidden;
}

.month-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 8px;
  flex-shrink: 0;
  background: var(--menuColor);
  user-select: none;
}

/* 纯图标按钮（无边框，hover 变色） */
.month-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  border-radius: 4px;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.month-icon-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.month-nav {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.month-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fontColor);
  white-space: nowrap;
}
.month-title i {
  font-size: 12px;
  opacity: 0.7;
}

.month-table {
  flex: 1;
  min-height: 0;
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.month-table-body {
  height: 100%;
}

.month-table tr {
  height: 16.66%;
}

.month-table td {
  vertical-align: top;
  padding: 2px;
  width: 14.28%;
  position: relative;
  cursor: pointer;
  border: 1px solid var(--borderColor);
}

.date-cell:hover {
  /* 折叠边框（border-collapse: collapse）下相邻单元格共享边框，
     border-color 只能点亮下/右两侧；改用 inset box-shadow
     在单元格内侧绘制四边高亮环线 */
  box-shadow: inset 0 0 0 1px var(--fontActiveColor);
}

.date-cell.today {
  opacity: 1;
}

.date-cell.selected-date {
  border: var(--fontActiveColor) 2px solid;
  opacity: 1;
}

/* 拖拽悬停目标：点亮内环并加深背景 */
.date-cell.drag-over {
  background: var(--menuActiveColor);
  box-shadow: inset 0 0 0 2px var(--fontActiveColor);
}

.date-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: 10px;
  margin: 2px;
  color: var(--fontColor);
}

.date-title.today {
  color: var(--fontActiveColor);
}

/* 日期右侧：新建按钮 + 数量徽标 */
.date-title-right {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

/* 悬浮单元格时才显示的新建按钮 */
.date-add-btn {
  display: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--fontColor);
  border-radius: 3px;
  cursor: pointer;
  font-size: 9px;
  line-height: 1;
}
.date-title:hover .date-add-btn {
  display: inline-flex;
}
.date-add-btn:hover {
  display: inline-flex;
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

/* 日期项目数量徽标（使用 borderColor 颜色，无项目不显示） */
.date-count {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: var(--borderColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  min-width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
  box-sizing: border-box;
}

.date-items {
  /* 减去标题高度并留出少许余量，防止滚动区溢出盖住底部边框 */
  height: calc(100% - 22px);
  overflow-y: auto;
  /* 显式禁掉横向滚动，内容超宽时裁剪而不是出现横向滑块 */
  overflow-x: hidden;
}

.task-span {
  position: relative;
  z-index: 1;
  font-size: 10px;
  cursor: grab;
  width: calc(100% - 14px);
  border-radius: 2px;
  margin-bottom: 2px;
  padding: 4px;
  border-left: 3px solid;
}

.task-span:active {
  cursor: grabbing;
}

/* 拖拽中的源卡片：半透明提示 */
.task-span.dragging {
  opacity: 0.5;
}

.task-span-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.task-span-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* 任务卡片删除按钮：默认隐藏（不占位），悬浮显示（与随手记逻辑一致） */
.task-span-del-btn {
  width: 0;
  height: 16px;
  margin-left: 0;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
  flex-shrink: 0;
  transition: opacity 0.2s, width 0.15s ease, margin-left 0.15s ease;
}
.task-span:hover .task-span-del-btn {
  width: 16px;
  margin-left: 2px;
  opacity: 0.7;
  pointer-events: auto;
}
.task-span-del-btn:hover {
  opacity: 1 !important;
  color: #e74c3c;
  background: #fde8e8;
}

/* ========== 周视图 ========== */
.week-container {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-radius: 5px;
  overflow: hidden;
}

.week-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 8px;
  flex-shrink: 0;
  background: var(--menuColor);
  user-select: none;
}

.week-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fontColor);
  white-space: nowrap;
}
.week-title i {
  font-size: 12px;
  opacity: 0.7;
}

/* 周视图表头：只显示周次（日期已在日期单元格的 date-title 中展示） */
.week-table th {
  font-size: 12px;
  padding: 3px 6px;
  white-space: nowrap;
  vertical-align: middle;
}
.week-table .week-head-today {
  color: var(--fontActiveColor);
}

/* 周视图只有一行：撑满容器高度 */
.week-container .month-table tr {
  height: 100%;
}

/* 周视图单元格内容更大，便于查看 */
.week-container .date-title {
  font-size: 13px;
  font-weight: 600;
  margin: 4px 6px;
}
/* 周视图标题更大，预留更多高度，避免滚动区盖住底部边框 */
.week-container .date-items {
  height: calc(100% - 30px);
}
.week-container .task-span {
  font-size: 11px;
  padding: 5px 6px;
}

/* ========== 右侧面板 ========== */
.right-panel {
  width: 200px;
  border-left: 1px solid var(--borderColor);
  background: var(--backgroundColor);
  overflow: hidden;
}

/* ========== 属性编辑界面 - 保持原有紧凑样式 ========== */
.property {
  width: calc(100% - 10px);
  height: calc(100% - 10px);
  padding: 5px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.property-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--borderColor);
}

.property-title {
  margin: 0;
  font-size: 16px;
  color: var(--fontColor);
}

.property-close-btn {
  margin: 0px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
}

.property-close-btn:hover {
  background: var(--menuActiveColor);
}

.property-content {
  flex: 1;
}

.property-field {
  margin: 5px 0px;
  display: flex;
  flex-direction: column;
}

.property-label {
  display: block;
  font-size: 12px;
  color: var(--fontColor);
  margin-bottom: 2px;
}

.property-input {
  width: calc(100% - 10px);
  min-height: 50px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 14px;
  margin: 0px;
  padding: 4px;
  resize: vertical;
  font-family: inherit;
}

.property-date-input {
  width: calc(100% - 10px);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 14px;
  margin: 0px;
  padding: 4px;
}

.property-select {
  width: calc(100% - 2px);
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 14px;
  margin: 0px;
  padding: 6px;
}

.color-picker {
  margin: 0px;
  width: calc(100% - 0px);
}

.color-options {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin-bottom: 8px;
}

.color-option {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid transparent;
  transition: transform 0.2s;
}

.color-option:hover {
  transform: scale(1.1);
  border-color: var(--fontActiveColor);
}

.color-option.selected {
  border-color: var(--fontActiveColor);
}

.color-option-check {
  color: white;
  font-size: 12px;
  text-shadow: 0 0 2px rgba(0,0,0,0.5);
}

.color-input {
  width: calc(100% - 0px);
  height: 32px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  cursor: pointer;
  margin: 0px;
}

.property-btn {
  width: calc(100% - 12px);
  cursor: pointer;
  padding: 5px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
}

.property-btn:hover {
  background: var(--menuActiveColor);
}

/* ========== 空状态样式 ========== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--fontColor);
  opacity: 0.5;
  text-align: center;
}

.empty-state.full-size {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
}

.empty-state i {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-hint {
  font-size: 12px;
  margin-top: 8px;
  opacity: 0.7;
}

/* ========== 设置模态框 ========== */
.settings-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}

.settings-modal {
  min-width: 360px;
  max-width: 600px;
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

.settings-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}

.settings-modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fontColor);
}

.settings-close {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.settings-close:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}

.settings-modal-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 统计数据：紧凑的面包屑式胶囊 */
.stats-crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.crumb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 11px;
  background: var(--menuColor);
  color: var(--fontColor);
  font-size: 12px;
  white-space: nowrap;
}
.crumb-num {
  font-weight: 600;
  color: var(--fontActiveColor);
}
.crumb-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  opacity: 0.85;
}
.crumb-label i {
  font-size: 9px;
  opacity: 0.7;
}

.settings-label {
  font-size: 12px;
  color: var(--fontColor);
  opacity: 0.8;
}

.settings-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.settings-folder {
  font-size: 11px;
  color: var(--borderColor);
  word-break: break-all;
}

.settings-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
}
.settings-btn:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
/* 危险操作按钮（清空等） */
.settings-btn.danger-btn {
  color: #e74c3c;
  border-color: #e74c3c;
}
.settings-btn.danger-btn:hover {
  background: #fde8e8;
  color: #c0392b;
}

/* 状态分类管理 */
.settings-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  padding: 0 8px;
  box-sizing: border-box;
  margin: 0;
}
/* 分类胶囊内的删除按钮（统计与管理合并后） */
.status-chip-remove {
  width: 14px;
  height: 14px;
  border: none;
  background: transparent;
  color: var(--fontColor);
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  opacity: 0.6;
  padding: 0;
  margin-left: 2px;
}
.status-chip-remove:hover {
  opacity: 1;
  color: #e74c3c;
}

/* ========== 滚动条样式 ========== */
.scoll::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.scoll::-webkit-scrollbar-track {
  background: transparent;
}

.scoll::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 3px;
}

.scoll::-webkit-scrollbar-thumb:hover {
  background: var(--fontActiveColor);
}
</style>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store/index'
import BlockEditor from '@/components/knowFile/view/block/BlockEditor.vue'

const store = usestore()

// 类型定义
type ViewMode = 'notes' | 'tree' | 'month' | 'week';
type ItemStatus = string;

interface Item {
  id: number;
  title: string;
  content?: string;
  status: ItemStatus;
  createdTime: Date;
  startTime?: Date;
  endTime?: Date;
  updatedAt?: Date;
  color?: string;
  parentId?: number;
  // 导入时暂存的父级标题（用于合并后重新关联父子结构，不会持久化）
  parentTitle?: string;
  children?: Item[];
  expanded?: boolean;
  relatedId?: number;
  _order?: number;
  filePath?: string;
  isFolder?: boolean;
  pinned?: boolean;
  hidden?: boolean;
}

// 视图配置
const viewModes = [
  { id: 'notes' as ViewMode, title: '随手记', icon: 'fa fa-sticky-note-o' },
  { id: 'tree' as ViewMode, title: '树状图', icon: 'fa fa-sitemap' },
  { id: 'month' as ViewMode, title: '月视图', icon: 'fa fa-map-o' },
  { id: 'week' as ViewMode, title: '周视图', icon: 'fa fa-calendar-o' }
] as const;

// 状态分类（可自定义，localStorage 持久化），默认六类
const STATUS_OPTIONS_KEY = 'todo-status-options';
const DEFAULT_STATUS_OPTIONS: { value: string; label: string; icon: string }[] = [
  { value: '灵感', label: '灵感', icon: 'fa fa-lightbulb-o' },
  { value: '规划', label: '规划', icon: 'fa fa-sitemap' },
  { value: '待办', label: '待办', icon: 'fa fa-clock-o' },
  { value: '进行中', label: '进行中', icon: 'fa fa-spinner fa-spin' },
  { value: '已完成', label: '已完成', icon: 'fa fa-check-circle-o' }
];
const statusOptions = ref<{ value: string; label: string; icon: string }[]>([]);
const newStatusName = ref('');

function loadStatusOptions() {
  try {
    const raw = localStorage.getItem(STATUS_OPTIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        // 移除已废弃的"归档"分类（归档已改为独立的显示/隐藏状态）
        statusOptions.value = parsed.filter(o => o && o.value !== '归档');
        // 兼容旧数据：补齐缺失的默认分类
        let changed = false;
        for (const def of DEFAULT_STATUS_OPTIONS) {
          if (!statusOptions.value.some(o => o.value === def.value)) {
            statusOptions.value.push({ ...def });
            changed = true;
          }
        }
        if (changed) saveStatusOptions();
        return;
      }
    }
  } catch (e) { console.error('加载状态分类失败:', e); }
  statusOptions.value = DEFAULT_STATUS_OPTIONS.map(o => ({ ...o }));
}
function saveStatusOptions() {
  localStorage.setItem(STATUS_OPTIONS_KEY, JSON.stringify(statusOptions.value));
}
// 添加自定义分类
function addStatusOption() {
  const name = newStatusName.value.trim();
  if (!name) return;
  if (statusOptions.value.some(o => o.value === name)) {
    ElMessage.warning(store.locales === 'zh' ? '该分类已存在' : 'Category already exists');
    return;
  }
  statusOptions.value.push({ value: name, label: name, icon: 'fa fa-tag' });
  newStatusName.value = '';
  saveStatusOptions();
}
// 删除自定义分类（已使用该分类的笔记/项目将自动计入"其他"）
function removeStatusOption(value: string) {
  statusOptions.value = statusOptions.value.filter(o => o.value !== value);
  if (selectedStatus.value === value) selectedStatus.value = '';
  saveStatusOptions();
}
// 恢复默认分类
function resetStatusOptions() {
  statusOptions.value = DEFAULT_STATUS_OPTIONS.map(o => ({ ...o }));
  saveStatusOptions();
}

// 响应式变量
const VIEW_STORAGE_KEY = 'todo-full-view';
const STATUS_STORAGE_KEY = 'todo-status-filter';

// 当前视图：随手记 / 树状图 / 瀑布流 / 月视图（默认随手记）
const currentView = ref<ViewMode>('notes');
// 分类筛选（原 header 中的状态筛选，改为下拉框；默认灵感）
const selectedStatus = ref('灵感');
// 显示/隐藏筛选（默认只显示；'hidden' 只看隐藏；'all' 全部显示）
const VISIBILITY_FILTER_KEY = 'todo-visibility-filter';
const visibilityFilter = ref<'show' | 'hidden' | 'all'>('show');
// 树状图排序方式（右键菜单选择，localStorage 持久化）
const TREE_SORT_KEY = 'todo-tree-sort';
const treeSortMode = ref<'default' | 'name' | 'updated' | 'start' | 'end' | 'status'>('default');
// 排序方向：asc 正序 / desc 倒序（再次点击同项切换）
const TREE_SORT_DIR_KEY = 'todo-tree-sort-dir';
const treeSortDir = ref<'asc' | 'desc'>('desc');

const currentDate = ref(new Date());
const selectedDate = ref(new Date());
// 月视图拖拽：当前拖拽的项目 id / 悬停目标日期（用于高亮）/ 阻止拖放后的误触点击
let dragItemId: number | null = null;
const dragOverDate = ref<Date | null>(null);
let suppressCellClick = false;
const allItems = ref<Item[]>([]);
const nextId = ref(1);
const selectedItem = ref<Item | null>(null);
const searchText = ref('');
const noteSearchActive = ref(false);
const workspacePath = ref<string>('');
const DEFAULT_NOTE_COLOR = '#e9ecef';
const showSettings = ref(false);
const noteEditorHost = ref<HTMLElement | null>(null);
/** 自研块编辑器：传给组件的 Markdown 与组件实例 */
const noteEditorValue = ref('');
const noteBeRef = ref<InstanceType<typeof BlockEditor> | null>(null);
let handleNoteShortcut: ((event: KeyboardEvent) => void) | null = null;

// UI状态：右侧编辑器宽度（可拖拽调整，像素固定；窗口缩放不改变宽度）与引用
const EDITOR_WIDTH_KEY = 'todo-editor-width';
const editorWidth = ref(480);
const homeRef = ref<HTMLElement | null>(null);
// ResizeObserver：容器尺寸变化时按比例同步左右面板
let resizeObserver: ResizeObserver | null = null;
// el-tree 引用与展开状态
const todoTreeRef = ref<any>(null);
const expandedKeys = ref<number[]>([]);

// 颜色选项
const colorOptions = ref([
  '#FF0000', '#00FF00', '#FF6B6B', '#4ECDC4', '#45B7D1',
  '#96CEB4', '#FFEAA7', '#DDA0DD', '#FDCB6E', '#A29BFE',
  '#FD79A8', '#00B894', '#e9ecef', '#cce5ff', '#d4edda'
]);

// 保存状态管理
let lastSavedTitle = '';
let lastSavedContent = '';
let hasUnsavedChanges = false;

// 计算属性 - 筛选条目（随手记视图：所有条目，支持分类/搜索/排序方式/正倒序）
const filteredEntries = computed(() => {
  const q = searchText.value.trim().toLowerCase();
  const dir = treeSortDir.value === 'asc' ? 1 : -1;
  return allItems.value
    .filter((item: Item) => {
      const statusMatch = statusFilterMatch(item.status);
      const visibleMatch = visibilityMatch(item);
      const searchMatch = !q ||
        (item.title || '').toLowerCase().includes(q) ||
        (item.content || '').toLowerCase().includes(q);
      return statusMatch && visibleMatch && searchMatch;
    })
    .sort((a: Item, b: Item) => {
      // 置顶优先（不受方向影响）
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      // 其余按排序方式 × 方向
      switch (treeSortMode.value) {
        case 'name':
          return dir * (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN');
        case 'updated': {
          const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : new Date(a.createdTime).getTime();
          const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : new Date(b.createdTime).getTime();
          return dir * (tb - ta);
        }
        case 'start': {
          const ta = a.startTime ? new Date(a.startTime).getTime() : new Date(a.createdTime).getTime();
          const tb = b.startTime ? new Date(b.startTime).getTime() : new Date(b.createdTime).getTime();
          return dir * (tb - ta);
        }
        case 'end': {
          const ta = a.endTime ? new Date(a.endTime).getTime() : (a.startTime ? new Date(a.startTime).getTime() : new Date(a.createdTime).getTime());
          const tb = b.endTime ? new Date(b.endTime).getTime() : (b.startTime ? new Date(b.startTime).getTime() : new Date(b.createdTime).getTime());
          return dir * (tb - ta);
        }
        case 'status': {
          const rank = (s: string) => {
            const i = statusOptions.value.findIndex(o => o.value === s);
            return i < 0 ? statusOptions.value.length : i;
          };
          return dir * (rank(a.status) - rank(b.status));
        }
        default: {
          const ta = a.startTime ? new Date(a.startTime).getTime() : new Date(a.createdTime).getTime();
          const tb = b.startTime ? new Date(b.startTime).getTime() : new Date(b.createdTime).getTime();
          return dir * (tb - ta); // 默认：按时间
        }
      }
    });
});

// 统计数据（设置面板展示，笔记与项目已统一）
const statsSummary = computed(() => {
  const all = allItems.value;
  const statusCounts = statusOptions.value.map(o => ({
    value: o.value,
    label: o.label,
    icon: o.icon,
    count: all.filter(i => i.status === o.value).length
  }));
  const undefinedCount = all.filter(i => !statusOptions.value.some(o => o.value === i.status)).length;
  return {
    noteCount: all.length,
    itemCount: all.length,
    totalNotes: all.length,
    statusCounts,
    undefinedCount
  };
});

// 树状图排序：default（拖拽顺序）/ 名称 / 时间 / 状态（支持正倒序）
function sortTreeChildren(a: Item, b: Item): number {
  const dir = treeSortDir.value === 'asc' ? 1 : -1;
  switch (treeSortMode.value) {
    case 'name':
      return dir * (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN');
    case 'updated': {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : new Date(a.createdTime).getTime();
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : new Date(b.createdTime).getTime();
      return dir * (ta - tb);
    }
    case 'start': {
      const ta = a.startTime ? new Date(a.startTime).getTime() : new Date(a.createdTime).getTime();
      const tb = b.startTime ? new Date(b.startTime).getTime() : new Date(b.createdTime).getTime();
      return dir * (ta - tb);
    }
    case 'end': {
      const ta = a.endTime ? new Date(a.endTime).getTime() : (a.startTime ? new Date(a.startTime).getTime() : new Date(a.createdTime).getTime());
      const tb = b.endTime ? new Date(b.endTime).getTime() : (b.startTime ? new Date(b.startTime).getTime() : new Date(b.createdTime).getTime());
      return dir * (ta - tb);
    }
    case 'status': {
      const rank = (s: string) => {
        const i = statusOptions.value.findIndex(o => o.value === s);
        return i < 0 ? statusOptions.value.length : i;
      };
      return dir * (rank(a.status) - rank(b.status));
    }
    default: {
      const aOrder = a._order !== undefined ? a._order : a.id;
      const bOrder = b._order !== undefined ? b._order : b.id;
      return aOrder - bOrder;
    }
  }
}

// 树状图项目计算
const treeItems = computed({
  get() {
    if (!allItems.value.length) return [];
    
    // 先根据筛选条件过滤项目，但注意：这里需要保持父子关系
    // 所以我们不能直接过滤，而是需要先找出所有符合条件的项目及其祖先
    let visibleItems = new Set<number>();

    // 找出所有符合条件的项目（始终计算）
    allItems.value.forEach(item => {
      // 显示/隐藏筛选：显示模式排除隐藏分支，隐藏模式只看隐藏分支，全部模式不限
      if (visibilityFilter.value === 'show' && isInHiddenBranch(item)) return;
      if (visibilityFilter.value === 'hidden' && !isInHiddenBranch(item)) return;
      const statusMatch = statusFilterMatch(item.status);
      const searchMatch = !searchText.value || 
        item.title?.toLowerCase().includes(searchText.value.toLowerCase()) ||
        item.content?.toLowerCase().includes(searchText.value.toLowerCase());

      if (statusMatch && searchMatch) {
        // 添加这个项目及其所有祖先（显式检查 parentId 是否未定义）
        let current: Item | undefined = item;
        while (current) {
          visibleItems.add(current.id);
          if (current.parentId !== undefined && current.parentId !== null) {
            current = allItems.value.find(i => i.id === current!.parentId);
          } else {
            break;
          }
        }
      }
    });
    
    // 构建树结构
    const buildTreeFromItems = (parentId?: number): Item[] => {
      return allItems.value
        .filter(item => {
          // 过滤父子关系（严格判断 parentId 是否未定义）
          if (parentId === undefined) {
            // 顶层：无 parentId，或父级已不存在（孤立项兜底显示为顶层，避免数据在树状图中“消失”）
            if (item.parentId === undefined || item.parentId === null) return true;
            const parentExists = allItems.value.some(p => p.id === item.parentId);
            return !parentExists;
          }
          return item.parentId === parentId;
        })
        .filter(item => {
          // 只显示可见的项目（含分类筛选与显示/隐藏筛选）
          return visibleItems.has(item.id);
        })
        .sort(sortTreeChildren)
        .map(item => {
          // 递归获取子项
          const children = buildTreeFromItems(item.id);
          
          return {
            ...item,
            expanded: item.expanded !== undefined ? item.expanded : true,
            children: children
          };
        });
    };
    
    return buildTreeFromItems();
  },
  set(newItems: Item[]) {
    // 只在拖拽排序时保存，不保存展开/折叠状态
    const hasOrderChanged = newItems.some((item, index) => {
      const existingItem = allItems.value.find(i => i.id === item.id);
      return existingItem && existingItem._order !== index;
    });
    
    if (hasOrderChanged) {
      newItems.forEach((item, index) => {
        const existingItem = allItems.value.find(i => i.id === item.id);
        if (existingItem) {
          existingItem._order = index;
          existingItem.parentId = undefined;
        }
      });
      // 强制刷新并保存到 localStorage
      allItems.value = [...allItems.value];
      saveItemsToStorage();
    }
  }
});

// 日期相关计算属性
const currentYear = computed(() => currentDate.value.getFullYear());
const currentMonth = computed(() => {
  return currentDate.value.toLocaleString('default', { month: 'long'}) + (' ' + currentYear.value);
});
const firstDayOfMonth = computed(() => new Date(currentYear.value, currentDate.value.getMonth(), 1));
const daysOfWeek = computed(() => ['日', '一', '二', '三', '四', '五', '六']);

const dates = computed(() => {
  const datesArr: any[] = [];
  const firstDay = new Date(firstDayOfMonth.value);
  const firstDayOfWeek = firstDay.getDay();
  const prevMonthLastDate = new Date(currentYear.value, currentDate.value.getMonth(), 0).getDate();
  
  for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const day = prevMonthLastDate - i;
    const prevMonthDate = new Date(currentYear.value, currentDate.value.getMonth() - 1, day);
    datesArr.push({
      day,
      isCurrentMonth: false,
      dateObject: prevMonthDate
    });
  }
  
  const lastDay = new Date(currentYear.value, currentDate.value.getMonth() + 1, 0);
  const lastDate = lastDay.getDate();
  for (let i = 1; i <= lastDate; i++) {
    const currentDateObj = new Date(currentYear.value, currentDate.value.getMonth(), i);
    datesArr.push({
      day: i,
      isCurrentMonth: true,
      dateObject: currentDateObj
    });
  }
  
  const remainingDays = 7 - (datesArr.length % 7);
  if (remainingDays < 7) {
    for (let i = 1; i <= remainingDays; i++) {
      const nextMonthDate = new Date(currentYear.value, currentDate.value.getMonth() + 1, i);
      datesArr.push({
        day: i,
        isCurrentMonth: false,
        dateObject: nextMonthDate
      });
    }
  }
  
  return datesArr;
});

const weeks = computed(() => {
  const weeksArr: any[][] = [];
  const datesArr = [...dates.value];
  while (datesArr.length) {
    weeksArr.push(datesArr.splice(0, 7));
  }
  return weeksArr;
});

// 周视图：当前周日期（周日~周六，与月视图表头一致）
const weekDays = computed(() => {
  const days: Date[] = [];
  const start = new Date(currentDate.value);
  start.setDate(start.getDate() - start.getDay());
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
});

// 周视图标题：日期范围 + 周序号
const currentWeekLabel = computed(() => {
  const start = weekDays.value[0];
  const end = weekDays.value[6];
  const sYear = start.getFullYear();
  const sMonth = start.getMonth() + 1;
  const eYear = end.getFullYear();
  const eMonth = end.getMonth() + 1;
  let range: string;
  if (sYear === eYear && sMonth === eMonth) {
    range = `${sYear}年${sMonth}月${start.getDate()}日 - ${end.getDate()}日`;
  } else if (sYear === eYear) {
    range = `${sYear}年${sMonth}月${start.getDate()}日 - ${eMonth}月${end.getDate()}日`;
  } else {
    range = `${sYear}年${sMonth}月${start.getDate()}日 - ${eYear}年${eMonth}月${end.getDate()}日`;
  }
  return `${range} · 第${getISOWeekNumber(start)}周`;
});

// ISO 周序号
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

// 周视图日期显示：月份/日（跨月时清晰区分）
function formatMonthDay(date: Date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// 当前正在编辑的条目（统一：笔记与项目一体）
const editingItem = computed(() => selectedItem.value);

// 编辑器绑定：统一编辑 selectedItem
const editorTitle = computed({
  get: () => selectedItem.value ? selectedItem.value.title : '',
  set: (value: string) => { if (selectedItem.value) selectedItem.value.title = value; }
});

const editorContent = computed({
  get: () => selectedItem.value ? (selectedItem.value.content || '') : '',
  set: (value: string) => { if (selectedItem.value) selectedItem.value.content = value; }
});

const editorColor = computed({
  get: () => selectedItem.value ? (selectedItem.value.color || DEFAULT_NOTE_COLOR) : DEFAULT_NOTE_COLOR,
  set: (value: string) => { if (selectedItem.value) selectedItem.value.color = value; }
});

// ========== 编辑器底层（自研块编辑器，见 src/lib/blockeditor） ==========
function initNoteEditor() {
  if (!noteEditorHost.value) return;
  // 首次挂载：把当前条目内容灌入编辑器
  noteEditorValue.value = editorContent.value || '';
}

function destroyNoteEditor() {
  // 生命周期由 Vue 管理（v-if / doc-key），无需手动销毁
}

/** 条目内容变化（切换条目 / 外部修改）时同步给编辑器 */
function syncNoteEditorContent() {
  noteEditorValue.value = editorContent.value || '';
}

/** 编辑器内容变化 → 写回当前条目（不落盘，落盘由 saveEditor 负责） */
function onNoteEditorChange(markdown: string) {
  if (selectedItem.value) {
    selectedItem.value.content = markdown;
  }
  hasUnsavedChanges = true;
}

// ========== 统一存储（localStorage 单一数据源，笔记 + 项目一体） ==========
const ENTRIES_KEY = 'todo-entries-v1';

// 从 localStorage 加载统一条目（笔记/项目一体）
function loadItemsFromStorage() {
  try {
    const raw = localStorage.getItem(ENTRIES_KEY);
    if (!raw) {
      allItems.value = [];
      nextId.value = 1;
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      allItems.value = [];
      nextId.value = 1;
      return;
    }
    allItems.value = parsed.map((it: any) => {
      // 兼容旧数据：原“归档”状态迁移为独立隐藏标记（hidden: true），状态归回默认
      const archived = it.status === '归档';
      return {
        id: it.id,
        title: it.title || '无标题',
        content: it.content || '',
        status: archived ? '灵感' : (typeof it.status === 'string' && it.status ? it.status : '灵感'),
        createdTime: it.createdTime ? new Date(it.createdTime) : new Date(),
        updatedAt: it.updatedAt ? new Date(it.updatedAt) : undefined,
        startTime: it.startTime ? new Date(it.startTime) : undefined,
        endTime: it.endTime ? new Date(it.endTime) : undefined,
        color: typeof it.color === 'string' ? it.color : undefined,
        parentId: typeof it.parentId === 'number' ? it.parentId : undefined,
        expanded: it.expanded !== undefined ? Boolean(it.expanded) : true,
        relatedId: typeof it.relatedId === 'number' ? it.relatedId : undefined,
        _order: typeof it._order === 'number' ? it._order : undefined,
        filePath: typeof it.filePath === 'string' ? it.filePath : undefined,
        isFolder: Boolean(it.isFolder),
        pinned: Boolean(it.pinned),
        hidden: Boolean(it.hidden) || archived
      };
    });
    let maxId = 0;
    allItems.value.forEach(i => { if (i.id > maxId) maxId = i.id; });
    nextId.value = maxId + 1;
  } catch (error) {
    console.error('加载统一数据失败:', error);
    allItems.value = [];
  }
}

// 保存全部条目到 localStorage（children 为运行时结构，不序列化）
function saveItemsToStorage() {
  const data = allItems.value.map(i => {
    const d: any = {
      id: i.id,
      title: i.title,
      content: i.content,
      status: i.status,
      createdTime: i.createdTime instanceof Date ? i.createdTime.toISOString() : i.createdTime,
      updatedAt: i.updatedAt instanceof Date ? i.updatedAt.toISOString() : i.updatedAt,
      color: i.color,
      parentId: i.parentId,
      expanded: i.expanded,
      relatedId: i.relatedId,
      _order: i._order,
      filePath: i.filePath,
      isFolder: i.isFolder,
      pinned: i.pinned,
      hidden: Boolean(i.hidden)
    };
    if (i.startTime instanceof Date) d.startTime = i.startTime.toISOString();
    if (i.endTime instanceof Date) d.endTime = i.endTime.toISOString();
    return d;
  });
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(data));
}

// 设置面板：迁移旧版数据（手动选择文件夹导入 .md）
async function onMigrateLegacyNotes() {
  const folder = await window.ipcRenderer.invoke('openFolderDialog');
  if (!folder) return;
  const folderNotes = await readNotesFromFolder(normalizePath(folder));
  if (folderNotes.length === 0) {
    ElMessage.info(store.locales === 'zh' ? '所选文件夹中没有 .md 笔记文件' : 'No .md note files found in the folder');
    return;
  }
  let imported = 0;
  for (const fn of folderNotes) {
    // 按文件路径去重：同一文件不重复导入；标题相同的不同文件保留为独立条目
    const byPath = fn.filePath ? allItems.value.find(n => n.filePath === fn.filePath) : undefined;
    if (byPath) { Object.assign(byPath, fn); imported++; continue; }
    allItems.value.push(fn);
    imported++;
  }
  // 合并后重新按标题关联父子结构，避免产生悬空的 parentId
  relinkImportedParents(folderNotes);
  saveItemsToStorage();
  ElMessage.success(store.locales === 'zh' ? `已导入 ${imported} 条旧版数据` : `Imported ${imported} legacy entries`);
}

// ========== 条目文件读写（导入 / 导出用，日常保存走 localStorage） ==========

// 解析 frontmatter（简单行式解析）
function parseFrontmatter(block: string): Record<string, any> {
  const result: Record<string, any> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (value === 'true') result[key] = true;
    else if (value === 'false') result[key] = false;
    else if (value !== '' && !isNaN(Number(value))) result[key] = Number(value);
    else result[key] = value;
  }
  return result;
}

// 解析单个 .md 笔记文件（frontmatter + 正文）→ 部分 Item（id 由调用方分配）
// parentTitle 为导出时写入的父级标题，用于导入时恢复树状结构
function parseNoteFile(content: string, filePath: string): (Partial<Item> & { parentTitle?: string }) | null {
  const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n?([\s\S]*)$/);
  let meta: Record<string, any> = {};
  let body = content;
  if (match) {
    meta = parseFrontmatter(match[1]);
    body = (match[2] || '').replace(/^\r?\n/, '');
  }
  const fileName = filePath.split(/[\/\\]/).pop() || '';
  const now = new Date();
  const result: Partial<Item> & { parentTitle?: string } = {
    title: meta.title || fileName.replace(/\.md$/, '') || '无标题',
    content: body.trim(),
    createdTime: meta.createdAt ? new Date(meta.createdAt) : now,
    updatedAt: meta.updatedAt ? new Date(meta.updatedAt) : now,
    startTime: meta.startTime ? new Date(meta.startTime) : undefined,
    endTime: meta.endTime ? new Date(meta.endTime) : undefined,
    _order: typeof meta.order === 'number' ? meta.order : undefined,
    parentTitle: typeof meta.parent === 'string' && meta.parent ? meta.parent : undefined,
    pinned: Boolean(meta.pinned),
    hidden: Boolean(meta.hidden),
    color: typeof meta.color === 'string' && meta.color ? meta.color : undefined,
    status: typeof meta.status === 'string' && meta.status ? meta.status : '灵感',
    filePath,
    expanded: true
  };
  return result;
}

// 写入单个 .md 笔记文件（导出用）；parentTitle 为父级标题，导入时用于恢复结构
async function writeNoteFile(filePath: string, item: Item, parentTitle?: string) {
  const meta: Record<string, any> = {
    title: item.title,
    createdAt: item.createdTime instanceof Date ? item.createdTime.toISOString() : item.createdTime,
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    status: item.status,
    pinned: Boolean(item.pinned),
    hidden: Boolean(item.hidden)
  };
  if (item.color) meta.color = item.color;
  if (item.startTime instanceof Date) meta.startTime = item.startTime.toISOString();
  if (item.endTime instanceof Date) meta.endTime = item.endTime.toISOString();
  if (parentTitle) meta.parent = parentTitle;
  if (item._order !== undefined) meta.order = item._order;
  let content = '---\n';
  for (const [k, v] of Object.entries(meta)) content += `${k}: ${v}\n`;
  content += '---\n';
  if (item.content) content += '\n' + item.content + '\n';
  await window.ipcRenderer.invoke('writeFile', normalizePath(filePath), content);
}

// 从文件夹读取所有 .md 文件为条目，并按目录结构保留层级（文件夹为父节点，子文件挂其下）
async function readNotesFromFolder(folder: string): Promise<Item[]> {
  const loaded: Item[] = [];
  const pendingParents = new Map<number, string>(); // 条目 id -> 父级标题（用于恢复树状结构）
  try {
    const { fileList } = await window.ipcRenderer.invoke('getFilesRelation', folder, 50);

    // 1) 收集所有 .md 文件（兼容大小写）
    const mdFiles: any[] = [];
    for (const file of fileList) {
      const lower = (file.label || '').toLowerCase();
      if (file.type === 'file' && /\.md$/.test(lower)) mdFiles.push(file);
    }
    if (mdFiles.length === 0) return loaded;

    // 2) 找出所有包含 .md 的目录，并为每个目录创建文件夹条目
    const dirItemMap = new Map<string, Item>(); // 目录路径 -> 文件夹条目
    for (const file of mdFiles) {
      const filePath = normalizePath(file.path);
      const dirPath = filePath.split(/[\/\\]/).slice(0, -1).join('\\');
      if (!dirPath || dirItemMap.has(dirPath)) continue;
      const segments = dirPath.split(/[\/\\]/);
      const name = segments[segments.length - 1] || '未命名';
      const parentDir = segments.slice(0, -1).join('\\');
      const item: Item = {
        id: nextId.value++,
        title: name,
        content: '',
        status: '灵感',
        createdTime: new Date(),
        color: getRandomColor(),
        filePath: dirPath,
        expanded: true,
        isFolder: true
      };
      // 父目录若也是条目，建立层级（fileList 按父先子后顺序，父目录已先创建）
      if (parentDir && dirItemMap.has(parentDir)) {
        item.parentId = dirItemMap.get(parentDir)!.id;
      }
      dirItemMap.set(dirPath, item);
      loaded.push(item);
    }

    // 3) 处理每个 .md 文件：.README.md 填充文件夹内容，普通文件挂到所在目录下
    for (const file of mdFiles) {
      const filePath = normalizePath(file.path);
      const dirPath = filePath.split(/[\/\\]/).slice(0, -1).join('\\');
      const lower = (file.label || '').toLowerCase();
      let content = '';
      try { content = await window.ipcRenderer.invoke('readFile', file.path); } catch (e) { console.error('读取笔记文件失败:', file.path, e); continue; }
      const parsed = parseNoteFile(content, filePath);
      if (!parsed) continue;

      // .README.md：作为其所在文件夹条目的内容
      if (lower === '.readme.md') {
        const dirItem = dirItemMap.get(dirPath);
        if (dirItem) {
          dirItem.content = parsed.content;
          dirItem.status = parsed.status || dirItem.status;
          dirItem.createdTime = parsed.createdTime || dirItem.createdTime;
          dirItem.updatedAt = parsed.updatedAt;
          dirItem.color = parsed.color || dirItem.color;
          dirItem.pinned = parsed.pinned;
          dirItem.hidden = parsed.hidden;
        }
        continue;
      }

      // 普通 .md 文件
      const item: Item = {
        id: nextId.value++,
        title: parsed.title || '无标题',
        content: parsed.content,
        status: parsed.status || '灵感',
        createdTime: parsed.createdTime || new Date(),
        updatedAt: parsed.updatedAt,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        color: parsed.color,
        filePath: parsed.filePath,
        expanded: true,
        pinned: parsed.pinned,
        hidden: parsed.hidden,
        _order: parsed._order,
        // 保留父级标题，供导入合并后重新关联（不会持久化）
        parentTitle: parsed.parentTitle
      };
      // frontmatter 中带 parent（父级标题）的：记录待恢复结构，不再挂到目录下
      if (parsed.parentTitle) {
        pendingParents.set(item.id, parsed.parentTitle);
      } else if (dirItemMap.has(dirPath)) {
        // 所在目录若是条目，则作为其子节点
        item.parentId = dirItemMap.get(dirPath)!.id;
      }
      loaded.push(item);
    }

    // 根据 frontmatter 中的 parent 标题恢复树状父子结构
    const titleToItem = new Map<string, Item>();
    for (const it of loaded) {
      if (it.title && !titleToItem.has(it.title)) titleToItem.set(it.title, it);
    }
    for (const [childId, parentTitle] of pendingParents) {
      const child = loaded.find(i => i.id === childId);
      const parent = titleToItem.get(parentTitle);
      if (child && parent && parent.id !== child.id) {
        child.parentId = parent.id;
      }
    }
  } catch (error) {
    console.error('读取文件夹笔记失败:', error);
  }
  return loaded;
}

// 导入合并后统一按 parentTitle 重新关联父级，
// 修复“子项按标题合并进已有条目后，parentId 仍指向已丢弃的导入 id”导致树状图中不可见的问题
function relinkImportedParents(folderNotes: Item[]) {
  const finalByTitle = new Map<string, Item>();
  for (const n of allItems.value) {
    if (n.title && !finalByTitle.has(n.title)) finalByTitle.set(n.title, n);
  }
  for (const fn of folderNotes) {
    if (!fn.parentTitle) continue;
    const parent = finalByTitle.get(fn.parentTitle);
    if (!parent) continue;
    const child = finalByTitle.get(fn.title);
    if (child && parent.id !== child.id) {
      child.parentId = parent.id;
    }
  }
}

// 导出所有条目到文件（备份）
async function exportNotesToFile() {
  const folder = await window.ipcRenderer.invoke('openFolderDialog');
  if (!folder) return;
  const folderPath = normalizePath(folder);
  try {
    await window.ipcRenderer.invoke('ensureDir', folderPath);
    let count = 0;
    for (const item of allItems.value) {
      const name = sanitizeFileName(item.title) || '无标题';
      let candidate = normalizePath(pathJoin(folderPath, `${name}.md`));
      let i = 1;
      while (await fileExists(candidate)) {
        candidate = normalizePath(pathJoin(folderPath, `${name}_${i++}.md`));
      }
      // 记录父级标题，导入时用于恢复树状结构（id 在导入后会重新分配，故用标题关联）
      const parentTitle = item.parentId != null
        ? (allItems.value.find(p => p.id === item.parentId)?.title || '')
        : '';
      await writeNoteFile(candidate, item, parentTitle);
      count++;
    }
    ElMessage.success(store.locales === 'zh' ? `已导出 ${count} 条内容到文件` : `Exported ${count} entries to files`);
  } catch (e) {
    console.error('导出失败:', e);
    ElMessage.error(store.locales === 'zh' ? '导出失败' : 'Export failed');
  }
}

// 导入笔记：从文件夹选择 .md 文件导入为条目（按标题合并去重）
async function importNotesFromFolder() {
  const folder = await window.ipcRenderer.invoke('openFolderDialog');
  if (!folder) return;
  const folderNotes = await readNotesFromFolder(normalizePath(folder));
  if (folderNotes.length === 0) {
    ElMessage.info(store.locales === 'zh' ? '所选文件夹中没有 .md 笔记文件' : 'No .md note files found in the folder');
    return;
  }
  let imported = 0;
  for (const fn of folderNotes) {
    const byTitle = fn.title !== '无标题' ? allItems.value.find(n => n.title === fn.title) : undefined;
    if (byTitle) { Object.assign(byTitle, fn); imported++; continue; }
    allItems.value.push(fn);
    imported++;
  }
  // 合并后重新按标题关联父子结构，避免产生悬空的 parentId
  relinkImportedParents(folderNotes);
  saveItemsToStorage();
  ElMessage.success(store.locales === 'zh' ? `已导入 ${imported} 条内容` : `Imported ${imported} entries`);
}

// 清空所有笔记/条目（二次确认，防止误删）
function clearAllEntries() {
  if (allItems.value.length === 0) {
    ElMessage.info(store.locales === 'zh' ? '当前没有可清空的内容' : 'Nothing to clear');
    return;
  }
  const count = allItems.value.length;
  // 先关闭设置框，避免确认弹窗被遮挡
  showSettings.value = false;
  ElMessageBox.confirm(
    store.locales === 'zh' ? `确定要清空全部 ${count} 条内容吗？此操作不可撤销。` : `Clear all ${count} entries? This cannot be undone.`,
    store.locales === 'zh' ? '清空确认' : 'Confirm clear',
    {
      confirmButtonText: store.locales === 'zh' ? '清空' : 'Clear',
      cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
      type: 'warning'
    }
  ).then(() => {
    allItems.value = [];
    nextId.value = 1;
    selectedItem.value = null;
    lastSavedTitle = '';
    lastSavedContent = '';
    hasUnsavedChanges = false;
    expandedKeys.value = [];
    saveItemsToStorage();
    syncNoteEditorContent();
    ElMessage.success(store.locales === 'zh' ? '已清空全部内容' : 'All entries cleared');
  }).catch(() => {
    // 用户取消
  });
}

// 保存编辑器内容（统一保存当前条目，新建时自动加入）
async function saveEditor() {
  if (!editingItem.value) return;
  const item = editingItem.value;
  const title = item.title.trim();
  const content = (item.content || '').trim();
  if (!title && !content) {
    ElMessage.warning(store.locales === 'zh' ? '请输入标题或内容' : 'Enter a title or content');
    return;
  }
  // 新建（草稿不在 allItems 中）→ 加入并保存
  const existing = allItems.value.find(i => i.id === item.id);
  if (!existing) {
    item.title = title || '无标题';
    if (!item.createdTime) item.createdTime = new Date();
    item.updatedAt = new Date();
    allItems.value.push(item);
    selectedItem.value = item;
    saveItemsToStorage();
    noteBeRef.value?.markSaved();
    ElMessage.success(store.locales === 'zh' ? '已保存' : 'Saved');
    return;
  }
  item.title = title || '无标题';
  item.updatedAt = new Date();
  await updateSelectedItem(item);
  noteBeRef.value?.markSaved();
  ElMessage.success(store.locales === 'zh' ? '已保存' : 'Saved');
}

// 新建条目：清空编辑器并进入新建状态。
// 点击新建后立刻创建项目（标题默认“新项目”），直接入库并可在右侧编辑。
// 日历（月）视图下自动带上选中日期作为起止时间，方便直接排期。
function startNewNote(date?: Date) {
  if (selectedItem.value) {
    clearSelected();
  }
  // 指定日期优先；否则日历视图用当前选中日期；其他视图不预设日期
  const baseDate = date || ((currentView.value === 'month' || currentView.value === 'week') ? new Date(selectedDate.value) : undefined);
  let startTime: Date | undefined;
  let endTime: Date | undefined;
  if (baseDate) {
    startTime = new Date(baseDate);
    startTime.setHours(9, 0, 0, 0);
    endTime = new Date(baseDate);
    endTime.setHours(17, 0, 0, 0);
  }
  const newItem: Item = {
    id: nextId.value++,
    title: '新项目',
    content: '',
    status: '灵感',
    createdTime: new Date(),
    startTime,
    endTime,
    color: getRandomColor(),
    expanded: true,
    pinned: false,
    isFolder: false
  };
  // 显式新建：立即入库并选中编辑
  allItems.value.push(newItem);
  selectedItem.value = newItem;
  saveItemsToStorage();
  lastSavedTitle = newItem.title;
  lastSavedContent = '';
  hasUnsavedChanges = false;
  syncNoteEditorContent();
}

// 进入模块时打开空白草稿：仅选中编辑，不创建/持久化任何项目
function openNewDraft() {
  if (selectedItem.value) {
    clearSelected();
  }
  const draft: Item = {
    id: nextId.value++,
    title: '',
    content: '',
    status: '灵感',
    createdTime: new Date(),
    color: getRandomColor(),
    expanded: true,
    pinned: false,
    isFolder: false
  };
  selectedItem.value = draft;
  lastSavedTitle = '';
  lastSavedContent = '';
  hasUnsavedChanges = false;
  syncNoteEditorContent();
}

// 月视图日期单元格上的“+”按钮：选中该日期并新建（带该日期的起止时间）
function startNewNoteOnDate(date: Date) {
  changeSelectedDate(date);
  startNewNote(date);
}

// 打开侧边栏搜索框并聚焦
function openNoteSearch() {
  noteSearchActive.value = true;
  nextTick(() => {
    document.querySelector<HTMLInputElement>('.notes-search-input')?.focus();
  });
}

// 关闭搜索框并清空关键词
function closeNoteSearch() {
  noteSearchActive.value = false;
  searchText.value = '';
}

// 置顶/取消置顶（所有条目统一支持）
function togglePin(item: Item) {
  if (!item) return;
  item.pinned = !item.pinned;
  item.updatedAt = new Date();
  saveItemsToStorage();
}

// 显示/隐藏切换（所有条目统一支持，替代原“归档”状态）
function toggleHide(item: Item) {
  if (!item) return;
  item.hidden = !item.hidden;
  item.updatedAt = new Date();
  saveItemsToStorage();
}

// 编辑器颜色输入：保存到当前条目
function onEditorColorInput(event: Event) {
  const target = event.target as HTMLInputElement;
  const color = target?.value || DEFAULT_NOTE_COLOR;
  editorColor.value = color;
  if (editingItem.value) {
    hasUnsavedChanges = true;
    saveIfNeeded('颜色更改');
  }
}

// 预设颜色：点击色块设置颜色（与取色器逻辑一致）
function setEditorColor(color: string) {
  editorColor.value = color;
  if (editingItem.value) {
    hasUnsavedChanges = true;
    saveIfNeeded('颜色更改');
  }
}

function bindNoteShortcut() {
  if (handleNoteShortcut) {
    window.removeEventListener('keydown', handleNoteShortcut);
  }

  handleNoteShortcut = (event: KeyboardEvent) => {
    const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
    if (!isSaveShortcut) return;

    event.preventDefault();
    saveEditor();
  };

  window.addEventListener('keydown', handleNoteShortcut);
}

// ========== 路径处理函数 ==========

// 标准化路径
function normalizePath(filePath: string): string {
  if (!filePath) return '';
  
  let normalized = filePath.replace(/\//g, '\\');
  normalized = normalized.replace(/^([a-zA-Z]):\\([a-zA-Z]):/, '$1:\\');
  
  if (normalized.match(/^[a-zA-Z]:\\[a-zA-Z]:/)) {
    normalized = normalized.substring(0, 3) + normalized.substring(4);
  }
  
  normalized = normalized.replace(/\\\\+/g, '\\');
  return normalized;
}

// 路径拼接
function pathJoin(...segments: string[]): string {
  const validSegments = segments.filter(s => s && s.length > 0);
  if (validSegments.length === 0) return '';
  
  let result = validSegments[0];
  
  for (let i = 1; i < validSegments.length; i++) {
    const segment = validSegments[i];
    
    if (result.endsWith('/') || result.endsWith('\\')) {
      result = result.slice(0, -1);
    }
    
    const cleanSegment = segment.startsWith('/') || segment.startsWith('\\') 
      ? segment.slice(1) 
      : segment;
    
    result = `${result}\\${cleanSegment}`;
  }
  
  if (result.match(/^[a-zA-Z]:\\[a-zA-Z]:/)) {
    result = result.replace(/^([a-zA-Z]):\\.*/, '$1:\\');
  }
  
  return result;
}

// ========== 文件系统相关函数 ==========

// 选择工作区
async function selectWorkspace() {
  const folderPath = await window.ipcRenderer.invoke('openFolderDialog');
  if (folderPath) {
    workspacePath.value = normalizePath(folderPath);
    await loadWorkspace();
  }
}

// 加载工作区
async function loadWorkspace() {
  if (!workspacePath.value) return;
  
  try {
    const { fileList, relationList } = await window.ipcRenderer.invoke(
      'getFilesRelation', 
      workspacePath.value, 
      10
    );
    
    const items: Item[] = [];
    let maxId = 0;
    
    for (const file of fileList) {
      const isFolder = file.type === 'folder';
      const isReadme = file.label === '.README.md';
      
      if (isReadme) continue;
      
      let item: Item;
      
      if (isFolder) {
        const readmePath = pathJoin(file.path, '.README.md');
        const metadata = await getFileMetadata(readmePath);
        
        item = {
          id: file.id,
          title: file.label,
          status: metadata?.status || '灵感',
          createdTime: metadata?.createdTime ? new Date(metadata.createdTime) : new Date(),
          color: metadata?.color || getRandomColor(),
          expanded: true,
          isFolder: true,
          filePath: normalizePath(file.path)
        };
        
        if (metadata?.startTime) item.startTime = new Date(metadata.startTime);
        if (metadata?.endTime) item.endTime = new Date(metadata.endTime);
        if (metadata?.updatedAt) item.updatedAt = new Date(metadata.updatedAt);
        if (metadata?.order !== undefined) item._order = metadata.order;
        
        // 读取文件夹的正文内容（从 .README.md 中）
        try {
          const readmeContent = await window.ipcRenderer.invoke('readFile', readmePath);
          // 提取 frontmatter 之后的内容
          const lines = readmeContent.split('\n');
          let inFrontmatter = false;
          let frontmatterEnded = false;
          let contentLines: string[] = [];
          
          for (const line of lines) {
            if (line.trim() === '---' && !inFrontmatter && !frontmatterEnded) {
              inFrontmatter = true;
              continue;
            }
            if (line.trim() === '---' && inFrontmatter) {
              inFrontmatter = false;
              frontmatterEnded = true;
              continue;
            }
            if (!inFrontmatter && frontmatterEnded) {
              contentLines.push(line);
            }
          }
          
          item.content = contentLines.join('\n').trim();
        } catch (error) {
          console.error(`读取文件夹正文失败: ${readmePath}`, error);
        }
        
      } else {
        const metadata = await getFileMetadata(file.path);
        
        item = {
          id: file.id,
          title: file.label.replace(/\.md$/, ''),
          status: metadata?.status || '灵感',
          createdTime: metadata?.createdTime ? new Date(metadata.createdTime) : new Date(),
          color: metadata?.color || getRandomColor(),
          expanded: true,
          isFolder: false,
          filePath: normalizePath(file.path)
        };
        
        if (metadata?.startTime) item.startTime = new Date(metadata.startTime);
        if (metadata?.endTime) item.endTime = new Date(metadata.endTime);
        if (metadata?.updatedAt) item.updatedAt = new Date(metadata.updatedAt);
        if (metadata?.parentId) item.parentId = metadata.parentId;
        if (metadata?.order !== undefined) item._order = metadata.order;
        if (metadata?.relatedId) item.relatedId = metadata.relatedId;
        
        // 读取文件的正文内容
        try {
          const fileContent = await window.ipcRenderer.invoke('readFile', file.path);
          // 提取 frontmatter 之后的内容
          const lines = fileContent.split('\n');
          let inFrontmatter = false;
          let frontmatterEnded = false;
          let contentLines: string[] = [];
          
          for (const line of lines) {
            if (line.trim() === '---' && !inFrontmatter && !frontmatterEnded) {
              inFrontmatter = true;
              continue;
            }
            if (line.trim() === '---' && inFrontmatter) {
              inFrontmatter = false;
              frontmatterEnded = true;
              continue;
            }
            if (!inFrontmatter && frontmatterEnded) {
              contentLines.push(line);
            }
          }
          
          item.content = contentLines.join('\n').trim();
        } catch (error) {
          console.error(`读取文件正文失败: ${file.path}`, error);
        }
      }
      
      items.push(item);
      maxId = Math.max(maxId, file.id);
    }
    
    for (const relation of relationList) {
      const child = items.find(i => i.id === relation.target);
      if (child) {
        child.parentId = relation.source;
      }
    }
    
    allItems.value = items;
    nextId.value = maxId + 1;
    expandedKeys.value = collectExpandedIds();
    nextTick(() => {
      syncTreeExpansion();
    });
    
    //console.log(`工作区加载完成，共 ${items.length} 个项目`);
    
  } catch (error) {
    //console.error('加载工作区失败:', error);
  }
}

// 获取文件元数据
async function getFileMetadata(filePath: string): Promise<any> {
  try {
    const normalizedPath = normalizePath(filePath);
    const exists = await fileExists(normalizedPath);
    if (!exists) return null;
    
    const content = await window.ipcRenderer.invoke('readFile', normalizedPath);
    
    const match = content.match(/^---\r?\n([\s\S]+?)\r?\n---/);
    if (match) {
      try {
        // 尝试 JSON 解析
        return JSON.parse('{' + match[1].replace(/(\w+):/g, '"$1":') + '}');
      } catch {
        // 简单的 YAML 解析
        const lines = match[1].split('\n');
        const result: any = {};
        for (const line of lines) {
          const [key, ...valueParts] = line.split(':');
          if (key && valueParts.length) {
            const value = valueParts.join(':').trim();
            if (value === 'true') result[key.trim()] = true;
            else if (value === 'false') result[key.trim()] = false;
            else if (!isNaN(Number(value))) result[key.trim()] = Number(value);
            else result[key.trim()] = value;
          }
        }
        return result;
      }
    }
    return null;
  } catch (error) {
    console.error('获取文件元数据失败:', error);
    return null;
  }
}

// 保存项目到文件
async function saveItemToFile(item: Item) {
  if (!workspacePath.value) return;
  
  // 每次保存时更新修改时间
  item.updatedAt = new Date();
  
  try {
    const isFolder = item.isFolder || (item.children && item.children.length > 0);
    let filePath = item.filePath ? normalizePath(item.filePath) : '';
    
    if (!filePath) {
      // 新项目，需要创建文件
      const parentItem = allItems.value.find(i => i.id === item.parentId);
      
      // 关键修复：正确获取父路径
      let parentPath = workspacePath.value;
      if (parentItem) {
        // 如果父项目是文件夹，直接使用其路径
        if (parentItem.isFolder) {
          parentPath = normalizePath(parentItem.filePath || '');
        } else {
          // 如果父项目不是文件夹，获取其所在目录
          const parentFilePath = parentItem.filePath || '';
          parentPath = normalizePath(parentFilePath.split(/[/\\]/).slice(0, -1).join('\\'));
        }
      }
      
      if (isFolder) {
        // 创建文件夹
        const folderName = sanitizeFileName(item.title) || '未命名';
        filePath = pathJoin(parentPath, folderName);
        filePath = normalizePath(filePath);
        
        // 确保父目录存在
        try {
          await window.ipcRenderer.invoke('ensureDir', parentPath);
        } catch (error) {
          console.error(`创建父目录失败: ${parentPath}`, error);
        }
        
        // 创建文件夹
        try {
          await window.ipcRenderer.invoke('ensureDir', filePath);
        } catch (error) {
          console.error(`创建文件夹失败: ${filePath}`, error);
          throw error;
        }
        
        // 创建 .README.md（包含元数据和正文）
        const readmePath = pathJoin(filePath, '.README.md');
        await saveContentToFile(readmePath, item);
        item.filePath = filePath;
      } else {
        // 创建 Markdown 文件
        const fileName = sanitizeFileName(item.title) || '未命名';
        filePath = pathJoin(parentPath, `${fileName}.md`);
        filePath = normalizePath(filePath);
        
        // 确保父目录存在
        try {
          await window.ipcRenderer.invoke('ensureDir', parentPath);
        } catch (error) {
          console.error(`创建父目录失败: ${parentPath}`, error);
        }
        
        // 检查文件是否已存在
        let finalPath = filePath;
        let counter = 1;
        while (true) {
          try {
            const exists = await fileExists(finalPath);
            if (!exists) break;
            finalPath = pathJoin(parentPath, `${fileName}_${counter}.md`);
            finalPath = normalizePath(finalPath);
            counter++;
          } catch {
            break;
          }
        }
        filePath = finalPath;
        
        await saveContentToFile(filePath, item);
        item.filePath = filePath;
      }
    } else {
      // 更新现有文件
      if (isFolder) {
        // 如果是文件夹，先确保文件夹存在
        try {
          const folderExists = await fileExists(filePath);
          if (!folderExists) {
            console.log(`文件夹不存在，重新创建: ${filePath}`);
            await window.ipcRenderer.invoke('ensureDir', filePath);
          }
        } catch (error) {
          console.error(`检查文件夹存在性失败: ${filePath}`, error);
        }
        
        // 更新 .README.md（包含元数据和正文）
        const readmePath = pathJoin(filePath, '.README.md');
        await saveContentToFile(readmePath, item);
      } else {
        // 如果是文件，直接更新
        const parentDir = filePath.substring(0, filePath.lastIndexOf('\\'));
        if (parentDir) {
          try {
            const dirExists = await fileExists(parentDir);
            if (!dirExists) {
              console.log(`父目录不存在，重新创建: ${parentDir}`);
              await window.ipcRenderer.invoke('ensureDir', parentDir);
            }
          } catch (error) {
            console.error(`检查父目录存在性失败: ${parentDir}`, error);
          }
        }
        
        // 保存文件内容
        await saveContentToFile(filePath, item);
      }
    }
    
    // 如果标题改变，可能需要重命名文件/文件夹
    const oldPath = item.filePath;
    if (oldPath) {
      const oldFileName = oldPath.split(/[/\\]/).pop() || '';
      const expectedFileName = isFolder 
        ? sanitizeFileName(item.title)
        : `${sanitizeFileName(item.title)}.md`;
      
      if (oldFileName !== expectedFileName && oldFileName !== '.README.md' && expectedFileName) {
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('\\'));
        if (parentPath) {
          // 生成不重复的文件名
          let newPath = normalizePath(pathJoin(parentPath, expectedFileName));
          let finalPath = newPath;
          let counter = 1;
          
          // 检查是否重名（排除当前文件自身）
          while (true) {
            try {
              const exists = await fileExists(finalPath);
              // 如果文件不存在，或者存在的是当前文件本身，则可以使用
              if (!exists || finalPath === oldPath) break;
              
              // 生成带数字后缀的新文件名
              const nameWithoutExt = expectedFileName.replace(/\.md$/, '');
              finalPath = normalizePath(pathJoin(parentPath, `${nameWithoutExt}_${counter}.md`));
              counter++;
            } catch {
              break;
            }
          }
          
          // 只有当路径不同时才执行重命名
          if (finalPath !== oldPath) {
            try {
              if (isFolder) {
                // 创建新文件夹
                await window.ipcRenderer.invoke('ensureDir', finalPath);
                
                // 移动 .README.md
                const oldReadmePath = pathJoin(oldPath, '.README.md');
                const newReadmePath = pathJoin(finalPath, '.README.md');
                
                try {
                  const oldReadmeExists = await fileExists(oldReadmePath);
                  if (oldReadmeExists) {
                    const content = await window.ipcRenderer.invoke('readFile', oldReadmePath);
                    await window.ipcRenderer.invoke('writeFile', newReadmePath, content);
                    await window.ipcRenderer.invoke('deleteFile', oldReadmePath);
                  }
                } catch (error) {
                  console.error('移动 .README.md 失败:', error);
                }
                
                // 移动所有子项目
                const children = allItems.value.filter(i => i.parentId === item.id);
                for (const child of children) {
                  if (child.filePath) {
                    const childFileName = child.filePath.split(/[/\\]/).pop();
                    const oldChildPath = child.filePath;
                    const newChildPath = normalizePath(pathJoin(finalPath, childFileName || ''));
                    
                    child.filePath = newChildPath;
                    
                    try {
                      const childExists = await fileExists(oldChildPath);
                      if (childExists) {
                        const content = await window.ipcRenderer.invoke('readFile', oldChildPath);
                        await window.ipcRenderer.invoke('writeFile', newChildPath, content);
                        await window.ipcRenderer.invoke('deleteFile', oldChildPath);
                      }
                    } catch (error) {
                      console.error(`移动子项目文件失败: ${oldChildPath}`, error);
                    }
                    
                    await saveItemToFile(child);
                  }
                }
                
                // 删除旧文件夹
                await deleteFolderRecursive(oldPath);
                
              } else {
                // 移动文件
                try {
                  const fileExists_check = await fileExists(oldPath);
                  if (fileExists_check) {
                    const content = await window.ipcRenderer.invoke('readFile', oldPath);
                    await window.ipcRenderer.invoke('writeFile', finalPath, content);
                    await window.ipcRenderer.invoke('deleteFile', oldPath);
                  } else {
                    await saveContentToFile(finalPath, item);
                  }
                } catch (error) {
                  console.error('移动文件失败:', error);
                }
              }
              
              item.filePath = finalPath;
              console.log(`文件重命名成功: ${oldPath} -> ${finalPath}`);
              
            } catch (error) {
              console.error('重命名失败:', error);
            }
          }
        }
      }
    }
    
    console.log(`文件保存完成: ${item.title}`);
    
  } catch (error) {
    console.error(`保存项目 ${item.title} 失败:`, error);
  }
}

// 递归删除文件夹
async function deleteFolderRecursive(folderPath: string) {
  try {
    const { fileList } = await window.ipcRenderer.invoke('getFilesRelation', folderPath, 1);
    
    for (const file of fileList) {
      if (file.type === 'file') {
        try {
          const fileExists_check = await fileExists(file.path);
          if (fileExists_check) {
            await window.ipcRenderer.invoke('deleteFile', file.path);
          }
        } catch (error) {
          console.error(`删除文件失败: ${file.path}`, error);
        }
      }
    }
    
    try {
      const folderExists = await fileExists(folderPath);
      if (folderExists) {
        await window.ipcRenderer.invoke('deleteFile', folderPath);
        console.log(`成功删除文件夹: ${folderPath}`);
      }
    } catch (error) {
      console.error(`删除文件夹失败: ${folderPath}`, error);
    }
  } catch (error) {
    console.error('获取文件夹内容失败:', error);
  }
}

// 保存完整内容到文件（包含元数据和正文）
async function saveContentToFile(filePath: string, item: Item) {
  const normalizedPath = normalizePath(filePath);
  
  const metadata: any = {
    id: item.id,
    status: item.status,
    color: item.color,
    createdTime: item.createdTime.toISOString(),
    updatedAt: item.updatedAt ? item.updatedAt.toISOString() : new Date().toISOString()
  };
  
  if (item.startTime) metadata.startTime = item.startTime.toISOString();
  if (item.endTime) metadata.endTime = item.endTime.toISOString();
  if (item.parentId) metadata.parentId = item.parentId;
  if (item._order !== undefined) metadata.order = item._order;
  if (item.relatedId) metadata.relatedId = item.relatedId;
  
  let content = '---\n';
  for (const [key, value] of Object.entries(metadata)) {
    content += `${key}: ${value}\n`;
  }
  content += '---\n';
  
  // 添加正文内容
  if (item.content && item.content.trim() !== '') {
    content += '\n' + item.content + '\n';
  }
  
  try {
    await window.ipcRenderer.invoke('writeFile', normalizedPath, content);
    console.log(`文件保存成功: ${normalizedPath}`);
  } catch (error) {
    console.error(`保存文件失败: ${normalizedPath}`, error);
    throw error;
  }
}

// 重命名文件
async function renameItemFile(item: Item, newName: string) {
  if (!item.filePath) return;
  
  const parentPath = normalizePath(item.filePath.split(/[/\\]/).slice(0, -1).join('\\'));
  const newPath = normalizePath(pathJoin(parentPath, newName));
  
  try {
    if (await fileExists(newPath)) {
      console.warn(`目标文件已存在: ${newPath}`);
      return;
    }
    
    const content = await window.ipcRenderer.invoke('readFile', item.filePath);
    await window.ipcRenderer.invoke('writeFile', newPath, content);
    await window.ipcRenderer.invoke('deleteFile', item.filePath);
    
    item.filePath = newPath;
  } catch (error) {
    console.error('重命名文件失败:', error);
  }
}

// 删除项目文件
async function deleteItemFile(item: Item) {
  if (!item.filePath) return;
  
  try {
    const normalizedPath = normalizePath(item.filePath);
    
    if (item.isFolder) {
      console.log(`开始删除文件夹及其内容: ${normalizedPath}`);
      
      // 先递归删除所有子项目
      const children = allItems.value.filter(i => i.parentId === item.id);
      for (const child of children) {
        await deleteItemFile(child);
      }
      
      // 删除文件夹内的 .README.md 文件
      const readmePath = pathJoin(normalizedPath, '.README.md');
      try {
        const readmeExists = await fileExists(readmePath);
        if (readmeExists) {
          await window.ipcRenderer.invoke('deleteFile', readmePath);
          console.log(`删除 .README.md 成功: ${readmePath}`);
        }
      } catch (error) {
        console.error(`删除 .README.md 失败: ${readmePath}`, error);
      }
      
      // 删除文件夹本身
      try {
        const folderExists = await fileExists(normalizedPath);
        if (folderExists) {
          // 注意：这里需要使用专门删除文件夹的方法
          // 如果 IPC 有删除文件夹的方法，使用它；否则可能需要递归删除
          await window.ipcRenderer.invoke('deleteFolder', normalizedPath);
          console.log(`删除文件夹成功: ${normalizedPath}`);
        }
      } catch (error) {
        console.error(`删除文件夹失败: ${normalizedPath}`, error);
      }
    } else {
      // 删除单个文件
      try {
        const fileExists_check = await fileExists(normalizedPath);
        if (fileExists_check) {
          await window.ipcRenderer.invoke('deleteFile', normalizedPath);
          console.log(`删除文件成功: ${normalizedPath}`);
        }
      } catch (error) {
        console.error(`删除文件失败: ${normalizedPath}`, error);
      }
    }
  } catch (error) {
    console.error(`删除项目文件失败: ${item.filePath}`, error);
  }
}

// ========== 视图控制函数 ==========

// 视图切换（顶部下拉框选择）持久化
watch(currentView, (view) => {
  localStorage.setItem(VIEW_STORAGE_KEY, view);
});

function getSearchPlaceholder() {
  switch (currentView.value) {
    case 'notes': return store.locales=='zh'?'搜索笔记...':'Search notes...';
    case 'tree': return store.locales=='zh'?'搜索规划项目...':'Search for planned items...';
    case 'month': return store.locales=='zh'?'搜索日历项目...':'Search calendar items...';
    case 'week': return store.locales=='zh'?'搜索日历项目...':'Search calendar items...';
    default: return store.locales=='zh'?'搜索...':'Search...';
  }
}

function getRandomColor() {
  return colorOptions.value[Math.floor(Math.random() * colorOptions.value.length)];
}

function selectItem(item: Item) {
  // 切换条目前的自动保存由 watch(selectedItem) 统一处理（避免未保存修改丢失）
  const original = allItems.value.find(i => i.id === item.id);
  selectedItem.value = original || item;
}

function clearSelected() {
  // 关闭面板前的自动保存由 watch(selectedItem) 统一处理
  selectedItem.value = null;
  hasUnsavedChanges = false;
}

// 添加项目（统一存储，无需工作区）
async function addItem() {
  const defaultStatus = selectedStatus.value || '灵感';
  const today = new Date();
  
  let newItem: Item = {
    id: nextId.value++,
    title: `新的${defaultStatus}`,
    status: defaultStatus as ItemStatus,
    createdTime: new Date(),
    color: getRandomColor(),
    expanded: true,
    content: ''
  };
  
  if (defaultStatus !== '灵感' && defaultStatus !== '规划') {
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 7);
    newItem.startTime = today;
    newItem.endTime = endDate;
  }
  
  if (defaultStatus === '规划') {
    newItem._order = treeItems.value.length;
  }
  
  if (selectedItem.value) {
    newItem.parentId = selectedItem.value.id;
    newItem.isFolder = false;
  } else {
    newItem.isFolder = false;
  }
  
  allItems.value.push(newItem);
  saveItemsToStorage();
  
  selectedItem.value = newItem;
}

function expandAll() {
  allItems.value.forEach((item: Item) => {
    if (item.status === '规划') {
      item.expanded = true;
    }
  });
  allItems.value = [...allItems.value];
  saveItemsToStorage();
  expandedKeys.value = collectExpandedIds();
  syncTreeExpansion();
}

function collapseAll() {
  allItems.value.forEach((item: Item) => {
    if (item.status === '规划') {
      item.expanded = false;
    }
  });
  allItems.value = [...allItems.value];
  saveItemsToStorage();
  expandedKeys.value = collectExpandedIds();
  syncTreeExpansion();
}

function prev() {
  if (currentView.value === 'month') {
    currentDate.value = new Date(currentYear.value, currentDate.value.getMonth() - 1, 1);
  } else if (currentView.value === 'week') {
    const d = new Date(currentDate.value);
    d.setDate(d.getDate() - 7);
    currentDate.value = d;
  }
}

function next() {
  if (currentView.value === 'month') {
    currentDate.value = new Date(currentYear.value, currentDate.value.getMonth() + 1, 1);
  } else if (currentView.value === 'week') {
    const d = new Date(currentDate.value);
    d.setDate(d.getDate() + 7);
    currentDate.value = d;
  }
}

// 回到今天：切换回当前月并选中今天
function goToday() {
  currentDate.value = new Date();
  selectedDate.value = new Date();
}

function formatDateForDisplay(date: Date | undefined) {
  if (!date) return '';
  const d = new Date(date);
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${month}-${day}`;
}

function changeSelectedDate(date: Date) {
  // 拖放结束后浏览器会补发一次 click，这里吞掉以免误切换选中日期
  if (suppressCellClick) {
    suppressCellClick = false;
    return;
  }
  selectedDate.value = new Date(date);
}

// 点击日期空白处（未点到具体项目，项目卡片已 .stop 拦截）：
// 仅选中该日期，不自动新建；之后点“新建”按钮才以该日期创建项目
function onDateCellClick(date: Date) {
  if (suppressCellClick) {
    suppressCellClick = false;
    return;
  }
  changeSelectedDate(date);
}

// 拖拽开始：记录被拖项目 id
function onTaskDragStart(event: DragEvent, item: Item) {
  dragItemId = item.id;
  if (event.dataTransfer) {
    event.dataTransfer.setData('text/plain', String(item.id));
    event.dataTransfer.effectAllowed = 'move';
  }
}

// 拖拽结束：清除状态（无论是否成功放下）
function onTaskDragEnd() {
  dragItemId = null;
  dragOverDate.value = null;
}

// 悬停日期单元格：允许放置并高亮目标日期
function onCellDragOver(event: DragEvent, date: Date) {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move';
  }
  const d = new Date(date);
  if (!dragOverDate.value || !isSameDay(dragOverDate.value, d)) {
    dragOverDate.value = d;
  }
}

// 拖放至日期单元格：移动项目到该日期
function onCellDrop(event: DragEvent, date: Date) {
  event.preventDefault();
  dragOverDate.value = null;
  const idStr = event.dataTransfer?.getData('text/plain');
  let id: number | null = null;
  if (idStr) {
    const num = Number(idStr);
    if (!Number.isNaN(num)) id = num;
  }
  if (id == null) id = dragItemId;
  if (id == null) return;
  const item = allItems.value.find(i => i.id === id);
  if (!item) return;
  moveItemToDate(item, date);
  saveItemsToStorage();
  dragItemId = null;
  // 吞掉拖放后浏览器补发的 click
  suppressCellClick = true;
  setTimeout(() => { suppressCellClick = false; }, 300);
}

// 将项目移动到目标日期：有起止时间则平移整个时间段（保持时长），否则设为单日
function moveItemToDate(item: Item, targetDate: Date) {
  const target = new Date(targetDate);
  if (item.startTime && item.endTime) {
    const oldStart = new Date(item.startTime);
    const oldEnd = new Date(item.endTime);
    const durationMs = oldEnd.getTime() - oldStart.getTime();
    const newStart = new Date(target);
    newStart.setHours(oldStart.getHours(), oldStart.getMinutes(), oldStart.getSeconds(), 0);
    const newEnd = new Date(newStart.getTime() + durationMs);
    item.startTime = newStart;
    item.endTime = newEnd;
  } else {
    // 无起止时间（灵感/笔记）：设为单日 9:00~17:00
    const newStart = new Date(target);
    newStart.setHours(9, 0, 0, 0);
    const newEnd = new Date(target);
    newEnd.setHours(17, 0, 0, 0);
    item.startTime = newStart;
    item.endTime = newEnd;
  }
  item.updatedAt = new Date();
}

function isToday(date: Date) {
  const today = new Date();
  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

function isSameDay(date1: Date, date2: Date): boolean {
  if (!date1 || !date2) return false;
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

function countTodo(date: Date): number {
  let itemsToCount = allItems.value;
  
  itemsToCount = itemsToCount.filter((item: Item) => statusFilterMatch(item.status));
  itemsToCount = itemsToCount.filter((item: Item) => visibilityMatch(item));
  
  if (searchText.value) {
    const searchTerm = searchText.value.toLowerCase();
    itemsToCount = itemsToCount.filter((item: Item) => 
      item.title?.toLowerCase().includes(searchTerm) ||
      item.content?.toLowerCase().includes(searchTerm)
    );
  }
  
  return itemsToCount.filter((item: Item) => {
    // 有起止时间：按时间范围匹配
    if (item.startTime && item.endTime) {
      const taskStart = new Date(item.startTime);
      const taskEnd = new Date(item.endTime);
      const checkDate = new Date(date);
      
      taskStart.setHours(0, 0, 0, 0);
      taskEnd.setHours(23, 59, 59, 999);
      checkDate.setHours(0, 0, 0, 0);
      
      return checkDate >= taskStart && checkDate <= taskEnd;
    }
    // 无起止时间：按修改时间（回退创建时间）单日匹配
    const anchor = item.updatedAt || item.createdTime;
    if (!anchor) return false;
    const checkDate = new Date(date);
    checkDate.setHours(0, 0, 0, 0);
    const anchorDate = new Date(anchor);
    anchorDate.setHours(0, 0, 0, 0);
    return checkDate.getTime() === anchorDate.getTime();
  }).length;
}

function getItemsForDate(date: Date) {
  let itemsToShow = allItems.value;
  
  itemsToShow = itemsToShow.filter((item: Item) => statusFilterMatch(item.status));
  itemsToShow = itemsToShow.filter((item: Item) => visibilityMatch(item));
  
  if (searchText.value) {
    const searchTerm = searchText.value.toLowerCase();
    itemsToShow = itemsToShow.filter((item: Item) => 
      item.title?.toLowerCase().includes(searchTerm) ||
      item.content?.toLowerCase().includes(searchTerm)
    );
  }
  
  return itemsToShow.filter((item: Item) => {
    // 有起止时间：按时间范围匹配
    if (item.startTime && item.endTime) {
      const taskStart = new Date(item.startTime);
      const taskEnd = new Date(item.endTime);
      taskStart.setHours(0, 0, 0, 0);
      taskEnd.setHours(23, 59, 59, 999);
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      return d >= taskStart && d <= taskEnd;
    }
    // 无起止时间：按修改时间（回退创建时间）单日匹配
    const anchor = item.updatedAt || item.createdTime;
    if (!anchor) return false;
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const a = new Date(anchor);
    a.setHours(0, 0, 0, 0);
    return d.getTime() === a.getTime();
  });
}

function getContrastColor(hexcolor: string): string {
  if (!hexcolor || hexcolor.includes('var(')) {
    return '#000000';
  }
  
  const color = hexcolor.replace('#', '');
  let r, g, b;
  if (color.length === 3) {
    r = parseInt(color[0] + color[0], 16);
    g = parseInt(color[1] + color[1], 16);
    b = parseInt(color[2] + color[2], 16);
  } else {
    r = parseInt(color.substring(0, 2), 16);
    g = parseInt(color.substring(2, 4), 16);
    b = parseInt(color.substring(4, 6), 16);
  }
  
  const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
  return yiq >= 128 ? '#000000' : '#FFFFFF';
}

function getItemSpanStyle(item: Item, cellDate: Date) {
  // 无起止时间的项目：按修改/创建时间在该日显示单日块
  if (!item.startTime || !item.endTime) {
    const anchor = item.updatedAt || item.createdTime;
    if (!anchor) return { display: 'none' };
    const cellDateCopy = new Date(cellDate);
    cellDateCopy.setHours(0, 0, 0, 0);
    const anchorDate = new Date(anchor);
    anchorDate.setHours(0, 0, 0, 0);
    if (cellDateCopy.getTime() !== anchorDate.getTime()) {
      return { display: 'none' };
    }
    const backgroundColor = item.color || getRandomColor();
    const textColor = getContrastColor(backgroundColor);
    return {
      backgroundColor,
      color: textColor,
      cursor: 'pointer',
      borderLeft: `3px solid ${backgroundColor}`,
      borderLeftColor: backgroundColor
    };
  }
  
  const taskStart = new Date(item.startTime);
  const taskEnd = new Date(item.endTime);
  
  taskStart.setHours(0, 0, 0, 0);
  taskEnd.setHours(0, 0, 0, 0);
  const cellDateCopy = new Date(cellDate);
  cellDateCopy.setHours(0, 0, 0, 0);
  
  if (cellDateCopy < taskStart || cellDateCopy > taskEnd) {
    return { display: 'none' };
  }
  
  const backgroundColor = item.color || getRandomColor();
  const textColor = getContrastColor(backgroundColor);
  
  return {
    backgroundColor,
    color: textColor,
    cursor: 'pointer',
    borderLeft: `3px solid ${backgroundColor}`,
    borderLeftColor: backgroundColor
  };
}

// ========== 保存相关函数 ==========

// 状态更改时保存
function updateItemStatus(event: Event) {
  if (!selectedItem.value) return;
  const target = event.target as HTMLSelectElement;
  selectedItem.value.status = target.value as ItemStatus;
  hasUnsavedChanges = true;
  saveIfNeeded('状态更改');
}

// 开始时间更改时保存
async function updateStartTime(event: any, item: Item) {
  if (!event.target.value) return;
  
  const newDate = new Date(event.target.value);
  if (item.startTime) {
    const oldDate = new Date(item.startTime);
    newDate.setHours(oldDate.getHours(), oldDate.getMinutes(), oldDate.getSeconds(), oldDate.getMilliseconds());
  }
  
  item.startTime = newDate;
  
  if (item.endTime && item.endTime < newDate) {
    item.endTime = new Date(newDate);
    if (item.endTime) item.endTime.setHours(17, 0, 0, 0);
  }
  
  item.updatedAt = new Date();
  hasUnsavedChanges = true;
  saveIfNeeded('开始时间更改');
}

// 结束时间更改时保存
async function updateEndTime(event: any, item: Item) {
  if (!event.target.value) return;
  
  const newDate = new Date(event.target.value);
  if (item.endTime) {
    const oldDate = new Date(item.endTime);
    newDate.setHours(oldDate.getHours(), oldDate.getMinutes(), oldDate.getSeconds(), oldDate.getMilliseconds());
  }
  
  item.endTime = newDate;
  
  if (item.startTime && item.startTime > newDate) {
    item.startTime = new Date(newDate);
    if (item.startTime) item.startTime.setHours(9, 0, 0, 0);
  }
  
  item.updatedAt = new Date();
  hasUnsavedChanges = true;
  saveIfNeeded('结束时间更改');
}

// 如果需要则保存（检查是否有未保存更改；item 参数用于保存即将被切换走的上一个条目）
async function saveIfNeeded(reason: string = '', item?: Item) {
  const target = item || selectedItem.value;
  if (!target) return;
  
  const hasTitleChanged = target.title !== lastSavedTitle;
  const hasContentChanged = target.content !== lastSavedContent;
  
  if (hasUnsavedChanges || hasTitleChanged || hasContentChanged) {
    console.log(`保存项目 (${reason}): ${target.title}`);
    
    // 更新最后保存的记录
    lastSavedTitle = target.title;
    lastSavedContent = target.content || '';
    hasUnsavedChanges = false;
    
    // 调用更新函数
    await updateSelectedItem(target);
  } else {
    console.log(`跳过保存 (${reason}): 无变化`);
  }
}

// 更新项目（若为新建草稿则自动加入）
async function updateSelectedItem(item: Item) {
  const index = allItems.value.findIndex((i: Item) => i.id === item.id);
  if (index !== -1) {
    // 先更新数组中的项目
    allItems.value[index] = { ...item };
    
    // 更新选中的项目引用
    if (selectedItem.value && selectedItem.value.id === item.id) {
      selectedItem.value = allItems.value[index];
    }
    
    // 保存到 localStorage
    saveItemsToStorage();
    
    console.log(`项目已更新并保存: ${item.title}`);
  } else {
    // 新建草稿：标题和内容都为空则不加入列表，但保留草稿
    // （避免切换类型/设置日期时选中项被清空，导致下方选项栏消失）
    if (!item.title.trim() && !(item.content || '').trim()) {
      return;
    }
    item.title = item.title.trim() || '无标题';
    if (!item.createdTime) item.createdTime = new Date();
    item.updatedAt = new Date();
    allItems.value.push(item);
    selectedItem.value = item;
    saveItemsToStorage();
  }
}

// 添加子项目
async function addChildItem(parent: Item) {
  const newItem: Item = {
    id: nextId.value++,
    title: '新的子规划',
    status: '规划',
    createdTime: new Date(),
    color: getRandomColor(),
    parentId: parent.id,
    isFolder: false,
    expanded: true,
    content: ''
  };
  
  allItems.value.push(newItem);
  
  // 本地化存储：只更新 localStorage，不创建任何文件/文件夹
  parent.expanded = true;
  saveItemsToStorage();
  expandedKeys.value = collectExpandedIds();
  nextTick(() => {
    syncTreeExpansion();
  });
}

// 删除项目
async function deleteItem(item: Item) {
  // 递归删除子项目
  const deleteChildren = async (parentId: number) => {
    const children = allItems.value.filter((i: Item) => i.parentId === parentId);
    for (const child of children) {
      await deleteChildren(child.id);
      const index = allItems.value.findIndex((i: Item) => i.id === child.id);
      if (index !== -1) {
        allItems.value.splice(index, 1);
      }
    }
  };
  
  // 先删除所有子项目
  await deleteChildren(item.id);
  
  // 再删除当前项目
  const index = allItems.value.findIndex((i: Item) => i.id === item.id);
  if (index !== -1) {
    allItems.value.splice(index, 1);
  }
  
  // 如果删除的是当前选中的项目，清除选中状态
  if (selectedItem.value && selectedItem.value.id === item.id) {
    selectedItem.value = null;
  }
  
  saveItemsToStorage();
  console.log(`项目删除完成: ${item.title}`);
}

function toggleExpand(item: Item) {
  if (!item) return;
  
  const existing = allItems.value.find(i => i.id === item.id);
  if (existing) {
    existing.expanded = !existing.expanded;
  } else {
    item.expanded = !item.expanded;
  }

  allItems.value = [...allItems.value];
  saveItemsToStorage();
}

// ========== el-tree 树状图事件 ==========
function collectExpandedIds(): number[] {
  return allItems.value.filter(i => i.expanded).map(i => i.id);
}

function onTreeNodeClick(data: Item) {
  selectItem(data);
}

// ========== 树状图右键菜单 ==========
const treeContextMenu = ref<{ visible: boolean; x: number; y: number; item: Item | null }>({ visible: false, x: 0, y: 0, item: null });

function openTreeContextMenu(event: MouseEvent, item: Item) {
  treeContextMenu.value.item = item;
  // 视口边界修正（估算菜单尺寸 150x80）
  const menuW = 150, menuH = 80;
  let x = event.clientX;
  let y = event.clientY;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 4;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4;
  treeContextMenu.value.x = Math.max(0, x);
  treeContextMenu.value.y = Math.max(0, y);
  treeContextMenu.value.visible = true;
}

function closeTreeContextMenu() {
  treeContextMenu.value.visible = false;
  treeContextMenu.value.item = null;
}

function treeMenuAddChild() {
  const item = treeContextMenu.value.item;
  closeTreeContextMenu();
  if (item) addChildItem(item);
}

function treeMenuDelete() {
  const item = treeContextMenu.value.item;
  closeTreeContextMenu();
  if (item) deleteItem(item);
}

// 切换树状图排序方式（再次点击同项切换正序/倒序，持久化到 localStorage）
function setTreeSort(mode: 'default' | 'name' | 'updated' | 'start' | 'end' | 'status') {
  if (treeSortMode.value === mode) {
    // 同项再次点击：切换方向（default 无方向，直接关闭）
    if (mode !== 'default') {
      treeSortDir.value = treeSortDir.value === 'asc' ? 'desc' : 'asc';
      localStorage.setItem(TREE_SORT_DIR_KEY, treeSortDir.value);
    }
  } else {
    treeSortMode.value = mode;
    localStorage.setItem(TREE_SORT_KEY, mode);
  }
  closeTreeContextMenu();
}

function allowTreeDrop(draggingNode: any, dropNode: any, type: string): boolean {
  if (!draggingNode || !dropNode) return false;
  if (draggingNode.data.id === dropNode.data.id) return false;
  const isSelfOrDescendant = (node: any): boolean => {
    if (!node) return false;
    if (node.data && node.data.id === draggingNode.data.id) return true;
    return (node.childNodes || []).some(isSelfOrDescendant);
  };
  return !isSelfOrDescendant(dropNode);
}

async function onTreeNodeDrop(draggingNode: any, dropNode: any, dropType: string, ev: any) {
  const movedItem = allItems.value.find(i => i.id === draggingNode.data.id);
  const targetItem = allItems.value.find(i => i.id === dropNode.data.id);
  if (!movedItem || !targetItem || movedItem.id === targetItem.id) return;

  let newParentId: number | undefined;
  if (dropType === 'inner') {
    newParentId = targetItem.id;
  } else {
    newParentId = targetItem.parentId;
  }
  if (newParentId === movedItem.id) return;

  // 防止拖入自己的后代
  const isDescendantOf = (parentId: number | undefined): boolean => {
    if (parentId === undefined || parentId === null) return false;
    if (parentId === movedItem.id) return true;
    const parent = allItems.value.find(i => i.id === parentId);
    return parent ? isDescendantOf(parent.parentId) : false;
  };
  if (isDescendantOf(newParentId)) return;

  movedItem.parentId = newParentId;

  // 同级重新排序（本地化存储：只更新 localStorage）
  const siblings = allItems.value
    .filter(i => (i.parentId ?? null) === (newParentId ?? null))
    .sort((a, b) => (a._order ?? a.id) - (b._order ?? b.id));
  const withoutMoved = siblings.filter(i => i.id !== movedItem.id);
  let insertIndex = withoutMoved.findIndex(i => i.id === targetItem.id);
  if (insertIndex < 0) insertIndex = withoutMoved.length;
  if (dropType === 'after') insertIndex += 1;
  insertIndex = Math.min(insertIndex, withoutMoved.length);
  withoutMoved.splice(insertIndex, 0, movedItem);
  for (let i = 0; i < withoutMoved.length; i++) {
    withoutMoved[i]._order = i;
  }

  allItems.value = [...allItems.value];
  saveItemsToStorage();
}

function onTreeNodeExpand(data: Item) {
  const item = allItems.value.find(i => i.id === data.id);
  if (item) item.expanded = true;
  if (!expandedKeys.value.includes(data.id)) expandedKeys.value.push(data.id);
  saveItemsToStorage();
}

function onTreeNodeCollapse(data: Item) {
  const item = allItems.value.find(i => i.id === data.id);
  if (item) item.expanded = false;
  expandedKeys.value = expandedKeys.value.filter(k => k !== data.id);
  saveItemsToStorage();
}

// 数据加载后同步展开状态（兜底，避免 el-tree 挂载时数据尚未加载）
function syncTreeExpansion() {
  const tree: any = todoTreeRef.value;
  if (!tree) return;
  try {
    const nodes: any[] = tree.store?._getAllNodes?.() || [];
    nodes.forEach((node: any) => {
      if (node && node.data && node.data.id !== undefined) {
        const item = allItems.value.find(i => i.id === node.data.id);
        if (item && node.expanded !== !!item.expanded) {
          node.expanded = !!item.expanded;
        }
      }
    });
  } catch (e) {
    console.warn('同步树展开状态失败:', e);
  }
}

function formatDateForInput(date: Date | undefined) {
  if (!date) return '';
  const d = new Date(date);
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 时间显示：有起止时间显示日期范围；无起止时间（灵感/笔记）显示相对时间或日期
function formatItemTime(item: Item): string {
  const fmt = (d: Date | undefined) => {
    if (!d) return '';
    const date = new Date(d);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${month}-${day}`;
  };
  // 有起止时间：按时间范围显示（日历/任务类）
  if (item.startTime) {
    const s = fmt(item.startTime);
    const e = fmt(item.endTime);
    return e && e !== s ? `${s} ~ ${e}` : s;
  }
  // 无起止时间（灵感/笔记）：优先显示相对时间（修改/创建时间）
  const anchor = item.updatedAt || item.createdTime;
  if (!anchor) return '';
  const ts = new Date(anchor).getTime();
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const isZh = store.locales === 'zh';
  if (mins < 1) return isZh ? '刚刚' : 'just now';
  if (mins < 60) return isZh ? `${mins}分钟前` : `${mins}m ago`;
  if (hours < 24) return isZh ? `${hours}小时前` : `${hours}h ago`;
  if (days < 7) return isZh ? `${days}天前` : `${days}d ago`;
  return fmt(anchor);
}

// 获取条目所属目录路径（父级链向上遍历），格式 目录A/子目录B/；无父级返回空串（不显示）
function getItemPath(item: Item): string {
  if (!item) return '';
  const parts: string[] = [];
  const seen = new Set<number>();
  let cur: Item | undefined = item;
  while (cur) {
    // 显式标注类型：避免循环赋值（cur = parent）导致 TS 隐式 any 的循环依赖推断
    const pid: number | undefined = cur.parentId;
    if (pid === undefined || pid === null) break;
    if (seen.has(pid)) break; // 防止循环引用
    seen.add(pid);
    const parent: Item | undefined = allItems.value.find(i => i.id === pid);
    if (!parent) break;
    parts.unshift(parent.title || '无标题');
    cur = parent;
  }
  return parts.length ? parts.join('/') + '/' : '';
}

function getStatusIcon(status: string): string {
  const opt = statusOptions.value.find(o => o.value === status);
  return opt ? opt.icon : 'fa fa-tag';
}

// 状态标签（未知分类显示"其他"）
function getStatusLabel(status: string): string {
  const opt = statusOptions.value.find(o => o.value === status);
  return opt ? opt.label : (store.locales === 'zh' ? '其他' : 'Other');
}

// 分类筛选匹配（"其他" = 不在任何自定义分类中）
function statusFilterMatch(itemStatus: string): boolean {
  if (!selectedStatus.value) return true;
  if (selectedStatus.value === '__undefined__') {
    return !statusOptions.value.some(o => o.value === itemStatus);
  }
  return itemStatus === selectedStatus.value;
}

// 判断条目是否位于隐藏分支（自身或任一祖先为隐藏）
function isInHiddenBranch(item: Item): boolean {
  let cur: Item | undefined = item;
  const seen = new Set<number>();
  while (cur) {
    if (cur.hidden) return true;
    if (cur.parentId === undefined || cur.parentId === null) break;
    if (seen.has(cur.id)) break; // 防止循环引用
    seen.add(cur.id);
    // 用局部变量承接 parentId，避免闭包内类型收窄丢失
    const pid: number | undefined = cur.parentId;
    cur = allItems.value.find(i => i.id === pid);
  }
  return false;
}

// 显示/隐藏筛选匹配（替代原“归档”逻辑）
function visibilityMatch(item: Item): boolean {
  if (visibilityFilter.value === 'all') return true;
  if (visibilityFilter.value === 'hidden') return Boolean(item.hidden);
  return !item.hidden;
}

// 指定状态是否属于某个自定义分类
function hasStatusOption(status: string): boolean {
  return statusOptions.value.some(o => o.value === status);
}

// 检查文件是否存在
async function fileExists(filePath: string): Promise<boolean> {
  if (!filePath) return false;
  
  try {
    const normalizedPath = normalizePath(filePath);
    const result = await window.ipcRenderer.invoke('getInf', normalizedPath);
    return result !== null && result !== undefined;
  } catch (error: any) {
    if (error.message?.includes('ENOENT') || error.code === 'ENOENT') {
      return false;
    }
    console.error('检查文件存在性时出错:', error);
    return false;
  }
}

// 清理文件名
function sanitizeFileName(fileName: string): string {
  if (!fileName) return '';
  return fileName
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

// ========== 右侧编辑器宽度拖拽调整（像素固定：窗口缩放不改变宽度，仅做边界限制） ==========
const isResizing = ref(false);

// 编辑器最小宽度 / 左侧面板最小保留宽度
const EDITOR_MIN_W = 240;
const LEFT_MIN_W = 180;

// 窗口/容器缩放时保持右侧编辑器像素宽度不变（仅在窗口过小/过大时收缩/放大到边界内）
function clampEditorWidth() {
  const home = homeRef.value;
  if (!home) return;
  const rect = home.getBoundingClientRect();
  if (!rect.width) return;
  // 限制最大宽度：保留至少 LEFT_MIN_W 给左侧面板，且不超过总宽的 70%
  const maxAllowed = Math.max(LEFT_MIN_W, Math.min(rect.width * 0.7, rect.width - LEFT_MIN_W));
  editorWidth.value = Math.min(maxAllowed, Math.max(EDITOR_MIN_W, editorWidth.value));
}

function startResize(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', stopResize);
}

function onResizeMove(e: MouseEvent) {
  if (!isResizing.value) return;
  const home = homeRef.value;
  if (!home) return;
  const rect = home.getBoundingClientRect();
  // 编辑器右边缘 = home 右边缘（去掉 padding 5px）
  const raw = rect.width - (e.clientX - rect.left) - 5;
  // 限制最大宽度：保留至少 LEFT_MIN_W 给左侧面板，且不超过总宽的 70%
  const maxAllowed = Math.max(LEFT_MIN_W, Math.min(rect.width * 0.7, rect.width - LEFT_MIN_W));
  editorWidth.value = Math.min(maxAllowed, Math.max(EDITOR_MIN_W, raw));
}

function stopResize() {
  if (!isResizing.value) return;
  isResizing.value = false;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', stopResize);
  localStorage.setItem(EDITOR_WIDTH_KEY, String(editorWidth.value));
}

// ========== 生命周期和监听 ==========

watch(selectedItem, (newVal, oldVal) => {
  // 切换条目 / 关闭面板时：若原条目仍在列表中且有未保存修改，则自动保存（防止数据丢失）
  if (oldVal && (!newVal || newVal.id !== oldVal.id)) {
    const stillExists = allItems.value.some(i => i.id === oldVal.id);
    if (stillExists) {
      saveIfNeeded('切换条目', oldVal);
    }
  }
  if (newVal && (!oldVal || newVal.id !== oldVal.id)) {
    let parentId = newVal.parentId;
    while (parentId !== undefined && parentId !== null) {
      const parent = allItems.value.find(i => i.id === parentId);
      if (parent) {
        parent.expanded = true;
        parentId = parent.parentId;
      } else {
        break;
      }
    }
    
    // 当选中项目变化时，更新最后保存的记录
    lastSavedTitle = newVal.title;
    lastSavedContent = newVal.content || '';
    hasUnsavedChanges = false;
  }
});

// 编辑器内容变化时同步到编辑器
watch(editorContent, () => {
  syncNoteEditorContent();
});

// 持久化分类筛选
watch(selectedStatus, (status) => {
  localStorage.setItem(STATUS_STORAGE_KEY, status);
});

// 持久化显示/隐藏筛选
watch(visibilityFilter, (v) => {
  localStorage.setItem(VISIBILITY_FILTER_KEY, v);
});

onMounted(() => {
  loadStatusOptions();

  // 从 localStorage 加载统一条目（旧版数据迁移改为手动，见设置面板）
  loadItemsFromStorage();

  // 点击任意处 / 滚动时关闭树状图右键菜单
  document.addEventListener('click', closeTreeContextMenu);
  document.addEventListener('scroll', closeTreeContextMenu, true);

  // 恢复上次的视图 / 分类筛选 / 左侧宽度（旧版 waterfall 值映射为 notes）
  const savedView = localStorage.getItem(VIEW_STORAGE_KEY);
  if (savedView === 'notes' || savedView === 'tree' || savedView === 'month' || savedView === 'week') {
    currentView.value = savedView;
  } else if (savedView === 'waterfall') {
    currentView.value = 'notes';
  }
  const savedStatus = localStorage.getItem(STATUS_STORAGE_KEY);
  if (savedStatus) {
    selectedStatus.value = savedStatus;
  }
  const savedVisibility = localStorage.getItem(VISIBILITY_FILTER_KEY);
  if (savedVisibility === 'show' || savedVisibility === 'hidden' || savedVisibility === 'all') {
    visibilityFilter.value = savedVisibility;
  }
  const savedSort = localStorage.getItem(TREE_SORT_KEY);
  if (savedSort === 'name' || savedSort === 'updated' || savedSort === 'start' || savedSort === 'end' || savedSort === 'status' || savedSort === 'default') {
    treeSortMode.value = savedSort;
  }
  const savedDir = localStorage.getItem(TREE_SORT_DIR_KEY);
  if (savedDir === 'asc' || savedDir === 'desc') {
    treeSortDir.value = savedDir;
  }

  nextTick(() => {
    // 恢复右侧编辑器像素宽度（无记录保持默认 480px）
    const savedWidth = Number(localStorage.getItem(EDITOR_WIDTH_KEY));
    if (savedWidth >= 240 && savedWidth <= 1200) {
      editorWidth.value = savedWidth;
    }
    clampEditorWidth();

    // 容器尺寸变化（窗口缩放等）时保持编辑器宽度不变（仅边界限制）
    if (typeof ResizeObserver !== 'undefined' && homeRef.value) {
      resizeObserver = new ResizeObserver(() => clampEditorWidth());
      resizeObserver.observe(homeRef.value);
    }

    // 编辑器常驻右侧，初始化一次
    initNoteEditor();
    bindNoteShortcut();

    // 默认显示新建面板（右侧出现空草稿编辑器，仅草稿不持久化）
    openNewDraft();

    // 统一存储：数据已在 onMounted 从 localStorage 加载；
    // 若存在旧工作区路径，仅保留字段（用于可选导入旧数据），不自动覆盖。
    const savedWorkspace = localStorage.getItem('workspacePath');
    if (savedWorkspace) {
      workspacePath.value = savedWorkspace;
    }
  });
});

onBeforeUnmount(() => {
  // 组件卸载前保存当前项目的更改
  saveIfNeeded('组件卸载');

  document.removeEventListener('click', closeTreeContextMenu);
  document.removeEventListener('scroll', closeTreeContextMenu, true);
  
  if (workspacePath.value) {
    localStorage.setItem('workspacePath', workspacePath.value);
  }

  if (handleNoteShortcut) {
    window.removeEventListener('keydown', handleNoteShortcut);
    handleNoteShortcut = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  stopResize();
});
</script>