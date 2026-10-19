/**
 * readText — 主进程 / 主机「把读失败当文本返回」的统一识别
 *
 * `fs.readText` 的契约是失败**不抛错**，而是返回 `Error reading file: …` /
 * `Error reading Excel file: …` 这类字符串（见 platform/contract 的 FileSystemPort）。
 * 调用方若直接把它当正文，就会出现「附件内容是 ENOENT 英文」「浏览视图显示一行报错」。
 */

/** 是否是读失败文本（只认主进程既有前缀，不误伤正常正文） */
export function isReadFailureText(text: unknown): boolean {
  return typeof text === 'string' && /^Error reading /.test(text)
}

/** 从读失败文本里取出可展示的原因（不是读失败返回空串） */
export function readFailureReason(text: unknown): string {
  if (!isReadFailureText(text)) return ''
  const s = String(text)
  const reason = s.replace(/^Error reading [^:]*:\s*/, '').trim()
  return reason || s.trim()
}
