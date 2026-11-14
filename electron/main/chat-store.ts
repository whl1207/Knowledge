/**
 * chat-store.ts — 聊天存档的主进程存储（**单一事实源**）
 *
 * 背景：聊天存档原先在渲染层 localStorage（`ai-chats`），设置独立窗口、主窗口、
 * 诊断与备份各自读写同一份 JSON。存档会涨到十几 MB，localStorage 的配额与
 * 「多窗口最后写者赢」都扛不住；自动化任务又需要一份**宿主侧**的存档来投递。
 * 因此把它搬到这里：
 *
 * - 文件：`<userData>/chats.json`，封套 `{ version, savedAt, chats }`；
 * - 写：原子写（`atomic-write`）+ **合并写**（流式回答期间渲染层会高频保存，
 *   这里保证同一时刻只有一次落盘，且总是写最新一份，不排队堆积）；
 * - 读：损坏时**先备份** `chats.json.corrupt-<ts>` 再返回空，绝不静默丢档；
 * - 兼容：旧文件若是裸数组也认；渲染层首次迁移时由它把 localStorage 的存档
 *   通过 `chats:save` 灌进来。
 *
 * 与渲染层的关系：渲染层启动时 `chats:load` 读一次，之后每次保存 `chats:save`
 * （防抖）。桌面端 localStorage 不再保存聊天正文；浏览器 / 安卓端没有 IPC，
 * 仍回退 localStorage（见 `src/lib/chatArchive.ts`）。
 */

import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './atomic-write'

const FILE_NAME = 'chats.json'
const VERSION = 1

export interface ChatArchiveInfo {
  chats: any[]
  savedAt: number
  exists: boolean
}

function archivePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** 待写入的最新一份（合并写：只保留最后一次提交的内容） */
let dirty: any[] | null = null
/** 正在进行的写循环（null = 空闲） */
let inFlight: Promise<void> | null = null
let lastSavedAt = 0
let lastBytes = 0

async function writeArchive(chats: any[]): Promise<void> {
  const payload = { version: VERSION, savedAt: Date.now(), chats }
  const text = JSON.stringify(payload)
  lastBytes = await atomicWrite(archivePath(), text)
  lastSavedAt = payload.savedAt
}

async function flushLoop(): Promise<void> {
  try {
    while (dirty) {
      const data = dirty
      dirty = null
      await writeArchive(data)
    }
  } catch (e) {
    console.error('[chat-store] 写入失败:', e)
  } finally {
    inFlight = null
    // 收尾窗口里又来了新提交：继续写，避免「最后一次保存丢失」
    if (dirty) inFlight = flushLoop()
  }
}

/** 保存整份聊天存档（合并写；不抛错——流式保存失败不应打断对话） */
export function saveChats(chats: any[]): Promise<void> {
  dirty = Array.isArray(chats) ? chats : []
  if (!inFlight) inFlight = flushLoop()
  return inFlight
}

/** 等待当前写入落地（测试 / 退出前用） */
export async function flushChats(): Promise<void> {
  if (inFlight) await inFlight
}

export async function loadChats(): Promise<ChatArchiveInfo> {
  const path = archivePath()
  let text: string
  try {
    text = await fsp.readFile(path, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { chats: [], savedAt: 0, exists: false }
    throw e
  }
  try {
    const parsed = JSON.parse(text)
    const chats = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.chats) ? parsed.chats : null)
    if (!chats) throw new Error('缺少 chats 数组')
    return { chats, savedAt: Number(parsed?.savedAt) || 0, exists: true }
  } catch (e) {
    // 损坏：先留档（用户还能手工救回来），再返回空
    try {
      await fsp.copyFile(path, `${path}.corrupt-${Date.now()}`)
    } catch { /* 备份失败不影响返回 */ }
    console.warn('[chat-store] 存档损坏，已备份后按空存档启动:', e)
    return { chats: [], savedAt: 0, exists: false }
  }
}

export async function clearChats(): Promise<void> {
  dirty = null
  await flushChats()
  await fsp.mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
  await atomicWrite(archivePath(), JSON.stringify({ version: VERSION, savedAt: Date.now(), chats: [] }))
  lastSavedAt = Date.now()
  lastBytes = 0
}

/** 存档概况（诊断页 / 设置页「聊天记录」行用） */
export async function statChats(): Promise<{
  exists: boolean
  chats: number
  messages: number
  bytes: number
  savedAt: number
}> {
  const path = archivePath()
  try {
    const st = await fsp.stat(path)
    const info = await loadChats()
    const messages = info.chats.reduce((n, c: any) => n + (Array.isArray(c?.messages) ? c.messages.length : 0), 0)
    return { exists: info.exists, chats: info.chats.length, messages, bytes: st.size, savedAt: info.savedAt || st.mtimeMs }
  } catch {
    return { exists: false, chats: 0, messages: 0, bytes: lastBytes, savedAt: lastSavedAt }
  }
}
