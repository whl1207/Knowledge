/**
 * swarmRoom.selftest.ts — 集群房间「回合归档 / 结束不清空 / 持久化恢复」自测（纯逻辑）
 *
 * 覆盖三条修复（都对应真实故障）：
 *  1. 回合结束**不能**清空任务板 —— 否则用户刚跑完，泳道立刻变空，任务过程再也看不到；
 *  2. 新回合开始时上一回合**归档**（进 history）而不是删除，工作台可切回去回看；
 *  3. 房间要能落盘并恢复 —— 房间原本只在渲染层内存里，刷新/重启即全丢；
 *     恢复时会话 id 必然失效，必须清掉，并把中断的成员/任务复位成可继续的状态。
 *
 * 用法：`npm run test:selftest swarmRoom`
 */

import type { SwarmRoom, SwarmTask } from '@/types/swarmRoom'
import { chatsRef } from '@/store/chats'
import {
  ensureRoom, createTask, updateTask, addArtifact, startEpisode, endEpisode,
  archiveEpisode, boardOf, episodeList, serializeRoom, restoreRoom, persistRooms,
} from './swarmRoom'

export interface SwarmRoomCase {
  name: string
  ok: boolean
  detail?: string
}

/** 简易 localStorage 替身（Node 里没有 localStorage；persistRooms 只在调用时读取它） */
function installLocalStorage(): Record<string, string> {
  const store: Record<string, string> = {}
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
  }
  return store
}

function task(id: string, patch: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id,
    episodeId: 'ep1',
    title: `任务 ${id}`,
    prompt: '做什么',
    deps: [],
    status: 'pending',
    createdAt: 1,
    ...patch,
  }
}

function room(chatId: string): SwarmRoom {
  const r = ensureRoom(chatId)
  r.members = [
    { idx: 0, name: 'Lead', role: '编排', status: 'idle' },
    { idx: 1, name: '费曼', role: '分析', status: 'idle' },
  ]
  return r
}

export function runSwarmRoomSelfTest(): SwarmRoomCase[] {
  const cases: SwarmRoomCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  // 1. 回合结束：任务板 / 消息 / 产出物**全部保留**（泳道不能空）
  {
    const r = room('c-end')
    startEpisode(r, '目标 A', 0)
    r.tasks.push(task('t1', { status: 'done', output: '结论' }))
    addArtifact(r, { name: 'a.md', path: 'D:/x/a.md', bytes: 12, taskId: 't1', agentIdx: 1 })
    endEpisode(r, 'done')
    add('回合结束不清空任务板',
      r.tasks.length === 1 && r.artifacts.length === 1 && r.episode?.status === 'done',
      `tasks=${r.tasks.length} artifacts=${r.artifacts.length} status=${r.episode?.status}`)
    add('回合结束后泳道仍有布局数据（boardOf 返回同一批任务）',
      (boardOf(r, '')?.tasks || []).length === 1 && boardOf(r, '')?.live === true)
  }

  // 2. 新回合开始：上一回合归档进 history（不是删除），当前任务板清空避免跨回合累积
  {
    const r = room('c-archive')
    startEpisode(r, '第一回合目标', 0)
    const ep1 = r.episode!.id
    r.tasks.push(task('t1', { status: 'done', prompt: '很长的任务描述'.repeat(50) }))
    r.messages.push({ id: 'm1', episodeId: ep1, from: 0, to: 1, kind: 'request', summary: '做这个', ts: 1, delivered: true })
    addArtifact(r, { name: 'r.md', path: 'D:/x/r.md', bytes: 3, taskId: 't1', agentIdx: 1 })
    startEpisode(r, '第二回合目标', 0)
    add('新回合归档上一回合（任务过程没被删）',
      r.history.length === 1 && r.history[0].episode.id === ep1 && r.history[0].tasks.length === 1,
      `history=${r.history.length}`)
    add('新回合归档保留产出物与通信',
      r.history[0].artifacts.length === 1 && r.history[0].messages.length === 1)
    add('新回合的任务板是干净的（不跨回合累积）',
      r.tasks.length === 0 && r.messages.length === 0 && r.artifacts.length === 0)
    const back = boardOf(r, ep1)
    add('可按回合 id 切回历史回合回看（只读）',
      !!back && back.live === false && back.tasks.length === 1 && back.tasks[0].id === 't1')
    const list = episodeList(r)
    add('回合列表：当前回合在前、历史在后',
      list.length === 2 && list[0].live === true && list[1].id === ep1,
      list.map((e) => `${e.id}${e.live ? '(live)' : ''}`).join(','))
  }

  // 3. 恢复存档：会话 id 清空、中断的成员与任务复位
  {
    const raw = {
      chatId: 'c-restore',
      maxInflight: 5,
      episode: { id: 'ep7', chatId: 'c-restore', leadIdx: 0, goal: '被刷新打断的目标', status: 'running', startedAt: 100 },
      members: [
        { idx: 0, name: 'Lead', role: '', status: 'running', sessionId: 'sess-1', currentTaskId: 't1', pending: [{ id: 'm9' }] },
        { idx: 1, name: '费曼', role: '', status: 'idle', sessionId: 'sess-2' },
      ],
      tasks: [task('t1', { status: 'running', episodeId: 'ep7', startedAt: 110 })],
      messages: [],
      artifacts: [],
      history: [{
        episode: { id: 'ep6', chatId: 'c-restore', leadIdx: 0, goal: '上一回合', status: 'done', startedAt: 1, endedAt: 2 },
        members: [{ idx: 0, name: 'Lead', role: '', status: 'running', sessionId: 'sess-old' }],
        tasks: [task('t0', { status: 'running', episodeId: 'ep6' })],
        messages: [{ id: 'm1', episodeId: 'ep6', from: 0, to: 1, kind: 'inform', summary: 'x', ts: 1, delivered: true }],
        artifacts: [{ name: 'old.md', path: 'D:/x/old.md', bytes: 1, at: 5 }],
      }],
    }
    const r = restoreRoom(raw)!
    add('恢复：成员的会话 id 与暂存消息被清掉（重启后必然失效）',
      r.members.every((m) => !m.sessionId) && !r.members[0].pending?.length)
    add('恢复：运行中的成员复位为 idle',
      r.members[0].status === 'idle' && r.members[0].currentTaskId === undefined)
    add('恢复：被中断的当前回合标记为已中断（不要假装还在跑）', r.episode?.status === 'aborted')
    add('恢复：当前回合中「运行中」的任务复位为 ready（可「继续未完成任务」）',
      r.tasks[0].status === 'ready' && r.tasks[0].startedAt === undefined)
    add('恢复：历史回合里「运行中」的任务标记为 cancelled（那次确实中断了）',
      r.history[0].tasks[0].status === 'cancelled')
    add('恢复：并发闸门与历史回合都在', r.maxInflight === 5 && r.history.length === 1)
    add('恢复：无回合但只有历史时，工作台回退显示最后一个历史回合',
      boardOf({ ...r, episode: null } as SwarmRoom, '')?.live === false)
    add('恢复：坏数据不抛异常（返回 null）',
      restoreRoom(null) === null && restoreRoom({}) === null)
  }

  // 4. 落盘：存档里没有会话 id、长文本被截断、对话被删后不再保留
  {
    const store = installLocalStorage()
    const r = room('c-persist')
    startEpisode(r, '落盘目标', 0)
    r.tasks.push(task('t1', { status: 'running', prompt: 'x'.repeat(9000) }))
    r.members[1].sessionId = 'sess-9'
    r.members[1].status = 'running'
    const snap = serializeRoom(r)
    add('存档：长任务描述被截断（localStorage 容量有限）',
      snap.tasks[0].prompt.length < 9000 && snap.tasks[0].prompt.endsWith('…'))
    add('存档：不写会话 id / 暂存消息',
      snap.members.every((m: any) => m.sessionId === undefined && m.pending === undefined))
    persistRooms()
    let saved: any = null
    try { saved = JSON.parse(store['ai-swarm-rooms'] || 'null') } catch { saved = null }
    add('落盘：房间写进了 ai-swarm-rooms', !!saved && !!saved['c-persist'] && saved['c-persist'].tasks.length === 1)

    // 空房间不落盘（每个项目组对话挂载时都会 ensureRoom 出一个空房间）
    ensureRoom('c-empty')
    persistRooms()
    saved = JSON.parse(store['ai-swarm-rooms'] || 'null')
    add('落盘：没有内容的房间不写盘', !saved['c-empty'] && !!saved['c-persist'])

    // 对话已被删除 → 该房间不再保留
    chatsRef.value = [{ id: 'c-persist' }]
    persistRooms()
    saved = JSON.parse(store['ai-swarm-rooms'] || 'null')
    add('落盘：对话被删除后不再保留其房间', !!saved['c-persist'] && Object.keys(saved).length === 1)
    chatsRef.value = []
  }

  // 5. 任务板常规更新（回归：archiveEpisode / restore 不该影响正常增改）
  {
    const r = room('c-tasks')
    startEpisode(r, '目标', 0)
    const created = createTask(r, { title: '标题', prompt: '正文', assignee: '费曼' })
    add('建任务仍走原有校验', created.ok === true)
    if (created.ok) {
      updateTask(r, { id: created.task.id, status: 'done', output: '完成' }, 1)
      add('成员可回写自己名下的任务', r.tasks[0].status === 'done' && r.tasks[0].output === '完成')
      archiveEpisode(r)
      add('手动归档后当前回合为空', r.episode === null && r.tasks.length === 0 && r.history.length === 1)
    }
  }

  return cases
}

/** 与其它套件一致：也提供 log 版本（runner 优先用 run*） */
export function logSwarmRoomSelfTest(): boolean {
  const cases = runSwarmRoomSelfTest()
  const bad = cases.filter((c) => !c.ok)
  for (const c of cases) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  return bad.length === 0
}
