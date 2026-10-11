<!--
  PluginManagement.vue — 设置 → 插件（P0 主进程插件宿主的管理面）

  安全提示（必须显著）：插件与宿主同进程运行，**不受工作区沙箱保护**；
  因此启用/禁用/重载/移除/改配置都走「先展示权限 → 弹确认框 → 带 confirm 重试」的审批路径
  （未确认时主进程返回 PERMISSION_DENIED 且不改变状态，见 electron/main/plugin-ipc.ts）。

  插件目录：userData/plugins（设置页可一键打开）；放入插件包后宿主会自动发现，
  源码改动会触发自动重载（fs.watch）。
-->
<template>
  <div class="plugin-panel">
    <div class="settings-group">
      <div class="group-title-row">
        <h3>{{ zh ? '插件管理' : 'Plugin Manager' }}</h3>
        <div class="plugin-head">
          <span class="plugin-head-count">{{ plugins.length }} {{ zh ? '个插件' : 'plugins' }}</span>
          <span class="folder-path" :title="rootDir || (zh ? '未设置' : 'Not set')">
            <i class="fa fa-folder"></i> {{ rootDir || (zh ? '未设置插件目录' : 'No plugins folder set') }}
          </span>
          <div class="button icon-btn" @click="installFromFolder" :title="zh ? '从本地文件夹安装插件' : 'Install a plugin from a local folder'">
            <i class="fa fa-plus"></i>
          </div>
          <div class="button icon-btn" @click="chooseRoot" :title="zh ? '选择插件目录' : 'Select plugins folder'">
            <i class="fa fa-folder-open"></i>
          </div>
          <div class="button icon-btn" @click="openDir()" :title="zh ? '在资源管理器中打开' : 'Open in Explorer'">
            <i class="fa fa-external-link"></i>
          </div>
          <div class="button icon-btn" @click="refresh" :title="zh ? '刷新' : 'Refresh'">
            <i class="fa fa-refresh"></i>
          </div>
        </div>
      </div>

      <!-- 安全声明 + 目录 -->
      <div class="plugin-notice">
        <i class="fa fa-exclamation-triangle"></i>
        <div class="plugin-notice-body">
          <div class="plugin-notice-title">{{ zh ? '插件以宿主权限运行' : 'Plugins run with host privileges' }}</div>
          <div class="plugin-notice-desc">
            {{ zh
              ? '插件代码与主进程同进程，不受工作区沙箱保护。启用前请确认来源可信；下方「权限」即该插件申请的宿主能力。'
              : 'Plugin code runs in the main process and is NOT confined by the workspace sandbox. Only enable plugins you trust; the “Permissions” listed below are the host capabilities it requests.' }}
          </div>
        </div>
      </div>

      <div v-if="unavailable" class="plugin-empty">
        <i class="fa fa-info-circle"></i>
        {{ zh ? '插件管理仅桌面版可用（window.dsh.plugin 不可用）' : 'Plugin management requires the desktop app (window.dsh.plugin unavailable)' }}
      </div>

      <div v-else-if="!plugins.length" class="plugin-empty">
        {{ zh
          ? '还没有插件。点右上角「安装」选择插件文件夹，或把插件文件夹放进上面的「插件目录」后点刷新。'
          : 'No plugins yet. Click “Install” to pick a plugin folder, or drop one into the plugins folder above and refresh.' }}
      </div>

      <div v-else class="plugin-list">
        <div v-for="p in plugins" :key="p.id" class="plugin-item" :class="`status-${p.status}`">
          <div class="plugin-item-main">
            <div class="plugin-name-row">
              <span class="plugin-name">{{ p.name }}</span>
              <code class="plugin-id">{{ p.id }}</code>
              <span class="plugin-badge">v{{ p.version }}</span>
              <span class="plugin-badge" :title="zh ? '插件要求的宿主 API 版本区间' : 'Required host API range'">API {{ p.apiVersion || '—' }}</span>
              <span class="plugin-badge" :class="`badge-status status-${p.status}`">{{ statusLabel(p.status) }}</span>
              <span v-if="!p.enabled" class="plugin-badge dim">{{ zh ? '已禁用' : 'Disabled' }}</span>
            </div>

            <div class="plugin-meta-row">
              <span :title="permissionHint(p.permissions)">
                <i class="fa fa-key"></i>
                {{ p.permissions.length ? p.permissions.join(' / ') : (zh ? '无' : 'none') }}
              </span>
              <span v-if="p.inject.length" :title="zh ? '依赖的宿主服务' : 'Required host services'">
                <i class="fa fa-cubes"></i> inject: {{ p.inject.join(', ') }}
              </span>
              <span v-if="p.tools.length" :title="zh ? '已注册的工具（scope = plugin:id）' : 'Registered tools (scope = plugin:id)'">
                <i class="fa fa-wrench"></i> {{ p.tools.join(', ') }}
              </span>
              <span v-if="p.services.length" :title="zh ? '对外提供的服务' : 'Provided services'">
                <i class="fa fa-share-alt"></i> {{ p.services.join(', ') }}
              </span>
              <span v-if="p.hasClient" :title="zh ? '含渲染层半边（P1 生效）' : 'Has a client half (effective in P1)'">
                <i class="fa fa-paint-brush"></i> UI
              </span>
              <span v-if="p.declaredSlots.length" :title="zh ? '声明挂载的界面槽位（P1 生效）' : 'Declared UI slots (effective in P1)'">
                <i class="fa fa-th-large"></i> {{ p.declaredSlots.join(', ') }}
              </span>
            </div>

            <div v-if="p.error" class="plugin-error" :title="p.error">
              <i class="fa fa-times-circle"></i> {{ p.error }}
            </div>

            <div v-if="p.description" class="plugin-desc">{{ p.description }}</div>
          </div>

          <div class="plugin-item-actions">
            <div
              v-if="!p.enabled"
              class="button icon-btn"
              :title="zh ? '启用插件（会先展示权限并要求确认）' : 'Enable plugin (shows permissions and asks for confirmation)'"
              @click="setEnabled(p, true)"
            >
              <i class="fa fa-play-circle"></i>
            </div>
            <div
              v-else
              class="button icon-btn"
              :title="zh ? '禁用插件（工具与界面元素立即消失）' : 'Disable plugin (tools and UI elements disappear immediately)'"
              @click="setEnabled(p, false)"
            >
              <i class="fa fa-pause-circle"></i>
            </div>
            <div
              class="button icon-btn"
              :title="zh ? '重载：撤销旧注册后重跑 apply（改代码 / 改配置后用它生效）' : 'Reload: dispose old registrations and re-run apply'"
              @click="reloadPlugin(p)"
            >
              <i class="fa fa-refresh"></i>
            </div>
            <div class="button icon-btn" :title="zh ? '查看运行日志' : 'View runtime logs'" @click="openLogs(p)">
              <i class="fa fa-list-alt"></i>
            </div>
            <div
              class="button icon-btn"
              :title="zh ? '编辑配置（传给 ctx.config，保存后点重载生效）' : 'Edit config (passed to ctx.config; applies on reload)'"
              @click="openConfig(p)"
            >
              <i class="fa fa-sliders"></i>
            </div>
            <div
              class="button icon-btn"
              :title="zh ? '详情：权限 / 注册内容 / 界面位置 / 快捷键' : 'Details: permissions / registrations / UI surfaces / shortcuts'"
              @click="openDetails(p)"
            >
              <i class="fa fa-info-circle"></i>
            </div>
            <div
              class="button icon-btn danger"
              :title="zh ? '移除插件（可选是否连磁盘文件一起删除）' : 'Remove plugin (optionally delete its files)'"
              @click="removePlugin(p)"
            >
              <i class="fa fa-trash-o"></i>
            </div>
          </div>
        </div>
      </div>

      <!-- 宿主服务面（插件可 inject 的内置服务） -->
      <div v-if="services.length" class="plugin-services">
        <i class="fa fa-plug"></i>
        {{ zh ? '宿主可注入服务：' : 'Host services available for inject: ' }}
        <code v-for="s in services" :key="s" class="host-service">{{ s }}</code>
        <span
          v-if="customRoot"
          class="plugin-reset-root"
          @click="resetRoot"
        >{{ zh ? '恢复默认插件目录' : 'Reset plugins folder' }}</span>
      </div>
    </div>

    <!-- 日志弹层 -->
    <div v-if="logTarget" class="plugin-overlay" @click.self="logTarget = null">
      <div class="plugin-dialog">
        <div class="dialog-head">
          <span>{{ zh ? '日志' : 'Logs' }} · {{ logTarget.name }}</span>
          <i class="fa fa-times" @click="logTarget = null"></i>
        </div>
        <pre class="plugin-log">{{ logText }}</pre>
      </div>
    </div>

    <!-- 配置弹层 -->
    <div v-if="configTarget" class="plugin-overlay" @click.self="closeConfig">
      <div class="plugin-dialog">
        <div class="dialog-head">
          <span>{{ zh ? '配置' : 'Config' }} · {{ configTarget.name }}</span>
          <i class="fa fa-times" @click="closeConfig"></i>
        </div>
        <textarea v-model="configText" spellcheck="false" class="plugin-config-input"></textarea>
        <div class="dialog-foot">
          <span class="hint">{{ zh ? 'JSON 对象；保存后在「重载」时生效' : 'JSON object; applied on Reload' }}</span>
          <div class="button small-btn" @click="saveConfig">{{ zh ? '保存' : 'Save' }}</div>
        </div>
      </div>
    </div>

    <!-- 详情弹层：权限 / 注册内容 / 界面位置 / 快捷键（本地诊断，不联网） -->
    <div v-if="detailTarget" class="plugin-overlay" @click.self="detailTarget = null">
      <div class="plugin-dialog">
        <div class="dialog-head">
          <span>{{ zh ? '详情' : 'Details' }} · {{ detailTarget.name }}</span>
          <i class="fa fa-times" @click="detailTarget = null"></i>
        </div>
        <div class="plugin-detail-body">
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '标识' : 'Id' }}</span>
            <span class="detail-v"><code>{{ detailTarget.id }}</code> · v{{ detailTarget.version }} · API {{ detailTarget.apiVersion || '—' }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '状态' : 'Status' }}</span>
            <span class="detail-v">{{ statusLabel(detailTarget.status) }}<template v-if="!detailTarget.enabled"> · {{ zh ? '已禁用' : 'disabled' }}</template></span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '权限' : 'Permissions' }}</span>
            <span class="detail-v">
              {{ detailTarget.permissions.length ? detailTarget.permissions.join(' / ') : (zh ? '无' : 'none') }}
              <template v-if="detailTarget.permissions.length">
                <div
                  v-for="perm in detailTarget.permissions"
                  :key="perm"
                  class="detail-hint"
                >{{ PERMISSION_HINTS[perm] ? `${perm} — ${zh ? PERMISSION_HINTS[perm][0] : PERMISSION_HINTS[perm][1]}` : perm }}</div>
              </template>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '工具' : 'Tools' }}</span>
            <span class="detail-v">{{ detailTarget.tools.length ? detailTarget.tools.join(', ') : (zh ? '无' : 'none') }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '服务' : 'Services' }}</span>
            <span class="detail-v">{{ detailTarget.services.length ? detailTarget.services.join(', ') : (zh ? '无' : 'none') }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '界面位置' : 'UI surface' }}</span>
            <span class="detail-v">
              {{ detailSlots.length ? detailSlots.join(' · ') : (zh ? '未注册（或未声明 client 半边）' : 'none') }}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '快捷键' : 'Shortcuts' }}</span>
            <span class="detail-v">
              <template v-if="detailShortcuts.length">
                <code v-for="s in detailShortcuts" :key="s.display" class="detail-shortcut">{{ s.display }}</code>
                <span class="detail-note">{{ detailShortcuts.map((s) => (zh ? s.descriptionZh : s.descriptionEn) || s.display).join('；') }}</span>
              </template>
              <template v-else>{{ zh ? '无' : 'none' }}</template>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '依赖' : 'Requires' }}</span>
            <span class="detail-v">{{ detailTarget.inject.length ? detailTarget.inject.join(', ') : (zh ? '无' : 'none') }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-k">{{ zh ? '目录' : 'Folder' }}</span>
            <span class="detail-v path">{{ detailTarget.dir }}</span>
          </div>
          <div v-if="detailTarget.error" class="detail-row">
            <span class="detail-k">{{ zh ? '错误' : 'Error' }}</span>
            <span class="detail-v error">{{ detailTarget.error }}</span>
          </div>
        </div>
        <div class="dialog-foot">
          <span class="hint">{{ zh ? '快捷键需插件已激活才生效' : 'Shortcuts are live only while the plugin is active' }}</span>
          <div class="button small-btn" @click="openLogsFromDetail">{{ zh ? '查看日志' : 'Logs' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import { useSlotSnapshot } from '@/lib/plugin/useSlots'
import { clientShortcuts } from '@/lib/plugin/runtime'
import type { PluginSnapshot, PluginStatus, PluginLogLine, PluginEvent } from '@/types/plugin'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const plugins = ref<PluginSnapshot[]>([])
const rootDir = ref('')
const customRoot = ref(false)
const services = ref<string[]>([])
const unavailable = ref(false)

const logTarget = ref<PluginSnapshot | null>(null)
const logText = ref('')
const configTarget = ref<PluginSnapshot | null>(null)
const configText = ref('')
/** 槽位注册表快照（详情面板用它把「界面位置」归到具体插件） */
const slotSnapshot = useSlotSnapshot()

let offEvent: (() => void) | null = null

const bridge = () => (window as any).dsh?.plugin

const statusLabel = (status: PluginStatus): string => {
  const map: Record<PluginStatus, [string, string]> = {
    discovered: ['待加载', 'Ready'],
    invalid: ['清单/版本不可用', 'Invalid'],
    pending: ['等待依赖', 'Pending'],
    loading: ['加载中', 'Loading'],
    active: ['已激活', 'Active'],
    failed: ['加载失败', 'Failed'],
    disabled: ['已禁用', 'Disabled'],
  }
  const [z, e] = map[status]
  return zh.value ? z : e
}

/** 权限的中文/英文说明（悬停与详情用；未收录的权限按原样显示） */
const PERMISSION_HINTS: Record<string, [string, string]> = {
  fs: ['文件读写（本插件目录内；带此权限的插件工具默认需要审批）', 'File read/write (inside its own folder; plugin tools with it require approval by default)'],
  shell: ['执行命令（仍受 trusted 沙箱策略约束）', 'Run shell commands (still bound by the trusted sandbox policy)'],
  net: ['发起网络请求', 'Make network requests'],
  agent: ['读取会话日志（只读）', 'Read session logs (read-only)'],
  llm: ['调用你配置的大模型来源（会消耗额度 / 算力）', 'Call your configured model sources (consumes quota / compute)'],
}

const permissionHint = (permissions: string[]): string => {
  const head = zh.value ? '声明的权限（悬停看说明）：' : 'Declared permissions (hover for details):'
  if (!permissions.length) return zh.value ? '未申请任何权限' : 'No permissions requested'
  const lines = permissions.map((p) => {
    const hit = PERMISSION_HINTS[p]
    return hit ? `${p} — ${zh.value ? hit[0] : hit[1]}` : p
  })
  return `${head}\n${lines.join('\n')}`
}

const refresh = async () => {
  const api = bridge()
  if (!api) {
    unavailable.value = true
    return
  }
  try {
    const res = await api.list()
    plugins.value = res.plugins
    rootDir.value = res.rootDir
    customRoot.value = res.customRoot === true
    services.value = res.services
    unavailable.value = false
  } catch (e: any) {
    console.error('[PluginManagement] 加载插件列表失败:', e)
    unavailable.value = true
  }
}

/** 变更类操作统一走「先确认（展示权限与影响）→ 带 confirm 重试」 */
const confirmMutation = async (p: PluginSnapshot, actionZh: string, actionEn: string): Promise<boolean> => {
  const permText = p.permissions.length
    ? (zh.value
        ? `申请的权限：<b>${p.permissions.join(' / ')}</b><br/>${permissionHint(p.permissions).split('\n').slice(1).join('<br/>')}`
        : `Requested permissions: <b>${p.permissions.join(' / ')}</b><br/>${permissionHint(p.permissions).split('\n').slice(1).join('<br/>')}`)
    : (zh.value ? '未申请额外权限' : 'No extra permissions requested')
  try {
    await ElMessageBox.confirm(
      `<div style="line-height:1.6">${zh.value ? `将${actionZh}插件「${p.name}」` : `Will ${actionEn} plugin "${p.name}"`}<br/>${permText}<br/>`
        + `<span style="color:#b45309">${zh.value ? '插件与宿主同进程运行，不受工作区沙箱保护。' : 'Plugins run in the main process and are not sandboxed.'}</span></div>`,
      zh.value ? '插件操作确认' : 'Confirm plugin action',
      {
        dangerouslyUseHTMLString: true,
        type: 'warning',
        confirmButtonText: zh.value ? '继续' : 'Continue',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
    return true
  } catch {
    return false
  }
}

const runMutation = async (p: PluginSnapshot, fn: (confirm: boolean) => Promise<any>) => {
  try {
    await fn(true)
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const setEnabled = async (p: PluginSnapshot, enable: boolean) => {
  const ok = enable
    ? await confirmMutation(p, '启用', 'enable')
    : await confirmMutation(p, '禁用', 'disable')
  if (!ok) return
  await runMutation(p, (confirm) =>
    enable ? bridge().enable(p.id, confirm) : bridge().disable(p.id, confirm))
  ElMessage.success(enable ? (zh.value ? '已启用' : 'Enabled') : (zh.value ? '已禁用' : 'Disabled'))
}

const reloadPlugin = async (p: PluginSnapshot) => {
  const ok = await confirmMutation(p, '重新加载', 'reload')
  if (!ok) return
  await runMutation(p, (confirm) => bridge().reload(p.id, confirm))
  ElMessage.success(zh.value ? '已重载' : 'Reloaded')
}

const removePlugin = async (p: PluginSnapshot) => {
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `从注册表移除插件「${p.name}」？移除后它的工具与界面元素立即消失。`
        : `Remove plugin "${p.name}" from the registry? Its tools and UI contributions disappear immediately.`,
      zh.value ? '移除确认' : 'Confirm removal',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '移除' : 'Remove',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  // 第二步单独询问是否删文件：删除磁盘文件不可逆，不放在同一个按钮里误触
  let deleteFiles = false
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `是否同时删除插件目录里的文件？\n${p.dir}`
        : `Also delete the plugin files on disk?\n${p.dir}`,
      zh.value ? '删除文件？' : 'Delete files?',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '删除文件' : 'Delete files',
        cancelButtonText: zh.value ? '保留文件' : 'Keep files',
      },
    )
    deleteFiles = true
  } catch {
    deleteFiles = false
  }
  try {
    const res = await bridge().uninstall(p.id, { confirm: true, deleteFiles })
    ElMessage.success(
      res?.deletedDir
        ? (zh.value ? '已移除并删除文件' : 'Removed and files deleted')
        : (zh.value ? '已从注册表移除（文件保留）' : 'Removed from registry (files kept)'),
    )
    if (detailTarget.value?.id === p.id) detailTarget.value = null
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const openLogs = async (p: PluginSnapshot) => {
  try {
    const lines: PluginLogLine[] = await bridge().logs(p.id)
    logText.value = lines.length
      ? lines.map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.level.toUpperCase()} ${l.message}`).join('\n')
      : (zh.value ? '（暂无日志）' : '(no logs yet)')
    logTarget.value = p
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const openConfig = async (p: PluginSnapshot) => {
  try {
    const cfg = await bridge().getConfig(p.id)
    configText.value = JSON.stringify(cfg ?? {}, null, 2)
    configTarget.value = p
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const closeConfig = () => {
  configTarget.value = null
  configText.value = ''
}

const saveConfig = async () => {
  const target = configTarget.value
  if (!target) return
  let patch: Record<string, unknown>
  try {
    patch = JSON.parse(configText.value || '{}')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('必须是 JSON 对象')
  } catch (e: any) {
    ElMessage.error(zh.value ? `配置不是合法 JSON 对象：${e?.message || e}` : `Config must be a JSON object: ${e?.message || e}`)
    return
  }
  try {
    await bridge().setConfig(target.id, patch, true)
    ElMessage.success(zh.value ? '配置已保存（点「重载」生效）' : 'Config saved (applies on Reload)')
    closeConfig()
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

const openDir = async (id?: string) => {
  try {
    await bridge().openDir(id)
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

/** 选择插件目录（与技能管理同一交互：系统目录选择框 → 主进程切换根目录并重新扫描） */
const chooseRoot = async () => {
  const api = bridge()
  if (!api?.setRoot) {
    ElMessage.error(zh.value ? '插件目录设置仅桌面版可用' : 'Setting the plugins folder requires the desktop app')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh.value
        ? '选择一个文件夹作为插件目录（每个子文件夹即一个插件）。切换后当前已加载的插件会先卸载，再从新目录重新扫描。'
        : 'Pick a folder to use as the plugins folder (each subfolder is a plugin). Loaded plugins are unloaded first, then the new folder is scanned.',
      zh.value ? '选择插件目录' : 'Select plugins folder',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '选择文件夹' : 'Choose folder',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }
  try {
    const res = await api.setRoot({ confirm: true })
    if (res?.cancelled) return
    ElMessage.success(zh.value ? `插件目录已切换：${res.rootDir}` : `Plugins folder: ${res.rootDir}`)
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

/**
 * 从本地文件夹安装（P2 本地安装；主进程弹目录选择框）。
 * 同名冲突时主进程返回 PLUGIN_EXISTS，这里询问用户后再以 replace 重试。
 */
const installFromFolder = async () => {
  const api = bridge()
  if (!api?.install) {
    ElMessage.error(zh.value ? '插件安装仅桌面版可用' : 'Installing plugins requires the desktop app')
    return
  }
  try {
    await ElMessageBox.confirm(
      zh.value
        ? '选择一个插件文件夹（内含 package.json 与 aikm 清单）安装到插件目录。插件与宿主同进程运行、不受工作区沙箱保护，只安装可信来源。'
        : 'Pick a plugin folder (package.json with an aikm manifest) to install into the plugins folder. Plugins run in the main process and are not sandboxed — install only trusted sources.',
      zh.value ? '安装插件' : 'Install plugin',
      {
        type: 'warning',
        confirmButtonText: zh.value ? '选择文件夹' : 'Choose folder',
        cancelButtonText: zh.value ? '取消' : 'Cancel',
      },
    )
  } catch {
    return
  }

  const run = async (replace: boolean): Promise<boolean> => {
    try {
      const res = await api.install({ confirm: true, replace })
      if (res?.cancelled) return true
      const name = res?.snapshot?.name ?? ''
      ElMessage.success(zh.value ? `已安装：${name}` : `Installed: ${name}`)
      await refresh()
      return true
    } catch (e: any) {
      if (e?.code === 'PLUGIN_EXISTS') {
        try {
          await ElMessageBox.confirm(
            zh.value
              ? `${e.message} 覆盖安装会先删除插件目录里的旧版本（插件内的配置保留）。`
              : `${e.message} Replacing first deletes the old copy in the plugins folder (its config is kept).`,
            zh.value ? '覆盖安装？' : 'Replace?',
            { type: 'warning', confirmButtonText: zh.value ? '覆盖安装' : 'Replace', cancelButtonText: zh.value ? '取消' : 'Cancel' },
          )
        } catch {
          return true
        }
        return run(true)
      }
      ElMessage.error(e?.message || String(e))
      return true
    }
  }
  await run(false)
}

/** 恢复默认插件目录（仅在自定义目录时显示入口） */
const resetRoot = async () => {
  const api = bridge()
  if (!api?.resetRoot) return
  try {
    await ElMessageBox.confirm(
      zh.value ? '恢复默认插件目录（<用户数据>/plugins）？' : 'Reset to the default plugins folder (userData/plugins)?',
      zh.value ? '恢复默认' : 'Reset',
      { type: 'warning', confirmButtonText: zh.value ? '恢复' : 'Reset', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  try {
    const res = await api.resetRoot({ confirm: true })
    ElMessage.success(zh.value ? `插件目录：${res.rootDir}` : `Plugins folder: ${res.rootDir}`)
    await refresh()
  } catch (e: any) {
    ElMessage.error(e?.message || String(e))
  }
}

/** 详情：注册的工具与服务来自主进程快照；界面位置来自渲染层槽位注册表（owner 归属） */
const detailTarget = ref<PluginSnapshot | null>(null)
const detailSlots = computed(() => {
  const target = detailTarget.value
  if (!target) return []
  const owner = `plugin:${target.id}`
  return slotSnapshot.value
    .flatMap((s) => s.entries.filter((e) => e.owner === owner).map((e) => `${s.slot} · ${e.key}`))
    .sort()
})
const detailShortcuts = computed(() => {
  const target = detailTarget.value
  if (!target) return []
  return clientShortcuts(`plugin:${target.id}`) as Array<{ display: string; descriptionZh: string; descriptionEn: string }>
})

const openDetails = (p: PluginSnapshot) => {
  detailTarget.value = p
}

const openLogsFromDetail = async () => {
  const target = detailTarget.value
  if (!target) return
  detailTarget.value = null
  await openLogs(target)
}

onMounted(async () => {
  await refresh()
  // 主进程推送：状态变更 / 日志 / 通知（节流到下一帧，避免重载期间连续刷列表）
  offEvent = bridge()?.onEvent?.((ev: PluginEvent) => {
    if (ev.type === 'plugin/changed') void refresh()
    else if (ev.type === 'plugin/notify') ElMessage.info(`[${ev.id}] ${ev.message}`)
  }) ?? null
})

onUnmounted(() => {
  offEvent?.()
  offEvent = null
})
</script>

<style scoped>
.plugin-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--fontColor);
  position: relative;
}
.plugin-panel .settings-group {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
  overflow: auto;
}
.group-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 10px 0;
}
.group-title-row h3 {
  margin: 0;
  font-size: 15px;
}
.plugin-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-count {
  font-size: 12px;
  opacity: 0.7;
}
.icon-btn {
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--borderColor, #ddd);
}
.icon-btn:hover {
  background: var(--hoverColor, rgba(0, 0, 0, 0.05));
}
.plugin-notice {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--borderColor, #e5e5e5);
  background: var(--backgroundColor, #fffbe6);
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.6;
}
.plugin-notice i {
  color: #d97706;
  margin-top: 2px;
}
.plugin-notice-title {
  font-weight: 600;
}
.plugin-notice-desc {
  opacity: 0.85;
}
.plugin-notice-path {
  margin-top: 4px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.7;
  word-break: break-all;
}
.plugin-empty {
  padding: 24px 8px;
  text-align: center;
  opacity: 0.6;
  font-size: 13px;
}
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plugin-item {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  padding: 8px 10px;
  border: 1px solid var(--borderColor, #e5e5e5);
  border-radius: 6px;
  border-left-width: 3px;
}
.plugin-item.status-active {
  border-left-color: #16a34a;
}
.plugin-item.status-failed,
.plugin-item.status-invalid {
  border-left-color: #dc2626;
}
.plugin-item.status-pending,
.plugin-item.status-loading {
  border-left-color: #d97706;
}
.plugin-item.status-disabled,
.plugin-item.status-discovered {
  border-left-color: #9ca3af;
}
.plugin-item-main {
  min-width: 0;
  flex: 1;
}
.plugin-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.plugin-name {
  font-weight: 600;
}
.plugin-id,
.host-service {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.7;
}
.plugin-badge {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  border: 1px solid var(--borderColor, #ddd);
  opacity: 0.85;
}
.plugin-badge.badge-status.status-active {
  border-color: #16a34a;
  color: #16a34a;
}
.plugin-badge.badge-status.status-failed,
.plugin-badge.badge-status.status-invalid {
  border-color: #dc2626;
  color: #dc2626;
}
.plugin-badge.dim {
  opacity: 0.5;
}
.plugin-meta-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  opacity: 0.75;
  margin-top: 4px;
}
.plugin-error {
  margin-top: 4px;
  font-size: 12px;
  color: #dc2626;
  word-break: break-all;
}
.plugin-desc {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.7;
}
.plugin-item-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
  flex-shrink: 0;
}
.small-btn {
  cursor: pointer;
  font-size: 12px;
  padding: 2px 10px;
  text-align: center;
  border: 1px solid var(--borderColor, #ddd);
  border-radius: 4px;
  white-space: nowrap;
}
.small-btn:hover {
  background: var(--hoverColor, rgba(0, 0, 0, 0.05));
}
.small-btn.danger:hover {
  border-color: #dc2626;
  color: #dc2626;
}
.install-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-color: var(--activeColor, #409eff);
}
.plugin-detail-body {
  padding: 10px 12px;
  overflow: auto;
  max-height: 60vh;
  font-size: 12px;
}
.detail-row {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--borderColor, #eee);
}
.detail-k {
  flex: 0 0 72px;
  opacity: 0.6;
}
.detail-v {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.detail-v.error {
  color: #dc2626;
}
.detail-v.path {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  opacity: 0.8;
}
.detail-shortcut {
  margin-right: 6px;
}
.detail-note {
  opacity: 0.7;
}

/* ===========================================================================
   样式对齐：与「工具」「技能」设置页保持一致
   （标题行 = ToolRegistryPanel 的 .group-title-row；图标按钮 = 其 .icon-btn；
     列表卡片 / 徽标取色沿用 registry / skill 列表的变量写法）
   =========================================================================== */
.plugin-panel .settings-group {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
  overflow: visible;
}
/* 标题行：h3 在左（带强调色竖条 + 下边框），工具条在右 */
.plugin-panel .group-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 10px 0;
  border-bottom: 1px solid var(--borderColor);
  flex-shrink: 0;
}
.plugin-panel .group-title-row h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0;
  padding: 0 0 8px 10px;
  border-bottom: none;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
  white-space: nowrap;
}
.plugin-panel .group-title-row h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}
.plugin-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
}
.plugin-head-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--fontActiveColor);
  white-space: nowrap;
  opacity: 0.9;
}
.folder-path {
  font-size: 10px;
  opacity: 0.65;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
  direction: rtl;
  text-align: left;
}
.folder-path i {
  margin-right: 3px;
}
/* 图标按钮：仅图标、无边框（与工具注册表 / 技能管理一致） */
.plugin-panel .button.icon-btn {
  width: 23px;
  height: 23px;
  margin: 0;
  padding: 0;
  border: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.plugin-panel .button.icon-btn:hover {
  background-color: var(--menuActiveColor);
}
/* 说明块：虚线边框的信息块（参照「注册表不可用」提示的写法） */
.plugin-notice {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--borderColor);
  border-radius: 5px;
  margin-bottom: 10px;
  font-size: 11px;
  line-height: 1.6;
  background: transparent;
}
.plugin-notice i {
  color: #f39c12;
  margin-top: 2px;
}
.plugin-notice-title {
  font-weight: 600;
  color: var(--fontActiveColor);
}
.plugin-notice-desc {
  opacity: 0.75;
}
.plugin-notice-path {
  margin-top: 3px;
  font-family: Consolas, monospace;
  font-size: 10px;
  opacity: 0.6;
  word-break: break-all;
}
.plugin-empty {
  padding: 14px;
  text-align: center;
  color: #888;
  font-size: 12px;
  border: 1px dashed var(--borderColor);
  border-radius: 5px;
}
.plugin-list {
  gap: 6px;
}
.plugin-item {
  padding: 8px;
  gap: 8px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background: var(--menuColor);
  transition: border-color 0.12s;
}
.plugin-item:hover {
  border-color: var(--fontActiveColor);
}
.plugin-name {
  font-size: 13px;
  font-weight: 600;
}
.plugin-badge {
  font-size: 9px;
  padding: 0 5px;
  border: none;
  border-radius: 3px;
  background: color-mix(in srgb, var(--fontColor) 8%, transparent);
  opacity: 1;
}
.plugin-badge.badge-status.status-active {
  background: color-mix(in srgb, #4caf50 14%, transparent);
  color: #4caf50;
}
.plugin-badge.badge-status.status-failed,
.plugin-badge.badge-status.status-invalid {
  background: color-mix(in srgb, #e74c3c 14%, transparent);
  color: #e74c3c;
}
.plugin-badge.badge-status.status-pending,
.plugin-badge.badge-status.status-loading {
  background: color-mix(in srgb, #f39c12 14%, transparent);
  color: #f39c12;
}
.plugin-meta-row {
  font-size: 10px;
  gap: 10px;
  opacity: 0.75;
}
.plugin-item-actions {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}
/* 行内动作按钮：只显示图标（悬停 title 说明），无边框，尺寸与工具页图标按钮一致 */
.plugin-panel .button.icon-btn {
  width: 23px;
  height: 23px;
  min-width: 23px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 4px;
  background-color: transparent;
  color: var(--fontColor);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.plugin-panel .button.icon-btn:hover {
  background-color: var(--menuActiveColor);
}
.plugin-panel .button.icon-btn.danger:hover {
  color: #e74c3c;
}
/* 小按钮（弹层底部等仍用带边框的文字按钮） */
.plugin-panel .button.small-btn {
  padding: 2px 6px;
  font-size: 10px;
  height: 22px;
  min-width: 22px;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  white-space: nowrap;
}
.plugin-panel .button.small-btn:hover {
  background-color: var(--menuActiveColor);
}
.plugin-panel .button.small-btn.danger:hover {
  border-color: #e74c3c;
  color: #e74c3c;
}
.plugin-services {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 10px;
}
/* 详情弹窗里的权限说明（小字、缩进一行） */
.plugin-dialog .detail-hint {
  font-size: 10px;
  opacity: 0.6;
  margin-top: 2px;
  white-space: normal;
}
/* 弹层：与设置面板配色一致 */
.plugin-dialog {
  background: var(--backgroundColor);
  border: 1px solid var(--borderColor);
}
.dialog-head {
  border-bottom: 1px solid var(--borderColor);
  color: var(--fontActiveColor);
}
.dialog-foot {
  border-top: 1px solid var(--borderColor);
}
.plugin-dialog .button.small-btn {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  padding: 2px 10px;
  font-size: 11px;
  height: 22px;
  cursor: pointer;
}
.plugin-dialog .button.small-btn:hover {
  background-color: var(--menuActiveColor);
}
.plugin-config-input {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
}
.plugin-services {
  margin-top: 12px;
  font-size: 12px;
  opacity: 0.75;
}
.host-service {
  margin-left: 6px;
}
.plugin-reset-root {
  margin-left: 10px;
  cursor: pointer;
  text-decoration: underline;
  opacity: 0.85;
}
.plugin-reset-root:hover {
  color: var(--fontActiveColor);
}
/* 弹层遮罩：必须脱离列表滚动容器。
   插件列表在设置内容区（.settings-content）里滚动，若这里用 position:absolute，
   遮罩会跟着内容一起滚——插件多时（列表很长、已向下滚动）弹窗就跑到了视口上方，
   需要往上滑才看得见。改成 fixed 后弹窗永远居中在窗口里。
   z-index 取 1600：高于设置层（.set-overlay 1500），低于 Element Plus 消息框（2000+）。 */
.plugin-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1600;
}
.plugin-dialog {
  width: min(720px, 92%);
  max-height: 80%;
  background: var(--backgroundColor, #fff);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.dialog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--borderColor, #eee);
  font-size: 13px;
  font-weight: 600;
}
.dialog-head i {
  cursor: pointer;
  opacity: 0.6;
}
.plugin-log {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60vh;
}
.plugin-config-input {
  margin: 10px 12px;
  min-height: 220px;
  padding: 8px;
  border: 1px solid var(--borderColor, #ddd);
  border-radius: 4px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  resize: vertical;
  background: transparent;
  color: inherit;
}
.dialog-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--borderColor, #eee);
  font-size: 12px;
}
.dialog-foot .hint {
  opacity: 0.65;
}
</style>
