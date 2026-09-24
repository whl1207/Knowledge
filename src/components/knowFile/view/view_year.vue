<template>
  <div class="calendar-container">

    <!-- 单月日历（样式参考待办月视图） -->
    <div class="cal-month-wrap">
      <table class="cal-table">
        <thead>
          <tr>
            <th v-for="day in ['日','一','二','三','四','五','六']" :key="day">{{ day }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in calRows" :key="r">
            <td v-for="(cell, c) in row" :key="c"
                class="cal-date-cell"
                :class="{ 'outside': cell.outside, 'today': isTodayDate(cell.date), 'has-event': !cell.outside && dayEventCount(cell.date) > 0 }"
                @click="clickDate(cell)">
              <div class="cal-date-title" :class="{ today: isTodayDate(cell.date) }">
                <span>{{ cell.day }}</span>
                <span v-if="!cell.outside && dayEventCount(cell.date) > 0" class="cal-date-count">{{ dayEventCount(cell.date) }}</span>
              </div>
              <div class="cal-date-items">
                <div v-for="(item, i) in dayItemsOf(cell.date)" :key="i" class="cal-item"
                     :title="item.label" @click.stop="clickItem(item)">
                  <i :class="store.icon(item.extension || item.type)" style="font-size:9px"></i>
                  <span class="cal-item-label">{{ item.label }}</span>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 底部状态栏：翻月 / 回到今天 / 深度 / 时间字段 / 计数 -->
    <div class="calendar-statusbar">
      <button class="statusbar-btn" @click="prevPeriod()" :title="store.locales==='zh'?'上一月':'Previous month'"><i class="fa fa-chevron-left"></i></button>
      <button class="statusbar-btn" @click="goToday()" :title="store.locales==='zh'?'回到今天':'Today'"><i class="fa fa-crosshairs"></i></button>
      <button class="statusbar-btn" @click="nextPeriod()" :title="store.locales==='zh'?'下一月':'Next month'"><i class="fa fa-chevron-right"></i></button>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-sitemap"></i> {{ store.locales==='zh'?'深度':'Depth' }}</span>
      <select class="statusbar-select" v-model.number="depth" @change="init()" :title="store.locales==='zh'?'扫描深度':'Scan depth'">
        <option v-for="l in [1,2,3,4,5]" :key="l" :value="l">L{{ l }}</option>
      </select>
      <template v-if="attributes.length">
        <span class="statusbar-item"><i class="fa fa-clock-o"></i> {{ store.locales==='zh'?'时间':'Time' }}</span>
        <select class="statusbar-select" v-model="attribute" :title="store.locales==='zh'?'时间字段':'Time field'">
          <option value="__default__">{{ store.locales==='zh'?'默认':'Default' }}</option>
          <option v-for="(a, i) in attributes" :key="i" :value="a.name">{{ a.name }}</option>
        </select>
      </template>
      <span class="statusbar-spacer"></span>
      <span class="statusbar-item statusbar-title" :title="currentMonthLabel"><i class="fa fa-calendar"></i> {{ currentMonthLabel }}</span>
      <span class="statusbar-item" :title="store.locales==='zh'?'本月事件':'Events this month'"><i class="fa fa-file"></i> {{ monthFileCount }}</span>
    </div>

    <!-- 日期事件弹窗 -->
    <div v-if="dateDialogData" class="dialog-overlay" @click="dateDialogData = null">
      <div class="dialog-box" @click.stop>
        <div class="dialog-header">
          <span>{{ dateDialogData.date }}</span>
          <button class="dialog-close" @click="dateDialogData = null">×</button>
        </div>
        <div class="dialog-body">
          <div v-for="(item, i) in dateDialogData.items" :key="item.id || i" class="dialog-item" @click="clickItem(item)">
            <i :class="store.icon(item.extension || item.type)"></i>
            <span>{{ item.label }}</span>
          </div>
          <div v-if="dateDialogData.items.length === 0" class="dialog-empty">{{ store.locales === 'zh' ? '暂无事件' : 'No events' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { usestore } from '@/store';

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
const attribute = ref("__default__");
const data = ref([]);
const currentYear = ref(new Date().getFullYear());
const currentMonth = ref(new Date().getMonth());
const monthCn = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
const currentMonthLabel = computed(() => `${currentYear.value} 年 ${monthCn[currentMonth.value]}`);
const depth = ref(Number(localStorage.getItem('calendar_depth') || '1'));
watch(depth, v => localStorage.setItem('calendar_depth', String(v)))

// 日期事件弹窗
const dateDialogData = ref(null)

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

// 导航（单月）
const prevPeriod = () => {
  currentMonth.value--;
  if (currentMonth.value < 0) { currentMonth.value = 11; currentYear.value--; }
};

const nextPeriod = () => {
  currentMonth.value++;
  if (currentMonth.value > 11) { currentMonth.value = 0; currentYear.value++; }
};

const goToday = () => {
  const t = new Date();
  currentYear.value = t.getFullYear();
  currentMonth.value = t.getMonth();
};

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

// 获取某天的事件列表
const getDayItems = (dateObj) => {
  return data.value.filter(item => {
    if (!item.date) return false;
    return isSameDay(item.date, dateObj);
  });
};

// 单月日历：生成 6 行×7 列（跨月日期灰显），保证各月行高一致
const calRows = computed(() => {
  const year = currentYear.value, month = currentMonth.value;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDow = new Date(year, month, 1).getDay();
  const rows = [];
  let cells = [];
  const push = (y, m, d, outside) => {
    cells.push({ year: y, month: m, day: d, outside, date: new Date(y, m, d) });
    if (cells.length === 7) { rows.push(cells); cells = []; }
  };
  // 月初前的星期空白（跨上月灰显）
  for (let i = firstDow - 1; i >= 0; i--) {
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
});

// 某天的事件列表 / 数量
const dayItemsOf = (dateObj) => getDayItems(dateObj);
const dayEventCount = (dateObj) => getDayItems(dateObj).length;
const monthFileCount = computed(() => data.value.filter(it => it.date && it.date.getFullYear() === currentYear.value && it.date.getMonth() === currentMonth.value).length);
const isTodayDate = (dateObj) => isToday(dateObj);

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
        if (key.toLowerCase().includes('time') || key.includes('时间')) {
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
  
  console.log('当前文件夹中的时间字段:', attributes.value);
  console.log('总文件数:', data.value.length);
};

// 初始化数据
const init = async function() {
  if (store.root != "") {
    try {
      data.value = await window.ipcRenderer.invoke("getFiles", store.root, depth.value);
    } catch (e) {
      console.warn('无法获取文件列表:', e);
      data.value = [];
    }
  }
  
  // 处理日期
  for (let i = 0; i < data.value.length; i++) {
    data.value[i].date = getFileDate(data.value[i]);
  }
  getAttributes();
};

// ============ 监听 ============
watch(() => store.root, () => {
  init();
});

watch(() => attribute.value, () => {
  for (let i = 0; i < data.value.length; i++) {
    data.value[i].date = getFileDate(data.value[i]);
  }
});

// ============ 生命周期 ============
onMounted(() => {
  init();
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
.cal-date-items {
  overflow-y: auto;
  overflow-x: hidden;
  height: calc(100% - 20px);
}
.cal-item {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 9px;
  color: var(--fontColor);
  padding: 0 2px;
  border-radius: 2px;
  cursor: pointer;
  white-space: nowrap;
}
.cal-item:hover {
  background: var(--menuActiveColor);
  color: var(--fontActiveColor);
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
  max-height: 70vh;
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