/**
 * plugin-agent-consent.ts — 插件委派智能体的**同意状态**（首次调用确认）
 *
 * 与 `plugin-grants.ts` 同一套路：内存缓存 + 原子落盘（tmp → rename）+ 坏文件当默认值。
 * 文件：`userData/plugin-agent-consent.json`。
 *
 * ## 为什么同意由**主进程自己弹框**记，而不是让渲染层带 `confirm: true`
 *
 * `plugin-approval.ts` 的 `confirm` 是**渲染层自证**的布尔（见该文件注释）——它今天够用，
 * 只是因为插件够不到 IPC（那条桥已被撤并加了源码级护栏）。但"让插件花用户的钱"这类决定
 * 值得按 `plugin-grants.ts` 的口径做成**主进程持有、用户亲手给出**的状态：
 * 唯一写入入口是主进程弹出的对话框，插件与渲染层都没有办法替用户回答。
 *
 * 三态：`allow`（本插件以后都放行）/ `ask`（默认，每次问）/ `deny`（拒绝）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'

import { logInfo } from './log'

const CONSENT_FILE = 'plugin-agent-consent.json'
const VERSION = 1

export type AgentConsent = 'allow' | 'ask' | 'deny'

interface ConsentStore {
  version: number
  byPlugin: Record<string, AgentConsent>
}

let store: ConsentStore | null = null
/** 同一次运行内，同一个插件的弹框不并发弹两次 */
const asking = new Map<string, Promise<AgentConsent>>()

const VALID: readonly AgentConsent[] = ['allow', 'ask', 'deny']

function storeFile(): string {
  return path.join(app.getPath('userData'), CONSENT_FILE)
}

function loadStore(): ConsentStore {
  if (store) return store
  const byPlugin: Record<string, AgentConsent> = {}
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<ConsentStore>
    for (const [id, v] of Object.entries(parsed?.byPlugin || {})) {
      if (id && VALID.includes(v as AgentConsent)) byPlugin[id] = v as AgentConsent
    }
  } catch {
    /* 没有文件 / 文件坏了 → 全部按默认 ask（最保守的可用状态） */
  }
  store = { version: VERSION, byPlugin }
  return store
}

function saveStore(): void {
  const current = store
  if (!current) return
  // 同 plugin-agent-budget：`storeFile()` 放 try 里面，拿不到 userData 时降级而不是抛
  try {
    const file = storeFile()
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    console.warn('[plugin-agent-consent] 保存同意状态失败（本次运行内仍然生效）:', e)
  }
}

/** 该插件的同意状态（默认 `ask`） */
export function consentOf(pluginId: string): AgentConsent {
  const id = String(pluginId || '').trim()
  if (!id) return 'deny'
  return loadStore().byPlugin[id] ?? 'ask'
}

/** 写入同意状态（**只有主进程的对话框**与设置页的撤销入口该调用它） */
export function setConsent(pluginId: string, consent: AgentConsent): boolean {
  const id = String(pluginId || '').trim()
  if (!id || !VALID.includes(consent)) return false
  const data = loadStore()
  if (consent === 'ask') delete data.byPlugin[id]
  else data.byPlugin[id] = consent
  saveStore()
  return true
}

/** 清掉某插件的同意（「插件 → 数据」撤销 / 卸载时调用） */
export function clearConsent(pluginId: string): boolean {
  const id = String(pluginId || '').trim()
  if (!id) return false
  const data = loadStore()
  if (!data.byPlugin[id]) return false
  delete data.byPlugin[id]
  saveStore()
  return true
}

/** 给设置页看的清单 */
export function listConsent(): Array<{ pluginId: string; consent: AgentConsent }> {
  return Object.entries(loadStore().byPlugin).map(([pluginId, consent]) => ({ pluginId, consent }))
}

export interface ConsentRequest {
  pluginId: string
  pluginName: string
  presetName: string
  maxSteps: number
  timeoutMs: number
}

/**
 * 解析一次调用的同意结果（必要时弹框）。
 * 弹框由**主进程**发起：插件与渲染层都没有办法替用户回答。
 * 没有窗口可用（无人值守 / 窗口已关）时按 `deny` 处理 —— fail-closed。
 */
export async function resolveConsent(req: ConsentRequest): Promise<AgentConsent> {
  const existing = consentOf(req.pluginId)
  if (existing !== 'ask') return existing

  const inflight = asking.get(req.pluginId)
  if (inflight) return inflight

  const task = (async (): Promise<AgentConsent> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return 'deny'

    // 文案只用中文：与 electron/main/plugin-ipc.ts 的目录选择框同一口径
    // （主进程拿不到渲染层的当前语言；要双语得先把 locale 广播下来，不值当）
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['允许', '每次都问', '拒绝'],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
      title: '插件请求调用智能体',
      message: `插件「${req.pluginName}」想用你配置的模型跑一次智能体会话`,
      detail: `预设：${req.presetName}\n最多 ${req.maxSteps} 步，超时 ${Math.round(req.timeoutMs / 60000)} 分钟。\n`
        + '这会消耗你的模型额度。委派出的智能体不会拿到文件 / 命令类工具。\n\n'
        + '「允许」= 以后这个插件不再询问；「每次都问」= 每次调用都确认；'
        + '「拒绝」= 本次及以后都拒绝（可在「插件 → 数据」里改回来）。',
    })

    const consent: AgentConsent = response === 0 ? 'allow' : response === 1 ? 'ask' : 'deny'
    if (consent !== 'ask') setConsent(req.pluginId, consent)
    logInfo('main', `[plugin-agent-consent] [audit] ${req.pluginId} → ${consent}`)
    return consent
  })()

  asking.set(req.pluginId, task)
  try {
    return await task
  } finally {
    asking.delete(req.pluginId)
  }
}
