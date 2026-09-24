<!-- FileAssocSettings.vue - 设置 → 其他：文件关联（默认打开方式） -->
<template>
  <div class="file-assoc-settings">
    <div class="settings-group">
      <h3>{{ zh ? '文件关联（默认打开方式）' : 'File Associations (Default Apps)' }}</h3>

      <div class="form-group">
        <div class="config-description" style="margin-left:0">{{ intro }}</div>
      </div>

      <!-- 平台 / 开发版提示 -->
      <div class="form-group" v-for="(n, i) in notices" :key="'n' + i">
        <div class="config-description fa-notice" :class="n.type" style="margin-left:0">
          <i class="fa" :class="n.icon"></i> {{ n.text }}
        </div>
      </div>

      <div class="form-group" v-if="loading">
        <div class="config-description" style="margin-left:0">
          <i class="fa fa-spinner fa-spin"></i> {{ zh ? '正在读取系统关联状态…' : 'Reading system associations…' }}
        </div>
      </div>

      <template v-else-if="info && info.supported">
        <!-- 文件类型列表：一行 = label（类型名）+ 关联级别下拉 -->
        <div class="form-group" v-for="e in info.entries" :key="e.key">
          <label :title="labelTitle(e)">{{ zh ? e.labelZh : e.labelEn }}</label>
          <select
            v-if="isSelectable(e)"
            class="layout-select"
            :value="modeOf(e.key)"
            :disabled="busy"
            :title="selectTitle"
            @change="onChange(e, $event)"
          >
            <option value="none">{{ zh ? '不关联' : 'Not associated' }}</option>
            <option v-if="info.supportsOpenWith" value="openwith">{{ zh ? '加入「打开方式」' : 'Add to "Open with"' }}</option>
            <option value="default">{{ zh ? '设为默认打开方式' : 'Set as default' }}</option>
          </select>
          <div v-else class="config-description" style="margin-left:0">{{ unsupportedText }}</div>
          <span
            v-if="stateOf(e.key).userChoice"
            class="fa-warn"
            :title="userChoiceTitle(stateOf(e.key).userChoice)"
          ><i class="fa fa-exclamation-triangle"></i></span>
        </div>

        <div class="form-group">
          <label>{{ zh ? '操作' : 'Actions' }}</label>
          <div class="button-group">
            <div class="button" :class="{ disabled: busy }" @click="applyAll('default')" :title="applyAllTitle">
              <i class="fa fa-check-circle-o"></i> {{ zh ? '全部设为默认' : 'Set All Default' }}
            </div>
            <div class="button" :class="{ disabled: busy }" @click="applyAll('none')" :title="clearAllTitle">
              <i class="fa fa-eraser"></i> {{ zh ? '全部取消关联' : 'Clear All' }}
            </div>
            <div class="button" :class="{ disabled: busy }" @click="load()" :title="zh ? '重新读取系统状态' : 'Reload system state'">
              <i class="fa fa-refresh"></i> {{ zh ? '刷新状态' : 'Refresh' }}
            </div>
          </div>
        </div>

        <div class="form-group">
          <div class="config-description" style="margin-left:0">{{ footer }}</div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

const loading = ref(true)
const busy = ref(false)
const info = ref<any>(null)
const states = ref<Record<string, { mode: string; userChoice?: string }>>({})
const hasIpc = typeof window !== 'undefined' && !!(window as any).ipcRenderer

// ---------- 文案 ----------
const intro = computed(() => zh.value
  ? '选择哪些文件类型由本软件打开。安装版在安装时已注册这些类型（PDF 除外）；此处可随时调整（写入当前用户，无需管理员权限）。「设为默认」会让双击该类型文件直接在本软件的新窗口中打开。PDF 默认不关联，以免抢占系统 PDF 阅读器，需要时请在此手动选择。'
  : 'Choose which file types open with this app. The installer already registers them (except PDF); you can adjust at any time (current-user scope, no admin rights). "Set as default" makes double-click open the file in a new app window. PDF is deliberately not associated by default so your system PDF reader stays in charge — pick it here if you want it.')

const footer = computed(() => zh.value
  ? '提示：Windows 8 及以上版本中，若某类型已被用户通过「打开方式 → 始终使用此应用」选定过默认程序，系统会优先采用该选择（程序无法覆盖）——此时请右键文件 → 打开方式 → 选择其他应用 → AI-KM，并勾选「始终使用」。'
  : 'Note: on Windows 8+, if a default app was already chosen via "Open with → Always use this app", the system keeps that choice (apps cannot override it). In that case, right-click the file → Open with → Choose another app → AI-KM and check "Always use".')

const selectTitle = computed(() => zh.value
  ? '不关联：移除本软件对该类型的注册\n加入「打开方式」：右键「打开方式」列表中出现 AI-KM（不改变默认程序）\n设为默认：双击直接用本软件打开'
  : 'Not associated: remove this app\'s registration\nAdd to "Open with": show AI-KM in the right-click Open with list (does not change the default)\nSet as default: double-click opens with this app')

/** 常见系统默认程序的 ProgID → 友好名称（仅用于提示文案；未命中时原样显示 ProgID） */
const PROGID_NAMES: Record<string, string> = {
  MSEdgePDF: 'Microsoft Edge',
  AppXq0fevzme2pys62n3e0fbqa7peapykr8v: 'Microsoft Edge',
  ChromePDF: 'Google Chrome',
  ChromeHTML: 'Google Chrome',
}
function progIdName(p?: string) {
  const id = String(p || '').trim()
  if (!id) return id
  if (PROGID_NAMES[id]) return PROGID_NAMES[id]
  if (/^AcroExch\./i.test(id)) return 'Adobe Acrobat / Reader'
  if (/^MSEdge/i.test(id)) return 'Microsoft Edge'
  if (/^Chrome/i.test(id)) return 'Google Chrome'
  if (/^Firefox/i.test(id)) return 'Mozilla Firefox'
  if (/^FoxitReader/i.test(id)) return 'Foxit Reader'
  return id
}

const userChoiceTitle = (p?: string) => zh.value
  ? `系统记录的默认程序为「${progIdName(p)}」，Windows 会优先使用它；如需改用本软件，请在「打开方式」中选择 AI-KM 并勾选「始终使用」`
  : `Windows currently uses "${progIdName(p)}" as the default; to switch, pick AI-KM in "Open with" and check "Always use"`

const applyAllTitle = computed(() => zh.value ? '把所有类型设为默认打开方式' : 'Set every type as default')
const clearAllTitle = computed(() => zh.value ? '取消本软件对所有类型的注册（不删除系统文件）' : 'Remove all registrations (files are not deleted)')

const notices = computed(() => {
  const out: { type: string; icon: string; text: string }[] = []
  if (!hasIpc) {
    out.push({ type: 'error', icon: 'fa-desktop', text: zh.value
      ? '当前为浏览器 / LAN 模式，文件关联仅在桌面版可用。'
      : 'File associations are only available in the desktop app (not in browser/LAN mode).' })
    return out
  }
  const rc = info.value?.reasonCode
  if (info.value && !info.value.supported) {
    const text = rc === 'macos'
      ? (zh.value
        ? 'macOS 不支持在软件内修改默认打开方式：请在「访达」中右键文件 → 显示简介 → 打开方式，选择 AI-KM 后点「全部更改」。'
        : 'macOS does not allow apps to change the default handler: in Finder, right-click the file → Get Info → Open with, pick AI-KM, then click "Change All".')
      : rc === 'no-desktop-entry'
        ? (zh.value
          ? '未检测到 AI-KM.desktop 桌面条目：请使用 .deb 安装版；AppImage / 免安装版需先创建桌面快捷方式。'
          : 'No AI-KM.desktop entry found: please use the .deb package; AppImage/portable builds need a desktop shortcut first.')
        : (zh.value ? '当前平台不支持在软件内设置默认打开方式。' : 'Setting the default app is not supported on this platform.')
    out.push({ type: 'warn', icon: 'fa-info-circle', text })
  }
  if (info.value?.supported && !info.value.isPackaged) {
    out.push({ type: 'warn', icon: 'fa-flask', text: zh.value
      ? '当前为开发版：关联命令指向开发环境（electron.exe + 项目路径），双击文件会尝试启动开发版，仅供调试；正式使用请在安装版中设置。'
      : 'Development build: the association points to the dev environment (electron.exe + project path). For daily use, configure this in the installed build.' })
  }
  return out
})

// ---------- 状态读取 / 修改 ----------
const extText = (e: any) => (e.exts || []).map((x: string) => '.' + x).join(' ')

const stateOf = (key: string) => states.value[key] || { mode: 'none' }
const modeOf = (key: string) => stateOf(key).mode || 'none'
/** 该类型在当前平台是否可设置（Linux 上仅支持有 MIME 映射的类型） */
const isSelectable = (e: any) => !!info.value?.supported && (info.value.platform !== 'linux' || !!e.mime)
/** label 悬停提示：类型名 + 扩展名清单 */
const labelTitle = (e: any) => `${zh.value ? e.labelZh : e.labelEn}  ${extText(e)}`
const unsupportedText = computed(() => zh.value
  ? '该类型在 Linux 上由系统 MIME 数据库管理，暂不支持在此设置'
  : 'Managed by the system MIME database on Linux; not configurable here')

function applyState(data: any) {
  info.value = data
  states.value = { ...(data?.states || {}) }
}

async function load() {
  if (!hasIpc) { loading.value = false; return }
  loading.value = true
  try {
    const res: any = await (window as any).ipcRenderer.invoke('file-assoc:get-state')
    if (res?.ok) applyState(res.data)
    else ElMessage.error(res?.error?.message || (zh.value ? '读取文件关联失败' : 'Failed to read file associations'))
  } catch (err: any) {
    ElMessage.error(err?.message || (zh.value ? '读取文件关联失败' : 'Failed to read file associations'))
  } finally {
    loading.value = false
  }
}

async function setMode(key: string, mode: string) {
  busy.value = true
  try {
    const res: any = await (window as any).ipcRenderer.invoke('file-assoc:set', { key, mode })
    if (res?.ok) {
      applyState(res.data)
    } else {
      ElMessage.error(res?.error?.message || (zh.value ? '设置失败' : 'Failed to apply'))
      await load()
    }
  } catch (err: any) {
    ElMessage.error(err?.message || (zh.value ? '设置失败' : 'Failed to apply'))
    await load()
  } finally {
    busy.value = false
  }
}

async function onChange(entry: any, ev: Event) {
  const mode = (ev.target as HTMLSelectElement).value
  await setMode(entry.key, mode)
}

async function applyAll(mode: 'default' | 'none') {
  if (!info.value?.entries?.length) return
  busy.value = true
  try {
    for (const e of info.value.entries) {
      if (!isSelectable(e)) continue
      const res: any = await (window as any).ipcRenderer.invoke('file-assoc:set', { key: e.key, mode })
      if (res?.ok) applyState(res.data)
      else {
        ElMessage.error(res?.error?.message || (zh.value ? '设置失败' : 'Failed to apply'))
        break
      }
    }
    if (mode === 'default') {
      ElMessage.success(zh.value ? '已把支持的类型设为默认打开方式' : 'All supported types set as default')
    } else {
      ElMessage.success(zh.value ? '已取消本软件的文件关联' : 'Associations cleared')
    }
  } catch (err: any) {
    ElMessage.error(err?.message || (zh.value ? '设置失败' : 'Failed to apply'))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
/* ====== 容器（与设置页其余面板一致） ====== */
.file-assoc-settings { padding: 2px; }

/* ====== 分组 / 标题 ====== */
.settings-group { margin-bottom: 5px; padding: 8px; }
.settings-group:last-child { margin-bottom: 0; }
.settings-group h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}
.settings-group h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* ====== 表单行 ====== */
.form-group { display: flex; align-items: center; margin-bottom: 5px; }
.form-group > * { margin: 0; }
.form-group:last-child { margin-bottom: 0; }
.form-group label {
  width: 120px;
  min-width: 120px;
  color: var(--fontColor);
  font-size: 14px;
  user-select: none;
  line-height: 1;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.form-group select {
  flex: 1;
  padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  height: 33px;
  box-sizing: border-box;
}
.form-group select:focus { outline: none; border-color: var(--fontActiveColor); }
.form-group select:disabled { opacity: 0.5; cursor: not-allowed; }
.layout-select { flex: 1; min-width: 0; box-sizing: border-box; }

/* ====== 说明 / 提示 ====== */
.config-description {
  flex: 1;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  margin-left: 5px;
  line-height: 1.5;
}
.fa-notice { opacity: 0.9; }
.fa-notice i { margin-right: 4px; }
.fa-notice.warn { color: #e6a23c; }
.fa-notice.error { color: #e74c3c; }
.fa-warn { flex-shrink: 0; margin-left: 6px; color: #e6a23c; }

/* ====== 按钮 / 按钮组（与其它设置模块一致） ====== */
.button {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 14px;
  white-space: nowrap;
  width: calc(100% - 20px);
  margin: 0;
  padding: 6px 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button i { font-size: 14px; }
.button.disabled { opacity: 0.5; pointer-events: none; }
.button-group {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
}
.button-group .button { width: calc(100% - 14px); }
</style>
