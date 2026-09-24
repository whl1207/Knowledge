/**
 * rendererTasks.ts — 渲染层任务执行接缝（主进程工具的浏览器侧执行者）
 *
 * 有些主进程工具需要 DOM / MathJax / canvas 等只有渲染进程具备的能力，典型是
 * 「把 Markdown 导出为 Word」：导出管线（markdown-it + MathJax SVG + mermaid 栅格化 +
 * OOXML/ZIP 组装 + 主进程写盘）完全跑在渲染层。
 *
 * 协议（见 electron/main/agent-loop.ts 的同名接缝）：
 *   主进程 requestRendererTask(agentId, kind, payload)
 *     → 广播 `agent/renderer-task`
 *     → 各窗口调 agent.claimRendererTask 抢占（先到先得，避免多窗口重复执行导出）
 *     → 抢到的窗口执行 → agent.rendererResult 回传 { ok, value | error }
 *
 * 本模块在入口（src/main.ts）初始化一次，与是否有活跃 agent 会话无关。
 */

/** 渲染层任务请求（对应 AgentEventMap['agent/renderer-task'].payload） */
export interface RendererTaskRequest {
  taskId: string
  kind: string
  payload: any
}

/** 任务执行结果（回传主进程） */
export interface RendererTaskResult {
  ok: boolean
  value?: any
  error?: string
}

let subscribed = false

/** 初始化渲染层任务订阅（幂等；入口调用一次） */
export function initRendererTaskRunner(): void {
  if (subscribed) return
  const api: any = (typeof window !== 'undefined') ? (window as any).dsh?.agent : null
  if (!api?.onEvent || !api?.claimRendererTask || !api?.rendererResult) return
  subscribed = true
  api.onEvent((ev: any) => {
    if (ev?.type !== 'agent/renderer-task') return
    const agentId = String(ev.agentId || '')
    const req = ev.payload as RendererTaskRequest
    if (!agentId || !req?.taskId) return
    void runTask(agentId, req)
  })
}

/** 抢任务 → 执行 → 回传结果（抢不到说明别的窗口已接管，直接返回） */
async function runTask(agentId: string, req: RendererTaskRequest): Promise<void> {
  const api: any = (window as any).dsh?.agent
  if (!api) return
  let claimed = false
  try {
    const res = await api.claimRendererTask(agentId, req.taskId)
    claimed = !!res?.claimed
  } catch {
    claimed = false
  }
  if (!claimed) return

  let result: RendererTaskResult
  try {
    result = await executeTask(String(req.kind || ''), req.payload || {})
  } catch (e: any) {
    result = { ok: false, error: String(e?.message || e) }
  }
  try {
    await api.rendererResult(agentId, req.taskId, result)
  } catch {
    // 回传失败（窗口关闭等）：主进程侧有超时兜底，无需额外处理
  }
}

/** 按 kind 分发（新增渲染层任务在此加分支） */
async function executeTask(kind: string, payload: any): Promise<RendererTaskResult> {
  if (kind === 'export_word') return await exportWord(payload)
  return { ok: false, error: `未知的渲染层任务类型: ${kind}` }
}

/**
 * exportWord：复用 Markdown → .docx 统一管线（与文件阅读 / 聊天 / 工作流 Word 节点同一套代码），
 * 因此公式转 Word 原生公式、mermaid 转 PNG、表格列宽与模板样式完全一致。
 * 导出模块体积较大（markdown-it/MathJax/OOXML），故在真正导出时才动态加载。
 */
async function exportWord(payload: any): Promise<RendererTaskResult> {
  const markdown = String(payload?.markdown || '')
  if (!markdown.trim()) return { ok: false, error: 'Markdown 内容为空' }
  try {
    const [{ buildDocxBlob }, { prepareMarkdownDocxHtml, saveDocxBlob }] = await Promise.all([
      import('@/lib/export/docx'),
      import('@/lib/export/md-to-docx'),
    ])
    // stripFrontmatter：模型常直接传带 YAML 头部的 .md 文件内容，头部不应进入 Word 正文
    const prep = await prepareMarkdownDocxHtml(markdown, {
      template: payload?.template || undefined,
      stripFrontmatter: true,
    })
    if (!prep) return { ok: false, error: 'Markdown 内容为空' }
    const blob = await buildDocxBlob(prep.html, prep.skin, prep.page)
    // targetPath 为空时只给文件名 → 主进程 exportDocx 落到系统下载目录
    const targetPath = String(payload?.targetPath || '').trim() || '导出文档.docx'
    const saved = await saveDocxBlob(blob, targetPath, payload?.overwrite === true)
    if (!saved.ok || !saved.path) {
      return {
        ok: false,
        error: saved.error === 'not-electron' ? '当前环境不支持写盘（请在桌面应用中使用）' : (saved.error || '保存失败'),
      }
    }
    return {
      ok: true,
      value: {
        path: saved.path,
        template: prep.templateKey,
        sizeKb: Math.max(1, Math.round(blob.size / 1024)),
        chars: markdown.length,
      },
    }
  } catch (e: any) {
    return { ok: false, error: `Word 导出失败: ${e?.message || String(e)}` }
  }
}
