/**
 * openExternal.ts — 打开外部链接（官网 / 文档）
 *
 * 与 SearchSettings 里的做法一致：桌面版优先用自带浏览器（浏览器 Agent 窗口，
 * 已开窗口则新标签页打开），主进程通道不可用（旧版本 / 浏览器 / 局域网模式）时
 * 退回系统默认浏览器。设置页与新手引导共用这一份，避免各处写法不一。
 */
import { aikmIpcOrNull } from '@/lib/aikmIpc'
import { getPlatform } from '@/platform'

export const openExternalUrl = async (url?: string): Promise<void> => {
  const target = String(url || '').trim()
  if (!target) return
  const ipc = aikmIpcOrNull()
  if (ipc?.invoke) {
    try {
      const r = await getPlatform().browserAgent.call('open-url', { url: target })
      if (r?.ok !== false) return
    } catch {
      /* 主进程未注册该通道（旧版本）时退回下面的系统浏览器 */
    }
  }
  window.open(target, '_blank', 'noopener')
}
