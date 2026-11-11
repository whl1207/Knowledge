/**
 * toolProfiles.selftest.ts — 「能力模板」工具集
 *
 * 锁住：
 * 1. 只读 / 知识库模板不能带写入类工具；
 * 2. 编码模板要包含命令、代码、子代理，但不带知识库检索；
 * 3. 办公模板要带 export_word；
 * 4. 浏览器模板要包含核心与扩展工具；
 * 5. 模板集合精确匹配才回显模板名，手工增删后必须是「自定义」。
 */

import { TOOL_PROFILES, groupToolsOf, profileLabel, profileOfBundles, profileOfTools, toolsOfProfile } from './toolProfiles'

export interface ToolProfilesCase { name: string; ok: boolean; detail?: string }

export function runToolProfilesSelfTest(): ToolProfilesCase[] {
  const cases: ToolProfilesCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const readonly = toolsOfProfile('readonly')
  add('只读模板不含写入工具',
    !['write_file', 'replace_in_file', 'multi_replace'].some((t) => readonly.includes(t)),
    readonly.join(','))
  add('只读模板不含导出 Word', !readonly.includes('export_word'))
  add('只读模板含读取与联网', readonly.includes('read_file') && readonly.includes('web_search'))

  const coding = toolsOfProfile('coding')
  add('编码模板含命令 / 代码 / 子代理',
    ['shell', 'run_code', 'run_subagent', 'job_output'].every((t) => coding.includes(t)),
    coding.join(','))
  add('编码模板不含知识库检索', !coding.includes('kb_search'))

  const knowledge = toolsOfProfile('knowledge')
  add('知识库模板含 kb_search 且不含写入',
    knowledge.includes('kb_search') && !knowledge.includes('write_file'),
    knowledge.join(','))

  const office = toolsOfProfile('office')
  add('办公模板含 export_word 与 skill',
    office.includes('export_word') && office.includes('skill'),
    office.join(','))

  const browser = toolsOfProfile('browser')
  add('浏览器模板含核心与扩展工具',
    browser.includes('browser_navigate') && browser.includes('browser_eval') && browser.includes('browser_playbook_run'),
    String(browser.length))

  const all = toolsOfProfile('full')
  add('全部模板包含各专项工具',
    ['read_file', 'shell', 'kb_search', 'mcp_call', 'browser_navigate', 'browser_eval', 'export_word']
      .every((t) => all.includes(t)),
    String(all.length))
  add('全部模板无重复', new Set(all).size === all.length)

  add('模板匹配：编码模板回显 coding', profileOfTools(coding) === 'coding')
  add('模板匹配：手工多一个工具 → custom', profileOfTools([...coding, 'not_a_real_tool']) === 'custom')
  add('模板匹配：空集合 → custom', profileOfTools([]) === 'custom')
  add('模板匹配：undefined → custom', profileOfTools(undefined) === 'custom')
  add('包匹配：编码域集合回显 coding', profileOfBundles(['files', 'code', 'interaction', 'web', 'subagent']) === 'coding')
  add('包匹配：多一个域 → custom', profileOfBundles(['files', 'code', 'interaction', 'web', 'subagent', 'browser']) === 'custom')
  add('包匹配：空集合 → custom', profileOfBundles([]) === 'custom')

  add('未知能力域返回空', groupToolsOf('not_a_group').length === 0)
  add('中英文标签可用', profileLabel('coding', true) === '编码助手' && profileLabel('coding', false) === 'Coding')
  add('模板数量稳定（6 个场景模板）', TOOL_PROFILES.length === 6, String(TOOL_PROFILES.length))

  return cases
}
