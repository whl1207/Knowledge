/**
 * fileAttachmentContext.selftest.ts — 智能体 / 集群模式「附件只给路径」的防回归
 *
 * 规则：有磁盘路径 → 只注入 `[附件路径] …`，绝不把正文塞进 prompt（模型用文件工具按需读）；
 *       全部没有路径（局域网访客 / 安卓 WebView / 虚拟来源）→ 才退回正文，避免附件丢失。
 *
 * 用法：`node scripts/run-selftests.mjs fileAttachmentContext`
 */
import { buildAgentAttachmentContext } from './fileAttachmentContext'

export interface AttachmentContextCase {
  name: string
  ok: boolean
  detail?: string
}

export function runFileAttachmentContextSelfTest(): AttachmentContextCase[] {
  const cases: AttachmentContextCase[] = []
  const add = (name: string, ok: boolean, detail = '') => cases.push({ name, ok, detail })

  const a = { name: 'a.docx', content: 'WORD_BODY_SHOULD_NOT_APPEAR', charCount: 25, path: 'C:\\docs\\a.docx' }
  const b = { name: 'b.xlsx', content: 'EXCEL_BODY_SHOULD_NOT_APPEAR', charCount: 10, path: 'C:\\docs\\b.xlsx' }

  const one = buildAgentAttachmentContext([a])
  add('有路径：只给路径', one === '[附件路径] C:\\docs\\a.docx', one)
  add('有路径：不出现正文', !one.includes('WORD_BODY_SHOULD_NOT_APPEAR'))

  const two = buildAgentAttachmentContext([a, b])
  add('多个路径：逐行列出', two === '[附件路径] C:\\docs\\a.docx\n[附件路径] C:\\docs\\b.xlsx', two)

  const noPath = buildAgentAttachmentContext([{ name: 'c.md', content: 'TEXT_BODY', charCount: 9 }])
  add('无路径：退回正文（否则附件丢失）', noPath.includes('TEXT_BODY'), noPath)

  const mixed = buildAgentAttachmentContext([a, { name: 'c.md', content: 'MIXED_BODY', charCount: 9 }])
  add('混合：有路径的只给路径、不带正文', mixed.includes('C:\\docs\\a.docx') && !mixed.includes('MIXED_BODY'), mixed)

  add('空附件：空串', buildAgentAttachmentContext([]) === '' && buildAgentAttachmentContext(undefined) === '')

  return cases
}

export function logFileAttachmentContextSelfTest(): boolean {
  const cases = runFileAttachmentContextSelfTest()
  const failed = cases.filter((c) => !c.ok)
  // eslint-disable-next-line no-console
  console.table(cases.map((c) => ({ 用例: c.name, 结果: c.ok ? '通过' : '失败', 备注: c.detail ?? '' })))
  // eslint-disable-next-line no-console
  console.log(`[fileAttachmentContext] ${cases.length - failed.length}/${cases.length} 通过`)
  return failed.length === 0
}
