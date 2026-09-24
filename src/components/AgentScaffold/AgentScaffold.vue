<!-- AgentScaffold.vue - 脚手架实例框架（实例切换在面板内的实例导航栏；App.vue 标题栏只显示模块名） -->
<template>
  <div class="agent-scaffold">
    <!-- 实例导航栏：每个实例关联一个任务文件（tooltip 显示文件位置/大小/修改时间） -->
    <div v-if="showTabBar" class="instance-bar">
      <!-- 最左：实例操作按钮（打开 / 新建 / 开始 / 暂停 / 保存）——不再用メニューパネル；
           开始 / 暂停 按「当前实例」的任务状态显示：有待处理行才显示开始，运行中只显示暂停 -->
      <div class="bar-btn" :title="openFileHint" @click="openFromFile"><i class="fa fa-folder-open-o"></i></div>
      <div class="bar-btn" :class="{ disabled: !hasAddable }" :title="newInstanceHint" @click="newInstance"><i class="fa fa-plus"></i></div>
      <div v-if="showStartBtn" class="bar-btn" :title="startHint" @click="startFromBar($event)"><i class="fa fa-play"></i></div>
      <div v-if="showStopBtn" class="bar-btn" :title="stopHint" @click="stopFromBar($event)"><i class="fa fa-pause"></i></div>
      <div class="bar-btn" :title="saveHint" @click="saveFromBar($event)"><i class="fa fa-save"></i></div>
      <div class="bar-sep"></div>

      <!-- 实例标签：单击切换、双击/右键重命名、× 关闭（任务文件保留） -->
      <div
        v-for="inst in instances"
        :key="inst.id"
        class="instance-tab"
        :class="{ active: inst.id === activeId, busy: isInstanceRunning(inst.id), missing: inst.fileMissing }"
        :title="tabTitle(inst)"
        @click="selectInstance(inst.id)"
        @dblclick.stop="renameInstance(inst)"
        @contextmenu.prevent.stop="openInstanceMenu(inst, $event)"
      >
        <i :class="iconOf(inst.type)"></i>
        <span class="tab-title">{{ displayTitle(inst) }}</span>
        <i v-if="inst.fileMissing" class="fa fa-exclamation-triangle tab-warn" :title="missingHint"></i>
        <i class="fa fa-times tab-close" :title="closeHint" @click.stop="closeInstance(inst)"></i>
      </div>

      <!-- 实例右键菜单（重命名 / 关闭） -->
      <Teleport to="body">
        <div
          v-if="instanceMenu"
          class="instance-ctx-menu"
          :style="{ left: instanceMenu.x + 'px', top: instanceMenu.y + 'px' }"
          @click.stop
        >
          <div class="add-menu-item" @click="renameFromMenu">
            <i class="fa fa-i-cursor"></i>
            <span class="add-menu-label">{{ isEn ? 'Rename instance' : '重命名实例' }}</span>
          </div>
          <div class="add-menu-item" @click="closeFromMenu">
            <i class="fa fa-times"></i>
            <span class="add-menu-label">{{ isEn ? 'Close instance' : '关闭实例' }}</span>
          </div>
        </div>
      </Teleport>
    </div>

    <div class="agent-scaffold-body">
      <!-- 当前实例内容（标签页由各脚手架内部渲染；按实例 id 缓存，切走后台继续运行） -->
      <div class="main-content">
        <KeepAlive v-if="activeInstance" :max="keepAliveMax">
          <component
            :is="currentScaffold"
            :key="activeId"
            ref="scaffoldRef"
            :instance-id="activeId"
            :task-file-path="activeFilePath"
            @link-file="onLinkFile"
            @file-missing="onFileMissing"
            @file-saved="onSaved"
          />
        </KeepAlive>
        <!-- 无实例引导页：一句话说明 + 两个入口（类型快捷入口与底部提示已移除） -->
        <div v-else class="cli-empty">
          <i class="fa fa-cubes cli-empty-icon"></i>
          <div class="cli-empty-title">{{ isEn ? 'No task instance' : '暂无任务实例' }}</div>
          <div class="cli-empty-hint">
            {{ isEn
              ? 'One instance = one task: create one below (no file is created yet — the first Save asks where to put its .task), or open an existing .task file to continue.'
              : '一个实例 = 一个任务：新建一个任务实例（不预建文件，首次「保存」时再选 .task 位置），或打开已有的任务文件继续。' }}
          </div>
          <div class="cli-empty-actions">
            <div class="cli-empty-btn primary" :class="{ disabled: !recommendedType }"
                 :title="recommendedType ? (isEn ? 'Create a new ' + recommendedType.label + ' instance (recommended)' : '新建「' + recommendedType.label + '」实例（推荐）') : newInstanceHint"
                 @click="recommendedType && createInstance(recommendedType.key)">
              <i class="fa fa-plus"></i> {{ isEn ? 'New task' : '新建任务' }}
            </div>
            <div class="cli-empty-btn" :title="openFileHint" @click="openFromFile">
              <i class="fa fa-folder-open-o"></i> {{ isEn ? 'Open task' : '打开任务' }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'Harness' })
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore, SCAFFOLDS, type ScaffoldInstanceMeta } from '@/store'
import { isInstanceRunning, reportInstanceRunning, runningTaskList, instanceTaskState } from '@/store/runningTasks'
import PipelineScaffold from '@/components/AgentScaffold/PipelineScaffold.vue'

const store = usestore()
const isEn = computed(() => store.locales === 'en')

// ==================== 实例 ====================
const instances = computed(() => store.visibleInstances())
const activeId = computed(() => store.activeInstanceId)
const activeInstance = computed(() => store.activeInstance())
const activeFilePath = computed(() => activeInstance.value?.filePath || '')

/** 当前实例对应的脚手架组件（未知类型回退到 Agent脚手架，避免空白面板） */
const COMPONENTS: Record<string, any> = {
  // 2026-09-21 收尾：Agent脚手架模块只剩「Agent脚手架」一个脚手架（原四种已收敛为其预设）
  pipeline: PipelineScaffold,
}
const currentScaffold = computed(() => COMPONENTS[activeInstance.value?.type || ''] || PipelineScaffold)

// 实例数上限（KeepAlive 缓存上限须 >= 上限，否则 LRU 会卸载实例导致切回状态丢失）
const MAX_INSTANCES_TOTAL = 12
const keepAliveMax = MAX_INSTANCES_TOTAL

/**
 * 导航栏显示条件：
 * - 没有任何实例时不显示（那 5 个按钮没作用，且引导页已有「新建任务 / 打开任务」）；
 * - 其余情况：多于一个实例（要切标签），或还能新建实例。
 */
const showTabBar = computed(() => instances.value.length > 0 && (instances.value.length > 1 || addableTypes.value.some(d => !d.disabled)))

/** 新建菜单里的类型列表（已启用的脚手架 + 剩余名额） */
const addableTypes = computed(() => SCAFFOLDS.filter(s => store.isScaffoldEnabled(s.key)).map(s => {
  const count = store.instancesOfType(s.key).length
  const reachTotal = store.scaffoldInstances.length >= MAX_INSTANCES_TOTAL
  const disabled = count >= s.maxInstances || reachTotal
  return {
    key: s.key,
    icon: s.icon,
    label: isEn.value ? s.labelEn : s.labelZh,
    count,
    max: s.maxInstances,
    disabled,
    hint: disabled
      ? (reachTotal
        ? (isEn.value ? `Instance limit reached (${MAX_INSTANCES_TOTAL}) — close one first` : `实例总数已达上限（${MAX_INSTANCES_TOTAL} 个），请先关闭其他实例`)
        : (isEn.value ? `This type allows at most ${s.maxInstances} instances` : `该类型最多 ${s.maxInstances} 个实例`))
      : (isEn.value ? `New ${s.labelEn} instance (each instance has its own task file)` : `新建「${s.labelZh}」实例（每个实例关联独立任务文件）`),
  }
}))

// ==================== 实例句柄（关闭时调 dispose 停止后台任务） ====================
const scaffoldRef = ref<any>(null)
const handles = new Map<string, any>()
// flush:'sync' 时回调在渲染前触发，scaffoldRef 仍指向旧实例 → 正好把切走实例的句柄存下来
watch(() => store.activeInstanceId, (_next, prev) => {
  if (prev && scaffoldRef.value) handles.set(prev, scaffoldRef.value)
}, { flush: 'sync' })
const handleOf = (id: string) => (id === store.activeInstanceId ? scaffoldRef.value : handles.get(id))
/** 安全调用脚手架暴露的只读状态函数（未实现时返回空串） */
const safeCall = (fn?: () => string): string => {
  if (typeof fn !== 'function') return ''
  try { return String(fn() || '') } catch { return '' }
}

// 运行中每秒刷新一次 tooltip（预计剩余时间随执行递减）
const etaTick = ref(0)
let etaTimer: ReturnType<typeof setInterval> | null = null
watch(() => runningTaskList.value.length, (n) => {
  if (n > 0 && !etaTimer) etaTimer = setInterval(() => { etaTick.value++ }, 1000)
  else if (n === 0 && etaTimer) { clearInterval(etaTimer); etaTimer = null }
}, { immediate: true })

// ==================== 文件状态（L0：只 stat，不读内容） ====================
const fileStat = ref<Record<string, { exists: boolean; size?: number; mtime?: number }>>({})
async function refreshFileStats() {
  const paths = instances.value.map(i => i.filePath).filter(Boolean)
  if (!paths.length || !window.ipcRenderer) return
  try {
    const list = await window.ipcRenderer.invoke('statTaskFiles', paths)
    const map: Record<string, { exists: boolean; size?: number; mtime?: number }> = {}
    for (const it of list || []) map[it.path] = it
    fileStat.value = map
  } catch { /* 桌面版不可用时忽略 */ }
}
watch(() => instances.value.map(i => i.filePath).join('|'), () => { void refreshFileStats() })

const fmtSize = (n?: number) => {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
const fmtTime = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '')

/** 自动生成的实例名（Agent脚手架 1 / Agent Scaffold 1，含更早的「通用流水线 N」「Pipeline N」） */
const AUTO_INST_TITLE = /^(Agent脚手架|Agent Scaffold|通用流水线|Pipeline)\s*(\d+)$/
/**
 * 实例显示名：自动生成的实例名按当前界面语言显示（手动改过名的原样）——
 * 存量实例的标题存的是「Agent脚手架 1」，英文界面下就不再显示中文
 */
const displayTitle = (inst: ScaffoldInstanceMeta): string => {
  const raw = String(inst.title || '')
  if (inst.titleManual) return raw || inst.type
  const m = AUTO_INST_TITLE.exec(raw.trim())
  return m ? `${isEn.value ? 'Agent Scaffold' : 'Agent脚手架'} ${m[2]}` : (raw || inst.type)
}

/** 标签 tooltip：关联文件位置（用户显式需求）+ 大小/修改时间 + 运行状态 + 预计剩余时间 */
const tabTitle = (inst: ScaffoldInstanceMeta): string => {
  // 建立渲染依赖：运行中每秒 tick 一次，悬停时能看到不断更新的预计剩余时间
  void etaTick.value
  const st = fileStat.value[inst.filePath]
  const lines: string[] = []
  lines.push(isEn.value ? `Instance: ${displayTitle(inst)}` : `实例：${displayTitle(inst)}`)
  lines.push(inst.filePath
    ? `${isEn.value ? 'Task file' : '任务文件'}：${inst.filePath}`
    : (isEn.value ? 'Task file: not linked yet — chosen on the first Save' : '任务文件：尚未关联（首次「保存」时选择位置）'))
  if (inst.filePath && st) {
    if (st.exists === false) lines.push(isEn.value ? '⚠ File not found (moved or deleted)' : '⚠ 文件不存在（已被移动或删除）')
    else lines.push(`${fmtSize(st.size)} · ${fmtTime(st.mtime)}`)
  }
  const running = isInstanceRunning(inst.id)
  lines.push(running
    ? (isEn.value ? 'Status: running in background' : '状态：后台运行中')
    : (isEn.value ? 'Status: idle' : '状态：空闲'))
  if (running) {
    const h = handleOf(inst.id)
    const prog = safeCall(h?.progress)
    const eta = safeCall(h?.eta)
    if (prog) lines.push(`${isEn.value ? 'Progress' : '进度'}：${prog}`)
    lines.push(eta
      ? `${isEn.value ? 'Estimated time left' : '预计剩余'}：${eta}`
      : (isEn.value ? 'Estimated time left: estimating...' : '预计剩余：正在估算...'))
  }
  lines.push(isEn.value
    ? 'Click to switch · Double-click or right-click to rename · × to close'
    : '单击切换 · 双击或右键重命名 · × 关闭')
  return lines.join('\n')
}
const closeHint = computed(() => isEn.value ? 'Close instance (task file is kept)' : '关闭实例（任务文件保留）')
const missingHint = computed(() => isEn.value ? 'Task file not found' : '关联的任务文件不存在')
const openFileHint = computed(() => isEn.value ? 'Pick a .task file and open it in a new instance' : '选择 .task 文件，在新实例中打开')
const newInstanceHint = computed(() => hasAddable.value
  ? (isEn.value ? 'Create a new task instance (its .task file location is chosen on the first save)' : '新建任务实例（不再预建文件，首次「保存」时再选择 .task 保存位置）')
  : (isEn.value ? 'Instance limit reached' : '实例数已达上限'))
const startHint = computed(() => (isEn.value
  ? 'Run / resume the CURRENT task (the active tab)'
  : '运行 / 继续「当前任务」（活动标签）') + allHintSuffix('对所有已打开实例执行', 'apply to every opened instance'))
const stopHint = computed(() => (isEn.value
  ? 'Pause the CURRENT task (state is kept, resume later)'
  : '暂停「当前任务」（状态保留，可稍后续跑）') + allHintSuffix('暂停所有运行中的实例', 'pause every running instance'))

// 「开始」「暂停」按当前实例的任务状态显示（脚手架常驻上报，见 store/runningTasks）：
// - 运行中 → 只显示「暂停」；
// - 空闲且有待处理行 → 只显示「开始」；
// - 空闲且没有待处理行（未导入表格 / 已全部跑完）→ 两个都不显示；
// - 状态未知（刚新建、脚手架还没上报）→ 保留「开始」，避免按钮一闪一闪。
const activeRunning = computed(() => isInstanceRunning(activeId.value))
const activeState = computed(() => instanceTaskState(activeId.value))
const showStartBtn = computed(() => !activeRunning.value && (activeState.value ? activeState.value.canStart : true))
const showStopBtn = computed(() => activeRunning.value)
const saveHint = computed(() => (isEn.value
  ? 'Save the CURRENT task to its .task file — a running one saves the current snapshot; if no file is linked yet it asks where to put it'
  : '把「当前任务」保存到它的 .task 文件（运行中的保存当前快照；尚未关联文件的会先让你选择保存位置）') + allHintSuffix('保存全部已打开实例', 'save every opened instance'))

// ==================== 实例操作 ====================
/** 是否还有可新建的类型（用于「新建」按钮置灰） */
const hasAddable = computed(() => addableTypes.value.some(d => !d.disabled))/** 无实例引导页与「新建」按钮的推荐类型：优先 Agent脚手架（唯一脚手架），否则第一个可新建类型 */
const recommendedType = computed(() => addableTypes.value.find(d => d.key === 'pipeline' && !d.disabled) || addableTypes.value.find(d => !d.disabled) || null)
/** 「新建」按钮：直接新建推荐类型实例（当前唯一脚手架 = Agent脚手架） */
const newInstance = () => { const t = recommendedType.value; if (t) void createInstance(t.key) }
const iconOf = (type: string) => SCAFFOLDS.find(s => s.key === type)?.icon || 'fa fa-cubes'

const selectInstance = (id: string) => {
  if (id === store.activeInstanceId) return
  if (scaffoldRef.value) handles.set(store.activeInstanceId, scaffoldRef.value)
  store.setActiveInstance(id)
}

/**
 * 新建实例：只登记实例，**不预先创建任务文件**（避免在默认目录留下需要清理的空文件）。
 * 实例在内存中工作，首次「保存」（实例栏或任务页）时由 useInstanceTaskFile 弹对话框选择 .task 位置并回填登记。
 */
const createInstance = async (type: string) => {
  const def = SCAFFOLDS.find(s => s.key === type)
  if (!def) return
  const count = store.instancesOfType(type).length
  if (count >= def.maxInstances) {
    ElMessage.warning(isEn.value ? `At most ${def.maxInstances} instances for this type` : `该类型最多 ${def.maxInstances} 个实例`)
    return
  }
  if (store.scaffoldInstances.length >= MAX_INSTANCES_TOTAL) {
    ElMessage.warning(isEn.value ? `Instance limit reached (${MAX_INSTANCES_TOTAL})` : `实例总数已达上限（${MAX_INSTANCES_TOTAL} 个）`)
    return
  }
  store.addInstance(type)
}

/** 从 .task 文件新建/激活实例（复用 store 的识别逻辑） */
const openFromFile = async () => {
  if (!window.ipcRenderer) return
  const res = await window.ipcRenderer.invoke('loadTaskFile')
  if (!res?.success || !res.path) return
  await store.openTaskFileByPath(res.path)
  void refreshFileStats()
}

const renameInstance = async (inst: ScaffoldInstanceMeta) => {
  instanceMenu.value = null
  try {
    const r = await ElMessageBox.prompt(
      isEn.value ? 'Instance name' : '实例名称',
      isEn.value ? 'Rename instance' : '重命名实例',
      { inputValue: displayTitle(inst), confirmButtonText: isEn.value ? 'OK' : '确定', cancelButtonText: isEn.value ? 'Cancel' : '取消' },
    )
    if (r.value) store.renameInstance(inst.id, String(r.value))
  } catch { /* 取消 */ }
}

// ---------- 实例右键菜单（重命名 / 关闭） ----------
const instanceMenu = ref<{ x: number; y: number; inst: ScaffoldInstanceMeta } | null>(null)
const openInstanceMenu = (inst: ScaffoldInstanceMeta, e: MouseEvent) => {
  instanceMenu.value = { x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 90), inst }
}
const renameFromMenu = () => { const m = instanceMenu.value; if (m) void renameInstance(m.inst) }
const closeFromMenu = () => { const m = instanceMenu.value; if (m) void closeInstance(m.inst) }
const onDocClick = () => { if (instanceMenu.value) instanceMenu.value = null }

// ---------- 开始 / 暂停 / 保存（作用于「当前标签」实例；按住修饰键 = 全部） ----------
// 需求：实例栏左侧按钮控制当前打开标签的任务，而不是全部。
// 保留批量能力：Ctrl / ⌘ / Alt + 点击 = 对所有已打开实例执行（提示里已说明）。
/** 修饰键点击 = 对所有已打开实例操作 */
const wantsAllInstances = (e?: MouseEvent) => !!(e && (e.ctrlKey || e.metaKey || e.altKey))
/** 操作目标：默认只取当前标签实例；修饰键点击取全部已打开实例 */
const barTargets = (e?: MouseEvent): ScaffoldInstanceMeta[] => {
  if (wantsAllInstances(e)) return instances.value.slice()
  const cur = instances.value.find(i => i.id === store.activeInstanceId)
  return cur ? [cur] : []
}
const allHintSuffix = (zh: string, en: string) => (isEn.value ? `\nCtrl/⌘/Alt-click: ${en}` : `\n按住 Ctrl / ⌘ / Alt 点击：${zh}`)
const nameOf = (inst: ScaffoldInstanceMeta) => displayTitle(inst)

/** 开始：运行 / 继续当前任务（未打开的实例没有内存态，无法开始） */
const startFromBar = (e?: MouseEvent) => {
  const list = barTargets(e)
  const zh = !isEn.value
  const single = list.length === 1
  let n = 0
  let first = ''
  for (const inst of list) {
    const h = handleOf(inst.id)
    if (typeof h?.start === 'function') {
      try { h.start(); n++; if (!first) first = nameOf(inst) } catch (err) { console.warn('[instance] start 失败:', err) }
    }
  }
  if (!n) {
    ElMessage.info(zh
      ? (single ? '当前任务尚未打开，无法开始（先点它的实例标签）' : '没有可开始的实例（请先打开实例）')
      : (single ? 'The current task is not open yet — open its tab first' : 'No opened instance can be started — open an instance first'))
    return
  }
  ElMessage.success(zh
    ? (n === 1 ? `已开始「${first}」` : `已开始 ${n} 个实例`)
    : (n === 1 ? `Started “${first}”` : `Started ${n} instance(s)`))
}
/** 暂停：只暂停当前任务（修饰键 = 全部运行中的实例） */
const stopFromBar = async (e?: MouseEvent) => {
  const list = barTargets(e)
  const zh = !isEn.value
  const single = list.length === 1
  const running = list.filter(i => isInstanceRunning(i.id))
  if (!running.length) {
    ElMessage.info(zh
      ? (single ? '当前任务没有在运行' : '当前没有正在运行的实例')
      : (single ? 'The current task is not running' : 'No running instance'))
    return
  }
  // 先给反馈：停止会级联取消大量进行中的 LLM 会话，主进程需要一段时间收敛，
  // 期间界面不应“看起来死掉”（以前这里同步循环 + 无提示，容易被当成卡死）
  ElMessage.info(zh
    ? (running.length === 1 ? `正在暂停「${nameOf(running[0])}」...` : `正在暂停 ${running.length} 个实例...`)
    : (running.length === 1 ? `Pausing “${nameOf(running[0])}”...` : `Pausing ${running.length} instance(s)...`))
  let n = 0
  const t0 = Date.now()
  for (const inst of running) {
    const h = handleOf(inst.id)
    if (typeof h?.stop === 'function') {
      const t = Date.now()
      try {
        h.stop()
        n++
      } catch (err) {
        console.warn('[instance] stop 失败:', err)
      }
      if (import.meta.env.DEV) {
        console.log(`[stopFromBar] ${inst.type}#${inst.id} stop 用时 ${Date.now() - t} ms`)
      }
    }
    // 让出主线程：每个实例停完后都能重绘 / 响应输入，避免整屏一起卡
    await new Promise((r) => setTimeout(r, 0))
  }
  if (import.meta.env.DEV) console.log(`[stopFromBar] 共 ${n} 个实例，总耗时 ${Date.now() - t0} ms`)
  ElMessage[n ? 'success' : 'info'](n
    ? (zh ? (n === 1 ? `已暂停「${nameOf(running[0])}」` : `已暂停 ${n} 个实例`) : (n === 1 ? `Paused “${nameOf(running[0])}”` : `Paused ${n} instance(s)`))
    : (zh ? '当前没有正在运行的实例' : 'No running instance'))
}

/** 保存：只保存当前任务（修饰键 = 全部已打开实例）；尚未关联文件的会弹对话框选位置 */
const saveFromBar = async (e?: MouseEvent) => {
  const list = barTargets(e)
  const zh = !isEn.value
  const single = list.length === 1
  const targets = list.filter((i) => typeof handleOf(i.id)?.saveTaskState === 'function')
  const skipped = list.length - targets.length
  if (!targets.length) {
    ElMessage.info(zh
      ? (single ? '当前任务尚未打开，无法保存' : '没有可保存的实例（请先打开实例）')
      : (single ? 'The current task is not open yet — nothing to save' : 'No opened instance can be saved — open an instance first'))
    return
  }
  let ok = 0
  let fail = 0
  let canceled = 0
  let running = 0
  for (const inst of targets) {
    const h = handleOf(inst.id)
    if (typeof h?.saveTaskState !== 'function') continue
    const hadFile = !!inst.filePath
    if (isInstanceRunning(inst.id)) running++
    try {
      const r = await h.saveTaskState()
      if (r === false) {
        // 未关联文件的实例：用户取消了「另存为」对话框 → 记为取消，而不是失败
        const linked = !!store.scaffoldInstances.find(i => i.id === inst.id)?.filePath
        if (!hadFile && !linked) canceled++
        else fail++
      } else ok++
    } catch (err) {
      fail++
      console.warn('[instance] 保存失败:', err)
    }
    // 让出主线程：大表格序列化很重，逐个来才能保持界面响应
    await new Promise((r) => setTimeout(r, 0))
  }
  const tail = [
    skipped ? (zh ? `，${skipped} 个未打开已跳过` : `, ${skipped} not opened`) : '',
    canceled ? (zh ? `，${canceled} 个取消选择保存位置` : `, ${canceled} canceled`) : '',
  ].join('')
  const runningNote = running
    ? (zh ? `，其中 ${running} 个运行中（保存快照）` : `, ${running} running (snapshot)`)
    : ''
  // 反馈统一走状态栏左下角（各实例自身已显示「保存中…→已保存/失败」）；
  // 只有多实例（修饰键）或需要补充说明时，才把汇总写到当前可见实例的状态栏。
  const activeHandle: any = store.activeInstanceId ? handleOf(store.activeInstanceId) : null
  const canHint = typeof activeHandle?.showStatusHint === 'function'
  if (!single) {
    const summary = (fail
      ? (zh ? `已保存 ${ok} 个实例，${fail} 个失败` : `Saved ${ok} instance(s), ${fail} failed`)
      : (zh ? `已保存 ${ok} 个实例` : `Saved ${ok} instance(s)`)) + tail + runningNote
    if (canHint) activeHandle.showStatusHint(fail ? 'err' : 'ok', summary)
    else ElMessage[fail ? 'warning' : 'success'](summary)
  } else if (running && canHint) {
    const title = nameOf(targets[0])
    const text = fail
      ? (zh ? `「${title}」保存失败（详见日志）` : `Failed to save “${title}” (see logs)`)
      : canceled
        ? (zh ? '已取消选择保存位置' : 'Save location canceled')
        : (zh ? `已保存「${title}」` : `Saved “${title}”`)
    activeHandle.showStatusHint(fail ? 'err' : canceled ? 'info' : 'ok', text + runningNote)
  }
  void refreshFileStats()
}

/** 关闭实例：运行中先确认（会停止后台任务）；任务文件保留在磁盘上 */
const closeInstance = async (inst: ScaffoldInstanceMeta) => {
  const zh = !isEn.value
  const running = isInstanceRunning(inst.id)
  try {
    await ElMessageBox.confirm(
      (zh ? `关闭实例「${displayTitle(inst)}」？` : `Close instance "${displayTitle(inst)}"?`)
      + (running ? (zh ? '\n该实例正在后台运行，关闭会停止正在执行的任务。' : '\nIt is running in the background; closing will stop the running task.') : '')
      + (inst.filePath ? (zh ? `\n任务文件保留：${inst.filePath}` : `\nTask file kept: ${inst.filePath}`) : ''),
      zh ? '关闭实例' : 'Close instance',
      { confirmButtonText: zh ? '关闭' : 'Close', cancelButtonText: zh ? '取消' : 'Cancel', type: running ? 'warning' : 'info' },
    )
  } catch { return }
  // 停掉后台任务并释放定时器/监听（KeepAlive 缓存条目随后由 :max LRU 回收）
  const h = handleOf(inst.id)
  try { h?.dispose?.() } catch (e) { console.warn('[instance] dispose 失败:', e) }
  handles.delete(inst.id)
  if (running) reportInstanceRunning(inst.id, false)
  store.removeInstance(inst.id)
  await nextTick()
  void refreshFileStats()
}

// ==================== 脚手架回调 ====================
const onLinkFile = (path: string) => {
  const id = store.activeInstanceId
  if (!id || !path) return
  const conflict = store.linkInstanceFile(id, path)
  if (conflict) {
    ElMessage.warning(isEn.value
      ? `This task file is already used by instance "${conflict.title}". Each instance needs its own file.`
      : `该任务文件已被实例「${conflict.title}」关联，每个实例需要独立的文件`)
  }
  void refreshFileStats()
}
const onFileMissing = (path: string) => {
  const inst = store.instanceByFilePath(path)
  if (inst) store.markInstanceFileMissing(inst.id, true)
}
const onSaved = (path: string) => {
  const inst = store.instanceByFilePath(path)
  if (inst) store.markInstanceFileMissing(inst.id, false)
  void refreshFileStats()
}

// ==================== 初始化：迁移 ====================
onMounted(() => {
  store.ensureInstances()
  document.addEventListener('click', onDocClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  if (etaTimer) { clearInterval(etaTimer); etaTimer = null }
})
</script>

<style scoped>
/* 根容器纵向排布：实例导航栏（自适应高）+ 脚手架内容（占满剩余高度）。
   ⚠️ 内容区必须用 flex:1 + min-height:0，不能写 height:100%——
   否则加上导航栏后总高 = 导航栏 + 100%，超出容器把脚手架底部的状态栏顶出可视区 */
.agent-scaffold {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--backgroundColor);
  /* 实例栏与脚手架内部标签页（.top-tabs）共用的条高：两处样式必须保持一致 */
  --harness-bar-h: 34px;
}

.agent-scaffold-body {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
}

/* ====== 主内容 ====== */
.main-content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

/* ====== 无实例引导页：一句话说明 + 两个入口（精简版） ====== */
.cli-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
}
.cli-empty-icon { font-size: 30px; color: var(--borderColor); }
.cli-empty-title { font-size: 14px; font-weight: 600; color: var(--fontColor); }
.cli-empty-hint { max-width: 460px; font-size: 11px; line-height: 1.7; color: var(--fontColor); opacity: 0.8; }
.cli-empty-actions { display: flex; gap: 8px; margin-top: 2px; }
.cli-empty-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 16px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  transition: all 0.15s;
}
.cli-empty-btn:hover { background: var(--menuColor); }
/* 主按钮（新建任务）：主题的 menuColor 底 + 略深一档的悬停 */
.cli-empty-btn.primary { background: var(--menuColor); border-color: var(--borderColor); color: var(--fontColor); font-weight: 600; }
.cli-empty-btn.primary:hover { background: color-mix(in srgb, var(--menuColor) 80%, var(--borderColor)); }
.cli-empty-btn.primary.disabled { opacity: 0.45; cursor: not-allowed; }

/* ====== 实例导航栏 ====== */
.instance-bar {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  /* 高度与下方脚手架标签页一致（--harness-bar-h）：4.5 + 24(行内控件) + 4.5 + 1(border) = 34 */
  padding: 4.5px 5px;
  min-height: var(--harness-bar-h, 34px);
  box-sizing: border-box;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
}
.instance-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  /* 固定高度：操作按钮与实例标签高度完全一致（与内部图标字号无关） */
  height: 24px;
  box-sizing: border-box;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fontColor);
  user-select: none;
}
.instance-tab:hover { background: var(--hoverColor, rgba(128,128,128,0.12)); }
.instance-tab.active {
  background: var(--activeColor, rgba(64,158,255,0.15));
  border-color: var(--activeBorder, rgba(64,158,255,0.5));
}
.instance-tab i:first-child { font-size: 12px; opacity: 0.85; }
.instance-tab .tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.instance-tab.busy .tab-title { font-weight: 600; }
/* 运行中状态点（对齐 AgentBatch 的执行中色） */
.instance-tab.busy::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #2196F3;
  flex: 0 0 auto;
}
.instance-tab.missing i:first-child { color: #f44336; }
.instance-tab .tab-warn { color: #f44336; font-size: 11px; }
.instance-tab .tab-close {
  font-size: 11px;
  opacity: 0.55;
  padding: 1px 2px;
  border-radius: 3px;
}
.instance-tab .tab-close:hover { opacity: 1; background: rgba(244,67,54,0.18); }
.instance-tab.add { color: var(--fontColor); opacity: 0.8; }
.instance-tab.add:hover { opacity: 1; }

/* 实例操作按钮（常驻导航栏：打开 / 新建 / 开始 / 暂停 / 保存） */
.bar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  min-width: 26px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 4px;
  cursor: pointer;
  color: var(--fontColor);
  opacity: 0.85;
  flex: 0 0 auto;
}
.bar-btn i { font-size: 12px; }
.bar-btn:hover { background: var(--hoverColor, rgba(128,128,128,0.12)); opacity: 1; }
.bar-btn.disabled { opacity: 0.4; cursor: not-allowed; }
.bar-btn.disabled:hover { background: none; }
/* 操作按钮与实例标签间的分隔线 */
.bar-sep { width: 1px; height: 16px; margin: 0 3px; background: var(--borderColor); flex: 0 0 auto; }
.add-menu-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  color: var(--fontColor);
}
.add-menu-item:hover { background: var(--hoverColor, rgba(128,128,128,0.12)); }
/* 菜单项左侧图标统一占位宽度：不同图标（folder/plus/play/pause…）字形宽窄不一，
   不固定宽度时后面的文字会错开对齐 */
.add-menu-item > i:first-child {
  flex: 0 0 14px;
  width: 14px;
  text-align: center;
  font-size: 12px;
}
.add-menu-item.disabled { opacity: 0.45; cursor: not-allowed; }
.add-menu-item.disabled:hover { background: none; }
.add-menu-label { flex: 1; }

/* 实例右键菜单（Teleport 到 body，固定定位避免被导航栏裁剪） */
.instance-ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 150px;
  padding: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background: var(--backgroundColor);
  box-shadow: 0 2px 10px rgba(0,0,0,0.2);
}
</style>
