<!-- 登录态导入：从本机 Chrome / Edge 读取 Cookie（仅 Windows），需用户显式点击 -->
<template>
  <div class="bli">
    <div class="bli-row">
      <div class="bli-label">
        <div class="bli-title">{{ zh ? '从本机浏览器导入登录态' : 'Import logins from a local browser' }}</div>
        <div class="bli-desc">
          {{ zh ? '读取 Chrome / Edge 的 Cookie 并写入浏览器分区，之后访问这些网站通常无需重新登录。仅在你点击时执行；不记录 Cookie 值。' : 'Reads Chrome / Edge cookies into the browser partition so those sites usually stay signed in. Runs only when clicked; cookie values are never logged.' }}
        </div>
      </div>
      <div class="bli-actions">
        <button class="bli-btn" :disabled="busy" @click="run('chrome')">
          <i class="fa fa-chrome"></i>{{ zh ? '从 Chrome 导入' : 'Import Chrome' }}
        </button>
        <button class="bli-btn" :disabled="busy" @click="run('edge')">
          <i class="fa fa-edge"></i>{{ zh ? '从 Edge 导入' : 'Import Edge' }}
        </button>
      </div>
    </div>
    <div v-if="result" class="bli-result" :class="{ bad: result.ok === false }">
      <i class="fa" :class="result.ok === false ? 'fa-exclamation-circle' : 'fa-check-circle'"></i>
      <span>{{ resultText }}</span>
    </div>
    <div v-if="busy" class="bli-result"><i class="fa fa-spinner fa-spin"></i><span>{{ zh ? '正在读取并导入…' : 'Importing…' }}</span></div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { usestore } from '@/store'
import { ElMessageBox } from 'element-plus'
import { getPlatform } from '@/platform'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const busy = ref(false)
const result = ref<any>(null)

const resultText = computed(() => {
  const r = result.value
  if (!r) return ''
  if (r.ok === false) return (zh.value ? '导入失败：' : 'Failed: ') + (r.error || '')
  const base = zh.value
    ? `已导入 ${r.imported} 条 Cookie（跳过 ${r.skipped}，失败 ${r.failed}）`
    : `Imported ${r.imported} cookies (${r.skipped} skipped, ${r.failed} failed)`
  return r.note ? `${base}。${r.note}` : base
})

const run = async (browser: 'chrome' | 'edge') => {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `将从本机 ${browser === 'edge' ? 'Edge' : 'Chrome'} 读取 Cookie 并导入浏览器分区。请确认这是你自己的浏览器数据；导入后可在「隐私 → 清除站点数据」撤销。`
        : `Cookies from local ${browser === 'edge' ? 'Edge' : 'Chrome'} will be imported into the browser partition. Confirm this is your own browser data; you can undo it via Privacy → Clear site data.`,
      zh.value ? '导入登录态' : 'Import logins',
      { confirmButtonText: zh.value ? '导入' : 'Import', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' },
    )
  } catch { return }
  busy.value = true
  result.value = null
  const res = await getPlatform().browserAgent.call('import-logins' as any, { browser }).catch((e: any) => ({ ok: false, error: e?.message || String(e) }))
  result.value = res?.data || res
  busy.value = false
}
</script>

<style scoped>
.bli { display: flex; flex-direction: column; gap: 8px; }
.bli-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.bli-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.bli-desc { font-size: 11px; line-height: 1.55; opacity: .55; max-width: 560px; }
.bli-actions { flex: 0 0 auto; display: flex; gap: 6px; flex-wrap: wrap; }
.bli-btn {
  height: 27px;
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  background: transparent;
  color: var(--fontColor);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.bli-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.bli-btn:disabled { opacity: .45; cursor: default; }
.bli-result { display: flex; align-items: flex-start; gap: 6px; font-size: 11px; line-height: 1.55; opacity: .75; }
.bli-result i { margin-top: 2px; color: #42b883; }
.bli-result.bad i { color: #e05a5a; }
@media (max-width: 700px) {
  .bli-row { flex-direction: column; gap: 8px; }
}
</style>
