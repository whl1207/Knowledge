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
import { writeFileSync, existsSync } from 'node:fs'
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
    await step('file_chooser', async () => {
      await tool('browser_click', { selector: '#file' })
      const up = await tool('browser_upload', { files: [fixturePath()] })
      if (!up.includes('文件选择器') && !up.includes('已向')) throw new Error(`文件选择器接管失败：${up.slice(0, 200)}`)
      const snap = await tool('browser_snapshot', { maxChars: 6000 })
      if (!snap.includes('files:1')) throw new Error('文件选择后页面未更新 files:1')
      return 'uploaded'
    })
    await step('drag', async () => {
      await tool('browser_drag', { from: { selector: '#pad' }, to: { selector: '#pad' } })
      const snap = await tool('browser_snapshot', { maxChars: 6000 })
      if (!snap.includes('dragged')) throw new Error('拖拽后页面未更新 dragged')
      return 'dragged'
    })
    await step('paste', async () => {
      await tool('browser_click', { selector: '#paste' })
      await tool('browser_paste', { text: 'pasted' })
      const snap = await tool('browser_snapshot', { maxChars: 6000 })
      if (!snap.includes('pasted')) throw new Error('粘贴后页面未更新 pasted')
      return 'pasted'
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
      const waited = await tool('browser_download_wait', { filename: 'aikm-e2e', timeoutMs: 8000 })
      if (!waited.includes('下载完成')) throw new Error(`等待下载未完成：${waited.slice(0, 300)}`)
      const rec = browserAgentService.listDownloads().find((d) => /aikm-e2e/.test(d.filename))
      if (!rec || rec.state !== 'completed') throw new Error(`下载记录状态异常：${rec?.state}`)
      if (!rec.path) throw new Error('下载记录没有 path')
      const listed = await tool('browser_list_downloads')
      if (!listed.includes('aikm-e2e.txt')) throw new Error('browser_list_downloads 未返回下载记录')
      await new Promise((r) => setTimeout(r, 700))
      const historyFile = join(app.getPath('userData'), 'browser-download-history.json')
      if (!existsSync(historyFile)) throw new Error('下载历史未落盘')

      const savePath = join(app.getPath('temp'), `aikm-e2e-save-${Date.now()}.txt`)
      const saved = await tool('browser_download', { id: rec.id, action: 'saveAs', path: savePath })
      if (!saved.includes('已执行') || !existsSync(savePath)) throw new Error(`saveAs 失败：${saved}`)
      const deleted = await tool('browser_download', { id: rec.id, action: 'delete' })
      if (!deleted.includes('已执行') || existsSync(savePath)) throw new Error(`delete 失败：${deleted}`)
      return `${rec.filename} ${rec.state} ${rec.receivedBytes}B`
    })
    await step('download_blocked', async () => {
      await tool('browser_click', { selector: '#evil' })
      const waited = await tool('browser_download_wait', { filename: 'evil.exe', timeoutMs: 5000 })
      if (!/阻止|危险/.test(waited)) throw new Error(`危险文件未被阻止：${waited.slice(0, 300)}`)
      return 'blocked'
    })
    await step('learning_get', async () => {
      const text = await tool('browser_learning_get', { host: 'e2e.example' })
      if (!text.includes('fixture button')) throw new Error('经验读取失败')
      return 'read'
    })
    await step('learning_delete', async () => { await tool('browser_learning_delete', { host: 'e2e.example' }); return 'deleted' })
    let claimTabId = ''
    await step('claim_add_user_tab', async () => {
      await browserAgentService.addTab(pathToFileURL(fixturePath()).toString(), { agent: false })
      const list = await tool('browser_list_tabs')
      const matches = [...list.matchAll(/\[用户\][^\n]*tabId=([^\s]+)/g)]
      if (!matches.length) throw new Error(`找不到用户标签：${list.slice(0, 300)}`)
      claimTabId = matches[matches.length - 1][1]
      return claimTabId
    })
    await step('claim_delegate', async () => {
      const delegated = browserAgentService.delegateTab(claimTabId)
      if (!delegated.ok) throw new Error(`移交失败：${delegated.error}`)
      return 'delegated'
    })
    await step('claim_take', async () => {
      const claimed = await tool('browser_claim_tab', { tabId: claimTabId })
      if (!claimed.includes('已接管')) throw new Error(`claim_tab 失败：${claimed.slice(0, 200)}`)
      return claimTabId
    })
    await step('claim_snapshot', async () => {
      const snap = await tool('browser_snapshot', { tabId: claimTabId, maxChars: 2000 })
      if (!snap.includes('Browser e2e fixture')) throw new Error('接管后无法快照该标签')
      return claimTabId
    })
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
