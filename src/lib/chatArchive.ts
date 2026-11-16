/**
 * chatArchive.ts — 聊天存档的渲染层入口（桌面走主进程，浏览器/安卓回退 localStorage）
 *
 * 为什么需要这一层：存档事实源已经搬到主进程（`electron/main/chat-store.ts`，
 * 文件 `<userData>/chats.json`），但：
 * - 渲染层有几十处保存点（流式每个 chunk 都可能保存），不能每次都真写盘 →
 *   这里做**防抖 + 合并**，退出前用 `send`（fire-and-forget）把最后一份送出去；
 * - 浏览器 / 安卓 / 局域网访客没有 IPC，只能继续用 localStorage →
 *   同一套 API 在两处实现，调用方不写分支；
 * - 老版本存档在 localStorage（`ai-chats`），首次启动由这里**迁移一次**：
 *   主进程存档不存在时把 localStorage 的灌进去，成功后删掉旧键释放配额。
 */

import { aikmIpc, aikmIpcAvailable } from '@/lib/aikmIpc'

const LS_CHATS = 'ai-chats'
/** 防抖窗口：流式回答期间高频调用，合并成一次 IPC + 一次落盘 */
const SAVE_DEBOUNCE_MS = 400
/** localStorage 兜底上限（超过就别写了，必然配额失败） */
const LEGACY_MIRROR_MAX_BYTES = 4 * 1024 * 1024

interface ArchivePayload {
  chats: any[]
  savedAt: number
  exists: boolean
}

/** 解包 `{ ok, data }` 信封（主进程 registerIpc 的统一返回） */
async function invokeIpc<T>(channel: string, payload?: any): Promise<T> {
  const res: any = await aikmIpc.invoke(channel, payload)
  if (res && typeof res === 'object' && 'ok' in res) {
    if (!res.ok) throw new Error(String(res?.error?.message || channel))
    return res.data as T
  }
  return res as T
}

const desktop = (): boolean => aikmIpcAvailable()

/** localStorage 里的旧存档（迁移用；解析失败按空处理） */
function readLegacyChats(): any[] {
  try {
    const raw = localStorage.getItem(LS_CHATS)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLegacyChats(list: any[]): void {
  try {
    const text = JSON.stringify(list)
    // localStorage 配额约 10MB：十几 MB 的存档写进去必然抛 QuotaExceeded，
    // 白白卡住主线程还可能把已有兜底数据挤掉——超过阈值就只告警不写。
    if (text.length > LEGACY_MIRROR_MAX_BYTES) {
      console.warn('[chatArchive] 存档过大，跳过 localStorage 兜底（' + Math.round(text.length / 1024 / 1024) + 'MB）')
      return
    }
    localStorage.setItem(LS_CHATS, text)
  } catch (e) {
    console.warn('[chatArchive] localStorage 写入失败（浏览器端配额）:', e)
  }
}

/**
 * 跨进程 / 落盘前先转成纯对象。
 *
 * **这是「重启后会话消失」的根因**：渲染层的 `chats.value` 是 Vue 的响应式 Proxy，
 * 结构化克隆（`ipcRenderer.invoke` 的参数序列化）**不支持 Proxy**，会抛
 * `An object could not be cloned`。于是 `chats:save` 每次都失败，主进程只在
 * 首次迁移那一刻写过一份快照；之后所有会话都只活在内存里，退出即丢。
 * `JSON.parse(JSON.stringify())` 会把 Proxy 摊平成普通对象（顺带丢弃不可序列化字段）。
 */
function toPlain<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch (e) {
    console.warn('[chatArchive] 存档序列化失败，按原样发送:', e)
    return value
  }
}

/**
 * 读整份存档。
 * @returns chats + 是否发生了「localStorage → 主进程」的一次性迁移
 */
export async function loadChatArchive(): Promise<{ chats: any[]; migrated: boolean }> {
  if (!desktop()) return { chats: readLegacyChats(), migrated: false }
  try {
    const info = await invokeIpc<ArchivePayload>('chats:load')
    if (info.chats.length) return { chats: info.chats, migrated: false }
    // 主进程存档不存在（首次升级）→ 迁移 localStorage 的旧档
    if (!info.exists) {
      const legacy = readLegacyChats()
      if (legacy.length) {
        await invokeIpc('chats:save', { chats: legacy })
        try { localStorage.removeItem(LS_CHATS) } catch { /* 忽略 */ }
        return { chats: legacy, migrated: true }
      }
    }
    return { chats: info.chats, migrated: false }
  } catch (e) {
    console.warn('[chatArchive] 读取主进程存档失败，回退 localStorage:', e)
    return { chats: readLegacyChats(), migrated: false }
  }
}

// ---------------- 保存（防抖 + 合并） ----------------

let pending: any[] | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let lastPromise: Promise<void> | null = null
/** 实际使用的防抖窗口：大存档（序列化慢）会自动拉长到 1500ms */
let debounceMs = SAVE_DEBOUNCE_MS

async function doSave(chats: any[]): Promise<void> {
  if (!desktop()) {
    writeLegacyChats(chats)
    return
  }
  // 关键：必须换成纯对象，否则 Proxy 过不了结构化克隆（见 toPlain 注释）
  const startedAt = Date.now()
  const plain = toPlain(chats)
  // 十几 MB 的存档序列化很贵：一旦发现慢，就把防抖窗口拉长，避免流式回答期间反复卡主线程
  if (Date.now() - startedAt > 60) debounceMs = 1500
  try {
    await invokeIpc('chats:save', { chats: plain })
  } catch (e) {
    // 主进程写失败时留一份 localStorage 兜底，下一次保存成功后清掉
    console.warn('[chatArchive] 主进程保存失败，写 localStorage 兜底:', e)
    writeLegacyChats(plain)
  }
}

/** 提交一份存档（防抖；同一时刻只有一个 IPC 在飞，期间只有最后一份会落地） */
export function scheduleChatArchiveSave(chats: any[]): void {
  pending = Array.isArray(chats) ? chats : []
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flushChatArchive()
  }, debounceMs)
}

/** 立即把待保存的一份送出去（切模块 / 关窗前调用） */
export async function flushChatArchive(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!pending) {
    if (lastPromise) await lastPromise
    return
  }
  const data = pending
  pending = null
  lastPromise = doSave(data)
  await lastPromise
}

/**
 * 退出前的**尽力**保存：用 `send` 而不是 invoke（不等待回包，进程退出时也能送到主进程）。
 * 浏览器端直接同步写 localStorage。
 */
export function flushChatArchiveSync(chats?: any[]): void {
  if (chats) pending = chats
  if (!pending) return
  const data = pending
  pending = null
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!desktop()) {
    writeLegacyChats(data)
    return
  }
  try {
    // 同一个坑：退出前用 send 也一样要过结构化克隆，Proxy 会抛
    aikmIpc.send('chats:save-async', { chats: toPlain(data) })
  } catch {
    writeLegacyChats(data)
  }
}

/** 清空存档（设置页「清空聊天记录」；主进程与 localStorage 一起清） */
export async function clearChatArchive(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending = null
  try { localStorage.removeItem(LS_CHATS) } catch { /* 忽略 */ }
  if (desktop()) {
    try {
      await invokeIpc('chats:clear')
    } catch (e) {
      console.warn('[chatArchive] 清空主进程存档失败:', e)
    }
  }
}

/** 存档概况（诊断页 / 设置页展示） */
export async function chatArchiveStat(): Promise<{
  chats: number
  messages: number
  bytes: number
  savedAt: number
  store: 'main' | 'local'
}> {
  if (desktop()) {
    try {
      const st = await invokeIpc<{ chats: number; messages: number; bytes: number; savedAt: number }>('chats:stat')
      return { ...st, store: 'main' }
    } catch { /* 回退 */ }
  }
  const chats = readLegacyChats()
  const messages = chats.reduce((n, c: any) => n + (Array.isArray(c?.messages) ? c.messages.length : 0), 0)
  let bytes = 0
  try { bytes = (localStorage.getItem(LS_CHATS) || '').length } catch { /* 忽略 */ }
  return { chats: chats.length, messages, bytes, savedAt: 0, store: 'local' }
}
