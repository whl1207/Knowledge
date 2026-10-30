<!-- src/components/home/ShellJobsBadge.vue
     主页顶栏的「后台命令」入口：显示正在跑 / 刚结束的后台 shell 任务（run_in_background 或
     前台超时转后台），点开可看尾部输出并停止。
     数据来自主进程 `shell-jobs:list`（只读，不消费模型侧 job_output 的游标）。 -->
<template>
  <div v-if="jobs.length" ref="rootRef" class="sj-root">
    <button
      class="sj-toggle"
      :class="{ active: open }"
      :title="zh ? '后台命令：查看 / 停止' : 'Background commands: view / stop'"
      @click="toggle"
    >
      <i class="fa" :class="runningCount ? 'fa-spinner fa-spin' : 'fa-tasks'"></i>
      <span class="sj-count">{{ runningCount || jobs.length }}</span>
    </button>

    <div v-if="open" class="sj-panel">
      <div class="sj-head">
        <span>{{ zh ? '后台命令' : 'Background commands' }}</span>
        <span class="sj-head-sub">{{ runningCount ? (zh ? `${runningCount} 个运行中` : `${runningCount} running`) : (zh ? '全部结束' : 'all done') }}</span>
      </div>
      <div class="sj-list scoll">
        <div v-for="job in jobs" :key="job.id" class="sj-job">
          <div class="sj-row">
            <i class="fa sj-dot" :class="dotClass(job)"></i>
            <span class="sj-cmd" :title="job.command">{{ job.description || job.command }}</span>
            <span class="sj-meta">{{ statusText(job) }}</span>
            <button v-if="job.status === 'running'" class="sj-btn stop" @click.stop="stop(job)">
              {{ zh ? '停止' : 'Stop' }}
            </button>
            <button v-else class="sj-btn" @click.stop="dismiss(job)">
              {{ zh ? '清除' : 'Clear' }}
            </button>
          </div>
          <pre v-if="job.output" class="sj-out">{{ tail(job.output) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usestore } from '@/store'
import { getPlatform } from '@/platform'
import type { ShellJobUi } from '@/platform/contract'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const jobs = ref<ShellJobUi[]>([])
const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)

let timer: ReturnType<typeof setInterval> | null = null
let busy = false

const runningCount = computed(() => jobs.value.filter((j) => j.status === 'running').length)

async function refresh(): Promise<void> {
  if (busy || typeof document !== 'undefined' && document.hidden) return
  busy = true
  try {
    const res = await getPlatform().app.listShellJobs()
    if (res?.ok) jobs.value = Array.isArray(res.jobs) ? res.jobs : []
  } catch {
    /* 平台不支持（网页 / 安卓）：静默 */
  } finally {
    busy = false
  }
}

function toggle(): void {
  open.value = !open.value
  if (open.value) void refresh()
}

async function stop(job: ShellJobUi): Promise<void> {
  try {
    await getPlatform().app.killShellJob(job.id)
  } catch { /* 忽略 */ }
  void refresh()
}

async function dismiss(job: ShellJobUi): Promise<void> {
  try {
    await getPlatform().app.dismissShellJob(job.id)
  } catch { /* 忽略 */ }
  void refresh()
}

function dotClass(job: ShellJobUi): string {
  if (job.status === 'running') return 'fa-circle sj-running'
  if (job.status === 'error') return 'fa-circle sj-error'
  return job.exitCode ? 'fa-circle sj-warn' : 'fa-check-circle sj-done'
}

function statusText(job: ShellJobUi): string {
  if (job.status === 'running') return `${Math.max(1, Math.round((Date.now() - job.startedAt) / 1000))}s`
  if (job.signal) return zh.value ? `已终止（${job.signal}）` : `killed (${job.signal})`
  if (typeof job.exitCode === 'number' && job.exitCode !== 0) return `exit ${job.exitCode}`
  return zh.value ? '完成' : 'done'
}

/** 只显示最后 12 行，避免把面板撑爆 */
function tail(text: string): string {
  const lines = String(text || '').replace(/\s+$/, '').split(/\r?\n/)
  return lines.length <= 12 ? lines.join('\n') : '…\n' + lines.slice(-12).join('\n')
}

function onDocClick(e: MouseEvent): void {
  if (!open.value) return
  const el = rootRef.value
  if (el && e.target instanceof Node && el.contains(e.target)) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  void refresh()
  timer = setInterval(() => { void refresh() }, 1500)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  if (timer) clearInterval(timer)
  timer = null
})
</script>

<style scoped>
.sj-root { position: relative; display: inline-flex; align-items: center; }

.sj-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--fontColor, #666);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}
.sj-toggle:hover,
.sj-toggle.active { background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent); color: var(--fontActiveColor); }
.sj-count { font-variant-numeric: tabular-nums; }

.sj-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 460px;
  max-width: min(80vw, 460px);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  background: var(--panelColor, var(--backgroundColor, #fff));
  border: 1px solid color-mix(in srgb, var(--fontColor) 18%, transparent);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  z-index: 3000;
  overflow: hidden;
}

.sj-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid color-mix(in srgb, var(--fontColor) 10%, transparent);
}
.sj-head-sub { font-weight: 400; opacity: .6; }

.sj-list { overflow: auto; padding: 4px 0; }
.sj-job { padding: 6px 10px; border-bottom: 1px dashed color-mix(in srgb, var(--fontColor) 8%, transparent); }
.sj-job:last-child { border-bottom: none; }

.sj-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.sj-dot { font-size: 8px; flex: none; }
.sj-running { color: #1971c2; }
.sj-done { color: #2f9e44; }
.sj-warn { color: #e8590c; }
.sj-error { color: #e03131; }
.sj-cmd { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; }
.sj-meta { flex: none; opacity: .6; font-variant-numeric: tabular-nums; }

.sj-btn {
  flex: none;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--fontColor) 20%, transparent);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.sj-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
.sj-btn.stop:hover { border-color: #e03131; color: #e03131; }

.sj-out {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: color-mix(in srgb, var(--fontColor) 6%, transparent);
  border-radius: 6px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
  opacity: .85;
}
</style>
