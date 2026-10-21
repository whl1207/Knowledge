<!-- 站点 Playbook：Agent 保存的草稿，用户查看代码后批准才能执行（设置页「Playbook」分组） -->
<template>
  <div class="bps">
    <div class="bps-head">
      <div>
        <div class="bps-title">{{ zh ? '可执行 Playbook' : 'Executable playbooks' }}</div>
        <div class="bps-desc">{{ zh ? 'Agent 把重复站点流程保存为脚本草稿；你必须查看代码并批准后，Agent 才能用 browser_playbook_run 执行。代码只使用 browser.* API，不接触文件/系统。' : 'The agent saves repeatable site flows as script drafts; you must review and approve the code before browser_playbook_run can execute it. Code only uses browser.* APIs, no file/system access.' }}</div>
      </div>
      <button class="bps-btn" :disabled="busy" @click="refresh"><i class="fa fa-refresh" :class="{ 'fa-spin': busy }"></i>{{ zh ? '刷新' : 'Refresh' }}</button>
    </div>

    <div v-if="!rows.length" class="bps-empty">
      <i class="fa fa-code"></i>
      <span>{{ zh ? '还没有 Playbook。AI 完成可复用流程后可用 browser_playbook_save 保存草稿。' : 'No playbooks yet. The AI can save a draft with browser_playbook_save after a reusable flow.' }}</span>
    </div>

    <div v-else class="bps-list">
      <div v-for="p in rows" :key="p.host + '/' + p.slug" class="bps-row" :class="{ draft: !p.approved }">
        <div class="bps-main">
          <div class="bps-name">
            {{ p.name }}
            <span class="bps-badge" :class="p.approved ? 'ok' : 'draft'">{{ p.approved ? (zh ? '已批准' : 'Approved') : (zh ? '草稿' : 'Draft') }}</span>
          </div>
          <div class="bps-meta">
            {{ p.host }} · {{ p.useCount }} {{ zh ? '次' : 'runs' }}<template v-if="p.lastRunAt"> · {{ p.lastRunOk ? '✓' : '✗' }} {{ formatDate(p.lastRunAt) }}</template>
          </div>
          <div v-if="p.description" class="bps-desc2">{{ p.description }}</div>
        </div>
        <div class="bps-actions">
          <button class="bps-btn" @click="toggleCode(p)">{{ openKey === p.host + '/' + p.slug ? (zh ? '收起代码' : 'Hide code') : (zh ? '查看代码' : 'View code') }}</button>
          <button v-if="!p.approved" class="bps-btn bps-approve" :disabled="busy" @click="approve(p)">{{ zh ? '批准执行' : 'Approve' }}</button>
          <button v-else class="bps-btn" :disabled="busy" @click="revoke(p)">{{ zh ? '撤销批准' : 'Revoke' }}</button>
          <button class="bps-btn bps-del" :disabled="busy" @click="remove(p)"><i class="fa fa-trash-o"></i></button>
        </div>
        <pre v-if="openKey === p.host + '/' + p.slug" class="bps-code">{{ codeMap[p.host + '/' + p.slug] || (zh ? '读取中…' : 'Loading…') }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { usestore } from '@/store'
import { ElMessageBox } from 'element-plus'
import { getPlatform } from '@/platform'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const invoke = (method: string, payload?: any) =>
  getPlatform().browserAgent.call(method.replace(/^browser-agent:/, '') as any, payload)

interface Row { host: string; name: string; slug: string; description: string; approved: boolean; useCount: number; lastRunAt?: number; lastRunOk?: boolean; bytes: number }
const rows = ref<Row[]>([])
const busy = ref(false)
const openKey = ref('')
const codeMap = reactive<Record<string, string>>({})
const formatDate = (t: number) => new Date(t).toLocaleString()

const refresh = async () => {
  busy.value = true
  const res = await invoke('browser-agent:playbooks-list').catch(() => null)
  const data = res?.data || res
  rows.value = Array.isArray(data) ? data : []
  busy.value = false
}

const toggleCode = async (p: Row) => {
  const key = `${p.host}/${p.slug}`
  if (openKey.value === key) { openKey.value = ''; return }
  openKey.value = key
  if (!codeMap[key]) {
    const res = await invoke('browser-agent:playbooks-get', { host: p.host, name: p.name }).catch(() => null)
    const d = res?.data || res
    codeMap[key] = d?.playbook?.code || (zh.value ? '读取失败' : 'Failed to load')
  }
}

const approve = async (p: Row) => {
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `批准「${p.name}」后，Agent 可以在 ${p.host} 上执行这段脚本。请确认你已查看代码、理解它会做什么。`
        : `After approving “${p.name}”, the agent may run this script on ${p.host}. Make sure you reviewed the code and understand what it does.`,
      zh.value ? '批准 Playbook' : 'Approve playbook',
      { confirmButtonText: zh.value ? '批准' : 'Approve', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' },
    )
  } catch { return }
  busy.value = true
  await invoke('browser-agent:playbooks-approve', { host: p.host, name: p.name, approved: true }).catch(() => null)
  busy.value = false
  await refresh()
}

const revoke = async (p: Row) => {
  busy.value = true
  await invoke('browser-agent:playbooks-approve', { host: p.host, name: p.name, approved: false }).catch(() => null)
  busy.value = false
  await refresh()
}

const remove = async (p: Row) => {
  try {
    await ElMessageBox.confirm(
      zh.value ? `删除「${p.name}」？删除后 Agent 不能再执行。` : `Delete “${p.name}”? The agent will no longer be able to run it.`,
      zh.value ? '删除 Playbook' : 'Delete playbook',
      { confirmButtonText: zh.value ? '删除' : 'Delete', cancelButtonText: zh.value ? '取消' : 'Cancel', type: 'warning' },
    )
  } catch { return }
  busy.value = true
  await invoke('browser-agent:playbooks-delete', { host: p.host, name: p.name }).catch(() => null)
  busy.value = false
  await refresh()
}

onMounted(() => { void refresh() })
</script>

<style scoped>
.bps { display: flex; flex-direction: column; gap: 10px; }
.bps-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.bps-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.bps-desc { font-size: 11px; line-height: 1.55; opacity: .55; max-width: 620px; }
.bps-empty { display: flex; align-items: center; gap: 7px; padding: 14px 0; font-size: 12px; opacity: .5; }
.bps-empty i { color: var(--fontActiveColor); }
.bps-list { display: flex; flex-direction: column; border-top: 1px solid color-mix(in srgb, var(--fontColor) 8%, transparent); }
.bps-row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, var(--fontColor) 8%, transparent); }
.bps-row.draft { background: color-mix(in srgb, #e6a23c 4%, transparent); }
.bps-main { min-width: 0; flex: 1; }
.bps-name { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; }
.bps-badge { font-size: 10px; font-weight: 500; padding: 1px 5px; border-radius: 3px; }
.bps-badge.ok { color: #42b883; background: color-mix(in srgb, #42b883 12%, transparent); }
.bps-badge.draft { color: #e6a23c; background: color-mix(in srgb, #e6a23c 14%, transparent); }
.bps-meta { font-size: 11px; opacity: .55; margin: 2px 0; }
.bps-desc2 { font-size: 11px; opacity: .7; line-height: 1.5; }
.bps-actions { display: flex; gap: 5px; flex-wrap: wrap; }
.bps-btn { height: 25px; padding: 0 8px; border: 1px solid var(--borderColor); border-radius: 6px; background: transparent; color: var(--fontColor); font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.bps-btn:hover { color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.bps-btn:disabled { opacity: .45; cursor: default; }
.bps-approve { color: #42b883; border-color: color-mix(in srgb, #42b883 40%, var(--borderColor)); }
.bps-del:hover { color: #e05a5a; border-color: #e05a5a; }
.bps-code { flex: 0 0 100%; margin: 4px 0 0; padding: 10px; max-height: 260px; overflow: auto; border-radius: 6px; background: color-mix(in srgb, var(--fontColor) 6%, transparent); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
</style>
