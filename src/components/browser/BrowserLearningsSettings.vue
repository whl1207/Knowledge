<!-- 站点经验：Agent 用 browser_learning_save 存下的可复用操作要点（设置页「经验」分组） -->
<template>
  <div class="bls">
    <div class="bls-head">
      <div class="bls-title">{{ zh ? '站点经验' : 'Site learnings' }}</div>
      <div class="bls-desc">{{ zh ? '智能体在站点任务成功后记录的操作要点；下次同站点任务会先读取。不要保存密码或 Cookie。' : 'Reusable notes saved by the agent after completing a site task; read first next time. Never contains passwords or cookies.' }}</div>
    </div>
    <div v-if="!rows.length" class="bls-empty">
      <i class="fa fa-lightbulb-o"></i>
      <span>{{ zh ? '还没有经验记录。完成站点任务后可让 AI 保存。' : 'No learnings yet. Ask the AI to save one after a site task.' }}</span>
    </div>
    <div v-else class="bls-list">
      <div v-for="r in rows" :key="r.host" class="bls-row">
        <div class="bls-main">
          <div class="bls-host">{{ r.host }}</div>
          <div class="bls-meta">{{ r.title }} · {{ formatDate(r.updatedAt) }} · {{ formatBytes(r.bytes) }}</div>
          <div class="bls-preview">{{ r.preview }}</div>
        </div>
        <button class="bls-del" :title="zh ? '删除该站点经验' : 'Delete learning'" @click="remove(r.host)">
          <i class="fa fa-trash-o"></i>
        </button>
      </div>
    </div>
    <div class="bls-actions">
      <button class="bls-btn" :disabled="busy" @click="refresh"><i class="fa fa-refresh" :class="{ 'fa-spin': busy }"></i>{{ zh ? '刷新' : 'Refresh' }}</button>
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

interface Row { host: string; title: string; updatedAt: number; bytes: number; preview: string }
const rows = ref<Row[]>([])
const busy = ref(false)

const formatDate = (t: number) => new Date(t).toLocaleString()
const formatBytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`

const refresh = async () => {
  busy.value = true
  const res = await invoke('browser-agent:learnings-list').catch(() => null)
  const data = res?.data || res
  rows.value = Array.isArray(data) ? data : []
  busy.value = false
}
const remove = async (host: string) => {
  try {
    await ElMessageBox.confirm(
      zh.value ? `删除 ${host} 的站点经验？` : `Delete the learning for ${host}?`,
      zh.value ? '删除经验' : 'Delete learning',
      { confirmButtonText: zh.value ? '删除' : 'Delete', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' },
    )
  } catch { return }
  await invoke('browser-agent:learnings-delete', { host }).catch(() => null)
  await refresh()
}

onMounted(() => { void refresh() })
</script>

<style scoped>
.bls { display: flex; flex-direction: column; gap: 10px; }
.bls-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.bls-desc { font-size: 11px; line-height: 1.55; opacity: .55; }
.bls-empty { display: flex; align-items: center; gap: 7px; padding: 14px 0; font-size: 12px; opacity: .5; }
.bls-empty i { color: var(--fontActiveColor); }
.bls-list { display: flex; flex-direction: column; border-top: 1px solid color-mix(in srgb, var(--fontColor) 8%, transparent); }
.bls-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid color-mix(in srgb, var(--fontColor) 8%, transparent); }
.bls-main { min-width: 0; }
.bls-host { font-size: 12px; font-weight: 600; }
.bls-meta { font-size: 11px; opacity: .55; margin: 1px 0 3px; }
.bls-preview { font-size: 11px; opacity: .7; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bls-del { flex: 0 0 auto; width: 24px; height: 24px; border: none; border-radius: 5px; background: transparent; color: var(--fontColor); opacity: .5; cursor: pointer; }
.bls-del:hover { opacity: 1; color: #e05a5a; background: color-mix(in srgb, #e05a5a 10%, transparent); }
.bls-actions { display: flex; justify-content: flex-end; }
.bls-btn { height: 25px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--borderColor); border-radius: 6px; background: transparent; color: var(--fontColor); font-size: 12px; cursor: pointer; }
.bls-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.bls-btn:disabled { opacity: .5; cursor: default; }
</style>
