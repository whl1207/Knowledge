<!--
  PluginPermissionsPanel.vue — 「设置 → 插件 → 权限」

  用途：把**用户能授予插件的东西**集中成一张表 —— 声明权限、委派同意、并发 / 每小时额度、本小时用量、
  以及「被委派的智能体能不能碰文件 / MCP 工具」。

  设计取舍：
  - 额度与放宽开关落在**主进程**（`electron/main/plugin-agent-config.ts`），读写都要 confirm；
    这一页只是它的界面，不做任何本地判定（否则就会出现"界面显示的和实际生效的不是一回事"）。
  - 默认值与面板出现之前**逐字节一致**（并发 1 / 每小时 20、放宽全关），所以没被调过的插件显示「默认」。
  - 「撤销自定义」走 `reset` 分支整条删掉配置，而不是写回默认值 —— 后者会让界面一直显示「已自定义」。
  - 每一行独立保存：改完点「保存」并确认，避免"改一下弹一次框"。
  - **外观照「插件 → 商店」那一页**（同一套主题变量与排版约定），表格按"每行约 30px"压紧。
-->
<template>
  <div class="plugin-perms">
    <div class="settings-group">
      <h3 class="pp-h3">
        <span>{{ zh ? '插件权限与额度' : 'Plugin permissions & budget' }}</span>
        <!-- 说明只留一个问号：悬浮显示。原来那两段常驻文字占掉了半屏，而它的受众是第一次打开的人 -->
        <i class="fa fa-question-circle pp-help" :title="helpText"></i>
      </h3>

      <div v-if="!supported" class="pp-empty">
        <i class="fa fa-plug"></i>
        {{ zh ? '当前环境不支持（委派需要桌面端：网页 / 移动端没有主进程来执行预算）。' : 'Not supported here — delegation needs the desktop app (web/mobile has no main process to enforce the budget).' }}
      </div>

      <template v-else>
        <div class="pp-actions">
          <div class="button small" style="margin:0px" :class="{ disabled: loading }" @click="reload">
            <i class="fa fa-refresh"></i> {{ zh ? '刷新' : 'Refresh' }}
          </div>
          <span class="pp-count">{{ zh ? `共 ${rows.length} 个插件` : `${rows.length} plugin(s)` }}</span>
        </div>

        <div v-if="!rows.length" class="pp-empty">
          <i class="fa fa-cube"></i> {{ zh ? '还没有已装的插件。' : 'No plugins installed yet.' }}
        </div>

        <div v-else class="pp-table-wrap">
          <table class="pp-table">
            <thead>
              <tr>
                <th>{{ zh ? '插件' : 'Plugin' }}</th>
                <th>{{ zh ? '声明权限' : 'Declared' }}</th>
                <th class="pp-th-icon" :title="zh ? '是否允许它调智能体（点击图标切换：每次询问 / 已允许 / 已拒绝）' : 'May it run agents (click the icon to cycle: ask / allow / deny)'">
                  <i class="fa fa-paper-plane"></i>
                </th>
                <th class="pp-th-icon" :title="zh ? '额度：并发 × 每小时（可改，改完点保存）· 本小时已用' : 'Budget: concurrency × per hour (editable, then save) · used this hour'">
                  <i class="fa fa-tachometer"></i>
                  <span class="pp-th-text">{{ zh ? '额度' : 'Budget' }}</span>
                </th>
                <th class="pp-th-icon" :title="zh ? '放宽被委派智能体的工具：文件 / MCP（需插件自己声明 fs；命令、代码、技能、递归委派不可放宽）' : 'Relax the delegated agent’s tools: files / MCP (needs the plugin to declare fs; shell, code, skills and recursion can never be relaxed)'">
                  <i class="fa fa-unlock-alt"></i>
                </th>
                <th class="pp-th-icon" :title="zh ? '工具审批：声明了 fs / shell 的插件，其工具默认要你确认（点击图标切换）' : 'Tool approval: plugins declaring fs / shell ask by default (click the icon to cycle)'">
                  <i class="fa fa-shield"></i>
                </th>
                <th class="pp-th-icon" :title="zh ? '保存 / 放弃（改了额度或开关才会出现）' : 'Save / discard (appears once you change a budget or switch)'">
                  <i class="fa fa-floppy-o"></i>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.pluginId" :class="{ 'pp-row-off': !row.agentRunDeclared, 'pp-row-dirty': isDirty(row) }">
                <td class="pp-plugin" :title="`${row.name} · ${row.pluginId} · ${row.status}`">
                  <span class="pp-name">
                    {{ row.name }}
                  </span>
                  <span v-if="row.customized" class="pp-badge pp-badge-custom" :title="zh ? '这一行的额度 / 开关被你改过' : 'You changed this row’s budget or switches'">{{ zh ? '已自定义' : 'custom' }}</span>
                  <span class="pp-id">{{ row.pluginId }} · {{ row.status }}</span>
                </td>

                <td class="pp-perms" :title="row.permissions.length ? row.permissions.join(zh ? '、' : ', ') : (zh ? '未声明任何权限' : 'no permissions declared')">
                  <span v-if="!row.permissions.length" class="pp-none">{{ zh ? '无' : 'none' }}</span>
                  <span v-for="p in row.permissions" :key="p" class="pp-badge" :class="{ 'pp-badge-key': p === 'agent.run' }">{{ p }}</span>
                </td>

                <!-- 委派同意：图标即状态（问号 / 绿勾 / 红禁），点击循环切换，标题说明当前与下一步 -->
                <td class="pp-center">
                  <button
                    class="pp-state"
                    :class="stateClass(row.consent)"
                    :disabled="!row.agentRunDeclared || busy === row.pluginId"
                    :title="consentTitle(row)"
                    @click="cycleConsent(row)"
                  >
                    <i class="fa" :class="stateIcon(row.consent)"></i>
                  </button>
                </td>

                <!-- 额度：并发 × 每小时 · 本小时已用（一行放下，全部有 title） -->
                <td class="pp-budget">
                  <input
                    class="pp-num"
                    type="number"
                    min="1"
                    max="3"
                    :disabled="!row.agentRunDeclared"
                    :value="draftOf(row).concurrency"
                    :title="zh ? '并发上限（默认 1，最大 3）' : 'Concurrency limit (default 1, max 3)'"
                    @input="edit(row, { concurrency: Number(($event.target as HTMLInputElement).value) })"
                  />
                  <span class="pp-sep">×</span>
                  <input
                    class="pp-num pp-num-wide"
                    type="number"
                    min="1"
                    max="200"
                    :disabled="!row.agentRunDeclared"
                    :value="draftOf(row).callsPerHour"
                    :title="zh ? '每小时调用上限（默认 20，最大 200）' : 'Calls per hour (default 20, max 200)'"
                    @input="edit(row, { callsPerHour: Number(($event.target as HTMLInputElement).value) })"
                  />
                  <span class="pp-usage" :title="zh ? '本小时已用 / 上限（滑动窗口）' : 'Used this hour / limit (sliding window)'">
                    <b>{{ row.callsInWindow }}</b><span v-if="row.inFlight" class="pp-inflight">+{{ row.inFlight }}</span>
                  </span>
                  <i
                    class="fa fa-refresh pp-icon-link"
                    :title="zh ? '重置用量（撞上限时不必干等窗口滑过）' : 'Reset usage (no need to wait out the window)'"
                    @click="onResetUsage(row)"
                  ></i>
                </td>

                <!-- 放宽开关：图标即开关，标题说明条件（fs 权限 / 只放行你配置并启用的 MCP） -->
                <td class="pp-relax">
                  <button
                    class="pp-toggle"
                    :class="[{ 'is-on': draftOf(row).relaxFs }, { 'is-off': !canRelaxFs(row) }]"
                    :disabled="!canRelaxFs(row) || busy === row.pluginId"
                    :title="fsTitle(row)"
                    @click="edit(row, { relaxFs: !draftOf(row).relaxFs })"
                  >
                    <i class="fa fa-file-text-o"></i>
                  </button>
                  <button
                    class="pp-toggle"
                    :class="[{ 'is-on': draftOf(row).relaxMcp }, { 'is-off': !row.agentRunDeclared }]"
                    :disabled="!row.agentRunDeclared || busy === row.pluginId"
                    :title="zh ? '允许被委派的智能体按 id 使用你在「MCP 服务」里配置并启用的服务' : 'Let the delegated agent use the MCP servers you configured and enabled, by id'"
                    @click="edit(row, { relaxMcp: !draftOf(row).relaxMcp })"
                  >
                    <i class="fa fa-plug"></i>
                  </button>
                </td>

                <!-- 工具审批：图标即状态，点击循环切换；标题列出会被问的工具 -->
                <td class="pp-center">
                  <button
                    class="pp-state"
                    :class="stateClass(row.toolApproval)"
                    :disabled="!row.approvalTools.length || busy === row.pluginId"
                    :title="toolApprovalTitle(row)"
                    @click="cycleToolApproval(row)"
                  >
                    <i class="fa" :class="stateIcon(row.toolApproval)"></i>
                  </button>
                </td>

                <!-- 保存 / 放弃 / 撤销自定义：纯图标，一行，无多余留白 -->
                <td class="pp-ops">
                  <template v-if="isDirty(row)">
                    <i class="fa fa-check pp-icon-link is-save" :title="zh ? '保存并确认' : 'Save and confirm'" @click="onSave(row)"></i>
                    <i class="fa fa-times pp-icon-link" :title="zh ? '放弃这次修改' : 'Discard these changes'" @click="discard(row)"></i>
                  </template>
                  <i
                    v-else-if="row.customized"
                    class="fa fa-undo pp-icon-link"
                    :title="zh ? '撤销自定义，回到默认（并发 1 / 每小时 20、放宽全关）' : 'Reset to defaults (1 concurrent / 20 per hour, all relaxations off)'"
                    @click="onResetConfig(row)"
                  ></i>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { usestore } from '@/store'
import {
  collectPluginAgentOverview,
  pluginAgentSupported,
  resetPluginAgentUsage,
  setPluginAgentConfig,
  setPluginAgentConsent,
  setPluginToolApproval,
  type PluginAgentOverviewRow,
} from '@/lib/plugin/pluginData'

const store = usestore()
const zh = computed(() => store.locales === 'zh')

/**
 * 这一页的全部说明（悬浮问号才显示）。
 *
 * 为什么收进 title：常驻两段文字要占掉半屏，而它的受众只有"第一次打开这一页的人"；
 * 用过一次之后，图标含义与额度上限都是噪音。
 */
const helpText = computed(() =>
  zh.value
    ? '这一页管的是「你授予了什么」——权限本身由插件清单声明，这里改不了。'
      + '三态图标：? 每次询问、✓ 已允许、⛔ 已拒绝，点一下切换（工具审批只管声明了 fs / shell 的插件，默认要问）。'
      + '额度＝并发 × 每小时（默认 1 / 20，上限 3 / 200），旁边是本小时已用，点 ↻ 重置。'
      + '两个放宽开关（文件 / MCP）默认关：文件还需插件自己声明 fs；MCP 只含你在「MCP 服务」里配置并启用的服务；'
      + '命令执行 / 代码执行 / 技能 / 递归委派不可放宽。'
      + '额度与开关都落在主进程、写入前要确认，卸载插件会一并清掉。'
    : 'This page is what you grant — the permissions themselves come from each plugin manifest and cannot be changed here. '
      + 'Tri-state icons: ? asks, ✓ allowed, ⛔ denied — click to cycle (tool approval only concerns plugins declaring fs / shell; they ask by default). '
      + 'Budget = concurrency × per hour (default 1 / 20, ceilings 3 / 200) with this hour’s usage beside it; click ↻ to reset. '
      + 'The two relaxation toggles (file / MCP) are off by default: file also requires the plugin to declare fs; MCP only covers servers you configured and enabled; '
      + 'shell / code execution / skills / recursive delegation can never be relaxed. '
      + 'Budgets and switches live in the main process, every write asks for confirmation, and uninstalling a plugin clears them.',
)
const supported = computed(() => pluginAgentSupported())

const rows = ref<PluginAgentOverviewRow[]>([])
const loading = ref(false)
/** 正在写盘的那一行（按钮禁用，防连点） */
const busy = ref('')

interface Draft {
  concurrency: number
  callsPerHour: number
  relaxFs: boolean
  relaxMcp: boolean
}
/** 只存被改动过的行；其余行直接读服务端值（避免"界面值"与"生效值"两套真相） */
const drafts = ref<Record<string, Draft>>({})

const draftOf = (row: PluginAgentOverviewRow): Draft =>
  drafts.value[row.pluginId] ?? {
    concurrency: row.limits.concurrency,
    callsPerHour: row.limits.callsPerHour,
    relaxFs: row.relax.fs,
    relaxMcp: row.relax.mcp,
  }

const isDirty = (row: PluginAgentOverviewRow): boolean => {
  const d = draftOf(row)
  return (
    d.concurrency !== row.limits.concurrency ||
    d.callsPerHour !== row.limits.callsPerHour ||
    d.relaxFs !== row.relax.fs ||
    d.relaxMcp !== row.relax.mcp
  )
}

const canRelaxFs = (row: PluginAgentOverviewRow): boolean => row.agentRunDeclared && row.permissions.includes('fs')

const fsTitle = (row: PluginAgentOverviewRow): string => {
  if (!row.agentRunDeclared) return zh.value ? '插件未声明 agent.run，委派不可用' : 'The plugin does not declare agent.run'
  if (!row.permissions.includes('fs')) return zh.value ? '插件没有声明 fs 权限，不能放宽文件工具（要放宽得先让它声明 fs）' : 'The plugin does not declare fs, so file tools cannot be relaxed'
  return zh.value
    ? '允许被委派的智能体读写文件。这是双条件：这里勾上，且插件自己声明了 fs 权限。'
    : 'Let the delegated agent read/write files. Two conditions: this box, plus the plugin declaring fs.'
}

const edit = (row: PluginAgentOverviewRow, patch: Partial<Draft>) => {
  drafts.value = { ...drafts.value, [row.pluginId]: { ...draftOf(row), ...patch } }
}

const discard = (row: PluginAgentOverviewRow) => {
  const next = { ...drafts.value }
  delete next[row.pluginId]
  drafts.value = next
}

const reload = async () => {
  loading.value = true
  try {
    rows.value = await collectPluginAgentOverview()
    drafts.value = {}
  } finally {
    loading.value = false
  }
}

onMounted(reload)

const onSave = async (row: PluginAgentOverviewRow) => {
  const d = draftOf(row)
  // 钳到面板承诺的区间（服务端还会再钳一次；这里只是别让用户看到自己填了 99 却生效 3）
  const limits = {
    concurrency: Math.max(1, Math.min(3, Math.floor(d.concurrency) || 1)),
    callsPerHour: Math.max(1, Math.min(200, Math.floor(d.callsPerHour) || 20)),
  }
  const relax = { fs: d.relaxFs, mcp: d.relaxMcp }
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `修改「${row.name}」的委派额度与放宽设置？\n副本：并发 ${limits.concurrency}、每小时 ${limits.callsPerHour} 次`
          + `\n放宽：文件工具 ${relax.fs ? '开' : '关'}、MCP ${relax.mcp ? '开' : '关'}`
          + (relax.fs || relax.mcp ? '\n\n注意：放宽后，被委派的智能体会拿到对应工具。' : '')
        : `Update delegation limits for “${row.name}”?\nConcurrency ${limits.concurrency}, ${limits.callsPerHour}/hour`
          + `\nRelaxation: file tools ${relax.fs ? 'on' : 'off'}, MCP ${relax.mcp ? 'on' : 'off'}`,
      zh.value ? '插件权限' : 'Plugin permissions',
      { type: 'warning', confirmButtonText: zh.value ? '确定' : 'OK', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  busy.value = row.pluginId
  try {
    const ok = await setPluginAgentConfig(row.pluginId, { limits, relax })
    if (ok) {
      ElMessage.success(zh.value ? '已保存' : 'Saved')
      await reload()
    } else {
      ElMessage.error(zh.value ? '保存失败（未连接到主进程？）' : 'Save failed (main process not reachable?)')
    }
  } finally {
    busy.value = ''
  }
}

const onResetConfig = async (row: PluginAgentOverviewRow) => {
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `把「${row.name}」的委派设置恢复成默认？\n并发 1、每小时 20 次、放宽全部关闭。`
        : `Reset “${row.name}” to defaults?\n1 concurrent, 20/hour, all relaxation off.`,
      zh.value ? '插件权限' : 'Plugin permissions',
      { type: 'warning', confirmButtonText: zh.value ? '确定' : 'OK', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  busy.value = row.pluginId
  try {
    const ok = await setPluginAgentConfig(row.pluginId, { reset: true })
    if (ok) {
      ElMessage.success(zh.value ? '已恢复默认' : 'Reset')
      await reload()
    } else {
      ElMessage.error(zh.value ? '操作失败' : 'Failed')
    }
  } finally {
    busy.value = ''
  }
}

/**
 * 改写**工具审批**三态。与委派同意同一口径：弹一次确认（主进程还会再确认一次），
 * 改完重载 —— 这一页不做任何本地判定，显示的就是主进程的实况。
 */
const onToolApproval = async (row: PluginAgentOverviewRow, state: 'allow' | 'ask' | 'deny') => {
  if (state === row.toolApproval) return
  const label =
    state === 'allow'
      ? zh.value ? '以后不再询问，直接允许' : 'allow without asking again'
      : state === 'deny'
        ? zh.value ? '不再询问，直接拒绝' : 'refuse without asking'
        : zh.value ? '每次调用都重新询问' : 'ask on every call'
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `把「${row.name}」的工具审批改成：${label}？\n（影响它的 ${row.approvalTools.length} 个工具：${row.approvalTools.join('、')}）`
        : `Set “${row.name}” tool approval to ${label}?`,
      zh.value ? '工具审批' : 'Tool approval',
      { type: 'warning', confirmButtonText: zh.value ? '确定' : 'OK', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  busy.value = row.pluginId
  try {
    const ok = await setPluginToolApproval(row.pluginId, state)
    if (ok) await reload()
    else ElMessage.error(zh.value ? '更新失败' : 'Update failed')
  } finally {
    busy.value = ''
  }
}

type TriState = 'allow' | 'ask' | 'deny'

/**
 * 三态控件的**纯展示层**：图标即状态，`title` 说明"现在是什么 + 点击会变成什么"。
 *
 * 为什么不用 `<select>`：这一页要压在一行里，而原生下拉在深色模式下是**白底下拉 + 继承来的
 * 白字**（面板把 background 覆盖成 transparent 时就更是如此）。图标按钮既避开这个坑，也比三选一
 * 的下拉窄得多。改状态仍走同一套确认流程（`onConsent` / `onToolApproval`），语义没变。
 */
const NEXT_STATE: Record<TriState, TriState> = { ask: 'allow', allow: 'deny', deny: 'ask' }
const stateIcon = (s: TriState) => (s === 'allow' ? 'fa-check-circle' : s === 'deny' ? 'fa-ban' : 'fa-question-circle')
const stateClass = (s: TriState) => (s === 'allow' ? 'is-allow' : s === 'deny' ? 'is-deny' : 'is-ask')
const stateLabel = (s: TriState) =>
  s === 'allow'
    ? zh.value ? '已允许' : 'allowed'
    : s === 'deny'
      ? zh.value ? '已拒绝' : 'denied'
      : zh.value ? '每次询问' : 'asks each time'
const nextLabel = (s: TriState) => stateLabel(NEXT_STATE[s])

const consentTitle = (row: PluginAgentOverviewRow) => {
  if (!row.agentRunDeclared) return zh.value ? '该插件未声明 agent.run，不能委派智能体' : 'This plugin does not declare agent.run'
  return zh.value
    ? `委派智能体：${stateLabel(row.consent)}（点击改为：${nextLabel(row.consent)}）`
    : `Agent delegation: ${stateLabel(row.consent)} (click for: ${nextLabel(row.consent)})`
}
const cycleConsent = (row: PluginAgentOverviewRow) => onConsent(row, NEXT_STATE[row.consent])

const toolApprovalTitle = (row: PluginAgentOverviewRow) => {
  if (!row.approvalTools.length) {
    return zh.value
      ? '该插件没有需要审批的工具（未声明 fs / shell）'
      : 'No tools need approval (the plugin declares no fs / shell)'
  }
  const list = row.approvalTools.join(zh.value ? '、' : ', ')
  return zh.value
    ? `工具审批：${stateLabel(row.toolApproval)}（点击改为：${nextLabel(row.toolApproval)}）\n会被问的工具：${list}`
    : `Tool approval: ${stateLabel(row.toolApproval)} (click for: ${nextLabel(row.toolApproval)})\nTools that ask: ${list}`
}
const cycleToolApproval = (row: PluginAgentOverviewRow) => onToolApproval(row, NEXT_STATE[row.toolApproval])

const onConsent = async (row: PluginAgentOverviewRow, consent: 'allow' | 'ask' | 'deny') => {
  if (consent === row.consent) return
  const label =
    consent === 'allow'
      ? zh.value ? '以后不再询问，直接允许' : 'allow without asking again'
      : consent === 'deny'
        ? zh.value ? '不再询问，直接拒绝' : 'refuse without asking'
        : zh.value ? '每次调用都重新询问' : 'ask on every call'
  try {
    await ElMessageBox.confirm(
      zh.value ? `把「${row.name}」的委派改成：${label}？` : `Set “${row.name}” delegation to ${label}?`,
      zh.value ? '委派同意' : 'Delegation consent',
      { type: 'warning', confirmButtonText: zh.value ? '确定' : 'OK', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  busy.value = row.pluginId
  try {
    const ok = await setPluginAgentConsent(row.pluginId, consent)
    if (ok) await reload()
    else ElMessage.error(zh.value ? '更新失败' : 'Update failed')
  } finally {
    busy.value = ''
  }
}

const onResetUsage = async (row: PluginAgentOverviewRow) => {
  try {
    await ElMessageBox.confirm(
      zh.value
        ? `重置「${row.name}」本小时的委派计数？\n（并发上限不受影响）`
        : `Reset the hourly delegation counter for “${row.name}”?`,
      zh.value ? '委派额度' : 'Delegation budget',
      { type: 'warning', confirmButtonText: zh.value ? '确定' : 'OK', cancelButtonText: zh.value ? '取消' : 'Cancel' },
    )
  } catch {
    return
  }
  busy.value = row.pluginId
  try {
    const ok = await resetPluginAgentUsage(row.pluginId)
    if (ok) {
      ElMessage.success(zh.value ? '已重置' : 'Reset')
      await reload()
    } else {
      ElMessage.error(zh.value ? '重置失败' : 'Reset failed')
    }
  } finally {
    busy.value = ''
  }
}
</script>

<style scoped>
/* 外观照「插件 → 商店」那一页（同一个设置区里的兄弟页）。
   主题变量由运行时注入：--fontColor / --fontActiveColor / --borderColor / --menuColor / --menuActiveColor。 */
.plugin-perms {
  color: var(--fontColor);
}
/* 内边距必须由组件自带：Set.vue 的 .settings-group 是 scoped 样式，不会作用到子组件内部 */
.plugin-perms .settings-group {
  padding: 8px;
  margin-bottom: 0;
}
/* 标题与其它设置页一致：强调色 + 左侧竖条 + 下边框 */
.plugin-perms h3 {
  position: relative;
  color: var(--fontActiveColor);
  margin: 0 0 10px 0;
  padding: 0 0 8px 10px;
  border-bottom: 1px solid var(--borderColor);
  font-size: 14px;
  font-weight: 600;
}
.plugin-perms h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--fontActiveColor);
}

/* ====== 标题右侧的问号（说明都挂它的 title 上）====== */
.pp-h3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pp-help {
  cursor: help;
  opacity: 0.55;
  font-size: 13px;
}
.pp-help:hover {
  opacity: 1;
  color: var(--fontActiveColor);
}

/* ====== 工具条与空态 ====== */
.pp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.pp-count {
  font-size: 11px;
  opacity: 0.6;
}
.pp-empty {
  padding: 14px;
  text-align: center;
  font-size: 12px;
  opacity: 0.7;
}
.pp-actions .button.small {
  padding: 2px 8px;
  font-size: 11px;
  height: 24px;
  cursor: pointer;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.pp-actions .button.small:hover {
  background-color: var(--menuActiveColor);
}
.pp-actions .button.small.disabled {
  opacity: 0.6;
  cursor: default;
}

/* ====== 表格 ======
   紧凑目标：行高由 20px 的控件撑起（整行 ≈30px），字号 11px，单元格内边距 3px/6px。 */
.pp-table-wrap {
  overflow-x: auto;
}
.pp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.pp-table th {
  text-align: left;
  padding: 4px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fontActiveColor);
  border-bottom: 1px solid var(--borderColor);
  white-space: nowrap;
}
/* 图标表头：宽度贴着内容（不写死宽度，否则带文字的「额度」会被裁掉），title 里是完整标题 */
.pp-table th.pp-th-icon {
  text-align: center;
  padding: 4px 2px;
  cursor: help;
  white-space: nowrap;
}
.pp-th-icon .pp-th-text {
  margin-left: 4px;
  font-weight: 600;
}
.pp-table td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--borderColor);
  vertical-align: middle;
  line-height: 1.3;
}
.pp-center {
  text-align: center;
}
.pp-table tbody tr:hover td {
  background-color: var(--menuActiveColor);
}
.pp-row-off td {
  opacity: 0.5;
}
.pp-row-dirty td {
  background-color: var(--menuColor);
}
/* 插件列：名称 + 徽章 + id · 状态**压成一行**（这一列一旦两行，整张表每行都会跟着变两行） */
.pp-plugin {
  white-space: nowrap;
}
.pp-name {
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
}
.pp-id {
  margin-left: 5px;
  font-size: 10px;
  opacity: 0.55;
  font-family: ui-monospace, Consolas, monospace;
}
/* 权限徽章：不换行（多了就裁掉，完整清单在 title 里）—— 同样是为了保住"一行" */
.pp-perms {
  max-width: 170px;
  white-space: nowrap;
  overflow: hidden;
}
.pp-none {
  opacity: 0.5;
}
.pp-badge {
  display: inline-block;
  padding: 0 5px;
  /* 不留底部外边距、并对齐中线：否则徽章会把行高顶高一点，"一行"就保不住了 */
  margin: 0 3px 0 0;
  vertical-align: middle;
  border: 1px solid var(--borderColor);
  border-radius: 8px;
  font-size: 10px;
  opacity: 0.85;
  white-space: nowrap;
}
.pp-badge-key {
  border-color: var(--fontActiveColor);
  color: var(--fontActiveColor);
}
.pp-badge-custom {
  border-color: #b45309;
  color: #b45309;
  margin-left: 4px;
}
/* 表单控件：**必须显式给背景与前景**。
   之前这里是 `background-color: transparent; color: inherit` —— 深色模式下原生输入/下拉
   的弹层是白底，而文字继承了 --fontColor（白），于是"白底白字"。
   全局 style.css 的 select 规则用的是 `color: var(--fontColor); background-color: var(--backgroundColor)`，
   这里跟着它走（两个变量随主题一起翻转，所以明暗两套都对）。 */
.pp-num {
  height: 20px;
  padding: 0 4px;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  box-sizing: border-box;
  width: 44px;
}
.pp-num-wide {
  width: 54px;
}

/* ====== 三态图标按钮（委派 / 工具审批）====== */
.pp-state {
  width: 22px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.pp-state:hover:not(:disabled) {
  background-color: var(--menuActiveColor);
}
.pp-state:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pp-state.is-allow {
  color: #16a34a;
  border-color: #16a34a;
}
.pp-state.is-deny {
  color: #e74c3c;
  border-color: #e74c3c;
}
.pp-state.is-ask {
  opacity: 0.75;
}

/* ====== 放宽开关（图标即开关）====== */
.pp-relax {
  white-space: nowrap;
}
.pp-toggle {
  width: 24px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0 3px 0 0;
  border: 1px solid var(--borderColor);
  border-radius: 4px;
  background-color: var(--backgroundColor);
  color: var(--fontColor);
  font-size: 11px;
  line-height: 1;
  opacity: 0.45;
  cursor: pointer;
}
.pp-toggle.is-on {
  opacity: 1;
  color: var(--fontActiveColor);
  border-color: var(--fontActiveColor);
}
.pp-toggle.is-off {
  opacity: 0.3;
  cursor: not-allowed;
}
.pp-toggle:hover:not(:disabled) {
  background-color: var(--menuActiveColor);
}

/* ====== 行内图标动作（重置 / 保存 / 放弃 / 撤销自定义）====== */
.pp-icon-link {
  cursor: pointer;
  opacity: 0.55;
  font-size: 12px;
  padding: 0 2px;
}
.pp-icon-link:hover {
  opacity: 1;
  color: var(--fontActiveColor);
}
.pp-icon-link.is-save:hover {
  color: #16a34a;
}

/* 额度列：并发 × 每小时 · 本小时已用 + 重置，全部一行 */
.pp-budget {
  white-space: nowrap;
}
.pp-sep {
  opacity: 0.5;
  margin: 0 3px;
}
.pp-usage {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}
.pp-inflight {
  opacity: 0.6;
  margin-left: 2px;
}
/* 动作列：贴住图标宽度（不占一整列的文字宽度），改了才出现内容 —— 没有留白 */
.pp-ops {
  width: 1%;
  white-space: nowrap;
  text-align: right;
  padding-left: 2px;
}
</style>
