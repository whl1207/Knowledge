<!-- 协作设置模块（独立 vue）：一个组件承载协作一级分组下的三个子页，由 section 决定渲染哪一块：
       share = 共享（局域网共享 + 共享文件夹）｜ collab = 协同（协同文件编辑）｜ perm = 权限（局域网访客白名单）。
     状态与 IPC 调用集中在这里，避免三个子页各持一份（端口探测 / 服务启停 / 令牌生成）。 -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { buildLanEmbedPayload, buildLanLlmPayload } from '@/platform/lanKb'
import { pushLanGuestPolicy } from '@/platform/lanGuestSync'
import { AGENT_TOOL_REGISTRY } from '@/services/agentSkills'
import {
  LAN_GUEST_DANGEROUS_TOOLS,
  LAN_GUEST_MODES,
  LAN_GUEST_READONLY_TOOLS,
  LAN_GUEST_SANDBOX_OPTIONS,
  LAN_GUEST_FS_OPTIONS,
  defaultLanGuestPolicy,
  effectiveGuestTools,
  normalizeLanGuestPolicy,
} from '@/shared/lanGuest'
import { llmSourceLabel, normalizeLlmType } from '@/shared/llmSources'
import { presetPresentation } from '@/lib/agent/ptc'
import { getPlatform, hasCapability } from '@/platform'

interface Props {
  store: any
  /** 只渲染哪一块：share=共享 / collab=协同 / perm=权限（省略时三块全渲染，兼容旧调用） */
  section?: 'share' | 'collab' | 'perm' | ''
}
const props = defineProps<Props>()
const store = props.store
const t = (zh: string, en: string): string => (store.locales === 'zh' ? zh : en)

// 分节显隐（省略 section 时三块全显示）
const sec = computed(() => props.section || '')
const showShare = computed(() => !sec.value || sec.value === 'share')
const showCollab = computed(() => !sec.value || sec.value === 'collab')
const showPerm = computed(() => !sec.value || sec.value === 'perm')

// ==================== 局域网共享（静态网页分享） ====================
const lanServerRunning = ref(false)
const lanServerPort = ref(3345)
const lanServerIPs = ref<string[]>([])
// 知识库共享目录（存于 store.lan.kbDir，同时同步到主进程供 LAN HTTP 服务读取）
// 防御：旧存档/异常情况 store.lan 缺失时先补齐默认结构
if (!store.lan) store.lan = { kbDir: '', guest: defaultLanGuestPolicy(), guestVersion: 2 }
if (!store.lan.guest) store.lan.guest = normalizeLanGuestPolicy(null)
const lanKbDir = ref<string>(store.lan?.kbDir || '')

// 监听局域网服务器状态变化
const unsubLan: Array<() => void> = []
if (hasCapability('events.bus')) {
  unsubLan.push(getPlatform().events.on('lan-server-status', (status: any) => {
    lanServerRunning.value = status.running
    lanServerPort.value = status.port
    lanServerIPs.value = status.ips
  }))
}

// 获取局域网服务器状态
const refreshLanServerInfo = async () => {
  if (!hasCapability('host.lanShare')) return
  try {
    const info = await getPlatform().host.lan.getServerInfo()
    lanServerRunning.value = info.running
    lanServerPort.value = info.port
    lanServerIPs.value = info.ips
  } catch (e) {
    console.error('获取局域网服务器信息失败:', e)
  }
}

// 把「知识库共享目录 + 主机嵌入配置」同步到主进程（LAN HTTP 服务据此提供 /api/kb/*）
const syncLanKbToMain = async () => {
  if (!hasCapability('host.lanShare')) return
  try {
    await getPlatform().host.lan.setKbDir(lanKbDir.value || '')
    // 主机嵌入配置：供远端网页端对共享 .kb 做向量检索（维度与建库模型一致）
    await getPlatform().host.lan.setEmbed(JSON.parse(JSON.stringify(buildLanEmbedPayload(store))))
  } catch (e) {
    console.warn('同步局域网知识库配置失败:', e)
  }
}

/**
 * 把「访客权限策略 + 主机模型」同步到主进程（P3/P4）：
 * 主进程据此校验访问令牌、限制并发，并给网页端智能体会话兑上主机模型与工具白名单。
 */
const syncLanGuestToMain = async () => {
  if (!hasCapability('host.lanShare')) return
  try {
    // 单一入口：策略 + 主机模型 + 可用智能体档案（见 src/platform/lanGuestSync.ts）
    await pushLanGuestPolicy(store)
  } catch (e: any) {
    console.warn('[lan-guest] 下发访客权限失败:', e)
  }
  // 回读主机侧实际生效的模型（权限页「模型」一项显示「当前生效」用）
  await refreshGuestActiveModel()
}

// 选择知识库共享目录
const chooseLanKbDir = async () => {
  if (!hasCapability('dialog.native')) return
  try {
    const p = await getPlatform().dialog.pickDirectory()
    if (p) {
      lanKbDir.value = p
      store.lan.kbDir = p
      store.saveConfig()
      await syncLanKbToMain()
      ElMessage.success(t('知识库共享目录已设置', 'KB share folder set'))
    }
  } catch (e) {
    console.error('选择知识库共享目录失败:', e)
  }
}

// 启动局域网共享（启动前同步知识库目录/嵌入配置与访客权限，网页端即可使用）
const startLanServer = async () => {
  if (!hasCapability('host.lanShare')) return
  try {
    await syncLanKbToMain()
    await syncLanGuestToMain()
    const result = await getPlatform().host.lan.startServer(lanServerPort.value)
    if (result.success) {
      // 主动回读一次状态（不依赖推送时序），端口顺延/地址列表也能立即显示
      await refreshLanServerInfo()
      ElMessage.success(t('局域网共享已启动', 'LAN sharing started'))
    } else {
      ElMessage.error(t('启动失败: ', 'Start failed: ') + result.error)
    }
  } catch (e: any) {
    ElMessage.error(t('启动失败: ', 'Start failed: ') + e.message)
  }
}

// 停止局域网共享
const stopLanServer = async () => {
  if (!hasCapability('host.lanShare')) return
  try {
    const result = await getPlatform().host.lan.stopServer()
    if (result.success) {
      await refreshLanServerInfo()
      ElMessage.success(t('局域网共享已停止', 'LAN sharing stopped'))
    }
  } catch (e: any) {
    ElMessage.error(t('停止失败: ', 'Stop failed: ') + e.message)
  }
}

// ==================== 协同文件编辑服务 ====================
const collabServerRunning = ref(false)
const collabServerPort = ref(3346)
const collabServerIPs = ref<string[]>([])

// 协同服务运行状态 ⇄ 「显示协同入口」开关：运行中即启用，停止即关闭
const syncCollabEnabled = (running: boolean) => {
  if (store.collab.enabled !== running) {
    store.collab.enabled = running
    store.saveConfig()
  }
}

if (window.dsh?.collab) {
  window.dsh.collab.onStatus((status: any) => {
    collabServerRunning.value = status.running
    collabServerPort.value = status.port
    collabServerIPs.value = status.ips
    syncCollabEnabled(status.running)
  })
}

const refreshCollabServerInfo = async () => {
  if (!window.dsh?.collab) return
  try {
    const info = await window.dsh.collab.getStatus()
    collabServerRunning.value = info.running
    collabServerPort.value = info.port
    collabServerIPs.value = info.ips
    syncCollabEnabled(info.running)
  } catch (e) {
    console.error('获取协同服务信息失败:', e)
  }
}

const startCollabServer = async () => {
  if (!window.dsh?.collab) {
    ElMessage.error(t('协同服务不可用', 'Collab service unavailable'))
    return
  }
  try {
    const result = await window.dsh.collab.start({
      port: store.collab.port,
      maxMembers: store.collab.maxMembers,
      permissionMode: store.collab.permissionMode,
    })
    if (result.success) {
      ElMessage.success(t('协同服务已启动', 'Collab service started'))
      syncCollabEnabled(true)
      if (result.port) {
        store.collab.port = result.port
        store.saveConfig()
      }
    } else {
      ElMessage.error(t('启动失败: ', 'Start failed: ') + result.error)
    }
  } catch (e: any) {
    ElMessage.error(t('启动失败: ', 'Start failed: ') + e.message)
  }
}

const stopCollabServer = async () => {
  if (!window.dsh?.collab) return
  try {
    const result = await window.dsh.collab.stop()
    if (result.success) {
      ElMessage.success(t('协同服务已停止', 'Collab service stopped'))
      syncCollabEnabled(false)
    }
  } catch (e: any) {
    ElMessage.error(t('停止失败: ', 'Stop failed: ') + e.message)
  }
}

const regenerateCollabToken = () => {
  const chars = '0123456789abcdef'
  let token = ''
  for (let i = 0; i < 8; i++) token += chars[Math.floor(Math.random() * chars.length)]
  store.collab.token = token
  store.saveConfig()
  ElMessage.success(t('已生成新的房间 Token', 'New room token generated'))
}

// ==================== 远程文件共享（共享文件夹，客户端可只读预览/下载） ====================
const remoteFsRunning = ref(false)
const remoteFsPort = ref(3347)
const remoteFsIPs = ref<string[]>([])

if (window.dsh?.remoteFs) {
  window.dsh.remoteFs.onStatus((status: any) => {
    remoteFsRunning.value = status.running
    remoteFsPort.value = status.port
    remoteFsIPs.value = status.ips
  })
}

const refreshRemoteFsInfo = async () => {
  if (!window.dsh?.remoteFs) return
  try {
    const info = await window.dsh.remoteFs.getStatus()
    remoteFsRunning.value = info.running
    remoteFsPort.value = info.port
    remoteFsIPs.value = info.ips
  } catch (e) {
    console.error('获取远程文件共享信息失败:', e)
  }
}

const chooseRemoteFsRoot = async () => {
  const path = await getPlatform().dialog.pickDirectory()
  if (path) {
    store.remoteFs.rootDir = path
    store.saveConfig()
  }
}

const startRemoteFsServer = async () => {
  if (!window.dsh?.remoteFs) {
    ElMessage.error(t('远程文件共享服务不可用', 'Remote FS service unavailable'))
    return
  }
  if (!store.remoteFs.rootDir) {
    ElMessage.warning(t('请先选择要共享的文件夹', 'Choose a folder to share first'))
    return
  }
  try {
    const result = await window.dsh.remoteFs.start({
      port: store.remoteFs.port,
      rootDir: store.remoteFs.rootDir,
      token: store.remoteFs.token || undefined,
    })
    if (result.success) {
      if (result.port) store.remoteFs.port = result.port
      if (result.token) store.remoteFs.token = result.token
      store.remoteFs.enabled = true
      store.saveConfig()
      ElMessage.success(t('远程文件共享已启动', 'Remote FS started'))
    } else {
      ElMessage.error(t('启动失败: ', 'Start failed: ') + result.error)
    }
  } catch (e: any) {
    ElMessage.error(t('启动失败: ', 'Start failed: ') + e.message)
  }
}

const stopRemoteFsServer = async () => {
  if (!window.dsh?.remoteFs) return
  try {
    const result = await window.dsh.remoteFs.stop()
    if (result.success) {
      store.remoteFs.enabled = false
      store.saveConfig()
      ElMessage.success(t('远程文件共享已停止', 'Remote FS stopped'))
    }
  } catch (e: any) {
    ElMessage.error(t('停止失败: ', 'Stop failed: ') + e.message)
  }
}

const regenerateRemoteFsToken = () => {
  const chars = '0123456789abcdef'
  let token = ''
  for (let i = 0; i < 12; i++) token += chars[Math.floor(Math.random() * chars.length)]
  store.remoteFs.token = token
  store.saveConfig()
  ElMessage.success(t('已生成新的访问 Token', 'New access token generated'))
}

// ==================== 权限（局域网访客能力白名单） ====================
// 访客 = 用浏览器打开共享地址的人。网页端没有文件/执行能力，能做什么完全由这份策略决定。
// 默认全只读（仅普通对话 + 知识库检索 = 今天的行为）；写入 / 执行 / 外部调用都要在这里显式允许。
// 数据模型见 src/shared/lanGuest.ts（后续主进程 /api/agent/* 直接消费同一份）。
const guest = store.lan.guest

/** 访客当前允许的工具集合（null / 非数组时回默认只读集） */
const guestTools = ref<Set<string>>(new Set(Array.isArray(guest.tools) ? guest.tools : LAN_GUEST_READONLY_TOOLS))

/** 工具行（数据源与「工具 → 管理」「Agent 预设 → 工具」一致；高危项标红） */
const guestToolRows = computed(() => AGENT_TOOL_REGISTRY.map((tol: any) => {
  const label = store.locales === 'zh' ? (tol.labelZh || tol.name) : (tol.labelEn || tol.name)
  return {
    name: tol.name,
    label,
    /** 悬停说明：名称（工具名）+ 功能说明 */
    title: `${label}（${tol.name}）：${tol.description || ''}`,
    description: tol.description || '',
    danger: LAN_GUEST_DANGEROUS_TOOLS.has(tol.name),
    on: guestTools.value.has(tol.name),
  }
}))

const guestModeOn = (m: string) => Array.isArray(guest.modes) && guest.modes.includes(m)

/** 访客是否可用某 Agent 预设 */
const guestPresetOn = (id: string) => Array.isArray(guest.presetIds) && guest.presetIds.includes(id)

/** 可下发给访客的预设：PTC 预设不下发（访客档案是逐个调用的只读工具集，没有 run_code / SDK 段） */
const shareablePresets = computed(() =>
  (store.agentPresets || []).filter((p: any) => presetPresentation(p) !== 'ptc'))

/** 勾选/取消「访客可用智能体」（改动即时下发：主进程据此允许访客建对应预设会话） */
const toggleGuestPreset = (preset: any) => {
  const id = String(preset?.id || '')
  if (!id) return
  const next = new Set<string>(Array.isArray(guest.presetIds) ? guest.presetIds : [])
  if (next.has(id)) next.delete(id)
  else next.add(id)
  guest.presetIds = Array.from(next)
  store.saveConfig()
}

// ---------------- 访客智能体使用的模型（来源 + 模型） ----------------
// 网页端智能体跑在主机，模型与 Key 都不离开主机；这里只决定「用哪个来源的哪个模型」。
// 默认 guestLlmType = '' → 跟随主机当前激活来源与当前模型。

/** 可选来源：跟随主机（空值）+ 已启用内置来源 + 已启用自定义来源（custom:<索引>，各占一项） */
const guestLlmTypeOptions = computed(() => {
  const out: Array<{ value: string; label: string }> = []
  for (const type of (store.enabledLlmTypes || []) as string[]) {
    if (type === 'custom') continue
    out.push({ value: type, label: llmSourceLabel(type) })
  }
  const sources = (store.AIconfig.llm.custom?.sources || []) as any[]
  sources.forEach((src, i) => {
    if (store.isLlmSourceDisabled('custom', src?.id)) return
    const name = src?.name || src?.model || `#${i + 1}`
    out.push({ value: `custom:${i}`, label: `${t('自定义', 'Custom')}：${name}` })
  })
  return out
})

/** 指定来源下可用的模型名（未探测过则为空，仍可手输） */
const guestModelOptions = computed<string[]>(() => {
  const key = String(guest.guestLlmType || '')
  if (!key) return []
  const llm: any = store.AIconfig.llm
  if (key.startsWith('custom:')) {
    const i = parseInt(key.slice('custom:'.length), 10) || 0
    const src = llm.custom?.sources?.[i]
    return Array.isArray(src?.available_models) ? src.available_models : []
  }
  const type = normalizeLlmType(key)
  const cfg: any = llm?.[type] || {}
  const list = Array.isArray(cfg.available_models) ? [...cfg.available_models] : []
  // DeepSeek 单来源：两个接口样式的模型清单合并展示
  if (type === 'deepseek') {
    const other: any = llm?.deepseekResponses || {}
    for (const m of Array.isArray(other.available_models) ? other.available_models : []) {
      if (!list.includes(m)) list.push(m)
    }
  }
  return list
})

/** 该来源当前配置的模型（用于「留空 = …」提示） */
const guestSourceCurrentModel = computed<string>(() => {
  const key = String(guest.guestLlmType || '')
  const llm: any = store.AIconfig.llm
  if (!key) return String(llm?.[normalizeLlmType(llm.type)]?.model || '')
  if (key.startsWith('custom:')) {
    const i = parseInt(key.slice('custom:'.length), 10) || 0
    return String(llm.custom?.sources?.[i]?.model || '')
  }
  return String(llm?.[normalizeLlmType(key)]?.model || '')
})

const guestModelPlaceholder = computed(() => {
  if (guestSourceCurrentModel.value) {
    return t(`留空 = ${guestSourceCurrentModel.value}`, `Empty = ${guestSourceCurrentModel.value}`)
  }
  return t('留空 = 该来源当前模型', 'Empty = source default model')
})

/** 主机侧实际生效的访客模型（同步后回读确认，避免「设了却没生效」的疑问） */
const guestActiveModel = ref('')

/** 主动回读主机当前生效的访客模型 */
const refreshGuestActiveModel = async () => {
  if (!hasCapability('host.lanShare')) return
  try {
    const res = await getPlatform().host.lan.getGuest()
    applyGuestHostModel(res?.info)
  } catch (e: any) {
    console.warn('[lan-guest] 读取主机访客状态失败:', e)
  }
}

/** 把主进程回报的访客状态落到界面（推送与主动拉取共用） */
const applyGuestHostModel = (info: any) => {
  if (!info) return
  guestActiveModel.value = info.provider ? `${info.provider} / ${info.model || '—'}` : ''
}

/** 对话模式块的悬停说明：名称（策略值）+ 说明 */
const modeChipTitle = (m: any): string => {
  const name = store.locales === 'zh' ? m.zh : m.en
  const desc = store.locales === 'zh' ? m.zhDesc : m.enDesc
  return `${name}（${m.value}）：${desc}`
}

/** 预设块的悬停说明：名称（预设 id）+ 标签 + 提示词摘要 */
const presetChipTitle = (p: any): string => {
  const name = String(p?.name || p?.id || '')
  const id = p?.id ? `（${p.id}）` : ''
  const tags = Array.isArray(p?.tags) && p.tags.length ? `[${p.tags.join(' / ')}] ` : ''
  const prompt = String(p?.systemPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return [name + id, tags + prompt].filter(Boolean).join('：')
}

// 主进程每次收到策略就回推一次生效状态 → 设置页不需要自己轮询
if (hasCapability('events.bus')) {
  unsubLan.push(getPlatform().events.on('lan:guest-state', (info: any) => applyGuestHostModel(info)))
}

/** 权限页各行的悬停说明（页面上只留控件，说明统一走 title） */
const permHints = computed(() => ({
  section: t(
    '网页端访客没有本地文件与执行能力，能做什么完全由这里决定。默认只读：只有普通对话与知识库检索；任何写入 / 执行 / 外部调用都需要在此显式允许，需要时再开启访问令牌。\n\n说明：文件「编辑权限」（开放 / 批准 / 只读）在「协同」页；三种服务（局域网共享 / 协同 / 共享文件夹）的令牌互相独立；本页设置只影响局域网访客，不改变本机任何行为。',
    'Remote browser guests have no local file or execution access — what they may do is decided here. Read-only by default (plain chat and KB search only); any write / execution / external call must be explicitly allowed, and keeping the token required is recommended.\n\nNote: file editing permission (open / approve / read-only) lives under Collaborative Editing; each of the three services has its own token; these settings only affect LAN guests and never change local behaviour.',
  ),
  tools: t(
    '仅在开启「智能体」模式后生效（技能已并入智能体：勾选 skill 工具后，访客用 $技能名 即可触发主机技能）。带「高危」标记的写入 / 执行 / 外部调用类工具默认关闭，开启需二次确认。勾选预设时，访客实际可用工具 = 预设能力 ∩ 本白名单。',
    'Only applies when Agent mode is on (skills live inside Agent: enable the skill tool so guests can trigger host skills via $name). Tools marked “Risky” (write / execute / external calls) are off by default and need confirmation to enable. With a preset selected, effective tools = preset capabilities ∩ this whitelist.',
  ),
  modelSource: t(
    '网页端智能体在主机上执行，这里决定用哪个模型来源；默认跟随主机当前激活来源。',
    'Guest agents run on the host — this picks which model source they use. Default follows the host’s active source.',
  ),
  model: [
    t(
      '留空 = 使用该来源当前配置的模型；可下拉选择已探测到的模型，也可直接输入模型名。',
      'Empty = the source’s currently configured model. Pick a detected model or type a name.',
    ),
    guestActiveModel.value ? t(`当前生效：${guestActiveModel.value}`, `Active: ${guestActiveModel.value}`) : '',
  ].filter(Boolean).join('\n'),
  sandbox: t('只能比「其他 → 安全策略」更严格', 'Can only be stricter than the global policy'),
  token: t(
    '默认不需要（局域网内直接访问）；需要时开启，访客访问共享地址需携带下方令牌',
    'Off by default (LAN access is direct); when on, guests must send the token below',
  ),
  guestModel: t('默认用主机模型（访客无需配置 Key）', 'Host model by default (guests need no key)'),
  maxSteps: t(
    '通用智能体单轮最大步数（防死循环）；预设按它自己的循环轮数',
    'Max steps per guest turn (prevents endless loops); presets use their own loop count',
  ),
  concurrency: t(
    '同时允许的访客任务数（保护主机模型 / GPU）；普通对话、知识库检索与访客智能体共用这个额度',
    'Concurrent guest tasks (protects the host model / GPU); plain chat, KB search and guest agents share this quota',
  ),
}))

/** 切换来源时清空手指定模型（否则会带着上一条来源的模型名） */
const onGuestLlmTypeChange = () => {
  guest.guestLlmModel = ''
  store.saveConfig()
}

const toggleGuestMode = (m: string) => {
  const list: string[] = Array.isArray(guest.modes) ? [...guest.modes] : []
  const i = list.indexOf(m)
  if (i >= 0) list.splice(i, 1)
  else list.push(m)
  guest.modes = list
  store.saveConfig()
}

/** 工具开关：高危工具（写入 / 执行 / 外部调用）开启时二次确认 */
const toggleGuestTool = async (row: any) => {
  const next = new Set(guestTools.value)
  if (next.has(row.name)) {
    next.delete(row.name)
  } else {
    if (row.danger) {
      try {
        await ElMessageBox.confirm(
          t(
            `「${row.label}」会让局域网访客在主机上写入文件 / 执行代码或调用外部能力，存在安全风险。\n确认允许？`,
            `“${row.label}” lets LAN guests write files, run code or call external services on the host — this is risky.\nAllow it?`,
          ),
          t('允许高危工具？', 'Allow dangerous tool?'),
          { type: 'warning', confirmButtonText: t('允许', 'Allow'), cancelButtonText: t('取消', 'Cancel') },
        )
      } catch { return /* 用户取消 */ }
    }
    next.add(row.name)
  }
  guestTools.value = next
  guest.tools = Array.from(next)
  store.saveConfig()
}

const regenerateGuestToken = () => {
  const chars = '0123456789abcdef'
  let token = ''
  for (let i = 0; i < 12; i++) token += chars[Math.floor(Math.random() * chars.length)]
  guest.token = token
  store.saveConfig()
  ElMessage.success(t('已生成新的访客令牌', 'New guest token generated'))
}

// 开启「需要令牌」时若尚无令牌则自动生成一个，避免开了开关却无可用的凭证
const setRequireToken = (value: boolean) => {
  guest.requireToken = value
  if (value && !guest.token) {
    const chars = '0123456789abcdef'
    let token = ''
    for (let i = 0; i < 12; i++) token += chars[Math.floor(Math.random() * chars.length)]
    guest.token = token
  }
  store.saveConfig()
}

const copyGuestToken = () => {
  if (!guest.token) { ElMessage.warning(t('请先生成令牌', 'Generate a token first')); return }
  void copyToClipboardText(guest.token)
}

/** 「访问令牌」下拉（不需要 / 需要令牌） */
const onRequireTokenChange = (e: Event) => {
  setRequireToken((e.target as HTMLSelectElement).value === '1')
}

/** 「访客自带模型」下拉（禁止 / 允许） */
const onAllowGuestModelChange = (e: Event) => {
  guest.allowGuestModel = (e.target as HTMLSelectElement).value === '1'
  store.saveConfig()
}

// ==================== 连接信息复制 ====================
const copyToClipboardText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(t('链接已复制', 'Link copied'))
  } catch {
    ElMessage.error(t('复制失败', 'Copy failed'))
  }
}
const copyLanLink = (ip: string) => copyToClipboardText(lanShareUrl(ip))

/** 共享地址：开启「访问令牌」时带上 ?token=（首次访问换 Cookie，后续请求自动携带） */
const lanShareUrl = (ip: string) => {
  const base = `http://${ip}:${lanServerPort.value}`
  if (!guest.requireToken || !guest.token) return base
  return `${base}/?token=${encodeURIComponent(guest.token)}`
}
const copyCollabLink = (ip: string) => copyToClipboardText(`ws://${ip}:${collabServerPort.value}/collab/<房间号>?token=${store.collab.token || ''}`)
const copyRemoteFsLink = (ip: string) => copyToClipboardText(`remote-fs://${ip}:${remoteFsPort.value}?token=${store.remoteFs.token || ''}`)

// 初始化：刷新三项服务状态 + 把知识库目录/嵌入配置与访客权限同步到主进程
onMounted(async () => {
  await refreshLanServerInfo()
  await refreshCollabServerInfo()
  await refreshRemoteFsInfo()
  await syncLanKbToMain()
  await syncLanGuestToMain()
})

// 访客权限任一改动即时下发主进程（令牌校验 / 并发上限 / 工具白名单随之生效，无需重启共享）
watch(guest, () => { void syncLanGuestToMain() }, { deep: true })

onBeforeUnmount(() => {
  unsubLan.forEach(fn => { try { fn() } catch { /* ignore */ } })
})
</script>

<template>
  <div class="settings-section collab-settings">
    <!-- 局域网共享（网页端访问入口；含知识库共享目录） -->
    <div v-if="showShare" class="settings-group">
      <h3>{{ store.locales=='zh'?'局域网共享' : 'LAN Sharing' }}</h3>
      <!-- 操作（第一行，状态显示在操作右侧） -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'操作' : 'Actions' }}</label>
        <div class="action-with-status">
          <div class="button-group">
            <div v-if="!lanServerRunning" class="button" @click="startLanServer"
                 :title="store.locales=='zh'?'启动局域网共享' : 'Start LAN sharing'">
              <i class="fa fa-globe"></i> {{ store.locales=='zh'?'启动共享' : 'Start' }}
            </div>
            <div v-if="lanServerRunning" class="button" @click="stopLanServer"
                 :title="store.locales=='zh'?'停止局域网共享' : 'Stop LAN sharing'">
              <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止共享' : 'Stop' }}
            </div>
            <div class="button" @click="refreshLanServerInfo"
                 :title="store.locales=='zh'?'刷新状态' : 'Refresh status'">
              <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'刷新' : 'Refresh' }}
            </div>
          </div>
          <div class="status-indicator" :class="{ online: lanServerRunning, offline: !lanServerRunning }">
            <i :class="lanServerRunning ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
            <span>{{ lanServerRunning
              ? (store.locales=='zh' ? '已启动' : 'Running')
              : (store.locales=='zh' ? '未启动' : 'Stopped') }}</span>
            <span v-if="lanServerRunning && lanServerPort" class="status-port">:{{ lanServerPort }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'端口' : 'Port' }}</label>
        <input v-model.number="lanServerPort" type="number" min="1024" max="65535"
               :disabled="lanServerRunning"
               :placeholder="store.locales=='zh'?'端口号' : 'Port number'"/>
      </div>
      <!-- 知识库共享目录（网页端知识库模式可选择该目录里的 .kb） -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'知识库目录' : 'KB Folder' }}</label>
        <div class="input-with-button">
          <input v-model="lanKbDir" readonly
                 :placeholder="store.locales=='zh'?'选择放置 .kb 知识库的文件夹' : 'Choose folder containing .kb files'"/>
          <div class="button" style="width:auto;padding:0 8px;" @click="chooseLanKbDir"
               :title="store.locales=='zh'?'选择文件夹':'Choose folder'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div v-if="lanServerRunning && lanServerIPs.length > 0" class="form-group">
        <label>{{ store.locales=='zh'?'访问地址' : 'Access URL' }}</label>
        <div class="lan-addresses">
          <div v-for="ip in lanServerIPs" :key="ip" class="lan-address-item">
            <i class="fa fa-globe"></i>
            <code class="lan-link-code" :title="store.locales=='zh'?'点击复制':'Click to copy'"
                  @click="copyLanLink(ip)">{{ lanShareUrl(ip) }}</code>
            <span class="lan-copy-btn" :title="store.locales=='zh'?'复制':'Copy'" @click="copyLanLink(ip)"><i class="fa fa-copy"></i></span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <div class="config-description" style="margin-left:0">
          {{ store.locales=='zh'
            ? '启动后其他设备可通过浏览器访问上方地址使用聊天。若设置了「知识库目录」，远端网页端在 home 知识库模式可从该目录选择现有的 .kb 使用，或上传自己的文件作为知识库。文件浏览、设置等桌面专属功能在远程浏览器中不可用。'
            : 'Expose the chat interface to LAN. Remote devices open the URL above in a browser. If a "KB Folder" is set, remote users in home KB mode can pick an existing .kb from it, or upload their own files as a KB. File browsing, settings and other desktop-only features are unavailable in remote browsers.' }}
        </div>
      </div>
    </div>

    <!-- 协同文件编辑 -->
    <div v-if="showCollab" class="settings-group">
      <h3>{{ store.locales=='zh'?'协同文件编辑' : 'Collaborative Editing' }}</h3>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'操作' : 'Actions' }}</label>
        <div class="action-with-status">
          <div class="button-group">
            <div v-if="!collabServerRunning" class="button" @click="startCollabServer"
                 :title="store.locales=='zh'?'启动协同服务' : 'Start collab service'">
              <i class="fa fa-play"></i> {{ store.locales=='zh'?'启动服务' : 'Start' }}
            </div>
            <div v-if="collabServerRunning" class="button" @click="stopCollabServer"
                 :title="store.locales=='zh'?'停止协同服务' : 'Stop collab service'">
              <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止服务' : 'Stop' }}
            </div>
            <div class="button" @click="refreshCollabServerInfo"
                 :title="store.locales=='zh'?'刷新状态' : 'Refresh status'">
              <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'刷新' : 'Refresh' }}
            </div>
          </div>
          <div class="status-indicator" :class="{ online: collabServerRunning, offline: !collabServerRunning }">
            <i :class="collabServerRunning ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
            <span>{{ collabServerRunning
              ? (store.locales=='zh' ? '已启动' : 'Running')
              : (store.locales=='zh' ? '未启动' : 'Stopped') }}</span>
            <span v-if="collabServerRunning && collabServerPort" class="status-port">:{{ collabServerPort }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'端口' : 'Port' }}</label>
        <input v-model.number="store.collab.port" type="number" min="1024" max="65535"
               :disabled="collabServerRunning"
               :placeholder="store.locales=='zh'?'协同服务端口' : 'Collab port'"/>
      </div>
      <div v-if="collabServerRunning && collabServerIPs.length > 0" class="form-group">
        <label>{{ store.locales=='zh'?'连接地址' : 'Address' }}</label>
        <div class="lan-addresses">
          <div v-for="ip in collabServerIPs" :key="ip" class="lan-address-item">
            <i class="fa fa-link"></i>
            <code class="lan-link-code" :title="store.locales=='zh'?'点击复制':'Click to copy'"
                  @click="copyCollabLink(ip)">ws://{{ ip }}:{{ collabServerPort }}/collab/&lt;房间号&gt;?token={{ store.collab.token || '' }}</code>
            <span class="lan-copy-btn" :title="store.locales=='zh'?'复制':'Copy'" @click="copyCollabLink(ip)"><i class="fa fa-copy"></i></span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'最大成员数' : 'Max Members' }}</label>
        <input v-model.number="store.collab.maxMembers" type="number" min="2" max="20"
               :disabled="collabServerRunning"
               :placeholder="store.locales=='zh'?'2~20' : '2-20'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'编辑权限' : 'Edit Permission' }}</label>
        <div class="environment-selector">
          <div class="environment-option"
               :class="{ active: store.collab.permissionMode === 'open' }"
               @click="store.collab.permissionMode='open'; store.saveConfig()"
               :title="store.locales=='zh' ? '所有成员加入即可编辑' : 'Everyone can edit on join'">
            <i class="fa fa-unlock"></i>
            <span>{{ store.locales=='zh' ? '开放编辑' : 'Open' }}</span>
          </div>
          <div class="environment-option"
               :class="{ active: store.collab.permissionMode === 'approve' }"
               @click="store.collab.permissionMode='approve'; store.saveConfig()"
               :title="store.locales=='zh' ? '加入为只读，需主机批准后才能编辑' : 'Join as read-only; host approval required to edit'">
            <i class="fa fa-handshake-o"></i>
            <span>{{ store.locales=='zh' ? '请求-批准' : 'Approve' }}</span>
          </div>
          <div class="environment-option"
               :class="{ active: store.collab.permissionMode === 'readonly' }"
               @click="store.collab.permissionMode='readonly'; store.saveConfig()"
               :title="store.locales=='zh' ? '所有人只读，仅主机可编辑' : 'Read-only for all except host'">
            <i class="fa fa-eye"></i>
            <span>{{ store.locales=='zh' ? '只读' : 'Read-only' }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'房间 Token' : 'Room Token' }}</label>
        <div class="input-with-button">
          <input v-model="store.collab.token" :disabled="collabServerRunning"
                 :placeholder="store.locales=='zh'?'加入房间时需要输入的凭证' : 'Token required to join'"/>
          <div class="button" style="width:20px;" @click="regenerateCollabToken"
               :title="store.locales=='zh'?'重新生成':'Regenerate'">
            <i class="fa fa-refresh"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'自动保存间隔（秒）' : 'Auto-save (seconds)' }}</label>
        <input v-model.number="store.collab.autoSaveSeconds" type="number" min="5" max="600"
               :placeholder="store.locales=='zh'?'主机写盘间隔' : 'Host save interval'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'客户端名称' : 'Client Name' }}</label>
        <input v-model="store.collab.nickname" maxlength="20"
               :placeholder="store.locales=='zh'?'连接后显示的名称（默认：主机/访客）' : 'Name shown after connect (default: Host/Guest)'"/>
      </div>
      <div class="form-group">
        <div class="config-description" style="margin-left:0">
          {{ store.locales=='zh'
            ? '在代码编辑器状态栏点击协同图标可「共享此文件」或「加入会话」。共享者（主机）负责将文档写盘，其他成员通过局域网实时协同编辑；需要房间 Token 才能加入。'
            : 'Click the collab icon in the code editor status bar to share a file or join a session. The host writes the document to disk; others edit in real time over LAN. A room token is required to join.' }}
        </div>
      </div>
    </div>

    <!-- 共享文件夹（远程只读文件服务，客户端可添加远程工作区预览/下载） -->
    <div v-if="showShare" class="settings-group">
      <h3>{{ store.locales=='zh'?'共享文件夹' : 'Shared Folder' }}</h3>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'操作' : 'Actions' }}</label>
        <div class="action-with-status">
          <div class="button-group">
            <div v-if="!remoteFsRunning" class="button" @click="startRemoteFsServer"
                 :title="store.locales=='zh'?'启动共享文件夹服务' : 'Start shared folder service'">
              <i class="fa fa-cloud"></i> {{ store.locales=='zh'?'启动共享' : 'Start' }}
            </div>
            <div v-if="remoteFsRunning" class="button" @click="stopRemoteFsServer"
                 :title="store.locales=='zh'?'停止共享文件夹服务' : 'Stop shared folder service'">
              <i class="fa fa-stop"></i> {{ store.locales=='zh'?'停止共享' : 'Stop' }}
            </div>
            <div class="button" @click="refreshRemoteFsInfo"
                 :title="store.locales=='zh'?'刷新状态' : 'Refresh status'">
              <i class="fa fa-refresh"></i> {{ store.locales=='zh'?'刷新' : 'Refresh' }}
            </div>
          </div>
          <div class="status-indicator" :class="{ online: remoteFsRunning, offline: !remoteFsRunning }">
            <i :class="remoteFsRunning ? 'fa fa-check-circle' : 'fa fa-times-circle'"></i>
            <span>{{ remoteFsRunning
              ? (store.locales=='zh' ? '已启动' : 'Running')
              : (store.locales=='zh' ? '未启动' : 'Stopped') }}</span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'共享目录' : 'Folder' }}</label>
        <div class="input-with-button">
          <input v-model="store.remoteFs.rootDir" :disabled="remoteFsRunning"
                 :placeholder="store.locales=='zh'?'选择要共享的文件夹' : 'Choose folder to share'"/>
          <div class="button" style="width:auto;padding:0 8px;" @click="chooseRemoteFsRoot" :disabled="remoteFsRunning"
               :title="store.locales=='zh'?'选择文件夹':'Choose folder'">
            <i class="fa fa-folder-open"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'端口' : 'Port' }}</label>
        <input v-model.number="store.remoteFs.port" type="number" min="1024" max="65535"
               :disabled="remoteFsRunning"
               :placeholder="store.locales=='zh'?'默认 3347' : 'Default 3347'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'访问 Token' : 'Token' }}</label>
        <div class="input-with-button">
          <input v-model="store.remoteFs.token" :disabled="remoteFsRunning"
                 :placeholder="store.locales=='zh'?'客户端添加远程工作区时的凭据' : 'Credential for clients'"/>
          <div class="button" style="width:20px;" @click="regenerateRemoteFsToken"
               :title="store.locales=='zh'?'重新生成':'Regenerate'">
            <i class="fa fa-refresh"></i>
          </div>
        </div>
      </div>
      <div v-if="remoteFsRunning && remoteFsIPs.length > 0" class="form-group">
        <label>{{ store.locales=='zh'?'连接信息' : 'Connection' }}</label>
        <div class="lan-addresses">
          <div v-for="ip in remoteFsIPs" :key="ip" class="lan-address-item">
            <i class="fa fa-cloud"></i>
            <code class="lan-link-code" :title="store.locales=='zh'?'点击复制':'Click to copy'"
                  @click="copyRemoteFsLink(ip)">remote-fs://{{ ip }}:{{ remoteFsPort }}?token={{ store.remoteFs.token || '' }}</code>
            <span class="lan-copy-btn" :title="store.locales=='zh'?'复制':'Copy'" @click="copyRemoteFsLink(ip)"><i class="fa fa-copy"></i></span>
          </div>
        </div>
      </div>
      <div class="form-group">
        <div class="config-description" style="margin-left:0">
          {{ store.locales=='zh'
            ? '客户端在「知识管理 → 文件树空白处右键 → 添加远程工作区」中粘贴上面的链接（或分别填写主机、端口、Token），即可只读预览共享文件夹中的文件；编辑时需下载到本地工作区。'
            : 'On the client, right-click the file tree in Knowledge Management → "Add Remote Workspace" and paste the link above (or fill in Host / Port / Token separately) to preview files read-only; editing requires downloading to a local workspace.' }}
        </div>
      </div>
    </div>

    <!-- 权限：局域网访客（浏览器打开共享地址的人）能做什么 —— 默认全只读 -->
    <div v-if="showPerm" class="settings-group">
      <h3 :title="permHints.section">{{ store.locales=='zh'?'权限（局域网访客）' : 'Permissions (LAN guests)' }}</h3>
      <!-- ① 访客可用的对话模式（简洁开关块：说明放 title，不放图标） -->
      <div class="form-group perm-list-row">
        <label>{{ store.locales=='zh'?'对话模式' : 'Chat modes' }}</label>
        <div class="perm-chips">
          <div v-for="m in LAN_GUEST_MODES" :key="m.value"
               class="perm-chip"
               :class="{ on: guestModeOn(m.value) }"
               :title="modeChipTitle(m)"
               @click="toggleGuestMode(m.value)">
            <span class="perm-chip-name">{{ store.locales=='zh' ? m.zh : m.en }}</span>
            <span class="perm-switch" :class="{ on: guestModeOn(m.value) }"><i class="perm-switch-knob"></i></span>
          </div>
        </div>
      </div>
      <!-- ② 访客可选的智能体（通用智能体固定开放；其余为 Agent 预设，需在此勾选） -->
      <div class="form-group perm-list-row">
        <label :title="store.locales=='zh'?'网页端访客可选的智能体；PTC 预设不下发（访客只能逐个调用工具）':'Agents a web guest may pick; PTC presets are not shared (guests call tools one by one)'">{{ store.locales=='zh'?'可用智能体' : 'Available agents' }}</label>
        <div class="perm-chips">
          <div class="perm-chip on disabled" :title="store.locales=='zh'?'通用智能体始终可用（自主规划 + 上方工具白名单）':'Always available (autonomous planning + the tool whitelist above)'">
            <span class="perm-chip-name">{{ store.locales=='zh'?'通用智能体' : 'General Agent' }}</span>
            <span class="perm-switch on"><i class="perm-switch-knob"></i></span>
          </div>
          <div v-for="p in shareablePresets" :key="p.id"
               class="perm-chip"
               :class="{ on: guestPresetOn(p.id) }"
               :title="presetChipTitle(p)"
               @click="toggleGuestPreset(p)">
            <span class="perm-chip-name">{{ p.name || (store.locales=='zh'?'未命名' : 'Unnamed') }}</span>
            <span class="perm-switch" :class="{ on: guestPresetOn(p.id) }"><i class="perm-switch-knob"></i></span>
          </div>
        </div>
      </div>
      <!-- ③ 智能体工具白名单（逐工具，数据源与「工具 → 管理」一致；与上方两行同构：左标签 + 右列表） -->
      <div class="form-group perm-list-row">
        <label :title="permHints.tools">{{ store.locales=='zh'?'智能体工具' : 'Agent tools' }}</label>
        <div class="perm-chips">
          <div v-for="row in guestToolRows" :key="row.name"
               class="perm-chip"
               :class="{ on: row.on, danger: row.danger }"
               :title="row.title"
               @click="toggleGuestTool(row)">
            <span class="perm-chip-name">{{ row.label }}</span>
            <span v-if="row.danger" class="perm-chip-danger">{{ store.locales=='zh'?'高危' : 'Risky' }}</span>
            <span class="perm-switch" :class="{ on: row.on }"><i class="perm-switch-knob"></i></span>
          </div>
        </div>
      </div>
      <!-- ③ 访客智能体使用的模型（来源 + 模型；默认跟随主机当前来源） -->
      <div class="form-group perm-block-gap">
        <label>{{ store.locales=='zh'?'模型来源' : 'Model source' }}</label>
        <select v-model="guest.guestLlmType" class="perm-hint" :title="permHints.modelSource" @change="onGuestLlmTypeChange">
          <option value="">{{ store.locales=='zh'?'跟随主机当前来源（默认）' : 'Follow host current source (default)' }}</option>
          <option v-for="o in guestLlmTypeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'模型' : 'Model' }}</label>
        <input v-model="guest.guestLlmModel" list="perm-guest-model-list" class="perm-hint"
               :title="permHints.model"
               @change="store.saveConfig()"
               :placeholder="guestModelPlaceholder"/>
        <datalist id="perm-guest-model-list">
          <option v-for="m in guestModelOptions" :key="m" :value="m"></option>
        </datalist>
      </div>
      <!-- ④ 其他权限 -->
      <div class="form-group">
        <label>{{ store.locales=='zh'?'最大步数' : 'Max steps' }}</label>
        <input v-model.number="guest.maxSteps" type="number" min="1" max="200" class="perm-hint"
               :title="permHints.maxSteps"
               @change="store.saveConfig()"
               :placeholder="store.locales=='zh'?'单轮最大步数（防死循环）' : 'Max steps per turn'"/>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'并发上限' : 'Concurrency' }}</label>
        <input v-model.number="guest.maxConcurrent" type="number" min="1" max="20" class="perm-hint"
               :title="permHints.concurrency"
               @change="store.saveConfig()"
               :placeholder="store.locales=='zh'?'同时允许的访客任务数' : 'Concurrent guest tasks'"/>
      </div>
      <!-- 访客对主机共享目录的文件访问（网页端经 /api/fs/* 由主机代做，路径限制在共享目录内） -->
      <div class="form-group">
        <label :title="store.locales=='zh'?'网页端本身没有本地文件；打开后由主机代做，且只能访问「共享」页里设置的「知识库目录」。写入档位可新建 / 保存 / 重命名 / 删除。' : 'The web page has no local files of its own; when enabled the host does the work and only inside the shared folder set on the Share tab.'">{{ store.locales=='zh'?'文件访问' : 'File access' }}</label>
        <select v-model="guest.guestFs" class="perm-hint" @change="store.saveConfig()">
          <option v-for="o in LAN_GUEST_FS_OPTIONS" :key="o.value" :value="o.value">
            {{ store.locales=='zh' ? o.zh : o.en }}
          </option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'沙箱级别' : 'Sandbox' }}</label>
        <select v-model="guest.sandbox" class="perm-hint" :title="permHints.sandbox" @change="store.saveConfig()">
          <option v-for="s in LAN_GUEST_SANDBOX_OPTIONS" :key="s.value" :value="s.value">
            {{ store.locales=='zh' ? s.zh : s.en }}
          </option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'访问令牌' : 'Access token' }}</label>
        <select class="perm-hint" :value="guest.requireToken ? '1' : '0'" :title="permHints.token" @change="onRequireTokenChange">
          <option value="0">{{ store.locales=='zh'?'不需要' : 'No token' }}</option>
          <option value="1">{{ store.locales=='zh'?'需要令牌' : 'Token required' }}</option>
        </select>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'令牌值' : 'Token' }}</label>
        <div class="input-with-button">
          <input v-model="guest.token"
                 :placeholder="store.locales=='zh'?'访客访问共享地址时需要携带的凭证' : 'Token guests must provide to access'"/>
          <div class="button" style="width:20px;" @click="regenerateGuestToken"
               :title="store.locales=='zh'?'重新生成':'Regenerate'">
            <i class="fa fa-refresh"></i>
          </div>
          <div class="button" style="width:20px;margin-left:4px" @click="copyGuestToken"
               :title="store.locales=='zh'?'复制':'Copy'">
            <i class="fa fa-copy"></i>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>{{ store.locales=='zh'?'访客自带模型' : 'Guest model' }}</label>
        <select class="perm-hint" :value="guest.allowGuestModel ? '1' : '0'" :title="permHints.guestModel" @change="onAllowGuestModelChange">
          <option value="0">{{ store.locales=='zh'?'禁止（用主机模型）':'Blocked (use host)' }}</option>
          <option value="1">{{ store.locales=='zh'?'允许':'Allowed' }}</option>
        </select>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ====== 组容器（与设置页其余面板一致） ====== */
.collab-settings { padding: 2px; }
.settings-group {
  margin-bottom: 5px;
  padding: 8px;
}
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

/* ====== 表单组 ====== */
.form-group { display: flex; align-items: center; margin-bottom: 5px; }
.form-group > * { margin: 0; }
.form-group:last-child { margin-bottom: 0; }
.form-group label {
  width: 120px; min-width: 120px;
  color: var(--fontColor); font-size: 14px;
  user-select: none; line-height: 1; flex-shrink: 0;
}
.form-group input,
.form-group textarea {
  flex: 1; padding: 2px 4px;
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  font-size: 14px;
  transition: border-color 0.2s ease;
  margin: 0px;
}
.form-group input, .form-group select { height: 33px; box-sizing: border-box; }
.form-group input[type="range"] { height: auto; }
.form-group input:focus, .form-group select:focus, .form-group textarea:focus {
  outline: none; border-color: var(--fontActiveColor);
}
.form-group input[type="checkbox"] { flex: 0 0 auto; width: 16px; height: 16px; margin-right: 10px; }

/* 带按钮输入框 */
.input-with-button { flex: 1; min-width: 0; display: flex; align-items: stretch; gap: 5px; }
.input-with-button > input, .input-with-button > select { flex: 1; min-width: 0; margin: 0; }
.input-with-button > .button {
  flex-shrink: 0; height: auto; align-self: stretch;
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 0; padding: 0 6px; margin: 0; width: auto;
}

/* ====== 按钮 / 按钮组 / 操作+状态 ====== */
.button {
  border: 1px solid var(--borderColor);
  border-radius: 5px;
  background-color: var(--menuColor);
  color: var(--fontColor);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex; align-items: center; justify-content: center;
  gap: 5px; font-size: 14px; white-space: nowrap;
  margin: 0px; padding: 6px 6px;
}
.button:hover { background-color: var(--menuActiveColor); color: var(--fontActiveColor); }
.button:disabled { opacity: 0.5; cursor: not-allowed; }
.button i { font-size: 14px; }
.button-group { flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.button-group .button { width: 100%; }

/* ====== 权限页（局域网访客白名单） ====== */

/* ====== 权限页：简洁开关块（无图标；说明放 title，悬停可见；等宽多列、同行共享一行） ====== */
.perm-chips {
  flex: 1; min-width: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 5px; align-content: start;
}
.perm-chip {
  display: flex; align-items: center; gap: 6px;
  width: 100%; box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  background: var(--backgroundColor); cursor: pointer;
  transition: all .12s;
}
.perm-chip:hover { border-color: var(--fontActiveColor); }
.perm-chip.on { border-color: var(--fontActiveColor); background: color-mix(in srgb, var(--fontActiveColor) 8%, transparent); }
.perm-chip.on .perm-chip-name { color: var(--fontActiveColor); }
.perm-chip.disabled { opacity: 0.5; cursor: not-allowed; }
.perm-chip-name { font-size: 12px; color: var(--fontColor); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.perm-chip-key { font-size: 9px; color: var(--fontColor); opacity: 0.45; font-family: Consolas, monospace; flex-shrink: 0; }
/* 高危标记（写入 / 执行 / 外部调用类工具：默认关闭，开启需确认） */
.perm-chip-danger { font-size: 9px; color: #e6a23c; border: 1px solid #e6a23c; border-radius: 3px; padding: 0 3px; }
.perm-chip.danger.on { border-color: #e6a23c; background: color-mix(in srgb, #e6a23c 10%, transparent); }
.perm-chip.danger.on .perm-chip-name { color: #b07a17; }
/* 开关（26×14，与各模块开关观感一致）；右对齐成一列 */
.perm-switch {
  width: 26px; height: 14px; border-radius: 7px; margin-left: auto; flex-shrink: 0;
  background: var(--borderColor); position: relative; transition: all .15s;
}
.perm-switch .perm-switch-knob {
  position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25);
  transition: all .15s;
}
.perm-switch.on { background: var(--fontActiveColor); }
.perm-switch.on .perm-switch-knob { left: 14px; }
/* 带说明的控件：悬停显示说明（说明不再占一行） */
.perm-hint { cursor: help; }
/* 新板块前的留白（上一块是整块列表，紧贴会显得拥挤） */
.perm-block-gap { margin-top: 5px; }
/* 带卡片列表的行：标签与列表顶部对齐（避免 label 被垂直居中到列表中间） */
.perm-list-row { align-items: flex-start; }
.perm-list-row > label { line-height: 26px; }
.action-with-status { flex: 1; min-width: 0; display: flex; align-items: stretch; gap: 8px; }
.action-with-status .button-group { flex: 1; }
.action-with-status .button-group .button { height: 33px; box-sizing: border-box; }
.action-with-status .status-indicator {
  flex: none; margin-left: auto; white-space: nowrap;
  height: 33px; box-sizing: border-box;
  display: flex; align-items: center; padding: 0 12px;
}

/* ====== 状态指示器 ====== */
.status-indicator { flex: 1; display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 5px; font-size: 14px; }
.status-indicator.online { background-color: rgba(46, 204, 113, 0.2); color: #2ecc71; border: 1px solid rgba(46, 204, 113, 0.3); }
.status-indicator.offline { background-color: rgba(231, 76, 60, 0.2); color: #e74c3c; border: 1px solid rgba(231, 76, 60, 0.3); }
.status-indicator i { font-size: 16px; }
.status-port { opacity: 0.85; font-weight: 600; }

/* ====== 环境选择（编辑权限） ====== */
.environment-selector { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.environment-option {
  display: flex; flex-direction: row; align-items: center; justify-content: center;
  height: 33px; box-sizing: border-box; padding: 0 10px;
  border: 1px solid var(--borderColor); border-radius: 5px;
  background-color: var(--menuColor); color: var(--fontColor);
  cursor: pointer; transition: all 0.2s ease; gap: 6px; white-space: nowrap;
}
.environment-option:hover { background-color: var(--menuActiveColor); }
.environment-option.active { background-color: var(--menuActiveColor); color: var(--fontActiveColor); border-color: var(--fontActiveColor); }
.environment-option i { font-size: 16px; }
.environment-option span { font-size: 14px; font-weight: 500; text-align: center; }

/* ====== 局域网地址/连接信息 ====== */
.lan-addresses { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.lan-address-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background-color: var(--backgroundColor); border: 1px solid var(--borderColor); border-radius: 5px; }
.lan-address-item i { color: var(--fontActiveColor); font-size: 14px; }
.lan-address-item code { flex: 1; min-width: 0; word-break: break-all; color: var(--fontActiveColor); font-size: 13px; font-weight: 600; background: none; user-select: all; cursor: pointer; }
.lan-link-code:hover { text-decoration: underline; }
.lan-copy-btn {
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0; width: 24px; height: 24px;
  border: 1px solid var(--borderColor); border-radius: 4px;
  color: var(--fontActiveColor); background: var(--menuColor);
  cursor: pointer; font-size: 12px; transition: all 0.15s;
}
.lan-copy-btn:hover { background: var(--menuActiveColor); }
.lan-copy-btn:active { opacity: 0.7; }

/* ====== 配置描述 ====== */
.config-description { flex: 1; font-size: 10px; color: var(--fontColor); opacity: 0.7; margin-left: 5px; }
</style>
