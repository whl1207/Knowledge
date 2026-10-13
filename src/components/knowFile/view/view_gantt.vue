<script setup lang="ts">
  import { usestore } from '@/store'
  import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
  import { ElMessageBox, ElMessage } from 'element-plus'
  import { stripMdSuffix, attrDateOf, collectTimeFields, resolveStartFieldOf, DEFAULT_TIME_FIELD, colorOfAttributes } from '@/lib/knowFile/itemMeta'
import { getPlatform, hasCapability } from '@/platform'
  
  const store = usestore()

  // 嵌入「日历」视图时：由父级提供视图切换器（月视图 / 周视图 / 甘特图），
  // 避免上下叠出两条状态栏；单独使用时（showViewSwitch=false）行为不变。
  const props = defineProps({
    showViewSwitch: { type: Boolean, default: false },
    viewMode: { type: String, default: 'gantt' }
  })
  const emit = defineEmits(['change-view'])
  const onViewSelect = (e: Event) => emit('change-view', (e.target as HTMLSelectElement).value)
  const contextMenu = ref(null) as any
  const showContextMenu = ref(false)
  const contextMenuPos = ref({ x: 0, y: 0 })
  const selectedTaskId = ref('')
  const timelineRef = ref<HTMLElement | null>(null)
  const deep = ref(1)
  
  // 可配置的开始/结束时间字段：与日历视图共用同一组偏好
  // （起始 calendar_time_field、结束 gantt_endField；旧键 gantt_startField 做一次迁移后不再使用）
  const START_FIELD_KEY = 'calendar_time_field'
  const END_FIELD_KEY = 'gantt_endField'
  const legacyStart = localStorage.getItem('gantt_startField')
  if (!localStorage.getItem(START_FIELD_KEY) && legacyStart) localStorage.setItem(START_FIELD_KEY, legacyStart)
  const startField = ref(localStorage.getItem(START_FIELD_KEY) || DEFAULT_TIME_FIELD)
  const endField = ref(localStorage.getItem(END_FIELD_KEY) || '结束时间')
  // 起止字段候选：只收时间类字段（与日历一致，不再把 状态 / 颜色 之类也列进来）
  const timeFields = ref<string[]>([])
  watch(startField, v => localStorage.setItem(START_FIELD_KEY, v))
  watch(endField, v => localStorage.setItem(END_FIELD_KEY, v))
  
  // 任务数据
  interface GanttTask {
    id: string
    text: string
    start_date: string
    end_date: string
    duration: number
    data: any
  }
  const tasks = ref<GanttTask[]>([])
  
  // 缩放级别配置
  const zoomLevels = ['day', 'week', 'month'] as const
  type ZoomLevel = typeof zoomLevels[number]
  const currentZoom = ref<ZoomLevel>('day')
  
  // 每列的像素宽度（按缩放级别）
  const columnWidth = computed(() => {
    switch (currentZoom.value) {
      case 'day': return 60
      case 'week': return 80
      case 'month': return 100
    }
  })
  
  const rowHeight = 32
  const taskNameWidth = 200

  /** 取当天 0 点：时间轴按「天」对齐（属性里可能带时分秒，YAML 还可能解析成 Date） */
  const dayFloor = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x }
  const daysBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 86400000

  // 日期范围 - 覆盖较宽的时间段（两端都对齐到 0 点，保证表头列与任务条同一套坐标）
  const dateRange = computed(() => {
    if (tasks.value.length === 0) {
      const now = dayFloor(new Date())
      const start = new Date(now)
      start.setFullYear(start.getFullYear() - 1)
      const end = new Date(now)
      end.setFullYear(end.getFullYear() + 1)
      return { start, end }
    }
    let minDate = Infinity, maxDate = -Infinity
    tasks.value.forEach(t => {
      const s = new Date(t.start_date).getTime()
      const e = new Date(t.end_date).getTime()
      if (s < minDate) minDate = s
      if (e > maxDate) maxDate = e
    })
    const start = dayFloor(new Date(minDate))
    start.setMonth(start.getMonth() - 6)
    const end = dayFloor(new Date(maxDate))
    end.setMonth(end.getMonth() + 7)
    return { start, end }
  })
  
  // 生成时间轴表头
  const timeHeaders = computed(() => {
    const headers: { label: string; colSpan: number }[] = []
    const cursor = new Date(dateRange.value.start)
    const end = new Date(dateRange.value.end)
    
    switch (currentZoom.value) {
      case 'day':
        while (cursor < end) {
          const day = cursor.getDate()
          const month = cursor.getMonth() + 1
          headers.push({ label: `${month}/${day}`, colSpan: 1 })
          cursor.setDate(cursor.getDate() + 1)
        }
        break
      case 'week': {
        // 第一行：月份
        // 第二行：周数
        let weekStart = new Date(cursor)
        while (weekStart < end) {
          const weekNum = getWeekNumber(weekStart)
          headers.push({ label: `W${weekNum}`, colSpan: 1 })
          weekStart.setDate(weekStart.getDate() + 7)
        }
        break
      }
      case 'month':
        while (cursor < end) {
          const month = cursor.getMonth() + 1
          const year = cursor.getFullYear()
          headers.push({ label: `${year}/${month}`, colSpan: 1 })
          cursor.setMonth(cursor.getMonth() + 1)
        }
        break
    }
    return headers
  })
  
  const totalTimelineWidth = computed(() => timeHeaders.value.length * columnWidth.value)
  
  function getWeekNumber(d: Date): number {
    const temp = new Date(d)
    temp.setHours(0, 0, 0, 0)
    temp.setDate(temp.getDate() + 3 - (temp.getDay() + 6) % 7)
    const week1 = new Date(temp.getFullYear(), 0, 4)
    return 1 + Math.round(((temp.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7)
  }
  
  // 任务条的 left (px)，根据缩放级别换算
  /**
   * 日期 → 时间轴像素位置（与表头列一一对应）。
   * 日/周按天数比例；月按**自然月**插值（不能按 30 天近似，否则一年会累计偏出好几列）。
   */
  function dateToPx(input: Date): number {
    const s = dateRange.value.start
    const d = dayFloor(input)
    let cols = 0
    if (currentZoom.value === 'day') {
      cols = daysBetween(s, d)
    } else if (currentZoom.value === 'week') {
      cols = daysBetween(s, d) / 7
    } else {
      const whole = (d.getFullYear() - s.getFullYear()) * 12 + (d.getMonth() - s.getMonth())
      const colStart = addMonths(s, whole)
      const colEnd = addMonths(s, whole + 1)
      const span = daysBetween(colStart, colEnd)
      cols = whole + (span > 0 ? daysBetween(colStart, d) / span : 0)
    }
    return cols * columnWidth.value
  }

  function barLeft(task: GanttTask): number {
    return dateToPx(new Date(task.start_date))
  }

  // 任务条的 width (px)：duration = 覆盖天数，右边界为「末日 + 1」
  function barWidth(task: GanttTask): number {
    const s = dayFloor(new Date(task.start_date))
    const e = new Date(s)
    e.setDate(e.getDate() + task.duration)
    return Math.max(dateToPx(e) - dateToPx(s), 10)
  }

  /** 今天在时间轴上的像素位置（红线） */
  const todayPx = computed(() => dateToPx(new Date()))

  /**
   * 任务条样式：位置 / 宽度 + 配色。
   * 有 `颜色` 属性时用该颜色作为边框与淡底（与日历条目条、看板卡片同一套色），
   * 没有则用主题强调色 —— 避免只用半透明底色导致任务条在浅/深主题下都看不清。
   */
  function barStyle(task: GanttTask) {
    const s: Record<string, string> = {
      left: barLeft(task) + 'px',
      width: barWidth(task) + 'px'
    }
    const c = colorOfAttributes(task.data && task.data.attributes)
    if (c) s['--bar-color'] = c
    return s
  }
  // 格式化日期
  function formatDate(dateStr: string): string {
    const d = new Date(dateStr)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  
  // 获取数据
  const init = async function () {
    const dir = store.dataDir
    if (dir === '') return
    try {
      const list = await getPlatform().fs.listTree(dir, deep.value)
      // 只排期 Markdown 文件：文件夹与其它格式（图片 / 表格 / 代码等）不参与甘特
      const files = (list || []).filter((f: any) => f.type === 'file' && String(f.extension || '').toLowerCase() === '.md')
      // 起止字段候选：只收时间类字段（与日历视图一致）
      timeFields.value = collectTimeFields(files)

      tasks.value = files.map((f: any) => {
        const attrs = f.attributes || {}
        // 起始字段：显式指定 > 自动（开始时间 / 首个时间类字段），与日历同一套解析
        const sf = resolveStartFieldOf(f, startField.value)
        const ef = endField.value
        const sDate = attrDateOf(f, sf)
        const eDate = ef ? attrDateOf(f, ef) : null
        // 天数按「含首尾」计：9/30 ~ 10/02 = 3 天（先对齐到当天 0 点再算间隔，避开时分秒与夏令时误差）
        let duration = 1
        if (sDate && eDate && eDate >= sDate) {
          duration = Math.max(Math.round(daysBetween(dayFloor(sDate), dayFloor(eDate))) + 1, 1)
        }
        // 没有可用的起始日期：放到今天（保持原有兜底行为）
        const start_date = sDate ? store.StampToDate(sDate) : store.StampToDate(new Date())
        // end_date 为**含**末日的日期（显示 / 默认值用）；任务条宽度另按 duration 天算
        const endDate = new Date(start_date)
        endDate.setDate(endDate.getDate() + duration - 1)
        return {
          id: f.path,
          text: stripMdSuffix(f.label),
          start_date,
          end_date: store.StampToDate(endDate),
          duration,
          data: f
        }
      })
      // 按开始时间排序
      tasks.value.sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
      await nextTick()
      focusToday()
    } catch (e) {
      console.error(e)
    }
  }
  
  // 聚焦到今天
  const focusToday = function () {
    if (!timelineRef.value) return
    const today = new Date()
    scrollToDate(today)
  }
  
  // 滚动到指定任务的开始时间
  const scrollToTask = function (task: GanttTask) {
    scrollToDate(new Date(task.start_date))
  }
  
  // 滚动时间轴到指定日期
  const scrollToDate = function (date: Date) {
    if (!timelineRef.value) return
    timelineRef.value.scrollLeft = Math.max(0, dateToPx(date) - 200)
  }
  
  // 右键菜单中设置开始/结束时间
  const setDateForSelected = async function (isStart: boolean) {
    const task = tasks.value.find(t => t.id === selectedTaskId.value)
    if (!task) return
    // 起始字段可能选了「默认」——按该文件实际使用的时间字段写入
    const field = isStart ? resolveStartFieldOf(task.data, startField.value) : endField.value
    const label = store.locales === 'zh' ? (isStart ? '开始时间' : '结束时间') : (isStart ? 'Start Time' : 'End Time')
    const defaultValue = isStart ? task.start_date.substring(0, 10) : task.end_date.substring(0, 10)
    await doSetDate(task, field, label, defaultValue)
  }
  
  const doSetDate = async function (task: GanttTask, field: string, label: string, defaultValue: string) {
    try {
      const { value: dateStr } = await ElMessageBox.prompt(
        store.locales === 'zh' ? `请输入${label} (YYYY-MM-DD)：` : `Enter ${label} (YYYY-MM-DD):`,
        label,
        {
          inputValue: defaultValue,
          inputPattern: /^\d{4}-\d{2}-\d{2}$/,
          inputErrorMessage: store.locales === 'zh' ? '日期格式错误，请输入 YYYY-MM-DD' : 'Invalid date format, please enter YYYY-MM-DD',
          confirmButtonText: store.locales === 'zh' ? '确定' : 'OK',
          cancelButtonText: store.locales === 'zh' ? '跳过' : 'Skip',
        }
      )
      if (!dateStr) return
      
      const filePath = task.data.path
      if (!filePath) return
      
      // 读取当前元数据
      let metadata: Record<string, any> = {}
      try {
        metadata = (await getPlatform().fs.readMetadata(filePath)) || {}
      } catch (e) {}
      
      // 更新字段并保存
      metadata[field] = dateStr
      await getPlatform().fs.saveMetadata(filePath, metadata)
      ElMessage.success(`${label}: ${dateStr}`)
      await init()
    } catch {
      // 用户跳过
    }
  }
  
  // 向左/向右翻页
  const scrollTimeline = function (dir: 'left' | 'right') {
    if (!timelineRef.value) return
    const amount = timelineRef.value.clientWidth * 0.8
    timelineRef.value.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' })
  }
  
  // 缩放
  const scale = function (dir: 'in' | 'out') {
    const idx = zoomLevels.indexOf(currentZoom.value)
    if (dir === 'in' && idx < zoomLevels.length - 1) currentZoom.value = zoomLevels[idx + 1]
    if (dir === 'out' && idx > 0) currentZoom.value = zoomLevels[idx - 1]
    nextTick(() => focusToday())
  }
  
  // 右键菜单
  const showEditorContextMenu = function (e: MouseEvent, taskId?: string) {
    e.preventDefault()
    e.stopPropagation()
    if (taskId) selectedTaskId.value = taskId
    // 根据点击位置判断菜单向上还是向下显示
    const menuHeight = 320 // 估算菜单高度
    const spaceBelow = window.innerHeight - e.clientY
    contextMenuPos.value = {
      x: e.clientX,
      y: spaceBelow > menuHeight ? e.clientY : e.clientY - menuHeight
    }
    showContextMenu.value = true
  }
  const showBgContextMenu = function (e: MouseEvent) {
    selectedTaskId.value = ''
    showEditorContextMenu(e)
  }
  const hideContextMenu = () => { showContextMenu.value = false }
  
  const getSelectedTask = () => tasks.value.find(t => t.id === selectedTaskId.value)
  
  // 二级菜单自适应方向，避免超出屏幕
  const adjustSubmenu = function (e: MouseEvent) {
    const target = e.currentTarget as HTMLElement
    const sub = target.querySelector('.submenu') as HTMLElement
    if (!sub) return
    const subHeight = sub.scrollHeight
    const rect = target.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    if (spaceBelow < subHeight) {
      sub.style.top = Math.max(-(subHeight - rect.height), -(subHeight - 20)) + 'px'
    } else {
      sub.style.top = '-4px'
    }
  }
  
  // Ctrl+S 刷新
  async function handleKeydown(e: KeyboardEvent) {
    if (e.keyCode === 83 && (navigator.platform.match('Mac') ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      await init()
    }
  }
  
  watch([() => store.root, () => store.path], () => init())
  
  onMounted(() => {
    init()
    window.addEventListener('keydown', handleKeydown)
    document.addEventListener('click', hideContextMenu)
  })
  
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('click', hideContextMenu)
  })
</script>

<template>
  <div class="bg" @contextmenu="showBgContextMenu">
    <!-- 甘特图主体 -->
    <div class="gantt-body" v-if="tasks.length > 0">
      <!-- 左侧任务名称 -->
      <div class="task-names" :style="{ width: taskNameWidth + 'px' }">
        <div class="task-name-header">{{ store.locales === 'zh' ? '任务' : 'Task' }}</div>
        <div class="task-name-list scoll">
          <div v-for="task in tasks" :key="task.id" class="task-name-row" :style="{ height: rowHeight + 'px' }"
               @contextmenu="showEditorContextMenu($event, task.id)"
               @click="scrollToTask(task)"
               @dblclick="store.openFileByMode(task.data)">
            <span class="task-name-text" :title="task.text">{{ task.text }}</span>
            <span class="task-date">{{ formatDate(task.start_date) }}</span>
          </div>
        </div>
      </div>

      <!-- 右侧时间轴 -->
      <div class="timeline-wrap scoll" ref="timelineRef">
        <!-- 表头 -->
        <div class="timeline-header" :style="{ width: totalTimelineWidth + 'px' }">
          <div v-for="(h, i) in timeHeaders" :key="i" class="header-cell" :style="{ width: columnWidth + 'px' }">
            {{ h.label }}
          </div>
        </div>
        <!-- 任务条区域 -->
        <div class="timeline-body" :style="{ width: totalTimelineWidth + 'px' }">
          <!-- 今日标记线 -->
          <div class="today-marker" :style="{ left: todayPx + 'px' }"></div>
          <!-- 网格线和任务条 -->
          <div v-for="(task, ti) in tasks" :key="task.id" class="bar-row" :style="{ height: rowHeight + 'px' }"
               @contextmenu="showEditorContextMenu($event, task.id)"
               @dblclick="store.openFileByMode(task.data)">
            <div class="bar" :style="barStyle(task)">
              <span class="bar-text">{{ task.text }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <i class="fa fa-tasks"></i>
      <p>{{ store.locales === 'zh' ? '暂无任务数据' : 'No task data' }}</p>
    </div>

    <!-- 底部状态栏：视图(月/周/甘特，嵌入日历视图时) / 缩放 / 层级 / 刷新 / 时间字段 / 计数 -->
    <div class="gantt-statusbar">
      <span v-if="store.folderName" class="statusbar-item status-folder" :title="store.dataDir" style="max-width:220px"><i class="fa fa-folder-open-o"></i><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ store.folderName }}</span></span>
      <span v-if="store.folderName" class="statusbar-sep"></span>
      <template v-if="props.showViewSwitch">
        <span class="statusbar-item"><i class="fa fa-calendar-o"></i> {{ store.locales === 'zh' ? '视图' : 'View' }}</span>
        <select class="statusbar-select" :value="props.viewMode" @change="onViewSelect" :title="store.locales === 'zh' ? '月视图 / 周视图 / 年视图 / 甘特图' : 'Month / Week / Year / Gantt'">
          <option value="month">{{ store.locales === 'zh' ? '月视图' : 'Month' }}</option>
          <option value="week">{{ store.locales === 'zh' ? '周视图' : 'Week' }}</option>
          <option value="year">{{ store.locales === 'zh' ? '年视图' : 'Year' }}</option>
          <option value="gantt">{{ store.locales === 'zh' ? '甘特图' : 'Gantt' }}</option>
        </select>
        <span class="statusbar-sep"></span>
      </template>
      <span class="statusbar-item"><i class="fa fa-search-plus"></i> {{ store.locales === 'zh' ? '缩放' : 'Zoom' }}</span>
      <select class="statusbar-select" v-model="currentZoom" @change="nextTick(() => focusToday())" :title="store.locales === 'zh' ? '时间粒度' : 'Time granularity'">
        <option value="day">{{ store.locales === 'zh' ? '日' : 'Day' }}</option>
        <option value="week">{{ store.locales === 'zh' ? '周' : 'Week' }}</option>
        <option value="month">{{ store.locales === 'zh' ? '月' : 'Month' }}</option>
      </select>
      <span class="statusbar-sep"></span>
      <span class="statusbar-item"><i class="fa fa-sitemap"></i> {{ store.locales === 'zh' ? '层级' : 'Level' }}</span>
      <select class="statusbar-select" v-model.number="deep" @change="init()" :title="store.locales === 'zh' ? '扫描层级' : 'Scan level'">
        <option v-for="l in [1,2,3,4,5]" :key="l" :value="l">L{{ l }}</option>
      </select>
      <button class="statusbar-btn" @click="init()" :title="store.locales === 'zh' ? '刷新' : 'Refresh'"><i class="fa fa-refresh"></i></button>
      <button class="statusbar-btn" @click="focusToday()" :title="store.locales === 'zh' ? '跳转到今天' : 'Focus Today'"><i class="fa fa-flag-o"></i></button>
      <template v-if="timeFields.length">
        <span class="statusbar-sep"></span>
        <span class="statusbar-item"><i class="fa fa-clock-o"></i> {{ store.locales === 'zh' ? '开始' : 'Start' }}</span>
        <select class="statusbar-select" v-model="startField" @change="init()" :title="store.locales === 'zh' ? '起始时间字段（与日历视图共用）' : 'Start field (shared with the Calendar view)'">
          <option :value="DEFAULT_TIME_FIELD">{{ store.locales === 'zh' ? '默认' : 'Default' }}</option>
          <option v-if="startField !== DEFAULT_TIME_FIELD && !timeFields.includes(startField)" :value="startField">{{ startField }}</option>
          <option v-for="attr in timeFields" :key="attr" :value="attr">{{ attr }}</option>
        </select>
        <span class="statusbar-item"><i class="fa fa-clock-o"></i> {{ store.locales === 'zh' ? '结束' : 'End' }}</span>
        <select class="statusbar-select" v-model="endField" @change="init()" :title="store.locales === 'zh' ? '结束时间字段（与日历视图共用）' : 'End field (shared with the Calendar view)'">
          <option v-if="!timeFields.includes(endField)" :value="endField">{{ endField }}</option>
          <option v-for="attr in timeFields" :key="attr" :value="attr">{{ attr }}</option>
        </select>
      </template>
      <span class="statusbar-spacer"></span>
      <span class="statusbar-item"><i class="fa fa-tasks"></i> {{ tasks.length }} {{ store.locales === 'zh' ? '任务' : 'tasks' }}</span>
    </div>

    <!-- 右键菜单 -->
    <div v-if="showContextMenu" class="context-menu"
         :style="{ left: contextMenuPos.x + 'px', top: contextMenuPos.y + 'px' }"
         @mouseleave="hideContextMenu" @click.stop>

      <div class="menu-divider"></div>
      <div class="menu-item has-submenu" @mouseenter="adjustSubmenu">
        <i class="fa fa-search-plus"></i>
        <span style="flex:1">{{ store.locales === 'zh' ? '缩放' : 'Zoom' }}</span>
        <span style="font-size:11px;color:var(--borderColor)">{{ store.locales === 'zh' ? (currentZoom==='day'?'日':currentZoom==='week'?'周':'月') : currentZoom }}</span>
        <ul class="submenu">
          <li @click="currentZoom='day'; nextTick(() => focusToday()); hideContextMenu()"><i class="fa fa-circle-o"></i> {{ store.locales === 'zh' ? '日' : 'Day' }}</li>
          <li @click="currentZoom='week'; nextTick(() => focusToday()); hideContextMenu()"><i class="fa fa-circle-o"></i> {{ store.locales === 'zh' ? '周' : 'Week' }}</li>
          <li @click="currentZoom='month'; nextTick(() => focusToday()); hideContextMenu()"><i class="fa fa-circle-o"></i> {{ store.locales === 'zh' ? '月' : 'Month' }}</li>
        </ul>
      </div>
      <div class="menu-item" @click="init(); hideContextMenu()"><i class="fa fa-refresh"></i> {{ store.locales === 'zh' ? '刷新' : 'Refresh' }}</div>
      <div class="menu-item" @click="focusToday(); hideContextMenu()"><i class="fa fa-flag-o"></i> {{ store.locales === 'zh' ? '跳转到今天' : 'Focus Today' }}</div>
      <div class="menu-divider" v-if="selectedTaskId && getSelectedTask()?.data?.path?.endsWith('.md')"></div>
      <div class="menu-item" v-if="selectedTaskId && getSelectedTask()?.data?.path?.endsWith('.md')" @click="setDateForSelected(true); hideContextMenu()"><i class="fa fa-clock-o"></i> {{ store.locales === 'zh' ? '设置开始时间' : 'Set Start Time' }}</div>
      <div class="menu-item" v-if="selectedTaskId && getSelectedTask()?.data?.path?.endsWith('.md')" @click="setDateForSelected(false); hideContextMenu()"><i class="fa fa-clock-o"></i> {{ store.locales === 'zh' ? '设置结束时间' : 'Set End Time' }}</div>
      <div class="menu-item has-submenu" @mouseenter="adjustSubmenu">
        <i class="fa fa-sitemap"></i>
        <span style="flex:1">{{ store.locales === 'zh' ? '扫描层级' : 'Scan Level' }}</span>
        <span style="font-size:11px;color:var(--borderColor)">L{{ deep }}</span>
        <ul class="submenu">
          <li v-for="l in [1,2,3,4,5]" :key="l" @click="deep=l; init(); hideContextMenu()"><i class="fa fa-circle-o"></i> L{{ l }}</li>
        </ul>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item has-submenu" v-if="timeFields.length>0" @mouseenter="adjustSubmenu">
        <i class="fa fa-clock-o"></i>
        <span style="flex:1">{{ store.locales === 'zh' ? '起始时间字段' : 'Start Field' }}</span>
        <span style="font-size:11px;color:var(--borderColor)">{{ startField === DEFAULT_TIME_FIELD ? (store.locales === 'zh' ? '默认' : 'Default') : startField }}</span>
        <ul class="submenu">
          <li @click="startField=DEFAULT_TIME_FIELD; init(); hideContextMenu()">
            <i class="fa fa-dot-circle-o" v-if="startField===DEFAULT_TIME_FIELD"></i>
            <i class="fa fa-circle-o" v-else></i>
            {{ store.locales === 'zh' ? '默认（按文件自动）' : 'Default (per file)' }}
          </li>
          <li v-for="attr in timeFields" :key="attr" @click="startField=attr; init(); hideContextMenu()">
            <i class="fa fa-dot-circle-o" v-if="startField===attr"></i>
            <i class="fa fa-circle-o" v-else></i>
            {{ attr }}
          </li>
        </ul>
      </div>
      <div class="menu-item has-submenu" v-if="timeFields.length>0" @mouseenter="adjustSubmenu">
        <i class="fa fa-clock-o"></i>
        <span style="flex:1">{{ store.locales === 'zh' ? '结束时间字段' : 'End Field' }}</span>
        <span style="font-size:11px;color:var(--borderColor)">{{ endField }}</span>
        <ul class="submenu">
          <li v-for="attr in timeFields" :key="attr" @click="endField=attr; init(); hideContextMenu()">
            <i class="fa fa-dot-circle-o" v-if="endField===attr"></i>
            <i class="fa fa-circle-o" v-else></i>
            {{ attr }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bg {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  overflow: hidden;
  border-right: 1px solid var(--borderColor);
}

/* 甘特图主体 */
.gantt-body {
  flex: 1;
  display: flex;
  min-height: 0;
  height: auto;
  overflow: hidden;
}

/* 左侧任务名称 */
.task-names {
  flex-shrink: 0;
  border-right: 1px solid var(--borderColor);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.task-name-header {
  height: 30px;
  line-height: 30px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--fontColor);
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}
.task-name-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.task-name-row {
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-bottom: 1px solid var(--borderColor);
  cursor: pointer;
  gap: 4px;
  transition: background 0.1s;
}
.task-name-row:hover { background: var(--menuActiveColor); }
.task-name-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fontColor);
}
.task-date {
  font-size: 11px;
  color: var(--borderColor);
  white-space: nowrap;
}

/* 右侧时间轴 */
.timeline-wrap {
  flex: 1;
  min-width: 0;
  overflow: auto;
  position: relative;
}
.timeline-header {
  display: flex;
  height: 30px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  position: sticky;
  top: 0;
  z-index: 2;
}
.header-cell {
  flex-shrink: 0;
  box-sizing: border-box;
  font-size: 11px;
  color: var(--fontColor);
  text-align: center;
  line-height: 30px;
  border-right: 1px solid var(--borderColor);
  white-space: nowrap;
  overflow: hidden;
}
.timeline-body {
  position: relative;
}
.bar-row {
  position: relative;
  border-bottom: 1px solid var(--borderColor);
}
.bar-row:hover { background: rgba(128,128,128,0.03); }

/* 任务条 */
.bar {
  position: absolute;
  top: 4px;
  height: 24px;
  border-radius: 4px;
  /* 边框用条目颜色（无 `颜色` 属性时用主题强调色），底色取同色淡底：浅色/深色主题下都能看清 */
  border: 1px solid var(--bar-color, var(--fontActiveColor));
  background: color-mix(in srgb, var(--bar-color, var(--fontActiveColor)) 18%, var(--backgroundColor));
  color: var(--fontColor);
  display: flex;
  align-items: center;
  padding: 0 6px;
  box-sizing: border-box;
  cursor: pointer;
  transition: background-color 0.15s, box-shadow 0.15s;
  overflow: hidden;
}
.bar:hover {
  background: color-mix(in srgb, var(--bar-color, var(--fontActiveColor)) 34%, var(--backgroundColor));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
}
.bar-text {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 今日标记线 */
.today-marker {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #e74c3c;
  z-index: 1;
  pointer-events: none;
}

/* 空状态 */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--borderColor);
  gap: 8px;
}
.empty-state i { font-size: 40px; }
.empty-state p { font-size: 14px; margin: 0; }

/* ===== 底部状态栏（与代码编辑/阅读视图一致观感） ===== */
.gantt-statusbar {
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
.gantt-statusbar .statusbar-item { display: inline-flex; align-items: center; gap: 4px; opacity: 0.85; }
.gantt-statusbar .statusbar-item i { font-size: 11px; opacity: 0.7; }
.gantt-statusbar .statusbar-spacer { flex: 1; }
.gantt-statusbar .statusbar-btn {
  margin: 0; padding: 0 6px; height: 18px; border: none; border-radius: 3px; background: transparent;
  color: var(--fontColor); font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0.85; transition: background-color 0.15s; flex-shrink: 0;
}
.gantt-statusbar .statusbar-btn:hover { background: var(--menuActiveColor); opacity: 1; }
.gantt-statusbar .statusbar-sep { width: 1px; height: 14px; background: var(--borderColor); flex-shrink: 0; }
.gantt-statusbar .statusbar-select {
  height: 18px; border: 1px solid var(--borderColor); border-radius: 3px;
  background: var(--backgroundColor); color: var(--fontColor); font-size: 11px; padding: 0 4px;
  width: auto; min-width: 40px; max-width: 110px; outline: none; cursor: pointer; flex-shrink: 0;
}
.gantt-statusbar .statusbar-select option {
  background: var(--backgroundColor); color: var(--fontColor);
}
</style>