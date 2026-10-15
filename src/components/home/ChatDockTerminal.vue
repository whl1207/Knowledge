<!-- src/components/home/ChatDockTerminal.vue
     右侧栏（dock）「终端」标签：**真 PTY 终端**（与 DSH 一样：主进程 node-pty + 渲染层 xterm.js）。

     一个「终端」标签 = 一个独立 shell 会话：
       - 键盘输入 → terminal:write；主进程输出 → terminal:data → term.write；
       - 容器尺寸变化（拖宽 / 切标签 / 窗口缩放）→ 适配后 terminal:resize；
       - 标签卸载（关标签 / 关右侧栏 / 切聊天）→ terminal:kill，不留孤儿 shell。

     环境差异：
       - 桌面（Electron）才有 PTY；安卓 / 纯网页按能力显示「当前环境不支持终端」；
       - 安全策略**不是终端的门槛**：命令由用户自己敲、结果自己看，与智能体自动执行命令的
         「安全策略」是两码事，因此「只读安全 / 工作区写入 / 完全访问」任何档位都直接可用。 -->
<template>
  <div class="dock-terminal">
    <div ref="hostEl" class="dock-terminal-host" :class="{ ready: status === 'running' }"></div>

    <!-- 不可用的两种情形：环境不支持 / 起会话或运行中断 -->
    <div v-if="overlay" class="dock-terminal-overlay">
      <i class="fa" :class="overlay.icon"></i>
      <div class="dock-terminal-title">{{ overlay.title }}</div>
      <div class="dock-terminal-note">{{ overlay.note }}</div>
      <button v-if="overlay.retry" class="dock-terminal-btn" @click="restart">
        <i class="fa fa-refresh"></i>{{ zh ? '重试' : 'Retry' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { usestore } from '@/store'
import { getPlatform, hasCapability } from '@/platform'

/** tabId：一个「终端」标签 = 一个 shell 会话 id；active：标签是否可见（可见才做尺寸适配 / 聚焦）
 *  cwd：**当前聊天自己的工作区**（空 = 回落到全局默认 store.root） */
const props = defineProps<{ tabId: string; active?: boolean; cwd?: string }>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const hostEl = ref<HTMLElement | null>(null)
const status = ref<'idle' | 'running' | 'exited' | 'error'>('idle')
const errorText = ref('')

/** 能力：桌面才有 PTY */
const unsupported = computed(() => !hasCapability('terminal'))

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let offData: (() => void) | null = null
let offExit: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let started = false

/** 遮罩：环境不支持 / 起会话失败 / 会话已退出 */
const overlay = computed(() => {
  if (unsupported.value) {
    return {
      icon: 'fa-ban', retry: false,
      title: zh.value ? '终端不可用' : 'Terminal unavailable',
      note: zh.value ? '当前环境没有本地 PTY（仅桌面版支持终端）。' : 'No local PTY here (the terminal needs the desktop build).',
    }
  }
  if (status.value === 'error') {
    return {
      icon: 'fa-exclamation-triangle', retry: true,
      title: zh.value ? '终端启动失败' : 'Failed to start the terminal',
      note: errorText.value,
    }
  }
  if (status.value === 'exited') {
    return {
      icon: 'fa-power-off', retry: true,
      title: zh.value ? '会话已结束' : 'Session ended',
      note: zh.value ? 'shell 已退出（exit / Ctrl+D，或它自己崩了）。' : 'The shell exited (exit / Ctrl+D, or it crashed).',
    }
  }
  return null
})

/** 终端配色跟随应用主题（xterm 需要真实颜色，不能直接吃 CSS 变量） */
function readTheme() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => (css.getPropertyValue(name) || '').trim() || fallback
  return {
    background: v('--backgroundColor', '#ffffff'),
    foreground: v('--fontColor', '#1f2328'),
    cursor: v('--fontActiveColor', '#03254d'),
    cursorAccent: v('--backgroundColor', '#ffffff'),
    selectionBackground: v('--menuActiveColor', '#9ec4f0'),
  }
}

function fitIfPossible(): void {
  if (!term || !fitAddon || !hostEl.value) return
  const rect = hostEl.value.getBoundingClientRect()
  if (rect.width < 20 || rect.height < 20) return // 标签不可见（display:none）时不动尺寸
  try { fitAddon.fit() } catch { /* 尺寸异常时忽略 */ }
  void getPlatform().terminal.call('resize', { id: props.tabId, cols: term.cols, rows: term.rows }).catch(() => {})
}

/** 起会话（同一个标签重复调用会先收掉旧会话） */
async function start(): Promise<void> {
  if (!term || !hostEl.value) return
  if (unsupported.value) return
  if (started) return
  started = true
  errorText.value = ''
  status.value = 'idle'
  fitIfPossible()
  const res = await getPlatform().terminal.call('create', {
    id: props.tabId,
    cols: term.cols || 80,
    rows: term.rows || 24,
    // 终端开在当前聊天的工作区里（未选过则由主进程回落到默认目录）
    cwd: String(props.cwd || store.root || ''),
  }).catch((e: any) => ({ ok: false, error: String(e?.message || e) }))

  if (!res?.ok) {
    started = false
    status.value = 'error'
    errorText.value = String(res?.error || (zh.value ? '未知错误' : 'Unknown error'))
    return
  }
  status.value = 'running'
  if (props.active) void nextTick(() => term?.focus())
}

/** 手动重开（会话退出 / 启动失败后） */
function restart(): void {
  started = false
  status.value = 'idle'
  errorText.value = ''
  try { term?.reset() } catch { /* 忽略 */ }
  void start()
}

onMounted(async () => {
  if (!hostEl.value) return
  term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, Monaco, "Courier New", monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: readTheme(),
    allowTransparency: true,
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(hostEl.value)

  // 输出 / 退出：事件按 id 过滤（同一窗口可能有多个终端标签）
  offData = getPlatform().events.on('terminal:data', (payload: any) => {
    if (String(payload?.id ?? '') !== props.tabId) return
    term?.write(String(payload?.data ?? ''))
  })
  offExit = getPlatform().events.on('terminal:exit', (payload: any) => {
    if (String(payload?.id ?? '') !== props.tabId) return
    status.value = 'exited'
  })

  // 键盘输入 → PTY（含 Ctrl+C / 方向键等控制序列）
  term.onData((data) => {
    void getPlatform().terminal.call('write', { id: props.tabId, data }).catch(() => {})
  })

  // 尺寸变化：容器（拖宽 / 折行）与标签激活都会触发
  resizeObserver = new ResizeObserver(() => fitIfPossible())
  resizeObserver.observe(hostEl.value)

  await nextTick()
  fitIfPossible()
  void start()
})

// 标签被切到前台：适配尺寸 + 聚焦（用户点开终端就能直接打字）
watch(() => props.active, async (active) => {
  if (!active) return
  if (term) term.options.theme = readTheme()
  await nextTick()
  fitIfPossible()
  if (status.value === 'running') term?.focus()
  // 标签被切回来时若还没起会话（例如之前起失败了），这里直接补起
  if (!started && !unsupported.value) void start()
})

onBeforeUnmount(() => {
  offData?.(); offData = null
  offExit?.(); offExit = null
  resizeObserver?.disconnect(); resizeObserver = null
  // 关标签 / 关右侧栏 / 切聊天：结束该会话（不留孤儿 shell）
  void getPlatform().terminal.call('kill', { id: props.tabId }).catch(() => {})
  try { term?.dispose() } catch { /* 忽略 */ }
  term = null
  fitAddon = null
})
</script>

<style scoped>
.dock-terminal {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--backgroundColor);
}
.dock-terminal-host {
  flex: 1;
  min-height: 0;
  padding: 4px 2px 2px 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.dock-terminal-host.ready { opacity: 1; }
.dock-terminal-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  text-align: center;
  background: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 12px;
}
.dock-terminal-overlay > i { font-size: 20px; opacity: 0.6; }
.dock-terminal-title { font-weight: 600; }
.dock-terminal-note { max-width: 340px; line-height: 1.6; opacity: 0.72; }
.dock-terminal-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  padding: 4px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
}
.dock-terminal-btn:hover { border-color: var(--fontActiveColor); color: var(--fontActiveColor); }
</style>
