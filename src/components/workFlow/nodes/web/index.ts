/**
 * web executor - 网络搜索节点
 *
 * 复用主进程统一工具注册表的 web_search（搜索源可在设置页「工具 → 搜索」配置）：
 * 默认 Bing（隐藏 Chromium 渲染 + HTML 解析兜底），也可切换百度 / DuckDuckGo / SearXNG / 博查 / 智谱 / Tavily / Brave，
 * 或使用设置页里添加的自定义（内网）搜索源，
 * 与智能体 web_search 工具逻辑完全一致。
 */
import type { NodeExecutor, ExecutionContext } from '@/components/workFlow/engine/NodeExecutor'
import type { NodeData } from '@/components/workFlow/engine/WorkflowRunner'

export const webExecutor: NodeExecutor = {
  type: 'web',
  label: '网络搜索',
  async execute(node: NodeData, ctx: ExecutionContext): Promise<boolean> {
    if (!node.prompt || node.prompt.trim() === '') {
      node.result = ctx.t('enter_search_keywords'); node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }

    const query = ctx.resolveTemplate(node.prompt.trim(), node.id)
    ctx.log(`网络搜索: "${query}"`, 'info')

    try {
      // 走统一工具注册表 web_search（主进程按设置页「搜索源」分发；默认 Bing 页面渲染 + HTML 解析兜底）
      const res = await ctx.safeIpcInvoke('tools:execute', { name: 'web_search', input: { query } })
      const toolResult = (res && typeof res === 'object' && 'data' in res) ? res.data : res
      if (!toolResult?.ok) {
        throw new Error(toolResult?.error || ctx.t('search_error'))
      }
      const results: Array<{ title?: string; url?: string; snippet?: string; summary?: string }> =
        Array.isArray(toolResult.value?.results) ? toolResult.value.results : []

      let content = `搜索 "${query}" 结果：\n\n`
      if (results.length === 0) {
        content += '未找到结果'
      } else {
        results.forEach((it, i) => {
          content += `${i + 1}. ${it.title || ''}\n   链接: ${it.url || ''}\n   摘要: ${it.snippet || it.summary || ''}\n\n`
        })
      }

      // 结果写入运行日志（内层子图 onNodeComplete 不转发，只能靠 ctx.log 透出）
      ctx.log(`网络搜索 "${query}" 完成（${results.length} 条）:\n${content.slice(0, 800)}${content.length > 800 ? '\n...（内容已截断）' : ''}`, 'info')

      node.result = JSON.stringify({
        result: content, query, results,
        source: 'web_search', via: toolResult.value?.via,
        timestamp: new Date().toISOString()
      })
      node.status = 'success'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'success', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'success', node.result)
      return true
    } catch (error: any) {
      ctx.log(`网络搜索失败: ${error.message}`, 'error')
      node.result = `${ctx.t('search_error')}: ${error.message}`; node.status = 'error'
      ctx.callbacks.onNodeStatusUpdate?.(node.id, 'error', node.result)
      ctx.callbacks.onNodeComplete?.(node.id, node.name, node.type, 'error', node.result)
      return false
    }
  }
}
