<!-- src/components/browser/BrowserSettingsPage.vue
     P1：浏览器设置改成独立标签页（参照 ego-lite 的设置页）：
     左侧分组导航 + 右侧内容卡片；改动即时生效；页面操作已移到网页右键菜单。 -->
<template>
  <div class="bsp-page">
    <div class="bsp-body">
      <aside class="bsp-side">
        <button
          v-for="sec in sections"
          :key="sec.id"
          class="bsp-nav-item"
          :class="{ active: activeSection === sec.id }"
          @click="selectSection(sec.id)"
        >
          <i class="fa" :class="sec.icon"></i>
          <span>{{ zh ? sec.zh : sec.en }}</span>
        </button>
      </aside>

      <div ref="contentRef" class="bsp-content scoll" @scroll="onScroll">
        <section id="bsp-general" class="bsp-section">
          <div class="bsp-sec-head">
            <h3>{{ zh ? '常规' : 'General' }}</h3>
            <p>{{ zh ? '主页 / 新标签页 / 搜索 / 收藏夹 / 剪藏 / 顶部图标' : 'Home, new tab, search, bookmarks, clipping and toolbar icons' }}</p>
          </div>
          <div class="bsp-card bsp-card-settings">
            <BrowserSettingsPanel />
          </div>
        </section>

        <section id="bsp-behavior" class="bsp-section">
          <div class="bsp-sec-head">
            <h3>{{ zh ? '行为' : 'Behavior' }}</h3>
            <p>{{ zh ? '每会话页面预算 / 默认快照 / 下载目录' : 'Page budget, default snapshot and download folder' }}</p>
          </div>
          <div class="bsp-card bsp-card-pad">
            <BrowserBehaviorSettings />
          </div>
        </section>

        <section id="bsp-learnings" class="bsp-section">
          <div class="bsp-sec-head">
            <h3>{{ zh ? '经验' : 'Learnings' }}</h3>
            <p>{{ zh ? '站点经验（Agent 可读写的可复用操作要点）' : 'Reusable per-site notes the agent can read and write' }}</p>
          </div>
          <div class="bsp-card bsp-card-pad">
            <BrowserLearningsSettings />
          </div>
        </section>

        <section id="bsp-playbooks" class="bsp-section">
          <div class="bsp-sec-head">
            <h3>{{ zh ? 'Playbook' : 'Playbooks' }}</h3>
            <p>{{ zh ? '可执行站点流程：草稿需你查看代码并批准后，Agent 才能运行' : 'Executable site flows: review and approve drafts before the agent can run them' }}</p>
          </div>
          <div class="bsp-card bsp-card-pad">
            <BrowserPlaybooksSettings />
          </div>
        </section>

        <section id="bsp-privacy" class="bsp-section">          <div class="bsp-sec-head">
            <h3>{{ zh ? '隐私' : 'Privacy' }}</h3>
            <p>{{ zh ? '站点数据（Cookie / localStorage / IndexedDB）' : 'Site data (cookies / localStorage / IndexedDB)' }}</p>
          </div>
          <div class="bsp-card bsp-card-pad">
            <BrowserSiteDataSettings />
          </div>
          <div class="bsp-card bsp-card-pad bsp-card-gap">
            <BrowserLoginImport />
          </div>
        </section>

        <section id="bsp-cache" class="bsp-section">          <div class="bsp-sec-head">
            <h3>{{ zh ? '缓存' : 'Cache' }}</h3>
            <p>{{ zh ? '清理网页缓存不影响收藏、书签与登录' : 'Clearing web cache keeps bookmarks, saved pages and logins' }}</p>
          </div>
          <div class="bsp-card bsp-cache">
            <span class="bsp-cache-info" :title="zh ? '浏览器网页缓存占用' : 'Browser web cache usage'">
              <i class="fa fa-database"></i>
              <span>{{ cacheText }}</span>
              <span v-if="clearedText" class="bsp-cache-done">{{ clearedText }}</span>
            </span>
            <button class="bsp-btn" :disabled="cacheBusy" @click="clearCache">
              <i class="fa" :class="cacheBusy ? 'fa-spinner fa-spin' : 'fa-trash-o'"></i>
              {{ cacheBusy ? (zh ? '清理中…' : '…') : (zh ? '清理缓存' : 'Clear cache') }}
            </button>
          </div>
        </section>

        <section id="bsp-about" class="bsp-section">
          <div class="bsp-sec-head">
            <h3>{{ zh ? '关于' : 'About' }}</h3>
            <p>{{ zh ? '设置页形态参考 ego-lite：设置是浏览器里的一个标签页，而不是侧边浮层' : 'The settings page follows ego-lite: settings is a browser tab, not a side overlay' }}</p>
          </div>
          <div class="bsp-card bsp-about">
            <div class="bsp-about-row">
              <i class="fa fa-external-link"></i>
              <a href="https://github.com/citrolabs/ego-lite" target="_blank" rel="noopener">citrolabs / ego-lite</a>
              <span class="bsp-about-tag">MIT</span>
            </div>
            <div class="bsp-about-row bsp-about-tip">
              <i class="fa fa-info-circle"></i>
              <span>{{ zh ? '在网页里点右键可：在系统浏览器打开、保存整页（离线 HTML）、保存 Markdown 到知识库、另存为 PDF、检查元素等。' : 'Right-click a page for: open in system browser, save page (offline HTML), save Markdown, save as PDF, inspect element, and more.' }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usestore } from '@/store'
import { ElMessageBox } from 'element-plus'
import BrowserSettingsPanel from '@/components/browser/BrowserSettingsPanel.vue'
import BrowserBehaviorSettings from '@/components/browser/BrowserBehaviorSettings.vue'
import BrowserLearningsSettings from '@/components/browser/BrowserLearningsSettings.vue'
import BrowserPlaybooksSettings from '@/components/browser/BrowserPlaybooksSettings.vue'
import BrowserSiteDataSettings from '@/components/browser/BrowserSiteDataSettings.vue'
import BrowserLoginImport from '@/components/browser/BrowserLoginImport.vue'
import { getPlatform } from '@/platform'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const invoke = (method: string, payload?: any) =>
  getPlatform().browserAgent.call(method.replace(/^browser-agent:/, '') as any, payload)

type SectionId = 'general' | 'behavior' | 'learnings' | 'playbooks' | 'privacy' | 'cache' | 'about'
const sections: Array<{ id: SectionId; icon: string; zh: string; en: string }> = [
  { id: 'general', icon: 'fa-sliders', zh: '常规', en: 'General' },
  { id: 'behavior', icon: 'fa-mouse-pointer', zh: '行为', en: 'Behavior' },
  { id: 'learnings', icon: 'fa-lightbulb-o', zh: '经验', en: 'Learnings' },
  { id: 'playbooks', icon: 'fa-code', zh: 'Playbook', en: 'Playbooks' },
  { id: 'privacy', icon: 'fa-shield', zh: '隐私', en: 'Privacy' },
  { id: 'cache', icon: 'fa-database', zh: '缓存', en: 'Cache' },
  { id: 'about', icon: 'fa-info-circle', zh: '关于', en: 'About' },
]
const activeSection = ref<SectionId>('general')
const contentRef = ref<HTMLElement | null>(null)

const selectSection = (id: SectionId) => {
  activeSection.value = id
  const el = document.getElementById(`bsp-${id}`)
  if (el && contentRef.value) {
    const top = el.offsetTop - 8
    contentRef.value.scrollTo({ top, behavior: 'smooth' })
  }
}
const onScroll = () => {
  const host = contentRef.value
  if (!host) return
  const y = host.scrollTop + 24
  let current: SectionId = 'general'
  for (const sec of sections) {
    const el = document.getElementById(`bsp-${sec.id}`)
    if (el && el.offsetTop <= y) current = sec.id
  }
  activeSection.value = current
}

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

const refreshCache = async () => {
  const res = await invoke('browser-agent:cache-info').catch(() => null)
  cacheSize.value = res && typeof res.size === 'number' ? res.size : null
}
const clearCache = async () => {
  if (cacheBusy.value) return
  try {
    await ElMessageBox.confirm(
      zh.value ? `确定清理浏览器网页缓存吗？当前占用 ${cacheText.value}。不影响收藏与登录。` : `Clear the browser web cache? Current usage: ${cacheText.value}. Bookmarks and logins are kept.`,
      zh.value ? '清理浏览器缓存' : 'Clear browser cache',
      { confirmButtonText: zh.value ? '清理' : 'Clear', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' },
    )
  } catch { return }
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

onMounted(() => { void refreshCache() })
</script>

<style scoped>
.bsp-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--backgroundColor);
  color: var(--fontColor);
  overflow: hidden;
}

/* 顶栏 */
.bsp-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 18px;
  border-bottom: 1px solid var(--borderColor);
  background: color-mix(in srgb, var(--menuColor) 55%, var(--backgroundColor));
}
.bsp-head-icon {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: color-mix(in srgb, var(--fontActiveColor) 12%, transparent);
  color: var(--fontActiveColor);
}
.bsp-head-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.bsp-title { font-size: 14px; font-weight: 600; }
.bsp-sub { font-size: 11px; opacity: .55; }
.bsp-spacer { flex: 1; }
.bsp-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; opacity: .6; }
.bsp-live i { font-size: 6px; color: #42b883; }

/* 主体：左分组导航 + 右内容 */
.bsp-body { flex: 1; min-height: 0; display: flex; }
.bsp-side {
  flex: 0 0 160px;
  padding: 12px 8px;
  border-right: 1px solid var(--borderColor);
  background: color-mix(in srgb, var(--menuColor) 35%, var(--backgroundColor));
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bsp-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  opacity: .7;
}
.bsp-nav-item i { width: 14px; text-align: center; font-size: 12px; }
.bsp-nav-item:hover { opacity: 1; background: color-mix(in srgb, var(--fontColor) 6%, transparent); }
.bsp-nav-item.active {
  opacity: 1;
  color: var(--fontActiveColor);
  background: color-mix(in srgb, var(--fontActiveColor) 10%, transparent);
  font-weight: 600;
}

.bsp-content { flex: 1; min-width: 0; overflow: auto; padding: 14px 22px 28px; }
/* 宽屏不再把设置内容限制在 820px：卡片随内容区铺满，右侧不留整块空白 */
.bsp-section { width: 100%; max-width: none; margin-bottom: 22px; }
.bsp-sec-head { margin: 2px 0 8px; }
.bsp-sec-head h3 { margin: 0 0 3px; font-size: 13px; font-weight: 600; }
.bsp-sec-head p { margin: 0; font-size: 11px; line-height: 1.5; opacity: .55; }
.bsp-card {
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  background: color-mix(in srgb, var(--fontColor) 2.5%, transparent);
}
.bsp-card-settings { padding: 12px 14px; }
.bsp-card-pad { padding: 10px 14px; }
.bsp-card-gap { margin-top: 8px; }
.bsp-cache { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; }
.bsp-cache-info { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; }
.bsp-cache-info i { color: var(--fontActiveColor); }
.bsp-cache-done { color: #42b883; font-size: 11px; }
.bsp-btn {
  height: 26px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
}
.bsp-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.bsp-btn:disabled { opacity: .5; cursor: default; }

.bsp-about { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.bsp-about-row { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.bsp-about-row i { color: var(--fontActiveColor); }
.bsp-about-row a { color: var(--fontActiveColor); text-decoration: none; }
.bsp-about-row a:hover { text-decoration: underline; }
.bsp-about-tag { font-size: 10px; opacity: .5; border: 1px solid var(--borderColor); border-radius: 3px; padding: 0 4px; }
.bsp-about-tip { align-items: flex-start; line-height: 1.6; opacity: .65; }
.bsp-about-tip i { margin-top: 2px; }

@media (max-width: 620px) {
  .bsp-side { flex: 0 0 46px; padding: 10px 4px; }
  .bsp-nav-item { justify-content: center; padding: 0; }
  .bsp-nav-item span { display: none; }
  .bsp-content { padding: 12px 12px 22px; }
}
</style>
