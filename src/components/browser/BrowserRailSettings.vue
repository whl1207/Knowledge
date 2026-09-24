<!-- src/components/browser/BrowserRailSettings.vue
     浏览器右侧停靠栏「设置」面板（独立模块，从 BrowserAgentShell 分离）：
       - 当前标签 AI 状态行（浏览 / AI / 操作中）
       - 页面操作：在系统浏览器打开 / 保存整页 / 回收 AI 会话标签 / 控制台
       - AI 控制：允许执行 JS（browser_eval）开关
       - 浏览器设置（BrowserSettingsPanel：默认页面 / 保存文件夹）
       - 缓存管理：显示浏览器缓存大小 + 一键清理（主进程 browser-agent:cache-info / clear-cache）
     面板状态/动作经 props 注入；缓存信息自行经 IPC 查询（active 变为 true 时自动刷新）。 -->
<template>
  <div class="browser-rail-settings">
    <!-- 当前标签的 AI 状态（跟随激活标签：浏览 / AI / 操作中） -->
    <div class="ba-rail-agent" :class="chip.cls" :title="chip.title">
      <i class="fa" :class="chip.icon"></i>
      <span>{{ chip.text }}</span>
    </div>

    <!-- 页面操作 -->
    <div class="ba-rail-sec">{{ zh ? '页面操作' : 'Page actions' }}</div>
    <button class="ba-rail-row" :disabled="!url" :title="zh ? '用系统默认浏览器打开当前页' : 'Open current page in the system browser'" @click="onOpenExternal?.()">
      <i class="fa fa-external-link"></i>
      <span>{{ zh ? '在系统浏览器打开' : 'Open in system browser' }}</span>
    </button>
    <button class="ba-rail-row" :disabled="!url" :title="zh ? '整体保存当前页（含图片/样式等资源），存到「浏览器设置 → 保存文件夹」' : 'Save current page with resources into the browser save folder'" @click="onSavePage?.('full')">
      <i class="fa fa-download"></i>
      <span>{{ zh ? '保存整页（离线 HTML）' : 'Save full page (offline HTML)' }}</span>
    </button>
    <button class="ba-rail-row" :title="zh ? '回收 AI 会话产生的标签页（保留正在查看的标签）' : 'Recycle AI session tabs (keep the one you are viewing)'" @click="onRecycle?.()">
      <i class="fa fa-eraser"></i>
      <span>{{ zh ? '回收 AI 会话标签' : 'Recycle AI session tabs' }}</span>
    </button>
    <button class="ba-rail-row" :title="zh ? '打开当前页的开发者控制台（DevTools）' : 'Open DevTools for the current page'" @click="onDevtools?.()">
      <i class="fa fa-terminal"></i>
      <span>{{ zh ? '控制台（DevTools）' : 'Console (DevTools)' }}</span>
    </button>

    <!-- AI 控制 -->
    <div class="ba-rail-sec">{{ zh ? 'AI 控制' : 'AI control' }}</div>
    <div class="ba-rail-switch-row"
      :title="zh ? (allowEval ? '已允许 AI 调用 browser_eval 执行任意 JS（点击关闭）' : '允许 AI 调用 browser_eval 在页面中执行任意 JavaScript（默认关闭，点击开启）') : (allowEval ? 'Allow browser_eval (arbitrary JS) - click to disable' : 'Allow AI to call browser_eval (arbitrary JS on the page) - click to enable')">
      <div class="ba-rail-switch-info">
        <span class="ba-rail-switch-name">{{ zh ? '允许执行 JS' : 'Allow JavaScript' }}</span>
        <span class="ba-rail-switch-desc">{{ zh ? 'browser_eval（默认关闭，风险操作）' : 'browser_eval (off by default, risky)' }}</span>
      </div>
      <div class="ba-rail-switch" :class="{ on: allowEval }" @click="onToggleEval?.(!allowEval)">
        <span class="ba-rail-switch-knob"></span>
      </div>
    </div>

    <!-- 浏览器设置（默认页面 / 保存文件夹） -->
    <div class="ba-rail-sec">{{ zh ? '浏览器设置' : 'Browser settings' }}</div>
    <div class="ba-rail-settings">
      <BrowserSettingsPanel compact />
    </div>

    <!-- 缓存管理：左侧缓存大小 + 右侧清理按钮（说明放 title，紧凑一行） -->
    <div class="ba-rail-sec">{{ zh ? '缓存管理' : 'Cache' }}</div>
    <div class="ba-rail-cache"
      :title="zh ? '浏览器网页缓存占用大小；清理不影响收藏、书签与登录，清理后刷新页面即重新加载资源。' : 'Browser web cache usage; clearing keeps bookmarks & logins; refresh pages afterwards.'">
      <span class="ba-rail-cache-info">
        <i class="fa fa-database"></i>
        <span class="ba-rail-cache-size">{{ cacheText }}</span>
        <span v-if="clearedText" class="ba-rail-cache-done">{{ clearedText }}</span>
      </span>
      <button class="ba-rail-cache-btn" :disabled="cacheBusy" @click="doClearCache"
        :title="zh ? '清理浏览器网页缓存' : 'Clear browser web cache'">
        <i class="fa" :class="cacheBusy ? 'fa-spinner fa-spin' : 'fa-trash-o'"></i>
        {{ cacheBusy ? (zh ? '清理中…' : '…') : (zh ? '清理' : 'Clear') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { usestore } from '@/store'
import BrowserSettingsPanel from '@/components/browser/BrowserSettingsPanel.vue'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

export interface ChipInfo { cls: string; icon: string; text: string; title: string }

const props = withDefaults(defineProps<{
  chip: ChipInfo
  url: string
  allowEval: boolean
  /** 面板是否可见（= 停靠栏展开且为设置视图）；变为 true 时刷新缓存大小 */
  active?: boolean
  onOpenExternal?: () => void
  onSavePage?: (mode: 'link' | 'full') => void
  onRecycle?: () => void
  onDevtools?: () => void
  onToggleEval?: (v: boolean) => void
}>(), {
  chip: () => ({ cls: 'plain', icon: 'fa-globe', text: '', title: '' }),
  url: '',
  allowEval: false,
  active: false,
})

// ===== 缓存管理 =====
const invoke = (channel: string, payload?: any) =>
  window.ipcRenderer?.invoke ? window.ipcRenderer.invoke(channel, payload) : Promise.resolve(null)

const cacheBusy = ref(false)
const cacheSize = ref<number | null>(null)
const clearedText = ref('')

const formatBytes = (n: number) => {
  if (!Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
const cacheText = computed(() => cacheSize.value == null ? (zh.value ? '读取中…' : '…') : formatBytes(cacheSize.value))

const refreshCacheInfo = async () => {
  const res = await invoke('browser-agent:cache-info').catch(() => null)
  cacheSize.value = res && typeof res.size === 'number' ? res.size : null
}
const doClearCache = async () => {
  if (cacheBusy.value) return
  cacheBusy.value = true
  clearedText.value = ''
  const res = await invoke('browser-agent:clear-cache').catch(() => null)
  if (res?.ok) {
    cacheSize.value = typeof res.size === 'number' ? res.size : null
    clearedText.value = zh.value ? '已清理 ✓' : 'Cleared ✓'
  } else {
    clearedText.value = zh.value ? '清理失败' : 'Failed'
  }
  cacheBusy.value = false
  window.setTimeout(() => { clearedText.value = '' }, 2500)
}

// 打开设置面板时刷新缓存大小
watch(() => props.active, (v) => {
  if (v) { clearedText.value = ''; void refreshCacheInfo() }
})
onMounted(() => { void refreshCacheInfo() })
</script>

<style scoped>
.browser-rail-settings {
  display: flex;
  flex-direction: column;
}
/* 当前标签 AI 状态行 */
.ba-rail-agent {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  font-size: 12px;
  color: var(--fontColor);
  border: 1px solid var(--borderColor);
  background: color-mix(in srgb, var(--fontColor) 5%, transparent);
  margin-bottom: 10px;
  white-space: nowrap;
  overflow: hidden;
}
.ba-rail-agent.plain { opacity: .55; }
.ba-rail-agent.agent {
  color: var(--fontActiveColor);
  border-color: color-mix(in srgb, var(--fontActiveColor) 40%, transparent);
  background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent);
}
.ba-rail-agent.active {
  color: #fff;
  border-color: transparent;
  background: var(--fontActiveColor);
  box-shadow: 0 0 8px color-mix(in srgb, var(--fontActiveColor) 55%, transparent);
}
/* 分组标题 */
.ba-rail-sec {
  margin: 12px 2px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fontColor);
  opacity: .55;
  letter-spacing: .5px;
}
/* 操作行按钮 */
.ba-rail-row {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  margin-bottom: 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background .12s;
}
.ba-rail-row i { width: 16px; text-align: center; color: var(--fontActiveColor); font-size: 13px; opacity: .85; }
.ba-rail-row:hover { background: color-mix(in srgb, var(--fontColor) 7%, transparent); }
.ba-rail-row:disabled { opacity: .35; cursor: default; }
.ba-rail-row:disabled:hover { background: transparent; }
/* 开关行（允许执行 JS） */
.ba-rail-switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: color-mix(in srgb, var(--fontColor) 3%, transparent);
  cursor: pointer;
}
.ba-rail-switch-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ba-rail-switch-name { font-size: 13px; color: var(--fontColor); }
.ba-rail-switch-desc { font-size: 11px; color: var(--fontColor); opacity: .55; line-height: 1.3; }
.ba-rail-switch {
  flex: 0 0 auto;
  width: 34px;
  height: 18px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--fontColor) 22%, transparent);
  position: relative;
  transition: background .15s;
}
.ba-rail-switch.on { background: var(--fontActiveColor); }
.ba-rail-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: left .15s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .25);
}
.ba-rail-switch.on .ba-rail-switch-knob { left: 18px; }
/* 浏览器设置（内嵌 BrowserSettingsPanel compact） */
.ba-rail-settings {
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  padding: 10px;
  background: color-mix(in srgb, var(--fontColor) 3%, transparent);
}
/* 缓存管理：左=大小，右=按钮，紧凑一行 */
.ba-rail-cache {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: color-mix(in srgb, var(--fontColor) 3%, transparent);
  min-width: 0;
}
.ba-rail-cache-info { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--fontColor); min-width: 0; }
.ba-rail-cache-info i { color: var(--fontActiveColor); font-size: 12px; flex-shrink: 0; }
.ba-rail-cache-size { font-weight: 600; white-space: nowrap; }
.ba-rail-cache-done { color: #42b883; font-size: 11px; white-space: nowrap; }
.ba-rail-cache-btn {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: transparent;
  color: var(--fontColor);
  font-size: 11px;
  cursor: pointer;
  transition: all .15s;
}
.ba-rail-cache-btn i { color: var(--fontActiveColor); font-size: 11px; }
.ba-rail-cache-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.ba-rail-cache-btn:disabled { opacity: .5; cursor: default; }
</style>
