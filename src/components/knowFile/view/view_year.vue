<template>
  <div class="calendar-container">
    <!-- 顶部工具栏（路径面包屑 + 搜索）由 explorer.vue 统一渲染一条 -->

    <!-- 日历主体：月/周（日历网格）/ 年（12 小月）/ 甘特图（内嵌 view_gantt，自带状态栏） -->
    <div ref="calWrapRef" class="cal-month-wrap" :class="{ 'gantt-wrap': isGanttMode, 'year-wrap': isYearMode }">
      <ViewGantt v-if="isGanttMode" show-view-switch :view-mode="periodMode" @change-view="onViewChange" />
      <!-- 年视图：12 个小月，列数随面板宽高比自适应（12 个月始终铺满可视区） -->
      <div v-else-if="isYearMode" class="year-grid" :style="{ '--year-cols': yearCols }">
        <div v-for="m in yearMonths" :key="m.month" class="mini-month">
          <div class="mini-title" :title="store.locales==='zh' ? '打开该月的月视图' : 'Open month view'" @click="gotoMonth(m.month)">{{ m.label }}</div>
          <div class="mini-week">
            <span v-for="w in ['日','一','二','三','四','五','六']" :key="w">{{ w }}</span>
          </div>
          <div class="mini-days">
            <div v-for="(cell, ci) in m.cells" :key="ci" class="mini-day"
                 :class="{ outside: cell.outside, today: isToday(cell.date), 'has-event': !cell.outside && dayEventCount(cell.date) > 0 }"
                 :title="dayTooltip(cell.date)"
                 @click="onYearDayClick(cell)">
              <span>{{ cell.day }}</span>
            </div>
          </div>
        </div>
      </div>
      <table v-else class="cal-table" :class="{ 'week-mode': isWeekMode }">
        <thead>
          <tr>
            <th v-for="day in ['日','一','二','三','四','五','六']" :key="day">{{ day }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in calRows" :key="r">
            <td v-for="(cell, c) in row" :key="c"
                class="cal-date-cell"
                :class="{ 'outside': cell.outside, 'today': isTodayDate(cell.date), 'has-event': !cell.outside && dayEventCount(cell.date) > 0, 'drag-over': dragOverDate && isSameDay(dragOverDate, cell.date) }"
                @click="clickDate(cell)"
                @dragover.prevent="onCellDragOver(cell)"
                @dragleave="onCellDragLeave(cell)"
                @drop.prevent="onCellDrop(cell)">
              <div class="cal-date-title" :class="{ today: isTodayDate(cell.date) }">
                <span>{{ cell.day }}</span>
                <span class="cal-date-title-right">
                  <button v-if="!cell.outside" class="cal-date-add" :title="store.locales==='zh'?'在此日期新建条目':'New item on this date'" @click.stop="createOnDate(cell.date)"><i class="fa fa-plus"></i></button>
                  <span v-if="!cell.outside && dayEventCount(cell.date) > 0" class="cal-date-count">{{ dayEventCount(cell.date) }}</span>
                </span>
              </div>
              <div class="cal-date-items">
                <div v-for="(e, i) in dayEntriesOf(cell.date)" :key="i" class="cal-item"
                     :class="[chipClass(e), { dragging: draggingItem && draggingItem.path === e.item.path }]"
                     :style="chipStyle(e.item)"
                     :title="chipTitle(e)" draggable="true"
                     @dragstart="onItemDragStart($event, e.item, cell.date)"
                     @dragend="onItemDragEnd"
                     @contextmenu="openMenu($event, e.item)"
                     @click.stop="clickItem(e.item)">
                  <i class="cal-item-icon" :class="statusIconOf(e.item.attributes) || store.icon(e.item.extension || e.item.type)"></i>
                  <span class="cal-item-label">{{ stripMdSuffix(e.item.label) }}</span>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 底部状态栏：视图(月/周/年/甘特) / 翻页 / 回到今天 / 深度 / 时间字段 / 计数（路径与搜索在顶部工具栏） -->
    <div v-if="!isGanttMode" class="calendar-statusbar">
      <span v-if="store.folderName" class="statusbar-item status-folder" :title="store.dataDir" style="max-width:220px"><i class="fa fa-folder-open-o"></i><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ store.folderName }}</span></span>
      <span v-if="store.folderName" class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-calendar-o"></i> {{ store.locales==='zh'?'视图':'View' }}</span>
      <select class="statusbar-select" v-model="periodMode" :title="store.locales==='zh'?'月视图 / 周视图 / 年视图 / 甘特图':'Month / Week / Year / Gantt'">
        <option value="month">{{ store.locales==='zh'?'月视图':'Month' }}</option>
        <option value="week">{{ store.locales==='zh'?'周视图':'Week' }}</option>
        <option value="year">{{ store.locales==='zh'?'年视图':'Year' }}</option>
        <option value="gantt">{{ store.locales==='zh'?'甘特图':'Gantt' }}</option>
      </select>
      <span class="statusbar-sep"></span>
      <button class="statusbar-btn" @click="prevPeriod()" :title="periodMode==='week' ? (store.locales==='zh'?'上一周':'Previous week') : periodMode==='year' ? (store.locales==='zh'?'上一年':'Previous year') : (store.locales==='zh'?'上一月':'Previous month')"><i class="fa fa-chevron-left"></i></button>
      <button class="statusbar-btn" @click="goToday()" :title="store.locales==='zh'?'回到今天':'Today'"><i class="fa fa-crosshairs"></i></button>
      <button class="statusbar-btn" @click="nextPeriod()" :title="periodMode==='week' ? (store.locales==='zh'?'下一周':'Next week') : periodMode==='year' ? (store.locales==='zh'?'下一年':'Next year') : (store.locales==='zh'?'下一月':'Next month')"><i class="fa fa-chevron-right"></i></button>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-sitemap"></i> {{ store.locales==='zh'?'深度':'Depth' }}</span>
      <select class="statusbar-select" v-model.number="depth" @change="init()" :title="store.locales==='zh'?'扫描深度':'Scan depth'">
        <option v-for="l in [1,2,3,4,5]" :key="l" :value="l">L{{ l }}</option>
      </select>
      <template v-if="attributes.length">
        <span class="statusbar-item"><i class="fa fa-clock-o"></i> {{ store.locales==='zh'?'开始':'Start' }}</span>
        <select class="statusbar-select" v-model="attribute" :title="store.locales==='zh'?'起始时间字段（与甘特视图共用）':'Start time field (shared with the Gantt view)'">
          <option value="__default__">{{ store.locales==='zh'?'默认':'Default' }}</option>
          <option v-for="(a, i) in attributes" :key="i" :value="a.name">{{ a.name }}</option>
        </select>
        <span class="statusbar-item" :title="store.locales==='zh'?'结束时间字段：与起始字段同时存在时，条目在日历上横跨每一天（拖拽整段平移）':'End time field: entries span every day in between when both fields exist'"><i class="fa fa-clock-o"></i> {{ store.locales==='zh'?'结束':'End' }}</span>
        <select class="statusbar-select" v-model="rangeEndField" :title="store.locales==='zh'?'结束时间字段（与甘特视图共用）':'End time field (shared with the Gantt view)'">
          <option v-if="!attributes.some(a => a.name === rangeEndField)" :value="rangeEndField">{{ rangeEndField }}</option>
          <option v-for="(a, i) in attributes" :key="i" :value="a.name">{{ a.name }}</option>
        </select>
      </template>
      <!-- 归档：与看板一致，默认不显示已归档条目，点此临时查看（归档 / 取消归档在条目右键菜单里） -->
      <button class="statusbar-btn" :class="{ active: showArchived }" @click="showArchived = !showArchived" :title="store.locales==='zh'?'显示 / 隐藏已归档条目（右键条目可归档）':'Show / hide archived entries (right-click an entry to archive)'"><i class="fa fa-archive"></i></button>
      <span class="statusbar-spacer"></span>
      <span class="statusbar-item statusbar-title" :title="currentPeriodLabel"><i class="fa fa-calendar"></i> {{ currentPeriodLabel }}</span>
      <span class="statusbar-item" :title="store.locales==='zh'?'当前视图范围内的事件数（搜索时显示 命中 / 总数）':'Events in view (hits / total while searching)'"><i class="fa fa-file"></i> {{ searching ? periodFileCount + ' / ' + periodFileTotal : periodFileCount }}</span>
    </div>

    <!-- 日期事件弹窗 -->
    <div v-if="dateDialogData" class="dialog-overlay" @click="dateDialogData = null">
      <div class="dialog-box" @click.stop>
        <div class="dialog-header">
          <span>{{ dateDialogData.date }}</span>
          <button class="dialog-close" @click="dateDialogData = null">×</button>
        </div>
        <div class="dialog-body">
          <div v-for="(item, i) in dateDialogData.items" :key="item.id || i" class="dialog-item" @click="clickItem(item)" @contextmenu="openMenu($event, item)">
            <i :class="store.icon(item.extension || item.type)"></i>
            <span>{{ stripMdSuffix(item.label) }}</span>
          </div>
          <div v-if="dateDialogData.items.length === 0" class="dialog-empty">{{ store.locales === 'zh' ? '暂无事件' : 'No events' }}</div>
        </div>
      </div>
    </div>

    <!-- 条目右键菜单（打开 / 重命名 / 设置时间 / 颜色 / 复制文件路径 / 在文件夹中显示 / 删除）：
         与看板卡片菜单同一套选项与紧凑样式（见 style.css 的「知识管理模块：紧凑右键菜单」），
         .kb-menu 仅为脚本里「点击外部关闭」的判定钩子 -->
    <div
      v-if="menu"
      ref="menuEl"
      class="context-menu kb-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
      @mouseover="onMenuHover"
    >
      <div class="menu-item" @click="runMenu((it) => clickItem(it))"><i class="fa fa-external-link"></i>{{ store.locales === 'zh' ? '打开' : 'Open' }}</div>
      <div class="menu-item" @click="runMenu((it) => renameItem(it))"><i class="fa fa-pencil"></i>{{ store.locales === 'zh' ? '重命名' : 'Rename' }}</div>
      <div class="menu-item" @click="runMenu((it, p) => openDateEditAt(p.x, p.y, it))"><i class="fa fa-calendar-o"></i>{{ store.locales === 'zh' ? '设置时间' : 'Set dates' }}</div>
      <!-- 颜色：预设色板（随主题切换，浅色 / 深色各一套）/ 取色器自定义 / 清除（写入 frontmatter，条目按该色着色） -->
      <div class="menu-item has-submenu">
        <i class="fa fa-tint"></i><span class="menu-label">{{ store.locales === 'zh' ? '颜色' : 'Color' }}</span><i class="fa fa-chevron-right" style="font-size:10px;width:auto"></i>
        <div class="submenu">
          <div class="kb-swatches">
            <button
              v-for="c in COLOR_PRESETS"
              :key="c"
              class="kb-swatch"
              :class="{ current: currentColor(menu.item).toLowerCase() === c }"
              :style="{ background: c }"
              :title="c"
              @click="runMenu((it) => setColor(it, c))"
            ></button>
          </div>
          <label class="kb-color-row" :title="store.locales === 'zh' ? '用系统取色器选一个自定义颜色' : 'Pick a custom color with the system picker'">
            <i class="fa fa-eyedropper"></i><span>{{ store.locales === 'zh' ? '自定义颜色…' : 'Custom color…' }}</span>
            <span class="kb-color-hex">{{ currentColor(menu.item) }}</span>
            <input type="color" :value="currentColor(menu.item) || '#4a90d9'" @click.stop @change="onCustomColor($event, menu.item)" />
          </label>
          <div class="kb-color-row" @click="runMenu((it) => setColor(it, ''))">
            <i class="fa fa-eraser"></i><span>{{ store.locales === 'zh' ? '清除颜色' : 'Clear color' }}</span>
          </div>
        </div>
      </div>
      <div class="menu-item" @click="runMenu((it) => toggleArchive(it))">
        <i class="fa fa-archive"></i>{{ isArchived(menu.item) ? (store.locales === 'zh' ? '取消归档' : 'Unarchive') : (store.locales === 'zh' ? '归档' : 'Archive') }}
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="runMenu((it) => copyItemPath(it))"><i class="fa fa-clipboard"></i>{{ store.locales === 'zh' ? '复制文件路径' : 'Copy path' }}</div>
      <div class="menu-item" @click="runMenu((it) => revealItem(it))"><i class="fa fa-folder-open-o"></i>{{ store.locales === 'zh' ? '在文件夹中显示' : 'Reveal in folder' }}</div>
      <div class="menu-item menu-danger" @click="runMenu((it) => removeItem(it))"><i class="fa fa-trash-o"></i>{{ store.locales === 'zh' ? '删除' : 'Delete' }}</div>
    </div>

    <!-- 时间编辑浮层：菜单「设置时间」弹出；写回 frontmatter 的开始 / 结束字段（清空 = 删除该属性） -->
    <div
      v-if="dateEdit"
      ref="dateEditEl"
      class="kb-date-edit"
      :style="{ left: dateEdit.x + 'px', top: dateEdit.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <div class="de-head">
        <i class="fa fa-calendar-o"></i>
        <span class="de-title" :title="stripMdSuffix(dateEdit.item.label)">{{ store.locales === 'zh' ? '修改时间' : 'Edit dates' }}</span>
        <button class="de-close" @click="dateEdit = null" :title="store.locales === 'zh' ? '关闭 (Esc)' : 'Close (Esc)'"><i class="fa fa-times"></i></button>
      </div>
      <label class="de-row">
        <span class="de-label" :title="editStartField">{{ editStartField }}</span>
        <input class="de-input" type="date" v-model="editStartDate" @change="onDateChanged" @keydown.enter.prevent="saveDateEdit" @keydown.stop />
      </label>
      <label class="de-row">
        <span class="de-label" :title="editEndField">{{ editEndField }}</span>
        <input class="de-input" type="date" v-model="editEndDate" @change="onDateChanged" @keydown.enter.prevent="saveDateEdit" @keydown.stop />
      </label>
      <div class="de-actions">
        <button class="de-btn" :disabled="!editStartDate && !editEndDate" @click="clearDateEdit" :title="store.locales === 'zh' ? '清空两个日期（删除这两个属性）' : 'Clear both dates'">
          <i class="fa fa-eraser"></i>{{ store.locales === 'zh' ? '清除' : 'Clear' }}
        </button>
        <button class="de-btn primary" @click="saveDateEdit"><i class="fa fa-check"></i>{{ store.locales === 'zh' ? '保存' : 'Save' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { aikmIpc } from '@/lib/aikmIpc'
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch, defineAsyncComponent } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { usestore, parentPathOf } from '@/store';
import { parseSearchQuery, matchSearchTerms } from '@/lib/knowFile/itemSearch';
import { colorOfAttributes, contrastTextColor, colorFieldOf, colorPresetsFor, COLOR_FIELD_DEFAULT, FIELD_ARCHIVED, isArchivedOf, statusIconOf, statusTextOf, stripMdSuffix, attrDateOf, resolveStartFieldOf, isTimeishField } from '@/lib/knowFile/itemMeta';
// 浮层公用交互：点击外部 / Esc 收起、子菜单溢出翻转、贴边回收（见 lib/knowFile/overlay.ts）
import { bindDismiss, createSubmenuHoverFix, clampToViewport } from '@/lib/knowFile/overlay';
import { getPlatform, hasCapability } from '@/platform'

// 甘特图（原独立的「甘特/日程」视图）作为日历视图的第三种模式懒加载，避免默认加载其代码
const ViewGantt = defineAsyncComponent(() => import('@/components/knowFile/view/view_gantt.vue'));

const store = usestore();
const props = defineProps({
  year: {
    type: Number,
    default: undefined
  },
  month: {
    type: Number,
    default: undefined
  }
});

// ============ 状态 ============
const attributes = ref([]);
// 时间字段选择（本机记住；'__default__' = 走默认策略：开始时间 / 首个时间类字段 → 文件时间兜底）
const TIME_FIELD_KEY = 'calendar_time_field';
const attribute = ref(localStorage.getItem(TIME_FIELD_KEY) || '__default__');
watch(attribute, v => localStorage.setItem(TIME_FIELD_KEY, String(v)));
// 起止字段：与甘特视图共用同一组偏好（起始 `calendar_time_field` / 结束 `gantt_endField`）
// 条目同时具备「开始」「结束」两个字段时，日历按区间横跨每一天展示（拖拽则整段平移）
const END_FIELD_KEY = 'gantt_endField';
const rangeEndField = ref(localStorage.getItem(END_FIELD_KEY) || '结束时间');
watch(rangeEndField, v => localStorage.setItem(END_FIELD_KEY, String(v || '结束时间')));

// 日历内搜索：按标题 / 状态 / 属性值过滤展示的条目（不影响文件）
const searchQuery = computed(() => store.knowQuery);
const searchActive = ref(false);

const data = ref([]);
const currentYear = ref(new Date().getFullYear());
const currentMonth = ref(new Date().getMonth());
const monthCn = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
const currentMonthLabel = computed(() => `${currentYear.value} 年 ${monthCn[currentMonth.value]}`);
const depth = ref(Number(localStorage.getItem('calendar_depth') || '1'));
watch(depth, v => localStorage.setItem('calendar_depth', String(v)))

// 归档（与看板同一套）：已归档条目默认不在日历上出现，状态栏图标可临时显示
const ARCHIVED_KEY = 'calendar-view-show-archived';
const showArchived = ref(localStorage.getItem(ARCHIVED_KEY) === '1');
watch(showArchived, v => localStorage.setItem(ARCHIVED_KEY, v ? '1' : '0'));
const isArchived = (item) => isArchivedOf(item && item.attributes);
/** 按「是否显示已归档」过滤后的条目（计数 / 日历网格 / 当天列表都用它） */
const archiveVisible = computed(() => showArchived.value ? data.value : data.value.filter(it => !isArchived(it)));

// 视图模式：month=月视图 / week=周视图 / year=年视图（全年 12 个小月）/ gantt=甘特图（原「甘特」视图）
const VIEW_MODES = ['month', 'week', 'year', 'gantt'];
const savedPeriod = localStorage.getItem('calendar_period');
const periodMode = ref(VIEW_MODES.includes(savedPeriod) ? savedPeriod : 'month');
const isWeekMode = computed(() => periodMode.value === 'week');
const isYearMode = computed(() => periodMode.value === 'year');
const isGanttMode = computed(() => periodMode.value === 'gantt');
// 周视图锚点（该日期所在的那一周；周日为一周起点，与表头一致）
const weekAnchor = ref(new Date());

// 年视图自适应：测量面板尺寸 → 估算列数（12 个小月尽量铺满且不过分挤压）
const calWrapRef = ref(null);
const wrapW = ref(0);
const wrapH = ref(0);
let wrapRO = null;
// 小月卡片理想高宽比（标题 + 星期行 + 6 行日期）
const MINI_ASPECT = 0.72;
const yearCols = computed(() => {
  const W = wrapW.value, H = wrapH.value;
  if (!W || !H) return 4;
  const gap = 6;
  let best = 2, bestScore = Infinity;
  for (let c = 2; c <= 6; c++) {
    const r = Math.ceil(12 / c);
    const cw = (W - gap * (c - 1)) / c;
    const ch = (H - gap * (r - 1)) / r;
    if (cw <= 0 || ch <= 0) continue;
    // 偏差越小越接近理想卡片形状；过小再额外惩罚，避免格子被压得看不清
    const target = cw * MINI_ASPECT;
    const score = Math.abs(ch - target) / target + (cw < 110 ? 0.5 : 0) + (ch < 70 ? 0.5 : 0);
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
});

// 日期事件弹窗
const dateDialogData = ref(null)

// 拖拽改期状态
const draggingItem = ref(null);
const dragOverDate = ref(null);

// ============ 计算属性 ============
const currentDisplayDate = computed(() => {
  return currentYear.value + '年';
});

// 月视图相关

// 获取文件的日期（支持默认策略和所有包含Time的字段）
const getFileDate = (file) => {
  // 如果选择了默认策略
  if (attribute.value === '__default__') {
    // 优先级：创建时间 > 修改时间 > 其他Time字段 > 文件时间戳
    if (file.attributes && file.attributes['创建时间']) {
      return new Date(file.attributes['创建时间']);
    } else if (file.attributes && file.attributes['修改时间']) {
      return new Date(file.attributes['修改时间']);
    } else if (file.attributes) {
      // 查找所有包含"Time"的字段
      const timeKeys = Object.keys(file.attributes).filter(key => 
        key.includes('Time') || key.includes('时间')
      );
      if (timeKeys.length > 0) {
        // 使用第一个找到的时间字段
        return new Date(file.attributes[timeKeys[0]]);
      }
    } else if (file.createTime) {
      return new Date(file.createTime);
    } else if (file.modifyTime) {
      return new Date(file.modifyTime);
    } else {
      return new Date();
    }
  } else {
    // 使用指定的属性
    if (file.attributes && file.attributes[attribute.value]) {
      return new Date(file.attributes[attribute.value]);
    } else {
      return new Date();
    }
  }
};

// 日期工具
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// 周视图锚点所在周的周日（一周起点，与表头「日一二三四五六」一致）
const weekStartDate = computed(() => {
  const d = new Date(weekAnchor.value);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
});

/** ISO 周序号 */
const isoWeekNumber = (date) => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNr = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayNr + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
};

// 导航（月：±1 月；周：±7 天；年：±1 年）
const prevPeriod = () => {
  if (isWeekMode.value) { weekAnchor.value = addDays(weekStartDate.value, -7); return; }
  if (isYearMode.value) { currentYear.value--; return; }
  currentMonth.value--;
  if (currentMonth.value < 0) { currentMonth.value = 11; currentYear.value--; }
};

const nextPeriod = () => {
  if (isWeekMode.value) { weekAnchor.value = addDays(weekStartDate.value, 7); return; }
  if (isYearMode.value) { currentYear.value++; return; }
  currentMonth.value++;
  if (currentMonth.value > 11) { currentMonth.value = 0; currentYear.value++; }
};

const goToday = () => {
  const t = new Date();
  currentYear.value = t.getFullYear();
  currentMonth.value = t.getMonth();
  weekAnchor.value = t;
};

// 切换月/周/年/甘特：尽量停留在当前看的时间范围
watch(periodMode, (v) => {
  localStorage.setItem('calendar_period', v);
  if (v === 'gantt' || v === 'year') return; // 这两个模式不使用月/周锚点
  const t = new Date();
  if (v === 'week') {
    weekAnchor.value = (currentYear.value === t.getFullYear() && currentMonth.value === t.getMonth())
      ? t
      : new Date(currentYear.value, currentMonth.value, 1);
  } else {
    currentYear.value = weekAnchor.value.getFullYear();
    currentMonth.value = weekAnchor.value.getMonth();
  }
});

// 内嵌甘特图的状态栏切回月/周/年视图
const onViewChange = (v) => { periodMode.value = v; };

// 标题：月视图=年月；周视图=日期区间 + ISO 周序号；年视图=年份
const currentPeriodLabel = computed(() => {
  if (isWeekMode.value) {
    const s = weekStartDate.value;
    return `${fmtDate(s)} ~ ${fmtDate(addDays(s, 6))}  第${isoWeekNumber(s)}周`;
  }
  if (isYearMode.value) return `${currentYear.value} 年`;
  return currentMonthLabel.value;
});

// 判断今天
const isToday = (dateObj) => {
  const today = new Date();
  return dateObj.getDate() === today.getDate() &&
         dateObj.getMonth() === today.getMonth() &&
         dateObj.getFullYear() === today.getFullYear();
};

// 判断同一天
const isSameDay = (date1, date2) => {
  if (!date1 || !date2) return false;
  return date1.getDate() === date2.getDate() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getFullYear() === date2.getFullYear();
};

/** 取属性里的日期；无值 / 非法值返回 null */
const attrDate = (item, field) => attrDateOf(item, field);

/** 日历落点 / 拖拽写入用的「开始字段」（与甘特共用同一套解析：显式指定 > 开始时间 > 首个时间类字段） */
const startFieldOf = (item) => resolveStartFieldOf(item, attribute.value);

/** 条目在日历上的日期区间 { start, end }：同时有「开始」「结束」字段时横跨每一天，否则为单日 */
const rangeOf = (item) => {
  let s = attrDate(item, startFieldOf(item));
  // 起始字段没有值时退回原有默认策略（创建时间 → 修改时间 → 首个时间类字段 → 文件时间戳）
  if (!s) s = getFileDate(item);
  let e = attrDate(item, rangeEndField.value);
  if (!e || e < s) e = s;
  return { start: s, end: e };
};

/** 取当天 0 点（拖拽位移按天算，需忽略时分秒） */
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** 单条最多铺多少天（防脏数据里的超长区间把索引撑大） */
const MAX_SPAN_DAYS = 400;

/** 日历内搜索匹配：标题 / 路径 / 任意属性值（与其它视图同一套语法，见 lib/knowFile/itemSearch.ts） */
const searchTerms = computed(() => parseSearchQuery(searchQuery.value));

// 按「YYYY-MM-DD」索引当日条目（区间会展开到每一天；年视图一次要算 365 天，避免逐格扫描全量数据）
const itemsByDay = computed(() => {
  const map = new Map();
  const terms = searchTerms.value;
  for (const item of archiveVisible.value) {
    const start = item.date;
    if (!start || isNaN(start.getTime())) continue;
    let end = item.dateEnd && !isNaN(item.dateEnd.getTime()) ? item.dateEnd : start;
    if (end < start) end = start;
    if (!matchSearchTerms(item, terms)) continue;
    const total = Math.min(Math.round((dayStart(end) - dayStart(start)) / 86400000) + 1, MAX_SPAN_DAYS);
    for (let i = 0; i < total; i++) {
      const k = fmtDate(addDays(start, i));
      const entry = { item, spanStart: i === 0, spanEnd: i === total - 1, multi: total > 1 };
      const arr = map.get(k);
      if (arr) arr.push(entry); else map.set(k, [entry]);
    }
  }
  return map;
});

// 某天的条目（含区间信息，供日历网格渲染条目条）
const dayEntriesOf = (dateObj) => itemsByDay.value.get(fmtDate(dateObj)) || [];
// 某天的条目列表（原始条目，供弹窗 / 计数 / 悬浮提示）
const getDayItems = (dateObj) => dayEntriesOf(dateObj).map(e => e.item);

/** 生成某月的 6 行×7 列网格（跨月日期灰显），各月行高一致 */
const buildMonthRows = (year, month) => {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();
  const rows = [];
  let cells = [];
  const push = (y, m, d, outside) => {
    cells.push({ year: y, month: m, day: d, outside, date: new Date(y, m, d) });
    if (cells.length === 7) { rows.push(cells); cells = []; }
  };
  // 月初前的跨月日期（灰显）：共 firstDow 个，从上月最后一天往前数（注意别把本月 1 号重复算进来）
  for (let i = firstDow; i > 0; i--) {
    const dt = new Date(year, month, 1 - i);
    push(dt.getFullYear(), dt.getMonth(), dt.getDate(), true);
  }
  for (let d = 1; d <= daysInMonth; d++) push(year, month, d, false);
  // 补齐到 6 行（跨下月灰显）
  let add = 1;
  while (rows.length < 6) {
    const dt = new Date(year, month, daysInMonth + add);
    push(dt.getFullYear(), dt.getMonth(), dt.getDate(), true);
    add++;
  }
  return rows;
};

// 日历网格：月视图=6 行×7 列（跨月日期灰显）；周视图=1 行×7 天
const calRows = computed(() => {
  if (isWeekMode.value) {
    const s = weekStartDate.value;
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const dt = addDays(s, i);
      cells.push({ year: dt.getFullYear(), month: dt.getMonth(), day: dt.getDate(), outside: false, date: dt });
    }
    return [cells];
  }
  return buildMonthRows(currentYear.value, currentMonth.value);
});

// 年视图：全年 12 个小月
const yearMonths = computed(() => {
  const y = currentYear.value;
  return monthCn.map((label, m) => ({ month: m, label, cells: buildMonthRows(y, m).flat() }));
});

// 某天的事件数量
const dayEventCount = (dateObj) => dayEntriesOf(dateObj).length;
// 搜索命中的条目（无搜索时为全部）
const visibleItems = computed(() => {
  const terms = searchTerms.value;
  return terms.length ? archiveVisible.value.filter(it => matchSearchTerms(it, terms)) : archiveVisible.value;
});
/** 某集合在当前视图范围内（月=本月 / 周=本周 / 年=本年，按区间起点计）的事件数 */
const countInPeriod = (list) => {
  const valid = list.filter(it => it.date && !isNaN(it.date.getTime()));
  if (isWeekMode.value) {
    const s = weekStartDate.value;
    const e = addDays(s, 7);
    return valid.filter(it => it.date >= s && it.date < e).length;
  }
  if (isYearMode.value) return valid.filter(it => it.date.getFullYear() === currentYear.value).length;
  return valid.filter(it => it.date.getFullYear() === currentYear.value && it.date.getMonth() === currentMonth.value).length;
};
const periodFileCount = computed(() => countInPeriod(visibleItems.value));
const periodFileTotal = computed(() => countInPeriod(archiveVisible.value));
const searching = computed(() => !!searchQuery.value.trim());
const isTodayDate = (dateObj) => isToday(dateObj);

// ---- 条目条展示（颜色 / 状态图标 / 跨天区间） ----
/** 条目条配色：有 `颜色` 属性时用它做底色，并按亮度自动选对比文字色 */
const chipStyle = (item) => {
  const c = colorOfAttributes(item.attributes);
  if (!c) return undefined;
  return { backgroundColor: c, borderLeftColor: c, color: contrastTextColor(c) };
};
/** 跨天条目的区间标记（首日 / 末日圆角，便于看出是一段而不是多条） */
const chipClass = (e) => ({
  span: e.multi,
  'span-start': e.multi && e.spanStart,
  'span-end': e.multi && e.spanEnd,
});
/** 条目条悬浮提示：标题 · 区间 · 状态 */
const chipTitle = (e) => {
  const item = e.item;
  const parts = [stripMdSuffix(item.label)];
  if (e.multi && item.date && item.dateEnd) parts.push(`${fmtDate(item.date)} ~ ${fmtDate(item.dateEnd)}`);
  const st = statusTextOf(item.attributes);
  if (st) parts.push(st);
  return parts.join(' · ');
};

// ---- 年视图交互 ----
/** 日期格悬浮提示：当天条目名称 */
const dayTooltip = (dateObj) => {
  const items = getDayItems(dateObj);
  if (!items.length) return '';
  const names = items.slice(0, 8).map(i => stripMdSuffix(i.label)).join('、');
  return `${fmtDate(dateObj)}：${names}${items.length > 8 ? ` … 共 ${items.length} 条` : ''}`;
};

/** 年视图点击某天：有事件则弹出当天列表；空白日期不做跳转（点小月标题才进月视图） */
const onYearDayClick = (cell) => {
  if (getDayItems(cell.date).length) showDateEvents(cell.date);
};

/** 年视图点击小月标题：跳到该月的月视图 */
const gotoMonth = (m) => {
  currentMonth.value = m;
  periodMode.value = 'month';
};

// 点击日期：跨月日期跳到对应月；当月有事件则弹列表
const clickDate = (cell) => {
  if (cell.outside) {
    currentYear.value = cell.year;
    currentMonth.value = cell.month;
    return;
  }
  if (getDayItems(cell.date).length) showDateEvents(cell.date);
};

// 显示某天的所有事件
const showDateEvents = (dateObj) => {
  const items = getDayItems(dateObj)
  if (items.length === 0) return
  dateDialogData.value = {
    date: `${dateObj.getFullYear()}-${dateObj.getMonth()+1}-${dateObj.getDate()}`,
    items
  }
};

// 点击项目
const clickItem = (item) => {
  store.openFileByMode(item)
  dateDialogData.value = null
};

// ===== 拖拽改期 / 格内新建（写入 YAML 时间字段） =====

/** 可写元数据的目标路径：.md 文件本身；文件夹取其 .README.md（不存在则不可写） */
const markdownTargetOf = async (item) => {
  const p = String(item?.path || '');
  if (!p) return null;
  if (item.type === 'file' && p.toLowerCase().endsWith('.md')) return p;
  if (item.type === 'folder') {
    const sep = p.includes('\\') ? '\\' : '/';
    const readme = p.replace(/[\\/]+$/, '') + sep + '.README.md';
    try {
      const inf = await getPlatform().fs.getInfo(readme);
      return inf ? readme : null;
    } catch { return null; }
  }
  return null;
};

/** 改期写入哪个时间字段：日历当前选的字段 > 与甘特共用的开始字段 > 文件已有时间字段 > 开始时间 */
const resolveTimeField = (item) => startFieldOf(item);

/** 合并写 frontmatter：一次读取 + 一次写盘，值为空则删除该字段（其余元数据原样保留） */
const patchMeta = async (target, patch) => {
  try {
    const meta = (await getPlatform().fs.readMetadata(target)) || {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') delete meta[k];
      else meta[k] = v;
    }
    return !!await getPlatform().fs.saveMetadata(target, meta);
  } catch { return false; }
};

/** 写入一个或多个时间字段 */
const writeDateFields = async (target, pairs) => {
  const patch = {};
  for (const [field, dateStr] of pairs) {
    if (field) patch[field] = dateStr;
  }
  if (!Object.keys(patch).length) return false;
  return patchMeta(target, patch);
};

// 拖拽起点：记住从哪一天抓起来（区间条目按「抓起点 → 落点」整天平移）
const dragFromDate = ref(null);
const onItemDragStart = (e, item, fromDate) => {
  draggingItem.value = item;
  dragFromDate.value = fromDate || item.date || null;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(item.path || ''));
  }
};
const onItemDragEnd = () => { draggingItem.value = null; dragOverDate.value = null; dragFromDate.value = null; };
const onCellDragOver = (cell) => { if (draggingItem.value) dragOverDate.value = cell.date; };
const onCellDragLeave = (cell) => {
  if (dragOverDate.value && isSameDay(dragOverDate.value, cell.date)) dragOverDate.value = null;
};

/** 拖到某天：把该条目改期到目标日期（带区间时整段平移，保持时长） */
const onCellDrop = async (cell) => {
  const item = draggingItem.value;
  const from = dragFromDate.value || item?.date;
  dragOverDate.value = null;
  draggingItem.value = null;
  dragFromDate.value = null;
  if (!item || !from) return;
  const delta = Math.round((dayStart(cell.date) - dayStart(from)) / 86400000);
  if (!delta) return;
  const target = await markdownTargetOf(item);
  if (!target) {
    ElMessage.warning(store.locales === 'zh' ? '仅 Markdown 文件（或含 .README.md 的文件夹）可拖拽改期' : 'Only Markdown files can be rescheduled');
    return;
  }
  const start = addDays(item.date, delta);
  const end = addDays(item.dateEnd || item.date, delta);
  const pairs = [[resolveTimeField(item), fmtDate(start)]];
  // 区间条目：结束字段一并平移；单日条目只写起始字段
  if (item.dateEnd && item.dateEnd.getTime() !== item.date.getTime() && rangeEndField.value) {
    pairs.push([rangeEndField.value, fmtDate(end)]);
  }
  const ok = await writeDateFields(target, pairs);
  if (ok) {
    const span = pairs.length > 1;
    ElMessage.success(store.locales === 'zh'
      ? (span ? `已改期：${fmtDate(start)} ~ ${fmtDate(end)}` : `已改期：${pairs[0][0]} → ${fmtDate(start)}`)
      : `Rescheduled: ${fmtDate(start)}${span ? ' ~ ' + fmtDate(end) : ''}`);
    await init();
  } else {
    ElMessage.error(store.locales === 'zh' ? '改期失败' : 'Reschedule failed');
  }
};

/** 日期格内新建：在当前文件夹创建 Markdown，并把时间字段设为该日期 */
const createOnDate = async (date) => {
  const dir = store.dataDir;
  if (!dir) {
    ElMessage.warning(store.locales === 'zh' ? '请先打开工作区' : 'Open a workspace first');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt(
      store.locales === 'zh' ? '请输入文件名:' : 'Enter file name:',
      store.locales === 'zh' ? `新建条目（${fmtDate(date)}）` : `New item (${fmtDate(date)})`,
      {
        confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
        cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
        inputPattern: /\S+/,
        inputErrorMessage: store.locales === 'zh' ? '名称不能为空' : 'Name cannot be empty'
      }
    );
    const name = String(value || '').trim();
    if (!name) return;
    const path = await getPlatform().fs.createFile(dir, name + '.md');
    if (!path) {
      ElMessage.error(store.locales === 'zh' ? '创建失败（可能同名文件已存在）' : 'Create failed (name may exist)');
      return;
    }
    const field = (attribute.value && attribute.value !== '__default__') ? attribute.value : '开始时间';
    const ok = await patchMeta(path, { [field]: fmtDate(date) });
    ElMessage.success(
      ok
        ? (store.locales === 'zh' ? `已新建「${name}」并设为 ${fmtDate(date)}` : `Created "${name}" on ${fmtDate(date)}`)
        : (store.locales === 'zh' ? `已新建「${name}」` : `Created "${name}"`)
    );
    await init();
  } catch { /* 用户取消 */ }
};

// ===== 条目右键菜单（打开 / 重命名 / 设置时间 / 颜色 / 复制文件路径 / 在文件夹中显示 / 删除） =====
// 与看板卡片菜单同一套选项与外观（.kb-menu 紧凑样式 + .kb-date-edit 时间浮层，见 style.css）
const menu = ref(null);
const menuEl = ref(null);
bindDismiss(computed(() => !!menu.value), '.kb-menu', () => { menu.value = null });
const onMenuHover = createSubmenuHoverFix('.kb-menu');

/** 右键条目：记住坐标与条目（菜单渲染后贴边回收进视口） */
const openMenu = (e, item) => {
  e.preventDefault();
  e.stopPropagation();
  menu.value = { x: e.clientX, y: e.clientY, item };
  nextTick(() => {
    if (!menu.value) return;
    const p = clampToViewport(menuEl.value, menu.value.x, menu.value.y);
    menu.value = { ...menu.value, x: p.x, y: p.y };
  });
};
/**
 * 菜单项统一入口：先收起菜单再把条目传给动作（避免操作后菜单残留 / 读到已清空的 menu）。
 * 第二个参数是菜单当时的坐标（「设置时间」要把时间浮层开在菜单位置）。
 */
const runMenu = (fn) => {
  const cur = menu.value;
  menu.value = null;
  if (cur && cur.item) void fn(cur.item, { x: cur.x, y: cur.y });
};

/** 条目的颜色属性（读 `颜色`，兼容 `color`） */
const currentColor = (item) => colorOfAttributes(item && item.attributes);
/** 预设色板（按主题亮度取一套，与看板卡片菜单共用） */
const COLOR_PRESETS = computed(() => colorPresetsFor(store.UI.backgroundColor));
/** 写入 / 清除条目颜色（留空 = 两个可能的字段名一起删，不留下另一个） */
const setColor = async (item, value) => {
  const target = await markdownTargetOf(item);
  if (!target) {
    ElMessage.warning(store.locales === 'zh' ? '仅 Markdown 文件可设置颜色' : 'Only Markdown files can be colored');
    return;
  }
  const patch = value
    ? { [colorFieldOf(item.attributes)]: value }
    : { [COLOR_FIELD_DEFAULT]: undefined, color: undefined };
  const ok = await patchMeta(target, patch);
  if (!ok) {
    ElMessage.error(store.locales === 'zh' ? '颜色写入失败' : 'Failed to save color');
    return;
  }
  await init();
  ElMessage.success(value
    ? (store.locales === 'zh' ? `已设置颜色 ${value}` : `Color set to ${value}`)
    : (store.locales === 'zh' ? '已清除颜色' : 'Color cleared'));
};
/** 取色器确认后写入并收起菜单（原生取色器只在确认时触发 change） */
const onCustomColor = async (e, item) => {
  const value = e.target.value;
  menu.value = null;
  if (value) await setColor(item, value);
};

/** 重命名条目文件：提示里填条目名（不带 .md），未写扩展名时自动补回原扩展名 */
const renameItem = async (item) => {
  const ext = String(item.extension || '.md');
  const base = stripMdSuffix(item.label);
  try {
    const { value } = await ElMessageBox.prompt(
      store.locales === 'zh' ? '请输入新的文件名：' : 'Enter a new file name:',
      store.locales === 'zh' ? '重命名' : 'Rename',
      {
        confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
        cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel',
        inputValue: base,
        inputPattern: /[^\s\\/:*?"<>|]/,
        inputErrorMessage: store.locales === 'zh' ? '名称不能为空，也不能含 \\ / : * ? " < > |' : 'Name is empty or contains \\ / : * ? " < > |'
      }
    );
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed === base) return;
    const fileName = trimmed.toLowerCase().endsWith(ext.toLowerCase()) ? trimmed : trimmed + ext;
    const result = await getPlatform().fs.renameFile(item.path, fileName);
    if (!result || !result.success) {
      ElMessage.error(store.locales === 'zh' ? `重命名失败：${(result && result.error) || ''}` : `Rename failed: ${(result && result.error) || ''}`);
      return;
    }
    dateDialogData.value = null;
    await init();
    ElMessage.success(store.locales === 'zh' ? `已重命名为「${stripMdSuffix(fileName)}」` : `Renamed to "${fileName}"`);
  } catch { /* 用户取消 */ }
};

/** 归档 / 取消归档（写入 `归档` 属性；已归档条目默认不在日历上显示，点状态栏归档图标可查看） */
const toggleArchive = async (item) => {
  const next = !isArchived(item);
  const target = await markdownTargetOf(item);
  if (!target) {
    ElMessage.warning(store.locales === 'zh' ? '仅 Markdown 文件可归档' : 'Only Markdown files can be archived');
    return;
  }
  const ok = await patchMeta(target, { [FIELD_ARCHIVED]: next ? true : undefined });
  if (!ok) {
    ElMessage.error(store.locales === 'zh' ? '归档写入失败' : 'Failed to update archive');
    return;
  }
  dateDialogData.value = null;
  await init();
  ElMessage.success(next
    ? (store.locales === 'zh' ? '已归档（可在状态栏显示）' : 'Archived')
    : (store.locales === 'zh' ? '已取消归档' : 'Unarchived'));
};

const copyItemPath = async (item) => {
  try {
    await navigator.clipboard.writeText(String(item.path || ''));
    ElMessage.success(store.locales === 'zh' ? '已复制文件路径' : 'Path copied');
  } catch {
    ElMessage.error(store.locales === 'zh' ? '复制失败' : 'Copy failed');
  }
};

const revealItem = async (item) => {
  const dir = parentPathOf(item.path);
  if (!dir) return;
  await getPlatform().shell.openWithSystemApp(dir);
};

const removeItem = async (item) => {
  try {
    await ElMessageBox.confirm(
      store.locales === 'zh' ? `确定删除「${stripMdSuffix(item.label)}」？此操作不可恢复。` : `Delete "${stripMdSuffix(item.label)}"? This cannot be undone.`,
      store.locales === 'zh' ? '删除文件' : 'Delete file',
      { type: 'warning', confirmButtonText: store.locales === 'zh' ? '删除' : 'Delete', cancelButtonText: store.locales === 'zh' ? '取消' : 'Cancel' }
    );
  } catch {
    return;
  }
  const ok = !!(await getPlatform().fs.deleteFile(item.path));
  if (!ok) {
    ElMessage.error(store.locales === 'zh' ? '删除失败' : 'Delete failed');
    return;
  }
  store.closeTabByPath(item.path);
  dateDialogData.value = null;
  await init();
  ElMessage.success(store.locales === 'zh' ? '已删除' : 'Deleted');
};

// ---- 时间编辑浮层（菜单「设置时间」，写回文件里已有的起止字段） ----
const dateEdit = ref(null);
const dateEditEl = ref(null);
const editStartDate = ref('');
const editEndDate = ref('');
const editStartField = ref('开始时间');
const editEndField = ref('结束时间');
/** 打开时的原值：用来跳过「点开又直接保存」这类没有改动的写入 */
let editStartRaw = '';
let editEndRaw = '';
bindDismiss(computed(() => !!dateEdit.value), '.kb-date-edit', () => { dateEdit.value = null });

/** 在指定位置打开某条目的时间编辑器（起止字段沿用文件里已有的写法） */
const openDateEditAt = (x, y, item) => {
  const startField = startFieldOf(item);
  const endField = rangeEndField.value || '结束时间';
  // 起始值：文件里该字段有值就用它；否则用日历上的落点（可能来自文件时间戳兜底），便于直接钉住
  const start = attrDate(item, startField) || (item.date && !isNaN(item.date.getTime()) ? item.date : null);
  // 结束值只在文件里真有该字段时才带出，避免保存时多写一个冗余的结束时间
  const end = attrDate(item, endField);
  editStartField.value = startField;
  editEndField.value = endField;
  editStartDate.value = editStartRaw = start ? fmtDate(start) : '';
  editEndDate.value = editEndRaw = end ? fmtDate(end) : '';
  dateEdit.value = { x, y, item };
  nextTick(() => {
    if (!dateEdit.value) return;
    const p = clampToViewport(dateEditEl.value, dateEdit.value.x, dateEdit.value.y);
    dateEdit.value = { ...dateEdit.value, x: p.x, y: p.y };
  });
};

const datesChanged = () => editStartDate.value !== editStartRaw || editEndDate.value !== editEndRaw;

/** 写回开始 / 结束字段（清空 = 删除该属性，其余元数据原样保留） */
const applyDates = async () => {
  const cur = dateEdit.value;
  if (!cur) return;
  const target = await markdownTargetOf(cur.item);
  if (!target) {
    ElMessage.error(store.locales === 'zh' ? '仅 Markdown 文件可设置时间' : 'Only Markdown files can be rescheduled');
    return;
  }
  const ok = await patchMeta(target, {
    [editStartField.value]: editStartDate.value || undefined,
    [editEndField.value]: editEndDate.value || undefined
  });
  if (!ok) {
    ElMessage.error(store.locales === 'zh' ? '时间写入失败' : 'Failed to save dates');
    return;
  }
  editStartRaw = editStartDate.value;
  editEndRaw = editEndDate.value;
  await init();
};
/** 日期选完即应用（与看板的时间浮层一致），浮层保持打开便于接着改另一个 */
const onDateChanged = () => {
  if (datesChanged()) void applyDates();
};
const saveDateEdit = async () => {
  const changed = datesChanged();
  if (changed) await applyDates();
  dateEdit.value = null;
  if (changed) ElMessage.success(store.locales === 'zh' ? '已更新时间' : 'Dates updated');
};
const clearDateEdit = async () => {
  editStartDate.value = '';
  editEndDate.value = '';
  await saveDateEdit();
};

// ===== 元数据选项列表的获取逻辑 =====
// 1. 遍历所有文件数据 (store.data)
// 2. 提取每个文件的 attributes 对象的所有键名
// 3. 筛选出包含 "Time"、"time" 或 "时间" 的字段
// 4. 去重
// 5. 按优先级排序
const getAttributes = function() {
  let allProps = [];
  let propMap = {};
  
  // 从 data.value（实际文件数据）中提取属性
  data.value.forEach((file) => {
    if (file.attributes && typeof file.attributes === 'object') {
      const keys = Object.keys(file.attributes);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        // 筛选包含时间关键词的字段（不区分大小写）
        if (isTimeishField(key)) {
          if (!propMap[key]) {
            propMap[key] = {
              name: key,
              count: 0
            };
          }
          propMap[key].count++;
          allProps.push(key);
        }
      }
    }
  });
  
  // 去重
  let uniqueProps = [...new Set(allProps)];
  
  // 转换为选项格式
  attributes.value = uniqueProps.map(name => ({
    name: name,
    count: propMap[name]?.count || 0
  }));
  
  // 按出现次数降序排序
  attributes.value.sort((a, b) => b.count - a.count);

  // 历史选择的字段已不存在（换工作区/改名）时回落到「默认」，避免下拉显示空白
  if (attribute.value !== '__default__' && data.value.length && !attributes.value.some(a => a.name === attribute.value)) {
    attribute.value = '__default__';
  }
};

/** 重算所有条目的日期区间（时间字段 / 结束字段 / 数据变化时调用） */
const recomputeRanges = () => {
  for (const item of data.value) {
    const r = rangeOf(item);
    item.date = r.start;
    item.dateEnd = r.end;
  }
};

// 初始化数据
const init = async function() {
  const dir = store.dataDir;
  if (dir) {
    try {
      const list = await aikmIpc.invoke("getFiles", dir, depth.value);
      // 只显示 Markdown 文件（与甘特一致）：文件夹与图片 / 数据 / 代码等格式不参与日历
      data.value = (list || []).filter(f => f.type === 'file' && String(f.extension || '').toLowerCase() === '.md');
    } catch (e) {
      console.warn('无法获取文件列表:', e);
      data.value = [];
    }
  }
  recomputeRanges();
  getAttributes();
};

// ============ 监听 ============
watch([() => store.root, () => store.path], () => {
  init();
});
// 顶部工具栏的「刷新」：重新拉取当前目录
watch(() => store.knowRefreshTick, () => {
  init();
});

watch(attribute, () => recomputeRanges());
watch(rangeEndField, () => recomputeRanges());

// ============ 生命周期 ============
onMounted(() => {
  init();
  // 年视图自适应：监听面板尺寸（窗口缩放 / 与其他视图并排拖动分隔条都会触发）
  const el = calWrapRef.value;
  if (el && typeof ResizeObserver !== 'undefined') {
    wrapW.value = el.clientWidth;
    wrapH.value = el.clientHeight;
    wrapRO = new ResizeObserver(() => {
      wrapW.value = el.clientWidth;
      wrapH.value = el.clientHeight;
    });
    wrapRO.observe(el);
  }
});

onBeforeUnmount(() => {
  if (wrapRO) { wrapRO.disconnect(); wrapRO = null; }
});
</script>

<style scoped>
.calendar-container {
  font-family: Arial, sans-serif;
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  user-select: none;
}

/* ===== 单月日历（样式参考待办月视图） ===== */
.cal-month-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 4px;
  box-sizing: border-box;
}
/* 甘特模式：内嵌 view_gantt（自带状态栏），外层不再留内边距 / 叠边框 */
.cal-month-wrap.gantt-wrap {
  padding: 0;
}
.cal-month-wrap.gantt-wrap :deep(.bg) {
  border-right: none;
}

/* ===== 年视图：12 个小月，列数由 --year-cols 控制（脚本按面板宽高比算），始终铺满可视区 ===== */
.year-grid {
  display: grid;
  grid-template-columns: repeat(var(--year-cols, 4), minmax(0, 1fr));
  grid-auto-rows: minmax(0, 1fr);
  gap: 6px;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.mini-month {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  box-sizing: border-box;
  /* 容器查询：内部字号随小月宽度缩放，窄面板也看得清 */
  container-type: inline-size;
}
.mini-title {
  flex-shrink: 0;
  text-align: center;
  padding: 1px 0;
  font-size: clamp(8px, 5cqw, 14px);
  color: var(--fontActiveColor);
  border-bottom: 1px solid var(--borderColor);
  cursor: pointer;
  user-select: none;
}
.mini-title:hover {
  background: var(--menuActiveColor);
}
.mini-week {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  text-align: center;
  font-size: clamp(6px, 3.4cqw, 11px);
  color: var(--borderColor);
  line-height: 1.5;
  user-select: none;
}
.mini-days {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-template-rows: repeat(6, minmax(0, 1fr));
}
.mini-day {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
  font-size: clamp(6px, 4.2cqw, 13px);
  line-height: 1;
  color: var(--fontColor);
  border-radius: 2px;
  cursor: pointer;
}
.mini-day:hover {
  background: var(--menuActiveColor);
}
.mini-day.outside {
  opacity: 0.3;
}
.mini-day.today {
  color: var(--fontActiveColor);
  font-weight: 700;
  box-shadow: inset 0 0 0 1px var(--fontActiveColor);
}
/* 有事件的日期：数字下方一个小圆点（具体条目见悬浮提示） */
.mini-day.has-event::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 6%;
  width: 22%;
  max-width: 4px;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--fontActiveColor);
  transform: translateX(-50%);
}
.cal-table {
  width: 100%;
  height: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.cal-table thead th {
  padding: 2px 0;
  font-size: 11px;
  font-weight: 400;
  color: var(--borderColor);
  border-bottom: 1px solid var(--borderColor);
}
.cal-table tbody tr {
  height: 16.66%;
}
.cal-table.week-mode tbody tr {
  height: 100%;
}
.cal-table td {
  vertical-align: top;
  padding: 1px;
  border: 1px solid var(--borderColor);
  cursor: pointer;
  position: relative;
  min-width: 0;
}
.cal-date-cell:hover {
  box-shadow: inset 0 0 0 1px var(--fontActiveColor);
}
/* 今天：整格用 fontActiveColor 描边 + 淡底（月视图 / 周视图共用），日期与计数也用强调色 */
.cal-date-cell.today {
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  box-shadow: inset 0 0 0 1px var(--fontActiveColor);
}
.cal-date-cell.today .cal-date-title {
  color: var(--fontActiveColor);
  font-weight: 700;
}
.cal-date-cell.today .cal-date-count {
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.cal-date-cell.today .cal-date-add {
  color: var(--fontActiveColor);
  opacity: 0.9;
}
.cal-date-cell.drag-over {
  box-shadow: inset 0 0 0 2px var(--fontActiveColor);
  background: var(--menuActiveColor);
}
.cal-date-cell.outside {
  opacity: 0.4;
}
.cal-date-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: 11px;
  margin: 1px 2px;
  color: var(--fontColor);
}
.cal-date-title.today {
  color: var(--fontActiveColor);
}
.cal-date-title.today span:first-child {
  font-weight: 700;
}
.cal-date-count {
  font-size: 9px;
  font-weight: 600;
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
.cal-date-title-right {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
/* 格内新建：默认隐藏，悬停日期格才出现（避免干扰事件列表） */
.cal-date-add {
  display: none;
  border: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 9px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  opacity: 0.65;
  border-radius: 2px;
}
.cal-date-cell:hover .cal-date-add {
  display: inline-flex;
}
.cal-date-add:hover {
  opacity: 1;
  color: var(--fontActiveColor);
  background: var(--menuActiveColor);
}
.cal-date-items {
  overflow-y: auto;
  overflow-x: hidden;
  height: calc(100% - 20px);
}
.cal-item {
  display: flex;
  align-items: center;
  gap: 4px;
  /* 与日期数字同号（11px）：此前 9px 在条目条里太小 */
  font-size: 11px;
  line-height: 16px;
  color: var(--fontColor);
  padding: 0 3px;
  border-radius: 2px;
  cursor: pointer;
  white-space: nowrap;
}
/* 条目图标（状态图标 / 文件类型图标）：随文字一起放大，且不参与压缩 */
.cal-item-icon {
  flex-shrink: 0;
  font-size: 10px;
  opacity: 0.85;
}
/* 跨天条目（区间）：整段左侧色条 + 淡底，首尾切直角，便于看出一段而非多条 */
.cal-item.span {
  border-left: 3px solid var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
}
.cal-item.span-start {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.cal-item.span-end {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.cal-item:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
}
.cal-item.dragging {
  opacity: 0.4;
}
.cal-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* ===== 底部状态栏（与代码编辑/阅读视图一致观感） ===== */
.calendar-statusbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  box-sizing: border-box;
  flex-shrink: 0;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  background-color: var(--menuColor);
  border-top: 1px solid var(--borderColor);
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.calendar-statusbar .statusbar-item { display: inline-flex; align-items: center; gap: 4px; opacity: 0.85; }
.calendar-statusbar .statusbar-item i { font-size: 11px; opacity: 0.7; }
.calendar-statusbar .statusbar-spacer { flex: 1; }
.calendar-statusbar .statusbar-btn {
  margin: 0; padding: 0 6px; height: 18px; border: none; border-radius: 3px; background: transparent;
  color: var(--fontColor); font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0.85; transition: background-color 0.15s; flex-shrink: 0;
}
.calendar-statusbar .statusbar-btn:hover { background: var(--menuActiveColor); opacity: 1; }
/* 生效中的开关（如「显示已归档」）用强调色标出（与看板状态栏一致） */
.calendar-statusbar .statusbar-btn.active { color: var(--fontActiveColor); opacity: 1; }
.calendar-statusbar .statusbar-sep { width: 1px; height: 14px; background: var(--borderColor); flex-shrink: 0; }
.calendar-statusbar .statusbar-select {
  height: 18px; border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; padding: 0 4px;
  width: auto; min-width: 44px; max-width: 110px; outline: none; cursor: pointer; flex-shrink: 0;
}
.calendar-statusbar .statusbar-select option {
  background: var(--menuColor); color: var(--fontColor);
}
.calendar-statusbar .statusbar-title { color: var(--fontActiveColor); opacity: 0.9; font-weight: 600; }

/* ===== 事件弹窗 ===== */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.dialog-box {
  min-width: 260px;
  max-width: 400px;
  max-height: calc(70vh / var(--ui-zoom, 1));
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  color: var(--fontColor);
  user-select: none;
}
.dialog-close {
  border: none;
  background: transparent;
  color: var(--fontColor);
  font-size: 16px;
  cursor: pointer;
  padding: 0 6px;
  opacity: 0.6;
  border-radius: 3px;
}
.dialog-close:hover { opacity: 1; background: var(--menuColor); }
.dialog-body {
  padding: 6px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dialog-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fontColor);
  transition: background 0.15s;
}
.dialog-item:hover { background: var(--menuActiveColor); }
.dialog-item i { width: 16px; text-align: center; }
.dialog-item span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dialog-empty {
  padding: 20px;
  text-align: center;
  color: var(--borderColor);
  font-size: 13px;
}

/* ===== 通用 ===== */
select {
  background-color: var(--bgColor);
  color: var(--fontColor);
  border-color: var(--borderColor);
  cursor: pointer;
  padding: 0 4px;
}

select:focus {
  outline: none;
  border-color: var(--fontActiveColor);
}

/* ===== 滚动条 ===== */
::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

::-webkit-scrollbar-track {
  background: var(--bgColor);
}

::-webkit-scrollbar-thumb {
  background: var(--borderColor);
  border-radius: 2px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--fontActiveColor);
}

/* 右键菜单样式统一在 explorer.vue 中定义 */
</style>