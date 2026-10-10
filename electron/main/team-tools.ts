/**
 * team-tools.ts — Agent Teams 协议工具（主进程侧 = **纯转发**）
 *
 * 设计：`docs/plan/群聊-AgentTeams-实施设计（逐文件）.md`
 * - 所有语义在渲染层（`src/store/swarmRoom.ts` + `src/composables/swarm/useSwarmRoomTask.ts`）；
 * - 主进程只把调用经 `requestRendererTask(agentId, 'swarm_room', { op, args })` 转发过去，
 *   再把渲染层的返回值原样回给模型（与 export_word 同一接缝）。
 *
 * 为什么必须走渲染层：消息投递要调用 `agentBridge.steer/send`（渲染层 API），且
 * 成员名册 ↔ agent 会话的映射只存在于渲染层。主进程保持**零状态**。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { toolRegistry, defineTool } from '@/shared/toolRegistry'
import { requestRendererTask } from './agent-loop'
import type { ToolResult, ToolExecutionContext } from '@/types/tool'

/** 产出物落盘目录名（工作区根下） */
const ARTIFACT_DIR = '.swarm-artifacts'

/**
 * post_artifact：把长产出（报告/代码/数据/清单）写成文件，只把「路径 + 摘要」回给模型。
 * 目的：避免长文挤爆群聊上下文——群聊只留一张产物卡片，需要全文时用 read_file 读路径。
 */
async function postArtifact(input: any, ctx: ToolExecutionContext): Promise<ToolResult> {
  const name = String(input?.name ?? '').trim()
  const content = String(input?.content ?? '')
  if (!name) return { ok: false, error: 'name 必填（产出物文件名，如 report.md）' }
  if (!content.trim()) return { ok: false, error: 'content 必填（产出物正文）' }

  // 文件名 / 目录名消毒（防路径越界）
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.{2,}/g, '.').trim().slice(0, 120) || 'artifact.md'
  const scope = String(ctx.scope || 'swarm').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'swarm'
  const root = String(ctx.cwd || process.cwd())
  const dir = path.join(root, ARTIFACT_DIR, scope)

  try {
    fs.mkdirSync(dir, { recursive: true })
    let target = path.join(dir, safeName)
    if (fs.existsSync(target)) {
      const ext = path.extname(safeName)
      const base = safeName.slice(0, safeName.length - ext.length)
      target = path.join(dir, `${base}-${Date.now().toString(36)}${ext}`)
    }
    fs.writeFileSync(target, content, 'utf-8')
    const bytes = Buffer.byteLength(content, 'utf8')
    const summary = content.replace(/\s+/g, ' ').trim().slice(0, 200)
    return { ok: true, value: { name: path.basename(target), path: target, bytes, summary } }
  } catch (e: any) {
    return { ok: false, error: `写入产出物失败：${e?.message || String(e)}` }
  }
}

/** 统一转发：op 决定渲染层的处理分支 */
function forward(op: string) {
  return async (input: any, ctx: ToolExecutionContext): Promise<ToolResult> => {
    const agentId = ctx.agentId || ctx.sessionId
    if (!agentId) return { ok: false, error: `${op} 只能在 agent 会话内使用` }
    try {
      const value = await requestRendererTask(agentId, 'swarm_room', { op, args: input || {}, agentId })
      return { ok: true, value }
    } catch (e: any) {
      return { ok: false, error: `${op} 失败：${e?.message || String(e)}` }
    }
  }
}

/** 注册 Agent Teams 协议工具（在 registerCoreTools 内调用一次；幂等由注册表保证） */
export function registerTeamTools(): void {
  // ---------------- 编排面（仅 Lead 可见：由白名单控制） ----------------

  toolRegistry.register(
    defineTool(
      'team_spawn',
      '（Team Lead 专用）新增一名具名队友到本回合团队。name 之后可被 send_message 寻址。简单任务不必调用。',
      forward('spawn'),
      {
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '队友名（唯一，可寻址）' },
            role: { type: 'string', description: '角色/职责说明（进它的系统提示）' },
            prompt: { type: 'string', description: '可选，该队友的初始任务描述' },
            permission: { type: 'string', enum: ['default', 'readonly', 'auto'], description: '可选，权限档位' },
          },
          required: ['name'],
        },
      },
    ),
  )

  toolRegistry.register(
    defineTool(
      'team_task_create',
      '（Team Lead 专用）在共享任务板上创建一个任务，可指定负责人 assignee（名册下标）与依赖 deps（任务 id 列表）。返回新任务 id，供后续 update/依赖引用。',
      forward('task_create'),
      {
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '3~8 字短标题（看板展示）' },
            prompt: { type: 'string', description: '完整任务描述（发给执行者）' },
            assignee: { type: 'string', description: '可选，负责人：填成员名（如 "费曼"）或名册下标（如 "1"）' },
            deps: { type: 'array', items: { type: 'string' }, description: '可选，依赖的任务 id 列表' },
            background: { type: 'boolean', description: '可选，后台执行（不阻塞主流程）' },
          },
          required: ['title', 'prompt'],
        },
      },
    ),
  )

  toolRegistry.register(
    defineTool(
      'team_task_delete',
      '（Team Lead 专用）从任务板删除一个任务，并清理其它任务对它的依赖。',
      forward('task_delete'),
      {
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '任务 id（如 t1）' } },
          required: ['id'],
        },
      },
    ),
  )

  // ---------------- 全员可见 ----------------

  toolRegistry.register(
    defineTool(
      'team_task_list',
      '查看共享任务板（所有任务的 id/标题/状态/负责人/依赖）。派活前或接活前先看板，避免重复或冲突。',
      forward('task_list'),
      { inputSchema: { type: 'object', properties: {} } },
    ),
  )

  toolRegistry.register(
    defineTool(
      'team_task_update',
      '更新一个任务的状态或产出。成员只能更新自己名下的任务；Lead 不受限。status=done 时请把结论放进 output。',
      forward('task_update'),
      {
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 id' },
            status: { type: 'string', enum: ['pending', 'ready', 'running', 'done', 'error', 'cancelled'] },
            output: { type: 'string', description: '可选，任务产出/结论（完成后填写）' },
            assignee: { type: 'integer', description: '可选，改派负责人下标（Lead 用）' },
          },
          required: ['id'],
        },
      },
    ),
  )

  toolRegistry.register(
    defineTool(
      'team_task_claim',
      '认领任务板上一个尚未指派的任务（把自己设为负责人）。',
      forward('task_claim'),
      {
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '任务 id' } },
          required: ['id'],
        },
      },
    ),
  )

  toolRegistry.register(
    defineTool(
      'send_message',
      '向群内某位成员（to=成员名）、群主（to=lead）或全体（to=*）发送一条结构化消息。需要同事配合、交接或提问时用它，而不是只在正文里写 @。summary 会显示在群聊时间线上。',
      forward('say'),
      {
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: '接收方：成员名 / "lead" / "*"（广播）' },
            message: { type: 'string', description: '要传达的完整内容' },
            summary: { type: 'string', description: '一句话摘要（进群聊时间线）' },
            kind: { type: 'string', enum: ['request', 'inform', 'handoff', 'question', 'reply'], description: '可选，消息类型（默认 request）' },
          },
          required: ['to', 'summary'],
        },
      },
    ),
  )

  toolRegistry.register(
    defineTool(
      'post_artifact',
      '把长产出（报告 / 代码 / 数据 / 清单）写成文件，返回文件路径。正文不要同时塞进回复里——回复只写摘要与结论，需要全文时用 read_file 读该路径。',
      postArtifact,
      {
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '产出物文件名（如 report.md / data.csv）' },
            content: { type: 'string', description: '产出物完整正文' },
            kind: { type: 'string', enum: ['report', 'data', 'code', 'note'], description: '可选，产出物类型' },
          },
          required: ['name', 'content'],
        },
      },
    ),
  )

  // ---------------- 生命周期（仅 Lead） ----------------

  toolRegistry.register(
    defineTool(
      'team_shutdown',
      '（Team Lead 专用）让一名队友退出本回合编排（其会话将被回收）。不等于从名册删除。',
      forward('shutdown'),
      {
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '队友名' },
            reason: { type: 'string', description: '可选，停止原因' },
          },
          required: ['name'],
        },
      },
    ),
  )

  toolRegistry.register(
    defineTool(
      'team_delete',
      '（Team Lead 专用）结束本回合（Episode）：收尾并允许运行时回收全部成员会话。任务板保留供查看。',
      forward('delete'),
      { inputSchema: { type: 'object', properties: {} } },
    ),
  )
}
