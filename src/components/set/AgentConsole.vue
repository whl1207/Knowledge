<!-- AgentConsole.vue — 智能体控制台：执行中心（主从布局：任务列表 + 详情，按会话聚合） -->
<!-- 用于设置 → 智能体 → 智能体控制台；会话可由外部指定（sessionId prop）或任务列表选择 -->
<template>
  <div class="agent-console">
    <!-- ====== 顶部：执行中心（主从布局：任务列表 + 详情，按会话聚合） ====== -->
    <div class="ac-exec">
      <div class="ac-exec-head">
        <span class="ac-exec-title"><i class="fa fa-tasks"></i> {{ isZh ? '智能体控制台' : 'Agent Console' }}</span>
        <span class="ac-hint">{{ taskRows.length }} {{ isZh ? '个任务' : 'tasks' }}</span>
        <div class="ac-actions">
          <button v-if="selectedSession && !selectedSession.disposed" class="ac-btn" :disabled="selectedSession.status === 'idle'" :title="isZh ? '取消当前执行' : 'Cancel'" @click="onCancel">
            <i class="fa fa-stop"></i>
          </button>
          <button v-if="selectedSession && !selectedSession.disposed" class="ac-btn" :title="isZh ? '销毁智能体' : 'Dispose'" @click="onDispose">
            <i class="fa fa-trash-o"></i>
          </button>
          <button class="ac-btn" :title="isZh ? '刷新' : 'Refresh'" @click="onRefresh">
            <i class="fa fa-refresh"></i>
          </button>
        </div>
      </div>

      <div class="ac-split">
        <!-- ====== 主：任务列表（按会话聚合：agent 会话一行 + 非 agent 后台任务） ====== -->
        <div class="ac-master scoll">
          <div v-if="taskRows.length === 0" class="ac-empty">
            <i class="fa fa-robot"></i>
            <p>{{ isZh ? '暂无任务。在主页选择「智能体」模式发送消息后，这里会显示执行过程与后台任务。' : 'No tasks yet. Send a message in "Agent" mode on Home to see execution here.' }}</p>
          </div>
          <div v-for="row in taskRows" :key="row.key"
            class="ac-row"
            :class="[{ active: row.key === selectedKey }, 'ac-row-' + row.status]"
            :title="row.detail || ''"
            @click="selectTask(row)">
            <i class="fa ac-row-icon" :class="rowIcon(row)"></i>
            <div class="ac-row-main">
              <span class="ac-row-title">{{ row.title }}</span>
              <span class="ac-row-meta">{{ row.kind }} · {{ statusTextOf(row.status) }}</span>
            </div>
            <button v-if="row.status === 'running'" class="ac-btn ac-btn-mini" :title="isZh ? '取消' : 'Cancel'" @click.stop="onCancelRow(row)">
              <i class="fa fa-stop"></i>
            </button>
            <div v-if="row.progress !== null" class="ac-row-bar">
              <div class="ac-row-bar-fill" :style="{ width: row.progress + '%' }"></div>
            </div>
          </div>
        </div>

        <!-- ====== 从：详情 ====== -->
        <div class="ac-detail scoll">
          <!-- agent 会话详情（复用原执行面板） -->
          <template v-if="selectedSession">
            <div class="ac-statusbar">
              <span class="ac-badge" :class="badgeClass(selectedSession.status)">
                <i class="fa" :class="statusIcon"></i> {{ statusText }}
              </span>
              <span class="ac-meta" :title="selectedSession.id">{{ selectedSession.label || selectedSession.id.slice(0, 18) }}</span>
              <span class="ac-meta">T{{ selectedSession.turn }}·S{{ selectedSession.step }}</span>
              <span v-if="selectedSession.inbox > 0" class="ac-badge ac-badge-inbox" :title="isZh ? '排队中的输入' : 'queued input'">
                <i class="fa fa-inbox"></i> {{ selectedSession.inbox }}
              </span>
              <span v-if="selectedSession.lastError" class="ac-error" :title="selectedSession.lastError">
                <i class="fa fa-exclamation-triangle"></i> {{ short(selectedSession.lastError, 40) }}
              </span>
            </div>

            <div v-if="selectedSession.pendingQuestion" class="ac-question">
              <div class="ac-question-text">
                <i class="fa fa-question-circle"></i>
                {{ selectedSession.pendingQuestion.question }}
              </div>
              <div class="ac-question-row">
                <input v-model="answerInput" class="ac-input" :placeholder="isZh ? '输入回答...' : 'Type your answer...'"
                  @keydown.enter="onAnswer" />
                <button class="ac-btn ac-btn-primary" :disabled="!answerInput.trim()" @click="onAnswer">
                  {{ isZh ? '回答' : 'Answer' }}
                </button>
              </div>
            </div>

            <div class="ac-steer-row">
              <input v-model="steerInput" class="ac-input" :placeholder="isZh ? '转向输入（立即插入下一步）...' : 'Steer (applies at next step)...'"
                @keydown.enter="onSteer" />
              <button class="ac-btn" :disabled="!steerInput.trim()" @click="onSteer">
                <i class="fa fa-arrow-right"></i>
              </button>
              <input v-model="injectInput" class="ac-input" :placeholder="isZh ? '注入上下文（不唤醒）...' : 'Inject context (no wake)...'"
                @keydown.enter="onInject" />
              <button class="ac-btn" :disabled="!injectInput.trim()" @click="onInject">
                <i class="fa fa-upload"></i>
              </button>
            </div>

            <div class="ac-body">
              <div v-if="selectedSession.plan" class="ac-plan">
                <div class="ac-section-title"><i class="fa fa-map-o"></i> {{ isZh ? '执行计划' : 'Plan' }}</div>
                <pre class="ac-plan-text">{{ selectedSession.plan }}</pre>
              </div>

              <div v-if="selectedSession.todos.length" class="ac-todos">
                <div class="ac-section-title"><i class="fa fa-list-ul"></i> {{ isZh ? '任务清单' : 'Todos' }}</div>
                <div v-for="t in selectedSession.todos" :key="t.id" class="ac-todo" :class="'ac-todo-' + t.status">
                  <i class="fa" :class="todoIcon(t.status)"></i>
                  <span class="ac-todo-title">{{ t.title }}</span>
                  <span v-if="t.detail" class="ac-todo-detail">{{ t.detail }}</span>
                </div>
              </div>

              <div class="ac-section-title">
                <i class="fa fa-tasks"></i> {{ isZh ? '执行时间线' : 'Timeline' }}
                <span class="ac-steps-count">{{ selectedSession.steps.length }} {{ isZh ? '步' : 'steps' }}</span>
              </div>
              <div v-if="selectedSession.steps.length === 0 && selectedSession.status === 'idle'" class="ac-idle-hint">
                <i class="fa fa-hourglass-o"></i> {{ isZh ? '空闲，等待输入...' : 'Idle, awaiting input...' }}
              </div>
              <div v-for="(step, i) in selectedSession.steps" :key="i" class="ac-step" :class="{ 'ac-step-active': i === selectedSession.steps.length - 1 && selectedSession.status === 'running' }">
                <div class="ac-step-head">
                  <i class="fa" :class="stepEnded(step) ? 'fa-check-circle-o ac-ok' : 'fa-circle-o-notch fa-spin ac-run'"></i>
                  <span class="ac-step-no">Step {{ step.step }}</span>
                  <span class="ac-step-time">{{ duration(step) }}</span>
                </div>
                <div v-if="step.stream || step.content" class="ac-step-text scoll" :class="{ 'ac-step-streaming': !!step.stream }">
                  <pre>{{ step.stream || step.content }}</pre>
                </div>
                <div v-for="(tc, j) in step.toolCalls" :key="j" class="ac-tool" :class="'ac-tool-' + tc.status">
                  <div class="ac-tool-head" @click="toggleTool(i, j)">
                    <i class="fa" :class="toolIcon(tc.status)"></i>
                    <span class="ac-tool-name">{{ tc.name }}</span>
                    <span v-if="tc.endTime" class="ac-tool-time">{{ (tc.endTime - tc.startTime) / 1000 }}s</span>
                    <i class="fa fa-chevron-down ac-tool-toggle"></i>
                  </div>
                  <div v-if="toolOpen[i + ':' + j]" class="ac-tool-detail">
                    <div class="ac-tool-label">{{ isZh ? '参数' : 'Args' }}</div>
                    <pre class="ac-json scoll">{{ pretty(tc.args) }}</pre>
                    <div v-if="tc.status !== 'running'" class="ac-tool-label">{{ tc.status === 'success' ? (isZh ? '结果' : 'Result') : (isZh ? '错误' : 'Error') }}</div>
                    <pre v-if="tc.status === 'success'" class="ac-json ac-result scoll">{{ pretty(tc.result) }}</pre>
                    <pre v-else-if="tc.status === 'error'" class="ac-json ac-error-text">{{ tc.error }}</pre>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- 非 agent 任务详情 -->
          <template v-else-if="selectedJob">
            <div class="ac-job">
              <div class="ac-job-head">
                <span class="ac-badge" :class="badgeClass(selectedJob.status)">{{ statusTextOf(selectedJob.status) }}</span>
                <span class="ac-job-kind">{{ selectedJob.kind }}</span>
              </div>
              <div class="ac-job-title">{{ selectedJob.title }}</div>
              <div class="ac-job-row"><span class="ac-job-label">{{ isZh ? '任务 ID' : 'Job ID' }}</span><span class="ac-job-value">{{ selectedJob.id }}</span></div>
              <div v-if="selectedJob.progress !== null" class="ac-job-row">
                <span class="ac-job-label">{{ isZh ? '进度' : 'Progress' }}</span>
                <div class="ac-row-bar ac-job-progress"><div class="ac-row-bar-fill" :style="{ width: selectedJob.progress + '%' }"></div></div>
              </div>
              <div v-if="selectedJob.detail" class="ac-job-row"><span class="ac-job-label">{{ isZh ? '详情' : 'Detail' }}</span><span class="ac-job-value">{{ selectedJob.detail }}</span></div>
              <div v-if="selectedJob.error" class="ac-job-error"><i class="fa fa-exclamation-triangle"></i> {{ selectedJob.error }}</div>
              <div v-if="selectedJob.result" class="ac-job-row">
                <span class="ac-job-label">{{ isZh ? '结果' : 'Result' }}</span>
                <pre class="ac-json scoll">{{ pretty(selectedJob.result) }}</pre>
              </div>
            </div>
          </template>

          <div v-else class="ac-empty">
            <i class="fa fa-hand-o-right"></i>
            <p>{{ isZh ? '从左侧选择一个任务查看详情' : 'Select a task on the left to view details' }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import { agentBridge, type AgentSessionView } from '@/platform/agentBridge'
import type { JobInfo } from '../../../electron/main/job-registry'

const props = defineProps<{ sessionId?: string }>()

const store = usestore()
const isZh = computed(() => store.locales !== 'en')

// ---- agent 会话（agentBridge 实时视图；按会话聚合，一个会话一行） ----
const sessions = ref<AgentSessionView[]>([])
// ---- 后台任务（job-registry；agent 任务已按会话聚合，这里只保留非 agent 任务） ----
const jobs = ref<JobInfo[]>([])

// ---- 选中与详情交互 ----
const selectedKey = ref('')
const answerInput = ref('')
const steerInput = ref('')
const injectInput = ref('')
const toolOpen = ref<Record<string, boolean>>({})

let unsubAgent: (() => void) | null = null
let unsubJobs: (() => void) | null = null
/** 会话列表轮询定时器（新建的智能体可能没有任何事件 → 靠轮询补齐） */
let pollTimer: ReturnType<typeof setInterval> | null = null

// ====== 统一任务行（agent 会话 + 非 agent 任务） ======
interface TaskRow {
  key: string
  kind: string
  isAgent: boolean
  agentId?: string
  jobId?: string
  title: string
  status: string
  progress: number | null
  detail?: string
  error?: string
  updatedAt: number
}

const taskRows = computed<TaskRow[]>(() => {
  const rows: TaskRow[] = []
  for (const s of sessions.value) {
    rows.push({
      key: 'agent:' + s.id,
      kind: 'agent',
      isAgent: true,
      agentId: s.id,
      title: s.label || s.id.slice(0, 18),
      status: s.status,
      progress: null,
      detail: s.status === 'running' ? `T${s.turn}·S${s.step} · ${s.steps.length} ${isZh.value ? '步' : 'steps'}` : undefined,
      error: s.lastError,
      updatedAt: Date.now(),
    })
  }
  for (const j of jobs.value) {
    if (j.kind === 'agent') continue
    rows.push({
      key: 'job:' + j.id,
      kind: j.kind,
      isAgent: false,
      jobId: j.id,
      title: j.title,
      status: j.status,
      progress: j.progress,
      detail: j.detail,
      error: j.error,
      updatedAt: j.updatedAt,
    })
  }
  // 排序：运行中优先，其次按最近更新倒序
  const rank = (s: string): number => (s === 'running' ? 0 : s === 'stopping' ? 1 : s === 'error' ? 2 : 3)
  rows.sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt)
  return rows
})

const selectedSession = computed<AgentSessionView | null>(() => {
  if (!selectedKey.value.startsWith('agent:')) return null
  const id = selectedKey.value.slice('agent:'.length)
  return sessions.value.find((s) => s.id === id) || null
})
const selectedJob = computed<JobInfo | null>(() => {
  if (!selectedKey.value.startsWith('job:')) return null
  const id = selectedKey.value.slice('job:'.length)
  return jobs.value.find((j) => j.id === id) || null
})

function selectTask(row: TaskRow): void {
  selectedKey.value = row.key
  answerInput.value = ''
  toolOpen.value = {}
}

function rowIcon(row: TaskRow): string {
  if (row.isAgent) {
    const map: Record<string, string> = { idle: 'fa-circle-o', running: 'fa-spinner fa-spin', stopping: 'fa-hourglass-half', disposed: 'fa-times-circle' }
    return map[row.status] || 'fa-circle-o'
  }
  const map: Record<string, string> = { running: 'fa-circle-o-notch fa-spin', completed: 'fa-check-circle', cancelled: 'fa-ban', error: 'fa-times-circle' }
  return map[row.status] || 'fa-circle-o'
}

function statusTextOf(status: string): string {
  const map: Record<string, string> = {
    idle: isZh.value ? '空闲' : 'Idle',
    running: isZh.value ? '执行中' : 'Running',
    stopping: isZh.value ? '停止中' : 'Stopping',
    disposed: isZh.value ? '已销毁' : 'Disposed',
    completed: isZh.value ? '完成' : 'Done',
    cancelled: isZh.value ? '已取消' : 'Cancelled',
    error: isZh.value ? '出错' : 'Error',
  }
  return map[status] || status
}

function badgeClass(status: string): string {
  const map: Record<string, string> = {
    idle: 'ac-badge-idle',
    running: 'ac-badge-running',
    stopping: 'ac-badge-stopping',
    disposed: 'ac-badge-disposed',
    completed: 'ac-badge-disposed',
    cancelled: 'ac-badge-disposed',
    error: 'ac-badge-error',
  }
  return map[status] || 'ac-badge-idle'
}

// ====== 数据刷新 ======
async function refreshSessions(): Promise<void> {
  if (!agentBridge.available) return
  sessions.value = await agentBridge.refreshAll()
}
async function refreshJobs(): Promise<void> {
  if (!window.dsh?.jobs) return
  try {
    jobs.value = (await window.dsh.jobs.list()) || []
  } catch {
    jobs.value = []
  }
}
async function onRefresh(): Promise<void> {
  await Promise.all([refreshSessions(), refreshJobs()])
}
/** 窗口重新获得焦点：立即拉一次最新会话（切回设置窗口不用等轮询） */
function onWindowFocus(): void {
  void refreshSessions()
  void refreshJobs()
}

// ====== 取消 / 销毁 ======
async function onCancelRow(row: TaskRow): Promise<void> {
  if (row.isAgent && row.agentId) await agentBridge.cancel(row.agentId, 'user')
  else if (row.jobId && window.dsh?.jobs) await window.dsh.jobs.cancel(row.jobId, 'user')
}
async function onCancel(): Promise<void> {
  if (selectedSession.value) await agentBridge.cancel(selectedSession.value.id, 'user')
}
async function onDispose(): Promise<void> {
  if (selectedSession.value) await agentBridge.dispose(selectedSession.value.id)
  await refreshSessions()
}

// ====== 详情交互（ask_user / steer / inject） ======
async function onAnswer(): Promise<void> {
  const v = selectedSession.value
  if (!v?.pendingQuestion || !answerInput.value.trim()) return
  await agentBridge.answer(v.id, v.pendingQuestion.askId, answerInput.value.trim())
  answerInput.value = ''
}
async function onSteer(): Promise<void> {
  const v = selectedSession.value
  if (!v || !steerInput.value.trim()) return
  // 转向/引导只在会话执行中受理（下一个 step 边界消费）；空闲时主进程会拒绝，
  // 避免被驱动器当成「新任务」另开一轮
  const ok = await agentBridge.steer(v.id, steerInput.value.trim())
  if (!ok) {
    ElMessage.warning(store.locales == 'zh'
      ? '该会话当前未在执行（本轮已结束）：转向输入未投递'
      : 'This session is not running (turn ended): steer not delivered')
    return
  }
  steerInput.value = ''
}
async function onInject(): Promise<void> {
  const v = selectedSession.value
  if (!v || !injectInput.value.trim()) return
  await agentBridge.inject(v.id, injectInput.value.trim())
  injectInput.value = ''
}

// ====== agent 详情状态 ======
const statusText = computed(() => statusTextOf(selectedSession.value?.status || 'idle'))
const statusIcon = computed(() => {
  const map: Record<string, string> = { idle: 'fa-circle-o', running: 'fa-spinner fa-spin', stopping: 'fa-hourglass-half', disposed: 'fa-times-circle' }
  return map[selectedSession.value?.status || 'idle'] || 'fa-circle-o'
})

// ====== 工具函数 ======
function short(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
function pretty(v: any): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
function duration(step: { startTime: number; endTime?: number }): string {
  const end = step.endTime || Date.now()
  const ms = end - step.startTime
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}
function stepEnded(step: { endTime?: number }): boolean {
  return !!step.endTime
}
function todoIcon(status: string): string {
  return { pending: 'fa-circle-o', running: 'fa-spinner fa-spin', done: 'fa-check-circle-o', cancelled: 'fa-ban' }[status] || 'fa-circle-o'
}
function toolIcon(status: string): string {
  return { running: 'fa-spinner fa-spin', success: 'fa-check', error: 'fa-exclamation-triangle' }[status] || 'fa-circle-o'
}
function toggleTool(i: number, j: number): void {
  toolOpen.value[`${i}:${j}`] = !toolOpen.value[`${i}:${j}`]
}

onMounted(async () => {
  unsubAgent = agentBridge.on((v) => {
    const idx = sessions.value.findIndex((s) => s.id === v.id)
    if (idx >= 0) sessions.value[idx] = v
    else sessions.value.push(v)
  })
  if (window.dsh?.jobs) {
    unsubJobs = window.dsh.jobs.onEvent(() => refreshJobs())
  }
  await refreshSessions()
  await refreshJobs()
  // 轮询补齐：会话可能在别的窗口（主窗口）被创建、且创建后暂时没有任何事件（例如刚建好还在空闲），
  // 单靠事件无法发现 → 定时拉一次会话列表（主进程 agent:list，很轻；已知会话不会被重复 restore）。
  // 窗口重新获得焦点时也立即刷一次（切回设置窗口立刻是最新状态）。
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return
    void refreshSessions()
    void refreshJobs()
  }, 3000)
  window.addEventListener('focus', onWindowFocus)
  if (props.sessionId) {
    selectedKey.value = 'agent:' + props.sessionId
    const s = agentBridge.get(props.sessionId) || (await agentBridge.restore(props.sessionId))
    if (s) {
      const idx = sessions.value.findIndex((x) => x.id === s.id)
      if (idx >= 0) sessions.value[idx] = s
      else sessions.value.push(s)
    }
  } else if (!selectedKey.value && sessions.value.length > 0) {
    selectedKey.value = 'agent:' + sessions.value[sessions.value.length - 1].id
  }
})
onBeforeUnmount(() => {
  unsubAgent?.()
  unsubJobs?.()
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  window.removeEventListener('focus', onWindowFocus)
})
</script>

<style scoped>
.agent-console {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 13px;
}
/* 执行中心：主从布局占满整个面板 */
.ac-exec { display: flex; flex-direction: column; flex: 1; min-height: 0; }

/* ====== 执行中心头部 ====== */
.ac-exec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--borderColor);
  background: var(--menuColor);
  flex-shrink: 0;
}
.ac-exec-title { font-weight: 600; white-space: nowrap; }
.ac-exec-head .ac-actions { margin-left: auto; }

/* ====== 主从布局 ====== */
.ac-split { display: flex; flex: 1; min-height: 0; }
.ac-master {
  width: 240px; flex-shrink: 0;
  border-right: 1px solid var(--borderColor);
  overflow-y: auto;
  padding: 4px;
  display: flex; flex-direction: column; gap: 3px;
}
.ac-detail { flex: 1; min-width: 0; overflow-y: auto; }

/* ====== 任务列表行（按会话聚合） ====== */
.ac-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 5px 6px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  cursor: pointer; transition: all .12s;
}
.ac-row:hover { border-color: var(--fontActiveColor); }
.ac-row.active { border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent); }
.ac-row-running { border-left: 3px solid #409eff; }
.ac-row-stopping { border-left: 3px solid #d46b08; }
.ac-row-error { border-left: 3px solid #cf1322; }
.ac-row-completed, .ac-row-cancelled, .ac-row-disposed { opacity: 0.6; }
.ac-row-icon { color: var(--fontColor); font-size: 12px; flex-shrink: 0; }
.ac-row-running .ac-row-icon { color: #0958d9; }
.ac-row-error .ac-row-icon { color: #cf1322; }
.ac-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ac-row-title { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-row-meta { font-size: 10px; opacity: 0.6; }
.ac-row-bar { width: 100%; height: 3px; background: var(--borderColor); border-radius: 2px; overflow: hidden; }
.ac-row-bar-fill { height: 100%; background: #409eff; border-radius: 2px; transition: width .3s; }
.ac-btn-mini { padding: 1px 6px; font-size: 10px; }

/* ====== 非 agent 任务详情 ====== */
.ac-job { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.ac-job-head { display: flex; align-items: center; gap: 8px; }
.ac-job-kind { font-size: 11px; opacity: 0.7; background: color-mix(in srgb, var(--fontColor) 8%, transparent); border-radius: 3px; padding: 1px 6px; }
.ac-job-title { font-size: 14px; font-weight: 600; }
.ac-job-row { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; }
.ac-job-label { flex-shrink: 0; opacity: 0.6; min-width: 48px; }
.ac-job-value { word-break: break-all; }
.ac-job-progress { flex: 1; margin-top: 5px; }
.ac-job-error { display: flex; align-items: center; gap: 6px; color: #cf1322; font-size: 12px; }

/* ====== 通用操作按钮 ====== */
.ac-actions { margin-left: auto; display: flex; gap: 4px; flex-shrink: 0; }
.ac-btn {
  border: 1px solid var(--borderColor);
  background: transparent;
  color: var(--fontColor);
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
}
.ac-btn-danger { color: #e74c3c; border-color: rgba(231, 76, 60, 0.55); }
.ac-btn-danger:hover { background: rgba(231, 76, 60, 0.12); border-color: #e74c3c; }
.ac-btn:hover:not(:disabled) { background: var(--menuActiveColor); }
.ac-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ac-btn-primary { background: #409eff; border-color: #409eff; color: #fff; }
.ac-hint { color: #888; font-size: 12px; white-space: nowrap; flex-shrink: 0; }

.ac-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: #888; padding: 20px; text-align: center; }
.ac-empty i { font-size: 32px; }
.ac-statusbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--borderColor); flex-wrap: wrap; }
.ac-badge { padding: 1px 8px; border-radius: 10px; font-size: 12px; }
.ac-badge-idle { background: #eef; color: #446; }
.ac-badge-running { background: #e6f4ff; color: #0958d9; }
.ac-badge-stopping { background: #fff7e6; color: #d46b08; }
.ac-badge-disposed { background: #f0f0f0; color: #888; }
.ac-badge-inbox { background: #f6ffed; color: #389e0d; }
.ac-badge-error { background: #fff1f0; color: #cf1322; }
.ac-meta { color: #666; font-size: 12px; }
.ac-error { color: #cf1322; font-size: 12px; }
.ac-question { margin: 8px 12px; padding: 8px; border: 1px solid #ffd591; background: #fff7e6; border-radius: 6px; }
.ac-question-text { margin-bottom: 6px; color: #d46b08; }
.ac-question-row { display: flex; gap: 6px; }
.ac-steer-row { display: flex; gap: 5px; padding: 5px; border-bottom: 1px solid var(--borderColor); }
.ac-input {
  flex: 1;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  padding: 4px 8px;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
  margin: 0px;
}
/* 详情区内部：ac-body 不再自滚动（由 .ac-detail 滚动） */
.ac-detail .ac-body { flex: none; overflow: visible; padding: 4px 12px 12px; }
.ac-section-title { font-weight: 600; margin: 10px 0 6px; display: flex; align-items: center; gap: 6px; }
.ac-steps-count { font-weight: normal; color: #888; font-size: 12px; }
.ac-plan { border-left: 1px solid var(--border); background: var(--menuColor); padding: 6px 10px; border-radius: 4px; }
.ac-plan-text { white-space: pre-wrap; margin: 0; font-size: 12px; }
.ac-todos { margin-bottom: 4px; }
.ac-todo { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; }
.ac-todo-done .ac-todo-title { text-decoration: line-through; color: #888; }
.ac-todo-running { color: #0958d9; }
.ac-todo-cancelled .ac-todo-title { color: #cf1322; }
.ac-todo-detail { color: #888; font-size: 11px; }
.ac-idle-hint { color: #888; padding: 12px; text-align: center; }
.ac-step { border: 1px solid var(--borderColor); border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
.ac-step-active { border-color: #409eff; }
.ac-step-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: var(--menuColor); font-size: 12px; }
.ac-run { color: #0958d9; }
.ac-ok { color: #389e0d; }
.ac-step-no { font-weight: 600; }
.ac-step-time { margin-left: auto; color: #888; font-size: 11px; }
.ac-step-text { padding: 6px 10px; border-top: 1px dashed var(--borderColor); max-height: 200px; overflow: auto; }
.ac-step-streaming pre { color: #0958d9; }
.ac-step-text pre { white-space: pre-wrap; margin: 0; font-size: 12px; }
.ac-tool { border-top: 1px solid var(--borderColor); }
.ac-tool-head { display: flex; align-items: center; gap: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
.ac-tool-running .ac-tool-head { color: #0958d9; }
.ac-tool-success .ac-tool-head { color: #389e0d; }
.ac-tool-error .ac-tool-head { color: #cf1322; }
.ac-tool-name { font-weight: 600; }
.ac-tool-time { color: #888; font-size: 11px; }
.ac-tool-toggle { margin-left: auto; font-size: 10px; }
.ac-tool-detail { padding: 0 10px 8px; }
.ac-tool-label { color: #888; font-size: 11px; margin: 4px 0 2px; }
.ac-json { white-space: pre-wrap; word-break: break-all; margin: 0; font-size: 11px; background: var(--menuColor); padding: 6px; border-radius: 4px; max-height: 160px; overflow: auto; }
.ac-result { color: #389e0d; }
.ac-error-text { color: #cf1322; }
</style>
