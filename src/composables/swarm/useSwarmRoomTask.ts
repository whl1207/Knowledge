/**
 * useSwarmRoomTask.ts — 渲染层「群聊 = Agent Teams」协议处理器
 *
 * 主进程协议工具（team-tools.ts）经 `agent/renderer-task`（kind='swarm_room'）
 * 把 op 转发到这里；**所有群聊语义都在本文件发生**（房间事实源在渲染层）。
 *
 * 投递语义复用 agentBridge：
 * - 成员空闲 → `send`（唤醒开新 turn）
 * - 成员运行中 → `steer`（投递到最近 step 边界，运行中立即消费）
 * - 成员未 spawn（无 sessionId）→ 暂存 `member.pending`，spawn 时注入
 */

import { agentBridge } from '@/platform/agentBridge'
import { swarmRunChatId } from '@/store/swarmState'
import {
  roomOf, pushMessage, createTask, updateTask, claimTask, deleteTask,
  findMemberByName, findMemberBySession, setMemberStatus, endEpisode,
} from '@/store/swarmRoom'
import { pushSwarmMessage } from '@/composables/swarm/useSwarmChat'
import type { SwarmRoom, SwarmMessage, SwarmRoomTaskPayload, SwarmRoomTaskResult } from '@/types/swarmRoom'

/** 群聊里的一条协议细条（折叠展示，不污染正文） */
function projectProtocol(text: string, kind = 'protocol'): void {
  try {
    pushSwarmMessage({ role: 'system', content: text, timestamp: Date.now(), swarmProtocol: { kind, text } })
  } catch { /* 非运行期（无归属对话）忽略 */ }
}

function who(from: SwarmMessage['from'], room: SwarmRoom): string {
  if (from === 'lead') return '群主'
  if (from === 'user') return '用户'
  const idx = Number(from)
  return room.members.find((m) => m.idx === idx)?.name || `成员#${idx}`
}

/** 把一条协议消息投递到某成员（空闲唤醒 / 运行中 steer / 未 spawn 暂存） */
async function deliver(room: SwarmRoom, idx: number, msg: SwarmMessage): Promise<void> {
  const m = room.members.find((x) => x.idx === idx)
  if (!m) return
  // 未 spawn：暂存，等 runner 为本成员创建会话时注入
  if (!m.sessionId) {
    m.pending = [...(m.pending || []), msg]
    msg.delivered = true
    return
  }
  const text = `【来自 ${who(msg.from, room)} 的消息 · ${msg.kind}】\n${msg.content || msg.summary}`
  try {
    const view = agentBridge.get(m.sessionId)
    if (view?.status === 'running') {
      const ok = await agentBridge.steer(m.sessionId, text)
      if (ok) { msg.delivered = true; return }
    }
    await agentBridge.send(m.sessionId, text, 'swarm-msg')
    msg.delivered = true
  } catch {
    // 投递失败：标记未投递，交由后续回合重试 / 人工可见
    msg.delivered = false
  }
}

/** 协议处理器（渲染层任务入口） */
export async function handleSwarmRoom(payload: SwarmRoomTaskPayload): Promise<SwarmRoomTaskResult> {
  const chatId = payload?.chatId || swarmRunChatId.value || ''
  const room = roomOf(chatId)
  if (!room) return { ok: false, error: '当前对话没有 Team 房间（请以「项目组」方式发起运行）' }
  const actor = findMemberBySession(room, payload.agentId)
  const actorIdx = actor ? actor.idx : -1 // -1 = Lead（中立 LLM，或未登记的发起方）
  const args = payload.args || {}

  try {
    switch (payload.op) {
      // ---------------- 编排面 ----------------
      case 'spawn': {
        const name = String(args.name || '').trim()
        if (!name) return { ok: false, error: 'name 必填' }
        if (findMemberByName(room, name)) return { ok: false, error: `成员已存在：${name}` }
        const idx = room.members.length
        room.members.push({
          idx, name, role: String(args.role || ''), status: 'idle',
          permission: args.permission, recentTools: [],
        })
        projectProtocol(`🟢 加入：${name}${args.role ? ` · ${args.role}` : ''}`, 'spawn')
        return { ok: true, value: { name, idx } }
      }

      case 'task_create': {
        const r = createTask(room, args)
        if (!r.ok) return { ok: false, error: r.error }
        projectProtocol(`📋 新任务 ${r.task.id}：${r.task.title}${r.task.assignee !== undefined ? ` → ${room.members[r.task.assignee]?.name || '#' + r.task.assignee}` : ''}`, 'task')
        return { ok: true, value: { id: r.task.id, status: r.task.status } }
      }

      case 'task_delete': {
        const r = deleteTask(room, String(args.id || ''))
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, value: { deleted: args.id } }
      }

      case 'delete': {
        endEpisode(room, 'done')
        projectProtocol('⚪ 本回合结束', 'episode')
        return { ok: true, value: { done: true } }
      }

      case 'shutdown': {
        const name = String(args.name || '').trim()
        const m = findMemberByName(room, name)
        if (!m) return { ok: false, error: `找不到成员：${name}` }
        if (m.sessionId) { try { await agentBridge.cancel(m.sessionId, 'shutdown') } catch { /* 忽略 */ } }
        setMemberStatus(room, m.idx, 'stopped', { currentTaskId: undefined })
        projectProtocol(`⚪ 已停止：${name}${args.reason ? `（${args.reason}）` : ''}`, 'shutdown')
        return { ok: true, value: { name, status: 'stopped' } }
      }

      // ---------------- 全员 ----------------
      case 'task_list': {
        return {
          ok: true,
          value: room.tasks.map((t) => ({
            id: t.id, title: t.title, status: t.status, deps: t.deps,
            assignee: t.assignee, assigneeName: t.assignee !== undefined ? room.members[t.assignee]?.name : undefined,
            output: t.output,
          })),
        }
      }

      case 'task_update': {
        const r = updateTask(room, args, actorIdx)
        if (!r.ok) return { ok: false, error: r.error }
        if (args.status) projectProtocol(`${r.task.status === 'done' ? '✅' : '🔵'} ${r.task.id} ${r.task.title} → ${r.task.status}`, 'task')
        return { ok: true, value: { id: r.task.id, status: r.task.status } }
      }

      case 'task_claim': {
        const r = claimTask(room, String(args.id || ''), actorIdx)
        if (!r.ok) return { ok: false, error: r.error }
        return { ok: true, value: { id: r.task.id, assignee: r.task.assignee } }
      }

      case 'say': {
        const to = String(args.to || '').trim()
        const message = String(args.message || '').trim()
        const summary = String(args.summary || '').trim() || message.slice(0, 60)
        const kind = (args.kind || 'request') as SwarmMessage['kind']
        if (!to) return { ok: false, error: 'to 必填（成员名 / lead / *）' }
        if (!message && !summary) return { ok: false, error: 'message 或 summary 至少填一个' }

        let targets = [] as typeof room.members
        if (to === '*') targets = room.members.filter((m) => m.idx !== actorIdx)
        else if (to === 'lead') {
          const leadIdx = room.episode?.leadIdx ?? 0
          targets = room.members.filter((m) => m.idx === leadIdx)
        } else {
          const m = findMemberByName(room, to)
          if (!m) return { ok: false, error: `找不到成员：${to}` }
          targets = [m]
        }
        if (!targets.length) return { ok: false, error: `没有可投递的接收方：${to}` }

        const delivered: string[] = []
        if (to === '*') {
          // 广播：只记一条 to:'*' 协议消息（通信流据此识别广播），再分别投递到各成员
          const bmsg = pushMessage(room, { from: actorIdx, to: '*', kind, summary, content: message })
          for (const t of targets) {
            await deliver(room, t.idx, bmsg)
            delivered.push(t.name)
          }
        } else {
          for (const t of targets) {
            const msg = pushMessage(room, { from: actorIdx, to: t.idx, kind, summary, content: message })
            await deliver(room, t.idx, msg)
            delivered.push(t.name)
          }
        }
        // 群聊时间线：折叠通信条
        try {
          pushSwarmMessage({
            role: 'system',
            content: `${who(actorIdx, room)} → ${to === '*' ? '全体' : delivered.join('、')} · ${summary}`,
            timestamp: Date.now(),
            swarmComm: { to: to === '*' ? '*' : delivered.join('、'), kind, summary },
          })
        } catch { /* 忽略 */ }
        return { ok: true, value: { delivered } }
      }

      default:
        return { ok: false, error: `未知的协议操作：${payload.op}` }
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
