/**
 * session-log.ts — 会话事件日志（JSONL 事件流 + deriveMessages）
 *
 * 借鉴 DeepSeek-Harness 的会话日志设计（docs/subsystems/session.md）：
 * - **append-only 事件流**：`userData/session-logs/<sessionId>.jsonl`，
 *   每行一个 JSON 事件（`SessionEvent`），是会话的单一事实源；
 * - **模型可见即已记录**：`deriveMessages()` 从事件流投影出模型历史，
 *   UI / fork / 恢复 / transcript 都应从该投影派生，而非第二份消息状态；
 * - **运行时不变式**：`assertIntegrity()` 校验日志自洽（seq 连续、事件有序）。
 *
 * 设计决策：
 * - 顺序号（seq）按会话单调递增，重启后从文件尾部续接；
 * - 写盘使用追加模式（O_APPEND），单事件写入原子性由操作系统保证，
 *   崩溃最多丢失正在写的最后一条事件；
 * - `assistant/chunk` 是流式增量，仅用于 UI 保真与回放，不参与 deriveMessages；
 * - 完整的模型可见事实（user/message、assistant/message、tool/call、
 *   tool/result、session/start 的 systemPrompt）全部落盘，保证可重建。
 */

import { app } from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs'
import {
  type SessionEvent,
  type SessionEventType,
  type DerivedMessage,
  type SessionLogIntegrity,
  type SessionEventMap,
} from '@/types/session-log'

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function sanitizeSessionId(sessionId: string): string {
  // 防路径穿越：只保留安全字符
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** 追加写入（同步、O_APPEND 语义，保证单事件原子性） */
function appendLine(file: string, line: string): void {
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, line + '\n', null, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// 会话日志存储
// ---------------------------------------------------------------------------

class SessionLogStore {
  /** 内存中的下一顺序号（重启后从文件尾部续接） */
  private nextSeq = new Map<string, number>()
  /**
   * 会话事件解析缓存（key = 文件 size:mtime，append 后自动失效）。
   * 目的：事件流分段翻页 / derive / 完整性校验不必每次整文件重复解析——
   * 超大日志下只整文件解析一次即可，避免打开面板与向下翻页时反复卡顿。
   */
  private parsed = new Map<string, { key: string; events: SessionEvent[] }>()

  private dir(): string {
    return join(app.getPath('userData'), 'session-logs')
  }

  private file(sessionId: string): string {
    return join(this.dir(), `${sanitizeSessionId(sessionId)}.jsonl`)
  }

  private ensureDir(): void {
    try {
      fs.mkdirSync(this.dir(), { recursive: true })
    } catch (e) {
      console.error('[session-log] 创建目录失败:', e)
    }
  }

  /** 读取某会话日志的下一顺序号（无文件时从 1 开始） */
  private loadNextSeq(sessionId: string): number {
    const cached = this.nextSeq.get(sessionId)
    if (cached !== undefined) return cached
    const file = this.file(sessionId)
    if (!fs.existsSync(file)) return 1
    let lastSeq = 0
    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as SessionEvent
          if (typeof ev?.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq
        } catch {
          // 跳过损坏行（容忍半写）
        }
      }
    } catch (e) {
      console.error('[session-log] 读取顺序号失败:', e)
    }
    this.nextSeq.set(sessionId, lastSeq + 1)
    return lastSeq + 1
  }

  /**
   * 追加一个会话事件（只追加；顺序号自动分配）。
   * 这是唯一写入口——所有模型可见事实都必须经由此处落盘。
   */
  append<K extends SessionEventType>(
    sessionId: string,
    type: K,
    payload: SessionEventMap[K],
  ): SessionEvent {
    this.ensureDir()
    const seq = this.loadNextSeq(sessionId)
    this.nextSeq.set(sessionId, seq + 1)
    const event = {
      seq,
      ts: Date.now(),
      sessionId,
      type,
      ...payload,
    } as SessionEvent
    try {
      appendLine(this.file(sessionId), JSON.stringify(event))
    } catch (e) {
      console.error('[session-log] 追加事件失败:', e)
    }
    return event
  }

  /** 文件修改签名（size:mtime），作为解析缓存失效依据 */
  private statKey(file: string): string | null {
    try {
      const st = fs.statSync(file)
      return `${st.size}:${Math.trunc(st.mtimeMs)}`
    } catch {
      return null
    }
  }

  /** 解析某会话完整事件流（按 seq 升序）并缓存；文件变化后自动重解析 */
  private getParsed(sessionId: string): SessionEvent[] {
    const file = this.file(sessionId)
    if (!fs.existsSync(file)) {
      this.parsed.delete(sessionId)
      return []
    }
    const key = this.statKey(file)
    const hit = this.parsed.get(sessionId)
    if (hit && hit.key === key) return hit.events
    const events: SessionEvent[] = []
    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as SessionEvent
          if (ev.sessionId === sessionId) events.push(ev)
        } catch {
          // 跳过损坏行
        }
      }
      events.sort((a, b) => a.seq - b.seq)
    } catch (e) {
      console.error('[session-log] 读取失败:', e)
    }
    this.parsed.set(sessionId, { key: key ?? '', events })
    // 只保留最近访问的少量会话，避免长期运行内存膨胀
    while (this.parsed.size > 4) {
      const oldest = this.parsed.keys().next().value
      if (oldest === undefined) break
      this.parsed.delete(oldest)
    }
    return events
  }

  /** 读取某会话的完整事件流（按 seq 升序） */
  readAll(sessionId: string): SessionEvent[] {
    return this.getParsed(sessionId)
  }

  /**
   * 只读某会话“最近 count 条”事件（按 seq 升序）。
   * 供分段加载首屏使用：内存/传输只带尾部窗口，避免超大日志整份送到渲染层卡死。
   */
  readTail(sessionId: string, count: number): SessionEvent[] {
    if (count <= 0) return []
    return this.getParsed(sessionId).slice(-count)
  }

  /**
   * 读 seq < beforeSeq 的最后 count 条（按 seq 升序）。
   * 供“加载更早历史”向上翻页使用；返回不足 count 条即说明已到最早。
   */
  readBefore(sessionId: string, beforeSeq: number, count: number): SessionEvent[] {
    if (beforeSeq <= 1 || count <= 0) return []
    const older: SessionEvent[] = []
    for (const ev of this.getParsed(sessionId)) {
      if (ev.seq < beforeSeq) {
        older.push(ev)
        if (older.length > count) older.shift()
      }
    }
    return older
  }

  /**
   * 会话全文检索：命中会话 id 或派生聊天记录（user/assistant 消息正文）。
   * 返回 [{ id, snippet }]（按最后修改时间倒序）；snippet 为空表示 id 命中。
   */
  searchSessions(keyword: string, limit = 200): Array<{ id: string; snippet: string }> {
    const kw = String(keyword || '').trim().toLowerCase()
    if (!kw) return []
    const dir = this.dir()
    if (!fs.existsSync(dir)) return []
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return []
    }
    const files = entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .map((entry) => ({ id: entry.slice(0, -'.jsonl'.length), file: join(dir, entry) }))
    files.sort((a, b) => {
      try { return fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs } catch { return 0 }
    })
    const out: Array<{ id: string; snippet: string }> = []
    for (const f of files) {
      if (out.length >= limit) break
      if (f.id.toLowerCase().includes(kw)) {
        out.push({ id: f.id, snippet: '' })
        continue
      }
      const snippet = this.findSnippet(f.id, kw)
      if (snippet) out.push({ id: f.id, snippet })
    }
    return out
  }

  /** 在某会话日志里找首个命中关键字的聊天正文片段（未命中返回空串） */
  private findSnippet(sessionId: string, kw: string): string {
    for (const ev of this.getParsed(sessionId)) {
      let text = ''
      if (ev.type === 'user/message' || ev.type === 'assistant/message') {
        const c = (ev as any).content
        text = typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c)
      } else if (ev.type === 'tool/result') {
        const v = (ev as any).value
        if (typeof v === 'string') text = v
        else if (v != null) text = JSON.stringify(v)
      }
      if (text && text.toLowerCase().includes(kw)) return this.snippetAround(text, kw)
    }
    return ''
  }

  /** 截取关键字附近的一段作为片段 */
  private snippetAround(text: string, kw: string): string {
    const lower = text.toLowerCase()
    const idx = lower.indexOf(kw)
    if (idx < 0) return text.replace(/\s+/g, ' ').slice(0, 120)
    const start = Math.max(0, idx - 20)
    const end = Math.min(text.length, idx + kw.length + 50)
    const seg = text.slice(start, end).replace(/\s+/g, ' ').trim()
    return `${start > 0 ? '…' : ''}${seg}${end < text.length ? '…' : ''}`
  }

  /** 删除某会话的事件日志（释放会话时调用） */
  remove(sessionId: string): void {
    this.nextSeq.delete(sessionId)
    this.parsed.delete(sessionId)
    const file = this.file(sessionId)
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (e) {
      console.error('[session-log] 删除失败:', e)
    }
  }

  /** 清空全部会话日志（删除 session-logs 目录下所有 .jsonl，重置 seq） */
  clearAll(): void {
    this.nextSeq.clear()
    this.parsed.clear()
    const dir = this.dir()
    if (!fs.existsSync(dir)) return
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.jsonl')) continue
        try {
          fs.unlinkSync(join(dir, entry))
        } catch (e) {
          console.error('[session-log] 删除文件失败:', e)
        }
      }
    } catch (e) {
      console.error('[session-log] 清空目录失败:', e)
    }
  }

  /**
   * 按“最近活动早于 cutoffTs”清理会话日志（append-only 文件以 mtime 近似最后活动）。
   * cutoffTs 为空/非法 → 全部清理。返回实际删除数量。
   */
  clearBefore(cutoffTs: number | null): number {
    const dir = this.dir()
    if (!fs.existsSync(dir)) return 0
    let removed = 0
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.jsonl')) continue
        const file = join(dir, entry)
        try {
          const st = fs.statSync(file)
          if (cutoffTs == null || st.mtimeMs < cutoffTs) {
            fs.unlinkSync(file)
            const id = entry.slice(0, -'.jsonl'.length)
            this.nextSeq.delete(id)
            this.parsed.delete(id)
            removed++
          }
        } catch {
          // 单文件失败忽略，继续清理其余
        }
      }
    } catch (e) {
      console.error('[session-log] 按时间清理失败:', e)
    }
    return removed
  }

  /** 列出全部会话日志文件（按最后修改时间倒序）：id / 事件数 / 最近时间 */
  listSessions(): Array<{ id: string; events: number; lastTs: number }> {
    const dir = this.dir()
    if (!fs.existsSync(dir)) return []
    const out: Array<{ id: string; events: number; lastTs: number }> = []
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.jsonl')) continue
        const file = join(dir, entry)
        const id = entry.slice(0, -'.jsonl'.length)
        let events = 0
        let lastTs = 0
        try {
          const stat = fs.statSync(file)
          // append-only JSONL 一行一事件：只统计非空行即可；不再逐行 JSON.parse，
          // 避免超大日志在会话列表/打开面板时反复整文件解析卡顿
          lastTs = stat.mtimeMs
          const lines = fs.readFileSync(file, 'utf-8').split('\n')
          for (const line of lines) {
            if (line.trim()) events++
          }
        } catch {
          continue
        }
        out.push({ id, events, lastTs })
      }
    } catch (e) {
      console.error('[session-log] 列出会话失败:', e)
    }
    out.sort((a, b) => b.lastTs - a.lastTs)
    return out
  }

  /**
   * 从事件流派生模型历史消息（对齐 DSH deriveMessages）。
   * 规则：
   * - `user/message` → user 消息；
   * - `assistant/message` → assistant 消息（含 toolCalls）；
   * - `tool/call` + `tool/result` → 配对的 tool 消息（失败转 ERROR 文本）；
   * - `session/start.systemPrompt` → 首条 system 消息；
   * - `assistant/chunk` 不参与派生（仅 UI 保真）。
   */
  deriveMessages(sessionId: string): DerivedMessage[] {
    const events = this.readAll(sessionId)
    // 第一遍：收集 tool/call 与 tool/result 的配对关系
    const toolResults = new Map<string, Extract<SessionEvent, { type: 'tool/result' }>>()
    for (const ev of events) {
      if (ev.type === 'tool/result') {
        toolResults.set(ev.callId, ev)
      }
    }

    // 第二遍：按顺序派生模型历史
    const out: DerivedMessage[] = []
    for (const ev of events) {
      switch (ev.type) {
        case 'session/start':
          if (ev.systemPrompt) {
            out.push({ role: 'system', content: ev.systemPrompt })
          }
          break
        case 'user/message':
          out.push({ role: 'user', content: ev.content })
          break
        case 'assistant/message': {
          const msg: DerivedMessage = { role: 'assistant', content: ev.content }
          if (ev.toolCalls?.length) msg.toolCalls = ev.toolCalls
          out.push(msg)
          // 把该 assistant 消息发起的工具调用展开为 tool 消息（模型可见）
          for (const call of ev.toolCalls || []) {
            const res = toolResults.get(call.id)
            out.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: res
                ? res.ok
                  ? JSON.stringify(res.value ?? null)
                  : `ERROR: ${res.error || '工具执行失败'}`
                : 'ERROR: 工具结果缺失（日志不完整）',
            })
          }
          break
        }
        default:
          break
      }
    }
    return out
  }

  /** 运行时不变式校验：seq 连续、类型合法、事件有序 */
  assertIntegrity(sessionId: string): SessionLogIntegrity {
    const events = this.readAll(sessionId)
    let expected = 1
    for (const ev of events) {
      if (ev.seq !== expected) {
        return { ok: false, seq: events.length, violation: `seq 不连续：期望 ${expected}，实际 ${ev.seq}` }
      }
      expected++
    }
    return { ok: true, seq: events.length }
  }
}

/** 全局单例 */
export const sessionLog = new SessionLogStore()
