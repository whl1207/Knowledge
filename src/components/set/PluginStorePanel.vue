<!--
  PluginStorePanel.vue — 插件商店（共享目录 / HTTP 清单）

  设计取向：**不引入新协议**。局域网共享已经是只读 + token 的 HTTP 服务，
  主进程在 `/fs/store` 里把共享目录扫描成商店清单、`/fs/bundle` 打包整个目录：
  这里只需 GET 清单 → 选插件 → 交给主进程下载安装（插件代码与宿主同进程，安装前确认权限）。

  来源地址可以粘贴「协作 → 共享」里那条给人看的 `remote-fs://<ip>:<port>?token=…`，
  也可以直接给 `http://<ip>:<port>/fs/store?token=…`（见 lib/remoteStore.ts）。
-->
<template>
  <div class="plugin-store">
    <div class="settings-group">
      <h3>{{ zh ? '插件商店' : 'Plugin Store' }}</h3>

      <!-- 来源栏 -->
      <div class="ps-sources">
        <div
          v-for="s in sources"
          :key="s.url"
          class="ps-source"
          :class="{ active: current?.url === s.url }"
          @click="selectSource(s)"
          :title="s.url"
        >
          <i class="fa fa-cloud"></i>
          <span class="ps-source-name">{{ s.name }}</span>
          <span class="ps-source-remove" @click.stop="removeSource(s)" :title="zh ? '删除来源' : 'Remove source'">
            <i class="fa fa-times"></i>
          </span>
        </div>
        <div class="ps-source ps-source-add" @click="addSourceFromInput" :title="zh ? '添加共享目录 / 商店地址' : 'Add a shared folder or store URL'">
          <i class="fa fa-plus"></i><span class="ps-source-name">{{ zh ? '添加来源' : 'Add source' }}</span>
        </div>
        <div class="ps-source ps-source-local" @click="useLocalShare" :title="zh ? '把本机正在共享的目录加成来源' : 'Use this machine’s running share as a source'">
          <i class="fa fa-desktop"></i><span class="ps-source-name">{{ zh ? '本机共享目录' : 'Local share' }}</span>
        </div>
      </div>
      <div class="ps-source-input">
        <input
          v-model="sourceInput"
          :placeholder="zh
            ? '粘贴共享地址：remote-fs://192.168.1.5:7788?token=xxx 或 http://…/fs/store?token=xxx（回车添加）'
            : 'Paste a share URL: remote-fs://192.168.1.5:7788?token=xxx or http://…/fs/store?token=xxx (Enter to add)'"
          @keyup.enter="addSourceFromInput"
        />
        <div class="button small" @click="addSourceFromInput">{{ zh ? '添加' : 'Add' }}</div>
      </div>

      <!-- 状态 / 提示 -->
      <div v-if="!desktop" class="ps-notice warn">
        <i class="fa fa-info-circle"></i>
        <div>
          <div class="ps-title">{{ zh ? '插件商店仅桌面版可用' : 'Desktop only' }}</div>
          <div class="ps-desc">{{ zh
            ? '安装插件需要主进程写盘与加载插件代码，网页端（局域网访客）不提供该能力。'
            : 'Installing a plugin needs main-process file access and code loading, which the web guest build does not provide.' }}</div>
        </div>
      </div>
      <div v-else-if="!current" class="ps-notice">
        <i class="fa fa-info-circle"></i>
        <div>
          <div class="ps-title">{{ zh ? '先把一个共享目录加成来源' : 'Add a shared folder as a source first' }}</div>
          <div class="ps-desc">{{ zh
            ? '在「协作 → 共享」里共享一个存放插件 / 技能的文件夹并启动服务，把它显示的地址复制到这里（或点「本机共享目录」）。商店会自动扫描出其中的插件与技能。'
            : 'Share a folder that holds plugins / skills under Collaboration → Share, start the service, then paste the address shown there (or click “Local share”). The store scans it for plugins and skills.' }}</div>
        </div>
      </div>

      <div v-if="loading" class="ps-loading"><i class="fa fa-spinner fa-spin"></i> {{ zh ? '正在读取商店清单…' : 'Loading store index…' }}</div>
      <div v-else-if="error" class="ps-notice warn">
        <i class="fa fa-exclamation-triangle"></i>
        <div>
          <div class="ps-title">{{ zh ? '读取失败' : 'Failed to load' }}</div>
          <div class="ps-desc">{{ error }}</div>
        </div>
      </div>
      <div v-else-if="current && !plugins.length" class="ps-loading">{{ zh ? '该来源里没有扫描到插件（插件 = 含 package.json 与 aikm 清单的目录）' : 'No plugins found in this source (a plugin folder has a package.json with an aikm manifest)' }}</div>

      <!-- 插件列表 -->
      <div v-else-if="plugins.length" class="ps-list">
        <div v-for="p in plugins" :key="p.id" class="ps-item">
          <div class="ps-item-main">
            <div class="ps-item-head">
              <span class="ps-item-name">{{ p.name }}</span>
              <code class="ps-item-id">{{ p.id }}</code>
              <span class="ps-badge" v-if="p.version">v{{ p.version }}</span>
              <span class="ps-badge" v-if="p.apiVersion">API {{ p.apiVersion }}</span>
              <span class="ps-badge" :class="{ dim: !p.permissions.length }" :title="permissionHint(p.permissions)">
                <i class="fa fa-key"></i> {{ p.permissions.length ? p.permissions.join(' / ') : (zh ? '无权限' : 'none') }}
              </span>
              <span class="ps-badge active" v-if="installedIds.has(p.id)">{{ zh ? '已安装' : 'installed' }}</span>
            </div>
            <div class="ps-item-desc" v-if="p.description">{{ p.description }}</div>
            <div class="ps-item-path" v-if="p.path"><i class="fa fa-folder-o"></i> {{ p.path }}</div>
          </div>
          <div class="ps-item-actions">
            <div class="button small" :class="{ working: installing === p.id }" @click="install(p)">
              <i class="fa" :class="installing === p.id ? 'fa-spinner fa-spin' : (installedIds.has(p.id) ? 'fa-refresh' : 'fa-download')"></i>
              {{ installedIds.has(p.id) ? (zh ? '重装' : 'Reinstall') : (zh ? '安装' : 'Install') }}
            </div>
          </div>
        </div>
      </div>

      <!-- 技能提示：同一来源也能给技能商店用 -->
      <div v-if="current && skills.length" class="ps-notice">
        <i class="fa fa-book"></i>
        <div>
          <div class="ps-title">{{ zh ? `该来源还包含 ${skills.length} 个技能` : `This source also has ${skills.length} skills` }}</div>
          <div class="ps-desc">{{ zh
            ? '在「技能 → 商店」里用同一个地址添加来源，即可浏览并安装这些技能。'
            : 'Add the same address as a source under Skills → Store to browse and install them.' }}</div>
        </div>
      </div>

      <!-- 本地方案（保留原有入口） -->
      <div class="ps-cards">
        <div class="ps-card">
          <div class="ps-card-title"><i class="fa fa-folder-open-o"></i> {{ zh ? '本地安装' : 'Local install' }}</div>
          <div class="ps-card-desc">{{ zh
            ? '插件包 = 一个文件夹（含 package.json 与 aikm 清单）。仓库里的 examples/plugins/hello-panel 可直接拿来试用。'
            : 'A plugin package is a folder with a package.json carrying the aikm manifest. examples/plugins/hello-panel in the repo is a ready-to-try sample.' }}</div>
          <div class="ps-actions">
            <div class="button small" @click="goManage">{{ zh ? '去「管理」安装' : 'Go to Manage' }}</div>
            <div class="button small" @click="openDir">{{ zh ? '打开插件目录' : 'Open plugins folder' }}</div>
          </div>
        </div>
        <div class="ps-card">
          <div class="ps-card-title"><i class="fa fa-upload"></i> {{ zh ? '怎么发布' : 'How to publish' }}</div>
          <div class="ps-card-desc">{{ zh
            ? '把插件 / 技能文件夹放进共享目录即可（可分类放进子文件夹，最多 4 层）；商店清单由软件实时扫描生成，不需要手写任何索引文件。'
            : 'Drop plugin / skill folders into the shared folder (category subfolders up to 4 levels are fine). The index is generated on the fly — no hand-written file needed.' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { aikmDsh, aikmIpcAvailable } from '@/lib/aikmIpc'
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { normalizeRemoteStoreUrl, parseStoreIndex, type RemoteStorePlugin } from '@/lib/remoteStore'

const store = usestore()
const zh = computed(() => store.locales === 'zh')
const desktop = computed(() => typeof window !== 'undefined' && !!aikmIpcAvailable())

interface StoreSource { name: string; url: string }

const sourceInput = ref('')
const current = ref<StoreSource | null>(null)
const plugins = ref<RemoteStorePlugin[]>([])
const skills = ref<Array<{ name: string }>>([])
const loading = ref(false)
const error = ref('')
const installing = ref('')
/** 已装插件 id（用于把「安装」按钮显示成「重装」） */
const installedIds = ref<Set<string>>(new Set())

/** 已保存的来源（插件商店没有可硬编码的公开源，来源都由用户显式添加） */
const sources = computed<StoreSource[]>(() =>
  (store.pluginStoreSources || [])
    .filter((s: any) => s && typeof s.url === 'string')
    .map((s: any) => ({ name: s.name || s.url, url: s.url })),
)

const PERMISSION_HINTS: Record<string, [string, string]> = {
  fs: ['文件读写（本插件目录内）', 'File read/write inside its own folder'],
  shell: ['执行命令', 'Run shell commands'],
  net: ['发起网络请求', 'Make network requests'],
  agent: ['读取会话日志（只读）', 'Read session logs (read-only)'],
  llm: ['调用你配置的大模型来源', 'Call your configured model sources'],
}
const permissionHint = (perms: string[]): string => {
  if (!perms.length) return zh.value ? '未申请任何权限' : 'No permissions requested'
  return perms.map((p) => {
    const hit = PERMISSION_HINTS[p]
    return hit ? `${p} — ${zh.value ? hit[0] : hit[1]}` : p
  }).join('\n')
}

/** 读取当前来源的商店清单（纯 GET；共享服务已开 CORS，无需主进程中转） */
const loadSource = async (src: StoreSource) => {
  current.value = src
  loading.value = true
  error.value = ''
  plugins.value = []
  skills.value = []
  try {
    const resp = await fetch(src.url, { cache: 'no-store' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const parsed = parseStoreIndex(await resp.json())
    plugins.value = parsed.plugins
    skills.value = parsed.skills
    await refreshInstalled()
  } catch (e: any) {
    error.value = `${e?.message || e}${zh.value ? '（检查共享服务是否在运行、token 是否最新）' : ' (check that the share is running and the token is current)'}`
  } finally {
    loading.value = false
  }
}

const refreshInstalled = async () => {
  try {
    const res = await aikmDsh?.plugin?.list?.()
    installedIds.value = new Set((res?.plugins || []).map((p: any) => p.id))
  } catch { /* 列表不可用不影响商店浏览 */ }
}

const selectSource = (src: StoreSource) => {
  if (current.value?.url === src.url && (plugins.value.length || loading.value)) return
  void loadSource(src)
}

const rememberSource = (name: string, url: string) => {
  const exists = sources.value.some((s) => s.url.toLowerCase() === url.toLowerCase())
  if (!exists) {
    store.pluginStoreSources = [...(store.pluginStoreSources || []), { name, url }]
    store.saveConfig()
  }
}

const addSourceFromInput = () => {
  const raw = sourceInput.value.trim()
  if (!raw) return
  const normalized = normalizeRemoteStoreUrl(raw)
  if (!normalized) {
    ElMessage.warning(zh.value ? '请填写 http(s) 或 remote-fs:// 地址' : 'Enter an http(s) or remote-fs:// URL')
    return
  }
  const name = raw.replace(/^remote-fs:\/\//i, '').split('?')[0]
  rememberSource(name, normalized.url)
  sourceInput.value = ''
  void loadSource({ name, url: normalized.url })
}

const removeSource = (src: StoreSource) => {
  store.pluginStoreSources = (store.pluginStoreSources || []).filter((s: any) => s.url !== src.url)
  store.saveConfig()
  if (current.value?.url === src.url) {
    current.value = null
    plugins.value = []
    skills.value = []
  }
}

/** 一键使用「本机正在共享的目录」：向主进程取真实运行状态（不信任可能过期的存档开关） */
const useLocalShare = async () => {
  const api = aikmDsh?.remoteFs
  if (!api?.getStatus) {
    ElMessage.warning(zh.value ? '共享服务不可用（网页端没有本机共享）' : 'Share service unavailable')
    return
  }
  let status: any = null
  try {
    status = await api.getStatus()
  } catch { /* 状态取不到按未运行处理 */ }
  if (!status?.running) {
    ElMessage.warning(zh.value ? '本机还没有启动「协作 → 共享」的文件夹共享服务' : 'Folder sharing is not running yet (Collaboration → Share)')
    return
  }
  const token = String(status.token || '')
  const url = `http://127.0.0.1:${status.port}/fs/store${token ? `?token=${encodeURIComponent(token)}` : ''}`
  const name = zh.value ? `本机共享（${status.name || '共享目录'}）` : `Local share (${status.name || 'shared folder'})`
  rememberSource(name, url)
  void loadSource({ name, url })
}

/** 安装：先把该插件申请的权限摆出来让用户确认，再交主进程下载 + 落盘 + 加载 */
const install = async (p: RemoteStorePlugin) => {
  const api = aikmDsh?.plugin
  if (!api?.installFromStore) {
    ElMessage.error(zh.value ? '插件商店仅桌面版可用' : 'Plugin store requires the desktop app')
    return
  }
  const perms = p.permissions.length
    ? (zh.value
        ? `申请的权限：<b>${p.permissions.join(' / ')}</b><br/>${permissionHint(p.permissions).split('\n').join('<br/>')}`
        : `Permissions: <b>${p.permissions.join(' / ')}</b>`)
    : (zh.value ? '未申请额外权限' : 'No extra permissions requested')
  try {
    await ElMessageBox.confirm(
      `<div style="line-height:1.6">${zh.value ? `将从来源安装插件「${p.name}」` : `Install plugin "${p.name}" from this source`}`
        + `<br/>${perms}<br/>`
        + `<span style="color:#b45309">${zh.value ? '插件与宿主同进程运行，不受工作区沙箱保护。' : 'Plugins run in the main process and are not sandboxed.'}</span></div>`,
      zh.value ? '安装插件确认' : 'Confirm plugin install',
      {
        dangerouslyUseHTMLString: true,
        type: 'warning',
        confirmButtonText: zh.value ? '安装' : 'Install',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  installing.value = p.id
  try {
    const snapshot = await api.installFromStore({
      url: p.downloadUrl || '',
      id: p.id,
      confirm: true,
      replace: installedIds.value.has(p.id),
    })
    ElMessage.success(zh.value
      ? `已安装「${snapshot?.name || p.name}」${snapshot?.status === 'active' ? '（已激活，工具与界面已生效）' : '（见「插件 → 管理」）'}`
      : `Installed "${snapshot?.name || p.name}"`)
    await refreshInstalled()
  } catch (e: any) {
    ElMessage.error(zh.value ? `安装失败：${e?.message || e}` : `Install failed: ${e?.message || e}`)
  } finally {
    installing.value = ''
  }
}

const goManage = () => {
  store.settingsNav = 'plugin'
}

const openDir = async () => {
  try {
    await aikmDsh?.plugin?.openDir?.()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

onMounted(() => {
  // 已有来源时自动读第一个，省一次点击
  if (sources.value.length) void loadSource(sources.value[0])
})
</script>

<style scoped>
.plugin-store {
  color: var(--fontColor);
}
/* 内边距必须由组件自带：Set.vue 的 .settings-group 是 scoped 样式，不会作用到子组件内部 */
.plugin-store .settings-group {
  padding: 8px;
  margin-bottom: 0;
}
/* 标题与其它设置页一致：强调色 + 左侧竖条 + 下边框 */
.plugin-store h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}
.plugin-store h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}
.ps-notice {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  margin-top: 10px;
  border: 1px dashed var(--borderColor);
  border-radius: 5px;
  font-size: 11px;
  line-height: 1.6;
}
.ps-notice i {
  color: #409eff;
  margin-top: 2px;
}
.ps-notice.warn i {
  color: #b45309;
}
/* ====== 来源栏 ====== */
.ps-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ps-source {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
  padding: 3px 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  background-color: var(--menuColor);
}
.ps-source.active {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
  font-weight: 600;
}
.ps-source:hover {
  background-color: var(--menuActiveColor);
}
.ps-source-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ps-source-remove {
  opacity: 0.55;
  padding: 0 2px;
}
.ps-source-remove:hover {
  opacity: 1;
  color: #dc2626;
}
.ps-source-add,
.ps-source-local {
  border-style: dashed;
  opacity: 0.85;
}
.ps-source-input {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.ps-source-input input {
  flex: 1;
  min-width: 0;
  margin: 0;
  height: 26px;
  font-size: 12px;
}
.ps-loading {
  margin-top: 12px;
  font-size: 12px;
  opacity: 0.7;
}
/* ====== 插件列表 ====== */
.ps-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ps-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
}
.ps-item-main {
  flex: 1;
  min-width: 0;
}
.ps-item-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.ps-item-name {
  font-weight: 600;
  font-size: 13px;
}
.ps-item-id {
  font-size: 11px;
  opacity: 0.7;
}
.ps-badge {
  font-size: 10px;
  padding: 0 6px;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  opacity: 0.85;
}
.ps-badge.dim {
  opacity: 0.5;
}
.ps-badge.active {
  border-color: #16a34a;
  color: #16a34a;
}
.ps-item-desc {
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.6;
  opacity: 0.8;
}
.ps-item-path {
  margin-top: 4px;
  font-size: 10px;
  opacity: 0.55;
  font-family: ui-monospace, Consolas, monospace;
}
.ps-item-actions .button.small {
  padding: 2px 8px;
  font-size: 11px;
  height: 24px;
  cursor: pointer;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.ps-item-actions .button.small:hover {
  background-color: var(--menuActiveColor);
}
.ps-item-actions .button.working {
  opacity: 0.6;
  pointer-events: none;
}
.ps-title {
  font-weight: 600;
  color: var(--fontActiveColor);
}
.ps-desc {
  opacity: 0.75;
}
.ps-cards {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.ps-card {
  flex: 1 1 260px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  padding: 10px;
  background: var(--menuColor);
}
.ps-card-title {
  font-weight: 600;
  font-size: 13px;
}
.ps-card-desc {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.7;
  opacity: 0.75;
}
.ps-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
/* 与技能管理的工具栏按钮同款（.button.small） */
.plugin-store .button.small {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
  margin: 0;
  cursor: pointer;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
}
.plugin-store .button.small:hover {
  background-color: var(--menuActiveColor);
}
.ps-actions .button {
  margin: 0;
  cursor: pointer;
}
</style>
