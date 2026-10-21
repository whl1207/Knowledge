/**
 * e2e.ts — 真实 Electron 浏览器端到端自测（由 AIKM_BROWSER_E2E=1 触发）
 *
 * 与纯逻辑 selftest 不同：这里真的创建 BrowserWindow / WebContentsView / CDP，
 * 用 browserAgentService.executeTool 驱动本地 fixture，验证 snapshot → ref → click →
 * fill → select → hover → wait_for → extract 的主链路。
 *
 * 用法：
 *   npm run test:browser-e2e
 * 或：
 *   AIKM_BROWSER_E2E=1 AIKM_BROWSER_E2E_OUT=out.json electron .
 *
 * 注意：需要图形环境；CI/无头环境请用 xvfb（Linux）或跳过。
 */
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { browserAgentService } from '../browser-agent'

interface E2EStep { name: string; ok: boolean; detail?: string }

function fixturePath(): string {
  return process.env.AIKM_BROWSER_E2E_FIXTURE
    || join(app.getAppPath(), 'test', 'fixtures', 'browser', 'e2e.html')
}

function refFor(snapshot: string, pattern: RegExp): number | null {
  const m = pattern.exec(snapshot)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export async function runBrowserE2E(): Promise<void> {
  const steps: E2EStep[] = []
  const out = process.env.AIKM_BROWSER_E2E_OUT || join(app.getPath('temp'), 'aikm-browser-e2e.json')
  const owner = 'e2e'
  const tool = async (name: string, args: any = {}) => {
    const res: any = await browserAgentService.executeTool(name, args, { owner })
    return String(res?.text || '')
  }
  const step = async (name: string, fn: () => Promise<any>) => {
    try {
      const detail = await fn()
      steps.push({ name, ok: true, ...(detail ? { detail: String(detail).slice(0, 500) } : {}) })
    } catch (err: any) {
      steps.push({ name, ok: false, detail: err?.message || String(err) })
    }
  }

  try {
    const url = pathToFileURL(fixturePath()).toString()
    let snap = ''
    await step('help', async () => {
      const text = await tool('browser_help')
      if (!text.includes('Web Agent 快速指南')) throw new Error('browser_help 内容异常')
      return 'quickstart'
    })
    await step('navigate', async () => { await tool('browser_navigate', { url }); return url })
    await step('snapshot', async () => {
      snap = await tool('browser_snapshot', { maxChars: 6000 })
      if (!snap.includes('Browser e2e fixture')) throw new Error('snapshot 未包含 fixture 标题')
      return snap.slice(0, 300)
    })
    await step('browser_run', async () => {
      const text = await tool('browser_run', { code: 'return await browser.title()' })
      if (!text.includes('AI-KM browser e2e')) throw new Error(`browser_run 返回异常：${text.slice(0, 200)}`)
      return 'title via browser.*'
    })
    const btn = refFor(snap, /button "Click me"[^\n]*\[ref=(\d+)/)
    const nameRef = refFor(snap, /textbox "[^"]*"[^\n]*\[ref=(\d+)/)
    const pickRef = refFor(snap, /combobox[^\n]*\[ref=(\d+)/)

    await step('fill', async () => {
      if (nameRef == null) throw new Error('找不到 name 输入框 ref')
      await tool('browser_fill', { ref: nameRef, text: 'AI-KM' })
      return `ref=${nameRef}`
    })
    await step('click', async () => {
      if (btn == null) throw new Error('找不到按钮 ref')
      await tool('browser_click', { ref: btn })
      return `ref=${btn}`
    })
    await step('wait_for_text', async () => {
      await tool('browser_wait_for', { kind: 'text', value: 'clicked', timeoutMs: 5000 })
      return 'clicked'
    })
    await step('select', async () => {
      if (pickRef == null) throw new Error('找不到下拉框 ref')
      await tool('browser_select', { ref: pickRef, label: 'Beta' })
      return `ref=${pickRef}`
    })
    await step('hover', async () => {
      await tool('browser_hover', { selector: '#hover' })
      return 'selector=#hover'
    })
    await step('extract_text', async () => {
      const text = await tool('browser_extract_text', { maxChars: 2000 })
      if (!text.includes('clicked')) throw new Error(`提取文本缺少结果：${text.slice(0, 200)}`)
      return text.slice(0, 200)
    })
    await step('playbook_save', async () => {
      await tool('browser_playbook_save', {
        host: 'e2e.example',
        name: 'E2E title',
        description: 'returns the current page title',
        code: "const t = await browser.title();\nreturn t;",
      })
      return 'draft saved'
    })
    await step('playbook_draft_blocks_run', async () => {
      let blocked = false
      try { await tool('browser_playbook_run', { host: 'e2e.example', name: 'E2E title' }) } catch (err: any) {
        blocked = /未批准/.test(String(err?.message || err))
      }
      if (!blocked) throw new Error('未批准的 Playbook 竟然可以执行')
      return 'blocked'
    })
    await step('playbook_approve_and_run', async () => {
      browserAgentService.approvePlaybook('e2e.example', 'E2E title', true)
      const text = await tool('browser_playbook_run', { host: 'e2e.example', name: 'E2E title' })
      if (!text.includes('执行完成') || !text.includes('AI-KM browser e2e')) throw new Error(`Playbook 执行结果异常：${text.slice(0, 300)}`)
      return 'ran'
    })
    await step('playbook_delete', async () => {
      browserAgentService.deletePlaybook('e2e.example', 'E2E title')
      return 'deleted'
    })
    await step('learning_save', async () => { await tool('browser_learning_save', { host: 'e2e.example', title: 'e2e', notes: 'fixture button updates #out' }); return 'saved' })
    await step('download', async () => {
      await tool('browser_click', { selector: '#dl' })
      const deadline = Date.now() + 8000
      let rec: any = null
      while (Date.now() < deadline) {
        rec = browserAgentService.listDownloads().find((d) => /aikm-e2e/.test(d.filename))
        if (rec?.state === 'completed' || rec?.state === 'cancelled' || rec?.state === 'interrupted') break
        await new Promise((r) => setTimeout(r, 200))
      }
      if (!rec) throw new Error('下载列表里没有记录（will-download 未记录）')
      if (rec.state !== 'completed') throw new Error(`下载记录状态=${rec.state}，received=${rec.receivedBytes}/${rec.totalBytes}`)
      if (!rec.path) throw new Error('下载记录没有 path')
      const listed = await tool('browser_list_downloads')
      if (!listed.includes('aikm-e2e.txt')) throw new Error('browser_list_downloads 未返回下载记录')
      return `${rec.filename} ${rec.state} ${rec.receivedBytes}B`
    })
    await step('learning_get', async () => {
      const text = await tool('browser_learning_get', { host: 'e2e.example' })
      if (!text.includes('fixture button')) throw new Error('经验读取失败')
      return 'read'
    })
    await step('learning_delete', async () => { await tool('browser_learning_delete', { host: 'e2e.example' }); return 'deleted' })
    await step('finish', async () => { await tool('browser_space_finish', { keep: [] }); return 'closed' })
  } finally {
    const ok = steps.every((s) => s.ok)
    try {
      writeFileSync(out, JSON.stringify({ ok, steps, at: new Date().toISOString() }, null, 2), 'utf8')
    } catch { /* 忽略 */ }
    // 给窗口一点时间落盘，然后退出（避免 e2e 卡住）
    setTimeout(() => { try { app.exit(ok ? 0 : 1) } catch { /* 忽略 */ } }, 300)
  }
}
