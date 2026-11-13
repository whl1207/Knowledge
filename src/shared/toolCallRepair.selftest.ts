/**
 * toolCallRepair.selftest.ts — XML 工具调用自动修复
 *
 * 覆盖用户实测的畸形形态（缺 </function> / </parameter>）、完整 XML、JSON-in-XML、
 * 正文保留、未知工具拒绝、以及畸形 arguments 的参数提取。
 */

import { parseXmlToolArgs, repairTextToolCalls } from './toolCallRepair'

export interface ToolCallRepairCase { name: string; ok: boolean; detail?: string }

export function runToolCallRepairSelfTest(): ToolCallRepairCase[] {
  const cases: ToolCallRepairCase[] = []
  const add = (name: string, ok: boolean, detail?: string) => cases.push({ name, ok, ...(detail ? { detail } : {}) })

  const malformed = '<tool_call>\n<function=job_output>\n<parameter=job_id>shell-2\n</tool_call>'
  const r1 = repairTextToolCalls(malformed, ['job_output'])
  add('缺闭合标签也能识别工具名', !!r1 && r1.calls[0]?.name === 'job_output')
  add('缺闭合标签也能提取参数', !!r1 && r1.calls[0]?.args?.job_id === 'shell-2')
  add('修复后正文不残留 XML', !!r1 && r1.cleaned === '')

  const full = '先说明一下。\n<tool_call>\n<function=read_file>\n<parameter=path>/tmp/a.txt</parameter>\n</function>\n</tool_call>\n完成。'
  const r2 = repairTextToolCalls(full, ['read_file'])
  add('完整 XML 识别', !!r2 && r2.calls[0]?.name === 'read_file' && r2.calls[0]?.args?.path === '/tmp/a.txt')
  add('只清理 XML 块、保留正文', !!r2 && r2.cleaned.includes('先说明一下') && r2.cleaned.includes('完成') && !r2.cleaned.includes('<tool_call'))

  const json = '<tool_call>{"name":"job_output","arguments":{"job_id":"shell-2"}}</tool_call>'
  const r3 = repairTextToolCalls(json, ['job_output'])
  add('JSON-in-XML 识别', !!r3 && r3.calls[0]?.args?.job_id === 'shell-2')

  const unknown = '<tool_call><function=evil_tool><parameter=x>1</parameter></tool_call>'
  add('未知工具不修复', repairTextToolCalls(unknown, ['job_output']) === null)
  add('不传 knownTools 时可解析', repairTextToolCalls(unknown)?.calls[0]?.name === 'evil_tool')

  add('普通正文不误判', repairTextToolCalls('这里只是提到 <function=foo> 这个格式，没有调用') === null)
  add('畸形 arguments 提取参数', parseXmlToolArgs('<parameter=job_id>shell-2\n')?.job_id === 'shell-2')
  add('无 parameter 不当作工具参数', parseXmlToolArgs('just text') === null)

  const two = '<tool_call><function=job_list></function></tool_call><tool_call><function=job_output><parameter=job_id>a</parameter></tool_call>'
  const r4 = repairTextToolCalls(two, ['job_list', 'job_output'])
  add('多个 XML 调用按序识别', !!r4 && r4.calls.map((c) => c.name).join(',') === 'job_list,job_output')

  return cases
}
