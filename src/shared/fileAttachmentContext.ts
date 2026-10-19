/**
 * fileAttachmentContext — 智能体 / 集群模式的附件上下文
 *
 * 这两个模式有文件读取工具（read_file / list_dir 等），附件只需要告诉模型「文件在哪」，
 * 由模型按需读取即可。把 Word / Excel / Markdown 全文塞进 prompt 有两个问题：
 *   1. 浪费 token：同一份内容在模型调用文件工具时还会再读一遍；
 *   2. 降低可控性：模型无法按需选择只读某个文件 / 某个范围。
 *
 * 普通聊天 / 知识库 / 工作流模式仍走另一条路径（正文直接注入），因为那些模式没有文件工具。
 * 没有磁盘路径的附件（局域网访客网页 / 安卓 WebView / 虚拟文件来源）退回正文，
 * 否则附件会彻底丢失——这些环境本来也给不出可用的本地路径。
 */
import type { ChatMessage } from '@/types/chat'

export type FileAttachments = NonNullable<ChatMessage['fileAttachments']>

/** 生成智能体 / 集群模式的任务前缀：有路径给路径，全都没有路径时才退回正文 */
export function buildAgentAttachmentContext(fileAttachments?: FileAttachments): string {
  if (!fileAttachments || fileAttachments.length === 0) return ''

  const withPath = fileAttachments.filter((f) => String(f?.path || '').trim())
  if (withPath.length > 0) {
    return withPath.map((f) => `[附件路径] ${String(f.path).trim()}`).join('\n')
  }

  return fileAttachments
    .map((f) => `[文件: ${f.name} (${f.charCount}字)]\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n')
}
