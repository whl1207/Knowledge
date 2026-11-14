<!--
  SchedulePanel.vue — 自动化任务面板（首页左侧工具栏入口打开）

  复刻 DSH 自动化任务的交互骨架（列表 / 规则 / 目的地 / 暂停恢复 / 立即执行 / 运行记录），
  但**只做 prompt 投递**：到点把指令送进目标聊天的收件箱，执行仍由对话里的 Agent 完成。
  新建 / 编辑 / 删除都走 `@/lib/scheduleClient`（主进程 schedule 服务是唯一事实源）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import {
  createSchedule,
  deleteInactiveSchedules,
  editSchedule,
  listSchedules,
  runScheduleNow,
  scheduleAvailable,
  scheduleHistory,
  type ScheduleReceipt,
  type ScheduleTask,
} from '@/lib/scheduleClient'
import type { ScheduleTiming } from '@/shared/scheduleTime'

const props = defineProps<{
  chats: any[]
  currentChatId?: string
  currentChat?: any
  /** 窄屏（手机 / 细长窗口）：右侧栏是整屏二级界面，本面板也整屏显示 */
  narrow?: boolean
  /** 聊天列表当前是否展开（决定 fa-bars 的提示文字） */
  sidebarVisible?: boolean
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'toggle-sidebar'): void }>()

const store = usestore()
const zh = () => store.locales === 'zh'
const T = (a: string, b: string) => (zh() ? a : b)

const available = scheduleAvailable()
const loading = ref(false)
const tasks = ref<ScheduleTask[]>([])
const activeFilter = ref<'active' | 'paused' | 'ended' | 'all'>('active')
const keyword = ref('')
const busy = ref('')

/** 正在编辑的任务（null = 新建） */
const editingId = ref<string | null>(null)
const formOpen = ref(false)
const historyOpen = ref<string | null>(null)
const history = ref<ScheduleReceipt[]>([])

const localTz = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' } catch { return 'Asia/Shanghai' }
})()

const form = reactive({
  title: '',
  prompt: '',
  kind: 'daily' as 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule',
  at: '',
  everySeconds: 3600,
  time: '09:00',
  weekdays: [1, 2, 3, 4, 5] as number[],
  cron: '0 9 * * *',
  rrule: `DTSTART;TZID=${localTz}:20260101T090000\nRRULE:FREQ=DAILY;INTERVAL=1`,
  timeZone: localTz,
  targetKind: 'chat' as 'chat' | 'new_chat_once' | 'new_chat',
  targetTitle: '',
  /** 执行这个任务的智能体：'' = 跟随目标对话；'__normal__' = 普通对话（不带预设）；其它 = 预设 id */
  agentPresetId: '',
})

/** 可选智能体（Agent 预设）：来自设置 → 智能体 → 预设 */
const agentOptions = computed(() => {
  const list = Array.isArray(store.agentPresets) ? store.agentPresets : []
  return list
    .filter((p: any) => p && p.id)
    .map((p: any) => ({ id: String(p.id), name: String(p.name || p.id) }))
})

const WEEK = computed(() => (zh()
  ? [['1', '一'], ['2', '二'], ['3', '三'], ['4', '四'], ['5', '五'], ['6', '六'], ['7', '日']]
  : [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']]))

const statusText = (s: string) => (s === 'active' ? T('已开启', 'Active') : s === 'paused' ? T('已暂停', 'Paused') : T('已结束', 'Ended'))

const fmtTime = (iso?: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString(zh() ? 'zh-CN' : 'en-US', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return tasks.value.filter((t) => {
    if (activeFilter.value === 'active' && t.status !== 'active') return false
    if (activeFilter.value === 'paused' && t.status !== 'paused') return false
    if (activeFilter.value === 'ended' && t.status !== 'ended') return false
    if (!kw) return true
    return `${t.title} ${t.prompt}`.toLowerCase().includes(kw)
  })
})

async function refresh() {
  if (!available) return
  loading.value = true
  try {
    const res = await listSchedules({ limit: 500 })
    tasks.value = res.items
  } catch (e: any) {
    ElMessage.error(T('读取自动化任务失败：', 'Failed to load tasks: ') + (e?.message || e))
  } finally {
    loading.value = false
  }
}

function resetForm() {
  editingId.value = null
  form.title = ''
  form.prompt = ''
  form.kind = 'daily'
  form.time = '09:00'
  form.weekdays = [1, 2, 3, 4, 5]
  form.everySeconds = 3600
  form.at = ''
  form.cron = '0 9 * * *'
  form.rrule = `DTSTART;TZID=${localTz}:20260101T090000\nRRULE:FREQ=DAILY;INTERVAL=1`
  form.timeZone = localTz
  form.targetKind = 'chat'
  form.targetTitle = ''
  form.agentPresetId = ''
}

function openCreate() {
  resetForm()
  formOpen.value = true
}

async function openEdit(task: ScheduleTask) {
  resetForm()
  editingId.value = task.id
  form.title = task.title
  form.prompt = task.prompt
  form.kind = task.timing.kind
  if (task.timing.kind === 'at') form.at = toLocalInput(task.timing.at)
  if (task.timing.kind === 'every') form.everySeconds = task.timing.everySeconds
  if (task.timing.kind === 'daily' || task.timing.kind === 'weekly') {
    form.time = task.timing.time
    form.timeZone = task.timing.timeZone
  }
  if (task.timing.kind === 'weekly') form.weekdays = task.timing.weekdays.slice()
  if (task.timing.kind === 'cron') {
    form.cron = task.timing.expression
    form.timeZone = task.timing.timeZone
  }
  if (task.timing.kind === 'rrule') form.rrule = task.timing.rrule
  form.targetKind = task.target.kind
  form.targetTitle = task.target.title || ''
  form.agentPresetId = String(task.target.chatTemplate?.agentPresetId || '')
  formOpen.value = true
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function buildTiming(): ScheduleTiming | null {
  switch (form.kind) {
    case 'at': {
      const ms = form.at ? new Date(form.at).getTime() : NaN
      if (!Number.isFinite(ms)) { ElMessage.warning(T('请选择执行时间', 'Pick a time')); return null }
      return { kind: 'at', at: new Date(ms).toISOString() }
    }
    case 'every':
      return { kind: 'every', everySeconds: Math.max(60, Math.round(Number(form.everySeconds) || 3600)) }
    case 'daily':
      return { kind: 'daily', time: form.time, timeZone: form.timeZone }
    case 'weekly':
      if (!form.weekdays.length) { ElMessage.warning(T('至少选一个星期几', 'Pick at least one weekday')); return null }
      return { kind: 'weekly', time: form.time, timeZone: form.timeZone, weekdays: form.weekdays.slice().sort((a, b) => a - b) }
    case 'cron':
      return { kind: 'cron', expression: form.cron.trim(), timeZone: form.timeZone }
    case 'rrule':
      return { kind: 'rrule', rrule: form.rrule.trim() }
    default:
      return null
  }
}

async function submit() {
  if (!form.title.trim()) { ElMessage.warning(T('请填标题', 'Title is required')); return }
  if (!form.prompt.trim()) { ElMessage.warning(T('请填指令', 'Prompt is required')); return }
  const timing = buildTiming()
  if (!timing) return
  const chat = props.currentChat || {}
  // 执行这个任务的智能体：跟随目标对话 / 普通对话 / 指定 Agent 预设
  const agentChoice = String(form.agentPresetId || '')
  const chatTemplate: any = {
    workspace: chat.workspace || '',
    noWorkspace: !chat.workspace,
    config: chat.config ? JSON.parse(JSON.stringify(chat.config)) : undefined,
    ...(agentChoice === '__normal__' ? { agentMode: 'normal' } : {}),
    ...(agentChoice && agentChoice !== '__normal__' ? { agentPresetId: agentChoice } : {}),
  }
  const target: any = form.targetKind === 'chat'
    ? { kind: 'chat', chatId: props.currentChatId || '', chatTemplate }
    : {
        kind: form.targetKind,
        ...(form.targetTitle.trim() ? { title: form.targetTitle.trim() } : {}),
        chatTemplate,
      }
  if (form.targetKind === 'chat' && !target.chatId) {
    ElMessage.warning(T('当前没有打开的对话，无法投递', 'No chat is open'))
    return
  }
  busy.value = 'save'
  try {
    const res = editingId.value
      ? await editSchedule({ id: editingId.value, action: 'update', patch: { title: form.title.trim(), prompt: form.prompt.trim(), timing, target } })
      : await createSchedule({ title: form.title.trim(), prompt: form.prompt.trim(), timing, target })
    if (!res.ok) {
      ElMessage.error(res.message || T('保存失败', 'Save failed'))
      return
    }
    ElMessage.success(editingId.value ? T('已保存', 'Saved') : T('已创建', 'Created'))
    formOpen.value = false
    await refresh()
  } catch (e: any) {
    ElMessage.error(T('保存失败：', 'Save failed: ') + (e?.message || e))
  } finally {
    busy.value = ''
  }
}

async function toggleActive(task: ScheduleTask) {
  busy.value = task.id
  try {
    const res = await editSchedule({ id: task.id, action: 'update', patch: { active: task.status !== 'active' } })
    if (!res.ok) ElMessage.error(res.message)
    await refresh()
  } finally { busy.value = '' }
}

async function runNow(task: ScheduleTask) {
  busy.value = task.id
  try {
    const res = await runScheduleNow(task.id)
    if (!res.ok) ElMessage.error(res.message)
    else ElMessage.success(T('已投递（执行在目标对话里进行）', 'Delivered (runs in the target chat)'))
    await refresh()
  } finally { busy.value = '' }
}

async function removeTask(task: ScheduleTask) {
  try {
    await ElMessageBox.confirm(
      T(`删除「${task.title}」？已投递的消息不会撤回。`, `Delete “${task.title}”? Delivered messages stay.`),
      T('删除任务', 'Delete task'),
      { type: 'warning', confirmButtonText: T('删除', 'Delete'), cancelButtonText: T('取消', 'Cancel') },
    )
  } catch { return }
  busy.value = task.id
  try {
    const res = await editSchedule({ id: task.id, action: 'delete' })
    if (!res.ok) ElMessage.error(res.message)
    await refresh()
  } finally { busy.value = '' }
}

async function openHistory(task: ScheduleTask) {
  historyOpen.value = task.id
  history.value = []
  try {
    const res = await scheduleHistory(task.id, 50)
    if (res.ok) history.value = res.records
  } catch { /* 忽略 */ }
}

async function openTargetChat(task: ScheduleTask) {
  const id = task.target.chatId || task.lastDelivery?.chatId
  if (!id) return
  const chat = (props.chats || []).find((c) => c && String(c.id) === id)
  if (!chat) { ElMessage.warning(T('目标对话已不存在', 'Target chat no longer exists')); return }
  emit('close')
}

async function cleanEnded() {
  try {
    const { removed } = await deleteInactiveSchedules()
    ElMessage.success(T(`已清理 ${removed} 个已结束任务`, `Removed ${removed} ended tasks`))
    await refresh()
  } catch (e: any) {
    ElMessage.error(T('清理失败：', 'Cleanup failed: ') + (e?.message || e))
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refresh()
  timer = setInterval(() => { void refresh() }, 15000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="schedule-panel" :class="{ narrow: !!narrow }">
    <div class="schedule-head">
      <!-- 聊天列表开关：与 chat-header 里那颗 fa-bars 完全同款（纯图标、无边框/底色） -->
      <div
        class="sidebar-toggle-btn"
        :title="sidebarVisible ? T('隐藏聊天列表', 'Hide chat list') : T('显示聊天列表', 'Show chat list')"
        @click="emit('toggle-sidebar')"
      >
        <i class="fa fa-bars"></i>
      </div>
      <i class="fa fa-clock-o" />
      <span class="schedule-title">{{ T('自动化任务', 'Tasks') }}</span>
      <select v-model="activeFilter" class="s-input s-head-select" :title="T('筛选状态', 'Filter')">
        <option value="active">{{ T('已开启', 'Active') }}</option>
        <option value="paused">{{ T('已暂停', 'Paused') }}</option>
        <option value="ended">{{ T('已结束', 'Ended') }}</option>
        <option value="all">{{ T('全部', 'All') }}</option>
      </select>
      <input v-model="keyword" class="s-input s-head-search" :placeholder="T('搜索', 'Search')" />
      <span class="schedule-head-actions">
        <button class="s-btn s-btn-ghost s-head-clean" :title="T('清理已结束任务', 'Clear ended tasks')" @click="cleanEnded">
          <i class="fa fa-trash-o" />
        </button>
        <button class="s-btn" :disabled="!available" :title="T('新建任务', 'New task')" @click="openCreate">
          <i class="fa fa-plus" />
        </button>
        <button class="s-btn s-btn-ghost s-head-close" :title="T('关闭', 'Close')" @click="emit('close')">
          <i class="fa fa-times" />
        </button>
      </span>
    </div>

      <div v-if="!available" class="schedule-empty">
        {{ T('自动化任务只在桌面版可用（需要主进程）。', 'Scheduled tasks are desktop-only (they live in the main process).') }}
      </div>

      <template v-else>
        <div class="schedule-body scoll">
          <div v-if="loading && !tasks.length" class="schedule-empty">{{ T('加载中…', 'Loading…') }}</div>
          <div v-else-if="!filtered.length" class="schedule-empty">
            {{ T('还没有任务。点「新建」安排一条定时指令。', 'No tasks yet. Click New to schedule one.') }}
          </div>
          <div v-for="task in filtered" :key="task.id" class="task-card" :class="'st-' + task.status">
            <div class="task-head">
              <span class="task-title" :title="task.title">{{ task.title }}</span>
              <span class="task-actions">
                <button class="t-icon" :disabled="busy === task.id" :title="T('立即执行', 'Run now')" @click="runNow(task)">
                  <i class="fa fa-bolt" />
                </button>
                <button class="t-icon" :disabled="busy === task.id" :title="task.status === 'active' ? T('暂停', 'Pause') : T('恢复', 'Resume')" @click="toggleActive(task)">
                  <i class="fa" :class="task.status === 'active' ? 'fa-pause' : 'fa-play'" />
                </button>
                <button class="t-icon" :title="T('编辑', 'Edit')" @click="openEdit(task)">
                  <i class="fa fa-pencil" />
                </button>
                <button class="t-icon" :title="T('运行记录', 'History')" @click="openHistory(task)">
                  <i class="fa fa-history" />
                </button>
                <button class="t-icon t-danger" :disabled="busy === task.id" :title="T('删除', 'Delete')" @click="removeTask(task)">
                  <i class="fa fa-trash-o" />
                </button>
              </span>
            </div>
            <div class="task-meta">
              <span class="tag">{{ task.scheduleText }}</span>
              <span class="tag">{{ T('下次', 'Next') }} {{ fmtTime(task.scheduledAt) }}</span>
              <span class="tag" :class="'badge-' + task.status">{{ statusText(task.status) }}</span>
              <span class="tag">
                {{ task.target.kind === 'chat' ? T('当前对话', 'chat') : task.target.kind === 'new_chat_once' ? T('新建并复用', 'new (reuse)') : T('每次新建', 'new each') }}
              </span>
            </div>
            <div class="task-prompt" :title="task.prompt">{{ task.prompt }}</div>
          </div>
        </div>
      </template>

      <!-- 新建 / 编辑：直接复用 Element Plus 的 el-message-box 结构（与「新建 Markdown」完全同一套皮肤） -->
      <div v-if="formOpen" class="el-overlay schedule-modal" @click.self="formOpen = false">
        <div class="el-message-box" role="dialog" tabindex="-1">
          <div class="el-message-box__header">
            <div class="el-message-box__title"><span>{{ editingId ? T('编辑任务', 'Edit task') : T('新建任务', 'New task') }}</span></div>
            <button type="button" class="el-message-box__headerbtn" :aria-label="T('关闭', 'Close')" @click="formOpen = false">
              <i class="el-message-box__close">✕</i>
            </button>
          </div>
          <div class="el-message-box__content">
          <div class="s-dialog-body">
          <label class="s-field">
            <input v-model="form.title" class="s-input" maxlength="120" :title="T('标题', 'Title')" :placeholder="T('标题，例如：每天早报', 'Title, e.g. Morning briefing')" />
          </label>
          <label class="s-field">
            <textarea v-model="form.prompt" class="s-input s-area" rows="2" :title="T('到点投递到对话的指令', 'Prompt delivered to the chat')" :placeholder="T('指令，例如：汇总昨天的会议，列出今天的三件事', 'Prompt, e.g. Summarise yesterday and list today’s three tasks')" />
          </label>
          <div class="s-row">
            <label class="s-field s-grow">
              <select v-model="form.kind" class="s-input" :title="T('重复', 'Repeat')">
                <option value="at">{{ T('一次性', 'Once') }}</option>
                <option value="every">{{ T('固定间隔', 'Interval') }}</option>
                <option value="daily">{{ T('每天', 'Daily') }}</option>
                <option value="weekly">{{ T('每周', 'Weekly') }}</option>
                <option value="cron">{{ T('Cron', 'Cron') }}</option>
                <option value="rrule">{{ T('RRULE', 'RRULE') }}</option>
              </select>
            </label>
            <label v-if="form.kind === 'at'" class="s-field s-grow">
              <input v-model="form.at" type="datetime-local" class="s-input" :title="T('执行时间', 'When')" />
            </label>
            <label v-else-if="form.kind === 'every'" class="s-field s-grow">
              <input v-model.number="form.everySeconds" type="number" min="60" class="s-input" :title="T('间隔秒数（≥60）', 'Seconds (≥60)')" :placeholder="T('间隔秒数（≥60）', 'Seconds (≥60)')" />
            </label>
            <label v-else-if="form.kind === 'daily' || form.kind === 'weekly'" class="s-field">
              <input v-model="form.time" type="time" class="s-input" :title="T('时刻', 'Time')" />
            </label>
            <label v-else-if="form.kind === 'cron'" class="s-field s-grow">
              <input v-model="form.cron" class="s-input" :title="T('Cron（分 时 日 月 周）', 'Cron (min hour dom mon dow)')" placeholder="0 9 * * 1-5" />
            </label>
          </div>
          <div v-if="form.kind === 'weekly'" class="s-field" :title="T('星期', 'Weekdays')">
            <div class="s-chips">
              <label v-for="[v, label] in WEEK" :key="v" class="s-chip">
                <input v-model="form.weekdays" type="checkbox" :value="Number(v)" /> {{ label }}
              </label>
            </div>
          </div>
          <!-- 时区不暴露给用户：新建用本机时区（form.timeZone 在 resetForm 里取
               Intl 解析出的本地时区；编辑已有任务时沿用任务保存的时区，不会被改掉） -->
          <label v-if="form.kind === 'rrule'" class="s-field">
            <textarea v-model="form.rrule" class="s-input s-area s-mono" rows="2" :title="T('RRULE：两行 DTSTART + RRULE', 'RRULE: DTSTART + RRULE')" :placeholder="T('DTSTART;TZID=Asia/Shanghai:20260101T090000\nRRULE:FREQ=DAILY;INTERVAL=1', 'DTSTART;TZID=Asia/Shanghai:20260101T090000\nRRULE:FREQ=DAILY;INTERVAL=1')" />
          </label>
          <div class="s-row">
            <label class="s-field s-grow">
              <select v-model="form.targetKind" class="s-input" :title="T('投递到', 'Deliver to')">
                <option value="chat">{{ T('当前对话', 'Current chat') }}</option>
                <option value="new_chat_once">{{ T('新建对话并复用', 'New chat, then reuse') }}</option>
                <option value="new_chat">{{ T('每次新建对话', 'New chat each time') }}</option>
              </select>
            </label>
            <label v-if="form.targetKind !== 'chat'" class="s-field s-grow">
              <input v-model="form.targetTitle" class="s-input" :title="T('新对话标题（空 = 用任务标题）', 'New chat title (optional)')" :placeholder="T('新对话标题（可空）', 'New chat title (optional)')" />
            </label>
          </div>
          <label class="s-field">
            <select v-model="form.agentPresetId" class="s-input" :title="T('用什么智能体执行', 'Run with agent')">
              <option value="">{{ T('跟随目标对话（默认）', 'Follow the target chat') }}</option>
              <option value="__normal__">{{ T('普通对话（不带智能体预设）', 'Plain chat (no preset)') }}</option>
              <option v-for="p in agentOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          </div>
          </div>
          <div class="el-message-box__btns">
            <button type="button" class="el-button" @click="formOpen = false"><span>{{ T('取消', 'Cancel') }}</span></button>
            <button type="button" class="el-button el-button--primary" :disabled="busy === 'save'" @click="submit"><span>{{ T('保存', 'Save') }}</span></button>
          </div>
        </div>
      </div>

      <!-- 运行记录 -->
      <div v-if="historyOpen" class="el-overlay schedule-modal" @click.self="historyOpen = null">
        <div class="el-message-box" role="dialog" tabindex="-1">
          <div class="el-message-box__header">
            <div class="el-message-box__title"><span>{{ T('运行记录', 'Delivery history') }}</span></div>
            <button type="button" class="el-message-box__headerbtn" :aria-label="T('关闭', 'Close')" @click="historyOpen = null">
              <i class="el-message-box__close">✕</i>
            </button>
          </div>
          <div class="el-message-box__content">
          <div class="s-dialog-body">
          <div v-if="!history.length" class="schedule-empty">{{ T('还没有投递记录', 'No deliveries yet') }}</div>
          <div v-for="(r, i) in history" :key="i" class="history-row">
            <div class="history-time">{{ fmtTime(r.deliveredAt) }} ← {{ fmtTime(r.scheduledAt) }}</div>
            <div class="history-prompt">{{ r.prompt }}</div>
          </div>
          </div>
          </div>
          <div class="el-message-box__btns">
            <button type="button" class="el-button" @click="historyOpen = null"><span>{{ T('关闭', 'Close') }}</span></button>
          </div>
        </div>
      </div>
  </div>
</template>

<style scoped>
/* 内嵌在首页右侧栏：高度撑满、标题行与 .chat-header 同高（var(--topbar-h)），
   不再是浮动遮罩 —— 打开它时右侧栏内容被整个替换掉。 */
.schedule-panel { position: relative; display: flex; flex-direction: column; height: 100%; width: 100%; min-width: 0; overflow: hidden; background: var(--backgroundColor, #fff); color: var(--fontColor, #303133); }
/* 窄屏：右侧栏本身是 fixed 整屏二级界面，这里同样整屏 */
.schedule-panel.narrow { position: fixed; inset: 0; z-index: 2600; }
.schedule-head { display: flex; align-items: center; gap: 5px; padding: 1px 5px; box-sizing: border-box; height: var(--topbar-h); flex-shrink: 0; border-bottom: 1px solid var(--borderColor, #dcdfe6); background: var(--menuColor, #f7f8fa); overflow: hidden; }
/* 聊天列表开关（与 home 的 .sidebar-toggle-btn 同款：纯图标、无边框/底色）。
   home.vue 的样式是 scoped 的，管不到子组件模板里的这颗按钮，所以在这里复制一份。 */
.sidebar-toggle-btn { margin: 0 2px 0 0; padding: 0; width: 26px; height: 24px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; border: 0; background-color: transparent; color: var(--fontColor, #303133); font-size: 13px; border-radius: 6px; cursor: pointer; -webkit-app-region: no-drag; transition: background-color .15s ease, color .15s ease; }
.sidebar-toggle-btn:hover { background-color: var(--menuActiveColor, rgba(0, 0, 0, .06)); color: var(--fontActiveColor, #409eff); }
.schedule-title { font-weight: 600; font-size: 13px; white-space: nowrap; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* 标题栏里的控件：不允许 margin（全局表单样式会带外边距），高度压到与行高一致 */
.schedule-panel select, .schedule-panel input, .schedule-panel textarea, .schedule-panel button { margin: 0 !important; }
/* 标题栏所有元素同高（24px）：标题、筛选、搜索、三个图标按钮 */
.schedule-head > * { height: 24px; box-sizing: border-box; }
/* 左侧时钟图标：FontAwesome 的 <i> 是行内元素，固定高度后字形会偏上；
   用 inline-flex 居中并压掉 line-height，字形才与整行垂直居中 */
.schedule-head > i { display: inline-flex; align-items: center; justify-content: center; width: 14px; font-size: 12px; line-height: 1; flex: 0 0 auto; }
.schedule-title { line-height: 24px; }
.schedule-head .s-input { height: 24px; margin: 0 !important; width:100%}
.schedule-head .s-btn { height: 24px; padding: 0 8px; }
/* 右侧三个图标：整体靠右、按钮 24px（与标题栏其它元素同高）、图标 11px */
.schedule-head-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.schedule-head-actions .s-btn,
.s-head-clean, .s-head-new, .s-head-close { width: 24px; min-width: 24px; height: 24px; padding: 0; font-size: 11px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
.schedule-head-actions .s-btn i { font-size: 11px; }
/* 用更高优先级压住下面 .s-input 的通用样式（否则 select 会被 width:100% 撑满整行） */
.schedule-head select.s-head-select { width: 74px; min-width: 46px; flex: 0 0 auto; padding: 0 2px; }
.schedule-head input.s-head-search { flex: 1 1 40px; min-width: 30px; padding: 0 4px; }
.schedule-grow { flex: 1 1 auto; }
.schedule-body { flex: 1 1 auto; overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.schedule-empty { padding: 28px 12px; text-align: center; font-size: 12px; opacity: .65; }
.s-input { height: 28px; box-sizing: border-box; padding: 0 5px; border: 1px solid var(--borderColor, #dcdfe6); border-radius: 4px; background: var(--backgroundColor, #fff); color: var(--fontColor, #303133); font-size: 12px; }
.s-area { height: auto; padding: 6px 8px; line-height: 1.6; resize: vertical; }
.s-mono { font-family: ui-monospace, Consolas, monospace; }
.s-w120 { width: 120px; }
.s-grow { flex: 1 1 auto; min-width: 0; }
.s-btn { height: 26px; padding: 0 10px; border-radius: 4px; border: 1px solid var(--borderColor, #409eff); color: var(--fontColor); font-size: 12px; cursor: pointer; }
.s-btn:disabled { opacity: .5; cursor: default; }
.s-btn-ghost { background: transparent; color: var(--fontColor, #303133); border-color: var(--borderColor, #dcdfe6); }
.s-danger { color: #c1453c; border-color: #c1453c33; }
/* 任务卡：标题 + 右侧一行图标按钮，下面一行元信息、两行指令；整体紧凑 */
.task-card { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border: 1px solid var(--borderColor, #dcdfe6); border-radius: 6px; }
.task-card.st-paused, .task-card.st-ended { opacity: .72; }
.task-card.st-active { border-left: 2px solid var(--fontActiveColor, #409eff); padding-left: 6px; }
.task-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.task-title { flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 1px; }
.t-icon { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--fontColor, #303133); opacity: .72; font-size: 11px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.t-icon:hover { opacity: 1; background: var(--menuActiveColor, rgba(0, 0, 0, .06)); color: var(--fontActiveColor, #409eff); }
.t-icon:disabled { opacity: .35; cursor: default; }
.t-icon.t-danger:hover { color: #c1453c; }
.task-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 7px; border: 1px solid var(--borderColor, #dcdfe6); opacity: .8; white-space: nowrap; }
.badge-active { color: #2f9e5f; border-color: #2f9e5f66; opacity: 1; }
.badge-paused { color: #d08b1a; border-color: #d08b1a66; opacity: 1; }
.badge-ended { opacity: .6; }
.task-prompt { font-size: 11px; opacity: .72; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
/* 弹层直接复用 el-message-box 的结构类名（与「新建 Markdown」的 ElMessageBox 同一套 EP 皮肤），
   这里只补三件事：遮罩居中、标题用 fontActiveColor、内容区控件对齐 EP 输入框。 */
.schedule-modal { display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
.schedule-modal .el-message-box { max-height: 86vh; display: flex; flex-direction: column; }
.schedule-modal .el-message-box__content { overflow: auto; }
.schedule-modal .el-message-box__title span { color: var(--fontActiveColor, #409eff); font-size: 16px; font-weight: 600; }
.schedule-modal .el-message-box__close { font-size: 14px; font-style: normal; line-height: 1; color: var(--el-text-color-secondary, #909399); }
.schedule-modal .el-message-box__btns { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 15px 15px; }
.s-dialog-body { display: flex; flex-direction: column; gap: 6px; }
.s-dialog-body .s-input { width: 100%; box-sizing: border-box; height: 32px; padding: 0 11px; border: none; border-radius: var(--el-border-radius-base, 4px); background: var(--el-fill-color-blank, #fff); box-shadow: 0 0 0 1px var(--el-border-color, #dcdfe6) inset; color: var(--el-text-color-regular, #606266); font-size: 13px; outline: none; }
.s-dialog-body .s-input:focus { box-shadow: 0 0 0 1px var(--el-color-primary, #409eff) inset; }
.s-row { display: flex; gap: 8px; }
.s-row > .s-field { flex: 1 1 0; min-width: 0; }
.s-field { display: flex; flex-direction: column; gap: 2px; font-size: 12px; padding: 0; min-width: 0; }
.s-field > span { opacity: .7; font-size: 10px; }
.s-dialog-body .s-area { height: auto; min-height: 48px; padding: 5px 11px; }
.s-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.s-chip { display: flex; align-items: center; gap: 3px; font-size: 12px; }
.history-row { padding: 6px 0; border-bottom: 1px dashed var(--borderColor, #dcdfe6); }
.history-time { font-size: 11px; opacity: .6; }
.history-prompt { font-size: 12px; white-space: pre-wrap; }
</style>
