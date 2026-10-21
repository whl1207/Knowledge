<!-- 站点数据：Cookie / localStorage / IndexedDB 概况与清除（设置标签页的「隐私」分组） -->
<template>
  <div class="bsd">
    <div class="bsd-row">
      <div class="bsd-label">
        <div class="bsd-title">{{ zh ? '站点数据' : 'Site data' }}</div>
        <div class="bsd-desc">{{ zh ? 'Cookie、localStorage、IndexedDB、Service Worker；清除后需要重新登录网站' : 'Cookies, localStorage, IndexedDB and service workers; clearing means signing in again' }}</div>
      </div>
      <div class="bsd-meta">
        <span>{{ cookiesText }}</span>
        <span v-if="bytesText !== ''">· {{ bytesText }}</span>
      </div>
    </div>
    <div class="bsd-actions">
      <button class="bsd-btn" :disabled="busy" @click="refresh">
        <i class="fa fa-refresh" :class="{ 'fa-spin': busy }"></i>{{ zh ? '刷新' : 'Refresh' }}
      </button>
      <button class="bsd-btn bsd-danger" :disabled="busy || cookies === 0" @click="clearAll">
        <i class="fa fa-trash-o"></i>{{ zh ? '清除站点数据' : 'Clear site data' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usestore } from '@/store'
import { ElMessageBox } from 'element-plus'
import { getPlatform } from '@/platform'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const invoke = (method: string, payload?: any) =>
  getPlatform().browserAgent.call(method.replace(/^browser-agent:/, '') as any, payload)

const busy = ref(false)
const cookies = ref(0)
const bytes = ref(0)

const formatBytes = (n: number) => {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
const cookiesText = computed(() => zh.value ? `${cookies.value} 个 Cookie` : `${cookies.value} cookies`)
const bytesText = computed(() => bytes.value ? formatBytes(bytes.value) : '')

const refresh = async () => {
  busy.value = true
  const res = await invoke('browser-agent:site-data-info').catch(() => null)
  if (res?.ok || res?.data) {
    const d = res.data || res
    cookies.value = Number(d.cookies) || 0
    bytes.value = Number(d.bytes) || 0
  }
  busy.value = false
}
const clearAll = async () => {
  try {
    await ElMessageBox.confirm(
      zh.value ? `将清除浏览器内的 Cookie/站点存储（当前 ${cookiesText.value}），之后需要重新登录网站。收藏与历史不受影响。` : `Clear browser cookies and site storage (${cookiesText.value}); you will need to sign in again. Bookmarks and history are kept.`,
      zh.value ? '清除站点数据' : 'Clear site data',
      { confirmButtonText: zh.value ? '清除' : 'Clear', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' },
    )
  } catch { return }
  busy.value = true
  const res = await invoke('browser-agent:clear-site-data').catch(() => null)
  const d = res?.data || res
  if (d) {
    cookies.value = Number(d.cookies) || 0
    bytes.value = Number(d.bytes) || 0
  }
  busy.value = false
}

onMounted(() => { void refresh() })
</script>

<style scoped>
.bsd { display: flex; flex-direction: column; gap: 12px; }
.bsd-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.bsd-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.bsd-desc { font-size: 11px; line-height: 1.5; opacity: .55; max-width: 560px; }
.bsd-meta { flex: 0 0 auto; font-size: 12px; opacity: .7; white-space: nowrap; }
.bsd-actions { display: flex; gap: 8px; }
.bsd-btn {
  height: 27px;
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
.bsd-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.bsd-btn:disabled { opacity: .45; cursor: default; }
.bsd-danger { color: #e05a5a; border-color: color-mix(in srgb, #e05a5a 35%, var(--borderColor)); }
.bsd-danger:hover { color: #fff; background: #e05a5a; border-color: #e05a5a; }
</style>
