<!-- 浏览器行为设置：页面预算 / 默认快照 / 下载目录（设置标签页的「行为」分组） -->
<template>
  <div class="bbs">
    <div class="bbs-row">
      <div class="bbs-label">
        <div class="bbs-title">{{ zh ? '每会话页面上限' : 'Pages per session' }}</div>
        <div class="bbs-desc">{{ zh ? '单个 Agent 会话最多保留的页面数，超出回收最旧页（2–20）' : 'Max pages one agent session may keep; oldest is recycled (2–20)' }}</div>
      </div>
      <div class="bbs-control">
        <input v-model.number="pageBudget" class="bbs-num" type="number" min="2" max="20" step="1" @change="apply" />
      </div>
    </div>

    <div class="bbs-row">
      <div class="bbs-label">
        <div class="bbs-title">{{ zh ? '快照默认只看可交互节点' : 'Interactive-only snapshots by default' }}</div>
        <div class="bbs-desc">{{ zh ? 'browser_snapshot 默认省略正文，只保留按钮/输入框等（省 token；单次调用可覆盖）' : 'browser_snapshot omits body text and keeps controls only (saves tokens; per-call override allowed)' }}</div>
      </div>
      <div class="bbs-control">
        <button class="bbs-switch" :class="{ on: interactiveOnly }" role="switch" :aria-checked="interactiveOnly"
          @click="interactiveOnly = !interactiveOnly; apply()">
          <span class="bbs-knob"></span>
        </button>
      </div>
    </div>

    <div class="bbs-row">
      <div class="bbs-label">
        <div class="bbs-title">{{ zh ? '下载目录' : 'Download folder' }}</div>
        <div class="bbs-desc">{{ zh ? '留空则保存到应用数据目录 browser-downloads' : 'Empty = app data browser-downloads folder' }}</div>
      </div>
      <div class="bbs-control bbs-dir">
        <input :value="downloadDir" class="bbs-input" readonly :placeholder="zh ? '默认目录' : 'Default folder'" />
        <button class="bbs-btn" @click="pickDir">{{ zh ? '选择…' : 'Choose…' }}</button>
        <button v-if="downloadDir" class="bbs-btn bbs-btn-ghost" @click="downloadDir = ''; apply()">{{ zh ? '恢复默认' : 'Reset' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { usestore } from '@/store'
import { getPlatform } from '@/platform'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const invoke = (method: string, payload?: any) =>
  getPlatform().browserAgent.call(method.replace(/^browser-agent:/, '') as any, payload)

const pageBudget = ref(Number(store.UI?.browserPageBudget) || 8)
const interactiveOnly = ref(!!store.UI?.browserSnapshotInteractiveOnly)
const downloadDir = ref(String(store.UI?.browserDownloadDir || ''))

const apply = () => {
  store.UI.browserPageBudget = Math.max(2, Math.min(20, Math.round(Number(pageBudget.value) || 8)))
  pageBudget.value = store.UI.browserPageBudget
  store.UI.browserSnapshotInteractiveOnly = !!interactiveOnly.value
  store.UI.browserDownloadDir = String(downloadDir.value || '').trim()
  store.saveConfig()
  void invoke('browser-agent:set-config', {
    pageBudget: store.UI.browserPageBudget,
    snapshotInteractiveOnly: store.UI.browserSnapshotInteractiveOnly,
    downloadDir: store.UI.browserDownloadDir,
  }).catch(() => {})
}

const pickDir = async () => {
  const res = await invoke('browser-agent:pick-download-dir').catch(() => null)
  if (res?.ok && res.path) {
    downloadDir.value = String(res.path)
    apply()
  }
}
</script>

<style scoped>
.bbs { display: flex; flex-direction: column; }
.bbs-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 11px 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--fontColor) 8%, transparent);
}
.bbs-row:last-child { border-bottom: none; }
.bbs-label { min-width: 0; }
.bbs-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.bbs-desc { font-size: 11px; line-height: 1.5; opacity: .55; }
.bbs-control { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.bbs-num {
  width: 64px;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  text-align: center;
}
.bbs-input {
  width: 210px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
}
.bbs-dir { flex-wrap: wrap; justify-content: flex-end; max-width: 460px; }
.bbs-btn {
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.bbs-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.bbs-btn-ghost { opacity: .65; }
.bbs-switch {
  width: 34px;
  height: 19px;
  padding: 2px;
  border: none;
  border-radius: 10px;
  background: color-mix(in srgb, var(--fontColor) 18%, transparent);
  cursor: pointer;
  transition: background .15s;
}
.bbs-switch.on { background: var(--fontActiveColor); }
.bbs-knob {
  display: block;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #fff;
  transition: transform .15s;
}
.bbs-switch.on .bbs-knob { transform: translateX(15px); }
@media (max-width: 700px) {
  .bbs-row { align-items: flex-start; flex-direction: column; gap: 8px; }
  .bbs-control { width: 100%; justify-content: flex-start; }
  .bbs-dir { max-width: none; }
  .bbs-input { flex: 1; min-width: 120px; }
}
</style>
