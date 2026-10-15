<!-- src/components/home/ChatDockBrowser.vue
     右侧栏（dock）「浏览器」标签：把浏览器模块**嵌进侧栏**（与 DSH 一致）。

     关键点（网页区是主进程的原生 WebContentsView，不是 iframe，永远画在 DOM 之上）：
       - 主进程把网页视图挂到**主窗口**上，位置由 BrowserAgentShell 上报 .ba-main 的矩形决定
         （见 electron/main/browser-agent.ts 的 attachDock / setDockRect）；
       - 标签栏 / 地址栏 / 收藏夹 / 设置侧栏都直接复用浏览器模块自身的 UI（BrowserAgentShell embedded）；
       - 切走标签、关侧栏、主窗口弹浮层时，都必须让原生视图 setVisible(false)，否则会盖住界面。 -->
<template>
  <div class="dock-browser">
    <!-- 桌面才有浏览器 Agent；其它环境（安卓 / 纯网页）给出说明 -->
    <div v-if="!available" class="dock-browser-placeholder">
      <i class="fa fa-globe"></i>
      <div class="dock-browser-title">{{ zh ? '浏览器不可用' : 'Browser unavailable' }}</div>
      <div class="dock-browser-note">
        {{ zh
          ? '浏览器模块是桌面专属子系统（主进程 WebContentsView 承载网页）。'
          : 'The browser module is desktop-only (pages are hosted by a main-process WebContentsView).' }}
      </div>
    </div>
    <BrowserAgentShell
      v-else
      embedded
      :pane-active="!!active"
      :occluded="!!occluded"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { usestore } from '@/store'
import { hasCapability } from '@/platform'

/**
 * 浏览器壳按需加载（与 App.vue 里独立浏览器窗口的用法一致）：
 * 它是个大组件（地址栏 / 标签 / 收藏夹 / 设置侧栏），静态导入会把它整个拉进主页分块，
 * 同时让 App.vue 那处动态导入失去分包意义（Rollup 会为此告警）。
 */
const BrowserAgentShell = defineAsyncComponent(() => import('@/components/browser/BrowserAgentShell.vue'))

const props = defineProps<{
  tabId: string
  /** 本标签在侧栏里是否可见（切走的标签要把原生网页视图藏起来） */
  active?: boolean
  /** 主窗口里有浮层盖住侧栏 */
  occluded?: boolean
}>()

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const available = computed(() => hasCapability('browserAgent'))
void props
</script>

<style scoped>
.dock-browser {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--fontColor);
  font-size: 12px;
  background: var(--backgroundColor);
}
.dock-browser-placeholder {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px 18px;
  text-align: center;
}
.dock-browser-placeholder > i { font-size: 22px; opacity: 0.6; }
.dock-browser-title { font-weight: 600; }
.dock-browser-note { max-width: 320px; line-height: 1.6; opacity: 0.7; }
</style>
