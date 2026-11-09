<!-- src/components/home/ChatDockJobs.vue
     主页右侧栏的「后台任务」页：对齐 DSH 的 jobs 面板。
     数据来自主进程 job-registry（jobs:list / job:event）；shell 任务的输出再从
     shell-jobs:list 合并进来。只读展示 + 停止，不消费模型侧 job_output 游标。 -->
<template>
  <div class="cdj">
    <div class="cdj-head">
      <span class="cdj-title"><i class="fa fa-tasks"></i> {{ zh ? '后台任务' : 'Jobs' }}</span>
      <span class="cdj-sub">{{ runningCount ? (zh ? `${runningCount} 个运行中` : `${runningCount} running`) : (zh ? '全部结束' : 'all done') }}</span>
      <span class="cdj-spacer"></span>
      <button class="cdj-icon-btn" :title="zh ? '刷新' : 'Refresh'" @click="refresh"><i class="fa fa-refresh" :class="{ 'fa-spin': busy }"></i></button>
    </div>

    <div class="cdj-list scoll">
      <div v-if="!visibleJobs.length" class="cdj-empty">
        <i class="fa fa-inbox"></i>
        <span>{{ zh ? '暂无后台任务' : 'No background jobs' }}</span>
        <span class="cdj-empty-hint">{{ zh ? 'shell / 子代理 / 知识库构建等长任务会显示在这里' : 'Long shell / subagent / KB tasks appear here' }}</span>
      </div>

      <div v-for="job in visibleJobs" :key="job.id" class="cdj-job" :class="job.status">
        <div class="cdj-row">
          <i class="fa cdj-dot" :class="dotClass(job)"></i>
          <span class="cdj-kind">{{ kindLabel(job.kind) }}</span>
          <span class="cdj-name" :title="job.title">{{ job.title || job.id }}</span>
          <span class="cdj-meta">{{ statusText(job) }}</span>
          <button v-if="job.status === 'running'" class="cdj-btn stop" @click="stop(job)">{{ zh ? '停止' : 'Stop' }}</button>
        </div>
        <div v-if="job.progress !== null && job.progress !== undefined" class="cdj-progress">
          <i :style="{ width: Math.max(0, Math.min(100, Number(job.progress) || 0)) + '%' }"></i>
        </div>
        <div v-if="job.detail" class="cdj-detail">{{ job.detail }}</div>
        <div v-if="job.error" class="cdj-error"><i class="fa fa-exclamation-triangle"></i> {{ job.error }}</div>
        <pre v-if="outputOf(job)" class="cdj-out">{{ outputOf(job) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usestore } from '@/store'
import { getPlatform } from '@/platform'
import { aikmDsh } from '@/lib/aikmIpc'
import type { ShellJobUi } from '@/platform/contract'

interface JobInfo {
  id: string
  kind: string
  owner?: string
  title: string
  status: string
  progress?: number | null
  detail?: string
  error?: string
  result?: any
  createdAt?: number
  updatedAt?: number
}

const props = defineProps<{ active?: boolean }>()
const store = usestore()
const zh = computed(() => store.locales === 'zh')
const jobs = ref<JobInfo[]>([])
const shellJobs = ref<ShellJobUi[]>([])
const busy = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
let unsub: (() => void) | null = null

const visibleJobs = computed(() => jobs.value
  .filter(j => j.kind !== 'agent')
  .sort((a, b) => {
    const rank = (s: string) => s === 'running' ? 0 : s === 'error' ? 1 : 2
    return rank(a.status) - rank(b.status) || (b.updatedAt || 0) - (a.updatedAt || 0)
  }))
const runningCount = computed(() => visibleJobs.value.filter(j => j.status === 'running').length)

function kindLabel(kind: string): string {
  const map: Record<string, { zh: string; en: string }> = {
    shell: { zh: '命令', en: 'shell' },
    subagent: { zh: '子代理', en: 'agent' },
    'kb-build': { zh: '知识库', en: 'KB' },
    ontology: { zh: '本体', en: 'ontology' },
    swarm: { zh: '集群', en: 'swarm' },
  }
  return map[kind] ? (zh.value ? map[kind].zh : map[kind].en) : kind
}
function dotClass(job: JobInfo): string {
  if (job.status === 'running') return 'fa-circle cdj-running'
  if (job.status === 'error') return 'fa-circle cdj-error'
  if (job.status === 'cancelled') return 'fa-ban cdj-muted'
  return 'fa-check-circle cdj-done'
}
function statusText(job: JobInfo): string {
  if (job.status === 'running') {
    const elapsed = job.createdAt ? Math.max(1, Math.round((Date.now() - job.createdAt) / 1000)) : 0
    return elapsed ? `${elapsed}s` : (zh.value ? '运行中' : 'running')
  }
  if (job.status === 'cancelled') return zh.value ? '已停止' : 'stopped'
  if (job.status === 'error') return zh.value ? '失败' : 'error'
  return zh.value ? '完成' : 'done'
}
function outputOf(job: JobInfo): string {
  const shell = shellJobs.value.find(s => s.id === job.id)
  if (!shell?.output) return ''
  const lines = String(shell.output).replace(/\s+$/, '').split(/\r?\n/)
  return lines.length <= 14 ? lines.join('\n') : '…\n' + lines.slice(-14).join('\n')
}
async function refresh(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    if (aikmDsh?.jobs) jobs.value = (await aikmDsh.jobs.list()) || []
    try {
      const res = await getPlatform().app.listShellJobs()
      if (res?.ok) shellJobs.value = Array.isArray(res.jobs) ? res.jobs : []
    } catch { /* 非桌面端 */ }
  } finally {
    busy.value = false
  }
}
async function stop(job: JobInfo): Promise<void> {
  try {
    if (job.kind === 'shell') await getPlatform().app.killShellJob(job.id)
    if (aikmDsh?.jobs) await aikmDsh.jobs.cancel(job.id, 'user')
  } catch { /* ignore */ }
  void refresh()
}
function startPolling(): void {
  if (timer) return
  timer = setInterval(() => { if (props.active !== false && !document.hidden) void refresh() }, 1800)
}
function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}
watch(() => props.active, (v) => { if (v) { void refresh(); startPolling() } else stopPolling() })
onMounted(() => {
  void refresh()
  if (props.active !== false) startPolling()
  if (aikmDsh?.jobs) unsub = aikmDsh.jobs.onEvent(() => { void refresh() })
})
onBeforeUnmount(() => {
  stopPolling()
  unsub?.()
  unsub = null
})
</script>

<style scoped>
.cdj { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--backgroundColor); color: var(--fontColor); }
.cdj-head { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--borderColor); flex-shrink: 0; }
.cdj-title { font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; }
.cdj-title .fa { color: var(--fontActiveColor); }
.cdj-sub { font-size: 9px; opacity: .55; }
.cdj-spacer { flex: 1; }
.cdj-icon-btn { border: 0; background: transparent; color: var(--fontColor); opacity: .6; cursor: pointer; width: 24px; height: 24px; padding: 0; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
.cdj-icon-btn .fa { font-size: 12px; line-height: 1; }
.cdj-icon-btn:hover { opacity: 1; background: var(--menuActiveColor); }
.cdj-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px 10px; }
.cdj-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 36px 12px; color: var(--fontColor); opacity: .55; font-size: 11px; text-align: center; }
.cdj-empty .fa { font-size: 22px; opacity: .5; }
.cdj-empty-hint { font-size: 9px; opacity: .7; }
.cdj-job { padding: 7px 8px; border: 1px solid var(--borderColor); border-radius: 7px; margin-bottom: 6px; background: var(--backgroundColor); }
.cdj-job.running { border-color: color-mix(in srgb, var(--fontActiveColor) 45%, var(--borderColor)); }
.cdj-row { display: flex; align-items: center; gap: 5px; font-size: 10px; min-width: 0; }
.cdj-dot { font-size: 8px; flex: none; }
.cdj-running { color: #1971c2; }
.cdj-done { color: #2f9e44; }
.cdj-error { color: #e03131; }
.cdj-muted { color: var(--borderColor); }
.cdj-kind { flex: none; font-size: 9px; padding: 0 4px; border-radius: 3px; background: var(--menuColor); opacity: .8; }
.cdj-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.cdj-meta { flex: none; font-size: 9px; opacity: .55; font-variant-numeric: tabular-nums; }
.cdj-btn { flex: none; font-size: 9px; padding: 1px 6px; border: 1px solid var(--borderColor); border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.cdj-btn.stop:hover { border-color: #e03131; color: #e03131; }
.cdj-progress { height: 4px; margin: 6px 0 2px; border-radius: 2px; background: var(--borderColor); overflow: hidden; }
.cdj-progress i { display: block; height: 100%; background: var(--fontActiveColor); transition: width .25s; }
.cdj-detail { font-size: 9px; opacity: .6; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cdj-error { font-size: 10px; margin-top: 4px; }
.cdj-out { margin: 5px 0 0; padding: 5px 6px; border-radius: 5px; background: color-mix(in srgb, var(--fontColor) 6%, transparent); font-family: ui-monospace, Consolas, monospace; font-size: 9px; line-height: 1.45; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; opacity: .85; }
</style>
