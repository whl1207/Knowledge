/**
 * help.selftest.ts — browser_help 指南文本（纯逻辑）
 */
import { buildBrowserHelp, browserHelpTopics } from './help'

export interface BrowserHelpCase { name: string; ok: boolean; detail?: string }

export function runBrowserHelpSelfTest(): BrowserHelpCase[] {
  const cases: BrowserHelpCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  add('默认返回快速指南', buildBrowserHelp().includes('Web Agent 快速指南'))
  add('未知主题回退快速指南', buildBrowserHelp('nope').includes('Web Agent 快速指南'))
  add('主题列表包含关键主题', ['quickstart', 'actions', 'waits', 'tabs', 'script', 'files', 'learnings'].every((t) => browserHelpTopics().includes(t as any)))
  add('actions 主题列出 click/fill', /browser_click/.test(buildBrowserHelp('actions')) && /browser_fill/.test(buildBrowserHelp('actions')))
  add('quickstart 包含 ref 规则', /ref/.test(buildBrowserHelp('quickstart')) && /snapshot/.test(buildBrowserHelp('quickstart')))
  add('files 主题提到下载查询', /browser_list_downloads/.test(buildBrowserHelp('files')))
  return cases
}
