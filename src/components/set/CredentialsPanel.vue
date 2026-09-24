<!-- CredentialsPanel.vue — 凭据管理（路线图 2.3：凭据接缝的 UI） -->
<!-- API key 明文只存主进程 credentials.json，这里只显示脱敏信息；模型配置可用 apiKeyRef 引用 -->
<template>
  <div class="credentials-panel">
    <div class="settings-group">
      <div class="cp-head">
        <h3>{{ isZh ? '凭据管理' : 'Credentials' }}</h3>
        <div class="button cp-refresh" @click="refresh" :title="isZh ? '重新读取凭据列表' : 'Reload credentials'">
          <i class="fa" :class="loading ? 'fa-spinner fa-spin' : 'fa-refresh'"></i>{{ isZh ? '刷新' : 'Refresh' }}
        </div>
      </div>

      <div class="form-group">
        <div class="config-description" style="margin-left:0">
          {{ isZh
            ? 'API Key 明文只保存在主进程 credentials.json 中，保存后无法查看；模型配置里用 apiKeyRef: <名称> 引用，避免把明文写进配置文件。'
            : 'Plaintext keys are stored only in the main process (credentials.json) and cannot be viewed after saving. Reference them in model config with apiKeyRef: <name> instead of an inline api_key.' }}
        </div>
      </div>

      <!-- 凭据表格：数据行 + 固定在最后一行的新增行 -->
      <div class="cp-table-wrap">
        <table class="cp-table">
          <colgroup>
            <col class="cp-w-idx" />
            <col class="cp-w-name" />
            <col class="cp-w-key" />
            <col class="cp-w-time" />
            <col class="cp-w-act" />
          </colgroup>
          <thead>
            <tr>
              <th class="cp-th-idx">{{ isZh ? '序号' : '#' }}</th>
              <th>{{ isZh ? '名称' : 'Name' }}</th>
              <th>API Key</th>
              <th>{{ isZh ? '更新时间' : 'Updated' }}</th>
              <th class="cp-th-act">{{ isZh ? '操作' : 'Actions' }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading && creds.length === 0">
              <td colspan="5" class="cp-tip">
                <i class="fa fa-spinner fa-spin"></i> {{ isZh ? '加载中…' : 'Loading…' }}
              </td>
            </tr>
            <tr v-else-if="creds.length === 0">
              <td colspan="5" class="cp-tip">
                {{ isZh ? '暂无凭据。在下方最后一行填写名称与 API Key，回车或点「＋」新增。' : 'No credentials yet. Fill the last row below, then press Enter or click +.' }}
              </td>
            </tr>
            <tr v-for="(c, i) in creds" :key="c.name">
              <td class="cp-idx">{{ i + 1 }}</td>
              <td class="cp-name" :title="c.name">{{ c.name }}</td>
              <td>
                <code class="cp-masked" :title="isZh ? '明文仅存主进程，不可查看' : 'Plaintext is main-process only'">{{ c.masked }}</code>
              </td>
              <td class="cp-time" :title="fmtFull(c.updatedAt)">{{ fmt(c.updatedAt) }}</td>
              <td class="cp-act">
                <div class="cp-act-box">
                  <div class="button cp-icon" :title="isZh ? '填入最后一行以便覆盖密钥' : 'Load into the add row below'" @click="startEdit(c.name)">
                    <i class="fa fa-pencil"></i>
                  </div>
                  <div class="button cp-icon cp-del" :title="isZh ? '删除' : 'Delete'" @click="onDelete(c.name)">
                    <i class="fa fa-trash"></i>
                  </div>
                </div>
              </td>
            </tr>

            <!-- 新增行：始终位于表格最下方，同名保存即覆盖 -->
            <tr class="cp-add-row">
              <td class="cp-idx cp-idx-add">+</td>
              <td>
                <input
                  ref="nameInput"
                  v-model="form.name"
                  :placeholder="isZh ? '填写名称' : 'name'"
                  @keyup.enter="focusKey"
                />
              </td>
              <td>
                <input
                  ref="keyInput"
                  v-model="form.value"
                  type="password"
                  :placeholder="isZh ? '填写 API Key' : 'API key'"
                  @keyup.enter="save"
                />
              </td>
              <td class="cp-time" :title="isZh ? '同名保存即覆盖旧密钥' : 'Saving an existing name overwrites its key'">{{ isZh ? '同名覆盖' : 'overwrite' }}</td>
              <td class="cp-act">
                <div class="cp-act-box">
                  <div
                    class="button cp-icon cp-add"
                    :class="{ disabled: saving }"
                    :title="isZh ? '新增 / 更新' : 'Add / Update'"
                    @click="save"
                  >
                    <i class="fa" :class="saving ? 'fa-spinner fa-spin' : 'fa-plus'"></i>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { usestore } from '@/store'
import { ElMessage } from 'element-plus'
import type { CredentialInfo } from '../../../electron/main/credentials'

const store = usestore()
const isZh = computed(() => store.locales === 'zh')

const creds = ref<CredentialInfo[]>([])
const loading = ref(false)
const saving = ref(false)
const form = ref({ name: '', value: '' })
const nameInput = ref<HTMLInputElement | null>(null)
const keyInput = ref<HTMLInputElement | null>(null)

/** 表格内短时间：MM-DD HH:mm（列窄，完整时间走 title 提示） */
const fmt = (ts: number): string => {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtFull = (ts: number): string => new Date(ts).toLocaleString()

/** 名称行回车 → 跳到密钥输入框 */
const focusKey = () => keyInput.value?.focus()

/** 编辑：把名称填进表格最后一行（同名保存即覆盖密钥） */
const startEdit = (name: string) => {
  form.value = { name, value: '' }
  keyInput.value?.focus()
}

const refresh = async () => {
  if (!window.dsh?.credentials) return
  loading.value = true
  try {
    creds.value = (await window.dsh.credentials.list()) || []
  } catch (e) {
    console.warn('[credentials] 拉取失败:', e)
  } finally {
    loading.value = false
  }
}

const save = async () => {
  if (!window.dsh?.credentials) return
  const name = form.value.name.trim()
  const value = form.value.value.trim()
  if (!name || !value) {
    ElMessage.warning(isZh.value ? '请填写凭据名称与 API Key' : 'Enter both a name and an API key')
    return
  }
  saving.value = true
  try {
    await window.dsh.credentials.set(name, value)
    form.value = { name: '', value: '' }
    await refresh()
    nameInput.value?.focus()
    ElMessage.success(isZh.value ? '凭据已保存' : 'Credential saved')
  } catch (e: any) {
    ElMessage.error((isZh.value ? '保存失败: ' : 'Save failed: ') + (e?.message || ''))
  } finally {
    saving.value = false
  }
}

const onDelete = async (name: string) => {
  if (!window.dsh?.credentials) return
  try {
    await window.dsh.credentials.delete(name)
    await refresh()
    ElMessage.success(isZh.value ? '凭据已删除' : 'Credential deleted')
  } catch (e: any) {
    ElMessage.error((isZh.value ? '删除失败: ' : 'Delete failed: ') + (e?.message || ''))
  }
}

onMounted(refresh)
</script>

<style scoped>
/* ====== 容器（与设置页其余面板一致） ====== */
.credentials-panel { padding: 2px; }

/* ====== 分组 / 标题 ====== */
.settings-group { margin-bottom: 5px; padding: 8px; }
.settings-group:last-child { margin-bottom: 0; }
.cp-head { position: relative; }
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

/* ====== 表单行（说明文字） ====== */
.form-group { display: flex; align-items: center; margin-bottom: 5px; }
.form-group > * { margin: 0; }
.form-group:last-child { margin-bottom: 0; }
.config-description {
  flex: 1;
  font-size: 10px;
  color: var(--fontColor);
  opacity: 0.7;
  margin-left: 5px;
  line-height: 1.5;
}

/* ====== 表格 ====== */
.cp-table-wrap {
  border: 1px solid var(--borderColor);
  border-radius: 6px;
  overflow: hidden;
}
.cp-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 13px;
  /* 全局 style.css 给 table 加了 border-top/left，与外层 .cp-table-wrap 外框重复 → 清零 */
  border: none;
  border-spacing: 0;
  background-color: transparent;
}
.cp-table th,
.cp-table td {
  /* 去掉全局 table td/th 的竖线（border-right），只保留行分隔线 */
  border-right: none;
  border-left: none;
  border-top: none;
}
.cp-table th {
  padding: 6px 8px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--fontColor);
  opacity: 0.75;
  background-color: var(--menuColor);
  border-bottom: 1px solid var(--borderColor);
  white-space: nowrap;
  user-select: none;
}
.cp-table td {
  padding: 0 8px;
  color: var(--fontColor);
  border-bottom: 1px solid var(--borderColor);
  vertical-align: middle;
}
/* 行高统一：新增行（内部输入框 26px）与凭据行等高 */
.cp-table tbody tr { height: 30px; }
.cp-table tbody tr:last-child td { border-bottom: none; }
.cp-table tbody tr:not(.cp-add-row):hover td { background-color: var(--menuActiveColor); }
.cp-w-idx { width: 44px; }
.cp-w-name { width: 28%; }
.cp-w-key { width: 34%; }
.cp-w-time { width: 96px; }
.cp-w-act { width: 72px; }
.cp-th-idx { text-align: center !important; }
.cp-th-act { text-align: center !important; }
.cp-idx {
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.5;
}
.cp-idx-add { font-size: 14px; opacity: 0.35; }
.cp-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 15px;
}
.cp-time {
  font-size: 10px;
  opacity: 0.55;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.cp-tip {
  padding: 6px 8px !important;
  font-size: 11px;
  opacity: 0.7;
  text-align: center;
}
.cp-masked {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: Consolas, Monaco, monospace;
  font-size: 14px;
  color: var(--fontColor);
  opacity: 0.85;
}

/* ====== 新增行（表格最下方一行）：无边框无底色，提示居中 ====== */
.cp-add-row td { padding: 0 8px; }
.cp-add-row input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  height: 26px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--fontColor);
  text-align: center;
  text-overflow: ellipsis;
  font-size: 15px;
  cursor: text;
}
.cp-add-row input:focus { outline: none; color: var(--fontActiveColor); }
.cp-add-row input::placeholder { text-align: center; opacity: 0.4; }

/* ====== 操作列 ====== */
.cp-act-box { display: flex; align-items: center; justify-content: center; gap: 2px; }

/* ====== 按钮（与其它设置模块一致；行内图标按钮必须写在 .button 之后并用双类名，
   否则会被 .button 的 100% 宽度覆盖） ====== */
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
  margin: 0;
  padding: 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button i { font-size: 14px; }
.button.disabled { opacity: 0.5; pointer-events: none; }
.button.cp-icon {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding: 0;
  flex-shrink: 0;
}
.button.cp-icon i { font-size: 12px; }
.button.cp-del:hover {
  color: #e74c3c;
  border-color: #e74c3c;
  background-color: var(--menuActiveColor);
}
.button.cp-add {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}

/* ====== 标题右上角刷新按钮 ====== */
.button.cp-refresh {
  position: absolute;
  top: -2px;
  right: 0;
  width: auto;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  gap: 4px;
  font-size: 12px;
}
.button.cp-refresh i { font-size: 11px; }
</style>
